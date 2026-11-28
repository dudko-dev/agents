// The session workflow: one per conversation. Deterministic and small - the logic is in
// session-state.ts; this file is the Temporal wiring.
//
//   wait for a message (or an answer to a parked turn) -> run ONE turn as an activity -> append it
//   to the history -> write the turn.ended marker -> wait again
//
// Continue-as-new carries the state when Temporal suggests it or after maxTurnsPerRun turns.
import {
  ActivityCancellationType,
  allHandlersFinished,
  CancellationScope,
  condition,
  continueAsNew,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow'
import type { SwarmActivities } from './activities.ts'
import { answerSignal, messageSignal, stateQuery, stopSignal, TURN_REFUSED } from './session-api.ts'
import {
  acceptAnswer,
  acceptMessage,
  acceptStop,
  carry,
  finishTurn,
  hasWork,
  initialState,
  shouldContinueAsNew,
  takeTurn,
  view,
  type ISessionCarry,
  type TurnOutcome,
} from './session-state.ts'
import type { ISessionOptions, ISessionView } from './session-types.ts'

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
  setHandler(answerSignal, (answer) => {
    acceptAnswer(state, answer)
  })
  setHandler(stopSignal, (stop) => {
    acceptStop(state, stop, Date.now())
    if (state.stopping) {
      scope?.cancel()
    }
  })
  setHandler(stateQuery, () => view(state, ended))

  for (;;) {
    // The turn.ended markers first: a client waiting on the stream learns the outcome.
    while (state.endings.length) {
      await endTurn(state.endings[0]!)
      state.endings.shift()
    }
    if (state.ending) {
      break
    }
    if (shouldContinueAsNew(state, workflowInfo().continueAsNewSuggested)) {
      await condition(allHandlersFinished)
      await continueAsNew<typeof session>({ ...input, carry: carry(state) })
    }
    const ready = (): boolean => state.ending || hasWork(state)
    if (o.idleTimeoutMs > 0) {
      if (!(await condition(ready, o.idleTimeoutMs))) {
        break
      }
    } else {
      await condition(ready)
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
  }
  ended = true
  await condition(allHandlersFinished)
  return view(state, true)
}
