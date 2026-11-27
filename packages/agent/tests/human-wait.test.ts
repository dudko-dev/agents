import assert from 'node:assert/strict'
import test from 'node:test'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { startLocalMcpServer } from '@dudko.dev/test-servers'
import {
  createAgent,
  createSubagentTool,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
} from '../src/index.ts'
import { runContext } from '../src/context.ts'
import { SPAWN_SUBAGENT_TOOL } from '../src/subagent-dynamic-shared.ts'
import {
  startLocalOpenAI,
  systemOf,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type IScriptedReply,
  type Script,
} from './helpers/openai-server.ts'

// Time spent waiting for a HUMAN - a tool approval, an MCP elicitation - is not the model's or a
// tool's latency: the step's limit (llmTimeoutMs) and a subagent's timeoutMs stop while a question
// is with the host and go on with what they had left. Over real sockets, with real (short) timers:
// each test names the guard it is the check for.

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

type Call = { name: string; args: unknown }
type Who = 'root' | 'helper' | 'child'

/** Whose request it is: the run's own, the helper whose task carries [[A]], or a static child. */
const whoOf = (req: IChatRequest): Who =>
  systemOf(req).includes('CHILD AGENT')
    ? 'child'
    : /\[\[A\]\]/.test(userOf(req).split('\nOverall plan:')[0])
      ? 'helper'
      : 'root'

/** Every actor plans one step and makes its calls one round after another, then reports. */
const script =
  (rounds: Partial<Record<Who, Call[][]>>): Script =>
  (req): IScriptedReply => {
    const mine = rounds[whoOf(req)] ?? []
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'finish', reason: 'done' }) }
      case 'synthesizer':
        return { text: 'All done.' }
      default: {
        // One round per batch of results already in the conversation.
        let seen = 0
        let round = 0
        while (round < mine.length && seen + mine[round].length <= toolResults(req).length) {
          seen += mine[round].length
          round += 1
        }
        return round < mine.length
          ? { toolCalls: mine[round] }
          : { text: `results: ${toolResults(req).join(' | ')}` }
      }
    }
  }

const baseConfig = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'human-wait',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 3,
  maxStepsPerTask: 5,
  llmMaxRetries: 0,
  logLevel: 'none',
  ...extra,
})

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

interface IRig {
  llm: ILocalOpenAI
  agent: IAgent
  events: AgentEvent[]
}

const withAgent = async (
  rounds: Partial<Record<Who, Call[][]>>,
  config: (llmUrl: string) => Partial<IAgentConfig>,
  body: (rig: IRig) => Promise<void>,
): Promise<void> => {
  const llm = await startLocalOpenAI(script(rounds))
  const events: AgentEvent[] = []
  let agent: IAgent | undefined
  try {
    agent = await createAgent(baseConfig(llm.baseURL, config(llm.baseURL)), (e) => events.push(e))
    await body({ llm, agent, events })
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
  }
}

const flatten = (events: AgentEvent[]): AgentEvent[] =>
  events.flatMap((e) => (e.type === 'subagent.event' ? [e, ...flatten([e.event])] : [e]))
const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  flatten(events).filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

type IRunResult = Awaited<ReturnType<IAgent['run']>>
const callsOf = (result: IRunResult) =>
  result.trace.flatMap((s) => s.toolCalls.map((c) => [c.name, c.ok, String(c.output)]))

/** A write tool that says when it ran. */
const noteTool = (ran: string[] = []): ToolSet => ({
  save_note: tool({
    description: 'Save a note',
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => {
      ran.push(text)
      return `saved ${text}`
    },
  }),
})

/** An approval that the person takes `ms` to give. */
const approveAfter = (ms: number, asked: string[] = []) => ({
  mode: 'ask-all' as const,
  onRequest: async (req: { toolName: string }) => {
    asked.push(req.toolName)
    await sleep(ms)
    return true
  },
})

const STEP = 400
const HUMAN = 1000

// ── approval ────────────────────────────────────────────────────────────────

test('approval: a decision that takes longer than the step limit does not end the step', async () => {
  const ran: string[] = []
  await withAgent(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    () => ({ tools: noteTool(ran), toolApproval: approveAfter(HUMAN), llmTimeoutMs: STEP }),
    async (rig) => {
      const result = await rig.agent.run({ input: 'Save it' })
      assert.deepEqual(callsOf(result), [['save_note', true, 'saved a']])
      assert.deepEqual(ran, ['a'])
      assert.equal(result.text, 'All done.')
      const [resolved] = of(rig.events, 'tool.approval-resolved')
      assert.deepEqual([resolved.approved, resolved.automatic], [true, false])
      assert.deepEqual(of(rig.events, 'error'), [])
    },
  )
})

