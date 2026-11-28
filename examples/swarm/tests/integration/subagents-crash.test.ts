// A worker killed (SIGKILL) while a parked turn's children run: the children's heartbeats time
// out, Temporal retries their activities on the other worker, which resumes each child's run
// from its snapshot (and its call journal); the session workflow is replayed there too, starts no
// second child, and the turn goes on with both answers. Nothing is duplicated.
import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { after, before, test } from 'node:test'
import type { TestWorkflowEnvironment } from '@temporalio/testing'
import type pg from 'pg'
import { workflowIdOf } from 'swarm-shared'
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
  roundOf,
  sessionOptions,
  stageOf,
  startLocalOpenAI,
  startTemporal,
  toolNames,
  toolResults,
  uniqueQueue,
  until,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
} from './harness.ts'

let temporal: TestWorkflowEnvironment
let pool: pg.Pool
let llm: ILocalOpenAI
let gateway: IRunningGateway
const children: ChildProcess[] = []
const calls: Record<string, number> = {}
let queue: string

const taskOf = (req: IChatRequest): string | undefined =>
  /look into ([a-z]+)/.exec(userOf(req))?.[1]
const isChild = (req: IChatRequest): boolean =>
  taskOf(req) !== undefined && !/research these/.test(userOf(req))
const count = (key: string): number => (calls[key] = (calls[key] ?? 0) + 1)

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  llm = await startLocalOpenAI((req) => {
    const stage = stageOf(req)
    if (stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    if (isChild(req)) {
      const task = taskOf(req)!
      count(`child-${task}-${stage}`)
      if (stage === 'planner') return { text: planJson(['c']) }
      if (stage === 'synthesizer') return { text: `child says ${task}` }
      // The first worker hangs in each child's step until it is killed; the second answers.
      return calls[`child-${task}-executor`] === 1
        ? { text: 'never seen', delayMs: 20_000 }
        : { text: `looked into ${task}` }
    }
    count(`parent-${stage}`)
    if (stage === 'planner') return { text: planJson(['a']) }
    if (stage === 'synthesizer') return { text: `final: ${userOf(req).slice(0, 2000)}` }
    if (roundOf(req) === 0 && toolNames(req).includes('researcher')) {
      count('parent-dispatch-round')
      return {
        toolCalls: ['alpha', 'beta'].map((t) => ({
          name: 'researcher',
          args: { task: `look into ${t}` },
        })),
      }
    }
    return { text: `results: ${toolResults(req).join(' | ')}` }
  })
  queue = uniqueQueue('subcrash')
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
  SUBAGENTS: JSON.stringify({
    researcher: { description: 'Look into one thing and report', readOnly: true },
  }),
})

test('a worker killed while the children run: they finish elsewhere, the turn resumes, nothing twice', async () => {
  const a = childWorker(workerEnv('worker-a'))
  children.push(a)
  const client = api(`http://127.0.0.1:${gateway.port}`)
  const created = await client.post('/sessions', { message: 'research these: alpha, beta' })
  assert.equal(created.status, 201)
  const sessionId = created.body.sessionId as string

  // Both children are in their step on worker A, with their plans checkpointed.
  await until(
    'both children to be in their step',
    () => (calls['child-alpha-executor'] === 1 && calls['child-beta-executor'] === 1) || undefined,
    60_000,
  )
  await until('both child plans to be on record', async () => {
    const r = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM swarm_runs WHERE session_id LIKE $1 || '/%' AND snapshot->'plan' IS NOT NULL",
      [sessionId],
    )
    return r.rows[0]?.n === 2 || undefined
  })
  const b = childWorker(workerEnv('worker-b'))
  children.push(b)
  a.kill('SIGKILL')
  assert.equal(await exited(a), null)

  const stream = await readSse(
    `http://127.0.0.1:${gateway.port}/sessions/${sessionId}/events`,
    client.headers,
    (seen) => seen.some((e) => e.data.event.type === 'turn.ended'),
    120_000,
  )
  const end = stream.events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /child says alpha/)
  assert.match(String(end.text), /child says beta/)
  assert.equal(end.attempt, 2, 'parked once, resumed once')

  // The session started exactly two children (its history), each ran one run, under attempt 2.
  const history = await temporal.client.workflow.getHandle(workflowIdOf(sessionId)).fetchHistory()
  const started = (history.events ?? []).filter(
    (e) => e.childWorkflowExecutionStartedEventAttributes,
  )
  assert.equal(started.length, 2, 'no second child for an item')
  const runs = await pool.query<{
    session_id: string
    run_no: number
    attempt: number
    status: string
  }>(
    "SELECT session_id, run_no, attempt, status FROM swarm_runs WHERE session_id LIKE $1 || '/%' ORDER BY session_id",
    [sessionId],
  )
  assert.equal(runs.rows.length, 2)
  for (const r of runs.rows) {
    assert.deepEqual([r.run_no, r.attempt, r.status], [1, 2, 'complete'])
  }
  // The parent dispatched once; each child planned once (its plan was on record) and its step
  // ran twice - the killed try and the retry.
  assert.equal(calls['parent-dispatch-round'], 1)
  assert.equal(calls['parent-planner'], 1)
  for (const t of ['alpha', 'beta']) {
    assert.equal(calls[`child-${t}-planner`], 1, `${t} planned once`)
    assert.equal(calls[`child-${t}-executor`], 2, `${t}: the interrupted step and its retry`)
    assert.equal(calls[`child-${t}-synthesizer`], 1, `${t} answered once`)
  }
  // Each item answered once: the subagent.ended markers, one per child.
  const endedMarkers = stream.events.filter((e) => e.data.event.type === 'subagent.ended')
  assert.equal(endedMarkers.length, 2)

  b.kill('SIGTERM')
  assert.equal(await exited(b), 0)
})
