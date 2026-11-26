import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import {
  adoptSubagentEvent,
  createAgent,
  createRunControl,
  createSubagentTool,
  markReadOnly,
  resolveDynamicSubagents,
  SPAWN_INPUT_SCHEMA,
  SPAWN_SUBAGENT_TOOL,
  SUBAGENT_DEFAULTS,
  SUBAGENT_MAX_DEPTH_LIMIT,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type IRunSnapshot,
  type IToolApprovalRequest,
} from '../src/index.ts'
import { parseSubagents } from '../src/cli/config.ts'
import {
  assertSpawnAllowed,
  cleanSpawnInput,
  createSpawnGate,
  narrowSubagentTools,
  renderSubagentTask,
  shareSubagentBudget,
} from '../src/subagent-dynamic-shared.ts'
import {
  startLocalOpenAI,
  systemOf,
  toolNames,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type IScriptedReply,
  type Script,
} from './helpers/openai-server.ts'

// Dynamic subagents (config.subagents.dynamic): helpers the MODEL starts with spawn_subagent.
// Over real sockets against the scripted OpenAI-compatible endpoint. This is a privilege
// boundary - a helper may only have less than the run that starts it - so the assertions read
// what each helper was really offered and really did on the wire, not what the events claim.

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}
const stepOf = (req: IChatRequest): string =>
  /CURRENT STEP to execute \(id=([^)]+)\)/.exec(userOf(req))?.[1] ?? '?'

// Whose request it is: the run's own ('root'), or the helper whose task carries a [[marker]].
// Read from the request line of the prompt only - a parent's trace quotes its helpers' tasks.
const whoOf = (req: IChatRequest): string => {
  const user = userOf(req)
  const from = user.indexOf('ser request:\n')
  let own = from < 0 ? user : user.slice(from)
  for (const end of [
    '\nOverall plan:',
    '\nPlan that was executed:',
    '\nCurrent plan:',
    '\nUser request:',
  ]) {
    const at = own.indexOf(end, 5)
    if (at > 0) own = own.slice(0, at)
  }
  return /\[\[(\w+)\]\]/.exec(own)?.[1] ?? 'root'
}

const planJson = (ids: string[]): string =>
  JSON.stringify({
    thought: 'Plan.',
    steps: ids.map((id) => ({
      id,
      description: `Step ${id}`,
      expectedOutcome: `${id} done`,
      suggestedTools: [],
    })),
  })

interface IActor {
  // The ids of its plan's steps (default one step, s1).
  steps?: string[]
  // Its executor: `round` is how many tool results the step's conversation already holds.
  exec?: (req: IChatRequest, step: string, round: number) => IScriptedReply
  // Its synthesizer's answer.
  final?: string
  plan?: (req: IChatRequest) => IScriptedReply
}

const play =
  (actors: Record<string, IActor>): Script =>
  (req) => {
    const who = whoOf(req)
    const actor = actors[who] ?? {}
    switch (stageOf(req)) {
      case 'planner':
        return actor.plan?.(req) ?? { text: planJson(actor.steps ?? ['s1']) }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'on track' }) }
      case 'synthesizer':
        return { text: actor.final ?? `${who} answer` }
      default:
        return (
          actor.exec?.(req, stepOf(req), toolResults(req).length) ?? {
            text: `${who} did ${stepOf(req)}`,
          }
        )
    }
  }

const spawn = (args: Record<string, unknown>) => ({ name: SPAWN_SUBAGENT_TOOL, args })
// An executor that makes these calls in its first round and reports what came back.
const callsThen =
  (...calls: { name: string; args: unknown }[]): IActor['exec'] =>
  (req, _step, round) =>
    round === 0 ? { toolCalls: calls } : { text: `results: ${toolResults(req).join(' | ')}` }

const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'dynamic-subagents',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'std',
  mcpServers: {},
  maxIterations: 6,
  maxStepsPerTask: 6,
  llmMaxRetries: 0,
  logLevel: 'none',
  subagents: { dynamic: true },
  ...extra,
})

interface IHarness {
  llm: ILocalOpenAI
  agent: IAgent
  events: AgentEvent[]
  by: (who: string, stage?: Stage) => IChatRequest[]
}

const withAgent = async (
  script: Script,
  extra: Partial<IAgentConfig>,
  body: (h: IHarness) => Promise<void>,
): Promise<void> => {
  const llm = await startLocalOpenAI(script)
  let agent: IAgent | undefined
  try {
    agent = await createAgent(config(llm.baseURL, extra))
    await body({
      llm,
      agent,
      events: [],
      by: (who, stage) =>
        llm.requests.filter((r) => whoOf(r) === who && (!stage || stageOf(r) === stage)),
    })
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
  }
}

const go = (h: IHarness, opts: Partial<Parameters<IAgent['run']>[0]> = {}) =>
  h.agent.run({ input: 'Do the work', onEvent: (e) => h.events.push(e), ...opts })

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

// Every event of the run, the helpers' unwrapped: [the chain of subagent ids above it, the event].
const flatten = (events: AgentEvent[], chain: string[] = []): [string[], AgentEvent][] =>
  events.flatMap((e): [string[], AgentEvent][] =>
    e.type === 'subagent.event'
      ? [[chain, e], ...flatten([e.event], [...chain, e.id])]
      : [[chain, e]],
  )
const deep = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  flatten(events)
    .map(([, e]) => e)
    .filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

// The result of the run's first tool call, as the model saw it.
const firstResult = (h: IHarness, who = 'root'): string =>
  h.by(who, 'executor').flatMap((r) => toolResults(r))[0] ?? ''

// A host with one tool that reads and one that writes; `log` is what really ran.
const notes = () => {
  const log: string[] = []
  const tools: ToolSet = {
    read_note: markReadOnly(
      tool({
        description: 'Read a note.',
        inputSchema: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          log.push(`read:${id}`)
          return `note ${id}`
        },
      }),
    ),
    write_note: tool({
      description: 'Write a note.',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        log.push(`write:${text}`)
        return `saved ${text}`
      },
    }),
  }
  return { log, tools }
}

// ── spawn, and the answer back ───────────────────────────────────────────

test('spawn: the helper runs the loop on the task and its answer is the tool result', async () => {
  const { tools, log } = notes()
  await withAgent(
    play({
      root: {
        exec: callsThen(spawn({ task: '[[A]] Find the note n1', role: 'A careful reader' })),
      },
      A: {
        exec: callsThen({ name: 'read_note', args: { id: 'n1' } }),
        final: 'The note says: note n1',
      },
    }),
    { tools, systemPrompt: 'OPERATOR RULES' },
    async (h) => {
      const result = await go(h)
      assert.equal(result.text, 'root answer')
      assert.equal(firstResult(h), 'The note says: note n1')
      assert.deepEqual(log, ['read:n1'])
      const call = result.trace[0].toolCalls[0]
      assert.deepEqual(
        [call.name, call.ok, call.output],
        [SPAWN_SUBAGENT_TOOL, true, 'The note says: note n1'],
      )

      // The helper ran the whole loop: a plan, the step (two rounds), an answer.
      assert.deepEqual(h.by('A').map(stageOf), ['planner', 'executor', 'executor', 'synthesizer'])
      for (const req of h.by('A')) {
        // CONTEXT: the task, not the parent's request or transcript.
        assert.ok(!userOf(req).includes('Do the work'), stageOf(req))
        // The operator's system prompt is the operator's; the role is model-written text and is
        // part of the task, under a line that says where it came from.
        assert.match(systemOf(req), /OPERATOR RULES/)
        assert.ok(!systemOf(req).includes('A careful reader'), stageOf(req))
        assert.match(
          userOf(req),
          /Your role for this task, as described by the agent that delegated/,
        )
        assert.match(userOf(req), /A careful reader\n\nTask:\n\[\[A\]\] Find the note n1/)
      }
      assert.equal(
        renderSubagentTask({ task: 'T', role: 'R' }),
        'Your role for this task, as described by the agent that delegated it to you:\nR\n\nTask:\nT',
      )
      assert.equal(renderSubagentTask({ task: 'T' }), 'T')
    },
  )
})

test("usage: a helper's tokens are charged to the parent run and to agent.usage, once", async () => {
  await withAgent(
    play({ root: { exec: callsThen(spawn({ task: '[[A]] think' })) } }),
    {},
    async (h) => {
      const result = await go(h)
      // Helper: plan + step + answer = 3 calls; root: plan + 2 executor rounds + answer = 4.
      assert.equal(h.by('A').length, 3)
      assert.equal(h.by('root').length, 4)
      assert.equal(result.usage.totalTokens, 7 * 15)
      assert.equal(h.agent.usage.totalTokens, 7 * 15)
      const charged = of(h.events, 'usage').filter((e) => e.phase === 'subagent')
      assert.equal(
        charged.reduce((n, e) => n + e.usage.totalTokens, 0),
        3 * 15,
      )
      assert.equal(of(h.events, 'subagent.complete')[0].usage.totalTokens, 3 * 15)
    },
  )
})

