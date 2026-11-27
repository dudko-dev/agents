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
import { useVirtualTime, type IVirtualTime } from './helpers/virtual-time.ts'

// Time spent waiting for a HUMAN - a tool approval, an MCP elicitation - is not the model's or a
// tool's latency: the step's limit (llmTimeoutMs) and a subagent's timeoutMs stop while a question
// is with the host and go on with what they had left (wait-clock.ts; its unit tests, on mocked
// timers, are in wait-clock.test.ts). Here the whole loop, over real sockets. The limits run on
// VIRTUAL time (helpers/virtual-time.ts): they move only when a test moves them - by a tool's
// work, or by a person's wait while a question is open - so the speed of the machine never
// decides a result, and what a step had left is checked to the millisecond. A worker thread does
// not share that time, and the last test keeps real timers. The elicitation's own bound past the
// step's limit is tested with the rest of the elicitation suite
// (mcp-elicitation-integration.test.ts, "time").

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

/** `p`, or a failure saying `message` if it has not settled after `ms` of real time. */
const within = async <T>(p: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

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

// Virtual milliseconds. STEP is llmTimeoutMs, which also bounds the planner's and the
// synthesizer's calls in REAL time - ample on any machine. HUMAN is longer than every limit here:
// a limit that runs on while a person is asked does not survive it.
const STEP = 10_000
const SUBAGENT = 20_000
const HUMAN = 30_000
/** Real milliseconds: the bound of a wait that is not on the clock (an approval's, a host's). */
const BOUND = 200

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

/** What a tool that never returns saw of its limit. */
interface IProbe {
  started: boolean
  /** Still running after `left - 1` ms. */
  ranOn?: boolean
  /** Ended at `left`. */
  ended?: boolean
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * A tool that takes `burnMs` of the step's time, and one that never returns: it ends with its
 * signal, which must come exactly `left` ms after it started - it is still running at `left - 1`.
 */
const slowTools = (vt: IVirtualTime, burnMs: number, left: number, probe: IProbe): ToolSet => ({
  burn: tool({
    description: 'Takes a while',
    inputSchema: z.object({}),
    execute: async () => {
      vt.tick(burnMs)
      return 'burnt'
    },
  }),
  hang: tool({
    description: 'Never returns',
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }): Promise<string> => {
      probe.started = true
      vt.tick(left - 1)
      await turn()
      probe.ranOn = abortSignal?.aborted === false
      vt.tick(1)
      await turn()
      probe.ended = abortSignal?.aborted === true
      throw abortSignal?.aborted ? abortSignal.reason : new Error('still running')
    },
  }),
})

/** What a limit had left when the hanging tool started: exactly `left`, no more and no less. */
const assertLeft = (probe: IProbe, what: string): void => {
  assert.ok(probe.started, `the wait counted against ${what}: its tool never ran`)
  assert.equal(probe.ranOn, true, `${what} ended early: the wait counted against it`)
  assert.equal(probe.ended, true, `${what} got more than it had left after the wait`)
}

/**
 * A person who takes HUMAN to answer. Every clock with a deadline must have stopped when they are
 * asked (`waits` records it): one that ran on ends its step in the tick.
 */
const humanWait = async (vt: IVirtualTime, waits: boolean[]): Promise<void> => {
  waits.push(await vt.stopped())
  vt.tick(HUMAN)
}

/** An approval that the person takes HUMAN to give. */
const approveAfter = (vt: IVirtualTime, waits: boolean[], asked: string[] = []) => ({
  mode: 'ask-all' as const,
  onRequest: async (req: { toolName: string }) => {
    asked.push(req.toolName)
    await humanWait(vt, waits)
    return true
  },
})

const NOTHING_RAN_ON = 'a time limit ran on while the person was asked'

// ── approval ────────────────────────────────────────────────────────────────

