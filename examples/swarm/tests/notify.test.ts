// The LISTEN fan-out over a fake connection: a notification is never lost between a read and a
// wait, only the session's streams wake, a lost connection is re-opened and wakes everyone.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNotifyHub, type IListenClient } from '../src/db/notify.ts'

type Handler = (...args: never[]) => void

const fakeClients = () => {
  const made: { handlers: Record<string, Handler[]>; queries: string[]; ended: boolean }[] = []
  let failConnect = 0
  const newClient = (): IListenClient => {
    const c = { handlers: {} as Record<string, Handler[]>, queries: [] as string[], ended: false }
    made.push(c)
    return {
      connect: async () => {
        if (failConnect > 0) {
          failConnect -= 1
          throw new Error('refused')
        }
      },
      query: async (text) => void c.queries.push(text),
      on: ((event: string, fn: Handler) => {
        ;(c.handlers[event] ??= []).push(fn)
      }) as IListenClient['on'],
      end: async () => {
        c.ended = true
      },
    }
  }
  const emit = (i: number, event: string, arg?: unknown) => {
    for (const fn of made[i]?.handlers[event] ?? []) (fn as (a: unknown) => void)(arg)
  }
  return { made, newClient, emit, failNext: (n: number) => (failConnect = n) }
}

test('LISTEN on start; a pending notification is not lost; only the session wakes', async () => {
  const f = fakeClients()
  const hub = createNotifyHub({ channel: 'swarm_events', newClient: f.newClient })
  await hub.start()
  assert.equal(hub.ready(), true)
  assert.deepEqual(f.made[0]?.queries, ['LISTEN swarm_events'])
  const a = hub.subscribe('a')
  const b = hub.subscribe('b')
  // Arrives while "a" is reading (not waiting): the next wait returns at once.
  f.emit(0, 'notification', { channel: 'swarm_events', payload: 'a' })
  assert.equal(await a.wait(1000), 'notified')
  assert.equal(await a.wait(20), 'timeout', 'consumed')
  assert.equal(await b.wait(20), 'timeout')
  // Another channel or no payload: ignored.
  f.emit(0, 'notification', { channel: 'other', payload: 'a' })
  f.emit(0, 'notification', { channel: 'swarm_events' })
  assert.equal(await a.wait(20), 'timeout')
  const waiting = b.wait(1000)
  f.emit(0, 'notification', { channel: 'swarm_events', payload: 'b' })
  assert.equal(await waiting, 'notified')
  assert.equal(hub.size(), 2)
  a.close()
  b.close()
  assert.equal(hub.size(), 0)
  await hub.stop()
})

test('a lost connection is re-opened with backoff and wakes every stream', async () => {
  const f = fakeClients()
  const logs: string[] = []
  const hub = createNotifyHub({
    channel: 'swarm_events',
    newClient: f.newClient,
    minBackoffMs: 10,
    maxBackoffMs: 40,
    log: (m) => logs.push(m),
  })
  await hub.start()
  const s = hub.subscribe('x')
  const woke = s.wait(2000)
  f.failNext(1)
  f.emit(0, 'error', new Error('terminated'))
  assert.equal(hub.ready(), false)
  assert.equal(f.made[0]?.ended, true)
  assert.equal(await woke, 'notified', 'woken by the reconnect, to read again')
  assert.equal(hub.ready(), true)
  assert.equal(f.made.length, 3, 'one failed reconnect, then one that held')
  assert.match(logs[0] ?? '', /terminated/)
  s.close()
  await hub.stop()
})

test('wait ends on abort and on close; stop wakes the waiting streams', async () => {
  const f = fakeClients()
  const hub = createNotifyHub({ channel: 'swarm_events', newClient: f.newClient })
  await hub.start()
  const s = hub.subscribe('x')
  const ac = new AbortController()
  const aborted = s.wait(5000, ac.signal)
  ac.abort()
  assert.equal(await aborted, 'closed')
  const stopping = s.wait(5000)
  await hub.stop()
  assert.equal(await stopping, 'closed')
  s.close()
  assert.equal(await s.wait(10), 'closed')
})
