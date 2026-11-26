import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import {
  adoptSubagentEvent,
  createAgent,
  createRunControl,
  createSubagentTool,
  defineSkill,
  defineTool,
  MemoryStore,
  resolveDynamicSubagents,
  SPAWN_INPUT_SCHEMA,
  SPAWN_SUBAGENT_TOOL,
  SUBAGENT_DEFAULTS,
  SUBAGENT_MAX_DEPTH_LIMIT,
  type Agent,
  type AgentEvent,
  type AgentToolSet,
  type BrowserAgentConfig,
  type RunOptions,
  type RunPersistence,
  type RunSnapshot,
  type ToolApprovalRequest,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// Dynamic subagents (`subagents.dynamic`): helpers the MODEL starts with spawn_subagent. A helper
// runs on the caller's own model objects, so one scripted model sees every call of the tree and
// its call log is the proof: this is a privilege boundary - a helper may only have less than the
// run that starts it - and the assertions read what each helper was really offered and really
// did, not what the events claim. The pure rules (dynamic-shared.ts, the same file as the Node
// package's) are unit-tested there.

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer'

// Whose call it is: the run's own ('root'), or the helper whose task carries a [[marker]]. Read
// from the GOAL line only - a parent's log quotes what its helpers were asked.
const whoOf = (info: CallInfo): string => {
  const from = info.user.indexOf('GOAL: ')
  let own = from < 0 ? info.user : info.user.slice(from)
  for (const end of ['\n\nAlready done', '\n\nSTEP ', 'EARLIER ATTEMPT', '\n\nRemaining plan']) {
    const at = own.indexOf(end)
    if (at > 0) own = own.slice(0, at)
  }
  return /\[\[(\w+)\]\]/.exec(own)?.[1] ?? 'root'
}
const stepOf = (info: CallInfo): string => /STEP \d+\/\d+: Step (\w+)/.exec(info.user)?.[1] ?? '?'

// The tool results a call's conversation already holds, as the model was shown them.
const resultsOf = (info: CallInfo): string[] =>
  ((info.options.prompt ?? []) as { role: string; content: unknown }[])
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content as { type: string; output?: { value?: unknown } }[])
    .filter((p) => p.type === 'tool-result')
    .map((p) =>
      typeof p.output?.value === 'string' ? p.output.value : JSON.stringify(p.output?.value),
    )

const planJson = (ids: string[], complexity?: string): string =>
  JSON.stringify({
    thought: 'Plan.',
    steps: ids.map((id) => ({ description: `Step ${id}`, ...(complexity ? { complexity } : {}) })),
  })

interface Actor {
  /** The ids of its plan's steps (default one step, s1). */
  steps?: string[]
  /** Its executor: `round` is how many tool results the step's conversation already holds. */
  exec?: (info: CallInfo, step: string, round: number) => Reply
  /** Its synthesizer's answer. */
  final?: string
  plan?: (info: CallInfo) => Reply
}

const play =
  (actors: Record<string, Actor>) =>
  (info: CallInfo): Reply => {
    const who = whoOf(info)
    const actor = actors[who] ?? {}
    switch (stageOf(info)) {
      case 'planner':
        return actor.plan?.(info) ?? { text: planJson(actor.steps ?? ['s1']) }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'continue', reason: 'on track' }) }
      case 'synthesizer':
        return { text: actor.final ?? `${who} answer` }
      default:
        return (
          actor.exec?.(info, stepOf(info), info.toolResults) ?? {
            text: `${who} did ${stepOf(info)}`,
          }
        )
    }
  }

const spawn = (args: Record<string, unknown>) => ({ name: SPAWN_SUBAGENT_TOOL, args })
/** An executor that makes these calls in its first round and reports what came back. */
const callsThen =
  (...calls: { name: string; args: unknown }[]): Actor['exec'] =>
  (info, _step, round) =>
    round === 0 ? { toolCalls: calls } : { text: `results: ${resultsOf(info).join(' | ')}` }

interface Rig {
  agent: Agent
  calls: CallInfo[]
  events: AgentEvent[]
  by: (who: string, stage?: Stage) => CallInfo[]
  go: (opts?: RunOptions) => ReturnType<Agent['run']>
}

const rig = async (
  actors: Record<string, Actor>,
  extra: Partial<BrowserAgentConfig> = {},
): Promise<Rig> => {
  const model = scriptedModel(play(actors))
  const agent = await createAgent({
    model: model.model,
    toolMode: 'native',
    subagents: { dynamic: true },
    ...extra,
  })
  const events: AgentEvent[] = []
  return {
    agent,
    calls: model.calls,
    events,
    by: (who, stage) =>
      model.calls.filter((c) => whoOf(c) === who && (!stage || stageOf(c) === stage)),
    go: (opts = {}) => agent.run('Do the work', { onEvent: (e) => events.push(e), ...opts }),
  }
}

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

/** The result of a run's first tool call, as the model saw it. */
const firstResult = (r: Rig, who = 'root'): string =>
  r.by(who, 'executor').flatMap((c) => resultsOf(c))[0] ?? ''

const errorOf = (output: unknown): string =>
  output instanceof Error
    ? output.message
    : typeof output === 'string'
      ? output
      : JSON.stringify(output)

