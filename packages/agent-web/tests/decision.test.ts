import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { z } from 'zod'
import {
  askDecisionModel,
  createAgent,
  createPipeline,
  createRunControl,
  decisionEgressPolicy,
  defineTool,
  DEFAULT_DECISION_CONFIDENCE_THRESHOLD,
  DEFAULT_DECISION_TIMEOUT_MS,
  MemoryCredentialStore,
  nodeResolver,
  resolveDecisionModel,
  type AgentEvent,
  type BrowserAgentConfig,
  type IDecisionAnswer,
  type IDecisionModel,
  type IDecisionModelSpec,
  type IDecisionQuestion,
  type PipelineDefinition,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// `config.decisionModel`: a model that answers a closed question with an option and a
// probability. The guard itself (`askDecisionModel`, a byte-for-byte copy of the Node sibling's)
// is tested case by case in packages/agent/tests/decision.test.ts; here: the same guards through
// this package's replanner and pipeline, and what is this package's own - a hosted decision API
// called from the page, with the key from the CredentialStore and the request pinned to its host.
// No real API, no key.

const question: IDecisionQuestion = {
  id: 'q',
  prompt: 'Which one?',
  options: [{ id: 'a' }, { id: 'b' }],
  context: 'some text',
}

test('decision: the defaults, and the guard as exported from this package', async () => {
  assert.equal(DEFAULT_DECISION_CONFIDENCE_THRESHOLD, 0.8)
  assert.equal(DEFAULT_DECISION_TIMEOUT_MS, 5000)
  const says = (a: Partial<IDecisionAnswer>): IDecisionModel => ({
    decide: async () => a as IDecisionAnswer,
  })
  assert.equal(
    (await askDecisionModel(says({ choice: 'a', confidence: 0.8 }), question)).accepted,
    true,
  )
  assert.equal(
    (await askDecisionModel(says({ choice: 'a', confidence: 0.79 }), question)).reason,
    'low-confidence',
  )
  assert.equal(
    (await askDecisionModel(says({ choice: 'c', confidence: 1 }), question)).reason,
    'invalid-choice',
  )
  assert.equal(
    (await askDecisionModel(says({ choice: 'a', confidence: 7 }), question)).reason,
    'invalid-confidence',
  )
  const hung = await askDecisionModel({ decide: () => new Promise(() => {}) }, question, {
    timeoutMs: 30,
  })
  assert.equal(hung.reason, 'timeout')
})

// ── the replanner's decision ─────────────────────────────────────────────────

const plan = JSON.stringify({
  thought: 'Three steps.',
  steps: ['one', 'two', 'three'].map((n) => ({ description: `Step ${n}` })),
})

const script = () =>
  scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'continue', reason: 'on track' }) }
      case 'executor':
        return { text: 'did it' }
      default:
        return { text: 'All three done.' }
    }
  })

interface ScriptedDecision extends IDecisionModel {
  questions: IDecisionQuestion[]
}

