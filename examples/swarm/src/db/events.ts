// The run's events in Postgres (`swarm_events`), keyed (session_id, run_id, attempt, seq) - the
// core's own numbers - and ordered for the stream by (turn, turn_attempt, seq). An insert fires
// `NOTIFY swarm_events, '<session id>'` (a statement trigger, sql/001_init.sql), so the gateway's
// live streams wake without polling.
//
// The writer batches: a model streams its answer as many small deltas, and one INSERT per delta
// would be one round trip per token. Events are best effort (retried, then dropped with a log): the
// durable state is the snapshot. Delivery is at-least-once anyway - the step a crash interrupted
// runs again under the next attempt.
import type { AgentEvent } from '@dudko.dev/agent'
import type { ICursor, IStreamBatch, IStreamMarker, IStreamRow } from 'swarm-shared'
import { toJsonText } from './json.ts'
import type { IQueryable, IStatement } from './pool.ts'
import { TURN_END_ATTEMPT, TURN_START_ATTEMPT } from './runs.ts'

export const EVENTS_CHANNEL = 'swarm_events'

export interface IEventRow {
  sessionId: string
  turn: number
  runId: string
  attempt: number
  seq: number
  turnAttempt: number
  type: string
  json: string
}

const COLUMNS = ['session_id', 'turn', 'run_id', 'attempt', 'seq', 'turn_attempt', 'type', 'event']
// 8 parameters a row; a statement takes at most 65535.
export const INSERT_MAX_ROWS = 500

