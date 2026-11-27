import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { mcpAppOrigin } from '@dudko.dev/agent-web'
import {
  buildMcpAppSandboxShell,
  grantedAppCsp,
  MCP_APP_SANDBOX_FRAME_TOKENS,
  mcpAppCsp,
  McpAppSandboxLink,
  mcpAppSandboxProxyUrl,
  mcpAppSandboxShellCsp,
  mcpAppSandboxTarget,
} from '../dist/index.js'
import {
  isMcpAppSandboxHost,
  MCP_APP_POLICY_MAX_ORIGINS,
  MCP_APP_POLICY_TOKEN_MAX_CHARS,
  MCP_APP_SANDBOX_PERMISSIONS_POLICY,
  MCP_APP_SANDBOX_PROXY_READY,
  MCP_APP_SANDBOX_RESOURCE_READY,
  MCP_APP_SANDBOX_SCRIPT,
  mcpAppPolicy,
  mcpAppPolicyOfToken,
  mcpAppPolicyOrigin,
  mcpAppPolicyToken,
  mcpAppSandboxHeaders,
  mcpAppSandboxPage,
  mcpAppSandboxResponse,
  parseMcpAppSandboxHosts,
} from '../dist/mcp-app-sandbox.js'

// MCP Apps on an origin of their own: the sandbox proxy (the `./mcp-app-sandbox` entry: the page,
// its script, its server) and the page's side of it (`mcp-app.ts`: the URL, the shell, the link).
// A security boundary: every guard has a test named "guard …" here, and e2e/apps-sandbox.spec.ts
// proves the same in a real browser against the hostile travel app.

const PAGE = 'https://agent.example.com'
const SANDBOX = 'https://apps.example.net'
const URL_V1 = `${SANDBOX}/sandbox/v1`

// ── the origin rule: a copy of the core's, held to it ──────────────────────────────────────

const CORPUS = [
  'https://api.example.com',
  'HTTPS://API.EXAMPLE.COM/',
  ' https://api.example.com ',
  'https://api.example.com:8443',
  'https://*.example.com',
  'https://*.com',
  'https://*',
  'wss://socket.example.com',
  'ws://socket.example.com',
  'http://api.example.com',
  'http://localhost:3000',
  'http://127.0.0.1',
  'http://[::1]:8080',
  'ws://localhost',
  'https://api.example.com/path',
  'https://api.example.com?x=1',
  'https://ok.example; script-src *',
  'https://ok.example script-src',
  'https://ok.example,https://b.example',
  '*',
  "'unsafe-eval'",
  "'self'",
  'data:',
  'blob:',
  'https:',
  'javascript:alert(1)',
  'https://-bad.example.com',
  'https://bad-.example.com',
  `https://${'a'.repeat(64)}.example.com`,
  `https://${'a'.repeat(63)}.example.com`,
  'https://exa mple.com',
  'https://user@example.com',
  'https://xn--bcher-kva.example',
  'https://例え.jp',
  '',
  'x'.repeat(301),
  42,
  null,
  undefined,
  {},
]

test('guard origin rule: the proxy’s copy answers exactly as the core’s mcpAppOrigin', () => {
  for (const entry of CORPUS) {
    assert.equal(mcpAppPolicyOrigin(entry), mcpAppOrigin(entry), JSON.stringify(entry))
  }
})

test('guard origin rule: the copy is the core’s code, line for line, and the same cap', () => {
  const core = readFileSync(new URL('../../agent-web/src/mcp/apps.ts', import.meta.url), 'utf8')
  const copy = readFileSync(new URL('../src/mcp-app-policy.ts', import.meta.url), 'utf8')
  const lines = (source: string) =>
    source
      .split('\n')
      .filter((l) => /^const (LABEL|HOST|PORT|SECURE_ORIGIN|LOOPBACK_ORIGIN) = /.test(l))
  assert.equal(lines(core).length, 5)
  assert.deepEqual(lines(copy), lines(core))
  const body = (source: string, name: string) => {
    const start = source.indexOf(`export const ${name} = (entry: unknown): string | undefined => {`)
    assert.ok(start >= 0, name)
    return source
      .slice(source.indexOf('{', start), source.indexOf('\n}\n', start))
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
  }
  assert.equal(body(copy, 'mcpAppPolicyOrigin'), body(core, 'mcpAppOrigin'))
  const cap = /export const MCP_APP_MAX_DOMAINS = (\d+)/.exec(core)?.[1]
  assert.equal(String(MCP_APP_POLICY_MAX_ORIGINS), cap)
})

