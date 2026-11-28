// `persistence.journal`: the CALL JOURNAL of a run, and PARKING a run on what it waits for.
//
// The journal records, as the run goes, every language-model response (the parts the SDK needs
// to continue: text, reasoning, tool calls, the finish reason, the provider's metadata) and every
// tool result (as the model saw it, after the output cap). A resume (`resumeFromRunId`) loads it
// and REPLAYS the step a crash - or a park - interrupted: a model call whose request matches the
// one recorded at its position gets the recorded response (no request goes out, sharedLimits is
// not asked, nothing is charged again), a tool call whose name and arguments match gets the
// recorded result (the tool does not run). At the first call that does not match, and at the end
// of the journal, the run goes on live.
//
// Positions are the same on every attempt: `<segment>.<n>` is the n-th model call of a segment
// (`0` before the loop, `1`, `2`, ... the loop's iterations, `f` the answer) - n counts only the
// calls that were recorded, so a failed call and its retry share one -, `.t<i>` the i-th tool
// call of that response, `.q<j>` a question asked inside that tool call, `.m<k>` a model call
// made inside it, `/c<k>/` a run started inside it (a helper, an in-process subagent: its calls
// are recorded in the same journal, under that prefix). A tool entry names the model entry that
// asked for it (`parent`), so a call is never answered from another branch of the run.
//
// Order: a model response is appended BEFORE any tool call it contains runs (the stream's
// tool-call parts are held until the response is complete and on record); a tool result is
// appended right after the tool returns, before the model sees it. Appends are fail-closed: one
// that throws ends the run as failed - a side effect the journal does not know about would break
// the guarantee. The one window that cannot be closed: a tool that ran, but whose result was not
// appended before the process died, runs again.
//
// Parking: a question of the approval gate answered `{ park: true }`, or a tool that returns
// `deferResult()`, makes that call PENDING. The round's other calls settle as usual; at the end
// of the round (before the next model call, or when the step's loop ends) the run parks with
// every pending item of the round: it stops without failing, and the run that resumes it with
// `answers` replays up to that round, answers the pending calls from `answers` and goes on live.
// Answers are recorded too: a crash after the resume does not need them again.
//
// The core keeps no timers or retries for pending items: those are the host's. Node only: the
// browser sibling reserves the names (its docs/design.md says why).

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { LanguageModelMiddleware } from 'ai'
import { runContext } from './context.ts'
import type { ModelCallStage } from './shared-limits.ts'
import type {
  AgentEvent,
  IJournalAnswerEntry,
  IJournalEntry,
  IJournalModelEntry,
  IJournalPendingEntry,
  IJournalToolEntry,
  IPersistence,
  IRunJournal,
  IRunSnapshot,
  IToolApprovalRequest,
  IUsage,
  ParkAnswer,
  ParkedItem,
  ToolApprovalAnswer,
  ToolResultAnswer,
} from './types.ts'
import { accumulateUsage, emptyUsage, normalizeUsage } from './utils.ts'

/** The bounds on what comes from outside the run (a deferred call's note, an answer). */
export const JOURNAL_LIMITS = Object.freeze({
  // deferResult({ note }): what the tool says about the result to come.
  noteChars: 2_000,
  // A tool answer's `output`, serialized.
  answerChars: 1_000_000,
  // A tool answer's `error`.
  errorChars: 4_000,
  // Nesting of a tool answer's `output`.
  answerDepth: 64,
})

// ── deferResult: the result of a tool call comes later, from outside ─────────────────────────────

const DEFERRED = Symbol.for('@dudko.dev/agent:deferred-result')

/** What `deferResult()` returns. Opaque: return it from a tool's `execute`. */
export interface IDeferredResult {
  readonly [DEFERRED]: true
  readonly note?: string
}

// Characters a person would not see in a text: controls (but \t \n), zero-width and bidi marks.
const INVISIBLE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g

const cleanText = (text: string, max: number): string => {
  const s = text.replace(INVISIBLE, '').trim()
  return s.length > max ? `${s.slice(0, max)}... [truncated, ${s.length - max} chars]` : s
}

/**
 * Return this from a tool's `execute` when its result will come from outside the run, later (a
 * long job, a webhook, a review in another system). The run parks at the end of the tool round;
 * the host resumes it with the result as the answer to that item. Needs `persistence.journal`:
 * without it the call fails with a clear error. `note` (clipped, invisible characters removed)
 * is shown with the parked item.
 */
export const deferResult = (options: { note?: string } = {}): IDeferredResult => {
  const note =
    typeof options?.note === 'string' ? cleanText(options.note, JOURNAL_LIMITS.noteChars) : ''
  return Object.freeze({ [DEFERRED]: true as const, ...(note ? { note } : {}) })
}

export const isDeferredResult = (value: unknown): value is IDeferredResult =>
  Boolean(value) &&
  typeof value === 'object' &&
  (value as Record<symbol, unknown>)[DEFERRED] === true

// What a pending call hands the SDK in place of a result: the model never sees it (the run
// parks before the next model call).
const PENDING = Object.freeze({ [Symbol.for('@dudko.dev/agent:pending-tool-call')]: true })
const PENDING_MODEL_OUTPUT = { type: 'text', value: '[waiting for a result from outside the run]' }

export const isPendingToolOutput = (value: unknown): boolean => value === PENDING

// ── errors ───────────────────────────────────────────────────────────────────────────────────────

/** An append to (or a read of) the journal failed: the run cannot go on with an exact record. */
export class JournalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JournalError'
  }

  toJSON(): string {
    return this.message
  }
}

// Thrown where a run (or a run inside it) parks: never reaches the host - `agent.run()` resolves
// with `result.parked`.
export class RunParkedSignal extends Error {
  constructor() {
    super('the run parked: it waits for answers from outside')
    this.name = 'RunParkedSignal'
  }
}

export const isRunParked = (err: unknown): boolean =>
  err instanceof RunParkedSignal ||
  (Boolean(err) &&
    typeof err === 'object' &&
    (err as { name?: unknown }).name === 'RunParkedSignal')

/** The failure a deferred call was answered with (`{ error }`). */
export class ToolResultError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolResultError'
  }

  toJSON(): string {
    return this.message
  }
}

// ── stable serialization and hashes ──────────────────────────────────────────────────────────────

/**
 * JSON with object keys sorted, bytes as base64, dates as ISO strings, URLs as their href: the
 * same value always gives the same text. What the journal's hashes are taken of.
 */
