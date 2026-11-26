import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  addEdge,
  addNode,
  autoLayout,
  conditionSummary,
  createInitialPipelineState,
  defaultPipelineLabels,
  emptyPipeline,
  ensureEdgeIds,
  inspectorTitle,
  issueTarget,
  mergePipelineLabels,
  moveNode,
  nextNodePosition,
  parsePipelineJson,
  PipelineEditor,
  PipelineInspector,
  PipelineLabelsProvider,
  PipelineNodeCard,
  PipelineResults,
  pipelineStateReducer,
  pipelineToCode,
  removeEdge,
  removeNode,
  renameNode,
  renameRoute,
  setEntry,
  setLimits,
  setPipelineName,
  slugifyId,
  uniqueEdgeId,
  uniqueNodeId,
  updateEdge,
  updateNode,
  validatePipeline,
  type PipelineController,
  type PipelineDefinition,
  type PipelineUiState,
} from '../dist/pipeline.js'

const html = renderToStaticMarkup

const review: PipelineDefinition = {
  version: 1,
  name: 'Review loop',
  entry: 'writer',
  nodes: [
    { id: 'writer', name: 'Writer', model: 'smart', position: { x: 0, y: 0 } },
    {
      id: 'reviewer',
      name: 'Reviewer',
      skills: ['tone'],
      tools: ['files'],
      mcpServers: ['docs'],
      routes: [{ label: 'approved', description: 'ready' }, { label: 'revise' }],
      position: { x: 320, y: 0 },
    },
    { id: 'publisher', position: { x: 640, y: 0 } },
  ],
  edges: [
    { id: 'e0', from: 'writer', to: 'reviewer' },
    { id: 'e1', from: 'reviewer', to: 'publisher', when: { kind: 'route', label: 'approved' } },
    { id: 'e2', from: 'reviewer', to: 'writer', when: { kind: 'otherwise' } },
  ],
  limits: { maxNodeVisits: 3 },
}
const frozen = JSON.stringify(review)
const valid = (definition: PipelineDefinition) => validatePipeline(definition).errors

// ── Editing helpers ──────────────────────────────────────────────────────────

test('addNode gives a free id, keeps a taken one unique, and makes the first node the entry', () => {
  const one = addNode(review, { name: 'Fact checker' })
  assert.equal(one.nodes.at(-1)?.id, 'fact-checker')
  assert.equal(one.entry, 'writer', 'the entry is not touched')
  const two = addNode(one, { id: 'writer', name: 'Another' })
  assert.equal(two.nodes.at(-1)?.id, 'writer-2')
  assert.equal(addNode(two, { id: 'writer' }).nodes.at(-1)?.id, 'writer-3')
  assert.equal(addNode(review).nodes.at(-1)?.id, 'node')

  const empty: PipelineDefinition = { version: 1, entry: '', nodes: [], edges: [] }
  const first = addNode(empty, { name: 'Agent 1' })
  assert.equal(first.entry, 'agent-1', 'the first node receives the request')
  assert.deepEqual(valid(first), [])
  assert.deepEqual(valid(emptyPipeline()), [])

  assert.equal(uniqueNodeId(review, 'Writer'), 'writer-2')
  assert.equal(uniqueNodeId(review, '  '), 'node')
  assert.equal(slugifyId('Проверка фактов!'), 'проверка-фактов')
  assert.equal(JSON.stringify(review), frozen, 'the original is never changed')
})

test('updateNode patches fields, removes the emptied ones, and says when nothing changed', () => {
  const next = updateNode(review, 'writer', { instructions: 'Write.', model: undefined })
  const writer = next.nodes[0]
  assert.equal(writer.instructions, 'Write.')
  assert.equal('model' in writer, false, 'an emptied field is removed, not left empty')
  const cleared = updateNode(review, 'reviewer', { skills: [], routes: [], name: '' })
  assert.deepEqual(Object.keys(cleared.nodes[1]).sort(), ['id', 'mcpServers', 'position', 'tools'])
  assert.equal(updateNode(review, 'writer', { name: 'Writer' }), review, 'the same object')
  assert.equal(updateNode(review, 'nobody', { name: 'x' }), review)
  assert.deepEqual(moveNode(review, 'writer', { x: 12.4, y: -7.6 }).nodes[0].position, {
    x: 12,
    y: -8,
  })
  assert.equal(moveNode(review, 'writer', { x: 0, y: 0 }), review)
  assert.equal(JSON.stringify(review), frozen)
})

