import assert from 'node:assert/strict'
import test from 'node:test'
import type { LanguageModel } from 'ai'
import {
  createPipeline,
  createSubagentTool,
  ModelCallRefusedError,
  type IAgentConfig,
  type IModelCall,
  type IPersistence,
  type ISharedLimits,
  type IUsage,
  type PipelineDefinition,
} from '../src/index.ts'
import { limitedModel } from '../src/shared-limits.ts'
import { withRetry } from '../src/utils.ts'
import { isEscalatableError } from '../src/tiers.ts'
import {
  hasToolResult,
  startLocalOpenAI,
  systemOf,
  toolResults,
  userOf,
  type IChatRequest,
  type Script,
} from './helpers/openai-server.ts'
import {
  collect,
  config,
  linearScript,
  ofType,
  planJson,
  stageOf,
  stepOf,
  until,
  withLlm,
  within,
} from './helpers/loop.ts'

// config.sharedLimits: beforeModelCall is asked before EVERY language-model call - the four
// stages, compaction, a pipeline's route call, helpers, subagents (in-process and in a worker),
// escalated tiers - and afterModelCall is told what each used. The proof that nothing is missed
// is the scripted endpoint's own log: every request it saw was asked about once, under the stage
// it was for.

interface IRecorder extends ISharedLimits {
  before: IModelCall[]
  after: { call: IModelCall; usage: IUsage; ok: boolean }[]
}

const recorder = (
  decide: (call: IModelCall) => void | Promise<void> = () => {},
  afterHook?: (call: IModelCall) => void,
): IRecorder => {
  const before: IModelCall[] = []
  const after: IRecorder['after'] = []
  return {
    before,
    after,
    beforeModelCall: (call) => {
      before.push(call)
      return decide(call)
    },
    afterModelCall: (call, usage, outcome) => {
      after.push({ call, usage, ok: outcome.ok })
      afterHook?.(call)
    },
  }
}

// The stage the hook is told, for what the endpoint saw.
const hookStageOf = (req: IChatRequest): string => {
  const stage = stageOf(req)
  return stage === 'compact-history' || stage === 'compact-trace' ? 'compaction' : stage
}

const countBy = <T>(items: T[], key: (item: T) => string): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1
  return out
}

const refuse = (stage: string) => (call: IModelCall) => {
  if (call.stage === stage) {
    // A refusal that LOOKS retryable (a 429 cause): it must still never be retried.
    throw Object.assign(new Error(`budget spent for ${call.runId}`), { status: 429 })
  }
}

// ── coverage: every call, every stage ───────────────────────────────────────

