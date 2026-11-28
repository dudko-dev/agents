// `runLease` for the agent, held by the Temporal activity that runs the turn:
//
//   acquire - the run is starting inside a turn activity: bind it to that turn (a fresh run) or
//             check it is the run the turn resumes. Temporal runs one attempt of an activity at a
//             time, so there is no one else to take it from; the bind's unique key is the guard
//             against a worker that lost the turn and does not know yet.
//   renew   - the activity heartbeat. False once Temporal says the turn is not this worker's any
//             more: the heartbeat timed out, the worker is shutting down, the activity was reset,
//             paused or is not found. The core then aborts the run and writes nothing more.
//             A user's stop is NOT a lost lease: the activity aborts the run itself, and the run
//             records its 'cancelled' snapshot.
//   release - forget the run.
//
// One agent serves every turn of the worker, so the lease finds the turn through an
// AsyncLocalStorage the activity sets around `agent.run` (acquire runs inside that call) and then
// by run id.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IRunLease } from '@dudko.dev/agent'
import type { IRunBinding } from './db/runs.ts'

export type TurnIntent =
  | { kind: 'fresh'; runNo: number; attemptBase: number }
  | { kind: 'resume'; runId: string; attemptBase: number }

export interface ITurnScope {
  sessionId: string
  turn: number
  intent: TurnIntent
  // Set by acquire.
  runId?: string
  heartbeat: (details: unknown) => void
  // Why the turn may not go on here (undefined while it may).
  revoked: () => string | undefined
}

const scopes = new AsyncLocalStorage<ITurnScope>()

export const withTurnScope = <T>(scope: ITurnScope, fn: () => Promise<T>): Promise<T> =>
  scopes.run(scope, fn)

export interface IHeartbeatLease extends IRunLease {
  // The turn a run belongs to (while its lease is held).
  scopeOf: (runId: string) => ITurnScope | undefined
}

export const createHeartbeatLease = (o: {
  bindRun: (binding: IRunBinding) => Promise<boolean>
  ttlMs: number
  owner: string
  log?: (message: string) => void
}): IHeartbeatLease => {
  const held = new Map<string, ITurnScope>()
  return {
    ttlMs: o.ttlMs,
    owner: o.owner,
    acquire: async (runId) => {
      const scope = scopes.getStore()
      if (!scope) {
        o.log?.(`[lease] run ${runId} started outside a turn activity: refused`)
        return false
      }
      if (scope.runId && scope.runId !== runId) {
        // One run per turn activity: anything else would be a second run inside this one.
        return false
      }
      if (scope.intent.kind === 'resume') {
        if (runId !== scope.intent.runId) {
          return false
        }
      } else if (
        !(await o.bindRun({
          runId,
          sessionId: scope.sessionId,
          turn: scope.turn,
          runNo: scope.intent.runNo,
          attemptBase: scope.intent.attemptBase,
        }))
      ) {
        o.log?.(
          `[lease] run ${scope.intent.runNo} of turn ${scope.turn} of session ${scope.sessionId} is already bound: refused`,
        )
        return false
      }
      if (scope.revoked()) {
        return false
      }
      scope.runId = runId
      held.set(runId, scope)
      return true
    },
    renew: (runId) => {
      const scope = held.get(runId)
      if (!scope || scope.revoked()) {
        return false
      }
      scope.heartbeat({ runId })
      return true
    },
    release: (runId) => {
      held.delete(runId)
    },
    scopeOf: (runId) => held.get(runId),
  }
}
