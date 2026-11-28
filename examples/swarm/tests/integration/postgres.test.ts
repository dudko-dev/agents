// The Postgres adapters against a real Postgres: the migration, snapshot fencing, the event log
// and its NOTIFY, and the shared token bucket delaying and refusing.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import type { AgentEvent, IRunSnapshot } from '@dudko.dev/agent'
import pg from 'pg'
import type { IJournalEntry } from '@dudko.dev/agent'
import { createEventStore, EVENTS_CHANNEL } from '../../src/db/events.ts'
import {
  appendJournalSql,
  createPostgresJournal,
  JournalFencedError,
} from '../../src/db/journal.ts'
import { createParkedStore } from '../../src/db/parked.ts'
import { createPostgresLimits, RateLimitRefusal } from '../../src/db/limiter.ts'
import { migrate } from '../../src/db/migrate.ts'
import { createNotifyHub } from '../../src/db/notify.ts'
import { createPool } from '../../src/db/pool.ts'
import {
  createPostgresPersistence,
  createRunStore,
  SnapshotFencedError,
} from '../../src/db/runs.ts'
import { DATABASE_URL, migrated } from './harness.ts'

let pool: pg.Pool

before(async () => {
  pool = await migrated()
})

after(async () => {
  await pool?.end()
})

const snapshot = (
  runId: string,
  attempt: number,
  extra: Partial<IRunSnapshot> = {},
): IRunSnapshot => ({
  runId,
  startedAt: 1,
  status: 'executing',
  input: 'hi',
  plan: { thought: 't', steps: [{ id: 'a', description: 'a', expectedOutcome: 'a' }] },
  trace: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  stepIndex: 0,
  iterations: 0,
  revisions: 0,
  attempt,
  ...extra,
})

test('migrate is idempotent', async () => {
  assert.deepEqual(await migrate(pool), [])
  const r = await pool.query('SELECT name FROM swarm_migrations ORDER BY name')
  assert.deepEqual(
    r.rows.map((x) => x.name),
    ['001_init.sql', '002_parking.sql'],
  )
})

test('snapshots: bound to a turn, fenced by attempt', async () => {
  const runs = createRunStore(pool)
  const persistence = createPostgresPersistence(pool)
  const sessionId = randomUUID()
  const runId = randomUUID()
  assert.equal(await runs.bindRun({ runId, sessionId, turn: 1, runNo: 1, attemptBase: 0 }), true)
  // The same slot cannot be bound twice (a worker that lost the turn and does not know yet).
  assert.equal(
    await runs.bindRun({ runId: randomUUID(), sessionId, turn: 1, runNo: 1, attemptBase: 0 }),
    false,
  )
  await persistence.onRunStart!(snapshot(runId, 1))
  await persistence.onStepComplete!(snapshot(runId, 1, { stepIndex: 1 }))
  await persistence.onRunResume!(snapshot(runId, 2, { stepIndex: 1 }))
  // A late checkpoint of attempt 1 (the worker that lost the turn) is refused, and so is a second
  // resume to the same attempt.
  await assert.rejects(
    async () => persistence.onStepComplete!(snapshot(runId, 1, { stepIndex: 2 })),
    SnapshotFencedError,
  )
  await assert.rejects(
    async () => persistence.onRunResume!(snapshot(runId, 2)),
    SnapshotFencedError,
  )
  await persistence.onRunComplete!(snapshot(runId, 2, { status: 'complete', text: 'ok' }))
  const loaded = await persistence.loadRun!(runId)
  assert.equal(loaded?.attempt, 2)
  assert.equal(loaded?.status, 'complete')
  assert.equal(loaded?.text, 'ok')
  assert.equal(await persistence.loadRun!(randomUUID()), null)
  const latest = await runs.latestRunOfTurn(sessionId, 1)
  assert.equal(latest?.runId, runId)
  assert.equal(latest?.attempt, 2)
  // A second run of the turn starts above every attempt the first one had.
  assert.equal(await runs.nextAttemptBase(sessionId, 1), 2)
  // A write for a run that was never bound has nowhere to go.
  await assert.rejects(
    async () => persistence.onStepComplete!(snapshot(randomUUID(), 1)),
    SnapshotFencedError,
  )
})

