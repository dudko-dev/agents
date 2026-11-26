import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgent, type AgentEvent, type BrowserAgentConfig } from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// A replanner that cannot give a decision must not throw away the steps already done, and must
// not fail silently either: the run carries on with the plan it has, the failure is an `error`
// event of phase 'replan' and a `replan.decision` marked `failed`, and what the failed attempts
// cost is in the usage. Same names and meaning as the Node sibling
// (packages/agent/tests/replan-failure.test.ts).

const plan = JSON.stringify({
  thought: 'Three steps.',
  steps: ['one', 'two', 'three'].map((n) => ({ description: `Step ${n}` })),
})
const decision = JSON.stringify({ decision: 'continue', reason: 'on track' })

/** Every stage answers well; `replanner(n, info)` may answer (or throw) for the Nth replanner call. */
const script = (replanner: (n: number, info: CallInfo) => Reply | undefined) => {
  let replans = 0
  return scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan }
      case 'replanner':
        replans += 1
        return replanner(replans, info) ?? { text: decision }
      case 'executor':
        return { text: 'did it' }
      default:
        return { text: 'All three done.' }
    }
  })
}

const collector = () => {
  const warned: unknown[][] = []
  return {
    warned,
    logger: {
      error: () => {},
      warn: (...args: unknown[]) => void warned.push(args),
      info: () => {},
      debug: () => {},
    },
  }
}

const runWith = async (
  m: ReturnType<typeof scriptedModel>,
  extra: Partial<BrowserAgentConfig> = {},
  signal?: AbortSignal,
) => {
  const log = collector()
  // The replanner is consulted after every step, the last one included: three rounds.
  const agent = await createAgent({
    model: m.model,
    replanAfter: 'always',
    logger: log.logger,
    ...extra,
  })
  const events: AgentEvent[] = []
  const result = await agent.run('Do three things', { onEvent: (e) => events.push(e), signal })
  return { agent, result, events, warned: log.warned }
}

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

const count = (m: ReturnType<typeof scriptedModel>, stage: string): number =>
  m.calls.filter((c) => stageOf(c) === stage).length

test('the replanner failing at round 1 (both attempts): the run continues and reports it', async () => {
  // Round 1 = calls 1 (structured) and 2 (the prompted fallback): both fail.
  const m = script((n) => {
    if (n <= 2) throw new Error('upstream is down')
    return undefined
  })
  const { result, events, warned } = await runWith(m)

  assert.equal(result.final, 'All three done.', 'the run finished and synthesized')
  assert.equal(result.trace.length, 3, 'every planned step ran')
  assert.equal(count(m, 'executor'), 3)
  assert.equal(result.stopped, false)

  const errors = of(events, 'error')
  assert.equal(errors.length, 1, 'the failure is reported once')
  assert.equal(errors[0].phase, 'replan')
  assert.match(errors[0].error, /upstream is down/)

  const decisions = of(events, 'replan.decision')
  assert.equal(decisions.length, 3)
  assert.deepEqual(
    decisions.map((d) => [d.mode, d.failed]),
    [
      ['continue', true],
      ['continue', undefined],
      ['continue', undefined],
    ],
    'only the fallback decision is marked',
  )
  assert.match(decisions[0].reason, /^replanner failed: upstream is down/)
  // The structured attempt's failure is announced before the fallback call, as the planner's is.
  const retries = of(events, 'retry').filter((e) => e.phase === 'replan')
  assert.equal(retries.length, 1)
  assert.ok(
    warned.some((args) => args.some((a) => /replanner failed/.test(String(a)))),
    'and logged as a warning',
  )
})

test('a failure at round 2 keeps the earlier steps and still runs the last one', async () => {
  // Round 1 is one call; round 2 = calls 2 and 3.
  const m = script((n) => {
    if (n === 2 || n === 3) throw new Error('rate limited')
    return undefined
  })
  const { result, events } = await runWith(m)
  assert.equal(result.trace.length, 3)
  assert.equal(result.final, 'All three done.')
  assert.deepEqual(
    of(events, 'replan.decision').map((d) => d.failed),
    [undefined, true, undefined],
  )
})

