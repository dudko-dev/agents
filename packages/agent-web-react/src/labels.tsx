import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type {
  DecisionFallbackReason,
  EscalationReason,
  ModelTier,
  TierReason,
  ToolApprovalMode,
} from '@dudko.dev/agent-web'
import { defaultNoticeTexts, type NoticeTexts } from './composer.js'
import type { FileKind } from './file-kinds.js'
import type { AgentStatus } from './types.js'

/**
 * Every string the pre-styled components render — override any of them for
 * another language or wording, per component (`labels` prop) or for a whole
 * tree (`<AgentLabelsProvider>`). Counted phrases are functions, so languages
 * with several plural forms can say them properly.
 */
export interface AgentLabels {
  // ── chat panel ─────────────────────────────────────────────────────────────
  emptyState: string
  status: Record<AgentStatus, string>
  history: string
  newChat: string
  files: string
  totalUsage: string
  showHistory: string
  showFiles: string
  close: string

  // ── transcript ─────────────────────────────────────────────────────────────
  steps: (n: number) => string
  toolCalls: (n: number) => string
  subagents: (n: number) => string
  skillsUsed: (names: string) => string
  /** "learned: a, b" - lessons the agent wrote down in this run. */
  learnedNow: (names: string) => string
  /** "2 web requests" - what the model fetched in this run. */
  fetches: (n: number) => string
  /** Why a web request was refused. */
  fetchRefused: (reason: string) => string
  answerThoughts: string
  stepThoughts: string
  usageTitle: string
  attachments: string
  planned: string
  replanned: (mode: string, reason: string) => string

  // ── notebook (the agent's own lessons) ─────────────────────────────────────
  notebookTitle: string
  notebookEmpty: string
  notebookForget: string
  notebookRevision: (n: number) => string
  /** Before the sources a lesson came from. */
  notebookFrom: string

  // ── composer ───────────────────────────────────────────────────────────────
  placeholder: string
  listening: string
  message: string
  dropHint: string
  attach: string
  attachTitle: string
  commands: string
  commandsTitle: string
  send: string
  stop: string
  dismiss: string
  remove: (name: string) => string
  dictate: string
  dictateTitle: string
  stopDictation: string
  microphone: string
  model: string
  thinking: string
  toolConsent: string
  modes: Record<ToolApprovalMode, { label: string; hint: string }>
  timerRunning: string
  timerLast: string
  agents: (n: number) => string
  agentsTitle: string
  /** Banners: a limit stopped the run / the context was compacted. */
  notices: NoticeTexts
  attachmentsOnly: string
  seeAttachments: string
  tooLarge: (name: string, mb: number) => string
  binaryText: (name: string) => string
  commandGroups: { commands: string; consent: string; skills: string }
  commandDescriptions: {
    compact: string
    new: string
    stop: string
    autopilot: string
    ask: string
    askAll: string
    readOnly: string
    think: (levels: string) => string
  }
  /** `off` = the provider's default; `none` = thinking switched off. */
  thinkingLevels: { off: string; none: string; low: string; medium: string; high: string }

  // ── files panel ────────────────────────────────────────────────────────────
  filesEmpty: string
  upload: string
  download: string
  delete: string
  preview: string
  bytes: (n: number) => string

  // ── chat history ───────────────────────────────────────────────────────────
  historyEmpty: string
  deleteChat: string
  messagesCount: (n: number) => string

  // ── consent prompt ─────────────────────────────────────────────────────────
  approvalLead: string
  approve: string
  alwaysAllow: string
  deny: string
  declinedReason: string
  readOnlyTool: string
  consentWaiting: string
  consentAllowed: string
  consentDenied: (reason?: string) => string

  // ── steering a run that is going ───────────────────────────────────────────
  /** Composer placeholder while the agent works (what you type is sent to it). */
  placeholderBusy: string
  /** The send button while the agent works. */
  steer: string
  /** Shown when files are attached while the agent works (they can't be added then). */
  noAttachmentsWhileBusy: string
  /** A message waiting to reach the agent. */
  queuedWaiting: string
  /** Where a note landed: between tool calls / after a step / before the answer. */
  noteAt: Record<'round' | 'step' | 'final', string>
  /** Messages the run ended without delivering, offered for sending. */
  undelivered: (n: number) => string
  sendUndelivered: string
  discardUndelivered: string
  stopSubagent: string
  subagentStopped: string

  // ── steps / tool calls ─────────────────────────────────────────────────────
  failed: string
  toolCostTitle: string

