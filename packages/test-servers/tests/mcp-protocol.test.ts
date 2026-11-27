import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CORS_ALLOW_HEADERS_2025,
  REPORT_VALUE,
  startLocalMcp,
  startLocalMcpServer,
  type ProbeFault,
} from '../src/index.ts'
import { postForm } from './helpers.ts'
import {
  initialize,
  legacy,
  modern,
  MODERN,
  modernRequest,
  modernStream,
  openStream,
  until,
  type IWireAnswer,
} from './mcp-wire.ts'

// The protocol switch, checked on the wire with hand-built JSON-RPC: what the
// MCP server answers in each mode, to each era of client.

const SERVER_INFO = {
  'io.modelcontextprotocol/serverInfo': { name: 'local-mcp', version: '1.0.0' },
}

/** A 400 whose body is the JSON-RPC error a modern server answers with. */
const assertRefused = (answer: IWireAnswer, code: number, label: string): void => {
  assert.equal(answer.status, 400, `${label}: status`)
  assert.match(String(answer.headers.get('content-type')), /application\/json/, label)
  assert.equal(answer.body.jsonrpc, '2.0', label)
  assert.equal(answer.body.error.code, code, `${label}: ${answer.text}`)
}

// ── legacy: the default, and unchanged ────────────────────────────────────

test('legacy (default): the wire of the 2025 handshake is what it always was', async () => {
  const mcp = await startLocalMcpServer({ instructions: 'Be kind.' })
  try {
    assert.equal(mcp.protocol, 'legacy')
    const init = await initialize(mcp.url)
    assert.equal(init.status, 200)
    assert.equal(init.headers.get('content-type'), 'text/event-stream')
    // Stateless: this server has never issued a session id.
    assert.equal(init.headers.get('mcp-session-id'), null)
    assert.deepEqual(init.events, [
      {
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'local-mcp', version: '1.0.0' },
          instructions: 'Be kind.',
        },
        jsonrpc: '2.0',
        id: 'init',
      },
    ])
    const initialized = await legacy(mcp.url, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    assert.equal(initialized.status, 202)
    assert.equal(initialized.text, '')

    const list = await legacy(mcp.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    assert.equal(list.status, 200)
    assert.equal(list.headers.get('mcp-session-id'), null)
    // No `resultType`, no cache fields, the draft-07 dialect and the 1.x SDK's
    // `execution` block: byte for byte what the 2025 clients have been reading.
    assert.equal(
      list.text,
      'event: message\ndata: ' +
        JSON.stringify({
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo the input back',
                inputSchema: {
                  $schema: 'http://json-schema.org/draft-07/schema#',
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
                execution: { taskSupport: 'forbidden' },
              },
              {
                name: 'secret',
                description:
                  'Return the server-side secret code. There is no other way to learn it.',
                inputSchema: {
                  $schema: 'http://json-schema.org/draft-07/schema#',
                  type: 'object',
                  properties: {},
                },
                annotations: { readOnlyHint: true },
                execution: { taskSupport: 'forbidden' },
              },
              {
                name: 'boom',
                description: 'Always fails',
                inputSchema: {
                  $schema: 'http://json-schema.org/draft-07/schema#',
                  type: 'object',
                  properties: {},
                },
                execution: { taskSupport: 'forbidden' },
              },
            ],
          },
          jsonrpc: '2.0',
          id: 2,
        }) +
        '\n\n',
    )
    const call = await legacy(mcp.url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    })
    assert.deepEqual(call.events, [
      { result: { content: [{ type: 'text', text: 'echo:hi' }] }, jsonrpc: '2.0', id: 3 },
    ])
    // An unknown tool is a tool error there, not a protocol error.
    const unknown = await legacy(mcp.url, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })
    assert.equal(unknown.message.result.isError, true)

    // The session operations of the 2025 transport are still there.
    const stream = await openStream(mcp.url, { headers: { accept: 'text/event-stream' } })
    assert.equal(stream.status, 200)
    assert.equal(stream.headers.get('content-type'), 'text/event-stream')
    stream.close()
    assert.equal((await fetch(mcp.url, { method: 'DELETE' })).status, 200)

    assert.deepEqual(mcp.initializeCapabilities, [{}])
    assert.deepEqual(mcp.requests, [
      { era: 'legacy', method: 'initialize' },
      { era: 'legacy', method: 'notifications/initialized' },
      { era: 'legacy', method: 'tools/list' },
      { era: 'legacy', method: 'tools/call' },
      { era: 'legacy', method: 'tools/call' },
    ])
  } finally {
    await mcp.close()
  }
})