test('an unparsable structured answer is salvaged by the prompted fallback: not a failure', async () => {
  const m = script((n) => (n === 1 ? { text: 'prose, not a decision' } : undefined))
  const { result, events } = await runWith(m)
  assert.equal(result.trace.length, 3)
  assert.equal(of(events, 'error').length, 0)
  assert.equal(of(events, 'replan.decision').filter((d) => d.failed).length, 0)
  assert.equal(of(events, 'retry').filter((e) => e.phase === 'replan').length, 1)
})

test('what the failed attempts cost is counted', async () => {
  const usage = { input: 100, output: 20 }
  // The structured attempt is answered (and paid for) but is not a decision; the fallback fails.
  const m = script((n) => {
    if (n === 1) return { text: 'prose, not a decision', usage }
    if (n === 2) throw new Error('upstream is down')
    return undefined
  })
  const { agent, result, events } = await runWith(m)
  assert.equal(of(events, 'replan.decision')[0].failed, true)
  // 1 plan + 3 steps + 2 good replans + 1 synthesis at 10/5, and the paid-for failed attempt.
  assert.equal(result.usage.inputTokens, 7 * 10 + 100)
  assert.equal(result.usage.outputTokens, 7 * 5 + 20)
  assert.equal(agent.usage.totalTokens, result.usage.totalTokens)
  const replanSpend = of(events, 'usage')
    .filter((u) => u.phase === 'replan')
    .reduce((n, u) => n + u.usage.totalTokens, 0)
  assert.equal(replanSpend, 2 * 15 + 120)
})

test('a run-level limit the failed attempt crosses still stops the run', async () => {
  const m = script((n) => {
    if (n === 1) return { text: 'prose', usage: { input: 900, output: 200 } }
    if (n === 2) throw new Error('upstream is down')
    return undefined
  })
  const { result, events } = await runWith(m, { limits: { maxTotalTokens: 1000 } })
  assert.equal(result.trace.length, 1, 'no further step ran')
  assert.equal(of(events, 'budget.exceeded').length, 1)
  assert.equal(result.budgetExceeded?.kind, 'total')
  assert.equal(result.final, 'All three done.', 'the answer is still written from what it has')
})

test('a prompted-mode replanner that fails is reported the same way', async () => {
  let replans = 0
  const m = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return {
          text: JSON.stringify({ reply: 'ok', plan: ['Step one', 'Step two', 'Step three'] }),
        }
      case 'replanner':
        replans += 1
        if (replans === 1) throw new Error('model crashed')
        return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
      case 'executor':
        return { text: JSON.stringify({ reply: 'did it', actions: [] }) }
      default:
        return { text: 'All three done.' }
    }
  })
  const { result, events } = await runWith(m, { toolMode: 'prompted' })
  assert.equal(result.trace.length, 3)
  const errors = of(events, 'error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].phase, 'replan')
  assert.match(errors[0].error, /model crashed/)
  assert.equal(of(events, 'replan.decision')[0].failed, true)
  // No structured attempt in prompted mode, so nothing to announce as a retry.
  assert.equal(of(events, 'retry').length, 0)
})

test('an abort during the replanner call is a stop, not a failed decision', async () => {
  const controller = new AbortController()
  const m = script((n) => {
    if (n === 1) {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    }
    return undefined
  })
  const { result, events } = await runWith(m, {}, controller.signal)
  assert.equal(result.stopped, true)
  assert.equal(count(m, 'replanner'), 1, 'no fallback call was spent after the abort')
  assert.equal(count(m, 'executor'), 1)
  assert.equal(of(events, 'replan.decision').length, 0)
  assert.equal(of(events, 'error').length, 0)
  assert.equal(of(events, 'stopped').length, 1)
})
