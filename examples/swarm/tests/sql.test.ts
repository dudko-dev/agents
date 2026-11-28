// The adapters' SQL builders and JSON, and the event writer's batching, on a fake database.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent, IRunSnapshot } from '@dudko.dev/agent'
import {
  createEventWriter,
  eventJson,
  eventRowOf,
  eventsAfterSql,
  insertEventsSql,
  INSERT_MAX_ROWS,
  markerRow,
} from '../src/db/events.ts'
import { toJsonText } from '../src/db/json.ts'
import type { IQueryable } from '../src/db/pool.ts'
import {
  bindRunSql,
  loadRunSql,
  nextAttemptBaseSql,
  TURN_END_ATTEMPT,
  writeSnapshotSql,
} from '../src/db/runs.ts'
import { insertSessionSql, sessionExistsSql } from '../src/backend.ts'

const ev = (seq: number, attempt = 1, extra: object = {}): AgentEvent =>
  ({
    type: 'log',
    level: 'info',
    message: `m${seq}`,
    runId: 'r1',
    seq,
    attempt,
    ...extra,
  }) as AgentEvent

test('toJsonText: Errors readable, NUL replaced, an escaped backslash left alone', () => {
  assert.equal(
    toJsonText({ error: new TypeError('bad') }),
    '{"error":{"name":"TypeError","message":"bad"}}',
  )
  assert.equal(toJsonText({ s: 'a\u0000b' }), '{"s":"a\\ufffdb"}')
  // A literal backslash followed by "u0000" is not a NUL: it must survive untouched.
  const literal = { s: '\\u0000' }
  assert.deepEqual(JSON.parse(toJsonText(literal)), literal)
  const both = { s: '\\\u0000' }
  assert.deepEqual(JSON.parse(toJsonText(both)), { s: '\\�' })
  assert.equal(toJsonText({ n: 10n }), '{"n":"10"}')
})

test('insertEventsSql: one statement, numbered placeholders, jsonb cast, bounded', () => {
  const rows = [1, 2].map((seq) =>
    eventRowOf(ev(seq), { sessionId: 's', turn: 3, attemptBase: 1 }, 1e6)!,
  )
  const { text, values } = insertEventsSql(rows)
  assert.equal(
    text,
    'INSERT INTO swarm_events (session_id, turn, run_id, attempt, seq, turn_attempt, type, event) VALUES ' +
      '($1, $2, $3, $4, $5, $6, $7, $8::jsonb), ($9, $10, $11, $12, $13, $14, $15, $16::jsonb) ON CONFLICT DO NOTHING',
  )
  assert.deepEqual(values.slice(0, 7), ['s', 3, 'r1', 1, 1, 2, 'log'])
  assert.throws(() => insertEventsSql([]), RangeError)
  assert.throws(() => insertEventsSql(Array(INSERT_MAX_ROWS + 1).fill(rows[0])), RangeError)
})

test('eventRowOf: the turn attempt is base + attempt; events outside a run are skipped', () => {
  const row = eventRowOf(ev(5, 2), { sessionId: 's', turn: 1, attemptBase: 3 }, 1e6)!
  assert.equal(row.turnAttempt, 5)
  assert.equal(row.attempt, 2)
  assert.equal(row.seq, 5)
  assert.equal(
    eventRowOf(
      { type: 'log', level: 'info', message: 'x' } as AgentEvent,
      { sessionId: 's', turn: 1, attemptBase: 0 },
      1e6,
    ),
    undefined,
  )
})

test('eventJson: an oversized event becomes a stub that says so', () => {
  const big = ev(1, 1, { message: 'x'.repeat(5000) })
  const stub = JSON.parse(eventJson(big, 1000)) as Record<string, unknown>
  assert.deepEqual(stub, {
    type: 'log',
    runId: 'r1',
    seq: 1,
    attempt: 1,
    truncated: true,
    bytes: stub.bytes,
  })
  assert.ok((stub.bytes as number) > 5000)
  assert.equal(JSON.parse(eventJson(ev(1), 1000)).message, 'm1')
})