// ── one policy, built in one place ───────────────────────────────────────────────────────────

test('guard policy: the page’s frame and the sandbox page build the same policy from the same origins', () => {
  const declared = {
    connectDomains: ['https://api.example.com', '*', 'https://ok.example; script-src *'],
    resourceDomains: ['https://cdn.example.com', "'unsafe-eval'"],
    frameDomains: ['https://player.example.com'],
  }
  const granted = grantedAppCsp(declared)
  const policy = mcpAppPolicy({
    connect: granted.connectDomains,
    resources: granted.resourceDomains,
  })
  assert.equal(policy, mcpAppCsp(declared))
  assert.match(policy, /connect-src https:\/\/api\.example\.com;/)
  assert.match(policy, /frame-src 'none'/)
  assert.doesNotMatch(policy, /ok\.example|unsafe-eval|player/)
})

// ── the policy in the URL ────────────────────────────────────────────────────────────────────

test('guard token: what the page writes the sandbox reads back, and nothing else', () => {
  const policy = { connect: ['https://api.example.com', 'wss://ws.example.com'], resources: [] }
  const token = mcpAppPolicyToken(policy)
  assert.ok(token && /^[A-Za-z0-9_-]+$/.test(token), 'base64url, one path segment')
  assert.deepEqual(mcpAppPolicyOfToken(token), policy)
  const empty = mcpAppPolicyToken({ connect: [], resources: [] })
  assert.deepEqual(mcpAppPolicyOfToken(empty), { connect: [], resources: [] })

  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const refused: [string, unknown][] = [
    ['not base64url', 'abc+def/'],
    ['padding', `${empty}=`],
    ['empty', ''],
    ['not a string', 42],
    ['too long', 'A'.repeat(MCP_APP_POLICY_TOKEN_MAX_CHARS + 1)],
    ['not JSON', Buffer.from('{oops').toString('base64url')],
    ['an array', enc([[], []])],
    ['a key missing', enc({ c: [] })],
    ['a key more', enc({ c: [], r: [], f: ['https://player.example.com'] })],
    ['not a list', enc({ c: 'https://api.example.com', r: [] })],
    ['a wildcard', enc({ c: ['*'], r: [] })],
    ['a keyword', enc({ c: [], r: ["'unsafe-eval'"] })],
    ['an injected directive', enc({ c: ['https://ok.example; script-src *'], r: [] })],
    ['a scheme', enc({ c: ['data:'], r: [] })],
    ['plain http off loopback', enc({ c: ['http://api.example.com'], r: [] })],
    ['not canonical', enc({ c: ['HTTPS://API.EXAMPLE.COM'], r: [] })],
    ['a trailing slash', enc({ c: ['https://api.example.com/'], r: [] })],
    ['twice', enc({ c: ['https://a.example.com', 'https://a.example.com'], r: [] })],
    [
      'too many',
      enc({
        c: Array.from(
          { length: MCP_APP_POLICY_MAX_ORIGINS + 1 },
          (_, i) => `https://h${i}.example.com`,
        ),
        r: [],
      }),
    ],
    ['another encoding of the same', Buffer.from('{"c": [], "r": []}').toString('base64url')],
    ['keys the other way round', enc({ r: [], c: [] })],
  ]
  for (const [why, token] of refused) assert.equal(mcpAppPolicyOfToken(token), undefined, why)
  // Non-ASCII is not a checked origin: no token at all.
  assert.equal(mcpAppPolicyToken({ connect: ['https://例え.jp'], resources: [] }), undefined)
})

test('guard token: a policy too long for a URL gets none - the app runs opaque', () => {
  const long = Array.from({ length: 32 }, (_, i) => `https://${'a'.repeat(60)}${i}.example.com`)
  assert.equal(
    mcpAppSandboxProxyUrl(URL_V1, { connectDomains: long, resourceDomains: long }),
    undefined,
  )
  const url = mcpAppSandboxProxyUrl(URL_V1, { connectDomains: ['https://api.example.com', '*'] })
  assert.ok(url?.startsWith(`${URL_V1}/`))
  // Only the origins the policy grants are in it: what the frame's policy is built from.
  assert.deepEqual(mcpAppPolicyOfToken(url?.slice(URL_V1.length + 1)), {
    connect: ['https://api.example.com'],
    resources: [],
  })
})

