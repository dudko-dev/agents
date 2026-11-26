// The pipeline engine: the JSON definition, its validation, the edge conditions and the scheduler.
// Pure - no agent, no I/O, no imports: a node is run by the `runNode` it is handed.
//
// A DELIBERATE COPY. `packages/agent/src/pipeline-engine.ts` and
// `packages/agent-web/src/pipeline/engine.ts` are the same file, byte for byte: change both, with
// tests (`tests/pipeline-agent.test.ts` in the Node package fails when they differ). Only the adapter
// that runs a node with a package's own `createAgent` is different (`pipeline.ts` /
// `pipeline/index.ts`).

// ── The definition (plain JSON) ──────────────────────────────────────────────

export interface PipelineDefinition {
  version: 1
  name?: string
  // The id of the node that receives the request.
  entry: string
  nodes: PipelineNode[]
  edges: PipelineEdge[]
  limits?: {
    // Visits of one node (default 3).
    maxNodeVisits?: number
    // Node runs of the whole pipeline (default 25).
    maxRuns?: number
  }
}

export interface PipelineNode {
  id: string
  name?: string
  // This node's role, added to its agent's system prompt.
  instructions?: string
  // Keys the host resolves. Never a model object, never a secret.
  model?: string
  skills?: string[]
  tools?: string[]
  mcpServers?: string[]
  // The node picks one of these after it answers.
  routes?: PipelineRoute[]
  // How a node activated by several edges waits for them (default 'all').
  join?: 'all' | 'any'
  // Passed to the host's resolver untouched.
  settings?: Record<string, unknown>
  // For editors; the runner ignores it.
  position?: { x: number; y: number }
}

export interface PipelineRoute {
  label: string
  description?: string
}

export type PipelineCondition =
  | { kind: 'always' }
  | { kind: 'contains'; text: string; caseSensitive?: boolean }
  | { kind: 'matches'; pattern: string; flags?: string }
  | { kind: 'route'; label: string }
  | { kind: 'otherwise' }

export interface PipelineEdge {
  // Unique. An edge without one is given `e<its position in edges>` (see normalizePipeline).
  id?: string
  from: string
  to: string
  // Absent = always.
  when?: PipelineCondition
}

// ── Bounds ───────────────────────────────────────────────────────────────────

export const PIPELINE_LIMITS = {
  // Defaults of `limits`.
  maxNodeVisits: 3,
  maxRuns: 25,
  // The largest values `limits` accepts (the smallest is 1).
  maxNodeVisitsCeiling: 100,
  maxRunsCeiling: 1000,
  // The size of a definition.
  maxNodes: 200,
  maxEdges: 1000,
  maxRoutes: 20,
  // `matches`: the longest pattern, and the largest compiled program (what `a{50}` grows into).
  maxPatternLength: 500,
  maxPatternProgram: 1000,
  // `contains` and `matches` look at this many leading characters of an output.
  conditionInputChars: 50_000,
} as const

// ── What a run hands out ─────────────────────────────────────────────────────

export interface PipelineUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
}

export interface PipelineNodeSource {
  nodeId: string
  name?: string
  text: string
}

export interface PipelineNodeInput {
  // The original input of the run.
  request: string
  // The outputs that activated this visit (empty for the entry node's first visit).
  from: PipelineNodeSource[]
  // 1 for the first visit of this node.
  visit: number
}

export interface PipelineNodeOutput {
  text: string
  usage?: PipelineUsage
  // One of the node's `routes` labels; anything else counts as no route.
  route?: string
}

export interface PipelineNodeContext<E = never> {
  // Aborted when the run is aborted, or when another node of the wave failed.
  signal: AbortSignal
  pipeline: PipelineDefinition
  // Forward one of the node's own events; the runner adds `nodeId` and `visit`.
  emit: (event: E) => void
}

export type PipelineNodeRunner<E = never> = (
  node: PipelineNode,
  input: PipelineNodeInput,
  ctx: PipelineNodeContext<E>,
) => Promise<PipelineNodeOutput>

export type PipelineStop = 'maxRuns' | 'maxNodeVisits' | 'aborted'

export type PipelineEvent =
  | { type: 'pipeline.started'; pipeline?: string }
  | { type: 'pipeline.node.started'; nodeId: string; visit: number; from: string[] }
  | {
      type: 'pipeline.node.finished'
      nodeId: string
      visit: number
      text: string
      route?: string
      usage?: PipelineUsage
    }
  | { type: 'pipeline.node.failed'; nodeId: string; visit: number; error: string }
  // An activation a cap refused: the node does not start.
  | {
      type: 'pipeline.node.skipped'
      nodeId: string
      from: string[]
      reason: 'maxRuns' | 'maxNodeVisits'
    }
  // `visit` is the visit of the SOURCE node whose output decided the edge.
  | {
      type: 'pipeline.edge'
      from: string
      to: string
      edgeId: string
      visit: number
      fired: boolean
    }
  | { type: 'pipeline.finished'; stoppedBy?: PipelineStop; runs: number }

// A node's own event, as the runner forwards it.
export type PipelineNodeEvent<E> = E & { nodeId: string; visit: number }

export type PipelineTraceEntry =
  | {
      type: 'node'
      nodeId: string
      visit: number
      wave: number
      from: string[]
      text: string
      route?: string
      usage?: PipelineUsage
    }
  | { type: 'edge'; from: string; to: string; edgeId: string; visit: number; fired: boolean }
  // An activation a cap refused: the node did not run.
  | { type: 'dropped'; nodeId: string; from: string[]; reason: 'maxRuns' | 'maxNodeVisits' }

export interface PipelineResult {
  // The output of the last terminal node to finish; several of the same wave are joined under
  // their names.
  text: string
  outputs: Record<string, { visit: number; text: string; route?: string }[]>
  // Node runs, edge decisions and dropped activations, in order.
  trace: PipelineTraceEntry[]
  usage: PipelineUsage
  stoppedBy?: PipelineStop
  // Node runs started.
  runs: number
}

