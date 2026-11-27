import assert from 'node:assert/strict'
import test from 'node:test'
import { startLocalMcp, type ILocalMcp } from '@dudko.dev/test-servers'
import {
  beginMcpOAuth,
  finishMcpOAuth,
  MemoryOAuthStore,
  NodeOAuthProvider,
  type IOAuthStore,
} from '../src/mcp-oauth.ts'
import { connectMcpServers } from '../src/mcp.ts'

// `registration` on the OAuth provider: how the client is registered with the
// authorization server - 'auto' (the document where the server supports it,
// else dynamic registration), 'cimd' (the document only) or 'dcr' (dynamic
// registration only) - and `registrationKind()`, which way a stored client was
// made. Over real sockets, against the authorization server of
// `@dudko.dev/test-servers`, which counts every request to its registration
// endpoint and can stop (or start) advertising CIMD between two attempts.
//
// The same suite lives in the browser package (packages/agent-web/tests/mcp-oauth-registration.test.ts):
// the two providers share names and semantics, so they share the tests.

const CIMD_URL = 'https://app.example.test/oauth/client.json'
const OTHER_CIMD_URL = 'https://app.example.test/oauth/other-client.json'
const REDIRECT_URL = 'http://127.0.0.1:9999/callback'

/** A storage whose keys a test can list: "nothing stored" is checked, not assumed. */
class ListedStorage implements IOAuthStore {
  readonly map = new Map<string, string>()
  async get(key: string) {
    return this.map.get(key)
  }
  async set(key: string, value: string) {
    this.map.set(key, value)
  }
  async delete(key: string) {
    this.map.delete(key)
  }
  /** What is stored, by suffix (`client`, `tokens`, `discovery`, ...). */
  suffixes(): string[] {
    return [...this.map.keys()].map((k) => k.slice(k.lastIndexOf(':') + 1)).sort()
  }
}

const provider = (
  mcp: ILocalMcp,
  extra: Record<string, unknown> = {},
  storage: IOAuthStore = new MemoryOAuthStore(),
) =>
  new NodeOAuthProvider({
    serverUrl: mcp.url,
    redirectUrl: REDIRECT_URL,
    store: storage,
    ...extra,
  })

// The connector the agent uses, as the hooks of the browser package use theirs.
const connectMcpHttp = (
  servers: Record<string, { url: string; authProvider: NodeOAuthProvider }>,
) => connectMcpServers(servers, () => {}, 'agent-test')

/** The whole interactive flow: begin, "the user comes back", exchange the code. */
const signIn = async (p: NodeOAuthProvider): Promise<void> => {
  assert.equal(await beginMcpOAuth(p), 'REDIRECT')
  await finishMcpOAuth(p, {
    code: 'auth-code-1',
    state: p.authorizationUrl?.searchParams.get('state') ?? undefined,
  })
  assert.equal(await p.isAuthorized(), true)
}

const withMcp = async (
  opts: { cimd: boolean },
  body: (mcp: ILocalMcp) => Promise<void>,
): Promise<void> => {
  const mcp = await startLocalMcp({ requireAuth: true, clientIdMetadataDocument: opts.cimd })
  try {
    await body(mcp)
  } finally {
    await mcp.close()
  }
}

const CIMD_REFUSED =
  /does not support client ID metadata documents \(CIMD\), which this connection requires \(registration: 'cimd'\) - nothing was sent to its registration endpoint/

// ── construction ──────────────────────────────────────────────────────────

test("registration: 'auto' is the default, and an unknown value or 'cimd' without a document fail at construction", async () => {
  await withMcp({ cimd: false }, async (mcp) => {
    assert.equal(provider(mcp).registration, 'auto')
    assert.equal(provider(mcp, { registration: 'auto' }).registration, 'auto')
    assert.equal(provider(mcp, { registration: 'dcr' }).registration, 'dcr')
    assert.throws(
      () => provider(mcp, { registration: 'cimd' }),
      /registration 'cimd' needs a clientMetadataUrl/,
    )
    assert.throws(
      () => provider(mcp, { registration: 'CIMD', clientMetadataUrl: CIMD_URL }),
      /registration must be 'auto', 'cimd' or 'dcr'/,
    )
    assert.throws(() => provider(mcp, { registration: '' }), /registration must be/)
    assert.equal(
      provider(mcp, { registration: 'cimd', clientMetadataUrl: CIMD_URL }).registration,
      'cimd',
    )
    // Nothing reached either server: a configuration error is said before any request.
    assert.equal(mcp.registrations(), 0)
    assert.deepEqual(mcp.grants(), [])
  })
})

