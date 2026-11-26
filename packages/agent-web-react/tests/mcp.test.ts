import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  claimOAuthCallback,
  describeMcpResult,
  isUnauthorizedError,
  mcpInstructionsOf,
  mcpOAuthProviderOptions,
  readCallbackParams,
  stripOAuthParams,
} from '../dist/mcp.js'

// The connect/OAuth machinery lives in the core and is covered there; what this
// package owns is the mapping from a connect outcome to UI state, and the URL
// hygiene around the redirect. Both are pure, so they are tested without React.

test('describeMcpResult: a connected server yields the connected status', () => {
  assert.deepEqual(describeMcpResult({ name: 'mcp', connected: true }), { status: 'connected' })
})

test('describeMcpResult: needsAuthorization outranks the accompanying error text', () => {
  assert.deepEqual(
    describeMcpResult({
      name: 'mcp',
      connected: false,
      needsAuthorization: true,
      error: 'Unauthorized',
    }),
    { status: 'needs-authorization' },
  )
})

test('describeMcpResult: a plain failure carries the server error through', () => {
  assert.deepEqual(describeMcpResult({ name: 'mcp', connected: false, error: 'DNS exploded' }), {
    status: 'error',
    error: 'DNS exploded',
  })
})

test('describeMcpResult: a failure with no message still gets a readable one', () => {
  const { status, error } = describeMcpResult({ name: 'mcp', connected: false })
  assert.equal(status, 'error')
  assert.match(error ?? '', /Could not connect/)
})

test('describeMcpResult: a missing result is an error, not a crash', () => {
  const { status, error } = describeMcpResult(undefined)
  assert.equal(status, 'error')
  assert.match(error ?? '', /no result/)
})

test('stripOAuthParams: drops the single-use response params, keeps everything else', () => {
  assert.equal(
    stripOAuthParams('https://app.test/demo/?code=abc&state=xyz&iss=as&view=mcp#/panel'),
    'https://app.test/demo/?view=mcp#/panel',
  )
})

test('stripOAuthParams: drops an error response too', () => {
  assert.equal(
    stripOAuthParams('https://app.test/?error=access_denied&error_description=nope'),
    'https://app.test/',
  )
})

test('stripOAuthParams: leaves a clean URL untouched', () => {
  assert.equal(stripOAuthParams('https://app.test/demo/'), 'https://app.test/demo/')
})

// The callback has to be read synchronously, before the hook's first await:
// React flushes the rest of the app's effects in between, and one of them may
// rewrite location (the demo's own view router did exactly that).

test('readCallbackParams: reads a query-string callback', () => {
  assert.deepEqual(readCallbackParams('https://app.test/demo/?code=abc&state=xyz'), {
    code: 'abc',
    state: 'xyz',
    iss: undefined,
    error: undefined,
    errorDescription: undefined,
  })
})

test('readCallbackParams: reads a callback carried in a hash route', () => {
  assert.deepEqual(readCallbackParams('https://app.test/#/cb?code=abc&state=xyz'), {
    code: 'abc',
    state: 'xyz',
    iss: undefined,
    error: undefined,
    errorDescription: undefined,
  })
})

test('readCallbackParams: reads a denial, and ignores a URL carrying neither', () => {
  const denied = readCallbackParams('https://app.test/?error=access_denied&error_description=nope')
  assert.equal(denied?.error, 'access_denied')
  assert.equal(denied?.errorDescription, 'nope')
  assert.equal(readCallbackParams('https://app.test/demo/?view=mcp'), undefined)
  assert.equal(readCallbackParams('not a url'), undefined)
})

test('stripOAuthParams: clears a callback carried in the fragment too', () => {
  assert.equal(
    stripOAuthParams('https://app.test/#/cb?code=abc&state=xyz&tab=tools'),
    'https://app.test/#/cb?tab=tools',
  )
  assert.equal(stripOAuthParams('https://app.test/#/cb?code=abc'), 'https://app.test/#/cb')
})

test('claimOAuthCallback: a code can only be claimed once', () => {
  const callback = { code: 'single-use', state: 'st' }
  // StrictMode mounts every effect twice in development; the second pass must
  // not race the first into the token endpoint, where it would lose the
  // single-use state check and report a CSRF failure on a good flow.
  assert.equal(claimOAuthCallback(callback), true)
  assert.equal(claimOAuthCallback({ ...callback }), false)
  assert.equal(claimOAuthCallback({ code: 'another', state: 'st' }), true)
})

