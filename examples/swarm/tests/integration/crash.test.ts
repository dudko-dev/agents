// A worker killed (SIGKILL) in the middle of a turn: its heartbeat times out, Temporal retries
// the turn on the other worker, which resumes the run from its last snapshot - the step already
// done is not done again - under attempt 2. The stream shows both attempts, attempt 1 first.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { ChildProcess } from 'node:child_process'
import type { TestWorkflowEnvironment } from '@temporalio/testing'
import type pg from 'pg'
import type { IRunningGateway } from '../../src/gateway-main.ts'
import {
  api,
  childWorker,
  DATABASE_URL,
  exited,
  gatewayConfig,
  inProcessGateway,
  migrated,
  planJson,
  readSse,
  sessionOptions,
  stageOf,
  startLocalOpenAI,
  startTemporal,
  stepOf,
  uniqueQueue,
  until,
  type ILocalOpenAI,
} from './harness.ts'

let temporal: TestWorkflowEnvironment
let pool: pg.Pool
let llm: ILocalOpenAI
let gateway: IRunningGateway
const children: ChildProcess[] = []
const calls: Record<string, number> = {}
let queue: string

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  llm = await startLocalOpenAI((req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson(['a', 'b']) }
    if (stage === 'synthesizer') return { text: 'finished after the crash' }
    if (stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    const step = stepOf(req)
    calls[step] = (calls[step] ?? 0) + 1
    // The first worker hangs in step b until it is killed; the second answers at once.
    return step === 'b' && calls[step] === 1
      ? { text: 'never seen', delayMs: 15_000 }
      : { text: `did ${step}` }
  })
  queue = uniqueQueue('crash')
  gateway = await inProcessGateway(
    gatewayConfig(temporal, queue, { session: sessionOptions({ heartbeatTimeoutMs: 3000 }) }),
  )
})

after(async () => {
  for (const c of children) c.kill('SIGKILL')
  await gateway?.close()
  await temporal?.teardown()
  await llm?.close()
  await pool?.end()
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
})

test('a worker killed mid-turn: another worker finishes the turn under attempt 2', async () => {
  const a = childWorker(workerEnv('worker-a'))
  children.push(a)
  const client = api(`http://127.0.0.1:${gateway.port}`)
  const created = await client.post('/sessions', { message: 'survive a crash' })
  assert.equal(created.status, 201)
  const sessionId = created.body.sessionId as string

  // Worker A is in step b, and step a is checkpointed.
  const runId = await until(
    'step a to be checkpointed',
    async () => {
      const r = await pool.query<{ run_id: string }>(
        "SELECT run_id FROM swarm_runs WHERE session_id = $1 AND (snapshot->>'stepIndex')::int = 1",
        [sessionId],
      )
      return r.rows[0]?.run_id
    },
    60_000,
  )
  await until('step b to start', () => calls.b === 1 || undefined, 30_000)

  const b = childWorker(workerEnv('worker-b'))
  children.push(b)
  a.kill('SIGKILL')
  assert.equal(await exited(a), null)

  const stream = await readSse(
    `http://127.0.0.1:${gateway.port}/sessions/${sessionId}/events`,
    client.headers,
    (seen) => seen.some((e) => e.data.event.type === 'turn.ended'),
    90_000,
  )
  const ended = stream.events.at(-1)!.data.event
  assert.equal(ended.type, 'turn.ended')
  assert.equal(ended.status, 'completed')
  assert.equal(ended.text, 'finished after the crash')
  assert.equal(ended.runId, runId, 'the same run went on')
  assert.equal(ended.attempt, 2)

  // Both attempts are on the stream, attempt 1 first; the answer came from attempt 2.
  const ofRun = stream.events.filter((e) => e.data.event.runId === runId)
  const attempts = ofRun.map((e) => e.data.event.attempt as number)
  const firstTwo = attempts.indexOf(2)
  assert.ok(firstTwo > 0, 'attempt 2 events after attempt 1 events')
  assert.ok(attempts.slice(0, firstTwo).every((n) => n === 1))
  assert.ok(attempts.slice(firstTwo).every((n) => n === 2))
  const finals = ofRun.filter((e) => e.data.event.type === 'final')
  assert.equal(finals.length, 1)
  assert.equal(finals[0]!.data.event.attempt, 2)
  // seq restarts at 1 for attempt 2; the turn's attempt is the run's (no fresh restart).
  assert.equal(ofRun[firstTwo]!.data.event.seq, 1)
  assert.match(ofRun[firstTwo]!.id, /^1:2:1$/)

  // Step a ran once (resumed after its checkpoint), step b twice (the killed try and the retry).
  assert.equal(calls.a, 1)
  assert.equal(calls.b, 2)
  const snap = await pool.query<{ attempt: number; status: string }>(
    'SELECT attempt, status FROM swarm_runs WHERE run_id = $1',
    [runId],
  )
  assert.deepEqual(snap.rows[0], { attempt: 2, status: 'complete' })

  // SIGTERM: the second worker drains and exits cleanly.
  b.kill('SIGTERM')
  assert.equal(await exited(b), 0)
})
