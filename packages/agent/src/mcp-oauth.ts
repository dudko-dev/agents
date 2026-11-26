import { auth } from '@modelcontextprotocol/client'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
  FetchLike,
} from '@modelcontextprotocol/client'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * OAuth 2.1 for remote MCP servers, from Node.
 *
 * The MCP SDK owns the protocol - discovery (RFC 9728), dynamic client
 * registration (RFC 7591) or a client ID metadata document (CIMD), PKCE, the
 * code exchange and the refresh on 401. What it does not own, and what this
 * module supplies, is WHERE the resulting tokens live between processes, HOW an
 * operator is asked to authorize, and the check of the `iss` parameter on the
 * way back (RFC 9207).
 *
 * Pass the result to `mcpServers[name].authProvider`.
 */

/** Where a provider persists tokens, registration and the PKCE verifier. */
export interface IOAuthStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

const DEFAULT_STORE_PATH = path.join(os.homedir(), '.agent', 'mcp-oauth.json')

/**
 * A JSON file, written 0600 in a 0700 directory (tokens are bearer credentials:
 * anything that can read the file can act as the user). Each write goes through
 * a temp file + rename, so a reader never sees a half-written store and a crash
 * cannot lose one.
 *
 * Writes are serialized in-process only. Two PROCESSES sharing one file can
 * still lose an update (both read, both write, the later wins) - the default
 * path is shared, so give each process its own `filePath` when they authorize
 * against different servers concurrently.
 */
export class FileOAuthStore implements IOAuthStore {
  private readonly filePath: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(filePath: string = DEFAULT_STORE_PATH) {
    this.filePath = filePath
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      // Missing, unparseable, or parseable-but-not-an-object (a file holding
      // `null` would otherwise make every get/set throw forever).
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {}
      }
      return parsed as Record<string, string>
    } catch {
      return {}
    }
  }

  /**
   * Write via a temp file + rename, which is atomic on POSIX. A plain
   * `writeFile` truncates first, so a concurrent reader can see an empty file
   * (and start a whole new authorization), and a crash mid-write loses every
   * token in the store.
   */
  private async writeAll(all: Record<string, string>): Promise<void> {
    const tmp = `${this.filePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, this.filePath)
  }

  // Serialize read-modify-write so two saves in the same tick can't clobber
  // each other (saveTokens and saveClientInformation often land together).
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  async get(key: string): Promise<string | undefined> {
    return this.enqueue(async () => (await this.readAll())[key])
  }

  async set(key: string, value: string): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.readAll()
      all[key] = value
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
      await this.writeAll(all)
    })
  }

  async delete(key: string): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.readAll()
      if (!(key in all)) {
        return
      }
      delete all[key]
      await this.writeAll(all)
    })
  }
}

/** Non-persistent store: tokens die with the process. */
export class MemoryOAuthStore implements IOAuthStore {
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

export interface INodeOAuthProviderOptions {
  /** The MCP endpoint being authorized. */
  serverUrl: string
  /**
   * Where the authorization server sends the operator back. For a CLI this is
   * usually a loopback URL you listen on (`http://127.0.0.1:PORT/callback`);
   * whatever you pick is what gets registered, so it must match on return.
   */
  redirectUrl: string
  /** `client_name` submitted during dynamic registration. */
  clientName?: string
  /** Fallback scope when the server advertises none. */
  scope?: string
  /** Merged over the defaults (e.g. `software_id`, `contacts`, `application_type`). */
  clientMetadata?: Partial<OAuthClientMetadata> & { application_type?: string }
  /**
   * URL of a client ID metadata document (CIMD) you host. When the
   * authorization server advertises `client_id_metadata_document_supported`,
   * this URL is used as the `client_id` and no dynamic registration is made;
   * otherwise registration runs as before. A registration already in the store
   * wins over both. Must be https with a non-root path, and the document served
   * there must list the same `redirect_uris` as `redirectUrl`.
   */
  clientMetadataUrl?: string
  /** Defaults to a 0600 JSON file under ~/.agent. */
  store?: IOAuthStore
  /** Treat the access token as expired this many seconds early. Default 30. */
  expirySkewSeconds?: number
  /**
   * Invoked with the URL the operator must open. Nothing is printed or spawned
   * on your behalf - a library that writes to stdout breaks piped output, and
   * one that opens a browser surprises a server process.
   */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>
}

