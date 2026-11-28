// The session workflow's logic as plain functions over plain data: no Temporal, no clock, no
// randomness (the workflow passes `now`). `workflows.ts` only wires these to signals, a query, a
// timer and the activities, so what a session does can be tested without a server.
import type { IConversationTurn } from '@dudko.dev/agent'
import { answerProblem } from './answers.ts'
import { subagentStreamOf, subagentWorkflowIdOf } from './session-api.ts'
import type {
  IAnswer,
  IParkedRequest,
  ISessionOptions,
  ISessionView,
  IStopRequest,
  IStreamMarker,
  ISubagentInput,
  ITurnEnd,
  ITurnInput,
  ITurnRecord,
  IUserMessage,
  SubagentOutcome,
  TurnResult,
} from './session-types.ts'

// The turn records the state keeps (and the query shows).
export const TURNS_KEPT = 20
// Message ids remembered to drop a repeated POST.
export const SEEN_KEPT = 500
// Answers kept while nothing asks for them (a client answering a request that is not open).
export const ANSWERS_KEPT = 100

// Static subagents: the caps a session started without them gets (ISessionOptions).
export const SUBAGENT_DEFAULTS = { maxPerRound: 4, maxPerSession: 50 } as const

// Where the subagent markers go in a turn's order: the parked attempt's slot, from this seq on -
// far above any seq the attempt's own events reach. `subagent.started` takes SEQ + i (the i-th
// child of the park), `subagent.ended` SEQ + SPAN + j (the j-th to end, in the order the workflow
// saw them end). The workflow writes them in that order, one after the other, so a reader that
// follows the stream never sees a marker land behind its cursor.
export const SUBAGENT_MARKER_SEQ = 1_073_741_824
export const SUBAGENT_MARKER_SPAN = 1_048_576

export interface IParked {
  turn: number
  runId: string
  requests: IParkedRequest[]
  input: string
  messageIds: string[]
  startedAt: number
  // The parked attempt's slot in the turn's order (the subagent markers go there).
  turnAttempt?: number
  // The requests a child workflow was started for, in start order; and how many have ended.
  children?: string[]
  ended?: number
}

export interface ISessionState {
  sessionId: string
  options: ISessionOptions
  turn: number
  inbox: IUserMessage[]
  seen: string[]
  dropped: number
  history: IConversationTurn[]
  turns: ITurnRecord[]
  running?: { turn: number; messageIds: string[]; startedAt: number; input: string }
  // A stop arrived while the turn ran: the turn is being cancelled.
  stopping: boolean
  // The session ends once nothing runs.
  ending: boolean
  parked?: IParked
  answers: Record<string, IAnswer>
  // turn.ended markers not written yet (the workflow drains them through an activity).
  endings: ITurnEnd[]
  // Subagent markers not written yet (drained the same way, in order).
  markers: IStreamMarker[]
  // Static subagent calls started in this session (subagentMaxPerSession).
  subagentsStarted: number
  // Turns run by this workflow run (continue-as-new resets it).
  turnsThisRun: number
}

// What continue-as-new carries into the next run: the whole state but the per-run counter.
export type ISessionCarry = Omit<ISessionState, 'turnsThisRun' | 'options' | 'sessionId'>

// How a turn came out, as the workflow sees it: the activity's result, or a failure Temporal gave
// up on (or a cancellation the user asked for).
export type TurnOutcome = TurnResult | { status: 'failed'; error: string }

export const initialState = (
  sessionId: string,
  options: ISessionOptions,
  carry?: ISessionCarry,
): ISessionState => ({
  sessionId,
  options,
  turn: carry?.turn ?? 0,
  inbox: [...(carry?.inbox ?? [])],
  seen: [...(carry?.seen ?? [])],
  dropped: carry?.dropped ?? 0,
  history: [...(carry?.history ?? [])],
  turns: [...(carry?.turns ?? [])],
  ...(carry?.running ? { running: carry.running } : {}),
  stopping: carry?.stopping ?? false,
  ending: carry?.ending ?? false,
  ...(carry?.parked ? { parked: carry.parked } : {}),
  answers: { ...(carry?.answers ?? {}) },
  endings: [...(carry?.endings ?? [])],
  markers: [...(carry?.markers ?? [])],
  subagentsStarted: carry?.subagentsStarted ?? 0,
  turnsThisRun: 0,
})