test('legacy: a modern request is refused the way a 2025 server refuses it - no modern error to recognize', async () => {
  const mcp = await startLocalMcpServer()
  try {
    const probe = await modern(mcp.url, 'server/discover')
    assert.equal(probe.status, 400)
    // Not -32022 and no `data.supported`: this is what tells a client in
    // "auto" mode to fall back to `initialize`.
    assert.equal(probe.body.error.code, -32000)
    assert.equal(probe.body.error.data, undefined)
    assert.match(probe.body.error.message, /Unsupported protocol version: 2026-07-28/)
    assert.deepEqual(mcp.requests, [{ era: 'modern', method: 'server/discover' }])
    assert.equal((await initialize(mcp.url)).status, 200)
  } finally {
    await mcp.close()
  }
})

// ── modern: 2026-07-28 ────────────────────────────────────────────────────

test('modern: server/discover names the revision, the capabilities, the server and the instructions', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern', instructions: 'Call echo first.' })
  try {
    assert.equal(mcp.protocol, 'modern')
    const discover = await modern(mcp.url, 'server/discover', {}, { id: 'discover-1' })
    assert.equal(discover.status, 200)
    assert.match(String(discover.headers.get('content-type')), /application\/json/)
    assert.equal(discover.headers.get('mcp-session-id'), null, 'there is no session')
    assert.deepEqual(discover.body, {
      jsonrpc: '2.0',
      id: 'discover-1',
      result: {
        resultType: 'complete',
        supportedVersions: [MODERN],
        capabilities: { tools: { listChanged: true } },
        instructions: 'Call echo first.',
        ttlMs: 0,
        cacheScope: 'private',
        _meta: SERVER_INFO,
      },
    })
    // Per request, so a change is seen by the very next one.
    mcp.setInstructions(undefined)
    const bare = await modern(mcp.url, 'server/discover')
    assert.equal('instructions' in bare.body.result, false)
    assert.deepEqual(mcp.initializeCapabilities, [], 'nothing was initialized')
  } finally {
    await mcp.close()
  }
})