  // ── model tiers and escalation ─────────────────────────────────────────────
  /** The tier badge on a step. */
  tierNames: Record<ModelTier, string>
  /** The badge's tooltip: why the step started on its tier. */
  tierReasons: Record<TierReason, string>
  /** Why a step was retried on a stronger model. */
  escalationReasons: Record<EscalationReason, string>
  /** "Escalated: light → strong (reported a blocker)" - the names and the reason are already labels. */
  escalated: (from: string, to: string, reason: string) => string
  /** Opens what the failed attempt had written. */
  escalatedAttemptText: string
  /** "1 escalation" in the activity summary. */
  escalations: (n: number) => string
  /** On a tool call made by an attempt that was escalated. */
  attemptTag: (n: number) => string
  /** On a write the core did not run a second time (it succeeded in an earlier attempt). */
  replayed: string
  replayedTitle: string
  /** The replanner call failed; the run went on with the plan it had. */
  replanFailed: string

  // ── the subagent tree ──────────────────────────────────────────────────────
  /** The tag on a helper the model started itself (`spawn_subagent`). */
  subagentHelper: string
  /** A node's status, in words. */
  subagentStatus: Record<'running' | 'done' | 'error' | 'stopped', string>
  /** "12k tokens" - what was spent under a node; the number is already formatted. */
  subagentTokens: (tokens: string) => string
  /** "tools: fs_read, web_fetch" - what a helper was given. */
  subagentTools: (names: string) => string
  /** A helper that was given no tools at all (it only reasons). */
  subagentNoTools: string
  /** The consent prompt of a helper's call: `role` is what the model wrote for it, if anything. */
  approvalLeadHelper: (role: string | undefined, depth: number) => string

  // ── generated media and transcripts ────────────────────────────────────────
  /** Alt text of a generated image; `path` is where it is in the workspace. */
  mediaImage: (path: string) => string
  /** The accessible name of a generated audio player. */
  mediaAudio: (path: string) => string
  /** A generated file that cannot be shown here (no workspace, the file is gone, an unknown type). */
  mediaFile: (path: string) => string
  /** The summary of a transcript block. */
  transcriptOf: (name: string) => string
  /** Says whose words a transcript is: the content of the user's file, not the agent's. */
  transcriptNote: string

  // ── files written in a turn ────────────────────────────────────────────────
  /** Above the chips: "3 files written in this turn". */
  filesWritten: (n: number) => string
  /** In the activity summary: "3 files". */
  filesCount: (n: number) => string
  /** The link that opens the Files panel. */
  showInFiles: string
  /** What a file is, on its chip. */
  fileKinds: Record<FileKind, string>
  /** The open button of a chip (accessible name); `name` is the file's name. */
  fileOpen: (name: string) => string
  /** The same button while the preview is open. */
  fileClose: (name: string) => string
  /** The download button of a chip (accessible name). */
  fileDownload: (name: string) => string
  /** On a chip: the subagent that wrote the file. */
  fileBy: (name: string) => string
  /** On a chip whose file is not in the workspace any more. */
  fileGone: string
  /** In the preview of a file that cannot be shown as text or as an image. */
  fileNoPreview: string
  /** Under a preview that shows only the first `chars` characters. */
  fileCut: (chars: number) => string
  /** Unfold / fold a long text preview. */
  fileShowRest: string
  fileShowLess: string
  /** The two views of a text file the host can render (Markdown). */
  fileRendered: string
  fileSource: string
  closePreview: string
  /** Under a source view: "64 lines". */
  fileLines: (n: number) => string

  // ── HTML preview (the sandboxed frame) ─────────────────────────────────────
  /** The host's label on the frame of an HTML file. */
  htmlFrameTitle: string
  /** The two badges under it, while the page is shown. */
  htmlSandboxed: string
  htmlNoNetwork: string
  /** In their place, while the source is shown. */
  htmlSourceNote: string
  /** In the frame's footer. */
  htmlScripts: (on: boolean) => string
  /** The files the page links to that the preview does not load. */
  htmlLinkedFiles: (names: string) => string
  /** A page too large to frame. */
  htmlTooLarge: string
  /** The button that makes the frame taller / back. */
  htmlTaller: string
  htmlShorter: string
  /** The accessible name of the frame itself. */
  htmlFrameName: (path: string) => string

  // ── usage: calls that are not tokens ───────────────────────────────────────
  usageMedia: (n: number) => string
  usageDecisions: (n: number) => string

