// A worker killed (SIGKILL) in the middle of a pipeline node: the node's heartbeat times out,
// Temporal retries its activity on the other worker, which resumes the node's run from its
// snapshot and its call journal - the write the node made before the crash is not made again.
// The pipeline workflow (and the session's) is replayed there: the graph engine gets the
// finished node's answer from the history and starts nothing twice.
import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import type { TestWorkflowEnvironment } from '@temporalio/testing'
import type pg from 'pg'
import type { IRunningGateway } from '../../src/gateway-main.ts'
import { pipelineNodeStreamOf } from '../../src/session-api.ts'
import type { IPipelineConfig } from '../../src/pipelines.ts'
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
  systemOf,
  toolNames,
  toolResults,
  uniqueQueue,
  until,
  userOf,
  type IChatRequest,
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

// draft -> write (writes a note, then hangs on the first worker) -> final.
const chain: IPipelineConfig = {
  description: 'Draft, write it down, finish',
  readOnly: true,
  definition: {
    version: 1,
    entry: 'draft',
    nodes: [
      { id: 'draft', instructions: 'NODE=draft' },
      { id: 'write', instructions: 'NODE=write', tools: ['write_note'] },
      { id: 'final', instructions: 'NODE=final' },
    ],
    edges: [
      { from: 'draft', to: 'write' },
      { from: 'write', to: 'final' },
    ],
  },
}

const nodeOf = (req: IChatRequest): string | undefined => /NODE=([a-z]+)/.exec(systemOf(req))?.[1]

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  dir = mkdtempSync(join(tmpdir(), 'swarm-notes-'))
  notes = join(dir, 'notes.txt')
  writeFileSync(notes, '')
  llm = await startLocalOpenAI((req) => {
    const stage = stageOf(req)
    if (stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    const node = nodeOf(req)
    if (node) {
      if (stage === 'executor') {
        const n = count(`${node}-executor-r${roundOf(req)}`)
        if (node === 'write' && roundOf(req) === 0 && toolNames(req).includes('write_note')) {
          return { toolCalls: [{ name: 'write_note', args: { text: 'once' } }] }
        }
        // The first worker hangs in write's second round until it is killed; the second answers.
        if (node === 'write' && n === 1) {
          return { text: 'never seen', delayMs: 20_000 }
        }
        return { text: `${node} did it (${toolResults(req).join(' | ')})` }
      }
      count(`${node}-${stage}`)
      if (stage === 'planner') return { text: planJson(['n']) }
      return { text: `${node} says ok` }
    }
    count(`parent-${stage}`)
    if (stage === 'planner') return { text: planJson(['a']) }
    if (stage === 'synthesizer') return { text: `final: ${userOf(req).slice(0, 2000)}` }
    if (roundOf(req) === 0 && toolNames(req).includes('chain')) {
      return { toolCalls: [{ name: 'chain', args: { task: 'write it down' } }] }
    }
    return { text: `results: ${toolResults(req).join(' | ')}` }
  })
  queue = uniqueQueue('pipecrash')
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
  PIPELINES: JSON.stringify({ chain }),
  SWARM_TEST_NOTES: notes,
})

const ended = (seen: ISseEvent[]) => seen.some((e) => e.data.event.type === 'turn.ended')

