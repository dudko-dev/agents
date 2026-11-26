import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import {
  REPORT_VALUE,
  startLocalMcp,
  startLocalMcpServer,
  type ILocalMcpServer,
  type McpProtocol,
} from '@dudko.dev/test-servers'
import { loadConfig } from '../src/cli/config.ts'
import { createNodeOAuthProvider, finishMcpOAuth, MemoryOAuthStore } from '../src/mcp-oauth.ts'
import {
  MCP_MODERN_PROTOCOL_VERSION,
  mcpProtocolMode,
  mcpVersionNegotiation,
  type McpProtocolMode,
} from '../src/mcp-shared.ts'
import { connectMcpServers } from '../src/mcp.ts'
import type { IMcpServerConfig } from '../src/types.ts'
import { captureMcpWire } from './helpers/mcp-wire.ts'

// The connector on the 2.x SDK client, against REAL servers over real sockets
// (`@dudko.dev/test-servers`: the 1.x server SDK behind `legacy`, the 2.x one
// behind `modern`, both behind `dual`) and a real child process over stdio.
//
// First half: a server config WITHOUT `protocol`. The client negotiates the
// 2025 revisions only (`versionNegotiation` is not passed to the SDK at all): a
// server that also speaks 2026-07-28 must make no difference, one that speaks
// nothing else must fail clearly, and the wire is what it was before the
// option existed.
//
// Second half: `protocol: 'legacy' | 'auto' | 'modern'` against each of the
// three servers, and what 2026-07-28 changes (the listen stream,
// `input_required`, OAuth, stdio).

const callTool = (tools: Record<string, unknown>, name: string, args: unknown = {}) =>
  (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {})

const until = async (condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
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
  const mcp = await connectMcpServers(
    { wx: { url: server.url } },
    (level, message) => logs.push(`${level} ${message}`),
    'agent-test',
    undefined,
    (name) => changed.push(name),
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
  assert.equal(seen.boom, 'McpToolError: kaboom')
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
  const mcp = await connectMcpServers(
    { wx: { url: server.url }, other: { url: server.url } },
    (level, message) => logs.push(`${level} ${message}`),
    'agent-test',
    undefined,
    undefined,
    undefined,
    { connectTimeoutMs: 5_000 },
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
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures/mcp-wire-without-protocol.json',
    ),
    'utf8',
  ),
) as unknown

const wireOf = (config: Partial<IMcpServerConfig>, server: McpProtocol = 'legacy') =>
  captureMcpWire(
    (url, fetchFn) =>
      connectMcpServers(
        { wx: { url, fetch: fetchFn, ...config } as IMcpServerConfig },
        () => {},
        'agent-test',
        undefined,
        () => {},
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
  // And none of it is of the 2026 revision.
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
  // No session and no GET stream; and no Mcp-Param-* header (the typed verb's own).
  assert.ok(!modern.some((r) => r.method === 'GET' || r.method === 'DELETE'))
  assert.ok(!modern.some((r) => Object.keys(r.headers).some((h) => /^mcp-(param|session)/.test(h))))
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
  const mcp = await connectMcpServers(
    { wx: { url: server.url, protocol } },
    (level, message) => logs.push(`${level} ${message}`),
    'agent-test',
    undefined,
    undefined,
    undefined,
    { connectTimeoutMs: 5_000 },
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
      assert.equal(s.seen.boom, 'McpToolError: kaboom')
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
      // The "no" a 2025 server gives the probe is not reported as a broken transport.
      assert.deepEqual(
        s.logs.filter((l) => /^warn .*transport error/.test(l)),
        [],
      )
    })
  }
}

