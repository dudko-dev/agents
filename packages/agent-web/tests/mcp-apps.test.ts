import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import {
  startLocalMcpServer,
  TRAVEL_APP_URI,
  TRAVEL_BAD_APP_URI,
  TRAVEL_FLIGHTS,
  type ILocalMcpServer,
} from '@dudko.dev/test-servers'
import {
  createAgent,
  defineTool,
  ToolDeniedError,
  type Agent,
  type AgentEvent,
  type AppToolCallRequest,
  type BrowserAgentConfig,
  type RunSnapshot,
  type ToolApprovalRequest,
} from '../dist/index.js'
import {
  connectMcpHttp,
  isMcpAppMimeType,
  isMcpAppUri,
  MCP_APP_MAX_DOMAINS,
  MCP_APP_MAX_HTML_CHARS,
  MCP_APP_MAX_RESULT_CHARS,
  MCP_APP_MAX_DOWNLOAD_BYTES,
  McpAppResourceError,
  mcpAppCspOf,
  mcpAppDownloadOf,
  mcpAppsModeOf,
  mcpAppOrigin,
  mcpAppPermissionsOf,
  mcpAppResourceOf,
  mcpAppToolMeta,
  mcpAppToolResultOf,
  type ConnectedMcp,
  type ConnectMcpOptions,
  type McpElicitationRequest,
} from '../dist/mcp.js'
import { captureMcpWire, type IWireRequest } from './helpers/mcp-wire.ts'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// MCP Apps (`apps: true`, the `io.modelcontextprotocol/ui` extension) in the browser connector
// and the agent: the guards on what a server declares (pure, in `src/mcp/apps.ts`), the
// connector against the REAL test server over real sockets in both revisions, and the agent's
// consent gate for the calls an app asks for. Every guard here is a security boundary: each has
// a test, and each needs a mutation check (docs/security.md, "MCP Apps").

type Era = 'legacy' | 'modern'
const ERAS: Era[] = ['legacy', 'modern']
const EXTENSION = 'io.modelcontextprotocol/ui'

// ── the guards, pure ─────────────────────────────────────────────────────────

test('guard: a tool declares its app as a ui:// URI and nothing else; nested meta wins', () => {
  assert.deepEqual(mcpAppToolMeta({ _meta: { ui: { resourceUri: 'ui://a/b.html' } } }), {
    resourceUri: 'ui://a/b.html',
    visibility: ['model', 'app'],
  })
  // The deprecated flat key still works, and loses to the nested one.
  assert.equal(
    mcpAppToolMeta({ _meta: { 'ui/resourceUri': 'ui://flat' } }).resourceUri,
    'ui://flat',
  )
  assert.equal(
    mcpAppToolMeta({ _meta: { ui: { resourceUri: 'ui://nested' }, 'ui/resourceUri': 'ui://flat' } })
      .resourceUri,
    'ui://nested',
  )
  for (const bad of [
    'https://evil.test/app.html',
    'ui://',
    'UI://upper',
    `ui://${'x'.repeat(3000)}`,
    'ui://a\nb',
    42,
    { uri: 'ui://x' },
  ]) {
    const meta = mcpAppToolMeta({ _meta: { ui: { resourceUri: bad } } })
    assert.equal(meta.resourceUri, undefined, `accepted ${String(bad).slice(0, 40)}`)
    assert.ok(meta.refusedUri !== undefined)
  }
  assert.equal(isMcpAppUri('ui://ok'), true)
  assert.deepEqual(mcpAppToolMeta({}), { visibility: ['model', 'app'] })
})

test('guard: visibility - who may call a tool; unknown entries dropped, nothing known = default', () => {
  const vis = (v: unknown) => mcpAppToolMeta({ _meta: { ui: { visibility: v } } }).visibility
  assert.deepEqual(vis(['app']), ['app'])
  assert.deepEqual(vis(['model']), ['model'])
  assert.deepEqual(vis(['app', 'app', 'model', 'admin']), ['app', 'model'])
  assert.deepEqual(vis(['admin']), ['model', 'app'])
  assert.deepEqual(vis('app'), ['model', 'app'])
})

test('guard: the MIME type is the extension one - text/html with profile=mcp-app, charset at most', () => {
  for (const ok of [
    'text/html;profile=mcp-app',
    'text/html; profile=mcp-app',
    'TEXT/HTML;PROFILE=MCP-APP',
    'text/html;profile="mcp-app"',
    'text/html;profile=mcp-app;charset=utf-8',
  ]) {
    assert.equal(isMcpAppMimeType(ok), true, ok)
  }
  for (const bad of [
    'text/html',
    'text/plain;profile=mcp-app',
    'text/html;profile=other',
    'text/html;profile=mcp-app;x=1',
    'text/html;profile=mcp-app;charset=latin1',
    'application/xhtml+xml;profile=mcp-app',
    undefined,
    42,
  ]) {
    assert.equal(isMcpAppMimeType(bad), false, String(bad))
  }
})

