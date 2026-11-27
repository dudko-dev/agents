import type { FetchLike, OAuthClientProvider } from '@modelcontextprotocol/client'
import type { ToolSet } from 'ai'
import type { RunControl } from './control.ts'
import type { IDecisionConfig, IDecisionEvent, IDecisionModel } from './decision.ts'
import type { PipelineEvent } from './pipeline-engine.ts'
import type { IEgressPolicy } from './safe-fetch.ts'
import type { ISearchConfig } from './web-search.ts'
import type { ISandboxConfig } from './sandbox-engine.ts'
import type { IMediaConfig, IRunFile } from './media.ts'
import type {
  McpElicitationHandler,
  McpElicitationOptions,
  McpElicitationReason,
  McpElicitationSchema,
} from './mcp-elicitation.ts'
import type { McpProtocolMode } from './mcp-shared.ts'
import type { ISubagentsConfig } from './subagent-dynamic-shared.ts'

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'google'
  | 'xai'
  | 'azure'
  | 'amazon-bedrock'
  | 'google-vertex'
  | 'deepseek'
  | 'gateway'
  | 'cloudflare'

export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug'

// 'all'           - executor receives the full filtered ToolSet on every step.
//                   Best for catalogs <= ~40 tools.
// 'plan-narrowed' - executor receives only tools listed in step.suggestedTools.
//                   Planner is required to populate suggestedTools when a step
//                   needs tools; empty means "reasoning-only step".
// 'search'        - executor starts each step with the built-in tools, the
//                   step's suggestedTools and the tools discovered earlier in
//                   the run, plus `find_tools`, which searches the whole
//                   catalogue and activates matches for the rest of the run.
//                   Built for catalogues of hundreds of tools.
// 'auto' (default) - 'all' while the filtered catalogue has at most
//                   `toolSearchThreshold` (default 40) tools, 'search' above.
export type ToolSelectionStrategy = 'all' | 'plan-narrowed' | 'search' | 'auto'

// The four LLM stages of the loop. The replanner shares the planner's model
// but has its own thinking / per-call budget knobs.
export type AgentStage = 'planner' | 'executor' | 'replanner' | 'synthesizer'

// Executor models by strength (config.executorTiers), weakest first.
export type ModelTier = 'light' | 'standard' | 'strong'

// What the planner marks a step with when tiers are configured: how hard the step is. It names
// the tier the step should run on (low -> light, medium -> standard, high -> strong).
export type StepComplexity = 'low' | 'medium' | 'high'

// Why a step started on its tier: 'planned' - the planner's complexity named a configured tier;
// 'default' - the planner did not mark the step, so it runs on `standard`; 'fallback' - the tier
// the planner named is not configured, so the nearest configured one runs it.
export type TierReason = 'planned' | 'default' | 'fallback'

// Why a step was retried on a stronger tier: the executor reported a blocker; it produced no
// text and no successful tool call; it kept calling a tool with arguments that did not parse;
// its output was cut by the per-call cap; or its model call failed.
export type EscalationReason =
  'blocked' | 'empty-result' | 'tool-arguments' | 'output-cut' | 'error'

// One escalation of a step, kept on its result.
export interface IStepEscalation {
  from: ModelTier
  to: ModelTier
  reason: EscalationReason
}

export interface IEscalationConfig {
  // Retries of ONE step on stronger tiers (each on the next stronger configured tier). Default 1.
  maxPerStep?: number
  // Escalations in one run, a resumed run included. Default 3.
  maxPerRun?: number
}

// Portable reasoning effort, mapped by the AI SDK onto each provider's own
// knob. 'none' explicitly disables thinking; 'provider-default' sends the
// provider's default level.
export type ThinkingLevel =
  'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface IThinkingConfig {
  // Default 'medium'.
  level?: ThinkingLevel
  // Exact token budget. Becomes provider-specific options for providers that
  // take a budget rather than an effort level (Anthropic, Google).
  budgetTokens?: number
  // Ask the provider to stream its thoughts (step.reasoning-delta /
  // final.reasoning-delta) where it supports that. Default true.
  includeThoughts?: boolean
}

// false / undefined -> send nothing (provider default); true -> 'medium';
// a bare level -> { level }.
export type ThinkingSetting = boolean | ThinkingLevel | IThinkingConfig

// Cumulative per-run token caps. Soft caps: checked between steps and at
// every executor LLM step boundary; once crossed the run stops executing
// steps and goes straight to synthesis (which still runs, capped by
// perCall.synthesizer).
export interface ITokenLimits {
  maxInputTokens?: number
  // Includes reasoning tokens.
  maxOutputTokens?: number
  maxReasoningTokens?: number
  // input + output. Falls back to the legacy top-level `maxTotalTokens`.
  maxTotalTokens?: number
  // maxOutputTokens for every single LLM call of a stage.
  perCall?: {
    planner?: number
    executor?: number
    replanner?: number
    synthesizer?: number
    compaction?: number
  }
}

export type TokenLimitKind = 'input' | 'output' | 'reasoning' | 'total'

// What a `budget.exceeded` event reports. For 'tool-calls', `tokens` carries
// the number of tool calls made.
export type BudgetKind = TokenLimitKind | 'tool-calls'

export interface ILimitBreach {
  kind: TokenLimitKind
  tokens: number
  cap: number
}

