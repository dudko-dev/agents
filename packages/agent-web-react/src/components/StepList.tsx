import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { useLabels, type AgentLabels, type AgentLabelsOverride } from '../labels.js'
import type {
  ApprovalView,
  DecisionView,
  StepView,
  SubagentView,
  ToolCallView,
  UserNoteView,
} from '../types.js'
import {
  formatDuration,
  formatProbability,
  formatTokens,
  imagesInOutput,
  previewValue,
  webSearchOf,
} from './format.js'
import {
  AlertIcon,
  AppIcon,
  ArrowUpIcon,
  BrainIcon,
  CheckIcon,
  GlobeIcon,
  SendIcon,
  ShieldIcon,
  SpinnerIcon,
  ToolIcon,
} from './icons.js'
import { SubagentTree, type RenderSubagent } from './SubagentTree.js'

/** Render a tool call yourself; `fallback` is the built-in `<li>` row — return it, or your own `<li>`. */
export type RenderToolCall = (call: ToolCallView, fallback: ReactNode) => ReactNode

export interface ToolCallRowProps {
  call: ToolCallView
  showUsage?: boolean
  /**
   * Mark a call of an escalated attempt ("attempt 1") and a write that was not run a second
   * time (default true). Nothing shows without model tiers.
   */
  showTiers?: boolean
  /**
   * A `web_search` call's results as a short list under the row: the query, then title + host
   * of each result as a link and its snippet as plain text (default true).
   */
  showSearchResults?: boolean
  labels?: AgentLabelsOverride
}

/** The name of the core's search tool (its `WEB_SEARCH_TOOL`). */
const WEB_SEARCH = 'web_search'

/**
 * One tool call: name, arguments, status — and optionally its cost, any images it returned and,
 * for a web search, what it found.
 */
