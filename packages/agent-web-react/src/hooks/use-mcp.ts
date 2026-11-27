import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentToolSet, McpSkillConsent } from '@dudko.dev/agent-web'
import type { McpAppsConnectionLike } from './use-mcp-app-host.js'
import {
  createElicitationQueue,
  elicitationConnectOptions,
  elicitationSettings,
  elicitationTimeoutOf,
  type ElicitationQueue,
  type PendingElicitation,
} from '../elicitation.js'
import type {
  BrowserOAuthProvider,
  BrowserOAuthProviderOptions,
  ConnectedMcp,
  McpCatalogEntry,
  McpElicitationHandler,
  McpElicitationOptions,
  McpElicitationResult,
  McpModule,
  McpOAuthCallback,
  McpOAuthRegistration,
  McpOAuthRegistrationKind,
  McpProtocolMode,
  McpServerProtocol,
  McpServerResult,
} from '../mcp-types.js'

export type McpStatus = 'idle' | 'connecting' | 'connected' | 'needs-authorization' | 'error'

/** The OAuth details of one server. Everything is optional. */
export interface McpOAuthOptions {
  /** Where the authorization server sends the user back (default: this page, without query or hash). */
  redirectUrl?: string
  /** Fallback scope when the server's metadata advertises none. */
  scope?: string
  /** `client_name` for dynamic registration (default: the hook's `clientName`). */
  clientName?: string
  /**
   * URL of a client ID metadata document (CIMD) your app hosts (default: the
   * hook's `clientMetadataUrl`). An authorization server that advertises
   * `client_id_metadata_document_supported` takes it as the `client_id` and no
   * dynamic registration is made; any other server is registered with as
   * before. Must be https with a non-root path, and the document must list the
   * `redirectUrl` in its `redirect_uris` - the core refuses anything else and
   * the server ends in `status: 'error'`. A core that does not know the option
   * ignores it and registers dynamically.
   */
  clientMetadataUrl?: string
  /**
   * How the client is registered with the server's authorization server:
   * `'auto'` (the default - the document where the server supports it, dynamic
   * registration otherwise), `'cimd'` (the document only: needs a
   * `clientMetadataUrl`, and a server without support ends in `status: 'error'`
   * before anything is sent to its registration endpoint) or `'dcr'` (dynamic
   * registration only, even with a `clientMetadataUrl`). Kept across the
   * redirect, and with the server list of `useMcpServers`. Left out, nothing is
   * passed. A core that does not know the option is refused for `'cimd'` /
   * `'dcr'` (it would register as it always did). Which way was taken is in
   * `oauthRegistration`.
   */
  registration?: McpOAuthRegistration
}

export interface McpConnectOptions {
  /** The server's StreamableHTTP endpoint. */
  url: string
  /** Prefix for the discovered tool names ("<name>__<tool>"). Default 'mcp'. */
  name?: string
  /** Static headers, e.g. `{ Authorization: 'Bearer …' }`. Ignored when `oauth` is set. */
  headers?: Record<string, string>
  /**
   * Authenticate with OAuth 2.1 + dynamic client registration. Requires a core
   * that ships the OAuth provider; check `oauthSupported` before offering it.
   */
  oauth?: boolean | McpOAuthOptions
  /**
   * The MCP protocol revisions this connection may use: `'legacy'` the 2025 revisions,
   * `'auto'` 2026-07-28 when the server offers it and the 2025 ones otherwise (one probe
   * request; from a page the server's CORS must allow `Mcp-Method` and `Mcp-Name`, or the
   * probe is blocked and the connection falls back with a warning), `'modern'` 2026-07-28 only.
   * Left out, nothing is passed and the core decides (`'legacy'`). What was negotiated is in
   * the hook's `protocol`.
   */
  protocol?: McpProtocolMode
  /**
   * EXPERIMENTAL (the MCP Skills extension is Beta): load the skills the server serves into the
   * agent's skills catalog, as `<server>/<skill>` - they come with `tools`, so nothing else is
   * wired. Needs `protocol: 'auto'` or `'modern'`. Third-party text: the core loads it as
   * knowledge only, never policy, and - unless `{ consent: 'never' }` - only after a person
   * allowed it (`useAgent().pendingApprovals`, a request with `skill`). `true` or `{ consent }`
   * (see `McpSkillsSetting`). Left out, nothing is passed (off).
   */
  skills?: McpSkillsSetting
}

/**
 * `skills` on a server, as the hooks pass it on and remember it: `true`, or `{ consent }` -
 * `'once-per-skill'` (the core's default), `'ask'` or `'never'` (see the core's
 * `McpHttpServerConfig.skills`).
 */
export type McpSkillsSetting = true | { consent?: McpSkillConsent }

