// The session's logic in its Durable Object: what examples/swarm's `session` workflow does on
// Temporal, over swarm-shared's reducer (`swarm-shared/workflow`), with the object as the session's
// SINGLE WRITER. Every transition - a message, an answer, a stop, a turn's or a child's outcome, the
// idle timer - is one call here, and everything it produces is written in the same storage
// transaction as the state it leaves: the `turn.ended` and child markers (the event log is here
// too, so they need no activity), the parked items, the children, and the effects on other
// services - starting a Workflow instance, sending one an event - as rows of an OUTBOX, which the
// object makes after the transaction committed, in order, until each one succeeded (durable.ts).
//
// Turns run in a Workflow instance each (workflows.ts, `TurnWorkflow`): its steps ask for the
// phase they run (`turnPhase`) and report what came of it (`turnOutcome`). A phase is one
// `agent.run` attempt of the turn: phase 0 the turn as it starts, phase k the k-th resume of a
// parked turn. A child (a static subagent call, a pipeline call, a pipeline's node visit) is a
// Workflow instance of its own and talks to the object the same way (`childPhase`,
// `childOutcome`). Pure but for the storage and the clock it is given: no `cloudflare:*`, so the
// unit tests drive it over node:sqlite.
import {
  acceptAnswer,
  acceptChildAnswer,
  acceptMessage,
  acceptStop,
  childFinished,
  childPark,
  childParked,
  childReady,
  childrenRunning,
  closeChildWait,
  emptyUsage,
  finishTurn,
  initialChildWait,
  initialState,
  pipelineFinished,
  startChildren,
  takeChildAnswers,
  takeTurn,
  view,
  type IAnswer,
  type IChildParked,
  type IChildWait,
  type IParkedRequest,
  type IPipelineInput,
  type IPipelineNodeInput,
  type ISessionOptions,
  type ISessionState,
  type ISessionView,
  type IStopRequest,
  type IStreamBatch,
  type ISubagentInput,
  type ITurnEnd,
  type ITurnInput,
  type IUserMessage,
  type PipelineNodeOutcome,
  type PipelineOutcome,
  type SubagentOutcome,
  type TurnOutcome,
} from 'swarm-shared/workflow'
import { pipelineWorkflowIdOf, subagentWorkflowIdOf } from 'swarm-shared/workflow'
import type { IParkedRow } from 'swarm-shared'
import {
  cancelOwned,
  cancelTurn,
  getBlob,
  getMeta,
  insertEvents,
  markAnswered,
  markerRow,
  migrate,
  parkedAnsweredBy,
  parkedItem,
  putBlob,
  recordParked,
  setMeta,
  streamBatchRows,
  streamExists,
  streamMarkerRow,
  type IEventRow,
} from './store.ts'
import type { IStorage } from './sql.ts'

// The Workflows a session starts (wrangler.jsonc names their bindings).
export type WorkflowKind = 'turn' | 'subagent' | 'pipeline' | 'node'

// An effect on another service, made after the transaction that decided it (the outbox).
export type Effect =
  | { kind: 'create'; workflow: WorkflowKind; id: string; params: Record<string, unknown> }
  | {
      kind: 'event'
      workflow: WorkflowKind
      id: string
      type: string
      payload: Record<string, unknown>
    }

// What a turn's Workflow instance is started with: the session and the turn (everything else it
// reads from the object - the input may be large) and the two session options its steps need.
export interface ITurnParams {
  sessionId: string
  turn: number
  options: Pick<ISessionOptions, 'turnTimeoutMs' | 'maxTurnAttempts'>
}

// A child's Workflow instance: its session and its workflow id (swarm-shared's naming).
export interface IChildParams {
  sessionId: string
  workflowId: string
  options: Pick<ISessionOptions, 'turnTimeoutMs' | 'maxTurnAttempts'>
}

// The instance a turn runs in: one per session and turn, so a retried start never makes a second.
export const turnInstanceOf = (sessionId: string, turn: number): string =>
  `turn-${sessionId}-${turn}`

// What a turn's (or a child's) Workflow instance waits for while its run is parked.
export const resumeEventOf = (k: number): string => `resume-${k}`
// What a pipeline's instance waits for: its node visits settling, one at a time (or a stop).
export const SETTLED_EVENT = 'settled'