// Context compaction. Everything has a default; pass `{ auto: false }` to
// keep only the manual `agent.compact()` and the tool-output cap.
export interface ICompactionConfig {
  // Compact history (at run start) and trace (before each executor /
  // replanner / synthesizer call) when their estimate crosses the threshold.
  // Default true.
  auto?: boolean
  // Model context window, in tokens. Default 128_000.
  contextWindowTokens?: number
  // Compact when the estimated context - the fixed prompt (system, tool
  // definitions, skills), the history and the run's trace together - exceeds
  // this. Default: thresholdRatio of the window.
  thresholdTokens?: number
  // The same threshold as a share of the window, 0 < ratio <= 1 (default
  // 0.85). thresholdTokens wins when both are set.
  thresholdRatio?: number
  // History turns kept verbatim (default 4).
  keepRecentTurns?: number
  // Trace steps kept verbatim (default 3).
  keepRecentSteps?: number
  // Output cap of a summary call (default 1024).
  summaryMaxTokens?: number
  // Per tool result the MODEL sees (default 20_000; 0 = unlimited). The raw
  // output still lands in the trace and the events.
  maxToolOutputChars?: number
  // Inside one step's tool loop: once its context passes this many tokens,
  // the oldest tool results become one-line stubs (context editing). Default:
  // a quarter of the window; 0 = never.
  clearToolResultsAfterTokens?: number
  // Most recent tool results kept verbatim when clearing (default 3).
  keepToolResults?: number
}

// An agentskills.io-style skill: a name + a one-line description shown in an
// index, and instructions the agent loads only when the skill applies.
export interface ISkill {
  // [a-z0-9-]{1,64}
  name: string
  // When to use it (shown in the index).
  description: string
  // Full instructions (markdown body).
  content: string
  // Bundled text resources, skill-relative POSIX paths.
  files?: { path: string; content: string }[]
  // Set on a skill the AGENT wrote (config.learning); absent on the operator's own.
  origin?: ISkillOrigin
}

// Where a learned skill came from.
export interface ISkillOrigin {
  kind: 'learned'
  // Epoch ms of the last write.
  at: number
  // 1 for a new lesson, +1 each time the agent rewrites it.
  revision: number
  runId?: string
  // What the model said it consulted (URLs without query strings, doc names).
  sources?: string[]
  // Pages web_fetch read during the run that wrote it - recorded by the harness, not the model.
  fetched?: string[]
}

// Where learned skills are kept. MemorySkillStore (the open session) and DirSkillStore (a folder
// of SKILL.md files) are provided; bring your own for a database.
export interface ISkillStore {
  list: () => ISkill[] | Promise<ISkill[]>
  save: (skill: ISkill) => void | Promise<void>
  remove: (name: string) => boolean | Promise<boolean>
}

export interface ILearningConfig {
  // Default: a MemorySkillStore - lessons last as long as the agent.
  store?: ISkillStore
  // Cap on lessons (default 50).
  maxSkills?: number
  // Cap on one lesson's instructions, in characters (default 6000).
  maxSkillChars?: number
  // Add the "write down what you learned" guidance to the executor's prompt (default true).
  nudge?: boolean
}

// How tool calls are consented:
//   'autopilot'  - every call runs (default);
//   'ask-writes' - read-only tools run, anything else asks;
//   'ask-all'    - every call asks;
//   'read-only'  - read-only tools run, anything else is denied.
export type ToolApprovalMode = 'autopilot' | 'ask-writes' | 'ask-all' | 'read-only'

export type ToolPermission = 'allow' | 'ask' | 'deny'

export interface IToolApprovalRequest {
  // Unique per request.
  id: string
  toolName: string
  // The tool input AFTER inputSanitizer.
  input: unknown
  // The tool is known to be read-only (MCP readOnlyHint or markReadOnly).
  readOnly: boolean
  step?: IPlanStep
  runId?: string
  // Set when the call comes from a helper the model started (config.subagents.dynamic), not from
  // the run itself: the helper's id (as in its subagent.start event) and its depth.
  subagent?: { id: string; depth: number }
}

// What the gate hands `onRequest` beside the request.
export interface IToolApprovalContext {
  // Aborted when the question ends WITHOUT your answer: no decision within `timeoutMs`
  // (`signal.reason` is an Error named 'TimeoutError'), the run was stopped (the run's own
  // reason), or the handler failed. Take the prompt down then: an answer given later is ignored.
  // Never aborted once you have answered.
  signal: AbortSignal
}

// `remember: true` on an approval allows the tool for the rest of this agent
// instance's life without asking again.
export type ToolApprovalDecision =
  boolean | { approved: boolean; reason?: string; remember?: boolean }

export interface IToolApprovalConfig {
  // Default 'autopilot'. Switch at runtime with agent.setToolApprovalMode().
  mode?: ToolApprovalMode
  // Exact tool names or '*' globs, e.g. { 'github__delete_*': 'deny' }.
  // The most specific match wins (exact > longest glob) and beats the mode.
  rules?: Record<string, ToolPermission>
  // Called for every 'ask'. Without it an 'ask' is a denial.
  onRequest?: (
    req: IToolApprovalRequest,
    ctx: IToolApprovalContext,
  ) => ToolApprovalDecision | Promise<ToolApprovalDecision>
  // No decision within this many ms -> deny. Default 300_000 (TOOL_APPROVAL_TIMEOUT_MS). 0 or
  // Infinity: no bound - the question waits until the run is stopped; so does a value above
  // 2^31 - 1 (about 24.8 days, the most a timer holds). Negative or NaN: createAgent throws.
  // The only bound on the wait: the step's `llmTimeoutMs` (and a subagent's `timeoutMs`) stop
  // while a person decides.
  timeoutMs?: number
}

// true (default) / false, or options: Anthropic cache TTL and the OpenAI
// prompt cache key (default `${clientName}:${stage}`).
export type PromptCachingSetting = boolean | { ttl?: '5m' | '1h'; key?: string }

// One entry of the tool catalogue (agent.listTools()).
export interface IToolCatalogEntry {
  name: string
  description: string
  // MCP server name, or '<native>' for config.tools.
  server?: string
  // Known to be read-only (MCP annotations.readOnlyHint, or markReadOnly()).
  readOnly?: boolean
}

