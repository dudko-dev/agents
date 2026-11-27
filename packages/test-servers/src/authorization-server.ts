import type { JsonWebKey } from 'node:crypto'
import { createServer } from 'node:http'
import { applyCors, closeServer, json, listen, readBody, type IListenOptions } from './http.ts'
import {
  CLIENT_ASSERTION_TYPE,
  ID_JAG_TYP,
  JWT_BEARER_GRANT,
  peekJwt,
  readClientAuth,
  verifyClientAssertion,
  verifyJwt,
  type ClientAssertionProfile,
} from './jwt.ts'

/**
 * A test OAuth authorization server for an MCP server, on loopback, over real
 * sockets. Two personalities:
 *
 * - by default, the endpoints the interactive flow needs (metadata, dynamic
 *   client registration, a token endpoint that rotates the access token). There
 *   is no `/authorize` page: a test plays the redirect itself;
 * - with `enterprise`, only the `jwt-bearer` grant with an ID-JAG from one
 *   identity provider, verified the way the ID-JAG draft asks.
 */

/** Enterprise-managed authorization: who may be granted a token, and how they authenticate. */
export interface IEnterpriseGrantOptions {
  /** The `iss` an ID-JAG must carry. */
  idpIssuer: string
  /** Where the IdP's signing keys are fetched from, on every grant. */
  jwksUri: string
  clientId: string
  /**
   * Omit to run a PUBLIC client for this grant: it is identified by `client_id`
   * alone. Draft -04 only discourages that; draft -06 (section 4.4) requires a
   * sender-constrained ID-JAG then, which this server does not implement.
   */
  clientSecret?: string
  /** The client's public keys, for `private_key_jwt`. */
  clientJwks?: { keys: JsonWebKey[] }
  /**
   * What a `private_key_jwt` client assertion must look like: `'rfc7523bis'`
   * (the default: `aud` = this issuer, `typ: client-authentication+jwt`) or
   * `'rfc7523'` (`aud` = this token endpoint, `typ: JWT` or none). Each refuses
   * the other's form.
   */
  assertionProfile?: ClientAssertionProfile
  /**
   * Accept a client whose `client_id` is the https URL of a client ID
   * metadata document: fetch the document (through `resolve`, which stands in
   * for DNS and TLS and maps the https URL to the test server that hosts it),
   * require `private_key_jwt`, and verify the assertion against the document's
   * `jwks` or `jwks_uri`.
   */
  cimd?: { resolve: (url: string) => string }
  /** Refuse every grant, quoting the request in the error (a careless server). */
  echoAssertion?: boolean
}

export interface ILocalAuthorizationServerOptions extends IListenOptions {
  /** Seconds until an issued access token expires. Default 3600. */
  expiresIn?: number
  /** Advertise `client_id_metadata_document_supported` (CIMD). */
  clientIdMetadataDocument?: boolean
  /**
   * Advertise `authorization_response_iss_parameter_supported` (RFC 9207). There
   * is no browser in these tests, so nothing redirects: a test plays the
   * redirect by passing `issuer` (or a wrong value) as the callback's `iss`.
   */
  issParameter?: boolean
  /**
   * Accept the `jwt-bearer` grant with an ID-JAG (enterprise-managed
   * authorization) from this identity provider, for this pre-registered
   * client. Every other grant is then refused: there is no interactive way in.
   */
  enterprise?: IEnterpriseGrantOptions
  /**
   * The MCP resource this server governs: an ID-JAG that names another
   * `resource` is refused. Also settable afterwards (`server.resource = ...`),
   * for the usual order of starting the authorization server first.
   */
  resource?: string
}

/** One request the token endpoint received. */
export interface ITokenRequest {
  /** Its form parameters. */
  params: Record<string, string>
  /** How the client authenticated: `basic`, `post`, `none` or `assertion`. */
  authMethod: string
  /** The OAuth error it was answered with, if any. */
  error?: string
}

export interface ILocalAuthorizationServer {
  /** The issuer identifier: what an honest redirect carries as `iss`. */
  issuer: string
  tokenEndpoint: string
  /** Mutable: the MCP resource this server governs (see the option). */
  resource: string | undefined
  /** Tokens the authorization server currently accepts. Hand it to the MCP server. */
  validTokens: Set<string>
  /** Dynamic client registrations performed so far. */
  registrations: () => number
  /** grant_type values seen at the token endpoint, in order. */
  grants: () => string[]
  /** client_id values seen at the token endpoint, in order. */
  tokenClientIds: () => string[]
  /** Every request the token endpoint received. */
  tokenRequests: () => ITokenRequest[]
  /**
   * Mutable: make the token endpoint go wrong from now on (enterprise mode).
   * `refuseGrant` answers every grant with that OAuth error; `echoRequest`
   * refuses and quotes the whole request body in the description (a careless
   * server).
   */
  faults: { refuseGrant?: { error: string; description: string }; echoRequest?: boolean }
  /** Every client ID metadata document URL the authorization server fetched. */
  cimdFetches: string[]
  /**
   * Mutable: what the metadata advertises from now on (starts from the options),
   * for a server that changes its mind between two attempts.
   */
  advertised: { clientIdMetadataDocument: boolean }
  close: () => Promise<void>
}