export interface PipelineIssue {
  code: string
  message: string
  nodeId?: string
  edgeId?: string
  // Position in `edges`.
  edgeIndex?: number
}

export interface PipelineValidation {
  ok: boolean
  errors: PipelineIssue[]
  warnings: PipelineIssue[]
}

export class PipelineValidationError extends Error {
  errors: PipelineIssue[]
  constructor(errors: PipelineIssue[]) {
    super(`Invalid pipeline: ${errors.map((e) => e.message).join('; ')}`)
    this.name = 'PipelineValidationError'
    this.errors = errors
  }
}

export class PipelineNodeError extends Error {
  nodeId: string
  visit: number
  constructor(nodeId: string, visit: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`Pipeline node "${nodeId}" failed (visit ${visit}): ${reason}`, { cause })
    this.name = 'PipelineNodeError'
    this.nodeId = nodeId
    this.visit = visit
  }
}

// ── `matches`: a matcher that cannot backtrack ───────────────────────────────
//
// A definition may come from someone else, and a backtracking regex engine (the browser's, Node's)
// has no timeout: `(a+)+$` on thirty characters is enough to hang a tab. So a pattern is NOT run by
// RegExp. It is compiled to a small program and simulated over the input one character at a time,
// keeping the SET of positions the program can be in (a Pike VM): the work is bounded by
// (input length) x (program size), whatever the pattern. The price is a subset of the syntax: no
// backreferences and no lookaround (they are what needs backtracking), no \p{...}.

type Assertion = 'start' | 'end' | 'word' | 'not-word'

type Ast =
  | { t: 'char'; c: number }
  | { t: 'any' }
  // Flat pairs: lo, hi, lo, hi ...
  | { t: 'set'; r: number[]; neg: boolean }
  | { t: 'assert'; k: Assertion }
  | { t: 'cat'; items: Ast[] }
  | { t: 'alt'; items: Ast[] }
  | { t: 'rep'; item: Ast; min: number; max: number }

type Inst =
  | { op: 'char'; c: number }
  | { op: 'any' }
  | { op: 'set'; r: number[]; neg: boolean }
  | { op: 'assert'; k: Assertion }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'match' }

const cp = (s: string): number => s.codePointAt(0) as number

const DIGIT = [0x30, 0x39]
const WORD = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a]
const SPACE = [
  0x09, 0x0d, 0x20, 0x20, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f,
  0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff,
]
const MAX_CODE_POINT = 0x10ffff
const MAX_REPEAT = 1000

const inRanges = (r: number[], c: number): boolean => {
  for (let i = 0; i < r.length; i += 2) {
    if (c >= r[i] && c <= r[i + 1]) return true
  }
  return false
}

// The ranges NOT covered by `r`.
const complement = (r: number[]): number[] => {
  const pairs: [number, number][] = []
  for (let i = 0; i < r.length; i += 2) pairs.push([r[i], r[i + 1]])
  pairs.sort((a, b) => a[0] - b[0])
  const out: number[] = []
  let next = 0
  for (const [lo, hi] of pairs) {
    if (lo > next) out.push(next, lo - 1)
    next = Math.max(next, hi + 1)
  }
  if (next <= MAX_CODE_POINT) out.push(next, MAX_CODE_POINT)
  return out
}

const isLineEnd = (c: number): boolean => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029
const isWordChar = (c: number | undefined): boolean => c !== undefined && inRanges(WORD, c)
const isHex = (c: number | undefined): boolean =>
  c !== undefined && /^[0-9a-fA-F]$/.test(String.fromCodePoint(c))
const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39

