import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {
  constants as cryptoConstants,
  createPublicKey,
  generateKeyPairSync,
  verify as cryptoVerify,
  type JsonWebKey as NodeJwk,
} from 'node:crypto'
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

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

const peekJwt = (jwt: string) => {
  const [h, p] = jwt.split('.')
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>,
  }
}

/** Verify a compact JWT with node:crypto - an implementation the provider does not share. */
const verifyJwt = (jwt: string, jwk: NodeJwk) => {
  const parts = jwt.split('.')
  if (parts.length !== 3) return undefined
  try {
    const decoded = peekJwt(jwt)
    const alg = String(decoded.header.alg)
    if (!/^(ES|RS|PS)(256|384|512)$/.test(alg)) return undefined
    if ((alg.startsWith('ES') ? 'EC' : 'RSA') !== jwk.kty) return undefined
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

const makeKey = (kind: 'P-256' | 'P-384' | 'P-521' | 'RSA') => {
  const { privateKey, publicKey } =
    kind === 'RSA'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: kind })
  return {
    privateJwk: privateKey.export({ format: 'jwk' }),
    publicJwk: publicKey.export({ format: 'jwk' }),
  }
}

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
  /** The client at the authorization server is public: `client_id` only, no secret. */
  publicClient?: boolean
  /** The client authenticates with `private_key_jwt`: verified against this public key. */
  clientJwk?: NodeJwk
  /** The client id an assertion must name. Default AS_CLIENT. */
  clientId?: string
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
    /** Mutable: from now on refuse every grant, quoting the request body. */
    echoRequest: false,
    /** Mutable: from now on refuse every grant with this error. */
    refuse: undefined as { error: string; error_description: string } | undefined,
    /** Why the last client assertion was refused. */
    assertionRefusal: undefined as string | undefined,
    seenJti: new Set<string>(),
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
        token_endpoint_auth_methods_supported: [
          opts.clientJwk ? 'private_key_jwt' : opts.publicClient ? 'none' : 'client_secret_basic',
        ],
        authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],
      })
    }
    if (href.endsWith('/token')) {
      const seen = record(url, init)
      state.tokenRequests.push(seen)
      if (opts.grantError) return jsonResponse(opts.grantError, 400)
      if (state.echoRequest) {
        return jsonResponse(
          { error: 'invalid_request', error_description: `cannot accept ${String(init.body)}` },
          400,
        )
      }
      if (state.refuse) return jsonResponse(state.refuse, 400)
      if (opts.clientJwk) {
        // private_key_jwt: signed by the registered key, for THIS issuer, fresh.
        const assertion = seen.params.get('client_assertion') ?? ''
        const verified = verifyJwt(assertion, opts.clientJwk)
        const claims = verified?.payload ?? {}
        const now = Math.floor(Date.now() / 1000)
        state.assertionRefusal = !verified
          ? 'signature'
          : claims.iss !== (opts.clientId ?? AS_CLIENT) || claims.sub !== claims.iss
            ? 'client'
            : claims.aud !== asUrl
              ? 'audience'
              : typeof claims.exp !== 'number' || claims.exp <= now || claims.exp - now > 60
                ? 'lifetime'
                : state.seenJti.has(String(claims.jti))
                  ? 'replay'
                  : undefined
        if (
          state.assertionRefusal ||
          seen.params.get('client_assertion_type') !== CLIENT_ASSERTION_TYPE ||
          seen.headers.get('authorization') !== null ||
          seen.params.has('client_secret')
        ) {
          return jsonResponse(
            { error: 'invalid_client', error_description: `assertion: ${state.assertionRefusal}` },
            401,
          )
        }
        state.seenJti.add(String(claims.jti))
        if (seen.params.get('assertion') !== ID_JAG) {
          return jsonResponse({ error: 'invalid_grant' }, 400)
        }
        state.issued += 1
        const access = `access-${state.issued}`
        state.validTokens.clear()
        state.validTokens.add(access)
        return jsonResponse({ access_token: access, token_type: 'Bearer', expires_in: 3600 })
      }
      const basic = `Basic ${Buffer.from(`${AS_CLIENT}:${AS_SECRET}`).toString('base64')}`
      const authenticated = opts.publicClient
        ? seen.headers.get('authorization') === null &&
          seen.params.get('client_id') === AS_CLIENT &&
          !seen.params.has('client_secret')
        : seen.headers.get('authorization') === basic
      if (!authenticated) {
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
    expectedIssuer: AS_URL,
    idp: { tokenEndpoint: IDP_TOKEN_URL, clientId: IDP_CLIENT, clientSecret: IDP_SECRET },
    getIdToken: () => ID_TOKEN,
    storage: new MemoryOAuthStorage(),
    ...extra,
  } as never)

