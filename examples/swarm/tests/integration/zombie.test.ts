// A worker PAUSED (SIGSTOP) before its run wrote its first snapshot - in the middle of the
// planner call, with the run bound to the turn and nothing to resume: its heartbeat times out,
// Temporal retries the turn on the other worker, which cannot resume that run (no plan on record)
// and starts the turn's next run. Before it does, it supersedes the first run (its fence goes to
// the top), so when the paused worker wakes (SIGCONT) - and does not know yet that it lost the
// turn - its very next journal append is refused, the core stops the run fail-closed, and its
// tool call never runs. The write runs once, and the turn ends once, with the second run's answer.
//
// Deterministic, not a race: the paused worker's planner answer lands in its socket while it is
// stopped, so on SIGCONT it reads the answer at once and appends it - well before its lease's
// next renew (LEASE_TTL_MS / 3) can learn from Temporal that the turn moved.
import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import type { TestWorkflowEnvironment } from '@temporalio/testing'
import type pg from 'pg'
import { runIdOf } from '../../src/activities.ts'
import { SUPERSEDED_FENCE } from '../../src/db/runs.ts'
import type { IRunningGateway } from '../../src/gateway-main.ts'
import { workflowIdOf } from '../../src/session-api.ts'
import {
  api,
  childWorker,
  DATABASE_URL,
  gatewayConfig,
  inProcessGateway,
  migrated,
  planJson,
  readSse,
  roundOf,
  sessionOptions,
  stageOf,
  startLocalOpenAI,
  startTemporal,
  toolNames,
  toolResults,
  uniqueQueue,
  until,
  type ILocalOpenAI,
  type ISseEvent,
} from './harness.ts'

const NOTES_WORKER = fileURLToPath(new URL('./notes-worker.ts', import.meta.url))

let temporal: TestWorkflowEnvironment
let pool: pg.Pool
let llm: ILocalOpenAI
let gateway: IRunningGateway
let queue: string
let dir: string
let notes: string
const children: ChildProcess[] = []
const calls: Record<string, number> = {}
const count = (key: string): number => (calls[key] = (calls[key] ?? 0) + 1)

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  dir = mkdtempSync(join(tmpdir(), 'swarm-zombie-'))
  notes = join(dir, 'notes.txt')
  writeFileSync(notes, '')
  llm = await startLocalOpenAI((req) => {
    const stage = stageOf(req)
    count(stage)
    if (stage === 'planner') {
      // The first worker's planner answer comes late: it is paused before it reads it.
      return calls.planner === 1
        ? { text: planJson(['w']), delayMs: 1500 }
        : { text: planJson(['w']) }
    }
    if (stage === 'replanner') {
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    }
    if (stage === 'synthesizer') return { text: 'the note is written' }
    if (roundOf(req) === 0 && toolNames(req).includes('write_note')) {
      return { toolCalls: [{ name: 'write_note', args: { text: 'once' } }] }
    }
    return { text: `done (${toolResults(req).join(' | ')})` }
  })
  queue = uniqueQueue('zombie')
  gateway = await inProcessGateway(
    gatewayConfig(temporal, queue, { session: sessionOptions({ heartbeatTimeoutMs: 3000 }) }),
  )
})

after(async () => {
  for (const c of children) {
    c.kill('SIGCONT')
    c.kill('SIGKILL')
  }
  await gateway?.close()
  await temporal?.teardown()
  await llm?.close()
  await pool?.end()
  rmSync(dir, { recursive: true, force: true })
})

const workerEnv = (name: string): Record<string, string> => ({
  DATABASE_URL,
  PG_POOL_MAX: '3',
  TEMPORAL_ADDRESS: temporal.address,
  TEMPORAL_TASK_QUEUE: queue,
  WORKER_IDENTITY: name,
  WORKER_HEALTH_PORT: '0',
  WORKER_HEARTBEAT_THROTTLE_MS: '200',
  WORKER_SHUTDOWN_GRACE_MS: '1000',
  LEASE_TTL_MS: '1500',
  AGENT_PROVIDER_TYPE: 'openai-compatible',
  AGENT_BASE_URL: llm.baseURL,
  AGENT_API_KEY: 'not-a-real-key',
  AGENT_MODEL: 'scripted',
  AGENT_LOG_LEVEL: 'none',
  LOG_LEVEL: 'warn',
  SWARM_TEST_NOTES: notes,
})

const lines = (): string[] => readFileSync(notes, 'utf8').split('\n').filter(Boolean)
const ended = (seen: ISseEvent[]) => seen.some((e) => e.data.event.type === 'turn.ended')

