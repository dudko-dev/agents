import { mcpAppOrigin, type McpAppCsp } from '@dudko.dev/agent-web'
import { cspMetaTag, escapeAttribute, withPolicyFirst } from './html-preview.js'
import {
  isMcpAppSandboxMessage,
  MCP_APP_SANDBOX_PROXY_READY,
  MCP_APP_SANDBOX_RESOURCE_READY,
  mcpAppPolicy,
  mcpAppPolicyToken,
} from './mcp-app-policy.js'

/**
 * MCP Apps, the host's side: the security core of `<McpAppFrame>`, as pure code - no React, no
 * DOM - so every guard is unit-tested (`tests/apps.test.ts`) and proved in a real browser
 * (`e2e/apps.spec.ts`).
 *
 * The frame: an app is third-party HTML WITH scripts that must talk to the page, so it gets the
 * HTML preview's boundary (`html-preview.ts`) and one addition, a relay:
 *
 *  1. The outer `<iframe sandbox="allow-scripts">` (never `allow-same-origin`): an opaque origin,
 *     no access to the page's DOM, storage, IndexedDB (the key vault) or cookies; no top
 *     navigation, popups, forms, modals, downloads. No `allow` attribute: no camera, microphone,
 *     geolocation or clipboard, whatever the app asked for.
 *  2. It holds a SHELL of ours (`buildMcpAppDocument`): the policy built from the resource's
 *     declared origins and nothing else (`mcpAppCsp`), one inner frame - the app, also
 *     `sandbox="allow-scripts"`, with the same policy first in its own document - and a relay
 *     script. The shell's `frame-src 'none'` is what stops the app navigating itself (a frame
 *     may always navigate itself; only the EMBEDDING document's policy decides where to).
 *  3. The relay forwards messages between the page and the app, and nothing else: from the
 *     app's window to the page, from the page to the app's window, never the
 *     `ui/notifications/sandbox-*` messages the specification reserves. The app talks to
 *     `window.parent` as the extension's SDK does; the page accepts messages only from the outer
 *     frame (`event.source`), so the app writing to `window.top` directly is ignored.
 *  4. The bridge (`McpAppBridge`) answers the app: a method allow-list, checked parameters, a
 *     cap on requests in flight, and every request that DOES something (a tool call, a link, a
 *     message) handed to the host, which asks the user.
 *
 * That is the default. Opt-in, the app runs on an origin of its own instead, behind a sandbox
 * page the host serves on another origin (the specification's "sandbox proxy"): 1 - 3 change
 * (see "An app on an origin of its own" below and `mcp-app-policy.ts`), 4 does not.
 */

/** The revision of the extension this host speaks. */
export const MCP_APP_PROTOCOL_VERSION = '2026-01-26'

/** An app's frame height, before it says how tall it is. */
export const APP_DEFAULT_HEIGHT = 360
/** The frame's height is the host's: the app's wish, clamped to these. */
export const APP_MIN_HEIGHT = 120
export const APP_MAX_HEIGHT = 800

/** At most this many requests of one app wait at once (tool calls, links, messages). */
export const MCP_APP_MAX_IN_FLIGHT = 3
/** A message an app puts in the chat: at most this many characters. */
export const MCP_APP_MAX_MESSAGE_CHARS = 4000
/** A link an app asks to open: at most this many characters. */
export const MCP_APP_MAX_URL_CHARS = 2048
/** The arguments of a tool call an app makes: at most this many characters as JSON. */
export const MCP_APP_MAX_ARGS_CHARS = 64_000

export const clampAppHeight = (height: number): number =>
  Math.min(
    APP_MAX_HEIGHT,
    Math.max(APP_MIN_HEIGHT, Math.round(Number.isFinite(height) ? height : APP_DEFAULT_HEIGHT)),
  )

/** The declared origins of a list that are origins (re-checked here: whoever built the object). */
const origins = (list: readonly string[] | undefined): string[] => {
  const out: string[] = []
  for (const entry of list ?? []) {
    const origin = mcpAppOrigin(entry)
    if (origin && !out.includes(origin)) out.push(origin)
  }
  return out
}