  // ── decision model ─────────────────────────────────────────────────────────
  /** "decision model: continue (0.93)" - its answer was used; the probability is formatted. */
  decisionAccepted: (choice: string, confidence: string) => string
  /** "decision model fell back: low confidence (0.41 < 0.8)" - the ordinary model call ran. */
  decisionFellBack: (reason: string, detail: string) => string
  decisionReasons: Record<DecisionFallbackReason, string>

  // ── web search results ─────────────────────────────────────────────────────
  /** Before the query of a `web_search` call. */
  searchQuery: string
  searchNoResults: string
  /** Results left out by the egress policy. */
  searchFiltered: (n: number) => string
  /** The list was cut to the cap. */
  searchTruncated: string
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const kb = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`

export const defaultLabels: AgentLabels = {
  emptyState: 'Ask the agent to do something.',
  status: {
    idle: 'Idle',
    initializing: 'Loading model…',
    ready: 'Ready',
    running: 'Working…',
    error: 'Failed to start',
  },
  history: 'Chats',
  newChat: 'New chat',
  files: 'Files',
  totalUsage: 'Tokens this conversation used, by kind',
  showHistory: 'Show chats',
  showFiles: 'Show files',
  close: 'Close',

  steps: (n) => plural(n, 'step', 'steps'),
  toolCalls: (n) => plural(n, 'tool call', 'tool calls'),
  subagents: (n) => plural(n, 'subagent', 'subagents'),
  skillsUsed: (names) => `skills: ${names}`,
  learnedNow: (names) => `learned: ${names}`,
  fetches: (n) => plural(n, 'web request', 'web requests'),
  fetchRefused: (reason) => `refused: ${reason}`,
  answerThoughts: 'Thinking about the answer',
  stepThoughts: 'Thoughts',
  usageTitle: 'Tokens this answer spent, by kind',
  attachments: 'Attachments',
  planned: 'Plan',
  replanned: (mode, reason) => `Replanned (${mode}): ${reason}`,

  notebookTitle: 'Notebook',
  notebookEmpty: 'The agent has not written any lessons down yet.',
  notebookForget: 'Forget',
  notebookRevision: (n) => `revision ${n}`,
  notebookFrom: 'from',

  placeholder: 'Ask the agent to do something…  ( / for commands, Ctrl+V to paste an image )',
  listening: 'Listening…',
  message: 'Message',
  dropHint: 'Drop files or images to attach them',
  attach: 'Attach files',
  attachTitle: 'Attach files or images (or paste with Ctrl+V, or drop them here)',
  commands: 'Commands',
  commandsTitle: 'Commands and skills ( / )',
  send: 'Send',
  stop: 'Stop',
  dismiss: 'Dismiss',
  remove: (name) => `Remove ${name}`,
  dictate: 'Dictate (speech to text)',
  dictateTitle: 'Dictate — speech to text in the browser',
  stopDictation: 'Stop dictation',
  microphone: 'Microphone',
  model: 'Model',
  thinking: 'Thinking',
  toolConsent: 'Tool consent',
  modes: {
    autopilot: { label: 'Auto', hint: 'Autopilot — run every tool without asking' },
    'ask-writes': {
      label: 'Ask',
      hint: 'Run read-only tools freely; ask before anything that may change state',
    },
    'ask-all': { label: 'Ask all', hint: 'Ask before every tool call' },
    'read-only': {
      label: 'Read-only',
      hint: 'Only read-only tools; refuse changes without asking',
    },
  },
  timerRunning: 'This run so far',
  timerLast: 'The last run took',
  agents: (n) => plural(n, 'agent', 'agents'),
  agentsTitle: 'Subagents running in this run',
  notices: defaultNoticeTexts,
  attachmentsOnly: '(attachments)',
  seeAttachments: 'See the attachments.',
  tooLarge: (name, mb) => `${name} is larger than ${mb} MB.`,
  binaryText: (name) => `${name} looks binary — it can't be attached as text.`,
  commandGroups: { commands: 'Commands', consent: 'Consent', skills: 'Skills' },
  commandDescriptions: {
    compact: 'Summarise the conversation to free context',
    new: 'Start a new conversation',
    stop: 'Stop the current run',
    autopilot: 'Run every tool without asking',
    ask: 'Ask before tools that may change state',
    askAll: 'Ask before every tool call',
    readOnly: 'Only read; refuse changes',
    think: (levels) => `Set thinking: ${levels}`,
  },
  thinkingLevels: {
    off: 'Default',
    none: 'No thinking',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
  },

