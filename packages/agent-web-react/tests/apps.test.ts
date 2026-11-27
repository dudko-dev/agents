import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentEvent } from '@dudko.dev/agent-web'
import {
  agentStateReducer,
  APP_MAX_HEIGHT,
  APP_MIN_HEIGHT,
  appLinkOf,
  appMessageTextOf,
  AppRequestPrompt,
  buildMcpAppDocument,
  clampAppHeight,
  createInitialAgentState,
  defaultLabels,
  MCP_APP_MAX_ARGS_CHARS,
  MCP_APP_MAX_IN_FLIGHT,
  MCP_APP_MAX_MESSAGE_CHARS,
  MCP_APP_PROTOCOL_VERSION,
  MCP_APP_REFUSED,
  MCP_APP_RELAY,
  McpAppBridge,
  mcpAppCsp,
  McpAppFrame,
  mcpAppHostCapabilities,
  McpAppLine,
  McpAppRpcError,
  MessageList,
  ToolApprovalPrompt,
  type AgentAction,
  type AgentUiState,
  type AppLink,
  type AppView,
  type McpAppBridgeHandlers,
  type McpAppHost,
  type McpAppRpcMessage,
} from '../dist/index.js'

// MCP Apps on the host's side: the frame's policy and shell, the bridge (the extension's
// JSON-RPC, method by method), what the reducer keeps, and the parts as markup. A security
// boundary: every guard has a test named "guard …" here, and e2e/apps.spec.ts proves the same in
// a real browser against a real MCP server and a hostile app.

const event = (state: AgentUiState, e: AgentEvent): AgentUiState =>
  agentStateReducer(state, { type: 'event', event: e } as AgentAction)
const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node)

// ── the frame: policy and shell ─────────────────────────────────────────────

const directive = (policy: string, name: string): string =>
  policy
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? ''

test('guard csp: nothing declared, no network at all - and nothing a policy could be widened with', () => {
  const policy = mcpAppCsp()
  assert.equal(directive(policy, 'default-src'), "default-src 'none'")
  assert.equal(directive(policy, 'connect-src'), "connect-src 'none'")
  assert.equal(directive(policy, 'script-src'), "script-src 'unsafe-inline'")
  assert.equal(directive(policy, 'img-src'), 'img-src data: blob:')
  for (const name of [
    'frame-src',
    'child-src',
    'worker-src',
    'object-src',
    'form-action',
    'base-uri',
  ]) {
    assert.equal(directive(policy, name), `${name} 'none'`, name)
  }
  assert.doesNotMatch(policy, /https?:|\*|'self'|unsafe-eval/)
})

test('guard csp: declared origins and only them, each re-checked - an injected directive goes nowhere', () => {
  const policy = mcpAppCsp({
    connectDomains: [
      'https://api.example.com',
      'https://ok.example; script-src *',
      '*',
      "'unsafe-eval'",
    ],
    resourceDomains: ['https://cdn.example.com', 'data:', 'https://*.com'],
    frameDomains: ['https://player.example.com'],
    baseUriDomains: ['https://base.example.com'],
  })
  assert.equal(directive(policy, 'connect-src'), 'connect-src https://api.example.com')
  assert.equal(
    directive(policy, 'script-src'),
    "script-src 'unsafe-inline' https://cdn.example.com",
  )
  assert.equal(directive(policy, 'style-src'), "style-src 'unsafe-inline' https://cdn.example.com")
  assert.equal(directive(policy, 'font-src'), 'font-src data: https://cdn.example.com')
  // Frames and <base> are never granted: a frame the app may embed is a place it may go.
  assert.equal(directive(policy, 'frame-src'), "frame-src 'none'")
  assert.equal(directive(policy, 'base-uri'), "base-uri 'none'")
  assert.doesNotMatch(policy, /ok\.example|\*|unsafe-eval|player\.example|base\.example/)
  assert.equal(policy.split(';').length, mcpAppCsp().split(';').length, 'no directive was added')
  // What the app is told it was granted: the same lists.
  assert.deepEqual(
    mcpAppHostCapabilities({ connectDomains: ['https://api.example.com', '*'] }).sandbox,
    {
      permissions: {},
      csp: { connectDomains: ['https://api.example.com'], resourceDomains: [] },
    },
  )
})

