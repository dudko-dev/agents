import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tool } from 'ai'
import { z } from 'zod'
import { createAgent, markReadOnly, type IAgent } from '../src/index.ts'
import { parseExecutorTiers } from '../src/cli/config.ts'
import { nodeResolver } from '../src/pipeline.ts'
import { TieredPlanSchema } from '../src/planner.ts'
import {
  escalationReasonOf,
  isEscalatableError,
  nextStrongerTier,
  pickTier,
  resolveEscalation,
} from '../src/tiers.ts'
import type {
  AgentEvent,
  IAgentConfig,
  IAgentRunResult,
  IRunSnapshot,
  ModelTier,
} from '../src/types.ts'
import {
  hasToolResult,
  startLocalOpenAI,
  systemOf,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type IScriptedReply,
  type Script,
} from './helpers/openai-server.ts'

// Model tiers (config.executorTiers) and escalation (config.escalation), over real sockets against
// the scripted OpenAI-compatible endpoint. The model id on the wire is how a test tells which tier
// ran a call: 'lite' / 'std' / 'big' for the executor tiers, 'plan' for the planner + replanner.

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer' | 'other'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  if (system.includes('You are the Executor')) return 'executor'
  return 'other'
}

type Complexity = 'low' | 'medium' | 'high' | undefined
const planOf = (complexities: Complexity[]): string =>
  JSON.stringify({
    thought: 'Plan.',
    steps: complexities.map((complexity, i) => ({
      id: `s${i + 1}`,
      description: `Step s${i + 1}`,
      expectedOutcome: `s${i + 1} done`,
      suggestedTools: [],
      ...(complexity ? { complexity } : {}),
    })),
  })

// Which plan step an executor request is for.
const stepOf = (req: IChatRequest): string =>
  /CURRENT STEP to execute \(id=(\w+)\)/.exec(userOf(req))?.[1] ?? '?'

const TIERS: IAgentConfig['executorTiers'] = { light: { model: 'lite' }, strong: { model: 'big' } }

const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'model-tiers',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'std',
  planner: { model: 'plan' },
  synthesizer: { model: 'plan' },
  mcpServers: {},
  maxIterations: 6,
  maxStepsPerTask: 4,
  llmMaxRetries: 0,
  logLevel: 'none',
  ...extra,
})

interface IHarness {
  llm: ILocalOpenAI
  agent: IAgent
  events: AgentEvent[]
  run: (signal?: AbortSignal) => Promise<IAgentRunResult>
}

const withRun = async (
  script: Script,
  extra: Partial<IAgentConfig>,
  body: (h: IHarness) => Promise<void>,
): Promise<void> => {
  const llm = await startLocalOpenAI(script)
  let agent: IAgent | undefined
  try {
    agent = await createAgent(config(llm.baseURL, extra))
    const events: AgentEvent[] = []
    const a = agent
    await body({
      llm,
      agent: a,
      events,
      run: (signal) => a.run({ input: 'Do the work', signal, onEvent: (e) => events.push(e) }),
    })
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
  }
}

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

const executorModels = (llm: ILocalOpenAI): string[] =>
  llm.requests.filter((r) => stageOf(r) === 'executor').map((r) => `${stepOf(r)}:${r.model}`)

const count = (llm: ILocalOpenAI, stage: Stage): number =>
  llm.requests.filter((r) => stageOf(r) === stage).length

// A script whose executor answers are decided per (step, model, has a tool result yet).
const scripted =
  (
    complexities: Complexity[],
    executor: (step: string, model: string, req: IChatRequest) => IScriptedReply,
  ): Script =>
  (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planOf(complexities) }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'on track' }) }
      case 'executor':
        return executor(stepOf(req), req.model ?? '', req)
      default:
        return { text: 'All done.' }
    }
  }

// ── OFF: nothing changes ─────────────────────────────────────────────────

const GOLDEN = new URL('./fixtures/requests-without-tiers.json', import.meta.url)

// A run that touches every stage: two steps, a tool call, the replanner, the synthesizer.
const goldenRun = async (extra: Partial<IAgentConfig>): Promise<IChatRequest[]> => {
  let requests: IChatRequest[] = []
  await withRun(
    (req) => {
      switch (stageOf(req)) {
        case 'planner':
          return { text: planOf([undefined, undefined]) }
        case 'replanner':
          return { text: JSON.stringify({ mode: 'continue', reason: 'on track' }) }
        case 'executor':
          return stepOf(req) === 's1' && !hasToolResult(req)
            ? { toolCalls: [{ name: 'note_write', args: { text: 'hello' } }] }
            : { text: `finished ${stepOf(req)}` }
        default:
          return { text: 'All done.' }
      }
    },
    {
      replanAfter: 'always',
      // So that the plan and decision SCHEMAS are on the wire too, and compared.
      providerOptions: { supportsStructuredOutputs: true },
      tools: {
        note_write: tool({
          description: 'Write a note.',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => `saved ${text}`,
        }),
      },
      ...extra,
    },
    async (h) => {
      await h.run()
      requests = h.llm.requests
    },
  )
  return requests
}

