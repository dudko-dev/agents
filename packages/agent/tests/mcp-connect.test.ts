import assert from 'node:assert/strict'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  checkAuthorizationResponseIssuer,
  createNodeOAuthProvider,
  FileOAuthStore,
  finishMcpOAuth,
  MemoryOAuthStore,
  type NodeOAuthProvider,
} from '../src/mcp-oauth.ts'
import { isReadOnlyTool } from '../src/approval.ts'
import { connectMcpServers, filterTools } from '../src/mcp.ts'
import type { IMcpServerConfig } from '../src/types.ts'

// A fake remote MCP server + authorization server behind a mock fetch. This is
// what makes the OAuth path testable at all: RFC 9728 resource metadata, AS
// metadata, RFC 7591 dynamic registration, PKCE code exchange, refresh-token
// rotation and 401-on-stale-token all happen in-process.

const MCP_ORIGIN = 'https://mcp.example.test'
const MCP_URL = `${MCP_ORIGIN}/mcp`
const AS_URL = 'https://as.example.test'
const REDIRECT_URL = 'http://127.0.0.1:8765/callback'

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
    annotations?: Record<string, unknown>
  }[]
  failListTools?: boolean
  /** Paginate tools/list: this many tools per page, cursor = next offset. */
  pageSize?: number
  /** Awaited before each MCP POST is answered — used to prove overlap. */
  gate?: () => Promise<void>
  onMcpRequest?: () => void
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
  const requests: { method: string; url: string; auth?: string }[] = []
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
  }

  const handleRpc = (msg: RpcMessage): unknown => {
    if (msg.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        },
      }
    }
    if (msg.id === undefined) {
      return undefined
    }
    if (msg.method === 'tools/list') {
      if (opts.failListTools) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'list exploded' } }
      }
      const cursor = (msg.params as { cursor?: string } | undefined)?.cursor
      state.listCursors.push(cursor)
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
    const headers = new Headers((init.headers ?? {}) as Record<string, string>)
    requests.push({ method, url: href, auth: headers.get('authorization') ?? undefined })

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
      if (!href.startsWith(AS_URL)) {
        return new Response('not found', { status: 404 })
      }
      return jsonResponse({
        issuer: AS_URL,
        authorization_endpoint: `${AS_URL}/authorize`,
        token_endpoint: `${AS_URL}/token`,
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
      // "The client you claim to be is not registered here" — what an AS says
      // after it has forgotten (or rotated away) a dynamic registration.
      if (state.rejectClient) {
        return jsonResponse({ error: 'invalid_client' }, 401)
      }
      if (grant === 'authorization_code') {
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
      state.validTokens = new Set([access])
      return jsonResponse({
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `refresh-${state.issued}`,
      })
    }

    if (href.startsWith(MCP_URL)) {
      if (method === 'GET') {
        return new Response(null, { status: 405 })
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 200 })
      }
      opts.onMcpRequest?.()
      if (opts.gate) {
        await opts.gate()
      }
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
      const replies = messages.map(handleRpc).filter((r) => r !== undefined)
      if (replies.length === 0) {
        return new Response(null, { status: 202 })
      }
      return jsonResponse(replies.length === 1 ? replies[0] : replies)
    }

    return new Response('not found', { status: 404 })
  }

  return { fetchFn, state, requests }
}

const silent = () => {}

const collect = () => {
  const lines: string[] = []
  return { log: (_l: string, m: string) => lines.push(m), lines }
}

const connect = (servers: Record<string, IMcpServerConfig>, log = silent) =>
  connectMcpServers(servers, log as never, 'agent-test')

const callTool = (
  tools: Record<string, unknown>,
  name: string,
  args: unknown,
): Promise<unknown> => {
  const tool = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }
  return tool.execute(args, {})
}

const makeProvider = (store = new MemoryOAuthStore()) =>
  createNodeOAuthProvider({ serverUrl: MCP_URL, redirectUrl: REDIRECT_URL, store })

// ── connect / mount / dispatch ──────────────────────────────────────────────

test('connectMcpServers: mounts prefixed tools and dispatches through the transport', async () => {
  const mock = createMockServer()
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } })

  assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  assert.equal(await callTool(mcp.tools, 'docs__echo', { text: 'hi' }), 'echo:{"text":"hi"}')
  await mcp.close()
})

