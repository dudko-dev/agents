// The gateway: the clients' only door, as a fetch-style handler - `(request: Request) =>
// Promise<Response>` over Web-standard APIs only (Request, Response, Headers, ReadableStream,
// TextEncoder, crypto), so every platform serves the SAME API: Node behind its adapter
// (examples/swarm's gateway.ts), Cloudflare Workers as it is, Cloud Run / Firebase Functions, Lambda
// behind an adapter. Stateless - any number of replicas: sessions and events live in the platform's
// services (platform.ts says what it must provide).
//
//   POST /sessions                          start a session (optionally with its first message)
//   POST /sessions/:id/messages             { text, id? }      -> the session's inbox
//   POST /sessions/:id/answers/:requestId   the answer         -> an item a parked turn waits for,
//                                           or one a child of it waits for (signalled to that child)
//   POST /sessions/:id/stop                 { end? }           -> stop the running turn
//   GET  /sessions/:id                      the session's state
//   GET  /sessions/:id/events?after=<cursor>  SSE: replay from the event log, then live
//   GET  /sessions/:id/subagents            the session's static subagent calls
//   GET  /sessions/:id/subagents/:itemId/events?after=<cursor>  SSE: one child's own stream
//   GET  /sessions/:id/pipelines            the session's pipeline calls
//   GET  /sessions/:id/pipelines/:itemId/events?after=<cursor>  SSE: a pipeline's own stream
//   GET  /sessions/:id/pipelines/:itemId/nodes/:nodeId/:visit/events?after=<cursor>
//                                           SSE: one node visit's own stream
//   GET  /healthz  /readyz                  no auth
import { answerProblem } from './answers.ts'
import { formatCursor, parseCursor, type ICursor } from './cursor.ts'
import {
  corsHeaders,
  createBearerCheck,
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
} from './http.ts'
import { errorMessage, type ILogger } from './log.ts'
import {
  BackendUnavailableError,
  ChildEndedError,
  SessionEndedError,
  SessionNotFoundError,
  type IEventFeed,
  type IParkedRow,
  type ISessionBackend,
  type IStreamRow,
} from './platform.ts'
import {
  childWorkflowIdOf,
  pipelineEventsPath,
  pipelineNodeStreamOf,
  pipelineStreamOf,
  subagentStreamOf,
} from './session-ids.ts'
import type { IAnswer, IUserMessage } from './session-types.ts'

export type GatewayAuth = { mode: 'bearer'; tokens: string[] } | { mode: 'none' }