  filesEmpty: 'No files yet. Attachments and files the agent writes appear here.',
  upload: 'Upload',
  download: 'Download',
  delete: 'Delete',
  preview: 'Preview',
  bytes: kb,

  historyEmpty: 'No saved chats yet.',
  deleteChat: 'Delete chat',
  messagesCount: (n) => plural(n, 'message', 'messages'),

  approvalLead: 'The agent wants to run',
  approve: 'Allow once',
  alwaysAllow: 'Always allow',
  deny: 'Deny',
  declinedReason: 'the user declined',
  readOnlyTool: 'read-only',
  consentWaiting: 'waiting for your consent',
  consentAllowed: 'allowed',
  consentDenied: (reason) => `denied${reason ? ` — ${reason}` : ''}`,

  placeholderBusy: 'Tell the agent something while it works…',
  steer: 'Send to the agent',
  noAttachmentsWhileBusy:
    'Files can’t be added while the agent is working — send them with your next message.',
  queuedWaiting: 'waiting for the agent’s next step',
  noteAt: {
    round: 'you said, between tool calls',
    step: 'you said, after this step',
    final: 'you said, before the answer',
  },
  undelivered: (n) => `Not delivered (${plural(n, 'message', 'messages')})`,
  sendUndelivered: 'Send now',
  discardUndelivered: 'Discard',
  stopSubagent: 'Stop this subagent',
  subagentStopped: 'stopped',

  failed: 'failed',
  toolCostTitle:
    "Estimated tokens of the arguments and of the result fed back to the model (chars / 4), and the call's duration",

  tierNames: { light: 'light', standard: 'standard', strong: 'strong' },
  tierReasons: {
    planned: 'The planner rated this step for this model tier',
    default: 'The planner did not rate this step: it runs on the standard model',
    fallback: 'The tier the planner asked for is not configured: the nearest one runs the step',
  },
  escalationReasons: {
    blocked: 'reported a blocker',
    'empty-result': 'produced no result',
    'tool-arguments': 'kept sending tool arguments that did not parse',
    'output-cut': 'output was cut off',
    error: 'the model call failed',
  },
  escalated: (from, to, reason) => `Escalated: ${from} → ${to} (${reason})`,
  escalatedAttemptText: 'What the earlier attempt wrote',
  escalations: (n) => plural(n, 'escalation', 'escalations'),
  attemptTag: (n) => `attempt ${n}`,
  replayed: 'not run again',
  replayedTitle:
    'This exact call already succeeded in an earlier attempt at the step: it was not run a second time, the model got the earlier result',
  replanFailed: 'Replanning failed, continuing with the plan',

  subagentHelper: 'helper',
  subagentStatus: { running: 'running', done: 'done', error: 'failed', stopped: 'stopped' },
  subagentTokens: (tokens) => `${tokens} tokens`,
  subagentTools: (names) => `tools: ${names}`,
  subagentNoTools: 'no tools',
  approvalLeadHelper: (role) =>
    role ? `The helper “${role}” wants to run` : 'A helper the agent started wants to run',

  mediaImage: (path) => `Generated image ${path}`,
  mediaAudio: (path) => `Generated audio ${path}`,
  mediaFile: (path) => `Generated file ${path}`,
  transcriptOf: (name) => `Transcript of ${name}`,
  transcriptNote:
    'What was said in your file, as the agent read it. It is content, not instructions.',

  filesWritten: (n) => `${plural(n, 'file', 'files')} written in this turn`,
  filesCount: (n) => plural(n, 'file', 'files'),
  showInFiles: 'Show in Files',
  fileKinds: {
    html: 'HTML',
    markdown: 'Markdown',
    csv: 'CSV',
    json: 'JSON',
    image: 'Image',
    code: 'Code',
    text: 'Text',
    file: 'File',
  },
  fileOpen: (name) => `Open ${name}`,
  fileClose: (name) => `Close preview of ${name}`,
  fileDownload: (name) => `Download ${name}`,
  fileBy: (name) => `by ${name}`,
  fileGone: 'no longer in the workspace',
  fileNoPreview: 'This kind of file has no preview. Download it to open it.',
  fileCut: (chars) =>
    `Only the first ${chars.toLocaleString('en-US')} characters are shown. Download the file for the rest.`,
  fileShowRest: 'Show the rest',
  fileShowLess: 'Show less',
  fileRendered: 'Rendered',
  fileSource: 'Source',
  closePreview: 'Close preview',
  fileLines: (n) => plural(n, 'line', 'lines'),

