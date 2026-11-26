import {
  constants as cryptoConstants,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * The JWT and client-authentication pieces the test identity provider and the
 * test authorization server share. Verification here is `node:crypto`, on
 * purpose a different implementation from the browser provider's WebCrypto.
 */

export const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
export const ID_TOKEN_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
export const ID_JAG_TYP = 'oauth-id-jag+jwt'
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
/** The `typ` draft-ietf-oauth-rfc7523bis gives a client assertion. */
export const CLIENT_AUTHENTICATION_TYP = 'client-authentication+jwt'

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url')

/** Sign a compact ES256 JWT. */
export const signJwt = (
  key: KeyObject,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string => {
  const signingInput = `${b64url(JSON.stringify({ alg: 'ES256', ...header }))}.${b64url(
    JSON.stringify(payload),
  )}`
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${b64url(signature)}`
}

export interface IVerifiedJwt {
  header: Record<string, unknown>
  payload: Record<string, unknown>
}

const decodeJwt = (jwt: string): IVerifiedJwt | undefined => {
  const parts = jwt.split('.')
  if (parts.length !== 3) {
    return undefined
  }
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as Record<string, unknown>,
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>,
    }
  } catch {
    return undefined
  }
}

/** The claims of a JWT, NOT verified: for a test to look at what was sent. */
export const peekJwt = (jwt: string): IVerifiedJwt => {
  const decoded = decodeJwt(jwt)
  if (!decoded) {
    throw new Error('not a JWT')
  }
  return decoded
}

/**
 * Verify a compact JWT (ES256/384/512, RS256/384/512, PS256/384/512) against a
 * JWKS: by `kid` when the token names one, else against the only key. Returns
 * undefined for anything that is not a well-formed token signed by one of the
 * keys - the caller checks the claims.
 */
export const verifyJwt = (jwt: string, jwks: { keys: JsonWebKey[] }): IVerifiedJwt | undefined => {
  const decoded = decodeJwt(jwt)
  if (!decoded) {
    return undefined
  }
  const { header } = decoded
  const alg = typeof header.alg === 'string' ? header.alg : ''
  if (!/^(ES|RS|PS)(256|384|512)$/.test(alg)) {
    return undefined
  }
  const jwk =
    header.kid === undefined && jwks.keys.length === 1
      ? jwks.keys[0]
      : jwks.keys.find((k) => (k as { kid?: string }).kid === header.kid)
  if (!jwk) {
    return undefined
  }
  // A key is only good for its own family: an RSA key never verifies "ES256".
  if ((alg.startsWith('ES') ? 'EC' : 'RSA') !== jwk.kty) {
    return undefined
  }
  try {
    const parts = jwt.split('.')
    const key = createPublicKey({ key: jwk, format: 'jwk' })
    const ok = cryptoVerify(
      `sha${alg.slice(2)}`,
      Buffer.from(`${parts[0]}.${parts[1]}`),
      alg.startsWith('ES')
        ? { key, dsaEncoding: 'ieee-p1363' }
        : alg.startsWith('PS')
          ? {
              key,
              padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
              saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
            }
          : key,
      Buffer.from(parts[2], 'base64url'),
    )
    return ok ? decoded : undefined
  } catch {
    return undefined
  }
}

/**
 * Which specification a server holds a `private_key_jwt` client assertion to.
 * The two are exclusive on purpose, so a test can show a client setting working
 * against one and being refused by the other:
 *
 * - `'rfc7523bis'` (the default; draft-ietf-oauth-rfc7523bis): `aud` is the
 *   server's issuer identifier and nothing else, and the header `typ` is
 *   `client-authentication+jwt`;
 * - `'rfc7523'` (RFC 7523 as deployed): `aud` is the token endpoint URL (alone,
 *   or in a list), and a `typ` other than `JWT` is refused - a server written
 *   before the bis draft knows no other.
 */
export type ClientAssertionProfile = 'rfc7523bis' | 'rfc7523'

/**
 * Verify a `private_key_jwt` client assertion as RFC 7523 section 3 asks, with
 * the audience and `typ` rule of the chosen `profile`: signed by a registered
 * key, `iss` = `sub`, the right audience, unexpired and not long-lived, and a
 * `jti` not seen before. Returns the client id, or the reason it was refused.
 */
export const verifyClientAssertion = (
  assertion: string,
  opts: {
    jwks: { keys: JsonWebKey[] }
    /** The server's issuer identifier. */
    issuer: string
    /** The server's token endpoint URL. */
    tokenEndpoint: string
    profile?: ClientAssertionProfile
    seenJti: Set<string>
  },
): { clientId: string } | { refused: string } => {
  const verified = verifyJwt(assertion, opts.jwks)
  if (!verified) {
    return { refused: 'Client assertion signature validation failed' }
  }
  const { header, payload } = verified
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.iss !== 'string' || !payload.iss || payload.iss !== payload.sub) {
    return { refused: 'Client assertion iss and sub must both be the client' }
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (opts.profile === 'rfc7523') {
    if (header.typ !== undefined && header.typ !== 'JWT') {
      return { refused: 'Client assertion typ is not supported' }
    }
    if (!aud.includes(opts.tokenEndpoint)) {
      return { refused: 'Client assertion audience is not the token endpoint' }
    }
  } else {
    if (header.typ !== CLIENT_AUTHENTICATION_TYP) {
      return { refused: 'Client assertion typ is not client-authentication+jwt' }
    }
    if (aud.length !== 1 || aud[0] !== opts.issuer) {
      return { refused: 'Client assertion audience is not this server' }
    }
  }
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    return { refused: 'Client assertion has expired' }
  }
  if (payload.exp - now > 300) {
    return { refused: 'Client assertion lives too long' }
  }
  if (typeof payload.jti !== 'string' || !payload.jti || opts.seenJti.has(payload.jti)) {
    return { refused: 'Client assertion was already used' }
  }
  opts.seenJti.add(payload.jti)
  return { clientId: payload.iss }
}

export interface IClientKey {
  kid: string
  privateJwk: JsonWebKey
  privatePem: string
  publicJwk: JsonWebKey
}

/** A client key pair for `private_key_jwt`, in every form the providers take. */
export const generateClientKey = (
  kind: 'ES256' | 'ES384' | 'ES512' | 'RSA',
  kid = `client-${randomUUID().slice(0, 8)}`,
): IClientKey => {
  const { privateKey, publicKey } =
    kind === 'RSA'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', {
          namedCurve: { ES256: 'P-256', ES384: 'P-384', ES512: 'P-521' }[kind],
        })
  return {
    kid,
    privateJwk: privateKey.export({ format: 'jwk' }),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicJwk: { ...publicKey.export({ format: 'jwk' }), kid } as JsonWebKey,
  }
}

/** `client_id` / `client_secret` from a Basic header or the form body. */
export const readClientAuth = (
  req: IncomingMessage,
  params: URLSearchParams,
): {
  clientId?: string
  clientSecret?: string
  method: 'basic' | 'post' | 'none' | 'assertion'
} => {
  if (params.get('client_assertion')) {
    return { method: 'assertion' }
  }
  const authorization = req.headers.authorization ?? ''
  if (/^Basic\s+/i.test(authorization)) {
    const decoded = Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString()
    const colon = decoded.indexOf(':')
    const form = (v: string): string => new URLSearchParams(`v=${v}`).get('v') ?? ''
    return {
      clientId: form(decoded.slice(0, colon)),
      clientSecret: form(decoded.slice(colon + 1)),
      method: 'basic',
    }
  }
  const clientId = params.get('client_id') ?? undefined
  const clientSecret = params.get('client_secret') ?? undefined
  return { clientId, clientSecret, method: clientSecret ? 'post' : 'none' }
}
