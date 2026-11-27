import type { IDecisionModel } from '../decision.js'
import {
  NoObjectGeneratedError,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
} from 'ai'
import { cachedInstructions, cachingProviderOptions, type ResolvedCaching } from '../caching.js'
import { outputCapNotice, type BrowserAgentConfig, type ResolvedConfig } from '../config.js'
import type { AgentEvent } from '../events.js'
import type { StoredMessage } from '../memory/store.js'
import type { Prompts, ToolCallMode } from '../prompts.js'
import { withSystem } from '../prompts.js'
import type { Skill } from '../skills.js'
import {
  mergeProviderOptions,
  resolveThinking,
  thinkingFor,
  type ProviderOptionsMap,
  type ThinkingLevel,
  type ThinkingStage,
} from '../thinking.js'
import type { AgentToolSet } from '../tools/types.js'
import type { AgentLogger } from '../logger.js'
import {
  AttachmentsNotSupportedError,
  attachmentKind,
  isAttachmentRefusal,
  modelLabel,
  toFilePart,
  unsupportedAttachment,
  type RunFile,
} from '../images.js'
import type { IResolvedEscalation } from '../tiers.js'
import type { IWaitClock } from '../wait-clock.js'
import type { IPlanStep, IUsage, ModelTier } from './loop-types.js'

/** The effective tool-selection strategy of a run ('auto' already resolved). */
export type EffectiveToolStrategy = 'all' | 'plan-narrowed' | 'search'

/** One executor tier of an agent with `config.executorTiers`. */
export interface ExecutorTier {
  model: LanguageModel
  /** The tier's own tool-mode: a local light model is prompted, a cloud strong one native. */
  mode: ToolCallMode
  /** Model id, for the events. */
  id: string
  /** The window the tier's output cap is a share of (never below the window the run is fitted to). */
  windowTokens: number
  /** The tier's per-call output cap (0 = none), by the same rules as `budgets.executor`. */
  outputCap: number
}

/** The executor models by tier. `standard` is always there (it is `executorModel`). */
export interface ExecutorTiers {
  byTier: Partial<Record<ModelTier, ExecutorTier>>
  configured: ReadonlySet<ModelTier>
  escalation: IResolvedEscalation
}

/** Everything the phase functions (planner/executor/replanner/synthesizer) share. */
export interface AgentContext {
  config: ResolvedConfig
  raw: BrowserAgentConfig
  plannerModel: LanguageModel
  executorModel: LanguageModel
  /**
   * Set only when `config.executorTiers` names a light or a strong model: the planner then rates
   * steps and the executor runs each on its tier. Absent = one executor model, as ever.
   */
  tiers?: ExecutorTiers
  /** The window the executor's output cap was judged against, when it is not the run's (a tier's). */
  executorWindowTokens?: number
  synthesizerModel: LanguageModel
  /** `config.decisionModel`, resolved. Absent = the feature is off. */
  decisionModel?: IDecisionModel
  /** Tool-mode for the planner/replanner (from the planner model). */
  plannerMode: ToolCallMode
  /** Tool-mode for the executor (from the executor model). */
  executorMode: ToolCallMode
  /** The run's tools (host + MCP + built-ins), already wrapped by the consent gate. */
  tools: AgentToolSet
  /** The catalogue as the planner sees it (condensed in search mode). */
  toolCatalog: string
  prompts: Prompts
  emit: (event: AgentEvent) => void
  /** Leveled logger (config.logLevel over config.logger ?? console). */
  log: AgentLogger
  signal?: AbortSignal
  /**
   * The run's clock (wait-clock.ts): the executor's step limit (`chatTimeoutMs`) runs on it, and
   * it is stopped while a tool call of the run - or of a subagent below it - waits for a person.
   */
  clock?: IWaitClock
  /** Current world state for grounding, or undefined when no describeState is configured. */
  state: () => Promise<string | undefined>
  /** Session transcript loaded from memory BEFORE this run's goal was appended. */
  history?: StoredMessage[]

  /** Effective tool selection for this run. */
  strategy?: EffectiveToolStrategy
  /** Prompt caching, resolved. */
  caching?: ResolvedCaching
  /** All configured skills. */
  skills?: Skill[]
  /** Skills whose instructions are in play for this run. */
  activeSkills?: () => Skill[]
  /**
   * Set when `config.learning` is on: whether the executor is told to write lessons down, and the
   * notebook's tool names - callable in every step whatever the strategy narrows to (they are
   * still wrapped and gated like any other tool).
   */
  learning?: { nudge: boolean; tools: string[] }
  /**
   * Set when `config.sandbox` is on and `run_js` is mounted: the sentences the stage prompts
   * carry (what the tool is, and that code is never reported as run without it).
   */
  sandbox?: { planner: string; executor: string; synthesizer: string }
  /**
   * Set while `spawn_subagent` is among the tools (`config.subagents.dynamic`): the planner's and
   * the executor's prompts say when a helper is worth it.
   */
  subagents?: true
  /**
   * The rendered instructions of the MCP servers whose tools are mounted (`renderMcpInstructions`);
   * absent when none sent any or `config.mcpInstructions` is false. Built once, when the agent is
   * created, so it is the same text in every call of every run.
   */
  mcpInstructions?: string
  /** Tools find_tools activated during this run (search mode). */
  discovered?: () => string[]
  /** Built-in tool names (find_tools, skill tools) — always callable. */
  builtinTools?: ReadonlySet<string>
  /** Parameter hint of a tool, for prompted catalogues. */
  toolHint?: (name: string) => string | undefined
  /** Run usage so far (for in-step budget checks). */
  usageSoFar?: () => IUsage
  /** True when the run's limits are reached given extra usage spent inside the current call. */
  overBudget?: (extra: IUsage) => boolean
  /** Tracks the step being executed (tools read it via their run context). */
  setCurrentStep?: (step: IPlanStep | undefined) => void
  /** Images / PDFs / files the user sent with this run's goal. */
  images?: RunFile[]
  /** Everything the user said while the run was going (`RunControl.send`), oldest first. */
  userUpdates?: () => string[]
  /**
   * Take what the user said since the last boundary, for delivery INSIDE a step (between
   * tool-calling rounds): records it, announces it, and returns the texts.
   */
  takeRoundUpdates?: () => string[]
}

