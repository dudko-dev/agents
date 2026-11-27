import { useEffect, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  elicitationFields,
  elicitationFormAnswer,
  elicitationInitialDraft,
  elicitationLink,
  formatCountdown,
  type ElicitationDraft,
  type ElicitationDraftValue,
  type ElicitationField,
  type ElicitationIssue,
  type PendingElicitation,
} from '../elicitation.js'
import { useLabels, type AgentLabels, type AgentLabelsOverride } from '../labels.js'
import type { McpElicitationResult } from '../mcp-types.js'
import type { ElicitationView } from '../types.js'
import { previewValue } from './format.js'
import { AlertIcon, ExternalIcon, QuestionIcon, XIcon } from './icons.js'

export interface ElicitationPromptProps {
  /**
   * The questions waiting for the user (`useMcp().pendingElicitations` /
   * `useMcpServers().pendingElicitations`, or the requests your own `onElicitation` was given).
   * One is shown at a time, with a count.
   */
  elicitations: PendingElicitation[]
  /**
   * The user's decision: `accept` (with the form's values, or a link the user opened and
   * finished), `decline` or `cancel`. Wire it to the hook's `answerElicitation`. The values go
   * to this callback and nowhere else.
   */
  onAnswer: (id: string, result: McpElicitationResult) => void
  /**
   * The run's questions as the reducer keeps them (`useAgent().elicitations`): the ones that
   * were answered without anybody deciding - a timeout, a stopped run, a cap - are said so.
   */
  outcomes?: ElicitationView[]
  /** Say which questions were answered automatically (default true; needs `outcomes`). */
  showOutcomes?: boolean
  /** The note that a question expires, with the time left when it is known (default true). */
  showExpiry?: boolean
  /** Say that a helper's call is the one that asks (default true). */
  showHelper?: boolean
  /**
   * Render a question yourself: `fallback` is the built-in card, `answer` decides it. The
   * request's strings are the SERVER's text - render them as text.
   */
  renderElicitation?: (
    elicitation: PendingElicitation,
    fallback: ReactNode,
    answer: (result: McpElicitationResult) => void,
  ) => ReactNode
  labels?: AgentLabelsOverride
  className?: string
}

/** Ticks once a second while `active`, so a countdown redraws. */
const useNow = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const Expiry = ({ expiresAt, L }: { expiresAt?: number; L: AgentLabels }) => {
  const now = useNow(expiresAt !== undefined)
  return (
    <p className="awr-elicit__expiry">
      {expiresAt === undefined
        ? L.elicitationExpires
        : L.elicitationExpiresIn(formatCountdown(expiresAt - now))}
    </p>
  )
}

/** The server's own words: plain text, under a caption that says whose they are. */
const ServerText = ({
  server,
  message,
  children,
  L,
}: {
  server: string
  message: string
  children?: ReactNode
  L: AgentLabels
}) => (
  <div className="awr-elicit__server">
    <span className="awr-elicit__from">{L.elicitationFrom(server)}</span>
    {message && <p className="awr-elicit__message">{message}</p>}
    {children}
  </div>
)

interface FieldProps {
  field: ElicitationField
  id: string
  value: ElicitationDraftValue | undefined
  issue?: ElicitationIssue
  onChange: (value: ElicitationDraftValue) => void
  L: AgentLabels
}

const FieldControl = ({ field, id, value, issue, onChange, L }: FieldProps) => {
  const hintId = field.description ? `${id}-hint` : undefined
  const errorId = issue ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  const common = {
    'aria-describedby': describedBy,
    'aria-invalid': issue ? (true as const) : undefined,
  }
  const mark = field.required && (
    <span className="awr-elicit__req" title={L.elicitationRequired}>
      <span aria-hidden="true">*</span>
      <span className="awr-elicit__sr"> ({L.elicitationRequired})</span>
    </span>
  )
  const hint = field.description && (
    <p className="awr-elicit__hint" id={hintId}>
      {field.description}
    </p>
  )
  const error = issue && (
    <p className="awr-elicit__error" id={errorId} role="alert">
      {L.elicitationErrors[issue.kind](field.label, issue.limit)}
    </p>
  )
  const wrap = `awr-elicit__field awr-elicit__field--${field.control}${issue ? ' is-invalid' : ''}`

  if (field.control === 'checkbox') {
    return (
      <div className={wrap} data-field={field.name}>
        <label className="awr-elicit__check">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            {...common}
          />
          <span>
            {field.label}
            {mark}
          </span>
        </label>
        {hint}
        {error}
      </div>
    )
  }

  if (field.control === 'multiselect') {
    const picked = Array.isArray(value) ? value : []
    return (
      <fieldset className={wrap} data-field={field.name} {...common}>
        <legend className="awr-elicit__label">
          {field.label}
          {mark}
        </legend>
        {hint}
        {(field.options ?? []).map((option, i) => (
          <label key={option.value} className="awr-elicit__check">
            <input
              id={i === 0 ? id : undefined}
              type="checkbox"
              checked={picked.includes(option.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...picked, option.value]
                    : picked.filter((v) => v !== option.value),
                )
              }
            />
            <span>{option.label}</span>
          </label>
        ))}
        {error}
      </fieldset>
    )
  }

  const text = typeof value === 'string' ? value : ''
  return (
    <div className={wrap} data-field={field.name}>
      <label className="awr-elicit__label" htmlFor={id}>
        {field.label}
        {mark}
      </label>
      {hint}
      {field.control === 'select' ? (
        <select
          id={id}
          className="awr-elicit__input"
          value={text}
          required={field.required}
          onChange={(e) => onChange(e.target.value)}
          {...common}
        >
          <option value="">{L.elicitationChoose}</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          className="awr-elicit__input"
          // A number is typed as text: the browser's own number field hides what does not
          // parse, and the form could then only say "required".
          type={
            field.control === 'datetime'
              ? 'datetime-local'
              : field.control === 'number'
                ? 'text'
                : field.control
          }
          inputMode={
            field.control === 'number'
              ? field.schema.type === 'integer'
                ? 'numeric'
                : 'decimal'
              : undefined
          }
          value={text}
          required={field.required}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          {...common}
        />
      )}
      {error}
    </div>
  )
}

