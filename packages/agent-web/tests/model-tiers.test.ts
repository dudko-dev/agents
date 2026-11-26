import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import {
  createAgent,
  defineTool,
  escalationReasonOf,
  isEscalatableError,
  MemoryRunStore,
  nextStrongerTier,
  nodeResolver,
  parsePlannerResponse,
  pickTier,
  resolveEscalation,
  TieredPlanSchema,
  type AgentEvent,
  type BrowserAgentConfig,
  type ModelTier,
  type RunPersistence,
  type RunSnapshot,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// Model tiers (`executorTiers`) and escalation (`escalation`). Every tier is a scripted model of
// its own, so "which tier ran this call" is simply "whose call log grew": 'lite' / 'std' / 'big'
// for the executor tiers, 'plan' for the planner, the replanner and the synthesizer.

type Complexity = 'low' | 'medium' | 'high' | undefined

const planOf = (complexities: Complexity[]): string =>
  JSON.stringify({
    thought: 'Plan.',
    steps: complexities.map((complexity, i) => ({
      description: `Step s${i + 1}`,
      ...(complexity ? { complexity } : {}),
    })),
  })

/** The step an executor call is for. `STEP n/m: …` heads its user prompt. */
const stepOf = (info: CallInfo): string => /STEP \d+\/\d+: Step (\w+)/.exec(info.user)?.[1] ?? '?'

type ExecutorScript = (step: string, model: string, info: CallInfo) => Reply

interface Rig {
  config: BrowserAgentConfig
  /** Every executor call, in order, as `step:model` (a tool loop makes several per attempt). */
  executed: string[]
  /** The same with consecutive repeats folded: one entry per attempt. */
  attempts: () => string[]
  calls: Record<'plan' | 'lite' | 'std' | 'big', CallInfo[]>
  models: Record<'plan' | 'lite' | 'std' | 'big', ReturnType<typeof scriptedModel>['model']>
}

const rig = (
  planner: Reply | ((info: CallInfo) => Reply),
  executor: ExecutorScript,
  extra: Partial<BrowserAgentConfig> = {},
  replanner: (info: CallInfo) => Reply = () => ({
    text: JSON.stringify({ decision: 'continue', reason: 'on track' }),
  }),
): Rig => {
  const executed: string[] = []
  const tier = (id: string) => {
    const m = scriptedModel((info) => {
      executed.push(`${stepOf(info)}:${id}`)
      return executor(stepOf(info), id, info)
    })
    Object.defineProperty(m.model, 'modelId', { value: id })
    return m
  }
  const plan = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return typeof planner === 'function' ? planner(info) : planner
      case 'replanner':
        return replanner(info)
      default:
        return { text: 'All done.' }
    }
  })
  Object.defineProperty(plan.model, 'modelId', { value: 'plan' })
  const lite = tier('lite')
  const std = tier('std')
  const big = tier('big')
  return {
    executed,
    attempts: () => executed.filter((e, i) => e !== executed[i - 1]),
    calls: { plan: plan.calls, lite: lite.calls, std: std.calls, big: big.calls },
    models: { plan: plan.model, lite: lite.model, std: std.model, big: big.model },
    config: {
      model: std.model,
      planner: plan.model,
      synthesizer: plan.model,
      executorTiers: { light: lite.model, strong: big.model },
      ...extra,
    },
  }
}

const runRig = async (r: Rig, signal?: AbortSignal) => {
  const agent = await createAgent(r.config)
  const events: AgentEvent[] = []
  const result = await agent.run('Do the work', { signal, onEvent: (e) => events.push(e) })
  return { agent, events, result }
}

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

const stages = (calls: CallInfo[], stage: string): CallInfo[] =>
  calls.filter((c) => stageOf(c) === stage)

// ── OFF: nothing changes ─────────────────────────────────────────────────

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

// A run that touches every stage: two steps, a tool call, the replanner, the synthesizer - once
// with native tool calling and structured output, once on the prompted (JSON-salvage) path.
const goldenRun = async (
  mode: 'native' | 'prompted',
  extra: Partial<BrowserAgentConfig> = {},
): Promise<unknown> => {
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
        return { text: planOf([undefined, undefined]) }
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
  const result = await agent.run('Take a note and check it')
  assert.equal(result.trace.length, 2)
  // Without tiers a "[low]" at the head of a step is the model's own text: it stays.
  if (mode === 'prompted') assert.equal(result.plan.steps[0].description, '[low] Note it')
  return wire(model.calls)
}

// The fixture was captured from the code as it was BEFORE tiers existed (run this file with
// UPDATE_GOLDEN=1 to write it again after a deliberate change to a prompt or a schema). An agent
// without tiers must send exactly those calls: the same prompts, schemas, tools and caps.
test('off: an agent without tiers sends exactly the calls it sent before tiers existed', async () => {
  const sent = { native: await goldenRun('native'), prompted: await goldenRun('prompted') }
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, `${JSON.stringify(sent, null, 2)}\n`)
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof sent
  assert.deepEqual(sent.native, golden.native)
  assert.deepEqual(sent.prompted, golden.prompted)
  assert.ok(!JSON.stringify(sent).includes('complexity'), 'no trace of the feature')
})

