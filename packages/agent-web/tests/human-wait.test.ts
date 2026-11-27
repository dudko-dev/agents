import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { startLocalMcpServer } from '@dudko.dev/test-servers'
import {
  createAgent,
  createSubagentTool,
  defineTool,
  serveSubagentWorker,
  SPAWN_SUBAGENT_TOOL,
  type Agent,
  type AgentEvent,
  type AgentToolSet,
  type BrowserAgentConfig,
  type RunResult,
  type ToolApprovalConfig,
} from '../dist/index.js'
import { connectMcpHttp } from '../dist/mcp.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// Time spent waiting for a HUMAN - a tool approval, an MCP elicitation - is not the model's or a
// tool's latency: the step's limit (chatTimeoutMs, 120 s by default) and a subagent's timeoutMs
// stop while a question is with the host and go on with what they had left (wait-clock.ts, the
// same file as the Node package's, unit-tested there on mocked timers). Here the whole loop on a
// scripted model, with real but short timers. The Node sibling's `tests/human-wait.test.ts`; the
// elicitation's own bound past the step's limit is in `mcp-elicitation-agent.test.ts` ("time").

type Calls = { name: string; args: unknown }[]
type Who = 'root' | 'helper'

const planJson = JSON.stringify({ thought: 'Plan.', steps: [{ description: 'Step s1' }] })

/** Whose call it is: the run's own, or the helper whose task carries [[A]] (its GOAL line). */
const whoOf = (info: CallInfo): Who => {
  const from = info.user.indexOf('GOAL: ')
  const own = (from < 0 ? info.user : info.user.slice(from)).split('\n\n')[0]
  return own.includes('[[A]]') ? 'helper' : 'root'
}

/** The tool results a call's conversation already holds, as the model was shown them. */
const resultsOf = (info: CallInfo): string[] =>
  ((info.options.prompt ?? []) as { role: string; content: unknown }[])
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content as { type: string; output?: { value?: unknown } }[])
    .filter((p) => p.type === 'tool-result')
    .map((p) =>
      typeof p.output?.value === 'string' ? p.output.value : JSON.stringify(p.output?.value),
    )

/** Every actor plans one step and makes its calls one round after another, then reports. */
const script =
  (rounds: Partial<Record<Who, Calls[]>>) =>
  (info: CallInfo): Reply => {
    const mine = rounds[whoOf(info)] ?? []
    switch (stageOf(info)) {
      case 'planner':
        return { text: planJson }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'finish', reason: 'done' }) }
      case 'synthesizer':
        return { text: 'All done.' }
      default:
        return info.toolResults < mine.length
          ? { toolCalls: mine[info.toolResults] }
          : { text: `results: ${resultsOf(info).join(' | ')}` }
    }
  }

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })

interface Rig {
  agent: Agent
  events: AgentEvent[]
  go: (opts?: Parameters<Agent['run']>[1]) => Promise<RunResult>
}

const rig = async (
  rounds: Partial<Record<Who, Calls[]>>,
  extra: Partial<BrowserAgentConfig>,
): Promise<Rig> => {
  const model = scriptedModel(script(rounds))
  const agent = await createAgent({ model: model.model, toolMode: 'native', ...extra })
  const events: AgentEvent[] = []
  return {
    agent,
    events,
    go: (opts = {}) => agent.run('Do the work', { onEvent: (e) => events.push(e), ...opts }),
  }
}

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
const callsOf = (result: RunResult) =>
  result.trace.flatMap((s) => s.toolCalls.map((c) => [c.name, c.ok, errorOf(c.output)]))

/** A write tool that says when it ran. */
const noteTool = (ran: string[] = []): AgentToolSet => ({
  save_note: defineTool({
    description: 'Save a note',
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => {
      ran.push(text)
      return `saved ${text}`
    },
  }),
})

/** Tools that take a while, and one that never returns (it ends with its signal). */
const slowTools = (burnMs: number, times: { startedAt: number; endedAt: number }) => ({
  burn: defineTool({
    description: 'Takes a while',
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }) => {
      await sleep(burnMs, abortSignal)
      return 'burnt'
    },
  }),
  hang: defineTool({
    description: 'Never returns',
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }) => {
      times.startedAt = Date.now()
      await sleep(60_000, abortSignal).catch((err) => {
        times.endedAt = Date.now()
        throw err
      })
      return 'never'
    },
  }),
})