/**
 * A `skills` value as the hooks take it - also from storage, so anything else is dropped: `true`,
 * an object with a known `consent` (or none: `true`), else `undefined` (off).
 */
export const mcpSkillsSettingOf = (value: unknown): McpSkillsSetting | undefined => {
  if (value === true) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const consent = (value as { consent?: unknown }).consent
  return consent === 'ask' || consent === 'once-per-skill' || consent === 'never'
    ? { consent }
    : consent === undefined
      ? true
      : undefined
}

export interface UseMcpOptions {
  /** Client name reported to the MCP server during initialize. */
  clientName?: string
  /**
   * URL of the client ID metadata document (CIMD) this app hosts, used for
   * every OAuth server unless its own `oauth.clientMetadataUrl` says otherwise.
   * See `McpOAuthOptions.clientMetadataUrl`.
   */
  clientMetadataUrl?: string
  /** Called with connector log lines — handy while debugging a server. */
  onLog?: (level: string, message: string) => void
  /**
   * MCP Apps: declare the extension and read the tools' apps (default false). The hook then
   * returns `apps` - pass it to `<AgentChat mcpApps>` - and a tool's results come with an app.
   * A tool for its app only is then not in `tools`. Needs a core with MCP Apps.
   */
  apps?: boolean
  /**
   * MCP elicitation: let a server ask the USER for input in the middle of a tool call - a
   * form, or (with `url: true`) a link to open. Off by default, and then nothing is passed to
   * the core: no capability is declared and the wire is what it was. `true` turns it on with
   * the core's defaults; an object is the core's `elicitation` settings (`url`, `timeoutMs`,
   * `maxPerToolCall`, `maxPerRun`, `subagents`). Questions land in `pendingElicitations`; show
   * them (`<ElicitationPrompt>`, or `<AgentChat elicitations>`) and answer with
   * `answerElicitation`. Read when a server connects: changing it takes a reconnect.
   */
  elicitation?: boolean | McpElicitationOptions
}

/**
 * A stable `McpAppsConnectionLike` for the hooks: each call reaches the connection the server is
 * on NOW (or says it is not connected), so it can be handed to `<AgentChat>` once.
 */
export const mcpAppsRouter = (
  connectionOf: (server: string) => ConnectedMcp | undefined,
): McpAppsConnectionLike => {
  const appsOf = (server: string) => connectionOf(server)?.apps
  const notConnected = (server: string) => new Error(`the server “${server}” is not connected`)
  return {
    readUiResource: (server, uri, options) => {
      const apps = appsOf(server)
      return apps ? apps.readUiResource(server, uri, options) : Promise.reject(notConnected(server))
    },
    appTool: (server, name) => appsOf(server)?.appTool(server, name),
    readResource: (server, uri, options) => {
      const apps = appsOf(server)
      if (!apps) return Promise.reject(notConnected(server))
      // An older core has no such read: a linked file is refused, never fetched instead.
      if (!apps.readResource) {
        return Promise.reject(new Error('this version of the core cannot read a linked file'))
      }
      return apps.readResource(server, uri, options)
    },
    callAppTool: (server, name, args, options) => {
      const apps = appsOf(server)
      return apps
        ? apps.callAppTool(server, name, args, options)
        : Promise.reject(notConnected(server))
    },
  }
}

/** What both MCP hooks return for elicitation. */
export interface McpElicitationControls {
  /**
   * Questions servers are waiting on, oldest first (empty unless `elicitation` is on). Every
   * string in a request is the SERVER's text. A question leaves the list when it is answered,
   * when the core stops waiting (its time ran out, the run stopped), when its server is
   * disconnected and when the component unmounts - the last three answer `cancel`.
   */
  pendingElicitations: PendingElicitation[]
  /**
   * Answer a pending question: `{ action: 'accept', content }` (a form's values; no content
   * for a link), `{ action: 'decline' }` or `{ action: 'cancel' }`. The answer is handed to
   * the core and kept nowhere. False when no such question is waiting any more.
   */
  answerElicitation: (id: string, result: McpElicitationResult) => boolean
}