// ── where the sandbox may be ─────────────────────────────────────────────────────────────────

const target = (url: string, server = 'travel', page: string | undefined = PAGE) =>
  mcpAppSandboxTarget({ url }, server, page)

test('guard sandbox URL: another origin, https - or http on loopback only', () => {
  assert.deepEqual(target(URL_V1), { ok: true, origin: SANDBOX, base: URL_V1 })
  assert.deepEqual(target(`${URL_V1}/`), { ok: true, origin: SANDBOX, base: URL_V1 })
  assert.deepEqual(target(SANDBOX), { ok: true, origin: SANDBOX, base: SANDBOX })
  assert.deepEqual(target('http://localhost:4173/sandbox/v1', 'travel', 'http://127.0.0.1:4173'), {
    ok: true,
    origin: 'http://localhost:4173',
    base: 'http://localhost:4173/sandbox/v1',
  })
  assert.equal(target('http://127.0.0.1:9/s', 'travel', 'http://localhost:9').ok, true)
  const refused: [string, string, string | undefined, string][] = [
    ['the page’s own origin', `${PAGE}/sandbox/v1`, PAGE, 'same-origin'],
    ['the page’s own origin, another case', 'HTTPS://AGENT.EXAMPLE.COM/x', PAGE, 'same-origin'],
    [
      'the page’s own origin, its port spelled out',
      'https://agent.example.com:443/x',
      PAGE,
      'same-origin',
    ],
    ['plain http', 'http://apps.example.net/sandbox/v1', PAGE, 'insecure'],
    ['IPv6 loopback (a policy cannot name it)', 'http://[::1]:8080/s', PAGE, 'insecure'],
    ['another scheme', 'ftp://apps.example.net/s', PAGE, 'insecure'],
    ['javascript', 'javascript:alert(1)', PAGE, 'insecure'],
    ['data', 'data:text/html,x', PAGE, 'insecure'],
    ['credentials', 'https://user:pw@apps.example.net/s', PAGE, 'invalid'],
    ['a query', `${URL_V1}?x=1`, PAGE, 'invalid'],
    ['a fragment', `${URL_V1}#x`, PAGE, 'invalid'],
    ['a space', `${URL_V1}/a b`, PAGE, 'invalid'],
    ['a ; in the path (a policy separator)', `${URL_V1};x`, PAGE, 'invalid'],
    ['a , in the path', `${URL_V1},x`, PAGE, 'invalid'],
    ['a quote in the path', `${URL_V1}/'self'`, PAGE, 'invalid'],
    ['not a URL', 'apps.example.net/sandbox', PAGE, 'invalid'],
    ['empty', '', PAGE, 'invalid'],
    ['a page without an origin', URL_V1, 'null', 'no-page-origin'],
  ]
  for (const [why, url, page, reason] of refused) {
    assert.deepEqual(target(url, 'travel', page), { ok: false, reason }, why)
  }
  assert.deepEqual(mcpAppSandboxTarget(undefined, 'travel', PAGE), { ok: false, reason: 'invalid' })
  assert.deepEqual(mcpAppSandboxTarget({ url: URL_V1 }, 'travel', undefined), {
    ok: false,
    reason: 'no-page-origin',
  })
})

