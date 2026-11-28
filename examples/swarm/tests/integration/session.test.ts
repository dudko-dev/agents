// A session end to end: the gateway starts the workflow, the workflow runs a turn as an activity,
// the activity runs the agent against a scripted model, the events reach Postgres and come back
// over SSE in (turn, attempt, seq) order - and again, from the cursor, after a reconnect.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import type { TestWorkflowEnvironment } from '@temporalio/testing'
import type pg from 'pg'
import { insertSessionSql } from '../../src/backend.ts'
import { compareCursors, parseCursor, type ICursor } from '../../src/cursor.ts'
import type { IRunningGateway } from '../../src/gateway-main.ts'
import { SESSION_WORKFLOW, workflowIdOf } from '../../src/session-api.ts'
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
  sessionOptions,
  stageOf,
  startLocalOpenAI,
  startTemporal,
  stepOf,
  uniqueQueue,
  until,
  userOf,
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
let queue: string

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  llm = await startLocalOpenAI((req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson(['a', 'b']) }
    if (stage === 'synthesizer') {
      return { text: `answer to: ${userOf(req).includes('again') ? 'again' : 'hello'}` }
    }
    if (stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    return { text: `did ${stepOf(req)}` }
  })
  queue = uniqueQueue('session')
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

const cursorOf = (e: ISseEvent): ICursor => {
  const parsed = parseCursor(e.id)
  assert.ok(parsed.ok)
  return parsed.cursor
}

const assertOrdered = (events: ISseEvent[]): void => {
  for (let i = 1; i < events.length; i++) {
    assert.ok(
      compareCursors(cursorOf(events[i - 1]!), cursorOf(events[i]!)) < 0,
      `events out of order at ${i}: ${events[i - 1]!.id} then ${events[i]!.id}`,
    )
  }
}

const endedTurn = (turn: number) => (seen: ISseEvent[]) =>
  seen.some((e) => e.data.event.type === 'turn.ended' && e.data.turn === turn)

test('a turn runs end to end and its events stream in order, then replay from a cursor', async () => {
  const client = api(base)
  const created = await client.post('/sessions', { message: 'hello' })
  assert.equal(created.status, 201)
  const sessionId = created.body.sessionId as string
  assert.match(sessionId, /^[0-9a-f-]{36}$/)

  const first = await readSse(`${base}/sessions/${sessionId}/events`, client.headers, endedTurn(1))
  assert.equal(first.status, 200)
  assertOrdered(first.events)
  const types = first.events.map((e) => e.data.event.type)
  assert.equal(types[0], 'turn.started')
  assert.equal(types.at(-1), 'turn.ended')
  for (const t of ['plan.created', 'step.start', 'step.complete', 'final']) {
    assert.ok(types.includes(t), `missing ${t} in ${types.join(', ')}`)
  }
  const ended = first.events.at(-1)!.data.event
  assert.equal(ended.status, 'completed')
  assert.equal(ended.text, 'answer to: hello')
  // Every event of the run carries the core's numbers: attempt 1, seq from 1, one run id.
  const runEvents = first.events.filter(
    (e) => typeof e.data.event.seq === 'number' && e.data.event.seq,
  )
  assert.ok(runEvents.length > 3)
  assert.deepEqual([...new Set(runEvents.map((e) => e.data.event.attempt))], [1], 'one attempt')
  assert.deepEqual(
    runEvents.map((e) => e.data.event.seq),
    runEvents.map((_, i) => i + 1),
  )
  assert.equal(new Set(runEvents.map((e) => e.data.event.runId)).size, 1)

  // The state query: idle, one completed turn, the exchange in the history.
  const state = await until('the session to be idle', async () => {
    const s = await client.get(`/sessions/${sessionId}`)
    return s.body.status === 'idle' ? s : undefined
  })
  assert.equal(state.status, 200)
  assert.equal((state.body.turns as { status: string }[])[0]?.status, 'completed')
  assert.deepEqual(state.body.history, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'answer to: hello' },
  ])

  // A second turn gets the first as history.
  const sent = await client.post(`/sessions/${sessionId}/messages`, { text: 'again' })
  assert.equal(sent.status, 202)
  const second = await readSse(`${base}/sessions/${sessionId}/events`, client.headers, endedTurn(2))
  assertOrdered(second.events)
  assert.equal(second.events.at(-1)!.data.event.text, 'answer to: again')
  const planned = llm.requests.filter((r) => stageOf(r) === 'planner').at(-1)!
  assert.match(JSON.stringify(planned.messages), /hello/, 'the history reached the planner')

  // Reconnect from the middle: with the cursor in `after`, and with Last-Event-ID (which wins).
  const all = second.events
  const middle = all[Math.floor(all.length / 2)]!
  const rest = all.filter((e) => compareCursors(cursorOf(e), cursorOf(middle)) > 0)
  const byQuery = await readSse(
    `${base}/sessions/${sessionId}/events?after=${middle.id}`,
    client.headers,
    endedTurn(2),
  )
  assert.deepEqual(
    byQuery.events.map((e) => e.id),
    rest.map((e) => e.id),
  )
  const byHeader = await readSse(
    `${base}/sessions/${sessionId}/events?after=0:0:0`,
    { ...client.headers, 'last-event-id': middle.id },
    endedTurn(2),
  )
  assert.deepEqual(
    byHeader.events.map((e) => e.id),
    rest.map((e) => e.id),
  )
})

