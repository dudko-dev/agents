import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  REPORT_VALUE,
  startLocalMcp,
  startLocalMcpServer,
  type ILocalMcpServer,
  type McpProtocol,
} from '@dudko.dev/test-servers'
import {
  BrowserOAuthProvider,
  connectMcpHttp,
  finishMcpOAuth,
  MCP_MODERN_PROTOCOL_VERSION,
  MemoryOAuthStorage,
  type McpHttpServerConfig,
  type McpProtocolMode,
} from '../dist/mcp.js'
import { captureMcpWire } from './helpers/mcp-wire.ts'

// The connector on the 2.x SDK client, against REAL servers over real sockets
// (`@dudko.dev/test-servers`: the 1.x server SDK behind `legacy`, the 2.x one
// behind `modern`, both behind `dual`). The same suite as the Node sibling's
// `tests/mcp-protocol.test.ts`, minus stdio.
//
// First half: a server config WITHOUT `protocol`. The client negotiates the
// 2025 revisions only (`versionNegotiation` is not passed to the SDK at all): a
// server that also speaks 2026-07-28 must make no difference, one that speaks
// nothing else must fail clearly, and the wire is what it was before the
// option existed.
//
// Second half: `protocol: 'legacy' | 'auto' | 'modern'` against each of the
// three servers, and what 2026-07-28 changes (the listen stream,
// `input_required`, OAuth). What a page's CORS adds is in
// `tests/mcp-protocol-cors.test.ts`.

const callTool = (tools: Record<string, unknown>, name: string, args: unknown = {}) =>
  (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {})