export const stableJson = (value: unknown): string => {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'bigint') {
        return `${v}n`
      }
      if (typeof v === 'function' || typeof v === 'symbol') {
        return undefined
      }
      if (typeof v === 'number' && !Number.isFinite(v)) {
        return String(v)
      }
      return v
    }
    if (v instanceof Uint8Array) {
      return { $bytes: Buffer.from(v).toString('base64') }
    }
    if (v instanceof ArrayBuffer) {
      return { $bytes: Buffer.from(new Uint8Array(v)).toString('base64') }
    }
    if (v instanceof Date) {
      return { $date: Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString() }
    }
    if (v instanceof URL) {
      return { $url: v.href }
    }
    if (seen.has(v)) {
      return '[circular]'
    }
    seen.add(v)
    try {
      if (Array.isArray(v)) {
        return v.map((x) => {
          const w = walk(x)
          return w === undefined ? null : w
        })
      }
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v).sort()) {
        const w = walk((v as Record<string, unknown>)[key])
        if (w !== undefined) {
          out[key] = w
        }
      }
      return out
    } finally {
      seen.delete(v)
    }
  }
  return JSON.stringify(walk(value)) ?? 'null'
}

export const journalHash = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex')

// A model part made plain JSON for the journal, and back: bytes, dates and URLs are tagged.
const encode = (v: unknown, depth = 0): unknown => {
  if (depth > 64) {
    return null
  }
  if (v instanceof Uint8Array) {
    return { $bytes: Buffer.from(v).toString('base64') }
  }
  if (v instanceof Date) {
    return { $date: v.toISOString() }
  }
  if (v instanceof URL) {
    return { $url: v.href }
  }
  if (Array.isArray(v)) {
    return v.map((x) => encode(x, depth + 1))
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, x] of Object.entries(v)) {
      if (x !== undefined && typeof x !== 'function' && typeof x !== 'symbol') {
        out[key] = encode(x, depth + 1)
      }
    }
    return out
  }
  return typeof v === 'bigint' ? String(v) : v
}

const decode = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    return v.map(decode)
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 1) {
      if (typeof o.$bytes === 'string') {
        return new Uint8Array(Buffer.from(o.$bytes, 'base64'))
      }
      if (typeof o.$date === 'string') {
        return new Date(o.$date)
      }
      if (typeof o.$url === 'string') {
        return new URL(o.$url)
      }
    }
    return Object.fromEntries(keys.map((key) => [key, decode(o[key])]))
  }
  return v
}

// A plain JSON copy, or undefined for a value JSON cannot hold.
const jsonCopy = (v: unknown): unknown => {
  try {
    const s = JSON.stringify(v)
    return s === undefined ? undefined : JSON.parse(s)
  } catch {
    return undefined
  }
}

const findLast = <T>(items: readonly T[], pred: (item: T) => boolean): T | undefined => {
  for (let i = items.length - 1; i >= 0; i--) {
    if (pred(items[i])) {
      return items[i]
    }
  }
  return undefined
}

const messageOf = (err: unknown): string =>
  err == null
    ? 'unknown error'
    : typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : (() => {
            try {
              return JSON.stringify(err)
            } catch {
              return String(err)
            }
          })()

// ── the session of one attempt, and its scopes ───────────────────────────────────────────────────

type Stopped = { kind: 'park' } | { kind: 'fatal'; error: Error }

/** One attempt's view of a run's journal. Shared by every scope of the run. */
export interface IJournalSession {
  runId: string
  attempt: number
  hook: IRunJournal
  byPosition: Map<string, IJournalEntry[]>
  // `answers`, checked: by item id.
  answers: Map<string, ParkAnswer>
  used: Set<string>
  // What was pending when this attempt started (the snapshot's items, the journal's open ones).
  pendingIds: Set<string>
  // What this attempt parks on, in the order the items came.
  items: ParkedItem[]
  // The recorded usage of the model calls replayed so far, not yet in the run's total.
  replayed: IUsage
  stopped?: Stopped
  root: IJournalScope
  lost: () => Error | undefined
  outputSanitizer?: (toolName: string, output: unknown) => unknown | Promise<unknown>
}

/** A run's place in the journal: the run the host started, or a run inside one of its calls. */
export interface IJournalScope {
  session: IJournalSession
  prefix: string
  nested: boolean
  parent?: { scope: IJournalScope; call: IJournalCallRef }
  segment: string
  // Recorded model calls so far, by position base.
  counts: Map<string, number>
  // No more lookups: the journal ended, or the run diverged from it.
  live: boolean
  diverged: boolean
  // A call of the current round is pending: the run parks at the end of the round.
  pendingRound: boolean
  parked: boolean
  // Aborts this run (combined into its signal): a park, or a failed append.
  stop: AbortController
  // Tool calls of the model responses seen, by toolCallId, until they run.
  calls: Map<string, IJournalCallRef>
  // What the model is shown of a tool result, by toolCallId (the tool's toModelOutput asks).
  outputs: Map<string, unknown>
}

/** A tool call of a recorded model response. */
export interface IJournalCallRef {
  scope: IJournalScope
  toolCallId: string
  position: string
  // The model entry whose response asked for it.
  parent: string
  // The response was replayed: the call is looked up in the journal.
  replay: boolean
  questions: number
  children: number
  // A run started inside this call parked.
  childParked: boolean
}

// The tool call a piece of code runs inside (set by the tool wrapper around the call).
const toolCallScope = new AsyncLocalStorage<IJournalCallRef>()

const entryId = (session: IJournalSession, kind: IJournalEntry['kind'], position: string): string =>
  `a${session.attempt}:${kind}:${position}`

const itemIdOf = (
  session: IJournalSession,
  position: string,
  parent: string,
  hash: string,
): string =>
  `p_${createHash('sha256').update(`${session.runId}\n${position}\n${parent}\n${hash}`).digest('hex').slice(0, 32)}`

const fail = (session: IJournalSession, error: Error): void => {
  if (session.stopped?.kind !== 'fatal') {
    session.stopped = { kind: 'fatal', error }
  }
  session.root.stop.abort(error)
}

