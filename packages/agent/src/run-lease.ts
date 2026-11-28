// `config.runLease`: one worker at a time owns a run. Scale-out HOOK, not a broker: the host
// brings the lease (Redis, a database row, etcd - anything with an atomic "take it if nobody
// holds it"), this file only drives it - acquire before the run does anything, renew while it
// goes, release at the end - and enforces the STRICT reading of a lost lease: once a renew says
// no (or throws, or does not answer before the lease would have run out), the run is aborted at
// once and writes nothing more to `persistence`. Another worker may own the run by then, and a
// late snapshot from this one would overwrite its state.
//
// The timers have a test seam of their OWN (`TEST_TIME` below), not the wait clock's: a renew is
// not a run deadline, and the human-wait tests ask whether any deadline is running.
import { randomUUID } from 'node:crypto'

// The host's lease. `acquire` / `renew` answer true when this owner holds the run's lease for
// another `ttlMs` (a renew by an owner who does not hold it must answer false); `release` gives
// it up. `ttlMs` and `owner` are read once, by createAgent.
export interface IRunLease {
  acquire: (runId: string, options: IRunLeaseOptions) => boolean | Promise<boolean>
  renew: (runId: string, options: IRunLeaseOptions) => boolean | Promise<boolean>
  release: (runId: string, options: { owner: string }) => void | Promise<void>
  // How long one acquire / renew holds the lease. Default 30_000; renewed every ttlMs / 3. At
  // least 1_000, at most 2_147_483_647 (the longest timer); anything else - createAgent throws.
  ttlMs?: number
  // Who holds it. Default: a random id per agent (`agent.leaseOwner`). 1-256 characters.
  owner?: string
}

export interface IRunLeaseOptions {
  owner: string
  ttlMs: number
}

// Why a lease that was held is not any more: a renew answered false, threw, or did not answer
// before the lease ran out.
export type RunLeaseLostReason = 'refused' | 'error' | 'expired'

export class RunLeaseError extends Error {
  readonly runId: string
  readonly owner: string
  // false: the lease could not be taken (the run never started); true: it was held and lost
  // (the run was aborted, and nothing more was persisted).
  readonly lost: boolean
  readonly reason: RunLeaseLostReason
  constructor(
    runId: string,
    owner: string,
    lost: boolean,
    reason: RunLeaseLostReason,
    detail?: string,
    options?: { cause?: unknown },
  ) {
    super(
      lost
        ? `run "${runId}": the lease was lost (${leaseReasonText(reason)}${detail ? `: ${detail}` : ''}) - another worker may own the run now; it was aborted and nothing more was persisted`
        : `run "${runId}": the lease could not be acquired (${leaseReasonText(reason)}${detail ? `: ${detail}` : ''}) - another worker may own the run; nothing ran and nothing was persisted`,
      options,
    )
    this.name = 'RunLeaseError'
    this.runId = runId
    this.owner = owner
    this.lost = lost
    this.reason = reason
  }

  toJSON(): string {
    return this.message
  }
}

const leaseReasonText = (reason: RunLeaseLostReason): string =>
  reason === 'refused'
    ? 'the lease answered false'
    : reason === 'error'
      ? 'the lease threw'
      : 'no renew answered before the lease ran out'

export const RUN_LEASE_DEFAULT_TTL_MS = 30_000
export const RUN_LEASE_MIN_TTL_MS = 1_000
export const RUN_LEASE_MAX_TTL_MS = 2_147_483_647
const OWNER_MAX_CHARS = 256

// What createAgent keeps: the host's lease with its settings checked and filled in.
export interface IResolvedRunLease {
  lease: IRunLease
  ttlMs: number
  owner: string
}

// Checked at createAgent: a lease that cannot work is a configuration error, not something to
// find out at the first renew.
export const resolveRunLease = (lease: IRunLease | undefined): IResolvedRunLease | undefined => {
  if (lease === undefined) {
    return undefined
  }
  if (!lease || typeof lease !== 'object') {
    throw new Error('runLease must be an object with acquire / renew / release')
  }
  for (const method of ['acquire', 'renew', 'release'] as const) {
    if (typeof lease[method] !== 'function') {
      throw new Error(`runLease.${method} must be a function`)
    }
  }
  const ttlMs = lease.ttlMs ?? RUN_LEASE_DEFAULT_TTL_MS
  if (
    typeof ttlMs !== 'number' ||
    !Number.isFinite(ttlMs) ||
    ttlMs < RUN_LEASE_MIN_TTL_MS ||
    ttlMs > RUN_LEASE_MAX_TTL_MS
  ) {
    throw new Error(
      `runLease.ttlMs must be a number of milliseconds from ${RUN_LEASE_MIN_TTL_MS} to ${RUN_LEASE_MAX_TTL_MS}, got ${String(ttlMs)}`,
    )
  }
  const owner = lease.owner ?? `agent-${randomUUID()}`
  if (typeof owner !== 'string' || !owner.trim() || owner.length > OWNER_MAX_CHARS) {
    throw new Error(`runLease.owner must be a non-empty string of at most ${OWNER_MAX_CHARS} chars`)
  }
  return { lease, ttlMs: Math.floor(ttlMs), owner }
}

