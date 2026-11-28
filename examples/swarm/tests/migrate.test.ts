// The migration plan (pure) and the files the image ships.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadMigrations, planMigrations, sha256, type IMigration } from '../src/db/migrate.ts'

const m = (name: string, sql = name): IMigration => ({ name, sql, sha256: sha256(sql) })

test('the shipped migrations are named, ordered and create what the adapters use', async () => {
  const files = await loadMigrations()
  assert.deepEqual(
    files.map((f) => f.name),
    ['001_init.sql'],
  )
  const sql = files[0]!.sql
  for (const table of ['swarm_sessions', 'swarm_runs', 'swarm_events', 'swarm_limiter']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table} `))
  }
  assert.match(sql, /PRIMARY KEY \(session_id, run_id, attempt, seq\)/)
  assert.match(sql, /swarm_events \(session_id, turn, turn_attempt, seq\)/)
  assert.match(sql, /pg_notify\('swarm_events', s\.session_id\)/)
})

test('plan: pending in order, nothing twice, an edited or unknown migration refused', () => {
  const files = [m('001_a.sql'), m('002_b.sql')]
  assert.deepEqual(planMigrations(files, new Map()), { ok: true, pending: files })
  assert.deepEqual(planMigrations(files, new Map([['001_a.sql', files[0]!.sha256]])), {
    ok: true,
    pending: [files[1]],
  })
  const edited = planMigrations(files, new Map([['001_a.sql', sha256('something else')]]))
  assert.equal(edited.ok, false)
  assert.match(edited.ok ? '' : edited.error, /were edited: 001_a\.sql/)
  const newer = planMigrations(files, new Map([['003_c.sql', 'x']]))
  assert.equal(newer.ok, false)
  assert.match(newer.ok ? '' : newer.error, /003_c\.sql/)
})

test('loadMigrations refuses a file that is not NNN_name.sql', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-migrations-'))
  try {
    await writeFile(join(dir, '001_ok.sql'), 'SELECT 1;')
    await writeFile(join(dir, 'notes.txt'), 'ignored')
    assert.equal((await loadMigrations(dir)).length, 1)
    await writeFile(join(dir, 'Init.sql'), 'SELECT 1;')
    await assert.rejects(async () => loadMigrations(dir), /NNN_name\.sql: Init\.sql/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