const appendEntry = async (session: IJournalSession, entry: IJournalEntry): Promise<void> => {
  // A lost lease: nothing more is written - another worker may own the run now.
  const lost = session.lost()
  if (lost) {
    throw lost
  }
  try {
    await session.hook.append(session.runId, entry)
  } catch (err) {
    const e = new JournalError(
      `[journal] persistence.journal.append threw for run ${session.runId} at ${entry.position} (${entry.kind}); the run stops - a call the journal does not know about would break the exact resume: ${messageOf(err)}`,
      { cause: err },
    )
    fail(session, e)
    throw e
  }
}

const emitHere = (event: AgentEvent): void => {
  try {
    runContext.getStore()?.emit?.(event)
  } catch {}
}

const diverge = (
  scope: IJournalScope,
  position: string,
  kind: 'model' | 'tool',
  stage?: ModelCallStage,
): void => {
  if (scope.diverged) {
    return
  }
  scope.diverged = true
  emitHere({ type: 'journal.diverged', position, kind, ...(stage ? { stage } : {}) })
}

// ── loading, and what may be answered ────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

const isItem = (v: unknown): v is ParkedItem =>
  isObject(v) && typeof v.id === 'string' && (v.kind === 'approval' || v.kind === 'tool')

const isEntry = (v: unknown): v is IJournalEntry => {
  if (
    !isObject(v) ||
    typeof v.id !== 'string' ||
    typeof v.position !== 'string' ||
    typeof v.attempt !== 'number'
  ) {
    return false
  }
  switch (v.kind) {
    case 'model':
      return typeof v.stage === 'string' && typeof v.hash === 'string' && isObject(v.response)
    case 'tool':
      return typeof v.parent === 'string' && typeof v.hash === 'string' && typeof v.ok === 'boolean'
    case 'pending':
      return typeof v.parent === 'string' && typeof v.hash === 'string' && isItem(v.item)
    case 'answer':
      return (
        typeof v.parent === 'string' &&
        typeof v.hash === 'string' &&
        typeof v.itemId === 'string' &&
        isObject(v.answer) &&
        typeof v.answer.approved === 'boolean'
      )
    default:
      return false
  }
}

const keyOf = (e: { position: string; parent: string; hash: string }): string =>
  `${e.position}\n${e.parent}\n${e.hash}`

// What the journal says is pending (asked for, not answered yet), and what was pending and is
// answered now.
const pendingOf = (
  entries: readonly IJournalEntry[],
): { open: Map<string, ParkedItem>; resolved: Set<string> } => {
  const byKey = new Map<string, ParkedItem>()
  const resolved = new Set<string>()
  for (const e of entries) {
    if (e.kind === 'model') {
      continue
    }
    const key = keyOf(e)
    if (e.kind === 'pending') {
      byKey.set(key, e.item)
      resolved.delete(e.item.id)
      continue
    }
    const item = byKey.get(key)
    if (item) {
      byKey.delete(key)
      resolved.add(item.id)
    }
  }
  return { open: new Map([...byKey.values()].map((item) => [item.id, item])), resolved }
}

const APPROVAL_KEYS = new Set(['approved', 'reason', 'remember'])

const approvalProblem = (a: unknown): string | undefined => {
  if (typeof a === 'boolean') {
    return undefined
  }
  if (
    isObject(a) &&
    typeof a.approved === 'boolean' &&
    Object.keys(a).every((k) => APPROVAL_KEYS.has(k)) &&
    (a.reason === undefined || typeof a.reason === 'string') &&
    (a.remember === undefined || typeof a.remember === 'boolean')
  ) {
    return undefined
  }
  return "an 'approval' item takes true / false or { approved, reason?, remember? }"
}

// Plain JSON only: what a tool could have returned over the wire.
const jsonValueProblem = (v: unknown, depth: number): string | undefined => {
  if (depth > JOURNAL_LIMITS.answerDepth) {
    return `nested deeper than ${JOURNAL_LIMITS.answerDepth} levels`
  }
  if (v === null || typeof v === 'string' || typeof v === 'boolean') {
    return undefined
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? undefined : 'a number that is not finite'
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = jsonValueProblem(x, depth + 1)
      if (p) {
        return p
      }
    }
    return undefined
  }
  if (isObject(v)) {
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) {
      return 'an object that is not plain JSON'
    }
    for (const x of Object.values(v)) {
      const p = jsonValueProblem(x, depth + 1)
      if (p) {
        return p
      }
    }
    return undefined
  }
  return `a ${typeof v}, which is not JSON`
}

const toolAnswerProblem = (a: unknown): string | undefined => {
  const shape = "a 'tool' item takes { output: <JSON value> } or { error: <non-empty string> }"
  if (!isObject(a)) {
    return shape
  }
  const keys = Object.keys(a)
  if (keys.length === 1 && keys[0] === 'error') {
    return typeof a.error === 'string' && a.error.trim() ? undefined : shape
  }
  if (keys.length !== 1 || keys[0] !== 'output') {
    return shape
  }
  const p = jsonValueProblem(a.output, 0)
  if (p) {
    return `${shape}: its output is ${p}`
  }
  let size = 0
  try {
    size = JSON.stringify(a.output)?.length ?? 0
  } catch {
    return `${shape}: its output cannot be serialized`
  }
  return size > JOURNAL_LIMITS.answerChars
    ? `its output is ${size} characters as JSON, more than ${JOURNAL_LIMITS.answerChars}`
    : undefined
}

/** Why `answer` cannot answer an item of `kind`, or undefined when it can. */
export const parkAnswerProblem = (kind: ParkedItem['kind'], answer: unknown): string | undefined =>
  kind === 'approval' ? approvalProblem(answer) : toolAnswerProblem(answer)

const loadEntries = async (
  hook: IRunJournal,
  runId: string,
  warn: (message: string) => void,
): Promise<IJournalEntry[]> => {
  let raw: unknown
  try {
    raw = await hook.load(runId)
  } catch (err) {
    throw new JournalError(
      `[resume] persistence.journal.load threw for run ${runId}; the resume was refused: ${messageOf(err)}`,
      { cause: err },
    )
  }
  if (!Array.isArray(raw)) {
    throw new JournalError(
      `[resume] persistence.journal.load must return an array of entries for run ${runId}; the resume was refused`,
    )
  }
  const entries = raw.filter(isEntry)
  if (entries.length < raw.length) {
    warn(
      `[journal] ${raw.length - entries.length} entr${raw.length - entries.length === 1 ? 'y' : 'ies'} of run ${runId} not understood and ignored`,
    )
  }
  return entries
}