test('sharedLimits: asked once for every language-model call of every stage - helpers, subagents (in-process and worker), escalation, compaction', async () => {
  const script: Script = (req) => {
    const stage = stageOf(req)
    const user = userOf(req)
    const system = systemOf(req)
    if (stage === 'compact-history') return { text: 'HISTORY-SUMMARY' }
    if (stage === 'compact-trace') return { text: 'TRACE-SUMMARY' }
    const sub =
      user.includes('HELPER TASK') ||
      system.includes('CHILD AGENT') ||
      system.includes('WORKER AGENT')
    if (sub) {
      if (stage === 'planner') return { text: planJson([{ id: 'c1' }]) }
      if (stage === 'synthesizer') return { text: 'sub answer' }
      return { text: 'sub did it' }
    }
    if (stage === 'planner') {
      return {
        text: planJson([
          { id: 's1', complexity: 'low' },
          { id: 's2', complexity: 'medium' },
        ]),
      }
    }
    if (stage === 'replanner') return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }) }
    if (stage === 'synthesizer') return { text: 'Parent done.' }
    // s1 on the light tier gives up: escalated to standard.
    if (stepOf(req) === 's1')
      return req.model === 'light' ? { text: '[BLOCKER] too hard' } : { text: 'did s1' }
    const results = toolResults(req).length
    if (results === 0)
      return { toolCalls: [{ name: 'spawn_subagent', args: { task: 'HELPER TASK: look' } }] }
    if (results === 1) return { toolCalls: [{ name: 'child', args: { task: 'child task' } }] }
    if (results === 2)
      return { toolCalls: [{ name: 'worker_child', args: { task: 'worker task' } }] }
    return { text: 'did s2' }
  }
  await withLlm(script, async ({ llm, open }) => {
    const hooks = recorder()
    // The children's configs name no sharedLimits: the run's applies to them.
    const child = createSubagentTool({
      name: 'child',
      description: 'Delegate in-process',
      isolation: 'in-process',
      config: config(llm.baseURL, { systemPrompt: 'CHILD AGENT', maxIterations: 2 }),
    })
    const worker_child = createSubagentTool({
      name: 'worker_child',
      description: 'Delegate to a worker',
      isolation: 'worker',
      config: config(llm.baseURL, { systemPrompt: 'WORKER AGENT', maxIterations: 2 }),
      timeoutMs: 30_000,
    })
    const agent = await open(
      config(llm.baseURL, {
        sharedLimits: hooks,
        executorTiers: { light: { model: 'light' }, strong: { model: 'strong' } },
        replanAfter: 'always',
        subagents: { dynamic: true },
        tools: { child, worker_child },
        compaction: { thresholdTokens: 1, keepRecentTurns: 2, keepRecentSteps: 1 },
      }),
    )
    const history = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `turn ${i}`,
    }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'do the work', history, onEvent })
    assert.equal(result.text, 'Parent done.')
    assert.ok(
      result.trace[1].toolCalls.every((c) => c.ok),
      JSON.stringify(result.trace[1].toolCalls),
    )
    assert.equal(ofType(events, 'step.escalated').length, 1, 'an escalation happened')

    // One question per request the endpoint saw, under the right stage.
    assert.equal(hooks.before.length, llm.requests.length)
    assert.deepEqual(
      countBy(hooks.before, (c) => c.stage),
      countBy(llm.requests, hookStageOf),
    )
    for (const stage of ['planner', 'executor', 'replanner', 'synthesizer', 'compaction']) {
      assert.ok(
        hooks.before.some((c) => c.stage === stage),
        `a ${stage} call was asked about`,
      )
    }
    // The executor calls name their tier's model: the escalated attempt went through it too.
    const executorModels = hooks.before.filter((c) => c.stage === 'executor').map((c) => c.modelId)
    assert.ok(executorModels.includes('light') && executorModels.includes('scripted'))
    // All of it spent for the run the host started - the helper's, the children's, the worker's.
    const runId = events[0].runId
    assert.ok(
      hooks.before.every((c) => c.runId === runId),
      JSON.stringify(hooks.before.map((c) => c.runId)),
    )
    // The call as the host sees it.
    const first = hooks.before[0]
    assert.equal(first.stage, 'compaction')
    assert.equal(first.provider, 'scale-out-test.chat')
    assert.ok((first.estimatedInputTokens ?? 0) > 0)
    const plannerCall = hooks.before.find((c) => c.stage === 'planner')
    assert.equal(typeof plannerCall?.maxOutputTokens, 'number')
    // And afterModelCall once per call, with what it used (10 in / 5 out, scripted).
    await until(() => hooks.after.length === hooks.before.length, 'every afterModelCall')
    assert.ok(
      hooks.after.every(
        (a) =>
          a.ok &&
          a.usage.inputTokens === 10 &&
          a.usage.outputTokens === 5 &&
          a.usage.totalTokens === 15,
      ),
    )
  })
})

test('sharedLimits: agent.compact() and a pipeline route call are asked about too (no run: no runId)', async () => {
  await withLlm(
    (req) => (stageOf(req) === 'compact-history' ? { text: 'SUMMARY' } : { text: 'x' }),
    async ({ llm, open }) => {
      const hooks = recorder()
      const agent = await open(config(llm.baseURL, { sharedLimits: hooks }))
      const history = Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        content: `turn ${i}`,
      }))
      const r = await agent.compact({ history, force: true })
      assert.equal(r.compacted, true)
      assert.deepEqual(
        hooks.before.map((c) => [c.stage, c.runId]),
        [['compaction', undefined]],
      )
    },
  )
  const definition: PipelineDefinition = {
    version: 1,
    name: 'route',
    entry: 'a',
    nodes: [
      { id: 'a', instructions: 'NODE-A', routes: [{ label: 'yes' }, { label: 'no' }] },
      { id: 'b', instructions: 'NODE-B' },
    ],
    edges: [{ id: 'e', from: 'a', to: 'b', when: { kind: 'route', label: 'yes' } }],
  }
  const routeScript = (refused: boolean) => {
    const hooks = recorder(refused ? refuse('route') : () => {})
    return { hooks }
  }
  for (const refused of [false, true]) {
    const { hooks } = routeScript(refused)
    const llm = await startLocalOpenAI((req) =>
      stageOf(req) === 'route'
        ? { text: JSON.stringify({ route: 'yes' }) }
        : linearScript(['s1'])(req),
    )
    const pipeline = createPipeline(definition, {
      resolveNode: () => config(llm.baseURL, { sharedLimits: hooks, llmMaxRetries: 2 }),
    })
    try {
      const result = await pipeline.run({ input: 'go' })
      const routes = hooks.before.filter((c) => c.stage === 'route')
      assert.equal(routes.length, 1, 'one route call, asked about once (a refusal is not retried)')
      assert.equal(routes[0].runId, undefined)
      assert.equal(llm.requests.filter((r) => stageOf(r) === 'route').length, refused ? 0 : 1)
      // A refused route call is no route, as a failed one is.
      assert.equal(result.runs, refused ? 1 : 2)
      assert.equal(hooks.before.length, llm.requests.length + (refused ? 1 : 0))
    } finally {
      await pipeline.close()
      await llm.close()
    }
  }
})