const shellOf = (doc: string) => {
  const inner = /<iframe id="app" ([^>]*?) srcdoc="([^"]*)"><\/iframe>/.exec(doc)
  assert.ok(inner, 'the shell has one inner frame')
  return { attrs: inner[1], srcdoc: inner[2] }
}

test('guard shell: the policy first, one inner frame with scripts and nothing else, then the relay', () => {
  const doc = buildMcpAppDocument('<!doctype html><p>app</p>', {
    connectDomains: ['https://api.example.com'],
  })
  assert.match(
    doc,
    /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;|^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'/,
  )
  const { attrs, srcdoc } = shellOf(doc)
  // The shell's own policy is what stops the app navigating itself: frame-src 'none'.
  const shellPolicy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(doc)?.[1]
  assert.ok(shellPolicy?.includes("frame-src 'none'"), 'the shell forbids navigation')
  assert.ok(shellPolicy?.includes('connect-src https://api.example.com'))
  assert.equal(attrs, 'sandbox="allow-scripts" referrerpolicy="no-referrer"')
  assert.doesNotMatch(
    doc,
    /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals|allow-downloads/,
  )
  assert.doesNotMatch(doc, / allow="/, 'no permission is delegated (camera, microphone, …)')
  // The app's own document carries the same policy first (after its doctype).
  assert.ok(
    srcdoc.startsWith(
      '&lt;!doctype html&gt;&lt;meta http-equiv=&quot;Content-Security-Policy&quot;',
    ),
  )
  assert.ok(srcdoc.includes('connect-src https://api.example.com'))
  assert.ok(doc.endsWith(`<script>${MCP_APP_RELAY}</script></body></html>`))
})

test('guard escaping: an app cannot close its attribute and write into the shell', () => {
  const hostile = '"></iframe><script>parent.document.title="pwned"</script><iframe srcdoc="'
  const doc = buildMcpAppDocument(hostile)
  const { srcdoc } = shellOf(doc)
  assert.doesNotMatch(srcdoc, /["<>]/)
  assert.equal((doc.match(/<script>/g) ?? []).length, 1, 'only the relay is a script of the shell')
})

test('guard relay: by window, both ways, and never the reserved sandbox-* messages', () => {
  // The relay runs in the shell; play it with stand-ins for the two windows.
  const sent: { to: string; data: unknown }[] = []
  const inner = { postMessage: (data: unknown) => sent.push({ to: 'app', data }) }
  const parent = { postMessage: (data: unknown) => sent.push({ to: 'page', data }) }
  let listener: (e: { source: unknown; data: unknown }) => void = () => {}
  new Function('document', 'addEventListener', 'parent', MCP_APP_RELAY)(
    { getElementById: (id: string) => (id === 'app' ? { contentWindow: inner } : null) },
    (type: string, fn: typeof listener) => {
      if (type === 'message') listener = fn
    },
    parent,
  )
  const msg = { jsonrpc: '2.0', id: 1, method: 'ui/initialize' }
  listener({ source: inner, data: msg })
  listener({ source: parent, data: { jsonrpc: '2.0', id: 1, result: {} } })
  listener({ source: {}, data: msg }) // another window: nothing
  listener({
    source: inner,
    data: { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' },
  })
  listener({
    source: parent,
    data: {
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: { html: 'x' },
    },
  })
  assert.deepEqual(sent, [
    { to: 'page', data: msg },
    { to: 'app', data: { jsonrpc: '2.0', id: 1, result: {} } },
  ])
})

test('guard height: the app’s wish, clamped to the host’s bounds', () => {
  assert.equal(clampAppHeight(5000), APP_MAX_HEIGHT)
  assert.equal(clampAppHeight(10), APP_MIN_HEIGHT)
  assert.equal(clampAppHeight(Number.NaN), 360)
  assert.equal(clampAppHeight(432.4), 432)
  assert.equal(APP_MAX_HEIGHT, 800)
})

test('guard link: http(s), a host, no credentials, not too long - the host taken apart for the prompt', () => {
  assert.deepEqual(appLinkOf('https://example-air.test/checkout?offer=SL418'), {
    href: 'https://example-air.test/checkout?offer=SL418',
    scheme: 'https://',
    host: 'example-air.test',
    rest: '/checkout?offer=SL418',
  })
  // An internationalised name is shown as the browser will go there: punycode.
  assert.equal(appLinkOf('https://аpple.com/')?.host, 'xn--pple-43d.com')
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'blob:https://x.test/1',
    'file:///etc/passwd',
    'ftp://x.test/',
    'https://user:pass@x.test/',
    'https://x.test@evil.test/',
    'not a url',
    `https://x.test/${'a'.repeat(3000)}`,
    42,
  ]) {
    assert.equal(appLinkOf(bad), undefined, String(bad).slice(0, 40))
  }
})

test('guard message: user text only, cleaned of what cannot be seen, capped', () => {
  assert.equal(appMessageTextOf([{ type: 'text', text: ' Book SL 418 ' }]), 'Book SL 418')
  assert.equal(appMessageTextOf({ type: 'text', text: 'one object' }), 'one object')
  assert.equal(
    appMessageTextOf([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]),
    'a\n\nb',
  )
  assert.equal(appMessageTextOf([{ type: 'text', text: 'pay‮evil​' }]), 'payevil')
  for (const bad of [
    [],
    [{ type: 'image', data: 'x', mimeType: 'image/png' }],
    [
      { type: 'text', text: 'ok' },
      { type: 'resource', resource: {} },
    ],
    [{ type: 'text', text: '   ' }],
    [{ type: 'text', text: 'x'.repeat(MCP_APP_MAX_MESSAGE_CHARS + 1) }],
    'plain string',
  ]) {
    assert.equal(appMessageTextOf(bad), undefined, JSON.stringify(bad).slice(0, 60))
  }
})

// ── the bridge ──────────────────────────────────────────────────────────────

interface IRig {
  bridge: McpAppBridge
  sent: McpAppRpcMessage[]
  calls: { name: string; args: unknown }[]
  links: AppLink[]
  messages: string[]
  heights: number[]
  answer: (id: number) => McpAppRpcMessage | undefined
  flush: () => Promise<void>
}

const rig = (
  handlers: Partial<McpAppBridgeHandlers> = {},
  extra: { toolResult?: unknown } = { toolResult: { content: [{ type: 'text', text: 'r' }] } },
): IRig => {
  const sent: McpAppRpcMessage[] = []
  const calls: { name: string; args: unknown }[] = []
  const links: AppLink[] = []
  const messages: string[] = []
  const heights: number[] = []
  const bridge = new McpAppBridge({
    post: (m) => sent.push(m),
    handlers: {
      callTool: async (name, args) => {
        calls.push({ name, args })
        return { content: [{ type: 'text', text: `ok:${name}` }] }
      },
      openLink: async (link) => {
        links.push(link)
        return true
      },
      message: async (text) => {
        messages.push(text)
        return true
      },
      resize: (h) => heights.push(h),
      ...handlers,
    },
    hostInfo: { name: 'test-host', version: '1' },
    hostCapabilities: mcpAppHostCapabilities(),
    hostContext: { theme: 'dark' },
    toolInput: { from: 'LIS' },
    ...extra,
  })
  return {
    bridge,
    sent,
    calls,
    links,
    messages,
    heights,
    answer: (id) => sent.find((m) => 'id' in m && m.id === id && !('method' in m)),
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

const req = (id: number, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
})
const ready = async (r: IRig) => {
  r.bridge.receive(
    req(1, 'ui/initialize', { protocolVersion: '2026-01-26', appInfo: {}, appCapabilities: {} }),
  )
  r.bridge.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
  await r.flush()
}

test('bridge: the handshake - initialize answered, then the tool input and result, once, in order', async () => {
  const r = rig()
  r.bridge.receive(
    req(1, 'ui/initialize', { protocolVersion: '2026-01-26', appInfo: {}, appCapabilities: {} }),
  )
  const init = r.answer(1) as { result: Record<string, unknown> }
  assert.equal(init.result.protocolVersion, MCP_APP_PROTOCOL_VERSION)
  assert.deepEqual(init.result.hostInfo, { name: 'test-host', version: '1' })
  assert.deepEqual(init.result.hostContext, { theme: 'dark' })
  // What this host does NOT offer is not declared: no resources, no model context, no
  // downloads, no sampling, no logging.
  assert.deepEqual(Object.keys(init.result.hostCapabilities as object).sort(), [
    'message',
    'openLinks',
    'sandbox',
    'serverTools',
  ])
  assert.equal(r.bridge.initialized, false)
  assert.equal(r.sent.length, 1, 'nothing is sent before the app says it is initialized')
  r.bridge.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
  r.bridge.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
  assert.deepEqual(r.sent.slice(1), [
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: { from: 'LIS' } },
    },
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { content: [{ type: 'text', text: 'r' }] },
    },
  ])
  assert.equal(r.bridge.initialized, true)
  // No result to give: the app is told the call was cancelled.
  const none = rig({}, {})
  await ready(none)
  assert.equal((none.sent.at(-1) as { method: string }).method, 'ui/notifications/tool-cancelled')
})

