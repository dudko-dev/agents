import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { inspect } from 'node:util'
import { createAgent, type IAgent } from '../src/index.ts'
import { connectMcpServers } from '../src/mcp.ts'
import {
  createClientAssertion,
  createEnterpriseOAuthProvider,
  ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION,
  enterpriseGrantTarget,
  EnterpriseOAuthError,
  requestIdJag,
  type EnterpriseAssertionAlgorithm,
} from '../src/mcp-enterprise-oauth.ts'
import { MemoryOAuthStore } from '../src/mcp-oauth.ts'
import {
  CLIENT_ASSERTION_TYPE,
  generateClientKey,
  ID_JAG_TOKEN_TYPE,
  ID_TOKEN_TOKEN_TYPE,
  JWT_BEARER_GRANT,
  peekJwt,
  startLocalIdp,
  TOKEN_EXCHANGE_GRANT,
  verifyJwt,
  startLocalMcp,
  type ILocalIdp,
  type ILocalIdpOptions,
  type ILocalMcp,
  type ILocalMcpOptions,
} from '@dudko.dev/test-servers'
import {
  hasToolResult,
  startLocalOpenAI,
  type IChatRequest,
  type IScriptedReply,
} from './helpers/openai-server.ts'

// Enterprise-Managed Authorization (ID-JAG). The first half is the guards, one
// by one, against a mock fetch; the second half is the whole flow over real
// sockets: a test identity provider that signs real tokens, an authorization
// server that verifies them against the IdP's keys, and the SDK's MCP server.
// There is no commercial IdP here - the test IdP is the verification.

// Values that must never surface in an error, a log line or the store.
const ID_TOKEN = 'eyJhbGciOiJFUzI1NiJ9.aWQtdG9rZW4tcGF5bG9hZA.aWQtdG9rZW4tc2ln'
const ID_JAG = 'eyJ0eXAiOiJvYXV0aC1pZC1qYWcrand0In0.aWQtamFnLXBheWxvYWQ.aWQtamFnLXNpZw'
const AS_SECRET = 'as-secret-7f3a91c2'
const IDP_SECRET = 'idp-secret-b84e02d6'

const MCP_URL = 'https://mcp.example.test/mcp'
const AS_URL = 'https://as.example.test'
const IDP_TOKEN_URL = 'https://idp.example.test/oauth2/token'

const baseOptions = (extra: Record<string, unknown> = {}) => ({
  serverUrl: MCP_URL,
  clientId: 'agent-at-as',
  clientSecret: AS_SECRET,
  expectedIssuer: AS_URL,
  idp: { tokenEndpoint: IDP_TOKEN_URL, clientId: 'agent-at-idp', clientSecret: IDP_SECRET },
  getIdToken: () => ID_TOKEN,
  store: new MemoryOAuthStore(),
  ...extra,
})

const discovery = (extra: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) =>
  ({
    authorizationServerUrl: `${AS_URL}/`,
    authorizationServerMetadata: {
      issuer: AS_URL,
      token_endpoint: `${AS_URL}/token`,
      response_types_supported: ['code'],
      ...metadata,
    },
    resourceMetadata: { resource: MCP_URL, authorization_servers: [AS_URL] },
    ...extra,
  }) as never

interface IRecordedCall {
  url: string
  init: RequestInit
  params: URLSearchParams
  headers: Headers
}

/** A mock IdP: records the request, answers with `reply`. */
const mockIdp = (reply: () => Response | Promise<Response>) => {
  const calls: IRecordedCall[] = []
  const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    calls.push({
      url: String(url),
      init,
      params: new URLSearchParams(String(init.body)),
      headers: new Headers(init.headers),
    })
    return reply()
  }
  return { calls, fetchFn }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const goodExchange = (): Response =>
  jsonResponse({ issued_token_type: ID_JAG_TOKEN_TYPE, access_token: ID_JAG, token_type: 'N_A' })

const assertNoSecrets = (text: string, label: string): void => {
  for (const [name, value] of Object.entries({ ID_TOKEN, ID_JAG, AS_SECRET, IDP_SECRET })) {
    assert.ok(!text.includes(value), `${label} must not contain ${name}`)
  }
}

const rejection = async (fn: () => Promise<unknown>): Promise<EnterpriseOAuthError> => {
  try {
    await fn()
  } catch (err) {
    assert.ok(err instanceof EnterpriseOAuthError, `expected EnterpriseOAuthError, got ${err}`)
    return err
  }
  return assert.fail('expected a rejection')
}

// ── guards: construction ──────────────────────────────────────────────────

test('enterprise: the MCP server URL must be https or loopback', () => {
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions({ serverUrl: 'http://mcp.example.test/mcp' })),
    /requires https/,
  )
  // A registrable host that merely starts with "localhost" is not loopback.
  assert.throws(
    () =>
      createEnterpriseOAuthProvider(
        baseOptions({ serverUrl: 'http://localhost.attacker.example/mcp' }),
      ),
    /requires https/,
  )
  createEnterpriseOAuthProvider(baseOptions({ serverUrl: 'http://127.0.0.1:8080/mcp' }))
})

test('enterprise: the IdP token endpoint must be https or loopback', () => {
  const idp = (tokenEndpoint: string) => ({
    idp: { tokenEndpoint, clientId: 'agent-at-idp', clientSecret: IDP_SECRET },
  })
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions(idp('http://idp.example.test/token'))),
    /Enterprise IdP token endpoint: requires https/,
  )
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions(idp('not a url'))),
    /not a valid URL/,
  )
  createEnterpriseOAuthProvider(baseOptions(idp('http://localhost:9000/token')))
})

test('enterprise: expectedIssuer must be https or loopback, and the required options are required', () => {
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions({ expectedIssuer: 'http://as.example.test' })),
    /requires https/,
  )
  assert.throws(() => createEnterpriseOAuthProvider(baseOptions({ clientId: '' })), /clientId/)
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions({ getIdToken: undefined })),
    /getIdToken/,
  )
})

test('enterprise: a client secret needs expectedIssuer; a public client may omit it', () => {
  // Without the issuer, the MCP server's metadata would choose who gets the secret.
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions({ expectedIssuer: undefined })),
    /clientSecret needs expectedIssuer/,
  )
  createEnterpriseOAuthProvider(baseOptions())
  const pub = createEnterpriseOAuthProvider(
    baseOptions({ clientSecret: undefined, expectedIssuer: undefined }),
  )
  assert.deepEqual(pub.clientInformation(), { client_id: 'agent-at-as' })
  // The secret at the IdP is a different matter: it only ever goes to the
  // configured token endpoint.
  assert.equal(pub.clientMetadata.token_endpoint_auth_method, 'none')
})

// ── guards: the audience and the resource come from discovery ─────────────

test('enterpriseGrantTarget: audience is the discovered issuer, resource the published one', () => {
  assert.deepEqual(enterpriseGrantTarget(MCP_URL, discovery()), {
    audience: AS_URL,
    resource: MCP_URL,
    tokenEndpoint: `${AS_URL}/token`,
  })
  // No protected resource metadata: the configured URL, without its fragment.
  assert.deepEqual(
    enterpriseGrantTarget(`${MCP_URL}#frag`, discovery({ resourceMetadata: undefined })),
    { audience: AS_URL, resource: MCP_URL, tokenEndpoint: `${AS_URL}/token` },
  )
  // Metadata without a token endpoint names none: nothing is made up for it.
  assert.deepEqual(enterpriseGrantTarget(MCP_URL, discovery({}, { token_endpoint: undefined })), {
    audience: AS_URL,
    resource: MCP_URL,
  })
})

test('enterpriseGrantTarget: refuses without discovery, or without an issuer in the metadata', () => {
  assert.throws(() => enterpriseGrantTarget(MCP_URL, undefined), /nothing is known/)
  assert.throws(
    () => enterpriseGrantTarget(MCP_URL, discovery({ authorizationServerMetadata: undefined })),
    /published no metadata with an issuer/,
  )
  assert.throws(
    () => enterpriseGrantTarget(MCP_URL, discovery({}, { issuer: '' })),
    /published no metadata with an issuer/,
  )
})

test('enterpriseGrantTarget: refuses metadata that names another issuer (RFC 8414 3.3)', () => {
  // A hostile MCP server points at its own authorization server, whose metadata
  // claims to be an honest one: the ID-JAG would be minted for the honest
  // server and delivered to the hostile token endpoint.
  assert.throws(
    () =>
      enterpriseGrantTarget(
        MCP_URL,
        discovery(
          { authorizationServerUrl: 'https://evil.example.test/' },
          { issuer: AS_URL, token_endpoint: 'https://evil.example.test/token' },
        ),
      ),
    (err: unknown) =>
      err instanceof EnterpriseOAuthError &&
      err.hop === 'discovery' &&
      /names another issuer/.test(err.message),
  )
})

test('enterpriseGrantTarget: with expectedIssuer, any other authorization server is refused', () => {
  assert.deepEqual(enterpriseGrantTarget(MCP_URL, discovery(), `${AS_URL}/`).audience, AS_URL)
  assert.throws(
    () => enterpriseGrantTarget(MCP_URL, discovery(), 'https://other-as.example.test'),
    /expected "https:\/\/other-as\.example\.test"; refusing to send credentials/,
  )
})

test('enterpriseGrantTarget: the authorization server and its token endpoint must be https or loopback', () => {
  assert.throws(
    () =>
      enterpriseGrantTarget(
        MCP_URL,
        discovery(
          { authorizationServerUrl: 'http://as.example.test/' },
          { issuer: 'http://as.example.test' },
        ),
      ),
    /MCP authorization server: requires https/,
  )
  assert.throws(
    () =>
      enterpriseGrantTarget(
        MCP_URL,
        discovery({}, { token_endpoint: 'http://as.example.test/token' }),
      ),
    /token endpoint: requires https/,
  )
})

test('enterpriseGrantTarget: a published resource that does not cover this server is refused', () => {
  const withResource = (resource: string) =>
    discovery({ resourceMetadata: { resource, authorization_servers: [AS_URL] } })
  for (const resource of [
    'https://other.example.test/mcp',
    'https://mcp.example.test/mcp/deeper',
    'https://mcp.example.test/mcp2',
    'not a url',
  ]) {
    assert.throws(
      () => enterpriseGrantTarget(MCP_URL, withResource(resource)),
      /does not cover/,
      resource,
    )
  }
  // A parent path on the same origin is the server's own resource identifier.
  assert.equal(
    enterpriseGrantTarget(MCP_URL, withResource('https://mcp.example.test')).resource,
    'https://mcp.example.test',
  )
})

// ── guards: the token exchange ────────────────────────────────────────────

const exchange = (fetchFn: unknown, extra: Record<string, unknown> = {}) =>
  requestIdJag({
    idp: { tokenEndpoint: IDP_TOKEN_URL, clientId: 'agent-at-idp', clientSecret: IDP_SECRET },
    idToken: ID_TOKEN,
    audience: AS_URL,
    resource: MCP_URL,
    fetch: fetchFn as never,
    ...extra,
  })

