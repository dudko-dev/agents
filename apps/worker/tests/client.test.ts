import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import {
  connectMcpHttp,
  type McpElicitationHandler,
  type McpElicitationRequest,
} from '@dudko.dev/agent-web/mcp'
import { DEMO_INSTRUCTIONS } from '../src/demo-server.ts'
import { demoMcpMiddleware } from '../src/node.ts'
import { DEMO_SKILL_FILES, DEMO_SKILL_URIS } from '../src/skills.ts'
import { DEMO_TOOL_NAMES, DOCS_PATH } from '../src/tools.ts'
import { APP_ONLY_TOOLS, bookingCode, TRIP_BOARD_URI } from '../src/trip-board.ts'

// The demo server as the demo's own client meets it: `connectMcpHttp` of @dudko.dev/agent-web
// (the official 2.x client SDK inside) over a real socket, through the Node adapter that `vite
// dev` / `vite preview` mount (`src/node.ts`). One server per test, on loopback.

const listen = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const middleware = demoMcpMiddleware()
  const server: Server = createServer((req, res) =>
    middleware(req, res, () => {
      res.writeHead(404)
      res.end()
    }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp/demo`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const TRIP = {
  destination: 'Kyoto',
  start: '2027-04-02',
  nights: 5,
  travellers: 1,
  budget: 'shoestring',
  flexible: false,
}

type Execute = (args: unknown, options: unknown) => Promise<unknown>

const connect = async (
  protocol: 'legacy' | 'auto' | undefined,
  onElicitation?: McpElicitationHandler,
  apps = false,
) => {
  const server = await listen()
  const logs: string[] = []
  const events: { type: string }[] = []
  const mcp = await connectMcpHttp(
    { demo: { url: server.url, ...(protocol ? { protocol } : {}) } },
    {
      clientName: 'worker-test',
      onLog: (level, message) => logs.push(`${level} ${message}`),
      ...(onElicitation ? { onElicitation, elicitation: { url: true } } : {}),
      ...(apps ? { apps: true } : {}),
    },
  )
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const tool = mcp.tools[`demo__${name}`] as unknown as { execute: Execute }
    try {
      const value = await tool.execute(args, {
        agentRun: { emit: (event: { type: string }) => events.push(event) },
      })
      return typeof value === 'string' ? value : JSON.stringify(value)
    } catch (err) {
      return `threw: ${String(err)}`
    }
  }
  return {
    mcp,
    logs,
    events,
    call,
    origin: new URL(server.url).origin,
    close: async () => {
      await mcp.close()
      await server.close()
    },
  }
}

test('auto: the 2026-07-28 revision, every tool (no MCP Apps: the app tools too), the instructions', async () => {
  const demo = await connect('auto')
  try {
    assert.deepEqual(demo.mcp.results, [{ name: 'demo', connected: true }])
    assert.deepEqual(demo.mcp.protocols, [{ server: 'demo', version: '2026-07-28', era: 'modern' }])
    assert.deepEqual(
      demo.mcp.catalog.map((t) => [t.name, t.readOnly === true]),
      DEMO_TOOL_NAMES.map((name) => [`demo__${name}`, name !== 'book_trip']),
    )
    assert.deepEqual(
      demo.mcp.instructions.map((i) => [i.server, i.instructions]),
      [['demo', DEMO_INSTRUCTIONS]],
    )
    const dice = JSON.parse(await demo.call('roll_dice', { count: 3, sides: 4 }))
    assert.equal(JSON.stringify(dice).includes('"sides":4'), true)
  } finally {
    await demo.close()
  }
})

test('auto + onElicitation: plan_trip shows the form and the answer reaches the server', async () => {
  const asked: McpElicitationRequest[] = []
  const demo = await connect('auto', (request) => {
    asked.push(request)
    return { action: 'accept', content: TRIP }
  })
  try {
    const result = await demo.call('plan_trip', { destination: 'Kyoto' })
    assert.match(
      result,
      /Trip to Kyoto: 5 nights from 2027-04-02 to 2027-04-07, 1 traveller, shoestring budget, fixed dates\./,
    )
    assert.equal(asked.length, 1)
    const [question] = asked
    assert.equal(question?.mode, 'form')
    assert.equal(question?.tool, 'demo__plan_trip')
    assert.deepEqual(Object.keys(question?.requestedSchema?.properties ?? {}), [
      'destination',
      'start',
      'nights',
      'travellers',
      'budget',
      'flexible',
    ])
    assert.equal(question?.requestedSchema?.properties.destination?.default, 'Kyoto')
  } finally {
    await demo.close()
  }
})

test('auto + onElicitation: open_docs hands over a link on the server origin, and a no', async () => {
  const asked: McpElicitationRequest[] = []
  const demo = await connect('auto', (request) => {
    asked.push(request)
    return { action: 'decline' }
  })
  try {
    const result = await demo.call('open_docs')
    assert.match(result, /did not open the page \(decline\)/)
    assert.equal(asked[0]?.mode, 'url')
    // The link is on the origin the request was sent to: here the loopback server.
    assert.equal(asked[0]?.url, `${demo.origin}${DOCS_PATH}`)
  } finally {
    await demo.close()
  }
})

test('2025 (the client default): plain tools work; a question is an error that names the revision', async () => {
  const demo = await connect(undefined, () => ({ action: 'accept', content: TRIP }))
  try {
    assert.equal(demo.mcp.protocols[0]?.era, 'legacy')
    assert.match(await demo.call('echo', { text: 'over 2025' }), /over 2025/)
    assert.match(await demo.call('plan_trip'), /2026-07-28/)
  } finally {
    await demo.close()
  }
})

const LISBON = {
  destination: 'Lisbon',
  start: '2026-12-01',
  nights: 3,
  travellers: 2,
  budget: 'comfortable',
}

for (const protocol of ['auto', 'legacy'] as const) {
  test(`apps: true (${protocol}): the app tools are not the model's; the app is read, and calls them`, async () => {
    const demo = await connect(protocol, undefined, true)
    try {
      assert.equal(demo.mcp.protocols[0]?.era, protocol === 'auto' ? 'modern' : 'legacy')
      // The model's tools: all but the two that are for the app only.
      assert.deepEqual(
        demo.mcp.catalog.map((t) => t.name),
        DEMO_TOOL_NAMES.filter((n) => !(APP_ONLY_TOOLS as readonly string[]).includes(n)).map(
          (n) => `demo__${n}`,
        ),
      )
      for (const name of APP_ONLY_TOOLS) assert.equal(demo.mcp.tools[`demo__${name}`], undefined)
      assert.deepEqual(
        demo.mcp.catalog.filter((t) => t.app).map((t) => [t.name, t.app]),
        [['demo__trip_board', TRIP_BOARD_URI]],
      )
      const apps = demo.mcp.apps
      assert.ok(apps)
      // The model's call comes with the event a host draws the app from.
      await demo.call('trip_board', LISBON)
      const event = demo.events.find((e) => e.type === 'mcp.app') as any
      assert.equal(event.resourceUri, TRIP_BOARD_URI)
      assert.equal(event.toolName, 'trip_board')
      assert.equal(event.result.structuredContent.trip.destination, 'Lisbon')
      // The app's document, as the core checks it: the MIME type, no origin to reach.
      const resource = await apps.readUiResource('demo', TRIP_BOARD_URI)
      assert.match(resource.html, /^<!doctype html>/)
      assert.ok(resource.html.includes(JSON.stringify(`${demo.origin}/docs/browser/`).slice(0, -1)))
      assert.deepEqual(resource.csp, {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      })
      assert.deepEqual(resource.refusedDomains, [])
      assert.deepEqual(resource.permissions, {})
      // The app may call its two tools: one a write, as far as the host knows (it asks first).
      assert.equal(apps.appTool('demo', 'book_trip')?.readOnly, false)
      assert.deepEqual(apps.appTool('demo', 'book_trip')?.visibility, ['app'])
      assert.equal(apps.appTool('demo', 'reshuffle_day')?.readOnly, true)
      const booked = await apps.callAppTool('demo', 'book_trip', { ...LISBON, variants: [0, 2] })
      assert.equal(
        (booked.structuredContent as { confirmation: string }).confirmation,
        bookingCode({ ...LISBON, end: '2026-12-04' } as never, [0, 2]),
      )
      const day = await apps.callAppTool('demo', 'reshuffle_day', {
        destination: 'Lisbon',
        day: 3,
        days: 4,
        variant: 1,
      })
      assert.equal((day.structuredContent as { day: number }).day, 3)
    } finally {
      await demo.close()
    }
  })
}