// The fixture was captured from the code as it was BEFORE tiers existed (run this file with
// UPDATE_GOLDEN=1 to write it again after a deliberate change to a prompt or a schema). An agent
// without tiers must send exactly those requests: the same prompts, schemas, tools and caps.
test('off: an agent without tiers sends exactly the requests it sent before tiers existed', async () => {
  const requests = await goldenRun({})
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, `${JSON.stringify(requests, null, 2)}\n`)
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as IChatRequest[]
  assert.equal(requests.length, golden.length)
  requests.forEach((r, i) => assert.deepEqual(r, golden[i], `request ${i + 1} (${stageOf(r)})`))
  assert.ok(!JSON.stringify(requests).includes('complexity'), 'no trace of the feature')
})

test('off: escalation without tiers, an empty tiers block and a standard-only block change nothing', async () => {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as IChatRequest[]
  for (const extra of [
    { escalation: true },
    { escalation: { maxPerStep: 3 } },
    { executorTiers: {} },
    { executorTiers: { standard: { model: 'std' } } },
  ] satisfies Partial<IAgentConfig>[]) {
    assert.deepEqual(await goldenRun(extra), golden, JSON.stringify(extra))
  }
})

test('off: the events and the result carry no tier fields', async () => {
  await withRun(
    scripted([undefined], () => ({ text: 'ok' })),
    {},
    async (h) => {
      const result = await h.run()
      const start = of(h.events, 'step.start')[0]
      assert.deepEqual(Object.keys(start).sort(), ['index', 'runId', 'step', 'type'])
      assert.deepEqual(Object.keys(result.trace[0]).sort(), [
        'blocked',
        'durationMs',
        'step',
        'summary',
        'toolCalls',
      ])
    },
  )
})

// ── ROUTING ──────────────────────────────────────────────────────────────

test("routing: the planner's complexity sends each step to its tier's model", async () => {
  await withRun(
    scripted(['low', 'medium', 'high', undefined], (step) => ({ text: `did ${step}` })),
    { executorTiers: TIERS },
    async (h) => {
      const result = await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:lite', 's2:std', 's3:big', 's4:std'])
      assert.deepEqual(
        of(h.events, 'step.start').map((e) => [e.tier, e.model, e.tierReason]),
        [
          ['light', 'lite', 'planned'],
          ['standard', 'std', 'planned'],
          ['strong', 'big', 'planned'],
          ['standard', 'std', 'default'],
        ],
      )
      assert.deepEqual(
        result.trace.map((r) => [r.step.complexity, r.tier, r.model, r.escalations]),
        [
          ['low', 'light', 'lite', undefined],
          ['medium', 'standard', 'std', undefined],
          ['high', 'strong', 'big', undefined],
          [undefined, 'standard', 'std', undefined],
        ],
      )
      assert.equal(of(h.events, 'step.escalated').length, 0)
      // The plan the host sees carries the rating.
      assert.deepEqual(
        of(h.events, 'plan.created')[0].plan.steps.map((s) => s.complexity),
        ['low', 'medium', 'high', undefined],
      )
    },
  )
})

test('routing: the complexity instruction and the enum are in the planner call only with tiers', async () => {
  await withRun(
    scripted(['low'], () => ({ text: 'ok' })),
    { executorTiers: TIERS, providerOptions: { supportsStructuredOutputs: true } },
    async (h) => {
      await h.run()
      const planner = h.llm.requests.find((r) => stageOf(r) === 'planner')!
      assert.match(systemOf(planner), /You are the Planner/)
      assert.match(systemOf(planner), /STEP COMPLEXITY:/)
      const schema = JSON.stringify(planner.response_format)
      assert.match(schema, /"complexity":\{[^}]*"enum":\["low","medium","high"\]/)
      assert.ok(!schema.includes('maxItems'))
      // The other stages' system prompts do not move.
      for (const r of h.llm.requests.filter((x) => stageOf(x) !== 'planner')) {
        assert.ok(!systemOf(r).includes('STEP COMPLEXITY'), stageOf(r))
      }
      // A step's rating is optional in the schema: a plan without it is still a plan.
      const required = JSON.stringify(
        (planner.response_format?.json_schema?.schema as { properties: { steps: unknown } })
          .properties.steps,
      )
      assert.ok(!/"required":\[[^\]]*"complexity"/.test(required))
    },
  )
})

test('routing: a revised plan is rated too, and the replanner is told to (tiers only)', async () => {
  let executed = 0
  await withRun(
    (req) => {
      switch (stageOf(req)) {
        case 'planner':
          return { text: planOf(['low', 'low']) }
        case 'replanner':
          return {
            text: JSON.stringify({
              mode: 'revise',
              reason: 'harder than it looked',
              newPlan: {
                thought: 'again',
                steps: [
                  {
                    id: 'r1',
                    description: 'Step r1',
                    expectedOutcome: 'done',
                    suggestedTools: [],
                    complexity: 'high',
                  },
                ],
              },
            }),
          }
        case 'executor':
          executed += 1
          return { text: `did ${executed}` }
        default:
          return { text: 'All done.' }
      }
    },
    {
      executorTiers: TIERS,
      replanAfter: 'always',
      escalation: false,
      providerOptions: { supportsStructuredOutputs: true },
    },
    async (h) => {
      await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:lite', 'r1:big'])
      const replanner = h.llm.requests.find((r) => stageOf(r) === 'replanner')!
      assert.match(systemOf(replanner), /STEP COMPLEXITY:/)
      assert.match(JSON.stringify(replanner.response_format), /"complexity"/)
    },
  )
})

