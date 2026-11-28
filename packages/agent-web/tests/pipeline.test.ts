import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createPipeline,
  normalizePipeline,
  PIPELINE_LIMITS,
  PipelineNodeError,
  PipelineValidationError,
  preparePipeline,
  renderPipelineNodeInput,
  runPipelineGraph,
  testPipelineCondition,
  validatePipeline,
  type PipelineCondition,
  type PipelineDefinition,
  type PipelineEdge,
  type PipelineNode,
  type PipelineNodeInput,
  type PipelineNodeOutput,
  type PipelineNodeRunner,
  type PipelineResult,
} from '../dist/index.js'

// The graph engine, through `runNode` stubs: no agent, no model. Everything below this line is
// the same in packages/agent and packages/agent-web (only the import above differs).

type Answer =
  string | PipelineNodeOutput | ((input: PipelineNodeInput) => string | PipelineNodeOutput)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const nodes = (...ids: string[]): PipelineNode[] => ids.map((id) => ({ id }))
const edge = (from: string, to: string, when?: PipelineCondition): PipelineEdge => ({
  from,
  to,
  ...(when ? { when } : {}),
})
const graph = (
  entry: string,
  nodeList: PipelineNode[],
  edges: PipelineEdge[],
  limits?: PipelineDefinition['limits'],
): PipelineDefinition => ({
  version: 1,
  entry,
  nodes: nodeList,
  edges,
  ...(limits ? { limits } : {}),
})

// A pipeline whose nodes answer from a table; `calls` records every visit with its input.
const stubbed = (
  definition: PipelineDefinition,
  answers: Record<string, Answer> = {},
  delays: Record<string, number> = {},
) => {
  const calls: { nodeId: string; input: PipelineNodeInput }[] = []
  const events: Record<string, unknown>[] = []
  const pipeline = createPipeline(definition, {
    runNode: async (node, input, ctx) => {
      calls.push({ nodeId: node.id, input })
      if (delays[node.id]) await sleep(delays[node.id])
      if (ctx.signal.aborted) throw new Error('aborted')
      const answer = answers[node.id] ?? `${node.id} output`
      const out = typeof answer === 'function' ? answer(input) : answer
      return typeof out === 'string' ? { text: out } : out
    },
  })
  const run = (input = 'the request', signal?: AbortSignal) =>
    pipeline.run({ input, signal, onEvent: (e) => events.push(e as Record<string, unknown>) })
  return { pipeline, run, calls, events, order: () => calls.map((c) => c.nodeId) }
}

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code)

// ── scheduling ───────────────────────────────────────────────────────────────

test('pipeline: a linear chain passes each output to the next node', async () => {
  const p = stubbed(graph('a', nodes('a', 'b', 'c'), [edge('a', 'b'), edge('b', 'c')]))
  const result = await p.run('do it')

  assert.deepEqual(p.order(), ['a', 'b', 'c'])
  assert.deepEqual(p.calls[0].input, { request: 'do it', from: [], visit: 1 })
  assert.deepEqual(p.calls[1].input, {
    request: 'do it',
    from: [{ nodeId: 'a', text: 'a output' }],
    visit: 1,
  })
  assert.equal(result.text, 'c output')
  assert.equal(result.runs, 3)
  assert.equal(result.stoppedBy, undefined)
  assert.deepEqual(result.outputs.b, [{ visit: 1, text: 'b output' }])
})

test('pipeline: the nodes of a wave run concurrently', async () => {
  const p = stubbed(
    graph('a', nodes('a', 'b', 'c'), [edge('a', 'b'), edge('a', 'c')]),
    {},
    { b: 40, c: 40 },
  )
  await p.run()
  // Read off the order of events, not off the clock: both have started before either finished.
  const seen = p.events
    .filter(
      (e) =>
        (e.nodeId === 'b' || e.nodeId === 'c') && /node\.(started|finished)$/.test(String(e.type)),
    )
    .map((e) => String(e.type).replace('pipeline.node.', ''))
  assert.deepEqual(seen, ['started', 'started', 'finished', 'finished'])
})

// a → b → join, a → c → d → join: the branches have different lengths.
const fanIn = (join?: 'all' | 'any'): PipelineDefinition =>
  graph(
    'a',
    [...nodes('a', 'b', 'c', 'd'), { id: 'join', name: 'Join', ...(join ? { join } : {}) }],
    [edge('a', 'b'), edge('a', 'c'), edge('c', 'd'), edge('b', 'join'), edge('d', 'join')],
  )

test("pipeline: join 'all' (the default) waits for the longer branch and runs once with both", async () => {
  const p = stubbed(fanIn())
  const result = await p.run()

  const joins = p.calls.filter((c) => c.nodeId === 'join')
  assert.equal(joins.length, 1, 'the join ran once')
  assert.deepEqual(
    joins[0].input.from.map((f) => f.nodeId),
    ['b', 'd'],
  )
  assert.equal(result.runs, 5)
  assert.equal(result.text, 'join output')
})

test("pipeline: join 'any' runs the node for every arrival", async () => {
  const p = stubbed(fanIn('any'))
  const result = await p.run()

  const joins = p.calls.filter((c) => c.nodeId === 'join')
  assert.deepEqual(
    joins.map((c) => c.input.from.map((f) => f.nodeId)),
    [['b'], ['d']],
  )
  assert.deepEqual(
    joins.map((c) => c.input.visit),
    [1, 2],
  )
  assert.equal(result.runs, 6)
})

test('pipeline: a cycle of mutual waiting resolves - every waiting node runs', async () => {
  // b and c each lead to the other, so each would wait for the other for ever.
  const p = stubbed(
    graph(
      'a',
      nodes('a', 'b', 'c'),
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'c'), edge('c', 'b')],
      { maxNodeVisits: 1 },
    ),
  )
  const result = await p.run()
  assert.deepEqual(p.order().sort(), ['a', 'b', 'c'])
  assert.equal(result.runs, 3)
  assert.equal(result.stoppedBy, 'maxNodeVisits')
})

