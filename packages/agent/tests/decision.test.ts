import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { tool } from 'ai'
import { Experimental_DecisionMockModelV4 } from 'ai/test'
import { z } from 'zod'
import {
  askDecisionModel,
  createAgent,
  createPipeline,
  createRunControl,
  decisionModelFromAiSdk,
  DEFAULT_DECISION_CONFIDENCE_THRESHOLD,
  DEFAULT_DECISION_TIMEOUT_MS,
  nodeResolver,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type IAgentRunResult,
  type IDecisionAnswer,
  type IDecisionModel,
  type IDecisionQuestion,
  type PipelineDefinition,
} from '../src/index.ts'
import {
  hasToolResult,
  startLocalOpenAI,
  systemOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from './helpers/openai-server.ts'

// `config.decisionModel`: a model that answers a closed question with an option and a
// probability. Scripted decision models (an object with `decide`) and the scripted
// OpenAI-compatible endpoint for the ordinary model; the vendor adapter against a local
// imitation of the documented Gemini Decisions response. No real API, no key.

const here = (path: string): URL => new URL(path, import.meta.url)

test('decision: the shared file is the same in both packages, and so are its tests', (t) => {
  const sibling = here('../../agent-web/src/decision.ts')
  if (!existsSync(sibling)) return t.skip('the browser sibling is not in this checkout')
  assert.equal(
    readFileSync(here('../src/decision.ts'), 'utf8'),
    readFileSync(sibling, 'utf8'),
    'src/decision.ts and agent-web/src/decision.ts are a deliberate copy: change both',
  )
})

// ── the guard: askDecisionModel ──────────────────────────────────────────────

const question: IDecisionQuestion = {
  id: 'q',
  prompt: 'Which one?',
  options: [{ id: 'a', description: 'the first' }, { id: 'b' }],
  context: 'some text',
}

const answering = (answer: Partial<IDecisionAnswer> | Error): IDecisionModel => ({
  name: 'scripted',
  decide: async () => {
    if (answer instanceof Error) throw answer
    return answer as IDecisionAnswer
  },
})

test('decision: the defaults are named constants', () => {
  assert.equal(DEFAULT_DECISION_CONFIDENCE_THRESHOLD, 0.8)
  assert.equal(DEFAULT_DECISION_TIMEOUT_MS, 5000)
})

test('decision guard: an answer at or above the threshold is accepted, one below is not', async () => {
  const at = await askDecisionModel(answering({ choice: 'a', confidence: 0.8 }), question)
  assert.equal(at.accepted, true, 'the default threshold is inclusive')
  assert.equal(at.choice, 'a')
  assert.equal(at.confidence, 0.8)
  assert.equal(at.threshold, 0.8)
  assert.equal(at.reason, undefined)

  const below = await askDecisionModel(answering({ choice: 'a', confidence: 0.79 }), question)
  assert.equal(below.accepted, false)
  assert.equal(below.reason, 'low-confidence')
  assert.equal(below.choice, 'a', 'what it said is still reported')
  assert.equal(below.confidence, 0.79)

  // The host's threshold replaces the default, both ways.
  const strict = { confidenceThreshold: 0.95 }
  const high = await askDecisionModel(answering({ choice: 'b', confidence: 0.9 }), question, strict)
  assert.equal(high.accepted, false)
  assert.equal(high.threshold, 0.95)
  const lax = await askDecisionModel(answering({ choice: 'b', confidence: 0.5 }), question, {
    confidenceThreshold: 0.5,
  })
  assert.equal(lax.accepted, true)
})

test('decision guard: an answer that is not one of the options is refused, whatever its confidence', async () => {
  for (const choice of ['c', 'A', ' a', '', undefined, 7, null]) {
    const r = await askDecisionModel(
      answering({ choice: choice as string, confidence: 1 }),
      question,
    )
    assert.equal(r.accepted, false, `choice ${JSON.stringify(choice)}`)
    assert.equal(r.reason, 'invalid-choice')
    assert.equal(r.choice, undefined, 'a made-up option is never handed on')
  }
  const nothing = await askDecisionModel({ decide: async () => undefined as never }, question)
  assert.equal(nothing.reason, 'invalid-choice')
})

test('decision guard: a confidence that is not a probability is refused', async () => {
  for (const confidence of [Number.NaN, Infinity, -0.1, 1.01, '0.99', undefined]) {
    const r = await askDecisionModel(
      answering({ choice: 'a', confidence: confidence as number }),
      question,
    )
    assert.equal(r.accepted, false, `confidence ${String(confidence)}`)
    assert.equal(r.reason, 'invalid-confidence')
  }
})

test('decision guard: an error is an outcome, not an exception', async () => {
  const r = await askDecisionModel(answering(new Error('503 from the API')), question)
  assert.equal(r.accepted, false)
  assert.equal(r.reason, 'error')
  assert.match(r.error ?? '', /503 from the API/)
  // A synchronous throw too.
  const sync = await askDecisionModel(
    {
      decide: () => {
        throw new Error('sync')
      },
    },
    question,
  )
  assert.equal(sync.reason, 'error')
  // A long message is clipped.
  const long = await askDecisionModel(answering(new Error('x'.repeat(5000))), question)
  assert.ok((long.error ?? '').length <= 301)
})

test('decision guard: a model that does not answer in time is a timeout, and is told to stop', async () => {
  let seen: AbortSignal | undefined
  const hanging: IDecisionModel = {
    decide: (_q, { abortSignal }) => {
      seen = abortSignal
      // Ignores its signal: the guard must not wait for it.
      return new Promise(() => {})
    },
  }
  const started = Date.now()
  const r = await askDecisionModel(hanging, question, { timeoutMs: 40 })
  assert.equal(r.accepted, false)
  assert.equal(r.reason, 'timeout')
  assert.ok(Date.now() - started < 2000, 'the guard returned at the deadline')
  assert.equal(seen?.aborted, true, 'the call was aborted')

  // An answer that arrives after the deadline is not used, and a late rejection is swallowed.
  const late: IDecisionModel = {
    decide: () =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 80)),
  }
  const r2 = await askDecisionModel(late, question, { timeoutMs: 20 })
  assert.equal(r2.reason, 'timeout')
  await new Promise((resolve) => setTimeout(resolve, 120))
})