// ── auto ──────────────────────────────────────────────────────────────────

test("registration 'auto': a server that supports CIMD gets the document, and no registration request", async () => {
  await withMcp({ cimd: true }, async (mcp) => {
    const p = provider(mcp, { clientMetadataUrl: CIMD_URL })
    assert.equal(await p.registrationKind(), undefined, 'nothing stored yet')
    await signIn(p)
    assert.equal(mcp.registrations(), 0)
    assert.deepEqual(mcp.tokenClientIds(), [CIMD_URL])
    assert.equal(await p.registrationKind(), 'cimd')
  })
})

test("registration 'auto': a server without CIMD support is registered with dynamically", async () => {
  await withMcp({ cimd: false }, async (mcp) => {
    const p = provider(mcp, { clientMetadataUrl: CIMD_URL })
    await signIn(p)
    assert.equal(mcp.registrations(), 1)
    assert.deepEqual(mcp.tokenClientIds(), ['dcr-1'])
    assert.equal(await p.registrationKind(), 'dcr')
  })
})

test("registration 'auto': whatever is stored is used as it is (today's behaviour)", async () => {
  await withMcp({ cimd: true }, async (mcp) => {
    const storage = new ListedStorage()
    // Registered dynamically by a 'dcr' provider, then read by an 'auto' one
    // that has a document and a server that would accept it.
    await signIn(provider(mcp, { registration: 'dcr', clientMetadataUrl: CIMD_URL }, storage))
    const auto = provider(mcp, { clientMetadataUrl: CIMD_URL }, storage)
    assert.equal(await auto.registrationKind(), 'dcr')
    assert.equal((await auto.tokens())?.access_token, 'access-1', 'its tokens are kept')
    const connection = await connectMcpHttp({ s: { url: mcp.url, authProvider: auto } })
    try {
      assert.equal(connection.results[0]?.connected, true)
    } finally {
      await connection.close()
    }
    assert.equal(mcp.registrations(), 1, 'no second registration')
  })
})

// ── cimd ──────────────────────────────────────────────────────────────────

test("registration 'cimd': a server that supports CIMD gets the document", async () => {
  await withMcp({ cimd: true }, async (mcp) => {
    const p = provider(mcp, { registration: 'cimd', clientMetadataUrl: CIMD_URL })
    assert.equal(p.clientMetadataUrl, CIMD_URL)
    await signIn(p)
    assert.equal(mcp.registrations(), 0)
    assert.deepEqual(mcp.tokenClientIds(), [CIMD_URL])
    assert.equal(await p.registrationKind(), 'cimd')
  })
})

test("registration 'cimd': a server without CIMD support is refused before any registration request, and nothing is stored", async () => {
  await withMcp({ cimd: false }, async (mcp) => {
    const storage = new ListedStorage()
    const p = provider(mcp, { registration: 'cimd', clientMetadataUrl: CIMD_URL }, storage)

    // The path the agent takes: the connect's 401 starts the flow inside the transport.
    const connection = await connectMcpHttp({ s: { url: mcp.url, authProvider: p } })
    const result = connection.results[0]
    await connection.close()
    assert.equal(result?.connected, false)
    assert.notEqual(
      result?.needsAuthorization,
      true,
      'not an authorization to ask for: it cannot work',
    )
    assert.match(result?.error ?? '', CIMD_REFUSED)
    assert.ok(result?.error?.includes(mcp.issuer), 'the message names the authorization server')
    assert.ok(result?.error?.includes(mcp.url), 'and the MCP server')

    // And the direct one.
    await assert.rejects(beginMcpOAuth(p), CIMD_REFUSED)

    assert.equal(mcp.registrations(), 0, 'no request reached the registration endpoint')
    assert.deepEqual(mcp.grants(), [], 'nor the token endpoint')
    assert.equal(p.authorizationUrl, undefined, 'and nobody is sent to authorize')
    assert.deepEqual(storage.suffixes(), [], 'no client, no token, no discovery record')
    assert.equal(await p.registrationKind(), undefined)
  })
})

