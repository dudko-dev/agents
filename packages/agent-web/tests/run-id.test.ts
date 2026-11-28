import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgent,
  MemoryRunStore,
  type AgentEvent,
  type RunPersistence,
  type RunSnapshot,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// run(goal, { runId }): a fresh run under the caller's id instead of a random one, so that a host
// keying runs by ids of its own (a session and a turn) finds the same run on a retry. The Node
// sibling's option and rules: the rule of every run id, refused together with resumeFromRunId,
// and a run on record is never written over. Every refusal throws before anything of the run:
// no model call, no event, no write.

const route = (info: CallInfo): Reply => {
  switch (stageOf(info)) {
    case 'planner':
      return {
        text: JSON.stringify({
          thought: 'plan',
          steps: [{ description: 'Gather' }, { description: 'Write' }],
        }),
      }
    case 'executor':
      return { text: 'did it' }
    default:
      return { text: 'All done.' }
  }
}

// A store that keeps every snapshot by id and logs what it is asked, in order.
const store = (seed: RunSnapshot[] = []) => {
  const saved = new Map<string, RunSnapshot>(seed.map((s) => [s.runId, structuredClone(s)]))
  const log: string[] = []
  const write = (hook: string) => (snapshot: RunSnapshot) => {
    log.push(`${hook}:${snapshot.runId}`)
    saved.set(snapshot.runId, structuredClone(snapshot))
  }
  const persistence: RunPersistence = {
    onRunStart: write('onRunStart'),
    onStepComplete: write('onStepComplete'),
    onRunComplete: write('onRunComplete'),
    onRunResume: write('onRunResume'),
    loadRun: (runId) => {
      log.push(`loadRun:${runId}`)
      return structuredClone(saved.get(runId) ?? null)
    },
  }
  return { saved, log, persistence }
}

const snapshotOf = (runId: string, status: RunSnapshot['status']): RunSnapshot => ({
  runId,
  startedAt: 1,
  status,
  goal: 'an earlier turn',
  sessionId: 'default',
  plan: { thought: 't', steps: [{ id: 's1', description: 'a' }] } as RunSnapshot['plan'],
  remaining: [{ id: 's1', description: 'a' }] as RunSnapshot['remaining'],
  trace: [],
  done: [],
  findings: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as RunSnapshot['usage'],
  iterations: 0,
  revisions: 0,
  toolCalls: 0,
  applied: 0,
  skills: [],
  discovered: [],
  attachments: 0,
})

const collect = () => {
  const events: AgentEvent[] = []
  return { events, onEvent: (e: AgentEvent) => events.push(e) }
}

test('runId: a fresh run takes the caller id - its run.start, every snapshot and the result carry it', async () => {
  const model = scriptedModel(route)
  const { saved, log, persistence } = store()
  const agent = await createAgent({ model: model.model, persistence })
  const { events, onEvent } = collect()
  const result = await agent.run('do it', { runId: 'session-42_turn-3', onEvent })

  assert.equal(result.runId, 'session-42_turn-3')
  assert.equal(result.final, 'All done.')
  const start = events.find((e) => e.type === 'run.start')
  assert.ok(start?.type === 'run.start')
  assert.equal(start.runId, 'session-42_turn-3')
  assert.deepEqual([...saved.keys()], ['session-42_turn-3'])
  assert.equal(saved.get('session-42_turn-3')?.status, 'complete')
  // The id was looked up first (free), then every write went under it.
  assert.equal(log[0], 'loadRun:session-42_turn-3')
  assert.ok(log.slice(1).every((entry) => entry.endsWith(':session-42_turn-3')))
  assert.ok(log.includes('onRunStart:session-42_turn-3'))
})

test('runId: a fresh run without one still gets an id of its own, and nothing is looked up', async () => {
  const model = scriptedModel(route)
  const { saved, log, persistence } = store()
  const agent = await createAgent({ model: model.model, persistence })
  const result = await agent.run('do it')
  assert.match(result.runId, /^[A-Za-z0-9_-]{1,128}$/)
  assert.deepEqual([...saved.keys()], [result.runId])
  assert.ok(!log.some((entry) => entry.startsWith('loadRun')))
})