/** A host with one tool that reads and one that writes; `log` is what really ran. */
const notes = () => {
  const log: string[] = []
  const tools: AgentToolSet = {
    read_note: defineTool({
      description: 'Read a note.',
      inputSchema: z.object({ id: z.string() }),
      readOnly: true,
      execute: async ({ id }) => {
        log.push(`read:${id}`)
        return `note ${id}`
      },
    }),
    write_note: defineTool({
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

/** A tool that never returns on its own: it waits for the abort. */
const hang = (onStart: () => void) =>
  defineTool({
    description: 'Wait.',
    inputSchema: z.object({}),
    readOnly: true,
    execute: (_input, options) =>
      new Promise<string>((_resolve, reject) => {
        onStart()
        const signal = (options as { abortSignal?: AbortSignal }).abortSignal
        const stop = (): void => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        }
        if (signal?.aborted) return stop()
        signal?.addEventListener('abort', stop, { once: true })
      }),
  })

// ── spawn, and the answer back ───────────────────────────────────────────

test('spawn: the helper runs the loop on the task and its answer is the tool result', async () => {
  const { tools, log } = notes()
  const r = await rig(
    {
      root: {
        exec: callsThen(spawn({ task: '[[A]] Find the note n1', role: 'A careful reader' })),
      },
      A: {
        exec: callsThen({ name: 'read_note', args: { id: 'n1' } }),
        final: 'The note says: note n1',
      },
    },
    { tools, systemPrompt: 'OPERATOR RULES' },
  )
  const result = await r.go()
  assert.equal(result.final, 'root answer')
  assert.equal(firstResult(r), 'The note says: note n1')
  assert.deepEqual(log, ['read:n1'])
  const call = result.trace[0].toolCalls[0]
  assert.deepEqual(
    [call.name, call.ok, call.output],
    [SPAWN_SUBAGENT_TOOL, true, 'The note says: note n1'],
  )
  // The helper ran the whole loop: a plan, the step (two rounds), an answer.
  assert.deepEqual(r.by('A').map(stageOf), ['planner', 'executor', 'executor', 'synthesizer'])
  for (const c of r.by('A')) {
    // CONTEXT: the task, not the parent's goal or log.
    assert.ok(!c.user.includes('Do the work'), stageOf(c))
    // The operator's system prompt is the operator's; the role is model-written text and is
    // part of the task, under a line that says where it came from.
    assert.match(c.system, /OPERATOR RULES/)
    assert.ok(!c.system.includes('A careful reader'), stageOf(c))
    assert.match(c.user, /Your role for this task, as described by the agent that delegated/)
    assert.match(c.user, /A careful reader\n\nTask:\n\[\[A\]\] Find the note n1/)
  }
})

test("usage: a helper's tokens are charged to the parent run and to agent.usage, once", async () => {
  const r = await rig({ root: { exec: callsThen(spawn({ task: '[[A]] think' })) } })
  const result = await r.go()
  // Helper: plan + step + answer = 3 calls; root: plan + 2 executor rounds + answer = 4.
  assert.equal(r.by('A').length, 3)
  assert.equal(r.by('root').length, 4)
  assert.equal(result.usage.totalTokens, 7 * 15)
  assert.equal(r.agent.usage.totalTokens, 7 * 15)
  assert.equal(r.agent.sessionUsage().totalTokens, 7 * 15)
  const charged = of(r.events, 'usage').filter((e) => e.phase === 'subagent')
  assert.equal(
    charged.reduce((n, e) => n + e.usage.totalTokens, 0),
    3 * 15,
  )
  assert.equal(of(r.events, 'subagent.complete')[0].usage.totalTokens, 3 * 15)
})

// ── narrowing ────────────────────────────────────────────────────────────

test('tools: without a list a helper gets the read-only tools; "all" is a host decision', async () => {
  for (const [defaultTools, expected] of [
    [undefined, ['read_note']],
    ['all', ['read_note', 'write_note']],
  ] as const) {
    const r = await rig(
      { root: { exec: callsThen(spawn({ task: '[[A]] look' })) } },
      { tools: notes().tools, subagents: { dynamic: defaultTools ? { defaultTools } : true } },
    )
    await r.go()
    assert.deepEqual(r.by('A', 'executor')[0].tools, expected)
    assert.deepEqual(of(r.events, 'subagent.start')[0].tools, expected)
    // The parent itself has everything, the spawn tool included.
    assert.deepEqual([...r.by('root', 'executor')[0].tools].sort(), [
      'read_note',
      SPAWN_SUBAGENT_TOOL,
      'write_note',
    ])
  }
})

test('tools: a named subset is exactly what the helper is offered', async () => {
  const { tools, log } = notes()
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] write it', tools: ['write_note'] })) },
      A: { exec: callsThen({ name: 'write_note', args: { text: 'x' } }) },
    },
    { tools },
  )
  await r.go()
  assert.deepEqual(r.by('A', 'executor')[0].tools, ['write_note'])
  assert.deepEqual(log, ['write:x'])
  // [] is a helper that only reasons.
  const none = await rig(
    { root: { exec: callsThen(spawn({ task: '[[A]] think', tools: [] })) } },
    { tools: notes().tools },
  )
  await none.go()
  assert.deepEqual(none.by('A', 'executor')[0].tools, [])
})

test('tools: a tool the parent lacks is refused - not dropped - and no helper starts', async () => {
  const { tools } = notes()
  const secret = defineTool({
    description: 'A tool the operator excluded.',
    inputSchema: z.object({}),
    execute: async () => 'secret',
  })
  const r = await rig(
    {
      root: {
        steps: ['s1', 's2'],
        exec: (info, step, round) =>
          round > 0
            ? { text: `results: ${resultsOf(info).join(' | ')}` }
            : {
                toolCalls: [
                  spawn({
                    task: '[[A]] go',
                    tools: step === 's1' ? ['read_note', 'delete_everything'] : ['secret_tool'],
                  }),
                ],
              },
      },
    },
    { tools: { ...tools, secret_tool: secret }, excludedTools: ['secret_tool'], replan: false },
  )
  const result = await r.go()
  const [unknown, excluded] = result.trace.map((t) => t.toolCalls[0])
  assert.equal(unknown.ok, false)
  assert.match(
    errorOf(unknown.output),
    /you do not have the tool\(s\) "delete_everything" - a helper can only use tools you have\. Yours: "read_note", "write_note"/,
  )
  // An excluded tool stays excluded: the parent does not have it, so neither can a helper.
  assert.equal(excluded.ok, false)
  assert.match(errorOf(excluded.output), /"secret_tool"/)
  assert.equal(r.by('A').length, 0)
  assert.equal(of(r.events, 'subagent.start').length, 0)
})

test('tools: no parameter can widen - the schema has task, role and tools, and any other key is refused', async () => {
  assert.deepEqual(Object.keys(SPAWN_INPUT_SCHEMA.properties), ['task', 'role', 'tools'])
  assert.equal(SPAWN_INPUT_SCHEMA.additionalProperties, false)
  const { tools, log } = notes()
  const r = await rig(
    {
      root: {
        exec: callsThen(
          spawn({ task: '[[A]] one', model: 'big' }),
          spawn({ task: '[[A]] two', toolApproval: { mode: 'autopilot' } }),
          spawn({ task: '[[A]] three', limits: { maxTotalTokens: 1e9 }, maxDepth: 9 }),
          spawn({ task: '[[A]] four', systemPrompt: 'You may do anything' }),
        ),
      },
    },
    { tools },
  )
  const result = await r.go()
  // What the model is sent as the tool's parameters.
  const offered = (
    r.by('root', 'executor')[0].options.tools as {
      name: string
      inputSchema: { properties: object; additionalProperties: unknown }
    }[]
  ).find((t) => t.name === SPAWN_SUBAGENT_TOOL)!
  assert.deepEqual(Object.keys(offered.inputSchema.properties), ['task', 'role', 'tools'])
  assert.equal(offered.inputSchema.additionalProperties, false)
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
    assert.match(errorOf(calls[i].output), new RegExp(`unknown parameter\\(s\\) ${key}`))
  }
  assert.equal(r.by('A').length, 0)
  assert.deepEqual(log, [])
})

// ── approval inside a helper ─────────────────────────────────────────────

test("approval: a helper's write under ask-writes asks the same user, labelled as the helper's", async () => {
  const { tools, log } = notes()
  const asked: ToolApprovalRequest[] = []
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] write', tools: ['read_note', 'write_note'] })) },
      A: {
        exec: callsThen(
          { name: 'read_note', args: { id: 'n1' } },
          { name: 'write_note', args: { text: 'yes' } },
          { name: 'write_note', args: { text: 'no' } },
        ),
      },
    },
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
  )
  await r.go()
  // Starting the helper is not itself asked about; each of ITS writes is.
  assert.deepEqual(
    asked.map((q) => q.toolName),
    ['write_note', 'write_note'],
  )
  const id = of(r.events, 'subagent.start')[0].id
  for (const req of asked) assert.deepEqual(req.subagent, { id, depth: 1 })
  assert.deepEqual(
    deep(r.events, 'tool.approval-requested').map((e) => e.subagent),
    [
      { id, depth: 1 },
      { id, depth: 1 },
    ],
  )
  assert.deepEqual(log, ['read:n1', 'write:yes'])
  assert.match(resultsOf(r.by('A', 'executor')[1]).join('\n'), /Tool call denied by the user/)
})

test('approval: a deny rule and the read-only mode hold inside a helper', async () => {
  for (const toolApproval of [
    { rules: { write_note: 'deny' } },
    { mode: 'read-only' },
  ] satisfies BrowserAgentConfig['toolApproval'][]) {
    const { tools, log } = notes()
    const r = await rig(
      {
        root: { exec: callsThen(spawn({ task: '[[A]] write', tools: ['write_note'] })) },
        A: { exec: callsThen({ name: 'write_note', args: { text: 'x' } }) },
      },
      { tools, toolApproval },
    )
    await r.go()
    assert.deepEqual(log, [], JSON.stringify(toolApproval))
    assert.deepEqual(
      deep(r.events, 'tool.approval-resolved').map((e) => [e.name, e.approved, e.automatic]),
      [['write_note', false, true]],
    )
    assert.match(resultsOf(r.by('A', 'executor')[1])[0], /Tool call denied/)
  }
})

