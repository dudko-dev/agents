import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  assertLoopbackHost,
  closeServer,
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_HEADERS_2025,
  corsHeaders,
  listen,
  startLocalAuthorizationServer,
  startLocalIdp,
  startLocalMcp,
  startLocalMcpServer,
} from '../src/index.ts'

// ── CORS ──────────────────────────────────────────────────────────────────

const ORIGIN = 'http://localhost:5173'

const lower = (list: string | null): string[] =>
  (list ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()

/** What a browser MCP client needs to be told (the browser package's README, "CORS"). */
const assertCors = (headers: Headers, origin: string, label: string): void => {
  assert.equal(headers.get('access-control-allow-origin'), origin, `${label}: allowed origin`)
  for (const name of ['www-authenticate', 'mcp-session-id']) {
    assert.ok(
      lower(headers.get('access-control-expose-headers')).includes(name),
      `${label}: ${name} must be exposed`,
    )
  }
}

const preflight = (url: string, method = 'POST') =>
  fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization, content-type, mcp-protocol-version',
    },
  })

const assertPreflight = async (url: string, label: string): Promise<void> => {
  const res = await preflight(url)
  assert.equal(res.status, 204, `${label}: preflight status`)
  assert.equal(await res.text(), '')
  assertCors(res.headers, ORIGIN, label)
  assert.deepEqual(
    lower(res.headers.get('access-control-allow-methods')),
    ['delete', 'get', 'options', 'post'],
    label,
  )
  assert.deepEqual(
    lower(res.headers.get('access-control-allow-headers')),
    [
      'authorization',
      'content-type',
      'last-event-id',
      'mcp-method',
      'mcp-name',
      'mcp-protocol-version',
      'mcp-session-id',
    ],
    `${label}: the request headers an MCP client sends`,
  )
  assert.equal(res.headers.get('access-control-max-age'), '86400')
  assert.equal(
    res.headers.get('vary'),
    'Origin',
    `${label}: one origin, so the answer varies by it`,
  )
}

test('cors: the exact header names the browser e2e server sends', () => {
  assert.deepEqual(corsHeaders('*'), {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version, Last-Event-ID, Mcp-Method, Mcp-Name',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, mcp-session-id',
    'Access-Control-Max-Age': '86400',
  })
  // The list a deployment made before 2026-07-28 has: the two new headers are what it lacks.
  assert.equal(
    CORS_ALLOW_HEADERS_2025,
    'Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version, Last-Event-ID',
  )
  assert.equal(CORS_ALLOW_HEADERS, `${CORS_ALLOW_HEADERS_2025}, Mcp-Method, Mcp-Name`)
  assert.equal(
    corsHeaders('*', CORS_ALLOW_HEADERS_2025)['Access-Control-Allow-Headers'],
    CORS_ALLOW_HEADERS_2025,
  )
  assert.equal(corsHeaders(ORIGIN).Vary, 'Origin')
})

test('cors: the IdP answers the preflight and puts the headers on every answer', async () => {
  const idp = await startLocalIdp({
    clientId: 'c',
    clientSecret: 's',
    resourceClientId: 'r',
    cors: ORIGIN,
    idTokenEndpoint: true,
  })
  try {
    await assertPreflight(idp.tokenEndpoint, 'idp token endpoint')
    assertCors((await fetch(idp.jwksUri)).headers, ORIGIN, 'jwks')
    assertCors((await fetch(idp.idTokenEndpoint as string)).headers, ORIGIN, 'id token')
    // An error answer too: a page must be able to read why it was refused.
    const refused = await fetch(idp.tokenEndpoint, { method: 'POST', body: 'grant_type=x' })
    assert.equal(refused.status, 401)
    assertCors(refused.headers, ORIGIN, 'refused exchange')
    assert.equal(idp.exchanges.length, 1, 'a preflight is not an exchange')
  } finally {
    await idp.close()
  }
})