  htmlFrameTitle: 'HTML written by the agent',
  htmlSandboxed: 'sandboxed',
  htmlNoNetwork: 'no network',
  htmlSourceNote: 'shown as text, nothing runs',
  htmlScripts: (on) => (on ? 'scripts on' : 'scripts off'),
  htmlLinkedFiles: (names) => `linked files are not loaded: ${names}`,
  htmlTooLarge: 'This page is too large to preview. It is shown as source.',
  htmlTaller: 'Make the preview taller',
  htmlShorter: 'Make the preview shorter',
  htmlFrameName: (path) => `Preview of ${path}`,

  usageMedia: (n) => plural(n, 'media call', 'media calls'),
  usageDecisions: (n) => plural(n, 'decision call', 'decision calls'),

  decisionAccepted: (choice, confidence) => `decision model: ${choice} (${confidence})`,
  decisionFellBack: (reason, detail) =>
    `decision model fell back: ${reason}${detail ? ` (${detail})` : ''}`,
  decisionReasons: {
    'low-confidence': 'low confidence',
    'invalid-choice': 'an answer that is not an option',
    'invalid-confidence': 'a confidence that is not a probability',
    error: 'the call failed',
    timeout: 'timed out',
    'needs-model': 'the choice needs the model',
  },

  searchQuery: 'Searched the web for',
  searchNoResults: 'no results',
  searchFiltered: (n) => `${n} left out by the web access policy`,
  searchTruncated: 'list cut short',
}

/** Overrides: any label, with the nested groups merged key by key. */
export type AgentLabelsOverride = Partial<
  Omit<
    AgentLabels,
    | 'status'
    | 'modes'
    | 'commandGroups'
    | 'commandDescriptions'
    | 'thinkingLevels'
    | 'notices'
    | 'tierNames'
    | 'tierReasons'
    | 'escalationReasons'
    | 'subagentStatus'
    | 'decisionReasons'
    | 'fileKinds'
  >
> & {
  status?: Partial<AgentLabels['status']>
  modes?: Partial<AgentLabels['modes']>
  commandGroups?: Partial<AgentLabels['commandGroups']>
  commandDescriptions?: Partial<AgentLabels['commandDescriptions']>
  thinkingLevels?: Partial<AgentLabels['thinkingLevels']>
  notices?: Partial<AgentLabels['notices']>
  tierNames?: Partial<AgentLabels['tierNames']>
  tierReasons?: Partial<AgentLabels['tierReasons']>
  escalationReasons?: Partial<AgentLabels['escalationReasons']>
  subagentStatus?: Partial<AgentLabels['subagentStatus']>
  decisionReasons?: Partial<AgentLabels['decisionReasons']>
  fileKinds?: Partial<AgentLabels['fileKinds']>
}

const NESTED = [
  'status',
  'modes',
  'commandGroups',
  'commandDescriptions',
  'thinkingLevels',
  'noteAt',
  'tierNames',
  'tierReasons',
  'escalationReasons',
  'subagentStatus',
  'decisionReasons',
  'fileKinds',
] as const

/** `base` with `over` applied (nested groups merged, not replaced). */
export const mergeLabels = (base: AgentLabels, over?: AgentLabelsOverride): AgentLabels => {
  if (!over) return base
  const out = { ...base, ...over } as AgentLabels
  for (const key of NESTED) {
    if (over[key]) (out as unknown as Record<string, unknown>)[key] = { ...base[key], ...over[key] }
  }
  return out
}

const LabelsContext = createContext<AgentLabels>(defaultLabels)

export interface AgentLabelsProviderProps {
  labels: AgentLabelsOverride
  children?: ReactNode
}

/** Override labels for every component below (nests: inner providers win). */
export const AgentLabelsProvider = ({ labels, children }: AgentLabelsProviderProps) => {
  const parent = useContext(LabelsContext)
  const value = useMemo(() => mergeLabels(parent, labels), [parent, labels])
  return <LabelsContext.Provider value={value}>{children}</LabelsContext.Provider>
}

/** The labels in effect: the provider's, with a component's own `labels` prop on top. */
export const useLabels = (over?: AgentLabelsOverride): AgentLabels => {
  const ctx = useContext(LabelsContext)
  return useMemo(() => mergeLabels(ctx, over), [ctx, over])
}
