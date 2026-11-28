// The gateway: the clients' only door. Stateless - any number of replicas behind a load balancer:
// sessions live in Temporal, events in Postgres. node:http, no framework.
//
//   POST /sessions                          start a session (optionally with its first message)
//   POST /sessions/:id/messages             { text, id? }      -> the session's inbox
//   POST /sessions/:id/answers/:requestId   any JSON object    -> an answer to a parked question
//   POST /sessions/:id/stop                 { end? }           -> stop the running turn
//   GET  /sessions/:id                      the session's state (a workflow query)
//   GET  /sessions/:id/events?after=<cursor>  SSE: replay from Postgres, then live (LISTEN/NOTIFY)
//   GET  /healthz  /readyz                  no auth
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { IGatewayConfig } from './config.ts'
import { formatCursor, parseCursor, type ICursor } from './cursor.ts'
import type { IStreamRow } from './db/events.ts'
import type { ISubscription } from './db/notify.ts'
import { corsHeaders, createBearerCheck, HttpError, readJson, sendError, sendJson } from './http.ts'
import { errorMessage, type ILogger } from './log.ts'
import type { IAnswer, ISessionView, IStopRequest, IUserMessage } from './session-types.ts'

// What the gateway needs from Temporal (and the session table). The real one is backend.ts.
export interface ISessionBackend {
  create: (sessionId: string, first?: IUserMessage) => Promise<void>
  message: (sessionId: string, message: IUserMessage) => Promise<void>
  answer: (sessionId: string, answer: IAnswer) => Promise<void>
  stop: (sessionId: string, stop: IStopRequest) => Promise<void>
  state: (sessionId: string) => Promise<ISessionView>
  // The session was started here (Postgres): the event stream of an unknown id is a 404.
  exists: (sessionId: string) => Promise<boolean>
  // Throws when Temporal or Postgres cannot be reached.
  ready: () => Promise<void>
}

// What the event stream needs from Postgres. The real one is events.ts + notify.ts.
export interface IEventFeed {
  after: (sessionId: string, after: ICursor, limit: number) => Promise<IStreamRow[]>
  subscribe: (sessionId: string) => ISubscription
  // The LISTEN connection is up.
  ready: () => boolean
  // Streams open now.
  open: () => number
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`no session ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

export class SessionEndedError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} has ended`)
    this.name = 'SessionEndedError'
  }
}

export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendUnavailableError'
  }
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

type Route =
  | { name: 'create' }
  | { name: 'message' | 'stop' | 'state' | 'events'; sessionId: string }
  | { name: 'answer'; sessionId: string; requestId: string }
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
  ]
  if (ids.some((id) => id !== undefined && !ID_PATTERN.test(id))) {
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
  const id = body.id ?? randomUUID()
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new HttpError(400, 'invalid_id', `"id" must match ${ID_PATTERN}`)
  }
  return { id, text, at: now }
}

const mapBackendError = (err: unknown): HttpError => {
  if (err instanceof HttpError) return err
  if (err instanceof SessionNotFoundError) return new HttpError(404, 'not_found', err.message)
  if (err instanceof SessionEndedError) return new HttpError(409, 'session_ended', err.message)
  if (err instanceof BackendUnavailableError) {
    return new HttpError(503, 'unavailable', err.message, { 'retry-after': '2' })
  }
  return new HttpError(500, 'internal', 'internal error')
}

export interface IGatewayDeps {
  config: Pick<IGatewayConfig, 'auth' | 'corsOrigins' | 'maxBodyBytes' | 'messageMaxChars' | 'sse'>
  backend: ISessionBackend
  feed: IEventFeed
  log: ILogger
  now?: () => number
}

export interface IGateway {
  handle: (req: IncomingMessage, res: ServerResponse) => void
  // Stops every open event stream (shutdown); the clients reconnect to another replica.
  closeStreams: () => void
}