test('requestIdJag: sends the token exchange the ID-JAG draft describes', async () => {
  const idp = mockIdp(goodExchange)
  assert.equal(await exchange(idp.fetchFn, { scope: 'chat.read chat.history' }), ID_JAG)

  const [call] = idp.calls
  assert.equal(call.url, IDP_TOKEN_URL)
  assert.equal(call.init.method, 'POST')
  assert.deepEqual(Object.fromEntries(call.params), {
    grant_type: TOKEN_EXCHANGE_GRANT,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    audience: AS_URL,
    resource: MCP_URL,
    subject_token: ID_TOKEN,
    subject_token_type: ID_TOKEN_TOKEN_TYPE,
    scope: 'chat.read chat.history',
  })
  // Basic by default: the secret is in the header and not in the body.
  assert.equal(
    call.headers.get('authorization'),
    `Basic ${Buffer.from(`agent-at-idp:${IDP_SECRET}`).toString('base64')}`,
  )
  assert.equal(call.headers.get('content-type'), 'application/x-www-form-urlencoded')
})

test('requestIdJag: client_secret_post and a public client put the client in the body', async () => {
  const post = mockIdp(goodExchange)
  await exchange(post.fetchFn, {
    idp: {
      tokenEndpoint: IDP_TOKEN_URL,
      clientId: 'agent-at-idp',
      clientSecret: IDP_SECRET,
      clientAuthMethod: 'client_secret_post',
    },
  })
  assert.equal(post.calls[0].params.get('client_id'), 'agent-at-idp')
  assert.equal(post.calls[0].params.get('client_secret'), IDP_SECRET)
  assert.equal(post.calls[0].headers.get('authorization'), null)

  const pub = mockIdp(goodExchange)
  await exchange(pub.fetchFn, { idp: { tokenEndpoint: IDP_TOKEN_URL, clientId: 'agent-at-idp' } })
  assert.equal(pub.calls[0].params.get('client_id'), 'agent-at-idp')
  assert.equal(pub.calls[0].params.has('client_secret'), false)
  assert.equal(pub.calls[0].headers.get('authorization'), null)
})

test('requestIdJag: a redirect is refused, never followed', async () => {
  const idp = mockIdp(goodExchange)
  await exchange(idp.fetchFn)
  assert.equal(idp.calls[0].init.redirect, 'error')
})

test('requestIdJag: an answer that is not an ID-JAG is refused', async () => {
  for (const body of [
    // An access token for something else, dressed as the answer.
    { issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', access_token: ID_JAG },
    { access_token: ID_JAG, token_type: 'Bearer' },
    { issued_token_type: 42, access_token: ID_JAG },
  ]) {
    const err = await rejection(() => exchange(mockIdp(() => jsonResponse(body)).fetchFn))
    assert.equal(err.hop, 'idp')
    assert.match(err.message, /where an ID-JAG .* was requested; nothing was sent/)
    assertNoSecrets(err.message, 'the error')
  }
})

test('requestIdJag: an answer without a token is refused', async () => {
  for (const body of [
    { issued_token_type: ID_JAG_TOKEN_TYPE },
    { issued_token_type: ID_JAG_TOKEN_TYPE, access_token: '' },
    { issued_token_type: ID_JAG_TOKEN_TYPE, access_token: { jwt: ID_JAG } },
  ]) {
    const err = await rejection(() => exchange(mockIdp(() => jsonResponse(body)).fetchFn))
    assert.equal(err.hop, 'idp')
    assert.match(err.message, /returned no ID-JAG/)
  }
  const notJson = mockIdp(() => new Response('<html>ok</html>', { status: 200 }))
  await assert.rejects(() => exchange(notJson.fetchFn), /no issued_token_type/)
})

test('requestIdJag: the IdP error is passed on with its code, and names the hop', async () => {
  const idp = mockIdp(() =>
    jsonResponse({ error: 'invalid_grant', error_description: 'Audience validation failed' }, 400),
  )
  const err = await rejection(() => exchange(idp.fetchFn))
  assert.equal(err.hop, 'idp')
  assert.equal(err.code, 'invalid_grant')
  assert.equal(
    err.message,
    'Enterprise IdP token exchange failed: the identity provider answered 400 invalid_grant - Audience validation failed',
  )

  const plain = mockIdp(() => new Response('Bad Gateway', { status: 502 }))
  const upstream = await rejection(() => exchange(plain.fetchFn))
  assert.match(upstream.message, /answered 502$/)
})

test('requestIdJag: no token or secret survives in an error, whatever the server or fetch says', async () => {
  // A server that echoes the request body back in its error description.
  const echo = mockIdp(() =>
    jsonResponse(
      {
        error: 'invalid_request',
        error_description: `bad: subject_token=${ID_TOKEN}&client_secret=${IDP_SECRET}`,
      },
      400,
    ),
  )
  const echoed = await rejection(() => exchange(echo.fetchFn))
  assertNoSecrets(echoed.message, 'an echoed error')
  assert.match(echoed.message, /\[redacted\]/)

  // A fetch whose own error quotes the request.
  const thrower = async (): Promise<Response> => {
    throw new Error(`connect failed for body subject_token=${ID_TOKEN} secret ${IDP_SECRET}`)
  }
  const network = await rejection(() => exchange(thrower))
  assert.equal(network.hop, 'idp')
  assertNoSecrets(network.message, 'a network error')
  assert.match(network.message, /did not complete/)
})

// ── the provider ──────────────────────────────────────────────────────────

test('provider: non-interactive, with the pre-registered client from configuration', async () => {
  const provider = createEnterpriseOAuthProvider(baseOptions({ expectedIssuer: AS_URL }))
  assert.equal(provider.redirectUrl, undefined, 'no redirectUrl is what makes it non-interactive')
  assert.equal(provider.extension, ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION)
  assert.deepEqual(provider.clientInformation(), {
    client_id: 'agent-at-as',
    client_secret: AS_SECRET,
    // The stamp the SDK checks before presenting the client anywhere.
    issuer: AS_URL,
  })
  // An `invalid_client` makes the SDK drop "all": the client is configuration
  // and survives it.
  await provider.invalidateCredentials('all')
  assert.equal(provider.clientInformation().client_id, 'agent-at-as')
  assert.throws(() => provider.redirectToAuthorization(), /no interactive step/)
})

test('provider: the ID-JAG is requested for the discovered audience and resource, never from the caller', async () => {
  const idp = mockIdp(goodExchange)
  let asked = 0
  const provider = createEnterpriseOAuthProvider(
    baseOptions({
      fetch: idp.fetchFn,
      scope: 'mcp:tools',
      getIdToken: () => {
        asked += 1
        return ID_TOKEN
      },
    }),
  )
  await provider.saveDiscoveryState(discovery())

  const params = await provider.prepareTokenRequest('mcp:tools')
  assert.deepEqual(Object.fromEntries(params), { grant_type: JWT_BEARER_GRANT, assertion: ID_JAG })
  assert.equal(idp.calls[0].params.get('audience'), AS_URL)
  assert.equal(idp.calls[0].params.get('resource'), MCP_URL)
  assert.equal(idp.calls[0].params.get('scope'), 'mcp:tools')

  // A new ID-JAG every time: neither it nor the ID token is cached.
  await provider.prepareTokenRequest()
  assert.equal(asked, 2)
  assert.equal(idp.calls.length, 2)
})

test('provider: refused discovery reaches neither the host nor the IdP, and is not kept', async () => {
  const idp = mockIdp(goodExchange)
  let asked = 0
  const store = new MemoryOAuthStore()
  const provider = createEnterpriseOAuthProvider(
    baseOptions({
      store,
      fetch: idp.fetchFn,
      expectedIssuer: 'https://corp-as.example.test',
      getIdToken: () => {
        asked += 1
        return ID_TOKEN
      },
    }),
  )
  await provider.saveDiscoveryState(discovery())
  const err = await rejection(() => provider.prepareTokenRequest())
  assert.equal(err.hop, 'discovery')
  assert.equal(asked, 0, 'no ID token was asked for')
  assert.equal(idp.calls.length, 0, 'nothing was sent to the IdP')
  assert.equal(await provider.discoveryState(), undefined, 'the refused discovery was dropped')
})

test('provider: a missing or failing ID token is an IdP-hop error that quotes nothing', async () => {
  const idp = mockIdp(goodExchange)
  const failing = createEnterpriseOAuthProvider(
    baseOptions({
      fetch: idp.fetchFn,
      getIdToken: () => {
        throw new Error(`session expired for token ${ID_TOKEN}`)
      },
    }),
  )
  await failing.saveDiscoveryState(discovery())
  const thrown = await rejection(() => failing.prepareTokenRequest())
  assert.equal(thrown.hop, 'idp')
  assertNoSecrets(thrown.message, 'the error')

  const empty = createEnterpriseOAuthProvider(
    baseOptions({ fetch: idp.fetchFn, getIdToken: () => '' }),
  )
  await empty.saveDiscoveryState(discovery())
  await assert.rejects(() => empty.prepareTokenRequest(), /returned no ID token/)
  assert.equal(idp.calls.length, 0)
})

test('provider: only the access token is stored; the ID token, the ID-JAG and the secrets are not', async () => {
  const idp = mockIdp(goodExchange)
  const store = new MemoryOAuthStore()
  const provider = createEnterpriseOAuthProvider(baseOptions({ store, fetch: idp.fetchFn }))
  await provider.saveDiscoveryState(discovery())
  await provider.prepareTokenRequest()
  await provider.saveTokens({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600 })

  const dump = JSON.stringify([...(store as unknown as { map: Map<string, string> }).map])
  assert.match(dump, /access-1/)
  assertNoSecrets(dump, 'the store')
  // Nor does printing the provider give them away.
  assertNoSecrets(inspect(provider, { depth: 8, showHidden: true }), 'inspect(provider)')
  assertNoSecrets(JSON.stringify(provider), 'JSON.stringify(provider)')
})

test('provider: tokens are stored like the interactive provider stores them (expiry with a skew)', async () => {
  const provider = createEnterpriseOAuthProvider(baseOptions())
  assert.equal(await provider.isAccessTokenExpired(), true)
  assert.equal(await provider.isAuthorized(), false)
  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 })
  assert.equal(await provider.isAccessTokenExpired(), false)
  assert.equal((await provider.tokens())?.access_token, 'a')
  await provider.saveTokens({ access_token: 'b', token_type: 'Bearer', expires_in: 10 })
  assert.equal(await provider.isAccessTokenExpired(), true, 'inside the 30s skew')
  await provider.invalidateCredentials('tokens')
  assert.equal(await provider.tokens(), undefined)
})

// ── the whole flow, over real sockets ─────────────────────────────────────

