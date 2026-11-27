import type { TestContext } from 'node:test'

// Virtual time for the WAIT CLOCKS of one test (`src/wait-clock.ts`, through its test seam): the
// step limits and the subagents' time limits of the runs the test starts move only when the test
// ticks them. However loaded the machine, the real latency of the model, the sockets and the
// workers then never counts against them, and a person's wait is a tick taken while the question
// is open - which a limit that was not stopped would not survive. Everything else keeps real
// time: the waits' own bounds (`toolApproval.timeoutMs`, `elicitation.timeoutMs`), a host's
// `AbortSignal.timeout`, the planner's and synthesizer's call limits, and a clock in another
// thread (a Node worker thread does not share this global).

const KEY = Symbol.for('@dudko.dev/agent:wait-clock-test-time')

export interface IVirtualTime {
  /** Move the time on by `ms`, firing every deadline that falls due on the way, in order. */
  tick: (ms: number) => void
  /** Deadlines running now: set, and not yet fired, taken down or stopped by a pause. */
  readonly running: number
  /**
   * Whether no deadline runs - every clock that has one is stopped. A clock in a worker learns of
   * a wait by message: `boundMs` waits that long, in real time, for it to stop. Without one the
   * answer is the state now (a wait in this thread stops its clocks before the host is asked).
   */
  stopped: (boundMs?: number) => Promise<boolean>
}

/** Put the wait clocks of this test on virtual time; real time again once the test is over. */
export const useVirtualTime = (t: TestContext): IVirtualTime => {
  const global = globalThis as unknown as Record<symbol, unknown>
  if (global[KEY] !== undefined) throw new Error('virtual time is already in use')
  let now = 1_000_000
  let seq = 0
  let set = 0
  const timers = new Map<number, { at: number; fire: () => void }>()
  global[KEY] = {
    now: () => now,
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
    // A test whose runs made no deadline on this time proves nothing with its ticks.
    if (set === 0) {
      throw new Error(
        "no clock of the test's runs was on virtual time: is wait-clock.ts's seam gone?",
      )
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
    stopped: async (boundMs = 0) => {
      const until = Date.now() + boundMs
      while (timers.size > 0) {
        if (Date.now() >= until) return false
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      return true
    },
  }
}
