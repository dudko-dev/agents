// Every role's configuration from the environment. The README lists each variable; a new one goes
// there, in .env.example and in compose.yaml if the stack needs it.
import { hostname } from 'node:os'
import type { IAgentConfig } from '@dudko.dev/agent'
import { agentConfigFromEnv } from './agent-config.ts'
import type { ILimiterConfig, LimiterScope } from './db/limiter.ts'
import { bool, ConfigError, int, list, num, oneOf, secret, str, type Env } from './env.ts'
import { isLogLevel, type LogLevel } from './log.ts'
import type { ISessionOptions } from './session-types.ts'

export interface ITemporalConfig {
  address: string
  namespace: string
  taskQueue: string
  tls?: { caPath?: string; certPath?: string; keyPath?: string; serverName?: string }
  apiKey?: string
}

export interface IDatabaseConfig {
  url: string
  poolMax: number
}

export type GatewayAuth = { mode: 'bearer'; tokens: string[] } | { mode: 'none' }

export interface IGatewayConfig {
  host: string
  port: number
  auth: GatewayAuth
  corsOrigins: string[]
  maxBodyBytes: number
  messageMaxChars: number
  sse: { maxConnections: number; keepAliveMs: number; batch: number }
  session: ISessionOptions
  temporal: ITemporalConfig
  database: IDatabaseConfig
  logLevel: LogLevel
}

export interface IWorkerConfig {
  identity: string
  maxConcurrentTurns: number
  shutdownGraceMs: number
  heartbeatThrottleMs: number
  healthPort: number
  workflowBundlePath?: string
  leaseTtlMs: number
  eventMaxBytes: number
  limiter?: ILimiterConfig
  agent: IAgentConfig
  temporal: ITemporalConfig
  database: IDatabaseConfig
  logLevel: LogLevel
}

// The shortest token the gateway accepts: a guessable one is no lock.
export const TOKEN_MIN_CHARS = 16

export const logLevelOf = (env: Env): LogLevel => {
  const v = str(env, 'LOG_LEVEL') ?? 'info'
  if (!isLogLevel(v)) {
    throw new ConfigError(`LOG_LEVEL must be debug | info | warn | error, got: ${v}`)
  }
  return v
}

export const temporalConfig = (env: Env): ITemporalConfig => {
  const caPath = str(env, 'TEMPORAL_TLS_CA_PATH')
  const certPath = str(env, 'TEMPORAL_TLS_CERT_PATH')
  const keyPath = str(env, 'TEMPORAL_TLS_KEY_PATH')
  const serverName = str(env, 'TEMPORAL_TLS_SERVER_NAME')
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new ConfigError('TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH go together (mTLS)')
  }
  const apiKey = secret(env, 'TEMPORAL_API_KEY')
  const tls = bool(env, 'TEMPORAL_TLS', Boolean(caPath || certPath || apiKey))
  return {
    address: str(env, 'TEMPORAL_ADDRESS') ?? 'localhost:7233',
    namespace: str(env, 'TEMPORAL_NAMESPACE') ?? 'default',
    taskQueue: str(env, 'TEMPORAL_TASK_QUEUE') ?? 'swarm',
    ...(tls
      ? {
          tls: {
            ...(caPath ? { caPath } : {}),
            ...(certPath ? { certPath } : {}),
            ...(keyPath ? { keyPath } : {}),
            ...(serverName ? { serverName } : {}),
          },
        }
      : {}),
    ...(apiKey ? { apiKey } : {}),
  }
}

export const databaseConfig = (env: Env, name = 'DATABASE_URL'): IDatabaseConfig => {
  const url = secret(env, name)
  if (!url) {
    throw new ConfigError(`${name} (or ${name}_FILE) is required`)
  }
  return { url, poolMax: int(env, 'PG_POOL_MAX', 10, { min: 1, max: 1000 }) }
}

export const sessionOptions = (env: Env): ISessionOptions => ({
  idleTimeoutMs: int(env, 'SESSION_IDLE_TIMEOUT_MS', 86_400_000),
  turnTimeoutMs: int(env, 'TURN_TIMEOUT_MS', 1_800_000, { min: 1000 }),
  heartbeatTimeoutMs: int(env, 'TURN_HEARTBEAT_TIMEOUT_MS', 20_000, { min: 1000 }),
  maxTurnAttempts: int(env, 'TURN_MAX_ATTEMPTS', 5, { min: 1, max: 100 }),
  maxTurnsPerRun: int(env, 'SESSION_MAX_TURNS_PER_RUN', 100, { min: 1 }),
  historyMaxChars: int(env, 'SESSION_HISTORY_MAX_CHARS', 200_000, { min: 1000 }),
  maxQueuedMessages: int(env, 'SESSION_MAX_QUEUED_MESSAGES', 50, { min: 1, max: 1000 }),
})

