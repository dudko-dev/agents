import type { ReactNode } from 'react'
import type { AppRequestAnswerOptions, AppRequestView } from '../hooks/use-mcp-app-host.js'
import { useLabels, type AgentLabelsOverride } from '../labels.js'
import { BotIcon, DownloadIcon, ExternalIcon, MessageIcon } from './icons.js'

export interface AppRequestPromptProps {
  /** Waiting requests (`useMcpAppHost().requests`; `<AgentChat mcpApps>` passes its own). */
  requests: AppRequestView[]
  /**
   * The user's answer (`useMcpAppHost().answer`): an accepted link is opened and an accepted file
   * saved on this click; `always` allows an app's sampling until the page is reloaded.
   */
  onAnswer: (id: string, accept: boolean, options?: AppRequestAnswerOptions) => void
  /** Render a request yourself (gets the built-in card as `fallback`). */
  renderRequest?: (request: AppRequestView, fallback: ReactNode) => ReactNode
  labels?: AgentLabelsOverride
  className?: string
}

/**
 * Consent cards for what an MCP App asks the host to do besides calling a tool: open a link
 * (the address with its host highlighted - what the user should check - and opened only on
 * "Open", in a new tab without an opener or a referrer), put a message in the message box
 * (shown as the app's text; accepted, it is a draft the user still sends - never sent for them),
 * save a file (its sanitized name, type and size; saved by this page only on "Save file"), or
 * ask the agent's model for an answer (the app's messages and instructions as plain text,
 * exactly what the model would get, and how much it may write). They sit with the agent's own
 * consent cards and say they come from the APP.
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
  const actions = (accept: string, decline: string, id: string, always?: string) => (
    <div className="awr-approval__actions">
      <button type="button" className="awr-btn awr-btn--primary" onClick={() => onAnswer(id, true)}>
        {accept}
      </button>
      {always && (
        <button
          type="button"
          className="awr-btn"
          onClick={() => onAnswer(id, true, { always: true })}
        >
          {always}
        </button>
      )}
      <button type="button" className="awr-btn" onClick={() => onAnswer(id, false)}>
        {decline}
      </button>
    </div>
  )
  return (
    <div className={['awr-approvals', className].filter(Boolean).join(' ')} role="alert">
      {requests.map((r) => {
        let card: ReactNode
        if (r.kind === 'link' && r.link) {
          card = (
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
              {actions(L.appLinkOpen, L.appCancel, r.id)}
            </div>
          )
        } else if (r.kind === 'download' && r.download) {
          const d = r.download
          card = (
            <div
              key={r.id}
              className="awr-approval awr-approval--app awr-approval--download"
              data-app={r.appId}
            >
              <div className="awr-approval__head">
                <DownloadIcon size={14} className="awr-approval__icon" />
                <span>{L.appDownloadLead(r.server)}</span>
              </div>
              <p className="awr-approval__file">
                <b className="awr-approval__filename">{d.name}</b>
                <span className="awr-approval__filemeta">
                  {L.appDownloadType(d.mimeType)} · {L.appDownloadSize(d.size)}
                </span>
              </p>
              <p className="awr-approval__from">
                {L.appDownloadSource(d.source, r.server)} {L.appDownloadNote}
              </p>
              {actions(L.appDownloadSave, L.appCancel, r.id)}
            </div>
          )
        } else if (r.kind === 'sampling' && r.sampling) {
          const s = r.sampling
          card = (
            <div
              key={r.id}
              className="awr-approval awr-approval--app awr-approval--sampling"
              data-app={r.appId}
            >
              <div className="awr-approval__head">
                <BotIcon size={14} className="awr-approval__icon" />
                <span>{L.appSamplingLead(r.server)}</span>
              </div>
              <div className="awr-approval__sampling">
                {s.systemPrompt && (
                  <div className="awr-approval__turn awr-approval__turn--system">
                    <span className="awr-approval__role">{L.appSamplingSystem}</span>
                    <p className="awr-approval__quote">{s.systemPrompt}</p>
                  </div>
                )}
                {s.messages.map((m, i) => (
                  <div key={i} className={`awr-approval__turn awr-approval__turn--${m.role}`}>
                    <span className="awr-approval__role">{L.appSamplingRole(m.role)}</span>
                    {m.text && <p className="awr-approval__quote">{m.text}</p>}
                    {m.images.length > 0 && (
                      <p className="awr-approval__from">{L.appSamplingImages(m.images.length)}</p>
                    )}
                  </div>
                ))}
              </div>
              <p className="awr-approval__from">
                {L.appSamplingTokens(s.maxTokens, s.requestedMaxTokens)} {L.appSamplingNote}
              </p>
              {actions(L.appSamplingAllow, L.appSamplingDeny, r.id, L.appSamplingAlways)}
            </div>
          )
        } else {
          card = (
            <div key={r.id} className="awr-approval awr-approval--app" data-app={r.appId}>
              <div className="awr-approval__head">
                <MessageIcon size={14} className="awr-approval__icon" />
                <span>{L.appMessageLead(r.server)}</span>
              </div>
              <blockquote className="awr-approval__quote">{r.text}</blockquote>
              <p className="awr-approval__from">{L.appMessageNote}</p>
              {actions(L.appMessageAccept, L.appMessageDiscard, r.id)}
            </div>
          )
        }
        return renderRequest ? <div key={r.id}>{renderRequest(r, card)}</div> : card
      })}
    </div>
  )
}
