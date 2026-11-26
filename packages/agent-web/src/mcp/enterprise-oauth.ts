import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createLogger } from '../logger.js'
import { assertSecureOAuthUrl, VaultOAuthStorage, type McpOAuthStorage } from './oauth.js'

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
 * Only the resulting access token is stored. The ID token, the ID-JAG and the
 * client assertions pass through memory and are never written, logged or put
 * in an error.
 *
 * The client authenticates on each hop with a secret or with a signed
 * assertion (`private_key_jwt`, RFC 7523 section 2.2). By default the audience
 * of that assertion is the issuer identifier of the server it is for and
 * nothing else, as draft-ietf-oauth-rfc7523bis requires: an assertion made for
 * the IdP is of no use at the authorization server, and the other way round.
 * For a server built to RFC 7523 as published, `assertionAudience:
 * 'token-endpoint'` and `assertionType: 'JWT'` produce the older form - see
 * `EnterpriseAssertionAudience` for what that gives up.
 *
 * Follows draft-ietf-oauth-identity-assertion-authz-grant and the extension's
 * 2026-07-28 revision. The Node package carries the same provider; change both.
 *
 * In a browser the IdP's token endpoint must allow this page's origin (CORS),
 * and a `clientSecret` in a page is readable by anyone who can open the page:
 * see docs/security.md before using one here.
 *
 * Pass the result to `connectMcpHttp`'s `servers[name].authProvider`.
 */

/** The extension identifier a client declares in its capabilities. */
export const ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION =
  'io.modelcontextprotocol/enterprise-managed-authorization'

const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const TOKEN_TYPE_ID_JAG = 'urn:ietf:params:oauth:token-type:id-jag'
const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token'
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
/** Seconds a client assertion lives: long enough for one request, no more. */
const CLIENT_ASSERTION_LIFETIME_SECONDS = 60

/** Which part of the flow refused. */
export type EnterpriseOAuthHop = 'discovery' | 'idp' | 'authorization-server'

/**
 * A failure of the enterprise flow, with the hop that refused: `'discovery'`
 * (what the MCP server published cannot be trusted or used), `'idp'` (the token
 * exchange) or `'authorization-server'` (the `jwt-bearer` grant). The message
 * is short and safe to show: never a request body, a token, an assertion, a
 * secret or a key. What the authorization server said in full goes to the log
 * (`onLog`), redacted the same way.
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

/** Signature algorithms for a `private_key_jwt` client assertion. */
export type EnterpriseAssertionAlgorithm =
  'ES256' | 'ES384' | 'ES512' | 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512'

/**
 * The private key that signs a client assertion: a `CryptoKey` (best: import
 * or generate it as non-extractable, so page script can use it but not read
 * it) or a JWK object. It must be a key for the chosen `algorithm` (an ECDSA
 * P-256 key for ES256, an RSASSA-PKCS1-v1_5 key for RS256, RSA-PSS for PS256...).
 */
export type EnterprisePrivateKey = JsonWebKey | CryptoKey

/**
 * What a `private_key_jwt` client assertion names as its audience (`aud`).
 *
 * - `'issuer'` (the default): the issuer identifier of the server the
 *   assertion is for, as draft-ietf-oauth-rfc7523bis requires.
 * - `'token-endpoint'`: the URL of that server's token endpoint, which is what
 *   RFC 7523 as published describes and what many deployed identity providers
 *   check for.
 *
 * The default is the issuer because an assertion addressed to a token endpoint
 * URL is exactly what the bis draft forbids. The token endpoint is one field of
 * a metadata document; a client that reads its audience from metadata can be
 * handed a document that names an honest server's endpoint (audience
 * injection), and then signs an assertion the party that served the document
 * can replay at that honest server. The issuer identifier is the one value a
 * client checks before it trusts the rest of the document. This provider never
 * takes either value from the MCP server alone - the IdP's endpoint is
 * configuration, and the authorization server's is used only after its
 * metadata matched `expectedIssuer` - so `'token-endpoint'` here costs the
 * defence in depth, not the check itself. Use it only for a server that
 * refuses the issuer form.
 */
export type EnterpriseAssertionAudience = 'issuer' | 'token-endpoint'

/**
 * The `typ` header of a client assertion: `client-authentication+jwt` (the
 * default, from draft-ietf-oauth-rfc7523bis: a token typed this way cannot be
 * mistaken for another kind of JWT) or `JWT`, for a server that refuses a
 * `typ` it does not know.
 */
export type EnterpriseAssertionType = 'client-authentication+jwt' | 'JWT'

/** Where the provider reports what it will not put in an error. */
export type EnterpriseOAuthLog = (level: 'info' | 'warn' | 'error', message: string) => void

