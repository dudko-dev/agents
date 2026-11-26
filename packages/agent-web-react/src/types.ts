import type {
  AgentEvent,
  DecisionFallbackReason,
  DecisionPoint,
  EscalationReason,
  IPlan,
  IPlanStep,
  IUsage,
  ModelTier,
  ReplanMode,
  TierReason,
} from '@dudko.dev/agent-web'

/** Why a run stopped early (a `budget.exceeded` event). */
export interface BudgetView {
  kind: 'input' | 'output' | 'reasoning' | 'total' | 'tool-calls'
  tokens: number
  cap: number
}

/**
 * Lifecycle of the agent instance the hook owns.
 * - `idle`         — no config yet, nothing built.
 * - `initializing` — building the agent (dynamic provider imports, vault key
 *                    fetch, and — for WebLLM — weight download).
 * - `ready`        — the agent is built and can run.
 * - `running`      — a run is in flight.
 * - `error`        — the agent failed to build (a run error keeps it `ready`).
 */
export type AgentStatus = 'idle' | 'initializing' | 'ready' | 'running' | 'error'

/** A file or image shown with a message (and, for images, sent to the model). */
export interface ChatAttachment {
  name: string
  mediaType: string
  /** A data URL (images: thumbnail + full view) — kept so a saved chat can show it again. */
  dataUrl?: string
  /** Where it was stored in the virtual file system, if it was. */
  path?: string
  size?: number
}

/** One turn of the chat transcript that a chat UI renders. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** An assistant message that is still streaming (no final/stopped/error yet). */
  pending: boolean
  /** User turn: what was attached (images, files). */
  attachments?: ChatAttachment[]
  /** Assistant turn: the run's steps — tool calls, thoughts, subagents — as they happened. */
  steps?: StepView[]
  /** Assistant turn: consent decisions of the run. */
  approvals?: ApprovalView[]
  /** Assistant turn: subagent delegations of the run. */
  subagents?: SubagentView[]
  /** Assistant turn: what the user said while the run was going, and where it reached the agent. */
  notes?: UserNoteView[]
  /** Assistant turn: the synthesizer's thoughts. */
  reasoning?: string
  /** Assistant turn: tokens the run spent, by kind. */
  usage?: IUsage
  /** Assistant turn: wall-clock duration of the run (needs timestamps from the hook). */
  durationMs?: number
  /** Assistant turn: skills the run used. */
  skills?: string[]
  /** Assistant turn: lessons the agent wrote down during the run (names). */
  learned?: string[]
  /** Assistant turn: what the model fetched from the web during the run. */
  fetches?: FetchView[]
  /** Assistant turn: the images and audio the run generated (`config.media`); absent when none. */
  media?: MediaView[]
  /** Assistant turn: the audio the run transcribed (`config.media`); absent when none. */
  transcripts?: TranscriptView[]
  /** Assistant turn ended with an error. */
  error?: boolean
}

/** A single tool call as it appears in a step, streamed then finalized. */
export interface ToolCallView {
  name: string
  input: unknown
  output?: unknown
  ok?: boolean
  status: 'calling' | 'done'
  /** When the call started (ms epoch; set when the hook stamps events). */
  startedAt?: number
  /** How long the call took. */
  durationMs?: number
  /** ≈ tokens of the arguments the model wrote (chars / 4). */
  inputTokens?: number
  /** ≈ tokens of the result fed back to the model (chars / 4). */
  outputTokens?: number
  /**
   * Set on a call of an attempt that was escalated (model tiers): the attempt it belongs to,
   * 1 for the step's first. A call of the attempt the step is on now (or finished on) has none.
   */
  attempt?: number
  /**
   * The core did NOT run this call again: the same write already succeeded in an earlier attempt
   * at the step, and the model was handed that result (`output` carries the core's note).
   */
  replayed?: boolean
}

