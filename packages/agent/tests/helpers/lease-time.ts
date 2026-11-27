import type { TestContext } from 'node:test'

// Virtual time for the timers of `config.runLease` (`src/run-lease.ts`, through its own test
// seam): the renew cadence and the expiry of a renew that does not answer move only when the test
// ticks them, so a test proves "every ttlMs / 3" without a sleep. Everything else keeps real time.
// The run deadlines (`virtual-time.ts`) and the MCP listen stream (`listen-time.ts`) have seams of
// their own: the three do not mix.

const KEY = Symbol.for('@dudko.dev/agent:run-lease-test-time')

export interface ILeaseTime {
  /** Move the time on by `ms`, firing every timer that falls due on the way, in order. */
  tick: (ms: number) => void
  /** Timers pending now: set, and not yet fired or taken down. */
  readonly running: number
  /** Timers set since the test began. */
  readonly set: number
}

/** Put the lease timers of the runs started in this test on virtual time. */
export const useLeaseTime = (
  t: TestContext,
  options: { expectTimers?: boolean } = {},
): ILeaseTime => {
  const global = globalThis as unknown as Record<symbol, unknown>
  if (global[KEY] !== undefined) throw new Error('lease time is already in use')
  let now = 0
  let seq = 0
  let set = 0
  const timers = new Map<number, { at: number; fire: () => void }>()
  global[KEY] = {
    set: (fire: () => void, ms: number) => {
      seq += 1
      set += 1
      timers.set(seq, { at: now + Math.max(0, ms), fire })
      return seq
    },
    clear: (handle: unknown) => {
      timers.delete(handle as number)
    },
  }
  t.after(() => {
    delete global[KEY]
    // A test whose runs set no timer on this time proves nothing with its ticks.
    if (options.expectTimers !== false && set === 0) {
      throw new Error('no lease timer of the test was on virtual time: is the seam gone?')
    }
  })
  return {
    tick: (ms) => {
      const end = now + ms
      for (;;) {
        let next: [number, { at: number; fire: () => void }] | undefined
        for (const entry of timers) {
          if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
        }
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fire()
      }
      now = end
    },
    get running() {
      return timers.size
    },
    get set() {
      return set
    },
  }
}
