import type { EscalationConfig, IStepResult, ModelTier } from './agent/loop-types.js'
import type { RunPersistence } from './agent/persistence.js'
import type { PromptCachingSetting } from './caching.js'
import type { TokenLimits } from './limits.js'
import {
  resolveCompaction,
  type CompactionConfig,
  type ResolvedCompaction,
} from './memory/compress.js'
import type { ContextStore } from './memory/store.js'
import type { AgentLoggerSink, LogLevel } from './logger.js'
import type { ModelInput, StageInput } from './providers/types.js'
import type { Prompts } from './prompts.js'
import type { CredentialStore } from './secrets/store.js'
import type { LearningConfig } from './learning.js'
import type { SandboxConfig } from './sandbox/index.js'
import type { Skill } from './skills.js'
import type { IEgressPolicy } from './tools/egress.js'
import type { ISearchConfig } from './tools/web-search.js'
import {
  resolveThinking,
  thinkingFor,
  type ThinkingSetting,
  type ThinkingStage,
} from './thinking.js'
import type { ToolApprovalConfig } from './tools/approval.js'
import type { AgentToolSet } from './tools/types.js'

/** Force a tool-calling strategy, or let the agent pick per model ('auto'). */
export type ToolMode = 'auto' | 'native' | 'prompted'

/**
 * When to consult the replanner after an executed step (given `replan` is on):
 * 'failure' — after a blocked step or a failed tool call (default);
 * 'always'  — after every step, so the replanner can react to problems the host
 *             surfaces via `describeState` (one extra model call per step);
 * predicate — decides per step result; closes over host state if needed, and
 *             falls back to 'failure' behaviour if it throws.
 */
export type ReplanTrigger =
  'failure' | 'always' | ((result: IStepResult) => boolean | Promise<boolean>)

/**
 * 'all'           — the executor sees the full ToolSet on every step.
 * 'plan-narrowed' — the executor sees only a step's suggestedTools (the planner
 *                   must populate them). Empty means a reasoning-only step.
 * 'search'        — for large catalogues: the executor starts with the step's
 *                   suggestedTools plus a `find_tools` meta-tool that activates
 *                   more on demand; the planner sees a condensed catalogue.
 * 'auto'          — 'all' up to `toolSearchThreshold` tools, 'search' above (default).
 */
export type ToolSelectionStrategy = 'all' | 'plan-narrowed' | 'search' | 'auto'

/** Per-phase generation budgets (max output tokens). */
export interface PhaseBudgets {
  planner?: number
  executor?: number
  replanner?: number
  synthesizer?: number
}

export interface BrowserAgentConfig {
  /** The default (executor) model: a ready AI SDK model, or a ProviderModelSpec to resolve. */
  model: ModelInput
  /** Optional per-stage model overrides. A partial override inherits base provider/creds. */
  planner?: StageInput
  synthesizer?: StageInput
  /**
   * Executor models by tier. Off unless `light` or `strong` is set: with neither, nothing about a
   * run changes. Each is a stage input like `planner` (a model, a spec, or a partial override of
   * the base); `standard` is `model` unless overridden here. With tiers on, the planner marks
   * every step with a `complexity` and the executor runs it on that tier's model (low -> light,
   * medium -> standard, high -> strong); a tier that is not configured falls back to the nearest
   * configured one (the stronger of two equally near). Every step is fitted to the SMALLEST
   * window among the models in play (a local model's is read from it; state a cloud model's in
   * `compaction.contextWindowTokens`).
   */
  executorTiers?: Partial<Record<ModelTier, StageInput>>
  /**
   * When a step fails in a way a stronger model could fix (a blocker, no result, tool arguments
   * that keep failing to parse, output cut by the cap, a failed model call), retry it on the next
   * stronger configured tier BEFORE the replanner is consulted. The retry continues the step: it
   * is shown what the first attempt already did, and a write that already succeeded is not
   * executed again. Never on a stop, refused credentials (401 / 403), a rate limit (429), a spent
   * budget or a tool the user denied. Default: on when `executorTiers` is on (`false` turns it
   * off); without tiers it does nothing.
   */
  escalation?: boolean | EscalationConfig
  /** Fetches API keys for ProviderModelSpec models. Default: none (inline keys only). */
  credentials?: CredentialStore
  /** Propagated to the openai-compatible provider name and the MCP client. */
  clientName?: string

