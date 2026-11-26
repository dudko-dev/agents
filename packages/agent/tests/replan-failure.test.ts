import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgent, createRunControl, type IAgent, type RunControl } from '../src/index.ts'
import type { AgentEvent, IAgentConfig, IAgentRunResult, IRunSnapshot } from '../src/types.ts'
import { isAuthError, usageOfError } from '../src/utils.ts'
import {
  startLocalOpenAI,
  systemOf,
  type IChatRequest,
  type ILocalOpenAI,
  type IScriptedReply,
  type Script,
} from './helpers/openai-server.ts'

// A replanner that cannot give a decision must not throw away the steps already done. Over real
// sockets against the scripted OpenAI-compatible endpoint: the replanner is broken at one round
// (unparseable output, a schema mismatch, the provider down) and the run is expected to carry on
// with the plan it has, report the failure and count what the failed attempt cost. A stop, and
// credentials the provider refuses, still end the run.

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer' | 'other'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
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

/**
 * Every stage answers well, except the replanner at round `breakAt` (1-based: its Nth call),
 * which answers with `broken` - `times` calls in a row, for a failure the SDK retries.
 */
const brokenAt = (breakAt: number, broken: IScriptedReply, times = 1): Script => {
  let replans = 0
  return (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: plan }
      case 'replanner':
        replans += 1
        return replans >= breakAt && replans < breakAt + times
          ? broken
          : { text: JSON.stringify({ mode: 'continue', reason: 'on track' }) }
      case 'executor':
        return { text: 'did it' }
      default:
        return { text: 'All three done.' }
    }
  }
}

const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'replan-failure',
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

const withRun = async (
  script: Script,
  extra: Partial<IAgentConfig>,
  body: (r: {
    llm: ILocalOpenAI
    events: AgentEvent[]
    run: (signal?: AbortSignal, control?: RunControl) => Promise<IAgentRunResult>
  }) => Promise<void>,
): Promise<void> => {
  const llm = await startLocalOpenAI(script)
  let agent: IAgent | undefined
  try {
    agent = await createAgent(config(llm.baseURL, extra))
    const events: AgentEvent[] = []
    await body({
      llm,
      events,
      run: (signal, control) =>
        agent!.run({
          input: 'Do three things',
          signal,
          ...(control ? { control } : {}),
          onEvent: (e) => events.push(e),
        }),
    })
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
  }
}

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

const calls = (llm: ILocalOpenAI, stage: Stage): number =>
  llm.requests.filter((r) => stageOf(r) === stage).length

// What the run must look like when the replanner broke at one round and the run carried on.
const assertCarriedOn = (
  r: { llm: ILocalOpenAI; events: AgentEvent[] },
  result: IAgentRunResult,
  brokenRound: number,
  errorPattern: RegExp,
): void => {
  assert.equal(result.text, 'All three done.', 'the run finished and synthesized')
  assert.equal(result.trace.length, 3, 'every planned step ran')
  assert.equal(calls(r.llm, 'executor'), 3)
  assert.equal(calls(r.llm, 'synthesizer'), 1)

  const errors = of(r.events, 'error')
  assert.equal(errors.length, 1, 'the failure is reported once')
  assert.equal(errors[0].phase, 'replan')
  assert.match(errors[0].error.message, errorPattern)

  const decisions = of(r.events, 'replan.decision').filter((d) => d.cause === 'llm-decision')
  assert.equal(decisions.length, 2, 'both replanner rounds produced a decision')
  decisions.forEach((d, i) => {
    assert.equal(d.mode, 'continue')
    if (i + 1 === brokenRound) {
      assert.equal(d.failed, true, 'the fallback decision is marked')
      assert.match(d.reason, /^replanner failed: /)
    } else {
      assert.equal(d.failed, undefined, 'a real decision is not')
    }
  })
  const warned = of(r.events, 'log').filter(
    (l) => l.level === 'warn' && l.message.startsWith('[replan] the replanner failed'),
  )
  assert.equal(warned.length, 1)
}

