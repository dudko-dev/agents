import {
  auth,
  Client,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type ClientOptions,
  type FetchLike,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type OAuthClientProvider,
  type StreamableHTTPReconnectionOptions,
} from '@modelcontextprotocol/client'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import {
  createMcpElicitationSession,
  resolveMcpElicitationOptions,
  type McpElicitationCallInfo,
  type McpElicitationDeps,
  type McpElicitationEvent,
  type McpElicitationHandler,
  type McpElicitationOptions,
  type McpElicitationSession,
} from './elicitation.js'
import { assertSecureOAuthUrl } from './oauth.js'
import {
  cleanMcpInstructions,
  dropStructuredDuplicates,
  isStructuredContent,
  markMcpTool,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_MODERN_REFUSED_HINT,
  MCP_MODERN_REQUEST_HEADERS,
  mcpInputRequiredMessage,
  mcpProtocolMode,
  mcpVersionNegotiation,
  outputSchemaNote,
  withStructuredContent,
  type McpProtocolMode,
  type McpServerInstructions,
  type McpServerProtocol,
} from './shared.js'

/**
 * A remote MCP server reached over StreamableHTTP. Browsers can ONLY speak the
 * HTTP transport — stdio (child processes) is Node-only and intentionally
 * unsupported here. This connector lives behind the `@dudko.dev/agent-web/mcp`
 * subpath so `@modelcontextprotocol/client` never enters the core bundle.
 *
 * Three ways to authenticate, in ascending order of capability:
 *   1. `headers` — a static token you already hold.
 *   2. `getHeaders` — resolved once per connect, for tokens you mint yourself.
 *   3. `authProvider` — full OAuth 2.1: the SDK discovers the authorization
 *      server, dynamically registers the client (DCR), runs PKCE, and — the
 *      part 1 and 2 cannot do — transparently REFRESHES the access token when
 *      the server answers 401 mid-run. See `./oauth`.
 */
export interface McpHttpServerConfig {
  url: string
  headers?: Record<string, string>
  /** Called at connect time to provide fresh headers (e.g. a rotating Bearer). */
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
  /**
   * OAuth client provider (see `./oauth` for a browser implementation). The
   * transport sends its access token, refreshes on 401 and retries the request.
   * Do NOT also set an `Authorization` entry in `headers`: request headers are
   * merged last and would shadow the OAuth token.
   */
  authProvider?: OAuthClientProvider
  /** Custom fetch for every request: proxying, instrumentation, retries. */
  fetch?: FetchLike
  /** Overrides for the SSE reconnect backoff. Merged over the defaults below. */
  reconnection?: Partial<StreamableHTTPReconnectionOptions>
  /** Give up on this server after this many ms of connect + listing (overrides the option). */
  connectTimeoutMs?: number
  /**
   * Which revisions of the protocol this connection may use. Default `'legacy'`:
   * the 2025 revisions (the `initialize` handshake), exactly what was sent before
   * this option existed. `'auto'` asks the server first (`server/discover`) and
   * speaks 2026-07-28 to one that offers it, the 2025 handshake to any other;
   * `'modern'` is 2026-07-28 only, and a server that does not offer it fails the
   * connect. Decided once, at connect: a tool call is never retried in another
   * revision.
   *
   * CORS: 2026-07-28 adds the request headers `Mcp-Method` and `Mcp-Name` (and
   * sends `MCP-Protocol-Version` on every request, the first included). A server
   * whose `Access-Control-Allow-Headers` does not list them cannot be reached
   * that way from a page: `'modern'` then fails, and `'auto'` falls back to the
   * 2025 revisions with a warning that names the headers. See the README, "CORS".
   *
   * On 2026-07-28 there is no session; a tool-list change arrives over a
   * `subscriptions/listen` stream this connector opens (it is not opened again
   * when it drops), and an `input_required` result fails the call unless the
   * connection was given `onElicitation` (see `ConnectMcpOptions`).
   */
  protocol?: McpProtocolMode
}

export interface McpCatalogEntry {
  name: string
  description: string
  server: string
  /** The server marked the tool read-only (`annotations.readOnlyHint`). */
  readOnly?: boolean
}

export interface McpServerResult {
  name: string
  connected: boolean
  error?: string
  /**
   * The server demands OAuth and we have no usable token. When the config
   * carried a `BrowserOAuthProvider`, its `authorizationUrl` now holds the page
   * to send the user to; reconnect once they are back.
   */
  needsAuthorization?: boolean
}

export interface ConnectedMcp {
  /** Discovered tools, keyed by "server__tool", ready to merge into config.tools. */
  tools: ToolSet
  catalog: McpCatalogEntry[]
  /** Per-server connect outcome. */
  results: McpServerResult[]
  /**
   * The `instructions` each connected server returned in its `initialize`
   * result, in declaration order; servers that sent none are absent. Read once
   * per connection. Third-party text: the agent shows it to the model under a
   * preamble that says so (`config.mcpInstructions`, on by default) — each
   * mounted tool carries its server's instructions, so merging `tools` into
   * the agent's config is all a host does.
   */
  instructions: McpServerInstructions[]
  /**
   * The protocol revision negotiated with each connected server, in declaration
   * order: `2025-…` after the `initialize` handshake (always, for a server
   * without `protocol`), `2026-07-28` when `protocol: 'auto'` or `'modern'`
   * found a server that offers it. Fixed for the life of the connection.
   */
  protocols: McpServerProtocol[]
  /**
   * Re-list one server's tools and rewrite its entries in `tools`/`catalog`.
   * Both are mutated in place, so anything holding a reference (including a
   * live agent config) sees the new set. Throws if the server isn't connected.
   */
  refreshServer: (name: string) => Promise<void>
  close: () => Promise<void>
}