test('guard sandbox URL: {server} - only in the host name, once, and only for a DNS label', () => {
  const T = 'https://{server}.apps.example.net/sandbox/v1'
  assert.deepEqual(target(T, 'travel'), {
    ok: true,
    origin: 'https://travel.apps.example.net',
    base: 'https://travel.apps.example.net/sandbox/v1',
  })
  assert.equal(target('https://mcp-{server}.apps.example.net/s', 'a1').ok, true)
  // Two servers, two origins: their apps cannot reach each other.
  assert.notEqual(
    (target(T, 'travel') as { origin: string }).origin,
    (target(T, 'docs') as { origin: string }).origin,
  )
  for (const server of [
    'Travel',
    'my server',
    'my_server',
    'a.b',
    'evil.com#',
    'x/../y',
    '-travel',
    'travel-',
    '',
    'a'.repeat(64),
    'ünï',
    '{server}',
  ]) {
    assert.deepEqual(target(T, server), { ok: false, reason: 'server-name' }, server)
  }
  // A whole label of at most 63 characters, prefix and suffix included.
  assert.deepEqual(target(`https://${'x'.repeat(60)}{server}.example.net/s`, 'abcd'), {
    ok: false,
    reason: 'server-name',
  })
  for (const url of [
    'https://apps.example.net/{server}/sandbox',
    'https://apps.example.net/sandbox?s={server}',
    'https://{server}.{server}.example.net/s',
    '{server}://apps.example.net/s',
  ]) {
    assert.deepEqual(target(url), { ok: false, reason: 'invalid' }, url)
  }
  // Even a server whose name makes the page's own host is refused.
  assert.deepEqual(target('https://{server}.example.com/s', 'agent'), {
    ok: false,
    reason: 'same-origin',
  })
})

// ── the shell (ours, the page's origin) ──────────────────────────────────────────────────────

test('guard shell: no script, the proxy’s exact URL as the only frame, its policy first', () => {
  const proxy = mcpAppSandboxProxyUrl(URL_V1, { connectDomains: ['https://api.example.com'] })
  assert.ok(proxy)
  const shell = buildMcpAppSandboxShell(proxy)
  const policy = mcpAppSandboxShellCsp(proxy)
  assert.ok(
    shell.startsWith(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}">`,
    ),
  )
  const directives = policy.split('; ')
  assert.ok(directives.includes("default-src 'none'"))
  assert.ok(directives.includes("script-src 'none'"))
  // A path with no trailing slash matches that path alone: the frame cannot be sent elsewhere.
  assert.ok(directives.includes(`frame-src ${proxy}`))
  assert.ok(!proxy.endsWith('/'))
  assert.equal(directives.filter((d) => d.startsWith('frame-src')).length, 1)
  assert.doesNotMatch(shell, /<script/i)
  const frames = [...shell.matchAll(/<iframe ([^>]*)><\/iframe>/g)]
  assert.equal(frames.length, 1)
  assert.equal(
    frames[0][1],
    `id="proxy" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" src="${proxy}"`,
  )
  assert.equal(MCP_APP_SANDBOX_FRAME_TOKENS, 'allow-scripts allow-same-origin')
  assert.doesNotMatch(
    shell,
    /allow-top-navigation|allow-popups|allow-forms|allow-modals|allow-downloads| allow="/,
  )
})

test('guard shell: refuses anything but a proxy URL this package builds', () => {
  for (const url of [
    `${URL_V1}/x" onload="alert(1)`,
    `${URL_V1}/x y`,
    `${URL_V1}/x; script-src *`,
    'javascript:alert(1)',
    `${URL_V1}/x?y`,
    "https://apps.example.net/'self'",
  ]) {
    assert.throws(() => buildMcpAppSandboxShell(url), /not a sandbox proxy URL/, url)
  }
})

// ── the page's side of the handshake ─────────────────────────────────────────────────────────

const linked = () => {
  const posts: { message: any; targetOrigin: string }[] = []
  const proxy = { name: 'proxy' }
  const link = new McpAppSandboxLink({
    origin: SANDBOX,
    html: '<p>app</p>',
    csp: { connectDomains: ['https://api.example.com', '*'] },
    post: (message, targetOrigin) => posts.push({ message, targetOrigin }),
  })
  const from = (data: unknown, source: unknown = proxy, origin = SANDBOX) =>
    link.receive({ source, origin, data }, proxy)
  return { link, posts, proxy, from }
}
const READY = { jsonrpc: '2.0', method: MCP_APP_SANDBOX_PROXY_READY, params: {} }
const RPC = { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }

test('guard link: the proxy’s window AND the sandbox origin, or nothing', () => {
  const { link, from, posts, proxy } = linked()
  // Not the proxy's window, or not the sandbox origin: dropped, whatever it says.
  assert.equal(from(READY, {}, SANDBOX), 'drop')
  assert.equal(from(READY, proxy, PAGE), 'drop')
  assert.equal(from(READY, proxy, 'null'), 'drop')
  assert.equal(from(READY, null, SANDBOX), 'drop')
  assert.equal(link.receive({ source: undefined, origin: SANDBOX, data: READY }, undefined), 'drop')
  assert.equal(posts.length, 0)
  assert.equal(link.ready, false)
  // Before the handshake, nothing reaches the bridge.
  assert.equal(from(RPC), 'drop')
  // A malformed ready is not one.
  assert.equal(from({ method: MCP_APP_SANDBOX_PROXY_READY }), 'drop')
  assert.equal(from(READY), 'ready')
  assert.equal(link.ready, true)
  assert.equal(from(RPC), 'app')
  assert.equal(from(RPC, proxy, PAGE), 'drop')
  assert.equal(from(RPC, {}, SANDBOX), 'drop')
})

test('guard link: the app once, on the first ready, to the sandbox origin - never *', () => {
  const { link, from, posts } = linked()
  from(READY)
  assert.deepEqual(posts, [
    {
      message: {
        jsonrpc: '2.0',
        method: MCP_APP_SANDBOX_RESOURCE_READY,
        params: {
          html: '<p>app</p>',
          csp: { connectDomains: ['https://api.example.com'], resourceDomains: [] },
        },
      },
      targetOrigin: SANDBOX,
    },
  ])
  link.post({ jsonrpc: '2.0', id: 1, result: {} })
  assert.equal(posts.length, 2)
  for (const p of posts) assert.equal(p.targetOrigin, SANDBOX)
})

test('guard link: a second ready is the proxy loaded again - broken, and silent from then on', () => {
  const { link, from, posts } = linked()
  link.post({ early: true })
  assert.equal(posts.length, 0, 'nothing is posted before the handshake')
  from(READY)
  assert.equal(from(READY), 'broken')
  assert.equal(link.broken, true)
  assert.equal(posts.length, 1, 'the app is never sent again')
  assert.equal(from(RPC), 'drop')
  assert.equal(from(READY), 'drop')
  link.post({ jsonrpc: '2.0', id: 1, result: {} })
  assert.equal(posts.length, 1)
})

test('guard link: the reserved sandbox-* messages never reach the bridge', () => {
  const { from, link } = linked()
  from(READY)
  for (const method of [
    MCP_APP_SANDBOX_RESOURCE_READY,
    'ui/notifications/sandbox-anything',
    'ui/notifications/sandbox-proxy-ready-later',
  ]) {
    assert.equal(from({ jsonrpc: '2.0', method, params: {} }), 'drop', method)
  }
  assert.equal(link.ready, true, 'none of them broke the link')
  link.close()
  assert.equal(from(RPC), 'drop')
})

// ── the sandbox page's script, with stand-ins for the windows ────────────────────────────────

interface FakeWindow {
  name: string
  parent: FakeWindow
  origin?: string
  posted: { data: any; target: string }[]
  postMessage: (data: unknown, target: string) => void
}
const fakeWindow = (name: string, parent?: FakeWindow): FakeWindow => {
  const w: FakeWindow = {
    name,
    parent: undefined as unknown as FakeWindow,
    posted: [],
    postMessage: (data, target) => w.posted.push({ data, target }),
  }
  w.parent = parent ?? w
  return w
}