export interface UseMcpReturn extends McpElicitationControls {
  status: McpStatus
  /** Merge into `BrowserAgentConfig.tools` once `status === 'connected'`. */
  tools?: AgentToolSet
  catalog: McpCatalogEntry[]
  /**
   * What the connected server told the agent in its handshake (its MCP `instructions`), when it
   * sent any. Third-party text that the core puts in the agent's system prompt: show it to the
   * user as the server's words, never as your own.
   */
  instructions?: string
  /**
   * The protocol revision negotiated with the connected server (`version`, `era`); absent
   * until it is connected, and on a core that does not report it.
   */
  protocol?: McpServerProtocol
  error?: string
  /** Where to send the user when `status === 'needs-authorization'`. */
  authorizationUrl?: string
  /**
   * How the OAuth client of the connected server was registered - `'cimd'`
   * (its client ID metadata document) or `'dcr'` (dynamic registration) - once
   * it is connected with OAuth, on a core that reports it.
   */
  oauthRegistration?: McpOAuthRegistrationKind
  /**
   * Whether the installed core exposes the OAuth API. `undefined` until the
   * optional subpath has been loaded once — call `checkOAuthSupport()` to
   * resolve it before offering OAuth in your UI.
   */
  oauthSupported?: boolean
  /** True while an OAuth redirect is being finished on mount. */
  completingAuthorization: boolean
  connect: (options: McpConnectOptions) => Promise<void>
  disconnect: () => Promise<void>
  /** Navigate to the authorization server. Call it from a user gesture. */
  authorize: () => void
  /** Drop the stored tokens and dynamic registration for the current server. */
  forgetAuthorization: () => Promise<void>
  /** Load the optional subpath and report whether it can do OAuth. */
  checkOAuthSupport: () => Promise<boolean>
  /** MCP Apps of the connected server (with `apps: true`): pass it to `<AgentChat mcpApps>`. */
  apps?: McpAppsConnectionLike
}

/**
 * The instructions the server `name` sent, or undefined when it sent none (or the core is too
 * old to report them). The text is the server's, not the host's: show it as such.
 */
export const mcpInstructionsOf = (
  connection: Pick<ConnectedMcp, 'instructions'>,
  name: string,
): string | undefined => {
  const list = Array.isArray(connection.instructions) ? connection.instructions : []
  const text = list.find((i) => i?.server === name)?.instructions
  return typeof text === 'string' && text.trim() ? text : undefined
}

/** What was negotiated with the server `name`, or undefined (not connected, or an older core). */
export const mcpProtocolOf = (
  connection: Pick<ConnectedMcp, 'protocols'>,
  name: string,
): McpServerProtocol | undefined => {
  const list = Array.isArray(connection.protocols) ? connection.protocols : []
  const found = list.find((p) => p?.server === name)
  return found && typeof found.version === 'string'
    ? { server: name, version: found.version, era: found.era }
    : undefined
}

/**
 * The queue of questions behind both MCP hooks (`pendingElicitations`, `answerElicitation`),
 * and the handler they give the core when `elicitation` is on. Whatever is still waiting is
 * cancelled on unmount; a question that arrives after it is cancelled at once.
 */
export const useElicitationQueue = (optionsRef: {
  current: Pick<UseMcpOptions, 'elicitation'>
}): McpElicitationControls & {
  handler: McpElicitationHandler
  /** Cancel the waiting questions: all, or one server's. */
  cancel: (server?: string) => void
} => {
  const [pendingElicitations, setPending] = useState<PendingElicitation[]>([])
  const mountedRef = useRef(true)
  const queueRef = useRef<ElicitationQueue | undefined>(undefined)
  queueRef.current ??= createElicitationQueue({
    timeoutMs: () => {
      const settings = elicitationSettings(optionsRef.current.elicitation)
      return settings ? elicitationTimeoutOf(settings) : undefined
    },
    onChange: (pending) => {
      if (mountedRef.current) setPending(pending)
    },
  })
  const queue = queueRef.current
  const handler = useCallback<McpElicitationHandler>(
    (request, ctx) =>
      mountedRef.current ? queue.handler(request, ctx) : { action: 'cancel' as const },
    [queue],
  )
  const answerElicitation = useCallback(
    (id: string, result: McpElicitationResult) => queue.answer(id, result),
    [queue],
  )
  const cancel = useCallback(
    (server?: string) =>
      queue.cancel(server === undefined ? undefined : (request) => request.server === server),
    [queue],
  )
  useEffect(() => {
    // Set again on every mount: StrictMode unmounts and remounts once in development.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      queue.cancel()
    }
  }, [queue])
  return { pendingElicitations, answerElicitation, handler, cancel }
}

export const OAUTH_UNSUPPORTED =
  'The installed @dudko.dev/agent-web has no MCP OAuth support. Upgrade the core to a version exporting BrowserOAuthProvider, or use a static Authorization header.'

const PENDING_KEY = 'agent-web-react:mcp:pending'
const OAUTH_KEY = 'agent-web-react:mcp:oauth'

/**
 * The OAuth details a redirect record keeps for one server - both hooks write one before the
 * user leaves for the authorization server, and build the provider and the reconnect from it
 * on the way back, so the client is the same both times.
 */
export interface McpOAuthRecord {
  redirectUrl: string
  scope?: string
  clientName?: string
  clientMetadataUrl?: string
  registration?: McpOAuthRegistration
}

interface OAuthRecord extends McpOAuthRecord {
  url: string
  name?: string
  /** The protocol revisions the connection was asked for, kept across the redirect. */
  protocol?: McpProtocolMode
  /** `skills` was asked for (`true` or `{ consent }`), kept across the redirect. */
  skills?: McpSkillsSetting
  /** When the redirect was started, so a stale record can't claim a callback. */
  startedAt?: number
}

