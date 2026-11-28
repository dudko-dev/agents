// The session object's tables (src/store.ts) over node:sqlite: the fences of snapshots and the
// journal, the supersede, the lease, the event log's order, the parked items, the blobs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IJournalEntry, IRunSnapshot } from '@dudko.dev/agent'
import { START_CURSOR } from 'swarm-shared'
import { splitText } from '../src/sql.ts'
import {
  appendJournal,
  bindRun,
  cancelOwned,
  cancelTurn,
  eventsAfter,
  fenceRun,
  getBlob,
  insertEvents,
  latestRunOfTurn,
  leaseAcquire,
  leaseRelease,
  leaseRenew,
  loadJournal,
  loadRun,
  markAnswered,
  markerRow,
  migrate,
  nextAttemptBase,
  parkedAnsweredBy,
  parkedItem,
  putBlob,
  recordParked,
  streamMarkerRow,
  SUPERSEDED_FENCE,
  supersedeRun,
  writeSnapshot,
  type IEventRow,
} from '../src/store.ts'
import { memoryStorage } from './helpers/sqlite.ts'

const db = () => {
  const s = memoryStorage()
  migrate(s.sql)
  return s.sql
}

const snapshot = (runId: string, attempt: number, extra: Partial<IRunSnapshot> = {}) =>
  ({
    runId,
    startedAt: 1,
    status: 'executing',
    input: 'x',
    trace: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    stepIndex: 0,
    iterations: 0,
    revisions: 0,
    attempt,
    ...extra,
  }) as IRunSnapshot

const PLAN = { thought: 't', steps: [] } as unknown as IRunSnapshot['plan']

const entry = (id: string, attempt: number, extra: Record<string, unknown> = {}) =>
  ({ id, position: id, attempt, at: 1, kind: 'tool', ...extra }) as unknown as IJournalEntry

const bind = (sql: ReturnType<typeof db>, runId = 'r1', runNo = 1) =>
  bindRun(sql, { runId, stream: 's', turn: 1, runNo, attemptBase: 0 })

test('a run is bound once, by its id and by its (stream, turn, run_no)', () => {
  const sql = db()
  assert.equal(bind(sql), true)
  assert.equal(bind(sql), false)
  assert.equal(bindRun(sql, { runId: 'r2', stream: 's', turn: 1, runNo: 1, attemptBase: 0 }), false)
  assert.equal(bind(sql, 'r2', 2), true)
  assert.equal(latestRunOfTurn(sql, 's', 1)?.runId, 'r2')
  assert.equal(latestRunOfTurn(sql, 's', 2), undefined)
})

test('snapshots: a checkpoint may keep the attempt, a resume must raise it, nothing below the fence', () => {
  const sql = db()
  assert.equal(writeSnapshot(sql, snapshot('r1', 1), 'checkpoint'), false, 'not bound: refused')
  bind(sql)
  assert.equal(writeSnapshot(sql, snapshot('r1', 1), 'checkpoint'), true)
  assert.equal(writeSnapshot(sql, snapshot('r1', 1), 'checkpoint'), true)
  assert.equal(writeSnapshot(sql, snapshot('r1', 1), 'resume'), false, 'a resume must go above')
  assert.equal(writeSnapshot(sql, snapshot('r1', 2), 'resume'), true)
  assert.equal(writeSnapshot(sql, snapshot('r1', 1), 'checkpoint'), false, 'below the record')
  // A resume took the run as attempt 3: attempt 2 writes nothing more.
  assert.equal(fenceRun(sql, 'r1'), 3)
  assert.equal(writeSnapshot(sql, snapshot('r1', 2), 'checkpoint'), false, 'below the fence')
  assert.equal(writeSnapshot(sql, snapshot('r1', 3), 'resume'), true)
  assert.equal(loadRun(sql, 'r1')?.attempt, 3)
  assert.equal(fenceRun(sql, 'nope'), undefined)
})