test('connectMcpServers: an MCP result with isError becomes a failed tool call', async () => {
  const mock = createMockServer({ tools: [{ name: 'boom', inputSchema: { type: 'object' } }] })
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  // Not a resolved value carrying error text: the AI SDK must see a throw, or
  // toolCalls[].ok stays true and replanAfter: 'failure' never fires.
  await assert.rejects(() => callTool(mcp.tools, 'docs__boom', {}), /kaboom/)
  await mcp.close()
})

test('connectMcpServers: a throwing outputSanitizer cannot turn isError into success', async () => {
  const mock = createMockServer({ tools: [{ name: 'boom', inputSchema: { type: 'object' } }] })
  const mcp = await connectMcpServers(
    { docs: { url: MCP_URL, fetch: mock.fetchFn } },
    silent as never,
    'agent-test',
    () => {
      throw new Error('sanitizer exploded')
    },
  )
  // The redaction placeholder must still arrive as a THROW: returning it would
  // record ok: true for a call the server reported as failed.
  await assert.rejects(() => callTool(mcp.tools, 'docs__boom', {}), /output redacted/)
  await mcp.close()
})

test('connectMcpServers: a failed MCP call survives JSON serialization of the trace', async () => {
  const mock = createMockServer({ tools: [{ name: 'boom', inputSchema: { type: 'object' } }] })
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  const err = await callTool(mcp.tools, 'docs__boom', {}).then(
    () => undefined,
    (e: unknown) => e,
  )
  // The AI SDK puts the thrown value on the tool-error part verbatim, and it
  // ends up in IStepResult -> IPersistence. JSON.stringify(new Error()) is
  // "{}", which would lose the server's message entirely.
  assert.equal(JSON.parse(JSON.stringify({ output: err })).output, 'kaboom')
  await mcp.close()
})

test('connectMcpServers: tool names are sanitized into the provider-safe alphabet', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'files.read', inputSchema: { type: 'object' } },
      { name: 'files/read', inputSchema: { type: 'object' } },
    ],
  })
  const mcp = await connect({ 'my docs': { url: MCP_URL, fetch: mock.fetchFn } })
  // "my docs" and both dotted/slashed tool names would be rejected outright by
  // OpenAI's ^[a-zA-Z0-9_-]{1,64}$; the collision is suffixed, not dropped.
  assert.deepEqual(Object.keys(mcp.tools), ['my_docs__files_read', 'my_docs__files_read_2'])
  assert.equal(await callTool(mcp.tools, 'my_docs__files_read', { a: 1 }), 'files.read:{"a":1}')
  assert.equal(await callTool(mcp.tools, 'my_docs__files_read_2', { a: 1 }), 'files/read:{"a":1}')
  await mcp.close()
})

test('connectMcpServers: tools over the 64-char name cap are skipped with a warning', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'x'.repeat(70), inputSchema: { type: 'object' } },
      { name: 'ok', inputSchema: { type: 'object' } },
    ],
  })
  const logger = collect()
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } }, logger.log as never)
  assert.deepEqual(Object.keys(mcp.tools), ['docs__ok'])
  assert.ok(logger.lines.some((m) => m.includes('exceeds the 64-char limit')))
  await mcp.close()
})

test('connectMcpServers: closes the client when listTools fails after connect', async () => {
  const mock = createMockServer({ failListTools: true })
  const logger = collect()
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } }, logger.log as never)
  assert.equal(mcp.results[0].connected, false)
  // Otherwise the transport (an SSE stream here, a spawned child for stdio)
  // outlives the failed connect with nothing holding a handle to it.
  assert.ok(logger.lines.some((m) => m.includes('transport closed')))
})