test('approval: a mode the host tightens while a helper works applies to its next call', async () => {
  const { tools, log } = notes()
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] write', tools: ['write_note'] })) },
      A: {
        exec: (_info, _step, round) =>
          round < 2
            ? { toolCalls: [{ name: 'write_note', args: { text: `w${round}` } }] }
            : { text: 'done' },
      },
    },
    { tools },
  )
  await r.go({
    onEvent: (e) => {
      r.events.push(e)
      if (e.type === 'subagent.event' && e.event.type === 'step.tool-result') {
        r.agent.setToolApprovalMode('read-only')
      }
    },
  })
  assert.deepEqual(log, ['write:w0'])
})

test('approval: "always allow" given inside a helper is the agent\'s, and a rule on spawn_subagent applies', async () => {
  const { tools, log } = notes()
  const asked: string[] = []
  const r = await rig(
    {
      root: {
        exec: callsThen(spawn({ task: '[[A]] write', tools: ['write_note'] }), {
          name: 'write_note',
          args: { text: 'root' },
        }),
      },
      A: { exec: callsThen({ name: 'write_note', args: { text: 'helper' } }) },
    },
    {
      tools,
      toolApproval: {
        mode: 'ask-all',
        onRequest: (q) => {
          asked.push(`${q.toolName}:${q.subagent ? 'helper' : 'run'}`)
          return { approved: true, remember: true }
        },
      },
    },
  )
  await r.go()
  // ask-all asks about the spawn itself; one "always allow" per tool then covers the whole tree,
  // whoever - the run or its helper - happened to ask first.
  assert.equal(asked.filter((a) => a === `${SPAWN_SUBAGENT_TOOL}:run`).length, 1)
  assert.equal(asked.filter((a) => a.startsWith('write_note:')).length, 1)
  assert.equal(asked.length, 2)
  assert.deepEqual(log.sort(), ['write:helper', 'write:root'])

  const denied = await rig(
    { root: { exec: callsThen(spawn({ task: '[[A]] x' })) } },
    { toolApproval: { rules: { [SPAWN_SUBAGENT_TOOL]: 'deny' } } },
  )
  const result = await denied.go()
  assert.equal(result.trace[0].toolCalls[0].ok, false)
  assert.equal(denied.by('A').length, 0)
})

// ── limits ───────────────────────────────────────────────────────────────

test('depth: by default a helper cannot start helpers - it is not even offered the tool', async () => {
  const r = await rig(
    { root: { exec: callsThen(spawn({ task: '[[A]] delegate further' })) } },
    { tools: notes().tools },
  )
  await r.go()
  for (const c of r.by('A')) {
    assert.ok(!c.tools.includes(SPAWN_SUBAGENT_TOOL))
    assert.ok(!c.system.includes('HELPERS:'), stageOf(c))
    assert.ok(!c.system.includes(SPAWN_SUBAGENT_TOOL), stageOf(c))
  }
  // Naming the tool in the list does not get it either.
  const named = await rig({
    root: { exec: callsThen(spawn({ task: '[[A]] delegate', tools: [SPAWN_SUBAGENT_TOOL] })) },
  })
  await named.go()
  assert.deepEqual(named.by('A', 'executor')[0].tools, [])
  assert.equal(SUBAGENT_DEFAULTS.maxDepth, 1)
})

test('depth: maxDepth 2 lets a helper start one more level, and that level stops there', async () => {
  const { tools, log } = notes()
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] split the work', tools: ['read_note'] })) },
      A: {
        exec: callsThen(spawn({ task: '[[G]] read n9', tools: ['read_note'] })),
        final: 'A: done',
      },
      G: { exec: callsThen({ name: 'read_note', args: { id: 'n9' } }), final: 'G: note n9' },
    },
    { tools, subagents: { dynamic: { maxDepth: 2 } } },
  )
  await r.go()
  assert.deepEqual(log, ['read:n9'])
  assert.ok(r.by('A', 'executor')[0].tools.includes(SPAWN_SUBAGENT_TOOL))
  assert.match(r.by('A', 'executor')[0].system, /HELPERS:/)
  assert.deepEqual(r.by('G', 'executor')[0].tools, ['read_note'])
  assert.ok(!r.by('G', 'executor')[0].system.includes('HELPERS:'))
  assert.equal(firstResult(r, 'A'), 'G: note n9')
  assert.equal(firstResult(r), 'A: done')
})

test('depth: a helper of a helper narrows from ITS parent, not from the agent', async () => {
  const { tools, log } = notes()
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] split', tools: ['read_note'] })) },
      // A was given read_note only: it cannot hand write_note on, although the agent has it.
      A: { exec: callsThen(spawn({ task: '[[G]] write', tools: ['write_note'] })) },
      G: { exec: callsThen({ name: 'write_note', args: { text: 'x' } }) },
    },
    { tools, subagents: { dynamic: { maxDepth: 2 } } },
  )
  await r.go()
  assert.match(firstResult(r, 'A'), /you do not have the tool\(s\) "write_note"/)
  assert.equal(r.by('G').length, 0)
  assert.deepEqual(log, [])
})

test("children: a run starts at most maxChildren helpers, its helpers' helpers included", async () => {
  const r = await rig(
    {
      root: {
        exec: (info, _step, round) =>
          round < 3
            ? { toolCalls: [spawn({ task: `[[C${round}]] part ${round}` })] }
            : { text: `results: ${resultsOf(info).join(' | ')}` },
      },
    },
    { subagents: { dynamic: { maxChildren: 2 } } },
  )
  const result = await r.go()
  assert.deepEqual(
    result.trace[0].toolCalls.map((c) => c.ok),
    [true, true, false],
  )
  assert.match(
    errorOf(result.trace[0].toolCalls[2].output),
    /this run has already started 2 helper\(s\), the limit \(2\)/,
  )
  assert.equal(r.by('C2').length, 0)
  assert.equal(of(r.events, 'subagent.start').length, 2)

  // The count is the whole tree's: a helper's helper uses the run's allowance.
  const tree = await rig(
    {
      root: {
        exec: (info, _step, round) =>
          round < 2
            ? { toolCalls: [spawn({ task: round === 0 ? '[[A]] split' : '[[B]] more' })] }
            : { text: `results: ${resultsOf(info).join(' | ')}` },
      },
      A: { exec: callsThen(spawn({ task: '[[G]] leaf' })) },
    },
    { subagents: { dynamic: { maxChildren: 2, maxDepth: 2 } } },
  )
  const second = await tree.go()
  assert.deepEqual(
    second.trace[0].toolCalls.map((c) => c.ok),
    [true, false],
  )
  assert.equal(tree.by('G').length, 3)
  assert.equal(tree.by('B').length, 0)
  assert.equal(SUBAGENT_DEFAULTS.maxChildren, 8)
})