const event = (runId: string, attempt: number, seq: number, extra: object = {}): AgentEvent =>
  ({ type: 'log', level: 'info', message: `m${seq}`, runId, attempt, seq, ...extra }) as AgentEvent

test('events: batched, ordered by (turn, attempt, seq), NOTIFY on insert, NUL survives', async () => {
  const store = createEventStore(pool, 262_144)
  const sessionId = randomUUID()
  const runId = randomUUID()
  const listener = new pg.Client({ connectionString: DATABASE_URL })
  await listener.connect()
  const notified: string[] = []
  listener.on('notification', (m) => notified.push(m.payload ?? ''))
  await listener.query(`LISTEN ${EVENTS_CHANNEL}`)
  try {
    const w2 = store.writer({ sessionId, turn: 1, attemptBase: 0 })
    for (let seq = 1; seq <= 3; seq++) w2.push(event(runId, 2, seq))
    await w2.flush()
    // A late event of attempt 1 (a worker that did not know it had lost the turn): stored, and
    // ordered before attempt 2 - a client that dedupes keeps attempt 2's copy.
    const w1 = store.writer({ sessionId, turn: 1, attemptBase: 0 })
    w1.push(event(runId, 1, 7, { message: 'nul\u0000inside' }))
    w1.push(event(runId, 1, 7)) // a repeat: ignored
    await w1.flush()
    await store.marker({ kind: 'ended', sessionId, turn: 1, body: { status: 'completed' } })
    await store.marker({ kind: 'started', sessionId, turn: 2, body: {} })

    const rows = await store.after(sessionId, { turn: 0, attempt: 0, seq: 0 }, 100)
    assert.deepEqual(
      rows.map((r) => `${r.cursor.turn}:${r.cursor.attempt}:${r.cursor.seq}`),
      ['1:1:7', '1:2:1', '1:2:2', '1:2:3', '1:2147483647:0', '2:0:0'],
    )
    assert.match(rows[0]!.json, /nul\\ufffdinside|nul�inside/)
    const tail = await store.after(sessionId, { turn: 1, attempt: 2, seq: 2 }, 100)
    assert.equal(tail.length, 3)
    const limited = await store.after(sessionId, { turn: 0, attempt: 0, seq: 0 }, 2)
    assert.equal(limited.length, 2)
    // The trigger notifies once per statement, with the session id.
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(notified.filter((p) => p === sessionId).length >= 4)
  } finally {
    await listener.end()
  }
})

test('the notify hub wakes a stream of its session only, and reconnects', async () => {
  const hub = createNotifyHub({
    channel: EVENTS_CHANNEL,
    newClient: () => new pg.Client({ connectionString: DATABASE_URL }),
    minBackoffMs: 50,
  })
  await hub.start()
  const store = createEventStore(pool, 262_144)
  const mine = randomUUID()
  const other = randomUUID()
  const sub = hub.subscribe(mine)
  const subOther = hub.subscribe(other)
  try {
    const woke = sub.wait(5000)
    await store.marker({ kind: 'started', sessionId: mine, turn: 1, body: {} })
    assert.equal(await woke, 'notified')
    assert.equal(await subOther.wait(200), 'timeout')
    // Kill the LISTEN connection from the server side: the hub reconnects and wakes everyone.
    await pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN swarm_events' AND pid <> pg_backend_pid()",
    )
    assert.equal(await subOther.wait(5000), 'notified')
    const again = sub.wait(5000)
    await store.marker({ kind: 'started', sessionId: mine, turn: 2, body: {} })
    assert.equal(await again, 'notified')
  } finally {
    sub.close()
    subOther.close()
    await hub.stop()
  }
})

