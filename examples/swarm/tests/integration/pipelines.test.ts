// Pipelines as child workflows: a call of a pipeline tool parks the turn with one item; the session
// starts a child workflow `pipeline`, whose graph engine starts one child workflow `pipelineNode`
// per node visit - the two nodes of a wave side by side - and the turn goes on with the
// pipeline's answer. The route of a routed node is picked in that node's activity. The caps
// refuse with a tool error, a stop cancels the pipeline and its nodes, and every stream has its
// route.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import type { TestWorkflowEnvironment } from '@temporalio/testing'
import type pg from 'pg'
import {
  compareCursors,
  parseCursor,
  pipelineNodeWorkflowIdOf,
  pipelineWorkflowIdOf,
  SUBAGENT_MARKER_SEQ,
  workflowIdOf,
  type ICursor,
  type IParkedRequest,
} from 'swarm-shared'
import { insertSessionSql } from '../../src/backend.ts'
import type { IRunningGateway } from '../../src/gateway-main.ts'
import type { IPipelineConfig } from '../../src/pipelines.ts'
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
  systemOf,
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
// When each node's executor was asked, and how often each node's stages were.
const asked: Record<string, number[]> = {}
const calls: Record<string, number> = {}
const count = (key: string): number => (calls[key] = (calls[key] ?? 0) + 1)

const WAVE_DELAY_MS = 1500

// start -> left + right (a wave of two, in parallel) -> judge (routes) -> publish | rework.
const review: IPipelineConfig = {
  description: 'Review a text with a panel of agents and publish it',
  readOnly: true,
  definition: {
    version: 1,
    name: 'review',
    entry: 'start',
    nodes: [
      { id: 'start', instructions: 'NODE=start' },
      { id: 'left', instructions: 'NODE=left' },
      { id: 'right', instructions: 'NODE=right' },
      {
        id: 'judge',
        instructions: 'NODE=judge',
        routes: [
          { label: 'approve', description: 'good enough' },
          { label: 'revise', description: 'not yet' },
        ],
      },
      { id: 'publish', instructions: 'NODE=publish' },
      { id: 'rework', instructions: 'NODE=rework' },
    ],
    edges: [
      { from: 'start', to: 'left' },
      { from: 'start', to: 'right' },
      { from: 'left', to: 'judge' },
      { from: 'right', to: 'judge' },
      { from: 'judge', to: 'publish', when: { kind: 'route', label: 'approve' } },
      { from: 'judge', to: 'rework', when: { kind: 'route', label: 'revise' } },
    ],
  },
}

// One node that hangs: for the stop.
const slow: IPipelineConfig = {
  description: 'Think for a long time',
  readOnly: true,
  definition: {
    version: 1,
    entry: 'wait',
    nodes: [{ id: 'wait', instructions: 'NODE=wait' }],
    edges: [],
  },
}

