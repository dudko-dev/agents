import {
  isMcpAppSandboxMessage,
  MCP_APP_POLICY_MAX_ORIGINS,
  MCP_APP_POLICY_TOKEN_MAX_CHARS,
  MCP_APP_SANDBOX_PROXY_READY,
  MCP_APP_SANDBOX_RESOURCE_READY,
  mcpAppPolicy,
  mcpAppPolicyOfToken,
  mcpAppPolicyOrigin,
  mcpAppPolicyToken,
  type McpAppPolicyOrigins,
} from './mcp-app-policy.js'

/**
 * The `./mcp-app-sandbox` entry: the MCP Apps sandbox proxy - the page a host serves on ANOTHER
 * origin, so that an app runs on an origin of its own (storage, cookies, a real `Origin`) and not
 * in an opaque one. Framework-free, no imports but `mcp-app-policy.ts`: a Cloudflare Worker, Deno,
 * Bun or Node (18+) serves it with `mcpAppSandboxResponse` (Request in, Response out).
 *
 * The page, `<base>/<policy>` (`<policy>` = `mcpAppPolicyToken`):
 *
 *  1. Its response carries the app's policy as a HEADER, built from the path (`mcpAppPolicy`), plus
 *     `frame-ancestors` = the allowed host origins. The app's document is written into a frame
 *     the page creates (`about:blank`, `document.write`), which INHERITS that policy - nothing the
 *     app's markup says comes before it, and every document the app can reach on this origin
 *     (this page, a reload of it, a frame of it) has a policy some host chose for that frame.
 *  2. Its script binds to the first ANCESTOR window on an allowed host origin that sends it
 *     `ui/notifications/sandbox-resource-ready`, once; after that it relays the extension's
 *     messages between that window (to its exact origin) and the app's window (to this origin),
 *     never the `ui/notifications/sandbox-*` ones, and creates nothing else. It asks for
 *     `ui/notifications/sandbox-proxy-ready` with a content-free message to every ancestor.
 *  3. The app's frame: `sandbox="allow-scripts allow-same-origin"`, no `allow` attribute. The app
 *     is same-origin with this page and can reach it - which is why the boundary is not here but
 *     in what the HOST draws around it (the frame's sandbox, the shell's `frame-src` pinned to
 *     this URL) and in the policy header above. A `sandbox`, `csp` or `permissions` the host sends
 *     is ignored: the header is the policy, and no permission is ever granted.
 */

export {
  isMcpAppSandboxMessage,
  MCP_APP_POLICY_MAX_ORIGINS,
  MCP_APP_POLICY_TOKEN_MAX_CHARS,
  MCP_APP_SANDBOX_PROXY_READY,
  MCP_APP_SANDBOX_RESOURCE_READY,
  mcpAppPolicy,
  mcpAppPolicyOfToken,
  mcpAppPolicyOrigin,
  mcpAppPolicyToken,
}
export type { McpAppPolicyOrigins }

/** A host origin pattern: `https://<prefix>*<suffix>.<rest>`, `*` one run of `[a-z0-9-]`. */
export interface McpAppSandboxHostPattern {
  prefix: string
  suffix: string
  /** The rest of the host name after the first label: two labels at least. */
  rest: string
}

