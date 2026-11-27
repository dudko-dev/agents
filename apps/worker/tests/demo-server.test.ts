import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import {
  boundResponse,
  createDemoMcpServer,
  DEMO_INSTRUCTIONS,
  DEMO_LIMITS,
  DEMO_SERVER_INFO,
  type DemoMcpServer,
} from '../src/demo-server.ts'
import { DEMO_TOOL_NAMES, DOCS_PATH, ECHO_MAX_CHARS, tripForm } from '../src/tools.ts'
import {
  ASKABLE,
  initialize,
  legacy,
  legacyRequest,
  modern,
  modernRequest,
  MODERN,
  read,
  textOf,
  URL_ON_SITE,
} from './wire.ts'

// The demo MCP server spoken to by hand, through `server.fetch` with web-standard requests: what
// the Worker is handed on Cloudflare. Each era, each tool, each question, each limit.

const withServer = async (body: (server: DemoMcpServer) => Promise<void>): Promise<void> => {
  const server = createDemoMcpServer()
  try {
    await body(server)
  } finally {
    await server.close()
  }
}

const call = (
  name: string,
  args: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  name,
  arguments: args,
  ...extra,
})

const TRIP = {
  destination: 'Lisbon',
  start: '2026-12-01',
  nights: 3,
  travellers: 2,
  budget: 'comfortable',
  flexible: true,
}

// ── the two eras ────────────────────────────────────────────────────────────

test('2026-07-28: server/discover names the revision, the instructions and no list changes', async () => {
  await withServer(async (server) => {
    const answer = await modern(server, 'server/discover')
    assert.equal(answer.status, 200)
    const result = answer.message.result
    assert.deepEqual(result.supportedVersions, [MODERN])
    assert.equal(result.instructions, DEMO_INSTRUCTIONS)
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } })
    assert.deepEqual(result._meta['io.modelcontextprotocol/serverInfo'], DEMO_SERVER_INFO)
  })
})

test('2025-11-25: initialize is answered statelessly, with no session id', async () => {
  await withServer(async (server) => {
    const answer = await initialize(server)
    assert.equal(answer.status, 200)
    assert.equal(answer.headers.get('mcp-session-id'), null)
    const result = answer.message.result
    assert.equal(result.protocolVersion, '2025-11-25')
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } })
    assert.deepEqual(result.serverInfo, DEMO_SERVER_INFO)
    assert.equal(result.instructions, DEMO_INSTRUCTIONS)
  })
})

test('tools/list: the same five read-only tools on both eras; roll_dice declares its output', async () => {
  await withServer(async (server) => {
    const lists = [
      (await modern(server, 'tools/list')).message.result.tools,
      (await legacy(server, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).message
        .result.tools,
    ]
    for (const tools of lists) {
      assert.deepEqual(
        tools.map((t: { name: string }) => t.name),
        [...DEMO_TOOL_NAMES],
      )
      for (const tool of tools) {
        assert.equal(tool.annotations.readOnlyHint, true, tool.name)
        assert.ok(tool.description.length > 20, tool.name)
      }
      const dice = tools.find((t: { name: string }) => t.name === 'roll_dice')
      assert.deepEqual(Object.keys(dice.outputSchema.properties), ['sides', 'rolls', 'total'])
    }
  })
})

// ── plain tools ─────────────────────────────────────────────────────────────

test('echo: returns its text; a text over the limit is refused by the schema', async () => {
  await withServer(async (server) => {
    const ok = await modern(server, 'tools/call', call('echo', { text: 'hello, demo' }))
    assert.equal(textOf(ok), 'hello, demo')
    assert.equal(ok.message.result.isError, undefined)
    const long = await modern(
      server,
      'tools/call',
      call('echo', { text: 'x'.repeat(ECHO_MAX_CHARS + 1) }),
    )
    assert.equal(long.message.result.isError, true)
    assert.match(textOf(long), /Too big/)
  })
})

test('current_time: UTC now, the local time in a named zone, an unknown zone is an error', async () => {
  await withServer(async (server) => {
    const before = Date.now()
    const utc = textOf(await modern(server, 'tools/call', call('current_time')))
    assert.ok(Math.abs(Date.parse(utc) - before) < 5000, utc)
    const tokyo = textOf(
      await modern(server, 'tools/call', call('current_time', { timeZone: 'Asia/Tokyo' })),
    )
    assert.match(tokyo, /^\d{4}-\d\d-\d\dT.+Z \(.+\)$/)
    assert.match(tokyo, /GMT\+9|Japan/)
    const bad = await modern(server, 'tools/call', call('current_time', { timeZone: 'Mars/Base' }))
    assert.equal(bad.message.result.isError, true)
    assert.equal(textOf(bad), 'Unknown time zone: "Mars/Base".')
  })
})

test('roll_dice: structured content that matches its text, within bounds, on both eras', async () => {
  await withServer(async (server) => {
    const answers = [
      await modern(server, 'tools/call', call('roll_dice', { count: 5, sides: 6 })),
      await legacy(server, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: call('roll_dice', { count: 5, sides: 6 }),
      }),
    ]
    for (const answer of answers) {
      const { structuredContent } = answer.message.result
      assert.deepEqual(JSON.parse(textOf(answer)), structuredContent)
      assert.equal(structuredContent.sides, 6)
      assert.equal(structuredContent.rolls.length, 5)
      assert.ok(
        structuredContent.rolls.every((r: number) => Number.isInteger(r) && r >= 1 && r <= 6),
      )
      assert.equal(
        structuredContent.total,
        structuredContent.rolls.reduce((a: number, b: number) => a + b, 0),
      )
    }
    // Defaults: one six-sided die. Every face turns up (not a constant, not off by one).
    const faces = new Set<number>()
    for (let i = 0; i < 4; i += 1) {
      const answer = await modern(server, 'tools/call', call('roll_dice', { count: 20 }))
      for (const roll of answer.message.result.structuredContent.rolls) faces.add(roll)
    }
    assert.deepEqual([...faces].sort(), [1, 2, 3, 4, 5, 6])
    const tooMany = await modern(server, 'tools/call', call('roll_dice', { count: 21 }))
    assert.equal(tooMany.message.result.isError, true)
  })
})