// ── waiting ─────────────────────────────────────────────────────────────────

test('sharedLimits: a delay is honoured - nothing is sent before beforeModelCall lets the call go', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    let letGo: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      letGo = resolve
    })
    const hooks = recorder((call) => (call.stage === 'planner' ? held : undefined))
    const agent = await open(config(llm.baseURL, { sharedLimits: hooks }))
    const run = agent.run({ input: 'x' })
    await until(() => hooks.before.length === 1, 'the planner to ask')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(llm.requests.length, 0, 'the planner call waits')
    letGo()
    const result = await run
    assert.equal(result.text, 'All done.')
    assert.equal(stageOf(llm.requests[0]), 'planner')
  })
})

test("sharedLimits: the wait counts against the call's own timeout - and a slot given late is handed back", async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    let letGo: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      letGo = resolve
    })
    const hooks = recorder((call) => (call.stage === 'planner' ? held : undefined))
    const agent = await open(
      config(llm.baseURL, { sharedLimits: hooks, llmTimeoutMs: 1_500, llmMaxRetries: 0 }),
    )
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'x', onEvent })
    // The planner call timed out while it waited: the run answered from the fallback plan.
    assert.equal(ofType(events, 'plan.created')[0].plan.steps[0].id, 'fallback')
    assert.equal(llm.requests.filter((r) => stageOf(r) === 'planner').length, 0)
    assert.equal(result.text, 'All done.')
    const planner = hooks.before.find((c) => c.stage === 'planner') as IModelCall
    assert.ok(!hooks.after.some((a) => a.call === planner), 'not let through yet')
    letGo()
    await until(() => hooks.after.some((a) => a.call === planner), 'the late slot to come back')
    const back = hooks.after.find((a) => a.call === planner)
    assert.equal(back?.ok, false)
    assert.equal(back?.usage.totalTokens, 0)
  })
})

test('sharedLimits: a generate call (the replanner) is bounded by its timeout while it waits, too', async () => {
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    let letGo: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      letGo = resolve
    })
    const hooks = recorder((call) => (call.stage === 'replanner' ? held : undefined))
    const agent = await open(
      config(llm.baseURL, {
        sharedLimits: hooks,
        replanAfter: 'always',
        llmTimeoutMs: 1_500,
        llmMaxRetries: 0,
      }),
    )
    const { events, onEvent } = collect()
    try {
      // The replanner call times out while it waits: the run carries on with the plan it has.
      const result = await within(agent.run({ input: 'x', onEvent }), 'the run')
      assert.equal(result.text, 'All done.')
      const decision = ofType(events, 'replan.decision').find((d) => d.cause === 'llm-decision')
      assert.equal(decision?.failed, true)
      assert.equal(llm.requests.filter((r) => stageOf(r) === 'replanner').length, 0)
    } finally {
      letGo()
    }
  })
})

// ── refusals: never retried, and the stage fails as it fails on any error ─────

test('sharedLimits: a refused synthesizer call is not retried and fails the run with ModelCallRefusedError', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const hooks = recorder(refuse('synthesizer'))
    const saved: string[] = []
    const persistence: IPersistence = { onRunComplete: (s) => void saved.push(s.status) }
    const agent = await open(
      config(llm.baseURL, { sharedLimits: hooks, llmMaxRetries: 3, persistence }),
    )
    const { events, onEvent } = collect()
    const err = await agent.run({ input: 'x', onEvent }).then(
      () => assert.fail('the run must fail'),
      (e: unknown) => e,
    )
    assert.ok(err instanceof ModelCallRefusedError, String(err))
    assert.equal(err.call.stage, 'synthesizer')
    assert.match(err.message, /refused by sharedLimits\.beforeModelCall: budget spent/)
    assert.equal(hooks.before.filter((c) => c.stage === 'synthesizer').length, 1, 'asked once')
    assert.equal(ofType(events, 'retry').length, 0, 'never retried')
    assert.equal(llm.requests.filter((r) => stageOf(r) === 'synthesizer').length, 0)
    assert.deepEqual(saved, ['failed'])
  })
})

