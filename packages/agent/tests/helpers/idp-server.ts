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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A test enterprise identity provider, on loopback, over real sockets.
 *
 * It does what the ID-JAG draft (draft-ietf-oauth-identity-assertion-authz-grant)
 * asks of an IdP authorization server: issues signed ID tokens for a test user,
 * serves its keys as a JWKS, and answers the RFC 8693 token exchange with a
 * signed ID-JAG after authenticating the client and validating the subject
 * token. It can be told to misbehave, one way at a time, for the negative tests.
 *
 * Keys are generated per run (ES256); nothing here is a secret worth keeping.
 */

export const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
export const ID_TOKEN_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
export const ID_JAG_TYP = 'oauth-id-jag+jwt'

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

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/**
 * Verify a `private_key_jwt` client assertion as RFC 7523 section 3 and
 * draft-ietf-oauth-rfc7523bis ask: signed by a registered key, `iss` = `sub`,
 * the server's issuer identifier as the SOLE audience (a token endpoint URL is
 * not one), unexpired and not long-lived, and a `jti` not seen before.
 * Returns the client id, or the reason it was refused.
 */
export const verifyClientAssertion = (
  assertion: string,
  opts: { jwks: { keys: JsonWebKey[] }; audience: string; seenJti: Set<string> },
): { clientId: string } | { refused: string } => {
  const verified = verifyJwt(assertion, opts.jwks)
  if (!verified) {
    return { refused: 'Client assertion signature validation failed' }
  }
  const { payload } = verified
  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.iss !== 'string' || !payload.iss || payload.iss !== payload.sub) {
    return { refused: 'Client assertion iss and sub must both be the client' }
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (aud.length !== 1 || aud[0] !== opts.audience) {
    return { refused: 'Client assertion audience is not this server' }
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

/** A client key pair for `private_key_jwt`, in every form the providers take. */
export const generateClientKey = (
  kind: 'ES256' | 'ES384' | 'ES512' | 'RSA',
  kid = `client-${randomUUID().slice(0, 8)}`,
): { kid: string; privateJwk: JsonWebKey; privatePem: string; publicJwk: JsonWebKey } => {
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

/** Ways the IdP can be told to go wrong. One field at a time is the useful way. */
export interface IIdpMisbehaviour {
  /** Answer the exchange with this `issued_token_type` instead of the ID-JAG type. */
  issuedTokenType?: string
  /** Leave `access_token` out of the answer. */
  omitToken?: boolean
  /** Put this `aud` in the ID-JAG, whatever audience was asked for. */
  audience?: string
  /** Issue an ID-JAG that expired a minute ago. */
  expired?: boolean
  /** Refuse the client's credentials (401 invalid_client). */
  rejectClient?: boolean
  /** Refuse by policy (400 access_denied) with this description. */
  deny?: string
  /** Answer 307 to this URL instead of handling the exchange. */
  redirectTo?: string
  /** Echo the whole request body back in `error_description` (a careless server). */
  echoRequest?: boolean
}

export interface ILocalIdpOptions {
  /** The client as registered at the IdP. */
  clientId: string
  /** Its secret, for a client that authenticates with one. */
  clientSecret?: string
  /** Its public keys, for a client that authenticates with `private_key_jwt`. */
  clientJwks?: { keys: JsonWebKey[] }
  /**
   * The same client's identifier at the resource authorization server: what
   * goes in the ID-JAG's `client_id` claim (draft section 5).
   */
  resourceClientId: string
  /** Seconds an ID-JAG lives. Default 300. */
  idJagExpiresIn?: number
}

/** One token-exchange request as the IdP received it. */
export interface IIdpExchange {
  params: Record<string, string>
  authMethod: 'basic' | 'post' | 'none' | 'assertion'
  /** What was answered. */
  status: number
}

export interface ILocalIdp {
  issuer: string
  tokenEndpoint: string
  jwksUri: string
  /** A signed ID token for a test user, addressed to the client. */
  issueIdToken: (claims?: { sub?: string; email?: string; expiresIn?: number }) => string
  /** Every token-exchange request, in order. */
  exchanges: IIdpExchange[]
  /** Every ID-JAG issued, in order. */
  issuedIdJags: string[]
  /** Mutable: set a field to make the next exchanges go wrong. */
  misbehave: IIdpMisbehaviour
  close: () => Promise<void>
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString()
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

export const startLocalIdp = async (opts: ILocalIdpOptions): Promise<ILocalIdp> => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const kid = `idp-${randomUUID().slice(0, 8)}`
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' }] }
  const exchanges: IIdpExchange[] = []
  const issuedIdJags: string[] = []
  const misbehave: IIdpMisbehaviour = {}
  const seenClientJti = new Set<string>()
  const now = (): number => Math.floor(Date.now() / 1000)

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      if (url.pathname === '/.well-known/jwks.json') {
        json(res, 200, jwks)
        return
      }
      if (url.pathname === '/.well-known/openid-configuration') {
        json(res, 200, {
          issuer,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          grant_types_supported: [TOKEN_EXCHANGE_GRANT],
          identity_chaining_requested_token_types_supported: [ID_JAG_TOKEN_TYPE],
        })
        return
      }
      if (url.pathname !== '/token' || req.method !== 'POST') {
        json(res, 404, { error: 'not_found' })
        return
      }

      const raw = await readBody(req)
      const params = new URLSearchParams(raw)
      const client = readClientAuth(req, params)
      const record: IIdpExchange = {
        params: Object.fromEntries(params),
        authMethod: client.method,
        status: 0,
      }
      exchanges.push(record)
      const answer = (status: number, body: unknown, headers?: Record<string, string>): void => {
        record.status = status
        if (headers) {
          res.writeHead(status, headers)
          res.end()
          return
        }
        json(res, status, body)
      }

      if (misbehave.redirectTo) {
        answer(307, undefined, { location: misbehave.redirectTo })
        return
      }
      if (misbehave.echoRequest) {
        answer(400, { error: 'invalid_request', error_description: `bad request: ${raw}` })
        return
      }
      let authenticated = false
      let refusal = 'Client authentication failed'
      if (client.method === 'assertion') {
        // private_key_jwt: the assertion must be for THIS issuer.
        const checked =
          opts.clientJwks && params.get('client_assertion_type') === CLIENT_ASSERTION_TYPE
            ? verifyClientAssertion(params.get('client_assertion') ?? '', {
                jwks: opts.clientJwks,
                audience: issuer,
                seenJti: seenClientJti,
              })
            : { refused: 'Client assertions are not accepted for this client' }
        if ('refused' in checked) {
          refusal = checked.refused
        } else {
          authenticated = checked.clientId === opts.clientId
        }
      } else {
        authenticated =
          opts.clientSecret !== undefined &&
          client.clientId === opts.clientId &&
          client.clientSecret === opts.clientSecret
      }
      if (misbehave.rejectClient || !authenticated) {
        answer(401, { error: 'invalid_client', error_description: refusal })
        return
      }
      if (
        params.get('grant_type') !== TOKEN_EXCHANGE_GRANT ||
        params.get('requested_token_type') !== ID_JAG_TOKEN_TYPE ||
        params.get('subject_token_type') !== ID_TOKEN_TOKEN_TYPE
      ) {
        answer(400, { error: 'invalid_request', error_description: 'Not an ID-JAG exchange' })
        return
      }
      const audience = params.get('audience')
      if (!audience || params.getAll('audience').length !== 1) {
        answer(400, { error: 'invalid_target', error_description: 'Exactly one audience' })
        return
      }
      // Section 4.3.3: the subject token must be ours, unexpired, and issued to
      // the client that is authenticating.
      const subject = verifyJwt(params.get('subject_token') ?? '', jwks)
      if (
        !subject ||
        subject.payload.iss !== issuer ||
        subject.payload.aud !== opts.clientId ||
        typeof subject.payload.exp !== 'number' ||
        subject.payload.exp <= now()
      ) {
        answer(400, { error: 'invalid_grant', error_description: 'Subject token is not valid' })
        return
      }
      if (misbehave.deny) {
        answer(400, { error: 'access_denied', error_description: misbehave.deny })
        return
      }

      const iat = now()
      const lifetime = opts.idJagExpiresIn ?? 300
      const resource = params.get('resource')
      const scope = params.get('scope')
      const idJag = signJwt(
        privateKey,
        { typ: ID_JAG_TYP, kid },
        {
          jti: randomUUID(),
          iss: issuer,
          sub: subject.payload.sub,
          ...(subject.payload.email ? { email: subject.payload.email } : {}),
          aud: misbehave.audience ?? audience,
          client_id: opts.resourceClientId,
          iat: misbehave.expired ? iat - 600 : iat,
          exp: misbehave.expired ? iat - 60 : iat + lifetime,
          ...(resource ? { resource } : {}),
          ...(scope ? { scope } : {}),
        },
      )
      issuedIdJags.push(idJag)
      answer(200, {
        issued_token_type: misbehave.issuedTokenType ?? ID_JAG_TOKEN_TYPE,
        ...(misbehave.omitToken ? {} : { access_token: idJag }),
        token_type: 'N_A',
        ...(scope ? { scope } : {}),
        expires_in: lifetime,
      })
    })().catch(() => {
      if (!res.headersSent) {
        json(res, 500, { error: 'server_error' })
      }
    })
  })
  const port = await listen(server)
  const issuer = `http://127.0.0.1:${port}`

  return {
    issuer,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    issueIdToken: (claims = {}) => {
      const iat = now()
      return signJwt(
        privateKey,
        { typ: 'JWT', kid },
        {
          iss: issuer,
          sub: claims.sub ?? 'U019488227',
          email: claims.email ?? 'user@example.test',
          aud: opts.clientId,
          iat,
          exp: iat + (claims.expiresIn ?? 3600),
        },
      )
    },
    exchanges,
    issuedIdJags,
    misbehave,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