// Remote MCP server reached over StreamableHTTP. (Legacy HTTP+SSE servers -
// the 2024-11-05 transport with a separate /sse endpoint - are NOT supported;
// point this at a StreamableHTTP endpoint.)
export interface IMcpHttpServerConfig {
  url: string
  headers?: Record<string, string>
  // Called at connect time (and on reconnect) to provide fresh request headers.
  // Use this when tokens rotate; combine with `agent.reconnect()` to refresh
  // an expired Bearer. Note that it is resolved ONCE per connect - for tokens
  // that expire mid-run, use `authProvider` instead.
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
  // Full OAuth 2.1: the SDK discovers the authorization server (RFC 9728),
  // registers dynamically when the provider supports it (RFC 7591), attaches
  // the access token, and REFRESHES it on a 401 before retrying the request.
  // See `createNodeOAuthProvider` for a file-backed implementation, or supply
  // any OAuthClientProvider of your own.
  authProvider?: OAuthClientProvider
  // Custom fetch for every HTTP request the transport and the OAuth flow make:
  // corporate proxies, mTLS agents, instrumentation.
  fetch?: FetchLike
  // A server that does not finish connect + tools/list within this many ms
  // is reported as failed and closed; the others still mount. Overrides the
  // top-level mcpConnectTimeoutMs. Default 30_000; 0 disables.
  connectTimeoutMs?: number
  // Which revisions of the protocol this connection may use. Default 'legacy': the 2025
  // revisions (the `initialize` handshake), exactly what was sent before this option existed.
  // 'auto' asks the server first (`server/discover`) and speaks 2026-07-28 to one that offers it,
  // the 2025 handshake to any other; 'modern' is 2026-07-28 only, and a server that does not
  // offer it fails the connect. Decided once, at connect: a tool call is never retried in another
  // revision. On 2026-07-28 there is no session, a tool-list change arrives over a
  // `subscriptions/listen` stream this connector opens (no automatic re-listen when it drops),
  // and an `input_required` result (elicitation) fails the call. See the README, "MCP protocol
  // revision".
  protocol?: McpProtocolMode
}

// Local MCP server spawned as a child process. The transport speaks JSON-RPC
// over the process's stdin/stdout. `stderr` of the child is inherited by
// default so server logs are visible in the agent's terminal.
export interface IMcpStdioServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  // See IMcpHttpServerConfig.connectTimeoutMs.
  connectTimeoutMs?: number
  // See IMcpHttpServerConfig.protocol. Over stdio, 'auto' and 'modern' ask on a SECOND,
  // short-lived process started from the same command (a server that exits on a request it does
  // not know must not take the session's process with it): the command runs twice per connect.
  protocol?: McpProtocolMode
}

// Discriminated union: callers pick HTTP or stdio per server. Existing
// callers passing { url, headers? } typecheck unchanged as IMcpHttpServerConfig.
export type IMcpServerConfig = IMcpHttpServerConfig | IMcpStdioServerConfig

// Per-stage override for the planner / synthesizer. Each field is optional
// and inherits from the top-level IAgentConfig defaults when omitted, so the
// common case (one provider, one key, one model) stays a single block.
//
// Cross-provider override caveat: setting `providerType` without `apiKey`
// throws at createAgent time - inheriting a key across providers is almost
// always a configuration mistake (different vendors, different keys).
export interface IAgentStageOverride {
  providerType?: ProviderType
  baseURL?: string
  apiKey?: string
  model?: string
  // Escape hatch for provider-specific factory options that don't fit the
  // baseURL/apiKey shape: Azure `apiVersion` / `resourceName`, Bedrock
  // `region` / `accessKeyId` / `secretAccessKey`, Vertex `project` /
  // `location` / `googleAuthOptions`, Cloudflare `accountId`, and so on.
  // The map is spread into the SDK's create* call AFTER baseURL/apiKey, so
  // callers can also override those when needed. Inherits from the top-level
  // config.providerOptions when omitted.
  providerOptions?: Record<string, unknown>
}

