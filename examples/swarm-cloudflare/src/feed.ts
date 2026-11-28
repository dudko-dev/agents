// The live side of the event stream, inside the session's Durable Object: swarm-shared's
// `IEventFeed` over the object's own event log. This is what LISTEN / NOTIFY is in examples/swarm,
// without the network in between: a subscription is a waiter in this object's memory, taken
// synchronously before the stream's first read (the gateway's order) - and the object runs one
// thing at a time, so an event stored after `subscribe` and before the read is either seen by the
// read or wakes the waiter. Nothing is polled.
import type { ICursor, IEventFeed, IStreamRow, ISubscription, WaitResult } from 'swarm-shared'

interface IWaiter {
  pending: boolean
  wake?: (result: WaitResult) => void
  closed: boolean
}

export interface IEventHub extends IEventFeed {
  // New rows of these streams were stored.
  notify: (streams: Iterable<string>) => void
  // End every open subscription (the object is going away).
  closeAll: () => void
}

export const createEventHub = (
  after: (stream: string, after: ICursor, limit: number) => IStreamRow[],
): IEventHub => {
  const byStream = new Map<string, Set<IWaiter>>()
  let open = 0
  const subscribe = (stream: string): ISubscription => {
    const w: IWaiter = { pending: false, closed: false }
    const set = byStream.get(stream) ?? new Set()
    set.add(w)
    byStream.set(stream, set)
    open += 1
    return {
      wait: (ms, signal) =>
        new Promise<WaitResult>((resolve) => {
          if (w.closed) return resolve('closed')
          if (w.pending) {
            w.pending = false
            return resolve('notified')
          }
          if (signal?.aborted) return resolve('closed')
          const done = (result: WaitResult): void => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            w.wake = undefined
            resolve(result)
          }
          const onAbort = (): void => done('closed')
          const timer = setTimeout(() => done('timeout'), ms)
          signal?.addEventListener('abort', onAbort, { once: true })
          w.wake = done
        }),
      close: () => {
        if (w.closed) return
        w.closed = true
        open -= 1
        w.wake?.('closed')
        set.delete(w)
        if (set.size === 0) byStream.delete(stream)
      },
    }
  }
  return {
    after: async (stream, cursor, limit) => after(stream, cursor, limit),
    subscribe,
    ready: () => true,
    open: () => open,
    notify: (streams) => {
      for (const stream of streams) {
        for (const w of byStream.get(stream) ?? []) {
          if (w.wake) {
            w.wake('notified')
          } else {
            w.pending = true
          }
        }
      }
    },
    closeAll: () => {
      for (const set of byStream.values()) {
        for (const w of set) {
          w.closed = true
          w.wake?.('closed')
        }
      }
      byStream.clear()
      open = 0
    },
  }
}
