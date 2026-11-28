// Configuration from the environment: defaults, bounds, secrets from files, errors by name.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentConfigFromEnv } from '../src/agent-config.ts'
import {
  gatewayAuth,
  gatewayConfig,
  limiterConfig,
  migrateConfig,
  sessionOptions,
  temporalConfig,
  workerConfig,
} from '../src/config.ts'
import { ConfigError, int, secret } from '../src/env.ts'
import { connectionOptions } from '../src/temporal.ts'

const TOKEN = 'a-token-of-sixteen-plus'
const base = {
  DATABASE_URL: 'postgres://u:p@db/swarm',
  GATEWAY_TOKENS: TOKEN,
  AGENT_API_KEY: 'k',
  AGENT_MODEL: 'gpt-x',
}

test('the gateway: defaults', () => {
  const cfg = gatewayConfig(base)
  assert.equal(cfg.port, 8080)
  assert.equal(cfg.host, '0.0.0.0')
  assert.deepEqual(cfg.auth, { mode: 'bearer', tokens: [TOKEN] })
  assert.deepEqual(cfg.corsOrigins, [])
  assert.equal(cfg.maxBodyBytes, 65_536)
  assert.deepEqual(cfg.temporal, {
    address: 'localhost:7233',
    namespace: 'default',
    taskQueue: 'swarm',
  })
  assert.equal(cfg.session.heartbeatTimeoutMs, 20_000)
  assert.equal(cfg.logLevel, 'info')
})

test('auth: required, long enough, rotatable, off only when asked', () => {
  assert.throws(() => gatewayAuth({}), /GATEWAY_TOKENS/)
  assert.throws(() => gatewayAuth({ GATEWAY_TOKENS: 'short' }), /at least 16/)
  assert.deepEqual(gatewayAuth({ GATEWAY_TOKENS: ` ${TOKEN} , ${TOKEN}2 ,` }), {
    mode: 'bearer',
    tokens: [TOKEN, `${TOKEN}2`],
  })
  assert.deepEqual(gatewayAuth({ GATEWAY_AUTH: 'none' }), { mode: 'none' })
  assert.throws(() => gatewayAuth({ GATEWAY_AUTH: 'basic' }), /bearer \| none/)
})

test('secrets from files: <NAME>_FILE, not both', () => {
  const read = (path: string) => (path === '/run/secrets/token' ? `${TOKEN}\n` : '')
  assert.equal(
    secret({ GATEWAY_TOKENS_FILE: '/run/secrets/token' }, 'GATEWAY_TOKENS', read),
    `${TOKEN}\n`,
  )
  assert.throws(() => secret({ X: 'a', X_FILE: '/f' }, 'X', read), /set X or X_FILE, not both/)
  assert.throws(
    () =>
      secret({ X_FILE: '/missing' }, 'X', () => {
        throw new Error('ENOENT')
      }),
    /X_FILE: cannot read \/missing: ENOENT/,
  )
})

test('numbers are whole and bounded; booleans and choices are checked', () => {
  assert.equal(int({ N: '42' }, 'N', 1), 42)
  assert.equal(int({}, 'N', 7), 7)
  for (const bad of ['4.2', '1e3', 'ten', '-1', '99999999999999999999']) {
    assert.throws(() => int({ N: bad }, 'N', 1), ConfigError, bad)
  }
  assert.throws(
    () => sessionOptions({ TURN_HEARTBEAT_TIMEOUT_MS: '500' }),
    /TURN_HEARTBEAT_TIMEOUT_MS/,
  )
  assert.throws(() => gatewayConfig({ ...base, LOG_LEVEL: 'loud' }), /LOG_LEVEL/)
  assert.throws(() => temporalConfig({ TEMPORAL_TLS: 'maybe' }), /TEMPORAL_TLS must be on \| off/)
})

