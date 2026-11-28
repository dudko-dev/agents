// The shapes the gateway, the session workflow and the turn activity share. Types only: the
// workflow bundle imports this file, so nothing here may touch Node.
import type { IConversationTurn, IUsage } from '@dudko.dev/agent'
import type { PipelineNode, PipelineNodeInput } from '@dudko.dev/agent/pipeline-engine'

// A message the user sent. `id` makes a retried POST harmless (the workflow drops a repeat);
// `at` is the gateway's clock, for display only.
export interface IUserMessage {
  id: string
  text: string
  at: number
}

// The answer to an item a parked turn waits for (see "Parking" in examples/swarm/README.md): a
// person's decision (an 'approval' item) or a tool's result from outside (a 'tool' item) - checked
// by answers.ts. A static subagent's or a pipeline's child workflow answers its own item the same
// way (`by: 'subagent'` / `by: 'pipeline'`).
export interface IAnswer {
  requestId: string
  value: unknown
  at: number
  by?: 'client' | 'subagent' | 'pipeline'
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
  // Pipelines (a child workflow per call, one per node visit under it): the same two caps, of
  // their own (PIPELINE_DEFAULTS in session-state.ts for a session started before them).
  pipelineMaxPerRound?: number
  pipelineMaxPerSession?: number
}

// What one turn is given. `answers`: a parked turn goes on with the answers to every item it waits
// for (the activity resumes its run with them). `subagents` / `pipelines`: how many static
// subagent / pipeline calls the turn's next round may make (the caps, minus what the session has
// started already).
export interface ITurnInput {
  sessionId: string
  turn: number
  input: string
  history: IConversationTurn[]
  messageIds: string[]
  answers?: Record<string, IAnswer>
  subagents?: IChildBudget
  pipelines?: IChildBudget
}

