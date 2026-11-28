// LISTEN swarm_events on ONE connection per gateway, fanned out to the open streams of each
// session. A stream subscribes BEFORE it replays, so a notification that arrives while it reads
// is not lost: it leaves the subscription dirty and the next wait returns at once. A lost
// connection is re-opened with backoff, and every stream is woken to re-read after it (anything
// notified while it was down was missed).

export interface IListenClient {
  connect: () => Promise<unknown>
  query: (text: string) => Promise<unknown>
  on(event: 'notification', fn: (msg: { channel: string; payload?: string }) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  on(event: 'end', fn: () => void): unknown
  end: () => Promise<void>
}

export type WaitResult = 'notified' | 'timeout' | 'closed'

export interface ISubscription {
  // Until a notification for the session (or one already pending), `ms`, or `signal`.
  wait: (ms: number, signal?: AbortSignal) => Promise<WaitResult>
  close: () => void
}

export interface INotifyHub {
  start: () => Promise<void>
  subscribe: (sessionId: string) => ISubscription
  // The LISTEN connection is up.
  ready: () => boolean
  stop: () => Promise<void>
  // Streams open now (for the SSE cap and the tests).
  size: () => number
}

interface ISub {
  dirty: boolean
  wake?: (r: WaitResult) => void
}

export const createNotifyHub = (o: {
  channel: string
  newClient: () => IListenClient
  log?: (message: string) => void
  minBackoffMs?: number
  maxBackoffMs?: number
}): INotifyHub => {
  const subs = new Map<string, Set<ISub>>()
  let client: IListenClient | undefined
  let up = false
  let stopped = false
  let backoff = o.minBackoffMs ?? 500
  let retry: ReturnType<typeof setTimeout> | undefined

  const notify = (sub: ISub): void => {
    sub.dirty = true
    const wake = sub.wake
    delete sub.wake
    wake?.('notified')
  }
  const wakeAll = (): void => {
    for (const set of subs.values()) {
      for (const sub of set) notify(sub)
    }
  }

  const connect = async (): Promise<void> => {
    const c = o.newClient()
    let dead = false
    const lost = (why: string): void => {
      if (dead) {
        return
      }
      dead = true
      up = false
      if (client === c) {
        client = undefined
      }
      void c.end().catch(() => {})
      if (stopped) {
        return
      }
      o.log?.(`[notify] LISTEN connection lost (${why}); reconnecting in ${backoff} ms`)
      retry = setTimeout(() => {
        retry = undefined
        void connect().catch(() => {})
      }, backoff)
      retry.unref?.()
      backoff = Math.min(backoff * 2, o.maxBackoffMs ?? 10_000)
    }
    c.on('error', (err) => lost(err.message))
    c.on('end', () => lost('closed'))
    c.on('notification', (msg) => {
      if (msg.channel !== o.channel || !msg.payload) {
        return
      }
      for (const sub of subs.get(msg.payload) ?? []) notify(sub)
    })
    try {
      await c.connect()
      await c.query(`LISTEN ${o.channel}`)
    } catch (err) {
      lost((err as Error).message)
      throw err
    }
    client = c
    up = true
    backoff = o.minBackoffMs ?? 500
    // Whatever was notified while no connection listened: every stream reads again.
    wakeAll()
  }

  return {
    start: () => connect(),
    subscribe: (sessionId) => {
      const sub: ISub = { dirty: false }
      let set = subs.get(sessionId)
      if (!set) {
        set = new Set()
        subs.set(sessionId, set)
      }
      set.add(sub)
      let closed = false
      return {
        wait: (ms, signal) => {
          if (closed || signal?.aborted) {
            return Promise.resolve('closed')
          }
          if (sub.dirty) {
            sub.dirty = false
            return Promise.resolve('notified')
          }
          return new Promise<WaitResult>((resolve) => {
            const done = (r: WaitResult): void => {
              clearTimeout(timer)
              signal?.removeEventListener('abort', onAbort)
              delete sub.wake
              if (r === 'notified') {
                sub.dirty = false
              }
              resolve(r)
            }
            const onAbort = (): void => done('closed')
            const timer = setTimeout(() => done('timeout'), ms)
            signal?.addEventListener('abort', onAbort, { once: true })
            sub.wake = done
          })
        },
        close: () => {
          if (closed) {
            return
          }
          closed = true
          sub.wake?.('closed')
          set.delete(sub)
          if (set.size === 0) {
            subs.delete(sessionId)
          }
        },
      }
    },
    ready: () => up,
    stop: async () => {
      stopped = true
      if (retry) {
        clearTimeout(retry)
      }
      const c = client
      client = undefined
      up = false
      for (const set of subs.values()) {
        for (const sub of set) sub.wake?.('closed')
      }
      await c?.end().catch(() => {})
    },
    size: () => [...subs.values()].reduce((n, s) => n + s.size, 0),
  }
}
