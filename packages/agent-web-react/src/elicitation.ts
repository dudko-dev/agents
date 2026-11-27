import type {
  McpElicitationFieldSchema,
  McpElicitationHandler,
  McpElicitationOptions,
  McpElicitationRequest,
  McpElicitationResult,
  McpElicitationSchema,
} from './mcp-types.js'

/**
 * MCP elicitation, the part of it that is not React: what a field of a server's form is drawn
 * as, what the user typed turned into the answer, the checks an answer must pass before it is
 * sent (the core's own rules, so the form says what is wrong instead of the tool call failing),
 * what a link may be opened as, and the queue of questions waiting for the user.
 *
 * Pure, and free of the MCP SDK and of the core's `./mcp` subpath: the prompt is in the main
 * entry of this package, the hooks that fill the queue are in `./mcp`.
 *
 * Nothing here keeps, logs or returns a value the user entered except to the one caller that
 * hands it to the server: an issue names the field and the rule, never the value.
 */

// ── a question waiting for the user ──────────────────────────────────────

/**
 * A question waiting for the user: the core's request (every string in it is the SERVER's
 * text), and when the core will stop waiting for the answer.
 */
export interface PendingElicitation extends McpElicitationRequest {
  /** Epoch ms after which the core cancels the question by itself; absent when it has no limit. */
  expiresAt?: number
}

/** The core's default for `elicitation.timeoutMs` (`MCP_ELICITATION_TIMEOUT_MS`). */
export const ELICITATION_TIMEOUT_MS = 300_000

/**
 * The hooks' `elicitation` option as the core's settings, or `undefined` when it is off - and
 * then NOTHING is passed to the core: no capability is declared and the wire is what it was.
 */
export const elicitationSettings = (
  option: boolean | McpElicitationOptions | undefined | null,
): McpElicitationOptions | undefined => {
  if (option === true) return {}
  if (typeof option === 'object' && option !== null) return { ...option }
  return undefined
}

/**
 * What the hooks add to the options of the core's `connectMcpHttp`: the handler and the
 * settings when elicitation is on, and NOTHING - not even the keys - when it is off.
 */
export const elicitationConnectOptions = (
  option: boolean | McpElicitationOptions | undefined | null,
  handler: McpElicitationHandler,
): { onElicitation?: McpElicitationHandler; elicitation?: McpElicitationOptions } => {
  const settings = elicitationSettings(option)
  return settings ? { onElicitation: handler, elicitation: settings } : {}
}

/** How long the core waits for an answer with these settings; `undefined` = no limit of its own. */
export const elicitationTimeoutOf = (settings: McpElicitationOptions): number | undefined => {
  const raw = settings.timeoutMs
  if (raw === undefined || raw === null) return ELICITATION_TIMEOUT_MS
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined
  return Math.floor(raw)
}

export interface ElicitationQueueOptions {
  /**
   * How long the core waits (ms), for `expiresAt`; `undefined` = no limit. A function is read
   * when a question arrives (the settings of the connection that is open then).
   */
  timeoutMs?: number | (() => number | undefined)
  /** Called whenever the list of pending questions changed. */
  onChange?: (pending: PendingElicitation[]) => void
  /** The clock (tests). */
  now?: () => number
}

export interface ElicitationQueue {
  /** The core's `onElicitation`: resolves when the user answers, or as `cancel`. */
  handler: McpElicitationHandler
  /** The questions waiting, oldest first. */
  pending: () => PendingElicitation[]
  /** Answer one. False when no such question is waiting (answered, expired, cancelled). */
  answer: (id: string, result: McpElicitationResult) => boolean
  /** Cancel the waiting questions - all of them, or those `match` picks (one server's). */
  cancel: (match?: (request: PendingElicitation) => boolean) => void
  /** Cancel everything and stop reporting: the owner is gone. A later question is cancelled at once. */
  dispose: () => void
}

/**
 * The questions MCP servers are waiting on: `request.id → resolver`. A question leaves the queue
 * exactly once - answered by the user, cancelled because the core no longer wants the answer
 * (`ctx.signal`: its time ran out, the run stopped), or cancelled by its owner (a disconnect, an
 * unmount) - and the queue never holds an answer: `answer` passes it straight to the resolver.
 */
