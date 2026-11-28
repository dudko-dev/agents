// Example: the two scale-out hooks - `runLease` and `sharedLimits` - with in-memory reference
// implementations. Single process only: they show the wiring and the contract, without a broker.
// For many workers, put the same logic in a store every worker sees (Redis `SET NX PX` + a
// compare-and-set renew for the lease, a shared counter for the bucket); the agent's side does
// not change.
//
//   const lease = createMemoryRunLease()
//   const limits = createTokenBucketLimits({ capacity: 10, refillPerSecond: 2, maxTokensPerRun: 200_000 })
//   const agent = await createAgent({ ...config, runLease: lease, sharedLimits: limits, persistence })
//   // agent.leaseOwner: who this agent is to the lease (a random id unless lease.owner is set)
//
// A worker that picks up a crashed run resumes it by id; the lease makes sure two workers never
// run it at once, and the events of the attempts are ordered by (attempt, seq).

import type { IModelCall, IRunLease, ISharedLimits, IUsage } from '../src/index.ts'

interface IHeld {
  owner: string
  // Epoch ms at which the lease runs out unless renewed.
  until: number
}

export interface IMemoryRunLease extends IRunLease {
  // Who holds a run now (undefined: nobody, or the lease ran out).
  holder: (runId: string) => string | undefined
}

/**
 * One lease per run id, held for `ttlMs` by one owner at a time. `acquire` takes it when nobody
 * holds it (or the holder's ran out); `renew` extends it ONLY for the owner that holds it and only
 * while it has not run out - a renew after expiry answers false, because another worker may have
 * taken the run in between. `release` gives it up if this owner holds it.
 */
export const createMemoryRunLease = (
  options: { ttlMs?: number; now?: () => number } = {},
): IMemoryRunLease => {
  const now = options.now ?? Date.now
  const leases = new Map<string, IHeld>()
  const live = (runId: string): IHeld | undefined => {
    const held = leases.get(runId)
    if (held && held.until <= now()) {
      leases.delete(runId)
      return undefined
    }
    return held
  }
  return {
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    acquire: (runId, { owner, ttlMs }) => {
      const held = live(runId)
      if (held && held.owner !== owner) {
        return false
      }
      leases.set(runId, { owner, until: now() + ttlMs })
      return true
    },
    renew: (runId, { owner, ttlMs }) => {
      const held = live(runId)
      if (!held || held.owner !== owner) {
        return false
      }
      held.until = now() + ttlMs
      return true
    },
    release: (runId, { owner }) => {
      if (leases.get(runId)?.owner === owner) {
        leases.delete(runId)
      }
    },
    holder: (runId) => live(runId)?.owner,
  }
}

export interface ITokenBucketOptions {
  // Calls the bucket holds when full: a burst.
  capacity: number
  // Calls added back per second.
  refillPerSecond: number
  // What one call costs (default 1: a requests-per-second limit). It could weigh by
  // `call.estimatedInputTokens` instead, for a tokens-per-minute limit.
  costOf?: (call: IModelCall) => number
  // Tokens one run may spend in all, across workers (with one store); a call after that is
  // refused (ModelCallRefusedError for the agent).
  maxTokensPerRun?: number
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface ITokenBucketLimits extends ISharedLimits {
  // Tokens a run has spent so far, as afterModelCall reported them.
  spent: (runId: string) => number
}

const abortable = (ms: number, signal?: AbortSignal): Promise<void> =>
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

/**
 * A token bucket in front of every model call (beforeModelCall waits until the bucket has room:
 * a shared rate limit) and a per-run token budget kept from what afterModelCall reports (a call
 * of a run that spent it is refused: a shared budget). The wait counts against the call's own
 * timeout; give the sleep the signal so a call that is given up stops waiting.
 */
export const createTokenBucketLimits = (options: ITokenBucketOptions): ITokenBucketLimits => {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortable
  const costOf = options.costOf ?? (() => 1)
  const spentByRun = new Map<string, number>()
  let tokens = options.capacity
  let last = now()
  const refill = (): void => {
    const t = now()
    tokens = Math.min(options.capacity, tokens + ((t - last) / 1000) * options.refillPerSecond)
    last = t
  }
  return {
    beforeModelCall: async (call, { signal }) => {
      const spent = call.runId ? (spentByRun.get(call.runId) ?? 0) : 0
      if (options.maxTokensPerRun !== undefined && spent >= options.maxTokensPerRun) {
        throw new Error(`run ${call.runId} has spent its ${options.maxTokensPerRun} tokens`)
      }
      const cost = costOf(call)
      for (;;) {
        refill()
        if (tokens >= cost) {
          tokens -= cost
          return
        }
        await sleep(Math.ceil(((cost - tokens) / options.refillPerSecond) * 1000), signal)
      }
    },
    afterModelCall: (call: IModelCall, usage: IUsage) => {
      if (call.runId) {
        spentByRun.set(call.runId, (spentByRun.get(call.runId) ?? 0) + usage.totalTokens)
      }
    },
    spent: (runId) => spentByRun.get(runId) ?? 0,
  }
}
