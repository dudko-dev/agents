// Dynamic subagents (`config.subagents.dynamic`): the rules of the `spawn_subagent` tool, with which
// the MODEL starts a helper agent for a sub-task. Pure, no imports: the same file in both packages
// (`@dudko.dev/agent` src/subagent-dynamic-shared.ts, `@dudko.dev/agent-web`
// src/subagent/dynamic-shared.ts) - change both; the server's tests compare them byte for byte.
//
// This is a privilege boundary. A helper is started by model-written text, so everything here only
// NARROWS what the parent run has: its tools by name, a share of what is left of its budgets, one
// more level of depth. Nothing the model writes can name a model, a provider, a limit or an
// approval mode - the tool's input has no such parameter and any other key is refused.

export const SPAWN_SUBAGENT_TOOL = 'spawn_subagent'

// What a child gets when the model names no tools: the parent's read-only tools, or all of them.
export type SubagentDefaultTools = 'read-only' | 'all'

export interface IDynamicSubagentsConfig {
  // How deep helpers may nest: 1 (default) = the run's helpers cannot start helpers of their own.
  // At most SUBAGENT_MAX_DEPTH_LIMIT.
  maxDepth?: number
  // Helpers one run may start, the helpers of its helpers included (a resumed run keeps counting).
  // Default 8.
  maxChildren?: number
  // Helpers of ONE parent running at once; further calls wait. Default 3.
  maxConcurrent?: number
  // The share of what is LEFT of the parent's budgets (run token limits, tool calls) one helper
  // may take, and of its iteration cap: 0 < share <= 1. Default 0.5.
  budgetShare?: number
  // A helper is not started with fewer tokens than this (when the parent has a token limit).
  // Default 2000.
  minTokens?: number
  // Wall-clock limit of one helper, in ms (0 = none). Default 300000.
  timeoutMs?: number
  // What a helper gets when the model names no tools. Default 'read-only'.
  defaultTools?: SubagentDefaultTools
}

export interface ISubagentsConfig {
  // Let the model start helper agents itself (the spawn_subagent tool). Off unless set.
  dynamic?: boolean | IDynamicSubagentsConfig
}

export interface IResolvedDynamicSubagents {
  maxDepth: number
  maxChildren: number
  maxConcurrent: number
  budgetShare: number
  minTokens: number
  timeoutMs: number
  defaultTools: SubagentDefaultTools
}

export const SUBAGENT_DEFAULTS: IResolvedDynamicSubagents = {
  maxDepth: 1,
  maxChildren: 8,
  maxConcurrent: 3,
  budgetShare: 0.5,
  minTokens: 2_000,
  timeoutMs: 300_000,
  defaultTools: 'read-only',
}

// Whatever the host configures, helpers never nest deeper than this.
export const SUBAGENT_MAX_DEPTH_LIMIT = 4
export const SUBAGENT_TASK_MAX_CHARS = 8_000
export const SUBAGENT_ROLE_MAX_CHARS = 2_000
export const SUBAGENT_MAX_TOOL_NAMES = 64

