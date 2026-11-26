/**
 * MCP by hand: JSON-RPC built here and sent with `fetch`, so the MCP server is
 * checked on the wire - status codes, headers, error codes, result shapes -
 * and not through the SDK client it is later used to test.
 */

/** The revision the modern era speaks. */
export const MODERN = '2026-07-28'

const ACCEPT = 'application/json, text/event-stream'

/** An answer that never ends fails the test instead of hanging it. */
const ANSWER_TIMEOUT_MS = 10_000

type Json = Record<string, unknown>

/** The per-request `_meta` every 2026-07-28 request carries. */
export const envelope = (capabilities: Json = {}, version: string = MODERN): Json => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'wire-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': capabilities,
})

/** One HTTP answer: the JSON body if it is one, and the JSON-RPC messages of an SSE body. */
export interface IWireAnswer {
  status: number
  headers: Headers
  text: string
  /** The body parsed as JSON; `undefined` when it is not JSON. */
  body: any
  /** The JSON-RPC messages of a `text/event-stream` body, in order. */
  events: any[]
  /** The JSON-RPC message that answers the request: the JSON body, or the last event. */
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

const answer = async (res: Response): Promise<IWireAnswer> => {
  const text = await res.text()
  const sse = (res.headers.get('content-type') ?? '').includes('text/event-stream')
  let body: unknown
  try {
    body = sse ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }
  const events = sse ? parseEvents(text) : []
  return {
    status: res.status,
    headers: res.headers,
    text,
    body,
    events,
    message: sse ? events.at(-1) : body,
  }
}

export interface IModernOptions {
  id?: number | string
  /** `clientCapabilities` in `_meta`. */
  capabilities?: Json
  /** The version in `_meta` and, unless overridden, in the header. */
  version?: string
  /** Headers that replace (or, with `null`, remove) the ones a correct client sends. */
  headers?: Record<string, string | null>
  token?: string
}

let nextId = 0

/** The HTTP request a correct 2026-07-28 client sends for one JSON-RPC request. */
export const modernRequest = (
  method: string,
  params: Json = {},
  opts: IModernOptions = {},
): { headers: Record<string, string>; body: string } => {
  nextId += 1
  const name = typeof params.name === 'string' ? params.name : undefined
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: ACCEPT,
    'mcp-protocol-version': opts.version ?? MODERN,
    'mcp-method': method,
    ...(name === undefined ? {} : { 'mcp-name': name }),
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
  }
  for (const [key, value] of Object.entries(opts.headers ?? {})) {
    if (value === null) delete headers[key]
    else headers[key] = value
  }
  return {
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: opts.id ?? nextId,
      method,
      params: { ...params, _meta: envelope(opts.capabilities, opts.version) },
    }),
  }
}

/** POST one modern request and read the whole answer. */
export const modern = async (
  url: string,
  method: string,
  params: Json = {},
  opts: IModernOptions = {},
): Promise<IWireAnswer> =>
  answer(
    await fetch(url, {
      method: 'POST',
      ...modernRequest(method, params, opts),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    }),
  )

/** POST one 2025-era message (no `_meta` envelope) and read the whole answer. */
export const legacy = async (
  url: string,
  message: Json,
  headers: Record<string, string> = {},
): Promise<IWireAnswer> =>
  answer(
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        ...(message.method === 'initialize' ? {} : { 'mcp-protocol-version': '2025-11-25' }),
        ...headers,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    }),
  )

/** The `initialize` request of a 2025-11-25 client. */
export const initialize = (url: string, capabilities: Json = {}): Promise<IWireAnswer> =>
  legacy(url, {
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities,
      clientInfo: { name: 'wire-test', version: '1.0.0' },
    },
  })

/** An SSE answer read message by message while it stays open. */
export interface IWireStream {
  status: number
  headers: Headers
  /** The next JSON-RPC message; `undefined` once the server ended the stream. */
  next: () => Promise<any>
  /** Hang up (what cancels a request on Streamable HTTP). */
  close: () => void
}

export const openStream = async (url: string, init: RequestInit): Promise<IWireStream> => {
  const abort = new AbortController()
  const res = await fetch(url, { ...init, signal: abort.signal })
  const reader = res.body?.getReader()
  const decoder = new TextDecoder()
  const queue: any[] = []
  let buffer = ''
  let ended = reader === undefined
  const next = async (): Promise<any> => {
    while (queue.length === 0 && !ended) {
      const chunk = await Promise.race([
        (reader as NonNullable<typeof reader>).read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no message on the stream within 5 s')), 5000).unref(),
        ),
      ])
      if (chunk.done) {
        ended = true
        break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      const cut = Math.max(buffer.lastIndexOf('\n\n'), buffer.lastIndexOf('\r\n\r\n'))
      if (cut >= 0) {
        queue.push(...parseEvents(buffer.slice(0, cut)))
        buffer = buffer.slice(cut).trimStart()
      }
    }
    return queue.shift()
  }
  return { status: res.status, headers: res.headers, next, close: () => abort.abort() }
}

/** Open the stream of one modern request (`subscriptions/listen`, or a call read as it goes). */
export const modernStream = (
  url: string,
  method: string,
  params: Json = {},
  opts: IModernOptions = {},
): Promise<IWireStream> =>
  openStream(url, { method: 'POST', ...modernRequest(method, params, opts) })

/** Wait until `check` holds: for what the server does after it has answered. */
export const until = async (check: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}