export interface IAgentConfig {
  clientName: string
  providerType: ProviderType
  // Optional for providers with a default endpoint (openai, anthropic, google,
  // xai, deepseek, gateway, amazon-bedrock, google-vertex, cloudflare).
  // Required for `openai-compatible` (point at a self-hosted server) and
  // `azure` (point at the Azure OpenAI deployment URL).
  baseURL?: string
  apiKey: string
  model: string
  // Provider-specific extras forwarded to the SDK factory. See
  // IAgentStageOverride.providerOptions for details. Each per-stage override
  // can supply its own block; when absent, this top-level value is used.
  providerOptions?: Record<string, unknown>
  // Per-stage overrides. Use these to put planner on a small/cheap model
  // while running synthesis on a larger one, OR to mix providers entirely
  // (e.g. Gemini planner, Anthropic synthesizer). Each block is independent;
  // omit it to inherit every default from the top level.
  planner?: IAgentStageOverride
  synthesizer?: IAgentStageOverride
  // Executor models by tier. Off unless `light` or `strong` is set: with neither, nothing about a
  // run changes. Each block is a stage override like `planner` (omitted fields inherit the top
  // level); `standard` is the top-level model unless overridden here. With tiers on, the planner
  // marks every step with a `complexity` and the executor runs it on that tier's model (low ->
  // light, medium -> standard, high -> strong); a tier that is not configured falls back to the
  // nearest configured one (the stronger of two equally near). `compaction.contextWindowTokens`
  // must be the window of the SMALLEST of these models: every step is fitted to it.
  executorTiers?: Partial<Record<ModelTier, IAgentStageOverride>>
  // When a step fails in a way a stronger model could fix (a blocker, no result, tool arguments
  // that keep failing to parse, output cut by the cap, a failed model call), retry it on the next
  // stronger configured tier BEFORE the replanner is consulted. The retry continues the step: it
  // is shown what the first attempt already did, and a write that already succeeded is not
  // executed again. Never on a stop, refused credentials (401 / 403), a rate limit (429), a spent
  // budget or a tool the user denied. Default: on when `executorTiers` is on (false turns it off);
  // without tiers it does nothing.
  escalation?: boolean | IEscalationConfig
  // Deprecated single-string shortcuts. Equivalent to
  // `planner: { model }` / `synthesizer: { model }`. Kept for back-compat
  // with the pre-stage-override API; prefer the override blocks for new code.
  // If both are set for the same stage, the block wins.
  /** @deprecated use `planner: { model }` */
  plannerModel?: string
  /** @deprecated use `synthesizer: { model }` */
  synthesizerModel?: string
  mcpServers: Record<string, IMcpServerConfig>
  // Outbound requests the MODEL may make (the web_fetch tool). Off unless set. `true` = any public
  // host over https; an object narrows or widens that (allow / deny lists, private networks, ...)
  // - see IEgressPolicy. Requests go through createSafeFetch: own DNS lookup, private / metadata
  // ranges refused, redirects re-checked, size and time bounded. It does not govern the provider's
  // own API calls or the MCP servers you configure - those are your configuration, not the model's.
  egress?: boolean | IEgressPolicy
  // Let the model SEARCH the web (the web_search tool: a short list of title / url / snippet). Off
  // unless set. The library ships no key: pass a function (`engine` - any search API) or name
  // the built-in provider (`provider: 'google'` + a Gemini `apiKey`: Google Search through
  // Gemini grounding, which spends model tokens). The provider's request reaches that API's
  // host only, through createSafeFetch; with `egress` set, results the model could not fetch are
  // left out. Works without `egress` (then there is no web_fetch to open a link). See ISearchConfig.
  search?: ISearchConfig
  // A decision model: a small, fast model that answers a closed question with one option and a
  // probability instead of writing text (see decision.ts). Off unless set. Where it is confident
  // it replaces the replanner's continue / finish call and a pipeline node's route call; below
  // `decision.confidenceThreshold`, on an error, a timeout or an answer that is not an option,
  // the ordinary model call runs exactly as without it. Never consulted for tool approval or
  // egress.
  decisionModel?: IDecisionModel
  // The threshold (default 0.8), the timeout (default 5000 ms) and which questions it is asked.
  decision?: IDecisionConfig
  // Let the agent keep a notebook: it writes lessons it learned (problem -> what worked) as skills,
  // visible in the SKILLS index and loadable for the rest of the session. `true` = in memory (as
  // long as the agent lives); give a store to keep them (DirSkillStore). Saving is a write for
  // tool approval. Knowledge only - never policy. See src/learning.ts.
  learning?: boolean | ILearningConfig
  // Let the agent RUN JavaScript it wrote (the `run_js` tool) and read the output. Off unless set:
  // with it off the tool does not exist, the engine is never loaded and no worker is started.
  // `true` = the defaults; an object sets the limits - see ISandboxConfig. The guest runs in
  // QuickJS compiled to WebAssembly (the optional peer `quickjs-emscripten`: createAgent throws
  // when it is not installed) inside a worker thread that is killed at the deadline. It has no
  // network, no files, no process and no host modules. A run is a write for tool approval.
  // See src/sandbox.ts.
  sandbox?: boolean | ISandboxConfig
  // Image generation, speech and transcription, each as a tool that exists only when its model
  // is set: `imageModel` -> generate_image, `speechModel` -> generate_speech,
  // `transcriptionModel` -> transcribe_audio and audio attachments (`run({ files })`, transcribed
  // once; the model reads the text). Off unless set. Generated files are written under the run's
  // directory (or `media.dir`) and the model gets a path, never the bytes. Each call is a write
  // for tool approval, counts in `usage.mediaCalls`, and a run may make `media.maxCalls` of them
  // (default 8). Prompts, spoken text and audio leave for the provider of that model. See
  // src/media.ts.
  media?: IMediaConfig
  // Subagents the MODEL starts itself. `dynamic: true` (or an object of limits) mounts the
  // spawn_subagent tool: the model gives a sub-task, an optional role and optionally a subset of
  // its own tools by name; a helper agent runs the normal loop on it and its answer is the tool
  // result. Off unless set: with it off the tool does not exist and no prompt mentions it. A helper
  // can only have LESS than the run that starts it (its tools, a share of what is left of its
  // budgets, the same models, approval mode and rules); its spend counts against this run's limits.
  // Subagents the HOST defines are tools (createSubagentTool) and need no switch. See
  // IDynamicSubagentsConfig and src/subagent-dynamic.ts.
  subagents?: ISubagentsConfig
  // Native AI-SDK tools registered alongside MCP-discovered tools. Names
  // must not collide with any MCP-prefixed tool ("server__tool"); createAgent
  // throws on conflict. Native tools bypass outputSanitizer/inputSanitizer
  // since the caller already controls their implementation.
  tools?: ToolSet
  availableTools?: string[]
  excludedTools?: string[]
  // Cap on executed steps across the run (every step counts, including those
  // executed after a "revise"). Guards against runaway loops.
  maxIterations: number
  // Cap on LLM steps inside a single executor call (multi-step tool calling).
  maxStepsPerTask: number
  // Cap on the number of "revise" decisions the replanner can make per run.
  maxRevisions?: number
  // What makes the LLM replanner run after a step (it never runs after the
  // last planned step):
  //   'failure' (default) - the step was blocked, or a tool call failed and
  //     stayed failed (a later successful call to the same tool within the
  //     step counts as self-corrected);
  //   'always' - after every step, e.g. when the host surfaces problems to
  //     the replanner through systemPrompt/domain context (costs one extra
  //     LLM call per step);
  //   predicate - decides per step result; may be async and close over host
  //     state. A predicate that throws, rejects, or outlives llmTimeoutMs /
  //     the run signal falls back to the 'failure' rule, so a buggy or hung
  //     predicate can never stall the run.
  replanAfter?: ReplanTrigger
  // Soft cap on cumulative tokens; checked between steps and triggers an
  // early jump to synthesis when crossed. Legacy shortcut for
  // `limits.maxTotalTokens` (which wins when both are set).
  maxTotalTokens?: number
  // Cumulative per-run token caps + per-call output caps. See ITokenLimits.
  limits?: ITokenLimits
  // Cap on tool calls per run (across steps). Once reached, further calls
  // fail with "tool-call budget exhausted" and the run goes to synthesis.
  maxToolCalls?: number
  // Hard cap on the number of steps in a plan (initial and revised).
  // Default 8.
  maxPlanSteps?: number
  // Thinking / reasoning for every stage. Per-stage entries in stageThinking
  // win. Compaction calls never think.
  thinking?: ThinkingSetting
  stageThinking?: Partial<Record<AgentStage, ThinkingSetting>>
  // History / trace compaction and the model-visible tool-output cap.
  compaction?: ICompactionConfig
  // Skills the planner can pick and the executor can load on demand.
  skills?: ISkill[]
  // Tool-call consent. Default: autopilot (every call runs).
  toolApproval?: IToolApprovalConfig
  // 'auto' switches to 'search' above this many tools. Default 40.
  toolSearchThreshold?: number
  // Default connect + tools/list timeout for every MCP server (each server
  // can override it). Default 30_000; 0 disables.
  mcpConnectTimeoutMs?: number
  // MCP elicitation: a server may ask the user for input in the middle of a tool call (a form,
  // or - with `elicitation.url` - a link to open), and this callback answers: accept with the
  // form's values, decline, or cancel. The HOST decides, never the model: the question is not
  // shown to the model and the answer goes only to the server that asked - not into the model's
  // context, an event, a log, a trace or a run snapshot. Without the callback the capability is
  // not declared, a server cannot ask, and nothing is sent that was not sent before. The
  // server's message and form are third-party text: cleaned, capped and restricted to a flat
  // form before the callback sees them; the answer is checked against the form before it is
  // sent. A callback that throws or does not answer in time cancels the question and fails the
  // tool call; nothing is retried. See the README, "MCP elicitation".
  onElicitation?: McpElicitationHandler
  // Its settings: `timeoutMs` (default 300_000: a human is answering; the step's `llmTimeoutMs`
  // stops while a question waits; 0 or Infinity = no limit of its own), `maxPerToolCall` (5),
  // `maxPerRun` (20), `url` (also accept URL mode; default false), `subagents` (let a call made
  // by a spawn_subagent helper ask too; default false: a helper's question is cancelled without
  // the callback being called).
  elicitation?: McpElicitationOptions
  // Show the model the `instructions` a connected MCP server returned in its
  // initialize result (planner and executor system prompts, under a preamble
  // that marks them as third-party text; capped per server and in total).
  // Default true. Set false for servers you do not trust to write into a
  // system prompt: the text is a prompt-injection surface.
  mcpInstructions?: boolean
  // Provider prompt caching. Default true: run-stable system prompts, an
  // Anthropic cache breakpoint on them, and an OpenAI prompt cache key.
  promptCaching?: PromptCachingSetting
  // Time limit of one model call - for the executor, of a whole step: its rounds and its tool
  // calls (default: none). It does not run while a tool call of the step waits for a person (a
  // tool approval, an MCP elicitation): the step goes on with the time it had left once the
  // person has answered. Those waits have bounds of their own (`toolApproval.timeoutMs`,
  // `elicitation.timeoutMs`), and stopping the run ends them at once.
  llmTimeoutMs?: number
  llmMaxRetries?: number
  // Hard cap on the number of concurrent agent.run() calls a single agent
  // instance will accept. When the cap is reached, further run() calls reject
  // synchronously with a ConcurrencyLimitError. Default: unlimited. The cap
  // is intentionally a throw rather than a queue - applications that need
  // back-pressure should run a queue on their side.
  maxConcurrentRuns?: number
  // Optional facade for durable run snapshots. The agent itself never reads
  // the data back; implementations can persist for audit, debugging, or
  // resume-after-crash workflows.
  persistence?: IPersistence
  toolSelectionStrategy?: ToolSelectionStrategy
  // Sanitize an input the LLM passed to a tool BEFORE the call is dispatched
  // and BEFORE the step.tool-call event is emitted. Use to redact secrets the
  // model may have copied from prior context (auth tokens, PII) so they don't
  // reach external services or event consumers / log sinks.
  //
  // CONTRACT: must be IDEMPOTENT. The sanitizer is applied twice per call -
  // once in the executor before event emission, once in the MCP wrapper
  // before dispatch - so calling f(f(x)) must equal f(x). Typical
  // implementations (regex redaction, key stripping, value masking) satisfy
  // this naturally. Throwing replaces the input with a safe placeholder string
  // and the call proceeds, so the model sees a deterministic failure rather
  // than a hang.
  inputSanitizer?: (toolName: string, input: unknown) => unknown | Promise<unknown>
  outputSanitizer?: (toolName: string, output: unknown) => unknown | Promise<unknown>
  logLevel: LogLevel
  systemPrompt?: string
  // Root directory for per-run sandbox subdirs. Each agent.run() call gets
  // its own <sandboxRoot>/<runId>/ folder, created lazily the first time a
  // tool writes a binary blob. Defaults to <os.tmpdir()>/agent-sandbox.
  // Tools (native or via MCP) can reach the directory via getCurrentRunSandbox().
  sandboxRoot?: string
  // When true, the per-run sandbox directory is NOT removed after the run
  // completes. Useful for debugging or post-run inspection. Default false.
  keepSandbox?: boolean
  // When true, createAgent throws if every configured MCP server failed to
  // connect (i.e. the agent would start with zero tools). Defaults to false:
  // the agent starts and the failure is surfaced via 'log' events at error
  // level.
  failOnNoTools?: boolean
}