export interface ConnectMcpOptions {
  clientName?: string
  clientVersion?: string
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /**
   * Fires when a server pushes `notifications/tools/list_changed`. Call
   * `refreshServer(name)` from a point where no run is reading `tools` — this
   * connector deliberately does not refresh behind a running agent's back.
   * On a 2026-07-28 connection (`protocol`) the notice arrives over a
   * `subscriptions/listen` stream, opened only when this callback is given.
   */
  onToolsChanged?: (server: string) => void
  /**
   * Per-server deadline for connect + tool listing (default 30 000 ms). A
   * server that misses it is reported failed and closed; the others still
   * mount — one hanging server no longer holds every other one hostage.
   */
  connectTimeoutMs?: number
  /**
   * MCP elicitation: a server may ask the user for input in the middle of a tool
   * call (a form, or - with `elicitation.url` - a link to open), and this
   * callback answers: accept with the form's values, decline, or cancel. The
   * HOST decides, never the model: the question is not shown to the model, and
   * the answer goes only to the server that asked - not into the model's
   * context, an event, a log or a run checkpoint.
   *
   * Without the callback the capability is not declared, a server cannot ask,
   * and nothing is sent that was not sent before. The server's message and form
   * are third-party text: cleaned, capped and restricted to a flat form before
   * the callback sees them; the answer is checked against the form before it is
   * sent. A link (URL mode) is only handed to the callback: this package never
   * fetches or opens it. A callback that throws or does not answer in time
   * cancels the question and fails the tool call; nothing is retried.
   *
   * Inside an agent run the two events `mcp.elicitation-requested` /
   * `mcp.elicitation-answered` are emitted (the answered one never carries a
   * value). On the 2025 revisions the calls to a server with this option run
   * one at a time: its question does not say which call it belongs to.
   */
  onElicitation?: McpElicitationHandler
  /**
   * Its settings: `timeoutMs` (default 300 000: a human is answering; the
   * step's `chatTimeoutMs` stops while a question waits),
   * `maxPerToolCall` (5), `maxPerRun` (20), `url` (also accept URL mode; default
   * false), `subagents` (let a call made by a helper - a subagent - ask too;
   * default false: its question is cancelled without the callback being called).
   */
  elicitation?: McpElicitationOptions
}

/**
 * The longest delay a timer takes (2^31 - 1 ms): the SDK's own request timeout
 * is set to it for a 2025 tool call that may ask the user something, whose time
 * is kept by the elicitation session instead (it does not count the time a
 * question waits).
 */
const MAX_TIMER_MS = 2_147_483_647

/**
 * What an MCP tool reads of the call that reached it, structurally (this entry
 * does not import the core): the run context the agent passes as
 * `options.agentRun`, and the mark a subagent tool puts on a host tool's call.
 */
interface ToolCallOptions {
  abortSignal?: AbortSignal
  agentRun?: {
    emit?: (event: never) => void
    step?: unknown
    signal?: AbortSignal
    runId?: string
    subagent?: { id: string; depth: number }
    elicitations?: { count: number }
    /** The run's clock: stopped while a question waits, so the step's limit does not run. */
    clock?: { pause: () => () => void }
  }
  subagentCall?: {
    id: string
    depth: number
    elicitations?: { count: number }
    /** Stops the clock of the run that delegated, for a call that reaches here without a run. */
    pause?: () => () => void
  }
}

/** Hard stop for a server whose pagination never ends (the Node sibling's cap and name). */
export const MAX_TOOL_LIST_PAGES = 100
/**
 * 2026-07-28: how long the `subscriptions/listen` stream may take to be
 * acknowledged before the connect goes on without tool-list change notices
 * (the Node sibling's bound and name).
 */
export const MCP_LISTEN_ACK_TIMEOUT_MS = 10_000

/** The SDK's typed error with this code (by name too: a second copy of the SDK is another class). */
const isSdkError = (err: unknown, code: SdkErrorCode): boolean =>
  (err instanceof SdkError || (err instanceof Error && err.name === 'SdkError')) &&
  (err as { code?: unknown }).code === code

/**
 * Every tool of a server, following `nextCursor` (up to MAX_TOOL_LIST_PAGES
 * pages; a repeated cursor ends the walk). Servers with hundreds of tools
 * paginate; reading only the first page silently drops the rest.
 *
 * Page by page through `client.request`, not `client.listTools()`: called
 * without a cursor, the typed verb of the 2.x SDK walks every page itself,
 * throws past its own page cap, answers without asking when the server did not
 * advertise the tools capability, and fills the cache that switches on the
 * SDK's output-schema check in `callTool` (which this module does itself, see
 * `outputSchemaViolation`). The raw request does none of that.
 */
export const listAllTools = async (
  client: Pick<Client, 'request'>,
  onTruncated?: () => void,
): Promise<McpToolDescriptor[]> => {
  const all: McpToolDescriptor[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
    const res = await client.request({
      method: 'tools/list',
      params: cursor ? { cursor } : undefined,
    })
    all.push(...(res.tools as McpToolDescriptor[]))
    const next = typeof res.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined
    if (!next || seen.has(next)) return all
    seen.add(next)
    cursor = next
  }
  onTruncated?.()
  return all
}

class ConnectTimeoutError extends Error {}

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  if (!(ms > 0)) return p
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ConnectTimeoutError(`${label} timed out after ${ms} ms`)),
        ms,
      )
    }),
  ])
}

// Providers cap tool names at 64 chars (^[a-zA-Z0-9_-]{1,64}$). We enforce the
// same limit on the prefixed "server__tool" so one server can't poison a run.
const MAX_TOOL_NAME_LEN = 64

// Browsers drop long-lived SSE streams on tab-throttling and flaky networks far
// more often than a server does; the SDK's default (2 retries) gives up too
// early for an agent that may idle between steps.
const DEFAULT_RECONNECTION: StreamableHTTPReconnectionOptions = {
  maxReconnectionDelay: 30_000,
  initialReconnectionDelay: 1_000,
  reconnectionDelayGrowFactor: 1.5,
  maxRetries: 5,
}

// MCP names may contain characters providers reject (dots, slashes, spaces);
// map them into the allowed alphabet. callTool still uses the ORIGINAL name.
const sanitizeName = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')

/**
 * Sanitizing can map two distinct MCP names onto one key ("a.b" and "a-b" both
 * become "a_b"). Suffix instead of dropping: a tool the model can't see is a
 * silent capability loss, and the disambiguated name still resolves back to the
 * original on dispatch.
 */
