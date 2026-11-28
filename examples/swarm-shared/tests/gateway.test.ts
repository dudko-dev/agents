// The gateway as a fetch handler, driven with `new Request(...)` - no sockets, no Node API in the
// handler: what a platform (Workers, Cloud Run, Lambda behind an adapter, Node behind
// examples/swarm's) can rely on. Routing, auth, CORS, bodies, error mapping, the answer checks
// (a child's item included), the listings, and the event stream: replay after a cursor, paged,
// Last-Event-ID, live through the subscription, keep-alive, the cap, backpressure, the client going
// away (the body's cancel, the request's signal), shutdown.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareCursors, type ICursor } from '../src/cursor.ts'
import {
  childOwnerOf,
  createGatewayHandler,
  matchRoute,
  pipelineView,
  sseFrame,
  subagentView,
  type IApiConfig,
  type IGatewayHandler,
} from '../src/gateway.ts'
import { constantTimeEqual, corsHeaders, createBearerCheck } from '../src/http.ts'
import type { ILogger } from '../src/log.ts'
import {
  BackendUnavailableError,
  ChildEndedError,
  SessionEndedError,
  SessionNotFoundError,
  type IEventFeed,
  type IParkedRow,
  type ISessionBackend,
  type IStreamRow,
  type WaitResult,
} from '../src/platform.ts'
import type { ISessionView } from '../src/session-types.ts'

const TOKEN = 'unit-test-token-0123456789abcdef'
const OTHER = 'rotated-token-0123456789abcdefgh'

// --- fakes -------------------------------------------------------------------------------------

const calls: { name: string; args: unknown[] }[] = []
let failWith: Error | undefined
let readyError: Error | undefined
let stateAnswer: unknown
const known = new Set(['s1', 'ended'])
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
const SUB_CHILD = 'subagent-s1-r1-sub1'
const NODE_CHILD = 'pipeline-s1-r1-pipe1.draft.1'
const childRow = (itemId: string, owner: IParkedRow['owner'], extra: Partial<IParkedRow> = {}) =>
  parkedRow(itemId, { runId: 'child-run', owner, ...extra })
for (const [id, row] of [
  ['c1', childRow('c1', { workflowId: SUB_CHILD, itemId: 'sub1' })],
  [
    'n1',
    childRow(
      'n1',
      { workflowId: NODE_CHILD, itemId: 'pipe1', nodeId: 'draft', visit: 1 },
      { kind: 'tool', item: { kind: 'tool', toolName: 'render' } },
    ),
  ],
  ['cdone', childRow('cdone', { workflowId: SUB_CHILD, itemId: 'sub1' }, { state: 'answered' })],
  ['cgone', childRow('cgone', { workflowId: SUB_CHILD, itemId: 'sub1' }, { state: 'cancelled' })],
  // Owners that are not a child of s1's park: another session's workflow, the wrong kind, no such
  // call, a node visit of another node than the row says.
  ['cforged', childRow('cforged', { workflowId: 'subagent-s2-r1-sub1', itemId: 'sub1' })],
  [
    'ckind',
    childRow('ckind', { workflowId: SUB_CHILD, itemId: 'sub1', nodeId: 'draft', visit: 1 }),
  ],
  ['corphan', childRow('corphan', { workflowId: 'subagent-s1-r1-nope', itemId: 'nope' })],
  [
    'cnode',
    childRow('cnode', { workflowId: NODE_CHILD, itemId: 'pipe1', nodeId: 'other', visit: 1 }),
  ],
  // Rows of ANOTHER session, as a lookup that lost its session filter would hand them back.
  ['leak', childRow('leak', { workflowId: SUB_CHILD, itemId: 'sub1' }, { sessionId: 's2' })],
  ['leakown', parkedRow('leakown', { sessionId: 's2' })],
  [
    'subleak',
    parkedRow('subleak', { sessionId: 's2', kind: 'tool', answeredBy: 'subagent', item: {} }),
  ],
  ['cparent', childRow('cparent', { workflowId: 'subagent-s1-r1-subleak', itemId: 'subleak' })],
] as const) {
  parkedRows.set(id, row)
}
let parkedFails = false
let childEnded = false