test('a worker killed mid-node: another finishes it, finished nodes do not run again, the write runs once', async () => {
  const a = childWorker(workerEnv('worker-a'), NOTES_WORKER)
  children.push(a)
  const client = api(`http://127.0.0.1:${gateway.port}`)
  const created = await client.post('/sessions', { message: 'run the chain' })
  assert.equal(created.status, 201)
  const sessionId = created.body.sessionId as string

  // On worker A: draft is done, write has written its note and hangs in its second round, with
  // its plan on record.
  await until(
    'write to hang after its write',
    () => (calls['write-executor-r1'] === 1 && calls['draft-synthesizer'] === 1) || undefined,
    90_000,
  )
  assert.equal(readFileSync(notes, 'utf8'), 'once\n')
  const parked = await client.get(`/sessions/${sessionId}`)
  const itemId = (parked.body.parked as { requests: { requestId: string }[] }).requests[0]!
    .requestId
  const stream = pipelineNodeStreamOf(sessionId, itemId, 'write', 1)
  await until('write plan to be on record', async () => {
    const r = await pool.query(
      "SELECT 1 FROM swarm_runs WHERE session_id = $1 AND snapshot->'plan' IS NOT NULL",
      [stream],
    )
    return (r.rowCount ?? 0) > 0 || undefined
  })
  const b = childWorker(workerEnv('worker-b'), NOTES_WORKER)
  children.push(b)
  a.kill('SIGKILL')
  assert.equal(await exited(a), null)

  const done = await readSse(
    `http://127.0.0.1:${gateway.port}/sessions/${sessionId}/events`,
    client.headers,
    ended,
    120_000,
  )
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /final says ok/)

  // The write ran once: the retry answered it from the node's journal.
  assert.equal(readFileSync(notes, 'utf8'), 'once\n')
  // The finished node did not run again; write planned once, its first round was replayed (not
  // asked again), its second round ran twice (the killed try and the retry); final ran once.
  for (const key of ['draft-planner', 'draft-executor-r0', 'draft-synthesizer']) {
    assert.equal(calls[key], 1, key)
  }
  assert.equal(calls['write-planner'], 1)
  assert.equal(calls['write-executor-r0'], 1, 'the recorded round is replayed')
  assert.equal(calls['write-executor-r1'], 2)
  assert.equal(calls['write-synthesizer'], 1)
  for (const key of ['final-planner', 'final-executor-r0', 'final-synthesizer']) {
    assert.equal(calls[key], 1, key)
  }
  assert.equal(calls['parent-planner'], 1)

  // The pipeline started one child per visit (its history), and write's run went on as attempt 2.
  const listed = await client.get(`/sessions/${sessionId}/pipelines`)
  const call = (listed.body.pipelines as { workflowId: string }[])[0]!
  const history = await temporal.client.workflow.getHandle(call.workflowId).fetchHistory()
  const startedChildren = (history.events ?? []).filter(
    (e) => e.childWorkflowExecutionStartedEventAttributes,
  )
  assert.equal(startedChildren.length, 3, 'draft, write, final: no second child for a visit')
  const runs = await pool.query<{
    session_id: string
    run_no: number
    attempt: number
    status: string
  }>(
    "SELECT session_id, run_no, attempt, status FROM swarm_runs WHERE session_id LIKE $1 || '/%/%/%' ORDER BY session_id",
    [sessionId],
  )
  assert.deepEqual(
    runs.rows.map((r) => [
      r.session_id.split('/').slice(2).join('/'),
      r.run_no,
      r.attempt,
      r.status,
    ]),
    [
      ['draft/1', 1, 1, 'complete'],
      ['final/1', 1, 1, 'complete'],
      ['write/1', 1, 2, 'complete'],
    ],
  )
  // The node's stream: both attempts, attempt 1 first, then its turn.ended.
  const visit = await readSse(
    `http://127.0.0.1:${gateway.port}/sessions/${sessionId}/pipelines/${itemId}/nodes/write/1/events`,
    client.headers,
    ended,
  )
  const attempts = visit.events
    .filter((e) => e.data.event.type !== 'turn.started' && e.data.event.type !== 'turn.ended')
    .map((e) => e.data.event.attempt as number)
  assert.ok(attempts.includes(1) && attempts.includes(2))
  assert.equal(attempts.indexOf(2), attempts.lastIndexOf(1) + 1, 'attempt 1, then attempt 2')
  assert.equal(visit.events.at(-1)!.data.event.status, 'completed')

  b.kill('SIGTERM')
  assert.equal(await exited(b), 0)
})
