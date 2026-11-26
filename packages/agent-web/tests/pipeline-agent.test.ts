import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPipeline,
  defineSkill,
  MemoryStore,
  nodeResolver,
  PipelineNodeError,
  type AgentEvent,
  type PipelineDefinition,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// The adapter: pipeline nodes run by the real createAgent over a scripted model. The graph engine
// itself is covered in pipeline.test.ts (the same file as the Node sibling's, which also checks
// that the two copies of the engine are identical).

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

// One scripted answer per stage, per node (the node's instructions are in its system prompt).
const script =
  (routeAnswer: string) =>
  (info: CallInfo): Reply => {
    if (isRouter(info)) return { text: routeAnswer }
    const role = roleOf(info)
    switch (stageOf(info)) {
      case 'planner':
        return { text: JSON.stringify({ thought: 'ok', steps: [{ description: `${role} work` }] }) }
      case 'synthesizer':
        return { text: `${role} says done` }
      default:
        return { text: `${role} worked` }
    }
  }

test('pipeline: two agents and a routed edge, through the real createAgent', async () => {
  const m = scriptedModel(script(JSON.stringify({ route: 'approve' })))
  const pipeline = createPipeline(definition, {
    resolveNode: nodeResolver({ base: { model: m.model } }),
  })
  const events: AgentEvent[] = []
  const result = await pipeline.run({ input: 'Check my text', onEvent: (e) => events.push(e) })

  assert.equal(result.text, 'publisher says done')
  assert.equal(result.runs, 2)
  assert.deepEqual(result.outputs.reviewer, [
    { visit: 1, text: 'reviewer says done', route: 'approve' },
  ])
  assert.equal(result.outputs.writer, undefined, 'the other route was not taken')

  // The route was picked by a call of its own, which saw the labels and the node's answer.
  const routerCalls = m.calls.filter(isRouter)
  assert.equal(routerCalls.length, 1, 'one route call: only the reviewer has routes')
  assert.match(routerCalls[0].user, /- approve: good to publish/)
  assert.match(routerCalls[0].user, /- revise/)
  assert.match(routerCalls[0].user, /reviewer says done/)
  assert.ok(routerCalls[0].options.responseFormat, 'a structured-output call')

  // The publisher was told the request and the reviewer's output, under its name.
  const publisherPlan = m.calls.find((c) => roleOf(c) === 'publisher' && stageOf(c) === 'planner')
  assert.ok(publisherPlan)
  assert.match(publisherPlan.user, /Check my text/)
  assert.match(publisherPlan.user, /Output of "Reviewer":\nreviewer says done/)

  // Usage: every call of both agents, and the route call (10 in / 5 out each).
  assert.equal(result.usage.totalTokens, m.calls.length * 15)

  // Events: the pipeline's own, and the agents' tagged with the node.
  const types = events.map((e) => e.type)
  assert.equal(types[0], 'pipeline.started')
  assert.equal(types.at(-1), 'pipeline.finished')
  assert.deepEqual(
    events.filter((e) => e.type === 'pipeline.edge'),
    [
      {
        type: 'pipeline.edge',
        from: 'reviewer',
        to: 'publisher',
        edgeId: 'ok',
        visit: 1,
        fired: true,
      },
      {
        type: 'pipeline.edge',
        from: 'reviewer',
        to: 'writer',
        edgeId: 'redo',
        visit: 1,
        fired: false,
      },
    ],
  )
  const inner = events.filter((e) => !e.type.startsWith('pipeline.'))
  assert.ok(inner.length > 0, 'the agents events were forwarded')
  assert.ok(
    inner.every((e) => (e.nodeId === 'reviewer' || e.nodeId === 'publisher') && e.visit === 1),
    'every forwarded event names its node and visit',
  )
  assert.deepEqual(
    events.filter((e) => e.type === 'final').map((e) => e.nodeId),
    ['reviewer', 'publisher'],
  )
  const finished = events.find((e) => e.type === 'pipeline.node.finished')
  assert.ok(finished?.type === 'pipeline.node.finished')
  assert.equal(finished.route, 'approve')
  await pipeline.close()
})

