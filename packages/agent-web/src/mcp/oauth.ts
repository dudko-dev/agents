import {
  auth,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from '@modelcontextprotocol/client'
import { IndexedDBVault, type VaultOptions } from '../secrets/vault.js'

/**
 * Browser-side OAuth 2.1 for remote MCP servers: Dynamic Client Registration
 * (RFC 7591) or a client ID metadata document (CIMD) - automatically or one of
 * them only (`registration`) - PKCE authorization-code flow, refresh-token
 * rotation, and the `iss` check on the way back (RFC 9207).
 *
 * The heavy lifting lives in the MCP SDK — `auth()` discovers the protected
 * resource (RFC 9728), registers the client if we have no client_id yet,
 * exchanges the code, and refreshes expired tokens; `StreamableHTTPClient-
 * Transport` retries any 401 through it. This module supplies the missing
 * half: WHERE the tokens, the registration, and the PKCE verifier are kept,
 * and HOW the user is sent to the authorization server.
 *
 * ── WHY NO AUTOMATIC NAVIGATION ──
 * `redirectToAuthorization` deliberately does NOT navigate by default. The SDK
 * can call it from deep inside a tool call, and throwing the user out of a
 * running agent would discard in-flight state. Instead the URL is recorded on
 * `authorizationUrl`, `connectMcpHttp` reports `needsAuthorization: true`, and
 * the app decides when to send the user there (a button, a popup, a redirect).
 * Pass `onRedirect` to opt into eager navigation.
 */

/** Where an OAuth provider keeps its tokens / registration / PKCE verifier. */
export interface McpOAuthStorage {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Default storage: the same encrypted IndexedDB vault that holds provider API
 * keys (AES-GCM, non-extractable key). Read the threat model in
 * `secrets/vault.ts` — this protects tokens at rest, not against active XSS.
 */
export class VaultOAuthStorage implements McpOAuthStorage {
  private readonly vault: IndexedDBVault

  constructor(opts: VaultOptions = {}) {
    this.vault = new IndexedDBVault(opts)
  }

  get(key: string): Promise<string | undefined> {
    return this.vault.getSecret(key)
  }
  set(key: string, value: string): Promise<void> {
    return this.vault.setSecret(key, value)
  }
  delete(key: string): Promise<void> {
    return this.vault.deleteSecret(key)
  }
}

/** Non-persistent storage for tests / SSR. Tokens die with the tab. */
export class MemoryOAuthStorage implements McpOAuthStorage {
  private readonly map = new Map<string, string>()

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key)
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
}

/**
 * How the OAuth client is registered with a server's authorization server
 * (`BrowserOAuthProviderOptions.registration`):
 *
 * - `'auto'` (the default): by the client ID metadata document (CIMD) when the
 *   authorization server advertises `client_id_metadata_document_supported` and
 *   a `clientMetadataUrl` is set, by dynamic client registration (DCR, RFC 7591)
 *   otherwise. A client already in storage is used as it is.
 * - `'cimd'`: by the metadata document only. Needs `clientMetadataUrl`. An
 *   authorization server that does not advertise support is refused before
 *   anything is sent to its registration endpoint.
 * - `'dcr'`: by dynamic registration only, even with a `clientMetadataUrl` set:
 *   the SDK is never shown the URL.
 *
 * The Node package has the same option, with the same names; change both.
 */
export type McpOAuthRegistration = 'auto' | 'cimd' | 'dcr'

/** How a stored client was registered: see {@link BrowserOAuthProvider.registrationKind}. */
export type McpOAuthRegistrationKind = 'cimd' | 'dcr'

export interface BrowserOAuthProviderOptions {
  /** The MCP endpoint this provider authorizes against (the resource server). */
  serverUrl: string
  /**
   * Where the authorization server sends the user back. Must be a page of your
   * app that calls `readOAuthCallback()` + `finishMcpOAuth()`. Registered with
   * the AS via DCR, so it has to match byte-for-byte on the way back.
   */
  redirectUrl: string | URL
  /** `client_name` submitted during dynamic registration. */
  clientName?: string
  /** Fallback scope when the server's metadata advertises none. */
  scope?: string
  /** Merged over the defaults; use it for `software_id`, `contacts`, `application_type`, … */
  clientMetadata?: Partial<OAuthClientMetadata> & { application_type?: string }
  /**
   * URL of a client ID metadata document (CIMD) you host. When the
   * authorization server advertises `client_id_metadata_document_supported`,
   * this URL is used as the `client_id` and no dynamic registration is made;
   * otherwise registration runs as before. A registration already in storage
   * wins over both. Must be https with a non-root path, and the document served
   * there must list the same `redirect_uris` as `redirectUrl`. With
   * `registration: 'dcr'` it is never used as the `client_id`.
   */
  clientMetadataUrl?: string
  /**
   * How the client is registered: `'auto'` (default; as described for
   * `clientMetadataUrl`), `'cimd'` (the metadata document only: needs
   * `clientMetadataUrl`, and an authorization server without support is refused
   * before any registration request) or `'dcr'` (dynamic registration only).
   * A stored client of the other kind is not reused: it is forgotten, with the
   * tokens issued to it, and the user signs in again. See
   * {@link McpOAuthRegistration}.
   */
  registration?: McpOAuthRegistration
  /** Defaults to the encrypted IndexedDB vault. */
  storage?: McpOAuthStorage
  /** Treat an access token as expired this many seconds early. Default 30. */
  expirySkewSeconds?: number
  /** Called when the SDK wants the user at the authorization server. */
  onRedirect?: (url: URL) => void | Promise<void>
}

interface StoredTokens {
  tokens: OAuthTokens
  /** Absolute ms timestamp derived from `expires_in` at save time. */
  expiresAt?: number
}

const DEFAULT_SKEW_SECONDS = 30

// Namespacing by origin+path+query keeps two MCP servers on the same host
// (/mcp/docs vs /mcp/crm, or ?tenant=a vs ?tenant=b) from sharing a
// registration or a token — one tenant's bearer must never be sent to another.
const namespaceFor = (serverUrl: string): string => {
  const u = new URL(serverUrl)
  return `mcp-oauth:${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * OAuth over plaintext hands the bearer token to anyone on the path, so only
 * https — or a loopback host, where there is no network to sniff — is allowed.
 * Parsed rather than pattern-matched: `http://localhost.attacker.example/` is a
 * registrable host that a prefix match would wave through.
 */
export const assertSecureOAuthUrl = (url: string, label = 'MCP server'): void => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label}: "${url}" is not a valid URL`)
  }
  if (parsed.protocol === 'https:' || LOOPBACK_HOSTS.has(parsed.hostname)) return
  throw new Error(
    `${label}: MCP OAuth requires https (or a loopback host) - refusing to send tokens to "${url}"`,
  )
}

/**
 * A client ID metadata document URL is used as the `client_id`, and the
 * authorization server fetches it: it has to be https with a path of its own
 * (a bare origin identifies a site, not a client). Checked when the provider is
 * built, so a bad value fails at start-up and not in the middle of a flow.
 */
const assertClientMetadataUrl = (url: string, label = 'MCP OAuth'): void => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label}: clientMetadataUrl "${url}" is not a valid URL`)
  }
  if (parsed.protocol === 'https:' && parsed.pathname !== '/') return
  throw new Error(
    `${label}: clientMetadataUrl requires https and a non-root path - refusing "${url}"`,
  )
}

