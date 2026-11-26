import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  generateClientKey,
  JWT_BEARER_GRANT,
  listen,
  closeServer,
  startLocalAuthorizationServer,
  startLocalIdp,
  type IEnterpriseGrantOptions,
  type ILocalAuthorizationServer,
  type ILocalIdp,
} from '../src/index.ts'
import {
  assertionParams,
  basic,
  clientAssertion,
  exchangeParams,
  getJson,
  grantParams,
  postForm,
} from './helpers.ts'

const AS_CLIENT = 'agent-at-as'
const AS_SECRET = 'as-secret-for-this-test'
const IDP_CLIENT = 'agent-at-idp'
const IDP_SECRET = 'idp-secret-for-this-test'
const RESOURCE = 'http://127.0.0.1:9/mcp'

// ── the interactive personality ───────────────────────────────────────────

test('authorization server: metadata, registration and a token endpoint that rotates', async () => {
  const as = await startLocalAuthorizationServer({ expiresIn: 120 })
  try {
    assert.match(as.issuer, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(as.tokenEndpoint, `${as.issuer}/token`)
    const meta = (await getJson(`${as.issuer}/.well-known/oauth-authorization-server`)).body
    assert.equal(meta.issuer, as.issuer)
    assert.equal(meta.token_endpoint, as.tokenEndpoint)
    assert.equal(meta.registration_endpoint, `${as.issuer}/register`)
    assert.deepEqual(meta.grant_types_supported, ['authorization_code', 'refresh_token'])
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['none'])
    assert.equal('client_id_metadata_document_supported' in meta, false)
    assert.equal('authorization_response_iss_parameter_supported' in meta, false)

    const registered = await fetch(`${as.issuer}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'a test', redirect_uris: ['http://127.0.0.1/cb'] }),
    })
    assert.equal(registered.status, 201)
    const client = (await registered.json()) as Record<string, unknown>
    assert.equal(client.client_id, 'dcr-1')
    assert.equal(client.client_name, 'a test')
    assert.equal(as.registrations(), 1)

    // PKCE is not optional.
    const noVerifier = await postForm(as.tokenEndpoint, {
      grant_type: 'authorization_code',
      code: 'c',
      client_id: 'dcr-1',
    })
    assert.equal(noVerifier.status, 400)
    const first = await postForm(as.tokenEndpoint, {
      grant_type: 'authorization_code',
      code: 'c',
      code_verifier: 'v',
      client_id: 'dcr-1',
    })
    assert.deepEqual(first.body, {
      access_token: 'access-1',
      token_type: 'Bearer',
      expires_in: 120,
      refresh_token: 'refresh-1',
    })
    assert.deepEqual([...as.validTokens], ['access-1'])
    const second = await postForm(as.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'dcr-1',
    })
    assert.equal(second.body.access_token, 'access-2')
    assert.deepEqual([...as.validTokens], ['access-2'], 'only the newest token works')
    assert.deepEqual(as.grants(), ['authorization_code', 'authorization_code', 'refresh_token'])
    assert.deepEqual(as.tokenClientIds(), ['dcr-1', 'dcr-1', 'dcr-1'])
    assert.equal(as.tokenRequests().length, 3)
    assert.equal(as.tokenRequests()[2].params.refresh_token, 'refresh-1')
    assert.equal((await getJson(`${as.issuer}/nothing`)).status, 404)
  } finally {
    await as.close()
  }
})

test('authorization server: the optional metadata flags are advertised when asked', async () => {
  const as = await startLocalAuthorizationServer({
    clientIdMetadataDocument: true,
    issParameter: true,
  })
  try {
    const meta = (await getJson(`${as.issuer}/.well-known/oauth-authorization-server`)).body
    assert.equal(meta.client_id_metadata_document_supported, true)
    assert.equal(meta.authorization_response_iss_parameter_supported, true)
  } finally {
    await as.close()
  }
})

// ── the enterprise personality: the jwt-bearer grant with an ID-JAG ───────

interface IEnterpriseWorld {
  idp: ILocalIdp
  as: ILocalAuthorizationServer
  /** A fresh ID-JAG addressed to this authorization server. */
  idJag: (extra?: Record<string, string>) => Promise<string>
}

const withEnterprise = async (
  body: (world: IEnterpriseWorld) => Promise<void>,
  enterprise: Partial<IEnterpriseGrantOptions> = {},
): Promise<void> => {
  const idp = await startLocalIdp({
    clientId: IDP_CLIENT,
    clientSecret: IDP_SECRET,
    resourceClientId: AS_CLIENT,
  })
  const as = await startLocalAuthorizationServer({
    resource: RESOURCE,
    enterprise: {
      idpIssuer: idp.issuer,
      jwksUri: idp.jwksUri,
      clientId: AS_CLIENT,
      clientSecret: AS_SECRET,
      ...enterprise,
    },
  })
  try {
    await body({
      idp,
      as,
      idJag: async (extra = {}) => {
        const res = await postForm(
          idp.tokenEndpoint,
          exchangeParams(idp.issueIdToken(), as.issuer, extra),
          basic(IDP_CLIENT, IDP_SECRET),
        )
        return String(res.body.access_token)
      },
    })
  } finally {
    await as.close()
    await idp.close()
  }
}

test('enterprise authorization server: an ID-JAG from the IdP buys an access token, once', async () => {
  await withEnterprise(async ({ as, idJag }) => {
    const meta = (await getJson(`${as.issuer}/.well-known/oauth-authorization-server`)).body
    assert.deepEqual(meta.grant_types_supported, [JWT_BEARER_GRANT])
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, [
      'client_secret_basic',
      'client_secret_post',
    ])
    assert.deepEqual(meta.authorization_grant_profiles_supported, [
      'urn:ietf:params:oauth:grant-profile:id-jag',
    ])

    const jag = await idJag({ resource: RESOURCE, scope: 'mcp:tools' })
    const granted = await postForm(as.tokenEndpoint, grantParams(jag), basic(AS_CLIENT, AS_SECRET))
    assert.equal(granted.status, 200)
    assert.deepEqual(granted.body, {
      access_token: 'access-1',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:tools',
    })
    assert.equal('refresh_token' in granted.body, false, 'the ID-JAG replaces the refresh token')
    assert.ok(as.validTokens.has('access-1'))
    assert.equal(as.tokenRequests()[0].authMethod, 'basic')
    assert.equal(as.tokenRequests()[0].error, undefined)

    // The same ID-JAG a second time.
    const replay = await postForm(as.tokenEndpoint, grantParams(jag), basic(AS_CLIENT, AS_SECRET))
    assert.equal(replay.status, 400)
    assert.equal(replay.body.error_description, 'Assertion was already used')
    assert.equal(as.tokenRequests()[1].error, 'invalid_grant: Assertion was already used')

    // The secret in the body is accepted as well.
    const post = await postForm(as.tokenEndpoint, {
      ...grantParams(await idJag()),
      client_id: AS_CLIENT,
      client_secret: AS_SECRET,
    })
    assert.equal(post.status, 200)
  })
})

test('enterprise authorization server: each thing wrong with the client or the grant is refused by name', async () => {
  await withEnterprise(async ({ idp, as, idJag }) => {
    const auth = basic(AS_CLIENT, AS_SECRET)
    const refused = async (
      params: Record<string, string>,
      headers: Record<string, string> = auth,
    ) => {
      const res = await postForm(as.tokenEndpoint, params, headers)
      return `${res.status} ${res.body.error}: ${res.body.error_description}`
    }
    assert.equal(
      await refused(grantParams(await idJag()), basic(AS_CLIENT, 'wrong')),
      '401 invalid_client: Client authentication failed',
    )
    assert.equal(
      await refused({ ...grantParams(await idJag()), client_id: AS_CLIENT }, {}),
      '401 invalid_client: Client authentication failed',
    )
    assert.equal(
      await refused({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v' }),
      '400 unsupported_grant_type: Only the jwt-bearer grant is accepted',
    )
    assert.equal(
      await refused(grantParams('not.a.jwt')),
      '400 invalid_grant: Signature validation failed',
    )
    // An ID token is signed by the right key and is still not an ID-JAG.
    assert.equal(await refused(grantParams(idp.issueIdToken())), '400 invalid_grant: Not an ID-JAG')
    idp.misbehave.audience = 'https://another-as.example.test'
    assert.equal(
      await refused(grantParams(await idJag())),
      '400 invalid_grant: Audience validation failed',
    )
    idp.misbehave.audience = undefined
    idp.misbehave.expired = true
    assert.equal(
      await refused(grantParams(await idJag())),
      '400 invalid_grant: Assertion has expired',
    )
    idp.misbehave.expired = false
    assert.equal(
      await refused(grantParams(await idJag({ resource: 'http://127.0.0.1:9/another' }))),
      '400 invalid_target: This authorization server does not govern that resource',
    )
    // The resource can be set after the start, as the pair does.
    as.resource = 'http://127.0.0.1:9/another'
    assert.equal(
      (
        await postForm(
          as.tokenEndpoint,
          grantParams(await idJag({ resource: 'http://127.0.0.1:9/another' })),
          auth,
        )
      ).status,
      200,
    )
    assert.equal(as.validTokens.size, 1)
  })
})

test('enterprise authorization server: an ID-JAG from another IdP, or for another client, is refused', async () => {
  await withEnterprise(
    async ({ as, idJag }) => {
      const res = await postForm(
        as.tokenEndpoint,
        grantParams(await idJag()),
        basic(AS_CLIENT, AS_SECRET),
      )
      assert.equal(res.body.error_description, 'Issuer is not trusted')
    },
    { idpIssuer: 'https://another-idp.example.test' },
  )
  // The IdP issues for `agent-at-as`; this server knows the client under another name.
  await withEnterprise(
    async ({ as, idJag }) => {
      const res = await postForm(
        as.tokenEndpoint,
        grantParams(await idJag()),
        basic('renamed-client', AS_SECRET),
      )
      assert.equal(res.body.error_description, 'Assertion was issued to another client')
    },
    { clientId: 'renamed-client' },
  )
})

test('enterprise authorization server: a public client is identified by client_id alone', async () => {
  await withEnterprise(
    async ({ as, idJag }) => {
      const meta = (await getJson(`${as.issuer}/.well-known/oauth-authorization-server`)).body
      assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['none'])
      const res = await postForm(as.tokenEndpoint, {
        ...grantParams(await idJag()),
        client_id: AS_CLIENT,
      })
      assert.equal(res.status, 200)
      assert.equal(as.tokenRequests()[0].authMethod, 'none')
      const other = await postForm(as.tokenEndpoint, {
        ...grantParams(await idJag()),
        client_id: 'someone-else',
      })
      assert.equal(other.status, 401)
    },
    { clientSecret: undefined },
  )
})

test('enterprise authorization server faults: refuseGrant, echoRequest and echoAssertion', async () => {
  await withEnterprise(async ({ as, idJag }) => {
    const auth = basic(AS_CLIENT, AS_SECRET)
    as.faults.refuseGrant = { error: 'access_denied', description: 'Not today' }
    const refused = await postForm(as.tokenEndpoint, grantParams(await idJag()), auth)
    assert.equal(refused.status, 400)
    assert.deepEqual(refused.body, { error: 'access_denied', error_description: 'Not today' })
    as.faults.refuseGrant = undefined
    as.faults.echoRequest = true
    const jag = await idJag()
    const echoed = await postForm(as.tokenEndpoint, grantParams(jag), auth)
    assert.equal(echoed.status, 400)
    assert.ok(String(echoed.body.error_description).includes(jag), 'the request is quoted back')
    as.faults.echoRequest = false
    assert.equal((await postForm(as.tokenEndpoint, grantParams(await idJag()), auth)).status, 200)
    assert.equal(as.validTokens.size, 1)
  })
  // The same carelessness, switched on from the start.
  await withEnterprise(
    async ({ as, idJag }) => {
      const jag = await idJag()
      const echoed = await postForm(as.tokenEndpoint, grantParams(jag), basic(AS_CLIENT, AS_SECRET))
      assert.ok(String(echoed.body.error_description).includes(jag))
    },
    { echoAssertion: true },
  )
})

// ── private_key_jwt at the authorization server: the two forms ────────────

const KEY = generateClientKey('ES256', 'as-test-key')

test('enterprise authorization server: private_key_jwt in the rfc7523bis form (the default)', async () => {
  await withEnterprise(
    async ({ as, idJag }) => {
      const meta = (await getJson(`${as.issuer}/.well-known/oauth-authorization-server`)).body
      assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['private_key_jwt'])
      const send = async (assertion: string) =>
        postForm(as.tokenEndpoint, { ...grantParams(await idJag()), ...assertionParams(assertion) })
      const ok = await send(clientAssertion(KEY, { clientId: AS_CLIENT, audience: as.issuer }))
      assert.equal(ok.status, 200)
      assert.equal(as.tokenRequests()[0].authMethod, 'assertion')
      const endpoint = await send(
        clientAssertion(KEY, { clientId: AS_CLIENT, audience: as.tokenEndpoint }),
      )
      assert.equal(endpoint.status, 401)
      assert.equal(endpoint.body.error_description, 'Client assertion audience is not this server')
      const typ = await send(
        clientAssertion(KEY, { clientId: AS_CLIENT, audience: as.issuer, typ: 'JWT' }),
      )
      assert.equal(
        typ.body.error_description,
        'Client assertion typ is not client-authentication+jwt',
      )
      // A secret is no way in for a client registered with keys.
      const secret = await postForm(
        as.tokenEndpoint,
        grantParams(await idJag()),
        basic(AS_CLIENT, AS_SECRET),
      )
      assert.equal(secret.status, 401)
      // Nor is an assertion that names another client.
      const other = await send(clientAssertion(KEY, { clientId: 'other', audience: as.issuer }))
      assert.equal(other.status, 401)
    },
    { clientSecret: undefined, clientJwks: { keys: [KEY.publicJwk] } },
  )
})

test('enterprise authorization server: private_key_jwt in the rfc7523 form', async () => {
  await withEnterprise(
    async ({ as, idJag }) => {
      const send = async (assertion: string) =>
        postForm(as.tokenEndpoint, { ...grantParams(await idJag()), ...assertionParams(assertion) })
      const ok = await send(
        clientAssertion(KEY, { clientId: AS_CLIENT, audience: as.tokenEndpoint, typ: 'JWT' }),
      )
      assert.equal(ok.status, 200)
      const issuer = await send(
        clientAssertion(KEY, { clientId: AS_CLIENT, audience: as.issuer, typ: 'JWT' }),
      )
      assert.equal(issuer.status, 401)
      assert.equal(
        issuer.body.error_description,
        'Client assertion audience is not the token endpoint',
      )
      const typ = await send(
        clientAssertion(KEY, { clientId: AS_CLIENT, audience: as.tokenEndpoint }),
      )
      assert.equal(typ.body.error_description, 'Client assertion typ is not supported')
    },
    {
      clientSecret: undefined,
      clientJwks: { keys: [KEY.publicJwk] },
      assertionProfile: 'rfc7523',
    },
  )
})

test('enterprise authorization server: a client ID metadata document names the keys', async () => {
  const CIMD_URL = 'https://client.example.test/oauth/client.json'
  let document: Record<string, unknown> = {}
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(document))
  })
  const siteUrl = await listen(site)
  const idp = await startLocalIdp({
    clientId: IDP_CLIENT,
    clientSecret: IDP_SECRET,
    resourceClientId: CIMD_URL,
  })
  const as = await startLocalAuthorizationServer({
    enterprise: {
      idpIssuer: idp.issuer,
      jwksUri: idp.jwksUri,
      clientId: 'unused',
      cimd: { resolve: (url) => url.replace('https://client.example.test', siteUrl) },
    },
  })
  try {
    const meta = (await getJson(`${as.issuer}/.well-known/oauth-authorization-server`)).body
    assert.equal(meta.client_id_metadata_document_supported, true)
    const grant = async () => {
      const jag = await postForm(
        idp.tokenEndpoint,
        exchangeParams(idp.issueIdToken(), as.issuer),
        basic(IDP_CLIENT, IDP_SECRET),
      )
      return postForm(as.tokenEndpoint, {
        ...grantParams(String(jag.body.access_token)),
        ...assertionParams(clientAssertion(KEY, { clientId: CIMD_URL, audience: as.issuer })),
      })
    }
    document = {
      client_id: CIMD_URL,
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: { keys: [KEY.publicJwk] },
    }
    assert.equal((await grant()).status, 200)
    assert.deepEqual(as.cimdFetches, [CIMD_URL])
    document = { ...document, client_id: 'https://client.example.test/other.json' }
    assert.equal(
      (await grant()).body.error_description,
      'Client metadata document names another client',
    )
    document = { client_id: CIMD_URL, token_endpoint_auth_method: 'none' }
    assert.equal(
      (await grant()).body.error_description,
      'Client metadata document does not allow private_key_jwt',
    )
  } finally {
    await as.close()
    await idp.close()
    await closeServer(site)
  }
})