interface IStoredTokens {
  tokens: OAuthTokens
  expiresAt?: number
}

const DEFAULT_SKEW_SECONDS = 30

// origin + path + query: two tenants of one endpoint (?tenant=a vs ?tenant=b)
// must never share a registration or a token.
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
export const assertSecureOAuthUrl = (url: string, label = 'MCP OAuth'): void => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label}: "${url}" is not a valid URL`)
  }
  if (parsed.protocol === 'https:' || LOOPBACK_HOSTS.has(parsed.hostname)) {
    return
  }
  throw new Error(
    `${label}: requires https (or a loopback host) - refusing to send tokens to "${url}"`,
  )
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
  if (parsed.protocol === 'https:' && parsed.pathname !== '/') {
    return
  }
  throw new Error(
    `${label}: clientMetadataUrl requires https and a non-root path - refusing "${url}"`,
  )
}

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
 * - no stored discovery state (a store written by an older version): `iss` is
 *   compared with the issuer stamped on the stored client information, and with
 *   nothing to compare against the response is accepted.
 *
 * The browser package carries the same function; change both.
 */
export const checkAuthorizationResponseIssuer = (
  iss: string | undefined,
  discoveryState: OAuthDiscoveryState | undefined,
  clientIssuer?: string,
): void => {
  // The flag is not in the SDK's types. It is kept for a document served as
  // `oauth-authorization-server` (a loose schema); the SDK drops it from one
  // served only as `openid-configuration`, and then only a present `iss` is checked.
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

/**
 * A persistent `OAuthClientProvider`. Also exposes `isAccessTokenExpired`,
 * which `connectMcpServers` uses to refresh a known-dead token before the
 * first request instead of paying for a guaranteed 401.
 */
export class NodeOAuthProvider implements OAuthClientProvider {
  /** Set when an interactive authorization is required. */
  authorizationUrl?: URL

  readonly serverUrl: string

  private readonly store: IOAuthStore
  private readonly ns: string
  private readonly _redirectUrl: string
  private readonly _clientMetadata: OAuthClientMetadata
  private readonly _clientMetadataUrl?: string
  private readonly skewMs: number
  private readonly onAuthorizationUrl?: (url: URL) => void | Promise<void>

  constructor(opts: INodeOAuthProviderOptions) {
    this.serverUrl = opts.serverUrl
    this.store = opts.store ?? new FileOAuthStore()
    this.ns = namespaceFor(opts.serverUrl)
    this._redirectUrl = opts.redirectUrl
    this.skewMs = (opts.expirySkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000
    this.onAuthorizationUrl = opts.onAuthorizationUrl
    this._clientMetadata = {
      client_name: opts.clientName ?? 'agent',
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Public client. A CLI cannot keep a client_secret secret; PKCE is what
      // protects the exchange.
      token_endpoint_auth_method: 'none',
      // By the redirect: loopback (the usual CLI callback) is 'native', https is 'web'.
      application_type: applicationTypeFor(this._redirectUrl),
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...opts.clientMetadata,
    } as OAuthClientMetadata

    assertSecureOAuthUrl(opts.serverUrl)
    if (opts.clientMetadataUrl !== undefined) {
      assertClientMetadataUrl(opts.clientMetadataUrl)
      this._clientMetadataUrl = opts.clientMetadataUrl
    }
  }

  get redirectUrl(): string {
    return this._redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata
  }

  /** The client ID metadata document URL (CIMD), when one was configured. */
  get clientMetadataUrl(): string | undefined {
    return this._clientMetadataUrl
  }

  private key(suffix: string): string {
    return `${this.ns}:${suffix}`
  }

  private async readJSON<T>(suffix: string): Promise<T | undefined> {
    const raw = await this.store.get(this.key(suffix))
    if (raw === undefined) {
      return undefined
    }
    try {
      return JSON.parse(raw) as T
    } catch {
      await this.store.delete(this.key(suffix))
      return undefined
    }
  }

  async state(): Promise<string> {
    const value = randomBytes(32).toString('hex')
    await this.store.set(this.key('state'), value)
    return value
  }

  /** Single-use CSRF check for the value that comes back on the redirect. */
  async verifyState(returned: string | undefined): Promise<boolean> {
    const expected = await this.store.get(this.key('state'))
    await this.store.delete(this.key('state'))
    return expected !== undefined && returned !== undefined && expected === returned
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.readJSON<OAuthClientInformationMixed>('client')
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.set(this.key('client'), JSON.stringify(info))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readJSON<IStoredTokens>('tokens'))?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const stored: IStoredTokens = {
      tokens,
      expiresAt:
        typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined,
    }
    await this.store.set(this.key('tokens'), JSON.stringify(stored))
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.set(this.key('verifier'), verifier)
  }

  async codeVerifier(): Promise<string> {
    const v = await this.store.get(this.key('verifier'))
    if (!v) {
      throw new Error(
        'No PKCE code verifier stored: the authorization was started by another process, or the store was cleared mid-flow',
      )
    }
    return v
  }

  /**
   * What discovery found (the authorization server, its metadata, the resource
   * metadata). The SDK reuses it instead of discovering again, and
   * {@link finishMcpOAuth} reads the expected issuer from it.
   */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.store.set(this.key('discovery'), JSON.stringify(state))
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
    await this.onAuthorizationUrl?.(url)
  }

  /**
   * Called by the SDK when the server rejects what we hold: `'tokens'` on an
   * `invalid_grant` (dead refresh token), `'all'` on an `invalid_client` (the
   * AS forgot our dynamic registration). `'client'`, `'verifier'` and
   * `'discovery'` are in its type and handled the same way: one key each.
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const targets =
      scope === 'all' ? ['tokens', 'client', 'verifier', 'state', 'discovery'] : [scope]
    await Promise.all(targets.map((t) => this.store.delete(this.key(t))))
  }

  /** True when there is no access token, or it expires within the skew window. */
  async isAccessTokenExpired(): Promise<boolean> {
    const stored = await this.readJSON<IStoredTokens>('tokens')
    if (!stored?.tokens?.access_token) {
      return true
    }
    if (stored.expiresAt === undefined) {
      return false
    }
    return Date.now() + this.skewMs >= stored.expiresAt
  }

  async isAuthorized(): Promise<boolean> {
    return (await this.tokens()) !== undefined
  }

  /** Forget tokens, registration, verifier, state and discovery for this server. */
  async reset(): Promise<void> {
    this.authorizationUrl = undefined
    await this.invalidateCredentials('all')
  }
}

/** Convenience factory mirroring the rest of the package's `createX` style. */
export const createNodeOAuthProvider = (opts: INodeOAuthProviderOptions): NodeOAuthProvider =>
  new NodeOAuthProvider(opts)

export interface IOAuthRequestOptions {
  /** Custom fetch for discovery / registration / token requests. */
  fetch?: FetchLike
}

/**
 * Start (or silently renew) an authorization. `'AUTHORIZED'` means a usable
 * token is in hand - possibly obtained by exchanging a refresh token without
 * bothering anyone. `'REDIRECT'` means the operator must visit
 * `provider.authorizationUrl` and the code has to come back through
 * {@link finishMcpOAuth}.
 */
export const beginMcpOAuth = async (
  provider: NodeOAuthProvider,
  opts: IOAuthRequestOptions = {},
): Promise<'AUTHORIZED' | 'REDIRECT'> => {
  provider.authorizationUrl = undefined
  return auth(provider, { serverUrl: provider.serverUrl, fetchFn: opts.fetch })
}

/**
 * Complete the flow with the `code` (and `state`, and `iss` when the redirect
 * carried one) the authorization server sent back. Verifies `state`, then the
 * issuer (RFC 9207, {@link checkAuthorizationResponseIssuer}), exchanges the
 * code with the stored PKCE verifier and persists the tokens. Throws unless the
 * exchange fully succeeded.
 */
export const finishMcpOAuth = async (
  provider: NodeOAuthProvider,
  callback: { code: string; state?: string; iss?: string },
  opts: IOAuthRequestOptions = {},
): Promise<void> => {
  if (!(await provider.verifyState(callback.state))) {
    throw new Error('Authorization state mismatch; refusing to exchange the code (possible CSRF)')
  }
  // Before the exchange: a code that came from another authorization server
  // must never reach this one's token endpoint.
  checkAuthorizationResponseIssuer(
    callback.iss,
    await provider.discoveryState(),
    (await provider.clientInformation())?.issuer,
  )
  const result = await auth(provider, {
    serverUrl: provider.serverUrl,
    authorizationCode: callback.code,
    fetchFn: opts.fetch,
  })
  if (result !== 'AUTHORIZED') {
    throw new Error(`Token exchange did not complete (SDK returned "${result}")`)
  }
}
