// One image, three roles: `gateway` | `worker` | `migrate` (the first argument).
//
//   node src/main.ts migrate   apply sql/*.sql, then exit (a one-shot job before the others)
//   node src/main.ts gateway   the HTTP API (stateless; scale freely)
//   node src/main.ts worker    sessions and turns (scale with the load)
import { workerConfig, gatewayConfig, logLevelOf, migrateConfig } from './config.ts'
import { migrate } from './db/migrate.ts'
import { createPool } from './db/pool.ts'
import { ConfigError } from './env.ts'
import { startGateway } from './gateway-main.ts'
import { createLogger, errorMessage } from './log.ts'
import { installRuntime, startWorker } from './worker.ts'

const ROLES = ['gateway', 'worker', 'migrate'] as const
type Role = (typeof ROLES)[number]

const main = async (role: string | undefined): Promise<void> => {
  if (!ROLES.includes(role as Role)) {
    process.stderr.write(`usage: main.ts ${ROLES.join(' | ')}\n`)
    process.exitCode = 2
    return
  }
  const log = createLogger(logLevelOf(process.env), { role })
  try {
    if (role === 'migrate') {
      const cfg = migrateConfig(process.env)
      const pool = createPool(cfg.url, { max: 1, applicationName: 'swarm-migrate' })
      try {
        const applied = await migrate(pool, { log: (m) => log.info(m) })
        log.info(applied.length ? 'migrations applied' : 'schema up to date', { applied })
      } finally {
        await pool.end()
      }
      return
    }
    if (role === 'gateway') {
      const running = await startGateway(gatewayConfig(process.env), log)
      const stop = (signal: string): void => {
        log.info('shutting down', { signal })
        void running.close().then(() => process.exit(0))
      }
      process.once('SIGTERM', () => stop('SIGTERM'))
      process.once('SIGINT', () => stop('SIGINT'))
      return
    }
    const cfg = workerConfig(process.env)
    installRuntime(log)
    const running = await startWorker(cfg, log)
    // Temporal's Runtime turns SIGTERM / SIGINT into worker.shutdown(): polling stops, running
    // turns get the grace time, then the process exits here.
    process.once('SIGTERM', () => log.info('draining', { signal: 'SIGTERM' }))
    await running.done
    process.exit(process.exitCode ?? 0)
  } catch (err) {
    log.error(err instanceof ConfigError ? 'configuration error' : 'failed', {
      error: errorMessage(err),
    })
    process.exitCode = 1
  }
}

void main(process.argv[2])