/**
 * The policy of an app's document: scripts and styles inline, `data:` / `blob:` media, and the
 * network ONLY where the resource declared it - `connectDomains` for `fetch` / XHR / WebSocket,
 * `resourceDomains` for scripts, styles, images, fonts and media. Nothing declared, nothing
 * reached. Nested frames, workers, plugins, forms and `<base>` are refused whatever was declared
 * (`frameDomains` / `baseUriDomains` are not granted: a frame the app may embed would also be a
 * place it may navigate itself to). Each entry is checked again with the core's `mcpAppOrigin`.
 */
export const mcpAppCsp = (csp?: Partial<McpAppCsp>): string =>
  mcpAppPolicy({ connect: origins(csp?.connectDomains), resources: origins(csp?.resourceDomains) })

/** The origins the policy actually grants: what the app is told in `hostCapabilities.sandbox`. */
export const grantedAppCsp = (
  csp?: Partial<McpAppCsp>,
): { connectDomains: string[]; resourceDomains: string[] } => ({
  connectDomains: origins(csp?.connectDomains),
  resourceDomains: origins(csp?.resourceDomains),
})

/**
 * The relay of the shell: the app's messages to the page, the page's to the app - matched by
 * `event.source`, never by anything the message says - and not the reserved
 * `ui/notifications/sandbox-*` ones. It reads nothing else and runs nothing it is sent.
 */
export const MCP_APP_RELAY =
  "(function(){var f=document.getElementById('app');" +
  "function reserved(d){return !!d&&typeof d.method==='string'&&d.method.indexOf('ui/notifications/sandbox-')===0}" +
  "addEventListener('message',function(e){var w=f&&f.contentWindow;if(!w||reserved(e.data))return;" +
  "if(e.source===w){parent.postMessage(e.data,'*')}else if(e.source===parent){w.postMessage(e.data,'*')}})})()"

/**
 * What goes into the OUTER frame's `srcdoc`: the shell (the app's policy first, one inner frame
 * that fills it, the relay) carrying the app, escaped, as the inner frame's `srcdoc` - with the
 * same policy first in it. Give the outer `<iframe>` `sandbox="allow-scripts"` and nothing else.
 */
export const buildMcpAppDocument = (html: string, csp?: Partial<McpAppCsp>): string => {
  const policy = mcpAppCsp(csp)
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">` +
    '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}' +
    'iframe{display:block;border:0;width:100%;height:100%}</style></head><body>' +
    `<iframe id="app" sandbox="allow-scripts" referrerpolicy="no-referrer" ` +
    `srcdoc="${escapeAttribute(withPolicyFirst(html, policy))}"></iframe>` +
    `<script>${MCP_APP_RELAY}</script></body></html>`
  )
}

/** A link an app asks to open, taken apart for the prompt: the host is what the user checks. */
export interface AppLink {
  /** The normalised URL (what is opened). */
  href: string
  /** `https://` */
  scheme: string
  /** The host (and port), as the browser will go there - an internationalised name in punycode. */
  host: string
  /** Everything after the host. */
  rest: string
}

/** An `http(s)` URL with a host and no credentials, at most `MCP_APP_MAX_URL_CHARS`; else none. */
export const appLinkOf = (value: unknown): AppLink | undefined => {
  if (typeof value !== 'string' || value.length > MCP_APP_MAX_URL_CHARS) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username || url.password || !url.hostname) return undefined
  const scheme = `${url.protocol}//`
  return {
    href: url.href,
    scheme,
    host: url.host,
    rest: url.href.slice(scheme.length + url.host.length),
  }
}

// Characters that change how text reads without being seen (bidirectional overrides,
// zero-width) and control characters other than line breaks and tabs.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g

/**
 * The text of a `ui/message` an app sends: text blocks only (one, or a list of at most 20),
 * joined, without invisible characters, at most `MCP_APP_MAX_MESSAGE_CHARS`. Anything else -
 * an image, a resource, an empty or a longer text - is refused (`undefined`).
 */
export const appMessageTextOf = (content: unknown): string | undefined => {
  const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content]
  if (blocks.length === 0 || blocks.length > 20) return undefined
  const texts: string[] = []
  for (const block of blocks) {
    if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') {
      return undefined
    }
    texts.push(block.text)
  }
  const text = texts.join('\n\n').replace(HIDDEN, '').trim()
  return text && text.length <= MCP_APP_MAX_MESSAGE_CHARS ? text : undefined
}

