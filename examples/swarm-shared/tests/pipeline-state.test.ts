// The pipeline workflow's logic, without Temporal: the signal the engine reads, the stream log and
// its batches, the node children's input and output, and how a run comes out - including the
// engine itself driven the way the workflow drives it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  preparePipeline,
  runPipelineGraph,
  type PipelineDefinition,
  type PipelineEvent,
} from '@dudko.dev/agent/pipeline-engine'
import {
  completedOutcomeOf,
  createAbortLatch,
  createStreamLog,
  emptyUsage,
  failedOutcomeOf,
  isAbortError,
  nodeInputOf,
  nodeOutputOf,
  PIPELINE_ERROR_MAX_CHARS,
  PIPELINE_TEXT_MAX_CHARS,
  STREAM_BATCH_MAX,
  sumUsage,
} from '../src/pipeline-state.ts'
import { pipelineNodeStreamOf, pipelineNodeWorkflowIdOf } from '../src/session-ids.ts'
import type { IPipelineInput } from '../src/session-types.ts'

const input: IPipelineInput = {
  sessionId: 's',
  turn: 2,
  parentRunId: 'r1',
  itemId: 'p_1',
  workflowId: 'pipeline-s-r1-p_1',
  stream: 's/p_1',
  name: 'review',
  task: 'the task',
  options: { turnTimeoutMs: 60_000, heartbeatTimeoutMs: 10_000, maxTurnAttempts: 3 },
}
const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 }

test('the abort latch: what the engine reads of a signal; once, in order, a throw stays put', () => {
  const { signal, abort } = createAbortLatch()
  const seen: string[] = []
  const a = () => seen.push('a')
  signal.addEventListener('abort', a)
  signal.addEventListener('abort', a)
  signal.addEventListener('abort', () => {
    throw new Error('mine')
  })
  signal.addEventListener('abort', () => seen.push('b'))
  const gone = () => seen.push('gone')
  signal.addEventListener('abort', gone)
  signal.removeEventListener('abort', gone)
  signal.addEventListener('other' as 'abort', () => seen.push('other'))
  assert.equal(signal.aborted, false)
  abort()
  abort()
  assert.equal(signal.aborted, true)
  assert.deepEqual(seen, ['a', 'b'])
})

test('the stream log: numbered in order, batched, a node start names its child and stream', () => {
  const log = createStreamLog(input)
  assert.equal(log.take(), undefined)
  log.push({ type: 'pipeline.started', pipeline: 'review' })
  log.push({ type: 'pipeline.node.started', nodeId: 'draft', visit: 2, from: ['check'] })
  const batch = log.take()!
  assert.equal(batch.stream, 's/p_1')
  assert.deepEqual(
    batch.events.map((e) => [e.seq, e.event.type]),
    [
      [1, 'pipeline.started'],
      [2, 'pipeline.node.started'],
    ],
  )
  assert.deepEqual(batch.events[1]!.event, {
    type: 'pipeline.node.started',
    nodeId: 'draft',
    visit: 2,
    from: ['check'],
    workflowId: pipelineNodeWorkflowIdOf(input.workflowId, 'draft', 2),
    events: '/sessions/s/pipelines/p_1/nodes/draft/2/events',
  })
  assert.equal(log.pending(), 0)
  // The numbers go on across batches; a batch is bounded.
  for (let i = 0; i < STREAM_BATCH_MAX + 3; i++) {
    log.push({ type: 'pipeline.edge', from: 'a', to: 'b', edgeId: 'e0', visit: 1, fired: true })
  }
  const big = log.take()!
  assert.equal(big.events.length, STREAM_BATCH_MAX)
  assert.equal(big.events[0]!.seq, 3)
  assert.equal(log.take()!.events.length, 3)
})

test("a node child's input: ids and stream of the visit; its output: clipped, or a throw", () => {
  const n = nodeInputOf(
    input,
    { id: 'check', routes: [{ label: 'ok' }] },
    { request: 'the task', from: [{ nodeId: 'draft', text: 'd' }], visit: 3 },
  )
  assert.equal(n.workflowId, 'pipeline-s-r1-p_1.check.3')
  assert.equal(n.stream, pipelineNodeStreamOf('s', 'p_1', 'check', 3))
  assert.equal(n.stream, 's/p_1/check/3')
  assert.equal(n.pipeline, 'review')
  assert.equal(n.input.visit, 3)
  assert.deepEqual(n.options, input.options)

  const done = nodeOutputOf({
    status: 'completed',
    runId: 'r',
    attempt: 1,
    text: 'x'.repeat(PIPELINE_TEXT_MAX_CHARS + 5),
    usage,
    route: 'ok',
  })
  assert.equal(done.text.length, PIPELINE_TEXT_MAX_CHARS)
  assert.equal(done.route, 'ok')
  assert.deepEqual(done.usage, usage)
  assert.equal(
    'route' in nodeOutputOf({ status: 'completed', runId: 'r', attempt: 1, text: 't', usage }),
    false,
  )
  assert.throws(() => nodeOutputOf({ status: 'failed', error: 'boom' }), /^Error: boom$/)
  assert.throws(() => nodeOutputOf({ status: 'stopped' }), /stopped before it answered/)
})

