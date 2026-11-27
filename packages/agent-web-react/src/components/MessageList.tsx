import type { ReactNode } from 'react'
import type { IUsage, VirtualFileSystem } from '@dudko.dev/agent-web'
import { useLabels, type AgentLabels, type AgentLabelsOverride } from '../labels.js'
import type { ChatAttachment, ChatMessage, MediaView, WrittenFileView } from '../types.js'
import { formatDuration, formatTokens } from './format.js'
import { BookIcon, BrainIcon, FileIcon, GlobeIcon, SpinnerIcon } from './icons.js'
import { FileChips, type FileChipsProps } from './FileChips.js'
import { GeneratedMedia, TranscriptBlock } from './Media.js'
import { StepList, type RenderToolCall } from './StepList.js'
import type { RenderSubagent } from './SubagentTree.js'

export interface MessageListProps {
  messages: ChatMessage[]
  /** Rendered when there are no messages yet. */
  empty?: ReactNode
  /** Each answer's steps, thoughts, subagents and consent decisions (default true). */
  showActivity?: boolean
  /** Each tool call inside the activity (default true). */
  showToolCalls?: boolean
  /** Tokens per answer and per tool call (default true). */
  showUsage?: boolean
  /** Thoughts (step + answer) when the model thinks (default true). */
  showThoughts?: boolean
  /** What the user said while the agent worked, under the step it reached (default true). */
  showNotes?: boolean
  /** The lessons the agent wrote down during the answer, and the pages it fetched (default true). */
  showLearned?: boolean
  /** Model tiers: the tier badges, escalation lines and the escalation count (default true). */
  showTiers?: boolean
  /** The "replanning failed, continuing with the plan" warning under a step (default true). */
  showReplanFailed?: boolean
  /** The decision model's note under a step (default true; nothing shows without one). */
  showDecisions?: boolean
  /** A `web_search` call's results as a list under its row (default true). */
  showSearchResults?: boolean
  /** The subagent tree under the step that started it (default true). */
  showSubagents?: boolean
  /**
   * What the run generated, in the answer: images inline, audio as a player - and the
   * transcripts of audio files, folded (default true). Needs `files` to show the bytes.
   */
  showMedia?: boolean
  /**
   * The files an answer wrote to the workspace, as chips under it - open (an inline preview;
   * an `.html` file in a sandboxed frame) and download (default true). Needs `files`.
   */
  showFileChips?: boolean
  /** The workspace generated and written files are read from (the core's `VirtualFileSystem`). */
  files?: VirtualFileSystem
  /** How an `.html` file is previewed (see `FileChips`); `false` shows HTML as source only. */
  htmlPreview?: FileChipsProps['htmlPreview']
  /** Adds a "Show in Files" link above the chips. */
  onShowFiles?: () => void
  /** A file chip; `fallback` is the built-in one. */
  renderFile?: (file: WrittenFileView, message: ChatMessage, fallback: ReactNode) => ReactNode
  /** A text file rendered your way (Markdown through your renderer); `undefined` = as source. */
  renderFileContent?: FileChipsProps['renderFileContent']
  /** A generated file; `fallback` is the built-in image / player / chip. */
  renderMedia?: (media: MediaView, message: ChatMessage, fallback: ReactNode) => ReactNode
  /** A node of the subagent tree (gets the built-in `<li>` as `fallback`). */
  renderSubagent?: RenderSubagent
  /** Give a running subagent a stop button (`useAgent().stopSubagent`). */
  onStopSubagent?: (id: string) => void
  /** Open the activity of finished answers too (default: only while it runs). */
  activityOpen?: boolean
  /** Extra content under the latest assistant turn while it streams (plan thought, …). */
  liveExtra?: ReactNode
  /**
   * A message's text — e.g. through your markdown renderer. Default: plain
   * text, line breaks kept.
   */
  renderContent?: (message: ChatMessage) => ReactNode
  /** A whole message; `fallback` is the built-in one, to wrap or ignore. */
  renderMessage?: (message: ChatMessage, fallback: ReactNode) => ReactNode
  /** An attachment shown with a message (thumbnail / chip by default). */
  renderAttachment?: (attachment: ChatAttachment, message: ChatMessage) => ReactNode
  /** Tool calls inside the activity. */
  renderToolCall?: RenderToolCall
  labels?: AgentLabelsOverride
  className?: string
}