export interface IConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface IUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  // Optional in the type for back-compat; the agent always fills them.
  // Part of outputTokens.
  reasoningTokens?: number
  // Input tokens served from the provider's prompt cache (part of inputTokens).
  cachedInputTokens?: number
  // Input tokens written to the provider's prompt cache.
  cacheWriteTokens?: number
  // What the media models (config.media) were asked for - calls (failed ones included), images
  // written, characters sent to the speech model, seconds of audio transcribed. Not tokens and
  // not part of the counts above. Absent until a media model is called (see IMediaUsage).
  mediaCalls?: number
  imagesGenerated?: number
  speechCharacters?: number
  transcriptionSeconds?: number
  // Calls made to `config.decisionModel`. A call is not a token: what the API billed for it
  // (when it says) is in the token fields, the number of calls is here. Absent when zero.
  decisionCalls?: number
}

export interface IPlanStep {
  id: string
  description: string
  expectedOutcome: string
  suggestedTools?: string[]
  // Set by the planner pipeline (not the LLM) when the step originally listed
  // suggestedTools but every name was unknown. Signals to the executor that
  // the step does want tools, even though suggestedTools ended up empty -
  // narrowed mode then falls back to the full toolset rather than running the
  // step with zero tools.
  requiresTools?: boolean
  // How hard the planner rated the step. Only when config.executorTiers is on.
  complexity?: StepComplexity
}

