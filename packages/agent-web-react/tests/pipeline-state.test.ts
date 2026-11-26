import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent, PipelineDefinition, PipelineNodeRunner } from '@dudko.dev/agent-web'
import {
  createInitialPipelineState,
  createPipeline,
  PipelineNodeError,
  pipelineNodeView,
  pipelineStateReducer,
  type PipelineAction,
  type PipelineResult,
  type PipelineUiState,
} from '../dist/pipeline.js'

// The reducer against event sequences RECORDED FROM THE CORE'S OWN RUNNER: each test runs a real
// `createPipeline` with a scripted `runNode` (no model), keeps every event it emitted, and folds
// them. So the sequences are exactly what a page receives - their order included.

type Runner = PipelineNodeRunner<AgentEvent>

interface Recording {
  events: AgentEvent[]
  result?: PipelineResult
  error?: unknown
}

const record = async (
  definition: PipelineDefinition,
  runNode: Runner,
  signal?: AbortSignal,
): Promise<Recording> => {
  const events: AgentEvent[] = []
  const pipeline = createPipeline(definition, { runNode })
  try {
    const result = await pipeline.run({ input: 'go', signal, onEvent: (e) => events.push(e) })
    return { events, result }
  } catch (error) {
    return { events, error }
  }
}

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) freeze(v)
  }
  return value
}

// Fold a recording the way `usePipeline` does. Every state is frozen first: a reducer that
// mutated its input would throw here.
const fold = (recording: Recording, input = 'go'): PipelineUiState[] => {
  const actions: PipelineAction[] = [
    { type: 'run.start', input },
    ...recording.events.map((event) => ({ type: 'event' as const, event })),
  ]
  if (recording.result) actions.push({ type: 'run.result', result: recording.result })
  if (recording.error) {
    const err = recording.error
    actions.push({
      type: 'run.error',
      error: err instanceof Error ? err.message : String(err),
      nodeId: err instanceof PipelineNodeError ? err.nodeId : undefined,
    })
  }
  const states: PipelineUiState[] = []
  let state = freeze(createInitialPipelineState())
  for (const action of actions) {
    state = freeze(pipelineStateReducer(state, action))
    states.push(state)
  }
  return states
}

const usage = (n: number) => ({ inputTokens: n, outputTokens: n, totalTokens: n * 2 })
const say =
  (texts: Record<string, string> = {}): Runner =>
  async (node, input) => ({
    text: texts[node.id] ?? `${node.id}#${input.visit}`,
    usage: usage(10),
  })
const statuses = (state: PipelineUiState, ids: string[]) =>
  ids.map((id) => pipelineNodeView(state, id).status)

const linear: PipelineDefinition = {
  version: 1,
  name: 'Linear',
  entry: 'a',
  nodes: [{ id: 'a', name: 'A' }, { id: 'b' }, { id: 'c' }],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ],
}

test('linear: nodes light up in order, each waiting between the edge and its start', async () => {
  const recording = await record(linear, say({ c: 'the end' }))
  assert.deepEqual(
    recording.events.map((e) => e.type),
    [
      'pipeline.started',
      'pipeline.node.started',
      'pipeline.node.finished',
      'pipeline.edge',
      'pipeline.node.started',
      'pipeline.node.finished',
      'pipeline.edge',
      'pipeline.node.started',
      'pipeline.node.finished',
      'pipeline.finished',
    ],
    'the sequence the runner emits for a → b → c',
  )
  const states = fold(recording)
  const ids = ['a', 'b', 'c']
  // [run.start, started, a started, a finished, edge a→b, b started, …]
  assert.equal(states[0].status, 'running')
  assert.equal(states[0].input, 'go')
  assert.equal(states[1].name, 'Linear')
  assert.deepEqual(statuses(states[2], ids), ['running', 'idle', 'idle'])
  assert.deepEqual(statuses(states[3], ids), ['done', 'idle', 'idle'])
  assert.deepEqual(statuses(states[4], ids), ['done', 'waiting', 'idle'])
  assert.deepEqual(states[4].lastFired, ['e0'])
  assert.equal(states[4].edges.e0.live, true, 'the edge carries the output until b has used it')
  assert.deepEqual(statuses(states[5], ids), ['done', 'running', 'idle'])
  assert.deepEqual(states[5].nodes.b.from, ['a'])
  assert.equal(states[5].edges.e0.live, true)
  assert.deepEqual(statuses(states[6], ids), ['done', 'done', 'idle'])
  assert.equal(states[6].edges.e0.live, false)
  assert.deepEqual(states[6].lastFired, [], 'cleared when the next node finishes')

  const end = states.at(-1) as PipelineUiState
  assert.equal(end.status, 'done')
  assert.equal(end.text, 'the end')
  assert.equal(end.runs, 3)
  assert.equal(end.stoppedBy, undefined)
  assert.deepEqual(end.usage, usage(30))
  assert.deepEqual(end.nodes.a.usage, usage(10))
  assert.deepEqual(end.nodes.c.outputs, [{ visit: 1, text: 'the end' }])
  assert.deepEqual(
    end.visits.map((v) => [v.nodeId, v.visit, v.status, v.text]),
    [
      ['a', 1, 'done', 'a#1'],
      ['b', 1, 'done', 'b#1'],
      ['c', 1, 'done', 'the end'],
    ],
  )
  assert.deepEqual(end.edges.e1, {
    from: 'b',
    to: 'c',
    fired: true,
    visit: 1,
    count: 1,
    live: false,
  })
})

