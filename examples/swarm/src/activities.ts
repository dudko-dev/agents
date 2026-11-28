// The activities: `runTurn` - one ordinary `agent.run` - and `endTurn`, the turn.ended marker.
//
// A retried turn (its worker died, its heartbeat timed out, the provider was down) finds its run
// by (session, turn) and goes on from the last snapshot under the next attempt. The decision is
// `planTurn`, pure:
//
//   no run yet, or one that died before its plan  -> a fresh run (the next run_no of the turn)
//   a snapshot with a plan, not finished           -> resume it (`resumeFromRunId`)
//   'complete'   -> the run finished but its result never reached Temporal: return it
//   'cancelled'  -> the user stopped it: the turn is stopped
import { Context } from '@temporalio/activity'
import { ApplicationFailure, type ActivityCancellationDetails } from '@temporalio/common'
import {
  isModelCallRefused,
  RunLeaseError,
  type AgentEvent,
  type IAgent,
  type IAgentRunResult,
} from '@dudko.dev/agent'
import type { IEventStore } from './db/events.ts'
import type { IRunRow, IRunStore } from './db/runs.ts'
import { withTurnScope, type ITurnScope, type TurnIntent } from './lease.ts'
import { errorMessage, type ILogger } from './log.ts'
import { TURN_REFUSED } from './session-api.ts'
import type { ITurnEnd, ITurnInput, TurnResult } from './session-types.ts'

export type TurnPlan =
  | { kind: 'completed'; row: IRunRow }
  | { kind: 'stopped'; row: IRunRow }
  | { kind: 'resume'; runId: string; attemptBase: number }
  | { kind: 'fresh'; runNo: number; first: boolean }

export const planTurn = (latest: IRunRow | undefined): TurnPlan => {
  if (!latest) {
    return { kind: 'fresh', runNo: 1, first: true }
  }
  const snapshot = latest.snapshot
  if (snapshot?.status === 'complete') {
    return { kind: 'completed', row: latest }
  }
  if (snapshot?.status === 'cancelled') {
    return { kind: 'stopped', row: latest }
  }
  if (snapshot?.plan) {
    return { kind: 'resume', runId: latest.runId, attemptBase: latest.attemptBase }
  }
  // Bound, but it died before its plan: there is nothing to resume.
  return { kind: 'fresh', runNo: latest.runNo + 1, first: false }
}

// Why Temporal took the turn away from this worker (the lease is lost). A user's stop is not here:
// it ends the turn, it does not move it.
export const revokedReason = (d: ActivityCancellationDetails | undefined): string | undefined => {
  if (!d) {
    return undefined
  }
  if (d.timedOut) return 'the heartbeat timed out'
  if (d.workerShutdown) return 'the worker is shutting down'
  if (d.reset) return 'the activity was reset'
  if (d.paused) return 'the activity was paused'
  if (d.notFound) return 'the activity is not known to the server'
  return undefined
}

// The provider refused the credentials: the next attempt would be refused too. (The core's own
// check is not exported; this is the same reading of the AI SDK's errors.)
export const isAuthError = (err: unknown, seen: Set<unknown> = new Set()): boolean => {
  if (!err || typeof err !== 'object' || seen.has(err)) {
    return false
  }
  seen.add(err)
  const e = err as { statusCode?: number; status?: number; cause?: unknown; lastError?: unknown }
  const status = e.statusCode ?? e.status
  return (
    status === 401 || status === 403 || isAuthError(e.cause, seen) || isAuthError(e.lastError, seen)
  )
}

export interface IActivityDeps {
  agent: Pick<IAgent, 'run'>
  runs: IRunStore
  events: IEventStore
  log: ILogger
}

