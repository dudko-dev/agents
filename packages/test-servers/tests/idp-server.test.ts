import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateClientKey,
  ID_JAG_TOKEN_TYPE,
  ID_JAG_TYP,
  peekJwt,
  startLocalIdp,
  verifyJwt,
  type ILocalIdp,
  type ILocalIdpOptions,
} from '../src/index.ts'
import {
  assertionParams,
  basic,
  clientAssertion,
  exchangeParams,
  getJson,
  postForm,
} from './helpers.ts'

const CLIENT = 'agent-at-idp'
const SECRET = 'idp-secret-for-this-test'
const AUDIENCE = 'https://as.example.test'

const withIdp = async (
  body: (idp: ILocalIdp) => Promise<void>,
  opts: Partial<ILocalIdpOptions> = {},
): Promise<void> => {
  const idp = await startLocalIdp({
    clientId: CLIENT,
    clientSecret: SECRET,
    resourceClientId: 'agent-at-as',
    ...opts,
  })
  try {
    await body(idp)
  } finally {
    await idp.close()
  }
}

const exchange = (idp: ILocalIdp, extra: Record<string, string> = {}) =>
  postForm(
    idp.tokenEndpoint,
    exchangeParams(idp.issueIdToken(), AUDIENCE, extra),
    basic(CLIENT, SECRET),
  )

