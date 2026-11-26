import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { assertSecureOAuthUrl, FileOAuthStore, type IOAuthStore } from './mcp-oauth.ts'

/**
 * Enterprise-Managed Authorization for remote MCP servers (the MCP extension
 * `io.modelcontextprotocol/enterprise-managed-authorization`, also called Cross
 * App Access): the organization's identity provider decides which MCP servers
 * a user's client may reach, and no one is sent to a consent page.
 *
 * Two hops, both plain HTTP POSTs:
 *
 * 1. at the IdP - an RFC 8693 token exchange turns the user's ID token into an
 *    Identity Assertion JWT Authorization Grant (ID-JAG) addressed to the MCP
 *    server's authorization server;
 * 2. at the MCP authorization server - an RFC 7523 `jwt-bearer` grant turns the
 *    ID-JAG into an ordinary access token.
 *
 * The MCP SDK owns discovery (RFC 9728 / RFC 8414), the second hop and the
 * retry on a 401; this module supplies the first hop and the checks around it.
 * Only the resulting access token is stored. The ID token and the ID-JAG pass
 * through memory and are never written, logged or put in an error.
 *
 * Follows draft-ietf-oauth-identity-assertion-authz-grant and the extension's
 * 2026-07-28 revision. The browser package carries the same provider; change both.
 *
 * Pass the result to `mcpServers[name].authProvider`.
 */

/** The extension identifier a client declares in its capabilities. */
export const ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION =
  'io.modelcontextprotocol/enterprise-managed-authorization'

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const TOKEN_TYPE_ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag'
const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token'

/** Which part of the flow refused. */
export type EnterpriseOAuthHop = 'discovery' | 'idp' | 'authorization-server'

/**
 * A failure of the enterprise flow, with the hop that refused: `'discovery'`
 * (what the MCP server published cannot be trusted or used), `'idp'` (the token
 * exchange) or `'authorization-server'` (the `jwt-bearer` grant). The message
 * carries what the server answered (`error`, `error_description`), never a
 * request body, a token or a secret.
 */
export class EnterpriseOAuthError extends Error {
  readonly hop: EnterpriseOAuthHop
  /** The OAuth `error` code the server answered with, when it sent one. */
  readonly code?: string

  constructor(hop: EnterpriseOAuthHop, message: string, code?: string) {
    super(message)
    this.name = 'EnterpriseOAuthError'
    this.hop = hop
    this.code = code
  }
}

export interface IEnterpriseIdpOptions {
  /**
   * The IdP's token endpoint, where the token exchange is posted. Configured,
   * not discovered: it is where the user's ID token and the client's IdP
   * credentials go, so nothing fetched at run time may choose it.
   */
  tokenEndpoint: string
  /** This client's `client_id` at the IdP (the audience of the ID token). */
  clientId: string
  /** This client's secret at the IdP. Omit for a client the IdP treats as public. */
  clientSecret?: string
  /**
   * How the secret is sent: in an `Authorization: Basic` header (the default,
   * which every OAuth server must accept) or in the form body.
   */
  clientAuthMethod?: 'client_secret_basic' | 'client_secret_post'
}

export interface IEnterpriseOAuthProviderOptions {
  /** The MCP endpoint being authorized. */
  serverUrl: string
  /** This client's pre-registered `client_id` at the MCP server's authorization server. */
  clientId: string
  /** Its secret there. The grant is meant for confidential clients. */
  clientSecret?: string
  /**
   * The issuer of the MCP server's authorization server, when you know it.
   * Anything else the MCP server points at is then refused before a credential
   * leaves the process. Without it, the MCP server's metadata decides which
   * authorization server receives `clientSecret` and the ID-JAG.
   */
  expectedIssuer?: string
  /** The enterprise identity provider. */
  idp: IEnterpriseIdpOptions
  /**
   * The user's OpenID Connect ID token from the IdP. How it was obtained (the
   * single sign-on of your application) is yours; it is called each time a new
   * ID-JAG is needed, so return a current one. The value is never stored.
   */
  getIdToken: () => string | Promise<string>
  /** Scopes to ask the IdP for (space-separated). */
  scope?: string
  /** Defaults to a 0600 JSON file under ~/.agent. Holds the access token only. */
  store?: IOAuthStore
  /** Treat the access token as expired this many seconds early. Default 30. */
  expirySkewSeconds?: number
  /** Custom fetch for the request to the IdP. */
  fetch?: FetchLike
}