const AS_CLIENT = 'agent-at-as'
const IDP_CLIENT = 'agent-at-idp'

interface IWorld {
  idp: ILocalIdp
  mcp: ILocalMcp
  store: MemoryOAuthStore
  idTokens: string[]
  provider: (extra?: Record<string, unknown>) => ReturnType<typeof createEnterpriseOAuthProvider>
}

interface IWorldOptions {
  expiresIn?: number
  echoAssertion?: boolean
  publicClient?: boolean
  /** Overrides for the test IdP (e.g. `clientJwks`, `resourceClientId`). */
  idp?: Partial<ILocalIdpOptions>
  /** Overrides for the authorization server's enterprise settings. */
  enterprise?: Partial<NonNullable<ILocalMcpOptions['enterprise']>>
}

const withWorld = async (
  body: (world: IWorld) => Promise<void>,
  opts: IWorldOptions = {},
): Promise<void> => {
  const idp = await startLocalIdp({
    clientId: IDP_CLIENT,
    clientSecret: IDP_SECRET,
    resourceClientId: AS_CLIENT,
    ...opts.idp,
  })
  const mcp = await startLocalMcp({
    requireAuth: true,
    expiresIn: opts.expiresIn,
    enterprise: {
      idpIssuer: idp.issuer,
      jwksUri: idp.jwksUri,
      clientId: AS_CLIENT,
      clientSecret: opts.publicClient ? undefined : AS_SECRET,
      echoAssertion: opts.echoAssertion,
      ...opts.enterprise,
    },
  })
  const store = new MemoryOAuthStore()
  const idTokens: string[] = []
  try {
    await body({
      idp,
      mcp,
      store,
      idTokens,
      provider: (extra = {}) =>
        createEnterpriseOAuthProvider({
          serverUrl: mcp.url,
          clientId: AS_CLIENT,
          clientSecret: AS_SECRET,
          expectedIssuer: mcp.issuer,
          idp: { tokenEndpoint: idp.tokenEndpoint, clientId: IDP_CLIENT, clientSecret: IDP_SECRET },
          getIdToken: () => {
            const token = idp.issueIdToken()
            idTokens.push(token)
            return token
          },
          store,
          ...extra,
        }),
    })
  } finally {
    await mcp.close()
    await idp.close()
  }
}

const collectLogs = () => {
  const lines: string[] = []
  const levels: string[] = []
  return {
    lines,
    levels,
    log: (level: string, message: string) => {
      levels.push(level)
      lines.push(message)
    },
  }
}

const callTool = (tools: Record<string, unknown>, name: string, args: unknown): Promise<unknown> =>
  (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {})

/**
 * Nothing this run touched may hold a token of the exchange, a client assertion
 * or a secret: not the store, not an error, not a log line.
 */
const assertWorldLeaksNothing = (world: IWorld, texts: string[], more: string[] = []): void => {
  const dump = JSON.stringify([...(world.store as unknown as { map: Map<string, string> }).map])
  const assertions = [
    ...world.idp.exchanges.map((e) => e.params.client_assertion),
    ...world.mcp.tokenRequests().map((r) => r.params.client_assertion),
  ].filter((v): v is string => Boolean(v))
  const sensitive = [
    ...world.idTokens,
    ...world.idp.issuedIdJags,
    ...assertions,
    AS_SECRET,
    IDP_SECRET,
    ...more,
  ]
  for (const value of sensitive) {
    // Not even the beginning of one: a clipped token is still its claims.
    for (const needle of value.length > 60 ? [value, value.slice(0, 48)] : [value]) {
      assert.ok(!dump.includes(needle), 'the store holds no token, assertion, key or secret')
      for (const text of texts) {
        assert.ok(
          !text.includes(needle),
          `no token, assertion, key or secret in: ${text.slice(0, 90)}`,
        )
      }
    }
  }
}

test('e2e: IdP → authorization server → MCP server, with no human step', async () => {
  await withWorld(async (world) => {
    const { idp, mcp } = world
    const logs = collectLogs()
    const connected = await connectMcpServers(
      { files: { url: mcp.url, authProvider: world.provider({ scope: 'mcp:tools' }) } },
      logs.log as never,
      'agent-test',
    )
    try {
      assert.deepEqual(connected.results, [{ name: 'files', connected: true }])
      const out = await callTool(connected.tools, 'files__echo', { text: 'hello' })
      assert.match(JSON.stringify(out), /echo:hello/)
      assert.deepEqual(mcp.calls, [{ name: 'echo', args: { text: 'hello' } }])
    } finally {
      await connected.close()
    }

    // Hop 1, as the IdP received it.
    assert.equal(idp.exchanges.length, 1)
    const exchange = idp.exchanges[0]
    assert.equal(exchange.status, 200)
    assert.equal(exchange.authMethod, 'basic')
    assert.equal(exchange.params.grant_type, TOKEN_EXCHANGE_GRANT)
    assert.equal(exchange.params.requested_token_type, ID_JAG_TOKEN_TYPE)
    assert.equal(exchange.params.subject_token_type, ID_TOKEN_TOKEN_TYPE)
    assert.equal(exchange.params.audience, mcp.issuer, 'audience = the issuer discovery found')
    assert.equal(exchange.params.resource, mcp.url, 'resource = this MCP server')
    assert.equal(exchange.params.scope, 'mcp:tools')
    assert.equal(exchange.params.subject_token, world.idTokens[0])

    // Hop 2, as the authorization server received it.
    const grants = mcp.tokenRequests()
    assert.equal(grants.length, 1)
    assert.equal(grants[0].params.grant_type, JWT_BEARER_GRANT)
    assert.equal(grants[0].params.assertion, idp.issuedIdJags[0])
    assert.equal(grants[0].authMethod, 'basic')
    assert.equal(grants[0].error, undefined)
    assert.equal(mcp.registrations(), 0, 'a pre-registered client never registers')
    // The extension is declared by the client that uses it.
    assert.deepEqual(mcp.initializeCapabilities[0].extensions, {
      [ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION]: {},
    })

    assertWorldLeaksNothing(world, logs.lines)
  })
})

const TOOL = 'files__echo'
const agentScript = (req: IChatRequest): IScriptedReply => {
  const system = req.messages.find((m) => m.role === 'system')?.content
  const prompt = typeof system === 'string' ? system : JSON.stringify(system ?? '')
  if (prompt.includes('You are the Planner')) {
    return {
      text: JSON.stringify({
        thought: 'Echo the text through the MCP server.',
        steps: [
          {
            id: 's1',
            description: 'Echo the text',
            expectedOutcome: 'The server echoed the text back',
            suggestedTools: [TOOL],
          },
        ],
      }),
    }
  }
  if (prompt.includes('You are the Replanner')) {
    return { text: JSON.stringify({ mode: 'finish', reason: 'The step succeeded.' }) }
  }
  if (prompt.includes('You are the Synthesizer')) return { text: 'Echoed: hello' }
  if (hasToolResult(req)) return { text: 'Called the echo tool and got the text back.' }
  return { toolCalls: [{ name: TOOL, args: { text: 'hello' } }] }
}

test('e2e: a full agent run through the enterprise flow; a token that dies mid-run is re-obtained', async () => {
  await withWorld(async (world) => {
    const { idp, mcp } = world
    const llm = await startLocalOpenAI(agentScript)
    let agent: IAgent | undefined
    try {
      agent = (await createAgent({
        clientName: 'agent-enterprise-test',
        providerType: 'openai-compatible',
        baseURL: llm.baseURL,
        apiKey: 'not-a-real-key',
        model: 'scripted',
        mcpServers: { files: { url: mcp.url, authProvider: world.provider() } },
        maxIterations: 3,
        maxStepsPerTask: 4,
        logLevel: 'none',
      } as never)) as IAgent
      assert.equal(agent.listTools().length, 3, 'the tools arrived without anyone authorizing')
      assert.equal(idp.exchanges.length, 1)

      // The access token stops working after the connection is up.
      mcp.validTokens.clear()
      const result = await agent.run({ input: 'Echo "hello" for me' })
      assert.equal(result.text, 'Echoed: hello')
      assert.deepEqual(mcp.calls, [{ name: 'echo', args: { text: 'hello' } }])
      assert.equal(idp.exchanges.length, 2, 'a fresh ID-JAG was requested')
      assert.equal(world.idTokens.length, 2, 'from a fresh ID token')
      assert.deepEqual(mcp.grants(), [JWT_BEARER_GRANT, JWT_BEARER_GRANT])
      assert.notEqual(idp.issuedIdJags[0], idp.issuedIdJags[1])
    } finally {
      await agent?.close().catch(() => {})
      await llm.close()
    }
  })
})

test('e2e: an expired access token triggers a fresh exchange before the first request', async () => {
  await withWorld(
    async (world) => {
      const { idp, mcp } = world
      const provider = world.provider()
      const first = await connectMcpServers(
        { files: { url: mcp.url, authProvider: provider } },
        (() => {}) as never,
        'agent-test',
      )
      await first.close()
      assert.equal(idp.exchanges.length, 1)
      // Issued for one second: already inside the skew window.
      assert.equal(await provider.isAccessTokenExpired(), true)

      const second = await connectMcpServers(
        { files: { url: mcp.url, authProvider: provider } },
        (() => {}) as never,
        'agent-test',
      )
      try {
        assert.deepEqual(second.results, [{ name: 'files', connected: true }])
        assert.equal(idp.exchanges.length, 2, 'one new exchange, not a guaranteed 401 first')
        assert.equal(mcp.tokenRequests().length, 2)
        await callTool(second.tools, 'files__echo', { text: 'again' })
      } finally {
        await second.close()
      }
    },
    { expiresIn: 1 },
  )
})

/** Connect expecting failure; returns the one result and everything logged. */
const failToConnect = async (world: IWorld, provider = world.provider()) => {
  const logs = collectLogs()
  const connected = await connectMcpServers(
    { files: { url: world.mcp.url, authProvider: provider } },
    logs.log as never,
    'agent-test',
  )
  await connected.close()
  const [result] = connected.results
  assert.equal(result.connected, false)
  assert.equal(Object.keys(connected.tools).length, 0)
  return { error: result.error ?? '', logs: logs.lines }
}

test('e2e: an ID-JAG for the wrong audience is refused by the authorization server', async () => {
  await withWorld(async (world) => {
    const { idp, mcp } = world
    idp.misbehave.audience = 'https://another-as.example.test'
    const { error, logs } = await failToConnect(world)

    // Short and safe for whoever shows it; the server's words go to the log.
    assert.equal(
      error,
      'MCP authorization server refused the ID-JAG grant: invalid_grant (HTTP 400)',
    )
    assert.ok(logs.some((l) => /Audience validation failed/.test(l)))
    assert.deepEqual(
      mcp.tokenRequests().map((r) => r.error),
      ['invalid_grant: Audience validation failed'],
      'one grant, refused once: a final refusal is not retried',
    )
    assert.equal(idp.exchanges.length, 1)
    assert.equal(mcp.validTokens.size, 0, 'no access token was issued')
    assert.equal(await world.provider().tokens(), undefined)
    assertWorldLeaksNothing(world, [error, ...logs])

    // The typed error, straight from the provider.
    const err = await rejection(() => world.provider().authorize())
    assert.equal(err.hop, 'authorization-server')
    assert.equal(err.code, 'invalid_grant')
  })
})