export interface EnterpriseIdpOptions {
  /**
   * The IdP's token endpoint, where the token exchange is posted. Configured,
   * not discovered: it is where the user's ID token and the client's IdP
   * credentials go, so nothing fetched at run time may choose it.
   */
  tokenEndpoint: string
  /**
   * The IdP's issuer identifier. REQUIRED with `private_key_jwt`, where it is
   * the audience of the client assertion - unless `assertionAudience` is
   * `'token-endpoint'`, which addresses the assertion to `tokenEndpoint`.
   */
  issuer?: string
  /** This client's `client_id` at the IdP (the audience of the ID token). */
  clientId: string
  /**
   * This client's secret at the IdP. Omit for a client the IdP treats as
   * public. In a browser it is readable by anyone who can open the page: leave
   * it out and pass a `fetch` that sends this request through your backend.
   */
  clientSecret?: string
  /**
   * How the client authenticates at the IdP. With a secret: in an
   * `Authorization: Basic` header (the default, which every OAuth server must
   * accept) or in the form body. `'private_key_jwt'`: a signed assertion, which
   * needs `privateKey`, `algorithm` and `issuer` (or `assertionAudience:
   * 'token-endpoint'`).
   */
  clientAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt'
  /** The key for `private_key_jwt`. Never stored, logged or put in an error. */
  privateKey?: EnterprisePrivateKey
  /** `kid` header of the assertion: the key's id in the JWKS the IdP holds. */
  keyId?: string
  /** Signature algorithm of the assertion. */
  algorithm?: EnterpriseAssertionAlgorithm
  /**
   * The audience of the assertion: `'issuer'` (the default: `issuer`) or
   * `'token-endpoint'` (`tokenEndpoint`, for an IdP built to RFC 7523 - the
   * weaker form, see `EnterpriseAssertionAudience`). Only with `private_key_jwt`.
   */
  assertionAudience?: EnterpriseAssertionAudience
  /**
   * The `typ` header of the assertion: `'client-authentication+jwt'` (the
   * default) or `'JWT'` for an IdP that refuses the new one. Only with
   * `private_key_jwt`.
   */
  assertionType?: EnterpriseAssertionType
}

export interface EnterpriseOAuthProviderOptions {
  /** The MCP endpoint being authorized. */
  serverUrl: string
  /**
   * This client's `client_id` at the MCP server's authorization server: a
   * pre-registered identifier, or the https URL of a client ID metadata
   * document (CIMD) you host. A URL must be https with a path of its own, and
   * cannot be used with `clientSecret`: a document anyone can read establishes
   * no shared secret, so such a client is public or uses `private_key_jwt`
   * with the keys the document lists (`jwks` / `jwks_uri`).
   */
  clientId: string
  /**
   * Its secret there. The grant is meant for confidential clients. A secret
   * needs `expectedIssuer`: without it the MCP server's metadata would choose
   * who receives the secret, and the constructor throws.
   *
   * In a browser a secret is readable by anyone who can open the page. This
   * provider is for public clients there, or for a `fetch` that routes the IdP
   * call through your backend, which holds the secret.
   */
  clientSecret?: string
  /**
   * How the client authenticates at the authorization server. Left out, the
   * SDK decides: a secret is sent the way the server's metadata allows (Basic
   * first), no secret means `client_id` alone. `'private_key_jwt'` signs an
   * assertion and needs `privateKey`, `algorithm` and `expectedIssuer`.
   */
  clientAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt' | 'none'
  /** The key for `private_key_jwt`. Never stored, logged or put in an error. */
  privateKey?: EnterprisePrivateKey
  /** `kid` header of the assertion: the key's id in the JWKS the server holds. */
  keyId?: string
  /** Signature algorithm of the assertion. */
  algorithm?: EnterpriseAssertionAlgorithm
  /**
   * The audience of the assertion for the authorization server: `'issuer'`
   * (the default: the issuer discovery found, once it matched
   * `expectedIssuer`) or `'token-endpoint'` (the token endpoint from that same
   * metadata, for a server built to RFC 7523 - the weaker form, see
   * `EnterpriseAssertionAudience`). The endpoint is read only from metadata
   * whose issuer is `expectedIssuer`, and must be https or loopback. Only with
   * `private_key_jwt`.
   */
  assertionAudience?: EnterpriseAssertionAudience
  /**
   * The `typ` header of the assertion: `'client-authentication+jwt'` (the
   * default) or `'JWT'` for a server that refuses the new one. Only with
   * `private_key_jwt`.
   */
  assertionType?: EnterpriseAssertionType
  /**
   * The issuer of the MCP server's authorization server. Anything else the MCP
   * server points at is refused before a credential leaves the process.
   * REQUIRED with `clientSecret` and with `private_key_jwt`: neither the
   * receiver of a secret nor the audience of a signed assertion may come from
   * the MCP server's metadata alone. A client with no credential at the
   * authorization server may omit it: then the only thing sent there is the
   * ID-JAG, which the IdP addressed to that one server and which is of no use
   * to any other.
   */
  expectedIssuer?: string
  /** The enterprise identity provider. */
  idp: EnterpriseIdpOptions
  /**
   * The user's OpenID Connect ID token from the IdP. How it was obtained (the
   * single sign-on of your application) is yours; it is called each time a new
   * ID-JAG is needed, so return a current one. The value is never stored.
   */
  getIdToken: () => string | Promise<string>
  /** Scopes to ask the IdP for (space-separated). */
  scope?: string
  /** Defaults to the encrypted IndexedDB vault. Holds the access token only. */
  storage?: McpOAuthStorage
  /** Treat the access token as expired this many seconds early. Default 30. */
  expirySkewSeconds?: number
  /** Custom fetch for the request to the IdP. */
  fetch?: FetchLike
  /**
   * Receives the detail a refusal's error leaves out (what the authorization
   * server answered), redacted. `connectMcpHttp` passes its `onLog`; this is
   * for a provider used without it. With neither, it goes to the package's
   * logger at `warn` (`[agent-web]` on the console).
   */
  onLog?: EnterpriseOAuthLog
}