interface CardProps {
  elicitation: PendingElicitation
  answer: (result: McpElicitationResult) => void
  L: AgentLabels
}

/** Form mode. What is typed lives in this component only, and goes with it. */
const FormBody = ({ elicitation, answer, L }: CardProps) => {
  const baseId = useId()
  const schema = elicitation.requestedSchema
  const fields = elicitationFields(schema)
  const [draft, setDraft] = useState<ElicitationDraft>(() => elicitationInitialDraft(schema))
  const [issues, setIssues] = useState<Record<string, ElicitationIssue> | undefined>(undefined)
  const fieldId = (i: number) => `${baseId}-f${i}`

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const outcome = elicitationFormAnswer(schema, draft)
    if (outcome.ok) {
      answer({ action: 'accept', content: outcome.content })
      return
    }
    setIssues(outcome.issues)
    const first = fields.findIndex((f) => outcome.issues[f.name])
    if (first >= 0 && typeof document !== 'undefined') {
      document.getElementById(fieldId(first))?.focus()
    }
  }

  const change = (name: string, value: ElicitationDraftValue) => {
    const next = { ...draft, [name]: value }
    setDraft(next)
    // Once a submit was refused, the messages follow what is typed.
    if (issues) {
      const outcome = elicitationFormAnswer(schema, next)
      setIssues(outcome.ok ? {} : outcome.issues)
    }
  }

  const wrong = issues ? Object.keys(issues).length : 0
  return (
    <form className="awr-elicit__form" noValidate onSubmit={submit}>
      <ServerText server={elicitation.server} message={elicitation.message} L={L}>
        {fields.map((field, i) => (
          <FieldControl
            key={field.name}
            field={field}
            id={fieldId(i)}
            value={draft[field.name]}
            issue={issues?.[field.name]}
            onChange={(value) => change(field.name, value)}
            L={L}
          />
        ))}
      </ServerText>
      {wrong > 0 && <p className="awr-elicit__fix">{L.elicitationFix(wrong)}</p>}
      <div className="awr-elicit__actions">
        <button type="submit" className="awr-btn awr-btn--primary">
          {L.elicitationSubmit}
        </button>
        <button type="button" className="awr-btn" onClick={() => answer({ action: 'decline' })}>
          {L.elicitationDecline}
        </button>
        <button
          type="button"
          className="awr-btn awr-btn--ghost"
          onClick={() => answer({ action: 'cancel' })}
        >
          {L.elicitationCancel}
        </button>
      </div>
    </form>
  )
}