/**
 * One escalation of a step (a `step.escalated` event): the attempt on tier `from` failed for
 * `reason` and the step was retried on the stronger tier `to`.
 */
export interface StepEscalationView {
  from: ModelTier
  to: ModelTier
  reason: EscalationReason
  /** The model id of `to` (absent only when the escalation is known from the step's result alone). */
  model?: string
  /** What the failed attempt had written when it was escalated (its streamed text), if anything. */
  text?: string
}

/**
 * A lesson in the agent's notebook (`config.learning`): a skill the agent wrote down itself.
 * `revision` goes up each time it rewrites the lesson.
 */
export interface LessonView {
  name: string
  /** WHEN the lesson applies - the line the planner sees. */
  description: string
  revision: number
  /** Size of the instructions, in characters. */
  chars: number
  /** What it consulted: the sources it named, then the pages `web_fetch` read in that run. */
  sources: string[]
}

/** One request the model made through `web_fetch` (an `egress.request` event). */
export interface FetchView {
  /** Origin and path only - the core never reports the query string. */
  url: string
  allowed: boolean
  status?: number
  /** Why it was refused. */
  reason?: string
}

/**
 * A file a media tool wrote (a `media.generated` event). The bytes are in the virtual file system
 * at `path` - never in the state.
 */
export interface MediaView {
  kind: 'image' | 'speech'
  path: string
  mediaType: string
  /** Size of the file. */
  bytes: number
  /** The media model that made it. */
  model: string
  /** The step whose tool call made it, when the event named one. */
  stepId?: string
}

/**
 * An audio file that was transcribed (a `media.transcribed` event): one the user attached
 * (`attachment`) or one the model asked about (`tool`). `text` is the content of that file -
 * third-party text, never instructions.
 */
export interface TranscriptView {
  source: 'attachment' | 'tool'
  /** The file's name. */
  name: string
  text: string
  language?: string
  durationInSeconds?: number
  model: string
}

/**
 * One question put to `config.decisionModel` (a `decision` event): its answer was used
 * (`accepted`), or the ordinary model call ran and `reason` says why.
 */
export interface DecisionView {
  point: DecisionPoint
  accepted: boolean
  choice?: string
  /** The probability the decision model gave its choice, 0..1. */
  confidence?: number
  threshold: number
  reason?: DecisionFallbackReason
  durationMs: number
  model?: string
}

/** A tool call waiting for (or decided by) the user's consent. */
export interface ApprovalView {
  id: string
  name: string
  input: unknown
  readOnly: boolean
  /** The step the call belongs to, when known. */
  stepId?: string
  /**
   * Set when a helper the model started is asking, not the run itself: its id (a node of
   * `subagents`), its depth, and - when its `subagent.start` was seen - its name and role.
   */
  subagent?: { id: string; depth: number; name?: string; role?: string }
  status: 'pending' | 'approved' | 'denied'
  reason?: string
  /** Decided by policy (rule / read-only mode), not by a person. */
  automatic?: boolean
}

/** A message sent to the agent while it works, still waiting for a boundary to be shown to the model. */
export interface QueuedMessageView {
  id: string
  text: string
}

/**
 * A message the user sent while the run was going, after it reached the agent.
 * `at` says where: `round` = between tool calls inside a step, `step` = at the end
 * of a step (the replanner then re-checked the plan), `final` = just before the
 * answer was written.
 */
export interface UserNoteView {
  id: string
  text: string
  at: 'round' | 'step' | 'final'
  /** The step it was delivered in (`round`) or after (`step`); none for `final`. */
  stepId?: string
}

/**
 * A delegated task running in a subagent: one the host defined (`createSubagentTool`, in-process
 * or a Web Worker) or a helper the model started (`spawn_subagent`). Each is a NODE OF A TREE:
 * `parentId` / `depth` say where, and {@link subagentTree} nests the flat list.
 */