test('approval: the step goes on with the time it had left - not with a full limit, and not with none', async () => {
  // The step may take 1000 ms. A first call uses 600 of them; the second waits 500 ms for a
  // person and then never returns: the step must end about 400 ms after the decision.
  let startedAt = 0
  let endedAt = 0
  const tools: ToolSet = {
    burn: tool({
      description: 'Takes a while',
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => {
        startedAt = Date.now()
        await sleep(600, abortSignal)
        return 'burnt'
      },
    }),
    hang: tool({
      description: 'Never returns',
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => {
        await sleep(60_000, abortSignal).catch((err) => {
          endedAt = Date.now()
          throw err
        })
        return 'never'
      },
    }),
  }
  await withAgent(
    {
      root: [[{ name: 'burn', args: {} }], [{ name: 'hang', args: {} }]],
    },
    () => ({
      tools,
      toolApproval: {
        mode: 'autopilot',
        rules: { hang: 'ask' },
        onRequest: async () => {
          await sleep(500)
          return true
        },
      },
      llmTimeoutMs: 1000,
    }),
    async (rig) => {
      await rig.agent.run({ input: 'Do both' }).catch(() => undefined)
      assert.ok(endedAt > 0, 'the step never ended')
      const took = endedAt - startedAt
      // Not paused: ~1000. Paused and resumed with a full limit: ~2100. Right: ~1500.
      assert.ok(took >= 1350, `the wait counted against the step (${took} ms)`)
      assert.ok(took < 1900, `the step got more than it had left (${took} ms)`)
    },
  )
})

test('approval: stopping the run ends the wait at once', async () => {
  const controller = new AbortController()
  await withAgent(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    () => ({
      tools: noteTool(),
      toolApproval: {
        mode: 'ask-all',
        onRequest: () => {
          setTimeout(() => controller.abort(), 30)
          return new Promise<boolean>(() => {})
        },
      },
      llmTimeoutMs: 5000,
    }),
    async (rig) => {
      const startedAt = Date.now()
      await rig.agent.run({ input: 'Save it', signal: controller.signal }).catch(() => undefined)
      assert.ok(Date.now() - startedAt < 2000, 'the stop waited for the decision')
      const [resolved] = of(rig.events, 'tool.approval-resolved')
      assert.deepEqual(
        [resolved.approved, resolved.automatic, resolved.reason],
        [false, true, 'aborted'],
      )
    },
  )
})

test("approval: its own bound (toolApproval.timeoutMs) still ends the wait, past the step's limit", async () => {
  const ran: string[] = []
  await withAgent(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    () => ({
      tools: noteTool(ran),
      toolApproval: {
        mode: 'ask-all',
        timeoutMs: HUMAN,
        onRequest: () => new Promise<boolean>(() => {}),
      },
      llmTimeoutMs: STEP,
    }),
    async (rig) => {
      const result = await rig.agent.run({ input: 'Save it' })
      // Denied by the approval's own clock; the step itself was not cut and reported it.
      const [[name, ok, output]] = callsOf(result)
      assert.deepEqual([name, ok], ['save_note', false])
      assert.match(String(output), new RegExp(`no decision within ${HUMAN}ms`))
      assert.deepEqual(ran, [])
      assert.equal(result.text, 'All done.')
    },
  )
})

// ── elicitation ─────────────────────────────────────────────────────────────