// ── narrowing ────────────────────────────────────────────────────────────

test('tools: without a list a helper gets the read-only tools; "all" is a host decision', async () => {
  for (const [defaultTools, expected] of [
    [undefined, ['read_note']],
    ['all', ['read_note', 'write_note']],
  ] as const) {
    const { tools } = notes()
    await withAgent(
      play({ root: { exec: callsThen(spawn({ task: '[[A]] look' })) } }),
      { tools, subagents: { dynamic: defaultTools ? { defaultTools } : true } },
      async (h) => {
        await go(h)
        assert.deepEqual(toolNames(h.by('A', 'executor')[0]), expected)
        assert.deepEqual(of(h.events, 'subagent.start')[0].tools, expected)
        // The parent itself has everything, the spawn tool included.
        assert.deepEqual(toolNames(h.by('root', 'executor')[0]).sort(), [
          'read_note',
          SPAWN_SUBAGENT_TOOL,
          'write_note',
        ])
      },
    )
  }
})

test('tools: a named subset is exactly what the helper is offered', async () => {
  const { tools, log } = notes()
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] write it', tools: ['write_note'] })) },
      A: { exec: callsThen({ name: 'write_note', args: { text: 'x' } }) },
    }),
    { tools },
    async (h) => {
      await go(h)
      assert.deepEqual(toolNames(h.by('A', 'executor')[0]), ['write_note'])
      assert.deepEqual(log, ['write:x'])
      // [] is a helper that only reasons.
    },
  )
  await withAgent(
    play({ root: { exec: callsThen(spawn({ task: '[[A]] think', tools: [] })) } }),
    { tools: notes().tools },
    async (h) => {
      await go(h)
      assert.deepEqual(toolNames(h.by('A', 'executor')[0]), [])
    },
  )
})

test('tools: a tool the parent lacks is refused - not dropped - and no helper starts', async () => {
  const { tools } = notes()
  const secret = tool({
    description: 'A tool the operator excluded.',
    inputSchema: z.object({}),
    execute: async () => 'secret',
  })
  await withAgent(
    play({
      root: {
        steps: ['s1', 's2'],
        exec: (req, step, round) =>
          round > 0
            ? { text: `results: ${toolResults(req).join(' | ')}` }
            : {
                toolCalls: [
                  spawn({
                    task: '[[A]] go',
                    tools: step === 's1' ? ['read_note', 'delete_everything'] : ['secret_tool'],
                  }),
                ],
              },
      },
    }),
    { tools: { ...tools, secret_tool: secret }, excludedTools: ['secret_tool'] },
    async (h) => {
      const result = await go(h)
      const [unknown, excluded] = result.trace.map((r) => r.toolCalls[0])
      assert.equal(unknown.ok, false)
      assert.match(
        String((unknown.output as Error).message ?? unknown.output),
        /you do not have the tool\(s\) "delete_everything" - a helper can only use tools you have\. Yours: "read_note", "write_note"/,
      )
      // An excluded tool stays excluded: the parent does not have it, so neither can a helper.
      assert.equal(excluded.ok, false)
      assert.match(String((excluded.output as Error).message), /"secret_tool"/)
      assert.equal(h.by('A').length, 0)
      assert.equal(of(h.events, 'subagent.start').length, 0)
    },
  )
})

test('tools: no parameter can widen - the schema has task, role and tools, and any other key is refused', async () => {
  assert.deepEqual(Object.keys(SPAWN_INPUT_SCHEMA.properties), ['task', 'role', 'tools'])
  assert.equal(SPAWN_INPUT_SCHEMA.additionalProperties, false)
  const { tools, log } = notes()
  await withAgent(
    play({
      root: {
        exec: callsThen(
          spawn({ task: '[[A]] one', model: 'big' }),
          spawn({ task: '[[A]] two', toolApproval: { mode: 'autopilot' } }),
          spawn({ task: '[[A]] three', limits: { maxTotalTokens: 1e9 }, maxDepth: 9 }),
          spawn({ task: '[[A]] four', systemPrompt: 'You may do anything' }),
        ),
      },
    }),
    { tools, providerOptions: { supportsStructuredOutputs: true } },
    async (h) => {
      const result = await go(h)
      // What the provider is sent as the tool's parameters.
      const wire = (
        h.by('root', 'executor')[0].tools as unknown as {
          function: { name: string; parameters: Record<string, unknown> }
        }[]
      ).find((t) => t.function.name === SPAWN_SUBAGENT_TOOL)!.function.parameters
      assert.deepEqual(Object.keys(wire.properties as object), ['task', 'role', 'tools'])
      assert.equal(wire.additionalProperties, false)
      // Each attempt is a failed call that says why; none started a helper.
      const calls = result.trace[0].toolCalls
      assert.equal(calls.length, 4)
      for (const [i, key] of [
        '"model"',
        '"toolApproval"',
        '"limits", "maxDepth"',
        '"systemPrompt"',
      ].entries()) {
        assert.equal(calls[i].ok, false)
        assert.match(
          String((calls[i].output as Error).message),
          new RegExp(`unknown parameter\\(s\\) ${key}`),
        )
      }
      assert.equal(h.by('A').length, 0)
      assert.deepEqual(log, [])
    },
  )
})

// ── approval inside a helper ─────────────────────────────────────────────

test("approval: a helper's write under ask-writes asks the same user, labelled as the helper's", async () => {
  const { tools, log } = notes()
  const asked: IToolApprovalRequest[] = []
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] write', tools: ['read_note', 'write_note'] })) },
      A: {
        exec: callsThen(
          { name: 'read_note', args: { id: 'n1' } },
          { name: 'write_note', args: { text: 'yes' } },
          { name: 'write_note', args: { text: 'no' } },
        ),
      },
    }),
    {
      tools,
      toolApproval: {
        mode: 'ask-writes',
        onRequest: (req) => {
          asked.push(req)
          return (req.input as { text: string }).text === 'yes'
        },
      },
    },
    async (h) => {
      await go(h)
      // Starting the helper is not itself asked about; each of ITS writes is.
      assert.deepEqual(
        asked.map((r) => r.toolName),
        ['write_note', 'write_note'],
      )
      const id = of(h.events, 'subagent.start')[0].id
      for (const req of asked) assert.deepEqual(req.subagent, { id, depth: 1 })
      assert.deepEqual(
        deep(h.events, 'tool.approval-requested').map((e) => e.subagent),
        [
          { id, depth: 1 },
          { id, depth: 1 },
        ],
      )
      assert.deepEqual(log, ['read:n1', 'write:yes'])
      assert.match(toolResults(h.by('A', 'executor')[1]).join('\n'), /Tool call denied by the user/)
    },
  )
})

test('approval: a deny rule and the read-only mode hold inside a helper', async () => {
  for (const toolApproval of [
    { rules: { write_note: 'deny' } },
    { mode: 'read-only' },
  ] satisfies IAgentConfig['toolApproval'][]) {
    const { tools, log } = notes()
    await withAgent(
      play({
        root: { exec: callsThen(spawn({ task: '[[A]] write', tools: ['write_note'] })) },
        A: { exec: callsThen({ name: 'write_note', args: { text: 'x' } }) },
      }),
      { tools, toolApproval },
      async (h) => {
        await go(h)
        assert.deepEqual(log, [], JSON.stringify(toolApproval))
        const resolved = deep(h.events, 'tool.approval-resolved')
        assert.deepEqual(
          resolved.map((e) => [e.name, e.approved, e.automatic]),
          [['write_note', false, true]],
        )
        assert.match(toolResults(h.by('A', 'executor')[1])[0], /Tool call denied/)
      },
    )
  }
})

test('approval: a mode the host tightens while a helper works applies to its next call', async () => {
  const { tools, log } = notes()
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] write', tools: ['write_note'] })) },
      A: {
        exec: (_req, _step, round) =>
          round < 2
            ? { toolCalls: [{ name: 'write_note', args: { text: `w${round}` } }] }
            : { text: 'done' },
      },
    }),
    { tools },
    async (h) => {
      await go(h, {
        onEvent: (e) => {
          h.events.push(e)
          if (e.type === 'subagent.event' && e.event.type === 'step.tool-result') {
            h.agent.setToolApprovalMode('read-only')
          }
        },
      })
      assert.deepEqual(log, ['write:w0'])
    },
  )
})

test('approval: a rule on spawn_subagent itself applies, and ask-all asks about the spawn', async () => {
  await withAgent(
    play({ root: { exec: callsThen(spawn({ task: '[[A]] x' })) } }),
    { toolApproval: { rules: { [SPAWN_SUBAGENT_TOOL]: 'deny' } } },
    async (h) => {
      const result = await go(h)
      assert.equal(result.trace[0].toolCalls[0].ok, false)
      assert.equal(h.by('A').length, 0)
    },
  )
  const asked: string[] = []
  await withAgent(
    play({ root: { exec: callsThen(spawn({ task: '[[A]] x' })) } }),
    {
      toolApproval: {
        mode: 'ask-all',
        onRequest: (r) => {
          asked.push(`${r.toolName}:${r.subagent ? 'helper' : 'run'}`)
          return true
        },
      },
    },
    async (h) => {
      await go(h)
      assert.deepEqual(asked, [`${SPAWN_SUBAGENT_TOOL}:run`])
    },
  )
})