const parsePattern = (pattern: string): Ast => {
  const src = Array.from(pattern, cp)
  let i = 0
  const peek = (offset = 0): number | undefined => src[i + offset]
  const is = (ch: string, offset = 0): boolean => src[i + offset] === cp(ch)
  const fail = (message: string): never => {
    throw new Error(`${message} (at ${i})`)
  }

  const hex = (digits: number): number => {
    let value = 0
    for (let n = 0; n < digits; n++) {
      if (!isHex(peek())) fail('a bad hexadecimal escape')
      value = value * 16 + parseInt(String.fromCodePoint(src[i++]), 16)
    }
    return value
  }

  // After the backslash. A class shorthand comes back as ranges, anything else as one character.
  const escape = (inClass: boolean): { c: number } | { r: number[] } | { k: Assertion } => {
    const c = peek()
    if (c === undefined) return fail('a pattern cannot end with a backslash')
    i++
    const ch = String.fromCodePoint(c)
    switch (ch) {
      case 'd':
        return { r: DIGIT }
      case 'D':
        return { r: complement(DIGIT) }
      case 'w':
        return { r: WORD }
      case 'W':
        return { r: complement(WORD) }
      case 's':
        return { r: SPACE }
      case 'S':
        return { r: complement(SPACE) }
      case 'b':
        return inClass ? { c: 0x08 } : { k: 'word' }
      case 'B':
        return inClass ? fail('\\B is not allowed in a class') : { k: 'not-word' }
      case 'n':
        return { c: 0x0a }
      case 'r':
        return { c: 0x0d }
      case 't':
        return { c: 0x09 }
      case 'f':
        return { c: 0x0c }
      case 'v':
        return { c: 0x0b }
      case '0':
        return isDigit(peek()) ? fail('octal escapes are not supported') : { c: 0 }
      case 'x':
        return { c: hex(2) }
      case 'u': {
        if (!is('{')) return { c: hex(4) }
        i++
        let value = 0
        let digits = 0
        while (isHex(peek())) {
          value = value * 16 + parseInt(String.fromCodePoint(src[i++]), 16)
          digits++
          if (value > MAX_CODE_POINT) fail('a code point out of range')
        }
        if (!digits || !is('}')) fail('a bad \\u{...} escape')
        i++
        return { c: value }
      }
      case 'k':
        return fail('backreferences are not supported')
      case 'p':
      case 'P':
        return fail('\\p{...} is not supported')
      case 'c':
        return fail('\\c control escapes are not supported')
      default:
        if (isDigit(c)) return fail('backreferences are not supported')
        if (/^[a-zA-Z]$/.test(ch)) return fail(`unknown escape \\${ch}`)
        return { c }
    }
  }

  const klass = (): Ast => {
    const neg = is('^')
    if (neg) i++
    const r: number[] = []
    for (;;) {
      const c = peek()
      if (c === undefined) return fail('an unterminated class')
      if (is(']')) {
        i++
        break
      }
      i++
      let lo: number
      if (c === cp('\\')) {
        const e = escape(true)
        if ('r' in e) {
          r.push(...e.r)
          continue
        }
        lo = (e as { c: number }).c
      } else {
        lo = c
      }
      if (is('-') && peek(1) !== undefined && !is(']', 1)) {
        i++
        let hi = src[i++]
        if (hi === cp('\\')) {
          const e = escape(true)
          if (!('c' in e)) return fail('a bad range in a class')
          hi = e.c
        }
        if (hi < lo) fail('a range out of order in a class')
        r.push(lo, hi)
      } else {
        r.push(lo, lo)
      }
    }
    return { t: 'set', r, neg }
  }

  // `{n}`, `{n,}`, `{n,m}` at the cursor, or undefined when the brace is not a quantifier.
  const braces = (): { min: number; max: number } | undefined => {
    let j = i + 1
    const number = (): number | undefined => {
      const start = j
      while (isDigit(src[j])) j++
      return j > start ? Number(String.fromCodePoint(...src.slice(start, j))) : undefined
    }
    const min = number()
    if (min === undefined) return undefined
    let max: number | undefined = min
    if (src[j] === cp(',')) {
      j++
      max = number() ?? Infinity
    }
    if (src[j] !== cp('}')) return undefined
    i = j + 1
    if (max < min) fail('a quantifier out of order')
    if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
      fail(`a repeat count above ${MAX_REPEAT}`)
    }
    return { min, max }
  }

  const atom = (): Ast => {
    const c = src[i++]
    switch (String.fromCodePoint(c)) {
      case '(': {
        if (is('?')) {
          if (is(':', 1)) {
            i += 2
          } else if (is('<', 1) && !is('=', 2) && !is('!', 2)) {
            // A named group: the name is dropped, nothing is captured.
            while (peek() !== undefined && !is('>')) i++
            if (peek() === undefined) fail('an unterminated group name')
            i++
          } else {
            fail('lookaround is not supported')
          }
        }
        const inner = alternation()
        if (!is(')')) fail('an unterminated group')
        i++
        return inner
      }
      case '[':
        return klass()
      case '.':
        return { t: 'any' }
      case '^':
        return { t: 'assert', k: 'start' }
      case '$':
        return { t: 'assert', k: 'end' }
      case '\\': {
        const e = escape(false)
        if ('k' in e) return { t: 'assert', k: e.k }
        return 'r' in e ? { t: 'set', r: e.r, neg: false } : { t: 'char', c: e.c }
      }
      case '*':
      case '+':
      case '?':
        return fail('nothing to repeat')
      case '{':
        i--
        if (braces()) fail('nothing to repeat')
        i++
        return { t: 'char', c }
      default:
        return { t: 'char', c }
    }
  }

  const repetition = (): Ast => {
    let item = atom()
    for (;;) {
      let q: { min: number; max: number } | undefined
      if (is('*')) q = { min: 0, max: Infinity }
      else if (is('+')) q = { min: 1, max: Infinity }
      else if (is('?')) q = { min: 0, max: 1 }
      if (q) i++
      else if (is('{')) q = braces()
      if (!q) return item
      if (item.t === 'assert') fail('nothing to repeat')
      // Lazy (`*?`): the same answer for a yes/no test.
      if (is('?')) i++
      item = { t: 'rep', item, min: q.min, max: q.max }
    }
  }

  const sequence = (): Ast => {
    const items: Ast[] = []
    while (peek() !== undefined && !is('|') && !is(')')) items.push(repetition())
    return items.length === 1 ? items[0] : { t: 'cat', items }
  }

  function alternation(): Ast {
    const items = [sequence()]
    while (is('|')) {
      i++
      items.push(sequence())
    }
    return items.length === 1 ? items[0] : { t: 'alt', items }
  }

  const ast = alternation()
  if (i < src.length) fail('an unmatched )')
  return ast
}

