import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  createPipeline,
  nodeResolver,
  type AgentEvent,
  type IAgentConfig,
  type PipelineDefinition,
} from '../src/index.ts'
import {
  startLocalOpenAI,
  systemOf,
  userOf,
  type IChatRequest,
  type IScriptedReply,
} from './helpers/openai-server.ts'

// The adapter: pipeline nodes run by the real createAgent against the scripted OpenAI-compatible
// endpoint (see integration.test.ts). The graph engine itself is covered in pipeline.test.ts.

const here = (path: string): URL => new URL(path, import.meta.url)

test('pipeline: the engine is the same file in both packages, and so are its tests', (t) => {
  const sibling = here('../../agent-web/src/pipeline/engine.ts')
  if (!existsSync(sibling)) return t.skip('the browser sibling is not in this checkout')
  assert.equal(
    readFileSync(here('../src/pipeline-engine.ts'), 'utf8'),
    readFileSync(sibling, 'utf8'),
    'src/pipeline-engine.ts and agent-web/src/pipeline/engine.ts are a deliberate copy: change both',
  )
  // The tests differ only in where they import the package from.
  const body = (source: string): string => source.slice(source.indexOf('// The graph engine'))
  assert.equal(
    body(readFileSync(here('./pipeline.test.ts'), 'utf8')),
    body(readFileSync(here('../../agent-web/tests/pipeline.test.ts'), 'utf8')),
    'tests/pipeline.test.ts is the same in both packages below its imports',
  )
})

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

// One scripted answer per stage, per node (the node's instructions are in its system prompt).
const script =
  (route: string, delayMs = 0) =>
  (req: IChatRequest): IScriptedReply => {
    const system = systemOf(req)
    if (system.includes('You are the Router')) return { text: JSON.stringify({ route }) }
    const role = roleOf(req)
    if (system.includes('You are the Planner')) {
      return {
        delayMs,
        text: JSON.stringify({
          thought: 'One step.',
          steps: [{ id: 's1', description: `Do the ${role} work`, expectedOutcome: 'Done' }],
        }),
      }
    }
    if (system.includes('You are the Synthesizer')) return { text: `${role} says done` }
    return { text: `${role} worked` }
  }

const baseConfig = (baseURL: string): IAgentConfig => ({
  clientName: 'pipeline-test',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 3,
  maxStepsPerTask: 4,
  logLevel: 'none',
})

test('pipeline: two agents and a routed edge, through the real createAgent', async () => {
  const llm = await startLocalOpenAI(script('approve'))
  const pipeline = createPipeline(definition, {
    resolveNode: nodeResolver({ base: baseConfig(llm.baseURL) }),
  })
  try {
    const events: AgentEvent[] = []
    const result = await pipeline.run({ input: 'Check my text', onEvent: (e) => events.push(e) })

    assert.equal(result.text, 'publisher says done')
    assert.equal(result.runs, 2)
    assert.deepEqual(result.outputs.reviewer, [
      { visit: 1, text: 'reviewer says done', route: 'approve' },
    ])
    assert.equal(result.outputs.writer, undefined, 'the other route was not taken')

    // The route was picked by a call of its own, which saw the labels and the node's answer.
    const routerCalls = llm.requests.filter((r) => systemOf(r).includes('You are the Router'))
    assert.equal(routerCalls.length, 1, 'one route call: only the reviewer has routes')
    const routerPrompt = userOf(routerCalls[0])
    assert.match(routerPrompt, /- approve: good to publish/)
    assert.match(routerPrompt, /- revise/)
    assert.match(routerPrompt, /reviewer says done/)

    // The publisher was told the request and the reviewer's output, under its name.
    const publisherPlan = llm.requests.find(
      (r) => roleOf(r) === 'publisher' && systemOf(r).includes('You are the Planner'),
    )
    assert.ok(publisherPlan)
    assert.match(userOf(publisherPlan), /Check my text/)
    assert.match(userOf(publisherPlan), /Output of \\?"Reviewer\\?":\s*(\\n)?reviewer says done/)

    // Usage: every call of both agents, and the route call (10 in / 5 out each).
    assert.equal(result.usage.totalTokens, llm.requests.length * 15)

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
    assert.ok(
      inner.every((e) => typeof e.runId === 'string'),
      'and keeps its runId',
    )
    const finals = events.filter((e) => e.type === 'final')
    assert.deepEqual(
      finals.map((e) => e.nodeId),
      ['reviewer', 'publisher'],
    )
    const finished = events.find((e) => e.type === 'pipeline.node.finished')
    assert.ok(finished?.type === 'pipeline.node.finished')
    assert.equal(finished.route, 'approve')
  } finally {
    await pipeline.close()
    await llm.close()
  }
})

