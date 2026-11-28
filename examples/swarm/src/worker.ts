// The `worker` role: one agent per process, serving the session workflows and their turns on one
// task queue. Scale by running more of them.
//
// SIGTERM (handled by Temporal's Runtime): stop polling, give the running turns
// WORKER_SHUTDOWN_GRACE_MS to finish, then cancel them - the lease is lost, the run is aborted
// and writes nothing more, Temporal retries the turn on another worker, which resumes it from the
// last snapshot. A worker that is killed outright has its turns retried once their heartbeat
// times out (TURN_HEARTBEAT_TIMEOUT_MS).
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { NativeConnection, Runtime, Worker } from '@temporalio/worker'
import { createAgent, type AgentEvent, type IAgent, type IAgentConfig } from '@dudko.dev/agent'
import { createActivities } from './activities.ts'
import type { IWorkerConfig } from './config.ts'
import { createEventStore } from './db/events.ts'
import { createPostgresLimits } from './db/limiter.ts'
import { createPool } from './db/pool.ts'
import { createPostgresPersistence, createRunStore } from './db/runs.ts'
import { createHeartbeatLease } from './lease.ts'
import type { ILogger } from './log.ts'
import { DEFAULT_BUNDLE_PATH, WORKFLOWS_PATH } from './paths.ts'
import { connectionOptions } from './temporal.ts'

export interface IRunningWorker {
  worker: Worker
  agent: IAgent
  // Resolves once the worker has stopped and everything it opened is closed.
  done: Promise<void>
  shutdown: () => void
  healthPort?: number
}

// Logs of the agent at warn and above go to the process log; every event of a run also goes to
// Postgres (the activity's onEvent).
const agentLogger =
  (log: ILogger) =>
  (event: AgentEvent): void => {
    if (event.type !== 'log') return
    if (event.level === 'error') log.error(event.message, { runId: event.runId })
    else if (event.level === 'warn') log.warn(event.message, { runId: event.runId })
  }

// The SDK's own log lines (worker state, failed activities) in the process's JSON format.
export const installRuntime = (log: ILogger): void => {
  const fields = (meta?: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(meta ?? {}).map(([k, v]) => [k, v instanceof Error ? v.message : v]),
    )
  const at = (level: string, message: string, meta?: Record<string, unknown>): void => {
    const f = { sdk: 'temporal', ...fields(meta) }
    if (level === 'ERROR') log.error(message, f)
    else if (level === 'WARN') log.warn(message, f)
    else if (level === 'INFO') log.info(message, f)
    else log.debug(message, f)
  }
  Runtime.install({
    logger: {
      log: (level, message, meta) => at(level, message, meta),
      trace: (message, meta) => at('TRACE', message, meta),
      debug: (message, meta) => at('DEBUG', message, meta),
      info: (message, meta) => at('INFO', message, meta),
      warn: (message, meta) => at('WARN', message, meta),
      error: (message, meta) => at('ERROR', message, meta),
    },
  })
}

const healthServer = (worker: Worker, port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const state = worker.getState()
      const ok = req.url === '/readyz' ? state === 'RUNNING' : state !== 'FAILED'
      res.writeHead(req.url === '/healthz' || req.url === '/readyz' ? (ok ? 200 : 503) : 404, {
        'content-type': 'application/json',
      })
      res.end(JSON.stringify({ state }))
    })
    server.on('error', reject)
    server.listen(port, () => resolve(server))
  })

export const startWorker = async (
  cfg: IWorkerConfig,
  log: ILogger,
  // Tests swap the agent's config (a scripted model) without touching the env.
  agentConfig: IAgentConfig = cfg.agent,
): Promise<IRunningWorker> => {
  const pool = createPool(cfg.database.url, {
    max: cfg.database.poolMax,
    applicationName: 'swarm-worker',
  })
  const runs = createRunStore(pool)
  const events = createEventStore(pool, cfg.eventMaxBytes)
  const lease = createHeartbeatLease({
    bindRun: runs.bindRun,
    ttlMs: cfg.leaseTtlMs,
    owner: cfg.identity,
    log: (message) => log.warn(message),
  })
  const sharedLimits = cfg.limiter ? createPostgresLimits(pool, cfg.limiter) : undefined
  const agent = await createAgent(
    {
      ...agentConfig,
      persistence: createPostgresPersistence(pool),
      runLease: lease,
      ...(sharedLimits ? { sharedLimits } : {}),
    },
    agentLogger(log),
  )
  const connection = await NativeConnection.connect(connectionOptions(cfg.temporal))
  const bundle =
    cfg.workflowBundlePath ?? (existsSync(DEFAULT_BUNDLE_PATH) ? DEFAULT_BUNDLE_PATH : undefined)
  const worker = await Worker.create({
    connection,
    namespace: cfg.temporal.namespace,
    taskQueue: cfg.temporal.taskQueue,
    identity: cfg.identity,
    ...(bundle ? { workflowBundle: { codePath: bundle } } : { workflowsPath: WORKFLOWS_PATH }),
    activities: createActivities({ agent, runs, events, log }),
    maxConcurrentActivityTaskExecutions: cfg.maxConcurrentTurns,
    shutdownGraceTime: cfg.shutdownGraceMs,
    // A stop reaches a running turn on its next heartbeat: send them often.
    maxHeartbeatThrottleInterval: cfg.heartbeatThrottleMs,
    defaultHeartbeatThrottleInterval: cfg.heartbeatThrottleMs,
  })
  const health = cfg.healthPort > 0 ? await healthServer(worker, cfg.healthPort) : undefined
  log.info('worker started', {
    identity: cfg.identity,
    taskQueue: cfg.temporal.taskQueue,
    workflows: bundle ? 'bundle' : 'source',
  })
  const done = worker.run().finally(async () => {
    log.info('worker stopped; closing', { identity: cfg.identity })
    health?.close()
    await agent.close().catch(() => {})
    await connection.close().catch(() => {})
    await pool.end().catch(() => {})
  })
  const address = health?.address()
  return {
    worker,
    agent,
    done,
    shutdown: () => worker.shutdown(),
    ...(address && typeof address === 'object' ? { healthPort: address.port } : {}),
  }
}