export const createElicitationQueue = (options: ElicitationQueueOptions = {}): ElicitationQueue => {
  const now = options.now ?? Date.now
  const waiting = new Map<
    string,
    { request: PendingElicitation; settle: (result: McpElicitationResult) => void }
  >()
  let disposed = false

  const list = (): PendingElicitation[] => [...waiting.values()].map((w) => w.request)
  const changed = (): void => {
    if (!disposed) options.onChange?.(list())
  }

  const handler: McpElicitationHandler = (request, ctx) =>
    new Promise<McpElicitationResult>((resolve) => {
      const signal = ctx?.signal
      // Nobody to ask, or nobody wants the answer any more.
      if (disposed || signal?.aborted || waiting.has(request.id)) {
        resolve({ action: 'cancel' })
        return
      }
      // The core no longer wants the answer: its time ran out, or the run stopped.
      const onAbort = (): void => {
        if (waiting.get(request.id)?.settle !== settle) return
        settle({ action: 'cancel' })
        changed()
      }
      const settle = (result: McpElicitationResult): void => {
        // Exactly once: a second answer to the same question finds nothing to resolve.
        if (waiting.get(request.id)?.settle !== settle) return
        waiting.delete(request.id)
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const timeoutMs =
        typeof options.timeoutMs === 'function' ? options.timeoutMs() : options.timeoutMs
      waiting.set(request.id, {
        request: {
          ...request,
          ...(timeoutMs !== undefined ? { expiresAt: now() + timeoutMs } : {}),
        },
        settle,
      })
      changed()
    })

  return {
    handler,
    pending: list,
    answer: (id, result) => {
      const entry = waiting.get(id)
      if (!entry) return false
      entry.settle(result)
      changed()
      return true
    },
    cancel: (match) => {
      let any = false
      for (const entry of [...waiting.values()]) {
        if (match && !match(entry.request)) continue
        entry.settle({ action: 'cancel' })
        any = true
      }
      if (any) changed()
    },
    dispose: () => {
      disposed = true
      for (const entry of [...waiting.values()]) entry.settle({ action: 'cancel' })
    },
  }
}

// ── a form: fields, values, the answer ───────────────────────────────────

/** What a field is drawn as. */
export type ElicitationControl =
  'text' | 'email' | 'url' | 'date' | 'datetime' | 'number' | 'checkbox' | 'select' | 'multiselect'

export interface ElicitationOption {
  /** What goes back to the server, verbatim. */
  value: string
  /** What the user reads (the option's title, or the value). */
  label: string
}

/** One field of a form, ready to draw. `label`, `description` and option labels are the server's text. */
export interface ElicitationField {
  name: string
  label: string
  description?: string
  required: boolean
  control: ElicitationControl
  /** `select` / `multiselect`. */
  options?: ElicitationOption[]
  schema: McpElicitationFieldSchema
}

/** What the form holds while it is being filled in: text as typed, a tick, the ticked options. */
export type ElicitationDraftValue = string | boolean | string[]
export type ElicitationDraft = Record<string, ElicitationDraftValue>

const titled = (options: { const: string; title: string }[]): ElicitationOption[] =>
  options.map((o) => ({ value: o.const, label: o.title || o.const }))

/** The options of a select, in the three forms the core lets through. */
const optionsOf = (schema: McpElicitationFieldSchema): ElicitationOption[] | undefined => {
  if (schema.type === 'array') {
    const items = schema.items
    if (items?.anyOf) return titled(items.anyOf)
    return (items?.enum ?? []).map((value) => ({ value, label: value }))
  }
  if (schema.type !== 'string') return undefined
  if (schema.oneOf) return titled(schema.oneOf)
  if (schema.enum) {
    const names = schema.enumNames
    return schema.enum.map((value, i) => ({ value, label: names?.[i] || value }))
  }
  return undefined
}

const controlOf = (schema: McpElicitationFieldSchema): ElicitationControl => {
  switch (schema.type) {
    case 'boolean':
      return 'checkbox'
    case 'number':
    case 'integer':
      return 'number'
    case 'array':
      return 'multiselect'
    default:
      if (schema.enum || schema.oneOf) return 'select'
      switch (schema.format) {
        case 'email':
          return 'email'
        case 'uri':
          return 'url'
        case 'date':
          return 'date'
        case 'date-time':
          return 'datetime'
        default:
          return 'text'
      }
  }
}

/**
 * The fields of a form in the order the server listed them - exactly the set the core's schema
 * guard lets through: a text (plain, email, uri, date, date-time), a number / integer, a
 * boolean, a single select (`enum`, `enum` + `enumNames`, `oneOf`) and a multi-select (an array
 * of `enum` or `anyOf` options).
 */
export const elicitationFields = (schema: McpElicitationSchema | undefined): ElicitationField[] => {
  const required = new Set(schema?.required ?? [])
  return Object.entries(schema?.properties ?? {}).map(([name, field]) => {
    const options = optionsOf(field)
    return {
      name,
      label: field.title || name,
      ...(field.description ? { description: field.description } : {}),
      required: required.has(name),
      control: controlOf(field),
      ...(options ? { options } : {}),
      schema: field,
    }
  })
}

const pad = (n: number): string => String(n).padStart(2, '0')

// A date-time default as `<input type="datetime-local">` wants it (local time, to the minute).
const toLocalInput = (value: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** What the form starts with: the schema's defaults (the core dropped the ones that do not fit). */
export const elicitationInitialDraft = (
  schema: McpElicitationSchema | undefined,
): ElicitationDraft => {
  const draft: ElicitationDraft = {}
  for (const field of elicitationFields(schema)) {
    const preset = field.schema.default
    switch (field.control) {
      case 'checkbox':
        draft[field.name] = preset === true
        break
      case 'multiselect':
        draft[field.name] = Array.isArray(preset) ? [...preset] : []
        break
      case 'number':
        draft[field.name] = typeof preset === 'number' ? String(preset) : ''
        break
      case 'datetime':
        draft[field.name] = typeof preset === 'string' ? toLocalInput(preset) : ''
        break
      default:
        draft[field.name] = typeof preset === 'string' ? preset : ''
    }
  }
  return draft
}

/** The rules an answer can break. An issue never carries the value. */
export type ElicitationIssueKind =
  | 'required'
  | 'tooShort'
  | 'tooLong'
  | 'email'
  | 'uri'
  | 'date'
  | 'dateTime'
  | 'notNumber'
  | 'notInteger'
  | 'belowMinimum'
  | 'aboveMaximum'
  | 'notAnOption'
  | 'tooFew'
  | 'tooMany'

export interface ElicitationIssue {
  kind: ElicitationIssueKind
  /** The limit the rule states (a length, a bound, a count), when it has one. */
  limit?: number
}

/** The longest text a field without its own `maxLength` takes (the core's cap). */
export const ELICITATION_VALUE_MAX_CHARS = 10_000
/** The most options one multi-select may be answered with (the core's cap). */
export const ELICITATION_MAX_OPTIONS = 100

// A number as a person types it: digits, a sign, a decimal point, an exponent. `Number('')` is
// 0 and `Number(' 1 ')` is 1, so the text is checked first.
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

const numberOf = (text: string): number | undefined => {
  const trimmed = text.trim()
  if (!NUMBER.test(trimmed)) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

// The core's `validFormat`, rule for rule.
const formatIssue = (
  format: McpElicitationFieldSchema['format'],
  value: string,
): ElicitationIssueKind | undefined => {
  switch (format) {
    case 'email':
      return /^[^@\s]+@[^@\s]+$/.test(value) ? undefined : 'email'
    case 'uri':
      try {
        return new URL(value) ? undefined : 'uri'
      } catch {
        return 'uri'
      }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : 'date'
    case 'date-time':
      return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : 'dateTime'
    default:
      return undefined
  }
}

// A date-time goes back as RFC 3339 with its offset (UTC): the input's value is local time
// without one, which a server could read as any zone.
const dateTimeOf = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

type FieldAnswer =
  { issue: ElicitationIssue } | { value: string | number | boolean | string[] } | { empty: true }

// One field: its value as the server gets it, why it does not fit, or "left empty".
const answerOf = (field: ElicitationField, raw: ElicitationDraftValue | undefined): FieldAnswer => {
  const { schema } = field
  switch (field.control) {
    case 'checkbox':
      // A tick box always has a value: unticked is `false`, which is an answer.
      return { value: raw === true }
    case 'multiselect': {
      const picked = Array.isArray(raw) ? raw : []
      // Nothing ticked in an optional list is "not answered", as an empty text is.
      if (picked.length === 0 && !field.required) return { empty: true }
      const allowed = new Set((field.options ?? []).map((o) => o.value))
      if (!picked.every((item) => allowed.has(item))) return { issue: { kind: 'notAnOption' } }
      if (schema.minItems !== undefined && picked.length < schema.minItems) {
        return { issue: { kind: 'tooFew', limit: schema.minItems } }
      }
      const max = Math.min(schema.maxItems ?? ELICITATION_MAX_OPTIONS, ELICITATION_MAX_OPTIONS)
      if (picked.length > max) return { issue: { kind: 'tooMany', limit: max } }
      return { value: [...picked] }
    }
    case 'number': {
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (!text) return { empty: true }
      const n = numberOf(text)
      if (n === undefined) return { issue: { kind: 'notNumber' } }
      if (schema.type === 'integer' && !Number.isInteger(n)) {
        return { issue: { kind: 'notInteger' } }
      }
      if (schema.minimum !== undefined && n < schema.minimum) {
        return { issue: { kind: 'belowMinimum', limit: schema.minimum } }
      }
      if (schema.maximum !== undefined && n > schema.maximum) {
        return { issue: { kind: 'aboveMaximum', limit: schema.maximum } }
      }
      return { value: n }
    }
    case 'select': {
      const text = typeof raw === 'string' ? raw : ''
      if (!text) return { empty: true }
      return (field.options ?? []).some((o) => o.value === text)
        ? { value: text }
        : { issue: { kind: 'notAnOption' } }
    }
    default: {
      const typed = typeof raw === 'string' ? raw : ''
      if (!typed) return { empty: true }
      const text = field.control === 'datetime' ? dateTimeOf(typed) : typed
      const max = schema.maxLength ?? ELICITATION_VALUE_MAX_CHARS
      if (text.length > max) return { issue: { kind: 'tooLong', limit: max } }
      if (schema.minLength !== undefined && text.length < schema.minLength) {
        return { issue: { kind: 'tooShort', limit: schema.minLength } }
      }
      const format = formatIssue(schema.format, text)
      return format ? { issue: { kind: format } } : { value: text }
    }
  }
}

export type ElicitationFormOutcome =
  | { ok: true; content: Record<string, string | number | boolean | string[]> }
  | { ok: false; issues: Record<string, ElicitationIssue> }

/**
 * A filled-in form as the answer the core will accept, or what is wrong with it, per field. The
 * rules are the core's (`validateMcpElicitationContent`): a required field is there, every
 * value is of its field's type and within its limits, and nothing the form did not ask for is
 * sent. A field left empty is left out, not sent as an empty text.
 */
export const elicitationFormAnswer = (
  schema: McpElicitationSchema | undefined,
  draft: ElicitationDraft,
): ElicitationFormOutcome => {
  const content: Record<string, string | number | boolean | string[]> = {}
  const issues: Record<string, ElicitationIssue> = {}
  for (const field of elicitationFields(schema)) {
    const answer = answerOf(field, Object.hasOwn(draft, field.name) ? draft[field.name] : undefined)
    if ('issue' in answer) {
      issues[field.name] = answer.issue
    } else if ('empty' in answer) {
      if (field.required) issues[field.name] = { kind: 'required' }
    } else {
      content[field.name] = answer.value
    }
  }
  return Object.keys(issues).length > 0 ? { ok: false, issues } : { ok: true, content }
}

// ── a link ───────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface ElicitationLink {
  /** The host the link leads to (with its port), as the browser will resolve it; '' if unparseable. */
  host: string
  /** The whole link as text: the parsed form when it parses, what the server sent otherwise. */
  href: string
  /** Whether an "Open" action may exist for it: https, or http on a loopback host, no credentials. */
  openable: boolean
}

/**
 * A link a server wants the user to open, as the prompt may show it. The core already refuses
 * anything but https (http on loopback); this is the same rule applied again where the link is
 * about to be opened, because a host may hand the prompt a request the core never checked.
 */
export const elicitationLink = (raw: unknown): ElicitationLink => {
  const text = typeof raw === 'string' ? raw : ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { host: '', href: text, openable: false }
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  return {
    host: url.host,
    href: url.href,
    openable: secure && !url.username && !url.password && !/\s/.test(text),
  }
}

/** "4:05" - what is left of a question's time. */
export const formatCountdown = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${pad(total % 60)}`
}
