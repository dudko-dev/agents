import type { Tool } from 'ai'
import type { IPlanStep } from '../agent/loop-types.js'

/**
 * Tool consent. Every tool call passes a gate that decides allow / ask / deny:
 *
 * - `autopilot`   — run everything (default; explicit `rules` still apply);
 * - `ask-writes`  — run read-only tools, ask before anything that may change state;
 * - `ask-all`     — ask before every call;
 * - `read-only`   — run read-only tools, refuse the rest without asking.
 *
 * A tool is read-only when its MCP annotations say so (`readOnlyHint`) or the
 * host marked it (`defineTool({ readOnly: true })` / `markReadOnly`). Unknown =
 * may write: the safe assumption.
 */
export type ToolApprovalMode = 'autopilot' | 'ask-writes' | 'ask-all' | 'read-only'
export type ToolPermission = 'allow' | 'ask' | 'deny'

export const TOOL_APPROVAL_MODES: readonly ToolApprovalMode[] = [
  'autopilot',
  'ask-writes',
  'ask-all',
  'read-only',
]

export interface ToolApprovalRequest {
  /** Unique per request — echo it back from a UI. */
  id: string
  toolName: string
  input: unknown
  readOnly: boolean
  step?: IPlanStep
  /**
   * Set when the call comes from a helper the model started (`subagents.dynamic`), not from the
   * run itself: the helper's id (as in its `subagent.start` event) and its depth.
   */
  subagent?: { id: string; depth: number }
  /**
   * Set when the call comes from an MCP App (`Agent.approveAppToolCall`), not from the model:
   * a UI says so ("The app “travel” wants to run …"). `toolName` above is then the name the
   * agent's rules match (`server__tool`), `app.tool` the server's own name for it.
   */
  app?: ToolApprovalApp
}

/** Who asks when an MCP App asks (see `ToolApprovalRequest.app`). */
export interface ToolApprovalApp {
  /** The MCP server the app came from (its tools are the only ones it may call). */
  server: string
  /** The tool's own name on that server. */
  tool: string
  /** The app's `ui://` resource. */
  resourceUri: string
}

/**
 * `true`/`false`, or an object. `remember: true` on an approval allows this
 * tool for the rest of the agent's life ("always allow").
 */
export type ToolApprovalDecision =
  boolean | { approved: boolean; reason?: string; remember?: boolean }

export interface ToolApprovalConfig {
  /** Default policy (default 'autopilot'). */
  mode?: ToolApprovalMode
  /**
   * Per-tool overrides by exact name or `*` glob, e.g. `{ 'github__delete_*': 'deny' }`.
   * They win over the mode — an explicit 'ask' still asks under autopilot.
   */
  rules?: Record<string, ToolPermission>
  /** Resolves an approval request (a UI prompt, a policy service, …). */
  onRequest?: (req: ToolApprovalRequest) => ToolApprovalDecision | Promise<ToolApprovalDecision>
  /**
   * No decision within this many ms → deny. Default: wait indefinitely (until the run is
   * stopped). The only bound on the wait: the step's `chatTimeoutMs` (and a subagent's
   * `timeoutMs`) stop while a person decides.
   */
  timeoutMs?: number
}

/** Raised by a denied tool call; recorded as a failed call the replanner sees. */
export class ToolDeniedError extends Error {
  constructor(reason?: string) {
    super(
      `Tool call denied by the user${reason ? `: ${reason}` : ''}. Do not retry it; continue without it, or report what is blocked.`,
    )
    this.name = 'ToolDeniedError'
  }

  toJSON(): string {
    return this.message
  }
}

/** Mark a tool as read-only so `ask-writes` / `read-only` let it through. Returns it. */
export const markReadOnly = <T extends object>(tool: T, readOnly = true): T => {
  ;(tool as { readOnly?: boolean }).readOnly = readOnly
  return tool
}

export const isReadOnlyTool = (tool: Tool | undefined): boolean =>
  (tool as { readOnly?: unknown } | undefined)?.readOnly === true

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  )

/** The most specific matching rule: an exact name, else the longest glob. Pure. */
export const matchRule = (
  rules: Record<string, ToolPermission> | undefined,
  toolName: string,
): ToolPermission | undefined => {
  if (!rules) return undefined
  if (Object.hasOwn(rules, toolName)) return rules[toolName]
  let best: { len: number; perm: ToolPermission } | undefined
  for (const [pattern, perm] of Object.entries(rules)) {
    if (!pattern.includes('*')) continue
    if (!globToRegExp(pattern).test(toolName)) continue
    const len = pattern.replace(/\*/g, '').length
    if (!best || len > best.len) best = { len, perm }
  }
  return best?.perm
}

/**
 * What the gate does for one call, before any human is involved. Order:
 * remembered "always allow" → most specific rule → mode default. Pure.
 */