test('guard methods: an allow-list - anything else is "method not found" and reaches no handler', async () => {
  const r = rig()
  await ready(r)
  const before = r.sent.length
  for (const [i, method] of [
    'resources/read',
    'resources/list',
    'tools/list',
    'sampling/createMessage',
    'ui/update-model-context',
    'ui/download-file',
    'prompts/get',
    'ui/notifications/sandbox-resource-ready',
  ].entries()) {
    r.bridge.receive(req(100 + i, method, {}))
    assert.equal((r.answer(100 + i) as { error: { code: number } }).error.code, -32601, method)
  }
  assert.equal(r.sent.length - before, 8)
  assert.deepEqual([r.calls, r.links, r.messages], [[], [], []])
  // Notifications outside the list are dropped, unanswered.
  r.bridge.receive({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'x' } })
  r.bridge.receive({ jsonrpc: '2.0', method: 'ui/notifications/request-teardown' })
  assert.equal(r.sent.length - before, 8)
  // ping and the display mode (it stays inline) are answered.
  r.bridge.receive(req(200, 'ping'))
  r.bridge.receive(req(201, 'ui/request-display-mode', { mode: 'fullscreen' }))
  assert.deepEqual((r.answer(200) as { result: unknown }).result, {})
  assert.deepEqual((r.answer(201) as { result: unknown }).result, { mode: 'inline' })
})

