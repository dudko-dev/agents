import { createMcpHandler, McpServer, type McpRequestContext } from '@modelcontextprotocol/server'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker'
import { attachDemoSkills } from './skills.ts'
import { registerDemoTools } from './tools.ts'

/**
 * The demo MCP server of agent.dudko.dev: a public endpoint any MCP client may use, written for
 * a Cloudflare Worker - web-standard `Request` in, `Response` out, nothing kept between requests.
 *
 * Both protocol eras are served statelessly by the SDK's `createMcpHandler`, from ONE factory
 * that builds a fresh `McpServer` per request:
 *
 * - 2026-07-28 has no session and no handshake; a question to the user is an `input_required`
 *   result the client answers by sending the call again (multi round-trip requests). Nothing has
 *   to survive between the two requests, so the asking tools work here.
 * - The 2025 revisions are served by the SDK's stateless fallback (`legacy: 'stateless'`: a
 *   streamable HTTP transport without a session id). Plain tools work; a question cannot (see
 *   `tools.ts`), and a GET for a standalone stream is answered 405 by the SDK.
 *
 * What is in front of the SDK is the abuse limits of a public endpoint: the request body is
 * bounded before it is parsed, JSON-RPC batches are refused (one message, so at most one tool
 * call, per request), a `subscriptions/listen` stream is refused (the lists never change, and a
 * stream would stay open), the answer is bounded, and a page of another origin is refused. No
 * input is logged: the SDK's error callbacks are silenced, and nothing here writes to the
 * console. Request rates are not limited here: that is a Cloudflare rule (see CLAUDE.md).
 */

/** Where the Worker serves this server. */
export const DEMO_MCP_PATH = '/mcp/demo'

export const DEMO_SERVER_INFO = { name: 'agent-dudko-dev-demo', version: '1.0.0' } as const

export const DEMO_LIMITS = {
  /** The largest request body read, in bytes. A tools/call with a form's answer is under 2 KiB. */
  requestBytes: 32 * 1024,
  /**
   * The largest answer sent, in bytes. tools/list is about 10 KiB, the trip board's document
   * (`resources/read`) about 25 KiB.
   */
  responseBytes: 64 * 1024,
  /** Array elements plus object members one tools/call's `arguments` may have (the SDK's check). */
  toolInputElements: 64,
} as const

export const DEMO_INSTRUCTIONS = [
  'A demo MCP server of agent.dudko.dev, for trying MCP clients. It keeps nothing: no account,',
  'no storage, no outbound requests.',
  'echo, current_time and roll_dice answer at once (roll_dice with structured content).',
  'plan_trip and open_docs ask the USER something during the call - a form, a link - and work on',
  'the 2026-07-28 protocol revision only. Let the user answer: never fill in a trip yourself.',
  'trip_board plans a trip day by day and comes with an MCP App, a board the user works with in',
  'hosts that show apps; pass it what the user said (or what plan_trip returned). reshuffle_day',
  "and book_trip are that app's own tools: a model has no use for them, and book_trip is a demo",
  'that books nothing.',
].join(' ')

const JSON_HEADERS = { 'content-type': 'application/json' }

const rpcError = (status: number, code: number, message: string, id: unknown = null): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status,
    headers: JSON_HEADERS,
  })

const ABOUT = [
  'This is the demo MCP server of https://agent.dudko.dev (MCP over streamable HTTP).',
  'Connect an MCP client to this URL. The 2026-07-28 revision is served, and the 2025 ones;',
  'its questions to the user (elicitation) need 2026-07-28.',
  '',
].join('\n')

/** The body, read up to `max` bytes; `undefined` once it is longer. */
const readBounded = async (request: Request, max: number): Promise<string | undefined> => {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** The answer, cut off (the stream errors) once it is longer than `max` bytes. */
export const boundResponse = (response: Response, max: number): Response => {
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (declared > max) return rpcError(500, -32603, 'The answer is too large')
  if (!response.body) return response
  let size = 0
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength
        if (size > max) controller.error(new Error('The answer is too large'))
        else controller.enqueue(chunk)
      },
    }),
  )
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

const fieldOf = (message: unknown, key: 'id' | 'method'): unknown =>
  typeof message === 'object' && message !== null
    ? (message as Record<string, unknown>)[key]
    : undefined

/** One server per request, the same for both eras: the tools are declared once. */
const buildServer = (ctx: McpRequestContext): McpServer => {
  const origin = ctx.requestInfo ? new URL(ctx.requestInfo.url).origin : 'https://agent.dudko.dev'
  const server = new McpServer(DEMO_SERVER_INFO, {
    instructions: DEMO_INSTRUCTIONS,
    // The lists never change: a client has no reason to open a stream for changes. (The trip
    // board's resource is what makes the server one with resources.)
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    maxToolInputElements: DEMO_LIMITS.toolInputElements,
    // The same validator on Node (tests, the demo's dev server) as on workerd.
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  })
  // Errors are answered on the wire; nothing about a request is written anywhere else.
  server.server.onerror = () => {}
  registerDemoTools(server, { era: ctx.era, origin })
  // The Skills extension is written against 2026-07-28: declared, and served, there only. A 2025
  // client sees no extension and its methods are unknown (-32601); the tools are the same.
  if (ctx.era === 'modern') attachDemoSkills(server)
  return server
}

export interface DemoMcpServer {
  /** Serve one request to `DEMO_MCP_PATH` (the path itself is not checked here). */
  fetch: (request: Request) => Promise<Response>
  close: () => Promise<void>
}

export const createDemoMcpServer = (): DemoMcpServer => {
  const handler = createMcpHandler(buildServer, {
    legacy: 'stateless',
    maxRequestBodySize: DEMO_LIMITS.requestBytes,
    onerror: () => {},
  })

  const serve = async (request: Request): Promise<Response> => {
    // Same origin only: a page elsewhere gets no answer it could read. Clients that are not
    // pages (an agent on a server, a desktop app) send no Origin and are served.
    const origin = request.headers.get('origin')
    if (origin !== null && origin !== new URL(request.url).origin) {
      return rpcError(403, -32600, 'Requests from other origins are not accepted')
    }
    if (
      request.method === 'GET' &&
      !(request.headers.get('accept') ?? '').includes('text/event-stream')
    ) {
      // A person who opened the URL: say what it is. (A 2025 client asking for a stream sends
      // `Accept: text/event-stream` and gets the SDK's 405.)
      return new Response(ABOUT, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    if (request.method !== 'POST') return handler.fetch(request)

    const length = Number(request.headers.get('content-length') ?? 0)
    if (length > DEMO_LIMITS.requestBytes) {
      return rpcError(413, -32600, 'The request body is too large')
    }
    const raw = await readBounded(request, DEMO_LIMITS.requestBytes)
    if (raw === undefined) return rpcError(413, -32600, 'The request body is too large')
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      message = undefined // Not JSON: the SDK gives the parse error.
    }
    if (Array.isArray(message)) {
      return rpcError(400, -32600, 'JSON-RPC batches are not accepted: one message per request')
    }
    if (fieldOf(message, 'method') === 'subscriptions/listen') {
      const id = fieldOf(message, 'id') ?? null
      return rpcError(200, -32601, 'This server announces no changes: its lists never change', id)
    }
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    const forwarded = new Request(request.url, {
      method: 'POST',
      headers,
      body: raw,
      signal: request.signal,
    })
    return boundResponse(await handler.fetch(forwarded), DEMO_LIMITS.responseBytes)
  }

  return { fetch: serve, close: () => handler.close() }
}