interface StoredTokens {
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
 * for THIS server and from nothing else - and, once every check below has
 * passed, the token endpoint that metadata names (the audience of a client
 * assertion under `assertionAudience: 'token-endpoint'`). Throws (`hop:
 * 'discovery'`) when the published metadata cannot be trusted:
 *
 * - the authorization server and its token endpoint must be https or loopback;
 * - it must have published metadata with an `issuer`, and that issuer must be
 *   the URL the metadata was fetched for (RFC 8414 section 3.3) - otherwise a
 *   hostile server could name an honest authorization server as the audience
 *   and collect the ID-JAG at its own token endpoint;
 * - with `expectedIssuer`, it must be that one;
 * - the published resource must cover the configured server URL.
 *
 * The Node package carries the same function; change both.
 */
export const enterpriseGrantTarget = (
  serverUrl: string,
  state: OAuthDiscoveryState | undefined,
  expectedIssuer?: string,
): { audience: string; resource: string; tokenEndpoint?: string } => {
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
  return {
    audience: issuer,
    resource: published ?? stripFragment(serverUrl),
    // Handed out only here, after the issuer and the scheme checks above.
    ...(typeof metadata?.token_endpoint === 'string' && metadata.token_endpoint
      ? { tokenEndpoint: metadata.token_endpoint }
      : {}),
  }
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

const ALGORITHMS: readonly EnterpriseAssertionAlgorithm[] = [
  'ES256',
  'ES384',
  'ES512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
]

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const base64UrlJson = (value: unknown): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)))

// ── signing: the one part the two packages do differently ──────────────────
// The browser signs with WebCrypto; the Node package with node:crypto.

const isCryptoKey = (key: EnterprisePrivateKey): key is CryptoKey =>
  typeof (key as CryptoKey).extractable === 'boolean' &&
  typeof (key as CryptoKey).algorithm === 'object' &&
  Array.isArray((key as CryptoKey).usages)