const maxPerRound = (o: ISessionOptions): number =>
  o.subagentMaxPerRound ?? SUBAGENT_DEFAULTS.maxPerRound
const maxPerSession = (o: ISessionOptions): number =>
  o.subagentMaxPerSession ?? SUBAGENT_DEFAULTS.maxPerSession

export type AcceptResult = 'queued' | 'duplicate' | 'full' | 'ended'

// A message from the user: queued behind the running turn, or dropped as a repeat / overflow.
export const acceptMessage = (state: ISessionState, message: IUserMessage): AcceptResult => {
  if (state.ending) {
    return 'ended'
  }
  if (state.seen.includes(message.id)) {
    return 'duplicate'
  }
  if (state.inbox.length >= state.options.maxQueuedMessages) {
    state.dropped += 1
    return 'full'
  }
  state.seen.push(message.id)
  if (state.seen.length > SEEN_KEPT) {
    state.seen.splice(0, state.seen.length - SEEN_KEPT)
  }
  state.inbox.push(message)
  return 'queued'
}

const boundStray = (state: ISessionState): void => {
  const open = new Set(state.parked?.requests.map((r) => r.requestId) ?? [])
  const stray = Object.keys(state.answers).filter((id) => !open.has(id))
  for (const id of stray.slice(0, Math.max(0, stray.length - ANSWERS_KEPT))) {
    delete state.answers[id]
  }
}

// Why the parked turn cannot take this answer for this request (undefined: it can).
const refusalOf = (request: IParkedRequest, answer: IAnswer): string | undefined => {
  if (request.subagent && answer.by !== 'subagent') {
    return 'a subagent answers this item'
  }
  return answerProblem(request.kind, answer.value)
}

export type AnswerVerdict = 'accepted' | 'early' | 'refused'

// A client's answer. While a turn is parked it must name one of its requests and fit its kind
// (the gateway checked both already; this is the authority); an item a subagent answers is
// refused. While no turn is parked it is kept: the client may be faster than the workflow (it is
// checked when the park arrives), and bounded, so that answers nobody asked for cannot grow the
// state.
export const acceptAnswer = (state: ISessionState, answer: IAnswer): AnswerVerdict => {
  if (state.parked) {
    const request = state.parked.requests.find((r) => r.requestId === answer.requestId)
    if (!request || refusalOf(request, answer)) {
      return 'refused'
    }
    state.answers[answer.requestId] = answer
    return 'accepted'
  }
  if (answer.by === 'subagent') {
    return 'refused'
  }
  state.answers[answer.requestId] = answer
  boundStray(state)
  return 'early'
}

// The answer a child's outcome gives its item.
export const childAnswerOf = (outcome: SubagentOutcome): unknown =>
  outcome.status === 'completed'
    ? { output: outcome.text }
    : outcome.status === 'stopped'
      ? { error: 'the subagent was stopped before it answered' }
      : { error: `the subagent failed: ${outcome.error}` }

// The children a parked turn needs: one per request a static subagent answers that has no answer
// and no child yet - within the caps, per round and per session; a call beyond them is answered
// at once with an error the model reads (it never starts a child). Marks the rest started, counts
// them and queues their `subagent.started` markers. Returns what the workflow starts.
export interface IChildStart {
  requestId: string
  workflowId: string
  input: ISubagentInput
}

