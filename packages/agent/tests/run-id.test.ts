import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent, IJournalEntry, IPersistence, IRunSnapshot } from '../src/index.ts'
import { collect, config, linearScript, withLlm } from './helpers/loop.ts'

// agent.run({ runId }): a fresh run under the caller's id instead of a random UUID, so that a host
// keying runs by ids of its own (a session and a turn) finds the same run on a retry. The id
// follows the rule of every runId, is refused together with resumeFromRunId, and is never used
// to write over a run that is on record. Every refusal happens before anything of the run: no
// model call, no event, no write.

// A store that keeps every snapshot by id and logs what it is asked, in order.
const store = (seed: IRunSnapshot[] = []) => {
  const saved = new Map<string, IRunSnapshot>(seed.map((s) => [s.runId, structuredClone(s)]))
  const log: string[] = []
  const write = (hook: string) => (snapshot: IRunSnapshot) => {
    log.push(`${hook}:${snapshot.runId}`)
    saved.set(snapshot.runId, structuredClone(snapshot))
  }
  const persistence: IPersistence = {
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

const snapshotOf = (runId: string, status: IRunSnapshot['status']): IRunSnapshot => ({
  runId,
  startedAt: 1,
  status,
  input: 'an earlier turn',
  plan: { thought: '', steps: [{ id: 's1', description: 'x', expectedOutcome: 'y' }] },
  trace: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  stepIndex: 0,
  iterations: 0,
  revisions: 0,
})

test('runId: a fresh run takes the caller id - every event, every snapshot and the result carry it', async () => {
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    const { saved, log, persistence } = store()
    const agent = await open(config(llm.baseURL, { persistence }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'do it', runId: 'session-42_turn-3', onEvent })

    assert.equal(result.runId, 'session-42_turn-3')
    assert.equal(result.text, 'All done.')
    assert.ok(events.length > 0)
    assert.deepEqual([...new Set(events.map((e: AgentEvent) => e.runId))], ['session-42_turn-3'])
    assert.deepEqual([...saved.keys()], ['session-42_turn-3'])
    assert.equal(saved.get('session-42_turn-3')?.status, 'complete')
    // The id was looked up first (free), then every write went under it.
    assert.equal(log[0], 'loadRun:session-42_turn-3')
    assert.ok(log.slice(1).every((entry) => entry.endsWith(':session-42_turn-3')))
    assert.ok(log.includes('onRunStart:session-42_turn-3'))
  })
})

test('runId: a fresh run without one still gets a random UUID, and the result names it', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const { saved, log, persistence } = store()
    const agent = await open(config(llm.baseURL, { persistence }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'do it', onEvent })
    assert.match(result.runId ?? '', /^[0-9a-f-]{36}$/)
    assert.deepEqual([...saved.keys()], [result.runId])
    assert.equal(events[0].runId, result.runId)
    assert.ok(!log.some((entry) => entry.startsWith('loadRun')), 'nothing is looked up')
  })
})

test('runId: an id that breaks the rule is refused before anything of the run', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const { saved, log, persistence } = store()
    const agent = await open(config(llm.baseURL, { persistence }))
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
        agent.run({ input: 'do it', runId: runId as string, onEvent }),
        /Unsafe runId from options\.runId/,
        JSON.stringify(runId),
      )
      assert.deepEqual(events, [], `${JSON.stringify(runId)}: no event`)
    }
    assert.equal(llm.requests.length, 0, 'no model call')
    assert.deepEqual(log, [], 'nothing looked up, nothing written')
    assert.equal(saved.size, 0)
    // The longest id the rule takes is taken.
    const longest = 'x'.repeat(128)
    assert.equal((await agent.run({ input: 'do it', runId: longest })).runId, longest)
  })
})

test('runId: refused together with resumeFromRunId', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const { log, persistence } = store([snapshotOf('crashed', 'executing')])
    const agent = await open(config(llm.baseURL, { persistence }))
    const { events, onEvent } = collect()
    await assert.rejects(
      agent.run({ input: '', runId: 'other', resumeFromRunId: 'crashed', onEvent }),
      /options\.runId names a fresh run and cannot be combined with resumeFromRunId/,
    )
    await assert.rejects(
      agent.run({ input: '', runId: 'crashed', resumeFromRunId: 'crashed' }),
      /cannot be combined with resumeFromRunId/,
      'even when both name the same run',
    )
    assert.deepEqual(events, [])
    assert.deepEqual(log, [], 'neither id was looked up')
    assert.equal(llm.requests.length, 0)
  })
})

