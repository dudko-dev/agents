// Pipelines (PIPELINES): the tool's dispatch (defer within the caps), the checks against the
// worker (every refusal), a node's agent config (only what it names, nobody to ask) and the
// session agent's tools.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeferredResult, type IAgentConfig, type PipelineDefinition } from '@dudko.dev/agent'
import { childAskDecision } from '../src/child-ask.ts'
import { withTurnScope, type ITurnScope } from '../src/lease.ts'
import {
  canonicalJson,
  checkPipelines,
  pipelineDispatch,
  pipelineNodeConfig,
  pipelineNote,
  pipelineTools,
  preparedDefinition,
  type IPipelineConfig,
} from '../src/pipelines.ts'
import { sessionAgentConfig } from '../src/subagents.ts'

const scope = (pipelines?: ITurnScope['pipelines']): ITurnScope => ({
  sessionId: 's',
  turn: 1,
  intent: { kind: 'fresh', runId: 'r1', runNo: 1, attemptBase: 0 },
  heartbeat: () => {},
  revoked: () => undefined,
  ...(pipelines ? { pipelines } : {}),
})

test('dispatch defers at once, within the per-round and per-session caps', async () => {
  const dispatch = pipelineDispatch('review')
  await assert.rejects(dispatch(), /can only be called from a turn/)
  const s = scope({ maxPerRound: 2, remaining: 5, dispatched: 0 })
  const first = await withTurnScope(s, () => dispatch())
  assert.equal(isDeferredResult(first), true)
  assert.equal((first as { note?: string }).note, pipelineNote('review'))
  await withTurnScope(s, () => dispatch())
  assert.equal(s.pipelines?.dispatched, 2)
  await assert.rejects(
    withTurnScope(s, () => dispatch()),
    /refused: at most 2 pipeline calls in one round/,
  )
  const last = scope({ maxPerRound: 4, remaining: 1, dispatched: 0 })
  await withTurnScope(last, () => dispatch())
  await assert.rejects(
    withTurnScope(last, () => dispatch()),
    /this session may start no more pipeline calls/,
  )
  // A turn's subagent budget is not a pipeline budget.
  const subagentsOnly: ITurnScope = {
    ...scope(),
    subagents: { maxPerRound: 4, remaining: 4, dispatched: 0 },
  }
  await assert.rejects(
    withTurnScope(subagentsOnly, () => dispatch()),
    /can only be called/,
  )
})

const definition = (extra: Partial<PipelineDefinition> = {}): PipelineDefinition => ({
  version: 1,
  entry: 'a',
  nodes: [
    { id: 'a', instructions: 'Write it.' },
    { id: 'b', tools: ['docs__search', 'lookup'], routes: [{ label: 'ok' }, { label: 'no' }] },
    { id: 'c', mcpServers: ['github'] },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c', when: { kind: 'route', label: 'ok' } },
  ],
  ...extra,
})
const pipeline = (extra: Partial<IPipelineConfig> = {}): IPipelineConfig => ({
  description: 'Review it',
  definition: definition(),
  ...extra,
})

const base = {
  clientName: 't',
  providerType: 'openai',
  apiKey: 'k',
  model: 'big',
  planner: { model: 'planner-model' },
  synthesizer: { model: 'synth-model' },
  systemPrompt: 'worker prompt',
  maxIterations: 10,
  maxStepsPerTask: 8,
  mcpServers: {
    docs: { url: 'https://docs.example/mcp' },
    github: { url: 'https://gh.example/mcp' },
    jira: { url: 'https://jira.example/mcp' },
  },
  tools: { write_note: { description: 'w' } as never, lookup: { description: 'l' } as never },
  subagents: { dynamic: true },
  toolApproval: {
    mode: 'ask-writes',
    rules: { 'github__*': 'deny' },
    onRequest: () => ({ park: true }),
  },
} as unknown as IAgentConfig