// A round-trip to an authorization server and back takes seconds. Anything
// older than this is not the flow that produced the ?code= we are looking at —
// most likely another sign-in on the same page — so we leave it alone.
export const PENDING_TTL_MS = 10 * 60 * 1000

let modulePromise: Promise<McpModule> | undefined

/**
 * Load the core's optional `./mcp` subpath. Kept dynamic so apps that never
 * touch MCP don't pull `@modelcontextprotocol/client` into their bundle, and so a
 * core without the OAuth half degrades to a clear message instead of a crash.
 */
export const loadMcp = (): Promise<McpModule> => {
  modulePromise ??= import('@dudko.dev/agent-web/mcp')
    .then((m) => m as unknown as McpModule)
    .catch((err: unknown) => {
      // A rejected promise is neither null nor undefined, so ??= would cache
      // the failure forever — one flaky chunk fetch would kill MCP for the tab.
      modulePromise = undefined
      throw err
    })
  return modulePromise
}

/** Map a single server's connect outcome onto the hook's status. Pure. */
export const describeMcpResult = (
  result: McpServerResult | undefined,
): { status: McpStatus; error?: string } => {
  if (!result) return { status: 'error', error: 'The connector returned no result for the server' }
  if (result.connected) return { status: 'connected' }
  if (result.needsAuthorization) return { status: 'needs-authorization' }
  return { status: 'error', error: result.error ?? 'Could not connect to the MCP server' }
}

const OAUTH_PARAMS = ['code', 'state', 'error', 'error_description', 'iss']

/**
 * Read the authorization-code parameters out of a URL **synchronously**.
 *
 * The core exports an equivalent, but it lives behind a dynamic import: by the
 * time that import resolves, React has flushed the rest of the app's effects,
 * and any one of them may have rewritten `location` (the demo's own view
 * router did exactly that). The callback has to be captured before the first
 * await, so this parser is duplicated here on purpose.
 *
 * Reads the query string and, for hash-routed apps, the fragment. Returns
 * undefined when neither a `code` nor an `error` is present.
 */
export const readCallbackParams = (href?: string): McpOAuthCallback | undefined => {
  const target =
    href ?? (typeof globalThis.location !== 'undefined' ? globalThis.location.href : undefined)
  if (!target) return undefined
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return undefined
  }
  const params = new URLSearchParams(url.search)
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  const q = hash.indexOf('?')
  if (q >= 0) {
    for (const [k, v] of new URLSearchParams(hash.slice(q + 1))) {
      if (!params.has(k)) params.set(k, v)
    }
  }
  const code = params.get('code') ?? undefined
  const error = params.get('error') ?? undefined
  if (!code && !error) return undefined
  return {
    code,
    state: params.get('state') ?? undefined,
    // RFC 9207: the core's `finishMcpOAuth` checks it against the authorization
    // server the flow was started with, before the code is exchanged.
    iss: params.get('iss') ?? undefined,
    error,
    errorDescription: params.get('error_description') ?? undefined,
  }
}

/**
 * Remove the OAuth response parameters from a URL, leaving the rest intact —
 * query string and fragment alike. The code is single-use and lands in history,
 * referrers and screenshots, so it goes as soon as it has been read.
 */
export const stripOAuthParams = (href: string): string => {
  const url = new URL(href)
  for (const key of OAUTH_PARAMS) url.searchParams.delete(key)
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  const q = hash.indexOf('?')
  if (q >= 0) {
    const params = new URLSearchParams(hash.slice(q + 1))
    for (const key of OAUTH_PARAMS) params.delete(key)
    const rest = params.toString()
    url.hash = rest ? `${hash.slice(0, q)}?${rest}` : hash.slice(0, q)
  }
  return url.toString()
}

// An authorization code is single-use, and React StrictMode mounts every effect
// twice in development. Claiming happens synchronously, before any await, so
// the second pass cannot race the first into the token endpoint (where it would
// lose the state check and report a CSRF failure on a perfectly good flow).
const claimedCallbacks = new Set<string>()

export const claimOAuthCallback = (callback: McpOAuthCallback): boolean => {
  const key = `${callback.code ?? ''}|${callback.state ?? ''}|${callback.error ?? ''}`
  if (claimedCallbacks.has(key)) return false
  claimedCallbacks.add(key)
  return true
}

export const readRecord = <T>(key: string): T | undefined => {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}

export const writeRecord = (key: string, value: unknown): void => {
  try {
    if (value) globalThis.localStorage?.setItem(key, JSON.stringify(value))
    else globalThis.localStorage?.removeItem(key)
  } catch {
    // Private mode / storage disabled: the OAuth round-trip simply won't
    // resume automatically, which the UI already handles.
  }
}

