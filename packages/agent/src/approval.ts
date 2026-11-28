import { randomUUID } from 'node:crypto'
import { runContext } from './context.ts'
import type { IRunState } from './internal.ts'
import {
  isParkDecision,
  journalQuestion,
  RunParkedSignal,
  type IJournalQuestion,
} from './journal.ts'
import {
  createMcpSkillGrants,
  isMcpSkillName,
  type McpSkillConsentView,
  type McpSkillGrants,
} from './mcp-skills.ts'
import type {
  EventHandler,
  IToolApprovalConfig,
  IToolApprovalContext,
  IToolApprovalRequest,
  ToolApprovalDecision,
  ToolApprovalMode,
  ToolPermission,
} from './types.ts'

const MODES: ReadonlySet<string> = new Set<ToolApprovalMode>([
  'autopilot',
  'ask-writes',
  'ask-all',
  'read-only',
])

export const isToolApprovalMode = (v: unknown): v is ToolApprovalMode =>
  typeof v === 'string' && MODES.has(v)

/**
 * Thrown from inside a tool's execute when the call was not approved. The AI
 * SDK records it as a failed tool call (`ok: false`), so the replanner sees
 * it; `toJSON` keeps the message when a trace is serialised.
 */
export class ToolDeniedError extends Error {
  readonly reason?: string

  constructor(reason?: string) {
    super(
      `Tool call denied by the user${reason ? `: ${reason}` : ''}. Do not retry it; continue without it, or report what is blocked.`,
    )
    this.name = 'ToolDeniedError'
    this.reason = reason
  }

  toJSON(): string {
    return this.message
  }
}

// Read-only metadata on a tool object. MCP tools get it from
// annotations.readOnlyHint; native tools opt in with markReadOnly(tool).
export const markReadOnly = <T extends object>(tool: T, readOnly = true): T => {
  ;(tool as { readOnly?: boolean }).readOnly = readOnly
  return tool
}

export const isReadOnlyTool = (tool: unknown): boolean =>
  Boolean(tool) && typeof tool === 'object' && (tool as { readOnly?: unknown }).readOnly === true

// Code-execution metadata on a tool object: the call runs code (the sandbox's run_js has it; a
// host marks its own with markCodeExecution). While a run acts on skills an MCP server served,
// such a call is always asked (decideToolPermission).
export const markCodeExecution = <T extends object>(tool: T, codeExecution = true): T => {
  ;(tool as { codeExecution?: boolean }).codeExecution = codeExecution
  return tool
}

export const isCodeExecutionTool = (tool: unknown): boolean =>
  Boolean(tool) &&
  typeof tool === 'object' &&
  (tool as { codeExecution?: unknown }).codeExecution === true

const globCache = new Map<string, RegExp>()
const globToRegExp = (glob: string): RegExp => {
  let re = globCache.get(glob)
  if (!re) {
    const body = glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    re = new RegExp(`^${body}$`)
    globCache.set(glob, re)
  }
  return re
}

/**
 * The most specific rule matching `name`: an exact key wins, then the
 * longest matching '*' glob (ties: the first declared). Pure.
 */
export const matchToolRule = (
  rules: Record<string, ToolPermission> | undefined,
  name: string,
): { pattern: string; permission: ToolPermission } | undefined => {
  if (!rules) {
    return undefined
  }
  if (Object.hasOwn(rules, name) && !name.includes('*')) {
    return { pattern: name, permission: rules[name] }
  }
  let best: { pattern: string; permission: ToolPermission } | undefined
  for (const [pattern, permission] of Object.entries(rules)) {
    if (!pattern.includes('*')) {
      continue
    }
    if (globToRegExp(pattern).test(name) && (!best || pattern.length > best.pattern.length)) {
      best = { pattern, permission }
    }
  }
  return best
}

export interface IToolDecisionInput {
  name: string
  readOnly: boolean
  mode: ToolApprovalMode
  rules?: Record<string, ToolPermission>
  remembered?: ReadonlySet<string>
  // Built-in tools (load_skill, read_skill_file, find_tools) are always allowed.
  builtIn?: boolean
  // The tool runs code (isCodeExecutionTool).
  codeExecution?: boolean
  // The run (or a run above it) acts on skills an MCP server served: their names.
  mcpSkills?: readonly string[]
}

