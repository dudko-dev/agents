// Everything the session's Durable Object does, as a plain class: the RPC surface the gateway and
// the steps call (backend.ts, steps.ts' ISessionPort), the event streams it serves, the outbox's
// effects and the alarm's jobs. `durable.ts` is a thin `DurableObject` around it that gives it its
// storage, its alarm and the Workflow bindings; the tests give it node:sqlite and fakes - so what
// runs in workerd is what the unit tests run.
//
//   - the outbox: the effects a transition decided (start a Workflow instance, send one an event),
//     made after its transaction, in the order they were decided, one at a time; the first that
//     fails stops the drain (a later one never overtakes it) and is retried with backoff from the
//     alarm; one that keeps failing is given up, with a log;
//   - the idle timer: the session ends after SESSION_IDLE_TIMEOUT_MS without work (session.ts);
//   - the watchdog: a turn or a child the object still counts as working whose Workflow instance
//     errored, was terminated or completed without its outcome reaching the object is failed - what
//     Temporal tells a workflow about an activity it gave up on, said here by asking the instance.
//     One whose step has gone silent (no heartbeat, no event for three lease TTLs) while the
//     instance still says it runs is NUDGED: sent an event nothing waits for (`NUDGE_EVENT`), which
//     wakes an engine that lost the process its step ran in. Cloudflare's own engine restarts such
//     a step by itself, and a nudge is then a no-op; Miniflare's (`wrangler dev`) resumes an
//     instance only when something sends it an event - a dev server killed mid-step would wait
//     forever without it (e2e/crash.test.ts).
import type { IJournalEntry, IRunSnapshot } from '@dudko.dev/agent'
import {
  createGatewayHandler,
  errorMessage,
  silentLogger,
  type IAnswer,
  type IApiConfig,
  type IGatewayHandler,
  type ILogger,
  type IParkedRow,
  type IPipelineNodeInput,
  type ISessionBackend,
  type ISessionOptions,
  type ISessionView,
  type IStopRequest,
  type IStreamBatch,
  type IUserMessage,
  type TurnOutcome,
} from 'swarm-shared'
import { createEventHub, type IEventHub } from './feed.ts'
import {
  SessionCore,
  turnInstanceOf,
  type ChildOutcome,
  type ChildPhase,
  type Effect,
  type Result,
  type TurnPhase,
  type WorkflowKind,
} from './session.ts'
import type { ISql, IStorage } from './sql.ts'
import type { StopScope } from './steps.ts'
import {
  appendJournal,
  bindRun,
  eventsAfter,
  fenceRun,
  latestRunOfTurn,
  leaseAcquire,
  leaseRelease,
  leaseRenew,
  loadJournal,
  loadRun,
  nextAttemptBase,
  supersedeRun,
  writeSnapshot,
  type IEventRow,
  type IRunBinding,
  type IRunRow,
} from './store.ts'

// How often the watchdog asks the instances of what runs: four lease TTLs (a minute by default),
// at least 5 s.
export const watchdogMsOf = (leaseTtlMs: number): number => Math.max(5000, 4 * leaseTtlMs)
// What wakes an instance whose step went silent (nothing waits for it).
export const NUDGE_EVENT = 'nudge'
// How many times an effect is tried before it is given up.
export const OUTBOX_MAX_ATTEMPTS = 12

// What an instance says about itself (a Workflow instance's `status()`).
export type InstanceStatus = { status: string; error?: { message?: string } } | 'not_found'

export interface ISessionHostOptions {
  storage: IStorage
  eventMaxBytes: number
  // The runLease TTL (LEASE_TTL_MS): the watchdog's pace and its patience.
  leaseTtlMs: number
  // Make one effect (a Workflow binding call). Throws to be retried.
  perform: (effect: Effect) => Promise<void>
  // A Workflow instance's status, for the watchdog.
  status?: (kind: WorkflowKind, id: string) => Promise<InstanceStatus>
  // Set (or clear, undefined) the object's alarm.
  setAlarm?: (at: number | undefined) => Promise<void>
  // For the event streams this object serves.
  api?: () => IApiConfig
  log?: ILogger
  now?: () => number
  // Keep a promise running after the call that started it (the object's waitUntil).
  waitUntil?: (p: Promise<unknown>) => void
}