export type ChildKind = 'subagent' | 'pipeline' | 'node'

// A child as the object keeps it. `state`: running (its step runs, or will), waiting (its run is
// parked on a person), stopping (a stop came while it ran: its step stops at the next heartbeat),
// ended.
export interface IChildRecord {
  workflowId: string
  kind: ChildKind
  itemId: string
  // A node visit's pipeline (its workflow id).
  parent?: string
  state: 'running' | 'waiting' | 'stopping' | 'ended'
  // The child's phase: 0 its run, k its k-th resume.
  k: number
}

interface ISessionMeta {
  sessionId: string
  ended: boolean
  // The phase of the turn that runs now (or ran last).
  phase?: { turn: number; k: number }
  // The last time the session did something (the idle timer counts from here).
  idleSince: number
}

// What a turn's step is given: its input, or why there is nothing to run.
export type TurnPhase =
  { input: ITurnInput; stopping: boolean } | { applied: string } | { gone: true }

export type ChildInput = ISubagentInput | IPipelineInput | IPipelineNodeInput

export type ChildPhase =
  | {
      kind: ChildKind
      input: ChildInput
      answers?: Record<string, IAnswer>
      stopping: boolean
    }
  | { applied: string }
  | { gone: true }

// What a child's step reports: its outcome, or its run parked.
export type ChildOutcome = SubagentOutcome | PipelineNodeOutcome | PipelineOutcome | IChildParked

// What the gateway-facing calls answer (an error class does not cross an RPC boundary, so the
// backend maps these to swarm-shared's errors).
export type Refusal = 'not_found' | 'ended' | 'child_ended'
export type Result<T = true> = { ok: true; value: T } | { ok: false; error: Refusal }

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const refused = (error: Refusal): Result<never> => ({ ok: false, error })

export interface ISessionCoreOptions {
  storage: IStorage
  now?: () => number
  // A stored event's cap (EVENT_MAX_BYTES).
  eventMaxBytes: number
  // Called with the streams that got new events, after the transaction (the live readers).
  notify?: (streams: Set<string>) => void
}

export class SessionCore {
  private readonly storage: IStorage
  private readonly now: () => number
  private readonly eventMaxBytes: number
  private readonly notify: (streams: Set<string>) => void
  private cache?: { state: ISessionState; meta: ISessionMeta }
  private touched = new Set<string>()

  constructor(o: ISessionCoreOptions) {
    this.storage = o.storage
    this.now = o.now ?? Date.now
    this.eventMaxBytes = o.eventMaxBytes
    this.notify = o.notify ?? (() => {})
    migrate(this.storage.sql)
  }

  private get sql() {
    return this.storage.sql
  }

  // One transition: everything `fn` writes commits together, and the cached state is dropped if
  // it throws (the storage rolled back).
  private tx<T>(fn: () => T): T {
    try {
      const out = this.storage.transactionSync(fn)
      const streams = this.touched
      this.touched = new Set()
      if (streams.size) {
        this.notify(streams)
      }
      return out
    } catch (err) {
      this.cache = undefined
      this.touched = new Set()
      throw err
    }
  }

  private loaded(): { state: ISessionState; meta: ISessionMeta } | undefined {
    if (this.cache) {
      return this.cache
    }
    const meta = getMeta<ISessionMeta>(this.sql, 'session')
    const state = meta ? getBlob<ISessionState>(this.sql, 'state') : undefined
    if (!meta || !state) {
      return undefined
    }
    this.cache = { state, meta }
    return this.cache
  }

  private save(state: ISessionState, meta: ISessionMeta): void {
    putBlob(this.sql, 'state', state)
    setMeta(this.sql, 'session', meta)
    setMeta(this.sql, 'stopping', state.stopping && state.running ? state.running.turn : 0)
    this.cache = { state, meta }
  }

  private events(rows: IEventRow[]): void {
    for (const stream of insertEvents(this.sql, rows)) {
      this.touched.add(stream)
    }
  }

  private effect(e: Effect): void {
    this.sql.exec('INSERT INTO outbox (body) VALUES (?)', JSON.stringify(e))
  }

  // --- the gateway's calls -----------------------------------------------------------------------

  exists(): boolean {
    return Boolean(this.loaded())
  }

