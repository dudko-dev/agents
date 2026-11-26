import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginMcpOAuth,
  BrowserOAuthProvider,
  checkAuthorizationResponseIssuer,
  connectMcpHttp,
  diagnoseMcpCors,
  finishMcpOAuth,
  flattenContent,
  MemoryOAuthStorage,
  readOAuthCallback,
  UnauthorizedError,
  VaultOAuthStorage,
} from '../dist/mcp.js'

// ── A fake remote MCP server + authorization server, spoken over a mock fetch.
// Everything the OAuth story needs (RFC 9728 resource metadata, AS metadata,
// RFC 7591 dynamic registration, PKCE code exchange, refresh-token rotation,
// 401 on a stale token) happens here, so the tests exercise the real SDK
// state machine without a network.

const MCP_ORIGIN = 'https://mcp.example.test'
const MCP_URL = `${MCP_ORIGIN}/mcp`
const AS_URL = 'https://as.example.test'
const REDIRECT_URL = 'https://app.example.test/callback'

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

interface MockOptions {
  requireAuth?: boolean
  /** Advertise `client_id_metadata_document_supported` (CIMD). */
  cimd?: boolean
  /** Advertise `authorization_response_iss_parameter_supported` (RFC 9207). */
  issParameter?: boolean
  tools?: {
    name: string
    description?: string
    inputSchema?: unknown
    outputSchema?: unknown
    annotations?: unknown
  }[]
  failListTools?: boolean
  /** Do not advertise the `tools` capability in the initialize result. */
  noToolsCapability?: boolean
  /** Never stop paginating: `same` repeats one cursor, `fresh` makes up a new one each page. */
  endlessCursor?: 'same' | 'fresh'
  /** Answer `tools/call` for this name with a JSON-RPC error, as a 2.x server does for an unknown tool. */
  unknownTool?: string
  /** The whole `tools/call` result for a tool, by name. */
  results?: Record<string, Record<string, unknown>>
  /** Answer `tools/call` for this tool with 403 `insufficient_scope`, asking for `scope`. */
  forbidTool?: { name: string; scope: string }
  /** Publish a token endpoint over plain http on a host that is not loopback. */
  insecureTokenEndpoint?: boolean
  /** The `issuer` the authorization server's metadata claims (default: its own URL). */
  metadataIssuer?: string
  /** Paginate tools/list with this many tools per page. */
  pageSize?: number
  /** Never answer tools/list (a hung server). */
  hangListTools?: boolean
}