// Each wave of a run, as `<node>#<visit>[<the nodes it got outputs from>]`, read off the trace.
const wavesOf = (result: PipelineResult): string[][] => {
  const waves: string[][] = []
  for (const t of result.trace) {
    if (t.type === 'node') (waves[t.wave] ??= []).push(`${t.nodeId}#${t.visit}[${t.from}]`)
  }
  return waves
}

// a → b → join, a → c → d → join, and back: join → a. The join and d reach each other through the
// loop (join → a → c → d), so each waits for the other.
const loopAround = (): PipelineDefinition =>
  graph(
    'a',
    [...nodes('a', 'b', 'c', 'd'), { id: 'join', name: 'Join' }],
    [
      edge('a', 'b'),
      edge('a', 'c'),
      edge('c', 'd'),
      edge('b', 'join'),
      edge('d', 'join'),
      edge('join', 'a'),
    ],
    { maxNodeVisits: 2 },
  )

test("pipeline: in a loop around the fan-out and the fan-in, join 'all' waits for the slower branch on every pass", async () => {
  const p = stubbed(loopAround())
  const result = await p.run()
  // The wait of d for the join goes back through the loop's head (a): it is for the next pass,
  // so d runs and the join goes on waiting for it.
  assert.deepEqual(wavesOf(result), [
    ['a#1[]'],
    ['b#1[a]', 'c#1[a]'],
    ['d#1[c]'],
    ['join#1[b,d]'],
    ['a#2[join]'],
    ['b#2[a]', 'c#2[a]'],
    ['d#2[c]'],
    ['join#2[b,d]'],
  ])
  assert.deepEqual(
    [result.runs, result.stoppedBy, result.text],
    [10, 'maxNodeVisits', 'join output'],
  )
})

test('pipeline: the loop may go back to any node before the fan-out, in any order of the edges', async () => {
  // s → p → a, the fan-out and the fan-in, then join → r → p: back to p, not to the entry.
  const edges = [
    edge('s', 'p'),
    edge('p', 'a'),
    edge('a', 'b'),
    edge('a', 'c'),
    edge('c', 'd'),
    edge('b', 'join'),
    edge('d', 'join'),
    edge('join', 'r'),
    edge('r', 'p'),
  ]
  for (const order of [edges, [...edges].reverse()]) {
    const p = stubbed(
      graph('s', nodes('s', 'p', 'a', 'b', 'c', 'd', 'join', 'r'), order, { maxNodeVisits: 2 }),
    )
    const result = await p.run()
    assert.deepEqual(
      p.calls.filter((c) => c.nodeId === 'join').map((c) => c.input.from.map((f) => f.nodeId)),
      [
        ['b', 'd'],
        ['b', 'd'],
      ],
    )
    assert.deepEqual([result.runs, result.stoppedBy], [15, 'maxNodeVisits'])
  }
})

test('pipeline: only a wait of everybody is decided by the pass - a node after a loop still waits for it to end', async () => {
  // e → a, a ↔ b (the loop), a → x: x waits while b can still reach it (through a), however
  // long the loop goes - b is never stuck waiting, so nothing changes here.
  const p = stubbed(
    graph('e', nodes('e', 'a', 'b', 'x'), [
      edge('e', 'a'),
      edge('a', 'b'),
      edge('b', 'a'),
      edge('a', 'x'),
    ]),
  )
  const result = await p.run()
  assert.deepEqual(
    p.calls.filter((c) => c.nodeId === 'x').map((c) => c.input.from.map((f) => f.nodeId)),
    [['a', 'a', 'a']],
  )
  assert.deepEqual(p.order(), ['e', 'a', 'b', 'a', 'b', 'a', 'b', 'x'])
  assert.equal(result.stoppedBy, 'maxNodeVisits')
})

test('pipeline: a loop back INTO a branch has no head - the join and that branch run together (the known limit)', async () => {
  // a → b → join, a → c → d → join, join → c: the cycle c → d → join → c is entered at c (from a)
  // and at the join (from b), so no wait in it is "the next pass" and everybody runs.
  const p = stubbed(
    graph(
      'a',
      nodes('a', 'b', 'c', 'd', 'join'),
      [
        edge('a', 'b'),
        edge('a', 'c'),
        edge('c', 'd'),
        edge('b', 'join'),
        edge('d', 'join'),
        edge('join', 'c'),
      ],
      { maxNodeVisits: 2 },
    ),
  )
  const result = await p.run()
  assert.deepEqual(wavesOf(result).slice(0, 3), [['a#1[]'], ['b#1[a]'], ['c#1[a]', 'join#1[b]']])
})

test('pipeline: several terminal nodes of the last wave are joined under their names', async () => {
  const p = stubbed(
    graph(
      'a',
      [{ id: 'a' }, { id: 'b', name: 'Summary' }, { id: 'c' }],
      [edge('a', 'b'), edge('a', 'c')],
    ),
  )
  const result = await p.run()
  assert.equal(result.text, '## Summary\n\nb output\n\n## c\n\nc output')
})

// ── conditions ───────────────────────────────────────────────────────────────

const taken = async (when: PipelineCondition, answer: Answer, source?: PipelineNode) => {
  const p = stubbed(graph('a', [source ?? { id: 'a' }, { id: 'b' }], [edge('a', 'b', when)]), {
    a: answer,
  })
  await p.run()
  return p.order().includes('b')
}

test('pipeline: an edge without a condition, and "always", fire', async () => {
  assert.equal(await taken({ kind: 'always' }, 'anything'), true)
  const p = stubbed(graph('a', nodes('a', 'b'), [edge('a', 'b')]))
  await p.run()
  assert.deepEqual(p.order(), ['a', 'b'])
})

test('pipeline: "contains" is a plain substring, case-insensitive unless asked', async () => {
  assert.equal(await taken({ kind: 'contains', text: 'approved' }, 'Status: APPROVED.'), true)
  assert.equal(await taken({ kind: 'contains', text: 'approved' }, 'rejected'), false)
  assert.equal(
    await taken({ kind: 'contains', text: 'approved', caseSensitive: true }, 'APPROVED'),
    false,
  )
  assert.equal(
    await taken({ kind: 'contains', text: 'APPROVED', caseSensitive: true }, 'APPROVED'),
    true,
  )
  // Not a pattern: the dot is a dot.
  assert.equal(await taken({ kind: 'contains', text: 'a.c' }, 'abc'), false)
})

