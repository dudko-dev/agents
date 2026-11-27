import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentEvent, AppSamplingView } from '@dudko.dev/agent-web'
import {
  agentStateReducer,
  appDisplayModeAllowed,
  appDownloadOf,
  appDownloadRefusal,
  appFileNameOf,
  appGestureOf,
  AppRequestPrompt,
  appSamplingErrorOf,
  createInitialAgentState,
  defaultLabels,
  MCP_APP_MAX_DOWNLOAD_BYTES,
  MCP_APP_MAX_FILE_NAME_CHARS,
  MCP_APP_REFUSED,
  McpAppBridge,
  mcpAppHostCapabilities,
  McpAppRpcError,
  resolveAppDownload,
  saveAppFile,
  type AgentAction,
  type AgentUiState,
  type AppDownload,
  type AppRequestView,
  type McpAppBridgeHandlers,
  type McpAppDisplayMode,
  type McpAppRpcMessage,
} from '../dist/index.js'

// MCP Apps, the three requests that need the host to turn them on - a display mode
// (`ui/request-display-mode`), a file to save (`ui/download-file`), a completion of the agent's
// model (`sampling/createMessage`) - and the per-server switch's reducer side. A consent
// boundary: every guard has a test named "guard …" here, a mutation check, and its browser
// proof in e2e/demo-server-app.spec.ts and e2e/apps.spec.ts.

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

// ── a bridge with the optional handlers ─────────────────────────────────────

const rig = (
  handlers: Partial<McpAppBridgeHandlers> = {},
  context: Record<string, unknown> = { displayMode: 'inline', availableDisplayModes: ['inline'] },
  features: { downloadFile?: boolean; sampling?: boolean } = {},
) => {
  const sent: McpAppRpcMessage[] = []
  const bridge = new McpAppBridge({
    post: (m) => sent.push(m),
    handlers: {
      callTool: async () => ({}),
      openLink: async () => true,
      message: async () => true,
      resize: () => {},
      ...handlers,
    },
    hostInfo: { name: 'test-host', version: '1' },
    hostCapabilities: mcpAppHostCapabilities(undefined, features),
    hostContext: { ...context },
    toolInput: {},
    toolResult: { content: [] },
  })
  const answer = (id: number) =>
    sent.find((m) => 'id' in m && m.id === id && !('method' in m)) as
      { result?: Record<string, unknown>; error?: { code: number; message: string } } | undefined
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const start = async (appCapabilities: Record<string, unknown> = {}) => {
    bridge.receive({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: { protocolVersion: '2026-01-26', appInfo: {}, appCapabilities },
    })
    bridge.receive({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })
    await flush()
  }
  const ask = async (id: number, method: string, params?: unknown) => {
    bridge.receive({ jsonrpc: '2.0', id, method, params })
    await flush()
    return answer(id)
  }
  return { bridge, sent, answer, flush, start, ask }
}

// ── capabilities: only what is on ───────────────────────────────────────────

test('guard capabilities: downloadFile and sampling only when on; never sampling.tools', () => {
  const off = mcpAppHostCapabilities()
  assert.equal('downloadFile' in off, false)
  assert.equal('sampling' in off, false)
  const on = mcpAppHostCapabilities(undefined, { downloadFile: true, sampling: true })
  assert.deepEqual(on.downloadFile, {})
  assert.deepEqual(on.sampling, {}, 'no tools in sampling')
})

test('guard methods: ui/download-file and sampling/createMessage reach a handler only when given one', async () => {
  const none = rig()
  await none.start()
  for (const [id, method] of [
    [10, 'ui/download-file'],
    [11, 'sampling/createMessage'],
  ] as const) {
    assert.equal((await none.ask(id, method, {}))?.error?.code, -32601, method)
  }
  const files: AppDownload[] = []
  const samples: unknown[] = []
  const on = rig({
    downloadFile: async (f) => (files.push(f), true),
    sample: async (p) => (
      samples.push(p),
      { role: 'assistant', content: { type: 'text', text: 'ok' } }
    ),
  })
  // Before ui/initialize: refused, like every request but ping.
  assert.equal((await on.ask(12, 'sampling/createMessage', {}))?.error?.code, MCP_APP_REFUSED)
  await on.start()
  const file = { contents: [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'hi' } }] }
  assert.deepEqual((await on.ask(13, 'ui/download-file', file))?.result, {})
  assert.deepEqual(
    (await on.ask(14, 'sampling/createMessage', { messages: [], maxTokens: 9 }))?.result,
    { role: 'assistant', content: { type: 'text', text: 'ok' } },
  )
  assert.equal(files.length, 1)
  assert.deepEqual(samples, [{ messages: [], maxTokens: 9 }])
})

