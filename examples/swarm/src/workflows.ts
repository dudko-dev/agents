// The session workflow: one per conversation. Deterministic and small - the logic is in
// session-state.ts; this file is the Temporal wiring.
//
//   wait for a message (or an answer to a parked turn) -> run ONE turn as an activity -> append it
//   to the history -> write the turn.ended marker -> wait again
//
// Continue-as-new carries the state when Temporal suggests it or after maxTurnsPerRun turns.
//
// A turn that parks on static subagent calls starts one child workflow `subagent` per call (in
// parallel, ids from session + run + item); each child's outcome answers its item, and the turn
// goes on once every item has its answer. The session holds no activity slot while they run.
import {
  ActivityCancellationType,
  allHandlersFinished,
  CancellationScope,
  CancelledFailure,
  condition,
  continueAsNew,
  isCancellation,
  ParentClosePolicy,
  patched,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
} from '@temporalio/workflow'
import type { SwarmActivities } from './activities.ts'
import {
  answerSignal,
  messageSignal,
  PATCH_SUBAGENTS,
  stateQuery,
  stopSignal,
  SUBAGENT_WORKFLOW,
  TURN_REFUSED,
} from './session-api.ts'
import {
  acceptAnswer,
  acceptMessage,
  acceptStop,
  carry,
  childFinished,
  childrenRunning,
  finishTurn,
  hasWork,
  initialState,
  shouldContinueAsNew,
  startChildren,
  takeTurn,
  view,
  type ISessionCarry,
  type TurnOutcome,
} from './session-state.ts'
import type {
  ISessionOptions,
  ISessionView,
  ISubagentInput,
  SubagentOutcome,
} from './session-types.ts'

export interface ISessionInput {
  sessionId: string
  options: ISessionOptions
  carry?: ISessionCarry
}

const messageOf = (err: unknown): string => {
  // An ActivityFailure says "Activity task failed"; the reason is its cause.
  let e = err as { message?: string; cause?: unknown } | undefined
  while (e?.cause && typeof e.cause === 'object') {
    e = e.cause as { message?: string; cause?: unknown }
  }
  return e?.message || String(err)
}