test('pipeline: "matches" tests a pattern with its flags', async () => {
  assert.equal(
    await taken({ kind: 'matches', pattern: '^score: \\d+$', flags: 'm' }, 'x\nscore: 42'),
    true,
  )
  assert.equal(await taken({ kind: 'matches', pattern: '^score: \\d+$' }, 'x\nscore: 42'), false)
  assert.equal(await taken({ kind: 'matches', pattern: 'done', flags: 'i' }, 'DONE'), true)
  assert.equal(await taken({ kind: 'matches', pattern: 'done' }, 'DONE'), false)
})

test('pipeline: "otherwise" fires only when no other edge of the node did', async () => {
  const definition = graph('a', nodes('a', 'yes', 'no'), [
    edge('a', 'yes', { kind: 'contains', text: 'ok' }),
    edge('a', 'no', { kind: 'otherwise' }),
  ])
  const hit = stubbed(definition, { a: 'ok' })
  await hit.run()
  assert.deepEqual(hit.order(), ['a', 'yes'])

  const miss = stubbed(definition, { a: 'nope' })
  await miss.run()
  assert.deepEqual(miss.order(), ['a', 'no'])
})

const routed: PipelineNode = {
  id: 'a',
  routes: [{ label: 'approve' }, { label: 'revise', description: 'needs work' }],
}
const routeGraph = graph(
  'a',
  [routed, ...nodes('ok', 'again', 'fallback')],
  [
    edge('a', 'ok', { kind: 'route', label: 'approve' }),
    edge('a', 'again', { kind: 'route', label: 'revise' }),
    edge('a', 'fallback', { kind: 'otherwise' }),
  ],
)

test('pipeline: a "route" edge fires for the label the node picked', async () => {
  const p = stubbed(routeGraph, { a: { text: 'fine', route: 'approve' } })
  const result = await p.run()
  assert.deepEqual(p.order(), ['a', 'ok'])
  assert.deepEqual(result.outputs.a, [{ visit: 1, text: 'fine', route: 'approve' }])
})

test('pipeline: a label the node does not have is no route', async () => {
  const p = stubbed(routeGraph, { a: { text: 'fine', route: 'ship-it' } })
  const result = await p.run()
  assert.deepEqual(p.order(), ['a', 'fallback'])
  assert.deepEqual(result.outputs.a, [{ visit: 1, text: 'fine' }], 'the unknown label is dropped')
})

test('pipeline: no route at all leaves only the other conditions', async () => {
  const p = stubbed(routeGraph, { a: 'fine' })
  await p.run()
  assert.deepEqual(p.order(), ['a', 'fallback'])
})

// ── loops and caps ───────────────────────────────────────────────────────────

// writer → reviewer; the reviewer sends it back until it approves.
const reviewLoop = (limits?: PipelineDefinition['limits']): PipelineDefinition =>
  graph(
    'writer',
    nodes('writer', 'reviewer', 'publisher'),
    [
      edge('writer', 'reviewer'),
      edge('reviewer', 'publisher', { kind: 'contains', text: 'APPROVED' }),
      edge('reviewer', 'writer', { kind: 'otherwise' }),
    ],
    limits,
  )

test('pipeline: a review loop ends when the condition is met', async () => {
  const p = stubbed(reviewLoop(), {
    writer: (input) => `draft ${input.visit}`,
    reviewer: (input) => (input.from[0].text === 'draft 2' ? 'APPROVED' : 'more detail please'),
  })
  const result = await p.run()

  assert.deepEqual(p.order(), ['writer', 'reviewer', 'writer', 'reviewer', 'publisher'])
  assert.equal(result.runs, 5)
  assert.equal(result.stoppedBy, undefined)
  assert.equal(result.text, 'publisher output')
  // The second visit of the writer got the review.
  assert.deepEqual(p.calls[2].input, {
    request: 'the request',
    from: [{ nodeId: 'reviewer', text: 'more detail please' }],
    visit: 2,
  })
})

test('pipeline: a loop that never ends is stopped by maxNodeVisits (default 3)', async () => {
  const p = stubbed(reviewLoop(), { reviewer: 'no' })
  const result = await p.run()

  assert.equal(PIPELINE_LIMITS.maxNodeVisits, 3)
  assert.equal(result.runs, 6, 'writer and reviewer three times each')
  assert.equal(result.stoppedBy, 'maxNodeVisits')
  assert.equal(result.outputs.writer.length, 3)
  assert.equal(result.outputs.reviewer.length, 3)
  assert.equal(result.text, 'no', 'the run ends with what it has: the last review')
  assert.deepEqual(result.trace.at(-1), {
    type: 'dropped',
    nodeId: 'writer',
    from: ['reviewer'],
    reason: 'maxNodeVisits',
  })
})

test('pipeline: an activation a cap drops is reported as pipeline.node.skipped', async () => {
  const byVisits = stubbed(reviewLoop({ maxNodeVisits: 1 }), { reviewer: 'no' })
  await byVisits.run()
  // The edge fired, the node did not start: a UI is told both, in that order.
  assert.deepEqual(byVisits.events.slice(-3), [
    { type: 'pipeline.edge', from: 'reviewer', to: 'writer', edgeId: 'e2', visit: 1, fired: true },
    {
      type: 'pipeline.node.skipped',
      nodeId: 'writer',
      from: ['reviewer'],
      reason: 'maxNodeVisits',
    },
    { type: 'pipeline.finished', stoppedBy: 'maxNodeVisits', runs: 2 },
  ])

  const byRuns = stubbed(reviewLoop({ maxRuns: 3, maxNodeVisits: 50 }), { reviewer: 'no' })
  await byRuns.run()
  assert.deepEqual(
    byRuns.events.filter((e) => e.type === 'pipeline.node.skipped'),
    [{ type: 'pipeline.node.skipped', nodeId: 'reviewer', from: ['writer'], reason: 'maxRuns' }],
  )

  const none = stubbed(reviewLoop(), { reviewer: 'APPROVED' })
  await none.run()
  assert.ok(!none.events.some((e) => e.type === 'pipeline.node.skipped'))
})