export interface IToolDecision {
  permission: ToolPermission
  source: 'builtin' | 'remembered' | 'rule' | 'mode' | 'mcp-skill'
  // The matched rule pattern (source 'rule').
  rule?: string
}

/**
 * Decide one call. Pure. Order: built-in -> remembered "always allow" ->
 * most specific rule -> mode default (autopilot: allow; read-only: allow if
 * readOnly else deny; ask-writes: allow if readOnly else ask; ask-all: ask).
 * Then one rule that only ever tightens: a call that runs code while the run acts on an MCP
 * server's skill is asked when it would have been allowed - by the mode, a rule or an "always
 * allow" alike (the Skills extension: no code runs here on a server's skill without a person's
 * approval). A deny stays a deny.
 */
export const decideToolPermission = (input: IToolDecisionInput): IToolDecision => {
  if (input.builtIn) {
    return { permission: 'allow', source: 'builtin' }
  }
  const decision = decideByPolicy(input)
  if (decision.permission === 'allow' && input.codeExecution && input.mcpSkills?.length) {
    return { permission: 'ask', source: 'mcp-skill' }
  }
  return decision
}

const decideByPolicy = (input: IToolDecisionInput): IToolDecision => {
  if (input.remembered?.has(input.name)) {
    return { permission: 'allow', source: 'remembered' }
  }
  const rule = matchToolRule(input.rules, input.name)
  if (rule) {
    return { permission: rule.permission, source: 'rule', rule: rule.pattern }
  }
  switch (input.mode) {
    case 'autopilot':
      return { permission: 'allow', source: 'mode' }
    case 'read-only':
      return { permission: input.readOnly ? 'allow' : 'deny', source: 'mode' }
    case 'ask-writes':
      return { permission: input.readOnly ? 'allow' : 'ask', source: 'mode' }
    case 'ask-all':
      return { permission: 'ask', source: 'mode' }
  }
}

export interface IApprovalGateOptions {
  readOnly: boolean
  builtIn?: boolean
  // The tool runs code (isCodeExecutionTool): asked while the run acts on an MCP server's skill.
  codeExecution?: boolean
  signal?: AbortSignal
}

// The MCP skills the run of this call acts on - its own and those of every run above it (a
// helper the model started works for its caller's skill too). Skill names with a "/" are MCP
// skills: a host skill's or a lesson's name cannot hold one.
const mcpSkillsActing = (state: IRunState | undefined): string[] => {
  const names: string[] = []
  for (let s = state; s; s = s.spawn?.parent) {
    for (const name of s.activeSkills) {
      if (isMcpSkillName(name) && !names.includes(name)) {
        names.push(name)
      }
    }
  }
  return names
}

export interface IApprovalController {
  getMode: () => ToolApprovalMode
  setMode: (mode: ToolApprovalMode) => void
  // Tools approved with remember: true (agent-instance lifetime).
  remembered: Set<string>
  // Resolves when the call may run; throws ToolDeniedError otherwise.
  gate: (name: string, input: unknown, opts: IApprovalGateOptions) => Promise<void>
  // What a person allowed of MCP servers' skills for the agent's life (shared by its helpers).
  mcpSkillGrants: McpSkillGrants
  // Ask the person whether an MCP server's skill may enter the model's context (the same
  // `onRequest`, `timeoutMs` and events as a tool call, the request carrying `skill`; the
  // approval mode and the rules play no part). Resolves with the answer - `by` says whether a
  // person gave it - and throws only when the run was stopped.
  askSkill: (
    input: unknown,
    skill: McpSkillConsentView,
    opts: { signal?: AbortSignal },
  ) => Promise<{
    approved: boolean
    remember?: boolean
    reason?: string
    by: 'person' | 'no-handler' | 'no-answer'
  }>
}

// What the events say of a question the run parks on.
const PARKED_REASON = 'parked: the answer comes from outside the run'

// The journal's view of a question (persistence.journal), or why it cannot park.
const questionOf = (
  what: Parameters<typeof journalQuestion>[0],
): { q?: IJournalQuestion; refusal: string } => {
  const asked = journalQuestion(what)
  return 'id' in asked ? { q: asked, refusal: '' } : { refusal: asked.refusal }
}

