import type { LanguageModel, ToolSet } from 'ai'
import type { IApprovalController } from './approval.ts'
import type { IMedia } from './media.ts'
import type { IResolvedEscalation, IStepWrites } from './tiers.ts'
import type {
  EventHandler,
  IAgentConfig,
  ISkill,
  IToolCatalogEntry,
  IUsage,
  ModelTier,
} from './types.ts'

// The effective (resolved) tool selection strategy of a run.
export type EffectiveToolStrategy = 'all' | 'plan-narrowed' | 'search'

// Mutable state of ONE run, shared between the runner, the stages and the
// tool wrappers (reached from inside a tool through the run context).
export interface IRunState {
  // Live usage accumulator of the run (the object the result returns).
  usage: IUsage
  // Tool calls made so far (maxToolCalls).
  toolCalls: number
  strategy: EffectiveToolStrategy
  // Tools find_tools activated, oldest first (search strategy).
  discovered: string[]
  // Tools active in the executor call in flight (search strategy); find_tools
  // adds to it so the next LLM step sees the new tools.
  stepActive?: Set<string>
  // Skill names active for the rest of the run, in activation order.
  activeSkills: string[]
  // Pages web_fetch read in this run (origin + path), kept as provenance for any lesson the run writes.
  fetched?: string[]
  // Running summary of trace[0, traceSummaryUpTo).
  traceSummary?: string
  traceSummaryUpTo: number
  // What the user said while the run was going (RunControl.send), oldest first, and whether
  // the replanner has weighed each. Reconciled ones always precede the unreconciled ones.
  userUpdates: { text: string; reconciled: boolean }[]
  // Escalations made so far in the run (escalation.maxPerRun).
  escalations?: number
  // The writes of the step in flight, set only while that step may be escalated: the tool wrapper
  // records them and hands an earlier attempt's result back instead of writing twice (tiers.ts).
  stepWrites?: IStepWrites
}

// The executor models by tier, when config.executorTiers is on. `standard` is always there (it
// is ctx.executorModel).
export interface IExecutorTiers {
  models: Partial<Record<ModelTier, LanguageModel>>
  // Model ids, for the events.
  ids: Partial<Record<ModelTier, string>>
  configured: ReadonlySet<ModelTier>
  escalation: IResolvedEscalation
}

export interface IAgentInternalContext {
  config: IAgentConfig
  // Called with the usage of every model call a run makes, as it arrives (the agent's own total,
  // IAgent.usage). Not called for a resumed run's earlier usage: that was spent before.
  onUsage?: (usage: IUsage) => void
  executorModel: LanguageModel
  // Set only when config.executorTiers names a light or a strong model: the planner then rates
  // steps and the executor runs each on its tier. Absent = one executor model, as ever.
  tiers?: IExecutorTiers
  plannerModel: LanguageModel
  synthesizerModel: LanguageModel
  // Host + MCP tools, already wrapped (approval gate, tool-call budget,
  // model-visible output cap). Mutated in place on refresh / reconnect.
  tools: ToolSet
  toolCatalog: IToolCatalogEntry[]
  emit: EventHandler
  // Built-in skill tools (load_skill / read_skill_file), when skills exist.
  builtinTools?: ToolSet
  // The find_tools built-in, when the search strategy is possible.
  findTools?: ToolSet
  skills?: ISkill[]
  // Set when config.learning is on (the executor is told to write lessons down). `tools` are the
  // notebook's tool names: callable in every step whatever the strategy narrows to (they are still
  // wrapped and gated like any other tool).
  learning?: { nudge: boolean; tools: string[] }
  // Set when config.sandbox is on and run_js is among the tools: the stage prompts say what it
  // is and that code is never reported as run without it.
  sandbox?: { files: boolean }
  // The rendered instructions of the connected MCP servers whose tools are mounted (the planner's
  // and the executor's system prompts carry it); absent when none sent any or
  // config.mcpInstructions is false. Replaced only between runs (refresh / reconnect), and a run
  // reads its own copy of this context, so the text cannot change under a run.
  mcpInstructions?: string
  approval?: IApprovalController
  // Set when config.media names a model: its tools are among `tools`; the runner uses it to
  // transcribe a run's audio attachments.
  media?: IMedia
  // Per-run state; set by the runner on its per-run copy of the context.
  run?: IRunState
  // Take what the user said since the last boundary, for delivery INSIDE a step (between
  // tool-calling rounds): records it, announces it, returns the texts. Set only when the
  // run has a control.
  takeRoundUpdates?: () => string[]
}
