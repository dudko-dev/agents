// What the gateway needs from a platform: the sessions (`ISessionBackend` - Temporal and the
// session table in examples/swarm), the event log (`IEventFeed` - Postgres and LISTEN/NOTIFY
// there), the rows they return, and the errors they throw. Types and plain error classes only: each
// platform implements them with its own services; the gateway (gateway.ts) is the same everywhere.
import type { ICursor } from './cursor.ts'
import type {
  IAnswer,
  IParkedRequest,
  ISessionView,
  IStopRequest,
  IUserMessage,
} from './session-types.ts'

// --- the parked items ----------------------------------------------------------------------------

// pending - the turn (or the child) waits for it; answered - the turn went on with its answer
// (marked when the resume starts); cancelled - the turn was stopped while it waited (or the child
// ended).
export type ParkedState = 'pending' | 'answered' | 'cancelled'

// Who answers an item: a client (a person, an outside system) or a child workflow of the session.
export type AnsweredBy = 'client' | 'subagent' | 'pipeline'

// The child workflow that waits for an item (a child's own park): its workflow id, the parked
// turn's item it answers, and - a pipeline node visit - the node and the visit.
export interface IParkedOwner {
  workflowId: string
  itemId: string
  nodeId?: string
  visit?: number
}

// An item a parked turn (or a child of it) waits for, as the platform stores it - what the gateway
// checks an answer against without asking a worker.
export interface IParkedRow {
  sessionId: string
  itemId: string
  turn: number
  runId: string
  kind: IParkedRequest['kind']
  answeredBy: AnsweredBy
  // The child workflow that answers it (answeredBy 'subagent' / 'pipeline').
  childId?: string
  // The child workflow that WAITS for it (a child's own item; answeredBy 'client').
  owner?: IParkedOwner
  item: unknown
  state: ParkedState
}

// --- the sessions --------------------------------------------------------------------------------

// What the gateway needs for the sessions. A call to a session the platform does not know throws
// SessionNotFoundError, to one that has ended SessionEndedError, anything unreachable
// BackendUnavailableError (a 503); anything else is a 500.
export interface ISessionBackend {
  create: (sessionId: string, first?: IUserMessage) => Promise<void>
  message: (sessionId: string, message: IUserMessage) => Promise<void>
  answer: (sessionId: string, answer: IAnswer) => Promise<void>
  // The answer to an item a child of the session's parked turn waits for: signalled to that child
  // workflow (`workflowId`, checked by the gateway to be the session's). ChildEndedError when the
  // child is over.
  answerChild: (sessionId: string, workflowId: string, answer: IAnswer) => Promise<void>
  stop: (sessionId: string, stop: IStopRequest) => Promise<void>
  state: (sessionId: string) => Promise<ISessionView>
  // The session was started here: the event stream of an unknown id is a 404.
  exists: (sessionId: string) => Promise<boolean>
  // An item a parked turn of the session waits for (no worker needed), and the session's static
  // subagent and pipeline calls. The lookup is by session: another session's item is not found.
  parkedItem: (sessionId: string, itemId: string) => Promise<IParkedRow | undefined>
  subagents: (sessionId: string) => Promise<IParkedRow[]>
  pipelines: (sessionId: string) => Promise<IParkedRow[]>
  // Throws when the platform's services cannot be reached (GET /readyz names the reason).
  ready: () => Promise<void>
}

// --- the event log -------------------------------------------------------------------------------

// One stored event of a stream, in stream order.
export interface IStreamRow {
  cursor: ICursor
  // The stored event, as JSON text on one line.
  json: string
}

export type WaitResult = 'notified' | 'timeout' | 'closed'

// A stream's subscription to its new events. It is taken BEFORE the stream replays, so an event
// stored while it reads is not lost: the next wait returns at once.
export interface ISubscription {
  // Until a notification for the stream (or one already pending), `ms`, or `signal`.
  wait: (ms: number, signal?: AbortSignal) => Promise<WaitResult>
  close: () => void
}

// What the event stream needs from the platform.
export interface IEventFeed {
  // The rows after `after`, in stream order, at most `limit`.
  after: (sessionId: string, after: ICursor, limit: number) => Promise<IStreamRow[]>
  subscribe: (sessionId: string) => ISubscription
  // The notification channel is up.
  ready: () => boolean
  // Streams open now (subscriptions): the SSE cap.
  open: () => number
}

// --- the errors a backend throws -----------------------------------------------------------------

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`no session ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

export class SessionEndedError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} has ended`)
    this.name = 'SessionEndedError'
  }
}

// The child an item names is over (stopped, ended): nothing waits for the item any more.
export class ChildEndedError extends Error {
  constructor(workflowId: string) {
    super(`child workflow ${workflowId} has ended`)
    this.name = 'ChildEndedError'
  }
}

export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendUnavailableError'
  }
}
