import { generateKeyPairSync, randomUUID, type JsonWebKey } from 'node:crypto'
import { createServer } from 'node:http'
import { applyCors, closeServer, json, listen, readBody, type IListenOptions } from './http.ts'
import {
  CLIENT_ASSERTION_TYPE,
  ID_JAG_TOKEN_TYPE,
  ID_JAG_TYP,
  ID_TOKEN_TOKEN_TYPE,
  readClientAuth,
  signJwt,
  TOKEN_EXCHANGE_GRANT,
  verifyClientAssertion,
  verifyJwt,
  type ClientAssertionProfile,
} from './jwt.ts'

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

export interface ILocalIdpOptions extends IListenOptions {
  /** The client as registered at the IdP. */
  clientId: string
  /** Its secret, for a client that authenticates with one. */
  clientSecret?: string
  /** Its public keys, for a client that authenticates with `private_key_jwt`. */
  clientJwks?: { keys: JsonWebKey[] }
  /**
   * What a `private_key_jwt` client assertion must look like: `'rfc7523bis'`
   * (the default: `aud` = this issuer, `typ: client-authentication+jwt`) or
   * `'rfc7523'` (`aud` = this token endpoint, `typ: JWT` or none). Each refuses
   * the other's form.
   */
  assertionProfile?: ClientAssertionProfile
  /**
   * The same client's identifier at the resource authorization server: what
   * goes in the ID-JAG's `client_id` claim (draft section 5).
   */
  resourceClientId: string
  /** Seconds an ID-JAG lives. Default 300. */
  idJagExpiresIn?: number
  /**
   * Serve `GET /test/id-token`: a fresh ID token for the test user, to anyone
   * who asks. A stand-in for the single sign-on a harness in another process
   * (a browser) cannot perform. Off unless asked for; the CLI asks for it.
   */
  idTokenEndpoint?: boolean
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
  /** Where a fresh ID token can be fetched, when `idTokenEndpoint` is on. */
  idTokenEndpoint?: string
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

export const startLocalIdp = async (opts: ILocalIdpOptions): Promise<ILocalIdp> => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const kid = `idp-${randomUUID().slice(0, 8)}`
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' }] }
  const exchanges: IIdpExchange[] = []
  const issuedIdJags: string[] = []
  const misbehave: IIdpMisbehaviour = {}
  const seenClientJti = new Set<string>()
  const now = (): number => Math.floor(Date.now() / 1000)

  const issueIdToken: ILocalIdp['issueIdToken'] = (claims = {}) => {
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
  }

  const server = createServer((req, res) => {
    void (async () => {
      if (applyCors(req, res, opts.cors)) {
        return
      }
      const noStore = { 'cache-control': 'no-store' }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      if (url.pathname === '/.well-known/jwks.json') {
        json(res, 200, jwks, noStore)
        return
      }
      if (url.pathname === '/.well-known/openid-configuration') {
        json(
          res,
          200,
          {
            issuer,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/.well-known/jwks.json`,
            grant_types_supported: [TOKEN_EXCHANGE_GRANT],
            identity_chaining_requested_token_types_supported: [ID_JAG_TOKEN_TYPE],
          },
          noStore,
        )
        return
      }
      if (opts.idTokenEndpoint && url.pathname === '/test/id-token' && req.method === 'GET') {
        json(res, 200, { id_token: issueIdToken() }, noStore)
        return
      }
      if (url.pathname !== '/token' || req.method !== 'POST') {
        json(res, 404, { error: 'not_found' }, noStore)
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
        json(res, status, body, noStore)
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
        // private_key_jwt: the assertion must be for THIS server, in the form
        // the profile asks for.
        const checked =
          opts.clientJwks && params.get('client_assertion_type') === CLIENT_ASSERTION_TYPE
            ? verifyClientAssertion(params.get('client_assertion') ?? '', {
                jwks: opts.clientJwks,
                issuer,
                tokenEndpoint: `${issuer}/token`,
                profile: opts.assertionProfile,
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
  const issuer = await listen(server, opts)

  return {
    issuer,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    ...(opts.idTokenEndpoint ? { idTokenEndpoint: `${issuer}/test/id-token` } : {}),
    issueIdToken,
    exchanges,
    issuedIdJags,
    misbehave,
    close: () => closeServer(server),
  }
}