export const decideToolPermission = (opts: {
  toolName: string
  readOnly: boolean
  mode: ToolApprovalMode
  rules?: Record<string, ToolPermission>
  remembered?: ReadonlySet<string>
}): ToolPermission => {
  if (opts.remembered?.has(opts.toolName)) return 'allow'
  const rule = matchRule(opts.rules, opts.toolName)
  if (rule) return rule
  switch (opts.mode) {
    case 'autopilot':
      return 'allow'
    case 'read-only':
      return opts.readOnly ? 'allow' : 'deny'
    case 'ask-writes':
      return opts.readOnly ? 'allow' : 'ask'
    case 'ask-all':
      return 'ask'
  }
}

const normalizeDecision = (
  d: ToolApprovalDecision,
): { approved: boolean; reason?: string; remember?: boolean } =>
  typeof d === 'boolean'
    ? { approved: d }
    : { approved: Boolean(d?.approved), reason: d?.reason, remember: d?.remember }

/** Mutable approval state shared by every run of one agent. */
export interface ApprovalState {
  mode: ToolApprovalMode
  readonly config: ToolApprovalConfig
  /** Tools the user chose to "always allow". */
  readonly remembered: Set<string>
}

export const createApprovalState = (config: ToolApprovalConfig | undefined): ApprovalState => ({
  mode: config?.mode ?? 'autopilot',
  config: config ?? {},
  remembered: new Set<string>(),
})

let seq = 0

export interface ApprovalEvents {
  requested: (req: ToolApprovalRequest) => void
  resolved: (r: {
    id: string
    name: string
    approved: boolean
    reason?: string
    automatic: boolean
  }) => void
  /**
   * A person is being asked (right after `requested`): stop the run's time limits - the step's,
   * a subagent's - for the length of the wait. Returns what starts them again (wait-clock.ts).
   */
  wait?: () => () => void
}

/**
 * Run the gate for one call. Resolves when the call may proceed; throws
 * {@link ToolDeniedError} otherwise. `alwaysAllow` short-circuits (built-ins).
 */
export const gateToolCall = async (
  state: ApprovalState,
  call: {
    toolName: string
    input: unknown
    readOnly: boolean
    step?: IPlanStep
    subagent?: { id: string; depth: number }
    app?: ToolApprovalApp
  },
  events: ApprovalEvents,
  signal?: AbortSignal,
): Promise<void> => {
  const permission = decideToolPermission({
    toolName: call.toolName,
    readOnly: call.readOnly,
    mode: state.mode,
    rules: state.config.rules,
    remembered: state.remembered,
  })
  if (permission === 'allow') return
  const id = `approval-${Date.now().toString(36)}-${(seq += 1)}`
  if (permission === 'deny') {
    const reason =
      state.mode === 'read-only' && !matchRule(state.config.rules, call.toolName)
        ? 'the agent is in read-only mode'
        : 'blocked by policy'
    events.resolved({ id, name: call.toolName, approved: false, reason, automatic: true })
    throw new ToolDeniedError(reason)
  }
  const onRequest = state.config.onRequest
  if (!onRequest) {
    const reason = 'no approval handler configured'
    events.resolved({ id, name: call.toolName, approved: false, reason, automatic: true })
    throw new ToolDeniedError(reason)
  }
  const req: ToolApprovalRequest = { id, ...call }
  events.requested(req)
  let decision: { approved: boolean; reason?: string; remember?: boolean }
  // A person is being asked: the step's limit is about models and tools, and does not run
  // meanwhile. The wait has its own bound, `timeoutMs`, and a stop still ends it at once.
  const resume = events.wait?.()
  try {
    decision = normalizeDecision(
      await withDeadline(Promise.resolve(onRequest(req)), state.config.timeoutMs, signal),
    )
  } catch (err) {
    resume?.()
    const reason = err instanceof Error ? err.message : String(err)
    events.resolved({ id, name: call.toolName, approved: false, reason, automatic: true })
    throw new ToolDeniedError(reason)
  }
  resume?.()
  if (decision.approved && decision.remember) state.remembered.add(call.toolName)
  events.resolved({
    id,
    name: call.toolName,
    approved: decision.approved,
    reason: decision.reason,
    automatic: false,
  })
  if (!decision.approved) throw new ToolDeniedError(decision.reason)
}

const withDeadline = <T>(
  p: Promise<T>,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<T> => {
  if ((!timeoutMs || timeoutMs <= 0) && !signal) return p
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      done()
      reject(new Error('the run was stopped while waiting for approval'))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        done()
        reject(new Error(`no approval decision within ${timeoutMs} ms`))
      }, timeoutMs)
    }
    p.then(
      (v) => {
        done()
        resolve(v)
      },
      (e) => {
        done()
        reject(e)
      },
    )
  })
}