const nodeOf = (req: IChatRequest): string | undefined => /NODE=([a-z]+)/.exec(systemOf(req))?.[1]
const isRouter = (req: IChatRequest): boolean => systemOf(req).includes('You are the Router')

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  llm = await startLocalOpenAI((req) => {
    if (isRouter(req)) {
      count('router')
      return { text: JSON.stringify({ route: 'approve' }) }
    }
    const stage = stageOf(req)
    if (stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    const node = nodeOf(req)
    if (node) {
      count(`${node}-${stage}`)
      if (stage === 'planner') return { text: planJson(['n']) }
      if (stage === 'synthesizer') return { text: `${node} says ok` }
      ;(asked[node] ??= []).push(Date.now())
      if (node === 'wait') return { text: 'never seen', delayMs: 30_000 }
      return {
        text: `${node} did it`,
        ...(node === 'left' || node === 'right' ? { delayMs: WAVE_DELAY_MS } : {}),
      }
    }
    if (stage === 'planner') return { text: planJson(['a']) }
    if (stage === 'synthesizer') return { text: `final: ${userOf(req).slice(0, 2000)}` }
    // The last ask in the prompt (the history comes before the request).
    const m = [...userOf(req).matchAll(/(review|slow) (\d) times: ([a-z ]+)/g)].at(-1)
    if (roundOf(req) === 0 && m && toolNames(req).includes(m[1]!)) {
      return {
        toolCalls: Array.from({ length: Number(m[2]) }, (_, i) => ({
          name: m[1]!,
          args: { task: `${m[3]} #${i + 1}` },
        })),
      }
    }
    return { text: `results: ${toolResults(req).join(' | ')}` }
  })
  queue = uniqueQueue('pipelines')
  worker = await inProcessWorker(
    workerConfig(temporal, queue, agentConfig(llm.baseURL), { pipelines: { review, slow } }),
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
const inOrder = (events: ISseEvent[]): void => {
  for (let i = 1; i < events.length; i++) {
    assert.ok(compareCursors(cursorOf(events[i - 1]!), cursorOf(events[i]!)) < 0, 'in order')
  }
}

interface IListed {
  itemId: string
  runId: string
  state: string
  workflowId: string
  name: string
  task: string
  events: string
}

test('a pipeline call: a wave of two side by side, a routed node, the turn resumes with the answer', async () => {
  const client = api(base)
  const { body } = await client.post('/sessions', { message: 'review 1 times: the draft' })
  const sessionId = body.sessionId as string
  const stream = await readSse(
    `${base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
    90_000,
  )
  const events = stream.events
  inOrder(events)
  const end = events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /publish says ok/, 'the pipeline answer reached the parent')

  // The wave: left and right were asked before either had answered (each answer takes 1.5 s).
  const [l, r] = [asked.left?.[0], asked.right?.[0]]
  assert.ok(l && r && Math.abs(l - r) < WAVE_DELAY_MS, `left ${l}, right ${r}`)
  // Every node ran once; the router was asked once (for judge), and judge's route led to publish.
  for (const node of ['start', 'left', 'right', 'judge', 'publish']) {
    assert.equal(calls[`${node}-planner`], 1, `${node} planned once`)
    assert.equal(calls[`${node}-synthesizer`], 1, `${node} answered once`)
  }
  assert.equal(calls['rework-planner'], undefined, 'the other route never ran')
  assert.equal(calls.router, 1)

  // The parent's stream: run.parked, then the call's two markers in the parked attempt's slot, then
  // the resumed attempt.
  const types = events.map((e) => e.data.event.type)
  const parkedAt = types.indexOf('run.parked')
  const markers = events.filter((e) => e.data.event.type.startsWith('pipeline.call.'))
  assert.deepEqual(
    markers.map((e) => e.data.event.type),
    ['pipeline.call.started', 'pipeline.call.ended'],
  )
  const parkedSlot = cursorOf(events[parkedAt]!).attempt
  for (const m of markers) {
    assert.equal(cursorOf(m).attempt, parkedSlot)
    assert.ok(cursorOf(m).seq >= SUBAGENT_MARKER_SEQ)
    assert.ok(events.indexOf(m) > parkedAt)
  }
  const resumedAt = events.findIndex((e) => e.data.event.attempt === 2)
  assert.ok(resumedAt > events.indexOf(markers.at(-1)!), 'the markers come before the resume')
  const [started, done] = markers.map((m) => m.data.event)
  assert.equal(started!.name, 'review')
  assert.equal(started!.task, 'the draft #1')
  assert.equal(done!.status, 'completed')
  assert.equal(done!.runs, 5)
  assert.ok((done!.usage as { totalTokens: number }).totalTokens > 0)

  // The resumed round saw the pipeline's answer as the call's result.
  const resumed = llm.requests.find(
    (q) => !nodeOf(q) && stageOf(q) === 'executor' && toolResults(q).length === 1,
  )!
  assert.match(toolResults(resumed).join('\n'), /publish says ok/)

  // GET /sessions/:id/pipelines: the call, answered, its workflow named after session + run + item.
  const listed = await client.get(`/sessions/${sessionId}/pipelines`)
  const calls_ = listed.body.pipelines as IListed[]
  assert.equal(calls_.length, 1)
  const call = calls_[0]!
  assert.equal(call.state, 'answered')
  assert.equal(call.name, 'review')
  assert.equal(call.workflowId, pipelineWorkflowIdOf(sessionId, call.runId, call.itemId))
  assert.equal(
    (await temporal.client.workflow.getHandle(call.workflowId).describe()).status.name,
    'COMPLETED',
  )
  // The pipeline's own stream: turn.started, the engine's events in order, turn.ended.
  const own = await readSse(`${base}${call.events}`, client.headers, ended(1))
  inOrder(own.events)
  const ownTypes = own.events.map((e) => e.data.event.type)
  assert.equal(ownTypes[0], 'turn.started')
  assert.equal(ownTypes[1], 'pipeline.started')
  assert.equal(ownTypes.at(-2), 'pipeline.finished')
  assert.equal(ownTypes.at(-1), 'turn.ended')
  assert.equal(own.events.at(-1)!.data.event.status, 'completed')
  const nodeStarts = own.events.filter((e) => e.data.event.type === 'pipeline.node.started')
  assert.deepEqual(
    nodeStarts.map((e) => e.data.event.nodeId),
    ['start', 'left', 'right', 'judge', 'publish'],
  )
  const judged = own.events.find(
    (e) => e.data.event.type === 'pipeline.node.finished' && e.data.event.nodeId === 'judge',
  )!
  assert.equal(judged.data.event.route, 'approve')
  // Replay from a cursor: everything after it, nothing before.
  const middle = own.events[3]!
  const rest = await readSse(`${base}${call.events}?after=${middle.id}`, client.headers, ended(1))
  assert.deepEqual(
    rest.events.map((e) => e.id),
    own.events.slice(4).map((e) => e.id),
  )
  const viaHeader = await readSse(
    `${base}${call.events}`,
    { ...client.headers, 'last-event-id': middle.id },
    ended(1),
  )
  assert.deepEqual(
    viaHeader.events.map((e) => e.id),
    own.events.slice(4).map((e) => e.id),
  )

  // Each node visit: a child workflow of the pipeline, a stream of its own (its run's events), and
  // its turn.ended - judge's with the route its activity picked.
  for (const s of nodeStarts) {
    const nodeId = s.data.event.nodeId as string
    assert.equal(s.data.event.workflowId, pipelineNodeWorkflowIdOf(call.workflowId, nodeId, 1))
    const d = await temporal.client.workflow.getHandle(s.data.event.workflowId as string).describe()
    assert.equal(d.status.name, 'COMPLETED')
    assert.equal(d.parentExecution?.workflowId, call.workflowId)
    const visit = await readSse(`${base}${s.data.event.events as string}`, client.headers, ended(1))
    const visitTypes = visit.events.map((e) => e.data.event.type)
    assert.equal(visitTypes[0], 'turn.started')
    assert.ok(visitTypes.includes('plan.created'))
    const visitEnd = visit.events.at(-1)!.data.event
    assert.equal(visitEnd.status, 'completed')
    assert.equal(visitEnd.text, `${nodeId} says ok`)
    assert.equal(visitEnd.route, nodeId === 'judge' ? 'approve' : undefined)
  }
  // One run per visit: nothing ran twice.
  const runs = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM swarm_runs WHERE session_id LIKE $1 || '/%/%/%'",
    [sessionId],
  )
  assert.equal(runs.rows[0]?.n, 5)
})

test('the caps: beyond the per-round and the per-session cap a call is a tool error, never a child', async () => {
  const client = api(base)
  const sessionId = randomUUID()
  await pool.query(insertSessionSql, [sessionId, workflowIdOf(sessionId)])
  await temporal.client.workflow.signalWithStart(SESSION_WORKFLOW, {
    taskQueue: queue,
    workflowId: workflowIdOf(sessionId),
    args: [
      {
        sessionId,
        options: sessionOptions({ pipelineMaxPerRound: 1, pipelineMaxPerSession: 1 }),
      },
    ],
    signal: 'message',
    signalArgs: [{ id: 'm1', text: 'review 2 times: capped', at: 1 }],
  })
  const first = await readSse(
    `${base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
    90_000,
  )
  assert.equal(first.events.at(-1)!.data.event.status, 'completed')
  const resumed = llm.requests.find(
    (q) =>
      !nodeOf(q) &&
      stageOf(q) === 'executor' &&
      /capped/.test(userOf(q)) &&
      toolResults(q).length === 2,
  )!
  const shown = toolResults(resumed).join('\n')
  assert.match(shown, /publish says ok/, 'the first call ran')
  assert.match(shown, /at most 1 pipeline calls in one round/, 'the second one was refused')

  // The session's cap: one call per session, so the next turn's call is refused too.
  await client.post(`/sessions/${sessionId}/messages`, { text: 'review 1 times: again' })
  const second = await readSse(
    `${base}/sessions/${sessionId}/events`,
    client.headers,
    ended(2),
    60_000,
  )
  assert.equal(second.events.at(-1)!.data.event.status, 'completed')
  const again = llm.requests.find(
    (q) => !nodeOf(q) && stageOf(q) === 'executor' && /again/.test(userOf(q)) && roundOf(q) === 1,
  )!
  assert.match(toolResults(again).join('\n'), /this session may start no more pipeline calls/)
  assert.equal(
    second.events.filter((e) => e.data.turn === 2 && e.data.event.type === 'run.parked').length,
    0,
    'a refused call does not park the turn',
  )
  const listed = await client.get(`/sessions/${sessionId}/pipelines`)
  assert.equal((listed.body.pipelines as unknown[]).length, 1, 'one pipeline in the session')
})

test('stop while a pipeline runs: the turn ends stopped, the pipeline and its node are cancelled', async () => {
  const client = api(base)
  const { body } = await client.post('/sessions', { message: 'slow 1 times: think' })
  const sessionId = body.sessionId as string
  const parked = await until(
    'the node to be running',
    async () => {
      const s = await client.get(`/sessions/${sessionId}`)
      const p = s.body.parked as { requests: IParkedRequest[] } | undefined
      return p && asked.wait?.length ? p : undefined
    },
    60_000,
  )
  const itemId = parked.requests[0]!.requestId
  assert.deepEqual(parked.requests[0]!.pipeline, { name: 'slow', task: 'think #1' })
  // A client cannot answer what a pipeline answers.
  const refused = await client.post(`/sessions/${sessionId}/answers/${itemId}`, { output: 'mine' })
  assert.equal(refused.status, 409)
  assert.equal((refused.body.error as { code: string }).code, 'answered_by_pipeline')
  const asked_ = Date.now()
  assert.equal((await client.post(`/sessions/${sessionId}/stop`)).status, 202)
  const done = await readSse(`${base}/sessions/${sessionId}/events`, client.headers, ended(1))
  assert.equal(done.events.at(-1)!.data.event.status, 'stopped')
  // The pipeline's own stream and its node's both end as stopped, before the hung model answers.
  const own = await readSse(
    `${base}/sessions/${sessionId}/pipelines/${itemId}/events`,
    client.headers,
    ended(1),
  )
  assert.equal(own.events.at(-1)!.data.event.status, 'stopped')
  const visit = await readSse(
    `${base}/sessions/${sessionId}/pipelines/${itemId}/nodes/wait/1/events`,
    client.headers,
    ended(1),
  )
  assert.equal(visit.events.at(-1)!.data.event.status, 'stopped')
  assert.ok(Date.now() - asked_ < 20_000, 'before the hung model call answered')
  const listed = await client.get(`/sessions/${sessionId}/pipelines`)
  const call = (listed.body.pipelines as IListed[])[0]!
  assert.equal(call.state, 'cancelled')
  const status = async (id: string) =>
    until(`${id} to be over`, async () => {
      const d = await temporal.client.workflow.getHandle(id).describe()
      return d.status.name === 'RUNNING' ? undefined : d.status.name
    })
  assert.equal(await status(call.workflowId), 'CANCELLED')
  assert.equal(await status(pipelineNodeWorkflowIdOf(call.workflowId, 'wait', 1)), 'CANCELLED')
})