export const startChildren = (state: ISessionState, now: number): IChildStart[] => {
  const parked = state.parked
  if (!parked) {
    return []
  }
  const children = (parked.children ??= [])
  const o = state.options
  const out: IChildStart[] = []
  for (const r of parked.requests) {
    if (!r.subagent || state.answers[r.requestId] || children.includes(r.requestId)) {
      continue
    }
    const refuse = (why: string): void => {
      state.answers[r.requestId] = {
        requestId: r.requestId,
        value: { error: `subagent "${r.subagent!.name}" refused: ${why}` },
        at: now,
        by: 'subagent',
      }
    }
    if (out.length >= maxPerRound(o)) {
      refuse(`at most ${maxPerRound(o)} subagent calls in one round`)
      continue
    }
    if (state.subagentsStarted >= maxPerSession(o)) {
      refuse(`at most ${maxPerSession(o)} subagent calls in one session`)
      continue
    }
    state.subagentsStarted += 1
    children.push(r.requestId)
    const workflowId = subagentWorkflowIdOf(state.sessionId, parked.runId, r.requestId)
    const stream = subagentStreamOf(state.sessionId, r.requestId)
    out.push({
      requestId: r.requestId,
      workflowId,
      input: {
        sessionId: state.sessionId,
        turn: parked.turn,
        parentRunId: parked.runId,
        itemId: r.requestId,
        stream,
        name: r.subagent.name,
        task: r.subagent.task,
        ...(r.subagent.profile ? { profile: r.subagent.profile } : {}),
        options: {
          turnTimeoutMs: o.turnTimeoutMs,
          heartbeatTimeoutMs: o.heartbeatTimeoutMs,
          maxTurnAttempts: o.maxTurnAttempts,
        },
      },
    })
    if (parked.turnAttempt !== undefined) {
      state.markers.push({
        sessionId: state.sessionId,
        turn: parked.turn,
        turnAttempt: parked.turnAttempt,
        seq: SUBAGENT_MARKER_SEQ + children.length - 1,
        type: 'subagent.started',
        body: {
          itemId: r.requestId,
          name: r.subagent.name,
          task: r.subagent.task,
          ...(r.subagent.profile ? { profile: r.subagent.profile } : {}),
          workflowId,
          events: `/sessions/${state.sessionId}/subagents/${r.requestId}/events`,
        },
      })
    }
  }
  return out
}

// A child is over: its outcome answers its item, and its `subagent.ended` marker is queued. A child
// of a park that is over (stopped) or one whose item is answered already changes nothing.
export const childFinished = (
  state: ISessionState,
  requestId: string,
  outcome: SubagentOutcome,
  now: number,
): boolean => {
  const parked = state.parked
  const request = parked?.requests.find((r) => r.requestId === requestId)
  if (!parked || !request?.subagent || !parked.children?.includes(requestId)) {
    return false
  }
  if (state.answers[requestId]) {
    return false
  }
  state.answers[requestId] = { requestId, value: childAnswerOf(outcome), at: now, by: 'subagent' }
  const n = parked.ended ?? 0
  parked.ended = n + 1
  if (parked.turnAttempt !== undefined) {
    state.markers.push({
      sessionId: state.sessionId,
      turn: parked.turn,
      turnAttempt: parked.turnAttempt,
      seq: SUBAGENT_MARKER_SEQ + SUBAGENT_MARKER_SPAN + n,
      type: 'subagent.ended',
      body: {
        itemId: requestId,
        name: request.subagent.name,
        status: outcome.status,
        ...(outcome.status === 'completed' ? { text: outcome.text, usage: outcome.usage } : {}),
        ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
        ...(outcome.status !== 'failed' && outcome.runId ? { runId: outcome.runId } : {}),
        ...(outcome.status !== 'failed' && outcome.attempt ? { attempt: outcome.attempt } : {}),
      },
    })
  }
  return true
}

// Children of the parked turn still running (continue-as-new waits for them: a new run of the
// workflow could not await them).
export const childrenRunning = (state: ISessionState): boolean =>
  Boolean(state.parked?.children?.some((id) => !state.answers[id]))

