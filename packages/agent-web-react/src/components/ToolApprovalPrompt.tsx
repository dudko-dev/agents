import type { ReactNode } from 'react'
import { useLabels, type AgentLabels, type AgentLabelsOverride } from '../labels.js'
import type { ApprovalView, SkillConsentView } from '../types.js'
import { previewValue } from './format.js'
import { ShieldIcon } from './icons.js'

export interface ToolApprovalPromptProps {
  /** Pending requests (e.g. `agent.pendingApprovals`). */
  approvals: ApprovalView[]
  onApprove: (id: string, options?: { remember?: boolean }) => void
  onDeny: (id: string, reason?: string) => void
  /**
   * Offer "Always allow" (remembers the tool for the agent's life) - and, on a request about an
   * MCP server's skill, "Always for this server" (that server's skills for the agent's life,
   * nested ones excepted). Default true.
   */
  allowRemember?: boolean
  /**
   * On a request about an MCP server's skill: the collapsible preview of the instructions the
   * model would read (plain text). Default true.
   */
  showSkillPreview?: boolean
  /** Say which helper is asking when the call is a helper's, not the run's own (default true). */
  showHelper?: boolean
  /** Render a request yourself (gets the built-in card as `fallback`). */
  renderApproval?: (approval: ApprovalView, fallback: ReactNode) => ReactNode
  labels?: AgentLabelsOverride
  className?: string
}

/**
 * The card for a request about an MCP server's skill (`approval.skill`): which server offers
 * which skill, its description, size and files, and - collapsed - the very text the model would
 * read. Every string of the server's is a text node in a box captioned as the server's.
 */
const SkillConsentCard = ({
  approval: a,
  skill,
  helper,
  L,
  allowRemember,
  showPreview,
  onApprove,
  onDeny,
}: {
  approval: ApprovalView
  skill: SkillConsentView
  helper: ApprovalView['subagent']
  L: AgentLabels
  allowRemember: boolean
  showPreview: boolean
  onApprove: ToolApprovalPromptProps['onApprove']
  onDeny: ToolApprovalPromptProps['onDeny']
}) => (
  <div
    className={`awr-approval awr-approval--skill${helper ? ' awr-approval--helper' : ''}`}
    data-skill={skill.name}
    data-skill-server={skill.server}
    data-subagent={helper?.id}
  >
    <div className="awr-approval__head">
      <ShieldIcon size={14} className="awr-approval__icon" />
      <span>{L.skillConsentLead(skill.server, skill.skill)}</span>
    </div>
    {skill.description && <p className="awr-approval__quote">{skill.description}</p>}
    <p className="awr-approval__skillmeta">
      <code className="awr-tool__name">{skill.name}</code>
      <span>{L.skillConsentSize(skill.size, skill.fileCount)}</span>
    </p>
    {skill.byUri && <p className="awr-approval__from">{L.skillConsentByUri}</p>}
    {skill.nestedIn && (
      <p className="awr-approval__from awr-approval__nested">
        {L.skillConsentNested(skill.nestedIn)}
      </p>
    )}
    {showPreview && skill.body !== undefined && (
      <details className="awr-approval__preview">
        <summary>{L.skillConsentPreview}</summary>
        <pre className="awr-approval__quote awr-approval__body">{skill.body}</pre>
        {skill.files.length > 0 && (
          <p className="awr-approval__from">
            {L.skillConsentFiles(skill.files.join(', '), skill.fileCount - skill.files.length)}
          </p>
        )}
      </details>
    )}
    <p className="awr-approval__from">{L.skillConsentNote(skill.server, skill.consent)}</p>
    <div className="awr-approval__actions">
      <button type="button" className="awr-btn awr-btn--primary" onClick={() => onApprove(a.id)}>
        {L.skillConsentAllow}
      </button>
      {allowRemember && (
        <button
          type="button"
          className="awr-btn"
          onClick={() => onApprove(a.id, { remember: true })}
        >
          {L.skillConsentAlways}
        </button>
      )}
      <button
        type="button"
        className="awr-btn awr-btn--danger"
        onClick={() => onDeny(a.id, L.skillConsentDeclined)}
      >
        {L.skillConsentDeny}
      </button>
    </div>
  </div>
)

/**
 * Consent cards for tool calls the agent wants to make — "Allow once",
 * "Always allow" and "Deny" - and for an MCP server's skill about to enter the agent's context
 * ("Allow once", "Always for this server", "Deny"). Wire it to {@link useAgent}'s
 * `pendingApprovals`, `approve` and `deny`; `<AgentChat>` renders it for you.
 */
export const ToolApprovalPrompt = ({
  approvals,
  onApprove,
  onDeny,
  allowRemember = true,
  showSkillPreview = true,
  showHelper = true,
  renderApproval,
  labels,
  className,
}: ToolApprovalPromptProps) => {
  const L = useLabels(labels)
  if (approvals.length === 0) return null
  return (
    <div className={['awr-approvals', className].filter(Boolean).join(' ')} role="alert">
      {approvals.map((a) => {
        if (a.skill) {
          const card = (
            <SkillConsentCard
              key={a.id}
              approval={a}
              skill={a.skill}
              helper={showHelper ? a.subagent : undefined}
              L={L}
              allowRemember={allowRemember}
              showPreview={showSkillPreview}
              onApprove={onApprove}
              onDeny={onDeny}
            />
          )
          return renderApproval ? <div key={a.id}>{renderApproval(a, card)}</div> : card
        }
        // A helper's role is text the model wrote: shown as plain text, shortened.
        const helper = showHelper ? a.subagent : undefined
        // An MCP App asks, not the agent: said in the lead, with the server's own tool name.
        const app = a.app
        const card = (
          <div
            key={a.id}
            className={`awr-approval${helper ? ' awr-approval--helper' : ''}${app ? ' awr-approval--app' : ''}`}
            data-subagent={helper?.id}
            data-app-server={app?.server}
          >
            <div className="awr-approval__head">
              <ShieldIcon size={14} className="awr-approval__icon" />
              <span>
                {app
                  ? L.approvalLeadApp(app.server)
                  : helper
                    ? L.approvalLeadHelper(
                        previewValue(helper.role ?? '', 60) || undefined,
                        helper.depth,
                      )
                    : L.approvalLead}{' '}
                <code className="awr-tool__name">{app ? app.tool : a.name}</code>
                {a.readOnly && !app ? ` (${L.readOnlyTool})` : ''}
              </span>
            </div>
            {previewValue(a.input, 300) && (
              <pre className="awr-approval__input">{previewValue(a.input, 300)}</pre>
            )}
            {app && (
              <p className="awr-approval__from">{L.approvalFromApp(app.server, a.readOnly)}</p>
            )}
            <div className="awr-approval__actions">
              <button
                type="button"
                className="awr-btn awr-btn--primary"
                onClick={() => onApprove(a.id)}
              >
                {L.approve}
              </button>
              {allowRemember && (
                <button
                  type="button"
                  className="awr-btn"
                  onClick={() => onApprove(a.id, { remember: true })}
                >
                  {L.alwaysAllow}
                </button>
              )}
              <button
                type="button"
                className="awr-btn awr-btn--danger"
                onClick={() => onDeny(a.id, L.declinedReason)}
              >
                {L.deny}
              </button>
            </div>
          </div>
        )
        return renderApproval ? <div key={a.id}>{renderApproval(a, card)}</div> : card
      })}
    </div>
  )
}
