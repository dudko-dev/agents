// The activities: `runTurn` - one ordinary `agent.run` - `runSubagent` - one agent.run of a static
// subagent, inside its child workflow - `pipelineDefinition` and `runPipelineNode` - a pipeline's
// graph, and one visit of one of its nodes (its agent.run and its route call), inside the node's
// child workflow - and the stream writes: `endTurn` (turn.ended), `writeMarkers` (the child
// markers in the parent turn's stream) and `writeStream` (a pipeline's own stream).
//
// A retried turn (its worker died, its heartbeat timed out, the provider was down) finds its run
// by (session, turn) and goes on from the last snapshot under the next attempt - with the call
// journal, the step a crash interrupted is REPLAYED, not run again. The decision is `planTurn`,
// pure:
//
//   no run yet, or one that died before its plan  -> a fresh run (the next run_no of the turn),
//                                                    under an id the activity names (`runIdOf`)
//   a snapshot with a plan, not finished           -> resume it (`resumeFromRunId`, + `answers`)
//   'waiting', and no answer for what it waits for -> the run is parked: report it again
//   'complete'   -> the run finished but its result never reached Temporal: return it
//   'cancelled'  -> the user stopped it: the turn is stopped
//
// A run that PARKS (a person's question under the approval mode, a deferred tool result, a static
// subagent call) resolves; the activity records its items (swarm_parked) and returns `parked`.
// The workflow collects the answers and runs the activity again, which resumes the run with them.
import { createHash } from 'node:crypto'
import { Context } from '@temporalio/activity'
import { ApplicationFailure, type ActivityCancellationDetails } from '@temporalio/common'
import {
  addUsage,
  isAuthError,
  isModelCallRefused,
  pickPipelineRoute,
  renderPipelineNodeInput,
  RunLeaseError,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type IAgentRunResult,
  type IConversationTurn,
  type IUsage,
  type ParkAnswer,
  type ParkedItem,
  type PipelineDefinition,
  type PipelineNode,
} from '@dudko.dev/agent'
import type { IEventStore } from './db/events.ts'
import type { IParkedStore } from './db/parked.ts'
import type { IRunRow, IRunStore } from './db/runs.ts'
import { withTurnScope, type ITurnScope, type TurnIntent } from './lease.ts'
import { errorMessage, type ILogger } from './log.ts'
import { PIPELINE_TEXT_MAX_CHARS } from './pipeline-state.ts'
import { canonicalJson } from './pipelines.ts'
import { pipelineWorkflowIdOf, subagentWorkflowIdOf, TURN_REFUSED } from './session-api.ts'
import type {
  IAnswer,
  IChildBudget,
  IParkedRequest,
  IPipelineCall,
  IPipelineNodeInput,
  IStreamBatch,
  IStreamMarker,
  ISubagentCall,
  ISubagentInput,
  ITurnEnd,
  ITurnInput,
  PipelineNodeOutcome,
  SubagentOutcome,
  TurnResult,
} from './session-types.ts'

// The core's isAuthError: the provider refused the credentials (401 / 403 anywhere down the cause
// chain), so the next attempt would be refused too.
export { isAuthError }

// A child's answer, as the parent's item gets it (and as Temporal carries it).
export const SUBAGENT_TEXT_MAX_CHARS = 32_000

// A fresh run's id, named by the activity (`agent.run({ runId })`): a function of where it runs -
// the stream (a session, a child's own stream), the turn and the run's number in the turn - so a
// run can be named from its turn alone, and the lease knows which run to expect before the core
// starts it. The core refuses the id when it is taken already (a snapshot or journal entries
// under it): that is a run a retry RESUMES (planTurn finds it), never one started again.
export const runIdOf = (stream: string, turn: number, runNo: number): string =>
  `run-${createHash('sha256').update(`${stream}\n${turn}\n${runNo}`).digest('hex').slice(0, 32)}`

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

// A pipeline's call, read from its parked item: the tool is one of the pipelines and its input is
// `{ task }` (the tool is the core's remote subagent tool). Anything else is an ordinary item.
export const pipelineCallOf = (
  item: ParkedItem,
  pipelines: ReadonlySet<string>,
): IPipelineCall | undefined => {
  if (item.kind !== 'tool' || !pipelines.has(item.toolName)) {
    return undefined
  }
  const input = (item.input ?? {}) as { task?: unknown }
  return typeof input.task === 'string' ? { name: item.toolName, task: input.task } : undefined
}

// The core's items as the workflow keeps them.
export const requestsOf = (
  items: ParkedItem[],
  subagents: ReadonlySet<string>,
  pipelines: ReadonlySet<string> = new Set(),
): IParkedRequest[] =>
  items.map((item) => {
    const { id, kind, ...question } = item
    const call = subagentCallOf(item, subagents)
    const pipeline = call ? undefined : pipelineCallOf(item, pipelines)
    return {
      requestId: id,
      kind,
      question,
      ...(call ? { subagent: call } : {}),
      ...(pipeline ? { pipeline } : {}),
    }
  })