test('pipeline: an answer that is not a label is no route', async () => {
  const m = scriptedModel(script(JSON.stringify({ route: 'ship-it' })))
  const pipeline = createPipeline(definition, {
    resolveNode: nodeResolver({ base: { model: m.model } }),
  })
  const result = await pipeline.run({ input: 'Check my text' })
  assert.equal(result.runs, 1, 'no route edge fired')
  assert.deepEqual(result.outputs.reviewer, [{ visit: 1, text: 'reviewer says done' }])
  // Structured output refused the answer, then the plain-text fallback could not use it either.
  assert.equal(m.calls.filter(isRouter).length, 2)
  assert.equal(result.usage.totalTokens, m.calls.length * 15, 'the failed attempt still counts')
})

test('pipeline: a model without structured output can still pick a route in plain text', async () => {
  const m = scriptedModel(script('Revise.'))
  const pipeline = createPipeline(definition, {
    resolveNode: nodeResolver({ base: { model: m.model } }),
  })
  const result = await pipeline.run({ input: 'Check my text' })
  assert.equal(result.outputs.reviewer[0].route, 'revise')
  assert.equal(result.text, 'writer says done')
})

test('pipeline: an aborted signal resolves with stoppedBy "aborted", as agent.run stops', async () => {
  const m = scriptedModel(script(JSON.stringify({ route: 'approve' })))
  const pipeline = createPipeline(definition, {
    resolveNode: nodeResolver({ base: { model: m.model } }),
  })
  const controller = new AbortController()
  const events: AgentEvent[] = []
  const result = await pipeline.run({
    input: 'Check my text',
    signal: controller.signal,
    onEvent: (e) => {
      events.push(e)
      if (e.type === 'step.start') controller.abort()
    },
  })
  assert.equal(result.stoppedBy, 'aborted')
  assert.equal(result.runs, 1)
  assert.deepEqual(result.outputs, {})
  assert.deepEqual(events.at(-1), { type: 'pipeline.finished', stoppedBy: 'aborted', runs: 1 })
  assert.ok(!events.some((e) => e.type === 'pipeline.node.failed'), 'an abort is not a failure')

  // Aborted before it starts: nothing runs.
  const never = await pipeline.run({ input: 'x', signal: AbortSignal.abort() })
  assert.equal(never.stoppedBy, 'aborted')
  assert.equal(never.runs, 0)
})

test('pipeline: a signal aborts a runNode pipeline too', async () => {
  const pipeline = createPipeline(
    { version: 1, entry: 'a', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },
    { runNode: () => new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 200)) },
  )
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  const started = Date.now()
  const result = await pipeline.run({ input: 'x', signal: controller.signal })
  assert.equal(result.stoppedBy, 'aborted')
  assert.ok(Date.now() - started < 150, 'the run did not wait for the node')
})

test('pipeline: an agent run that fails is a failed node, not an answer', async () => {
  const m = scriptedModel(() => {
    throw new Error('model unavailable')
  })
  const pipeline = createPipeline(definition, {
    resolveNode: nodeResolver({ base: { model: m.model, replan: false } }),
  })
  const events: AgentEvent[] = []
  await assert.rejects(
    pipeline.run({ input: 'Check my text', onEvent: (e) => events.push(e) }),
    (err: unknown) => err instanceof PipelineNodeError && err.nodeId === 'reviewer',
  )
  assert.equal(events.at(-1)?.type, 'pipeline.node.failed')
})

