// What a Workflow step does: ONE `agent.run` attempt - examples/swarm's activities (`runTurn`,
// `runSubagent`, `runPipelineNode`) on this platform - with every scale-out hook of the agent
// pointed at the session's Durable Object (the `ISessionPort`, an RPC stub there, an in-process
// object in the unit tests):
//
//   persistence          -> the object's runs (snapshots, fenced by attempt and by the run's fence)
//   persistence.journal  -> the object's journal (fenced the same way): a retried step REPLAYS
//   runLease             -> the object's lease (a TTL by its clock; a newer attempt revokes the
//                           holder) + the run's bind (fresh) or fence (resume)
//   onEvent              -> the object's event log, in batches (its live readers wake at once)
//   sharedLimits         -> a LimiterDO per bucket
//   a stop               -> the answer of the lease's renew and of an event batch: the step aborts
//                           the run, which records `cancelled`
//
// The plan is examples/swarm's `planTurn`: a run on record is resumed (or its result returned, or
// its park reported again), never started again under its id; one that cannot be resumed (bound,
// no plan) is superseded before the turn names its next run. No `cloudflare:*` here: the unit
// tests run it in Node against the real core and a scripted model.
import {
  addUsage,
  createAgent,
  isAuthError,
  isModelCallRefused,
  pickPipelineRoute,
  renderPipelineNodeInput,
  RunLeaseError,
  type AgentEvent,
  type IAgentConfig,
  type IAgentRunResult,
  type IConversationTurn,
  type IJournalEntry,
  type IPersistence,
  type IRunLease,
  type IRunSnapshot,
  type IToolCatalogEntry,
  type ParkAnswer,
  type ParkedItem,
} from '@dudko.dev/agent'
import {
  PIPELINE_TEXT_MAX_CHARS,
  type IAnswer,
  type IChildParked,
  type IParkedRequest,
  type IPipelineCall,
  type IPipelineNodeInput,
  type IStreamBatch,
  type ISubagentCall,
  type ISubagentInput,
  type PipelineNodeOutcome,
  type SubagentOutcome,
  type TurnOutcome,
  type TurnResult,
} from 'swarm-shared/workflow'
import type { IAgentSetup } from './agent-config.ts'
import type { IRuntimeConfig } from './config.ts'
import { runIdOf } from './ids.ts'
import { createSharedLimits, type BucketDecision, type IBucketConfig } from './limiter.ts'
import { canonicalJson, needsCatalog, pipelineNodeConfig } from './pipelines.ts'
import type { ChildOutcome, ChildPhase, TurnPhase } from './session.ts'
import { eventRowOf, type IEventRow, type IRunBinding, type IRunRow } from './store.ts'
import { childAgentConfig, sessionAgentConfig, type ITurnBudget } from './subagents.ts'

// Whose stop a heartbeat asks about: the session's running turn, or a child.
export type StopScope = { turn: number } | { child: string }

// What a step needs of the session's object.
export interface ISessionPort {
  started: (stream: string, turn: number, body: Record<string, unknown>) => Promise<void>
  appendEvents: (rows: IEventRow[], scope: StopScope) => Promise<{ stop: boolean }>
  bindRun: (b: IRunBinding) => Promise<boolean>
  latestRunOfTurn: (stream: string, turn: number) => Promise<IRunRow | undefined>
  nextAttemptBase: (stream: string, turn: number) => Promise<number>
  supersedeRun: (runId: string) => Promise<boolean>
  fenceRun: (runId: string) => Promise<number | undefined>
  writeSnapshot: (s: IRunSnapshot, mode: 'checkpoint' | 'resume') => Promise<boolean>
  loadRun: (runId: string) => Promise<IRunSnapshot | null>
  appendJournal: (runId: string, entry: IJournalEntry) => Promise<boolean>
  loadJournal: (runId: string) => Promise<IJournalEntry[]>
  leaseAcquire: (runId: string, owner: string, ttlMs: number) => Promise<boolean>
  heartbeat: (
    scope: StopScope,
    runId: string,
    owner: string,
    ttlMs: number,
  ) => Promise<{ held: boolean; stop: boolean }>
  leaseRelease: (runId: string, owner: string) => Promise<void>
  turnPhase: (turn: number, k: number) => Promise<TurnPhase>
  turnOutcome: (turn: number, k: number, outcome: TurnOutcome) => Promise<{ applied: string }>
  childPhase: (workflowId: string, k: number) => Promise<ChildPhase>
  childOutcome: (
    workflowId: string,
    k: number,
    outcome: ChildOutcome,
  ) => Promise<{ applied: string }>
  childStopping: (workflowId: string) => Promise<boolean>
  startNodeVisit: (
    pipelineWorkflowId: string,
    input: IPipelineNodeInput,
  ) => Promise<{ started: boolean }>
  stopNodeVisit: (workflowId: string) => Promise<void>
  writeStream: (batch: IStreamBatch) => Promise<void>
}

