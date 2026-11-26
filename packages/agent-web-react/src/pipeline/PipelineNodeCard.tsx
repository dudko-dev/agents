import type { PipelineNode } from '@dudko.dev/agent-web'
import { CanvasPort } from '../canvas/Canvas.js'
import { AlertIcon, BookIcon, CheckIcon, SpinnerIcon, ToolIcon } from '../components/icons.js'
import { PlugIcon, SkipIcon } from './icons.js'
import { usePipelineLabels, type PipelineLabels, type PipelineLabelsOverride } from './labels.js'
import type { PipelineNodeActivity, PipelineNodeView } from './state.js'

/** The id of the canvas port a route leaves by. */
export const routePortId = (label: string): string => `route:${label}`
/** The id of the port every other kind of edge leaves by. */
export const OUTPUT_PORT = 'out'

export interface PipelineNodeCardProps {
  node: PipelineNode
  /** Its run state (an idle one when the pipeline has not run). */
  view: PipelineNodeView
  /** It is the pipeline's entry node. */
  entry?: boolean
  /** What to show for its model instead of the name in the definition. */
  modelLabel?: string
  /** A validation error is about this node. */
  invalid?: boolean
  labels?: PipelineLabelsOverride
}

/** One line of what a running node's agent is doing. */
export const activityText = (
  activity: PipelineNodeActivity | undefined,
  labels: PipelineLabels,
): string => {
  if (!activity) return labels.activityPlanning
  if (activity.tool) return labels.activityTool(activity.tool)
  if (activity.phase === 'synthesize') return labels.activityAnswering
  if (activity.phase === 'replan') return labels.activityReplanning
  if (activity.step) {
    return labels.activityStep(activity.stepIndex ?? 1, activity.stepTotal ?? 1, activity.step)
  }
  return labels.activityPlanning
}

/**
 * A node on the canvas: its name, model, what it may use, its routes as output ports and its
 * run status. Rendered inside a canvas node (it places `<CanvasPort>`s for a node with routes).
 */
export const PipelineNodeCard = ({
  node,
  view,
  entry = false,
  modelLabel,
  invalid = false,
  labels: over,
}: PipelineNodeCardProps) => {
  const L = usePipelineLabels(over)
  const { status } = view
  const skills = node.skills?.length ?? 0
  const tools = node.tools?.length ?? 0
  const mcp = node.mcpServers?.length ?? 0
  const routes = node.routes ?? []
  const note =
    status === 'running'
      ? activityText(view.activity, L)
      : status === 'failed'
        ? view.error
        : status === 'skipped' && view.skipped
          ? L.skippedBy[view.skipped]
          : undefined
  return (
    <div
      className={`awr-pnode awr-pnode--${status}${invalid ? ' awr-pnode--invalid' : ''}`}
      data-status={status}
    >
      <div className="awr-pnode__head">
        <span className="awr-pnode__status" title={L.nodeStatus[status]}>
          {status === 'running' ? (
            <SpinnerIcon size={14} />
          ) : status === 'done' ? (
            <CheckIcon size={14} />
          ) : status === 'failed' ? (
            <AlertIcon size={14} />
          ) : status === 'skipped' ? (
            <SkipIcon size={14} />
          ) : (
            <span className="awr-pnode__dot" />
          )}
        </span>
        <span className="awr-pnode__name">{node.name || node.id}</span>
        {view.visits > 1 && <span className="awr-pnode__visits">{L.visits(view.visits)}</span>}
        {entry && <span className="awr-pnode__entry">{L.entry}</span>}
      </div>
      <div className="awr-pnode__meta">
        <span className={`awr-pnode__model${node.model ? '' : ' awr-pnode__model--default'}`}>
          {modelLabel ?? node.model ?? L.defaultModel}
        </span>
        {skills > 0 && (
          <span className="awr-pnode__badge" title={L.skillsBadge(skills)}>
            <BookIcon size={12} />
            {skills}
            <span className="awr-pipeline__sr">{L.skillsBadge(skills)}</span>
          </span>
        )}
        {tools > 0 && (
          <span className="awr-pnode__badge" title={L.toolsBadge(tools)}>
            <ToolIcon size={12} />
            {tools}
            <span className="awr-pipeline__sr">{L.toolsBadge(tools)}</span>
          </span>
        )}
        {mcp > 0 && (
          <span className="awr-pnode__badge" title={L.mcpBadge(mcp)}>
            <PlugIcon size={12} />
            {mcp}
            <span className="awr-pipeline__sr">{L.mcpBadge(mcp)}</span>
          </span>
        )}
      </div>
      {note && <div className="awr-pnode__note">{note}</div>}
      {routes.length > 0 && (
        <ul className="awr-pnode__routes">
          {routes.map((route) => (
            <li key={route.label} className="awr-pnode__route" title={route.description}>
              <span className="awr-pnode__route-label">{route.label}</span>
              <CanvasPort id={routePortId(route.label)} label={route.label} />
            </li>
          ))}
          <li className="awr-pnode__route awr-pnode__route--any">
            <span className="awr-pnode__route-label">{L.anyOutput}</span>
            <CanvasPort id={OUTPUT_PORT} label={L.anyOutput} />
          </li>
        </ul>
      )}
    </div>
  )
}