test('guard handshake first: before ui/initialize only ping is answered; nothing is done', async () => {
  const r = rig()
  r.bridge.receive(req(5, 'tools/call', { name: 'flights.book', arguments: {} }))
  r.bridge.receive(req(6, 'ui/open-link', { url: 'https://x.test/' }))
  r.bridge.receive(req(7, 'ping'))
  await r.flush()
  assert.equal((r.answer(5) as { error: { code: number } }).error.code, MCP_APP_REFUSED)
  assert.equal((r.answer(6) as { error: { code: number } }).error.code, MCP_APP_REFUSED)
  assert.deepEqual((r.answer(7) as { result: unknown }).result, {})
  assert.deepEqual([r.calls, r.links], [[], []])
})

test('guard envelope: not JSON-RPC 2.0, a bad id, a bad method, params that are not an object', async () => {
  const r = rig()
  await ready(r)
  const before = r.sent.length
  for (const junk of [
    'string',
    null,
    [1, 2],
    { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' },
    { jsonrpc: '2.0', id: 'x'.repeat(200), method: 'ping' },
    { jsonrpc: '2.0', id: 1, result: {} },
  ]) {
    r.bridge.receive(junk)
  }
  assert.equal(r.sent.length, before, 'nothing answered')
  r.bridge.receive({ jsonrpc: '2.0', id: 9, method: 'x'.repeat(101) })
  r.bridge.receive({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: ['flights.book'] })
  assert.equal((r.answer(9) as { error: { code: number } }).error.code, -32600)
  assert.equal((r.answer(10) as { error: { code: number } }).error.code, -32602)
  assert.deepEqual(r.calls, [])
})

test('bridge: a tool call is handed to the host with its name and arguments; refused, the app gets an error', async () => {
  const r = rig()
  await ready(r)
  r.bridge.receive(req(20, 'tools/call', { name: 'flights.book', arguments: { flight: 'SL 418' } }))
  await r.flush()
  assert.deepEqual(r.calls, [{ name: 'flights.book', args: { flight: 'SL 418' } }])
  assert.deepEqual((r.answer(20) as { result: unknown }).result, {
    content: [{ type: 'text', text: 'ok:flights.book' }],
  })
  const denied = rig({
    callTool: async () => {
      throw new McpAppRpcError(MCP_APP_REFUSED, 'Tool call denied by the user')
    },
  })
  await ready(denied)
  denied.bridge.receive(req(21, 'tools/call', { name: 'flights.book' }))
  await denied.flush()
  assert.deepEqual((denied.answer(21) as { error: unknown }).error, {
    code: MCP_APP_REFUSED,
    message: 'Tool call denied by the user',
  })
})

test('guard tool call parameters: a name, an object of arguments, not too large - else no handler', async () => {
  const r = rig()
  await ready(r)
  r.bridge.receive(req(30, 'tools/call', {}))
  r.bridge.receive(req(31, 'tools/call', { name: 'x'.repeat(129) }))
  r.bridge.receive(req(32, 'tools/call', { name: 'flights.book', arguments: 'SL 418' }))
  r.bridge.receive(
    req(33, 'tools/call', {
      name: 'flights.book',
      arguments: { big: 'x'.repeat(MCP_APP_MAX_ARGS_CHARS) },
    }),
  )
  await r.flush()
  for (const id of [30, 31, 32, 33]) {
    assert.equal((r.answer(id) as { error: { code: number } }).error.code, -32602, String(id))
  }
  assert.deepEqual(r.calls, [])
})

test('guard in flight: at most MCP_APP_MAX_IN_FLIGHT requests of an app wait at once', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const r = rig({
    callTool: async () => {
      await gate
      return {}
    },
  })
  await ready(r)
  for (let i = 0; i < MCP_APP_MAX_IN_FLIGHT + 2; i += 1) {
    r.bridge.receive(req(40 + i, 'tools/call', { name: 'flights.refresh' }))
  }
  await r.flush()
  const refused = [40, 41, 42, 43, 44].filter((id) => r.answer(id))
  assert.deepEqual(refused, [43, 44])
  assert.match((r.answer(43) as { error: { message: string } }).error.message, /Too many/)
  release()
  await r.flush()
  assert.ok([40, 41, 42].every((id) => 'result' in (r.answer(id) as object)))
})