for (const era of ['legacy', 'modern'] as const) {
  const withServer = async (
    extra: Partial<IAgentConfig>,
    body: (
      rig: IRig & { server: Awaited<ReturnType<typeof startLocalMcpServer>> },
    ) => Promise<void>,
  ): Promise<void> => {
    const server = await startLocalMcpServer({ protocol: era, elicitationTools: true })
    try {
      await withAgent(
        { root: [[{ name: 'wx__elicit_form', args: {} }]] },
        () => ({
          mcpServers: {
            wx: { url: server.url, ...(era === 'modern' ? { protocol: 'modern' as const } : {}) },
          },
          llmTimeoutMs: STEP,
          ...extra,
        }),
        (rig) => body({ ...rig, server }),
      )
    } finally {
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
      async (rig) => {
        const result = await rig.agent.run({ input: 'Fill in my profile' })
        assert.deepEqual(
          callsOf(result).map(([name, ok]) => [name, ok]),
          [['wx__elicit_form', true]],
        )
        assert.equal(result.text, 'All done.')
        const [answered] = of(rig.events, 'mcp.elicitation-answered')
        assert.deepEqual([answered.action, answered.automatic], ['accept', false])
        assert.equal(JSON.stringify(rig.server.elicitations).includes('"accept"'), true)
      },
    )
  })

  test(`${era} elicitation: its own bound (elicitation.timeoutMs) still ends the wait, past the step's limit`, async () => {
    let hostSignal: AbortSignal | undefined
    await withServer(
      {
        onElicitation: (_request, ctx) => {
          hostSignal = ctx.signal
          return new Promise(() => {})
        },
        elicitation: { timeoutMs: HUMAN },
      },
      async (rig) => {
        const result = await rig.agent.run({ input: 'Fill in my profile' })
        assert.equal(hostSignal?.aborted, true, 'the host was not told the wait is over')
        const [answered] = of(rig.events, 'mcp.elicitation-answered')
        assert.deepEqual(
          [answered.action, answered.automatic, answered.reason],
          ['cancel', true, 'timeout'],
        )
        // The call failed for that reason; the step was not cut and reported it.
        const [[name, ok, output]] = callsOf(result)
        assert.deepEqual([name, ok], ['wx__elicit_form', false])
        assert.match(String(output), /elicitation\.timeoutMs/)
        assert.equal(result.text, 'All done.')
      },
    )
  })

  test(`${era} elicitation: stopping the run ends the wait at once`, async () => {
    const controller = new AbortController()
    await withServer(
      {
        onElicitation: () => {
          setTimeout(() => controller.abort(), 30)
          return new Promise(() => {})
        },
        llmTimeoutMs: 5000,
      },
      async (rig) => {
        const startedAt = Date.now()
        await rig.agent
          .run({ input: 'Fill in my profile', signal: controller.signal })
          .catch(() => undefined)
        assert.ok(Date.now() - startedAt < 2000, 'the stop waited for the answer')
        const [answered] = of(rig.events, 'mcp.elicitation-answered')
        assert.deepEqual(
          [answered.action, answered.automatic, answered.reason],
          ['cancel', true, 'aborted'],
        )
      },
    )
  })
}

// ── helpers ─────────────────────────────────────────────────────────────────

test("a helper's wait stops its own step, the step of the run that called it, and the helper's time limit", async () => {
  // Three clocks would each end this: the helper's step (400), the parent's step, which is
  // running spawn_subagent (400), and the bound on the helper as a whole (600).
  const ran: string[] = []
  const asked: string[] = []
  await withAgent(
    {
      root: [[{ name: SPAWN_SUBAGENT_TOOL, args: { task: '[[A]] save the note' } }]],
      helper: [[{ name: 'save_note', args: { text: 'h' } }]],
    },
    () => ({
      tools: noteTool(ran),
      toolApproval: {
        mode: 'autopilot',
        rules: { save_note: 'ask' },
        onRequest: async (req) => {
          asked.push(`${req.toolName}:${req.subagent ? 'helper' : 'run'}`)
          await sleep(HUMAN)
          return true
        },
      },
      subagents: { dynamic: { timeoutMs: 600, defaultTools: 'all' } },
      llmTimeoutMs: STEP,
    }),
    async (rig) => {
      const result = await rig.agent.run({ input: 'Delegate it' })
      assert.deepEqual(asked, ['save_note:helper'])
      assert.deepEqual(ran, ['h'])
      assert.deepEqual(
        callsOf(result).map(([name, ok]) => [name, ok]),
        [[SPAWN_SUBAGENT_TOOL, true]],
      )
      assert.deepEqual(of(rig.events, 'subagent.error'), [])
      assert.equal(of(rig.events, 'subagent.complete').length, 1)
      assert.equal(result.text, 'All done.')
    },
  )
})

test("a helper's time limit goes on with what it had left after the wait", async () => {
  // The helper may take 900 ms. A first call uses 400 of them; the second waits 600 ms for a
  // person and then never returns: the helper must end about 500 ms after the decision.
  let startedAt = 0
  let endedAt = 0
  const tools: ToolSet = {
    burn: tool({
      description: 'Takes a while',
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => {
        await sleep(400, abortSignal)
        return 'burnt'
      },
    }),
    hang: tool({
      description: 'Never returns',
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => {
        startedAt = Date.now()
        await sleep(60_000, abortSignal).catch((err) => {
          endedAt = Date.now()
          throw err
        })
        return 'never'
      },
    }),
  }
  await withAgent(
    {
      root: [[{ name: SPAWN_SUBAGENT_TOOL, args: { task: '[[A]] hang' } }]],
      helper: [[{ name: 'burn', args: {} }], [{ name: 'hang', args: {} }]],
    },
    () => ({
      tools,
      toolApproval: {
        mode: 'autopilot',
        rules: { hang: 'ask' },
        onRequest: async () => {
          await sleep(600)
          return true
        },
      },
      subagents: { dynamic: { timeoutMs: 900, defaultTools: 'all' } },
    }),
    async (rig) => {
      const result = await rig.agent.run({ input: 'Delegate it' })
      const [[name, ok, output]] = callsOf(result)
      assert.deepEqual([name, ok], [SPAWN_SUBAGENT_TOOL, false])
      assert.match(String(output), /the helper timed out after 900ms/)
      // The tool started after the wait. Not paused: the helper ended during the wait and the
      // tool never ran. Resumed with a full limit: ~900 ms. Right: ~500 ms, less the model's time.
      assert.ok(endedAt > 0, 'the wait counted against the helper: its tool never ran')
      const left = endedAt - startedAt
      assert.ok(left > 150, `the wait counted against the helper (${left} ms)`)
      assert.ok(left < 750, `the helper got a full limit after the wait (${left} ms)`)
    },
  )
})