// ── skills (`skills: true`, experimental) ───────────────────────────────────

/** A server's skills as the agent finds them on its tools (`collectMcpSkillSources` reads this). */
interface SkillSourceOnTool {
  server: string
  skills: { uri: string; name: string; description: string; path: string[]; files: string[] }[]
  load: (uri: string) => Promise<{ uri: string; body: string; files: readonly string[] }>
  readFile: (loaded: { uri: string }, path: string) => Promise<string>
}

// The mark is a symbol of the global registry (so that it holds across bundles): `markMcpSkills`
// in @dudko.dev/agent-web's `mcp/skills.ts`.
const SKILLS_MARK = Symbol.for('@dudko.dev/agent:mcp-skills')

const connectWithSkills = async (protocol: 'auto' | 'legacy') => {
  const server = await listen()
  const logs: string[] = []
  const methods: string[] = []
  const recording: typeof fetch = (input, init) => {
    if (typeof init?.body === 'string') {
      try {
        methods.push(String(JSON.parse(init.body).method))
      } catch {
        /* not JSON */
      }
    }
    return fetch(input, init)
  }
  const mcp = await connectMcpHttp(
    { demo: { url: server.url, protocol, skills: true, fetch: recording } },
    { clientName: 'worker-test', onLog: (level, message) => logs.push(`${level} ${message}`) },
  )
  const source = (mcp.tools.demo__echo as unknown as Record<symbol, unknown>)[SKILLS_MARK] as
    SkillSourceOnTool | undefined
  return {
    mcp,
    logs,
    methods,
    source,
    close: async () => {
      await mcp.close()
      await server.close()
    },
  }
}

