// The gateway on node:http: swarm-shared's fetch handler - the routes, the checks, the event
// stream: the same API on every platform - behind a node:http <-> fetch adapter. Stateless - any
// number of replicas behind a load balancer: sessions live in Temporal, events in Postgres.
//
//   node:http request -> Request   the URL (parsed against http://gateway, as before), the headers
//                                  as node:http joined them, the body streamed - read from the
//                                  socket only if a route reads it -, a signal aborted when the
//                                  client goes away before its answer is out
//   Response -> node:http          the status and the headers, the body written chunk by chunk,
//                                  waiting for 'drain' (an event stream's backpressure); a client
//                                  gone cancels the body (an event stream ends, its subscription
//                                  closes)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  createGatewayHandler,
  errorResponse,
  HttpError,
  type IGatewayDeps,
  type IGatewayHandler,
} from 'swarm-shared'
import { errorMessage } from './log.ts'

export interface IGateway {
  handle: (req: IncomingMessage, res: ServerResponse) => void
  // Stops every open event stream (shutdown); the clients reconnect to another replica.
  closeStreams: () => void
}

// The request's body, read from node:http only when the handler reads it (a route that takes no
// body leaves it to node:http, which discards it after the answer). Its cancel - a body refused
// half way - ends the read as an early exit from `for await` over the request does: the request
// is destroyed, its socket kept for the answer (a 413 says `connection: close`).
const bodyOf = (req: IncomingMessage): ReadableStream<Uint8Array> => {
  let chunks: AsyncIterator<Buffer> | undefined
  return new ReadableStream<Uint8Array>(
    {
      pull: async (controller) => {
        chunks ??= (req as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
        const next = await chunks.next()
        if (next.done) {
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      },
      cancel: async () => {
        await chunks?.return?.()
      },
    },
    { highWaterMark: 0 },
  )
}

// Methods fetch cannot build a Request with, which node:http takes (TRACE; a CONNECT never reaches
// a request handler). No route takes one: the handler answers 404 / 405 by the method it reads.
const FETCH_FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK'])

const toRequest = (req: IncomingMessage, signal: AbortSignal): Request => {
  const url = new URL(req.url ?? '/', 'http://gateway')
  // A Request's URL has no credentials (an absolute-form target may carry some); the handler reads
  // the path and the query only.
  url.username = ''
  url.password = ''
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  const method = req.method ?? 'GET'
  const forbidden = FETCH_FORBIDDEN_METHODS.has(method)
  const bodyless = forbidden || method === 'GET' || method === 'HEAD'
  const request = new Request(url, {
    method: forbidden ? 'GET' : method,
    headers,
    signal,
    ...(bodyless ? {} : { body: bodyOf(req), duplex: 'half' }),
  } as RequestInit)
  if (forbidden) {
    Object.defineProperty(request, 'method', { value: method })
  }
  return request
}

// The answer, on node:http. The body is read chunk by chunk and written as it comes; a write the
// socket cannot take yet waits for 'drain' - so a slow client holds the event stream back (it reads
// the log no further) instead of filling the gateway's memory.
const send = async (res: ServerResponse, response: Response, gone: AbortSignal): Promise<void> => {
  if (gone.aborted) {
    // Nobody to answer: an event stream ends at once.
    await response.body?.cancel().catch(() => {})
    return
  }
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })
  res.writeHead(response.status, headers)
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  const cancel = (): void => void reader.cancel().catch(() => {})
  gone.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const go = (): void => {
            res.off('drain', go)
            gone.removeEventListener('abort', go)
            resolve()
          }
          res.on('drain', go)
          gone.addEventListener('abort', go, { once: true })
        })
      }
    }
  } finally {
    gone.removeEventListener('abort', cancel)
    res.end()
  }
}

const serve = async (
  handler: IGatewayHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  // The response's close before it finished: the client went away (not the request's, which is
  // about its body).
  const gone = new AbortController()
  res.once('close', () => {
    if (!res.writableFinished) gone.abort()
  })
  let request: Request
  try {
    request = toRequest(req, gone.signal)
  } catch {
    // What node:http took and fetch cannot represent (a target the URL parser refuses).
    await send(
      res,
      errorResponse(
        new HttpError(400, 'bad_request', 'the request cannot be read', { connection: 'close' }),
      ),
      gone.signal,
    )
    return
  }
  await send(res, await handler.fetch(request), gone.signal)
}

// `storeName`: the store the gateway reads itself (a parked item, a session's calls) is Postgres.
export const createGateway = (deps: IGatewayDeps): IGateway => {
  const handler = createGatewayHandler({ storeName: 'postgres', ...deps })
  return {
    handle: (req, res) => {
      void serve(handler, req, res).catch((err) => {
        deps.log.error('response failed', { path: req.url, error: errorMessage(err) })
        res.destroy()
      })
    },
    closeStreams: handler.closeStreams,
  }
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