test('off: escalation without tiers, an empty tiers block and a standard-only block change nothing', async () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { native: unknown; prompted: unknown }
  for (const extra of [
    { escalation: true },
    { escalation: { maxPerStep: 3 } },
    { executorTiers: {} },
  ] satisfies Partial<BrowserAgentConfig>[]) {
    assert.deepEqual(await goldenRun('native', extra), golden.native, JSON.stringify(extra))
    assert.deepEqual(await goldenRun('prompted', extra), golden.prompted, JSON.stringify(extra))
  }
})

test('off: the events and the result carry no tier fields', async () => {
  const model = scriptedModel((info) =>
    stageOf(info) === 'planner' ? { text: planOf([undefined]) } : { text: 'ok' },
  )
  const agent = await createAgent({ model: model.model })
  const events: AgentEvent[] = []
  const result = await agent.run('Do it', { onEvent: (e) => events.push(e) })
  assert.deepEqual(Object.keys(of(events, 'step.start')[0]).sort(), [
    'index',
    'step',
    'total',
    'type',
  ])
  assert.deepEqual(Object.keys(result.trace[0]).sort(), ['blocked', 'step', 'summary', 'toolCalls'])
  assert.equal(agent.models.tiers, undefined)
})

// ── ROUTING ──────────────────────────────────────────────────────────────

test("routing: the planner's complexity sends each step to its tier's model", async () => {
  const r = rig({ text: planOf(['low', 'medium', 'high', undefined]) }, (step) => ({
    text: `did ${step}`,
  }))
  const { agent, events, result } = await runRig(r)
  assert.deepEqual(r.executed, ['s1:lite', 's2:std', 's3:big', 's4:std'])
  assert.deepEqual(
    of(events, 'step.start').map((e) => [e.tier, e.model, e.tierReason]),
    [
      ['light', 'lite', 'planned'],
      ['standard', 'std', 'planned'],
      ['strong', 'big', 'planned'],
      ['standard', 'std', 'default'],
    ],
  )
  assert.deepEqual(
    result.trace.map((t) => [t.step.complexity, t.tier, t.model, t.escalations]),
    [
      ['low', 'light', 'lite', undefined],
      ['medium', 'standard', 'std', undefined],
      ['high', 'strong', 'big', undefined],
      [undefined, 'standard', 'std', undefined],
    ],
  )
  assert.equal(of(events, 'step.escalated').length, 0)
  assert.deepEqual(
    of(events, 'plan.created')[0].plan.steps.map((s) => s.complexity),
    ['low', 'medium', 'high', undefined],
  )
  assert.deepEqual(Object.keys(agent.models.tiers ?? {}).sort(), ['light', 'standard', 'strong'])
  assert.equal(agent.models.tiers?.standard, agent.models.executor)
})

test('routing: the complexity instruction and the enum are in the planner call only with tiers', async () => {
  const r = rig({ text: planOf(['low']) }, () => ({ text: 'ok' }))
  await runRig(r)
  const planner = stages(r.calls.plan, 'planner')[0]
  assert.match(planner.system, /PLANNER/)
  assert.match(planner.system, /set "complexity" on every step/)
  const schema = JSON.stringify(planner.options.responseFormat)
  assert.match(schema, /"complexity":\{[^}]*"enum":\["low","medium","high"\]/)
  assert.ok(!schema.includes('maxItems'))
  assert.ok(!/"required":\[[^\]]*"complexity"/.test(schema), 'the rating is optional')
  for (const c of [...r.calls.lite, ...stages(r.calls.plan, 'synthesizer')]) {
    assert.ok(!c.system.includes('complexity'), stageOf(c))
  }
})

test('routing, prompted path: a tiny model rates a step with a tag at the head of the string', async () => {
  const r = rig(
    {
      text: JSON.stringify({ reply: 'ok', plan: ['[low] Step s1', '[HIGH]: Step s2', 'Step s3'] }),
    },
    (step) => ({ text: `did ${step}` }),
    { toolMode: 'prompted' },
  )
  const { result } = await runRig(r)
  const planner = stages(r.calls.plan, 'planner')[0]
  assert.match(planner.system, /start every "plan" string with its complexity in brackets/)
  assert.ok(
    !JSON.stringify(planner.options.responseFormat ?? {}).includes('complexity'),
    'no schema on this path: the rating travels inside the strings',
  )
  assert.deepEqual(r.attempts(), ['s1:lite', 's2:big', 's3:std'])
  // The tag is the rating, not part of the step.
  assert.deepEqual(
    result.plan.steps.map((s) => [s.description, s.complexity]),
    [
      ['Step s1', 'low'],
      ['Step s2', 'high'],
      ['Step s3', undefined],
    ],
  )
})

test('routing, prompted path: the tag survives a plan cut off mid-JSON', () => {
  // What a looping local model leaves: the envelope never closes. The salvage parser still
  // recovers the finished strings, and each still carries its rating.
  const cut = parsePlannerResponse('{ "reply": "ok", "plan": ["[low] Look it up", "[high] Anal')
  assert.deepEqual(cut.plan, ['[low] Look it up'])
})

