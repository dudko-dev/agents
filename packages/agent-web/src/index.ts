// ── Agent ──────────────────────────────────────────────────────────────────
export { createAgent } from './agent/runner.js'
export type {
  Agent,
  AppSamplingOptions,
  AppSamplingRequest,
  AppToolCallRequest,
  CompactOptions,
  CompactResult,
  RunOptions,
  RunResult,
} from './agent/runner.js'
// Steer a run while it goes: send a message, stop one subagent.
export { createRunControl } from './agent/control.js'
export type { RunControl, SubagentInfo } from './agent/control.js'
export type {
  EscalationConfig,
  EscalationReason,
  IPlan,
  IPlanStep,
  IStepEscalation,
  IStepResult,
  IToolCall,
  IUsage,
  ModelTier,
  StepComplexity,
  TierReason,
} from './agent/loop-types.js'
export {
  PlanSchema,
  PlanStepSchema,
  ReplanSchema,
  TieredPlanSchema,
  TieredPlanStepSchema,
} from './agent/schemas.js'
// Model tiers and escalation: the pure rules (which tier, when to escalate), for hosts and tests.
export {
  escalationReasonOf,
  isEscalatableError,
  isReplayedToolOutput,
  MODEL_TIERS,
  nextStrongerTier,
  pickTier,
  REPLAY_NOTE,
  resolveEscalation,
} from './tiers.js'
export type { PlanShape, ReplanShape } from './agent/schemas.js'
// Phase functions + helpers, for hosts building a custom loop.
export { createPlan } from './agent/planner.js'
export { executeStep, replanWanted, shouldReplan, splitBlocker } from './agent/executor.js'
export { decideReplan } from './agent/replanner.js'
export { synthesizeAnswer } from './agent/synthesizer.js'
export type { AgentContext, EffectiveToolStrategy } from './agent/internal.js'

// ── Pipelines: a graph of agents with conditions and loops, in plain JSON ────
export { createPipeline, nodeResolver } from './pipeline/index.js'
export type {
  NodeResolverOptions,
  Pipeline,
  PipelineOptions,
  PipelineRunOptions,
} from './pipeline/index.js'
export {
  normalizePipeline,
  PIPELINE_LIMITS,
  PipelineNodeError,
  PipelineValidationError,
  renderPipelineNodeInput,
  testPipelineCondition,
  validatePipeline,
} from './pipeline/engine.js'
export type {
  PipelineCondition,
  PipelineDefinition,
  PipelineEdge,
  PipelineEvent,
  PipelineIssue,
  PipelineNode,
  PipelineNodeContext,
  PipelineNodeInput,
  PipelineNodeOutput,
  PipelineNodeRunner,
  PipelineNodeSource,
  PipelineResult,
  PipelineRoute,
  PipelineStop,
  PipelineTraceEntry,
  PipelineUsage,
  PipelineValidation,
} from './pipeline/engine.js'

// ── Subagents (in-process or Web Worker) ─────────────────────────────────────
export { createSubagentTool } from './subagent/tool.js'
export type { SubagentProfile, SubagentToolOptions, SubagentWorkerConfig } from './subagent/tool.js'
export { serveSubagentWorker } from './subagent/worker.js'
export type { ServeSubagentOptions } from './subagent/worker.js'
export type {
  MessageEndpoint,
  WorkerLike,
  ParentToWorker,
  WorkerToParent,
  ProxiedToolSpec,
} from './subagent/protocol.js'
// Dynamic subagents: helpers the model starts itself (`subagents.dynamic`).
export {
  adoptSubagentEvent,
  resolveDynamicSubagents,
  SPAWN_INPUT_SCHEMA,
  SPAWN_SUBAGENT_TOOL,
  SUBAGENT_DEFAULTS,
  SUBAGENT_MAX_DEPTH_LIMIT,
  SubagentSpawnError,
} from './subagent/dynamic-shared.js'
export type {
  IDynamicSubagentsConfig,
  IResolvedDynamicSubagents,
  ISubagentsConfig,
  SubagentDefaultTools,
} from './subagent/dynamic-shared.js'

