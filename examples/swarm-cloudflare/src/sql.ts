// What the session's Durable Object needs of its storage: SQLite's `exec` (the shape of a Durable
// Object's `ctx.storage.sql`) and a synchronous transaction. The DO passes its own storage; the unit
// tests pass `node:sqlite` behind the same shape (tests/helpers/sqlite.ts), so every table, fence
// and transition below runs in Node without workerd.
export type SqlValue = string | number | null

export interface ISqlCursor<T> {
  toArray: () => T[]
  one: () => T
  readonly rowsWritten: number
}

export interface ISql {
  exec: <T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) => ISqlCursor<T>
}

export interface IStorage {
  sql: ISql
  // Everything `fn` writes commits together, or nothing does (a throw rolls back).
  transactionSync: <T>(fn: () => T) => T
}

// A Durable Object's SQLite keeps a row (a string) up to 2 MB. A value that may be larger - the
// session's state, a run snapshot, a journal entry, a turn's input - is cut into parts this long
// (characters; at most 3 bytes each in UTF-8), never inside a surrogate pair.
export const PART_CHARS = 400_000

export const splitText = (text: string, size = PART_CHARS): string[] => {
  const parts: string[] = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(text.length, at + size)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1
    }
    parts.push(text.slice(at, end))
    at = end
  }
  return parts.length ? parts : ['']
}