const newScope = (
  session: IJournalSession,
  prefix: string,
  live: boolean,
  parent?: IJournalScope['parent'],
): IJournalScope => ({
  session,
  prefix,
  nested: Boolean(parent),
  ...(parent ? { parent } : {}),
  segment: '0',
  counts: new Map(),
  live,
  diverged: false,
  pendingRound: false,
  parked: false,
  stop: new AbortController(),
  calls: new Map(),
  outputs: new Map(),
})

export interface IOpenJournalOptions {
  hook: IRunJournal | undefined
  runId: string
  attempt: number
  resumed?: IRunSnapshot
  answers?: Record<string, ParkAnswer>
  // The journal of the run this one runs inside, when there is one.
  outer?: IJournalScope
  lost: () => Error | undefined
  outputSanitizer?: (toolName: string, output: unknown) => unknown | Promise<unknown>
  warn: (message: string) => void
}

/**
 * The journal scope of a run: a scope of its own in the journal of the run it runs inside, when
 * it is started from one of that run's tool calls (a helper, an in-process subagent); else the
 * root scope of a session of its own, with the journal loaded on a resume and `answers` checked
 * against what is pending. Throws - before anything of the run happened - on answers that cannot
 * be taken, and on a parked run without a journal to resume it from.
 */
export const openJournal = async (o: IOpenJournalOptions): Promise<IJournalScope | undefined> => {
  if (o.outer) {
    const call = toolCallScope.getStore()
    if (!call || call.scope !== o.outer) {
      return undefined
    }
    const session = o.outer.session
    const prefix = `${call.position}/c${call.children++}/`
    return newScope(session, prefix, !call.replay || session.byPosition.size === 0, {
      scope: o.outer,
      call,
    })
  }
  const given = Object.entries(o.answers ?? {})
  if (!o.hook) {
    if (o.resumed?.status === 'waiting') {
      throw new Error(
        `Run "${o.runId}" parked and waits for answers; resuming it needs config.persistence.journal`,
      )
    }
    if (given.length) {
      throw new Error(
        `answers need config.persistence.journal: nothing of run "${o.runId}" can be pending without it`,
      )
    }
    return undefined
  }
  const entries = o.resumed ? await loadEntries(o.hook, o.runId, o.warn) : []
  const byPosition = new Map<string, IJournalEntry[]>()
  for (const e of entries) {
    const at = byPosition.get(e.position)
    if (at) {
      at.push(e)
    } else {
      byPosition.set(e.position, [e])
    }
  }
  const { open, resolved } = pendingOf(entries)
  if (o.resumed?.status === 'waiting') {
    for (const item of o.resumed.parked?.items ?? []) {
      if (isItem(item) && !resolved.has(item.id) && !open.has(item.id)) {
        open.set(item.id, item)
      }
    }
  }
  const answers = new Map<string, ParkAnswer>()
  for (const [id, answer] of given) {
    const item = open.get(id)
    if (!item) {
      // Answered on an earlier resume and on record: the journal's answer stands (a retried
      // resume is not an error).
      if (resolved.has(id)) {
        continue
      }
      throw new Error(
        `answers["${id}"] was refused: no item with that id is pending in run "${o.runId}"`,
      )
    }
    const problem = parkAnswerProblem(item.kind, answer)
    if (problem) {
      throw new Error(`answers["${id}"] was refused: ${problem}`)
    }
    answers.set(id, answer)
  }
  const session = {
    runId: o.runId,
    attempt: o.attempt,
    hook: o.hook,
    byPosition,
    answers,
    used: new Set<string>(),
    pendingIds: new Set(open.keys()),
    items: [] as ParkedItem[],
    replayed: emptyUsage(),
    lost: o.lost,
    ...(o.outputSanitizer ? { outputSanitizer: o.outputSanitizer } : {}),
  } as Omit<IJournalSession, 'root'> as IJournalSession
  session.root = newScope(session, '', entries.length === 0)
  return session.root
}

/** `persistence.journal` as createAgent takes it: both methods, and a loadRun to resume with. */
export const checkJournal = (persistence: IPersistence | undefined): void => {
  const journal = persistence?.journal
  if (journal === undefined) {
    return
  }
  if (!journal || typeof journal.append !== 'function' || typeof journal.load !== 'function') {
    throw new Error('persistence.journal must be { append(runId, entry), load(runId) }')
  }
  if (typeof persistence?.loadRun !== 'function') {
    throw new Error(
      'persistence.journal needs persistence.loadRun: the journal is read back when a run is resumed',
    )
  }
}

/** A new segment of the run starts: before the loop `0`, an iteration `1`, `2`, ..., the answer `f`. */
export const startJournalSegment = (scope: IJournalScope, segment: string): void => {
  scope.segment = segment
  scope.pendingRound = false
  if (!scope.nested) {
    scope.session.items = []
  }
}

/** The recorded usage of the calls replayed since the last time, for the run's own total. */
export const takeReplayedUsage = (scope: IJournalScope): IUsage | undefined => {
  const s = scope.session
  if (!s.replayed.totalTokens && !s.replayed.inputTokens && !s.replayed.outputTokens) {
    return undefined
  }
  const taken = s.replayed
  s.replayed = emptyUsage()
  return taken
}

/** The answers this attempt was given and never reached (the run diverged before them). */
export const unusedAnswers = (scope: IJournalScope): string[] =>
  [...scope.session.answers.keys()].filter((id) => !scope.session.used.has(id))

// ── parking ──────────────────────────────────────────────────────────────────────────────────────

const holdItem = (scope: IJournalScope, item: ParkedItem): void => {
  const s = scope.session
  if (!s.items.some((i) => i.id === item.id)) {
    s.items.push(item)
  }
  scope.pendingRound = true
}

// The round is over and something of it is pending: this run stops. A run inside a tool call
// stops alone and marks that call (its round parks the run above it in turn); the run the host
// started stops for good - the runner writes the 'waiting' snapshot.
const parkScope = (scope: IJournalScope): never => {
  scope.pendingRound = false
  scope.parked = true
  if (scope.parent) {
    scope.parent.call.childParked = true
    scope.parent.scope.pendingRound = true
  } else if (!scope.session.stopped) {
    scope.session.stopped = { kind: 'park' }
  }
  scope.stop.abort(new RunParkedSignal())
  throw new RunParkedSignal()
}