test('protocol: a value that is none of the three names fails that server, by name, before anything is sent', async () => {
  const server = await startLocalMcpServer({ protocol: 'dual' })
  try {
    const mcp = await connectMcpServers(
      {
        bad: { url: server.url, protocol: '2026-07-28' as never },
        good: { url: server.url },
      },
      () => {},
      'agent-test',
    )
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

test('mcpProtocolMode / mcpVersionNegotiation: the option as the SDK gets it', () => {
  assert.equal(mcpProtocolMode(undefined, 's'), 'legacy')
  assert.equal(mcpProtocolMode(null, 's'), 'legacy')
  assert.equal(mcpProtocolMode('auto', 's'), 'auto')
  assert.equal(mcpProtocolMode('modern', 's'), 'modern')
  for (const bad of ['', 'Modern', 'latest', 1, true, {}, { pin: '2026-07-28' }]) {
    assert.throws(() => mcpProtocolMode(bad, 's'), /MCP server "s": protocol must be/)
  }
  // 'legacy' is NOT `{ mode: 'legacy' }`: the option is left out, as it always was.
  assert.equal(mcpVersionNegotiation('legacy'), undefined)
  assert.equal(mcpVersionNegotiation('legacy', 5_000), undefined)
  assert.deepEqual(mcpVersionNegotiation('auto'), { mode: 'auto' })
  assert.deepEqual(mcpVersionNegotiation('modern'), { mode: { pin: '2026-07-28' } })
  assert.deepEqual(mcpVersionNegotiation('auto', 1_500), {
    mode: 'auto',
    probe: { timeoutMs: 1_500 },
  })
  for (const none of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(mcpVersionNegotiation('auto', none), { mode: 'auto' })
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
      const mcp = await connectMcpServers(
        { wx: { url: server.url, protocol: 'auto' } },
        () => {},
        'agent-test',
      )
      assert.equal(mcp.results[0].connected, false, fault)
      assert.match(mcp.results[0].error ?? '', expected)
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
    const mcp = await connectMcpServers(
      { wx: { url: server.url, protocol } },
      (level, message) => logs.push(`${level} ${message}`),
      'agent-test',
      undefined,
      (name) => changed.push(name),
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
    const silent = await connectMcpServers(
      { wx: { url: server.url, protocol: 'modern' } },
      () => {},
      'agent-test',
    )
    assert.deepEqual(
      server.requests.map((r) => r.method),
      ['server/discover', 'tools/list'],
    )
    assert.equal(server.changeListeners(), 0)
    await silent.close()

    const logs: string[] = []
    const mcp = await connectMcpServers(
      { wx: { url: server.url, protocol: 'modern' } },
      (level, message) => logs.push(`${level} ${message}`),
      'agent-test',
      undefined,
      () => {},
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

// ── 2026-07-28: input_required ─────────────────────────────────────────────

test('2026-07-28: an input_required result is a clear tool error, and the call is made once', async () => {
  const server = await startLocalMcpServer({ protocol: 'modern', elicitationTools: true })
  // A server that asks although this client declared no elicitation capability.
  server.elicitationFaults.undeclaredMode = true
  const mcp = await connectMcpServers(
    { wx: { url: server.url, protocol: 'modern' } },
    () => {},
    'agent-test',
  )
  try {
    for (const tool of ['elicit_form', 'elicit_twice', 'elicit_state']) {
      await assert.rejects(
        () => callTool(mcp.tools, `wx__${tool}`),
        (err: unknown) => {
          assert.equal((err as Error).name, 'McpToolError')
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
  const mcp = await connectMcpServers(
    { wx: { url: server.url, protocol: 'modern' } },
    () => {},
    'agent-test',
  )
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
      const provider = createNodeOAuthProvider({
        serverUrl: server.url,
        redirectUrl: 'http://127.0.0.1:9999/callback',
        store: new MemoryOAuthStore(),
      })
      const connect = () =>
        connectMcpServers(
          { wx: { url: server.url, authProvider: provider, protocol } },
          () => {},
          'agent-test',
        )
      // The probe is the first request the server refuses: the 401 starts the
      // authorization exactly as a refused `initialize` does.
      const first = await connect()
      assert.deepEqual(first.results, [
        {
          name: 'wx',
          connected: false,
          error: first.results[0].error,
          needsAuthorization: true,
        },
      ])
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

// ── the CLI's MCP_SERVERS ──────────────────────────────────────────────────

test('MCP_SERVERS: protocol flows through for url and command entries, and a wrong value is refused by name', () => {
  const saved = { ...process.env }
  try {
    process.env.AGENT_PROVIDER_TYPE = 'openai'
    process.env.AGENT_API_KEY = 'k'
    process.env.AGENT_MODEL = 'm'
    process.env.MCP_SERVERS = JSON.stringify({
      a: { url: 'https://a.example.test/mcp', protocol: 'auto' },
      b: { command: '/bin/b', protocol: 'modern' },
      c: { url: 'https://c.example.test/mcp' },
    })
    const servers = loadConfig().mcpServers
    assert.equal(servers.a.protocol, 'auto')
    assert.equal(servers.b.protocol, 'modern')
    assert.ok(!('protocol' in servers.c), 'left out when not given')
    process.env.MCP_SERVERS = JSON.stringify({
      a: { url: 'https://a.example.test/mcp', protocol: 'new' },
    })
    assert.throws(
      () => loadConfig(),
      /MCP server "MCP_SERVERS.a": protocol must be 'legacy', 'auto' or 'modern'/,
    )
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key]
    }
    Object.assign(process.env, saved)
  }
})

// ── stdio ───────────────────────────────────────────────────────────────────

const CHATTY_MCP = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/chatty-mcp.mjs',
)

test('stdio: lines on stdout that are not JSON-RPC do not break the session; env is added, not replaced', async () => {
  const logs: string[] = []
  const mcp = await connectMcpServers(
    {
      local: {
        command: process.execPath,
        args: [CHATTY_MCP],
        env: { CHATTY_EXTRA: 'from-config' },
      },
    },
    (level, message) => logs.push(`${level} ${message}`),
    'agent-test',
  )
  try {
    assert.deepEqual(mcp.results, [{ name: 'local', connected: true }])
    assert.deepEqual(Object.keys(mcp.tools), ['local__env'])
    const env = JSON.parse(
      String(await callTool(mcp.tools, 'local__env', { names: ['CHATTY_EXTRA', 'PATH'] })),
    ) as Record<string, string | null>
    assert.equal(env.CHATTY_EXTRA, 'from-config')
    assert.equal(env.PATH, process.env.PATH, 'the inherited environment is still there')
    // The 2.x transport skips such lines (1.x reported each as a transport error).
    assert.deepEqual(
      logs.filter((l) => /transport error/.test(l)),
      [],
    )
  } finally {
    await mcp.close()
  }
})

/** One stdio session with the chatty fixture: `discover` is how it answers the version probe. */
const stdioSession = async (
  protocol: McpProtocolMode | undefined,
  discover?: 'silent' | 'modern',
  connectTimeoutMs?: number,
) => {
  const starts = path.join(mkdtempSync(path.join(os.tmpdir(), 'chatty-')), 'starts')
  const logs: string[] = []
  const began = Date.now()
  const mcp = await connectMcpServers(
    {
      local: {
        command: process.execPath,
        args: [CHATTY_MCP],
        env: { CHATTY_STARTS: starts, ...(discover ? { CHATTY_DISCOVER: discover } : {}) },
        ...(protocol ? { protocol } : {}),
        ...(connectTimeoutMs ? { connectTimeoutMs } : {}),
      },
    },
    (level, message) => logs.push(`${level} ${message}`),
    'agent-test',
    undefined,
    () => {},
  )
  const connectMs = Date.now() - began
  try {
    const env = mcp.results[0].connected
      ? (JSON.parse(String(await callTool(mcp.tools, 'local__env', { names: ['PATH'] }))) as {
          PATH: string
        })
      : undefined
    await mcp.close()
    let processes = 0
    try {
      processes = readFileSync(starts, 'utf8').split('\n').filter(Boolean).length
    } catch {
      // never started
    }
    return { result: mcp.results[0], protocols: mcp.protocols, env, processes, connectMs, logs }
  } finally {
    await mcp.close()
  }
}

test('stdio, protocol unset: one process, the 2025 handshake', async () => {
  const s = await stdioSession(undefined)
  assert.deepEqual(s.result, { name: 'local', connected: true })
  assert.deepEqual(s.protocols, [{ server: 'local', version: '2025-11-25', era: 'legacy' }])
  assert.equal(s.processes, 1)
})

test("stdio, protocol 'auto' against a 2025 server: asked on a second process, then the 2025 handshake", async () => {
  const s = await stdioSession('auto')
  assert.deepEqual(s.result, { name: 'local', connected: true })
  assert.deepEqual(s.protocols, [{ server: 'local', version: '2025-11-25', era: 'legacy' }])
  assert.equal(s.env?.PATH, process.env.PATH, 'the session process works, environment and all')
  assert.equal(s.processes, 2, 'the command ran twice: the probe, then the session')
})

test("stdio, protocol 'auto' against a 2025 server that ignores the probe: the 2025 handshake after a bounded wait", async () => {
  // The bound is half the connect budget (at most MCP_STDIO_PROBE_TIMEOUT_MS):
  // the SDK's own default, a minute, would outlast the connect timeout.
  const s = await stdioSession('auto', 'silent', 2_000)
  assert.deepEqual(s.result, { name: 'local', connected: true })
  assert.deepEqual(s.protocols, [{ server: 'local', version: '2025-11-25', era: 'legacy' }])
  assert.ok(s.connectMs >= 900 && s.connectMs < 1_900, `waited about a second (${s.connectMs} ms)`)
})

test("stdio, protocol 'modern' against a 2025 server: a clear error, and the session process is never started", async () => {
  const s = await stdioSession('modern')
  assert.equal(s.result.connected, false)
  assert.match(
    s.result.error ?? '',
    /did not offer pinned protocol version 2026-07-28 .* - protocol: 'modern' accepts only/,
  )
  assert.ok(s.connectMs < 2_000)
  assert.equal(s.processes, 1, 'only the probe ran')
})

test('stdio, 2026-07-28: auto and modern connect to a server that offers it; unset is refused by it', async () => {
  for (const protocol of ['auto', 'modern'] as const) {
    const s = await stdioSession(protocol, 'modern')
    assert.deepEqual(s.result, { name: 'local', connected: true }, protocol)
    assert.deepEqual(s.protocols, [{ server: 'local', version: '2026-07-28', era: 'modern' }])
    assert.equal(s.env?.PATH, process.env.PATH)
    assert.equal(s.processes, 2)
    // This server does not advertise `tools.listChanged`: no listen stream is
    // asked of it (it would answer "method not found"), and that is said.
    assert.deepEqual(
      s.logs.filter((l) => /tool list change/.test(l)),
      ['info [mcp] local: the server does not announce tool list changes'],
    )
  }
  const unset = await stdioSession(undefined, 'modern')
  assert.equal(unset.result.connected, false)
  assert.match(unset.result.error ?? '', /Unsupported protocol version/)
})
