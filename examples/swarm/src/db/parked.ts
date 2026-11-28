// The items parked turns wait for (`swarm_parked`): written by the turn activity when its run
// parks, read by the gateway to check an answer before it signals the session - so an answer
// can be checked (and sent) while no worker runs - and to list a session's subagent and pipeline
// calls. A child's run that parks (a subagent child, a pipeline node visit) records its items
// here too: under the session, in the parent's turn, OWNED by the child workflow (`owner`) - the
// gateway signals the answer to that child, once it has checked the child is the session's.
//
//   pending   - the turn (or the child) waits for it
//   answered  - the turn went on with its answer (marked when the resume starts)
//   cancelled - the turn was stopped while it waited (or the child ended)
import type { IParkedRequest } from '../session-types.ts'
import { toJsonText } from './json.ts'
import type { IQueryable, IStatement } from './pool.ts'

export type ParkedState = 'pending' | 'answered' | 'cancelled'

// Who answers an item: a client (a person, an outside system) or a child workflow of the session.
export type AnsweredBy = 'client' | 'subagent' | 'pipeline'

// The child workflow that waits for an item (a child's own park): its workflow id, the parked
// turn's item it answers, and - a pipeline node visit - the node and the visit.
export interface IParkedOwner {
  workflowId: string
  itemId: string
  nodeId?: string
  visit?: number
}

export interface IParkedRow {
  sessionId: string
  itemId: string
  turn: number
  runId: string
  kind: IParkedRequest['kind']
  answeredBy: AnsweredBy
  // The child workflow that answers it (answeredBy 'subagent' / 'pipeline').
  childId?: string
  // The child workflow that WAITS for it (a child's own item; answeredBy 'client').
  owner?: IParkedOwner
  item: unknown
  state: ParkedState
}

const COLUMNS = [
  'session_id',
  'turn',
  'item_id',
  'run_id',
  'kind',
  'answered_by',
  'child_id',
  'item',
  'owner_id',
  'owner_item',
  'owner_node',
  'owner_visit',
] as const

// One upsert for every item of a park: a turn that parks again (a partial resume) puts its
// remaining items back to pending.
export const recordParkedSql = (rows: Omit<IParkedRow, 'state'>[]): IStatement => {
  const values: unknown[] = []
  const tuples = rows.map((r) => {
    const at = values.length
    values.push(
      r.sessionId,
      r.turn,
      r.itemId,
      r.runId,
      r.kind,
      r.answeredBy,
      r.childId ?? null,
      toJsonText(r.item),
      r.owner?.workflowId ?? null,
      r.owner?.itemId ?? null,
      r.owner?.nodeId ?? null,
      r.owner?.visit ?? null,
    )
    const p = COLUMNS.map((_, i) => `$${at + i + 1}`)
    p[7] = `${p[7]}::jsonb`
    return `(${p.join(', ')})`
  })
  return {
    text:
      `INSERT INTO swarm_parked (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')} ` +
      'ON CONFLICT (session_id, item_id) DO UPDATE SET turn = EXCLUDED.turn, ' +
      'run_id = EXCLUDED.run_id, kind = EXCLUDED.kind, answered_by = EXCLUDED.answered_by, ' +
      'child_id = EXCLUDED.child_id, item = EXCLUDED.item, owner_id = EXCLUDED.owner_id, ' +
      'owner_item = EXCLUDED.owner_item, owner_node = EXCLUDED.owner_node, ' +
      "owner_visit = EXCLUDED.owner_visit, state = 'pending', updated_at = now()",
    values,
  }
}

export const markAnsweredSql = (sessionId: string, itemIds: string[]): IStatement => ({
  text:
    "UPDATE swarm_parked SET state = 'answered', updated_at = now() " +
    "WHERE session_id = $1 AND item_id = ANY($2::text[]) AND state = 'pending'",
  values: [sessionId, itemIds],
})