test('approval: a decision that takes longer than the step limit does not end the step', async (t) => {
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const ran: string[] = []
  await withAgent(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    () => ({ tools: noteTool(ran), toolApproval: approveAfter(vt, waits), llmTimeoutMs: STEP }),
    async (rig) => {
      const result = await rig.agent.run({ input: 'Save it' })
      assert.deepEqual(waits, [true], NOTHING_RAN_ON)
      assert.deepEqual(callsOf(result), [['save_note', true, 'saved a']])
      assert.deepEqual(ran, ['a'])
      assert.equal(result.text, 'All done.')
      const [resolved] = of(rig.events, 'tool.approval-resolved')
      assert.deepEqual([resolved.approved, resolved.automatic], [true, false])
      assert.deepEqual(of(rig.events, 'error'), [])
    },
  )
})

test('approval: the step goes on with the time it had left - not with a full limit, and not with none', async (t) => {
  // The step may take STEP. A first call uses 4000 of it; the second waits HUMAN for a person and
  // then never returns: the step must end exactly STEP - 4000 after the decision.
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const probe: IProbe = { started: false }
  await withAgent(
    {
      root: [[{ name: 'burn', args: {} }], [{ name: 'hang', args: {} }]],
    },
    () => ({
      tools: slowTools(vt, 4000, STEP - 4000, probe),
      toolApproval: {
        mode: 'autopilot',
        rules: { hang: 'ask' },
        onRequest: async () => {
          await humanWait(vt, waits)
          return true
        },
      },
      llmTimeoutMs: STEP,
    }),
    async (rig) => {
      await rig.agent.run({ input: 'Do both' }).catch(() => undefined)
      assertLeft(probe, 'the step')
      assert.deepEqual(waits, [true], NOTHING_RAN_ON)
    },
  )
})

test('approval: stopping the run ends the wait at once', async (t) => {
  // The person never decides, and the step's limit does not move: only the stop can end this.
  useVirtualTime(t)
  const controller = new AbortController()
  let stoppedAt = 0
  await withAgent(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    () => ({
      tools: noteTool(),
      toolApproval: {
        mode: 'ask-all',
        onRequest: () => {
          setTimeout(() => {
            stoppedAt = Date.now()
            controller.abort()
          }, 30)
          return new Promise<boolean>(() => {})
        },
      },
      llmTimeoutMs: STEP,
    }),
    async (rig) => {
      await within(
        rig.agent.run({ input: 'Save it', signal: controller.signal }).catch(() => undefined),
        10_000,
        'the stop waited for the decision',
      )
      assert.ok(Date.now() - stoppedAt < 5000, 'the stop waited')
      const [resolved] = of(rig.events, 'tool.approval-resolved')
      assert.deepEqual(
        [resolved.approved, resolved.automatic, resolved.reason],
        [false, true, 'aborted'],
      )
    },
  )
})

test("approval: a time limit the host put on the run's signal is a stop - it is not paused", async (t) => {
  // The config has no run-level time limit; a host's own AbortSignal.timeout() on the run is
  // the only one, and it ends a wait like any stop. It is set when the person is asked, so that
  // it runs out during the wait however long the run took to get there; the step's own limit
  // does not move meanwhile.
  useVirtualTime(t)
  const host = new AbortController()
  await withAgent(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    () => ({
      tools: noteTool(),
      toolApproval: {
        mode: 'ask-all',
        onRequest: () => {
          const limit = AbortSignal.timeout(BOUND)
          limit.addEventListener('abort', () => host.abort(limit.reason), { once: true })
          return new Promise<boolean>(() => {})
        },
      },
      llmTimeoutMs: STEP,
    }),
    async (rig) => {
      // (`within` also keeps Node alive: AbortSignal.timeout does not, and nothing else would.)
      await within(
        rig.agent.run({ input: 'Save it', signal: host.signal }).catch(() => {}),
        10_000,
        "the host's limit waited for the person",
      )
      assert.equal((host.signal.reason as Error).name, 'TimeoutError')
      const [resolved] = of(rig.events, 'tool.approval-resolved')
      assert.deepEqual(
        [resolved.approved, resolved.automatic, resolved.reason],
        [false, true, 'aborted'],
      )
    },
  )
})