export interface IPlan {
  thought: string
  steps: IPlanStep[]
  // Names of configured skills the planner picked for this request. Their
  // instructions are injected into the executor / replanner / synthesizer.
  skills?: string[]
}

export interface IStepResult {
  step: IPlanStep
  summary: string
  toolCalls: { name: string; input: unknown; output: unknown; ok: boolean }[]
  durationMs: number
  // True when the executor signalled it could not complete the step (via the
  // [BLOCKER] sentinel in its reply). The replanner is invoked on this signal.
  blocked: boolean
  // Only when config.executorTiers is on: the tier (and its model id) the step FINISHED on, and
  // the escalations that led there, in order. `toolCalls` then holds every attempt's calls.
  tier?: ModelTier
  model?: string
  escalations?: IStepEscalation[]
}

// When the LLM replanner is consulted after a step; see IAgentConfig.replanAfter.
export type ReplanTrigger =
  'failure' | 'always' | ((result: IStepResult) => boolean | Promise<boolean>)

// 'user-message': the replanner ran because the user sent a message mid-run (RunControl.send),
// not because a step failed or the replan trigger fired.
// 'decision-model': `config.decisionModel` decided, and the replanner was not called.
export type ReplanCause =
  'last-step' | 'clean-step' | 'llm-decision' | 'user-message' | 'decision-model'

// Phase of a `usage` event. 'compact' is a compaction summary call;
// 'subagent' is usage a subagent tool spent (it counts against this run's
// limits like any other).
export type UsagePhase =
  | 'plan'
  | 'execute'
  | 'replan'
  | 'synthesize'
  | 'compact'
  | 'subagent'
  // A call to `config.decisionModel` (usage.decisionCalls, plus the tokens its API reported).
  | 'decision'
  // A call to an image / speech / transcription model (config.media): its `usage` carries the
  // media fields and zero tokens.
  | 'media'
  // A web_search through the google provider (config.search): the grounding call is a model
  // call, and these are the tokens its API reported.
  | 'search'

