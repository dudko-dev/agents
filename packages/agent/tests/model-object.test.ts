import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { trace, type Span, type Tracer } from '@opentelemetry/api'
import {
  createAgent,
  createPipeline,
  createSubagentTool,
  nodeResolver,
  type AgentEvent,
  type AgentModel,
  type IAgentConfig,
  type PipelineDefinition,
} from '../src/index.ts'
import {
  collect,
  config,
  linearScript,
  ofType,
  planJson,
  stageOf,
  stepOf,
  withLlm,
} from './helpers/loop.ts'
import {
  startLocalOpenAI,
  systemOf,
  type IChatRequest,
  type Script,
} from './helpers/openai-server.ts'

// A ready AI SDK model object as the model (`config.model`, a stage, a tier): used as it is, no
// provider package imported for it, no providerType or apiKey needed. The objects here are the
// real openai-compatible provider pointed at the scripted endpoint, so every request is on the
// wire, under the model id it was given.

const modelAt = (baseURL: string, id: string): AgentModel =>
  createOpenAICompatible({ name: 'objects', baseURL })(id)

// A config with nothing but a model object.
const bare = (model: AgentModel, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'model-object-test',
  model,
  mcpServers: {},
  maxIterations: 6,
  maxStepsPerTask: 6,
  logLevel: 'none',
  ...extra,
})

// `<stage>:<model id>` of every request, once each, sorted.
const routes = (requests: IChatRequest[]): string[] =>
  [...new Set(requests.map((r) => `${stageOf(r)}:${r.model}`))].sort()

// ── a recording tracer: the span attributes the agent sets ──────────────────

const spans: { name: string; attrs: Record<string, unknown> }[] = []
const recordingSpan = (name: string): Span => {
  const record = { name, attrs: {} as Record<string, unknown> }
  spans.push(record)
  const span = {
    spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }),
    setAttribute: (key: string, value: unknown) => ((record.attrs[key] = value), span),
    setAttributes: (attrs: Record<string, unknown>) => (Object.assign(record.attrs, attrs), span),
    addEvent: () => span,
    addLink: () => span,
    addLinks: () => span,
    setStatus: () => span,
    updateName: () => span,
    end: () => undefined,
    isRecording: () => true,
    recordException: () => undefined,
  }
  return span as unknown as Span
}
trace.setGlobalTracerProvider({
  getTracer: () =>
    ({
      startSpan: (name: string) => recordingSpan(name),
      startActiveSpan: (name: string, ...rest: unknown[]) =>
        (rest.at(-1) as (span: Span) => unknown)(recordingSpan(name)),
    }) as unknown as Tracer,
})

// ── a whole run ──────────────────────────────────────────────────────────

test('a model object alone runs the whole loop: no providerType, no apiKey', async () => {
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    const agent = await open(bare(modelAt(llm.baseURL, 'obj-model'), { replanAfter: 'always' }))
    const result = await agent.run({ input: 'go' })
    assert.equal(result.text, 'All done.')
    assert.deepEqual(routes(llm.requests), [
      'executor:obj-model',
      'planner:obj-model',
      'replanner:obj-model',
      'synthesizer:obj-model',
    ])
  })
})

test('per stage: planner and synthesizer objects, a string executor - each stage on its own model', async () => {
  const objects = await startLocalOpenAI(linearScript(['s1', 's2']))
  try {
    await withLlm(linearScript(['s1', 's2']), async ({ llm: ids, open }) => {
      const agent = await open(
        config(ids.baseURL, {
          model: 'exec-id',
          planner: modelAt(objects.baseURL, 'planner-obj'),
          synthesizer: modelAt(objects.baseURL, 'synth-obj'),
          replanAfter: 'always',
        }),
      )
      assert.equal((await agent.run({ input: 'go' })).text, 'All done.')
      // The string stage went the provider way, to its endpoint; the objects to theirs.
      assert.deepEqual(routes(ids.requests), ['executor:exec-id'])
      assert.deepEqual(routes(objects.requests), [
        'planner:planner-obj',
        'replanner:planner-obj',
        'synthesizer:synth-obj',
      ])
    })
  } finally {
    await objects.close()
  }
})