test("approval: its own bound (toolApproval.timeoutMs) still ends the wait, past the step's limit", async (t) => {
  // The person never decides. HUMAN of the step's time passes while they are asked - more than
  // its limit - and the approval's own bound (real time, not on the clock) ends the wait.
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const ran: string[] = []
  await withAgent(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    () => ({
      tools: noteTool(ran),
      toolApproval: {
        mode: 'ask-all',
        timeoutMs: BOUND,
        onRequest: async () => {
          await humanWait(vt, waits)
          return new Promise<boolean>(() => {})
        },
      },
      llmTimeoutMs: STEP,
    }),
    async (rig) => {
      const result = await rig.agent.run({ input: 'Save it' })
      assert.deepEqual(waits, [true], NOTHING_RAN_ON)
      // Denied by the approval's own clock; the step itself was not cut and reported it.
      const [[name, ok, output]] = callsOf(result)
      assert.deepEqual([name, ok], ['save_note', false])
      assert.match(String(output), new RegExp(`no decision within ${BOUND}ms`))
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

  test(`${era} elicitation: an answer that takes longer than the step limit does not end the step`, async (t) => {
    const vt = useVirtualTime(t)
    const waits: boolean[] = []
    await withServer(
      {
        onElicitation: async () => {
          await humanWait(vt, waits)
          return { action: 'accept', content: { name: 'Ada', email: 'a@b.test' } }
        },
      },
      async (rig) => {
        const result = await rig.agent.run({ input: 'Fill in my profile' })
        assert.deepEqual(waits, [true], NOTHING_RAN_ON)
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

  test(`${era} elicitation: stopping the run ends the wait at once`, async (t) => {
    // The person never answers, and the step's limit does not move: only the stop can end this.
    useVirtualTime(t)
    const controller = new AbortController()
    let stoppedAt = 0
    await withServer(
      {
        onElicitation: () => {
          setTimeout(() => {
            stoppedAt = Date.now()
            controller.abort()
          }, 30)
          return new Promise(() => {})
        },
      },
      async (rig) => {
        await within(
          rig.agent
            .run({ input: 'Fill in my profile', signal: controller.signal })
            .catch(() => undefined),
          10_000,
          'the stop waited for the answer',
        )
        assert.ok(Date.now() - stoppedAt < 5000, 'the stop waited')
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

test("a helper's wait stops its own step, the step of the run that called it, and the helper's time limit", async (t) => {
  // Three clocks would each end this: the helper's step (STEP), the parent's step, which is
  // running spawn_subagent (STEP), and the bound on the helper as a whole (SUBAGENT).
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
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
          await humanWait(vt, waits)
          return true
        },
      },
      subagents: { dynamic: { timeoutMs: SUBAGENT, defaultTools: 'all' } },
      llmTimeoutMs: STEP,
    }),
    async (rig) => {
      const result = await rig.agent.run({ input: 'Delegate it' })
      assert.deepEqual(asked, ['save_note:helper'])
      assert.deepEqual(waits, [true], NOTHING_RAN_ON)
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

test("a helper's time limit goes on with what it had left after the wait", async (t) => {
  // The helper may take 9000. A first call uses 4000 of them; the second waits HUMAN for a
  // person and then never returns: the helper must end exactly 5000 after the decision.
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const probe: IProbe = { started: false }
  await withAgent(
    {
      root: [[{ name: SPAWN_SUBAGENT_TOOL, args: { task: '[[A]] hang' } }]],
      helper: [[{ name: 'burn', args: {} }], [{ name: 'hang', args: {} }]],
    },
    () => ({
      tools: slowTools(vt, 4000, 5000, probe),
      toolApproval: {
        mode: 'autopilot',
        rules: { hang: 'ask' },
        onRequest: async () => {
          await humanWait(vt, waits)
          return true
        },
      },
      subagents: { dynamic: { timeoutMs: 9000, defaultTools: 'all' } },
    }),
    async (rig) => {
      const result = await rig.agent.run({ input: 'Delegate it' })
      assertLeft(probe, 'the helper')
      assert.deepEqual(waits, [true], NOTHING_RAN_ON)
      const [[name, ok, output]] = callsOf(result)
      assert.deepEqual([name, ok], [SPAWN_SUBAGENT_TOOL, false])
      assert.match(String(output), /the helper timed out after 9000ms/)
    },
  )
})

test("a static subagent's wait stops the parent's step and the subagent's timeoutMs", async (t) => {
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
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
            timeoutMs: SUBAGENT,
            config: baseConfig(baseURL, {
              systemPrompt: 'CHILD AGENT',
              tools: noteTool(ran),
              toolApproval: approveAfter(vt, waits),
              llmTimeoutMs: STEP,
            }),
          }),
        },
        llmTimeoutMs: STEP,
      }
    },
    async (rig) => {
      const result = await rig.agent.run({ input: 'Delegate it' })
      assert.deepEqual(waits, [true], NOTHING_RAN_ON)
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
  // The host tool runs in the calling run, on the parent thread; the child, in its worker
  // thread, is waiting for the tool's result with a step limit of its own. A worker thread does
  // not share the test's virtual time, so this one is on real timers: the child's limit is far
  // above the child's own work, and the person takes longer than all of it. (No limit on the
  // parent here: starting a worker thread takes longer than a limit a test can wait out.)
  const childStep = 1500
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
          config: baseConfig(baseURL, { systemPrompt: 'CHILD AGENT', llmTimeoutMs: childStep }),
          tools: {
            ask_person: tool({
              description: 'Asks the person something',
              inputSchema: z.object({}),
              execute: async () => {
                // What the approval gate and an MCP question do while the host is asked.
                const resume = runContext.getStore()?.state?.clock?.pause()
                asked += 1
                await sleep(childStep + 500)
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

test('no wait: a step that runs past its limit still ends there', async (t) => {
  const vt = useVirtualTime(t)
  const probe: IProbe = { started: false }
  await withAgent(
    { root: [[{ name: 'hang', args: {} }]] },
    () => ({ tools: slowTools(vt, 0, STEP, probe), llmTimeoutMs: STEP }),
    async (rig) => {
      await rig.agent.run({ input: 'Hang' }).catch(() => undefined)
      assert.ok(probe.started, 'the step never ran its tool')
      assert.equal(probe.ranOn, true, 'the step ended before its limit')
      assert.equal(probe.ended, true, 'the step ran past its limit')
    },
  )
})

test('no wait, on real timers: a step that runs past its limit still ends there', async () => {
  // Without a test's time the limits are real timers (Date.now / setTimeout).
  const limit = 1000
  let endedAt = 0
  const tools: ToolSet = {
    hang: tool({
      description: 'Never returns',
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal }) => {
        await sleep(20_000, abortSignal).catch((err) => {
          endedAt = Date.now()
          throw err
        })
        return 'never'
      },
    }),
  }
  await withAgent(
    { root: [[{ name: 'hang', args: {} }]] },
    () => ({ tools, llmTimeoutMs: limit }),
    async (rig) => {
      const startedAt = Date.now()
      await rig.agent.run({ input: 'Hang' }).catch(() => undefined)
      assert.ok(endedAt > 0, 'the step never ended')
      // It started with the step, after the run did (a timer may fire a little early on a busy
      // event loop: Node counts from the loop's cached time).
      assert.ok(
        endedAt - startedAt >= limit * 0.8,
        `ended ${endedAt - startedAt} ms after the start`,
      )
    },
  )
})
