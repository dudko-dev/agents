// The `migrate` role: apply sql/NNN_name.sql in order, each once, all in ONE transaction under an
// advisory lock (two migrate jobs at once wait for each other; a failure applies nothing). A file
// that was applied and then changed is refused: migrations are append-only.
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inTransaction, type IDatabase } from './pool.ts'

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../sql/', import.meta.url))
// Any constant: the key of the advisory lock the migrators share.
const LOCK_KEY = 727_004_001
const FILE = /^[0-9]{3,}_[a-z0-9_]+\.sql$/

export interface IMigration {
  name: string
  sql: string
  sha256: string
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export const loadMigrations = async (dir: string = MIGRATIONS_DIR): Promise<IMigration[]> => {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()
  const bad = names.filter((n) => !FILE.test(n))
  if (bad.length) {
    throw new Error(`migration files must be named NNN_name.sql: ${bad.join(', ')}`)
  }
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8')
      return { name, sql, sha256: sha256(sql) }
    }),
  )
}

export type MigrationPlan = { ok: true; pending: IMigration[] } | { ok: false; error: string }

// What to apply, given what is on record. Pure.
export const planMigrations = (
  files: IMigration[],
  applied: Map<string, string>,
): MigrationPlan => {
  const changed = files.filter((f) => applied.has(f.name) && applied.get(f.name) !== f.sha256)
  if (changed.length) {
    return {
      ok: false,
      error: `applied migrations were edited: ${changed.map((f) => f.name).join(', ')} - add a new file instead`,
    }
  }
  const known = new Set(files.map((f) => f.name))
  const missing = [...applied.keys()].filter((name) => !known.has(name))
  if (missing.length) {
    return {
      ok: false,
      error: `the database has migrations this image does not: ${missing.join(', ')} - is the image older than the schema?`,
    }
  }
  return { ok: true, pending: files.filter((f) => !applied.has(f.name)) }
}

export const migrate = async (
  db: IDatabase,
  options: { dir?: string; log?: (message: string) => void } = {},
): Promise<string[]> => {
  const files = await loadMigrations(options.dir)
  return inTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY])
    await client.query(
      'CREATE TABLE IF NOT EXISTS swarm_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    )
    const rows = (
      await client.query<{ name: string; sha256: string }>(
        'SELECT name, sha256 FROM swarm_migrations',
      )
    ).rows
    const plan = planMigrations(files, new Map(rows.map((r) => [r.name, r.sha256])))
    if (!plan.ok) {
      throw new Error(plan.error)
    }
    for (const m of plan.pending) {
      options.log?.(`[migrate] applying ${m.name}`)
      // No parameters: the simple query protocol, so a file may hold many statements.
      await client.query(m.sql)
      await client.query('INSERT INTO swarm_migrations (name, sha256) VALUES ($1, $2)', [
        m.name,
        m.sha256,
      ])
    }
    return plan.pending.map((m) => m.name)
  })
}
