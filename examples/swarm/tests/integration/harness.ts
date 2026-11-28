// The integration harness: a real Postgres (DATABASE_URL), a real Temporal dev server
// (`TestWorkflowEnvironment.createLocal()`: downloaded once from temporal.download, or the binary
// at TEMPORAL_CLI_PATH), the scripted OpenAI-compatible model of the agent package's tests (no
// provider, no key), and the swarm's own worker and gateway.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import type { IAgentConfig } from '@dudko.dev/agent'
import pg from 'pg'
import type { ISessionOptions } from 'swarm-shared'
import type { IGatewayConfig, IWorkerConfig } from '../../src/config.ts'
import { migrate } from '../../src/db/migrate.ts'
import { createPool } from '../../src/db/pool.ts'
import { startGateway, type IRunningGateway } from '../../src/gateway-main.ts'
import { silentLogger } from '../../src/log.ts'
import { startWorker, type IRunningWorker } from '../../src/worker.ts'
import {
  startLocalOpenAI,
  systemOf,
  toolNames,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from '../../../../packages/agent/tests/helpers/openai-server.ts'

export {
  startLocalOpenAI,
  systemOf,
  toolNames,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
}

// The executor's rounds of a step: the i-th answer once i rounds are done (assistant turns).
export const roundOf = (req: IChatRequest): number =>
  req.messages.filter((m) => m.role === 'assistant').length
export { readSse, type ISseEvent } from '../helpers/sse.ts'

export const DATABASE_URL = process.env.DATABASE_URL ?? ''
if (!DATABASE_URL) {
  throw new Error(
    'the integration tests need a Postgres: set DATABASE_URL (e.g. postgres://swarm:swarm@localhost:5432/swarm)',
  )
}

export const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url))
export const TOKEN = 'integration-test-token-0123456789'

export const migrated = async (): Promise<pg.Pool> => {
  const pool = createPool(DATABASE_URL, { max: 5 })
  await migrate(pool)
  return pool
}

export const startTemporal = (): Promise<TestWorkflowEnvironment> =>
  TestWorkflowEnvironment.createLocal({
    server: {
      ...(process.env.TEMPORAL_CLI_PATH
        ? { executable: { type: 'existing-path', path: process.env.TEMPORAL_CLI_PATH } }
        : {}),
      log: { format: 'pretty', level: 'error' },
    },
  })

// Which stage a request is for: the stages' system prompts start with these role phrases.
export const stageOf = (req: IChatRequest): string => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}

export const stepOf = (req: IChatRequest): string =>
  /CURRENT STEP to execute \(id=([^)]+)\)/.exec(userOf(req))?.[1] ?? '?'

export const planJson = (ids: string[]): string =>
  JSON.stringify({
    thought: 'Step by step.',
    steps: ids.map((id) => ({
      id,
      description: `Step ${id}`,
      expectedOutcome: `${id} done`,
      suggestedTools: [],
    })),
  })

export const agentConfig = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'swarm-test',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 6,
  maxStepsPerTask: 4,
  logLevel: 'none',
  ...extra,
})

export const sessionOptions = (extra: Partial<ISessionOptions> = {}): ISessionOptions => ({
  idleTimeoutMs: 0,
  turnTimeoutMs: 120_000,
  heartbeatTimeoutMs: 3000,
  maxTurnAttempts: 5,
  maxTurnsPerRun: 100,
  historyMaxChars: 200_000,
  maxQueuedMessages: 50,
  ...extra,
})

export const workerConfig = (
  temporal: TestWorkflowEnvironment,
  taskQueue: string,
  agent: IAgentConfig,
  extra: Partial<IWorkerConfig> = {},
): IWorkerConfig => ({
  identity: `test-worker-${randomUUID().slice(0, 8)}`,
  maxConcurrentTurns: 4,
  shutdownGraceMs: 1000,
  heartbeatThrottleMs: 200,
  healthPort: 0,
  leaseTtlMs: 1500,
  eventMaxBytes: 262_144,
  agent,
  temporal: { address: temporal.address, namespace: 'default', taskQueue },
  database: { url: DATABASE_URL, poolMax: 5 },
  logLevel: 'warn',
  ...extra,
})

export const gatewayConfig = (
  temporal: TestWorkflowEnvironment,
  taskQueue: string,
  extra: Partial<IGatewayConfig> = {},
): IGatewayConfig => ({
  host: '127.0.0.1',
  port: 0,
  auth: { mode: 'bearer', tokens: [TOKEN] },
  corsOrigins: [],
  maxBodyBytes: 65_536,
  messageMaxChars: 32_000,
  sse: { maxConnections: 100, keepAliveMs: 1000, batch: 500 },
  session: sessionOptions(),
  temporal: { address: temporal.address, namespace: 'default', taskQueue },
  database: { url: DATABASE_URL, poolMax: 5 },
  logLevel: 'warn',
  ...extra,
})

export const inProcessWorker = (cfg: IWorkerConfig): Promise<IRunningWorker> =>
  startWorker(cfg, silentLogger)

export const inProcessGateway = (cfg: IGatewayConfig): Promise<IRunningGateway> =>
  startGateway(cfg, silentLogger)

// A worker as its own process (`main.ts worker`), the way the image runs it - so it can be killed.
// `script`: another entry that starts a worker (notes-worker.ts: one with a native write tool).
export const childWorker = (env: Record<string, string>, script = MAIN): ChildProcess => {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', script, 'worker'],
    {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout?.resume()
  child.stderr?.on('data', (d: Buffer) => {
    if (process.env.SWARM_TEST_VERBOSE) process.stderr.write(d)
  })
  return child
}

export const exited = (child: ChildProcess): Promise<number | null> =>
  child.exitCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((resolve) => child.once('exit', (code) => resolve(code)))

export const until = async <T>(
  what: string,
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 30_000,
  everyMs = 100,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v !== undefined && v !== false) {
      return v
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

export const api = (base: string) => {
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return {
    headers: { authorization: `Bearer ${TOKEN}` },
    post,
    get: async (path: string) => {
      const res = await fetch(`${base}${path}`, { headers })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    },
  }
}

export const uniqueQueue = (name: string): string =>
  `swarm-test-${name}-${randomUUID().slice(0, 8)}`