test('removeNode takes its edges with it and moves the entry', () => {
  const next = removeNode(review, 'reviewer')
  assert.deepEqual(
    next.nodes.map((n) => n.id),
    ['writer', 'publisher'],
  )
  assert.deepEqual(next.edges, [], 'every edge touched the reviewer')
  assert.equal(next.entry, 'writer')
  assert.deepEqual(valid(next), [])

  const noEntry = removeNode(review, 'writer')
  assert.equal(noEntry.entry, 'reviewer', 'the entry moves to the first node left')
  assert.deepEqual(
    noEntry.edges.map((e) => e.id),
    ['e1'],
  )
  assert.deepEqual(valid(noEntry), [])
  const last = removeNode(removeNode(noEntry, 'reviewer'), 'publisher')
  assert.equal(last.entry, '')
  assert.deepEqual(last.nodes, [])
  assert.equal(removeNode(review, 'nobody'), review)
})

test('renameNode moves the edges and the entry with the id; a taken or empty id is refused', () => {
  const next = renameNode(review, 'writer', ' author ')
  assert.equal(next.entry, 'author')
  assert.deepEqual(
    next.edges.map((e) => `${e.from}>${e.to}`),
    ['author>reviewer', 'reviewer>publisher', 'reviewer>author'],
  )
  assert.equal(next.nodes[0].name, 'Writer', 'the name is not the id')
  assert.deepEqual(valid(next), [])
  assert.equal(renameNode(review, 'writer', 'reviewer'), review, 'taken')
  assert.equal(renameNode(review, 'writer', '   '), review, 'empty')
  assert.equal(renameNode(review, 'writer', 'writer'), review)
  assert.equal(renameNode(review, 'nobody', 'x'), review)
  assert.equal(setEntry(review, 'publisher').entry, 'publisher')
  assert.equal(setEntry(review, 'nobody'), review)
  assert.equal(setEntry(review, 'writer'), review)
})

test('addEdge connects existing nodes once, with an id that stays unique', () => {
  const next = addEdge(review, { from: 'publisher', to: 'writer' })
  assert.deepEqual(next.edges.at(-1), { id: 'e3', from: 'publisher', to: 'writer' })
  assert.equal(addEdge(next, { from: 'publisher', to: 'writer' }), next, 'the same edge twice')
  assert.equal(
    addEdge(next, { from: 'publisher', to: 'writer', when: { kind: 'always' } }),
    next,
    '`always` is what no condition means',
  )
  const second = addEdge(next, {
    from: 'publisher',
    to: 'writer',
    when: { kind: 'contains', text: 'again' },
  })
  assert.equal(second.edges.length, 5, 'another condition is another edge')
  assert.equal(addEdge(review, { from: 'writer', to: 'nobody' }), review)
  assert.equal(addEdge(review, { from: 'nobody', to: 'writer' }), review)
  assert.equal(
    addEdge(review, { from: 'writer', to: 'publisher', id: 'e1' }).edges.at(-1)?.id,
    'e3',
  )
  assert.equal(
    addEdge(review, { from: 'writer', to: 'publisher', id: 'mine' }).edges.at(-1)?.id,
    'mine',
  )

  // After a removal the positional id of the last edge is free again; the new edge must not
  // collide with an id that is written down.
  const holed = removeEdge(review, 'e1')
  assert.deepEqual(
    holed.edges.map((e) => e.id),
    ['e0', 'e2'],
  )
  assert.equal(uniqueEdgeId(holed), 'e3')
  const refilled = addEdge(holed, { from: 'writer', to: 'publisher' })
  assert.equal(new Set(refilled.edges.map((e) => e.id)).size, 3)
  assert.deepEqual(valid(refilled), [])
})

test('edges written without ids get them written down before the first edit', () => {
  const bare: PipelineDefinition = {
    ...review,
    edges: review.edges.map((e) => {
      const { id, ...rest } = e
      void id
      return rest
    }),
  }
  assert.equal(ensureEdgeIds(review), review, 'nothing to do, the same object')
  assert.deepEqual(
    ensureEdgeIds(bare).edges.map((e) => e.id),
    ['e0', 'e1', 'e2'],
  )
  // Removing the middle one by its positional id keeps the ids of the others.
  const next = removeEdge(bare, 'e1')
  assert.deepEqual(
    next.edges.map((e) => [e.id, e.to]),
    [
      ['e0', 'reviewer'],
      ['e2', 'writer'],
    ],
  )
  assert.equal(removeEdge(bare, 'e9'), bare)
  assert.equal(updateEdge(bare, 'e2', { when: { kind: 'always' } }).edges[2].when, undefined)
})