export interface IStepDeps {
  port: (sessionId: string) => ISessionPort
  take?: (bucket: string, cost: number, cfg: IBucketConfig) => Promise<BucketDecision>
  setup: IAgentSetup
  runtime: IRuntimeConfig
  log?: (level: 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
  // Tests swap them.
  createAgent?: typeof createAgent
  pickRoute?: typeof pickPipelineRoute
  // A unique owner per attempt (the lease's holder).
  owner?: () => string
}

// A failure that will fail again (a limit, refused credentials, a misconfiguration): the Workflow
// does not retry it (workflows.ts throws it as a NonRetryableError).
export class TurnRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TurnRefused'
  }
}

export class SnapshotFencedError extends Error {
  constructor(runId: string, attempt: number, mode: 'checkpoint' | 'resume') {
    super(
      mode === 'resume'
        ? `run ${runId}: attempt ${attempt} is not above the attempt on record (or the run is not bound) - refusing the resume`
        : `run ${runId}: a newer attempt than ${attempt} is on record (or the run is not bound) - this attempt lost the run`,
    )
    this.name = 'SnapshotFencedError'
  }
}

export class JournalFencedError extends Error {
  constructor(runId: string, attempt: number) {
    super(
      `run ${runId}: attempt ${attempt} may not append to the journal - a newer attempt took the run (or the run is not bound); this attempt lost the run`,
    )
    this.name = 'JournalFencedError'
  }
}

// A child's answer, as the parent's item gets it.
export const SUBAGENT_TEXT_MAX_CHARS = 32_000

// --- the plan: examples/swarm's planTurn -------------------------------------------------------

export type TurnPlan =
  | { kind: 'completed'; row: IRunRow }
  | { kind: 'stopped'; row: IRunRow }
  | { kind: 'parked'; row: IRunRow }
  | { kind: 'resume'; runId: string; attemptBase: number }
  | { kind: 'fresh'; runNo: number; first: boolean; supersedes?: string }

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
  return { kind: 'fresh', runNo: latest.runNo + 1, first: false, supersedes: latest.runId }
}

// --- the parked items: examples/swarm's requestsOf ----------------------------------------------

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

export const coreAnswersOf = (answers: Record<string, IAnswer>): Record<string, ParkAnswer> =>
  Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, a.value as ParkAnswer]))

// --- the events ---------------------------------------------------------------------------------

export interface IEventWriter {
  push: (event: AgentEvent) => void
  flush: () => Promise<void>
}

// In batches (one RPC per flush, at most `maxBatch` events): a model streams its answer as many
// small deltas. Best effort (retried, then dropped with a log): the snapshot is the durable state,
// and delivery is at-least-once anyway. Each answer says whether the stream is being stopped.
export const createEventWriter = (
  port: ISessionPort,
  o: {
    stream: string
    turn: number
    attemptBase: number
    maxEventBytes: number
    flushMs: number
    scope: StopScope
    onStop: () => void
    onError?: (err: unknown, dropped: number) => void
    maxBatch?: number
    retries?: number
  },
): IEventWriter => {
  const maxBatch = o.maxBatch ?? 200
  const retries = o.retries ?? 3
  let buffer: IEventRow[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()
  const send = async (rows: IEventRow[]): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const { stop } = await port.appendEvents(rows, o.scope)
        if (stop) o.onStop()
        return
      } catch (err) {
        if (attempt >= retries) {
          o.onError?.(err, rows.length)
          return
        }
        await new Promise((r) => setTimeout(r, 100 * 4 ** attempt))
      }
    }
  }
  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (buffer.length) {
      const batch = buffer
      buffer = []
      chain = chain.then(() => send(batch))
    }
    return chain
  }
  return {
    push: (event) => {
      const row = eventRowOf(event, o, o.maxEventBytes)
      if (!row) return
      buffer.push(row)
      if (buffer.length >= maxBatch) {
        void flush()
      } else if (!timer) {
        timer = setTimeout(() => void flush(), o.flushMs)
      }
    },
    flush,
  }
}