type AgentEventBody =
  | { type: 'plan.thought-delta'; delta: string }
  // Fires once per planner step as soon as the structured-output stream has
  // emitted enough fields for the step to be coherent (description present).
  // The step may still be revised before plan.created lands - prefer this
  // event for incremental UI hints, and plan.created for the canonical plan.
  | { type: 'plan.step-added'; step: IPlanStep; index: number }
  | { type: 'plan.created'; plan: IPlan }
  | { type: 'plan.revised'; plan: IPlan; reason: string }
  // tier / model / tierReason: only when config.executorTiers is on - the tier the step starts
  // on, its model id, and why that tier (see TierReason).
  | {
      type: 'step.start'
      step: IPlanStep
      index: number
      tier?: ModelTier
      model?: string
      tierReason?: TierReason
    }
  // The step failed on `from` and is retried on the stronger tier `to` (config.escalation);
  // `model` is the model id of `to`. Fires between the step's start and its completion.
  | {
      type: 'step.escalated'
      step: IPlanStep
      from: ModelTier
      to: ModelTier
      model: string
      reason: EscalationReason
    }
  | { type: 'step.text-delta'; step: IPlanStep; delta: string }
  // The model's thoughts, when thinking is on and the provider streams them.
  | { type: 'step.reasoning-delta'; step: IPlanStep; delta: string }
  | { type: 'step.tool-call'; step: IPlanStep; name: string; input: unknown }
  | { type: 'step.tool-result'; step: IPlanStep; name: string; output: unknown; ok: boolean }
  | { type: 'step.complete'; step: IPlanStep; result: IStepResult }
  | {
      type: 'replan.decision'
      mode: 'continue' | 'revise' | 'finish'
      reason: string
      cause: ReplanCause
      // Set when the replanner call itself failed (unparseable output, a schema mismatch, the
      // provider down after its retries) and `mode: 'continue'` is the fallback, not the model's
      // decision. The failure is the `error` event (phase 'replan') just before this one.
      failed?: true
      // Set with cause 'decision-model': the probability the decision model gave its choice.
      confidence?: number
    }
  // `config.decisionModel` was asked a question: its answer was used (`accepted`), or the
  // ordinary model call ran and `reason` says why.
  | IDecisionEvent
  | { type: 'final.text-delta'; delta: string }
  | { type: 'final.reasoning-delta'; delta: string }
  | { type: 'final'; text: string }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'usage'; phase: UsagePhase; usage: IUsage }
  | {
      type: 'retry'
      phase: 'plan' | 'execute' | 'replan' | 'synthesize'
      attempt: number
      error: string
    }
  // A run-level cap was crossed; the run stops executing steps and
  // synthesizes. For kind 'tool-calls', `tokens` is the tool-call count.
  | { type: 'budget.exceeded'; kind: BudgetKind; tokens: number; cap: number }
  | {
      type: 'context.compacted'
      // tool-results = stale results inside a step's tool loop.
      scope: 'history' | 'trace' | 'tool-results'
      beforeTokens: number
      afterTokens: number
    }
  | { type: 'skill.activated'; name: string; by: 'plan' | 'tool' }
  // find_tools found and activated these tools (search strategy).
  | { type: 'tools.discovered'; step: IPlanStep; query: string; names: string[] }
  // Only when the agent actually asks (onRequest is called).
  | {
      type: 'tool.approval-requested'
      id: string
      name: string
      input: unknown
      readOnly: boolean
      step?: IPlanStep
      // Set when a helper the model started is asking (see IToolApprovalRequest.subagent).
      subagent?: { id: string; depth: number }
    }
  // automatic: true for rule / mode / timeout denials nobody decided on.
  // Automatic ALLOWs emit nothing, to keep the stream quiet.
  | {
      type: 'tool.approval-resolved'
      id: string
      name: string
      approved: boolean
      reason?: string
      automatic: boolean
    }
  // An MCP server asked the user for input during a tool call (`onElicitation` is being called).
  // `message`, `requestedSchema` and `url` are the SERVER's text: cleaned and capped, for a UI
  // to show - never instructions.
  | {
      type: 'mcp.elicitation-requested'
      id: string
      server: string
      // The tool call that asks: the tool's name as the model called it.
      tool: string
      mode: 'form' | 'url'
      message: string
      requestedSchema?: McpElicitationSchema
      url?: string
      step?: IPlanStep
      // Set when a helper the model started is the one whose call asks.
      subagent?: { id: string; depth: number }
    }
  // The question was answered. Never carries a value the user entered: `fields` are the NAMES
  // of the fields an accepted form was answered with. automatic: true when nobody decided (a
  // guard, a cap, a timeout, a failed handler, a stopped run) - `reason` says which, the tool
  // call fails, and no 'mcp.elicitation-requested' may have preceded it.
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
  // `profile` is set when the parent chose one of the subagent's named profiles for this call.
  // The tree: `parentId` is the id of the subagent that made the call, or the `runId` of the run
  // when the run itself made it; `depth` is 1 for the run's own subagents, 2 for theirs, ...
  // `dynamic` marks a helper the model started with spawn_subagent (config.subagents.dynamic):
  // `role` is what the model wrote for it, `tools` the tool names it was given.
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
  // A child event, forwarded verbatim (long strings clipped).
  | { type: 'subagent.event'; id: string; name: string; event: AgentEvent }
  | { type: 'subagent.complete'; id: string; name: string; text: string; usage: IUsage }
  // `stopped` is set when the user stopped this subagent (RunControl.stopSubagent), as
  // opposed to it failing.
  // `usage`: what a dynamic helper had spent when it failed (already charged to the parent).
  | {
      type: 'subagent.error'
      id: string
      name: string
      error: string
      stopped?: boolean
      usage?: IUsage
    }
  // A message sent with RunControl.send is waiting for the next boundary.
  | { type: 'message.queued'; id: string; text: string }
  // The message reached the model. 'round' = between tool-calling rounds inside a step, so
  // the rest of that step can act on it (the replanner weighs it at the end of the step);
  // 'step' = at a step boundary, where it forces the replanner to look at the plan;
  // 'final' = just before the answer is written.
  | { type: 'message.delivered'; id: string; text: string; at: 'round' | 'step' | 'final' }
  // A request of the web_fetch tool, or of web_search to its search API: allowed or refused by the
  // egress policy. `url` is origin and path only (a query string can carry a secret or the query).
  | { type: 'egress.request'; url: string; allowed: boolean; status?: number; reason?: string }
  // The agent wrote (or rewrote) a lesson. `sources` = what it named plus the pages fetched that run.
  | {
      type: 'skill.learned'
      name: string
      description: string
      update: boolean
      chars: number
      sources: string[]
    }
  | { type: 'skill.forgotten'; name: string }
  // A media tool (config.media) wrote a file: `path` is where (absolute), `mediaType` what its
  // bytes are, `bytes` its size. The bytes themselves are in the file, never in an event.
  | {
      type: 'media.generated'
      kind: 'image' | 'speech'
      path: string
      mediaType: string
      bytes: number
      model: string
      step?: IPlanStep
    }
  // An audio file was transcribed: one the user attached to the run ('attachment') or one the
  // model asked about ('tool'). `text` is what the model reads of it (cleaned and capped).
  | {
      type: 'media.transcribed'
      source: 'attachment' | 'tool'
      name: string
      text: string
      language?: string
      durationInSeconds?: number
      model: string
    }
  | { type: 'revisions.exceeded'; cap: number }
  | { type: 'error'; error: Error; phase: 'plan' | 'execute' | 'replan' | 'synthesize' | 'init' }
  // A pipeline's own events (createPipeline): the run, each node visit, each edge decision.
  | PipelineEvent