export interface IChildBudget {
  maxPerRound: number
  remaining: number
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
  // Set when a pipeline answers it: the workflow runs it as a child workflow `pipeline`.
  pipeline?: IPipelineCall
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

// What a child's activity (runSubagent, runPipelineNode) is given beside the child's input.
// `park`: the child workflow waits for a person's answers (it is new enough to - behind
// PATCH_CHILD_PARKING), so a run that parks reports `parked` (a child without it never parks: an
// ask is a denial, a deferred result a refusal). `answers`: the resume of a parked run, with an
// answer for every item it waits for.
export interface IChildRun {
  park?: boolean
  answers?: Record<string, IAnswer>
}

// A child's run that parked: it waits for an answer to every request (a person's decision, or a
// result from outside), from the gateway - the child workflow resumes the SAME run with them.
export interface IChildParked {
  status: 'parked'
  runId: string
  attempt: number
  requests: IParkedRequest[]
}

// What a child workflow of a parked turn tells the session about its own park
// (childParkSignal): it waits for a person (`waiting`, with the items), or it goes on
// (`resumed`, with the ids it was answered). `itemId`: the parked turn's item the child answers
// (a subagent call, or a pipeline call - then `nodeId` / `visit` name the node visit that waits).
export interface IChildParkNotice {
  itemId: string
  kind: 'subagent' | 'pipeline'
  // The child that waits: the subagent child, or the pipeline's node visit.
  workflowId: string
  nodeId?: string
  visit?: number
  runId: string
  state: 'waiting' | 'resumed'
  requests?: IParkedRequest[]
  answered?: string[]
  at: number
}

// A child of the parked turn that waits for a person, as the session's state shows it. `requests`
// are what to answer - POST /sessions/:id/answers/:requestId, the same route as the turn's own
// items; `events` is the child's own stream.
export interface IChildWaiting {
  itemId: string
  kind: 'subagent' | 'pipeline'
  name: string
  workflowId: string
  nodeId?: string
  visit?: number
  runId: string
  requests: IParkedRequest[]
  since: number
  events: string
}

// A child workflow's own state (childStateQuery): running its activity, waiting for answers (what
// it waits for, and which have come), or ended.
export interface IChildView {
  status: 'running' | 'waiting' | 'ended'
  // How many times its run parked.
  parks: number
  parked?: { runId: string; requests: IParkedRequest[]; answered: string[] }
}

// A call of a pipeline (PIPELINES), as the parent model made it: its `task` is the pipeline's
// request.
export interface IPipelineCall {
  name: string
  task: string
}

// What a child workflow `pipeline` is given: one run of the pipeline `name` on `task`. Its graph
// is the worker's (an activity reads it once, so the history holds the definition the run used);
// `stream` keys its own event stream (the engine's pipeline.* events), `workflowId` names its
// node children.
export interface IPipelineInput {
  sessionId: string
  turn: number
  parentRunId: string
  itemId: string
  workflowId: string
  stream: string
  name: string
  task: string
  options: Pick<ISessionOptions, 'turnTimeoutMs' | 'heartbeatTimeoutMs' | 'maxTurnAttempts'>
}

// How a pipeline came out; the parent turns it into the item's answer. `runs` and `usage`: the
// node visits it started and what the finished ones spent. `stoppedBy`: a cap of the
// definition's `limits` cut the run short (it still has an answer: its last terminal node's).
export type PipelineOutcome =
  | {
      status: 'completed'
      text: string
      usage: IUsage
      runs: number
      stoppedBy?: 'maxRuns' | 'maxNodeVisits'
    }
  | { status: 'stopped'; runs: number; usage: IUsage }
  | {
      status: 'failed'
      error: string
      runs: number
      usage: IUsage
      nodeId?: string
      visit?: number
    }

// What a child workflow `pipelineNode` is given: ONE visit of one node - one agent.run of the
// node's agent (the worker's, see examples/swarm's pipelines.ts) on the rendered input, and the
// route call when the node has routes. `node` is the node as the pipeline's plan has it (the
// worker checks it is the one it has); `stream` keys the visit's run and events.
export interface IPipelineNodeInput {
  sessionId: string
  turn: number
  itemId: string
  pipeline: string
  workflowId: string
  stream: string
  node: PipelineNode
  input: PipelineNodeInput
  options: Pick<ISessionOptions, 'turnTimeoutMs' | 'heartbeatTimeoutMs' | 'maxTurnAttempts'>
}

// How a node visit came out. `route`: one of the node's labels (or none).
export type PipelineNodeOutcome =
  | {
      status: 'completed'
      runId: string
      attempt: number
      text: string
      usage: IUsage
      route?: string
    }
  | { status: 'stopped'; runId?: string; attempt?: number; usage?: IUsage }
  | { status: 'failed'; error: string }

// A batch of a stream the workflow writes through an activity (a pipeline's own stream: the
// engine's events, numbered by the workflow). `started`: the stream's turn.started marker's body.
export interface IStreamBatch {
  stream: string
  started?: Record<string, unknown>
  events: { seq: number; event: { type: string } & Record<string, unknown> }[]
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

// What the workflow tells the event stream when a turn is over (`turn.ended`). A child's own
// stream ends the same way; a pipeline's adds `runs` / `stoppedBy`, a node visit's its `route`.
export interface ITurnEnd {
  sessionId: string
  turn: number
  status: Exclude<TurnStatus, 'parked'>
  runId?: string
  attempt?: number
  text?: string
  error?: string
  usage?: IUsage
  route?: string
  runs?: number
  stoppedBy?: string
  // A child that may have waited for answers: the items it still waits for (in `swarm_parked`,
  // under the session, owned by the child's workflow id) are closed with it. Not in the marker.
  closes?: { sessionId: string; owner: string }
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
  // `waiting`: the children of the parked turn that wait for a person (their own items).
  parked?: {
    turn: number
    runId: string
    requests: IParkedRequest[]
    answered: string[]
    waiting?: IChildWaiting[]
  }
  // Static subagent calls started in this session (counted against subagentMaxPerSession).
  subagentsStarted?: number
  // Pipeline calls started in this session (counted against pipelineMaxPerSession).
  pipelinesStarted?: number
  history: IConversationTurn[]
  turns: ITurnRecord[]
}

// A marker the workflow puts in a session's stream about a child workflow of a parked turn:
// `subagent.started` / `pipeline.call.started` when it starts, `subagent.ended` /
// `pipeline.call.ended` when it is over, and between them `subagent.waiting` /
// `pipeline.call.waiting` when the child (a pipeline's node visit) parks on a person's answer and
// `subagent.resumed` / `pipeline.call.resumed` when it goes on with the answers. In the parked
// attempt's slot of the turn (`turnAttempt`) at seq SUBAGENT_MARKER_SEQ + n, after every event of
// that attempt and before the resumed one's (session-state.ts says how n is chosen). (Not
// `pipeline.started`: that is the engine's own event, in the pipeline's own stream.)
export interface IStreamMarker {
  sessionId: string
  turn: number
  turnAttempt: number
  seq: number
  type:
    | 'subagent.started'
    | 'subagent.waiting'
    | 'subagent.resumed'
    | 'subagent.ended'
    | 'pipeline.call.started'
    | 'pipeline.call.waiting'
    | 'pipeline.call.resumed'
    | 'pipeline.call.ended'
  body: Record<string, unknown>
}