test('connectMcpServers: servers connect concurrently but mount in declaration order', async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let slowBlocked = false
  let gatedOnce = false
  let overlapped = false
  let fallbackFired = false
  // "slow" blocks on its first request; "fast" releases it. Overlap is only
  // recorded if fast's request lands WHILE slow is still blocked — a
  // sequential connector would reach fast only after the fallback timer had
  // unblocked slow, which the fallbackFired assertion then catches.
  const timer = setTimeout(() => {
    fallbackFired = true
    release()
  }, 2000)
  const slow = createMockServer({
    tools: [{ name: 's', inputSchema: { type: 'object' } }],
    gate: async () => {
      if (gatedOnce) return
      gatedOnce = true
      slowBlocked = true
      await gate
      slowBlocked = false
    },
  })
  const fast = createMockServer({
    tools: [{ name: 'f', inputSchema: { type: 'object' } }],
    onMcpRequest: () => {
      if (slowBlocked) overlapped = true
      release()
    },
  })

  const logger = collect()
  const mcp = await connect(
    {
      slow: { url: MCP_URL, fetch: slow.fetchFn },
      fast: { url: MCP_URL, fetch: fast.fetchFn },
    },
    logger.log as never,
  )
  clearTimeout(timer)

  assert.equal(fallbackFired, false, 'the gate was opened by the second server, not by the timer')
  assert.equal(overlapped, true, 'the second server was reached while the first was still blocked')
  assert.deepEqual(Object.keys(mcp.tools), ['slow__s', 'fast__f'], logger.lines.join(' | '))
  assert.deepEqual(
    mcp.results.map((r) => r.name),
    ['slow', 'fast'],
  )
  await mcp.close()
})

test('connectMcpServers: one broken server does not stop the others', async () => {
  const mock = createMockServer()
  const mcp = await connect({
    dead: {
      url: 'https://dead.example.test/mcp',
      fetch: async () => new Response('x', { status: 500 }),
    },
    docs: { url: MCP_URL, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results.find((r) => r.name === 'dead')?.connected, false)
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  await mcp.close()
})

test('connectMcpServers: two server names that sanitize alike keep both tool sets', async () => {
  // "a.b" and "a/b" both sanitize to "a_b__": purging by prefix would unmount
  // the first server's tools while leaving its catalogue rows, and route its
  // name to the OTHER server's client.
  const a = createMockServer()
  const b = createMockServer()
  const mcp = await connect({
    'a.b': { url: MCP_URL, fetch: a.fetchFn },
    'a/b': { url: MCP_URL, fetch: b.fetchFn },
  })

  assert.deepEqual(Object.keys(mcp.tools), ['a_b__echo', 'a_b__echo_2'])
  assert.deepEqual(
    mcp.catalog.map((c) => `${c.server}:${c.name}`),
    ['a.b:a_b__echo', 'a/b:a_b__echo_2'],
  )
  await callTool(mcp.tools, 'a_b__echo_2', {})
  assert.equal(b.state.toolCalls, 1, 'the suffixed key reaches the second server')
  assert.equal(a.state.toolCalls, 0)
  await mcp.close()
})

test('refreshServer: a nested server prefix is not swept away', async () => {
  // "a__b" starts with "a__": a prefix purge while refreshing "a" would
  // silently unmount every tool of the other server mid-session.
  const outer = createMockServer({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] })
  const inner = createMockServer({ tools: [{ name: 'y', inputSchema: { type: 'object' } }] })
  const mcp = await connect({
    a: { url: MCP_URL, fetch: outer.fetchFn },
    a__b: { url: MCP_URL, fetch: inner.fetchFn },
  })
  assert.deepEqual(Object.keys(mcp.tools).sort(), ['a__b__y', 'a__x'])

  await mcp.refreshServer('a')

  assert.deepEqual(Object.keys(mcp.tools).sort(), ['a__b__y', 'a__x'])
  assert.equal(mcp.catalog.length, 2)
  await mcp.close()
})

test('refreshServer: re-lists one server and rewrites its entries in place', async () => {
  const tools = [{ name: 'echo', inputSchema: { type: 'object' } }]
  const mock = createMockServer({ tools })
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  const live = mcp.tools

  tools.push({ name: 'added', inputSchema: { type: 'object' } })
  await mcp.refreshServer('docs')

  assert.equal(mcp.tools, live, 'the same object reference — a running agent sees the new tool')
  assert.deepEqual(Object.keys(live).sort(), ['docs__added', 'docs__echo'])
  await assert.rejects(() => mcp.refreshServer('nope'), /is not connected/)
  await mcp.close()
})

// ── OAuth ───────────────────────────────────────────────────────────────────

test('OAuth: an unauthenticated connect registers dynamically and asks to authorize', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  const mcp = await connect({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })

  assert.equal(mcp.results[0].connected, false)
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(mock.state.registrations, 1, 'dynamic client registration ran')
  const url = provider.authorizationUrl
  assert.ok(url)
  assert.equal(url.searchParams.get('client_id'), 'dcr-client-1')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URL)
})