test('concurrency: at most maxConcurrent helpers of one parent run at once; the rest wait', async () => {
  for (const [maxConcurrent, peak] of [
    [1, 1],
    [2, 2],
  ] as const) {
    let running = 0
    let seen = 0
    const slow = defineTool({
      description: 'Slow read.',
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => {
        running += 1
        seen = Math.max(seen, running)
        await new Promise((resolve) => setTimeout(resolve, 30))
        running -= 1
        return 'ok'
      },
    })
    const helper: Actor = { exec: callsThen({ name: 'slow', args: {} }) }
    const r = await rig(
      {
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
      },
      { tools: { slow }, subagents: { dynamic: { maxConcurrent } } },
    )
    const result = await r.go()
    assert.deepEqual(
      result.trace[0].toolCalls.map((c) => c.ok),
      [true, true, true],
    )
    assert.equal(seen, peak, `maxConcurrent ${maxConcurrent}`)
  }
  assert.equal(SUBAGENT_DEFAULTS.maxConcurrent, 3)
})

test('budget: a helper gets a share of what is left of the token limit, and stops at it', async () => {
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] long work' })) },
      A: { steps: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'] },
    },
    {
      limits: { maxTotalTokens: 200 },
      maxIterations: 20,
      subagents: { dynamic: { minTokens: 20 } },
    },
  )
  await r.go()
  // The parent had spent its planner call (15) when it called: (200 - 15) * 0.5 = 92.
  assert.deepEqual(
    deep(r.events, 'budget.exceeded').map((e) => [e.kind, e.cap]),
    [['total', 92]],
  )
  // 15 for its plan and 15 a step: the share is crossed after the sixth, and the seventh is
  // not started.
  assert.equal(r.by('A', 'executor').length, 6)
})

test('budget: a spawn is refused when what is left cannot cover a helper', async () => {
  const r = await rig(
    { root: { exec: callsThen(spawn({ task: '[[A]] work' })) } },
    { limits: { maxTotalTokens: 200 }, subagents: { dynamic: { minTokens: 150 } } },
  )
  const result = await r.go()
  const call = result.trace[0].toolCalls[0]
  assert.equal(call.ok, false)
  assert.match(
    errorOf(call.output),
    /not enough of the total-token budget is left for a helper \(185 left, a helper's share would be 92, the minimum is 150\)/,
  )
  assert.equal(r.by('A').length, 0)
  assert.equal(of(r.events, 'subagent.start').length, 0)
  assert.equal(SUBAGENT_DEFAULTS.minTokens, 2000)
  assert.equal(SUBAGENT_DEFAULTS.budgetShare, 0.5)
})

test("budget: tool calls - a helper has a share, and its calls count on the parent's cap", async () => {
  const { tools, log } = notes()
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] read a lot' })) },
      A: {
        exec: (_info, _step, round) =>
          round < 3
            ? { toolCalls: [{ name: 'read_note', args: { id: `n${round}` } }] }
            : { text: 'done' },
      },
    },
    // The spawn is the parent's first call: 5 are left, a helper's share is 2.
    { tools, maxToolCalls: 6 },
  )
  let snapshot: RunSnapshot | undefined
  let closed = 0
  const persisted = await createAgent({
    model: scriptedModel(
      play({
        root: { exec: callsThen(spawn({ task: '[[A]] read a lot' })) },
        A: {
          exec: (_info, _step, round) =>
            round < 3
              ? { toolCalls: [{ name: 'read_note', args: { id: `n${round}` } }] }
              : { text: 'done' },
        },
      }),
    ).model,
    toolMode: 'native',
    subagents: { dynamic: true },
    tools: notes().tools,
    maxToolCalls: 6,
    persistence: {
      onRunComplete: (s) => {
        snapshot = s
        closed += 1
      },
    },
  })
  await persisted.run('Do the work')
  // The helper's 2 calls and the spawn itself are the parent's 3.
  assert.equal(snapshot?.toolCalls, 3)
  // A helper is not checkpointed: the store hears of the run, never of its helpers.
  assert.equal(closed, 1)
  await r.go()
  assert.deepEqual(log, ['read:n0', 'read:n1'])
  // It stopped at ITS cap (2), not the run's (6): two rounds, and no third.
  assert.equal(r.by('A', 'executor').length, 2)
  // Nothing left for a helper: refused.
  const none = await rig(
    { root: { exec: callsThen(spawn({ task: '[[A]] read' })) } },
    { tools: notes().tools, maxToolCalls: 2 },
  )
  const result = await none.go()
  assert.match(
    errorOf(result.trace[0].toolCalls[0].output),
    /not enough of the tool-call budget is left for a helper \(1 call\(s\) left\)/,
  )
  assert.equal(none.by('A').length, 0)
})

test('budget: the share holds inside one round too - calls made together are counted one by one', async () => {
  const { tools, log } = notes()
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] read three at once' })) },
      A: {
        exec: callsThen(
          { name: 'read_note', args: { id: 'n0' } },
          { name: 'read_note', args: { id: 'n1' } },
          { name: 'read_note', args: { id: 'n2' } },
        ),
      },
    },
    // 5 are left after the spawn, a helper's share is 2 - the run's own cap would allow all 3.
    { tools, maxToolCalls: 6 },
  )
  await r.go()
  assert.equal(log.length, 2, log.join(','))
  const refused = deep(r.events, 'step.tool-result').filter((e) => !e.ok)
  assert.equal(refused.length, 1)
  assert.match(errorOf(refused[0].output), /Tool-call budget exhausted \(2 per run\)/)
})

test('budget: a helper cannot make a call its parent has no budget left for', async () => {
  const { tools, log } = notes()
  const r = await rig(
    {
      root: {
        exec: (info, _step, round) =>
          round === 0
            ? {
                toolCalls: [
                  { name: 'read_note', args: { id: 'p1' } },
                  { name: 'read_note', args: { id: 'p2' } },
                  spawn({ task: '[[A]] read' }),
                ],
              }
            : { text: `results: ${resultsOf(info).length}` },
      },
      A: {
        exec: (_info, _step, round) =>
          round < 4
            ? { toolCalls: [{ name: 'read_note', args: { id: `a${round}` } }] }
            : { text: 'done' },
      },
    },
    { tools, maxToolCalls: 4, subagents: { dynamic: { budgetShare: 1 } } },
  )
  await r.go()
  // Whatever order the three calls were counted in, the run made 4 calls in all.
  assert.equal(log.length + 1, 4, log.join(','))
})

test('budget: what a running helper was promised is not promised to the next one', async () => {
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] first' }), spawn({ task: '[[B]] second' })) },
      A: { exec: callsThen({ name: 'read_note', args: { id: 'a' } }) },
    },
    // Both spawns are counted (2 of 6) when the first helper is promised all 4 that are left.
    { tools: notes().tools, maxToolCalls: 6, subagents: { dynamic: { budgetShare: 1 } } },
  )
  const result = await r.go()
  // (The trace lists calls as they finish: the refusal comes back first.)
  const refused = result.trace[0].toolCalls.filter((c) => !c.ok)
  assert.equal(result.trace[0].toolCalls.length, 2)
  assert.equal(refused.length, 1)
  assert.match(
    errorOf(refused[0].output),
    /not enough of the tool-call budget is left for a helper \(0 call\(s\) left\)/,
  )
  assert.equal(r.by('B').length, 0)
})

test('budget: iterations are a share of the cap, and the wall clock has its own limit', async () => {
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] many steps' })) },
      A: { steps: ['a1', 'a2', 'a3', 'a4', 'a5'] },
    },
    { maxIterations: 6 },
  )
  await r.go()
  assert.equal(r.by('A', 'executor').length, 3)

  const slow = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] slow' })) },
      A: { exec: callsThen({ name: 'wait', args: {} }) },
    },
    { tools: { wait: hang(() => {}) }, subagents: { dynamic: { timeoutMs: 60 } } },
  )
  const result = await slow.go()
  assert.match(firstResult(slow), /the helper timed out after 60ms/)
  assert.equal(result.final, 'root answer')
  assert.match(of(slow.events, 'subagent.error')[0].error, /timed out/)
  assert.equal(SUBAGENT_DEFAULTS.timeoutMs, 300_000)
})