// Stop: the running turn is cancelled, the messages queued behind it are dropped (they were
// written before the user said stop), a parked turn ends as stopped. `end` ends the session.
export const acceptStop = (state: ISessionState, stop: IStopRequest, now: number): void => {
  state.inbox = []
  if (stop.end) {
    state.ending = true
  }
  if (state.running) {
    state.stopping = true
  }
  if (state.parked) {
    const parked = state.parked
    delete state.parked
    recordTurn(state, {
      turn: parked.turn,
      status: 'stopped',
      messageIds: parked.messageIds,
      startedAt: parked.startedAt,
      endedAt: now,
      runId: parked.runId,
    })
    state.endings.push({
      sessionId: state.sessionId,
      turn: parked.turn,
      status: 'stopped',
      runId: parked.runId,
    })
  }
}

// A parked turn may go on once every request it asked has an answer.
export const parkedReady = (state: ISessionState): boolean =>
  Boolean(state.parked && state.parked.requests.every((r) => state.answers[r.requestId]))

// Something for the loop to do: a turn to start or to go on with, or markers to write.
export const hasWork = (state: ISessionState): boolean =>
  !state.running &&
  (state.endings.length > 0 ||
    state.markers.length > 0 ||
    (!state.parked && state.inbox.length > 0) ||
    parkedReady(state))

// What the turn's next round may start: the per-round cap and what is left of the session's.
const subagentBudget = (state: ISessionState): ITurnInput['subagents'] => ({
  maxPerRound: maxPerRound(state.options),
  remaining: Math.max(0, maxPerSession(state.options) - state.subagentsStarted),
})

// Several messages queued behind a turn become one turn: the model reads them in order.
export const joinMessages = (messages: IUserMessage[]): string =>
  messages.map((m) => m.text).join('\n\n')

// The next turn's input: a parked turn with its answers, else the queued messages. Marks it running.
export const takeTurn = (state: ISessionState, now: number): ITurnInput | undefined => {
  if (state.running) {
    return undefined
  }
  if (state.parked && parkedReady(state)) {
    const parked = state.parked
    delete state.parked
    const answers: Record<string, IAnswer> = {}
    for (const r of parked.requests) {
      answers[r.requestId] = state.answers[r.requestId] as IAnswer
      delete state.answers[r.requestId]
    }
    state.running = {
      turn: parked.turn,
      messageIds: parked.messageIds,
      startedAt: parked.startedAt,
      input: parked.input,
    }
    state.stopping = false
    return {
      sessionId: state.sessionId,
      turn: parked.turn,
      input: parked.input,
      history: [...state.history],
      messageIds: parked.messageIds,
      answers,
      subagents: subagentBudget(state),
    }
  }
  if (state.parked || state.inbox.length === 0) {
    return undefined
  }
  const batch = state.inbox.splice(0)
  const turn = state.turn + 1
  state.turn = turn
  const input = joinMessages(batch)
  const messageIds = batch.map((m) => m.id)
  state.running = { turn, messageIds, startedAt: now, input }
  state.stopping = false
  return {
    sessionId: state.sessionId,
    turn,
    input,
    history: [...state.history],
    messageIds,
    subagents: subagentBudget(state),
  }
}

const recordTurn = (state: ISessionState, record: ITurnRecord): void => {
  const i = state.turns.findIndex((t) => t.turn === record.turn)
  if (i >= 0) {
    state.turns[i] = record
  } else {
    state.turns.push(record)
  }
  if (state.turns.length > TURNS_KEPT) {
    state.turns.splice(0, state.turns.length - TURNS_KEPT)
  }
}

const historyChars = (history: IConversationTurn[]): number =>
  history.reduce((n, t) => n + t.content.length, 0)

// Keep the conversation under `maxChars`, dropping the oldest turns first (a user turn with the
// answer after it, so the history never starts with an orphan answer). The last exchange always
// stays, however long: a cap must not erase what was just said.
export const capHistory = (history: IConversationTurn[], maxChars: number): IConversationTurn[] => {
  const out = [...history]
  while (out.length > 2 && historyChars(out) > maxChars) {
    out.shift()
    while (out.length > 2 && out[0]?.role === 'assistant') {
      out.shift()
    }
  }
  return out
}

