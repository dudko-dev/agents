import { context, trace, type Span, type Tracer } from '@opentelemetry/api'
import assert from 'node:assert/strict'
import test from 'node:test'
import { startLocalMcpServer, type ILocalMcpServer } from '@dudko.dev/test-servers'
import {
  createAgent,
  createSubagentTool,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type IRunSnapshot,
  type McpElicitationHandler,
  type McpElicitationRequest,
} from '../src/index.ts'
import { SPAWN_SUBAGENT_TOOL } from '../src/subagent-dynamic-shared.ts'
import {
  startLocalOpenAI,
  systemOf,
  toolResults,
  userOf,
  type IChatRequest,
  type IScriptedReply,
  type Script,
} from './helpers/openai-server.ts'

// MCP elicitation inside a whole agent, over real sockets: a scripted
// OpenAI-compatible endpoint, the real MCP test server (both revisions) and
// nothing stubbed in between. What is asserted here is where the user's answer
// does NOT go - the model's context, events, logs, traces, run snapshots - and
// who may ask: the run, not its helpers.

type Era = 'legacy' | 'modern'

/** A value no prompt, schema or server text contains: if it shows up, the agent put it there. */
const SECRET = 'S3CR3T-answer-41c9'
/** The test server's question and the titles of its form: third-party text. */
const SERVER_TEXT = ['Fill in the profile', 'Your name', 'Portuguese', 'Toppings']

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}

const planJson = JSON.stringify({
  thought: 'Plan.',
  steps: [{ id: 's1', description: 'Step s1', expectedOutcome: 's1 done', suggestedTools: [] }],
})

/** Whose request it is: the run's own, or the helper whose task carries [[A]]. */
const isHelper = (req: IChatRequest): boolean =>
  /\[\[A\]\]/.test(userOf(req).split('\nOverall plan:')[0])

/** Every actor plans one step, calls its tools in the first round, then reports. */
const script =
  (calls: {
    root: { name: string; args: unknown }[]
    helper?: { name: string; args: unknown }[]
    child?: { name: string; args: unknown }[]
  }): Script =>
  (req): IScriptedReply => {
    const mine = systemOf(req).includes('CHILD AGENT')
      ? (calls.child ?? [])
      : isHelper(req)
        ? (calls.helper ?? [])
        : calls.root
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'finish', reason: 'done' }) }
      case 'synthesizer':
        return { text: 'All done.' }
      default:
        return toolResults(req).length === 0 && mine.length
          ? { toolCalls: mine }
          : { text: `results: ${toolResults(req).join(' | ')}` }
    }
  }

const baseConfig = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'elicitation-integration',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 3,
  maxStepsPerTask: 4,
  llmMaxRetries: 0,
  logLevel: 'debug',
  ...extra,
})

const serverConfig = (server: ILocalMcpServer, era: Era) => ({
  url: server.url,
  ...(era === 'modern' ? { protocol: 'modern' as const } : {}),
})

interface IHarness {
  llm: Awaited<ReturnType<typeof startLocalOpenAI>>
  server: ILocalMcpServer
  agent: IAgent
  events: AgentEvent[]
  asked: McpElicitationRequest[]
  snapshots: IRunSnapshot[]
}

const withAgent = async (
  era: Era,
  setup: {
    script: Script
    onElicitation?: McpElicitationHandler
    config?: (server: ILocalMcpServer, llmUrl: string) => Partial<IAgentConfig>
  },
  body: (h: IHarness) => Promise<void>,
): Promise<void> => {
  const server = await startLocalMcpServer({ protocol: era, elicitationTools: true })
  const llm = await startLocalOpenAI(setup.script)
  const events: AgentEvent[] = []
  const asked: McpElicitationRequest[] = []
  const snapshots: IRunSnapshot[] = []
  const keep = (snapshot: IRunSnapshot): void => {
    // As a store would: serialised at the moment it is handed over.
    snapshots.push(JSON.parse(JSON.stringify(snapshot)) as IRunSnapshot)
  }
  const handler = setup.onElicitation
  let agent: IAgent | undefined
  try {
    agent = await createAgent(
      baseConfig(llm.baseURL, {
        mcpServers: { wx: serverConfig(server, era) },
        persistence: { onRunStart: keep, onStepComplete: keep, onRunComplete: keep },
        ...(handler
          ? {
              onElicitation: (request, ctx) => {
                asked.push(request)
                return handler(request, ctx)
              },
            }
          : {}),
        ...setup.config?.(server, llm.baseURL),
      }),
      (event) => events.push(event),
    )
    await body({ llm, server, agent, events, asked, snapshots })
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
    await server.close()
  }
}