// ── abort, stop ──────────────────────────────────────────────────────────

test("abort: the parent's signal stops every helper", async () => {
  const ac = new AbortController()
  let hanging = 0
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] wait' }), spawn({ task: '[[B]] wait' })) },
      A: { exec: callsThen({ name: 'wait', args: {} }) },
      B: { exec: callsThen({ name: 'wait', args: {} }) },
    },
    {
      tools: {
        wait: hang(() => {
          hanging += 1
          if (hanging === 2) ac.abort()
        }),
      },
    },
  )
  const result = await r.go({ signal: ac.signal })
  assert.equal(result.stopped, true)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(of(r.events, 'subagent.error').length, 2)
  const before = r.calls.length
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(r.calls.length, before, 'no helper kept working after the abort')
})

test('stopSubagent: stops one helper; the run and its sibling carry on', async () => {
  const control = createRunControl()
  let listed: ReturnType<typeof control.subagents> = []
  const r = await rig(
    {
      root: {
        exec: callsThen(
          spawn({ task: '[[A]] wait', role: 'waiter' }),
          spawn({ task: '[[B]] quick' }),
        ),
      },
      A: { exec: callsThen({ name: 'wait', args: {} }) },
      B: { final: 'B: done' },
    },
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
  )
  const result = await r.go({ control })
  assert.equal(result.final, 'root answer')
  assert.equal(result.stopped, false)
  const a = listed.find((s) => s.task.includes('[[A]]'))!
  assert.deepEqual(
    [a.name, a.depth, a.dynamic, a.role, a.parentId],
    [SPAWN_SUBAGENT_TOOL, 1, true, 'waiter', undefined],
  )
  const errors = of(r.events, 'subagent.error')
  assert.deepEqual(
    errors.map((e) => [e.id, e.stopped]),
    [[a.id, true]],
  )
  // What the helper had spent is reported, and stays charged: its planner call (the step it
  // was stopped in never reported its usage).
  assert.equal(errors[0].usage?.totalTokens, 15)
  const results = resultsOf(r.by('root', 'executor')[1])
  assert.match(results.join('\n'), /the helper was stopped by the user before it finished/)
  assert.ok(results.includes('B: done'))
  assert.deepEqual(control.subagents(), [])
})

test("stopSubagent: a helper's helper registers in the run's control too", async () => {
  const control = createRunControl()
  let seen: { depth?: number; parentId?: string; id: string }[] = []
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] split', tools: ['wait'] })) },
      A: {
        exec: callsThen(spawn({ task: '[[G]] wait', tools: ['wait'] })),
        final: 'A: carried on',
      },
      G: { exec: callsThen({ name: 'wait', args: {} }) },
    },
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
  )
  await r.go({ control })
  assert.deepEqual(seen.map((s) => s.depth).sort(), [1, 2])
  assert.equal(seen.find((s) => s.depth === 2)!.parentId, seen.find((s) => s.depth === 1)!.id)
  assert.equal(firstResult(r), 'A: carried on')
})

// ── the event tree ───────────────────────────────────────────────────────

interface Node {
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
const treeOf = (events: AgentEvent[]): Map<string, Node> => {
  const nodes = new Map<string, Node>()
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
      Object.assign(nodes.get(e.id) as Node, { status: 'done', tokens: e.usage.totalTokens })
    } else if (e.type === 'subagent.error') {
      Object.assign(nodes.get(e.id) as Node, { status: 'failed', tokens: e.usage?.totalTokens })
    }
  }
  return nodes
}

const runIdOf = (events: AgentEvent[]): string => of(events, 'run.start')[0].runId as string

test('events: ids, parentId and depth form the tree, from the stream alone', async () => {
  const control = createRunControl()
  const r = await rig(
    {
      root: {
        exec: callsThen(
          spawn({ task: '[[A]] split', role: 'lead' }),
          spawn({ task: '[[B]] alone' }),
        ),
      },
      A: {
        exec: callsThen(
          spawn({ task: '[[G]] leaf', tools: [] }),
          spawn({ task: '[[H]] fail', tools: ['wait'] }),
        ),
      },
      H: { exec: callsThen({ name: 'wait', args: {} }) },
    },
    {
      tools: {
        wait: hang(() => {
          const h = control.subagents().find((s) => s.task.includes('[[H]]'))
          control.stopSubagent((h as { id: string }).id)
        }),
      },
      subagents: { dynamic: { maxDepth: 2, defaultTools: 'all' } },
    },
  )
  const result = await r.go({ control })
  const runId = runIdOf(r.events)
  const nodes = [...treeOf(r.events).values()]
  const node = (marker: string) => nodes.find((n) => n.task.includes(`[[${marker}]]`)) as Node
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
  // Usage rolls up: A's includes its helpers' (H had only planned when it was stopped).
  assert.equal(node('G').tokens, 45)
  assert.equal(node('H').tokens, 15)
  assert.equal(node('A').tokens, 4 * 15 + 45 + 15)
  assert.equal(result.usage.totalTokens, 4 * 15 + node('A').tokens! + node('B').tokens!)

  // Every event of a helper is attributable: the envelopes above it name its ancestors,
  // innermost last, and their number is its depth.
  for (const [chain, e] of flatten(r.events)) {
    if (e.type === 'subagent.start') {
      assert.equal(chain.length, (e.depth as number) - 1)
      assert.equal(chain.at(-1) ?? runId, e.parentId)
    }
  }
  const leaf = flatten(r.events).find(
    ([chain, e]) => e.type === 'final' && chain.at(-1) === node('G').id,
  )
  assert.deepEqual(leaf?.[0], [node('A').id, node('G').id])
})

test('events: a static subagent is a node of the same tree, under whoever called it', async () => {
  const model = scriptedModel(
    play({
      root: {
        exec: callsThen(
          { name: 'researcher', args: { task: '[[S]] direct' } },
          spawn({ task: '[[A]] use the researcher', tools: ['researcher'] }),
        ),
      },
      A: { exec: callsThen({ name: 'researcher', args: { task: '[[T]] nested' } }) },
    }),
  )
  // The static subagent is an agent of its own, configured by the host.
  const researcher = createSubagentTool({
    name: 'researcher',
    description: 'Research.',
    config: { model: model.model, toolMode: 'native' },
  })
  const agent = await createAgent({
    model: model.model,
    toolMode: 'native',
    subagents: { dynamic: true },
    tools: { researcher },
  })
  const events: AgentEvent[] = []
  await agent.run('Do the work', { onEvent: (e) => events.push(e) })
  const runId = runIdOf(events)
  const nodes = [...treeOf(events).values()]
  const node = (m: string) => nodes.find((n) => n.task.includes(`[[${m}]]`)) as Node
  assert.deepEqual([node('S').parentId, node('S').depth], [runId, 1])
  assert.deepEqual([node('A').parentId, node('A').depth], [runId, 1])
  assert.deepEqual([node('T').parentId, node('T').depth], [node('A').id, 2])
})

