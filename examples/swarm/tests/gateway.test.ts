// The gateway over loopback with a fake backend and a fake event log: routing, auth, CORS, body
// bounds, error mapping, and the event stream (replay after a cursor, Last-Event-ID, live wake-up,
// keep-alive, the connection cap, shutdown).
import assert from 'node:assert/strict'
import { request } from 'node:http'
import type { Server } from 'node:http'
import { after, before, test } from 'node:test'
import { compareCursors, type ICursor } from '../src/cursor.ts'
import type { IStreamRow } from '../src/db/events.ts'
import type { IParkedRow } from '../src/db/parked.ts'
import { createNotifyHub, type IListenClient } from '../src/db/notify.ts'
import {
  BackendUnavailableError,
  createGateway,
  listen,
  matchRoute,
  SessionEndedError,
  SessionNotFoundError,
  pipelineView,
  sseFrame,
  subagentView,
  type IGateway,
  type ISessionBackend,
} from '../src/gateway.ts'
import { corsHeaders, createBearerCheck } from '../src/http.ts'
import { silentLogger } from '../src/log.ts'
import type { ISessionView } from '../src/session-types.ts'
import { readSse } from './helpers/sse.ts'

const TOKEN = 'unit-test-token-0123456789abcdef'
const OTHER = 'rotated-token-0123456789abcdefgh'

// --- fakes -------------------------------------------------------------------------------------

const calls: { name: string; args: unknown[] }[] = []
let failWith: Error | undefined
let readyError: Error | undefined
const known = new Set(['s1', 'ended'])
// What parked turns of s1 wait for (swarm_parked).
const parkedRow = (itemId: string, extra: Partial<IParkedRow> = {}): IParkedRow => ({
  sessionId: 's1',
  itemId,
  turn: 1,
  runId: 'r1',
  kind: 'approval',
  answeredBy: 'client',
  item: { kind: 'approval' },
  state: 'pending',
  ...extra,
})
const parkedRows = new Map<string, IParkedRow>([
  ['q1', parkedRow('q1')],
  ['t1', parkedRow('t1', { kind: 'tool', item: { kind: 'tool', toolName: 'render' } })],
  ['done', parkedRow('done', { state: 'answered' })],
  ['gone', parkedRow('gone', { state: 'cancelled' })],
  [
    'sub1',
    parkedRow('sub1', {
      kind: 'tool',
      answeredBy: 'subagent',
      childId: 'subagent-s1-r1-sub1',
      item: { kind: 'tool', subagent: { name: 'researcher', task: 'dig' } },
    }),
  ],
  [
    'pipe1',
    parkedRow('pipe1', {
      kind: 'tool',
      answeredBy: 'pipeline',
      childId: 'pipeline-s1-r1-pipe1',
      item: { kind: 'tool', pipeline: { name: 'review', task: 'check it' } },
    }),
  ],
])
let parkedFails = false

const backend: ISessionBackend = {
  create: async (...args) => void calls.push({ name: 'create', args }),
  message: async (...args) => {
    calls.push({ name: 'message', args })
    if (failWith) throw failWith
  },
  answer: async (...args) => void calls.push({ name: 'answer', args }),
  stop: async (...args) => void calls.push({ name: 'stop', args }),
  state: async (sessionId) => {
    if (!known.has(sessionId)) throw new SessionNotFoundError(sessionId)
    return {
      sessionId,
      status: 'idle',
      turn: 0,
      queued: [],
      dropped: 0,
      history: [],
      turns: [],
    } as ISessionView
  },
  exists: async (sessionId) => known.has(sessionId),
  parkedItem: async (sessionId, itemId) => {
    if (parkedFails) throw new Error('connection refused')
    return sessionId === 's1' ? parkedRows.get(itemId) : undefined
  },
  subagents: async (sessionId) =>
    sessionId === 's1' ? [...parkedRows.values()].filter((r) => r.answeredBy === 'subagent') : [],
  pipelines: async (sessionId) =>
    sessionId === 's1' ? [...parkedRows.values()].filter((r) => r.answeredBy === 'pipeline') : [],
  ready: async () => {
    if (readyError) throw readyError
  },
}