const REGISTRATIONS: readonly McpOAuthRegistration[] = ['auto', 'cimd', 'dcr']

/**
 * `registration` is checked when the provider is built: an unknown value would
 * otherwise read as "auto", and `'cimd'` without a document has nothing to sign
 * in with. The Node package carries the same function; change both.
 */
const resolveRegistration = (
  registration: unknown,
  clientMetadataUrl: string | undefined,
  label = 'MCP OAuth',
): McpOAuthRegistration => {
  if (registration === undefined) return 'auto'
  if (!REGISTRATIONS.includes(registration as McpOAuthRegistration)) {
    throw new Error(
      `${label}: registration must be 'auto', 'cimd' or 'dcr' - refusing "${String(registration)}"`,
    )
  }
  if (registration === 'cimd' && clientMetadataUrl === undefined) {
    throw new Error(
      `${label}: registration 'cimd' needs a clientMetadataUrl - the client ID metadata document to sign in with`,
    )
  }
  return registration as McpOAuthRegistration
}

// How a client was registered is stamped on its stored record under this key,
// when it is saved (the URL it was registered under is known then, and may be
// configured differently later), and taken off again before the record reaches
// the SDK: nothing of it is ever sent.
const KIND_KEY = 'x-agent-registration'

/**
 * RFC 9207: is the `iss` parameter of an authorization response the
 * authorization server this flow was started with? Throws when it is not; the
 * caller must not exchange the code then (a mix-up attack hands the code of an
 * honest server to another one's token endpoint).
 *
 * - expected issuer: the `issuer` of the stored authorization server metadata,
 *   else the authorization server URL discovery used;
 * - `iss` present: it must equal the expected issuer, compared as plain strings
 *   (RFC 9207 section 2.4: no normalization);
 * - `iss` absent: refused when the metadata says
 *   `authorization_response_iss_parameter_supported: true`;
 * - no stored discovery state (storage written by an older version): `iss` is
 *   compared with the issuer stamped on the stored client information, and with
 *   nothing to compare against the response is accepted. ({@link finishMcpOAuth}
 *   does not exchange a code in that case: see there.)
 *
 * The Node package carries the same function; change both.
 */