  create(sessionId: string, options: ISessionOptions, first?: IUserMessage): Result {
    return this.tx(() => {
      if (this.loaded()) {
        return ok(true)
      }
      const state = initialState(sessionId, options)
      const meta: ISessionMeta = { sessionId, ended: false, idleSince: this.now() }
      if (first) {
        acceptMessage(state, first)
      }
      this.pump(state, meta)
      return ok(true)
    })
  }

  message(message: IUserMessage): Result {
    return this.withSession((state, meta) => {
      acceptMessage(state, message)
      this.pump(state, meta)
    })
  }

  // A client's answer to one of the turn's own items (the reducer is the authority: an item a
  // child answers, or one the turn does not wait for, is refused there).
  answer(answer: IAnswer): Result {
    return this.withSession((state, meta) => {
      acceptAnswer(state, { ...answer, by: 'client' })
      this.pump(state, meta)
    })
  }

  // A client's answer to an item a child waits for (the gateway checked the child is this
  // session's: childOwnerOf). The child's wait (swarm-shared's child-state.ts) is the authority.
  answerChild(workflowId: string, answer: IAnswer): Result {
    return this.tx(() => {
      const s = this.loaded()
      if (!s) return refused('not_found')
      // Not a child of this session, or one that is over (its wait closed with it): nothing waits.
      const child = this.child(workflowId)
      if (!child) {
        return refused('child_ended')
      }
      const wait = this.waitOf(workflowId)
      if (wait.closed) {
        return refused('child_ended')
      }
      acceptChildAnswer(wait, { ...answer, by: 'client' })
      putBlob(this.sql, `wait:${workflowId}`, wait)
      if (child.state === 'waiting' && childReady(wait)) {
        this.resumeChild(s.state, child, wait)
      }
      this.pump(s.state, s.meta)
      return ok(true)
    })
  }

  stop(stop: IStopRequest): Result {
    return this.withSession((state, meta) => {
      const parked = state.parked
      acceptStop(state, stop, this.now())
      if (parked && !state.parked) {
        // The parked turn ended as stopped: its instance waits for its next phase - let it end -
        // and its children are stopped (a waiting one at once, a working one at its heartbeat).
        if (meta.phase?.turn === parked.turn) {
          this.effect({
            kind: 'event',
            workflow: 'turn',
            id: turnInstanceOf(meta.sessionId, parked.turn),
            type: resumeEventOf(meta.phase.k + 1),
            payload: { stop: true },
          })
        }
        this.stopChildren(state)
      }
      this.pump(state, meta)
    })
  }

  view(): Result<ISessionView> {
    const s = this.loaded()
    return s ? ok(view(s.state, s.meta.ended)) : refused('not_found')
  }

  parkedItem(itemId: string): IParkedRow | undefined {
    const s = this.loaded()
    return s ? parkedItem(this.sql, s.meta.sessionId, itemId) : undefined
  }

  calls(by: 'subagent' | 'pipeline'): IParkedRow[] {
    const s = this.loaded()
    return s ? parkedAnsweredBy(this.sql, s.meta.sessionId, by) : []
  }

  // A session ended by the idle timer: what an alarm calls. True when it ended now.
  idle(): boolean {
    return this.tx(() => {
      const s = this.loaded()
      if (!s || s.meta.ended) return false
      const at = this.idleDeadline()
      if (at === undefined || this.now() < at) return false
      s.meta.ended = true
      s.state.ending = true
      if (s.state.parked && s.meta.phase?.turn === s.state.parked.turn) {
        this.effect({
          kind: 'event',
          workflow: 'turn',
          id: turnInstanceOf(s.meta.sessionId, s.state.parked.turn),
          type: resumeEventOf(s.meta.phase.k + 1),
          payload: { stop: true },
        })
      }
      this.save(s.state, s.meta)
      return true
    })
  }

  // When the idle timer would end the session (undefined: it does not run now) - Temporal's
  // `condition(ready, idleTimeoutMs)`: not while a turn runs, nor while the parked turn has
  // children (working, or waiting for a person).
  idleDeadline(): number | undefined {
    const s = this.loaded()
    if (!s || s.meta.ended) return undefined
    const idle = s.state.options.idleTimeoutMs
    if (idle <= 0 || s.state.running || childrenRunning(s.state)) return undefined
    return s.meta.idleSince + idle
  }

