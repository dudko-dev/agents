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
  type ILocalIdp,
  type ILocalIdpOptions,
} from './helpers/idp-server.ts'
import { startLocalMcp, type ILocalMcp, type ILocalMcpOptions } from './helpers/mcp-server.ts'
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
  })
  // No protected resource metadata: the configured URL, without its fragment.
  assert.deepEqual(
    enterpriseGrantTarget(`${MCP_URL}#frag`, discovery({ resourceMetadata: undefined })),
    { audience: AS_URL, resource: MCP_URL },
  )
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
    assert.ok(!dump.includes(value), 'the store holds no token, assertion, key or secret')
    for (const text of texts) {
      assert.ok(
        !text.includes(value),
        `no token, assertion, key or secret in: ${text.slice(0, 90)}`,
      )
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