test('a worker paused before its first snapshot: superseded, its tool call never runs, the turn ends once', async () => {
  const a = childWorker(workerEnv('worker-a'), NOTES_WORKER)
  children.push(a)
  const client = api(`http://127.0.0.1:${gateway.port}`)
  const created = await client.post('/sessions', { message: 'write it down once' })
  assert.equal(created.status, 201)
  const sessionId = created.body.sessionId as string
  const first = runIdOf(sessionId, 1, 1)
  const second = runIdOf(sessionId, 1, 2)

  // Worker A is in the planner call of the turn's first run: bound, no snapshot yet. Pause it.
  await until('the first planner call', () => calls.planner === 1 || undefined, 60_000)
  await until('the first run to be bound', async () => {
    const r = await pool.query('SELECT 1 FROM swarm_runs WHERE run_id = $1', [first])
    return (r.rowCount ?? 0) > 0 || undefined
  })
  assert.equal(a.kill('SIGSTOP'), true)
  const b = childWorker(workerEnv('worker-b'), NOTES_WORKER)
  children.push(b)

  // Worker B gets the retry: the first run has no plan on record, so the turn starts its second
  // run - and that run writes the note and answers.
  const stream = await readSse(
    `http://127.0.0.1:${gateway.port}/sessions/${sessionId}/events`,
    client.headers,
    ended,
    120_000,
  )
  const end = stream.events.at(-1)!.data.event
  assert.equal(end.type, 'turn.ended')
  assert.equal(end.status, 'completed')
  assert.equal(end.text, 'the note is written')
  assert.equal(end.runId, second, "the second run's answer")
  assert.deepEqual(lines(), ['once'])
  const executorCalls = calls.executor ?? 0

  // The paused worker wakes, still holding (as far as it knows) the first run. Its planner answer
  // is waiting in its socket; appending it is refused, and the run stops right there.
  assert.equal(a.kill('SIGCONT'), true)
  const refused = await until(
    'the zombie to be refused, or to write',
    async () => {
      if (lines().length > 1) {
        return 'wrote'
      }
      const r = await pool.query<{ event: { error?: unknown } }>(
        "SELECT event FROM swarm_events WHERE run_id = $1 AND type = 'error'",
        [first],
      )
      return r.rows.find((row) => /may not append to the journal/.test(JSON.stringify(row.event)))
        ? 'refused'
        : undefined
    },
    30_000,
  )
  // Give a zombie that got through every chance to show it.
  await new Promise((r) => setTimeout(r, 2000))
  assert.deepEqual(lines(), ['once'], 'the write ran once')
  assert.equal(calls.executor ?? 0, executorCalls, 'the zombie never got to its step')
  assert.equal(refused, 'refused', 'the zombie run hit the fence')
  const after = await pool.query<{ snapshot: unknown; fence: number }>(
    'SELECT snapshot, fence FROM swarm_runs WHERE run_id = $1',
    [first],
  )
  assert.equal(after.rows[0]?.fence, SUPERSEDED_FENCE, 'the first run was superseded')
  assert.equal(after.rows[0]?.snapshot, null, "the zombie's snapshot writes were refused")
  const journal = await pool.query('SELECT 1 FROM swarm_journal WHERE run_id = $1', [first])
  assert.equal(journal.rowCount, 0, "nothing of the zombie's is in the journal")

  // The turn ended once - on the stream read again from the start, and in the session's history.
  const again = await readSse(
    `http://127.0.0.1:${gateway.port}/sessions/${sessionId}/events`,
    client.headers,
    ended,
    30_000,
  )
  assert.equal(again.events.filter((e) => e.data.event.type === 'turn.ended').length, 1)
  const finals = again.events.filter((e) => e.data.event.type === 'final')
  assert.deepEqual(
    finals.map((e) => e.data.event.runId),
    [second],
  )
  const history = await temporal.client.workflow.getHandle(workflowIdOf(sessionId)).fetchHistory()
  const events = history.events ?? []
  const turnActivity = events.filter(
    (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'runTurn',
  )
  assert.equal(turnActivity.length, 1, 'one turn activity')
  const of = (id: unknown): boolean => String(id) === String(turnActivity[0]!.eventId)
  const started = events.filter((e) => of(e.activityTaskStartedEventAttributes?.scheduledEventId))
  const completed = events.filter((e) =>
    of(e.activityTaskCompletedEventAttributes?.scheduledEventId),
  )
  assert.equal(completed.length, 1, 'completed once')
  assert.ok(
    (started[0]?.activityTaskStartedEventAttributes?.attempt ?? 0) >= 2,
    'by a retry, after the pause',
  )
  const runs = await pool.query<{ run_no: number; status: string | null }>(
    'SELECT run_no, status FROM swarm_runs WHERE session_id = $1 ORDER BY run_no',
    [sessionId],
  )
  assert.deepEqual(
    runs.rows.map((r) => [r.run_no, r.status]),
    [
      [1, null],
      [2, 'complete'],
    ],
  )
})