const DEFAULT_TOOLS = [
  {
    name: 'echo',
    description: 'Echo the input back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
]

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const createMockServer = (opts: MockOptions = {}) => {
  const tools = opts.tools ?? DEFAULT_TOOLS
  const requests: { method: string; url: string; auth?: string; body?: string }[] = []
  const state = {
    validTokens: new Set<string>(['access-1']),
    registrations: 0,
    grants: [] as string[],
    issued: 1,
    lastCodeVerifier: undefined as string | undefined,
    lastTokenClientId: undefined as string | undefined,
    toolCalls: 0,
    lastRegistration: undefined as Record<string, unknown> | undefined,
    /** Set to answer the next token request with invalid_client. */
    rejectClient: false,
    /** Set to answer dynamic registration with invalid_client_metadata. */
    failRegistration: false,
    /** Set to answer refresh_token grants with a transient 503. */
    failRefresh: false,
    /** tools/list requests answered, with the cursor each one carried. */
    listCursors: [] as (string | undefined)[],
    /** tools/call requests refused with 403 `insufficient_scope`. */
    forbidden: 0,
    /** The `scope` parameter of every token request, in order. */
    tokenScopes: [] as (string | undefined)[],
  }

  const handleRpc = (msg: RpcMessage): unknown => {
    if (msg.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion,
          capabilities: opts.noToolsCapability ? {} : { tools: { listChanged: true } },
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        },
      }
    }
    // Notifications carry no id and expect no response.
    if (msg.id === undefined) return undefined
    if (msg.method === 'tools/list') {
      if (opts.failListTools) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'tools/list exploded' },
        }
      }
      const cursor = (msg.params as { cursor?: string } | undefined)?.cursor
      state.listCursors.push(cursor)
      if (opts.endlessCursor) {
        const nextCursor =
          opts.endlessCursor === 'same' ? 'again' : `page-${state.listCursors.length}`
        return { jsonrpc: '2.0', id: msg.id, result: { tools: cursor ? [] : tools, nextCursor } }
      }
      if (opts.pageSize) {
        const start = Number(cursor ?? 0)
        const end = start + opts.pageSize
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: tools.slice(start, end),
            ...(end < tools.length ? { nextCursor: String(end) } : {}),
          },
        }
      }
      return { jsonrpc: '2.0', id: msg.id, result: { tools } }
    }
    if (msg.method === 'tools/call') {
      state.toolCalls += 1
      const params = (msg.params ?? {}) as { name?: string; arguments?: unknown }
      if (params.name === opts.unknownTool) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: `Tool ${params.name} not found` },
        }
      }
      const fixed = params.name ? opts.results?.[params.name] : undefined
      if (fixed) return { jsonrpc: '2.0', id: msg.id, result: fixed }
      if (params.name === 'boom') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'kaboom' }], isError: true },
        }
      }
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          // Echo the name the SERVER received, so a test asserting that a
          // sanitized key still dispatches to the original name is real.
          content: [
            { type: 'text', text: `${params.name}:${JSON.stringify(params.arguments ?? {})}` },
          ],
        },
      }
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }
  }

  const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const href = String(url)
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers as HeadersInit | undefined)
    requests.push({
      method,
      url: href,
      auth: headers.get('authorization') ?? undefined,
      body: typeof init.body === 'string' ? init.body : undefined,
    })

    if (href.includes('/.well-known/oauth-protected-resource')) {
      return jsonResponse({
        resource: MCP_URL,
        authorization_servers: [AS_URL],
        scopes_supported: ['mcp:tools'],
      })
    }

    if (
      href.includes('/.well-known/oauth-authorization-server') ||
      href.includes('/.well-known/openid-configuration')
    ) {
      if (!href.startsWith(AS_URL)) return new Response('not found', { status: 404 })
      return jsonResponse({
        issuer: opts.metadataIssuer ?? AS_URL,
        authorization_endpoint: `${AS_URL}/authorize`,
        token_endpoint: opts.insecureTokenEndpoint
          ? `${AS_URL.replace('https:', 'http:')}/token`
          : `${AS_URL}/token`,
        registration_endpoint: `${AS_URL}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        ...(opts.cimd ? { client_id_metadata_document_supported: true } : {}),
        ...(opts.issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
      })
    }

    if (href === `${AS_URL}/register`) {
      state.registrations += 1
      const metadata = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
      state.lastRegistration = metadata
      if (state.failRegistration) {
        return jsonResponse(
          { error: 'invalid_client_metadata', error_description: 'redirect_uri not allowed' },
          400,
        )
      }
      return jsonResponse(
        { ...metadata, client_id: `dcr-client-${state.registrations}`, client_id_issued_at: 1 },
        201,
      )
    }

    if (href === `${AS_URL}/token`) {
      const params = new URLSearchParams(String(init.body ?? ''))
      const grant = params.get('grant_type') ?? ''
      state.grants.push(grant)
      state.lastTokenClientId = params.get('client_id') ?? undefined
      state.tokenScopes.push(params.get('scope') ?? undefined)
      // "The client you claim to be is not registered here" — what an AS says
      // after it has forgotten (or rotated away) a dynamic registration.
      if (state.rejectClient) {
        return jsonResponse({ error: 'invalid_client' }, 401)
      }
      if (grant === 'authorization_code') {
        // PKCE is mandatory for a public client — fail loudly if the SDK ever
        // stops sending the verifier.
        state.lastCodeVerifier = params.get('code_verifier') ?? undefined
        if (!state.lastCodeVerifier) {
          return jsonResponse({ error: 'invalid_request' }, 400)
        }
        if (params.get('code') !== 'auth-code-1') {
          return jsonResponse({ error: 'invalid_grant' }, 400)
        }
      } else if (grant === 'refresh_token') {
        if (state.failRefresh) {
          // A transient authorization-server outage, NOT a dead token.
          return jsonResponse({ error: 'server_error' }, 503)
        }
        if (!params.get('refresh_token')?.startsWith('refresh-')) {
          return jsonResponse({ error: 'invalid_grant' }, 400)
        }
      }
      state.issued += 1
      const access = `access-${state.issued}`
      // Rotation: the previous access token stops working, exactly like a real
      // AS that issues short-lived tokens.
      state.validTokens = new Set([access])
      return jsonResponse({
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `refresh-${state.issued}`,
        scope: 'mcp:tools',
      })
    }

    if (href.startsWith(MCP_URL)) {
      if (method === 'GET') return new Response(null, { status: 405 })
      if (method === 'DELETE') return new Response(null, { status: 200 })
      if (opts.requireAuth) {
        const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
        if (!state.validTokens.has(token)) {
          return jsonResponse({ error: 'unauthorized' }, 401, {
            'www-authenticate': `Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
          })
        }
      }
      const parsed = JSON.parse(String(init.body ?? 'null')) as RpcMessage | RpcMessage[]
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      if (opts.hangListTools && messages.some((m) => m.method === 'tools/list')) {
        return new Promise<Response>(() => {})
      }
      const forbidden = messages.find(
        (m) => m.method === 'tools/call' && m.params?.name === opts.forbidTool?.name,
      )
      if (forbidden && opts.forbidTool) {
        state.forbidden += 1
        return jsonResponse({ error: 'insufficient_scope' }, 403, {
          'www-authenticate': `Bearer error="insufficient_scope", scope="${opts.forbidTool.scope}", resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
        })
      }
      const replies = messages.map(handleRpc).filter((r) => r !== undefined)
      if (replies.length === 0) return new Response(null, { status: 202 })
      return jsonResponse(replies.length === 1 ? replies[0] : replies)
    }

    return new Response('not found', { status: 404 })
  }

  return { fetchFn, state, requests }
}

const makeProvider = (onRedirect?: (url: URL) => void) =>
  new BrowserOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    storage: new MemoryOAuthStorage(),
    clientName: 'agent-web-test',
    onRedirect,
  })

// dynamicTool's execute takes AI-SDK call options we don't need here.
const callTool = (
  tools: Record<string, unknown>,
  name: string,
  args: unknown,
): Promise<unknown> => {
  const tool = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }
  return tool.execute(args, {})
}

// ── flattenContent ──────────────────────────────────────────────────────────

test('flattenContent: joins all-text parts and passes other shapes through', () => {
  assert.equal(
    flattenContent([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]),
    'a\nb',
  )
  assert.equal(flattenContent('raw'), 'raw')
  assert.deepEqual(flattenContent([]), [])
  const mixed = flattenContent([
    { type: 'text', text: 'a' },
    { type: 'image', data: 'zzz', mimeType: 'image/png' },
  ]) as unknown[]
  assert.equal(mixed[0], 'a')
  assert.deepEqual(mixed[1], { type: 'image', data: 'zzz', mimeType: 'image/png' })
})

// ── connect / mount / dispatch ──────────────────────────────────────────────

test('connectMcpHttp: mounts prefixed tools and dispatches through the transport', async () => {
  const mock = createMockServer()
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })

  assert.deepEqual(
    mcp.results.map((r) => ({ name: r.name, connected: r.connected })),
    [{ name: 'docs', connected: true }],
  )
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  assert.equal(mcp.catalog[0].description, 'Echo the input back')

  const out = await callTool(mcp.tools, 'docs__echo', { text: 'hi' })
  assert.equal(out, 'echo:{"text":"hi"}')
  await mcp.close()
})

test('connectMcpHttp: static headers reach the server', async () => {
  const mock = createMockServer()
  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, headers: { Authorization: 'Bearer static-token' }, fetch: mock.fetchFn },
  })
  await mcp.close()
  const posted = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith(MCP_URL))
  assert.ok(posted.length > 0)
  assert.ok(posted.every((r) => r.auth === 'Bearer static-token'))
})

test('connectMcpHttp: an MCP result with isError becomes a thrown tool error', async () => {
  const mock = createMockServer({ tools: [{ name: 'boom', inputSchema: { type: 'object' } }] })
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  await assert.rejects(() => callTool(mcp.tools, 'docs__boom', {}), /kaboom/)
  await mcp.close()
})

test('connectMcpHttp: sanitized name collisions are suffixed, not dropped', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'a.b', inputSchema: { type: 'object' } },
      { name: 'a/b', inputSchema: { type: 'object' } },
    ],
  })
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  assert.deepEqual(Object.keys(mcp.tools), ['docs__a_b', 'docs__a_b_2'])
  // Both keys still dispatch to their ORIGINAL server-side names.
  assert.equal(await callTool(mcp.tools, 'docs__a_b', { x: 1 }), 'a.b:{"x":1}')
  assert.equal(await callTool(mcp.tools, 'docs__a_b_2', { x: 1 }), 'a/b:{"x":1}')
  await mcp.close()
})

test('connectMcpHttp: tools whose prefixed name exceeds 64 chars are skipped', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'x'.repeat(70), inputSchema: { type: 'object' } },
      { name: 'ok', inputSchema: { type: 'object' } },
    ],
  })
  const logs: string[] = []
  const mcp = await connectMcpHttp(
    {
      docs: { url: MCP_URL, fetch: mock.fetchFn },
    },
    { onLog: (_l, m) => logs.push(m) },
  )
  assert.deepEqual(Object.keys(mcp.tools), ['docs__ok'])
  assert.ok(logs.some((m) => m.includes('64-char name limit')))
  await mcp.close()
})

test('connectMcpHttp: a failing server is reported, never thrown, and others still mount', async () => {
  const mock = createMockServer()
  const mcp = await connectMcpHttp({
    dead: {
      url: 'https://nope.example.test/mcp',
      fetch: async () => new Response('no', { status: 500 }),
    },
    docs: { url: MCP_URL, fetch: mock.fetchFn },
  })
  const dead = mcp.results.find((r) => r.name === 'dead')
  assert.equal(dead?.connected, false)
  assert.ok(dead?.error)
  assert.equal(mcp.results.find((r) => r.name === 'docs')?.connected, true)
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  await mcp.close()
})

test('connectMcpHttp: rejects headers + getHeaders on the same server', async () => {
  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, headers: { a: 'b' }, getHeaders: () => ({ c: 'd' }) },
  })
  assert.match(mcp.results[0].error ?? '', /either headers or getHeaders/)
})

test('connectMcpHttp: closes the client when listTools fails after connect', async () => {
  const mock = createMockServer({ failListTools: true })
  const logs: string[] = []
  const mcp = await connectMcpHttp(
    { docs: { url: MCP_URL, fetch: mock.fetchFn } },
    { onLog: (_l, m) => logs.push(m) },
  )
  assert.equal(mcp.results[0].connected, false)
  // The transport must have been torn down — otherwise the SSE stream leaks
  // for the lifetime of the tab.
  assert.ok(logs.some((m) => m.includes('transport closed')))
})

test('two server names that sanitize to the same prefix keep both tool sets', async () => {
  // "docs.v1" and "docs/v1" both sanitize to "docs_v1__": a connector that
  // purged by prefix would unmount the first server while still listing it in
  // the catalogue, and route its name to the OTHER server's client.
  const a = createMockServer()
  const b = createMockServer()
  const mcp = await connectMcpHttp({
    'docs.v1': { url: MCP_URL, fetch: a.fetchFn },
    'docs/v1': { url: MCP_URL, fetch: b.fetchFn },
  })

  assert.deepEqual(Object.keys(mcp.tools), ['docs_v1__echo', 'docs_v1__echo_2'])
  assert.deepEqual(
    mcp.catalog.map((c) => `${c.server}:${c.name}`),
    ['docs.v1:docs_v1__echo', 'docs/v1:docs_v1__echo_2'],
  )

  await callTool(mcp.tools, 'docs_v1__echo', {})
  assert.equal(a.state.toolCalls, 1, 'the first key reaches the first server')
  assert.equal(b.state.toolCalls, 0)
  await callTool(mcp.tools, 'docs_v1__echo_2', {})
  assert.equal(b.state.toolCalls, 1, 'the suffixed key reaches the second server')
  await mcp.close()
})

test('refreshServer: a nested server prefix is not swept away', async () => {
  // "a__b" starts with "a__", so a prefix-based purge during a refresh of "a"
  // would silently unmount every tool of the OTHER server.
  const outer = createMockServer({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] })
  const inner = createMockServer({ tools: [{ name: 'y', inputSchema: { type: 'object' } }] })
  const mcp = await connectMcpHttp({
    a: { url: MCP_URL, fetch: outer.fetchFn },
    a__b: { url: MCP_URL, fetch: inner.fetchFn },
  })
  assert.deepEqual(Object.keys(mcp.tools).sort(), ['a__b__y', 'a__x'])

  await mcp.refreshServer('a')

  assert.deepEqual(Object.keys(mcp.tools).sort(), ['a__b__y', 'a__x'])
  assert.equal(mcp.catalog.length, 2)
  await mcp.close()
})

test('refreshServer: re-lists a server and rewrites its entries in place', async () => {
  const tools = [{ name: 'echo', inputSchema: { type: 'object' } }]
  const mock = createMockServer({ tools })
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  const liveTools = mcp.tools
  assert.deepEqual(Object.keys(liveTools), ['docs__echo'])

  tools.push({ name: 'added-later', inputSchema: { type: 'object' } })
  await mcp.refreshServer('docs')

  // Same object reference — a live agent config sees the new tool.
  assert.equal(mcp.tools, liveTools)
  assert.deepEqual(Object.keys(liveTools).sort(), ['docs__added-later', 'docs__echo'])
  assert.equal(mcp.catalog.filter((c) => c.server === 'docs').length, 2)
  await assert.rejects(() => mcp.refreshServer('nope'), /is not connected/)
  await mcp.close()
})

// ── OAuth: storage, callback parsing, CSRF ──────────────────────────────────

test('BrowserOAuthProvider: persists tokens and reports expiry with a skew', async () => {
  const provider = makeProvider()
  assert.equal(await provider.isAccessTokenExpired(), true, 'no token yet')
  assert.equal(await provider.isAuthorized(), false)

  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 })
  assert.equal((await provider.tokens())?.access_token, 'a')
  assert.equal(await provider.isAccessTokenExpired(), false)
  assert.equal(await provider.isAuthorized(), true)

  // Inside the 30s skew window: treated as already expired.
  await provider.saveTokens({ access_token: 'b', token_type: 'Bearer', expires_in: 10 })
  assert.equal(await provider.isAccessTokenExpired(), true)

  // No expires_in: the AS didn't say, so we wait for a 401 instead of guessing.
  await provider.saveTokens({ access_token: 'c', token_type: 'Bearer' })
  assert.equal(await provider.isAccessTokenExpired(), false)
})

test('BrowserOAuthProvider: invalidateCredentials drops the right scopes', async () => {
  const provider = makeProvider()
  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' })
  await provider.saveClientInformation({ client_id: 'c1' })
  await provider.saveCodeVerifier('verifier')

  await provider.invalidateCredentials('tokens')
  assert.equal(await provider.tokens(), undefined)
  assert.deepEqual(await provider.clientInformation(), { client_id: 'c1' })

  await provider.invalidateCredentials('all')
  assert.equal(await provider.clientInformation(), undefined)
  await assert.rejects(() => provider.codeVerifier(), /No PKCE code verifier/)
})

test('BrowserOAuthProvider: state is single-use and mismatches fail', async () => {
  const provider = makeProvider()
  const issued = await provider.state()
  assert.equal(issued.length, 64)
  assert.equal(await provider.verifyState('something-else'), false)

  const second = await provider.state()
  assert.equal(await provider.verifyState(second), true)
  // Replay of the same value must not pass twice.
  assert.equal(await provider.verifyState(second), false)
})

test('BrowserOAuthProvider: refuses to carry tokens over plaintext http', () => {
  const opts = { redirectUrl: REDIRECT_URL, storage: new MemoryOAuthStorage() }
  assert.throws(
    () => new BrowserOAuthProvider({ ...opts, serverUrl: 'http://mcp.example.test/mcp' }),
    /requires https/,
  )
  // A registrable host that merely starts with "localhost" is not loopback.
  assert.throws(
    () => new BrowserOAuthProvider({ ...opts, serverUrl: 'http://localhost.attacker.test/mcp' }),
    /requires https/,
  )
  assert.ok(new BrowserOAuthProvider({ ...opts, serverUrl: 'http://localhost:8080/mcp' }))
  assert.ok(new BrowserOAuthProvider({ ...opts, serverUrl: 'http://127.0.0.1:8080/mcp' }))
})

test('BrowserOAuthProvider: two tenants on one URL path do not share credentials', async () => {
  // Same origin and path, different query — a namespace that ignored the query
  // would hand tenant B the bearer token minted for tenant A.
  const storage = new MemoryOAuthStorage()
  const a = new BrowserOAuthProvider({
    serverUrl: `${MCP_URL}?tenant=a`,
    redirectUrl: REDIRECT_URL,
    storage,
  })
  const b = new BrowserOAuthProvider({
    serverUrl: `${MCP_URL}?tenant=b`,
    redirectUrl: REDIRECT_URL,
    storage,
  })

  await a.saveTokens({ access_token: 'tenant-a', token_type: 'Bearer' })
  assert.equal((await a.tokens())?.access_token, 'tenant-a')
  assert.equal(await b.tokens(), undefined)
})

test('VaultOAuthStorage: round-trips through the encrypted IndexedDB vault', async () => {
  const storage = new VaultOAuthStorage({ dbName: `oauth-test-${Date.now()}` })
  const provider = new BrowserOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    storage,
  })

  await provider.saveTokens({ access_token: 'stored', token_type: 'Bearer', expires_in: 3600 })
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })

  assert.equal((await provider.tokens())?.access_token, 'stored')
  assert.equal((await provider.clientInformation())?.client_id, 'dcr-client-1')
  assert.equal(await provider.isAccessTokenExpired(), false)

  await provider.reset()
  assert.equal(await provider.tokens(), undefined)
})

test('readOAuthCallback: reads query params, hash routes, and errors', () => {
  assert.deepEqual(readOAuthCallback('https://app.test/cb?code=abc&state=xyz'), {
    code: 'abc',
    state: 'xyz',
    iss: undefined,
    error: undefined,
    errorDescription: undefined,
  })
  assert.deepEqual(readOAuthCallback('https://app.test/#/cb?code=abc&state=xyz'), {
    code: 'abc',
    state: 'xyz',
    iss: undefined,
    error: undefined,
    errorDescription: undefined,
  })
  assert.equal(readOAuthCallback('https://app.test/'), undefined)
  const denied = readOAuthCallback('https://app.test/cb?error=access_denied&error_description=nope')
  assert.equal(denied?.error, 'access_denied')
  assert.equal(denied?.errorDescription, 'nope')
})

test('finishMcpOAuth: refuses a callback whose state does not match', async () => {
  const provider = makeProvider()
  await provider.state()
  await assert.rejects(
    () => finishMcpOAuth(provider, { code: 'auth-code-1', state: 'forged' }),
    /state mismatch/,
  )
})

test('finishMcpOAuth: surfaces an authorization-server error verbatim', async () => {
  const provider = makeProvider()
  await assert.rejects(
    () => finishMcpOAuth(provider, { error: 'access_denied', errorDescription: 'user said no' }),
    /access_denied - user said no/,
  )
})

// ── OAuth end-to-end: DCR → PKCE → tokens → refresh ─────────────────────────

test('OAuth: unauthenticated connect registers dynamically and asks for authorization', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })

  assert.equal(mcp.results[0].connected, false)
  assert.equal(mcp.results[0].needsAuthorization, true, 'the UI needs a way to tell auth apart')
  assert.equal(mock.state.registrations, 1, 'dynamic client registration ran')

  const url = provider.authorizationUrl
  assert.ok(url, 'the authorization URL is recorded for the app to use')
  assert.equal(url.origin + url.pathname, `${AS_URL}/authorize`)
  assert.equal(url.searchParams.get('client_id'), 'dcr-client-1')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(url.searchParams.get('code_challenge'), 'PKCE challenge present')
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URL)
  // The registration is persisted, so a page reload does not re-register.
  assert.deepEqual((await provider.clientInformation())?.client_id, 'dcr-client-1')
})

test('DCR: the registration request describes a public PKCE client', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = new BrowserOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    storage: new MemoryOAuthStorage(),
    clientName: 'agent-web-test',
  })
  await connectMcpHttp({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  const sent = mock.state.lastRegistration
  assert.ok(sent, 'a registration body was posted')
  assert.equal(sent.client_name, 'agent-web-test')
  assert.deepEqual(sent.redirect_uris, [REDIRECT_URL])
  assert.deepEqual(sent.response_types, ['code'])
  // Without refresh_token in grant_types the AS may never issue one, and every
  // expiry would become an interactive re-authorization.
  assert.deepEqual(sent.grant_types, ['authorization_code', 'refresh_token'])
  // A browser cannot hold a client_secret; PKCE is what protects the exchange.
  assert.equal(sent.token_endpoint_auth_method, 'none')
  // Scope comes from the resource metadata when the caller didn't pin one.
  assert.equal(sent.scope, 'mcp:tools')
})

test('DCR: a stored registration is reused instead of registering again', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()

  await connectMcpHttp({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })
  await connectMcpHttp({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  assert.equal(mock.state.registrations, 1, 'a reload must not mint a second client')
  assert.equal((await provider.clientInformation())?.client_id, 'dcr-client-1')
})

test('DCR: an invalid_client response re-registers and restarts authorization', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  // A registration the AS has since forgotten (redeployed, pruned, rotated).
  await provider.saveClientInformation({ client_id: 'forgotten-client' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-1',
  })
  mock.state.validTokens.clear()
  mock.state.rejectClient = true

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })

  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(mock.state.registrations, 1, 'the dead client_id was replaced by a new registration')
  assert.equal((await provider.clientInformation())?.client_id, 'dcr-client-1')
  // Credentials tied to the dead client must go, or every later attempt
  // retries the same doomed refresh.
  assert.equal(await provider.tokens(), undefined)
  assert.ok(provider.authorizationUrl)
  assert.equal(provider.authorizationUrl.searchParams.get('client_id'), 'dcr-client-1')
})

test('DCR: a rejected registration surfaces the reason instead of a bare 401', async () => {
  const mock = createMockServer({ requireAuth: true })
  mock.state.failRegistration = true
  const provider = makeProvider()

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })

  assert.equal(mcp.results[0].connected, false)
  assert.match(mcp.results[0].error ?? '', /redirect_uri not allowed/)
  assert.equal(await provider.clientInformation(), undefined, 'nothing half-registered was stored')
})

test('OAuth: full flow — authorize, exchange the code, connect, call a tool', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()

  const first = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(first.results[0].needsAuthorization, true)

  // The user comes back from the AS with ?code=…&state=…
  const state = provider.authorizationUrl?.searchParams.get('state') ?? undefined
  await finishMcpOAuth(provider, { code: 'auth-code-1', state }, { fetch: mock.fetchFn })
  assert.ok(mock.state.lastCodeVerifier, 'the code was exchanged with a PKCE verifier')
  assert.equal((await provider.tokens())?.access_token, 'access-2')

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)
  assert.equal(await callTool(mcp.tools, 'docs__echo', { text: 'hi' }), 'echo:{"text":"hi"}')

  const mcpPosts = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith(MCP_URL))
  assert.ok(mcpPosts.at(-1)?.auth === 'Bearer access-2', 'the bearer token is attached')
  await mcp.close()
})

test('OAuth: an access token that expires mid-session is refreshed and the call retried', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-1',
  })

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)

  // The server now rejects the token we hold — exactly what an expiry looks
  // like from the client's side.
  mock.state.validTokens.clear()
  const out = await callTool(mcp.tools, 'docs__echo', { text: 'after-expiry' })

  assert.equal(out, 'echo:{"text":"after-expiry"}', 'the tool call survived the 401')
  assert.ok(mock.state.grants.includes('refresh_token'), 'the refresh grant was used')
  assert.equal((await provider.tokens())?.access_token, 'access-2', 'the new token was persisted')
  assert.equal(mock.state.registrations, 0, 're-registration is not needed to refresh')
  await mcp.close()
})

test('OAuth: an already-expired token is refreshed BEFORE the first request', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  // expires_in inside the skew window: known-dead before we even connect.
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 5,
    refresh_token: 'refresh-1',
  })
  mock.state.validTokens.clear()

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)

  // No MCP request was ever made with the dead token: the refresh came first.
  const mcpPosts = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith(MCP_URL))
  assert.ok(mcpPosts.length > 0)
  assert.ok(
    mcpPosts.every((r) => r.auth === 'Bearer access-2'),
    'every MCP request used the refreshed token',
  )
  assert.equal(mock.state.grants.filter((g) => g === 'refresh_token').length, 1)
  await mcp.close()
})

test('OAuth: a transient refresh failure still leads to ONE usable authorization', async () => {
  // The proactive refresh must never start an authorization of its own: the
  // SDK's auth() silently escalates a failed refresh into a full redirect,
  // issuing a state + PKCE verifier that the transport's own 401 handling
  // would then overwrite — leaving the user holding a code the stored pair
  // cannot verify ("state mismatch") on every attempt.
  const mock = createMockServer({ requireAuth: true })
  mock.state.failRefresh = true
  const redirects: URL[] = []
  const provider = new BrowserOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    storage: new MemoryOAuthStorage(),
    onRedirect: (url) => {
      redirects.push(url)
    },
  })
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 5, // inside the skew window: the proactive refresh will fire
    refresh_token: 'refresh-1',
  })
  mock.state.validTokens.clear()

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(redirects.length, 1, 'exactly one authorization was started')

  // The state that reached the user is the state we can verify.
  mock.state.failRefresh = false
  const state = redirects[0].searchParams.get('state') ?? undefined
  await finishMcpOAuth(provider, { code: 'auth-code-1', state }, { fetch: mock.fetchFn })
  assert.ok((await provider.tokens())?.access_token)
})

test('OAuth: beginMcpOAuth reports REDIRECT and records where to send the user', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  const outcome = await beginMcpOAuth(provider, { fetch: mock.fetchFn })
  assert.equal(outcome, 'REDIRECT')
  assert.equal(provider.authorizationUrl?.searchParams.get('client_id'), 'dcr-client-1')

  await finishMcpOAuth(
    provider,
    {
      code: 'auth-code-1',
      state: provider.authorizationUrl?.searchParams.get('state') ?? undefined,
    },
    { fetch: mock.fetchFn },
  )
  assert.equal(await provider.isAuthorized(), true)
})

test('OAuth: a dead refresh token falls back to a fresh authorization', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'bogus',
  })
  mock.state.validTokens.clear()

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })

  assert.equal(mcp.results[0].connected, false)
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.ok(provider.authorizationUrl, 'the user is sent back through the authorization flow')
  // invalid_grant must clear the dead tokens, or every later attempt retries
  // the same doomed refresh.
  assert.equal(await provider.tokens(), undefined)
})

test('the subpath re-exports UnauthorizedError so a host can identify auth failures', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].needsAuthorization, true)

  // The class has to be reachable from this package: a host that depends only
  // on it has no other handle. On the 2.x SDK the class also names itself (the
  // 1.x one read as "Error") and is recognised by a brand, not by prototype.
  const err = new UnauthorizedError()
  assert.equal(err.name, 'UnauthorizedError', 'a host may check the name')
  assert.ok(err instanceof UnauthorizedError)
  assert.ok(err instanceof Error)
  // A tool's own failure that merely talks about authorization is not one.
  assert.ok(!(new Error('Unauthorized') instanceof UnauthorizedError))
  const lookalike = Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' })
  assert.ok(!(lookalike instanceof UnauthorizedError), 'a name alone does not make an instance')
})

// ── The failure a browser refuses to explain ────────────────────────────────
// A CORS rejection reaches JavaScript as a bare TypeError, identical to a
// server being down. The interesting case is the one that looks like the OAuth
// consent step broke: the origin is allowed, so discovery, the token exchange
// and `initialize` all succeed, and then the transport adds the
// MCP-Protocol-Version header that the spec requires afterwards — and a server
// whose CORS list predates that requirement blocks every request from there on.

test('diagnoseMcpCors: names the refused header when a plain request gets through', async () => {
  const seen: string[][] = []
  const hint = await diagnoseMcpCors(MCP_URL, async (_url, init) => {
    seen.push(Object.keys((init?.headers ?? {}) as Record<string, string>))
    return new Response('{}', { status: 200 })
  })
  assert.match(hint ?? '', /MCP-Protocol-Version/)
  assert.match(hint ?? '', /Access-Control-Allow-Headers/)
  // The probe must ask for nothing beyond content-type, or it proves nothing.
  assert.deepEqual(seen, [['content-type']])
})

test('diagnoseMcpCors: a plain request that is also blocked points at the origin', async () => {
  const hint = await diagnoseMcpCors(MCP_URL, async () => {
    throw new TypeError('Failed to fetch')
  })
  assert.match(hint ?? '', /Access-Control-Allow-Origin/)
  assert.doesNotMatch(hint ?? '', /MCP-Protocol-Version/)
})

test('diagnoseMcpCors: an unreadable 401 challenge is called out as well', async () => {
  const hint = await diagnoseMcpCors(
    MCP_URL,
    async () => new Response('{}', { status: 401 }), // no WWW-Authenticate exposed
  )
  assert.match(hint ?? '', /WWW-Authenticate/)
  assert.match(hint ?? '', /Access-Control-Expose-Headers/)
})

test('diagnoseMcpCors: stays quiet about the challenge when it is readable', async () => {
  const hint = await diagnoseMcpCors(
    MCP_URL,
    async () =>
      new Response('{}', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://x.example.test/rm"' },
      }),
  )
  assert.doesNotMatch(hint ?? '', /Expose-Headers/)
})

test('connectMcpHttp: a blocked fetch is reported with the CORS diagnosis attached', async () => {
  let calls = 0
  const mcp = await connectMcpHttp({
    docs: {
      url: MCP_URL,
      fetch: async () => {
        calls += 1
        // The transport's own requests are blocked; the diagnostic probe is not.
        if (calls === 1) throw new TypeError('Failed to fetch')
        return new Response('{}', { status: 200 })
      },
    },
  })
  const docs = mcp.results.find((r) => r.name === 'docs')
  assert.equal(docs?.connected, false)
  assert.match(docs?.error ?? '', /Failed to fetch/)
  assert.match(docs?.error ?? '', /MCP-Protocol-Version/)
  await mcp.close()
})

test('connectMcpHttp: an ordinary server error is not dressed up as a CORS problem', async () => {
  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, fetch: async () => new Response('boom', { status: 500 }) },
  })
  const docs = mcp.results.find((r) => r.name === 'docs')
  assert.equal(docs?.connected, false)
  assert.doesNotMatch(docs?.error ?? '', /Access-Control/)
  await mcp.close()
})

// ── large catalogues: pagination, deadlines, annotations ────────────────────

test('connectMcpHttp: follows nextCursor so every page of tools is mounted', async () => {
  const tools = Array.from({ length: 25 }, (_, i) => ({
    name: `t${i}`,
    inputSchema: { type: 'object' },
  }))
  const mock = createMockServer({ tools, pageSize: 10 })
  const mcp = await connectMcpHttp({ big: { url: MCP_URL, fetch: mock.fetchFn } })
  assert.equal(Object.keys(mcp.tools).length, 25)
  assert.equal(mcp.catalog.at(-1)?.name, 'big__t24')
  await mcp.refreshServer('big')
  assert.equal(Object.keys(mcp.tools).length, 25)
  await mcp.close()
})

test('connectMcpHttp: a server that hangs is cut off by connectTimeoutMs, others still mount', async () => {
  const hung = createMockServer({ hangListTools: true })
  const fine = createMockServer()
  const started = Date.now()
  const mcp = await connectMcpHttp(
    {
      slow: { url: MCP_URL, fetch: hung.fetchFn },
      docs: { url: MCP_URL, fetch: fine.fetchFn },
    },
    { connectTimeoutMs: 300 },
  )
  assert.ok(Date.now() - started < 3_000)
  assert.deepEqual(
    mcp.results.map((r) => [r.name, r.connected]),
    [
      ['slow', false],
      ['docs', true],
    ],
  )
  assert.match(mcp.results[0].error ?? '', /timed out after 300 ms/)
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  await mcp.close()
})

test('connectMcpHttp: readOnlyHint marks tools read-only for the consent gate', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'write', inputSchema: { type: 'object' } },
    ],
  })
  const mcp = await connectMcpHttp({ s: { url: MCP_URL, fetch: mock.fetchFn } })
  assert.equal((mcp.tools.s__read as { readOnly?: boolean }).readOnly, true)
  assert.equal((mcp.tools.s__write as { readOnly?: boolean }).readOnly, undefined)
  assert.deepEqual(
    mcp.catalog.map((c) => [c.name, c.readOnly ?? false]),
    [
      ['s__read', true],
      ['s__write', false],
    ],
  )
  await mcp.close()
})

// ── OAuth hardening: CIMD, application_type, discovery state, RFC 9207 ──────
// The same block lives in the sibling package's suite (packages/agent/tests/mcp-connect.test.ts): the two
// providers share names and semantics, so they share the tests.

const CIMD_URL = 'https://app.example.test/oauth/client.json'

const hardened = (extra: Record<string, unknown> = {}, store = new MemoryOAuthStorage()) =>
  new BrowserOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    storage: store,
    ...extra,
  })

const begin = (provider: BrowserOAuthProvider, mock: ReturnType<typeof createMockServer>) =>
  connectMcpHttp({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

const issuedState = (provider: BrowserOAuthProvider): string | undefined =>
  provider.authorizationUrl?.searchParams.get('state') ?? undefined

test('CIMD: the metadata URL is the client_id when the AS supports it, with no registration', async () => {
  const mock = createMockServer({ requireAuth: true, cimd: true })
  const provider = hardened({ clientMetadataUrl: CIMD_URL })
  assert.equal(provider.clientMetadataUrl, CIMD_URL)

  await begin(provider, mock)

  assert.equal(mock.state.registrations, 0, 'no dynamic registration request was made')
  assert.equal(provider.authorizationUrl?.searchParams.get('client_id'), CIMD_URL)
  assert.equal((await provider.clientInformation())?.client_id, CIMD_URL)

  await finishMcpOAuth(
    provider,
    { code: 'auth-code-1', state: issuedState(provider) },
    { fetch: mock.fetchFn },
  )
  assert.equal(mock.state.lastTokenClientId, CIMD_URL, 'the exchange names the same client')
  assert.equal(mock.state.registrations, 0)
})

test('CIMD: falls back to dynamic registration when the AS does not support it', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = hardened({ clientMetadataUrl: CIMD_URL })

  await begin(provider, mock)

  assert.equal(mock.state.registrations, 1)
  assert.equal(provider.authorizationUrl?.searchParams.get('client_id'), 'dcr-client-1')
})

test('CIMD: a registration already in the store wins over the metadata URL', async () => {
  const mock = createMockServer({ requireAuth: true, cimd: true })
  const provider = hardened({ clientMetadataUrl: CIMD_URL })
  await provider.saveClientInformation({ client_id: 'pre-registered' })

  await begin(provider, mock)

  assert.equal(mock.state.registrations, 0)
  assert.equal(provider.authorizationUrl?.searchParams.get('client_id'), 'pre-registered')
})

test('CIMD: clientMetadataUrl must be https with a non-root path', () => {
  const refused = /clientMetadataUrl requires https and a non-root path/
  assert.throws(
    () => hardened({ clientMetadataUrl: 'http://app.example.test/client.json' }),
    refused,
  )
  // Loopback is fine for the MCP server itself, never for a document the
  // authorization server has to fetch.
  assert.throws(() => hardened({ clientMetadataUrl: 'http://localhost/client.json' }), refused)
  assert.throws(() => hardened({ clientMetadataUrl: 'https://app.example.test' }), refused)
  assert.throws(() => hardened({ clientMetadataUrl: 'https://app.example.test/' }), refused)
  assert.throws(() => hardened({ clientMetadataUrl: 'client.json' }), /is not a valid URL/)
  assert.throws(() => hardened({ clientMetadataUrl: '' }), /is not a valid URL/)
  assert.equal(hardened().clientMetadataUrl, undefined)
})

test('DCR: application_type follows the redirect - loopback is native, an https page is web', () => {
  assert.equal((hardened().clientMetadata as { application_type?: string }).application_type, 'web')
  assert.equal(
    (
      hardened({ redirectUrl: 'http://localhost:5173/callback' }).clientMetadata as {
        application_type?: string
      }
    ).application_type,
    'native',
  )
})

test('DCR: the registration request carries application_type, and clientMetadata overrides it', async () => {
  const mock = createMockServer({ requireAuth: true })
  await begin(hardened(), mock)
  assert.equal(mock.state.lastRegistration?.application_type, 'web')

  const other = createMockServer({ requireAuth: true })
  await begin(hardened({ clientMetadata: { application_type: 'native' } }), other)
  assert.equal(other.state.lastRegistration?.application_type, 'native')
})

test('issuer stamp: what the SDK stamps on the client and the tokens survives the store', async () => {
  const mock = createMockServer({ requireAuth: true })
  const store = new MemoryOAuthStorage()
  const provider = hardened({}, store)

  await begin(provider, mock)
  await finishMcpOAuth(
    provider,
    { code: 'auth-code-1', state: issuedState(provider) },
    { fetch: mock.fetchFn },
  )

  // A second provider over the same store is what a restart / reload reads.
  const reloaded = hardened({}, store)
  assert.equal((await reloaded.clientInformation())?.issuer, AS_URL)
  assert.equal((await reloaded.tokens())?.issuer, AS_URL)
  assert.equal((await reloaded.tokens())?.access_token, 'access-2')
})

test('discovery state: saved, reused instead of discovering again, cleared with the rest', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = hardened()
  const asMetadataRequests = () =>
    mock.requests.filter((r) => r.url.startsWith(AS_URL) && r.url.includes('/.well-known/')).length

  await begin(provider, mock)
  const saved = await provider.discoveryState()
  assert.equal(saved?.authorizationServerUrl, AS_URL)
  assert.equal(saved?.authorizationServerMetadata?.issuer, AS_URL)
  assert.equal(saved?.resourceMetadata?.resource, MCP_URL)

  const before = asMetadataRequests()
  assert.ok(before > 0)
  await begin(provider, mock)
  assert.equal(asMetadataRequests(), before, 'the second flow read the stored state')

  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' })
  await provider.invalidateCredentials('discovery')
  assert.equal(await provider.discoveryState(), undefined)
  assert.equal((await provider.tokens())?.access_token, 'a', 'only the named scope goes')

  await provider.saveDiscoveryState(saved!)
  await provider.invalidateCredentials('all')
  assert.equal(await provider.discoveryState(), undefined)

  await provider.saveDiscoveryState(saved!)
  await provider.reset()
  assert.equal(await provider.discoveryState(), undefined)
})

test('RFC 9207: an iss that names another server is refused before any token request', async () => {
  const mock = createMockServer({ requireAuth: true, issParameter: true })
  const provider = hardened()
  await begin(provider, mock)

  await assert.rejects(
    () =>
      finishMcpOAuth(
        provider,
        { code: 'auth-code-1', state: issuedState(provider), iss: 'https://evil.example.test' },
        { fetch: mock.fetchFn },
      ),
    /expected "https:\/\/as\.example\.test".*mix-up/,
  )
  assert.deepEqual(mock.state.grants, [], 'the token endpoint saw nothing')
  assert.equal(mock.requests.filter((r) => r.url === `${AS_URL}/token`).length, 0)
  assert.equal(await provider.tokens(), undefined)
})

test('RFC 9207: the comparison is exact - a trailing slash or another case is another issuer', async () => {
  for (const iss of [`${AS_URL}/`, AS_URL.toUpperCase(), `${AS_URL}?x=1`, '']) {
    const mock = createMockServer({ requireAuth: true })
    const provider = hardened()
    await begin(provider, mock)
    await assert.rejects(
      () =>
        finishMcpOAuth(
          provider,
          { code: 'auth-code-1', state: issuedState(provider), iss },
          { fetch: mock.fetchFn },
        ),
      /mix-up/,
      `iss "${iss}" must be refused`,
    )
    assert.deepEqual(mock.state.grants, [])
  }
})

test('RFC 9207: a response without iss is refused when the AS says it always sends one', async () => {
  const mock = createMockServer({ requireAuth: true, issParameter: true })
  const provider = hardened()
  await begin(provider, mock)

  await assert.rejects(
    () =>
      finishMcpOAuth(
        provider,
        { code: 'auth-code-1', state: issuedState(provider) },
        { fetch: mock.fetchFn },
      ),
    /carried no "iss".*mix-up/,
  )
  assert.deepEqual(mock.state.grants, [], 'the token endpoint saw nothing')
})

test('RFC 9207: a matching iss passes, and so does no iss from an AS that never promised one', async () => {
  const advertised = createMockServer({ requireAuth: true, issParameter: true })
  const a = hardened()
  await begin(a, advertised)
  await finishMcpOAuth(
    a,
    { code: 'auth-code-1', state: issuedState(a), iss: AS_URL },
    { fetch: advertised.fetchFn },
  )
  assert.deepEqual(advertised.state.grants, ['authorization_code'])
  assert.equal((await a.tokens())?.access_token, 'access-2')

  // Not advertised, but sent anyway: still checked, still accepted when right.
  const quiet = createMockServer({ requireAuth: true })
  const b = hardened()
  await begin(b, quiet)
  await finishMcpOAuth(
    b,
    { code: 'auth-code-1', state: issuedState(b), iss: AS_URL },
    { fetch: quiet.fetchFn },
  )
  assert.equal((await b.tokens())?.access_token, 'access-2')

  const silent9207 = createMockServer({ requireAuth: true })
  const c = hardened()
  await begin(c, silent9207)
  await finishMcpOAuth(
    c,
    { code: 'auth-code-1', state: issuedState(c) },
    { fetch: silent9207.fetchFn },
  )
  assert.equal((await c.tokens())?.access_token, 'access-2')
})

test('RFC 9207: the state is checked first, so a forged callback never reaches the issuer check', async () => {
  const mock = createMockServer({ requireAuth: true, issParameter: true })
  const provider = hardened()
  await begin(provider, mock)
  await assert.rejects(
    () =>
      finishMcpOAuth(
        provider,
        { code: 'auth-code-1', state: 'forged', iss: 'https://evil.example.test' },
        { fetch: mock.fetchFn },
      ),
    /state mismatch/,
  )
  assert.deepEqual(mock.state.grants, [])
})

test('RFC 9207: a flow without discovery state (older version) is refused, and nothing is lost', async () => {
  // Stamped client, no discovery state: iss is compared with the stamp.
  const mock = createMockServer({ requireAuth: true })
  const provider = hardened()
  await begin(provider, mock)
  await provider.invalidateCredentials('discovery')
  await assert.rejects(
    () =>
      finishMcpOAuth(
        provider,
        { code: 'auth-code-1', state: issuedState(provider), iss: 'https://evil.example.test' },
        { fetch: mock.fetchFn },
      ),
    /mix-up/,
  )
  assert.deepEqual(mock.state.grants, [])

  // The right iss is not enough: the code belongs to the authorization server
  // the user was sent to, and the record of which one that was is gone. The
  // 2.x SDK refuses the exchange (1.x went ahead); we say so in our words.
  const again = createMockServer({ requireAuth: true })
  const second = hardened()
  await begin(second, again)
  await second.invalidateCredentials('discovery')
  await assert.rejects(
    () =>
      finishMcpOAuth(
        second,
        { code: 'auth-code-1', state: issuedState(second), iss: AS_URL },
        { fetch: again.fetchFn },
      ),
    /^Error: Authorization cannot be completed: .*start the authorization again$/,
  )
  assert.deepEqual(again.state.grants, [], 'the token endpoint saw nothing')
  assert.equal(await second.tokens(), undefined)
  // Starting again is all it takes.
  await begin(second, again)
  await finishMcpOAuth(
    second,
    { code: 'auth-code-1', state: issuedState(second), iss: AS_URL },
    { fetch: again.fetchFn },
  )
  assert.equal((await second.tokens())?.access_token, 'access-2')

  // A flow a much older version started (an unstamped registration, no
  // discovery state), with or without iss: the same refusal, and the token
  // that is already in storage stays usable.
  for (const iss of [undefined, 'https://whoever.example.test']) {
    const old = createMockServer({ requireAuth: true })
    const legacy = hardened()
    await legacy.saveClientInformation({ client_id: 'old-client' })
    await legacy.saveTokens({ access_token: 'access-1', token_type: 'Bearer' })
    await legacy.saveCodeVerifier('verifier-from-an-older-version')
    const state = await legacy.state()
    await assert.rejects(
      () => finishMcpOAuth(legacy, { code: 'auth-code-1', state, iss }, { fetch: old.fetchFn }),
      /start the authorization again/,
    )
    assert.deepEqual(old.state.grants, [])
    assert.equal((await legacy.tokens())?.access_token, 'access-1')
    const mcp = await begin(legacy, old)
    assert.equal(mcp.results[0].connected, true)
    await mcp.close()
  }
})

test('checkAuthorizationResponseIssuer: the rule, case by case', () => {
  const metadata = {
    issuer: 'https://as.example.test',
    authorization_endpoint: 'https://as.example.test/authorize',
    token_endpoint: 'https://as.example.test/token',
    response_types_supported: ['code'],
  }
  const discovered = {
    authorizationServerUrl: 'https://as.example.test',
    authorizationServerMetadata: metadata,
  }
  const promised = {
    authorizationServerUrl: 'https://as.example.test',
    authorizationServerMetadata: {
      ...metadata,
      authorization_response_iss_parameter_supported: true,
    },
  }
  const ok = (...args: Parameters<typeof checkAuthorizationResponseIssuer>) =>
    assert.doesNotThrow(() => checkAuthorizationResponseIssuer(...args))
  const refused = (...args: Parameters<typeof checkAuthorizationResponseIssuer>) =>
    assert.throws(() => checkAuthorizationResponseIssuer(...args), /mix-up/)

  ok('https://as.example.test', discovered)
  ok(undefined, discovered)
  refused('https://evil.example.test', discovered)
  refused('https://as.example.test/', discovered)

  ok('https://as.example.test', promised)
  refused(undefined, promised)
  // Only a literal `true` is a promise.
  ok(undefined, {
    ...promised,
    authorizationServerMetadata: {
      ...metadata,
      authorization_response_iss_parameter_supported: 'true',
    },
  })

  // The metadata's issuer wins over the URL discovery used...
  const moved = { ...discovered, authorizationServerUrl: 'https://alias.example.test' }
  ok('https://as.example.test', moved)
  refused('https://alias.example.test', moved)
  // ...which is the fallback when there is no metadata document.
  const bare = { authorizationServerUrl: 'https://legacy.example.test/' }
  ok('https://legacy.example.test/', bare)
  refused('https://as.example.test', bare)
  ok(undefined, bare)

  // The discovery state wins over the stamp on the client.
  refused('https://stamp.example.test', discovered, 'https://stamp.example.test')

  // No discovery state: the stamp on the stored client, else nothing to check.
  ok('https://as.example.test', undefined, 'https://as.example.test')
  refused('https://evil.example.test', undefined, 'https://as.example.test')
  ok(undefined, undefined, 'https://as.example.test')
  ok('https://anything.example.test', undefined, undefined)
  ok(undefined, undefined, undefined)
})

test('readOAuthCallback: reads iss from the query string and from a hash route', () => {
  const iss = 'https://as.example.test'
  const q = encodeURIComponent(iss)
  assert.equal(readOAuthCallback(`https://app.test/cb?code=abc&state=xyz&iss=${q}`)?.iss, iss)
  assert.equal(readOAuthCallback(`https://app.test/#/cb?code=abc&state=xyz&iss=${q}`)?.iss, iss)
  assert.equal(readOAuthCallback('https://app.test/cb?code=abc&state=xyz')?.iss, undefined)
  // An error response carries it too (RFC 9207 section 2).
  assert.equal(readOAuthCallback(`https://app.test/cb?error=access_denied&iss=${q}`)?.iss, iss)
})

// ── on the 2.x SDK client: what this package does itself ────────────────────
//
// The 2.x client lists every page and checks every result on its own; the
// connector keeps doing both by hand (`listAllTools`, `outputSchemaViolation`)
// so that what it promised before still holds. These pin that. The same block
// lives in the sibling package's suite (packages/agent/tests/mcp-connect.test.ts).

const MAX_TOOL_LIST_PAGES = 100

const collect = () => {
  const lines: string[] = []
  return {
    lines,
    onLog: (level: string, message: string) => void lines.push(`${level} ${message}`),
  }
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' }, temperature: { type: 'number' } },
  required: ['city', 'temperature'],
}

test('tools/list: a repeated cursor ends the walk quietly', async () => {
  const mock = createMockServer({ endlessCursor: 'same' })
  const logs = collect()
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } }, logs)
  assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  assert.deepEqual(mock.state.listCursors, [undefined, 'again'])
  assert.ok(!logs.lines.some((l) => /still paginating/.test(l)))
  await mcp.close()
})