/** Every event of a run, the helpers' and children's unwrapped. */
const flatten = (events: AgentEvent[]): AgentEvent[] =>
  events.flatMap((e) => (e.type === 'subagent.event' ? [e, ...flatten([e.event])] : [e]))

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  flatten(events).filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

// ── a recording tracer: everything the agent hands to OpenTelemetry ────────

const spans: unknown[] = []
const recordingSpan = (name: string, options: unknown): Span => {
  const record: unknown[] = [name, options]
  spans.push(record)
  const span = {
    spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }),
    setAttribute: (key: string, value: unknown) => (record.push(['attr', key, value]), span),
    setAttributes: (attrs: unknown) => (record.push(['attrs', attrs]), span),
    addEvent: (...args: unknown[]) => (record.push(['event', ...args]), span),
    addLink: (link: unknown) => (record.push(['link', link]), span),
    addLinks: (links: unknown) => (record.push(['links', links]), span),
    setStatus: (status: unknown) => (record.push(['status', status]), span),
    updateName: (next: string) => (record.push(['name', next]), span),
    end: () => undefined,
    isRecording: () => true,
    recordException: (err: unknown) => {
      record.push(['exception', String(err), (err as Error)?.stack ?? ''])
    },
  }
  return span as unknown as Span
}
const recordingTracer = {
  startSpan: (name: string, options?: unknown) => recordingSpan(name, options),
  startActiveSpan: (name: string, ...rest: unknown[]) => {
    const fn = rest.at(-1) as (span: Span) => unknown
    return fn(recordingSpan(name, rest.length > 1 ? rest[0] : undefined))
  },
} as unknown as Tracer
trace.setGlobalTracerProvider({ getTracer: () => recordingTracer })
void context

// ── the answer goes to the server, and nowhere else ────────────────────────

