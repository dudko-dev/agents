// The session workflow's logic as plain functions over plain data: no Temporal, no clock, no
// randomness (the workflow passes `now`). `workflows.ts` only wires these to signals, a query, a
// timer and the activities, so what a session does can be tested without a server.
import type { IConversationTurn } from '@dudko.dev/agent'
import type {
  IAnswer,
  IParkedRequest,
  ISessionOptions,
  ISessionView,
  IStopRequest,
  ITurnEnd,
  ITurnInput,
  ITurnRecord,
  IUserMessage,
  TurnResult,
} from './session-types.ts'

// The turn records the state keeps (and the query shows).
export const TURNS_KEPT = 20
// Message ids remembered to drop a repeated POST.
export const SEEN_KEPT = 500
// Answers kept while nothing asks for them (a client answering a request that is not open).
export const ANSWERS_KEPT = 100

export interface IParked {
  turn: number
  runId: string
  requests: IParkedRequest[]
  input: string
  messageIds: string[]
  startedAt: number
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
  turnsThisRun: 0,
})

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

// An answer to a question. Kept even when no turn asks it (yet): the client may be faster than the
// workflow; bounded so that answers nobody asked for cannot grow the state.
export const acceptAnswer = (state: ISessionState, answer: IAnswer): void => {
  state.answers[answer.requestId] = answer
  const open = new Set(state.parked?.requests.map((r) => r.requestId) ?? [])
  const stray = Object.keys(state.answers).filter((id) => !open.has(id))
  for (const id of stray.slice(0, Math.max(0, stray.length - ANSWERS_KEPT))) {
    delete state.answers[id]
  }
}

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
  (state.endings.length > 0 || (!state.parked && state.inbox.length > 0) || parkedReady(state))

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
  return { sessionId: state.sessionId, turn, input, history: [...state.history], messageIds }
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
  history: state.history,
  turns: state.turns,
})