  // What the watchdog checks: the turn that runs and the children that work.
  live(): { sessionId: string; turn?: number; children: IChildRecord[] } | undefined {
    const s = this.loaded()
    if (!s) return undefined
    return {
      sessionId: s.meta.sessionId,
      ...(s.state.running ? { turn: s.state.running.turn } : {}),
      children: this.children().filter((c) => c.state === 'running' || c.state === 'stopping'),
    }
  }

  private withSession(fn: (state: ISessionState, meta: ISessionMeta) => void): Result {
    return this.tx(() => {
      const s = this.loaded()
      if (!s) return refused('not_found')
      if (s.meta.ended) return refused('ended')
      fn(s.state, s.meta)
      return ok(true)
    })
  }

  // --- the loop ----------------------------------------------------------------------------------

  // After every transition: the markers first (a reader learns an outcome before the next turn's
  // events), then the end of a session that ends, else the next turn (or a parked one that may go
  // on). Saves the state.
  private pump(state: ISessionState, meta: ISessionMeta): void {
    const now = this.now()
    let worked = false
    for (const end of state.endings) {
      this.endTurn(end)
      worked = true
    }
    state.endings = []
    if (state.markers.length) {
      this.events(state.markers.map(streamMarkerRow))
      state.markers = []
      worked = true
    }
    if (state.ending && !state.running) {
      if (!meta.ended) {
        meta.ended = true
        this.stopChildren(state)
      }
    } else if (!state.running && !meta.ended) {
      const next = takeTurn(state, now)
      if (next) {
        const resume = next.answers !== undefined
        const k = resume && meta.phase?.turn === next.turn ? meta.phase.k + 1 : 0
        meta.phase = { turn: next.turn, k }
        putBlob(this.sql, 'phase', next)
        if (resume) {
          // The turn goes on with them: the gateway refuses another answer from now on.
          markAnswered(this.sql, meta.sessionId, Object.keys(next.answers ?? {}))
          this.effect({
            kind: 'event',
            workflow: 'turn',
            id: turnInstanceOf(meta.sessionId, next.turn),
            type: resumeEventOf(k),
            payload: {},
          })
        } else {
          const params: ITurnParams = {
            sessionId: meta.sessionId,
            turn: next.turn,
            options: {
              turnTimeoutMs: state.options.turnTimeoutMs,
              maxTurnAttempts: state.options.maxTurnAttempts,
            },
          }
          this.effect({
            kind: 'create',
            workflow: 'turn',
            id: turnInstanceOf(meta.sessionId, next.turn),
            params: params as unknown as Record<string, unknown>,
          })
        }
        worked = true
      }
    }
    if (worked) {
      meta.idleSince = now
    }
    this.save(state, meta)
  }

  // A stream's turn.ended (the session's turn, or a child's own stream), and whatever its turn
  // still waited for is closed with it - its children's own items too; a child's own end closes
  // what it waited for.
  private endTurn(end: ITurnEnd): void {
    const { sessionId, turn, closes, ...body } = end
    this.events([markerRow({ kind: 'ended', stream: sessionId, turn, body })])
    cancelTurn(this.sql, sessionId, turn)
    if (closes) {
      cancelOwned(this.sql, closes.sessionId, closes.owner)
    }
  }

  // --- a turn's Workflow instance ----------------------------------------------------------------

  private applied(scope: string, k: number): string | undefined {
    return this.sql
      .exec<{ status: string }>('SELECT status FROM phases WHERE scope = ? AND k = ?', scope, k)
      .toArray()[0]?.status
  }

  private markApplied(scope: string, k: number, status: string): void {
    this.sql.exec(
      'INSERT INTO phases (scope, k, status) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      scope,
      k,
      status,
    )
  }

  turnPhase(turn: number, k: number): TurnPhase {
    const scope = `turn:${turn}`
    const done = this.applied(scope, k)
    if (done) return { applied: done }
    const s = this.loaded()
    if (
      !s ||
      s.state.running?.turn !== turn ||
      s.meta.phase?.turn !== turn ||
      s.meta.phase.k !== k
    ) {
      return { gone: true }
    }
    const input = getBlob<ITurnInput>(this.sql, 'phase')
    return input ? { input, stopping: s.state.stopping } : { gone: true }
  }

