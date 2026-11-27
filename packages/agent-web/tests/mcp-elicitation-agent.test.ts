import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startLocalMcpServer, type ILocalMcpServer } from '@dudko.dev/test-servers'
import {
  createAgent,
  createSubagentTool,
  serveSubagentWorker,
  SPAWN_SUBAGENT_TOOL,
  type Agent,
  type AgentEvent,
  type BrowserAgentConfig,
  type RunSnapshot,
} from '../dist/index.js'
import {
  connectMcpHttp,
  type ConnectedMcp,
  type McpElicitationHandler,
  type McpElicitationOptions,
  type McpElicitationRequest,
} from '../dist/mcp.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'
import { useVirtualTime } from './helpers/virtual-time.ts'

// MCP elicitation inside a whole agent: a scripted model, the real MCP test
// server over real sockets (both revisions), nothing stubbed in between. What is
// asserted here is where the user's answer does NOT go - the model's context,
// events, logs, run checkpoints - and who may ask: the run, not its helpers.
// The Node sibling's `tests/mcp-elicitation-integration.test.ts`.

type Era = 'legacy' | 'modern'

/** A value no prompt, schema or server text contains: if it shows up, the agent put it there. */
const SECRET = 'S3CR3T-answer-9b2e'
/** The test server's question and the titles of its form: third-party text. */
const SERVER_TEXT = ['Fill in the profile', 'Your name', 'Portuguese', 'Toppings']

const planJson = JSON.stringify({ thought: 'Plan.', steps: [{ description: 'Step s1' }] })

/** The tool results a call's conversation already holds, as the model was shown them. */
const resultsOf = (info: CallInfo): string[] =>
  ((info.options.prompt ?? []) as { role: string; content: unknown }[])
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content as { type: string; output?: { value?: unknown } }[])
    .filter((p) => p.type === 'tool-result')
    .map((p) =>
      typeof p.output?.value === 'string' ? p.output.value : JSON.stringify(p.output?.value),
    )

/** Whose call it is: the run's own, or the helper whose task carries [[A]]. */
const isHelper = (info: CallInfo): boolean => {
  const from = info.user.indexOf('GOAL: ')
  const own = (from < 0 ? info.user : info.user.slice(from)).split('\n\n')[0]
  return own.includes('[[A]]')
}

type Calls = { name: string; args: unknown }[]

/** Plans one step, calls its tools in the first round, then reports what came back. */
const actor =
  (calls: Calls) =>
  (info: CallInfo): Reply => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: planJson }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'finish', reason: 'done' }) }
      case 'synthesizer':
        return { text: 'All done.' }
      default:
        return info.toolResults === 0 && calls.length
          ? { toolCalls: calls }
          : { text: `results: ${resultsOf(info).join(' | ')}` }
    }
  }

interface Rig {
  server: ILocalMcpServer
  mcp: ConnectedMcp
  agent: Agent
  calls: CallInfo[]
  events: AgentEvent[]
  asked: McpElicitationRequest[]
  snapshots: RunSnapshot[]
  logs: string[]
}