test('over a top-level object: a block with a model id and a providerType goes the provider way, a block that names nothing keeps the object', async () => {
  const objects = await startLocalOpenAI(linearScript(['s1', 's2']))
  try {
    await withLlm(linearScript(['s1', 's2']), async ({ llm: ids, open }) => {
      const agent = await open(
        bare(modelAt(objects.baseURL, 'top-obj'), {
          // No apiKey here or at the top: there is no key to inherit, the SDK's own fallback
          // applies (the scripted endpoint asks for none).
          planner: { providerType: 'openai-compatible', baseURL: ids.baseURL, model: 'planner-id' },
          synthesizer: {},
          executorTiers: { standard: {} },
          replanAfter: 'always',
        }),
      )
      assert.equal((await agent.run({ input: 'go' })).text, 'All done.')
      assert.deepEqual(routes(ids.requests), ['planner:planner-id', 'replanner:planner-id'])
      assert.deepEqual(routes(objects.requests), ['executor:top-obj', 'synthesizer:top-obj'])
    })
  } finally {
    await objects.close()
  }
})

// ── the guards: a model id needs a providerType ──────────────────────────

test('a model id with no providerType anywhere is refused at createAgent, naming the block', async () => {
  const llm = await startLocalOpenAI(linearScript(['s1']))
  try {
    const top = modelAt(llm.baseURL, 'top-obj')
    const object = '; the top-level model is a model object'
    const cases: [Partial<IAgentConfig>, string][] = [
      [
        { planner: { model: 'x' } },
        `planner: model "x" is a model id, so a providerType is needed (set planner.providerType or the top-level providerType${object})`,
      ],
      [
        { synthesizer: { model: 'y', apiKey: 'k' } },
        `synthesizer: model "y" is a model id, so a providerType is needed (set synthesizer.providerType or the top-level providerType${object})`,
      ],
      // The deprecated shortcuts are `{ model }` blocks.
      [{ plannerModel: 'x' }, `planner: model "x" is a model id`],
      [{ synthesizerModel: 'y' }, `synthesizer: model "y" is a model id`],
      [{ executorTiers: { standard: { model: 'std' } } }, `executor: model "std" is a model id`],
      [{ executorTiers: { light: { model: 'small' } } }, `executorTiers.light: model "small" is`],
      // A provider field and no model id: nothing to build, and the object is not the block's.
      [
        { synthesizer: { apiKey: 'k' } },
        'synthesizer: sets a provider but no model id, and the top-level model is a model object - set synthesizer.model, or give the stage a model object',
      ],
      [{ planner: { providerType: 'openai' } }, 'planner: sets a provider but no model id'],
      [{ planner: { providerOptions: { a: 1 } } }, 'planner: sets a provider but no model id'],
      [{ planner: { baseURL: 'http://x' } }, 'planner: sets a provider but no model id'],
    ]
    for (const [extra, message] of cases) {
      const events: AgentEvent[] = []
      await assert.rejects(
        createAgent(bare(top, extra), (e) => events.push(e)),
        (err: Error) => err.message.startsWith(message),
        JSON.stringify(extra),
      )
      assert.ok(
        events.some((e) => e.type === 'error' && e.phase === 'init'),
        'the error event of phase init',
      )
    }
    // A string model without a providerType: the same rule, with no word about an object.
    await assert.rejects(createAgent({ ...bare(top), model: 'plain' }), {
      message:
        'executor: model "plain" is a model id, so a providerType is needed (set executor.providerType or the top-level providerType)',
    })
    assert.equal(llm.requests.length, 0, 'nothing was sent')
  } finally {
    await llm.close()
  }
})

test('cross-provider rule over a top-level object: a top-level key belongs to no provider, so a stage that names one brings its own', async () => {
  const top = modelAt('http://127.0.0.1:1/v1', 'top-obj')
  const planner = {
    providerType: 'openai-compatible' as const,
    baseURL: 'http://127.0.0.1:1/v1',
    model: 'p',
  }
  await assert.rejects(createAgent(bare(top, { apiKey: 'top-key', planner })), {
    message:
      'planner: providerType "openai-compatible" differs from the default "none" - you must also set planner.apiKey (cross-provider key inheritance is unsafe)',
  })
  // With its own key it builds (nothing is sent before a run); with no top-level key there is
  // nothing to inherit (the run above).
  for (const extra of [
    { apiKey: 'top-key', planner: { ...planner, apiKey: 'own' } },
    { planner },
  ] as Partial<IAgentConfig>[]) {
    await (await createAgent(bare(top, extra))).close()
  }
})