export interface SubagentView {
  id: string
  /** The subagent's name (`spawn_subagent` for a helper the model started). */
  name: string
  /** Empty when only its events were seen (its `subagent.start` never arrived). */
  task: string
  /**
   * The subagent that started this one; absent for the run's own subagents (depth 1). A parent
   * that is not in the list (its start was never seen) leaves the node at the top of the tree.
   */
  parentId?: string
  /** 1 for the run's own subagents, 2 for theirs, ... */
  depth: number
  /** A helper the model started itself (`subagents.dynamic`). */
  dynamic?: true
  /** What the model wrote for a helper it started. Model-written text. */
  role?: string
  /** The tool names a helper was given. */
  tools?: string[]
  /** The model and tier its latest step ran on - known only when the child uses model tiers. */
  model?: string
  tier?: ModelTier
  /** When it started (ms epoch; set when the hook stamps events). */
  startedAt?: number
  /** How long it ran, once it ended. */
  durationMs?: number
  /** `stopped`: the user stopped this subagent; the run went on without it. */
  status: 'running' | 'done' | 'error' | 'stopped'
  /** The profile the parent model chose for this delegation, when there are profiles. */
  profile?: string
  /** The step that delegated it, when known. */
  stepId?: string
  /** What the child is doing right now ("step 2: …", "→ tool"). */
  activity: string
  /** Steps the child started. */
  steps: number
  /** Tool calls the child made. */
  toolCalls: number
  /** The child's answer (streamed, then final). */
  text: string
  /**
   * Tokens spent under this node, its own subagents included: counted live from its `usage`
   * events, then replaced by the total its end reports.
   */
  usage: IUsage
  error?: string
}

/** A {@link SubagentView} with the subagents it started (see {@link subagentTree}). */
export interface SubagentNode extends SubagentView {
  children: SubagentNode[]
}

/** One compaction of the context (a `context.compacted` event). */
export interface CompactionView {
  scope: 'history' | 'trace' | 'tool-results'
  beforeTokens: number
  afterTokens: number
}

/** An execution step with its accumulated text and tool calls. */
export interface StepView {
  id: string
  index: number
  total: number
  step: IPlanStep
  /** Streamed executor text for this step (step.text-delta). */
  text: string
  /** Streamed executor thoughts for this step (step.reasoning-delta). */
  reasoning: string
  toolCalls: ToolCallView[]
  status: 'running' | 'done'
  summary?: string
  blocked: boolean
  /**
   * Model tiers (`config.executorTiers`) - all four are absent when tiers are off.
   * `tier` / `model`: the tier the step is on NOW (where it started, then where an escalation
   * took it, then where it finished) and that tier's model id.
   */
  tier?: ModelTier
  model?: string
  /** Why the step STARTED on its tier: the planner's rating, the default, or a fallback. */
  tierReason?: TierReason
  /**
   * The step's escalations, in order. `text` / `reasoning` above hold the current attempt only;
   * the calls of the attempts before it stay in `toolCalls`, marked with their `attempt`.
   */
  escalations?: StepEscalationView[]
  /**
   * The replanner call that followed this step failed (the provider's error): the run went on
   * with the plan it had. A warning, not a failed step.
   */
  replanFailed?: string
  /** What `config.decisionModel` was asked after this step; absent without a decision model. */
  decisions?: DecisionView[]
  /** The files this step's media tools wrote (also in the turn's `media`); absent when none. */
  media?: MediaView[]
}

/** WebLLM weight-download / engine-init progress (model.load events). */
export interface ModelLoadState {
  progress: number
  text: string
}

export interface ReplanState {
  mode: ReplanMode
  reason: string
  /** The replanner ran because the user sent a message, not because a step failed. */
  byUser?: boolean
  /**
   * The replanner call itself failed and `continue` is the fallback, not the model's decision.
   * `error` is the failure (the `error` event of phase `replan` that came just before).
   */
  failed?: true
  error?: string
  /** `config.decisionModel` made this decision: the probability it gave its choice. */
  confidence?: number
}

