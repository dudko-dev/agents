/**
 * MCP elicitation, the part the two agent packages share: a server asks the user for input in
 * the middle of a tool call, the HOST answers through a callback, and the call goes on. Pure, no
 * imports: the limits, what a request must look like before a host sees it, what an answer must
 * look like before a server sees it, the one function that asks, and the two ways a tool call
 * with questions is driven (`elicitation/create` requests on the 2025 revisions, `input_required`
 * results on 2026-07-28).
 *
 * A consent boundary. The server's text is third-party data: cleaned and capped here, shown only
 * to the host's callback and in the `mcp.elicitation-requested` event, never put into a prompt.
 * The answer goes to the server that asked and nowhere else: nothing in this file logs, emits or
 * returns a value the user entered - events and errors carry field NAMES only.
 *
 * This file is a COPY, byte for byte, in `@dudko.dev/agent` (`src/mcp-elicitation.ts`) and
 * `@dudko.dev/agent-web` (`src/mcp/elicitation.ts`): change both. The Node package's
 * `tests/mcp-elicitation-shared.test.ts` compares the two files and tests every guard here; each
 * needs a mutation check.
 */

// ── limits ───────────────────────────────────────────────────────────────

/** How long one question waits for the host's answer, by default: a human is reading it. */
export const MCP_ELICITATION_TIMEOUT_MS = 300_000
/** The most questions one tool call may ask, by default. */
export const MCP_ELICITATION_MAX_PER_TOOL_CALL = 5
/** The most questions one run may be asked, by default (its helpers' calls included). */
export const MCP_ELICITATION_MAX_PER_RUN = 20
/** The most of a server's message a host is shown, in characters. */
export const MCP_ELICITATION_MESSAGE_MAX_CHARS = 2000
/** The most of a field's title or of an option's title. */
export const MCP_ELICITATION_LABEL_MAX_CHARS = 200
/** The most of a field's description. */
export const MCP_ELICITATION_DESCRIPTION_MAX_CHARS = 500
/** A form with more fields is refused. */
export const MCP_ELICITATION_MAX_FIELDS = 50
/** A select with more options is refused. */
export const MCP_ELICITATION_MAX_OPTIONS = 100
/** A field name, or an option's value, longer than this is refused (they go back verbatim). */
export const MCP_ELICITATION_NAME_MAX_CHARS = 200
/** A link longer than this is refused. */
export const MCP_ELICITATION_URL_MAX_CHARS = 2048
/** The longest text a field without its own `maxLength` may be answered with. */
export const MCP_ELICITATION_VALUE_MAX_CHARS = 10_000
/** Ends a text that a cap cut. */
export const MCP_ELICITATION_TRUNCATED = '... [truncated]'
/** 2026-07-28: the most `input_required` answers one tool call may take before it fails. */
export const MCP_INPUT_REQUIRED_MAX_ROUNDS = 10
/** 2026-07-28: the pause before a round that only says "call me again" is answered. */
export const MCP_INPUT_REQUIRED_PACING_MS = 250
/**
 * 2025 revisions: how long a tool call may take, NOT counting the time a question of its own
 * waits for the user. (The SDK's request timeout, a minute, would otherwise end a call whose
 * form is still being filled in.)
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 60_000

// ── types ────────────────────────────────────────────────────────────────

/** One field of a form: the flat subset of JSON Schema the specification allows, nothing else. */
export interface McpElicitationFieldSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  title?: string
  description?: string
  default?: string | number | boolean | string[]
  /** string */
  minLength?: number
  maxLength?: number
  format?: 'email' | 'uri' | 'date' | 'date-time'
  /** string: single-select, plain (`enumNames`: the older titled form). */
  enum?: string[]
  enumNames?: string[]
  /** string: single-select with titles. */
  oneOf?: { const: string; title: string }[]
  /** number / integer */
  minimum?: number
  maximum?: number
  /** array: multi-select. */
  minItems?: number
  maxItems?: number
  items?: { type?: 'string'; enum?: string[]; anyOf?: { const: string; title: string }[] }
}

/** The form a server asks for, as a host is shown it: checked, cleaned and capped. */
export interface McpElicitationSchema {
  type: 'object'
  properties: Record<string, McpElicitationFieldSchema>
  required?: string[]
}

/** What the host's callback is given. Every string in it is third-party text. */
export interface McpElicitationRequest {
  /** Unique per question; the same id is in the two events. */
  id: string
  /** The server that asks: its key in the host's configuration. */
  server: string
  /** The tool call during which it asks: the tool's name as the model called it. */
  tool: string
  mode: 'form' | 'url'
  /** The server's words, cleaned and capped (MCP_ELICITATION_MESSAGE_MAX_CHARS). */
  message: string
  /** Form mode: the fields to fill in. */
  requestedSchema?: McpElicitationSchema
  /**
   * URL mode: the link the server wants the user to open. It is only handed over: nothing in
   * these packages fetches or opens it. https, or http on a loopback host.
   */
  url?: string
  /** URL mode on the 2025 revisions: the server's id for this interaction. */
  elicitationId?: string
  runId?: string
  /** Set when a helper the model started is the one whose call asks (`elicitation.subagents`). */
  subagent?: { id: string; depth: number }
}

export type McpElicitationContent = Record<string, string | number | boolean | string[]>

/**
 * The host's answer. `accept` carries the form's values (form mode) or nothing (URL mode: it
 * says the user agreed to open the link); `decline` is a no; `cancel` is "dismissed".
 */
export type McpElicitationResult =
  | { action: 'accept'; content?: McpElicitationContent }
  | { action: 'decline' }
  | { action: 'cancel' }

