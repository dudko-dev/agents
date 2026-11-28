// The limiter inside a turn: the shared bucket refuses a model call (ModelCallRefusedError in the
// core), the turn fails for good - a refusal is not retried - and the session goes on.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
  workerConfig,
  type ILocalOpenAI,
} from './harness.ts'

let temporal: TestWorkflowEnvironment
let pool: pg.Pool
let llm: ILocalOpenAI
let worker: IRunningWorker
let gateway: IRunningGateway

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  llm = await startLocalOpenAI((req) =>
    stageOf(req) === 'planner' ? { text: planJson(['a']) } : { text: 'never asked' },
  )
  const queue = uniqueQueue('limits')
  worker = await inProcessWorker(
    workerConfig(
      temporal,
      queue,
      // A model of its own: its bucket is this test's alone.
      agentConfig(llm.baseURL, { model: `scripted-${randomUUID()}` }),
      // One token, (practically) never refilled, no waiting: the second call is refused.
      { limiter: { capacity: 1, refillPerSecond: 0.001, maxWaitMs: 0, scope: 'model' } },
    ),
  )
  gateway = await inProcessGateway(gatewayConfig(temporal, queue))
})

after(async () => {
  await gateway?.close()
  worker?.shutdown()
  await worker?.done
  await temporal?.teardown()
  await llm?.close()
  await pool?.end()
})

test('a refused model call fails the turn once, without a retry', async () => {
  const client = api(`http://127.0.0.1:${gateway.port}`)
  const { body } = await client.post('/sessions', { message: 'over the limit' })
  const sessionId = body.sessionId as string
  const stream = await readSse(
    `http://127.0.0.1:${gateway.port}/sessions/${sessionId}/events`,
    client.headers,
    (seen) => seen.some((e) => e.data.event.type === 'turn.ended'),
  )
  const ended = stream.events.at(-1)!.data.event
  assert.equal(ended.status, 'failed')
  assert.match(String(ended.error), /rate limit/)
  // The planner took the only token; the executor's call never reached the model.
  assert.deepEqual(
    llm.requests.map((r) => stageOf(r)),
    ['planner'],
  )
  // One attempt: the refusal is not retried.
  const starts = stream.events.filter((e) => e.data.event.type === 'plan.created')
  assert.equal(starts.length, 1)
  const state = await client.get(`/sessions/${sessionId}`)
  assert.equal((state.body.turns as { status: string }[])[0]?.status, 'failed')
  assert.equal(state.body.status, 'idle')
})