test('guard: a CSP entry is an origin or nothing - no keyword, scheme, path, wildcard or separator', () => {
  for (const [entry, kept] of [
    ['https://api.example.com', 'https://api.example.com'],
    ['HTTPS://API.Example.com/', 'https://api.example.com'],
    ['https://api.example.com:8443', 'https://api.example.com:8443'],
    ['wss://live.example.com', 'wss://live.example.com'],
    ['https://*.example.com', 'https://*.example.com'],
    ['http://127.0.0.1:4000', 'http://127.0.0.1:4000'],
    ['http://localhost', 'http://localhost'],
    ['ws://[::1]:9', 'ws://[::1]:9'],
  ] as const) {
    assert.equal(mcpAppOrigin(entry), kept, entry)
  }
  for (const entry of [
    '*',
    'https:',
    'https://*',
    'https://*.com',
    "'unsafe-eval'",
    "'self'",
    'data:',
    'blob:',
    'http://api.example.com',
    'ws://api.example.com',
    'https://api.example.com/path',
    'https://api.example.com?q=1',
    'https://ok.example; script-src *',
    'https://ok.example script-src',
    'https://a.example,https://b.example',
    'javascript:alert(1)',
    'https://user@api.example.com',
    42,
  ]) {
    assert.equal(mcpAppOrigin(entry), undefined, String(entry))
  }
  const many = Array.from({ length: MCP_APP_MAX_DOMAINS + 5 }, (_, i) => `https://h${i}.example`)
  const { csp, refused } = mcpAppCspOf({
    connectDomains: [...many, 'https://ok.example; script-src *'],
    resourceDomains: 'https://not-a-list.example',
    frameDomains: ['https://player.example'],
  })
  assert.equal(csp.connectDomains.length, MCP_APP_MAX_DOMAINS)
  assert.equal(refused.length, 6)
  assert.deepEqual(csp.resourceDomains, [])
  assert.deepEqual(csp.frameDomains, ['https://player.example'])
  assert.deepEqual(csp.baseUriDomains, [])
  assert.deepEqual(mcpAppCspOf(undefined).csp, {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  })
})

test('guard: permissions - the four the specification names, as asked; nothing else', () => {
  assert.deepEqual(
    mcpAppPermissionsOf({ camera: {}, microphone: true, clipboardWrite: {}, usb: {} }),
    { camera: true, clipboardWrite: true },
  )
  assert.deepEqual(mcpAppPermissionsOf('camera'), {})
})

test('guard: a resources/read answer - the URI asked for, the MIME type, the size; text or base64', () => {
  const uri = 'ui://s/app.html'
  const entry = (patch: Record<string, unknown> = {}) => ({
    contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<p>app</p>', ...patch }],
  })
  const ok = mcpAppResourceOf('s', uri, entry({ _meta: { ui: { prefersBorder: false } } }))
  assert.equal(ok.html, '<p>app</p>')
  assert.equal(ok.server, 's')
  assert.equal(ok.prefersBorder, false)
  const throws = (result: unknown, pattern: RegExp, max?: number) =>
    assert.throws(
      () => mcpAppResourceOf('s', uri, result, max),
      (err: unknown) => err instanceof McpAppResourceError && pattern.test(err.message),
    )
  throws(
    { contents: [{ uri: 'ui://s/other.html', mimeType: 'text/html;profile=mcp-app', text: 'x' }] },
    /does not contain/,
  )
  throws(entry({ mimeType: 'text/html' }), /not an MCP App/)
  throws(entry({ text: 'x'.repeat(101) }), /larger than 100/, 100)
  throws(entry({ text: undefined }), /neither text nor blob/)
  throws(entry({ text: undefined, blob: '%%% not base64' }), /not base64/)
  throws({ contents: 'nope' }, /does not contain/)
  // Base64, decoded as UTF-8 - and capped before AND after decoding.
  const html = '<p>blob ✓</p>'
  const blob = Buffer.from(html, 'utf8').toString('base64')
  assert.equal(mcpAppResourceOf('s', uri, entry({ text: undefined, blob })).html, html)
  throws(
    entry({ text: undefined, blob: Buffer.from('y'.repeat(200)).toString('base64') }),
    /larger/,
    100,
  )
  assert.equal(MCP_APP_MAX_HTML_CHARS, 2_000_000)
})

test('guard: what of a result an app is given - the four keys, capped', () => {
  assert.deepEqual(
    mcpAppToolResultOf({
      content: [{ type: 'text', text: 'hi' }],
      structuredContent: { a: 1 },
      isError: false,
      _meta: { t: 1 },
      extra: 'dropped',
    }),
    { content: [{ type: 'text', text: 'hi' }], structuredContent: { a: 1 }, _meta: { t: 1 } },
  )
  assert.deepEqual(mcpAppToolResultOf({ isError: true }), { isError: true })
  assert.equal(mcpAppToolResultOf({ content: [{ text: 'x'.repeat(200) }] }, 100), undefined)
  assert.equal(mcpAppToolResultOf('text'), undefined)
  assert.equal(MCP_APP_MAX_RESULT_CHARS, 512_000)
})

// ── the connector, off ───────────────────────────────────────────────────────

const golden = (): IWireRequest[] =>
  JSON.parse(
    readFileSync(new URL('./fixtures/mcp-wire-without-protocol.json', import.meta.url), 'utf8'),
  ) as IWireRequest[]

const wireOf = (options: ConnectMcpOptions): Promise<IWireRequest[]> =>
  captureMcpWire((url, fetchFn) =>
    connectMcpHttp(
      { wx: { url, fetch: fetchFn } },
      { clientName: 'agent-web-test', onToolsChanged: () => {}, ...options },
    ),
  )

const sorted = (list: IWireRequest[]): string[] => list.map((r) => JSON.stringify(r)).sort()

test('off: without `apps` the wire is byte for byte what it was', async () => {
  assert.deepEqual(await wireOf({}), golden())
  assert.deepEqual(await wireOf({ apps: false }), golden())
})

test('on: the only difference on the 2025 wire is the declared extension', async () => {
  const expected = golden().map((request) => {
    const body = request.body as { method?: string; params?: { capabilities?: object } } | null
    if (body?.method !== 'initialize') return request
    return {
      ...request,
      body: {
        ...body,
        params: {
          ...body.params,
          capabilities: {
            ...body.params?.capabilities,
            extensions: { [EXTENSION]: { mimeTypes: ['text/html;profile=mcp-app'] } },
          },
        },
      },
    }
  })
  assert.deepEqual(sorted(await wireOf({ apps: true })), sorted(expected))
})

