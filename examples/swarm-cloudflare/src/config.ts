// The Worker's configuration from its environment (wrangler.jsonc `vars`, Worker secrets,
// `.dev.vars` locally), under examples/swarm's variable names wherever the meaning is the same
// (its src/config.ts). The README lists each variable, and which of the Temporal swarm's have no
// meaning here.
import {
  isLogLevel,
  type GatewayAuth,
  type IApiConfig,
  type ISessionOptions,
  type LogLevel,
} from 'swarm-shared'
import { CHILD_ASKS, type ChildAsk } from './child-ask.ts'
import { ConfigError, int, list, num, oneOf, str, type Env } from './env.ts'
import type { ILimiterConfig, LimiterScope } from './limiter.ts'

// The shortest token the gateway accepts: a guessable one is no lock.
export const TOKEN_MIN_CHARS = 16

export const logLevelOf = (env: Env): LogLevel => {
  const v = str(env, 'LOG_LEVEL') ?? 'info'
  if (!isLogLevel(v)) {
    throw new ConfigError(`LOG_LEVEL must be debug | info | warn | error, got: ${v}`)
  }
  return v
}

export const gatewayAuth = (env: Env): GatewayAuth => {
  const mode = oneOf(env, 'GATEWAY_AUTH', ['bearer', 'none'] as const, 'bearer')
  if (mode === 'none') {
    return { mode }
  }
  const tokens = list(env, 'GATEWAY_TOKENS')
  if (tokens.length === 0) {
    throw new ConfigError(
      'GATEWAY_TOKENS is required: one or more bearer tokens, comma separated, as a Worker secret (GATEWAY_AUTH=none turns auth off, for a local try only)',
    )
  }
  if (tokens.some((t) => t.length < TOKEN_MIN_CHARS)) {
    throw new ConfigError(
      `every GATEWAY_TOKENS entry must be at least ${TOKEN_MIN_CHARS} characters`,
    )
  }
  return { mode, tokens }
}

// swarm-shared's IApiConfig. SSE_MAX_CONNECTIONS counts the open streams of ONE session here (the
// session's object serves them), not of a gateway instance: a Worker has no instance to protect -
// the object is the one resource a crowd of readers could wear out.
export const apiConfig = (env: Env): IApiConfig => ({
  auth: gatewayAuth(env),
  corsOrigins: list(env, 'CORS_ORIGINS'),
  maxBodyBytes: int(env, 'GATEWAY_MAX_BODY_BYTES', 65_536, { min: 1024, max: 16_777_216 }),
  messageMaxChars: int(env, 'MESSAGE_MAX_CHARS', 32_000, { min: 1 }),
  sse: {
    maxConnections: int(env, 'SSE_MAX_CONNECTIONS', 100, { min: 1 }),
    keepAliveMs: int(env, 'SSE_KEEPALIVE_MS', 15_000, { min: 1000 }),
    batch: int(env, 'SSE_BATCH', 500, { min: 1, max: 5000 }),
  },
})

// The lease TTL is what a Temporal activity's heartbeat timeout was: how long a step that stopped
// answering keeps the run before a retry may take it.
export const leaseTtlMs = (env: Env): number =>
  int(env, 'LEASE_TTL_MS', 15_000, { min: 1000, max: 2_147_483_647 })

// Fixed when a session starts (its object keeps them), so a running session never depends on a
// later deploy's vars.
export const sessionOptions = (env: Env): ISessionOptions => ({
  idleTimeoutMs: int(env, 'SESSION_IDLE_TIMEOUT_MS', 86_400_000),
  // One attempt of a turn: the step's timeout.
  turnTimeoutMs: int(env, 'TURN_TIMEOUT_MS', 1_800_000, { min: 1000 }),
  // No heartbeat timeout here: the lease's TTL plays its part (LEASE_TTL_MS).
  heartbeatTimeoutMs: leaseTtlMs(env),
  maxTurnAttempts: int(env, 'TURN_MAX_ATTEMPTS', 5, { min: 1, max: 100 }),
  // No continue-as-new on this platform (a Durable Object has no history to cut): not read.
  maxTurnsPerRun: 100,
  historyMaxChars: int(env, 'SESSION_HISTORY_MAX_CHARS', 200_000, { min: 1000 }),
  maxQueuedMessages: int(env, 'SESSION_MAX_QUEUED_MESSAGES', 50, { min: 1, max: 1000 }),
  subagentMaxPerRound: int(env, 'SUBAGENT_MAX_PER_ROUND', 4, { min: 1, max: 64 }),
  subagentMaxPerSession: int(env, 'SUBAGENT_MAX_PER_SESSION', 50, { min: 0, max: 10_000 }),
  pipelineMaxPerRound: int(env, 'PIPELINE_MAX_PER_ROUND', 2, { min: 1, max: 64 }),
  pipelineMaxPerSession: int(env, 'PIPELINE_MAX_PER_SESSION', 20, { min: 0, max: 10_000 }),
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

// What the steps need beside the agent: the lease, the events, the limiter, CHILD_ASK.
export interface IRuntimeConfig {
  leaseTtlMs: number
  // One stored event's cap (a Durable Object row holds 2 MB).
  eventMaxBytes: number
  // How long a step buffers its run's events before it sends them to the session's object (one
  // RPC - a subrequest - per flush).
  eventFlushMs: number
  limiter?: ILimiterConfig
  childAsk: ChildAsk
  logLevel: LogLevel
}

export const runtimeConfig = (env: Env): IRuntimeConfig => {
  const limiter = limiterConfig(env)
  return {
    leaseTtlMs: leaseTtlMs(env),
    eventMaxBytes: int(env, 'EVENT_MAX_BYTES', 262_144, { min: 1024, max: 1_048_576 }),
    eventFlushMs: int(env, 'EVENT_FLUSH_MS', 100, { min: 10, max: 10_000 }),
    ...(limiter ? { limiter } : {}),
    childAsk: oneOf(env, 'CHILD_ASK', CHILD_ASKS, 'park'),
    logLevel: logLevelOf(env),
  }
}
