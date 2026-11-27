import type { ReactNode } from 'react'
import type { AppRequestView } from '../hooks/use-mcp-app-host.js'
import { useLabels, type AgentLabelsOverride } from '../labels.js'
import { ExternalIcon, MessageIcon } from './icons.js'

export interface AppRequestPromptProps {
  /** Waiting requests (`useMcpAppHost().requests`; `<AgentChat mcpApps>` passes its own). */
  requests: AppRequestView[]
  /** The user's answer (`useMcpAppHost().answer`): an accepted link is opened on this click. */
  onAnswer: (id: string, accept: boolean) => void
  /** Render a request yourself (gets the built-in card as `fallback`). */
  renderRequest?: (request: AppRequestView, fallback: ReactNode) => ReactNode
  labels?: AgentLabelsOverride
  className?: string
}

/**
 * Consent cards for what an MCP App asks the host to do besides calling a tool: open a link
 * (the address with its host highlighted - what the user should check - and opened only on
 * "Open", in a new tab without an opener or a referrer), or put a message in the message box
 * (shown as the app's text; accepted, it is a draft the user still sends - never sent for them).
 * They sit with the agent's own consent cards and say they come from the APP.
 */
export const AppRequestPrompt = ({
  requests,
  onAnswer,
  renderRequest,
  labels,
  className,
}: AppRequestPromptProps) => {
  const L = useLabels(labels)
  if (requests.length === 0) return null
  return (
    <div className={['awr-approvals', className].filter(Boolean).join(' ')} role="alert">
      {requests.map((r) => {
        const card =
          r.kind === 'link' && r.link ? (
            <div key={r.id} className="awr-approval awr-approval--app" data-app={r.appId}>
              <div className="awr-approval__head">
                <ExternalIcon size={14} className="awr-approval__icon" />
                <span>{L.appLinkLead(r.server)}</span>
              </div>
              <p className="awr-approval__url">
                {r.link.scheme}
                <b>{r.link.host}</b>
                {r.link.rest}
              </p>
              <p className="awr-approval__from">{L.appLinkNote}</p>
              <div className="awr-approval__actions">
                <button
                  type="button"
                  className="awr-btn awr-btn--primary"
                  onClick={() => onAnswer(r.id, true)}
                >
                  {L.appLinkOpen}
                </button>
                <button type="button" className="awr-btn" onClick={() => onAnswer(r.id, false)}>
                  {L.appCancel}
                </button>
              </div>
            </div>
          ) : (
            <div key={r.id} className="awr-approval awr-approval--app" data-app={r.appId}>
              <div className="awr-approval__head">
                <MessageIcon size={14} className="awr-approval__icon" />
                <span>{L.appMessageLead(r.server)}</span>
              </div>
              <blockquote className="awr-approval__quote">{r.text}</blockquote>
              <p className="awr-approval__from">{L.appMessageNote}</p>
              <div className="awr-approval__actions">
                <button
                  type="button"
                  className="awr-btn awr-btn--primary"
                  onClick={() => onAnswer(r.id, true)}
                >
                  {L.appMessageAccept}
                </button>
                <button type="button" className="awr-btn" onClick={() => onAnswer(r.id, false)}>
                  {L.appMessageDiscard}
                </button>
              </div>
            </div>
          )
        return renderRequest ? <div key={r.id}>{renderRequest(r, card)}</div> : card
      })}
    </div>
  )
}