// --- one run attempt ----------------------------------------------------------------------------

type TurnIntent =
  | { kind: 'fresh'; runId: string; runNo: number; attemptBase: number }
  | { kind: 'resume'; runId: string; attemptBase: number }

export interface IRunOne {
  sessionId: string
  // The session - or a child's own stream.
  stream: string
  turn: number
  config: IAgentConfig
  input: string
  history: IConversationTurn[]
  answers?: Record<string, IAnswer>
  started: Record<string, unknown>
  scope: StopScope
  // The tool names of the session's subagents and pipelines (a child's items are all a client's).
  callNames?: { subagents: ReadonlySet<string>; pipelines: ReadonlySet<string> }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const runOne = async (deps: IStepDeps, o: IRunOne): Promise<TurnResult> => {
  const port = deps.port(o.sessionId)
  const { stream, turn } = o
  const log = deps.log ?? (() => {})
  await port.started(stream, turn, o.started)
  const answerIds = Object.keys(o.answers ?? {})
  let plan = planTurn(await port.latestRunOfTurn(stream, turn), answerIds)
  // A fresh run after one that cannot be resumed (no plan on record): that one may still be
  // running somewhere (an attempt the engine gave up on, which does not know it yet). Supersede it
  // first: from then on it writes nothing, so its next journal append fails and the core stops it
  // before any tool call it makes runs. One that put its plan on record meanwhile is resumed.
  if (plan.kind === 'fresh' && plan.supersedes && !(await port.supersedeRun(plan.supersedes))) {
    plan = planTurn(await port.latestRunOfTurn(stream, turn), answerIds)
    if (plan.kind === 'fresh') {
      throw new Error(`turn ${turn}: its latest run changed while the turn planned the next one`)
    }
  }
  const requests = (items: ParkedItem[]): IParkedRequest[] =>
    o.callNames
      ? requestsOf(items, o.callNames.subagents, o.callNames.pipelines)
      : requestsOf(items, new Set(), new Set())
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
    return {
      status: 'parked',
      runId: s.runId,
      attempt: s.attempt ?? 1,
      turnAttempt: plan.row.attemptBase + (s.attempt ?? 1),
      requests: requests(s.parked?.items ?? []),
    }
  }
  const intent: TurnIntent =
    plan.kind === 'resume'
      ? plan
      : {
          kind: 'fresh',
          runId: await runIdOf(stream, turn, plan.runNo),
          runNo: plan.runNo,
          attemptBase: plan.first ? 0 : await port.nextAttemptBase(stream, turn),
        }