/** The signature (raw bytes, JWS form) of `input` under `algorithm`. Throws on a key that does not fit. */
const signAssertionInput = async (
  algorithm: EnterpriseAssertionAlgorithm,
  privateKey: EnterprisePrivateKey,
  input: string,
): Promise<Uint8Array> => {
  const bits = algorithm.slice(2)
  const hash = `SHA-${bits}`
  const family = algorithm.slice(0, 2)
  const importAs =
    family === 'ES'
      ? { name: 'ECDSA', namedCurve: bits === '512' ? 'P-521' : `P-${bits}` }
      : { name: family === 'PS' ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5', hash }
  const signAs =
    family === 'ES'
      ? { name: 'ECDSA', hash }
      : family === 'PS'
        ? { name: 'RSA-PSS', saltLength: Number(bits) / 8 }
        : { name: 'RSASSA-PKCS1-v1_5' }
  const { subtle } = globalThis.crypto
  let key: CryptoKey
  if (isCryptoKey(privateKey)) {
    key = privateKey
    // A key made for another scheme, curve or hash must not sign under this name.
    const made = key.algorithm as { name?: string; namedCurve?: string; hash?: { name?: string } }
    const fits =
      key.type === 'private' &&
      made.name === importAs.name &&
      (family === 'ES'
        ? made.namedCurve === (importAs as { namedCurve: string }).namedCurve
        : made.hash?.name === hash)
    if (!fits) {
      throw new Error('key does not fit the algorithm')
    }
  } else {
    if (typeof (privateKey as { d?: unknown }).d !== 'string') {
      throw new Error('not a private key')
    }
    // Imported as non-extractable, for signing only. `alg`, `use` and `key_ops`
    // are left out: a JWK labelled for something else would refuse to import.
    const { alg: _alg, use: _use, key_ops: _ops, ...jwk } = privateKey as JsonWebKey
    key = await subtle.importKey('jwk', jwk, importAs, false, ['sign'])
  }
  return new Uint8Array(await subtle.sign(signAs, key, new TextEncoder().encode(input)))
}

// ── end of signing ─────────────────────────────────────────────────────────

/** The strings of a key that must never be seen: a JWK's private members. A `CryptoKey` has none to read. */
const keySecrets = (key: EnterprisePrivateKey | undefined): string[] => {
  if (key === undefined) {
    return []
  }
  const jwk = key as Record<string, unknown>
  return ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']
    .map((member) => jwk[member])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
}

export interface ClientAssertionRequest {
  /** The client: both `iss` and `sub`. */
  clientId: string
  /**
   * The sole `aud`: the issuer identifier of the server the assertion is for
   * or, for a server built to RFC 7523, the URL of its token endpoint.
   */
  audience: string
  privateKey: EnterprisePrivateKey
  algorithm: EnterpriseAssertionAlgorithm
  keyId?: string
  /** The `typ` header. Default `client-authentication+jwt`. */
  type?: EnterpriseAssertionType
}

/**
 * A `private_key_jwt` client assertion (RFC 7523 section 2.2, with the audience
 * rule of draft-ietf-oauth-rfc7523bis): `iss` = `sub` = the client, `aud` = the
 * one audience the caller chose (the provider passes the issuer identifier of
 * the server it is for, or its token endpoint URL when configured to), a
 * random `jti`, `iat`, and an `exp` one minute away; header `typ`
 * `client-authentication+jwt` unless `type` says `JWT`. A failure to sign says
 * so and nothing more: the underlying error may describe the key. The Node
 * package carries the same function; change both.
 */
export const createClientAssertion = async (req: ClientAssertionRequest): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    alg: req.algorithm,
    typ: req.type === 'JWT' ? 'JWT' : 'client-authentication+jwt',
    ...(req.keyId ? { kid: req.keyId } : {}),
  }
  const payload = {
    iss: req.clientId,
    sub: req.clientId,
    aud: req.audience,
    jti: globalThis.crypto.randomUUID(),
    iat: now,
    exp: now + CLIENT_ASSERTION_LIFETIME_SECONDS,
  }
  const input = `${base64UrlJson(header)}.${base64UrlJson(payload)}`
  let signature: Uint8Array
  try {
    signature = await signAssertionInput(req.algorithm, req.privateKey, input)
  } catch {
    throw new Error(
      `Enterprise MCP authorization: could not sign the client assertion with ${req.algorithm}; check that privateKey is a private key for that algorithm`,
    )
  }
  return `${input}.${base64Url(signature)}`
}

export interface IdJagRequest {
  idp: EnterpriseIdpOptions
  /** The ID token (the subject token). */
  idToken: string
  /** The issuer of the MCP server's authorization server. */
  audience: string
  /** The resource identifier of the MCP server. */
  resource: string
  scope?: string
  /** The signed client assertion, when the IdP client uses `private_key_jwt`. */
  clientAssertion?: string
  fetch?: FetchLike
}

/**
 * Hop 1: exchange the ID token for an ID-JAG at the IdP's token endpoint
 * (RFC 8693, as profiled by the ID-JAG draft, section 4.3). Returns the ID-JAG.
 *
 * Throws `EnterpriseOAuthError` (`hop: 'idp'`) unless the answer is a 200 whose
 * `issued_token_type` is the ID-JAG type and whose `access_token` is a
 * non-empty string. A redirect is refused, not followed: the body holds the ID
 * token and the client's credential. The browser package carries the same
 * function; change both.
 */