// ── FALLBACK ─────────────────────────────────────────────────────────────

test('fallback rule: the nearest configured tier, the stronger of two equally near', () => {
  const set = (...t: ModelTier[]) => new Set<ModelTier>(t)
  const all = set('light', 'standard', 'strong')
  assert.deepEqual(pickTier('low', all), { tier: 'light', reason: 'planned' })
  assert.deepEqual(pickTier('medium', all), { tier: 'standard', reason: 'planned' })
  assert.deepEqual(pickTier('high', all), { tier: 'strong', reason: 'planned' })
  assert.deepEqual(pickTier(undefined, all), { tier: 'standard', reason: 'default' })
  // A missing light or strong means standard, never the far end.
  assert.deepEqual(pickTier('low', set('standard', 'strong')), {
    tier: 'standard',
    reason: 'fallback',
  })
  assert.deepEqual(pickTier('high', set('light', 'standard')), {
    tier: 'standard',
    reason: 'fallback',
  })
  // The general rule, should `standard` ever be missing: nearest first...
  assert.deepEqual(pickTier('low', set('strong')), { tier: 'strong', reason: 'fallback' })
  assert.deepEqual(pickTier('high', set('light')), { tier: 'light', reason: 'fallback' })
  // ...and of two equally near, the stronger.
  assert.deepEqual(pickTier('medium', set('light', 'strong')), {
    tier: 'strong',
    reason: 'fallback',
  })
  assert.deepEqual(pickTier(undefined, set('light', 'strong')), {
    tier: 'strong',
    reason: 'fallback',
  })
  assert.throws(() => pickTier('low', set()), /no executor tier/)

  assert.equal(nextStrongerTier('light', all), 'standard')
  assert.equal(nextStrongerTier('standard', all), 'strong')
  assert.equal(nextStrongerTier('strong', all), undefined)
  assert.equal(nextStrongerTier('light', set('light', 'strong')), 'strong')
  assert.equal(nextStrongerTier('standard', set('light', 'standard')), undefined)
})

test('fallback: a tier the host did not configure runs on the nearest one, and says so', async () => {
  await withRun(
    scripted(['low', 'high'], (step) => ({ text: `did ${step}` })),
    { executorTiers: { strong: { model: 'big' } } },
    async (h) => {
      await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:std', 's2:big'])
      assert.deepEqual(
        of(h.events, 'step.start').map((e) => [e.tier, e.tierReason]),
        [
          ['standard', 'fallback'],
          ['strong', 'planned'],
        ],
      )
    },
  )
  await withRun(
    scripted(['low', 'high'], (step) => ({ text: `did ${step}` })),
    { executorTiers: { light: { model: 'lite' } } },
    async (h) => {
      await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:lite', 's2:std'])
      assert.deepEqual(
        of(h.events, 'step.start').map((e) => [e.tier, e.tierReason]),
        [
          ['light', 'planned'],
          ['standard', 'fallback'],
        ],
      )
    },
  )
})

test('tiers: executorTiers.standard replaces the standard model; a cross-provider tier needs its own key', async () => {
  await withRun(
    scripted(['medium', 'low'], (step) => ({ text: `did ${step}` })),
    { executorTiers: { standard: { model: 'std2' }, light: { model: 'lite' } } },
    async (h) => {
      await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:std2', 's2:lite'])
    },
  )
  await assert.rejects(
    () =>
      createAgent(
        config('http://127.0.0.1:1/v1', { executorTiers: { strong: { providerType: 'openai' } } }),
      ),
    /executorTiers\.strong: providerType "openai" differs .* executorTiers\.strong\.apiKey/,
  )
})

// ── ESCALATION ───────────────────────────────────────────────────────────