test('fan-in: two branches run together, and the join waits for both', async () => {
  const definition: PipelineDefinition = {
    version: 1,
    entry: 'start',
    nodes: [{ id: 'start' }, { id: 'fast' }, { id: 'slow' }, { id: 'join' }],
    edges: [
      { id: 'sf', from: 'start', to: 'fast' },
      { id: 'ss', from: 'start', to: 'slow' },
      { id: 'fj', from: 'fast', to: 'join' },
      { id: 'sj', from: 'slow', to: 'join' },
    ],
  }
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const recording = await record(definition, async (node, input) => {
    if (node.id === 'slow') await gate
    // The fast branch has finished and fired its edge before the slow one is let go.
    if (node.id === 'fast') setTimeout(release, 5)
    return { text: `${node.id} got ${input.from.map((f) => f.nodeId).join('+')}` }
  })
  const states = fold(recording)
  const ids = ['start', 'fast', 'slow', 'join']

  const bothRunning = states.find(
    (s) => s.nodes.fast?.status === 'running' && s.nodes.slow?.status === 'running',
  )
  assert.ok(bothRunning, 'the two branches are running at the same time')
  assert.deepEqual(bothRunning.lastFired, ['sf', 'ss'], 'the start fired both of its edges')

  const joinWaits = states.find((s) => s.nodes.join?.status === 'waiting')
  assert.ok(joinWaits, 'the join waits once one branch has reached it')
  assert.deepEqual(statuses(joinWaits, ids), ['done', 'done', 'running', 'waiting'])
  assert.equal(joinWaits.edges.fj.live, true)

  const end = states.at(-1) as PipelineUiState
  assert.deepEqual(statuses(end, ids), ['done', 'done', 'done', 'done'])
  assert.equal(end.nodes.join.visits, 1, 'one visit, with both outputs')
  assert.deepEqual([...end.nodes.join.from].sort(), ['fast', 'slow'])
  assert.equal(end.text, 'join got fast+slow')
  assert.equal(end.runs, 4)
  assert.ok(Object.values(end.edges).every((e) => e.fired && !e.live && e.count === 1))
})

test('a loop stopped by the visit cap: the refused node is skipped, the run ends normally', async () => {
  const definition: PipelineDefinition = {
    version: 1,
    entry: 'writer',
    nodes: [
      { id: 'writer' },
      { id: 'reviewer', routes: [{ label: 'approved' }, { label: 'revise' }] },
      { id: 'publisher' },
    ],
    edges: [
      { id: 'draft', from: 'writer', to: 'reviewer' },
      { id: 'ok', from: 'reviewer', to: 'publisher', when: { kind: 'route', label: 'approved' } },
      { id: 'again', from: 'reviewer', to: 'writer', when: { kind: 'otherwise' } },
    ],
    limits: { maxNodeVisits: 2 },
  }
  // The reviewer never approves.
  const recording = await record(definition, async (node, input) => ({
    text: `${node.id}#${input.visit}`,
    ...(node.id === 'reviewer' ? { route: 'revise' } : {}),
  }))
  assert.equal(recording.events.filter((e) => e.type === 'pipeline.node.skipped').length, 1)
  const states = fold(recording)
  const end = states.at(-1) as PipelineUiState

  assert.equal(end.status, 'done', 'a capped run is a finished run')
  assert.equal(end.stoppedBy, 'maxNodeVisits')
  assert.equal(end.runs, 4)
  assert.equal(end.nodes.writer.status, 'skipped')
  assert.equal(end.nodes.writer.skipped, 'maxNodeVisits')
  assert.equal(end.nodes.writer.visits, 2, 'the visits it did make are kept')
  assert.equal(end.nodes.writer.outputs.length, 2)
  assert.equal(end.nodes.reviewer.status, 'done')
  assert.deepEqual(end.nodes.reviewer.outputs, [
    { visit: 1, text: 'reviewer#1', route: 'revise' },
    { visit: 2, text: 'reviewer#2', route: 'revise' },
  ])
  assert.equal(pipelineNodeView(end, 'publisher').status, 'idle', 'never reached')
  assert.deepEqual(end.edges.ok, {
    from: 'reviewer',
    to: 'publisher',
    fired: false,
    visit: 2,
    count: 0,
    live: false,
  })
  assert.equal(end.edges.again.count, 2, 'the loop edge fired twice')
  assert.equal(end.edges.again.live, false, 'what it carried the second time was dropped')
  assert.equal(end.text, 'reviewer#2')
  assert.deepEqual(
    end.visits.map((v) => `${v.nodeId}#${v.visit}`),
    ['writer#1', 'reviewer#1', 'writer#2', 'reviewer#2'],
  )
  // On its second visit the writer was running again, its first output still there.
  const second = states.find((s) => s.nodes.writer?.status === 'running' && s.runs === 3)
  assert.ok(second)
  assert.equal(second.nodes.writer.outputs.length, 1)
  assert.deepEqual(second.nodes.writer.from, ['reviewer'])
})

