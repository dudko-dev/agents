// The agent's call journal (`persistence.journal`) in Postgres, `swarm_journal`: one row per entry,
// read back in the order it was appended. It is what makes a resume EXACT (a recorded model call
// is not sent again, a recorded tool call does not run again) and what parking needs.
//
// Appends are fenced like the snapshots: an entry is kept only while its attempt is not below the
// attempt on record for the run nor below the fence a resume raised when it took the run
// (runs.ts). A worker that lost its turn and does not know it yet (a paused process, a partition)
// gets its append refused; the core then stops that run (an append is fail-closed), so the late
// worker can neither add a stale entry the next resume would replay nor go on with side effects.
//
// One statement, and it takes the run's row FOR SHARE: the fence (an UPDATE of that row) waits for
// every append that read the old fence to commit, and an append that comes after it re-reads the
// row and is refused. So once the fence is up, the resume's `load` sees every entry an older
// attempt will ever have - none can land behind it. (Without the lock, an append whose snapshot
// predates the fence could commit after the resume read the journal.)
import type { IJournalEntry, IRunJournal } from '@dudko.dev/agent'
import type { IQueryable, IStatement } from './pool.ts'

export const appendJournalSql = (runId: string, entry: IJournalEntry): IStatement => ({
  text:
    'INSERT INTO swarm_journal (run_id, entry_id, attempt, entry) ' +
    'SELECT $1::text, $2::text, $3::integer, $4::text FROM swarm_runs ' +
    'WHERE run_id = $1 AND attempt <= $3 AND fence <= $3 FOR SHARE',
  values: [runId, entry.id, entry.attempt, JSON.stringify(entry)],
})

export const loadJournalSql = (runId: string): IStatement => ({
  text: 'SELECT entry FROM swarm_journal WHERE run_id = $1 ORDER BY n',
  values: [runId],
})

export class JournalFencedError extends Error {
  constructor(runId: string, attempt: number) {
    super(
      `run ${runId}: attempt ${attempt} may not append to the journal - a newer attempt took the run (or the run is not bound); this worker lost the run`,
    )
    this.name = 'JournalFencedError'
  }
}

export const createPostgresJournal = (db: IQueryable): IRunJournal => ({
  append: async (runId, entry) => {
    const { text, values } = appendJournalSql(runId, entry)
    if (((await db.query(text, values)).rowCount ?? 0) === 0) {
      throw new JournalFencedError(runId, entry.attempt)
    }
  },
  load: async (runId) => {
    const { text, values } = loadJournalSql(runId)
    const rows = (await db.query<{ entry: string }>(text, values)).rows
    return rows.map((r) => JSON.parse(r.entry) as IJournalEntry)
  },
})