// The 1.x SDK's UnauthorizedError never assigned `this.name`, so it read as
// "Error" — a name check silently never fired, which is how the mid-session
// re-authorization prompt shipped as dead code. The first three tests are that
// era's (a class of its own stands in for the SDK's); the ones after them use
// the real class of the 2.x SDK, as the core's `./mcp` hands it over.

test('isUnauthorizedError: matches the core-exported class by identity', () => {
  class UnauthorizedError extends Error {}
  const mod = { UnauthorizedError } as never
  assert.equal(isUnauthorizedError(new UnauthorizedError('Unauthorized'), mod), true)
  assert.equal(isUnauthorizedError(new Error('Unauthorized'), mod), false)
})

test('isUnauthorizedError: falls back to the constructor name on an older core', () => {
  class UnauthorizedError extends Error {}
  const err = new UnauthorizedError()
  assert.equal(err.name, 'Error', 'guards the assumption behind the fallback')
  assert.equal(isUnauthorizedError(err), true)
})

test('isUnauthorizedError: a tool whose own error mentions "unauthorized" is not auth', () => {
  // The connector throws a failing tool's text verbatim, so message matching
  // would flip the UI into an auth prompt for an ordinary tool failure.
  assert.equal(isUnauthorizedError(new Error('unauthorized: quota exceeded')), false)
  assert.equal(isUnauthorizedError('not an error'), false)
  assert.equal(isUnauthorizedError(undefined), false)
})

// The hook gets the class from a dynamic `import('@dudko.dev/agent-web/mcp')`
// and the error from a tool call made deep inside the core: the two must still
// meet when they crossed that boundary, and when the page holds two copies of
// the SDK (the CommonJS build below is a second copy with classes of its own).

const coreMcp = async () =>
  (await import('@dudko.dev/agent-web/mcp')) as unknown as {
    UnauthorizedError: new (message?: string) => Error
    connectMcpHttp: (
      servers: Record<string, unknown>,
      opts?: unknown,
    ) => Promise<{
      results: { connected: boolean; needsAuthorization?: boolean }[]
      tools: Record<string, unknown>
      close: () => Promise<void>
    }>
  }

/** The SDK the core resolves to, loaded a second time as CommonJS. */
const secondSdkCopy = () =>
  createRequire(import.meta.resolve('@dudko.dev/agent-web/mcp'))(
    '@modelcontextprotocol/client',
  ) as {
    UnauthorizedError: new (message?: string) => Error
    InsufficientScopeError: new (init: { requiredScope?: string }) => Error
    ProtocolError: new (code: number, message: string) => Error
  }

test('isUnauthorizedError: the 2.x class from the core module, by identity and by name', async () => {
  const mod = await coreMcp()
  const err = new mod.UnauthorizedError()
  assert.equal(err.name, 'UnauthorizedError')
  assert.equal(isUnauthorizedError(err, mod as never), true)
  // Without the module too (a host that only has the error in hand).
  assert.equal(isUnauthorizedError(err), true)
  // A minified host bundle renames the class; the name the SDK sets is a string.
  const Renamed = { e: class extends mod.UnauthorizedError {} }.e
  assert.notEqual(Renamed.name, 'UnauthorizedError')
  assert.equal(isUnauthorizedError(new Renamed(), mod as never), true)
  assert.equal(isUnauthorizedError(new Renamed()), true)
})

test('isUnauthorizedError: a class with no name to go by is recognised by identity alone', () => {
  // The 1.x class in a minified bundle: `name` reads "Error" and the class is
  // called something else. Only the class the core module hands over tells.
  const Minified = { e: class extends Error {} }.e
  const err = new Minified('Unauthorized')
  assert.equal(err.name, 'Error')
  assert.notEqual(Minified.name, 'UnauthorizedError')
  assert.equal(isUnauthorizedError(err, { UnauthorizedError: Minified } as never), true)
  assert.equal(isUnauthorizedError(err), false)
  assert.equal(
    isUnauthorizedError(err, { UnauthorizedError: class extends Error {} } as never),
    false,
  )
})

test('isUnauthorizedError: an error made by another copy of the SDK is still recognised', async () => {
  const mod = await coreMcp()
  const other = secondSdkCopy()
  assert.notEqual(other.UnauthorizedError, mod.UnauthorizedError, 'two copies, two classes')
  const foreign = new other.UnauthorizedError('Unauthorized')
  assert.equal(isUnauthorizedError(foreign, mod as never), true)
  assert.equal(isUnauthorizedError(new mod.UnauthorizedError(), other as never), true)
})