  // A user's stop: abort the run, which then writes its 'cancelled' snapshot. A lost lease is
  // something else - the core aborts the run itself, and nothing more is written.
  const stop = new AbortController()
  const onStop = (): void => {
    if (!stop.signal.aborted) stop.abort(new Error(`turn ${turn} stopped by the user`))
  }
  const owner = deps.owner?.() ?? `step-${crypto.randomUUID()}`
  const ttlMs = deps.runtime.leaseTtlMs
  let bound: string | undefined
  const lease: IRunLease = {
    ttlMs,
    owner,
    acquire: async (runId) => {
      if (runId !== intent.runId || (bound && bound !== runId)) {
        return false
      }
      // Held by an older attempt: it is revoked now, and lets go at its next renew - or, if it is
      // gone, its lease runs out. Wait for that (up to twice the TTL), then take it.
      const deadline = Date.now() + 2 * ttlMs
      while (!(await port.leaseAcquire(runId, owner, ttlMs))) {
        if (Date.now() > deadline) {
          log('warn', 'the run is held by another attempt', { stream, turn, runId })
          return false
        }
        await sleep(Math.max(100, Math.floor(ttlMs / 4)))
      }
      if (intent.kind === 'resume') {
        if ((await port.fenceRun(runId)) === undefined) {
          await port.leaseRelease(runId, owner)
          return false
        }
      } else if (
        !(await port.bindRun({
          runId,
          stream,
          turn,
          runNo: intent.runNo,
          attemptBase: intent.attemptBase,
        }))
      ) {
        await port.leaseRelease(runId, owner)
        return false
      }
      bound = runId
      return true
    },
    renew: async (runId) => {
      const { held, stop: stopping } = await port.heartbeat(o.scope, runId, owner, ttlMs)
      if (stopping) onStop()
      return held
    },
    release: (runId) => port.leaseRelease(runId, owner),
  }
  const write = async (s: IRunSnapshot, mode: 'checkpoint' | 'resume'): Promise<void> => {
    if (!(await port.writeSnapshot(s, mode))) {
      throw new SnapshotFencedError(s.runId, s.attempt ?? 1, mode)
    }
  }
  const persistence: IPersistence = {
    onRunStart: (s) => write(s, 'checkpoint'),
    onStepComplete: (s) => write(s, 'checkpoint'),
    onRunComplete: (s) => write(s, 'checkpoint'),
    onRunResume: (s) => write(s, 'resume'),
    loadRun: (runId) => port.loadRun(runId),
    journal: {
      append: async (runId, entry) => {
        if (!(await port.appendJournal(runId, entry))) {
          throw new JournalFencedError(runId, entry.attempt)
        }
      },
      load: (runId) => port.loadJournal(runId),
    },
  }
  const limits =
    deps.runtime.limiter && deps.take
      ? { sharedLimits: createSharedLimits(deps.take, deps.runtime.limiter) }
      : {}
  const writer = createEventWriter(port, {
    stream,
    turn,
    attemptBase: intent.attemptBase,
    maxEventBytes: deps.runtime.eventMaxBytes,
    flushMs: deps.runtime.eventFlushMs,
    scope: o.scope,
    onStop,
    onError: (err, dropped) =>
      log('warn', 'events dropped', { stream, turn, dropped, error: errorMessage(err) }),
  })
  let last: { attempt?: number } = {}
  const onEvent = (event: AgentEvent): void => {
    writer.push(event)
    last = { attempt: event.attempt }
    if (event.type === 'log' && (event.level === 'error' || event.level === 'warn')) {
      log(event.level, event.message, { runId: event.runId })
    }
  }
  const agent = await (deps.createAgent ?? createAgent)({
    ...o.config,
    persistence,
    runLease: lease,
    ...limits,
  })
  let result: IAgentRunResult
  try {
    result = await agent.run(
      intent.kind === 'resume'
        ? {
            input: '',
            resumeFromRunId: intent.runId,
            ...(answerIds.length ? { answers: coreAnswersOf(o.answers!) } : {}),
            signal: stop.signal,
            onEvent,
          }
        : {
            runId: intent.runId,
            input: o.input,
            history: o.history,
            signal: stop.signal,
            onEvent,
          },
    )
  } catch (err) {
    await writer.flush()
    if (err instanceof RunLeaseError) {
      log('warn', 'turn moved', { stream, turn, runId: intent.runId, reason: errorMessage(err) })
      throw new Error(`turn ${turn} left this attempt: ${errorMessage(err)}`)
    }
    if (stop.signal.aborted) {
      const ran = bound ?? (intent.kind === 'resume' ? intent.runId : undefined)
      return {
        status: 'stopped',
        ...(ran ? { runId: ran } : {}),
        ...(last.attempt ? { attempt: last.attempt } : {}),
      }
    }
    if (isModelCallRefused(err) || isAuthError(err)) {
      throw new TurnRefused(errorMessage(err))
    }
    log('warn', 'turn failed', { stream, turn, runId: intent.runId, error: errorMessage(err) })
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    await agent.close().catch(() => {})
  }
  await writer.flush()
  if (result.parked) {
    return {
      status: 'parked',
      runId: result.parked.runId,
      attempt: last.attempt ?? 1,
      turnAttempt: intent.attemptBase + (last.attempt ?? 1),
      requests: requests(result.parked.items),
    }
  }
  return {
    status: 'completed',
    runId: result.runId ?? intent.runId,
    attempt: last.attempt ?? 1,
    text: result.text,
    usage: result.usage,
    ...(result.compactedHistory ? { compactedHistory: result.compactedHistory } : {}),
  }
}