test('sharedLimits: a refused replanner call degrades to continue, as a failed one does', async () => {
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    const hooks = recorder(refuse('replanner'))
    const agent = await open(
      config(llm.baseURL, { sharedLimits: hooks, replanAfter: 'always', llmMaxRetries: 2 }),
    )
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'x', onEvent })
    assert.equal(result.text, 'All done.')
    const decision = ofType(events, 'replan.decision').find((d) => d.cause === 'llm-decision')
    assert.equal(decision?.failed, true)
    assert.equal(decision?.mode, 'continue')
    assert.equal(hooks.before.filter((c) => c.stage === 'replanner').length, 1)
    assert.equal(result.trace.length, 2)
  })
})

test('sharedLimits: a refused planner call falls back to the one-step plan, as a failed one does', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const hooks = recorder(refuse('planner'))
    const agent = await open(config(llm.baseURL, { sharedLimits: hooks, llmMaxRetries: 2 }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'x', onEvent })
    assert.equal(ofType(events, 'plan.created')[0].plan.steps[0].id, 'fallback')
    assert.equal(hooks.before.filter((c) => c.stage === 'planner').length, 1)
    assert.equal(result.text, 'All done.')
  })
})

test('sharedLimits: a refused executor call fails the step - and the run - and is not escalated to a stronger tier', async () => {
  const script: Script = (req) =>
    stageOf(req) === 'planner'
      ? { text: planJson([{ id: 's1', complexity: 'low' }]) }
      : linearScript(['s1'])(req)
  await withLlm(script, async ({ llm, open }) => {
    // A plain refusal (no 429 in its cause): it is the refusal itself that is not escalated.
    const hooks = recorder((call) => {
      if (call.stage === 'executor') throw new Error('tenant budget spent')
    })
    const agent = await open(
      config(llm.baseURL, {
        sharedLimits: hooks,
        llmMaxRetries: 2,
        executorTiers: { light: { model: 'light' }, strong: { model: 'strong' } },
      }),
    )
    const { events, onEvent } = collect()
    await assert.rejects(agent.run({ input: 'x', onEvent }), ModelCallRefusedError)
    assert.equal(hooks.before.filter((c) => c.stage === 'executor').length, 1)
    assert.equal(ofType(events, 'step.escalated').length, 0)
    assert.equal(ofType(events, 'error')[0].phase, 'execute')
  })
})

test('sharedLimits: a refused compaction call leaves the history as it was; the run goes on', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const hooks = recorder(refuse('compaction'))
    const agent = await open(
      config(llm.baseURL, {
        sharedLimits: hooks,
        compaction: { thresholdTokens: 1, keepRecentTurns: 1 },
      }),
    )
    const history = Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `turn ${i}`,
    }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'x', history, onEvent })
    assert.equal(result.text, 'All done.')
    assert.equal(result.compactedHistory, undefined)
    assert.equal(ofType(events, 'context.compacted').length, 0)
    assert.equal(hooks.before.filter((c) => c.stage === 'compaction').length, 1)
  })
})

test('sharedLimits: the refusal rule in the retry helper and the escalation rule, on their own', async () => {
  const call: IModelCall = { stage: 'executor', modelId: 'm' }
  const refused = new ModelCallRefusedError(call, Object.assign(new Error('x'), { status: 429 }))
  let tries = 0
  await assert.rejects(
    withRetry(
      async () => {
        tries++
        throw refused
      },
      { maxRetries: 3, baseDelayMs: 1 },
    ),
    ModelCallRefusedError,
  )
  assert.equal(tries, 1, 'a refusal is never retried, whatever its cause says')
  // Wrapped further down a chain, still a refusal.
  tries = 0
  await assert.rejects(
    withRetry(
      async () => {
        tries++
        throw Object.assign(new Error('wrapped'), { status: 503, cause: refused })
      },
      { maxRetries: 3, baseDelayMs: 1 },
    ),
  )
  assert.equal(tries, 1)
  assert.equal(isEscalatableError(refused), false)
  assert.equal(isEscalatableError(new ModelCallRefusedError(call, new Error('plain'))), false)
  assert.equal(isEscalatableError(new Error('some model failure')), true)
  // A plain refusal (no status anywhere) is not retried either.
  tries = 0
  await assert.rejects(
    withRetry(
      async () => {
        tries++
        throw Object.assign(new Error('fetch failed'), {
          name: 'TypeError',
          cause: new ModelCallRefusedError(call, new Error('plain')),
        })
      },
      { maxRetries: 3, baseDelayMs: 1 },
    ),
  )
  assert.equal(tries, 1, 'not even under a network-looking error')
})

