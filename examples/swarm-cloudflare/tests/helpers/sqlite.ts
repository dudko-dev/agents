// A Durable Object's storage over node:sqlite: the shape of `ctx.storage.sql` (`exec` with
// bindings, `toArray` / `one` / `rowsWritten`) and `transactionSync`, so the object's tables and
// transitions run in Node (src/sql.ts).
import { DatabaseSync } from 'node:sqlite'
import type { ISql, ISqlCursor, IStorage, SqlValue } from '../../src/sql.ts'

export const memoryStorage = (): IStorage & { db: DatabaseSync } => {
  const db = new DatabaseSync(':memory:')
  const sql: ISql = {
    exec: <T>(query: string, ...bindings: SqlValue[]): ISqlCursor<T> => {
      const stmt = db.prepare(query)
      const reads = stmt.columns().length > 0
      let rows: T[] = []
      let written = 0
      if (reads) {
        rows = stmt.all(...bindings) as T[]
        if (!/^\s*select\b/i.test(query)) {
          written = Number((db.prepare('SELECT changes() AS n').get() as { n: number }).n)
        }
      } else {
        written = Number(stmt.run(...bindings).changes)
      }
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`)
          return rows[0]!
        },
        rowsWritten: written,
      }
    },
  }
  let depth = 0
  return {
    db,
    sql,
    transactionSync: <T>(fn: () => T): T => {
      // Nested calls join the outer transaction (as the object's do).
      if (depth > 0) return fn()
      db.exec('BEGIN')
      depth += 1
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      } finally {
        depth -= 1
      }
    },
  }
}