/** "in 12k · out 456 · think 120 · cached 9k · 4.2 s" for one answer. */
export const usageLine = (usage: IUsage | undefined, durationMs?: number): string => {
  const parts: string[] = []
  if (usage && usage.totalTokens > 0) {
    parts.push(`in ${formatTokens(usage.inputTokens)}`, `out ${formatTokens(usage.outputTokens)}`)
    if (usage.reasoningTokens) parts.push(`think ${formatTokens(usage.reasoningTokens)}`)
    if (usage.cachedInputTokens) parts.push(`cached ${formatTokens(usage.cachedInputTokens)}`)
  }
  if (durationMs !== undefined) parts.push(formatDuration(durationMs))
  return parts.join(' · ')
}

/** The built-in attachment: an image thumbnail (opens full size) or a file chip. */
export const AttachmentView = ({ attachment: a }: { attachment: ChatAttachment }) =>
  a.dataUrl && a.mediaType.startsWith('image/') ? (
    <a href={a.dataUrl} target="_blank" rel="noreferrer" title={a.path ?? a.name}>
      <img className="awr-thumb awr-thumb--msg" src={a.dataUrl} alt={a.name} />
    </a>
  ) : (
    <span className="awr-chip awr-file" title={a.path ?? a.mediaType}>
      <FileIcon size={13} /> {a.name}
    </span>
  )

const toolCallCount = (m: ChatMessage): number =>
  (m.steps ?? []).reduce((n, s) => n + s.toolCalls.length, 0)

const activitySummary = (
  m: ChatMessage,
  showToolCalls: boolean,
  showLearned: boolean,
  showTiers: boolean,
  showFileChips: boolean,
  L: AgentLabels,
): string => {
  const steps = m.steps ?? []
  const parts = [L.steps(steps.length)]
  if (showToolCalls) parts.push(L.toolCalls(toolCallCount(m)))
  const escalations = steps.reduce((n, s) => n + (s.escalations?.length ?? 0), 0)
  if (showTiers && escalations > 0) parts.push(L.escalations(escalations))
  if (m.subagents?.length) parts.push(L.subagents(m.subagents.length))
  if (m.skills?.length) parts.push(L.skillsUsed(m.skills.join(', ')))
  if (showLearned && m.learned?.length) parts.push(L.learnedNow(m.learned.join(', ')))
  if (showLearned && m.fetches?.length) parts.push(L.fetches(m.fetches.length))
  if (showFileChips && m.writtenFiles?.length) parts.push(L.filesCount(m.writtenFiles.length))
  return parts.join(' · ')
}

/**
 * The chat transcript. User turns show their text and attachments (image
 * thumbnails, file chips); every assistant turn keeps its own activity — the
 * steps with each tool call (≈tokens, duration, returned images), thoughts,
 * subagents, consent decisions — and the tokens it spent by kind. Every part
 * can be hidden, relabelled or rendered by the host.
 */