// The answers the workflow collected, as the core takes them (the value is the answer).
export const coreAnswersOf = (answers: Record<string, IAnswer>): Record<string, ParkAnswer> =>
  Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, a.value as ParkAnswer]))

// A node of a pipeline, as the worker built it: the node (from the worker's own, validated
// definition), its agent and that agent's config (the route call is made with it).
export interface IPipelineNodeRuntime {
  node: PipelineNode
  agent: Pick<IAgent, 'run'>
  config: IAgentConfig
}

// A pipeline as the worker has it (PIPELINES): its normalised definition and its nodes, by id.
export interface IPipelineRuntime {
  definition: PipelineDefinition
  nodes: ReadonlyMap<string, IPipelineNodeRuntime>
}

export interface IActivityDeps {
  agent: Pick<IAgent, 'run'>
  runs: IRunStore
  events: IEventStore
  parked: IParkedStore
  log: ILogger
  // The static subagents' agents, by tool name (their profiles; SUBAGENTS).
  subagents?: ReadonlyMap<string, Pick<IAgent, 'run'>>
  // The pipelines, by tool name (PIPELINES).
  pipelines?: ReadonlyMap<string, IPipelineRuntime>
  // The route call (tests swap it); the core's pickPipelineRoute.
  pickRoute?: typeof pickPipelineRoute
  // How often the route call heartbeats (it runs outside the run, so outside its lease).
  routeHeartbeatMs?: number
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
  subagents?: IChildBudget
  pipelines?: IChildBudget
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

export const createActivities = (deps: IActivityDeps) => {
  const { runs, events, parked, log } = deps
  const subagentNames = new Set(deps.subagents?.keys() ?? [])
  const pipelineNames = new Set(deps.pipelines?.keys() ?? [])
  const pickRoute = deps.pickRoute ?? pickPipelineRoute

  // The run's items, recorded for the gateway, and the `parked` result.
  const parkedResult = async (
    stream: string,
    turn: number,
    runId: string,
    attempt: number,
    attemptBase: number,
    items: ParkedItem[],
  ): Promise<TurnResult> => {
    const requests = requestsOf(items, subagentNames, pipelineNames)
    await parked.record(
      requests.map((r) => ({
        sessionId: stream,
        itemId: r.requestId,
        turn,
        runId,
        kind: r.kind,
        answeredBy: r.subagent ? 'subagent' : r.pipeline ? 'pipeline' : 'client',
        ...(r.subagent ? { childId: subagentWorkflowIdOf(stream, runId, r.requestId) } : {}),
        ...(r.pipeline ? { childId: pipelineWorkflowIdOf(stream, runId, r.requestId) } : {}),
        item: {
          kind: r.kind,
          ...(r.question as object),
          ...(r.subagent ? { subagent: r.subagent } : {}),
          ...(r.pipeline ? { pipeline: r.pipeline } : {}),
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
            runId: runIdOf(stream, turn, plan.runNo),
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
    let last: { attempt?: number } = {}
    const scope: ITurnScope = {
      sessionId: stream,
      turn,
      intent,
      heartbeat: (details) => ctx.heartbeat(details),
      revoked,
      ...(o.subagents ? { subagents: { ...o.subagents, dispatched: 0 } } : {}),
      ...(o.pipelines ? { pipelines: { ...o.pipelines, dispatched: 0 } } : {}),
    }
    const runId = intent.runId
    // The run, once it exists: a resumed one from the start, a fresh one once its lease bound it.
    const existing = (): string | undefined =>
      scope.runId ?? (intent.kind === 'resume' ? intent.runId : undefined)
    const onEvent = (event: AgentEvent): void => {
      writer.push(event)
      last = { attempt: event.attempt }
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
            : { runId, input: o.input, history: o.history, signal: stop.signal, onEvent },
        ),
      )
    } catch (err) {
      await writer.flush()
      ctx.cancellationSignal.removeEventListener('abort', onCancel)
      const why = revoked()
      if (why || err instanceof RunLeaseError) {
        log.warn('turn moved', { stream, turn, runId, reason: why ?? errorMessage(err) })
        throw ApplicationFailure.retryable(
          `turn ${turn} left this worker: ${why ?? errorMessage(err)}`,
          'TurnMoved',
        )
      }
      if (stop.signal.aborted) {
        const ran = existing()
        return {
          status: 'stopped',
          ...(ran ? { runId: ran } : {}),
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
      runId: result.runId ?? runId,
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
      ...(input.pipelines ? { pipelines: input.pipelines } : {}),
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

  // A pipeline's graph, as this worker has it: read once by the pipeline's workflow (so its
  // history holds the definition the run used). A worker without it: another one may have it.
  const pipelineDefinition = async (input: {
    name: string
  }): Promise<{ definition: PipelineDefinition }> => {
    const p = deps.pipelines?.get(input.name)
    if (!p) {
      throw ApplicationFailure.retryable(
        `pipeline "${input.name}" is not configured on this worker (PIPELINES)`,
        'PipelineUnknown',
      )
    }
    return { definition: p.definition }
  }

  // The route call of a node with routes, where the node ran: the core's pickPipelineRoute with
  // the node agent's config (its decision model, else its planner model, under sharedLimits). It
  // runs after the run, so outside its lease: it heartbeats on its own, a stop aborts it and a
  // lost turn moves it (the retry finds the run complete and asks again). No label, or a failed
  // call, is no route (the core's rule).
  const routeOf = async (
    entry: IPipelineNodeRuntime,
    node: PipelineNode,
    text: string,
  ): Promise<{ route?: string; usage: IUsage } | 'stopped'> => {
    const ctx = Context.current()
    const ac = new AbortController()
    const onCancel = (): void => ac.abort(new Error(`node "${node.id}" stopped`))
    if (ctx.cancellationSignal.aborted) {
      onCancel()
    } else {
      ctx.cancellationSignal.addEventListener('abort', onCancel, { once: true })
    }
    const beat = setInterval(() => ctx.heartbeat({ route: node.id }), deps.routeHeartbeatMs ?? 1000)
    beat.unref?.()
    try {
      return await pickRoute(node, text, { config: entry.config, signal: ac.signal })
    } catch (err) {
      const why = revokedReason(ctx.cancellationDetails)
      if (why) {
        throw ApplicationFailure.retryable(
          `node "${node.id}" left this worker: ${why}`,
          'TurnMoved',
        )
      }
      if (ac.signal.aborted) {
        return 'stopped'
      }
      log.warn('route call failed', { node: node.id, error: errorMessage(err) })
      return { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
    } finally {
      clearInterval(beat)
      ctx.cancellationSignal.removeEventListener('abort', onCancel)
    }
  }

  // One visit of one pipeline node: the node's agent on the rendered input, as turn 1 of the
  // visit's own stream - so a retry (the worker died) finds the visit's run and resumes it from
  // its snapshot and its call journal (a write it made is not made again), and a second start of
  // the same visit returns the answer it already has. Then the route call. The worker's node must
  // be the one the run was planned with: a worker whose PIPELINES differ leaves it to another.
  const runPipelineNode = async (input: IPipelineNodeInput): Promise<PipelineNodeOutcome> => {
    const entry = deps.pipelines?.get(input.pipeline)?.nodes.get(input.node.id)
    if (!entry) {
      throw ApplicationFailure.retryable(
        `pipeline "${input.pipeline}" has no node "${input.node.id}" on this worker (PIPELINES)`,
        'PipelineUnknown',
      )
    }
    if (canonicalJson(entry.node) !== canonicalJson(input.node)) {
      throw ApplicationFailure.retryable(
        `pipeline "${input.pipeline}": node "${input.node.id}" on this worker is not the node the run was planned with (PIPELINES changed)`,
        'PipelineChanged',
      )
    }
    const text = renderPipelineNodeInput(input.input)
    const out = await runOne({
      stream: input.stream,
      turn: 1,
      agent: entry.agent,
      input: text,
      history: [],
      started: {
        // The run's snapshot has all of it.
        input: clip(text, PIPELINE_TEXT_MAX_CHARS),
        pipeline: input.pipeline,
        nodeId: input.node.id,
        visit: input.input.visit,
        from: input.input.from.map((f) => f.nodeId),
        parent: { sessionId: input.sessionId, turn: input.turn },
        itemId: input.itemId,
        workflowId: input.workflowId,
      },
    })
    if (out.status === 'parked') {
      // A node has no one to ask and no children of its own: its approvals are decided by the
      // worker's mode and rules (an 'ask' is a denial), so this is a misconfiguration.
      throw ApplicationFailure.nonRetryable(
        `pipeline "${input.pipeline}": node "${input.node.id}" parked - a pipeline node's run cannot wait for answers`,
        TURN_REFUSED,
      )
    }
    if (out.status !== 'completed') {
      return out
    }
    const answer = clip(out.text, PIPELINE_TEXT_MAX_CHARS)
    if (!entry.node.routes?.length) {
      return {
        status: 'completed',
        runId: out.runId,
        attempt: out.attempt,
        text: answer,
        usage: out.usage,
      }
    }
    const picked = await routeOf(entry, entry.node, out.text)
    if (picked === 'stopped') {
      return { status: 'stopped', runId: out.runId, attempt: out.attempt, usage: out.usage }
    }
    return {
      status: 'completed',
      runId: out.runId,
      attempt: out.attempt,
      text: answer,
      usage: addUsage(out.usage, picked.usage),
      ...(picked.route ? { route: picked.route } : {}),
    }
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

  // A batch of a pipeline's own stream (its engine's events, numbered by the workflow). Written
  // once: a retried batch is a no-op.
  const writeStream = async (batch: IStreamBatch): Promise<void> => {
    await events.streamBatch(batch)
  }

  return {
    runTurn,
    runSubagent,
    pipelineDefinition,
    runPipelineNode,
    endTurn,
    writeMarkers,
    writeStream,
  }
}

export type SwarmActivities = ReturnType<typeof createActivities>