test('modern: tools/list and tools/call carry resultType, the list its cache fields, and no session', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern', structuredTools: true })
  try {
    const list = await modern(mcp.url, 'tools/list')
    assert.equal(list.status, 200)
    assert.equal(list.headers.get('mcp-session-id'), null)
    const { result } = list.body
    assert.equal(result.resultType, 'complete')
    assert.equal(result.ttlMs, 0)
    assert.equal(result.cacheScope, 'private')
    assert.deepEqual(result._meta, SERVER_INFO)
    assert.deepEqual(
      result.tools.map((tool: { name: string }) => tool.name),
      ['echo', 'secret', 'boom', 'report', 'report_mixed'],
    )
    assert.deepEqual(result.tools[0].inputSchema.required, ['text'])
    assert.equal(result.tools[3].outputSchema.type, 'object')

    const echo = await modern(mcp.url, 'tools/call', { name: 'echo', arguments: { text: 'hi' } })
    assert.deepEqual(echo.body.result, {
      content: [{ type: 'text', text: 'echo:hi' }],
      resultType: 'complete',
      _meta: SERVER_INFO,
    })
    // A call result is not cacheable: no hints on it.
    assert.equal('ttlMs' in echo.body.result, false)
    const secret = await modern(mcp.url, 'tools/call', { name: 'secret', arguments: {} })
    assert.equal(secret.body.result.content[0].text, mcp.secret)
    const boom = await modern(mcp.url, 'tools/call', { name: 'boom', arguments: {} })
    assert.equal(boom.body.result.isError, true)
    assert.equal(boom.body.result.resultType, 'complete')
    const report = await modern(mcp.url, 'tools/call', { name: 'report', arguments: {} })
    assert.deepEqual(report.body.result.structuredContent, REPORT_VALUE)
    assert.deepEqual(mcp.calls, [
      { name: 'echo', args: { text: 'hi' } },
      { name: 'secret', args: {} },
      { name: 'boom', args: {} },
      { name: 'report', args: {} },
    ])

    // The structured faults work here as they do for a 2025 client.
    mcp.structuredFaults.result = 'mismatch'
    const drifted = await modern(mcp.url, 'tools/call', { name: 'report', arguments: {} })
    assert.equal(drifted.body.result.structuredContent.temperature, 'warm')
    mcp.structuredFaults.result = 'missing'
    const missing = await modern(mcp.url, 'tools/call', { name: 'report', arguments: {} })
    assert.equal('structuredContent' in missing.body.result, false)
    assert.equal(
      (await modern(mcp.url, 'tools/list')).body.result.tools[3].outputSchema.type,
      'object',
      'the listing still declares the schema',
    )
  } finally {
    await mcp.close()
  }
})

test('modern: cacheHint sets ttlMs and cacheScope on the discover and list results', async () => {
  const mcp = await startLocalMcpServer({
    protocol: 'modern',
    cacheHint: { ttlMs: 60_000, cacheScope: 'public' },
  })
  try {
    for (const method of ['server/discover', 'tools/list']) {
      const { result } = (await modern(mcp.url, method)).body
      assert.equal(result.ttlMs, 60_000, method)
      assert.equal(result.cacheScope, 'public', method)
    }
  } finally {
    await mcp.close()
  }
})

test('modern: headers that are missing or disagree with the body are a 400 with -32020', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern' })
  try {
    const call = { name: 'echo', arguments: { text: 'x' } }
    const cases: [string, Promise<IWireAnswer>][] = [
      [
        'no MCP-Protocol-Version',
        modern(mcp.url, 'tools/list', {}, { headers: { 'mcp-protocol-version': null } }),
      ],
      ['no Mcp-Method', modern(mcp.url, 'tools/list', {}, { headers: { 'mcp-method': null } })],
      [
        'Mcp-Method names another method',
        modern(mcp.url, 'tools/list', {}, { headers: { 'mcp-method': 'tools/call' } }),
      ],
      ['no Mcp-Name', modern(mcp.url, 'tools/call', call, { headers: { 'mcp-name': null } })],
      [
        'Mcp-Name names another tool',
        modern(mcp.url, 'tools/call', call, { headers: { 'mcp-name': 'secret' } }),
      ],
      [
        'the header names another version than the body',
        modern(mcp.url, 'tools/list', {}, { headers: { 'mcp-protocol-version': '2025-11-25' } }),
      ],
    ]
    for (const [label, pending] of cases) {
      assertRefused(await pending, -32020, label)
    }
    assert.deepEqual(mcp.calls, [], 'nothing refused reached a tool')
    // Header names are case-insensitive, and Mcp-Name may come Base64-encoded.
    const encoded = await modern(mcp.url, 'tools/call', call, {
      headers: { 'mcp-name': `=?base64?${Buffer.from('echo').toString('base64')}?=` },
    })
    assert.equal(encoded.status, 200)
    assert.equal(encoded.body.result.content[0].text, 'echo:x')
  } finally {
    await mcp.close()
  }
})