test('tools/list: a server that paginates forever is cut at the page cap, with a warning', async () => {
  const mock = createMockServer({ endlessCursor: 'fresh' })
  const logs = collect()
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } }, logs)
  // Not a failed connect (the SDK's own aggregate walk throws past ITS cap of 64).
  assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  assert.equal(mock.state.listCursors.length, MAX_TOOL_LIST_PAGES)
  assert.equal(
    logs.lines.filter(
      (l) => l.startsWith('warn ') && l.includes(`after ${MAX_TOOL_LIST_PAGES} pages`),
    ).length,
    1,
  )
  // A refresh walks under the same cap, and says so again.
  await mcp.refreshServer('docs')
  assert.equal(mock.state.listCursors.length, 2 * MAX_TOOL_LIST_PAGES)
  assert.equal(logs.lines.filter((l) => l.includes(`after ${MAX_TOOL_LIST_PAGES} pages`)).length, 2)
  await mcp.close()
})

test('tools/list: asked even when the server did not advertise the tools capability', async () => {
  // The 2.x `listTools()` answers `{ tools: [] }` without asking. Servers that
  // forget the capability and serve tools all the same exist; they keep working.
  const mock = createMockServer({ noToolsCapability: true })
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  assert.deepEqual(mock.state.listCursors, [undefined])
  await mcp.close()
})