// A turn is over (or parked): the history, the record and the marker to write.
export const finishTurn = (
  state: ISessionState,
  input: ITurnInput,
  outcome: TurnOutcome,
  now: number,
): void => {
  const running = state.running
  delete state.running
  state.stopping = false
  state.turnsThisRun += 1
  const startedAt = running?.startedAt ?? now
  if (outcome.status === 'parked') {
    state.parked = {
      turn: input.turn,
      runId: outcome.runId,
      requests: outcome.requests,
      input: input.input,
      messageIds: input.messageIds,
      startedAt,
      ...(outcome.turnAttempt !== undefined ? { turnAttempt: outcome.turnAttempt } : {}),
      children: [],
      ended: 0,
    }
    // Answers that came before the park: kept only where they fit their request.
    for (const r of outcome.requests) {
      const early = state.answers[r.requestId]
      if (early && refusalOf(r, early)) {
        delete state.answers[r.requestId]
      }
    }
    recordTurn(state, {
      turn: input.turn,
      status: 'parked',
      messageIds: input.messageIds,
      startedAt,
      runId: outcome.runId,
      attempt: outcome.attempt,
    })
    return
  }
  if (outcome.status === 'completed') {
    const base = outcome.compactedHistory ?? state.history
    state.history = capHistory(
      [
        ...base,
        { role: 'user', content: input.input },
        { role: 'assistant', content: outcome.text },
      ],
      state.options.historyMaxChars,
    )
  }
  const record: ITurnRecord = {
    turn: input.turn,
    status: outcome.status,
    messageIds: input.messageIds,
    startedAt,
    endedAt: now,
    ...(outcome.status !== 'failed' && outcome.runId ? { runId: outcome.runId } : {}),
    ...(outcome.status !== 'failed' && outcome.attempt ? { attempt: outcome.attempt } : {}),
    ...(outcome.status === 'completed' ? { text: outcome.text } : {}),
    ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
    ...(outcome.status !== 'failed' && outcome.usage ? { usage: outcome.usage } : {}),
  }
  recordTurn(state, record)
  state.endings.push({
    sessionId: state.sessionId,
    turn: input.turn,
    status: record.status as ITurnEnd['status'],
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.attempt ? { attempt: record.attempt } : {}),
    ...(record.text !== undefined ? { text: record.text } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.usage ? { usage: record.usage } : {}),
  })
}

// Continue-as-new at a quiet point (nothing running, every marker written), when Temporal
// suggests it (the history is large) or after maxTurnsPerRun turns.
export const shouldContinueAsNew = (state: ISessionState, suggested: boolean): boolean =>
  !state.running &&
  state.endings.length === 0 &&
  state.markers.length === 0 &&
  !childrenRunning(state) &&
  (suggested || state.turnsThisRun >= state.options.maxTurnsPerRun)

export const carry = (state: ISessionState): ISessionCarry => {
  const { turnsThisRun: _n, options: _o, sessionId: _s, ...rest } = state
  void [_n, _o, _s]
  return rest
}

export const view = (state: ISessionState, ended = false): ISessionView => ({
  sessionId: state.sessionId,
  status: ended
    ? 'ended'
    : state.running
      ? state.stopping
        ? 'stopping'
        : 'running'
      : state.parked
        ? 'parked'
        : 'idle',
  turn: state.turn,
  ...(state.running
    ? {
        running: {
          turn: state.running.turn,
          messageIds: state.running.messageIds,
          startedAt: state.running.startedAt,
        },
      }
    : {}),
  queued: state.inbox.map((m) => ({ id: m.id, at: m.at })),
  dropped: state.dropped,
  ...(state.parked
    ? {
        parked: {
          turn: state.parked.turn,
          runId: state.parked.runId,
          requests: state.parked.requests,
          answered: state.parked.requests
            .map((r) => r.requestId)
            .filter((id) => state.answers[id] !== undefined),
        },
      }
    : {}),
  ...(state.subagentsStarted ? { subagentsStarted: state.subagentsStarted } : {}),
  history: state.history,
  turns: state.turns,
})
