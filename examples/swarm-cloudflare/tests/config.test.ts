// The Worker's configuration from its environment (src/config.ts, src/agent-config.ts, src/env.ts)
// and the ids this platform adds (src/ids.ts).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { childWorkflowIdOf, pipelineNodeWorkflowIdOf, pipelineWorkflowIdOf } from 'swarm-shared'
import { agentSetupFromEnv, PROVIDERS } from '../src/agent-config.ts'
import {
  apiConfig,
  limiterConfig,
  runtimeConfig,
  sessionOptions,
  TOKEN_MIN_CHARS,
} from '../src/config.ts'
import { ConfigError, stringsOf } from '../src/env.ts'
import { INSTANCE_ID, instanceIdOf, runIdOf } from '../src/ids.ts'

const AGENT = {
  AGENT_PROVIDER_TYPE: 'openai-compatible',
  AGENT_BASE_URL: 'http://127.0.0.1:1/v1',
  AGENT_API_KEY: 'not-a-real-key',
  AGENT_MODEL: 'm',
}

test('the API: bearer by default, tokens required and long enough, the rest bounded', () => {
  assert.throws(() => apiConfig({}), /GATEWAY_TOKENS is required/)
  assert.throws(() => apiConfig({ GATEWAY_TOKENS: 'short' }), new RegExp(`${TOKEN_MIN_CHARS}`))
  const c = apiConfig({
    GATEWAY_TOKENS: 'a'.repeat(16) + ', ' + 'b'.repeat(20),
    CORS_ORIGINS: 'https://a, https://b',
  })
  assert.deepEqual(c.auth, { mode: 'bearer', tokens: ['a'.repeat(16), 'b'.repeat(20)] })
  assert.deepEqual(c.corsOrigins, ['https://a', 'https://b'])
  assert.equal(c.sse.maxConnections, 100, 'per session here')
  assert.deepEqual(apiConfig({ GATEWAY_AUTH: 'none' }).auth, { mode: 'none' })
  assert.throws(() => apiConfig({ GATEWAY_AUTH: 'open' }), ConfigError)
  assert.throws(
    () => apiConfig({ GATEWAY_AUTH: 'none', GATEWAY_MAX_BODY_BYTES: '10' }),
    /GATEWAY_MAX_BODY_BYTES/,
  )
})

test('session options: the Temporal swarm names; the heartbeat timeout is the lease TTL here', () => {
  const o = sessionOptions({
    TURN_MAX_ATTEMPTS: '3',
    LEASE_TTL_MS: '5000',
    SUBAGENT_MAX_PER_ROUND: '1',
  })
  assert.equal(o.maxTurnAttempts, 3)
  assert.equal(o.heartbeatTimeoutMs, 5000)
  assert.equal(o.subagentMaxPerRound, 1)
  assert.equal(o.idleTimeoutMs, 86_400_000)
  assert.throws(() => sessionOptions({ TURN_MAX_ATTEMPTS: '0' }), /TURN_MAX_ATTEMPTS/)
  assert.throws(() => sessionOptions({ SUBAGENT_MAX_PER_ROUND: '65' }), /SUBAGENT_MAX_PER_ROUND/)
})

test('the runtime: the lease, the events, the limiter, CHILD_ASK', () => {
  const r = runtimeConfig({})
  assert.equal(r.leaseTtlMs, 15_000)
  assert.equal(r.childAsk, 'park')
  assert.equal(r.limiter, undefined)
  assert.throws(
    () => runtimeConfig({ EVENT_MAX_BYTES: '2000000' }),
    /EVENT_MAX_BYTES/,
    'a row holds 2 MB',
  )
  assert.throws(() => runtimeConfig({ CHILD_ASK: 'maybe' }), /CHILD_ASK/)
  assert.throws(() => limiterConfig({ LIMITER_CAPACITY: '3' }), /LIMITER_REFILL_PER_SECOND/)
  assert.deepEqual(limiterConfig({ LIMITER_REFILL_PER_SECOND: '2' }), {
    refillPerSecond: 2,
    capacity: 2,
    maxWaitMs: 60_000,
    scope: 'global',
  })
})