// The API's own settings (examples/swarm reads them from GATEWAY_AUTH / GATEWAY_TOKENS,
// CORS_ORIGINS, GATEWAY_MAX_BODY_BYTES, MESSAGE_MAX_CHARS and SSE_*).
export interface IApiConfig {
  auth: GatewayAuth
  corsOrigins: string[]
  maxBodyBytes: number
  messageMaxChars: number
  // Per gateway instance: open streams (more: 503), the keep-alive comment of an idle stream, rows
  // per replay read.
  sse: { maxConnections: number; keepAliveMs: number; batch: number }
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
// A node visit's number in a route: 1 and up (the engine's maxNodeVisits is at most 100).
export const VISIT_PATTERN = /^[1-9][0-9]{0,2}$/

type Route =
  | { name: 'create' }
  | {
      name: 'message' | 'stop' | 'state' | 'events' | 'subagents' | 'pipelines'
      sessionId: string
    }
  | { name: 'answer'; sessionId: string; requestId: string }
  | { name: 'subagentEvents' | 'pipelineEvents'; sessionId: string; requestId: string }
  | {
      name: 'pipelineNodeEvents'
      sessionId: string
      requestId: string
      nodeId: string
      visit: string
    }
  | { name: 'healthz' | 'readyz' }

const ROUTES: { pattern: RegExp; method: string; route: (m: RegExpExecArray) => Route }[] = [
  { pattern: /^\/healthz$/, method: 'GET', route: () => ({ name: 'healthz' }) },
  { pattern: /^\/readyz$/, method: 'GET', route: () => ({ name: 'readyz' }) },
  { pattern: /^\/sessions$/, method: 'POST', route: () => ({ name: 'create' }) },
  {
    pattern: /^\/sessions\/([^/]+)$/,
    method: 'GET',
    route: (m) => ({ name: 'state', sessionId: m[1]! }),
  },
  {
    pattern: /^\/sessions\/([^/]+)\/messages$/,
    method: 'POST',
    route: (m) => ({ name: 'message', sessionId: m[1]! }),
  },
  {
    pattern: /^\/sessions\/([^/]+)\/answers\/([^/]+)$/,
    method: 'POST',
    route: (m) => ({ name: 'answer', sessionId: m[1]!, requestId: m[2]! }),
  },
  {
    pattern: /^\/sessions\/([^/]+)\/stop$/,
    method: 'POST',
    route: (m) => ({ name: 'stop', sessionId: m[1]! }),
  },
  {
    pattern: /^\/sessions\/([^/]+)\/events$/,
    method: 'GET',
    route: (m) => ({ name: 'events', sessionId: m[1]! }),
  },
  {
    pattern: /^\/sessions\/([^/]+)\/subagents$/,
    method: 'GET',
    route: (m) => ({ name: 'subagents', sessionId: m[1]! }),
  },
  {
    pattern: /^\/sessions\/([^/]+)\/subagents\/([^/]+)\/events$/,
    method: 'GET',
    route: (m) => ({ name: 'subagentEvents', sessionId: m[1]!, requestId: m[2]! }),
  },
  {
    pattern: /^\/sessions\/([^/]+)\/pipelines$/,
    method: 'GET',
    route: (m) => ({ name: 'pipelines', sessionId: m[1]! }),
  },
  {
    pattern: /^\/sessions\/([^/]+)\/pipelines\/([^/]+)\/events$/,
    method: 'GET',
    route: (m) => ({ name: 'pipelineEvents', sessionId: m[1]!, requestId: m[2]! }),
  },
  {
    pattern: /^\/sessions\/([^/]+)\/pipelines\/([^/]+)\/nodes\/([^/]+)\/([^/]+)\/events$/,
    method: 'GET',
    route: (m) => ({
      name: 'pipelineNodeEvents',
      sessionId: m[1]!,
      requestId: m[2]!,
      nodeId: m[3]!,
      visit: m[4]!,
    }),
  },
]

export type RouteMatch =
  { ok: true; route: Route } | { ok: false; status: 404 | 405; allow?: string }

export const matchRoute = (method: string, path: string): RouteMatch => {
  const hits = ROUTES.map((r) => ({ r, m: r.pattern.exec(path) })).filter((h) => h.m)
  if (hits.length === 0) {
    return { ok: false, status: 404 }
  }
  const hit = hits.find((h) => h.r.method === method)
  if (!hit) {
    return { ok: false, status: 405, allow: [...new Set(hits.map((h) => h.r.method))].join(', ') }
  }
  const route = hit.r.route(hit.m!)
  const ids = [
    'sessionId' in route ? route.sessionId : undefined,
    'requestId' in route ? route.requestId : undefined,
    'nodeId' in route ? route.nodeId : undefined,
  ]
  if (ids.some((id) => id !== undefined && !ID_PATTERN.test(id))) {
    return { ok: false, status: 404 }
  }
  if ('visit' in route && !VISIT_PATTERN.test(route.visit)) {
    return { ok: false, status: 404 }
  }
  return { ok: true, route }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

const objectBody = (body: unknown, required: boolean): Record<string, unknown> => {
  if (body === undefined && !required) {
    return {}
  }
  if (!isObject(body)) {
    throw new HttpError(400, 'invalid_body', 'the body must be a JSON object')
  }
  return body
}

export const messageOf = (
  body: Record<string, unknown>,
  field: string,
  maxChars: number,
  now: number,
): IUserMessage => {
  const text = body[field]
  if (typeof text !== 'string' || !text.trim()) {
    throw new HttpError(400, 'invalid_message', `"${field}" must be a non-empty string`)
  }
  if (text.length > maxChars) {
    throw new HttpError(413, 'message_too_long', `a message is limited to ${maxChars} characters`)
  }
  const id = body.id ?? crypto.randomUUID()
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new HttpError(400, 'invalid_id', `"id" must match ${ID_PATTERN}`)
  }
  return { id, text, at: now }
}

const mapBackendError = (err: unknown): HttpError => {
  if (err instanceof HttpError) return err
  if (err instanceof SessionNotFoundError) return new HttpError(404, 'not_found', err.message)
  if (err instanceof SessionEndedError) return new HttpError(409, 'session_ended', err.message)
  if (err instanceof ChildEndedError) {
    return new HttpError(404, 'not_found', 'nothing waits for that item any more')
  }
  if (err instanceof BackendUnavailableError) {
    return new HttpError(503, 'unavailable', err.message, { 'retry-after': '2' })
  }
  return new HttpError(500, 'internal', 'internal error')
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  connection: 'keep-alive',
  'x-content-type-options': 'nosniff',
  // Proxies that buffer (nginx) would hold the stream back.
  'x-accel-buffering': 'no',
}

const encoder = new TextEncoder()

export interface IGatewayDeps {
  config: IApiConfig
  backend: ISessionBackend
  feed: IEventFeed
  log: ILogger
  now?: () => number
  // The name a 503 gives the platform's store when a read the gateway makes itself fails (a parked
  // item, a session's calls): `<storeName>: <the error>`. examples/swarm: 'postgres'.
  storeName?: string
}

export interface IGatewayHandler {
  // One request, one answer: JSON, or an event stream (a Response whose body is the SSE stream).
  // Never rejects: every failure is an answer (a 500 says only "internal error"; the log has it).
  fetch: (request: Request) => Promise<Response>
  // Ends every open event stream (shutdown); the clients reconnect to another replica.
  closeStreams: () => void
}

export const createGatewayHandler = (deps: IGatewayDeps): IGatewayHandler => {
  const { config, backend, feed, log } = deps
  const now = deps.now ?? Date.now
  const storeName = deps.storeName ?? 'store'
  const authorized =
    config.auth.mode === 'bearer'
      ? createBearerCheck(config.auth.tokens)
      : async (): Promise<boolean> => true
  const streams = new Set<AbortController>()
  // The store reads of the gateway: a failure is an outage for the client (503).
  const unavailableOn = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new BackendUnavailableError(`${storeName}: ${errorMessage(err)}`)
    }
  }
  const parkedItem = (sessionId: string, itemId: string) =>
    unavailableOn(() => backend.parkedItem(sessionId, itemId))
  const sessionExists = (sessionId: string) => unavailableOn(() => backend.exists(sessionId))

  // The body of one open stream: replay from the cursor, then live through the subscription
  // (taken BEFORE the first read, so nothing stored meanwhile is missed), a keep-alive comment on
  // an idle one. Backpressure: a frame waits until the reader has taken the one before it - as a
  // node:http write waits for 'drain'. The client going away is the body's `cancel` (what a
  // platform does with a response nobody reads any more) or the request's `signal`;
  // closeStreams() ends it too.
  const eventStream = (
    request: Request,
    sessionId: string,
    from: ICursor,
  ): ReadableStream<Uint8Array> => {
    const sub = feed.subscribe(sessionId)
    const ac = new AbortController()
    streams.add(ac)
    const gone = (): void => ac.abort()
    if (request.signal.aborted) {
      ac.abort()
    } else {
      request.signal.addEventListener('abort', gone, { once: true })
    }
    // The writer waiting for the reader: woken by a pull, or by the end of the stream.
    let wake: (() => void) | undefined
    const pulled = (): void => {
      const w = wake
      wake = undefined
      w?.()
    }
    ac.signal.addEventListener('abort', pulled, { once: true })

    const pump = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
      let cursor = from
      const write = async (text: string): Promise<void> => {
        if (ac.signal.aborted) {
          return
        }
        controller.enqueue(encoder.encode(text))
        while ((controller.desiredSize ?? 0) <= 0 && !ac.signal.aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      }
      try {
        await write('retry: 2000\n\n')
        while (!ac.signal.aborted) {
          const rows = await feed.after(sessionId, cursor, config.sse.batch)
          for (const row of rows) {
            if (ac.signal.aborted) break
            await write(sseFrame(row))
            cursor = row.cursor
          }
          if (rows.length === config.sse.batch) {
            continue
          }
          const woke = await sub.wait(config.sse.keepAliveMs, ac.signal)
          if (woke === 'closed') break
          if (woke === 'timeout') await write(': keep-alive\n\n')
        }
      } catch (err) {
        log.warn('event stream ended on an error', {
          sessionId,
          cursor: formatCursor(cursor),
          error: errorMessage(err),
        })
      } finally {
        sub.close()
        streams.delete(ac)
        request.signal.removeEventListener('abort', gone)
        try {
          controller.close()
        } catch {
          // Cancelled by the reader: there is nothing left to close.
        }
      }
    }

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        void pump(controller)
      },
      pull: () => pulled(),
      cancel: () => ac.abort(),
    })
  }

  // One stream: a session's, or a child's own (its stream id in place of a session's).
  const events = async (
    request: Request,
    sessionId: string,
    url: URL,
    cors: Record<string, string>,
    exists: () => Promise<boolean> = () => backend.exists(sessionId),
  ): Promise<Response> => {
    // A reconnecting EventSource sends Last-Event-ID; it wins over the URL's `after`.
    const lastId = request.headers.get('last-event-id')
    const parsed = parseCursor(
      lastId !== null && lastId.trim() ? lastId : url.searchParams.get('after'),
    )
    if (!parsed.ok) {
      throw new HttpError(400, 'invalid_cursor', parsed.error)
    }
    if (feed.open() >= config.sse.maxConnections) {
      throw new HttpError(503, 'too_many_streams', 'too many open event streams', {
        'retry-after': '5',
      })
    }
    if (!(await exists())) {
      throw new HttpError(404, 'not_found', `no such stream: ${sessionId}`)
    }
    return new Response(eventStream(request, sessionId, parsed.cursor), {
      status: 200,
      headers: { ...cors, ...SSE_HEADERS },
    })
  }

  const route = async (
    request: Request,
    url: URL,
    cors: Record<string, string>,
  ): Promise<Response> => {
    const match = matchRoute(request.method, url.pathname)
    if (!match.ok) {
      throw new HttpError(
        match.status,
        match.status === 404 ? 'not_found' : 'method_not_allowed',
        match.status === 404 ? 'no such route' : 'method not allowed',
        match.allow ? { allow: match.allow } : {},
      )
    }
    const r = match.route
    if (r.name === 'healthz') {
      return jsonResponse(200, { status: 'ok' }, cors)
    }
    if (r.name === 'readyz') {
      const checks: Record<string, string> = { events: feed.ready() ? 'ok' : 'down' }
      try {
        await backend.ready()
        checks.backend = 'ok'
      } catch (err) {
        checks.backend = errorMessage(err)
      }
      const ok = Object.values(checks).every((v) => v === 'ok')
      return jsonResponse(ok ? 200 : 503, { status: ok ? 'ready' : 'not ready', checks }, cors)
    }
    if (!(await authorized(request.headers.get('authorization') ?? undefined))) {
      throw new HttpError(401, 'unauthorized', 'a valid bearer token is required', {
        'www-authenticate': 'Bearer',
      })
    }
    switch (r.name) {
      case 'create': {
        const body = objectBody(await readJson(request, config.maxBodyBytes), false)
        const first =
          body.message !== undefined
            ? messageOf(body, 'message', config.messageMaxChars, now())
            : undefined
        const sessionId = crypto.randomUUID()
        await backend.create(sessionId, first)
        return jsonResponse(
          201,
          { sessionId, ...(first ? { messageId: first.id } : {}) },
          { ...cors, location: `/sessions/${sessionId}` },
        )
      }
      case 'message': {
        const body = objectBody(await readJson(request, config.maxBodyBytes), true)
        const message = messageOf(body, 'text', config.messageMaxChars, now())
        await backend.message(r.sessionId, message)
        return jsonResponse(202, { messageId: message.id }, cors)
      }
      case 'answer': {
        const value = objectBody(await readJson(request, config.maxBodyBytes), true)
        const item = await parkedItem(r.sessionId, r.requestId)
        const missing = (): HttpError =>
          new HttpError(
            404,
            'not_found',
            `no parked turn of session ${r.sessionId} waits for ${r.requestId}`,
          )
        // The row is the session's (the lookup is by session; checked again), and still open.
        if (!item || item.sessionId !== r.sessionId || item.state === 'cancelled') {
          throw missing()
        }
        // A child's item: the answer goes to the child that waits for it - once it is shown to
        // be a child of THIS session's parked turn: the call it answers is the session's too,
        // and the child's workflow id is the one the session named it with (childOwnerOf).
        // Anything else is unknown.
        let owner: string | undefined
        if (item.owner) {
          const parent = await parkedItem(r.sessionId, item.owner.itemId)
          owner =
            parent && parent.sessionId === r.sessionId
              ? childOwnerOf(r.sessionId, item, parent)
              : undefined
          if (!owner) {
            throw missing()
          }
        }
        if (item.state === 'answered') {
          throw new HttpError(409, 'already_answered', `${r.requestId} is answered already`)
        }
        if (item.answeredBy === 'subagent') {
          throw new HttpError(
            409,
            'answered_by_subagent',
            `a subagent answers ${r.requestId}; stop the turn to give up on it`,
          )
        }
        if (item.answeredBy === 'pipeline') {
          throw new HttpError(
            409,
            'answered_by_pipeline',
            `a pipeline answers ${r.requestId}; stop the turn to give up on it`,
          )
        }
        const problem = answerProblem(item.kind, value)
        if (problem) {
          throw new HttpError(400, 'invalid_answer', problem)
        }
        const answer: IAnswer = { requestId: r.requestId, value, at: now() }
        if (owner) {
          await backend.answerChild(r.sessionId, owner, answer)
        } else {
          await backend.answer(r.sessionId, answer)
        }
        return jsonResponse(
          202,
          {
            requestId: r.requestId,
            kind: item.kind,
            ...(owner && item.owner ? { child: childOf(item.owner) } : {}),
          },
          cors,
        )
      }
      case 'stop': {
        const body = objectBody(await readJson(request, config.maxBodyBytes), false)
        if (body.end !== undefined && typeof body.end !== 'boolean') {
          throw new HttpError(400, 'invalid_body', '"end" must be a boolean')
        }
        await backend.stop(r.sessionId, { ...(body.end ? { end: true } : {}), at: now() })
        return jsonResponse(202, { stopping: true, ...(body.end ? { ending: true } : {}) }, cors)
      }
      case 'state': {
        return jsonResponse(200, await backend.state(r.sessionId), cors)
      }
      case 'events': {
        return events(request, r.sessionId, url, cors)
      }
      case 'subagents': {
        if (!(await sessionExists(r.sessionId))) {
          throw new HttpError(404, 'not_found', `no session ${r.sessionId}`)
        }
        const rows = await unavailableOn(() => backend.subagents(r.sessionId))
        return jsonResponse(200, { subagents: rows.map((row) => subagentView(row)) }, cors)
      }
      case 'subagentEvents': {
        const stream = subagentStreamOf(r.sessionId, r.requestId)
        return events(request, stream, url, cors, async () => {
          const item = await parkedItem(r.sessionId, r.requestId)
          return item?.answeredBy === 'subagent'
        })
      }
      case 'pipelines': {
        if (!(await sessionExists(r.sessionId))) {
          throw new HttpError(404, 'not_found', `no session ${r.sessionId}`)
        }
        const rows = await unavailableOn(() => backend.pipelines(r.sessionId))
        return jsonResponse(200, { pipelines: rows.map((row) => pipelineView(row)) }, cors)
      }
      case 'pipelineEvents':
      case 'pipelineNodeEvents': {
        // The pipeline's own stream, or one visit of one of its nodes: either way the item must
        // be one a pipeline answers. A visit that has not started (or never will) is an empty
        // stream that waits, as a child's stream does before its run begins.
        const stream =
          r.name === 'pipelineNodeEvents'
            ? pipelineNodeStreamOf(r.sessionId, r.requestId, r.nodeId, Number(r.visit))
            : pipelineStreamOf(r.sessionId, r.requestId)
        return events(request, stream, url, cors, async () => {
          const item = await parkedItem(r.sessionId, r.requestId)
          return item?.answeredBy === 'pipeline'
        })
      }
    }
  }

  return {
    fetch: async (request) => {
      const url = new URL(request.url)
      const origin = request.headers.get('origin') ?? undefined
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin, config.corsOrigins, true),
        })
      }
      const cors = corsHeaders(origin, config.corsOrigins, false)
      try {
        return await route(request, url, cors)
      } catch (err) {
        const httpErr = mapBackendError(err)
        if (httpErr.status >= 500 && !(err instanceof HttpError)) {
          log.error('request failed', { path: url.pathname, error: errorMessage(err) })
        }
        return errorResponse(
          new HttpError(httpErr.status, httpErr.code, httpErr.message, {
            ...cors,
            ...httpErr.headers,
            // A refused body may be half read: do not reuse the connection.
            ...(httpErr.status === 413 ? { connection: 'close' } : {}),
          }),
        )
      }
    },
    closeStreams: () => {
      for (const ac of streams) ac.abort()
    },
  }
}