test('tools/call: an unknown tool answered with a JSON-RPC error is a failed call the model can read', async () => {
  // A 1.x server answers an unknown tool with an `isError` result (the `boom`
  // test above); a 2.x server with a protocol error, -32602. Both must reach
  // the AI SDK as a throw - a failed call - with the server's words.
  const mock = createMockServer({
    tools: [{ name: 'ghost', inputSchema: { type: 'object' } }],
    unknownTool: 'ghost',
  })
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  const err = await callTool(mcp.tools, 'docs__ghost', {}).then(
    () => undefined,
    (e: unknown) => e as Error & { code?: unknown },
  )
  assert.ok(err instanceof Error)
  // Verbatim: the 1.x SDK put "MCP error -32602: " in front.
  assert.equal(err.message, 'Tool ghost not found')
  assert.equal(err.code, -32602)
  assert.ok(!(err instanceof UnauthorizedError))
  assert.equal(mock.state.toolCalls, 1, 'asked once, not retried')
  // The connection survives it.
  assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])
  await mcp.close()
})

test('outputSchema: a result that follows it is passed on without a note', async () => {
  const value = { city: 'Lisbon', temperature: 21 }
  const mock = createMockServer({
    tools: [{ name: 'report', inputSchema: { type: 'object' }, outputSchema: REPORT_SCHEMA }],
    results: { report: { content: [], structuredContent: value } },
  })
  const logs = collect()
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } }, logs)
  assert.deepEqual(await callTool(mcp.tools, 'docs__report', {}), value)
  assert.ok(!logs.lines.some((l) => /outputSchema/.test(l)))
  await mcp.close()
})

