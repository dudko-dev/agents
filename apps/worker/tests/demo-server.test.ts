import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import vm from 'node:vm'
import {
  boundResponse,
  createDemoMcpServer,
  DEMO_INSTRUCTIONS,
  DEMO_LIMITS,
  DEMO_SERVER_INFO,
  type DemoMcpServer,
} from '../src/demo-server.ts'
import { DEMO_TOOL_NAMES, DOCS_PATH, ECHO_MAX_CHARS, tripForm } from '../src/tools.ts'
import { tripBoardHtml } from '../src/trip-board-app.ts'
import {
  APP_DOCS_PATH,
  APP_ONLY_TOOLS,
  bookingCode,
  TRIP_BOARD_URI,
  TRIP_DEFAULT_LEAD_DAYS,
  TRIP_DEFAULT_WEEKDAY,
  TRIP_MAX_NIGHTS,
  defaultTripStart,
  tripDay,
  tripPlan,
} from '../src/trip-board.ts'
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

/** Tools and a resource (the trip board's app), and lists that never change. */
const CAPABILITIES = { tools: { listChanged: false }, resources: { listChanged: false } }

test('2026-07-28: server/discover names the revision, the instructions and no list changes', async () => {
  await withServer(async (server) => {
    const answer = await modern(server, 'server/discover')
    assert.equal(answer.status, 200)
    const result = answer.message.result
    assert.deepEqual(result.supportedVersions, [MODERN])
    assert.equal(result.instructions, DEMO_INSTRUCTIONS)
    assert.deepEqual(result.capabilities, CAPABILITIES)
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
    assert.deepEqual(result.capabilities, CAPABILITIES)
    assert.deepEqual(result.serverInfo, DEMO_SERVER_INFO)
    assert.equal(result.instructions, DEMO_INSTRUCTIONS)
  })
})

