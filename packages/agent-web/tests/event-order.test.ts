import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgent,
  MemoryRunStore,
  resolveResume,
  type AgentEvent,
  type RunPersistence,
  type RunSnapshot,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// Event order across crashes, the Node sibling's contract and names: every event of a run
// carries `seq` (1, 2, ... within one attempt) and `attempt` (1 for the run as first started, one
// more for every resume), and (attempt, seq) orders the events of a run totally - however many
// times its tab died, and wherever. A resume puts its attempt on record BEFORE it emits anything.

const STEPS = ['Gather the data', 'Analyse the data', 'Write the report']
const plan = (steps: string[]) =>
  JSON.stringify({ thought: 'plan', steps: steps.map((description) => ({ description })) })
const stepOf = (info: CallInfo): string => /STEP \d+\/\d+: ([^\n]+)/.exec(info.user)?.[1] ?? '?'
const route = (info: CallInfo): Reply => {
  switch (stageOf(info)) {
    case 'planner':
      return { text: plan(STEPS) }
    case 'executor':
      return { text: `did: ${stepOf(info)}` }
    default:
      return { text: 'All three steps done.' }
  }
}

const seqs = (events: AgentEvent[]): number[] => events.map((e) => e.seq as number)
const attempts = (events: AgentEvent[]): (number | undefined)[] => [
  ...new Set(events.map((e) => e.attempt)),
]
const oneTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)
const collect = () => {
  const events: AgentEvent[] = []
  return { events, onEvent: (e: AgentEvent) => events.push(e) }
}

// What a crash leaves: the last write, nothing else (a dead tab writes no onRunComplete).
const crashStore = (options: { resumeHook?: boolean } = {}) => {
  const saved = new Map<string, RunSnapshot>()
  const timeline: string[] = []
  const write = (hook: string) => (s: RunSnapshot) => {
    timeline.push(`write:${hook}:${s.attempt}`)
    saved.set(s.runId, structuredClone(s))
  }
  const persistence: RunPersistence = {
    onRunStart: write('onRunStart'),
    onStepComplete: write('onStepComplete'),
    ...(options.resumeHook === false ? {} : { onRunResume: write('onRunResume') }),
    loadRun: (id) => structuredClone(saved.get(id) ?? null),
  }
  return { saved, timeline, persistence }
}

// Stopped right after `n` steps were checkpointed (by attempt `attempt`).
const dyingAt = (inner: RunPersistence, n: number) => {
  const controller = new AbortController()
  const persistence: RunPersistence = {
    ...inner,
    onStepComplete: async (s) => {
      await inner.onStepComplete?.(s)
      if (s.trace.length === n) controller.abort()
    },
  }
  return { controller, persistence }
}

test('event order: a fresh run numbers its events 1..n under attempt 1; the snapshot carries the attempt', async () => {
  const model = scriptedModel(route)
  const store = new MemoryRunStore({ keepCompleted: true })
  const agent = await createAgent({ model: model.model, persistence: store })
  const { events, onEvent } = collect()
  const r = await agent.run('three things', { onEvent })
  assert.ok(events.length > 5)
  assert.deepEqual(seqs(events), oneTo(events.length))
  assert.deepEqual(attempts(events), [1])
  assert.equal(store.loadRun(r.runId)?.attempt, 1)
})

test('event order: with no persistence nothing breaks - the events are numbered all the same', async () => {
  const model = scriptedModel(route)
  const agent = await createAgent({ model: model.model })
  const { events, onEvent } = collect()
  const r = await agent.run('three things', { onEvent })
  assert.equal(r.final, 'All three steps done.')
  assert.deepEqual(seqs(events), oneTo(events.length))
  assert.deepEqual(attempts(events), [1])
})

test('event order: a resume continues under attempt 2, recorded before any of its events', async () => {
  const model = scriptedModel(route)
  const { saved, timeline, persistence } = crashStore()
  const dying = dyingAt(persistence, 1)
  const first = await createAgent({ model: model.model, persistence: dying.persistence })
  const before = collect()
  const r1 = await first.run('three things', {
    signal: dying.controller.signal,
    onEvent: before.onEvent,
  })
  assert.equal(r1.stopped, true)
  assert.equal(saved.get(r1.runId)?.attempt, 1)

  const second = await createAgent({ model: model.model, persistence })
  const after = collect()
  const r2 = await second.run('', {
    resumeFromRunId: r1.runId,
    onEvent: (e) => {
      timeline.push(`event:${e.attempt}:${e.seq}`)
      after.onEvent(e)
    },
  })
  assert.equal(r2.trace.length, 3)
  assert.deepEqual(attempts(before.events), [1])
  assert.deepEqual(attempts(after.events), [2])
  assert.deepEqual(seqs(after.events), oneTo(after.events.length))
  const resumeWrite = timeline.indexOf('write:onRunResume:2')
  assert.ok(resumeWrite >= 0, timeline.join(' '))
  assert.ok(resumeWrite < timeline.findIndex((t) => t.startsWith('event:')))
  assert.ok(timeline.includes('write:onStepComplete:2'), 'its checkpoints carry it too')
  const all = [...before.events, ...after.events]
  const sorted = [...all].sort(
    (a, b) =>
      (a.attempt as number) - (b.attempt as number) || (a.seq as number) - (b.seq as number),
  )
  assert.deepEqual(sorted, all)
})

