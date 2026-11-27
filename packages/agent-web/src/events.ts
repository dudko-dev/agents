import type {
  EscalationReason,
  IPlan,
  IPlanStep,
  IStepResult,
  IUsage,
  ModelTier,
  TierReason,
} from './agent/loop-types.js'
import type { IDecisionEvent } from './decision.js'
import type { LimitKind } from './limits.js'
import type { McpElicitationReason, McpElicitationSchema } from './mcp/elicitation.js'
import type { PipelineEvent } from './pipeline/engine.js'

export type ReplanMode = 'continue' | 'revise' | 'finish'
export type Phase = 'plan' | 'execute' | 'replan' | 'synthesize'
/**
 * Phases a `usage` event can be charged to: the four stages plus compaction and subagents;
 * `decision` - a call to `config.decisionModel` (`usage.decisionCalls`, plus the tokens its API
 * reported); and 'media' - a call to an image / speech / transcription model (`config.media`),
 * whose `usage` carries the media fields and zero tokens.
 */
export type UsagePhase = Phase | 'compact' | 'subagent' | 'decision' | 'media'

/**
 * Everything the agent does is streamed as a typed event so any UI (or none)
 * can render progress. The final answer arrives as a `final` event; there is no
 * built-in rendering. This is a browser-focused subset of the Node sibling's
 * event taxonomy (no persistence/otel events), plus `model.load` for WebLLM
 * weight-download progress.
 */
