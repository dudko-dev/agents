// Parking end to end: a turn stops on a person's question (ask-writes, a write tool), the item
// reaches the client in the stream and in the state, the answer comes through the gateway and the
// SAME turn goes on - the write runs exactly once. A partial answer keeps the turn parked; a run
// resumed with part of its answers parks again with the rest. Stop during a park ends it.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { MockActivityEnvironment } from '@temporalio/testing'
import type { TestWorkflowEnvironment } from '@temporalio/testing'
import { tool } from 'ai'
import type pg from 'pg'
import { z } from 'zod'
import { createAgent, type IAgent } from '@dudko.dev/agent'
import { createActivities } from '../../src/activities.ts'
import { insertSessionSql } from '../../src/backend.ts'
import { createEventStore } from '../../src/db/events.ts'
import { createPostgresJournal } from '../../src/db/journal.ts'
import { createParkedStore } from '../../src/db/parked.ts'
import { createPostgresPersistence, createRunStore } from '../../src/db/runs.ts'
import type { IRunningGateway } from '../../src/gateway-main.ts'
import { createHeartbeatLease } from '../../src/lease.ts'
import { silentLogger } from '../../src/log.ts'
import { workflowIdOf } from '../../src/session-api.ts'
import type { IParkedRequest, ITurnInput } from '../../src/session-types.ts'
import { sessionAgentConfig } from '../../src/subagents.ts'
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
  roundOf,
  stageOf,
  startLocalOpenAI,
  startTemporal,
  toolResults,
  uniqueQueue,
  until,
  userOf,
  workerConfig,
  type IChatRequest,
  type ILocalOpenAI,
  type ISseEvent,
} from './harness.ts'

let temporal: TestWorkflowEnvironment
let pool: pg.Pool
let llm: ILocalOpenAI
let worker: IRunningWorker
let gateway: IRunningGateway
let base: string
const written: string[] = []

// A write tool (not read-only): under ask-writes every call asks a person, so the turn parks.
const writeNote = tool({
  description: 'Write a note (a write).',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => {
    written.push(text)
    return `wrote ${text}`
  },
})

// The executor writes one note per name in the user's input ("notes: a, b"), all in one round,
// then answers with what the tools said.
const notesOf = (req: IChatRequest): string[] => {
  const m = /notes: ([a-z, ]+)/.exec(JSON.stringify(req.messages))
  return m ? m[1]!.split(',').map((s) => s.trim()) : []
}

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  llm = await startLocalOpenAI((req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson(['a']) }
    if (stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    if (stage === 'synthesizer')
      return { text: `final: ${userOf(req).includes('wrote') ? 'written' : 'not written'}` }
    if (roundOf(req) === 0) {
      return { toolCalls: notesOf(req).map((text) => ({ name: 'write_note', args: { text } })) }
    }
    return { text: `results: ${toolResults(req).join(' | ')}` }
  })
  const queue = uniqueQueue('parking')
  worker = await inProcessWorker(
    workerConfig(
      temporal,
      queue,
      agentConfig(llm.baseURL, {
        tools: { write_note: writeNote },
        toolApproval: { mode: 'ask-writes' },
      }),
    ),
  )
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
const parkedNow = (seen: ISseEvent[]) => seen.some((e) => e.data.event.type === 'run.parked')

const parkedState = async (client: ReturnType<typeof api>, sessionId: string) =>
  until('the turn to park', async () => {
    const s = await client.get(`/sessions/${sessionId}`)
    return s.body.status === 'parked'
      ? (s.body.parked as { requests: IParkedRequest[]; answered: string[]; runId: string })
      : undefined
  })