test('escalation: a blocked step is retried once on the next stronger tier, before the replanner', async () => {
  await withRun(
    scripted(['low', 'low'], (step, model) =>
      step === 's1' && model === 'lite'
        ? { text: 'I cannot work this out.\n[BLOCKER]' }
        : { text: `did ${step} on ${model}` },
    ),
    { executorTiers: TIERS },
    async (h) => {
      const result = await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:lite', 's1:std', 's2:lite'])
      assert.deepEqual(
        of(h.events, 'step.escalated').map((e) => [e.step.id, e.from, e.to, e.model, e.reason]),
        [['s1', 'light', 'standard', 'std', 'blocked']],
      )
      // The order a UI sees: the step starts on light, is escalated, completes on standard.
      const order = h.events
        .filter((e) => e.type.startsWith('step.') && 'step' in e && e.step?.id === 's1')
        .map((e) => e.type)
        .filter((t) => t !== 'step.text-delta')
      assert.deepEqual(order, ['step.start', 'step.escalated', 'step.complete'])
      assert.equal(of(h.events, 'step.start')[0].tier, 'light')
      const first = result.trace[0]
      assert.equal(first.blocked, false)
      assert.equal(first.summary, 'did s1 on std')
      assert.equal(first.tier, 'standard')
      assert.equal(first.model, 'std')
      assert.deepEqual(first.escalations, [{ from: 'light', to: 'standard', reason: 'blocked' }])
      assert.equal(count(h.llm, 'replanner'), 0, 'the stronger tier fixed it: no replanner call')
      // The stronger model is told what happened, in the USER prompt (the system prompt is stable).
      const retry = h.llm.requests.filter((r) => stageOf(r) === 'executor')[1]
      assert.match(userOf(retry), /EARLIER ATTEMPT AT THIS STEP/)
      assert.match(userOf(retry), /Attempt 1 \(light model\) stopped because it reported/)
      assert.equal(
        systemOf(retry),
        systemOf(h.llm.requests.filter((r) => stageOf(r) === 'executor')[0]),
      )
    },
  )
})

test('escalation: capped at one per step by default - a second failure goes to the replanner', async () => {
  await withRun(
    scripted(['low', 'low'], (step, model) =>
      step === 's1' ? { text: `stuck on ${model}\n[BLOCKER]` } : { text: 'ok' },
    ),
    { executorTiers: TIERS },
    async (h) => {
      const result = await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:lite', 's1:std', 's2:lite'])
      assert.equal(of(h.events, 'step.escalated').length, 1)
      assert.equal(result.trace[0].blocked, true)
      assert.equal(result.trace[0].tier, 'standard')
      assert.equal(count(h.llm, 'replanner'), 1, 'the replanner is consulted after escalation')
    },
  )
})

test('escalation: maxPerStep 2 climbs light -> standard -> strong; the strongest tier has nowhere to go', async () => {
  await withRun(
    scripted(['low', 'high'], (_step, model) =>
      model === 'big' ? { text: 'still stuck\n[BLOCKER]' } : { text: 'stuck\n[BLOCKER]' },
    ),
    { executorTiers: TIERS, escalation: { maxPerStep: 2, maxPerRun: 10 } },
    async (h) => {
      const result = await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:lite', 's1:std', 's1:big', 's2:big'])
      assert.deepEqual(result.trace[0].escalations, [
        { from: 'light', to: 'standard', reason: 'blocked' },
        { from: 'standard', to: 'strong', reason: 'blocked' },
      ])
      assert.equal(result.trace[1].escalations, undefined)
    },
  )
})

test('escalation: capped per run (default 3, configurable)', async () => {
  const stuckOnLite = scripted(['low', 'low', 'low', 'low', 'low'], (_step, model) =>
    model === 'lite' ? { text: 'stuck\n[BLOCKER]' } : { text: 'ok' },
  )
  await withRun(stuckOnLite, { executorTiers: TIERS, maxIterations: 8 }, async (h) => {
    await h.run()
    assert.equal(of(h.events, 'step.escalated').length, 3)
    assert.deepEqual(executorModels(h.llm), [
      's1:lite',
      's1:std',
      's2:lite',
      's2:std',
      's3:lite',
      's3:std',
      's4:lite',
      's5:lite',
    ])
  })
  await withRun(
    stuckOnLite,
    { executorTiers: TIERS, maxIterations: 8, escalation: { maxPerRun: 1 } },
    async (h) => {
      await h.run()
      assert.equal(of(h.events, 'step.escalated').length, 1)
    },
  )
})

test('escalation: off with escalation false, and a zero cap is off too', async () => {
  for (const escalation of [false, { maxPerStep: 0 }, { maxPerRun: 0 }] as const) {
    await withRun(
      scripted(['low', 'low'], (step, model) =>
        step === 's1' && model === 'lite' ? { text: 'stuck\n[BLOCKER]' } : { text: 'ok' },
      ),
      { executorTiers: TIERS, escalation },
      async (h) => {
        await h.run()
        assert.deepEqual(executorModels(h.llm), ['s1:lite', 's2:lite'], JSON.stringify(escalation))
        assert.equal(of(h.events, 'step.escalated').length, 0)
        assert.equal(count(h.llm, 'replanner'), 1)
      },
    )
  }
  assert.deepEqual(resolveEscalation(undefined, true), {
    enabled: true,
    maxPerStep: 1,
    maxPerRun: 3,
  })
  assert.equal(resolveEscalation(true, false).enabled, false, 'never without tiers')
  assert.equal(resolveEscalation(false, true).enabled, false)
})

const badArgs: IScriptedReply = { toolCalls: [{ name: 'note_write', args: { text: 42 } }] }
const noteTool = (ran: unknown[]) => ({
  note_write: tool({
    description: 'Write a note.',
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => {
      ran.push(input)
      return `saved ${input.text}`
    },
  }),
})