test('guard link: a bad URL never reaches the host; a declined one is an error for the app', async () => {
  const r = rig()
  await ready(r)
  r.bridge.receive(req(50, 'ui/open-link', { url: 'javascript:alert(1)' }))
  r.bridge.receive(req(51, 'ui/open-link', {}))
  r.bridge.receive(req(52, 'ui/open-link', { url: 'https://example-air.test/x' }))
  await r.flush()
  assert.equal((r.answer(50) as { error: { code: number } }).error.code, -32602)
  assert.equal((r.answer(51) as { error: { code: number } }).error.code, -32602)
  assert.deepEqual(
    r.links.map((l) => l.host),
    ['example-air.test'],
  )
  assert.deepEqual((r.answer(52) as { result: unknown }).result, {})
  const declined = rig({ openLink: async () => false })
  await ready(declined)
  declined.bridge.receive(req(53, 'ui/open-link', { url: 'https://example-air.test/x' }))
  await declined.flush()
  assert.deepEqual((declined.answer(53) as { error: unknown }).error, {
    code: MCP_APP_REFUSED,
    message: 'Link opening denied by user',
  })
})

test('guard message: only a user text reaches the host; declined, the app is told', async () => {
  const r = rig()
  await ready(r)
  r.bridge.receive(
    req(60, 'ui/message', { role: 'assistant', content: [{ type: 'text', text: 'x' }] }),
  )
  r.bridge.receive(req(61, 'ui/message', { role: 'user', content: [{ type: 'image', data: 'x' }] }))
  r.bridge.receive(
    req(62, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'Book it' }] }),
  )
  await r.flush()
  assert.equal((r.answer(60) as { error: { code: number } }).error.code, -32602)
  assert.equal((r.answer(61) as { error: { code: number } }).error.code, -32602)
  assert.deepEqual(r.messages, ['Book it'])
  const declined = rig({ message: async () => false })
  await ready(declined)
  declined.bridge.receive(
    req(63, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'x' }] }),
  )
  await declined.flush()
  assert.equal(
    (declined.answer(63) as { error: { message: string } }).error.message,
    'Message sending denied',
  )
})

