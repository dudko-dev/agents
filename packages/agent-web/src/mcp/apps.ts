/**
 * MCP Apps (the `io.modelcontextprotocol/ui` extension, stable revision 2026-01-26): a tool of an
 * MCP server declares an HTML user interface (`_meta.ui.resourceUri`, a `ui://` resource), the
 * host reads it with `resources/read` and shows it next to the tool's result in a sandboxed frame.
 *
 * Pure, no imports: what this package accepts of the server's declarations, before anything is
 * shown. Everything here is third-party data from the server, so every function is a guard:
 *
 * - `mcpAppToolMeta`: the tool's link to its app - a `ui://` URI or nothing - and who may call
 *   it (`visibility`: the model, the app, or both).
 * - `mcpAppResourceOf`: the `resources/read` answer - the right URI, the extension's MIME type,
 *   a size cap, `text` or base64 `blob` - and the resource's metadata cleaned: CSP origins that
 *   are origins and nothing else, the permissions it asks for (reported, never granted here).
 * - `mcpAppToolResultOf`: what of a tool's result is handed to the app, capped.
 *
 * The HTML itself never reaches the model: it is not part of a tool result, an event or a log.
 */

/** The extension's identifier: declared under `capabilities.extensions` in the handshake. */
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui'

/** The one content type of the stable revision (`text/html` with the `mcp-app` profile). */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

/** An app's HTML above this many characters is refused (a bundled single-file app is ~1 MB). */
export const MCP_APP_MAX_HTML_CHARS = 2_000_000

/** A tool result above this many characters (as JSON) is not handed to its app. */
export const MCP_APP_MAX_RESULT_CHARS = 512_000

/** At most this many origins per CSP list of a resource; the rest are refused. */
export const MCP_APP_MAX_DOMAINS = 32

const MAX_URI_CHARS = 2048

/** Who may call a tool: the model (it is in the agent's toolbox), an app of its server, or both. */
export type McpAppVisibility = 'model' | 'app'

/** The specification's default when a tool says nothing. */
export const MCP_APP_DEFAULT_VISIBILITY: readonly McpAppVisibility[] = ['model', 'app']

/**
 * The origins an app's resource declared, after cleaning: each entry an origin
 * (`https://host[:port]`, `wss://…`, `https://*.example.com`, or `http(s)/ws(s)` on loopback),
 * nothing else. An empty list means "none": the frame gets no network for that kind.
 */
export interface McpAppCsp {
  /** `fetch` / XHR / WebSocket (`connect-src`). */
  connectDomains: string[]
  /** Scripts, styles, images, fonts, media (`script-src`, `style-src`, …). */
  resourceDomains: string[]
  /** Nested frames (`frame-src`). */
  frameDomains: string[]
  /** `<base href>` (`base-uri`). */
  baseUriDomains: string[]
}

/** Browser features the resource asks for. Reported to the host; this package grants none. */
export interface McpAppPermissions {
  camera?: true
  microphone?: true
  geolocation?: true
  clipboardWrite?: true
}

/** An app's document, read from the server that declared it and checked. */
export interface McpAppResource {
  /** The server it was read from (the one whose tool declared it). */
  server: string
  uri: string
  /** The app's HTML. Third-party code: frame it, never put it in a page or a model's context. */
  html: string
  /** The origins it declared, cleaned (see `McpAppCsp`). */
  csp: McpAppCsp
  /** Declared entries that are not origins this package accepts - left out of `csp`. */
  refusedDomains: string[]
  /** What it asked for; not granted by this package. */
  permissions: McpAppPermissions
  /** Its wish for a visible border; the host decides. */
  prefersBorder?: boolean
  /** The dedicated origin it asked for; a page-based host cannot give one, so it is only reported. */
  domain?: string
}

