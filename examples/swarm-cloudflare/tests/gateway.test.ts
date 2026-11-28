// The Worker's side of the API (src/gateway.ts, src/backend.ts) and the session object's event
// streams (src/host.ts, src/feed.ts), driven with `new Request(...)`: which requests reach a
// session's object and which never do, how the object's answers become swarm-shared's errors,
// and the stream the object serves - replay from the cursor, Last-Event-ID, live, the cap, the
// client going away.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { silentLogger, type IApiConfig } from 'swarm-shared'
import { createDurableBackend, type IBackendPorts } from '../src/backend.ts'
import { createWorkerGateway } from '../src/gateway.ts'
import { SessionHost } from '../src/host.ts'
import { memoryStorage } from './helpers/sqlite.ts'
import { completed, message, OPTIONS } from './helpers/host.ts'

const TOKEN = 'unit-test-token-0123456789'
const config = (extra: Partial<IApiConfig> = {}): IApiConfig => ({
  auth: { mode: 'bearer', tokens: [TOKEN] },
  corsOrigins: ['https://app.example'],
  maxBodyBytes: 65_536,
  messageMaxChars: 1000,
  sse: { maxConnections: 2, keepAliveMs: 200, batch: 2 },
  ...extra,
})

const auth = { authorization: `Bearer ${TOKEN}` }
const SID = '6f8c8c0a-3b5a-4f61-9d2a-2a1b7f1e9a10'

const fakePorts = (session: Partial<ReturnType<IBackendPorts['session']>> = {}) => {
  const seen: string[] = []
  const ports: IBackendPorts = {
    session: (id) => {
      seen.push(id)
      return {
        exists: async () => true,
        create: async () => ({ ok: true, value: true }),
        message: async () => ({ ok: true, value: true }),
        answer: async () => ({ ok: true, value: true }),
        answerChild: async () => ({ ok: true, value: true }),
        stop: async () => ({ ok: true, value: true }),
        view: async () => ({ ok: true, value: { sessionId: id, status: 'idle' } }),
        parkedItem: async () => undefined,
        calls: async () => [],
        ...session,
      } as ReturnType<IBackendPorts['session']>
    },
    ping: async () => 'ok',
  }
  return { ports, seen }
}