test('decision guard: a stop of the run throws, before and during the call', async () => {
  const stopped = new AbortController()
  stopped.abort()
  let called = false
  await assert.rejects(
    askDecisionModel(
      {
        decide: async () => {
          called = true
          return { choice: 'a', confidence: 1 }
        },
      },
      question,
      undefined,
      stopped.signal,
    ),
  )
  assert.equal(called, false, 'a stopped run asks nothing')

  const during = new AbortController()
  const pending = askDecisionModel(
    { decide: () => new Promise(() => {}) },
    question,
    { timeoutMs: 0 },
    during.signal,
  )
  setTimeout(() => during.abort(), 20)
  await assert.rejects(pending)
})

// ── the replanner's decision ─────────────────────────────────────────────────

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer' | 'router' | 'other'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Router')) return 'router'
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  if (system.includes('You are the Executor')) return 'executor'
  return 'other'
}

const plan = JSON.stringify({
  thought: 'Three steps.',
  steps: ['s1', 's2', 's3'].map((id) => ({
    id,
    description: `Step ${id}`,
    expectedOutcome: `${id} done`,
    suggestedTools: [],
  })),
})

const script: Script = (req) => {
  switch (stageOf(req)) {
    case 'planner':
      return { text: plan }
    case 'replanner':
      return { text: JSON.stringify({ mode: 'continue', reason: 'on track' }) }
    case 'executor':
      return { text: 'did it' }
    default:
      return { text: 'All done.' }
  }
}