test('the gateway refuses what it should', async () => {
  const client = api(base)
  const noAuth = await fetch(`${base}/sessions`, { method: 'POST' })
  assert.equal(noAuth.status, 401)
  const unknown = await client.get('/sessions/no-such-session')
  assert.equal(unknown.status, 404)
  const stream = await readSse(
    `${base}/sessions/no-such-session/events`,
    client.headers,
    () => true,
  )
  assert.equal(stream.status, 404)
  const badCursor = await fetch(`${base}/sessions/x/events?after=1:2`, { headers: client.headers })
  assert.equal(badCursor.status, 400)
  const ready = await fetch(`${base}/readyz`)
  assert.equal(ready.status, 200)
})

test('continue-as-new carries the session; an idle session ends', async () => {
  const client = api(base)
  // Started here rather than by the gateway: options of its own (one turn per run, a short idle).
  const sessionId = randomUUID()
  await pool.query(insertSessionSql, [sessionId, workflowIdOf(sessionId)])
  const handle = await temporal.client.workflow.start(SESSION_WORKFLOW, {
    taskQueue: queue,
    workflowId: workflowIdOf(sessionId),
    args: [{ sessionId, options: sessionOptions({ maxTurnsPerRun: 1, idleTimeoutMs: 4000 }) }],
  })
  const firstRun = handle.firstExecutionRunId
  for (const [turn, text] of [
    [1, 'hello'],
    [2, 'again'],
  ] as const) {
    assert.equal((await client.post(`/sessions/${sessionId}/messages`, { text })).status, 202)
    await readSse(`${base}/sessions/${sessionId}/events`, client.headers, endedTurn(turn))
  }
  const state = await until('both turns in the state', async () => {
    const s = await client.get(`/sessions/${sessionId}`)
    return (s.body.turns as unknown[]).length === 2 && s.body.status === 'idle' ? s : undefined
  })
  assert.equal(state.body.turn, 2)
  assert.equal((state.body.history as unknown[]).length, 4, 'the history crossed the new run')
  const first = await temporal.client.workflow
    .getHandle(workflowIdOf(sessionId), firstRun)
    .describe()
  assert.equal(first.status.name, 'CONTINUED_AS_NEW')

  // No message for idleTimeoutMs: the session ends by itself.
  const ended = await until(
    'the idle session to end',
    async () => {
      const s = await client.get(`/sessions/${sessionId}`)
      return s.body.status === 'ended' ? s : undefined
    },
    20_000,
    250,
  )
  assert.equal((ended.body.turns as unknown[]).length, 2)
})
