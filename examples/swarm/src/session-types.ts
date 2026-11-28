// The shapes the gateway, the session workflow and the turn activity share. Types only: the
// workflow bundle imports this file, so nothing here may touch Node.
import type { IConversationTurn, IUsage } from '@dudko.dev/agent'

// A message the user sent. `id` makes a retried POST harmless (the workflow drops a repeat);
// `at` is the gateway's clock, for display only.
export interface IUserMessage {
  id: string
  text: string
  at: number
}

// The answer to an item a parked turn waits for (see "Parking" in the README): a person's decision
// (an 'approval' item) or a tool's result from outside (a 'tool' item) - checked by answers.ts.
// A static subagent's child workflow answers its own item the same way (`by: 'subagent'`).
export interface IAnswer {
  requestId: string
  value: unknown
  at: number
  by?: 'client' | 'subagent'
}

// Stop the turn that is running (and drop the messages queued behind it). `end` also ends the
// session once nothing runs.
export interface IStopRequest {
  end?: boolean
  at: number
}

// Fixed when the session starts (the gateway reads them from its env), so a running workflow
// never depends on a worker's env: replays stay deterministic.
export interface ISessionOptions {
  // No message for this long ends the session (0: never).
  idleTimeoutMs: number
  // One turn, from first attempt to last (Temporal's startToCloseTimeout of one attempt).
  turnTimeoutMs: number
  // A worker that has not heartbeat for this long has lost the turn; Temporal retries it elsewhere.
  heartbeatTimeoutMs: number
  // Attempts of one turn before it counts as failed.
  maxTurnAttempts: number
  // Turns in one workflow run before continue-as-new (Temporal's own suggestion also triggers it).
  maxTurnsPerRun: number
  // The conversation the workflow carries, in characters; the oldest exchanges go first.
  historyMaxChars: number
  // Messages that may wait behind a running turn; more are dropped (and counted).
  maxQueuedMessages: number
  // Static subagents (child workflows): calls in one round of a turn, and in the whole session.
  // Optional: a session started before they existed has neither and gets the defaults
  // (SUBAGENT_DEFAULTS in session-state.ts).
  subagentMaxPerRound?: number
  subagentMaxPerSession?: number
}

// What one turn is given. `answers`: a parked turn goes on with the answers to every item it waits
// for (the activity resumes its run with them). `subagents`: how many static subagent calls the
// turn's next round may make (the caps, minus what the session has started already).
export interface ITurnInput {
  sessionId: string
  turn: number
  input: string
  history: IConversationTurn[]
  messageIds: string[]
  answers?: Record<string, IAnswer>
  subagents?: { maxPerRound: number; remaining: number }
}

// An item a parked turn waits for. `requestId` is the core's stable item id.
export interface IParkedRequest {
  requestId: string
  // 'approval': a person's decision on a tool call; 'tool': a tool's result from outside.
  kind: 'approval' | 'tool'
  // What there is to answer: the approval request (the tool and its input, the step), or the
  // deferred call (the tool, its input, its note). The core's item without `id` and `kind`.
  question: unknown
  // Set when a static subagent answers it: the workflow runs it as a child workflow.
  subagent?: ISubagentCall
}

// A call of a static subagent (SUBAGENTS), as the parent model made it.
export interface ISubagentCall {
  name: string
  task: string
  profile?: string
}

// What a child workflow `subagent` is given: one agent.run of the profile `name` on `task`.
// `stream` keys its run and its events in Postgres (its own stream, not the parent turn's).
export interface ISubagentInput {
  sessionId: string
  turn: number
  parentRunId: string
  itemId: string
  stream: string
  name: string
  task: string
  profile?: string
  options: Pick<ISessionOptions, 'turnTimeoutMs' | 'heartbeatTimeoutMs' | 'maxTurnAttempts'>
}

// How a child came out; the parent turns it into the item's answer ({ output } or { error }).
export type SubagentOutcome =
  | { status: 'completed'; runId: string; attempt: number; text: string; usage: IUsage }
  | { status: 'stopped'; runId?: string; attempt?: number; usage?: IUsage }
  | { status: 'failed'; error: string }

// How a turn ended, as the activity reports it. A failure is not a value: the activity throws
// (retryable or not) and the workflow records `failed` once Temporal gives up.
export type TurnResult =
  | {
      status: 'completed'
      runId: string
      attempt: number
      text: string
      usage: IUsage
      // The history the run was given, compacted by it; replaces the workflow's copy.
      compactedHistory?: IConversationTurn[]
    }
  | { status: 'stopped'; runId?: string; attempt?: number; usage?: IUsage }
  // The run parked: it waits for every request's answer, then goes on as the same turn and the
  // same run. `turnAttempt` is the slot of the parked attempt in the turn's order (the subagent
  // markers go there, after the attempt's own events).
  | {
      status: 'parked'
      runId: string
      attempt: number
      turnAttempt?: number
      requests: IParkedRequest[]
    }

export type TurnStatus = 'completed' | 'stopped' | 'failed' | 'parked'

// One turn in the session's record (the state query shows the last few).
export interface ITurnRecord {
  turn: number
  status: TurnStatus
  messageIds: string[]
  startedAt: number
  endedAt?: number
  runId?: string
  attempt?: number
  text?: string
  error?: string
  usage?: IUsage
}

// What the workflow tells the event stream when a turn is over (`turn.ended`).
export interface ITurnEnd {
  sessionId: string
  turn: number
  status: Exclude<TurnStatus, 'parked'>
  runId?: string
  attempt?: number
  text?: string
  error?: string
  usage?: IUsage
}

export type SessionStatus = 'idle' | 'running' | 'stopping' | 'parked' | 'ended'

// The state query's answer.
export interface ISessionView {
  sessionId: string
  status: SessionStatus
  // Turns started so far (the running or last one's number).
  turn: number
  running?: { turn: number; messageIds: string[]; startedAt: number }
  queued: { id: string; at: number }[]
  // Messages dropped because the queue was full.
  dropped: number
  parked?: { turn: number; runId: string; requests: IParkedRequest[]; answered: string[] }
  // Static subagent calls started in this session (counted against subagentMaxPerSession).
  subagentsStarted?: number
  history: IConversationTurn[]
  turns: ITurnRecord[]
}

// A marker the workflow puts in a session's stream about a static subagent: `subagent.started`
// when its child workflow starts, `subagent.ended` when it is over. In the parked attempt's slot
// of the turn (`turnAttempt`) at seq SUBAGENT_MARKER_SEQ + n, after every event of that attempt and
// before the resumed one's (session-state.ts says how n is chosen).
export interface IStreamMarker {
  sessionId: string
  turn: number
  turnAttempt: number
  seq: number
  type: 'subagent.started' | 'subagent.ended'
  body: Record<string, unknown>
}