// ── display modes ───────────────────────────────────────────────────────────

test('guard display mode: inline always; another mode only offered by the host AND declared by the app', () => {
  const allowed = (
    requested: McpAppDisplayMode,
    host: McpAppDisplayMode[],
    app?: McpAppDisplayMode[],
  ) => appDisplayModeAllowed({ requested, current: 'inline', host, app })
  assert.equal(allowed('inline', ['inline']), true)
  assert.equal(allowed('fullscreen', ['inline', 'fullscreen'], ['inline', 'fullscreen']), true)
  assert.equal(allowed('fullscreen', ['inline', 'fullscreen'], undefined), false, 'not declared')
  assert.equal(allowed('fullscreen', ['inline', 'fullscreen'], ['inline']), false)
  assert.equal(allowed('fullscreen', ['inline'], ['inline', 'fullscreen']), false, 'not offered')
  assert.equal(allowed('pip', ['inline', 'fullscreen'], ['pip']), false, 'pip is never offered')
  assert.equal(
    appDisplayModeAllowed({
      requested: 'inline',
      current: 'fullscreen',
      host: ['inline'],
      app: ['fullscreen'],
    }),
    true,
    'the way back is always open',
  )
})

test('guard gesture: the frame has the focus AND the page was just activated (focus alone without the API)', () => {
  assert.equal(appGestureOf({ focused: true, activation: true }), true)
  assert.equal(appGestureOf({ focused: true, activation: false }), false, 'activation expired')
  assert.equal(appGestureOf({ focused: false, activation: true }), false, 'a click elsewhere')
  assert.equal(appGestureOf({ focused: true, activation: undefined }), true)
  assert.equal(appGestureOf({ focused: false, activation: undefined }), false)
})

test('guard display mode: the bridge asks the host only for an allowed mode, and answers the resulting one', async () => {
  const asked: McpAppDisplayMode[] = []
  let grant = true
  const r = rig(
    {
      displayMode: (mode) => {
        asked.push(mode)
        return grant ? mode : 'inline'
      },
    },
    { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] },
  )
  await r.start({ availableDisplayModes: ['inline', 'fullscreen'] })
  assert.equal((await r.ask(20, 'ui/request-display-mode', { mode: 'big' }))?.error?.code, -32602)
  assert.equal((await r.ask(21, 'ui/request-display-mode', {}))?.error?.code, -32602)
  assert.deepEqual((await r.ask(22, 'ui/request-display-mode', { mode: 'pip' }))?.result, {
    mode: 'inline',
  })
  assert.deepEqual(asked, [], 'pip is not offered: the host is not even asked')
  assert.deepEqual((await r.ask(23, 'ui/request-display-mode', { mode: 'fullscreen' }))?.result, {
    mode: 'fullscreen',
  })
  grant = false
  assert.deepEqual((await r.ask(24, 'ui/request-display-mode', { mode: 'fullscreen' }))?.result, {
    mode: 'inline',
  })
  assert.deepEqual(asked, ['fullscreen', 'fullscreen'])
  // An app that declared no modes stays where it is; so does any app without a handler.
  const undeclared = rig(
    { displayMode: (m) => (asked.push(m), m) },
    {
      displayMode: 'inline',
      availableDisplayModes: ['inline', 'fullscreen'],
    },
  )
  await undeclared.start({})
  assert.deepEqual(
    (await undeclared.ask(25, 'ui/request-display-mode', { mode: 'fullscreen' }))?.result,
    { mode: 'inline' },
  )
  assert.equal(asked.length, 2)
  const plain = rig({}, { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] })
  await plain.start({ availableDisplayModes: ['fullscreen'] })
  assert.deepEqual(
    (await plain.ask(26, 'ui/request-display-mode', { mode: 'fullscreen' }))?.result,
    {
      mode: 'inline',
    },
  )
  // The host's change of mode reaches the app as a context change.
  r.bridge.updateContext({ displayMode: 'fullscreen' })
  assert.equal(r.bridge.displayMode, 'fullscreen')
  assert.deepEqual(r.sent.at(-1), {
    jsonrpc: '2.0',
    method: 'ui/notifications/host-context-changed',
    params: { displayMode: 'fullscreen' },
  })
})