test('bridge: the size an app asks for reaches the host as a number; a closed bridge says nothing', async () => {
  const r = rig()
  await ready(r)
  r.bridge.receive({
    jsonrpc: '2.0',
    method: 'ui/notifications/size-changed',
    params: { width: 9000, height: 5000 },
  })
  r.bridge.receive({
    jsonrpc: '2.0',
    method: 'ui/notifications/size-changed',
    params: { height: 'tall' },
  })
  r.bridge.receive({
    jsonrpc: '2.0',
    method: 'ui/notifications/size-changed',
    params: { height: -1 },
  })
  assert.deepEqual(r.heights, [5000])
  r.bridge.updateContext({ theme: 'light' })
  assert.deepEqual(r.sent.at(-1), {
    jsonrpc: '2.0',
    method: 'ui/notifications/host-context-changed',
    params: { theme: 'light' },
  })
  r.bridge.teardown('closed')
  assert.equal((r.sent.at(-1) as { method: string }).method, 'ui/resource-teardown')
  const count = r.sent.length
  r.bridge.close()
  r.bridge.receive(req(70, 'ping'))
  r.bridge.teardown('again')
  assert.equal(r.sent.length, count)
})

// ── the reducer ─────────────────────────────────────────────────────────────

const step = { id: 's1', description: 'Search flights' }
const appEvent = (id = 'mcp-app-1'): AgentEvent => ({
  type: 'mcp.app',
  id,
  server: 'travel',
  tool: 'travel__flights_search',
  toolName: 'flights.search',
  resourceUri: 'ui://travel/results.html',
  input: { from: 'LIS', to: 'VIE' },
  result: { structuredContent: { flights: [] } },
  step,
})

const runWithApp = (): AgentUiState => {
  let s = createInitialAgentState()
  s = event(s, { type: 'run.start', goal: 'Find a flight' })
  s = event(s, { type: 'step.start', step, index: 0, total: 1 })
  s = event(s, {
    type: 'step.tool-call',
    step,
    name: 'travel__flights_search',
    input: { from: 'LIS' },
  })
  s = event(s, appEvent())
  s = event(s, appEvent()) // a repeated event is the same app
  s = event(s, {
    type: 'step.tool-result',
    step,
    name: 'travel__flights_search',
    output: 'ok',
    ok: true,
  })
  // The step's result is the authority on its calls: the tag must survive it.
  s = event(s, {
    type: 'step.complete',
    step,
    result: {
      step,
      summary: 'found',
      blocked: false,
      toolCalls: [
        { name: 'travel__flights_search', input: { from: 'LIS' }, output: 'ok', ok: true },
      ],
    },
  } as AgentEvent)
  return s
}

test('reducer: an app joins the turn once, tags its tool call and is kept on the message', () => {
  const s = runWithApp()
  assert.equal(s.apps?.length, 1)
  assert.deepEqual(s.apps?.[0], {
    id: 'mcp-app-1',
    server: 'travel',
    tool: 'travel__flights_search',
    toolName: 'flights.search',
    resourceUri: 'ui://travel/results.html',
    input: { from: 'LIS', to: 'VIE' },
    result: { structuredContent: { flights: [] } },
    stepId: 's1',
  })
  assert.equal(s.steps[0].toolCalls[0].app, 'mcp-app-1')
  const message = s.messages.find((m) => m.role === 'assistant')
  assert.equal(message?.apps, s.apps)
  // The next run starts with none; the turn keeps its own.
  const next = event(s, { type: 'run.start', goal: 'Again' })
  assert.equal(next.apps, undefined)
  assert.equal(next.messages.find((m) => m.role === 'assistant')?.apps?.length, 1)
})