test('skills: true (auto): the demo client lists both skills, loads one and reads its file, verified', async () => {
  const demo = await connectWithSkills('auto')
  try {
    assert.equal(demo.mcp.protocols[0]?.era, 'modern')
    // Every entry accepted: no refusal, no failed read.
    assert.ok(demo.logs.includes('info [mcp] demo: 2 skills listed'), demo.logs.join('\n'))
    assert.deepEqual(
      demo.logs.filter((l) => !l.startsWith('info')),
      [],
    )
    // Listed, nothing read yet (lazy retrieval).
    assert.ok(demo.methods.includes('skills/list'))
    assert.ok(!demo.methods.includes('resources/read'))
    const source = demo.source
    assert.ok(source, 'the tools carry the server skills')
    assert.equal(source.server, 'demo')
    assert.deepEqual(
      source.skills.map((s) => [s.uri, s.name, s.path.join('/'), s.files]),
      [
        [DEMO_SKILL_URIS[0], 'trip-planning', 'demo/trip-planning', ['references/checklist.md']],
        [DEMO_SKILL_URIS[1], 'dice-games', 'demo/dice-games', []],
      ],
    )
    // Loaded as the agent loads it: read and verified (size, digest, the frontmatter field by
    // field) by the SDK's skills client. A mismatch would throw here.
    const trip = await source.load(DEMO_SKILL_URIS[0] as string)
    const files = DEMO_SKILL_FILES['demo/trip-planning'] as Record<string, string>
    assert.ok(
      files['SKILL.md']?.endsWith(trip.body),
      'the body is the SKILL.md after its frontmatter',
    )
    assert.match(trip.body, /^\n# Trip planning with the demo server\n/)
    assert.deepEqual(trip.files, ['references/checklist.md'])
    assert.equal(
      await source.readFile(trip, 'references/checklist.md'),
      files['references/checklist.md'],
    )
    // Only a file the entry lists.
    await assert.rejects(source.readFile(trip, 'references/other.md'), /has no file/)
    const dice = await source.load(DEMO_SKILL_URIS[1] as string)
    assert.match(dice.body, /## Pig/)
    assert.match(dice.body, /## Yacht-lite/)
    assert.deepEqual(
      demo.logs.filter((l) => !l.startsWith('info')),
      [],
    )
  } finally {
    await demo.close()
  }
})

test('skills: true (legacy): the client asks for no skills, and none come with the tools', async () => {
  const demo = await connectWithSkills('legacy')
  try {
    assert.equal(demo.mcp.protocols[0]?.era, 'legacy')
    assert.equal(demo.source, undefined)
    assert.ok(!demo.methods.includes('skills/list'))
    assert.deepEqual(
      demo.mcp.catalog.map((t) => t.name),
      DEMO_TOOL_NAMES.map((n) => `demo__${n}`),
    )
  } finally {
    await demo.close()
  }
})

test('skills off (the default, auto): nothing of the extension is listed or read', async () => {
  const demo = await connect('auto')
  try {
    assert.equal(demo.mcp.protocols[0]?.era, 'modern')
    const marked = (demo.mcp.tools.demo__echo as unknown as Record<symbol, unknown>)[SKILLS_MARK]
    assert.equal(marked, undefined)
    assert.ok(!demo.logs.some((l) => l.includes('skills')), demo.logs.join('\n'))
  } finally {
    await demo.close()
  }
})
