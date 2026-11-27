import { mcpAppOrigin, type McpAppCsp } from '@dudko.dev/agent-web'
import { escapeAttribute, withPolicyFirst } from './html-preview.js'

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
export const mcpAppCsp = (csp?: Partial<McpAppCsp>): string => {
  const resources = origins(csp?.resourceDomains)
  const connect = origins(csp?.connectDomains)
  const from = resources.length > 0 ? ` ${resources.join(' ')}` : ''
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${from}`,
    `style-src 'unsafe-inline'${from}`,
    `img-src data: blob:${from}`,
    `font-src data:${from}`,
    `media-src data: blob:${from}`,
    connect.length > 0 ? `connect-src ${connect.join(' ')}` : "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "webrtc 'block'",
  ].join('; ')
}

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
