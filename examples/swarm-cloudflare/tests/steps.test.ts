// A Workflow step's work (src/steps.ts) in Node: the real core (@dudko.dev/agent) against the
// scripted OpenAI-compatible model, with every hook on the session's object - the in-process host
// over node:sqlite (tests/helpers/host.ts). What examples/swarm's integration tests prove on
// Temporal and Postgres, here without workerd: a phase end to end, a lost result, parking, a stop,
// a refusal, and the two fences against an attempt the engine gave up on that does not know it
// yet (mirrors examples/swarm's tests/integration/zombie.test.ts): superseded before its first
// snapshot, revoked from its lease after it.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { tool } from 'ai'
import { z } from 'zod'
import { agentSetupFromEnv } from '../src/agent-config.ts'
import { runtimeConfig } from '../src/config.ts'
import { latestRunOfTurn, loadRun } from '../src/store.ts'
import { runTurnPhase, TurnRefused, type ISessionPort, type IStepDeps } from '../src/steps.ts'
import {
  startLocalOpenAI,
  systemOf,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type IScriptedReply,
} from '../../../packages/agent/tests/helpers/openai-server.ts'
import { message, OPTIONS, testHost, type ITestHost } from './helpers/host.ts'

let llm: ILocalOpenAI
const written: string[] = []
// Per test: how the model answers (a request -> a reply, or undefined for the default).
let override: ((req: IChatRequest) => IScriptedReply | undefined) | undefined