export const MessageList = ({
  messages,
  empty,
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
  files,
  htmlPreview,
  onShowFiles,
  renderFile,
  renderFileContent,
  renderMedia,
  renderSubagent,
  onStopSubagent,
  activityOpen = false,
  liveExtra,
  renderContent,
  renderMessage,
  renderAttachment,
  renderToolCall,
  labels,
  className,
}: MessageListProps) => {
  const L = useLabels(labels)
  if (messages.length === 0) {
    return empty ? <div className="awr-messages__empty">{empty}</div> : null
  }
  return (
    <div className={['awr-messages', className].filter(Boolean).join(' ')}>
      {messages.map((m) => {
        const steps = m.steps ?? []
        const hasActivity =
          showActivity &&
          (steps.length > 0 || (m.subagents?.length ?? 0) > 0 || (m.pending && !!liveExtra))
        const usage = showUsage ? usageLine(m.usage, m.durationMs) : ''
        const node = (
          <div
            key={m.id}
            className={`awr-msg awr-msg--${m.role}${m.error ? ' awr-msg--error' : ''}${m.pending ? ' is-pending' : ''}`}
          >
            <div className="awr-msg__col">
              {m.role === 'assistant' && hasActivity && (
                <details className="awr-activity" open={m.pending || activityOpen}>
                  <summary className="awr-activity__summary">
                    {activitySummary(m, showToolCalls, showLearned, showTiers, showFileChips, L)}
                  </summary>
                  {m.pending && liveExtra}
                  <StepList
                    steps={steps}
                    subagents={m.subagents}
                    approvals={m.approvals}
                    notes={m.notes}
                    showNotes={showNotes}
                    onStopSubagent={m.pending ? onStopSubagent : undefined}
                    showToolCalls={showToolCalls}
                    showUsage={showUsage}
                    showThoughts={showThoughts}
                    showTiers={showTiers}
                    showReplanFailed={showReplanFailed}
                    showDecisions={showDecisions}
                    showSearchResults={showSearchResults}
                    showSubagents={showSubagents}
                    renderToolCall={renderToolCall}
                    renderSubagent={renderSubagent}
                    labels={labels}
                  />
                  {showLearned && m.fetches?.length ? (
                    <ul className="awr-fetches">
                      {m.fetches.map((f, i) => (
                        <li
                          key={i}
                          className={`awr-fetch${f.allowed ? '' : ' awr-fetch--refused'}`}
                        >
                          <GlobeIcon size={12} /> <code>{f.url}</code>{' '}
                          <span className="awr-fetch__result">
                            {f.allowed ? (f.status ?? 'ok') : L.fetchRefused(f.reason ?? '')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {showLearned && m.learned?.length ? (
                    <p className="awr-learned">
                      <BookIcon size={12} /> {L.learnedNow(m.learned.join(', '))}
                    </p>
                  ) : null}
                  {showThoughts && m.reasoning?.trim() && (
                    <details className="awr-thought">
                      <summary>
                        <BrainIcon size={13} /> {L.answerThoughts}
                      </summary>
                      <p className="awr-thought__text">{m.reasoning.trim()}</p>
                    </details>
                  )}
                </details>
              )}
              {showMedia && m.transcripts?.length ? (
                <div className="awr-msg__transcripts">
                  {m.transcripts.map((t, i) => (
                    <TranscriptBlock key={i} transcript={t} labels={labels} />
                  ))}
                </div>
              ) : null}
              {(m.content || m.pending || !m.attachments?.length) && (
                <div className="awr-msg__bubble">
                  {m.content ? (renderContent ? renderContent(m) : m.content) : null}
                  {m.pending && !m.content && (
                    <SpinnerIcon size={14} className="awr-msg__pending" />
                  )}
                </div>
              )}
              {showMedia && m.media?.length ? (
                <div className="awr-msg__media">
                  {m.media.map((item, i) => {
                    const built = (
                      <GeneratedMedia key={i} media={item} files={files} labels={labels} />
                    )
                    return renderMedia ? (
                      <span key={i} className="awr-msg__mediaitem">
                        {renderMedia(item, m, built)}
                      </span>
                    ) : (
                      built
                    )
                  })}
                </div>
              ) : null}
              {showFileChips && m.role === 'assistant' && m.writtenFiles?.length ? (
                <FileChips
                  written={m.writtenFiles}
                  files={files}
                  htmlPreview={htmlPreview}
                  onShowFiles={onShowFiles}
                  renderFile={renderFile ? (f, fallback) => renderFile(f, m, fallback) : undefined}
                  renderFileContent={renderFileContent}
                  labels={labels}
                />
              ) : null}
              {m.attachments?.length ? (
                <div className="awr-msg__attachments" aria-label={L.attachments}>
                  {m.attachments.map((a, i) => (
                    <span key={i} className="awr-msg__attachment">
                      {renderAttachment ? (
                        renderAttachment(a, m)
                      ) : (
                        <AttachmentView attachment={a} />
                      )}
                    </span>
                  ))}
                </div>
              ) : null}
              {m.role === 'assistant' && usage && !m.pending && (
                <div className="awr-msg__usage" title={L.usageTitle}>
                  {usage}
                </div>
              )}
            </div>
          </div>
        )
        return renderMessage ? <div key={m.id}>{renderMessage(m, node)}</div> : node
      })}
    </div>
  )
}