test('tools/list: the same tools on both eras, read-only but for book_trip; roll_dice declares its output', async () => {
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
        // book_trip changes nothing either, but it stands for a booking: see trip-board.ts.
        assert.equal(tool.annotations.readOnlyHint, tool.name !== 'book_trip', tool.name)
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

// ── trip_board: an MCP App ──────────────────────────────────────────────────

const LISBON = {
  destination: 'Lisbon',
  start: '2026-12-01',
  nights: 3,
  travellers: 2,
  budget: 'comfortable',
}

const toolsOf = async (server: DemoMcpServer, era: 'modern' | 'legacy') =>
  era === 'modern'
    ? (await modern(server, 'tools/list')).message.result.tools
    : (await legacy(server, { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }))
        .message.result.tools

const readApp = async (server: DemoMcpServer, era: 'modern' | 'legacy', uri = TRIP_BOARD_URI) =>
  era === 'modern'
    ? modern(server, 'resources/read', { uri })
    : legacy(server, { jsonrpc: '2.0', id: 'read', method: 'resources/read', params: { uri } })

const callOn = async (
  server: DemoMcpServer,
  era: 'modern' | 'legacy',
  name: string,
  args: Record<string, unknown>,
) =>
  era === 'modern'
    ? modern(server, 'tools/call', call(name, args))
    : legacy(server, { jsonrpc: '2.0', id: name, method: 'tools/call', params: call(name, args) })

for (const era of ['modern', 'legacy'] as const) {
  test(`trip_board (${era}): the tool declares its app; the two app tools are for the app only`, async () => {
    await withServer(async (server) => {
      const tools = await toolsOf(server, era)
      const byName = new Map(tools.map((t: { name: string }) => [t.name, t]))
      const board = byName.get('trip_board') as any
      assert.deepEqual(board._meta, {
        ui: { resourceUri: TRIP_BOARD_URI, visibility: ['model', 'app'] },
        // The deprecated flat key, for hosts that read only that one.
        'ui/resourceUri': TRIP_BOARD_URI,
      })
      assert.deepEqual(Object.keys(board.outputSchema.properties), ['trip', 'days', 'estimate'])
      for (const name of APP_ONLY_TOOLS) {
        const tool = byName.get(name) as any
        // `visibility: ['app']`: a host that speaks MCP Apps never gives it to its model.
        assert.deepEqual(tool._meta, { ui: { visibility: ['app'] } }, name)
        assert.match(tool.description, /app only/, name)
        assert.ok(tool.outputSchema, name)
      }
      // Every other tool says nothing about apps.
      for (const tool of tools) {
        if (!['trip_board', ...APP_ONLY_TOOLS].includes(tool.name)) {
          assert.equal(tool._meta, undefined, tool.name)
        }
      }
      const book = byName.get('book_trip') as any
      assert.deepEqual(book.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      })
      assert.match(book.description, /DEMO booking: nothing is booked, charged or stored/)
      assert.equal((byName.get('reshuffle_day') as any).annotations.readOnlyHint, true)
    })
  })

  test(`trip_board (${era}): resources/read returns the app - its MIME type, empty CSP lists, one self-contained document`, async () => {
    await withServer(async (server) => {
      if (era === 'legacy') await initialize(server)
      const answer = await readApp(server, era)
      assert.equal(answer.status, 200)
      // The whole answer fits the response bound with room to spare.
      assert.ok(answer.text.length < DEMO_LIMITS.responseBytes / 2, `${answer.text.length} bytes`)
      const [content, ...more] = answer.message.result.contents
      assert.equal(more.length, 0)
      assert.equal(content.uri, TRIP_BOARD_URI)
      assert.equal(content.mimeType, 'text/html;profile=mcp-app')
      assert.deepEqual(content._meta, {
        ui: {
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
          prefersBorder: true,
        },
      })
      const html: string = content.text
      assert.match(html, /^<!doctype html><html lang="en">/)
      assert.ok(html.length < 40 * 1024, `${html.length} characters`)
      // Nothing to load: no external script, style, image, font or frame, no URL but the docs.
      assert.doesNotMatch(html, /<(link|img|iframe|object|embed|base)\b|\bsrc=|@import|url\(/i)
      const urls = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(([url]) => url)
      assert.deepEqual(urls, [`https://agent.dudko.dev${APP_DOCS_PATH}`])
      assert.equal(html.match(/<script>/g)?.length, 1)
    })
  })

  test(`trip_board (${era}): a plan computed from its inputs, the same every time`, async () => {
    await withServer(async (server) => {
      if (era === 'legacy') await initialize(server)
      const first = await callOn(server, era, 'trip_board', LISBON)
      const again = await callOn(server, era, 'trip_board', LISBON)
      const plan = first.message.result.structuredContent as ReturnType<typeof tripPlan>
      assert.equal(first.message.result.isError, undefined)
      assert.deepEqual(again.message.result.structuredContent, plan)
      assert.deepEqual(plan, tripPlan({ ...LISBON, end: '2026-12-04' } as never))
      assert.deepEqual(plan.trip, { ...LISBON, end: '2026-12-04' })
      assert.deepEqual(
        plan.days.map((d) => [d.day, d.date]),
        [
          [1, '2026-12-01'],
          [2, '2026-12-02'],
          [3, '2026-12-03'],
          [4, '2026-12-04'],
        ],
      )
      // Arrival and departure days, and middle days of three plans, none of them twice.
      assert.equal(plan.days[0]?.theme, 'Arrive and settle in')
      assert.equal(plan.days[0]?.items[0]?.title, 'Arrive in Lisbon and check in')
      assert.equal(plan.days[3]?.items.at(-1)?.title, 'Check out and head home')
      assert.deepEqual(
        plan.days.map((d) => d.items.length),
        [2, 3, 3, 2],
      )
      assert.equal(new Set(plan.days.map((d: { theme: string }) => d.theme)).size, 4)
      assert.deepEqual(plan.estimate, { currency: 'EUR', perPerson: 565, total: 1130 })
      // The text is the same plan, for the model and for hosts without apps.
      const words = textOf(first)
      assert.match(words, /^Trip board for Lisbon: 3 nights from 2026-12-01 to 2026-12-04/)
      for (const day of plan.days) assert.ok(words.includes(day.theme), day.theme)
      assert.match(words, /€1,130 in all/)
    })
  })
}

test('trip_board: the default first day - the first Friday at least 14 days after the request day (UTC)', () => {
  const at = (iso: string) => defaultTripStart(new Date(iso))
  // Friday 27 Nov 2026: 14 days on is Friday 11 Dec.
  assert.equal(at('2026-11-27T10:00:00Z'), '2026-12-11')
  // Saturday 28 Nov: 12 Dec is a Saturday, so Friday 18 Dec.
  assert.equal(at('2026-11-28T00:00:00Z'), '2026-12-18')
  // Thursday 26 Nov, late in the UTC day: 10 Dec is a Thursday, so Friday 11 Dec.
  assert.equal(at('2026-11-26T23:59:59Z'), '2026-12-11')
  // The day in UTC decides, whatever the time: the same request day, the same date.
  assert.equal(at('2026-11-26T00:00:00Z'), at('2026-11-26T23:59:59.999Z'))
  // Across a month and a year end.
  assert.equal(at('2026-12-20T12:00:00Z'), '2027-01-08')
  for (let d = 0; d < 14; d += 1) {
    const day = new Date(Date.UTC(2027, 1, 20 + d))
    const start = new Date(`${defaultTripStart(day)}T00:00:00Z`)
    const lead = (start.getTime() - day.getTime()) / 86_400_000
    assert.equal(start.getUTCDay(), TRIP_DEFAULT_WEEKDAY)
    assert.ok(lead >= TRIP_DEFAULT_LEAD_DAYS && lead < TRIP_DEFAULT_LEAD_DAYS + 7, String(lead))
  }
})

test('trip_board: defaults (dates from the request day when none is given), inputs bounded by the schema', async (t) => {
  // The server's clock, for this test only: a request on Friday 27 Nov 2026.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-27T09:30:00Z') })
  await withServer(async (server) => {
    const plain = await modern(server, 'tools/call', call('trip_board', { destination: ' Kyoto ' }))
    const plan = plain.message.result.structuredContent
    assert.deepEqual(plan.trip, {
      destination: 'Kyoto',
      start: '2026-12-11',
      end: '2026-12-14',
      nights: 3,
      travellers: 2,
      budget: 'comfortable',
    })
    assert.equal(plan.days.length, 4)
    assert.deepEqual(
      plan.days.map((d: { date?: string }) => d.date),
      ['2026-12-11', '2026-12-12', '2026-12-13', '2026-12-14'],
    )
    // The model is told the date was picked for it, and how to change it.
    assert.match(
      textOf(plain),
      /No first day was given, so the trip starts on 2026-12-11: the first Friday at least 14 days from today \(UTC\)/,
    )
    // Given, it is used as it is, and nothing is said about it.
    const given = await modern(
      server,
      'tools/call',
      call('trip_board', { destination: 'Kyoto', start: '2027-03-01' }),
    )
    assert.equal(given.message.result.structuredContent.trip.start, '2027-03-01')
    assert.doesNotMatch(textOf(given), /No first day/)
    assert.match(plan.days[0].items[0].title, /Arrive in Kyoto/)
    // A place is not case: the same plan.
    const lower = await modern(server, 'tools/call', call('trip_board', { destination: 'kyoto' }))
    assert.deepEqual(
      lower.message.result.structuredContent.days.map((d: { theme: string }) => d.theme),
      plan.days.map((d: { theme: string }) => d.theme),
    )
    for (const bad of [
      { destination: '' },
      { destination: 'x'.repeat(81) },
      { destination: 'Rome', nights: TRIP_MAX_NIGHTS + 1 },
      { destination: 'Rome', nights: 0 },
      { destination: 'Rome', travellers: 13 },
      { destination: 'Rome', budget: 'unlimited' },
      { destination: 'Rome', start: 'next week' },
    ]) {
      const answer = await modern(server, 'tools/call', call('trip_board', bad))
      assert.equal(answer.message.result.isError, true, JSON.stringify(bad))
    }
    const blank = await modern(server, 'tools/call', call('trip_board', { destination: '   ' }))
    assert.equal(blank.message.result.isError, true)
    assert.match(textOf(blank), /A destination is needed/)
    // The longest trip is still a small answer.
    const long = await modern(
      server,
      'tools/call',
      call('trip_board', { destination: 'x'.repeat(80), start: '2026-12-30', nights: 14 }),
    )
    assert.equal(long.message.result.structuredContent.days.length, 15)
    assert.equal(long.message.result.structuredContent.days[14].date, '2027-01-13')
    assert.ok(long.text.length < 16 * 1024, `${long.text.length} bytes`)
  })
})

test('trip_board: the docs link of the app is on the origin the request was sent to', async () => {
  await withServer(async (server) => {
    const local = await read(
      await server.fetch(
        modernRequest(
          'resources/read',
          { uri: TRIP_BOARD_URI },
          {},
          {},
          'http://127.0.0.1:4199/mcp/demo',
        ),
      ),
    )
    const html: string = local.message.result.contents[0].text
    assert.ok(html.includes(JSON.stringify(`http://127.0.0.1:4199${APP_DOCS_PATH}`)))
    assert.ok(!html.includes('https://agent.dudko.dev'))
    // A resource that is not there is an error, not an empty answer.
    const missing = await modern(server, 'resources/read', { uri: 'ui://demo/other.html' })
    assert.ok(missing.message.error, JSON.stringify(missing.message))
  })
})

test('trip_board: resources/list names the app, with its type and policy', async () => {
  await withServer(async (server) => {
    const { resources } = (await modern(server, 'resources/list')).message.result
    assert.equal(resources.length, 1)
    assert.equal(resources[0].uri, TRIP_BOARD_URI)
    assert.equal(resources[0].mimeType, 'text/html;profile=mcp-app')
    assert.deepEqual(resources[0]._meta.ui.csp.connectDomains, [])
  })
})

test('trip_board: the app script compiles, and speaks the extension as the specification says', () => {
  const html = tripBoardHtml(`https://agent.dudko.dev${APP_DOCS_PATH}`)
  const code = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'))
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'trip-board.js' }))
  // The handshake, in its order, and the revision of the extension it names.
  const initialize = code.indexOf("request('ui/initialize'")
  const initialized = code.indexOf("notify('ui/notifications/initialized'")
  assert.ok(initialize > 0 && initialized > initialize)
  assert.match(code, /protocolVersion: '2026-01-26'/)
  assert.match(code, /appInfo: \{ name: 'trip-board', version: '1\.0\.0' \}/)
  // It declares full screen, and asks for it (and the way back) only through the extension.
  assert.match(code, /appCapabilities: \{ availableDisplayModes: \['inline', 'fullscreen'\] \}/)
  assert.match(code, /request\('ui\/request-display-mode', \{ mode: mode \}\)/)
  // A file to save and an answer of the host's model only where the host offers them: the
  // buttons stay hidden otherwise. Its sampling request asks for no tools, and little.
  assert.match(code, /\$\('download'\)\.hidden = !caps\.downloadFile/)
  assert.match(code, /hidden: !caps\.sampling/)
  assert.match(code, /b\.hidden = !caps\.sampling/)
  const sampling = code.slice(code.indexOf("request('sampling/createMessage'"))
  assert.match(sampling, /maxTokens: 120,/)
  assert.doesNotMatch(sampling.slice(0, 600), /tools|toolChoice/)
  assert.match(
    code,
    /request\('ui\/download-file', \{ contents: \[\{ type: 'resource', resource: \{ uri: 'file:\/\/\/' \+ name, mimeType: 'text\/plain'/,
  )
  // The model's answer is text in the page, never markup.
  assert.match(code, /\$\('idea-text'\)\.textContent = text/)
  // Text from the server is never markup: innerHTML takes the constant icons only.
  assert.deepEqual(
    [...code.matchAll(/innerHTML = (\w+)/g)].map(([, value]) => value),
    ['svg'],
  )
  // It talks to the window that framed it, and listens to that window only.
  assert.match(code, /event\.source !== host/)
  assert.doesNotMatch(code, /window\.top|top\.postMessage|localStorage|indexedDB|fetch\(/)
})

test('reshuffle_day: another plan for one day, computed from its inputs; a day out of the trip is an error', async () => {
  await withServer(async (server) => {
    const args = { destination: 'Lisbon', day: 2, days: 4, start: '2026-12-01' }
    const first = await modern(server, 'tools/call', call('reshuffle_day', { ...args, variant: 0 }))
    const next = await modern(server, 'tools/call', call('reshuffle_day', { ...args, variant: 1 }))
    const board = tripPlan({ ...LISBON } as never)
    // Variant 0 is the board's own plan for that day; the next one is another.
    assert.deepEqual(first.message.result.structuredContent, board.days[1])
    const other = next.message.result.structuredContent
    assert.deepEqual(other, tripDay('Lisbon', 2, 4, 1, '2026-12-01'))
    assert.notEqual(other.theme, board.days[1].theme)
    assert.equal(other.variant, 1)
    assert.equal(other.date, '2026-12-02')
    assert.match(textOf(next), new RegExp(`^Day 2, ${other.theme}: `))
    // Eight alternatives for a middle day, all different.
    const themes = new Set(Array.from({ length: 8 }, (_, v) => tripDay('Lisbon', 2, 4, v).theme))
    assert.equal(themes.size, 8)
    const outside = await modern(
      server,
      'tools/call',
      call('reshuffle_day', { ...args, day: 5, variant: 0 }),
    )
    assert.equal(outside.message.result.isError, true)
    assert.match(textOf(outside), /Day 5 is not in a trip of 4 days/)
  })
})

for (const era of ['modern', 'legacy'] as const) {
  test(`book_trip (${era}): a demo confirmation computed from the trip - the same trip, the same code`, async () => {
    await withServer(async (server) => {
      if (era === 'legacy') await initialize(server)
      const args = { ...LISBON, variants: [0, 1, 0, 0] }
      const first = await callOn(server, era, 'book_trip', args)
      const again = await callOn(server, era, 'book_trip', args)
      const value = first.message.result.structuredContent
      assert.equal(first.message.result.isError, undefined)
      assert.match(value.confirmation, /^DEMO-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
      assert.deepEqual(again.message.result.structuredContent, value)
      assert.deepEqual(value, {
        confirmation: bookingCode({ ...LISBON, end: '2026-12-04' } as never, [0, 1, 0, 0]),
        trip: { ...LISBON, end: '2026-12-04' },
        total: 1130,
        currency: 'EUR',
        demo: true,
      })
      assert.match(textOf(first), /^Demo booking DEMO-.+ Nothing was booked or charged/)
    })
  })
}

test('book_trip: every input is in the code; the case and the spaces of the place are not', async () => {
  const trip = { ...LISBON, end: '2026-12-04' } as never
  const code = bookingCode(trip, [0, 1, 0, 0])
  // Missing plans are the first ones.
  assert.equal(bookingCode(trip, [0, 1]), code)
  assert.equal(bookingCode({ ...LISBON, destination: '  lisbon ' } as never, [0, 1, 0, 0]), code)
  const others = [
    bookingCode(trip, [0, 0, 0, 0]),
    bookingCode({ ...LISBON, destination: 'Porto' } as never, [0, 1, 0, 0]),
    bookingCode({ ...LISBON, start: '2026-12-02' } as never, [0, 1, 0, 0]),
    bookingCode({ ...LISBON, nights: 4 } as never, [0, 1, 0, 0]),
    bookingCode({ ...LISBON, travellers: 3 } as never, [0, 1, 0, 0]),
    bookingCode({ ...LISBON, budget: 'luxury' } as never, [0, 1, 0, 0]),
  ]
  assert.equal(new Set([code, ...others]).size, others.length + 1)
  await withServer(async (server) => {
    // More plans than days, and arguments past the element bound, are refused.
    const extra = await modern(
      server,
      'tools/call',
      call('book_trip', { ...LISBON, variants: [0, 0, 0, 0, 0] }),
    )
    assert.equal(extra.message.result.isError, true)
    const huge = await modern(
      server,
      'tools/call',
      call('book_trip', {
        ...LISBON,
        variants: Array.from({ length: DEMO_LIMITS.toolInputElements }, () => 0),
      }),
    )
    assert.equal(huge.message.result.isError, true)
    assert.match(textOf(huge), /maximum of 64 elements/)
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
    // A declared length over the bound is refused before a byte is read.
    let read0 = 0
    // (No high-water mark: the stream is pulled only when somebody reads it.)
    const unread = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read0 += 1
          controller.enqueue(encoder.encode('{}'))
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const early = await server.fetch(
      new Request(URL_ON_SITE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(DEMO_LIMITS.requestBytes + 1),
        },
        body: unread,
        duplex: 'half',
      } as RequestInit),
    )
    assert.equal(early.status, 413)
    assert.equal(read0, 0)
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
      await modern(server, 'tools/call', call('trip_board', { destination: 'SECRET-PLACE-1' }))
      await modern(
        server,
        'tools/call',
        call('book_trip', {
          destination: 'SECRET-PLACE-2',
          nights: 2,
          travellers: 1,
          budget: 'luxury',
          variants: [1, 2, 3, 4],
        }),
      )
      await modern(server, 'resources/read', { uri: 'ui://demo/SECRET.html' })
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
