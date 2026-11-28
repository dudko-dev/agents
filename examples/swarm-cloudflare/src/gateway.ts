// The Worker's fetch: swarm-shared's HTTP API (`createGatewayHandler`, the same routes, checks and
// answers as examples/swarm's gateway) over the Durable Object backend (backend.ts) - except the
// event streams, which the Worker FORWARDS to the session's object once the bearer token is
// checked: the object serves them with the same handler, its own event log as the feed (durable.ts,
// feed.ts). Why there: a reader's wait is then a waiter in the memory of the one object that writes
// the stream, taken before the replay reads and woken by the write itself - LISTEN / NOTIFY without
// a network hop, nothing polled, nothing missed between the replay and the live part. An
// unauthenticated request never reaches an object (an id names an object; any id would wake one).
import {
  corsHeaders,
  createBearerCheck,
  createGatewayHandler,
  errorMessage,
  errorResponse,
  HttpError,
  matchRoute,
  type IApiConfig,
  type IEventFeed,
  type IGatewayHandler,
  type ILogger,
  type ISessionBackend,
} from 'swarm-shared'

// The routes the session's object serves.
export const STREAM_ROUTES = new Set([
  'events',
  'subagentEvents',
  'pipelineEvents',
  'pipelineNodeEvents',
])

// The Worker answers no stream itself: its feed is never read.
const noFeed: IEventFeed = {
  after: async () => [],
  subscribe: () => ({ wait: async () => 'closed', close: () => {} }),
  ready: () => true,
  open: () => 0,
}

export interface IWorkerGateway {
  fetch: (request: Request) => Promise<Response>
}

export const createWorkerGateway = (o: {
  config: IApiConfig
  backend: ISessionBackend
  // The session's object, for a stream (its `fetch`).
  forward: (sessionId: string, request: Request) => Promise<Response>
  log: ILogger
}): IWorkerGateway => {
  const handler: IGatewayHandler = createGatewayHandler({
    config: o.config,
    backend: o.backend,
    feed: noFeed,
    log: o.log,
    storeName: 'durable object',
  })
  const authorized =
    o.config.auth.mode === 'bearer'
      ? createBearerCheck(o.config.auth.tokens)
      : async (): Promise<boolean> => true
  return {
    fetch: async (request) => {
      const url = new URL(request.url)
      const match = matchRoute(request.method, url.pathname)
      if (!match.ok || !STREAM_ROUTES.has(match.route.name) || !('sessionId' in match.route)) {
        return handler.fetch(request)
      }
      const cors = corsHeaders(
        request.headers.get('origin') ?? undefined,
        o.config.corsOrigins,
        false,
      )
      if (!(await authorized(request.headers.get('authorization') ?? undefined))) {
        return errorResponse(
          new HttpError(401, 'unauthorized', 'a valid bearer token is required', {
            ...cors,
            'www-authenticate': 'Bearer',
          }),
        )
      }
      try {
        return await o.forward(match.route.sessionId, request)
      } catch (err) {
        o.log.error('event stream not forwarded', { path: url.pathname, error: errorMessage(err) })
        return errorResponse(
          new HttpError(503, 'unavailable', 'the session cannot be reached', {
            ...cors,
            'retry-after': '2',
          }),
        )
      }
    },
  }
}