  /**
   * Requests the MODEL may make (the `web_fetch` tool). Off unless set: with it off there is no
   * way to fetch. `true` = any public host over https; an object narrows or widens that (allow /
   * deny lists, ...) - see `IEgressPolicy`. A browser cannot pin DNS: prefer an `allow` list, or a
   * `fetch` that goes through a server-side safe fetch. Not the provider's own calls, MCP servers
   * or tools you pass yourself - those are your configuration, not the model's.
   */
  egress?: boolean | IEgressPolicy
  /**
   * Let the model SEARCH the web (the `web_search` tool: a short list of title / url / snippet).
   * Off unless set. The library ships no key: name a hosted search API (`provider` +
   * `credentialRef` - the key stays in `credentials`, never here - or a SearXNG `baseURL`) or
   * pass a function (`engine`). The adapter's request reaches that API's host only, through the
   * guarded fetch; with `egress` set, results the model could not fetch are left out. Works
   * without `egress` (then there is no `web_fetch` to open a link). The API must allow
   * cross-origin calls from a page - see `ISearchConfig`.
   */
  search?: ISearchConfig
  /**
   * Let the agent RUN JavaScript it wrote (the `run_js` tool) and read the output. Off unless
   * set: with it off the tool does not exist and the engine is never loaded. `true` = the
   * defaults, on the page's thread; an object sets the limits and - recommended - a `worker`
   * factory, so the guest runs in a Web Worker that is terminated at the deadline. The guest
   * runs in QuickJS compiled to WebAssembly (the optional peer `quickjs-emscripten`): no network,
   * no DOM, no page globals. When the agent has file tools (`createFileTools`) the guest can
   * import / require workspace files and use `fs` through the same file system and the same
   * consent rules (`files: false` switches that off). A run is a write for tool approval.
   */
  sandbox?: boolean | SandboxConfig
  /** Host tools the executor may call (an AI SDK ToolSet; use defineTool). */
  tools?: AgentToolSet
  /** Whitelist: only these tool names from `tools` are mounted (default: all). */
  availableTools?: string[]
  /** Blacklist: these tool names are removed after the whitelist is applied. */
  excludedTools?: string[]
  /** Force native/prompted tool-calling; 'auto' picks per model (default 'auto'). */
  toolMode?: ToolMode
  /** How the executor sees the tool catalogue (default 'auto'). */
  toolSelectionStrategy?: ToolSelectionStrategy
  /** Catalogue size above which 'auto' switches to 'search' (default 40). */
  toolSearchThreshold?: number
  /** Consent policy for tool calls: autopilot, ask before writes, ask always, read-only. */
  toolApproval?: ToolApprovalConfig

  /** Reusable instruction bundles (SKILL.md) the planner/executor can pull in. */
  skills?: Skill[]

  /**
   * Let the agent write down lessons as skills (`save_skill` / `forget_skill`) for the rest of the
   * session: `true` keeps them in memory; `{ store: new VfsSkillStore(vfs) }` keeps them in the
   * file system across sessions. Off by default. Knowledge only - see `learning.ts`.
   */
  learning?: boolean | LearningConfig

  /**
   * Show the model the `instructions` an MCP server returned in its `initialize` result (read from
   * the tools `connectMcpHttp` mounted): planner and executor system prompts, under a preamble
   * that marks them as third-party text, capped per server and in total. Default true. Set false
   * for servers you do not trust to write into a system prompt (see docs/security.md).
   */
  mcpInstructions?: boolean

  /** Prepended to every phase's system prompt. */
  systemPrompt?: string
  /** Override any phase prompt builder. */
  prompts?: Partial<Prompts>
  /** Serialize the host's current world state into prompt context (grounding). */
  describeState?: () => string | Promise<string>

  /**
   * Persist the transcript (e.g. new IndexedDBStore()). The last few messages
   * are also read back into the planner prompt, so follow-up goals can refer
   * to earlier turns.
   */
  memory?: ContextStore
  sessionId?: string
  /**
   * Checkpoint runs so a reload or a crashed tab does not lose finished work:
   * `new IndexedDBRunStore()` survives a reload, `new MemoryRunStore()` does not.
   * `run(goal, { resumeFromRunId })` then continues from the last checkpoint —
   * see `RunSnapshot` for exactly what is, and is not, kept.
   */
  persistence?: RunPersistence