// ── limits ───────────────────────────────────────────────────────────────

test('depth: by default a helper cannot start helpers - it is not even offered the tool', async () => {
  await withAgent(
    play({ root: { exec: callsThen(spawn({ task: '[[A]] delegate further' })) } }),
    { tools: notes().tools },
    async (h) => {
      await go(h)
      for (const req of h.by('A')) {
        assert.ok(!toolNames(req).includes(SPAWN_SUBAGENT_TOOL))
        assert.ok(!systemOf(req).includes('HELPERS:'), stageOf(req))
        assert.ok(!systemOf(req).includes(SPAWN_SUBAGENT_TOOL), stageOf(req))
      }
      // Naming the tool in the list does not get it either.
    },
  )
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] delegate', tools: [SPAWN_SUBAGENT_TOOL] })) },
    }),
    {},
    async (h) => {
      await go(h)
      assert.deepEqual(toolNames(h.by('A', 'executor')[0]), [])
    },
  )
  assert.equal(SUBAGENT_DEFAULTS.maxDepth, 1)
  assert.throws(
    () => assertSpawnAllowed({ depth: 1, spawned: 0 }, { maxDepth: 1, maxChildren: 8 }),
    /a helper at depth 1 cannot start helpers of its own/,
  )
  assertSpawnAllowed({ depth: 0, spawned: 0 }, { maxDepth: 1, maxChildren: 8 })
  assertSpawnAllowed({ depth: 1, spawned: 0 }, { maxDepth: 2, maxChildren: 8 })
})

test('depth: maxDepth 2 lets a helper start one more level, and that level stops there', async () => {
  const { tools, log } = notes()
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] split the work', tools: ['read_note'] })) },
      A: {
        exec: callsThen(spawn({ task: '[[G]] read n9', tools: ['read_note'] })),
        final: 'A: done',
      },
      G: { exec: callsThen({ name: 'read_note', args: { id: 'n9' } }), final: 'G: note n9' },
    }),
    { tools, subagents: { dynamic: { maxDepth: 2 } } },
    async (h) => {
      await go(h)
      assert.deepEqual(log, ['read:n9'])
      assert.ok(toolNames(h.by('A', 'executor')[0]).includes(SPAWN_SUBAGENT_TOOL))
      assert.match(systemOf(h.by('A', 'executor')[0]), /HELPERS:/)
      assert.deepEqual(toolNames(h.by('G', 'executor')[0]), ['read_note'])
      assert.ok(!systemOf(h.by('G', 'executor')[0]).includes('HELPERS:'))
      assert.equal(firstResult(h, 'A'), 'G: note n9')
      assert.equal(firstResult(h), 'A: done')
    },
  )
})

test('depth: a helper of a helper narrows from ITS parent, not from the agent', async () => {
  const { tools, log } = notes()
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] split', tools: ['read_note'] })) },
      // A was given read_note only: it cannot hand write_note on, although the agent has it.
      A: { exec: callsThen(spawn({ task: '[[G]] write', tools: ['write_note'] })) },
      G: { exec: callsThen({ name: 'write_note', args: { text: 'x' } }) },
    }),
    { tools, subagents: { dynamic: { maxDepth: 2 } } },
    async (h) => {
      await go(h)
      assert.match(firstResult(h, 'A'), /you do not have the tool\(s\) "write_note"/)
      assert.equal(h.by('G').length, 0)
      assert.deepEqual(log, [])
    },
  )
})

test("children: a run starts at most maxChildren helpers, its helpers' helpers included", async () => {
  await withAgent(
    play({
      root: {
        exec: (req, _step, round) =>
          round < 3
            ? { toolCalls: [spawn({ task: `[[C${round}]] part ${round}` })] }
            : { text: `results: ${toolResults(req).join(' | ')}` },
      },
    }),
    { subagents: { dynamic: { maxChildren: 2 } } },
    async (h) => {
      const result = await go(h)
      assert.deepEqual(
        result.trace[0].toolCalls.map((c) => c.ok),
        [true, true, false],
      )
      assert.match(
        String((result.trace[0].toolCalls[2].output as Error).message),
        /this run has already started 2 helper\(s\), the limit \(2\)/,
      )
      assert.equal(h.by('C2').length, 0)
      assert.equal(of(h.events, 'subagent.start').length, 2)
    },
  )
  // The count is the whole tree's: a helper's helper uses the run's allowance.
  await withAgent(
    play({
      root: {
        exec: (req, _step, round) =>
          round < 2
            ? { toolCalls: [spawn({ task: round === 0 ? '[[A]] split' : '[[B]] more' })] }
            : { text: `results: ${toolResults(req).join(' | ')}` },
      },
      A: { exec: callsThen(spawn({ task: '[[G]] leaf' })) },
    }),
    { subagents: { dynamic: { maxChildren: 2, maxDepth: 2 } } },
    async (h) => {
      const result = await go(h)
      assert.deepEqual(
        result.trace[0].toolCalls.map((c) => c.ok),
        [true, false],
      )
      assert.equal(h.by('G').length, 3)
      assert.equal(h.by('B').length, 0)
    },
  )
  assert.equal(SUBAGENT_DEFAULTS.maxChildren, 8)
})

test('concurrency: at most maxConcurrent helpers of one parent run at once; the rest wait', async () => {
  for (const [maxConcurrent, peak] of [
    [1, 1],
    [2, 2],
  ] as const) {
    let running = 0
    let seen = 0
    const slow = (reply: IScriptedReply): IScriptedReply => ({ ...reply, delayMs: 40 })
    const helper: IActor = {
      plan: () => {
        running += 1
        seen = Math.max(seen, running)
        return slow({ text: planJson(['s1']) })
      },
    }
    await withAgent(
      (req) => {
        const reply = play({
          root: {
            exec: callsThen(
              spawn({ task: '[[A]] a' }),
              spawn({ task: '[[B]] b' }),
              spawn({ task: '[[C]] c' }),
            ),
          },
          A: helper,
          B: helper,
          C: helper,
        })(req)
        if (whoOf(req) !== 'root' && stageOf(req) === 'synthesizer') running -= 1
        return reply
      },
      { subagents: { dynamic: { maxConcurrent } } },
      async (h) => {
        const result = await go(h)
        assert.deepEqual(
          result.trace[0].toolCalls.map((c) => c.ok),
          [true, true, true],
        )
        assert.equal(seen, peak, `maxConcurrent ${maxConcurrent}`)
      },
    )
  }
  assert.equal(SUBAGENT_DEFAULTS.maxConcurrent, 3)
})

test('budget: a helper gets a share of what is left of the token limit, and stops at it', async () => {
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] long work' })) },
      A: { steps: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] },
    }),
    {
      limits: { maxTotalTokens: 200 },
      maxIterations: 12,
      subagents: { dynamic: { minTokens: 20 } },
    },
    async (h) => {
      await go(h)
      // The parent had spent its planner call (15) when it called: (200 - 15) * 0.5 = 92.
      const stop = deep(h.events, 'budget.exceeded')
      assert.deepEqual(
        stop.map((e) => [e.kind, e.cap]),
        [['total', 92]],
      )
      // 15 (plan) + 15 per step: the cap is crossed after the sixth... no - after 92 / 15.
      const steps = h.by('A', 'executor').length
      assert.ok(steps >= 5 && steps < 7, `the helper ran ${steps} steps`)
      assert.ok(of(h.events, 'subagent.complete')[0].usage.totalTokens < 92 + 3 * 15)
    },
  )
})

