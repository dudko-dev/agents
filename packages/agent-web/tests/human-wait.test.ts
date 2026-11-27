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
import { useVirtualTime, type IVirtualTime } from './helpers/virtual-time.ts'

// Time spent waiting for a HUMAN - a tool approval, an MCP elicitation - is not the model's or a
// tool's latency: the step's limit (chatTimeoutMs, 120 s by default) and a subagent's timeoutMs
// stop while a question is with the host and go on with what they had left (wait-clock.ts, the
// same file as the Node package's, unit-tested there on mocked timers). Here the whole loop on a
// scripted model. The limits run on VIRTUAL time (helpers/virtual-time.ts): they move only when a
// test moves them - by a tool's work, or by a person's wait while a question is open - so the
// speed of the machine never decides a result, and what a step had left is checked to the
// millisecond. The last test keeps real timers. The Node sibling's `tests/human-wait.test.ts`;
// the elicitation's own bound past the step's limit is in `mcp-elicitation-agent.test.ts`
// ("time").

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

// Virtual milliseconds. STEP is chatTimeoutMs, which also bounds the planner's and the
// synthesizer's calls in REAL time - ample on any machine. HUMAN is longer than every limit here:
// a limit that runs on while a person is asked does not survive it.
const STEP = 10_000
const SUBAGENT = 20_000
const HUMAN = 30_000
/** Real milliseconds: the bound of a wait that is not on the clock (an approval's, a host's). */
const BOUND = 200
/** Real milliseconds a clock in a worker is given to hear of a wait (it takes a message or two). */
const WORKER = 5000

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