test("registration 'cimd': after a refusal the server's metadata is read again, so support added since is used", async () => {
  await withMcp({ cimd: false }, async (mcp) => {
    const p = provider(mcp, { registration: 'cimd', clientMetadataUrl: CIMD_URL })
    await assert.rejects(beginMcpOAuth(p), CIMD_REFUSED)
    mcp.advertised.clientIdMetadataDocument = true
    await signIn(p)
    assert.equal(mcp.registrations(), 0)
    assert.deepEqual(mcp.tokenClientIds(), [CIMD_URL])
  })
})

// ── dcr ───────────────────────────────────────────────────────────────────

test("registration 'dcr': registers dynamically even with a document and a server that supports it", async () => {
  await withMcp({ cimd: true }, async (mcp) => {
    const p = provider(mcp, { registration: 'dcr', clientMetadataUrl: CIMD_URL })
    assert.equal(p.clientMetadataUrl, undefined, 'the SDK is never shown the document')
    await signIn(p)
    assert.equal(mcp.registrations(), 1)
    assert.deepEqual(mcp.tokenClientIds(), ['dcr-1'])
    assert.notEqual((await p.clientInformation())?.client_id, CIMD_URL)
    assert.equal(await p.registrationKind(), 'dcr')
  })
})

// ── a changed setting never reuses the other kind's client ────────────────

test("switching to 'cimd': the dynamic registration and its tokens are forgotten, the next sign-in uses the document", async () => {
  await withMcp({ cimd: true }, async (mcp) => {
    const storage = new ListedStorage()
    await signIn(provider(mcp, { registration: 'dcr', clientMetadataUrl: CIMD_URL }, storage))
    assert.equal(mcp.registrations(), 1)

    const cimd = provider(mcp, { registration: 'cimd', clientMetadataUrl: CIMD_URL }, storage)
    // The first thing read is the token, as the transport reads it on every request.
    assert.equal(await cimd.tokens(), undefined, "the old client's token is not presented")
    assert.equal(await cimd.registrationKind(), undefined, 'not a client it would use')
    assert.equal(await cimd.isAuthorized(), false)
    assert.ok(!storage.suffixes().includes('client'))
    assert.ok(!storage.suffixes().includes('tokens'))

    await signIn(cimd)
    assert.equal(mcp.registrations(), 1, 'no second registration')
    assert.deepEqual(mcp.tokenClientIds(), ['dcr-1', CIMD_URL])
    assert.equal(await cimd.registrationKind(), 'cimd')
  })
})

test("switching to 'dcr': the document client and its tokens are forgotten, the next sign-in registers", async () => {
  await withMcp({ cimd: true }, async (mcp) => {
    const storage = new ListedStorage()
    await signIn(provider(mcp, { clientMetadataUrl: CIMD_URL }, storage))
    assert.equal(mcp.registrations(), 0)

    const dcr = provider(mcp, { registration: 'dcr', clientMetadataUrl: CIMD_URL }, storage)
    // The first thing read is the expiry, as the connector reads it before connecting.
    assert.equal(await dcr.isAccessTokenExpired(), true, 'no token of the old client')
    assert.equal(await dcr.registrationKind(), undefined)
    assert.equal(await dcr.tokens(), undefined)
    // The connect path: the refresh before the first request reads the token too.
    const connection = await connectMcpHttp({ s: { url: mcp.url, authProvider: dcr } })
    const result = connection.results[0]
    await connection.close()
    assert.equal(result?.needsAuthorization, true, 'a new sign-in, not the old client')
    assert.equal(mcp.registrations(), 1)
    assert.equal(dcr.authorizationUrl?.searchParams.get('client_id'), 'dcr-1')
    assert.equal(await dcr.registrationKind(), 'dcr')
  })
})

