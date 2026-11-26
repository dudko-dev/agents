import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { startLocalMcpServer, type McpProtocol } from '@dudko.dev/test-servers'
import {
  connectMcpHttp,
  diagnoseMcpCors,
  MCP_MODERN_REQUEST_HEADERS,
  type McpProtocolMode,
} from '../dist/mcp.js'

// `protocol: 'auto' | 'modern'` from a PAGE. The 2026-07-28 revision sends
// `Mcp-Method` and `Mcp-Name` (and `MCP-Protocol-Version` on the first request
// already), and a browser sends a header only to a server whose
// `Access-Control-Allow-Headers` lists it.
//
// There is no browser here, so the part of one that matters is played by
// `pageFetch`: before every request it sends the REAL preflight to the real
// test server and, as a browser would, throws a bare `TypeError` - telling
// nothing - when the answer does not allow the origin or one of the request
// headers. The server's `cors` probe fault answers every preflight with the
// header list of a deployment configured before 2026-07-28.
//
// The SDK decides differently in a page and outside one (a blocked probe is
// "a 2025 server" in a page, an error elsewhere), by `window` and `document`:
// `asPage` gives it a page to see.

const ORIGIN = 'https://app.example.test'

/** Headers a browser sends without asking (the CORS safelist, as far as this client goes). */
const SAFELISTED = new Set(['accept', 'accept-language', 'content-language'])

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>

/** A page's `fetch`, as far as CORS goes; `preflights` records what each one asked for. */
const pageFetch = (preflights: string[][] = []): FetchFn => {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    const asked = [...headers.keys()].map((h) => h.toLowerCase()).filter((h) => !SAFELISTED.has(h))
    preflights.push(asked)
    const preflight = await fetch(input, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': init?.method ?? 'GET',
        'access-control-request-headers': asked.join(', '),
      },
    })
    const allowedOrigin = preflight.headers.get('access-control-allow-origin')
    const allowed = (preflight.headers.get('access-control-allow-headers') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
    if (
      !preflight.ok ||
      (allowedOrigin !== ORIGIN && allowedOrigin !== '*') ||
      asked.some((h) => !allowed.includes(h))
    ) {
      throw new TypeError('Failed to fetch')
    }
    headers.set('origin', ORIGIN)
    return fetch(input, { ...init, headers })
  }
}

const asPage = async <T>(run: () => Promise<T>): Promise<T> => {
  const g = globalThis as { window?: unknown; document?: unknown }
  const saved = { window: g.window, document: g.document }
  g.window = globalThis
  g.document = {}
  try {
    return await run()
  } finally {
    g.window = saved.window
    g.document = saved.document
  }
}

const callTool = (tools: Record<string, unknown>, name: string, args: unknown = {}) =>
  (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {})

/** Connect from a "page" to a server whose CORS list is (or is not) the pre-2026 one. */
const fromPage = async (
  serverProtocol: McpProtocol,
  protocol: McpProtocolMode | undefined,
  opts: { oldCors?: boolean; page?: boolean } = {},
) => {
  const server = await startLocalMcpServer({ protocol: serverProtocol, cors: ORIGIN })
  if (opts.oldCors) server.protocolFaults.probe = 'cors'
  const logs: string[] = []
  const preflights: string[][] = []
  const connect = () =>
    connectMcpHttp(
      { wx: { url: server.url, fetch: pageFetch(preflights), ...(protocol ? { protocol } : {}) } },
      { onLog: (level, message) => logs.push(`${level} ${message}`), connectTimeoutMs: 5_000 },
    )
  const mcp = await (opts.page === false ? connect() : asPage(connect))
  try {
    const echo = mcp.results[0].connected
      ? await callTool(mcp.tools, 'wx__echo', { text: 'hi' })
      : undefined
    return {
      result: mcp.results[0],
      protocols: mcp.protocols,
      echo,
      logs,
      preflights,
      // What the connector sent that got through (the diagnosis's own pings left out).
      requests: server.requests
        .filter((r) => r.method !== 'ping')
        .map((r) => `${r.era} ${r.method}`),
    }
  } finally {
    await mcp.close()
    await server.close()
  }
}

const NAMES_BOTH =
  /one carrying Mcp-Method \/ Mcp-Name was blocked: the server's Access-Control-Allow-Headers does not list them\. .* add Mcp-Method, Mcp-Name to Access-Control-Allow-Headers/