const backend: ISessionBackend = {
  create: async (...args) => void calls.push({ name: 'create', args }),
  message: async (...args) => {
    calls.push({ name: 'message', args })
    if (failWith) throw failWith
  },
  answer: async (...args) => void calls.push({ name: 'answer', args }),
  answerChild: async (...args) => {
    calls.push({ name: 'answerChild', args })
    if (childEnded) throw new ChildEndedError(args[1])
  },
  stop: async (...args) => void calls.push({ name: 'stop', args }),
  state: async (sessionId) => {
    if (!known.has(sessionId)) throw new SessionNotFoundError(sessionId)
    if (stateAnswer !== undefined) return stateAnswer as ISessionView
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
    sessionId === 's1'
      ? [...parkedRows.values()].filter((r) => r.answeredBy === 'subagent' && r.sessionId === 's1')
      : [],
  pipelines: async (sessionId) =>
    sessionId === 's1' ? [...parkedRows.values()].filter((r) => r.answeredBy === 'pipeline') : [],
  ready: async () => {
    if (readyError) throw readyError
  },
}

// The event log in memory: rows per stream, and subscriptions with the semantics a platform's
// notification fan-out must have (a notification while nobody waits leaves the subscription
// dirty: the next wait returns at once).
interface ISub {
  dirty: boolean
  wake?: (r: WaitResult) => void
}
const rows = new Map<string, IStreamRow[]>()
const subs = new Map<string, Set<ISub>>()
let afterCalls = 0
let afterFails: Error | undefined
let feedUp = true
const notify = (stream: string): void => {
  for (const sub of subs.get(stream) ?? []) {
    sub.dirty = true
    const wake = sub.wake
    delete sub.wake
    wake?.('notified')
  }
}
const open = (): number => [...subs.values()].reduce((n, s) => n + s.size, 0)
const feed: IEventFeed = {
  after: async (stream: string, after: ICursor, limit: number) => {
    afterCalls += 1
    if (afterFails) throw afterFails
    return (rows.get(stream) ?? [])
      .filter((r) => compareCursors(r.cursor, after) > 0)
      .sort((a, b) => compareCursors(a.cursor, b.cursor))
      .slice(0, limit)
  },
  subscribe: (stream) => {
    const sub: ISub = { dirty: false }
    const set = subs.get(stream) ?? new Set<ISub>()
    subs.set(stream, set.add(sub))
    let closed = false
    return {
      wait: (ms, signal) => {
        if (closed || signal?.aborted) return Promise.resolve('closed')
        if (sub.dirty) {
          sub.dirty = false
          return Promise.resolve('notified')
        }
        return new Promise<WaitResult>((resolve) => {
          const done = (r: WaitResult): void => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            delete sub.wake
            if (r === 'notified') sub.dirty = false
            resolve(r)
          }
          const onAbort = (): void => done('closed')
          const timer = setTimeout(() => done('timeout'), ms)
          signal?.addEventListener('abort', onAbort, { once: true })
          sub.wake = done
        })
      },
      close: () => {
        if (closed) return
        closed = true
        sub.wake?.('closed')
        set.delete(sub)
        if (set.size === 0) subs.delete(stream)
      },
    }
  },
  ready: () => feedUp,
  open,
}
const row = (turn: number, attempt: number, seq: number, type = 'log'): IStreamRow => ({
  cursor: { turn, attempt, seq },
  json: JSON.stringify({ type, seq }),
})
const append = (stream: string, r: IStreamRow): void => {
  rows.set(stream, [...(rows.get(stream) ?? []), r])
  notify(stream)
}

const logged: { level: string; message: string; fields?: Record<string, unknown> }[] = []
const log: ILogger = {
  debug: () => {},
  info: () => {},
  warn: (message, fields) => void logged.push({ level: 'warn', message, fields }),
  error: (message, fields) => void logged.push({ level: 'error', message, fields }),
}

const CONFIG: IApiConfig = {
  auth: { mode: 'bearer', tokens: [TOKEN, OTHER] },
  corsOrigins: ['https://app.example'],
  maxBodyBytes: 1024,
  messageMaxChars: 100,
  sse: { maxConnections: 3, keepAliveMs: 100, batch: 2 },
}
const handlerOf = (config: Partial<IApiConfig> = {}): IGatewayHandler =>
  createGatewayHandler({
    config: { ...CONFIG, ...config },
    backend,
    feed,
    log,
    now: () => 42,
    storeName: 'postgres',
  })
const gateway = handlerOf()

const auth = { authorization: `Bearer ${TOKEN}` }
const json = { ...auth, 'content-type': 'application/json' }
const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  gateway.fetch(new Request(`http://gateway${path}`, init))
const get = (path: string, headers: Record<string, string> = auth): Promise<Response> =>
  call(path, { headers })
const post = (path: string, body?: string, headers: Record<string, string> = json) =>
  call(path, { method: 'POST', headers, ...(body !== undefined ? { body } : {}) })
const code = async (res: Response): Promise<[number, string]> => [
  res.status,
  ((await res.json()) as { error?: { code: string } }).error?.code ?? 'ok',
]

// A body the test can watch: how many chunks were read, and whether it was cancelled.
const watchedBody = (chunks: string[]) => {
  const seen = { pulls: 0, cancelled: false }
  let i = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        seen.pulls += 1
        if (i < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[i++]!))
        else controller.close()
      },
      cancel: () => {
        seen.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return { body, seen }
}

// An SSE body read frame by frame (a frame ends with a blank line) until `stop` says so.
interface IFrame {
  id?: string
  data?: { cursor: string; turn: number; event: { type: string } & Record<string, unknown> }
  text: string
}
const frames = async (
  res: Response,
  stop: (seen: IFrame[]) => boolean,
  o: { timeoutMs?: number; cancel?: boolean } = {},
): Promise<{
  frames: IFrame[]
  done: boolean
  reader: ReadableStreamDefaultReader<Uint8Array>
}> => {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const seen: IFrame[] = []
  let buffer = ''
  let done = false
  const deadline = Date.now() + (o.timeoutMs ?? 5000)
  while (!stop(seen)) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([
      reader.read(),
      new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), deadline - Date.now()))),
    ])
    clearTimeout(timer)
    if (next === 'late') {
      await reader.cancel()
      assert.fail(`the stream did not give what was expected in time (saw ${seen.length} frames)`)
    }
    if (next.done) {
      done = true
      break
    }
    buffer += decoder.decode(next.value, { stream: true })
    let i: number
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const text = buffer.slice(0, i)
      buffer = buffer.slice(i + 2)
      const id = /^id: (.*)$/m.exec(text)?.[1]
      const data = /^data: (.*)$/m.exec(text)?.[1]
      seen.push({ text, ...(id ? { id } : {}), ...(data ? { data: JSON.parse(data) } : {}) })
    }
  }
  // The reader stays the caller's when it asked to go on reading.
  if (o.cancel !== false && !done) await reader.cancel()
  return { frames: seen, done, reader }
}
const ids = (seen: IFrame[]): string[] => seen.filter((f) => f.id).map((f) => f.id!)
const until = async (ok: () => boolean, what: string, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!ok()) {
    assert.ok(Date.now() < deadline, what)
    await new Promise((r) => setTimeout(r, 5))
  }
}