// The event log: rows per session, and a LISTEN client the test notifies by hand.
const rows = new Map<string, IStreamRow[]>()
let afterCalls = 0
const fakeListen: { handlers: Record<string, ((...a: never[]) => void)[]> } = { handlers: {} }
const listenClient = (): IListenClient => {
  fakeListen.handlers = {}
  const on = (event: string, fn: (...a: never[]) => void) => {
    ;(fakeListen.handlers[event] ??= []).push(fn)
  }
  return {
    connect: async () => undefined,
    query: async () => undefined,
    on: on as IListenClient['on'],
    end: async () => undefined,
  }
}
const notify = (sessionId: string): void => {
  for (const fn of fakeListen.handlers.notification ?? []) {
    ;(fn as (m: { channel: string; payload: string }) => void)({
      channel: 'swarm_events',
      payload: sessionId,
    })
  }
}
const row = (turn: number, attempt: number, seq: number, type = 'log'): IStreamRow => ({
  cursor: { turn, attempt, seq },
  json: JSON.stringify({ type, seq }),
})
const append = (sessionId: string, r: IStreamRow): void => {
  rows.set(sessionId, [...(rows.get(sessionId) ?? []), r])
  notify(sessionId)
}

const hub = createNotifyHub({ channel: 'swarm_events', newClient: listenClient })
let gateway: IGateway
let server: Server
let base: string

const start = async (extra: { batch?: number; maxConnections?: number } = {}) => {
  gateway = createGateway({
    config: {
      auth: { mode: 'bearer', tokens: [TOKEN, OTHER] },
      corsOrigins: ['https://app.example'],
      maxBodyBytes: 1024,
      messageMaxChars: 100,
      sse: { maxConnections: extra.maxConnections ?? 3, keepAliveMs: 100, batch: extra.batch ?? 2 },
    },
    backend,
    feed: {
      after: async (sessionId: string, after: ICursor, limit: number) => {
        afterCalls += 1
        return (rows.get(sessionId) ?? [])
          .filter((r) => compareCursors(r.cursor, after) > 0)
          .sort((a, b) => compareCursors(a.cursor, b.cursor))
          .slice(0, limit)
      },
      subscribe: hub.subscribe,
      ready: hub.ready,
      open: hub.size,
    },
    log: silentLogger,
    now: () => 42,
  })
  server = await listen(gateway, '127.0.0.1', 0)
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}

before(async () => {
  await hub.start()
  await start()
})

