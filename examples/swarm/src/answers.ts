// The answer to an item a parked turn waits for, checked by its kind. Pure and import-free: the
// gateway checks an answer before it signals the session (a clear 400), and the workflow checks it
// again when it takes it (the authority: an answer that reached the workflow some other way is
// held to the same rules). The core checks it a third time on the resume.
//
//   'approval' - a person's decision on a tool call: { "approved": true } or
//                { "approved": false, "reason"?: "..." }
//   'tool'     - the result of a call whose result comes from outside (deferResult): the tool's
//                output { "output": <JSON> } or its failure { "error": "..." }

export type ParkedKind = 'approval' | 'tool'

export const ANSWER_LIMITS = {
  // An approval's `reason`, and a tool answer's `error` (the core's JOURNAL_LIMITS.errorChars).
  reasonChars: 2_000,
  errorChars: 4_000,
  // A tool answer's `output`, serialized (the core takes up to 1 000 000; the gateway's body cap is
  // the tighter bound in practice).
  outputChars: 1_000_000,
  // Nesting of a tool answer's `output` (the core's JOURNAL_LIMITS.answerDepth).
  outputDepth: 64,
} as const

export const isParkedKind = (v: unknown): v is ParkedKind => v === 'approval' || v === 'tool'

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return false
  }
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const jsonProblem = (v: unknown, depth: number): string | undefined => {
  if (depth > ANSWER_LIMITS.outputDepth) {
    return `it is nested deeper than ${ANSWER_LIMITS.outputDepth} levels`
  }
  if (v === null || typeof v === 'string' || typeof v === 'boolean') {
    return undefined
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? undefined : 'it holds a number that is not finite'
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = jsonProblem(x, depth + 1)
      if (p) return p
    }
    return undefined
  }
  if (isPlainObject(v)) {
    for (const x of Object.values(v)) {
      const p = jsonProblem(x, depth + 1)
      if (p) return p
    }
    return undefined
  }
  return 'it is not plain JSON'
}

const approvalProblem = (a: Record<string, unknown>): string | undefined => {
  const shape = 'an approval is { "approved": true | false, "reason"?: "..." }'
  if ('remember' in a) {
    // The core's `remember` lasts for one agent instance; on a swarm the next call may run on any
    // worker, so it would hold on one worker and not on the others.
    return `${shape}: "remember" is not supported here (every call is decided on its own)`
  }
  if (
    typeof a.approved !== 'boolean' ||
    Object.keys(a).some((k) => k !== 'approved' && k !== 'reason')
  ) {
    return shape
  }
  if (a.reason !== undefined) {
    if (typeof a.reason !== 'string') {
      return shape
    }
    if (a.reason.length > ANSWER_LIMITS.reasonChars) {
      return `"reason" is limited to ${ANSWER_LIMITS.reasonChars} characters`
    }
  }
  return undefined
}

const toolProblem = (a: Record<string, unknown>): string | undefined => {
  const shape = 'a tool result is { "output": <JSON> } or { "error": "<what failed>" }'
  const keys = Object.keys(a)
  if (keys.length === 1 && keys[0] === 'error') {
    if (typeof a.error !== 'string' || !a.error.trim()) {
      return shape
    }
    return a.error.length > ANSWER_LIMITS.errorChars
      ? `"error" is limited to ${ANSWER_LIMITS.errorChars} characters`
      : undefined
  }
  if (keys.length !== 1 || keys[0] !== 'output' || a.output === undefined) {
    return shape
  }
  const p = jsonProblem(a.output, 0)
  if (p) {
    return `${shape}: its output is not usable (${p})`
  }
  const size = JSON.stringify(a.output).length
  return size > ANSWER_LIMITS.outputChars
    ? `"output" is limited to ${ANSWER_LIMITS.outputChars} characters as JSON (got ${size})`
    : undefined
}

// Why `value` cannot answer an item of `kind` - or undefined when it can.
export const answerProblem = (kind: ParkedKind, value: unknown): string | undefined => {
  if (!isPlainObject(value)) {
    return 'an answer is a JSON object'
  }
  return kind === 'approval' ? approvalProblem(value) : toolProblem(value)
}
