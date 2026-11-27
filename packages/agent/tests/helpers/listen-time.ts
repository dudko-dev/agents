import type { TestContext } from 'node:test'

// Virtual time for the timers of the MCP listen stream (`mcp-listen.ts` in the Node package,
// `src/mcp/listen.ts` in the browser one, through their test seam): the retry after a lost
// stream and the stability timer move only when the test ticks them, so a test runs the whole
// backoff - up to a minute between two attempts - without a sleep, against real servers over
// real sockets. Everything else keeps real time, the SDK's 10 s bound on the acknowledgement
// included. The run deadlines have a seam of their own (`virtual-time.ts`): the two do not mix.
// The same file in both packages.

const KEY = Symbol.for('@dudko.dev/agent:mcp-listen-test-time')

export interface IListenTime {
  /** Move the time on by `ms`, firing every timer that falls due on the way, in order. */
  tick: (ms: number) => void
  /** Timers pending now: set, and not yet fired or taken down. */
  readonly running: number
}

/** Put the listen timers of the connections made in this test on virtual time. */
export const useListenTime = (t: TestContext): IListenTime => {
  const global = globalThis as unknown as Record<symbol, unknown>
  if (global[KEY] !== undefined) throw new Error('listen time is already in use')
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
    // A test whose connections set no timer on this time proves nothing with its ticks.
    if (set === 0) {
      throw new Error('no listen timer of the test was on virtual time: is the seam gone?')
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
  }
}