const uniqueKey = (base: string, taken: ToolSet): string => {
  // hasOwn, not truthiness: a tool named so that the key lands on "__proto__"
  // would otherwise read as already taken through the prototype chain.
  if (!Object.hasOwn(taken, base)) return base
  for (let n = 2; n < 100; n++) {
    const suffix = `_${n}`
    const candidate = base.slice(0, MAX_TOOL_NAME_LEN - suffix.length) + suffix
    if (!Object.hasOwn(taken, candidate)) return candidate
  }
  return ''
}

/**
 * Flatten an MCP tool result's content into something a model can read. Unlike
 * the Node sibling this NEVER spills to a filesystem (there isn't one in the
 * browser): all-text content is joined; mixed content passes through as an
 * array of text + raw parts for the host to handle.
 */
export const flattenContent = (content: unknown): unknown => {
  if (!Array.isArray(content)) return content
  const parts = content as Array<Record<string, unknown>>
  const allText =
    parts.length > 0 && parts.every((p) => p?.type === 'text' && typeof p.text === 'string')
  if (allText) return parts.map((p) => p.text as string).join('\n')
  return parts.map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : p))
}

interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: unknown
  outputSchema?: unknown
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
}

/** The longest compile error repeated in a refusal (the SDK clips at the same length). */
const OUTPUT_SCHEMA_ERROR_MAX_CHARS = 200

/**
 * Why a tool result does not follow the `outputSchema` its tool declared, or
 * `undefined` when it does. The rule and the wording are those of the SDK's
 * `Client.callTool`: a tool with an output schema must answer with
 * `structuredContent`, and that value must validate. An `isError` result is
 * not checked.
 *
 * The check is made here, on a result that was received, instead of inside
 * `callTool`, which throws on a violation and takes the result with it: the
 * call RAN on the server, so its result goes to the model with a note.
 *
 * The Node package carries the same function; change both.
 */
export const outputSchemaViolation = (
  toolName: string,
  result: Pick<CallToolResult, 'structuredContent' | 'isError'>,
  validate: JsonSchemaValidator<unknown>,
): string | undefined => {
  if (result.isError === true) return undefined
  if (result.structuredContent === undefined) {
    return `Tool ${toolName} has an output schema but did not return structured content`
  }
  try {
    const checked = validate(result.structuredContent)
    return checked.valid
      ? undefined
      : `Structured content does not match the tool's output schema: ${checked.errorMessage}`
  } catch (err) {
    return `Failed to validate structured content: ${err instanceof Error ? err.message : String(err)}`
  }
}

interface ServerConnect {
  name: string
  client?: Client
  /** What the server said in its initialize result ('' when nothing). */
  instructions?: string
  /** The revision the connection negotiated. */
  protocol?: Omit<McpServerProtocol, 'server'>
  listed?: McpToolDescriptor[]
  error?: string
  needsAuthorization?: boolean
}

/**
 * The enterprise-managed provider (`enterprise-oauth.ts`), recognised by shape
 * so a host's own subclass, or one from another bundle of this package, counts.
 */
type EnterpriseLog = (level: 'info' | 'warn' | 'error', message: string) => void

interface EnterpriseProviderShape {
  extension: string
  authorize: (opts: { fetch?: FetchLike; onLog?: EnterpriseLog }) => Promise<void>
  transportFetch: (base?: FetchLike, log?: EnterpriseLog) => FetchLike
}

const asEnterpriseProvider = (
  provider: OAuthClientProvider,
): EnterpriseProviderShape | undefined => {
  const p = provider as Partial<Record<keyof EnterpriseProviderShape, unknown>>
  return typeof p.extension === 'string' &&
    typeof p.authorize === 'function' &&
    typeof p.transportFetch === 'function'
    ? (provider as unknown as EnterpriseProviderShape)
    : undefined
}

/** Thrown by the refresh-only view when the SDK reaches for a redirect. */
class RefreshOnlyAbort extends Error {}

/**
 * A view of the provider that can renew a token but can never start an
 * interactive authorization.
 *
 * `auth()` does not have a refresh-only mode: when a refresh fails for a reason
 * it deems recoverable (a 5xx from the token endpoint, a network blip) it falls
 * through to a brand-new authorization — issuing a state and a PKCE verifier,
 * overwriting the stored pair, and calling `redirectToAuthorization`. The
 * transport then does its own `auth()` on the first 401, overwriting them
 * again, so the user comes back holding a code the second pair can't verify.
 * Blocking the three redirect-path methods aborts the escalation before
 * anything is overwritten; the transport's 401 handling stays the single owner
 * of interactive authorization.
 */
const refreshOnly = (p: OAuthClientProvider): OAuthClientProvider => ({
  // Must stay truthy: `auth()` reads a missing redirectUrl as "non-interactive
  // grant" and would try to fetch a token without one.
  get redirectUrl() {
    return p.redirectUrl
  },
  get clientMetadata() {
    return p.clientMetadata
  },
  get clientMetadataUrl() {
    return p.clientMetadataUrl
  },
  // The second argument is the authorization server the SDK resolved: a
  // provider that keeps credentials per issuer reads and writes by it.
  clientInformation: (ctx) => p.clientInformation(ctx),
  saveClientInformation: p.saveClientInformation?.bind(p),
  tokens: (ctx) => p.tokens(ctx),
  saveTokens: (t, ctx) => p.saveTokens(t, ctx),
  invalidateCredentials: p.invalidateCredentials?.bind(p),
  addClientAuthentication: p.addClientAuthentication?.bind(p),
  validateResourceURL: p.validateResourceURL?.bind(p),
  // What a refresh request is made of, when the provider says so.
  scopeForRefresh: p.scopeForRefresh?.bind(p),
  dpop: p.dpop?.bind(p),
  codeVerifier: () => p.codeVerifier(),
  state: () => {
    throw new RefreshOnlyAbort()
  },
  saveCodeVerifier: () => {
    throw new RefreshOnlyAbort()
  },
  redirectToAuthorization: () => {
    throw new RefreshOnlyAbort()
  },
})