// A redirect_uri must not carry a fragment (RFC 6749 §3.1.2), and it has to
// match the registered value byte-for-byte, so query and hash are dropped.
export const defaultRedirectUrl = (): string =>
  typeof globalThis.location === 'undefined'
    ? ''
    : `${globalThis.location.origin}${globalThis.location.pathname}`

/**
 * The options of the core's OAuth provider for one server: the server's own
 * `oauth` details first, then the hook-level defaults (`clientName`,
 * `clientMetadataUrl`), then this page as the redirect. Pure - both hooks build
 * every provider through it, on connect, on the way back from the redirect and
 * when forgetting, so the three always describe the same client.
 */
export const mcpOAuthProviderOptions = (
  serverUrl: string,
  oauth: McpOAuthOptions = {},
  defaults: Pick<McpOAuthOptions, 'clientName' | 'clientMetadataUrl'> = {},
): BrowserOAuthProviderOptions => {
  const clientMetadataUrl = oauth.clientMetadataUrl ?? defaults.clientMetadataUrl
  return {
    serverUrl,
    redirectUrl: oauth.redirectUrl ?? defaultRedirectUrl(),
    clientName: oauth.clientName ?? defaults.clientName,
    scope: oauth.scope,
    // Left out when unset: a provider built without it keeps registering dynamically.
    ...(clientMetadataUrl !== undefined ? { clientMetadataUrl } : {}),
    // Left out when unset, too: the core's default is 'auto'.
    ...(oauth.registration !== undefined ? { registration: oauth.registration } : {}),
  }
}

/**
 * What a redirect record keeps of the options `mcpOAuthProviderOptions` resolved (the server's
 * URL is kept beside it). Pure; written as JSON, so an unset field is simply absent.
 */
export const mcpOAuthRecordOf = (resolved: BrowserOAuthProviderOptions): McpOAuthRecord => ({
  redirectUrl: resolved.redirectUrl,
  scope: resolved.scope,
  clientName: resolved.clientName,
  clientMetadataUrl: resolved.clientMetadataUrl,
  ...(resolved.registration !== undefined ? { registration: resolved.registration } : {}),
})

/**
 * The OAuth details read back from a redirect record on the way in: what the provider and the
 * reconnect are built with. Pure. `registration` is passed on as it was stored - a value the
 * core does not know is refused by the core, never read as "auto".
 */
export const mcpOAuthOptionsOfRecord = (record: McpOAuthRecord): McpOAuthOptions => ({
  redirectUrl: record.redirectUrl,
  scope: record.scope,
  clientName: record.clientName,
  clientMetadataUrl: record.clientMetadataUrl,
  ...(record.registration !== undefined ? { registration: record.registration } : {}),
})

export const registrationUnsupported = (registration: McpOAuthRegistration): string =>
  `The installed @dudko.dev/agent-web does not support oauth.registration ('${registration}'): it would register as it always did. Upgrade the core, or leave registration out.`

/**
 * The core's OAuth provider for one server. A `registration` other than `'auto'` needs a core
 * that knows it - an older one would ignore it and register the old way (a document under
 * `'dcr'`, a dynamic registration under `'cimd'`) - so that is refused here, before any request.
 */
export const newMcpOAuthProvider = (
  mod: McpModule,
  options: BrowserOAuthProviderOptions,
): BrowserOAuthProvider => {
  if (!mod.BrowserOAuthProvider) throw new Error(OAUTH_UNSUPPORTED)
  const provider = new mod.BrowserOAuthProvider(options)
  const asked = options.registration
  if (asked !== undefined && asked !== 'auto' && provider.registration !== asked) {
    throw new Error(registrationUnsupported(asked))
  }
  return provider
}

/**
 * How the provider's stored client was registered (`'cimd'` / `'dcr'`), read after a sign-in;
 * undefined without a provider, on a core that does not report it, or when the read fails.
 * Never throws: it is what the UI shows, not a check.
 */
export const mcpOAuthRegistrationOf = async (
  provider: BrowserOAuthProvider | undefined,
): Promise<McpOAuthRegistrationKind | undefined> => {
  if (typeof provider?.registrationKind !== 'function') return undefined
  try {
    const kind = await provider.registrationKind()
    return kind === 'cimd' || kind === 'dcr' ? kind : undefined
  } catch {
    return undefined
  }
}