/** The step's tool loop ended: if a call of its last round is pending, the run parks now. */
export const journalRoundEnd = (): void => {
  const scope = runContext.getStore()?.journal
  if (scope?.pendingRound) {
    parkScope(scope)
  }
}

// ── model calls ──────────────────────────────────────────────────────────────────────────────────

type Middleware = LanguageModelMiddleware
type CallParams = Parameters<NonNullable<Middleware['wrapGenerate']>>[0]['params']
type GenerateResult = Awaited<
  ReturnType<Parameters<NonNullable<Middleware['wrapGenerate']>>[0]['doGenerate']>
>
type StreamResult = Awaited<
  ReturnType<Parameters<NonNullable<Middleware['wrapStream']>>[0]['doStream']>
>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never

const zeroUsage = () => ({
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
})

// The provider's usage (V4: nested totals) as this package's IUsage.
const usageOf = (usage: unknown): IUsage => {
  const u = (usage ?? {}) as {
    inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number }
    outputTokens?: { total?: number; reasoning?: number }
  }
  return normalizeUsage({
    inputTokens: u.inputTokens?.total,
    outputTokens: u.outputTokens?.total,
    inputTokenDetails: {
      cacheReadTokens: u.inputTokens?.cacheRead,
      cacheWriteTokens: u.inputTokens?.cacheWrite,
    },
    outputTokenDetails: { reasoningTokens: u.outputTokens?.reasoning },
  })
}

interface IModelCallAt {
  base: string
  n: number
  position: string
  hash: string
  stage: ModelCallStage
  hit?: IJournalModelEntry
}

const beginModelCall = (
  scope: IJournalScope,
  stage: ModelCallStage,
  params: CallParams,
): IModelCallAt => {
  // The end of a tool round with a pending call: the next model call is not made.
  if (scope.pendingRound) {
    parkScope(scope)
  }
  const call = toolCallScope.getStore()
  const inside = call && call.scope === scope ? call : undefined
  const base = inside ? `${inside.position}.m` : `${scope.prefix}${scope.segment}.`
  const n = scope.counts.get(base) ?? 0
  const position = `${base}${n}`
  const hash = journalHash({
    prompt: params.prompt,
    tools: params.tools ?? null,
    toolChoice: params.toolChoice ?? null,
    responseFormat: params.responseFormat ?? null,
  })
  // A call made inside a tool call is looked up when that call's response was replayed; the
  // calls of the run itself until the run is live.
  const lookUp = inside ? inside.replay : !scope.live
  let hit: IJournalModelEntry | undefined
  if (lookUp) {
    const here = (scope.session.byPosition.get(position) ?? []).filter(
      (e): e is IJournalModelEntry => e.kind === 'model',
    )
    hit = findLast(here, (e) => e.stage === stage && e.hash === hash)
    if (!hit) {
      if (!inside) {
        scope.live = true
      }
      if (here.length) {
        diverge(scope, position, 'model', stage)
      }
    }
  }
  return { base, n, position, hash, stage, ...(hit ? { hit } : {}) }
}

const finishModelCall = (
  scope: IJournalScope,
  at: IModelCallAt,
  entry: IJournalModelEntry,
  toolCalls: readonly { toolCallId?: unknown }[],
  replay: boolean,
): void => {
  scope.counts.set(at.base, at.n + 1)
  toolCalls.forEach((tc, i) => {
    if (typeof tc.toolCallId !== 'string') {
      return
    }
    scope.calls.set(tc.toolCallId, {
      scope,
      toolCallId: tc.toolCallId,
      position: `${at.position}.t${i}`,
      parent: entry.id,
      replay,
      questions: 0,
      children: 0,
      childParked: false,
    })
  })
}

const modelEntry = (
  scope: IJournalScope,
  at: IModelCallAt,
  call: 'stream' | 'generate',
  response: IJournalModelEntry['response'],
  usage: IUsage,
): IJournalModelEntry => ({
  id: entryId(scope.session, 'model', at.position),
  kind: 'model',
  position: at.position,
  attempt: scope.session.attempt,
  at: Date.now(),
  stage: at.stage,
  hash: at.hash,
  call,
  response,
  usage,
})

const metaOf = (m: { id?: unknown; modelId?: unknown; timestamp?: unknown } | undefined) => {
  if (!m) {
    return undefined
  }
  const out: { id?: string; modelId?: string; timestamp?: string } = {}
  if (typeof m.id === 'string') {
    out.id = m.id
  }
  if (typeof m.modelId === 'string') {
    out.modelId = m.modelId
  }
  if (m.timestamp instanceof Date && !Number.isNaN(m.timestamp.getTime())) {
    out.timestamp = m.timestamp.toISOString()
  }
  return Object.keys(out).length ? out : undefined
}

const replayedMeta = (m: { id?: string; modelId?: string; timestamp?: string } | undefined) =>
  m
    ? {
        ...(m.id ? { id: m.id } : {}),
        ...(m.modelId ? { modelId: m.modelId } : {}),
        ...(m.timestamp ? { timestamp: new Date(m.timestamp) } : {}),
      }
    : undefined

// A replay: the recorded response, at no cost (its usage goes to the run's total only).
const replayed = (scope: IJournalScope, at: IModelCallAt, entry: IJournalModelEntry) => {
  accumulateUsage(scope.session.replayed, normalizeUsage(entry.usage))
  const parts = (entry.response.parts ?? []).map(decode) as Record<string, unknown>[]
  const content = (entry.response.content ?? []).map(decode) as Record<string, unknown>[]
  const toolCalls = (entry.call === 'stream' ? parts : content).filter(
    (p) => p.type === 'tool-call',
  )
  finishModelCall(scope, at, entry, toolCalls, true)
  return { parts, content }
}

/**
 * The journal's middleware for the language-model calls of `stage` (applied by `limitedModel`,
 * OUTSIDE the sharedLimits one, only while a run with a journal is in force). Replays a recorded
 * response; records a live one before its tool calls are let through.
 */