const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'decision',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 6,
  maxStepsPerTask: 3,
  // The replanner is consulted after every step but the last: two rounds for three steps.
  replanAfter: 'always',
  llmMaxRetries: 0,
  logLevel: 'none',
  ...extra,
})

interface IScriptedDecision extends IDecisionModel {
  questions: IDecisionQuestion[]
}

// A decision model that answers every question the same way and records what it was asked.
const scripted = (
  answer: (q: IDecisionQuestion) => Partial<IDecisionAnswer> | Promise<IDecisionAnswer>,
): IScriptedDecision => {
  const questions: IDecisionQuestion[] = []
  return {
    name: 'scripted-decision',
    questions,
    decide: async (q) => {
      questions.push(q)
      return (await answer(q)) as IDecisionAnswer
    },
  }
}

const withRun = async (
  extra: Partial<IAgentConfig>,
  body: (r: {
    llm: ILocalOpenAI
    agent: IAgent
    events: AgentEvent[]
    result: IAgentRunResult
  }) => void | Promise<void>,
  theScript: Script = script,
): Promise<void> => {
  const llm = await startLocalOpenAI(theScript)
  let agent: IAgent | undefined
  try {
    agent = await createAgent(config(llm.baseURL, extra))
    const events: AgentEvent[] = []
    const result = await agent.run({ input: 'Do three things', onEvent: (e) => events.push(e) })
    await body({ llm, agent, events, result })
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
  }
}

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

const calls = (llm: ILocalOpenAI, stage: Stage): number =>
  llm.requests.filter((r) => stageOf(r) === stage).length

test('decision replan: a confident "continue" replaces the replanner call', async () => {
  const model = scripted(() => ({
    choice: 'continue',
    confidence: 0.93,
    usage: { inputTokens: 120, outputTokens: 0 },
  }))
  await withRun({ decisionModel: model }, ({ llm, agent, events, result }) => {
    assert.equal(calls(llm, 'replanner'), 0, 'the replanner was never called')
    assert.equal(calls(llm, 'executor'), 3, 'every planned step ran')
    assert.equal(result.text, 'All done.')

    // What it was asked: a closed question about the same text the replanner would have read.
    assert.equal(model.questions.length, 2)
    assert.equal(model.questions[0].id, 'replan')
    assert.deepEqual(
      model.questions[0].options.map((o) => o.id),
      ['continue', 'finish', 'revise'],
    )
    assert.match(model.questions[0].context ?? '', /Do three things/)

    const decisions = of(events, 'decision')
    assert.equal(decisions.length, 2)
    for (const d of decisions) {
      assert.equal(d.point, 'replan')
      assert.equal(d.accepted, true)
      assert.equal(d.choice, 'continue')
      assert.equal(d.confidence, 0.93)
      assert.equal(d.threshold, 0.8)
      assert.equal(d.model, 'scripted-decision')
      assert.equal(d.reason, undefined)
    }
    const replans = of(events, 'replan.decision').filter((e) => e.cause !== 'last-step')
    assert.deepEqual(
      replans.map((e) => [e.mode, e.cause, e.confidence]),
      [
        ['continue', 'decision-model', 0.93],
        ['continue', 'decision-model', 0.93],
      ],
    )

    // Usage: the calls are counted as calls, the tokens the API reported as tokens.
    const charged = of(events, 'usage').filter((e) => e.phase === 'decision')
    assert.equal(charged.length, 2)
    assert.deepEqual(charged[0].usage, {
      inputTokens: 120,
      outputTokens: 0,
      totalTokens: 120,
      decisionCalls: 1,
    })
    assert.equal(result.usage.decisionCalls, 2)
    assert.equal(agent.usage.decisionCalls, 2)
    // 15 tokens per scripted model call, plus the 2 x 120 the decision API reported.
    assert.equal(result.usage.totalTokens, llm.requests.length * 15 + 240)
    assert.equal(of(events, 'usage').filter((e) => e.phase === 'replan').length, 0)
  })
})