export const checkAuthorizationResponseIssuer = (
  iss: string | undefined,
  discoveryState: OAuthDiscoveryState | undefined,
  clientIssuer?: string,
): void => {
  // Read as it is stored, not through the SDK's type: only a literal `true` is
  // a promise (the SDK's schema keeps the flag for both metadata documents and
  // turns anything that is not a boolean into "absent").
  const metadata = discoveryState?.authorizationServerMetadata as
    { issuer?: string; authorization_response_iss_parameter_supported?: unknown } | undefined
  const expected = discoveryState
    ? (metadata?.issuer ?? String(discoveryState.authorizationServerUrl))
    : clientIssuer
  if (iss === undefined) {
    if (metadata?.authorization_response_iss_parameter_supported === true) {
      throw new Error(
        'Authorization response carried no "iss", which this authorization server says it always sends; refusing to exchange the code (possible mix-up attack)',
      )
    }
    return
  }
  if (expected !== undefined && iss !== expected) {
    throw new Error(
      `Authorization response came from issuer "${iss}", expected "${expected}"; refusing to exchange the code (possible mix-up attack)`,
    )
  }
}

const randomToken = (): string => {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * `application_type` for dynamic registration, read off the redirect URL: a
 * loopback address or a private-use scheme is how a native client is called
 * back, an https page is a web client. Said explicitly because a server that
 * tells the two apart assumes "web" when the field is absent, and then refuses
 * a loopback redirect - and one that is told "native" refuses an https one.
 * The browser and the Node package carry the same function; change both.
 */
const applicationTypeFor = (redirectUrl: string): 'native' | 'web' => {
  try {
    const u = new URL(redirectUrl)
    return u.protocol === 'https:' && !LOOPBACK_HOSTS.has(u.hostname) ? 'web' : 'native'
  } catch {
    return 'native'
  }
}

/**
 * An `OAuthClientProvider` (MCP SDK) that persists everything it is handed and
 * never navigates behind your back. One instance per MCP server.
 */
export class BrowserOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK asks for an authorization redirect; read it in your UI. */
  authorizationUrl?: URL

  readonly serverUrl: string

  private readonly storage: McpOAuthStorage
  private readonly ns: string
  private readonly _redirectUrl: string
  private readonly _clientMetadata: OAuthClientMetadata
  private readonly _clientMetadataUrl?: string
  private readonly _registration: McpOAuthRegistration
  private readonly skewMs: number
  private readonly onRedirect?: (url: URL) => void | Promise<void>
  /** Once per provider: a stored client of the other kind is forgotten (see `settle`). */
  private settled?: Promise<void>

  constructor(opts: BrowserOAuthProviderOptions) {
    assertSecureOAuthUrl(opts.serverUrl)
    if (opts.clientMetadataUrl !== undefined) {
      assertClientMetadataUrl(opts.clientMetadataUrl)
      this._clientMetadataUrl = opts.clientMetadataUrl
    }
    this._registration = resolveRegistration(opts.registration, opts.clientMetadataUrl)
    this.serverUrl = opts.serverUrl
    this.storage = opts.storage ?? new VaultOAuthStorage()
    this.ns = namespaceFor(opts.serverUrl)
    this._redirectUrl = String(opts.redirectUrl)
    this.skewMs = (opts.expirySkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000
    this.onRedirect = opts.onRedirect
    this._clientMetadata = {
      client_name: opts.clientName ?? 'agent-web',
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Public client: a browser cannot hold a client_secret. PKCE is what
      // actually protects the code exchange.
      token_endpoint_auth_method: 'none',
      // By the redirect: an https page is 'web', a loopback one (local dev) is 'native'.
      application_type: applicationTypeFor(this._redirectUrl),
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...opts.clientMetadata,
    } as OAuthClientMetadata
  }

  get redirectUrl(): string {
    return this._redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata
  }

  /**
   * The client ID metadata document URL (CIMD), when one was configured - and
   * not with `registration: 'dcr'`: the SDK uses this getter to decide, so a
   * URL it cannot see is a URL it never uses as the `client_id`.
   */
  get clientMetadataUrl(): string | undefined {
    return this._registration === 'dcr' ? undefined : this._clientMetadataUrl
  }

  /** How this provider registers its client: `'auto'`, `'cimd'` or `'dcr'`. */
  get registration(): McpOAuthRegistration {
    return this._registration
  }

  private key(suffix: string): string {
    return `${this.ns}:${suffix}`
  }

  private async readJSON<T>(suffix: string): Promise<T | undefined> {
    // The read itself is inside the guard on purpose: the default storage
    // decrypts, and an AES-GCM blob written under a key that no longer exists
    // (a partially cleared IndexedDB, a rotated vault key) throws. Treating
    // that as "no value" lets the flow re-authorize instead of every call
    // rejecting with an opaque OperationError forever.
    try {
      const raw = await this.storage.get(this.key(suffix))
      if (raw === undefined) return undefined
      return JSON.parse(raw) as T
    } catch {
      await this.storage.delete(this.key(suffix)).catch(() => {})
      return undefined
    }
  }

  async state(): Promise<string> {
    const value = randomToken()
    await this.storage.set(this.key('state'), value)
    return value
  }

  /**
   * CSRF check for the redirect back. Single-use: the stored value is dropped
   * whether or not it matched, so a replayed callback can't pass twice.
   */
  async verifyState(returned: string | undefined): Promise<boolean> {
    const expected = await this.storage.get(this.key('state'))
    await this.storage.delete(this.key('state'))
    return expected !== undefined && returned !== undefined && expected === returned
  }

  /** The stored client, without our stamp, and how it was registered. */
  private async readClient(): Promise<
    { info: OAuthClientInformationMixed; kind: McpOAuthRegistrationKind } | undefined
  > {
    const stored = await this.readJSON<Record<string, unknown>>('client')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined
    const info: Record<string, unknown> = { ...stored }
    const stamp = info[KIND_KEY]
    delete info[KIND_KEY]
    // A record saved before the stamp existed: CIMD when its client_id is the
    // document configured now.
    const kind = stamp === 'cimd' || stamp === 'dcr' ? stamp : this.kindOf(info.client_id)
    return { info: info as unknown as OAuthClientInformationMixed, kind }
  }

  private kindOf(clientId: unknown): McpOAuthRegistrationKind {
    return this._clientMetadataUrl !== undefined && clientId === this._clientMetadataUrl
      ? 'cimd'
      : 'dcr'
  }

  /**
   * May this provider use the stored client? Under `'auto'` any; under `'cimd'`
   * only the configured document itself; under `'dcr'` only one that was not
   * registered by a document.
   */
  private fits(client: { info: OAuthClientInformationMixed; kind: McpOAuthRegistrationKind }) {
    if (this._registration === 'cimd') {
      return client.kind === 'cimd' && client.info.client_id === this._clientMetadataUrl
    }
    if (this._registration === 'dcr') return client.kind === 'dcr'
    return true
  }

  /** The client and the tokens issued to it go together: a token belongs to a client. */
  private async forgetClient(): Promise<void> {
    await Promise.all(['client', 'tokens'].map((t) => this.storage.delete(this.key(t))))
  }

  /**
   * Under `'cimd'` / `'dcr'`, before the first read of the client or a token: a
   * stored client of the other kind (registered under another setting) is
   * forgotten with its tokens, so the setting is never served by the old
   * client - not even by its access token, which the transport would otherwise
   * keep sending until it expires. Once per provider (its setting is fixed); a
   * failure is not remembered.
   */
  private settle(): Promise<void> {
    if (this._registration === 'auto') return Promise.resolve()
    this.settled ??= (async () => {
      const client = await this.readClient()
      if (client && !this.fits(client)) await this.forgetClient()
    })().catch((err: unknown) => {
      this.settled = undefined
      throw err
    })
    return this.settled
  }

  /**
   * `'cimd'` with no usable client: the SDK is about to choose between the
   * document and a dynamic registration, by the authorization server metadata
   * it has just saved (`saveDiscoveryState` comes first). Without support it
   * would register - so it is stopped HERE, before any request is made, and
   * what discovery found is forgotten, so the next attempt reads the server's
   * metadata again (a server that starts supporting CIMD is noticed).
   */
  private async assertCimdSupported(): Promise<void> {
    const discovery = await this.discoveryState()
    const metadata = discovery?.authorizationServerMetadata as
      { issuer?: unknown; client_id_metadata_document_supported?: unknown } | undefined
    // Only a literal `true` is a promise, as the SDK reads it.
    if (metadata?.client_id_metadata_document_supported === true) return
    await this.storage.delete(this.key('discovery')).catch(() => {})
    const server =
      typeof metadata?.issuer === 'string' ? metadata.issuer : discovery?.authorizationServerUrl
    throw new Error(
      server
        ? `MCP OAuth: the authorization server ${server} of ${this.serverUrl} does not support client ID metadata documents (CIMD), which this connection requires (registration: 'cimd') - nothing was sent to its registration endpoint`
        : `MCP OAuth: no record of the authorization server of ${this.serverUrl}, so its support for client ID metadata documents (CIMD), which this connection requires (registration: 'cimd'), cannot be confirmed - nothing was registered`,
    )
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    await this.settle()
    const client = await this.readClient()
    if (client && this.fits(client)) return client.info
    // Written by a provider with another setting since this one settled.
    if (client) await this.forgetClient()
    if (this._registration === 'cimd') await this.assertCimdSupported()
    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    // Whatever arrived under our key (a registration response is the server's
    // text) is replaced by what this provider knows: a client whose ID is the
    // configured document is CIMD, any other was registered dynamically.
    const record: Record<string, unknown> = { ...info }
    record[KIND_KEY] = this.kindOf(info.client_id)
    await this.storage.set(this.key('client'), JSON.stringify(record))
  }

  /**
   * How the stored client was registered: `'cimd'` (its `client_id` is the
   * client ID metadata document), `'dcr'` (registered dynamically - or saved by
   * the host), or undefined when there is none this provider would use. Read it
   * after a sign-in to show the user which way was taken.
   */
  async registrationKind(): Promise<McpOAuthRegistrationKind | undefined> {
    await this.settle()
    const client = await this.readClient()
    return client && this.fits(client) ? client.kind : undefined
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    await this.settle()
    return (await this.readJSON<StoredTokens>('tokens'))?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const stored: StoredTokens = {
      tokens,
      expiresAt:
        typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined,
    }
    await this.storage.set(this.key('tokens'), JSON.stringify(stored))
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.storage.set(this.key('verifier'), verifier)
  }

  async codeVerifier(): Promise<string> {
    const v = await this.storage.get(this.key('verifier'))
    if (!v) {
      throw new Error(
        'No PKCE code verifier stored: the authorization was started in a different browser profile, or storage was cleared mid-flow',
      )
    }
    return v
  }

  /**
   * What discovery found (the authorization server, its metadata, the resource
   * metadata). The SDK reuses it instead of discovering again - after the
   * redirect back too - and {@link finishMcpOAuth} reads the expected issuer
   * from it.
   */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.storage.set(this.key('discovery'), JSON.stringify(state))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = await this.readJSON<OAuthDiscoveryState>('discovery')
    if (!state || typeof state !== 'object' || typeof state.authorizationServerUrl !== 'string') {
      return undefined
    }
    return state
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.authorizationUrl = url
    await this.onRedirect?.(url)
  }

  /**
   * Called by the SDK when the server rejects what we hold: `'tokens'` after an
   * `invalid_grant` (dead refresh token); `'client'` and then `'tokens'` after
   * an `invalid_client` (the AS forgot our dynamic registration) - what
   * discovery found is kept on purpose, the SDK checks the next callback
   * against it. `'verifier'` and `'discovery'` are in its type and handled the
   * same way: one key each. `'all'` is what {@link reset} asks for. Clearing
   * lets the SDK re-register and re-authorize without the user clearing site
   * data.
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const targets =
      scope === 'all' ? ['tokens', 'client', 'verifier', 'state', 'discovery'] : [scope]
    await Promise.all(targets.map((t) => this.storage.delete(this.key(t))))
  }

  /** True when there is no access token, or it expires within the skew window. */
  async isAccessTokenExpired(): Promise<boolean> {
    await this.settle()
    const stored = await this.readJSON<StoredTokens>('tokens')
    if (!stored?.tokens?.access_token) return true
    // No expires_in means the AS didn't say; assume it is still good and let a
    // 401 drive the refresh.
    if (stored.expiresAt === undefined) return false
    return Date.now() + this.skewMs >= stored.expiresAt
  }

  /** True once an authorization has completed for this server. */
  async isAuthorized(): Promise<boolean> {
    return (await this.tokens()) !== undefined
  }

  /** Forget tokens, registration, verifier, state and discovery for this server. */
  async reset(): Promise<void> {
    this.authorizationUrl = undefined
    await this.invalidateCredentials('all')
  }
}

