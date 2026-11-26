import {
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

/**
 * Verify a compact ES256 JWT against a JWKS (by `kid`). Returns undefined for
 * anything that is not a well-formed token signed by one of the keys - the
 * caller checks the claims.
 */
export const verifyJwt = (jwt: string, jwks: { keys: JsonWebKey[] }): IVerifiedJwt | undefined => {
  const parts = jwt.split('.')
  if (parts.length !== 3) {
    return undefined
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as Record<
      string,
      unknown
    >
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<
      string,
      unknown
    >
    if (header.alg !== 'ES256') {
      return undefined
    }
    const jwk = jwks.keys.find((k) => (k as { kid?: string }).kid === header.kid)
    if (!jwk) {
      return undefined
    }
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url'),
    )
    return ok ? { header, payload } : undefined
  } catch {
    return undefined
  }
}

/** `client_id` / `client_secret` from a Basic header or the form body. */
export const readClientAuth = (
  req: IncomingMessage,
  params: URLSearchParams,
): { clientId?: string; clientSecret?: string; method: 'basic' | 'post' | 'none' } => {
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
  clientSecret: string
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
  authMethod: 'basic' | 'post' | 'none'
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
      if (
        misbehave.rejectClient ||
        client.clientId !== opts.clientId ||
        client.clientSecret !== opts.clientSecret
      ) {
        answer(401, { error: 'invalid_client', error_description: 'Client authentication failed' })
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