test('e2e: an expired ID-JAG is refused by the authorization server', async () => {
  await withWorld(async (world) => {
    world.idp.misbehave.expired = true
    const { error, logs } = await failToConnect(world)
    assert.match(error, /MCP authorization server refused the ID-JAG grant: invalid_grant/)
    assert.ok(logs.some((l) => /Assertion has expired/.test(l)))
    assert.equal(world.mcp.validTokens.size, 0)
    assertWorldLeaksNothing(world, [error, ...logs])
  })
})

test('e2e: a wrong issued_token_type is refused before the authorization server is contacted', async () => {
  await withWorld(async (world) => {
    const { idp, mcp } = world
    idp.misbehave.issuedTokenType = 'urn:ietf:params:oauth:token-type:access_token'
    const { error, logs } = await failToConnect(world)

    assert.match(error, /Enterprise IdP token exchange failed/)
    assert.match(error, /where an ID-JAG .* was requested/)
    assert.equal(idp.exchanges.length, 1, 'a final refusal is not retried')
    assert.equal(idp.issuedIdJags.length, 1, 'the IdP did hand over a token')
    assert.equal(mcp.tokenRequests().length, 0, 'the authorization server saw no request')
    assertWorldLeaksNothing(world, [error, ...logs])
  })
})

test('e2e: an answer without a token never reaches the authorization server', async () => {
  await withWorld(async (world) => {
    world.idp.misbehave.omitToken = true
    const { error } = await failToConnect(world)
    assert.match(error, /returned no ID-JAG/)
    assert.equal(world.mcp.tokenRequests().length, 0)
  })
})

test('e2e: the IdP rejecting the client, or denying by policy, names the IdP hop', async () => {
  await withWorld(async (world) => {
    const { idp, mcp } = world
    idp.misbehave.rejectClient = true
    const rejected = await failToConnect(world)
    assert.match(
      rejected.error,
      /Enterprise IdP token exchange failed: the identity provider answered 401 invalid_client - Client authentication failed/,
    )
    assertWorldLeaksNothing(world, [rejected.error, ...rejected.logs])

    idp.misbehave.rejectClient = false
    idp.misbehave.deny = 'The user is not assigned to this application'
    const denied = await failToConnect(world)
    assert.match(denied.error, /400 access_denied - The user is not assigned to this application/)

    // A wrong secret is caught by the IdP itself, not only by the switch above.
    idp.misbehave.deny = undefined
    const wrong = await failToConnect(
      world,
      world.provider({
        idp: { tokenEndpoint: idp.tokenEndpoint, clientId: IDP_CLIENT, clientSecret: 'nope' },
      }),
    )
    assert.match(wrong.error, /401 invalid_client/)
    assert.equal(mcp.tokenRequests().length, 0, 'the authorization server saw no request')
  })
})

test('e2e: an IdP that echoes the request leaks nothing through the error', async () => {
  await withWorld(async (world) => {
    world.idp.misbehave.echoRequest = true
    const { error, logs } = await failToConnect(world)
    assert.match(error, /400 invalid_request/)
    assert.match(error, /\[redacted\]/)
    assertWorldLeaksNothing(world, [error, ...logs])
  })
})