export interface McpOAuthRequestOptions {
  /**
   * Custom fetch for the discovery / registration / token requests. Pass the
   * same one you give the connector so a proxy or an instrumentation wrapper
   * covers the OAuth traffic too.
   */
  fetch?: FetchLike
}

export interface McpOAuthCallback {
  code?: string
  state?: string
  /** The `iss` parameter of the response (RFC 9207), when the server sent one. */
  iss?: string
  error?: string
  errorDescription?: string
}

/**
 * Pull the authorization-code parameters out of a redirect URL. Reads the query
 * string and, for hash-routed apps, the fragment. Returns undefined when the
 * URL carries neither a `code` nor an `error`, so it is safe to call on every
 * page load.
 */
export const readOAuthCallback = (input?: string | URL): McpOAuthCallback | undefined => {
  const href = input
    ? String(input)
    : typeof globalThis.location !== 'undefined'
      ? globalThis.location.href
      : undefined
  if (!href) return undefined
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  const params = new URLSearchParams(url.search)
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  // Hash-routed apps get "#/callback?code=…"; take whatever follows the "?".
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
    iss: params.get('iss') ?? undefined,
    error,
    errorDescription: params.get('error_description') ?? undefined,
  }
}

/**
 * Finish the flow after the authorization server redirected back: verify the
 * `state`, then the issuer (RFC 9207, {@link checkAuthorizationResponseIssuer}),
 * exchange the code (PKCE) and persist the tokens. Throws when the AS returned
 * an error, when `state` doesn't match what we issued, when `iss` names another
 * authorization server, or when the exchange fails — never resolves on a
 * half-finished authorization.
 *
 * A flow whose discovery state is not in storage any more (started by a
 * version that did not keep it, or cleared in between) is not completed: the
 * code is bound to the authorization server the user was sent to, and without
 * the record of which one that was the SDK refuses the exchange. Start again
 * with {@link beginMcpOAuth}; stored tokens are not touched.
 */