test('reducer: told before its call (the tool runs while the stream is read), the app still tags it', () => {
  let s = createInitialAgentState()
  s = event(s, { type: 'run.start', goal: 'Find a flight' })
  s = event(s, { type: 'step.start', step, index: 0, total: 1 })
  s = event(s, appEvent())
  s = event(s, {
    type: 'step.tool-call',
    step,
    name: 'travel__flights_search',
    input: { from: 'LIS' },
  })
  s = event(s, {
    type: 'step.tool-call',
    step,
    name: 'travel__flights_search',
    input: { from: 'OPO' },
  })
  assert.deepEqual(
    s.steps[0].toolCalls.map((c) => c.app),
    ['mcp-app-1', undefined],
  )
})

test('reducer: an app of a subagent’s call is the turn’s too, and says whose call it was', () => {
  let s = createInitialAgentState()
  s = event(s, { type: 'run.start', goal: 'Delegate' })
  s = event(s, { type: 'subagent.start', id: 'sub-1', name: 'researcher', task: 'look', depth: 1 })
  s = event(s, {
    type: 'subagent.event',
    id: 'sub-1',
    name: 'researcher',
    event: appEvent('mcp-app-9'),
  })
  assert.deepEqual(s.apps?.[0].by, { id: 'sub-1', name: 'researcher' })
  assert.equal(s.apps?.[0].stepId, undefined)
})

const appApproval: AgentEvent = {
  type: 'tool.approval-requested',
  id: 'approval-app-1',
  name: 'travel__flights_book',
  input: { flight: 'SL 418' },
  readOnly: false,
  app: { server: 'travel', tool: 'flights.book', resourceUri: 'ui://travel/results.html' },
}

test('guard consent: an app’s request is the user’s - it outlives a run, a stop, and is never on a message', () => {
  let s = runWithApp()
  s = event(s, appApproval)
  assert.deepEqual(s.approvals.find((a) => a.id === 'approval-app-1')?.app, appApproval.app)
  // A stop denies the run's pending requests, not the app's.
  s = event(s, { type: 'stopped' })
  assert.equal(s.approvals.find((a) => a.id === 'approval-app-1')?.status, 'pending')
  // A new run keeps it pending.
  s = event(s, { type: 'run.start', goal: 'Next' })
  assert.deepEqual(
    s.approvals.map((a) => [a.id, a.status]),
    [['approval-app-1', 'pending']],
  )
  s = event(s, {
    type: 'tool.approval-resolved',
    id: 'approval-app-1',
    name: 'travel__flights_book',
    approved: true,
    automatic: false,
  })
  // Decided, it is not a decision of the run: on no message.
  for (const m of s.messages) {
    assert.equal(m.approvals?.some((a) => a.id === 'approval-app-1') ?? false, false, m.id)
  }
})

// ── the parts, as markup ────────────────────────────────────────────────────

const L = defaultLabels
const appView: AppView = {
  id: 'mcp-app-1',
  server: 'travel',
  tool: 'travel__flights_search',
  toolName: 'flights.search',
  resourceUri: 'ui://travel/results.html',
  input: {},
}
const host = (patch: Partial<McpAppHost> = {}): McpAppHost => ({
  connected: true,
  read: () => new Promise(() => {}),
  tool: () => undefined,
  callTool: async () => ({}),
  openLink: async () => true,
  message: async () => true,
  requests: [],
  answer: () => {},
  isWaiting: () => false,
  ...patch,
})