test('media: a stage block over a top-level model object needs a providerType, named by its field', async () => {
  const top = modelAt('http://127.0.0.1:1/v1', 'top-obj')
  await assert.rejects(createAgent(bare(top, { media: { imageModel: { model: 'img-1' } } })), {
    message:
      'media.imageModel: model "img-1" is a model id, so a providerType is needed (set media.imageModel.providerType or the top-level providerType; the top-level model is a model object)',
  })
})

// ── tiers ────────────────────────────────────────────────────────────────

test('tiers: model objects (and a block) as tiers, each named in the events by its model id', async () => {
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return {
          text: planJson([
            { id: 's1', complexity: 'low' },
            { id: 's2', complexity: 'medium' },
            { id: 's3', complexity: 'high' },
          ]),
        }
      case 'executor':
        return { text: `did ${stepOf(req)}` }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'on track' }) }
      default:
        return { text: 'All done.' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const at = (id: string) => modelAt(llm.baseURL, id)
    const agent = await open(
      bare(at('std-obj'), {
        executorTiers: {
          light: at('light-obj'),
          strong: { providerType: 'openai-compatible', baseURL: llm.baseURL, model: 'strong-id' },
        },
        escalation: false,
      }),
    )
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'go', onEvent })
    assert.deepEqual(
      ofType(events, 'step.start').map((e) => [e.tier, e.model]),
      [
        ['light', 'light-obj'],
        ['standard', 'std-obj'],
        ['strong', 'strong-id'],
      ],
    )
    assert.deepEqual(
      result.trace.map((r) => r.model),
      ['light-obj', 'std-obj', 'strong-id'],
    )
    assert.deepEqual(
      llm.requests.filter((r) => stageOf(r) === 'executor').map((r) => `${stepOf(r)}:${r.model}`),
      ['s1:light-obj', 's2:std-obj', 's3:strong-id'],
    )
  })
})

// ── subagents ────────────────────────────────────────────────────────────

// A model whose methods all sit on its prototype: a structured clone copies its fields and drops
// them - it would cross into a worker and fail there, at its first call.
class PrototypeModel {
  readonly specificationVersion = 'v3'
  readonly provider = 'prototype'
  readonly modelId = 'prototype-model'
  readonly supportedUrls = {}
  async doGenerate(): Promise<never> {
    throw new Error('not here')
  }
  async doStream(): Promise<never> {
    throw new Error('not here')
  }
}

const childConfig = (extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'child',
  providerType: 'openai',
  apiKey: 'k',
  model: 'm',
  mcpServers: {},
  maxIterations: 1,
  maxStepsPerTask: 1,
  logLevel: 'none',
  ...extra,
})

test('worker isolation refuses a model object when the tool is created, naming the field', () => {
  const real = modelAt('http://127.0.0.1:1/v1', 'real-obj')
  const plain = new PrototypeModel() as unknown as AgentModel
  // The guard is not the function walk: this one has no function of its own and clones cleanly.
  assert.equal(structuredClone(plain).modelId, 'prototype-model')
  const refusal = (path: string) =>
    `subagent "w": ${path} is a model object, which cannot cross into a worker thread; use isolation 'in-process', or a provider config (providerType + a model id)`
  const cases: [Partial<IAgentConfig>, string][] = [
    [{ model: real }, 'config.model'],
    [{ model: plain }, 'config.model'],
    [{ planner: plain }, 'config.planner'],
    [{ synthesizer: real }, 'config.synthesizer'],
    [{ executorTiers: { strong: plain } }, 'config.executorTiers.strong'],
    [{ media: { imageModel: plain as never } }, 'config.media.imageModel'],
  ]
  for (const [extra, path] of cases) {
    for (const isolation of [undefined, 'worker'] as const) {
      assert.throws(
        () =>
          createSubagentTool({
            name: 'w',
            description: 'd',
            ...(isolation ? { isolation } : {}),
            config: childConfig(extra),
          }),
        { message: refusal(path) },
      )
    }
  }
  assert.throws(
    () =>
      createSubagentTool({
        name: 'w',
        description: 'd',
        config: childConfig(),
        profiles: { cheap: { description: 'cheap', config: { model: plain } } },
      }),
    { message: refusal('profile "cheap" config.model') },
  )
  // In-process takes it.
  assert.doesNotThrow(() =>
    createSubagentTool({
      name: 'i',
      description: 'd',
      isolation: 'in-process',
      config: childConfig({ model: plain, planner: real }),
      profiles: { cheap: { description: 'cheap', config: { model: real } } },
    }),
  )
})