  // The watchdog found the running turn's instance dead (errored, terminated, or complete without
  // its outcome): the phase that runs fails, as Temporal fails an activity it gave up on.
  failRunning(turn: number, error: string): void {
    const s = this.loaded()
    const phase = s?.meta.phase
    if (!s || s.state.running?.turn !== turn || phase?.turn !== turn) return
    this.turnOutcome(turn, phase.k, { status: 'failed', error })
  }

  // Is the turn that runs being stopped (what its heartbeat answers)? Cheap: no state read.
  turnStopping(turn: number): boolean {
    return getMeta<number>(this.sql, 'stopping') === turn
  }

  // A phase's outcome (the step's report, or its failure once the engine gave up on it). Taken
  // once per phase: a retried report is a no-op. A parked one records its items for the gateway
  // and starts the children its calls need.
  turnOutcome(turn: number, k: number, outcome: TurnOutcome): { applied: string } {
    return this.tx(() => {
      const scope = `turn:${turn}`
      const done = this.applied(scope, k)
      if (done) return { applied: done }
      const s = this.loaded()
      if (
        !s ||
        s.state.running?.turn !== turn ||
        s.meta.phase?.turn !== turn ||
        s.meta.phase.k !== k
      ) {
        return { applied: 'gone' }
      }
      const input = getBlob<ITurnInput>(this.sql, 'phase')
      if (!input) return { applied: 'gone' }
      this.markApplied(scope, k, outcome.status)
      const now = this.now()
      finishTurn(s.state, input, outcome, now)
      if (outcome.status === 'parked') {
        this.recordTurnPark(s.meta.sessionId, turn, outcome.runId, outcome.requests)
        this.startChildWorkflows(s.state)
      }
      this.pump(s.state, s.meta)
      return { applied: outcome.status }
    })
  }

  // The turn's items, for the gateway: who answers each (a client, or the child its call starts,
  // named as the session names it).
  private recordTurnPark(
    sessionId: string,
    turn: number,
    runId: string,
    requests: IParkedRequest[],
  ): void {
    const by = (r: IParkedRequest): Pick<IParkedRow, 'answeredBy' | 'childId'> =>
      r.subagent
        ? { answeredBy: 'subagent', childId: subagentWorkflowIdOf(sessionId, runId, r.requestId) }
        : r.pipeline
          ? { answeredBy: 'pipeline', childId: pipelineWorkflowIdOf(sessionId, runId, r.requestId) }
          : { answeredBy: 'client' }
    recordParked(
      this.sql,
      requests.map((r) => ({
        sessionId,
        itemId: r.requestId,
        turn,
        runId,
        kind: r.kind,
        ...by(r),
        item: {
          kind: r.kind,
          ...(r.question as object),
          ...(r.subagent ? { subagent: r.subagent } : {}),
          ...(r.pipeline ? { pipeline: r.pipeline } : {}),
        },
      })),
    )
  }

  // The children the parked turn needs (swarm-shared decides: caps, ids, markers): a row each,
  // its input, and the start of its instance.
  private startChildWorkflows(state: ISessionState): void {
    for (const start of startChildren(state, this.now())) {
      this.addChild(
        {
          workflowId: start.workflowId,
          kind: start.kind,
          itemId: start.requestId,
          state: 'running',
          k: 0,
        },
        start.input,
      )
      this.startInstance(state, start.kind, start.workflowId)
    }
  }

  private startInstance(state: ISessionState, kind: ChildKind, workflowId: string): void {
    const params: IChildParams = {
      sessionId: state.sessionId,
      workflowId,
      options: {
        turnTimeoutMs: state.options.turnTimeoutMs,
        maxTurnAttempts: state.options.maxTurnAttempts,
      },
    }
    this.effect({
      kind: 'create',
      workflow: kind,
      id: workflowId,
      params: params as unknown as Record<string, unknown>,
    })
  }

  // --- the children ------------------------------------------------------------------------------

  child(workflowId: string): IChildRecord | undefined {
    const r = this.sql
      .exec<{
        workflow_id: string
        kind: ChildKind
        item_id: string
        parent: string | null
        state: IChildRecord['state']
        k: number
      }>(
        'SELECT workflow_id, kind, item_id, parent, state, k FROM children WHERE workflow_id = ?',
        workflowId,
      )
      .toArray()[0]
    return r
      ? {
          workflowId: r.workflow_id,
          kind: r.kind,
          itemId: r.item_id,
          ...(r.parent ? { parent: r.parent } : {}),
          state: r.state,
          k: r.k,
        }
      : undefined
  }

