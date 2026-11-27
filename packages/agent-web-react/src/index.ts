// ── Hooks ────────────────────────────────────────────────────────────────────
export { useAgent } from './hooks/use-agent.js'
export type {
  ApproveOptions,
  RunGoalOptions,
  UseAgentOptions,
  UseAgentReturn,
} from './hooks/use-agent.js'
export { useChatHistory } from './hooks/use-chat-history.js'
export type { UseChatHistoryOptions, UseChatHistoryReturn } from './hooks/use-chat-history.js'
export { useVirtualFiles } from './hooks/use-virtual-files.js'
export type { UseVirtualFilesReturn } from './hooks/use-virtual-files.js'
export { useSpeechToText } from './hooks/use-speech-to-text.js'
export type {
  UseSpeechToTextOptions,
  UseSpeechToTextReturn,
  SpeechRecognizerLike,
} from './hooks/use-speech-to-text.js'
export { useCredentials } from './hooks/use-credentials.js'
export type { UseCredentialsReturn } from './hooks/use-credentials.js'
export { createWebLLMEngine, useWebLLMModel } from './hooks/use-webllm-model.js'
export { useLocalModel } from './hooks/use-local-model.js'
export type {
  LocalModelEngine,
  LocalModelLoadContext,
  LocalModelProgress,
  UseLocalModelOptions,
  UseLocalModelReturn,
} from './hooks/use-local-model.js'
export type {
  UseWebLLMModelReturn,
  UseWebLLMModelOptions,
  WebLLMModelFactory,
} from './hooks/use-webllm-model.js'

// ── Chat history, labels (i18n), composer helpers, images ────────────────────
export { ChatHistoryStore, chatTitle, newChatId } from './chat-history.js'
export type { ChatRecord, ChatSummary, ChatHistoryStoreOptions } from './chat-history.js'
export { AgentLabelsProvider, defaultLabels, mergeLabels, useLabels } from './labels.js'
export type { AgentLabels, AgentLabelsOverride, AgentLabelsProviderProps } from './labels.js'
export {
  parseSlash,
  filterCommands,
  attachmentKindOf,
  withAttachments,
  attachmentRefusal,
  formatElapsed,
  noticesOf,
  steerIntent,
} from './composer.js'
export type {
  SlashCommand,
  ComposerAttachment,
  ComposerNotice,
  NoticeTexts,
  SteerIntent,
} from './composer.js'
export { downscaleImage } from './image-resize.js'
export type { DownscaleOptions } from './image-resize.js'

// ── Context ──────────────────────────────────────────────────────────────────
export { AgentProvider, useAgentContext, useOptionalAgentContext } from './context.js'
export type { AgentProviderProps } from './context.js'

// ── Headless state (the pure event → UI reducer, for custom UIs) ─────────────
export { agentStateReducer, createInitialAgentState, lessonsOf, subagentTree } from './state.js'
export type { AgentAction } from './state.js'
// The form inside an `ElicitationView` (types only: the MCP hooks are the `./mcp` entry).
export type {
  McpElicitationFieldSchema,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationSchema,
} from './mcp-types.js'
// The prompt's pure half: a form's fields, the answer and its checks, a link, the countdown.
export {
  elicitationFields,
  elicitationFormAnswer,
  elicitationInitialDraft,
  elicitationLink,
  formatCountdown,
} from './elicitation.js'
export type {
  ElicitationControl,
  ElicitationDraft,
  ElicitationDraftValue,
  ElicitationField,
  ElicitationFormOutcome,
  ElicitationIssue,
  ElicitationIssueKind,
  ElicitationLink,
  ElicitationOption,
  ElicitationOutcomeReason,
  PendingElicitation,
} from './elicitation.js'
export type {
  AgentUiState,
  AgentStatus,
  QueuedMessageView,
  UserNoteView,
  ApprovalView,
  ElicitationView,
  BudgetView,
  ChatAttachment,
  ChatMessage,
  CompactionView,
  DecisionView,
  FetchView,
  LessonView,
  MediaView,
  StepEscalationView,
  StepView,
  SubagentNode,
  SubagentView,
  ToolCallView,
  TranscriptView,
  ModelLoadState,
  ReplanState,
} from './types.js'