test('off: a server with apps is used as before - every tool mounted, no `_meta` read, no event', async () => {
  const server = await startLocalMcpServer({ appTools: true })
  const mcp = await connectMcpHttp({ wx: { url: server.url } })
  try {
    assert.equal(mcp.apps, undefined)
    assert.deepEqual(
      Object.keys(mcp.tools)
        .filter((k) => k.includes('flights'))
        .sort(),
      [
        'wx__flights_admin',
        'wx__flights_bad',
        'wx__flights_book',
        'wx__flights_refresh',
        'wx__flights_search',
      ],
    )
    assert.equal(
      mcp.catalog.some((c) => 'app' in c),
      false,
    )
    const events: unknown[] = []
    const run = { emit: (e: unknown) => events.push(e) }
    await (mcp.tools.wx__flights_search as { execute: Function }).execute(
      { from: 'LIS', to: 'VIE' },
      { agentRun: run },
    )
    assert.deepEqual(events, [])
    assert.equal(server.initializeCapabilities.at(-1)?.extensions, undefined)
  } finally {
    await mcp.close()
    await server.close()
  }
})

// ── the connector, on ────────────────────────────────────────────────────────

interface IRig {
  server: ILocalMcpServer
  mcp: ConnectedMcp
  logs: string[]
  reads: () => number
}

const withApps = async (
  era: Era,
  body: (rig: IRig) => Promise<void>,
  extra: { second?: boolean } = {},
): Promise<void> => {
  const server = await startLocalMcpServer({ protocol: era, appTools: true })
  const other = extra.second ? await startLocalMcpServer({ protocol: era }) : undefined
  const logs: string[] = []
  const mcp = await connectMcpHttp(
    {
      wx: { url: server.url, ...(era === 'modern' ? { protocol: 'modern' as const } : {}) },
      ...(other
        ? {
            other: { url: other.url, ...(era === 'modern' ? { protocol: 'modern' as const } : {}) },
          }
        : {}),
    },
    { apps: true, onLog: (level, message) => logs.push(`${level} ${message}`) },
  )
  try {
    await body({
      server,
      mcp,
      logs,
      reads: () => server.requests.filter((r) => r.method === 'resources/read').length,
    })
  } finally {
    await mcp.close()
    await server.close()
    await other?.close()
  }
}