const compileAst = (ast: Ast): Inst[] => {
  const prog: Inst[] = []
  const push = (inst: Inst): number => {
    if (prog.length >= PIPELINE_LIMITS.maxPatternProgram) {
      throw new Error(
        `the pattern is too complex (more than ${PIPELINE_LIMITS.maxPatternProgram} steps once its repeats are unrolled)`,
      )
    }
    prog.push(inst)
    return prog.length - 1
  }
  const emit = (node: Ast): void => {
    switch (node.t) {
      case 'char':
        push({ op: 'char', c: node.c })
        return
      case 'any':
        push({ op: 'any' })
        return
      case 'set':
        push({ op: 'set', r: node.r, neg: node.neg })
        return
      case 'assert':
        push({ op: 'assert', k: node.k })
        return
      case 'cat':
        for (const item of node.items) emit(item)
        return
      case 'alt': {
        const exits: Extract<Inst, { op: 'jmp' }>[] = []
        node.items.forEach((item, index) => {
          if (index === node.items.length - 1) {
            emit(item)
            return
          }
          const split: Inst = { op: 'split', x: 0, y: 0 }
          split.x = push(split) + 1
          emit(item)
          const exit: Extract<Inst, { op: 'jmp' }> = { op: 'jmp', x: 0 }
          push(exit)
          exits.push(exit)
          split.y = prog.length
        })
        for (const exit of exits) exit.x = prog.length
        return
      }
      case 'rep': {
        for (let n = 0; n < node.min; n++) emit(node.item)
        if (node.max === Infinity) {
          const split: Inst = { op: 'split', x: 0, y: 0 }
          const at = push(split)
          split.x = at + 1
          emit(node.item)
          push({ op: 'jmp', x: at })
          split.y = prog.length
          return
        }
        const skips: Extract<Inst, { op: 'split' }>[] = []
        for (let n = node.min; n < node.max; n++) {
          const split: Extract<Inst, { op: 'split' }> = { op: 'split', x: 0, y: 0 }
          split.x = push(split) + 1
          skips.push(split)
          emit(node.item)
        }
        for (const split of skips) split.y = prog.length
        return
      }
    }
  }
  emit(ast)
  push({ op: 'match' })
  return prog
}

const ALLOWED_FLAGS = 'imsu'

// A compiled `matches` condition: does the pattern occur anywhere in the text?
type Matcher = (text: string) => boolean

// Throws an Error that says what is wrong with the pattern or the flags.
const compileMatcher = (pattern: string, flags = ''): Matcher => {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('the pattern is empty')
  }
  if (pattern.length > PIPELINE_LIMITS.maxPatternLength) {
    throw new Error(`the pattern is longer than ${PIPELINE_LIMITS.maxPatternLength} characters`)
  }
  if (typeof flags !== 'string') throw new Error('flags must be a string')
  for (const flag of flags) {
    if (!ALLOWED_FLAGS.includes(flag)) {
      throw new Error(`flag "${flag}" is not allowed (allowed: ${ALLOWED_FLAGS})`)
    }
  }
  if (new Set(flags).size !== flags.length) throw new Error('a flag is repeated')
  // The subset must also be a regular expression as JavaScript reads it. Compiling is linear;
  // the RegExp is never executed.
  try {
    new RegExp(pattern, flags)
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
  const prog = compileAst(parsePattern(pattern))
  const ignoreCase = flags.includes('i')
  const multiline = flags.includes('m')
  const dotAll = flags.includes('s')
  // A case mapping that is not one character for one character (ß → SS) is no mapping.
  const single = (c: number, mapped: string): number =>
    mapped.length === String.fromCodePoint(cp(mapped)).length ? cp(mapped) : c
  const lower = (c: number): number => single(c, String.fromCodePoint(c).toLowerCase())
  const upper = (c: number): number => single(c, String.fromCodePoint(c).toUpperCase())

  return (text: string): boolean => {
    const input = Array.from(text.slice(0, PIPELINE_LIMITS.conditionInputChars), cp)
    const n = input.length
    // mark[pc] === generation: this program position is already on the list for this character.
    const mark = new Int32Array(prog.length)
    let generation = 0
    let matched = false
    const stack: number[] = []

    const holds = (k: Assertion, pos: number): boolean => {
      switch (k) {
        case 'start':
          return pos === 0 || (multiline && isLineEnd(input[pos - 1]))
        case 'end':
          return pos === n || (multiline && isLineEnd(input[pos]))
        case 'word':
          return isWordChar(input[pos - 1]) !== isWordChar(input[pos])
        case 'not-word':
          return isWordChar(input[pos - 1]) === isWordChar(input[pos])
      }
    }

    // Follow the jumps from `start` and list every position that waits for a character.
    const add = (list: number[], start: number, pos: number): void => {
      stack.push(start)
      while (stack.length) {
        const pc = stack.pop() as number
        if (mark[pc] === generation) continue
        mark[pc] = generation
        const inst = prog[pc]
        switch (inst.op) {
          case 'jmp':
            stack.push(inst.x)
            break
          case 'split':
            stack.push(inst.y, inst.x)
            break
          case 'assert':
            if (holds(inst.k, pos)) stack.push(pc + 1)
            break
          case 'match':
            matched = true
            break
          default:
            list.push(pc)
        }
      }
    }

    let current: number[] = []
    let next: number[] = []
    generation++
    add(current, 0, 0)
    for (let pos = 0; pos < n && !matched; pos++) {
      const c = input[pos]
      const lo = ignoreCase ? lower(c) : c
      const up = ignoreCase ? upper(c) : c
      generation++
      for (const pc of current) {
        const inst = prog[pc]
        let ok = false
        if (inst.op === 'char') {
          ok =
            inst.c === c || (ignoreCase && (inst.c === lo || inst.c === up || lower(inst.c) === lo))
        } else if (inst.op === 'any') {
          ok = dotAll || !isLineEnd(c)
        } else if (inst.op === 'set') {
          const inside =
            inRanges(inst.r, c) || (ignoreCase && (inRanges(inst.r, lo) || inRanges(inst.r, up)))
          ok = inside !== inst.neg
        }
        if (ok) add(next, pc + 1, pos + 1)
      }
      // A match may start at any character.
      add(next, 0, pos + 1)
      current = next
      next = []
    }
    return matched
  }
}

// ── Conditions ───────────────────────────────────────────────────────────────

const CONDITION_KINDS = ['always', 'contains', 'matches', 'route', 'otherwise']