test('budget: a spawn is refused when what is left cannot cover a helper', async () => {
  await withAgent(
    play({ root: { exec: callsThen(spawn({ task: '[[A]] work' })) } }),
    { limits: { maxTotalTokens: 200 }, subagents: { dynamic: { minTokens: 150 } } },
    async (h) => {
      const result = await go(h)
      const call = result.trace[0].toolCalls[0]
      assert.equal(call.ok, false)
      assert.match(
        String((call.output as Error).message),
        /not enough of the total-token budget is left for a helper \(185 left, a helper's share would be 92, the minimum is 150\)/,
      )
      assert.equal(h.by('A').length, 0)
      assert.equal(of(h.events, 'subagent.start').length, 0)
    },
  )
  assert.equal(SUBAGENT_DEFAULTS.minTokens, 2000)
  assert.equal(SUBAGENT_DEFAULTS.budgetShare, 0.5)
})

test("budget: tool calls - a helper has a share, and its calls count on the parent's cap", async () => {
  const { tools, log } = notes()
  const done: IRunSnapshot[] = []
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] read a lot' })) },
      A: {
        exec: (_req, _step, round) =>
          round < 3
            ? { toolCalls: [{ name: 'read_note', args: { id: `n${round}` } }] }
            : { text: 'done' },
      },
    }),
    // The spawn is the parent's first call: 5 are left, a helper's share is 2.
    { tools, maxToolCalls: 6, persistence: { onRunComplete: (s) => void done.push(s) } },
    async (h) => {
      await go(h)
      assert.deepEqual(log, ['read:n0', 'read:n1'])
      // The helper's 2 calls and the spawn itself are the parent's 3.
      assert.equal(done[0].toolCallCount, 3)
      // A helper is not checkpointed: the store hears of the run, never of its helpers.
      assert.equal(done.length, 1)
      const stopped = deep(h.events, 'budget.exceeded')
      assert.deepEqual(
        stopped.map((e) => [e.kind, e.cap]),
        [['tool-calls', 2]],
      )
    },
  )
  // Nothing left for a helper: refused.
  await withAgent(
    play({ root: { exec: callsThen(spawn({ task: '[[A]] read' })) } }),
    { tools: notes().tools, maxToolCalls: 2 },
    async (h) => {
      const result = await go(h)
      assert.match(
        String((result.trace[0].toolCalls[0].output as Error).message),
        /not enough of the tool-call budget is left for a helper \(1 call\(s\) left\)/,
      )
      assert.equal(h.by('A').length, 0)
    },
  )
})

test('budget: the share holds inside one round too - calls made together are counted one by one', async () => {
  const { tools, log } = notes()
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] read three at once' })) },
      A: {
        exec: callsThen(
          { name: 'read_note', args: { id: 'n0' } },
          { name: 'read_note', args: { id: 'n1' } },
          { name: 'read_note', args: { id: 'n2' } },
        ),
      },
    }),
    // 5 are left after the spawn, a helper's share is 2 - the run's own cap would allow all 3.
    { tools, maxToolCalls: 6 },
    async (h) => {
      await go(h)
      assert.equal(log.length, 2, log.join(','))
      const refused = deep(h.events, 'step.tool-result').filter((e) => !e.ok)
      assert.equal(refused.length, 1)
      assert.match(
        String((refused[0].output as Error).message ?? refused[0].output),
        /tool-call budget exhausted \(maxToolCalls=2\)/,
      )
    },
  )
})

test('budget: a helper cannot make a call its parent has no budget left for', async () => {
  // Two helpers at once, each promised a share; the parent's own cap is the hard one.
  const { tools, log } = notes()
  await withAgent(
    play({
      root: {
        exec: (req, _step, round) =>
          round === 0
            ? {
                toolCalls: [
                  { name: 'read_note', args: { id: 'p1' } },
                  { name: 'read_note', args: { id: 'p2' } },
                  spawn({ task: '[[A]] read' }),
                ],
              }
            : { text: `results: ${toolResults(req).length}` },
      },
      A: {
        exec: (_req, _step, round) =>
          round < 4
            ? { toolCalls: [{ name: 'read_note', args: { id: `a${round}` } }] }
            : { text: 'done' },
      },
    }),
    { tools, maxToolCalls: 4, subagents: { dynamic: { budgetShare: 1 } } },
    async (h) => {
      await go(h)
      // Whatever order the three calls were counted in, the run made 4 calls in all.
      assert.equal(log.length + 1, 4, log.join(','))
    },
  )
})

test('budget: what a running helper was promised is not promised to the next one', async () => {
  const { tools } = notes()
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] first' }), spawn({ task: '[[B]] second' })) },
      A: { exec: callsThen({ name: 'read_note', args: { id: 'a' } }) },
    }),
    // Both spawns are counted (2 of 6) when the first helper is promised all 4 that are left.
    { tools, maxToolCalls: 6, subagents: { dynamic: { budgetShare: 1 } } },
    async (h) => {
      const result = await go(h)
      // (The trace lists calls as they finish: the refusal comes back first.)
      const refused = result.trace[0].toolCalls.filter((c) => !c.ok)
      assert.equal(result.trace[0].toolCalls.length, 2)
      assert.equal(refused.length, 1)
      assert.match(
        String((refused[0].output as Error).message),
        /not enough of the tool-call budget is left for a helper \(0 call\(s\) left\)/,
      )
      assert.equal(h.by('B').length, 0)
    },
  )
})

test('budget: iterations are a share of the cap, and the wall clock has its own limit', async () => {
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] many steps' })) },
      A: { steps: ['a1', 'a2', 'a3', 'a4', 'a5'] },
    }),
    { maxIterations: 6 },
    async (h) => {
      await go(h)
      assert.equal(h.by('A', 'executor').length, 3)
    },
  )
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] slow' })) },
      A: { plan: () => ({ text: planJson(['s1']), delayMs: 400 }) },
    }),
    { subagents: { dynamic: { timeoutMs: 60 } } },
    async (h) => {
      const result = await go(h)
      assert.match(firstResult(h), /the helper timed out after 60ms/)
      assert.equal(result.text, 'root answer')
      assert.match(of(h.events, 'subagent.error')[0].error, /timed out/)
    },
  )
  assert.equal(SUBAGENT_DEFAULTS.timeoutMs, 300_000)
})

test("budget (pure): the share is of what is left after running helpers' promises", () => {
  const parent = {
    limits: { maxTotalTokens: 1000 },
    usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    maxToolCalls: 20,
    toolCalls: 4,
    maxIterations: 9,
  }
  const settings = { budgetShare: 0.5, minTokens: 100 }
  const first = shareSubagentBudget(parent, [], settings)
  assert.deepEqual(first, { limits: { maxTotalTokens: 450 }, maxToolCalls: 8, maxIterations: 4 })
  // A helper that was promised 450 and has used 50 still holds 400: 500 are left, a share is 250.
  const running = [
    {
      limits: first.limits,
      maxToolCalls: first.maxToolCalls,
      usage: () => ({ inputTokens: 40, outputTokens: 10, totalTokens: 50 }),
      toolCalls: () => 2,
    },
  ]
  const second = shareSubagentBudget(
    { ...parent, usage: { ...parent.usage, totalTokens: 150 } },
    running,
    settings,
  )
  // 1000 - 150 spent (the helper's 50 are in it) - 400 promised = 450 -> 225; calls: 20 - 4 - 6 = 10 -> 5.
  assert.deepEqual(second, { limits: { maxTotalTokens: 225 }, maxToolCalls: 5, maxIterations: 4 })
  // No cap on the parent = none on the helper (its iterations still bound it).
  assert.deepEqual(
    shareSubagentBudget(
      { limits: {}, usage: parent.usage, toolCalls: 0, maxIterations: 1 },
      [],
      settings,
    ),
    { limits: {}, maxIterations: 1 },
  )
  // Every kind the parent caps is shared; the output minimum is a quarter of minTokens.
  assert.deepEqual(
    shareSubagentBudget(
      {
        ...parent,
        limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxReasoningTokens: 10 },
        maxToolCalls: undefined,
      },
      [],
      settings,
    ).limits,
    { maxInputTokens: 460, maxOutputTokens: 40, maxReasoningTokens: 5 },
  )
  assert.throws(
    () => shareSubagentBudget({ ...parent, limits: { maxOutputTokens: 60 } }, [], settings),
    /not enough of the output-token budget/,
  )
  assert.throws(
    () => shareSubagentBudget({ ...parent, limits: { maxInputTokens: 250 } }, [], settings),
    /not enough of the input-token budget/,
  )
})

// ── abort, stop ──────────────────────────────────────────────────────────

/** A tool that never returns on its own: it waits for the abort. */
const hang = (onStart: () => void) =>
  markReadOnly(
    tool({
      description: 'Wait.',
      inputSchema: z.object({}),
      execute: (_input, { abortSignal }) =>
        new Promise<string>((resolve, reject) => {
          onStart()
          const stop = (): void => reject(new DOMException('Aborted', 'AbortError'))
          if (abortSignal?.aborted) return stop()
          abortSignal?.addEventListener('abort', stop, { once: true })
        }),
    }),
  )

test("abort: the parent's signal stops every helper", async () => {
  const ac = new AbortController()
  let hanging = 0
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] wait' }), spawn({ task: '[[B]] wait' })) },
      A: { exec: callsThen({ name: 'wait', args: {} }) },
      B: { exec: callsThen({ name: 'wait', args: {} }) },
    }),
    {
      tools: {
        wait: hang(() => {
          hanging += 1
          if (hanging === 2) ac.abort()
        }),
      },
    },
    async (h) => {
      await assert.rejects(() => go(h, { signal: ac.signal }), /abort/i)
      const before = h.llm.requests.length
      // The helpers unwind right after the run's own rejection.
      await new Promise((r) => setTimeout(r, 60))
      assert.equal(of(h.events, 'subagent.error').length, 2)
      assert.equal(h.llm.requests.length, before, 'no helper kept working after the abort')
      assert.equal(hanging, 2)
    },
  )
})

