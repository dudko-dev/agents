// The gateway's backend: Temporal for the sessions (start, signals, the state query) and the
// session table in Postgres (the event stream of an unknown id is a 404 without asking Temporal).
import { WorkflowNotFoundError, type Client } from '@temporalio/client'
import { createParkedStore } from './db/parked.ts'
import type { IQueryable } from './db/pool.ts'
import {
  BackendUnavailableError,
  SessionEndedError,
  SessionNotFoundError,
  type ISessionBackend,
} from './gateway.ts'
import {
  answerSignal,
  messageSignal,
  SESSION_WORKFLOW,
  stateQuery,
  stopSignal,
  workflowIdOf,
} from './session-api.ts'
import type { ISessionOptions } from './session-types.ts'
import type { ISessionInput } from './workflows.ts'

export const insertSessionSql =
  'INSERT INTO swarm_sessions (session_id, workflow_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'
export const sessionExistsSql = 'SELECT 1 FROM swarm_sessions WHERE session_id = $1'

export const createTemporalBackend = (o: {
  client: Client
  db: IQueryable
  taskQueue: string
  session: ISessionOptions
  // How long one call to Temporal may take before the gateway answers 503.
  deadlineMs?: number
}): ISessionBackend => {
  const deadlineMs = o.deadlineMs ?? 5000
  const exists = async (sessionId: string): Promise<boolean> =>
    ((await o.db.query(sessionExistsSql, [sessionId])).rowCount ?? 0) > 0

  // A call to the session's workflow: not found is a 404 (never started here) or a 409 (it ended);
  // anything else from Temporal is an outage for the client (503).
  const call = async <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await o.client.withDeadline(Date.now() + deadlineMs, fn)
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        throw (await exists(sessionId).catch(() => false))
          ? new SessionEndedError(sessionId)
          : new SessionNotFoundError(sessionId)
      }
      throw new BackendUnavailableError(`temporal: ${(err as Error).message}`)
    }
  }
  const handle = (sessionId: string) => o.client.workflow.getHandle(workflowIdOf(sessionId))
  const parked = createParkedStore(o.db)

  return {
    create: async (sessionId, first) => {
      const workflowId = workflowIdOf(sessionId)
      try {
        await o.db.query(insertSessionSql, [sessionId, workflowId])
      } catch (err) {
        throw new BackendUnavailableError(`postgres: ${(err as Error).message}`)
      }
      const input: ISessionInput = { sessionId, options: o.session }
      await call(sessionId, async () => {
        if (first) {
          await o.client.workflow.signalWithStart(SESSION_WORKFLOW, {
            taskQueue: o.taskQueue,
            workflowId,
            args: [input],
            signal: messageSignal,
            signalArgs: [first],
          })
        } else {
          await o.client.workflow.start(SESSION_WORKFLOW, {
            taskQueue: o.taskQueue,
            workflowId,
            args: [input],
          })
        }
      })
    },
    message: (sessionId, message) =>
      call(sessionId, () => handle(sessionId).signal(messageSignal, message)),
    answer: (sessionId, answer) =>
      call(sessionId, () => handle(sessionId).signal(answerSignal, answer)),
    stop: (sessionId, stop) => call(sessionId, () => handle(sessionId).signal(stopSignal, stop)),
    state: (sessionId) => call(sessionId, () => handle(sessionId).query(stateQuery)),
    parkedItem: (sessionId, itemId) => parked.item(sessionId, itemId),
    subagents: (sessionId) => parked.subagents(sessionId),
    pipelines: (sessionId) => parked.pipelines(sessionId),
    exists: async (sessionId) => {
      try {
        return await exists(sessionId)
      } catch (err) {
        throw new BackendUnavailableError(`postgres: ${(err as Error).message}`)
      }
    },
    ready: async () => {
      await o.db.query('SELECT 1')
      await o.client.withDeadline(Date.now() + deadlineMs, () =>
        o.client.workflowService.getSystemInfo({}),
      )
    },
  }
}