// ── downloads ───────────────────────────────────────────────────────────────

test('guard file name: the last segment, no traversal, nothing hidden, no reserved name, capped', () => {
  assert.equal(appFileNameOf('file:///exports/trip-lisbon.txt'), 'trip-lisbon.txt')
  assert.equal(appFileNameOf('../../etc/passwd'), 'passwd')
  assert.equal(appFileNameOf('C:\\Windows\\System32\\evil.txt'), 'evil.txt')
  assert.equal(appFileNameOf('file:///a/..%2F..%2Fsecret.txt'), 'secret.txt')
  assert.equal(appFileNameOf('file:///x/report.json?download=1#top'), 'report.json')
  assert.equal(appFileNameOf('invoice\u202egpj.exe'), 'invoicegpj.exe')
  assert.equal(appFileNameOf('a<b>c:d"e|f*g.txt'), 'a_b_c_d_e_f_g.txt')
  assert.equal(appFileNameOf('.bashrc'), 'bashrc')
  assert.equal(appFileNameOf('notes.txt. . '), 'notes.txt')
  assert.equal(appFileNameOf('CON.txt'), '_CON.txt')
  assert.equal(appFileNameOf('lpt1'), '_lpt1')
  for (const empty of ['', '/', '...', 'file:///', 42, undefined, '%E0%A4%A']) {
    const name = appFileNameOf(empty)
    assert.ok(name.length > 0 && !name.includes('/'), String(empty))
  }
  assert.equal(appFileNameOf(''), 'download')
  const long = appFileNameOf(`${'x'.repeat(300)}.ics`)
  assert.equal(long.length, MCP_APP_MAX_FILE_NAME_CHARS)
  assert.ok(long.endsWith('.ics'))
})

test('guard file type: programs, scripts and pages a browser runs are refused - by name and by type', () => {
  for (const name of [
    'a.exe',
    'A.EXE',
    'trip.pdf.exe',
    'x.bat',
    'x.sh',
    'x.ps1',
    'x.js',
    'x.jar',
    'x.html',
    'x.htm',
    'x.svg',
    'x.xml',
    'x.lnk',
    'x.dmg',
    'x.apk',
    'x.hta',
    'x.msi',
    'x.py',
  ]) {
    assert.ok(appDownloadRefusal(name), name)
  }
  for (const type of [
    'text/html',
    'TEXT/HTML; charset=utf-8',
    'image/svg+xml',
    'application/xhtml+xml',
    'application/x-msdownload',
    'application/javascript',
    'application/atom+xml',
    'text/xml',
  ]) {
    assert.ok(appDownloadRefusal('trip.txt', type), type)
  }
  for (const [name, type] of [
    ['trip.txt', 'text/plain'],
    ['trip.ics', 'text/calendar'],
    ['board.png', 'image/png'],
    ['data.json', 'application/json'],
    ['report.pdf', 'application/pdf'],
    ['table.csv', undefined],
    ['README', 'not a type'],
  ] as const) {
    assert.equal(appDownloadRefusal(name, type), undefined, name)
  }
})