test("a static subagent's wait stops the parent's step and the subagent's timeoutMs", async () => {
  const ran: string[] = []
  await withAgent(
    {
      root: [[{ name: 'researcher', args: { task: 'Save the note' } }]],
      child: [[{ name: 'save_note', args: { text: 'c' } }]],
    },
    (baseURL) => {
      return {
        tools: {
          researcher: createSubagentTool({
            name: 'researcher',
            description: 'Delegate a task',
            isolation: 'in-process',
            timeoutMs: 600,
            config: baseConfig(baseURL, {
              systemPrompt: 'CHILD AGENT',
              tools: noteTool(ran),
              toolApproval: approveAfter(HUMAN),
              llmTimeoutMs: STEP,
            }),
          }),
        },
        llmTimeoutMs: STEP,
      }
    },
    async (rig) => {
      const result = await rig.agent.run({ input: 'Delegate it' })
      assert.deepEqual(ran, ['c'])
      assert.deepEqual(
        callsOf(result).map(([name, ok]) => [name, ok]),
        [['researcher', true]],
      )
      assert.deepEqual(of(rig.events, 'subagent.error'), [])
      assert.equal(result.text, 'All done.')
    },
  )
})

test("a worker subagent: a host tool that waits for a person stops the child's step too", async () => {
  // The host tool runs in the calling run, on the parent thread; the child, in its worker,
  // is waiting for the tool's result with a step limit of its own. (No limit on the parent
  // here: starting a worker thread takes longer than a limit a test can wait out.)
  let asked = 0
  await withAgent(
    {
      root: [[{ name: 'researcher', args: { task: 'Ask the person' } }]],
      child: [[{ name: 'ask_person', args: {} }]],
    },
    (baseURL) => ({
      tools: {
        researcher: createSubagentTool({
          name: 'researcher',
          description: 'Delegate a task',
          isolation: 'worker',
          config: baseConfig(baseURL, { systemPrompt: 'CHILD AGENT', llmTimeoutMs: STEP }),
          tools: {
            ask_person: tool({
              description: 'Asks the person something',
              inputSchema: z.object({}),
              execute: async () => {
                // What the approval gate and an MCP question do while the host is asked.
                const resume = runContext.getStore()?.state?.clock?.pause()
                asked += 1
                await sleep(HUMAN)
                resume?.()
                return 'the person said yes'
              },
            }),
          },
        }),
      },
    }),
    async (rig) => {
      const result = await rig.agent.run({ input: 'Delegate it' })
      assert.equal(asked, 1)
      assert.deepEqual(
        callsOf(result).map(([name, ok]) => [name, ok]),
        [['researcher', true]],
      )
      assert.deepEqual(of(rig.events, 'subagent.error'), [])
      const childCalls = of(rig.events, 'step.tool-result').filter((e) => e.name === 'ask_person')
      assert.deepEqual(
        childCalls.map((e) => [e.ok, e.output]),
        [[true, 'the person said yes']],
      )
    },
  )
})

// ── nothing waits: nothing changes ──────────────────────────────────────────

test('no wait: a step that runs past its limit still ends there', async () => {
  let endedAt = 0
  let startedAt = 0
  const tools: ToolSet = {
    hang: tool({
      description: 'Never returns',
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => {
        startedAt = Date.now()
        await sleep(60_000, abortSignal).catch((err) => {
          endedAt = Date.now()
          throw err
        })
        return 'never'
      },
    }),
  }
  await withAgent(
    { root: [[{ name: 'hang', args: {} }]] },
    () => ({ tools, llmTimeoutMs: STEP }),
    async (rig) => {
      await rig.agent.run({ input: 'Hang' }).catch(() => undefined)
      assert.ok(endedAt > 0, 'the step never ended')
      assert.ok(endedAt - startedAt <= STEP + 50, `ended after ${endedAt - startedAt} ms`)
      assert.ok(endedAt - startedAt >= STEP - 250)
    },
  )
})