export const cancelTurnSql = (sessionId: string, turn: number): IStatement => ({
  text:
    "UPDATE swarm_parked SET state = 'cancelled', updated_at = now() " +
    "WHERE session_id = $1 AND turn = $2 AND state = 'pending'",
  values: [sessionId, turn],
})

// A child's end: whatever it still waits for is closed with it (a later answer is a 404).
export const cancelOwnedSql = (sessionId: string, owner: string): IStatement => ({
  text:
    "UPDATE swarm_parked SET state = 'cancelled', updated_at = now() " +
    "WHERE session_id = $1 AND owner_id = $2 AND state = 'pending'",
  values: [sessionId, owner],
})

const SELECT =
  'SELECT session_id, item_id, turn, run_id, kind, answered_by, child_id, item, state, ' +
  'owner_id, owner_item, owner_node, owner_visit FROM swarm_parked '

// One item of ONE session: the session is part of the key - an item of another session is not
// found, exactly as an unknown one.
export const parkedItemSql = (sessionId: string, itemId: string): IStatement => ({
  text: `${SELECT}WHERE session_id = $1 AND item_id = $2`,
  values: [sessionId, itemId],
})

// A session's calls answered by children of one kind ('subagent' / 'pipeline'), oldest first.
export const childrenOfSql = (
  sessionId: string,
  by: Exclude<AnsweredBy, 'client'>,
): IStatement => ({
  text: `${SELECT}WHERE session_id = $1 AND answered_by = $2 ORDER BY created_at, item_id`,
  values: [sessionId, by],
})

export const subagentsOfSql = (sessionId: string): IStatement =>
  childrenOfSql(sessionId, 'subagent')
export const pipelinesOfSql = (sessionId: string): IStatement =>
  childrenOfSql(sessionId, 'pipeline')

interface IRecord {
  session_id: string
  item_id: string
  turn: number
  run_id: string
  kind: IParkedRequest['kind']
  answered_by: AnsweredBy
  child_id: string | null
  item: unknown
  state: ParkedState
  owner_id: string | null
  owner_item: string | null
  owner_node: string | null
  owner_visit: number | null
}

const rowOf = (r: IRecord): IParkedRow => ({
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
  item: r.item,
  state: r.state,
})

export interface IParkedStore {
  record: (rows: Omit<IParkedRow, 'state'>[]) => Promise<void>
  markAnswered: (sessionId: string, itemIds: string[]) => Promise<void>
  cancelTurn: (sessionId: string, turn: number) => Promise<void>
  cancelOwned: (sessionId: string, owner: string) => Promise<void>
  item: (sessionId: string, itemId: string) => Promise<IParkedRow | undefined>
  subagents: (sessionId: string) => Promise<IParkedRow[]>
  pipelines: (sessionId: string) => Promise<IParkedRow[]>
}

export const createParkedStore = (db: IQueryable): IParkedStore => ({
  record: async (rows) => {
    if (rows.length === 0) return
    const { text, values } = recordParkedSql(rows)
    await db.query(text, values)
  },
  markAnswered: async (sessionId, itemIds) => {
    if (itemIds.length === 0) return
    const { text, values } = markAnsweredSql(sessionId, itemIds)
    await db.query(text, values)
  },
  cancelTurn: async (sessionId, turn) => {
    const { text, values } = cancelTurnSql(sessionId, turn)
    await db.query(text, values)
  },
  cancelOwned: async (sessionId, owner) => {
    const { text, values } = cancelOwnedSql(sessionId, owner)
    await db.query(text, values)
  },
  item: async (sessionId, itemId) => {
    const { text, values } = parkedItemSql(sessionId, itemId)
    const row = (await db.query<IRecord>(text, values)).rows[0]
    return row ? rowOf(row) : undefined
  },
  subagents: async (sessionId) => {
    const { text, values } = subagentsOfSql(sessionId)
    return (await db.query<IRecord>(text, values)).rows.map(rowOf)
  },
  pipelines: async (sessionId) => {
    const { text, values } = pipelinesOfSql(sessionId)
    return (await db.query<IRecord>(text, values)).rows.map(rowOf)
  },
})