// ── Images, files ────────────────────────────────────────────────────────────
export {
  AttachmentsNotSupportedError,
  ImagesNotSupportedError,
  attachmentKind,
  isAttachmentRefusal,
  isImageRefusal,
  mediaTypeOf,
  toFilePart,
  toImagePart,
} from './images.js'
export type { AttachmentKind, RunFile, RunImage } from './images.js'
export {
  VirtualFileSystem,
  normalizePath,
  mimeFromPath,
  isTextMime,
  bytesToBase64,
} from './files/vfs.js'
export type {
  VirtualFile,
  VirtualFileInfo,
  VirtualFileSystemOptions,
  VfsListener,
} from './files/vfs.js'
export { createFileTools, fileToolBindingOf } from './files/tools.js'
export type { FileToolBinding, FileToolsOptions } from './files/tools.js'
// Sandbox (`config.sandbox`, the run_js tool): types only - its code is loaded when it is
// switched on, and the worker side is the `./sandbox-worker` entry.
export type { SandboxConfig, SandboxWorkerLike } from './sandbox/index.js'
export type {
  ISandboxConfig,
  ISandboxError,
  ISandboxLimits,
  ISandboxResult,
} from './sandbox/engine.js'

// ── Thinking, limits, caching ────────────────────────────────────────────────
export { resolveThinking, thinkingFor, mergeProviderOptions } from './thinking.js'
export type {
  ThinkingConfig,
  ThinkingLevel,
  ThinkingSetting,
  ThinkingStage,
  ResolvedThinking,
  ProviderOptionsMap,
} from './thinking.js'
export { checkLimits, ToolBudgetError } from './limits.js'
export type { TokenLimits, LimitBreach, LimitKind } from './limits.js'
export { resolveCaching, withRollingBreakpoint } from './caching.js'
export type { PromptCachingSetting, ResolvedCaching } from './caching.js'

// ── Skills ───────────────────────────────────────────────────────────────────
export {
  defineSkill,
  parseSkillMarkdown,
  loadSkillFromUrl,
  renderSkillIndex,
  renderActiveSkills,
  createSkillTools,
  learnedPreamble,
  skillPreamble,
  SKILL_TOOL_NAMES,
} from './skills.js'
export type { Skill, SkillOrigin, McpSkillOrigin, LoadSkillOptions } from './skills.js'
// MCP skills (`skills: true` on a server of `./mcp`, experimental): the extension's id, the
// caps and the pure rules (no SDK behind them).
export {
  MCP_SKILLS_EXTENSION,
  MCP_SKILL_BODY_MAX_CHARS,
  MCP_SKILL_DESCRIPTION_MAX_CHARS,
  MCP_SKILL_FILE_MAX_CHARS,
  MCP_SKILL_MAX_RESOURCES,
  MCP_SKILL_MAX_TOTAL_BYTES,
  MCP_SKILLS_MAX_PER_SERVER,
  MCP_SKILLS_MAX_TOTAL,
  MCP_SKILL_CONSENTS,
  MCP_SKILL_CONSENT_DEFAULT,
  MCP_SKILL_URI_MAX_CHARS,
  MCP_SKILL_DIRECTORY_ENTRIES_MAX,
  MCP_SKILL_SNAPSHOT_MAX_DIRECTORIES,
  MCP_SKILL_SNAPSHOT_MAX_DEPTH,
  MCP_SKILL_SNAPSHOTS_MAX_BYTES,
  mcpSkillEntryRefusal,
  mcpSkillPreamble,
  mcpSkillUriRefusal,
  type McpSkillConsent,
  type McpSkillConsentView,
  type McpSkillsOptions,
  type McpSkillsSetting,
  type SkillDirectoryListing,
} from './mcp/skills.js'

// ── Learning: the agent's notebook of lessons (skills it wrote itself) ───────
export {
  createLearning,
  MemorySkillStore,
  VfsSkillStore,
  findSecret,
  normalizeSkillName,
  SAVE_SKILL_TOOL,
  FORGET_SKILL_TOOL,
} from './learning.js'
export type { Learning, LearningConfig, SaveSkillInput, SkillStore } from './learning.js'