export interface McpElicitationContext {
  /** Aborted when the answer is no longer wanted: the run stopped, or the time ran out. */
  signal: AbortSignal
}

/** `onElicitation`: the host decides, never the model. */
export type McpElicitationHandler = (
  request: McpElicitationRequest,
  ctx: McpElicitationContext,
) => McpElicitationResult | Promise<McpElicitationResult>

/** The `elicitation` settings beside `onElicitation`. */
export interface McpElicitationOptions {
  /** How long one question waits for an answer. Default 300 000; 0 = no limit of its own. */
  timeoutMs?: number
  /** Questions one tool call may ask. Default 5. */
  maxPerToolCall?: number
  /** Questions one run may be asked. Default 20. */
  maxPerRun?: number
  /** Also accept URL mode (a link to open). Default false: only forms are declared. */
  url?: boolean
  /**
   * Let a tool call made by a helper (a subagent) ask the user too. Default false: such a
   * question is cancelled without the callback being called.
   */
  subagents?: boolean
}

export interface McpResolvedElicitationOptions {
  timeoutMs: number
  maxPerToolCall: number
  maxPerRun: number
  url: boolean
  subagents: boolean
}

/** Why a question was answered without the host deciding. */
export type McpElicitationReason =
  | 'unsupported-schema'
  | 'unsupported-mode'
  | 'insecure-url'
  | 'invalid-request'
  | 'subagent'
  | 'cap-per-call'
  | 'cap-per-run'
  | 'handler-error'
  | 'timeout'
  | 'invalid-answer'
  | 'aborted'
  | 'step-timeout'
  | 'after-failure'
  | 'no-tool-call'

/** The two events of a question. Neither ever carries a value the user entered. */
export type McpElicitationEvent =
  | {
      type: 'mcp.elicitation-requested'
      id: string
      server: string
      tool: string
      mode: 'form' | 'url'
      message: string
      requestedSchema?: McpElicitationSchema
      url?: string
      subagent?: { id: string; depth: number }
    }
  | {
      type: 'mcp.elicitation-answered'
      id: string
      server: string
      tool: string
      action: 'accept' | 'decline' | 'cancel'
      /** true when nobody decided: a guard, a cap, a timeout, a failed handler. */
      automatic: boolean
      reason?: McpElicitationReason
      /** The names of the fields an accepted form was answered with. Names only. */
      fields?: string[]
    }

/** A failure of this boundary; `toJSON` keeps the message when a trace is serialised. */
export class McpElicitationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpElicitationError'
  }

  toJSON(): string {
    return this.message
  }
}

// ── settings ─────────────────────────────────────────────────────────────

const settingOf = (value: unknown, name: string, fallback: number, min: number): number => {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(
      `elicitation.${name} must be a number of at least ${min} (got ${JSON.stringify(value) ?? String(value)})`,
    )
  }
  return Math.floor(value)
}

/** The settings with their defaults. A value that is not a usable number is a configuration error. */
export const resolveMcpElicitationOptions = (
  raw: McpElicitationOptions | undefined,
): McpResolvedElicitationOptions => ({
  timeoutMs: settingOf(raw?.timeoutMs, 'timeoutMs', MCP_ELICITATION_TIMEOUT_MS, 0),
  maxPerToolCall: settingOf(
    raw?.maxPerToolCall,
    'maxPerToolCall',
    MCP_ELICITATION_MAX_PER_TOOL_CALL,
    1,
  ),
  maxPerRun: settingOf(raw?.maxPerRun, 'maxPerRun', MCP_ELICITATION_MAX_PER_RUN, 1),
  url: raw?.url === true,
  subagents: raw?.subagents === true,
})

/**
 * The `elicitation` capability a client with a handler declares: the form always, URL mode only
 * when the host asked for it. (No handler: no capability at all - the caller declares nothing.)
 */
export const mcpElicitationCapability = (
  options: Pick<McpResolvedElicitationOptions, 'url'>,
): { form: Record<string, never>; url?: Record<string, never> } =>
  options.url ? { form: {}, url: {} } : { form: {} }

// ── the request, before a host sees it ───────────────────────────────────

// C0 / C1 controls (tab and newline stay), zero-width and bidirectional-override characters.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Third-party text as a host may show it: a string, invisible characters removed, capped. */
export const cleanMcpElicitationText = (raw: unknown, max: number): string => {
  if (typeof raw !== 'string') {
    return ''
  }
  const text = raw.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').trim()
  return text.length > max ? `${text.slice(0, Math.max(0, max))}${MCP_ELICITATION_TRUNCATED}` : text
}

// A string that goes back to the server verbatim (a field name, an option's value): it is
// never altered, so one that would have to be is not usable.
const isVerbatim = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MCP_ELICITATION_NAME_MAX_CHARS &&
  value.replace(INVISIBLE, '') === value &&
  !/[\r\n\t]/.test(value)

const UNSAFE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

// A field's name in a sentence a model or a log may read.
const fieldLabel = (name: string): string =>
  JSON.stringify(cleanMcpElicitationText(name, 64).replace(/\s+/g, ' '))

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string }

const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

const label = (raw: unknown, max: number): string | undefined => {
  const text = cleanMcpElicitationText(raw, max)
  return text ? text : undefined
}

const count = (raw: unknown): number | undefined | null =>
  raw === undefined
    ? undefined
    : typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
      ? raw
      : null

const plainOptions = (raw: unknown): string[] | undefined =>
  Array.isArray(raw) &&
  raw.length > 0 &&
  raw.length <= MCP_ELICITATION_MAX_OPTIONS &&
  raw.every(isVerbatim)
    ? [...(raw as string[])]
    : undefined