// No secret at the authorization server and no pinned issuer: what refuses
// then is the provider's own reading of discovery, not the SDK's stamp check.
const PUBLIC = { clientSecret: undefined, expectedIssuer: undefined }

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

test('enterprise: a client secret needs expectedIssuer; a public client may omit it', async () => {
  // Without the issuer, the MCP server's metadata would choose who gets the secret.
  assert.throws(
    () => makeProvider({ expectedIssuer: undefined }),
    /clientSecret needs expectedIssuer/,
  )
  makeProvider()
  const world = mockWorld({ publicClient: true })
  const idp = mockIdp()
  const pub = makeProvider({ ...PUBLIC, fetch: idp.fetchFn })
  assert.deepEqual(pub.clientInformation(), { client_id: AS_CLIENT })

  // And that path works end to end: the ID-JAG alone buys the token.
  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: pub, fetch: world.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true, mcp.results[0].error)
  await mcp.close()
  assert.equal(world.state.tokenRequests[0].params.get('client_id'), AS_CLIENT)
  assert.equal(world.state.tokenRequests[0].headers.get('authorization'), null)
  assert.equal(idp.calls[0].params.get('audience'), AS_URL)
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
    PUBLIC,
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
    PUBLIC,
    /MCP authorization server: .*requires https/,
  )
  await refusedBeforeAnyCredential(
    { tokenEndpoint: 'http://as.example.test/token' },
    PUBLIC,
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

test('enterprise: a refusal by the authorization server names that hop; the detail goes to the log, redacted', async () => {
  const world = mockWorld({
    grantError: {
      error: 'invalid_request',
      error_description: `Audience validation failed for assertion=${ID_JAG} secret=${AS_SECRET}`,
    },
  })
  const idp = mockIdp()
  const logs: string[] = []
  const provider = makeProvider({ fetch: idp.fetchFn })
  const err = await rejection(() =>
    provider.authorize({ fetch: world.fetchFn, onLog: (_l, m) => void logs.push(m) }),
  )
  assert.equal(err.hop, 'authorization-server')
  assert.equal(err.code, 'invalid_request')
  // Short and safe for whoever shows it; the server's words go to the log.
  assert.equal(
    err.message,
    'MCP authorization server refused the ID-JAG grant: invalid_request (HTTP 400)',
  )
  assert.equal(logs.length, 1)
  assert.match(logs[0], /Audience validation failed for assertion=\[redacted\] secret=\[redacted\]/)
  assertNoSecrets(logs[0], 'the log line')
  assert.equal(world.state.tokenRequests.length, 1, 'a final refusal is not retried')
  assert.equal(idp.calls.length, 1)
  assert.equal(await provider.tokens(), undefined)
})

// ── private_key_jwt (RFC 7523 section 2.2, audience per rfc7523bis) ───────

const EC_KEY = makeKey('P-256')
const RSA_KEY = makeKey('RSA')
const IDP_ISSUER = 'https://idp.example.test'

const keyMaterial = (key: { privateJwk: NodeJwk }): string[] =>
  ['d', 'p', 'q', 'dp', 'dq', 'qi']
    .map((m) => (key.privateJwk as Record<string, unknown>)[m])
    .filter((v): v is string => typeof v === 'string')

const jwtOptions = (extra: Record<string, unknown> = {}) => ({
  clientSecret: undefined,
  clientAuthMethod: 'private_key_jwt',
  privateKey: EC_KEY.privateJwk,
  algorithm: 'ES256',
  ...extra,
})

const idpJwt = (extra: Record<string, unknown> = {}) => ({
  idp: {
    tokenEndpoint: IDP_TOKEN_URL,
    clientId: IDP_CLIENT,
    clientAuthMethod: 'private_key_jwt',
    privateKey: RSA_KEY.privateJwk,
    algorithm: 'RS256',
    issuer: IDP_ISSUER,
    ...extra,
  },
})

const STORED_DISCOVERY = {
  authorizationServerUrl: `${AS_URL}/`,
  authorizationServerMetadata: { issuer: AS_URL, token_endpoint: `${AS_URL}/token` },
  resourceMetadata: { resource: MCP_URL, authorization_servers: [AS_URL] },
} as never

/** The two client assertions a provider makes: for the IdP and for the authorization server. */
const assertionsOf = async (provider: ReturnType<typeof makeProvider>, idp = mockIdp()) => {
  await provider.saveDiscoveryState(STORED_DISCOVERY)
  await provider.prepareTokenRequest()
  const headers = new Headers()
  const params = new URLSearchParams()
  await provider.addClientAuthentication?.(headers, params, `${AS_URL}/token`, undefined)
  return { forAs: params.get('client_assertion') ?? '', headers, params, idp }
}

test('private_key_jwt: what the options must hold, said when the provider is built', () => {
  makeProvider(jwtOptions())
  // The audience of a signed assertion must not come from the MCP server alone.
  assert.throws(
    () => makeProvider(jwtOptions({ expectedIssuer: undefined })),
    /private_key_jwt needs expectedIssuer/,
  )
  assert.throws(
    () => makeProvider(jwtOptions({ privateKey: undefined })),
    /needs privateKey and an algorithm/,
  )
  assert.throws(
    () => makeProvider(jwtOptions({ algorithm: 'HS256' })),
    /needs privateKey and an algorithm/,
  )
  assert.throws(
    () => makeProvider(jwtOptions({ clientSecret: AS_SECRET })),
    /clientSecret is not used with clientAuthMethod 'private_key_jwt'/,
  )
  assert.throws(
    () => makeProvider({ privateKey: EC_KEY.privateJwk }),
    /privateKey is only used with/,
  )
  assert.throws(
    () => makeProvider({ clientSecret: undefined, clientAuthMethod: 'client_secret_post' }),
    /needs clientSecret/,
  )
  assert.throws(
    () => makeProvider({ clientAuthMethod: 'none' }),
    /clientSecret is not used with clientAuthMethod 'none'/,
  )
  // The same at the IdP, where the audience is its issuer and has to be given.
  makeProvider(idpJwt())
  assert.throws(() => makeProvider(idpJwt({ issuer: undefined })), /needs idp\.issuer/)
  assert.throws(
    () => makeProvider(idpJwt({ issuer: 'http://idp.example.test' })),
    /Enterprise IdP issuer: .*requires https/,
  )
  assert.throws(
    () => makeProvider(idpJwt({ algorithm: undefined })),
    /needs idp\.privateKey and an idp\.algorithm/,
  )
  assert.throws(
    () => makeProvider(idpJwt({ clientSecret: IDP_SECRET })),
    /idp\.clientSecret is not used/,
  )
  assert.throws(
    () =>
      makeProvider({
        idp: {
          tokenEndpoint: IDP_TOKEN_URL,
          clientId: IDP_CLIENT,
          clientSecret: IDP_SECRET,
          privateKey: RSA_KEY.privateJwk,
        },
      }),
    /idp\.privateKey is only used with/,
  )
})

test('client assertion: the claims rfc7523bis asks for, each for its own server, a new jti every time', async () => {
  const idp = mockIdp()
  const provider = makeProvider({
    ...jwtOptions({ keyId: 'ec-1' }),
    ...idpJwt(),
    fetch: idp.fetchFn,
  })
  const before = Math.floor(Date.now() / 1000)
  const first = await assertionsOf(provider, idp)
  const second = await assertionsOf(provider, idp)

  const forAs = verifyJwt(first.forAs, EC_KEY.publicJwk)
  assert.ok(forAs, 'signed by the key for the authorization server')
  assert.deepEqual(forAs.header, { alg: 'ES256', typ: 'client-authentication+jwt', kid: 'ec-1' })
  assert.deepEqual(Object.keys(forAs.payload).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sub'])
  assert.equal(forAs.payload.iss, AS_CLIENT)
  assert.equal(forAs.payload.sub, AS_CLIENT)
  // The issuer identifier as the SOLE audience: a string, not a token endpoint URL.
  assert.equal(forAs.payload.aud, AS_URL)
  assert.ok((forAs.payload.iat as number) >= before)
  assert.equal((forAs.payload.exp as number) - (forAs.payload.iat as number), 60)
  assert.equal(first.params.get('client_assertion_type'), CLIENT_ASSERTION_TYPE)
  assert.equal(first.params.has('client_secret'), false)
  assert.equal(first.headers.get('authorization'), null)

  // The one for the IdP is a different token: its own issuer, its own key.
  const sent = idp.calls[0]
  assert.equal(sent.params.get('client_assertion_type'), CLIENT_ASSERTION_TYPE)
  assert.equal(sent.params.has('client_secret'), false)
  assert.equal(sent.headers.get('authorization'), null)
  const forIdp = verifyJwt(sent.params.get('client_assertion') ?? '', RSA_KEY.publicJwk)
  assert.ok(forIdp, 'signed by the key for the IdP')
  assert.equal(forIdp.header.alg, 'RS256')
  assert.equal('kid' in forIdp.header, false)
  assert.equal(forIdp.payload.iss, IDP_CLIENT)
  assert.equal(forIdp.payload.aud, IDP_ISSUER, 'never the audience of the other server')
  assert.equal((forIdp.payload.exp as number) - (forIdp.payload.iat as number), 60)
  // Neither key verifies the other's assertion.
  assert.equal(verifyJwt(first.forAs, RSA_KEY.publicJwk), undefined)

  const jtis = [
    forAs.payload.jti,
    forIdp.payload.jti,
    peekJwt(second.forAs).payload.jti,
    peekJwt(idp.calls[1].params.get('client_assertion') ?? '').payload.jti,
  ]
  assert.equal(new Set(jtis).size, 4, 'unique per request')
})

test('client assertion: every algorithm verifies, from a JWK and from a non-extractable CryptoKey', async () => {
  const keys = {
    ES256: EC_KEY,
    ES384: makeKey('P-384'),
    ES512: makeKey('P-521'),
    RSA: RSA_KEY,
  }
  const importSpec = (alg: string) =>
    alg.startsWith('ES')
      ? { name: 'ECDSA', namedCurve: alg === 'ES512' ? 'P-521' : `P-${alg.slice(2)}` }
      : {
          name: alg.startsWith('PS') ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5',
          hash: `SHA-${alg.slice(2)}`,
        }
  for (const algorithm of [
    'ES256',
    'ES384',
    'ES512',
    'RS256',
    'RS384',
    'RS512',
    'PS256',
    'PS384',
    'PS512',
  ]) {
    const key = keys[(algorithm.startsWith('ES') ? algorithm : 'RSA') as keyof typeof keys]
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'jwk',
      key.privateJwk as never,
      importSpec(algorithm),
      false,
      ['sign'],
    )
    for (const privateKey of [key.privateJwk, cryptoKey]) {
      const { forAs } = await assertionsOf(
        makeProvider({ ...jwtOptions({ privateKey, algorithm }), fetch: mockIdp().fetchFn }),
      )
      const verified = verifyJwt(forAs, key.publicJwk)
      assert.ok(verified, `${algorithm} verifies`)
      assert.equal(verified.header.alg, algorithm)
    }
  }
})

test('client assertion: a key that does not fit, or is broken, fails without describing the key', async () => {
  const rsaForPss = await globalThis.crypto.subtle.importKey(
    'jwk',
    RSA_KEY.privateJwk as never,
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const rsaSha384 = await globalThis.crypto.subtle.importKey(
    'jwk',
    RSA_KEY.privateJwk as never,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
    false,
    ['sign'],
  )
  const ecP384 = await globalThis.crypto.subtle.importKey(
    'jwk',
    makeKey('P-384').privateJwk as never,
    { name: 'ECDSA', namedCurve: 'P-384' },
    false,
    ['sign'],
  )
  const cases: [string, unknown, string[]][] = [
    ['ES256', RSA_KEY.privateJwk, keyMaterial(RSA_KEY)],
    ['RS256', EC_KEY.privateJwk, keyMaterial(EC_KEY)],
    ['ES384', EC_KEY.privateJwk, keyMaterial(EC_KEY)],
    ['ES256', EC_KEY.publicJwk, []],
    // A CryptoKey made for another scheme, hash or curve must not sign under
    // this name - WebCrypto itself would sign the last two without complaint.
    ['RS256', rsaForPss, []],
    ['RS256', rsaSha384, []],
    ['ES256', ecP384, []],
    [
      'ES256',
      { kty: 'EC', crv: 'P-256', d: 'bWFya2VyLWluLWEtYnJva2VuLWp3aw', x: 'AA', y: 'AA' },
      ['bWFya2VyLWluLWEtYnJva2VuLWp3aw'],
    ],
  ]
  for (const [algorithm, privateKey, material] of cases) {
    const provider = makeProvider(jwtOptions({ privateKey, algorithm }))
    await provider.saveDiscoveryState(STORED_DISCOVERY)
    const err = await rejection(() =>
      Promise.resolve(
        provider.addClientAuthentication?.(new Headers(), new URLSearchParams(), AS_URL, undefined),
      ),
    )
    assert.equal(err.hop, 'authorization-server')
    assert.equal(
      err.message,
      `Enterprise MCP authorization: could not sign the client assertion with ${algorithm}; check that privateKey is a private key for that algorithm`,
    )
    for (const secret of material) assert.ok(!err.message.includes(secret))
  }
  // At the IdP the same failure is an IdP-hop error, before anything is sent.
  const idp = mockIdp()
  const atIdp = makeProvider({ ...idpJwt({ privateKey: EC_KEY.privateJwk }), fetch: idp.fetchFn })
  await atIdp.saveDiscoveryState(STORED_DISCOVERY)
  const err = await rejection(() => atIdp.prepareTokenRequest())
  assert.equal(err.hop, 'idp')
  assert.equal(idp.calls.length, 0)
})

test('private_key_jwt: the key and the assertions are never printed, serialized or stored', async () => {
  const idp = mockIdp()
  const storage = new MemoryOAuthStorage()
  const provider = makeProvider({ ...jwtOptions(), ...idpJwt(), storage, fetch: idp.fetchFn })
  const { forAs } = await assertionsOf(provider, idp)
  const forIdp = idp.calls[0].params.get('client_assertion') ?? ''
  const secrets = [...keyMaterial(EC_KEY), ...keyMaterial(RSA_KEY), forAs, forIdp, ID_TOKEN, ID_JAG]
  const views = {
    inspect: inspect(provider, { depth: 8, showHidden: true }),
    json: JSON.stringify(provider),
    storage: JSON.stringify([...(storage as unknown as { map: Map<string, string> }).map]),
  }
  for (const [name, text] of Object.entries(views)) {
    for (const secret of secrets) assert.ok(!text.includes(secret), `${name} holds no key or token`)
  }
  // An IdP that echoes the request: the assertion is cut out like the ID token.
  const echoing = mockIdp()
  const echoProvider = makeProvider({ ...idpJwt(), fetch: echoing.fetchFn })
  await echoProvider.saveDiscoveryState(STORED_DISCOVERY)
  echoing.setReply(() =>
    jsonResponse(
      {
        error: 'invalid_client',
        error_description: `bad client_assertion=${echoing.calls.at(-1)?.params.get('client_assertion')}`,
      },
      401,
    ),
  )
  const err = await rejection(() => echoProvider.prepareTokenRequest())
  const sent = echoing.calls[0].params.get('client_assertion') ?? ''
  // Nor does the key itself survive in an error, should anything ever quote it.
  const quoting = makeProvider({
    ...idpJwt({ privateKey: EC_KEY.privateJwk, algorithm: 'ES256' }),
    fetch: async () => {
      throw new Error(`debug dump: ${JSON.stringify(EC_KEY.privateJwk)}`)
    },
  })
  await quoting.saveDiscoveryState(STORED_DISCOVERY)
  const quoted = await rejection(() => quoting.prepareTokenRequest())
  for (const secret of keyMaterial(EC_KEY)) {
    assert.ok(!quoted.message.includes(secret), 'no private member of the key')
  }
  assert.ok(sent.length > 100)
  assert.ok(!err.message.includes(sent))
  assert.ok(!err.message.includes(sent.slice(0, 48)), 'not even its beginning')
  assert.match(err.message, /client_assertion=\[redacted\]/)
  assert.ok(!err.message.includes(ID_TOKEN))
})

test('private_key_jwt: no assertion is signed for an authorization server that is not the expected one', async () => {
  const provider = makeProvider(jwtOptions())
  await provider.saveDiscoveryState({
    authorizationServerUrl: 'https://evil.example.test/',
    authorizationServerMetadata: {
      issuer: 'https://evil.example.test',
      token_endpoint: 'https://evil.example.test/token',
    },
    resourceMetadata: { resource: MCP_URL, authorization_servers: ['https://evil.example.test'] },
  } as never)
  const params = new URLSearchParams()
  const err = await rejection(() =>
    Promise.resolve(
      provider.addClientAuthentication?.(new Headers(), params, 'https://evil.example.test/token'),
    ),
  )
  assert.match(err.message, /expected "https:\/\/as\.example\.test"; refusing to send credentials/)
  assert.equal(params.has('client_assertion'), false)
})

test('private_key_jwt: connect end to end; a replayed or misaddressed assertion would be refused', async () => {
  const world = mockWorld({ clientJwk: EC_KEY.publicJwk })
  const idp = mockIdp()
  const provider = makeProvider({ ...jwtOptions(), fetch: idp.fetchFn })
  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: world.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true, mcp.results[0].error)
  // A second grant mid-session: a fresh assertion, or the server calls it a replay.
  world.state.validTokens.clear()
  assert.match(JSON.stringify(await callTool(mcp.tools, 'docs__echo', {})), /echo:ok/)
  await mcp.close()
  assert.equal(world.state.tokenRequests.length, 2)
  assert.equal(world.state.assertionRefusal, undefined)

  // The server's own line: the same client, the right key, the IdP's audience.
  const wrongAudience = makeProvider({
    ...jwtOptions(),
    fetch: idp.fetchFn,
    serverUrl: MCP_URL,
  })
  const strict = mockWorld({ clientJwk: EC_KEY.publicJwk, clientId: 'someone-else' })
  const err = await rejection(() => wrongAudience.authorize({ fetch: strict.fetchFn }))
  assert.equal(
    err.message,
    'MCP authorization server refused the ID-JAG grant: invalid_client (HTTP 401)',
  )
  assert.equal(strict.state.assertionRefusal, 'client')
})

// ── CIMD as the client id ─────────────────────────────────────────────────

const CIMD_URL = 'https://client.example.test/oauth/client.json'

test('CIMD: a clientId that is a URL must be an https document URL, and takes no secret', async () => {
  for (const clientId of [
    'http://client.example.test/oauth/client.json',
    'https://client.example.test/',
    'https://client.example.test',
    'ftp://client.example.test/client.json',
  ]) {
    assert.throws(
      () => makeProvider({ clientId, clientSecret: undefined }),
      /client ID metadata document: it requires https and a non-root path/,
      clientId,
    )
  }
  // A document anyone can read establishes no shared secret.
  assert.throws(() => makeProvider({ clientId: CIMD_URL }), /cannot be used with clientSecret/)
  makeProvider({ clientId: CIMD_URL, clientSecret: undefined })
  makeProvider({ clientId: 'urn:example:agent' })

  // With private_key_jwt the URL is the client in the assertion. (The server
  // side of CIMD - fetching the document and its keys - runs over real sockets
  // in the Node package's test.)
  const world = mockWorld({ clientJwk: EC_KEY.publicJwk, clientId: CIMD_URL })
  const idp = mockIdp()
  const provider = makeProvider({ ...jwtOptions({ clientId: CIMD_URL }), fetch: idp.fetchFn })
  await provider.authorize({ fetch: world.fetchFn })
  const assertion = peekJwt(world.state.tokenRequests[0].params.get('client_assertion') ?? '')
  assert.equal(assertion.payload.iss, CIMD_URL)
  assert.equal(assertion.payload.sub, CIMD_URL)
  assert.equal(assertion.payload.aud, AS_URL)
})

// ── a refusal in the middle of a session ──────────────────────────────────

test('enterprise: a server that starts refusing mid-session gives a clean error; the detail goes to the log, redacted', async () => {
  const world = mockWorld({ clientJwk: EC_KEY.publicJwk })
  const idp = mockIdp()
  const logs: { level: string; message: string }[] = []
  const mcp = await connectMcpHttp(
    {
      docs: {
        url: MCP_URL,
        authProvider: makeProvider({ ...jwtOptions(), fetch: idp.fetchFn }),
        fetch: world.fetchFn,
      },
    },
    { onLog: (level, message) => void logs.push({ level, message }) },
  )
  assert.equal(mcp.results[0].connected, true, mcp.results[0].error)
  const before = logs.length

  // The token dies and the server now refuses every grant, quoting the whole
  // request - grant, client assertion and all - in its answer.
  world.state.validTokens.clear()
  world.state.echoRequest = true
  let thrown: unknown
  try {
    await callTool(mcp.tools, 'docs__echo', {})
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
  assert.equal(idp.calls.length, 2, 'one fresh exchange, and no second try')

  world.state.echoRequest = false
  world.state.refuse = { error: 'access_denied', error_description: 'The user is not licensed' }
  await assert.rejects(
    () => callTool(mcp.tools, 'docs__echo', {}),
    (err: unknown) =>
      err instanceof EnterpriseOAuthError &&
      err.message === 'MCP authorization server refused the ID-JAG grant: access_denied (HTTP 400)',
  )
  await mcp.close()

  const detail = logs.slice(before).filter((l) => l.message.includes('enterprise authorization'))
  assert.equal(detail.length, 2)
  assert.ok(detail.every((l) => l.level === 'warn'))
  assert.match(
    detail[0].message,
    /refused the ID-JAG grant with 400 invalid_request: cannot accept/,
  )
  assert.match(detail[0].message, /\[redacted\]/)
  assert.match(detail[1].message, /400 access_denied: The user is not licensed/)
  const sent = world.state.tokenRequests.map((r) => r.params.get('client_assertion') ?? 'none')
  const everything = [thrown.message, inspect(thrown), ...logs.map((l) => l.message)].join('\n')
  for (const secret of [...sent, ...keyMaterial(EC_KEY), ID_JAG, ID_TOKEN, IDP_SECRET]) {
    // Not even the beginning of one: a clipped token is still its claims.
    for (const needle of secret.length > 60 ? [secret, secret.slice(0, 48)] : [secret]) {
      assert.ok(
        !everything.includes(needle),
        'no grant, assertion, key or secret in the error or the log',
      )
    }
  }
})

test('enterprise: with no onLog the detail goes to the package logger, redacted; a throwing log changes nothing', async () => {
  const world = mockWorld({
    grantError: { error: 'bad code "><script>', error_description: `no: ${ID_JAG} ${AS_SECRET}` },
  })
  const idp = mockIdp()
  const warned: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => void warned.push(args.join(' '))
  try {
    const err = await rejection(() =>
      makeProvider({ fetch: idp.fetchFn }).authorize({ fetch: world.fetchFn }),
    )
    // A code that is not a code is not repeated.
    assert.equal(
      err.message,
      'MCP authorization server refused the ID-JAG grant: no error code (HTTP 400)',
    )
    assert.equal(err.code, undefined)
  } finally {
    console.warn = realWarn
  }
  assert.equal(warned.length, 1)
  assert.match(warned[0], /^\[agent-web\] \[mcp\] enterprise authorization/)
  assert.match(warned[0], /\[redacted\] \[redacted\]/)
  assertNoSecrets(warned[0], 'the logger line')

  const loud = await rejection(() =>
    makeProvider({ fetch: idp.fetchFn }).authorize({
      fetch: world.fetchFn,
      onLog: () => {
        throw new Error('log sink exploded')
      },
    }),
  )
  assert.equal(loud.hop, 'authorization-server')

  // A network failure on the grant is named too, and its text is not passed on.
  const said: string[] = []
  const down = await rejection(() =>
    makeProvider({ fetch: idp.fetchFn }).authorize({
      onLog: (_l, m) => void said.push(m),
      fetch: async (url, init) => {
        if (String(url).endsWith('/token')) throw new Error(`socket hang up sending ${ID_JAG}`)
        return world.fetchFn(url, init)
      },
    }),
  )
  assert.equal(down.message, 'MCP authorization server could not be reached for the ID-JAG grant')
  assertNoSecrets(said.join('\n'), 'the log')
})
