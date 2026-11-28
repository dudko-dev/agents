// The session workflow: one per conversation. Deterministic and small - the logic is in
// swarm-shared (`swarm-shared/workflow`: session-state.ts, child-state.ts, pipeline-state.ts, the
// same on every platform); this file is the Temporal wiring.
//
//   wait for a message (or an answer to a parked turn) -> run ONE turn as an activity -> append it
//   to the history -> write the turn.ended marker -> wait again
//
// Continue-as-new carries the state when Temporal suggests it or after maxTurnsPerRun turns.
//
// A turn that parks on static subagent calls starts one child workflow `subagent` per call (in
// parallel, ids from session + run + item); each child's outcome answers its item, and the turn
// goes on once every item has its answer. The session holds no activity slot while they run.
//
// A pipeline call is the same, with a child workflow `pipeline`: the core's graph engine runs in
// it as the deterministic scheduler, and every node visit is a child workflow `pipelineNode` of
// its own (one activity: the node's agent.run, and its route call). Temporal's history is the
// graph's snapshot: replayed after a crash, the engine gets the finished visits' answers from it.
//
// A child whose run parks on a person (an "ask" of the approval mode) waits like the session does,
// holding no slot: its workflow takes the answers the gateway signals to it, checks each one, and
// resumes the same run once every item has its answer (swarm-shared's child-state.ts); it tells
// the session when it starts and stops waiting (childParkSignal: the state shows it, the stream
// gets a marker).
import {
  ActivityCancellationType,
  allHandlersFinished,
  CancellationScope,
  CancelledFailure,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  isCancellation,
  ParentClosePolicy,
  patched,
  proxyActivities,
  setHandler,
  startChild,
  workflowInfo,
} from '@temporalio/workflow'
// The engine only - never the main entry (`ai`, `zod`, MCP, `node:*`): `tests/bundle.test.ts`.
import {
  preparePipeline,
  runPipelineGraph,
  type PipelineNodeRunner,
} from '@dudko.dev/agent/pipeline-engine'
import {
  acceptAnswer,
  acceptChildAnswer,
  acceptMessage,
  acceptStop,
  carry,
  childFinished,
  childPark,
  childParked,
  childReady,
  childrenRunning,
  childView,
  childWorkflowIdOf,
  closeChildWait,
  completedOutcomeOf,
  createAbortLatch,
  createStreamLog,
  emptyUsage,
  failedOutcomeOf,
  finishTurn,
  hasWork,
  initialChildWait,
  initialState,
  isAbortError,
  nodeInputOf,
  nodeOutputOf,
  pipelineFinished,
  shouldContinueAsNew,
  startChildren,
  sumUsage,
  takeChildAnswers,
  takeTurn,
  view,
  workflowIdOf,
  type IAnswer,
  type IChildParked,
  type IChildParkNotice,
  type IChildWait,
  type IPipelineInput,
  type IPipelineNodeInput,
  type ISessionCarry,
  type ISessionOptions,
  type ISessionView,
  type ISubagentInput,
  type ITally,
  type PipelineNodeOutcome,
  type PipelineOutcome,
  type SubagentOutcome,
  type TurnOutcome,
} from 'swarm-shared/workflow'
import type { SwarmActivities } from './activities.ts'
import {
  answerSignal,
  childParkSignal,
  childStateQuery,
  messageSignal,
  PATCH_CHILD_PARKING,
  PATCH_PIPELINES,
  PATCH_SUBAGENTS,
  PIPELINE_NODE_WORKFLOW,
  PIPELINE_WORKFLOW,
  stateQuery,
  stopSignal,
  SUBAGENT_WORKFLOW,
  TURN_REFUSED,
} from './session-api.ts'

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

// The child side of a child's park: run the activity; while it reports `parked`, tell the session,
// wait (no slot held) until every item has an answer the workflow accepted, tell the session
// again and resume the same run with them. A partial answer keeps it waiting; a resume that parks
// again waits again. A stop cancels the wait (condition rejects with the scope).
const untilAnswered = async <T extends { status: string }>(
  wait: IChildWait,
  run: (answers?: Record<string, IAnswer>) => Promise<T | IChildParked>,
  tell: (
    notice: Pick<IChildParkNotice, 'state' | 'runId' | 'requests' | 'answered'>,
  ) => Promise<void>,
): Promise<T> => {
  let answers: Record<string, IAnswer> | undefined
  for (;;) {
    const out = await run(answers)
    if (out.status !== 'parked') {
      return out as T
    }
    const parked = out as IChildParked
    childParked(wait, parked, Date.now())
    await tell({ state: 'waiting', runId: parked.runId, requests: parked.requests })
    await condition(() => childReady(wait))
    answers = takeChildAnswers(wait)
    await tell({ state: 'resumed', runId: parked.runId, answered: Object.keys(answers) })
  }
}