test('unparseable replanner output at round 1: the run continues with the plan and reports it', async () => {
  await withRun(brokenAt(1, { text: 'I think we should carry on, probably.' }), {}, async (r) => {
    const result = await r.run()
    assertCarriedOn(r, result, 1, /could not parse the response/)
    // Usage: every call was paid for, the one whose answer could not be parsed included
    // (10 in / 5 out each: 1 plan + 3 steps + 2 replans + 1 synthesis).
    assert.equal(r.llm.requests.length, 7)
    assert.deepEqual(
      { in: result.usage.inputTokens, out: result.usage.outputTokens },
      { in: 70, out: 35 },
    )
    const replanUsage = of(r.events, 'usage').filter((u) => u.phase === 'replan')
    assert.equal(replanUsage.length, 2, 'the failed attempt has a usage event of its own')
  })
})

test('a schema mismatch at round 2: the earlier steps are kept and the last one still runs', async () => {
  // Valid JSON, wrong shape: `revise` without the plan it must carry.
  const broken = { text: JSON.stringify({ mode: 'revise', reason: 'change of plan' }) }
  await withRun(brokenAt(2, broken), {}, async (r) => {
    const result = await r.run()
    assertCarriedOn(r, result, 2, /did not match schema/)
    assert.equal(result.usage.totalTokens, 7 * 15)
  })
})

test('the spend of the failed attempt is what the provider reported for it', async () => {
  const broken = { text: 'not json', usage: { prompt: 400, completion: 60 } }
  await withRun(brokenAt(1, broken), {}, async (r) => {
    const result = await r.run()
    assert.equal(result.usage.inputTokens, 6 * 10 + 400)
    assert.equal(result.usage.outputTokens, 6 * 5 + 60)
  })
})

test('the provider failing for the replanner (500, after the retries): the run continues', async () => {
  // Down for all three attempts the SDK makes (the call and its two retries).
  await withRun(brokenAt(1, { status: 500, text: 'upstream is down' }, 3), {}, async (r) => {
    const result = await r.run()
    assertCarriedOn(r, result, 1, /upstream is down/)
    assert.equal(calls(r.llm, 'replanner'), 3 + 1, 'three failed attempts, then round 2')
    // Nothing was reported as spent for calls the provider never answered.
    assert.equal(result.usage.totalTokens, 6 * 15)
  })
})

test('a request the provider rejects for the replanner (400): the run continues', async () => {
  await withRun(brokenAt(2, { status: 400, text: 'schema not supported' }), {}, async (r) => {
    const result = await r.run()
    assertCarriedOn(r, result, 2, /schema not supported/)
  })
})

test('a budget the failed attempt crosses still stops the run, at the next boundary', async () => {
  // The broken replanner call alone costs more than the whole run may spend.
  const broken = { text: 'not json', usage: { prompt: 900, completion: 200 } }
  const extra = { limits: { maxTotalTokens: 1000 } }
  await withRun(brokenAt(1, broken), extra, async (r) => {
    const result = await r.run()
    assert.equal(result.trace.length, 1, 'no further step ran')
    assert.equal(calls(r.llm, 'executor'), 1)
    assert.equal(calls(r.llm, 'replanner'), 1)
    const exceeded = of(r.events, 'budget.exceeded')
    assert.equal(exceeded.length, 1)
    assert.equal(exceeded[0].kind, 'total')
    assert.equal(result.text, 'All three done.', 'the answer is still written from what it has')
    assert.ok(result.usage.totalTokens >= 1100, 'the failed attempt is in the total')
  })
})

test('credentials the provider refuses (401) still stop the run', async () => {
  const saved: IRunSnapshot[] = []
  const extra = { persistence: { onRunComplete: (s: IRunSnapshot) => void saved.push(s) } }
  await withRun(brokenAt(1, { status: 401, text: 'invalid api key' }), extra, async (r) => {
    await assert.rejects(r.run(), /invalid api key/)
    assert.equal(calls(r.llm, 'executor'), 1, 'no step ran after the refusal')
    assert.equal(calls(r.llm, 'synthesizer'), 0)
    assert.equal(of(r.events, 'error')[0]?.phase, 'replan')
    assert.equal(
      of(r.events, 'replan.decision').filter((d) => d.failed).length,
      0,
      'no fallback decision',
    )
    assert.equal(saved.at(-1)?.status, 'failed')
    assert.equal(saved.at(-1)?.trace.length, 1, 'the snapshot keeps the step that was done')
  })
})