// runId is auto-populated at emit time from AsyncLocalStorage. Consumers that
// multiplex events across concurrent runs on the same agent should filter by it.
// nodeId / visit are set on the events a pipeline forwards from a node's agent (and on the
// pipeline.node.* events themselves).
export type AgentEvent = AgentEventBody & { runId?: string; nodeId?: string; visit?: number }

export type EventHandler = (event: AgentEvent) => void

// Synchronous callback fired right before each plan step starts executing.
// The caller can call `abort()` to cancel JUST that step (the rest of the
// run continues - the cancelled step records as blocked, the replanner is
// invoked next). This is distinct from the run-level AbortSignal, which
// terminates the whole run.
export interface IStepStartInfo {
  step: IPlanStep
  index: number
  abort: () => void
}

export interface IAgentRunOptions {
  // Required for fresh runs; ignored when resumeFromRunId is set (the
  // snapshot's input wins so the resumed run is deterministic against the
  // original prompt).
  input: string
  history?: IConversationTurn[]
  // Audio the user attached (needs config.media.transcriptionModel; anything else is refused):
  // each file is transcribed once and its text is put under the input, marked as the content of
  // the user's file. Ignored on resume (the saved input already carries the transcripts).
  files?: IRunFile[]
  signal?: AbortSignal
  onEvent?: EventHandler
  onStepStart?: (info: IStepStartInfo) => void
  // Resume a previously persisted run. Requires config.persistence.loadRun
  // to be implemented and the snapshot to be in a non-terminal state (i.e.
  // not 'complete'). The runner re-uses the saved runId, plan, trace, and
  // counters; the saved sandbox dir is recreated lazily but its prior
  // contents are gone unless keepSandbox was true on the original run.
  resumeFromRunId?: string
  // Steer the run while it goes: control.send(text) puts a message in front of the model at
  // the next boundary, control.stopSubagent(id) stops one subagent. Make it with
  // createRunControl(); one control per run.
  control?: RunControl
}

export interface IAgentRunResult {
  text: string
  plan: IPlan
  trace: IStepResult[]
  iterations: number
  usage: IUsage
  // Set when the run compacted the history it was given (the caller's array
  // is never mutated). Persist it in place of the old history.
  compactedHistory?: IConversationTurn[]
  // Set when the run was given a `control`: the messages sent with it that the run never got
  // to show the model (they arrived while the answer was being written). Send them as the
  // next run. A run that throws (abort, failure) cannot return it - read control.pending().
  undelivered?: string[]
}

// Snapshot of a run handed to IPersistence hooks. Each hook receives the
// fields most relevant at its lifecycle point; consumers should treat these
// as read-only.
//
// Resume semantics: stepIndex / iterations / revisions are the loop counters
// at the moment the snapshot was taken. On resume, the runner picks up at
// trace.length and inherits iterations/revisions so the per-run caps still
// apply across crashes.
export interface IRunSnapshot {
  runId: string
  startedAt: number
  // 'executing' is the only non-terminal status the runtime writes; the
  // others are written exactly once when the run resolves. ('planning' is
  // intentionally omitted - we never persist before the plan is in hand,
  // so there's no row in that state to query for.)
  status: 'executing' | 'complete' | 'failed' | 'cancelled'
  input: string
  history?: IConversationTurn[]
  plan?: IPlan
  trace: IStepResult[]
  usage: IUsage
  // Loop counters at snapshot time. iterations counts every executed step
  // (including those replaced by a revise), revisions counts replan revises.
  // stepIndex is the NEXT step index to execute within `plan.steps`; on
  // resume it should equal trace.length when the saved plan is still in play.
  stepIndex: number
  iterations: number
  revisions: number
  text?: string
  error?: string
  completedAt?: number
  // Running summary of trace[0, traceSummaryUpTo) once trace compaction has
  // kicked in; prompts render it in place of those steps.
  traceSummary?: string
  traceSummaryUpTo?: number
  // Skills activated so far (by the plan or by load_skill).
  activeSkills?: string[]
  // Tool calls made so far (counts against maxToolCalls on resume).
  toolCallCount?: number
  // What the user said while the run was going (RunControl.send), in order, and whether the
  // replanner has already weighed each. A resumed run keeps them: otherwise it would forget a
  // correction the user had already made.
  userUpdates?: { text: string; reconciled: boolean }[]
  // Escalations so far (counts against escalation.maxPerRun on resume).
  escalations?: number
  // Helpers the model started so far (counts against subagents.dynamic.maxChildren on resume).
  subagentsSpawned?: number
}

// Optional persistence facade. Write hooks fire at run start, after each
// step, and at run completion. Implementations decide what (if anything) to
// durably store. loadRun is consulted only when the caller asks for a resume
// via IAgentRunOptions.resumeFromRunId.
//
// Write hooks: errors are caught and logged at warn level - persistence
// failures must NEVER crash a run. Reads in loadRun, by contrast, propagate
// to the caller (a missing snapshot is a configuration / programmer error).
export interface IPersistence {
  onRunStart?: (snapshot: IRunSnapshot) => void | Promise<void>
  onStepComplete?: (snapshot: IRunSnapshot) => void | Promise<void>
  onRunComplete?: (snapshot: IRunSnapshot) => void | Promise<void>
  // Optional read hook used by agent.run({ resumeFromRunId }). Returns the
  // saved snapshot, or null when not found. Implementations that don't want
  // to support resume can simply omit this method.
  loadRun?: (runId: string) => IRunSnapshot | null | Promise<IRunSnapshot | null>
}