// What a child tells its session (childParkSignal). Best effort: a session that is gone has
// stopped its children already; a cancellation is the child's own and goes on up.
const tellSession =
  (
    sessionId: string,
    who: Pick<IChildParkNotice, 'itemId' | 'kind' | 'workflowId' | 'nodeId' | 'visit'>,
  ) =>
  async (
    notice: Pick<IChildParkNotice, 'state' | 'runId' | 'requests' | 'answered'>,
  ): Promise<void> => {
    try {
      await getExternalWorkflowHandle(workflowIdOf(sessionId)).signal(childParkSignal, {
        ...who,
        ...notice,
        at: Date.now(),
      })
    } catch (err) {
      if (isCancellation(err)) {
        throw err
      }
    }
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
  // A child of the parked turn waits for a person, or goes on (behind the patch: only a child
  // new enough to wait sends it, and the markers it queues are new commands).
  setHandler(childParkSignal, (notice) => {
    if (patched(PATCH_CHILD_PARKING)) {
      childPark(state, notice, Date.now())
    }
  })

  // One child workflow per static subagent call and per pipeline call of the parked turn, every
  // start decided at once (startChildren: so the markers stay in order). Started in a scope of
  // their own (a stop cancels it); each result answers its item, in the order the children end.
  const startChildWorkflows = async (kinds: {
    subagents: boolean
    pipelines: boolean
  }): Promise<void> => {
    const starts = startChildren(state, Date.now(), kinds)
    if (starts.length === 0) {
      return
    }
    const mine = new CancellationScope()
    children = mine
    const failed = (kind: 'subagent' | 'pipeline', requestId: string, err: unknown): void => {
      if (isCancellation(err)) {
        return
      }
      if (kind === 'pipeline') {
        pipelineFinished(
          state,
          requestId,
          { status: 'failed', error: messageOf(err), runs: 0, usage: emptyUsage() },
          Date.now(),
        )
      } else {
        childFinished(state, requestId, { status: 'failed', error: messageOf(err) }, Date.now())
      }
    }
    await mine.run(() =>
      Promise.all(
        starts.map(async (s) => {
          try {
            if (s.kind === 'pipeline') {
              const child = await startChild<typeof pipeline>(PIPELINE_WORKFLOW, {
                workflowId: s.workflowId,
                args: [s.input],
                parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
              })
              void child.result().then(
                (outcome) => void pipelineFinished(state, s.requestId, outcome, Date.now()),
                (err: unknown) => failed('pipeline', s.requestId, err),
              )
              return
            }
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
              (err: unknown) => failed('subagent', s.requestId, err),
            )
          } catch (err) {
            failed(s.kind, s.requestId, err)
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
    if (outcome.status === 'parked') {
      // Each kind behind its own patch: a session recorded before pipelines never asks the
      // second one (its parks have no pipeline items), so it replays the same commands.
      const subagents = outcome.requests.some((r) => r.subagent) && patched(PATCH_SUBAGENTS)
      const pipelines = outcome.requests.some((r) => r.pipeline) && patched(PATCH_PIPELINES)
      if (subagents || pipelines) {
        await startChildWorkflows({ subagents, pipelines })
      }
    }
  }
  ended = true
  await condition(allHandlersFinished)
  return view(state, true)
}

// The child workflow of one static subagent call: one activity, one agent.run of the profile on
// the task (its own run and its own stream in Postgres), then its turn.ended marker. A failure is a
// value (the parent answers the item with it); a cancellation (the parent's stop) is not. A run
// that parks on a person waits here for the answers (untilAnswered) - behind the patch: a child
// started before it never parks (its activity is not told it may), its asks are denials.
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
  const parking = patched(PATCH_CHILD_PARKING)
  const wait = initialChildWait()
  setHandler(answerSignal, (answer) => {
    acceptChildAnswer(wait, { ...answer, by: 'client' })
  })
  setHandler(childStateQuery, () => childView(wait))
  const workflowId = childWorkflowIdOf(input.sessionId, input.parentRunId, input.itemId)
  let outcome: SubagentOutcome
  let cancelled: unknown
  try {
    outcome = parking
      ? await untilAnswered<SubagentOutcome>(
          wait,
          (answers) => runSubagent({ ...input, park: true, ...(answers ? { answers } : {}) }),
          tellSession(input.sessionId, { itemId: input.itemId, kind: 'subagent', workflowId }),
        )
      : ((await runSubagent(input)) as SubagentOutcome)
  } catch (err) {
    if (isCancellation(err)) {
      cancelled = err
      outcome = { status: 'stopped' }
    } else {
      outcome = { status: 'failed', error: messageOf(err) }
    }
  }
  closeChildWait(wait)
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
      ...(parking ? { closes: { sessionId: input.sessionId, owner: workflowId } } : {}),
    }),
  )
  // The parent stopped it (the run aborted and recorded 'cancelled'): the child ends cancelled.
  if (cancelled || CancellationScope.current().consideredCancelled) {
    throw cancelled ?? new CancelledFailure('the session stopped the subagent')
  }
  return outcome
}