test('events: a helper started inside a static subagent is a node under that subagent', async () => {
  const model = scriptedModel(
    play({
      root: { exec: callsThen({ name: 'researcher', args: { task: '[[S]] research' } }) },
      S: { exec: callsThen(spawn({ task: '[[X]] part' })) },
    }),
  )
  // The static subagent's own agent lets ITS model start helpers.
  const researcher = createSubagentTool({
    name: 'researcher',
    description: 'Research.',
    config: { model: model.model, toolMode: 'native', subagents: { dynamic: true } },
  })
  const agent = await createAgent({ model: model.model, toolMode: 'native', tools: { researcher } })
  const events: AgentEvent[] = []
  await agent.run('Do the work', { onEvent: (e) => events.push(e) })
  const nodes = [...treeOf(events).values()]
  const node = (m: string) => nodes.find((n) => n.task.includes(`[[${m}]]`)) as Node
  assert.deepEqual([node('S').parentId, node('S').depth], [runIdOf(events), 1])
  assert.deepEqual([node('X').parentId, node('X').depth], [node('S').id, 2])
})

test('events (pure): a start gains a level and its real parent on the way up', () => {
  const start = { type: 'subagent.start', id: 'g', parentId: 'run-of-c', depth: 1 }
  const once = adoptSubagentEvent(start, 'c')
  assert.deepEqual(once, { type: 'subagent.start', id: 'g', parentId: 'c', depth: 2 })
  const twice = adoptSubagentEvent({ type: 'subagent.event', id: 'c', event: once }, 'p')
  assert.deepEqual(twice, {
    type: 'subagent.event',
    id: 'c',
    event: { type: 'subagent.start', id: 'g', parentId: 'c', depth: 3 },
  })
  const other = { type: 'step.start', depth: 7 }
  assert.equal(adoptSubagentEvent(other, 'p'), other)
})

// ── off = identical; on = said once ──────────────────────────────────────

const GOLDEN = new URL('./fixtures/requests-without-tiers.json', import.meta.url)

/** What a model was sent, as plain data (tool-call ids are a process-wide counter: folded). */
const wire = (calls: CallInfo[]): unknown =>
  JSON.parse(
    JSON.stringify(
      calls.map(({ options: o }) => ({
        prompt: o.prompt,
        tools: o.tools,
        toolChoice: o.toolChoice,
        responseFormat: o.responseFormat,
        maxOutputTokens: o.maxOutputTokens,
        temperature: o.temperature,
        providerOptions: o.providerOptions,
      })),
    ).replace(/call-\d+/g, 'call-N'),
  )

// The run tests/model-tiers.test.ts records its fixture from.
const goldenRun = async (
  mode: 'native' | 'prompted',
  extra: Partial<BrowserAgentConfig> = {},
): Promise<CallInfo[]> => {
  const model = scriptedModel((info) => {
    const first = /STEP 1\//.test(info.user)
    if (mode === 'prompted') {
      switch (stageOf(info)) {
        case 'planner':
          return { text: JSON.stringify({ reply: 'ok', plan: ['[low] Note it', 'Check it'] }) }
        case 'replanner':
          return { text: JSON.stringify({ decision: 'continue', reason: 'on track' }) }
        case 'executor':
          return first && !info.user.includes('TOOL RESULTS')
            ? {
                text: JSON.stringify({
                  reply: '',
                  actions: [{ tool: 'note_write', args: { text: 'hello' } }],
                }),
              }
            : { text: JSON.stringify({ reply: 'finished', actions: [] }) }
        default:
          return { text: 'All done.' }
      }
    }
    switch (stageOf(info)) {
      case 'planner':
        return { text: planJson(['s1', 's2']) }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'continue', reason: 'on track' }) }
      case 'executor':
        return first && info.toolResults === 0
          ? { toolCalls: [{ name: 'note_write', args: { text: 'hello' } }] }
          : { text: 'finished' }
      default:
        return { text: 'All done.' }
    }
  })
  const agent = await createAgent({
    model: model.model,
    toolMode: mode,
    replanAfter: 'always',
    tools: {
      note_write: defineTool({
        description: 'Write a note.',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => `saved ${text}`,
      }),
    },
    ...extra,
  })
  await agent.run('Take a note and check it')
  return model.calls
}

test('off: without the switch the calls are the recorded ones, byte for byte', async () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { native: unknown; prompted: unknown }
  for (const extra of [
    {},
    { subagents: {} },
    { subagents: { dynamic: false } },
  ] satisfies Partial<BrowserAgentConfig>[]) {
    for (const mode of ['native', 'prompted'] as const) {
      const sent = wire(await goldenRun(mode, extra))
      assert.deepEqual(sent, golden[mode], `${mode} ${JSON.stringify(extra)}`)
      assert.ok(!JSON.stringify(sent).includes(SPAWN_SUBAGENT_TOOL))
      assert.ok(!JSON.stringify(sent).includes('HELPERS'))
    }
  }
  assert.equal(resolveDynamicSubagents(undefined), undefined)
  assert.equal(resolveDynamicSubagents({}), undefined)
  assert.equal(resolveDynamicSubagents({ dynamic: false }), undefined)
})