const scripted = (
  answer: (q: IDecisionQuestion) => Partial<IDecisionAnswer> | Promise<IDecisionAnswer>,
): ScriptedDecision => {
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

const runWith = async (extra: Partial<BrowserAgentConfig> = {}) => {
  const m = script()
  // The replanner is consulted after every step, the last one included: three rounds.
  const agent = await createAgent({ model: m.model, replanAfter: 'always', ...extra })
  const events: AgentEvent[] = []
  const result = await agent.run('Do three things', { onEvent: (e) => events.push(e) })
  return { m, agent, result, events }
}

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

const count = (m: ReturnType<typeof scriptedModel>, stage: string): number =>
  m.calls.filter((c) => stageOf(c) === stage).length

/** What a model call was given: the part a decision model must not change. */
const sent = (m: ReturnType<typeof scriptedModel>) =>
  m.calls.map((c) => ({ system: c.system, user: c.user, tools: c.tools }))

test('decision replan: a confident "continue" replaces the replanner call', async () => {
  const model = scripted(() => ({
    choice: 'continue',
    confidence: 0.93,
    usage: { inputTokens: 120, outputTokens: 0 },
  }))
  const { m, agent, result, events } = await runWith({ decisionModel: model })
  assert.equal(count(m, 'replanner'), 0, 'the replanner was never called')
  assert.equal(count(m, 'executor'), 3)
  assert.equal(result.final, 'All three done.')
  assert.equal(agent.decisionModel, model)

  assert.equal(model.questions.length, 3)
  assert.equal(model.questions[0].id, 'replan')
  assert.deepEqual(
    model.questions[0].options.map((o) => o.id),
    ['continue', 'finish', 'revise'],
  )
  assert.match(model.questions[0].context ?? '', /Do three things/)

  const decisions = of(events, 'decision')
  assert.equal(decisions.length, 3)
  for (const d of decisions) {
    assert.equal(d.point, 'replan')
    assert.equal(d.accepted, true)
    assert.equal(d.choice, 'continue')
    assert.equal(d.confidence, 0.93)
    assert.equal(d.threshold, 0.8)
    assert.equal(d.model, 'scripted-decision')
  }
  assert.deepEqual(
    of(events, 'replan.decision').map((e) => [e.mode, e.confidence]),
    [
      ['continue', 0.93],
      ['continue', 0.93],
      ['continue', 0.93],
    ],
  )

  // Usage: the calls are counted as calls, the tokens the API reported as tokens.
  const charged = of(events, 'usage').filter((e) => e.phase === 'decision')
  assert.equal(charged.length, 3)
  assert.deepEqual(charged[0].usage, {
    inputTokens: 120,
    outputTokens: 0,
    totalTokens: 120,
    decisionCalls: 1,
  })
  assert.equal(result.usage.decisionCalls, 3)
  assert.equal(agent.usage.decisionCalls, 3)
  assert.equal(agent.sessionUsage().decisionCalls, 3)
  assert.equal(result.usage.totalTokens, m.calls.length * 15 + 360)
  assert.equal(of(events, 'usage').filter((e) => e.phase === 'replan').length, 0)
})

test('decision replan: a confident "finish" ends the plan; no usage reported = no tokens added', async () => {
  const model = scripted(() => ({ choice: 'finish', confidence: 0.97 }))
  const { m, result, events } = await runWith({ decisionModel: model })
  assert.equal(count(m, 'replanner'), 0)
  assert.equal(count(m, 'executor'), 1, 'the run stopped after the first step')
  assert.equal(result.trace.length, 1)
  assert.equal(of(events, 'replan.decision').at(-1)?.mode, 'finish')
  assert.equal(result.usage.decisionCalls, 1)
  assert.equal(result.usage.totalTokens, m.calls.length * 15, 'no token was invented')
})

const fallbacks: [string, IDecisionModel['decide'], string, Partial<BrowserAgentConfig>][] = [
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
    const reference = await runWith()
    assert.equal(of(reference.events, 'decision').length, 0, 'off: no decision event')
    assert.equal('decisionCalls' in reference.result.usage, false, 'off: no new usage field')
    assert.equal(reference.agent.decisionModel, undefined)

    const { m, result, events } = await runWith({ decisionModel: { decide }, ...extra })
    assert.equal(count(m, 'replanner'), 3, 'the replanner ran at every round')
    assert.deepEqual(sent(m), sent(reference.m), 'the same model calls as without it')
    const decisions = of(events, 'decision')
    assert.equal(decisions.length, 3)
    assert.ok(decisions.every((d) => d.accepted === false && d.reason === reason))
    assert.ok(of(events, 'replan.decision').every((e) => e.confidence === undefined))
    assert.equal(result.trace.length, 3, 'the wrong "finish" ended nothing')
    assert.equal(result.usage.decisionCalls, 3, 'the attempts are still counted')
  })
}

