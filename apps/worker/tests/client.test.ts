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
import { DEMO_TOOL_NAMES, DOCS_PATH } from '../src/tools.ts'

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
) => {
  const server = await listen()
  const logs: string[] = []
  const mcp = await connectMcpHttp(
    { demo: { url: server.url, ...(protocol ? { protocol } : {}) } },
    {
      clientName: 'worker-test',
      onLog: (level, message) => logs.push(`${level} ${message}`),
      ...(onElicitation ? { onElicitation, elicitation: { url: true } } : {}),
    },
  )
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const tool = mcp.tools[`demo__${name}`] as unknown as { execute: Execute }
    try {
      const value = await tool.execute(args, { agentRun: { emit: () => {} } })
      return typeof value === 'string' ? value : JSON.stringify(value)
    } catch (err) {
      return `threw: ${String(err)}`
    }
  }
  return {
    mcp,
    logs,
    call,
    origin: new URL(server.url).origin,
    close: async () => {
      await mcp.close()
      await server.close()
    },
  }
}

test('auto: the 2026-07-28 revision, the five tools, the instructions', async () => {
  const demo = await connect('auto')
  try {
    assert.deepEqual(demo.mcp.results, [{ name: 'demo', connected: true }])
    assert.deepEqual(demo.mcp.protocols, [{ server: 'demo', version: '2026-07-28', era: 'modern' }])
    assert.deepEqual(
      demo.mcp.catalog.map((t) => [t.name, t.readOnly]),
      DEMO_TOOL_NAMES.map((name) => [`demo__${name}`, true]),
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