test('guard download request: one file, embedded (capped) or a link; checked before anyone is asked', () => {
  const embedded = (resource: Record<string, unknown>) => ({
    contents: [{ type: 'resource', resource }],
  })
  const text = appDownloadOf(
    embedded({ uri: 'file:///trip.txt', mimeType: 'text/plain', text: 'Olá' }),
  )
  assert.ok(typeof text === 'object' && text.kind === 'embedded')
  assert.equal(text.name, 'trip.txt')
  assert.equal(text.mimeType, 'text/plain')
  assert.equal(dec(text.bytes), 'Olá')
  const blob = appDownloadOf(embedded({ uri: 'file:///b.dat', blob: 'AAEC' }))
  assert.ok(typeof blob === 'object' && blob.kind === 'embedded')
  assert.deepEqual([...blob.bytes], [0, 1, 2])
  const link = appDownloadOf({
    contents: [
      {
        type: 'resource_link',
        uri: 'ui://demo/itinerary.ics',
        name: 'Itinerary',
        mimeType: 'text/calendar',
      },
    ],
  })
  assert.deepEqual(link, {
    kind: 'link',
    uri: 'ui://demo/itinerary.ics',
    name: 'itinerary.ics',
    mimeType: 'text/calendar',
  })
  const named = appDownloadOf({
    contents: [{ type: 'resource_link', uri: 'res://x/', name: 'Q4 report.pdf' }],
  })
  assert.ok(typeof named === 'object' && named.name === 'Q4 report.pdf')

  const refused: [unknown, RegExp][] = [
    [undefined, /contents/],
    [{ contents: [] }, /contents/],
    [
      {
        contents: [
          embedded({ uri: 'file:///a', text: 'a' }).contents[0],
          embedded({ uri: 'file:///b', text: 'b' }).contents[0],
        ],
      },
      /One file/,
    ],
    [{ contents: ['x'] }, /Invalid content/],
    [{ contents: [{ type: 'image', data: 'x' }] }, /resource or a resource_link/],
    [embedded({ text: 'x' }), /resource.uri/],
    [embedded({ uri: 'file:///a\nb.txt', text: 'x' }), /resource.uri/],
    [embedded({ uri: 'file:///a.txt' }), /text or blob/],
    [embedded({ uri: 'file:///a.txt', blob: 'not base64!' }), /base64/],
    [embedded({ uri: 'file:///page.html', text: '<script>' }), /Policy violation/],
    [
      embedded({ uri: 'file:///a.txt', mimeType: 'text/html', text: '<script>' }),
      /Policy violation/,
    ],
    [embedded({ uri: 'file:///setup.exe', blob: 'TVo=' }), /Policy violation/],
    [{ contents: [{ type: 'resource_link', uri: 'https://x.test/a b' }] }, /URI/],
    [{ contents: [{ type: 'resource_link', uri: 'https://x.test/run.sh' }] }, /Policy violation/],
    [
      { contents: [{ type: 'resource_link', uri: 'res://x/a', mimeType: 'image/svg+xml' }] },
      /Policy violation/,
    ],
  ]
  for (const [params, why] of refused) {
    const got = appDownloadOf(params)
    assert.equal(typeof got, 'string', JSON.stringify(params)?.slice(0, 80))
    assert.match(got as string, why)
  }
  // The size cap, on text and on base64 (checked before the blob is decoded).
  assert.match(
    appDownloadOf(embedded({ uri: 'file:///a.txt', text: 'x'.repeat(11) }), 10) as string,
    /larger than 10/,
  )
  assert.match(
    appDownloadOf(embedded({ uri: 'file:///a.txt', text: '€€€€' }), 10) as string,
    /larger than 10/,
  )
  assert.match(
    appDownloadOf(embedded({ uri: 'file:///a.dat', blob: 'A'.repeat(40) }), 10) as string,
    /larger than 10/,
  )
  // Before it is decoded: an over-long blob is refused for its size, not looked at at all.
  assert.match(
    appDownloadOf(embedded({ uri: 'file:///a.dat', blob: '!'.repeat(40) }), 10) as string,
    /larger than 10/,
  )
  assert.equal(MCP_APP_MAX_DOWNLOAD_BYTES, 20 * 1024 * 1024)
})