const harness = (
  hostEntries: string | string[] = 'https://agent.example.com https://*-agents.example.workers.dev',
  { framed = true }: { framed?: boolean } = {},
) => {
  const host = fakeWindow('host')
  const shell = fakeWindow('shell', host)
  const me = fakeWindow('proxy', framed ? shell : undefined) as FakeWindow & {
    addEventListener: (type: string, fn: (e: unknown) => void) => void
  }
  me.origin = SANDBOX
  const app = fakeWindow('app', me)
  let listener: ((e: { source: unknown; origin: string; data: unknown }) => void) | undefined
  me.addEventListener = (type, fn) => {
    if (type === 'message') listener = fn as typeof listener
  }
  const frames: { attrs: Record<string, string>; id?: string; written: string[] }[] = []
  const hosts = parseMcpAppSandboxHosts(hostEntries)
  const page = mcpAppSandboxPage(hosts)
  const data = /<script type="application\/json" id="mcp-app-sandbox-hosts">([^<]*)<\/script>/.exec(
    page,
  )?.[1]
  assert.ok(data, 'the page carries the hosts as data')
  const document = {
    getElementById: (id: string) => (id === 'mcp-app-sandbox-hosts' ? { textContent: data } : null),
    createElement: (tag: string) => {
      assert.equal(tag, 'iframe')
      const frame = {
        attrs: {} as Record<string, string>,
        id: undefined as string | undefined,
        written: [] as string[],
        setAttribute(name: string, value: string) {
          frame.attrs[name] = value
        },
        contentWindow: app,
        contentDocument: {
          open: () => frame.written.push('<open>'),
          write: (html: string) => frame.written.push(html),
          close: () => frame.written.push('<close>'),
        },
      }
      return frame
    },
    body: { appendChild: (f: (typeof frames)[number]) => frames.push(f) },
  }
  // The script as the page runs it: `window` and `document` are the stand-ins.
  new Function('window', 'document', MCP_APP_SANDBOX_SCRIPT)(me, document)
  const send = (source: unknown, origin: string, message: unknown) =>
    listener?.({ source, origin, data: message })
  return { host, shell, me, app, frames, send, listening: Boolean(listener) }
}
const RESOURCE = (html = '<p>app</p>', extra: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  method: MCP_APP_SANDBOX_RESOURCE_READY,
  params: { html, ...extra },
})

test('guard proxy: announces itself to its ancestors with nothing in it, and only when framed', () => {
  const h = harness()
  for (const w of [h.shell, h.host]) {
    assert.deepEqual(w.posted, [
      { data: { jsonrpc: '2.0', method: MCP_APP_SANDBOX_PROXY_READY, params: {} }, target: '*' },
    ])
  }
  assert.equal(h.frames.length, 0, 'no frame before the app arrives')
  const top = harness(undefined, { framed: false })
  assert.equal(top.listening, false, 'opened on its own, it does nothing')
})

test('guard proxy: takes the app only from an ancestor on an allowed origin, once', () => {
  const h = harness()
  h.send({}, PAGE, RESOURCE()) // a window that is not an ancestor
  h.send(h.app, SANDBOX, RESOURCE()) // a descendant (the app's own window)
  h.send(h.host, 'https://evil.example', RESOURCE()) // an ancestor on an origin not allowed
  h.send(h.host, PAGE, { ...RESOURCE(), jsonrpc: '1.0' })
  h.send(h.host, PAGE, { jsonrpc: '2.0', method: MCP_APP_SANDBOX_RESOURCE_READY, params: {} })
  h.send(h.host, PAGE, RPC)
  assert.equal(h.frames.length, 0)
  // The page (the shell between them runs no script) - and a host's wishes for the frame are not
  // honoured: no other sandbox, no permission.
  h.send(
    h.host,
    PAGE,
    RESOURCE('<p>app</p>', {
      sandbox: 'allow-scripts allow-same-origin allow-top-navigation allow-popups',
      permissions: { camera: {} },
      csp: { connectDomains: ['*'] },
    }),
  )
  assert.equal(h.frames.length, 1)
  assert.deepEqual(h.frames[0].attrs, {
    sandbox: 'allow-scripts allow-same-origin',
    referrerpolicy: 'no-referrer',
    title: 'MCP App',
  })
  assert.deepEqual(h.frames[0].written, ['<open>', '<p>app</p>', '<close>'])
  // Once: a second app is not written, by that window or any other.
  h.send(h.host, PAGE, RESOURCE('<p>second</p>'))
  h.send(h.shell, PAGE, RESOURCE('<p>third</p>'))
  assert.equal(h.frames.length, 1)
  assert.deepEqual(h.frames[0].written, ['<open>', '<p>app</p>', '<close>'])
})

test('guard proxy: relays the bound host and the app to each other, to exact origins, nothing reserved', () => {
  const h = harness()
  h.send(h.host, PAGE, RESOURCE())
  const fromApp = { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }
  const fromHost = { jsonrpc: '2.0', id: 1, result: {} }
  h.send(h.app, SANDBOX, fromApp)
  h.send(h.host, PAGE, fromHost)
  // Dropped: the app from another origin, a reserved message either way, another window, the
  // host's window from another origin, the shell (an ancestor, not the bound host).
  h.send(h.app, 'null', fromApp)
  h.send(h.app, SANDBOX, { jsonrpc: '2.0', method: MCP_APP_SANDBOX_PROXY_READY })
  h.send(h.host, PAGE, { jsonrpc: '2.0', method: 'ui/notifications/sandbox-x', params: {} })
  h.send({}, PAGE, fromHost)
  h.send(h.host, 'https://evil.example', fromHost)
  h.send(h.shell, PAGE, fromHost)
  assert.deepEqual(h.host.posted.slice(1), [{ data: fromApp, target: PAGE }])
  assert.deepEqual(h.app.posted, [{ data: fromHost, target: SANDBOX }])
})