/** What a tool that never returns saw of its limit. */
interface Probe {
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
const slowTools = (vt: IVirtualTime, burnMs: number, left: number, probe: Probe) => ({
  burn: defineTool({
    description: 'Takes a while',
    inputSchema: z.object({}),
    execute: async () => {
      vt.tick(burnMs)
      return 'burnt'
    },
  }),
  hang: defineTool({
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
const assertLeft = (probe: Probe, what: string): void => {
  assert.ok(probe.started, `the wait counted against ${what}: its tool never ran`)
  assert.equal(probe.ranOn, true, `${what} ended early: the wait counted against it`)
  assert.equal(probe.ended, true, `${what} got more than it had left after the wait`)
}

/**
 * A person who takes HUMAN to answer. Every clock with a deadline must have stopped when they are
 * asked (`waits` records it; a clock in a worker is told by message: `workerMs` gives it that
 * long): one that ran on ends its step in the tick.
 */
const humanWait = async (vt: IVirtualTime, waits: boolean[], workerMs = 0): Promise<void> => {
  waits.push(await vt.stopped(workerMs))
  vt.tick(HUMAN)
}

/** An approval that the person takes HUMAN to give. */
const approveAfter = (
  vt: IVirtualTime,
  waits: boolean[],
  asked: string[] = [],
  rules?: ToolApprovalConfig['rules'],
  workerMs = 0,
) =>
  ({
    mode: rules ? 'autopilot' : 'ask-all',
    ...(rules ? { rules } : {}),
    onRequest: async (req) => {
      asked.push(`${req.toolName}${req.subagent ? ':helper' : ''}`)
      await humanWait(vt, waits, workerMs)
      return true
    },
  }) satisfies ToolApprovalConfig

const NOTHING_RAN_ON = 'a time limit ran on while the person was asked'

// ── approval ────────────────────────────────────────────────────────────────

test('approval: a decision that takes longer than the step limit does not end the step', async (t) => {
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const ran: string[] = []
  const r = await rig(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    { tools: noteTool(ran), toolApproval: approveAfter(vt, waits), chatTimeoutMs: STEP },
  )
  const result = await r.go()
  assert.deepEqual(waits, [true], NOTHING_RAN_ON)
  assert.deepEqual(callsOf(result), [['save_note', true, 'saved a']])
  assert.deepEqual(ran, ['a'])
  assert.equal(result.final, 'All done.')
  const [resolved] = of(r.events, 'tool.approval-resolved')
  assert.deepEqual([resolved.approved, resolved.automatic], [true, false])
  assert.deepEqual(of(r.events, 'error'), [])
})

test('approval: the step goes on with the time it had left - not with a full limit, and not with none', async (t) => {
  // The step may take STEP. A first call uses 4000 of it; the second waits HUMAN for a person and
  // then never returns: the step must end exactly STEP - 4000 after the decision.
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const probe: Probe = { started: false }
  const r = await rig(
    { root: [[{ name: 'burn', args: {} }], [{ name: 'hang', args: {} }]] },
    {
      tools: slowTools(vt, 4000, STEP - 4000, probe),
      toolApproval: approveAfter(vt, waits, [], { hang: 'ask' }),
      chatTimeoutMs: STEP,
    },
  )
  await r.go()
  assertLeft(probe, 'the step')
  assert.deepEqual(waits, [true], NOTHING_RAN_ON)
})

test('approval: stopping the run ends the wait at once', async (t) => {
  // The person never decides, and the step's limit does not move: only the stop can end this.
  useVirtualTime(t)
  const controller = new AbortController()
  let stoppedAt = 0
  const r = await rig(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    {
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
      chatTimeoutMs: STEP,
    },
  )
  const result = await within(
    r.go({ signal: controller.signal }),
    10_000,
    'the stop waited for the decision',
  )
  assert.ok(Date.now() - stoppedAt < 5000, 'the stop waited')
  assert.equal(result.stopped, true)
  const [resolved] = of(r.events, 'tool.approval-resolved')
  assert.deepEqual([resolved.approved, resolved.automatic], [false, true])
})

test("approval: a time limit the host put on the run's signal is a stop - it is not paused", async (t) => {
  // The config has no run-level time limit; a host's own AbortSignal.timeout() on the run is
  // the only one, and it ends a wait like any stop. It is set when the person is asked, so that
  // it runs out during the wait however long the run took to get there; the step's own limit
  // does not move meanwhile.
  useVirtualTime(t)
  const host = new AbortController()
  const r = await rig(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    {
      tools: noteTool(),
      toolApproval: {
        mode: 'ask-all',
        onRequest: () => {
          const limit = AbortSignal.timeout(BOUND)
          limit.addEventListener('abort', () => host.abort(limit.reason), { once: true })
          return new Promise<boolean>(() => {})
        },
      },
      chatTimeoutMs: STEP,
    },
  )
  // (`within` also keeps Node alive: AbortSignal.timeout does not, and nothing else would here.)
  const result = await within(
    r.go({ signal: host.signal }),
    10_000,
    "the host's limit waited for the person",
  )
  assert.equal((host.signal.reason as Error).name, 'TimeoutError')
  assert.equal(result.stopped, true)
  const [resolved] = of(r.events, 'tool.approval-resolved')
  assert.deepEqual([resolved.approved, resolved.automatic], [false, true])
})

test("approval: its own bound (toolApproval.timeoutMs) still ends the wait, past the step's limit", async (t) => {
  // The person never decides. HUMAN of the step's time passes while they are asked - more than
  // its limit - and the approval's own bound (real time, not on the clock) ends the wait.
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const ran: string[] = []
  const r = await rig(
    { root: [[{ name: 'save_note', args: { text: 'a' } }]] },
    {
      tools: noteTool(ran),
      toolApproval: {
        mode: 'ask-all',
        timeoutMs: BOUND,
        onRequest: async () => {
          await humanWait(vt, waits)
          return new Promise<boolean>(() => {})
        },
      },
      chatTimeoutMs: STEP,
    },
  )
  const result = await r.go()
  assert.deepEqual(waits, [true], NOTHING_RAN_ON)
  // Denied by the approval's own clock; the step itself was not cut and reported it.
  const [[name, ok, output]] = callsOf(result)
  assert.deepEqual([name, ok], ['save_note', false])
  assert.match(String(output), new RegExp(`no approval decision within ${BOUND} ms`))
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

/** A worker for a subagent: the worker's side served on a MessageChannel in this thread. */
const channelWorker = (model: ReturnType<typeof scriptedModel>, opened: MessagePort[]) => () => {
  const channel = new MessageChannel()
  opened.push(channel.port1, channel.port2)
  serveSubagentWorker({ scope: channel.port2, resolveModel: () => model.model })
  channel.port1.start()
  channel.port2.start()
  return Object.assign(channel.port1, {
    terminate: () => {
      channel.port1.close()
      channel.port2.close()
    },
  })
}

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
      {},
      async (r) => {
        const result = await r.go()
        assert.deepEqual(waits, [true], NOTHING_RAN_ON)
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

  test(`${era} elicitation: a worker subagent's host tool asks the user - the calling step, the subagent's limit and the child's step stop`, async (t) => {
    // The MCP tool runs on the main thread for the child in the worker, with no run of its own:
    // the mark the subagent tool puts on it carries the calling run's clock.
    const vt = useVirtualTime(t)
    const waits: boolean[] = []
    const server = await startLocalMcpServer({ protocol: era, elicitationTools: true })
    const mcp = await connectMcpHttp(
      { wx: { url: server.url, ...(era === 'modern' ? { protocol: 'modern' as const } : {}) } },
      {
        onElicitation: async () => {
          await humanWait(vt, waits, WORKER)
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
              timeoutMs: SUBAGENT,
              worker: channelWorker(child, opened),
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
      assert.deepEqual(waits, [true], NOTHING_RAN_ON)
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
      {},
      async (r) => {
        await within(r.go({ signal: controller.signal }), 10_000, 'the stop waited for the answer')
        assert.ok(Date.now() - stoppedAt < 5000, 'the stop waited')
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

test("a helper's wait stops its own step, the step of the run that called it, and the helper's time limit", async (t) => {
  // Three clocks would each end this: the helper's step (STEP), the parent's step, which is
  // running spawn_subagent (STEP), and the bound on the helper as a whole (SUBAGENT).
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const ran: string[] = []
  const asked: string[] = []
  const r = await rig(
    {
      root: [[{ name: SPAWN_SUBAGENT_TOOL, args: { task: '[[A]] save the note' } }]],
      helper: [[{ name: 'save_note', args: { text: 'h' } }]],
    },
    {
      tools: noteTool(ran),
      toolApproval: approveAfter(vt, waits, asked, { save_note: 'ask' }),
      subagents: { dynamic: { timeoutMs: SUBAGENT, defaultTools: 'all' } },
      chatTimeoutMs: STEP,
    },
  )
  const result = await r.go()
  assert.deepEqual(asked, ['save_note:helper'])
  assert.deepEqual(waits, [true], NOTHING_RAN_ON)
  assert.deepEqual(ran, ['h'])
  assert.deepEqual(
    callsOf(result).map(([name, ok]) => [name, ok]),
    [[SPAWN_SUBAGENT_TOOL, true]],
  )
  assert.deepEqual(of(r.events, 'subagent.error'), [])
  assert.equal(of(r.events, 'subagent.complete').length, 1)
  assert.equal(result.final, 'All done.')
})

test("a helper's time limit goes on with what it had left after the wait", async (t) => {
  // The helper may take 9000. A first call uses 4000 of them; the second waits HUMAN for a
  // person and then never returns: the helper must end exactly 5000 after the decision.
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const probe: Probe = { started: false }
  const r = await rig(
    {
      root: [[{ name: SPAWN_SUBAGENT_TOOL, args: { task: '[[A]] hang' } }]],
      helper: [[{ name: 'burn', args: {} }], [{ name: 'hang', args: {} }]],
    },
    {
      tools: slowTools(vt, 4000, 5000, probe),
      toolApproval: approveAfter(vt, waits, [], { hang: 'ask' }),
      subagents: { dynamic: { timeoutMs: 9000, defaultTools: 'all' } },
    },
  )
  const result = await r.go()
  assertLeft(probe, 'the helper')
  assert.deepEqual(waits, [true], NOTHING_RAN_ON)
  const [[name, ok, output]] = callsOf(result)
  assert.deepEqual([name, ok], [SPAWN_SUBAGENT_TOOL, false])
  assert.match(String(output), /the helper timed out after 9000ms/)
})

test("an in-process subagent's own approval stops the parent's step and the subagent's timeoutMs", async (t) => {
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const ran: string[] = []
  const child = childModel([{ name: 'save_note', args: { text: 'c' } }])
  const r = await rig(
    { root: [[{ name: 'researcher', args: { task: 'Save the note' } }]] },
    {
      tools: {
        researcher: createSubagentTool({
          name: 'researcher',
          description: 'Delegate a task',
          timeoutMs: SUBAGENT,
          config: {
            model: child.model,
            toolMode: 'native',
            tools: noteTool(ran),
            toolApproval: approveAfter(vt, waits),
            chatTimeoutMs: STEP,
          },
        }),
      },
      chatTimeoutMs: STEP,
    },
  )
  const result = await r.go()
  assert.deepEqual(waits, [true], NOTHING_RAN_ON)
  assert.deepEqual(ran, ['c'])
  assert.deepEqual(
    callsOf(result).map(([name, ok]) => [name, ok]),
    [['researcher', true]],
  )
  assert.deepEqual(of(r.events, 'subagent.error'), [])
  assert.equal(result.final, 'All done.')
})

test("an in-process subagent's host tool, asked about by the PARENT's gate: no clock of the three runs on", async (t) => {
  // The host tool runs in the child's step (STEP), behind the parent's consent gate; the
  // parent's step (STEP) is running the subagent, which has a bound of its own (SUBAGENT).
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
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
          timeoutMs: SUBAGENT,
          config: { model: child.model, toolMode: 'native', chatTimeoutMs: STEP },
          tools: noteTool(ran),
        }),
      },
      toolApproval: approveAfter(vt, waits, asked, { save_note: 'ask' }),
      chatTimeoutMs: STEP,
    },
  )
  const result = await r.go()
  assert.deepEqual(asked, ['save_note'])
  assert.deepEqual(waits, [true], NOTHING_RAN_ON)
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

test("a worker subagent's host tool, asked about by the parent's gate: the child's step in the worker stops too", async (t) => {
  const vt = useVirtualTime(t)
  const waits: boolean[] = []
  const ran: string[] = []
  const asked: string[] = []
  const child = childModel([{ name: 'save_note', args: { text: 'w' } }])
  const opened: MessagePort[] = []
  try {
    const r = await rig(
      { root: [[{ name: 'researcher', args: { task: 'Save the note' } }]] },
      {
        tools: {
          researcher: createSubagentTool({
            name: 'researcher',
            description: 'Delegate a task',
            timeoutMs: SUBAGENT,
            worker: channelWorker(child, opened),
            workerConfig: {
              model: { providerType: 'openai', model: 'child' },
              toolMode: 'native',
              chatTimeoutMs: STEP,
            },
            tools: noteTool(ran),
          }),
        },
        toolApproval: approveAfter(vt, waits, asked, { save_note: 'ask' }, WORKER),
        chatTimeoutMs: STEP,
      },
    )
    const result = await r.go()
    assert.deepEqual(asked, ['save_note'])
    assert.deepEqual(waits, [true], NOTHING_RAN_ON)
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

test('no wait: a step that runs past its limit still ends there', async (t) => {
  const vt = useVirtualTime(t)
  const probe: Probe = { started: false }
  const r = await rig(
    { root: [[{ name: 'hang', args: {} }]] },
    { tools: slowTools(vt, 0, STEP, probe), chatTimeoutMs: STEP },
  )
  await r.go()
  assert.ok(probe.started, 'the step never ran its tool')
  assert.equal(probe.ranOn, true, 'the step ended before its limit')
  assert.equal(probe.ended, true, 'the step ran past its limit')
})

test('no wait, on real timers: a step that runs past its limit still ends there', async () => {
  // Without a test's time the limits are real timers (Date.now / setTimeout).
  const limit = 1000
  let endedAt = 0
  const r = await rig(
    { root: [[{ name: 'hang', args: {} }]] },
    {
      tools: {
        hang: defineTool({
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
      },
      chatTimeoutMs: limit,
    },
  )
  const startedAt = Date.now()
  await r.go()
  assert.ok(endedAt > 0, 'the step never ended')
  // It started with the step, after the run did (a timer may fire a little early on a busy
  // event loop: Node counts from the loop's cached time).
  assert.ok(endedAt - startedAt >= limit * 0.8, `ended ${endedAt - startedAt} ms after the start`)
})
