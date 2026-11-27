import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { createDemoMcpServer, DEMO_MCP_PATH, type DemoMcpServer } from './demo-server.ts'

/**
 * The demo MCP server on Node: the same `DemoMcpServer` the Worker runs, behind a `node:http`
 * request. It is how the demo's Vite dev and preview servers serve `/mcp/demo` (there is no
 * Worker there), so local development and the browser tests run the code that is deployed.
 * Never part of the Worker bundle.
 */

/** A Node request as a web-standard one; its body is streamed, and aborted with the request. */
export const toWebRequest = (req: IncomingMessage, signal?: AbortSignal): Request => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(name, one)
    else if (value !== undefined) headers.set(name, value)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(url, {
    method: req.method,
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
  } as RequestInit)
}

/** Write a web-standard response to a Node one, chunk by chunk (an SSE answer is streamed). */
export const sendWebResponse = async (res: ServerResponse, response: Response): Promise<void> => {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  res.on('close', () => void reader.cancel().catch(() => {}))
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } catch {
    // The answer was cut off (too large, or the client went away): end what was sent.
  }
  res.end()
}

type Next = (err?: unknown) => void

/**
 * A connect-style middleware (Vite's `server.middlewares`): `DEMO_MCP_PATH` is served by the
 * demo MCP server, every other path goes on to `next`.
 */
export const demoMcpMiddleware = (
  server: DemoMcpServer = createDemoMcpServer(),
): ((req: IncomingMessage, res: ServerResponse, next: Next) => void) => {
  return (req, res, next) => {
    const path = (req.url ?? '').split(/[?#]/)[0]
    if (path !== DEMO_MCP_PATH) {
      next()
      return
    }
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    server
      .fetch(toWebRequest(req, abort.signal))
      .then((response) => sendWebResponse(res, response))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
        res.end()
      })
  }
}
