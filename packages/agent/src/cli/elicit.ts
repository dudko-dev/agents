import type {
  McpElicitationContent,
  McpElicitationFieldSchema,
  McpElicitationRequest,
  McpElicitationResult,
} from '../mcp-elicitation.ts'

// MCP elicitation at the terminal: a server asks the user something in the middle of a tool
// call, and the REPL puts the question at the prompt. Pure but for the `ask` it is given (the
// REPL's readline), so it is tested without a terminal.
//
// Everything a server sent is printed as a quotation ("| " in front of each line): third-party
// text, never the CLI's own. A link (URL mode) is printed and never opened.

// AGENT_MCP_ELICITATION: off (default) | form | all.
export type ElicitationMode = 'off' | 'form' | 'all'

export const parseElicitationMode = (raw: string | undefined): ElicitationMode => {
  const v = raw?.trim().toLowerCase()
  if (!v || ['off', 'false', '0', 'no'].includes(v)) {
    return 'off'
  }
  if (['form', 'on', 'true', '1', 'yes'].includes(v)) {
    return 'form'
  }
  if (v === 'all') {
    return 'all'
  }
  throw new Error(`AGENT_MCP_ELICITATION must be off | form | all, got: ${raw}`)
}

// How many times a value that does not fit is asked for again before the question is cancelled.
export const ELICIT_FIELD_ATTEMPTS = 3

const optionsOf = (field: McpElicitationFieldSchema): { value: string; title?: string }[] => {
  if (field.enum) {
    return field.enum.map((value, i) => ({
      value,
      ...(field.enumNames?.[i] && field.enumNames[i] !== value
        ? { title: field.enumNames[i] }
        : {}),
    }))
  }
  const titled = field.oneOf ?? field.items?.anyOf
  if (titled) {
    return titled.map((o) => ({
      value: o.const,
      ...(o.title !== o.const ? { title: o.title } : {}),
    }))
  }
  return (field.items?.enum ?? []).map((value) => ({ value }))
}

const showOptions = (field: McpElicitationFieldSchema): string =>
  optionsOf(field)
    .map((o) => (o.title ? `${o.value} (${o.title})` : o.value))
    .join(', ')

// One line that says what a field wants.
export const describeElicitationField = (
  name: string,
  field: McpElicitationFieldSchema,
  required: boolean,
): string => {
  const what: string[] = []
  const options = optionsOf(field)
  if (field.type === 'array') {
    what.push(`pick from: ${showOptions(field)} (comma-separated)`)
  } else if (options.length) {
    what.push(`one of: ${showOptions(field)}`)
  } else if (field.type === 'boolean') {
    what.push('y / n')
  } else if (field.type === 'number' || field.type === 'integer') {
    const range = [
      field.minimum !== undefined ? `min ${field.minimum}` : '',
      field.maximum !== undefined ? `max ${field.maximum}` : '',
    ].filter(Boolean)
    what.push(
      `${field.type === 'integer' ? 'a whole number' : 'a number'}${range.length ? `, ${range.join(', ')}` : ''}`,
    )
  } else if (field.format) {
    what.push(field.format)
  }
  if (field.default !== undefined) {
    what.push(
      `default ${Array.isArray(field.default) ? field.default.join(',') : String(field.default)}`,
    )
  }
  what.push(required ? 'required' : 'optional')
  const label = field.title && field.title !== name ? `${name} - ${field.title}` : name
  return `${label} [${what.join('; ')}]`
}

type FieldInput =
  | { kind: 'value'; value: string | number | boolean | string[] }
  | { kind: 'skip' }
  | { kind: 'again'; hint: string }

