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
  PIPELINE_STREAM_RUN,
  streamBatchRows,
  streamMarkerRow,
} from '../src/db/events.ts'
import {
  appendJournalSql,
  createPostgresJournal,
  JournalFencedError,
  loadJournalSql,
} from '../src/db/journal.ts'
import {
  cancelTurnSql,
  markAnsweredSql,
  parkedItemSql,
  pipelinesOfSql,
  recordParkedSql,
  subagentsOfSql,
} from '../src/db/parked.ts'
import { toJsonText } from '../src/db/json.ts'
import type { IQueryable } from '../src/db/pool.ts'
import {
  bindRunSql,
  fenceRunSql,
  loadRunSql,
  nextAttemptBaseSql,
  SUPERSEDED_FENCE,
  supersedeRunSql,
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
  assert.match(checkpoint.text, /WHERE run_id = \$1 AND attempt <= \$4 AND fence <= \$4$/)
  assert.deepEqual(checkpoint.values.slice(2), ['executing', 2, 'w1'])
  assert.equal(JSON.parse(checkpoint.values[1] as string).runId, 'r1')
  assert.match(writeSnapshotSql(snap(3), 'resume').text, /AND attempt < \$4 AND fence <= \$4$/)
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

test('the journal: an append is one fenced statement; a load reads in append order', async () => {
  const entry = {
    id: 'a2:tool:1.1.t0',
    kind: 'tool',
    position: '1.1.t0',
    attempt: 2,
    at: 1,
    parent: 'a2:model:1.1',
    tool: 'write_note',
    hash: 'h',
    ok: true,
    model: 'done \u0000',
  } as const
  const append = appendJournalSql('r1', entry as never)
  assert.match(append.text, /^INSERT INTO swarm_journal .* SELECT .* FROM swarm_runs /)
  assert.match(append.text, /WHERE run_id = \$1 AND attempt <= \$3 AND fence <= \$3 FOR SHARE$/)
  assert.deepEqual(append.values.slice(0, 3), ['r1', 'a2:tool:1.1.t0', 2])
  assert.deepEqual(JSON.parse(append.values[3] as string), entry, 'byte for byte, NUL included')
  assert.match(loadJournalSql('r1').text, /ORDER BY n$/)
  // 0 rows: the attempt was fenced off - the append throws (the core stops the run).
  let rowCount = 0
  const db: IQueryable = {
    query: (async (text: string) => {
      if (text.startsWith('SELECT')) {
        return { rows: [{ entry: JSON.stringify(entry) }], rowCount: 1 }
      }
      return { rows: [], rowCount }
    }) as IQueryable['query'],
  }
  const journal = createPostgresJournal(db)
  await assert.rejects(Promise.resolve(journal.append('r1', entry as never)), JournalFencedError)
  rowCount = 1
  await journal.append('r1', entry as never)
  assert.deepEqual(await journal.load('r1'), [entry])
})

test('the fence: a resume raises it to the attempt on record + 1, never lowers it', () => {
  const f = fenceRunSql('r1')
  assert.match(
    f.text,
    /SET fence = GREATEST\(fence, attempt \+ 1\) WHERE run_id = \$1 RETURNING fence$/,
  )
  assert.deepEqual(f.values, ['r1'])
})

test('supersede: the fence to the top, only while the run has no plan on record', () => {
  const s = supersedeRunSql('r1')
  assert.match(
    s.text,
    /^UPDATE swarm_runs SET fence = \$2 WHERE run_id = \$1 AND \(snapshot IS NULL OR jsonb_typeof\(snapshot -> 'plan'\) IS DISTINCT FROM 'object'\) RETURNING run_id$/,
  )
  assert.deepEqual(s.values, ['r1', SUPERSEDED_FENCE])
  // Above every attempt a write can carry (the attempt column is an integer).
  assert.equal(SUPERSEDED_FENCE, 2 ** 31 - 1)
})

test('parked items: one upsert per park, answered / cancelled only from pending', () => {
  const rec = recordParkedSql([
    {
      sessionId: 's',
      itemId: 'p1',
      turn: 2,
      runId: 'r',
      kind: 'approval',
      answeredBy: 'client',
      item: { kind: 'approval' },
    },
    {
      sessionId: 's',
      itemId: 'p2',
      turn: 2,
      runId: 'r',
      kind: 'tool',
      answeredBy: 'subagent',
      childId: 'subagent-s-r-p2',
      item: { kind: 'tool' },
    },
  ])
  assert.match(rec.text, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8::jsonb\), \(\$9,/)
  assert.match(rec.text, /ON CONFLICT \(session_id, item_id\) DO UPDATE .* state = 'pending'/)
  assert.deepEqual(rec.values.slice(8, 15), [
    's',
    2,
    'p2',
    'r',
    'tool',
    'subagent',
    'subagent-s-r-p2',
  ])
  assert.equal(rec.values[6], null)
  assert.match(
    markAnsweredSql('s', ['p1']).text,
    /item_id = ANY\(\$2::text\[\]\) AND state = 'pending'$/,
  )
  assert.match(cancelTurnSql('s', 2).text, /AND turn = \$2 AND state = 'pending'$/)
  assert.deepEqual(parkedItemSql('s', 'p1').values, ['s', 'p1'])
  assert.match(subagentsOfSql('s').text, /answered_by = \$2 ORDER BY created_at, item_id$/)
  assert.deepEqual(subagentsOfSql('s').values, ['s', 'subagent'])
  assert.deepEqual(pipelinesOfSql('s').values, ['s', 'pipeline'])
})

test("a pipeline's own stream: its turn.started, then the engine's events in the workflow's order", () => {
  const rows = streamBatchRows(
    {
      stream: 's/p1',
      started: { name: 'review', input: 'the task' },
      events: [
        { seq: 1, event: { type: 'pipeline.started', pipeline: 'review' } },
        { seq: 2, event: { type: 'pipeline.node.started', nodeId: 'a', visit: 1, from: [] } },
      ],
    },
    1024,
  )
  assert.deepEqual(
    rows.map((r) => [r.sessionId, r.turn, r.runId, r.attempt, r.seq, r.turnAttempt, r.type]),
    [
      ['s/p1', 1, 'turn-1', 0, 0, 0, 'turn.started'],
      ['s/p1', 1, PIPELINE_STREAM_RUN, 1, 1, 1, 'pipeline.started'],
      ['s/p1', 1, PIPELINE_STREAM_RUN, 1, 2, 1, 'pipeline.node.started'],
    ],
  )
  assert.equal(JSON.parse(rows[2]!.json).nodeId, 'a')
  // Without `started` (every batch but the first): only the events. A huge one is a stub.
  const later = streamBatchRows(
    {
      stream: 's/p1',
      events: [{ seq: 3, event: { type: 'pipeline.node.finished', text: 'x'.repeat(2000) } }],
    },
    1024,
  )
  assert.equal(later.length, 1)
  assert.deepEqual(JSON.parse(later[0]!.json), {
    type: 'pipeline.node.finished',
    truncated: true,
    bytes: JSON.stringify({ type: 'pipeline.node.finished', text: 'x'.repeat(2000) }).length,
  })
})

test('subagent markers: the slot and seq the workflow chose, a run id of their own', () => {
  const row = streamMarkerRow({
    sessionId: 's',
    turn: 3,
    turnAttempt: 2,
    seq: 1_073_741_824,
    type: 'subagent.started',
    body: { itemId: 'p1' },
  })
  assert.deepEqual(
    [row.turn, row.turnAttempt, row.seq, row.runId, row.attempt, row.type],
    [3, 2, 1_073_741_824, 'subagents-3', 2, 'subagent.started'],
  )
  assert.deepEqual(JSON.parse(row.json), { itemId: 'p1', type: 'subagent.started', turn: 3 })
})