const wholeNumber = (value: unknown, name: string, min: number, max?: number): number => {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    throw new Error(
      `subagents.dynamic.${name} must be a whole number >= ${min}${max !== undefined ? ` and <= ${max}` : ''}, got: ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * The effective settings, or undefined when the feature is off (nothing is mounted, nothing is
 * added to a prompt). A bad value is a configuration error, thrown when the agent is created.
 */
export const resolveDynamicSubagents = (
  subagents: ISubagentsConfig | undefined,
): IResolvedDynamicSubagents | undefined => {
  const dynamic = subagents?.dynamic
  if (!dynamic) {
    return undefined
  }
  const c: IDynamicSubagentsConfig = dynamic === true ? {} : dynamic
  const d = SUBAGENT_DEFAULTS
  const budgetShare = c.budgetShare ?? d.budgetShare
  if (typeof budgetShare !== 'number' || !(budgetShare > 0) || budgetShare > 1) {
    throw new Error(
      `subagents.dynamic.budgetShare must be a number above 0 and at most 1, got: ${JSON.stringify(budgetShare)}`,
    )
  }
  const defaultTools = c.defaultTools ?? d.defaultTools
  if (defaultTools !== 'read-only' && defaultTools !== 'all') {
    throw new Error(
      `subagents.dynamic.defaultTools must be 'read-only' | 'all', got: ${JSON.stringify(defaultTools)}`,
    )
  }
  return {
    maxDepth: wholeNumber(c.maxDepth ?? d.maxDepth, 'maxDepth', 1, SUBAGENT_MAX_DEPTH_LIMIT),
    maxChildren: wholeNumber(c.maxChildren ?? d.maxChildren, 'maxChildren', 1),
    maxConcurrent: wholeNumber(c.maxConcurrent ?? d.maxConcurrent, 'maxConcurrent', 1),
    budgetShare,
    minTokens: wholeNumber(c.minTokens ?? d.minTokens, 'minTokens', 1),
    timeoutMs: wholeNumber(c.timeoutMs ?? d.timeoutMs, 'timeoutMs', 0),
    defaultTools,
  }
}

/**
 * A spawn that was refused: the model reads the message as the tool's error and can correct the
 * call or carry on without a helper.
 */
export class SubagentSpawnError extends Error {
  constructor(message: string) {
    super(`${SPAWN_SUBAGENT_TOOL}: ${message}`)
    this.name = 'SubagentSpawnError'
  }

  toJSON(): string {
    return this.message
  }
}

// ── the tool's input ─────────────────────────────────────────────────────

// The WHOLE input: a task, an optional role, an optional list of the caller's own tool names.
// There is no parameter for a model, a provider, a limit, a timeout or an approval mode.
export const SPAWN_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description:
        'The complete, self-contained sub-task. The helper sees nothing of your context except this text: include every fact, id and constraint it needs, and say what to return.',
    },
    role: {
      type: 'string',
      description:
        'Optional: who the helper should be for this task and how to work, in a sentence or two (e.g. "a careful code reviewer; report only real bugs").',
    },
    tools: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional: the names of YOUR tools the helper may use. Only tools you have can be named. Omit it for the default set; pass [] for a helper that only reasons.',
    },
  },
  required: ['task'],
  additionalProperties: false,
} as const

export const SPAWN_INPUT_HINT = '{ task: string, role?: string, tools?: string[] }'

export interface ISpawnInput {
  task: string
  role?: string
  tools?: string[]
}

const SPAWN_INPUT_KEYS: readonly string[] = Object.keys(SPAWN_INPUT_SCHEMA.properties)

/**
 * Validate what the model passed. Any key that is not in the schema is REFUSED, not ignored: a
 * call that tries `model`, `limits`, `toolApproval` ... is told it cannot, so it never looks as
 * if it worked.
 */
export const cleanSpawnInput = (raw: unknown): ISpawnInput => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SubagentSpawnError(`the input must be an object ${SPAWN_INPUT_HINT}`)
  }
  const input = raw as Record<string, unknown>
  const unknown = Object.keys(input).filter((k) => !SPAWN_INPUT_KEYS.includes(k))
  if (unknown.length) {
    throw new SubagentSpawnError(
      `unknown parameter(s) ${unknown.map((k) => JSON.stringify(k)).join(', ')} - a helper runs on your models, limits and approval rules, and none of them can be set here. The only parameters are task, role and tools`,
    )
  }
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  if (!task) {
    throw new SubagentSpawnError('"task" is required: a complete, self-contained task')
  }
  if (task.length > SUBAGENT_TASK_MAX_CHARS) {
    throw new SubagentSpawnError(
      `"task" is ${task.length} characters; the limit is ${SUBAGENT_TASK_MAX_CHARS}`,
    )
  }
  const out: ISpawnInput = { task }
  // An empty value counts as "not given": models do send `role: ""`.
  if (input.role !== undefined && input.role !== null && input.role !== '') {
    if (typeof input.role !== 'string') {
      throw new SubagentSpawnError('"role" must be a string')
    }
    const role = input.role.trim()
    if (role.length > SUBAGENT_ROLE_MAX_CHARS) {
      throw new SubagentSpawnError(
        `"role" is ${role.length} characters; the limit is ${SUBAGENT_ROLE_MAX_CHARS}`,
      )
    }
    if (role) {
      out.role = role
    }
  }
  if (input.tools !== undefined && input.tools !== null) {
    if (!Array.isArray(input.tools) || input.tools.some((t) => typeof t !== 'string')) {
      throw new SubagentSpawnError('"tools" must be a list of tool names')
    }
    if (input.tools.length > SUBAGENT_MAX_TOOL_NAMES) {
      throw new SubagentSpawnError(
        `"tools" names ${input.tools.length} tools; the limit is ${SUBAGENT_MAX_TOOL_NAMES}`,
      )
    }
    out.tools = [...new Set((input.tools as string[]).map((t) => t.trim()).filter(Boolean))]
  }
  return out
}

/**
 * What the helper is given as its request. The role is the model's text: it is part of the
 * TASK, under a line that says so - never the system prompt, which stays the operator's.
 */
export const renderSubagentTask = (input: ISpawnInput): string =>
  input.role
    ? `Your role for this task, as described by the agent that delegated it to you:\n${input.role}\n\nTask:\n${input.task}`
    : input.task

// ── narrowing ────────────────────────────────────────────────────────────

export interface ISpawnToolEntry {
  name: string
  readOnly: boolean
}

export interface ISpawnNarrowing {
  defaultTools: SubagentDefaultTools
  // Names a helper has (or lacks) by rule, whatever is asked: built-ins and the spawn tool itself.
  // Naming one is harmless and changes nothing.
  implicit?: readonly string[]
  // Names a helper never gets: the notebook's tools.
  withheld?: readonly string[]
}

const quoteNames = (names: string[], max = 40): string =>
  names.length
    ? `${names
        .slice(0, max)
        .map((n) => `"${n}"`)
        .join(', ')}${names.length > max ? `, ... (${names.length - max} more)` : ''}`
    : '(none)'

/**
 * The tools of a helper: a subset of `parent`, the tools the CALLING run has right now. A name
 * the parent does not have is refused - not dropped - so the model learns the helper will not
 * have it. Without a list: the parent's read-only tools (or all of them, by configuration).
 */
export const narrowSubagentTools = (
  parent: ISpawnToolEntry[],
  requested: string[] | undefined,
  rules: ISpawnNarrowing,
): string[] => {
  const implicit = new Set(rules.implicit ?? [])
  const withheld = new Set(rules.withheld ?? [])
  const grantable = parent.filter((t) => !implicit.has(t.name) && !withheld.has(t.name))
  if (requested === undefined) {
    return grantable.filter((t) => rules.defaultTools === 'all' || t.readOnly).map((t) => t.name)
  }
  const asked = requested.filter((name) => !implicit.has(name))
  const refused = asked.filter((name) => withheld.has(name))
  if (refused.length) {
    throw new SubagentSpawnError(
      `${quoteNames(refused)} cannot be given to a helper: the notebook of lessons stays with you. Ask the helper to report what it learned, and write it down yourself`,
    )
  }
  const have = new Set(grantable.map((t) => t.name))
  const missing = asked.filter((name) => !have.has(name))
  if (missing.length) {
    throw new SubagentSpawnError(
      `you do not have the tool(s) ${quoteNames(missing)} - a helper can only use tools you have. Yours: ${quoteNames([...have])}`,
    )
  }
  return asked
}

// ── limits ───────────────────────────────────────────────────────────────

export interface ISpawnPosition {
  // 0 for the run itself, 1 for its helpers, ...
  depth: number
  // Helpers started so far in the whole run.
  spawned: number
}

/** Depth and the per-run count. Throws SubagentSpawnError when another helper may not start. */
export const assertSpawnAllowed = (
  at: ISpawnPosition,
  settings: Pick<IResolvedDynamicSubagents, 'maxDepth' | 'maxChildren'>,
): void => {
  if (at.depth >= settings.maxDepth) {
    throw new SubagentSpawnError(
      `a helper at depth ${at.depth} cannot start helpers of its own (the limit is ${settings.maxDepth}). Do the work yourself`,
    )
  }
  if (at.spawned >= settings.maxChildren) {
    throw new SubagentSpawnError(
      `this run has already started ${at.spawned} helper(s), the limit (${settings.maxChildren}). Do the rest yourself`,
    )
  }
}

export interface ISpawnTokenLimits {
  maxInputTokens?: number
  maxOutputTokens?: number
  maxReasoningTokens?: number
  maxTotalTokens?: number
}

export interface ISpawnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
}

// What a running helper was promised, and how much of it it has used: the unspent part is not
// the parent's to promise to another helper.
export interface ISpawnReservation {
  limits: ISpawnTokenLimits
  maxToolCalls?: number
  usage: () => ISpawnUsage
  toolCalls: () => number
}

export interface ISpawnParentBudget {
  // The parent's run limits (absent / 0 = no cap of that kind).
  limits: ISpawnTokenLimits
  usage: ISpawnUsage
  maxToolCalls?: number
  toolCalls: number
  maxIterations: number
}

export interface ISpawnBudget {
  // The helper's own run limits: for each kind the parent caps, a share of what is left.
  limits: ISpawnTokenLimits
  // Set when the parent has a tool-call cap.
  maxToolCalls?: number
  maxIterations: number
}

const TOKEN_KINDS = [
  ['maxTotalTokens', 'totalTokens', 'total', 1],
  ['maxInputTokens', 'inputTokens', 'input', 1],
  ['maxOutputTokens', 'outputTokens', 'output', 4],
  ['maxReasoningTokens', 'reasoningTokens', 'reasoning', 0],
] as const

const isCap = (cap: number | undefined): cap is number =>
  typeof cap === 'number' && Number.isFinite(cap) && cap > 0

/**
 * A helper's budgets: `budgetShare` of what is LEFT of each of the parent's - after what the
 * parent has spent and what its running helpers may still spend. The helper's spend is charged to
 * the parent as it happens, so the share is a cap inside the parent's cap, never on top of it.
 * Throws SubagentSpawnError when what is left cannot cover a helper's minimum (`minTokens` for
 * the total and the input cap, a quarter of it for the output cap, one tool call).
 */
export const shareSubagentBudget = (
  parent: ISpawnParentBudget,
  running: ISpawnReservation[],
  settings: Pick<IResolvedDynamicSubagents, 'budgetShare' | 'minTokens'>,
): ISpawnBudget => {
  const limits: ISpawnTokenLimits = {}
  for (const [cap, field, label, divisor] of TOKEN_KINDS) {
    const max = parent.limits[cap]
    if (!isCap(max)) {
      continue
    }
    const promised = running.reduce(
      (sum, r) =>
        sum + (isCap(r.limits[cap]) ? Math.max(0, r.limits[cap] - (r.usage()[field] ?? 0)) : 0),
      0,
    )
    const left = max - (parent.usage[field] ?? 0) - promised
    const share = Math.floor(Math.max(0, left) * settings.budgetShare)
    const min = divisor ? Math.ceil(settings.minTokens / divisor) : 1
    if (share < min) {
      throw new SubagentSpawnError(
        `not enough of the ${label}-token budget is left for a helper (${Math.max(0, left)} left, a helper's share would be ${share}, the minimum is ${min}). Finish the work yourself, briefly`,
      )
    }
    limits[cap] = share
  }
  let maxToolCalls: number | undefined
  if (isCap(parent.maxToolCalls)) {
    const promised = running.reduce(
      (sum, r) => sum + (isCap(r.maxToolCalls) ? Math.max(0, r.maxToolCalls - r.toolCalls()) : 0),
      0,
    )
    const left = parent.maxToolCalls - parent.toolCalls - promised
    maxToolCalls = Math.floor(Math.max(0, left) * settings.budgetShare)
    if (maxToolCalls < 1) {
      throw new SubagentSpawnError(
        `not enough of the tool-call budget is left for a helper (${Math.max(0, left)} call(s) left). Finish the work yourself`,
      )
    }
  }
  return {
    limits,
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    maxIterations: Math.max(1, Math.floor(parent.maxIterations * settings.budgetShare)),
  }
}