test('checks: a valid definition against the worker passes; normalised by the core', () => {
  assert.doesNotThrow(() => checkPipelines({ review: pipeline() }, base, ['researcher']))
  const d = preparedDefinition('review', definition())
  assert.deepEqual(
    d.edges.map((e) => e.id),
    ['e0', 'e1'],
    'every edge has an id',
  )
})

test('checks: every refusal names the pipeline (and the node)', () => {
  const refuses = (
    pipelines: Record<string, IPipelineConfig>,
    pattern: RegExp,
    subagents: string[] = [],
  ) => assert.throws(() => checkPipelines(pipelines, base, subagents), pattern)
  // The name.
  refuses({ 'Bad Name': pipeline() }, /PIPELINES: "Bad Name" must match/)
  refuses({ docs__x: pipeline() }, /must match/)
  refuses({ researcher: pipeline() }, /"researcher" is already a subagent/, ['researcher'])
  refuses({ lookup: pipeline() }, /"lookup" is already a tool of the worker/)
  // The definition: the core's validation, every issue.
  refuses(
    { review: pipeline({ definition: definition({ entry: 'nope' }) }) },
    /PIPELINES\.review\.definition is not a valid pipeline: .*nope/,
  )
  refuses(
    {
      review: pipeline({
        definition: definition({
          version: 2 as never,
          edges: [{ from: 'a', to: 'zzz' }],
        }),
      }),
    },
    /PIPELINES\.review\.definition is not a valid pipeline: .*version.*;.*zzz/s,
  )
  refuses(
    { review: pipeline({ definition: 'x' as never }) },
    /PIPELINES\.review\.definition is not a valid pipeline/,
  )
  // A node: an id that cannot name a workflow / stream / route.
  const withNode = (node: Record<string, unknown>) =>
    pipeline({
      definition: { version: 1, entry: String(node.id), nodes: [node as never], edges: [] },
    })
  refuses({ review: withNode({ id: 'a.b' }) }, /PIPELINES\.review: node "a\.b": its id must match/)
  refuses({ review: withNode({ id: 'a/b' }) }, /its id must match/)
  // What the swarm cannot honour: skills, settings.
  refuses(
    { review: withNode({ id: 'a', skills: ['writing'] }) },
    /PIPELINES\.review: node "a": "skills" are not supported here/,
  )
  refuses(
    { review: withNode({ id: 'a', settings: { temperature: 0 } }) },
    /node "a": "settings" are not supported here/,
  )
  assert.doesNotThrow(() =>
    checkPipelines({ review: withNode({ id: 'a', skills: [], settings: {} }) }, base),
  )
  // What the worker does not have.
  refuses(
    { review: withNode({ id: 'a', tools: ['jira2__x'] }) },
    /node "a": tool "jira2__x" is not a tool of this worker/,
  )
  refuses({ review: withNode({ id: 'a', tools: ['search'] }) }, /tool "search" is not a tool/)
  refuses(
    { review: withNode({ id: 'a', mcpServers: ['slack'] }) },
    /node "a": MCP server "slack" is not one of this worker's/,
  )
  refuses({ review: withNode({ id: 'a', model: '' }) }, /node "a": "model" must be a model id/)
})

