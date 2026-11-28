// Run snapshots in Postgres (`swarm_runs`): the agent's `persistence`, and which run belongs to
// which turn of which session.
//
// A fresh run's id is named by the activity (`agent.run({ runId })`, a function of the stream, the
// turn and the run's number in it - activities.ts, `runIdOf`), and the run is BOUND to the turn
// the moment its lease is taken (`bindRun`, before the run does anything): the retry of a turn
// looks the run up by (session, turn) and resumes it. `run_no` counts the runs of one turn: a turn
// whose worker died before the first snapshot (no plan yet - nothing to resume; the core also
// refuses to start a run again under an id that has journal entries) supersedes the first run and
// starts a second one.
//
// Every write is fenced by `attempt`: a checkpoint may not go below the attempt on record, a
// resume must go above it. A worker that lost its turn (a paused process, a partition) cannot
// overwrite the snapshot of the attempt that replaced it. And by `fence`: the attempt a resume
// claims when it takes the run (`fenceRun`, from the lease's acquire), before it reads the
// snapshot or the journal - from that moment an older attempt writes nothing, not even in the
// window before the resume puts its own attempt on record. The journal's appends are fenced the
// same way (journal.ts).
//
// A run that cannot be resumed (bound, but no plan on record: its first snapshot, onRunStart, is
// written only once the planner has answered) is SUPERSEDED before its turn starts the next run
// (`supersedeRun`): its fence goes to the top, so no attempt of it writes anything again - the
// worker still running it (lost the turn before that first snapshot and does not know yet) gets
// its next journal append refused and the core stops the run before any tool call it makes runs.
import type { IPersistence, IRunSnapshot } from '@dudko.dev/agent'
import { toJsonText } from './json.ts'
import type { IQueryable, IStatement } from './pool.ts'

// The turn markers' slot in a turn's order: turn.started before every attempt, turn.ended after.
export const TURN_START_ATTEMPT = 0
export const TURN_END_ATTEMPT = 2147483647

export interface IRunBinding {
  runId: string
  sessionId: string
  turn: number
  runNo: number
  // Added to the core's attempt to order the turn's events across its runs (see events.ts).
  attemptBase: number
}

export interface IRunRow extends IRunBinding {
  // The attempt of the last snapshot written (1 before any).
  attempt: number
  status: IRunSnapshot['status'] | null
  snapshot: IRunSnapshot | null
}

export type SnapshotWrite = 'checkpoint' | 'resume'

export const bindRunSql = (b: IRunBinding): IStatement => ({
  text:
    'INSERT INTO swarm_runs (run_id, session_id, turn, run_no, attempt_base, attempt) ' +
    'VALUES ($1, $2, $3, $4, $5, 1) ON CONFLICT DO NOTHING RETURNING run_id',
  values: [b.runId, b.sessionId, b.turn, b.runNo, b.attemptBase],
})

export const latestRunOfTurnSql = (sessionId: string, turn: number): IStatement => ({
  text:
    'SELECT run_id, session_id, turn, run_no, attempt_base, attempt, status, snapshot ' +
    'FROM swarm_runs WHERE session_id = $1 AND turn = $2 ORDER BY run_no DESC LIMIT 1',
  values: [sessionId, turn],
})

// The attempt numbers a new run of the turn must start above: every attempt the turn's earlier
// runs have on record, in snapshots or in events (the turn markers excluded).
export const nextAttemptBaseSql = (sessionId: string, turn: number): IStatement => ({
  text:
    'SELECT GREATEST(' +
    'COALESCE((SELECT MAX(attempt_base + attempt) FROM swarm_runs WHERE session_id = $1 AND turn = $2), 0), ' +
    'COALESCE((SELECT MAX(turn_attempt) FROM swarm_events WHERE session_id = $1 AND turn = $2 ' +
    'AND turn_attempt > 0 AND turn_attempt < $3), 0)) AS base',
  values: [sessionId, turn, TURN_END_ATTEMPT],
})

// A checkpoint keeps or raises the attempt on record; a resume must raise it (two resumes of the
// same snapshot would otherwise share an attempt number).
export const writeSnapshotSql = (s: IRunSnapshot, mode: SnapshotWrite): IStatement => ({
  text:
    'UPDATE swarm_runs SET snapshot = $2::jsonb, status = $3, attempt = $4, lease_owner = $5, ' +
    `updated_at = now() WHERE run_id = $1 AND attempt ${mode === 'resume' ? '<' : '<='} $4 ` +
    'AND fence <= $4',
  values: [s.runId, toJsonText(s), s.status, s.attempt ?? 1, s.leaseOwner ?? null],
})

// A resume takes the run: the attempt it will run as (the one on record + 1) becomes the fence.
// Never lowered; no row (the run is not bound) refuses the resume.
export const fenceRunSql = (runId: string): IStatement => ({
  text: 'UPDATE swarm_runs SET fence = GREATEST(fence, attempt + 1) WHERE run_id = $1 RETURNING fence',
  values: [runId],
})