// The child workflow an item of a child's own park goes to - or undefined when it cannot be shown
// to be a child of the request's session. The workflow id is never taken from the item's row
// alone: it is recomputed from the session of the REQUEST (`sessionId`, not a row's), the parked
// turn's item the child answers (`parent`: its run and its id) and, for a pipeline node visit, the
// node and the visit - the same function the session named the child with - and must equal the
// owner the row names. The parent must be a call of the child's kind, in the same turn. (The
// route checks first that both rows are the session's.)
export const childOwnerOf = (
  sessionId: string,
  item: IParkedRow,
  parent: IParkedRow | undefined,
): string | undefined => {
  const owner = item.owner
  if (!owner || !parent) {
    return undefined
  }
  if (parent.itemId !== owner.itemId || parent.turn !== item.turn) {
    return undefined
  }
  const node =
    owner.nodeId !== undefined && owner.visit !== undefined
      ? { nodeId: owner.nodeId, visit: owner.visit }
      : undefined
  if (owner.nodeId !== undefined || owner.visit !== undefined) {
    if (!node || parent.answeredBy !== 'pipeline') return undefined
  } else if (parent.answeredBy !== 'subagent') {
    return undefined
  }
  const expected = childWorkflowIdOf(sessionId, parent.runId, parent.itemId, node)
  return expected === owner.workflowId ? expected : undefined
}