export const journalMiddleware = (stage: ModelCallStage): Middleware => ({
  wrapGenerate: async ({ doGenerate, params }) => {
    const scope = runContext.getStore()?.journal
    if (!scope) {
      return doGenerate()
    }
    const at = beginModelCall(scope, stage, params)
    if (at.hit) {
      const { content } = replayed(scope, at, at.hit)
      const meta = replayedMeta(at.hit.response.meta)
      return {
        content,
        finishReason: decode(at.hit.response.finishReason),
        usage: zeroUsage(),
        ...(at.hit.response.providerMetadata !== undefined
          ? { providerMetadata: decode(at.hit.response.providerMetadata) }
          : {}),
        ...(meta ? { response: meta } : {}),
        warnings: [],
      } as unknown as GenerateResult
    }
    const result = await doGenerate()
    const content = (result.content ?? []) as unknown as Record<string, unknown>[]
    const meta = metaOf(result.response)
    const entry = modelEntry(
      scope,
      at,
      'generate',
      {
        content: encode(content) as Record<string, unknown>[],
        finishReason: encode(result.finishReason),
        ...(result.providerMetadata !== undefined
          ? { providerMetadata: encode(result.providerMetadata) }
          : {}),
        ...(meta ? { meta } : {}),
      },
      usageOf(result.usage),
    )
    await appendEntry(scope.session, entry)
    finishModelCall(
      scope,
      at,
      entry,
      content.filter((p) => p.type === 'tool-call'),
      false,
    )
    return result
  },
  wrapStream: async ({ doStream, params }) => {
    const scope = runContext.getStore()?.journal
    if (!scope) {
      return doStream()
    }
    const at = beginModelCall(scope, stage, params)
    if (at.hit) {
      const { parts } = replayed(scope, at, at.hit)
      const meta = replayedMeta(at.hit.response.meta)
      const all = [
        { type: 'stream-start', warnings: [] },
        ...(meta ? [{ type: 'response-metadata', ...meta }] : []),
        ...parts,
        {
          type: 'finish',
          finishReason: decode(at.hit.response.finishReason),
          usage: zeroUsage(),
          ...(at.hit.response.providerMetadata !== undefined
            ? { providerMetadata: decode(at.hit.response.providerMetadata) }
            : {}),
        },
      ] as unknown as StreamPart[]
      return {
        stream: new ReadableStream<StreamPart>({
          start: (controller) => {
            for (const part of all) {
              controller.enqueue(part)
            }
            controller.close()
          },
        }),
      } as StreamResult
    }
    const result = await doStream()
    const parts: Record<string, unknown>[] = []
    const held: StreamPart[] = []
    let meta: ReturnType<typeof metaOf>
    let failed = false
    const record = (part: Record<string, unknown>): void => {
      const last = parts[parts.length - 1]
      // Consecutive deltas of one block are kept as one.
      if (
        (part.type === 'text-delta' || part.type === 'reasoning-delta') &&
        last?.type === part.type &&
        last.id === part.id &&
        last.providerMetadata === undefined &&
        part.providerMetadata === undefined
      ) {
        last.delta = `${String(last.delta ?? '')}${String(part.delta ?? '')}`
        return
      }
      parts.push(encode(part) as Record<string, unknown>)
    }
    const stream = result.stream.pipeThrough(
      new TransformStream<StreamPart, StreamPart>({
        transform: async (part, controller) => {
          const p = part as unknown as Record<string, unknown>
          switch (p.type) {
            case 'stream-start':
            case 'raw':
            case 'ping':
            case 'tool-input-start':
            case 'tool-input-delta':
            case 'tool-input-end':
              controller.enqueue(part)
              return
            case 'response-metadata':
              meta = metaOf(p)
              controller.enqueue(part)
              return
            case 'error':
              failed = true
              controller.enqueue(part)
              return
            case 'tool-call':
              // Held until the response is complete and on record.
              record(p)
              held.push(part)
              return
            case 'finish': {
              if (!failed) {
                const entry = modelEntry(
                  scope,
                  at,
                  'stream',
                  {
                    parts,
                    finishReason: encode(p.finishReason),
                    ...(p.providerMetadata !== undefined
                      ? { providerMetadata: encode(p.providerMetadata) }
                      : {}),
                    ...(meta ? { meta } : {}),
                  },
                  usageOf(p.usage),
                )
                try {
                  await appendEntry(scope.session, entry)
                } catch (err) {
                  controller.error(err)
                  return
                }
                finishModelCall(
                  scope,
                  at,
                  entry,
                  held as unknown as { toolCallId?: unknown }[],
                  false,
                )
              }
              for (const h of held.splice(0)) {
                controller.enqueue(h)
              }
              controller.enqueue(part)
              return
            }
            default:
              record(p)
              controller.enqueue(part)
          }
        },
        flush: (controller) => {
          for (const h of held.splice(0)) {
            controller.enqueue(h)
          }
        },
      }),
    )
    return { ...result, stream }
  },
})

// ── tool calls ───────────────────────────────────────────────────────────────────────────────────

/** A tool call the journal knows (its model response was seen in this run). */
export interface IJournalCall {
  ref: IJournalCallRef
  scope: IJournalScope
  name: string
  hash: string
  // replay: a recorded result; pending: a deferred call of an earlier attempt; live: run it.
  state: 'live' | 'replay' | 'pending'
  entry?: IJournalToolEntry | IJournalPendingEntry
}

/** The journal's view of one tool call, or undefined when it has none (no journal, no response). */
export const beginJournalToolCall = (
  name: string,
  input: unknown,
  toolCallId: unknown,
): IJournalCall | undefined => {
  const scope = runContext.getStore()?.journal
  if (!scope || typeof toolCallId !== 'string') {
    return undefined
  }
  const ref = scope.calls.get(toolCallId)
  if (!ref) {
    return undefined
  }
  scope.calls.delete(toolCallId)
  const hash = journalHash({ tool: name, input })
  const call: IJournalCall = { ref, scope, name, hash, state: 'live' }
  if (!ref.replay) {
    return call
  }
  const mine = (scope.session.byPosition.get(ref.position) ?? []).filter(
    (e): e is IJournalToolEntry | IJournalPendingEntry =>
      (e.kind === 'tool' || (e.kind === 'pending' && e.item.kind === 'tool')) &&
      e.parent === ref.parent,
  )
  const match = findLast(mine, (e) => e.hash === hash)
  if (match) {
    call.state = match.kind === 'tool' ? 'replay' : 'pending'
    call.entry = match
  } else if (mine.length) {
    diverge(scope, ref.position, 'tool')
  }
  return call
}

