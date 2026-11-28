// The session's tables in its Durable Object's SQLite: what Postgres holds for a session in
// examples/swarm (swarm_runs, swarm_journal, swarm_events, swarm_parked), plus what Temporal held
// there (the session's state, the children, the effects still to make). Pure functions over `ISql`:
// the DO calls them inside one storage transaction per transition, the unit tests call them over
// node:sqlite.
//
// The fences are examples/swarm's (src/db/runs.ts, src/db/journal.ts), with one difference that
// makes them simpler: the object is the session's ONLY writer and runs one call at a time, so a
// check and the write it guards are one synchronous block - nothing can come between them (where
// Postgres needs `FOR SHARE` on the run's row, so that the fence waits for appends that read it).
//
//   - a snapshot checkpoint may not go below the attempt on record, a resume must go above it, and
//     neither may go below the run's fence;
//   - a resume takes the run by raising its fence to the attempt it claims (`fenceRun`): from then
//     on an older attempt writes nothing - no snapshot, no journal entry;
//   - a run that cannot be resumed (bound, but no plan on record) is SUPERSEDED before its turn
//     names the next run (`supersedeRun`): its fence goes to the top, so it writes nothing again.
import type { IJournalEntry, IRunSnapshot } from '@dudko.dev/agent'
import type {
  AnsweredBy,
  ICursor,
  IParkedRequest,
  IParkedRow,
  IStreamBatch,
  IStreamMarker,
  IStreamRow,
  ParkedState,
} from 'swarm-shared'
import { byteLength, toJsonText } from './json.ts'
import { splitText, type ISql, type SqlValue } from './sql.ts'

// The turn markers' slot in a turn's order: turn.started before every attempt, turn.ended after.
export const TURN_START_ATTEMPT = 0
export const TURN_END_ATTEMPT = 2147483647
// A superseded run's fence: above every attempt the core gives a run.
export const SUPERSEDED_FENCE = 2147483647

// Rows a write changed - read once the cursor is consumed (a Durable Object's cursor is lazy).
const written = (sql: ISql, query: string, ...bindings: SqlValue[]): number => {
  const cursor = sql.exec(query, ...bindings)
  cursor.toArray()
  return cursor.rowsWritten
}