test('updateEdge changes the condition or the ends; `always` leaves no condition behind', () => {
  const contains = updateEdge(review, 'e0', { when: { kind: 'contains', text: 'DONE' } })
  assert.deepEqual(contains.edges[0].when, { kind: 'contains', text: 'DONE' })
  const always = updateEdge(contains, 'e0', { when: { kind: 'always' } })
  assert.equal('when' in always.edges[0], false)
  assert.equal(updateEdge(review, 'e0', { when: { kind: 'always' } }), review, 'already so')
  assert.equal(updateEdge(review, 'e0', { to: 'publisher' }).edges[0].to, 'publisher')
  assert.deepEqual(
    updateEdge(review, 'e1', { from: 'writer' }).edges[1].when,
    { kind: 'route', label: 'approved' },
    'the condition is kept when only an end changes',
  )
  assert.equal(updateEdge(review, 'e0', { to: 'nobody' }), review)
  assert.equal(updateEdge(review, 'nope', { to: 'writer' }), review)
})

test('renameRoute renames the edges that take the route', () => {
  const next = renameRoute(review, 'reviewer', 'approved', 'ship')
  assert.deepEqual(next.nodes[1].routes, [
    { label: 'ship', description: 'ready' },
    { label: 'revise' },
  ])
  assert.deepEqual(next.edges[1].when, { kind: 'route', label: 'ship' })
  assert.deepEqual(valid(next), [])
  assert.equal(renameRoute(review, 'reviewer', 'approved', 'revise'), review, 'taken')
  assert.equal(renameRoute(review, 'reviewer', 'nope', 'x'), review)
  assert.equal(renameRoute(review, 'writer', 'approved', 'x'), review)
})

test('limits and the name: set, cleared, and no empty object left behind', () => {
  assert.deepEqual(setLimits(review, { maxRuns: 10 }).limits, { maxNodeVisits: 3, maxRuns: 10 })
  const none = setLimits(review, { maxNodeVisits: undefined })
  assert.equal('limits' in none, false)
  assert.equal(setLimits(none, { maxRuns: undefined }), none)
  assert.equal(setLimits(review, { maxNodeVisits: 3 }), review)
  assert.equal(setPipelineName(review, 'Review loop'), review)
  assert.equal(setPipelineName(review, 'Other').name, 'Other')
  assert.equal('name' in setPipelineName(review, ''), false)
})

test('autoLayout places the nodes that have no position, in columns from the entry', () => {
  const bare: PipelineDefinition = {
    version: 1,
    entry: 'plan',
    nodes: [{ id: 'plan' }, { id: 'a' }, { id: 'b' }, { id: 'end' }, { id: 'orphan' }],
    edges: [
      { from: 'plan', to: 'a' },
      { from: 'plan', to: 'b' },
      { from: 'a', to: 'end' },
      { from: 'b', to: 'end' },
      { from: 'end', to: 'plan' },
    ],
  }
  const laid = autoLayout(bare)
  const at = Object.fromEntries(
    laid.nodes.map((n) => [n.id, n.position as { x: number; y: number }]),
  )
  assert.ok(at.plan.x < at.a.x && at.a.x === at.b.x && at.b.x < at.end.x, 'columns by distance')
  assert.ok(at.orphan.x > at.end.x, 'what the entry does not reach goes last')
  assert.notEqual(at.a.y, at.b.y, 'two nodes of a column do not overlap')
  assert.equal(at.plan.y, (at.a.y + at.b.y) / 2, 'a column is centred on the tallest one')
  assert.equal(new Set(laid.nodes.map((n) => `${n.position?.x},${n.position?.y}`)).size, 5)

  assert.equal(autoLayout(review), review, 'everything is placed: the same object')
  const partial = autoLayout({ ...review, nodes: [...review.nodes, { id: 'new' }] })
  assert.deepEqual(partial.nodes[0].position, { x: 0, y: 0 }, 'a placed node stays where it is')
  assert.ok(partial.nodes[3].position)
  assert.notDeepEqual(autoLayout(review, { all: true }).nodes[2].position, undefined)
  assert.deepEqual(nextNodePosition(review), { x: 640, y: 170 })
  assert.deepEqual(nextNodePosition({ ...review, nodes: [] }), { x: 0, y: 0 })
})