// ── plan_trip: a form question ──────────────────────────────────────────────

test('plan_trip (2026-07-28): asks for the form, then summarises the accepted answer', async () => {
  await withServer(async (server) => {
    const first = await modern(server, 'tools/call', call('plan_trip'), ASKABLE)
    const result = first.message.result
    assert.equal(result.resultType, 'input_required')
    // Stateless: everything the second round needs comes back in the answer itself.
    assert.equal(result.requestState, undefined)
    assert.deepEqual(result.inputRequests, {
      trip: {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: 'Where and when would you like to go?',
          requestedSchema: tripForm(),
        },
      },
    })

    const done = await modern(
      server,
      'tools/call',
      call('plan_trip', {}, { inputResponses: { trip: { action: 'accept', content: TRIP } } }),
      ASKABLE,
    )
    assert.equal(done.message.result.resultType, 'complete')
    assert.equal(done.message.result.isError, undefined)
    assert.equal(
      textOf(done),
      'Trip to Lisbon: 3 nights from 2026-12-01 to 2026-12-04, 2 travellers, comfortable budget, flexible dates.',
    )
  })
})

test('plan_trip: a destination the model knows is offered as the default', async () => {
  await withServer(async (server) => {
    const first = await modern(
      server,
      'tools/call',
      call('plan_trip', { destination: ' Porto ' }),
      ASKABLE,
    )
    const schema = first.message.result.inputRequests.trip.params.requestedSchema
    assert.equal(schema.properties.destination.default, 'Porto')
    assert.deepEqual(schema, tripForm('Porto'))
  })
})

test('plan_trip: an answer that does not fit the form is asked again, not failed', async () => {
  await withServer(async (server) => {
    for (const content of [
      { ...TRIP, nights: 0 },
      { ...TRIP, start: 'next week' },
      { ...TRIP, budget: 'unlimited' },
      { destination: 'Lisbon' },
    ]) {
      const again = await modern(
        server,
        'tools/call',
        call('plan_trip', {}, { inputResponses: { trip: { action: 'accept', content } } }),
        ASKABLE,
      )
      assert.equal(again.message.result.resultType, 'input_required', JSON.stringify(content))
      assert.match(again.message.result.inputRequests.trip.params.message, /did not fit the form/)
    }
  })
})

test('plan_trip: decline and cancel are outcomes, not errors', async () => {
  await withServer(async (server) => {
    for (const action of ['decline', 'cancel']) {
      const answer = await modern(
        server,
        'tools/call',
        call('plan_trip', {}, { inputResponses: { trip: { action } } }),
        ASKABLE,
      )
      assert.equal(answer.message.result.isError, undefined)
      assert.equal(textOf(answer), `The user did not plan a trip (${action}).`)
    }
  })
})