test('guard proxy hosts: exact origins and one-label patterns - the same answer in the script', () => {
  const entries =
    'https://agent.example.com, https://*-agents.example.workers.dev\nhttp://127.0.0.1:4173'
  const hosts = parseMcpAppSandboxHosts(entries)
  assert.deepEqual(hosts.origins, ['https://agent.example.com', 'http://127.0.0.1:4173'])
  assert.deepEqual(hosts.patterns, [{ prefix: '', suffix: '-agents', rest: 'example.workers.dev' }])
  // frame-ancestors cannot say "one label": the pattern is widened there, the script holds it.
  assert.deepEqual(hosts.frameAncestors, [
    'https://agent.example.com',
    'https://*.example.workers.dev',
    'http://127.0.0.1:4173',
  ])
  assert.deepEqual(hosts.invalid, [])
  const cases: [string, boolean][] = [
    ['https://agent.example.com', true],
    ['http://127.0.0.1:4173', true],
    ['https://0a1b2c3d-agents.example.workers.dev', true],
    ['https://feature-x-agents.example.workers.dev', true],
    ['https://-agents.example.workers.dev', false],
    ['https://agents.example.workers.dev', false],
    ['https://a.b-agents.example.workers.dev', false],
    ['https://x-agents.example.workers.dev.evil.com', false],
    ['https://x-agents.example.workers.dev:8443', false],
    ['http://x-agents.example.workers.dev', false],
    ['https://x-agentsx.example.workers.dev', false],
    ['https://agent.example.com.evil.com', false],
    ['https://evil-agent.example.com', false],
    ['http://agent.example.com', false],
    ['http://127.0.0.1:4174', false],
    ['null', false],
    [`https://${'a'.repeat(60)}-agents.example.workers.dev`, false],
  ]
  for (const [origin, ok] of cases) {
    assert.equal(isMcpAppSandboxHost(hosts, origin), ok, origin)
    const h = harness(entries)
    h.send(h.host, origin, RESOURCE())
    assert.equal(h.frames.length, ok ? 1 : 0, `the script, ${origin}`)
  }
})

test('guard proxy hosts: anything but an origin or a one-label pattern is invalid', () => {
  for (const entry of [
    'http://agent.example.com',
    'https://agent.example.com/path',
    'https://agent.example.com?x',
    '*',
    'https://*',
    'https://*.com',
    'https://**.example.com',
    'https://a*b*.example.com',
    'https://a.*.example.com',
    'https://*.example.com:8443',
    "'self'",
    'agent.example.com',
    'https://exa mple.com',
    'http://[::1]:8080',
  ]) {
    assert.deepEqual(parseMcpAppSandboxHosts([entry]).invalid, [entry], entry)
  }
  // A setting string is a list: separated by spaces, commas or lines.
  assert.deepEqual(parseMcpAppSandboxHosts('https://a.example.com,https://b.example.com').origins, [
    'https://a.example.com',
    'https://b.example.com',
  ])
  assert.deepEqual(parseMcpAppSandboxHosts(undefined), {
    origins: [],
    patterns: [],
    frameAncestors: [],
    invalid: [],
  })
})

// ── the sandbox page's server ────────────────────────────────────────────────────────────────

const HOSTS = 'https://agent.example.com https://*-agents.example.workers.dev'
const serve = (path: string, init?: RequestInit, hosts: string | string[] | undefined = HOSTS) =>
  mcpAppSandboxResponse(new Request(`${SANDBOX}${path}`, init), { path: '/sandbox/v1', hosts })
const POLICY = { connect: ['https://api.example.com'], resources: ['https://cdn.example.com'] }
const TOKEN = mcpAppPolicyToken(POLICY) as string

