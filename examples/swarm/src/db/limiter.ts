// `sharedLimits` for the agent: one token bucket in Postgres that every worker draws from (a
// provider's rate limit is per key, not per worker). A call takes a token under a row lock
// (SELECT ... FOR UPDATE), refilled by the time the database's clock says has passed - never a
// worker's clock, they drift. No token: the call waits (outside the transaction) for the refill;
// a wait beyond `maxWaitMs` is a refusal, which the core turns into ModelCallRefusedError (never
// retried). The math is pure and below; the SQL is the thin part.
import type { IModelCall, ISharedLimits } from '@dudko.dev/agent'
import { inTransaction, type IDatabase } from './pool.ts'

export interface IBucketConfig {
  // Tokens the bucket holds when full: a burst.
  capacity: number
  // Tokens added back per second.
  refillPerSecond: number
}

export interface IBucketState {
  tokens: number
  updatedMs: number
}

export type BucketDecision =
  { take: true; state: IBucketState } | { take: false; state: IBucketState; waitMs: number }

// The bucket at `nowMs`: what it had plus what the elapsed time refilled, never above capacity. A
// clock that went back (a failover to a replica a little behind) refills nothing.
export const refill = (s: IBucketState, nowMs: number, cfg: IBucketConfig): IBucketState => {
  const elapsed = Math.max(0, nowMs - s.updatedMs)
  return {
    tokens: Math.min(cfg.capacity, s.tokens + (elapsed / 1000) * cfg.refillPerSecond),
    updatedMs: Math.max(nowMs, s.updatedMs),
  }
}

// Take `cost` tokens now, or say how long until there are enough.
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

// One bucket for everything, or one per provider + model (each with the same settings).
export const bucketOf = (call: Pick<IModelCall, 'provider' | 'modelId'>, scope: LimiterScope) =>
  scope === 'global' ? 'global' : `${call.provider ?? 'unknown'}:${call.modelId}`.slice(0, 200)

export interface ILimiterConfig extends IBucketConfig {
  scope: LimiterScope
  // A call that would have to wait longer than this in all is refused.
  maxWaitMs: number
  // Tokens one call costs (1: a requests-per-second limit).
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

export const ensureBucketSql =
  'INSERT INTO swarm_limiter (bucket, tokens, updated_at) VALUES ($1, $2, clock_timestamp()) ON CONFLICT DO NOTHING'
export const lockBucketSql =
  'SELECT tokens, (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms FROM swarm_limiter WHERE bucket = $1 FOR UPDATE'
// Read AFTER the lock is held: a clock read in the locking statement may predate the wait for it.
export const nowSql = 'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms'
export const saveBucketSql =
  'UPDATE swarm_limiter SET tokens = $2, updated_at = to_timestamp($3 / 1000.0) WHERE bucket = $1'

export interface IPostgresLimits extends ISharedLimits {
  // One try at the bucket (the transaction beforeModelCall runs): taken, or the wait.
  tryTake: (bucket: string) => Promise<BucketDecision>
}

export const createPostgresLimits = (
  db: IDatabase,
  cfg: ILimiterConfig,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
): IPostgresLimits => {
  const cost = cfg.cost ?? 1
  const tryTake = (bucket: string): Promise<BucketDecision> =>
    inTransaction(db, async (c) => {
      await c.query(ensureBucketSql, [bucket, cfg.capacity])
      const row = (await c.query<{ tokens: number; updated_ms: number }>(lockBucketSql, [bucket]))
        .rows[0]
      const now = (await c.query<{ now_ms: number }>(nowSql)).rows[0]
      if (!row || !now) {
        throw new Error(`rate limit "${bucket}": the bucket row is missing`)
      }
      const decision = takeOrWait(
        { tokens: Number(row.tokens), updatedMs: Number(row.updated_ms) },
        Number(now.now_ms),
        cost,
        cfg,
      )
      await c.query(saveBucketSql, [bucket, decision.state.tokens, decision.state.updatedMs])
      return decision
    })
  return {
    tryTake,
    beforeModelCall: async (call, { signal }) => {
      const bucket = bucketOf(call, cfg.scope)
      let waited = 0
      for (;;) {
        const decision = await tryTake(bucket)
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
