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

// A person's answer to a question a turn asked (see "Parking" in the README). Stored by the
// workflow now; consumed once the core can park a run.
export interface IAnswer {
  requestId: string
  value: unknown
  at: number
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
}

// What one turn is given. `answers` is the parking seam: the answers to the questions a parked
// turn asked, passed when the turn goes on (unused until the core can park a run).
export interface ITurnInput {
  sessionId: string
  turn: number
  input: string
  history: IConversationTurn[]
  messageIds: string[]
  answers?: Record<string, IAnswer>
}

// A question a parked turn is waiting on.
export interface IParkedRequest {
  requestId: string
  kind: string
  // What the person is shown (the tool and its input, an MCP server's question, ...).
  question: unknown
}

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
  // The next step (parking, a parallel core PR): the run stopped on a person's question; it goes
  // on, as the same turn and the same run, once every request has an answer.
  | { status: 'parked'; runId: string; attempt: number; requests: IParkedRequest[] }

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
  history: IConversationTurn[]
  turns: ITurnRecord[]
}