const until = async (condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Everything a session shows of itself: what was mounted, what each call gave, what was logged. */
const session = async (protocol: McpProtocol) => {
  const server: ILocalMcpServer = await startLocalMcpServer({
    protocol,
    structuredTools: true,
    instructions: 'Call report before report_mixed.',
  })
  const logs: string[] = []
  const changed: string[] = []
  const mcp = await connectMcpHttp(
    { wx: { url: server.url } },
    {
      clientName: 'agent-web-test',
      onLog: (level, message) => logs.push(`${level} ${message}`),
      onToolsChanged: (name) => changed.push(name),
    },
  )
  try {
    const seen: Record<string, unknown> = {
      results: mcp.results,
      instructions: mcp.instructions,
      catalog: mcp.catalog,
      echo: await callTool(mcp.tools, 'wx__echo', { text: 'hi' }),
      report: await callTool(mcp.tools, 'wx__report'),
      boom: await callTool(mcp.tools, 'wx__boom').then(
        () => 'resolved',
        (err: unknown) => String(err),
      ),
    }
    server.structuredFaults.result = 'mismatch'
    seen.mismatch = await callTool(mcp.tools, 'wx__report')
    server.structuredFaults.result = 'missing'
    seen.missing = await callTool(mcp.tools, 'wx__report')
    server.structuredFaults.result = undefined

    // The server tells the client its tool list changed; the client re-lists.
    await until(() => server.changeListeners() > 0, 'the notification stream')
    server.addTool('late')
    await until(() => changed.length > 0, 'notifications/tools/list_changed')
    await mcp.refreshServer('wx')
    seen.changed = changed
    seen.late = await callTool(mcp.tools, 'wx__late')
    seen.tools = Object.keys(mcp.tools)
    seen.logs = logs
    return { seen, requests: server.requests, calls: server.calls }
  } finally {
    await mcp.close()
    await server.close()
  }
}

test('legacy server: the whole surface of a session', async () => {
  const { seen, requests } = await session('legacy')
  assert.deepEqual(seen.results, [{ name: 'wx', connected: true }])
  assert.deepEqual(seen.instructions, [
    { server: 'wx', instructions: 'Call report before report_mixed.' },
  ])
  assert.equal(seen.echo, 'echo:hi')
  assert.deepEqual(seen.report, REPORT_VALUE)
  assert.equal(seen.boom, 'Error: kaboom')
  assert.deepEqual(Object.keys(seen.mismatch as object), ['note', 'structuredContent'])
  assert.deepEqual(Object.keys(seen.missing as object), ['note', 'content'])
  assert.deepEqual(seen.changed, ['wx'])
  assert.equal(seen.late, 'late:ok')
  assert.deepEqual(seen.tools, [
    'wx__echo',
    'wx__secret',
    'wx__boom',
    'wx__report',
    'wx__report_mixed',
    'wx__late',
  ])
  // The 2025 handshake, and nothing of the 2026 revision.
  assert.deepEqual(
    requests.slice(0, 3).map((r) => r.method),
    ['initialize', 'notifications/initialized', 'tools/list'],
  )
  assert.ok(requests.every((r) => r.era === 'legacy'))
  assert.ok(!requests.some((r) => r.method === 'server/discover'))
})

test('dual server: identical to a legacy one for this client, request for request', async () => {
  const legacy = await session('legacy')
  const dual = await session('dual')
  assert.deepEqual(dual.seen, legacy.seen)
  assert.deepEqual(dual.requests, legacy.requests)
  assert.deepEqual(dual.calls, legacy.calls)
  assert.ok(dual.requests.every((r) => r.era === 'legacy'))
})

test('modern-only server: a clear connection error, at once, and no tools', async () => {
  // Without `protocol` nothing of 2026-07-28 is tried. This is what a server
  // that dropped the 2025 revisions then looks like: a failed connect that says why.
  const server = await startLocalMcpServer({ protocol: 'modern' })
  const logs: string[] = []
  const started = Date.now()
  const mcp = await connectMcpHttp(
    { wx: { url: server.url }, other: { url: server.url } },
    { onLog: (level, message) => logs.push(`${level} ${message}`), connectTimeoutMs: 5_000 },
  )
  try {
    assert.ok(Date.now() - started < 2_000, 'refused, not timed out')
    assert.deepEqual(Object.keys(mcp.tools), [])
    assert.equal(mcp.results.length, 2)
    for (const result of mcp.results) {
      assert.equal(result.connected, false)
      assert.equal(result.needsAuthorization, undefined)
      assert.match(result.error ?? '', /Unsupported protocol version: 2025-11-25/)
      assert.match(result.error ?? '', /"supported":\["2026-07-28"\]/)
      // A refusal the server spelled out is not dressed up as a CORS problem.
      assert.doesNotMatch(result.error ?? '', /Access-Control|browser blocked/)
    }
    assert.ok(
      logs.some((l) => /^error \[mcp\] wx: failed to connect - .*Unsupported protocol/.test(l)),
    )
    // Only the handshake was tried: no probe, no second attempt in another dialect.
    assert.deepEqual(
      server.requests.map((r) => `${r.era} ${r.method}`),
      ['legacy initialize', 'legacy initialize'],
    )
  } finally {
    await mcp.close()
    await server.close()
  }
})

// ── `protocol` unset: the wire did not move ────────────────────────────────

const WIRE_WITHOUT_PROTOCOL = JSON.parse(
  readFileSync(new URL('./fixtures/mcp-wire-without-protocol.json', import.meta.url), 'utf8'),
) as unknown

const wireOf = (config: Partial<McpHttpServerConfig>, server: McpProtocol = 'legacy') =>
  captureMcpWire(
    (url, fetchFn) =>
      connectMcpHttp(
        { wx: { url, fetch: fetchFn, ...config } },
        { clientName: 'agent-web-test', onToolsChanged: () => {} },
      ),
    server,
  )

test('protocol unset: every request - method, headers, body - is what it was before the option existed', async () => {
  // The fixture was recorded from the connector as it was BEFORE `protocol`
  // (tests/helpers/mcp-wire.ts): a session without the field must still send
  // exactly that, to a 2025 server and to one that also speaks 2026-07-28.
  const unset = await wireOf({})
  assert.deepEqual(unset, WIRE_WITHOUT_PROTOCOL)
  assert.deepEqual(await wireOf({ protocol: undefined }), WIRE_WITHOUT_PROTOCOL)
  assert.deepEqual(await wireOf({ protocol: 'legacy' }), WIRE_WITHOUT_PROTOCOL)
  assert.deepEqual(await wireOf({}, 'dual'), WIRE_WITHOUT_PROTOCOL)
  // And none of it is of the 2026 revision: no header a 2025 CORS list lacks.
  const text = JSON.stringify(unset)
  assert.doesNotMatch(text, /mcp-method|mcp-name|server\/discover|_meta|2026-07-28/i)
})

test('protocol set: the same session in the 2026-07-28 revision is a different wire', async () => {
  // The other half of the test above: the comparison can tell the two apart.
  const modern = await wireOf({ protocol: 'modern' }, 'dual')
  assert.notDeepEqual(modern, WIRE_WITHOUT_PROTOCOL)
  const posts = modern.filter((r) => r.method === 'POST')
  assert.ok(posts.length > 0)
  for (const post of posts) {
    assert.equal(post.headers['mcp-protocol-version'], MCP_MODERN_PROTOCOL_VERSION)
    assert.equal(post.headers['mcp-method'], (post.body as { method: string }).method)
  }
  const calls = posts.filter((r) => (r.body as { method: string }).method === 'tools/call')
  assert.deepEqual(
    calls.map((r) => r.headers['mcp-name']).sort(),
    ['boom', 'echo', 'report'],
    'Mcp-Name is derived from the message, although the call goes through client.request',
  )
  // No session and no GET stream; and no Mcp-Param-* header (the typed verb's
  // own), so the request headers a server's CORS list must allow are these:
  assert.ok(!modern.some((r) => r.method === 'GET' || r.method === 'DELETE'))
  assert.deepEqual([...new Set(modern.flatMap((r) => Object.keys(r.headers)))].sort(), [
    'accept',
    'content-type',
    'mcp-method',
    'mcp-name',
    'mcp-protocol-version',
  ])
})

// ── `protocol`: each mode against each server ──────────────────────────────

/** One session with `protocol` set, for the matrix: what connected, what a call gave, what was sent. */
const matrixSession = async (serverProtocol: McpProtocol, protocol: McpProtocolMode) => {
  const server = await startLocalMcpServer({
    protocol: serverProtocol,
    structuredTools: true,
    instructions: 'Call report before report_mixed.',
  })
  const logs: string[] = []
  const started = Date.now()
  const mcp = await connectMcpHttp(
    { wx: { url: server.url, protocol } },
    { onLog: (level, message) => logs.push(`${level} ${message}`), connectTimeoutMs: 5_000 },
  )
  const connectMs = Date.now() - started
  try {
    const seen: Record<string, unknown> = {}
    if (mcp.results[0].connected) {
      seen.echo = await callTool(mcp.tools, 'wx__echo', { text: 'hi' })
      seen.report = await callTool(mcp.tools, 'wx__report')
      seen.boom = await callTool(mcp.tools, 'wx__boom').then(
        () => 'resolved',
        (err: unknown) => String(err),
      )
      server.structuredFaults.result = 'mismatch'
      seen.mismatch = await callTool(mcp.tools, 'wx__report')
      server.structuredFaults.result = 'missing'
      seen.missing = await callTool(mcp.tools, 'wx__report')
    }
    return {
      result: mcp.results[0],
      protocols: mcp.protocols,
      instructions: mcp.instructions,
      tools: Object.keys(mcp.tools),
      seen,
      logs,
      connectMs,
      requests: server.requests.map((r) => `${r.era} ${r.method}`),
      calls: server.calls.map((c) => c.name),
    }
  } finally {
    await mcp.close()
    await server.close()
  }
}

const LEGACY_VERSION = '2025-11-25'

// server -> client mode -> the revision negotiated, or the error.
const MATRIX: Record<McpProtocol, Record<McpProtocolMode, string | RegExp>> = {
  legacy: {
    legacy: LEGACY_VERSION,
    auto: LEGACY_VERSION,
    modern: /did not offer pinned protocol version 2026-07-28 .* - protocol: 'modern' accepts only/,
  },
  dual: {
    legacy: LEGACY_VERSION,
    auto: MCP_MODERN_PROTOCOL_VERSION,
    modern: MCP_MODERN_PROTOCOL_VERSION,
  },
  modern: {
    legacy: /Unsupported protocol version: 2025-11-25/,
    auto: MCP_MODERN_PROTOCOL_VERSION,
    modern: MCP_MODERN_PROTOCOL_VERSION,
  },
}

for (const serverProtocol of ['legacy', 'dual', 'modern'] as const) {
  for (const protocol of ['legacy', 'auto', 'modern'] as const) {
    const expected = MATRIX[serverProtocol][protocol]
    test(`protocol '${protocol}' against a ${serverProtocol} server: ${
      typeof expected === 'string' ? `connects on ${expected}` : 'a clear error, at once'
    }`, async () => {
      const s = await matrixSession(serverProtocol, protocol)
      if (typeof expected !== 'string') {
        // The impossible pairs: refused in one exchange, not after a timeout.
        assert.equal(s.result.connected, false)
        assert.match(s.result.error ?? '', expected)
        assert.equal(s.result.needsAuthorization, undefined)
        // A refusal the server spelled out is not dressed up as a CORS problem.
        assert.doesNotMatch(s.result.error ?? '', /Access-Control|browser blocked/)
        assert.ok(s.connectMs < 2_000, `refused, not timed out (${s.connectMs} ms)`)
        assert.deepEqual(s.protocols, [])
        assert.deepEqual(s.tools, [])
        assert.deepEqual(
          s.requests,
          protocol === 'modern' ? ['modern server/discover'] : ['legacy initialize'],
          'one attempt in the configured revision, and no second one in another',
        )
        assert.ok(s.logs.some((l) => l.startsWith('error [mcp] wx: failed to connect - ')))
        return
      }
      const era = expected === MCP_MODERN_PROTOCOL_VERSION ? 'modern' : 'legacy'
      assert.deepEqual(s.result, { name: 'wx', connected: true })
      assert.deepEqual(s.protocols, [{ server: 'wx', version: expected, era }])
      // The instructions come from `initialize` or from `server/discover`: the same text.
      assert.deepEqual(s.instructions, [
        { server: 'wx', instructions: 'Call report before report_mixed.' },
      ])
      assert.deepEqual(s.tools, [
        'wx__echo',
        'wx__secret',
        'wx__boom',
        'wx__report',
        'wx__report_mixed',
      ])
      assert.equal(s.seen.echo, 'echo:hi')
      assert.deepEqual(s.seen.report, REPORT_VALUE)
      assert.equal(s.seen.boom, 'Error: kaboom')
      // A result that breaks the outputSchema is passed on with a note, in both eras.
      const mismatch = s.seen.mismatch as { note: string; structuredContent: unknown }
      assert.deepEqual(Object.keys(mismatch), ['note', 'structuredContent'])
      assert.match(mismatch.note, /does not follow the output schema/)
      assert.deepEqual(mismatch.structuredContent, { ...REPORT_VALUE, temperature: 'warm' })
      const missing = s.seen.missing as { note: string; content: unknown }
      assert.deepEqual(Object.keys(missing), ['note', 'content'])
      assert.match(missing.note, /did not return structured content/)

      // What was sent. The revision is decided at connect, by at most one
      // probe; after that every call is ONE request - none is tried again in
      // another revision (five calls made, five received, five run).
      const handshake =
        era === 'modern'
          ? ['modern server/discover', 'modern tools/list']
          : [
              ...(protocol === 'auto' ? ['modern server/discover'] : []),
              'legacy initialize',
              'legacy notifications/initialized',
              'legacy tools/list',
            ]
      assert.deepEqual(s.requests, [...handshake, ...Array(5).fill(`${era} tools/call`)])
      assert.deepEqual(s.calls, ['echo', 'report', 'boom', 'report', 'report'])

      // The log line that names the revision: only when the option is set to probe.
      const line = s.logs.filter((l) => /^info \[mcp\] wx: protocol /.test(l))
      if (protocol === 'legacy') {
        assert.deepEqual(line, [])
      } else {
        assert.equal(line.length, 1)
        assert.ok(line[0].includes(`protocol ${expected} (${era}`), line[0])
        assert.ok(line[0].includes(`configured '${protocol}'`), line[0])
      }
      // The "no" a 2025 server gives the probe is not reported as a broken
      // transport, and a probe that was answered is not called blocked.
      assert.deepEqual(
        s.logs.filter((l) => /^warn /.test(l) && /transport error|was blocked/.test(l)),
        [],
      )
    })
  }
}

test('protocol: a value that is none of the three names fails that server, by name, before anything is sent', async () => {
  const server = await startLocalMcpServer({ protocol: 'dual' })
  try {
    const mcp = await connectMcpHttp({
      bad: { url: server.url, protocol: '2026-07-28' as never },
      good: { url: server.url },
    })
    assert.equal(mcp.results[0].connected, false)
    assert.match(
      mcp.results[0].error ?? '',
      /MCP server "bad": protocol must be 'legacy', 'auto' or 'modern' \(got "2026-07-28"\)/,
    )
    assert.deepEqual(mcp.results[1], { name: 'good', connected: true })
    assert.ok(server.requests.every((r) => r.era === 'legacy'))
    await mcp.close()
  } finally {
    await server.close()
  }
})

test("protocol 'auto': a probe that goes wrong is an error, never a silent fall back", async () => {
  // A 2025 server says "no" to the probe and gets the 2025 handshake (the
  // matrix above). An outage or a broken answer is not a "no".
  for (const [fault, expected] of [
    ['server_error', /Version negotiation failed: the server answered the probe with HTTP 503/],
    ['garbage', /Version negotiation probe failed: the server answered with an unusable reply/],
  ] as const) {
    const server = await startLocalMcpServer({ protocol: 'dual' })
    server.protocolFaults.probe = fault
    try {
      const started = Date.now()
      const mcp = await connectMcpHttp({ wx: { url: server.url, protocol: 'auto' } })
      assert.equal(mcp.results[0].connected, false, fault)
      assert.match(mcp.results[0].error ?? '', expected)
      assert.doesNotMatch(mcp.results[0].error ?? '', /Access-Control/)
      assert.ok(Date.now() - started < 2_000, 'at once')
      assert.deepEqual(
        server.requests.map((r) => `${r.era} ${r.method}`),
        ['modern server/discover'],
        'no handshake was tried after it',
      )
      await mcp.close()
    } finally {
      await server.close()
    }
  }
})

// ── 2026-07-28: tool list changes ──────────────────────────────────────────

test('2026-07-28: a tool list change arrives over subscriptions/listen; refreshServer re-lists', async () => {
  for (const protocol of ['auto', 'modern'] as const) {
    const server = await startLocalMcpServer({ protocol: 'modern' })
    const changed: string[] = []
    const logs: string[] = []
    const mcp = await connectMcpHttp(
      { wx: { url: server.url, protocol } },
      {
        onLog: (level, message) => logs.push(`${level} ${message}`),
        onToolsChanged: (name) => changed.push(name),
      },
    )
    try {
      assert.deepEqual(mcp.results, [{ name: 'wx', connected: true }])
      // Opened before the first list, and acknowledged by then.
      assert.deepEqual(
        server.requests.map((r) => r.method),
        ['server/discover', 'subscriptions/listen', 'tools/list'],
      )
      assert.equal(server.changeListeners(), 1)
      server.addTool('late')
      await until(() => changed.length > 0, 'notifications/tools/list_changed')
      assert.deepEqual(changed, ['wx'])
      assert.ok(!('wx__late' in mcp.tools), 'nothing is re-listed behind the caller')
      await mcp.refreshServer('wx')
      assert.equal(await callTool(mcp.tools, 'wx__late'), 'late:ok')

      // The stream is not opened again when it ends: that is said, once.
      await server.close()
      await until(() => logs.some((l) => /tool list change stream ended/.test(l)), 'the warning')
      assert.deepEqual(
        logs.filter((l) => /tool list change stream ended/.test(l)),
        [
          'warn [mcp] wx: the tool list change stream ended (closed by the server); changes are not announced until the server is connected again',
        ],
      )
    } finally {
      await mcp.close()
      await server.close()
    }
  }
})

test('2026-07-28: no listen stream without onToolsChanged, and closing the connection ends it quietly', async () => {
  const server = await startLocalMcpServer({ protocol: 'modern' })
  try {
    const silent = await connectMcpHttp({ wx: { url: server.url, protocol: 'modern' } })
    assert.deepEqual(
      server.requests.map((r) => r.method),
      ['server/discover', 'tools/list'],
    )
    assert.equal(server.changeListeners(), 0)
    await silent.close()

    const logs: string[] = []
    const mcp = await connectMcpHttp(
      { wx: { url: server.url, protocol: 'modern' } },
      { onLog: (level, message) => logs.push(`${level} ${message}`), onToolsChanged: () => {} },
    )
    assert.equal(server.changeListeners(), 1)
    await mcp.close()
    await until(() => server.changeListeners() === 0, 'the stream to end at the server')
    assert.deepEqual(
      logs.filter((l) => /stream ended|could not subscribe/.test(l)),
      [],
      'our own close is not a dropped stream',
    )
  } finally {
    await server.close()
  }
})

test('2026-07-28: a server that does not advertise tools.listChanged is not asked for a listen stream', async () => {
  // Answered by hand: the test server always advertises it.
  const methods: string[] = []
  const fetchFn = async (_url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const msg = JSON.parse(String(init.body)) as { id?: number | string; method: string }
    methods.push(msg.method)
    const result =
      msg.method === 'server/discover'
        ? {
            resultType: 'complete',
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {} },
            ttlMs: 0,
            cacheScope: 'private',
          }
        : msg.method === 'tools/list'
          ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [] }
          : undefined
    return new Response(
      JSON.stringify(
        result
          ? { jsonrpc: '2.0', id: msg.id, result }
          : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } },
      ),
      { status: result ? 200 : 404, headers: { 'content-type': 'application/json' } },
    )
  }
  const logs: string[] = []
  const mcp = await connectMcpHttp(
    { wx: { url: 'https://mcp.example.test/mcp', fetch: fetchFn, protocol: 'modern' } },
    { onLog: (level, message) => logs.push(`${level} ${message}`), onToolsChanged: () => {} },
  )
  assert.deepEqual(mcp.results, [{ name: 'wx', connected: true }])
  assert.deepEqual(methods, ['server/discover', 'tools/list'])
  assert.deepEqual(
    logs.filter((l) => /tool list change/.test(l)),
    ['info [mcp] wx: the server does not announce tool list changes'],
  )
  await mcp.close()
})

