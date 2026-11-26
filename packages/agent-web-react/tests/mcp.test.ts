import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claimOAuthCallback,
  describeMcpResult,
  isUnauthorizedError,
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

// The SDK's UnauthorizedError never assigns `this.name`, so it reads as
// "Error" — a name check silently never fires, which is how the mid-session
// re-authorization prompt shipped as dead code.

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