const withAgent = async (
  era: Era,
  setup: {
    root: Calls
    helper?: Calls
    onElicitation?: McpElicitationHandler
    elicitation?: McpElicitationOptions
    config?: (mcp: ConnectedMcp) => Partial<BrowserAgentConfig>
    /** Leave the MCP tools out of the agent's own tool set (a subagent gets them instead). */
    withoutMcpTools?: boolean
  },
  body: (rig: Rig) => Promise<void>,
): Promise<void> => {
  const server = await startLocalMcpServer({ protocol: era, elicitationTools: true })
  const logs: string[] = []
  const asked: McpElicitationRequest[] = []
  const handler = setup.onElicitation
  const mcp = await connectMcpHttp(
    { wx: { url: server.url, ...(era === 'modern' ? { protocol: 'modern' as const } : {}) } },
    {
      onLog: (level, message) => logs.push(`mcp ${level} ${message}`),
      ...(handler
        ? {
            onElicitation: (request, ctx) => {
              asked.push(request)
              return handler(request, ctx)
            },
          }
        : {}),
      ...(setup.elicitation ? { elicitation: setup.elicitation } : {}),
    },
  )
  const root = actor(setup.root)
  const helper = actor(setup.helper ?? [])
  const model = scriptedModel((info) => (isHelper(info) ? helper(info) : root(info)))
  const snapshots: RunSnapshot[] = []
  const keep = (snapshot: RunSnapshot): void => {
    // As a store would: serialised at the moment it is handed over.
    snapshots.push(JSON.parse(JSON.stringify(snapshot)) as RunSnapshot)
  }
  const sink = Object.fromEntries(
    (['debug', 'info', 'warn', 'error'] as const).map((level) => [
      level,
      (...args: unknown[]) => {
        logs.push(
          `agent ${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
        )
      },
    ]),
  )
  const events: AgentEvent[] = []
  try {
    const extra = setup.config?.(mcp) ?? {}
    const agent = await createAgent({
      model: model.model,
      toolMode: 'native',
      logLevel: 'debug',
      logger: sink as never,
      persistence: { onRunStart: keep, onStepComplete: keep, onRunComplete: keep },
      ...extra,
      tools: { ...(setup.withoutMcpTools ? {} : mcp.tools), ...extra.tools },
    })
    await body({ server, mcp, agent, calls: model.calls, events, asked, snapshots, logs })
  } finally {
    await mcp.close()
    await server.close()
  }
}

const go = (rig: Rig, opts: Parameters<Agent['run']>[1] = {}) =>
  rig.agent.run('Do the work', { onEvent: (e) => rig.events.push(e), ...opts })

/** Every event of a run, the helpers' and children's unwrapped. */
const flatten = (events: AgentEvent[]): AgentEvent[] =>
  events.flatMap((e) => (e.type === 'subagent.event' ? [e, ...flatten([e.event])] : [e]))

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  flatten(events).filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

const errorOf = (output: unknown): string =>
  output instanceof Error
    ? output.message
    : typeof output === 'string'
      ? output
      : JSON.stringify(output)

const ACCEPT_PROFILE: McpElicitationHandler = () => ({
  action: 'accept',
  content: { name: 'Ada', email: 'a@b.test' },
})

for (const era of ['legacy', 'modern'] as Era[]) {
  // ── the answer goes to the server, and nowhere else ──────────────────────

  test(`${era}: a run answers a server's form; the answer is in no prompt, event, log or checkpoint`, async (t) => {
    const consoleLines: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      t.mock.method(console, method, (...args: unknown[]) => {
        consoleLines.push(args.map(String).join(' '))
      })
    }
    await withAgent(
      era,
      {
        root: [{ name: 'wx__elicit_form', args: {} }],
        onElicitation: () => ({
          action: 'accept',
          content: { name: SECRET, email: `${SECRET}@example.test`, toppings: ['basil'] },
        }),
      },
      async (rig) => {
        // The server leaves the answers out of its result: anything found is the agent's doing.
        rig.server.elicitationFaults.quietResult = true
        const result = await go(rig)

        assert.equal(result.final, 'All done.')
        const call = result.trace[0].toolCalls[0]
        assert.deepEqual(
          [call.name, call.ok, call.output],
          ['wx__elicit_form', true, JSON.stringify({ tool: 'elicit_form', action: 'accept' })],
        )
        // ONE call on the server, whatever it took on the wire.
        assert.deepEqual(rig.server.calls, [{ name: 'elicit_form', args: {} }])
        // The answer did arrive.
        assert.ok(JSON.stringify(rig.server.elicitations).includes(SECRET))

        assert.equal(rig.asked.length, 1)
        assert.equal(rig.asked[0].tool, 'wx__elicit_form')
        assert.equal(rig.asked[0].server, 'wx')
        assert.equal(rig.asked[0].subagent, undefined)
        assert.match(rig.asked[0].runId ?? '', /\S/)

        // The two events sit between the tool's call and its result, and carry the step.
        const order = rig.events
          .map((e) => e.type)
          .filter((type) => type.startsWith('mcp.') || type.startsWith('step.tool'))
        assert.deepEqual(order, [
          'step.tool-call',
          'mcp.elicitation-requested',
          'mcp.elicitation-answered',
          'step.tool-result',
        ])
        const [requested] = of(rig.events, 'mcp.elicitation-requested')
        const [answered] = of(rig.events, 'mcp.elicitation-answered')
        assert.equal(requested.id, rig.asked[0].id)
        assert.equal(requested.step?.description, 'Step s1')
        assert.equal(requested.message, 'Fill in the profile')
        assert.equal(requested.requestedSchema?.properties.name.title, 'Name')
        // seq / attempt: its place in the run's events (a number of every event of a run).
        assert.equal(answered.attempt, 1)
        assert.equal(typeof answered.seq, 'number')
        assert.deepEqual(
          { ...answered, id: '', seq: 0, attempt: 0 },
          {
            type: 'mcp.elicitation-answered',
            id: '',
            seq: 0,
            attempt: 0,
            server: 'wx',
            tool: 'wx__elicit_form',
            action: 'accept',
            automatic: false,
            fields: ['name', 'email', 'toppings'],
          },
        )

        // Nowhere but on its way to the server:
        const everywhere: [string, unknown][] = [
          ["the model's context", rig.calls.map((c) => c.options.prompt)],
          ['the events', rig.events],
          ['the run checkpoints', rig.snapshots],
          ['the run result', result],
          ["the logs (the agent's and the connector's)", rig.logs],
          ['the console', consoleLines],
        ]
        for (const [where, value] of everywhere) {
          assert.equal(JSON.stringify(value).includes(SECRET), false, `the answer is in ${where}`)
        }
        assert.ok(rig.snapshots.length >= 2, 'no checkpoint was taken')
        assert.ok(
          rig.logs.some((l) => l.startsWith('agent ')),
          'the agent logged nothing',
        )

        // And the server's own text reached the host and the event - never a prompt.
        const prompts = JSON.stringify(rig.calls.map((c) => c.options.prompt))
        for (const text of SERVER_TEXT) {
          assert.equal(prompts.includes(text), false, `"${text}" is in the model's context`)
        }
        assert.equal(JSON.stringify(rig.snapshots).includes('Fill in the profile'), false)
      },
    )
  })

  test(`${era}: a failed question says why to the model, without the answer`, async () => {
    await withAgent(
      era,
      {
        root: [{ name: 'wx__elicit_form', args: {} }],
        // Not what the form asks for: the email is no email.
        onElicitation: () => ({ action: 'accept', content: { name: 'Ada', email: SECRET } }),
      },
      async (rig) => {
        const result = await go(rig)
        const call = result.trace[0].toolCalls[0]
        assert.equal(call.ok, false)
        assert.match(
          errorOf(call.output),
          /did not finish: the server asked the user for input, and the answer did not fit the form \(field "email" is not a valid email\) and was not sent/,
        )
        const seen = rig.calls.flatMap((c) => resultsOf(c)).join('\n')
        assert.match(
          seen,
          /The call was not repeated; do not call the tool again only because of this/,
        )
        assert.equal(
          JSON.stringify([
            rig.calls.map((c) => c.options.prompt),
            rig.events,
            rig.snapshots,
            rig.logs,
          ]).includes(SECRET),
          false,
        )
        assert.deepEqual(rig.server.calls, [{ name: 'elicit_form', args: {} }])
        assert.equal(JSON.stringify(rig.server.elicitations).includes(SECRET), false)
      },
    )
  })

  // ── who may ask ───────────────────────────────────────────────────────────

  const spawnHelper = (tool: string): Calls => [
    { name: SPAWN_SUBAGENT_TOOL, args: { task: '[[A]] Fill in the form', tools: [tool] } },
  ]

  test(`${era}: a helper the model started cannot ask the user`, async () => {
    await withAgent(
      era,
      {
        root: spawnHelper('wx__elicit_form'),
        helper: [{ name: 'wx__elicit_form', args: {} }],
        onElicitation: ACCEPT_PROFILE,
        config: () => ({ subagents: { dynamic: { defaultTools: 'all' } } }),
      },
      async (rig) => {
        await go(rig)
        assert.equal(rig.asked.length, 0, 'a helper put a question to the user')
        assert.equal(of(rig.events, 'mcp.elicitation-requested').length, 0)
        const [answered] = of(rig.events, 'mcp.elicitation-answered')
        assert.deepEqual(
          [answered.action, answered.automatic, answered.reason],
          ['cancel', true, 'subagent'],
        )
        const helperSaw = rig.calls
          .filter(isHelper)
          .flatMap((c) => resultsOf(c))
          .join('\n')
        assert.match(
          helperSaw,
          /a helper is not allowed to ask the user \(elicitation\.subagents\)/,
        )
        assert.equal(
          JSON.stringify(rig.server.elicitations).includes('"accept"'),
          false,
          'the server was given an answer',
        )
        assert.deepEqual(rig.server.calls, [{ name: 'elicit_form', args: {} }])
      },
    )
  })

  test(`${era}: ... unless the connection passes it through (elicitation.subagents), and then the request says who asks`, async () => {
    await withAgent(
      era,
      {
        root: spawnHelper('wx__elicit_form'),
        helper: [{ name: 'wx__elicit_form', args: {} }],
        onElicitation: ACCEPT_PROFILE,
        elicitation: { subagents: true },
        config: () => ({ subagents: { dynamic: { defaultTools: 'all' } } }),
      },
      async (rig) => {
        await go(rig)
        assert.equal(rig.asked.length, 1)
        const [start] = of(rig.events, 'subagent.start')
        assert.deepEqual(rig.asked[0].subagent, { id: start.id, depth: 1 })
        const [requested] = of(rig.events, 'mcp.elicitation-requested')
        assert.deepEqual(requested.subagent, { id: start.id, depth: 1 })
        assert.deepEqual(rig.server.calls, [{ name: 'elicit_form', args: {} }])
      },
    )
  })

  test(`${era}: a helper's questions count on the run that started it (maxPerRun)`, async () => {
    await withAgent(
      era,
      {
        root: [{ name: 'wx__elicit_state', args: {} }, ...spawnHelper('wx__elicit_state')],
        helper: [{ name: 'wx__elicit_state', args: {} }],
        onElicitation: () => ({ action: 'accept', content: { confirm: true } }),
        elicitation: { subagents: true, maxPerRun: 1 },
        config: () => ({ subagents: { dynamic: { defaultTools: 'all' } } }),
      },
      async (rig) => {
        await go(rig)
        assert.equal(rig.asked.length, 1, 'the cap is per run, helpers included')
        const reasons = of(rig.events, 'mcp.elicitation-answered').map((e) => e.reason ?? 'host')
        assert.deepEqual(reasons.sort(), ['cap-per-run', 'host'])
      },
    )
  })

  // A subagent tool: the child calls the MCP tool it was given, three ways.
  const childModel = () =>
    scriptedModel((info) => actor([{ name: 'wx__elicit_form', args: {} }])(info))

  const staticSubagent = (
    kind: 'own tools' | 'host tools' | 'worker',
    mcp: ConnectedMcp,
    child: ReturnType<typeof childModel>,
    opened: MessagePort[],
  ) => {
    const tools = { wx__elicit_form: mcp.tools.wx__elicit_form }
    if (kind === 'own tools') {
      // The host hands the child the very tool objects the parent has.
      return createSubagentTool({
        name: 'researcher',
        description: 'Delegate a task',
        config: { model: child.model, toolMode: 'native', tools },
      })
    }
    if (kind === 'host tools') {
      return createSubagentTool({
        name: 'researcher',
        description: 'Delegate a task',
        config: { model: child.model, toolMode: 'native' },
        tools,
      })
    }
    return createSubagentTool({
      name: 'researcher',
      description: 'Delegate a task',
      worker: () => {
        const channel = new MessageChannel()
        opened.push(channel.port1, channel.port2)
        serveSubagentWorker({ scope: channel.port2, resolveModel: () => child.model })
        channel.port1.start()
        channel.port2.start()
        return Object.assign(channel.port1, {
          terminate: () => {
            channel.port1.close()
            channel.port2.close()
          },
        })
      },
      workerConfig: {
        model: { providerType: 'openai', model: 'x', apiKey: 'k' },
        toolMode: 'native',
      },
      tools,
    })
  }

  for (const kind of ['own tools', 'host tools', 'worker'] as const) {
    test(`${era}: a subagent (${kind}) cannot ask the user through the parent's connection`, async () => {
      const child = childModel()
      const opened: MessagePort[] = []
      await withAgent(
        era,
        {
          root: [{ name: 'researcher', args: { task: 'Fill in the form' } }],
          onElicitation: ACCEPT_PROFILE,
          withoutMcpTools: true,
          config: (mcp) => ({ tools: { researcher: staticSubagent(kind, mcp, child, opened) } }),
        },
        async (rig) => {
          const result = await go(rig)
          assert.equal(result.trace[0].toolCalls[0].name, 'researcher')
          assert.ok(child.calls.length > 0, 'the child never ran')
          assert.equal(rig.asked.length, 0, 'a subagent put a question to the user')
          const childSaw = child.calls.flatMap((c) => resultsOf(c)).join('\n')
          assert.match(
            childSaw,
            /a helper is not allowed to ask the user \(elicitation\.subagents\)/,
          )
          assert.equal(JSON.stringify(rig.server.elicitations).includes('"accept"'), false)
          assert.deepEqual(rig.server.calls, [{ name: 'elicit_form', args: {} }])
          for (const port of opened) port.close()
        },
      )
    })

    test(`${era}: a subagent (${kind}) may, once the connection says so`, async () => {
      const child = childModel()
      const opened: MessagePort[] = []
      await withAgent(
        era,
        {
          root: [{ name: 'researcher', args: { task: 'Fill in the form' } }],
          onElicitation: ACCEPT_PROFILE,
          elicitation: { subagents: true },
          withoutMcpTools: true,
          config: (mcp) => ({ tools: { researcher: staticSubagent(kind, mcp, child, opened) } }),
        },
        async (rig) => {
          await go(rig)
          assert.equal(rig.asked.length, 1)
          const [start] = of(rig.events, 'subagent.start')
          assert.deepEqual(rig.asked[0].subagent, { id: start.id, depth: 1 })
          assert.deepEqual(rig.server.calls, [{ name: 'elicit_form', args: {} }])
          for (const port of opened) port.close()
        },
      )
    })
  }

  test(`${era}: a subagent's questions count on the run that delegated to it (maxPerRun)`, async () => {
    const child = scriptedModel((info) => actor([{ name: 'wx__elicit_state', args: {} }])(info))
    await withAgent(
      era,
      {
        root: [
          { name: 'wx__elicit_state', args: {} },
          { name: 'researcher', args: { task: 'Confirm it' } },
        ],
        onElicitation: () => ({ action: 'accept', content: { confirm: true } }),
        elicitation: { subagents: true, maxPerRun: 1 },
        config: (mcp) => ({
          tools: {
            researcher: createSubagentTool({
              name: 'researcher',
              description: 'Delegate a task',
              config: { model: child.model, toolMode: 'native' },
              tools: { wx__elicit_state: mcp.tools.wx__elicit_state },
            }),
          },
        }),
      },
      async (rig) => {
        await go(rig)
        assert.ok(child.calls.length > 0, 'the child never ran')
        assert.equal(rig.asked.length, 1, 'the cap is per run, subagents included')
        const reasons = of(rig.events, 'mcp.elicitation-answered').map((e) => e.reason ?? 'host')
        assert.deepEqual(reasons.sort(), ['cap-per-run', 'host'])
      },
    )
  })

  // ── time ──────────────────────────────────────────────────────────────────

  test(`${era}: the step's limit does not end a question - the question's own bound does, and says so`, async (t) => {
    // The step's limit runs on virtual time (helpers/virtual-time.ts), the question's own bound
    // on real time: while the question waits, three times the step's limit passes, and the step's
    // limit stops meanwhile (wait-clock.ts) - it is the question's bound that ends the wait.
    const vt = useVirtualTime(t)
    let stopped: boolean | undefined
    let hostSignal: AbortSignal | undefined
    await withAgent(
      era,
      {
        root: [{ name: 'wx__elicit_form', args: {} }],
        onElicitation: async (_request, ctx) => {
          hostSignal = ctx.signal
          stopped = await vt.stopped()
          vt.tick(3 * 10_000)
          return new Promise(() => {})
        },
        elicitation: { timeoutMs: 300 },
        // Also the planner's and synthesizer's bound, in real time: ample on any machine.
        config: () => ({ chatTimeoutMs: 10_000 }),
      },
      async (rig) => {
        const result = await go(rig)
        assert.equal(stopped, true, "the step's limit ran on while the question waited")
        assert.equal(hostSignal?.aborted, true, 'the host was not told the wait is over')
        const [answered] = of(rig.events, 'mcp.elicitation-answered')
        assert.deepEqual(
          [answered.action, answered.automatic, answered.reason],
          ['cancel', true, 'timeout'],
        )
        // The call failed for that reason, and the step reported it: it was not cut.
        const [call] = result.trace.flatMap((s) => s.toolCalls)
        assert.deepEqual([call.name, call.ok], ['wx__elicit_form', false])
        assert.match(
          errorOf(call.output),
          /nobody answered within 300 ms \(elicitation\.timeoutMs\)/,
        )
        assert.equal(result.final, 'All done.')
        assert.deepEqual(rig.server.calls, [{ name: 'elicit_form', args: {} }])
      },
    )
  })

  test(`${era}: stopping the run cancels the question`, async () => {
    let hostSignal: AbortSignal | undefined
    const controller = new AbortController()
    await withAgent(
      era,
      {
        root: [{ name: 'wx__elicit_form', args: {} }],
        onElicitation: (_request, ctx) => {
          hostSignal = ctx.signal
          setTimeout(() => controller.abort(), 20)
          return new Promise(() => {})
        },
      },
      async (rig) => {
        const result = await go(rig, { signal: controller.signal }).catch(() => undefined)
        assert.equal(result === undefined || result.stopped, true)
        assert.equal(hostSignal?.aborted, true)
        const [answered] = of(rig.events, 'mcp.elicitation-answered')
        assert.deepEqual(
          [answered.action, answered.automatic, answered.reason],
          ['cancel', true, 'aborted'],
        )
        assert.deepEqual(rig.server.calls, [{ name: 'elicit_form', args: {} }])
      },
    )
  })
}

// ── the link is never opened here ───────────────────────────────────────────

test('nothing in the built package opens or fetches a link a server sent', () => {
  // URL mode hands the link to the host's callback. The connector's bundle has
  // no window.open and no navigation; its only fetches are the transport's.
  for (const file of ['../dist/mcp.js', '../dist/mcp.cjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.equal(
      /window\.open\s*\(|\.open\(\s*request\.url|location\.assign\(/.test(source),
      false,
      file,
    )
  }
  const shared = readFileSync(new URL('../src/mcp/elicitation.ts', import.meta.url), 'utf8')
  assert.equal(/\bfetch\(|window\.|location\.|document\./.test(shared), false)
})