test('the fence is never lowered', () => {
  const sql = db()
  bind(sql)
  assert.equal(fenceRun(sql, 'r1'), 2)
  assert.equal(fenceRun(sql, 'r1'), 2)
  assert.equal(writeSnapshot(sql, snapshot('r1', 2), 'resume'), true)
  assert.equal(fenceRun(sql, 'r1'), 3)
})

test('the journal: appends fenced by the attempt on record and by the fence', () => {
  const sql = db()
  assert.equal(appendJournal(sql, 'r1', entry('a1:tool:1', 1)), false, 'not bound')
  bind(sql)
  assert.equal(appendJournal(sql, 'r1', entry('a1:tool:1', 1)), true)
  assert.equal(fenceRun(sql, 'r1'), 2)
  assert.equal(appendJournal(sql, 'r1', entry('a1:tool:2', 1)), false, 'below the fence')
  assert.equal(appendJournal(sql, 'r1', entry('a2:tool:2', 2)), true)
  assert.deepEqual(
    loadJournal(sql, 'r1').map((e) => e.id),
    ['a1:tool:1', 'a2:tool:2'],
  )
})

test('the journal: a repeated entry is taken as written, another one under its id refused', () => {
  const sql = db()
  bind(sql)
  assert.equal(appendJournal(sql, 'r1', entry('a1:tool:1', 1, { result: 'x' })), true)
  assert.equal(appendJournal(sql, 'r1', entry('a1:tool:1', 1, { result: 'x' })), true)
  assert.equal(appendJournal(sql, 'r1', entry('a1:tool:1', 1, { result: 'y' })), false)
  assert.equal(loadJournal(sql, 'r1').length, 1)
})

test('the journal: an entry larger than a row is kept in parts and read back whole, in order', () => {
  const sql = db()
  bind(sql)
  const big = 'é'.repeat(900_001)
  appendJournal(sql, 'r1', entry('a1:model:1', 1, { text: big }))
  appendJournal(sql, 'r1', entry('a1:tool:2', 1))
  const back = loadJournal(sql, 'r1')
  assert.equal(back.length, 2)
  assert.equal((back[0] as unknown as { text: string }).text, big)
  assert.equal(back[1]!.id, 'a1:tool:2')
})

test('supersede: only a run with no plan on record, and then it writes nothing again', () => {
  const sql = db()
  bind(sql)
  writeSnapshot(sql, snapshot('r1', 1), 'checkpoint')
  bind(sql, 'r2', 2)
  writeSnapshot(sql, snapshot('r2', 1, { plan: PLAN }), 'checkpoint')
  assert.equal(supersedeRun(sql, 'r2'), false, 'it has a plan: resume it instead')
  assert.equal(supersedeRun(sql, 'r1'), true)
  assert.equal(supersedeRun(sql, 'nope'), false)
  assert.equal(appendJournal(sql, 'r1', entry('a1:model:0', 1)), false)
  assert.equal(writeSnapshot(sql, snapshot('r1', 1, { plan: PLAN }), 'checkpoint'), false)
  assert.equal(writeSnapshot(sql, snapshot('r1', 2), 'resume'), false)
  assert.equal(fenceRun(sql, 'r1'), SUPERSEDED_FENCE)
})

test('a snapshot that loses its plan... cannot: has_plan follows the latest snapshot', () => {
  const sql = db()
  bind(sql)
  writeSnapshot(sql, snapshot('r1', 1, { plan: PLAN }), 'checkpoint')
  assert.equal(supersedeRun(sql, 'r1'), false)
})