test('pipeline: an answer that is not a label is no route', async () => {
  const llm = await startLocalOpenAI(script('ship-it'))
  const pipeline = createPipeline(definition, {
    resolveNode: nodeResolver({ base: { ...baseConfig(llm.baseURL), llmMaxRetries: 0 } }),
  })
  try {
    const result = await pipeline.run({ input: 'Check my text' })
    assert.equal(result.runs, 1, 'no route edge fired')
    assert.deepEqual(result.outputs.reviewer, [{ visit: 1, text: 'reviewer says done' }])
    assert.equal(result.text, 'reviewer says done')
  } finally {
    await pipeline.close()
    await llm.close()
  }
})

test('pipeline: an aborted signal rejects with an AbortError, as agent.run does', async () => {
  const llm = await startLocalOpenAI(script('approve', 300))
  const pipeline = createPipeline(definition, {
    resolveNode: nodeResolver({ base: baseConfig(llm.baseURL) }),
  })
  try {
    const events: AgentEvent[] = []
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(
      pipeline.run({
        input: 'Check my text',
        signal: controller.signal,
        onEvent: (e) => events.push(e),
      }),
      { name: 'AbortError' },
    )
    assert.deepEqual(events.at(-1), { type: 'pipeline.finished', stoppedBy: 'aborted', runs: 1 })
    assert.ok(!events.some((e) => e.type === 'pipeline.node.failed'), 'an abort is not a failure')

    // Aborted before it starts: nothing runs.
    await assert.rejects(pipeline.run({ input: 'x', signal: AbortSignal.abort() }), {
      name: 'AbortError',
    })
  } finally {
    await pipeline.close()
    await llm.close()
  }
})

test('pipeline: a signal aborts a runNode pipeline too', async () => {
  const pipeline = createPipeline(
    { version: 1, entry: 'a', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },
    { runNode: () => new Promise((resolve) => setTimeout(() => resolve({ text: 'late' }), 200)) },
  )
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  const started = Date.now()
  await assert.rejects(pipeline.run({ input: 'x', signal: controller.signal }), {
    name: 'AbortError',
  })
  assert.ok(Date.now() - started < 150, 'the run did not wait for the node')
})

test('nodeResolver: names become config, an unknown name fails the node clearly', async () => {
  const base = { ...baseConfig('http://127.0.0.1:1/v1'), planner: { model: 'base-planner' } }
  const skill = { name: 'tone', description: 'House tone', content: 'Be brief.' }
  const tool = { description: 'noop', inputSchema: { type: 'object' } }
  const resolve = nodeResolver({
    base,
    models: { fast: { model: 'small', baseURL: 'http://127.0.0.1:2/v1' } },
    skills: { tone: skill },
    tools: { files: { read_file: tool as never } },
    mcpServers: { docs: { url: 'http://127.0.0.1:3/mcp' } },
    configure: (config, node) => ({
      ...config,
      maxIterations: typeof node.settings?.maxIterations === 'number' ? 1 : config.maxIterations,
    }),
  })

  const plain = await resolve({ id: 'plain', settings: { toolApproval: { mode: 'autopilot' } } })
  assert.equal(plain.model, 'scripted')
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
  assert.equal(full.model, 'small')
  assert.equal(full.baseURL, 'http://127.0.0.1:2/v1')
  assert.equal(full.planner, undefined, "the base's planner override belonged to the base model")
  assert.deepEqual(full.skills, [skill])
  assert.deepEqual(Object.keys(full.tools ?? {}), ['read_file'])
  assert.deepEqual(full.mcpServers, { docs: { url: 'http://127.0.0.1:3/mcp' } })
  assert.equal(full.maxIterations, 1, 'configure read node.settings')
  assert.deepEqual(base.mcpServers, {}, 'the base is not mutated')

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

test('pipeline: a node whose name is not registered fails the run', async () => {
  const pipeline = createPipeline(
    { version: 1, entry: 'a', nodes: [{ id: 'a', model: 'secret-model' }], edges: [] },
    { resolveNode: nodeResolver({ base: baseConfig('http://127.0.0.1:1/v1') }) },
  )
  await assert.rejects(pipeline.run({ input: 'x' }), /node "a" failed.*unknown model/)
})