// --- a session turn's phase ---------------------------------------------------------------------

// One phase of a turn: its input from the object, one attempt, its outcome to the object. The
// step's own result is only the status (the outcome may be large: the object keeps it).
export const runTurnPhase = async (
  deps: IStepDeps,
  sessionId: string,
  turn: number,
  k: number,
): Promise<{ status: string }> => {
  const port = deps.port(sessionId)
  const phase = await port.turnPhase(turn, k)
  if ('applied' in phase) return { status: phase.applied }
  if ('gone' in phase) return { status: 'gone' }
  if (phase.stopping) {
    await port.turnOutcome(turn, k, { status: 'stopped' })
    return { status: 'stopped' }
  }
  const input = phase.input
  const budget: ITurnBudget = {
    ...(input.subagents ? { subagents: { ...input.subagents, dispatched: 0 } } : {}),
    ...(input.pipelines ? { pipelines: { ...input.pipelines, dispatched: 0 } } : {}),
  }
  const { setup } = deps
  const outcome = await runOne(deps, {
    sessionId,
    stream: sessionId,
    turn,
    config: sessionAgentConfig(setup.config, setup.subagents, setup.pipelines, budget),
    input: input.input,
    history: input.history,
    ...(input.answers ? { answers: input.answers } : {}),
    started: {
      messageIds: input.messageIds,
      input: input.input,
      ...(input.answers ? { resumed: Object.keys(input.answers) } : {}),
    },
    scope: { turn },
    callNames: {
      subagents: new Set(Object.keys(setup.subagents)),
      pipelines: new Set(Object.keys(setup.pipelines)),
    },
  })
  const { applied } = await port.turnOutcome(turn, k, outcome)
  return { status: applied === 'gone' ? outcome.status : applied }
}

// --- a child's phase ------------------------------------------------------------------------------

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

// A child whose run parked: it waits for a person when CHILD_ASK=park; under 'deny' a run that
// parks anyway (a deferred tool result) cannot wait - a refusal.
const childParkedOf = (out: TurnResult & { status: 'parked' }, deps: IStepDeps, what: string) => {
  if (deps.runtime.childAsk !== 'park') {
    throw new TurnRefused(`${what} parked: its run cannot wait for answers (CHILD_ASK=deny)`)
  }
  const parked: IChildParked = {
    status: 'parked',
    runId: out.runId,
    attempt: out.attempt,
    requests: out.requests,
  }
  return parked
}

export const runChildPhase = async (
  deps: IStepDeps,
  sessionId: string,
  workflowId: string,
  k: number,
): Promise<{ status: string }> => {
  const port = deps.port(sessionId)
  const phase = await port.childPhase(workflowId, k)
  if ('applied' in phase) return { status: phase.applied }
  if ('gone' in phase) return { status: 'gone' }
  if (phase.stopping) {
    await port.childOutcome(workflowId, k, { status: 'stopped' })
    return { status: 'stopped' }
  }
  const outcome =
    phase.kind === 'subagent'
      ? await runSubagent(deps, workflowId, phase.input as ISubagentInput, phase.answers)
      : await runNodeVisit(deps, phase.input as IPipelineNodeInput, phase.answers)
  const { applied } = await port.childOutcome(workflowId, k, outcome)
  return { status: applied === 'gone' ? outcome.status : applied }
}