export const gatewayAuth = (env: Env): GatewayAuth => {
  const mode = oneOf(env, 'GATEWAY_AUTH', ['bearer', 'none'] as const, 'bearer')
  if (mode === 'none') {
    return { mode }
  }
  const tokens = (secret(env, 'GATEWAY_TOKENS') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  if (tokens.length === 0) {
    throw new ConfigError(
      'GATEWAY_TOKENS (or GATEWAY_TOKENS_FILE) is required: one or more bearer tokens, comma separated (GATEWAY_AUTH=none turns auth off, for a local try only)',
    )
  }
  const short = tokens.filter((t) => t.length < TOKEN_MIN_CHARS)
  if (short.length) {
    throw new ConfigError(
      `every GATEWAY_TOKENS entry must be at least ${TOKEN_MIN_CHARS} characters`,
    )
  }
  return { mode, tokens }
}

export const gatewayConfig = (env: Env): IGatewayConfig => ({
  host: str(env, 'GATEWAY_HOST') ?? '0.0.0.0',
  port: int(env, 'GATEWAY_PORT', 8080, { max: 65535 }),
  auth: gatewayAuth(env),
  corsOrigins: list(env, 'CORS_ORIGINS'),
  maxBodyBytes: int(env, 'GATEWAY_MAX_BODY_BYTES', 65_536, { min: 1024, max: 16_777_216 }),
  messageMaxChars: int(env, 'MESSAGE_MAX_CHARS', 32_000, { min: 1 }),
  sse: {
    maxConnections: int(env, 'SSE_MAX_CONNECTIONS', 1000, { min: 1 }),
    keepAliveMs: int(env, 'SSE_KEEPALIVE_MS', 15_000, { min: 1000 }),
    batch: int(env, 'SSE_BATCH', 500, { min: 1, max: 5000 }),
  },
  session: sessionOptions(env),
  temporal: temporalConfig(env),
  database: databaseConfig(env),
  logLevel: logLevelOf(env),
})

export const limiterConfig = (env: Env): ILimiterConfig | undefined => {
  if (str(env, 'LIMITER_REFILL_PER_SECOND') === undefined) {
    for (const name of ['LIMITER_CAPACITY', 'LIMITER_MAX_WAIT_MS', 'LIMITER_SCOPE']) {
      if (str(env, name) !== undefined) {
        throw new ConfigError(
          `${name} is set but LIMITER_REFILL_PER_SECOND is not - the limiter is off`,
        )
      }
    }
    return undefined
  }
  const refillPerSecond = num(env, 'LIMITER_REFILL_PER_SECOND', { min: 0.001, max: 1_000_000 })
  const capacity =
    str(env, 'LIMITER_CAPACITY') === undefined
      ? Math.max(1, refillPerSecond)
      : num(env, 'LIMITER_CAPACITY', { min: 1, max: 1_000_000 })
  return {
    refillPerSecond,
    capacity,
    maxWaitMs: int(env, 'LIMITER_MAX_WAIT_MS', 60_000),
    scope: oneOf<LimiterScope>(env, 'LIMITER_SCOPE', ['global', 'model'], 'global'),
  }
}

export const workerConfig = (env: Env): IWorkerConfig => {
  const leaseTtlMs = int(env, 'LEASE_TTL_MS', 15_000, { min: 1000, max: 2_147_483_647 })
  const bundle = str(env, 'WORKFLOW_BUNDLE_PATH')
  const limiter = limiterConfig(env)
  return {
    identity: str(env, 'WORKER_IDENTITY') ?? `${hostname()}-${process.pid}`,
    maxConcurrentTurns: int(env, 'WORKER_MAX_CONCURRENT_TURNS', 10, { min: 1 }),
    shutdownGraceMs: int(env, 'WORKER_SHUTDOWN_GRACE_MS', 30_000),
    heartbeatThrottleMs: int(env, 'WORKER_HEARTBEAT_THROTTLE_MS', 1000, { min: 100 }),
    healthPort: int(env, 'WORKER_HEALTH_PORT', 8081, { max: 65535 }),
    ...(bundle ? { workflowBundlePath: bundle } : {}),
    leaseTtlMs,
    eventMaxBytes: int(env, 'EVENT_MAX_BYTES', 262_144, { min: 1024 }),
    ...(limiter ? { limiter } : {}),
    agent: agentConfigFromEnv(env),
    temporal: temporalConfig(env),
    database: databaseConfig(env),
    logLevel: logLevelOf(env),
  }
}

export const migrateConfig = (env: Env): IDatabaseConfig =>
  secret(env, 'MIGRATE_DATABASE_URL') !== undefined
    ? databaseConfig(env, 'MIGRATE_DATABASE_URL')
    : databaseConfig(env)