/**
 * An access token that is already expired produces a guaranteed 401 on the
 * first request. When the provider tells us so AND we hold a refresh token,
 * renew before connecting: one round-trip saved, and a run that starts on a
 * stale token doesn't surface a spurious auth error to the model.
 *
 * Best-effort by design — anything that goes wrong here is left to the
 * transport's own 401 handling, which is the path that knows how to ask the
 * user for a new authorization.
 */
const refreshIfExpired = async (
  provider: OAuthClientProvider,
  serverUrl: string,
  fetchFn: FetchLike | undefined,
  log: NonNullable<ConnectMcpOptions['onLog']>,
  name: string,
  // The host's own `onLog`, when it gave one: left undefined otherwise, so the
  // enterprise provider falls back to the package's logger for its detail.
  detailLog?: EnterpriseLog,
): Promise<void> => {
  const check = (provider as { isAccessTokenExpired?: () => boolean | Promise<boolean> })
    .isAccessTokenExpired
  if (typeof check !== 'function') return
  if (!(await check.call(provider))) return
  const enterprise = asEnterpriseProvider(provider)
  if (enterprise) {
    // No human step and no refresh token (the ID-JAG replaces it): get the
    // token now. A refusal by the IdP or the authorization server is final -
    // asking again through the 401 path would only repeat the exchange - so it
    // fails this server with the error that names who refused. Only a
    // discovery failure is left to the transport: the server's 401 may say
    // where its metadata lives, or it may need no authorization at all.
    try {
      await enterprise.authorize({ fetch: fetchFn, onLog: detailLog })
    } catch (err) {
      if ((err as { hop?: unknown })?.hop !== 'discovery') throw err
      log('info', `[mcp] ${name}: ${err instanceof Error ? err.message : String(err)}; continuing`)
    }
    return
  }
  const tokens = await provider.tokens()
  // Nothing to refresh with: let the 401 path ask for a new authorization.
  if (!tokens?.refresh_token) return
  try {
    await auth(refreshOnly(provider), { serverUrl, fetchFn })
  } catch (err) {
    log(
      'info',
      err instanceof RefreshOnlyAbort
        ? `[mcp] ${name}: the stored token could not be refreshed; a new authorization is needed`
        : `[mcp] ${name}: proactive token refresh failed (${
            err instanceof Error ? err.message : String(err)
          }); continuing`,
    )
  }
}

/**
 * A fetch the browser refused for CORS reasons is indistinguishable, from
 * JavaScript, from a server that is simply down: both surface as a bare
 * `TypeError`. The reason is deliberately withheld, and the browser prints it
 * only to the devtools console — which is why this failure is usually read as a
 * client bug and debugged in the wrong place for a long time.
 */
const isNetworkLevelFailure = (err: unknown): boolean =>
  err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(err))

/**
 * Work out WHY the browser blocked us, by asking a question it will answer.
 *
 * A request carrying only `content-type` needs the same preflight as the real
 * one but asks for nothing else. So if the plain request gets through while the
 * transport's did not, the origin is fine and a *header* is the problem — and
 * the header the transport adds is `MCP-Protocol-Version`, which the spec has
 * required on every post-initialize request since 2025-06-18 and which server
 * CORS lists written before that date do not include. That is the shape of the
 * bug that lets OAuth and `initialize` succeed and then kills the connection
 * moments later, looking for all the world like the consent step failed.
 *
 * With `protocol: 'auto'` or `'modern'` the transport also sends the request
 * headers of the 2026-07-28 revision, on the very first request. The browser
 * will not say which header a preflight refused either, so each one is tried on
 * its own: the ones that do not get through are the ones missing from the
 * server's `Access-Control-Allow-Headers`, and they are named.
 *
 * Exported because a UI wants to say this too, not just log it.
 */
export const diagnoseMcpCors = async (
  url: string,
  fetchFn: FetchLike = globalThis.fetch,
  opts: { protocol?: McpProtocolMode } = {},
): Promise<string | undefined> => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' })
  let plain: Response
  try {
    plain = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
  } catch {
    return (
      `the browser blocked every request to ${url}, including a plain one. ` +
      'The server is unreachable, or it does not answer the CORS preflight for this ' +
      'origin: it must return Access-Control-Allow-Origin (and handle OPTIONS) on the ' +
      'MCP endpoint, the OAuth endpoints and the /.well-known documents.'
    )
  }
  const hints: string[] = []
  const modern = opts.protocol === 'auto' || opts.protocol === 'modern'
  if (modern) {
    // One request per header, each asking the preflight for that header alone.
    // Whatever the server answers is an answer: only a blocked request counts.
    const refused: string[] = []
    for (const [header, value] of [
      ['MCP-Protocol-Version', MCP_MODERN_PROTOCOL_VERSION],
      [MCP_MODERN_REQUEST_HEADERS[0], 'ping'],
      [MCP_MODERN_REQUEST_HEADERS[1], 'cors-check'],
    ] as const) {
      try {
        await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [header]: value },
          body,
        })
      } catch {
        refused.push(header)
      }
    }
    if (refused.length > 0) {
      hints.push(
        `a plain request to ${url} succeeded (HTTP ${plain.status}), but one carrying ` +
          `${refused.join(' / ')} was blocked: the server's Access-Control-Allow-Headers ` +
          `does not list ${refused.length === 1 ? 'it' : 'them'}. The ${MCP_MODERN_PROTOCOL_VERSION} ` +
          `revision of the protocol (protocol: '${opts.protocol}') sends MCP-Protocol-Version, ` +
          `${MCP_MODERN_REQUEST_HEADERS.join(' and ')} on every request: add ` +
          `${refused.join(', ')} to Access-Control-Allow-Headers, alongside Content-Type and ` +
          `Authorization (and any Mcp-Param-* header the server's tools declare).`,
      )
    }
  }
  if (hints.length === 0) {
    hints.push(
      `a plain request to ${url} succeeded (HTTP ${plain.status}) but the transport's did not, ` +
        'so the origin is allowed and a request HEADER is being refused. Add ' +
        'MCP-Protocol-Version (required on every request after initialize) and Last-Event-ID ' +
        "to the server's Access-Control-Allow-Headers, alongside Content-Type, Authorization " +
        'and mcp-session-id.' +
        (modern
          ? ` With protocol: '${opts.protocol}', ${MCP_MODERN_REQUEST_HEADERS.join(' and ')} too.`
          : ''),
    )
  }
  // A 401 whose challenge JS cannot read means OAuth discovery cannot start
  // from a browser at all, so say so while we are here.
  if (plain.status === 401 && !plain.headers.get('www-authenticate')) {
    hints.push(
      'The server also answers 401 without exposing WWW-Authenticate: add it to ' +
        'Access-Control-Expose-Headers, or a browser client cannot read the challenge ' +
        'and OAuth discovery never starts.',
    )
  }
  return hints.join(' ')
}