test('how a run comes out: completed (a cap noted), failed (the node named), stopped', () => {
  const tally = { runs: 4, usage }
  const ok = completedOutcomeOf(
    { text: 'final', outputs: {}, trace: [], usage, runs: 4, stoppedBy: 'maxNodeVisits' },
    tally,
  )
  assert.deepEqual(ok, {
    status: 'completed',
    text: 'final',
    usage,
    runs: 4,
    stoppedBy: 'maxNodeVisits',
  })
  assert.equal(
    'stoppedBy' in completedOutcomeOf({ text: 't', outputs: {}, trace: [], usage, runs: 1 }, tally),
    false,
  )
  const nodeError = Object.assign(new Error('Pipeline node "b" failed (visit 2): boom'), {
    name: 'PipelineNodeError',
    nodeId: 'b',
    visit: 2,
  })
  assert.deepEqual(failedOutcomeOf(nodeError, tally), {
    status: 'failed',
    error: 'Pipeline node "b" failed (visit 2): boom',
    runs: 4,
    usage,
    nodeId: 'b',
    visit: 2,
  })
  const other = failedOutcomeOf(new Error('x'.repeat(PIPELINE_ERROR_MAX_CHARS * 2)), tally)
  assert.equal(other.status === 'failed' && other.error.length, PIPELINE_ERROR_MAX_CHARS)
  assert.equal('nodeId' in other, false)
  const named = Object.assign(new Error('Aborted'), { name: 'AbortError' })
  assert.equal(isAbortError(named), true)
  assert.equal(isAbortError(new Error('Aborted')), false)
  assert.deepEqual(sumUsage(emptyUsage(), { ...usage, reasoningTokens: 5 }), {
    ...usage,
    reasoningTokens: 5,
  })
})

// The engine as the workflow drives it: a wave of two started together, a route, the events in
// order - and the same answers in the same order give the same events (what a replay relies on).
const graph: PipelineDefinition = {
  version: 1,
  entry: 'start',
  nodes: [
    { id: 'start' },
    { id: 'left' },
    { id: 'right' },
    { id: 'judge', routes: [{ label: 'approve' }, { label: 'revise' }] },
    { id: 'publish' },
  ],
  edges: [
    { from: 'start', to: 'left' },
    { from: 'start', to: 'right' },
    { from: 'left', to: 'judge' },
    { from: 'right', to: 'judge' },
    { from: 'judge', to: 'publish', when: { kind: 'route', label: 'approve' } },
  ],
}

const drive = async (abortAt?: string) => {
  const log = createStreamLog(input)
  const latch = createAbortLatch()
  const started: string[][] = []
  let wave: string[] = []
  const result = runPipelineGraph(
    preparePipeline(graph),
    async (node, nodeInput, ctx) => {
      wave.push(node.id)
      const outcome = await new Promise<Parameters<typeof nodeOutputOf>[0]>((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')))
        queueMicrotask(() => {
          if (node.id === abortAt) {
            latch.abort()
            return
          }
          resolve({
            status: 'completed',
            runId: `run-${node.id}`,
            attempt: 1,
            text: `${node.id} after ${nodeInput.from.map((f) => f.nodeId).join('+') || 'request'}`,
            usage,
            ...(node.id === 'judge' ? { route: 'approve' } : {}),
          })
        })
      })
      if (wave.length) {
        started.push(wave)
        wave = []
      }
      return nodeOutputOf(outcome)
    },
    {
      input: input.task,
      signal: latch.signal,
      onEvent: (e) => log.push(e as PipelineEvent),
      onAbort: 'reject',
    },
  )
  return { result, log, started }
}

test('the engine under the workflow: a wave started together, the route taken, deterministic', async () => {
  const first = await drive()
  const result = await first.result
  assert.equal(result.text, 'publish after judge')
  assert.deepEqual(first.started, [['start'], ['left', 'right'], ['judge'], ['publish']])
  const events = first.log.take()!.events
  const types = events.map(
    (e) => `${e.event.type}${'nodeId' in e.event ? `:${e.event.nodeId}` : ''}`,
  )
  assert.equal(types[0], 'pipeline.started')
  assert.equal(types.at(-1), 'pipeline.finished')
  assert.ok(
    types.indexOf('pipeline.node.started:right') < types.indexOf('pipeline.node.finished:left'),
  )
  assert.equal(
    events.find((e) => e.event.type === 'pipeline.node.finished' && e.event.nodeId === 'judge')!
      .event.route,
    'approve',
  )
  // The same answers in the same order: the same events, numbered the same.
  const again = await drive()
  await again.result
  assert.deepEqual(again.log.take()!.events, events)
})

test('the engine under the workflow: an abort rejects at once with an AbortError', async () => {
  const run = await drive('right')
  await assert.rejects(run.result, (err: unknown) => isAbortError(err))
  const last = run.log.take()!.events.at(-1)!.event
  assert.deepEqual(last, { type: 'pipeline.finished', stoppedBy: 'aborted', runs: 3 })
})