test('guard server: the page with the app’s policy as a header, framed only by the hosts', async () => {
  const res = serve(`/sandbox/v1/${TOKEN}`)
  assert.equal(res.status, 200)
  const headers = Object.fromEntries(res.headers)
  assert.equal(
    headers['content-security-policy'],
    `${mcpAppPolicy(POLICY)}; frame-ancestors https://agent.example.com https://*.example.workers.dev`,
  )
  assert.equal(headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['cache-control'], 'no-store')
  assert.equal(headers['referrer-policy'], 'no-referrer')
  assert.equal(headers['x-robots-tag'], 'noindex, nofollow')
  assert.equal(headers['permissions-policy'], MCP_APP_SANDBOX_PERMISSIONS_POLICY)
  assert.equal(headers['x-frame-options'], undefined, 'frame-ancestors decides')
  const expected = Object.entries(mcpAppSandboxHeaders(POLICY, parseMcpAppSandboxHosts(HOSTS)))
  assert.deepEqual(headers, Object.fromEntries(expected.map(([k, v]) => [k.toLowerCase(), v])))
  const body = await res.text()
  assert.equal(body, mcpAppSandboxPage(parseMcpAppSandboxHosts(HOSTS)))
  assert.ok(body.includes(`<script>${MCP_APP_SANDBOX_SCRIPT}</script>`))
  // The policy is the host's frame's policy for the same declaration, and nothing else.
  assert.equal(
    mcpAppPolicy(POLICY),
    mcpAppCsp({ connectDomains: POLICY.connect, resourceDomains: POLICY.resources }),
  )
  const head = serve(`/sandbox/v1/${TOKEN}`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal(head.headers.get('content-security-policy'), headers['content-security-policy'])
})

test('guard server: only GET / HEAD of a policy page; 404 elsewhere; a bad token, no page', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    const res = serve(`/sandbox/v1/${TOKEN}`, { method })
    assert.equal(res.status, 405, method)
    assert.equal(res.headers.get('allow'), 'GET, HEAD')
  }
  for (const path of [
    '/',
    '/sandbox',
    '/sandbox/v1',
    '/sandbox/v1/',
    `/sandbox/v1/${TOKEN}/x`,
    `/sandbox/v2/${TOKEN}`,
    `/sandbox/v1${TOKEN}`,
    '/robots.txt',
  ]) {
    const res = serve(path)
    assert.equal(res.status, 404, path)
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(
      res.headers.get('content-security-policy'),
      "default-src 'none'; frame-ancestors 'none'",
    )
  }
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  for (const token of [
    enc({ c: ['*'], r: [] }),
    enc({ c: ["'unsafe-eval'"], r: [] }),
    'x+y',
    'A',
  ]) {
    const res = serve(`/sandbox/v1/${encodeURIComponent(token)}`)
    assert.equal(res.status, 400, token)
    assert.doesNotMatch(await res.text(), /<script/)
  }
})

test('guard server: no valid host, or one invalid entry, and nobody gets a page (503)', () => {
  for (const hosts of [undefined, '', [], 'http://agent.example.com', `${HOSTS} *`]) {
    const res = mcpAppSandboxResponse(new Request(`${SANDBOX}/sandbox/v1/${TOKEN}`), {
      path: '/sandbox/v1',
      hosts,
    })
    assert.equal(res.status, 503, JSON.stringify(hosts))
    assert.equal(
      res.headers.get('content-security-policy'),
      "default-src 'none'; frame-ancestors 'none'",
    )
  }
  assert.equal(serve(`/sandbox/v1/${TOKEN}`, undefined, ['https://agent.example.com']).status, 200)
})

test('guard page: the hosts are data, not script - an entry cannot close the element', () => {
  const page = mcpAppSandboxPage({
    origins: ['https://a.example.com'],
    patterns: [{ prefix: '</script><script>alert(1)//', suffix: '', rest: 'x.y' }],
    frameAncestors: [],
    invalid: [],
  })
  assert.equal((page.match(/<script/g) ?? []).length, 2)
  assert.equal((page.match(/<\/script>/g) ?? []).length, 2)
  assert.ok(page.startsWith('<!doctype html><html><head><meta charset="utf-8">'))
  assert.ok(page.includes('<meta name="robots" content="noindex">'))
})