export const createActivities = (deps: IActivityDeps) => {
  const { agent, runs, events, log } = deps

  const runTurn = async (input: ITurnInput): Promise<TurnResult> => {
    const ctx = Context.current()
    const { sessionId, turn } = input
    await events.marker({
      kind: 'started',
      sessionId,
      turn,
      body: { messageIds: input.messageIds, input: input.input },
    })
    const plan = planTurn(await runs.latestRunOfTurn(sessionId, turn))
    if (plan.kind === 'completed') {
      const s = plan.row.snapshot!
      return {
        status: 'completed',
        runId: s.runId,
        attempt: s.attempt ?? 1,
        text: s.text ?? '',
        usage: s.usage,
      }
    }
    if (plan.kind === 'stopped') {
      const s = plan.row.snapshot!
      return { status: 'stopped', runId: s.runId, attempt: s.attempt ?? 1, usage: s.usage }
    }
    const intent: TurnIntent =
      plan.kind === 'resume'
        ? plan
        : {
            kind: 'fresh',
            runNo: plan.runNo,
            attemptBase: plan.first ? 0 : await runs.nextAttemptBase(sessionId, turn),
          }

    // A user's stop reaches the activity as a cancellation (cancelRequested): abort the run, which
    // then writes its 'cancelled' snapshot. Any other cancellation is a lost lease - the core aborts
    // the run itself, and nothing more is written.
    const stop = new AbortController()
    const revoked = (): string | undefined => revokedReason(ctx.cancellationDetails)
    const onCancel = (): void => {
      if (!revoked()) {
        stop.abort(new Error(`turn ${turn} stopped by the user`))
      }
    }
    if (ctx.cancellationSignal.aborted) {
      onCancel()
    } else {
      ctx.cancellationSignal.addEventListener('abort', onCancel, { once: true })
    }

    const writer = events.writer({
      sessionId,
      turn,
      attemptBase: intent.attemptBase,
      onError: (err, dropped) =>
        log.warn('events dropped', { sessionId, turn, dropped, error: errorMessage(err) }),
    })
    let last: { runId?: string; attempt?: number } = {}
    const scope: ITurnScope = {
      sessionId,
      turn,
      intent,
      heartbeat: (details) => ctx.heartbeat(details),
      revoked,
    }
    const onEvent = (event: AgentEvent): void => {
      writer.push(event)
      last = { runId: event.runId, attempt: event.attempt }
      // Throttled by the SDK; it also carries a stop to the activity sooner than the renew does.
      ctx.heartbeat({ runId: event.runId, attempt: event.attempt, seq: event.seq })
    }

    let result: IAgentRunResult
    try {
      result = await withTurnScope(scope, () =>
        agent.run(
          intent.kind === 'resume'
            ? { input: '', resumeFromRunId: intent.runId, signal: stop.signal, onEvent }
            : { input: input.input, history: input.history, signal: stop.signal, onEvent },
        ),
      )
    } catch (err) {
      await writer.flush()
      ctx.cancellationSignal.removeEventListener('abort', onCancel)
      const runId = scope.runId ?? last.runId
      const why = revoked()
      if (why || err instanceof RunLeaseError) {
        log.warn('turn moved', { sessionId, turn, runId, reason: why ?? errorMessage(err) })
        throw ApplicationFailure.retryable(
          `turn ${turn} left this worker: ${why ?? errorMessage(err)}`,
          'TurnMoved',
        )
      }
      if (stop.signal.aborted) {
        return {
          status: 'stopped',
          ...(runId ? { runId } : {}),
          ...(last.attempt ? { attempt: last.attempt } : {}),
        }
      }
      if (isModelCallRefused(err) || isAuthError(err)) {
        throw ApplicationFailure.nonRetryable(errorMessage(err), TURN_REFUSED)
      }
      log.warn('turn failed', { sessionId, turn, runId, error: errorMessage(err) })
      throw ApplicationFailure.retryable(errorMessage(err), 'TurnFailed')
    }
    await writer.flush()
    ctx.cancellationSignal.removeEventListener('abort', onCancel)
    return {
      status: 'completed',
      runId: scope.runId ?? last.runId ?? '',
      attempt: last.attempt ?? 1,
      text: result.text,
      usage: result.usage,
      ...(result.compactedHistory ? { compactedHistory: result.compactedHistory } : {}),
    }
  }

  const endTurn = async (end: ITurnEnd): Promise<void> => {
    const { sessionId, turn, ...body } = end
    await events.marker({ kind: 'ended', sessionId, turn, body })
  }

  return { runTurn, endTurn }
}

export type SwarmActivities = ReturnType<typeof createActivities>