test('decision: `decision.replan: false` asks nothing', async () => {
  const reference = await runWith()
  const model = scripted(() => ({ choice: 'finish', confidence: 1 }))
  const { m, result, events } = await runWith({ decisionModel: model, decision: { replan: false } })
  assert.equal(model.questions.length, 0)
  assert.deepEqual(sent(m), sent(reference.m))
  assert.equal(of(events, 'decision').length, 0)
  assert.equal(result.usage.decisionCalls, undefined)
})

test('decision replan: a message from the user is weighed by the replanner, not the decision model', async () => {
  const model = scripted(() => ({ choice: 'finish', confidence: 1 }))
  const m = script()
  const agent = await createAgent({ model: m.model, replanAfter: 'always', decisionModel: model })
  const control = createRunControl()
  control.send('Make it shorter')
  const events: AgentEvent[] = []
  await agent.run('Do three things', { control, onEvent: (e) => events.push(e) })
  const replans = of(events, 'replan.decision')
  // Round 1 was forced by the message: the replanner answered it ("continue"), although the
  // decision model would have said "finish" with full confidence.
  assert.equal(replans[0].byUser, true)
  assert.equal(replans[0].mode, 'continue')
  assert.equal(replans[0].confidence, undefined)
  assert.equal(count(m, 'replanner'), 1)
  // Round 2 is an ordinary one: the decision model is asked, and ends the plan.
  assert.equal(model.questions.length, 1)
  assert.equal(replans[1].mode, 'finish')
  assert.equal(replans[1].confidence, 1)
  assert.equal(count(m, 'executor'), 2)
})

// ── security: a decision is never a permission ───────────────────────────────