test('outputSchema: a mismatch and a missing value are each passed on with a note, the call made once', async () => {
  const wrong = { city: 'Lisbon', temperature: 'warm' }
  const mock = createMockServer({
    tools: [
      { name: 'wrong', inputSchema: { type: 'object' }, outputSchema: REPORT_SCHEMA },
      { name: 'bare', inputSchema: { type: 'object' }, outputSchema: REPORT_SCHEMA },
    ],
    results: {
      wrong: { content: [], structuredContent: wrong },
      bare: { content: [{ type: 'text', text: 'just words' }] },
    },
  })
  const logs = collect()
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } }, logs)

  // The detail is the validator's: in a browser the SDK's default one is
  // @cfworker/json-schema (the Node sibling's is Ajv, with other words).
  assert.deepEqual(await callTool(mcp.tools, 'docs__wrong', {}), {
    note:
      'The tool "wrong" ran, but its result does not follow the output schema the server declared ' +
      "for it (Structured content does not match the tool's output schema: #: Property " +
      '"temperature" does not match schema.; #/temperature: Instance type "string" is invalid. ' +
      'Expected "number".). The result is passed on as received: treat its shape with care, and ' +
      'do not call the tool again only because of this note.',
    structuredContent: wrong,
  })
  assert.deepEqual(await callTool(mcp.tools, 'docs__bare', {}), {
    note:
      'The tool "bare" ran, but its result does not follow the output schema the server declared ' +
      'for it (Tool bare has an output schema but did not return structured content). The result ' +
      'is passed on as received: treat its shape with care, and do not call the tool again only ' +
      'because of this note.',
    content: 'just words',
  })
  assert.equal(mock.state.toolCalls, 2, 'one request each: nothing is called again')
  assert.equal(
    logs.lines.filter((l) => /^warn .*result does not follow the declared outputSchema/.test(l))
      .length,
    2,
  )
  await mcp.close()
})