export class SessionHost {
  readonly core: SessionCore
  readonly hub: IEventHub
  private readonly storage: IStorage
  private readonly o: ISessionHostOptions
  private readonly now: () => number
  private readonly log: ILogger
  private gateway?: IGatewayHandler
  private draining?: Promise<void>
  private again = false
  // When each working phase was last heard of (a heartbeat, events, its input read). In memory:
  // after a restart of the object a phase counts as heard of when the watchdog first looks.
  private readonly heard = new Map<string, number>()

  constructor(o: ISessionHostOptions) {
    this.o = o
    this.storage = o.storage
    this.now = o.now ?? Date.now
    this.log = o.log ?? silentLogger
    const sql = o.storage.sql
    this.hub = createEventHub((stream, after, limit) => eventsAfter(sql, stream, after, limit))
    this.core = new SessionCore({
      storage: o.storage,
      eventMaxBytes: o.eventMaxBytes,
      now: this.now,
      notify: (streams) => this.hub.notify(streams),
    })
  }

  private get sql(): ISql {
    return this.storage.sql
  }

  // After a transition: make its effects (in the background of this call) and set the alarm.
  private settle<T>(value: T): T {
    const p = this.drain()
    if (this.o.waitUntil) this.o.waitUntil(p)
    else void p
    return value
  }

  // --- the gateway's calls (backend.ts) -----------------------------------------------------------

  exists(): boolean {
    return this.core.exists()
  }

  create(sessionId: string, options: ISessionOptions, first?: IUserMessage): Result {
    return this.settle(this.core.create(sessionId, options, first))
  }

  message(message: IUserMessage): Result {
    return this.settle(this.core.message(message))
  }

  answer(answer: IAnswer): Result {
    return this.settle(this.core.answer(answer))
  }

  answerChild(workflowId: string, answer: IAnswer): Result {
    return this.settle(this.core.answerChild(workflowId, answer))
  }

  stop(stop: IStopRequest): Result {
    return this.settle(this.core.stop(stop))
  }

  view(): Result<ISessionView> {
    return this.core.view()
  }

  parkedItem(itemId: string): IParkedRow | undefined {
    return this.core.parkedItem(itemId)
  }

  calls(by: 'subagent' | 'pipeline'): IParkedRow[] {
    return this.core.calls(by)
  }

  // The session's event streams (the Worker forwards GET .../events here): swarm-shared's own
  // handler, with this object's log as its feed - replay after the cursor, then live.
  async fetch(request: Request): Promise<Response> {
    if (!this.gateway) {
      if (!this.o.api) throw new Error('no API configuration for the event streams')
      const local: ISessionBackend = {
        exists: async () => this.core.exists(),
        parkedItem: async (_sessionId, itemId) => this.core.parkedItem(itemId),
        create: unsupported,
        message: unsupported,
        answer: unsupported,
        answerChild: unsupported,
        stop: unsupported,
        state: unsupported,
        subagents: unsupported,
        pipelines: unsupported,
        ready: async () => {},
      }
      this.gateway = createGatewayHandler({
        config: this.o.api(),
        backend: local,
        feed: this.hub,
        log: this.log,
        storeName: 'durable object',
      })
    }
    return this.gateway.fetch(request)
  }

  // --- a step's calls (steps.ts: ISessionPort) ----------------------------------------------------

  started(stream: string, turn: number, body: Record<string, unknown>): void {
    this.core.started(stream, turn, body)
  }

  appendEvents(rows: IEventRow[], scope: StopScope): { stop: boolean } {
    this.core.appendEvents(rows)
    this.heardOf(scope)
    return { stop: this.stopping(scope) }
  }

  private heardOf(scope: StopScope): void {
    this.heard.set('turn' in scope ? `turn:${scope.turn}` : `child:${scope.child}`, this.now())
  }

