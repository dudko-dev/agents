import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import {
  REPORT_VALUE,
  startLocalMcpServer,
  type ILocalMcpServer,
  type McpProtocol,
} from '@dudko.dev/test-servers'
import { connectMcpServers } from '../src/mcp.ts'

// The connector on the 2.x SDK client, against REAL servers over real sockets
// (`@dudko.dev/test-servers`: the 1.x server SDK behind `legacy`, the 2.x one
// behind `modern`, both behind `dual`) and a real child process over stdio.
//
// The client negotiates the 2025 revisions only (`versionNegotiation` is left
// at the SDK's default, 'legacy'): a server that also speaks 2026-07-28 must
// make no difference, and one that speaks nothing else must fail clearly.

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
  // Opting into 2026-07-28 is a later change. Until then this is what a server
  // that dropped the 2025 revisions looks like: a failed connect that says why.
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