export const createGateway = (deps: IGatewayDeps): IGateway => {
  const { config, backend, feed, log } = deps
  const now = deps.now ?? Date.now
  const authorized =
    config.auth.mode === 'bearer' ? createBearerCheck(config.auth.tokens) : () => true
  const streams = new Set<AbortController>()

  const events = async (
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    url: URL,
    cors: Record<string, string>,
  ): Promise<void> => {
    // A reconnecting EventSource sends Last-Event-ID; it wins over the URL's `after`.
    const lastId = req.headers['last-event-id']
    const parsed = parseCursor(
      typeof lastId === 'string' && lastId.trim() ? lastId : url.searchParams.get('after'),
    )
    if (!parsed.ok) {
      throw new HttpError(400, 'invalid_cursor', parsed.error)
    }
    if (feed.open() >= config.sse.maxConnections) {
      throw new HttpError(503, 'too_many_streams', 'too many open event streams', {
        'retry-after': '5',
      })
    }
    if (!(await backend.exists(sessionId))) {
      throw new HttpError(404, 'not_found', `no session ${sessionId}`)
    }
    const ac = new AbortController()
    streams.add(ac)
    const sub = feed.subscribe(sessionId)
    // The response's close: the client went away (or the stream ended). Not the request's, which
    // is about its body.
    res.on('close', () => ac.abort())
    res.writeHead(200, {
      ...cors,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
      // Proxies that buffer (nginx) would hold the stream back.
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    let cursor = parsed.cursor
    const write = async (text: string): Promise<void> => {
      if (!res.write(text)) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off('drain', done)
            ac.signal.removeEventListener('abort', done)
            resolve()
          }
          res.on('drain', done)
          ac.signal.addEventListener('abort', done, { once: true })
        })
      }
    }
    try {
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
      res.end()
    }
  }

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://gateway')
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(origin, config.corsOrigins, true))
      res.end()
      return
    }
    const cors = corsHeaders(origin, config.corsOrigins, false)
    try {
      const match = matchRoute(req.method ?? 'GET', url.pathname)
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
        sendJson(res, 200, { status: 'ok' }, cors)
        return
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
        sendJson(res, ok ? 200 : 503, { status: ok ? 'ready' : 'not ready', checks }, cors)
        return
      }
      if (!authorized(req.headers.authorization)) {
        throw new HttpError(401, 'unauthorized', 'a valid bearer token is required', {
          'www-authenticate': 'Bearer',
        })
      }
      switch (r.name) {
        case 'create': {
          const body = objectBody(await readJson(req, config.maxBodyBytes), false)
          const first =
            body.message !== undefined
              ? messageOf(body, 'message', config.messageMaxChars, now())
              : undefined
          const sessionId = randomUUID()
          await backend.create(sessionId, first)
          sendJson(
            res,
            201,
            { sessionId, ...(first ? { messageId: first.id } : {}) },
            { ...cors, location: `/sessions/${sessionId}` },
          )
          return
        }
        case 'message': {
          const body = objectBody(await readJson(req, config.maxBodyBytes), true)
          const message = messageOf(body, 'text', config.messageMaxChars, now())
          await backend.message(r.sessionId, message)
          sendJson(res, 202, { messageId: message.id }, cors)
          return
        }
        case 'answer': {
          const value = objectBody(await readJson(req, config.maxBodyBytes), true)
          await backend.answer(r.sessionId, { requestId: r.requestId, value, at: now() })
          sendJson(res, 202, { requestId: r.requestId }, cors)
          return
        }
        case 'stop': {
          const body = objectBody(await readJson(req, config.maxBodyBytes), false)
          if (body.end !== undefined && typeof body.end !== 'boolean') {
            throw new HttpError(400, 'invalid_body', '"end" must be a boolean')
          }
          await backend.stop(r.sessionId, { ...(body.end ? { end: true } : {}), at: now() })
          sendJson(res, 202, { stopping: true, ...(body.end ? { ending: true } : {}) }, cors)
          return
        }
        case 'state': {
          sendJson(res, 200, await backend.state(r.sessionId), cors)
          return
        }
        case 'events': {
          await events(req, res, r.sessionId, url, cors)
          return
        }
      }
    } catch (err) {
      const httpErr = mapBackendError(err)
      if (httpErr.status >= 500 && !(err instanceof HttpError)) {
        log.error('request failed', { path: url.pathname, error: errorMessage(err) })
      }
      if (res.headersSent) {
        res.end()
        return
      }
      sendError(
        res,
        new HttpError(httpErr.status, httpErr.code, httpErr.message, {
          ...cors,
          ...httpErr.headers,
          // A refused body may be half read: do not reuse the connection.
          ...(httpErr.status === 413 ? { connection: 'close' } : {}),
        }),
      )
    }
  }

  return {
    handle: (req, res) => {
      void route(req, res)
    },
    closeStreams: () => {
      for (const ac of streams) ac.abort()
    },
  }
}

// One SSE frame: the cursor as the `id:` (what EventSource sends back as Last-Event-ID), the event
// under `data:`. Postgres prints jsonb on one line, so one `data:` line is enough.
export const sseFrame = (row: IStreamRow): string => {
  const id = formatCursor(row.cursor)
  return `id: ${id}\ndata: {"cursor":"${id}","turn":${row.cursor.turn},"event":${row.json}}\n\n`
}

export const listen = (gateway: IGateway, host: string, port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer(gateway.handle)
    // A slow client must not hold a request open forever; the event streams are exempt (no
    // timeout on an open response, only on the request's own headers).
    server.headersTimeout = 10_000
    server.requestTimeout = 30_000
    server.on('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