const titledOptions = (raw: unknown): { const: string; title: string }[] | undefined => {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MCP_ELICITATION_MAX_OPTIONS) {
    return undefined
  }
  const out: { const: string; title: string }[] = []
  for (const option of raw) {
    if (!isPlainObject(option) || !isVerbatim(option.const)) {
      return undefined
    }
    out.push({
      const: option.const,
      title: label(option.title, MCP_ELICITATION_LABEL_MAX_CHARS) ?? option.const,
    })
  }
  return out
}

const FORMATS: ReadonlySet<string> = new Set(['email', 'uri', 'date', 'date-time'])

const normalizeField = (name: string, raw: unknown): Checked<McpElicitationFieldSchema> => {
  const at = `field ${fieldLabel(name)}`
  if (!isPlainObject(raw)) {
    return bad(`${at} is not a schema`)
  }
  const type = raw.type
  if (
    type !== 'string' &&
    type !== 'number' &&
    type !== 'integer' &&
    type !== 'boolean' &&
    type !== 'array'
  ) {
    return bad(
      `${at} has an unsupported type (${cleanMcpElicitationText(typeof type === 'string' ? type : typeof type, 20)}); a form may hold only strings, numbers, booleans and selects`,
    )
  }
  // A nested form, whatever its `type` says.
  if (raw.properties !== undefined || raw.additionalProperties !== undefined) {
    return bad(`${at} is a nested object; a form is flat`)
  }
  const field: McpElicitationFieldSchema = { type }
  const title = label(raw.title, MCP_ELICITATION_LABEL_MAX_CHARS)
  if (title) {
    field.title = title
  }
  const description = label(raw.description, MCP_ELICITATION_DESCRIPTION_MAX_CHARS)
  if (description) {
    field.description = description
  }
  if (type === 'string') {
    if (raw.enum !== undefined && raw.oneOf !== undefined) {
      return bad(`${at} has both "enum" and "oneOf"`)
    }
    if (raw.enum !== undefined) {
      const options = plainOptions(raw.enum)
      if (!options) {
        return bad(`${at} has options that cannot be shown`)
      }
      field.enum = options
      if (Array.isArray(raw.enumNames) && raw.enumNames.length === options.length) {
        field.enumNames = raw.enumNames.map(
          (n, i) => label(n, MCP_ELICITATION_LABEL_MAX_CHARS) ?? options[i],
        )
      }
    } else if (raw.oneOf !== undefined) {
      const options = titledOptions(raw.oneOf)
      if (!options) {
        return bad(`${at} has options that cannot be shown`)
      }
      field.oneOf = options
    } else {
      const min = count(raw.minLength)
      const max = count(raw.maxLength)
      if (min === null || max === null) {
        return bad(`${at} has a length limit that is not a whole number`)
      }
      if (min !== undefined) {
        field.minLength = min
      }
      if (max !== undefined) {
        field.maxLength = max
      }
      if (raw.format !== undefined) {
        if (typeof raw.format !== 'string' || !FORMATS.has(raw.format)) {
          return bad(`${at} has an unsupported format`)
        }
        field.format = raw.format as McpElicitationFieldSchema['format']
      }
    }
  } else if (type === 'number' || type === 'integer') {
    for (const key of ['minimum', 'maximum'] as const) {
      const bound = raw[key]
      if (bound === undefined) {
        continue
      }
      if (typeof bound !== 'number' || !Number.isFinite(bound)) {
        return bad(`${at} has a bound that is not a number`)
      }
      field[key] = bound
    }
  } else if (type === 'array') {
    const items = raw.items
    if (!isPlainObject(items) || items.properties !== undefined) {
      return bad(`${at} is a list of something other than options; a form is flat`)
    }
    if (items.enum !== undefined && items.anyOf === undefined) {
      const options = plainOptions(items.enum)
      if (!options || (items.type !== undefined && items.type !== 'string')) {
        return bad(`${at} has options that cannot be shown`)
      }
      field.items = { type: 'string', enum: options }
    } else if (items.anyOf !== undefined && items.enum === undefined) {
      const options = titledOptions(items.anyOf)
      if (!options) {
        return bad(`${at} has options that cannot be shown`)
      }
      field.items = { anyOf: options }
    } else {
      return bad(`${at} is a list of something other than options; a form is flat`)
    }
    const min = count(raw.minItems)
    const max = count(raw.maxItems)
    if (min === null || max === null) {
      return bad(`${at} has a size limit that is not a whole number`)
    }
    if (min !== undefined) {
      field.minItems = min
    }
    if (max !== undefined) {
      field.maxItems = max
    }
  }
  // A default the field itself would refuse is left out, not shown.
  if (raw.default !== undefined && checkValue(name, field, raw.default) === undefined) {
    field.default = Array.isArray(raw.default)
      ? [...(raw.default as string[])]
      : (raw.default as string | number | boolean)
  }
  return { ok: true, value: field }
}

/**
 * The form a server asked for, reduced to what the specification allows a form to be: a flat
 * object of strings, numbers, booleans and selects. Anything else - a nested object, a list of
 * objects, a type union, an unknown format, too many fields or options, a name that could not
 * be sent back verbatim - is refused with a reason (the caller declines the request). Keywords
 * outside the subset are dropped; titles and descriptions are cleaned and capped.
 */
