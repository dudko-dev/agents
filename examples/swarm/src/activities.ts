// The activities: `runTurn` - one ordinary `agent.run` - `runSubagent` - one agent.run of a static
// subagent, inside its child workflow - and the markers: `endTurn` (turn.ended) and
// `writeMarkers` (subagent.started / subagent.ended in the parent turn's stream).
//
// A retried turn (its worker died, its heartbeat timed out, the provider was down) finds its run
// by (session, turn) and goes on from the last snapshot under the next attempt - with the call
// journal, the step a crash interrupted is REPLAYED, not run again. The decision is `planTurn`,
// pure:
//
//   no run yet, or one that died before its plan  -> a fresh run (the next run_no of the turn)
//   a snapshot with a plan, not finished           -> resume it (`resumeFromRunId`, + `answers`)
//   'waiting', and no answer for what it waits for -> the run is parked: report it again
//   'complete'   -> the run finished but its result never reached Temporal: return it
//   'cancelled'  -> the user stopped it: the turn is stopped
//
// A run that PARKS (a person's question under the approval mode, a deferred tool result, a static
// subagent call) resolves; the activity records its items (swarm_parked) and returns `parked`.
// The workflow collects the answers and runs the activity again, which resumes the run with them.
import { Context } from '@temporalio/activity'
import { ApplicationFailure, type ActivityCancellationDetails } from '@temporalio/common'
import {
  isModelCallRefused,
  RunLeaseError,
  type AgentEvent,
  type IAgent,
  type IAgentRunResult,
  type IConversationTurn,
  type ParkAnswer,
  type ParkedItem,
} from '@dudko.dev/agent'
import type { IEventStore } from './db/events.ts'
import type { IParkedStore } from './db/parked.ts'
import type { IRunRow, IRunStore } from './db/runs.ts'
import { withTurnScope, type ITurnScope, type TurnIntent } from './lease.ts'
import { errorMessage, type ILogger } from './log.ts'
import { subagentWorkflowIdOf, TURN_REFUSED } from './session-api.ts'
import type {
  IAnswer,
  IParkedRequest,
  IStreamMarker,
  ISubagentCall,
  ISubagentInput,
  ITurnEnd,
  ITurnInput,
  SubagentOutcome,
  TurnResult,
} from './session-types.ts'

// A child's answer, as the parent's item gets it (and as Temporal carries it).
export const SUBAGENT_TEXT_MAX_CHARS = 32_000

export type TurnPlan =
  | { kind: 'completed'; row: IRunRow }
  | { kind: 'stopped'; row: IRunRow }
  | { kind: 'parked'; row: IRunRow }
  | { kind: 'resume'; runId: string; attemptBase: number }
  | { kind: 'fresh'; runNo: number; first: boolean }

// `answers`: the ids the turn brings answers for. A 'waiting' run goes on only when it brings an
// answer for one of the items it waits for; otherwise (a retry of an activity whose `parked`
// result was lost, a stale retry) it is parked still, and nothing runs.
export const planTurn = (latest: IRunRow | undefined, answers: string[] = []): TurnPlan => {
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
  if (snapshot?.status === 'waiting' && snapshot.parked) {
    const waits = new Set(snapshot.parked.items.map((i) => i.id))
    if (!answers.some((id) => waits.has(id))) {
      return { kind: 'parked', row: latest }
    }
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

// A static subagent's call, read from its parked item: the tool is one of the subagents and its
// input is `{ task }` (what createSubagentTool takes). Anything else is an ordinary item.
export const subagentCallOf = (
  item: ParkedItem,
  subagents: ReadonlySet<string>,
): ISubagentCall | undefined => {
  if (item.kind !== 'tool' || !subagents.has(item.toolName)) {
    return undefined
  }
  const input = (item.input ?? {}) as { task?: unknown; profile?: unknown }
  if (typeof input.task !== 'string') {
    return undefined
  }
  return {
    name: item.toolName,
    task: input.task,
    ...(typeof input.profile === 'string' ? { profile: input.profile } : {}),
  }
}

// The core's items as the workflow keeps them.
export const requestsOf = (items: ParkedItem[], subagents: ReadonlySet<string>): IParkedRequest[] =>
  items.map((item) => {
    const { id, kind, ...question } = item
    const call = subagentCallOf(item, subagents)
    return { requestId: id, kind, question, ...(call ? { subagent: call } : {}) }
  })

// The answers the workflow collected, as the core takes them (the value is the answer).
export const coreAnswersOf = (answers: Record<string, IAnswer>): Record<string, ParkAnswer> =>
  Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, a.value as ParkAnswer]))