export const finishMcpOAuth = async (
  provider: BrowserOAuthProvider,
  callback: McpOAuthCallback,
  opts: McpOAuthRequestOptions = {},
): Promise<void> => {
  if (callback.error) {
    throw new Error(
      `Authorization denied by the server: ${callback.error}${
        callback.errorDescription ? ` - ${callback.errorDescription}` : ''
      }`,
    )
  }
  if (!callback.code) {
    throw new Error('Authorization callback carried no code')
  }
  if (!(await provider.verifyState(callback.state))) {
    throw new Error('Authorization state mismatch; refusing to exchange the code (possible CSRF)')
  }
  // Before the exchange: a code that came from another authorization server
  // must never reach this one's token endpoint.
  const discovery = await provider.discoveryState()
  checkAuthorizationResponseIssuer(
    callback.iss,
    discovery,
    (await provider.clientInformation())?.issuer,
  )
  if (!discovery) {
    // The SDK's own gate, said in our words: it throws on this inside `auth()`.
    throw new Error(
      'Authorization cannot be completed: the record of which authorization server it was started with is not in the store (started by an older version, or cleared in between); start the authorization again',
    )
  }
  const result = await auth(provider, {
    serverUrl: provider.serverUrl,
    authorizationCode: callback.code,
    // The SDK runs its own RFC 9207 check inside `auth()`, after ours: without
    // the value it would read a response that carried `iss` as one that did not.
    iss: callback.iss,
    fetchFn: opts.fetch,
  })
  if (result !== 'AUTHORIZED') {
    throw new Error(`Token exchange did not complete (SDK returned "${result}")`)
  }
}

/**
 * Kick off (or silently renew) an authorization. Returns `'AUTHORIZED'` when a
 * usable token is in hand — including the case where a refresh token was
 * silently exchanged — or `'REDIRECT'` when the user has to visit
 * `provider.authorizationUrl`.
 */
export const beginMcpOAuth = async (
  provider: BrowserOAuthProvider,
  opts: McpOAuthRequestOptions = {},
): Promise<'AUTHORIZED' | 'REDIRECT'> => {
  provider.authorizationUrl = undefined
  return auth(provider, { serverUrl: provider.serverUrl, fetchFn: opts.fetch })
}