const gateway = (
  o: { session?: Parameters<typeof fakePorts>[0]; api?: Partial<IApiConfig> } = {},
) => {
  const { ports, seen } = fakePorts(o.session)
  const forwarded: string[] = []
  let forwardFails = false
  const g = createWorkerGateway({
    config: config(o.api),
    backend: createDurableBackend(ports, OPTIONS),
    forward: async (sessionId, request) => {
      if (forwardFails) throw new Error('the object is not reachable')
      forwarded.push(`${sessionId} ${new URL(request.url).pathname}`)
      return new Response('id: 1:0:0\ndata: {}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
    log: silentLogger,
  })
  return {
    fetch: (path: string, init: RequestInit = {}) => g.fetch(new Request(`http://w${path}`, init)),
    forwarded,
    seen,
    failForward: () => {
      forwardFails = true
    },
  }
}

test('a stream is forwarded to its session object only with a valid token', async () => {
  const g = gateway()
  const no = await g.fetch(`/sessions/${SID}/events`)
  assert.equal(no.status, 401)
  assert.equal(no.headers.get('www-authenticate'), 'Bearer')
  const wrong = await g.fetch(`/sessions/${SID}/events`, {
    headers: { authorization: 'Bearer not-the-token-not-the-token' },
  })
  assert.equal(wrong.status, 401)
  assert.deepEqual(g.forwarded, [], 'no object was reached')
  const ok = await g.fetch(`/sessions/${SID}/events`, { headers: auth })
  assert.equal(ok.status, 200)
  for (const path of [
    `/sessions/${SID}/subagents/p_1/events`,
    `/sessions/${SID}/pipelines/p_1/events`,
    `/sessions/${SID}/pipelines/p_1/nodes/draft/2/events`,
  ]) {
    assert.equal((await g.fetch(path, { headers: auth })).status, 200)
  }
  assert.deepEqual(g.forwarded, [
    `${SID} /sessions/${SID}/events`,
    `${SID} /sessions/${SID}/subagents/p_1/events`,
    `${SID} /sessions/${SID}/pipelines/p_1/events`,
    `${SID} /sessions/${SID}/pipelines/p_1/nodes/draft/2/events`,
  ])
})

test('an id the API refuses never names an object; neither does a wrong method or a preflight', async () => {
  const g = gateway()
  assert.equal((await g.fetch('/sessions/bad.id/events', { headers: auth })).status, 404)
  assert.equal((await g.fetch(`/sessions/${'x'.repeat(65)}/events`, { headers: auth })).status, 404)
  assert.equal(
    (await g.fetch(`/sessions/${SID}/pipelines/p_1/nodes/a.b/1/events`, { headers: auth })).status,
    404,
  )
  assert.equal(
    (await g.fetch(`/sessions/${SID}/pipelines/p_1/nodes/a/0/events`, { headers: auth })).status,
    404,
  )
  assert.equal(
    (await g.fetch(`/sessions/${SID}/events`, { method: 'POST', headers: auth })).status,
    405,
  )
  const pre = await g.fetch(`/sessions/${SID}/events`, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.example' },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://app.example')
  assert.deepEqual(g.forwarded, [])
  assert.deepEqual(g.seen, [])
})

test('the 401 of a stream carries the CORS headers of an allowed origin', async () => {
  const g = gateway()
  const r = await g.fetch(`/sessions/${SID}/events`, { headers: { origin: 'https://app.example' } })
  assert.equal(r.status, 401)
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example')
})

test('an object that cannot be reached for a stream is a 503', async () => {
  const g = gateway()
  g.failForward()
  const r = await g.fetch(`/sessions/${SID}/events`, { headers: auth })
  assert.equal(r.status, 503)
  assert.equal(r.headers.get('retry-after'), '2')
})

test('auth none: a stream is forwarded without a token (GATEWAY_AUTH=none, a local try)', async () => {
  const g = gateway({ api: { auth: { mode: 'none' } } })
  assert.equal((await g.fetch(`/sessions/${SID}/events`)).status, 200)
  assert.equal(g.forwarded.length, 1)
})

test("the object's answers become the API's errors: 404, 409, a child that is over, an outage", async () => {
  const notFound = gateway({
    session: { message: async () => ({ ok: false, error: 'not_found' }) },
  })
  const post = (g: ReturnType<typeof gateway>, path: string, body: unknown) =>
    g.fetch(path, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  assert.equal((await post(notFound, `/sessions/${SID}/messages`, { text: 'x' })).status, 404)
  const ended = gateway({ session: { message: async () => ({ ok: false, error: 'ended' }) } })
  const r = await post(ended, `/sessions/${SID}/messages`, { text: 'x' })
  assert.equal(r.status, 409)
  assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'session_ended')
  const down = gateway({
    session: {
      message: async () => {
        throw new Error('Durable Object reset because its code was updated')
      },
    },
  })
  const d = await post(down, `/sessions/${SID}/messages`, { text: 'x' })
  assert.equal(d.status, 503)
  const body = (await d.json()) as { error: { message: string } }
  assert.match(body.error.message, /^durable object: /)
  // A child's item whose child is over: 404 - once the gateway has shown the child is the
  // session's (childOwnerOf, swarm-shared), which the rows below make it.
  const runId = 'run-1'
  const childOver = gateway({
    session: {
      parkedItem: async (itemId: string) =>
        itemId === 'c1'
          ? {
              sessionId: SID,
              itemId: 'c1',
              turn: 1,
              runId: 'run-c',
              kind: 'approval',
              answeredBy: 'client',
              owner: { workflowId: `subagent-${SID}-${runId}-p1`, itemId: 'p1' },
              item: {},
              state: 'pending',
            }
          : {
              sessionId: SID,
              itemId: 'p1',
              turn: 1,
              runId,
              kind: 'tool',
              answeredBy: 'subagent',
              item: {},
              state: 'pending',
            },
      answerChild: async () => ({ ok: false, error: 'child_ended' }),
    },
  })
  const c = await post(childOver, `/sessions/${SID}/answers/c1`, { approved: true })
  assert.equal(c.status, 404)
  assert.match(((await c.json()) as { error: { message: string } }).error.message, /nothing waits/)
})

test('readyz asks the backend (a limiter object answers)', async () => {
  const g = gateway()
  const r = await g.fetch('/readyz')
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { status: 'ready', checks: { events: 'ok', backend: 'ok' } })
})

// --- the session object's own streams -----------------------------------------------------------

const hostWithSession = async () => {
  const host = new SessionHost({
    storage: memoryStorage(),
    eventMaxBytes: 262_144,
    leaseTtlMs: 3000,
    perform: async () => {},
    api: () => config(),
  })
  host.create(SID, OPTIONS, message('hello'))
  await host.drain()
  return host
}

const readFrames = async (res: Response, n: number): Promise<string[]> => {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const ids: string[] = []
  while (ids.length < n) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let i: number
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, i)
      buffer = buffer.slice(i + 2)
      const id = /^id: (.*)$/m.exec(frame)?.[1]
      if (id) ids.push(id)
    }
  }
  await reader.cancel()
  return ids
}