test('guard download in the bridge: refused before the host is asked; the user saying no is isError', async () => {
  const asked: AppDownload[] = []
  let save = false
  const r = rig({ downloadFile: async (f) => (asked.push(f), save) })
  await r.start()
  const bad = await r.ask(30, 'ui/download-file', {
    contents: [{ type: 'resource', resource: { uri: 'file:///evil.exe', blob: 'TVo=' } }],
  })
  assert.equal(bad?.error?.code, -32602)
  assert.match(bad?.error?.message ?? '', /Policy violation/)
  assert.equal(asked.length, 0)
  const ok = {
    contents: [{ type: 'resource', resource: { uri: 'file:///trip.txt', text: 'Day 1' } }],
  }
  assert.deepEqual((await r.ask(31, 'ui/download-file', ok))?.result, { isError: true })
  save = true
  assert.deepEqual((await r.ask(32, 'ui/download-file', ok))?.result, {})
  assert.equal(asked.length, 2)
})

test('guard linked file: read from the app’s own server through the connection; the server’s type judged again', async () => {
  const reads: { server: string; uri: string; maxBytes: number }[] = []
  const reader =
    (mimeType: string | undefined, bytes = enc('BEGIN:VCALENDAR')) =>
    async (server: string, uri: string, o: { maxBytes: number }) => {
      reads.push({ server, uri, maxBytes: o.maxBytes })
      return { ...(mimeType ? { mimeType } : {}), bytes }
    }
  const file: AppDownload = { kind: 'link', uri: 'ui://demo/itinerary.ics', name: 'itinerary.ics' }
  const ready = await resolveAppDownload(file, 'demo', reader('text/calendar'))
  assert.deepEqual(
    { ...ready, bytes: dec(ready.bytes) },
    { name: 'itinerary.ics', mimeType: 'text/calendar', bytes: 'BEGIN:VCALENDAR', source: 'link' },
  )
  assert.deepEqual(reads, [
    { server: 'demo', uri: 'ui://demo/itinerary.ics', maxBytes: MCP_APP_MAX_DOWNLOAD_BYTES },
  ])
  // A page passed off as a calendar: the server says text/html.
  await assert.rejects(resolveAppDownload(file, 'demo', reader('text/html')), /Policy violation/)
  // No reader (an older core): refused, never fetched instead.
  await assert.rejects(resolveAppDownload(file, 'demo', undefined), /cannot read a linked file/)
  await assert.rejects(
    resolveAppDownload(file, 'demo', async () => {
      throw new Error('no such resource')
    }),
    /Invalid content: no such resource/,
  )
  await assert.rejects(
    resolveAppDownload(file, 'demo', reader(undefined, enc('x'.repeat(20))), undefined, 10),
    /larger than 10/,
  )
  // An embedded file is not read at all.
  const embedded = await resolveAppDownload(
    { kind: 'embedded', name: 'a.txt', bytes: enc('a') },
    'demo',
    undefined,
  )
  assert.equal(embedded.source, 'embedded')
})

test('guard save: a blob of this page as application/octet-stream, an <a download> clicked once - no navigation', () => {
  const log: string[] = []
  const blobs: Blob[] = []
  const anchor = {
    href: '',
    download: '',
    rel: '',
    style: { display: '' },
    click: () => log.push(`click ${anchor.href} ${anchor.download}`),
    remove: () => log.push('remove'),
  }
  const timers: (() => void)[] = []
  saveAppFile(
    { name: '../trip.txt', bytes: enc('Day 1') },
    {
      document: {
        createElement: () => anchor as unknown as HTMLAnchorElement,
        body: { append: () => log.push('append') },
      },
      URL: {
        createObjectURL: (b) => (blobs.push(b), 'blob:http://page/1'),
        revokeObjectURL: (u) => log.push(`revoke ${u}`),
      },
      setTimeout: (fn) => timers.push(fn),
    },
  )
  assert.equal(blobs[0].type, 'application/octet-stream')
  assert.equal(blobs[0].size, 5)
  assert.deepEqual(log, ['append', 'click blob:http://page/1 trip.txt', 'remove'])
  assert.equal(anchor.rel, 'noopener')
  timers.forEach((fn) => fn())
  assert.equal(log.at(-1), 'revoke blob:http://page/1')
})

// ── sampling ────────────────────────────────────────────────────────────────