after(async () => {
  gateway.closeStreams()
  await hub.stop()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const auth = { authorization: `Bearer ${TOKEN}` }
const json = { ...auth, 'content-type': 'application/json' }
const post = (path: string, body?: string, headers: Record<string, string> = json) =>
  fetch(`${base}${path}`, { method: 'POST', headers, ...(body !== undefined ? { body } : {}) })

// --- routing and auth --------------------------------------------------------------------------

test('routes: 404, 405 with Allow, ids that are not ids are 404', () => {
  assert.deepEqual(matchRoute('GET', '/nope'), { ok: false, status: 404 })
  assert.deepEqual(matchRoute('GET', '/sessions'), { ok: false, status: 405, allow: 'POST' })
  assert.deepEqual(matchRoute('DELETE', '/sessions/s1'), { ok: false, status: 405, allow: 'GET' })
  assert.deepEqual(matchRoute('GET', '/sessions/a.b'), { ok: false, status: 404 })
  assert.deepEqual(matchRoute('GET', `/sessions/${'x'.repeat(65)}`), { ok: false, status: 404 })
  assert.deepEqual(matchRoute('POST', '/sessions/s1/answers/r%2F1'), { ok: false, status: 404 })
  const hit = matchRoute('POST', '/sessions/s1/answers/req_1')
  assert.ok(hit.ok)
  assert.deepEqual(hit.route, { name: 'answer', sessionId: 's1', requestId: 'req_1' })
})

test('health needs no token; readiness reports what is down', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  const ready = await fetch(`${base}/readyz`)
  assert.equal(ready.status, 200)
  readyError = new Error('temporal: unreachable')
  const notReady = await fetch(`${base}/readyz`)
  assert.equal(notReady.status, 503)
  assert.deepEqual(((await notReady.json()) as { checks: unknown }).checks, {
    events: 'ok',
    backend: 'temporal: unreachable',
  })
  readyError = undefined
})

test('the bearer token: missing, wrong, right, rotated', async () => {
  const none = await fetch(`${base}/sessions/s1`)
  assert.equal(none.status, 401)
  assert.equal(none.headers.get('www-authenticate'), 'Bearer')
  assert.equal(
    (await fetch(`${base}/sessions/s1`, { headers: { authorization: 'Bearer nope' } })).status,
    401,
  )
  assert.equal(
    (await fetch(`${base}/sessions/s1`, { headers: { authorization: `Basic ${TOKEN}` } })).status,
    401,
  )
  assert.equal((await fetch(`${base}/sessions/s1`, { headers: auth })).status, 200)
  assert.equal(
    (await fetch(`${base}/sessions/s1`, { headers: { authorization: `bearer ${OTHER}` } })).status,
    200,
  )
})

test('createBearerCheck: exact tokens only', () => {
  const check = createBearerCheck([TOKEN])
  assert.equal(check(`Bearer ${TOKEN}`), true)
  assert.equal(check(`Bearer ${TOKEN}  `), true)
  assert.equal(check(`Bearer ${TOKEN}x`), false)
  assert.equal(check(`Bearer ${TOKEN.slice(0, -1)}`), false)
  assert.equal(check(`Bearer ${TOKEN} extra`), false)
  assert.equal(check(TOKEN), false)
  assert.equal(check(undefined), false)
  assert.equal(check('Bearer '), false)
  assert.equal(createBearerCheck([])(`Bearer ${TOKEN}`), false)
})

test('CORS: listed origins only, preflight answers the methods and headers', async () => {
  assert.deepEqual(corsHeaders(undefined, ['*'], false), {})
  assert.deepEqual(corsHeaders('https://evil.example', ['https://app.example'], false), {})
  assert.equal(corsHeaders('https://x', ['*'], false)['access-control-allow-origin'], '*')
  const pre = await fetch(`${base}/sessions`, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.example' },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://app.example')
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/)
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /last-event-id/)
  const actual = await fetch(`${base}/sessions/s1`, {
    headers: { ...auth, origin: 'https://app.example' },
  })
  assert.equal(actual.headers.get('access-control-allow-origin'), 'https://app.example')
  assert.equal(actual.headers.get('vary'), 'Origin')
  const foreign = await fetch(`${base}/sessions/s1`, {
    headers: { ...auth, origin: 'https://evil.example' },
  })
  assert.equal(foreign.headers.get('access-control-allow-origin'), null)
})

// --- bodies ------------------------------------------------------------------------------------