/** A tool's result as handed to its app: the MCP `CallToolResult`, unchanged but for unknown keys. */
export interface McpAppToolResult {
  content?: unknown[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
}

/** What a tool declares about apps. */
export interface McpAppToolMeta {
  /** Its app (`ui://…`), when it declares a valid one. */
  resourceUri?: string
  visibility: McpAppVisibility[]
  /** A declared app URI that was refused (not `ui://`, too long, not text) - for the log. */
  refusedUri?: string
}

type Obj = Record<string, unknown>

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** A `ui://` URI this package will read: text, short, no control characters. */
export const isMcpAppUri = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('ui://') &&
  value.length > 'ui://'.length &&
  value.length <= MAX_URI_CHARS &&
  !CONTROL.test(value)

/**
 * The tool's app and who may call it. `_meta.ui.resourceUri` wins over the deprecated flat
 * `_meta["ui/resourceUri"]`. `visibility` defaults to both; unknown entries are dropped; a list
 * that names nothing known is the default.
 */
export const mcpAppToolMeta = (tool: { _meta?: unknown }): McpAppToolMeta => {
  const meta = isObj(tool._meta) ? tool._meta : {}
  const ui = isObj(meta.ui) ? meta.ui : {}
  const declared = ui.resourceUri !== undefined ? ui.resourceUri : meta['ui/resourceUri']
  const raw = Array.isArray(ui.visibility) ? ui.visibility : undefined
  const named = raw?.filter((v): v is McpAppVisibility => v === 'model' || v === 'app')
  const visibility =
    named && named.length > 0 ? [...new Set(named)] : [...MCP_APP_DEFAULT_VISIBILITY]
  if (declared === undefined) return { visibility }
  if (isMcpAppUri(declared)) return { resourceUri: declared, visibility }
  return {
    visibility,
    refusedUri: typeof declared === 'string' ? declared.slice(0, 200) : typeof declared,
  }
}

/**
 * Whether a content type is the extension's: `text/html` with `profile=mcp-app`, in any case,
 * with or without spaces or quotes; `charset=utf-8` may come along, nothing else.
 */
export const isMcpAppMimeType = (value: unknown): boolean => {
  if (typeof value !== 'string' || value.length > 200) return false
  const [type, ...params] = value.split(';').map((p) => p.trim().toLowerCase())
  if (type !== 'text/html') return false
  let profile = false
  for (const p of params) {
    const eq = p.indexOf('=')
    if (eq < 0) return false
    const key = p.slice(0, eq).trim()
    const val = p
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
    if (key === 'profile' && val === 'mcp-app') profile = true
    else if (key === 'charset' && val === 'utf-8') continue
    else return false
  }
  return profile
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST = `(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*`
const PORT = '(?::\\d{1,5})?'
const SECURE_ORIGIN = new RegExp(`^(?:https|wss)://${HOST}${PORT}$`)
const LOOPBACK_ORIGIN = new RegExp(`^(?:http|ws)://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])${PORT}$`)

/**
 * One declared CSP entry as a source expression this package puts in a policy, or `undefined`.
 * Only an origin: `https://` / `wss://` (a `*.` subdomain wildcard over at least two labels),
 * or `http://` / `ws://` on loopback. No path, no keyword (`'unsafe-eval'`), no bare scheme, no
 * `*`, no separator (`;` `,` space) that could add a directive of its own.
 */
export const mcpAppOrigin = (entry: unknown): string | undefined => {
  if (typeof entry !== 'string' || entry.length > 300) return undefined
  const value = entry.trim().toLowerCase().replace(/\/$/, '')
  if (SECURE_ORIGIN.test(value)) {
    const host = value.replace(/^[a-z]+:\/\//, '').replace(/:\d+$/, '')
    // `*.com` would be every site of a top-level domain.
    if (host.startsWith('*.') && !host.slice(2).includes('.')) return undefined
    return value
  }
  return LOOPBACK_ORIGIN.test(value) ? value : undefined
}

const DOMAIN_LISTS = [
  'connectDomains',
  'resourceDomains',
  'frameDomains',
  'baseUriDomains',
] as const

/** The resource's declared CSP, cleaned: origins kept, everything else in `refused`. */
export const mcpAppCspOf = (raw: unknown): { csp: McpAppCsp; refused: string[] } => {
  const declared = isObj(raw) ? raw : {}
  const refused: string[] = []
  const csp = {} as McpAppCsp
  for (const list of DOMAIN_LISTS) {
    const entries = Array.isArray(declared[list]) ? (declared[list] as unknown[]) : []
    const kept: string[] = []
    for (const entry of entries) {
      const origin = mcpAppOrigin(entry)
      if (origin && kept.length < MCP_APP_MAX_DOMAINS) {
        if (!kept.includes(origin)) kept.push(origin)
      } else {
        refused.push(typeof entry === 'string' ? entry.slice(0, 120) : typeof entry)
      }
    }
    csp[list] = kept
  }
  return { csp, refused }
}

const PERMISSIONS = ['camera', 'microphone', 'geolocation', 'clipboardWrite'] as const

/** The permissions a resource asks for: the four the specification names, nothing else. */
export const mcpAppPermissionsOf = (raw: unknown): McpAppPermissions => {
  const declared = isObj(raw) ? raw : {}
  const out: McpAppPermissions = {}
  for (const key of PERMISSIONS) if (isObj(declared[key])) out[key] = true
  return out
}

/** Base64 to UTF-8 text, or `undefined` when it is not base64. */
const decodeBase64 = (blob: string): string | undefined => {
  try {
    const binary = atob(blob.replace(/\s+/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Why a `resources/read` answer is not an app this package shows. */
export class McpAppResourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpAppResourceError'
  }
}

/**
 * The app in a `resources/read` answer for `uri`: the entry with exactly that URI, the
 * extension's MIME type, `text` (or base64 `blob`) under `maxChars`, metadata cleaned. Throws
 * {@link McpAppResourceError} otherwise - nothing of a refused answer is shown.
 */
export const mcpAppResourceOf = (
  server: string,
  uri: string,
  result: unknown,
  maxChars: number = MCP_APP_MAX_HTML_CHARS,
): McpAppResource => {
  const contents = isObj(result) && Array.isArray(result.contents) ? result.contents : []
  const entry = contents.find((c): c is Obj => isObj(c) && c.uri === uri)
  if (!entry) {
    throw new McpAppResourceError(`the server's answer for ${uri} does not contain that resource`)
  }
  if (!isMcpAppMimeType(entry.mimeType)) {
    throw new McpAppResourceError(
      `${uri} is not an MCP App: its type is ${JSON.stringify(entry.mimeType ?? null)}, not ${MCP_APP_MIME_TYPE}`,
    )
  }
  let html: string | undefined
  if (typeof entry.text === 'string') {
    if (entry.text.length > maxChars) throw tooLarge(uri, maxChars)
    html = entry.text
  } else if (typeof entry.blob === 'string') {
    // Base64 is 4 characters for 3 bytes; a UTF-8 character is at least one byte.
    if (entry.blob.length > Math.ceil((maxChars * 4) / 3) + 4) throw tooLarge(uri, maxChars)
    html = decodeBase64(entry.blob)
    if (html === undefined) throw new McpAppResourceError(`${uri}: its blob is not base64 UTF-8`)
    if (html.length > maxChars) throw tooLarge(uri, maxChars)
  }
  if (html === undefined) throw new McpAppResourceError(`${uri} has neither text nor blob`)
  const meta = isObj(entry._meta) && isObj(entry._meta.ui) ? entry._meta.ui : {}
  const { csp, refused } = mcpAppCspOf(meta.csp)
  return {
    server,
    uri,
    html,
    csp,
    refusedDomains: refused,
    permissions: mcpAppPermissionsOf(meta.permissions),
    ...(typeof meta.prefersBorder === 'boolean' ? { prefersBorder: meta.prefersBorder } : {}),
    ...(typeof meta.domain === 'string' ? { domain: meta.domain.slice(0, 253) } : {}),
  }
}

const tooLarge = (uri: string, max: number): McpAppResourceError =>
  new McpAppResourceError(`${uri} is larger than ${max} characters`)

/**
 * The parts of a tool result an app is given (`content`, `structuredContent`, `isError`,
 * `_meta`), or `undefined` when they are more than `maxChars` as JSON or not a result at all.
 */
export const mcpAppToolResultOf = (
  result: unknown,
  maxChars: number = MCP_APP_MAX_RESULT_CHARS,
): McpAppToolResult | undefined => {
  if (!isObj(result)) return undefined
  const shaped: McpAppToolResult = {
    ...(Array.isArray(result.content) ? { content: result.content } : {}),
    ...(isObj(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(isObj(result._meta) ? { _meta: result._meta } : {}),
  }
  let size: number
  try {
    size = JSON.stringify(shaped).length
  } catch {
    return undefined
  }
  return size <= maxChars ? shaped : undefined
}

/** A one-line summary of a resource's declared policy, for the host's log (the audit trail). */
export const describeMcpAppPolicy = (resource: McpAppResource): string => {
  const parts = DOMAIN_LISTS.map((list) => {
    const kept = resource.csp[list]
    return `${list}: ${kept.length > 0 ? kept.join(' ') : 'none'}`
  })
  const asked = Object.keys(resource.permissions)
  if (asked.length > 0) parts.push(`permissions asked (not granted): ${asked.join(', ')}`)
  if (resource.refusedDomains.length > 0) {
    parts.push(`refused: ${resource.refusedDomains.join(' ')}`)
  }
  return parts.join('; ')
}