test("a node's agent: the node over the worker, only what it names, nobody to ask", () => {
  const d = definition()
  const [a, b, c] = d.nodes as [never, never, never]
  const catalog = [
    { name: 'github__issues', description: '', server: 'github' },
    { name: 'github__prs', description: '', server: 'github' },
    { name: 'docs__search', description: '', server: 'docs' },
    { name: 'docs__fetch', description: '', server: 'docs' },
  ]
  // a: no tools named - no tool at all; the worker's model and stage overrides; the instructions
  // under the worker's prompt.
  const ca = pipelineNodeConfig(base, a, catalog)
  assert.deepEqual(ca.mcpServers, {})
  assert.equal(ca.tools, undefined)
  assert.equal(ca.availableTools, undefined)
  assert.equal(ca.model, 'big')
  assert.deepEqual(ca.planner, { model: 'planner-model' })
  assert.equal(ca.systemPrompt, 'worker prompt\n\nWrite it.')
  assert.equal(ca.subagents, undefined, 'no dynamic subagents of its own')
  assert.deepEqual(ca.toolApproval, { mode: 'ask-writes', rules: { 'github__*': 'deny' } })
  assert.equal(ca.toolApproval?.onRequest, undefined)
  // b: one tool of a server and a native tool - an allowlist of exactly those.
  const cb = pipelineNodeConfig(base, b, catalog)
  assert.deepEqual(Object.keys(cb.mcpServers), ['docs'])
  assert.deepEqual(Object.keys(cb.tools ?? {}), ['lookup'])
  assert.deepEqual(cb.availableTools, ['docs__search', 'lookup'])
  // c: a whole server - every tool of it, live (no allowlist).
  const cc = pipelineNodeConfig(base, c, catalog)
  assert.deepEqual(Object.keys(cc.mcpServers), ['github'])
  assert.equal(cc.availableTools, undefined)
  assert.equal(cc.tools, undefined)
  // A whole server AND one tool of another: an allowlist of that tool and the whole server's
  // tools as the worker found them.
  const mixed = pipelineNodeConfig(
    base,
    { id: 'm', mcpServers: ['github'], tools: ['docs__fetch', 'github__prs'] },
    catalog,
  )
  assert.deepEqual(Object.keys(mixed.mcpServers).sort(), ['docs', 'github'])
  assert.deepEqual(mixed.availableTools, ['docs__fetch', 'github__prs', 'github__issues'])
  // Another model: on the worker's provider; the worker's per-stage overrides go with its model.
  const other = pipelineNodeConfig(base, { id: 'o', model: 'small' })
  assert.equal(other.model, 'small')
  assert.equal(other.providerType, 'openai')
  assert.equal(other.planner, undefined)
  assert.equal(other.synthesizer, undefined)
  // No prompt of the worker: the instructions alone; neither: none.
  const bare = { ...base, systemPrompt: undefined }
  assert.equal(
    pipelineNodeConfig(bare, { id: 'x', instructions: 'Only this.' }).systemPrompt,
    'Only this.',
  )
  assert.equal(pipelineNodeConfig(bare, { id: 'x' }).systemPrompt, undefined)
  // CHILD_ASK=park: the node's ask parks the visit's run (when its workflow waits); 'deny', the
  // default: nobody to ask.
  const parks = pipelineNodeConfig(base, a, catalog, 'park')
  assert.equal(parks.toolApproval?.mode, 'ask-writes')
  assert.equal(parks.toolApproval?.onRequest, childAskDecision)
  assert.equal(pipelineNodeConfig(base, a, catalog, 'deny').toolApproval?.onRequest, undefined)
})

test('the session agent: a pipeline is a tool next to the subagents', () => {
  const tools = pipelineTools({ review: pipeline({ readOnly: true }) })
  assert.deepEqual(Object.keys(tools), ['review'])
  const c = sessionAgentConfig(
    { ...base, toolApproval: undefined },
    { researcher: { description: 'Research it' } },
    { review: pipeline() },
  )
  assert.deepEqual(Object.keys(c.tools ?? {}).sort(), [
    'lookup',
    'researcher',
    'review',
    'write_note',
  ])
  const only = sessionAgentConfig({ ...base, tools: undefined }, {}, { review: pipeline() })
  assert.deepEqual(Object.keys(only.tools ?? {}), ['review'])
})

test('canonicalJson: the same node however its keys were written', () => {
  assert.equal(
    canonicalJson({ id: 'a', routes: [{ label: 'x', description: 'y' }], tools: ['t'] }),
    canonicalJson({ tools: ['t'], routes: [{ description: 'y', label: 'x' }], id: 'a' }),
  )
  assert.notEqual(
    canonicalJson({ id: 'a', tools: ['t', 'u'] }),
    canonicalJson({ id: 'a', tools: ['u', 't'] }),
  )
  assert.notEqual(canonicalJson({ id: 'a' }), canonicalJson({ id: 'a', instructions: 'x' }))
})