export async function session(input: ISessionInput): Promise<ISessionView> {
  const state = initialState(input.sessionId, input.options, input.carry)
  const o = state.options

  const { runTurn } = proxyActivities<SwarmActivities>({
    startToCloseTimeout: o.turnTimeoutMs,
    heartbeatTimeout: o.heartbeatTimeoutMs,
    // A stop waits until the run is really aborted: the next turn must not overlap it.
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      initialInterval: '1s',
      backoffCoefficient: 2,
      maximumInterval: '30s',
      maximumAttempts: o.maxTurnAttempts,
      nonRetryableErrorTypes: [TURN_REFUSED],
    },
  })
  const { endTurn } = proxyActivities<SwarmActivities>({
    startToCloseTimeout: '1 minute',
    retry: { initialInterval: '1s', maximumInterval: '10s' },
  })

  let scope: CancellationScope | undefined
  let ended = false
  setHandler(messageSignal, (message) => {
    acceptMessage(state, message)
  })
  // The children of the parked turn (cancelled by a stop).
  let children: CancellationScope | undefined
  const { writeMarkers } = proxyActivities<SwarmActivities>({
    startToCloseTimeout: '1 minute',
    retry: { initialInterval: '1s', maximumInterval: '10s' },
  })
  setHandler(answerSignal, (answer) => {
    // A client's: an item a subagent answers, or one the turn does not wait for, is refused.
    acceptAnswer(state, { ...answer, by: 'client' })
  })
  setHandler(stopSignal, (stop) => {
    acceptStop(state, stop, Date.now())
    if (state.stopping) {
      scope?.cancel()
    }
    if (!state.parked) {
      children?.cancel()
      children = undefined
    }
  })
  setHandler(stateQuery, () => view(state, ended))

  // One child workflow per static subagent call of the parked turn. Started in a scope of their
  // own (a stop cancels it); each result answers its item, in the order the children end.
  const startSubagents = async (): Promise<void> => {
    const starts = startChildren(state, Date.now())
    if (starts.length === 0) {
      return
    }
    const mine = new CancellationScope()
    children = mine
    const failed = (requestId: string, err: unknown): void => {
      if (!isCancellation(err)) {
        childFinished(state, requestId, { status: 'failed', error: messageOf(err) }, Date.now())
      }
    }
    await mine.run(() =>
      Promise.all(
        starts.map(async (s) => {
          try {
            const child = await startChild<(input: ISubagentInput) => Promise<SubagentOutcome>>(
              SUBAGENT_WORKFLOW,
              {
                workflowId: s.workflowId,
                args: [s.input],
                // The session ending (stop + end) cancels what still runs.
                parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
              },
            )
            void child.result().then(
              (outcome) => void childFinished(state, s.requestId, outcome, Date.now()),
              (err: unknown) => failed(s.requestId, err),
            )
          } catch (err) {
            failed(s.requestId, err)
          }
        }),
      ),
    )
  }

  for (;;) {
    // The turn.ended markers first: a client waiting on the stream learns the outcome.
    while (state.endings.length) {
      await endTurn(state.endings[0]!)
      state.endings.shift()
    }
    // The subagent markers, in the order they were queued (their seq order).
    while (state.markers.length) {
      const batch = state.markers.slice()
      await writeMarkers(batch)
      state.markers.splice(0, batch.length)
    }
    if (state.ending) {
      break
    }
    if (shouldContinueAsNew(state, workflowInfo().continueAsNewSuggested)) {
      await condition(allHandlersFinished)
      await continueAsNew<typeof session>({ ...input, carry: carry(state) })
    }
    const ready = (): boolean => state.ending || hasWork(state)
    // No idle end while children work for the parked turn.
    if (o.idleTimeoutMs > 0 && !childrenRunning(state)) {
      if (!(await condition(ready, o.idleTimeoutMs))) {
        break
      }
    } else {
      await condition(ready)
    }
    // Markers first: one queued now (a child that just ended) belongs before the next turn's
    // events in the stream.
    if (state.endings.length || state.markers.length) {
      continue
    }
    const next = takeTurn(state, Date.now())
    if (!next) {
      continue
    }
    let outcome: TurnOutcome
    scope = new CancellationScope()
    try {
      outcome = await scope.run(() => runTurn(next))
    } catch (err) {
      outcome =
        state.stopping && isCancellation(err)
          ? { status: 'stopped' }
          : { status: 'failed', error: messageOf(err) }
    } finally {
      scope = undefined
    }
    finishTurn(state, next, outcome, Date.now())
    if (
      outcome.status === 'parked' &&
      outcome.requests.some((r) => r.subagent) &&
      patched(PATCH_SUBAGENTS)
    ) {
      await startSubagents()
    }
  }
  ended = true
  await condition(allHandlersFinished)
  return view(state, true)
}

// The child workflow of one static subagent call: one activity, one agent.run of the profile on
// the task (its own run and its own stream in Postgres), then its turn.ended marker. A failure is a
// value (the parent answers the item with it); a cancellation (the parent's stop) is not.
export async function subagent(input: ISubagentInput): Promise<SubagentOutcome> {
  const o = input.options
  const { runSubagent } = proxyActivities<SwarmActivities>({
    startToCloseTimeout: o.turnTimeoutMs,
    heartbeatTimeout: o.heartbeatTimeoutMs,
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      initialInterval: '1s',
      backoffCoefficient: 2,
      maximumInterval: '30s',
      maximumAttempts: o.maxTurnAttempts,
      nonRetryableErrorTypes: [TURN_REFUSED],
    },
  })
  const { endTurn } = proxyActivities<SwarmActivities>({
    startToCloseTimeout: '1 minute',
    retry: { initialInterval: '1s', maximumInterval: '10s' },
  })
  let outcome: SubagentOutcome
  let cancelled: unknown
  try {
    outcome = await runSubagent(input)
  } catch (err) {
    if (isCancellation(err)) {
      cancelled = err
      outcome = { status: 'stopped' }
    } else {
      outcome = { status: 'failed', error: messageOf(err) }
    }
  }
  // Written whatever happened - a cancelled workflow schedules nothing unless it is told to.
  await CancellationScope.nonCancellable(() =>
    endTurn({
      sessionId: input.stream,
      turn: 1,
      status: outcome.status,
      ...(outcome.status === 'completed' ? { text: outcome.text, usage: outcome.usage } : {}),
      ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
      ...(outcome.status !== 'failed' && outcome.runId ? { runId: outcome.runId } : {}),
      ...(outcome.status !== 'failed' && outcome.attempt ? { attempt: outcome.attempt } : {}),
    }),
  )
  // The parent stopped it (the run aborted and recorded 'cancelled'): the child ends cancelled.
  if (cancelled || CancellationScope.current().consideredCancelled) {
    throw cancelled ?? new CancelledFailure('the session stopped the subagent')
  }
  return outcome
}
