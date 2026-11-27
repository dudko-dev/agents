import type { LanguageModel, ToolSet } from 'ai'
import type { IApprovalController } from './approval.ts'
import type { RunControlPort } from './control.ts'
import type { ISpawnReservation } from './subagent-dynamic-shared.ts'
import type { McpSkillConsent, McpSkillRunConsent } from './mcp-skills.ts'
import type { IMedia } from './media.ts'
import type { IResolvedEscalation, IStepWrites } from './tiers.ts'
import type { IWaitClock } from './wait-clock.ts'
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

// Where a run stands among the helpers the model starts (config.subagents.dynamic). The run the
// host started has depth 0 and no id; a helper's run carries what it was narrowed to.
export interface ISpawnScope {
  // The helper's id (its subagent.start event); absent for the host's run.
  id?: string
  depth: number
  // The state of the run the host started: the per-run count of helpers lives there.
  root: IRunState
  // This run's helpers that are running: what each may still spend of this run's budgets.
  running: ISpawnReservation[]
  // At most maxConcurrent helpers of this run at once.
  acquire: (signal?: AbortSignal) => Promise<() => void>
  // A helper's own run only: its tools (a subset of its parent's), their catalogue, its config
  // (the parent's, with its share of the budgets) and the run that started it.
  tools?: ToolSet
  catalog?: IToolCatalogEntry[]
  config?: IAgentConfig
  parent?: IRunState
  // Its counted tool calls so far (kept by the tool wrapper): what is left of its share is not
  // the parent's to promise to another helper.
  toolCalls?: number
  // The control of the run the host started: helpers at any depth register there.
  control?: RunControlPort
}

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
  // MCP servers' skills this run let into its context, and refused (the person's consent;
  // mcp-skills.ts). An MCP skill is active only when it is allowed here.
  mcpSkillConsent?: McpSkillRunConsent
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
  // Helpers the model started in this run, its helpers' helpers included (maxChildren). Counted
  // on the state of the run the host started.
  subagentsSpawned?: number
  // Set once the run starts a helper, and from the start on a helper's own run.
  spawn?: ISpawnScope
  // Questions MCP servers asked the user in this run (`onElicitation`), its helpers' calls
  // included: counted on the state of the run the host started (elicitation.maxPerRun).
  elicitations?: { count: number }
  // The run's clock (wait-clock.ts): its step limit (`llmTimeoutMs`) and the time limits of the
  // subagents it calls are deadlines of it, and it is stopped while a tool call of the run - or
  // of a subagent below it - waits for a person (a tool approval, an MCP elicitation).
  clock?: IWaitClock
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
  // Set while spawn_subagent is among the tools (config.subagents.dynamic): the planner's and the
  // executor's prompts say when a helper is worth it.
  subagents?: { dynamic: true }
  // On the context of a helper's run only: handed to its run state by the runner.
  spawn?: ISpawnScope
  // The rendered instructions of the connected MCP servers whose tools are mounted (the planner's
  // and the executor's system prompts carry it); absent when none sent any or
  // config.mcpInstructions is false. Replaced only between runs (refresh / reconnect), and a run
  // reads its own copy of this context, so the text cannot change under a run.
  mcpInstructions?: string
  approval?: IApprovalController
  // config.mcpSkills.consent: the consent for MCP servers' skills whose server config names none.
  mcpSkillConsent?: McpSkillConsent
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