// What a typed line means for a field. An empty line takes the default, else leaves the field
// out. The value's fit to the form (length, range, format) is checked by the agent itself
// before anything is sent: this only turns text into the right type.
export const parseElicitationInput = (
  field: McpElicitationFieldSchema,
  line: string,
): FieldInput => {
  const text = line.trim()
  if (!text) {
    return field.default !== undefined ? { kind: 'value', value: field.default } : { kind: 'skip' }
  }
  const options = optionsOf(field).map((o) => o.value)
  switch (field.type) {
    case 'boolean': {
      const v = text.toLowerCase()
      if (['y', 'yes', 'true', '1'].includes(v)) {
        return { kind: 'value', value: true }
      }
      if (['n', 'no', 'false', '0'].includes(v)) {
        return { kind: 'value', value: false }
      }
      return { kind: 'again', hint: 'answer y or n' }
    }
    case 'number':
    case 'integer': {
      const n = Number(text)
      return Number.isFinite(n)
        ? { kind: 'value', value: n }
        : { kind: 'again', hint: 'that is not a number' }
    }
    case 'array': {
      const picked = text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const unknown = picked.filter((p) => !options.includes(p))
      return unknown.length
        ? { kind: 'again', hint: `not among the options: ${unknown.join(', ')}` }
        : { kind: 'value', value: picked }
    }
    default:
      return options.length && !options.includes(text)
        ? { kind: 'again', hint: 'that is not one of the options' }
        : { kind: 'value', value: text }
  }
}

// A server's text, as a quotation.
const quoted = (text: string): string =>
  text
    .split('\n')
    .map((line) => `          | ${line}`)
    .join('\n')

/**
 * Put one elicitation to the person at the terminal. `ask` shows a prompt and resolves with the
 * line typed (it rejects when the question is no longer wanted: the run was stopped, or the
 * time ran out). At any prompt `/cancel` dismisses the whole question.
 */
export const answerElicitationAtPrompt = async (
  request: McpElicitationRequest,
  ask: (prompt: string) => Promise<string>,
): Promise<McpElicitationResult> => {
  const who = request.subagent ? ` (asked by a helper's call)` : ''
  const head = `[ask]     MCP server "${request.server}" asks during ${request.tool}${who}:\n${quoted(request.message || '(no message)')}`
  if (request.mode === 'url') {
    const answer = (
      await ask(
        `${head}\n          It wants you to open this link yourself (nothing here opens it):\n          ${request.url}\n          open it? [y]es / [n]o / [c]ancel: `,
      )
    )
      .trim()
      .toLowerCase()
    if (answer === 'y' || answer === 'yes') {
      return { action: 'accept' }
    }
    return answer === 'n' || answer === 'no' ? { action: 'decline' } : { action: 'cancel' }
  }
  const properties = request.requestedSchema?.properties ?? {}
  const required = new Set(request.requestedSchema?.required ?? [])
  const names = Object.keys(properties)
  const go = (
    await ask(
      `${head}\n          ${names.length} field(s): ${names.join(', ') || '(none)'}\n          answer? [y]es / [n]o / [c]ancel: `,
    )
  )
    .trim()
    .toLowerCase()
  if (go === 'n' || go === 'no') {
    return { action: 'decline' }
  }
  if (go !== 'y' && go !== 'yes') {
    return { action: 'cancel' }
  }
  const content: McpElicitationContent = {}
  for (const name of names) {
    const field = properties[name]
    const prompt = `          ${describeElicitationField(name, field, required.has(name))}${field.description ? `\n${quoted(field.description)}` : ''}\n          > `
    let hint = ''
    let done = false
    for (let attempt = 0; attempt < ELICIT_FIELD_ATTEMPTS && !done; attempt++) {
      const line = await ask(hint ? `          (${hint})\n${prompt}` : prompt)
      if (line.trim().toLowerCase() === '/cancel') {
        return { action: 'cancel' }
      }
      const input = parseElicitationInput(field, line)
      if (input.kind === 'value') {
        content[name] = input.value
        done = true
      } else if (input.kind === 'skip' && !required.has(name)) {
        done = true
      } else {
        hint = input.kind === 'again' ? input.hint : 'this field is required (/cancel to dismiss)'
      }
    }
    if (!done) {
      return { action: 'cancel' }
    }
  }
  return { action: 'accept', content }
}