test('issueTarget leads from a validation issue to the node or edge it is about', () => {
  const broken: PipelineDefinition = {
    ...review,
    nodes: [...review.nodes, { id: 'island' }],
    edges: [
      ...review.edges,
      { id: 'bad', from: 'reviewer', to: 'publisher', when: { kind: 'route', label: 'nope' } },
    ],
  }
  const { errors } = validatePipeline(broken)
  assert.equal(errors.length, 1)
  assert.deepEqual(issueTarget(errors[0], broken), { kind: 'edge', id: 'bad' })
  const { warnings } = validatePipeline({ ...review, nodes: [...review.nodes, { id: 'island' }] })
  const unreachable = warnings.find((w) => w.code === 'unreachable')
  assert.ok(unreachable)
  assert.deepEqual(issueTarget(unreachable, broken), { kind: 'node', id: 'island' })
  assert.equal(issueTarget({ code: 'entry', message: 'no entry' }, review), null)
  assert.equal(issueTarget({ code: 'x', message: 'x', nodeId: 'gone' }, review), null)
  assert.deepEqual(issueTarget({ code: 'x', message: 'x', edgeIndex: 2 }, review), {
    kind: 'edge',
    id: 'e2',
  })
})

test('parsePipelineJson reads a definition, fills what an editor needs, and refuses the rest', () => {
  const bare = parsePipelineJson(
    JSON.stringify({
      version: 1,
      entry: 'a',
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ from: 'a', to: 'b' }],
    }),
  )
  assert.equal(bare.edges[0].id, 'e0')
  assert.ok(bare.nodes.every((n) => n.position))
  assert.deepEqual(valid(bare), [])
  assert.deepEqual(parsePipelineJson(frozen), review, 'a complete definition comes back as it is')
  // Invalid but well-formed: loaded, for the editor to show what is wrong.
  const wrong = parsePipelineJson('{"version":2,"nodes":[{"id":"a"}],"edges":[]}')
  assert.equal(wrong.entry, '')
  assert.equal(valid(wrong).length, 2)
  assert.throws(() => parsePipelineJson('{not json'), /not JSON/)
  assert.throws(() => parsePipelineJson('[1,2]'), /must be an object/)
  assert.throws(() => parsePipelineJson('{"nodes":[]}'), /`nodes` and `edges`/)
  assert.throws(() => parsePipelineJson('{"nodes":[{"name":"x"}],"edges":[]}'), /needs an `id`/)
  assert.throws(() => parsePipelineJson('{"nodes":[],"edges":[{"from":"a"}]}'), /`from` and `to`/)
})

// ── Copy as code ─────────────────────────────────────────────────────────────