for (const era of ERAS) {
  test(`${era}: on - an app-only tool is not mounted; the catalogue names each tool's app`, async () => {
    await withApps(era, async ({ server, mcp }) => {
      assert.deepEqual(
        Object.keys(mcp.tools)
          .filter((k) => k.includes('flights'))
          .sort(),
        ['wx__flights_admin', 'wx__flights_bad', 'wx__flights_book', 'wx__flights_search'],
      )
      const search = mcp.catalog.find((c) => c.name === 'wx__flights_search')
      assert.equal(search?.app, TRAVEL_APP_URI)
      assert.equal(mcp.catalog.find((c) => c.name === 'wx__echo')?.app, undefined)
      // What an app may call: listed, with 'app' in its visibility. By the server's own name.
      assert.deepEqual(mcp.apps?.appTool('wx', 'flights.refresh'), {
        name: 'flights.refresh',
        key: 'wx__flights_refresh',
        description: 'Fetch the flights again (for the app)',
        inputSchema: mcp.apps?.appTool('wx', 'flights.refresh')?.inputSchema,
        readOnly: true,
        visibility: ['app'],
        resourceUri: TRAVEL_APP_URI,
      })
      assert.equal(mcp.apps?.appTool('wx', 'flights.book')?.readOnly, false)
      assert.equal(mcp.apps?.appTool('wx', 'flights.book')?.key, 'wx__flights_book')
      assert.equal(mcp.apps?.appTool('wx', 'flights.admin'), undefined, 'model only')
      assert.equal(mcp.apps?.appTool('wx', 'nope'), undefined)
      assert.equal(mcp.apps?.appTool('other', 'flights.book'), undefined)
      if (era === 'legacy') {
        assert.deepEqual(server.initializeCapabilities.at(-1)?.extensions, {
          [EXTENSION]: { mimeTypes: ['text/html;profile=mcp-app'] },
        })
      }
    })
  })

  test(`${era}: on - a result of a tool with an app is told to the run; the model's result is unchanged`, async () => {
    await withApps(era, async ({ mcp }) => {
      const events: AgentEvent[] = []
      const step = { id: 's1', description: 'Step s1' }
      const out = await (mcp.tools.wx__flights_search as { execute: Function }).execute(
        { from: 'LIS', to: 'VIE' },
        { agentRun: { emit: (e: AgentEvent) => events.push(e), step } },
      )
      assert.equal(events.length, 1)
      const [event] = events as Extract<AgentEvent, { type: 'mcp.app' }>[]
      assert.equal(event.type, 'mcp.app')
      assert.match(event.id, /^mcp-app-/)
      assert.equal(event.server, 'wx')
      assert.equal(event.tool, 'wx__flights_search')
      assert.equal(event.toolName, 'flights.search')
      assert.equal(event.resourceUri, TRAVEL_APP_URI)
      assert.deepEqual(event.input, { from: 'LIS', to: 'VIE' })
      assert.deepEqual(event.result?.structuredContent, {
        route: { from: 'LIS', to: 'VIE', date: '2026-12-12' },
        flights: TRAVEL_FLIGHTS,
      })
      assert.deepEqual(event.step, step)
      // The HTML is in no event.
      assert.ok(!JSON.stringify(events).includes('<!doctype'), 'the app is not in the event')
      // The model's output is what it would be without apps: the structured value, once.
      const off = await connectMcpHttp({ wx: { url: (await withoutApps()).url } })
      try {
        const plain = await (off.tools.wx__flights_search as { execute: Function }).execute(
          { from: 'LIS', to: 'VIE' },
          {},
        )
        assert.deepEqual(out, plain)
      } finally {
        await off.close()
        await closeWithout()
      }
      // A tool without an app says nothing; a call outside a run (no emit) is not an error.
      await (mcp.tools.wx__echo as { execute: Function }).execute(
        { text: 'x' },
        { agentRun: { emit: (e: AgentEvent) => events.push(e) } },
      )
      await (mcp.tools.wx__flights_search as { execute: Function }).execute(
        { from: 'A', to: 'B' },
        {},
      )
      assert.equal(events.length, 1)
    })
  })

  test(`${era}: guard - an app is read from the server that declared it, once, checked`, async () => {
    await withApps(era, async ({ server, mcp, logs, reads }) => {
      const apps = mcp.apps!
      const app = await apps.readUiResource('wx', TRAVEL_APP_URI)
      assert.equal(app.server, 'wx')
      assert.equal(app.uri, TRAVEL_APP_URI)
      assert.match(app.html, /^<!doctype html>/)
      assert.deepEqual(app.csp.connectDomains, [])
      assert.deepEqual(app.permissions, { camera: true })
      assert.equal(app.prefersBorder, true)
      assert.equal(reads(), 1)
      // Cached per connection.
      assert.equal(await apps.readUiResource('wx', TRAVEL_APP_URI), app)
      assert.equal(reads(), 1)
      // The audit line names the policy, never the document.
      assert.ok(logs.some((l) => l.includes(`app ${TRAVEL_APP_URI} - connectDomains: none`)))
      assert.ok(logs.some((l) => l.includes('permissions asked (not granted): camera')))
      assert.ok(!logs.join('\n').includes('<!doctype'))

      // Only a URI a tool of THIS server declares - nothing is asked of the server otherwise.
      await assert.rejects(
        apps.readUiResource('wx', 'ui://travel/undeclared.html'),
        /declares the app/,
      )
      await assert.rejects(
        apps.readUiResource('wx', 'https://evil.test/app.html'),
        /declares the app/,
      )
      await assert.rejects(apps.readUiResource('nobody', TRAVEL_APP_URI), /not connected/)
      assert.equal(reads(), 1)

      // A declared resource that is not an app is refused, and not kept.
      await assert.rejects(apps.readUiResource('wx', TRAVEL_BAD_APP_URI), (err: unknown) =>
        err instanceof McpAppResourceError ? /not an MCP App/.test(err.message) : false,
      )
      assert.equal(reads(), 2)
      void server
    })
  })

  test(`${era}: guard - a resource from another server is never read through this one`, async () => {
    await withApps(
      era,
      async ({ mcp, reads }) => {
        // `other` declares no app; asking it for wx's app is refused before anything is sent.
        await assert.rejects(mcp.apps!.readUiResource('other', TRAVEL_APP_URI), /declares the app/)
        assert.equal(reads(), 0)
      },
      { second: true },
    )
  })

  test(`${era}: guard - a refused read (MIME, size, URI) is not cached; the next read asks again`, async () => {
    await withApps(era, async ({ server, mcp, reads }) => {
      const apps = mcp.apps!
      server.appFaults.mime = 'text/html'
      await assert.rejects(apps.readUiResource('wx', TRAVEL_APP_URI), /not an MCP App/)
      server.appFaults.mime = undefined
      server.appFaults.padTo = MCP_APP_MAX_HTML_CHARS + 10
      await assert.rejects(apps.readUiResource('wx', TRAVEL_APP_URI), /larger than/)
      server.appFaults.padTo = undefined
      server.appFaults.otherUri = true
      await assert.rejects(apps.readUiResource('wx', TRAVEL_APP_URI), /does not contain/)
      server.appFaults.otherUri = false
      server.appFaults.cspInjection = true
      const app = await apps.readUiResource('wx', TRAVEL_APP_URI)
      assert.deepEqual(app.csp.connectDomains, [])
      assert.deepEqual(app.refusedDomains, [
        'https://ok.example; script-src *',
        '*',
        "'unsafe-eval'",
        'data:',
        'https://*.com',
      ])
      assert.equal(reads(), 4)
    })
  })

  test(`${era}: guard - an app calls only its server's tools that let it (visibility 'app')`, async () => {
    await withApps(
      era,
      async ({ server, mcp }) => {
        const apps = mcp.apps!
        const booked = await apps.callAppTool('wx', 'flights.book', { flight: 'SL 418' })
        assert.deepEqual(booked.content, [{ type: 'text', text: 'booked:SL 418' }])
        assert.equal(booked.isError, undefined)
        const refreshed = await apps.callAppTool('wx', 'flights.refresh', {})
        assert.equal((refreshed.structuredContent?.flights as unknown[]).length, 3)
        const before = server.calls.length
        await assert.rejects(apps.callAppTool('wx', 'flights.admin', {}), /that an app may call/)
        await assert.rejects(apps.callAppTool('wx', 'nope', {}), /that an app may call/)
        // Another server's tool, by its key: not a tool of wx. (An app of `other` names
        // `other`: the bridge passes the app's own server, never one the app chooses.)
        await assert.rejects(apps.callAppTool('wx', 'other__echo', {}), /that an app may call/)
        await assert.rejects(
          apps.callAppTool('wx', 'flights.book', ['x'] as never),
          /must be an object/,
        )
        assert.equal(server.calls.length, before, 'a refused call never reaches the server')
        assert.deepEqual(
          server.calls.map((c) => c.name),
          ['flights.book', 'flights.refresh'],
        )
      },
      { second: true },
    )
  })
}