/** An approval that the person takes `ms` to give. */
const approveAfter = (ms: number, asked: string[] = [], rules?: ToolApprovalConfig['rules']) =>
  ({
    mode: rules ? 'autopilot' : 'ask-all',
    ...(rules ? { rules } : {}),
    onRequest: async (req) => {
      asked.push(`${req.toolName}${req.subagent ? ':helper' : ''}`)
      await sleep(ms)
      return true
    },
  }) satisfies ToolApprovalConfig

const STEP = 300
const HUMAN = 800

// ── approval ────────────────────────────────────────────────────────────────

test('approval: a decision that takes longer than the step limit does not end the step', async () => {
  const ran: string[] = []
  const r = await rig(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    { tools: noteTool(ran), toolApproval: approveAfter(HUMAN), chatTimeoutMs: STEP },
  )
  const result = await r.go()
  assert.deepEqual(callsOf(result), [['save_note', true, 'saved a']])
  assert.deepEqual(ran, ['a'])
  assert.equal(result.final, 'All done.')
  const [resolved] = of(r.events, 'tool.approval-resolved')
  assert.deepEqual([resolved.approved, resolved.automatic], [true, false])
  assert.deepEqual(of(r.events, 'error'), [])
})

test('approval: the step goes on with the time it had left - not with a full limit, and not with none', async () => {
  // The step may take 1000 ms. A first call uses 500 of them; the second waits 600 ms for a
  // person and then never returns: the step must end about 500 ms after the decision.
  const times = { startedAt: 0, endedAt: 0 }
  const r = await rig(
    { root: [[{ name: 'burn', args: {} }], [{ name: 'hang', args: {} }]] },
    {
      tools: slowTools(500, times),
      toolApproval: approveAfter(600, [], { hang: 'ask' }),
      chatTimeoutMs: 1000,
    },
  )
  await r.go()
  // Not paused: the step ended during the wait and the tool never ran.
  assert.ok(times.endedAt > 0, 'the wait counted against the step: the tool never ran')
  const left = times.endedAt - times.startedAt
  // Resumed with a full limit: ~1000. Right: ~500, less the model's time.
  assert.ok(left > 350, `the wait counted against the step (${left} ms left)`)
  assert.ok(left < 800, `the step got more than it had left (${left} ms)`)
})

test('approval: stopping the run ends the wait at once', async () => {
  const controller = new AbortController()
  const r = await rig(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    {
      tools: noteTool(),
      toolApproval: {
        mode: 'ask-all',
        onRequest: () => {
          setTimeout(() => controller.abort(), 30)
          return new Promise<boolean>(() => {})
        },
      },
      chatTimeoutMs: 5000,
    },
  )
  const startedAt = Date.now()
  const result = await r.go({ signal: controller.signal })
  assert.ok(Date.now() - startedAt < 2000, 'the stop waited for the decision')
  assert.equal(result.stopped, true)
  const [resolved] = of(r.events, 'tool.approval-resolved')
  assert.deepEqual([resolved.approved, resolved.automatic], [false, true])
})

test("approval: a time limit the host put on the run's signal is a stop - it is not paused", async () => {
  // The config has no run-level time limit; a host's own AbortSignal.timeout() on the run is
  // the only one, and it ends a wait like any stop.
  const r = await rig(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    {
      tools: noteTool(),
      toolApproval: { mode: 'ask-all', onRequest: () => new Promise<boolean>(() => {}) },
      chatTimeoutMs: 5000,
    },
  )
  // AbortSignal.timeout does not keep Node alive, and nothing else would here.
  const alive = setTimeout(() => {}, 10_000)
  const startedAt = Date.now()
  const result = await r.go({ signal: AbortSignal.timeout(STEP) })
  const took = Date.now() - startedAt
  clearTimeout(alive)
  assert.ok(took < STEP + 1500, `the host's limit waited for the person (${took} ms)`)
  assert.equal(result.stopped, true)
  const [resolved] = of(r.events, 'tool.approval-resolved')
  assert.deepEqual([resolved.approved, resolved.automatic], [false, true])
})