test('decision security: the decision model is not consulted for tool approval or egress', async () => {
  let wiped = 0
  let fetched = 0
  // Says yes to anything, with full confidence - and would say "approve" / "allow" if asked.
  const model = scripted((q) => ({
    choice: q.options.find((o) => /approve|allow|yes/i.test(o.id))?.id ?? q.options[0].id,
    confidence: 1,
  }))
  let executorCalls = 0
  const m = scriptedModel((info: CallInfo): Reply => {
    switch (stageOf(info)) {
      case 'planner':
        return {
          text: JSON.stringify({
            thought: 'Two steps.',
            steps: [{ description: 'Step one' }, { description: 'Step two' }],
          }),
        }
      case 'executor':
        if (info.toolResults > 0) return { text: 'done' }
        executorCalls += 1
        return executorCalls === 1
          ? { toolCalls: [{ name: 'wipe', args: {} }] }
          : { toolCalls: [{ name: 'web_fetch', args: { url: 'https://not-allowed.test/x' } }] }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'continue', reason: 'on track' }) }
      default:
        return { text: 'All done.' }
    }
  })
  const asked: string[] = []
  const agent = await createAgent({
    model: m.model,
    replanAfter: 'always',
    decisionModel: model,
    decision: { confidenceThreshold: 0 },
    tools: {
      wipe: defineTool({
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
      // The human refuses the write and lets the fetch through: the egress policy, not a
      // consent, is what must stop that one.
      onRequest: (req) => {
        asked.push(req.toolName)
        return req.toolName === 'wipe' ? { approved: false, reason: 'no' } : { approved: true }
      },
    },
    egress: {
      allow: ['allowed.test'],
      fetch: async () => {
        fetched += 1
        return new Response('secret')
      },
    },
  })
  const events: AgentEvent[] = []
  const result = await agent.run('Do two things', { onEvent: (e) => events.push(e) })

  // The gates did their work in code...
  assert.equal(wiped, 0, 'the denied tool never ran')
  assert.deepEqual(asked, ['wipe', 'web_fetch'], 'the human was asked, not the decision model')
  assert.equal(fetched, 0, 'the host outside the allow list was never requested')
  const egress = of(events, 'egress.request')
  assert.equal(egress.length, 1)
  assert.equal(egress[0].allowed, false)
  assert.ok(result.trace.flatMap((s) => s.toolCalls).every((c) => c.ok === false))
  // ...and the decision model, live and fully confident, was asked about the plan only.
  assert.ok(model.questions.length > 0, 'the decision model was in play')
  assert.deepEqual([...new Set(model.questions.map((q) => q.id))], ['replan'])
  assert.ok(of(events, 'decision').every((e) => e.point === 'replan'))
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

const isRouter = (info: CallInfo): boolean => info.system.includes('You are the Router')
const roleOf = (info: CallInfo): string =>
  /ROLE-(\w+)/.exec(info.system)?.[1].toLowerCase() ?? 'none'

// The router model always says "revise": a run that ends at the publisher was routed by the
// decision model.
const runPipeline = async (extra: Partial<BrowserAgentConfig>) => {
  const m = scriptedModel((info: CallInfo): Reply => {
    if (isRouter(info)) return { text: JSON.stringify({ route: 'revise' }) }
    const role = roleOf(info)
    switch (stageOf(info)) {
      case 'planner':
        return { text: JSON.stringify({ thought: 'ok', steps: [{ description: `${role} work` }] }) }
      case 'synthesizer':
        return { text: `${role} says done` }
      default:
        return { text: `${role} worked` }
    }
  })
  const pipeline = createPipeline(definition, {
    resolveNode: nodeResolver({ base: { model: m.model, ...extra } }),
  })
  const events: AgentEvent[] = []
  const result = await pipeline.run({ input: 'Check my text', onEvent: (e) => events.push(e) })
  return { m, events, result }
}

const callsOf = (usage: object): number | undefined =>
  (usage as { decisionCalls?: number }).decisionCalls

test('decision route: a confident label is the route, and the route call is not made', async () => {
  const model = scripted(() => ({
    choice: 'approve',
    confidence: 0.91,
    usage: { inputTokens: 80 },
  }))
  const { m, events, result } = await runPipeline({ decisionModel: model })
  assert.equal(m.calls.filter(isRouter).length, 0, 'no route call')
  assert.equal(result.text, 'publisher says done', 'the decision model picked the route')
  assert.deepEqual(result.outputs.reviewer, [
    { visit: 1, text: 'reviewer says done', route: 'approve' },
  ])
  assert.equal(model.questions.length, 1)
  assert.equal(model.questions[0].id, 'route')
  assert.deepEqual(model.questions[0].options, [
    { id: 'approve', description: 'good to publish' },
    { id: 'revise' },
  ])
  assert.match(model.questions[0].context ?? '', /reviewer says done/)

  const decisions = of(events, 'decision')
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].point, 'route')
  assert.equal(decisions[0].accepted, true)
  assert.equal(decisions[0].choice, 'approve')
  assert.equal(decisions[0].confidence, 0.91)
  assert.equal(decisions[0].nodeId, 'reviewer', 'the event names its node')
  // The engine's usage type names the token fields only; it sums every numeric field it is given.
  assert.equal(callsOf(result.usage), 1)
  assert.equal(result.usage.totalTokens, m.calls.length * 15 + 80)
})

const routeFallbacks: [string, IDecisionModel['decide'], string, Partial<BrowserAgentConfig>][] = [
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
    const { m, events, result } = await runPipeline({ decisionModel: { decide }, ...extra })
    assert.equal(m.calls.filter(isRouter).length, 1, 'the route call ran')
    assert.deepEqual(sent(m), sent(reference.m), 'the same model calls as without it')
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
  const { m, result } = await runPipeline({ decisionModel: model, decision: { route: false } })
  assert.equal(model.questions.length, 0)
  assert.equal(m.calls.filter(isRouter).length, 1)
  assert.equal(result.text, 'writer says done')
})

// ── a hosted decision API, called from the page ──────────────────────────────