// ── Components (optional, pre-styled — import '@dudko.dev/agent-web-react/styles.css') ─
export { AgentChat } from './components/AgentChat.js'
export type {
  AgentChatProps,
  AgentChatSlots,
  AgentChatComponents,
  AgentChatClassNames,
} from './components/AgentChat.js'
export { AgentComposer } from './components/AgentComposer.js'
export type {
  AgentComposerProps,
  ComposerModelChip,
  ComposerThinkingChip,
  ConvertedFile,
} from './components/AgentComposer.js'
export { MessageList, AttachmentView, usageLine } from './components/MessageList.js'
export type { MessageListProps } from './components/MessageList.js'
export { ChatHistoryList } from './components/ChatHistoryList.js'
export type { ChatHistoryListProps } from './components/ChatHistoryList.js'
export { LearnedSkills } from './components/LearnedSkills.js'
export type { LearnedSkillsProps } from './components/LearnedSkills.js'
export { FilesPanel } from './components/FilesPanel.js'
export type { FilesPanelProps } from './components/FilesPanel.js'
export { Composer } from './components/Composer.js'
export type { ComposerProps } from './components/Composer.js'
export { PlanView } from './components/PlanView.js'
export type { PlanViewProps } from './components/PlanView.js'
export { StepList, ToolCallRow, UserNoteRow, decisionNote } from './components/StepList.js'
export type { StepListProps, ToolCallRowProps, RenderToolCall } from './components/StepList.js'
export { SubagentRow, SubagentTree } from './components/SubagentTree.js'
export type {
  RenderSubagent,
  SubagentRowProps,
  SubagentTreeProps,
} from './components/SubagentTree.js'
export { GeneratedMedia, TranscriptBlock, mediaFamilyOf } from './components/Media.js'
export type { GeneratedMediaProps, TranscriptBlockProps } from './components/Media.js'
export { FileChip, FileChips, SourceView, FILE_PREVIEW_CHARS } from './components/FileChips.js'
export type {
  FileChipProps,
  FileChipsProps,
  HtmlPreviewOptions,
  SourceViewProps,
} from './components/FileChips.js'
export {
  SandboxedFrame,
  clampFrameHeight,
  FRAME_MAX_HEIGHT,
  FRAME_MIN_HEIGHT,
} from './components/SandboxedFrame.js'
export type { SandboxedFrameProps } from './components/SandboxedFrame.js'
export {
  buildSandboxedDocument,
  escapeAttribute,
  linkedFilesOf,
  sandboxedCsp,
  sandboxTokens,
  tokenizeHtml,
  withCspFirst,
  HTML_PREVIEW_MAX_CHARS,
} from './html-preview.js'
export type { SandboxedDocumentOptions, SourceToken } from './html-preview.js'
export { fileKindOf, fileNameOf } from './file-kinds.js'
export type { FileKind } from './file-kinds.js'
export { webSearchOf } from './components/format.js'
export type { WebSearchResultView, WebSearchView } from './components/format.js'
export { ToolApprovalPrompt } from './components/ToolApprovalPrompt.js'
export type { ToolApprovalPromptProps } from './components/ToolApprovalPrompt.js'
export { ElicitationPrompt } from './components/ElicitationPrompt.js'
export type { ElicitationPromptProps } from './components/ElicitationPrompt.js'
export { ApprovalModeSwitch } from './components/ApprovalModeSwitch.js'
export type { ApprovalModeSwitchProps } from './components/ApprovalModeSwitch.js'
export { ContextMeter } from './components/ContextMeter.js'
export type { ContextMeterProps } from './components/ContextMeter.js'
export { ModelLoadBar } from './components/ModelLoadBar.js'
export type { ModelLoadBarProps } from './components/ModelLoadBar.js'
export { UsageBadge } from './components/UsageBadge.js'
export type { UsageBadgeProps } from './components/UsageBadge.js'
export { ApiKeyForm } from './components/ApiKeyForm.js'
export type { ApiKeyFormProps } from './components/ApiKeyForm.js'

// ── Convenience re-exports from the core (a peer dep), so a React app can
//    import the agent primitives it needs from one place. ──────────────────────
export {
  createAgent,
  defineTool,
  defineSkill,
  parseSkillMarkdown,
  loadSkillFromUrl,
  createRunControl,
  createSubagentTool,
  serveSubagentWorker,
  markReadOnly,
  createWebLLMModel,
  preloadWebLLMModel,
  unloadWebLLMModel,
  isWebGPUAvailable,
  VaultCredentialStore,
  MemoryCredentialStore,
  MemoryStore,
  IndexedDBStore,
  VirtualFileSystem,
  createFileTools,
  MemorySkillStore,
  VfsSkillStore,
  AttachmentsNotSupportedError,
  ImagesNotSupportedError,
  supportsImages,
  supportsPdf,
} from '@dudko.dev/agent-web'
export type {
  Agent,
  RunControl,
  RunOptions,
  RunResult,
  SubagentInfo,
  BrowserAgentConfig,
  AgentEvent,
  AgentEventHandler,
  AgentTool,
  AgentToolSet,
  CredentialStore,
  ProviderModelSpec,
  ProviderType,
  ModelInput,
  LogLevel,
  AgentLoggerSink,
  IPlan,
  IPlanStep,
  IStepResult,
  IToolCall,
  IUsage,
  Skill,
  SkillStore,
  LearningConfig,
  ThinkingSetting,
  ThinkingLevel,
  TokenLimits,
  CompactionConfig,
  CompactResult,
  ToolApprovalConfig,
  ToolApprovalMode,
  ToolApprovalRequest,
  SubagentToolOptions,
  SubagentWorkerConfig,
  RunFile,
  VirtualFile,
  VirtualFileInfo,
  FileToolsOptions,
} from '@dudko.dev/agent-web'