type Obj = Record<string, unknown>
const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A JSON-RPC message as the bridge sends it. */
export type McpAppRpcMessage =
  | { jsonrpc: '2.0'; id: string | number; method: string; params?: unknown }
  | { jsonrpc: '2.0'; method: string; params?: unknown }
  | { jsonrpc: '2.0'; id: string | number; result: unknown }
  | { jsonrpc: '2.0'; id: string | number; error: { code: number; message: string } }

/** The requests an app may make of this host. Any other is answered "method not found". */
export const MCP_APP_REQUESTS = [
  'ui/initialize',
  'ping',
  'tools/call',
  'ui/open-link',
  'ui/message',
  'ui/request-display-mode',
] as const
/** The notifications this host reads. Any other is dropped. */
export const MCP_APP_NOTIFICATIONS = [
  'ui/notifications/initialized',
  'ui/notifications/size-changed',
] as const

/** An error the bridge answers with: a JSON-RPC code and a message for the app. */
export class McpAppRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = 'McpAppRpcError'
  }
}

const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INVALID_REQUEST = -32600
/** The host refused: the user said no, too many requests, not initialized. */
export const MCP_APP_REFUSED = -32000

/** What the host does for an app (the user is asked inside these, never by the bridge). */
export interface McpAppBridgeHandlers {
  /** A `tools/call`: resolves with the result the app is given; throws when refused. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** A link (already checked): resolves true when it was opened, false when the user said no. */
  openLink: (link: AppLink) => Promise<boolean>
  /** A message (already cleaned): resolves true when it was accepted, false when not. */
  message: (text: string) => Promise<boolean>
  /** The app's wish for a height (the caller clamps it). */
  resize: (height: number) => void
}

export interface McpAppBridgeOptions {
  /** Send a message to the app (the page posts it to the outer frame). */
  post: (message: McpAppRpcMessage) => void
  handlers: McpAppBridgeHandlers
  hostInfo: { name: string; version: string }
  hostCapabilities: Record<string, unknown>
  hostContext: Record<string, unknown>
  /** The tool call's arguments: sent once the app says it is initialized. */
  toolInput: Record<string, unknown>
  /** Its result; `undefined` = the app is told the call was cancelled (`reason`). */
  toolResult?: unknown
  cancelledReason?: string
  maxInFlight?: number
}

const validId = (id: unknown): id is string | number =>
  (typeof id === 'string' && id.length > 0 && id.length <= 100) ||
  (typeof id === 'number' && Number.isFinite(id))

/**
 * One app's conversation with the host (the extension's JSON-RPC over `postMessage`). It never
 * touches the DOM: `receive` is given what arrived - from the right frame, the caller checked
 * `event.source` - and `post` sends. Requests outside the allow-list get "method not found";
 * before `ui/initialize`, only `ping` is answered; parameters are checked before a handler sees
 * them; at most `maxInFlight` requests run at once. The tool's input and result are sent once,
 * after the app's `ui/notifications/initialized`, as the specification requires.
 */
export class McpAppBridge {
  private readonly o: McpAppBridgeOptions
  private initializeSeen = false
  private delivered = false
  private inFlight = 0
  private closed = false
  private seq = 0

  constructor(options: McpAppBridgeOptions) {
    this.o = options
  }

  /** The app said it is ready, and was given the tool's input and result. */
  get initialized(): boolean {
    return this.delivered
  }

  /** Stop answering: the frame is gone or was reloaded. */
  close(): void {
    this.closed = true
  }

  /** Tell the app it is being torn down (not waited for: the frame goes anyway). */
  teardown(reason: string): void {
    if (!this.delivered || this.closed) return
    this.seq += 1
    this.send({
      jsonrpc: '2.0',
      id: `host-teardown-${this.seq}`,
      method: 'ui/resource-teardown',
      params: { reason },
    })
  }

  /** Tell an initialized app that part of the host context changed (the theme). */
  updateContext(patch: Record<string, unknown>): void {
    Object.assign(this.o.hostContext, patch)
    if (this.delivered && !this.closed) {
      this.send({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: patch })
    }
  }