// Which child an answer went to (the 202's `child`).
const childOf = (owner: NonNullable<IParkedRow['owner']>): Record<string, unknown> => ({
  itemId: owner.itemId,
  workflowId: owner.workflowId,
  ...(owner.nodeId !== undefined ? { nodeId: owner.nodeId, visit: owner.visit } : {}),
})

// A static subagent call as GET /sessions/:id/subagents lists it.
export const subagentView = (row: IParkedRow): Record<string, unknown> => {
  const item = (row.item ?? {}) as { subagent?: Record<string, unknown> }
  return {
    itemId: row.itemId,
    turn: row.turn,
    runId: row.runId,
    state: row.state,
    ...(row.childId ? { workflowId: row.childId } : {}),
    ...(item.subagent ?? {}),
    events: `/sessions/${row.sessionId}/subagents/${row.itemId}/events`,
  }
}

// A pipeline call as GET /sessions/:id/pipelines lists it. Its node visits are named by the
// `pipeline.node.started` events of its own stream (each with the visit's `events`).
export const pipelineView = (row: IParkedRow): Record<string, unknown> => {
  const item = (row.item ?? {}) as { pipeline?: Record<string, unknown> }
  return {
    itemId: row.itemId,
    turn: row.turn,
    runId: row.runId,
    state: row.state,
    ...(row.childId ? { workflowId: row.childId } : {}),
    ...(item.pipeline ?? {}),
    events: pipelineEventsPath(row.sessionId, row.itemId),
  }
}

// One SSE frame: the cursor as the `id:` (what EventSource sends back as Last-Event-ID), the event
// under `data:`. The event log stores the JSON on one line (Postgres prints jsonb so), so one
// `data:` line is enough.
export const sseFrame = (row: IStreamRow): string => {
  const id = formatCursor(row.cursor)
  return `id: ${id}\ndata: {"cursor":"${id}","turn":${row.cursor.turn},"event":${row.json}}\n\n`
}