test('decision replan: a decision model that reports no usage adds calls, and no tokens', async () => {
  const model = scripted(() => ({ choice: 'continue', confidence: 0.99 }))
  await withRun({ decisionModel: model }, ({ llm, result }) => {
    assert.equal(result.usage.decisionCalls, 2)
    assert.equal(result.usage.totalTokens, llm.requests.length * 15, 'no token was invented')
  })
})

test('decision replan: a confident "finish" ends the plan without a replanner call', async () => {
  const model = scripted(() => ({ choice: 'finish', confidence: 0.97 }))
  await withRun({ decisionModel: model }, ({ llm, events, result }) => {
    assert.equal(calls(llm, 'replanner'), 0)
    assert.equal(calls(llm, 'executor'), 1, 'the run stopped after the first step')
    assert.equal(calls(llm, 'synthesizer'), 1)
    assert.equal(result.trace.length, 1)
    const last = of(events, 'replan.decision').at(-1)
    assert.equal(last?.mode, 'finish')
    assert.equal(last?.cause, 'decision-model')
  })
})

// What the agent sends without a decision model: the reference every fallback is compared with.
const requestsWithout = async (): Promise<IChatRequest[]> => {
  let sent: IChatRequest[] = []
  await withRun({}, ({ llm, events }) => {
    sent = llm.requests
    assert.equal(of(events, 'decision').length, 0, 'off: no decision event')
    assert.equal(
      of(events, 'usage').filter((e) => e.phase === 'decision').length,
      0,
      'off: no decision usage',
    )
  })
  return sent
}

const fallbacks: [string, IDecisionModel['decide'], string, Partial<IAgentConfig>][] = [
  ['a low confidence', async () => ({ choice: 'finish', confidence: 0.79 }), 'low-confidence', {}],
  [
    'an error',
    async () => {
      throw new Error('decision API is down')
    },
    'error',
    {},
  ],
  ['a timeout', () => new Promise(() => {}), 'timeout', { decision: { timeoutMs: 30 } }],
  [
    'an answer that is not an option',
    async () => ({ choice: 'abort-everything', confidence: 1 }),
    'invalid-choice',
    {},
  ],
  [
    'a confidence that is not a probability',
    async () => ({ choice: 'finish', confidence: 42 }),
    'invalid-confidence',
    {},
  ],
  [
    '"revise" (a plan is text)',
    async () => ({ choice: 'revise', confidence: 0.99 }),
    'needs-model',
    {},
  ],
]

for (const [name, decide, reason, extra] of fallbacks) {
  test(`decision replan: ${name} falls back to the replanner, unchanged`, async () => {
    const reference = await requestsWithout()
    await withRun({ decisionModel: { decide }, ...extra }, ({ llm, events, result }) => {
      assert.equal(calls(llm, 'replanner'), 2, 'the replanner ran at both rounds')
      assert.deepEqual(
        llm.requests,
        reference,
        'the model calls are exactly the ones made without a decision model',
      )
      const decisions = of(events, 'decision')
      assert.equal(decisions.length, 2)
      assert.ok(decisions.every((d) => d.accepted === false && d.reason === reason))
      const replans = of(events, 'replan.decision').filter((e) => e.cause !== 'last-step')
      assert.ok(replans.every((e) => e.cause === 'llm-decision' && e.confidence === undefined))
      assert.equal(result.trace.length, 3, 'the wrong "finish" ended nothing')
      // The attempts are still counted: they were made.
      assert.equal(result.usage.decisionCalls, 2)
    })
  })
}

test('decision: off - no decision model, or `decision.replan: false` - asks nothing', async () => {
  const reference = await requestsWithout()
  const model = scripted(() => ({ choice: 'finish', confidence: 1 }))
  await withRun(
    { decisionModel: model, decision: { replan: false } },
    ({ llm, events, result }) => {
      assert.equal(model.questions.length, 0)
      assert.deepEqual(llm.requests, reference)
      assert.equal(of(events, 'decision').length, 0)
      assert.equal(result.usage.decisionCalls, undefined, 'usage has no new field when unused')
    },
  )
  await withRun({}, ({ agent, result }) => {
    assert.equal('decisionCalls' in result.usage, false)
    assert.equal('decisionCalls' in agent.usage, false)
  })
})