test('cors: the authorization server answers the preflight and puts the headers on every answer', async () => {
  const as = await startLocalAuthorizationServer({ cors: ORIGIN })
  try {
    await assertPreflight(as.tokenEndpoint, 'as token endpoint')
    await assertPreflight(`${as.issuer}/register`, 'as registration')
    assertCors(
      (await fetch(`${as.issuer}/.well-known/oauth-authorization-server`)).headers,
      ORIGIN,
      'as metadata',
    )
    const token = await fetch(as.tokenEndpoint, {
      method: 'POST',
      body: 'grant_type=refresh_token',
    })
    assertCors(token.headers, ORIGIN, 'token answer')
    assert.equal(as.tokenRequests().length, 1, 'a preflight is not a token request')
  } finally {
    await as.close()
  }
})

test('cors: the MCP server answers the preflight, exposes the 401 challenge, and keeps the headers on MCP answers', async () => {
  const mcp = await startLocalMcpServer({ cors: ORIGIN, requireAuth: true })
  try {
    // The preflight carries no token and must not be asked for one.
    await assertPreflight(mcp.url, 'mcp endpoint')
    assertCors(
      (await fetch(`${mcp.origin}/.well-known/oauth-protected-resource/mcp`)).headers,
      ORIGIN,
      'resource metadata',
    )
    const challenge = await fetch(mcp.url, { method: 'POST', body: '{}' })
    assert.equal(challenge.status, 401)
    assert.match(String(challenge.headers.get('www-authenticate')), /resource_metadata=/)
    assertCors(challenge.headers, ORIGIN, 'the 401 challenge')

    // What the SDK's transport writes still carries them.
    mcp.validTokens.add('t')
    const seen: Headers[] = []
    const client = new Client({ name: 'cors-test', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { authorization: 'Bearer t' } },
        fetch: async (url, init) => {
          const res = await fetch(url, init)
          seen.push(res.headers)
          return res
        },
      }),
    )
    await client.callTool({ name: 'echo', arguments: { text: 'x' } })
    await client.close()
    assert.ok(seen.length >= 2)
    for (const headers of seen) {
      assertCors(headers, ORIGIN, 'an MCP answer')
    }
  } finally {
    await mcp.close()
  }
})

test("cors: '*' allows any origin and does not vary; the pair passes the option to both servers", async () => {
  const pair = await startLocalMcp({ cors: '*' })
  try {
    for (const url of [pair.url, pair.tokenEndpoint]) {
      const res = await preflight(url)
      assert.equal(res.status, 204)
      assertCors(res.headers, '*', url)
      assert.equal(res.headers.get('vary'), null)
    }
  } finally {
    await pair.close()
  }
})

test('cors: without the option no CORS header is sent and OPTIONS is not special', async () => {
  const idp = await startLocalIdp({ clientId: 'c', clientSecret: 's', resourceClientId: 'r' })
  const pair = await startLocalMcp()
  try {
    for (const url of [idp.tokenEndpoint, idp.jwksUri, pair.tokenEndpoint, pair.url]) {
      const res = await preflight(url)
      assert.notEqual(res.status, 204, url)
      for (const name of [
        'access-control-allow-origin',
        'access-control-allow-headers',
        'access-control-expose-headers',
      ]) {
        assert.equal(res.headers.get(name), null, `${url}: ${name}`)
      }
    }
    assert.equal((await fetch(idp.jwksUri)).headers.get('access-control-allow-origin'), null)
  } finally {
    await pair.close()
    await idp.close()
  }
})

