// `sharedLimits` for the agent: one token bucket every step of every session draws from (a
// provider's rate limit is per key, not per Workflow instance), in a Durable Object of its own -
// `LimiterDO`, one object per bucket (`global`, or one per provider + model). A call takes a token
// in the object, refilled by the time the OBJECT's clock says has passed - never a step's. No
// token: the call waits (in the step, outside the object) for the refill; a wait beyond
// `maxWaitMs` is a refusal, which the core turns into ModelCallRefusedError (never retried). The
// math is examples/swarm's src/db/limiter.ts, unchanged; the row lock there is the object's
// one-call-at-a-time here.
import type { IModelCall, ISharedLimits } from '@dudko.dev/agent'
import type { ISql } from './sql.ts'

export interface IBucketConfig {
  capacity: number
  refillPerSecond: number
}

export interface IBucketState {
  tokens: number
  updatedMs: number
}

export type BucketDecision =
  { take: true; state: IBucketState } | { take: false; state: IBucketState; waitMs: number }

export const refill = (s: IBucketState, nowMs: number, cfg: IBucketConfig): IBucketState => {
  const elapsed = Math.max(0, nowMs - s.updatedMs)
  return {
    tokens: Math.min(cfg.capacity, s.tokens + (elapsed / 1000) * cfg.refillPerSecond),
    updatedMs: Math.max(nowMs, s.updatedMs),
  }
}

export const takeOrWait = (
  s: IBucketState,
  nowMs: number,
  cost: number,
  cfg: IBucketConfig,
): BucketDecision => {
  const state = refill(s, nowMs, cfg)
  if (state.tokens >= cost) {
    return { take: true, state: { ...state, tokens: state.tokens - cost } }
  }
  return {
    take: false,
    state,
    waitMs: Math.ceil(((cost - state.tokens) / cfg.refillPerSecond) * 1000),
  }
}

export type LimiterScope = 'global' | 'model'

export const bucketOf = (call: Pick<IModelCall, 'provider' | 'modelId'>, scope: LimiterScope) =>
  scope === 'global' ? 'global' : `${call.provider ?? 'unknown'}:${call.modelId}`.slice(0, 200)

export interface ILimiterConfig extends IBucketConfig {
  scope: LimiterScope
  maxWaitMs: number
  cost?: number
}

export class RateLimitRefusal extends Error {
  constructor(bucket: string, waitMs: number, maxWaitMs: number) {
    super(
      `rate limit "${bucket}": the call would wait ${waitMs} ms in all, more than the ${maxWaitMs} ms allowed`,
    )
    this.name = 'RateLimitRefusal'
  }
}

// The object's side: one try at the bucket, by its own clock.
export const takeBucket = (
  sql: ISql,
  bucket: string,
  cost: number,
  cfg: IBucketConfig,
  now: number,
): BucketDecision => {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS buckets (bucket TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_ms REAL NOT NULL)',
  )
  const row = sql
    .exec<{
      tokens: number
      updated_ms: number
    }>('SELECT tokens, updated_ms FROM buckets WHERE bucket = ?', bucket)
    .toArray()[0]
  const decision = takeOrWait(
    row
      ? { tokens: row.tokens, updatedMs: row.updated_ms }
      : { tokens: cfg.capacity, updatedMs: now },
    now,
    cost,
    cfg,
  )
  sql.exec(
    'INSERT INTO buckets (bucket, tokens, updated_ms) VALUES (?, ?, ?) ' +
      'ON CONFLICT (bucket) DO UPDATE SET tokens = excluded.tokens, updated_ms = excluded.updated_ms',
    bucket,
    decision.state.tokens,
    decision.state.updatedMs,
  )
  return decision
}

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

// The step's side: the core's ISharedLimits over the objects (`take` is one RPC).
export const createSharedLimits = (
  take: (bucket: string, cost: number, cfg: IBucketConfig) => Promise<BucketDecision>,
  cfg: ILimiterConfig,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
): ISharedLimits => {
  const cost = cfg.cost ?? 1
  const bucketCfg = { capacity: cfg.capacity, refillPerSecond: cfg.refillPerSecond }
  return {
    beforeModelCall: async (call, { signal }) => {
      const bucket = bucketOf(call, cfg.scope)
      let waited = 0
      for (;;) {
        const decision = await take(bucket, cost, bucketCfg)
        if (decision.take) {
          return
        }
        if (waited + decision.waitMs > cfg.maxWaitMs) {
          throw new RateLimitRefusal(bucket, waited + decision.waitMs, cfg.maxWaitMs)
        }
        await sleep(decision.waitMs, signal)
        waited += decision.waitMs
      }
    },
  }
}