// ── Config ───────────────────────────────────────────────────────────────────
export { outputCapNotice, resolveBudgets, resolveConfig, stageOutputCap } from './config.js'
export type {
  BrowserAgentConfig,
  OutputCap,
  ResolvedConfig,
  PhaseBudgets,
  ReplanTrigger,
  ToolMode,
  ToolSelectionStrategy,
} from './config.js'

// ── Providers / models ───────────────────────────────────────────────────────
export {
  buildMediaModelFromSpec,
  buildModelFromStage,
  resolveStage,
  resolveModel,
} from './providers/registry.js'
export type { MediaModelKind } from './providers/registry.js'
export {
  createWebLLMModel,
  preloadWebLLMModel,
  unloadWebLLMModel,
  isWebGPUAvailable,
} from './providers/webllm.js'
export type { WebLLMModelOptions } from './providers/webllm.js'
export {
  ContextWindowExceededError,
  contextOverflowOf,
  contextWindowOf,
  fitCompactionToWindow,
  toolDefinitionTokens,
  TOOL_SEARCH_WINDOW_SHARE,
  WEBLLM_DEFAULT_CONTEXT_WINDOW,
  webLLMContextWindow,
  withWebLLMContextWindow,
} from './context-window.js'
export type { WebLLMAppConfigLike } from './context-window.js'
export {
  supportsNativeTools,
  supportsStructuredOutput,
  directBrowserOk,
  supportsImages,
  supportsPdf,
} from './providers/capabilities.js'
export { isDirectModel, isProviderSpec } from './providers/types.js'
export type {
  ProviderType,
  ProviderModelSpec,
  ModelInput,
  StageInput,
  StageOverride,
  ResolvedStage,
} from './providers/types.js'

// ── Secrets (encrypted token vault) ──────────────────────────────────────────
export { IndexedDBVault } from './secrets/vault.js'
export type { VaultOptions } from './secrets/vault.js'
export { VaultCredentialStore, MemoryCredentialStore } from './secrets/store.js'
export type { CredentialStore } from './secrets/store.js'
export { getOrCreateVaultKey, encryptJSON, decryptJSON } from './secrets/crypto.js'
export type { EncryptedBlob } from './secrets/crypto.js'

// ── Storage (shared IndexedDB owner) ─────────────────────────────────────────
export {
  openAgentWebDB,
  KEYS_STORE,
  SECRETS_STORE,
  SESSIONS_STORE,
  FILES_STORE,
  RUNS_STORE,
} from './storage/db.js'
export type { AgentWebDBOptions } from './storage/db.js'

// ── Low-level LLM helpers (simple generation, tool loop) ─────────────────────
export { generate, stream, generateStructured } from './llm/generate.js'
export type { GenerateOptions, StructuredResult } from './llm/generate.js'
export { runToolLoop } from './llm/tool-loop.js'
export type { ToolLoopOptions, ToolLoopResult, ToolLoopCallbacks } from './llm/tool-loop.js'
export { normalizeUsage } from './llm/util.js'