test('bodies are bounded, typed and objects', async () => {
  const big = await post('/sessions/s1/messages', JSON.stringify({ text: 'x'.repeat(2000) }))
  assert.equal(big.status, 413)
  // A chunked body (no Content-Length) is counted as it streams.
  const chunked = await new Promise<number>((resolve, reject) => {
    const req = request(
      `${base}/sessions/s1/messages`,
      { method: 'POST', headers: json },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    for (let i = 0; i < 10; i++) req.write(`${'y'.repeat(200)}`)
    req.end()
  })
  assert.equal(chunked, 413)
  assert.equal(
    (
      await post('/sessions/s1/messages', '{"text":"hi"}', {
        ...auth,
        'content-type': 'text/plain',
      })
    ).status,
    415,
  )
  assert.equal((await post('/sessions/s1/messages', '{"text":')).status, 400)
  assert.equal((await post('/sessions/s1/messages', '["text"]')).status, 400)
  assert.equal((await post('/sessions/s1/messages')).status, 400, 'a message needs a body')
  assert.equal((await post('/sessions/s1/messages', '{"text":"   "}')).status, 400)
  assert.equal(
    (await post('/sessions/s1/messages', JSON.stringify({ text: 'z'.repeat(101) }))).status,
    413,
  )
  assert.equal((await post('/sessions/s1/messages', '{"text":"hi","id":"a b"}')).status, 400)
})

test('create, message, answer, stop reach the backend', async () => {
  calls.length = 0
  const created = await post('/sessions')
  assert.equal(created.status, 201)
  const { sessionId } = (await created.json()) as { sessionId: string }
  assert.equal(created.headers.get('location'), `/sessions/${sessionId}`)
  assert.deepEqual(calls.at(-1), { name: 'create', args: [sessionId, undefined] })

  const withFirst = await post('/sessions', JSON.stringify({ message: 'hello', id: 'm-1' }))
  assert.equal(withFirst.status, 201)
  assert.deepEqual(calls.at(-1)?.args[1], { id: 'm-1', text: 'hello', at: 42 })

  const sent = await post('/sessions/s1/messages', JSON.stringify({ text: 'hi' }))
  assert.equal(sent.status, 202)
  const { messageId } = (await sent.json()) as { messageId: string }
  assert.deepEqual(calls.at(-1), {
    name: 'message',
    args: ['s1', { id: messageId, text: 'hi', at: 42 }],
  })

  const answer = await post('/sessions/s1/answers/q1', JSON.stringify({ approved: true }))
  assert.equal(answer.status, 202)
  assert.deepEqual(await answer.json(), { requestId: 'q1', kind: 'approval' })
  assert.deepEqual(calls.at(-1), {
    name: 'answer',
    args: ['s1', { requestId: 'q1', value: { approved: true }, at: 42 }],
  })

  assert.equal((await post('/sessions/s1/stop')).status, 202)
  assert.deepEqual(calls.at(-1), { name: 'stop', args: ['s1', { at: 42 }] })
  assert.equal((await post('/sessions/s1/stop', '{"end":true}')).status, 202)
  assert.deepEqual(calls.at(-1), { name: 'stop', args: ['s1', { end: true, at: 42 }] })
  assert.equal((await post('/sessions/s1/stop', '{"end":"yes"}')).status, 400)
})

test('backend errors map to 404 / 409 / 503, anything else to a bare 500', async () => {
  const send = () => post('/sessions/s1/messages', '{"text":"hi"}')
  failWith = new SessionNotFoundError('s1')
  assert.equal((await send()).status, 404)
  failWith = new SessionEndedError('s1')
  const ended = await send()
  assert.equal(ended.status, 409)
  assert.equal(((await ended.json()) as { error: { code: string } }).error.code, 'session_ended')
  failWith = new BackendUnavailableError('temporal: down')
  const down = await send()
  assert.equal(down.status, 503)
  assert.equal(down.headers.get('retry-after'), '2')
  failWith = new Error('secret internals')
  const boom = await send()
  assert.equal(boom.status, 500)
  assert.doesNotMatch(await boom.text(), /secret internals/)
  failWith = undefined
  assert.equal((await fetch(`${base}/sessions/unknown`, { headers: auth })).status, 404)
})

test('answers: checked against the pending item and its kind before the session is signalled', async () => {
  calls.length = 0
  const code = async (res: Response): Promise<[number, string]> => [
    res.status,
    ((await res.json()) as { error?: { code: string } }).error?.code ?? 'ok',
  ]
  const answer = (id: string, body: unknown, session = 's1') =>
    post(`/sessions/${session}/answers/${id}`, JSON.stringify(body))
  // Unknown item, another session's, a cancelled one: 404.
  assert.deepEqual(await code(await answer('nope', { approved: true })), [404, 'not_found'])
  assert.deepEqual(await code(await answer('q1', { approved: true }, 'other')), [404, 'not_found'])
  assert.deepEqual(await code(await answer('gone', { approved: true })), [404, 'not_found'])
  // Answered already; answered by a subagent: 409.
  assert.deepEqual(await code(await answer('done', { approved: true })), [409, 'already_answered'])
  assert.deepEqual(await code(await answer('sub1', { output: 'mine' })), [
    409,
    'answered_by_subagent',
  ])
  assert.deepEqual(await code(await answer('pipe1', { output: 'mine' })), [
    409,
    'answered_by_pipeline',
  ])
  // The shape per kind: 400.
  assert.deepEqual(await code(await answer('q1', { output: 'x' })), [400, 'invalid_answer'])
  assert.deepEqual(await code(await answer('q1', { approved: 'yes' })), [400, 'invalid_answer'])
  assert.deepEqual(await code(await answer('q1', { approved: true, remember: true })), [
    400,
    'invalid_answer',
  ])
  assert.deepEqual(await code(await answer('t1', { approved: true })), [400, 'invalid_answer'])
  assert.deepEqual(await code(await answer('t1', { output: 1, error: 'x' })), [
    400,
    'invalid_answer',
  ])
  assert.equal(calls.length, 0, 'nothing refused reached the session')
  // A tool result: output or error.
  assert.equal((await answer('t1', { output: { url: 'https://x' } })).status, 202)
  assert.equal((await answer('t1', { error: 'render failed' })).status, 202)
  assert.deepEqual(
    calls.map((c) => (c.args[1] as { value: unknown }).value),
    [{ output: { url: 'https://x' } }, { error: 'render failed' }],
  )
  // Postgres down: 503, not a 500.
  parkedFails = true
  assert.deepEqual(await code(await answer('q1', { approved: true })), [503, 'unavailable'])
  parkedFails = false
})

test('subagents: listed from the session, each with its own stream', async () => {
  const listed = await fetch(`${base}/sessions/s1/subagents`, { headers: auth })
  assert.equal(listed.status, 200)
  assert.deepEqual(await listed.json(), {
    subagents: [subagentView(parkedRows.get('sub1')!)],
  })
  assert.deepEqual(subagentView(parkedRows.get('sub1')!), {
    itemId: 'sub1',
    turn: 1,
    runId: 'r1',
    state: 'pending',
    workflowId: 'subagent-s1-r1-sub1',
    name: 'researcher',
    task: 'dig',
    events: '/sessions/s1/subagents/sub1/events',
  })
  assert.equal((await fetch(`${base}/sessions/nope/subagents`, { headers: auth })).status, 404)
  // A child's stream: rows keyed by its own stream id; an item no subagent answers is a 404.
  append('s1/sub1', row(1, 1, 1, 'plan.created'))
  append('s1/sub1', row(1, 2147483647, 0, 'turn.ended'))
  const child = await readSse(`${base}/sessions/s1/subagents/sub1/events`, auth, (seen) =>
    seen.some((e) => e.data.event.type === 'turn.ended'),
  )
  assert.equal(child.status, 200)
  assert.deepEqual(
    child.events.map((e) => e.id),
    ['1:1:1', '1:2147483647:0'],
  )
  const notChild = await readSse(`${base}/sessions/s1/subagents/q1/events`, auth, () => true)
  assert.equal(notChild.status, 404)
  assert.ok(matchRoute('GET', '/sessions/s1/subagents/sub1/events').ok)
  assert.deepEqual(matchRoute('GET', '/sessions/s1/subagents/a.b/events'), {
    ok: false,
    status: 404,
  })
})

test('pipelines: listed from the session; their own streams and their node visits', async () => {
  const listed = await fetch(`${base}/sessions/s1/pipelines`, { headers: auth })
  assert.equal(listed.status, 200)
  assert.deepEqual(await listed.json(), { pipelines: [pipelineView(parkedRows.get('pipe1')!)] })
  assert.deepEqual(pipelineView(parkedRows.get('pipe1')!), {
    itemId: 'pipe1',
    turn: 1,
    runId: 'r1',
    state: 'pending',
    workflowId: 'pipeline-s1-r1-pipe1',
    name: 'review',
    task: 'check it',
    events: '/sessions/s1/pipelines/pipe1/events',
  })
  assert.equal((await fetch(`${base}/sessions/nope/pipelines`, { headers: auth })).status, 404)
  assert.equal(
    (await fetch(`${base}/sessions/s1/pipelines`, { headers: { authorization: 'Bearer x' } }))
      .status,
    401,
  )
  // The pipeline's own stream: keyed <session>/<item>, the same frames and cursor.
  append('s1/pipe1', row(1, 0, 0, 'turn.started'))
  append('s1/pipe1', row(1, 1, 1, 'pipeline.started'))
  append('s1/pipe1', row(1, 1, 2, 'pipeline.node.started'))
  append('s1/pipe1', row(1, 2147483647, 0, 'turn.ended'))
  const own = await readSse(
    `${base}/sessions/s1/pipelines/pipe1/events?after=1:1:1`,
    auth,
    (seen) => seen.some((e) => e.data.event.type === 'turn.ended'),
  )
  assert.equal(own.status, 200)
  assert.deepEqual(
    own.events.map((e) => e.id),
    ['1:1:2', '1:2147483647:0'],
    'replay after the cursor',
  )
  // Last-Event-ID wins over ?after=.
  const resumed = await readSse(
    `${base}/sessions/s1/pipelines/pipe1/events?after=0:0:0`,
    { ...auth, 'last-event-id': '1:1:2' },
    (seen) => seen.some((e) => e.data.event.type === 'turn.ended'),
  )
  assert.deepEqual(
    resumed.events.map((e) => e.id),
    ['1:2147483647:0'],
  )
  // A node visit's stream: <session>/<item>/<node>/<visit>.
  append('s1/pipe1/review/2', row(1, 1, 1, 'plan.created'))
  append('s1/pipe1/review/2', row(1, 2147483647, 0, 'turn.ended'))
  const visit = await readSse(
    `${base}/sessions/s1/pipelines/pipe1/nodes/review/2/events`,
    auth,
    (seen) => seen.some((e) => e.data.event.type === 'turn.ended'),
  )
  assert.equal(visit.status, 200)
  assert.deepEqual(
    visit.events.map((e) => e.id),
    ['1:1:1', '1:2147483647:0'],
  )
  // Not a pipeline's item (a subagent's, a person's, none): 404. A bad cursor: 400.
  for (const path of [
    '/sessions/s1/pipelines/sub1/events',
    '/sessions/s1/pipelines/q1/events',
    '/sessions/s1/pipelines/nope/events',
    '/sessions/s1/pipelines/sub1/nodes/review/1/events',
    '/sessions/other/pipelines/pipe1/events',
  ]) {
    assert.equal((await readSse(`${base}${path}`, auth, () => true)).status, 404, path)
  }
  assert.equal(
    (await readSse(`${base}/sessions/s1/pipelines/pipe1/events?after=x`, auth, () => true)).status,
    400,
  )
  // A subagent's stream route does not serve a pipeline's item.
  assert.equal(
    (await readSse(`${base}/sessions/s1/subagents/pipe1/events`, auth, () => true)).status,
    404,
  )
  // Route shapes: a node id is an id, a visit is 1..999.
  assert.deepEqual(matchRoute('GET', '/sessions/s1/pipelines/p/nodes/n_1/3/events'), {
    ok: true,
    route: {
      name: 'pipelineNodeEvents',
      sessionId: 's1',
      requestId: 'p',
      nodeId: 'n_1',
      visit: '3',
    },
  })
  for (const bad of [
    '/nodes/a.b/1/',
    '/nodes/a/0/',
    '/nodes/a/01/',
    '/nodes/a/1000/',
    '/nodes/a/x/',
  ]) {
    assert.deepEqual(matchRoute('GET', `/sessions/s1/pipelines/p${bad}events`), {
      ok: false,
      status: 404,
    })
  }
  assert.deepEqual(matchRoute('POST', '/sessions/s1/pipelines'), {
    ok: false,
    status: 405,
    allow: 'GET',
  })
})

// --- the event stream --------------------------------------------------------------------------

test('sseFrame: the cursor is the id; the event is under data on one line', () => {
  assert.equal(
    sseFrame({ cursor: { turn: 2, attempt: 1, seq: 7 }, json: '{"type":"final"}' }),
    'id: 2:1:7\ndata: {"cursor":"2:1:7","turn":2,"event":{"type":"final"}}\n\n',
  )
})

test('events: replay after the cursor (paged), Last-Event-ID wins, then live', async () => {
  rows.set('s1', [
    row(1, 0, 0, 'turn.started'),
    row(1, 1, 1),
    row(1, 1, 2),
    row(1, 1, 3),
    row(1, 2, 1),
  ])
  const all = await readSse(`${base}/sessions/s1/events`, auth, (seen) => seen.length >= 5, 5000)
  assert.equal(all.status, 200)
  assert.deepEqual(
    all.events.map((e) => e.id),
    ['1:0:0', '1:1:1', '1:1:2', '1:1:3', '1:2:1'],
  )
  assert.equal(all.events[0]?.data.event.type, 'turn.started')

  const fromQuery = await readSse(
    `${base}/sessions/s1/events?after=1:1:2`,
    auth,
    (s) => s.length >= 2,
    5000,
  )
  assert.deepEqual(
    fromQuery.events.map((e) => e.id),
    ['1:1:3', '1:2:1'],
  )
  const fromHeader = await readSse(
    `${base}/sessions/s1/events?after=0:0:0`,
    { ...auth, 'last-event-id': '1:1:3' },
    (s) => s.length >= 1,
    5000,
  )
  assert.deepEqual(
    fromHeader.events.map((e) => e.id),
    ['1:2:1'],
  )

  // Live: the stream is open and caught up; a new row and its NOTIFY reach it.
  const live = readSse(`${base}/sessions/s1/events?after=1:2:1`, auth, (s) => s.length >= 2, 5000)
  await new Promise((r) => setTimeout(r, 150))
  append('s1', row(1, 2, 2))
  append('s1', row(1, 2147483647, 0, 'turn.ended'))
  const got = await live
  assert.deepEqual(
    got.events.map((e) => e.id),
    ['1:2:2', '1:2147483647:0'],
  )
})

test('events: bad cursor 400, unknown session 404, idle streams get keep-alives', async () => {
  assert.equal((await fetch(`${base}/sessions/s1/events?after=1:2`, { headers: auth })).status, 400)
  assert.equal(
    (await fetch(`${base}/sessions/s1/events`, { headers: { ...auth, 'last-event-id': 'x' } }))
      .status,
    400,
  )
  assert.equal((await fetch(`${base}/sessions/nope/events`, { headers: auth })).status, 404)
  assert.equal((await fetch(`${base}/sessions/s1/events`)).status, 401)

  const ac = new AbortController()
  const res = await fetch(`${base}/sessions/ended/events`, { headers: auth, signal: ac.signal })
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(res.headers.get('x-accel-buffering'), 'no')
  let text = ''
  const decoder = new TextDecoder()
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk)
    if (text.includes(': keep-alive')) break
  }
  ac.abort()
  assert.match(text, /^retry: 2000\n\n/)
  assert.match(text, /: keep-alive\n\n/)
})

test('events: the connection cap answers 503; shutdown ends the open streams', async () => {
  await new Promise((r) => setTimeout(r, 100))
  const held = Array.from({ length: 3 }, () => {
    const ac = new AbortController()
    return {
      ac,
      res: fetch(`${base}/sessions/ended/events`, { headers: auth, signal: ac.signal }),
    }
  })
  await Promise.all(held.map((h) => h.res))
  const refused = await fetch(`${base}/sessions/ended/events`, { headers: auth })
  assert.equal(refused.status, 503)
  assert.equal(refused.headers.get('retry-after'), '5')
  const before = afterCalls
  gateway.closeStreams()
  // Every held stream ends (the body completes) without the client aborting it.
  await Promise.all(
    held.map(async (h) => {
      const body = await (await h.res).text()
      assert.match(body, /^retry: 2000/)
    }),
  )
  assert.ok(afterCalls >= before)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(hub.size(), 0)
})