test('a turn parks on a person question; the answer comes through the gateway; the write runs once', async () => {
  written.length = 0
  const client = api(base)
  const created = await client.post('/sessions', { message: 'notes: alpha' })
  const sessionId = created.body.sessionId as string

  // The item reaches the client: in the stream (the core's run.parked, the approval events) ...
  const first = await readSse(`${base}/sessions/${sessionId}/events`, client.headers, parkedNow)
  const types = first.events.map((e) => e.data.event.type)
  assert.ok(types.includes('tool.approval-requested'), types.join(', '))
  const resolved = first.events.find((e) => e.data.event.type === 'tool.approval-resolved')
  assert.equal(resolved?.data.event.parked, true)
  const parkedEvent = first.events.find((e) => e.data.event.type === 'run.parked')!.data.event
  const items = parkedEvent.items as { id: string; kind: string }[]
  assert.equal(items.length, 1)
  // ... and in the session state.
  const parked = await parkedState(client, sessionId)
  assert.deepEqual(
    parked.requests.map((r) => [r.requestId, r.kind]),
    [[items[0]!.id, 'approval']],
  )
  assert.equal(
    (parked.requests[0]!.question as { request: { toolName: string } }).request.toolName,
    'write_note',
  )
  assert.deepEqual(written, [], 'nothing was written before the answer')
  const id = parked.requests[0]!.requestId

  // The gateway refuses what does not fit, before the session hears of it.
  assert.equal(
    (await client.post(`/sessions/${sessionId}/answers/${id}`, { output: 'x' })).status,
    400,
  )
  assert.equal(
    (await client.post(`/sessions/${sessionId}/answers/p_not_pending`, { approved: true })).status,
    404,
  )
  const ok = await client.post(`/sessions/${sessionId}/answers/${id}`, { approved: true })
  assert.equal(ok.status, 202)

  const done = await readSse(`${base}/sessions/${sessionId}/events`, client.headers, ended(1))
  const end = done.events.at(-1)!.data.event
  assert.equal(end.type, 'turn.ended')
  assert.equal(end.status, 'completed')
  assert.equal(end.attempt, 2, 'the same run went on as its next attempt')
  assert.equal(end.runId, parked.runId)
  assert.deepEqual(written, ['alpha'], 'the write ran exactly once')
  // The resumed attempt's events come after the parked one's.
  const attempts = done.events
    .filter((e) => e.data.event.runId === parked.runId)
    .map((e) => e.data.event.attempt as number)
  assert.ok(attempts.indexOf(2) > 0 && attempts.slice(attempts.indexOf(2)).every((a) => a === 2))
  const row = await pool.query<{ state: string }>(
    'SELECT state FROM swarm_parked WHERE session_id = $1 AND item_id = $2',
    [sessionId, id],
  )
  assert.equal(row.rows[0]?.state, 'answered')
  assert.equal(
    (await client.post(`/sessions/${sessionId}/answers/${id}`, { approved: true })).status,
    409,
    'answered once',
  )
  const journal = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM swarm_journal WHERE run_id = $1',
    [parked.runId],
  )
  assert.ok((journal.rows[0]?.n ?? 0) > 0, 'the call journal is in Postgres')
})

test('a partial answer keeps the turn parked; the rest finishes it, each write once', async () => {
  written.length = 0
  const client = api(base)
  const { body } = await client.post('/sessions', { message: 'notes: one, two' })
  const sessionId = body.sessionId as string
  const parked = await parkedState(client, sessionId)
  assert.equal(parked.requests.length, 2, 'two calls of one round: one park, two items')
  const [a, b] = parked.requests.map((r) => r.requestId) as [string, string]
  assert.equal(
    (await client.post(`/sessions/${sessionId}/answers/${a}`, { approved: true })).status,
    202,
  )
  const half = await until('the first answer to be taken', async () => {
    const s = await client.get(`/sessions/${sessionId}`)
    const p = s.body.parked as { answered: string[] } | undefined
    return p?.answered.includes(a) ? s.body : undefined
  })
  assert.equal(half.status, 'parked', 'still parked')
  assert.deepEqual(written, [])
  // Denied: that call fails as a denial, the other one runs.
  assert.equal(
    (await client.post(`/sessions/${sessionId}/answers/${b}`, { approved: false, reason: 'no' }))
      .status,
    202,
  )
  const done = await readSse(`${base}/sessions/${sessionId}/events`, client.headers, ended(1))
  assert.equal(done.events.at(-1)!.data.event.status, 'completed')
  assert.deepEqual(written.sort(), ['one'])
})

