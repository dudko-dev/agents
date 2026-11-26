import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * What the three test servers share: binding (loopback only), CORS, and the
 * small pieces of plain `node:http` plumbing.
 */

/** Where a test server listens, and what a browser may do with it. */
export interface IListenOptions {
  /** `127.0.0.1` (the default) or `::1`. Anything else is refused: these servers are for tests. */
  host?: string
  /** A fixed port. Default 0: whatever the system hands out. */
  port?: number
  /**
   * Answer CORS for this origin (`'*'` for any): the preflight, and the headers
   * a browser MCP client needs on every answer. Left out, no CORS header is sent
   * at all - which is what a Node client sees from most servers.
   */
  cors?: string
}

const LOOPBACK_HOSTS = ['127.0.0.1', '::1']

/**
 * The guard: a test server issues tokens to anyone who asks the right way and
 * has switches that make it lie. It binds to a loopback address or not at all -
 * not `0.0.0.0`, not a LAN address, not a name (`localhost` is whatever the
 * resolver says it is).
 */
export const assertLoopbackHost = (host: string): void => {
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(
      `test servers bind to loopback only (127.0.0.1 or ::1) - refusing "${host}": they must never be reachable from another machine`,
    )
  }
}

/** Listen as asked and return the server's origin (`http://127.0.0.1:1234`). */
export const listen = async (server: Server, opts: IListenOptions = {}): Promise<string> => {
  const host = opts.host ?? '127.0.0.1'
  assertLoopbackHost(host)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

export const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })

/**
 * The request headers a browser MCP client sends. The first five are what the
 * 2025-era protocol needs (see the browser package's README, "CORS");
 * `Mcp-Method` and `Mcp-Name` are the request metadata headers the 2026-07-28
 * revision requires on every POST (Streamable HTTP, "Request Metadata").
 * `Mcp-Param-*` headers carry tool arguments under names only a tool definition
 * knows, so they cannot be listed here: the preflight allows the ones it is
 * asked about (see `applyCors`).
 */
export const CORS_ALLOW_HEADERS =
  'Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version, Last-Event-ID, Mcp-Method, Mcp-Name'

/**
 * The same list as a deployment configured before 2026-07-28 has it: a browser's
 * preflight for a modern request fails against it. What the `cors` probe fault
 * of the MCP server answers with.
 */
export const CORS_ALLOW_HEADERS_2025 =
  'Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version, Last-Event-ID'

/**
 * The CORS headers a browser MCP client needs (see the browser package's README,
 * "CORS"): the request headers above, and `WWW-Authenticate` and
 * `mcp-session-id` exposed - without the first of those two a page cannot read
 * the 401 challenge and discovery never starts.
 */
export const corsHeaders = (
  origin: string,
  allowHeaders: string = CORS_ALLOW_HEADERS,
): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': allowHeaders,
  'Access-Control-Expose-Headers': 'WWW-Authenticate, mcp-session-id',
  'Access-Control-Max-Age': '86400',
  ...(origin === '*' ? {} : { Vary: 'Origin' }),
})

/** `Mcp-Param-{name}`, where the name is an HTTP field-name token (RFC 9110, section 5.1). */
const MCP_PARAM_HEADER = /^mcp-param-[!#$%&'*+.^_`|~0-9a-z-]+$/i

/**
 * Put the CORS headers on the answer (when `cors` is set) and answer a
 * preflight. Returns true when the request was a preflight and is finished.
 * Call it first in a handler: whatever is written afterwards keeps the headers.
 *
 * A preflight that asks for `Mcp-Param-*` headers gets those names added to the
 * allowed list (they are named by tool definitions, not known in advance) -
 * unless `allowHeaders` is a list of its own, which is then answered as is.
 */
export const applyCors = (
  req: IncomingMessage,
  res: ServerResponse,
  cors: string | undefined,
  allowHeaders?: string,
): boolean => {
  if (cors === undefined) {
    return false
  }
  for (const [name, value] of Object.entries(corsHeaders(cors, allowHeaders))) {
    res.setHeader(name, value)
  }
  if (req.method !== 'OPTIONS') {
    return false
  }
  if (allowHeaders === undefined) {
    const asked = String(req.headers['access-control-request-headers'] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => MCP_PARAM_HEADER.test(name))
    if (asked.length > 0) {
      res.setHeader('Access-Control-Allow-Headers', [CORS_ALLOW_HEADERS, ...asked].join(', '))
    }
  }
  res.writeHead(204)
  res.end()
  return true
}

export const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

export const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString()
}