test('decision replan: a message from the user is weighed by the replanner, not the decision model', async () => {
  const model = scripted(() => ({ choice: 'finish', confidence: 1 }))
  const llm = await startLocalOpenAI(script)
  let agent: IAgent | undefined
  try {
    agent = await createAgent(config(llm.baseURL, { decisionModel: model }))
    const control = createRunControl()
    control.send('Make it shorter')
    const events: AgentEvent[] = []
    await agent.run({ input: 'Do three things', control, onEvent: (e) => events.push(e) })
    const replans = of(events, 'replan.decision')
    // Round 1 was forced by the message: the replanner answered it ("continue"), although the
    // decision model would have said "finish" with full confidence.
    assert.equal(replans[0].cause, 'user-message')
    assert.equal(replans[0].mode, 'continue')
    assert.equal(calls(llm, 'replanner'), 1)
    // Round 2 is an ordinary one: the decision model is asked, and ends the plan.
    assert.equal(model.questions.length, 1)
    assert.equal(replans[1].cause, 'decision-model')
    assert.equal(replans[1].mode, 'finish')
    assert.equal(calls(llm, 'executor'), 2)
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
  }
})

// ── security: a decision is never a permission ───────────────────────────────

test('decision security: the decision model is not consulted for tool approval or egress', async () => {
  let wiped = 0
  // Says yes to anything, with full confidence - and would say "approve" / "allow" if asked.
  const model = scripted((q) => ({
    choice: q.options.find((o) => /approve|allow|yes/i.test(o.id))?.id ?? q.options[0].id,
    confidence: 1,
  }))
  const twoSteps = JSON.stringify({
    thought: 'Two steps.',
    steps: ['s1', 's2'].map((id) => ({
      id,
      description: `Step ${id}`,
      expectedOutcome: `${id} done`,
      suggestedTools: ['wipe', 'web_fetch'],
    })),
  })
  let executorCalls = 0
  const acting: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: twoSteps }
      case 'executor':
        if (hasToolResult(req)) return { text: 'done' }
        executorCalls += 1
        return executorCalls === 1
          ? { toolCalls: [{ name: 'wipe', args: {} }] }
          : { toolCalls: [{ name: 'web_fetch', args: { url: 'https://not-allowed.test/x' } }] }
      default:
        return { text: 'All done.' }
    }
  }
  const approvals: string[] = []
  await withRun(
    {
      decisionModel: model,
      decision: { confidenceThreshold: 0 },
      tools: {
        wipe: tool({
          description: 'Delete everything',
          inputSchema: z.object({}),
          execute: async () => {
            wiped += 1
            return 'wiped'
          },
        }),
      },
      toolApproval: {
        mode: 'ask-all',
        onRequest: (request) => {
          approvals.push(request.toolName)
          // The human refuses the write and lets the fetch through: the egress policy, not a
          // consent, is what must stop that one.
          return request.toolName === 'wipe'
            ? { approved: false, reason: 'no' }
            : { approved: true }
        },
      },
      egress: { allow: ['allowed.test'] },
    },
    ({ events, result }) => {
      // The gates did their work in code...
      assert.equal(wiped, 0, 'the denied tool never ran')
      assert.ok(approvals.includes('wipe'), 'the human was asked, not the decision model')
      const resolved = of(events, 'tool.approval-resolved')
      assert.deepEqual(
        resolved.map((e) => [e.name, e.approved]),
        [
          ['wipe', false],
          ['web_fetch', true],
        ],
      )
      const egress = of(events, 'egress.request')
      assert.equal(egress.length, 1)
      assert.equal(egress[0].allowed, false, 'the host outside the allow list was refused')
      assert.ok(result.trace.flatMap((s) => s.toolCalls).every((c) => c.ok === false))
      // ...and the decision model, live and fully confident, was asked about the plan only.
      assert.ok(model.questions.length > 0, 'the decision model was in play')
      assert.deepEqual([...new Set(model.questions.map((q) => q.id))], ['replan'])
      assert.ok(of(events, 'decision').every((e) => e.point === 'replan'))
    },
    acting,
  )
})