/** The host origins a sandbox page answers, as `parseMcpAppSandboxHosts` reads them. */
export interface McpAppSandboxHosts {
  /** Exact origins (`https://agent.example.com`, `http://127.0.0.1:4173`). */
  origins: string[]
  /** One-label patterns (`https://*-agents.example.workers.dev`). */
  patterns: McpAppSandboxHostPattern[]
  /** The same as `frame-ancestors` sources (a pattern widened to `https://*.<rest>`). */
  frameAncestors: string[]
  /** Entries that are neither: a sandbox with any of these refuses to serve (503). */
  invalid: string[]
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const NAME = `${LABEL}(?:\\.${LABEL})+`
const EXACT_HTTPS = new RegExp(`^https://${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?$`)
const EXACT_LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/
const PATTERN = new RegExp(`^https://([a-z0-9-]{0,40})\\*([a-z0-9-]{0,40})\\.(${NAME})$`)

/**
 * The allowed host origins, from a list or a space / comma separated string (a deploy-time
 * setting, e.g. `ALLOWED_HOST_ORIGINS="https://agent.example.com https://*-agents.example.workers.dev"`).
 * An entry is an exact origin - `https://`, or `http://` on `localhost` / `127.0.0.1` - or a
 * pattern with ONE `*` inside the first label of an `https://` host. The page's script holds the
 * pattern to one label (`[a-z0-9-]+`, no dot); `frame-ancestors` cannot say that, so there the
 * pattern is widened to `https://*.<rest>` (every subdomain of `<rest>`). Anything else is
 * `invalid`.
 */
export const parseMcpAppSandboxHosts = (
  value: string | readonly string[] | undefined,
): McpAppSandboxHosts => {
  const entries = (typeof value === 'string' ? value.split(/[\s,]+/) : [...(value ?? [])])
    .map((e) => (typeof e === 'string' ? e.trim() : ''))
    .filter(Boolean)
  const hosts: McpAppSandboxHosts = { origins: [], patterns: [], frameAncestors: [], invalid: [] }
  const ancestor = (source: string) => {
    if (!hosts.frameAncestors.includes(source)) hosts.frameAncestors.push(source)
  }
  for (const raw of entries) {
    const entry = raw.toLowerCase().replace(/\/$/, '')
    const pattern = PATTERN.exec(entry)
    if (pattern) {
      const [, prefix, suffix, rest] = pattern
      if (
        !hosts.patterns.some((p) => p.prefix === prefix && p.suffix === suffix && p.rest === rest)
      ) {
        hosts.patterns.push({ prefix, suffix, rest })
      }
      ancestor(`https://*.${rest}`)
    } else if (EXACT_HTTPS.test(entry) || EXACT_LOOPBACK.test(entry)) {
      if (!hosts.origins.includes(entry)) hosts.origins.push(entry)
      ancestor(entry)
    } else {
      hosts.invalid.push(raw.slice(0, 120))
    }
  }
  return hosts
}

/** Whether an origin is one of the hosts (the same rule the page's script applies). */
export const isMcpAppSandboxHost = (hosts: McpAppSandboxHosts, origin: string): boolean => {
  if (hosts.origins.includes(origin)) return true
  const head = 'https://'
  for (const p of hosts.patterns) {
    const tail = `.${p.rest}`
    if (!origin.startsWith(head) || !origin.endsWith(tail)) continue
    const label = origin.slice(head.length, origin.length - tail.length)
    if (label.length > 63 || !label.startsWith(p.prefix) || !label.endsWith(p.suffix)) continue
    const middle = label.slice(p.prefix.length, label.length - p.suffix.length)
    if (/^[a-z0-9-]+$/.test(middle)) return true
  }
  return false
}

/**
 * The page's script (inline; it runs under the app's own policy, which allows inline scripts).
 * It reads the hosts from `#mcp-app-sandbox-hosts`, binds to the first allowed ancestor that sends
 * the resource, writes the app into its frame, and relays - see the entry's comment.
 */
export const MCP_APP_SANDBOX_SCRIPT = `(function () {
  'use strict'
  var READY = ${JSON.stringify(MCP_APP_SANDBOX_PROXY_READY)}
  var RESOURCE = ${JSON.stringify(MCP_APP_SANDBOX_RESOURCE_READY)}
  var RESERVED = 'ui/notifications/sandbox-'
  var me = window
  if (me.parent === me) return
  var cfg
  try {
    cfg = JSON.parse(document.getElementById('mcp-app-sandbox-hosts').textContent)
  } catch (e) {
    return
  }
  var origins = cfg && Array.isArray(cfg.origins) ? cfg.origins : []
  var patterns = cfg && Array.isArray(cfg.patterns) ? cfg.patterns : []
  function allowed(origin) {
    if (typeof origin !== 'string') return false
    if (origins.indexOf(origin) >= 0) return true
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i]
      var head = 'https://'
      var tail = '.' + p.rest
      if (origin.indexOf(head) !== 0 || origin.length <= head.length + tail.length) continue
      if (origin.slice(origin.length - tail.length) !== tail) continue
      var label = origin.slice(head.length, origin.length - tail.length)
      if (label.length > 63 || label.indexOf(p.prefix) !== 0) continue
      if (label.slice(label.length - p.suffix.length) !== p.suffix) continue
      if (/^[a-z0-9-]+$/.test(label.slice(p.prefix.length, label.length - p.suffix.length))) return true
    }
    return false
  }
  var ancestors = []
  for (var w = me.parent; ancestors.length < 32; w = w.parent) {
    ancestors.push(w)
    if (w === w.parent) break
  }
  function ancestor(source) {
    for (var i = 0; i < ancestors.length; i++) if (ancestors[i] === source) return true
    return false
  }
  function reserved(d) {
    return !!d && typeof d === 'object' && typeof d.method === 'string' && d.method.indexOf(RESERVED) === 0
  }
  var OWN = me.origin
  var host = null
  var hostOrigin = ''
  var app = null
  me.addEventListener('message', function (e) {
    var d = e.data
    if (app && e.source === app) {
      if (e.origin !== OWN || reserved(d)) return
      host.postMessage(d, hostOrigin)
      return
    }
    if (host) {
      if (e.source !== host || e.origin !== hostOrigin || reserved(d) || !app) return
      app.postMessage(d, OWN)
      return
    }
    if (!d || typeof d !== 'object' || d.jsonrpc !== '2.0' || d.method !== RESOURCE) return
    if (!ancestor(e.source) || !allowed(e.origin)) return
    var p = d.params
    if (!p || typeof p !== 'object' || typeof p.html !== 'string') return
    host = e.source
    hostOrigin = e.origin
    var frame = document.createElement('iframe')
    frame.id = 'app'
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.setAttribute('title', 'MCP App')
    document.body.appendChild(frame)
    app = frame.contentWindow
    var doc = frame.contentDocument
    doc.open()
    doc.write(p.html)
    doc.close()
  })
  var ready = { jsonrpc: '2.0', method: READY, params: {} }
  for (var i = 0; i < ancestors.length; i++) ancestors[i].postMessage(ready, '*')
})()`

const json = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

/** The page: the hosts as data, the script. Serve it with `mcpAppSandboxHeaders`. */
export const mcpAppSandboxPage = (hosts: McpAppSandboxHosts): string =>
  '<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">' +
  '<title>MCP App sandbox</title>' +
  '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}' +
  'iframe{display:block;border:0;width:100%;height:100%}</style></head><body>' +
  `<script type="application/json" id="mcp-app-sandbox-hosts">${json({
    origins: hosts.origins,
    patterns: hosts.patterns,
  })}</script>` +
  `<script>${MCP_APP_SANDBOX_SCRIPT}</script></body></html>`

/** Browser features the page and the app may never use, whatever an app asks for. */
export const MCP_APP_SANDBOX_PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), midi=()'