// ── 2026-07-28: input_required ─────────────────────────────────────────────

test('2026-07-28: an input_required result is a clear tool error, and the call is made once', async () => {
  const server = await startLocalMcpServer({ protocol: 'modern', elicitationTools: true })
  // A server that asks although this client declared no elicitation capability.
  server.elicitationFaults.undeclaredMode = true
  const mcp = await connectMcpHttp({ wx: { url: server.url, protocol: 'modern' } })
  try {
    for (const tool of ['elicit_form', 'elicit_twice', 'elicit_state']) {
      await assert.rejects(
        () => callTool(mcp.tools, `wx__${tool}`),
        (err: unknown) => {
          assert.equal(
            (err as Error).message,
            `MCP tool "${tool}" did not finish: the server asked for more input (an "input_required" result: an elicitation, or a retry of the call), which this client does not support. The call was not repeated.`,
          )
          return true
        },
      )
    }
    // Asked three times, answered never: no round was fulfilled, none retried.
    assert.equal(server.requests.filter((r) => r.method === 'tools/call').length, 3)
    assert.equal(server.elicitations.length, 3)
    assert.ok(server.elicitations.every((round) => round.responses === undefined))
    // The connection is still good.
    assert.equal(await callTool(mcp.tools, 'wx__echo', { text: 'after' }), 'echo:after')
  } finally {
    await mcp.close()
    await server.close()
  }
})