  private stopping(scope: StopScope): boolean {
    return 'turn' in scope
      ? this.core.turnStopping(scope.turn)
      : this.core.childStopping(scope.child)
  }

  bindRun(b: IRunBinding): boolean {
    return bindRun(this.sql, b)
  }

  latestRunOfTurn(stream: string, turn: number): IRunRow | undefined {
    return latestRunOfTurn(this.sql, stream, turn)
  }

  nextAttemptBase(stream: string, turn: number): number {
    return nextAttemptBase(this.sql, stream, turn)
  }

  supersedeRun(runId: string): boolean {
    return supersedeRun(this.sql, runId)
  }

  fenceRun(runId: string): number | undefined {
    return fenceRun(this.sql, runId)
  }

  writeSnapshot(s: IRunSnapshot, mode: 'checkpoint' | 'resume'): boolean {
    return this.storage.transactionSync(() => writeSnapshot(this.sql, s, mode))
  }

  loadRun(runId: string): IRunSnapshot | null {
    return loadRun(this.sql, runId)
  }

  appendJournal(runId: string, entry: IJournalEntry): boolean {
    return this.storage.transactionSync(() => appendJournal(this.sql, runId, entry))
  }

  loadJournal(runId: string): IJournalEntry[] {
    return loadJournal(this.sql, runId)
  }

  leaseAcquire(runId: string, owner: string, ttlMs: number): boolean {
    return leaseAcquire(this.sql, runId, owner, ttlMs, this.now())
  }

  heartbeat(
    scope: StopScope,
    runId: string,
    owner: string,
    ttlMs: number,
  ): { held: boolean; stop: boolean } {
    this.heardOf(scope)
    return {
      held: leaseRenew(this.sql, runId, owner, ttlMs, this.now()),
      stop: this.stopping(scope),
    }
  }

  leaseRelease(runId: string, owner: string): void {
    leaseRelease(this.sql, runId, owner)
  }

  turnPhase(turn: number, k: number): TurnPhase {
    this.heardOf({ turn })
    return this.core.turnPhase(turn, k)
  }

  turnOutcome(turn: number, k: number, outcome: TurnOutcome): { applied: string } {
    return this.settle(this.core.turnOutcome(turn, k, outcome))
  }

  childPhase(workflowId: string, k: number): ChildPhase {
    this.heardOf({ child: workflowId })
    return this.core.childPhase(workflowId, k)
  }

  childOutcome(workflowId: string, k: number, outcome: ChildOutcome): { applied: string } {
    return this.settle(this.core.childOutcome(workflowId, k, outcome))
  }

  childStopping(workflowId: string): boolean {
    return this.core.childStopping(workflowId)
  }

  startNodeVisit(pipelineWorkflowId: string, input: IPipelineNodeInput): { started: boolean } {
    return this.settle(this.core.startNodeVisit(pipelineWorkflowId, input))
  }

  stopNodeVisit(workflowId: string): void {
    this.core.stopNodeVisit(workflowId)
    this.settle(undefined)
  }

  writeStream(batch: IStreamBatch): void {
    this.core.writeStream(batch)
  }

  // --- the outbox, the alarm -----------------------------------------------------------------------

  // Resolves once every effect that can be made now was made (or failed, to be retried).
  drain(): Promise<void> {
    if (this.draining) {
      this.again = true
      return this.draining
    }
    this.draining = (async () => {
      try {
        do {
          this.again = false
          await this.drainOnce()
        } while (this.again)
      } finally {
        this.draining = undefined
        await this.schedule()
      }
    })()
    return this.draining
  }