// ── the pipeline's route ─────────────────────────────────────────────────────

const definition: PipelineDefinition = {
  version: 1,
  name: 'review',
  entry: 'reviewer',
  nodes: [
    {
      id: 'reviewer',
      name: 'Reviewer',
      instructions: 'ROLE-REVIEWER: judge the text.',
      routes: [{ label: 'approve', description: 'good to publish' }, { label: 'revise' }],
    },
    { id: 'publisher', instructions: 'ROLE-PUBLISHER: publish the text.' },
    { id: 'writer', instructions: 'ROLE-WRITER: rewrite the text.' },
  ],
  edges: [
    { id: 'ok', from: 'reviewer', to: 'publisher', when: { kind: 'route', label: 'approve' } },
    { id: 'redo', from: 'reviewer', to: 'writer', when: { kind: 'route', label: 'revise' } },
  ],
}

const roleOf = (req: IChatRequest): string =>
  /ROLE-(\w+)/.exec(systemOf(req))?.[1].toLowerCase() ?? 'none'

// The router model always says "revise": a run that ends at the publisher was routed by the
// decision model.
const pipelineScript: Script = (req) => {
  const stage = stageOf(req)
  const role = roleOf(req)
  if (stage === 'router') return { text: JSON.stringify({ route: 'revise' }) }
  if (stage === 'planner') {
    return {
      text: JSON.stringify({
        thought: 'One step.',
        steps: [{ id: 's1', description: `Do the ${role} work`, expectedOutcome: 'Done' }],
      }),
    }
  }
  if (stage === 'synthesizer') return { text: `${role} says done` }
  return { text: `${role} worked` }
}

const callsOf = (usage: object): number | undefined =>
  (usage as { decisionCalls?: number }).decisionCalls

const runPipeline = async (extra: Partial<IAgentConfig>) => {
  const llm = await startLocalOpenAI(pipelineScript)
  const pipeline = createPipeline(definition, {
    resolveNode: nodeResolver({
      base: { ...config(llm.baseURL, { replanAfter: 'failure', maxIterations: 3 }), ...extra },
    }),
  })
  try {
    const events: AgentEvent[] = []
    const result = await pipeline.run({ input: 'Check my text', onEvent: (e) => events.push(e) })
    return { llm, events, result }
  } finally {
    await pipeline.close()
    await llm.close()
  }
}

test('decision route: a confident label is the route, and the route call is not made', async () => {
  const model = scripted(() => ({
    choice: 'approve',
    confidence: 0.91,
    usage: { inputTokens: 80 },
  }))
  const { llm, events, result } = await runPipeline({ decisionModel: model })
  assert.equal(calls(llm, 'router'), 0, 'no route call')
  assert.equal(result.text, 'publisher says done', 'the decision model picked the route')
  assert.deepEqual(result.outputs.reviewer, [
    { visit: 1, text: 'reviewer says done', route: 'approve' },
  ])

  assert.equal(model.questions.length, 1)
  const asked = model.questions[0]
  assert.equal(asked.id, 'route')
  assert.deepEqual(asked.options, [
    { id: 'approve', description: 'good to publish' },
    { id: 'revise' },
  ])
  assert.match(asked.context ?? '', /reviewer says done/)

  const decisions = of(events, 'decision')
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].point, 'route')
  assert.equal(decisions[0].accepted, true)
  assert.equal(decisions[0].choice, 'approve')
  assert.equal(decisions[0].confidence, 0.91)
  assert.equal(decisions[0].nodeId, 'reviewer', 'the event names its node')
  // The pipeline's usage counts the call and the tokens it reported (the engine's usage type
  // names the token fields only; it sums every numeric field it is given).
  assert.equal(callsOf(result.usage), 1)
  assert.equal(result.usage.totalTokens, llm.requests.length * 15 + 80)
})