/** URL mode. The link is text; it is opened by the user's click on "Open" and by nothing else. */
const UrlBody = ({ elicitation, answer, L }: CardProps) => {
  const link = elicitationLink(elicitation.url)
  const [opened, setOpened] = useState(false)
  const open = () => {
    if (!link.openable || typeof window === 'undefined') return
    window.open(link.href, '_blank', 'noopener,noreferrer')
    setOpened(true)
  }
  return (
    <div className="awr-elicit__form">
      <ServerText server={elicitation.server} message={elicitation.message} L={L} />
      <div className="awr-elicit__link">
        <span className="awr-elicit__linklead">{L.elicitationUrlLead(elicitation.server)}</span>
        <strong className="awr-elicit__host">{link.host || '—'}</strong>
        <span className="awr-elicit__urllabel">{L.elicitationUrlFull}</span>
        <code className="awr-elicit__url">{link.href}</code>
      </div>
      {!link.openable && (
        <p className="awr-elicit__error" role="alert">
          {L.elicitationUrlRefused}
        </p>
      )}
      {opened && (
        <p className="awr-elicit__opened" role="status">
          {L.elicitationOpened}
        </p>
      )}
      <div className="awr-elicit__actions">
        {link.openable && (
          <button
            type="button"
            className={`awr-btn${opened ? '' : ' awr-btn--primary'}`}
            onClick={open}
          >
            <ExternalIcon size={14} /> {L.elicitationOpen}
          </button>
        )}
        {link.openable && opened && (
          <button
            type="button"
            className="awr-btn awr-btn--primary"
            onClick={() => answer({ action: 'accept' })}
          >
            {L.elicitationUrlDone}
          </button>
        )}
        <button type="button" className="awr-btn" onClick={() => answer({ action: 'decline' })}>
          {L.elicitationDecline}
        </button>
        <button
          type="button"
          className="awr-btn awr-btn--ghost"
          onClick={() => answer({ action: 'cancel' })}
        >
          {L.elicitationCancel}
        </button>
      </div>
    </div>
  )
}

/**
 * A question an MCP server puts to the user in the middle of a tool call (MCP elicitation): a
 * form to fill in, or a link to open. The header is the host's own - which server asks, during
 * which tool - and everything the server wrote is shown under a caption that says so, as plain
 * text. Three outcomes: accept (Submit / "I have finished there"), decline, cancel.
 *
 * Wire it to `useMcp` / `useMcpServers` (`pendingElicitations`, `answerElicitation`);
 * `<AgentChat elicitations onElicitationAnswer>` renders it for you. What the user types is
 * kept in this component only and handed to `onAnswer` once: it is not in the agent's state,
 * its events or the transcript.
 */
export const ElicitationPrompt = ({
  elicitations,
  onAnswer,
  outcomes,
  showOutcomes = true,
  showExpiry = true,
  showHelper = true,
  renderElicitation,
  labels,
  className,
}: ElicitationPromptProps) => {
  const L = useLabels(labels)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const automatic = showOutcomes
    ? (outcomes ?? []).filter(
        (o) => o.automatic === true && o.status !== 'pending' && !dismissed.has(o.id),
      )
    : []
  const current = elicitations[0]
  if (!current && automatic.length === 0) return null

  let card: ReactNode = null
  if (current) {
    const answer = (result: McpElicitationResult) => onAnswer(current.id, result)
    // A helper's role is text the model wrote: plain text, shortened.
    const helper = showHelper ? current.subagent : undefined
    const role = helper
      ? previewValue(outcomes?.find((o) => o.id === current.id)?.subagent?.role ?? '', 60) ||
        undefined
      : undefined
    const Body = current.mode === 'url' ? UrlBody : FormBody
    const builtIn = (
      <section
        className={`awr-elicit awr-elicit--${current.mode}`}
        aria-label={L.elicitationTitle}
        data-server={current.server}
        data-subagent={helper?.id}
      >
        <div className="awr-elicit__head" role="alert">
          <QuestionIcon size={16} className="awr-elicit__icon" />
          <span className="awr-elicit__lead">
            {helper
              ? L.elicitationLeadHelper(current.server, role)
              : L.elicitationLead(current.server)}{' '}
            <span className="awr-elicit__during">
              {L.elicitationDuring} <code className="awr-tool__name">{current.tool}</code>
            </span>
          </span>
          {elicitations.length > 1 && (
            <span className="awr-elicit__count">{L.elicitationCount(1, elicitations.length)}</span>
          )}
        </div>
        {/* Keyed by the question: the next one starts from an empty form. */}
        <Body key={current.id} elicitation={current} answer={answer} L={L} />
        {showExpiry && <Expiry key={`x-${current.id}`} expiresAt={current.expiresAt} L={L} />}
      </section>
    )
    card = renderElicitation ? renderElicitation(current, builtIn, answer) : builtIn
  }

  return (
    <div className={['awr-elicits', className].filter(Boolean).join(' ')}>
      {automatic.map((o) => (
        <div key={o.id} className="awr-elicit-outcome" role="status" data-reason={o.reason}>
          <AlertIcon size={14} className="awr-elicit-outcome__icon" />
          <span className="awr-elicit-outcome__text">
            {L.elicitationAutomatic(
              o.server,
              (o.reason && Object.hasOwn(L.elicitationReasons, o.reason)
                ? L.elicitationReasons[o.reason]
                : o.reason) || o.status,
            )}
          </span>
          <button
            type="button"
            className="awr-iconbtn awr-elicit-outcome__dismiss"
            aria-label={L.elicitationDismiss}
            title={L.elicitationDismiss}
            onClick={() => setDismissed((d) => new Set(d).add(o.id))}
          >
            <XIcon size={14} />
          </button>
        </div>
      ))}
      {card}
    </div>
  )
}