// ── Tools ────────────────────────────────────────────────────────────────────
export { defineTool } from './tools/define.js'
// Egress: what the model may fetch (the browser sibling of the server's createSafeFetch).
export {
  createGuardedFetch,
  createWebFetchTool,
  createEgressTools,
  EgressError,
  classifyAddress,
  checkEgressUrl,
  hostMatches,
  htmlToText,
  resolveEgressPolicy,
  WEB_FETCH_TOOL,
} from './tools/egress.js'
export type {
  EgressErrorCode,
  GuardedFetch,
  IEgressPolicy,
  IResolvedEgressPolicy,
  IWebFetchOptions,
} from './tools/egress.js'
// Search: the web_search tool (the host's function, or Google Search via Gemini grounding through the guarded fetch).
export {
  askDecisionModel,
  decisionModelFromAiSdk,
  DEFAULT_DECISION_CONFIDENCE_THRESHOLD,
  DEFAULT_DECISION_TIMEOUT_MS,
} from './decision.js'
export type {
  DecisionFallbackReason,
  DecisionPoint,
  IAiSdkDecisionOptions,
  IDecisionAnswer,
  IDecisionCallOptions,
  IDecisionConfig,
  IDecisionEvent,
  IDecisionModel,
  IDecisionOption,
  IDecisionOutcome,
  IDecisionQuestion,
} from './decision.js'
export {
  decisionEgressPolicy,
  resolveDecisionModel,
  DECISION_PROVIDERS,
} from './decision-provider.js'
export type { IDecisionModelSpec } from './decision-provider.js'
export { createWebSearchTool, createSearchTools, searchEgressPolicy } from './tools/web-search.js'
export type { ISearchConfig, IWebSearchOptions } from './tools/web-search.js'
export {
  buildSearchRequest,
  parseSearchResponse,
  sanitizeSearchResults,
  searchStatusMessage,
  searchToolResult,
  SEARCH_API_BASE_URL,
  SEARCH_DEFAULT_MAX_RESULTS,
  SEARCH_GOOGLE_DEFAULT_MODEL,
  SEARCH_GOOGLE_NOTE,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_MAX_RESULTS,
  SEARCH_MAX_SNIPPET_CHARS,
  SEARCH_MAX_SUMMARY_CHARS,
  SEARCH_MAX_TITLE_CHARS,
  SEARCH_MAX_TOTAL_CHARS,
  SEARCH_MAX_URL_CHARS,
  SEARCH_PROVIDERS,
  WEB_SEARCH_TOOL,
} from './tools/web-search-shared.js'
export type {
  ISanitizedSearch,
  ISearchAnswer,
  ISearchOptions,
  ISearchRequest,
  ISearchResult,
  ISearchToolResult,
  ISearchUsage,
  SearchEngine,
  SearchFreshness,
  SearchProvider,
} from './tools/web-search-shared.js'
// Media: generate_image / generate_speech / transcribe_audio, and audio attachments as text.
export { createMedia } from './tools/media.js'
export type {
  IMedia,
  IMediaConfig,
  IMediaFile,
  IMediaModelSpec,
  IMediaOptions,
  IMediaRun,
  ITranscription,
  MediaImageModel,
  MediaSpeechModel,
  MediaTranscriptionModel,
} from './tools/media.js'
export {
  acceptMedia,
  GENERATE_IMAGE_TOOL,
  GENERATE_SPEECH_TOOL,
  MEDIA_AUDIO_TYPES,
  MEDIA_DEFAULT_MAX_CALLS,
  MEDIA_FOLDER,
  MEDIA_IMAGE_TYPES,
  MEDIA_MAX_ATTACHED_AUDIO,
  MEDIA_MAX_AUDIO_INPUT_BYTES,
  MEDIA_MAX_IMAGE_BYTES,
  MEDIA_MAX_PROMPT_CHARS,
  MEDIA_MAX_SPEECH_BYTES,
  MEDIA_MAX_SPEECH_CHARS,
  MEDIA_MAX_TRANSCRIPT_CHARS,
  MEDIA_TIMEOUT_MS,
  MediaBudgetError,
  MediaError,
  mediaUsageOf,
  sniffMediaType,
  TRANSCRIBE_AUDIO_TOOL,
  wrapTranscript,
} from './tools/media-shared.js'
export type { IMediaUsage, MediaKind } from './tools/media-shared.js'
export { renderCatalog, dispatch } from './tools/prompted.js'
export { selectToolMode } from './tools/mode.js'
export { promptHintOf } from './tools/types.js'
export type { AgentTool, AgentToolSet } from './tools/types.js'
export {
  ToolDeniedError,
  markReadOnly,
  isReadOnlyTool,
  markCodeExecution,
  isCodeExecutionTool,
  matchRule,
  decideToolPermission,
  TOOL_APPROVAL_MODES,
  TOOL_APPROVAL_TIMEOUT_MS,
} from './tools/approval.js'
export type {
  ToolApprovalApp,
  ToolApprovalConfig,
  ToolApprovalContext,
  ToolApprovalDecision,
  ToolApprovalMode,
  ToolApprovalRequest,
  ToolPermission,
} from './tools/approval.js'
export {
  searchTools,
  renderSearchCatalog,
  toolCatalogOf,
  createFindToolsTool,
  tokenize,
  FIND_TOOLS_NAME,
} from './tools/search.js'
export type { ToolCatalogEntry, SearchToolsOptions } from './tools/search.js'
export { toolRunContextOf, schemaHintOf, limitModelOutput } from './tools/wrap.js'
export { createToolResultClearer } from './llm/context-editing.js'
export type { ToolResultClearing, ClearedInfo } from './llm/context-editing.js'
export type { ToolRunContext } from './tools/wrap.js'