/** Says that `diagnoseMcpCors` found request headers the server's CORS policy refuses. */
const NAMES_REFUSED_HEADERS = /was blocked: the server's Access-Control-Allow-Headers/

const warnTruncated = (log: NonNullable<ConnectMcpOptions['onLog']>, name: string): void =>
  log(
    'warn',
    `[mcp] ${name}: tools/list still paginating after ${MAX_TOOL_LIST_PAGES} pages; the rest of the tools are not mounted`,
  )

const openConnection = async (
  name: string,
  cfg: McpHttpServerConfig,
  opts: ConnectMcpOptions,
  log: NonNullable<ConnectMcpOptions['onLog']>,
  isClosing: () => boolean,
  elicitation: McpElicitationSession | undefined,
): Promise<ServerConnect> => {
  let client: Client | undefined
  let timedOut = false
  const timeoutMs = cfg.connectTimeoutMs ?? opts.connectTimeoutMs ?? 30_000
  // What the version probe (`protocol: 'auto' | 'modern'`) ran into.
  const probe: ProbeState = { blocked: false }
  const attempt = connectAndList(
    name,
    cfg,
    opts,
    log,
    probe,
    isClosing,
    (c) => {
      client = c
      // Created after the deadline already passed: nobody will ever use it.
      if (timedOut) void c.close().catch(() => {})
    },
    elicitation,
  )
  // A handshake that completes after the deadline must not leave a live session behind.
  attempt.then(
    (r) => {
      if (timedOut) void r.client?.close().catch(() => {})
    },
    () => {},
  )
  try {
    return await withTimeout(attempt, timeoutMs, 'connect')
  } catch (err) {
    if (err instanceof ConnectTimeoutError) timedOut = true
    // The client may be live even though we ended up here (listTools() failing
    // after a successful connect, or the deadline passing mid-listing). Close
    // it, or the SSE stream leaks for the lifetime of the tab.
    if (client) await client.close().catch(() => {})
    const needsAuthorization = err instanceof UnauthorizedError
    let message = err instanceof Error ? err.message : String(err)
    // `protocol: 'modern'` against a server that did not offer the revision:
    // the SDK's sentence, plus which option to turn.
    if (cfg.protocol === 'modern' && isSdkError(err, SdkErrorCode.EraNegotiationFailed)) {
      message = `${message} - ${MCP_MODERN_REFUSED_HINT}`
    }
    // Turn "TypeError: Failed to fetch" into the sentence the reader needs.
    // Only on the failure path, so the extra request costs nothing in normal use.
    if (!needsAuthorization && !(err instanceof ConnectTimeoutError)) {
      if (isNetworkLevelFailure(err)) {
        const hint = await diagnoseMcpCors(cfg.url, cfg.fetch, {
          protocol: probe.mode,
        }).catch(() => undefined)
        if (hint) message = `${message} - ${hint}`
      } else if (probe.blocked) {
        // The version probe never reached the server, and what failed
        // afterwards is another error (a page's SDK reads a blocked probe as
        // "a 2025 server" and goes on). Said only when a header is the cause.
        const hint = await diagnoseMcpCors(cfg.url, cfg.fetch, {
          protocol: probe.mode,
        }).catch(() => undefined)
        if (hint && NAMES_REFUSED_HEADERS.test(hint)) message = `${message} - ${hint}`
      }
    }
    log(
      'error',
      needsAuthorization
        ? `[mcp] ${name}: authorization required - send the user to the provider's authorizationUrl`
        : `[mcp] ${name}: failed to connect - ${message}`,
    )
    return { name, error: message, needsAuthorization }
  }
}

/** What the version probe of one connect ran into (see `openConnection`). */
interface ProbeState {
  /** The configured mode, once it was read. */
  mode?: McpProtocolMode
  /** A request of the probe was blocked before it reached the server (CORS, or no network). */
  blocked: boolean
}

/**
 * 2026-07-28: ask the server for tool-list change notices. Best effort - a
 * server that does not announce them, or a stream that cannot be opened, leaves
 * a connection whose tools still work; `refreshServer` still re-lists.
 */