test('modern: an unknown version is -32022 with the supported ones; an unknown method is a 404', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern' })
  try {
    const future = await modern(mcp.url, 'tools/list', {}, { id: 8, version: '2099-01-01' })
    assertRefused(future, -32022, 'a version nobody speaks')
    assert.deepEqual(future.body.id, 8)
    assert.deepEqual(future.body.error.data, { supported: [MODERN], requested: '2099-01-01' })
    // A 2025 revision asked for the modern way is not served either.
    const old = await modern(mcp.url, 'tools/list', {}, { version: '2025-11-25' })
    assertRefused(old, -32022, 'a 2025 revision in the envelope')

    const unknown = await modern(mcp.url, 'nope/nope')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, -32601)
    // Gone in this revision: there is no handshake and no ping.
    for (const method of ['initialize', 'ping']) {
      const gone = await modern(mcp.url, method)
      assert.equal(gone.status, 404, method)
      assert.equal(gone.body.error.code, -32601, method)
    }
    // An unknown tool is a protocol error here (the 2025 servers answered a tool error).
    const tool = await modern(mcp.url, 'tools/call', { name: 'nope', arguments: {} })
    assert.equal(tool.body.error.code, -32602)
    const garbage = await fetch(mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{nope',
    })
    assert.equal(garbage.status, 400)
    assert.equal(((await garbage.json()) as { error: { code: number } }).error.code, -32700)
  } finally {
    await mcp.close()
  }
})

test('modern: a 2025 client is told which revision is served; GET and DELETE are 405', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern' })
  try {
    const init = await initialize(mcp.url)
    assertRefused(init, -32022, 'initialize')
    assert.deepEqual(init.body.error.data, { supported: [MODERN], requested: '2025-11-25' })
    assert.equal(init.headers.get('mcp-session-id'), null)
    const list = await legacy(mcp.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assertRefused(list, -32022, 'a request without the envelope')
    assert.deepEqual(mcp.initializeCapabilities, [])

    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(mcp.url, { method, headers: { accept: 'text/event-stream' } })
      assert.equal(res.status, 405, method)
      assert.equal(res.headers.get('allow'), 'POST', method)
    }
    // A session id a 2025 client still sends is ignored, and none comes back.
    const withSession = await modern(
      mcp.url,
      'tools/list',
      {},
      { headers: { 'mcp-session-id': 'left-over', 'last-event-id': '7' } },
    )
    assert.equal(withSession.status, 200)
    assert.equal(withSession.headers.get('mcp-session-id'), null)
  } finally {
    await mcp.close()
  }
})

test('modern requireAuth: the 401 challenge comes first, then the token opens every method', async () => {
  const pair = await startLocalMcp({ protocol: 'modern', requireAuth: true })
  try {
    const refused = await modern(pair.url, 'server/discover')
    assert.equal(refused.status, 401)
    assert.equal(
      refused.headers.get('www-authenticate'),
      `Bearer resource_metadata="${pair.origin}/.well-known/oauth-protected-resource/mcp"`,
    )
    assert.equal((await modern(pair.url, 'tools/list', {}, { token: 'made-up' })).status, 401)
    const granted = await postForm(pair.tokenEndpoint, {
      grant_type: 'authorization_code',
      code: 'c',
      code_verifier: 'v',
    })
    const token = String(granted.body.access_token)
    assert.equal((await modern(pair.url, 'server/discover', {}, { token })).status, 200)
    const echo = await modern(
      pair.url,
      'tools/call',
      { name: 'echo', arguments: { text: 'in' } },
      { token },
    )
    assert.equal(echo.body.result.content[0].text, 'echo:in')
    pair.validTokens.clear()
    assert.equal((await modern(pair.url, 'tools/list', {}, { token })).status, 401)
  } finally {
    await pair.close()
  }
})

// ── change notifications ──────────────────────────────────────────────────