test('DCR: the registration request describes a public PKCE client', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = createNodeOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    store: new MemoryOAuthStore(),
    clientName: 'agent-test',
  })
  await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  const sent = mock.state.lastRegistration
  assert.ok(sent, 'a registration body was posted')
  assert.equal(sent.client_name, 'agent-test')
  assert.deepEqual(sent.redirect_uris, [REDIRECT_URL])
  assert.deepEqual(sent.response_types, ['code'])
  // Without refresh_token in grant_types the AS may never issue one, and every
  // expiry would become an interactive re-authorization.
  assert.deepEqual(sent.grant_types, ['authorization_code', 'refresh_token'])
  // A CLI cannot keep a client_secret; PKCE is what protects the exchange.
  assert.equal(sent.token_endpoint_auth_method, 'none')
  // Scope comes from the resource metadata when the caller didn't pin one.
  assert.equal(sent.scope, 'mcp:tools')
})

test('DCR: a stored registration is reused instead of registering again', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()

  await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })
  await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  assert.equal(mock.state.registrations, 1, 'a restart must not mint a second client')
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

  const mcp = await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(mock.state.registrations, 1, 'the dead client_id was replaced by a new registration')
  assert.equal((await provider.clientInformation())?.client_id, 'dcr-client-1')
  // Credentials tied to the dead client must go, or every later attempt
  // retries the same doomed refresh.
  assert.equal(await provider.tokens(), undefined)
  assert.equal(provider.authorizationUrl?.searchParams.get('client_id'), 'dcr-client-1')
})

test('DCR: a rejected registration surfaces the reason instead of a bare 401', async () => {
  const mock = createMockServer({ requireAuth: true })
  mock.state.failRegistration = true
  const provider = makeProvider()

  const mcp = await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  assert.equal(mcp.results[0].connected, false)
  assert.match(mcp.results[0].error ?? '', /redirect_uri not allowed/)
  assert.equal(await provider.clientInformation(), undefined, 'nothing half-registered was stored')
})

test('OAuth: full flow — authorize, exchange the code, connect, call a tool', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()

  await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })
  const state = provider.authorizationUrl?.searchParams.get('state') ?? undefined
  await finishMcpOAuth(provider, { code: 'auth-code-1', state }, { fetch: mock.fetchFn })
  assert.ok(mock.state.lastCodeVerifier, 'the exchange carried the PKCE verifier')

  const mcp = await connect({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)
  assert.equal(await callTool(mcp.tools, 'docs__echo', { text: 'hi' }), 'echo:{"text":"hi"}')
  const posts = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith(MCP_URL))
  assert.equal(posts.at(-1)?.auth, 'Bearer access-2')
  await mcp.close()
})

test('OAuth: rejects a callback whose state does not match', async () => {
  const provider = makeProvider()
  await provider.state()
  await assert.rejects(
    () => finishMcpOAuth(provider, { code: 'auth-code-1', state: 'forged' }),
    /state mismatch/,
  )
})

test('OAuth: a token that expires mid-session is refreshed and the call retried', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-1',
  })

  const mcp = await connect({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)

  mock.state.validTokens.clear() // the server now rejects what we hold
  assert.equal(await callTool(mcp.tools, 'docs__echo', { text: 'x' }), 'echo:{"text":"x"}')
  assert.ok(mock.state.grants.includes('refresh_token'))
  assert.equal((await provider.tokens())?.access_token, 'access-2')
  await mcp.close()
})

test('OAuth: an already-expired token is refreshed before the first request', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 5, // inside the 30s skew: known dead before we connect
    refresh_token: 'refresh-1',
  })
  mock.state.validTokens.clear()

  const mcp = await connect({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)
  const posts = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith(MCP_URL))
  assert.ok(posts.length > 0)
  assert.ok(
    posts.every((r) => r.auth === 'Bearer access-2'),
    'no request was ever sent with the dead token',
  )
  await mcp.close()
})