const listenForToolChanges = async (
  name: string,
  client: Client,
  log: NonNullable<ConnectMcpOptions['onLog']>,
  isClosing: () => boolean,
): Promise<void> => {
  if (!client.getServerCapabilities()?.tools?.listChanged) {
    log('info', `[mcp] ${name}: the server does not announce tool list changes`)
    return
  }
  try {
    const subscription = await client.listen(
      { toolsListChanged: true },
      { timeout: MCP_LISTEN_ACK_TIMEOUT_MS },
    )
    // The SDK does not open the stream again, and neither does this connector:
    // say so, or the silence reads as "nothing changed".
    void subscription.closed.then((cause) => {
      if (!isClosing()) {
        log(
          'warn',
          `[mcp] ${name}: the tool list change stream ended (${
            cause === 'graceful' ? 'closed by the server' : 'dropped'
          }); changes are not announced until the server is connected again`,
        )
      }
    })
  } catch (err) {
    log(
      'warn',
      `[mcp] ${name}: could not subscribe to tool list changes - ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

const connectAndList = async (
  name: string,
  cfg: McpHttpServerConfig,
  opts: ConnectMcpOptions,
  log: NonNullable<ConnectMcpOptions['onLog']>,
  probe: ProbeState,
  isClosing: () => boolean,
  onClient: (client: Client) => void,
  elicitation: McpElicitationSession | undefined,
): Promise<ServerConnect> => {
  // Read first: a `protocol` that is none of the three names is a
  // configuration error, said before anything is sent.
  const mode = mcpProtocolMode(cfg.protocol, name)
  probe.mode = mode
  if (cfg.headers && cfg.getHeaders) {
    throw new Error(`MCP server "${name}": specify either headers or getHeaders, not both`)
  }
  const headers = cfg.getHeaders ? await cfg.getHeaders() : cfg.headers
  if (cfg.authProvider) {
    if (headers && 'Authorization' in headers) {
      log(
        'warn',
        `[mcp] ${name}: an explicit Authorization header shadows the OAuth token from authProvider`,
      )
    }
    assertSecureOAuthUrl(cfg.url, name)
    await refreshIfExpired(cfg.authProvider, cfg.url, cfg.fetch, log, name, opts.onLog)
  }
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: headers ? { headers } : undefined,
    authProvider: cfg.authProvider,
    // A 403 `insufficient_scope` in the middle of a session. A provider
    // without a human step (no `redirectUrl`: the enterprise one) may ask
    // again for the wider scope, once per request - the SDK's cap. One WITH a
    // human step - in a browser nearly all of them - never does: the SDK would
    // skip the refresh and start a new authorization from inside a tool call,
    // replacing the stored state and PKCE verifier each time the model tried
    // the tool again. The call fails with the scope the server asked for, and
    // the host decides. The Node sibling's rule.
    onInsufficientScope: cfg.authProvider?.redirectUrl ? 'throw' : 'reauthorize',
    // The enterprise provider reports a refused grant itself: a short typed
    // error for the caller, the server's words (redacted) to the log.
    fetch:
      (cfg.authProvider &&
        asEnterpriseProvider(cfg.authProvider)?.transportFetch(cfg.fetch, opts.onLog)) ||
      cfg.fetch,
    reconnectionOptions: { ...DEFAULT_RECONNECTION, ...cfg.reconnection },
  })
  // Without these, a dropped SSE stream or a transport-level protocol error
  // is swallowed and the agent just stops getting results.
  // The version probe asks a question a 2025 server answers with an HTTP
  // error: that answer is the expected "no", not a fault of the connection. A
  // probe that was BLOCKED is remembered: a page's SDK reads it as "a 2025
  // server" too, and only this callback saw the difference.
  let probing = mode !== 'legacy'
  transport.onerror = (err) => {
    if (!probing) {
      log('warn', `[mcp] ${name}: transport error - ${err.message}`)
      return
    }
    if (isNetworkLevelFailure(err)) probe.blocked = true
    log('info', `[mcp] ${name}: version probe (server/discover) - ${err.message}`)
  }
  // info, not warn: an ordinary close() ends here too, and a routine
  // teardown logged as a warning trains people to ignore warnings.
  transport.onclose = () => log('info', `[mcp] ${name}: transport closed`)

  const enterprise = cfg.authProvider ? asEnterpriseProvider(cfg.authProvider) : undefined
  // Without `protocol` (or with 'legacy') nothing is added here: the client is
  // built with exactly the options it always had.
  const negotiation = mcpVersionNegotiation(mode)
  const clientOptions: ClientOptions | undefined =
    enterprise || negotiation || elicitation
      ? {
          // An extension is opt-in: it is declared only by the client that uses
          // it. So is elicitation: without `onElicitation` no capability is
          // declared, and a server cannot ask.
          ...(enterprise || elicitation
            ? {
                capabilities: {
                  ...(enterprise ? { extensions: { [enterprise.extension]: {} } } : {}),
                  ...(elicitation ? { elicitation: elicitation.capability } : {}),
                },
              }
            : {}),
          ...(negotiation
            ? {
                versionNegotiation: negotiation,
                // 2026-07-28: an `input_required` result is NOT answered and the
                // call is NOT sent again by the SDK (its default would try
                // both). Without `onElicitation` it fails the tool call; with
                // it, `execute` answers it through the session, which keeps
                // the caps the SDK's own loop does not have.
                inputRequired: { autoFulfill: false },
              }
            : {}),
        }
      : undefined
  const client = new Client(
    { name: opts.clientName ?? 'agent-web', version: opts.clientVersion ?? '0.0.0' },
    clientOptions,
  )
  if (elicitation) {
    // 2025 revisions: the server's question is a request of its own. (On
    // 2026-07-28 the SDK drops inbound requests; the question is then the tool
    // call's `input_required` result.)
    client.setRequestHandler('elicitation/create', (request) =>
      elicitation.onRequest(request.params),
    )
  }
  onClient(client)
  await client.connect(transport)
  probing = false
  const era = client.getProtocolEra() ?? 'legacy'
  const version = client.getNegotiatedProtocolVersion() ?? ''
  if (mode !== 'legacy') {
    log(
      'info',
      `[mcp] ${name}: protocol ${version} (${
        era === 'modern' ? 'modern: stateless, no session' : 'legacy: the initialize handshake'
      }; configured '${mode}')`,
    )
    // 'auto' on the 2025 revisions although the probe never reached the
    // server: when a CORS header is why, the server may well speak 2026-07-28.
    if (era === 'legacy' && probe.blocked) {
      const hint = await diagnoseMcpCors(cfg.url, cfg.fetch, { protocol: mode }).catch(
        () => undefined,
      )
      log(
        'warn',
        `[mcp] ${name}: the version probe (server/discover) was blocked before it reached the server, so the connection uses ${version}${
          hint && NAMES_REFUSED_HEADERS.test(hint) ? ` - ${hint}` : ''
        }`,
      )
    }
  }

  // Subscribe BEFORE the first list call: a server that mutates its tool set
  // during init would otherwise lose the notification in the window between
  // connect() and listTools().
  if (opts.onToolsChanged) {
    const notify = opts.onToolsChanged
    client.setNotificationHandler('notifications/tools/list_changed', () => notify(name))
    // 2026-07-28 has no stream a server may write to unasked: the notice above
    // arrives only on a `subscriptions/listen` stream the client opens. (The
    // 2025 revisions send it on the GET stream the transport opens by itself.)
    if (era === 'modern') await listenForToolChanges(name, client, log, isClosing)
  }

  const listed = await listAllTools(client, () => warnTruncated(log, name))
  // Read once, here: the text is fixed for the life of this connection.
  return {
    name,
    client,
    listed,
    instructions: cleanMcpInstructions(client.getInstructions()),
    protocol: { version, era },
  }
}

/**
 * Connect to one or more HTTP MCP servers and return their tools + catalogue.
 * Servers connect concurrently; tools, catalogue, and results merge in the
 * caller's declaration order, so the outcome is deterministic.
 */
export const connectMcpHttp = async (
  servers: Record<string, McpHttpServerConfig>,
  opts: ConnectMcpOptions = {},
): Promise<ConnectedMcp> => {
  const log = opts.onLog ?? (() => {})
  // Read first: a setting that is not a usable number is a configuration error.
  const elicitationOptions = resolveMcpElicitationOptions(opts.elicitation)
  const elicitationDeps: McpElicitationDeps | undefined = opts.onElicitation
    ? { handler: opts.onElicitation, options: elicitationOptions, log }
    : undefined
  // One per server, made before its client: the capability it declares is part
  // of the handshake.
  const elicitationSessions = new Map<string, McpElicitationSession>()
  const elicitationSessionOf = (name: string): McpElicitationSession | undefined => {
    if (!elicitationDeps) return undefined
    let session = elicitationSessions.get(name)
    if (!session) {
      session = createMcpElicitationSession(name, elicitationDeps)
      elicitationSessions.set(name, session)
    }
    return session
  }
  const clients = new Map<string, Client>()
  const tools: ToolSet = {}
  const catalog: McpCatalogEntry[] = []
  const results: McpServerResult[] = []
  const instructions: McpServerInstructions[] = []
  const instructionsOf = new Map<string, string>()
  const protocols: McpServerProtocol[] = []
  let closing = false
  // server name → the tool keys it currently owns, so a refresh can remove
  // exactly its own entries.
  const mountedKeys = new Map<string, string[]>()

  const mountTools = (name: string, client: Client, listed: McpToolDescriptor[]): void => {
    const prefix = `${sanitizeName(name)}__`
    // Drop this server's existing entries first, mutating in place so external
    // references (an agent's live ToolSet) stay valid. We delete the keys this
    // server actually mounted rather than everything matching its prefix:
    // sanitizing can make two server names share a prefix ("docs.v1" and
    // "docs/v1"), and one server's prefix can nest inside another's ("a" and
    // "a__b") — either way a prefix sweep would silently unmount a DIFFERENT
    // server's tools.
    for (const k of mountedKeys.get(name) ?? []) {
      delete tools[k]
    }
    for (let i = catalog.length - 1; i >= 0; i--) {
      if (catalog[i].server === name) catalog.splice(i, 1)
    }
    const keys: string[] = []
    // The SDK's own validator, the one its browser build uses by default
    // (@cfworker/json-schema: no code generation, so it runs under a CSP without
    // 'unsafe-eval'; dialect by `$schema`). One per mount, compiled lazily.
    let schemaValidator: CfWorkerJsonSchemaValidator | undefined

    let mounted = 0
    for (const t of listed) {
      const prefixed = prefix + sanitizeName(t.name)
      if (prefixed.length > MAX_TOOL_NAME_LEN) {
        log(
          'warn',
          `[mcp] ${name}: tool "${t.name}" exceeds the ${MAX_TOOL_NAME_LEN}-char name limit; skipping`,
        )
        continue
      }
      const key = uniqueKey(prefixed, tools)
      if (!key) {
        log('warn', `[mcp] ${name}: cannot find a free name for tool "${t.name}"; skipping`)
        continue
      }
      if (key !== prefixed) {
        log('warn', `[mcp] ${name}: tool name "${prefixed}" already taken; mounted as "${key}"`)
      }
      const description = t.description ?? ''
      const readOnly = t.annotations?.readOnlyHint === true
      // Compiled on the first call, as the SDK does, and once per mount.
      let outputValidator: JsonSchemaValidator<unknown> | undefined
      const outputValidatorOf = (): JsonSchemaValidator<unknown> | undefined => {
        if (!t.outputSchema || outputValidator) return outputValidator
        try {
          schemaValidator ??= new CfWorkerJsonSchemaValidator()
          outputValidator = schemaValidator.getValidator(t.outputSchema as JsonSchemaType)
        } catch (err) {
          // Before anything is sent, so nothing ran on the server: a schema
          // that cannot be compiled is refused as the SDK refuses it, and never
          // silently skipped.
          const reason = (err instanceof Error ? err.message : String(err)).slice(
            0,
            OUTPUT_SCHEMA_ERROR_MAX_CHARS,
          )
          throw new Error(`Tool '${t.name}' has an invalid outputSchema: ${reason}`)
        }
        return outputValidator
      }
      tools[key] = dynamicTool({
        description,
        inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (args, options) => {
          // Throws before anything is sent when the schema cannot be compiled.
          const validate = outputValidatorOf()
          // `client.request`, not `client.callTool`: the typed verb also checks
          // the result against the tool's outputSchema and throws when it does
          // not fit - taking with it a result that DID arrive. The request is
          // the same on the wire, in both eras: on 2026-07-28 the transport
          // derives `Mcp-Method` and `Mcp-Name` from the message itself,
          // whoever built it. Only the `Mcp-Param-*` headers are the typed
          // verb's own - a mirror of arguments a tool marked with
          // `x-mcp-header`, for intermediaries; this client does not send them
          // (so a server's CORS list needs none of them for this client). A
          // request that fails (transport, protocol, abort) throws here: there
          // is no result, and the throw is recorded as a failed call.
          let res: CallToolResult
          const elicitation = elicitationSessionOf(name)
          try {
            if (elicitation) {
              // The server may ask the user something during this call
              // (`onElicitation`). The session answers - on the 2025 revisions
              // a request of the server's own, on 2026-07-28 an
              // `input_required` result followed by the same call sent again
              // with the answers and the server's state - and keeps the caps;
              // see elicitation.ts.
              const call = options as ToolCallOptions | undefined
              const run = call?.agentRun
              const signal = call?.abortSignal ?? run?.signal
              const emit = run?.emit as ((event: unknown) => void) | undefined
              const step = run?.step
              // A call made by a helper says so: the agent marks its own
              // helpers' calls, a subagent tool the calls of its host tools.
              const helper = run?.subagent ?? call?.subagentCall
              // One count per run the host started: a subagent tool's child counts on the
              // run that delegated to it.
              const counter = call?.subagentCall?.elicitations ?? run?.elicitations
              // While the user is asked, the step's time limit does not run: the clock of the run
              // the call belongs to (or of the run that delegated it, from a worker's host tool).
              const pause = run?.clock?.pause ?? call?.subagentCall?.pause
              const era = client.getProtocolEra() ?? 'legacy'
              const info: McpElicitationCallInfo = {
                tool: key,
                toolName: t.name,
                ...(signal ? { signal } : {}),
                ...(emit
                  ? {
                      emit: (event: McpElicitationEvent) =>
                        emit(
                          event.type === 'mcp.elicitation-requested' && step
                            ? { ...event, step }
                            : event,
                        ),
                    }
                  : {}),
                ...(run?.runId ? { runId: run.runId } : {}),
                ...(helper ? { subagent: { id: helper.id, depth: helper.depth } } : {}),
                ...(counter ? { run: counter } : {}),
                ...(pause ? { pause } : {}),
              }
              res = await elicitation.call(
                era,
                info,
                (leg) =>
                  client.request(
                    {
                      method: 'tools/call',
                      params: {
                        name: t.name,
                        arguments: (args ?? {}) as Record<string, unknown>,
                        ...leg.retry,
                      },
                    },
                    {
                      ...(leg.signal ? { signal: leg.signal } : {}),
                      ...(leg.ownTimeout ? { timeout: MAX_TIMER_MS } : {}),
                      // Hand an `input_required` result back instead of failing
                      // on it: the session answers it.
                      ...(era === 'modern' ? { allowInputRequired: true } : {}),
                    },
                  ) as Promise<CallToolResult>,
              )
            } else {
              res = await client.request(
                {
                  method: 'tools/call',
                  params: { name: t.name, arguments: (args ?? {}) as Record<string, unknown> },
                },
                options?.abortSignal ? { signal: options.abortSignal } : undefined,
              )
            }
          } catch (err) {
            // 2026-07-28: the server answered `input_required` (it wants the
            // user asked something, or the call sent again with a state). Not
            // supported here, and the call is not repeated.
            if (isSdkError(err, SdkErrorCode.UnsupportedResultType)) {
              throw new Error(mcpInputRequiredMessage(t.name))
            }
            throw err
          }
          // A result arrived. When it does not follow the tool's outputSchema
          // (no structuredContent, or one that does not match) it is passed on
          // with a note rather than reported as a failure — a tool the model is
          // told failed is a tool it calls again, and this one may write.
          let schemaNote: string | undefined
          const violation = validate && outputSchemaViolation(t.name, res, validate)
          if (violation) {
            schemaNote = outputSchemaNote(t.name, violation)
            log(
              'warn',
              `[mcp] ${key}: result does not follow the declared outputSchema - ${violation}; passed on with a note`,
            )
          }
          // An MCP failure is a NORMAL response with isError set — surface it
          // as a thrown error so both tool paths record a failed call instead
          // of feeding the error text to the model as a success.
          if (res.isError) {
            const flat = flattenContent(res.content)
            throw new Error(typeof flat === 'string' ? flat : JSON.stringify(flat))
          }
          // A server that returns structured content also sends it serialized
          // as text (the specification's backwards-compatible form): the model
          // gets the value once, and whatever else the content holds beside it.
          const structured = isStructuredContent(res.structuredContent)
            ? res.structuredContent
            : undefined
          const flat = flattenContent(
            structured ? dropStructuredDuplicates(res.content, structured) : res.content,
          )
          return withStructuredContent(flat, structured, schemaNote)
        },
      })
      // The agent's consent gate lets read-only tools through in 'ask-writes'.
      if (readOnly) (tools[key] as { readOnly?: boolean }).readOnly = true
      // Which server the tool came from, and that server's instructions: the
      // agent shows the notes of the servers whose tools it actually mounts.
      markMcpTool(tools[key], name, instructionsOf.get(name))
      catalog.push({ name: key, description, server: name, ...(readOnly ? { readOnly } : {}) })
      keys.push(key)
      mounted += 1
    }
    mountedKeys.set(name, keys)
    log('info', `[mcp] ${name}: ${mounted} tools mounted`)
  }

  const connects = await Promise.all(
    Object.entries(servers).map(([name, cfg]) =>
      openConnection(name, cfg, opts, log, () => closing, elicitationSessionOf(name)),
    ),
  )

  for (const server of connects) {
    if (!server.client || !server.listed) {
      results.push({
        name: server.name,
        connected: false,
        error: server.error,
        ...(server.needsAuthorization ? { needsAuthorization: true } : {}),
      })
      continue
    }
    clients.set(server.name, server.client)
    if (server.instructions) {
      log(
        'info',
        `[mcp] ${server.name}: the server sent instructions (${server.instructions.length} chars)`,
      )
      instructions.push({ server: server.name, instructions: server.instructions })
      instructionsOf.set(server.name, server.instructions)
    }
    if (server.protocol) protocols.push({ server: server.name, ...server.protocol })
    mountTools(server.name, server.client, server.listed)
    results.push({ name: server.name, connected: true })
  }

  return {
    tools,
    catalog,
    results,
    instructions,
    protocols,
    refreshServer: async (name: string) => {
      const client = clients.get(name)
      if (!client) throw new Error(`MCP server "${name}" is not connected`)
      mountTools(name, client, await listAllTools(client, () => warnTruncated(log, name)))
    },
    close: async () => {
      closing = true
      await Promise.allSettled([...clients.values()].map((c) => c.close()))
    },
  }
}