// --- routing and auth --------------------------------------------------------------------------

test('routes: 404, 405 with Allow, ids that are not ids are 404', async () => {
  assert.deepEqual(matchRoute('GET', '/nope'), { ok: false, status: 404 })
  assert.deepEqual(matchRoute('GET', '/sessions'), { ok: false, status: 405, allow: 'POST' })
  assert.deepEqual(matchRoute('DELETE', '/sessions/s1'), { ok: false, status: 405, allow: 'GET' })
  assert.deepEqual(matchRoute('GET', '/sessions/a.b'), { ok: false, status: 404 })
  assert.deepEqual(matchRoute('GET', `/sessions/${'x'.repeat(65)}`), { ok: false, status: 404 })
  assert.deepEqual(matchRoute('POST', '/sessions/s1/answers/r%2F1'), { ok: false, status: 404 })
  const hit = matchRoute('POST', '/sessions/s1/answers/req_1')
  assert.ok(hit.ok)
  assert.deepEqual(hit.route, { name: 'answer', sessionId: 's1', requestId: 'req_1' })
  assert.ok(matchRoute('GET', '/sessions/s1/subagents/sub1/events').ok)
  assert.deepEqual(matchRoute('GET', '/sessions/s1/subagents/a.b/events'), {
    ok: false,
    status: 404,
  })
  // A node id is an id, a visit is 1..999.
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
  // Through the handler: the error body, Allow, and no token needed to learn a route is not there.
  const nope = await call('/nope')
  assert.deepEqual(await code(nope), [404, 'not_found'])
  const wrong = await call('/sessions', { method: 'PUT', headers: auth })
  assert.equal(wrong.status, 405)
  assert.equal(wrong.headers.get('allow'), 'POST')
  assert.equal(
    ((await wrong.json()) as { error: { code: string } }).error.code,
    'method_not_allowed',
  )
  assert.equal((await get('/sessions/a.b')).status, 404)
})

test('health needs no token; readiness reports what is down', async () => {
  const health = await call('/healthz')
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: 'ok' })
  assert.equal((await call('/readyz')).status, 200)
  readyError = new Error('temporal: unreachable')
  feedUp = false
  const notReady = await call('/readyz')
  assert.equal(notReady.status, 503)
  assert.deepEqual(await notReady.json(), {
    status: 'not ready',
    checks: { events: 'down', backend: 'temporal: unreachable' },
  })
  readyError = undefined
  feedUp = true
})

test('the bearer token: missing, wrong, right, rotated; auth off', async () => {
  const none = await get('/sessions/s1', {})
  assert.equal(none.status, 401)
  assert.equal(none.headers.get('www-authenticate'), 'Bearer')
  assert.equal((await get('/sessions/s1', { authorization: 'Bearer nope' })).status, 401)
  assert.equal((await get('/sessions/s1', { authorization: `Basic ${TOKEN}` })).status, 401)
  assert.equal((await get('/sessions/s1')).status, 200)
  assert.equal((await get('/sessions/s1', { authorization: `bearer ${OTHER}` })).status, 200)
  const open = handlerOf({ auth: { mode: 'none' } })
  assert.equal((await open.fetch(new Request('http://gateway/sessions/s1'))).status, 200)
})

test('createBearerCheck: exact tokens only, compared in constant time', async () => {
  const check = createBearerCheck([TOKEN])
  assert.equal(await check(`Bearer ${TOKEN}`), true)
  assert.equal(await check(`Bearer ${TOKEN}  `), true)
  assert.equal(await check(`Bearer ${TOKEN}x`), false)
  assert.equal(await check(`Bearer ${TOKEN.slice(0, -1)}`), false)
  assert.equal(await check(`Bearer ${TOKEN} extra`), false)
  assert.equal(await check(TOKEN), false)
  assert.equal(await check(undefined), false)
  assert.equal(await check('Bearer '), false)
  assert.equal(await createBearerCheck([])(`Bearer ${TOKEN}`), false)
  // Every token is compared, the matching one anywhere in the list.
  assert.equal(await createBearerCheck([OTHER, TOKEN])(`Bearer ${TOKEN}`), true)
  const bytes = (...b: number[]) => new Uint8Array(b)
  assert.equal(constantTimeEqual(bytes(1, 2, 3), bytes(1, 2, 3)), true)
  assert.equal(constantTimeEqual(bytes(1, 2, 3), bytes(1, 2, 4)), false)
  assert.equal(constantTimeEqual(bytes(0, 2, 3), bytes(1, 2, 3)), false)
  assert.equal(constantTimeEqual(bytes(1, 2), bytes(1, 2, 3)), false)
  assert.equal(constantTimeEqual(bytes(), bytes()), true)
})