test('outputSchema: an isError result is a failed call, never a note', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'boom', inputSchema: { type: 'object' }, outputSchema: REPORT_SCHEMA },
      { name: 'half', inputSchema: { type: 'object' }, outputSchema: REPORT_SCHEMA },
    ],
    // An error that also carries a value which breaks the schema: still an error.
    results: {
      half: {
        content: [{ type: 'text', text: 'half done' }],
        structuredContent: { city: 1 },
        isError: true,
      },
    },
  })
  const logs = collect()
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } }, logs)
  await assert.rejects(
    () => callTool(mcp.tools, 'docs__boom', {}),
    (err: unknown) => err instanceof Error && err.message === 'kaboom',
  )
  await assert.rejects(
    () => callTool(mcp.tools, 'docs__half', {}),
    (err: unknown) => err instanceof Error && err.message === 'half done',
  )
  assert.ok(!logs.lines.some((l) => /outputSchema/.test(l)))
  await mcp.close()
})

test('outputSchema: one that cannot be compiled fails that tool before anything is sent', async () => {
  // 1.x compiled every schema while listing, so this server did not connect at
  // all; now it does, and only the tool with the bad schema is refused.
  const mock = createMockServer({
    tools: [
      {
        name: 'odd',
        inputSchema: { type: 'object' },
        outputSchema: { $schema: 'http://json-schema.org/draft-03/schema#', type: 'object' },
      },
      { name: 'echo', inputSchema: { type: 'object' } },
    ],
  })
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      () => callTool(mcp.tools, 'docs__odd', {}),
      (err: unknown) =>
        err instanceof Error &&
        /^Tool 'odd' has an invalid outputSchema: .*unsupported dialect/.test(err.message) &&
        err.message.length <= "Tool 'odd' has an invalid outputSchema: ".length + 200,
    )
  }
  assert.equal(mock.state.toolCalls, 0, 'nothing ran on the server')
  assert.equal(await callTool(mcp.tools, 'docs__echo', { a: 1 }), 'echo:{"a":1}')
  await mcp.close()
})