export const insertEventsSql = (rows: IEventRow[]): IStatement => {
  if (rows.length === 0 || rows.length > INSERT_MAX_ROWS) {
    throw new RangeError(`insert 1 to ${INSERT_MAX_ROWS} events at a time, got ${rows.length}`)
  }
  const values: unknown[] = []
  const tuples = rows.map((r) => {
    const at = values.length
    values.push(r.sessionId, r.turn, r.runId, r.attempt, r.seq, r.turnAttempt, r.type, r.json)
    const p = COLUMNS.map((_, i) => `$${at + i + 1}`)
    p[7] = `${p[7]}::jsonb`
    return `(${p.join(', ')})`
  })
  return {
    text: `INSERT INTO swarm_events (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
    values,
  }
}

// The rows after a cursor, in stream order. The row comparison uses the (session_id, turn,
// turn_attempt, seq) index.
export const eventsAfterSql = (sessionId: string, after: ICursor, limit: number): IStatement => ({
  text:
    'SELECT turn, turn_attempt, seq, event::text AS event FROM swarm_events ' +
    'WHERE session_id = $1 AND (turn, turn_attempt, seq) > ($2, $3, $4) ' +
    'ORDER BY turn, turn_attempt, seq LIMIT $5',
  values: [sessionId, after.turn, after.attempt, after.seq, limit],
})

// An event as stored: the core's event (or a pipeline engine's), Errors readable, capped. One a
// tool made huge (a large output) is replaced by a stub that says so; the full result is still in
// the run's snapshot (a pipeline's node texts: in its nodes' own streams).
export const eventJson = (
  event: { type: string; runId?: string; seq?: number; attempt?: number },
  maxBytes: number,
): string => {
  const json = toJsonText(event)
  const bytes = Buffer.byteLength(json)
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
  event: AgentEvent,
  where: { sessionId: string; turn: number; attemptBase: number },
  maxBytes: number,
): IEventRow | undefined => {
  if (!event.runId || !event.seq || !event.attempt) {
    return undefined
  }
  return {
    sessionId: where.sessionId,
    turn: where.turn,
    runId: event.runId,
    attempt: event.attempt,
    seq: event.seq,
    turnAttempt: where.attemptBase + event.attempt,
    type: event.type,
    json: eventJson(event, maxBytes),
  }
}

export type TurnMarker =
  | { kind: 'started'; sessionId: string; turn: number; body: Record<string, unknown> }
  | { kind: 'ended'; sessionId: string; turn: number; body: Record<string, unknown> }

// turn.started sorts before every attempt of its turn, turn.ended after all of them (a late event
// of a dead attempt included). Written once: a retry's marker is a no-op.
export const markerRow = (m: TurnMarker): IEventRow => {
  const slot = m.kind === 'started' ? TURN_START_ATTEMPT : TURN_END_ATTEMPT
  const type = m.kind === 'started' ? 'turn.started' : 'turn.ended'
  return {
    sessionId: m.sessionId,
    turn: m.turn,
    runId: `turn-${m.turn}`,
    attempt: slot,
    seq: 0,
    turnAttempt: slot,
    type,
    json: toJsonText({ ...m.body, type, turn: m.turn }),
  }
}

// A child marker the session workflow writes (swarm-shared's session-state.ts chooses its slot and
// seq: the parked attempt's, above every seq of that attempt). Written once: a retry is a no-op.
export const streamMarkerRow = (m: IStreamMarker): IEventRow => ({
  sessionId: m.sessionId,
  turn: m.turn,
  runId: `subagents-${m.turn}`,
  attempt: m.turnAttempt,
  seq: m.seq,
  turnAttempt: m.turnAttempt,
  type: m.type,
  json: toJsonText({ ...m.body, type: m.type, turn: m.turn }),
})

// A pipeline's own stream is one "run" of the workflow: turn 1, attempt 1, the engine's events
// numbered by the workflow (swarm-shared's pipeline-state.ts). The run id column keys the
// stream's rows.
export const PIPELINE_STREAM_RUN = 'pipeline'

// The rows of one batch of a pipeline's own stream: its turn.started (the first batch), then its
// events. Written once: a retried batch is a no-op.
export const streamBatchRows = (batch: IStreamBatch, maxBytes: number): IEventRow[] => [
  ...(batch.started
    ? [markerRow({ kind: 'started', sessionId: batch.stream, turn: 1, body: batch.started })]
    : []),
  ...batch.events.map((e) => ({
    sessionId: batch.stream,
    turn: 1,
    runId: PIPELINE_STREAM_RUN,
    attempt: 1,
    seq: e.seq,
    turnAttempt: 1,
    type: e.event.type,
    json: eventJson(e.event, maxBytes),
  })),
]

export interface IEventWriter {
  push: (event: AgentEvent) => void
  // Resolves once everything pushed so far is written (or given up on). Never rejects.
  flush: () => Promise<void>
}

export interface IEventWriterOptions {
  sessionId: string
  turn: number
  attemptBase: number
  maxEventBytes: number
  flushMs?: number
  maxBatch?: number
  retries?: number
  onError?: (err: unknown, dropped: number) => void
  sleep?: (ms: number) => Promise<void>
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref?.())

export const createEventWriter = (db: IQueryable, o: IEventWriterOptions): IEventWriter => {
  const flushMs = o.flushMs ?? 25
  const maxBatch = Math.min(o.maxBatch ?? 200, INSERT_MAX_ROWS)
  const retries = o.retries ?? 3
  const sleep = o.sleep ?? delay
  let buffer: IEventRow[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()

  const insert = async (rows: IEventRow[]): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const { text, values } = insertEventsSql(rows)
        await db.query(text, values)
        return
      } catch (err) {
        if (attempt >= retries) {
          o.onError?.(err, rows.length)
          return
        }
        await sleep(100 * 4 ** attempt)
      }
    }
  }

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (buffer.length) {
      const batch = buffer
      buffer = []
      // In order: a batch is written only after the one before it.
      chain = chain.then(() => insert(batch))
    }
    return chain
  }

  return {
    push: (event) => {
      const row = eventRowOf(event, o, o.maxEventBytes)
      if (!row) {
        return
      }
      buffer.push(row)
      if (buffer.length >= maxBatch) {
        void flush()
      } else if (!timer) {
        timer = setTimeout(() => void flush(), flushMs)
        timer.unref?.()
      }
    },
    flush,
  }
}

export interface IEventStore {
  writer: (options: Omit<IEventWriterOptions, 'maxEventBytes'>) => IEventWriter
  marker: (m: TurnMarker) => Promise<void>
  // Child markers, in order, one statement (at most INSERT_MAX_ROWS).
  streamMarkers: (markers: IStreamMarker[]) => Promise<void>
  // A batch of a pipeline's own stream, in order.
  streamBatch: (batch: IStreamBatch) => Promise<void>
  after: (sessionId: string, after: ICursor, limit: number) => Promise<IStreamRow[]>
}

export const createEventStore = (db: IQueryable, maxEventBytes: number): IEventStore => ({
  writer: (options) => createEventWriter(db, { ...options, maxEventBytes }),
  marker: async (m) => {
    const { text, values } = insertEventsSql([markerRow(m)])
    await db.query(text, values)
  },
  streamMarkers: async (markers) => {
    for (let i = 0; i < markers.length; i += INSERT_MAX_ROWS) {
      const { text, values } = insertEventsSql(
        markers.slice(i, i + INSERT_MAX_ROWS).map(streamMarkerRow),
      )
      await db.query(text, values)
    }
  },
  streamBatch: async (batch) => {
    const rows = streamBatchRows(batch, maxEventBytes)
    for (let i = 0; i < rows.length; i += INSERT_MAX_ROWS) {
      const { text, values } = insertEventsSql(rows.slice(i, i + INSERT_MAX_ROWS))
      await db.query(text, values)
    }
  },
  after: async (sessionId, after, limit) => {
    const { text, values } = eventsAfterSql(sessionId, after, limit)
    const rows = (
      await db.query<{ turn: number; turn_attempt: number; seq: number; event: string }>(
        text,
        values,
      )
    ).rows
    return rows.map((r) => ({
      cursor: { turn: r.turn, attempt: r.turn_attempt, seq: r.seq },
      json: r.event,
    }))
  },
})