test('the shared bucket delays calls across workers, and refuses a wait beyond the limit', async () => {
  // Two pools: two workers drawing from one bucket.
  const second = createPool(DATABASE_URL, { max: 2 })
  try {
    const modelId = `bucket-${randomUUID()}`
    const cfg = { capacity: 2, refillPerSecond: 4, maxWaitMs: 10_000, scope: 'model' as const }
    const a = createPostgresLimits(pool, cfg)
    const b = createPostgresLimits(second, cfg)
    const call = { stage: 'executor' as const, modelId, provider: 'test' }
    const started = Date.now()
    const takenAt: number[] = []
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        Promise.resolve((i % 2 ? a : b).beforeModelCall(call, {})).then(() =>
          takenAt.push(Date.now() - started),
        ),
      ),
    )
    takenAt.sort((x, y) => x - y)
    // 2 at once (the burst), then 4 more at 4 a second: the last no sooner than ~1 s in.
    assert.ok(takenAt[1]! < 400, `burst: ${takenAt.join(', ')}`)
    assert.ok(takenAt[5]! >= 900, `refill: ${takenAt.join(', ')}`)

    const strict = createPostgresLimits(pool, {
      capacity: 1,
      refillPerSecond: 0.5,
      maxWaitMs: 200,
      scope: 'model',
    })
    const lonely = { stage: 'planner' as const, modelId: `refuse-${randomUUID()}`, provider: 't' }
    await strict.beforeModelCall(lonely, {})
    await assert.rejects(async () => strict.beforeModelCall(lonely, {}), RateLimitRefusal)
  } finally {
    await second.end()
  }
})

const entry = (attempt: number, n: number): IJournalEntry =>
  ({
    id: `a${attempt}:tool:1.${n}.t0`,
    kind: 'tool',
    position: `1.${n}.t0`,
    attempt,
    at: n,
    parent: `a${attempt}:model:1.${n}`,
    tool: 'write_note',
    hash: 'h',
    ok: true,
    model: `result ${n} \u0000 end`,
  }) as IJournalEntry

test('the journal: appends in order, read back byte for byte, fenced by the attempt on record', async () => {
  const runs = createRunStore(pool)
  const persistence = createPostgresPersistence(pool)
  const journal = createPostgresJournal(pool)
  const runId = randomUUID()
  // Not bound: nothing to append to.
  await assert.rejects(Promise.resolve(journal.append(runId, entry(1, 0))), JournalFencedError)
  await runs.bindRun({ runId, sessionId: randomUUID(), turn: 1, runNo: 1, attemptBase: 0 })
  await journal.append(runId, entry(1, 1))
  await journal.append(runId, entry(1, 2))
  assert.deepEqual(await journal.load(runId), [entry(1, 1), entry(1, 2)])
  // The resume takes the run: the fence goes up to attempt 2 before it reads anything ...
  assert.equal(await runs.fenceRun(runId), 2)
  assert.equal(await runs.fenceRun(randomUUID()), undefined, 'an unbound run has no fence')
  // ... and from then the worker of attempt 1 writes nothing: no entry, no checkpoint.
  await assert.rejects(Promise.resolve(journal.append(runId, entry(1, 3))), JournalFencedError)
  await assert.rejects(
    Promise.resolve(persistence.onStepComplete?.(snapshot(runId, 1))),
    SnapshotFencedError,
  )
  // The resume puts attempt 2 on record and appends as attempt 2.
  await persistence.onRunResume?.(snapshot(runId, 2))
  await journal.append(runId, entry(2, 3))
  assert.deepEqual(
    (await journal.load(runId)).map((e) => e.id),
    ['a1:tool:1.1.t0', 'a1:tool:1.2.t0', 'a2:tool:1.3.t0'],
  )
  // A second resume of the same attempt is refused by the fence the first raised, not reused.
  assert.equal(await runs.fenceRun(runId), 3)
  await assert.rejects(Promise.resolve(journal.append(runId, entry(2, 4))), JournalFencedError)
  // The same entry id twice in a run is an error, never a silent duplicate.
  await assert.rejects(Promise.resolve(journal.append(runId, entry(2, 3))))
  // Without a fence (a resume that took no lease), the attempt on record alone refuses an older one.
  const other = randomUUID()
  await runs.bindRun({ runId: other, sessionId: randomUUID(), turn: 1, runNo: 1, attemptBase: 0 })
  await persistence.onRunResume?.(snapshot(other, 2))
  await assert.rejects(Promise.resolve(journal.append(other, entry(1, 1))), JournalFencedError)
  await journal.append(other, entry(2, 1))
})