test('temporal: TLS on with a CA, a client certificate or an API key; mTLS needs both files', () => {
  assert.equal(temporalConfig({}).tls, undefined)
  assert.deepEqual(temporalConfig({ TEMPORAL_TLS: 'on' }).tls, {})
  assert.deepEqual(temporalConfig({ TEMPORAL_API_KEY: 'key' }).tls, {})
  assert.throws(
    () => temporalConfig({ TEMPORAL_TLS_CERT_PATH: '/c' }),
    /TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH go together/,
  )
  const t = temporalConfig({
    TEMPORAL_ADDRESS: 'ns.tmprl.cloud:7233',
    TEMPORAL_TLS_CERT_PATH: '/c',
    TEMPORAL_TLS_KEY_PATH: '/k',
    TEMPORAL_TLS_SERVER_NAME: 'srv',
  })
  const files: Record<string, Uint8Array> = { '/c': Buffer.from('C'), '/k': Buffer.from('K') }
  const opts = connectionOptions(t, (p) => files[p]!)
  assert.deepEqual(opts, {
    address: 'ns.tmprl.cloud:7233',
    tls: { clientCertPair: { crt: files['/c'], key: files['/k'] }, serverNameOverride: 'srv' },
  })
})

test('the worker: defaults, and the limiter only when its rate is set', () => {
  const cfg = workerConfig(base)
  assert.equal(cfg.leaseTtlMs, 15_000)
  assert.equal(cfg.maxConcurrentTurns, 10)
  assert.equal(cfg.shutdownGraceMs, 30_000)
  assert.equal(cfg.limiter, undefined)
  assert.equal(cfg.agent.providerType, 'openai')
  assert.equal(limiterConfig({}), undefined)
  assert.throws(() => limiterConfig({ LIMITER_CAPACITY: '5' }), /LIMITER_REFILL_PER_SECOND is not/)
  assert.deepEqual(limiterConfig({ LIMITER_REFILL_PER_SECOND: '0.5' }), {
    refillPerSecond: 0.5,
    capacity: 1,
    maxWaitMs: 60_000,
    scope: 'global',
  })
  assert.deepEqual(
    limiterConfig({
      LIMITER_REFILL_PER_SECOND: '10',
      LIMITER_CAPACITY: '20',
      LIMITER_MAX_WAIT_MS: '0',
      LIMITER_SCOPE: 'model',
    }),
    { refillPerSecond: 10, capacity: 20, maxWaitMs: 0, scope: 'model' },
  )
  assert.throws(
    () => limiterConfig({ LIMITER_REFILL_PER_SECOND: 'fast' }),
    /LIMITER_REFILL_PER_SECOND/,
  )
})

test('migrate uses MIGRATE_DATABASE_URL when set (a role that may change the schema)', () => {
  assert.equal(migrateConfig(base).url, base.DATABASE_URL)
  assert.equal(
    migrateConfig({ ...base, MIGRATE_DATABASE_URL: 'postgres://owner@db/swarm' }).url,
    'postgres://owner@db/swarm',
  )
  assert.throws(() => migrateConfig({}), /DATABASE_URL/)
})

test('the agent: the CLI names, autopilot by default, installed providers only', () => {
  const a = agentConfigFromEnv({
    AGENT_PROVIDER_TYPE: 'openai-compatible',
    AGENT_BASE_URL: 'http://llm:8000/v1',
    AGENT_API_KEY: 'k',
    AGENT_MODEL: 'm',
    AGENT_PLANNER_MODEL: 'small',
    MCP_SERVERS:
      '{"docs":{"url":"https://mcp.example/mcp","headers":{"x":"y"}},"fs":{"command":"mcp-fs","args":["/data"]}}',
    AGENT_TOOL_RULES: '{"docs__*":"allow"}',
    AGENT_CONTEXT_WINDOW_TOKENS: '32000',
  })
  assert.equal(a.toolApproval?.mode, 'autopilot')
  assert.deepEqual(a.toolApproval?.rules, { 'docs__*': 'allow' })
  assert.deepEqual(a.planner, { model: 'small' })
  assert.deepEqual(a.mcpServers, {
    docs: { url: 'https://mcp.example/mcp', headers: { x: 'y' } },
    fs: { command: 'mcp-fs', args: ['/data'] },
  })
  assert.deepEqual(a.compaction, { auto: true, contextWindowTokens: 32000 })
  assert.equal(a.logLevel, 'warn')
  assert.throws(() => agentConfigFromEnv({ AGENT_API_KEY: 'k' }), /AGENT_MODEL is required/)
  assert.throws(() => agentConfigFromEnv({ AGENT_MODEL: 'm' }), /AGENT_API_KEY/)
  assert.throws(
    () =>
      agentConfigFromEnv({
        AGENT_PROVIDER_TYPE: 'openai-compatible',
        AGENT_API_KEY: 'k',
        AGENT_MODEL: 'm',
      }),
    /AGENT_BASE_URL is required/,
  )
  assert.throws(
    () => agentConfigFromEnv({ AGENT_PROVIDER_TYPE: 'xai', AGENT_API_KEY: 'k', AGENT_MODEL: 'm' }),
    /not installed/,
  )
  assert.throws(
    () => agentConfigFromEnv({ ...base, AGENT_TOOL_APPROVAL: 'yolo' }),
    /AGENT_TOOL_APPROVAL/,
  )
  assert.throws(() => agentConfigFromEnv({ ...base, MCP_SERVERS: '{"x":{}}' }), /needs a "url"/)
  assert.throws(() => agentConfigFromEnv({ ...base, MCP_SERVERS: '[' }), /valid JSON/)
  assert.throws(
    () => agentConfigFromEnv({ ...base, AGENT_TOOL_RULES: '{"x":"maybe"}' }),
    /allow \| ask \| deny/,
  )
})

