import { startLocalMcpServer, type McpProtocol } from '@dudko.dev/test-servers'

/**
 * Everything one MCP session puts on the wire, as the transport hands it to
 * `fetch`: method, request headers and body of every request, in a form that
 * can be compared between two runs (the port and the client's version are
 * replaced, the entries sorted - the GET stream opens beside the first POSTs).
 *
 * Used to show that a server config WITHOUT `protocol` sends exactly what it
 * sent before the option existed: `tests/fixtures/mcp-wire-without-protocol.json`
 * was recorded from the connector as it was before that change.
 */
export interface IWireRequest {
  method: string
  headers: Record<string, string>
  body: unknown
}

interface IWireSession {
  tools: Record<string, unknown>
  close: () => Promise<void>
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>

const normalizeBody = (raw: unknown): unknown => {
  if (typeof raw !== 'string' || !raw) {
    return null
  }
  const parsed = JSON.parse(raw) as { params?: { clientInfo?: { version?: string } } }
  if (parsed.params?.clientInfo?.version !== undefined) {
    parsed.params.clientInfo.version = '<version>'
  }
  return parsed
}

export const captureMcpWire = async (
  connect: (url: string, fetchFn: FetchFn) => Promise<IWireSession>,
  protocol: McpProtocol = 'legacy',
): Promise<IWireRequest[]> => {
  const server = await startLocalMcpServer({ protocol, structuredTools: true })
  const seen: IWireRequest[] = []
  const fetchFn: FetchFn = (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value
    })
    seen.push({
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))),
      body: normalizeBody(init?.body),
    })
    return fetch(input, init)
  }
  const session = await connect(server.url, fetchFn)
  try {
    const call = (name: string, args: unknown = {}): Promise<unknown> =>
      (session.tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(
        args,
        {},
      )
    await call('wx__echo', { text: 'hi' })
    await call('wx__report')
    await call('wx__boom').catch(() => undefined)
    // The 2025 revisions open a GET stream beside the first requests: wait for
    // it, so that it is in the record every time.
    if (protocol !== 'modern') {
      const deadline = Date.now() + 3_000
      while (!seen.some((r) => r.method === 'GET') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
  } finally {
    await session.close()
    await server.close()
  }
  return seen
    .map((r) => JSON.stringify(r))
    .sort()
    .map((r) => JSON.parse(r) as IWireRequest)
}