test('escalation reasons: no result, output cut by the cap, tool arguments that keep failing, a failed call', async () => {
  const cases: [string, (req: IChatRequest) => IScriptedReply, Partial<IAgentConfig>][] = [
    ['empty-result', () => ({ text: '' }), {}],
    ['output-cut', () => ({ text: 'half an ans', cutOff: true }), {}],
    [
      'tool-arguments',
      (req) => (toolResults(req).length < 2 ? badArgs : { text: 'I could not call it.' }),
      { tools: noteTool([]) },
    ],
    ['error', () => ({ status: 500, text: 'failed to parse tool call' }), {}],
  ]
  for (const [reason, lite, extra] of cases) {
    await withRun(
      scripted(['low'], (_step, model, req) => (model === 'lite' ? lite(req) : { text: 'fixed' })),
      { executorTiers: TIERS, ...extra },
      async (h) => {
        const result = await h.run()
        assert.deepEqual(
          of(h.events, 'step.escalated').map((e) => e.reason),
          [reason],
          reason,
        )
        assert.equal(result.trace[0].summary, 'fixed', reason)
        assert.equal(result.trace[0].tier, 'standard', reason)
      },
    )
  }
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
    output: Object.assign(new Error('Invalid input for tool t'), {
      name: 'AI_InvalidToolInputError',
    }),
    ok: false,
  })
  const failed = { name: 't', input: {}, output: new Error('HTTP 500 from the service'), ok: false }
  // Tool calls that worked and no closing text is a step that did its work, not an empty one.
  assert.equal(escalationReasonOf({ ...base, empty: true, toolCalls: [ok] }), undefined)
  // "Repeatedly": twice for the same tool, and never a good call after.
  assert.equal(escalationReasonOf({ ...base, toolCalls: [bad()] }), undefined)
  assert.equal(escalationReasonOf({ ...base, toolCalls: [bad(), bad()] }), 'tool-arguments')
  assert.equal(escalationReasonOf({ ...base, toolCalls: [bad(), bad('u')] }), undefined)
  assert.equal(escalationReasonOf({ ...base, toolCalls: [bad(), bad(), ok] }), undefined)
  // The prompted path's own wording (the browser sibling shares this rule).
  const prompted = {
    name: 't',
    input: {},
    output: 'invalid args for "t": expected string',
    ok: false,
  }
  assert.equal(escalationReasonOf({ ...base, toolCalls: [prompted, prompted] }), 'tool-arguments')
  // A tool that failed for its own reasons is the replanner's business, not a bigger model's.
  assert.equal(escalationReasonOf({ ...base, toolCalls: [failed, failed] }), undefined)
  // Never: a budget stopped it, or the user said no.
  assert.equal(escalationReasonOf({ ...base, blocked: true, stopped: true }), undefined)
  const denied = {
    name: 't',
    input: {},
    output: Object.assign(new Error('Tool call denied by the user: no.'), {
      name: 'ToolDeniedError',
    }),
    ok: false,
  }
  assert.equal(escalationReasonOf({ ...base, blocked: true, toolCalls: [denied] }), undefined)
  const budget = {
    name: 't',
    input: {},
    output: 'tool-call budget exhausted (maxToolCalls=1). Do not call more tools',
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

test('no escalation: refused credentials (401 / 403) and a rate limit (429) end the step as they always did', async () => {
  for (const status of [401, 403, 429]) {
    await withRun(
      scripted(['low'], (_step, model) =>
        model === 'lite' ? { status, text: `scripted ${status}` } : { text: 'ok' },
      ),
      { executorTiers: TIERS },
      async (h) => {
        await assert.rejects(() => h.run(), `status ${status}`)
        // (the SDK retries a 429 on the same model by itself: that is the backoff it is for)
        assert.ok(
          executorModels(h.llm).every((m) => m === 's1:lite'),
          `${status}: no stronger model called`,
        )
        assert.equal(of(h.events, 'step.escalated').length, 0)
      },
    )
  }
})

test('no escalation: a stop is a stop', async () => {
  const stop = new AbortController()
  await withRun(
    scripted(['low'], (_step, model) => {
      if (model === 'lite') {
        stop.abort()
        return { text: 'stuck\n[BLOCKER]', delayMs: 30 }
      }
      return { text: 'ok' }
    }),
    { executorTiers: TIERS },
    async (h) => {
      await assert.rejects(() => h.run(stop.signal))
      assert.deepEqual(executorModels(h.llm), ['s1:lite'])
      assert.equal(of(h.events, 'step.escalated').length, 0)
    },
  )
})

test('no escalation: a spent budget (tokens, tool calls)', async () => {
  // The light attempt spends the run's token budget and reports a blocker.
  await withRun(
    scripted(['low', 'low'], (_step, model) =>
      model === 'lite'
        ? { text: 'stuck\n[BLOCKER]', usage: { prompt: 900, completion: 200 } }
        : { text: 'ok' },
    ),
    { executorTiers: TIERS, limits: { maxTotalTokens: 1000 } },
    async (h) => {
      await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:lite'])
      assert.equal(of(h.events, 'step.escalated').length, 0)
      assert.equal(of(h.events, 'budget.exceeded').length, 1)
    },
  )
  // The tool-call budget ran out inside the step.
  const ran: unknown[] = []
  await withRun(
    scripted(['low'], (_step, model, req) =>
      model !== 'lite'
        ? { text: 'ok' }
        : toolResults(req).length < 2
          ? { toolCalls: [{ name: 'note_write', args: { text: `n${toolResults(req).length}` } }] }
          : { text: 'out of calls\n[BLOCKER]' },
    ),
    { executorTiers: TIERS, maxToolCalls: 1, tools: noteTool(ran) },
    async (h) => {
      await h.run()
      assert.deepEqual(
        executorModels(h.llm).filter((m) => m !== 's1:lite'),
        [],
      )
      assert.equal(of(h.events, 'step.escalated').length, 0)
      assert.equal(ran.length, 1)
    },
  )
})

test('no escalation: a tool the user denied', async () => {
  const ran: unknown[] = []
  await withRun(
    scripted(['low', 'low'], (step, model, req) =>
      step !== 's1' || model !== 'lite'
        ? { text: 'ok' }
        : hasToolResult(req)
          ? { text: 'The user refused the write.\n[BLOCKER]' }
          : { toolCalls: [{ name: 'note_write', args: { text: 'x' } }] },
    ),
    {
      executorTiers: TIERS,
      tools: noteTool(ran),
      toolApproval: { mode: 'ask-all', onRequest: () => ({ approved: false, reason: 'no' }) },
    },
    async (h) => {
      const result = await h.run()
      assert.equal(ran.length, 0)
      assert.deepEqual(executorModels(h.llm), ['s1:lite', 's1:lite', 's2:lite'])
      assert.equal(of(h.events, 'step.escalated').length, 0)
      assert.equal(result.trace[0].blocked, true)
      assert.equal(count(h.llm, 'replanner'), 1, 'the replanner still hears of it')
    },
  )
})

// ── SIDE EFFECTS ─────────────────────────────────────────────────────────

test('side effects: the escalated attempt sees what was done, and a write is not executed twice', async () => {
  const writes: unknown[] = []
  let reads = 0
  const write = (text: string) => ({ toolCalls: [{ name: 'note_write', args: { text } }] })
  await withRun(
    scripted(['low'], (_step, model, req) => {
      const n = toolResults(req).length
      if (model === 'lite') {
        // Reads, writes "a" (it goes through), then gives up.
        return n === 0
          ? { toolCalls: [{ name: 'note_read', args: {} }] }
          : n === 1
            ? write('a')
            : { text: 'I wrote a but cannot go on.\n[BLOCKER]' }
      }
      // The stronger model starts the step over all the same: the read, the SAME write, then a
      // new one, then it finishes.
      return n === 0
        ? { toolCalls: [{ name: 'note_read', args: {} }] }
        : n === 1
          ? write('a')
          : n === 2
            ? write('b')
            : { text: 'wrote a and b' }
    }),
    {
      executorTiers: TIERS,
      tools: {
        ...noteTool(writes),
        note_read: markReadOnly(
          tool({
            description: 'Read the notes.',
            inputSchema: z.object({}),
            execute: async () => {
              reads += 1
              return `notes v${reads}`
            },
          }),
        ),
      },
    },
    async (h) => {
      const result = await h.run()
      assert.deepEqual(writes, [{ text: 'a' }, { text: 'b' }], 'the write of "a" ran exactly once')
      assert.equal(reads, 2, 'a read-only tool is simply run again')

      const retry = h.llm.requests.filter((r) => stageOf(r) === 'executor' && r.model === 'std')
      // It was told, with arguments and results, before it made a single call.
      assert.match(userOf(retry[0]), /note_write \{"text":"a"\} -> ok: saved a/)
      assert.match(userOf(retry[0]), /note_read \{\} -> ok: notes v1/)
      assert.match(userOf(retry[0]), /do not make it again/)
      assert.match(userOf(retry[0]), /It said: I wrote a but cannot go on\./)
      // And when it repeated the write anyway, it got the earlier result back, marked as such.
      const replayed = toolResults(retry[2])[1]
      assert.match(replayed, /not run again: this exact call already succeeded/)
      assert.match(replayed, /saved a/)

      // The trace holds every attempt's calls: all of them happened.
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
      assert.match(String(step.toolCalls[3].output), /not run again/)
      assert.equal(step.summary, 'wrote a and b')
      assert.deepEqual(step.escalations, [{ from: 'light', to: 'standard', reason: 'blocked' }])
    },
  )
})

test('side effects: a failed write is run again, and within one attempt nothing is held back', async () => {
  const attempts: string[] = []
  let failNext = true
  await withRun(
    scripted(['low'], (_step, model, req) => {
      const n = toolResults(req).length
      const call = { toolCalls: [{ name: 'flaky_write', args: { text: 'a' } }] }
      if (model === 'lite') {
        return n === 0 ? call : { text: 'the write failed\n[BLOCKER]' }
      }
      // Twice with the same arguments inside ONE attempt: both run, as they always would.
      return n < 2 ? call : { text: 'written' }
    }),
    {
      executorTiers: TIERS,
      tools: {
        flaky_write: tool({
          description: 'Write, failing the first time.',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => {
            attempts.push(text)
            if (failNext) {
              failNext = false
              throw new Error('disk busy')
            }
            return `saved ${text}`
          },
        }),
      },
    },
    async (h) => {
      await h.run()
      assert.equal(attempts.length, 3, 'the failed call and both calls of the second attempt ran')
      assert.equal(of(h.events, 'step.escalated').length, 1)
    },
  )
})

test('side effects: an attempt that THREW after a write still hands that write over', async () => {
  const writes: unknown[] = []
  await withRun(
    scripted(['low'], (_step, model, req) => {
      const n = toolResults(req).length
      const call = { toolCalls: [{ name: 'note_write', args: { text: 'a' } }] }
      if (model === 'lite') {
        return n === 0 ? call : { status: 500, text: 'model crashed' }
      }
      return n === 0 ? call : { text: 'done' }
    }),
    { executorTiers: TIERS, tools: noteTool(writes) },
    async (h) => {
      const result = await h.run()
      assert.deepEqual(writes, [{ text: 'a' }], 'once')
      assert.deepEqual(
        of(h.events, 'step.escalated').map((e) => e.reason),
        ['error'],
      )
      const retry = h.llm.requests.filter((r) => stageOf(r) === 'executor' && r.model === 'std')[0]
      assert.match(userOf(retry), /note_write \{"text":"a"\} -> ok: saved a/)
      assert.match(userOf(retry), /stopped because its model call failed/)
      assert.equal(result.trace[0].toolCalls.length, 2)
    },
  )
})

// ── USAGE ────────────────────────────────────────────────────────────────

test('usage: the calls of every tier count, a failed attempt included', async () => {
  const USE: Record<string, { prompt: number; completion: number }> = {
    lite: { prompt: 100, completion: 10 },
    std: { prompt: 1000, completion: 100 },
    big: { prompt: 10000, completion: 1000 },
  }
  await withRun(
    scripted(['low', 'high'], (step, model) => ({
      text: step === 's1' && model === 'lite' ? 'stuck\n[BLOCKER]' : 'ok',
      usage: USE[model],
    })),
    { executorTiers: TIERS },
    async (h) => {
      const result = await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:lite', 's1:std', 's2:big'])
      const executed = of(h.events, 'usage')
        .filter((e) => e.phase === 'execute')
        .map((e) => e.usage.totalTokens)
      assert.deepEqual(executed, [110, 1100, 11000])
      // planner 15 + three executor calls + synthesizer 15
      assert.equal(result.usage.totalTokens, 15 + 110 + 1100 + 11000 + 15)
      assert.equal(h.agent.usage.totalTokens, result.usage.totalTokens)
      assert.equal(result.usage.inputTokens, 10 + 100 + 1000 + 10000 + 10)
    },
  )
})

test('usage: a run-level limit counts every tier, and stops the run when a strong call crosses it', async () => {
  await withRun(
    scripted(['high', 'low', 'low'], (_step, model) => ({
      text: 'ok',
      usage: model === 'big' ? { prompt: 5000, completion: 100 } : { prompt: 10, completion: 5 },
    })),
    { executorTiers: TIERS, limits: { maxTotalTokens: 4000 } },
    async (h) => {
      const result = await h.run()
      assert.deepEqual(executorModels(h.llm), ['s1:big'])
      const exceeded = of(h.events, 'budget.exceeded')
      assert.equal(exceeded.length, 1)
      assert.equal(exceeded[0].kind, 'total')
      assert.equal(result.trace.length, 1)
    },
  )
})

// ── RESUME ───────────────────────────────────────────────────────────────

test('resume: the snapshot keeps each step rating and tier, and the escalation count', async () => {
  const saved = new Map<string, IRunSnapshot>()
  const persistence = {
    onStepComplete: (s: IRunSnapshot) => void saved.set(s.runId, structuredClone(s)),
    loadRun: (id: string) => saved.get(id) ?? null,
  }
  const crashAfterFirst = new AbortController()
  let runId = ''
  const script = scripted(['low', 'high', 'low'], (step, model) =>
    model === 'lite'
      ? { text: `stuck on ${step}\n[BLOCKER]` }
      : { text: `did ${step} on ${model}` },
  )
  await withRun(
    script,
    { executorTiers: TIERS, escalation: { maxPerRun: 1 }, replanAfter: () => false, persistence },
    async (h) => {
      await assert.rejects(() =>
        h.agent.run({
          input: 'Do the work',
          signal: crashAfterFirst.signal,
          onEvent: (e) => {
            runId = e.runId ?? runId
            // The "crash": the run dies right after its first checkpoint.
            if (e.type === 'step.start' && e.index === 1) {
              crashAfterFirst.abort()
            }
          },
        }),
      )
    },
  )
  const snap = saved.get(runId)!
  assert.equal(snap.stepIndex, 1)
  assert.deepEqual(
    snap.plan?.steps.map((s) => s.complexity),
    ['low', 'high', 'low'],
  )
  assert.equal(snap.trace[0].tier, 'standard')
  assert.equal(snap.trace[0].model, 'std')
  assert.deepEqual(snap.trace[0].escalations, [
    { from: 'light', to: 'standard', reason: 'blocked' },
  ])
  assert.equal(snap.escalations, 1)

  await withRun(
    script,
    { executorTiers: TIERS, escalation: { maxPerRun: 1 }, replanAfter: () => false, persistence },
    async (h) => {
      const events: AgentEvent[] = []
      const result = await h.agent.run({
        input: 'ignored',
        resumeFromRunId: runId,
        onEvent: (e) => events.push(e),
      })
      // The planner does not run again; the high step still goes to the strong model, the low
      // one to the light model - and the run's ONE escalation was already spent before the crash.
      assert.equal(count(h.llm, 'planner'), 0)
      assert.deepEqual(executorModels(h.llm), ['s2:big', 's3:lite'])
      assert.deepEqual(
        of(events, 'step.start').map((e) => [e.step.id, e.tier, e.tierReason]),
        [
          ['s2', 'strong', 'planned'],
          ['s3', 'light', 'planned'],
        ],
      )
      assert.equal(of(events, 'step.escalated').length, 0, 'the per-run cap survives the resume')
      assert.deepEqual(
        result.trace.map((r) => r.tier),
        ['standard', 'strong', 'light'],
      )
    },
  )
})

// ── SCHEMAS, CLI, PIPELINE ───────────────────────────────────────────────

test('schema: the tiered plan accepts a rated and an unrated step, and refuses an unknown rating', () => {
  const step = { id: 's1', description: 'd', expectedOutcome: 'e' }
  const plan = (s: object) => ({ thought: 't', steps: [s] })
  assert.equal(TieredPlanSchema.safeParse(plan(step)).success, true)
  const rated = TieredPlanSchema.safeParse(plan({ ...step, complexity: 'high' }))
  assert.equal(rated.success, true)
  assert.equal((rated.data?.steps[0] as { complexity?: string }).complexity, 'high')
  assert.equal(TieredPlanSchema.safeParse(plan({ ...step, complexity: 'extreme' })).success, false)
})

test('cli: the tier models and the escalation switches come from the environment', () => {
  assert.deepEqual(parseExecutorTiers({}), {})
  assert.deepEqual(parseExecutorTiers({ AGENT_EXECUTOR_LIGHT_MODEL: 'lite' }), {
    executorTiers: { light: { model: 'lite' } },
  })
  assert.deepEqual(
    parseExecutorTiers({
      AGENT_EXECUTOR_LIGHT_MODEL: 'lite',
      AGENT_EXECUTOR_STRONG_MODEL: 'big',
      AGENT_EXECUTOR_STRONG_PROVIDER_TYPE: 'anthropic',
      AGENT_EXECUTOR_STRONG_API_KEY: 'k',
      AGENT_ESCALATION_MAX_PER_STEP: '2',
    }),
    {
      executorTiers: {
        light: { model: 'lite' },
        strong: {
          providerType: 'anthropic',
          baseURL: undefined,
          apiKey: 'k',
          providerOptions: undefined,
          model: 'big',
        },
      },
      escalation: { maxPerStep: 2 },
    },
  )
  assert.deepEqual(
    parseExecutorTiers({ AGENT_EXECUTOR_STRONG_MODEL: 'big', AGENT_ESCALATION: 'off' }),
    { executorTiers: { strong: { model: 'big' } }, escalation: false },
  )
  assert.throws(() => parseExecutorTiers({ AGENT_ESCALATION: 'on' }), /no tier model/)
  assert.throws(
    () => parseExecutorTiers({ AGENT_EXECUTOR_LIGHT_API_KEY: 'k' }),
    /AGENT_EXECUTOR_LIGHT_MODEL is not/,
  )
  assert.throws(
    () => parseExecutorTiers({ AGENT_EXECUTOR_LIGHT_MODEL: 'l', AGENT_ESCALATION: 'maybe' }),
    /on \| off/,
  )
})

test('pipeline: a node keeps the base tiers, unless it names another model', async () => {
  const base = config('http://127.0.0.1:1/v1', { executorTiers: TIERS, escalation: false })
  const resolve = nodeResolver({
    base,
    models: {
      other: { model: 'other' },
      tiered: { model: 'other', executorTiers: { strong: { model: 'other-big' } } },
    },
  })
  const node = (model?: string) => ({ id: 'n', ...(model ? { model } : {}) }) as never
  const same = (await resolve(node())) as IAgentConfig
  assert.deepEqual(same.executorTiers, TIERS)
  assert.equal(same.escalation, false)
  // The base's tiers were written for the base model, like its planner / synthesizer blocks.
  const other = (await resolve(node('other'))) as IAgentConfig
  assert.equal(other.model, 'other')
  assert.equal(other.executorTiers, undefined)
  const tiered = (await resolve(node('tiered'))) as IAgentConfig
  assert.deepEqual(tiered.executorTiers, { strong: { model: 'other-big' } })
})