const COMMON = {
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

/**
 * The page's response headers: the app's policy AND `frame-ancestors` (the hosts; `'none'` when
 * there are none), `nosniff`, `no-store` (a policy is never served from a stale copy), no referrer,
 * `noindex`, and a Permissions-Policy that grants nothing.
 */
export const mcpAppSandboxHeaders = (
  policy: McpAppPolicyOrigins,
  hosts: McpAppSandboxHosts,
): Record<string, string> => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': `${mcpAppPolicy(policy)}; frame-ancestors ${
    hosts.frameAncestors.length > 0 ? hosts.frameAncestors.join(' ') : "'none'"
  }`,
  'Permissions-Policy': MCP_APP_SANDBOX_PERMISSIONS_POLICY,
  ...COMMON,
})

export interface McpAppSandboxServeOptions {
  /** Where the pages are: `'/sandbox/v1'` serves `/sandbox/v1/<policy>`. */
  path: string
  /** The host origins that may frame the page and send it an app (see `parseMcpAppSandboxHosts`). */
  hosts: string | readonly string[] | undefined
}

const plain = (status: number, text: string, extra: Record<string, string> = {}): Response =>
  new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      ...COMMON,
      ...extra,
    },
  })

/**
 * A fetch handler for the sandbox page: `GET` / `HEAD` of `<path>/<policy>` is the page, with its
 * headers; a token that is not exactly what `mcpAppPolicyToken` writes is 400; another method 405;
 * any other path 404; no valid host origin (or an invalid entry in the setting) 503 - a sandbox
 * nobody may frame is a configuration error, not a page.
 */
export const mcpAppSandboxResponse = (
  request: Request,
  options: McpAppSandboxServeOptions,
): Response => {
  const { pathname } = new URL(request.url)
  const base = options.path.replace(/\/+$/, '')
  if (!pathname.startsWith(`${base}/`)) return plain(404, 'Not found')
  const token = pathname.slice(base.length + 1)
  if (token.length === 0 || token.includes('/')) return plain(404, 'Not found')
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return plain(405, 'Method not allowed', { Allow: 'GET, HEAD' })
  }
  const policy = mcpAppPolicyOfToken(token)
  if (!policy) return plain(400, 'Not a policy this sandbox serves')
  const hosts = parseMcpAppSandboxHosts(options.hosts)
  if (hosts.invalid.length > 0 || hosts.frameAncestors.length === 0) {
    return plain(503, 'This sandbox has no valid allowed host origins')
  }
  return new Response(request.method === 'HEAD' ? null : mcpAppSandboxPage(hosts), {
    status: 200,
    headers: mcpAppSandboxHeaders(policy, hosts),
  })
}