type AgentEventBody =
  /**
   * `runId` names the run for `persistence` / `resumeFromRunId`. `resumed` is set when it
   * continues a checkpointed run: the steps already done and the ones still to come.
   */
  | {
      type: 'run.start'
      goal: string
      runId?: string
      resumed?: { completedSteps: number; remainingSteps: number }
    }
  | { type: 'model.load'; progress: number; text: string }
  | { type: 'plan.thought-delta'; delta: string }
  | { type: 'plan.step-added'; step: IPlanStep; index: number }
  | { type: 'plan.created'; plan: IPlan }
  | { type: 'plan.revised'; plan: IPlan; reason: string }
  /**
   * `tier` / `model` / `tierReason`: only when `config.executorTiers` is on - the tier the step
   * starts on, its model id, and why that tier (see `TierReason`).
   */
  | {
      type: 'step.start'
      step: IPlanStep
      index: number
      total: number
      tier?: ModelTier
      model?: string
      tierReason?: TierReason
    }
  /**
   * The step failed on `from` and is retried on the stronger tier `to` (`config.escalation`);
   * `model` is the model id of `to`. Fires between the step's start and its completion.
   */
  | {
      type: 'step.escalated'
      step: IPlanStep
      from: ModelTier
      to: ModelTier
      model: string
      reason: EscalationReason
    }
  | { type: 'step.text-delta'; step: IPlanStep; delta: string }
  /** The executor model's streamed thoughts (thinking enabled + provider support). */
  | { type: 'step.reasoning-delta'; step: IPlanStep; delta: string }
  | { type: 'step.tool-call'; step: IPlanStep; name: string; input: unknown }
  | { type: 'step.tool-result'; step: IPlanStep; name: string; output: unknown; ok: boolean }
  | { type: 'step.complete'; step: IPlanStep; result: IStepResult }
  /**
   * `byUser`: the replanner ran because the user sent a message (`RunControl.send`), not because a
   * step failed. `failed`: the replanner call itself failed (unparsable output, the provider
   * down) and `mode: 'continue'` is the fallback, not the model's decision — the failure is the
   * `error` event (phase 'replan') just before this one. `confidence`: `config.decisionModel`
   * made this decision (the replanner was not called) - the probability it gave its choice.
   */
  | {
      type: 'replan.decision'
      mode: ReplanMode
      reason: string
      byUser?: boolean
      failed?: true
      confidence?: number
    }
  /**
   * `config.decisionModel` was asked a question: its answer was used (`accepted`), or the
   * ordinary model call ran and `reason` says why.
   */
  | IDecisionEvent
  | { type: 'final.text-delta'; delta: string }
  /** The synthesizer's streamed thoughts. */
  | { type: 'final.reasoning-delta'; delta: string }
  | { type: 'final'; text: string }
  | { type: 'usage'; phase: UsagePhase; usage: IUsage }
  | { type: 'retry'; phase: Phase; attempt: number; error: string }
  /** A run-level limit was reached; the run stops executing and writes its answer. */
  | { type: 'budget.exceeded'; kind: LimitKind; tokens: number; cap: number }
  /** Older context was summarised to fit the window. */
  | {
      type: 'context.compacted'
      /** history = stored transcript; trace = the run's done steps; tool-results = stale results inside a step's tool loop. */
      scope: 'history' | 'trace' | 'tool-results'
      beforeTokens: number
      afterTokens: number
    }
  /** A skill's instructions entered the context (picked by the planner, or loaded by a tool call). */
  | { type: 'skill.activated'; name: string; by: 'plan' | 'tool' }
  /** The agent wrote a lesson down as a skill (`config.learning`). */
  | {
      type: 'skill.learned'
      name: string
      description: string
      /** true when it rewrote an earlier lesson of the same name. */
      update: boolean
      chars: number
      /** What it consulted: the sources it named, then the pages web_fetch read in the run. */
      sources: string[]
    }
  /** A lesson was deleted (by the agent's forget_skill, or the host's forgetSkill). */
  | { type: 'skill.forgotten'; name: string }
  /**
   * A media tool (`config.media`) wrote a file to the virtual file system: `path` is where (read
   * it with `vfs.readDataUrl(path)` to show the picture or play the audio), `mediaType` what its
   * bytes are, `bytes` its size. The bytes themselves are never in an event.
   */
  | {
      type: 'media.generated'
      kind: 'image' | 'speech'
      path: string
      mediaType: string
      bytes: number
      model: string
      step?: IPlanStep
    }
  /**
   * An audio file was transcribed: one the user attached to the run ('attachment') or one the
   * model asked about ('tool'). `text` is what the model reads of it (cleaned and capped).
   */
  | {
      type: 'media.transcribed'
      source: 'attachment' | 'tool'
      name: string
      text: string
      language?: string
      durationInSeconds?: number
      model: string
    }
  /** find_tools activated more tools (large-catalogue search mode). */
  | { type: 'tools.discovered'; step?: IPlanStep; query: string; names: string[] }
  /** A tool call is waiting for the user's consent (see `toolApproval`). */
  | {
      type: 'tool.approval-requested'
      id: string
      name: string
      input: unknown
      readOnly: boolean
      step?: IPlanStep
      /** Set when a helper the model started is asking (see `ToolApprovalRequest.subagent`). */
      subagent?: { id: string; depth: number }
    }
  /** A consent decision: from the user, or `automatic` (policy denial). */
  | {
      type: 'tool.approval-resolved'
      id: string
      name: string
      approved: boolean
      reason?: string
      automatic: boolean
    }
  /**
   * An MCP server asked the user for input during a tool call (the connection's `onElicitation`
   * is being called). `message`, `requestedSchema` and `url` are the SERVER's text: cleaned and
   * capped, for a UI to show - never instructions.
   */
  | {
      type: 'mcp.elicitation-requested'
      id: string
      server: string
      /** The tool call that asks: the tool's name as the model called it. */
      tool: string
      mode: 'form' | 'url'
      message: string
      requestedSchema?: McpElicitationSchema
      url?: string
      step?: IPlanStep
      /** Set when a helper (a subagent) is the one whose call asks. */
      subagent?: { id: string; depth: number }
    }
  /**
   * The question was answered. Never carries a value the user entered: `fields` are the NAMES
   * of the fields an accepted form was answered with. `automatic`: nobody decided (a guard, a
   * cap, a timeout, a failed handler, a stopped run) - `reason` says which, the tool call
   * fails, and no `mcp.elicitation-requested` may have preceded it.
   */
  | {
      type: 'mcp.elicitation-answered'
      id: string
      server: string
      tool: string
      action: 'accept' | 'decline' | 'cancel'
      automatic: boolean
      reason?: McpElicitationReason
      fields?: string[]
    }
  /**
   * `profile` is set when the parent chose one of the subagent's named profiles for this call.
   * The tree: `parentId` is the id of the subagent that made the call, or the `runId` of the run
   * when the run itself made it; `depth` is 1 for the run's own subagents, 2 for theirs, ...
   * `dynamic` marks a helper the model started with `spawn_subagent` (`subagents.dynamic`):
   * `role` is what the model wrote for it, `tools` the tool names it was given.
   */
  | {
      type: 'subagent.start'
      id: string
      name: string
      task: string
      profile?: string
      parentId?: string
      depth?: number
      dynamic?: true
      role?: string
      tools?: string[]
    }
  /** An event of a running subagent, forwarded verbatim. */
  | { type: 'subagent.event'; id: string; name: string; event: AgentEvent }
  | { type: 'subagent.complete'; id: string; name: string; text: string; usage: IUsage }
  /**
   * `stopped` is set when the user stopped this subagent (`RunControl.stopSubagent`), as opposed
   * to it failing. `usage`: what a dynamic helper had spent when it failed (already charged to
   * the parent).
   */
  | {
      type: 'subagent.error'
      id: string
      name: string
      error: string
      stopped?: boolean
      usage?: IUsage
    }
  /**
   * A request of the `web_fetch` tool, or of `web_search` to its search API, allowed or refused
   * by the egress policy. `url` is origin and path only (a query string can carry a secret).
   */
  | { type: 'egress.request'; url: string; allowed: boolean; status?: number; reason?: string }
  /** A message sent with `RunControl.send` is waiting for the next boundary. */
  | { type: 'message.queued'; id: string; text: string }
  /**
   * The message reached the model. `round` = between tool-calling rounds inside a step, so
   * the rest of that step can act on it (the replanner weighs it at the end of the step);
   * `step` = at a step boundary, where it forces the replanner to look at the plan;
   * `final` = just before the answer is written.
   */
  | { type: 'message.delivered'; id: string; text: string; at: 'round' | 'step' | 'final' }
  | { type: 'stopped' }
  | { type: 'error'; phase: Phase | 'run'; error: string }
  /** A pipeline's own events (`createPipeline`): the run, each node visit, each edge decision. */
  | PipelineEvent

/**
 * `nodeId` / `visit` are set on the events a pipeline forwards from a node's agent (and on the
 * `pipeline.node.*` events themselves).
 */
export type AgentEvent = AgentEventBody & { nodeId?: string; visit?: number }

export type AgentEventHandler = (event: AgentEvent) => void