test('runId: an id that names a run on record is refused - resume it instead; it is never written over', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    for (const status of ['executing', 'waiting', 'failed', 'cancelled', 'complete'] as const) {
      const before = snapshotOf('taken', status)
      const { saved, log, persistence } = store([before])
      const agent = await open(config(llm.baseURL, { persistence }))
      const { events, onEvent } = collect()
      await assert.rejects(
        agent.run({ input: 'a new turn', runId: 'taken', onEvent }),
        new RegExp(
          `Run "taken" already exists \\(status "${status}"\\); resume it with resumeFromRunId`,
        ),
      )
      assert.deepEqual(events, [], `${status}: no event`)
      assert.deepEqual(log, ['loadRun:taken'], `${status}: looked up, nothing written`)
      assert.deepEqual(saved.get('taken'), before, `${status}: the record is untouched`)
    }
    assert.equal(llm.requests.length, 0)
  })
})

test('runId: an id with a call journal but no snapshot is refused - the two runs would share one journal', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const { saved, log, persistence } = store()
    const journals = new Map<string, IJournalEntry[]>([
      ['half-started', [{ id: 'a1:model:0.1', kind: 'model', position: '0.1' } as IJournalEntry]],
    ])
    const appended: string[] = []
    const agent = await open(
      config(llm.baseURL, {
        persistence: {
          ...persistence,
          journal: {
            append: (runId, entry) => {
              appended.push(runId)
              journals.set(runId, [...(journals.get(runId) ?? []), entry])
            },
            load: (runId) => journals.get(runId) ?? [],
          },
        },
      }),
    )
    await assert.rejects(
      agent.run({ input: 'do it', runId: 'half-started' }),
      /Run "half-started" already has a call journal \(1 entries\) but no snapshot/,
    )
    assert.deepEqual(appended, [], 'nothing appended')
    assert.equal(saved.size, 0)
    assert.equal(llm.requests.length, 0)
    // A free id with a journal hook runs, and its journal is its own.
    const result = await agent.run({ input: 'do it', runId: 'fresh' })
    assert.equal(result.runId, 'fresh')
    assert.ok(appended.length > 0 && appended.every((id) => id === 'fresh'))
    assert.deepEqual(
      log.filter((entry) => entry.startsWith('loadRun')),
      ['loadRun:half-started', 'loadRun:fresh'],
    )
  })
})

test('runId: a store that cannot answer refuses the run (no answer is not "free")', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const agent = await open(
      config(llm.baseURL, {
        persistence: {
          loadRun: () => {
            throw new Error('the store is down')
          },
        },
      }),
    )
    await assert.rejects(agent.run({ input: 'do it', runId: 'r1' }), /the store is down/)
    assert.equal(llm.requests.length, 0)
  })
})

test('runId: with a run lease the id is looked up while the lease is held', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const { log, persistence } = store()
    const agent = await open(
      config(llm.baseURL, {
        persistence,
        runLease: {
          acquire: (runId) => {
            log.push(`acquire:${runId}`)
            return true
          },
          renew: () => true,
          release: (runId) => {
            log.push(`release:${runId}`)
          },
        },
      }),
    )
    await agent.run({ input: 'do it', runId: 'leased' })
    assert.deepEqual(log.slice(0, 2), ['acquire:leased', 'loadRun:leased'])
    // A refusal gives the lease back.
    log.length = 0
    await assert.rejects(agent.run({ input: 'again', runId: 'leased' }), /already exists/)
    assert.deepEqual(log, ['acquire:leased', 'loadRun:leased', 'release:leased'])
  })
})

test('runId: the host flow - a retry under the same id is refused, and resuming that id finishes the run', async () => {
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    const { saved, persistence } = store()
    const controller = new AbortController()
    const first = await open(
      config(llm.baseURL, {
        persistence: {
          ...persistence,
          onStepComplete: (snapshot) => {
            persistence.onStepComplete?.(snapshot)
            controller.abort() // the worker dies after its first checkpoint
          },
        },
      }),
    )
    await assert.rejects(
      first.run({ input: 'do it', runId: 'turn-7', signal: controller.signal }),
      /abort/i,
    )
    assert.equal(saved.get('turn-7')?.trace.length, 1)

    const second = await open(config(llm.baseURL, { persistence }))
    await assert.rejects(second.run({ input: 'do it', runId: 'turn-7' }), /resume it/)
    const { events, onEvent } = collect()
    const result = await second.run({ input: '', resumeFromRunId: 'turn-7', onEvent })
    assert.equal(result.runId, 'turn-7')
    assert.equal(result.text, 'All done.')
    assert.deepEqual([...new Set(events.map((e) => e.runId))], ['turn-7'])
    assert.deepEqual([...new Set(events.map((e) => e.attempt))], [2])
  })
})