interface IStoredTokens {
  tokens: OAuthTokens
  expiresAt?: number
}

const DEFAULT_SKEW_SECONDS = 30

// origin + path + query, as the interactive provider does, under a prefix of
// its own: a token obtained for a user through the IdP is never mistaken for
// one an operator authorized by hand.
const namespaceFor = (serverUrl: string): string => {
  const u = new URL(serverUrl)
  return `mcp-enterprise-oauth:${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`
}

/** Two issuer identifiers, equal as written or differing by one trailing slash. */
const sameIssuer = (a: string, b: string): boolean => a === b || a === `${b}/` || b === `${a}/`

const stripFragment = (url: string): string => {
  const u = new URL(url)
  u.hash = ''
  return u.href
}

/**
 * RFC 9728 section 3.3, as the MCP SDK applies it: the resource a server
 * publishes must be the URL we were configured with, or a parent path of it on
 * the same origin.
 */
const resourceCovers = (resource: string, serverUrl: string): boolean => {
  let published: URL
  try {
    published = new URL(resource)
  } catch {
    return false
  }
  const requested = new URL(serverUrl)
  if (published.origin !== requested.origin) {
    return false
  }
  const slashed = (p: string): string => (p.endsWith('/') ? p : `${p}/`)
  return slashed(requested.pathname).startsWith(slashed(published.pathname))
}

/**
 * The audience and the resource of the ID-JAG, read from what discovery found
 * for THIS server and from nothing else. Throws (`hop: 'discovery'`) when the
 * published metadata cannot be trusted:
 *
 * - the authorization server and its token endpoint must be https or loopback;
 * - it must have published metadata with an `issuer`, and that issuer must be
 *   the URL the metadata was fetched for (RFC 8414 section 3.3) - otherwise a
 *   hostile server could name an honest authorization server as the audience
 *   and collect the ID-JAG at its own token endpoint;
 * - with `expectedIssuer`, it must be that one;
 * - the published resource must cover the configured server URL.
 *
 * The browser package carries the same function; change both.
 */
export const enterpriseGrantTarget = (
  serverUrl: string,
  state: OAuthDiscoveryState | undefined,
  expectedIssuer?: string,
): { audience: string; resource: string } => {
  const refuse = (message: string): never => {
    throw new EnterpriseOAuthError('discovery', `Enterprise MCP authorization: ${message}`)
  }
  if (!state) {
    return refuse('nothing is known about the authorization server of this MCP server yet')
  }
  const asUrl = String(state.authorizationServerUrl)
  const metadata = state.authorizationServerMetadata as
    { issuer?: unknown; token_endpoint?: unknown } | undefined
  const issuer = metadata?.issuer
  if (typeof issuer !== 'string' || !issuer) {
    return refuse(
      `the authorization server "${asUrl}" published no metadata with an issuer, so there is no audience to ask the identity provider for`,
    )
  }
  if (!sameIssuer(issuer, asUrl)) {
    return refuse(
      `the metadata fetched for "${asUrl}" names another issuer ("${issuer}"); refusing to request a grant for it`,
    )
  }
  if (expectedIssuer !== undefined && !sameIssuer(issuer, expectedIssuer)) {
    return refuse(
      `this MCP server points at the authorization server "${issuer}", expected "${expectedIssuer}"; refusing to send credentials there`,
    )
  }
  try {
    assertSecureOAuthUrl(asUrl, 'MCP authorization server')
    if (typeof metadata?.token_endpoint === 'string') {
      assertSecureOAuthUrl(metadata.token_endpoint, 'MCP authorization server token endpoint')
    }
  } catch (err) {
    return refuse((err as Error).message)
  }
  const published = state.resourceMetadata?.resource
  if (published !== undefined && !resourceCovers(published, serverUrl)) {
    return refuse(
      `the protected resource "${published}" this server published does not cover "${serverUrl}"`,
    )
  }
  return { audience: issuer, resource: published ?? stripFragment(serverUrl) }
}

