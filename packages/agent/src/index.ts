export { createAgent } from './agent.ts'
export type { IAgent, ICloseOptions, ICompactOptions, ICompactResult } from './agent.ts'
export { getCurrentRunId, getCurrentRunSandbox } from './context.ts'
export { addUsage, normalizeUsage, redactHeaders } from './utils.ts'
export {
  beginMcpOAuth,
  checkAuthorizationResponseIssuer,
  createNodeOAuthProvider,
  FileOAuthStore,
  finishMcpOAuth,
  MemoryOAuthStore,
  NodeOAuthProvider,
} from './mcp-oauth.ts'
export {
  MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER,
  MCP_INSTRUCTIONS_MAX_CHARS_TOTAL,
  MCP_MODERN_PROTOCOL_VERSION,
  renderMcpInstructions,
  type McpProtocolMode,
  type McpServerInstructions,
  type McpServerProtocol,
} from './mcp-shared.ts'
// MCP skills (`skills: true` on a server, experimental): the extension's id, the caps, the rules.
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
} from './mcp-skills.ts'
export {
  MCP_ELICITATION_MAX_PER_RUN,
  MCP_ELICITATION_MAX_PER_TOOL_CALL,
  MCP_ELICITATION_TIMEOUT_MS,
  normalizeMcpElicitationSchema,
  validateMcpElicitationContent,
  type McpElicitationContent,
  type McpElicitationContext,
  type McpElicitationFieldSchema,
  type McpElicitationHandler,
  type McpElicitationOptions,
  type McpElicitationReason,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpElicitationSchema,
} from './mcp-elicitation.ts'
export type {
  INodeOAuthProviderOptions,
  IOAuthRequestOptions,
  IOAuthStore,
  McpOAuthRegistration,
  McpOAuthRegistrationKind,
} from './mcp-oauth.ts'
export {
  createEnterpriseOAuthProvider,
  ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION,
  EnterpriseOAuthError,
  NodeEnterpriseOAuthProvider,
} from './mcp-enterprise-oauth.ts'
export type {
  EnterpriseAssertionAlgorithm,
  EnterpriseAssertionAudience,
  EnterpriseAssertionType,
  EnterpriseOAuthHop,
  EnterpriseOAuthLog,
  EnterprisePrivateKey,
  IEnterpriseIdpOptions,
  IEnterpriseOAuthProviderOptions,
} from './mcp-enterprise-oauth.ts'