test('a failed node fails the run: its error is kept, nothing is left running', async () => {
  const recording = await record(linear, async (node) => {
    if (node.id === 'b') throw new Error('the model said no')
    return { text: node.id }
  })
  assert.ok(recording.error instanceof PipelineNodeError)
  assert.equal(recording.events.at(-1)?.type, 'pipeline.node.failed', 'no pipeline.finished')
  const states = fold(recording)
  const end = states.at(-1) as PipelineUiState
  assert.equal(end.status, 'failed')
  assert.equal(end.error, 'the model said no', "the node's own words, not the wrapper's")
  assert.equal(end.failedNode, 'b')
  assert.deepEqual(statuses(end, ['a', 'b', 'c']), ['done', 'failed', 'idle'])
  assert.equal(end.nodes.b.error, 'the model said no')
  assert.deepEqual(
    end.visits.map((v) => [v.nodeId, v.status, v.error]),
    [
      ['a', 'done', undefined],
      ['b', 'failed', 'the model said no'],
    ],
  )
  assert.ok(Object.values(end.edges).every((e) => !e.live))
  assert.equal(end.text, '')
})

test('a failure while another branch runs: that branch is settled, not left spinning', async () => {
  const definition: PipelineDefinition = {
    version: 1,
    entry: 'start',
    nodes: [{ id: 'start' }, { id: 'bad' }, { id: 'slow' }],
    edges: [
      { from: 'start', to: 'bad' },
      { from: 'start', to: 'slow' },
    ],
  }
  const recording = await record(definition, async (node, _input, ctx) => {
    if (node.id === 'bad') throw new Error('boom')
    if (node.id === 'slow') {
      await new Promise<void>((_, reject) =>
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      )
    }
    return { text: node.id }
  })
  const end = fold(recording).at(-1) as PipelineUiState
  assert.equal(end.status, 'failed')
  assert.deepEqual(statuses(end, ['start', 'bad', 'slow']), ['done', 'failed', 'idle'])
  assert.equal(end.visits.find((v) => v.nodeId === 'slow')?.status, 'stopped')
})

test('an abort: the run is stopped, the node that was running goes back to idle', async () => {
  const abort = new AbortController()
  const recording = await record(
    linear,
    async (node, _input, ctx) => {
      if (node.id === 'b') {
        setTimeout(() => abort.abort(), 0)
        await new Promise<void>((_, reject) =>
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        )
      }
      return { text: node.id, usage: usage(5) }
    },
    abort.signal,
  )
  assert.equal(recording.result?.stoppedBy, 'aborted', 'the browser core resolves an aborted run')
  assert.deepEqual(recording.events.at(-1), {
    type: 'pipeline.finished',
    stoppedBy: 'aborted',
    runs: 2,
  })
  const states = fold(recording)
  const running = states.find((s) => s.nodes.b?.status === 'running')
  assert.ok(running)
  const end = states.at(-1) as PipelineUiState
  assert.equal(end.status, 'stopped')
  assert.equal(end.stoppedBy, 'aborted')
  assert.deepEqual(statuses(end, ['a', 'b', 'c']), ['done', 'idle', 'idle'])
  assert.equal(end.nodes.b.visits, 1)
  assert.deepEqual(
    end.visits.map((v) => [v.nodeId, v.status]),
    [
      ['a', 'done'],
      ['b', 'stopped'],
    ],
  )
  assert.equal(end.runs, 2)
  assert.deepEqual(end.usage, usage(5), 'what the finished node spent')
  assert.ok(Object.values(end.edges).every((e) => !e.live))
})