  /** Hard cap on executed steps incl. replans (default 8). */
  maxIterations?: number
  /** Cap on tool-calling rounds inside one executor call, both modes (default 4). */
  maxStepsPerTask?: number
  /** Cap on replanner "revise" decisions per run (default 2). */
  maxRevisions?: number
  /** Cap on tool calls per run (default: unlimited). */
  maxToolCalls?: number
  /** Cap on the steps of one plan (default 8). */
  maxPlanSteps?: number
  /** Per-call timeout so a hang can't freeze a run (default 120000). */
  chatTimeoutMs?: number
  /** Legacy per-phase output caps; `limits.perCall` wins when both are set. */
  budgets?: PhaseBudgets
  /** Run-level token budgets (input / output / thinking / total) + per-call output caps. */
  limits?: TokenLimits
  temperature?: number

  /** Thinking for every stage: true, a level ('low'…'xhigh'), or { level, budgetTokens }. */
  thinking?: ThinkingSetting
  /** Per-stage thinking; a stage entry wins over `thinking`. */
  stageThinking?: Partial<Record<ThinkingStage, ThinkingSetting>>
  /**
   * Whether the model accepts images. Default: inferred (`supportsImages`) —
   * local/prompted models are text-only; unknown models are tried and a
   * refusal is reported as ImagesNotSupportedError.
   */
  vision?: boolean
  /** Per-kind override of what the model takes as attachments (`images` wins over `vision`). */
  inputs?: { images?: boolean; pdf?: boolean; files?: boolean }
  /** Provider prompt caching (default true): stable system prefixes + Anthropic breakpoints. */
  promptCaching?: PromptCachingSetting
  /** Context compaction (auto + manual `agent.compact()`); see CompactionConfig. */
  compaction?: CompactionConfig

  /** Master switch for the replan phase (default true). */
  replan?: boolean
  /** What triggers the replanner when it is on (default 'failure'). */
  replanAfter?: ReplanTrigger
  /** Write a final natural-language summary (default true). */
  synthesize?: boolean
  /**
   * Legacy: compress stored history past this many chars after each run
   * (0 = off). Used only when `compaction` is not set.
   */
  compressAfterChars?: number

  /** Verbosity: 'silent' | 'error' | 'warn' (default) | 'info' | 'debug'. */
  logLevel?: LogLevel
  /** Console-like sink the logs go to (default: the global console). */
  logger?: AgentLoggerSink
}

export interface ResolvedConfig {
  clientName: string
  sessionId: string
  toolMode: ToolMode
  toolSelectionStrategy: ToolSelectionStrategy
  toolSearchThreshold: number
  maxIterations: number
  maxStepsPerTask: number
  maxRevisions: number
  maxToolCalls: number
  maxPlanSteps: number
  chatTimeoutMs: number
  /**
   * Effective per-call output caps (limits.perCall over budgets, else a share of the window).
   * `0` = no cap for that stage: the host turned it off, or the stage thinks (see
   * `stageOutputCap`).
   */
  budgets: Required<PhaseBudgets> & { compaction: number }
  limits: TokenLimits
  temperature: number | undefined
  replan: boolean
  replanAfter: ReplanTrigger
  synthesize: boolean
  compressAfterChars: number
  compaction: ResolvedCompaction
  logLevel: LogLevel
}

// The default output cap of one call per phase is a share of the context window, so a small local
// model gets small caps (its window cannot hold a 3000-token answer next to the prompt) and a
// large one gets room. These shares give the long-standing numbers at the default 128k window:
// planner 800, executor 1200, replanner 400, synthesizer 3000, compaction 1024.
const BUDGET_SHARES = {
  planner: { num: 1, den: 160, min: 256, max: 2000 },
  executor: { num: 3, den: 320, min: 384, max: 8192 },
  replanner: { num: 1, den: 320, min: 192, max: 1500 },
  synthesizer: { num: 3, den: 128, min: 512, max: 8192 },
  compaction: { num: 1, den: 125, min: 256, max: 4096 },
} as const

const share = (window: number, s: { num: number; den: number; min: number; max: number }) =>
  Math.min(s.max, Math.max(s.min, Math.round((window * s.num) / s.den)))

/** The output cap of one call of a stage, and where it came from. */
export interface OutputCap {
  /** The cap in force; undefined = none (the provider's own maximum applies). */
  tokens?: number
  /** true when it came from the window, false when the host set it (or turned it off with 0). */
  derived: boolean
}