// A superseded run's fence: above every attempt the core gives a run (it counts them from 1, one
// per resume), so every write of the run is refused - snapshot, journal entry, resume.
export const SUPERSEDED_FENCE = 2147483647

// Supersede a run its turn cannot resume - only while it still has no plan on record, checked in
// the same statement that raises the fence, under the row's lock: when a late snapshot with a plan
// committed first, nothing changes (no row), and the turn resumes that run instead. The UPDATE
// waits for every journal append that read the old fence (they hold the row FOR SHARE); writes
// that come after it re-read the row and are refused.
export const supersedeRunSql = (runId: string): IStatement => ({
  text:
    'UPDATE swarm_runs SET fence = $2 WHERE run_id = $1 ' +
    "AND (snapshot IS NULL OR jsonb_typeof(snapshot -> 'plan') IS DISTINCT FROM 'object') " +
    'RETURNING run_id',
  values: [runId, SUPERSEDED_FENCE],
})

export const loadRunSql = (runId: string): IStatement => ({
  text: 'SELECT snapshot FROM swarm_runs WHERE run_id = $1',
  values: [runId],
})

export class SnapshotFencedError extends Error {
  constructor(runId: string, attempt: number, mode: SnapshotWrite) {
    super(
      mode === 'resume'
        ? `run ${runId}: attempt ${attempt} is not above the attempt on record (or the run is not bound) - refusing the resume`
        : `run ${runId}: a newer attempt than ${attempt} is on record (or the run is not bound) - this worker lost the run`,
    )
    this.name = 'SnapshotFencedError'
  }
}

interface IRunRecord {
  run_id: string
  session_id: string
  turn: number
  run_no: number
  attempt_base: number
  attempt: number
  status: IRunSnapshot['status'] | null
  snapshot: IRunSnapshot | null
}

export interface IRunStore {
  bindRun: (binding: IRunBinding) => Promise<boolean>
  // The fence a resume raises: the attempt it claims; undefined when the run is not bound.
  fenceRun: (runId: string) => Promise<number | undefined>
  // Supersede a run the turn cannot resume (supersedeRunSql); false when it is not bound or has
  // a plan on record by now (resume it instead).
  supersedeRun: (runId: string) => Promise<boolean>
  latestRunOfTurn: (sessionId: string, turn: number) => Promise<IRunRow | undefined>
  nextAttemptBase: (sessionId: string, turn: number) => Promise<number>
}

export const createRunStore = (db: IQueryable): IRunStore => ({
  bindRun: async (binding) => {
    const { text, values } = bindRunSql(binding)
    return ((await db.query(text, values)).rowCount ?? 0) > 0
  },
  fenceRun: async (runId) => {
    const { text, values } = fenceRunSql(runId)
    const row = (await db.query<{ fence: number }>(text, values)).rows[0]
    return row ? Number(row.fence) : undefined
  },
  supersedeRun: async (runId) => {
    const { text, values } = supersedeRunSql(runId)
    return ((await db.query(text, values)).rowCount ?? 0) > 0
  },
  latestRunOfTurn: async (sessionId, turn) => {
    const { text, values } = latestRunOfTurnSql(sessionId, turn)
    const row = (await db.query<IRunRecord>(text, values)).rows[0]
    return row
      ? {
          runId: row.run_id,
          sessionId: row.session_id,
          turn: row.turn,
          runNo: row.run_no,
          attemptBase: row.attempt_base,
          attempt: row.attempt,
          status: row.status,
          snapshot: row.snapshot,
        }
      : undefined
  },
  nextAttemptBase: async (sessionId, turn) => {
    const { text, values } = nextAttemptBaseSql(sessionId, turn)
    const row = (await db.query<{ base: number | string }>(text, values)).rows[0]
    return Number(row?.base ?? 0)
  },
})

export const createPostgresPersistence = (db: IQueryable): IPersistence => {
  const write = async (snapshot: IRunSnapshot, mode: SnapshotWrite): Promise<void> => {
    const { text, values } = writeSnapshotSql(snapshot, mode)
    const result = await db.query(text, values)
    if ((result.rowCount ?? 0) === 0) {
      throw new SnapshotFencedError(snapshot.runId, snapshot.attempt ?? 1, mode)
    }
  }
  return {
    onRunStart: (s) => write(s, 'checkpoint'),
    onStepComplete: (s) => write(s, 'checkpoint'),
    onRunComplete: (s) => write(s, 'checkpoint'),
    // Not fail-open in the core: a throw here refuses the resume.
    onRunResume: (s) => write(s, 'resume'),
    loadRun: async (runId) => {
      const { text, values } = loadRunSql(runId)
      const row = (await db.query<{ snapshot: IRunSnapshot | null }>(text, values)).rows[0]
      return row?.snapshot ?? null
    },
  }
}