test('the agent: a model object built here, on one of the bundled providers', () => {
  const s = agentSetupFromEnv(AGENT)
  assert.equal(typeof s.config.model, 'object', 'a model object, not an id')
  assert.equal((s.config.model as { modelId: string }).modelId, 'm')
  assert.equal(s.config.providerType, undefined)
  assert.equal(s.config.apiKey, undefined, 'the key stays in the provider')
  assert.equal((s.modelOf('other') as { modelId: string }).modelId, 'other')
  assert.deepEqual([...PROVIDERS], ['openai', 'anthropic', 'google', 'openai-compatible'])
  for (const p of PROVIDERS) {
    const m = agentSetupFromEnv({ ...AGENT, AGENT_PROVIDER_TYPE: p }).config.model as {
      provider: string
    }
    assert.ok(m.provider, `${p} builds`)
  }
  assert.throws(
    () => agentSetupFromEnv({ ...AGENT, AGENT_PROVIDER_TYPE: 'azure' }),
    /AGENT_PROVIDER_TYPE/,
  )
  assert.throws(() => agentSetupFromEnv({ ...AGENT, AGENT_API_KEY: '' }), /AGENT_API_KEY/)
  assert.throws(() => agentSetupFromEnv({ ...AGENT, AGENT_BASE_URL: '' }), /AGENT_BASE_URL/)
  const staged = agentSetupFromEnv({ ...AGENT, AGENT_PLANNER_MODEL: 'big' }).config
  assert.equal((staged.planner as { modelId: string }).modelId, 'big')
})

test('MCP servers: HTTP only - a stdio one is refused with the reason', () => {
  const ok = agentSetupFromEnv({
    ...AGENT,
    MCP_SERVERS: JSON.stringify({ docs: { url: 'https://mcp.example/mcp', headers: { a: 'b' } } }),
  })
  assert.deepEqual(ok.config.mcpServers, {
    docs: { url: 'https://mcp.example/mcp', headers: { a: 'b' } },
  })
  assert.throws(
    () => agentSetupFromEnv({ ...AGENT, MCP_SERVERS: JSON.stringify({ fs: { command: 'npx' } }) }),
    /stdio servers \("command"\) cannot run on Cloudflare Workers/,
  )
  assert.throws(() => agentSetupFromEnv({ ...AGENT, MCP_SERVERS: '[]' }), /MCP_SERVERS/)
})

test('SUBAGENTS and PIPELINES: checked against the worker as in examples/swarm', () => {
  const s = agentSetupFromEnv({
    ...AGENT,
    MCP_SERVERS: JSON.stringify({ docs: { url: 'https://mcp.example/mcp' } }),
    SUBAGENTS: JSON.stringify({ r: { description: 'd', tools: ['docs__search'], model: 'small' } }),
    PIPELINES: JSON.stringify({
      p: {
        description: 'd',
        definition: { version: 1, entry: 'a', nodes: [{ id: 'a' }], edges: [] },
      },
    }),
  })
  assert.deepEqual(Object.keys(s.subagents), ['r'])
  assert.equal(s.pipelines.p?.definition.entry, 'a')
  assert.throws(
    () =>
      agentSetupFromEnv({
        ...AGENT,
        SUBAGENTS: JSON.stringify({ r: { description: 'd', tools: ['nope'] } }),
      }),
    /not a tool of this worker/,
  )
  assert.throws(
    () =>
      agentSetupFromEnv({
        ...AGENT,
        PIPELINES: JSON.stringify({
          p: {
            description: 'd',
            definition: { version: 1, entry: 'a', nodes: [{ id: 'a.b' }], edges: [] },
          },
        }),
      }),
    /PIPELINES/,
  )
})

test("the env's strings only: bindings are not configuration", () => {
  assert.deepEqual(stringsOf({ A: 'x', SESSION: { get: () => 1 }, N: 3 }), { A: 'x' })
})

test("a run's id is examples/swarm's: the same digest of the same parts", async () => {
  const expected = `run-${createHash('sha256').update('s/item\n1\n2').digest('hex').slice(0, 32)}`
  assert.equal(await runIdOf('s/item', 1, 2), expected)
})

test('instance ids: valid for Workflows (<= 100 of [A-Za-z0-9_-]), one per child, stable', async () => {
  const sid = 'c1a5a2f0-0000-4000-8000-000000000000'
  const run = 'run-0123456789abcdef0123456789abcdef'
  const item = `p_${'a'.repeat(32)}`
  const sub = childWorkflowIdOf(sid, run, item)
  const pipe = pipelineWorkflowIdOf(sid, run, item)
  const node = pipelineNodeWorkflowIdOf(pipe, 'draft', 3)
  assert.ok(sub.length > 100, 'the shared name is too long for an instance id')
  assert.ok(node.includes('.'), 'and a node visit has dots')
  const ids = [
    await instanceIdOf('turn', `turn-${sid}-12`),
    await instanceIdOf('subagent', sub),
    await instanceIdOf('pipeline', pipe),
    await instanceIdOf('node', node),
    await instanceIdOf('node', pipelineNodeWorkflowIdOf(pipe, 'draft', 4)),
  ]
  for (const id of ids) {
    assert.match(id, INSTANCE_ID)
    assert.ok(id.length <= 100)
  }
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(await instanceIdOf('subagent', sub), ids[1], 'stable')
  assert.notEqual(await instanceIdOf('pipeline', sub), ids[1], 'per kind')
})