test('cors: a preflight for what a 2026-07-28 browser client sends is allowed, Mcp-Param-* included', async () => {
  const mcp = await startLocalMcpServer({ cors: ORIGIN, protocol: 'modern' })
  try {
    const ask = (headers: string) =>
      fetch(mcp.url, {
        method: 'OPTIONS',
        headers: {
          origin: ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': headers,
        },
      })
    const modern = await ask(
      'authorization, content-type, mcp-method, mcp-name, mcp-protocol-version',
    )
    assert.equal(modern.status, 204)
    const allowed = lower(modern.headers.get('access-control-allow-headers'))
    for (const name of ['mcp-method', 'mcp-name', 'mcp-protocol-version', 'authorization']) {
      assert.ok(allowed.includes(name), `${name} must be allowed`)
    }
    // Mcp-Param-* names come from tool definitions: the ones asked about are
    // allowed, and nothing else rides in with them.
    const mirrored = await ask('content-type, mcp-method, Mcp-Param-Region, x-other, mcp-param-')
    assert.deepEqual(
      lower(mirrored.headers.get('access-control-allow-headers')).filter(
        (name) => name.startsWith('mcp-param') || name.startsWith('x-'),
      ),
      ['mcp-param-region'],
    )
    // No CORS, no header: the answer to a real request never lists them.
    const answer = await fetch(mcp.url, { method: 'POST', body: '{}' })
    assert.equal(
      answer.headers.get('access-control-allow-headers'),
      CORS_ALLOW_HEADERS,
      'only a preflight is asked about Mcp-Param-*',
    )
  } finally {
    await mcp.close()
  }
})

// ── loopback only ─────────────────────────────────────────────────────────

const NOT_LOOPBACK = ['0.0.0.0', '::', 'localhost', '192.168.1.10', '10.0.0.1', 'example.test', '']

test('loopback: only 127.0.0.1 and ::1 pass the guard', () => {
  assertLoopbackHost('127.0.0.1')
  assertLoopbackHost('::1')
  for (const host of NOT_LOOPBACK) {
    assert.throws(() => assertLoopbackHost(host), /loopback only/, host)
  }
})

/** The start must be refused. If it is not, the server is closed before the test fails. */
const refusesToStart = async (
  label: string,
  start: () => Promise<{ close: () => Promise<void> }>,
): Promise<void> => {
  let started: { close: () => Promise<void> } | undefined
  try {
    started = await start()
  } catch (err) {
    assert.match(String((err as Error).message), /loopback only/, label)
    return
  }
  await started.close()
  assert.fail(`${label}: started where it had to refuse`)
}

test('loopback: no server binds anything else, and nothing is left listening', async () => {
  for (const host of NOT_LOOPBACK) {
    await refusesToStart(`idp on "${host}"`, () =>
      startLocalIdp({ clientId: 'c', resourceClientId: 'r', host }),
    )
    await refusesToStart(`as on "${host}"`, () => startLocalAuthorizationServer({ host }))
    await refusesToStart(`mcp on "${host}"`, () => startLocalMcpServer({ host }))
    await refusesToStart(`pair on "${host}"`, () => startLocalMcp({ host }))
  }
  // The guard is in `listen` itself: a server refused there was never bound.
  const server = createServer()
  await refusesToStart('listen on 0.0.0.0', async () => {
    await listen(server, { host: '0.0.0.0' })
    return { close: () => closeServer(server) }
  })
  assert.equal(server.listening, false)
})

test('loopback: a fixed port is used as given, and a taken one is an error', async () => {
  const first = await startLocalMcpServer()
  const port = Number(new URL(first.url).port)
  await first.close()
  const fixed = await startLocalMcpServer({ port })
  try {
    assert.equal(fixed.url, `http://127.0.0.1:${port}/mcp`)
    await assert.rejects(() => startLocalMcpServer({ port }), /EADDRINUSE/)
  } finally {
    await fixed.close()
  }
})

test('loopback: ::1 is served under a bracketed URL', async (t) => {
  const probe = createServer()
  try {
    await listen(probe, { host: '::1' })
  } catch {
    t.skip('this machine has no IPv6 loopback')
    return
  }
  await closeServer(probe)
  const mcp = await startLocalMcpServer({ host: '::1' })
  try {
    assert.match(mcp.url, /^http:\/\/\[::1\]:\d+\/mcp$/)
    assert.equal((await fetch(`${mcp.origin}/.well-known/oauth-protected-resource`)).status, 200)
  } finally {
    await mcp.close()
  }
})