export const normalizeMcpElicitationSchema = (raw: unknown): Checked<McpElicitationSchema> => {
  if (!isPlainObject(raw) || raw.type !== 'object' || !isPlainObject(raw.properties)) {
    return bad('the form is not an object with properties')
  }
  const names = Object.keys(raw.properties)
  if (names.length > MCP_ELICITATION_MAX_FIELDS) {
    return bad(`the form has more than ${MCP_ELICITATION_MAX_FIELDS} fields`)
  }
  const properties: Record<string, McpElicitationFieldSchema> = {}
  for (const name of names) {
    if (!isVerbatim(name) || UNSAFE_NAMES.has(name)) {
      return bad(`the form has a field name that cannot be used (${fieldLabel(name)})`)
    }
    const field = normalizeField(name, raw.properties[name])
    if (!field.ok) {
      return field
    }
    properties[name] = field.value
  }
  const schema: McpElicitationSchema = { type: 'object', properties }
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required)) {
      return bad('the form\'s "required" is not a list')
    }
    const required: string[] = []
    for (const name of raw.required) {
      if (typeof name !== 'string' || !Object.hasOwn(properties, name)) {
        return bad('the form requires a field it does not have')
      }
      if (!required.includes(name)) {
        required.push(name)
      }
    }
    if (required.length) {
      schema.required = required
    }
  }
  return { ok: true, value: schema }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * A link a server wants the user to open, or why it is refused. Only https - or http on a
 * loopback host, the rule the OAuth code of these packages applies (`assertSecureOAuthUrl`) -
 * and no credentials in it. Parsed, not pattern-matched; the result is the parsed form (an
 * internationalised host shows as punycode). The link is never fetched or opened here.
 */
export const checkMcpElicitationUrl = (raw: unknown): Checked<string> => {
  if (typeof raw !== 'string' || !raw || raw.length > MCP_ELICITATION_URL_MAX_CHARS) {
    return bad('the link is missing or too long')
  }
  if (raw.replace(INVISIBLE, '') !== raw || /\s/.test(raw)) {
    return bad('the link contains characters that cannot be shown')
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return bad('the link is not a valid URL')
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))
  ) {
    return bad('only https links are accepted (http on a loopback host)')
  }
  if (parsed.username || parsed.password) {
    return bad('the link carries credentials')
  }
  return { ok: true, value: parsed.href }
}

type ParsedRequest =
  | {
      ok: true
      mode: 'form'
      message: string
      requestedSchema: McpElicitationSchema
    }
  | { ok: true; mode: 'url'; message: string; url: string; elicitationId?: string }
  | { ok: false; reason: McpElicitationReason; detail: string }

/**
 * The params of an `elicitation/create` request as a host may be shown them, or why the request
 * is declined before anybody is asked.
 */
export const parseMcpElicitationParams = (
  params: unknown,
  options: Pick<McpResolvedElicitationOptions, 'url'>,
): ParsedRequest => {
  if (!isPlainObject(params)) {
    return { ok: false, reason: 'invalid-request', detail: 'the request has no parameters' }
  }
  const mode = params.mode ?? 'form'
  if (mode !== 'form' && mode !== 'url') {
    return { ok: false, reason: 'unsupported-mode', detail: 'the mode is neither form nor url' }
  }
  if (typeof params.message !== 'string') {
    return { ok: false, reason: 'invalid-request', detail: 'the request has no message' }
  }
  const message = cleanMcpElicitationText(params.message, MCP_ELICITATION_MESSAGE_MAX_CHARS)
  if (mode === 'url') {
    if (!options.url) {
      return {
        ok: false,
        reason: 'unsupported-mode',
        detail: 'URL mode was not offered (elicitation.url)',
      }
    }
    const url = checkMcpElicitationUrl(params.url)
    if (!url.ok) {
      return { ok: false, reason: 'insecure-url', detail: url.reason }
    }
    const elicitationId = label(params.elicitationId, MCP_ELICITATION_NAME_MAX_CHARS)
    return {
      ok: true,
      mode,
      message,
      url: url.value,
      ...(elicitationId ? { elicitationId } : {}),
    }
  }
  const schema = normalizeMcpElicitationSchema(params.requestedSchema)
  if (!schema.ok) {
    return { ok: false, reason: 'unsupported-schema', detail: schema.reason }
  }
  return { ok: true, mode, message, requestedSchema: schema.value }
}

// ── the answer, before a server sees it ──────────────────────────────────

const optionValues = (field: McpElicitationFieldSchema): string[] | undefined =>
  field.enum ?? field.oneOf?.map((o) => o.const)

const validFormat = (format: McpElicitationFieldSchema['format'], value: string): boolean => {
  switch (format) {
    case 'email':
      return /^[^@\s]+@[^@\s]+$/.test(value)
    case 'uri':
      try {
        return Boolean(new URL(value))
      } catch {
        return false
      }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    case 'date-time':
      return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))
    default:
      return true
  }
}

// Why a value does not fit its field, or undefined when it does. Never quotes the value.
const checkValue = (
  name: string,
  field: McpElicitationFieldSchema,
  value: unknown,
): string | undefined => {
  const at = `field ${fieldLabel(name)}`
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') {
        return `${at} must be a text`
      }
      const options = optionValues(field)
      if (options) {
        return options.includes(value) ? undefined : `${at} is not one of the options`
      }
      if (value.length > (field.maxLength ?? MCP_ELICITATION_VALUE_MAX_CHARS)) {
        return `${at} is too long`
      }
      if (field.minLength !== undefined && value.length < field.minLength) {
        return `${at} is too short`
      }
      return validFormat(field.format, value)
        ? undefined
        : `${at} is not a valid ${field.format ?? 'text'}`
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${at} must be a number`
      }
      if (field.type === 'integer' && !Number.isInteger(value)) {
        return `${at} must be a whole number`
      }
      if (field.minimum !== undefined && value < field.minimum) {
        return `${at} is below the minimum`
      }
      return field.maximum !== undefined && value > field.maximum
        ? `${at} is above the maximum`
        : undefined
    }
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${at} must be true or false`
    case 'array': {
      const options = field.items?.enum ?? field.items?.anyOf?.map((o) => o.const) ?? []
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return `${at} must be a list of options`
      }
      if (!value.every((item) => options.includes(item as string))) {
        return `${at} holds something that is not one of the options`
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        return `${at} has too few selected`
      }
      return (field.maxItems !== undefined && value.length > field.maxItems) ||
        value.length > MCP_ELICITATION_MAX_OPTIONS
        ? `${at} has too many selected`
        : undefined
    }
  }
}