test('guard chrome: the app’s label and controls are the host’s, outside any frame', () => {
  const markup = html(
    createElement(McpAppFrame, { app: appView, host: host(), onOpenPanel: () => {} }),
  )
  assert.ok(markup.includes(L.appFrom('travel')))
  assert.ok(markup.includes(L.appSandboxed))
  assert.ok(markup.includes(`aria-label="${L.appOpenPanel}"`))
  assert.ok(markup.includes(`aria-label="${L.appMenu}"`))
  // Before the app is read: a loading line, and no frame yet.
  assert.ok(markup.includes(L.appLoading))
  assert.doesNotMatch(markup, /<iframe/)
  // Folded: one line and a button.
  const line = html(
    createElement(McpAppFrame, { app: appView, host: host(), defaultCollapsed: true }),
  )
  assert.ok(line.includes(L.appHidden) && line.includes(`>${L.appShow}</button>`))
  assert.doesNotMatch(line, /<iframe/)
  const waiting = html(
    createElement(McpAppFrame, { app: appView, host: host({ isWaiting: () => true }) }),
  )
  assert.ok(waiting.includes(L.appWaiting) && waiting.includes('is-waiting'))
  const back = html(
    createElement(McpAppLine, {
      app: appView,
      note: L.appInPanel,
      action: L.appBringBack,
      onAction: () => {},
    }),
  )
  assert.ok(back.includes(L.appInPanel) && back.includes(L.appBringBack))
})

test('guard consent labels: a tool call an app asks for says so, with the server’s own tool name', () => {
  const markup = html(
    createElement(ToolApprovalPrompt, {
      approvals: [
        {
          id: 'a1',
          name: 'travel__flights_book',
          input: { flight: 'SL 418' },
          readOnly: false,
          status: 'pending',
          app: { server: 'travel', tool: 'flights.book', resourceUri: 'ui://travel/results.html' },
        },
      ],
      onApprove: () => {},
      onDeny: () => {},
    }),
  )
  assert.ok(markup.includes(L.approvalLeadApp('travel')))
  assert.ok(markup.includes('<code class="awr-tool__name">flights.book</code>'))
  assert.ok(markup.includes(L.approvalFromApp('travel', false)))
  assert.doesNotMatch(markup, new RegExp(L.approvalLead))
  for (const button of [L.approve, L.alwaysAllow, L.deny]) assert.ok(markup.includes(`>${button}<`))
})

test('guard link prompt: the host is what stands out; the text of a message is text', () => {
  const link = appLinkOf('https://example-air.test/checkout?offer=SL418&x=<b>')!
  const markup = html(
    createElement(AppRequestPrompt, {
      requests: [
        { id: 'r1', appId: 'mcp-app-1', server: 'travel', kind: 'link', link },
        {
          id: 'r2',
          appId: 'mcp-app-1',
          server: 'travel',
          kind: 'message',
          text: '<img src=x onerror=alert(1)>',
        },
      ],
      onAnswer: () => {},
    }),
  )
  assert.ok(markup.includes('https://<b>example-air.test</b>/checkout?offer=SL418&amp;x=%3Cb%3E'))
  assert.ok(markup.includes(L.appLinkLead('travel')) && markup.includes(`>${L.appLinkOpen}<`))
  assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.doesNotMatch(markup, /<img/)
  assert.ok(
    markup.includes(L.appMessageLead('travel')) && markup.includes(`>${L.appMessageAccept}<`),
  )
})

test('MessageList: an answer’s apps between its activity and its text, counted; none without renderApp', () => {
  const message = { ...runWithApp().messages[1], content: 'Three flights.', pending: false }
  const drawn = html(
    createElement(MessageList, {
      messages: [message],
      renderApp: (app) => createElement('div', { className: 'drawn' }, app.id),
    }),
  )
  assert.ok(drawn.includes('<div class="drawn">mcp-app-1</div>'))
  assert.ok(drawn.indexOf('drawn') < drawn.indexOf('Three flights.'))
  assert.ok(drawn.includes(L.appsCount(1)))
  assert.ok(drawn.includes(`awr-tool__tag--app`))
  const plain = html(createElement(MessageList, { messages: [message] }))
  assert.doesNotMatch(plain, /drawn|1 app\b/)
  const hidden = html(
    createElement(MessageList, {
      messages: [message],
      showApps: false,
      renderApp: () => createElement('div', { className: 'drawn' }),
    }),
  )
  assert.doesNotMatch(hidden, /drawn/)
})