test('event order: a crash right after a resume started - before its first checkpoint - still gives attempt 3', async () => {
  const model = scriptedModel(route)
  const { saved, persistence } = crashStore()
  const dying = dyingAt(persistence, 1)
  const first = await createAgent({ model: model.model, persistence: dying.persistence })
  const r1 = await first.run('three things', { signal: dying.controller.signal })

  const dies = new AbortController()
  const second = await createAgent({ model: model.model, persistence })
  const secondEvents = collect()
  const r2 = await second.run('', {
    resumeFromRunId: r1.runId,
    signal: dies.signal,
    onEvent: (e) => {
      secondEvents.onEvent(e)
      dies.abort()
    },
  })
  assert.equal(r2.stopped, true)
  assert.deepEqual(attempts(secondEvents.events), [2])
  assert.equal(saved.get(r1.runId)?.attempt, 2, 'only the resume write is on record')
  assert.equal(saved.get(r1.runId)?.trace.length, 1)

  const third = await createAgent({ model: model.model, persistence })
  const thirdEvents = collect()
  const r3 = await third.run('', { resumeFromRunId: r1.runId, onEvent: thirdEvents.onEvent })
  assert.equal(r3.trace.length, 3)
  assert.deepEqual(attempts(thirdEvents.events), [3], 'never a second attempt 2')
  assert.deepEqual(seqs(thirdEvents.events), oneTo(thirdEvents.events.length))
})

test('event order: without onRunResume the resume write goes to onStepComplete, still before any event', async () => {
  const model = scriptedModel(route)
  const { saved, timeline, persistence } = crashStore({ resumeHook: false })
  const dying = dyingAt(persistence, 1)
  const first = await createAgent({ model: model.model, persistence: dying.persistence })
  const r1 = await first.run('three things', { signal: dying.controller.signal })
  assert.equal(saved.get(r1.runId)?.attempt, 1)
  timeline.length = 0
  const second = await createAgent({ model: model.model, persistence })
  await second.run('', {
    resumeFromRunId: r1.runId,
    onEvent: (e) => timeline.push(`event:${e.attempt}:${e.seq}`),
  })
  assert.equal(timeline[0], 'write:onStepComplete:2', timeline.slice(0, 3).join(' '))
  assert.equal(timeline[1], 'event:2:1')
})

test('event order: a resume whose attempt cannot be recorded is refused before anything runs', async () => {
  const model = scriptedModel(route)
  const { saved, persistence } = crashStore()
  const dying = dyingAt(persistence, 1)
  const first = await createAgent({ model: model.model, persistence: dying.persistence })
  const r1 = await first.run('three things', { signal: dying.controller.signal })
  assert.ok(saved.get(r1.runId))
  const calls = model.calls.length
  const second = await createAgent({
    model: model.model,
    persistence: {
      ...persistence,
      onRunResume: () => {
        throw new Error('store is down')
      },
    },
  })
  const { events, onEvent } = collect()
  await assert.rejects(
    second.run('', { resumeFromRunId: r1.runId, onEvent }),
    /onRunResume threw while recording attempt 2.*store is down/,
  )
  assert.equal(events.length, 0, 'not one event')
  assert.equal(model.calls.length, calls, 'not one model call')
})

test('event order: a snapshot whose attempt is not a positive integer is not resumed', async () => {
  const snapshot = (attempt: unknown): RunSnapshot =>
    ({
      runId: 'run-1',
      startedAt: 1,
      status: 'executing',
      goal: 'g',
      sessionId: 'default',
      plan: { thought: 't', steps: [{ id: 's1', description: 'a' }] },
      remaining: [{ id: 's1', description: 'a' }],
      trace: [],
      done: [],
      findings: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      iterations: 0,
      revisions: 0,
      toolCalls: 0,
      applied: 0,
      skills: [],
      discovered: [],
      attachments: 0,
      attempt,
    }) as unknown as RunSnapshot
  for (const bad of [0, -1, 1.5, Number.NaN, '2', null, Infinity]) {
    await assert.rejects(
      resolveResume({ loadRun: () => snapshot(bad) }, 'run-1'),
      /invalid attempt/,
      `refuses ${String(bad)}`,
    )
  }
  for (const ok of [undefined, 1, 7]) {
    assert.ok(await resolveResume({ loadRun: () => snapshot(ok) }, 'run-1'))
  }
})

test('event order: a dynamic helper envelope is numbered in the parent run; the helper event keeps its own numbers', async () => {
  const model = scriptedModel((info) => {
    const helper = info.user.includes('HELPER TASK') && !info.user.includes('Delegate it')
    const stage = stageOf(info)
    if (stage === 'planner') return { text: plan(['one step']) }
    if (stage === 'synthesizer') return { text: helper ? 'helper answer' : 'Parent done.' }
    if (helper) return { text: 'helper did it' }
    return info.toolResults === 0
      ? { toolCalls: [{ name: 'spawn_subagent', args: { task: 'HELPER TASK: look' } }] }
      : { text: 'parent got it' }
  })
  const agent = await createAgent({ model: model.model, subagents: { dynamic: true } })
  const { events, onEvent } = collect()
  const r = await agent.run('Delegate it', { onEvent })
  assert.equal(r.final, 'Parent done.')
  assert.deepEqual(seqs(events), oneTo(events.length), 'the envelopes included, without a gap')
  const inner = events.flatMap((e) => (e.type === 'subagent.event' ? [e.event] : []))
  assert.ok(inner.length > 3)
  assert.deepEqual(seqs(inner), oneTo(inner.length))
  assert.deepEqual(attempts(inner), [1])
})