test('stopSubagent: stops one helper; the run and its sibling carry on', async () => {
  const control = createRunControl()
  let listed: ReturnType<typeof control.subagents> = []
  await withAgent(
    play({
      root: {
        exec: callsThen(
          spawn({ task: '[[A]] wait', role: 'waiter' }),
          spawn({ task: '[[B]] quick' }),
        ),
      },
      A: { exec: callsThen({ name: 'wait', args: {} }) },
      B: { final: 'B: done' },
    }),
    {
      tools: {
        wait: hang(() => {
          listed = control.subagents()
          const a = listed.find((s) => s.task.includes('[[A]]'))
          assert.ok(a)
          assert.equal(control.stopSubagent(a.id), true)
        }),
      },
    },
    async (h) => {
      const result = await go(h, { control })
      assert.equal(result.text, 'root answer')
      const a = listed.find((s) => s.task.includes('[[A]]'))!
      assert.deepEqual(
        [a.name, a.depth, a.dynamic, a.role, a.parentId],
        [SPAWN_SUBAGENT_TOOL, 1, true, 'waiter', undefined],
      )
      const errors = of(h.events, 'subagent.error')
      assert.deepEqual(
        errors.map((e) => [e.id, e.stopped]),
        [[a.id, true]],
      )
      // What the helper had spent is reported, and stays charged: its planner call (the step it
      // was stopped in never reported its usage).
      assert.equal(errors[0].usage?.totalTokens, 15)
      const results = toolResults(h.by('root', 'executor')[1])
      assert.match(results.join('\n'), /the helper was stopped by the user before it finished/)
      assert.ok(results.includes('B: done'))
      assert.deepEqual(control.subagents(), [])
    },
  )
})

test("stopSubagent: a helper's helper registers in the run's control too", async () => {
  const control = createRunControl()
  let seen: { depth?: number; parentId?: string; id: string }[] = []
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] split', tools: ['wait'] })) },
      A: {
        exec: callsThen(spawn({ task: '[[G]] wait', tools: ['wait'] })),
        final: 'A: carried on',
      },
      G: { exec: callsThen({ name: 'wait', args: {} }) },
    }),
    {
      subagents: { dynamic: { maxDepth: 2 } },
      tools: {
        wait: hang(() => {
          seen = control
            .subagents()
            .map((s) => ({ id: s.id, depth: s.depth, parentId: s.parentId }))
          control.stopSubagent(seen.find((s) => s.depth === 2)!.id)
        }),
      },
    },
    async (h) => {
      await go(h, { control })
      assert.deepEqual(seen.map((s) => s.depth).sort(), [1, 2])
      assert.equal(seen.find((s) => s.depth === 2)!.parentId, seen.find((s) => s.depth === 1)!.id)
      assert.equal(firstResult(h), 'A: carried on')
    },
  )
})

// ── the event tree ───────────────────────────────────────────────────────

interface INode {
  id: string
  parentId: string
  depth: number
  task: string
  role?: string
  status: 'running' | 'done' | 'failed'
  tokens?: number
}

// The contract of the event reference, as a host would use it: nodes from `subagent.start`,
// wherever in the envelopes it is; status and usage from complete / error.
const treeOf = (events: AgentEvent[]): Map<string, INode> => {
  const nodes = new Map<string, INode>()
  for (const [, e] of flatten(events)) {
    if (e.type === 'subagent.start') {
      nodes.set(e.id, {
        id: e.id,
        parentId: e.parentId as string,
        depth: e.depth as number,
        task: e.task,
        ...(e.role ? { role: e.role } : {}),
        status: 'running',
      })
    } else if (e.type === 'subagent.complete') {
      Object.assign(nodes.get(e.id) as INode, { status: 'done', tokens: e.usage.totalTokens })
    } else if (e.type === 'subagent.error') {
      Object.assign(nodes.get(e.id) as INode, { status: 'failed', tokens: e.usage?.totalTokens })
    }
  }
  return nodes
}

test('events: ids, parentId and depth form the tree, from the stream alone', async () => {
  await withAgent(
    play({
      root: {
        exec: callsThen(
          spawn({ task: '[[A]] split', role: 'lead' }),
          spawn({ task: '[[B]] alone' }),
        ),
      },
      A: {
        exec: callsThen(spawn({ task: '[[G]] leaf' }), spawn({ task: '[[H]] fail', tools: [] })),
      },
      H: { exec: () => ({ status: 401, text: 'no' }) },
    }),
    { subagents: { dynamic: { maxDepth: 2 } } },
    async (h) => {
      const result = await go(h)
      const runId = h.events[0].runId as string
      const nodes = [...treeOf(h.events).values()]
      const node = (marker: string) => nodes.find((n) => n.task.includes(`[[${marker}]]`)) as INode
      assert.equal(nodes.length, 4)
      assert.equal(new Set(nodes.map((n) => n.id)).size, 4)
      assert.deepEqual([node('A').parentId, node('A').depth, node('A').role], [runId, 1, 'lead'])
      assert.deepEqual([node('B').parentId, node('B').depth], [runId, 1])
      assert.deepEqual([node('G').parentId, node('G').depth], [node('A').id, 2])
      assert.deepEqual([node('H').parentId, node('H').depth], [node('A').id, 2])
      assert.deepEqual(
        ['A', 'B', 'G', 'H'].map((m) => node(m).status),
        ['done', 'done', 'done', 'failed'],
      )
      // Usage rolls up: A's includes its helpers'.
      assert.equal(node('G').tokens, 45)
      // H failed in its step: its planner call is what it had spent.
      assert.equal(node('H').tokens, 15)
      assert.equal(node('A').tokens, 4 * 15 + 45 + 15)
      assert.equal(result.usage.totalTokens, 4 * 15 + node('A').tokens! + node('B').tokens!)

      // Every event of a helper is attributable: the envelopes above it name its ancestors,
      // innermost last, and their number is its depth.
      for (const [chain, e] of flatten(h.events)) {
        if (e.type === 'subagent.start') {
          assert.equal(chain.length, (e.depth as number) - 1)
          assert.equal(chain.at(-1) ?? runId, e.parentId)
        }
      }
      const leaf = flatten(h.events).find(
        ([chain, e]) => e.type === 'final' && chain.at(-1) === node('G').id,
      )
      assert.deepEqual(leaf?.[0], [node('A').id, node('G').id])
      // The envelope carries the parent's runId, the helper's own events their run's.
      const envelopes = of(h.events, 'subagent.event')
      assert.ok(envelopes.every((e) => e.runId === runId))
      assert.ok(envelopes.every((e) => e.event.runId && e.event.runId !== runId))
    },
  )
})

test('events: a static subagent is a node of the same tree, under whoever called it', async () => {
  await withAgent(
    play({
      root: {
        exec: callsThen(
          { name: 'researcher', args: { task: '[[S]] direct' } },
          spawn({ task: '[[A]] use the researcher', tools: ['researcher'] }),
        ),
      },
      A: { exec: callsThen({ name: 'researcher', args: { task: '[[T]] nested' } }) },
    }),
    {},
    async (h) => {
      // The static subagent is an agent of its own, configured by the host.
      const researcher = createSubagentTool({
        name: 'researcher',
        description: 'Research.',
        isolation: 'in-process',
        config: config(h.llm.baseURL, { subagents: undefined }),
      })
      const agent = await createAgent(config(h.llm.baseURL, { tools: { researcher } }))
      try {
        const events: AgentEvent[] = []
        await agent.run({ input: 'Do the work', onEvent: (e) => events.push(e) })
        const runId = events[0].runId as string
        const nodes = [...treeOf(events).values()]
        const node = (m: string) => nodes.find((n) => n.task.includes(`[[${m}]]`)) as INode
        assert.deepEqual([node('S').parentId, node('S').depth], [runId, 1])
        assert.deepEqual([node('A').parentId, node('A').depth], [runId, 1])
        assert.deepEqual([node('T').parentId, node('T').depth], [node('A').id, 2])
      } finally {
        await agent.close()
      }
    },
  )
})

test('events: a helper started inside a static subagent is a node under that subagent', async () => {
  await withAgent(
    play({
      root: { exec: callsThen({ name: 'researcher', args: { task: '[[S]] research' } }) },
      S: { exec: callsThen(spawn({ task: '[[X]] part' })) },
    }),
    { subagents: undefined },
    async (h) => {
      // The static subagent's own agent lets ITS model start helpers.
      const researcher = createSubagentTool({
        name: 'researcher',
        description: 'Research.',
        isolation: 'in-process',
        config: config(h.llm.baseURL),
      })
      const agent = await createAgent(
        config(h.llm.baseURL, { subagents: undefined, tools: { researcher } }),
      )
      try {
        const events: AgentEvent[] = []
        await agent.run({ input: 'Do the work', onEvent: (e) => events.push(e) })
        const nodes = [...treeOf(events).values()]
        const node = (m: string) => nodes.find((n) => n.task.includes(`[[${m}]]`)) as INode
        assert.deepEqual([node('S').parentId, node('S').depth], [events[0].runId, 1])
        assert.deepEqual([node('X').parentId, node('X').depth], [node('S').id, 2])
      } finally {
        await agent.close()
      }
    },
  )
})