const routeFallbacks: [string, IDecisionModel['decide'], string, Partial<IAgentConfig>][] = [
  ['a low confidence', async () => ({ choice: 'approve', confidence: 0.5 }), 'low-confidence', {}],
  [
    'an error',
    async () => {
      throw new Error('down')
    },
    'error',
    {},
  ],
  ['a timeout', () => new Promise(() => {}), 'timeout', { decision: { timeoutMs: 30 } }],
  [
    'a label that does not exist',
    async () => ({ choice: 'publish-anyway', confidence: 1 }),
    'invalid-choice',
    {},
  ],
]

for (const [name, decide, reason, extra] of routeFallbacks) {
  test(`decision route: ${name} falls back to the route call, unchanged`, async () => {
    const reference = await runPipeline({})
    assert.equal(of(reference.events, 'decision').length, 0)
    const { llm, events, result } = await runPipeline({ decisionModel: { decide }, ...extra })
    assert.equal(calls(llm, 'router'), 1, 'the route call ran')
    assert.deepEqual(llm.requests, reference.llm.requests, 'the same model calls as without it')
    assert.equal(result.text, 'writer says done', 'the route is the router model\'s ("revise")')
    const decisions = of(events, 'decision')
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].accepted, false)
    assert.equal(decisions[0].reason, reason)
    assert.equal(callsOf(result.usage), 1)
  })
}

test('decision route: `decision.route: false` leaves the route to the model', async () => {
  const model = scripted(() => ({ choice: 'approve', confidence: 1 }))
  const { llm, result } = await runPipeline({ decisionModel: model, decision: { route: false } })
  assert.equal(model.questions.length, 0)
  assert.equal(calls(llm, 'router'), 1)
  assert.equal(result.text, 'writer says done')
})

// ── the vendor adapter: an AI SDK decision model ─────────────────────────────

interface IDecisionsRequest {
  path: string
  headers: IncomingHttpHeaders
  body: {
    model?: string
    input?: unknown
    questions?: Record<string, { type?: string; instructions?: string; criteria?: unknown }>
  }
}