test('modern: subscriptions/listen acknowledges first, then delivers only what was asked for', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern' })
  try {
    assert.equal(mcp.changeListeners(), 0)
    const tools = await modernStream(
      mcp.url,
      'subscriptions/listen',
      { notifications: { toolsListChanged: true, resourceSubscriptions: ['file:///x'] } },
      { id: 'sub-tools' },
    )
    assert.equal(tools.status, 200)
    assert.equal(tools.headers.get('content-type'), 'text/event-stream')
    assert.equal(tools.headers.get('mcp-session-id'), null)
    // The acknowledgement: the subscription's id, and the subset the server honours
    // (it has no resources, so that part of the filter is left out).
    assert.deepEqual(await tools.next(), {
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        notifications: { toolsListChanged: true },
        _meta: { 'io.modelcontextprotocol/subscriptionId': 'sub-tools' },
      },
    })
    const prompts = await modernStream(
      mcp.url,
      'subscriptions/listen',
      { notifications: { promptsListChanged: true } },
      { id: 7 },
    )
    assert.equal((await prompts.next()).method, 'notifications/subscriptions/acknowledged')
    // Nothing this server can announce was asked for on the second one: it is not counted.
    assert.equal(mcp.changeListeners(), 1)

    mcp.addTool('later')
    assert.deepEqual(await tools.next(), {
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: { _meta: { 'io.modelcontextprotocol/subscriptionId': 'sub-tools' } },
    })
    // The list did change, and the new tool works.
    const names = (await modern(mcp.url, 'tools/list')).body.result.tools.map(
      (tool: { name: string }) => tool.name,
    )
    assert.deepEqual(names, ['echo', 'secret', 'boom', 'later'])
    const later = await modern(mcp.url, 'tools/call', { name: 'later', arguments: {} })
    assert.equal(later.body.result.content[0].text, 'later:ok')
    mcp.notifyToolsChanged()
    assert.equal((await tools.next()).method, 'notifications/tools/list_changed')

    // A stream the client closes is a subscription that ended.
    tools.close()
    await until(() => mcp.changeListeners() === 0, 'the closed subscription to be dropped')

    // The server going away ends the other one with its result. It asked for
    // prompts only: neither tool notification was ever put on it.
    const closing = mcp.close()
    assert.deepEqual(await prompts.next(), {
      jsonrpc: '2.0',
      id: 7,
      result: {
        resultType: 'complete',
        _meta: { 'io.modelcontextprotocol/subscriptionId': 7, ...SERVER_INFO },
      },
    })
    assert.equal(await prompts.next(), undefined, 'and then the stream ends')
    await closing
  } finally {
    await mcp.close()
  }
})