interface DecisionsRequest {
  path: string
  method: string
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
  reply: (req: DecisionsRequest) => {
    status?: number
    headers?: Record<string, string>
    body?: unknown
  },
) => {
  const requests: DecisionsRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const seen: DecisionsRequest = {
        path: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        body: text.startsWith('{') ? JSON.parse(text) : {},
      }
      requests.push(seen)
      const { status = 200, headers = {}, body } = reply(seen)
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(body === undefined ? '' : JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
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

// Made up, and kept in a CredentialStore as a host's key would be.
const KEY = 'zq-decision-test-key-zq'
const REF = 'decision-key'
const vault = () => new MemoryCredentialStore({ [REF]: KEY })

const local = (baseURL: string, extra: Partial<IDecisionModelSpec> = {}): IDecisionModelSpec => ({
  providerType: 'google',
  model: 'gemini-decision-1',
  credentialRef: REF,
  baseURL,
  allowPrivateNetwork: true,
  ...extra,
})

const replanQuestion: IDecisionQuestion = {
  id: 'replan',
  prompt: 'What next?',
  options: [{ id: 'continue', description: 'carry on' }, { id: 'finish' }, { id: 'revise' }],
  context: 'the plan and the results',
}

test('decision spec: the documented request, with the key from the CredentialStore', async () => {
  const api = await startLocalDecisions(() => ({
    body: documentedAnswer({ continue: 0.9, finish: 0.06, revise: 0.04 }),
  }))
  try {
    const model = await resolveDecisionModel(local(api.baseURL), vault())
    assert.ok(model)
    assert.equal(model.name, 'google:gemini-decision-1')
    const outcome = await askDecisionModel(model, replanQuestion)
    assert.equal(outcome.accepted, true)
    assert.equal(outcome.choice, 'continue')
    assert.equal(outcome.confidence, 0.9, 'the probability of the option it chose')
    assert.deepEqual(outcome.usage, { inputTokens: 100, outputTokens: 0 })

    assert.equal(api.requests.length, 1)
    const req = api.requests[0]
    assert.equal(req.method, 'POST')
    assert.equal(req.path, '/v1beta/decisions')
    assert.equal(req.headers['x-goog-api-key'], KEY)
    assert.equal(req.headers.cookie, undefined)
    assert.equal(req.body.model, 'gemini-decision-1')
    assert.match(JSON.stringify(req.body.input), /the plan and the results/)
    assert.deepEqual(req.body.questions, {
      decision: {
        type: 'choice',
        instructions: 'What next?',
        criteria: { continue: 'carry on', finish: '', revise: '' },
      },
    })
    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(KEY))
  } finally {
    await api.close()
  }
})

test('decision spec: through the agent - the replanner is replaced, the key is in no event', async () => {
  const api = await startLocalDecisions(() => ({
    body: documentedAnswer({ continue: 0.95, finish: 0.03, revise: 0.02 }),
  }))
  try {
    const { m, agent, events, result } = await runWith({
      decisionModel: local(api.baseURL),
      credentials: vault(),
    })
    assert.equal(count(m, 'replanner'), 0)
    assert.equal(api.requests.length, 3)
    assert.equal(agent.decisionModel?.name, 'google:gemini-decision-1')
    assert.equal(result.usage.decisionCalls, 3)
    assert.equal(result.usage.totalTokens, m.calls.length * 15 + 300)
    assert.ok(of(events, 'decision').every((d) => d.accepted && d.confidence === 0.95))
    assert.doesNotMatch(JSON.stringify(events), new RegExp(KEY))
    assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY))
  } finally {
    await api.close()
  }
})