test('outputSchema: a validator that throws on the value is a note, not a failed call', async () => {
  // The browser validator resolves a `$ref` when it validates, not when it
  // compiles (Ajv, in the Node sibling, refuses such a schema up front). By
  // then the call has run: the result is passed on, with the reason.
  const value = { city: 'Lisbon' }
  const mock = createMockServer({
    tools: [
      {
        name: 'dangling',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { city: { $ref: '#/$defs/nowhere' } } },
      },
    ],
    results: { dangling: { content: [], structuredContent: value } },
  })
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  const out = (await callTool(mcp.tools, 'docs__dangling', {})) as {
    note: string
    structuredContent: unknown
  }
  assert.match(out.note, /\(Failed to validate structured content: .+\)\. The result is passed on/)
  assert.deepEqual(out.structuredContent, value)
  assert.equal(mock.state.toolCalls, 1)
  await mcp.close()
})

// ── on the 2.x SDK client: OAuth ────────────────────────────────────────────

const authorized = async (provider: BrowserOAuthProvider): Promise<void> => {
  await provider.saveClientInformation({ client_id: 'dcr-client-1', issuer: AS_URL })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-1',
    scope: 'mcp:tools',
    issuer: AS_URL,
  })
}

test('403 insufficient_scope, interactive provider: the call fails with the scope; no authorization is started', async () => {
  const mock = createMockServer({
    requireAuth: true,
    tools: [
      { name: 'admin', inputSchema: { type: 'object' } },
      { name: 'echo', inputSchema: { type: 'object' } },
    ],
    forbidTool: { name: 'admin', scope: 'mcp:admin' },
  })
  const prompts: URL[] = []
  const provider = hardened({ onRedirect: (url: URL) => void prompts.push(url) })
  await authorized(provider)
  // A flow the user has open: nothing a tool call does may replace its pair.
  await provider.saveCodeVerifier('verifier-of-a-pending-flow')
  const pendingState = await provider.state()

  const mcp = await begin(provider, mock)
  assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])

  for (let attempt = 1; attempt <= 3; attempt++) {
    const err = await callTool(mcp.tools, 'docs__admin', {}).then(
      () => undefined,
      (e: unknown) => e as Error & { requiredScope?: string },
    )
    assert.ok(err instanceof Error)
    assert.equal(err.message, 'Insufficient scope: required "mcp:admin"')
    assert.equal(err.requiredScope, 'mcp:admin')
    // Not an "authorize again" signal for a UI that watches for UnauthorizedError.
    assert.ok(!(err instanceof UnauthorizedError))
    assert.equal(mock.state.forbidden, attempt, 'one request per call: no retry, no loop')
  }
  assert.deepEqual(mock.state.grants, [], 'no token request: neither a refresh nor a code')
  assert.equal(mock.state.registrations, 0)
  assert.deepEqual(prompts, [], 'nobody was asked to authorize')
  assert.equal(provider.authorizationUrl, undefined)
  assert.equal(await provider.codeVerifier(), 'verifier-of-a-pending-flow')
  assert.equal(await provider.verifyState(pendingState), true, 'the pending state is still the one')
  // The token is as good as it was for everything else.
  assert.equal((await provider.tokens())?.access_token, 'access-1')
  assert.equal(await callTool(mcp.tools, 'docs__echo', { a: 1 }), 'echo:{"a":1}')
  await mcp.close()
})

test('403 insufficient_scope, provider without a human step: one wider grant per call, then it stops', async () => {
  const mock = createMockServer({
    requireAuth: true,
    tools: [{ name: 'admin', inputSchema: { type: 'object' } }],
    forbidTool: { name: 'admin', scope: 'mcp:admin' },
  })
  // The smallest non-interactive provider there is: a pre-registered client
  // and a grant of its own (what the enterprise provider is, minus the IdP).
  let tokens: Record<string, unknown> | undefined = {
    access_token: 'access-1',
    token_type: 'Bearer',
    scope: 'mcp:tools',
    issuer: AS_URL,
  }
  const redirects: URL[] = []
  const machine = {
    get redirectUrl() {
      return undefined
    },
    get clientMetadata() {
      return { redirect_uris: [], grant_types: ['client_credentials'] }
    },
    clientInformation: () => ({ client_id: 'machine', issuer: AS_URL }),
    tokens: () => tokens,
    saveTokens: (t: typeof tokens) => {
      tokens = t
    },
    prepareTokenRequest: (scope?: string) =>
      new URLSearchParams({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) }),
    redirectToAuthorization: (url: URL) => void redirects.push(url),
    saveCodeVerifier: () => {
      throw new Error('no interactive step')
    },
    codeVerifier: () => {
      throw new Error('no interactive step')
    },
  }

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: machine as never, fetch: mock.fetchFn },
  })
  assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])

  await assert.rejects(() => callTool(mcp.tools, 'docs__admin', {}), /403 insufficient_scope/)
  // One grant for the union of what it had and what was asked, one retry, done.
  assert.deepEqual(mock.state.grants, ['client_credentials'])
  assert.deepEqual(mock.state.tokenScopes, ['mcp:tools mcp:admin'])
  assert.equal(mock.state.forbidden, 2)
  assert.equal(tokens?.access_token, 'access-2')

  await assert.rejects(() => callTool(mcp.tools, 'docs__admin', {}), /403 insufficient_scope/)
  assert.equal(mock.state.grants.length, 2, 'the next call may try once more, and only once')
  assert.equal(mock.state.forbidden, 4)
  assert.deepEqual(redirects, [])
  await mcp.close()
})

test('issuer stamp: storage written before there was one keeps working and gets stamped', async (t) => {
  // What earlier versions left behind: a registration and tokens with no
  // `issuer`. They are used as they are and stamped on first use - never thrown
  // away, and never a crash. (The SDK says so on the console; not in the test output.)
  const warned = t.mock.method(console, 'warn', () => {})
  let n = 0
  for (const makeStore of [
    () => new MemoryOAuthStorage(),
    // The default storage: the encrypted IndexedDB vault.
    () => new VaultOAuthStorage({ dbName: `unstamped-${++n}` }),
  ]) {
    const mock = createMockServer({ requireAuth: true })
    const store = makeStore()
    // Byte for byte what the previous version's provider wrote.
    const ns = `mcp-oauth:${MCP_URL}`
    await store.set(`${ns}:client`, JSON.stringify({ client_id: 'dcr-client-1' }))
    await store.set(
      `${ns}:tokens`,
      JSON.stringify({
        tokens: {
          access_token: 'access-1',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-1',
        },
        expiresAt: Date.now() - 1000, // known dead: the refresh token has to be used
      }),
    )
    const provider = hardened({}, store)
    assert.equal((await provider.tokens())?.access_token, 'access-1', 'the old record loads')
    mock.state.validTokens.clear()

    const mcp = await begin(provider, mock)
    assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])
    assert.deepEqual(mock.state.grants, ['refresh_token'])
    assert.equal(mock.state.registrations, 0, 'the old registration was kept')
    assert.equal(mock.state.lastTokenClientId, 'dcr-client-1')
    assert.equal(provider.authorizationUrl, undefined, 'nobody was asked to authorize')
    await mcp.close()

    // What a reload reads: both carry the stamp now, exactly as the SDK wrote it.
    const reloaded = hardened({}, store)
    assert.deepEqual(await reloaded.clientInformation(), {
      client_id: 'dcr-client-1',
      issuer: AS_URL,
    })
    assert.equal((await reloaded.tokens())?.issuer, AS_URL)
    assert.equal((await reloaded.tokens())?.access_token, 'access-2')
    assert.equal(await reloaded.isAccessTokenExpired(), false)
  }
  assert.ok(warned.mock.calls.some((c) => /no 'issuer' stamp/.test(String(c.arguments[0]))))
})