test('pipeline: every edge has an id (its own, or e<position>) and events carry it with the source visit', async () => {
  const definition = graph('writer', nodes('writer', 'reviewer'), [
    edge('writer', 'reviewer'),
    { id: 'back', from: 'reviewer', to: 'writer' },
    edge('reviewer', 'reviewer', { kind: 'contains', text: 'never' }),
  ])
  const p = stubbed({ ...definition, limits: { maxNodeVisits: 2 } })
  assert.deepEqual(
    p.pipeline.definition.edges.map((e) => e.id),
    ['e0', 'back', 'e2'],
    'the definition the pipeline hands back is the normalised one',
  )
  assert.equal(definition.edges[0].id, undefined, 'the original is not touched')
  assert.deepEqual(
    normalizePipeline(definition).edges.map((e) => e.id),
    ['e0', 'back', 'e2'],
  )

  await p.run()
  assert.deepEqual(
    p.events
      .filter((e) => e.type === 'pipeline.edge')
      .map((e) => `${e.edgeId}#${e.visit}:${e.fired}`),
    ['e0#1:true', 'back#1:true', 'e2#1:false', 'e0#2:true', 'back#2:true', 'e2#2:false'],
  )
})

test('pipeline: maxNodeVisits from the definition is the exact bound', async () => {
  const p = stubbed(reviewLoop({ maxNodeVisits: 1 }), { reviewer: 'no' })
  const result = await p.run()
  assert.equal(result.runs, 2)
  assert.equal(result.stoppedBy, 'maxNodeVisits')
})

test('pipeline: maxRuns stops the whole pipeline at exactly that many runs', async () => {
  const p = stubbed(reviewLoop({ maxRuns: 5, maxNodeVisits: 50 }), { reviewer: 'no' })
  const result = await p.run()
  assert.equal(result.runs, 5)
  assert.equal(p.calls.length, 5)
  assert.equal(result.stoppedBy, 'maxRuns')
})

test('pipeline: the default maxRuns is 25', async () => {
  const p = stubbed(reviewLoop({ maxNodeVisits: 100 }), { reviewer: 'no' })
  const result = await p.run()
  assert.equal(PIPELINE_LIMITS.maxRuns, 25)
  assert.equal(result.runs, 25)
  assert.equal(result.stoppedBy, 'maxRuns')
})

// ── failure and abort ────────────────────────────────────────────────────────

test('pipeline: a node that throws rejects the run, names the node and aborts its siblings', async () => {
  let siblingSignal: AbortSignal | undefined
  let siblingFinished = false
  const events: Record<string, unknown>[] = []
  const pipeline = createPipeline(
    graph('a', nodes('a', 'bad', 'slow', 'after'), [
      edge('a', 'bad'),
      edge('a', 'slow'),
      edge('slow', 'after'),
    ]),
    {
      runNode: async (node, _input, ctx) => {
        if (node.id === 'bad') {
          await sleep(5)
          throw new Error('boom')
        }
        if (node.id === 'slow') {
          siblingSignal = ctx.signal
          await sleep(40)
          siblingFinished = true
        }
        return { text: node.id }
      },
    },
  )
  await assert.rejects(
    pipeline.run({ input: 'x', onEvent: (e) => events.push(e as Record<string, unknown>) }),
    (err: unknown) => {
      assert.ok(err instanceof PipelineNodeError)
      assert.equal(err.nodeId, 'bad')
      assert.equal(err.visit, 1)
      assert.match(err.message, /node "bad" failed.*boom/)
      return true
    },
  )
  assert.equal(siblingSignal?.aborted, true, 'the sibling was told to stop')
  assert.equal(siblingFinished, false, 'the run did not wait for it')
  await sleep(60)
  const types = events.map((e) => e.type)
  assert.ok(types.includes('pipeline.node.failed'))
  assert.equal(types.at(-1), 'pipeline.node.failed', 'nothing is reported after the failure')
  assert.ok(!events.some((e) => e.nodeId === 'after'), 'the sibling did not go on')
})

// ── usage, events, trace ─────────────────────────────────────────────────────

test('pipeline: usage is summed over every node run', async () => {
  const usage = (n: number) => ({ inputTokens: n, outputTokens: 1, totalTokens: n + 1 })
  const p = stubbed(graph('a', nodes('a', 'b', 'c'), [edge('a', 'b'), edge('b', 'c')]), {
    a: { text: 'a', usage: usage(10) },
    b: { text: 'b', usage: { ...usage(20), reasoningTokens: 4 } },
    c: 'no usage reported',
  })
  const result = await p.run()
  assert.deepEqual(result.usage, {
    inputTokens: 30,
    outputTokens: 2,
    totalTokens: 32,
    reasoningTokens: 4,
  })
})