test('nodeResolver: names become config, an unknown name fails the node clearly', async () => {
  const baseModel = scriptedModel(() => ({ text: '' })).model
  const fast = scriptedModel(() => ({ text: '' })).model
  const skill = defineSkill({ name: 'tone', description: 'House tone', content: 'Be brief.' })
  const tool = { description: 'noop', inputSchema: { type: 'object' } } as never
  const base = { model: baseModel, planner: { model: 'base-planner' }, tools: { own: tool } }
  const resolve = nodeResolver({
    base,
    models: { fast },
    skills: { tone: skill },
    tools: { files: { read_file: tool } },
    mcpServers: { docs: { tools: { docs__search: tool } } },
    configure: (config, node) => ({
      ...config,
      maxIterations: typeof node.settings?.maxIterations === 'number' ? 1 : config.maxIterations,
    }),
  })

  const plain = await resolve({ id: 'plain', settings: { toolApproval: { mode: 'autopilot' } } })
  assert.equal(plain.model, baseModel)
  assert.deepEqual(plain.planner, { model: 'base-planner' })
  assert.equal(plain.toolApproval, undefined, 'settings are never applied by themselves')

  const full = await resolve({
    id: 'full',
    model: 'fast',
    skills: ['tone'],
    tools: ['files'],
    mcpServers: ['docs'],
    settings: { maxIterations: 1 },
  })
  assert.equal(full.model, fast)
  assert.equal(full.planner, undefined, "the base's planner override belonged to the base model")
  assert.deepEqual(full.skills, [skill])
  assert.deepEqual(Object.keys(full.tools ?? {}), ['own', 'read_file', 'docs__search'])
  assert.equal(full.maxIterations, 1, 'configure read node.settings')
  assert.deepEqual(Object.keys(base.tools), ['own'], 'the base is not mutated')

  await assert.rejects(
    async () => resolve({ id: 'n1', model: 'huge' }),
    /node "n1": unknown model "huge" \(registered: fast\)/,
  )
  await assert.rejects(async () => resolve({ id: 'n2', skills: ['nope'] }), /unknown skill "nope"/)
  await assert.rejects(async () => resolve({ id: 'n3', tools: ['shell'] }), /unknown tool group/)
  await assert.rejects(
    async () => resolve({ id: 'n4', mcpServers: ['constructor'] }),
    /unknown MCP server "constructor"/,
  )
  await assert.rejects(
    async () => nodeResolver({ base })({ id: 'n5', model: 'x' }),
    /registered: none/,
  )
})

test('pipeline: with memory, every node keeps a conversation of its own', async () => {
  const m = scriptedModel(script('x'))
  const memory = new MemoryStore()
  const loop: PipelineDefinition = {
    version: 1,
    entry: 'writer',
    nodes: [
      { id: 'writer', instructions: 'ROLE-WRITER' },
      { id: 'reviewer', instructions: 'ROLE-REVIEWER' },
      { id: 'pinned', instructions: 'ROLE-PINNED', settings: { session: 'mine' } },
    ],
    edges: [
      { from: 'writer', to: 'reviewer' },
      { from: 'reviewer', to: 'writer' },
      { from: 'writer', to: 'pinned' },
    ],
    limits: { maxNodeVisits: 2 },
  }
  const pipeline = createPipeline(loop, {
    resolveNode: nodeResolver({
      base: { model: m.model, memory, sessionId: 'chat' },
      configure: (config, node) =>
        typeof node.settings?.session === 'string'
          ? { ...config, sessionId: node.settings.session }
          : config,
    }),
  })
  await pipeline.run({ input: 'Write it' })

  const said = async (sessionId: string): Promise<string[]> =>
    (await memory.load(sessionId)).filter((x) => x.role === 'assistant').map((x) => x.content)
  assert.deepEqual(await said('chat:writer'), ['writer says done', 'writer says done'])
  assert.deepEqual(await said('chat:reviewer'), ['reviewer says done', 'reviewer says done'])
  assert.deepEqual(await memory.load('chat'), [], "nothing went into the base's own session")
  assert.deepEqual(await said('mine'), ['pinned says done'], 'a session set in configure is kept')
  assert.deepEqual(await memory.load('chat:pinned'), [])

  // Without a base sessionId the agent's default one is the prefix.
  const plain = await nodeResolver({ base: { model: m.model, memory } })({ id: 'a' })
  assert.equal(plain.sessionId, 'default:a')
  // Without memory there is nothing to keep apart.
  const none = await nodeResolver({ base: { model: m.model, sessionId: 'chat' } })({ id: 'a' })
  assert.equal(none.sessionId, 'chat')
})

test('pipeline: a node whose name is not registered fails the run', async () => {
  const pipeline = createPipeline(
    { version: 1, entry: 'a', nodes: [{ id: 'a', model: 'secret-model' }], edges: [] },
    { resolveNode: nodeResolver({ base: { model: scriptedModel(() => ({ text: '' })).model } }) },
  )
  await assert.rejects(pipeline.run({ input: 'x' }), /node "a" failed.*unknown model/)
})