/**
 * An accepted form, checked against the schema it answers: every value of the type and within
 * the limits its field states, every required field there, and NO field the form did not ask
 * for (what the server did not request is not sent to it). The result is a fresh object holding
 * only the form's own fields. A refusal names the field and the rule, never the value.
 */
export const validateMcpElicitationContent = (
  schema: McpElicitationSchema,
  content: unknown,
): Checked<McpElicitationContent> => {
  if (content !== undefined && !isPlainObject(content)) {
    return bad('the answer is not an object of field values')
  }
  const given = content ?? {}
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(schema.properties, name)) {
      return bad(`${fieldLabel(name)} is not a field of the form`)
    }
  }
  const required = new Set(schema.required ?? [])
  const value: McpElicitationContent = {}
  for (const [name, field] of Object.entries(schema.properties)) {
    const answered = Object.hasOwn(given, name) ? given[name] : undefined
    if (answered === undefined || answered === null) {
      if (required.has(name)) {
        return bad(`field ${fieldLabel(name)} is required`)
      }
      continue
    }
    const problem = checkValue(name, field, answered)
    if (problem) {
      return bad(problem)
    }
    value[name] = Array.isArray(answered)
      ? [...(answered as string[])]
      : (answered as string | number | boolean)
  }
  return { ok: true, value }
}

// ── asking ───────────────────────────────────────────────────────────────

/** One tool call, as far as its questions are concerned. Made per call, by the connector. */
export interface McpElicitationCall {
  server: string
  /** The tool's name as the model called it. */
  tool: string
  /** The run's abort signal (and the step's time limit), when the call has one. */
  signal?: AbortSignal
  /** Where the two events go; absent outside a run. */
  emit?: (event: McpElicitationEvent) => void
  runId?: string
  /** Set when the call is made by a helper (a subagent), not by the run itself. */
  subagent?: { id: string; depth: number }
  /** The questions asked in this run so far: one object per run, shared by its calls. */
  run: { count: number }
  /** The questions asked in this call so far. */
  asked: number
  /**
   * Set by the first answer nobody decided: the call then FAILS with this text, whatever the
   * server answers afterwards, and nothing is asked or sent again on its behalf.
   */
  failure?: string
  /** Called around the wait for the host (true: waiting), so a call's own clock can stop. */
  onWait?: (waiting: boolean) => void
  /**
   * Stops the time limits of the run the call belongs to (its step's, and those of the subagent
   * tools above it) for the length of the wait for the host; returns what starts them again.
   * The wait keeps its own bound, `timeoutMs`, and a stop of the run still ends it at once.
   */
  pause?: () => () => void
}