test("the object's stream: replay after the cursor, Last-Event-ID wins, then live", async () => {
  const host = await hostWithSession()
  host.started(SID, 1, { input: 'hello' })
  host.turnOutcome(1, 0, completed('hi'))
  const url = `http://do/sessions/${SID}/events`
  const all = await readFrames(await host.fetch(new Request(url, { headers: auth })), 2)
  assert.deepEqual(all, ['1:0:0', '1:2147483647:0'])
  const after = await readFrames(
    await host.fetch(new Request(`${url}?after=1:0:0`, { headers: auth })),
    1,
  )
  assert.deepEqual(after, ['1:2147483647:0'])
  const header = await readFrames(
    await host.fetch(
      new Request(`${url}?after=0:0:0`, { headers: { ...auth, 'last-event-id': '1:0:0' } }),
    ),
    1,
  )
  assert.deepEqual(header, ['1:2147483647:0'])
  // Live: open at the end, then the next turn's marker is written.
  const live = await host.fetch(new Request(`${url}?after=1:2147483647:0`, { headers: auth }))
  const frames = readFrames(live, 1)
  await new Promise((r) => setTimeout(r, 50))
  host.started(SID, 2, { input: 'more' })
  assert.deepEqual(await frames, ['2:0:0'])
})

test("the object's stream: the token is checked again, an unknown stream is a 404, the cap holds", async () => {
  const host = await hostWithSession()
  const url = `http://do/sessions/${SID}/events`
  assert.equal((await host.fetch(new Request(url))).status, 401)
  assert.equal(
    (
      await host.fetch(
        new Request(`http://do/sessions/${SID}/subagents/p_none/events`, { headers: auth }),
      )
    ).status,
    404,
  )
  const a = new AbortController()
  const one = await host.fetch(new Request(url, { headers: auth, signal: a.signal }))
  const two = await host.fetch(new Request(url, { headers: auth }))
  assert.equal(one.status, 200)
  assert.equal(two.status, 200)
  assert.equal((await host.fetch(new Request(url, { headers: auth }))).status, 503)
  assert.equal(host.hub.open(), 2)
  // The client went away (the body cancelled): its slot is free.
  await one.body!.cancel()
  for (let i = 0; i < 20 && host.hub.open() !== 1; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.equal(host.hub.open(), 1)
  await two.body!.cancel()
})