test('isUnauthorizedError: other SDK errors and look-alike messages are not an authorization failure', async () => {
  const mod = await coreMcp()
  const other = secondSdkCopy()
  // What a tool call fails with on a 403 `insufficient_scope`: authorizing
  // again with the same scope would not help, so the panel must not ask.
  const scope = new other.InsufficientScopeError({ requiredScope: 'mcp:admin' })
  assert.equal(isUnauthorizedError(scope, mod as never), false)
  assert.equal(
    isUnauthorizedError(new other.ProtocolError(-32602, 'Unauthorized'), mod as never),
    false,
  )
  assert.equal(isUnauthorizedError(new Error('Unauthorized'), mod as never), false)
  assert.equal(isUnauthorizedError(new TypeError('UnauthorizedError'), mod as never), false)
})

test('isUnauthorizedError: the error a real tool call fails with, once the token is refused', async () => {
  // End to end through the core, as the hook meets it: a connected server whose
  // token stops working mid-session and cannot be renewed. The error is thrown
  // inside the SDK's transport and comes out of the tool's `execute`.
  const mod = await coreMcp()
  let revoked = false
  let redirects = 0
  const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (String(url).includes('/.well-known/')) return new Response('not found', { status: 404 })
    if (init.method === 'GET') return new Response(null, { status: 405 })
    if (revoked) return json({ error: 'invalid_token' }, 401)
    const msg = JSON.parse(String(init.body)) as { id?: number; method: string; params?: never }
    if (msg.id === undefined) return new Response(null, { status: 202 })
    const result =
      msg.method === 'initialize'
        ? {
            protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'mock', version: '1' },
          }
        : msg.method === 'tools/list'
          ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'ok' }] }
    return json({ jsonrpc: '2.0', id: msg.id, result })
  }
  const provider = {
    get redirectUrl() {
      return 'https://app.example.test/callback'
    },
    get clientMetadata() {
      return { redirect_uris: ['https://app.example.test/callback'] }
    },
    clientInformation: () => ({ client_id: 'known' }),
    tokens: () => ({ access_token: 'access-1', token_type: 'Bearer' }),
    saveTokens: () => {},
    saveCodeVerifier: () => {},
    codeVerifier: () => 'v',
    redirectToAuthorization: () => {
      redirects += 1
    },
  }
  const mcp = await mod.connectMcpHttp({
    docs: { url: 'https://mcp.example.test/mcp', authProvider: provider, fetch: fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)
  const call = () =>
    (mcp.tools.docs__echo as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(
      {},
      {},
    )
  assert.equal(await call(), 'ok')

  revoked = true
  // What the hook's tool wrapper catches (`watchAuthorization`).
  const err = await call().then(
    () => undefined,
    (e: unknown) => e,
  )
  assert.ok(err instanceof Error)
  assert.equal(isUnauthorizedError(err, mod as never), true)
  assert.equal(isUnauthorizedError(err), true, 'by name too, without the module')
  assert.equal(redirects, 1)
  await mcp.close()
})

test('readCallbackParams: carries iss (RFC 9207) for the core to check', () => {
  const iss = 'https://as.example.test'
  const q = encodeURIComponent(iss)
  assert.equal(readCallbackParams(`https://app.test/?code=abc&state=xyz&iss=${q}`)?.iss, iss)
  assert.equal(readCallbackParams(`https://app.test/#/cb?code=abc&state=xyz&iss=${q}`)?.iss, iss)
  assert.equal(readCallbackParams(`https://app.test/?error=access_denied&iss=${q}`)?.iss, iss)
  // ...and it leaves the address bar with the rest of the response.
  assert.equal(
    stripOAuthParams(`https://app.test/#/cb?code=abc&state=xyz&iss=${q}&tab=tools`),
    'https://app.test/#/cb?tab=tools',
  )
})

// clientMetadataUrl (CIMD). Both hooks build every OAuth provider - on connect, on the way back
// from the redirect, when forgetting - from this one function, so what it returns is what the
// core is given.

const CIMD_URL = 'https://app.example.test/oauth/client.json'

test("mcpOAuthProviderOptions: the server's own clientMetadataUrl is passed through", () => {
  assert.deepEqual(
    mcpOAuthProviderOptions('https://mcp.example.test/mcp', {
      redirectUrl: 'https://app.example.test/',
      scope: 'mcp:tools',
      clientName: 'my-app',
      clientMetadataUrl: CIMD_URL,
    }),
    {
      serverUrl: 'https://mcp.example.test/mcp',
      redirectUrl: 'https://app.example.test/',
      scope: 'mcp:tools',
      clientName: 'my-app',
      clientMetadataUrl: CIMD_URL,
    },
  )
})

test("mcpOAuthProviderOptions: the hook-level clientMetadataUrl is the default, a server's own wins", () => {
  const defaults = { clientName: 'my-app', clientMetadataUrl: CIMD_URL }
  const fromHook = mcpOAuthProviderOptions('https://mcp.example.test/mcp', {}, defaults)
  assert.equal(fromHook.clientMetadataUrl, CIMD_URL)
  assert.equal(fromHook.clientName, 'my-app')

  const own = 'https://app.example.test/oauth/other-client.json'
  const fromServer = mcpOAuthProviderOptions(
    'https://mcp.example.test/mcp',
    { clientMetadataUrl: own, clientName: 'other' },
    defaults,
  )
  assert.equal(fromServer.clientMetadataUrl, own)
  assert.equal(fromServer.clientName, 'other')
})

test('mcpOAuthProviderOptions: with no clientMetadataUrl the field is absent, not undefined', () => {
  const opts = mcpOAuthProviderOptions('https://mcp.example.test/mcp', undefined, {
    clientName: 'my-app',
  })
  assert.equal('clientMetadataUrl' in opts, false)
})

test("clientMetadataUrl: the core's provider takes what the hooks hand it, and refuses a bad URL", async () => {
  // The real class from the core this package is built against: the structural type in
  // mcp-types.ts is only a claim until the constructor has seen the object.
  const { BrowserOAuthProvider } = await import('@dudko.dev/agent-web/mcp')
  const build = (clientMetadataUrl: string) =>
    new BrowserOAuthProvider(
      mcpOAuthProviderOptions(
        'https://mcp.example.test/mcp',
        { redirectUrl: 'https://app.example.test/' },
        { clientMetadataUrl },
      ),
    )
  assert.equal(build(CIMD_URL).clientMetadataUrl, CIMD_URL)
  // The hooks catch this and report it as the server's error; nothing is requested.
  assert.throws(() => build('http://app.example.test/oauth/client.json'), /clientMetadataUrl/)
  assert.throws(() => build('https://app.example.test/'), /clientMetadataUrl/)
})

test('mcpInstructionsOf: the text one server sent, by its name', () => {
  const connection = {
    instructions: [
      { server: 'docs', instructions: 'Search before you answer.' },
      { server: 'crm', instructions: 'Never delete.' },
    ],
  }
  assert.equal(mcpInstructionsOf(connection, 'crm'), 'Never delete.')
  assert.equal(mcpInstructionsOf(connection, 'other'), undefined)
})

test('mcpInstructionsOf: an older core (no field), an empty text and a malformed list are "none"', () => {
  assert.equal(mcpInstructionsOf({}, 'docs'), undefined)
  assert.equal(
    mcpInstructionsOf({ instructions: [{ server: 'docs', instructions: '  ' }] }, 'docs'),
    undefined,
  )
  assert.equal(mcpInstructionsOf({ instructions: 'nope' as unknown as [] }, 'docs'), undefined)
})

test('protocol: the core takes the field of McpHttpServerConfig and reports protocols, as mcp-types describes them', async () => {
  // The structural types in src/mcp-types.ts (`McpHttpServerConfig.protocol`,
  // `ConnectedMcp.protocols`) describe the core this package is built against:
  // checked here against the real thing, over real sockets.
  const { startLocalMcpServer } = await import('@dudko.dev/test-servers')
  const mod = (await import('@dudko.dev/agent-web/mcp')) as unknown as {
    connectMcpHttp: (servers: Record<string, unknown>) => Promise<{
      results: { name: string; connected: boolean; error?: string }[]
      protocols?: { server: string; version: string; era: string }[]
      close: () => Promise<void>
    }>
  }
  const server = await startLocalMcpServer({ protocol: 'dual' })
  try {
    const mcp = await mod.connectMcpHttp({
      unset: { url: server.url },
      auto: { url: server.url, protocol: 'auto' },
      modern: { url: server.url, protocol: 'modern' },
    })
    assert.deepEqual(
      mcp.results.map((r) => r.connected),
      [true, true, true],
    )
    assert.deepEqual(mcp.protocols, [
      { server: 'unset', version: '2025-11-25', era: 'legacy' },
      { server: 'auto', version: '2026-07-28', era: 'modern' },
      { server: 'modern', version: '2026-07-28', era: 'modern' },
    ])
    await mcp.close()
  } finally {
    await server.close()
  }
})