export interface IJournalToolHooks {
  // 'journaled': its result is recorded and replayed. 'builtin': a built-in of the agent (its
  // effects are on the run's own state: it runs again on a replay). 'rerun': a call that runs a
  // run inside it (a helper, an in-process subagent): it runs again, and THAT run replays.
  kind: 'journaled' | 'builtin' | 'rerun'
  // The call itself: the budget, the approval gate, the tiers' write guard, the tool.
  live: () => Promise<unknown>
  // Count a call that is answered without running against the run's tool-call budget.
  count: () => void
  // What the model is shown of a result (the tool's toModelOutput, with the output cap).
  modelOutput: (output: unknown) => Promise<unknown>
  // The input as a parked item shows it (after inputSanitizer).
  shown: () => Promise<unknown>
  // The tiers' write guard: a result handed back without running is a write that happened.
  wrote?: (output: unknown) => void
  // A result longer than this (as JSON) is kept only as the model saw it; 0 = always kept.
  keepChars: number
  signal?: AbortSignal
}

const valueOfModelOutput = (m: unknown): unknown => {
  if (!isObject(m)) {
    return m
  }
  switch (m.type) {
    case 'text':
    case 'json':
    case 'error-text':
    case 'error-json':
    case 'content':
      return m.value
    case 'execution-denied':
      return m.reason ?? 'denied'
    default:
      return m
  }
}

const toolEntry = (
  call: IJournalCall,
  fields: Pick<IJournalToolEntry, 'ok'> & Partial<IJournalToolEntry>,
): IJournalToolEntry => ({
  id: entryId(call.scope.session, 'tool', call.ref.position),
  kind: 'tool',
  position: call.ref.position,
  attempt: call.scope.session.attempt,
  at: Date.now(),
  parent: call.ref.parent,
  tool: call.name,
  hash: call.hash,
  ...fields,
})

const pendingOutput = (call: IJournalCall): unknown => {
  call.scope.outputs.set(call.ref.toolCallId, { ...PENDING_MODEL_OUTPUT })
  return PENDING
}

const replayedError = (rec: { name?: unknown; message?: unknown } | undefined): Error => {
  const message = typeof rec?.message === 'string' ? rec.message : 'tool call failed'
  const err = new Error(message)
  err.name = typeof rec?.name === 'string' ? rec.name : 'Error'
  ;(err as unknown as { toJSON: () => string }).toJSON = () => message
  return err
}

// An error worth recording as the call's result: the tool's own failure or a refusal the model
// read - not a stop, a park or a failure of the journal itself.
const worthRecording = (err: unknown, signal: AbortSignal | undefined): boolean => {
  if (signal?.aborted || isRunParked(err)) {
    return false
  }
  const name = (err as { name?: unknown } | null)?.name
  return name !== 'AbortError' && name !== 'JournalError' && name !== 'RunLeaseError'
}

const keptOutput = (output: unknown, model: unknown, keepChars: number): unknown => {
  let json: string | undefined
  try {
    json = JSON.stringify(output)
  } catch {
    return undefined
  }
  if (json === undefined || (keepChars > 0 && json.length > keepChars)) {
    return undefined
  }
  const copy = JSON.parse(json) as unknown
  return stableJson(copy) === stableJson(valueOfModelOutput(model)) ? undefined : copy
}

const recordResult = async (
  call: IJournalCall,
  output: unknown,
  hooks: IJournalToolHooks,
  answered: boolean,
): Promise<void> => {
  const model = await hooks.modelOutput(output)
  call.scope.outputs.set(call.ref.toolCallId, model)
  const kept = keptOutput(output, model, hooks.keepChars)
  await appendEntry(
    call.scope.session,
    toolEntry(call, {
      ok: true,
      model: jsonCopy(model),
      ...(kept !== undefined ? { output: kept } : {}),
      ...(answered ? { answered: true as const } : {}),
    }),
  )
}

const cleanJson = (v: unknown): unknown =>
  typeof v === 'string'
    ? v.replace(INVISIBLE, '')
    : Array.isArray(v)
      ? v.map(cleanJson)
      : isObject(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanJson(x)]))
        : v

// Where the call is made, for a parked item.
const whereOf = () => {
  const store = runContext.getStore()
  const spawn = store?.state?.spawn
  return {
    ...(store?.currentStep ? { step: store.currentStep } : {}),
    ...(spawn?.id ? { subagent: { id: spawn.id, depth: spawn.depth } } : {}),
  }
}

const deferCall = async (
  call: IJournalCall,
  note: string | undefined,
  hooks: IJournalToolHooks,
) => {
  const s = call.scope.session
  const item: ParkedItem = {
    id: itemIdOf(s, call.ref.position, call.ref.parent, call.hash),
    kind: 'tool',
    toolName: call.name,
    input: jsonCopy(await hooks.shown()) ?? null,
    ...(note ? { note } : {}),
    ...(jsonCopy(whereOf()) as object),
  }
  const entry: IJournalPendingEntry = {
    id: entryId(s, 'pending', call.ref.position),
    kind: 'pending',
    position: call.ref.position,
    attempt: s.attempt,
    at: Date.now(),
    parent: call.ref.parent,
    hash: call.hash,
    item,
  }
  await appendEntry(s, entry)
  holdItem(call.scope, item)
}

// A call deferred on an earlier attempt: answered from `answers`, or pending again.
const answerDeferred = async (call: IJournalCall, hooks: IJournalToolHooks): Promise<unknown> => {
  const s = call.scope.session
  const item = (call.entry as IJournalPendingEntry).item
  const answer = s.answers.get(item.id) as ToolResultAnswer | undefined
  if (!answer) {
    holdItem(call.scope, item)
    return pendingOutput(call)
  }
  s.used.add(item.id)
  if ('error' in answer) {
    const message = cleanText(String(answer.error), JOURNAL_LIMITS.errorChars)
    await appendEntry(
      s,
      toolEntry(call, { ok: false, error: { name: 'ToolResultError', message }, answered: true }),
    )
    throw new ToolResultError(message)
  }
  // Untrusted: cleaned, then the host's outputSanitizer, then the tool's output cap - what any
  // tool result goes through.
  let output = cleanJson(answer.output)
  if (s.outputSanitizer) {
    try {
      output = await s.outputSanitizer(call.name, output)
    } catch {
      output = '[output redacted: sanitizer failed]'
    }
  }
  await recordResult(call, output, hooks, true)
  hooks.wrote?.(output)
  return output
}

/**
 * Run one tool call under the journal: a recorded result is handed back, a deferred call of an
 * earlier attempt is answered (or pending again), anything else runs - inside the call's scope,
 * so a question it asks and a run it starts know where they are - and its result is recorded.
 */