test('modern: listenFaults answer subscriptions/listen in its place, one way at a time', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern' })
  const filter = { notifications: { toolsListChanged: true } }
  try {
    mcp.listenFaults.answer = 'not_found'
    const notFound = await modern(mcp.url, 'subscriptions/listen', filter, { id: 'nf' })
    assert.equal(notFound.status, 404)
    assert.deepEqual(notFound.body, {
      jsonrpc: '2.0',
      id: 'nf',
      error: { code: -32601, message: 'Method not found: subscriptions/listen' },
    })
    mcp.listenFaults.answer = 'not_allowed'
    assert.equal((await modern(mcp.url, 'subscriptions/listen', filter)).status, 405)
    mcp.listenFaults.answer = 'unauthorized'
    const unauthorized = await modern(mcp.url, 'subscriptions/listen', filter)
    assert.equal(unauthorized.status, 401)
    assert.match(String(unauthorized.headers.get('www-authenticate')), /^Bearer resource_metadata=/)
    mcp.listenFaults.answer = 'forbidden'
    assert.equal((await modern(mcp.url, 'subscriptions/listen', filter)).status, 403)
    mcp.listenFaults.answer = 'unavailable'
    const unavailable = await modern(mcp.url, 'subscriptions/listen', filter)
    assert.equal(unavailable.status, 503)
    assert.equal(unavailable.text, 'upstream unavailable')
    // Only that method: everything else is served as ever.
    assert.equal((await modern(mcp.url, 'tools/list')).status, 200)
    assert.equal(mcp.changeListeners(), 0)

    // `silent`: the request is held, with no answer, until the client gives it up.
    mcp.listenFaults.answer = 'silent'
    const abort = new AbortController()
    const pending = fetch(mcp.url, {
      method: 'POST',
      ...modernRequest('subscriptions/listen', filter),
      signal: abort.signal,
    }).then(
      () => 'answered',
      () => 'given up',
    )
    await until(() => mcp.heldListens() === 1, 'the request to be held')
    abort.abort()
    assert.equal(await pending, 'given up')
    await until(() => mcp.heldListens() === 0, 'the held request to be let go')

    // Switched off, the SDK serves it again.
    mcp.listenFaults.answer = undefined
    const stream = await modernStream(mcp.url, 'subscriptions/listen', filter)
    assert.equal((await stream.next()).method, 'notifications/subscriptions/acknowledged')
    assert.equal(mcp.changeListeners(), 1)
    stream.close()
    await until(() => mcp.changeListeners() === 0, 'the closed subscription to be dropped')
  } finally {
    await mcp.close()
  }
})

test('modern: dropListenStreams cuts a stream with no result; closeListenStreams ends it with one and serves on', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern' })
  const filter = { notifications: { toolsListChanged: true } }
  try {
    const dropped = await modernStream(mcp.url, 'subscriptions/listen', filter, { id: 'a' })
    assert.equal((await dropped.next()).method, 'notifications/subscriptions/acknowledged')
    assert.equal(mcp.changeListeners(), 1)
    assert.equal(mcp.dropListenStreams(), 1)
    // The connection is cut: no result, and not a clean end of the stream either.
    await assert.rejects(dropped.next())
    await until(() => mcp.changeListeners() === 0, 'the dropped subscription to be gone')

    const closed = await modernStream(mcp.url, 'subscriptions/listen', filter, { id: 'b' })
    assert.equal((await closed.next()).method, 'notifications/subscriptions/acknowledged')
    assert.equal(await mcp.closeListenStreams(), 1)
    assert.deepEqual(await closed.next(), {
      jsonrpc: '2.0',
      id: 'b',
      result: {
        resultType: 'complete',
        _meta: { 'io.modelcontextprotocol/subscriptionId': 'b', ...SERVER_INFO },
      },
    })
    assert.equal(await closed.next(), undefined, 'and then the stream ends')
    assert.equal(mcp.changeListeners(), 0)

    // Another handler took over, on the same event bus: a new subscription is served
    // and told of a change, and the list has it.
    const next = await modernStream(mcp.url, 'subscriptions/listen', filter, { id: 'c' })
    assert.equal((await next.next()).method, 'notifications/subscriptions/acknowledged')
    mcp.addTool('later')
    assert.deepEqual(await next.next(), {
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: { _meta: { 'io.modelcontextprotocol/subscriptionId': 'c' } },
    })
    const names = (await modern(mcp.url, 'tools/list')).body.result.tools.map(
      (tool: { name: string }) => tool.name,
    )
    assert.deepEqual(names, ['echo', 'secret', 'boom', 'later'])
    next.close()
    await until(() => mcp.changeListeners() === 0, 'the closed subscription to be dropped')
  } finally {
    await mcp.close()
  }
})