export const startLocalAuthorizationServer = async (
  opts: ILocalAuthorizationServerOptions = {},
): Promise<ILocalAuthorizationServer> => {
  const validTokens = new Set<string>()
  const grants: string[] = []
  const tokenClientIds: string[] = []
  const tokenRequests: ITokenRequest[] = []
  const seenJti = new Set<string>()
  const seenClientJti = new Set<string>()
  const cimdFetches: string[] = []
  const faults: ILocalAuthorizationServer['faults'] = {
    echoRequest: opts.enterprise?.echoAssertion,
  }
  let registrations = 0
  let issued = 0
  const advertised = { clientIdMetadataDocument: opts.clientIdMetadataDocument === true }

  const server = createServer((req, res) => {
    void (async () => {
      if (applyCors(req, res, opts.cors)) {
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      if (url.pathname.includes('/.well-known/oauth-authorization-server')) {
        json(res, 200, {
          issuer: asUrl,
          authorization_endpoint: `${asUrl}/authorize`,
          token_endpoint: `${asUrl}/token`,
          registration_endpoint: `${asUrl}/register`,
          response_types_supported: ['code'],
          grant_types_supported: opts.enterprise
            ? [JWT_BEARER_GRANT]
            : ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: [
            ...(opts.enterprise?.clientSecret ? ['client_secret_basic', 'client_secret_post'] : []),
            ...(opts.enterprise?.clientJwks || opts.enterprise?.cimd ? ['private_key_jwt'] : []),
            ...(opts.enterprise?.clientSecret || opts.enterprise?.clientJwks ? [] : ['none']),
          ],
          ...(opts.enterprise?.cimd ? { client_id_metadata_document_supported: true } : {}),
          ...(opts.enterprise
            ? {
                authorization_grant_profiles_supported: [
                  'urn:ietf:params:oauth:grant-profile:id-jag',
                ],
              }
            : {}),
          ...(advertised.clientIdMetadataDocument
            ? { client_id_metadata_document_supported: true }
            : {}),
          ...(opts.issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
        })
        return
      }
      if (url.pathname === '/register') {
        registrations += 1
        const metadata = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        json(res, 201, { ...metadata, client_id: `dcr-${registrations}`, client_id_issued_at: 1 })
        return
      }
      if (url.pathname === '/token') {
        const rawBody = await readBody(req)
        const params = new URLSearchParams(rawBody)
        const grant = params.get('grant_type') ?? ''
        grants.push(grant)
        tokenClientIds.push(params.get('client_id') ?? '')
        const client = readClientAuth(req, params)
        const record: ITokenRequest = {
          params: Object.fromEntries(params),
          authMethod: client.method,
        }
        tokenRequests.push(record)
        if (opts.enterprise) {
          // Section 4.4.1 of the ID-JAG draft, in order: the client, the grant,
          // then the assertion - signature, typ, iss, aud, exp, client_id, jti.
          const ent = opts.enterprise
          const refuse = (status: number, error: string, description: string): void => {
            record.error = `${error}: ${description}`
            json(res, status, { error, error_description: description })
          }
          if (faults.echoRequest) {
            refuse(400, 'invalid_request', `cannot accept ${rawBody}`)
            return
          }
          if (faults.refuseGrant) {
            refuse(400, faults.refuseGrant.error, faults.refuseGrant.description)
            return
          }
          // Who is asking: a signed assertion, a secret, or (public) a bare id.
          let clientId: string | undefined
          let clientRefusal = 'Client authentication failed'
          if (client.method === 'assertion') {
            const assertion = params.get('client_assertion') ?? ''
            let jwks = ent.clientJwks
            let claimed: unknown
            try {
              claimed = peekJwt(assertion).payload.iss
            } catch {
              claimed = undefined
            }
            if (ent.cimd && typeof claimed === 'string' && claimed.startsWith('https://')) {
              // CIMD: the client id is a URL; what is served there says how the
              // client authenticates and with which keys.
              jwks = undefined
              try {
                cimdFetches.push(claimed)
                const doc = (await (await fetch(ent.cimd.resolve(claimed))).json()) as {
                  client_id?: string
                  token_endpoint_auth_method?: string
                  jwks?: { keys: JsonWebKey[] }
                  jwks_uri?: string
                }
                if (doc.client_id !== claimed) {
                  clientRefusal = 'Client metadata document names another client'
                } else if (doc.token_endpoint_auth_method !== 'private_key_jwt') {
                  clientRefusal = 'Client metadata document does not allow private_key_jwt'
                } else if (doc.jwks) {
                  jwks = doc.jwks
                } else if (doc.jwks_uri) {
                  jwks = (await (await fetch(ent.cimd.resolve(doc.jwks_uri))).json()) as {
                    keys: JsonWebKey[]
                  }
                }
              } catch {
                clientRefusal = 'Client metadata document could not be fetched'
              }
            } else if (claimed !== ent.clientId) {
              jwks = undefined
            }
            const checked =
              jwks && params.get('client_assertion_type') === CLIENT_ASSERTION_TYPE
                ? verifyClientAssertion(assertion, {
                    jwks,
                    issuer: asUrl,
                    tokenEndpoint: `${asUrl}/token`,
                    profile: ent.assertionProfile,
                    seenJti: seenClientJti,
                  })
                : { refused: clientRefusal }
            if ('refused' in checked) {
              clientRefusal = checked.refused
            } else {
              clientId = checked.clientId
            }
          } else if (
            !ent.clientJwks &&
            client.clientId === ent.clientId &&
            client.clientSecret === ent.clientSecret
          ) {
            clientId = client.clientId
          }
          if (!clientId) {
            refuse(401, 'invalid_client', clientRefusal)
            return
          }
          if (grant !== JWT_BEARER_GRANT) {
            refuse(400, 'unsupported_grant_type', 'Only the jwt-bearer grant is accepted')
            return
          }
          const jwks = (await (await fetch(ent.jwksUri)).json()) as { keys: never[] }
          const jag = verifyJwt(params.get('assertion') ?? '', jwks)
          if (!jag) {
            refuse(400, 'invalid_grant', 'Signature validation failed')
            return
          }
          const { header, payload } = jag
          if (header.typ !== ID_JAG_TYP) {
            refuse(400, 'invalid_grant', 'Not an ID-JAG')
            return
          }
          if (payload.iss !== ent.idpIssuer) {
            refuse(400, 'invalid_grant', 'Issuer is not trusted')
            return
          }
          const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
          if (aud.length !== 1 || aud[0] !== asUrl) {
            refuse(400, 'invalid_grant', 'Audience validation failed')
            return
          }
          if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
            refuse(400, 'invalid_grant', 'Assertion has expired')
            return
          }
          if (payload.client_id !== clientId) {
            refuse(400, 'invalid_grant', 'Assertion was issued to another client')
            return
          }
          if (typeof payload.sub !== 'string' || !payload.sub) {
            refuse(400, 'invalid_grant', 'Assertion names no subject')
            return
          }
          if (typeof payload.jti !== 'string' || seenJti.has(payload.jti)) {
            refuse(400, 'invalid_grant', 'Assertion was already used')
            return
          }
          if (
            payload.resource !== undefined &&
            handle.resource !== undefined &&
            payload.resource !== handle.resource
          ) {
            refuse(400, 'invalid_target', 'This authorization server does not govern that resource')
            return
          }
          seenJti.add(payload.jti)
          issued += 1
          const access = `access-${issued}`
          validTokens.clear()
          validTokens.add(access)
          // Section 4.4.4: no refresh token - the ID-JAG replaces it.
          json(res, 200, {
            access_token: access,
            token_type: 'Bearer',
            expires_in: opts.expiresIn ?? 3600,
            ...(typeof payload.scope === 'string' ? { scope: payload.scope } : {}),
          })
          return
        }
        if (grant === 'authorization_code' && !params.get('code_verifier')) {
          json(res, 400, { error: 'invalid_request' })
          return
        }
        issued += 1
        const access = `access-${issued}`
        // Rotation: only the newest token works, like a real short-lived one.
        validTokens.clear()
        validTokens.add(access)
        json(res, 200, {
          access_token: access,
          token_type: 'Bearer',
          expires_in: opts.expiresIn ?? 3600,
          refresh_token: `refresh-${issued}`,
        })
        return
      }
      json(res, 404, { error: 'not_found' })
    })().catch(() => {
      if (!res.headersSent) {
        json(res, 500, { error: 'server_error' })
      }
    })
  })
  const asUrl = await listen(server, opts)

  const handle: ILocalAuthorizationServer = {
    issuer: asUrl,
    tokenEndpoint: `${asUrl}/token`,
    resource: opts.resource,
    validTokens,
    registrations: () => registrations,
    grants: () => grants,
    tokenClientIds: () => tokenClientIds,
    tokenRequests: () => tokenRequests,
    faults,
    cimdFetches,
    advertised,
    close: () => closeServer(server),
  }
  return handle
}