// Thinking
export { mergeProviderOptions, resolveThinking } from './thinking.ts'
export type { IResolvedThinking } from './thinking.ts'
// Token limits
export { checkLimits, resolveLimits } from './limits.ts'
// Compaction
export {
  compactHistory,
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
  estimateTokens,
  resolveCompaction,
  SUMMARY_PREFIX,
  truncateToolModelOutput,
  withToolOutputLimit,
} from './compaction.ts'
export type { ICompactHistoryOptions, ICompactHistoryResult } from './compaction.ts'
// Skills
export { defineSkill, loadSkillsFromDir, parseSkillMarkdown } from './skills.ts'
// Tool approval
export {
  decideToolPermission,
  isCodeExecutionTool,
  isReadOnlyTool,
  markCodeExecution,
  markReadOnly,
  matchToolRule,
  TOOL_APPROVAL_TIMEOUT_MS,
  ToolDeniedError,
} from './approval.ts'
export type { IToolDecision, IToolDecisionInput } from './approval.ts'
export { ToolBudgetError } from './tool-wrap.ts'
// Tool search
export { searchTools } from './tool-search.ts'
export type { ISearchToolsOptions } from './tool-search.ts'
// Prompt caching
export { buildInstructions, resolvePromptCaching, withRollingBreakpoint } from './caching.ts'
// Context editing (stale tool results inside a step's tool loop)
export { createToolResultClearer } from './context-editing.ts'
export type { IClearedInfo, IToolResultClearing } from './context-editing.ts'
// Subagents
// Learning: the agent's notebook of lessons (skills it wrote itself).
export {
  createLearning,
  DirSkillStore,
  MemorySkillStore,
  findSecret,
  normalizeSkillName,
  SAVE_SKILL_TOOL,
  FORGET_SKILL_TOOL,
} from './learning.ts'
export type { ILearning, ISaveSkillInput } from './learning.ts'
// Egress: the fetch a model may use, and the safe fetch behind it.
export {
  createSafeFetch,
  EgressError,
  classifyAddress,
  checkEgressUrl,
  checkRedirect,
  hostMatches,
  resolveEgressPolicy,
} from './safe-fetch.ts'
export type { EgressErrorCode, IEgressPolicy, IResolvedAddress, SafeFetch } from './safe-fetch.ts'
export { createWebFetchTool, createEgressTools, htmlToText, WEB_FETCH_TOOL } from './web-fetch.ts'
// Search: the web_search tool (the host's function, or Google Search via Gemini grounding through the safe fetch).
export {
  askDecisionModel,
  decisionModelFromAiSdk,
  DEFAULT_DECISION_CONFIDENCE_THRESHOLD,
  DEFAULT_DECISION_TIMEOUT_MS,
} from './decision.ts'
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
} from './decision.ts'
export { createWebSearchTool, createSearchTools, searchEgressPolicy } from './web-search.ts'
export type { ISearchConfig, IWebSearchOptions } from './web-search.ts'
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
} from './web-search-shared.ts'
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
} from './web-search-shared.ts'
// Media: generate_image / generate_speech / transcribe_audio, and audio attachments as text.
export { createMedia } from './media.ts'
export type {
  IMedia,
  IMediaConfig,
  IMediaFile,
  IMediaModelSpec,
  IRunFile,
  ITranscription,
  MediaImageModel,
  MediaSpeechModel,
  MediaTranscriptionModel,
} from './media.ts'
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
} from './media-shared.ts'
export type { IMediaUsage, MediaKind } from './media-shared.ts'
export { buildMediaModelFromStage } from './provider.ts'
export type { MediaModelKind } from './provider.ts'
// Sandbox: the run_js tool (JavaScript in QuickJS/WebAssembly, in a worker thread).
export {
  createSandboxTool,
  createSandboxTools,
  resolveSandboxLimits,
  RUN_JS_TOOL,
  SandboxUnavailableError,
} from './sandbox.ts'
export type { ISandboxConfig, ISandboxError, ISandboxLimits, ISandboxResult } from './sandbox.ts'
// Steer a run while it goes: send a message, stop one subagent.
export { createRunControl } from './control.ts'
export type { RunControl, SubagentInfo } from './control.ts'
// Pipelines: a graph of agents with conditions and loops, described in plain JSON.
export { createPipeline, nodeResolver, pickPipelineRoute } from './pipeline.ts'
export type {
  NodeResolverOptions,
  Pipeline,
  PipelineModelConfig,
  PipelineOptions,
  PipelineRouteOptions,
  PipelineRouteResult,
  PipelineRunOptions,
} from './pipeline.ts'
export {
  matchPipelineRoute,
  normalizePipeline,
  PIPELINE_LIMITS,
  PIPELINE_ROUTER_SYSTEM,
  PipelineNodeError,
  PipelineValidationError,
  preparePipeline,
  renderPipelineNodeInput,
  renderPipelineRoutePrompt,
  runPipelineGraph,
  testPipelineCondition,
  validatePipeline,
} from './pipeline-engine.ts'
export type {
  PipelineAbortBehaviour,
  PipelineCondition,
  PipelineDefinition,
  PipelineEdge,
  PipelineEvent,
  PipelineGraphRunOptions,
  PipelineIssue,
  PipelineNode,
  PipelineNodeContext,
  PipelineNodeEvent,
  PipelineNodeInput,
  PipelineNodeOutput,
  PipelineNodeRunner,
  PipelineNodeSource,
  PipelinePlan,
  PipelineResult,
  PipelineRoute,
  PipelineStop,
  PipelineTraceEntry,
  PipelineUsage,
  PipelineValidation,
} from './pipeline-engine.ts'
export { createSubagentTool, REMOTE_SUBAGENT_LIMITS } from './subagent.ts'
export type {
  ILocalSubagentToolOptions,
  IRemoteSubagentContext,
  IRemoteSubagentResult,
  IRemoteSubagentTask,
  IRemoteSubagentToolOptions,
  ISubagentProfile,
  ISubagentToolOptions,
  RemoteSubagentDispatch,
  SubagentIsolation,
} from './subagent.ts'
export { RunLeaseError, RUN_LEASE_DEFAULT_TTL_MS } from './run-lease.ts'
export type { IRunLease, IRunLeaseOptions, RunLeaseLostReason } from './run-lease.ts'
export { isModelCallRefused, ModelCallRefusedError } from './shared-limits.ts'
export type { IModelCall, ISharedLimits, ModelCallStage } from './shared-limits.ts'
// Dynamic subagents: helpers the model starts itself (config.subagents.dynamic).
export {
  adoptSubagentEvent,
  resolveDynamicSubagents,
  SPAWN_INPUT_SCHEMA,
  SPAWN_SUBAGENT_TOOL,
  SUBAGENT_DEFAULTS,
  SUBAGENT_MAX_DEPTH_LIMIT,
  SubagentSpawnError,
} from './subagent-dynamic-shared.ts'
export type {
  IDynamicSubagentsConfig,
  IResolvedDynamicSubagents,
  ISubagentsConfig,
  SubagentDefaultTools,
} from './subagent-dynamic-shared.ts'

export type {
  AgentEvent,
  AgentStage,
  BudgetKind,
  EventHandler,
  IAgentConfig,
  IAgentRunOptions,
  IAgentRunResult,
  IAgentStageOverride,
  ICompactionConfig,
  IConversationTurn,
  ILimitBreach,
  IMcpHttpServerConfig,
  IMcpServerConfig,
  IMcpSkillOrigin,
  IMcpStdioServerConfig,
  IPersistence,
  IRunSnapshot,
  ISkill,
  ISkillOrigin,
  ISkillStore,
  ILearningConfig,
  IStepStartInfo,
  IPlan,
  IPlanStep,
  IStepResult,
  IStepEscalation,
  IEscalationConfig,
  EscalationReason,
  ModelTier,
  StepComplexity,
  TierReason,
  IThinkingConfig,
  ITokenLimits,
  IToolApprovalConfig,
  IToolApprovalContext,
  IToolApprovalRequest,
  IToolCatalogEntry,
  IUsage,
  LogLevel,
  PromptCachingSetting,
  ProviderType,
  ReplanCause,
  ReplanTrigger,
  ThinkingLevel,
  ThinkingSetting,
  TokenLimitKind,
  ToolApprovalDecision,
  ToolApprovalMode,
  ToolPermission,
  ToolSelectionStrategy,
  UsagePhase,
} from './types.ts'
// A write the escalation guard did not run twice: how to recognise its tool result.
export { isReplayedToolOutput, REPLAY_NOTE } from './tiers.ts'