test('page, CORS list with the two new headers: modern connects and calls a tool; nothing else is asked of the list', async () => {
  for (const protocol of ['auto', 'modern'] as const) {
    const s = await fromPage('dual', protocol)
    assert.deepEqual(s.result, { name: 'wx', connected: true })
    assert.deepEqual(s.protocols, [{ server: 'wx', version: '2026-07-28', era: 'modern' }])
    assert.equal(s.echo, 'echo:hi')
    // Every non-safelisted header the client sent, over the whole session.
    assert.deepEqual(
      [...new Set(s.preflights.flat())].sort(),
      ['content-type', 'mcp-method', 'mcp-name', 'mcp-protocol-version'],
      'no Mcp-Param-* header: the list in the README is the whole requirement',
    )
    assert.deepEqual(
      s.logs.filter((l) => /blocked|Access-Control/.test(l)),
      [],
    )
  }
})

test("page, pre-2026 CORS list, protocol 'modern': the connect fails and the error names the missing headers", async () => {
  for (const serverProtocol of ['dual', 'modern'] as const) {
    const s = await fromPage(serverProtocol, 'modern', { oldCors: true })
    assert.equal(s.result.connected, false)
    // The SDK's sentence (a blocked probe looks like a server that did not
    // offer the revision), which option to turn, and the actual cause.
    assert.match(s.result.error ?? '', /did not offer pinned protocol version 2026-07-28/)
    assert.match(s.result.error ?? '', NAMES_BOTH)
    // MCP-Protocol-Version is on the old list: it is not accused.
    assert.doesNotMatch(s.result.error ?? '', /carrying MCP-Protocol-Version/)
    assert.deepEqual(s.requests, [], 'the probe never reached the server')
    assert.ok(
      s.logs.some(
        (l) => l.startsWith('error [mcp] wx: failed to connect - ') && NAMES_BOTH.test(l),
      ),
    )
  }
})

test("page, pre-2026 CORS list, protocol 'auto', a server that speaks both: connects on 2025, with a warning that names the headers", async () => {
  const s = await fromPage('dual', 'auto', { oldCors: true })
  assert.deepEqual(s.result, { name: 'wx', connected: true })
  assert.deepEqual(s.protocols, [{ server: 'wx', version: '2025-11-25', era: 'legacy' }])
  assert.equal(s.echo, 'echo:hi')
  assert.ok(s.requests.every((r) => r.startsWith('legacy ')))
  const warnings = s.logs.filter((l) => /^warn .*version probe .* was blocked/.test(l))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /so the connection uses 2025-11-25/)
  assert.match(warnings[0], NAMES_BOTH)
})

test("page, pre-2026 CORS list, protocol 'auto', a 2026-only server: the refusal of the handshake, and why the probe did not get there", async () => {
  const s = await fromPage('modern', 'auto', { oldCors: true })
  assert.equal(s.result.connected, false)
  assert.match(s.result.error ?? '', /Unsupported protocol version: 2025-11-25/)
  assert.match(s.result.error ?? '', NAMES_BOTH)
  assert.deepEqual(s.requests, ['legacy initialize'])
})

test("outside a page (a worker), pre-2026 CORS list: a blocked probe is an error in 'auto' too, and it names the headers", async () => {
  for (const protocol of ['auto', 'modern'] as const) {
    const s = await fromPage('dual', protocol, { oldCors: true, page: false })
    assert.equal(s.result.connected, false)
    assert.match(s.result.error ?? '', /Version negotiation probe failed: .*Failed to fetch/)
    assert.match(s.result.error ?? '', NAMES_BOTH)
    assert.deepEqual(s.requests, [])
  }
})

test('page, pre-2026 CORS list, protocol unset: nothing changes - the 2025 headers are all that is sent', async () => {
  const s = await fromPage('dual', undefined, { oldCors: true })
  assert.deepEqual(s.result, { name: 'wx', connected: true })
  assert.equal(s.echo, 'echo:hi')
  assert.deepEqual([...new Set(s.preflights.flat())].sort(), [
    'content-type',
    'mcp-protocol-version',
  ])
  assert.deepEqual(
    s.logs.filter((l) => /blocked|Access-Control/.test(l)),
    [],
  )
})