test('a run resumed with part of its answers parks again with the rest (the activity, the core, Postgres)', async () => {
  written.length = 0
  // The activity on its own, over the real stores and a real agent: what the workflow would do
  // after a crash that left a partial resume behind.
  const runs = createRunStore(pool)
  const parked = createParkedStore(pool)
  const lease = createHeartbeatLease({
    bindRun: runs.bindRun,
    fenceRun: runs.fenceRun,
    ttlMs: 3000,
    owner: 'direct',
  })
  const agent: IAgent = await createAgent(
    sessionAgentConfig(
      {
        ...agentConfig(llm.baseURL, {
          tools: { write_note: writeNote },
          toolApproval: { mode: 'ask-writes' },
        }),
        persistence: { ...createPostgresPersistence(pool), journal: createPostgresJournal(pool) },
        runLease: lease,
      },
      {},
    ),
  )
  try {
    const activities = createActivities({
      agent,
      runs,
      events: createEventStore(pool, 262_144),
      parked,
      log: silentLogger,
    })
    const sessionId = randomUUID()
    await pool.query(insertSessionSql, [sessionId, workflowIdOf(sessionId)])
    const input: ITurnInput = {
      sessionId,
      turn: 1,
      input: 'notes: red, blue',
      history: [],
      messageIds: ['m'],
    }
    const env = () => new MockActivityEnvironment()
    const first = await env().run(activities.runTurn, input)
    assert.equal(first.status, 'parked')
    if (first.status !== 'parked') return
    const [red, blue] = first.requests
    assert.equal(first.attempt, 1)
    const answer = (id: string) => ({ [id]: { requestId: id, value: { approved: true }, at: 1 } })
    const second = await env().run(activities.runTurn, {
      ...input,
      answers: answer(red!.requestId),
    })
    assert.equal(second.status, 'parked')
    if (second.status !== 'parked') return
    assert.deepEqual(
      second.requests.map((r) => r.requestId),
      [blue!.requestId],
      'parked again with the rest, under the same id',
    )
    assert.equal(second.attempt, 2)
    assert.equal(second.turnAttempt, 2)
    const states = await pool.query<{ item_id: string; state: string }>(
      'SELECT item_id, state FROM swarm_parked WHERE session_id = $1 ORDER BY item_id',
      [sessionId],
    )
    assert.deepEqual(Object.fromEntries(states.rows.map((r) => [r.item_id, r.state])), {
      [red!.requestId]: 'answered',
      [blue!.requestId]: 'pending',
    })
    // A retry of that activity (its result lost) reports the park again and runs nothing.
    const retried = await env().run(activities.runTurn, input)
    assert.equal(retried.status, 'parked')
    const third = await env().run(activities.runTurn, {
      ...input,
      answers: answer(blue!.requestId),
    })
    assert.equal(third.status, 'completed')
    assert.deepEqual(written.sort(), ['blue', 'red'], 'each write once')
  } finally {
    await agent.close()
  }
})

test('stop during a park ends the turn as stopped; its items are cancelled', async () => {
  written.length = 0
  const client = api(base)
  const { body } = await client.post('/sessions', { message: 'notes: never' })
  const sessionId = body.sessionId as string
  const parked = await parkedState(client, sessionId)
  const id = parked.requests[0]!.requestId
  assert.equal((await client.post(`/sessions/${sessionId}/stop`)).status, 202)
  const done = await readSse(`${base}/sessions/${sessionId}/events`, client.headers, ended(1))
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'stopped')
  assert.equal(end.runId, parked.runId)
  const state = await client.get(`/sessions/${sessionId}`)
  assert.equal(state.body.status, 'idle')
  const row = await until('the item to be cancelled', async () => {
    const r = await pool.query<{ state: string }>(
      'SELECT state FROM swarm_parked WHERE session_id = $1 AND item_id = $2',
      [sessionId, id],
    )
    return r.rows[0]?.state === 'cancelled' ? r.rows[0] : undefined
  })
  assert.equal(row.state, 'cancelled')
  assert.equal(
    (await client.post(`/sessions/${sessionId}/answers/${id}`, { approved: true })).status,
    404,
    'nothing waits for it any more',
  )
  assert.deepEqual(written, [])
})