test('markers: started before every attempt, ended after all, one slot per turn', () => {
  const started = markerRow({ kind: 'started', sessionId: 's', turn: 4, body: { input: 'hi' } })
  const ended = markerRow({ kind: 'ended', sessionId: 's', turn: 4, body: { status: 'completed' } })
  assert.deepEqual([started.turnAttempt, started.seq, started.runId], [0, 0, 'turn-4'])
  assert.deepEqual([ended.turnAttempt, ended.seq], [TURN_END_ATTEMPT, 0])
  assert.deepEqual(JSON.parse(ended.json), { status: 'completed', type: 'turn.ended', turn: 4 })
  assert.equal(JSON.parse(started.json).type, 'turn.started')
})

test('eventsAfterSql: a row comparison after the cursor, in stream order, limited', () => {
  const { text, values } = eventsAfterSql('s', { turn: 2, attempt: 1, seq: 9 }, 50)
  assert.match(text, /\(turn, turn_attempt, seq\) > \(\$2, \$3, \$4\)/)
  assert.match(text, /ORDER BY turn, turn_attempt, seq LIMIT \$5$/)
  assert.deepEqual(values, ['s', 2, 1, 9, 50])
})

const snap = (attempt?: number): IRunSnapshot => ({
  runId: 'r1',
  startedAt: 1,
  status: 'executing',
  input: 'x',
  trace: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  stepIndex: 0,
  iterations: 0,
  revisions: 0,
  ...(attempt ? { attempt } : {}),
  leaseOwner: 'w1',
})

test('snapshot writes are fenced: a checkpoint by <=, a resume by <', () => {
  const checkpoint = writeSnapshotSql(snap(2), 'checkpoint')
  assert.match(checkpoint.text, /WHERE run_id = \$1 AND attempt <= \$4$/)
  assert.deepEqual(checkpoint.values.slice(2), ['executing', 2, 'w1'])
  assert.equal(JSON.parse(checkpoint.values[1] as string).runId, 'r1')
  assert.match(writeSnapshotSql(snap(3), 'resume').text, /AND attempt < \$4$/)
  // A snapshot from before attempts were recorded is attempt 1.
  assert.equal(writeSnapshotSql(snap(), 'checkpoint').values[3], 1)
  assert.deepEqual(loadRunSql('r1').values, ['r1'])
})

test('a run is bound once per (session, turn, run_no); the next base counts runs and events', () => {
  const bind = bindRunSql({ runId: 'r', sessionId: 's', turn: 2, runNo: 1, attemptBase: 0 })
  assert.match(bind.text, /ON CONFLICT DO NOTHING RETURNING run_id$/)
  assert.deepEqual(bind.values, ['r', 's', 2, 1, 0])
  const base = nextAttemptBaseSql('s', 2)
  assert.match(base.text, /MAX\(attempt_base \+ attempt\)/)
  assert.match(base.text, /turn_attempt > 0 AND turn_attempt < \$3/)
  assert.deepEqual(base.values, ['s', 2, TURN_END_ATTEMPT])
  assert.match(insertSessionSql, /ON CONFLICT DO NOTHING/)
  assert.match(sessionExistsSql, /WHERE session_id = \$1/)
})

test('the event writer batches, keeps order, retries, and gives up with a count', async () => {
  const statements: unknown[][] = []
  let failures = 0
  const db: IQueryable = {
    query: (async (_text: string, values?: unknown[]) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('connection reset')
      }
      statements.push(values ?? [])
      return { rows: [], rowCount: 0 }
    }) as unknown as IQueryable['query'],
  }
  const dropped: number[] = []
  const w = createEventWriter(db, {
    sessionId: 's',
    turn: 1,
    attemptBase: 0,
    maxEventBytes: 1e6,
    maxBatch: 3,
    flushMs: 5,
    retries: 2,
    sleep: async () => {},
    onError: (_err, n) => dropped.push(n),
  })
  for (let seq = 1; seq <= 7; seq++) w.push(ev(seq))
  await w.flush()
  // 3 + 3 written as soon as full, the last 1 on flush - in order.
  assert.deepEqual(
    statements.map((v) => v.length / 8),
    [3, 3, 1],
  )
  const seqs = statements.flatMap((v) => v.filter((_, i) => i % 8 === 4))
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7])
  // Two failures are retried away; three are not.
  failures = 2
  w.push(ev(8))
  await w.flush()
  assert.equal(statements.length, 4)
  failures = 3
  w.push(ev(9))
  w.push(ev(10))
  await w.flush()
  assert.deepEqual(dropped, [2])
  // The timer flushes on its own too.
  w.push(ev(11))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(statements.length, 5)
})
