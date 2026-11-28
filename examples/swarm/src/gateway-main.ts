// The `gateway` role: the HTTP server, a Temporal client, a Postgres pool and one LISTEN
// connection. SIGTERM: stop accepting, end the open event streams (clients reconnect elsewhere
// with Last-Event-ID), close.
import type { Server } from 'node:http'
import { Client, Connection } from '@temporalio/client'
import pg from 'pg'
import { createTemporalBackend } from './backend.ts'
import type { IGatewayConfig } from './config.ts'
import { createEventStore, EVENTS_CHANNEL } from './db/events.ts'
import { createNotifyHub } from './db/notify.ts'
import { createPool } from './db/pool.ts'
import { createGateway, listen, type IGateway } from './gateway.ts'
import { errorMessage, type ILogger } from './log.ts'
import { connectionOptions } from './temporal.ts'

export interface IRunningGateway {
  server: Server
  gateway: IGateway
  port: number
  close: () => Promise<void>
}

export const startGateway = async (cfg: IGatewayConfig, log: ILogger): Promise<IRunningGateway> => {
  const pool = createPool(cfg.database.url, {
    max: cfg.database.poolMax,
    applicationName: 'swarm-gateway',
  })
  // Lazy: the gateway starts (and says it is not ready) while Temporal is still coming up.
  const connection = Connection.lazy(connectionOptions(cfg.temporal))
  const client = new Client({ connection, namespace: cfg.temporal.namespace })
  const hub = createNotifyHub({
    channel: EVENTS_CHANNEL,
    newClient: () =>
      new pg.Client({ connectionString: cfg.database.url, application_name: 'swarm-listen' }),
    log: (message) => log.warn(message),
  })
  await hub.start().catch((err) => log.warn('LISTEN not up yet', { error: errorMessage(err) }))
  const store = createEventStore(pool, Number.MAX_SAFE_INTEGER)
  const gateway = createGateway({
    config: cfg,
    backend: createTemporalBackend({
      client,
      db: pool,
      taskQueue: cfg.temporal.taskQueue,
      session: cfg.session,
    }),
    feed: {
      after: store.after,
      subscribe: hub.subscribe,
      ready: hub.ready,
      open: hub.size,
    },
    log,
  })
  const server = await listen(gateway, cfg.host, cfg.port)
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : cfg.port
  log.info('gateway listening', { host: cfg.host, port, auth: cfg.auth.mode })
  return {
    server,
    gateway,
    port,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      gateway.closeStreams()
      server.closeIdleConnections()
      await hub.stop()
      await closed
      await connection.close().catch(() => {})
      await pool.end().catch(() => {})
    },
  }
}