// ── afterModelCall ──────────────────────────────────────────────────────────

test('sharedLimits: afterModelCall throwing is only logged', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const hooks: ISharedLimits = {
      beforeModelCall: () => {},
      afterModelCall: (call) => {
        if (call.stage === 'executor') throw new Error('ledger down')
        return Promise.reject(new Error('async ledger down'))
      },
    }
    const agent = await open(config(llm.baseURL, { sharedLimits: hooks }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'x', onEvent })
    assert.equal(result.text, 'All done.')
    await until(
      () =>
        ofType(events, 'log').filter((e) =>
          e.message.startsWith('[sharedLimits] afterModelCall threw'),
        ).length >= 3,
      'the logs',
    )
    const logs = ofType(events, 'log').map((e) => e.message)
    assert.ok(logs.some((m) => /threw \(executor\): ledger down/.test(m)))
    assert.ok(logs.some((m) => /async ledger down/.test(m)))
  })
})

// ── off ─────────────────────────────────────────────────────────────────────

test('sharedLimits: without the hook the model is not even wrapped', () => {
  const model = {
    specificationVersion: 'v3',
    provider: 'p',
    modelId: 'm',
  } as unknown as LanguageModel
  assert.equal(limitedModel(model, 'planner', undefined), model)
  const hooks: ISharedLimits = { beforeModelCall: () => {} }
  const wrapped = limitedModel(model, 'planner', hooks)
  assert.notEqual(wrapped, model)
  assert.equal(
    limitedModel(model, 'planner', hooks),
    wrapped,
    'one wrapper per hook, model and stage',
  )
  assert.notEqual(limitedModel(model, 'replanner', hooks), wrapped)
})

test('sharedLimits: createAgent refuses a hook that cannot work', async () => {
  const base: IAgentConfig = config('http://127.0.0.1:9/v1')
  await assert.rejects(
    import('../src/index.ts').then(({ createAgent }) =>
      createAgent({ ...base, sharedLimits: {} as ISharedLimits }),
    ),
    /sharedLimits\.beforeModelCall must be a function/,
  )
  await assert.rejects(
    import('../src/index.ts').then(({ createAgent }) =>
      createAgent({
        ...base,
        sharedLimits: { beforeModelCall: () => {}, afterModelCall: 'x' as never },
      }),
    ),
    /sharedLimits\.afterModelCall must be a function/,
  )
})

// A child's refused call is a failure of the child: its tool call fails, the parent carries on.
test('sharedLimits: a refused call inside an in-process subagent fails that delegation only', async () => {
  const script: Script = (req) => {
    const stage = stageOf(req)
    const child = systemOf(req).includes('CHILD AGENT')
    if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
    if (stage === 'synthesizer') return { text: child ? 'child answer' : 'Parent done.' }
    if (child) return { text: 'child did it' }
    if (hasToolResult(req)) return { text: 'parent carried on' }
    return { toolCalls: [{ name: 'child', args: { task: 'go' } }] }
  }
  await withLlm(script, async ({ llm, open }) => {
    let refusedOnce = false
    const hooks = recorder((call) => {
      // The second planner call is the child's: refuse the executor call that follows it.
      const plans = hooks.before.filter((c) => c.stage === 'planner').length
      if (call.stage === 'executor' && plans === 2 && !refusedOnce) {
        refusedOnce = true
        throw new Error('child budget spent')
      }
    })
    const child = createSubagentTool({
      name: 'child',
      description: 'Delegate',
      isolation: 'in-process',
      config: config(llm.baseURL, { systemPrompt: 'CHILD AGENT', llmMaxRetries: 2 }),
    })
    const agent = await open(config(llm.baseURL, { sharedLimits: hooks, tools: { child } }))
    const result = await agent.run({ input: 'delegate' })
    assert.equal(result.text, 'Parent done.')
    const call = result.trace[0].toolCalls[0]
    assert.equal(call.ok, false)
    assert.match(
      String(call.output),
      /refused by sharedLimits\.beforeModelCall: child budget spent/,
    )
  })
})