// A local imitation of the Gemini Decisions API as its documentation describes it
// (POST {base}/decisions, `x-goog-api-key`; `answers` keyed like `questions`, `usage` in tokens).
const startLocalDecisions = async (
  reply: (req: IDecisionsRequest) => { status?: number; body: unknown },
) => {
  const requests: IDecisionsRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const seen: IDecisionsRequest = {
        path: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      }
      requests.push(seen)
      const { status = 200, body } = reply(seen)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1beta`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const documentedAnswer = (probabilities: Record<string, number>) => {
  const [choice, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]
  return {
    answers: { decision: { type: 'choice', choice, probabilities, confidence } },
    usage: {
      total_input_tokens: 100,
      input_tokens_by_modality: [{ modality: 'text', tokens: 100 }],
      total_output_tokens: 0,
      total_tokens: 100,
    },
  }
}

test('decision adapter: Gemini Decisions through the AI SDK, against the documented shapes', async () => {
  const api = await startLocalDecisions(() => ({
    body: documentedAnswer({ continue: 0.9, finish: 0.06, revise: 0.04 }),
  }))
  try {
    const google = createGoogleGenerativeAI({ baseURL: api.baseURL, apiKey: 'test-key-not-real' })
    const model = decisionModelFromAiSdk(google.decisionModel('gemini-decision-1'))
    const answer = await model.decide(
      {
        id: 'replan',
        prompt: 'What next?',
        options: [
          { id: 'continue', description: 'carry on' },
          { id: 'finish', description: 'stop' },
          { id: 'revise' },
        ],
        context: 'the plan and the results',
      },
      {},
    )
    assert.equal(answer.choice, 'continue')
    assert.equal(answer.confidence, 0.9, 'the probability of the option it chose')
    assert.deepEqual(answer.usage, { inputTokens: 100, outputTokens: 0 })
    assert.match(model.name ?? '', /gemini-decision-1/)

    // The request is the documented one.
    assert.equal(api.requests.length, 1)
    const sent = api.requests[0]
    assert.equal(sent.path, '/v1beta/decisions')
    assert.equal(sent.headers['x-goog-api-key'], 'test-key-not-real')
    assert.equal(sent.body.model, 'gemini-decision-1')
    assert.match(JSON.stringify(sent.body.input), /the plan and the results/)
    assert.deepEqual(sent.body.questions, {
      decision: {
        type: 'choice',
        instructions: 'What next?',
        criteria: { continue: 'carry on', finish: 'stop', revise: '' },
      },
    })

    // And the guard reads it like any other answer.
    const outcome = await askDecisionModel(model, {
      id: 'replan',
      prompt: 'What next?',
      options: [{ id: 'continue' }, { id: 'finish' }, { id: 'revise' }],
      context: 'x',
    })
    assert.equal(outcome.accepted, true)
    assert.deepEqual(outcome.usage, { inputTokens: 100, outputTokens: 0 })
  } finally {
    await api.close()
  }
})

test('decision adapter: an API error, a blocked request and an unknown option are fallbacks', async () => {
  const q: IDecisionQuestion = {
    id: 'route',
    prompt: 'Which?',
    options: [{ id: 'approve' }, { id: 'revise' }],
    context: 'x',
  }
  const cases: [string, { status?: number; body: unknown }][] = [
    ['a 429', { status: 429, body: { error: { code: 429, message: 'quota' } } }],
    [
      'a safety block (documented: HTTP 400, no answers)',
      { status: 400, body: { error: { code: 'safety', message: 'Request blocked' } } },
    ],
    [
      'an option the question does not have',
      { body: documentedAnswer({ 'publish-anyway': 0.99, approve: 0.01 }) },
    ],
    ['no answers at all', { body: { usage: { total_input_tokens: 5 } } }],
  ]
  for (const [name, reply] of cases) {
    const api = await startLocalDecisions(() => reply)
    try {
      const google = createGoogleGenerativeAI({ baseURL: api.baseURL, apiKey: 'test-key-not-real' })
      const model = decisionModelFromAiSdk(google.decisionModel('gemini-decision-1'))
      const outcome = await askDecisionModel(model, q)
      assert.equal(outcome.accepted, false, name)
      assert.equal(outcome.reason, 'error', name)
      assert.equal(api.requests.length, 1, `${name}: one request, no retry`)
      assert.doesNotMatch(JSON.stringify(outcome), /test-key-not-real/, 'the key is in no outcome')
    } finally {
      await api.close()
    }
  }
})

test('decision adapter: a model that gives no probabilities gets confidence 0, and is never used', async () => {
  // A language model adapted to decide returns a choice without a distribution.
  const noDistribution = new Experimental_DecisionMockModelV4({
    provider: 'mock',
    modelId: 'adapted-llm',
    doDecide: async () => ({
      answers: { decision: { type: 'choice', choice: 'approve' } },
      warnings: [],
    }),
  })
  const model = decisionModelFromAiSdk(noDistribution)
  const q: IDecisionQuestion = {
    id: 'route',
    prompt: 'Which?',
    options: [{ id: 'approve' }, { id: 'revise' }],
    context: 'x',
  }
  const answer = await model.decide(q, {})
  assert.equal(answer.choice, 'approve')
  assert.equal(answer.confidence, 0)
  const outcome = await askDecisionModel(model, q)
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.reason, 'low-confidence')
  assert.equal(model.name, 'mock:adapted-llm')
})