test('idp: starts on loopback and says where it is', async () => {
  await withIdp(async (idp) => {
    assert.match(idp.issuer, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(idp.tokenEndpoint, `${idp.issuer}/token`)
    assert.equal(idp.jwksUri, `${idp.issuer}/.well-known/jwks.json`)
    assert.equal(idp.idTokenEndpoint, undefined)
    const config = await getJson(`${idp.issuer}/.well-known/openid-configuration`)
    assert.equal(config.body.issuer, idp.issuer)
    assert.equal(config.body.token_endpoint, idp.tokenEndpoint)
    assert.equal(config.body.jwks_uri, idp.jwksUri)
    assert.equal(config.headers.get('access-control-allow-origin'), null, 'no CORS unless asked')
    assert.equal((await getJson(`${idp.issuer}/nothing`)).status, 404)
  })
})

test('idp: an ID token it issues is signed by the key it publishes', async () => {
  await withIdp(async (idp) => {
    const jwks = (await getJson(idp.jwksUri)).body as { keys: never[] }
    const token = verifyJwt(idp.issueIdToken({ sub: 'U1', email: 'u1@example.test' }), jwks)
    assert.ok(token)
    assert.equal(token.payload.iss, idp.issuer)
    assert.equal(token.payload.aud, CLIENT)
    assert.equal(token.payload.sub, 'U1')
    assert.equal(token.payload.email, 'u1@example.test')
    // A key of its own every start: nothing is kept between runs.
    await withIdp(async (other) => {
      assert.equal(verifyJwt(other.issueIdToken(), jwks), undefined)
    })
  })
})

test('idp: the token exchange answers with a signed ID-JAG for the audience asked', async () => {
  await withIdp(async (idp) => {
    const res = await exchange(idp, {
      resource: 'https://mcp.example.test/mcp',
      scope: 'mcp:tools',
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.body.issued_token_type, ID_JAG_TOKEN_TYPE)
    assert.equal(res.body.token_type, 'N_A')
    const jwks = (await getJson(idp.jwksUri)).body as { keys: never[] }
    const jag = verifyJwt(String(res.body.access_token), jwks)
    assert.ok(jag, 'signed by the published key')
    assert.equal(jag.header.typ, ID_JAG_TYP)
    assert.equal(jag.payload.iss, idp.issuer)
    assert.equal(jag.payload.aud, AUDIENCE)
    assert.equal(jag.payload.client_id, 'agent-at-as')
    assert.equal(jag.payload.resource, 'https://mcp.example.test/mcp')
    assert.equal(jag.payload.scope, 'mcp:tools')
    assert.equal(jag.payload.sub, 'U019488227')
    // The exchange is recorded as received.
    assert.equal(idp.exchanges.length, 1)
    assert.equal(idp.exchanges[0].status, 200)
    assert.equal(idp.exchanges[0].authMethod, 'basic')
    assert.equal(idp.exchanges[0].params.audience, AUDIENCE)
    assert.deepEqual(idp.issuedIdJags, [res.body.access_token])
  })
})

test('idp: the client secret in the body works too; a wrong or missing one is refused', async () => {
  await withIdp(async (idp) => {
    const params = exchangeParams(idp.issueIdToken(), AUDIENCE)
    const post = await postForm(idp.tokenEndpoint, {
      ...params,
      client_id: CLIENT,
      client_secret: SECRET,
    })
    assert.equal(post.status, 200)
    assert.equal(idp.exchanges[0].authMethod, 'post')
    const wrong = await postForm(idp.tokenEndpoint, params, basic(CLIENT, 'not-the-secret'))
    assert.equal(wrong.status, 401)
    assert.equal(wrong.body.error, 'invalid_client')
    const other = await postForm(idp.tokenEndpoint, params, basic('someone-else', SECRET))
    assert.equal(other.status, 401)
    const none = await postForm(idp.tokenEndpoint, { ...params, client_id: CLIENT })
    assert.equal(none.status, 401)
    assert.equal(idp.issuedIdJags.length, 1)
  })
})

test('idp: what is not an ID-JAG exchange, or carries a bad subject token, is refused', async () => {
  await withIdp(async (idp) => {
    const auth = basic(CLIENT, SECRET)
    const good = exchangeParams(idp.issueIdToken(), AUDIENCE)
    const refused = async (params: Record<string, string>) =>
      (await postForm(idp.tokenEndpoint, params, auth)).body
    assert.equal(
      (await refused({ ...good, grant_type: 'authorization_code' })).error,
      'invalid_request',
    )
    assert.equal(
      (await refused({ ...good, requested_token_type: 'urn:x:other' })).error,
      'invalid_request',
    )
    const { audience: _audience, ...noAudience } = good
    assert.equal((await refused(noAudience)).error, 'invalid_target')
    assert.equal((await refused({ ...good, subject_token: 'not.a.jwt' })).error, 'invalid_grant')
    assert.equal(
      (await refused({ ...good, subject_token: idp.issueIdToken({ expiresIn: -10 }) })).error,
      'invalid_grant',
    )
    // A token from another IdP, however well made.
    await withIdp(async (other) => {
      assert.equal(
        (await refused({ ...good, subject_token: other.issueIdToken() })).error,
        'invalid_grant',
      )
    })
    assert.equal(idp.issuedIdJags.length, 0)
  })
})

// ── private_key_jwt: the two forms of the client assertion ────────────────

const KEY = generateClientKey('ES256', 'idp-test-key')

test('idp: private_key_jwt in the rfc7523bis form (the default): aud = issuer, typ client-authentication+jwt', async () => {
  await withIdp(
    async (idp) => {
      const send = (assertion: string) =>
        postForm(idp.tokenEndpoint, {
          ...exchangeParams(idp.issueIdToken(), AUDIENCE),
          ...assertionParams(assertion),
        })
      const ok = await send(clientAssertion(KEY, { clientId: CLIENT, audience: idp.issuer }))
      assert.equal(ok.status, 200)
      assert.equal(idp.exchanges[0].authMethod, 'assertion')
      // The RFC 7523 form is refused, piece by piece.
      const endpoint = await send(
        clientAssertion(KEY, { clientId: CLIENT, audience: idp.tokenEndpoint }),
      )
      assert.equal(endpoint.status, 401)
      assert.equal(endpoint.body.error_description, 'Client assertion audience is not this server')
      const typ = await send(
        clientAssertion(KEY, { clientId: CLIENT, audience: idp.issuer, typ: 'JWT' }),
      )
      assert.equal(
        typ.body.error_description,
        'Client assertion typ is not client-authentication+jwt',
      )
      const noTyp = await send(
        clientAssertion(KEY, { clientId: CLIENT, audience: idp.issuer, typ: null }),
      )
      assert.equal(
        noTyp.body.error_description,
        'Client assertion typ is not client-authentication+jwt',
      )
      // The issuer among other audiences is not the sole audience.
      const list = await send(
        clientAssertion(KEY, { clientId: CLIENT, audience: [idp.issuer, idp.tokenEndpoint] }),
      )
      assert.equal(list.body.error_description, 'Client assertion audience is not this server')
    },
    { clientSecret: undefined, clientJwks: { keys: [KEY.publicJwk] } },
  )
})

test('idp: private_key_jwt in the rfc7523 form: aud = token endpoint, typ JWT or none', async () => {
  await withIdp(
    async (idp) => {
      const send = (assertion: string) =>
        postForm(idp.tokenEndpoint, {
          ...exchangeParams(idp.issueIdToken(), AUDIENCE),
          ...assertionParams(assertion),
        })
      for (const typ of ['JWT', null]) {
        const ok = await send(
          clientAssertion(KEY, { clientId: CLIENT, audience: idp.tokenEndpoint, typ }),
        )
        assert.equal(ok.status, 200, `typ ${typ}`)
      }
      // RFC 7523 lets the audience be a list that contains the token endpoint.
      const list = await send(
        clientAssertion(KEY, {
          clientId: CLIENT,
          audience: [idp.tokenEndpoint, 'https://other.example.test'],
          typ: 'JWT',
        }),
      )
      assert.equal(list.status, 200)
      // The bis form is refused, piece by piece.
      const issuer = await send(
        clientAssertion(KEY, { clientId: CLIENT, audience: idp.issuer, typ: 'JWT' }),
      )
      assert.equal(issuer.status, 401)
      assert.equal(
        issuer.body.error_description,
        'Client assertion audience is not the token endpoint',
      )
      const typ = await send(
        clientAssertion(KEY, { clientId: CLIENT, audience: idp.tokenEndpoint }),
      )
      assert.equal(typ.body.error_description, 'Client assertion typ is not supported')
    },
    { clientSecret: undefined, clientJwks: { keys: [KEY.publicJwk] }, assertionProfile: 'rfc7523' },
  )
})

test('idp: a client assertion that is replayed, stale, long-lived, misnamed or signed by another key is refused', async () => {
  await withIdp(
    async (idp) => {
      const send = async (assertion: string) =>
        (
          await postForm(idp.tokenEndpoint, {
            ...exchangeParams(idp.issueIdToken(), AUDIENCE),
            ...assertionParams(assertion),
          })
        ).body.error_description
      const once = clientAssertion(KEY, { clientId: CLIENT, audience: idp.issuer })
      assert.equal(await send(once), undefined)
      assert.equal(await send(once), 'Client assertion was already used')
      assert.equal(
        await send(clientAssertion(KEY, { clientId: CLIENT, audience: idp.issuer, expiresIn: -5 })),
        'Client assertion has expired',
      )
      assert.equal(
        await send(
          clientAssertion(KEY, { clientId: CLIENT, audience: idp.issuer, expiresIn: 3600 }),
        ),
        'Client assertion lives too long',
      )
      assert.equal(
        await send(
          clientAssertion(KEY, { clientId: CLIENT, audience: idp.issuer, sub: 'someone-else' }),
        ),
        'Client assertion iss and sub must both be the client',
      )
      const stranger = generateClientKey('ES256', KEY.kid)
      assert.equal(
        await send(clientAssertion(stranger, { clientId: CLIENT, audience: idp.issuer })),
        'Client assertion signature validation failed',
      )
      // Rightly signed, by a client that is not the one registered here.
      const other = await postForm(idp.tokenEndpoint, {
        ...exchangeParams(idp.issueIdToken(), AUDIENCE),
        ...assertionParams(clientAssertion(KEY, { clientId: 'other', audience: idp.issuer })),
      })
      assert.equal(other.status, 401)
      // A secret is no way in for a client registered with keys.
      const secret = await postForm(
        idp.tokenEndpoint,
        exchangeParams(idp.issueIdToken(), AUDIENCE),
        basic(CLIENT, SECRET),
      )
      assert.equal(secret.status, 401)
    },
    { clientSecret: undefined, clientJwks: { keys: [KEY.publicJwk] } },
  )
  // And an assertion is no way in for a client registered with a secret.
  await withIdp(async (idp) => {
    const res = await postForm(idp.tokenEndpoint, {
      ...exchangeParams(idp.issueIdToken(), AUDIENCE),
      ...assertionParams(clientAssertion(KEY, { clientId: CLIENT, audience: idp.issuer })),
    })
    assert.equal(res.body.error_description, 'Client assertions are not accepted for this client')
  })
})

// ── the misbehaviour switches, one at a time ──────────────────────────────

test('idp misbehave.issuedTokenType: the answer names another token type', async () => {
  await withIdp(async (idp) => {
    idp.misbehave.issuedTokenType = 'urn:ietf:params:oauth:token-type:access_token'
    const res = await exchange(idp)
    assert.equal(res.status, 200)
    assert.equal(res.body.issued_token_type, 'urn:ietf:params:oauth:token-type:access_token')
    assert.equal(typeof res.body.access_token, 'string')
  })
})

test('idp misbehave.omitToken: the answer carries no token', async () => {
  await withIdp(async (idp) => {
    idp.misbehave.omitToken = true
    const res = await exchange(idp)
    assert.equal(res.status, 200)
    assert.equal(res.body.issued_token_type, ID_JAG_TOKEN_TYPE)
    assert.equal('access_token' in res.body, false)
  })
})

test('idp misbehave.audience: the ID-JAG is addressed to someone else', async () => {
  await withIdp(async (idp) => {
    idp.misbehave.audience = 'https://another-as.example.test'
    const res = await exchange(idp)
    assert.equal(
      peekJwt(String(res.body.access_token)).payload.aud,
      'https://another-as.example.test',
    )
    assert.equal(idp.exchanges[0].params.audience, AUDIENCE, 'what was asked is still recorded')
  })
})

test('idp misbehave.expired: the ID-JAG expired a minute ago', async () => {
  await withIdp(async (idp) => {
    idp.misbehave.expired = true
    const res = await exchange(idp)
    const { exp } = peekJwt(String(res.body.access_token)).payload
    assert.ok((exp as number) < Math.floor(Date.now() / 1000))
  })
})

test('idp misbehave.rejectClient: the right credentials are refused', async () => {
  await withIdp(async (idp) => {
    idp.misbehave.rejectClient = true
    const res = await exchange(idp)
    assert.equal(res.status, 401)
    assert.equal(res.body.error, 'invalid_client')
    assert.equal(idp.exchanges[0].status, 401)
    idp.misbehave.rejectClient = false
    assert.equal((await exchange(idp)).status, 200, 'the switch can be put back')
  })
})

test('idp misbehave.deny: refused by policy, with the given words', async () => {
  await withIdp(async (idp) => {
    idp.misbehave.deny = 'User is not assigned to this application'
    const res = await exchange(idp)
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, {
      error: 'access_denied',
      error_description: 'User is not assigned to this application',
    })
  })
})

test('idp misbehave.redirectTo: a 307 instead of an answer', async () => {
  await withIdp(async (idp) => {
    idp.misbehave.redirectTo = 'http://127.0.0.1:9/elsewhere'
    const res = await exchange(idp)
    assert.equal(res.status, 307)
    assert.equal(res.headers.get('location'), 'http://127.0.0.1:9/elsewhere')
    assert.equal(idp.exchanges[0].status, 307)
  })
})

test('idp misbehave.echoRequest: the error quotes the whole request', async () => {
  await withIdp(async (idp) => {
    idp.misbehave.echoRequest = true
    const idToken = idp.issueIdToken()
    const res = await postForm(
      idp.tokenEndpoint,
      exchangeParams(idToken, AUDIENCE),
      basic(CLIENT, SECRET),
    )
    assert.equal(res.status, 400)
    assert.ok(String(res.body.error_description).includes(idToken))
  })
})

test('idp: the ID token endpoint exists only when asked for', async () => {
  await withIdp(async (idp) => {
    assert.equal((await getJson(`${idp.issuer}/test/id-token`)).status, 404)
  })
  await withIdp(
    async (idp) => {
      assert.equal(idp.idTokenEndpoint, `${idp.issuer}/test/id-token`)
      const res = await getJson(idp.idTokenEndpoint)
      assert.equal(res.status, 200)
      const jwks = (await getJson(idp.jwksUri)).body as { keys: never[] }
      assert.equal(verifyJwt(String(res.body.id_token), jwks)?.payload.aud, CLIENT)
      // Good enough to exchange.
      const exchanged = await postForm(
        idp.tokenEndpoint,
        exchangeParams(String(res.body.id_token), AUDIENCE),
        basic(CLIENT, SECRET),
      )
      assert.equal(exchanged.status, 200)
    },
    { idTokenEndpoint: true },
  )
})
