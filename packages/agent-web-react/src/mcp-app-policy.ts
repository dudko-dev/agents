/**
 * MCP Apps: what the host (the page, `mcp-app.ts`) and the sandbox proxy (a page on ANOTHER
 * origin, `mcp-app-sandbox.ts`) must agree on - the app's Content-Security-Policy, the policy as a
 * path segment of the proxy's URL, and the names of the sandbox messages. Pure code with NO
 * imports at all: the proxy's server bundles it without React or the core (a Worker), so the
 * origin rule below is a copy of the core's `mcpAppOrigin`, and `tests/apps-sandbox.test.ts`
 * holds the two to the same answers.
 */

/** The proxy tells the host it can take the app (Sandbox → Host; content-free). */
export const MCP_APP_SANDBOX_PROXY_READY = 'ui/notifications/sandbox-proxy-ready'
/** The host hands the proxy the app's HTML (Host → Sandbox), once. */
export const MCP_APP_SANDBOX_RESOURCE_READY = 'ui/notifications/sandbox-resource-ready'

/** The specification reserves these between a host and its proxy: never relayed to or from an app. */
export const isMcpAppSandboxMessage = (data: unknown): boolean =>
  typeof data === 'object' &&
  data !== null &&
  typeof (data as { method?: unknown }).method === 'string' &&
  (data as { method: string }).method.startsWith('ui/notifications/sandbox-')

/** The origins an app's policy grants, each already an origin (`mcpAppPolicyOrigin`). */
export interface McpAppPolicyOrigins {
  /** `fetch` / XHR / WebSocket (`connect-src`). */
  connect: string[]
  /** Scripts, styles, images, fonts, media. */
  resources: string[]
}

/**
 * The policy of an app's document: scripts and styles inline, `data:` / `blob:` media, and the
 * network ONLY where the resource declared it. Nested frames, workers, plugins, forms and `<base>`
 * are refused whatever was declared (a frame the app may embed would also be a place it may
 * navigate itself to). The lists must already be checked origins: nothing here re-checks them.
 */
export const mcpAppPolicy = ({ connect, resources }: McpAppPolicyOrigins): string => {
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

// ── The origin rule: a COPY of the core's `mcpAppOrigin` (src/mcp/apps.ts) ──────────────────

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST = `(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*`
const PORT = '(?::\\d{1,5})?'
const SECURE_ORIGIN = new RegExp(`^(?:https|wss)://${HOST}${PORT}$`)
const LOOPBACK_ORIGIN = new RegExp(`^(?:http|ws)://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])${PORT}$`)

/**
 * One declared CSP entry as a source expression a policy may carry, or `undefined`: only an
 * origin (`https://` / `wss://`, a `*.` wildcard over at least two labels, or `http://` /
 * `ws://` on loopback). The same answers as the core's `mcpAppOrigin`, for the proxy's server.
 */
export const mcpAppPolicyOrigin = (entry: unknown): string | undefined => {
  if (typeof entry !== 'string' || entry.length > 300) return undefined
  const value = entry.trim().toLowerCase().replace(/\/$/, '')
  if (SECURE_ORIGIN.test(value)) {
    const host = value.replace(/^[a-z]+:\/\//, '').replace(/:\d+$/, '')
    if (host.startsWith('*.') && !host.slice(2).includes('.')) return undefined
    return value
  }
  return LOOPBACK_ORIGIN.test(value) ? value : undefined
}

// ── The policy in the proxy's URL ────────────────────────────────────────────────────────────

/** At most this many origins per list (the core's `MCP_APP_MAX_DOMAINS`). */
export const MCP_APP_POLICY_MAX_ORIGINS = 32
/** A policy token longer than this is not put in a URL: the app runs without its own origin. */
export const MCP_APP_POLICY_TOKEN_MAX_CHARS = 4096

const B64URL = /^[A-Za-z0-9_-]+$/

/**
 * The policy as one path segment (base64url of `{"c":[…],"r":[…]}`), or `undefined` when it does
 * not fit. It is in the PATH, not the query, because a `frame-src` source expression matches a
 * path exactly and ignores the query: the host pins the proxy's frame to this one URL, so nothing
 * inside the frame can load the proxy page with a policy of its choosing.
 */
export const mcpAppPolicyToken = ({
  connect,
  resources,
}: McpAppPolicyOrigins): string | undefined => {
  const json = JSON.stringify({ c: connect, r: resources })
  // Origins are ASCII; anything else is not a list of checked origins.
  if (/[^\x20-\x7e]/.test(json)) return undefined
  const token = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return token.length <= MCP_APP_POLICY_TOKEN_MAX_CHARS ? token : undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const originList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || value.length > MCP_APP_POLICY_MAX_ORIGINS) return undefined
  const out: string[] = []
  for (const entry of value) {
    // Exactly an origin as the host writes it: checked, canonical, once.
    if (typeof entry !== 'string' || mcpAppPolicyOrigin(entry) !== entry || out.includes(entry)) {
      return undefined
    }
    out.push(entry)
  }
  return out
}

/**
 * The policy a token stands for, or `undefined` for anything that is not exactly what
 * `mcpAppPolicyToken` writes: base64url of an object with the two lists and nothing else, every
 * entry an origin by the rule above, no more than `MCP_APP_POLICY_MAX_ORIGINS` each, the
 * canonical encoding (one URL per policy).
 */
export const mcpAppPolicyOfToken = (token: unknown): McpAppPolicyOrigins | undefined => {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MCP_APP_POLICY_TOKEN_MAX_CHARS ||
    !B64URL.test(token)
  ) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return undefined
  }
  if (!isObject(parsed)) return undefined
  const keys = Object.keys(parsed)
  if (keys.length !== 2 || !keys.includes('c') || !keys.includes('r')) return undefined
  const connect = originList(parsed.c)
  const resources = originList(parsed.r)
  if (!connect || !resources) return undefined
  const policy = { connect, resources }
  return mcpAppPolicyToken(policy) === token ? policy : undefined
}