// Does a condition hold for a node's output? `otherwise` is not decided here: it depends on the
// node's other edges, and answers false. Throws on an invalid pattern - validate first.
export const testPipelineCondition = (
  when: PipelineCondition | undefined,
  output: { text: string; route?: string },
  matcher?: (text: string) => boolean,
): boolean => {
  if (!when || when.kind === 'always') return true
  switch (when.kind) {
    case 'contains': {
      const text = output.text.slice(0, PIPELINE_LIMITS.conditionInputChars)
      return when.caseSensitive
        ? text.includes(when.text)
        : text.toLowerCase().includes(when.text.toLowerCase())
    }
    case 'matches':
      return (matcher ?? compileMatcher(when.pattern, when.flags))(output.text)
    case 'route':
      return output.route !== undefined && output.route === when.label
    default:
      return false
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

// The id of an edge: its own, or `e<position>` when it has none.
const edgeIdOf = (edge: unknown, index: number): string =>
  isRecord(edge) && isId(edge.id) ? edge.id : `e${index}`

const edgeRef = (edge: unknown, index: number): { edgeId: string; edgeIndex: number } => ({
  edgeId: edgeIdOf(edge, index),
  edgeIndex: index,
})

// A copy of a definition in which every edge has an id (`e0`, `e1`, ... for the ones that had
// none), so an event or an editor can always name an edge. Editing the original afterwards
// changes nothing in the copy.
export const normalizePipeline = (definition: PipelineDefinition): PipelineDefinition => {
  const def = JSON.parse(JSON.stringify(definition)) as PipelineDefinition
  if (isRecord(def) && Array.isArray(def.edges)) {
    def.edges.forEach((edge, index) => {
      if (isRecord(edge)) edge.id = edgeIdOf(edge, index)
    })
  }
  return def
}

const inRange = (v: unknown, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max

// Check a definition. Pure: nothing is run, and a pattern is compiled but never executed.
export const validatePipeline = (definition: PipelineDefinition): PipelineValidation => {
  const errors: PipelineIssue[] = []
  const warnings: PipelineIssue[] = []
  const error = (code: string, message: string, at: Partial<PipelineIssue> = {}): void => {
    errors.push({ code, message, ...at })
  }
  const done = (): PipelineValidation => ({ ok: errors.length === 0, errors, warnings })

  const def = definition as unknown
  if (!isRecord(def)) {
    error('definition', 'a pipeline definition must be an object')
    return done()
  }
  if (def.version !== 1) {
    error('version', `unsupported pipeline version ${JSON.stringify(def.version)} (expected 1)`)
  }
  const nodes = Array.isArray(def.nodes) ? (def.nodes as unknown[]) : undefined
  const edges = Array.isArray(def.edges) ? (def.edges as unknown[]) : undefined
  if (!nodes || nodes.length === 0) error('nodes', 'a pipeline needs at least one node')
  if (!edges) error('edges', '`edges` must be an array')
  if (nodes && nodes.length > PIPELINE_LIMITS.maxNodes) {
    error('nodes', `more than ${PIPELINE_LIMITS.maxNodes} nodes`)
  }
  if (edges && edges.length > PIPELINE_LIMITS.maxEdges) {
    error('edges', `more than ${PIPELINE_LIMITS.maxEdges} edges`)
  }

  const ids = new Set<string>()
  const routesOf = new Map<string, string[]>()
  for (const [index, node] of (nodes ?? []).entries()) {
    if (!isRecord(node) || !isId(node.id)) {
      error('node.id', `node #${index + 1} has no id`)
      continue
    }
    const nodeId = node.id
    if (ids.has(nodeId)) {
      error('node.duplicate', `duplicate node id "${nodeId}"`, { nodeId })
      continue
    }
    ids.add(nodeId)
    if (node.join !== undefined && node.join !== 'all' && node.join !== 'any') {
      error('node.join', `node "${nodeId}": join must be "all" or "any"`, { nodeId })
    }
    const labels: string[] = []
    if (node.routes !== undefined) {
      if (!Array.isArray(node.routes) || node.routes.length > PIPELINE_LIMITS.maxRoutes) {
        error(
          'node.routes',
          `node "${nodeId}": routes must be a list of at most ${PIPELINE_LIMITS.maxRoutes}`,
          { nodeId },
        )
      } else {
        for (const route of node.routes as unknown[]) {
          if (!isRecord(route) || !isId(route.label)) {
            error('node.routes', `node "${nodeId}": a route has no label`, { nodeId })
          } else if (labels.includes(route.label)) {
            error('node.routes', `node "${nodeId}": duplicate route "${route.label}"`, { nodeId })
          } else {
            labels.push(route.label)
          }
        }
      }
    }
    routesOf.set(nodeId, labels)
  }

  if (!isId(def.entry)) {
    error('entry', 'the pipeline has no entry node')
  } else if (!ids.has(def.entry)) {
    error('entry', `the entry node "${def.entry}" does not exist`)
  }

  const out = new Map<string, string[]>()
  const edgeIds = new Set<string>()
  const otherwise = new Set<string>()
  const routed = new Set<string>()
  for (const [index, edge] of (edges ?? []).entries()) {
    const at = edgeRef(edge, index)
    const label = `edge "${at.edgeId}"`
    if (!isRecord(edge)) {
      error('edge', `${label} is not an object`, at)
      continue
    }
    // Given ids and the ones handed out (`e<position>`) share one namespace.
    if (edge.id !== undefined && !isId(edge.id)) error('edge.id', `${label} has an empty id`, at)
    if (edgeIds.has(at.edgeId)) error('edge.duplicate', `duplicate edge id "${at.edgeId}"`, at)
    edgeIds.add(at.edgeId)
    const from = edge.from
    const to = edge.to
    const fromOk = isId(from) && ids.has(from)
    const toOk = isId(to) && ids.has(to)
    if (!fromOk)
      error('edge.from', `${label} starts at an unknown node ${JSON.stringify(from)}`, at)
    if (!toOk) error('edge.to', `${label} leads to an unknown node ${JSON.stringify(to)}`, at)
    if (fromOk && toOk) out.set(from, [...(out.get(from) ?? []), to])

    const when = edge.when
    if (when === undefined) continue
    if (!isRecord(when) || !CONDITION_KINDS.includes(when.kind as string)) {
      error('edge.when', `${label} has an unknown condition`, at)
      continue
    }
    switch (when.kind) {
      case 'contains':
        if (typeof when.text !== 'string' || when.text.length === 0) {
          error('edge.when', `${label}: "contains" needs a text`, at)
        }
        break
      case 'matches':
        try {
          compileMatcher(when.pattern as string, (when.flags ?? '') as string)
        } catch (err) {
          error('edge.pattern', `${label}: ${(err as Error).message}`, at)
        }
        break
      case 'route':
        if (fromOk) routed.add(from)
        if (!isId(when.label)) {
          error('edge.route', `${label}: "route" needs a label`, at)
        } else if (fromOk && !(routesOf.get(from) ?? []).includes(when.label)) {
          error(
            'edge.route',
            `${label}: node "${from}" has no route "${when.label}"`,
            fromOk ? { ...at, nodeId: from } : at,
          )
        }
        break
      case 'otherwise':
        if (fromOk) {
          if (otherwise.has(from)) {
            error('edge.otherwise', `node "${from}" has more than one "otherwise" edge`, {
              ...at,
              nodeId: from,
            })
          }
          otherwise.add(from)
        }
        break
    }
  }

  if (def.limits !== undefined) {
    if (!isRecord(def.limits)) {
      error('limits', '`limits` must be an object')
    } else {
      const { maxNodeVisits, maxRuns } = def.limits
      if (
        maxNodeVisits !== undefined &&
        !inRange(maxNodeVisits, PIPELINE_LIMITS.maxNodeVisitsCeiling)
      ) {
        error(
          'limits',
          `limits.maxNodeVisits must be a whole number from 1 to ${PIPELINE_LIMITS.maxNodeVisitsCeiling}`,
        )
      }
      if (maxRuns !== undefined && !inRange(maxRuns, PIPELINE_LIMITS.maxRunsCeiling)) {
        error(
          'limits',
          `limits.maxRuns must be a whole number from 1 to ${PIPELINE_LIMITS.maxRunsCeiling}`,
        )
      }
    }
  }

  // Warnings describe a graph that is at least well-formed.
  if (errors.length > 0 || !isId(def.entry)) return done()

  const reached = new Set<string>([def.entry])
  const queue = [def.entry]
  while (queue.length) {
    for (const to of out.get(queue.pop() as string) ?? []) {
      if (!reached.has(to)) {
        reached.add(to)
        queue.push(to)
      }
    }
  }
  for (const nodeId of ids) {
    if (!reached.has(nodeId)) {
      warnings.push({
        code: 'unreachable',
        message: `node "${nodeId}" cannot be reached from the entry node`,
        nodeId,
      })
    }
    if ((routesOf.get(nodeId) ?? []).length > 0 && !routed.has(nodeId)) {
      warnings.push({
        code: 'routes.unused',
        message: `node "${nodeId}" has routes but no edge with a "route" condition`,
        nodeId,
      })
    }
  }

  // A cycle is allowed (the caps bound it); say so once, naming one.
  const state = new Map<string, 'open' | 'closed'>()
  const path: string[] = []
  const findCycle = (nodeId: string): string[] | undefined => {
    state.set(nodeId, 'open')
    path.push(nodeId)
    for (const to of out.get(nodeId) ?? []) {
      if (state.get(to) === 'open') return [...path.slice(path.indexOf(to)), to]
      if (!state.has(to)) {
        const found = findCycle(to)
        if (found) return found
      }
    }
    path.pop()
    state.set(nodeId, 'closed')
    return undefined
  }
  const cycle = findCycle(def.entry)
  if (cycle) {
    warnings.push({
      code: 'cycle',
      message: `the pipeline has a loop (${cycle.join(' → ')}); limits.maxNodeVisits and limits.maxRuns bound it`,
      nodeId: cycle[0],
    })
  }
  return done()
}

// ── What a node is told, and how it picks a route ────────────────────────────

const titleOf = (source: { nodeId: string; name?: string }): string => source.name || source.nodeId

// The node's input as the plain text its agent reads: the request, then each predecessor's output
// under its name.
export const renderPipelineNodeInput = (input: PipelineNodeInput): string => {
  if (input.from.length === 0 && input.visit <= 1) return input.request
  const parts = [`Request:\n${input.request}`]
  for (const source of input.from) {
    parts.push(`Output of "${titleOf(source)}":\n${source.text}`)
  }
  if (input.visit > 1) parts.push(`(This is visit ${input.visit} of this step.)`)
  return parts.join('\n\n')
}

export const PIPELINE_ROUTER_SYSTEM =
  'You are the Router of one step in a pipeline of agents. The step has answered. Pick the ONE ' +
  'route label that fits its answer, from the list you are given. Answer with a label exactly as ' +
  'it is written in the list, and nothing else.'

// Enough of a long answer to judge it by: verdicts tend to sit at the end.
const ROUTER_HEAD_CHARS = 2000
const ROUTER_TAIL_CHARS = 6000

// The prompt of the small call that picks a route.
export const renderPipelineRoutePrompt = (node: PipelineNode, text: string): string => {
  const routes = (node.routes ?? [])
    .map((r) => `- ${r.label}${r.description ? `: ${r.description}` : ''}`)
    .join('\n')
  const answer =
    text.length > ROUTER_HEAD_CHARS + ROUTER_TAIL_CHARS
      ? `${text.slice(0, ROUTER_HEAD_CHARS)}\n[...]\n${text.slice(-ROUTER_TAIL_CHARS)}`
      : text
  return [
    `Step: ${titleOf({ nodeId: node.id, name: node.name })}`,
    node.instructions ? `Its role:\n${node.instructions}` : '',
    `Routes:\n${routes}`,
    `The step's answer:\n${answer}`,
    'Which route? Answer with one label from the list.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// The label a router's answer names, or undefined: an answer that is not one of the node's labels
// is no route. Takes the structured `{ route }`, a bare label, or JSON text carrying one.
export const matchPipelineRoute = (node: PipelineNode, answer: unknown): string | undefined => {
  const labels = (node.routes ?? []).map((r) => r.label)
  let value: unknown = answer
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.startsWith('{')) {
      try {
        value = JSON.parse(text)
      } catch {
        value = text
      }
    } else {
      value = text
    }
  }
  if (isRecord(value)) value = value.route
  if (typeof value !== 'string') return undefined
  const wanted = value
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, '')
    .toLowerCase()
  return labels.find((label) => label.toLowerCase() === wanted)
}

// ── The scheduler ────────────────────────────────────────────────────────────

interface PlannedEdge {
  edge: PipelineEdge
  matcher?: Matcher
}

// A validated definition, ready to run.
export interface PipelinePlan {
  definition: PipelineDefinition
  nodes: Map<string, PipelineNode>
  outgoing: Map<string, PlannedEdge[]>
  maxNodeVisits: number
  maxRuns: number
  // Can `from` reach `to` along the edges (conditions aside)?
  reaches: (from: string, to: string) => boolean
}

// Validate and compile a definition. Throws PipelineValidationError. The definition is copied
// (normalizePipeline): editing the original afterwards does not change the plan.
export const preparePipeline = (definition: PipelineDefinition): PipelinePlan => {
  const { errors } = validatePipeline(definition)
  if (errors.length > 0) throw new PipelineValidationError(errors)
  const def = normalizePipeline(definition)
  const nodes = new Map(def.nodes.map((n) => [n.id, n]))
  const outgoing = new Map<string, PlannedEdge[]>(def.nodes.map((n) => [n.id, []]))
  for (const edge of def.edges) {
    const planned: PlannedEdge = { edge }
    if (edge.when?.kind === 'matches') {
      planned.matcher = compileMatcher(edge.when.pattern, edge.when.flags)
    }
    outgoing.get(edge.from)?.push(planned)
  }
  const closure = new Map<string, Set<string>>()
  const descendants = (from: string): Set<string> => {
    let seen = closure.get(from)
    if (!seen) {
      seen = new Set<string>()
      const queue = [from]
      while (queue.length) {
        for (const { edge } of outgoing.get(queue.pop() as string) ?? []) {
          if (!seen.has(edge.to)) {
            seen.add(edge.to)
            queue.push(edge.to)
          }
        }
      }
      closure.set(from, seen)
    }
    return seen
  }
  return {
    definition: def,
    nodes,
    outgoing,
    maxNodeVisits: def.limits?.maxNodeVisits ?? PIPELINE_LIMITS.maxNodeVisits,
    maxRuns: def.limits?.maxRuns ?? PIPELINE_LIMITS.maxRuns,
    reaches: (from, to) => descendants(from).has(to),
  }
}

export interface PipelineGraphRunOptions<E = never> {
  input: string
  signal?: AbortSignal
  onEvent?: (event: PipelineEvent | PipelineNodeEvent<E>) => void
}

// What an aborted run does: 'reject' with an AbortError, or 'resolve' with what it has and
// `stoppedBy: 'aborted'`. Each package follows its own agent.
export type PipelineAbortBehaviour = 'reject' | 'resolve'

// One finished visit, and how many of the activations it fired are still alive.
interface VisitRecord {
  nodeId: string
  name?: string
  text: string
  wave: number
  live: number
}

interface Activation {
  source: PipelineNodeSource
  record: VisitRecord
}

const abortError = (): Error => new DOMException('Aborted', 'AbortError')

const addUsage = (into: PipelineUsage, usage: PipelineUsage | undefined): void => {
  if (!usage) return
  const sum = into as unknown as Record<string, number>
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number' && Number.isFinite(value)) sum[key] = (sum[key] ?? 0) + value
  }
}

// Run a prepared pipeline once. See the scheduling rules in the package's docs: waves, the join
// rule, the caps.
export const runPipelineGraph = async <E = never>(
  plan: PipelinePlan,
  runNode: PipelineNodeRunner<E>,
  options: PipelineGraphRunOptions<E>,
  onAbort: PipelineAbortBehaviour,
): Promise<PipelineResult> => {
  const { definition } = plan
  const controller = new AbortController()
  // Set once the run is over for the nodes still in flight: their events and results are ignored.
  let halted: 'aborted' | 'failed' | undefined
  let halt: (err: Error) => void = () => {}
  const haltPromise = new Promise<never>((_, reject) => {
    halt = reject
  })
  haltPromise.catch(() => {})

  const emit = (event: PipelineEvent | PipelineNodeEvent<E>): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // A handler that throws must not break the run.
    }
  }

  const visits = new Map<string, number>()
  const usage: PipelineUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const outputs: PipelineResult['outputs'] = {}
  const trace: PipelineTraceEntry[] = []
  const terminals: VisitRecord[] = []
  const capped = new Set<'maxRuns' | 'maxNodeVisits'>()
  let runs = 0
  let wave = 0
  // Activated nodes that have not started, in the order they were first activated.
  const pending = new Map<string, Activation[]>([[definition.entry, []]])

  const result = (stoppedBy?: PipelineStop): PipelineResult => {
    const lastWave = Math.max(-1, ...terminals.map((t) => t.wave))
    const last = terminals.filter((t) => t.wave === lastWave)
    const text =
      last.length === 1
        ? last[0].text
        : last.map((t) => `## ${titleOf(t)}\n\n${t.text}`).join('\n\n')
    return { text, outputs, trace, usage, ...(stoppedBy ? { stoppedBy } : {}), runs }
  }

  const onOuterAbort = (): void => {
    if (halted) return
    halted = 'aborted'
    controller.abort()
    halt(abortError())
  }

  const visit = async (nodeId: string, activations: Activation[]): Promise<void> => {
    const node = plan.nodes.get(nodeId) as PipelineNode
    const number = (visits.get(nodeId) ?? 0) + 1
    visits.set(nodeId, number)
    runs++
    const from = activations.map((a) => a.source.nodeId)
    emit({ type: 'pipeline.node.started', nodeId, visit: number, from })

    let output: PipelineNodeOutput
    try {
      output = await runNode(
        node,
        { request: options.input, from: activations.map((a) => ({ ...a.source })), visit: number },
        {
          signal: controller.signal,
          pipeline: definition,
          emit: (event) => {
            if (!halted) emit({ ...event, nodeId, visit: number })
          },
        },
      )
    } catch (err) {
      // Already over (an abort, or another node failed first): this is the fallout, not a cause.
      if (halted) return
      halted = 'failed'
      const failure = new PipelineNodeError(nodeId, number, err)
      emit({
        type: 'pipeline.node.failed',
        nodeId,
        visit: number,
        error: err instanceof Error ? err.message : String(err),
      })
      controller.abort()
      halt(failure)
      return
    }
    if (halted) return

    const text = typeof output?.text === 'string' ? output.text : ''
    const route = (node.routes ?? []).some((r) => r.label === output?.route)
      ? output.route
      : undefined
    addUsage(usage, output?.usage)
    const optional = {
      ...(route !== undefined ? { route } : {}),
      ...(output?.usage ? { usage: output.usage } : {}),
    }
    ;(outputs[nodeId] ??= []).push({
      visit: number,
      text,
      ...(route !== undefined ? { route } : {}),
    })
    trace.push({ type: 'node', nodeId, visit: number, wave, from, text, ...optional })
    emit({ type: 'pipeline.node.finished', nodeId, visit: number, text, ...optional })

    // Every edge whose condition holds fires; `otherwise` only when none of the others did.
    const edges = plan.outgoing.get(nodeId) ?? []
    const fired = edges.map(({ edge, matcher }) =>
      testPipelineCondition(edge.when, { text, route }, matcher),
    )
    const anyFired = fired.some(Boolean)
    const record: VisitRecord = { nodeId, name: node.name, text, wave, live: 0 }
    const targets = new Set<string>()
    edges.forEach(({ edge }, index) => {
      const fires = edge.when?.kind === 'otherwise' ? !anyFired : fired[index]
      const decision = {
        from: nodeId,
        to: edge.to,
        edgeId: edge.id as string,
        visit: number,
        fired: fires,
      }
      trace.push({ type: 'edge', ...decision })
      emit({ type: 'pipeline.edge', ...decision })
      // Two edges to the same node carry the output once.
      if (!fires || targets.has(edge.to)) return
      targets.add(edge.to)
      const waiting = pending.get(edge.to) ?? []
      waiting.push({ source: { nodeId, ...(node.name ? { name: node.name } : {}), text }, record })
      pending.set(edge.to, waiting)
    })
    record.live = targets.size
    // Terminal: it ran and activated nothing.
    if (record.live === 0) terminals.push(record)
  }

  // A cap refused the activation: the visits that fired it may have become terminal.
  const drop = (nodeId: string, activations: Activation[], reason: 'maxRuns' | 'maxNodeVisits') => {
    capped.add(reason)
    const from = activations.map((a) => a.source.nodeId)
    trace.push({ type: 'dropped', nodeId, from, reason })
    emit({ type: 'pipeline.node.skipped', nodeId, from, reason })
    for (const { record } of activations) {
      record.live--
      if (record.live === 0) terminals.push(record)
    }
  }

  // join 'all': wait while another pending node can still reach this one through the graph (a
  // path to a node never needs to pass through it, so plain reachability is the whole test).
  const deferred = (nodeId: string, all: string[]): boolean =>
    (plan.nodes.get(nodeId)?.join ?? 'all') === 'all' &&
    all.some((other) => other !== nodeId && plan.reaches(other, nodeId))

  emit({ type: 'pipeline.started', ...(definition.name ? { pipeline: definition.name } : {}) })
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    if (options.signal?.aborted) onOuterAbort()
    while (pending.size > 0 && !halted) {
      const waiting = [...pending.keys()]
      let ready = waiting.filter((nodeId) => !deferred(nodeId, waiting))
      // Everybody waits for somebody (a cycle): nobody would ever start, so all of them do.
      if (ready.length === 0) ready = waiting
      const starting: Promise<void>[] = []
      for (const nodeId of ready) {
        const activations = pending.get(nodeId) as Activation[]
        pending.delete(nodeId)
        if ((visits.get(nodeId) ?? 0) >= plan.maxNodeVisits) {
          drop(nodeId, activations, 'maxNodeVisits')
        } else if (runs >= plan.maxRuns) {
          drop(nodeId, activations, 'maxRuns')
        } else {
          starting.push(visit(nodeId, activations))
        }
      }
      if (starting.length === 0) continue
      await Promise.race([Promise.all(starting), haltPromise])
      wave++
    }
    if (halted) await haltPromise
  } catch (err) {
    if (halted !== 'aborted') throw err
    emit({ type: 'pipeline.finished', stoppedBy: 'aborted', runs })
    if (onAbort === 'reject') throw err
    return result('aborted')
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
  const stoppedBy = capped.has('maxRuns')
    ? 'maxRuns'
    : capped.has('maxNodeVisits')
      ? 'maxNodeVisits'
      : undefined
  emit({ type: 'pipeline.finished', ...(stoppedBy ? { stoppedBy } : {}), runs })
  return result(stoppedBy)
}