test('pipelineToCode: a browser snippet that names every registry the definition uses', () => {
  const code = pipelineToCode(review)
  assert.match(code, /^import \{ createPipeline, nodeResolver \} from '@dudko\.dev\/agent-web'\n/)
  assert.match(
    code,
    /const definition: PipelineDefinition = \{\n  version: 1,\n  name: 'Review loop',/,
  )
  assert.match(code, /base: \{ model, credentials \}, \/\/ a BrowserAgentConfig/)
  assert.match(code, /models: \{ smart: smartModel \}/)
  assert.match(code, /skills: \{ tone: toneSkill \}/)
  assert.match(code, /tools: \{ files: filesTools \}/)
  assert.match(code, /mcpServers: \{ docs: docsMcp \}/)
  assert.match(code, /when: \{ kind: 'route', label: 'approved' \}/)
  assert.match(code, /limits: \{ maxNodeVisits: 3 \}/)
  assert.match(code, /input: 'Your request',/)
  assert.doesNotMatch(code, /position/, 'positions are an editor matter')
  assert.doesNotMatch(code, /pipeline\.close/)
  assert.match(pipelineToCode(review, { positions: true }), /position: \{ x: 320, y: 0 \}/)
})

test('pipelineToCode: the Node snippet uses the Node package and closes the pipeline', () => {
  const code = pipelineToCode(review, { target: 'node', input: 'It\'s "quoted"\nand long' })
  assert.match(code, /from '@dudko\.dev\/agent'\n/)
  assert.doesNotMatch(code, /agent-web/)
  assert.match(code, /base: config, \/\/ an IAgentConfig/)
  assert.match(code, /await pipeline\.close\(\)/)
  assert.match(code, /input: 'It\\'s "quoted"\\nand long',/)
})

test('pipelineToCode: the definition in the snippet is the definition (it evaluates back)', () => {
  const tricky: PipelineDefinition = {
    version: 1,
    entry: 'first-node',
    nodes: [
      {
        id: 'first-node',
        instructions: "Don't stop.\nLine two \\ backslash `tick` ${notInterpolated}",
        model: 'gpt-4.1 mini',
        tools: ['web search', '2fast'],
        skills: ['a-b', 'a_b', 'a b'],
        settings: { 'max-steps': 3, nested: { ok: true, none: null } },
      },
    ],
    edges: [
      {
        id: 'e0',
        from: 'first-node',
        to: 'first-node',
        when: { kind: 'matches', pattern: "^\\d+'s$", flags: 'i' },
      },
    ],
  }
  const code = pipelineToCode(tricky)
  const literal = code.slice(code.indexOf('= {') + 2, code.indexOf('\n\nconst pipeline'))
  const back = new Function(`return (${literal})`)() as PipelineDefinition
  assert.deepEqual(back, tricky)
  // Names that are not identifiers are quoted as keys and turned into identifiers as values;
  // two names that would make the same identifier get different ones.
  assert.match(code, /models: \{ 'gpt-4\.1 mini': gpt41MiniModel \}/)
  assert.match(code, /tools: \{ 'web search': webSearchTools, '2fast': x2fastTools \}/)
  assert.match(code, /skills: \{ 'a-b': aBSkill, a_b: aBSkill2, 'a b': aBSkill3 \}/)
  // A definition that uses no registry gets none in the snippet.
  const plain = pipelineToCode(emptyPipeline())
  assert.doesNotMatch(plain, /models:|skills:|tools:|mcpServers:/)
})

// ── Labels ───────────────────────────────────────────────────────────────────

test('mergePipelineLabels overrides single labels and merges the nested groups', () => {
  const L = mergePipelineLabels(defaultPipelineLabels, {
    run: 'Запустить',
    nodeStatus: { running: 'работает' },
    canvas: { fit: 'Вписать' },
    conditionKinds: { otherwise: 'иначе' },
  })
  assert.equal(L.run, 'Запустить')
  assert.equal(L.stop, defaultPipelineLabels.stop)
  assert.equal(L.nodeStatus.running, 'работает')
  assert.equal(L.nodeStatus.done, 'done', 'the rest of the group is kept')
  assert.equal(L.canvas.fit, 'Вписать')
  assert.equal(L.canvas.zoomIn, defaultPipelineLabels.canvas.zoomIn)
  assert.equal(L.conditionKinds.route, 'route')
  assert.equal(mergePipelineLabels(defaultPipelineLabels), defaultPipelineLabels)
  assert.equal(defaultPipelineLabels.errors(1), '1 error')
  assert.equal(defaultPipelineLabels.errors(3), '3 errors')
  assert.equal(defaultPipelineLabels.visitTitle('Writer', 1), 'Writer')
  assert.equal(defaultPipelineLabels.visitTitle('Writer', 2), 'Writer · visit 2')
})

test('conditionSummary: what an edge reads as on the canvas', () => {
  const L = defaultPipelineLabels
  assert.equal(conditionSummary(undefined, L), '')
  assert.equal(conditionSummary({ kind: 'always' }, L), '')
  assert.equal(conditionSummary({ kind: 'route', label: 'approved' }, L), 'approved')
  assert.equal(conditionSummary({ kind: 'contains', text: 'DONE' }, L), 'contains “DONE”')
  assert.equal(conditionSummary({ kind: 'matches', pattern: '^ok', flags: 'i' }, L), '/^ok/i')
  assert.equal(conditionSummary({ kind: 'otherwise' }, L), 'otherwise')
})

test('docs/pipeline.md lists every label key (a new label must be documented)', () => {
  const doc = readFileSync(new URL('../docs/pipeline.md', import.meta.url), 'utf8')
  const keys = [...Object.keys(defaultPipelineLabels), ...Object.keys(defaultPipelineLabels.canvas)]
  const missing = keys.filter((k) => !doc.includes(`\`${k}\``))
  assert.deepEqual(missing, [], `label keys missing from docs/pipeline.md: ${missing.join(', ')}`)
})

// ── Components, rendered to markup ───────────────────────────────────────────

const idle = createInitialPipelineState()
const controller = (state: PipelineUiState): PipelineController => ({
  ...state,
  run: async () => undefined,
  stop: () => {},
  isRunning: state.status === 'running',
})
const fold = (state: PipelineUiState, ...events: Parameters<typeof pipelineStateReducer>[1][]) =>
  events.reduce(pipelineStateReducer, state)

test('PipelineEditor draws the graph: cards, routes as ports, conditions on edges, the toolbar', () => {
  const out = html(createElement(PipelineEditor, { value: review, onChange: () => {} }))
  assert.match(out, /class="awr-pipeline"/)
  assert.match(out, /role="toolbar" aria-label="Pipeline tools"/)
  for (const tool of ['add', 'delete', 'zoom-out', 'zoom-in', 'fit', 'import', 'export', 'code']) {
    assert.match(out, new RegExp(`data-tool="${tool}"`), `the ${tool} button`)
  }
  assert.match(out, /aria-label="Pipeline canvas"/)
  assert.match(out, /awr-pnode__name">Writer</)
  assert.match(out, /awr-pnode__entry">entry</)
  assert.match(out, /awr-pnode__model">smart</)
  assert.match(out, /awr-pnode__model awr-pnode__model--default">default model</)
  assert.match(out, /title="1 skill"/)
  assert.match(out, /title="1 tool group"/)
  assert.match(out, /title="1 MCP server"/)
  // The reviewer's routes are labelled output ports; the publisher (no routes) has the default one.
  assert.match(out, /data-awr-port="route:approved"/)
  assert.match(out, /data-awr-port="route:revise"/)
  assert.match(out, /aria-label="Connect Reviewer \(approved\) to another node"/)
  // Conditions are written on the edges and said by a screen reader.
  assert.match(
    out,
    /aria-label="Connection from Reviewer to Publisher: approved"|aria-label="Connection from Reviewer to publisher: approved"/,
  )
  assert.match(out, /aria-label="Connection from Reviewer to Writer: otherwise"/)
  assert.match(out, /entry\. idle\. Connects to: Reviewer\./)
  // Nothing selected: the inspector shows the pipeline. No controller: no run bar.
  assert.match(out, /awr-pipeline__inspector-kind">Pipeline</)
  assert.match(out, /value="Review loop"/)
  assert.match(out, /1 warning/, 'the loop is reported, as a warning')
  assert.doesNotMatch(out, /awr-pipeline__run/)
})

test('PipelineEditor: every part can be hidden, relabelled or replaced', () => {
  const hidden = html(
    createElement(PipelineEditor, {
      value: review,
      onChange: () => {},
      controller: controller(idle),
      showToolbar: false,
      showInspector: false,
      showRunBar: false,
      showResults: false,
    }),
  )
  assert.doesNotMatch(
    hidden,
    /role="toolbar"|awr-pipeline__inspector|awr-pipeline__run|awr-presults/,
  )
  const partial = html(
    createElement(PipelineEditor, {
      value: review,
      onChange: () => {},
      showImport: false,
      showExport: false,
      showCode: false,
      showZoom: false,
      showIssues: false,
      readOnly: true,
    }),
  )
  assert.doesNotMatch(partial, /data-tool="(import|export|code|fit|zoom-in|issues|add|delete)"/)
  assert.doesNotMatch(partial, /Delete node|Add route/, 'read-only: nothing that edits')

  const relabelled = html(
    createElement(
      PipelineLabelsProvider,
      { labels: { addNode: 'Добавить узел', entry: 'вход' } },
      createElement(PipelineEditor, {
        value: review,
        onChange: () => {},
        labels: { fit: 'Вписать', canvas: { canvas: 'Схема' } },
        slots: { toolbarEnd: createElement('i', { id: 'mine' }, 'slot') },
        renderNode: ({ node, card, entry }) =>
          node.id === 'publisher'
            ? createElement('b', { className: 'custom' }, `${node.id}:${entry}`)
            : card,
      }),
    ),
  )
  assert.match(relabelled, /aria-label="Добавить узел"/, 'from the provider')
  assert.match(relabelled, /awr-pnode__entry">вход</)
  assert.match(relabelled, /aria-label="Вписать"/, 'from the prop, on top of the provider')
  assert.match(relabelled, /aria-label="Схема"/)
  assert.match(relabelled, /<i id="mine">slot<\/i>/)
  assert.match(relabelled, /<b class="custom">publisher:false<\/b>/)
  assert.match(relabelled, /awr-pnode__name">Writer</, 'the others keep the card')
})

test('PipelineEditor shows a run: statuses on the cards, fired edges, the results', () => {
  const running = fold(
    idle,
    { type: 'run.start', input: 'A note' },
    { type: 'event', event: { type: 'pipeline.started', pipeline: 'Review loop' } },
    {
      type: 'event',
      event: { type: 'pipeline.node.started', nodeId: 'writer', visit: 1, from: [] },
    },
    {
      type: 'event',
      event: {
        type: 'pipeline.node.finished',
        nodeId: 'writer',
        visit: 1,
        text: 'A draft.',
        usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
      },
    },
    {
      type: 'event',
      event: {
        type: 'pipeline.edge',
        from: 'writer',
        to: 'reviewer',
        edgeId: 'e0',
        visit: 1,
        fired: true,
      },
    },
    {
      type: 'event',
      event: { type: 'pipeline.node.started', nodeId: 'reviewer', visit: 1, from: ['writer'] },
    },
    {
      type: 'event',
      event: {
        type: 'step.tool-call',
        step: { id: 's', description: 'Check' },
        name: 'fs_read',
        input: {},
        nodeId: 'reviewer',
        visit: 1,
      },
    },
  )
  const out = html(
    createElement(PipelineEditor, {
      value: review,
      onChange: () => {},
      controller: controller(running),
      selection: { kind: 'node', id: 'reviewer' },
    }),
  )
  assert.match(out, /data-status="running"/)
  assert.match(out, /awr-pnode awr-pnode--done" data-status="done"/)
  assert.match(out, /awr-pnode awr-pnode--running" data-status="running"/)
  assert.match(out, /awr-pnode__note">tool: fs_read</, 'what the running node is doing')
  assert.match(out, /awr-canvas__edge awr-canvas__edge--active/, 'the edge that fired')
  assert.match(out, /running\. Connects to/, 'said to a screen reader too')
  assert.match(out, /awr-presults__status--running">Running…</)
  assert.match(out, /in 1\.2k · out 300/)
  assert.match(out, /<button type="submit"[^>]*awr-pbtn--stop[^>]*>.*Stop<\/button>/s)
  // The inspector shows the selected node.
  assert.match(out, /awr-pipeline__inspector-kind">Node</)
  assert.match(out, /value="reviewer"/)
  assert.match(out, /aria-label="Remove route approved"/)

  const done = fold(
    running,
    {
      type: 'event',
      event: {
        type: 'pipeline.node.finished',
        nodeId: 'reviewer',
        visit: 1,
        text: 'Fine.',
        route: 'approved',
      },
    },
    { type: 'event', event: { type: 'pipeline.finished', stoppedBy: 'maxNodeVisits', runs: 2 } },
    {
      type: 'run.result',
      result: {
        text: '**Fine.**',
        outputs: {},
        trace: [],
        usage: { inputTokens: 2000, outputTokens: 500, totalTokens: 2500 },
        stoppedBy: 'maxNodeVisits',
        runs: 2,
      },
    },
  )
  const results = html(
    createElement(PipelineResults, {
      state: done,
      definition: review,
      renderContent: (text) => createElement('em', null, text.toUpperCase()),
    }),
  )
  assert.match(results, /awr-presults__status--done">Finished</)
  assert.match(results, /2 node runs/)
  assert.match(results, /A node reached its visit limit/)
  assert.match(results, /<em>\*\*FINE\.\*\*<\/em>/, 'the host renders the text')
  assert.match(results, /awr-pvisit__name">Writer</)
  assert.match(results, /awr-pvisit__route">route: approved</)
  assert.match(results, /from Writer/)
})

test('the inspector edits whatever is selected: a node, a connection, the pipeline', () => {
  const lists = {
    models: [{ id: 'smart', label: 'Smart model' }],
    skills: [{ id: 'tone' }, { id: 'brevity' }],
    tools: [{ id: 'files', label: 'Workspace files' }],
    mcpServers: [],
  }
  const node = html(
    createElement(PipelineInspector, {
      value: review,
      onChange: () => {},
      selection: { kind: 'node', id: 'reviewer' },
      ...lists,
    }),
  )
  assert.match(node, /<option value="smart">Smart model<\/option>/)
  assert.match(
    node,
    /awr-pchip awr-pchip--on"[^>]*><input type="checkbox"[^>]*checked=""[^>]*\/><span>tone</,
  )
  assert.match(node, /<span>brevity</)
  assert.match(node, /<span>Workspace files</)
  assert.match(
    node,
    /docs \(not available\)/,
    'a name the host does not offer can still be unticked',
  )
  assert.match(node, /Make it the entry/)
  assert.match(node, /<option value="any">Run on any of them<\/option>/)

  const entry = html(
    createElement(PipelineInspector, {
      value: review,
      onChange: () => {},
      selection: { kind: 'node', id: 'writer' },
    }),
  )
  assert.match(entry, /This node receives the request\./)
  assert.match(entry, /None available\./)

  const edge = html(
    createElement(PipelineInspector, {
      value: review,
      onChange: () => {},
      selection: { kind: 'edge', id: 'e1' },
    }),
  )
  assert.match(edge, /Reviewer → publisher/)
  assert.match(edge, /<option value="route" selected="">route<\/option>/)
  assert.match(edge, /<option value="approved" selected="">approved<\/option>/)
  assert.match(edge, /When the source node picks this route\./)
  for (const kind of ['always', 'contains', 'matches', 'route', 'otherwise']) {
    assert.match(edge, new RegExp(`<option value="${kind}"`))
  }
  const contains = html(
    createElement(PipelineInspector, {
      value: updateEdge(review, 'e0', {
        when: { kind: 'contains', text: 'DONE', caseSensitive: true },
      }),
      onChange: () => {},
      selection: { kind: 'edge', id: 'e0' },
    }),
  )
  assert.match(contains, /value="DONE"/)
  assert.match(contains, /<input type="checkbox"[^>]*checked=""[^>]*\/><span>Match case</)
  const matches = html(
    createElement(PipelineInspector, {
      value: updateEdge(review, 'e0', { when: { kind: 'matches', pattern: '^ok', flags: 'i' } }),
      onChange: () => {},
      selection: { kind: 'edge', id: 'e0' },
    }),
  )
  assert.match(matches, /value="\^ok"/)
  assert.match(matches, /value="i"/)

  const pipeline = html(
    createElement(PipelineInspector, { value: review, onChange: () => {}, selection: null }),
  )
  assert.match(pipeline, /value="Review loop"/)
  assert.match(pipeline, /<option value="writer" selected="">Writer<\/option>/)
  assert.match(pipeline, /placeholder="default 25"/)
  assert.match(pipeline, /3 nodes, 3 connections/)
  assert.deepEqual(inspectorTitle(review, { kind: 'edge', id: 'e2' }, defaultPipelineLabels), {
    kind: 'Connection',
    name: 'Reviewer → Writer',
  })
  assert.equal(
    inspectorTitle(review, { kind: 'node', id: 'gone' }, defaultPipelineLabels).kind,
    'Pipeline',
  )
})

test('PipelineNodeCard: each status, a failure, a skip, repeated visits', () => {
  const card = (view: Partial<PipelineUiState['nodes'][string]>) =>
    html(
      createElement(PipelineNodeCard, {
        node: review.nodes[0],
        view: { status: 'idle', visits: 0, from: [], outputs: [], ...view },
      }),
    )
  for (const status of ['idle', 'waiting', 'running', 'done', 'failed', 'skipped'] as const) {
    assert.match(card({ status }), new RegExp(`awr-pnode--${status}" data-status="${status}"`))
    assert.match(card({ status }), new RegExp(`title="${status}"`))
  }
  assert.match(card({ status: 'failed', error: 'quota' }), /awr-pnode__note">quota</)
  assert.match(
    card({ status: 'skipped', skipped: 'maxNodeVisits' }),
    /awr-pnode__note">visit limit reached</,
  )
  assert.match(card({ status: 'done', visits: 3 }), /awr-pnode__visits">×3</)
  assert.doesNotMatch(card({ status: 'done', visits: 1 }), /awr-pnode__visits/)
  assert.match(card({ status: 'running' }), /planning…/)
  assert.match(
    card({
      status: 'running',
      activity: { phase: 'execute', step: 'Draft it', stepIndex: 2, stepTotal: 3, toolCalls: 0 },
    }),
    /2\/3 Draft it/,
  )
})