test("approval: its own bound (toolApproval.timeoutMs) still ends the wait, past the step's limit", async () => {
  const ran: string[] = []
  const r = await rig(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    {
      tools: noteTool(ran),
      toolApproval: {
        mode: 'ask-all',
        timeoutMs: HUMAN,
        onRequest: () => new Promise<boolean>(() => {}),
      },
      chatTimeoutMs: STEP,
    },
  )
  const startedAt = Date.now()
  const result = await r.go()
  assert.ok(Date.now() - startedAt >= HUMAN, 'the step ended the wait')
  // Denied by the approval's own clock; the step itself was not cut and reported it.
  const [[name, ok, output]] = callsOf(result)
  assert.deepEqual([name, ok], ['save_note', false])
  assert.match(String(output), new RegExp(`no approval decision within ${HUMAN} ms`))
  assert.deepEqual(ran, [])
  assert.equal(result.final, 'All done.')
})

/** A child agent's model: it calls `calls` in its first round, then reports. */
const childModel = (calls: Calls) =>
  scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: planJson }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'finish', reason: 'done' }) }
      case 'synthesizer':
        return { text: 'child done' }
      default:
        return info.toolResults === 0
          ? { toolCalls: calls }
          : { text: `results: ${resultsOf(info).join(' | ')}` }
    }
  })

// ── elicitation ─────────────────────────────────────────────────────────────

for (const era of ['legacy', 'modern'] as const) {
  const withServer = async (
    options: Parameters<typeof connectMcpHttp>[1],
    extra: Partial<BrowserAgentConfig>,
    body: (r: Rig) => Promise<void>,
  ): Promise<void> => {
    const server = await startLocalMcpServer({ protocol: era, elicitationTools: true })
    const mcp = await connectMcpHttp(
      { wx: { url: server.url, ...(era === 'modern' ? { protocol: 'modern' as const } : {}) } },
      options,
    )
    try {
      const r = await rig(
        { root: [[{ name: 'wx__elicit_form', args: {} }]] },
        { tools: mcp.tools, chatTimeoutMs: STEP, ...extra },
      )
      await body(r)
    } finally {
      await mcp.close()
      await server.close()
    }
  }

  test(`${era} elicitation: an answer that takes longer than the step limit does not end the step`, async () => {
    await withServer(
      {
        onElicitation: async () => {
          await sleep(HUMAN)
          return { action: 'accept', content: { name: 'Ada', email: 'a@b.test' } }
        },
      },
      {},
      async (r) => {
        const result = await r.go()
        assert.deepEqual(
          callsOf(result).map(([name, ok]) => [name, ok]),
          [['wx__elicit_form', true]],
        )
        assert.equal(result.final, 'All done.')
        const [answered] = of(r.events, 'mcp.elicitation-answered')
        assert.deepEqual([answered.action, answered.automatic], ['accept', false])
      },
    )
  })

  test(`${era} elicitation: a worker subagent's host tool asks the user - the calling step, the subagent's limit and the child's step stop`, async () => {
    // The MCP tool runs on the main thread for the child in the worker, with no run of its own:
    // the mark the subagent tool puts on it carries the calling run's clock.
    const server = await startLocalMcpServer({ protocol: era, elicitationTools: true })
    const mcp = await connectMcpHttp(
      { wx: { url: server.url, ...(era === 'modern' ? { protocol: 'modern' as const } : {}) } },
      {
        onElicitation: async () => {
          await sleep(HUMAN)
          return { action: 'accept', content: { name: 'Ada', email: 'a@b.test' } }
        },
        elicitation: { subagents: true },
      },
    )
    const child = childModel([{ name: 'wx__elicit_form', args: {} }])
    const opened: MessagePort[] = []
    try {
      const r = await rig(
        { root: [[{ name: 'researcher', args: { task: 'Fill in the form' } }]] },
        {
          tools: {
            researcher: createSubagentTool({
              name: 'researcher',
              description: 'Delegate a task',
              timeoutMs: 500,
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
                model: { providerType: 'openai', model: 'child' },
                toolMode: 'native',
                chatTimeoutMs: STEP,
              },
              tools: { wx__elicit_form: mcp.tools.wx__elicit_form },
            }),
          },
          chatTimeoutMs: STEP,
        },
      )
      const result = await r.go()
      assert.deepEqual(
        callsOf(result).map(([name, ok]) => [name, ok]),
        [['researcher', true]],
      )
      const childCalls = of(r.events, 'step.tool-result').filter(
        (e) => e.name === 'wx__elicit_form',
      )
      assert.deepEqual(
        childCalls.map((e) => e.ok),
        [true],
      )
      assert.equal(JSON.stringify(server.elicitations).includes('"accept"'), true)
    } finally {
      for (const p of opened) p.close()
      await mcp.close()
      await server.close()
    }
  })

  test(`${era} elicitation: stopping the run ends the wait at once`, async () => {
    const controller = new AbortController()
    await withServer(
      {
        onElicitation: () => {
          setTimeout(() => controller.abort(), 30)
          return new Promise(() => {})
        },
      },
      { chatTimeoutMs: 5000 },
      async (r) => {
        const startedAt = Date.now()
        await r.go({ signal: controller.signal })
        assert.ok(Date.now() - startedAt < 2000, 'the stop waited for the answer')
        const [answered] = of(r.events, 'mcp.elicitation-answered')
        assert.deepEqual(
          [answered.action, answered.automatic, answered.reason],
          ['cancel', true, 'aborted'],
        )
      },
    )
  })
}