// ── apps per server: off for one, on for another ────────────────────────────

test('guard per server: the server’s own setting wins; false is "declined", not "unknown"', () => {
  assert.equal(mcpAppsModeOf(undefined, undefined), 'off')
  assert.equal(mcpAppsModeOf(undefined, false), 'off')
  assert.equal(mcpAppsModeOf(undefined, true), 'on')
  assert.equal(mcpAppsModeOf(true, undefined), 'on')
  assert.equal(mcpAppsModeOf(true, false), 'on')
  assert.equal(mcpAppsModeOf(false, true), 'declined')
  assert.equal(mcpAppsModeOf(false, undefined), 'declined')
})

const appRequests = (server: ILocalMcpServer) =>
  server.requests.filter((r) => r.method === 'resources/read').length

for (const era of ERAS) {
  test(`${era}: guard per server - apps off for one server: nothing declared or read, its app-only tools hidden, no event`, async () => {
    const off = await startLocalMcpServer({ protocol: era, appTools: true })
    const on = await startLocalMcpServer({ protocol: era, appTools: true })
    const protocol = era === 'modern' ? { protocol: 'modern' as const } : {}
    const mcp = await connectMcpHttp(
      { off: { url: off.url, apps: false, ...protocol }, on: { url: on.url, ...protocol } },
      { apps: true },
    )
    try {
      const keys = Object.keys(mcp.tools)
        .filter((k) => k.includes('flights'))
        .sort()
      // Declined: the app-only tool is mounted for nobody; the tool with an app is a plain tool.
      assert.deepEqual(
        keys.filter((k) => k.startsWith('off__')),
        ['off__flights_admin', 'off__flights_bad', 'off__flights_book', 'off__flights_search'],
      )
      assert.ok(!keys.includes('off__flights_refresh'))
      assert.equal(
        mcp.catalog.some((c) => c.server === 'off' && 'app' in c),
        false,
      )
      // The other server is untouched.
      assert.equal(mcp.catalog.find((c) => c.name === 'on__flights_search')?.app, TRAVEL_APP_URI)
      const apps = mcp.apps!
      assert.equal(apps.appTool('off', 'flights.refresh'), undefined)
      assert.equal(apps.appTool('off', 'flights.book'), undefined)
      assert.ok(apps.appTool('on', 'flights.refresh'))
      // No event: no frame is drawn for it.
      const events: unknown[] = []
      await (mcp.tools.off__flights_search as { execute: Function }).execute(
        { from: 'LIS', to: 'VIE' },
        { agentRun: { emit: (e: unknown) => events.push(e) } },
      )
      assert.deepEqual(events, [])
      // Nothing of it is read or called for an app - refused before anything is sent.
      await assert.rejects(apps.readUiResource('off', TRAVEL_APP_URI), /declares the app/)
      await assert.rejects(apps.readResource('off', TRAVEL_BAD_APP_URI), /off for the MCP server/)
      const before = off.calls.length
      await assert.rejects(apps.callAppTool('off', 'flights.refresh', {}), /that an app may call/)
      assert.equal(off.calls.length, before)
      assert.equal(appRequests(off), 0)
      if (era === 'legacy') {
        // Not told of apps at all; the other one is.
        assert.equal(off.initializeCapabilities.at(-1)?.extensions, undefined)
        assert.deepEqual(on.initializeCapabilities.at(-1)?.extensions, {
          [EXTENSION]: { mimeTypes: ['text/html;profile=mcp-app'] },
        })
      }
    } finally {
      await mcp.close()
      await off.close()
      await on.close()
    }
  })
}

test('per server: apps: true turns them on for that server alone; the connection stays off', async () => {
  const one = await startLocalMcpServer({ appTools: true })
  const two = await startLocalMcpServer({ appTools: true })
  const mcp = await connectMcpHttp({ one: { url: one.url, apps: true }, two: { url: two.url } })
  try {
    assert.equal(mcp.catalog.find((c) => c.name === 'one__flights_search')?.app, TRAVEL_APP_URI)
    assert.ok(!Object.keys(mcp.tools).includes('one__flights_refresh'))
    // The other: as before the extension - every tool mounted, nothing read.
    assert.ok(Object.keys(mcp.tools).includes('two__flights_refresh'))
    assert.equal(mcp.apps?.appTool('two', 'flights.book'), undefined)
    assert.ok(mcp.apps?.appTool('one', 'flights.book'))
    assert.equal(two.initializeCapabilities.at(-1)?.extensions, undefined)
  } finally {
    await mcp.close()
    await one.close()
    await two.close()
  }
})

// ── a file an app asks to save: a resource of ITS server, read through the connection ────────