test('static subagents: SUBAGENTS profiles, checked against the worker tools', () => {
  const mcp = '{"docs":{"url":"https://mcp.example/mcp"}}'
  const cfg = workerConfig({
    ...base,
    MCP_SERVERS: mcp,
    SUBAGENTS: JSON.stringify({
      researcher: {
        description: 'Research a question',
        model: 'gpt-small',
        systemPrompt: 'You research.',
        tools: ['docs__search'],
        maxIterations: 4,
        readOnly: true,
      },
      thinker: { description: 'Think it over' },
    }),
  })
  assert.deepEqual(cfg.subagents, {
    researcher: {
      description: 'Research a question',
      model: 'gpt-small',
      systemPrompt: 'You research.',
      tools: ['docs__search'],
      maxIterations: 4,
      readOnly: true,
    },
    thinker: { description: 'Think it over' },
  })
  assert.deepEqual(workerConfig(base).subagents, {})
  const bad =
    (subagents: unknown, extra: Record<string, string> = {}) =>
    () =>
      workerConfig({ ...base, MCP_SERVERS: mcp, SUBAGENTS: JSON.stringify(subagents), ...extra })
  assert.throws(bad([]), /SUBAGENTS must be a JSON object/)
  assert.throws(bad({ r: 'x' }), /SUBAGENTS\.r must be an object/)
  assert.throws(bad({ r: {} }), /SUBAGENTS\.r\.description is required/)
  assert.throws(bad({ r: { description: 'd', config: {} } }), /unknown field\(s\) config/)
  assert.throws(bad({ r: { description: 'd', model: '' } }), /model must be a non-empty string/)
  assert.throws(bad({ r: { description: 'd', tools: 'docs__search' } }), /array of tool names/)
  assert.throws(bad({ r: { description: 'd', maxIterations: 0 } }), /maxIterations/)
  assert.throws(bad({ r: { description: 'd', readOnly: 'yes' } }), /readOnly/)
  // Only the worker's own tools; a name that is a tool name.
  assert.throws(
    bad({ r: { description: 'd', tools: ['github__push'] } }),
    /not a tool of this worker/,
  )
  assert.throws(bad({ r: { description: 'd', tools: ['search'] } }), /not a tool of this worker/)
  assert.throws(bad({ 'Bad Name': { description: 'd' } }), /must match/)
  assert.throws(bad({ docs__x: { description: 'd' } }), /must match/)
  assert.throws(() => workerConfig({ ...base, SUBAGENTS: '{' }), /SUBAGENTS must be valid JSON/)
})

test('static subagents: the caps are session options, bounded', () => {
  const o = sessionOptions({})
  assert.equal(o.subagentMaxPerRound, 4)
  assert.equal(o.subagentMaxPerSession, 50)
  const set = sessionOptions({ SUBAGENT_MAX_PER_ROUND: '2', SUBAGENT_MAX_PER_SESSION: '0' })
  assert.equal(set.subagentMaxPerRound, 2)
  assert.equal(set.subagentMaxPerSession, 0, '0: no subagent call in this session')
  assert.throws(() => sessionOptions({ SUBAGENT_MAX_PER_ROUND: '0' }), /SUBAGENT_MAX_PER_ROUND/)
  assert.throws(() => sessionOptions({ SUBAGENT_MAX_PER_ROUND: '65' }), /SUBAGENT_MAX_PER_ROUND/)
  assert.throws(
    () => sessionOptions({ SUBAGENT_MAX_PER_SESSION: '-1' }),
    /SUBAGENT_MAX_PER_SESSION/,
  )
})