test('decision spec: the request can reach the API host and nothing else', async () => {
  assert.deepEqual(
    decisionEgressPolicy({
      providerType: 'google',
      model: 'gemini-decision-1',
      credentialRef: REF,
    }),
    {
      allow: ['generativelanguage.googleapis.com'],
      protocols: ['https'],
      ports: [443],
      methods: ['POST'],
      allowPrivateNetwork: false,
      followRedirects: false,
      maxResponseBytes: 1_000_000,
      timeoutMs: 15_000,
    },
  )

  // A redirect is never followed: the key is not carried to another host.
  const elsewhere = await startLocalDecisions(() => ({
    body: documentedAnswer({ continue: 1, finish: 0, revise: 0 }),
  }))
  const api = await startLocalDecisions(() => ({
    status: 307,
    headers: { location: `${elsewhere.baseURL}/decisions` },
  }))
  try {
    const model = await resolveDecisionModel(local(api.baseURL), vault())
    const outcome = await askDecisionModel(model as IDecisionModel, replanQuestion)
    assert.equal(outcome.accepted, false)
    assert.equal(outcome.reason, 'error')
    assert.equal(api.requests.length, 1)
    assert.equal(elsewhere.requests.length, 0, 'the redirect target was never requested')
    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(KEY))
  } finally {
    await api.close()
    await elsewhere.close()
  }

  // A loopback API is refused unless the host says so: nothing is sent.
  const guarded = await startLocalDecisions(() => ({
    body: documentedAnswer({ continue: 1, finish: 0, revise: 0 }),
  }))
  try {
    const model = await resolveDecisionModel(
      local(guarded.baseURL, { allowPrivateNetwork: false }),
      vault(),
    )
    const outcome = await askDecisionModel(model as IDecisionModel, replanQuestion)
    assert.equal(outcome.reason, 'error')
    assert.equal(guarded.requests.length, 0)
  } finally {
    await guarded.close()
  }
})

test('decision spec: an API error, a blocked request and an unknown option are fallbacks', async () => {
  const cases: [string, { status?: number; body: unknown }][] = [
    ['a 429', { status: 429, body: { error: { code: 429, message: 'quota' } } }],
    [
      'a safety block (documented: HTTP 400, no answers)',
      { status: 400, body: { error: { code: 'safety', message: 'Request blocked' } } },
    ],
    [
      'an option the question does not have',
      { body: documentedAnswer({ 'publish-anyway': 0.99, continue: 0.01 }) },
    ],
  ]
  for (const [name, reply] of cases) {
    const api = await startLocalDecisions(() => reply)
    try {
      const model = await resolveDecisionModel(local(api.baseURL), vault())
      const outcome = await askDecisionModel(model as IDecisionModel, replanQuestion)
      assert.equal(outcome.accepted, false, name)
      assert.equal(outcome.reason, 'error', name)
      assert.equal(api.requests.length, 1, `${name}: one request, no retry`)
      assert.doesNotMatch(JSON.stringify(outcome), new RegExp(KEY), 'the key is in no outcome')
    } finally {
      await api.close()
    }
  }
})

test('decision spec: the key is never in the config, and a spec that cannot work is refused early', async () => {
  const base = 'http://127.0.0.1:9/v1beta'
  const rejects = async (
    spec: unknown,
    credentials: MemoryCredentialStore | undefined,
    re: RegExp,
  ) => assert.rejects(resolveDecisionModel(spec as IDecisionModelSpec, credentials), re)

  await rejects({ ...local(base), apiKey: KEY }, vault(), /never written into the config/)
  await rejects(local(base), undefined, /no CredentialStore/)
  await rejects(local(base), new MemoryCredentialStore(), /no API key found/)
  await rejects(
    { providerType: 'google', model: 'gemini-decision-1' },
    vault(),
    /needs a credentialRef/,
  )
  await rejects({ ...local(base), providerType: 'typesafe' }, vault(), /unknown provider/)
  await rejects({ ...local(base), model: '' }, vault(), /`model` is required/)
  await rejects(local('ftp://example.com'), vault(), /http\(s\)/)
  await rejects(local('not a url'), vault(), /not a URL/)
  await rejects({ answer: 42 }, vault(), /expected an object with `decide`/)
  // createAgent refuses the same way, before any run.
  await assert.rejects(
    createAgent({
      model: script().model,
      decisionModel: { ...local(base), apiKey: KEY } as IDecisionModelSpec,
      credentials: vault(),
    }),
    /never written into the config/,
  )
  // Off, and a model of the host's own, pass through.
  assert.equal(await resolveDecisionModel(undefined, vault()), undefined)
  const mine: IDecisionModel = { decide: async () => ({ choice: 'a', confidence: 1 }) }
  assert.equal(await resolveDecisionModel(mine), mine)
})