test("page, good CORS, protocol 'modern', a 2025 server: refused by the server - not dressed up as a CORS problem", async () => {
  const s = await fromPage('legacy', 'modern')
  assert.equal(s.result.connected, false)
  assert.match(s.result.error ?? '', /did not offer pinned protocol version 2026-07-28/)
  assert.match(s.result.error ?? '', /protocol: 'modern' accepts only/)
  assert.doesNotMatch(s.result.error ?? '', /Access-Control|blocked/)
  assert.deepEqual(s.requests, ['modern server/discover'])
})

// ── diagnoseMcpCors, header by header ──────────────────────────────────────

const URL_ = 'https://mcp.example.test/mcp'

/** A fetch that blocks any request carrying one of `refused` (lower-case names). */
const refusing =
  (refused: string[], seen: string[][] = []): FetchFn =>
  async (_input, init) => {
    const names = Object.keys((init?.headers ?? {}) as Record<string, string>).map((h) =>
      h.toLowerCase(),
    )
    seen.push(names)
    if (names.some((h) => refused.includes(h))) throw new TypeError('Failed to fetch')
    return new Response('{}', { status: 400 })
  }

test('diagnoseMcpCors with a protocol: each header is tried on its own, and exactly the refused ones are named', async () => {
  const seen: string[][] = []
  const hint = await diagnoseMcpCors(URL_, refusing(['mcp-name'], seen), { protocol: 'modern' })
  assert.deepEqual(seen, [
    ['content-type'],
    ['content-type', 'mcp-protocol-version'],
    ['content-type', 'mcp-method'],
    ['content-type', 'mcp-name'],
  ])
  assert.match(hint ?? '', /one carrying Mcp-Name was blocked/)
  assert.match(hint ?? '', /does not list it\./)
  assert.match(hint ?? '', /add Mcp-Name to Access-Control-Allow-Headers/)
  assert.match(hint ?? '', /protocol: 'modern'/)

  const all = await diagnoseMcpCors(
    URL_,
    refusing(['mcp-protocol-version', 'mcp-method', 'mcp-name']),
    { protocol: 'auto' },
  )
  assert.match(all ?? '', /one carrying MCP-Protocol-Version \/ Mcp-Method \/ Mcp-Name was blocked/)
  assert.match(all ?? '', /add MCP-Protocol-Version, Mcp-Method, Mcp-Name to/)
  assert.match(all ?? '', /protocol: 'auto'/)
  // The constant a host can show is the pair the revision adds.
  assert.deepEqual([...MCP_MODERN_REQUEST_HEADERS], ['Mcp-Method', 'Mcp-Name'])
})

test('diagnoseMcpCors with a protocol: no header refused on its own leaves the general hint, with the two headers added', async () => {
  const hint = await diagnoseMcpCors(URL_, refusing([]), { protocol: 'modern' })
  assert.doesNotMatch(hint ?? '', /was blocked/)
  assert.match(hint ?? '', /a request HEADER is being refused/)
  assert.match(hint ?? '', /With protocol: 'modern', Mcp-Method and Mcp-Name too\./)
})

test('diagnoseMcpCors without a protocol, or with legacy: one plain request, the hint it always gave', async () => {
  for (const opts of [undefined, {}, { protocol: 'legacy' as const }]) {
    const seen: string[][] = []
    const hint = await diagnoseMcpCors(URL_, refusing([], seen), opts)
    assert.deepEqual(seen, [['content-type']])
    assert.equal(
      hint,
      `a plain request to ${URL_} succeeded (HTTP 400) but the transport's did not, ` +
        'so the origin is allowed and a request HEADER is being refused. Add ' +
        'MCP-Protocol-Version (required on every request after initialize) and Last-Event-ID ' +
        "to the server's Access-Control-Allow-Headers, alongside Content-Type, Authorization " +
        'and mcp-session-id.',
    )
  }
})

test('diagnoseMcpCors with a protocol: a plain request that is blocked too still points at the origin', async () => {
  const seen: string[][] = []
  const hint = await diagnoseMcpCors(URL_, refusing(['content-type'], seen), {
    protocol: 'modern',
  })
  assert.match(hint ?? '', /Access-Control-Allow-Origin/)
  assert.equal(seen.length, 1, 'no header is tried when nothing gets through')
})