test('plan_trip: a client that cannot show a form gets a tool error, and nothing is asked', async () => {
  await withServer(async (server) => {
    for (const capabilities of [{}, { elicitation: { url: {} } }]) {
      const answer = await modern(server, 'tools/call', call('plan_trip'), capabilities)
      assert.equal(answer.message.result.isError, true)
      assert.equal(answer.message.result.inputRequests, undefined)
      assert.match(textOf(answer), /did not declare/)
    }
    // An empty capability object is the form only (the specification's default).
    const formOnly = await modern(server, 'tools/call', call('plan_trip'), { elicitation: {} })
    assert.equal(formOnly.message.result.resultType, 'input_required')
  })
})

test('plan_trip and open_docs (2025): a tool error that names the revision they need', async () => {
  await withServer(async (server) => {
    await initialize(server)
    for (const name of ['plan_trip', 'open_docs']) {
      const answer = await legacy(server, {
        jsonrpc: '2.0',
        id: name,
        method: 'tools/call',
        params: call(name),
      })
      assert.equal(answer.status, 200)
      assert.equal(answer.message.result.isError, true)
      assert.match(textOf(answer), /2026-07-28/)
      // No question was sent on the stream: the call's answer is the only message.
      assert.equal(answer.text.match(/^data:/gm)?.length, 1)
    }
  })
})

// ── open_docs: a link question ──────────────────────────────────────────────

test('open_docs (2026-07-28): a link on the origin the request was sent to', async () => {
  await withServer(async (server) => {
    const first = await modern(server, 'tools/call', call('open_docs'), ASKABLE)
    assert.deepEqual(first.message.result.inputRequests, {
      docs: {
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: 'Open the page about MCP elicitation in the agent.dudko.dev docs.',
          url: `https://agent.dudko.dev${DOCS_PATH}`,
        },
      },
    })
    // A preview deployment or a local server links to itself.
    const local = await read(
      await server.fetch(
        modernRequest(
          'tools/call',
          call('open_docs'),
          ASKABLE,
          {},
          'http://127.0.0.1:4199/mcp/demo',
        ),
      ),
    )
    assert.equal(
      local.message.result.inputRequests.docs.params.url,
      `http://127.0.0.1:4199${DOCS_PATH}`,
    )
    const accepted = await modern(
      server,
      'tools/call',
      call('open_docs', {}, { inputResponses: { docs: { action: 'accept' } } }),
      ASKABLE,
    )
    assert.equal(textOf(accepted), `The user agreed to open https://agent.dudko.dev${DOCS_PATH}.`)
    const declined = await modern(
      server,
      'tools/call',
      call('open_docs', {}, { inputResponses: { docs: { action: 'decline' } } }),
      ASKABLE,
    )
    assert.equal(textOf(declined), 'The user did not open the page (decline).')
    // A client that declared forms only is not sent a link.
    const formOnly = await modern(server, 'tools/call', call('open_docs'), {
      elicitation: { form: {} },
    })
    assert.equal(formOnly.message.result.isError, true)
  })
})

// ── the limits of a public endpoint ─────────────────────────────────────────

const bigBody = (bytes: number): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'x'.repeat(bytes) } },
  })

test('limit: a body over the bound is refused 413, by its length or as it streams', async () => {
  await withServer(async (server) => {
    const declared = await read(
      await server.fetch(
        new Request(URL_ON_SITE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: bigBody(DEMO_LIMITS.requestBytes),
        }),
      ),
    )
    assert.equal(declared.status, 413)
    assert.equal(declared.message.error.code, -32600)
    // No content-length: a stream that keeps going is cut off at the bound.
    const encoder = new TextEncoder()
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(encoder.encode('x'.repeat(4096)))
      },
    })
    const streamed = await server.fetch(
      new Request(URL_ON_SITE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: endless,
        duplex: 'half',
      } as RequestInit),
    )
    assert.equal(streamed.status, 413)
    assert.ok(pulled * 4096 <= DEMO_LIMITS.requestBytes + 2 * 4096, `read ${pulled} chunks`)
    // Just under the bound is served.
    const under = await read(
      await server.fetch(
        modernRequest('tools/call', call('echo', { text: 'x'.repeat(ECHO_MAX_CHARS) })),
      ),
    )
    assert.equal(under.status, 200)
  })
})

test('limit: a JSON-RPC batch is refused, so one request is at most one tool call', async () => {
  await withServer(async (server) => {
    const one = { jsonrpc: '2.0', method: 'tools/call', params: call('roll_dice') }
    const answer = await read(
      await server.fetch(
        legacyRequest([
          { ...one, id: 1 },
          { ...one, id: 2 },
        ] as never),
      ),
    )
    assert.equal(answer.status, 400)
    assert.equal(answer.message.error.code, -32600)
    assert.match(answer.message.error.message, /batches are not accepted/)
  })
})