test('OAuth: a dead refresh token clears the tokens and asks to authorize again', async () => {
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

  const mcp = await connect({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(await provider.tokens(), undefined)
})

// ── provider + stores ───────────────────────────────────────────────────────

test('NodeOAuthProvider: expiry honours the skew, and an absent expires_in waits for a 401', async () => {
  const provider = makeProvider()
  assert.equal(await provider.isAccessTokenExpired(), true)

  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 })
  assert.equal(await provider.isAccessTokenExpired(), false)
  assert.equal(await provider.isAuthorized(), true)

  await provider.saveTokens({ access_token: 'b', token_type: 'Bearer', expires_in: 10 })
  assert.equal(await provider.isAccessTokenExpired(), true)

  await provider.saveTokens({ access_token: 'c', token_type: 'Bearer' })
  assert.equal(await provider.isAccessTokenExpired(), false)
})

test('NodeOAuthProvider: state is single-use', async () => {
  const provider = makeProvider()
  const issued = await provider.state()
  assert.equal(await provider.verifyState(issued), true)
  assert.equal(await provider.verifyState(issued), false)
})

test('NodeOAuthProvider: invalidateCredentials drops only the requested scope', async () => {
  const provider = makeProvider()
  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' })
  await provider.saveClientInformation({ client_id: 'c1' })

  await provider.invalidateCredentials('tokens')
  assert.equal(await provider.tokens(), undefined)
  assert.deepEqual(await provider.clientInformation(), { client_id: 'c1' })

  await provider.reset()
  assert.equal(await provider.clientInformation(), undefined)
})

test('NodeOAuthProvider: refuses a plaintext http server that is not loopback', () => {
  const make = (serverUrl: string) =>
    createNodeOAuthProvider({ serverUrl, redirectUrl: REDIRECT_URL, store: new MemoryOAuthStore() })

  assert.throws(() => make('http://mcp.example.test/mcp'), /requires https/)
  // A registrable host that merely STARTS with "localhost" is not loopback —
  // a prefix match would send bearer tokens to it in cleartext.
  assert.throws(() => make('http://localhost.attacker.test/mcp'), /requires https/)
  assert.ok(make('http://localhost:8765/mcp'))
  assert.ok(make('http://127.0.0.1:8765/mcp'))
  assert.ok(make('HTTPS://mcp.example.test/mcp'), 'the scheme check is case-insensitive')
})

test('connectMcpServers: an OAuth server config over plaintext http is refused', async () => {
  const provider = createNodeOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    store: new MemoryOAuthStore(),
  })
  // The provider guards its own URL; the transport talks to cfg.url, so a
  // mismatched pair would still put tokens on the wire in cleartext.
  const mcp = await connect({
    docs: { url: 'http://mcp.example.test/mcp', authProvider: provider },
  })
  assert.equal(mcp.results[0].connected, false)
  assert.match(mcp.results[0].error ?? '', /requires https/)
})

test('NodeOAuthProvider: two tenants of one endpoint do not share credentials', async () => {
  const store = new MemoryOAuthStore()
  const a = createNodeOAuthProvider({
    serverUrl: `${MCP_URL}?tenant=a`,
    redirectUrl: REDIRECT_URL,
    store,
  })
  const b = createNodeOAuthProvider({
    serverUrl: `${MCP_URL}?tenant=b`,
    redirectUrl: REDIRECT_URL,
    store,
  })
  await a.saveTokens({ access_token: 'tenant-a', token_type: 'Bearer' })
  assert.equal((await a.tokens())?.access_token, 'tenant-a')
  assert.equal(await b.tokens(), undefined)
})

test('OAuth: a transient refresh failure still leads to ONE usable authorization', async () => {
  // auth() silently escalates a failed refresh into a full authorization,
  // issuing a state + PKCE verifier that the transport's own 401 handling
  // would then overwrite — leaving the operator with a code the stored pair
  // cannot verify, on every attempt.
  const mock = createMockServer({ requireAuth: true })
  mock.state.failRefresh = true
  const prompts: URL[] = []
  const provider = createNodeOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    store: new MemoryOAuthStore(),
    onAuthorizationUrl: (url) => {
      prompts.push(url)
    },
  })
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 5, // inside the skew window: the proactive refresh fires first
    refresh_token: 'refresh-1',
  })
  mock.state.validTokens.clear()

  const mcp = await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(prompts.length, 1, 'the operator was asked exactly once')

  mock.state.failRefresh = false
  await finishMcpOAuth(
    provider,
    { code: 'auth-code-1', state: prompts[0].searchParams.get('state') ?? undefined },
    { fetch: mock.fetchFn },
  )
  assert.ok((await provider.tokens())?.access_token, 'the state that reached the user verified')
})