/** At most `max` holders; the rest wait in order. Abort-aware. Returns the release. */
export const createSpawnGate = (max: number): ((signal?: AbortSignal) => Promise<() => void>) => {
  let active = 0
  const queue: (() => void)[] = []
  const aborted = (): Error => {
    const e = new Error('Aborted')
    e.name = 'AbortError'
    return e
  }
  return (signal) =>
    new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(aborted())
        return
      }
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort)
        active += 1
        let released = false
        resolve(() => {
          if (released) {
            return
          }
          released = true
          active -= 1
          queue.shift()?.()
        })
      }
      function onAbort(): void {
        const i = queue.indexOf(grant)
        if (i >= 0) {
          queue.splice(i, 1)
        }
        reject(aborted())
      }
      if (active < max) {
        grant()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      queue.push(grant)
    })
}

// ── what the model is told ───────────────────────────────────────────────

export const spawnToolDescription = (
  settings: Pick<IResolvedDynamicSubagents, 'defaultTools'>,
): string =>
  'Start a helper agent on a self-contained sub-task and get its final answer back. ' +
  'Worth it for a sub-task that is independent of the rest of your work (several helpers called in the same turn run in parallel), or one that means reading a lot when you only need the conclusion. ' +
  "Not worth it for a single tool call or a quick question: a helper plans, works and writes an answer of its own, and every token and tool call it spends comes out of THIS run's budget. " +
  'The helper sees nothing of your context: put everything it needs into "task". ' +
  `It can use only tools you have - name them in "tools" (without it: ${settings.defaultTools === 'all' ? 'all your tools' : 'your read-only tools'}) - and it works under the same approval rules as you.`