test('CORS: listed origins only, preflight answers the methods and headers', async () => {
  assert.deepEqual(corsHeaders(undefined, ['*'], false), {})
  assert.deepEqual(corsHeaders('https://evil.example', ['https://app.example'], false), {})
  assert.equal(corsHeaders('https://x', ['*'], false)['access-control-allow-origin'], '*')
  assert.deepEqual(corsHeaders('', ['*'], false), {})
  // Preflight: any path, no token, no body.
  const pre = await call('/sessions', {
    method: 'OPTIONS',
    headers: { origin: 'https://app.example' },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.body, null)
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://app.example')
  assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
  assert.equal(
    pre.headers.get('access-control-allow-headers'),
    'authorization, content-type, last-event-id',
  )
  assert.equal(pre.headers.get('access-control-max-age'), '600')
  assert.equal(pre.headers.get('access-control-allow-credentials'), null)
  const preNope = await call('/nope', { method: 'OPTIONS', headers: { origin: 'https://evil.x' } })
  assert.equal(preNope.status, 204)
  assert.deepEqual([...preNope.headers], [])
  // The actual request, and its errors, carry the origin.
  const actual = await get('/sessions/s1', { ...auth, origin: 'https://app.example' })
  assert.equal(actual.headers.get('access-control-allow-origin'), 'https://app.example')
  assert.equal(actual.headers.get('vary'), 'Origin')
  assert.equal(actual.headers.get('access-control-allow-methods'), null)
  const refused = await get('/sessions/s1', { origin: 'https://app.example' })
  assert.equal(refused.status, 401)
  assert.equal(refused.headers.get('access-control-allow-origin'), 'https://app.example')
  const foreign = await get('/sessions/s1', { ...auth, origin: 'https://evil.example' })
  assert.equal(foreign.headers.get('access-control-allow-origin'), null)
})

test('a JSON answer: its type, length and the security headers', async () => {
  const res = await get('/sessions/s1')
  const text = await res.text()
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(res.headers.get('content-length'), String(new TextEncoder().encode(text).length))
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  // Not JSON at all (a backend that answers nothing): a bare 500.
  stateAnswer = () => {}
  const bad = await get('/sessions/s1')
  assert.deepEqual(await code(bad), [500, 'internal'])
  stateAnswer = undefined
})

// --- bodies ------------------------------------------------------------------------------------

test('bodies: bounded by Content-Length before a byte is read, and while they stream', async () => {
  const big = await post('/sessions/s1/messages', JSON.stringify({ text: 'x'.repeat(2000) }))
  assert.deepEqual(await code(big), [413, 'body_too_large'])
  assert.equal(big.headers.get('connection'), 'close')
  // Declared too long: refused unread.
  const declared = watchedBody(['{"text":"hi"}'])
  const unread = await call('/sessions/s1/messages', {
    method: 'POST',
    headers: { ...json, 'content-length': '5000' },
    body: declared.body,
    duplex: 'half',
  } as RequestInit)
  assert.equal(unread.status, 413)
  assert.equal(declared.seen.pulls, 0, 'not a byte read')
  // No length (chunked): counted as it streams; the rest is not read.
  const chunked = watchedBody(Array.from({ length: 10 }, () => 'y'.repeat(200)))
  const streamed = await call('/sessions/s1/messages', {
    method: 'POST',
    headers: json,
    body: chunked.body,
    duplex: 'half',
  } as RequestInit)
  assert.deepEqual(await code(streamed), [413, 'body_too_large'])
  assert.equal(streamed.headers.get('connection'), 'close')
  assert.equal(chunked.seen.pulls, 6, 'read up to the chunk past the limit')
  assert.equal(chunked.seen.cancelled, true, 'the rest cancelled')
  // Under the limit, chunked: read whole.
  const small = watchedBody(['{"te', 'xt":"', 'hi"}'])
  const fine = await call('/sessions/s1/messages', {
    method: 'POST',
    headers: json,
    body: small.body,
    duplex: 'half',
  } as RequestInit)
  assert.equal(fine.status, 202)
  assert.equal(small.seen.cancelled, false)
})

test('bodies are typed, JSON and objects; messages and ids are checked', async () => {
  const send = (body?: string, headers: Record<string, string> = json) =>
    post('/sessions/s1/messages', body, headers)
  assert.deepEqual(
    await code(await send('{"text":"hi"}', { ...auth, 'content-type': 'text/plain' })),
    [415, 'unsupported_media_type'],
  )
  assert.equal(
    (await send('{"text":"hi"}', { ...auth, 'content-type': 'Application/JSON; charset=utf-8' }))
      .status,
    202,
  )
  assert.deepEqual(await code(await send('{"text":')), [400, 'invalid_json'])
  // A byte order mark is not JSON (the bytes are read as they are).
  assert.deepEqual(await code(await send('﻿{"text":"hi"}')), [400, 'invalid_json'])
  assert.deepEqual(await code(await send('["text"]')), [400, 'invalid_body'])
  assert.deepEqual(await code(await send()), [400, 'invalid_body'], 'a message needs a body')
  assert.deepEqual(await code(await send('{"text":"   "}')), [400, 'invalid_message'])
  assert.deepEqual(await code(await send(JSON.stringify({ text: 'z'.repeat(101) }))), [
    413,
    'message_too_long',
  ])
  assert.deepEqual(await code(await send('{"text":"hi","id":"a b"}')), [400, 'invalid_id'])
  assert.deepEqual(await code(await send('{"text":"hi","id":7}')), [400, 'invalid_id'])
  // An empty body without a type is no body: `create` and `stop` take none.
  assert.equal((await post('/sessions', undefined, auth)).status, 201)
  assert.equal((await post('/sessions/s1/stop', '', auth)).status, 202)
})

test('create, message, answer, stop reach the backend', async () => {
  calls.length = 0
  const created = await post('/sessions')
  assert.equal(created.status, 201)
  const { sessionId } = (await created.json()) as { sessionId: string }
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(created.headers.get('location'), `/sessions/${sessionId}`)
  assert.deepEqual(calls.at(-1), { name: 'create', args: [sessionId, undefined] })

  const withFirst = await post('/sessions', JSON.stringify({ message: 'hello', id: 'm-1' }))
  assert.equal(withFirst.status, 201)
  assert.equal(((await withFirst.json()) as { messageId: string }).messageId, 'm-1')
  assert.deepEqual(calls.at(-1)?.args[1], { id: 'm-1', text: 'hello', at: 42 })

  const sent = await post('/sessions/s1/messages', JSON.stringify({ text: 'hi' }))
  assert.equal(sent.status, 202)
  const { messageId } = (await sent.json()) as { messageId: string }
  assert.match(messageId, /^[0-9a-f-]{36}$/)
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

  const stop = await post('/sessions/s1/stop')
  assert.equal(stop.status, 202)
  assert.deepEqual(await stop.json(), { stopping: true })
  assert.deepEqual(calls.at(-1), { name: 'stop', args: ['s1', { at: 42 }] })
  const end = await post('/sessions/s1/stop', '{"end":true}')
  assert.deepEqual(await end.json(), { stopping: true, ending: true })
  assert.deepEqual(calls.at(-1), { name: 'stop', args: ['s1', { end: true, at: 42 }] })
  assert.deepEqual(await code(await post('/sessions/s1/stop', '{"end":"yes"}')), [
    400,
    'invalid_body',
  ])
})

test('backend errors map to 404 / 409 / 503, anything else to a bare 500 (and the log)', async () => {
  const send = () => post('/sessions/s1/messages', '{"text":"hi"}')
  failWith = new SessionNotFoundError('s1')
  assert.deepEqual(await code(await send()), [404, 'not_found'])
  failWith = new SessionEndedError('s1')
  assert.deepEqual(await code(await send()), [409, 'session_ended'])
  failWith = new BackendUnavailableError('temporal: down')
  const down = await send()
  assert.equal(down.status, 503)
  assert.equal(down.headers.get('retry-after'), '2')
  assert.equal(
    ((await down.json()) as { error: { message: string } }).error.message,
    'temporal: down',
  )
  logged.length = 0
  failWith = new Error('secret internals')
  const boom = await send()
  assert.equal(boom.status, 500)
  const text = await boom.text()
  assert.doesNotMatch(text, /secret internals/)
  assert.deepEqual(JSON.parse(text), { error: { code: 'internal', message: 'internal error' } })
  assert.deepEqual(logged, [
    {
      level: 'error',
      message: 'request failed',
      fields: { path: '/sessions/s1/messages', error: 'secret internals' },
    },
  ])
  failWith = undefined
  assert.equal((await get('/sessions/unknown')).status, 404)
})

// --- answers -----------------------------------------------------------------------------------

test('answers: checked against the pending item and its kind before the session is signalled', async () => {
  calls.length = 0
  const answer = (id: string, body: unknown, session = 's1') =>
    post(`/sessions/${session}/answers/${id}`, JSON.stringify(body))
  assert.deepEqual(await code(await answer('nope', { approved: true })), [404, 'not_found'])
  assert.deepEqual(await code(await answer('q1', { approved: true }, 'other')), [404, 'not_found'])
  assert.deepEqual(await code(await answer('gone', { approved: true })), [404, 'not_found'])
  assert.deepEqual(await code(await answer('done', { approved: true })), [409, 'already_answered'])
  assert.deepEqual(await code(await answer('sub1', { output: 'mine' })), [
    409,
    'answered_by_subagent',
  ])
  assert.deepEqual(await code(await answer('pipe1', { output: 'mine' })), [
    409,
    'answered_by_pipeline',
  ])
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
  assert.deepEqual(await code(await post('/sessions/s1/answers/q1')), [400, 'invalid_body'])
  assert.equal(calls.length, 0, 'nothing refused reached the session')
  assert.equal((await answer('t1', { output: { url: 'https://x' } })).status, 202)
  assert.equal((await answer('t1', { error: 'render failed' })).status, 202)
  assert.deepEqual(
    calls.map((c) => (c.args[1] as { value: unknown }).value),
    [{ output: { url: 'https://x' } }, { error: 'render failed' }],
  )
  // The store down: 503, named after the store, not a 500.
  parkedFails = true
  const down = await answer('q1', { approved: true })
  assert.equal(down.status, 503)
  assert.deepEqual((await down.json()) as unknown, {
    error: { code: 'unavailable', message: 'postgres: connection refused' },
  })
  parkedFails = false
})

test("a child's item: the answer goes to the child that waits for it, once it is shown to be the session's", async () => {
  calls.length = 0
  const answer = (id: string, body: unknown, session = 's1') =>
    post(`/sessions/${session}/answers/${id}`, JSON.stringify(body))
  for (const id of [
    'cforged',
    'ckind',
    'corphan',
    'cnode',
    'leak',
    'leakown',
    'cparent',
    'cgone',
  ]) {
    assert.deepEqual(await code(await answer(id, { approved: true })), [404, 'not_found'], id)
  }
  assert.deepEqual(await code(await answer('c1', { approved: true }, 'other')), [404, 'not_found'])
  assert.deepEqual(await code(await answer('cdone', { approved: true })), [409, 'already_answered'])
  assert.deepEqual(await code(await answer('c1', { output: 'x' })), [400, 'invalid_answer'])
  assert.deepEqual(await code(await answer('n1', { approved: true })), [400, 'invalid_answer'])
  assert.equal(calls.length, 0, 'nothing refused reached a workflow')

  const sub = await answer('c1', { approved: true })
  assert.equal(sub.status, 202)
  assert.deepEqual(await sub.json(), {
    requestId: 'c1',
    kind: 'approval',
    child: { itemId: 'sub1', workflowId: SUB_CHILD },
  })
  const node = await answer('n1', { output: { done: true } })
  assert.equal(node.status, 202)
  assert.deepEqual(((await node.json()) as { child: unknown }).child, {
    itemId: 'pipe1',
    workflowId: NODE_CHILD,
    nodeId: 'draft',
    visit: 1,
  })
  assert.deepEqual(calls, [
    {
      name: 'answerChild',
      args: ['s1', SUB_CHILD, { requestId: 'c1', value: { approved: true }, at: 42 }],
    },
    {
      name: 'answerChild',
      args: ['s1', NODE_CHILD, { requestId: 'n1', value: { output: { done: true } }, at: 42 }],
    },
  ])
  childEnded = true
  assert.deepEqual(await code(await answer('c1', { approved: true })), [404, 'not_found'])
  childEnded = false
})

test('childOwnerOf: the workflow id is recomputed from the session, the call, its run (and the visit)', () => {
  const parent = parkedRows.get('sub1')!
  const pipeline = parkedRows.get('pipe1')!
  const c1 = parkedRows.get('c1')!
  const n1 = parkedRows.get('n1')!
  assert.equal(childOwnerOf('s1', c1, parent), SUB_CHILD)
  assert.equal(childOwnerOf('s1', n1, pipeline), NODE_CHILD)
  // The session of the REQUEST, not a row's: s1's rows asked for s2, and s2's rows (with an
  // owner s2 named) asked for s1.
  assert.equal(childOwnerOf('s2', c1, parent), undefined)
  const s2child = {
    ...c1,
    sessionId: 's2',
    owner: { ...c1.owner!, workflowId: 'subagent-s2-r1-sub1' },
  }
  assert.equal(childOwnerOf('s2', s2child, { ...parent, sessionId: 's2' }), 'subagent-s2-r1-sub1')
  assert.equal(childOwnerOf('s1', s2child, { ...parent, sessionId: 's2' }), undefined)
  // The row's owner must be the one the session would have named.
  assert.equal(
    childOwnerOf('s1', { ...c1, owner: { ...c1.owner!, workflowId: 'x' } }, parent),
    undefined,
  )
  assert.equal(childOwnerOf('s1', c1, { ...parent, runId: 'r2' }), undefined, 'another run')
  assert.equal(childOwnerOf('s1', c1, { ...parent, itemId: 'sub2' }), undefined, 'another call')
  assert.equal(childOwnerOf('s1', c1, { ...parent, turn: 2 }), undefined, 'another turn')
  assert.equal(childOwnerOf('s1', c1, undefined), undefined, 'no call')
  assert.equal(childOwnerOf('s1', c1, pipeline), undefined, 'a pipeline call, a subagent owner')
  assert.equal(childOwnerOf('s1', n1, parent), undefined, 'a subagent call, a node owner')
  assert.equal(
    childOwnerOf('s1', { ...n1, owner: { ...n1.owner!, visit: 2 } }, pipeline),
    undefined,
  )
  assert.equal(
    childOwnerOf(
      's1',
      { ...n1, owner: { workflowId: NODE_CHILD, itemId: 'pipe1', nodeId: 'draft' } },
      pipeline,
    ),
    undefined,
    'a node without its visit',
  )
  assert.equal(childOwnerOf('s1', parkedRows.get('q1')!, parent), undefined, 'not a child item')
})

// --- the listings ------------------------------------------------------------------------------

test('subagents and pipelines: listed from the session, each with its own stream', async () => {
  const subagents = await get('/sessions/s1/subagents')
  assert.equal(subagents.status, 200)
  assert.deepEqual(await subagents.json(), { subagents: [subagentView(parkedRows.get('sub1')!)] })
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
  const pipelines = await get('/sessions/s1/pipelines')
  assert.deepEqual(await pipelines.json(), { pipelines: [pipelineView(parkedRows.get('pipe1')!)] })
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
  assert.equal((await get('/sessions/nope/subagents')).status, 404)
  assert.equal((await get('/sessions/nope/pipelines')).status, 404)
  assert.equal((await get('/sessions/s1/pipelines', { authorization: 'Bearer x' })).status, 401)
})

// --- the event stream --------------------------------------------------------------------------

test('sseFrame: the cursor is the id; the event is under data on one line', () => {
  assert.equal(
    sseFrame({ cursor: { turn: 2, attempt: 1, seq: 7 }, json: '{"type":"final"}' }),
    'id: 2:1:7\ndata: {"cursor":"2:1:7","turn":2,"event":{"type":"final"}}\n\n',
  )
})

test('events: the headers, the retry line, replay after the cursor (paged), Last-Event-ID wins', async () => {
  rows.set('s1', [
    row(1, 0, 0, 'turn.started'),
    row(1, 1, 1),
    row(1, 1, 2),
    row(1, 1, 3),
    row(1, 2, 1),
  ])
  afterCalls = 0
  const res = await get('/sessions/s1/events', { ...auth, origin: 'https://app.example' })
  assert.equal(res.status, 200)
  assert.deepEqual(Object.fromEntries(res.headers), {
    'access-control-allow-origin': 'https://app.example',
    vary: 'Origin',
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
  })
  const all = await frames(res, (seen) => ids(seen).length >= 5)
  assert.equal(all.frames[0]?.text, 'retry: 2000')
  assert.deepEqual(ids(all.frames), ['1:0:0', '1:1:1', '1:1:2', '1:1:3', '1:2:1'])
  assert.deepEqual(all.frames[1]?.data, {
    cursor: '1:0:0',
    turn: 1,
    event: { type: 'turn.started', seq: 0 },
  })
  assert.ok(afterCalls >= 3, 'read in pages of SSE batch')

  const fromQuery = await frames(
    await get('/sessions/s1/events?after=1:1:2'),
    (s) => ids(s).length >= 2,
  )
  assert.deepEqual(ids(fromQuery.frames), ['1:1:3', '1:2:1'])
  const fromHeader = await frames(
    await get('/sessions/s1/events?after=0:0:0', { ...auth, 'last-event-id': '1:1:3' }),
    (s) => ids(s).length >= 1,
  )
  assert.deepEqual(ids(fromHeader.frames), ['1:2:1'])
  // A blank Last-Event-ID is no cursor: the URL's counts.
  const blank = await frames(
    await get('/sessions/s1/events?after=1:1:3', { ...auth, 'last-event-id': ' ' }),
    (s) => ids(s).length >= 1,
  )
  assert.deepEqual(ids(blank.frames), ['1:2:1'])
  await until(() => open() === 0, 'every stream closed its subscription')
})

test('events: bad cursor 400, unknown stream 404, no token 401, the cap 503 - nothing subscribed', async () => {
  assert.deepEqual(await code(await get('/sessions/s1/events?after=1:2')), [400, 'invalid_cursor'])
  assert.deepEqual(
    await code(await get('/sessions/s1/events', { ...auth, 'last-event-id': 'x' })),
    [400, 'invalid_cursor'],
  )
  assert.deepEqual(await code(await get('/sessions/nope/events')), [404, 'not_found'])
  assert.equal((await get('/sessions/s1/events', {})).status, 401)
  // A child stream: only an item of that kind has one.
  for (const path of [
    '/sessions/s1/subagents/q1/events',
    '/sessions/s1/subagents/pipe1/events',
    '/sessions/s1/pipelines/sub1/events',
    '/sessions/s1/pipelines/sub1/nodes/review/1/events',
    '/sessions/other/pipelines/pipe1/events',
  ]) {
    assert.equal((await get(path)).status, 404, path)
  }
  assert.equal(open(), 0)
  const held = await Promise.all([1, 2, 3].map(() => get('/sessions/ended/events')))
  assert.equal(open(), 3)
  const refused = await get('/sessions/ended/events')
  assert.deepEqual(await code(refused), [503, 'too_many_streams'])
  assert.equal(refused.headers.get('retry-after'), '5')
  await Promise.all(held.map((r) => r.body!.cancel()))
  await until(() => open() === 0, 'the held streams closed')
})

test("events: a child's own streams, keyed by their stream id", async () => {
  append('s1/sub1', row(1, 1, 1, 'plan.created'))
  append('s1/sub1', row(1, 2147483647, 0, 'turn.ended'))
  const child = await frames(await get('/sessions/s1/subagents/sub1/events'), (s) =>
    s.some((f) => f.data?.event.type === 'turn.ended'),
  )
  assert.deepEqual(ids(child.frames), ['1:1:1', '1:2147483647:0'])
  append('s1/pipe1', row(1, 1, 1, 'pipeline.started'))
  const own = await frames(
    await get('/sessions/s1/pipelines/pipe1/events'),
    (s) => ids(s).length >= 1,
  )
  assert.deepEqual(ids(own.frames), ['1:1:1'])
  append('s1/pipe1/review/2', row(1, 1, 1, 'plan.created'))
  const visit = await frames(
    await get('/sessions/s1/pipelines/pipe1/nodes/review/2/events'),
    (s) => ids(s).length >= 1,
  )
  assert.deepEqual(ids(visit.frames), ['1:1:1'])
  await until(() => open() === 0, 'closed')
})

test('events: live after the replay, a keep-alive on an idle stream', async () => {
  rows.set('live', [row(1, 1, 1)])
  known.add('live')
  const res = await get('/sessions/live/events')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const readUntil = async (marker: string): Promise<void> => {
    while (!text.includes(marker)) {
      const { value, done } = await reader.read()
      assert.ok(!done, `the stream is open (waiting for ${JSON.stringify(marker)})`)
      text += decoder.decode(value, { stream: true })
    }
  }
  await readUntil('id: 1:1:1')
  // Caught up and waiting: a new row and its notification reach it.
  append('live', row(1, 1, 2))
  append('live', row(1, 2147483647, 0, 'turn.ended'))
  await readUntil('id: 1:2147483647:0')
  assert.ok(text.indexOf('id: 1:1:2') < text.indexOf('id: 1:2147483647:0'))
  // Nothing new for keepAliveMs: a comment line.
  await readUntil(': keep-alive\n\n')
  await reader.cancel()
  await until(() => open() === 0, 'closed on cancel')
})

test('events: a notification while the stream replays is not lost (subscribed before the read)', async () => {
  known.add('race')
  rows.set('race', [row(1, 1, 1)])
  // The first read of the log lets a new row land (and notify) before it answers.
  const after = feed.after
  let first = true
  feed.after = async (stream, cursor, limit) => {
    const got = await after(stream, cursor, limit)
    if (stream === 'race' && first) {
      first = false
      append('race', row(1, 1, 2))
    }
    return got
  }
  // No keep-alive for a minute: only the subscription can bring the second row in time.
  const quiet = handlerOf({ sse: { maxConnections: 3, keepAliveMs: 60_000, batch: 2 } })
  try {
    const res = await quiet.fetch(
      new Request('http://gateway/sessions/race/events', { headers: auth }),
    )
    const seen = await frames(res, (s) => ids(s).length >= 2, { timeoutMs: 1000 })
    assert.deepEqual(ids(seen.frames), ['1:1:1', '1:1:2'])
  } finally {
    feed.after = after
  }
  await until(() => open() === 0, 'closed')
})

test('events: backpressure - the stream reads no further than its reader takes', async () => {
  known.add('big')
  rows.set(
    'big',
    Array.from({ length: 40 }, (_, i) => row(1, 1, i + 1)),
  )
  const slow = handlerOf({ sse: { maxConnections: 3, keepAliveMs: 1000, batch: 1 } })
  afterCalls = 0
  const res = await slow.fetch(new Request('http://gateway/sessions/big/events', { headers: auth }))
  const reader = res.body!.getReader()
  await reader.read()
  await new Promise((r) => setTimeout(r, 100))
  assert.ok(afterCalls <= 2, `a reader that takes nothing stops the replay (${afterCalls} reads)`)
  // Taking frames lets it go on, one read of the log per frame (batch 1).
  for (let i = 0; i < 10; i++) await reader.read()
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(afterCalls >= 9 && afterCalls <= 14, `it went on with the reader (${afterCalls})`)
  await reader.cancel()
  await until(() => open() === 0, 'closed')
})

test("events: the client going away - the body's cancel, the request's signal - closes the subscription", async () => {
  rows.set('ended', [])
  const before = afterCalls
  const cancelled = await get('/sessions/ended/events')
  assert.equal(open(), 1)
  await cancelled.body!.cancel()
  await until(() => open() === 0, 'cancel closed it')
  const ac = new AbortController()
  const aborted = await gateway.fetch(
    new Request('http://gateway/sessions/ended/events', { headers: auth, signal: ac.signal }),
  )
  const reader = aborted.body!.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'retry: 2000\n\n')
  assert.equal(open(), 1)
  ac.abort()
  await until(() => open() === 0, 'the signal closed it')
  // The body ends (what was written before is still there to read).
  let done = false
  for (let i = 0; i < 5 && !done; i++) done = (await reader.read()).done
  assert.ok(done, 'the body ended')
  // Already gone when the stream is made: it ends at once, nothing left subscribed.
  const gone = new AbortController()
  gone.abort()
  const late = await gateway.fetch(
    new Request('http://gateway/sessions/ended/events', { headers: auth, signal: gone.signal }),
  )
  assert.equal(late.status, 200)
  assert.equal(await late.text(), '')
  assert.equal(open(), 0)
  assert.ok(afterCalls - before <= 3)
})

test('events: an error of the log ends the stream, logged with its cursor', async () => {
  known.add('flaky')
  rows.set('flaky', [row(1, 1, 1)])
  logged.length = 0
  const res = await get('/sessions/flaky/events')
  const first = await frames(res, (s) => ids(s).length >= 1, { cancel: false })
  afterFails = new Error('connection terminated')
  append('flaky', row(1, 1, 2))
  let text = ''
  for (;;) {
    const { value, done } = await first.reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  afterFails = undefined
  assert.equal(text, '', 'nothing more, then the end')
  assert.deepEqual(ids(first.frames), ['1:1:1'])
  assert.deepEqual(logged, [
    {
      level: 'warn',
      message: 'event stream ended on an error',
      fields: { sessionId: 'flaky', cursor: '1:1:1', error: 'connection terminated' },
    },
  ])
  assert.equal(open(), 0)
})

test('closeStreams: every open stream ends (the clients reconnect elsewhere)', async () => {
  const held = await Promise.all([1, 2, 3].map(() => get('/sessions/ended/events')))
  assert.equal(open(), 3)
  gateway.closeStreams()
  for (const res of held) {
    assert.equal(await res.text(), 'retry: 2000\n\n')
  }
  assert.equal(open(), 0)
})