test('2026-07-28: a tool that needs elicitation is refused by an honest server, since none is declared', async () => {
  const server = await startLocalMcpServer({ protocol: 'modern', elicitationTools: true })
  const mcp = await connectMcpHttp({ wx: { url: server.url, protocol: 'modern' } })
  try {
    await assert.rejects(
      () => callTool(mcp.tools, 'wx__elicit_form'),
      /client capabilities do not declare the required capability/,
    )
    assert.equal(server.requests.filter((r) => r.method === 'tools/call').length, 1)
  } finally {
    await mcp.close()
    await server.close()
  }
})

// ── 2026-07-28: OAuth ──────────────────────────────────────────────────────

for (const [serverProtocol, protocol] of [
  ['modern', 'modern'],
  ['modern', 'auto'],
  ['dual', 'auto'],
  ['legacy', 'auto'],
] as const) {
  test(`OAuth with protocol '${protocol}' against a ${serverProtocol} server: authorize, connect, call, refresh`, async () => {
    const server = await startLocalMcp({ requireAuth: true, protocol: serverProtocol })
    try {
      const provider = new BrowserOAuthProvider({
        serverUrl: server.url,
        redirectUrl: 'http://127.0.0.1:9999/callback',
        storage: new MemoryOAuthStorage(),
        clientName: 'agent-web-test',
        onRedirect: () => {},
      })
      const connect = () =>
        connectMcpHttp({ wx: { url: server.url, authProvider: provider, protocol } })
      // The probe is the first request the server refuses: the 401 starts the
      // authorization exactly as a refused `initialize` does.
      const first = await connect()
      assert.equal(first.results[0].connected, false)
      assert.equal(first.results[0].needsAuthorization, true)
      assert.equal(server.registrations(), 1)
      await first.close()

      await finishMcpOAuth(provider, {
        code: 'auth-code-1',
        state: provider.authorizationUrl?.searchParams.get('state') ?? undefined,
      })
      const mcp = await connect()
      try {
        assert.deepEqual(mcp.results, [{ name: 'wx', connected: true }])
        assert.equal(mcp.protocols[0].era, serverProtocol === 'legacy' ? 'legacy' : 'modern')
        assert.equal(await callTool(mcp.tools, 'wx__echo', { text: 'hi' }), 'echo:hi')

        // The token dies mid-session: refreshed on the 401, the call sent again
        // by the transport (the server ran it once: a 401 runs nothing).
        server.validTokens.clear()
        assert.equal(await callTool(mcp.tools, 'wx__echo', { text: 'again' }), 'echo:again')
        assert.deepEqual(server.grants(), ['authorization_code', 'refresh_token'])
        assert.deepEqual(
          server.calls.map((c) => (c.args as { text: string }).text),
          ['hi', 'again'],
        )
      } finally {
        await mcp.close()
      }
    } finally {
      await server.close()
    }
  })
}