test('the journal race: an append that read the old fence lands before the resume reads the journal', async () => {
  const runs = createRunStore(pool)
  const journal = createPostgresJournal(pool)
  const runId = randomUUID()
  await runs.bindRun({ runId, sessionId: randomUUID(), turn: 1, runNo: 1, attemptBase: 0 })
  // The late worker (attempt 1) is in the middle of an append: its statement ran, it has not
  // committed yet.
  const late = await pool.connect()
  try {
    await late.query('BEGIN')
    const { text, values } = appendJournalSql(runId, entry(1, 1))
    assert.equal((await late.query(text, values)).rowCount, 1)
    // The resume takes the run now: the fence must wait for that append ...
    let fenced = false
    const fence = runs.fenceRun(runId).then((f) => {
      fenced = true
      return f
    })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(fenced, false, 'the fence waits for the append that read the old one')
    await late.query('COMMIT')
    assert.equal(await fence, 2)
  } finally {
    late.release()
  }
  // ... so the journal the resume reads has every entry attempt 1 will ever have.
  const seen = (await journal.load(runId)).map((e) => e.id)
  await assert.rejects(Promise.resolve(journal.append(runId, entry(1, 2))), JournalFencedError)
  const all = (await journal.load(runId)).map((e) => e.id)
  assert.deepEqual(seen, ['a1:tool:1.1.t0'])
  assert.deepEqual(all, seen, 'nothing of attempt 1 landed behind the resume')
})

test('parked items: recorded, answered, cancelled - as the gateway reads them', async () => {
  const parked = createParkedStore(pool)
  const sessionId = randomUUID()
  await parked.record([
    {
      sessionId,
      itemId: 'p1',
      turn: 1,
      runId: 'r',
      kind: 'approval',
      answeredBy: 'client',
      item: { kind: 'approval', request: { toolName: 'write \u0000' } },
    },
    {
      sessionId,
      itemId: 'p2',
      turn: 1,
      runId: 'r',
      kind: 'tool',
      answeredBy: 'subagent',
      childId: 'subagent-x',
      item: { kind: 'tool', subagent: { name: 'researcher', task: 't' } },
    },
  ])
  assert.equal((await parked.item(sessionId, 'p1'))?.state, 'pending')
  assert.equal(await parked.item(randomUUID(), 'p1'), undefined, 'per session')
  assert.deepEqual(
    (await parked.subagents(sessionId)).map((r) => [r.itemId, r.childId]),
    [['p2', 'subagent-x']],
  )
  await parked.markAnswered(sessionId, ['p1'])
  assert.equal((await parked.item(sessionId, 'p1'))?.state, 'answered')
  await parked.cancelTurn(sessionId, 1)
  assert.equal((await parked.item(sessionId, 'p1'))?.state, 'answered', 'answered stays answered')
  assert.equal((await parked.item(sessionId, 'p2'))?.state, 'cancelled')
  // A park again (a partial resume) puts an item back to pending.
  await parked.record([
    {
      sessionId,
      itemId: 'p2',
      turn: 1,
      runId: 'r',
      kind: 'tool',
      answeredBy: 'subagent',
      item: { kind: 'tool' },
    },
  ])
  assert.equal((await parked.item(sessionId, 'p2'))?.state, 'pending')
})