test('the next run of a turn counts its attempts above every earlier one, events included', () => {
  const sql = db()
  assert.equal(nextAttemptBase(sql, 's', 1), 0)
  bind(sql)
  writeSnapshot(sql, snapshot('r1', 2), 'resume')
  assert.equal(nextAttemptBase(sql, 's', 1), 2)
  insertEvents(sql, [
    {
      stream: 's',
      turn: 1,
      runId: 'r1',
      attempt: 5,
      seq: 1,
      turnAttempt: 5,
      type: 'x',
      json: '{}',
    },
  ])
  assert.equal(nextAttemptBase(sql, 's', 1), 5)
  // The turn markers do not count.
  insertEvents(sql, [markerRow({ kind: 'ended', stream: 's', turn: 1, body: {} })])
  assert.equal(nextAttemptBase(sql, 's', 1), 5)
})

test('the lease: held, renewed, released; a newer attempt revokes the holder and takes it once it runs out', () => {
  const sql = db()
  assert.equal(leaseAcquire(sql, 'r1', 'a', 1000, 0), true)
  assert.equal(leaseRenew(sql, 'r1', 'a', 1000, 500), true)
  assert.equal(leaseAcquire(sql, 'r1', 'b', 1000, 600), false, 'held by a')
  assert.equal(leaseRenew(sql, 'r1', 'a', 1000, 700), false, 'a is revoked: lost')
  assert.equal(leaseAcquire(sql, 'r1', 'b', 1000, 1400), false, 'until the last renew + ttl')
  assert.equal(leaseAcquire(sql, 'r1', 'b', 1000, 1501), true)
  assert.equal(leaseRenew(sql, 'r1', 'a', 1000, 1600), false)
  assert.equal(leaseRenew(sql, 'r1', 'b', 1000, 1600), true)
  leaseRelease(sql, 'r1', 'a')
  assert.equal(leaseRenew(sql, 'r1', 'b', 1000, 1700), true, 'a cannot release b')
  leaseRelease(sql, 'r1', 'b')
  assert.equal(leaseAcquire(sql, 'r1', 'c', 1000, 1701), true)
})

test('the lease: the holder may take it again (a resume in the same attempt)', () => {
  const sql = db()
  assert.equal(leaseAcquire(sql, 'r1', 'a', 1000, 0), true)
  assert.equal(leaseAcquire(sql, 'r1', 'a', 1000, 10), true)
})

const row = (turn: number, turnAttempt: number, seq: number, stream = 's'): IEventRow => ({
  stream,
  turn,
  runId: `run-${turn}`,
  attempt: turnAttempt,
  seq,
  turnAttempt,
  type: 't',
  json: JSON.stringify({ turn, turnAttempt, seq }),
})

test('events: written once, read back in (turn, attempt, seq) order after a cursor', () => {
  const sql = db()
  const touched = insertEvents(sql, [row(2, 1, 1), row(1, 2, 1), row(1, 1, 2), row(1, 1, 1)])
  assert.deepEqual([...touched], ['s'])
  assert.equal(insertEvents(sql, [row(1, 1, 1)]).size, 0, 'a repeat is a no-op')
  insertEvents(sql, [markerRow({ kind: 'started', stream: 's', turn: 1, body: {} })])
  insertEvents(sql, [markerRow({ kind: 'ended', stream: 's', turn: 1, body: {} })])
  const all = eventsAfter(sql, 's', START_CURSOR, 100).map(
    (r) => `${r.cursor.turn}:${r.cursor.attempt}:${r.cursor.seq}`,
  )
  assert.deepEqual(all, ['1:0:0', '1:1:1', '1:1:2', '1:2:1', '1:2147483647:0', '2:1:1'])
  const after = eventsAfter(sql, 's', { turn: 1, attempt: 1, seq: 2 }, 2).map((r) => r.cursor.seq)
  assert.deepEqual(after, [1, 0])
  assert.equal(eventsAfter(sql, 'other', START_CURSOR, 10).length, 0, 'a stream is its own')
})