export interface McpElicitationDeps {
  handler: McpElicitationHandler
  options: McpResolvedElicitationOptions
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

const newId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return typeof c?.randomUUID === 'function'
    ? c.randomUUID()
    : `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const isTimeoutAbort = (signal: AbortSignal | undefined): boolean =>
  (signal?.reason as { name?: unknown } | undefined)?.name === 'TimeoutError'

const abortReason = (signal: AbortSignal | undefined): unknown => {
  if (signal?.reason !== undefined) {
    return signal.reason
  }
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

/** What a tool call fails with when one of its questions was answered without the host deciding. */
export const mcpElicitationFailure = (
  tool: string,
  reason: McpElicitationReason,
  options: McpResolvedElicitationOptions,
  detail?: string,
): string => {
  const why: Record<McpElicitationReason, string> = {
    'unsupported-schema': `the form it sent cannot be shown (${detail ?? 'unsupported schema'})`,
    'unsupported-mode': `it asked in a way this client does not offer (${detail ?? 'unsupported mode'})`,
    'insecure-url': `the link it sent was refused (${detail ?? 'not https'})`,
    'invalid-request': `its request was malformed (${detail ?? 'invalid'})`,
    subagent:
      'a helper is not allowed to ask the user (elicitation.subagents); the question was not shown',
    'cap-per-call': `it had already asked ${options.maxPerToolCall} time(s) in this call (elicitation.maxPerToolCall)`,
    'cap-per-run': `${options.maxPerRun} question(s) were already asked in this run (elicitation.maxPerRun)`,
    'handler-error': 'the host could not ask the user (its elicitation handler failed)',
    timeout: `nobody answered within ${options.timeoutMs} ms (elicitation.timeoutMs)`,
    'invalid-answer': `the answer did not fit the form (${detail ?? 'invalid'}) and was not sent`,
    aborted: 'the run was stopped',
    'step-timeout': "the tool call's time limit ended before the question was answered",
    'after-failure': 'an earlier question of the same call had already failed',
    'no-tool-call': 'no tool call was in progress',
  }
  return (
    `MCP tool "${tool}" did not finish: the server asked the user for input, and ${why[reason]}. ` +
    `The call was not repeated; do not call the tool again only because of this.`
  )
}

type WireAnswer = { action: 'accept' | 'decline' | 'cancel'; content?: McpElicitationContent }

/**
 * Answer one `elicitation/create` (its `params`, from either revision) on behalf of a tool call.
 *
 * The host's callback is called only when every guard passes: the request is well-formed and
 * within what a form may be, the call is not a helper's (unless allowed), the caps are not
 * reached, the call has not failed already. Its answer is checked against the form before it is
 * returned. In every other case the answer is made here (`decline` for a request that cannot be
 * shown, `cancel` otherwise), `call.failure` is set, and the caller fails the tool call with it.
 *
 * Throws only when the call's own signal aborted (the run was stopped, or its time was already
 * spent when the question came): the reason is rethrown, as for any aborted tool call. While
 * the host is asked, the limits of the run are stopped (`call.pause`): the wait is bounded by
 * `timeoutMs` and by a stop of the run, not by the step it belongs to.
 */
export const answerMcpElicitation = async (
  deps: McpElicitationDeps,
  call: McpElicitationCall,
  params: unknown,
): Promise<WireAnswer> => {
  const { options, log } = deps
  const id = newId()
  const where = `[mcp] ${call.server}: elicitation during ${call.tool}`
  const answered = (
    action: WireAnswer['action'],
    automatic: boolean,
    reason?: McpElicitationReason,
    fields?: string[],
  ): void =>
    call.emit?.({
      type: 'mcp.elicitation-answered',
      id,
      server: call.server,
      tool: call.tool,
      action,
      automatic,
      ...(reason ? { reason } : {}),
      ...(fields ? { fields } : {}),
    })
  // Nobody decided: the answer is made here, and the tool call fails with the reason.
  const refuse = (reason: McpElicitationReason, detail?: string): WireAnswer => {
    const action = (
      ['unsupported-schema', 'unsupported-mode', 'insecure-url', 'invalid-request'] as string[]
    ).includes(reason)
      ? 'decline'
      : 'cancel'
    call.failure ??= mcpElicitationFailure(call.tool, reason, options, detail)
    log(
      'warn',
      `${where} answered "${action}" automatically - ${reason}${detail ? `: ${detail}` : ''}`,
    )
    answered(action, true, reason)
    return { action }
  }

  if (call.failure) {
    return refuse('after-failure')
  }
  const parsed = parseMcpElicitationParams(params, options)
  if (!parsed.ok) {
    return refuse(parsed.reason, parsed.detail)
  }
  if (call.subagent && !options.subagents) {
    return refuse('subagent')
  }
  if (call.asked >= options.maxPerToolCall) {
    return refuse('cap-per-call')
  }
  if (call.run.count >= options.maxPerRun) {
    return refuse('cap-per-run')
  }
  if (call.signal?.aborted) {
    answered('cancel', true, isTimeoutAbort(call.signal) ? 'step-timeout' : 'aborted')
    throw abortReason(call.signal)
  }
  call.asked += 1
  call.run.count += 1

  const request: McpElicitationRequest = {
    id,
    server: call.server,
    tool: call.tool,
    mode: parsed.mode,
    message: parsed.message,
    ...(parsed.mode === 'form' ? { requestedSchema: parsed.requestedSchema } : { url: parsed.url }),
    ...(parsed.mode === 'url' && parsed.elicitationId
      ? { elicitationId: parsed.elicitationId }
      : {}),
    ...(call.runId ? { runId: call.runId } : {}),
    ...(call.subagent ? { subagent: call.subagent } : {}),
  }
  call.emit?.({
    type: 'mcp.elicitation-requested',
    id,
    server: call.server,
    tool: call.tool,
    mode: request.mode,
    message: request.message,
    ...(request.requestedSchema ? { requestedSchema: request.requestedSchema } : {}),
    ...(request.url ? { url: request.url } : {}),
    ...(call.subagent ? { subagent: call.subagent } : {}),
  })

  // The host's own signal: aborted when the wait ends for any reason, so a prompt left open
  // (a dialog, a terminal question) can be taken down.
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  type Outcome =
    | { kind: 'answer'; value: unknown }
    | { kind: 'error'; error: unknown }
    | { kind: 'timeout' }
    | { kind: 'aborted' }
  call.onWait?.(true)
  // A person is being asked: the step's limit is about models and tools, and does not run
  // meanwhile. It goes on, with the time it had left, the moment the wait is over.
  const resume = call.pause?.()
  const outcome = await new Promise<Outcome>((resolve) => {
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), options.timeoutMs)
    }
    onAbort = () => resolve({ kind: 'aborted' })
    call.signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => deps.handler(request, { signal: controller.signal }))
      .then(
        (value) => resolve({ kind: 'answer', value }),
        (error: unknown) => resolve({ kind: 'error', error }),
      )
  })
  resume?.()
  call.onWait?.(false)
  if (timer) {
    clearTimeout(timer)
  }
  if (onAbort) {
    call.signal?.removeEventListener('abort', onAbort)
  }
  controller.abort()

  if (outcome.kind === 'aborted') {
    const reason: McpElicitationReason = isTimeoutAbort(call.signal) ? 'step-timeout' : 'aborted'
    call.failure ??= mcpElicitationFailure(call.tool, reason, options)
    if (reason === 'step-timeout') {
      // Not the step's own limit, which does not run while the host is asked (`call.pause`): a
      // time limit put on the call's signal from outside, the run's signal included.
      log(
        'warn',
        `${where}: a time limit on the tool call's signal ended while the question was waiting for an answer; only the step's own limit stops while a person is asked, not a limit on the run's signal`,
      )
    }
    answered('cancel', true, reason)
    throw abortReason(call.signal)
  }
  if (outcome.kind === 'timeout') {
    return refuse('timeout')
  }
  if (outcome.kind === 'error') {
    // The handler's message is the host's own text and may quote what the user typed: only
    // the kind of error is said.
    const name = (outcome.error as { name?: unknown } | null)?.name
    return refuse('handler-error', typeof name === 'string' ? name.slice(0, 40) : 'error')
  }
  const result = outcome.value as { action?: unknown; content?: unknown } | null | undefined
  const action = result?.action
  if (action === 'decline' || action === 'cancel') {
    answered(action, false)
    return { action }
  }
  if (action !== 'accept') {
    return refuse('invalid-answer', 'the handler returned no accept, decline or cancel')
  }
  if (parsed.mode === 'url') {
    // Consent to open the link; a URL-mode answer carries no content.
    answered('accept', false)
    return { action: 'accept' }
  }
  const content = validateMcpElicitationContent(parsed.requestedSchema, result?.content)
  if (!content.ok) {
    return refuse('invalid-answer', content.reason)
  }
  answered('accept', false, undefined, Object.keys(content.value))
  return { action: 'accept', content: content.value }
}

