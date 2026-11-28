// Static subagents as child workflows: two calls of `researcher` in one round park the turn with
// two items; the session starts two child workflows, which run in parallel (each one agent.run of
// the profile, in its own stream), and the turn goes on with both answers. The caps refuse with a
// tool error; a stop while the children run cancels them.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import type { TestWorkflowEnvironment } from '@temporalio/testing'
import type pg from 'pg'
import {
  compareCursors,
  parseCursor,
  SUBAGENT_MARKER_SEQ,
  subagentWorkflowIdOf,
  workflowIdOf,
  type ICursor,
  type IParkedRequest,
} from 'swarm-shared'
import { insertSessionSql } from '../../src/backend.ts'
import type { IRunningGateway } from '../../src/gateway-main.ts'
import { SESSION_WORKFLOW } from '../../src/session-api.ts'
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
  sessionOptions,
  stageOf,
  startLocalOpenAI,
  startTemporal,
  toolNames,
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
let queue: string
// When each child's executor was asked (to see them run side by side).
const childAsked: Record<string, number[]> = {}

const CHILD_DELAY_MS = 1500
const taskOf = (req: IChatRequest): string | undefined =>
  /look into ([a-z]+)/.exec(userOf(req))?.[1]
const isChild = (req: IChatRequest): boolean =>
  taskOf(req) !== undefined && !/research these/.test(userOf(req))

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  llm = await startLocalOpenAI((req) => {
    const stage = stageOf(req)
    if (stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    if (isChild(req)) {
      const task = taskOf(req)!
      if (stage === 'planner') return { text: planJson(['c']) }
      if (stage === 'synthesizer') return { text: `child says ${task}` }
      ;(childAsked[task] ??= []).push(Date.now())
      return { text: `looked into ${task}`, delayMs: task === 'slow' ? 30_000 : CHILD_DELAY_MS }
    }
    if (stage === 'planner') return { text: planJson(['a']) }
    if (stage === 'synthesizer') return { text: `final: ${userOf(req).slice(0, 2000)}` }
    if (roundOf(req) === 0 && toolNames(req).includes('researcher')) {
      const tasks = /research these: ([a-z, ]+)/.exec(userOf(req))?.[1]?.split(',') ?? []
      return {
        toolCalls: tasks.map((t) => ({
          name: 'researcher',
          args: { task: `look into ${t.trim()}` },
        })),
      }
    }
    return { text: `results: ${toolResults(req).join(' | ')}` }
  })
  queue = uniqueQueue('subagents')
  worker = await inProcessWorker(
    workerConfig(temporal, queue, agentConfig(llm.baseURL), {
      subagents: {
        researcher: {
          description: 'Look into one thing and report what you found',
          systemPrompt: 'You are a careful researcher.',
          readOnly: true,
        },
      },
    }),
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
const cursorOf = (e: ISseEvent): ICursor => {
  const parsed = parseCursor(e.id)
  assert.ok(parsed.ok)
  return parsed.cursor
}

test('two subagent calls in one round: two child workflows in parallel, the turn resumes with both', async () => {
  const client = api(base)
  const { body } = await client.post('/sessions', { message: 'research these: alpha, beta' })
  const sessionId = body.sessionId as string
  const stream = await readSse(
    `${base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
    60_000,
  )
  const events = stream.events
  for (let i = 1; i < events.length; i++) {
    assert.ok(compareCursors(cursorOf(events[i - 1]!), cursorOf(events[i]!)) < 0, 'in order')
  }
  const end = events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /child says alpha/)
  assert.match(String(end.text), /child says beta/)

  // The children ran side by side: each one's executor was asked before the other had answered.
  const [a, b] = [childAsked.alpha?.[0], childAsked.beta?.[0]]
  assert.ok(a && b && Math.abs(a - b) < CHILD_DELAY_MS, `alpha ${a}, beta ${b}`)

  // The parent's stream: run.parked, the four subagent markers in the parked attempt's slot, then
  // the resumed attempt.
  const types = events.map((e) => e.data.event.type)
  const parkedAt = types.indexOf('run.parked')
  const markers = events.filter((e) => e.data.event.type.startsWith('subagent.'))
  const own = markers.filter((e) => e.data.event.itemId !== undefined)
  assert.deepEqual(
    own.map((e) => e.data.event.type),
    ['subagent.started', 'subagent.started', 'subagent.ended', 'subagent.ended'],
  )
  const parkedSlot = cursorOf(events[parkedAt]!).attempt
  for (const m of own) {
    assert.equal(cursorOf(m).attempt, parkedSlot, 'in the parked attempt slot')
    assert.ok(cursorOf(m).seq >= SUBAGENT_MARKER_SEQ)
    assert.ok(events.indexOf(m) > parkedAt)
  }
  const resumedAt = events.findIndex((e) => e.data.event.attempt === 2)
  assert.ok(resumedAt > events.indexOf(own.at(-1)!), 'the markers come before the resumed attempt')
  assert.deepEqual(
    own.slice(2).map((e) => e.data.event.status),
    ['completed', 'completed'],
  )

  // The resumed round saw both answers as the calls' results.
  const resumed = llm.requests.find(
    (r) => !isChild(r) && stageOf(r) === 'executor' && toolResults(r).length === 2,
  )!
  assert.ok(resumed, 'the parent executor got two tool results')
  const shown = toolResults(resumed).join('\n')
  assert.match(shown, /child says alpha/)
  assert.match(shown, /child says beta/)

  // The children: listed, answered, their workflows named after session + run + item, done.
  const listed = await client.get(`/sessions/${sessionId}/subagents`)
  const subs = listed.body.subagents as {
    itemId: string
    runId: string
    state: string
    workflowId: string
    task: string
    events: string
  }[]
  assert.deepEqual(
    subs.map((s) => s.state),
    ['answered', 'answered'],
  )
  assert.deepEqual(subs.map((s) => s.task).sort(), ['look into alpha', 'look into beta'])
  for (const s of subs) {
    assert.equal(s.workflowId, subagentWorkflowIdOf(sessionId, s.runId, s.itemId))
    const d = await temporal.client.workflow.getHandle(s.workflowId).describe()
    assert.equal(d.status.name, 'COMPLETED')
    // Each child's own stream: its run's events, then its turn.ended.
    const child = await readSse(`${base}${s.events}`, client.headers, ended(1))
    const childTypes = child.events.map((e) => e.data.event.type)
    assert.equal(childTypes[0], 'turn.started')
    assert.ok(childTypes.includes('plan.created'))
    assert.equal(child.events.at(-1)!.data.event.status, 'completed')
    assert.match(String(child.events.at(-1)!.data.event.text), /child says (alpha|beta)/)
  }
  // One child run per item: nothing ran twice.
  const childRuns = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM swarm_runs WHERE session_id LIKE $1 || '/%'",
    [sessionId],
  )
  assert.equal(childRuns.rows[0]?.n, 2)
})

test('the per-round cap: a call beyond it is a tool error the model reads, never a child', async () => {
  const client = api(base)
  const sessionId = randomUUID()
  await pool.query(insertSessionSql, [sessionId, workflowIdOf(sessionId)])
  await temporal.client.workflow.signalWithStart(SESSION_WORKFLOW, {
    taskQueue: queue,
    workflowId: workflowIdOf(sessionId),
    args: [{ sessionId, options: sessionOptions({ subagentMaxPerRound: 1 }) }],
    signal: 'message',
    signalArgs: [{ id: 'm1', text: 'research these: gamma, delta', at: 1 }],
  })
  const done = await readSse(
    `${base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
    60_000,
  )
  assert.equal(done.events.at(-1)!.data.event.status, 'completed')
  const resumed = llm.requests.find(
    (r) =>
      !isChild(r) &&
      stageOf(r) === 'executor' &&
      /gamma/.test(userOf(r)) &&
      toolResults(r).length === 2,
  )!
  const shown = toolResults(resumed).join('\n')
  assert.match(shown, /child says gamma/)
  assert.match(shown, /at most 1 subagent calls in one round/)
  const listed = await client.get(`/sessions/${sessionId}/subagents`)
  assert.equal((listed.body.subagents as unknown[]).length, 1, 'one child')
})

test('stop while the children run: the turn ends as stopped and the children are cancelled', async () => {
  const client = api(base)
  const { body } = await client.post('/sessions', { message: 'research these: slow' })
  const sessionId = body.sessionId as string
  const parked = await until(
    'the child to be running',
    async () => {
      const s = await client.get(`/sessions/${sessionId}`)
      const p = s.body.parked as { requests: IParkedRequest[] } | undefined
      return p && childAsked.slow?.length ? p : undefined
    },
    60_000,
  )
  const itemId = parked.requests[0]!.requestId
  assert.equal(
    (await client.post(`/sessions/${sessionId}/answers/${itemId}`, { output: 'mine' })).status,
    409,
    'a subagent answers it, not a client',
  )
  const asked = Date.now()
  assert.equal((await client.post(`/sessions/${sessionId}/stop`)).status, 202)
  const done = await readSse(`${base}/sessions/${sessionId}/events`, client.headers, ended(1))
  assert.equal(done.events.at(-1)!.data.event.status, 'stopped')
  const child = await readSse(
    `${base}/sessions/${sessionId}/subagents/${itemId}/events`,
    client.headers,
    ended(1),
  )
  assert.equal(child.events.at(-1)!.data.event.status, 'stopped')
  assert.ok(Date.now() - asked < 20_000, 'before the hung model call answered')
  const listed = await client.get(`/sessions/${sessionId}/subagents`)
  const sub = (listed.body.subagents as { workflowId: string; state: string }[])[0]!
  assert.equal(sub.state, 'cancelled')
  const d = await until('the child workflow to be cancelled', async () => {
    const desc = await temporal.client.workflow.getHandle(sub.workflowId).describe()
    return desc.status.name === 'RUNNING' ? undefined : desc
  })
  assert.equal(d.status.name, 'CANCELLED')
})
