import { useEffect, useRef, useState } from 'react'
import type { ComponentType, CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { VirtualFileSystem } from '@dudko.dev/agent-web'
import { ChatHistoryStore } from '../chat-history.js'
import { useOptionalAgentContext } from '../context.js'
import type { UseAgentReturn } from '../hooks/use-agent.js'
import { useChatHistory, type UseChatHistoryReturn } from '../hooks/use-chat-history.js'
import {
  useMcpAppHost,
  type AppRequestView,
  type McpAppsConnectionLike,
} from '../hooks/use-mcp-app-host.js'
import type { McpAppSandboxOptions } from '../mcp-app.js'
import type { AppView, ChatMessage } from '../types.js'
import { AppRequestPrompt } from './AppRequestPrompt.js'
import { McpAppFrame, McpAppLine } from './McpAppFrame.js'
import { AgentLabelsProvider, useLabels, type AgentLabelsOverride } from '../labels.js'
import { AgentComposer, type AgentComposerProps } from './AgentComposer.js'
import { ChatHistoryList, type ChatHistoryListProps } from './ChatHistoryList.js'
import { ContextMeter } from './ContextMeter.js'
import { ElicitationPrompt, type ElicitationPromptProps } from './ElicitationPrompt.js'
import { FilesPanel, type FilesPanelProps } from './FilesPanel.js'
import { AlertIcon, FileIcon, HistoryIcon } from './icons.js'
import { MessageList, type MessageListProps } from './MessageList.js'
import { ModelLoadBar } from './ModelLoadBar.js'
import { decisionNote, type RenderToolCall } from './StepList.js'
import type { RenderSubagent } from './SubagentTree.js'
import { ToolApprovalPrompt, type ToolApprovalPromptProps } from './ToolApprovalPrompt.js'
import { UsageBadge } from './UsageBadge.js'

/** Places to put your own content in the panel. */
export interface AgentChatSlots {
  /** Replaces the whole header; `false` hides it. */
  header?: ReactNode | false
  /** In the header, before the title. */
  headerStart?: ReactNode
  /** In the header, after the usage badge. */
  headerEnd?: ReactNode
  /** In the body, above / below the transcript. */
  beforeMessages?: ReactNode
  afterMessages?: ReactNode
  /** Above the composer. */
  footerStart?: ReactNode
  /** Under the chat list in the history sidebar. */
  sidebar?: ReactNode
}

/** Swap any built-in part for your own component (same props). */
export interface AgentChatComponents {
  Composer?: ComponentType<AgentComposerProps>
  MessageList?: ComponentType<MessageListProps>
  HistoryList?: ComponentType<ChatHistoryListProps>
  FilesPanel?: ComponentType<FilesPanelProps>
  ApprovalPrompt?: ComponentType<ToolApprovalPromptProps>
  ElicitationPrompt?: ComponentType<ElicitationPromptProps>
}

/** Extra class names per part (added to the built-in `awr-` ones). */
export interface AgentChatClassNames {
  root?: string
  main?: string
  header?: string
  body?: string
  footer?: string
  sidebar?: string
  files?: string
}

export interface AgentChatProps {
  /**
   * An explicit controller from {@link useAgent}. If omitted, the component
   * reads the shared controller from an enclosing `<AgentProvider>`.
   */
  controller?: UseAgentReturn
  title?: ReactNode
  /** Content shown before the first message. */
  emptyState?: ReactNode
  /** @deprecated use `composer={{ placeholder }}` */
  placeholder?: string

  // ── what is shown ──────────────────────────────────────────────────────────
  /** Each answer's steps, thoughts, subagents, consent decisions (default true). */
  showActivity?: boolean
  /** Each tool call inside the activity (default true). */
  showToolCalls?: boolean
  /** Tokens per answer and per tool call (default true). */
  showUsage?: boolean
  /** Thoughts, when the model thinks (default true). */
  showThoughts?: boolean
  /** What you said while the agent worked, under the step it reached (default true). */
  showNotes?: boolean
  /** The lessons the agent wrote down during an answer, and the pages it fetched (default true). */
  showLearned?: boolean
  /**
   * Model tiers (`executorTiers`): the tier / model badge on a step, the "escalated" line and
   * the escalation count (default true; nothing shows when tiers are off).
   */
  showTiers?: boolean
  /** The "replanning failed, continuing with the plan" warning (default true). */
  showReplanFailed?: boolean
  /**
   * The decision model's note under the step it was asked after - "decision model: continue
   * (0.93)" (default true; nothing shows without `decisionModel`).
   */
  showDecisions?: boolean
  /** A `web_search` call's results as a short list under its row (default true). */
  showSearchResults?: boolean
  /**
   * The subagent tree - static subagents and the helpers the model started - under the step
   * that started them (default true).
   */
  showSubagents?: boolean
  /**
   * What a run generated (`config.media`): images inline in the answer, audio as a player, and
   * the transcripts of audio files, folded (default true). The bytes are read from `files`.
   */
  showMedia?: boolean
  /**
   * The files an answer wrote to the workspace (`files`), as chips under it: name, kind, size,
   * open (an inline preview - an `.html` file in a sandboxed frame) and download (default true).
   */
  showFileChips?: boolean
  /**
   * How an `.html` file is previewed: sandboxed, no network, scripts off by default;
   * `{ scripts: true }` lets its inline scripts run; `false` shows HTML as source only.
   */
  htmlPreview?: MessageListProps['htmlPreview']
  /** A stop button on each running subagent (default true). */
  stoppableSubagents?: boolean
  /** Conversation total in the header (default true). */
  showTotalUsage?: boolean
  /** Status dot in the header (default true). */
  showStatus?: boolean
  /** Consent-mode chip in the composer — "⚡ Auto" (default true). */
  showApprovalMode?: boolean
  /**
   * Context meter (tokens by kind, budget bar, Compact) above the composer
   * (default false). A number draws the bar against that budget.
   */
  showContext?: boolean | number
  /** Keep finished answers' activity expanded (default false). */
  activityOpen?: boolean
  /**
   * Questions MCP servers put to the user (MCP elicitation), beside the consent prompts
   * (default true). Shown once `elicitations` and `onElicitationAnswer` are given.
   */
  showElicitation?: boolean

  // ── features ───────────────────────────────────────────────────────────────
  /**
   * Saved conversations in IndexedDB with a sidebar to switch between them:
   * `true` (default store), your own `ChatHistoryStore`, or the result of your
   * own `useChatHistory()` (e.g. to render the list elsewhere).
   */
  history?: boolean | ChatHistoryStore | UseChatHistoryReturn
  /**
   * Sidebar open at first (default: on a wide panel yes; on a narrow one —
   * under `narrowWidth` — it starts closed and opens over the chat).
   */
  defaultHistoryOpen?: boolean
  /**
   * The workspace: attachments are saved here, and a Files panel shows it
   * (add `createFileTools(files)` to the agent's tools so it can use it too).
   */
  files?: VirtualFileSystem
  /** Files panel open at first (default false). */
  defaultFilesOpen?: boolean
  /** Below this width (px) side panels overlay the chat instead of sitting beside it (default 760). */
  narrowWidth?: number
  /** Composer options (model / thinking chips, commands, convertFile, speech…), or `false` to hide it. */
  composer?: Partial<Omit<AgentComposerProps, 'controller'>> | false
  /**
   * The questions MCP servers are waiting on: `pendingElicitations` of `useMcp` /
   * `useMcpServers` (from `@dudko.dev/agent-web-react/mcp`, with their `elicitation` option on).
   */
  elicitations?: ElicitationPromptProps['elicitations']
  /** The user's answer to one of them: the hook's `answerElicitation`. */
  onElicitationAnswer?: ElicitationPromptProps['onAnswer']

  // ── how it is rendered ─────────────────────────────────────────────────────
  /** A message's text — plug in your markdown renderer here. */
  renderContent?: MessageListProps['renderContent']
  renderMessage?: MessageListProps['renderMessage']
  renderAttachment?: MessageListProps['renderAttachment']
  renderToolCall?: RenderToolCall
  /** A node of the subagent tree. */
  renderSubagent?: RenderSubagent
  /** A generated image / audio file. */
  renderMedia?: MessageListProps['renderMedia']
  /** A file chip of an answer. */
  renderFile?: MessageListProps['renderFile']
  /** A written text file rendered your way (Markdown); `undefined` = shown as source. */
  renderFileContent?: MessageListProps['renderFileContent']
  renderApproval?: ToolApprovalPromptProps['renderApproval']
  /** A server's question (gets the built-in card as `fallback`, and `answer`). */
  renderElicitation?: ElicitationPromptProps['renderElicitation']
  slots?: AgentChatSlots
  components?: AgentChatComponents
  /** Override any text (i18n); applies to every part inside. */
  labels?: AgentLabelsOverride
  /** Force a colour scheme (default 'auto' = follow the OS). */
  theme?: 'auto' | 'light' | 'dark'
  classNames?: AgentChatClassNames
  className?: string
  /** Inline styles on the root — handy for sizing (e.g. `{ height: 520 }`). */
  style?: CSSProperties

  // ── MCP Apps ───────────────────────────────────────────────────────────────
  /**
   * MCP Apps: the connection that reads an app and makes the calls it asks for -
   * `useMcpServers({ apps: true }).apps` (or `useMcp`'s, or the core's `ConnectedMcp.apps`).
   * With it, an answer whose tool call came with an app shows the app in a sandboxed frame under
   * the answer, and everything the app asks for - a tool call, a link, a message - is put to the
   * user here, labelled as the app's. Without it no app is drawn.
   */
  mcpApps?: McpAppsConnectionLike
  /** Draw MCP Apps (default true; needs `mcpApps`). */
  showApps?: boolean
  /**
   * Run apps on an origin of their own: `{ url }` of a sandbox page you serve on ANOTHER origin
   * (`@dudko.dev/agent-web-react/mcp-app-sandbox`), e.g.
   * `{ url: 'https://apps.example.com/sandbox/v1' }` - or `'https://{server}.apps.example.com/…'`
   * for one origin per server. Default: none - apps run in an opaque frame (no storage of their
   * own). A URL on this page's origin, or not https, is refused (opaque); so is a page that does
   * not answer in `timeoutMs`.
   */
  appSandbox?: McpAppSandboxOptions
  /**
   * Let an app be shown full screen (`ui/request-display-mode`): over the chat panel, or the
   * viewport on a phone, in the host's chrome with Exit full screen and Esc. Granted only to
   * an app that declared it, right after a click or a key inside its frame. Default false.
   */
  appFullscreen?: boolean
  /**
   * Let an app hand the user a file to save (`ui/download-file`): a prompt with its name, type
   * and size, saved by this page on "Save file". Programs, scripts and web pages are refused; a
   * linked file is read from the app's own server only. Default false.
   */
  appDownloads?: boolean
  /**
   * Let an app ask the agent's model for an answer (`sampling/createMessage`, no tools): a
   * prompt with exactly what the model would get; "Allow once", "Always for this app" (until a
   * reload) or "Deny". The answer goes to the app only; its tokens count in the total. Default
   * false. Needs a controller with `sampleForApp` (`useAgent`).
   */
  appSampling?: boolean
  /** Start every app folded to one line (default false). */
  appsCollapsed?: boolean
  /**
   * Where an app opened "in panel" goes: `'auto'` (default) - beside the chat when it is wide,
   * a bottom sheet when it is narrow (`narrowWidth`); `'sheet'` - always the sheet; an element -
   * rendered into it (a column of your page); `false` - no panel.
   */
  appPanel?: 'auto' | 'sheet' | HTMLElement | null | false
  /** Told when an app goes into the panel (`app`) or leaves it (`undefined`). */
  onAppPanel?: (app: AppView | undefined) => void
  /** An app yourself: `fallback` is the built-in frame. */
  renderApp?: (app: AppView, message: ChatMessage, fallback: ReactNode) => ReactNode
  /** A link / message an app asks for, yourself: `fallback` is the built-in card. */
  renderAppRequest?: (request: AppRequestView, fallback: ReactNode) => ReactNode
}

/** Follows the OS colour scheme (for `theme="auto"`): what an app is told. */
const usePrefersDark = (): boolean => {
  const query = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(query)
    const on = () => setDark(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return dark
}

const isHistoryHook = (h: AgentChatProps['history']): h is UseChatHistoryReturn =>
  typeof h === 'object' && h !== null && 'select' in h && 'chats' in h

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ')

/**
 * A drop-in chat panel: transcript with every answer's activity (steps, tool
 * calls with their cost, thoughts, subagents, consent decisions) and tokens by
 * kind, live consent prompts, model-load progress, and the full composer
 * (attachments by "+", Ctrl+V and drag & drop; slash commands; timer; agents;
 * model + thinking; consent mode; dictation). Optional: saved chats in
 * IndexedDB (`history`) and a workspace panel (`files`).
 *
 * Everything is switchable (`show*`), relabelable (`labels`), replaceable
 * (`render*`, `slots`, `components`) and themable (`theme`, `--awr-*`
 * variables, `classNames`). Give it a `controller` from {@link useAgent}, or
 * wrap it in an {@link AgentProvider}.
 *
 * ```tsx
 * <AgentChat controller={agent} history files={vfs} composer={{ model: { label: 'Gemini' } }} />
 * ```
 */
export const AgentChat = (props: AgentChatProps) => (
  <AgentLabelsProvider labels={props.labels ?? NO_LABELS}>
    <AgentChatInner {...props} />
  </AgentLabelsProvider>
)

const NO_LABELS: AgentLabelsOverride = {}

const AgentChatInner = ({
  controller,
  title,
  emptyState,
  placeholder,
  showActivity = true,
  showToolCalls = true,
  showUsage = true,
  showThoughts = true,
  showNotes = true,
  showLearned = true,
  showTiers = true,
  showReplanFailed = true,
  showDecisions = true,
  showSearchResults = true,
  showSubagents = true,
  showMedia = true,
  showFileChips = true,
  htmlPreview,
  stoppableSubagents = true,
  showTotalUsage = true,
  showStatus = true,
  showApprovalMode = true,
  showContext = false,
  activityOpen = false,
  showElicitation = true,
  elicitations,
  onElicitationAnswer,
  renderElicitation,
  history,
  defaultHistoryOpen,
  files,
  defaultFilesOpen = false,
  narrowWidth = 760,
  composer,
  renderContent,
  renderMessage,
  renderAttachment,
  renderToolCall,
  renderSubagent,
  renderMedia,
  renderFile,
  renderFileContent,
  renderApproval,
  slots = {},
  components = {},
  theme = 'auto',
  classNames = {},
  className,
  style,
  mcpApps,
  appSandbox,
  appFullscreen = false,
  appDownloads = false,
  appSampling = false,
  showApps = true,
  appsCollapsed = false,
  appPanel = 'auto',
  onAppPanel,
  renderApp,
  renderAppRequest,
}: AgentChatProps) => {
  const ctx = useOptionalAgentContext()
  const agent = controller ?? ctx
  if (!agent) {
    throw new Error(
      '<AgentChat> needs a `controller` prop from useAgent(), or an enclosing <AgentProvider>.',
    )
  }
  const L = useLabels()

  // History: an external hook result, or our own over the given / default store.
  const external = isHistoryHook(history) ? history : undefined
  const [ownStore] = useState(() =>
    history instanceof ChatHistoryStore ? history : new ChatHistoryStore(),
  )
  const own = useChatHistory(agent, {
    store: ownStore,
    enabled: Boolean(history) && !external,
  })
  const chats = history ? (external ?? own) : undefined

  // Narrow panel → the side panels overlay the chat (and start closed).
  const rootRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return setNarrow(false)
    const measure = () => setNarrow(el.getBoundingClientRect().width < narrowWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [narrowWidth])
  const [historyChoice, setHistoryOpen] = useState<boolean | undefined>(defaultHistoryOpen)
  const historyOpen = historyChoice ?? narrow === false
  const [filesOpen, setFilesOpen] = useState(defaultFilesOpen)
  // On a narrow panel one overlay at a time.
  const toggleHistory = () => {
    setHistoryOpen(!historyOpen)
    if (narrow && !historyOpen) setFilesOpen(false)
  }
  const toggleFiles = () => {
    setFilesOpen((o) => !o)
    if (narrow && !filesOpen) setHistoryOpen(false)
  }

  const showFiles = () => {
    setFilesOpen(true)
    if (narrow) setHistoryOpen(false)
  }

  // Follow the transcript while the user is at the bottom; leave them be when
  // they scrolled up to read.
  const bodyRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  useEffect(() => {
    const el = bodyRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [
    agent.messages,
    agent.steps,
    agent.finalText,
    agent.modelLoad,
    agent.pendingApprovals,
    elicitations,
  ])

  // MCP Apps: the host (reads, consent), the theme they are told, the one in the panel.
  const appHost = useMcpAppHost({
    connection: mcpApps,
    approve: agent.approveAppToolCall,
    approvals: agent.pendingApprovals,
    sandbox: appSandbox,
    downloads: appDownloads,
    sampling: appSampling,
    ...(agent.sampleForApp ? { sample: agent.sampleForApp } : {}),
  })
  const prefersDark = usePrefersDark()
  const appTheme: 'light' | 'dark' = theme === 'auto' ? (prefersDark ? 'dark' : 'light') : theme
  const [panelApp, setPanelAppState] = useState<AppView | undefined>()
  const setPanelApp = (app: AppView | undefined) => {
    setPanelAppState(app)
    onAppPanel?.(app)
  }
  const appsOn = showApps && Boolean(mcpApps)
  const panelAllowed = appPanel !== false && appPanel !== null
  const panelTarget = typeof appPanel === 'object' && appPanel ? appPanel : undefined
  const asSheet = !panelTarget && (appPanel === 'sheet' || Boolean(narrow))
  // An app whose message is gone (a new chat, a reset) leaves the panel.
  useEffect(() => {
    if (panelApp && !agent.messages.some((m) => m.apps?.some((a) => a.id === panelApp.id))) {
      setPanelAppState(undefined)
      onAppPanel?.(undefined)
    }
  }, [agent.messages, panelApp, onAppPanel])
  const drawApp = (app: AppView, message: ChatMessage): ReactNode => {
    const built =
      panelApp?.id === app.id ? (
        <McpAppLine
          app={app}
          note={L.appInPanel}
          action={L.appBringBack}
          onAction={() => setPanelApp(undefined)}
        />
      ) : (
        <McpAppFrame
          app={app}
          host={appHost}
          theme={appTheme}
          defaultCollapsed={appsCollapsed}
          onOpenPanel={panelAllowed ? () => setPanelApp(app) : undefined}
          allowFullscreen={appFullscreen}
        />
      )
    return renderApp ? renderApp(app, message, built) : built
  }
  const appPanelNode =
    appsOn && panelApp ? (
      <McpAppFrame
        key={panelApp.id}
        app={panelApp}
        host={appHost}
        theme={appTheme}
        variant="panel"
        onClosePanel={() => setPanelApp(undefined)}
        allowFullscreen={appFullscreen}
      />
    ) : null

  const [compacting, setCompacting] = useState(false)
  const compact = () => {
    setCompacting(true)
    void agent.compact().finally(() => setCompacting(false))
  }

  const Composer = components.Composer ?? AgentComposer
  const Messages = components.MessageList ?? MessageList
  const HistoryList = components.HistoryList ?? ChatHistoryList
  const Files = components.FilesPanel ?? FilesPanel
  const Approvals = components.ApprovalPrompt ?? ToolApprovalPrompt
  const Elicitations = components.ElicitationPrompt ?? ElicitationPrompt

  const loading = agent.modelLoad && agent.modelLoad.progress < 1
  const showReplan = agent.replan && agent.replan.mode !== 'continue'
  // A replanner that failed before any step exists has no step to hang its warning on.
  const replanFailedEarly =
    showReplanFailed && agent.replan?.failed === true && agent.steps.length === 0
  // A decision made before any step exists has no step to sit under either.
  const earlyDecisions = showDecisions ? (agent.decisions ?? []) : []
  const liveExtra =
    agent.planThought.trim() || showReplan || replanFailedEarly || earlyDecisions.length > 0 ? (
      <>
        {agent.planThought.trim() && (
          <details className="awr-activity__plan">
            <summary>{L.planned}</summary>
            <p className="awr-activity__thought">{agent.planThought}</p>
          </details>
        )}
        {showReplan && (
          <div className="awr-activity__replan">
            {L.replanned(agent.replan!.mode, agent.replan!.reason)}
          </div>
        )}
        {replanFailedEarly && (
          <p className="awr-step__warn" title={agent.replan!.error}>
            <AlertIcon size={12} /> {L.replanFailed}
          </p>
        )}
        {earlyDecisions.map((d, i) => (
          <p
            key={i}
            className={`awr-step__decision${d.accepted ? '' : ' awr-step__decision--fallback'}`}
          >
            {decisionNote(d, L)}
          </p>
        ))}
      </>
    ) : undefined

  const header =
    slots.header === false ? null : slots.header !== undefined ? (
      slots.header
    ) : (
      <div className={cx('awr-chat__header', classNames.header)}>
        {chats && (
          <button
            type="button"
            className={cx('awr-iconbtn', historyOpen && 'is-on')}
            aria-label={L.showHistory}
            title={L.showHistory}
            aria-pressed={historyOpen}
            onClick={toggleHistory}
          >
            <HistoryIcon size={16} />
          </button>
        )}
        {slots.headerStart}
        <div className="awr-chat__title">{title}</div>
        {showStatus && (
          <span className={`awr-status awr-status--${agent.status}`} title={L.status[agent.status]}>
            <span className="awr-status__dot" />
            <span className="awr-status__text">{L.status[agent.status]}</span>
          </span>
        )}
        {showTotalUsage && (
          <span title={L.totalUsage}>
            <UsageBadge usage={agent.totalUsage} compact={narrow !== false} />
          </span>
        )}
        {files && (
          <button
            type="button"
            className={cx('awr-iconbtn', filesOpen && 'is-on')}
            aria-label={L.showFiles}
            title={L.showFiles}
            aria-pressed={filesOpen}
            onClick={toggleFiles}
          >
            <FileIcon size={16} />
          </button>
        )}
        {slots.headerEnd}
      </div>
    )

  return (
    <div
      ref={rootRef}
      className={cx('awr-chat', narrow && 'awr-chat--narrow', className, classNames.root)}
      style={style}
      data-awr-theme={theme === 'auto' ? undefined : theme}
    >
      {chats && historyOpen && (
        <aside className={cx('awr-chat__sidebar', classNames.sidebar)}>
          <HistoryList
            history={{
              ...chats,
              // Picking a chat on a narrow panel closes the overlay.
              select: async (id) => {
                await chats.select(id)
                if (narrow) setHistoryOpen(false)
              },
              newChat: () => {
                chats.newChat()
                if (narrow) setHistoryOpen(false)
              },
            }}
            disabled={agent.isRunning}
          />
          {slots.sidebar}
          <button
            type="button"
            className="awr-iconbtn awr-chat__closeside"
            aria-label={L.close}
            onClick={() => setHistoryOpen(false)}
          >
            ×
          </button>
        </aside>
      )}

      <div className={cx('awr-chat__main', classNames.main)}>
        {header}

        <div
          className={cx('awr-chat__body', classNames.body)}
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          {slots.beforeMessages}
          <Messages
            messages={agent.messages}
            empty={emptyState ?? L.emptyState}
            showActivity={showActivity}
            showToolCalls={showToolCalls}
            showUsage={showUsage}
            showThoughts={showThoughts}
            showNotes={showNotes}
            showLearned={showLearned}
            showTiers={showTiers}
            showReplanFailed={showReplanFailed}
            showDecisions={showDecisions}
            showSearchResults={showSearchResults}
            showSubagents={showSubagents}
            showMedia={showMedia}
            showFileChips={showFileChips}
            files={files}
            htmlPreview={htmlPreview}
            onShowFiles={files ? showFiles : undefined}
            renderFile={renderFile}
            renderFileContent={renderFileContent}
            renderMedia={renderMedia}
            renderSubagent={renderSubagent}
            onStopSubagent={stoppableSubagents ? agent.stopSubagent : undefined}
            activityOpen={activityOpen}
            liveExtra={liveExtra}
            renderContent={renderContent}
            renderMessage={renderMessage}
            renderAttachment={renderAttachment}
            renderToolCall={renderToolCall}
            showApps={appsOn}
            renderApp={appsOn ? drawApp : undefined}
          />
          <Approvals
            approvals={agent.pendingApprovals}
            onApprove={agent.approve}
            onDeny={agent.deny}
            renderApproval={renderApproval}
          />
          {/* Asked of the user, in this order: tool calls (the agent's and an app's), what an
              app asks besides (a link, a message), then a server's questions. */}
          {appsOn && (
            <AppRequestPrompt
              requests={appHost.requests}
              onAnswer={appHost.answer}
              renderRequest={renderAppRequest}
            />
          )}
          {showElicitation && elicitations && onElicitationAnswer && (
            <Elicitations
              elicitations={elicitations}
              onAnswer={onElicitationAnswer}
              outcomes={agent.elicitations}
              renderElicitation={renderElicitation}
            />
          )}
          {agent.modelLoad && loading && <ModelLoadBar load={agent.modelLoad} />}
          {slots.afterMessages}
        </div>

        <div className={cx('awr-chat__footer', classNames.footer)}>
          {slots.footerStart}
          {showContext !== false && (
            <ContextMeter
              usage={agent.usage}
              budgetTokens={typeof showContext === 'number' ? showContext : undefined}
              budget={agent.budget}
              compactions={agent.compactions}
              onCompact={agent.isRunning ? undefined : compact}
              compacting={compacting}
            />
          )}
          {composer === false ? (
            agent.error &&
            agent.status === 'error' && (
              <div className="awr-chat__error">
                <AlertIcon size={14} /> {agent.error}
              </div>
            )
          ) : (
            <Composer
              controller={agent}
              showApprovalMode={showApprovalMode}
              files={files}
              dropZone={rootRef}
              {...(appHost.draft ? { draft: appHost.draft } : {})}
              {...(placeholder ? { placeholder } : {})}
              {...composer}
            />
          )}
        </div>
      </div>

      {appPanelNode &&
        (panelTarget ? (
          // Outside the chat: the theme tokens come with it.
          createPortal(
            <div
              className="awr-theme awr-apppanel"
              data-awr-theme={theme === 'auto' ? undefined : theme}
            >
              {appPanelNode}
            </div>,
            panelTarget,
          )
        ) : asSheet ? (
          <>
            <div className="awr-sheet__scrim" onClick={() => setPanelApp(undefined)} />
            <aside
              className="awr-chat__appsheet"
              role="dialog"
              aria-label={L.appFrom(panelApp!.server)}
            >
              <div className="awr-sheet__grab" />
              {appPanelNode}
            </aside>
          </>
        ) : (
          <aside className="awr-chat__apppanel">{appPanelNode}</aside>
        ))}

      {files && filesOpen && (
        <aside className={cx('awr-chat__files', classNames.files)}>
          <Files files={files} />
          <button
            type="button"
            className="awr-iconbtn awr-chat__closeside"
            aria-label={L.close}
            onClick={() => setFilesOpen(false)}
          >
            ×
          </button>
        </aside>
      )}
    </div>
  )
}