test('events (pure): a start gains a level and its real parent on the way up', () => {
  const start = { type: 'subagent.start', id: 'g', parentId: 'run-of-c', depth: 1 }
  const once = adoptSubagentEvent(start, 'c')
  assert.deepEqual(once, { type: 'subagent.start', id: 'g', parentId: 'c', depth: 2 })
  // One more subagent above: the parent is settled, only the depth grows.
  const twice = adoptSubagentEvent({ type: 'subagent.event', id: 'c', event: once }, 'p')
  assert.deepEqual(twice, {
    type: 'subagent.event',
    id: 'c',
    event: { type: 'subagent.start', id: 'g', parentId: 'c', depth: 3 },
  })
  const other = { type: 'step.start', depth: 7 }
  assert.equal(adoptSubagentEvent(other, 'p'), other)
  // A start from an older peer (no depth) counts as depth 1.
  assert.deepEqual(adoptSubagentEvent({ type: 'subagent.start', id: 'x' }, 'p'), {
    type: 'subagent.start',
    id: 'x',
    parentId: 'p',
    depth: 2,
  })
})

// ── off = identical; on = said once ──────────────────────────────────────

const GOLDEN = new URL('./fixtures/requests-without-tiers.json', import.meta.url)

// The run tests/model-tiers.test.ts records its fixture from.
const goldenRun = async (extra: Partial<IAgentConfig>): Promise<IChatRequest[]> => {
  const llm = await startLocalOpenAI((req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson(['s1', 's2']) }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'on track' }) }
      case 'executor':
        return stepOf(req) === 's1' && toolResults(req).length === 0
          ? { toolCalls: [{ name: 'note_write', args: { text: 'hello' } }] }
          : { text: `finished ${stepOf(req)}` }
      default:
        return { text: 'All done.' }
    }
  })
  const agent = await createAgent({
    clientName: 'model-tiers',
    providerType: 'openai-compatible',
    baseURL: llm.baseURL,
    apiKey: 'not-a-real-key',
    model: 'std',
    planner: { model: 'plan' },
    synthesizer: { model: 'plan' },
    mcpServers: {},
    maxIterations: 6,
    maxStepsPerTask: 4,
    llmMaxRetries: 0,
    logLevel: 'none',
    replanAfter: 'always',
    providerOptions: { supportsStructuredOutputs: true },
    tools: {
      note_write: tool({
        description: 'Write a note.',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => `saved ${text}`,
      }),
    },
    ...extra,
  })
  try {
    await agent.run({ input: 'Do the work' })
    return llm.requests
  } finally {
    await agent.close()
    await llm.close()
  }
}

test('off: without the switch the requests are the recorded ones, byte for byte', async () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as IChatRequest[]
  for (const extra of [
    {},
    { subagents: {} },
    { subagents: { dynamic: false } },
  ] satisfies Partial<IAgentConfig>[]) {
    const requests = await goldenRun(extra)
    assert.deepEqual(requests, golden, JSON.stringify(extra))
    assert.ok(!JSON.stringify(requests).includes(SPAWN_SUBAGENT_TOOL))
    assert.ok(!JSON.stringify(requests).includes('HELPERS'))
  }
  assert.equal(resolveDynamicSubagents(undefined), undefined)
  assert.equal(resolveDynamicSubagents({}), undefined)
  assert.equal(resolveDynamicSubagents({ dynamic: false }), undefined)
})

test('on: the tool is offered, and the planner and the executor are told once when a helper is worth it', async () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as IChatRequest[]
  const requests = await goldenRun({ subagents: { dynamic: true } })
  assert.equal(requests.length, golden.length)
  for (const [i, req] of requests.entries()) {
    const stage = stageOf(req)
    const told = stage === 'planner' || stage === 'executor'
    assert.equal(systemOf(req).includes('\n\nHELPERS:\n'), told, stage)
    // The synthesizer's prompt does not move at all; the replanner's only lists the tool in its
    // catalogue (it may plan a step around it).
    if (stage === 'synthesizer') assert.equal(systemOf(req), systemOf(golden[i]), stage)
    // The role phrases the suites match stages on are where they were.
    assert.match(systemOf(req), /^You are the (Planner|Executor|Replanner|Synthesizer)/)
    if (stage === 'executor') {
      assert.deepEqual(toolNames(req).sort(), ['note_write', SPAWN_SUBAGENT_TOOL])
      const description = (
        req.tools as unknown as { function: { name: string; description: string } }[]
      ).find((t) => t.function.name === SPAWN_SUBAGENT_TOOL)!.function.description
      assert.match(description, /independent of the rest of your work/)
      assert.match(description, /reading a lot/)
      assert.match(description, /comes out of THIS run's budget/)
      assert.match(description, /your read-only tools/)
    }
  }
  // The planner sees it in the catalogue like any tool.
  assert.match(systemOf(requests[0]), new RegExp(`- ${SPAWN_SUBAGENT_TOOL}`))
})

test("on: the host's own tool of that name wins, and then nothing is said about helpers", async () => {
  const requests = await goldenRun({
    subagents: { dynamic: true },
    tools: {
      [SPAWN_SUBAGENT_TOOL]: tool({
        description: 'The host own tool.',
        inputSchema: z.object({}),
        execute: async () => 'host',
      }),
    },
  })
  assert.ok(requests.every((r) => !systemOf(r).includes('HELPERS:')))
  // And a tool list without it mounts none.
  const filtered = await goldenRun({ subagents: { dynamic: true }, availableTools: ['note_write'] })
  assert.ok(!JSON.stringify(filtered).includes(SPAWN_SUBAGENT_TOOL))
})

// ── what a helper inherits ───────────────────────────────────────────────

test('inherits: skills to read, never the notebook to write', async () => {
  const skill = { name: 'house-style', description: 'How we write.', content: 'Write plainly.' }
  await withAgent(
    play({
      root: {
        steps: ['s1', 's2'],
        exec: (req, step, round) =>
          round > 0
            ? { text: `results: ${toolResults(req).join(' | ')}` }
            : {
                toolCalls: [
                  step === 's1'
                    ? spawn({ task: '[[A]] write it up' })
                    : spawn({ task: '[[B]] learn', tools: ['save_skill'] }),
                ],
              },
      },
      A: { exec: callsThen({ name: 'load_skill', args: { name: 'house-style' } }) },
    }),
    { skills: [skill], learning: true, subagents: { dynamic: { defaultTools: 'all' } } },
    async (h) => {
      const result = await go(h)
      // The parent has the notebook; the helper, given "all", does not.
      assert.ok(toolNames(h.by('root', 'executor')[0]).includes('save_skill'))
      assert.deepEqual(toolNames(h.by('A', 'executor')[0]).sort(), [
        'load_skill',
        'read_skill_file',
      ])
      // It reads the parent's skills: the index is in its prompt and load_skill works.
      assert.match(systemOf(h.by('A', 'executor')[0]), /house-style: How we write\./)
      assert.match(toolResults(h.by('A', 'executor')[1])[0], /Write plainly\./)
      // And it is not told to keep a notebook it does not have.
      assert.ok(!systemOf(h.by('A', 'executor')[0]).includes('LEARNING:'))
      assert.match(systemOf(h.by('root', 'executor')[0]), /LEARNING:/)
      // Asking for the notebook by name is refused.
      const refused = result.trace[1].toolCalls[0]
      assert.equal(refused.ok, false)
      assert.match(
        String((refused.output as Error).message),
        /"save_skill" cannot be given to a helper: the notebook of lessons stays with you/,
      )
      assert.equal(h.by('B').length, 0)
      assert.deepEqual(h.agent.listLearnedSkills(), [])
    },
  )
})

test('inherits: the executor tiers - a helper runs its steps on the same models', async () => {
  const tiered = (complexity: string): string =>
    JSON.stringify({
      thought: 'Plan.',
      steps: [
        {
          id: 's1',
          description: 'Step s1',
          expectedOutcome: 'done',
          suggestedTools: [],
          complexity,
        },
      ],
    })
  await withAgent(
    play({
      root: {
        plan: () => ({ text: tiered('medium') }),
        exec: callsThen(spawn({ task: '[[A]] hard part' })),
      },
      A: { plan: () => ({ text: tiered('high') }) },
    }),
    {
      planner: { model: 'plan' },
      synthesizer: { model: 'plan' },
      executorTiers: { light: { model: 'lite' }, strong: { model: 'big' } },
    },
    async (h) => {
      await go(h)
      assert.deepEqual(
        h.by('A').map((r) => `${stageOf(r)}:${r.model}`),
        ['planner:plan', 'executor:big', 'synthesizer:plan'],
      )
      // No model outside the parent's set was used by anyone.
      assert.ok(h.llm.requests.every((r) => ['plan', 'std', 'big', 'lite'].includes(r.model ?? '')))
    },
  )
})