test('issuer stamp: an unstamped token that is still good connects without a single OAuth request', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const mock = createMockServer({ requireAuth: true })
  const provider = hardened()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600 })
  const mcp = await begin(provider, mock)
  assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])
  assert.deepEqual(mock.state.grants, [])
  assert.equal(mock.requests.filter((r) => !r.url.startsWith(MCP_URL)).length, 0)
  assert.equal(await callTool(mcp.tools, 'docs__echo', { a: 1 }), 'echo:{"a":1}')
  await mcp.close()
})

test('proactive refresh: a refresh token the server no longer knows leads to ONE authorization', async () => {
  // The other way a refresh ends in a new authorization (the test further up
  // has a 503): an `invalid_grant`. That escalation must not happen inside the
  // proactive refresh: it would issue a state and a PKCE verifier, and call
  // `onRedirect`, a moment before the transport's own 401 handling does all of
  // it again.
  const mock = createMockServer({ requireAuth: true })
  const redirects: URL[] = []
  const logs = collect()
  const provider = hardened({ onRedirect: (url: URL) => void redirects.push(url) })
  await provider.saveClientInformation({ client_id: 'dcr-client-1', issuer: AS_URL })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 5, // inside the skew window: the proactive refresh fires
    refresh_token: 'bogus',
    issuer: AS_URL,
  })
  mock.state.validTokens.clear()

  const mcp = await connectMcpHttp(
    { docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } },
    logs,
  )
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.deepEqual(mock.state.grants, ['refresh_token'], 'the dead token was tried once')
  assert.equal(redirects.length, 1, 'exactly one authorization was started')
  assert.ok(
    logs.lines.some((l) => /could not be refreshed; a new authorization is needed/.test(l)),
    logs.lines.join(' | '),
  )
  // The state that reached the user is the state we can verify.
  const state = redirects[0].searchParams.get('state') ?? undefined
  await finishMcpOAuth(provider, { code: 'auth-code-1', state }, { fetch: mock.fetchFn })
  assert.equal((await provider.tokens())?.access_token, 'access-2')
})

test('issuer stamp: credentials stamped for another authorization server are never presented to this one', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = hardened()
  await provider.saveClientInformation({
    client_id: 'client-of-another-as',
    issuer: 'https://other.example.test',
  })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 5,
    refresh_token: 'refresh-1',
    issuer: 'https://other.example.test',
  })
  mock.state.validTokens.clear()

  const mcp = await begin(provider, mock)
  // Read as if nothing were stored: a clean new authorization, not an error.
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.deepEqual(mock.state.grants, [], 'the refresh token went nowhere')
  assert.equal(mock.state.registrations, 1)
  assert.equal(provider.authorizationUrl?.searchParams.get('client_id'), 'dcr-client-1')
  assert.equal((await provider.clientInformation())?.issuer, AS_URL)
})

test('invalid_client: the registration and the tokens go, what discovery found stays', async () => {
  // The 2.x SDK asks for 'client' and then 'tokens' (1.x asked for 'all').
  const mock = createMockServer({ requireAuth: true })
  const provider = hardened()
  const scopes: string[] = []
  const invalidate = provider.invalidateCredentials.bind(provider)
  provider.invalidateCredentials = async (scope) => {
    scopes.push(scope)
    await invalidate(scope)
  }
  await begin(provider, mock)
  await finishMcpOAuth(
    provider,
    { code: 'auth-code-1', state: issuedState(provider) },
    { fetch: mock.fetchFn },
  )
  const discovery = await provider.discoveryState()
  assert.ok(discovery)
  const discoveries = () => mock.requests.filter((r) => r.url.includes('/.well-known/')).length
  const before = discoveries()

  mock.state.validTokens.clear()
  mock.state.rejectClient = true
  const mcp = await begin(provider, mock)
  assert.equal(discoveries(), before, 'nothing was discovered again: the record was never dropped')
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.deepEqual(scopes, ['client', 'tokens'])
  assert.equal(await provider.tokens(), undefined)
  assert.equal((await provider.clientInformation())?.client_id, 'dcr-client-2')
  assert.deepEqual(await provider.discoveryState(), discovery)
})

test('refresh: storage that cannot save the new tokens fails the connect, and asks nobody to authorize', async () => {
  // The authorization server has already rotated the refresh token when the
  // save fails. 1.x swallowed the error and started a new authorization; 2.x
  // lets it through, and the user sees what is actually wrong.
  const mock = createMockServer({ requireAuth: true })
  const inner = new MemoryOAuthStorage()
  let broken = false
  const store = {
    get: (key: string) => inner.get(key),
    delete: (key: string) => inner.delete(key),
    set: async (key: string, value: string) => {
      if (broken && key.endsWith(':tokens')) throw new Error('quota exceeded')
      await inner.set(key, value)
    },
  }
  const prompts: URL[] = []
  const provider = hardened({ onRedirect: (url: URL) => void prompts.push(url) }, store as never)
  await authorized(provider)
  mock.state.validTokens.clear()
  broken = true

  const mcp = await begin(provider, mock)
  // Not `needsAuthorization`: authorizing again would not make the quota any larger.
  assert.deepEqual(mcp.results, [{ name: 'docs', connected: false, error: 'quota exceeded' }])
  assert.deepEqual(prompts, [])
  assert.deepEqual(mock.state.grants, ['refresh_token'])
  assert.equal(mock.state.registrations, 0)
})

test('token endpoint over plain http on a host that is not loopback: nothing is sent to it', async () => {
  const mock = createMockServer({ requireAuth: true, insecureTokenEndpoint: true })
  const provider = hardened()
  await begin(provider, mock)
  await assert.rejects(
    () =>
      finishMcpOAuth(
        provider,
        { code: 'auth-code-1', state: issuedState(provider) },
        { fetch: mock.fetchFn },
      ),
    /token endpoint/i,
  )
  // And a refresh is refused the same way, not turned into a new authorization.
  const prompts: URL[] = []
  const second = hardened({ onRedirect: (url: URL) => void prompts.push(url) })
  await authorized(second)
  mock.state.validTokens.clear()
  const mcp = await begin(second, mock)
  assert.equal(mcp.results[0].connected, false)
  assert.match(mcp.results[0].error ?? '', /token endpoint/i)
  assert.deepEqual(prompts, [])
  assert.equal(mock.requests.filter((r) => r.url.endsWith('/token')).length, 0)
  assert.deepEqual(mock.state.grants, [])
})

test('proactive refresh: the provider is read and written with the issuer the SDK resolved', async () => {
  // A provider that keeps credentials per authorization server keys them on
  // the second argument; the refresh-only view must hand it through.
  const mock = createMockServer({ requireAuth: true })
  const provider = hardened()
  await provider.saveClientInformation({ client_id: 'dcr-client-1', issuer: AS_URL })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 5, // known dead: refreshed before the first request
    refresh_token: 'refresh-1',
    issuer: AS_URL,
  })
  mock.state.validTokens.clear()

  const seen: string[] = []
  const spy =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      seen.push(`${name} ${JSON.stringify(args.at(-1))}`)
      return fn(...args)
    }
  const keyed = provider as unknown as Record<string, (...args: never[]) => unknown>
  for (const name of ['clientInformation', 'tokens', 'saveTokens']) {
    keyed[name] = spy(name, keyed[name].bind(provider) as (...args: unknown[]) => unknown)
  }

  const mcp = await begin(provider, mock)
  assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])
  assert.deepEqual(mock.state.grants, ['refresh_token'])
  const ctx = JSON.stringify({ issuer: AS_URL })
  assert.ok(seen.includes(`clientInformation ${ctx}`), seen.join(' | '))
  assert.ok(seen.includes(`tokens ${ctx}`), seen.join(' | '))
  assert.ok(seen.includes(`saveTokens ${ctx}`), seen.join(' | '))
  await mcp.close()
})

test('authorization server metadata that names another issuer is refused: no registration, no prompt', async () => {
  // RFC 8414 section 3.3, enforced by the 2.x SDK (1.x took the document as it
  // came): metadata fetched for one issuer that claims to be another.
  const mock = createMockServer({
    requireAuth: true,
    metadataIssuer: 'https://someone-else.example.test',
  })
  const prompts: URL[] = []
  const provider = hardened({ onRedirect: (url: URL) => void prompts.push(url) })
  const mcp = await begin(provider, mock)
  assert.equal(mcp.results[0].connected, false)
  assert.equal(mcp.results[0].needsAuthorization, undefined)
  assert.match(mcp.results[0].error ?? '', /issuer/i)
  assert.match(mcp.results[0].error ?? '', /someone-else\.example\.test/)
  assert.equal(mock.state.registrations, 0)
  assert.deepEqual(prompts, [])
  assert.equal(await provider.discoveryState(), undefined, 'nothing of it was kept')
})