const SCHEMA = [
  // Values that may outgrow a row, in parts (sql.ts): the state, snapshots, inputs.
  `CREATE TABLE IF NOT EXISTS blobs (k TEXT NOT NULL, n INTEGER NOT NULL, part TEXT NOT NULL,
     PRIMARY KEY (k, n))`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  // One row per agent run (the session's turns and its children's runs, by stream).
  `CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, stream TEXT NOT NULL,
     turn INTEGER NOT NULL, run_no INTEGER NOT NULL, attempt_base INTEGER NOT NULL,
     attempt INTEGER NOT NULL DEFAULT 1, fence INTEGER NOT NULL DEFAULT 0, status TEXT,
     has_plan INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, UNIQUE (stream, turn, run_no))`,
  // The call journal: entry n of a run, in parts k.
  `CREATE TABLE IF NOT EXISTS journal (run_id TEXT NOT NULL, n INTEGER NOT NULL,
     k INTEGER NOT NULL, entry_id TEXT NOT NULL, attempt INTEGER NOT NULL, part TEXT NOT NULL,
     PRIMARY KEY (run_id, n, k))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS journal_entry ON journal (run_id, entry_id) WHERE k = 0`,
  // The event log of every stream of the session, in stream order.
  `CREATE TABLE IF NOT EXISTS events (stream TEXT NOT NULL, turn INTEGER NOT NULL,
     turn_attempt INTEGER NOT NULL, seq INTEGER NOT NULL, run_id TEXT NOT NULL,
     attempt INTEGER NOT NULL, type TEXT NOT NULL, event TEXT NOT NULL,
     PRIMARY KEY (stream, turn, turn_attempt, seq))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS events_run ON events (stream, run_id, attempt, seq)`,
  // The items parked turns (and their children) wait for.
  `CREATE TABLE IF NOT EXISTS parked (session_id TEXT NOT NULL, item_id TEXT NOT NULL,
     turn INTEGER NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, answered_by TEXT NOT NULL,
     child_id TEXT, item TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', owner_id TEXT,
     owner_item TEXT, owner_node TEXT, owner_visit INTEGER, ord INTEGER NOT NULL,
     PRIMARY KEY (session_id, item_id))`,
  // runLease: who runs a run now, until when (by the object's clock), and whether a newer
  // attempt asked for it.
  `CREATE TABLE IF NOT EXISTS lease (run_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
     until INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  // The session's children: a subagent call, a pipeline call, a pipeline's node visit.
  `CREATE TABLE IF NOT EXISTS children (workflow_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
     item_id TEXT NOT NULL, parent TEXT, state TEXT NOT NULL,
     k INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL)`,
  // The phases whose outcome the object took (a turn's, a child's), so a retried report is a no-op.
  `CREATE TABLE IF NOT EXISTS phases (scope TEXT NOT NULL, k INTEGER NOT NULL,
     status TEXT NOT NULL, PRIMARY KEY (scope, k))`,
  // Effects on other services (start a Workflow instance, send it an event), written in the
  // transaction that decided them and made after it, in order, until each one succeeded.
  `CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, body TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0)`,
]

export const migrate = (sql: ISql): void => {
  for (const statement of SCHEMA) {
    sql.exec(statement)
  }
}

// --- blobs and meta ---------------------------------------------------------------------------

export const putBlob = (sql: ISql, key: string, value: unknown): void => {
  sql.exec('DELETE FROM blobs WHERE k = ?', key)
  splitText(JSON.stringify(value)).forEach((part, n) => {
    sql.exec('INSERT INTO blobs (k, n, part) VALUES (?, ?, ?)', key, n, part)
  })
}

export const getBlob = <T>(sql: ISql, key: string): T | undefined => {
  const rows = sql.exec<{ part: string }>('SELECT part FROM blobs WHERE k = ? ORDER BY n', key)
  const parts = rows.toArray()
  return parts.length ? (JSON.parse(parts.map((r) => r.part).join('')) as T) : undefined
}

export const dropBlob = (sql: ISql, key: string): void => {
  sql.exec('DELETE FROM blobs WHERE k = ?', key)
}

export const getMeta = <T>(sql: ISql, key: string): T | undefined => {
  const row = sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', key).toArray()[0]
  return row ? (JSON.parse(row.v) as T) : undefined
}

export const setMeta = (sql: ISql, key: string, value: unknown): void => {
  sql.exec(
    'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v',
    key,
    JSON.stringify(value),
  )
}

// --- runs -------------------------------------------------------------------------------------

export interface IRunBinding {
  runId: string
  // The session - or a child's own stream (swarm-shared's session-ids.ts).
  stream: string
  turn: number
  runNo: number
  // Added to the core's attempt to order the turn's events across its runs.
  attemptBase: number
}

export interface IRunRow extends IRunBinding {
  attempt: number
  fence: number
  status: IRunSnapshot['status'] | null
  snapshot: IRunSnapshot | null
}

export type SnapshotWrite = 'checkpoint' | 'resume'

interface IRunRecord {
  run_id: string
  stream: string
  turn: number
  run_no: number
  attempt_base: number
  attempt: number
  fence: number
  status: IRunSnapshot['status'] | null
}

const snapshotKey = (runId: string): string => `snapshot:${runId}`

export const bindRun = (sql: ISql, b: IRunBinding): boolean =>
  written(
    sql,
    'INSERT INTO runs (run_id, stream, turn, run_no, attempt_base, attempt, fence) ' +
      'VALUES (?, ?, ?, ?, ?, 1, 0) ON CONFLICT DO NOTHING',
    b.runId,
    b.stream,
    b.turn,
    b.runNo,
    b.attemptBase,
  ) > 0

export const latestRunOfTurn = (sql: ISql, stream: string, turn: number): IRunRow | undefined => {
  const r = sql
    .exec<IRunRecord>(
      'SELECT run_id, stream, turn, run_no, attempt_base, attempt, fence, status FROM runs ' +
        'WHERE stream = ? AND turn = ? ORDER BY run_no DESC LIMIT 1',
      stream,
      turn,
    )
    .toArray()[0]
  return r
    ? {
        runId: r.run_id,
        stream: r.stream,
        turn: r.turn,
        runNo: r.run_no,
        attemptBase: r.attempt_base,
        attempt: r.attempt,
        fence: r.fence,
        status: r.status,
        snapshot: getBlob<IRunSnapshot>(sql, snapshotKey(r.run_id)) ?? null,
      }
    : undefined
}

// The attempt numbers a new run of the turn must start above: every attempt the turn's earlier
// runs have on record, in snapshots or in events (the turn markers excluded).
export const nextAttemptBase = (sql: ISql, stream: string, turn: number): number => {
  const runs = sql
    .exec<{
      m: number | null
    }>(
      'SELECT MAX(attempt_base + attempt) AS m FROM runs WHERE stream = ? AND turn = ?',
      stream,
      turn,
    )
    .one().m
  const events = sql
    .exec<{
      m: number | null
    }>(
      'SELECT MAX(turn_attempt) AS m FROM events WHERE stream = ? AND turn = ? ' +
        'AND turn_attempt > 0 AND turn_attempt < ?',
      stream,
      turn,
      TURN_END_ATTEMPT,
    )
    .one().m
  return Math.max(runs ?? 0, events ?? 0)
}

// A checkpoint keeps or raises the attempt on record; a resume must raise it. Neither below the
// fence. False: refused (another attempt took the run, or it is not bound).
export const writeSnapshot = (sql: ISql, s: IRunSnapshot, mode: SnapshotWrite): boolean => {
  const attempt = s.attempt ?? 1
  const row = sql
    .exec<{
      attempt: number
      fence: number
    }>('SELECT attempt, fence FROM runs WHERE run_id = ?', s.runId)
    .toArray()[0]
  if (!row || row.fence > attempt) {
    return false
  }
  if (mode === 'resume' ? row.attempt >= attempt : row.attempt > attempt) {
    return false
  }
  const hasPlan = s.plan !== null && typeof s.plan === 'object' && !Array.isArray(s.plan)
  sql.exec(
    'UPDATE runs SET status = ?, attempt = ?, lease_owner = ?, has_plan = ? WHERE run_id = ?',
    s.status,
    attempt,
    s.leaseOwner ?? null,
    hasPlan ? 1 : 0,
    s.runId,
  )
  putBlob(sql, snapshotKey(s.runId), s)
  return true
}

// A resume takes the run: the attempt it will run as (the one on record + 1) becomes the fence.
// Never lowered; undefined when the run is not bound (the resume is refused).
export const fenceRun = (sql: ISql, runId: string): number | undefined => {
  const row = sql
    .exec<{
      fence: number
    }>('UPDATE runs SET fence = MAX(fence, attempt + 1) WHERE run_id = ? RETURNING fence', runId)
    .toArray()[0]
  return row ? row.fence : undefined
}

// Supersede a run its turn cannot resume - only while it still has no plan on record (checked in
// the same statement: a plan that landed first is resumed instead).
export const supersedeRun = (sql: ISql, runId: string): boolean =>
  sql
    .exec(
      'UPDATE runs SET fence = ? WHERE run_id = ? AND has_plan = 0 RETURNING run_id',
      SUPERSEDED_FENCE,
      runId,
    )
    .toArray().length > 0

export const loadRun = (sql: ISql, runId: string): IRunSnapshot | null =>
  getBlob<IRunSnapshot>(sql, snapshotKey(runId)) ?? null

// --- the call journal -------------------------------------------------------------------------

// An entry is kept only while its attempt is not below the attempt on record for the run nor below
// its fence (the one a resume raised, or the top: superseded). A repeat of an entry already on
// record (a retried append whose answer was lost) is taken as written; another entry under the
// same id is refused. False: refused - the core then stops the run (an append is fail-closed).
export const appendJournal = (sql: ISql, runId: string, entry: IJournalEntry): boolean => {
  const row = sql
    .exec<{
      attempt: number
      fence: number
    }>('SELECT attempt, fence FROM runs WHERE run_id = ?', runId)
    .toArray()[0]
  if (!row || row.attempt > entry.attempt || row.fence > entry.attempt) {
    return false
  }
  const text = JSON.stringify(entry)
  const existing = sql
    .exec<{
      n: number
    }>('SELECT n FROM journal WHERE run_id = ? AND entry_id = ? AND k = 0', runId, entry.id)
    .toArray()[0]
  if (existing) {
    return journalText(sql, runId, existing.n) === text
  }
  const n =
    (sql.exec<{ m: number | null }>('SELECT MAX(n) AS m FROM journal WHERE run_id = ?', runId).one()
      .m ?? 0) + 1
  splitText(text).forEach((part, k) => {
    sql.exec(
      'INSERT INTO journal (run_id, n, k, entry_id, attempt, part) VALUES (?, ?, ?, ?, ?, ?)',
      runId,
      n,
      k,
      entry.id,
      entry.attempt,
      part,
    )
  })
  return true
}

const journalText = (sql: ISql, runId: string, n: number): string =>
  sql
    .exec<{ part: string }>(
      'SELECT part FROM journal WHERE run_id = ? AND n = ? ORDER BY k',
      runId,
      n,
    )
    .toArray()
    .map((r) => r.part)
    .join('')

export const loadJournal = (sql: ISql, runId: string): IJournalEntry[] => {
  const out: IJournalEntry[] = []
  let n = -1
  let text = ''
  for (const r of sql
    .exec<{
      n: number
      part: string
    }>('SELECT n, part FROM journal WHERE run_id = ? ORDER BY n, k', runId)
    .toArray()) {
    if (r.n !== n && n >= 0) {
      out.push(JSON.parse(text) as IJournalEntry)
      text = ''
    }
    n = r.n
    text += r.part
  }
  if (n >= 0) {
    out.push(JSON.parse(text) as IJournalEntry)
  }
  return out
}

// --- runLease ---------------------------------------------------------------------------------

// Take the run for `owner`, by the object's clock. Held by another owner whose lease has not run
// out: refused, and the holder is REVOKED - a newer attempt asked for the run (the engine retried
// the step: it holds the older one for dead, timed out or lost), so the holder's next renew says
// lost and the core aborts it; the newer attempt takes the run once the holder's lease has run out
// (its last renew + the TTL), when nothing of the holder can still be in flight under it.
export const leaseAcquire = (
  sql: ISql,
  runId: string,
  owner: string,
  ttlMs: number,
  now: number,
): boolean => {
  const held = sql
    .exec<{
      owner: string
      until: number
      revoked: number
    }>('SELECT owner, until, revoked FROM lease WHERE run_id = ?', runId)
    .toArray()[0]
  if (held && held.owner !== owner && held.until > now) {
    if (!held.revoked) {
      sql.exec('UPDATE lease SET revoked = 1 WHERE run_id = ?', runId)
    }
    return false
  }
  sql.exec(
    'INSERT INTO lease (run_id, owner, until, revoked) VALUES (?, ?, ?, 0) ' +
      'ON CONFLICT (run_id) DO UPDATE SET owner = excluded.owner, until = excluded.until, revoked = 0',
    runId,
    owner,
    now + ttlMs,
  )
  return true
}

// Still the holder (not revoked, not replaced): extend. False: the lease is lost.
export const leaseRenew = (
  sql: ISql,
  runId: string,
  owner: string,
  ttlMs: number,
  now: number,
): boolean =>
  written(
    sql,
    'UPDATE lease SET until = ? WHERE run_id = ? AND owner = ? AND revoked = 0',
    now + ttlMs,
    runId,
    owner,
  ) > 0

export const leaseRelease = (sql: ISql, runId: string, owner: string): void => {
  sql.exec('DELETE FROM lease WHERE run_id = ? AND owner = ?', runId, owner)
}

// --- the event log ----------------------------------------------------------------------------

export interface IEventRow {
  stream: string
  turn: number
  runId: string
  attempt: number
  seq: number
  turnAttempt: number
  type: string
  json: string
}

// Written once: a retried write is a no-op (both keys: the run's numbers and the stream order).
// Returns the streams that got a new row (whose live readers to wake).
export const insertEvents = (sql: ISql, rows: IEventRow[]): Set<string> => {
  const touched = new Set<string>()
  for (const r of rows) {
    const n = written(
      sql,
      'INSERT INTO events (stream, turn, turn_attempt, seq, run_id, attempt, type, event) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      r.stream,
      r.turn,
      r.turnAttempt,
      r.seq,
      r.runId,
      r.attempt,
      r.type,
      r.json,
    )
    if (n > 0) {
      touched.add(r.stream)
    }
  }
  return touched
}

export const eventsAfter = (
  sql: ISql,
  stream: string,
  after: ICursor,
  limit: number,
): IStreamRow[] =>
  sql
    .exec<{ turn: number; turn_attempt: number; seq: number; event: string }>(
      'SELECT turn, turn_attempt, seq, event FROM events WHERE stream = ? ' +
        'AND (turn, turn_attempt, seq) > (?, ?, ?) ORDER BY turn, turn_attempt, seq LIMIT ?',
      stream,
      after.turn,
      after.attempt,
      after.seq,
      limit,
    )
    .toArray()
    .map((r) => ({ cursor: { turn: r.turn, attempt: r.turn_attempt, seq: r.seq }, json: r.event }))

// An event as stored: capped. One a tool made huge is replaced by a stub that says so; the full
// result is still in the run's snapshot.
export const eventJson = (
  event: { type: string; runId?: string; seq?: number; attempt?: number },
  maxBytes: number,
): string => {
  const json = toJsonText(event)
  const bytes = byteLength(json)
  if (bytes <= maxBytes) {
    return json
  }
  return toJsonText({
    type: event.type,
    runId: event.runId,
    seq: event.seq,
    attempt: event.attempt,
    truncated: true,
    bytes,
  })
}

// The row of one run event; undefined for an event outside a run (no run id / numbers).
export const eventRowOf = (
  event: { type: string; runId?: string; seq?: number; attempt?: number },
  where: { stream: string; turn: number; attemptBase: number },
  maxBytes: number,
): IEventRow | undefined => {
  if (!event.runId || !event.seq || !event.attempt) {
    return undefined
  }
  return {
    stream: where.stream,
    turn: where.turn,
    runId: event.runId,
    attempt: event.attempt,
    seq: event.seq,
    turnAttempt: where.attemptBase + event.attempt,
    type: event.type,
    json: eventJson(event, maxBytes),
  }
}

export type TurnMarker = {
  kind: 'started' | 'ended'
  stream: string
  turn: number
  body: Record<string, unknown>
}

// turn.started sorts before every attempt of its turn, turn.ended after all of them.
export const markerRow = (m: TurnMarker): IEventRow => {
  const slot = m.kind === 'started' ? TURN_START_ATTEMPT : TURN_END_ATTEMPT
  const type = m.kind === 'started' ? 'turn.started' : 'turn.ended'
  return {
    stream: m.stream,
    turn: m.turn,
    runId: `turn-${m.turn}`,
    attempt: slot,
    seq: 0,
    turnAttempt: slot,
    type,
    json: toJsonText({ ...m.body, type, turn: m.turn }),
  }
}

// A child marker in the parent turn's stream (swarm-shared's session-state.ts chose its slot).
export const streamMarkerRow = (m: IStreamMarker): IEventRow => ({
  stream: m.sessionId,
  turn: m.turn,
  runId: `subagents-${m.turn}`,
  attempt: m.turnAttempt,
  seq: m.seq,
  turnAttempt: m.turnAttempt,
  type: m.type,
  json: toJsonText({ ...m.body, type: m.type, turn: m.turn }),
})

// A pipeline's own stream is one "run": turn 1, attempt 1, the engine's events numbered by the
// pipeline's workflow.
export const PIPELINE_STREAM_RUN = 'pipeline'

export const streamBatchRows = (batch: IStreamBatch, maxBytes: number): IEventRow[] => [
  ...(batch.started
    ? [markerRow({ kind: 'started', stream: batch.stream, turn: 1, body: batch.started })]
    : []),
  ...batch.events.map((e) => ({
    stream: batch.stream,
    turn: 1,
    runId: PIPELINE_STREAM_RUN,
    attempt: 1,
    seq: e.seq,
    turnAttempt: 1,
    type: e.event.type,
    json: eventJson(e.event, maxBytes),
  })),
]

export const streamExists = (sql: ISql, stream: string): boolean =>
  sql.exec('SELECT 1 AS x FROM events WHERE stream = ? LIMIT 1', stream).toArray().length > 0

// --- the parked items -------------------------------------------------------------------------

// One upsert per item of a park: a turn that parks again (a partial resume) puts its remaining
// items back to pending (their first position in the listing kept).
export const recordParked = (sql: ISql, rows: Omit<IParkedRow, 'state'>[]): void => {
  for (const r of rows) {
    const ord =
      (sql.exec<{ m: number | null }>('SELECT MAX(ord) AS m FROM parked').one().m ?? 0) + 1
    sql.exec(
      'INSERT INTO parked (session_id, item_id, turn, run_id, kind, answered_by, child_id, item, ' +
        "state, owner_id, owner_item, owner_node, owner_visit, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?) " +
        'ON CONFLICT (session_id, item_id) DO UPDATE SET turn = excluded.turn, run_id = excluded.run_id, ' +
        'kind = excluded.kind, answered_by = excluded.answered_by, child_id = excluded.child_id, ' +
        'item = excluded.item, owner_id = excluded.owner_id, owner_item = excluded.owner_item, ' +
        "owner_node = excluded.owner_node, owner_visit = excluded.owner_visit, state = 'pending'",
      r.sessionId,
      r.itemId,
      r.turn,
      r.runId,
      r.kind,
      r.answeredBy,
      r.childId ?? null,
      toJsonText(r.item),
      r.owner?.workflowId ?? null,
      r.owner?.itemId ?? null,
      r.owner?.nodeId ?? null,
      r.owner?.visit ?? null,
      ord,
    )
  }
}

export const markAnswered = (sql: ISql, sessionId: string, itemIds: string[]): void => {
  for (const id of itemIds) {
    sql.exec(
      "UPDATE parked SET state = 'answered' WHERE session_id = ? AND item_id = ? AND state = 'pending'",
      sessionId,
      id,
    )
  }
}

export const cancelTurn = (sql: ISql, sessionId: string, turn: number): void => {
  sql.exec(
    "UPDATE parked SET state = 'cancelled' WHERE session_id = ? AND turn = ? AND state = 'pending'",
    sessionId,
    turn,
  )
}

// A child's end: whatever it still waits for is closed with it (a later answer is a 404).
export const cancelOwned = (sql: ISql, sessionId: string, owner: string): void => {
  sql.exec(
    "UPDATE parked SET state = 'cancelled' WHERE session_id = ? AND owner_id = ? AND state = 'pending'",
    sessionId,
    owner,
  )
}

interface IParkedRecord {
  session_id: string
  item_id: string
  turn: number
  run_id: string
  kind: IParkedRequest['kind']
  answered_by: AnsweredBy
  child_id: string | null
  item: string
  state: ParkedState
  owner_id: string | null
  owner_item: string | null
  owner_node: string | null
  owner_visit: number | null
}

const SELECT_PARKED =
  'SELECT session_id, item_id, turn, run_id, kind, answered_by, child_id, item, state, ' +
  'owner_id, owner_item, owner_node, owner_visit FROM parked '

const parkedRowOf = (r: IParkedRecord): IParkedRow => ({
  sessionId: r.session_id,
  itemId: r.item_id,
  turn: r.turn,
  runId: r.run_id,
  kind: r.kind,
  answeredBy: r.answered_by,
  ...(r.child_id ? { childId: r.child_id } : {}),
  ...(r.owner_id && r.owner_item
    ? {
        owner: {
          workflowId: r.owner_id,
          itemId: r.owner_item,
          ...(r.owner_node !== null ? { nodeId: r.owner_node } : {}),
          ...(r.owner_visit !== null ? { visit: Number(r.owner_visit) } : {}),
        },
      }
    : {}),
  item: JSON.parse(r.item) as unknown,
  state: r.state,
})

// One item of ONE session: the session is part of the key.
export const parkedItem = (
  sql: ISql,
  sessionId: string,
  itemId: string,
): IParkedRow | undefined => {
  const r = sql
    .exec<IParkedRecord>(`${SELECT_PARKED}WHERE session_id = ? AND item_id = ?`, sessionId, itemId)
    .toArray()[0]
  return r ? parkedRowOf(r) : undefined
}

// A session's calls answered by children of one kind, oldest first.
export const parkedAnsweredBy = (
  sql: ISql,
  sessionId: string,
  by: Exclude<AnsweredBy, 'client'>,
): IParkedRow[] =>
  sql
    .exec<IParkedRecord>(
      `${SELECT_PARKED}WHERE session_id = ? AND answered_by = ? ORDER BY ord, item_id`,
      sessionId,
      by,
    )
    .toArray()
    .map(parkedRowOf)