// ── driving a tool call ──────────────────────────────────────────────────

/** What a later leg of a 2026-07-28 tool call adds to its params. */
export interface McpInputRequiredRetry {
  inputResponses?: Record<string, unknown>
  requestState?: string
}

/** One request of a tool call, as the connector sends it. */
export interface McpToolCallLeg {
  /** The call's signal for this leg. */
  signal?: AbortSignal
  /** 2026-07-28, after an `input_required` answer: what to add to the original params. */
  retry?: McpInputRequiredRetry
  /** 2025 revisions: the request's own timeout is replaced by the session's pausable one. */
  ownTimeout?: boolean
}

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

const isInputRequired = (
  value: unknown,
): value is { resultType: 'input_required'; inputRequests?: unknown; requestState?: unknown } =>
  isPlainObject(value) && value.resultType === 'input_required'

/** What a tool call fails with when a 2026-07-28 server asks for something that is not a question to the user. */
export const mcpInputRequestUnsupportedMessage = (toolName: string, method: unknown): string =>
  `MCP tool "${toolName}" did not finish: the server asked for input this client does not provide ` +
  `(${cleanMcpElicitationText(typeof method === 'string' ? method : 'a malformed request', 60)}; only elicitation is answered). ` +
  `The call was not repeated.`

export const mcpInputRequiredRoundsMessage = (toolName: string): string =>
  `MCP tool "${toolName}" did not finish: the server still asked for input after ` +
  `${MCP_INPUT_REQUIRED_MAX_ROUNDS} rounds. The call was not repeated.`

/** A tool call that ran past MCP_TOOL_CALL_TIMEOUT_MS of its own time (2025 revisions). */
export const mcpToolCallTimeoutMessage = (toolName: string): string =>
  `MCP tool "${toolName}" timed out after ${MCP_TOOL_CALL_TIMEOUT_MS} ms (not counting the time ` +
  `its questions waited for the user).`

export interface McpElicitationCallInfo {
  /** The tool's name as the model called it (events, the host's request). */
  tool: string
  /** The tool's own name on the server (error texts, as the other MCP errors use). */
  toolName: string
  signal?: AbortSignal
  emit?: (event: McpElicitationEvent) => void
  runId?: string
  subagent?: { id: string; depth: number }
  /** The run's counter; absent outside a run (the call then counts alone). */
  run?: { count: number }
  /** Stops the run's time limits while the host is asked; returns what starts them again. */
  pause?: () => () => void
}

export interface McpElicitationSession {
  /** The `elicitation` capability to declare. */
  capability: { form: Record<string, never>; url?: Record<string, never> }
  /**
   * 2025 revisions: answer an `elicitation/create` request the server sent. It belongs to the
   * tool call in flight (there is exactly one: `call` runs them one at a time); with none in
   * flight it is cancelled.
   */
  onRequest: (params: unknown) => Promise<WireAnswer>
  /**
   * Make one tool call. `send` issues one `tools/call` request and resolves with its result -
   * on 2026-07-28 possibly an `input_required` one, which is answered here and followed by
   * another leg. Rejects with McpElicitationError when a question was answered automatically.
   */
  call: <T>(
    era: 'legacy' | 'modern',
    info: McpElicitationCallInfo,
    send: (leg: McpToolCallLeg) => Promise<T>,
  ) => Promise<T>
}

/**
 * The elicitation side of one connection to one server.
 *
 * 2025 revisions: the server's question is a request of its own that does not say which tool
 * call it belongs to, so calls made through a session run ONE AT A TIME - the call in flight is
 * the one that asks. The call's own clock (MCP_TOOL_CALL_TIMEOUT_MS) stops while a question
 * waits. After an automatic answer the server's result is discarded and the call fails; a
 * server that asks again after that has its call aborted.
 *
 * 2026-07-28: the question is the call's own `input_required` result. Each is answered and the
 * call is sent again with the answers and the server's `requestState`, byte for byte - the
 * server's way of continuing ONE call, not a second call. After an automatic answer nothing is
 * sent again.
 */