test('guard download read: the exact URI, text as UTF-8 or base64, capped; any type', () => {
  const answer = (entry: Record<string, unknown>) => ({ contents: [entry] })
  const text = mcpAppDownloadOf(
    'file:///a.txt',
    answer({ uri: 'file:///a.txt', mimeType: 'text/plain', text: 'Olá' }),
  )
  assert.deepEqual([text.mimeType, [...text.bytes]], ['text/plain', [79, 108, 195, 161]])
  const blob = mcpAppDownloadOf('file:///b', answer({ uri: 'file:///b', blob: 'AAEC' }))
  assert.deepEqual([blob.mimeType, [...blob.bytes]], [undefined, [0, 1, 2]])
  assert.throws(
    () => mcpAppDownloadOf('file:///a', answer({ uri: 'file:///other', text: 'x' })),
    /does not contain/,
  )
  assert.throws(
    () => mcpAppDownloadOf('file:///a', answer({ uri: 'file:///a' })),
    /neither text nor blob/,
  )
  assert.throws(
    () => mcpAppDownloadOf('file:///a', answer({ uri: 'file:///a', blob: '!!' })),
    /not base64/,
  )
  assert.throws(
    () => mcpAppDownloadOf('file:///a', answer({ uri: 'file:///a', text: 'x'.repeat(11) }), 10),
    /larger than 10 bytes/,
  )
  // Three bytes a character: a text of 4 characters is 12 bytes.
  assert.throws(
    () => mcpAppDownloadOf('file:///a', answer({ uri: 'file:///a', text: '€€€€' }), 10),
    /larger than/,
  )
  assert.throws(
    () => mcpAppDownloadOf('file:///a', answer({ uri: 'file:///a', blob: 'A'.repeat(40) }), 10),
    /larger than/,
  )
  assert.equal(MCP_APP_MAX_DOWNLOAD_BYTES, 20 * 1024 * 1024)
})

for (const era of ERAS) {
  test(`${era}: guard download read - resources/read on the app's own server, never another; bad URIs never sent`, async () => {
    await withApps(
      era,
      async ({ server, mcp, reads }) => {
        const apps = mcp.apps!
        const file = await apps.readResource('wx', TRAVEL_BAD_APP_URI)
        assert.equal(file.uri, TRAVEL_BAD_APP_URI)
        assert.equal(file.mimeType, 'text/html')
        assert.equal(new TextDecoder().decode(file.bytes), '<p>not an app</p>')
        assert.equal(reads(), 1)
        // Not cached: a download is read when it is asked for.
        await apps.readResource('wx', TRAVEL_BAD_APP_URI)
        assert.equal(reads(), 2)
        await assert.rejects(
          apps.readResource('wx', TRAVEL_BAD_APP_URI, { maxBytes: 5 }),
          /larger than 5 bytes/,
        )
        assert.equal(reads(), 3)
        for (const bad of ['', 'ui://a b', 'ui://a\nb', `ui://${'x'.repeat(2050)}`, 42]) {
          await assert.rejects(apps.readResource('wx', bad as string), /one line/)
        }
        // Through another server, it is THAT server that is asked (it has no such resource):
        // never wx.
        await assert.rejects(apps.readResource('other', TRAVEL_BAD_APP_URI))
        await assert.rejects(apps.readResource('nobody', TRAVEL_BAD_APP_URI), /not connected/)
        assert.equal(reads(), 3)
        void server
      },
      { second: true },
    )
  })
}

let without: ILocalMcpServer | undefined
const withoutApps = async (): Promise<ILocalMcpServer> => {
  without = await startLocalMcpServer({ appTools: true })
  return without
}
const closeWithout = async (): Promise<void> => {
  await without?.close()
  without = undefined
}

// ── the agent: a whole run, and the consent gate for an app's calls ─────────

const planJson = JSON.stringify({ thought: 'Plan.', steps: [{ description: 'Step s1' }] })

const actor =
  (calls: { name: string; args: unknown }[]) =>
  (info: CallInfo): Reply => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: planJson }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'finish', reason: 'done' }) }
      case 'synthesizer':
        return { text: 'All done.' }
      default:
        return info.toolResults === 0 && calls.length ? { toolCalls: calls } : { text: 'done' }
    }
  }

const agentWith = async (
  mcp: ConnectedMcp,
  model: ReturnType<typeof scriptedModel>,
  config: Partial<BrowserAgentConfig> = {},
): Promise<Agent> =>
  createAgent({ model: model.model, toolMode: 'native', tools: mcp.tools, ...config })

test('agent: a run carries the mcp.app event; the app is in no prompt, event or checkpoint', async () => {
  await withApps('legacy', async ({ mcp }) => {
    const model = scriptedModel(
      actor([{ name: 'wx__flights_search', args: { from: 'LIS', to: 'VIE' } }]),
    )
    const snapshots: RunSnapshot[] = []
    const keep = (s: RunSnapshot): void => {
      snapshots.push(JSON.parse(JSON.stringify(s)) as RunSnapshot)
    }
    const agent = await agentWith(mcp, model, {
      persistence: { onRunStart: keep, onStepComplete: keep, onRunComplete: keep },
    })
    // The app is read by the host, as a UI would - it must still reach nothing of the agent's.
    const app = await mcp.apps!.readUiResource('wx', TRAVEL_APP_URI)
    const events: AgentEvent[] = []
    await agent.run('Find flights', { onEvent: (e) => events.push(e) })
    const apps = events.filter((e) => e.type === 'mcp.app')
    assert.equal(apps.length, 1)
    assert.equal((apps[0] as { step?: { id: string } }).step?.id !== undefined, true)
    const marker = app.html.slice(0, 200)
    const prompts = JSON.stringify(model.calls.map((c) => c.options.prompt))
    assert.ok(!prompts.includes('<!doctype'), 'the app reached a prompt')
    assert.ok(!prompts.includes(marker))
    assert.ok(!JSON.stringify(events).includes('<!doctype'), 'the app is in an event')
    assert.ok(snapshots.length > 0)
    assert.ok(!JSON.stringify(snapshots).includes('<!doctype'), 'the app is in a checkpoint')
  })
})

const bookCall = (patch: Partial<AppToolCallRequest> = {}): AppToolCallRequest => ({
  tool: 'wx__flights_book',
  toolName: 'flights.book',
  server: 'wx',
  resourceUri: TRAVEL_APP_URI,
  input: { flight: 'SL 418' },
  readOnly: false,
  ...patch,
})