// Run-stable notes for the system prompts of an agent with the tool (none without it).
export const SPAWN_PLANNER_NOTE = `A step may hand a self-contained sub-task to a helper agent with ${SPAWN_SUBAGENT_TOOL}: independent sub-tasks (helpers started in one step run in parallel) or long reading whose conclusion is all that is needed. Helpers spend this run's budget, so plan one only where it saves more than it costs; a step that should use helpers lists ${SPAWN_SUBAGENT_TOOL} among its tools.`

export const SPAWN_EXECUTOR_NOTE = `${SPAWN_SUBAGENT_TOOL} starts a helper agent for a self-contained sub-task and returns its answer. Use it for independent sub-tasks (call it several times in one turn to run them in parallel) or for long reading you only need the conclusion of - not for something one tool call does: a helper spends this run's budget. A helper knows only what you write in "task".`

// ── the event tree ───────────────────────────────────────────────────────

interface IEventLike {
  type: string
  depth?: number
  parentId?: string
  event?: unknown
}

const deepenEvent = (event: unknown): unknown => {
  if (!event || typeof event !== 'object') {
    return event
  }
  const e = event as IEventLike
  if (e.type === 'subagent.start') {
    return { ...e, depth: (typeof e.depth === 'number' ? e.depth : 1) + 1 }
  }
  if (e.type === 'subagent.event') {
    return { ...e, event: deepenEvent(e.event) }
  }
  return event
}

/**
 * A child's event on its way up through the subagent `parentId` (the `subagent.event` envelope is
 * added by the caller). A `subagent.start` is emitted with `depth: 1` and the id of the run that
 * made the call as `parentId`; each subagent it passes through on the way up adds one level, and
 * the first one - its real parent - puts its own id in `parentId`. So at the top of the stream
 * every start carries its true depth and parent, whatever mix of static and dynamic subagents,
 * threads and workers is below.
 */
export const adoptSubagentEvent = <E extends { type: string }>(event: E, parentId: string): E => {
  const e = event as unknown as IEventLike
  if (e.type === 'subagent.start') {
    return {
      ...e,
      parentId,
      depth: (typeof e.depth === 'number' ? e.depth : 1) + 1,
    } as unknown as E
  }
  if (e.type === 'subagent.event') {
    return { ...e, event: deepenEvent(e.event) } as unknown as E
  }
  return event
}