const stageOf = (req: IChatRequest): string => {
  const s = systemOf(req)
  if (s.includes('You are the Planner')) return 'planner'
  if (s.includes('You are the Replanner')) return 'replanner'
  if (s.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}

const plan = JSON.stringify({
  thought: 't',
  steps: [{ id: 'a', description: 'a', expectedOutcome: 'a', suggestedTools: [] }],
})

before(async () => {
  llm = await startLocalOpenAI((req) => {
    const o = override?.(req)
    if (o) return o
    const stage = stageOf(req)
    if (stage === 'planner') return { text: plan }
    if (stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    if (stage === 'synthesizer')
      return { text: `final: ${userOf(req).includes('wrote') ? 'written' : 'none'}` }
    const note = /note: ([a-z]+)/.exec(userOf(req))?.[1]
    if (note && toolResults(req).length === 0) {
      return { toolCalls: [{ name: 'write_note', args: { text: note } }] }
    }
    return { text: `results: ${toolResults(req).join(' | ')}` }
  })
})

after(async () => {
  await llm?.close()
})

const writeNote = tool({
  description: 'Write a note (a write).',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => {
    written.push(text)
    return `wrote ${text}`
  },
})

const depsOf = (t: ITestHost, env: Record<string, string> = {}): IStepDeps => {
  const vars = {
    AGENT_PROVIDER_TYPE: 'openai-compatible',
    AGENT_BASE_URL: llm.baseURL,
    AGENT_API_KEY: 'not-a-real-key',
    AGENT_MODEL: 'scripted',
    AGENT_LOG_LEVEL: 'none',
    AGENT_COMPACTION: 'off',
    AGENT_MAX_ITERATIONS: '4',
    AGENT_MAX_STEPS_PER_TASK: '4',
    LEASE_TTL_MS: '1000',
    EVENT_FLUSH_MS: '10',
    ...env,
  }
  // The port is the host's methods, made async (an RPC stub's shape).
  const port = new Proxy(t.host, {
    get: (target, name) => {
      const v = (target as unknown as Record<string | symbol, unknown>)[name]
      return typeof v === 'function' ? async (...args: unknown[]) => v.apply(target, args) : v
    },
  }) as unknown as ISessionPort
  return {
    port: () => port,
    setup: agentSetupFromEnv(vars, { tools: { write_note: writeNote } }),
    runtime: runtimeConfig(vars),
  }
}

const sqlOf = (t: ITestHost) => (t.host as unknown as { storage: { sql: never } }).storage.sql

const session = async (text: string): Promise<ITestHost> => {
  const t = testHost({ leaseTtlMs: 1000, realClock: true })
  t.host.create('s1', OPTIONS, message(text))
  await t.drain()
  return t
}

const writes = (text: string): number => written.filter((w) => w === text).length

test('a phase end to end: the run on the object, its outcome taken; a second run of it does nothing', async () => {
  const t = await session('note: alpha')
  const deps = depsOf(t)
  assert.deepEqual(await runTurnPhase(deps, 's1', 1, 0), { status: 'completed' })
  assert.equal(writes('alpha'), 1)
  const v = t.host.view()
  assert.ok(v.ok)
  assert.equal(v.value.turns[0]?.status, 'completed')
  assert.equal(v.value.turns[0]?.text, 'final: written')
  const row = latestRunOfTurn(sqlOf(t), 's1', 1)!
  assert.equal(row.snapshot?.status, 'complete')
  assert.match(row.runId, /^run-[0-9a-f]{32}$/)
  const before = llm.requests.length
  // The engine runs the step again (its result was lost): applied already, nothing runs.
  assert.deepEqual(await runTurnPhase(deps, 's1', 1, 0), { status: 'completed' })
  assert.equal(llm.requests.length, before)
  assert.equal(writes('alpha'), 1)
})

test('the outcome was lost before it reached the object: the retry returns it from the snapshot, no call made', async () => {
  const t = await session('note: beta')
  const deps = depsOf(t)
  // The first attempt ran the turn, but its report never arrived.
  const real = deps.port('s1')
  let dropped = false
  const lossy = new Proxy(real, {
    get: (target, name) =>
      name === 'turnOutcome' && !dropped
        ? async () => {
            dropped = true
            throw new Error('the object could not be reached')
          }
        : (target as unknown as Record<string | symbol, unknown>)[name],
  })
  await assert.rejects(
    runTurnPhase({ ...deps, port: () => lossy }, 's1', 1, 0),
    /could not be reached/,
  )
  assert.equal(writes('beta'), 1)
  const before = llm.requests.length
  assert.deepEqual(await runTurnPhase(deps, 's1', 1, 0), { status: 'completed' })
  assert.equal(llm.requests.length, before, 'no model call')
  assert.equal(writes('beta'), 1)
})

test('parking: ask-writes parks the phase; the answers resume the same run in the next one; the write runs once', async () => {
  const t = await session('note: gamma')
  const deps = depsOf(t, { AGENT_TOOL_APPROVAL: 'ask-writes' })
  assert.deepEqual(await runTurnPhase(deps, 's1', 1, 0), { status: 'parked' })
  assert.equal(writes('gamma'), 0)
  const v = t.host.view()
  assert.ok(v.ok && v.value.parked)
  const item = v.value.parked.requests[0]!
  assert.equal(item.kind, 'approval')
  t.host.answer({ requestId: item.requestId, value: { approved: true }, at: 1 })
  await t.drain()
  const resumes = llm.requests.length
  assert.deepEqual(await runTurnPhase(deps, 's1', 1, 1), { status: 'completed' })
  assert.equal(writes('gamma'), 1)
  const planner = llm.requests.slice(resumes).filter((r) => stageOf(r) === 'planner')
  assert.equal(planner.length, 0, 'the resume replays: the planner is not asked again')
  const row = latestRunOfTurn(sqlOf(t), 's1', 1)!
  assert.equal(row.snapshot?.attempt, 2, 'the same run, one attempt on')
})

test('a stop reaches the running step through its heartbeat: the run is cancelled, the phase stopped', async () => {
  const t = await session('note: delta')
  override = (req) => (stageOf(req) === 'executor' ? { text: 'slow', delayMs: 4000 } : undefined)
  try {
    const run = runTurnPhase(depsOf(t), 's1', 1, 0)
    setTimeout(() => t.host.stop({ at: 1 }), 600)
    const t0 = Date.now()
    assert.deepEqual(await run, { status: 'stopped' })
    assert.ok(Date.now() - t0 < 3500, 'before the slow answer')
    const row = latestRunOfTurn(sqlOf(t), 's1', 1)!
    assert.equal(row.snapshot?.status, 'cancelled')
    const v = t.host.view()
    assert.ok(v.ok && v.value.turns[0]?.status === 'stopped')
  } finally {
    override = undefined
  }
})

test('a refusal (the provider refuses the key) is a TurnRefused: the Workflow does not retry it', async () => {
  const t = await session('hello')
  override = (req) => (stageOf(req) === 'executor' ? { status: 401, text: 'bad key' } : undefined)
  try {
    await assert.rejects(
      runTurnPhase(depsOf(t), 's1', 1, 0),
      (err: unknown) => err instanceof TurnRefused,
    )
  } finally {
    override = undefined
  }
})

test('an attempt the engine gave up on BEFORE its first snapshot is superseded: its write never runs, the turn ends once', async () => {
  const t = await session('note: epsilon')
  let first = true
  // The first attempt's planner answer comes late: that attempt is "paused" before its plan.
  override = (req) => {
    if (stageOf(req) === 'planner' && first) {
      first = false
      return { text: plan, delayMs: 2500 }
    }
    return undefined
  }
  try {
    const deps = depsOf(t)
    const zombie = runTurnPhase(deps, 's1', 1, 0).then(
      (r) => ({ ok: r }),
      (err: unknown) => ({ err }),
    )
    // Its run is bound (the lease's acquire), its planner call out.
    for (let i = 0; i < 100 && !latestRunOfTurn(sqlOf(t), 's1', 1); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const r1 = latestRunOfTurn(sqlOf(t), 's1', 1)!
    assert.equal(r1.runNo, 1)
    // The retry: run 1 has no plan - superseded; the turn's run 2 does the work.
    assert.deepEqual(await runTurnPhase(deps, 's1', 1, 0), { status: 'completed' })
    const r2 = latestRunOfTurn(sqlOf(t), 's1', 1)!
    assert.equal(r2.runNo, 2)
    assert.equal(writes('epsilon'), 1)
    // The late attempt wakes: its first write is refused, it stops before any tool call runs.
    const late = await zombie
    assert.ok('err' in late, 'the superseded attempt failed')
    assert.match(
      String((late.err as Error).message),
      /may not append|lost the run|left this attempt/,
    )
    assert.equal(writes('epsilon'), 1, 'the superseded attempt wrote nothing')
    assert.equal(loadRun(sqlOf(t), r1.runId), null, 'it put nothing on record')
    const v = t.host.view()
    assert.ok(v.ok)
    assert.equal(v.value.turns.length, 1)
    assert.equal(v.value.turns[0]?.runId, r2.runId)
  } finally {
    override = undefined
  }
})

test('an attempt the engine gave up on AFTER its plan is revoked: it stops, the retry takes the run once its lease ran out', async () => {
  const t = await session('note: zeta')
  let slow = true
  // The first attempt hangs in its executor call (after the plan is on record).
  override = (req) => {
    if (stageOf(req) === 'executor' && slow && toolResults(req).length === 0) {
      slow = false
      return { toolCalls: [{ name: 'write_note', args: { text: 'zeta' } }], delayMs: 2500 }
    }
    return undefined
  }
  try {
    const deps = depsOf(t)
    const zombie = runTurnPhase(deps, 's1', 1, 0).then(
      (r) => ({ ok: r }),
      (err: unknown) => ({ err: err as Error }),
    )
    for (let i = 0; i < 200 && !latestRunOfTurn(sqlOf(t), 's1', 1)?.snapshot?.plan; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    // The retry: the run has a plan - a resume, which must wait for the holder's lease.
    const retry = await runTurnPhase(deps, 's1', 1, 0)
    assert.deepEqual(retry, { status: 'completed' })
    const late = await zombie
    assert.ok('err' in late, 'the revoked attempt failed')
    assert.match(late.err.message, /lease|lost the run|left this attempt/i)
    assert.equal(writes('zeta'), 1, 'the write ran once')
    const row = latestRunOfTurn(sqlOf(t), 's1', 1)!
    assert.equal(row.runNo, 1, 'the same run, resumed')
    assert.equal(row.snapshot?.status, 'complete')
    assert.equal(row.snapshot?.attempt, 2)
    // The resume took the run by its fence: from then on attempt 1 writes nothing.
    assert.equal(row.fence, 2)
    assert.equal(
      await deps.port('s1').appendJournal(row.runId, {
        id: 'a1:tool:late',
        position: 'late',
        attempt: 1,
        at: 1,
        kind: 'tool',
      } as never),
      false,
    )
  } finally {
    override = undefined
  }
})