/** Printable ASCII only, clipped: a server's words, safe to put in an error. */
const printable = (value: unknown, max = 300): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const clean = value.replace(/[^\x20-\x7e]+/g, ' ').trim()
  if (!clean) {
    return undefined
  }
  return clean.length > max ? `${clean.slice(0, max)}...` : clean
}

const formEncode = (value: string): string => new URLSearchParams({ v: value }).toString().slice(2)

/**
 * Whatever a failure message is built from, the secrets of this exchange never
 * leave in it - a server that echoes the request, or a fetch that quotes it,
 * included.
 */
const redact = (message: string, secrets: (string | undefined)[]): string => {
  let out = message
  for (const secret of secrets) {
    if (!secret) {
      continue
    }
    // As written, and as a form or a URL would spell it.
    const spellings = [secret, encodeURIComponent(secret), formEncode(secret)]
    for (const spelling of new Set(spellings)) {
      out = out.split(spelling).join('[redacted]')
    }
  }
  return out
}

export interface IIdJagRequest {
  idp: IEnterpriseIdpOptions
  /** The ID token (the subject token). */
  idToken: string
  /** The issuer of the MCP server's authorization server. */
  audience: string
  /** The resource identifier of the MCP server. */
  resource: string
  scope?: string
  fetch?: FetchLike
}

/**
 * Hop 1: exchange the ID token for an ID-JAG at the IdP's token endpoint
 * (RFC 8693, as profiled by the ID-JAG draft, section 4.3). Returns the ID-JAG.
 *
 * Throws `EnterpriseOAuthError` (`hop: 'idp'`) unless the answer is a 200 whose
 * `issued_token_type` is the ID-JAG type and whose `access_token` is a
 * non-empty string. A redirect is refused, not followed: the body holds the ID
 * token and the client secret. The browser package carries the same function;
 * change both.
 */
export const requestIdJag = async (req: IIdJagRequest): Promise<string> => {
  const { idp } = req
  const secrets = [req.idToken, idp.clientSecret]
  // Redacted BEFORE it is clipped: a clipped token no longer matches itself,
  // and the first half of a JWT is its claims.
  const said = (value: unknown, max?: number): string | undefined =>
    printable(typeof value === 'string' ? redact(value, secrets) : value, max)
  const fail = (message: string, code?: string): never => {
    throw new EnterpriseOAuthError(
      'idp',
      redact(`Enterprise IdP token exchange failed: ${message}`, secrets),
      code,
    )
  }

  const params = new URLSearchParams({
    grant_type: GRANT_TOKEN_EXCHANGE,
    requested_token_type: TOKEN_TYPE_ID_JAG,
    audience: req.audience,
    resource: req.resource,
    subject_token: req.idToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
  })
  if (req.scope) {
    params.set('scope', req.scope)
  }
  const headers = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  })
  if (idp.clientSecret === undefined || idp.clientAuthMethod === 'client_secret_post') {
    params.set('client_id', idp.clientId)
    if (idp.clientSecret !== undefined) {
      params.set('client_secret', idp.clientSecret)
    }
  } else {
    // RFC 6749 section 2.3.1: both parts are form-encoded before the base64.
    headers.set(
      'Authorization',
      `Basic ${btoa(`${formEncode(idp.clientId)}:${formEncode(idp.clientSecret)}`)}`,
    )
  }

  let response: Response
  try {
    response = await (req.fetch ?? fetch)(idp.tokenEndpoint, {
      method: 'POST',
      headers,
      body: params,
      redirect: 'error',
    })
  } catch (err) {
    return fail(
      `the request did not complete (${said((err as Error)?.message) ?? 'network error'})`,
    )
  }

  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await response.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>
    }
  } catch {
    // Not JSON: reported by status below.
  }

  if (!response.ok) {
    const code = said(body.error, 80)
    const description = said(body.error_description)
    return fail(
      `the identity provider answered ${response.status}${code ? ` ${code}` : ''}${
        description ? ` - ${description}` : ''
      }`,
      code,
    )
  }
  if (body.issued_token_type !== TOKEN_TYPE_ID_JAG) {
    return fail(
      `the identity provider returned ${
        said(body.issued_token_type, 120) ?? 'no issued_token_type'
      } where an ID-JAG (${TOKEN_TYPE_ID_JAG}) was requested; nothing was sent to the MCP authorization server`,
    )
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    return fail(
      'the identity provider returned no ID-JAG; nothing was sent to the MCP authorization server',
    )
  }
  return body.access_token
}