test('e2e: a redirect from the IdP token endpoint is not followed', async () => {
  const seen: string[] = []
  const sink = createServer((req, res) => {
    seen.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        issued_token_type: ID_JAG_TOKEN_TYPE,
        access_token: 'x',
        token_type: 'N_A',
      }),
    )
  })
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
  try {
    await withWorld(async (world) => {
      world.idp.misbehave.redirectTo = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/collect`
      const { error } = await failToConnect(world)
      assert.match(error, /Enterprise IdP token exchange failed: the request did not complete/)
      assert.deepEqual(seen, [], 'the ID token and the client secret went nowhere else')
      assert.equal(world.mcp.tokenRequests().length, 0)
    })
  } finally {
    sink.closeAllConnections()
    await new Promise<void>((resolve) => sink.close(() => resolve()))
  }
})

test('e2e: an authorization server other than the expected one receives nothing', async () => {
  await withWorld(async (world) => {
    const { idp, mcp } = world
    const { error, logs } = await failToConnect(
      world,
      world.provider({ expectedIssuer: 'https://corp-as.example.test' }),
    )
    assert.match(error, /corp-as\.example\.test/)
    assert.equal(world.idTokens.length, 0, 'no ID token was asked for')
    assert.equal(idp.exchanges.length, 0, 'nothing was sent to the IdP')
    assert.equal(mcp.tokenRequests().length, 0, 'nothing was sent to the authorization server')
    assertWorldLeaksNothing(world, [error, ...logs])
  })
})

test('e2e: a wrong client secret at the authorization server names that hop and leaks nothing', async () => {
  await withWorld(async (world) => {
    const wrongSecret = 'wrong-as-secret-55aa'
    const { error, logs } = await failToConnect(
      world,
      world.provider({ clientSecret: wrongSecret }),
    )
    assert.equal(
      error,
      'MCP authorization server refused the ID-JAG grant: invalid_client (HTTP 401)',
    )
    assert.ok(logs.some((l) => /Client authentication failed/.test(l)))
    assert.ok(![error, ...logs].some((t) => t.includes(wrongSecret)))
    assertWorldLeaksNothing(world, [error, ...logs])
  })
})

test('e2e: an authorization server that echoes the grant leaks nothing through the error', async () => {
  await withWorld(
    async (world) => {
      const { error, logs } = await failToConnect(world)
      assert.equal(
        error,
        'MCP authorization server refused the ID-JAG grant: invalid_request (HTTP 400)',
      )
      // The server quoted the whole request; the log line has it cut out.
      assert.ok(logs.some((l) => /cannot accept/.test(l) && /\[redacted\]/.test(l)))
      assert.equal(world.idp.issuedIdJags.length, 1)
      assertWorldLeaksNothing(world, [error, ...logs])
    },
    { echoAssertion: true },
  )
})

test('e2e: a public client with no secret and no expectedIssuer gets a token on the ID-JAG alone', async () => {
  await withWorld(
    async (world) => {
      const { idp, mcp } = world
      const connected = await connectMcpServers(
        {
          files: {
            url: mcp.url,
            authProvider: world.provider({ clientSecret: undefined, expectedIssuer: undefined }),
          },
        },
        (() => {}) as never,
        'agent-test',
      )
      try {
        assert.deepEqual(connected.results, [{ name: 'files', connected: true }])
        await callTool(connected.tools, 'files__echo', { text: 'public' })
      } finally {
        await connected.close()
      }
      const [grant] = mcp.tokenRequests()
      assert.equal(grant.authMethod, 'none')
      assert.equal(grant.params.client_id, AS_CLIENT)
      assert.equal(grant.params.client_secret, undefined)
      assert.equal(grant.error, undefined)
      // Still addressed to the server discovery found, and to nothing else.
      assert.equal(idp.exchanges[0].params.audience, mcp.issuer)
    },
    { publicClient: true },
  )
})

// ── private_key_jwt (RFC 7523 section 2.2, audience per rfc7523bis) ───────

const EC_KEY = generateClientKey('ES256', 'ec-key-1')
const RSA_KEY = generateClientKey('RSA', 'rsa-key-1')
const IDP_ISSUER = 'https://idp.example.test'

/** The private parts of a key, in every spelling a leak could take. */
const keyMaterial = (key: ReturnType<typeof generateClientKey>): string[] => [
  key.privatePem,
  key.privatePem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
  ...['d', 'p', 'q', 'dp', 'dq', 'qi']
    .map((m) => (key.privateJwk as Record<string, unknown>)[m])
    .filter((v): v is string => typeof v === 'string'),
]

const jwtOptions = (extra: Record<string, unknown> = {}) =>
  baseOptions({
    clientSecret: undefined,
    clientAuthMethod: 'private_key_jwt',
    privateKey: EC_KEY.privateJwk,
    algorithm: 'ES256',
    keyId: EC_KEY.kid,
    ...extra,
  })

test('private_key_jwt: what the options must hold, said when the provider is built', () => {
  createEnterpriseOAuthProvider(jwtOptions())
  // The audience of a signed assertion must not come from the MCP server alone.
  assert.throws(
    () => createEnterpriseOAuthProvider(jwtOptions({ expectedIssuer: undefined })),
    /private_key_jwt needs expectedIssuer/,
  )
  assert.throws(
    () => createEnterpriseOAuthProvider(jwtOptions({ privateKey: undefined })),
    /needs privateKey and an algorithm/,
  )
  assert.throws(
    () => createEnterpriseOAuthProvider(jwtOptions({ algorithm: 'HS256' })),
    /needs privateKey and an algorithm/,
  )
  assert.throws(
    () => createEnterpriseOAuthProvider(jwtOptions({ clientSecret: AS_SECRET })),
    /clientSecret is not used with clientAuthMethod 'private_key_jwt'/,
  )
  // A key nobody asked to use is a mistake, not something to ignore quietly.
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions({ privateKey: EC_KEY.privateJwk })),
    /privateKey is only used with/,
  )
  assert.throws(
    () =>
      createEnterpriseOAuthProvider(
        baseOptions({ clientSecret: undefined, clientAuthMethod: 'client_secret_post' }),
      ),
    /needs clientSecret/,
  )
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions({ clientAuthMethod: 'none' })),
    /clientSecret is not used with clientAuthMethod 'none'/,
  )

  // The same at the IdP, where the audience is its issuer and has to be given.
  const idp = (extra: Record<string, unknown>) => ({
    idp: {
      tokenEndpoint: IDP_TOKEN_URL,
      clientId: 'agent-at-idp',
      clientAuthMethod: 'private_key_jwt',
      privateKey: RSA_KEY.privatePem,
      algorithm: 'RS256',
      issuer: IDP_ISSUER,
      ...extra,
    },
  })
  createEnterpriseOAuthProvider(baseOptions(idp({})))
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions(idp({ issuer: undefined }))),
    /needs idp\.issuer/,
  )
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions(idp({ issuer: 'http://idp.example.test' }))),
    /Enterprise IdP issuer: requires https/,
  )
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions(idp({ algorithm: undefined }))),
    /needs idp\.privateKey and an idp\.algorithm/,
  )
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions(idp({ clientSecret: IDP_SECRET }))),
    /idp\.clientSecret is not used/,
  )
  assert.throws(
    () =>
      createEnterpriseOAuthProvider(
        baseOptions({
          idp: {
            tokenEndpoint: IDP_TOKEN_URL,
            clientId: 'agent-at-idp',
            clientSecret: IDP_SECRET,
            privateKey: RSA_KEY.privatePem,
          },
        }),
      ),
    /idp\.privateKey is only used with/,
  )
})

test('client assertion: the claims rfc7523bis asks for, short-lived, a new jti every time', async () => {
  const make = () =>
    createClientAssertion({
      clientId: 'agent-at-as',
      audience: AS_URL,
      privateKey: EC_KEY.privateJwk,
      algorithm: 'ES256',
      keyId: EC_KEY.kid,
    })
  const before = Math.floor(Date.now() / 1000)
  const first = await make()
  const second = await make()
  const verified = verifyJwt(first, { keys: [EC_KEY.publicJwk] })
  assert.ok(verified, 'signed by the key')
  assert.deepEqual(verified.header, {
    alg: 'ES256',
    typ: 'client-authentication+jwt',
    kid: EC_KEY.kid,
  })
  const { payload } = verified
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sub'])
  assert.equal(payload.iss, 'agent-at-as')
  assert.equal(payload.sub, 'agent-at-as')
  // The issuer identifier as the SOLE audience: a string, not a list, not a token endpoint.
  assert.equal(payload.aud, AS_URL)
  assert.ok((payload.iat as number) >= before && (payload.iat as number) <= before + 2)
  assert.equal((payload.exp as number) - (payload.iat as number), 60, 'one minute, no more')
  assert.match(String(payload.jti), /^[0-9a-f-]{36}$/)
  assert.notEqual(payload.jti, peekJwt(second).payload.jti, 'unique per request')
  // No kid when none was given.
  const bare = await createClientAssertion({
    clientId: 'c',
    audience: AS_URL,
    privateKey: EC_KEY.privateJwk,
    algorithm: 'ES256',
  })
  assert.equal('kid' in peekJwt(bare).header, false)
})

test('client assertion: every algorithm verifies, from a JWK, a PEM and a KeyObject', async () => {
  const { createPrivateKey } = await import('node:crypto')
  const keys: Record<string, ReturnType<typeof generateClientKey>> = {
    ES256: EC_KEY,
    ES384: generateClientKey('ES384'),
    ES512: generateClientKey('ES512'),
    RSA: RSA_KEY,
  }
  const algorithms: EnterpriseAssertionAlgorithm[] = [
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
  for (const algorithm of algorithms) {
    const key = keys[algorithm.startsWith('ES') ? algorithm : 'RSA']
    for (const privateKey of [key.privateJwk, key.privatePem, createPrivateKey(key.privatePem)]) {
      const jwt = await createClientAssertion({
        clientId: 'c',
        audience: AS_URL,
        privateKey,
        algorithm,
        keyId: key.kid,
      })
      const verified = verifyJwt(jwt, { keys: [key.publicJwk] })
      assert.ok(verified, `${algorithm} verifies`)
      assert.equal(verified.header.alg, algorithm)
    }
  }
})

test('client assertion: a key that does not fit, or is broken, fails without describing the key', async () => {
  const cases: [EnterpriseAssertionAlgorithm, unknown, string[]][] = [
    // An RSA key would sign anything: it must not sign under an EC name.
    ['ES256', RSA_KEY.privateJwk, keyMaterial(RSA_KEY)],
    ['RS256', EC_KEY.privatePem, keyMaterial(EC_KEY)],
    ['ES384', EC_KEY.privateJwk, keyMaterial(EC_KEY)],
    ['ES256', EC_KEY.publicJwk, []],
    [
      'ES256',
      '-----BEGIN PRIVATE KEY-----\nTUFSS0VSLWluLWEtYnJva2VuLWtleQ==\n-----END PRIVATE KEY-----',
      ['TUFSS0VSLWluLWEtYnJva2VuLWtleQ=='],
    ],
    [
      'ES256',
      { kty: 'EC', crv: 'P-256', d: 'bWFya2VyLWluLWEtYnJva2VuLWp3aw', x: 'AA', y: 'AA' },
      ['bWFya2VyLWluLWEtYnJva2VuLWp3aw'],
    ],
  ]
  for (const [algorithm, privateKey, material] of cases) {
    await assert.rejects(
      () =>
        createClientAssertion({
          clientId: 'c',
          audience: AS_URL,
          privateKey: privateKey as never,
          algorithm,
        }),
      (err: Error) => {
        assert.equal(
          err.message,
          `Enterprise MCP authorization: could not sign the client assertion with ${algorithm}; check that privateKey is a private key for that algorithm`,
        )
        for (const secret of material) assert.ok(!err.message.includes(secret))
        return true
      },
    )
  }
})

test('requestIdJag: private_key_jwt sends the assertion and no other credential', async () => {
  const idp = mockIdp(goodExchange)
  const clientAssertion = 'eyJhbGciOiJFUzI1NiJ9.Y2xpZW50LWFzc2VydGlvbg.c2lnbmF0dXJl'
  const pkjwt = {
    tokenEndpoint: IDP_TOKEN_URL,
    clientId: 'agent-at-idp',
    clientAuthMethod: 'private_key_jwt' as const,
    privateKey: EC_KEY.privateJwk,
    algorithm: 'ES256' as const,
    issuer: IDP_ISSUER,
  }
  await exchange(idp.fetchFn, { idp: pkjwt, clientAssertion })
  const [call] = idp.calls
  assert.equal(call.params.get('client_assertion_type'), CLIENT_ASSERTION_TYPE)
  assert.equal(call.params.get('client_assertion'), clientAssertion)
  assert.equal(call.params.has('client_secret'), false)
  assert.equal(call.headers.get('authorization'), null)

  // Echoed back by a careless IdP, the assertion is cut out like the ID token.
  const echo = mockIdp(() =>
    jsonResponse(
      { error: 'invalid_client', error_description: `bad client_assertion=${clientAssertion}` },
      401,
    ),
  )
  const err = await rejection(() => exchange(echo.fetchFn, { idp: pkjwt, clientAssertion }))
  assert.ok(!err.message.includes(clientAssertion))
  assert.match(err.message, /\[redacted\]/)
  // Nor does the key itself survive in an error, should anything ever quote it.
  const quoting = async (): Promise<Response> => {
    throw new Error(`debug dump: ${JSON.stringify(EC_KEY.privateJwk)}`)
  }
  const quoted = await rejection(() => exchange(quoting, { idp: pkjwt, clientAssertion }))
  for (const secret of keyMaterial(EC_KEY).filter((v) => v.length < 60)) {
    assert.ok(!quoted.message.includes(secret), 'no private member of the key')
  }
  // Without an assertion nothing is sent at all.
  const silent = mockIdp(goodExchange)
  await assert.rejects(() => exchange(silent.fetchFn, { idp: pkjwt }), /no client assertion/)
  assert.equal(silent.calls.length, 0)
})

test('provider: a private key is never printed, serialized or stored', async () => {
  const idp = mockIdp(goodExchange)
  const store = new MemoryOAuthStore()
  const provider = createEnterpriseOAuthProvider(
    jwtOptions({
      store,
      fetch: idp.fetchFn,
      privateKey: RSA_KEY.privatePem,
      algorithm: 'RS256',
      keyId: RSA_KEY.kid,
      idp: {
        tokenEndpoint: IDP_TOKEN_URL,
        clientId: 'agent-at-idp',
        clientAuthMethod: 'private_key_jwt',
        privateKey: EC_KEY.privateJwk,
        algorithm: 'ES256',
        issuer: IDP_ISSUER,
      },
    }),
  )
  await provider.saveDiscoveryState(discovery())
  await provider.prepareTokenRequest()
  const headers = new Headers()
  const params = new URLSearchParams()
  await provider.addClientAuthentication?.(headers, params, `${AS_URL}/token`, undefined)
  const forAs = params.get('client_assertion') ?? ''
  const forIdp = idp.calls[0].params.get('client_assertion') ?? ''

  // One assertion per server, each for that server's issuer and no other.
  assert.equal(peekJwt(forIdp).payload.aud, IDP_ISSUER)
  assert.equal(peekJwt(forIdp).payload.iss, 'agent-at-idp')
  assert.equal(peekJwt(forAs).payload.aud, AS_URL)
  assert.equal(peekJwt(forAs).payload.iss, 'agent-at-as')
  assert.ok(verifyJwt(forIdp, { keys: [EC_KEY.publicJwk] }))
  assert.ok(verifyJwt(forAs, { keys: [RSA_KEY.publicJwk] }))
  assert.equal(params.has('client_secret'), false)
  assert.equal(headers.get('authorization'), null)

  const secrets = [...keyMaterial(EC_KEY), ...keyMaterial(RSA_KEY), forAs, forIdp, ID_TOKEN, ID_JAG]
  const views = {
    inspect: inspect(provider, { depth: 8, showHidden: true }),
    json: JSON.stringify(provider),
    keys: JSON.stringify(Object.getOwnPropertyNames(provider)),
    store: JSON.stringify([...(store as unknown as { map: Map<string, string> }).map]),
  }
  for (const [name, text] of Object.entries(views)) {
    for (const secret of secrets) assert.ok(!text.includes(secret), `${name} holds no key or token`)
  }
})

test('provider: the assertion for the authorization server is refused when discovery is not the expected issuer', async () => {
  const provider = createEnterpriseOAuthProvider(jwtOptions())
  // Discovery now says another authorization server: no assertion is signed for it.
  await provider.saveDiscoveryState(
    discovery(
      { authorizationServerUrl: 'https://evil.example.test/' },
      { issuer: 'https://evil.example.test', token_endpoint: 'https://evil.example.test/token' },
    ),
  )
  const params = new URLSearchParams()
  await assert.rejects(
    () =>
      Promise.resolve(
        provider.addClientAuthentication?.(
          new Headers(),
          params,
          'https://evil.example.test/token',
        ),
      ),
    /expected "https:\/\/as\.example\.test"; refusing to send credentials/,
  )
  assert.equal(params.has('client_assertion'), false)
})

// ── the RFC 7523 form of the assertion: assertionAudience / assertionType ─

const IDP_JWT = {
  tokenEndpoint: IDP_TOKEN_URL,
  clientId: 'agent-at-idp',
  clientAuthMethod: 'private_key_jwt',
  privateKey: RSA_KEY.privatePem,
  algorithm: 'RS256',
  issuer: IDP_ISSUER,
}

/** The two assertions a provider makes, against a mock IdP and the stored discovery. */
const assertionsOf = async (
  extra: Record<string, unknown>,
  state: unknown = discovery(),
): Promise<{ forIdp: ReturnType<typeof peekJwt>; forAs: ReturnType<typeof peekJwt> }> => {
  const idp = mockIdp(goodExchange)
  const provider = createEnterpriseOAuthProvider(jwtOptions({ fetch: idp.fetchFn, ...extra }))
  await provider.saveDiscoveryState(state as never)
  await provider.prepareTokenRequest()
  const params = new URLSearchParams()
  await provider.addClientAuthentication?.(new Headers(), params, `${AS_URL}/token`)
  return {
    forIdp: peekJwt(idp.calls[0].params.get('client_assertion') ?? ''),
    forAs: peekJwt(params.get('client_assertion') ?? ''),
  }
}

test('assertionAudience / assertionType: what the options may hold, said when the provider is built', () => {
  createEnterpriseOAuthProvider(
    jwtOptions({ assertionAudience: 'token-endpoint', assertionType: 'JWT' }),
  )
  createEnterpriseOAuthProvider(
    jwtOptions({ assertionAudience: 'issuer', assertionType: 'client-authentication+jwt' }),
  )
  // A value that is not one of the two is not read as the default.
  assert.throws(
    () => createEnterpriseOAuthProvider(jwtOptions({ assertionAudience: 'token_endpoint' })),
    /assertionAudience must be 'issuer' or 'token-endpoint'/,
  )
  assert.throws(
    () => createEnterpriseOAuthProvider(jwtOptions({ assertionType: 'jwt' })),
    /assertionType must be 'client-authentication\+jwt' or 'JWT'/,
  )
  assert.throws(
    () =>
      createEnterpriseOAuthProvider(
        baseOptions({ idp: { ...IDP_JWT, assertionAudience: 'endpoint' } }),
      ),
    /idp\.assertionAudience must be/,
  )
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions({ idp: { ...IDP_JWT, assertionType: 'jws' } })),
    /idp\.assertionType must be/,
  )
  // Where no assertion is signed, the options mean nothing: say so.
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions({ assertionAudience: 'token-endpoint' })),
    /assertionAudience and assertionType are only used with clientAuthMethod 'private_key_jwt'/,
  )
  assert.throws(
    () =>
      createEnterpriseOAuthProvider(
        baseOptions({
          idp: {
            tokenEndpoint: IDP_TOKEN_URL,
            clientId: 'agent-at-idp',
            clientSecret: IDP_SECRET,
            assertionType: 'JWT',
          },
        }),
      ),
    /idp\.assertionAudience and idp\.assertionType are only used with idp\.clientAuthMethod/,
  )
  // The token endpoint still needs expectedIssuer: it comes from the same metadata.
  assert.throws(
    () =>
      createEnterpriseOAuthProvider(
        jwtOptions({ assertionAudience: 'token-endpoint', expectedIssuer: undefined }),
      ),
    /private_key_jwt needs expectedIssuer/,
  )

  // At the IdP the token endpoint is configuration, so its issuer is not needed...
  createEnterpriseOAuthProvider(
    baseOptions({
      idp: { ...IDP_JWT, issuer: undefined, assertionAudience: 'token-endpoint' },
    }),
  )
  // ...and it still is with the default audience, said or left out.
  for (const assertionAudience of [undefined, 'issuer']) {
    assert.throws(
      () =>
        createEnterpriseOAuthProvider(
          baseOptions({ idp: { ...IDP_JWT, issuer: undefined, assertionAudience } }),
        ),
      /needs idp\.issuer/,
    )
  }
})

test('assertionAudience: each hop is addressed as configured, independently of the other', async () => {
  // The defaults, and the defaults said out loud: the issuer on both hops.
  for (const said of [{}, { assertionAudience: 'issuer' }]) {
    const { forIdp, forAs } = await assertionsOf({ ...said, idp: { ...IDP_JWT, ...said } })
    assert.equal(forAs.payload.aud, AS_URL)
    assert.equal(forIdp.payload.aud, IDP_ISSUER)
  }
  // Only the authorization server's.
  const asOnly = await assertionsOf({ assertionAudience: 'token-endpoint', idp: IDP_JWT })
  assert.equal(asOnly.forAs.payload.aud, `${AS_URL}/token`, 'the discovered token endpoint')
  assert.equal(asOnly.forIdp.payload.aud, IDP_ISSUER)
  // Only the IdP's - and without idp.issuer at all.
  const idpOnly = await assertionsOf({
    idp: { ...IDP_JWT, issuer: undefined, assertionAudience: 'token-endpoint' },
  })
  assert.equal(idpOnly.forIdp.payload.aud, IDP_TOKEN_URL, 'the configured token endpoint')
  assert.equal(idpOnly.forAs.payload.aud, AS_URL)
  // The token endpoint is what the metadata says, not a guess from the issuer.
  const elsewhere = await assertionsOf(
    { assertionAudience: 'token-endpoint', idp: IDP_JWT },
    discovery({}, { token_endpoint: `${AS_URL}/oauth2/v1/token` }),
  )
  assert.equal(elsewhere.forAs.payload.aud, `${AS_URL}/oauth2/v1/token`)
  // Everything else about the assertion is unchanged.
  for (const { payload } of [asOnly.forAs, idpOnly.forIdp]) {
    assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sub'])
    assert.equal(typeof payload.aud, 'string', 'one audience, not a list')
    assert.equal((payload.exp as number) - (payload.iat as number), 60)
  }
})

test('assertionType: the typ header of each hop is the one configured', async () => {
  const defaults = await assertionsOf({ idp: IDP_JWT })
  assert.equal(defaults.forAs.header.typ, 'client-authentication+jwt')
  assert.equal(defaults.forIdp.header.typ, 'client-authentication+jwt')
  const said = await assertionsOf({
    assertionType: 'client-authentication+jwt',
    idp: { ...IDP_JWT, assertionType: 'client-authentication+jwt' },
  })
  assert.equal(said.forAs.header.typ, 'client-authentication+jwt')
  assert.equal(said.forIdp.header.typ, 'client-authentication+jwt')
  const asOnly = await assertionsOf({ assertionType: 'JWT', idp: IDP_JWT })
  assert.equal(asOnly.forAs.header.typ, 'JWT')
  assert.equal(asOnly.forIdp.header.typ, 'client-authentication+jwt')
  const idpOnly = await assertionsOf({ idp: { ...IDP_JWT, assertionType: 'JWT' } })
  assert.equal(idpOnly.forIdp.header.typ, 'JWT')
  assert.equal(idpOnly.forAs.header.typ, 'client-authentication+jwt')
  // The type does not move the audience, nor the audience the type.
  assert.equal(asOnly.forAs.payload.aud, AS_URL)
  const audienceOnly = await assertionsOf({ assertionAudience: 'token-endpoint', idp: IDP_JWT })
  assert.equal(audienceOnly.forAs.header.typ, 'client-authentication+jwt')
})

test('assertionAudience token-endpoint: expectedIssuer still gates the audience; a bad endpoint is refused', async () => {
  const sign = async (state: unknown) => {
    const provider = createEnterpriseOAuthProvider(
      jwtOptions({ assertionAudience: 'token-endpoint', assertionType: 'JWT' }),
    )
    await provider.saveDiscoveryState(state as never)
    const params = new URLSearchParams()
    const outcome = await Promise.resolve(
      provider.addClientAuthentication?.(new Headers(), params, 'https://evil.example.test/token'),
    ).then(
      () => undefined,
      (err: Error) => err,
    )
    return { outcome, params }
  }
  // Another authorization server, with a perfectly good token endpoint of its
  // own: no assertion is signed for it.
  const evil = await sign(
    discovery(
      { authorizationServerUrl: 'https://evil.example.test/' },
      { issuer: 'https://evil.example.test', token_endpoint: 'https://evil.example.test/token' },
    ),
  )
  assert.match(
    String(evil.outcome?.message),
    /expected "https:\/\/as\.example\.test"; refusing to send credentials/,
  )
  assert.equal(evil.params.has('client_assertion'), false)
  // The expected issuer's own metadata, naming a plaintext token endpoint.
  const plaintext = await sign(discovery({}, { token_endpoint: 'http://as.example.test/token' }))
  assert.match(String(plaintext.outcome?.message), /token endpoint: requires https/)
  assert.equal(plaintext.params.has('client_assertion'), false)
  // No token endpoint in the metadata: nothing to address, and nothing guessed.
  const none = await sign(discovery({}, { token_endpoint: undefined }))
  assert.ok(none.outcome instanceof EnterpriseOAuthError)
  assert.equal(none.outcome.hop, 'discovery')
  assert.match(none.outcome.message, /published no token endpoint/)
  assert.equal(none.params.has('client_assertion'), false)
})

// ── CIMD as the client id ─────────────────────────────────────────────────

const CIMD_URL = 'https://client.example.test/oauth/client.json'

test('CIMD: a clientId that is a URL must be an https document URL, and takes no secret', () => {
  for (const clientId of [
    'http://client.example.test/oauth/client.json',
    'https://client.example.test/',
    'https://client.example.test',
    'ftp://client.example.test/client.json',
  ]) {
    assert.throws(
      () => createEnterpriseOAuthProvider(baseOptions({ clientId, clientSecret: undefined })),
      /client ID metadata document: it requires https and a non-root path/,
      clientId,
    )
  }
  // A document anyone can read establishes no shared secret.
  assert.throws(
    () => createEnterpriseOAuthProvider(baseOptions({ clientId: CIMD_URL })),
    /cannot be used with clientSecret/,
  )
  createEnterpriseOAuthProvider(jwtOptions({ clientId: CIMD_URL }))
  createEnterpriseOAuthProvider(baseOptions({ clientId: CIMD_URL, clientSecret: undefined }))
  // An ordinary identifier is not a URL and is left alone.
  createEnterpriseOAuthProvider(baseOptions({ clientId: 'urn:example:agent' }))
})

// ── private_key_jwt and CIMD, over real sockets ───────────────────────────

const postForm = async (url: string, params: Record<string, string>) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  return { status: res.status, body: (await res.json()) as Record<string, string> }
}

test('e2e: private_key_jwt on both hops, each assertion for its own server only', async () => {
  await withWorld(
    async (world) => {
      const { idp, mcp } = world
      const logs = collectLogs()
      const provider = world.provider({
        clientSecret: undefined,
        clientAuthMethod: 'private_key_jwt',
        privateKey: RSA_KEY.privatePem,
        algorithm: 'RS256',
        keyId: RSA_KEY.kid,
        idp: {
          tokenEndpoint: idp.tokenEndpoint,
          issuer: idp.issuer,
          clientId: IDP_CLIENT,
          clientAuthMethod: 'private_key_jwt',
          privateKey: EC_KEY.privateJwk,
          algorithm: 'ES256',
          keyId: EC_KEY.kid,
        },
      })
      const connected = await connectMcpServers(
        { files: { url: mcp.url, authProvider: provider } },
        logs.log as never,
        'agent-test',
      )
      try {
        assert.deepEqual(connected.results, [{ name: 'files', connected: true }])
        // A second round, mid-session: new assertions, never the old ones again.
        mcp.validTokens.clear()
        await callTool(connected.tools, 'files__echo', { text: 'signed' })
      } finally {
        await connected.close()
      }

      assert.equal(idp.exchanges.length, 2)
      assert.equal(mcp.tokenRequests().length, 2)
      const forIdp = idp.exchanges.map((e) => peekJwt(e.params.client_assertion))
      const forAs = mcp.tokenRequests().map((r) => peekJwt(r.params.client_assertion))
      for (const exchange of idp.exchanges) {
        assert.equal(exchange.authMethod, 'assertion')
        assert.equal(exchange.status, 200)
        assert.equal(exchange.params.client_secret, undefined)
      }
      for (const grant of mcp.tokenRequests()) {
        assert.equal(grant.authMethod, 'assertion')
        assert.equal(grant.error, undefined)
        assert.equal(grant.params.client_assertion_type, CLIENT_ASSERTION_TYPE)
      }
      for (const { header, payload } of forIdp) {
        assert.equal(payload.aud, idp.issuer, 'for the IdP: its issuer, not its token endpoint')
        assert.equal(payload.iss, IDP_CLIENT)
        assert.equal(payload.sub, IDP_CLIENT)
        assert.equal(header.alg, 'ES256')
        assert.equal(header.kid, EC_KEY.kid)
      }
      for (const { header, payload } of forAs) {
        assert.equal(payload.aud, mcp.issuer, 'for the authorization server: its issuer')
        assert.equal(payload.iss, AS_CLIENT)
        assert.equal(header.alg, 'RS256')
      }
      const all = [...forIdp, ...forAs].map((j) => j.payload)
      assert.equal(new Set(all.map((p) => p.jti)).size, 4, 'a new jti for every request')
      for (const p of all) {
        assert.ok((p.exp as number) - (p.iat as number) <= 60, 'exp is at most a minute away')
      }

      // The servers hold the line too: an assertion made for one is refused by the other.
      const mint = (
        clientId: string,
        audience: string,
        key: typeof EC_KEY,
        algorithm: 'ES256' | 'RS256',
      ) =>
        createClientAssertion({
          clientId,
          audience,
          privateKey: key.privateJwk,
          algorithm,
          keyId: key.kid,
        })
      const idpBoundAtAs = await postForm(`${mcp.issuer}/token`, {
        grant_type: JWT_BEARER_GRANT,
        assertion: idp.issuedIdJags[0],
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await mint(AS_CLIENT, idp.issuer, RSA_KEY, 'RS256'),
      })
      assert.equal(idpBoundAtAs.status, 401)
      assert.equal(
        idpBoundAtAs.body.error_description,
        'Client assertion audience is not this server',
      )
      const asBoundAtIdp = await postForm(idp.tokenEndpoint, {
        grant_type: TOKEN_EXCHANGE_GRANT,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await mint(IDP_CLIENT, mcp.issuer, EC_KEY, 'ES256'),
      })
      assert.equal(asBoundAtIdp.status, 401)
      assert.equal(
        asBoundAtIdp.body.error_description,
        'Client assertion audience is not this server',
      )
      // A used assertion is not accepted twice.
      const replay = await postForm(`${mcp.issuer}/token`, {
        grant_type: JWT_BEARER_GRANT,
        assertion: idp.issuedIdJags[0],
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: mcp.tokenRequests()[0].params.client_assertion,
      })
      assert.equal(replay.body.error_description, 'Client assertion was already used')

      assertWorldLeaksNothing(world, logs.lines, [...keyMaterial(EC_KEY), ...keyMaterial(RSA_KEY)])
    },
    {
      idp: { clientSecret: undefined, clientJwks: { keys: [EC_KEY.publicJwk] } },
      enterprise: { clientSecret: undefined, clientJwks: { keys: [RSA_KEY.publicJwk] } },
    },
  )
})

// What the client is set to, and the server form it matches.
const ASSERTION_FORMS = {
  rfc7523bis: {},
  rfc7523: { assertionAudience: 'token-endpoint', assertionType: 'JWT' },
} as const
type AssertionForm = keyof typeof ASSERTION_FORMS

/** A world whose IdP and authorization server each hold assertions to one form. */
const withFormWorld = (
  servers: { idp: AssertionForm; as: AssertionForm },
  body: (
    world: IWorld,
    provider: (
      client: { idp: AssertionForm; as: AssertionForm },
      fresh?: boolean,
    ) => ReturnType<IWorld['provider']>,
  ) => Promise<void>,
): Promise<void> =>
  withWorld(
    (world) =>
      body(world, (client, fresh) =>
        world.provider({
          clientSecret: undefined,
          clientAuthMethod: 'private_key_jwt',
          privateKey: RSA_KEY.privatePem,
          algorithm: 'RS256',
          keyId: RSA_KEY.kid,
          ...ASSERTION_FORMS[client.as],
          // A store of its own: a token an earlier provider was granted is not this one's.
          ...(fresh ? { store: new MemoryOAuthStore() } : {}),
          idp: {
            tokenEndpoint: world.idp.tokenEndpoint,
            // Not needed when the assertion is addressed to the token endpoint.
            ...(client.idp === 'rfc7523bis' ? { issuer: world.idp.issuer } : {}),
            clientId: IDP_CLIENT,
            clientAuthMethod: 'private_key_jwt',
            privateKey: EC_KEY.privateJwk,
            algorithm: 'ES256',
            keyId: EC_KEY.kid,
            ...ASSERTION_FORMS[client.idp],
          },
        }),
      ),
    {
      idp: {
        clientSecret: undefined,
        clientJwks: { keys: [EC_KEY.publicJwk] },
        assertionProfile: servers.idp,
      },
      enterprise: {
        clientSecret: undefined,
        clientJwks: { keys: [RSA_KEY.publicJwk] },
        assertionProfile: servers.as,
      },
    },
  )

test('e2e: servers built to RFC 7523 accept the token-endpoint form and refuse the default one', async () => {
  await withFormWorld({ idp: 'rfc7523', as: 'rfc7523' }, async (world, provider) => {
    const { idp, mcp } = world
    const logs = collectLogs()
    const connected = await connectMcpServers(
      { files: { url: mcp.url, authProvider: provider({ idp: 'rfc7523', as: 'rfc7523' }) } },
      logs.log as never,
      'agent-test',
    )
    try {
      assert.deepEqual(connected.results, [{ name: 'files', connected: true }])
      assert.match(
        JSON.stringify(await callTool(connected.tools, 'files__echo', { text: 'old form' })),
        /echo:old form/,
      )
    } finally {
      await connected.close()
    }
    const forIdp = peekJwt(idp.exchanges[0].params.client_assertion)
    assert.equal(idp.exchanges[0].status, 200)
    assert.equal(forIdp.payload.aud, idp.tokenEndpoint, 'the configured IdP token endpoint')
    assert.equal(forIdp.header.typ, 'JWT')
    const forAs = peekJwt(mcp.tokenRequests()[0].params.client_assertion)
    assert.equal(mcp.tokenRequests()[0].error, undefined)
    assert.equal(forAs.payload.aud, mcp.tokenEndpoint, 'the discovered token endpoint')
    assert.equal(forAs.header.typ, 'JWT')
    assertWorldLeaksNothing(world, logs.lines, [...keyMaterial(EC_KEY), ...keyMaterial(RSA_KEY)])

    // The default (bis) form is refused by the RFC 7523 IdP...
    const atIdp = await failToConnect(world, provider({ idp: 'rfc7523bis', as: 'rfc7523' }, true))
    assert.match(
      atIdp.error,
      /the identity provider answered 401 invalid_client - Client assertion typ is not supported/,
    )
    assert.equal(mcp.tokenRequests().length, 1, 'nothing more reached the authorization server')
    // ...and by the RFC 7523 authorization server.
    const atAs = await failToConnect(world, provider({ idp: 'rfc7523', as: 'rfc7523bis' }, true))
    assert.equal(
      atAs.error,
      'MCP authorization server refused the ID-JAG grant: invalid_client (HTTP 401)',
    )
    assert.ok(atAs.logs.some((l) => /Client assertion typ is not supported/.test(l)))
  })
})

test('e2e: servers built to rfc7523bis accept the default form and refuse the token-endpoint one', async () => {
  await withFormWorld({ idp: 'rfc7523bis', as: 'rfc7523bis' }, async (world, provider) => {
    const { idp, mcp } = world
    const connected = await connectMcpServers(
      { files: { url: mcp.url, authProvider: provider({ idp: 'rfc7523bis', as: 'rfc7523bis' }) } },
      (() => {}) as never,
      'agent-test',
    )
    await connected.close()
    assert.deepEqual(connected.results, [{ name: 'files', connected: true }])
    assert.equal(peekJwt(idp.exchanges[0].params.client_assertion).payload.aud, idp.issuer)
    assert.equal(peekJwt(mcp.tokenRequests()[0].params.client_assertion).payload.aud, mcp.issuer)

    const atIdp = await failToConnect(world, provider({ idp: 'rfc7523', as: 'rfc7523bis' }, true))
    assert.match(
      atIdp.error,
      /the identity provider answered 401 invalid_client - Client assertion typ is not client-authentication\+jwt/,
    )
    assert.equal(mcp.tokenRequests().length, 1, 'nothing more reached the authorization server')
    const atAs = await failToConnect(world, provider({ idp: 'rfc7523bis', as: 'rfc7523' }, true))
    assert.equal(
      atAs.error,
      'MCP authorization server refused the ID-JAG grant: invalid_client (HTTP 401)',
    )
    assert.ok(
      atAs.logs.some((l) => /Client assertion typ is not client-authentication\+jwt/.test(l)),
    )
  })
})

test('e2e: the audience and the typ are judged separately by each kind of server', async () => {
  // Only the audience differs from what the server wants: the typ is right.
  await withFormWorld({ idp: 'rfc7523', as: 'rfc7523' }, async (world) => {
    const { idp, mcp } = world
    const issuerAudience = world.provider({
      clientSecret: undefined,
      clientAuthMethod: 'private_key_jwt',
      privateKey: RSA_KEY.privatePem,
      algorithm: 'RS256',
      keyId: RSA_KEY.kid,
      assertionType: 'JWT',
      idp: {
        tokenEndpoint: idp.tokenEndpoint,
        clientId: IDP_CLIENT,
        clientAuthMethod: 'private_key_jwt',
        privateKey: EC_KEY.privateJwk,
        algorithm: 'ES256',
        keyId: EC_KEY.kid,
        assertionAudience: 'token-endpoint',
        assertionType: 'JWT',
      },
    })
    const refused = await failToConnect(world, issuerAudience)
    assert.equal(
      refused.error,
      'MCP authorization server refused the ID-JAG grant: invalid_client (HTTP 401)',
    )
    assert.ok(
      refused.logs.some((l) => /Client assertion audience is not the token endpoint/.test(l)),
    )
    assert.equal(peekJwt(mcp.tokenRequests()[0].params.client_assertion).payload.aud, mcp.issuer)
  })
  await withFormWorld({ idp: 'rfc7523bis', as: 'rfc7523bis' }, async (world) => {
    const { idp, mcp } = world
    const endpointAudience = world.provider({
      clientSecret: undefined,
      clientAuthMethod: 'private_key_jwt',
      privateKey: RSA_KEY.privatePem,
      algorithm: 'RS256',
      keyId: RSA_KEY.kid,
      assertionAudience: 'token-endpoint',
      idp: {
        tokenEndpoint: idp.tokenEndpoint,
        issuer: idp.issuer,
        clientId: IDP_CLIENT,
        clientAuthMethod: 'private_key_jwt',
        privateKey: EC_KEY.privateJwk,
        algorithm: 'ES256',
        keyId: EC_KEY.kid,
      },
    })
    const refused = await failToConnect(world, endpointAudience)
    assert.ok(refused.logs.some((l) => /Client assertion audience is not this server/.test(l)))
    assert.equal(
      peekJwt(mcp.tokenRequests()[0].params.client_assertion).payload.aud,
      mcp.tokenEndpoint,
    )
  })
})

test('e2e: a client assertion signed with the wrong key is refused on each hop, by name', async () => {
  const other = generateClientKey('ES256', EC_KEY.kid)
  await withWorld(
    async (world) => {
      const { idp, mcp } = world
      const pkjwt = (key: typeof EC_KEY) => ({
        clientSecret: undefined,
        clientAuthMethod: 'private_key_jwt' as const,
        privateKey: key.privateJwk,
        algorithm: 'ES256' as const,
        keyId: key.kid,
      })
      const idpClient = (key: typeof EC_KEY) => ({
        tokenEndpoint: idp.tokenEndpoint,
        issuer: idp.issuer,
        clientId: IDP_CLIENT,
        clientAuthMethod: 'private_key_jwt' as const,
        privateKey: key.privateJwk,
        algorithm: 'ES256' as const,
        keyId: key.kid,
      })
      const atIdp = await failToConnect(
        world,
        world.provider({ ...pkjwt(EC_KEY), idp: idpClient(other) }),
      )
      assert.match(
        atIdp.error,
        /Enterprise IdP token exchange failed: the identity provider answered 401 invalid_client - Client assertion signature validation failed/,
      )
      assert.equal(mcp.tokenRequests().length, 0)

      const atAs = await failToConnect(
        world,
        world.provider({ ...pkjwt(other), idp: idpClient(EC_KEY) }),
      )
      assert.equal(
        atAs.error,
        'MCP authorization server refused the ID-JAG grant: invalid_client (HTTP 401)',
      )
      assert.ok(atAs.logs.some((l) => /Client assertion signature validation failed/.test(l)))
      assertWorldLeaksNothing(
        world,
        [atIdp.error, ...atIdp.logs, atAs.error, ...atAs.logs],
        [...keyMaterial(EC_KEY), ...keyMaterial(other)],
      )
    },
    {
      idp: { clientSecret: undefined, clientJwks: { keys: [EC_KEY.publicJwk] } },
      enterprise: { clientSecret: undefined, clientJwks: { keys: [EC_KEY.publicJwk] } },
    },
  )
})

test('e2e: a client ID metadata document as the client id, with private_key_jwt', async () => {
  // The client's own site: the document and the keys it points at.
  const served: string[] = []
  const site = createServer((req, res) => {
    served.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/oauth/client.json') {
      res.end(
        JSON.stringify({
          client_id: CIMD_URL,
          client_name: 'agent-enterprise-test',
          redirect_uris: [],
          grant_types: [TOKEN_EXCHANGE_GRANT, JWT_BEARER_GRANT],
          token_endpoint_auth_method: 'private_key_jwt',
          jwks_uri: 'https://client.example.test/oauth/jwks.json',
        }),
      )
      return
    }
    res.end(JSON.stringify({ keys: [EC_KEY.publicJwk] }))
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const siteOrigin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  try {
    await withWorld(
      async (world) => {
        const { idp, mcp } = world
        const logs = collectLogs()
        const connected = await connectMcpServers(
          {
            files: {
              url: mcp.url,
              authProvider: world.provider({
                clientId: CIMD_URL,
                clientSecret: undefined,
                clientAuthMethod: 'private_key_jwt',
                privateKey: EC_KEY.privatePem,
                algorithm: 'ES256',
                keyId: EC_KEY.kid,
              }),
            },
          },
          logs.log as never,
          'agent-test',
        )
        try {
          assert.deepEqual(connected.results, [{ name: 'files', connected: true }])
          await callTool(connected.tools, 'files__echo', { text: 'cimd' })
        } finally {
          await connected.close()
        }
        assert.deepEqual(mcp.cimdFetches, [CIMD_URL], 'the server resolved the client by its URL')
        assert.deepEqual(served, ['/oauth/client.json', '/oauth/jwks.json'])
        const [grant] = mcp.tokenRequests()
        assert.equal(grant.error, undefined)
        const assertion = peekJwt(grant.params.client_assertion)
        assert.equal(assertion.payload.iss, CIMD_URL)
        assert.equal(assertion.payload.sub, CIMD_URL)
        assert.equal(assertion.payload.aud, mcp.issuer)
        // The ID-JAG names the same client: the IdP knows it by that URL.
        assert.equal(peekJwt(idp.issuedIdJags[0]).payload.client_id, CIMD_URL)
        assert.equal(mcp.registrations(), 0)
        assertWorldLeaksNothing(world, logs.lines, keyMaterial(EC_KEY))
      },
      {
        idp: { resourceClientId: CIMD_URL },
        enterprise: {
          clientId: 'no-pre-registered-client',
          clientSecret: undefined,
          cimd: { resolve: (url) => url.replace('https://client.example.test', siteOrigin) },
        },
      },
    )
  } finally {
    site.closeAllConnections()
    await new Promise<void>((resolve) => site.close(() => resolve()))
  }
})

// ── a refusal in the middle of a session ──────────────────────────────────

test('e2e: an authorization server that starts refusing mid-session gives a clean error; the detail goes to the log, redacted', async () => {
  await withWorld(
    async (world) => {
      const { idp, mcp } = world
      const logs = collectLogs()
      const connected = await connectMcpServers(
        {
          files: {
            url: mcp.url,
            authProvider: world.provider({
              clientSecret: undefined,
              clientAuthMethod: 'private_key_jwt',
              privateKey: EC_KEY.privateJwk,
              algorithm: 'ES256',
              keyId: EC_KEY.kid,
            }),
          },
        },
        logs.log as never,
        'agent-test',
      )
      try {
        assert.deepEqual(connected.results, [{ name: 'files', connected: true }])
        await callTool(connected.tools, 'files__echo', { text: 'fine' })
        const linesBefore = logs.lines.length

        // The token dies and the server now refuses every grant, quoting the
        // whole request - grant, client assertion and all - in its answer.
        mcp.validTokens.clear()
        mcp.faults.echoRequest = true
        let thrown: unknown
        try {
          await callTool(connected.tools, 'files__echo', { text: 'refused' })
        } catch (err) {
          thrown = err
        }
        assert.ok(thrown instanceof EnterpriseOAuthError, `got ${String(thrown)}`)
        assert.equal(thrown.hop, 'authorization-server')
        assert.equal(thrown.code, 'invalid_request')
        assert.equal(
          thrown.message,
          'MCP authorization server refused the ID-JAG grant: invalid_request (HTTP 400)',
        )
        assert.equal(idp.exchanges.length, 2, 'one fresh exchange, and no second try')

        // The same with an ordinary refusal: the code for the UI, the words for the log.
        mcp.faults.echoRequest = false
        mcp.faults.refuseGrant = {
          error: 'access_denied',
          description: 'The end-user is not licensed for this application',
        }
        await assert.rejects(
          () => callTool(connected.tools, 'files__echo', { text: 'refused' }),
          (err: unknown) =>
            err instanceof EnterpriseOAuthError &&
            err.message ===
              'MCP authorization server refused the ID-JAG grant: access_denied (HTTP 400)',
        )

        const added = logs.lines.slice(linesBefore)
        const detail = added.filter((l) => l.includes('enterprise authorization'))
        assert.equal(detail.length, 2)
        assert.ok(logs.levels.slice(linesBefore).includes('warn'))
        assert.match(detail[0], /refused the ID-JAG grant with 400 invalid_request: cannot accept/)
        assert.match(detail[0], /\[redacted\]/)
        assert.match(detail[1], /400 access_denied: The end-user is not licensed/)
        assertWorldLeaksNothing(
          world,
          [thrown.message, inspect(thrown), ...logs.lines],
          keyMaterial(EC_KEY),
        )
      } finally {
        await connected.close()
      }
    },
    { enterprise: { clientSecret: undefined, clientJwks: { keys: [EC_KEY.publicJwk] } } },
  )
})

test('provider: without a log nothing is reported, and a log that throws changes nothing', async () => {
  const idp = mockIdp(goodExchange)
  const said: string[] = []
  const provider = createEnterpriseOAuthProvider(
    baseOptions({ fetch: idp.fetchFn, onLog: (_l: string, m: string) => void said.push(m) }),
  )
  await provider.saveDiscoveryState(discovery())
  const refuse = async (): Promise<Response> =>
    jsonResponse(
      { error: 'bad code "><script>', error_description: `no: ${ID_JAG} ${AS_SECRET}` },
      403,
    )

  // Not the grant: passed through untouched.
  const through = await provider.transportFetch(refuse)(`${AS_URL}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token' }),
  })
  assert.equal(through.status, 403)

  const grant = await provider.prepareTokenRequest()
  const err = await rejection(() =>
    provider.transportFetch(refuse)(`${AS_URL}/token`, { method: 'POST', body: grant }),
  )
  // A code that is not a code is not repeated.
  assert.equal(
    err.message,
    'MCP authorization server refused the ID-JAG grant: no error code (HTTP 403)',
  )
  assert.equal(err.code, undefined)
  assert.equal(said.length, 1, 'the provider-level onLog is the fallback')
  assertNoSecrets(said[0], 'the log line')
  assert.match(said[0], /\[redacted\] \[redacted\]/)

  // A network failure on the grant is named too, and its text is not passed on.
  const again = await provider.prepareTokenRequest()
  const down = await rejection(() =>
    provider.transportFetch(async () => {
      throw new Error(`socket hang up while sending ${ID_JAG}`)
    })(`${AS_URL}/token`, { method: 'POST', body: again }),
  )
  assert.equal(down.message, 'MCP authorization server could not be reached for the ID-JAG grant')
  assertNoSecrets(said.join('\n'), 'the log')

  // A log sink that throws does not replace the error.
  const third = await provider.prepareTokenRequest()
  const loud = await rejection(() =>
    provider.transportFetch(refuse, () => {
      throw new Error('log sink exploded')
    })(`${AS_URL}/token`, { method: 'POST', body: third }),
  )
  assert.equal(loud.hop, 'authorization-server')
})