  /** One message from the app's frame. */
  receive(data: unknown): void {
    if (this.closed || !isObject(data) || data.jsonrpc !== '2.0') return
    const method = data.method
    const id = data.id
    if (method === undefined) return // a response to a request of ours: nothing waits for it
    if (typeof method !== 'string' || method.length === 0 || method.length > 100) {
      if (validId(id)) this.error(id, INVALID_REQUEST, 'Invalid request')
      return
    }
    if (id === undefined) {
      this.notification(method, data.params)
      return
    }
    if (!validId(id)) return
    if (data.params !== undefined && !isObject(data.params)) {
      this.error(id, INVALID_PARAMS, 'params must be an object')
      return
    }
    void this.request(id, method, (data.params ?? {}) as Obj)
  }

  private send(message: McpAppRpcMessage): void {
    if (!this.closed) this.o.post(message)
  }

  private error(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private notification(method: string, params: unknown): void {
    const p = isObject(params) ? params : {}
    if (method === 'ui/notifications/initialized') {
      if (!this.initializeSeen || this.delivered) return
      this.delivered = true
      this.send({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-input',
        params: { arguments: this.o.toolInput },
      })
      this.send(
        this.o.toolResult === undefined
          ? {
              jsonrpc: '2.0',
              method: 'ui/notifications/tool-cancelled',
              params: { reason: this.o.cancelledReason ?? 'no result' },
            }
          : { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: this.o.toolResult },
      )
      return
    }
    if (method === 'ui/notifications/size-changed') {
      if (typeof p.height === 'number' && Number.isFinite(p.height) && p.height > 0) {
        this.o.handlers.resize(p.height)
      }
    }
    // Anything else (a log line, a teardown wish, an unknown one) is dropped.
  }

  private async request(id: string | number, method: string, params: Obj): Promise<void> {
    if (!(MCP_APP_REQUESTS as readonly string[]).includes(method)) {
      this.error(id, METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 60)}`)
      return
    }
    if (method === 'ping') {
      this.send({ jsonrpc: '2.0', id, result: {} })
      return
    }
    if (method === 'ui/initialize') {
      this.initializeSeen = true
      this.send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: this.o.hostInfo,
          hostCapabilities: this.o.hostCapabilities,
          hostContext: this.o.hostContext,
        },
      })
      return
    }
    if (!this.initializeSeen) {
      this.error(id, MCP_APP_REFUSED, 'The app is not initialized (send ui/initialize first)')
      return
    }
    if (method === 'ui/request-display-mode') {
      // The host decides where an app is shown; it stays where it is.
      this.send({ jsonrpc: '2.0', id, result: { mode: 'inline' } })
      return
    }
    // What remains does something the user is asked about: capped, then handed over.
    let run: (() => Promise<unknown>) | undefined
    if (method === 'tools/call') {
      const name = params.name
      const args = params.arguments === undefined ? {} : params.arguments
      if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
        this.error(id, INVALID_PARAMS, 'tools/call needs the name of a tool')
        return
      }
      if (!isObject(args)) {
        this.error(id, INVALID_PARAMS, 'tools/call arguments must be an object')
        return
      }
      let size = Infinity
      try {
        size = JSON.stringify(args).length
      } catch {
        // not serialisable: refused below
      }
      if (size > MCP_APP_MAX_ARGS_CHARS) {
        this.error(id, INVALID_PARAMS, 'tools/call arguments are too large')
        return
      }
      run = () => this.o.handlers.callTool(name, args)
    } else if (method === 'ui/open-link') {
      const link = appLinkOf(params.url)
      if (!link) {
        this.error(id, INVALID_PARAMS, 'Invalid URL: only http(s) links without credentials')
        return
      }
      run = async () => {
        if (!(await this.o.handlers.openLink(link))) {
          throw new McpAppRpcError(MCP_APP_REFUSED, 'Link opening denied by user')
        }
        return {}
      }
    } else {
      const text = params.role === 'user' ? appMessageTextOf(params.content) : undefined
      if (text === undefined) {
        this.error(
          id,
          INVALID_PARAMS,
          'Invalid message format: one user text, not empty, not too long',
        )
        return
      }
      run = async () => {
        if (!(await this.o.handlers.message(text))) {
          throw new McpAppRpcError(MCP_APP_REFUSED, 'Message sending denied')
        }
        return {}
      }
    }
    const cap = this.o.maxInFlight ?? MCP_APP_MAX_IN_FLIGHT
    if (this.inFlight >= cap) {
      this.error(id, MCP_APP_REFUSED, 'Too many requests of this app are waiting')
      return
    }
    this.inFlight += 1
    try {
      const result = await run()
      this.send({ jsonrpc: '2.0', id, result })
    } catch (err) {
      const code = err instanceof McpAppRpcError ? err.code : MCP_APP_REFUSED
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300)
      this.error(id, code, message)
    } finally {
      this.inFlight -= 1
    }
  }
}

/** What this host tells an app it can do (`hostCapabilities` of `ui/initialize`). */
export const mcpAppHostCapabilities = (csp?: Partial<McpAppCsp>): Record<string, unknown> => ({
  openLinks: {},
  serverTools: {},
  message: { text: {} },
  // What the frame grants: the declared origins it kept; no permission at all.
  sandbox: { permissions: {}, csp: grantedAppCsp(csp) },
})

// ── An app on an origin of its own: the sandbox proxy (opt-in) ──────────────────────────────
//
// The specification's web-host model: the app is not framed by a `srcdoc` of ours but by a page
// the host serves on ANOTHER origin (`./mcp-app-sandbox`), so the app gets that origin - storage,
// cookies, a real `Origin` on its requests - and never the page's. From the page down:
//
//   your page ── <iframe sandbox="allow-scripts allow-same-origin" srcdoc=SHELL>  (your origin)
//     SHELL: no script (`script-src 'none'`); `frame-src` = the proxy's exact URL
//       └─ <iframe sandbox="allow-scripts allow-same-origin" src=PROXY>           (the sandbox origin)
//            PROXY: the app's policy as a header; relays messages
//              └─ the app, written into a frame of the proxy                       (the sandbox origin)
//
// The app is same-origin with the proxy and can reach into it - make it navigate, run code in it.
// So the guards are what the app cannot reach: the frames' sandbox flags (drawn on YOUR side,
// cross-origin to the app), the shell's `frame-src`, which pins the proxy's frame to its one URL
// (any other navigation of it is refused, so nothing leaves for an origin the app did not
// declare), the policy in that URL's PATH (which the pin covers; a query would not be), and the
// page's checks below: messages only from the proxy's window AND the sandbox origin, posted to
// that origin only, one handshake. A second `sandbox-proxy-ready` means the proxy was loaded again
// - by the app - and the app is stopped. Without a sandbox URL, or when its page does not answer,
// the app runs in the opaque frame above: the stricter of the two.

/** `<AgentChat appSandbox>` / `useMcpAppHost({ sandbox })`. */
export interface McpAppSandboxOptions {
  /**
   * The sandbox page's base URL on another origin you serve (`mcpAppSandboxResponse` of the
   * `./mcp-app-sandbox` entry), e.g. `https://apps.example.com/sandbox/v1`; an app's frame loads
   * `<url>/<policy>`. `{server}` in the host name gives each server an origin of its own
   * (`https://{server}.apps.example.com/sandbox/v1`; the server's name must be a DNS label - it
   * needs a wildcard certificate). `https://` only; `http://` on `localhost` / `127.0.0.1`.
   */
  url: string
  /** How long a frame waits for the page's handshake before it falls back (default 5000 ms). */
  timeoutMs?: number
}

/** Why an app runs in the opaque frame although a sandbox URL is set. */
export type McpAppSandboxReason =
  | 'invalid'
  | 'insecure'
  | 'same-origin'
  | 'no-page-origin'
  | 'server-name'
  | 'too-many-origins'
  | 'no-answer'

export type McpAppSandboxTarget =
  { ok: true; origin: string; base: string } | { ok: false; reason: McpAppSandboxReason }

/** The placeholder for the server's name in `McpAppSandboxOptions.url`. */
export const MCP_APP_SANDBOX_SERVER = '{server}'
export const MCP_APP_SANDBOX_TIMEOUT_MS = 5000
/** After the shell has loaded (the proxy loaded or failed), the handshake gets this much longer. */
export const MCP_APP_SANDBOX_GRACE_MS = 1000
/**
 * The sandbox flags of the shell's frame and of the proxy's: scripts and an origin - the shell
 * must keep YOUR origin (else the proxy below it would get an opaque one) and runs no script; the
 * proxy is on the sandbox origin. Nothing else: no navigation, popup, form, modal, download.
 */
export const MCP_APP_SANDBOX_FRAME_TOKENS = 'allow-scripts allow-same-origin'

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
// CSP cannot name an IPv6 literal (`[::1]`): the proxy's frame could not be pinned.
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1']
// What a `frame-src` source expression's path may hold, and a URL keeps as it is.
const SAFE_PATH = /^\/[A-Za-z0-9\-._~/%]*$/

const no = (reason: McpAppSandboxReason): McpAppSandboxTarget => ({ ok: false, reason })

/**
 * Where an app of `server` runs, for a page on `pageOrigin`: the sandbox's origin and base URL,
 * or why not. Refused: not a URL; credentials, a query or a fragment; not `https://` (`http://`
 * only on `localhost` / `127.0.0.1`); a path a policy cannot name; `{server}` anywhere but the
 * host name, more than once, or a server name that is not a lowercase DNS label; a page without
 * an origin; and the sandbox on the PAGE'S OWN origin - `allow-same-origin` there would hand the
 * app your storage and the key vault.
 */
export const mcpAppSandboxTarget = (
  options: McpAppSandboxOptions | undefined,
  server: string,
  pageOrigin: string | undefined,
): McpAppSandboxTarget => {
  const template = options?.url
  if (typeof template !== 'string' || template.length === 0 || template.length > 2048) {
    return no('invalid')
  }
  const parts = template.split(MCP_APP_SANDBOX_SERVER)
  if (parts.length > 2) return no('invalid')
  let raw = template
  if (parts.length === 2) {
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(template)?.[1] ?? ''
    if (!authority.replace(/:\d*$/, '').includes(MCP_APP_SANDBOX_SERVER)) return no('invalid')
    if (typeof server !== 'string' || !DNS_LABEL.test(server)) return no('server-name')
    raw = template.replace(MCP_APP_SANDBOX_SERVER, server)
  }
  if (/[?#\s]/.test(raw)) return no('invalid')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return no('invalid')
  }
  const loopback = LOOPBACK_HOSTS.includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return no('insecure')
  if (url.username || url.password || !url.hostname) return no('invalid')
  if (!url.hostname.split('.').every((label) => DNS_LABEL.test(label))) {
    return no(parts.length === 2 ? 'server-name' : 'invalid')
  }
  if (!SAFE_PATH.test(url.pathname)) return no('invalid')
  if (!pageOrigin || pageOrigin === 'null') return no('no-page-origin')
  if (url.origin === pageOrigin) return no('same-origin')
  return { ok: true, origin: url.origin, base: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }
}

/** The proxy page's URL for an app's declared origins (`<base>/<policy>`), or none if too long. */
export const mcpAppSandboxProxyUrl = (
  base: string,
  csp?: Partial<McpAppCsp>,
): string | undefined => {
  const granted = grantedAppCsp(csp)
  const token = mcpAppPolicyToken({
    connect: granted.connectDomains,
    resources: granted.resourceDomains,
  })
  return token ? `${base}/${token}` : undefined
}

const PROXY_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9\-._~/%]*$/

/**
 * The policy of the shell: no script at all, and frames from the proxy's exact URL only - a
 * `frame-src` with a path matches that path and nothing else (the query is not part of the
 * match), so the proxy's frame can never be navigated anywhere else.
 */
export const mcpAppSandboxShellCsp = (proxyUrl: string): string =>
  [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    `frame-src ${proxyUrl}`,
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')

/**
 * What goes into the OUTER frame's `srcdoc` in sandbox mode: the shell - its policy first, one
 * frame of the proxy page, no script, nothing of the app. Give the outer `<iframe>`
 * `sandbox={MCP_APP_SANDBOX_FRAME_TOKENS}` and nothing else. Throws on a URL that is not a proxy
 * URL this package builds (`mcpAppSandboxProxyUrl`).
 */
export const buildMcpAppSandboxShell = (proxyUrl: string): string => {
  if (!PROXY_URL.test(proxyUrl)) throw new Error('not a sandbox proxy URL')
  return (
    '<!doctype html><html><head>' +
    cspMetaTag(mcpAppSandboxShellCsp(proxyUrl)) +
    '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}' +
    'iframe{display:block;border:0;width:100%;height:100%}</style></head><body>' +
    `<iframe id="proxy" sandbox="${MCP_APP_SANDBOX_FRAME_TOKENS}" referrerpolicy="no-referrer" ` +
    `src="${escapeAttribute(proxyUrl)}"></iframe></body></html>`
  )
}

/** What one message from the proxy's frame is, for the page (`McpAppSandboxLink.receive`). */
export type McpAppSandboxInput = 'drop' | 'ready' | 'broken' | 'app'

export interface McpAppSandboxLinkOptions {
  /** The sandbox origin (`mcpAppSandboxTarget(…).origin`). */
  origin: string
  /** The app, as read from its server: sent once, on the proxy's first ready. */
  html: string
  csp?: Partial<McpAppCsp>
  /** Post to the proxy's window. Always called with the sandbox origin as the target - never `*`. */
  post: (message: unknown, targetOrigin: string) => void
}

/**
 * The page's side of the sandbox proxy, without the DOM: which messages are the proxy's, the
 * handshake, and every post to the sandbox origin. A message is the proxy's only when it comes
 * from the proxy's window (`event.source`) AND from the sandbox origin (`event.origin`). The
 * first `sandbox-proxy-ready` is answered with the app (`sandbox-resource-ready`); another one
 * means the proxy page was loaded again - by the app - and the link breaks (`'broken'`: stop the
 * app). Every other `ui/notifications/sandbox-*` message is dropped; nothing reaches the bridge
 * (`'app'`) before the app was handed over.
 */
export class McpAppSandboxLink {
  private readonly o: McpAppSandboxLinkOptions
  private state: 'waiting' | 'loaded' | 'broken' | 'closed' = 'waiting'

  constructor(options: McpAppSandboxLinkOptions) {
    this.o = options
  }

  /** The proxy answered and was given the app. */
  get ready(): boolean {
    return this.state === 'loaded'
  }

  /** The proxy page was loaded a second time: the app must be stopped. */
  get broken(): boolean {
    return this.state === 'broken'
  }

  /** Whether a message event is the proxy's: its window, and the sandbox origin. */
  accepts(event: { source: unknown; origin: string }, proxy: unknown): boolean {
    return (
      proxy !== null &&
      proxy !== undefined &&
      event.source === proxy &&
      event.origin === this.o.origin
    )
  }

  receive(
    event: { source: unknown; origin: string; data: unknown },
    proxy: unknown,
  ): McpAppSandboxInput {
    if (this.state === 'broken' || this.state === 'closed' || !this.accepts(event, proxy)) {
      return 'drop'
    }
    const data = event.data
    if (isMcpAppSandboxMessage(data)) {
      const d = data as { jsonrpc?: unknown; method: string }
      if (d.jsonrpc !== '2.0' || d.method !== MCP_APP_SANDBOX_PROXY_READY) return 'drop'
      if (this.state === 'loaded') {
        this.state = 'broken'
        return 'broken'
      }
      this.state = 'loaded'
      const granted = grantedAppCsp(this.o.csp)
      this.o.post(
        {
          jsonrpc: '2.0',
          method: MCP_APP_SANDBOX_RESOURCE_READY,
          params: { html: this.o.html, csp: granted },
        },
        this.o.origin,
      )
      return 'ready'
    }
    return this.state === 'loaded' ? 'app' : 'drop'
  }

  /** Send a message to the app, through the proxy, to the sandbox origin. Nothing once broken. */
  post(message: unknown): void {
    if (this.state === 'loaded') this.o.post(message, this.o.origin)
  }

  close(): void {
    if (this.state !== 'broken') this.state = 'closed'
  }
}