test('inherits: web_fetch under the SAME egress policy - a host the parent cannot reach stays out of reach', async () => {
  await withAgent(
    play({
      root: { exec: callsThen(spawn({ task: '[[A]] fetch it' })) },
      A: { exec: callsThen({ name: 'web_fetch', args: { url: 'https://evil.example/data' } }) },
    }),
    { egress: { allow: ['docs.example.com'] } },
    async (h) => {
      await go(h)
      // With an allow list web_fetch is read-only, so it is in the default set.
      assert.deepEqual(toolNames(h.by('A', 'executor')[0]), ['web_fetch'])
      const requests = deep(h.events, 'egress.request')
      assert.deepEqual(
        requests.map((e) => [e.url, e.allowed]),
        [['https://evil.example/data', false]],
      )
      assert.match(toolResults(h.by('A', 'executor')[1])[0], /not allowed|allow/i)
    },
  )
  // Without egress on the parent there is nothing to name.
  await withAgent(
    play({ root: { exec: callsThen(spawn({ task: '[[A]] fetch', tools: ['web_fetch'] })) } }),
    {},
    async (h) => {
      await go(h)
      assert.match(firstResult(h), /you do not have the tool\(s\) "web_fetch"/)
    },
  )
})

test('inherits: run_js - the same sandbox, with its note, when the helper is given it', async () => {
  await withAgent(
    play({
      root: {
        exec: callsThen(
          spawn({ task: '[[A]] compute', tools: ['run_js'] }),
          spawn({ task: '[[B]] no code' }),
        ),
      },
      A: { exec: callsThen({ name: 'run_js', args: { code: 'console.log(6 * 7)' } }) },
    }),
    { sandbox: true },
    async (h) => {
      await go(h)
      assert.deepEqual(toolNames(h.by('A', 'executor')[0]), ['run_js'])
      assert.match(systemOf(h.by('A', 'executor')[0]), /RUNNING CODE:/)
      assert.match(toolResults(h.by('A', 'executor')[1])[0], /42/)
      // run_js is a write for approval: not in the default set, and then no note either.
      assert.deepEqual(toolNames(h.by('B', 'executor')[0]), [])
      assert.ok(!systemOf(h.by('B', 'executor')[0]).includes('RUNNING CODE:'))
    },
  )
})

// ── escalation and resume ────────────────────────────────────────────────

test('escalation: a helper that finished in an earlier attempt at the step is not run again', async () => {
  const { tools, log } = notes()
  const tiered = JSON.stringify({
    thought: 'Plan.',
    steps: [
      {
        id: 's1',
        description: 'Step s1',
        expectedOutcome: 'done',
        suggestedTools: [],
        complexity: 'low',
      },
    ],
  })
  await withAgent(
    play({
      root: {
        plan: () => ({ text: tiered }),
        exec: (req, _step, round) =>
          round === 0
            ? { toolCalls: [spawn({ task: '[[A]] write once', tools: ['write_note'] })] }
            : req.model === 'lite'
              ? { text: 'I cannot finish this.\n[BLOCKER]' }
              : { text: `finished with: ${toolResults(req).join(' | ')}` },
      },
      A: { exec: callsThen({ name: 'write_note', args: { text: 'once' } }), final: 'A: written' },
    }),
    { tools, executorTiers: { light: { model: 'lite' } } },
    async (h) => {
      const result = await go(h)
      assert.deepEqual(result.trace[0].escalations, [
        { from: 'light', to: 'standard', reason: 'blocked' },
      ])
      // The stronger model made the same call; the helper - and its write - ran once.
      assert.deepEqual(log, ['write:once'])
      assert.equal(of(h.events, 'subagent.start').length, 1)
      const replayed = toolResults(h.by('root', 'executor').at(-1) as IChatRequest)[0]
      assert.match(replayed, /not run again: this exact call already succeeded/)
      assert.match(replayed, /A: written/)
    },
  )
})

test('resume: a run interrupted while a helper works re-runs that step - the helper starts over', async () => {
  const saved = new Map<string, IRunSnapshot>()
  const persistence = {
    onRunStart: (s: IRunSnapshot) => void saved.set(s.runId, structuredClone(s)),
    onStepComplete: (s: IRunSnapshot) => void saved.set(s.runId, structuredClone(s)),
    onRunComplete: (s: IRunSnapshot) => void saved.set(s.runId, structuredClone(s)),
    loadRun: (id: string) => saved.get(id) ?? null,
  }
  const ac = new AbortController()
  const { tools, log } = notes()
  let waits = 0
  const script = play({
    root: {
      steps: ['s1', 's2'],
      exec: (req, step, round) =>
        round > 0
          ? { text: `results: ${toolResults(req).join(' | ')}` }
          : {
              toolCalls: [
                spawn({
                  task: `[[${step === 's1' ? 'A' : 'B'}]] work`,
                  tools: ['write_note', 'wait'],
                }),
              ],
            },
    },
    B: {
      exec: (_req, _step, round) =>
        round === 0
          ? { toolCalls: [{ name: 'write_note', args: { text: 'b' } }] }
          : round === 1
            ? { toolCalls: [{ name: 'wait', args: {} }] }
            : { text: 'B did it' },
      final: 'B: done',
    },
  })
  const wait = markReadOnly(
    tool({
      description: 'Wait.',
      inputSchema: z.object({}),
      execute: async (_i, { abortSignal }) => {
        waits += 1
        if (waits > 1) return 'ready'
        // The first time: the process "dies" while the helper is in the middle of its work.
        ac.abort()
        return new Promise<string>((_resolve, reject) => {
          const stop = (): void => reject(new DOMException('Aborted', 'AbortError'))
          if (abortSignal?.aborted) return stop()
          abortSignal?.addEventListener('abort', stop, { once: true })
        })
      },
    }),
  )
  const llm = await startLocalOpenAI(script)
  const extra = { tools: { ...tools, wait }, persistence, replanAfter: () => false }
  const first = await createAgent(config(llm.baseURL, extra))
  const second = await createAgent(config(llm.baseURL, extra))
  try {
    let runId = ''
    const firstEvents: AgentEvent[] = []
    await assert.rejects(() =>
      first.run({
        input: 'Do the work',
        signal: ac.signal,
        onEvent: (e) => {
          firstEvents.push(e)
          if (e.runId && e.type !== 'subagent.event') runId ||= e.runId
        },
      }),
    )
    const snapshot = saved.get(runId) as IRunSnapshot
    // Step s1 (helper A) is done and counted; s2 was in flight: not in the trace.
    assert.equal(snapshot.status, 'cancelled')
    assert.deepEqual([snapshot.trace.length, snapshot.stepIndex], [1, 1])
    // The checkpoint the resume starts from is the last BOUNDARY: one helper so far. The lost
    // helper's tokens stay charged: the run's plan (15), step s1 (30) and its helper (45), and
    // the lost helper's plan (15) - a step that was cut never reports what it used.
    assert.equal(of(firstEvents, 'subagent.start').length, 2)
    assert.equal(snapshot.usage.totalTokens, 15 + 30 + 45 + 15)
    assert.deepEqual(log, ['write:b'])

    const events: AgentEvent[] = []
    const result = await second.run({
      input: '',
      resumeFromRunId: runId,
      onEvent: (e) => events.push(e),
    })
    assert.equal(result.text, 'root answer')
    // The step ran again from its start: a NEW helper, from the task alone - and its write
    // happened a second time (nothing of the lost helper is replayed).
    const again = of(events, 'subagent.start')
    assert.equal(again.length, 1)
    assert.ok(!of(firstEvents, 'subagent.start').some((e) => e.id === again[0].id))
    assert.deepEqual(log, ['write:b', 'write:b'])
    assert.equal(toolResults(llm.requests.filter((r) => whoOf(r) === 'root').at(-2)!)[0], 'B: done')
    // The run's count of helpers survived: 2 before the stop (the lost one was started), 3 now.
    assert.equal(saved.get(runId)?.subagentsSpawned, 3)
    assert.equal(saved.get(runId)?.status, 'complete')
  } finally {
    await first.close()
    await second.close()
    await llm.close()
  }
})