test('limit: arguments with too many elements are refused by the SDK', async () => {
  await withServer(async (server) => {
    const answer = await modern(
      server,
      'tools/call',
      call('echo', {
        text: 'x',
        extra: Array.from({ length: DEMO_LIMITS.toolInputElements }, (_, i) => i),
      }),
    )
    assert.equal(answer.message.result.isError, true)
    assert.match(textOf(answer), /maximum of 64 elements/)
  })
})

test('limit: subscriptions/listen is refused at once, with the request id (no stream stays open)', async () => {
  await withServer(async (server) => {
    const req = modernRequest('subscriptions/listen', { notifications: { toolsListChanged: true } })
    const id = JSON.parse(await req.clone().text()).id
    const answer = await read(await server.fetch(req))
    assert.equal(answer.status, 200)
    assert.equal(answer.headers.get('content-type'), 'application/json')
    assert.deepEqual(answer.message.id, id)
    assert.equal(answer.message.error.code, -32601)
  })
})

test('limit: an answer over the bound is cut off, by its length or as it streams', async () => {
  const declared = boundResponse(
    new Response('x'.repeat(100), { headers: { 'content-length': '100' } }),
    10,
  )
  assert.equal(declared.status, 500)
  const streamed = boundResponse(new Response(new Blob(['x'.repeat(100)]).stream()), 10)
  await assert.rejects(streamed.text(), /too large/)
  const small = boundResponse(new Response('fine'), 10)
  assert.equal(await small.text(), 'fine')
})

test('origin: a page of another origin is refused; the site itself and non-browser clients are served', async () => {
  await withServer(async (server) => {
    const foreign = await read(
      await server.fetch(modernRequest('tools/list', {}, {}, { origin: 'https://evil.example' })),
    )
    assert.equal(foreign.status, 403)
    assert.equal(foreign.headers.get('access-control-allow-origin'), null)
    const site = await read(
      await server.fetch(
        modernRequest('tools/list', {}, {}, { origin: 'https://agent.dudko.dev' }),
      ),
    )
    assert.equal(site.status, 200)
    const none = await read(await server.fetch(modernRequest('tools/list')))
    assert.equal(none.status, 200)
  })
})

test('GET: a person gets a line about the endpoint; a 2025 stream request and DELETE get 405', async () => {
  await withServer(async (server) => {
    const page = await server.fetch(new Request(URL_ON_SITE, { headers: { accept: 'text/html' } }))
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /^text\/plain/)
    assert.match(await page.text(), /demo MCP server/)
    const stream = await server.fetch(
      new Request(URL_ON_SITE, { headers: { accept: 'text/event-stream' } }),
    )
    assert.equal(stream.status, 405)
    const del = await server.fetch(new Request(URL_ON_SITE, { method: 'DELETE' }))
    assert.equal(del.status, 405)
  })
})

test('bad requests are answered by the SDK: not JSON, the wrong media type, an unknown tool', async () => {
  await withServer(async (server) => {
    const notJson = await read(
      await server.fetch(
        new Request(URL_ON_SITE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: '{not json',
        }),
      ),
    )
    assert.equal(notJson.status, 400)
    assert.equal(notJson.message.error.code, -32700)
    const plain = await server.fetch(
      new Request(URL_ON_SITE, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      }),
    )
    assert.equal(plain.status, 415)
    const unknown = await modern(server, 'tools/call', call('nope'))
    assert.equal(unknown.message.error.code, -32602)
  })
})

test('nothing is logged: not the inputs, not the errors', async () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const spies = methods.map((name) => mock.method(console, name, () => {}))
  try {
    await withServer(async (server) => {
      await modern(server, 'tools/call', call('echo', { text: 'SECRET-INPUT-1' }))
      await modern(server, 'tools/call', call('current_time', { timeZone: 'SECRET/ZONE' }))
      await modern(
        server,
        'tools/call',
        call(
          'plan_trip',
          {},
          { inputResponses: { trip: { action: 'accept', content: { ...TRIP, nights: -1 } } } },
        ),
        ASKABLE,
      )
      await modern(server, 'tools/call', call('nope', { text: 'SECRET-INPUT-2' }))
      await server.fetch(
        new Request(URL_ON_SITE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{oops',
        }),
      )
      await initialize(server)
    })
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0)
  } finally {
    for (const spy of spies) spy.mock.restore()
  }
})