export const requestIdJag = async (req: IdJagRequest): Promise<string> => {
  const { idp } = req
  const secrets = [
    req.idToken,
    idp.clientSecret,
    req.clientAssertion,
    ...keySecrets(idp.privateKey),
  ]
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
  if (idp.clientAuthMethod === 'private_key_jwt') {
    if (!req.clientAssertion) {
      return fail('no client assertion was made for the identity provider')
    }
    params.set('client_assertion_type', CLIENT_ASSERTION_TYPE)
    params.set('client_assertion', req.clientAssertion)
  } else if (idp.clientSecret === undefined || idp.clientAuthMethod === 'client_secret_post') {
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

/** An https URL with a path of its own: a client ID metadata document. */
const looksLikeUrl = (value: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(value)

const configError = (message: string): Error =>
  new Error(`Enterprise MCP authorization: ${message}`)

const ASSERTION_AUDIENCES: readonly unknown[] = ['issuer', 'token-endpoint']
const ASSERTION_TYPES: readonly unknown[] = ['client-authentication+jwt', 'JWT']

/**
 * The two options that shape a client assertion, for one hop (`prefix` is ''
 * or 'idp.'): a value that is not one of the known ones is refused rather than
 * read as the default, and so is either option where no assertion is signed.
 */
const checkAssertionShape = (
  prefix: string,
  hop: { clientAuthMethod?: string; assertionAudience?: unknown; assertionType?: unknown },
): void => {
  if (hop.assertionAudience !== undefined && !ASSERTION_AUDIENCES.includes(hop.assertionAudience)) {
    throw configError(`${prefix}assertionAudience must be 'issuer' or 'token-endpoint'`)
  }
  if (hop.assertionType !== undefined && !ASSERTION_TYPES.includes(hop.assertionType)) {
    throw configError(`${prefix}assertionType must be 'client-authentication+jwt' or 'JWT'`)
  }
  if (
    hop.clientAuthMethod !== 'private_key_jwt' &&
    (hop.assertionAudience !== undefined || hop.assertionType !== undefined)
  ) {
    throw configError(
      `${prefix}assertionAudience and ${prefix}assertionType are only used with ${prefix}clientAuthMethod 'private_key_jwt'`,
    )
  }
}

/**
 * What is wrong with the options, said when the provider is built and not in
 * the middle of a flow. Every rule here keeps a credential from going where
 * nobody chose to send it. The browser package carries the same function;
 * change both.
 */
const checkOptions = (opts: EnterpriseOAuthProviderOptions): void => {
  assertSecureOAuthUrl(opts.serverUrl)
  assertSecureOAuthUrl(opts.idp?.tokenEndpoint, 'Enterprise IdP token endpoint')
  if (opts.expectedIssuer !== undefined) {
    assertSecureOAuthUrl(opts.expectedIssuer, 'MCP authorization server')
  }
  const { idp } = opts
  if (!opts.clientId || !idp.clientId) {
    throw configError('clientId and idp.clientId are required')
  }
  if (typeof opts.getIdToken !== 'function') {
    throw configError('getIdToken is required')
  }

  // The client at the MCP authorization server.
  const method = opts.clientAuthMethod
  if (looksLikeUrl(opts.clientId)) {
    let url: URL | undefined
    try {
      url = new URL(opts.clientId)
    } catch {
      // Reported below.
    }
    if (!url || url.protocol !== 'https:' || url.pathname === '/') {
      throw configError(
        `a clientId that is a URL is a client ID metadata document: it requires https and a non-root path - refusing "${opts.clientId}"`,
      )
    }
    if (opts.clientSecret) {
      throw configError(
        'a client ID metadata document cannot be used with clientSecret: use private_key_jwt, or no credential',
      )
    }
  }
  if (opts.clientSecret && (method === 'private_key_jwt' || method === 'none')) {
    throw configError(`clientSecret is not used with clientAuthMethod '${method}': remove one`)
  }
  if ((method === 'client_secret_basic' || method === 'client_secret_post') && !opts.clientSecret) {
    throw configError(`clientAuthMethod '${method}' needs clientSecret`)
  }
  if (opts.clientSecret && opts.expectedIssuer === undefined) {
    throw configError(
      'clientSecret needs expectedIssuer: without the issuer of the authorization server, the MCP server decides who receives the secret',
    )
  }
  if (method === 'private_key_jwt') {
    if (opts.privateKey === undefined || !ALGORITHMS.includes(opts.algorithm as never)) {
      throw configError(
        `clientAuthMethod 'private_key_jwt' needs privateKey and an algorithm (${ALGORITHMS.join(', ')})`,
      )
    }
    if (opts.expectedIssuer === undefined) {
      throw configError(
        'private_key_jwt needs expectedIssuer: the audience of the client assertion must not come from the MCP server alone',
      )
    }
  } else if (opts.privateKey !== undefined) {
    throw configError("privateKey is only used with clientAuthMethod 'private_key_jwt'")
  }

  checkAssertionShape('', opts)

  // The client at the IdP.
  checkAssertionShape('idp.', idp)
  if (idp.clientAuthMethod === 'private_key_jwt') {
    if (idp.privateKey === undefined || !ALGORITHMS.includes(idp.algorithm as never)) {
      throw configError(
        `idp.clientAuthMethod 'private_key_jwt' needs idp.privateKey and an idp.algorithm (${ALGORITHMS.join(', ')})`,
      )
    }
    // The audience is configuration either way: the issuer, or the token
    // endpoint that is required above. Only the former needs `idp.issuer`.
    if (idp.assertionAudience !== 'token-endpoint' && !idp.issuer) {
      throw configError(
        "idp.clientAuthMethod private_key_jwt needs idp.issuer: it is the audience of the client assertion (or set idp.assertionAudience to 'token-endpoint')",
      )
    }
    if (idp.clientSecret) {
      throw configError("idp.clientSecret is not used with idp.clientAuthMethod 'private_key_jwt'")
    }
  } else if (idp.privateKey !== undefined) {
    throw configError("idp.privateKey is only used with idp.clientAuthMethod 'private_key_jwt'")
  }
  if (idp.issuer !== undefined) {
    assertSecureOAuthUrl(idp.issuer, 'Enterprise IdP issuer')
  }
}

/** One named parameter of a form body, however the caller spelled the body. */
const formParam = (body: unknown, name: string): string | undefined => {
  if (body instanceof URLSearchParams) {
    return body.get(name) ?? undefined
  }
  if (typeof body === 'string') {
    return new URLSearchParams(body).get(name) ?? undefined
  }
  return undefined
}

/** An OAuth `error` code as RFC 6749 spells one, or nothing. */
const oauthCode = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined

/**
 * A non-interactive `OAuthClientProvider`: no redirect, no browser, no human.
 * On first use, and whenever the access token is missing, expired or rejected,
 * the SDK asks it for a token request and it answers with a fresh ID-JAG.
 */
export class BrowserEnterpriseOAuthProvider implements OAuthClientProvider {
  readonly serverUrl: string
  /** The MCP extension this provider implements; the connector declares it. */
  readonly extension = ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION
  /**
   * Present only with an explicit `clientAuthMethod`: the SDK then leaves the
   * client authentication of the grant to it (a `private_key_jwt` assertion is
   * signed here, for the issuer discovery found and `expectedIssuer` confirmed).
   */
  addClientAuthentication?: OAuthClientProvider['addClientAuthentication']

  // True private fields: the options hold the secrets, the private keys and the
  // ID token callback, and nothing that prints or serializes the provider
  // (console.log, the devtools object view, JSON.stringify) can reach them.
  readonly #opts: EnterpriseOAuthProviderOptions
  readonly #storage: McpOAuthStorage
  readonly #ns: string
  readonly #skewMs: number
  readonly #clientMetadata: OAuthClientMetadata
  // Held (in memory only) between a granted ID-JAG and the access token it
  // buys: a failure in that window belongs to the MCP authorization server,
  // and nothing said about it may carry the grant or the client assertion.
  #pendingAssertion: string | undefined
  #pendingClientAssertion: string | undefined

  constructor(opts: EnterpriseOAuthProviderOptions) {
    checkOptions(opts)
    this.serverUrl = opts.serverUrl
    this.#opts = opts
    this.#storage = opts.storage ?? new VaultOAuthStorage()
    this.#ns = namespaceFor(opts.serverUrl)
    this.#skewMs = (opts.expirySkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000
    this.#clientMetadata = {
      client_name: 'agent-web',
      redirect_uris: [],
      grant_types: [GRANT_TOKEN_EXCHANGE, GRANT_JWT_BEARER],
      token_endpoint_auth_method:
        opts.clientAuthMethod ?? (opts.clientSecret ? 'client_secret_basic' : 'none'),
      ...(opts.scope ? { scope: opts.scope } : {}),
    }
    if (opts.clientAuthMethod !== undefined) {
      this.addClientAuthentication = (headers, params) => this.#authenticateClient(headers, params)
    }
  }

  /** Never set: this is what tells the SDK the flow has no human step. */
  get redirectUrl(): undefined {
    return undefined
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.#clientMetadata
  }

  #key(suffix: string): string {
    return `${this.#ns}:${suffix}`
  }

  async #readJSON<T>(suffix: string): Promise<T | undefined> {
    // The read is inside the guard: the default storage decrypts, and a blob
    // written under a key that no longer exists throws. That is "no value".
    try {
      const raw = await this.#storage.get(this.#key(suffix))
      if (raw === undefined) {
        return undefined
      }
      return JSON.parse(raw) as T
    } catch {
      await this.#storage.delete(this.#key(suffix)).catch(() => {})
      return undefined
    }
  }

  /** Everything of this provider that must not appear in an error or a log line. */
  #secrets(): (string | undefined)[] {
    return [
      this.#pendingAssertion,
      this.#pendingClientAssertion,
      this.#opts.clientSecret,
      this.#opts.idp.clientSecret,
      ...keySecrets(this.#opts.privateKey),
      ...keySecrets(this.#opts.idp.privateKey),
    ]
  }

  /** The detail an error leaves out, to the log: redacted first, then clipped. */
  #report(log: EnterpriseOAuthLog | undefined, detail: string): void {
    // With no log given, the package's logger: the detail is not lost, and it
    // is as redacted there as anywhere.
    const sink: EnterpriseOAuthLog =
      log ?? this.#opts.onLog ?? ((_level, message) => createLogger().warn(message))
    const safe = printable(redact(detail, this.#secrets()), 600) ?? 'no detail'
    try {
      sink('warn', `[mcp] enterprise authorization for ${this.serverUrl}: ${safe}`)
    } catch {
      // A log sink that throws does not get to change the outcome.
    }
  }

  /**
   * The pre-registered client, from configuration and never from storage.
   * With `expectedIssuer` it carries that stamp, and the SDK then refuses to
   * present it to any other authorization server.
   */
  clientInformation(): OAuthClientInformationMixed {
    return {
      client_id: this.#opts.clientId,
      ...(this.#opts.clientSecret ? { client_secret: this.#opts.clientSecret } : {}),
      ...(this.#opts.expectedIssuer ? { issuer: this.#opts.expectedIssuer } : {}),
    }
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.#readJSON<StoredTokens>('tokens'))?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.#pendingAssertion = undefined
    this.#pendingClientAssertion = undefined
    const stored: StoredTokens = {
      tokens,
      expiresAt:
        typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined,
    }
    await this.#storage.set(this.#key('tokens'), JSON.stringify(stored))
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.#storage.set(this.#key('discovery'), JSON.stringify(state))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const state = await this.#readJSON<OAuthDiscoveryState>('discovery')
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
    this.#pendingAssertion = undefined
    this.#pendingClientAssertion = undefined
    let target: { audience: string; resource: string }
    try {
      target = enterpriseGrantTarget(
        this.serverUrl,
        await this.discoveryState(),
        this.#opts.expectedIssuer,
      )
    } catch (err) {
      // Never keep a discovery result that was refused: the next attempt
      // (after the server's 401 says where its metadata lives) starts clean.
      await this.#storage.delete(this.#key('discovery'))
      throw err
    }

    let idToken: string
    try {
      idToken = await this.#opts.getIdToken()
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

    const { idp } = this.#opts
    // Signed for the IdP and for nothing else - its issuer or, when configured
    // so, its token endpoint, both from configuration: it is no use at the
    // authorization server, whose assertion is made separately.
    const clientAssertion =
      idp.clientAuthMethod === 'private_key_jwt'
        ? await createClientAssertion({
            clientId: idp.clientId,
            audience:
              idp.assertionAudience === 'token-endpoint'
                ? idp.tokenEndpoint
                : (idp.issuer as string),
            privateKey: idp.privateKey as EnterprisePrivateKey,
            algorithm: idp.algorithm as EnterpriseAssertionAlgorithm,
            keyId: idp.keyId,
            type: idp.assertionType,
          }).catch((err: Error) => {
            throw new EnterpriseOAuthError('idp', err.message)
          })
        : undefined
    const assertion = await requestIdJag({
      idp,
      idToken,
      audience: target.audience,
      resource: target.resource,
      scope: scope ?? this.#opts.scope,
      clientAssertion,
      fetch: this.#opts.fetch,
    })
    this.#pendingAssertion = assertion
    return new URLSearchParams({ grant_type: GRANT_JWT_BEARER, assertion })
  }

  /** The client authentication of the grant, when `clientAuthMethod` says how. */
  async #authenticateClient(headers: Headers, params: URLSearchParams): Promise<void> {
    const { clientId, clientSecret, clientAuthMethod } = this.#opts
    if (clientAuthMethod === 'private_key_jwt') {
      // The audience is the issuer discovery found, or the token endpoint of
      // that same metadata - either one only after the metadata was checked
      // against `expectedIssuer`, which this method requires.
      const target = enterpriseGrantTarget(
        this.serverUrl,
        await this.discoveryState(),
        this.#opts.expectedIssuer,
      )
      const audience =
        this.#opts.assertionAudience === 'token-endpoint' ? target.tokenEndpoint : target.audience
      if (audience === undefined) {
        this.#pendingAssertion = undefined
        throw new EnterpriseOAuthError(
          'discovery',
          `Enterprise MCP authorization: the authorization server "${target.audience}" published no token endpoint, so there is no audience for the client assertion (assertionAudience 'token-endpoint')`,
        )
      }
      const assertion = await createClientAssertion({
        clientId,
        audience,
        privateKey: this.#opts.privateKey as EnterprisePrivateKey,
        algorithm: this.#opts.algorithm as EnterpriseAssertionAlgorithm,
        keyId: this.#opts.keyId,
        type: this.#opts.assertionType,
      }).catch((err: Error) => {
        this.#pendingAssertion = undefined
        throw new EnterpriseOAuthError('authorization-server', err.message)
      })
      this.#pendingClientAssertion = assertion
      params.set('client_assertion_type', CLIENT_ASSERTION_TYPE)
      params.set('client_assertion', assertion)
      return
    }
    if (clientAuthMethod === 'client_secret_basic') {
      headers.set(
        'Authorization',
        `Basic ${btoa(`${formEncode(clientId)}:${formEncode(clientSecret as string)}`)}`,
      )
      return
    }
    params.set('client_id', clientId)
    if (clientAuthMethod === 'client_secret_post') {
      params.set('client_secret', clientSecret as string)
    }
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
    await Promise.all(targets.map((t) => this.#storage.delete(this.#key(t))))
  }

  /** True when there is no access token, or it expires within the skew window. */
  async isAccessTokenExpired(): Promise<boolean> {
    const stored = await this.#readJSON<StoredTokens>('tokens')
    if (!stored?.tokens?.access_token) {
      return true
    }
    if (stored.expiresAt === undefined) {
      return false
    }
    return Date.now() + this.#skewMs >= stored.expiresAt
  }

  async isAuthorized(): Promise<boolean> {
    return (await this.tokens()) !== undefined
  }

  /**
   * The fetch to give the transport that carries this provider (the connector
   * does). It changes one thing: when the request that carries the ID-JAG is
   * refused, the caller gets an `EnterpriseOAuthError` (`hop:
   * 'authorization-server'`) with a short message - the OAuth error code and
   * the status - and what the server said in full goes to `log`, redacted.
   * That holds whenever the SDK asks for a token, at connect or in the middle
   * of a session, so an application never has the server's raw words to show.
   * A refusal is final: every grant is already a fresh one, so the SDK's
   * "drop the token and try again" would only repeat the IdP exchange.
   */
  transportFetch(base?: FetchLike, log?: EnterpriseOAuthLog): FetchLike {
    const inner: FetchLike = base ?? ((url, init) => fetch(url, init))
    return async (url, init) => {
      const grant = this.#pendingAssertion
      if (grant === undefined || formParam(init?.body, 'assertion') !== grant) {
        return inner(url, init)
      }
      let response: Response
      try {
        response = await inner(url, init)
      } catch (err) {
        this.#report(log, `the grant request did not complete: ${(err as Error)?.message ?? err}`)
        this.#pendingAssertion = undefined
        this.#pendingClientAssertion = undefined
        throw new EnterpriseOAuthError(
          'authorization-server',
          'MCP authorization server could not be reached for the ID-JAG grant',
        )
      }
      if (response.status < 400) {
        return response
      }
      const text = await response.text().catch(() => '')
      let body: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>
        }
      } catch {
        // Not JSON: the status is all there is.
      }
      const code = oauthCode(body.error)
      const description = typeof body.error_description === 'string' ? body.error_description : text
      this.#report(
        log,
        `the authorization server refused the ID-JAG grant with ${response.status}${
          code ? ` ${code}` : ''
        }${description ? `: ${description}` : ''}`,
      )
      this.#pendingAssertion = undefined
      this.#pendingClientAssertion = undefined
      throw new EnterpriseOAuthError(
        'authorization-server',
        `MCP authorization server refused the ID-JAG grant: ${code ?? 'no error code'} (HTTP ${response.status})`,
        code,
      )
    }
  }

  /**
   * Run the whole flow now (discovery, IdP exchange, grant) and store the
   * access token. `connectMcpHttp` calls it before connecting when there is
   * no usable token; call it yourself to fail early. A refusal is an
   * `EnterpriseOAuthError` whose `hop` says who refused.
   */
  async authorize(opts: { fetch?: FetchLike; onLog?: EnterpriseOAuthLog } = {}): Promise<void> {
    try {
      await auth(this, {
        serverUrl: this.serverUrl,
        fetchFn: this.transportFetch(opts.fetch, opts.onLog),
      })
    } catch (err) {
      if (err instanceof EnterpriseOAuthError) {
        throw err
      }
      const detail = (err as Error)?.message ?? String(err)
      if (this.#pendingAssertion !== undefined) {
        // The server answered the grant with something that is not a token.
        this.#report(opts.onLog, `the answer to the ID-JAG grant could not be used: ${detail}`)
        this.#pendingAssertion = undefined
        this.#pendingClientAssertion = undefined
        throw new EnterpriseOAuthError(
          'authorization-server',
          'MCP authorization server answered the ID-JAG grant with something that is not a token response',
        )
      }
      // What discovery found is not kept when the flow stopped on it.
      await this.#storage.delete(this.#key('discovery')).catch(() => {})
      const message = printable(redact(detail, this.#secrets()), 500) ?? 'no reason given'
      throw new EnterpriseOAuthError(
        'discovery',
        `Enterprise MCP authorization: discovery failed (${message})`,
        oauthCode((err as { errorCode?: unknown })?.errorCode),
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
  opts: EnterpriseOAuthProviderOptions,
): BrowserEnterpriseOAuthProvider => new BrowserEnterpriseOAuthProvider(opts)