  children(): IChildRecord[] {
    return this.sql
      .exec<{ workflow_id: string }>('SELECT workflow_id FROM children ORDER BY ord')
      .toArray()
      .map((r) => this.child(r.workflow_id)!)
  }

  private addChild(c: IChildRecord, input: ChildInput): void {
    const ord =
      (this.sql.exec<{ m: number | null }>('SELECT MAX(ord) AS m FROM children').one().m ?? 0) + 1
    this.sql.exec(
      'INSERT INTO children (workflow_id, kind, item_id, parent, state, k, ord) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workflow_id) DO NOTHING',
      c.workflowId,
      c.kind,
      c.itemId,
      c.parent ?? null,
      c.state,
      c.k,
      ord,
    )
    putBlob(this.sql, `child:${c.workflowId}`, input)
    putBlob(this.sql, `wait:${c.workflowId}`, initialChildWait())
  }

  private setChild(workflowId: string, patch: Partial<Pick<IChildRecord, 'state' | 'k'>>): void {
    const c = this.child(workflowId)
    if (!c) return
    this.sql.exec(
      'UPDATE children SET state = ?, k = ? WHERE workflow_id = ?',
      patch.state ?? c.state,
      patch.k ?? c.k,
      workflowId,
    )
  }

  private waitOf(workflowId: string): IChildWait {
    return getBlob<IChildWait>(this.sql, `wait:${workflowId}`) ?? initialChildWait()
  }

  private inputOf<T extends ChildInput>(workflowId: string): T | undefined {
    return getBlob<T>(this.sql, `child:${workflowId}`)
  }

  childPhase(workflowId: string, k: number): ChildPhase {
    const done = this.applied(`child:${workflowId}`, k)
    if (done) return { applied: done }
    const c = this.child(workflowId)
    const input = this.inputOf(workflowId)
    if (!c || !input || c.state === 'ended' || c.k !== k) return { gone: true }
    const answers =
      k > 0 ? getBlob<Record<string, IAnswer>>(this.sql, `answers:${workflowId}`) : undefined
    return {
      kind: c.kind,
      input,
      ...(answers ? { answers } : {}),
      stopping: c.state === 'stopping',
    }
  }

  childStopping(workflowId: string): boolean {
    const c = this.child(workflowId)
    return !c || c.state === 'stopping' || c.state === 'ended'
  }

  // A child's phase came out: its run parked (it waits for a person - or, stopped meanwhile, it
  // ends), or it is over (completed, stopped, failed): its stream's end, the items it waited for
  // closed, and its outcome to whoever waits for it - the parked turn's item (a subagent, a
  // pipeline), or the pipeline (a node visit).
  childOutcome(workflowId: string, k: number, outcome: ChildOutcome): { applied: string } {
    return this.tx(() => {
      const scope = `child:${workflowId}`
      const done = this.applied(scope, k)
      if (done) return { applied: done }
      const c = this.child(workflowId)
      const s = this.loaded()
      if (!c || !s || c.state === 'ended') return { applied: 'gone' }
      this.markApplied(scope, k, outcome.status)
      if (outcome.status === 'parked') {
        if (c.state === 'stopping') {
          this.finishChild(s.state, c, { status: 'stopped', runId: outcome.runId })
        } else {
          this.parkChild(s.state, c, outcome)
        }
      } else {
        this.finishChild(s.state, c, outcome)
      }
      this.pump(s.state, s.meta)
      return { applied: outcome.status }
    })
  }