for (const era of ['legacy', 'modern'] as Era[]) {
  test(`${era}: a run answers a server's form; the answer is in no prompt, event, log, trace or snapshot`, async (t) => {
    const consoleLines: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      t.mock.method(console, method, (...args: unknown[]) => {
        consoleLines.push(args.map(String).join(' '))
      })
    }
    spans.length = 0
    await withAgent(
      era,
      {
        script: script({ root: [{ name: 'wx__elicit_form', args: {} }] }),
        onElicitation: () => ({
          action: 'accept',
          content: { name: SECRET, email: `${SECRET}@example.test`, toppings: ['basil'] },
        }),
      },
      async (h) => {
        // The server leaves the answers out of its result: anything found is the agent's doing.
        h.server.elicitationFaults.quietResult = true
        const result = await h.agent.run({ input: 'Fill in my profile' })

        assert.equal(result.text, 'All done.')
        const call = result.trace[0].toolCalls[0]
        assert.deepEqual(
          [call.name, call.ok, call.output],
          ['wx__elicit_form', true, JSON.stringify({ tool: 'elicit_form', action: 'accept' })],
        )
        // ONE call on the server, whatever it took on the wire.
        assert.deepEqual(h.server.calls, [{ name: 'elicit_form', args: {} }])
        // The answer did arrive.
        assert.ok(JSON.stringify(h.server.elicitations).includes(SECRET))

        // The host was asked once, about this run's call.
        assert.equal(h.asked.length, 1)
        assert.equal(h.asked[0].tool, 'wx__elicit_form')
        assert.equal(h.asked[0].server, 'wx')
        assert.equal(h.asked[0].subagent, undefined)
        assert.match(h.asked[0].runId ?? '', /\S/)

        // The two events sit between the tool's call and its result, and carry the step.
        const order = h.events
          .map((e) => e.type)
          .filter((type) => type.startsWith('mcp.') || type.startsWith('step.tool'))
        assert.deepEqual(order, [
          'step.tool-call',
          'mcp.elicitation-requested',
          'mcp.elicitation-answered',
          'step.tool-result',
        ])
        const [requested] = of(h.events, 'mcp.elicitation-requested')
        const [answered] = of(h.events, 'mcp.elicitation-answered')
        assert.equal(requested.id, h.asked[0].id)
        assert.equal(requested.step?.id, 's1')
        assert.equal(requested.message, 'Fill in the profile')
        assert.equal(requested.requestedSchema?.properties.name.title, 'Name')
        assert.deepEqual(
          { ...answered, id: '', runId: undefined },
          {
            type: 'mcp.elicitation-answered',
            id: '',
            runId: undefined,
            server: 'wx',
            tool: 'wx__elicit_form',
            action: 'accept',
            automatic: false,
            fields: ['name', 'email', 'toppings'],
          },
        )

        // Nowhere but on its way to the server:
        const everywhere: [string, unknown][] = [
          ["the model's context", h.llm.requests],
          ['the events (logs included)', h.events],
          ['the run snapshots', h.snapshots],
          ['the run result', result],
          ['the traces', spans],
          ['the console', consoleLines],
        ]
        for (const [where, value] of everywhere) {
          assert.equal(JSON.stringify(value).includes(SECRET), false, `the answer is in ${where}`)
        }
        assert.ok(h.snapshots.length >= 2, 'no snapshot was taken')
        assert.ok(spans.length > 0, 'no span was recorded')
        assert.ok(
          h.events.some((e) => e.type === 'log'),
          'no log event was emitted',
        )

        // And the server's own text reached the host and the event - never a prompt.
        const prompts = JSON.stringify(h.llm.requests)
        for (const text of SERVER_TEXT) {
          assert.equal(prompts.includes(text), false, `"${text}" is in the model's context`)
        }
        assert.equal(JSON.stringify(h.snapshots).includes('Fill in the profile'), false)
      },
    )
  })

  test(`${era}: a declined question is the server's to report; a failed one says why to the model, without the answer`, async () => {
    await withAgent(
      era,
      {
        script: script({ root: [{ name: 'wx__elicit_form', args: {} }] }),
        // Not what the form asks for: the email is no email.
        onElicitation: () => ({ action: 'accept', content: { name: 'Ada', email: SECRET } }),
      },
      async (h) => {
        const result = await h.agent.run({ input: 'Fill in my profile' })
        const call = result.trace[0].toolCalls[0]
        assert.equal(call.ok, false)
        assert.match(
          String(call.output),
          /did not finish: the server asked the user for input, and the answer did not fit the form \(field "email" is not a valid email\) and was not sent/,
        )
        // The model reads that, and not the value.
        const seen = h.llm.requests.flatMap((r) => toolResults(r)).join('\n')
        assert.match(
          seen,
          /The call was not repeated; do not call the tool again only because of this/,
        )
        assert.equal(
          JSON.stringify([h.llm.requests, h.events, h.snapshots]).includes(SECRET),
          false,
        )
        assert.deepEqual(h.server.calls, [{ name: 'elicit_form', args: {} }])
        assert.equal(JSON.stringify(h.server.elicitations).includes(SECRET), false)
      },
    )
  })

  // ── who may ask ───────────────────────────────────────────────────────────

  test(`${era}: a helper the model started cannot ask the user`, async () => {
    await withAgent(
      era,
      {
        script: script({
          root: [
            {
              name: SPAWN_SUBAGENT_TOOL,
              args: { task: '[[A]] Fill in the profile form', tools: ['wx__elicit_form'] },
            },
          ],
          helper: [{ name: 'wx__elicit_form', args: {} }],
        }),
        onElicitation: () => ({ action: 'accept', content: { name: 'Ada', email: 'a@b.test' } }),
        config: () => ({ subagents: { dynamic: { defaultTools: 'all' } } }),
      },
      async (h) => {
        await h.agent.run({ input: 'Do the work' })
        assert.equal(h.asked.length, 0, 'a helper put a question to the user')
        assert.equal(of(h.events, 'mcp.elicitation-requested').length, 0)
        const [answered] = of(h.events, 'mcp.elicitation-answered')
        assert.deepEqual(
          [answered.action, answered.automatic, answered.reason],
          ['cancel', true, 'subagent'],
        )
        // The helper's model was told why.
        const helperSaw = h.llm.requests
          .filter(isHelper)
          .flatMap((r) => toolResults(r))
          .join('\n')
        assert.match(
          helperSaw,
          /a helper is not allowed to ask the user \(elicitation\.subagents\)/,
        )
        // Nothing was answered on the user's behalf.
        assert.equal(
          JSON.stringify(h.server.elicitations).includes('"accept"'),
          false,
          'the server was given an answer',
        )
        assert.deepEqual(h.server.calls, [{ name: 'elicit_form', args: {} }])
      },
    )
  })

  test(`${era}: ... unless the host passes it through (elicitation.subagents), and then the request says who asks`, async () => {
    await withAgent(
      era,
      {
        script: script({
          root: [
            {
              name: SPAWN_SUBAGENT_TOOL,
              args: { task: '[[A]] Fill in the profile form', tools: ['wx__elicit_form'] },
            },
          ],
          helper: [{ name: 'wx__elicit_form', args: {} }],
        }),
        onElicitation: () => ({ action: 'accept', content: { name: 'Ada', email: 'a@b.test' } }),
        config: () => ({
          subagents: { dynamic: { defaultTools: 'all' } },
          elicitation: { subagents: true },
        }),
      },
      async (h) => {
        await h.agent.run({ input: 'Do the work' })
        assert.equal(h.asked.length, 1)
        const [start] = of(h.events, 'subagent.start')
        assert.deepEqual(h.asked[0].subagent, { id: start.id, depth: 1 })
        const [requested] = of(h.events, 'mcp.elicitation-requested')
        assert.deepEqual(requested.subagent, { id: start.id, depth: 1 })
        assert.deepEqual(h.server.calls, [{ name: 'elicit_form', args: {} }])
      },
    )
  })

  test(`${era}: a helper's questions count on the run that started it (maxPerRun)`, async () => {
    await withAgent(
      era,
      {
        script: script({
          root: [
            { name: 'wx__elicit_state', args: {} },
            {
              name: SPAWN_SUBAGENT_TOOL,
              args: { task: '[[A]] Confirm it', tools: ['wx__elicit_state'] },
            },
          ],
          helper: [{ name: 'wx__elicit_state', args: {} }],
        }),
        onElicitation: () => ({ action: 'accept', content: { confirm: true } }),
        config: () => ({
          subagents: { dynamic: { defaultTools: 'all' } },
          elicitation: { subagents: true, maxPerRun: 1 },
        }),
      },
      async (h) => {
        await h.agent.run({ input: 'Do the work' })
        assert.equal(h.asked.length, 1, 'the cap is per run, helpers included')
        const reasons = of(h.events, 'mcp.elicitation-answered').map((e) => e.reason ?? 'host')
        assert.deepEqual(reasons.sort(), ['cap-per-run', 'host'])
      },
    )
  })

  for (const isolation of ['in-process', 'worker'] as const) {
    test(`${era}: a subagent (${isolation}) has its own connections - without a callback of its own it declares nothing`, async () => {
      // The child's server: the same tools, another process's worth of state.
      const childServer = await startLocalMcpServer({ protocol: era, elicitationTools: true })
      try {
        await withAgent(
          era,
          {
            script: script({
              root: [{ name: 'researcher', args: { task: 'Fill in the profile form' } }],
              child: [{ name: 'cx__elicit_form', args: {} }],
            }),
            onElicitation: () => ({
              action: 'accept',
              content: { name: 'Ada', email: 'a@b.test' },
            }),
            config: (_server, llmUrl) => ({
              tools: {
                researcher: createSubagentTool({
                  name: 'researcher',
                  description: 'Delegate a task',
                  isolation,
                  // The child's config has no onElicitation: the parent's is not inherited.
                  config: baseConfig(llmUrl, {
                    systemPrompt: 'CHILD AGENT',
                    logLevel: 'none',
                    mcpServers: { cx: serverConfig(childServer, era) },
                  }),
                  timeoutMs: 20_000,
                }),
              },
            }),
          },
          async (h) => {
            const result = await h.agent.run({ input: 'Delegate it' })
            assert.equal(result.trace[0].toolCalls[0].name, 'researcher')
            assert.equal(h.asked.length, 0, "the parent was asked on the child's behalf")
            assert.deepEqual(childServer.calls.length <= 1, true)
            if (era === 'legacy') {
              assert.deepEqual(childServer.initializeCapabilities, [{}])
            }
            assert.equal(JSON.stringify(childServer.elicitations).includes('"accept"'), false)
            // The child's model was told its tool failed; the parent's own server was not involved.
            const childSaw = h.llm.requests
              .filter((r) => systemOf(r).includes('CHILD AGENT'))
              .flatMap((r) => toolResults(r))
              .join('\n')
            assert.match(childSaw, /elicitation capability|-32021|capabilit/i)
            assert.deepEqual(h.server.calls, [])
          },
        )
      } finally {
        await childServer.close()
      }
    })
  }

  // ── time ──────────────────────────────────────────────────────────────────

  test(`${era}: a question does not outlive its step - the step's limit ends it, and says so`, async () => {
    let hostSignal: AbortSignal | undefined
    await withAgent(
      era,
      {
        script: script({ root: [{ name: 'wx__elicit_form', args: {} }] }),
        onElicitation: (_request, ctx) => {
          hostSignal = ctx.signal
          return new Promise(() => {})
        },
        // The question would wait five minutes; the step may take 400 ms.
        config: () => ({ llmTimeoutMs: 400 }),
      },
      async (h) => {
        const startedAt = Date.now()
        await h.agent.run({ input: 'Fill in my profile' }).catch(() => undefined)
        assert.ok(Date.now() - startedAt < 10_000, 'the run waited for the question')
        assert.equal(hostSignal?.aborted, true, 'the host was not told the wait is over')
        const [answered] = of(h.events, 'mcp.elicitation-answered')
        assert.deepEqual(
          [answered.action, answered.automatic, answered.reason],
          ['cancel', true, 'step-timeout'],
        )
        const logs = of(h.events, 'log').map((e) => e.message)
        assert.ok(
          logs.some((m) => /the step's time limit ended while the question was waiting/.test(m)),
          'nothing said why the question ended',
        )
        assert.deepEqual(h.server.calls, [{ name: 'elicit_form', args: {} }])
      },
    )
  })

  test(`${era}: stopping the run cancels the question`, async () => {
    let hostSignal: AbortSignal | undefined
    const controller = new AbortController()
    await withAgent(
      era,
      {
        script: script({ root: [{ name: 'wx__elicit_form', args: {} }] }),
        onElicitation: (_request, ctx) => {
          hostSignal = ctx.signal
          setTimeout(() => controller.abort(), 20)
          return new Promise(() => {})
        },
      },
      async (h) => {
        await assert.rejects(
          h.agent.run({ input: 'Fill in my profile', signal: controller.signal }),
        )
        assert.equal(hostSignal?.aborted, true)
        const [answered] = of(h.events, 'mcp.elicitation-answered')
        assert.deepEqual(
          [answered.action, answered.automatic, answered.reason],
          ['cancel', true, 'aborted'],
        )
        assert.deepEqual(h.server.calls, [{ name: 'elicit_form', args: {} }])
      },
    )
  })
}

// ── configuration ───────────────────────────────────────────────────────────

test('a worker subagent cannot be handed the callback: its config must be cloneable', () => {
  assert.throws(
    () =>
      createSubagentTool({
        name: 'researcher',
        description: 'Delegate a task',
        config: baseConfig('http://127.0.0.1:1', {
          onElicitation: () => ({ action: 'decline' }),
        }),
      }),
    /onElicitation/,
  )
})

test('a setting that is not a usable number is a configuration error', async () => {
  await assert.rejects(
    createAgent(baseConfig('http://127.0.0.1:1', { elicitation: { maxPerToolCall: 0 } })),
    /elicitation\.maxPerToolCall must be a number of at least 1/,
  )
})