export const ToolCallRow = ({
  call,
  showUsage = true,
  showTiers = true,
  showSearchResults = true,
  labels,
}: ToolCallRowProps) => {
  const L = useLabels(labels)
  const state = call.status === 'calling' ? 'calling' : call.ok === false ? 'failed' : 'ok'
  const images = call.ok === false ? [] : imagesInOutput(call.output).slice(0, 4)
  const search =
    showSearchResults && call.name === WEB_SEARCH && call.status === 'done' && call.ok !== false
      ? webSearchOf(call.output)
      : undefined
  const cost = [
    call.inputTokens ? `≈${formatTokens(call.inputTokens)} in` : '',
    call.outputTokens ? `≈${formatTokens(call.outputTokens)} out` : '',
    call.durationMs !== undefined ? formatDuration(call.durationMs) : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li
      className={`awr-tool awr-tool--${state}${showTiers && call.attempt !== undefined ? ' awr-tool--earlier' : ''}`}
    >
      <div className="awr-tool__row">
        <ToolIcon size={13} className="awr-tool__icon" />
        <code className="awr-tool__name">{call.name}</code>
        {previewValue(call.input) && (
          <span className="awr-tool__args">{previewValue(call.input)}</span>
        )}
        {call.status === 'calling' && <SpinnerIcon size={12} className="awr-tool__spin" />}
        {call.status === 'done' && call.ok === false && (
          <span className="awr-tool__badge">{L.failed}</span>
        )}
        {showTiers && call.replayed && (
          <span className="awr-tool__tag" title={L.replayedTitle}>
            {L.replayed}
          </span>
        )}
        {showTiers && call.attempt !== undefined && (
          <span className="awr-tool__tag">{L.attemptTag(call.attempt)}</span>
        )}
        {call.app && (
          <span className="awr-tool__tag awr-tool__tag--app" data-app={call.app}>
            <AppIcon size={10} /> {L.appTag}
          </span>
        )}
        {showUsage && cost && (
          <span className="awr-tool__cost" title={L.toolCostTitle}>
            {cost}
          </span>
        )}
      </div>
      {images.length > 0 && (
        <div className="awr-tool__images">
          {images.map((src, i) => (
            <a key={i} href={src} target="_blank" rel="noreferrer">
              <img className="awr-thumb" src={src} alt={`${call.name} result ${i + 1}`} />
            </a>
          ))}
        </div>
      )}
      {search && (
        <div className="awr-search">
          <p className="awr-search__query">
            <GlobeIcon size={12} /> {L.searchQuery} <q>{search.query}</q>
          </p>
          {search.results.length > 0 ? (
            <ol className="awr-search__results">
              {search.results.map((r, i) => (
                <li key={i} className="awr-search__result">
                  {/* Third-party text: React text nodes only, never markup. */}
                  <a
                    className="awr-search__title"
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {r.title}
                  </a>{' '}
                  <span className="awr-search__host">
                    {r.host}
                    {r.date ? ` · ${r.date}` : ''}
                  </span>
                  {r.snippet && <p className="awr-search__snippet">{r.snippet}</p>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="awr-search__note">{L.searchNoResults}</p>
          )}
          {(search.filtered > 0 || search.truncated) && (
            <p className="awr-search__note">
              {[
                search.filtered > 0 ? L.searchFiltered(search.filtered) : '',
                search.truncated ? L.searchTruncated : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

/** What the user said while the run was going, and where it reached the agent. */
export const UserNoteRow = ({
  note,
  labels,
}: {
  note: UserNoteView
  labels?: AgentLabelsOverride
}) => {
  const L = useLabels(labels)
  return (
    <li className={`awr-note awr-note--${note.at}`}>
      <SendIcon size={12} className="awr-note__icon" />
      <span className="awr-note__where">{L.noteAt[note.at]}</span>
      <q className="awr-note__text">{note.text}</q>
    </li>
  )
}

/** "decision model: continue (0.93)" / "decision model fell back: low confidence (0.41 < 0.8)". */
export const decisionNote = (d: DecisionView, L: AgentLabels): string => {
  if (d.accepted) {
    return L.decisionAccepted(
      d.choice ?? '',
      d.confidence !== undefined ? formatProbability(d.confidence) : '',
    )
  }
  const detail =
    d.reason === 'low-confidence' && d.confidence !== undefined
      ? `${formatProbability(d.confidence)} < ${formatProbability(d.threshold)}`
      : ''
  return L.decisionFellBack(d.reason ? L.decisionReasons[d.reason] : '', detail)
}

const decisionLabel = (a: ApprovalView, L: AgentLabels): string =>
  a.status === 'pending'
    ? L.consentWaiting
    : a.status === 'approved'
      ? L.consentAllowed
      : L.consentDenied(a.reason)

interface StepItemProps {
  step: StepView
  subagents: SubagentView[]
  approvals: ApprovalView[]
  notes: UserNoteView[]
  onStopSubagent?: (id: string) => void
  showToolCalls: boolean
  showUsage: boolean
  showThoughts: boolean
  showTiers: boolean
  showReplanFailed: boolean
  showDecisions: boolean
  showSearchResults: boolean
  showSubagents: boolean
  renderToolCall?: RenderToolCall
  renderSubagent?: RenderSubagent
  L: AgentLabels
}

const StepItem = ({
  step,
  subagents,
  approvals,
  notes,
  onStopSubagent,
  showToolCalls,
  showUsage,
  showThoughts,
  showTiers,
  showReplanFailed,
  showDecisions,
  showSearchResults,
  showSubagents,
  renderToolCall,
  renderSubagent,
  L,
}: StepItemProps) => (
  <li className={`awr-step awr-step--${step.blocked ? 'blocked' : step.status}`}>
    <div className="awr-step__head">
      <span className="awr-step__marker">
        {step.status === 'running' ? (
          <SpinnerIcon size={14} />
        ) : step.blocked ? (
          <AlertIcon size={14} />
        ) : (
          <CheckIcon size={14} />
        )}
      </span>
      <span className="awr-step__index">
        {step.index}/{step.total}
      </span>
      <span className="awr-step__desc">{step.step.description}</span>
    </div>
    {showTiers && step.tier && (
      <div className="awr-step__meta">
        <span
          className={`awr-step__tier awr-step__tier--${step.tier}`}
          title={step.tierReason ? L.tierReasons[step.tierReason] : undefined}
        >
          {L.tierNames[step.tier]}
        </span>
        {step.model && <span className="awr-step__model">{step.model}</span>}
      </div>
    )}
    {showTiers &&
      step.escalations?.map((e, i) => (
        <div key={i} className="awr-step__escalated">
          <p className="awr-step__escalated-line">
            <ArrowUpIcon size={12} />
            <span>
              {L.escalated(L.tierNames[e.from], L.tierNames[e.to], L.escalationReasons[e.reason])}
            </span>
          </p>
          {e.text?.trim() && (
            <details className="awr-step__attempt">
              <summary>{L.escalatedAttemptText}</summary>
              <p className="awr-step__text">{e.text.trim()}</p>
            </details>
          )}
        </div>
      ))}
    {showThoughts && step.reasoning.trim() && (
      <details className="awr-thought" open={step.status === 'running' && !step.text}>
        <summary>
          <BrainIcon size={13} /> {L.stepThoughts}
        </summary>
        <p className="awr-thought__text">{step.reasoning.trim()}</p>
      </details>
    )}
    {step.text.trim() && <p className="awr-step__text">{step.text.trim()}</p>}
    {showToolCalls && step.toolCalls.length > 0 && (
      <ul className="awr-step__tools">
        {step.toolCalls.map((call, i) => {
          const row = (
            <ToolCallRow
              key={i}
              call={call}
              showUsage={showUsage}
              showTiers={showTiers}
              showSearchResults={showSearchResults}
            />
          )
          return renderToolCall ? <Fragment key={i}>{renderToolCall(call, row)}</Fragment> : row
        })}
      </ul>
    )}
    {approvals.length > 0 && (
      <ul className="awr-step__tools">
        {approvals.map((a) => (
          <li key={a.id} className={`awr-tool awr-tool__row awr-tool--approval-${a.status}`}>
            <ShieldIcon size={13} className="awr-tool__icon" />
            <code className="awr-tool__name">{a.name}</code>
            <span className="awr-tool__args">{decisionLabel(a, L)}</span>
            {a.subagent && <span className="awr-tool__tag">{L.subagentHelper}</span>}
          </li>
        ))}
      </ul>
    )}
    {showSubagents && (
      <SubagentTree
        subagents={subagents}
        onStop={onStopSubagent}
        showUsage={showUsage}
        renderSubagent={renderSubagent}
      />
    )}
    {notes.length > 0 && (
      <ul className="awr-notes">
        {notes.map((n) => (
          <UserNoteRow key={n.id} note={n} />
        ))}
      </ul>
    )}
    {step.blocked && step.summary && <p className="awr-step__blocked">{step.summary}</p>}
    {showReplanFailed && step.replanFailed && (
      <p className="awr-step__warn" title={step.replanFailed}>
        <AlertIcon size={12} /> {L.replanFailed}
      </p>
    )}
    {showDecisions &&
      step.decisions?.map((d, i) => (
        <p
          key={i}
          className={`awr-step__decision${d.accepted ? '' : ' awr-step__decision--fallback'}`}
          title={d.model}
        >
          {decisionNote(d, L)}
        </p>
      ))}
  </li>
)

export interface StepListProps {
  steps: StepView[]
  /** Subagent delegations (`agent.subagents`) — shown under the step that made them. */
  subagents?: SubagentView[]
  /** Consent decisions (`agent.approvals`) — shown under their step. */
  approvals?: ApprovalView[]
  /** What the user said mid-run (`agent.notes`) — shown under the step it reached. */
  notes?: UserNoteView[]
  /** Show those notes (default true). */
  showNotes?: boolean
  /** Give a running subagent a stop button (`agent.stopSubagent`). */
  onStopSubagent?: (id: string) => void
  /** The subagent tree under the step that started it (default true). */
  showSubagents?: boolean
  /** Render a node of the subagent tree yourself (gets the built-in `<li>` as `fallback`). */
  renderSubagent?: RenderSubagent
  /** Show each tool call (default true). */
  showToolCalls?: boolean
  /** Show each tool call's ≈tokens and duration (default true). */
  showUsage?: boolean
  /** Show each step's thoughts when the model thinks (default true). */
  showThoughts?: boolean
  /**
   * Model tiers: the tier / model badge on a step, its "escalated: light → strong" line and the
   * marks on the earlier attempt's tool calls (default true; nothing shows when tiers are off).
   */
  showTiers?: boolean
  /** The "replanning failed, continuing with the plan" warning under a step (default true). */
  showReplanFailed?: boolean
  /**
   * The decision model's note under the step it was asked after - "decision model: continue
   * (0.93)" (default true; nothing shows without `decisionModel`).
   */
  showDecisions?: boolean
  /** A `web_search` call's results as a list under its row (default true). */
  showSearchResults?: boolean
  /** Render tool calls yourself (gets the built-in row as `fallback`). */
  renderToolCall?: RenderToolCall
  labels?: AgentLabelsOverride
  className?: string
}

/**
 * The live execution: each step, its thoughts, streamed text, tool calls,
 * consent decisions and subagent delegations.
 */
export const StepList = ({
  steps,
  subagents = [],
  approvals = [],
  notes = [],
  showNotes = true,
  onStopSubagent,
  showToolCalls = true,
  showUsage = true,
  showThoughts = true,
  showTiers = true,
  showReplanFailed = true,
  showDecisions = true,
  showSearchResults = true,
  showSubagents = true,
  renderToolCall,
  renderSubagent,
  labels,
  className,
}: StepListProps) => {
  const L = useLabels(labels)
  if (steps.length === 0) return null
  const known = new Set(steps.map((s) => s.id))
  // A note tied to a step shows under it; one said before the answer (or whose step is
  // gone) shows at the end.
  const atEnd = showNotes ? notes.filter((n) => !n.stepId || !known.has(n.stepId)) : []
  // A subagent is drawn under the step that delegated it (its own subagents come with it: they
  // carry the same step). One whose step is not known is drawn at the end rather than lost.
  const loose = showSubagents ? subagents.filter((s) => !s.stepId || !known.has(s.stepId)) : []
  return (
    <ol className={['awr-steps', className].filter(Boolean).join(' ')}>
      {steps.map((step) => (
        <StepItem
          key={step.id}
          step={step}
          subagents={subagents.filter((s) => s.stepId === step.id)}
          approvals={approvals.filter((a) => a.stepId === step.id && a.status !== 'pending')}
          notes={showNotes ? notes.filter((n) => n.stepId === step.id) : []}
          onStopSubagent={onStopSubagent}
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
          L={L}
        />
      ))}
      {loose.length > 0 && (
        <li className="awr-step awr-step--subagents">
          <SubagentTree
            subagents={loose}
            onStop={onStopSubagent}
            showUsage={showUsage}
            renderSubagent={renderSubagent}
          />
        </li>
      )}
      {atEnd.length > 0 && (
        <li className="awr-step awr-step--notes">
          <ul className="awr-notes">
            {atEnd.map((n) => (
              <UserNoteRow key={n.id} note={n} />
            ))}
          </ul>
        </li>
      )}
    </ol>
  )
}
