// Static subagents: the tool's dispatch (defer within the caps), the child agent's config (only
// the profile's tools, nobody to ask) and the session agent's (park on a person's question).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeferredResult, type IAgentConfig } from '@dudko.dev/agent'
import { withTurnScope, type ITurnScope } from '../src/lease.ts'
import {
  checkSubagentProfiles,
  childAgentConfig,
  sessionAgentConfig,
  subagentDispatch,
  subagentNote,
  subagentTools,
} from '../src/subagents.ts'

const scope = (subagents?: ITurnScope['subagents']): ITurnScope => ({
  sessionId: 's',
  turn: 1,
  intent: { kind: 'fresh', runId: 'r1', runNo: 1, attemptBase: 0 },
  heartbeat: () => {},
  revoked: () => undefined,
  ...(subagents ? { subagents } : {}),
})

test('dispatch defers at once, within the per-round and per-session caps', async () => {
  const dispatch = subagentDispatch('researcher')
  await assert.rejects(dispatch(), /can only be called from a turn/)
  const s = scope({ maxPerRound: 2, remaining: 5, dispatched: 0 })
  const first = await withTurnScope(s, () => dispatch())
  assert.equal(isDeferredResult(first), true)
  assert.equal((first as { note?: string }).note, subagentNote('researcher'))
  await withTurnScope(s, () => dispatch())
  assert.equal(s.subagents?.dispatched, 2)
  await assert.rejects(
    withTurnScope(s, () => dispatch()),
    /refused: at most 2 subagent calls in one round/,
  )
  const last = scope({ maxPerRound: 4, remaining: 1, dispatched: 0 })
  await withTurnScope(last, () => dispatch())
  await assert.rejects(
    withTurnScope(last, () => dispatch()),
    /this session may start no more subagent calls/,
  )
  const none = scope({ maxPerRound: 4, remaining: 0, dispatched: 0 })
  await assert.rejects(
    withTurnScope(none, () => dispatch()),
    /no more subagent calls/,
  )
})

const base = {
  clientName: 't',
  providerType: 'openai',
  apiKey: 'k',
  model: 'big',
  systemPrompt: 'parent',
  maxIterations: 10,
  maxStepsPerTask: 8,
  mcpServers: {
    docs: { url: 'https://docs.example/mcp' },
    github: { url: 'https://gh.example/mcp' },
  },
  tools: { write_note: { description: 'w' } as never, lookup: { description: 'l' } as never },
  toolApproval: { mode: 'ask-writes', rules: { 'github__*': 'deny' } },
} as unknown as IAgentConfig

test('the child agent: the profile over the worker, only its tools, nobody to ask', () => {
  const c = childAgentConfig(base, {
    description: 'd',
    model: 'small',
    systemPrompt: 'child',
    tools: ['docs__search', 'lookup'],
    maxIterations: 3,
  })
  assert.equal(c.model, 'small')
  assert.equal(c.systemPrompt, 'child')
  assert.equal(c.maxIterations, 3)
  assert.deepEqual(Object.keys(c.mcpServers), ['docs'], 'only the servers its tools are on')
  assert.deepEqual(Object.keys(c.tools ?? {}), ['lookup'])
  assert.deepEqual(c.availableTools, ['docs__search', 'lookup'])
  assert.deepEqual(c.toolApproval, { mode: 'ask-writes', rules: { 'github__*': 'deny' } })
  assert.equal(c.toolApproval?.onRequest, undefined)
  // Even when the worker's own config has someone to ask, a child does not.
  const asking = childAgentConfig(
    { ...base, toolApproval: { mode: 'ask-all', onRequest: () => ({ park: true }) } },
    { description: 'd' },
  )
  assert.deepEqual(asking.toolApproval, { mode: 'ask-all' })
  // No tools: no server, no native tool - not "every tool".
  const bare = childAgentConfig(base, { description: 'd' })
  assert.deepEqual(bare.mcpServers, {})
  assert.equal(bare.tools, undefined)
  assert.equal(bare.availableTools, undefined)
  assert.equal(bare.model, 'big')
  assert.equal(bare.systemPrompt, 'parent')
})

test('the session agent: the subagent tools and parking on an ask', async () => {
  const profiles = { researcher: { description: 'Research it', readOnly: true } }
  const c = sessionAgentConfig(base, profiles)
  assert.deepEqual(Object.keys(c.tools ?? {}).sort(), ['lookup', 'researcher', 'write_note'])
  assert.equal(c.toolApproval?.mode, 'ask-writes')
  assert.deepEqual(await c.toolApproval?.onRequest?.({} as never, {} as never), { park: true })
  const plain = sessionAgentConfig({ ...base, tools: undefined, toolApproval: undefined }, {})
  assert.equal(plain.tools, undefined)
  assert.deepEqual(await plain.toolApproval?.onRequest?.({} as never, {} as never), { park: true })
  assert.deepEqual(Object.keys(subagentTools(profiles)), ['researcher'])
})

test('profiles are checked against the worker: its tools only, no shadowing', () => {
  assert.doesNotThrow(() =>
    checkSubagentProfiles({ r: { description: 'd', tools: ['docs__x', 'lookup'] } }, base),
  )
  assert.throws(
    () => checkSubagentProfiles({ r: { description: 'd', tools: ['jira__x'] } }, base),
    /not a tool of this worker/,
  )
  assert.throws(
    () => checkSubagentProfiles({ lookup: { description: 'd' } }, base),
    /already a tool of the worker/,
  )
})
