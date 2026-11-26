import { Fragment, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useLabels, type AgentLabelsOverride } from '../labels.js'
import { subagentTree } from '../state.js'
import type { SubagentNode, SubagentView } from '../types.js'
import { formatDuration, formatTokens, previewValue } from './format.js'
import { AlertIcon, BotIcon, SpinnerIcon, StopIcon } from './icons.js'

/** Render a node yourself; `fallback` is the built-in `<li>` (with its children) — return it, or your own `<li>`. */
export type RenderSubagent = (node: SubagentNode, fallback: ReactNode) => ReactNode

/** Seconds a running node has been going, ticking; nothing without a start time. */
const useElapsed = (startedAt: number | undefined, running: boolean): number | undefined => {
  const [now, setNow] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!running || startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, startedAt])
  return running && startedAt !== undefined && now !== undefined
    ? Math.max(0, now - startedAt)
    : undefined
}

export interface SubagentRowProps {
  sub: SubagentView
  /** Stop this subagent (`useAgent().stopSubagent`); the button shows while it runs. */
  onStop?: (id: string) => void
  /** Its status line: status, model, tokens, tool calls, time (default true). */
  showUsage?: boolean
  /** The tools a helper was given (default true). */
  showTools?: boolean
  labels?: AgentLabelsOverride
  /** The subagents this one started (the tree puts them here). */
  children?: ReactNode
}

/**
 * One subagent - a static one or a helper the model started: who it is, its task, its status
 * with the model, tokens and time, what it is doing, and its answer when done. With `onStop`,
 * a running one gets a stop button (the run and its siblings go on).
 */
export const SubagentRow = ({
  sub,
  onStop,
  showUsage = true,
  showTools = true,
  labels,
  children,
}: SubagentRowProps) => {
  const L = useLabels(labels)
  const running = sub.status === 'running'
  const elapsed = useElapsed(sub.startedAt, running)
  const time = sub.durationMs ?? elapsed
  // A helper's role is what the model wrote for it: plain text, shown as its name.
  const role = sub.dynamic ? previewValue(sub.role ?? '', 48) : ''
  const meta = [
    sub.model ?? '',
    sub.tier ? L.tierNames[sub.tier] : '',
    sub.usage.totalTokens > 0 ? L.subagentTokens(formatTokens(sub.usage.totalTokens)) : '',
    sub.toolCalls > 0 ? L.toolCalls(sub.toolCalls) : '',
    time !== undefined ? formatDuration(time) : '',
  ].filter(Boolean)
  return (
    <li
      className={`awr-subagent awr-subagent--${sub.status}${sub.dynamic ? ' awr-subagent--dynamic' : ''}`}
      data-depth={sub.depth}
    >
      <div className="awr-subagent__head">
        <span className="awr-subagent__icon">
          {running ? (
            <SpinnerIcon size={13} />
          ) : sub.status === 'done' ? (
            <BotIcon size={13} />
          ) : sub.status === 'stopped' ? (
            <StopIcon size={13} />
          ) : (
            <AlertIcon size={13} />
          )}
        </span>
        <span className="awr-subagent__name" title={sub.role}>
          {role || (sub.dynamic ? L.subagentHelper : sub.name)}
        </span>
        {sub.dynamic && role && <span className="awr-subagent__profile">{L.subagentHelper}</span>}
        {sub.profile && <span className="awr-subagent__profile">{sub.profile}</span>}
        <span className="awr-subagent__task" title={sub.task}>
          {previewValue(sub.task, 90)}
        </span>
        {running && onStop && (
          <button
            type="button"
            className="awr-iconbtn awr-subagent__stop"
            aria-label={L.stopSubagent}
            title={L.stopSubagent}
            onClick={() => onStop(sub.id)}
          >
            <StopIcon size={12} />
          </button>
        )}
      </div>
      {showUsage && (
        <div className="awr-subagent__meta">
          <span className="awr-subagent__status">{L.subagentStatus[sub.status]}</span>
          {meta.map((part, i) => (
            <span key={i} className="awr-subagent__metaitem">
              {part}
            </span>
          ))}
        </div>
      )}
      {showTools && sub.tools && (
        <div className="awr-subagent__tools">
          {sub.tools.length > 0 ? L.subagentTools(sub.tools.join(', ')) : L.subagentNoTools}
        </div>
      )}
      <div className="awr-subagent__activity">
        {sub.status === 'error'
          ? sub.error
          : sub.status === 'stopped'
            ? L.subagentStopped
            : sub.status === 'done'
              ? previewValue(sub.text, 160)
              : `${sub.activity}${!showUsage && sub.toolCalls ? ` · ${L.toolCalls(sub.toolCalls)}` : ''}`}
      </div>
      {children}
    </li>
  )
}

export interface SubagentTreeProps {
  /**
   * The subagents to draw (`agent.subagents`, or a message's): static subagents and the helpers
   * the model started, at any depth. The flat list is nested by `parentId`.
   */
  subagents: SubagentView[]
  /** Give each running node a stop button (`useAgent().stopSubagent`). */
  onStop?: (id: string) => void
  /** Each node's status line: status, model, tokens, tool calls, time (default true). */
  showUsage?: boolean
  /** The tools each helper was given (default true). */
  showTools?: boolean
  /** Render a node yourself (gets the built-in `<li>` as `fallback`). */
  renderSubagent?: RenderSubagent
  labels?: AgentLabelsOverride
  className?: string
}

/**
 * The run's subagents as an indented tree: each node with its status, model, tokens and time,
 * what it is doing, and - while it runs - a stop button. A helper's own helpers sit under it.
 * Renders nothing when there are none.
 */
export const SubagentTree = ({
  subagents,
  onStop,
  showUsage = true,
  showTools = true,
  renderSubagent,
  labels,
  className,
}: SubagentTreeProps) => {
  if (subagents.length === 0) return null
  const branch = (nodes: SubagentNode[], nested: boolean): ReactNode => (
    <ul
      className={['awr-subagents', nested ? 'awr-subagents--nested' : className]
        .filter(Boolean)
        .join(' ')}
    >
      {nodes.map((node) => {
        const row = (
          <SubagentRow
            key={node.id}
            sub={node}
            onStop={onStop}
            showUsage={showUsage}
            showTools={showTools}
            labels={labels}
          >
            {node.children.length > 0 ? branch(node.children, true) : null}
          </SubagentRow>
        )
        return renderSubagent ? <Fragment key={node.id}>{renderSubagent(node, row)}</Fragment> : row
      })}
    </ul>
  )
  return branch(subagentTree(subagents), false)
}