// ── helpers and subagents ───────────────────────────────────────────────────

test("a helper's wait stops its own step, the step of the run that called it, and the helper's time limit", async () => {
  // Three clocks would each end this: the helper's step (300), the parent's step, which is
  // running spawn_subagent (300), and the bound on the helper as a whole (500).
  const ran: string[] = []
  const asked: string[] = []
  const r = await rig(
    {
      root: [[{ name: SPAWN_SUBAGENT_TOOL, args: { task: '[[A]] save the note' } }]],
      helper: [[{ name: 'save_note', args: { text: 'h' } }]],
    },
    {
      tools: noteTool(ran),
      toolApproval: approveAfter(HUMAN, asked, { save_note: 'ask' }),
      subagents: { dynamic: { timeoutMs: 500, defaultTools: 'all' } },
      chatTimeoutMs: STEP,
    },
  )
  const result = await r.go()
  assert.deepEqual(asked, ['save_note:helper'])
  assert.deepEqual(ran, ['h'])
  assert.deepEqual(
    callsOf(result).map(([name, ok]) => [name, ok]),
    [[SPAWN_SUBAGENT_TOOL, true]],
  )
  assert.deepEqual(of(r.events, 'subagent.error'), [])
  assert.equal(of(r.events, 'subagent.complete').length, 1)
  assert.equal(result.final, 'All done.')
})

test("a helper's time limit goes on with what it had left after the wait", async () => {
  // The helper may take 900 ms. A first call uses 400 of them; the second waits 600 ms for a
  // person and then never returns: the helper must end about 500 ms after the decision.
  const times = { startedAt: 0, endedAt: 0 }
  const r = await rig(
    {
      root: [[{ name: SPAWN_SUBAGENT_TOOL, args: { task: '[[A]] hang' } }]],
      helper: [[{ name: 'burn', args: {} }], [{ name: 'hang', args: {} }]],
    },
    {
      tools: slowTools(400, times),
      toolApproval: approveAfter(600, [], { hang: 'ask' }),
      subagents: { dynamic: { timeoutMs: 900, defaultTools: 'all' } },
    },
  )
  const result = await r.go()
  const [[name, ok, output]] = callsOf(result)
  assert.deepEqual([name, ok], [SPAWN_SUBAGENT_TOOL, false])
  assert.match(String(output), /the helper timed out after 900ms/)
  assert.ok(times.endedAt > 0, 'the wait counted against the helper: its tool never ran')
  const left = times.endedAt - times.startedAt
  assert.ok(left > 250, `the wait counted against the helper (${left} ms left)`)
  assert.ok(left < 750, `the helper got a full limit after the wait (${left} ms)`)
})