  private async drainOnce(): Promise<void> {
    for (;;) {
      const row = this.sql
        .exec<{
          id: number
          body: string
          attempts: number
          next_at: number
        }>('SELECT id, body, attempts, next_at FROM outbox ORDER BY id LIMIT 1')
        .toArray()[0]
      if (!row || row.next_at > this.now()) return
      const effect = JSON.parse(row.body) as Effect
      try {
        await this.o.perform(effect)
        this.sql.exec('DELETE FROM outbox WHERE id = ?', row.id)
      } catch (err) {
        const attempts = row.attempts + 1
        this.log.warn('an effect failed; it is retried', {
          effect: effect.kind,
          workflow: effect.workflow,
          id: effect.id,
          attempts,
          error: errorMessage(err),
        })
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
          this.log.error('an effect was given up', {
            effect: effect.kind,
            workflow: effect.workflow,
            id: effect.id,
            error: errorMessage(err),
          })
          this.sql.exec('DELETE FROM outbox WHERE id = ?', row.id)
          continue
        }
        this.sql.exec(
          'UPDATE outbox SET attempts = ?, next_at = ? WHERE id = ?',
          attempts,
          this.now() + Math.min(60_000, 500 * 2 ** attempts),
          row.id,
        )
        return
      }
    }
  }

  // The next time the alarm has work: an effect to retry, the idle deadline, the watchdog.
  nextAlarm(): number | undefined {
    const at: number[] = []
    const next = this.sql.exec<{ t: number | null }>('SELECT MIN(next_at) AS t FROM outbox').one().t
    if (next !== null) at.push(Math.max(next, this.now() + 10))
    const idle = this.core.idleDeadline()
    if (idle !== undefined) at.push(idle)
    const live = this.core.live()
    if (live && (live.turn !== undefined || live.children.length)) {
      at.push(this.now() + watchdogMsOf(this.o.leaseTtlMs))
    }
    return at.length ? Math.min(...at) : undefined
  }

  private async schedule(): Promise<void> {
    await this.o.setAlarm?.(this.nextAlarm())
  }

  async alarm(): Promise<void> {
    this.core.idle()
    await this.watchdog().catch((err) =>
      this.log.warn('watchdog failed', { error: errorMessage(err) }),
    )
    await this.drain()
  }

  async watchdog(): Promise<void> {
    const status = this.o.status
    const live = this.core.live()
    if (!status || !live) return
    // An instance whose start is still in the outbox is not dead: it is not there yet.
    const starting = new Set(
      this.sql
        .exec<{ body: string }>('SELECT body FROM outbox')
        .toArray()
        .map((r) => JSON.parse(r.body) as Effect)
        .filter((e) => e.kind === 'create')
        .map((e) => `${e.workflow}:${e.id}`),
    )
    const now = this.now()
    const patience = 3 * this.o.leaseTtlMs
    const dead = async (
      kind: WorkflowKind,
      id: string,
      heard: string,
    ): Promise<string | undefined> => {
      if (starting.has(`${kind}:${id}`)) return undefined
      const s = await status(kind, id)
      if (s === 'not_found') return 'its workflow instance is gone'
      if (s.status === 'errored' || s.status === 'terminated' || s.status === 'complete') {
        return `its workflow instance is ${s.status}${s.error?.message ? `: ${s.error.message}` : ''}`
      }
      const last = this.heard.get(heard)
      if (last === undefined) {
        this.heard.set(heard, now)
      } else if (now - last > patience && (s.status === 'running' || s.status === 'queued')) {
        this.log.warn('a step went silent: nudging its instance', { workflow: kind, id })
        this.heard.set(heard, now)
        await this.o
          .perform({ kind: 'event', workflow: kind, id, type: NUDGE_EVENT, payload: {} })
          .catch((err) => this.log.warn('nudge failed', { id, error: errorMessage(err) }))
      }
      return undefined
    }
    if (live.turn !== undefined) {
      const why = await dead('turn', turnInstanceOf(live.sessionId, live.turn), `turn:${live.turn}`)
      if (why) this.core.failRunning(live.turn, why)
    }
    for (const c of live.children) {
      const why = await dead(c.kind, c.workflowId, `child:${c.workflowId}`)
      if (why) {
        this.core.childOutcome(c.workflowId, c.k, { status: 'failed', error: why } as ChildOutcome)
      }
    }
  }
}

const unsupported = async (): Promise<never> => {
  throw new Error('not served by the session object')
}
