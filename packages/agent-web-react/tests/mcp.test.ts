import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { startLocalMcp } from '@dudko.dev/test-servers'
import {
  claimOAuthCallback,
  describeMcpResult,
  isUnauthorizedError,
  mcpInstructionsOf,
  mcpOAuthOptionsOfRecord,
  mcpOAuthProviderOptions,
  mcpOAuthRecordOf,
  mcpOAuthRegistrationOf,
  mcpSkillsSettingOf,
  newMcpOAuthProvider,
  readCallbackParams,
  stripOAuthParams,
  type McpModule,
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

// oauth.registration ('auto' | 'cimd' | 'dcr'): how the client is registered. The hooks hand it
// to the core through mcpOAuthProviderOptions, keep it in the redirect record (mcpOAuthRecordOf /
// mcpOAuthOptionsOfRecord - written before the user leaves, read on the way back), build the
// provider with newMcpOAuthProvider and report which way was taken (mcpOAuthRegistrationOf).

const MCP_URL = 'https://mcp.example.test/mcp'

test('mcpOAuthProviderOptions: registration is passed through when set, and absent when not', () => {
  const opts = mcpOAuthProviderOptions(
    MCP_URL,
    { registration: 'dcr' },
    { clientMetadataUrl: CIMD_URL },
  )
  assert.equal(opts.registration, 'dcr')
  assert.equal(
    opts.clientMetadataUrl,
    CIMD_URL,
    'the document stays: the core decides not to use it',
  )
  assert.equal('registration' in mcpOAuthProviderOptions(MCP_URL, {}, {}), false)
  assert.equal('registration' in mcpOAuthProviderOptions(MCP_URL, undefined, {}), false)
})

test('redirect record: registration survives the trip (JSON, the way localStorage keeps it)', () => {
  const started = mcpOAuthProviderOptions(
    MCP_URL,
    { redirectUrl: 'https://app.example.test/', scope: 'mcp:tools', registration: 'cimd' },
    { clientName: 'my-app', clientMetadataUrl: CIMD_URL },
  )
  const stored = JSON.parse(JSON.stringify(mcpOAuthRecordOf(started)))
  assert.equal(stored.registration, 'cimd')
  const back = mcpOAuthOptionsOfRecord(stored)
  assert.deepEqual(back, {
    redirectUrl: 'https://app.example.test/',
    scope: 'mcp:tools',
    clientName: 'my-app',
    clientMetadataUrl: CIMD_URL,
    registration: 'cimd',
  })
  // On the way back the hooks build the provider from it: the same client as before the trip,
  // whatever the hook's defaults are now.
  assert.deepEqual(
    mcpOAuthProviderOptions(MCP_URL, back, {
      clientName: 'renamed',
      clientMetadataUrl: 'https://x.test/c.json',
    }),
    started,
  )
})

test('redirect record: without registration the record and the options carry none', () => {
  const started = mcpOAuthProviderOptions(MCP_URL, { redirectUrl: 'https://app.example.test/' })
  const stored = JSON.parse(JSON.stringify(mcpOAuthRecordOf(started)))
  assert.equal('registration' in stored, false)
  assert.equal('registration' in mcpOAuthOptionsOfRecord(stored), false)
  // A record written before the option existed reads the same way.
  assert.equal(
    'registration' in mcpOAuthOptionsOfRecord({ redirectUrl: 'https://app.example.test/' }),
    false,
  )
})

test("newMcpOAuthProvider: the core's provider takes registration; 'dcr' hides the document, 'cimd' needs one", async () => {
  const core = (await import('@dudko.dev/agent-web/mcp')) as unknown as McpModule
  const build = (oauth: Record<string, unknown>) =>
    newMcpOAuthProvider(
      core,
      mcpOAuthProviderOptions(MCP_URL, { redirectUrl: 'https://app.example.test/', ...oauth }),
    ) as unknown as { registration?: string; clientMetadataUrl?: string }
  assert.equal(build({}).registration, 'auto')
  const dcr = build({ registration: 'dcr', clientMetadataUrl: CIMD_URL })
  assert.equal(dcr.registration, 'dcr')
  assert.equal(dcr.clientMetadataUrl, undefined)
  const cimd = build({ registration: 'cimd', clientMetadataUrl: CIMD_URL })
  assert.equal(cimd.registration, 'cimd')
  assert.equal(cimd.clientMetadataUrl, CIMD_URL)
  // The hooks report these as the server's error; nothing is requested.
  assert.throws(
    () => build({ registration: 'cimd' }),
    /registration 'cimd' needs a clientMetadataUrl/,
  )
  assert.throws(() => build({ registration: 'both' }), /registration must be/)
})

test("newMcpOAuthProvider: a core that does not know registration is refused for 'cimd' / 'dcr', used for the rest", () => {
  // A core from before the option: it ignores the field and would register the old way.
  class OldProvider {
    serverUrl: string
    constructor(opts: { serverUrl: string }) {
      this.serverUrl = opts.serverUrl
    }
    async isAuthorized() {
      return false
    }
    async reset() {}
  }
  const old = { BrowserOAuthProvider: OldProvider } as unknown as McpModule
  const opts = (registration?: 'auto' | 'cimd' | 'dcr') =>
    mcpOAuthProviderOptions(
      MCP_URL,
      { redirectUrl: 'https://app.example.test/', registration },
      {
        clientMetadataUrl: CIMD_URL,
      },
    )
  assert.throws(
    () => newMcpOAuthProvider(old, opts('cimd')),
    /does not support oauth\.registration \('cimd'\)/,
  )
  assert.throws(
    () => newMcpOAuthProvider(old, opts('dcr')),
    /does not support oauth\.registration \('dcr'\)/,
  )
  assert.ok(newMcpOAuthProvider(old, opts()) instanceof OldProvider)
  assert.ok(newMcpOAuthProvider(old, opts('auto')) instanceof OldProvider)
  assert.throws(() => newMcpOAuthProvider({} as McpModule, opts()), /has no MCP OAuth support/)
})

test('mcpOAuthRegistrationOf: the stored kind from the core, and nothing from what cannot say', async () => {
  const core = await import('@dudko.dev/agent-web/mcp')
  const provider = new core.BrowserOAuthProvider({
    ...mcpOAuthProviderOptions(
      MCP_URL,
      { redirectUrl: 'https://app.example.test/' },
      {
        clientMetadataUrl: CIMD_URL,
      },
    ),
    storage: new core.MemoryOAuthStorage(),
  })
  assert.equal(await mcpOAuthRegistrationOf(provider), undefined, 'nothing stored yet')
  await provider.saveClientInformation({ client_id: CIMD_URL })
  assert.equal(await mcpOAuthRegistrationOf(provider), 'cimd')
  await provider.saveClientInformation({ client_id: 'dcr-1' })
  assert.equal(await mcpOAuthRegistrationOf(provider), 'dcr')

  assert.equal(await mcpOAuthRegistrationOf(undefined), undefined)
  const older = { serverUrl: MCP_URL, isAuthorized: async () => true, reset: async () => {} }
  assert.equal(await mcpOAuthRegistrationOf(older), undefined, 'a core without the method')
  assert.equal(
    await mcpOAuthRegistrationOf({ ...older, registrationKind: async () => 'static' as never }),
    undefined,
  )
  assert.equal(
    await mcpOAuthRegistrationOf({
      ...older,
      registrationKind: async () => {
        throw new Error('storage gone')
      },
    }),
    undefined,
    'never throws: it is what the UI shows',
  )
})

test("the hooks' sequence over real sockets: record, redirect, the way back, connected - and the entry's kind", async () => {
  const core = (await import('@dudko.dev/agent-web/mcp')) as unknown as McpModule & {
    MemoryOAuthStorage: new () => unknown
    connectMcpHttp: McpModule['connectMcpHttp']
  }
  for (const [cimd, registration, expected] of [
    [true, 'cimd', 'cimd'],
    [true, 'dcr', 'dcr'],
    [false, undefined, 'dcr'],
  ] as const) {
    const mcp = await startLocalMcp({ requireAuth: true, clientIdMetadataDocument: cimd })
    try {
      const storage = new core.MemoryOAuthStorage()
      const options = (oauth: Parameters<typeof mcpOAuthProviderOptions>[1]) => ({
        ...mcpOAuthProviderOptions(mcp.url, oauth, { clientMetadataUrl: CIMD_URL }),
        storage,
      })
      // Connect: the server challenges, the provider is registered, the user is to be sent away.
      const first = newMcpOAuthProvider(
        core,
        options({ redirectUrl: 'http://127.0.0.1:9/cb', registration }),
      )
      const record = JSON.stringify(
        mcpOAuthRecordOf(options({ redirectUrl: 'http://127.0.0.1:9/cb', registration })),
      )
      const challenged = await core.connectMcpHttp({ s: { url: mcp.url, authProvider: first } })
      assert.equal(challenged.results[0]?.needsAuthorization, true)
      await challenged.close()
      const state = first.authorizationUrl?.searchParams.get('state') ?? undefined
      // ...and back: a new page, a provider built from the record alone.
      const back = newMcpOAuthProvider(core, options(mcpOAuthOptionsOfRecord(JSON.parse(record))))
      await core.finishMcpOAuth!(back, { code: 'auth-code-1', state })
      const connection = await core.connectMcpHttp({ s: { url: mcp.url, authProvider: back } })
      assert.equal(connection.results[0]?.connected, true)
      await connection.close()
      assert.equal(await mcpOAuthRegistrationOf(back), expected, `${registration ?? 'auto'}`)
      assert.equal(mcp.registrations(), expected === 'dcr' ? 1 : 0)
    } finally {
      await mcp.close()
    }
  }
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

test("skills: the core takes McpHttpServerConfig.skills - the mounted tools carry the server's skills, off without it", async () => {
  // `skills: true` (mcp-types) reaches the core's connector, whose tools then carry the server's
  // skills to the agent (`<server>/<skill>`); without it nothing of the extension is there.
  const { startLocalMcpServer } = await import('@dudko.dev/test-servers')
  const mod = (await import('@dudko.dev/agent-web/mcp')) as unknown as {
    connectMcpHttp: (servers: Record<string, unknown>) => Promise<{
      tools: Record<string, object>
      close: () => Promise<void>
    }>
  }
  const MARK = Symbol.for('@dudko.dev/agent:mcp-skills')
  const server = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    const on = await mod.connectMcpHttp({
      docs: { url: server.url, protocol: 'modern', skills: true },
    })
    const off = await mod.connectMcpHttp({ docs: { url: server.url, protocol: 'modern' } })
    const source = (on.tools.docs__echo as Record<symbol, { skills: { uri: string }[] }>)[MARK]
    assert.deepEqual(
      source.skills.map((k) => k.uri),
      [
        'skill://git-workflow/SKILL.md',
        'skill://pdf-processing/SKILL.md',
        'skill://acme/billing/refunds/SKILL.md',
        'skill://acme/support/refunds/SKILL.md',
      ],
    )
    assert.equal((off.tools.docs__echo as Record<symbol, unknown>)[MARK], undefined)
    assert.deepEqual(server.skillReads, [], 'nothing of a skill is read at connect')
    await on.close()
    await off.close()
  } finally {
    await server.close()
  }
})

test("skills: { dynamic: true } as the hooks pass it reaches the core - the server's generated skills join the catalog", async () => {
  const { startLocalMcpServer } = await import('@dudko.dev/test-servers')
  const mod = (await import('@dudko.dev/agent-web/mcp')) as unknown as {
    connectMcpHttp: (servers: Record<string, unknown>) => Promise<{
      tools: Record<string, object>
      close: () => Promise<void>
    }>
  }
  const MARK = Symbol.for('@dudko.dev/agent:mcp-skills')
  const server = await startLocalMcpServer({ protocol: 'modern', skills: true })
  server.skillFaults.dynamic = true
  const generatedOf = async (skills: unknown) => {
    const mcp = await mod.connectMcpHttp({
      docs: { url: server.url, protocol: 'modern', skills },
    })
    try {
      const source = (mcp.tools.docs__echo as Record<symbol, { skills: { uri: string }[] }>)[MARK]
      return source.skills.filter((k) => k.uri === 'skill://generated/SKILL.md')
    } finally {
      await mcp.close()
    }
  }
  try {
    // What `add` / `connect` and the remembered list hand the core (`mcpSkillsSettingOf`).
    const on = mcpSkillsSettingOf({ dynamic: true })
    assert.deepEqual(on, { dynamic: true })
    assert.equal((await generatedOf(on)).length, 1)
    assert.equal((await generatedOf(mcpSkillsSettingOf({ dynamic: false }))).length, 0)
    assert.equal((await generatedOf(true)).length, 0, 'declined without it')
    assert.deepEqual(server.skillReads, [], 'nothing of it read at connect')
  } finally {
    await server.close()
  }
})