  private parkChild(state: ISessionState, c: IChildRecord, parked: IChildParked): void {
    const wait = this.waitOf(c.workflowId)
    const node = this.nodeOf(c)
    const parent = this.parentTurnOf(c)
    childParked(wait, parked, this.now())
    // Under the SESSION (the gateway's lookup), in the parent's turn (a stop of that turn closes
    // them), owned by the child (who the answer goes to).
    recordParked(
      this.sql,
      parked.requests.map((r) => ({
        sessionId: state.sessionId,
        itemId: r.requestId,
        turn: parent,
        runId: parked.runId,
        kind: r.kind,
        answeredBy: 'client' as const,
        owner: {
          workflowId: c.workflowId,
          itemId: c.itemId,
          ...(node ? { nodeId: node.nodeId, visit: node.visit } : {}),
        },
        item: { kind: r.kind, ...(r.question as object) },
      })),
    )
    childPark(
      state,
      {
        itemId: c.itemId,
        kind: c.kind === 'subagent' ? 'subagent' : 'pipeline',
        workflowId: c.workflowId,
        ...(node ? { nodeId: node.nodeId, visit: node.visit } : {}),
        runId: parked.runId,
        state: 'waiting',
        requests: parked.requests,
        at: this.now(),
      },
      this.now(),
    )
    this.setChild(c.workflowId, { state: 'waiting' })
    if (childReady(wait)) {
      this.resumeChild(state, { ...c, state: 'waiting' }, wait)
    } else {
      putBlob(this.sql, `wait:${c.workflowId}`, wait)
    }
  }

  // Every item has its answer: the child goes on - the SAME run, with them, as its next phase.
  private resumeChild(state: ISessionState, c: IChildRecord, wait: IChildWait): void {
    const runId = wait.parked?.runId ?? ''
    const answers = takeChildAnswers(wait)
    putBlob(this.sql, `wait:${c.workflowId}`, wait)
    markAnswered(this.sql, state.sessionId, Object.keys(answers))
    const node = this.nodeOf(c)
    childPark(
      state,
      {
        itemId: c.itemId,
        kind: c.kind === 'subagent' ? 'subagent' : 'pipeline',
        workflowId: c.workflowId,
        ...(node ? { nodeId: node.nodeId, visit: node.visit } : {}),
        runId,
        state: 'resumed',
        answered: Object.keys(answers),
        at: this.now(),
      },
      this.now(),
    )
    const k = c.k + 1
    putBlob(this.sql, `answers:${c.workflowId}`, answers)
    this.setChild(c.workflowId, { state: 'running', k })
    this.effect({
      kind: 'event',
      workflow: c.kind,
      id: c.workflowId,
      type: resumeEventOf(k),
      payload: {},
    })
  }

  private nodeOf(c: IChildRecord): { nodeId: string; visit: number } | undefined {
    if (c.kind !== 'node') return undefined
    const input = this.inputOf<IPipelineNodeInput>(c.workflowId)
    return input ? { nodeId: input.node.id, visit: input.input.visit } : undefined
  }

  private parentTurnOf(c: IChildRecord): number {
    return this.inputOf<ChildInput>(c.workflowId)?.turn ?? 0
  }

  private streamOf(c: IChildRecord): string {
    return this.inputOf<ChildInput>(c.workflowId)?.stream ?? `${c.workflowId}`
  }

  // A child is over: its stream's turn.ended (what examples/swarm's child workflow writes with
  // `endTurn`), what it waited for closed with it, and its outcome delivered.
  private finishChild(
    state: ISessionState,
    c: IChildRecord,
    outcome: SubagentOutcome | PipelineNodeOutcome | PipelineOutcome,
  ): void {
    const wait = this.waitOf(c.workflowId)
    closeChildWait(wait)
    putBlob(this.sql, `wait:${c.workflowId}`, wait)
    this.setChild(c.workflowId, { state: 'ended' })
    const o = outcome as {
      status: string
      runId?: string
      attempt?: number
      text?: string
      usage?: unknown
      error?: string
      route?: string
      runs?: number
      stoppedBy?: string
    }
    const body: Record<string, unknown> = {
      status: o.status,
      ...(c.kind === 'pipeline'
        ? {
            ...(o.status === 'completed' ? { text: o.text } : {}),
            ...(o.status === 'completed' && o.stoppedBy ? { stoppedBy: o.stoppedBy } : {}),
            ...(o.status === 'failed' ? { error: o.error } : {}),
            runs: o.runs ?? 0,
            usage: o.usage ?? emptyUsage(),
          }
        : {
            ...(o.status === 'completed'
              ? { text: o.text, usage: o.usage, ...(o.route ? { route: o.route } : {}) }
              : {}),
            ...(o.status === 'failed' ? { error: o.error } : {}),
            ...(o.status !== 'failed' && o.runId ? { runId: o.runId } : {}),
            ...(o.status !== 'failed' && o.attempt ? { attempt: o.attempt } : {}),
          }),
    }
    this.events([markerRow({ kind: 'ended', stream: this.streamOf(c), turn: 1, body })])
    cancelOwned(this.sql, state.sessionId, c.workflowId)
    const now = this.now()
    if (c.kind === 'subagent') {
      childFinished(state, c.itemId, outcome as SubagentOutcome, now)
    } else if (c.kind === 'pipeline') {
      pipelineFinished(state, c.itemId, outcome as PipelineOutcome, now)
    } else if (c.parent && this.child(c.parent)?.state !== 'ended') {
      const node = this.nodeOf(c)
      this.effect({
        kind: 'event',
        workflow: 'pipeline',
        id: c.parent,
        type: SETTLED_EVENT,
        payload: {
          workflowId: c.workflowId,
          ...(node ? { nodeId: node.nodeId, visit: node.visit } : {}),
          outcome: outcome as unknown as Record<string, unknown>,
        },
      })
    }
  }

