import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REPORT_IMAGE_BASE64,
  REPORT_VALUE,
  startLocalIdp,
  startLocalMcp,
  startLocalMcpServer,
} from '../src/index.ts'
import { basic, exchangeParams, getJson, grantParams, postForm } from './helpers.ts'

/** The SDK's own client, so the server is spoken to by a real peer. */
const connect = async (url: string, token?: string) => {
  const client = new Client({ name: 'test-servers-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  })
  await client.connect(transport)
  return client
}

const textOf = (result: unknown): string =>
  ((result as { content: { text: string }[] }).content[0] ?? { text: '' }).text

test('mcp server: the three tools, as the SDK client sees them', async () => {
  const mcp = await startLocalMcpServer()
  try {
    assert.match(mcp.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.equal(mcp.url, `${mcp.origin}/mcp`)
    const client = await connect(mcp.url)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ['boom', 'echo', 'secret'])
    assert.equal(
      textOf(await client.callTool({ name: 'echo', arguments: { text: 'hi' } })),
      'echo:hi',
    )
    assert.equal(textOf(await client.callTool({ name: 'secret', arguments: {} })), mcp.secret)
    const boom = await client.callTool({ name: 'boom', arguments: {} })
    assert.equal(boom.isError, true)
    assert.equal(textOf(boom), 'kaboom')
    await client.close()
    assert.deepEqual(mcp.calls, [
      { name: 'echo', args: { text: 'hi' } },
      { name: 'secret', args: {} },
      { name: 'boom', args: {} },
    ])
    assert.equal(mcp.initializeCapabilities.length, 1)
    assert.equal(typeof mcp.initializeCapabilities[0], 'object')
    // The secret differs from run to run: it cannot be known without the tool.
    const other = await startLocalMcpServer()
    assert.notEqual(other.secret, mcp.secret)
    await other.close()
  } finally {
    await mcp.close()
  }
})

test('mcp server: protected resource metadata names the resource and its authorization servers', async () => {
  const mcp = await startLocalMcpServer({ authorizationServers: ['https://as.example.test'] })
  try {
    const meta = await getJson(`${mcp.origin}/.well-known/oauth-protected-resource/mcp`)
    assert.deepEqual(meta.body, {
      resource: mcp.url,
      authorization_servers: ['https://as.example.test'],
      scopes_supported: ['mcp:tools'],
    })
  } finally {
    await mcp.close()
  }
  const bare = await startLocalMcpServer()
  try {
    const meta = await getJson(`${bare.origin}/.well-known/oauth-protected-resource`)
    assert.deepEqual(meta.body.authorization_servers, [])
  } finally {
    await bare.close()
  }
})

test('mcp server requireAuth: a 401 with the challenge until the token is one it accepts', async () => {
  const mcp = await startLocalMcpServer({ requireAuth: true })
  try {
    const post = (token?: string) =>
      fetch(mcp.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    const refused = await post()
    assert.equal(refused.status, 401)
    assert.equal(
      refused.headers.get('www-authenticate'),
      `Bearer resource_metadata="${mcp.origin}/.well-known/oauth-protected-resource/mcp"`,
    )
    assert.equal((await post('made-up')).status, 401)
    // The metadata stays readable without a token: discovery starts there.
    assert.equal(
      (await getJson(`${mcp.origin}/.well-known/oauth-protected-resource/mcp`)).status,
      200,
    )
    mcp.validTokens.add('good-token')
    const client = await connect(mcp.url, 'good-token')
    assert.equal(
      textOf(await client.callTool({ name: 'echo', arguments: { text: 'in' } })),
      'echo:in',
    )
    await client.close()
    mcp.validTokens.clear()
    assert.equal((await post('good-token')).status, 401, 'a revoked token stops working')
  } finally {
    await mcp.close()
  }
})

test('the pair: an MCP server guarded by its own authorization server', async () => {
  const pair = await startLocalMcp({ requireAuth: true, expiresIn: 60 })
  try {
    assert.notEqual(
      new URL(pair.url).port,
      new URL(pair.issuer).port,
      'two ports, as in production',
    )
    assert.equal(pair.tokenEndpoint, `${pair.issuer}/token`)
    const meta = await getJson(`${pair.origin}/.well-known/oauth-protected-resource/mcp`)
    assert.deepEqual(meta.body.authorization_servers, [pair.issuer])
    const token = await postForm(pair.tokenEndpoint, {
      grant_type: 'authorization_code',
      code: 'c',
      code_verifier: 'v',
    })
    assert.equal(token.body.expires_in, 60)
    assert.ok(pair.validTokens.has(String(token.body.access_token)))
    const client = await connect(pair.url, String(token.body.access_token))
    assert.equal(
      textOf(await client.callTool({ name: 'echo', arguments: { text: 'ok' } })),
      'echo:ok',
    )
    await client.close()
    assert.deepEqual(pair.grants(), ['authorization_code'])
    assert.equal(pair.registrations(), 0)
  } finally {
    await pair.close()
  }
  // Closed means closed: both ports.
  await assert.rejects(() => fetch(pair.url))
  await assert.rejects(() => fetch(`${pair.issuer}/token`))
})

test('the pair, enterprise: the authorization server governs the MCP server it was started with', async () => {
  const idp = await startLocalIdp({
    clientId: 'at-idp',
    clientSecret: 'idp-s',
    resourceClientId: 'at-as',
  })
  const pair = await startLocalMcp({
    requireAuth: true,
    enterprise: {
      idpIssuer: idp.issuer,
      jwksUri: idp.jwksUri,
      clientId: 'at-as',
      clientSecret: 'as-s',
    },
  })
  try {
    const jag = async (resource: string) =>
      String(
        (
          await postForm(
            idp.tokenEndpoint,
            exchangeParams(idp.issueIdToken(), pair.issuer, { resource }),
            basic('at-idp', 'idp-s'),
          )
        ).body.access_token,
      )
    const elsewhere = await postForm(
      pair.tokenEndpoint,
      grantParams(await jag('http://127.0.0.1:9/mcp')),
      basic('at-as', 'as-s'),
    )
    assert.equal(elsewhere.body.error, 'invalid_target')
    const granted = await postForm(
      pair.tokenEndpoint,
      grantParams(await jag(pair.url)),
      basic('at-as', 'as-s'),
    )
    assert.equal(granted.status, 200)
    const client = await connect(pair.url, String(granted.body.access_token))
    assert.equal((await client.listTools()).tools.length, 3)
    await client.close()
    pair.faults.refuseGrant = { error: 'access_denied', description: 'no' }
    const refused = await postForm(
      pair.tokenEndpoint,
      grantParams(await jag(pair.url)),
      basic('at-as', 'as-s'),
    )
    assert.equal(refused.body.error, 'access_denied')
    assert.equal(pair.tokenRequests().length, 3)
    assert.deepEqual(pair.cimdFetches, [])
  } finally {
    await pair.close()
    await idp.close()
  }
})

test('mcp server: instructions arrive in the initialize result, and only when configured', async () => {
  const plain = await startLocalMcpServer()
  const guided = await startLocalMcpServer({ instructions: 'Call echo before secret.' })
  try {
    const a = await connect(plain.url)
    assert.equal(a.getInstructions(), undefined)
    await a.close()
    const b = await connect(guided.url)
    assert.equal(b.getInstructions(), 'Call echo before secret.')
    // A change reaches the next client to connect, not the one already connected.
    guided.setInstructions('Changed.')
    await b.listTools()
    assert.equal(b.getInstructions(), 'Call echo before secret.')
    const c = await connect(guided.url)
    assert.equal(c.getInstructions(), 'Changed.')
    await c.close()
    await b.close()
  } finally {
    await plain.close()
    await guided.close()
  }
})

test('mcp server: the structured tools are off by default and declare an output schema when on', async () => {
  const mcp = await startLocalMcpServer({ structuredTools: true })
  try {
    const client = await connect(mcp.url)
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((t) => t.name),
      ['echo', 'secret', 'boom', 'report', 'report_mixed'],
    )
    assert.equal(tools[3].outputSchema?.type, 'object')
    const report = await client.callTool({ name: 'report', arguments: {} })
    assert.deepEqual(report.structuredContent, REPORT_VALUE)
    // The backwards-compatible form: the same value, serialized, as text.
    assert.deepEqual(JSON.parse(textOf(report)), REPORT_VALUE)
    const mixed = await client.callTool({ name: 'report_mixed', arguments: {} })
    assert.deepEqual(mixed.structuredContent, REPORT_VALUE)
    assert.deepEqual(mixed.content, [
      { type: 'text', text: 'A mild, clear day.' },
      { type: 'image', data: REPORT_IMAGE_BASE64, mimeType: 'image/png' },
    ])
    await client.close()
  } finally {
    await mcp.close()
  }
})

test('mcp server: structuredFaults makes the answer break the schema the listing still declares', async () => {
  const mcp = await startLocalMcpServer({ structuredTools: true })
  try {
    const client = await connect(mcp.url)
    await client.listTools()
    mcp.structuredFaults.result = 'mismatch'
    // The SDK client validates against the listed schema: this is its refusal.
    await assert.rejects(
      () => client.callTool({ name: 'report', arguments: {} }),
      /does not match the tool's output schema/,
    )
    mcp.structuredFaults.result = 'missing'
    await assert.rejects(
      () => client.callTool({ name: 'report', arguments: {} }),
      /did not return structured content/,
    )
    // The listing is unchanged by the fault.
    assert.equal((await client.listTools()).tools[3].outputSchema?.type, 'object')
    delete mcp.structuredFaults.result
    assert.deepEqual(
      (await client.callTool({ name: 'report', arguments: {} })).structuredContent,
      REPORT_VALUE,
    )
    await client.close()
  } finally {
    await mcp.close()
  }
})
