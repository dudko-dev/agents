import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { inspect } from 'node:util'
import {
  BrowserEnterpriseOAuthProvider,
  connectMcpHttp,
  createEnterpriseOAuthProvider,
  ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION,
  EnterpriseOAuthError,
  MemoryOAuthStorage,
} from '../dist/mcp.js'

// Enterprise-Managed Authorization (ID-JAG), in the browser package. The MCP
// server, its authorization server and the identity provider are all spoken to
// over mock fetches, so the real SDK state machine runs without a network. The
// flow over real sockets, against a test IdP that signs real tokens, is in the
// Node package (packages/agent/tests/mcp-enterprise-oauth.test.ts): the two
// providers are the same code.

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
const ID_TOKEN_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'

// Values that must never surface in an error, a log line or storage.
const ID_TOKEN = 'eyJhbGciOiJFUzI1NiJ9.aWQtdG9rZW4tcGF5bG9hZA.aWQtdG9rZW4tc2ln'
const ID_JAG = 'eyJ0eXAiOiJvYXV0aC1pZC1qYWcrand0In0.aWQtamFnLXBheWxvYWQ.aWQtamFnLXNpZw'
const AS_SECRET = 'as-secret-7f3a91c2'
const IDP_SECRET = 'idp-secret-b84e02d6'

const MCP_ORIGIN = 'https://mcp.example.test'
const MCP_URL = `${MCP_ORIGIN}/mcp`
const AS_URL = 'https://as.example.test'
const IDP_TOKEN_URL = 'https://idp.example.test/oauth2/token'
const AS_CLIENT = 'agent-at-as'
const IDP_CLIENT = 'agent-at-idp'

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

interface Recorded {
  url: string
  init: RequestInit
  params: URLSearchParams
  headers: Headers
}

const record = (url: string | URL, init: RequestInit = {}): Recorded => ({
  url: String(url),
  init,
  params: new URLSearchParams(String(init.body ?? '')),
  headers: new Headers(init.headers as HeadersInit | undefined),
})

const goodExchange = (): Response =>
  jsonResponse({ issued_token_type: ID_JAG_TOKEN_TYPE, access_token: ID_JAG, token_type: 'N_A' })

/** The identity provider: records the exchange, answers with `reply`. */
const mockIdp = (reply: () => Response | Promise<Response> = goodExchange) => {
  const calls: Recorded[] = []
  const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    calls.push(record(url, init))
    return reply()
  }
  return { calls, fetchFn, setReply: (next: typeof reply) => void (reply = next) }
}

interface WorldOptions {
  /** `issuer` the authorization server's metadata declares. Default: its own URL. */
  metadataIssuer?: string
  /** Where the protected resource metadata points. Default: AS_URL. */
  authorizationServer?: string
  /** The `resource` the MCP server publishes. Default: MCP_URL. */
  resource?: string
  tokenEndpoint?: string
  /** Seconds the access token lives. Default 3600. */
  expiresIn?: number
  /** Answer every grant with this OAuth error. */
  grantError?: { error: string; error_description: string }
}