test('the kind is stamped when the client is saved: a changed document URL does not turn an old CIMD client into a DCR one', async () => {
  await withMcp({ cimd: true }, async (mcp) => {
    const storage = new ListedStorage()
    await signIn(provider(mcp, { clientMetadataUrl: CIMD_URL }, storage))

    // Configured with another document now: the stored client is still CIMD...
    assert.equal(
      await provider(mcp, { clientMetadataUrl: OTHER_CIMD_URL }, storage).registrationKind(),
      'cimd',
    )
    // ...so 'dcr' does not take it for a dynamic registration,
    const dcr = provider(mcp, { registration: 'dcr', clientMetadataUrl: OTHER_CIMD_URL }, storage)
    assert.equal(await dcr.registrationKind(), undefined)
    assert.equal(await dcr.clientInformation(), undefined)

    // ...and 'cimd' uses only the document configured now.
    await signIn(provider(mcp, { clientMetadataUrl: CIMD_URL }, storage))
    const other = provider(
      mcp,
      { registration: 'cimd', clientMetadataUrl: OTHER_CIMD_URL },
      storage,
    )
    assert.equal(await other.registrationKind(), undefined)
    await signIn(other)
    assert.deepEqual(mcp.tokenClientIds(), [CIMD_URL, CIMD_URL, OTHER_CIMD_URL])
    assert.equal(mcp.registrations(), 0)
  })
})

// ── the stamp itself ──────────────────────────────────────────────────────

test('the stamp: what a registration response claims is replaced, and the SDK never sees the stamp', async () => {
  await withMcp({ cimd: false }, async (mcp) => {
    const storage = new ListedStorage()
    const p = provider(mcp, { clientMetadataUrl: CIMD_URL }, storage)
    // A server's registration response is the server's text: it cannot make a
    // dynamic registration read as the document.
    await p.saveClientInformation({
      client_id: 'dcr-from-a-server',
      'x-agent-registration': 'cimd',
    } as never)
    assert.equal(await p.registrationKind(), 'dcr')
    const info = (await p.clientInformation()) as Record<string, unknown>
    assert.deepEqual(Object.keys(info), ['client_id'], 'the stamp is taken off before the SDK')

    await p.saveClientInformation({ client_id: CIMD_URL })
    assert.equal(await p.registrationKind(), 'cimd')
    assert.deepEqual(Object.keys((await p.clientInformation()) as object), ['client_id'])
  })
})

test('the stamp: a record saved before it existed is CIMD when its client_id is the document configured now', async () => {
  await withMcp({ cimd: false }, async (mcp) => {
    const storage = new ListedStorage()
    const p = provider(mcp, { clientMetadataUrl: CIMD_URL }, storage)
    await p.saveClientInformation({ client_id: 'x' })
    const clientKey = [...storage.map.keys()].find((k) => k.endsWith(':client'))!
    storage.map.set(clientKey, JSON.stringify({ client_id: CIMD_URL }))
    assert.equal(await p.registrationKind(), 'cimd')
    storage.map.set(clientKey, JSON.stringify({ client_id: 'dcr-old' }))
    assert.equal(await p.registrationKind(), 'dcr')
    storage.map.set(clientKey, JSON.stringify({ client_id: 'x', 'x-agent-registration': 'bogus' }))
    assert.equal(await p.registrationKind(), 'dcr', 'a stamp that is not one of the two is ignored')
  })
})

test('a client written by a provider with another setting after this one settled is not used', async () => {
  await withMcp({ cimd: true }, async (mcp) => {
    const storage = new ListedStorage()
    const cimd = provider(mcp, { registration: 'cimd', clientMetadataUrl: CIMD_URL }, storage)
    assert.equal(await cimd.tokens(), undefined) // settled, on an empty store
    await signIn(provider(mcp, { registration: 'dcr', clientMetadataUrl: CIMD_URL }, storage))
    assert.equal(await cimd.registrationKind(), undefined)
    // The SDK's read: nothing to use, and the other client is gone.
    await signIn(cimd)
    assert.equal(mcp.registrations(), 1)
    assert.deepEqual(mcp.tokenClientIds(), ['dcr-1', CIMD_URL])
  })
})