const normalizeDecision = (
  d: ToolApprovalDecision | undefined,
): { approved: boolean; reason?: string; remember?: boolean } =>
  typeof d === 'boolean'
    ? { approved: d }
    : d && typeof d === 'object'
      ? {
          approved: (d as { approved?: unknown }).approved === true,
          reason: (d as { reason?: string }).reason,
          remember: (d as { remember?: boolean }).remember,
        }
      : { approved: false, reason: 'invalid approval decision' }

/** How long a question waits for a decision when `toolApproval.timeoutMs` is not set: 5 minutes. */
export const TOOL_APPROVAL_TIMEOUT_MS = 300_000

// The longest delay a timer holds (2^31 - 1 ms, about 24.8 days). `setTimeout` fires a longer one
// - Infinity included - after about 1 ms, so a bound past it is taken as no bound at all.
const MAX_TIMER_MS = 2_147_483_647

/**
 * `toolApproval.timeoutMs` as the gate uses it: absent = {@link TOOL_APPROVAL_TIMEOUT_MS}; `0`,
 * `Infinity` or more than a timer holds = no bound (0: the question waits until the run is
 * stopped). Anything that is not a number of at least 0 is a configuration error.
 */
export const resolveApprovalTimeout = (value: unknown): number => {
  if (value === undefined || value === null) {
    return TOOL_APPROVAL_TIMEOUT_MS
  }
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new Error(
      `toolApproval.timeoutMs must be a number of milliseconds of at least 0 (0 or Infinity: no limit), got: ${typeof value === 'number' ? String(value) : JSON.stringify(value)}`,
    )
  }
  return value === 0 || value > MAX_TIMER_MS ? 0 : Math.max(1, Math.floor(value))
}

// The bound ran out. Named like `AbortSignal.timeout`'s reason: it is also the reason of the
// host's signal.
class ApprovalTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`no decision within ${timeoutMs}ms`)
    this.name = 'TimeoutError'
  }
}

// `timeoutMs` is resolved (resolveApprovalTimeout): 0 = no bound, else what a timer can hold.
const awaitDecision = (
  pending: Promise<ToolApprovalDecision>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ToolApprovalDecision> =>
  new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      if (timer) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', onAbort)
    }
    function onAbort(): void {
      done()
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        done()
        reject(new ApprovalTimeout(timeoutMs))
      }, timeoutMs)
    }
    pending.then(
      (v) => {
        done()
        resolve(v)
      },
      (err: unknown) => {
        done()
        reject(err)
      },
    )
  })

/**
 * One controller per agent instance. The gate runs INSIDE each tool's
 * execute, so it covers native and MCP tools alike; it reads the run's
 * emit / current step / runId from the AsyncLocalStorage run context.
 */
