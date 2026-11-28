// Pipelines (mirrors examples/swarm's tests/integration/pipelines.test.ts): a pipeline call parks
// the turn; the session's object starts a `PipelineWorkflow` instance, which runs the core's graph
// engine as its scheduler - every node visit a `PipelineNodeWorkflow` instance of its own, a wave
// side by side, a node with routes picking one where it ran - and the turn resumes with the
// pipeline's answer. Three kinds of stream: the parent's markers, the pipeline's own (the
// engine's events), each visit's. A stop while a node runs.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  compareCursors,
  parseCursor,
  pipelineNodeWorkflowIdOf,
  pipelineWorkflowIdOf,
  SUBAGENT_MARKER_SEQ,
  type ICursor,
} from 'swarm-shared'
import {
  api,
  planJson,
  readStream,
  roundOf,
  stageOf,
  startStack,
  systemOf,
  toolNames,
  toolResults,
  until,
  userOf,
  type IChatRequest,
  type ISseEvent,
  type IStack,
} from './harness.ts'

let stack: IStack
const asked: Record<string, number[]> = {}
const calls: Record<string, number> = {}
const count = (key: string): number => (calls[key] = (calls[key] ?? 0) + 1)
const WAVE_DELAY_MS = 1500

// start -> left + right (a wave of two, in parallel) -> judge (routes) -> publish | rework.
const review = {
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

const slow = {
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
  stack = await startStack(
    (req) => {
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
      if (stage === 'synthesizer') return { text: `final: ${userOf(req).slice(0, 3000)}` }
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
    },
    { PIPELINES: JSON.stringify({ review, slow }) },
  )
})

after(async () => {
  await stack?.stop()
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
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'review 1 times: the draft' })
  const sessionId = body.sessionId as string
  const stream = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
    150_000,
  )
  const events = stream.events
  inOrder(events)
  const end = events.at(-1)!.data.event
  assert.equal(end.status, 'completed', JSON.stringify(end))
  assert.match(String(end.text), /publish says ok/)

  const [l, r] = [asked.left?.[0], asked.right?.[0]]
  assert.ok(l && r && Math.abs(l - r) < WAVE_DELAY_MS, `left ${l}, right ${r}`)
  for (const node of ['start', 'left', 'right', 'judge', 'publish']) {
    assert.equal(calls[`${node}-planner`], 1, `${node} planned once`)
    assert.equal(calls[`${node}-synthesizer`], 1, `${node} answered once`)
  }
  assert.equal(calls['rework-planner'], undefined, 'the other route never ran')
  assert.equal(calls.router, 1)

  const parkedAt = events.map((e) => e.data.event.type).indexOf('run.parked')
  const markers = events.filter((e) => e.data.event.type.startsWith('pipeline.call.'))
  assert.deepEqual(
    markers.map((e) => e.data.event.type),
    ['pipeline.call.started', 'pipeline.call.ended'],
  )
  for (const m of markers) {
    assert.equal(cursorOf(m).attempt, cursorOf(events[parkedAt]!).attempt)
    assert.ok(cursorOf(m).seq >= SUBAGENT_MARKER_SEQ)
  }
  const done = markers[1]!.data.event
  assert.equal(done.status, 'completed')
  assert.equal(done.runs, 5)

  const listed = await client.get(`/sessions/${sessionId}/pipelines`)
  const call = (listed.body.pipelines as IListed[])[0]!
  assert.equal(call.state, 'answered')
  assert.equal(call.workflowId, pipelineWorkflowIdOf(sessionId, call.runId, call.itemId))
  const own = await readStream(`${stack.base}${call.events}`, client.headers, ended(1))
  inOrder(own.events)
  const ownTypes = own.events.map((e) => e.data.event.type)
  assert.equal(ownTypes[0], 'turn.started')
  assert.equal(ownTypes[1], 'pipeline.started')
  assert.equal(ownTypes.at(-2), 'pipeline.finished')
  assert.equal(ownTypes.at(-1), 'turn.ended')
  const nodeStarts = own.events.filter((e) => e.data.event.type === 'pipeline.node.started')
  assert.deepEqual(
    nodeStarts.map((e) => e.data.event.nodeId),
    ['start', 'left', 'right', 'judge', 'publish'],
  )
  const middle = own.events[3]!
  const rest = await readStream(
    `${stack.base}${call.events}?after=${middle.id}`,
    client.headers,
    ended(1),
  )
  assert.deepEqual(
    rest.events.map((e) => e.id),
    own.events.slice(4).map((e) => e.id),
  )
  for (const s of nodeStarts) {
    const nodeId = s.data.event.nodeId as string
    assert.equal(s.data.event.workflowId, pipelineNodeWorkflowIdOf(call.workflowId, nodeId, 1))
    const visit = await readStream(
      `${stack.base}${s.data.event.events as string}`,
      client.headers,
      ended(1),
    )
    const visitEnd = visit.events.at(-1)!.data.event
    assert.equal(visit.events[0]!.data.event.type, 'turn.started')
    assert.equal(visitEnd.status, 'completed')
    assert.equal(visitEnd.text, `${nodeId} says ok`)
    assert.equal(visitEnd.route, nodeId === 'judge' ? 'approve' : undefined)
  }
})

test('stop while a pipeline runs: the turn ends stopped, the pipeline and its node are stopped', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'slow 1 times: think' })
  const sessionId = body.sessionId as string
  const parked = await until(
    'the node to be running',
    async () => {
      const s = await client.get(`/sessions/${sessionId}`)
      const p = s.body.parked as { requests: { requestId: string; pipeline?: unknown }[] }
      return p && asked.wait?.length ? p : undefined
    },
    90_000,
  )
  const itemId = parked.requests[0]!.requestId
  assert.deepEqual(parked.requests[0]!.pipeline, { name: 'slow', task: 'think #1' })
  const refused = await client.post(`/sessions/${sessionId}/answers/${itemId}`, { output: 'mine' })
  assert.equal(refused.status, 409)
  assert.equal((refused.body.error as { code: string }).code, 'answered_by_pipeline')
  const t0 = Date.now()
  assert.equal((await client.post(`/sessions/${sessionId}/stop`)).status, 202)
  const done = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
  )
  assert.equal(done.events.at(-1)!.data.event.status, 'stopped')
  const own = await readStream(
    `${stack.base}/sessions/${sessionId}/pipelines/${itemId}/events`,
    client.headers,
    ended(1),
  )
  assert.equal(own.events.at(-1)!.data.event.status, 'stopped')
  const visit = await readStream(
    `${stack.base}/sessions/${sessionId}/pipelines/${itemId}/nodes/wait/1/events`,
    client.headers,
    ended(1),
  )
  assert.equal(visit.events.at(-1)!.data.event.status, 'stopped')
  assert.ok(Date.now() - t0 < 25_000, 'before the hung model call answered')
  const listed = await client.get(`/sessions/${sessionId}/pipelines`)
  assert.equal((listed.body.pipelines as IListed[])[0]!.state, 'cancelled')
})