test('guard sampling: the core’s refusal reaches the app with its code; the user saying no is -1', async () => {
  const err = (code: string, rpcCode: number) =>
    Object.assign(new Error(`no: ${code}`), { name: 'AppSamplingError', code, rpcCode })
  assert.equal(appSamplingErrorOf(err('denied', -1)).code, -1)
  assert.equal(appSamplingErrorOf(err('invalid', -32602)).code, -32602)
  assert.equal(appSamplingErrorOf(new Error('model down')).code, MCP_APP_REFUSED)
  // A look-alike without the core's name is just a refusal.
  assert.equal(
    appSamplingErrorOf(Object.assign(new Error('x'), { rpcCode: 0 })).code,
    MCP_APP_REFUSED,
  )
  const r = rig({
    sample: async () => {
      throw appSamplingErrorOf(err('denied', -1))
    },
  })
  await r.start()
  assert.deepEqual((await r.ask(40, 'sampling/createMessage', { messages: [] }))?.error, {
    code: -1,
    message: 'no: denied',
  })
  const params = await r.ask(41, 'sampling/createMessage', ['not', 'an', 'object'])
  assert.equal(params?.error?.code, -32602)
  assert.ok(new McpAppRpcError(-1, 'x') instanceof Error)
})

test('reducer: an app’s sampling tokens count in the total only - never in a run, never on an answer', () => {
  const event = (s: AgentUiState, e: AgentEvent) =>
    agentStateReducer(s, { type: 'event', event: e } as AgentAction)
  const tokens = (n: number) => ({
    inputTokens: n,
    outputTokens: 0,
    totalTokens: n,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  })
  let s = createInitialAgentState()
  s = event(s, { type: 'run.start', goal: 'Plan a trip' })
  s = event(s, { type: 'usage', phase: 'execute', usage: tokens(100) })
  s = event(s, { type: 'final', text: 'Done.' })
  s = event(s, { type: 'usage', phase: 'app', usage: tokens(40) })
  assert.equal(s.usage.totalTokens, 100)
  assert.equal(s.totalUsage.totalTokens, 140)
  const answer = s.messages.find((m) => m.role === 'assistant')
  assert.equal(answer?.usage.totalTokens, 100)
})

// ── the prompts, as markup ──────────────────────────────────────────────────

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node)
const view: AppSamplingView = {
  server: 'demo',
  resourceUri: 'ui://demo/trip-board.html',
  messages: [{ role: 'user', text: 'Dinner in <b>Lisbon</b>?', images: [] }],
  systemPrompt: 'You suggest <i>one</i> place.',
  maxTokens: 200,
  requestedMaxTokens: 5000,
}

test('guard prompts: a file shows its sanitized name, type and size; sampling shows the app’s text as text', () => {
  const requests: AppRequestView[] = [
    {
      id: 'r1',
      appId: 'a1',
      server: 'demo',
      kind: 'download',
      download: {
        name: 'lisbon-itinerary.txt',
        mimeType: 'text/plain',
        size: 2048,
        source: 'embedded',
      },
    },
    { id: 'r2', appId: 'a1', server: 'demo', kind: 'sampling', sampling: view },
  ]
  const out = html(createElement(AppRequestPrompt, { requests, onAnswer: () => {} }))
  assert.ok(out.includes(defaultLabels.appDownloadLead('demo').replace(/“|”/g, (q) => q)))
  assert.match(out, /<b class="awr-approval__filename">lisbon-itinerary\.txt<\/b>/)
  assert.ok(out.includes('text/plain · 2.0 KB'))
  assert.ok(out.includes(defaultLabels.appDownloadSave))
  // The app's text is text: its markup is escaped, never rendered.
  assert.ok(out.includes('Dinner in &lt;b&gt;Lisbon&lt;/b&gt;?'))
  assert.ok(out.includes('You suggest &lt;i&gt;one&lt;/i&gt; place.'))
  assert.ok(!out.includes('<b>Lisbon</b>'))
  assert.ok(out.includes(defaultLabels.appSamplingTokens(200, 5000)))
  for (const label of [
    defaultLabels.appSamplingAllow,
    defaultLabels.appSamplingAlways,
    defaultLabels.appSamplingDeny,
  ]) {
    assert.ok(out.includes(`>${label}</button>`), label)
  }
  assert.ok(out.includes(defaultLabels.appSamplingLead('demo').replace('’', '’')))
})