export const createMcpElicitationSession = (
  server: string,
  deps: McpElicitationDeps,
): McpElicitationSession => {
  let current: (McpElicitationCall & { abort: (reason: unknown) => void }) | undefined
  let tail: Promise<void> = Promise.resolve()

  // One at a time; waiting for the turn ends when the caller's signal aborts.
  const acquire = async (signal: AbortSignal | undefined): Promise<() => void> => {
    const before = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortReason(signal))
          return
        }
        const onAbort = (): void => reject(abortReason(signal))
        signal?.addEventListener('abort', onAbort, { once: true })
        void before.then(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    } catch (err) {
      // Give the turn up without breaking the chain for those behind.
      void before.then(release)
      throw err
    }
    return release
  }

  const newCall = (info: McpElicitationCallInfo, signal?: AbortSignal): McpElicitationCall => ({
    server,
    tool: info.tool,
    ...(signal ? { signal } : {}),
    ...(info.emit ? { emit: info.emit } : {}),
    ...(info.runId ? { runId: info.runId } : {}),
    ...(info.subagent ? { subagent: info.subagent } : {}),
    ...(info.pause ? { pause: info.pause } : {}),
    run: info.run ?? { count: 0 },
    asked: 0,
  })

  const callLegacy = async <T>(
    info: McpElicitationCallInfo,
    send: (leg: McpToolCallLeg) => Promise<T>,
  ): Promise<T> => {
    const release = await acquire(info.signal)
    const controller = new AbortController()
    const onOuterAbort = (): void => controller.abort(abortReason(info.signal))
    info.signal?.addEventListener('abort', onOuterAbort, { once: true })
    // The call's own clock: it runs only while no question is waiting.
    let left = MCP_TOOL_CALL_TIMEOUT_MS
    let startedAt = Date.now()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const start = (): void => {
      startedAt = Date.now()
      timer = setTimeout(
        () => {
          timedOut = true
          controller.abort(new McpElicitationError(mcpToolCallTimeoutMessage(info.toolName)))
        },
        Math.max(0, left),
      )
    }
    const stop = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
        left -= Date.now() - startedAt
      }
    }
    const call = Object.assign(newCall(info, controller.signal), {
      abort: (reason: unknown) => controller.abort(reason),
      onWait: (waiting: boolean) => (waiting ? stop() : start()),
    })
    current = call
    try {
      if (info.signal?.aborted) {
        throw abortReason(info.signal)
      }
      start()
      const result = await send({ signal: controller.signal, ownTimeout: true })
      if (call.failure) {
        throw new McpElicitationError(call.failure)
      }
      return result
    } catch (err) {
      // The caller's own abort stays what it was.
      if (info.signal?.aborted) {
        throw err
      }
      if (call.failure) {
        throw new McpElicitationError(call.failure)
      }
      if (timedOut) {
        throw new McpElicitationError(mcpToolCallTimeoutMessage(info.toolName))
      }
      throw err
    } finally {
      stop()
      info.signal?.removeEventListener('abort', onOuterAbort)
      if (current === call) {
        current = undefined
      }
      release()
    }
  }

  const callModern = async <T>(
    info: McpElicitationCallInfo,
    send: (leg: McpToolCallLeg) => Promise<T>,
  ): Promise<T> => {
    const call = newCall(info, info.signal)
    let retry: McpInputRequiredRetry | undefined
    for (let round = 0; ; round += 1) {
      const result = await send({
        ...(info.signal ? { signal: info.signal } : {}),
        ...(retry ? { retry } : {}),
      })
      if (!isInputRequired(result)) {
        return result
      }
      if (round >= MCP_INPUT_REQUIRED_MAX_ROUNDS) {
        throw new McpElicitationError(mcpInputRequiredRoundsMessage(info.toolName))
      }
      const requests = isPlainObject(result.inputRequests)
        ? Object.entries(result.inputRequests)
        : []
      const state = typeof result.requestState === 'string' ? result.requestState : undefined
      if (requests.length === 0 && state === undefined) {
        throw new McpElicitationError(
          mcpInputRequestUnsupportedMessage(info.toolName, 'an empty input_required result'),
        )
      }
      // Checked before anybody is asked: a round that also wants something this client does
      // not provide (sampling, roots) is not answered in part.
      for (const [, entry] of requests) {
        if (!isPlainObject(entry) || entry.method !== 'elicitation/create') {
          throw new McpElicitationError(
            mcpInputRequestUnsupportedMessage(
              info.toolName,
              isPlainObject(entry) ? entry.method : undefined,
            ),
          )
        }
      }
      // Keys are the server's: a prototype-less object, so none of them can be special.
      const responses = Object.create(null) as Record<string, unknown>
      for (const [key, entry] of requests) {
        const answer = await answerMcpElicitation(
          deps,
          call,
          (entry as Record<string, unknown>).params,
        )
        if (call.failure) {
          // Nobody decided: nothing is sent again.
          throw new McpElicitationError(call.failure)
        }
        responses[key] = answer
      }
      if (requests.length === 0) {
        // Only "call me again": do not spin.
        await sleep(MCP_INPUT_REQUIRED_PACING_MS, info.signal)
      }
      retry = {
        ...(requests.length ? { inputResponses: responses } : {}),
        ...(state !== undefined ? { requestState: state } : {}),
      }
    }
  }

  return {
    capability: mcpElicitationCapability(deps.options),
    onRequest: async (params) => {
      const call = current
      if (!call) {
        deps.log(
          'warn',
          `[mcp] ${server}: the server asked the user for input while no tool call was in progress; cancelled`,
        )
        return { action: 'cancel' }
      }
      const failedBefore = call.failure !== undefined
      const answer = await answerMcpElicitation(deps, call, params)
      if (failedBefore) {
        // It was told the call is over and asks again: stop waiting for it.
        call.abort(new McpElicitationError(call.failure as string))
      }
      return answer
    },
    call: (era, info, send) => (era === 'modern' ? callModern(info, send) : callLegacy(info, send)),
  }
}