// ── Memory ───────────────────────────────────────────────────────────────────
export { MemoryStore } from './memory/store.js'
export type { ContextStore, StoredMessage } from './memory/store.js'
export { IndexedDBStore } from './memory/sessions.js'
export type { IndexedDBStoreOptions } from './memory/sessions.js'
// Run persistence: checkpoint a run, resume it after a reload or a crash.
export { resolveResume } from './agent/persistence.js'
export type { RunPersistence, RunSnapshot, RunStatus } from './agent/persistence.js'
export { IndexedDBRunStore, MemoryRunStore } from './memory/runs.js'
export type { IndexedDBRunStoreOptions, RunStoreOptions } from './memory/runs.js'
export {
  compressHistory,
  compactHistory,
  compactSteps,
  estimateTokens,
  estimateMessagesTokens,
  resolveCompaction,
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
} from './memory/compress.js'
export type { CompressOptions, CompactionConfig, ResolvedCompaction } from './memory/compress.js'

// ── Prompts ──────────────────────────────────────────────────────────────────
export { defaultPrompts, withSystem } from './prompts.js'
export type {
  Prompts,
  PromptParts,
  ToolCallMode,
  PlannerPromptContext,
  ExecutorPromptContext,
  ReplannerPromptContext,
  SynthesizerPromptContext,
} from './prompts.js'

// ── Parsing (robust salvage — for custom loops / the prompted path) ──────────
export {
  parsePlannerResponse,
  parseExecutorResponse,
  parseReplannerResponse,
  parsePlainText,
  looksLikeJson,
  normalizeSteps,
} from './parse.js'
export type {
  RawAction,
  ReplanDecision,
  PlannerResult,
  ExecutorResult,
  ReplannerResult,
} from './parse.js'

// ── Events ───────────────────────────────────────────────────────────────────
export type { AgentEvent, AgentEventHandler, ReplanMode, Phase, UsagePhase } from './events.js'
// The types of the two `mcp.elicitation-*` events (the connector itself is the `./mcp` entry).
export type {
  McpElicitationFieldSchema,
  McpElicitationReason,
  McpElicitationSchema,
} from './mcp/elicitation.js'
// MCP Apps: the `mcp.app` event's types and the pure guards a UI re-applies (no SDK behind them;
// the connector is the `./mcp` entry).
export {
  MCP_APP_MAX_HTML_CHARS,
  MCP_APP_MAX_RESULT_CHARS,
  MCP_APP_MIME_TYPE,
  MCP_APPS_EXTENSION,
  mcpAppOrigin,
} from './mcp/apps.js'
export type {
  McpAppCsp,
  McpAppPermissions,
  McpAppResource,
  McpAppToolResult,
  McpAppVisibility,
} from './mcp/apps.js'
// MCP Apps asking the agent's model (`Agent.sampleForApp`): the rules, pure.
export {
  APP_SAMPLING_MAX_IMAGE_BYTES,
  APP_SAMPLING_MAX_IMAGES,
  APP_SAMPLING_MAX_INPUT_CHARS,
  APP_SAMPLING_MAX_MESSAGES,
  APP_SAMPLING_MAX_SYSTEM_CHARS,
  APP_SAMPLING_MAX_TOKENS,
  APP_SAMPLING_PER_APP,
  APP_SAMPLING_REASONING_TOKENS,
  APP_SAMPLING_PER_MINUTE,
  APP_SAMPLING_RPC_CODES,
  AppSamplingError,
  appSamplingRequestOf,
  appSamplingText,
  createAppSamplingLimiter,
  resolveAppSampling,
} from './app-sampling.js'
export type {
  AppSamplingErrorCode,
  AppSamplingImage,
  AppSamplingMessage,
  AppSamplingResult,
  AppSamplingSettings,
  AppSamplingView,
} from './app-sampling.js'

// ── Logging ──────────────────────────────────────────────────────────────────
export { createLogger } from './logger.js'
export type { AgentLogger, AgentLoggerSink, LogLevel } from './logger.js'
