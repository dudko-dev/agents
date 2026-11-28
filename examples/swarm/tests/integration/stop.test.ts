// Stop: the running turn is cancelled (the activity aborts the run, which records 'cancelled'),
// the session goes on with the next message; `end` ends the session.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { TestWorkflowEnvironment } from '@temporalio/testing'
import type pg from 'pg'
import type { IRunningGateway } from '../../src/gateway-main.ts'
import type { IRunningWorker } from '../../src/worker.ts'
import {
  agentConfig,
  api,
  gatewayConfig,
  inProcessGateway,
  inProcessWorker,
  migrated,
  planJson,
  readSse,
  stageOf,
  startLocalOpenAI,
  startTemporal,
  uniqueQueue,
  until,
  workerConfig,
  type ILocalOpenAI,
  type ISseEvent,
} from './harness.ts'

let temporal: TestWorkflowEnvironment
let pool: pg.Pool
let llm: ILocalOpenAI
let worker: IRunningWorker
let gateway: IRunningGateway
let base: string
let executorCalls = 0

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  llm = await startLocalOpenAI((req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson(['a']) }
    if (stage === 'synthesizer') return { text: 'the answer' }
    executorCalls += 1
    // The first step hangs (long enough to be stopped); later ones answer at once.
    return executorCalls === 1 ? { text: 'too late', delayMs: 8000 } : { text: 'did it' }
  })
  const queue = uniqueQueue('stop')
  worker = await inProcessWorker(workerConfig(temporal, queue, agentConfig(llm.baseURL)))
  gateway = await inProcessGateway(gatewayConfig(temporal, queue))
  base = `http://127.0.0.1:${gateway.port}`
})

after(async () => {
  await gateway?.close()
  worker?.shutdown()
  await worker?.done
  await temporal?.teardown()
  await llm?.close()
  await pool?.end()
})

const ended = (turn: number) => (seen: ISseEvent[]) =>
  seen.some((e) => e.data.event.type === 'turn.ended' && e.data.turn === turn)

test('stop cancels the running turn; the session takes the next message; end ends it', async () => {
  const client = api(base)
  const { body } = await client.post('/sessions', { message: 'something slow' })
  const sessionId = body.sessionId as string

  await until('the step to start', async () => {
    const r = await pool.query(
      "SELECT 1 FROM swarm_events WHERE session_id = $1 AND type = 'step.start'",
      [sessionId],
    )
    return r.rowCount ? true : undefined
  })
  const asked = Date.now()
  const stop = await client.post(`/sessions/${sessionId}/stop`)
  assert.equal(stop.status, 202)

  const first = await readSse(`${base}/sessions/${sessionId}/events`, client.headers, ended(1))
  const marker = first.events.at(-1)!.data.event
  assert.equal(marker.status, 'stopped')
  assert.ok(Date.now() - asked < 6000, 'stopped before the hung model call answered')
  const runId = marker.runId as string
  const snap = await pool.query<{ status: string }>(
    'SELECT status FROM swarm_runs WHERE run_id = $1',
    [runId],
  )
  assert.equal(snap.rows[0]?.status, 'cancelled')

  const state = await client.get(`/sessions/${sessionId}`)
  assert.equal(state.body.status, 'idle')
  assert.equal((state.body.turns as { status: string }[])[0]?.status, 'stopped')
  assert.deepEqual(state.body.history, [], 'a stopped turn adds nothing to the conversation')

  // The session goes on.
  await client.post(`/sessions/${sessionId}/messages`, { text: 'now quickly' })
  const second = await readSse(`${base}/sessions/${sessionId}/events`, client.headers, ended(2))
  assert.equal(second.events.at(-1)!.data.event.status, 'completed')

  // end: the session is over; a message is refused.
  assert.equal((await client.post(`/sessions/${sessionId}/stop`, { end: true })).status, 202)
  await until('the session to end', async () => {
    const s = await client.get(`/sessions/${sessionId}`)
    return s.body.status === 'ended' ? true : undefined
  })
  const late = await client.post(`/sessions/${sessionId}/messages`, { text: 'hello?' })
  assert.equal(late.status, 409)
  assert.equal((late.body.error as { code: string }).code, 'session_ended')
})