test('on: the tool is offered, and the planner and the executor are told once when a helper is worth it', async () => {
  for (const mode of ['native', 'prompted'] as const) {
    const off = await goldenRun(mode)
    const on = await goldenRun(mode, { subagents: { dynamic: true } })
    assert.equal(on.length, off.length)
    for (const [i, c] of on.entries()) {
      const stage = stageOf(c)
      const told = stage === 'planner' || stage === 'executor'
      assert.equal(c.system.includes('\n\nHELPERS:\n'), told, `${mode} ${stage}`)
      // The replanner's and the synthesizer's prompts do not move at all.
      if (!told) assert.equal(c.system, off[i].system, `${mode} ${stage}`)
      if (stage === 'executor' && mode === 'native') {
        assert.deepEqual([...c.tools].sort(), ['note_write', SPAWN_SUBAGENT_TOOL])
        const description = (c.options.tools as { name: string; description: string }[]).find(
          (t) => t.name === SPAWN_SUBAGENT_TOOL,
        )!.description
        assert.match(description, /independent of the rest of your work/)
        assert.match(description, /reading a lot/)
        assert.match(description, /comes out of THIS run's budget/)
        assert.match(description, /your read-only tools/)
      }
    }
    // The planner sees it in the catalogue like any tool - with its parameters, for a model
    // that is prompted rather than given tool definitions.
    assert.match(on[0].system, new RegExp(`${SPAWN_SUBAGENT_TOOL}`))
    if (mode === 'prompted') {
      assert.match(
        on.find((c) => stageOf(c) === 'executor')!.user,
        /spawn_subagent\{ task: string, role\?: string, tools\?: string\[\] \}|spawn_subagent.*task: string/,
      )
    }
  }
})

test('on: prompted mode - a model without native tool calling starts a helper too', async () => {
  const { tools, log } = notes()
  const model = scriptedModel((info) => {
    const who = whoOf(info)
    switch (stageOf(info)) {
      case 'planner':
        return { text: JSON.stringify({ reply: 'ok', plan: ['Step s1'] }) }
      case 'synthesizer':
        return { text: `${who} answer` }
      default: {
        const done = info.user.includes('TOOL RESULTS')
        const action =
          who === 'root'
            ? { tool: SPAWN_SUBAGENT_TOOL, args: { task: '[[A]] read n1', tools: ['read_note'] } }
            : { tool: 'read_note', args: { id: 'n1' } }
        return {
          text: JSON.stringify(
            done ? { reply: 'finished', actions: [] } : { reply: '', actions: [action] },
          ),
        }
      }
    }
  })
  const agent = await createAgent({
    model: model.model,
    toolMode: 'prompted',
    subagents: { dynamic: true },
    tools,
  })
  const events: AgentEvent[] = []
  const result = await agent.run('Do the work', { onEvent: (e) => events.push(e) })
  assert.deepEqual(log, ['read:n1'])
  assert.deepEqual(
    [result.trace[0].toolCalls[0].name, result.trace[0].toolCalls[0].output],
    [SPAWN_SUBAGENT_TOOL, 'A answer'],
  )
  assert.deepEqual(of(events, 'subagent.start')[0].tools, ['read_note'])
})

test("on: the host's own tool of that name wins, and then nothing is said about helpers", async () => {
  const calls = await goldenRun('native', {
    subagents: { dynamic: true },
    tools: {
      [SPAWN_SUBAGENT_TOOL]: defineTool({
        description: 'The host own tool.',
        inputSchema: z.object({}),
        execute: async () => 'host',
      }),
    },
  })
  assert.ok(calls.every((c) => !c.system.includes('HELPERS:')))
  // And a tool list without it mounts none.
  const filtered = await goldenRun('native', {
    subagents: { dynamic: true },
    availableTools: ['note_write'],
  })
  assert.ok(!JSON.stringify(wire(filtered)).includes(SPAWN_SUBAGENT_TOOL))
})

// ── what a helper inherits ───────────────────────────────────────────────

test('inherits: skills to read, never the notebook to write', async () => {
  const skill = defineSkill({
    name: 'house-style',
    description: 'How we write.',
    content: 'Write plainly.',
  })
  const r = await rig(
    {
      root: {
        steps: ['s1', 's2'],
        exec: (info, step, round) =>
          round > 0
            ? { text: `results: ${resultsOf(info).join(' | ')}` }
            : {
                toolCalls: [
                  step === 's1'
                    ? spawn({ task: '[[A]] write it up' })
                    : spawn({ task: '[[B]] learn', tools: ['save_skill'] }),
                ],
              },
      },
      A: { exec: callsThen({ name: 'load_skill', args: { name: 'house-style' } }) },
    },
    {
      skills: [skill],
      learning: true,
      replan: false,
      subagents: { dynamic: { defaultTools: 'all' } },
    },
  )
  const result = await r.go()
  // The parent has the notebook; the helper, given "all", does not.
  assert.ok(r.by('root', 'executor')[0].tools.includes('save_skill'))
  assert.deepEqual([...r.by('A', 'executor')[0].tools].sort(), ['load_skill', 'read_skill_file'])
  // It reads the parent's skills: the index is in its prompt and load_skill works.
  assert.match(r.by('A', 'executor')[0].system, /house-style: How we write\./)
  assert.match(resultsOf(r.by('A', 'executor')[1])[0], /Write plainly\./)
  // And it is not told to keep a notebook it does not have.
  assert.ok(!r.by('A', 'executor')[0].system.includes('save_skill'))
  assert.match(r.by('root', 'executor')[0].system, /save_skill/)
  // Asking for the notebook by name is refused.
  const refused = result.trace[1].toolCalls[0]
  assert.equal(refused.ok, false)
  assert.match(
    errorOf(refused.output),
    /"save_skill" cannot be given to a helper: the notebook of lessons stays with you/,
  )
  assert.equal(r.by('B').length, 0)
  assert.deepEqual(r.agent.listLearnedSkills(), [])
})

test('inherits: the executor tiers - a helper runs its steps on the same model objects', async () => {
  const actors = {
    root: {
      plan: () => ({ text: planJson(['s1'], 'medium') }),
      exec: callsThen(spawn({ task: '[[A]] hard part' })),
    },
    A: { plan: () => ({ text: planJson(['s1'], 'high') }) },
  }
  const named = (id: string) => {
    const m = scriptedModel(play(actors))
    Object.defineProperty(m.model, 'modelId', { value: id })
    return m
  }
  const [plan, lite, std, big] = ['plan', 'lite', 'std', 'big'].map(named)
  const agent = await createAgent({
    model: std.model,
    planner: plan.model,
    synthesizer: plan.model,
    executorTiers: { light: lite.model, strong: big.model },
    toolMode: 'native',
    subagents: { dynamic: true },
  })
  await agent.run('Do the work')
  const helper = (calls: CallInfo[]) => calls.filter((c) => whoOf(c) === 'A').map(stageOf)
  assert.deepEqual(helper(plan.calls), ['planner', 'synthesizer'])
  assert.deepEqual(helper(big.calls), ['executor'])
  assert.deepEqual(helper(std.calls), [])
  assert.deepEqual(helper(lite.calls), [])
})

test('inherits: web_fetch under the SAME egress policy - a host the parent cannot reach stays out of reach', async () => {
  const fetched: string[] = []
  const r = await rig(
    {
      root: { exec: callsThen(spawn({ task: '[[A]] fetch it' })) },
      A: { exec: callsThen({ name: 'web_fetch', args: { url: 'https://evil.example/data' } }) },
    },
    {
      egress: {
        allow: ['docs.example.com'],
        fetch: (async (url: string) => {
          fetched.push(String(url))
          return new Response('nope')
        }) as never,
      },
    },
  )
  await r.go()
  // With an allow list web_fetch is read-only, so it is in the default set.
  assert.deepEqual(r.by('A', 'executor')[0].tools, ['web_fetch'])
  assert.deepEqual(
    deep(r.events, 'egress.request').map((e) => [e.url, e.allowed]),
    [['https://evil.example/data', false]],
  )
  assert.deepEqual(fetched, [])
  // The helper has the caller's web_fetch or none: `egress` is not its own to switch on.
  const bare = await rig(
    { root: { exec: callsThen(spawn({ task: '[[A]] think', tools: [] })) } },
    { egress: { allow: ['docs.example.com'] }, search: { engine: async () => [] } },
  )
  await bare.go()
  assert.deepEqual(bare.by('A', 'executor')[0].tools, [])
  // Without egress on the parent there is nothing to name.
  const none = await rig({
    root: { exec: callsThen(spawn({ task: '[[A]] fetch', tools: ['web_fetch'] })) },
  })
  await none.go()
  assert.match(firstResult(none), /you do not have the tool\(s\) "web_fetch"/)
})

test('inherits: run_js - the same sandbox, with its note, when the helper is given it', async () => {
  const r = await rig(
    {
      root: {
        exec: callsThen(
          spawn({ task: '[[A]] compute', tools: ['run_js'] }),
          spawn({ task: '[[B]] no code' }),
        ),
      },
      A: { exec: callsThen({ name: 'run_js', args: { code: 'console.log(6 * 7)' } }) },
    },
    { sandbox: true },
  )
  await r.go()
  assert.deepEqual(r.by('A', 'executor')[0].tools, ['run_js'])
  assert.match(resultsOf(r.by('A', 'executor')[1])[0], /42/)
  // The helper's prompts carry what the parent's say about run_js; one without it, nothing.
  const note = /[^\n]*Never say that code was run[^\n]*/.exec(
    r.by('root', 'executor')[0].system,
  )?.[0] as string
  assert.ok(note && r.by('A', 'executor')[0].system.includes(note))
  assert.deepEqual(r.by('B', 'executor')[0].tools, [])
  assert.ok(!r.by('B', 'executor')[0].system.includes('run_js'))
})

test("inherits: none of the session - a helper neither reads nor writes the caller's memory", async () => {
  const memory = new MemoryStore()
  await memory.append('default', { role: 'user', content: 'EARLIER TURN' })
  const r = await rig({ root: { exec: callsThen(spawn({ task: '[[A]] think' })) } }, { memory })
  await r.go()
  // The parent's planner is shown the transcript; no call of the helper is.
  assert.match(r.by('root', 'planner')[0].user, /EARLIER TURN/)
  for (const c of r.by('A')) assert.ok(!c.user.includes('EARLIER TURN'), stageOf(c))
  assert.deepEqual(
    (await memory.load('default')).map((m) => m.content),
    ['EARLIER TURN', 'Do the work', 'root answer'],
  )
})

// ── escalation and resume ────────────────────────────────────────────────

test('escalation: a helper that finished in an earlier attempt at the step is not run again', async () => {
  const { tools, log } = notes()
  const actors = (id: string): Record<string, Actor> => ({
    root: {
      plan: () => ({ text: planJson(['s1'], 'low') }),
      exec: (info, _step, round) =>
        round === 0
          ? { toolCalls: [spawn({ task: '[[A]] write once', tools: ['write_note'] })] }
          : id === 'lite'
            ? { text: 'I cannot finish this.\n[BLOCKER]' }
            : { text: `finished with: ${resultsOf(info).join(' | ')}` },
    },
    A: { exec: callsThen({ name: 'write_note', args: { text: 'once' } }), final: 'A: written' },
  })
  const lite = scriptedModel(play(actors('lite')))
  const std = scriptedModel(play(actors('std')))
  const agent = await createAgent({
    model: std.model,
    executorTiers: { light: lite.model },
    toolMode: 'native',
    subagents: { dynamic: true },
    tools,
  })
  const events: AgentEvent[] = []
  const result = await agent.run('Do the work', { onEvent: (e) => events.push(e) })
  assert.deepEqual(result.trace[0].escalations, [
    { from: 'light', to: 'standard', reason: 'blocked' },
  ])
  // The stronger model made the same call; the helper - and its write - ran once.
  assert.deepEqual(log, ['write:once'])
  assert.equal(of(events, 'subagent.start').length, 1)
  const replayed = resultsOf(
    std.calls.filter((c) => whoOf(c) === 'root' && stageOf(c) === 'executor').at(-1) as CallInfo,
  )[0]
  assert.match(replayed, /not run again: this exact call already succeeded/)
  assert.match(replayed, /A: written/)
})

test('resume: a run interrupted while a helper works re-runs that step - the helper starts over', async () => {
  // A dead tab writes no closing snapshot: what is left is the last checkpoint.
  let saved: RunSnapshot | undefined
  const persistence: RunPersistence = {
    onRunStart: (s) => void (saved = structuredClone(s)),
    onStepComplete: (s) => void (saved = structuredClone(s)),
    loadRun: () => saved ?? null,
  }
  const ac = new AbortController()
  const { tools, log } = notes()
  let waits = 0
  const wait = defineTool({
    description: 'Wait.',
    inputSchema: z.object({}),
    readOnly: true,
    execute: async (_i, options) => {
      waits += 1
      if (waits > 1) return 'ready'
      // The first time: the tab "dies" while the helper is in the middle of its work.
      ac.abort()
      const signal = (options as { abortSignal?: AbortSignal }).abortSignal
      return new Promise<string>((_resolve, reject) => {
        const stop = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal?.aborted) return stop()
        signal?.addEventListener('abort', stop, { once: true })
      })
    },
  })
  const actors: Record<string, Actor> = {
    root: {
      steps: ['s1', 's2'],
      exec: (info, step, round) =>
        round > 0
          ? { text: `results: ${resultsOf(info).join(' | ')}` }
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
      exec: (_info, _step, round) =>
        round === 0
          ? { toolCalls: [{ name: 'write_note', args: { text: 'b' } }] }
          : round === 1
            ? { toolCalls: [{ name: 'wait', args: {} }] }
            : { text: 'B did it' },
      final: 'B: done',
    },
  }
  const extra = { tools: { ...tools, wait }, persistence, replan: false }
  const first = await rig(actors, extra)
  const stopped = await first.go({ signal: ac.signal })
  assert.equal(stopped.stopped, true)
  const snapshot = saved as RunSnapshot
  // Step s1 (helper A) is done and counted; s2 was in flight: still to run.
  assert.deepEqual(
    [snapshot.trace.length, snapshot.remaining.map((s) => s.description)],
    [1, ['Step s2']],
  )
  assert.equal(snapshot.subagentsSpawned, 1)
  assert.equal(of(first.events, 'subagent.start').length, 2)
  // The checkpoint is from BEFORE the lost helper started: what it spent is in this agent's
  // counter, not in the checkpoint.
  assert.equal(snapshot.usage.totalTokens, 15 + 30 + 45)
  assert.equal(first.agent.usage.totalTokens, 15 + 30 + 45 + 15)
  assert.deepEqual(log, ['write:b'])

  const second = await rig(actors, extra)
  const result = await second.go({ resumeFromRunId: snapshot.runId })
  assert.equal(result.final, 'root answer')
  // The step ran again from its start: a NEW helper, from the task alone - and its write
  // happened a second time (nothing of the lost helper is replayed).
  const again = of(second.events, 'subagent.start')
  assert.equal(again.length, 1)
  assert.ok(!of(first.events, 'subagent.start').some((e) => e.id === again[0].id))
  assert.deepEqual(log, ['write:b', 'write:b'])
  assert.equal(firstResult(second), 'B: done')
  // The run's count of helpers went on from the checkpoint's.
  assert.equal(saved?.subagentsSpawned, 2)
})