const runSubagent = async (
  deps: IStepDeps,
  workflowId: string,
  input: ISubagentInput,
  answers?: Record<string, IAnswer>,
): Promise<SubagentOutcome | IChildParked> => {
  const profile = deps.setup.subagents[input.name]
  if (!profile) {
    throw new TurnRefused(`subagent "${input.name}" is not configured (SUBAGENTS)`)
  }
  const out = await runOne(deps, {
    sessionId: input.sessionId,
    stream: input.stream,
    turn: 1,
    config: childAgentConfig(deps.setup.config, profile, deps.setup.modelOf, deps.runtime.childAsk),
    input: input.task,
    history: [],
    ...(answers ? { answers } : {}),
    started: {
      input: input.task,
      name: input.name,
      parent: { sessionId: input.sessionId, turn: input.turn, runId: input.parentRunId },
      itemId: input.itemId,
    },
    scope: { child: workflowId },
  })
  if (out.status === 'parked') {
    return childParkedOf(out, deps, `subagent "${input.name}"`)
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

// The tools of the servers a node mounts whole, as the worker finds them (a node that names one
// tool of a server and whole servers needs their names for its allowlist).
const catalogOf = async (
  deps: IStepDeps,
  servers: readonly string[],
): Promise<IToolCatalogEntry[]> => {
  const base = deps.setup.config
  const probe = await (deps.createAgent ?? createAgent)({
    clientName: base.clientName,
    model: base.model,
    mcpServers: Object.fromEntries(
      Object.entries(base.mcpServers ?? {}).filter(([name]) => servers.includes(name)),
    ),
    maxIterations: 1,
    maxStepsPerTask: 1,
    logLevel: 'none',
  })
  try {
    return probe.listTools()
  } finally {
    await probe.close().catch(() => {})
  }
}

const runNodeVisit = async (
  deps: IStepDeps,
  input: IPipelineNodeInput,
  answers?: Record<string, IAnswer>,
): Promise<PipelineNodeOutcome | IChildParked> => {
  const pipeline = deps.setup.pipelines[input.pipeline]
  const node = pipeline?.definition.nodes.find((n) => n.id === input.node.id)
  if (!pipeline || !node) {
    throw new TurnRefused(
      `pipeline "${input.pipeline}" has no node "${input.node.id}" (PIPELINES changed)`,
    )
  }
  if (canonicalJson(node) !== canonicalJson(input.node)) {
    throw new TurnRefused(
      `pipeline "${input.pipeline}": node "${input.node.id}" is not the node the run was planned with (PIPELINES changed)`,
    )
  }
  const catalog = needsCatalog(node) ? await catalogOf(deps, node.mcpServers ?? []) : []
  const config = pipelineNodeConfig(
    deps.setup.config,
    node,
    deps.setup.modelOf,
    catalog,
    deps.runtime.childAsk,
  )
  const text = renderPipelineNodeInput(input.input)
  const out = await runOne(deps, {
    sessionId: input.sessionId,
    stream: input.stream,
    turn: 1,
    config,
    input: text,
    history: [],
    ...(answers ? { answers } : {}),
    started: {
      input: clip(text, PIPELINE_TEXT_MAX_CHARS),
      pipeline: input.pipeline,
      nodeId: input.node.id,
      visit: input.input.visit,
      from: input.input.from.map((f) => f.nodeId),
      parent: { sessionId: input.sessionId, turn: input.turn },
      itemId: input.itemId,
      workflowId: input.workflowId,
    },
    scope: { child: input.workflowId },
  })
  if (out.status === 'parked') {
    return childParkedOf(out, deps, `pipeline "${input.pipeline}": node "${input.node.id}"`)
  }
  if (out.status !== 'completed') {
    return out
  }
  const answer = clip(out.text, PIPELINE_TEXT_MAX_CHARS)
  if (!node.routes?.length) {
    return {
      status: 'completed',
      runId: out.runId,
      attempt: out.attempt,
      text: answer,
      usage: out.usage,
    }
  }
  // The route call, where the node ran (the core's runner contract), after the run - so outside
  // its lease: a stop is read before it; a crash after it asks the router again on the retry.
  if (await deps.port(input.sessionId).childStopping(input.workflowId)) {
    return { status: 'stopped', runId: out.runId, attempt: out.attempt, usage: out.usage }
  }
  const limits =
    deps.runtime.limiter && deps.take
      ? { sharedLimits: createSharedLimits(deps.take, deps.runtime.limiter) }
      : {}
  try {
    const picked = await (deps.pickRoute ?? pickPipelineRoute)(node, out.text, {
      config: { ...config, ...limits },
    })
    return {
      status: 'completed',
      runId: out.runId,
      attempt: out.attempt,
      text: answer,
      usage: addUsage(out.usage, picked.usage),
      ...(picked.route ? { route: picked.route } : {}),
    }
  } catch (err) {
    deps.log?.('warn', 'route call failed', { node: node.id, error: errorMessage(err) })
    return {
      status: 'completed',
      runId: out.runId,
      attempt: out.attempt,
      text: answer,
      usage: out.usage,
    }
  }
}
