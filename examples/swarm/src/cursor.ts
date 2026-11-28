// The event stream's cursor: `<turn>:<attempt>:<seq>`. A session is many runs (one per turn), so
// the turn comes first; inside a turn, the core's (attempt, seq) order. `attempt` is the TURN's
// attempt - the run's own attempt, plus the attempts of earlier runs of the same turn when a turn
// had to start from scratch (its worker died before the first snapshot; see db/runs.ts). Clients
// treat a cursor as opaque: they send back the last `id:` they saw. Pure; no imports.

export interface ICursor {
  turn: number
  attempt: number
  seq: number
}

// Before everything: turns are numbered from 1.
export const START_CURSOR: ICursor = { turn: 0, attempt: 0, seq: 0 }

// Each part is a Postgres integer.
export const CURSOR_PART_MAX = 2147483647
export const CURSOR_MAX_CHARS = 40

export type CursorParse = { ok: true; cursor: ICursor } | { ok: false; error: string }

const PART = /^(0|[1-9][0-9]{0,9})$/

export const parseCursor = (raw: string | null | undefined): CursorParse => {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return { ok: true, cursor: START_CURSOR }
  }
  const text = raw.trim()
  if (text.length > CURSOR_MAX_CHARS) {
    return { ok: false, error: `a cursor is at most ${CURSOR_MAX_CHARS} characters` }
  }
  const parts = text.split(':')
  if (parts.length !== 3 || !parts.every((p) => PART.test(p))) {
    return { ok: false, error: 'a cursor is <turn>:<attempt>:<seq>, three non-negative integers' }
  }
  const [turn, attempt, seq] = parts.map(Number) as [number, number, number]
  if (turn > CURSOR_PART_MAX || attempt > CURSOR_PART_MAX || seq > CURSOR_PART_MAX) {
    return { ok: false, error: `each part of a cursor is at most ${CURSOR_PART_MAX}` }
  }
  return { ok: true, cursor: { turn, attempt, seq } }
}

export const formatCursor = (c: ICursor): string => `${c.turn}:${c.attempt}:${c.seq}`

export const compareCursors = (a: ICursor, b: ICursor): number =>
  a.turn - b.turn || a.attempt - b.attempt || a.seq - b.seq