test('resume: maxChildren counts the helpers of the whole run, across a resume', async () => {
  let saved: RunSnapshot | undefined
  const ac = new AbortController()
  const persistence: RunPersistence = {
    onStepComplete: (s) => {
      saved = structuredClone(s)
      ac.abort()
    },
    loadRun: () => saved ?? null,
  }
  const actors: Record<string, Actor> = {
    root: {
      steps: ['s1', 's2'],
      exec: (info, step, round) =>
        round > 0
          ? { text: `results: ${resultsOf(info).join(' | ')}` }
          : { toolCalls: [spawn({ task: `[[${step === 's1' ? 'A' : 'B'}]] work` })] },
    },
  }
  const extra: Partial<BrowserAgentConfig> = {
    persistence,
    replan: false,
    subagents: { dynamic: { maxChildren: 1 } },
  }
  const first = await rig(actors, extra)
  await first.go({ signal: ac.signal })
  assert.equal(saved?.subagentsSpawned, 1)
  const second = await rig(actors, {
    ...extra,
    persistence: { loadRun: persistence.loadRun },
  })
  const result = await second.go({ resumeFromRunId: (saved as RunSnapshot).runId })
  assert.match(
    errorOf(result.trace[1].toolCalls[0].output),
    /this run has already started 1 helper\(s\), the limit \(1\)/,
  )
  assert.equal(second.by('B').length, 0)
})

// ── configuration ────────────────────────────────────────────────────────

test('config: defaults, bounds, and a bad value is a configuration error', async () => {
  assert.deepEqual(resolveDynamicSubagents({ dynamic: true }), SUBAGENT_DEFAULTS)
  assert.deepEqual(resolveDynamicSubagents({ dynamic: { maxDepth: 2, timeoutMs: 0 } }), {
    ...SUBAGENT_DEFAULTS,
    maxDepth: 2,
    timeoutMs: 0,
  })
  assert.throws(
    () => resolveDynamicSubagents({ dynamic: { maxDepth: SUBAGENT_MAX_DEPTH_LIMIT + 1 } }),
    /subagents\.dynamic\.maxDepth/,
  )
  const model = scriptedModel(() => ({ text: 'x' }))
  await assert.rejects(
    () => createAgent({ model: model.model, subagents: { dynamic: { budgetShare: 2 } } }),
    /subagents\.dynamic\.budgetShare must be a number above 0 and at most 1/,
  )
})
