import type { IUsage } from '@dudko.dev/agent-web'
import { useLabels, type AgentLabelsOverride } from '../labels.js'
import { formatTokens } from './format.js'

export interface UsageBadgeProps {
  usage: IUsage
  /** Only in ↑ out ↓ (the rest stays in the tooltip) — for tight headers. */
  compact?: boolean
  /**
   * Calls that are not tokens - to the media models and to the decision model - when there were
   * any (default true).
   */
  showCalls?: boolean
  labels?: AgentLabelsOverride
  className?: string
}

/**
 * A compact token-usage readout: in ↑ out ↓, plus thinking (🧠) and cache-hit
 * tokens when the provider reported any, and the media / decision calls when the run made
 * some. The full breakdown is on hover.
 */
export const UsageBadge = ({
  usage,
  compact = false,
  showCalls = true,
  labels,
  className,
}: UsageBadgeProps) => {
  const L = useLabels(labels)
  const media = showCalls ? (usage.mediaCalls ?? 0) : 0
  const decisions = showCalls ? (usage.decisionCalls ?? 0) : 0
  if (usage.totalTokens === 0 && media === 0 && decisions === 0) return null
  const reasoning = usage.reasoningTokens ?? 0
  const cached = usage.cachedInputTokens ?? 0
  const title = [
    `${usage.inputTokens} in + ${usage.outputTokens} out = ${usage.totalTokens} tokens`,
    reasoning ? `${reasoning} thinking` : '',
    cached ? `${cached} input tokens from the prompt cache` : '',
    media ? L.usageMedia(media) : '',
    decisions ? L.usageDecisions(decisions) : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className={['awr-usage', className].filter(Boolean).join(' ')} title={title}>
      {formatTokens(usage.inputTokens)}↑ {formatTokens(usage.outputTokens)}↓
      {!compact && reasoning > 0 && ` · ${formatTokens(reasoning)} think`}
      {!compact && cached > 0 && ` · ${formatTokens(cached)} cached`}
      {!compact && media > 0 && ` · ${L.usageMedia(media)}`}
      {!compact && decisions > 0 && ` · ${L.usageDecisions(decisions)}`}
    </span>
  )
}