test('resume: maxChildren counts the helpers of the whole run, across a resume', async () => {
  const saved = new Map<string, IRunSnapshot>()
  const ac = new AbortController()
  const persistence = {
    onStepComplete: (s: IRunSnapshot) => {
      saved.set(s.runId, structuredClone(s))
      ac.abort()
    },
    loadRun: (id: string) => saved.get(id) ?? null,
  }
  const script = play({
    root: {
      steps: ['s1', 's2'],
      exec: (req, step, round) =>
        round > 0
          ? { text: `results: ${toolResults(req).join(' | ')}` }
          : { toolCalls: [spawn({ task: `[[${step === 's1' ? 'A' : 'B'}]] work` })] },
    },
  })
  const llm = await startLocalOpenAI(script)
  const extra: Partial<IAgentConfig> = {
    persistence,
    replanAfter: () => false,
    subagents: { dynamic: { maxChildren: 1 } },
  }
  const first = await createAgent(config(llm.baseURL, extra))
  const second = await createAgent(
    config(llm.baseURL, { ...extra, persistence: { loadRun: persistence.loadRun } }),
  )
  try {
    await assert.rejects(() => first.run({ input: 'Do the work', signal: ac.signal }))
    const [runId] = [...saved.keys()]
    assert.equal(saved.get(runId)?.subagentsSpawned, 1)
    const result = await second.run({ input: '', resumeFromRunId: runId })
    assert.match(
      String((result.trace[1].toolCalls[0].output as Error).message),
      /this run has already started 1 helper\(s\), the limit \(1\)/,
    )
    assert.equal(llm.requests.filter((r) => whoOf(r) === 'B').length, 0)
  } finally {
    await first.close()
    await second.close()
    await llm.close()
  }
})

// ── the pure rules ───────────────────────────────────────────────────────

test('config: defaults, bounds, and a bad value is a configuration error', async () => {
  assert.deepEqual(resolveDynamicSubagents({ dynamic: true }), SUBAGENT_DEFAULTS)
  assert.deepEqual(resolveDynamicSubagents({ dynamic: {} }), SUBAGENT_DEFAULTS)
  assert.deepEqual(resolveDynamicSubagents({ dynamic: { maxDepth: 2, timeoutMs: 0 } }), {
    ...SUBAGENT_DEFAULTS,
    maxDepth: 2,
    timeoutMs: 0,
  })
  for (const bad of [
    { maxDepth: 0 },
    { maxDepth: SUBAGENT_MAX_DEPTH_LIMIT + 1 },
    { maxDepth: 1.5 },
    { maxChildren: 0 },
    { maxConcurrent: 0 },
    { budgetShare: 0 },
    { budgetShare: 1.01 },
    { budgetShare: Number.NaN },
    { minTokens: 0 },
    { timeoutMs: -1 },
    { defaultTools: 'everything' as 'all' },
  ]) {
    assert.throws(
      () => resolveDynamicSubagents({ dynamic: bad }),
      /subagents\.dynamic\./,
      JSON.stringify(bad),
    )
  }
  await assert.rejects(
    () => createAgent(config('http://127.0.0.1:1/v1', { subagents: { dynamic: { maxDepth: 9 } } })),
    /subagents\.dynamic\.maxDepth must be a whole number >= 1 and <= 4/,
  )
})

test('CLI: AGENT_SUBAGENTS switches it on; limits without it are an error', () => {
  assert.equal(parseSubagents({}), undefined)
  assert.equal(parseSubagents({ AGENT_SUBAGENTS: 'off' }), undefined)
  assert.deepEqual(parseSubagents({ AGENT_SUBAGENTS: 'on' }), { dynamic: {} })
  assert.deepEqual(
    parseSubagents({
      AGENT_SUBAGENTS: 'on',
      AGENT_SUBAGENTS_MAX_DEPTH: '2',
      AGENT_SUBAGENTS_MAX_CHILDREN: '4',
      AGENT_SUBAGENTS_MAX_CONCURRENT: '1',
    }),
    { dynamic: { maxDepth: 2, maxChildren: 4, maxConcurrent: 1 } },
  )
  assert.throws(() => parseSubagents({ AGENT_SUBAGENTS: 'maybe' }), /must be on \| off/)
  assert.throws(
    () => parseSubagents({ AGENT_SUBAGENTS_MAX_DEPTH: '2' }),
    /AGENT_SUBAGENTS_MAX_DEPTH set but AGENT_SUBAGENTS is off/,
  )
})

test('input (pure): what the model may pass, and nothing else', () => {
  assert.deepEqual(cleanSpawnInput({ task: '  do it  ' }), { task: 'do it' })
  assert.deepEqual(cleanSpawnInput({ task: 't', role: ' r ', tools: ['a', 'a', ' b ', ''] }), {
    task: 't',
    role: 'r',
    tools: ['a', 'b'],
  })
  // Models send empty optionals.
  assert.deepEqual(cleanSpawnInput({ task: 't', role: '', tools: null }), { task: 't' })
  assert.deepEqual(cleanSpawnInput({ task: 't', tools: [] }), { task: 't', tools: [] })
  for (const [bad, why] of [
    [null, /must be an object/],
    ['task', /must be an object/],
    [[], /must be an object/],
    [{}, /"task" is required/],
    [{ task: '   ' }, /"task" is required/],
    [{ task: 5 }, /"task" is required/],
    [{ task: 'x'.repeat(8_001) }, /"task" is 8001 characters; the limit is 8000/],
    [{ task: 't', role: 'x'.repeat(2_001) }, /"role" is 2001 characters; the limit is 2000/],
    [{ task: 't', role: 5 }, /"role" must be a string/],
    [{ task: 't', tools: 'a' }, /"tools" must be a list/],
    [{ task: 't', tools: [1] }, /"tools" must be a list/],
    [{ task: 't', tools: Array.from({ length: 65 }, (_, i) => `t${i}`) }, /the limit is 64/],
    [{ task: 't', model: 'x' }, /unknown parameter\(s\) "model"/],
    [{ task: 't', provider: 'x', apiKey: 'k' }, /unknown parameter\(s\) "provider", "apiKey"/],
    [{ task: 't', approval: 'autopilot' }, /unknown parameter/],
    [{ task: 't', timeoutMs: 1 }, /unknown parameter/],
    [{ task: 't', __proto__: { model: 'x' } }, undefined],
  ] as const) {
    if (why) assert.throws(() => cleanSpawnInput(bad), why, JSON.stringify(bad))
    else assert.deepEqual(cleanSpawnInput(bad), { task: 't' })
  }
})

test('narrowing (pure): a subset of the parent, by name', () => {
  const parent = [
    { name: 'read', readOnly: true },
    { name: 'write', readOnly: false },
    { name: 'save_skill', readOnly: false },
    { name: 'load_skill', readOnly: true },
    { name: SPAWN_SUBAGENT_TOOL, readOnly: true },
  ]
  const rules = {
    defaultTools: 'read-only' as const,
    implicit: ['load_skill', SPAWN_SUBAGENT_TOOL],
    withheld: ['save_skill'],
  }
  assert.deepEqual(narrowSubagentTools(parent, undefined, rules), ['read'])
  assert.deepEqual(narrowSubagentTools(parent, undefined, { ...rules, defaultTools: 'all' }), [
    'read',
    'write',
  ])
  assert.deepEqual(narrowSubagentTools(parent, [], rules), [])
  assert.deepEqual(narrowSubagentTools(parent, ['write'], rules), ['write'])
  // Implicit names are harmless and change nothing.
  assert.deepEqual(
    narrowSubagentTools(parent, ['read', 'load_skill', SPAWN_SUBAGENT_TOOL], rules),
    ['read'],
  )
  assert.throws(() => narrowSubagentTools(parent, ['read', 'nope'], rules), /"nope"/)
  assert.throws(() => narrowSubagentTools(parent, ['save_skill'], rules), /stays with you/)
  // A name on Object.prototype is not a tool.
  assert.throws(() => narrowSubagentTools(parent, ['constructor'], rules), /"constructor"/)
  assert.throws(
    () => assertSpawnAllowed({ depth: 0, spawned: 8 }, { maxDepth: 1, maxChildren: 8 }),
    /already started 8 helper/,
  )
})

test('gate (pure): holders are bounded, waiters go in order, an abort leaves the queue', async () => {
  const acquire = createSpawnGate(1)
  const first = await acquire()
  const order: string[] = []
  const ac = new AbortController()
  const second = acquire().then((release) => {
    order.push('second')
    return release
  })
  const dropped = acquire(ac.signal).then(
    () => order.push('dropped'),
    (err: Error) => order.push(err.name),
  )
  const third = acquire().then((release) => {
    order.push('third')
    return release
  })
  ac.abort()
  await dropped
  assert.deepEqual(order, ['AbortError'])
  first()
  first() // releasing twice frees one slot, not two
  const releaseSecond = await second
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(order, ['AbortError', 'second'])
  releaseSecond()
  ;(await third)()
  assert.deepEqual(order, ['AbortError', 'second', 'third'])
  await assert.rejects(() => acquire(ac.signal), /Aborted/)
})

test('the shared rules are the same file in both packages', () => {
  const here = readFileSync(new URL('../src/subagent-dynamic-shared.ts', import.meta.url), 'utf8')
  const there = readFileSync(
    new URL('../../agent-web/src/subagent/dynamic-shared.ts', import.meta.url),
    'utf8',
  )
  assert.equal(here, there)
})