/**
 * The whole UI-facing view of an agent run, rebuilt purely from the stream of
 * `AgentEvent`s by {@link agentStateReducer}. `status` is owned by the hook
 * (build/run lifecycle) and layered on top; everything else here is derived
 * only from events, so the reducer is deterministic and testable without React.
 */
export interface AgentUiState {
  status: AgentStatus
  /** The goal of the current / most recent run. */
  goal?: string
  /** The last plan the agent produced (created or revised). */
  plan?: IPlan
  /** Streamed planner "thinking" text (plan.thought-delta). */
  planThought: string
  /** Execution steps, in order, with their tool calls. */
  steps: StepView[]
  /** The final answer (streamed via final.text-delta, finalized on final). */
  finalText: string
  /** The synthesizer's streamed thoughts (final.reasoning-delta). */
  finalReasoning: string
  /** Tool calls that asked for consent in this run, pending first-come. */
  approvals: ApprovalView[]
  /**
   * Subagent delegations of this run - static subagents and the helpers the model started, at
   * every depth, in the order they started. A tree: see `SubagentView.parentId` / `subagentTree`.
   */
  subagents: SubagentView[]
  /** Messages sent while the run goes that have not yet been shown to the model. */
  queued: QueuedMessageView[]
  /** What the user said during this run and when it reached the agent. */
  notes: UserNoteView[]
  /**
   * Messages the run ended without showing the model (sent while the answer was being
   * written, or still queued when the run was stopped). The hook sends them as a
   * follow-up unless the run was stopped; see `useAgent`'s `followUp`.
   */
  undelivered: string[]
  /** Skills activated in this run. */
  skills: string[]
  /**
   * The agent's notebook: the lessons it wrote down (`config.learning`). It belongs to the
   * agent, not to a conversation - it survives `reset` and a chat switch, and the hook
   * re-reads it whenever the agent is rebuilt.
   */
  learned: LessonView[]
  /** Names of the lessons written in this run. */
  learnedNow: string[]
  /** What the model fetched from the web in this run (`config.egress`). */
  fetches: FetchView[]
  /** Images and audio generated in this run (`config.media`). Absent until the first one. */
  media?: MediaView[]
  /** Audio transcribed in this run (`config.media`). Absent until the first one. */
  transcripts?: TranscriptView[]
  /**
   * Questions put to `config.decisionModel` before any step existed (a decision that follows a
   * step is on that step). Absent until the first one.
   */
  decisions?: DecisionView[]
  /** Tools activated by find_tools in this run. */
  discoveredTools: string[]
  /** Compactions in this run. */
  compactions: CompactionView[]
  /** Set when a run-level limit stopped the run early. */
  budget?: BudgetView
  /** Running token total across the current run. */
  usage: IUsage
  /** Token total across the whole conversation (every run since the last reset). */
  totalUsage: IUsage
  /** When the current run started (ms epoch; set when the hook stamps events). */
  runStartedAt?: number
  /** The id of the assistant message the current run streams into. */
  runMessageId?: string
  /** WebLLM progress, present only while a local model is loading. */
  modelLoad?: ModelLoadState
  /** The most recent replan decision, if any. */
  replan?: ReplanState
  /**
   * Error message from the last run error / build failure. A non-fatal `plan` / `execute` /
   * `synthesize` error is kept here too while the run goes on; a replanner failure is not (see
   * `replan.failed` and `StepView.replanFailed`).
   */
  error?: string
  /** True when the last run was aborted via stop(). */
  stopped: boolean
  /** A chat-style transcript built from every run, for chat UIs. */
  messages: ChatMessage[]
  /** The raw event log (most recent last), capped by `maxEvents`. */
  events: AgentEvent[]
  /** Monotonic counter; mints stable message ids without Date/Math.random. */
  seq: number
}
