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
  renderMcpInstructions,
  type McpServerInstructions,
} from './mcp-shared.ts'
export type { INodeOAuthProviderOptions, IOAuthRequestOptions, IOAuthStore } from './mcp-oauth.ts'
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
  isReadOnlyTool,
  markReadOnly,
  matchToolRule,
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
export { createPipeline, nodeResolver } from './pipeline.ts'
export type {
  NodeResolverOptions,
  Pipeline,
  PipelineModelConfig,
  PipelineOptions,
  PipelineRunOptions,
} from './pipeline.ts'
export {
  normalizePipeline,
  PIPELINE_LIMITS,
  PipelineNodeError,
  PipelineValidationError,
  renderPipelineNodeInput,
  testPipelineCondition,
  validatePipeline,
} from './pipeline-engine.ts'
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
} from './pipeline-engine.ts'
export { createSubagentTool } from './subagent.ts'
export type { ISubagentProfile, ISubagentToolOptions, SubagentIsolation } from './subagent.ts'

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