interface ILeaseTimeSource {
  set: (fire: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const REAL_TIME: ILeaseTimeSource = {
  set: (fire, ms) => {
    const handle = setTimeout(fire, ms)
    // A renew must never be what keeps a process alive: the run's own work does that.
    handle.unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * A TEST seam, not an API: a test that puts a time source under this key of `globalThis` before
 * a run starts moves the lease's timers itself (the renew cadence, the expiry of an unanswered
 * renew). A key of its own, not the wait clock's: a renew is not a run deadline. Nothing exports
 * it; it gives no power the globals it stands for do not.
 */
const TEST_TIME = Symbol.for('@dudko.dev/agent:run-lease-test-time')

const timeSource = (): ILeaseTimeSource => {
  const test = (globalThis as unknown as Record<symbol, Partial<ILeaseTimeSource> | undefined>)[
    TEST_TIME
  ]
  return typeof test?.set === 'function' && typeof test.clear === 'function'
    ? (test as ILeaseTimeSource)
    : REAL_TIME
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// A lease this run holds: renewed until `stop()`, aborting `signal` the moment it is lost.
export interface IHeldRunLease {
  readonly owner: string
  // Aborted (reason: the RunLeaseError) when the lease is lost.
  readonly signal: AbortSignal
  // Set once the lease is lost: from then on nothing may be persisted.
  readonly lost: RunLeaseError | undefined
  // Called once, when the lease is lost (at once, if it already was).
  onLost: (fn: (err: RunLeaseError, detail?: string) => void) => void
  // Stop renewing and give the lease up. Never throws: a failed release is passed to `log`.
  release: (log: (message: string) => void) => Promise<void>
}

/**
 * Take the run's lease, or throw a RunLeaseError (`lost: false`) - before anything of the run
 * happens. Then renew it every ttlMs / 3 until `release`.
 */
export const holdRunLease = async (
  resolved: IResolvedRunLease,
  runId: string,
): Promise<IHeldRunLease> => {
  const { lease, ttlMs, owner } = resolved
  let taken: boolean
  try {
    taken = (await lease.acquire(runId, { owner, ttlMs })) === true
  } catch (err) {
    throw new RunLeaseError(runId, owner, false, 'error', messageOf(err), { cause: err })
  }
  if (!taken) {
    throw new RunLeaseError(runId, owner, false, 'refused')
  }
  // Read when the lease is taken, as the wait clock reads its own seam.
  const time = timeSource()
  const ac = new AbortController()
  let lost: RunLeaseError | undefined
  let lostDetail: string | undefined
  let stopped = false
  let next: unknown
  let expiry: unknown
  const listeners: ((err: RunLeaseError, detail?: string) => void)[] = []
  const clear = (): void => {
    if (next !== undefined) {
      time.clear(next)
      next = undefined
    }
    if (expiry !== undefined) {
      time.clear(expiry)
      expiry = undefined
    }
  }
  const lose = (reason: RunLeaseLostReason, detail?: string, cause?: unknown): void => {
    if (stopped || lost) {
      return
    }
    clear()
    lost = new RunLeaseError(runId, owner, true, reason, detail, cause ? { cause } : undefined)
    lostDetail = detail
    for (const fn of listeners.splice(0)) {
      try {
        fn(lost, detail)
      } catch {}
    }
    ac.abort(lost)
  }
  // The lease runs out ttlMs after the last answer that kept it; a renew that has not answered
  // by then cannot be counted on.
  const armExpiry = (): void => {
    expiry = time.set(() => {
      expiry = undefined
      lose('expired')
    }, ttlMs)
  }
  const schedule = (): void => {
    next = time.set(
      () => {
        next = undefined
        void renewOnce()
      },
      Math.max(1, Math.floor(ttlMs / 3)),
    )
  }
  const renewOnce = async (): Promise<void> => {
    if (stopped || lost) {
      return
    }
    let ok: boolean
    try {
      ok = (await lease.renew(runId, { owner, ttlMs })) === true
    } catch (err) {
      lose('error', messageOf(err), err)
      return
    }
    if (stopped || lost) {
      return
    }
    if (!ok) {
      lose('refused')
      return
    }
    if (expiry !== undefined) {
      time.clear(expiry)
    }
    armExpiry()
    schedule()
  }
  armExpiry()
  schedule()
  return {
    owner,
    signal: ac.signal,
    get lost() {
      return lost
    },
    onLost: (fn) => {
      if (lost) {
        fn(lost, lostDetail)
        return
      }
      listeners.push(fn)
    },
    release: async (log) => {
      if (stopped) {
        return
      }
      stopped = true
      clear()
      listeners.length = 0
      // A lease that is lost is not ours to release: another worker may hold it now.
      if (lost) {
        return
      }
      try {
        await lease.release(runId, { owner })
      } catch (err) {
        log(`[lease] release of run ${runId} threw: ${messageOf(err)}`)
      }
    },
  }
}