const gateRig = async (config: Partial<BrowserAgentConfig>) => {
  const asked: ToolApprovalRequest[] = []
  let answer: (
    req: ToolApprovalRequest,
  ) => boolean | { approved: boolean; remember?: boolean } = () => true
  const model = scriptedModel(actor([]))
  const agent = await createAgent({
    model: model.model,
    toolMode: 'native',
    ...config,
    toolApproval: {
      ...config.toolApproval,
      onRequest: (req) => {
        asked.push(req)
        return answer(req)
      },
    },
  })
  return {
    agent,
    asked,
    answer: (fn: typeof answer) => {
      answer = fn
    },
  }
}

test('agent: guard - an app never writes silently, even when the agent runs on autopilot', async () => {
  const rig = await gateRig({ toolApproval: { mode: 'autopilot' } })
  const events: AgentEvent[] = []
  // A read-only tool of its server: through, as in 'ask-writes'.
  await rig.agent.approveAppToolCall(
    bookCall({ readOnly: true, tool: 'wx__flights_refresh' }),
    (e) => events.push(e),
  )
  assert.equal(rig.asked.length, 0)
  // A write asks - and the request says it is the app's.
  await rig.agent.approveAppToolCall(bookCall(), (e) => events.push(e))
  assert.equal(rig.asked.length, 1)
  assert.deepEqual(rig.asked[0].app, {
    server: 'wx',
    tool: 'flights.book',
    resourceUri: TRAVEL_APP_URI,
  })
  assert.equal(rig.asked[0].toolName, 'wx__flights_book')
  const requested = events.find((e) => e.type === 'tool.approval-requested')
  assert.deepEqual((requested as { app?: unknown }).app, rig.asked[0].app)
  assert.ok(events.some((e) => e.type === 'tool.approval-resolved' && e.approved && !e.automatic))
  // Denied: the call may not go.
  rig.answer(() => false)
  await assert.rejects(rig.agent.approveAppToolCall(bookCall()), ToolDeniedError)
  // The agent's own mode is untouched.
  assert.equal(rig.agent.toolApprovalMode, 'autopilot')
})

test("agent: guard - the host's rules and modes apply to an app's calls", async () => {
  const ruled = await gateRig({
    toolApproval: {
      mode: 'ask-writes',
      rules: { wx__flights_book: 'deny', wx__flights_refresh: 'ask' },
    },
  })
  const events: AgentEvent[] = []
  await assert.rejects(
    ruled.agent.approveAppToolCall(bookCall(), (e) => events.push(e)),
    ToolDeniedError,
  )
  assert.equal(ruled.asked.length, 0)
  assert.ok(events.some((e) => e.type === 'tool.approval-resolved' && e.automatic && !e.approved))
  await ruled.agent.approveAppToolCall(bookCall({ tool: 'wx__flights_refresh', readOnly: true }))
  assert.equal(ruled.asked.length, 1, "a rule's 'ask' asks even for a read")

  const readOnly = await gateRig({ toolApproval: { mode: 'read-only' } })
  await assert.rejects(readOnly.agent.approveAppToolCall(bookCall()), ToolDeniedError)
  assert.equal(readOnly.asked.length, 0)

  const askAll = await gateRig({ toolApproval: { mode: 'ask-all' } })
  await askAll.agent.approveAppToolCall(bookCall({ readOnly: true }))
  assert.equal(askAll.asked.length, 1)

  const allowed = await gateRig({
    toolApproval: { mode: 'ask-writes', rules: { 'wx__*': 'allow' } },
  })
  await allowed.agent.approveAppToolCall(bookCall())
  assert.equal(allowed.asked.length, 0, "the host's explicit allow")
})

test("agent: guard - an app's \"always allow\" is the app's: it does not reach the model's calls", async () => {
  await withApps('legacy', async ({ mcp, server }) => {
    const asked: ToolApprovalRequest[] = []
    const model = scriptedModel(actor([{ name: 'wx__flights_book', args: { flight: 'TA 2207' } }]))
    const agent = await agentWith(mcp, model, {
      toolApproval: {
        mode: 'ask-writes',
        onRequest: (req) => {
          asked.push(req)
          return req.app ? { approved: true, remember: true } : false
        },
      },
    })
    await agent.approveAppToolCall(bookCall())
    await agent.approveAppToolCall(bookCall())
    assert.equal(asked.length, 1, 'remembered for the app')
    // The model's call of the same tool still asks (and is denied here): the grant was the app's.
    await agent.run('Book it')
    assert.equal(asked.length, 2)
    assert.equal(asked[1].app, undefined)
    assert.equal(asked[1].toolName, 'wx__flights_book')
    assert.equal(server.calls.length, 0)
  })
})

test('agent: guard - an app request waits for no stopped page: the signal ends it', async () => {
  const rig = await gateRig({ toolApproval: { mode: 'ask-writes' } })
  rig.answer(() => new Promise(() => {}) as never)
  const controller = new AbortController()
  const pending = rig.agent.approveAppToolCall(bookCall(), undefined, controller.signal)
  controller.abort()
  await assert.rejects(pending, ToolDeniedError)
})

// ── with elicitation, and the time a person takes ────────────────────────────