/**
 * The output cap of one call of `stage` — the same rules as the Node sibling's `stageOutputCap`.
 * What the host set (`limits.perCall`, then the legacy `budgets`) wins, and `0` is an explicit
 * "no cap". Otherwise a share of the context window — except for a stage that thinks: on OpenAI
 * and Gemini the reasoning counts against the cap, so a default sized for the answer alone would
 * leave a thinking model no room to write it (or to finish a tool call's arguments). A stage that
 * thinks keeps the provider's own limit unless the host sets one.
 */
export const stageOutputCap = (
  c: BrowserAgentConfig,
  stage: ThinkingStage,
  contextWindowTokens: number,
): OutputCap => {
  const set = c.limits?.perCall?.[stage] ?? c.budgets?.[stage]
  if (typeof set === 'number' && Number.isFinite(set)) {
    return { ...(set > 0 ? { tokens: Math.floor(set) } : {}), derived: false }
  }
  const thinking = resolveThinking(thinkingFor(stage, c.thinking, c.stageThinking))
  if (thinking.reasoning && thinking.reasoning !== 'none') return { derived: false }
  return { tokens: share(contextWindowTokens, BUDGET_SHARES[stage]), derived: true }
}

/**
 * The notice for a call the output cap cut off (`finishReason: 'length'`), else undefined. A
 * truncated answer is silent otherwise — the model just stops, and a tool call whose arguments
 * were cut fails to parse — and a default cap makes that a thing a host can hit without ever
 * having set a limit.
 */
export const outputCapNotice = (
  c: BrowserAgentConfig,
  stage: ThinkingStage,
  contextWindowTokens: number,
  finishReason: string | undefined,
): string | undefined => {
  if (finishReason !== 'length') return undefined
  const cap = stageOutputCap(c, stage, contextWindowTokens)
  if (!cap.tokens) return undefined
  return cap.derived
    ? `[${stage}] the model's output was cut off at ${cap.tokens} tokens, the default cap for this stage (a share of the ${contextWindowTokens}-token window); raise limits.perCall.${stage}, or set it to 0 for no cap`
    : `[${stage}] the model's output was cut off at limits.perCall.${stage} (${cap.tokens} tokens); raise it`
}

/**
 * The effective per-call output caps: what the host set (`limits.perCall`, then the legacy
 * `budgets`) wins; every other phase gets its share of the window, and a stage that thinks gets
 * none. `0` in the result means "no cap" (see `stageOutputCap`).
 */
export const resolveBudgets = (
  c: BrowserAgentConfig,
  contextWindowTokens: number,
): ResolvedConfig['budgets'] => ({
  planner: stageOutputCap(c, 'planner', contextWindowTokens).tokens ?? 0,
  executor: stageOutputCap(c, 'executor', contextWindowTokens).tokens ?? 0,
  replanner: stageOutputCap(c, 'replanner', contextWindowTokens).tokens ?? 0,
  // The final answer is the one call whose text the user reads: 400 cut a normal answer short.
  synthesizer: stageOutputCap(c, 'synthesizer', contextWindowTokens).tokens ?? 0,
  compaction:
    c.limits?.perCall?.compaction ??
    c.compaction?.summaryMaxTokens ??
    share(contextWindowTokens, BUDGET_SHARES.compaction),
})

export const resolveConfig = (c: BrowserAgentConfig): ResolvedConfig => ({
  clientName: c.clientName ?? 'agent-web',
  sessionId: c.sessionId ?? 'default',
  toolMode: c.toolMode ?? 'auto',
  toolSelectionStrategy: c.toolSelectionStrategy ?? 'auto',
  toolSearchThreshold: c.toolSearchThreshold ?? 40,
  maxIterations: c.maxIterations ?? 8,
  maxStepsPerTask: c.maxStepsPerTask ?? 4,
  maxRevisions: c.maxRevisions ?? 2,
  maxToolCalls: c.maxToolCalls ?? 0,
  maxPlanSteps: c.maxPlanSteps ?? 8,
  chatTimeoutMs: c.chatTimeoutMs ?? 120_000,
  budgets: resolveBudgets(c, resolveCompaction(c.compaction).contextWindowTokens),
  limits: c.limits ?? {},
  temperature: c.temperature,
  replan: c.replan ?? true,
  replanAfter: c.replanAfter ?? 'failure',
  synthesize: c.synthesize ?? true,
  compressAfterChars: c.compressAfterChars ?? 12_000,
  compaction: resolveCompaction(c.compaction),
  logLevel: c.logLevel ?? 'warn',
})
