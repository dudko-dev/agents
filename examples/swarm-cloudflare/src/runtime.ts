// What every part of the Worker reads once per isolate: the configuration parsed from the
// environment (a bad value is a ConfigError naming the variable), the log, and the steps' deps.
import { createLogger, type IApiConfig, type ILogger, type ISessionOptions } from 'swarm-shared'
import { agentSetupFromEnv, type IAgentSetup } from './agent-config.ts'
import {
  apiConfig,
  logLevelOf,
  runtimeConfig,
  sessionOptions,
  type IRuntimeConfig,
} from './config.ts'
import type { Env } from './env-types.ts'
import { stringsOf } from './env.ts'
import type { ISessionPort, IStepDeps } from './steps.ts'

const logs = new WeakMap<object, ILogger>()

export const logOf = (env: Env): ILogger => {
  let log = logs.get(env)
  if (!log) {
    let level: ReturnType<typeof logLevelOf> = 'info'
    try {
      level = logLevelOf(stringsOf(env))
    } catch {
      // A bad LOG_LEVEL is reported where the rest of the config is read.
    }
    log = createLogger(level, { app: 'swarm-cloudflare' })
    logs.set(env, log)
  }
  return log
}

const cached = <T>(read: (env: Env) => T) => {
  const values = new WeakMap<object, { value: T } | { error: unknown }>()
  return (env: Env): T => {
    let v = values.get(env)
    if (!v) {
      try {
        v = { value: read(env) }
      } catch (error) {
        v = { error }
      }
      values.set(env, v)
    }
    if ('error' in v) throw v.error
    return v.value
  }
}

export const apiOf = cached((env): IApiConfig => apiConfig(stringsOf(env)))
export const sessionOf = cached((env): ISessionOptions => sessionOptions(stringsOf(env)))
export const runtimeOf = cached((env): IRuntimeConfig => runtimeConfig(stringsOf(env)))
export const setupOf = cached((env): IAgentSetup => agentSetupFromEnv(stringsOf(env)))

export const sessionPort = (env: Env, sessionId: string): ISessionPort =>
  env.SESSION.get(env.SESSION.idFromName(sessionId)) as unknown as ISessionPort

export const stepDepsOf = (env: Env): IStepDeps => {
  const log = logOf(env)
  return {
    port: (sessionId) => sessionPort(env, sessionId),
    take: (bucket, cost, cfg) =>
      env.LIMITER.get(env.LIMITER.idFromName(bucket)).take(bucket, cost, cfg),
    setup: setupOf(env),
    runtime: runtimeOf(env),
    log: (level, message, fields) => log[level](message, fields),
  }
}