test("an in-process subagent's own approval stops the parent's step and the subagent's timeoutMs", async () => {
  const ran: string[] = []
  const child = childModel([{ name: 'save_note', args: { text: 'c' } }])
  const r = await rig(
    { root: [[{ name: 'researcher', args: { task: 'Save the note' } }]] },
    {
      tools: {
        researcher: createSubagentTool({
          name: 'researcher',
          description: 'Delegate a task',
          timeoutMs: 500,
          config: {
            model: child.model,
            toolMode: 'native',
            tools: noteTool(ran),
            toolApproval: approveAfter(HUMAN),
            chatTimeoutMs: STEP,
          },
        }),
      },
      chatTimeoutMs: STEP,
    },
  )
  const result = await r.go()
  assert.deepEqual(ran, ['c'])
  assert.deepEqual(
    callsOf(result).map(([name, ok]) => [name, ok]),
    [['researcher', true]],
  )
  assert.deepEqual(of(r.events, 'subagent.error'), [])
  assert.equal(result.final, 'All done.')
})

test("an in-process subagent's host tool, asked about by the PARENT's gate: no clock of the three runs on", async () => {
  // The host tool runs in the child's step (300), behind the parent's consent gate; the parent's
  // step (300) is running the subagent, which has a bound of its own (500).
  const ran: string[] = []
  const asked: string[] = []
  const child = childModel([{ name: 'save_note', args: { text: 'c' } }])
  const r = await rig(
    { root: [[{ name: 'researcher', args: { task: 'Save the note' } }]] },
    {
      tools: {
        researcher: createSubagentTool({
          name: 'researcher',
          description: 'Delegate a task',
          timeoutMs: 500,
          config: { model: child.model, toolMode: 'native', chatTimeoutMs: STEP },
          tools: noteTool(ran),
        }),
      },
      toolApproval: approveAfter(HUMAN, asked, { save_note: 'ask' }),
      chatTimeoutMs: STEP,
    },
  )
  const result = await r.go()
  assert.deepEqual(asked, ['save_note'])
  assert.deepEqual(ran, ['c'])
  assert.deepEqual(
    callsOf(result).map(([name, ok]) => [name, ok]),
    [['researcher', true]],
  )
  const childCalls = of(r.events, 'step.tool-result').filter((e) => e.name === 'save_note')
  assert.deepEqual(
    childCalls.map((e) => [e.ok, e.output]),
    [[true, 'saved c']],
  )
  assert.equal(result.final, 'All done.')
})

test("a worker subagent's host tool, asked about by the parent's gate: the child's step in the worker stops too", async () => {
  const ran: string[] = []
  const asked: string[] = []
  const child = childModel([{ name: 'save_note', args: { text: 'w' } }])
  const opened: MessagePort[] = []
  const makeWorker = () => {
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
  }
  try {
    const r = await rig(
      { root: [[{ name: 'researcher', args: { task: 'Save the note' } }]] },
      {
        tools: {
          researcher: createSubagentTool({
            name: 'researcher',
            description: 'Delegate a task',
            timeoutMs: 500,
            worker: makeWorker,
            workerConfig: {
              model: { providerType: 'openai', model: 'child' },
              toolMode: 'native',
              chatTimeoutMs: STEP,
            },
            tools: noteTool(ran),
          }),
        },
        toolApproval: approveAfter(HUMAN, asked, { save_note: 'ask' }),
        chatTimeoutMs: STEP,
      },
    )
    const result = await r.go()
    assert.deepEqual(asked, ['save_note'])
    assert.deepEqual(ran, ['w'])
    assert.deepEqual(
      callsOf(result).map(([name, ok]) => [name, ok]),
      [['researcher', true]],
    )
    const childCalls = of(r.events, 'step.tool-result').filter((e) => e.name === 'save_note')
    assert.deepEqual(
      childCalls.map((e) => [e.ok, e.output]),
      [[true, 'saved w']],
    )
  } finally {
    for (const p of opened) p.close()
  }
})

// ── nothing waits: nothing changes ──────────────────────────────────────────

test('no wait: a step that runs past its limit still ends there', async () => {
  const times = { startedAt: 0, endedAt: 0 }
  const r = await rig(
    { root: [[{ name: 'hang', args: {} }]] },
    { tools: slowTools(0, times), chatTimeoutMs: STEP },
  )
  await r.go()
  assert.ok(times.endedAt > 0, 'the step never ended')
  const took = times.endedAt - times.startedAt
  assert.ok(took <= STEP + 50, `ended after ${took} ms`)
  assert.ok(took >= STEP - 100, `ended after ${took} ms`)
})