export const createApprovalController = (
  config: IToolApprovalConfig | undefined,
  deps: {
    // Applied to the input shown in the request (idempotent inputSanitizer).
    sanitize?: (name: string, input: unknown) => Promise<unknown>
    // Used when a tool is called outside of a run.
    fallbackEmit?: EventHandler
  } = {},
): IApprovalController => {
  let mode: ToolApprovalMode = config?.mode ?? 'autopilot'
  if (!isToolApprovalMode(mode)) {
    throw new Error(
      `toolApproval.mode must be ${[...MODES].join(' | ')}, got: ${JSON.stringify(mode)}`,
    )
  }
  const timeoutMs = resolveApprovalTimeout(config?.timeoutMs)
  const remembered = new Set<string>()

  const gate = async (name: string, input: unknown, opts: IApprovalGateOptions): Promise<void> => {
    const store = runContext.getStore()
    const mcpSkills = opts.codeExecution && !opts.builtIn ? mcpSkillsActing(store?.state) : []
    const decision = decideToolPermission({
      name,
      readOnly: opts.readOnly,
      mode,
      rules: config?.rules,
      remembered,
      builtIn: opts.builtIn,
      ...(opts.codeExecution ? { codeExecution: true } : {}),
      ...(mcpSkills.length ? { mcpSkills } : {}),
    })
    if (decision.permission === 'allow') {
      return
    }
    const emit: EventHandler = store?.emit ?? deps.fallbackEmit ?? (() => {})
    // persistence.journal: a question has a stable id (its place in the run) and may be on
    // record already - answered, or parked on - from an earlier attempt.
    const { q, refusal } =
      decision.permission === 'ask'
        ? questionOf({ kind: 'tool', toolName: name, input })
        : { q: undefined, refusal: '' }
    const id = q?.id ?? randomUUID()
    const deny = (reason: string, automatic: boolean): never => {
      emit({ type: 'tool.approval-resolved', id, name, approved: false, reason, automatic })
      throw new ToolDeniedError(reason)
    }
    if (decision.permission === 'deny') {
      deny(
        decision.source === 'rule'
          ? `denied by rule "${decision.rule}"`
          : `"${mode}" mode allows read-only tools only`,
        true,
      )
    }
    // An answer on record or given with the resume, or a question parked on and still open:
    // nobody is asked.
    const known = q?.recorded ?? q?.given
    const onRequest = config?.onRequest
    if (!onRequest && known === undefined && !q?.pending) {
      deny(
        decision.source === 'mcp-skill'
          ? "code runs only with a person's approval while the run acts on an MCP server's skill, and no approval handler is configured"
          : 'no approval handler configured',
        true,
      )
      return
    }
    const shown = deps.sanitize ? await deps.sanitize(name, input) : input
    const step = store?.currentStep
    // A call made by a helper the model started says so: the same user is asked, and can see
    // that it is the helper asking.
    const scope = store?.state?.spawn
    const subagent = scope?.id ? { id: scope.id, depth: scope.depth } : undefined
    emit({
      type: 'tool.approval-requested',
      id,
      name,
      input: shown,
      readOnly: opts.readOnly,
      ...(step ? { step } : {}),
      ...(subagent ? { subagent } : {}),
      ...(decision.source === 'mcp-skill' ? { mcpSkills } : {}),
    })
    const request: IToolApprovalRequest = {
      id,
      toolName: name,
      input: shown,
      readOnly: opts.readOnly,
      ...(step ? { step } : {}),
      ...(store?.runId ? { runId: store.runId } : {}),
      ...(subagent ? { subagent } : {}),
      ...(decision.source === 'mcp-skill' ? { mcpSkills } : {}),
    }
    // The run parks at the end of the tool round with this question (journal.ts).
    const park = async (question: IJournalQuestion): Promise<never> => {
      await question.park(request)
      emit({
        type: 'tool.approval-resolved',
        id,
        name,
        approved: false,
        reason: PARKED_REASON,
        automatic: false,
        parked: true,
      })
      throw new RunParkedSignal()
    }
    let raw: ToolApprovalDecision
    if (q && (known !== undefined || q.pending)) {
      if (known === undefined) {
        return park(q)
      }
      raw = known
    } else {
      // The host's own signal: aborted when the question ends without its answer (the bound, a
      // stop, a failed handler), so a prompt left open can be taken down. Never after an answer.
      const asked = new AbortController()
      const ctx: IToolApprovalContext = { signal: asked.signal }
      // A person is being asked: the step's time limit (and a subagent's) is about models and
      // tools, and does not run meanwhile. The wait has its own bound, `timeoutMs`.
      const resume = store?.state?.clock?.pause()
      try {
        raw = await awaitDecision(
          Promise.resolve().then(() => (onRequest as NonNullable<typeof onRequest>)(request, ctx)),
          timeoutMs,
          opts.signal,
        )
      } catch (err) {
        // Before the resolved event: a host that closes its prompt hears of it first.
        asked.abort(err)
        if (err instanceof ApprovalTimeout) {
          deny(`no decision within ${timeoutMs}ms`, true)
        }
        if (opts.signal?.aborted) {
          emit({
            type: 'tool.approval-resolved',
            id,
            name,
            approved: false,
            reason: 'aborted',
            automatic: true,
          })
          throw err
        }
        deny(`approval handler failed: ${(err as Error)?.message ?? String(err)}`, true)
        return
      } finally {
        resume?.()
      }
      if (isParkDecision(raw)) {
        // Parking needs the journal and a tool call to come back to: elsewhere it is a denial.
        if (!q) {
          deny(`cannot park: ${refusal}`, true)
          return
        }
        return park(q)
      }
    }
    const d = normalizeDecision(raw)
    // On record before the call goes on: a crash after the answer does not ask again.
    if (q && q.recorded === undefined) {
      await q.record(d)
    }
    // An "always allow" given to a call asked because of an MCP skill is remembered as usual; it
    // does not lift the rule above, which asks again next time.
    if (d.approved && d.remember) {
      remembered.add(name)
    }
    emit({
      type: 'tool.approval-resolved',
      id,
      name,
      approved: d.approved,
      ...(d.reason ? { reason: d.reason } : {}),
      automatic: false,
    })
    if (!d.approved) {
      throw new ToolDeniedError(d.reason)
    }
  }

  const mcpSkillGrants = createMcpSkillGrants()

  // The same question as a tool call's, about a skill: no mode, no rule, no "always allow" of
  // the tools' (a yes with remember is "Always for this server", kept by the caller).
  const askSkill: IApprovalController['askSkill'] = async (input, skill, opts) => {
    const store = runContext.getStore()
    const emit: EventHandler = store?.emit ?? deps.fallbackEmit ?? (() => {})
    const name = 'load_skill'
    // persistence.journal: the question's stable id, and what is on record for it.
    const { q, refusal } = questionOf({ kind: 'skill', toolName: name, input, skill })
    const id = q?.id ?? randomUUID()
    const known = q?.recorded ?? q?.given
    const onRequest = config?.onRequest
    if (!onRequest && known === undefined && !q?.pending) {
      const reason = 'no approval handler configured'
      emit({ type: 'tool.approval-resolved', id, name, approved: false, reason, automatic: true })
      return { approved: false, reason, by: 'no-handler' }
    }
    const step = store?.currentStep
    const scope = store?.state?.spawn
    const subagent = scope?.id ? { id: scope.id, depth: scope.depth } : undefined
    emit({
      type: 'tool.approval-requested',
      id,
      name,
      input,
      readOnly: true,
      ...(step ? { step } : {}),
      ...(subagent ? { subagent } : {}),
      skill,
    })
    const request: IToolApprovalRequest = {
      id,
      toolName: name,
      input,
      readOnly: true,
      ...(step ? { step } : {}),
      ...(store?.runId ? { runId: store.runId } : {}),
      ...(subagent ? { subagent } : {}),
      skill,
    }
    const park = async (question: IJournalQuestion): Promise<never> => {
      await question.park(request)
      emit({
        type: 'tool.approval-resolved',
        id,
        name,
        approved: false,
        reason: PARKED_REASON,
        automatic: false,
        parked: true,
      })
      throw new RunParkedSignal()
    }
    let raw: ToolApprovalDecision
    if (q && (known !== undefined || q.pending)) {
      if (known === undefined) {
        return park(q)
      }
      raw = known
    } else {
      const asked = new AbortController()
      const resume = store?.state?.clock?.pause()
      try {
        raw = await awaitDecision(
          Promise.resolve().then(() =>
            (onRequest as NonNullable<typeof onRequest>)(request, { signal: asked.signal }),
          ),
          timeoutMs,
          opts.signal,
        )
      } catch (err) {
        asked.abort(err)
        if (opts.signal?.aborted) {
          emit({
            type: 'tool.approval-resolved',
            id,
            name,
            approved: false,
            reason: 'aborted',
            automatic: true,
          })
          throw err
        }
        const reason =
          err instanceof ApprovalTimeout
            ? `no decision within ${timeoutMs}ms`
            : `approval handler failed: ${(err as Error)?.message ?? String(err)}`
        emit({ type: 'tool.approval-resolved', id, name, approved: false, reason, automatic: true })
        return { approved: false, reason, by: 'no-answer' }
      } finally {
        resume?.()
      }
      if (isParkDecision(raw)) {
        if (!q) {
          const reason = `cannot park: ${refusal}`
          emit({
            type: 'tool.approval-resolved',
            id,
            name,
            approved: false,
            reason,
            automatic: true,
          })
          return { approved: false, reason, by: 'no-answer' }
        }
        return park(q)
      }
    }
    const d = normalizeDecision(raw)
    if (q && q.recorded === undefined) {
      await q.record(d)
    }
    emit({
      type: 'tool.approval-resolved',
      id,
      name,
      approved: d.approved,
      ...(d.reason ? { reason: d.reason } : {}),
      automatic: false,
    })
    return {
      approved: d.approved,
      ...(d.remember ? { remember: true } : {}),
      ...(d.reason ? { reason: d.reason } : {}),
      by: 'person',
    }
  }

  return {
    mcpSkillGrants,
    askSkill,
    getMode: () => mode,
    setMode: (next) => {
      if (!isToolApprovalMode(next)) {
        throw new Error(
          `tool approval mode must be ${[...MODES].join(' | ')}, got: ${JSON.stringify(next)}`,
        )
      }
      mode = next
    },
    remembered,
    gate,
  }
}