test('pipeline: events come in order and carry what a UI needs', async () => {
  const p = stubbed(
    {
      ...graph('a', nodes('a', 'b', 'c'), [
        { id: 'e1', from: 'a', to: 'b', when: { kind: 'contains', text: 'go' } },
        { id: 'e2', from: 'a', to: 'c', when: { kind: 'otherwise' } },
      ]),
      name: 'demo',
    },
    { a: { text: 'go', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
  )
  await p.run()

  assert.deepEqual(p.events, [
    { type: 'pipeline.started', pipeline: 'demo' },
    { type: 'pipeline.node.started', nodeId: 'a', visit: 1, from: [] },
    {
      type: 'pipeline.node.finished',
      nodeId: 'a',
      visit: 1,
      text: 'go',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
    { type: 'pipeline.edge', from: 'a', to: 'b', edgeId: 'e1', visit: 1, fired: true },
    { type: 'pipeline.edge', from: 'a', to: 'c', edgeId: 'e2', visit: 1, fired: false },
    { type: 'pipeline.node.started', nodeId: 'b', visit: 1, from: ['a'] },
    { type: 'pipeline.node.finished', nodeId: 'b', visit: 1, text: 'b output' },
    { type: 'pipeline.finished', runs: 2 },
  ])
})

test('pipeline: a node event is forwarded with nodeId and visit', async () => {
  const events: Record<string, unknown>[] = []
  const pipeline = createPipeline(graph('a', nodes('a'), []), {
    runNode: async (_node, _input, ctx) => {
      ctx.emit({ type: 'final', text: 'inner' } as never)
      return { text: 'done' }
    },
  })
  await pipeline.run({ input: 'x', onEvent: (e) => events.push(e as Record<string, unknown>) })
  assert.deepEqual(events[2], { type: 'final', text: 'inner', nodeId: 'a', visit: 1 })
})

test('pipeline: an event handler that throws does not break the run', async () => {
  const pipeline = createPipeline(graph('a', nodes('a'), []), {
    runNode: async () => ({ text: 'done' }),
  })
  const result = await pipeline.run({
    input: 'x',
    onEvent: () => {
      throw new Error('bad handler')
    },
  })
  assert.equal(result.text, 'done')
})

test('pipeline: the trace lists runs and edge decisions in order', async () => {
  const p = stubbed(graph('a', nodes('a', 'b'), [edge('a', 'b')]))
  const result = await p.run()
  assert.deepEqual(result.trace, [
    { type: 'node', nodeId: 'a', visit: 1, wave: 0, from: [], text: 'a output' },
    { type: 'edge', from: 'a', to: 'b', edgeId: 'e0', visit: 1, fired: true },
    { type: 'node', nodeId: 'b', visit: 1, wave: 1, from: ['a'], text: 'b output' },
  ])
})

test('pipeline: the definition is copied - editing the original changes nothing', async () => {
  const definition = graph('a', nodes('a', 'b'), [edge('a', 'b')])
  const p = stubbed(definition)
  definition.edges.length = 0
  definition.entry = 'b'
  await p.run()
  assert.deepEqual(p.order(), ['a', 'b'])
  assert.equal(p.pipeline.definition.entry, 'a')
})

test('pipeline: the node input reads as plain text', () => {
  assert.equal(
    renderPipelineNodeInput({ request: 'Write a poem', from: [], visit: 1 }),
    'Write a poem',
  )
  assert.equal(
    renderPipelineNodeInput({
      request: 'Write a poem',
      from: [
        { nodeId: 'w', name: 'Writer', text: 'Roses' },
        { nodeId: 'r', text: 'Too short' },
      ],
      visit: 2,
    }),
    [
      'Request:\nWrite a poem',
      'Output of "Writer":\nRoses',
      'Output of "r":\nToo short',
      '(This is visit 2 of this step.)',
    ].join('\n\n'),
  )
})

// ── the scheduler, with a runner of your own ─────────────────────────────────

// plan → a, b; b → b2; a, b2 → join (all); join → review; review routes: approve → done,
// revise → fix → review (the loop, under maxNodeVisits: 2).
const hostGraph = (): PipelineDefinition =>
  graph(
    'plan',
    [
      ...nodes('plan', 'a', 'b', 'b2', 'join'),
      { id: 'review', routes: [{ label: 'approve' }, { label: 'revise' }] },
      ...nodes('fix', 'done'),
    ],
    [
      edge('plan', 'a'),
      edge('plan', 'b'),
      edge('a', 'join'),
      edge('b', 'b2'),
      edge('b2', 'join'),
      edge('join', 'review'),
      edge('review', 'done', { kind: 'route', label: 'approve' }),
      edge('review', 'fix', { kind: 'route', label: 'revise' }),
      edge('fix', 'review'),
    ],
    { maxNodeVisits: 2 },
  )

// A host's runner: it answers by node and visit (the route is ITS answer, not a model's) and
// logs when each visit starts and ends. No timer: a visit ends after one microtask turn.
const hostRunner = (route: (visit: number) => string | undefined) => {
  const log: string[] = []
  const runNode: PipelineNodeRunner = async (node, input) => {
    log.push(`start ${node.id}#${input.visit}`)
    await null
    log.push(`end ${node.id}#${input.visit}`)
    const picked = node.id === 'review' ? route(input.visit) : undefined
    return { text: `${node.id} ${input.visit}`, ...(picked ? { route: picked } : {}) }
  }
  return { runNode, log, calls: () => log.filter((l) => l.startsWith('start ')) }
}

test('runPipelineGraph: a runner of your own drives waves, a join, routes and a loop under its caps', async () => {
  const host = hostRunner(() => 'revise')
  const events: Record<string, unknown>[] = []
  const result = await runPipelineGraph(preparePipeline(hostGraph()), host.runNode, {
    input: 'the request',
    onEvent: (e) => events.push(e as Record<string, unknown>),
  })

  assert.deepEqual(host.calls(), [
    'start plan#1',
    'start a#1',
    'start b#1',
    'start b2#1',
    'start join#1',
    'start review#1',
    'start fix#1',
    'start review#2',
    'start fix#2',
  ])
  // A wave's visits all start before any is awaited.
  assert.deepEqual(host.log.slice(2, 6), ['start a#1', 'start b#1', 'end a#1', 'end b#1'])
  const waves = Object.fromEntries(
    result.trace.flatMap((t) => (t.type === 'node' ? [[`${t.nodeId}#${t.visit}`, t.wave]] : [])),
  )
  assert.deepEqual(waves, {
    'plan#1': 0,
    'a#1': 1,
    'b#1': 1,
    'b2#1': 2,
    'join#1': 3,
    'review#1': 4,
    'fix#1': 5,
    'review#2': 6,
    'fix#2': 7,
  })
  // The join waited for the longer branch and got both outputs in one visit.
  const join = result.trace.find((t) => t.type === 'node' && t.nodeId === 'join')
  assert.deepEqual(join?.type === 'node' && join.from, ['a', 'b2'])
  // The route the runner gave is the route: 'revise' every time, so the loop hit its cap.
  assert.deepEqual(result.outputs.review, [
    { visit: 1, text: 'review 1', route: 'revise' },
    { visit: 2, text: 'review 2', route: 'revise' },
  ])
  assert.deepEqual(events.at(-2), {
    type: 'pipeline.node.skipped',
    nodeId: 'review',
    from: ['fix'],
    reason: 'maxNodeVisits',
  })
  assert.equal(result.stoppedBy, 'maxNodeVisits')
  assert.equal(result.runs, 9)
  assert.equal(result.text, 'fix 2')

  // Another answer, another run: approved on the second visit.
  const approving = hostRunner((visit) => (visit === 2 ? 'approve' : 'revise'))
  const approved = await runPipelineGraph(preparePipeline(hostGraph()), approving.runNode, {
    input: 'the request',
  })
  assert.equal(approved.stoppedBy, undefined)
  assert.equal(approved.text, 'done 1')
  assert.deepEqual(approving.calls().slice(-2), ['start review#2', 'start done#1'])

  // A label the node does not have is no route: the review is where the run ends.
  const unknown = hostRunner(() => 'ship-it')
  const unrouted = await runPipelineGraph(preparePipeline(hostGraph()), unknown.runNode, {
    input: 'the request',
  })
  assert.deepEqual(unrouted.outputs.review, [{ visit: 1, text: 'review 1' }])
  assert.equal(unrouted.text, 'review 1')
})

test('runPipelineGraph: maxRuns bounds what the runner is asked, and the runner is never called past it', async () => {
  const host = hostRunner(() => 'revise')
  const definition = { ...hostGraph(), limits: { maxNodeVisits: 50, maxRuns: 4 } }
  const result = await runPipelineGraph(preparePipeline(definition), host.runNode, {
    input: 'x',
  })
  assert.equal(host.calls().length, 4)
  assert.equal(result.runs, 4)
  assert.equal(result.stoppedBy, 'maxRuns')
})

test('runPipelineGraph: createPipeline is built on it - the same runner gives the same run', async () => {
  const viaScheduler: unknown[] = []
  const viaPipeline: unknown[] = []
  const a = await runPipelineGraph(
    preparePipeline(hostGraph()),
    hostRunner(() => 'revise').runNode,
    {
      input: 'the request',
      onEvent: (e) => viaScheduler.push(e),
    },
  )
  const b = await createPipeline(hostGraph(), { runNode: hostRunner(() => 'revise').runNode }).run({
    input: 'the request',
    onEvent: (e) => viaPipeline.push(e),
  })
  assert.deepEqual(b, a)
  assert.deepEqual(viaPipeline, viaScheduler)
})

test('preparePipeline: validates, copies and fills in the defaults', () => {
  const definition = graph('a', nodes('a', 'b'), [edge('a', 'b')])
  const plan = preparePipeline(definition)
  assert.deepEqual(
    plan.definition.edges.map((e) => e.id),
    ['e0'],
  )
  assert.equal(definition.edges[0].id, undefined, 'the original is not touched')
  assert.equal(plan.maxNodeVisits, PIPELINE_LIMITS.maxNodeVisits)
  assert.equal(plan.maxRuns, PIPELINE_LIMITS.maxRuns)
  assert.deepEqual(
    preparePipeline(definition).definition,
    plan.definition,
    'the same definition, the same plan',
  )
  assert.throws(
    () => preparePipeline({ ...definition, entry: 'nowhere' }),
    (err: unknown) => err instanceof PipelineValidationError && err.errors[0].code === 'entry',
  )
})

test('runPipelineGraph: an abort settles the run at once - rejects by default, resolves with onAbort "resolve"', async () => {
  const definition = graph('a', nodes('a', 'b', 'c', 'after'), [
    edge('a', 'b'),
    edge('a', 'c'),
    edge('c', 'after'),
  ])
  const started = (onAbort?: 'reject' | 'resolve') => {
    const controller = new AbortController()
    const seen: string[] = []
    const events: Record<string, unknown>[] = []
    const run = runPipelineGraph(
      preparePipeline(definition),
      async (node, _input, ctx) => {
        if (node.id === 'a') return { text: 'a output' }
        ctx.signal.addEventListener('abort', () => seen.push(`${node.id} saw the abort`))
        if (node.id === 'b') {
          // Once every visit of the wave has started.
          await null
          controller.abort()
          // Never settles: the run must not wait for it.
          return new Promise<PipelineNodeOutput>(() => {})
        }
        return { text: `${node.id} output` }
      },
      {
        input: 'x',
        signal: controller.signal,
        onEvent: (e) => events.push(e as Record<string, unknown>),
        ...(onAbort ? { onAbort } : {}),
      },
    )
    return { run, seen, events }
  }

  const rejecting = started()
  await assert.rejects(rejecting.run, { name: 'AbortError', message: 'Aborted' })
  assert.deepEqual(rejecting.seen, ['b saw the abort', 'c saw the abort'])
  assert.deepEqual(rejecting.events.at(-1), {
    type: 'pipeline.finished',
    stoppedBy: 'aborted',
    runs: 3,
  })
  assert.ok(!rejecting.events.some((e) => e.nodeId === 'after'), 'nothing started after it')

  const resolving = started('resolve')
  const result = await resolving.run
  assert.equal(result.stoppedBy, 'aborted')
  assert.equal(result.runs, 3)
  assert.deepEqual(Object.keys(result.outputs), ['a'], 'what finished before the abort')

  // Aborted before it starts: the runner is never called.
  let called = false
  const never = await runPipelineGraph(
    preparePipeline(definition),
    async () => {
      called = true
      return { text: '' }
    },
    { input: 'x', signal: AbortSignal.abort(), onAbort: 'resolve' },
  )
  assert.equal(called, false)
  assert.equal(never.runs, 0)
  assert.equal(never.stoppedBy, 'aborted')
})

test('runPipelineGraph: a runner that rejects fails the run with a PipelineNodeError, whatever onAbort says', async () => {
  const events: Record<string, unknown>[] = []
  let siblingAborted = false
  await assert.rejects(
    runPipelineGraph(
      preparePipeline(
        graph('a', nodes('a', 'bad', 'slow', 'after'), [
          edge('a', 'bad'),
          edge('a', 'slow'),
          edge('slow', 'after'),
        ]),
      ),
      async (node, _input, ctx) => {
        if (node.id === 'bad') throw new Error('the worker is gone')
        if (node.id === 'slow') {
          await null
          siblingAborted = ctx.signal.aborted
        }
        return { text: node.id }
      },
      { input: 'x', onAbort: 'resolve', onEvent: (e) => events.push(e as Record<string, unknown>) },
    ),
    (err: unknown) =>
      err instanceof PipelineNodeError &&
      err.nodeId === 'bad' &&
      err.visit === 1 &&
      (err.cause as Error).message === 'the worker is gone',
  )
  assert.equal(siblingAborted, true, "the sibling's signal was aborted")
  assert.equal(events.at(-1)?.type, 'pipeline.node.failed')
  assert.ok(!events.some((e) => e.nodeId === 'after'), 'the sibling did not go on')
})

// ── validation ───────────────────────────────────────────────────────────────

const valid = (): PipelineDefinition => graph('a', nodes('a', 'b'), [edge('a', 'b')])
const errorsOf = (change: (d: PipelineDefinition) => void): string[] => {
  const definition = valid()
  change(definition)
  const result = validatePipeline(definition)
  assert.equal(result.ok, result.errors.length === 0)
  return codes(result.errors)
}

test('validatePipeline: a well-formed definition has no errors and no warnings', () => {
  assert.deepEqual(validatePipeline(valid()), { ok: true, errors: [], warnings: [] })
})

test('validatePipeline: errors', () => {
  assert.deepEqual(
    errorsOf((d) => ((d as { version: number }).version = 2)),
    ['version'],
  )
  assert.deepEqual(
    errorsOf((d) => d.nodes.push({ id: 'a' })),
    ['node.duplicate'],
  )
  assert.deepEqual(
    errorsOf((d) => d.nodes.push({ id: '  ' })),
    ['node.id'],
  )
  assert.deepEqual(
    errorsOf((d) => (d.entry = 'nowhere')),
    ['entry'],
  )
  assert.deepEqual(
    errorsOf((d) => (d.entry = '')),
    ['entry'],
  )
  assert.deepEqual(
    errorsOf((d) => d.edges.push(edge('a', 'ghost'))),
    ['edge.to'],
  )
  assert.deepEqual(
    errorsOf((d) => d.edges.push(edge('ghost', 'a'))),
    ['edge.from'],
  )
  assert.deepEqual(
    errorsOf((d) => d.edges.push({ id: 'x', from: 'a', to: 'b' }, { id: 'x', from: 'b', to: 'a' })),
    ['edge.duplicate'],
  )
  // An id that is handed out (`e<position>`) cannot also be given to another edge.
  assert.deepEqual(
    errorsOf((d) => d.edges.push({ id: 'e0', from: 'b', to: 'a' })),
    ['edge.duplicate'],
  )
  assert.deepEqual(
    errorsOf((d) => d.edges.push({ id: ' ', from: 'b', to: 'a' })),
    ['edge.id'],
  )
  assert.deepEqual(
    errorsOf((d) => d.edges.push(edge('a', 'b', { kind: 'sometimes' } as never))),
    ['edge.when'],
  )
  assert.deepEqual(
    errorsOf((d) => d.edges.push(edge('a', 'b', { kind: 'contains', text: '' }))),
    ['edge.when'],
  )
  // A route edge needs the label among the source node's routes.
  assert.deepEqual(
    errorsOf((d) => d.edges.push(edge('a', 'b', { kind: 'route', label: 'x' }))),
    ['edge.route'],
  )
  assert.deepEqual(
    errorsOf((d) => {
      d.nodes[0].routes = [{ label: 'y' }]
      d.edges.push(edge('a', 'b', { kind: 'route', label: 'x' }))
    }),
    ['edge.route'],
  )
  assert.deepEqual(
    errorsOf((d) => (d.nodes[0].routes = [{ label: 'y' }, { label: 'y' }])),
    ['node.routes'],
  )
  assert.deepEqual(
    errorsOf((d) =>
      d.edges.push(edge('a', 'b', { kind: 'otherwise' }), edge('a', 'a', { kind: 'otherwise' })),
    ),
    ['edge.otherwise'],
  )
  assert.deepEqual(
    errorsOf((d) => (d.nodes[0].join = 'some' as never)),
    ['node.join'],
  )
  assert.deepEqual(
    errorsOf((d) => (d.nodes = [])),
    ['nodes', 'entry', 'edge.from', 'edge.to'],
  )
  assert.deepEqual(
    validatePipeline(null as never).errors.map((e) => e.code),
    ['definition'],
  )
})

test('validatePipeline: an error says where', () => {
  const definition = valid()
  definition.edges.push({ id: 'e9', from: 'a', to: 'ghost' })
  assert.deepEqual(validatePipeline(definition).errors, [
    {
      code: 'edge.to',
      message: 'edge "e9" leads to an unknown node "ghost"',
      edgeId: 'e9',
      edgeIndex: 1,
    },
  ])
})

test('validatePipeline: limits out of range', () => {
  for (const limits of [
    { maxNodeVisits: 0 },
    { maxNodeVisits: 1.5 },
    { maxNodeVisits: PIPELINE_LIMITS.maxNodeVisitsCeiling + 1 },
    { maxRuns: 0 },
    { maxRuns: -1 },
    { maxRuns: PIPELINE_LIMITS.maxRunsCeiling + 1 },
    { maxRuns: '5' as never },
  ]) {
    assert.deepEqual(
      errorsOf((d) => (d.limits = limits)),
      ['limits'],
      JSON.stringify(limits),
    )
  }
  assert.deepEqual(
    errorsOf(
      (d) =>
        (d.limits = {
          maxNodeVisits: PIPELINE_LIMITS.maxNodeVisitsCeiling,
          maxRuns: PIPELINE_LIMITS.maxRunsCeiling,
        }),
    ),
    [],
  )
})

test('validatePipeline: a bad pattern or flag is an error', () => {
  const pattern = (p: string, flags?: string) =>
    errorsOf((d) => d.edges.push(edge('a', 'b', { kind: 'matches', pattern: p, flags })))
  assert.deepEqual(pattern('(unclosed'), ['edge.pattern'])
  assert.deepEqual(pattern('*'), ['edge.pattern'])
  assert.deepEqual(pattern(''), ['edge.pattern'])
  assert.deepEqual(pattern('a'.repeat(PIPELINE_LIMITS.maxPatternLength + 1)), ['edge.pattern'])
  assert.deepEqual(pattern('a'.repeat(PIPELINE_LIMITS.maxPatternLength)), [])
  // Only i, m, s, u - `g` and `y` keep state, `d` and `v` are not needed.
  for (const flags of ['g', 'y', 'd', 'v', 'ii', 'x']) {
    assert.deepEqual(pattern('a', flags), ['edge.pattern'], flags)
  }
  assert.deepEqual(pattern('a', 'imsu'), [])
  // What needs backtracking is refused, not run.
  assert.deepEqual(pattern('(a)\\1'), ['edge.pattern'])
  assert.deepEqual(pattern('(?=a)b'), ['edge.pattern'])
  assert.deepEqual(pattern('(?<!a)b'), ['edge.pattern'])
  // A repeat that unrolls into a huge program.
  assert.deepEqual(pattern('(a{100}){100}'), ['edge.pattern'])
})

test('validatePipeline: warnings', () => {
  const unreachable = valid()
  unreachable.nodes.push({ id: 'island' })
  assert.deepEqual(validatePipeline(unreachable).warnings, [
    {
      code: 'unreachable',
      message: 'node "island" cannot be reached from the entry node',
      nodeId: 'island',
    },
  ])

  const unusedRoutes = valid()
  unusedRoutes.nodes[0].routes = [{ label: 'x' }]
  assert.deepEqual(codes(validatePipeline(unusedRoutes).warnings), ['routes.unused'])

  const loop = valid()
  loop.edges.push(edge('b', 'a'))
  const result = validatePipeline(loop)
  assert.equal(result.ok, true, 'a loop is allowed')
  assert.deepEqual(codes(result.warnings), ['cycle'])
  assert.match(result.warnings[0].message, /a → b → a/)
})

test('createPipeline: throws on validation errors, with the issues', () => {
  const definition = valid()
  definition.entry = 'nowhere'
  assert.throws(
    () => createPipeline(definition, { runNode: async () => ({ text: '' }) }),
    (err: unknown) => {
      assert.ok(err instanceof PipelineValidationError)
      assert.deepEqual(codes(err.errors), ['entry'])
      return true
    },
  )
  assert.throws(() => createPipeline(valid(), {}), /resolveNode/)
})

// ── conditions: safety ───────────────────────────────────────────────────────

const matches = (pattern: string, text: string, flags?: string): boolean =>
  testPipelineCondition({ kind: 'matches', pattern, flags }, { text })

test('matches: agrees with RegExp on the supported syntax', () => {
  const patterns: [string, string?][] = [
    ['abc'],
    ['^abc$'],
    ['^abc$', 'm'],
    ['a.c'],
    ['a.c', 's'],
    ['colou?r'],
    ['\\bcat\\b'],
    ['\\Bcat'],
    ['[a-c]+z'],
    ['[^a-c\\d]'],
    ['[\\w-]+@[\\w.]+'],
    ['(foo|bar)+baz'],
    ['(?:ab)*c'],
    ['(?<word>ab){2,3}'],
    ['a{2}'],
    ['a{2,}b'],
    ['a{1,2}?b'],
    ['x*?y'],
    ['\\d+\\.\\d+'],
    ['\\s\\S\\W\\D'],
    ['APPROVED', 'i'],
    ['[a-z]+!', 'i'],
    ['straße', 'i'],
    ['\\u0041\\x42\\t'],
    ['\\u{1F600}', 'u'],
    ['^$'],
    ['^\\s*$', 'm'],
    ['a|b|'],
    ['[]'],
    ['[^]'],
    ['a{,2}'],
    ['\\/\\.\\*\\('],
    ['(a*)*b'],
    ['(a|aa)+$'],
  ]
  const texts = [
    '',
    'abc',
    'xabcx',
    'line\nabc\nline',
    'a\nc',
    'color colour',
    'a cat sat',
    'concat',
    'aaabz',
    '7',
    'q',
    'me-you@host.example',
    'foobarbaz',
    'ababc',
    'abababab',
    'aab',
    'xxy',
    'pi is 3.14',
    ' a!1',
    'approved',
    'Hey!',
    'STRASSE STRAßE',
    'AB\t',
    'smile \u{1F600}',
    '\n\n',
    'a{,2}',
    '/.*(',
    'aaaa',
  ]
  for (const [pattern, flags] of patterns) {
    for (const text of texts) {
      assert.equal(
        matches(pattern, text, flags),
        new RegExp(pattern, flags).test(text),
        `/${pattern}/${flags ?? ''} on ${JSON.stringify(text)}`,
      )
    }
  }
})

test('matches: a catastrophic pattern runs in bounded time', () => {
  // Each of these makes a backtracking engine take longer than the universe on this input.
  const input = `${'a'.repeat(PIPELINE_LIMITS.conditionInputChars - 1)}!`
  const started = Date.now()
  assert.equal(matches('(a+)+$', input), false)
  assert.equal(matches('(a|aa)+$', input), false)
  assert.equal(matches('(a*)*b', input), false)
  assert.equal(matches('(.*a){12}b', input), false)
  assert.equal(matches('a*a*a*a*a*a*b', input), false)
  assert.equal(matches('(a?){40}a{40}b', input), false)
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`)
})

test('conditions look at a bounded prefix of the output', () => {
  const limit = PIPELINE_LIMITS.conditionInputChars
  assert.equal(limit, 50_000)
  const inside = `${'x'.repeat(limit - 4)}DONE`
  const outside = `${'x'.repeat(limit - 3)}DONE`
  assert.equal(matches('DONE', inside), true)
  assert.equal(matches('DONE', outside), false, 'past the bound: not looked at')
  assert.equal(testPipelineCondition({ kind: 'contains', text: 'done' }, { text: inside }), true)
  assert.equal(testPipelineCondition({ kind: 'contains', text: 'done' }, { text: outside }), false)
})