test('filterTools: allow/deny entries are matched against sanitized names', async () => {
  const mock = createMockServer({
    tools: [{ name: 'files.read', inputSchema: { type: 'object' } }],
  })
  const logger = collect()
  const mcp = await connectMcpServers(
    { 'my.docs': { url: MCP_URL, fetch: mock.fetchFn } },
    logger.log as never,
    'agent-test',
  )

  // The operator configures the name the SERVER advertises; the catalogue
  // holds the sanitized one. A denylist that stops matching silently hands a
  // blocked tool back to the model.
  const denied = filterTools(mcp.tools, mcp.catalog, undefined, ['my.docs__files.read'])
  assert.deepEqual(Object.keys(denied.tools), [])

  const allowed = filterTools(mcp.tools, mcp.catalog, ['my.docs__files.read'])
  assert.deepEqual(Object.keys(allowed.tools), ['my_docs__files_read'])

  const missing = collect()
  filterTools(mcp.tools, mcp.catalog, ['nope__nothing'], undefined, missing.log as never)
  assert.ok(missing.lines.some((m) => m.includes('matches no discovered tool')))
  await mcp.close()
})

test('FileOAuthStore: a file holding a JSON non-object is recovered from, not fatal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-oauth-'))
  const file = path.join(dir, 'tokens.json')
  await writeFile(file, 'null')
  const store = new FileOAuthStore(file)

  assert.equal(await store.get('k'), undefined)
  await store.set('k', 'v')
  assert.equal(await store.get('k'), 'v')
})

test('FileOAuthStore: round-trips values and keeps the file owner-only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-oauth-'))
  const file = path.join(dir, 'nested', 'tokens.json')
  const store = new FileOAuthStore(file)

  await store.set('a', 'one')
  await store.set('b', 'two')
  assert.equal(await store.get('a'), 'one')

  // Tokens are bearer credentials: anything that can read the file is the user.
  assert.equal((await stat(file)).mode & 0o777, 0o600)

  await store.delete('a')
  assert.equal(await store.get('a'), undefined)
  assert.equal(await store.get('b'), 'two')
  assert.equal(await store.get('missing'), undefined)
})

test('FileOAuthStore: concurrent writes do not clobber each other', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-oauth-'))
  const store = new FileOAuthStore(path.join(dir, 'tokens.json'))

  await Promise.all(Array.from({ length: 8 }, (_, i) => store.set(`k${i}`, `v${i}`)))
  for (let i = 0; i < 8; i++) {
    assert.equal(await store.get(`k${i}`), `v${i}`)
  }
})

// ── pagination / connect timeout / annotations ─────────────────────────────

test('connectMcpServers: follows tools/list pagination, on connect and on refresh', async () => {
  const tools = Array.from({ length: 7 }, (_, i) => ({
    name: `t${i}`,
    inputSchema: { type: 'object' },
  }))
  const mock = createMockServer({ tools, pageSize: 3 })
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  assert.deepEqual(
    Object.keys(mcp.tools),
    tools.map((t) => `docs__${t.name}`),
  )
  assert.deepEqual(mock.state.listCursors, [undefined, '3', '6'])

  tools.push({ name: 't7', inputSchema: { type: 'object' } })
  await mcp.refreshServer('docs')
  assert.equal(Object.keys(mcp.tools).length, 8)
  assert.deepEqual(mock.state.listCursors.slice(3), [undefined, '3', '6'])
  await mcp.close()
})

test('connectMcpServers: a server that never answers times out; the others still mount', async () => {
  const hanging = createMockServer({ gate: () => new Promise<void>(() => {}) })
  const healthy = createMockServer()
  const logger = collect()
  const started = Date.now()
  const mcp = await connectMcpServers(
    {
      slow: { url: MCP_URL, fetch: hanging.fetchFn },
      docs: { url: MCP_URL, fetch: healthy.fetchFn },
    },
    logger.log as never,
    'agent-test',
    undefined,
    undefined,
    undefined,
    { connectTimeoutMs: 150 },
  )
  assert.ok(Date.now() - started < 2_000, 'the timeout bounded the connect')
  assert.deepEqual(mcp.results[0], {
    name: 'slow',
    connected: false,
    error: 'connect timed out after 150ms',
  })
  assert.equal(mcp.results[1].connected, true)
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  assert.ok(logger.lines.some((m) => m.includes('slow: failed to connect - connect timed out')))
  await mcp.close()
})