test('a 403 is a refusal too', async () => {
  await withRun(brokenAt(1, { status: 403, text: 'key has no access' }), {}, async (r) => {
    await assert.rejects(r.run(), /key has no access/)
    assert.equal(calls(r.llm, 'synthesizer'), 0)
  })
})

test('an abort during the replanner call still stops the run', async () => {
  const saved: IRunSnapshot[] = []
  const extra = { persistence: { onRunComplete: (s: IRunSnapshot) => void saved.push(s) } }
  const controller = new AbortController()
  const slow = { text: JSON.stringify({ mode: 'continue', reason: 'late' }), delayMs: 1_000 }
  await withRun(brokenAt(1, slow), extra, async (r) => {
    const running = r.run(controller.signal)
    // Abort once the replanner's request is on the wire.
    while (calls(r.llm, 'replanner') === 0) await new Promise((done) => setTimeout(done, 5))
    controller.abort()
    await assert.rejects(running, (err: Error) => err.name === 'AbortError')
    assert.equal(calls(r.llm, 'executor'), 1)
    assert.equal(calls(r.llm, 'synthesizer'), 0)
    assert.equal(of(r.events, 'replan.decision').filter((d) => d.failed).length, 0)
    assert.equal(saved.at(-1)?.status, 'cancelled')
  })
})

test('a message the failed replanner was to weigh is weighed at the next boundary', async () => {
  // Only the user's message makes the replanner run here (clean steps do not trigger it).
  const control = createRunControl()
  control.send('Make it shorter')
  await withRun(brokenAt(1, { text: 'not a decision' }), { replanAfter: 'failure' }, async (r) => {
    const result = await r.run(undefined, control)
    assert.equal(result.trace.length, 3)
    const asked = of(r.events, 'replan.decision').filter((d) => d.cause === 'user-message')
    assert.deepEqual(
      asked.map((d) => d.failed),
      [true, undefined],
      'asked again after the step that followed the failure, and only until it answered',
    )
    assert.equal(calls(r.llm, 'replanner'), 2)
  })
})

test('a plan that could not be parsed is paid for too (the fallback plan does not hide it)', async () => {
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: 'no plan, sorry', usage: { prompt: 300, completion: 40 } }
      case 'executor':
        return { text: 'answered directly' }
      default:
        return { text: 'Answer.' }
    }
  }
  await withRun(script, {}, async (r) => {
    const result = await r.run()
    assert.equal(result.plan.steps[0].id, 'fallback')
    assert.equal(result.usage.inputTokens, 300 + 10 + 10)
    assert.equal(result.usage.outputTokens, 40 + 5 + 5)
  })
})

test('usageOfError reads the usage a failed structured call carries, and nothing else', () => {
  assert.equal(usageOfError(new Error('plain')), undefined)
  assert.equal(usageOfError(undefined), undefined)
  assert.equal(usageOfError({ usage: 'nope' }), undefined)
  assert.equal(usageOfError({ usage: {} }), undefined, 'no tokens reported: nothing to charge')
  assert.deepEqual(usageOfError({ usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }), {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  })
})

test('isAuthError finds a 401 / 403 on the error or down its cause chain, and only those', () => {
  assert.equal(isAuthError({ statusCode: 401 }), true)
  assert.equal(isAuthError({ status: 403 }), true)
  assert.equal(isAuthError({ name: 'RetryError', lastError: { statusCode: 401 } }), true)
  assert.equal(isAuthError({ cause: { cause: { statusCode: 403 } } }), true)
  assert.equal(isAuthError({ statusCode: 500 }), false)
  assert.equal(isAuthError({ statusCode: 429 }), false)
  assert.equal(isAuthError({ statusCode: 400 }), false)
  assert.equal(isAuthError(new Error('plain')), false)
  assert.equal(isAuthError(undefined), false)
  const loop: { cause?: unknown } = {}
  loop.cause = loop
  assert.equal(isAuthError(loop), false, 'a cyclic cause chain ends')
})