export const runJournaledToolCall = (call: IJournalCall, hooks: IJournalToolHooks) =>
  toolCallScope.run(call.ref, async (): Promise<unknown> => {
    if (hooks.kind === 'journaled' && call.state !== 'live') {
      hooks.count()
      if (call.state === 'pending') {
        return answerDeferred(call, hooks)
      }
      const e = call.entry as IJournalToolEntry
      if (!e.ok) {
        throw replayedError(e.error)
      }
      if (e.model !== undefined) {
        call.scope.outputs.set(call.ref.toolCallId, e.model)
      }
      const out = 'output' in e ? e.output : valueOfModelOutput(e.model)
      hooks.wrote?.(out)
      return out
    }
    let output: unknown
    try {
      output = await hooks.live()
    } catch (err) {
      if (isRunParked(err) || call.ref.childParked) {
        return pendingOutput(call)
      }
      if (hooks.kind === 'journaled' && worthRecording(err, hooks.signal)) {
        await appendEntry(
          call.scope.session,
          toolEntry(call, {
            ok: false,
            error: {
              name: String((err as { name?: unknown } | null)?.name ?? 'Error'),
              message: messageOf(err),
            },
          }),
        )
      }
      throw err
    }
    if (call.ref.childParked) {
      return pendingOutput(call)
    }
    if (isDeferredResult(output)) {
      if (hooks.kind !== 'journaled') {
        throw new DeferRefusedError(call.name)
      }
      await deferCall(call, output.note, hooks)
      return pendingOutput(call)
    }
    if (hooks.kind === 'journaled') {
      await recordResult(call, output, hooks, false)
    }
    return output
  })

/** What the model is shown of a result the journal handed back (the tool's toModelOutput asks). */
export const journalModelOutput = (toolCallId: unknown): unknown => {
  const scope = runContext.getStore()?.journal
  if (!scope || typeof toolCallId !== 'string') {
    return undefined
  }
  const out = scope.outputs.get(toolCallId)
  if (out !== undefined) {
    scope.outputs.delete(toolCallId)
  }
  return out
}

/** A tool returned `deferResult()` where its result cannot come later (no journal). */
export class DeferRefusedError extends Error {
  constructor(name: string) {
    super(
      `${name} returned deferResult(), but its result cannot come later here: that needs config.persistence.journal and a tool call the run's model asked for. The call failed instead.`,
    )
    this.name = 'DeferRefusedError'
  }

  toJSON(): string {
    return this.message
  }
}

const RERUN = Symbol.for('@dudko.dev/agent:journal-rerun')

/** Mark a tool that runs a run inside it: on a replay it runs again, and its run replays. */
export const markJournalRerun = <T extends object>(tool: T): T => {
  Object.defineProperty(tool, RERUN, { value: true, enumerable: false, configurable: true })
  return tool
}

export const isJournalRerun = (tool: unknown): boolean =>
  Boolean(tool) && typeof tool === 'object' && (tool as Record<symbol, unknown>)[RERUN] === true

// ── questions of the approval gate ───────────────────────────────────────────────────────────────

/** A question the journal knows: its stable id, and what is on record or given for it. */
export interface IJournalQuestion {
  id: string
  // Answered on an earlier attempt: on record.
  recorded?: ToolApprovalAnswer
  // In `answers`.
  given?: ToolApprovalAnswer
  // Parked on an earlier attempt and not answered: parks again, nobody is asked.
  pending: boolean
  record: (answer: { approved: boolean; reason?: string; remember?: boolean }) => Promise<void>
  park: (request: IToolApprovalRequest) => Promise<void>
}

/**
 * The journal's view of a question of the approval gate - or why it cannot park: there is no
 * journal, or the question is not asked from a tool call of the run (an MCP skill the planner
 * picked, a resumed run's active skills).
 */
export const journalQuestion = (what: {
  kind: 'tool' | 'skill'
  toolName: string
  input: unknown
  skill?: unknown
}): IJournalQuestion | { refusal: string } => {
  const scope = runContext.getStore()?.journal
  if (!scope) {
    return { refusal: 'parking a run needs config.persistence.journal' }
  }
  const ref = toolCallScope.getStore()
  if (!ref || ref.scope !== scope) {
    return {
      refusal: 'the question is not asked from a tool call of the run, so it cannot wait',
    }
  }
  const s = scope.session
  const position = `${ref.position}.q${ref.questions++}`
  const hash = journalHash({
    kind: what.kind,
    tool: what.toolName,
    input: what.input,
    ...(what.skill !== undefined ? { skill: what.skill } : {}),
  })
  const id = itemIdOf(s, position, ref.parent, hash)
  const mine = (s.byPosition.get(position) ?? []).filter(
    (e): e is IJournalAnswerEntry | IJournalPendingEntry =>
      (e.kind === 'answer' || e.kind === 'pending') && e.parent === ref.parent && e.hash === hash,
  )
  const last = mine[mine.length - 1]
  const given = s.answers.get(id) as ToolApprovalAnswer | undefined
  const base = {
    position,
    attempt: s.attempt,
    parent: ref.parent,
    hash,
  }
  return {
    id,
    ...(last?.kind === 'answer' ? { recorded: last.answer } : {}),
    ...(given !== undefined ? { given } : {}),
    pending: last?.kind === 'pending' || s.pendingIds.has(id),
    record: async (answer) => {
      if (given !== undefined) {
        s.used.add(id)
      }
      await appendEntry(s, {
        ...base,
        id: entryId(s, 'answer', position),
        kind: 'answer',
        at: Date.now(),
        itemId: id,
        answer: {
          approved: answer.approved,
          ...(typeof answer.reason === 'string' ? { reason: answer.reason } : {}),
          ...(answer.remember ? { remember: true } : {}),
        },
      })
    },
    park: async (request) => {
      if (last?.kind === 'pending') {
        holdItem(scope, last.item)
        return
      }
      const item: ParkedItem = {
        id,
        kind: 'approval',
        request: (jsonCopy(request) ?? { ...request, input: null }) as IToolApprovalRequest,
      }
      await appendEntry(s, {
        ...base,
        id: entryId(s, 'pending', position),
        kind: 'pending',
        at: Date.now(),
        item,
      })
      holdItem(scope, item)
    },
  }
}

export const isParkDecision = (d: unknown): d is { park: true } => isObject(d) && d.park === true