test("a node's own agent events become one line of activity, and are gone when it finishes", async () => {
  const step = { id: 's1', description: 'Look it up' }
  const recording = await record(
    { version: 1, entry: 'a', nodes: [{ id: 'a' }], edges: [] },
    async (_node, _input, ctx) => {
      ctx.emit({ type: 'run.start', goal: 'go' })
      ctx.emit({ type: 'plan.thought-delta', delta: 'hm' })
      ctx.emit({ type: 'step.start', step, index: 1, total: 2 })
      ctx.emit({ type: 'step.text-delta', step, delta: 'x' })
      ctx.emit({ type: 'step.tool-call', step, name: 'search', input: { q: 'x' } })
      ctx.emit({ type: 'step.tool-result', step, name: 'search', output: 1, ok: true })
      ctx.emit({ type: 'replan.decision', mode: 'finish', reason: 'done' })
      ctx.emit({ type: 'final.text-delta', delta: 'The' })
      ctx.emit({ type: 'final.text-delta', delta: ' answer' })
      ctx.emit({ type: 'final', text: 'The answer' })
      return { text: 'The answer' }
    },
  )
  const states = fold(recording)
  const at = (type: string, nth = 0) => {
    const indexes = recording.events.flatMap((e, i) => (e.type === type ? [i] : []))
    return states[indexes[nth] + 1].nodes.a.activity
  }
  assert.deepEqual(at('run.start'), { phase: 'plan', toolCalls: 0 })
  assert.deepEqual(at('step.start'), {
    phase: 'execute',
    step: 'Look it up',
    stepIndex: 1,
    stepTotal: 2,
    toolCalls: 0,
  })
  assert.equal(at('step.tool-call')?.tool, 'search')
  assert.equal(at('step.tool-call')?.toolCalls, 1)
  assert.equal(at('step.tool-result')?.tool, undefined)
  assert.equal(at('step.tool-result')?.step, 'Look it up', 'back to the step')
  assert.deepEqual(at('replan.decision'), { phase: 'replan', toolCalls: 1 })
  assert.deepEqual(at('final.text-delta'), { phase: 'synthesize', toolCalls: 1 })
  assert.equal((states.at(-1) as PipelineUiState).nodes.a.activity, undefined)

  // A stream of deltas does not make a stream of states: what changes nothing returns the same object.
  const index = (type: string, nth = 0) =>
    recording.events.flatMap((e, i) => (e.type === type ? [i] : []))[nth] + 1
  assert.equal(states[index('plan.thought-delta')], states[index('plan.thought-delta') - 1])
  assert.equal(states[index('step.text-delta')], states[index('step.text-delta') - 1])
  assert.equal(states[index('final.text-delta', 1)], states[index('final.text-delta', 1) - 1])
})

test('the reducer ignores what is not its business, and starts each run clean', () => {
  const start = createInitialPipelineState()
  assert.deepEqual(start, {
    status: 'idle',
    nodes: {},
    edges: {},
    lastFired: [],
    visits: [],
    text: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    runs: 0,
  })
  assert.deepEqual(pipelineNodeView(start, 'anything'), {
    status: 'idle',
    visits: 0,
    from: [],
    outputs: [],
  })
  // An agent event with no node, or for a node that is not running: nothing.
  assert.equal(
    pipelineStateReducer(start, { type: 'event', event: { type: 'final', text: 'x' } }),
    start,
  )
  assert.equal(
    pipelineStateReducer(start, {
      type: 'event',
      event: {
        type: 'step.tool-call',
        step: { id: 's', description: 'd' },
        name: 't',
        input: 1,
        nodeId: 'a',
        visit: 1,
      },
    }),
    start,
  )
  // A definition that could not start: an error, nothing running.
  const refused = pipelineStateReducer(
    pipelineStateReducer(start, { type: 'run.start', input: 'x' }),
    { type: 'run.error', error: 'the pipeline has no entry node' },
  )
  assert.equal(refused.status, 'failed')
  assert.equal(refused.error, 'the pipeline has no entry node')
  assert.equal(refused.failedNode, undefined)
  // The next run does not inherit the last one.
  const again = pipelineStateReducer(refused, { type: 'run.start', input: 'y' })
  assert.equal(again.status, 'running')
  assert.equal(again.error, undefined)
  assert.equal(again.input, 'y')
  assert.deepEqual(pipelineStateReducer(again, { type: 'reset' }), start)
})

test('the same recording always folds to the same state', async () => {
  const recording = await record(linear, say())
  assert.deepEqual(fold(recording).at(-1), fold(recording).at(-1))
})