/**
 * Did this error come from the server refusing our authorization?
 *
 * Never by the message: it would also match a tool whose own error text
 * mentions "unauthorized" — the connector throws a failing tool's text
 * verbatim. Three handles, in order:
 *
 * 1. the class the core's `./mcp` subpath re-exports. On the 2.x MCP SDK
 *    (`@modelcontextprotocol/client`) `instanceof` goes by a brand the error
 *    carries, not by prototype, so it also holds when the error was made by
 *    another copy of the SDK than the one the core module resolved to (two
 *    bundles, an ESM and a CJS build on one page);
 * 2. the error's own `name`, which the 2.x class sets to `'UnauthorizedError'`
 *    (a string, so it survives a minifier; the 1.x class left it `'Error'`);
 * 3. `constructor.name`, for a core on the 1.x SDK that is too old to export
 *    the class (and only where the bundle keeps class names).
 */
export const isUnauthorizedError = (err: unknown, mod?: McpModule): boolean => {
  if (!(err instanceof Error)) return false
  if (mod?.UnauthorizedError && err instanceof mod.UnauthorizedError) return true
  if (err.name === 'UnauthorizedError') return true
  return err.constructor?.name === 'UnauthorizedError'
}

/**
 * Wrap each tool so a mid-session authorization failure is visible. Without
 * this the panel keeps reporting "connected" while every call fails: the core
 * refreshes silently on a 401, but once the refresh token is gone (revoked,
 * expired) it can only ask for a new authorization.
 */
export const watchAuthorization = (
  tools: AgentToolSet,
  mod: McpModule,
  onUnauthorized: () => void,
): AgentToolSet => {
  const entries = Object.entries(tools as Record<string, unknown>).map(([name, value]) => {
    const tool = value as { execute?: (args: unknown, options: unknown) => unknown }
    if (typeof tool.execute !== 'function') return [name, value]
    const execute = tool.execute.bind(tool)
    const watched = (args: unknown, options: unknown): unknown => {
      // Deliberately not an async function: the AI SDK inspects what `execute`
      // returns SYNCHRONOUSLY to decide whether a tool streams (isAsyncIterable),
      // so wrapping everything in a promise would collapse a streaming tool into
      // a single opaque result.
      try {
        const out = execute(args, options)
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          return (out as Promise<unknown>).then(undefined, (err: unknown) => {
            if (isUnauthorizedError(err, mod)) onUnauthorized()
            throw err
          })
        }
        return out
      } catch (err) {
        if (isUnauthorizedError(err, mod)) onUnauthorized()
        throw err
      }
    }
    return [name, { ...(value as object), execute: watched }]
  })
  return Object.fromEntries(entries) as AgentToolSet
}

/**
 * Connect the browser agent to a remote MCP server the user names at runtime —
 * static header, or full OAuth 2.1 with dynamic client registration.
 *
 * The OAuth round-trip leaves the page, so the hook persists what it needs to
 * resume: on mount it detects `?code=…`, finishes the exchange, cleans the URL
 * and reconnects, all before the app renders anything MCP-related.
 *
 * ```tsx
 * const mcp = useMcp()
 * // await mcp.connect({ url, oauth: true })
 * // mcp.status === 'needs-authorization' && <button onClick={mcp.authorize}>Authorize</button>
 * // <AgentProvider config={{ model, tools: { ...local, ...mcp.tools } }}>
 * ```
 */