for (const era of ERAS) {
  test(`${era}: an app's call goes through the elicitation session - the question reaches the host, no run needed`, async () => {
    const server = await startLocalMcpServer({
      protocol: era,
      appTools: true,
      elicitationTools: true,
    })
    const asked: McpElicitationRequest[] = []
    const mcp = await connectMcpHttp(
      { wx: { url: server.url, ...(era === 'modern' ? { protocol: 'modern' as const } : {}) } },
      {
        apps: true,
        onElicitation: (request) => {
          asked.push(request)
          const fields = request.requestedSchema?.properties ?? {}
          return { action: 'accept', content: fields.name ? { name: 'Ada' } : { color: 'green' } }
        },
      },
    )
    try {
      // Both are declared, side by side (the 2025 handshake; on 2026-07-28 the same capability
      // object travels with each request).
      if (era === 'legacy') {
        const declared = server.initializeCapabilities.at(-1) as {
          extensions?: Record<string, unknown>
          elicitation?: unknown
        }
        assert.deepEqual(declared.extensions?.[EXTENSION], {
          mimeTypes: ['text/html;profile=mcp-app'],
        })
        assert.ok(declared.elicitation, 'elicitation declared next to the extension')
      }
      // A tool without `_meta.ui` has the default visibility: its app - any app of the server -
      // may call it. Called the way a UI calls it, after its consent: outside any run.
      const out = await mcp.apps!.callAppTool('wx', 'elicit_twice', {})
      assert.deepEqual(out.content, [
        {
          type: 'text',
          text: JSON.stringify({
            tool: 'elicit_twice',
            action: 'accept',
            name: 'Ada',
            color: 'green',
          }),
        },
      ])
      assert.equal(out.isError, undefined)
      assert.equal(asked.length, 2)
      assert.deepEqual(
        asked.map((r) => [r.server, r.tool, r.subagent ?? null]),
        [
          ['wx', 'wx__elicit_twice', null],
          ['wx', 'wx__elicit_twice', null],
        ],
      )
      assert.deepEqual(server.calls, [{ name: 'elicit_twice', args: {} }])
    } finally {
      await mcp.close()
      await server.close()
    }
  })
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })

/** A person who decides an app's request only when the test says so. */
const heldDecision = () => {
  let release: (approved: boolean) => void = () => {}
  const decided = new Promise<boolean>((resolve) => {
    release = resolve
  })
  return { decided, release: (approved = true) => release(approved) }
}

test("agent: an app's request waits outside the run's clock - the step's limit runs on", async () => {
  // The run is not waiting for the person an app asks: a step that hangs still ends at its
  // limit while the app's request - made while that step runs - is open, and the request is
  // decided after the run.
  const times = { startedAt: 0, endedAt: 0 }
  const held = heldDecision()
  const appEvents: AgentEvent[] = []
  let appCall: Promise<void> | undefined
  const model = scriptedModel(actor([{ name: 'hang', args: {} }]))
  const agent: Agent = await createAgent({
    model: model.model,
    toolMode: 'native',
    chatTimeoutMs: 300,
    tools: {
      hang: defineTool({
        description: 'Never returns',
        inputSchema: z.object({}),
        execute: async (_input, { abortSignal }) => {
          times.startedAt = Date.now()
          appCall ??= agent.approveAppToolCall(bookCall(), (e) => appEvents.push(e))
          await sleep(60_000, abortSignal).catch((err: unknown) => {
            times.endedAt = Date.now()
            throw err
          })
          return 'never'
        },
      }),
    },
    toolApproval: {
      mode: 'ask-writes',
      rules: { hang: 'allow' },
      onRequest: (req) => (req.app ? held.decided : true),
    },
  })
  const runEvents: AgentEvent[] = []
  await agent.run('Do the work', { onEvent: (e) => runEvents.push(e) })
  assert.ok(times.endedAt > 0, 'the step never ended')
  const took = times.endedAt - times.startedAt
  assert.ok(took < 1500, `the app's open request held the step's clock (${took} ms)`)
  // Each side has its own events: the app's request is not the run's.
  assert.equal(
    runEvents.some((e) => e.type === 'tool.approval-requested'),
    false,
  )
  assert.ok(appCall, 'the app never asked')
  held.release(true)
  await appCall
  assert.deepEqual(
    appEvents.map((e) => e.type),
    ['tool.approval-requested', 'tool.approval-resolved'],
  )
})

test("agent: the run's own wait still stops its clock while an app's request is open", async () => {
  // Both are with the person at once: the model's write (decided after longer than the step's
  // limit - the step must not end under it) and the app's (open all along). Deciding one never
  // starts the clock the other stopped, nor the reverse.
  const ran: string[] = []
  const held = heldDecision()
  let appCall: Promise<void> | undefined
  const model = scriptedModel(actor([{ name: 'save_note', args: { text: 'a' } }]))
  const agent: Agent = await createAgent({
    model: model.model,
    toolMode: 'native',
    chatTimeoutMs: 300,
    tools: {
      save_note: defineTool({
        description: 'Save a note',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => {
          ran.push(text)
          return `saved ${text}`
        },
      }),
    },
    toolApproval: {
      mode: 'ask-writes',
      onRequest: async (req) => {
        if (req.app) return held.decided
        // The app asks while the model's request is with the person.
        appCall ??= agent.approveAppToolCall(bookCall())
        await sleep(800)
        return true
      },
    },
  })
  const events: AgentEvent[] = []
  const result = await agent.run('Do the work', { onEvent: (e) => events.push(e) })
  assert.deepEqual(ran, ['a'], "the step ended under the run's own approval")
  assert.deepEqual(
    result.trace.flatMap((st) => st.toolCalls.map((c) => [c.name, c.ok])),
    [['save_note', true]],
  )
  assert.deepEqual(
    events.filter((e) => e.type === 'error'),
    [],
  )
  assert.ok(appCall, 'the app never asked')
  held.release(false)
  await assert.rejects(appCall, ToolDeniedError)
})
