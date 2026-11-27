/**
 * MCP by hand, for the demo server: JSON-RPC built here and handed to `server.fetch` as a
 * web-standard `Request`, exactly as the Worker receives it. The answer is checked on the wire
 * (status, headers, error codes, result shapes), not through an SDK client.
 */
import type { DemoMcpServer } from '../src/demo-server.ts'

export const MODERN = '2026-07-28'
export const URL_ON_SITE = 'https://agent.dudko.dev/mcp/demo'

const ACCEPT = 'application/json, text/event-stream'

type Json = Record<string, unknown>

/** The per-request `_meta` of a 2026-07-28 request. */
export const envelope = (capabilities: Json = {}): Json => ({
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'wire-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': capabilities,
})

/** A client that can be asked both kinds of question. */
export const ASKABLE = { elicitation: { form: {}, url: {} } }

export interface IWireAnswer {
  status: number
  headers: Headers
  text: string
  /** The JSON-RPC message that answers the request: the JSON body, or the last SSE event. */
  message: any
}

const parseEvents = (text: string): any[] =>
  text
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data))

export const read = async (res: Response): Promise<IWireAnswer> => {
  const text = await res.text()
  const sse = (res.headers.get('content-type') ?? '').includes('text/event-stream')
  let message: unknown
  try {
    message = sse ? parseEvents(text).at(-1) : JSON.parse(text)
  } catch {
    message = undefined
  }
  return { status: res.status, headers: res.headers, text, message }
}

let nextId = 0

/** The request a correct 2026-07-28 client sends for one JSON-RPC request. */
export const modernRequest = (
  method: string,
  params: Json = {},
  capabilities: Json = {},
  headers: Record<string, string> = {},
  url: string = URL_ON_SITE,
): Request => {
  nextId += 1
  // `Mcp-Name` mirrors the tool's name, or the resource's URI (the SDK checks they agree).
  const name =
    typeof params.name === 'string'
      ? params.name
      : typeof params.uri === 'string'
        ? params.uri
        : undefined
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(name === undefined ? {} : { 'mcp-name': name }),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId,
      method,
      params: { ...params, _meta: envelope(capabilities) },
    }),
  })
}

export const modern = async (
  server: DemoMcpServer,
  method: string,
  params: Json = {},
  capabilities: Json = {},
): Promise<IWireAnswer> => read(await server.fetch(modernRequest(method, params, capabilities)))

/** One 2025-era message (no `_meta` envelope). */
export const legacyRequest = (message: Json | Json[], headers: Record<string, string> = {}) =>
  new Request(URL_ON_SITE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      ...(!Array.isArray(message) && message.method === 'initialize'
        ? {}
        : { 'mcp-protocol-version': '2025-11-25' }),
      ...headers,
    },
    body: JSON.stringify(message),
  })

export const legacy = async (server: DemoMcpServer, message: Json): Promise<IWireAnswer> =>
  read(await server.fetch(legacyRequest(message)))

export const initialize = (server: DemoMcpServer): Promise<IWireAnswer> =>
  legacy(server, {
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: { elicitation: { form: {}, url: {} } },
      clientInfo: { name: 'wire-test', version: '1.0.0' },
    },
  })

/** The text of the first content block of a tool result. */
export const textOf = (answer: IWireAnswer): string =>
  (answer.message?.result?.content?.[0]?.text as string | undefined) ?? ''