export const useMcp = (options: UseMcpOptions = {}): UseMcpReturn => {
  const [status, setStatus] = useState<McpStatus>('idle')
  const [tools, setTools] = useState<AgentToolSet | undefined>(undefined)
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([])
  const [instructions, setInstructions] = useState<string | undefined>(undefined)
  const [protocol, setProtocol] = useState<McpServerProtocol | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [authorizationUrl, setAuthorizationUrl] = useState<string | undefined>(undefined)
  const [oauthRegistration, setOauthRegistration] = useState<McpOAuthRegistrationKind | undefined>(
    undefined,
  )
  const [oauthSupported, setOauthSupported] = useState<boolean | undefined>(undefined)
  const [completingAuthorization, setCompletingAuthorization] = useState(
    () => readCallbackParams() !== undefined,
  )

  const connectionRef = useRef<ConnectedMcp | undefined>(undefined)
  const providerRef = useRef<BrowserOAuthProvider | undefined>(undefined)
  // Bumped by every connect / disconnect / unmount. A handshake that finishes
  // after its epoch has passed closes itself instead of writing state or
  // leaking an open MCP session onto a dead component.
  const epochRef = useRef(0)
  // Options land in a ref so `connect` keeps a stable identity: it is a natural
  // dependency of effects in host components.
  const optionsRef = useRef(options)
  optionsRef.current = options
  const elicitation = useElicitationQueue(optionsRef)
  const cancelElicitations = elicitation.cancel

  const closeConnection = useCallback(async () => {
    const open = connectionRef.current
    connectionRef.current = undefined
    // Nobody is left to take the answers of a connection that is being closed.
    cancelElicitations()
    if (open) await open.close().catch(() => {})
  }, [cancelElicitations])

  const checkOAuthSupport = useCallback(async () => {
    try {
      const mod = await loadMcp()
      const supported = typeof mod.BrowserOAuthProvider === 'function'
      setOauthSupported(supported)
      return supported
    } catch {
      setOauthSupported(false)
      return false
    }
  }, [])

  const connect = useCallback(
    async (opts: McpConnectOptions) => {
      const epoch = ++epochRef.current
      const current = () => epochRef.current === epoch
      await closeConnection()
      if (!current()) return
      setStatus('connecting')
      setError(undefined)
      setAuthorizationUrl(undefined)
      setOauthRegistration(undefined)
      setTools(undefined)
      setCatalog([])
      setInstructions(undefined)
      setProtocol(undefined)

      try {
        const mod = await loadMcp()
        setOauthSupported(typeof mod.BrowserOAuthProvider === 'function')
        const name = opts.name ?? 'mcp'
        let authProvider: BrowserOAuthProvider | undefined

        if (opts.oauth) {
          if (!mod.BrowserOAuthProvider) throw new Error(OAUTH_UNSUPPORTED)
          const providerOptions = mcpOAuthProviderOptions(
            opts.url,
            typeof opts.oauth === 'object' ? opts.oauth : {},
            optionsRef.current,
          )
          const record: OAuthRecord = {
            url: opts.url,
            name,
            ...mcpOAuthRecordOf(providerOptions),
            ...(opts.protocol ? { protocol: opts.protocol } : {}),
            ...(mcpSkillsSettingOf(opts.skills) ? { skills: mcpSkillsSettingOf(opts.skills) } : {}),
            startedAt: Date.now(),
          }
          // Throws on a clientMetadataUrl or registration the core refuses (not
          // https, a bare origin, 'cimd' without a document, a core that does not
          // know the option): reported below as this server's error, before any request.
          authProvider = newMcpOAuthProvider(mod, providerOptions)
          providerRef.current = authProvider
          // `pending` resumes the redirect; `oauth` outlives it so tokens stay
          // addressable for forgetAuthorization() after a reload.
          writeRecord(PENDING_KEY, record)
          writeRecord(OAUTH_KEY, record)
        } else {
          providerRef.current = undefined
        }

        const connection = await mod.connectMcpHttp(
          {
            [name]: {
              url: opts.url,
              headers: opts.oauth ? undefined : opts.headers,
              authProvider,
              // Only when asked for: without it the connection is built as it always was.
              ...(opts.protocol ? { protocol: opts.protocol } : {}),
              ...(mcpSkillsSettingOf(opts.skills)
                ? { skills: mcpSkillsSettingOf(opts.skills) }
                : {}),
            },
          },
          {
            clientName: optionsRef.current.clientName,
            onLog: optionsRef.current.onLog,
            ...(optionsRef.current.apps ? { apps: true } : {}),
            // Off: neither key is passed, so the core declares no capability.
            ...elicitationConnectOptions(optionsRef.current.elicitation, elicitation.handler),
          },
        )

        if (!current()) {
          // Unmounted, or another connect started while we were shaking hands.
          await connection.close().catch(() => {})
          return
        }

        const outcome = describeMcpResult(connection.results[0])
        if (outcome.status !== 'connected') {
          await connection.close().catch(() => {})
          if (outcome.status === 'needs-authorization') {
            const url = authProvider?.authorizationUrl
            setAuthorizationUrl(url ? String(url) : undefined)
            setStatus('needs-authorization')
            return
          }
          throw new Error(outcome.error)
        }

        connectionRef.current = connection
        // The round-trip is over: a stale record would later make an unrelated
        // ?code= on this page look like ours.
        writeRecord(PENDING_KEY, undefined)
        setTools(
          watchAuthorization(connection.tools, mod, () => {
            if (!current()) return
            const url = providerRef.current?.authorizationUrl
            if (url) setAuthorizationUrl(String(url))
            setStatus('needs-authorization')
          }),
        )
        setCatalog(connection.catalog)
        setInstructions(mcpInstructionsOf(connection, name))
        setProtocol(mcpProtocolOf(connection, name))
        const registered = await mcpOAuthRegistrationOf(authProvider)
        if (!current()) return
        setOauthRegistration(registered)
        setStatus('connected')
      } catch (err) {
        if (!current()) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      }
    },
    [closeConnection, elicitation.handler],
  )

  const disconnect = useCallback(async () => {
    epochRef.current++
    await closeConnection()
    setTools(undefined)
    setCatalog([])
    setInstructions(undefined)
    setProtocol(undefined)
    setAuthorizationUrl(undefined)
    setOauthRegistration(undefined)
    setError(undefined)
    setStatus('idle')
  }, [closeConnection])

  const authorize = useCallback(() => {
    if (authorizationUrl && typeof globalThis.location !== 'undefined') {
      globalThis.location.href = authorizationUrl
    }
  }, [authorizationUrl])

  const forgetAuthorization = useCallback(async () => {
    const record = readRecord<OAuthRecord>(OAUTH_KEY)
    writeRecord(PENDING_KEY, undefined)
    writeRecord(OAUTH_KEY, undefined)
    // After a reload there is no live provider, but the tokens are still in the
    // vault — rebuild one for the same server so "forget" actually forgets
    // rather than only resetting the UI.
    let provider = providerRef.current
    if (!provider && record) {
      const mod = await loadMcp().catch(() => undefined)
      if (mod?.BrowserOAuthProvider) {
        try {
          provider = new mod.BrowserOAuthProvider(mcpOAuthProviderOptions(record.url, record))
        } catch {
          // Options the core refuses never built a provider, so nothing was stored for them.
        }
      }
    }
    await provider?.reset().catch(() => {})
    providerRef.current = undefined
    await disconnect()
  }, [disconnect])

  // Resume an OAuth round-trip: the authorization server has just sent the user
  // back with ?code=… and this component is mounting for the first time.
  useEffect(() => {
    // Everything up to the first await runs synchronously, on purpose: React
    // flushes the remaining passive effects (which may rewrite location) before
    // an awaited continuation resumes, and StrictMode runs this effect twice.
    const callback = readCallbackParams()
    if (!callback) {
      setCompletingAuthorization(false)
      return
    }
    const pending = readRecord<OAuthRecord>(PENDING_KEY)
    // A record only proves that WE started a flow, not that THIS callback is
    // its answer — so an expired one is treated as somebody else's. Either way
    // the URL is left exactly as we found it: another sign-in flow on this page
    // may still need those parameters.
    const fresh =
      pending !== undefined &&
      (pending.startedAt === undefined || Date.now() - pending.startedAt < PENDING_TTL_MS)
    if (!pending || !fresh) {
      if (pending) writeRecord(PENDING_KEY, undefined)
      setCompletingAuthorization(false)
      return
    }
    if (!claimOAuthCallback(callback)) {
      setCompletingAuthorization(false)
      return
    }
    // Ours, and claimed: the code is in hand, so clear it from the address bar
    // now rather than after the reconnect.
    if (typeof globalThis.history !== 'undefined') {
      globalThis.history.replaceState(null, '', stripOAuthParams(globalThis.location.href))
    }

    void (async () => {
      try {
        const mod = await loadMcp()
        setOauthSupported(typeof mod.BrowserOAuthProvider === 'function')
        if (!mod.BrowserOAuthProvider || !mod.finishMcpOAuth) throw new Error(OAUTH_UNSUPPORTED)
        const oauth = mcpOAuthOptionsOfRecord(pending)
        const provider = newMcpOAuthProvider(mod, mcpOAuthProviderOptions(pending.url, oauth))
        providerRef.current = provider
        await mod.finishMcpOAuth(provider, callback)
        writeRecord(PENDING_KEY, undefined)
        // NOT gated on `cancelled`. StrictMode's simulated cleanup sets it in
        // development, and the second setup cannot take over — the code has
        // already been claimed and stripped from the URL — so bailing here
        // would finish the authorization and then never connect. `connect` is
        // epoch-guarded and a setState after a real unmount is a no-op, so
        // letting it run is safe either way.
        //
        // Hand back to `connect`, which owns the status from here — a slow or
        // hung handshake must not leave the UI stuck on "finishing".
        setCompletingAuthorization(false)
        // With the details the flow was started with: the same redirect, scope,
        // client name, client ID metadata document and registration, not the
        // hook's defaults.
        await connect({
          url: pending.url,
          name: pending.name,
          oauth,
          ...(pending.protocol ? { protocol: pending.protocol } : {}),
          ...(mcpSkillsSettingOf(pending.skills)
            ? { skills: mcpSkillsSettingOf(pending.skills) }
            : {}),
        })
      } catch (err) {
        writeRecord(PENDING_KEY, undefined)
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      } finally {
        setCompletingAuthorization(false)
      }
    })()
    // Runs once: `connect` is stable and the callback exists only on first load.
  }, [connect])

  useEffect(
    () => () => {
      epochRef.current++
      void closeConnection()
    },
    [closeConnection],
  )

  const appsOn = options.apps === true
  const apps = useMemo(
    () => (appsOn ? mcpAppsRouter(() => connectionRef.current) : undefined),
    [appsOn],
  )

  return {
    apps,
    status,
    tools,
    catalog,
    instructions,
    protocol,
    error,
    authorizationUrl,
    oauthRegistration,
    oauthSupported,
    completingAuthorization,
    pendingElicitations: elicitation.pendingElicitations,
    answerElicitation: elicitation.answerElicitation,
    connect,
    disconnect,
    authorize,
    forgetAuthorization,
    checkOAuthSupport,
  }
}