// The child workflow of one pipeline call: the core's graph engine is the scheduler, here, in the
// workflow - deterministic by contract (no clock, no randomness, no I/O), so a replay of this
// history makes the same calls in the same order and gets every finished visit's answer from the
// history. Every node VISIT is a child workflow `pipelineNode` (one activity: the node's
// agent.run and its route call); the visits of a wave are started together, so a wave runs in
// parallel across the swarm. The engine's own events go to the pipeline's stream through one
// activity at a time (createStreamLog says why that replays). A failure is a value (the parent
// answers the item with it); a cancellation (the session's stop) is not.
//
// Abort: a stop cancels this workflow; its cancellation scope aborts the signal the engine reads,
// and the engine settles at once with onAbort 'reject' - an AbortError, which cannot be mistaken
// for a result (with 'resolve' a stopped run would look finished but for `stoppedBy`), and a
// stopped pipeline gives the parent nothing to read anyway: the parked turn is stopped with it.
// The visits in flight are cancelled with the scope; the workflow waits for them to end (their
// streams get their turn.ended) before it writes its own.
export async function pipeline(input: IPipelineInput): Promise<PipelineOutcome> {
  const o = input.options
  const { pipelineDefinition } = proxyActivities<SwarmActivities>({
    startToCloseTimeout: '30 seconds',
    retry: {
      initialInterval: '1s',
      backoffCoefficient: 2,
      maximumInterval: '30s',
      maximumAttempts: o.maxTurnAttempts,
    },
  })
  // Short writes, retried soon: the stream's writer waits for each (a worker that died with one
  // in flight costs its timeout, not the session's minute).
  const { endTurn, writeStream } = proxyActivities<SwarmActivities>({
    startToCloseTimeout: '15 seconds',
    retry: { initialInterval: '1s', maximumInterval: '10s' },
  })
  const root = CancellationScope.current()
  const log = createStreamLog(input)
  let closed = false
  // One write at a time, in order, whatever happens to the run (a cancelled scope schedules
  // nothing, so the writer is not cancellable).
  const writer = CancellationScope.nonCancellable(async () => {
    await writeStream({
      stream: input.stream,
      started: {
        input: input.task,
        name: input.name,
        parent: { sessionId: input.sessionId, turn: input.turn, runId: input.parentRunId },
        itemId: input.itemId,
        workflowId: input.workflowId,
      },
      events: [],
    })
    for (;;) {
      await condition(() => closed || log.pending() > 0)
      const batch = log.take()
      if (!batch) {
        return
      }
      await writeStream(batch)
    }
  })
  const tally: ITally = { runs: 0, usage: emptyUsage() }
  // Every visit's child, so the workflow can wait for the ones a failure or a stop cancelled.
  const visits: Promise<unknown>[] = []
  const runNode: PipelineNodeRunner = async (node, nodeInput, ctx) => {
    tally.runs += 1
    const args = nodeInputOf(input, node, nodeInput)
    // Its own scope: a failure elsewhere in the wave aborts ctx.signal (the engine's rule), and
    // that cancels this visit; a stop cancels it with the workflow's scope.
    const scope = new CancellationScope()
    const cancel = (): void => scope.cancel()
    ctx.signal.addEventListener('abort', cancel)
    const run = scope.run(async () => {
      const child = await startChild<typeof pipelineNode>(PIPELINE_NODE_WORKFLOW, {
        workflowId: args.workflowId,
        args: [args],
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      })
      return child.result()
    })
    visits.push(run)
    try {
      const outcome = await run
      if (outcome.status === 'completed') {
        tally.usage = sumUsage(tally.usage, outcome.usage)
      }
      return nodeOutputOf(outcome)
    } catch (err) {
      // A Temporal failure says "Child Workflow execution failed"; the reason is its cause.
      throw new Error(messageOf(err))
    } finally {
      ctx.signal.removeEventListener('abort', cancel)
    }
  }
  let outcome: PipelineOutcome
  let cancelled: unknown
  try {
    const { definition } = await pipelineDefinition({ name: input.name })
    const plan = preparePipeline(definition)
    const latch = createAbortLatch()
    root.cancelRequested.catch(() => latch.abort())
    const result = await runPipelineGraph(plan, runNode, {
      input: input.task,
      signal: latch.signal,
      onEvent: (event) => log.push(event),
      onAbort: 'reject',
    })
    outcome = completedOutcomeOf(result, tally)
  } catch (err) {
    if (isCancellation(err) || isAbortError(err)) {
      cancelled = err
      outcome = { status: 'stopped', runs: tally.runs, usage: tally.usage }
    } else {
      outcome = failedOutcomeOf(err, tally)
    }
  }
  // The visits a failure or a stop cancelled end first: their own streams get their turn.ended.
  await Promise.allSettled(visits)
  closed = true
  await writer
  await CancellationScope.nonCancellable(() =>
    endTurn({
      sessionId: input.stream,
      turn: 1,
      status: outcome.status,
      ...(outcome.status === 'completed' ? { text: outcome.text } : {}),
      ...(outcome.status === 'completed' && outcome.stoppedBy
        ? { stoppedBy: outcome.stoppedBy }
        : {}),
      ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
      runs: outcome.runs,
      usage: outcome.usage,
    }),
  )
  if (cancelled || root.consideredCancelled) {
    throw isCancellation(cancelled)
      ? cancelled
      : new CancelledFailure('the session stopped the pipeline')
  }
  return outcome
}