test('child markers sit in the parked attempt slot, after its events, before the resumed one', () => {
  const sql = db()
  insertEvents(sql, [row(1, 1, 5), row(1, 2, 1)])
  insertEvents(sql, [
    streamMarkerRow({
      sessionId: 's',
      turn: 1,
      turnAttempt: 1,
      seq: 1_073_741_824,
      type: 'subagent.started',
      body: {},
    }),
  ])
  const order = eventsAfter(sql, 's', START_CURSOR, 10).map((r) => r.cursor)
  assert.deepEqual(
    order.map((c) => `${c.attempt}:${c.seq}`),
    ['1:5', '1:1073741824', '2:1'],
  )
})

const parked = (itemId: string, extra: Record<string, unknown> = {}) => ({
  sessionId: 's',
  itemId,
  turn: 1,
  runId: 'r1',
  kind: 'approval' as const,
  answeredBy: 'client' as const,
  item: { kind: 'approval' },
  ...extra,
})

test('parked items: pending, answered, cancelled; looked up in their session only', () => {
  const sql = db()
  recordParked(sql, [parked('p1'), parked('p2'), parked('p3', { sessionId: 'other' })])
  assert.equal(parkedItem(sql, 's', 'p1')?.state, 'pending')
  assert.equal(parkedItem(sql, 's', 'p3'), undefined, "another session's item")
  assert.equal(parkedItem(sql, 'other', 'p3')?.sessionId, 'other')
  markAnswered(sql, 's', ['p1'])
  assert.equal(parkedItem(sql, 's', 'p1')?.state, 'answered')
  cancelTurn(sql, 's', 1)
  assert.equal(parkedItem(sql, 's', 'p1')?.state, 'answered', 'an answered item stays answered')
  assert.equal(parkedItem(sql, 's', 'p2')?.state, 'cancelled')
  assert.equal(parkedItem(sql, 'other', 'p3')?.state, 'pending')
  // A park again (a partial resume): pending again.
  recordParked(sql, [parked('p2')])
  assert.equal(parkedItem(sql, 's', 'p2')?.state, 'pending')
})

test("parked items: a child's own items, owned and closed with it", () => {
  const sql = db()
  const owner = { workflowId: 'subagent-s-r1-p1', itemId: 'p1' }
  recordParked(sql, [
    parked('p1', { answeredBy: 'subagent', childId: 'subagent-s-r1-p1', kind: 'tool' }),
    parked('c1', { owner, runId: 'run-child' }),
    parked('n1', { owner: { ...owner, workflowId: 'w', nodeId: 'draft', visit: 2 } }),
  ])
  const child = parkedItem(sql, 's', 'c1')
  assert.deepEqual(child?.owner, owner)
  assert.deepEqual(parkedItem(sql, 's', 'n1')?.owner, {
    workflowId: 'w',
    itemId: 'p1',
    nodeId: 'draft',
    visit: 2,
  })
  cancelOwned(sql, 's', 'subagent-s-r1-p1')
  assert.equal(parkedItem(sql, 's', 'c1')?.state, 'cancelled')
  assert.equal(parkedItem(sql, 's', 'n1')?.state, 'pending')
  assert.deepEqual(
    parkedAnsweredBy(sql, 's', 'subagent').map((r) => [r.itemId, r.childId]),
    [['p1', 'subagent-s-r1-p1']],
  )
})

test('blobs: values larger than a row, never cut inside a surrogate pair', () => {
  const sql = db()
  const value = { text: '😀'.repeat(300_000) + 'x'.repeat(10) }
  putBlob(sql, 'k', value)
  assert.deepEqual(getBlob(sql, 'k'), value)
  putBlob(sql, 'k', { small: true })
  assert.deepEqual(getBlob(sql, 'k'), { small: true })
  for (const part of splitText('a😀'.repeat(10), 2)) {
    const last = part.charCodeAt(part.length - 1)
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no part ends in a high surrogate')
  }
  assert.equal(splitText('a😀'.repeat(10), 2).join(''), 'a😀'.repeat(10))
})