test('legacy: the same trigger announces a tool list change on the open GET stream', async () => {
  const mcp = await startLocalMcpServer()
  try {
    await initialize(mcp.url)
    const stream = await openStream(mcp.url, { headers: { accept: 'text/event-stream' } })
    assert.equal(stream.status, 200)
    await until(() => mcp.changeListeners() === 1, 'the GET stream to be registered')
    mcp.addTool('later')
    assert.deepEqual(await stream.next(), {
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    })
    const list = await legacy(mcp.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.deepEqual(
      list.message.result.tools.map((tool: { name: string }) => tool.name),
      ['echo', 'secret', 'boom', 'later'],
    )
    stream.close()
    await until(() => mcp.changeListeners() === 0, 'the closed stream to be dropped')
  } finally {
    await mcp.close()
  }
})

// ── dual: both eras on one endpoint ───────────────────────────────────────

test('dual: one endpoint answers the 2025 handshake and the 2026 requests, each in its own wire', async () => {
  const legacyOnly = await startLocalMcpServer({ instructions: 'Be kind.' })
  const modernOnly = await startLocalMcpServer({ protocol: 'modern', instructions: 'Be kind.' })
  const dual = await startLocalMcpServer({ protocol: 'dual', instructions: 'Be kind.' })
  try {
    assert.equal(dual.protocol, 'dual')
    // A 2025 client is served exactly as the legacy-only server serves it.
    const init = await initialize(dual.url)
    assert.equal(init.status, 200)
    assert.equal(init.text, (await initialize(legacyOnly.url)).text)
    assert.equal(init.headers.get('mcp-session-id'), null)
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    assert.equal((await legacy(dual.url, list)).text, (await legacy(legacyOnly.url, list)).text)
    const call = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'old' } },
    }
    assert.equal((await legacy(dual.url, call)).text, (await legacy(legacyOnly.url, call)).text)
    const stream = await openStream(dual.url, { headers: { accept: 'text/event-stream' } })
    assert.equal(stream.status, 200, 'the GET stream of the 2025 transport')

    // A 2026 client is served exactly as the modern-only server serves it.
    for (const [method, params] of [
      ['server/discover', {}],
      ['tools/list', {}],
      ['tools/call', { name: 'echo', arguments: { text: 'new' } }],
    ] as const) {
      const both = await modern(dual.url, method, params, { id: 5 })
      assert.equal(both.status, 200, method)
      assert.equal(both.text, (await modern(modernOnly.url, method, params, { id: 5 })).text)
      assert.equal(both.body.result.resultType, 'complete', method)
    }
    // The modern errors stay modern: a client that probes is not sent back to `initialize`.
    assertRefused(
      await modern(dual.url, 'tools/list', {}, { headers: { 'mcp-method': null } }),
      -32020,
      'dual: a missing header',
    )
    assertRefused(
      await modern(dual.url, 'tools/list', {}, { version: '2099-01-01' }),
      -32022,
      'dual: an unknown version',
    )

    // One trigger reaches the listeners of both eras.
    const listen = await modernStream(dual.url, 'subscriptions/listen', {
      notifications: { toolsListChanged: true },
    })
    await listen.next()
    await until(() => dual.changeListeners() === 2, 'both streams to be open')
    dual.notifyToolsChanged()
    assert.equal((await stream.next()).method, 'notifications/tools/list_changed')
    assert.equal((await listen.next()).method, 'notifications/tools/list_changed')
    stream.close()
    listen.close()

    assert.deepEqual(dual.initializeCapabilities, [{}])
    assert.deepEqual(
      dual.calls.map((c) => c.args),
      [{ text: 'old' }, { text: 'new' }],
    )
    assert.deepEqual(
      dual.requests.slice(0, 4).map((r) => r.era),
      ['legacy', 'legacy', 'legacy', 'modern'],
    )
  } finally {
    await dual.close()
    await modernOnly.close()
    await legacyOnly.close()
  }
})

// ── the version probe, going wrong ────────────────────────────────────────