test('routing: a revised plan is rated too (its steps are strings in both modes)', async () => {
  let asked = 0
  const r = rig(
    { text: planOf(['low', 'low']) },
    (step) => ({ text: `did ${step}` }),
    { replanAfter: 'always', escalation: false },
    () => {
      asked += 1
      return asked === 1
        ? {
            text: JSON.stringify({
              decision: 'revise',
              reason: 'harder than it looked',
              plan: ['[high] Step r1', 'Step r2'],
            }),
          }
        : { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    },
  )
  const { result } = await runRig(r)
  assert.deepEqual(r.executed, ['s1:lite', 'r1:big', 'r2:std'])
  assert.deepEqual(
    result.trace.map((t) => [t.step.description, t.step.complexity]),
    [
      ['Step s1', 'low'],
      ['Step r1', 'high'],
      ['Step r2', undefined],
    ],
  )
  const replanner = stages(r.calls.plan, 'replanner')[0]
  assert.match(replanner.system, /If you revise, start every "plan" string with its complexity/)
})

// ── FALLBACK ─────────────────────────────────────────────────────────────

test('fallback rule: the nearest configured tier, the stronger of two equally near', () => {
  const set = (...t: ModelTier[]) => new Set<ModelTier>(t)
  const all = set('light', 'standard', 'strong')
  assert.deepEqual(pickTier('low', all), { tier: 'light', reason: 'planned' })
  assert.deepEqual(pickTier('medium', all), { tier: 'standard', reason: 'planned' })
  assert.deepEqual(pickTier('high', all), { tier: 'strong', reason: 'planned' })
  assert.deepEqual(pickTier(undefined, all), { tier: 'standard', reason: 'default' })
  assert.deepEqual(pickTier('low', set('standard', 'strong')), {
    tier: 'standard',
    reason: 'fallback',
  })
  assert.deepEqual(pickTier('high', set('light', 'standard')), {
    tier: 'standard',
    reason: 'fallback',
  })
  assert.deepEqual(pickTier('low', set('strong')), { tier: 'strong', reason: 'fallback' })
  assert.deepEqual(pickTier('high', set('light')), { tier: 'light', reason: 'fallback' })
  assert.deepEqual(pickTier('medium', set('light', 'strong')), {
    tier: 'strong',
    reason: 'fallback',
  })
  assert.throws(() => pickTier('low', set()), /no executor tier/)
  assert.equal(nextStrongerTier('light', all), 'standard')
  assert.equal(nextStrongerTier('standard', all), 'strong')
  assert.equal(nextStrongerTier('strong', all), undefined)
  assert.equal(nextStrongerTier('light', set('light', 'strong')), 'strong')
})

test('fallback: a tier the host did not configure runs on the nearest one, and says so', async () => {
  const onlyStrong = rig({ text: planOf(['low', 'high']) }, (step) => ({ text: `did ${step}` }))
  onlyStrong.config.executorTiers = { strong: onlyStrong.models.big }
  const a = await runRig(onlyStrong)
  assert.deepEqual(onlyStrong.executed, ['s1:std', 's2:big'])
  assert.deepEqual(
    of(a.events, 'step.start').map((e) => [e.tier, e.tierReason]),
    [
      ['standard', 'fallback'],
      ['strong', 'planned'],
    ],
  )
  const onlyLight = rig({ text: planOf(['low', 'high']) }, (step) => ({ text: `did ${step}` }))
  onlyLight.config.executorTiers = { light: onlyLight.models.lite }
  const b = await runRig(onlyLight)
  assert.deepEqual(onlyLight.executed, ['s1:lite', 's2:std'])
  assert.deepEqual(
    of(b.events, 'step.start').map((e) => [e.tier, e.tierReason]),
    [
      ['light', 'planned'],
      ['standard', 'fallback'],
    ],
  )
})

// ── ESCALATION ───────────────────────────────────────────────────────────

test('escalation: a blocked step is retried once on the next stronger tier, before the replanner', async () => {
  const r = rig({ text: planOf(['low', 'low']) }, (step, model) =>
    step === 's1' && model === 'lite'
      ? { text: 'I cannot work this out. [BLOCKER]' }
      : { text: `did ${step} on ${model}` },
  )
  const { events, result } = await runRig(r)
  assert.deepEqual(r.executed, ['s1:lite', 's1:std', 's2:lite'])
  assert.deepEqual(
    of(events, 'step.escalated').map((e) => [e.step.id, e.from, e.to, e.model, e.reason]),
    [['s1', 'light', 'standard', 'std', 'blocked']],
  )
  const order = events
    .filter((e) => e.type.startsWith('step.') && 'step' in e && e.step?.id === 's1')
    .map((e) => e.type)
    .filter((t) => t !== 'step.text-delta')
  assert.deepEqual(order, ['step.start', 'step.escalated', 'step.complete'])
  const first = result.trace[0]
  assert.equal(first.blocked, false)
  assert.equal(first.summary, 'did s1 on std')
  assert.equal(first.tier, 'standard')
  assert.equal(first.model, 'std')
  assert.deepEqual(first.escalations, [{ from: 'light', to: 'standard', reason: 'blocked' }])
  assert.equal(stages(r.calls.plan, 'replanner').length, 0, 'no replanner call was needed')
  // The stronger model is told what happened - in the user prompt; its system prompt is the
  // one every executor call on that model gets.
  assert.match(r.calls.std[0].user, /EARLIER ATTEMPT AT THIS STEP/)
  assert.match(r.calls.std[0].user, /Attempt 1 \(light model\) stopped because it reported/)
  assert.ok(!r.calls.std[0].system.includes('EARLIER ATTEMPT'))
  assert.ok(!r.calls.lite[1].user.includes('EARLIER ATTEMPT'), 'the next step starts clean')
})

test('escalation: capped at one per step by default - a second failure goes to the replanner', async () => {
  const r = rig({ text: planOf(['low', 'low']) }, (step, model) =>
    step === 's1' ? { text: `stuck on ${model} [BLOCKER]` } : { text: 'ok' },
  )
  const { events, result } = await runRig(r)
  assert.deepEqual(r.executed, ['s1:lite', 's1:std', 's2:lite'])
  assert.equal(of(events, 'step.escalated').length, 1)
  assert.equal(result.trace[0].blocked, true)
  assert.equal(result.trace[0].tier, 'standard')
  assert.equal(stages(r.calls.plan, 'replanner').length, 1, 'the replanner comes after escalation')
})

test('escalation: maxPerStep 2 climbs light -> standard -> strong; the strongest tier has nowhere to go', async () => {
  const r = rig({ text: planOf(['low', 'high']) }, () => ({ text: 'stuck [BLOCKER]' }), {
    escalation: { maxPerStep: 2, maxPerRun: 10 },
  })
  const { result } = await runRig(r)
  assert.deepEqual(r.executed, ['s1:lite', 's1:std', 's1:big', 's2:big'])
  assert.deepEqual(result.trace[0].escalations, [
    { from: 'light', to: 'standard', reason: 'blocked' },
    { from: 'standard', to: 'strong', reason: 'blocked' },
  ])
  assert.equal(result.trace[1].escalations, undefined)
})

test('escalation: capped per run (default 3, configurable)', async () => {
  const stuckOnLite: ExecutorScript = (_step, model) =>
    model === 'lite' ? { text: 'stuck [BLOCKER]' } : { text: 'ok' }
  const five = { text: planOf(['low', 'low', 'low', 'low', 'low']) }
  const a = rig(five, stuckOnLite, { replan: false })
  const first = await runRig(a)
  assert.equal(of(first.events, 'step.escalated').length, 3)
  assert.deepEqual(a.executed, [
    's1:lite',
    's1:std',
    's2:lite',
    's2:std',
    's3:lite',
    's3:std',
    's4:lite',
    's5:lite',
  ])
  const b = rig(five, stuckOnLite, { replan: false, escalation: { maxPerRun: 1 } })
  const second = await runRig(b)
  assert.equal(of(second.events, 'step.escalated').length, 1)
})

test('escalation: off with escalation false, and a zero cap is off too', async () => {
  for (const escalation of [false, { maxPerStep: 0 }, { maxPerRun: 0 }] as const) {
    const r = rig(
      { text: planOf(['low', 'low']) },
      (step, model) =>
        step === 's1' && model === 'lite' ? { text: 'stuck [BLOCKER]' } : { text: 'ok' },
      { escalation },
    )
    const { events } = await runRig(r)
    assert.deepEqual(r.executed, ['s1:lite', 's2:lite'], JSON.stringify(escalation))
    assert.equal(of(events, 'step.escalated').length, 0)
    assert.equal(stages(r.calls.plan, 'replanner').length, 1)
  }
  assert.deepEqual(resolveEscalation(undefined, true), {
    enabled: true,
    maxPerStep: 1,
    maxPerRun: 3,
  })
  assert.equal(resolveEscalation(true, false).enabled, false, 'never without tiers')
  assert.equal(resolveEscalation(false, true).enabled, false)
})

const noteTools = (ran: unknown[]) => ({
  note_write: defineTool({
    description: 'Write a note.',
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => {
      ran.push(input)
      return `saved ${input.text}`
    },
  }),
})

test('escalation reasons: no result, output cut by the cap, tool arguments that keep failing, a failed call', async () => {
  const bad: Reply = { toolCalls: [{ name: 'note_write', args: { text: 42 } }] }
  const cases: [string, (info: CallInfo) => Reply][] = [
    ['empty-result', () => ({ text: '' })],
    ['output-cut', () => ({ text: 'half an ans', cutOff: true })],
    ['tool-arguments', (info) => (info.toolResults < 2 ? bad : { text: 'I could not call it.' })],
    [
      'error',
      () => {
        throw new Error('failed to parse the tool call')
      },
    ],
  ]
  for (const [reason, lite] of cases) {
    const r = rig(
      { text: planOf(['low']) },
      (_step, model, info) => (model === 'lite' ? lite(info) : { text: 'fixed' }),
      { tools: noteTools([]) },
    )
    const { events, result } = await runRig(r)
    assert.deepEqual(
      of(events, 'step.escalated').map((e) => e.reason),
      [reason],
      reason,
    )
    assert.equal(result.trace[0].summary, 'fixed', reason)
    assert.equal(result.trace[0].tier, 'standard', reason)
    assert.equal(of(events, 'error').length, 0, `${reason}: the stronger tier handled it`)
  }
})

test('escalation reasons, prompted path: arguments a tiny model keeps getting wrong', async () => {
  const r = rig(
    { text: JSON.stringify({ reply: 'ok', plan: ['[low] Step s1'] }) },
    (_step, model, info) => {
      if (model !== 'lite') return { text: JSON.stringify({ reply: 'fixed', actions: [] }) }
      const round = (info.user.match(/TOOL RESULTS/g) ?? []).length
      return round < 2
        ? {
            text: JSON.stringify({
              reply: '',
              actions: [{ tool: 'note_write', args: { text: 40 + round } }],
            }),
          }
        : { text: JSON.stringify({ reply: 'I could not call it.', actions: [] }) }
    },
    { toolMode: 'prompted', tools: noteTools([]) },
  )
  const { events, result } = await runRig(r)
  assert.deepEqual(
    of(events, 'step.escalated').map((e) => e.reason),
    ['tool-arguments'],
  )
  assert.equal(result.trace[0].summary, 'fixed')
})

test('escalation reasons, as a rule: what is and is not a failure a stronger model could fix', () => {
  const base = { toolCalls: [], blocked: false, empty: false, cut: false, stopped: false }
  assert.equal(escalationReasonOf(base), undefined, 'a clean step')
  assert.equal(escalationReasonOf({ ...base, blocked: true }), 'blocked')
  assert.equal(escalationReasonOf({ ...base, empty: true }), 'empty-result')
  assert.equal(escalationReasonOf({ ...base, cut: true }), 'output-cut')
  const ok = { name: 't', input: {}, output: 'fine', ok: true }
  const bad = (name = 't') => ({
    name,
    input: {},
    output: `invalid args for "${name}": expected string`,
    ok: false,
  })
  const failed = { name: 't', input: {}, output: 'HTTP 500 from the service', ok: false }
  assert.equal(escalationReasonOf({ ...base, empty: true, toolCalls: [ok] }), undefined)
  assert.equal(escalationReasonOf({ ...base, toolCalls: [bad()] }), undefined)
  assert.equal(escalationReasonOf({ ...base, toolCalls: [bad(), bad()] }), 'tool-arguments')
  assert.equal(escalationReasonOf({ ...base, toolCalls: [bad(), bad('u')] }), undefined)
  assert.equal(escalationReasonOf({ ...base, toolCalls: [bad(), bad(), ok] }), undefined)
  assert.equal(escalationReasonOf({ ...base, toolCalls: [failed, failed] }), undefined)
  assert.equal(escalationReasonOf({ ...base, blocked: true, stopped: true }), undefined)
  const denied = {
    name: 't',
    input: {},
    output: 'Tool call denied by the user: no. Do not retry it',
    ok: false,
  }
  assert.equal(escalationReasonOf({ ...base, blocked: true, toolCalls: [denied] }), undefined)
  const budget = {
    name: 't',
    input: {},
    output: 'Tool-call budget exhausted (1 per run). Do not call more tools',
    ok: false,
  }
  assert.equal(escalationReasonOf({ ...base, blocked: true, toolCalls: [budget] }), undefined)

  assert.equal(isEscalatableError(new Error('failed to parse tool call')), true)
  assert.equal(isEscalatableError(Object.assign(new Error('x'), { statusCode: 500 })), true)
  for (const status of [401, 403, 429]) {
    assert.equal(isEscalatableError(Object.assign(new Error('x'), { statusCode: status })), false)
    assert.equal(
      isEscalatableError(
        Object.assign(new Error('retries'), { lastError: { statusCode: status } }),
      ),
      false,
      `${status} down the chain`,
    )
  }
  assert.equal(isEscalatableError(new DOMException('Aborted', 'AbortError')), false)
  assert.equal(isEscalatableError(new DOMException('Timed out', 'TimeoutError')), false)
})

// ── NO ESCALATION ────────────────────────────────────────────────────────

test('no escalation: refused credentials (401 / 403) and a rate limit (429) are handled as they always were', async () => {
  for (const status of [401, 403, 429]) {
    const r = rig(
      { text: planOf(['low', 'low']) },
      (step, model) => {
        if (step === 's1' && model === 'lite') {
          throw Object.assign(new Error(`scripted ${status}`), { statusCode: status })
        }
        return { text: 'ok' }
      },
      { escalation: { maxPerStep: 2 } },
    )
    const { events, result } = await runRig(r)
    assert.deepEqual(r.calls.std.length + r.calls.big.length, 0, `${status}: no stronger model`)
    assert.equal(of(events, 'step.escalated').length, 0)
    // What a failed step has always been here: a blocked step, reported, for the replanner.
    assert.equal(result.trace[0].blocked, true)
    assert.equal(result.trace[0].tier, 'light')
    assert.deepEqual(
      of(events, 'error').map((e) => [e.phase, e.error]),
      [['execute', `scripted ${status}`]],
    )
  }
})

test('no escalation: a stop is a stop', async () => {
  const stop = new AbortController()
  const r = rig({ text: planOf(['low']) }, (_step, model) => {
    if (model === 'lite') {
      stop.abort()
      return { text: 'stuck [BLOCKER]' }
    }
    return { text: 'ok' }
  })
  const { events, result } = await runRig(r, stop.signal)
  assert.equal(result.stopped, true)
  assert.equal(r.calls.std.length, 0)
  assert.equal(of(events, 'step.escalated').length, 0)
})

test('no escalation: a spent budget (tokens, tool calls)', async () => {
  const tokens = rig(
    { text: planOf(['low', 'low']) },
    (_step, model) =>
      model === 'lite'
        ? { text: 'stuck [BLOCKER]', usage: { input: 900, output: 200 } }
        : { text: 'ok' },
    { limits: { maxTotalTokens: 1000 } },
  )
  const a = await runRig(tokens)
  assert.deepEqual(tokens.executed, ['s1:lite'])
  assert.equal(of(a.events, 'step.escalated').length, 0)
  assert.equal(of(a.events, 'budget.exceeded').length, 1)

  const ran: unknown[] = []
  const calls = rig(
    { text: planOf(['low']) },
    (_step, model, info) =>
      model !== 'lite'
        ? { text: 'ok' }
        : info.toolResults < 2
          ? { toolCalls: [{ name: 'note_write', args: { text: `n${info.toolResults}` } }] }
          : { text: 'out of calls [BLOCKER]' },
    { maxToolCalls: 1, tools: noteTools(ran) },
  )
  const b = await runRig(calls)
  assert.equal(calls.calls.std.length, 0)
  assert.equal(of(b.events, 'step.escalated').length, 0)
  assert.equal(ran.length, 1)
})

test('no escalation: a tool the user denied', async () => {
  const ran: unknown[] = []
  const r = rig(
    { text: planOf(['low', 'low']) },
    (step, model, info) =>
      step !== 's1' || model !== 'lite'
        ? { text: 'ok' }
        : info.toolResults > 0
          ? { text: 'The user refused the write. [BLOCKER]' }
          : { toolCalls: [{ name: 'note_write', args: { text: 'x' } }] },
    {
      tools: noteTools(ran),
      toolApproval: { mode: 'ask-all', onRequest: () => ({ approved: false, reason: 'no' }) },
    },
  )
  const { events, result } = await runRig(r)
  assert.equal(ran.length, 0)
  assert.equal(r.calls.std.length, 0)
  assert.equal(of(events, 'step.escalated').length, 0)
  assert.equal(result.trace[0].blocked, true)
  assert.equal(stages(r.calls.plan, 'replanner').length, 1, 'the replanner still hears of it')
})

// ── SIDE EFFECTS ─────────────────────────────────────────────────────────

const withRead = (writes: unknown[], reads: { n: number }) => ({
  ...noteTools(writes),
  note_read: defineTool({
    description: 'Read the notes.',
    inputSchema: z.object({}),
    readOnly: true,
    execute: async () => {
      reads.n += 1
      return `notes v${reads.n}`
    },
  }),
})

test('side effects: the escalated attempt sees what was done, and a write is not executed twice', async () => {
  const writes: unknown[] = []
  const reads = { n: 0 }
  const write = (text: string): Reply => ({ toolCalls: [{ name: 'note_write', args: { text } }] })
  const read: Reply = { toolCalls: [{ name: 'note_read', args: {} }] }
  const r = rig(
    { text: planOf(['low']) },
    (_step, model, info) => {
      const n = info.toolResults
      if (model === 'lite') {
        // Reads, writes "a" (it goes through), then gives up.
        return n === 0
          ? read
          : n === 1
            ? write('a')
            : { text: 'I wrote a but cannot go on. [BLOCKER]' }
      }
      // The stronger model starts over all the same: the read, the SAME write, a new one.
      return n === 0
        ? read
        : n === 1
          ? write('a')
          : n === 2
            ? write('b')
            : { text: 'wrote a and b' }
    },
    { tools: withRead(writes, reads) },
  )
  const { result } = await runRig(r)
  assert.deepEqual(writes, [{ text: 'a' }, { text: 'b' }], 'the write of "a" ran exactly once')
  assert.equal(reads.n, 2, 'a read-only tool is simply run again')

  // It was told, with arguments and results, before it made a single call.
  assert.match(r.calls.std[0].user, /note_write \{"text":"a"\} -> ok: saved a/)
  assert.match(r.calls.std[0].user, /note_read \{\} -> ok: notes v1/)
  assert.match(r.calls.std[0].user, /do not make it again/)
  assert.match(r.calls.std[0].user, /It said: I wrote a but cannot go on\./)

  const step = result.trace[0]
  assert.deepEqual(
    step.toolCalls.map((c) => [c.name, c.ok]),
    [
      ['note_read', true],
      ['note_write', true],
      ['note_read', true],
      ['note_write', true],
      ['note_write', true],
    ],
  )
  // When it repeated the write anyway it got the earlier result back, marked as such...
  assert.match(String(step.toolCalls[3].output), /not run again: this exact call already succeeded/)
  assert.match(String(step.toolCalls[3].output), /saved a/)
  // ...and that is not counted as a call that went through.
  assert.equal(result.applied, 4)
  assert.equal(step.summary, 'wrote a and b')
})

test('side effects, mixed modes: a prompted light model hands over to a native standard one', async () => {
  const writes: unknown[] = []
  const r = rig(
    { text: planOf(['low']) },
    (_step, model, info) => {
      if (model === 'lite') {
        return info.user.includes('TOOL RESULTS')
          ? { text: JSON.stringify({ reply: 'wrote a, lost after that [BLOCKER]', actions: [] }) }
          : {
              text: JSON.stringify({
                reply: '',
                actions: [{ tool: 'note_write', args: { text: 'a' } }],
              }),
            }
      }
      return info.toolResults === 0
        ? { toolCalls: [{ name: 'note_write', args: { text: 'a' } }] }
        : { text: 'done' }
    },
    { tools: noteTools(writes) },
  )
  // A local model: the agent talks to it in the prompted mode, tier by tier.
  Object.defineProperty(r.models.lite, 'provider', { value: 'web-llm' })
  const { result } = await runRig(r)
  assert.deepEqual(writes, [{ text: 'a' }], 'once, across the two tool-calling modes')
  assert.deepEqual(r.calls.lite[0].tools, [], 'the light model got its tools in the prompt')
  assert.match(r.calls.lite[0].user, /TOOLS:\n- note_write/)
  assert.deepEqual(r.calls.std[0].tools, ['note_write'], 'the standard one natively')
  assert.match(r.calls.std[0].user, /note_write \{"text":"a"\} -> ok: saved a/)
  assert.equal(result.trace[0].summary, 'done')
})

test('side effects: a failed write is run again, and within one attempt nothing is held back', async () => {
  const tried: string[] = []
  let failNext = true
  const call: Reply = { toolCalls: [{ name: 'flaky_write', args: { text: 'a' } }] }
  const r = rig(
    { text: planOf(['low']) },
    (_step, model, info) => {
      if (model === 'lite') {
        return info.toolResults === 0 ? call : { text: 'the write failed [BLOCKER]' }
      }
      // Twice with the same arguments inside ONE attempt: both run, as they always would.
      return info.toolResults < 2 ? call : { text: 'written' }
    },
    {
      tools: {
        flaky_write: defineTool({
          description: 'Write, failing the first time.',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => {
            tried.push(text)
            if (failNext) {
              failNext = false
              throw new Error('disk busy')
            }
            return `saved ${text}`
          },
        }),
      },
    },
  )
  const { events } = await runRig(r)
  assert.equal(tried.length, 3, 'the failed call and both calls of the second attempt ran')
  assert.equal(of(events, 'step.escalated').length, 1)
})

test('side effects: an attempt that THREW after a write still hands that write over', async () => {
  const writes: unknown[] = []
  const call: Reply = { toolCalls: [{ name: 'note_write', args: { text: 'a' } }] }
  const r = rig(
    { text: planOf(['low']) },
    (_step, model, info) => {
      if (model === 'lite') {
        if (info.toolResults === 0) return call
        throw new Error('model crashed')
      }
      return info.toolResults === 0 ? call : { text: 'done' }
    },
    { tools: noteTools(writes) },
  )
  const { events, result } = await runRig(r)
  assert.deepEqual(writes, [{ text: 'a' }], 'once')
  assert.deepEqual(
    of(events, 'step.escalated').map((e) => e.reason),
    ['error'],
  )
  assert.match(r.calls.std[0].user, /note_write \{"text":"a"\} -> ok: saved a/)
  assert.match(r.calls.std[0].user, /stopped because its model call failed/)
  assert.equal(result.trace[0].toolCalls.length, 2)
})

// ── USAGE ────────────────────────────────────────────────────────────────

test('usage: the calls of every tier count, a failed attempt included', async () => {
  const USE: Record<string, { input: number; output: number }> = {
    lite: { input: 100, output: 10 },
    std: { input: 1000, output: 100 },
    big: { input: 10000, output: 1000 },
  }
  const r = rig({ text: planOf(['low', 'high']) }, (step, model) => ({
    text: step === 's1' && model === 'lite' ? 'stuck [BLOCKER]' : 'ok',
    usage: USE[model],
  }))
  const { agent, events, result } = await runRig(r)
  assert.deepEqual(r.executed, ['s1:lite', 's1:std', 's2:big'])
  assert.deepEqual(
    of(events, 'usage')
      .filter((e) => e.phase === 'execute')
      .map((e) => e.usage.totalTokens),
    [110, 1100, 11000],
  )
  // planner 15 + the three executor calls + synthesizer 15
  assert.equal(result.usage.totalTokens, 15 + 110 + 1100 + 11000 + 15)
  assert.equal(agent.usage.totalTokens, result.usage.totalTokens)
  assert.equal(agent.sessionUsage().totalTokens, result.usage.totalTokens)
})

test('usage: a run-level limit counts every tier, and stops the run when a strong call crosses it', async () => {
  const r = rig(
    { text: planOf(['high', 'low', 'low']) },
    (_step, model) => ({
      text: 'ok',
      usage: model === 'big' ? { input: 5000, output: 100 } : { input: 10, output: 5 },
    }),
    { limits: { maxTotalTokens: 4000 } },
  )
  const { events, result } = await runRig(r)
  assert.deepEqual(r.executed, ['s1:big'])
  assert.equal(of(events, 'budget.exceeded')[0]?.kind, 'total')
  assert.equal(result.budgetExceeded?.kind, 'total')
})

// ── WINDOW ───────────────────────────────────────────────────────────────

/** Make a scripted model look like a loaded WebLLM model with this window. */
const asLocal = (model: object, id: string, window: number): void => {
  Object.defineProperty(model, 'provider', { value: 'web-llm' })
  Object.defineProperty(model, 'modelId', { value: id })
  Object.assign(model, {
    engine: { loadedModelIdToPipeline: new Map([[id, { contextWindowSize: window }]]) },
  })
}

test('window: the smallest tier window governs the run, and each tier writes within its own', async () => {
  const r = rig({ text: planOf(['low', 'medium']) }, (_step, model) =>
    model === 'lite'
      ? { text: JSON.stringify({ reply: 'did it', actions: [] }) }
      : { text: 'did it' },
  )
  asLocal(r.models.lite, 'lite', 4096)
  r.config.compaction = { contextWindowTokens: 128_000 }
  const { agent } = await runRig(r)
  // Compaction, tool search and every prompt are sized for the 4k model: any step may land on it.
  assert.equal(agent.contextWindowTokens, 4096)
  // What a call may WRITE follows the model that writes it: 384 is the executor's share of a
  // 4k window, 1200 its share of the 128k the host stated for the cloud models.
  assert.equal(r.calls.lite[0].options.maxOutputTokens, 384)
  assert.equal(r.calls.std[0].options.maxOutputTokens, 1200)
})

test('window: a small window on the STRONG tier governs just the same', async () => {
  const r = rig({ text: planOf(['medium']) }, () => ({ text: 'did it' }))
  asLocal(r.models.big, 'big', 4096)
  r.config.compaction = { contextWindowTokens: 128_000 }
  const { agent } = await runRig(r)
  assert.equal(agent.contextWindowTokens, 4096, 'a step may be escalated onto it')
  // No tier configured -> the same models leave the window where the host put it.
  const plain = await createAgent({
    model: r.models.std,
    compaction: { contextWindowTokens: 128_000 },
  })
  assert.equal(plain.contextWindowTokens, 128_000)
})

// ── RESUME ───────────────────────────────────────────────────────────────

test('resume: the checkpoint keeps each step rating and tier, and the escalation count', async () => {
  const store = new MemoryRunStore()
  const stop = new AbortController()
  let last: RunSnapshot | undefined
  // A store behaving like a real one after a crash: it holds the last checkpoint and nothing
  // else, because a dead tab never writes onRunComplete.
  const persistence: RunPersistence = {
    onRunStart: (s) => store.onRunStart(s),
    onStepComplete: async (s) => {
      await store.onStepComplete(s)
      last = structuredClone(s)
      stop.abort()
    },
    loadRun: (id) => store.loadRun(id),
  }
  const script: ExecutorScript = (step, model) =>
    model === 'lite' ? { text: `stuck on ${step} [BLOCKER]` } : { text: `did ${step} on ${model}` }
  const extra = { persistence, replan: false, escalation: { maxPerRun: 1 } }
  const a = rig({ text: planOf(['low', 'high', 'low']) }, script, extra)
  const first = await runRig(a, stop.signal)
  assert.equal(first.result.stopped, true)
  assert.ok(last)
  assert.deepEqual(
    last.remaining.map((s) => [s.id, s.complexity]),
    [
      ['s2', 'high'],
      ['s3', 'low'],
    ],
  )
  assert.equal(last.trace[0].tier, 'standard')
  assert.equal(last.trace[0].model, 'std')
  assert.deepEqual(last.trace[0].escalations, [
    { from: 'light', to: 'standard', reason: 'blocked' },
  ])
  assert.equal(last.escalations, 1)

  const b = rig({ text: planOf(['low']) }, script, {
    ...extra,
    persistence: { loadRun: (id) => store.loadRun(id) },
  })
  const agent = await createAgent(b.config)
  const events: AgentEvent[] = []
  const result = await agent.run('ignored', {
    resumeFromRunId: first.result.runId,
    onEvent: (e) => events.push(e),
  })
  // The planner does not run again; the high step still goes to the strong model, the low one
  // to the light model - and the run's ONE escalation was already spent before the crash.
  assert.equal(stages(b.calls.plan, 'planner').length, 0)
  assert.deepEqual(b.executed, ['s2:big', 's3:lite'])
  assert.deepEqual(
    of(events, 'step.start').map((e) => [e.step.id, e.tier, e.tierReason]),
    [
      ['s2', 'strong', 'planned'],
      ['s3', 'light', 'planned'],
    ],
  )
  assert.equal(of(events, 'step.escalated').length, 0, 'the per-run cap survives the resume')
  assert.deepEqual(
    result.trace.map((t) => t.tier),
    ['standard', 'strong', 'light'],
  )
})

// ── SCHEMA, PIPELINE ─────────────────────────────────────────────────────

test('schema: the tiered plan accepts a rated and an unrated step, and refuses an unknown rating', () => {
  const plan = (s: object) => ({ thought: 't', steps: [s] })
  assert.equal(TieredPlanSchema.safeParse(plan({ description: 'd' })).success, true)
  const rated = TieredPlanSchema.safeParse(plan({ description: 'd', complexity: 'high' }))
  assert.equal(rated.success, true)
  assert.equal(
    TieredPlanSchema.safeParse(plan({ description: 'd', complexity: 'extreme' })).success,
    false,
  )
})

test('pipeline: a node keeps the base tiers, unless it names another model', async () => {
  const r = rig({ text: planOf(['low']) }, () => ({ text: 'ok' }), { escalation: false })
  const resolve = nodeResolver({ base: r.config, models: { other: r.models.big } })
  const node = (model?: string) => ({ id: 'n', ...(model ? { model } : {}) }) as never
  const same = (await resolve(node())) as BrowserAgentConfig
  assert.equal(same.executorTiers, r.config.executorTiers)
  assert.equal(same.escalation, false)
  // The base's tiers were written for the base model, like its planner / synthesizer.
  const other = (await resolve(node('other'))) as BrowserAgentConfig
  assert.equal(other.model, r.models.big)
  assert.equal(other.executorTiers, undefined)
})