test('an in-process subagent runs on a model object', async () => {
  const script: Script = (req) =>
    stageOf(req) === 'planner'
      ? { text: planJson([{ id: 'c1' }]) }
      : stageOf(req) === 'executor'
        ? { text: 'worked' }
        : { text: `answer from ${req.model}` }
  await withLlm(script, async ({ llm }) => {
    const helper = createSubagentTool({
      name: 'helper',
      description: 'Help',
      isolation: 'in-process',
      config: bare(modelAt(llm.baseURL, 'child-obj')),
    })
    const output = await (
      helper as unknown as {
        execute: (input: unknown, options: unknown) => Promise<unknown>
      }
    ).execute({ task: 'one' }, { toolCallId: 't', messages: [] })
    assert.equal(output, 'answer from child-obj')
    assert.deepEqual([...new Set(llm.requests.map((r) => r.model))], ['child-obj'])
  })
})

// ── pipelines ────────────────────────────────────────────────────────────

test('pipeline: a registry entry that is a model object runs its node and the route call', async () => {
  const roleOf = (req: IChatRequest): string =>
    /ROLE-(\w+)/.exec(systemOf(req))?.[1].toLowerCase() ?? 'none'
  const script: Script = (req) => {
    const stage = stageOf(req)
    if (stage === 'route') return { text: JSON.stringify({ route: 'approve' }) }
    if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
    if (stage === 'synthesizer') return { text: `${roleOf(req)} says done` }
    if (stage === 'replanner') return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }) }
    return { text: `${roleOf(req)} worked` }
  }
  const definition: PipelineDefinition = {
    version: 1,
    name: 'objects',
    entry: 'reviewer',
    nodes: [
      {
        id: 'reviewer',
        instructions: 'ROLE-REVIEWER: judge the text.',
        model: 'cheap',
        routes: [{ label: 'approve' }, { label: 'revise' }],
      },
      { id: 'publisher', instructions: 'ROLE-PUBLISHER: publish the text.' },
      { id: 'writer', instructions: 'ROLE-WRITER: rewrite the text.' },
    ],
    edges: [
      { id: 'ok', from: 'reviewer', to: 'publisher', when: { kind: 'route', label: 'approve' } },
      { id: 'redo', from: 'reviewer', to: 'writer', when: { kind: 'route', label: 'revise' } },
    ],
  }
  await withLlm(script, async ({ llm }) => {
    const pipeline = createPipeline(definition, {
      resolveNode: nodeResolver({
        // A string base (provider fields and all) and an object in the registry.
        base: config(llm.baseURL, { model: 'base-id', maxIterations: 3 }),
        models: { cheap: { model: modelAt(llm.baseURL, 'cheap-obj') } },
      }),
    })
    try {
      const result = await pipeline.run({ input: 'Check my text' })
      assert.equal(result.text, 'publisher says done')
      const modelsOf = (pick: (r: IChatRequest) => boolean) => [
        ...new Set(llm.requests.filter(pick).map((r) => r.model)),
      ]
      assert.deepEqual(
        modelsOf((r) => stageOf(r) === 'route'),
        ['cheap-obj'],
      )
      assert.deepEqual(
        modelsOf((r) => roleOf(r) === 'reviewer'),
        ['cheap-obj'],
      )
      assert.deepEqual(
        modelsOf((r) => roleOf(r) === 'publisher'),
        ['base-id'],
      )
    } finally {
      await pipeline.close()
    }
  })
})

// ── telemetry ────────────────────────────────────────────────────────────

test("telemetry: a model object's run span names its provider and model id; a string config is unchanged", async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const model = modelAt(llm.baseURL, 'obj-model')
    spans.length = 0
    await (await open(bare(model))).run({ input: 'go' })
    await (await open(config(llm.baseURL))).run({ input: 'go' })
    const runs = spans.filter((s) => s.name === 'agent.run')
    assert.equal(runs.length, 2)
    assert.equal(runs[0].attrs['agent.provider'], model.provider)
    assert.equal(runs[0].attrs['agent.provider'], 'objects.chat')
    assert.equal(runs[0].attrs['agent.model'], 'obj-model')
    assert.equal(runs[1].attrs['agent.provider'], 'openai-compatible')
    assert.equal(runs[1].attrs['agent.model'], 'scripted')
  })
})