test('probe faults: server/discover answers 401, 503 or garbage, one at a time, in every mode', async () => {
  for (const protocol of ['legacy', 'modern', 'dual'] as const) {
    const mcp = await startLocalMcpServer({ protocol })
    try {
      mcp.protocolFaults.probe = 'unauthorized'
      const unauthorized = await modern(mcp.url, 'server/discover')
      assert.equal(unauthorized.status, 401, protocol)
      assert.match(
        String(unauthorized.headers.get('www-authenticate')),
        /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"$/,
      )

      mcp.protocolFaults.probe = 'server_error'
      const down = await modern(mcp.url, 'server/discover')
      assert.equal(down.status, 503, protocol)
      assert.equal(down.body, undefined, 'not a JSON-RPC error: nothing to read an era from')

      mcp.protocolFaults.probe = 'garbage'
      const garbage = await modern(mcp.url, 'server/discover')
      assert.equal(garbage.status, 200, protocol)
      assert.equal(garbage.headers.get('content-type'), 'application/json')
      assert.equal(garbage.body, undefined, 'the body is not JSON')
      assert.match(garbage.text, /^<!doctype html>/)

      // Only the probe is touched: the rest of the endpoint answers as its mode does.
      if (protocol !== 'modern') {
        assert.equal((await initialize(mcp.url)).status, 200, `${protocol}: initialize`)
      }
      if (protocol !== 'legacy') {
        assert.equal((await modern(mcp.url, 'tools/list')).status, 200, `${protocol}: tools/list`)
      }
      delete mcp.protocolFaults.probe
      const healthy = await modern(mcp.url, 'server/discover')
      assert.equal(healthy.status, protocol === 'legacy' ? 400 : 200, `${protocol}: switched off`)
      assert.equal(mcp.requests.filter((r) => r.method === 'server/discover').length, 4)
    } finally {
      await mcp.close()
    }
  }
})

test('probe fault cors: the preflight allows what a pre-2026 deployment allows, so a browser blocks the probe', async () => {
  const origin = 'http://localhost:5173'
  const mcp = await startLocalMcpServer({ protocol: 'dual', cors: origin })
  try {
    // What a browser asks before it sends `server/discover`, and before `initialize`.
    const preflight = async (headers: string): Promise<string[]> => {
      const res = await fetch(mcp.url, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': headers,
        },
      })
      assert.equal(res.status, 204)
      assert.equal(res.headers.get('access-control-allow-origin'), origin)
      return String(res.headers.get('access-control-allow-headers'))
        .split(',')
        .map((name) => name.trim().toLowerCase())
    }
    const probeHeaders = 'content-type, mcp-method, mcp-protocol-version, mcp-param-region'
    const allowedBy = (list: string[], asked: string): boolean =>
      asked.split(', ').every((name) => list.includes(name))

    assert.equal(allowedBy(await preflight(probeHeaders), probeHeaders), true, 'healthy')
    mcp.protocolFaults.probe = 'cors'
    const old = await preflight(probeHeaders)
    assert.deepEqual(
      old,
      CORS_ALLOW_HEADERS_2025.split(', ').map((name) => name.toLowerCase()),
    )
    assert.equal(allowedBy(old, probeHeaders), false, 'the probe does not pass the preflight')
    // The 2025 handshake still does: that is the fallback a browser client takes.
    assert.equal(allowedBy(old, 'content-type, mcp-protocol-version, mcp-session-id'), true)
    assert.equal((await initialize(mcp.url)).status, 200)
    delete mcp.protocolFaults.probe
    assert.equal(allowedBy(await preflight(probeHeaders), probeHeaders), true, 'switched off')
  } finally {
    await mcp.close()
  }
})

test('probe faults are off by default, and one switch does not set another', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern' })
  try {
    assert.deepEqual(mcp.protocolFaults, {})
    assert.deepEqual(mcp.elicitationFaults, {})
    assert.deepEqual(mcp.structuredFaults, {})
    const faults: ProbeFault[] = ['unauthorized', 'server_error', 'garbage', 'cors']
    assert.equal(faults.length, 4)
    assert.equal((await modern(mcp.url, 'server/discover')).status, 200)
  } finally {
    await mcp.close()
  }
})