// One visit of one pipeline node: one activity - the node's agent.run on its input, then its
// route call (where the node ran, as the core's runner contract says) - and its stream's
// turn.ended. Like a subagent child: a failure is a value, a cancellation is not, and a run that
// parks on a person waits here for the answers (the pipeline simply waits for the visit).
export async function pipelineNode(input: IPipelineNodeInput): Promise<PipelineNodeOutcome> {
  const o = input.options
  const { runPipelineNode } = proxyActivities<SwarmActivities>({
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
  const parking = patched(PATCH_CHILD_PARKING)
  const wait = initialChildWait()
  setHandler(answerSignal, (answer) => {
    acceptChildAnswer(wait, { ...answer, by: 'client' })
  })
  setHandler(childStateQuery, () => childView(wait))
  let outcome: PipelineNodeOutcome
  let cancelled: unknown
  try {
    outcome = parking
      ? await untilAnswered<PipelineNodeOutcome>(
          wait,
          (answers) => runPipelineNode({ ...input, park: true, ...(answers ? { answers } : {}) }),
          tellSession(input.sessionId, {
            itemId: input.itemId,
            kind: 'pipeline',
            workflowId: input.workflowId,
            nodeId: input.node.id,
            visit: input.input.visit,
          }),
        )
      : ((await runPipelineNode(input)) as PipelineNodeOutcome)
  } catch (err) {
    if (isCancellation(err)) {
      cancelled = err
      outcome = { status: 'stopped' }
    } else {
      outcome = { status: 'failed', error: messageOf(err) }
    }
  }
  closeChildWait(wait)
  await CancellationScope.nonCancellable(() =>
    endTurn({
      sessionId: input.stream,
      turn: 1,
      status: outcome.status,
      ...(outcome.status === 'completed'
        ? {
            text: outcome.text,
            usage: outcome.usage,
            ...(outcome.route ? { route: outcome.route } : {}),
          }
        : {}),
      ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
      ...(outcome.status !== 'failed' && outcome.runId ? { runId: outcome.runId } : {}),
      ...(outcome.status !== 'failed' && outcome.attempt ? { attempt: outcome.attempt } : {}),
      ...(parking ? { closes: { sessionId: input.sessionId, owner: input.workflowId } } : {}),
    }),
  )
  if (cancelled || CancellationScope.current().consideredCancelled) {
    throw cancelled ?? new CancelledFailure('the pipeline stopped the node')
  }
  return outcome
}