export interface IActivityDeps {
  agent: Pick<IAgent, 'run'>
  runs: IRunStore
  events: IEventStore
  parked: IParkedStore
  log: ILogger
  // The static subagents' agents, by tool name (their profiles; SUBAGENTS).
  subagents?: ReadonlyMap<string, Pick<IAgent, 'run'>>
}

interface IRunOne {
  // The session - or a child's own stream.
  stream: string
  turn: number
  agent: Pick<IAgent, 'run'>
  input: string
  history: IConversationTurn[]
  answers?: Record<string, IAnswer>
  started: Record<string, unknown>
  subagents?: ITurnInput['subagents']
}

export const createActivities = (deps: IActivityDeps) => {
  const { runs, events, parked, log } = deps
  const subagentNames = new Set(deps.subagents?.keys() ?? [])

  // The run's items, recorded for the gateway, and the `parked` result.
  const parkedResult = async (
    stream: string,
    turn: number,
    runId: string,
    attempt: number,
    attemptBase: number,
    items: ParkedItem[],
  ): Promise<TurnResult> => {
    const requests = requestsOf(items, subagentNames)
    await parked.record(
      requests.map((r) => ({
        sessionId: stream,
        itemId: r.requestId,
        turn,
        runId,
        kind: r.kind,
        answeredBy: r.subagent ? 'subagent' : 'client',
        ...(r.subagent ? { childId: subagentWorkflowIdOf(stream, runId, r.requestId) } : {}),
        item: {
          kind: r.kind,
          ...(r.question as object),
          ...(r.subagent ? { subagent: r.subagent } : {}),
        },
      })),
    )
    return { status: 'parked', runId, attempt, turnAttempt: attemptBase + attempt, requests }
  }

  const runOne = async (o: IRunOne): Promise<TurnResult> => {
    const ctx = Context.current()
    const { stream, turn } = o
    await events.marker({ kind: 'started', sessionId: stream, turn, body: o.started })
    const answerIds = Object.keys(o.answers ?? {})
    const plan = planTurn(await runs.latestRunOfTurn(stream, turn), answerIds)
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
    if (plan.kind === 'parked') {
      const s = plan.row.snapshot!
      return parkedResult(
        stream,
        turn,
        s.runId,
        s.attempt ?? 1,
        plan.row.attemptBase,
        s.parked?.items ?? [],
      )
    }
    const intent: TurnIntent =
      plan.kind === 'resume'
        ? plan
        : {
            kind: 'fresh',
            runNo: plan.runNo,
            attemptBase: plan.first ? 0 : await runs.nextAttemptBase(stream, turn),
          }
    if (plan.kind === 'resume' && answerIds.length) {
      // The turn goes on with them: the gateway refuses another answer from now on.
      await parked.markAnswered(stream, answerIds)
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
      sessionId: stream,
      turn,
      attemptBase: intent.attemptBase,
      onError: (err, dropped) =>
        log.warn('events dropped', { stream, turn, dropped, error: errorMessage(err) }),
    })
    let last: { runId?: string; attempt?: number } = {}
    const scope: ITurnScope = {
      sessionId: stream,
      turn,
      intent,
      heartbeat: (details) => ctx.heartbeat(details),
      revoked,
      ...(o.subagents ? { subagents: { ...o.subagents, dispatched: 0 } } : {}),
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
        o.agent.run(
          intent.kind === 'resume'
            ? {
                input: '',
                resumeFromRunId: intent.runId,
                ...(answerIds.length ? { answers: coreAnswersOf(o.answers!) } : {}),
                signal: stop.signal,
                onEvent,
              }
            : { input: o.input, history: o.history, signal: stop.signal, onEvent },
        ),
      )
    } catch (err) {
      await writer.flush()
      ctx.cancellationSignal.removeEventListener('abort', onCancel)
      const runId = scope.runId ?? last.runId
      const why = revoked()
      if (why || err instanceof RunLeaseError) {
        log.warn('turn moved', { stream, turn, runId, reason: why ?? errorMessage(err) })
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
      log.warn('turn failed', { stream, turn, runId, error: errorMessage(err) })
      throw ApplicationFailure.retryable(errorMessage(err), 'TurnFailed')
    }
    await writer.flush()
    ctx.cancellationSignal.removeEventListener('abort', onCancel)
    const runId = scope.runId ?? result.parked?.runId ?? last.runId ?? ''
    if (result.parked) {
      return parkedResult(
        stream,
        turn,
        result.parked.runId,
        last.attempt ?? 1,
        intent.attemptBase,
        result.parked.items,
      )
    }
    return {
      status: 'completed',
      runId,
      attempt: last.attempt ?? 1,
      text: result.text,
      usage: result.usage,
      ...(result.compactedHistory ? { compactedHistory: result.compactedHistory } : {}),
    }
  }

  const runTurn = (input: ITurnInput): Promise<TurnResult> =>
    runOne({
      stream: input.sessionId,
      turn: input.turn,
      agent: deps.agent,
      input: input.input,
      history: input.history,
      ...(input.answers ? { answers: input.answers } : {}),
      started: {
        messageIds: input.messageIds,
        input: input.input,
        ...(input.answers ? { resumed: Object.keys(input.answers) } : {}),
      },
      ...(input.subagents ? { subagents: input.subagents } : {}),
    })

  // One static subagent call: its profile's agent on the task, as turn 1 of its own stream - so a
  // retry (the worker died) finds the child's run and resumes it, and a second start of the same
  // child returns the answer it already has.
  const runSubagent = async (input: ISubagentInput): Promise<SubagentOutcome> => {
    const agent = deps.subagents?.get(input.name)
    if (!agent) {
      throw ApplicationFailure.retryable(
        `subagent "${input.name}" is not configured on this worker (SUBAGENTS)`,
        'SubagentUnknown',
      )
    }
    const out = await runOne({
      stream: input.stream,
      turn: 1,
      agent,
      input: input.task,
      history: [],
      started: {
        input: input.task,
        name: input.name,
        parent: { sessionId: input.sessionId, turn: input.turn, runId: input.parentRunId },
        itemId: input.itemId,
      },
    })
    if (out.status === 'parked') {
      // A child has no one to ask and no subagents of its own: its approvals are decided by the
      // worker's mode and rules (an 'ask' is a denial), so this is a misconfiguration.
      throw ApplicationFailure.nonRetryable(
        `subagent "${input.name}" parked: a subagent's run cannot wait for answers`,
        TURN_REFUSED,
      )
    }
    if (out.status === 'completed') {
      return {
        status: 'completed',
        runId: out.runId,
        attempt: out.attempt,
        text: out.text.slice(0, SUBAGENT_TEXT_MAX_CHARS),
        usage: out.usage,
      }
    }
    return out
  }

  const endTurn = async (end: ITurnEnd): Promise<void> => {
    const { sessionId, turn, ...body } = end
    await events.marker({ kind: 'ended', sessionId, turn, body })
    // Whatever the turn still waited for is over with it (a stopped park).
    await parked.cancelTurn(sessionId, turn)
  }

  const writeMarkers = async (markers: IStreamMarker[]): Promise<void> => {
    await events.streamMarkers(markers)
  }

  return { runTurn, runSubagent, endTurn, writeMarkers }
}

export type SwarmActivities = ReturnType<typeof createActivities>