test('connectMcpServers: a per-server connectTimeoutMs wins over the default', async () => {
  const hanging = createMockServer({ gate: () => new Promise<void>(() => {}) })
  const mcp = await connectMcpServers(
    { slow: { url: MCP_URL, fetch: hanging.fetchFn, connectTimeoutMs: 50 } },
    silent as never,
    'agent-test',
    undefined,
    undefined,
    undefined,
    { connectTimeoutMs: 60_000 },
  )
  assert.equal(mcp.results[0].error, 'connect timed out after 50ms')
  await mcp.close()
})

test('connectMcpServers: annotations.readOnlyHint marks the tool and its catalogue entry', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'get', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'put', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
    ],
  })
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  assert.deepEqual(
    mcp.catalog.map((c) => [c.name, c.readOnly]),
    [
      ['docs__get', true],
      ['docs__put', false],
    ],
  )
  assert.equal(isReadOnlyTool(mcp.tools.docs__get), true)
  assert.equal(isReadOnlyTool(mcp.tools.docs__put), false)
  await mcp.close()
})

// ── OAuth hardening: CIMD, application_type, discovery state, RFC 9207 ──────
// The same block lives in the sibling package's suite (packages/agent-web/tests/mcp.test.ts): the two
// providers share names and semantics, so they share the tests.

const CIMD_URL = 'https://app.example.test/oauth/client.json'

const hardened = (extra: Record<string, unknown> = {}, store = new MemoryOAuthStore()) =>
  createNodeOAuthProvider({ serverUrl: MCP_URL, redirectUrl: REDIRECT_URL, store: store, ...extra })

const begin = (provider: NodeOAuthProvider, mock: ReturnType<typeof createMockServer>) =>
  connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

const issuedState = (provider: NodeOAuthProvider): string | undefined =>
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
  assert.equal(
    (hardened().clientMetadata as { application_type?: string }).application_type,
    'native',
  )
  assert.equal(
    (
      hardened({ redirectUrl: 'https://app.example.test/callback' }).clientMetadata as {
        application_type?: string
      }
    ).application_type,
    'web',
  )
})

test('DCR: the registration request carries application_type, and clientMetadata overrides it', async () => {
  const mock = createMockServer({ requireAuth: true })
  await begin(hardened(), mock)
  assert.equal(mock.state.lastRegistration?.application_type, 'native')

  const other = createMockServer({ requireAuth: true })
  await begin(hardened({ clientMetadata: { application_type: 'web' } }), other)
  assert.equal(other.state.lastRegistration?.application_type, 'web')
})

test('issuer stamp: what the SDK stamps on the client and the tokens survives the store', async () => {
  const mock = createMockServer({ requireAuth: true })
  const store = new MemoryOAuthStore()
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

test('RFC 9207: a store without discovery state (older version) keeps working', async () => {
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

  const again = createMockServer({ requireAuth: true })
  const second = hardened()
  await begin(second, again)
  await second.invalidateCredentials('discovery')
  await finishMcpOAuth(
    second,
    { code: 'auth-code-1', state: issuedState(second), iss: AS_URL },
    { fetch: again.fetchFn },
  )
  assert.equal((await second.tokens())?.access_token, 'access-2')

  // Nothing to compare against at all: an unstamped registration, no discovery
  // state. With or without iss the exchange goes ahead, as it did before.
  for (const iss of [undefined, 'https://whoever.example.test']) {
    const old = createMockServer({ requireAuth: true })
    const legacy = hardened()
    await legacy.saveClientInformation({ client_id: 'old-client' })
    await legacy.saveCodeVerifier('verifier-from-an-older-version')
    const state = await legacy.state()
    await finishMcpOAuth(legacy, { code: 'auth-code-1', state, iss }, { fetch: old.fetchFn })
    assert.deepEqual(old.state.grants, ['authorization_code'])
    assert.equal((await legacy.tokens())?.access_token, 'access-2')
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
