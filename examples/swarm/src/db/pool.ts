import pg from 'pg'

// What the adapters need from Postgres: a query, and a client for a transaction. `pg.Pool`
// satisfies it; tests may pass anything shaped like it.
export interface IQueryable {
  query: <R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<R>>
}

export interface IDatabase extends IQueryable {
  connect: () => Promise<pg.PoolClient>
}

export interface IStatement {
  text: string
  values: unknown[]
}

export const createPool = (
  connectionString: string,
  options: { max?: number; applicationName?: string } = {},
): pg.Pool => {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'swarm',
    // A connection that cannot be had in this long is an outage, not a queue.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
  // An idle client that loses its server must not crash the process: the pool drops it.
  pool.on('error', () => {})
  return pool
}

// One transaction: BEGIN, the work, COMMIT - ROLLBACK on a throw.
export const inTransaction = async <T>(
  db: IDatabase,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