/**
 * The prompt of a stage call: plain text, or — when the run carries images — a
 * user message with the text and the images, so the model can see them.
 */
export const promptFor = (
  ctx: AgentContext,
  prompt: string,
): { prompt: string } | { messages: ModelMessage[] } =>
  ctx.images?.length
    ? {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }, ...ctx.images.map(toFilePart)],
          },
        ],
      }
    : { prompt }

/**
 * When a run carries attachments and a model call failed in a way that reads
 * like a refusal of them, the clear error to raise instead (else undefined).
 */
export const imageRefusal = (
  ctx: AgentContext,
  err: unknown,
  model: LanguageModel,
): AttachmentsNotSupportedError | undefined => {
  if (
    !ctx.images?.length ||
    err instanceof AttachmentsNotSupportedError ||
    !isAttachmentRefusal(err)
  ) {
    return undefined
  }
  const kinds = new Set(ctx.images.map(attachmentKind))
  const kind = kinds.size === 1 ? [...kinds][0] : 'file'
  const detail = err instanceof Error ? err.message.slice(0, 160) : undefined
  return unsupportedAttachment(modelLabel(model), kind, detail && `the provider said: ${detail}`)
}

/** Prepend the host's systemPrompt to a phase system prompt. */
export const systemFor = (ctx: AgentContext, base: string): string =>
  withSystem(base, ctx.raw.systemPrompt)

export const aborted = (ctx: AgentContext): boolean => ctx.signal?.aborted === true

export interface StageCallOptions {
  system: string | SystemModelMessage
  reasoning?: ThinkingLevel
  providerOptions?: ProviderOptionsMap
  /** The stage's per-call output cap; absent = no cap (turned off, or the stage thinks). */
  maxOutputTokens?: number
}

/**
 * The per-stage call settings: the host systemPrompt + the phase system prompt
 * (as a cacheable message when prompt caching is on), the stage's thinking
 * level, the merged provider options (thinking, caching), and the stage's per-call
 * output cap (`config.budgets`, where 0 means none).
 */
export const stageCall = (
  ctx: AgentContext,
  stage: ThinkingStage,
  baseSystem: string,
): StageCallOptions => {
  // The MCP servers' instructions go to the stages that choose and call tools, after the stage's
  // own text (whatever prompt builder made it) and under their own preamble: third-party text.
  const withMcp =
    ctx.mcpInstructions && (stage === 'planner' || stage === 'executor')
      ? `${baseSystem}\n\n${ctx.mcpInstructions}`
      : baseSystem
  const system = systemFor(ctx, withMcp)
  const thinking = resolveThinking(thinkingFor(stage, ctx.raw.thinking, ctx.raw.stageThinking))
  const caching = ctx.caching ?? { enabled: false }
  const providerOptions = mergeProviderOptions(
    cachingProviderOptions(caching, ctx.config.clientName, stage),
    thinking.providerOptions,
  )
  return {
    system: cachedInstructions(system, caching),
    ...(thinking.reasoning ? { reasoning: thinking.reasoning } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    ...(ctx.config.budgets[stage] > 0 ? { maxOutputTokens: ctx.config.budgets[stage] } : {}),
  }
}

/**
 * The notice for a call of `stage` that its output cap cut off (`finishReason: 'length'`), else
 * undefined. Judged against the window the run really uses, like the caps themselves.
 */
export const capNotice = (
  ctx: AgentContext,
  stage: ThinkingStage,
  finishReason: string | undefined,
): string | undefined =>
  outputCapNotice(
    ctx.raw,
    stage,
    (stage === 'executor' ? ctx.executorWindowTokens : undefined) ??
      ctx.config.compaction.contextWindowTokens,
    finishReason,
  )

/**
 * A structured stage (planner, replanner) whose JSON was cut by the cap fails with a parse error
 * that says nothing about why: add the reason to the message and hand the same error back.
 */
export const withCapHint = (ctx: AgentContext, stage: ThinkingStage, err: unknown): unknown => {
  if (NoObjectGeneratedError.isInstance(err)) {
    const notice = capNotice(ctx, stage, err.finishReason)
    if (notice) err.message = `${err.message} - ${notice}`
  }
  return err
}