/** The MCP server and its authorization server, behind one mock fetch. */
const mockWorld = (opts: WorldOptions = {}) => {
  const asUrl = opts.authorizationServer ?? AS_URL
  const state = {
    validTokens: new Set<string>(),
    issued: 0,
    tokenRequests: [] as Recorded[],
    mcpAuth: [] as (string | null)[],
    initialize: [] as Record<string, unknown>[],
  }
  const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const href = String(url)
    const headers = new Headers(init.headers as HeadersInit | undefined)
    if (href.includes('/.well-known/oauth-protected-resource')) {
      return jsonResponse({
        resource: opts.resource ?? MCP_URL,
        authorization_servers: [asUrl],
      })
    }
    if (
      href.includes('/.well-known/oauth-authorization-server') ||
      href.includes('/.well-known/openid-configuration')
    ) {
      if (!href.startsWith(asUrl)) return new Response('not found', { status: 404 })
      return jsonResponse({
        issuer: opts.metadataIssuer ?? asUrl,
        authorization_endpoint: `${asUrl}/authorize`,
        token_endpoint: opts.tokenEndpoint ?? `${asUrl}/token`,
        response_types_supported: ['code'],
        grant_types_supported: [JWT_BEARER_GRANT],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],
      })
    }
    if (href.endsWith('/token')) {
      const seen = record(url, init)
      state.tokenRequests.push(seen)
      if (opts.grantError) return jsonResponse(opts.grantError, 400)
      const basic = `Basic ${Buffer.from(`${AS_CLIENT}:${AS_SECRET}`).toString('base64')}`
      if (seen.headers.get('authorization') !== basic) {
        return jsonResponse({ error: 'invalid_client' }, 401)
      }
      if (
        seen.params.get('grant_type') !== JWT_BEARER_GRANT ||
        seen.params.get('assertion') !== ID_JAG
      ) {
        return jsonResponse({ error: 'invalid_grant' }, 400)
      }
      state.issued += 1
      const access = `access-${state.issued}`
      state.validTokens.clear()
      state.validTokens.add(access)
      return jsonResponse({
        access_token: access,
        token_type: 'Bearer',
        expires_in: opts.expiresIn ?? 3600,
      })
    }
    if (href.startsWith(MCP_URL)) {
      const method = init.method ?? 'GET'
      if (method === 'GET') return new Response(null, { status: 405 })
      if (method === 'DELETE') return new Response(null, { status: 200 })
      state.mcpAuth.push(headers.get('authorization'))
      const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      if (!state.validTokens.has(token)) {
        return jsonResponse({ error: 'unauthorized' }, 401, {
          'www-authenticate': `Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
        })
      }
      const msg = JSON.parse(String(init.body ?? 'null')) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
      }
      if (msg.method === 'initialize') {
        state.initialize.push(msg.params ?? {})
        return jsonResponse({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-mcp', version: '1.0.0' },
          },
        })
      }
      if (msg.id === undefined) return new Response(null, { status: 202 })
      if (msg.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] },
        })
      }
      if (msg.method === 'tools/call') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'echo:ok' }] },
        })
      }
      return jsonResponse({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchFn, state }
}

const makeProvider = (extra: Record<string, unknown> = {}) =>
  createEnterpriseOAuthProvider({
    serverUrl: MCP_URL,
    clientId: AS_CLIENT,
    clientSecret: AS_SECRET,
    idp: { tokenEndpoint: IDP_TOKEN_URL, clientId: IDP_CLIENT, clientSecret: IDP_SECRET },
    getIdToken: () => ID_TOKEN,
    storage: new MemoryOAuthStorage(),
    ...extra,
  } as never)

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

const callTool = (tools: Record<string, unknown>, name: string, args: unknown): Promise<unknown> =>
  (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {})

// ── guards: construction ──────────────────────────────────────────────────

test('enterprise: the MCP server URL and the IdP token endpoint must be https or loopback', () => {
  assert.throws(() => makeProvider({ serverUrl: 'http://mcp.example.test/mcp' }), /requires https/)
  assert.throws(
    () => makeProvider({ serverUrl: 'http://localhost.attacker.example/mcp' }),
    /requires https/,
  )
  const idp = (tokenEndpoint: string) => ({
    idp: { tokenEndpoint, clientId: IDP_CLIENT, clientSecret: IDP_SECRET },
  })
  assert.throws(
    () => makeProvider(idp('http://idp.example.test/token')),
    /Enterprise IdP token endpoint: .*requires https/,
  )
  assert.throws(() => makeProvider(idp('not a url')), /not a valid URL/)
  assert.throws(() => makeProvider({ expectedIssuer: 'http://as.example.test' }), /requires https/)
  assert.throws(() => makeProvider({ clientId: '' }), /clientId/)
  assert.throws(() => makeProvider({ getIdToken: undefined }), /getIdToken/)
  // Loopback is fine: there is no network to sniff.
  makeProvider({ serverUrl: 'http://127.0.0.1:8080/mcp', ...idp('http://localhost:9000/token') })
})

test('enterprise: non-interactive, with the pre-registered client from configuration', async () => {
  const provider = makeProvider({ expectedIssuer: AS_URL })
  assert.ok(provider instanceof BrowserEnterpriseOAuthProvider)
  assert.equal(provider.redirectUrl, undefined, 'no redirectUrl is what makes it non-interactive')
  assert.equal(provider.extension, ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION)
  assert.deepEqual(provider.clientInformation(), {
    client_id: AS_CLIENT,
    client_secret: AS_SECRET,
    issuer: AS_URL,
  })
  await provider.invalidateCredentials('all')
  assert.equal(provider.clientInformation().client_id, AS_CLIENT)
  assert.throws(() => provider.redirectToAuthorization(), /no interactive step/)
})

// ── the flow ──────────────────────────────────────────────────────────────

test('enterprise: connect with no human step - IdP exchange, then the jwt-bearer grant', async () => {
  const world = mockWorld()
  const idp = mockIdp()
  const storage = new MemoryOAuthStorage()
  const logs: string[] = []
  const provider = makeProvider({ storage, fetch: idp.fetchFn, scope: 'mcp:tools' })

  const mcp = await connectMcpHttp(
    { docs: { url: MCP_URL, authProvider: provider, fetch: world.fetchFn } },
    { onLog: (_level, message) => void logs.push(message) },
  )
  assert.equal(mcp.results[0].connected, true, mcp.results[0].error)
  assert.match(JSON.stringify(await callTool(mcp.tools, 'docs__echo', {})), /echo:ok/)
  await mcp.close()

  // Hop 1: exactly the exchange the draft describes, for THIS server.
  assert.equal(idp.calls.length, 1)
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
    scope: 'mcp:tools',
  })
  assert.equal(
    call.headers.get('authorization'),
    `Basic ${Buffer.from(`${IDP_CLIENT}:${IDP_SECRET}`).toString('base64')}`,
  )
  // A redirect would carry the ID token and the secret elsewhere: refused.
  assert.equal(call.init.redirect, 'error')

  // Hop 2: the ID-JAG as a jwt-bearer assertion, the client authenticated.
  assert.equal(world.state.tokenRequests.length, 1)
  const grant = world.state.tokenRequests[0]
  assert.equal(grant.url, `${AS_URL}/token`)
  assert.equal(grant.params.get('grant_type'), JWT_BEARER_GRANT)
  assert.equal(grant.params.get('assertion'), ID_JAG)
  // No MCP request went out before the token was in hand.
  assert.ok(world.state.mcpAuth.every((a) => a === 'Bearer access-1'))
  // The extension is declared by the client that uses it.
  assert.deepEqual(
    (world.state.initialize[0].capabilities as { extensions?: unknown }).extensions,
    { [ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION]: {} },
  )

  // Only the access token is stored.
  const dump = JSON.stringify([...(storage as unknown as { map: Map<string, string> }).map])
  assert.match(dump, /access-1/)
  assertNoSecrets(dump, 'storage')
  assertNoSecrets(logs.join('\n'), 'the log')
  assertNoSecrets(inspect(provider, { depth: 6 }), 'inspect(provider)')
  assertNoSecrets(JSON.stringify(provider), 'JSON.stringify(provider)')
})

test('enterprise: client_secret_post and a public client put the client in the body', async () => {
  const post = mockIdp()
  await makeProvider({
    fetch: post.fetchFn,
    idp: {
      tokenEndpoint: IDP_TOKEN_URL,
      clientId: IDP_CLIENT,
      clientSecret: IDP_SECRET,
      clientAuthMethod: 'client_secret_post',
    },
  }).authorize({ fetch: mockWorld().fetchFn })
  assert.equal(post.calls[0].params.get('client_id'), IDP_CLIENT)
  assert.equal(post.calls[0].params.get('client_secret'), IDP_SECRET)
  assert.equal(post.calls[0].headers.get('authorization'), null)

  const pub = mockIdp()
  await makeProvider({
    fetch: pub.fetchFn,
    idp: { tokenEndpoint: IDP_TOKEN_URL, clientId: IDP_CLIENT },
  }).authorize({ fetch: mockWorld().fetchFn })
  assert.equal(pub.calls[0].params.get('client_id'), IDP_CLIENT)
  assert.equal(pub.calls[0].params.has('client_secret'), false)
})

test('enterprise: an expired access token triggers a fresh exchange before the first request', async () => {
  const world = mockWorld({ expiresIn: 5 })
  const idp = mockIdp()
  let asked = 0
  const provider = makeProvider({
    fetch: idp.fetchFn,
    getIdToken: () => {
      asked += 1
      return ID_TOKEN
    },
  })
  const servers = { docs: { url: MCP_URL, authProvider: provider, fetch: world.fetchFn } }

  await (await connectMcpHttp(servers)).close()
  assert.equal(idp.calls.length, 1)
  assert.equal(await provider.isAccessTokenExpired(), true, 'five seconds is inside the skew')

  const second = await connectMcpHttp(servers)
  assert.equal(second.results[0].connected, true)
  assert.equal(idp.calls.length, 2, 'a fresh ID-JAG')
  assert.equal(asked, 2, 'from a fresh ID token')
  assert.ok(
    world.state.mcpAuth.slice(-2).every((a) => a === 'Bearer access-2'),
    'no request went out on the dead token',
  )

  // And a token the server stops accepting mid-session is re-obtained on the 401.
  world.state.validTokens.clear()
  assert.match(JSON.stringify(await callTool(second.tools, 'docs__echo', {})), /echo:ok/)
  assert.equal(idp.calls.length, 3)
  await second.close()
})

// ── guards: what discovery found ──────────────────────────────────────────

const refusedBeforeAnyCredential = async (
  worldOpts: WorldOptions,
  providerOpts: Record<string, unknown>,
  pattern: RegExp,
): Promise<void> => {
  const world = mockWorld(worldOpts)
  const idp = mockIdp()
  let asked = 0
  const provider = makeProvider({
    fetch: idp.fetchFn,
    getIdToken: () => {
      asked += 1
      return ID_TOKEN
    },
    ...providerOpts,
  })
  const err = await rejection(() => provider.authorize({ fetch: world.fetchFn }))
  assert.equal(err.hop, 'discovery')
  assert.match(err.message, pattern)
  assert.equal(asked, 0, 'no ID token was asked for')
  assert.equal(idp.calls.length, 0, 'nothing was sent to the IdP')
  assert.equal(world.state.tokenRequests.length, 0, 'nothing was sent to the authorization server')
  assert.equal(await provider.discoveryState(), undefined, 'the refused discovery was not kept')
}

test('enterprise: metadata that names another issuer is refused (RFC 8414 3.3)', async () => {
  // A hostile MCP server points at its own authorization server, whose metadata
  // claims to be an honest one: the ID-JAG would be minted for the honest
  // server and delivered to the hostile token endpoint.
  await refusedBeforeAnyCredential(
    { authorizationServer: 'https://evil.example.test', metadataIssuer: AS_URL },
    {},
    /names another issuer/,
  )
})

test('enterprise: with expectedIssuer, any other authorization server receives nothing', async () => {
  await refusedBeforeAnyCredential(
    {},
    { expectedIssuer: 'https://corp-as.example.test' },
    /corp-as\.example\.test/,
  )
  // The provider's own check, without the SDK's stamp check in front of it.
  const idpDirect = mockIdp()
  const direct = makeProvider({
    fetch: idpDirect.fetchFn,
    expectedIssuer: 'https://corp-as.example.test',
  })
  await direct.saveDiscoveryState({
    authorizationServerUrl: `${AS_URL}/`,
    authorizationServerMetadata: { issuer: AS_URL, token_endpoint: `${AS_URL}/token` },
    resourceMetadata: { resource: MCP_URL, authorization_servers: [AS_URL] },
  } as never)
  const err = await rejection(() => direct.prepareTokenRequest())
  assert.match(
    err.message,
    /expected "https:\/\/corp-as\.example\.test"; refusing to send credentials/,
  )
  assert.equal(idpDirect.calls.length, 0)
  assert.equal(await direct.discoveryState(), undefined)

  // The expected one passes, with or without the trailing slash.
  const idp = mockIdp()
  await makeProvider({ fetch: idp.fetchFn, expectedIssuer: `${AS_URL}/` }).authorize({
    fetch: mockWorld().fetchFn,
  })
  assert.equal(idp.calls[0].params.get('audience'), AS_URL)
})

test('enterprise: a plaintext authorization server or token endpoint is refused', async () => {
  await refusedBeforeAnyCredential(
    { authorizationServer: 'http://as.example.test' },
    {},
    /MCP authorization server: .*requires https/,
  )
  await refusedBeforeAnyCredential(
    { tokenEndpoint: 'http://as.example.test/token' },
    {},
    /token endpoint: .*requires https/,
  )
})

test('enterprise: the audience and the resource come from discovery, never from the caller', async () => {
  // A parent path on the same origin is the server's own identifier: used verbatim.
  const idp = mockIdp()
  const provider = makeProvider({ fetch: idp.fetchFn })
  await provider.authorize({ fetch: mockWorld({ resource: MCP_ORIGIN }).fetchFn })
  assert.equal(idp.calls[0].params.get('resource'), MCP_ORIGIN)
  assert.equal(idp.calls[0].params.get('audience'), AS_URL)

  // Stored discovery that no longer covers this server is refused, not used.
  const stale = makeProvider({ fetch: idp.fetchFn })
  for (const resource of ['https://other.example.test/mcp', `${MCP_URL}/deeper`, `${MCP_URL}2`]) {
    await stale.saveDiscoveryState({
      authorizationServerUrl: `${AS_URL}/`,
      authorizationServerMetadata: { issuer: AS_URL, token_endpoint: `${AS_URL}/token` },
      resourceMetadata: { resource, authorization_servers: [AS_URL] },
    } as never)
    const err = await rejection(() => stale.prepareTokenRequest())
    assert.equal(err.hop, 'discovery')
    assert.match(err.message, /does not cover/)
  }
  assert.equal(idp.calls.length, 1, 'no further exchange was made')

  // No metadata at all: there is no audience to ask for.
  await stale.saveDiscoveryState({ authorizationServerUrl: `${AS_URL}/` } as never)
  await assert.rejects(() => stale.prepareTokenRequest(), /published no metadata with an issuer/)
})

// ── guards: the token exchange ────────────────────────────────────────────

test('enterprise: an answer that is not an ID-JAG never reaches the authorization server', async () => {
  for (const body of [
    { issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', access_token: ID_JAG },
    { access_token: ID_JAG, token_type: 'Bearer' },
    { issued_token_type: ID_JAG_TOKEN_TYPE },
    { issued_token_type: ID_JAG_TOKEN_TYPE, access_token: '' },
  ]) {
    const world = mockWorld()
    const idp = mockIdp(() => jsonResponse(body))
    const provider = makeProvider({ fetch: idp.fetchFn })
    const err = await rejection(() => provider.authorize({ fetch: world.fetchFn }))
    assert.equal(err.hop, 'idp')
    assert.match(err.message, /nothing was sent to the MCP authorization server/)
    assert.equal(world.state.tokenRequests.length, 0, 'the authorization server saw no request')
    assert.equal(await provider.tokens(), undefined)
    assertNoSecrets(err.message, 'the error')
  }
})

test('enterprise: the IdP error is passed on, names the hop, and fails the connect once', async () => {
  const world = mockWorld()
  const idp = mockIdp(() =>
    jsonResponse({ error: 'access_denied', error_description: 'User is not assigned' }, 400),
  )
  const mcp = await connectMcpHttp({
    docs: {
      url: MCP_URL,
      authProvider: makeProvider({ fetch: idp.fetchFn }),
      fetch: world.fetchFn,
    },
  })
  assert.equal(mcp.results[0].connected, false)
  assert.equal(
    mcp.results[0].error,
    'Enterprise IdP token exchange failed: the identity provider answered 400 access_denied - User is not assigned',
  )
  assert.notEqual(mcp.results[0].needsAuthorization, true, 'there is no one to send anywhere')
  assert.equal(idp.calls.length, 1, 'a final refusal is not repeated through the 401 path')
  assert.equal(world.state.tokenRequests.length, 0)
  await mcp.close()
})

test('enterprise: no token or secret survives in an error, whatever the server or fetch says', async () => {
  const world = mockWorld()
  // A server that echoes the request back; long enough that the message is clipped.
  const echo = mockIdp(() =>
    jsonResponse(
      {
        error: 'invalid_request',
        error_description: `bad: ${'x'.repeat(260)} subject_token=${ID_TOKEN}&client_secret=${IDP_SECRET}`,
      },
      400,
    ),
  )
  const echoed = await rejection(() =>
    makeProvider({ fetch: echo.fetchFn }).authorize({ fetch: world.fetchFn }),
  )
  assert.equal(echoed.code, 'invalid_request')
  assertNoSecrets(echoed.message, 'an echoed error')
  // Not even the first half of the token, which is where a JWT keeps its claims.
  assert.ok(!echoed.message.includes(ID_TOKEN.slice(0, 20)))

  // A fetch whose own error quotes the request.
  const network = await rejection(() =>
    makeProvider({
      fetch: async () => {
        throw new Error(`connect failed, body subject_token=${ID_TOKEN} secret ${IDP_SECRET}`)
      },
    }).authorize({ fetch: world.fetchFn }),
  )
  assert.equal(network.hop, 'idp')
  assert.match(network.message, /did not complete/)
  assertNoSecrets(network.message, 'a network error')

  // A host whose getIdToken throws with the token in its message.
  const host = await rejection(() =>
    makeProvider({
      getIdToken: () => {
        throw new Error(`session expired for ${ID_TOKEN}`)
      },
    }).authorize({ fetch: world.fetchFn }),
  )
  assert.equal(host.hop, 'idp')
  assertNoSecrets(host.message, 'a host error')
  await assert.rejects(
    () => makeProvider({ getIdToken: () => '' }).authorize({ fetch: world.fetchFn }),
    /returned no ID token/,
  )
})

test('enterprise: a refusal by the authorization server names that hop and leaks nothing', async () => {
  const world = mockWorld({
    grantError: {
      error: 'invalid_request',
      error_description: `Audience validation failed for assertion=${ID_JAG} secret=${AS_SECRET}`,
    },
  })
  const idp = mockIdp()
  const provider = makeProvider({ fetch: idp.fetchFn })
  const err = await rejection(() => provider.authorize({ fetch: world.fetchFn }))
  assert.equal(err.hop, 'authorization-server')
  assert.equal(err.code, 'invalid_request')
  assert.match(err.message, /MCP authorization server refused the ID-JAG grant/)
  assert.match(err.message, /Audience validation failed/)
  assertNoSecrets(err.message, 'the error')
  assert.equal(await provider.tokens(), undefined)
})