/**
 * A non-interactive `OAuthClientProvider`: no redirect, no browser, no human.
 * On first use, and whenever the access token is missing, expired or rejected,
 * the SDK asks it for a token request and it answers with a fresh ID-JAG.
 */
export class NodeEnterpriseOAuthProvider implements OAuthClientProvider {
  readonly serverUrl: string
  /** The MCP extension this provider implements; the connector declares it. */
  readonly extension = ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION

  private readonly store: IOAuthStore
  private readonly ns: string
  private readonly opts: IEnterpriseOAuthProviderOptions
  private readonly skewMs: number
  private readonly _clientMetadata: OAuthClientMetadata
  // Held (in memory only) between a granted ID-JAG and the access token it
  // buys: a failure in that window belongs to the MCP authorization server,
  // and its message must not carry the grant.
  private pendingAssertion: string | undefined

  constructor(opts: IEnterpriseOAuthProviderOptions) {
    assertSecureOAuthUrl(opts.serverUrl)
    assertSecureOAuthUrl(opts.idp?.tokenEndpoint, 'Enterprise IdP token endpoint')
    if (opts.expectedIssuer !== undefined) {
      assertSecureOAuthUrl(opts.expectedIssuer, 'MCP authorization server')
    }
    if (!opts.clientId || !opts.idp.clientId) {
      throw new Error('Enterprise MCP authorization: clientId and idp.clientId are required')
    }
    if (typeof opts.getIdToken !== 'function') {
      throw new Error('Enterprise MCP authorization: getIdToken is required')
    }
    this.serverUrl = opts.serverUrl
    this.opts = opts
    this.store = opts.store ?? new FileOAuthStore()
    this.ns = namespaceFor(opts.serverUrl)
    this.skewMs = (opts.expirySkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000
    this._clientMetadata = {
      client_name: 'agent',
      redirect_uris: [],
      grant_types: [GRANT_TOKEN_EXCHANGE, GRANT_JWT_BEARER],
      token_endpoint_auth_method: opts.clientSecret ? 'client_secret_basic' : 'none',
      ...(opts.scope ? { scope: opts.scope } : {}),
    }
    // Secrets and the token callback stay off anything that prints the provider.
    for (const field of ['opts', 'store', 'pendingAssertion'] as const) {
      Object.defineProperty(this, field, { enumerable: false })
    }
  }

  /** Never set: this is what tells the SDK the flow has no human step. */
  get redirectUrl(): undefined {
    return undefined
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata
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

  /**
   * The pre-registered client, from configuration and never from the store.
   * With `expectedIssuer` it carries that stamp, and the SDK then refuses to
   * present it to any other authorization server.
   */
  clientInformation(): OAuthClientInformationMixed {
    return {
      client_id: this.opts.clientId,
      ...(this.opts.clientSecret ? { client_secret: this.opts.clientSecret } : {}),
      ...(this.opts.expectedIssuer ? { issuer: this.opts.expectedIssuer } : {}),
    }
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readJSON<IStoredTokens>('tokens'))?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.pendingAssertion = undefined
    const stored: IStoredTokens = {
      tokens,
      expiresAt:
        typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined,
    }
    await this.store.set(this.key('tokens'), JSON.stringify(stored))
  }

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

  /**
   * Called by the SDK inside `auth()`, after discovery and before the token
   * request to the MCP authorization server: get an ID token from the host,
   * exchange it at the IdP for an ID-JAG addressed to exactly the authorization
   * server and resource discovery found for this server, and hand the SDK the
   * `jwt-bearer` request. Throws before anything reaches the authorization
   * server when discovery cannot be trusted or the IdP's answer is not an ID-JAG.
   */
  async prepareTokenRequest(scope?: string): Promise<URLSearchParams> {
    this.pendingAssertion = undefined
    let target: { audience: string; resource: string }
    try {
      target = enterpriseGrantTarget(
        this.serverUrl,
        await this.discoveryState(),
        this.opts.expectedIssuer,
      )
    } catch (err) {
      // Never keep a discovery result that was refused: the next attempt
      // (after the server's 401 says where its metadata lives) starts clean.
      await this.store.delete(this.key('discovery'))
      throw err
    }

    let idToken: string
    try {
      idToken = await this.opts.getIdToken()
    } catch {
      // The host's error is not repeated: it may quote the token it failed on.
      throw new EnterpriseOAuthError(
        'idp',
        'Enterprise IdP token exchange failed: getIdToken() threw, so there is no ID token to exchange',
      )
    }
    if (typeof idToken !== 'string' || !idToken) {
      throw new EnterpriseOAuthError(
        'idp',
        'Enterprise IdP token exchange failed: getIdToken() returned no ID token',
      )
    }

    const assertion = await requestIdJag({
      idp: this.opts.idp,
      idToken,
      audience: target.audience,
      resource: target.resource,
      scope: scope ?? this.opts.scope,
      fetch: this.opts.fetch,
    })
    this.pendingAssertion = assertion
    return new URLSearchParams({ grant_type: GRANT_JWT_BEARER, assertion })
  }

  /** The codes of the interactive flow: this provider has none. */
  redirectToAuthorization(): never {
    throw new Error('Enterprise MCP authorization has no interactive step')
  }
  saveCodeVerifier(): never {
    throw new Error('Enterprise MCP authorization has no interactive step')
  }
  codeVerifier(): never {
    throw new Error('Enterprise MCP authorization has no interactive step')
  }

  /**
   * Called by the SDK when the authorization server rejects what it was sent.
   * The client is configuration, so there is nothing of it to forget; tokens
   * and discovery are dropped as asked.
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const targets =
      scope === 'all'
        ? ['tokens', 'discovery']
        : scope === 'tokens' || scope === 'discovery'
          ? [scope]
          : []
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

  /**
   * Run the whole flow now (discovery, IdP exchange, grant) and store the
   * access token. `connectMcpServers` calls it before connecting when there is
   * no usable token; call it yourself to fail early. A refusal is an
   * `EnterpriseOAuthError` whose `hop` says who refused.
   */
  async authorize(opts: { fetch?: FetchLike } = {}): Promise<void> {
    try {
      await auth(this, { serverUrl: this.serverUrl, fetchFn: opts.fetch })
    } catch (err) {
      if (err instanceof EnterpriseOAuthError) {
        throw err
      }
      const pending = this.pendingAssertion
      this.pendingAssertion = undefined
      const secrets = [pending, this.opts.clientSecret, this.opts.idp.clientSecret]
      const message =
        printable(redact((err as Error)?.message ?? String(err), secrets), 500) ?? 'no reason given'
      const code = printable((err as { errorCode?: unknown })?.errorCode, 80)
      if (pending === undefined) {
        // What discovery found is not kept when the flow stopped on it.
        await this.store.delete(this.key('discovery'))
      }
      throw pending
        ? new EnterpriseOAuthError(
            'authorization-server',
            `MCP authorization server refused the ID-JAG grant: ${message}`,
            code,
          )
        : new EnterpriseOAuthError(
            'discovery',
            `Enterprise MCP authorization: discovery failed (${message})`,
            code,
          )
    }
  }

  /** Forget the access token and what discovery found for this server. */
  async reset(): Promise<void> {
    await this.invalidateCredentials('all')
  }
}

/** Convenience factory mirroring the rest of the package's `createX` style. */
export const createEnterpriseOAuthProvider = (
  opts: IEnterpriseOAuthProviderOptions,
): NodeEnterpriseOAuthProvider => new NodeEnterpriseOAuthProvider(opts)