test('runId: an id that breaks the rule is refused before anything of the run', async () => {
  const model = scriptedModel(route)
  const { saved, log, persistence } = store()
  const agent = await createAgent({ model: model.model, persistence })
  const bad: unknown[] = [
    '',
    'a/b',
    '../escape',
    'a.b',
    'with space',
    'ünicode',
    'x'.repeat(129),
    42,
    null,
  ]
  for (const runId of bad) {
    const { events, onEvent } = collect()
    await assert.rejects(
      agent.run('do it', { runId: runId as string, onEvent }),
      /runId must be 1-128 characters/,
      JSON.stringify(runId),
    )
    assert.deepEqual(events, [], `${JSON.stringify(runId)}: no event`)
  }
  assert.equal(model.calls.length, 0, 'no model call')
  assert.deepEqual(log, [], 'nothing looked up, nothing written')
  assert.equal(saved.size, 0)
  // The longest id the rule takes is taken.
  const longest = 'x'.repeat(128)
  assert.equal((await agent.run('do it', { runId: longest })).runId, longest)
})

test('runId: refused together with resumeFromRunId', async () => {
  const model = scriptedModel(route)
  const { log, persistence } = store([snapshotOf('crashed', 'executing')])
  const agent = await createAgent({ model: model.model, persistence })
  const { events, onEvent } = collect()
  await assert.rejects(
    agent.run('', { runId: 'other', resumeFromRunId: 'crashed', onEvent }),
    /runId names a fresh run and cannot be combined with resumeFromRunId/,
  )
  await assert.rejects(
    agent.run('', { runId: 'crashed', resumeFromRunId: 'crashed' }),
    /cannot be combined with resumeFromRunId/,
    'even when both name the same run',
  )
  assert.deepEqual(events, [])
  assert.deepEqual(log, [], 'neither id was looked up')
  assert.equal(model.calls.length, 0)
})

test('runId: an id that names a run on record is refused - resume it instead; it is never written over', async () => {
  const model = scriptedModel(route)
  for (const status of ['executing', 'failed', 'cancelled', 'complete'] as const) {
    const before = snapshotOf('taken', status)
    const { saved, log, persistence } = store([before])
    const agent = await createAgent({ model: model.model, persistence })
    const { events, onEvent } = collect()
    await assert.rejects(
      agent.run('a new turn', { runId: 'taken', onEvent }),
      new RegExp(
        `Run "taken" already exists \\(status "${status}"\\); resume it with resumeFromRunId`,
      ),
    )
    assert.deepEqual(events, [], `${status}: no event`)
    assert.deepEqual(log, ['loadRun:taken'], `${status}: looked up, nothing written`)
    assert.deepEqual(saved.get('taken'), before, `${status}: the record is untouched`)
  }
  assert.equal(model.calls.length, 0)
})

test('runId: a store that cannot answer refuses the run (no answer is not "free")', async () => {
  const model = scriptedModel(route)
  const agent = await createAgent({
    model: model.model,
    persistence: {
      loadRun: () => {
        throw new Error('the store is down')
      },
    },
  })
  await assert.rejects(agent.run('do it', { runId: 'r1' }), /the store is down/)
  assert.equal(model.calls.length, 0)
})

test('runId: the host flow - a retry under the same id is refused, and resuming that id finishes the run', async () => {
  const model = scriptedModel(route)
  const runs = new MemoryRunStore()
  const controller = new AbortController()
  const first = await createAgent({
    model: model.model,
    persistence: {
      onRunStart: (s) => runs.onRunStart(s),
      onStepComplete: (s) => {
        runs.onStepComplete(s)
        controller.abort() // the tab dies after its first checkpoint
      },
      loadRun: (id) => runs.loadRun(id),
    },
  })
  const r1 = await first.run('do it', { runId: 'turn-7', signal: controller.signal })
  assert.equal(r1.stopped, true)
  assert.equal(r1.runId, 'turn-7')
  assert.equal(runs.loadRun('turn-7')?.trace.length, 1)

  const second = await createAgent({ model: model.model, persistence: runs })
  await assert.rejects(second.run('do it', { runId: 'turn-7' }), /resume it/)
  const { events, onEvent } = collect()
  const r2 = await second.run('', { resumeFromRunId: 'turn-7', onEvent })
  assert.equal(r2.runId, 'turn-7')
  assert.equal(r2.final, 'All done.')
  assert.deepEqual([...new Set(events.map((e) => e.attempt))], [2])
})