  // Stop every child that is not over: a waiting one ends at once (nothing of it runs: its
  // instance is told to end), a working one at its next heartbeat or phase (`stopping`), a
  // pipeline is told to abort its graph (its node visits are children here too).
  private stopChildren(state: ISessionState): void {
    for (const c of this.children()) {
      this.stopChild(state, c)
    }
  }

  private stopChild(state: ISessionState, c: IChildRecord): void {
    if (c.state === 'ended' || c.state === 'stopping') return
    if (c.state === 'waiting') {
      this.finishChild(state, c, { status: 'stopped' } as SubagentOutcome)
      this.effect({
        kind: 'event',
        workflow: c.kind,
        id: c.workflowId,
        type: resumeEventOf(c.k + 1),
        payload: { stop: true },
      })
      return
    }
    this.setChild(c.workflowId, { state: 'stopping' })
    if (c.kind === 'pipeline') {
      this.effect({
        kind: 'event',
        workflow: 'pipeline',
        id: c.workflowId,
        type: SETTLED_EVENT,
        payload: { stop: true },
      })
    }
  }

  // --- a pipeline's instance ---------------------------------------------------------------------

  // A node visit the pipeline's graph engine starts: a child of the session (so a stop reaches
  // it, and an answer to its own park finds it), started once.
  startNodeVisit(pipelineWorkflowId: string, input: IPipelineNodeInput): { started: boolean } {
    return this.tx(() => {
      const s = this.loaded()
      const pipeline = this.child(pipelineWorkflowId)
      if (!s || !pipeline || pipeline.kind !== 'pipeline') return { started: false }
      if (this.child(input.workflowId)) return { started: true }
      this.addChild(
        {
          workflowId: input.workflowId,
          kind: 'node',
          itemId: input.itemId,
          parent: pipelineWorkflowId,
          state: pipeline.state === 'stopping' ? 'stopping' : 'running',
          k: 0,
        },
        input,
      )
      this.startInstance(s.state, 'node', input.workflowId)
      return { started: true }
    })
  }

  // A visit the engine gave up on (another node of its wave failed): stopped like a session stop
  // stops it.
  stopNodeVisit(workflowId: string): void {
    this.tx(() => {
      const s = this.loaded()
      const c = this.child(workflowId)
      if (!s || !c || c.kind !== 'node') return
      this.stopChild(s.state, c)
      this.pump(s.state, s.meta)
    })
  }

  // A batch of a pipeline's own stream (its engine's events, numbered by its instance). Written
  // once: a retried batch is a no-op.
  writeStream(batch: IStreamBatch): void {
    this.tx(() => {
      this.events(streamBatchRows(batch, this.eventMaxBytes))
    })
  }

  // --- a step's writes ---------------------------------------------------------------------------

  // A stream's turn.started (written once: a retry's is a no-op).
  started(stream: string, turn: number, body: Record<string, unknown>): void {
    this.tx(() => {
      this.events([markerRow({ kind: 'started', stream, turn, body })])
    })
  }

  appendEvents(rows: IEventRow[]): void {
    this.tx(() => {
      this.events(rows)
    })
  }

  // The stream exists (a child's before its run began has no rows yet: the gateway checks the
  // item instead).
  hasStream(stream: string): boolean {
    return streamExists(this.sql, stream)
  }
}
