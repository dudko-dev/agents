import { asSchema, type Tool, type ToolSet } from 'ai'
import type { IPlanStep, IUsage } from '../agent/loop-types.js'
import type { RunControlPort } from '../agent/control.js'
import type { AgentEvent, UsagePhase } from '../events.js'
import { ToolBudgetError } from '../limits.js'
import {
  decideToolPermission,
  gateToolCall,
  isReadOnlyTool,
  type ApprovalState,
} from './approval.js'
import { recordWrite, replayOutput, replayedWrite, type IStepWrites } from '../tiers.js'
import { promptHintOf } from './types.js'
import type { SpawnRun } from '../subagent/dynamic.js'
import type { IWaitClock } from '../wait-clock.js'

/**
 * What a tool's `execute` can reach of the run that called it, passed as
 * `options.agentRun`. Subagent tools use it to stream nested events and to
 * charge their usage to the parent run.
 */
export interface ToolRunContext {
  emit: (event: AgentEvent) => void
  /** The plan step being executed, when there is one. */
  step?: IPlanStep
  signal?: AbortSignal
  /**
   * Add what was spent on the parent's behalf to the run: a subagent's tokens (the default
   * phase, 'subagent'), a media model's call (phase 'media'), or a grounded search's tokens
   * (phase 'search').
   */
  addUsage: (usage: IUsage, phase?: UsagePhase) => void
  /** The run's usage so far (media tools read their per-run call count from it). */
  usage?: () => IUsage
  /**
   * Run the agent's consent gate for a call made on its behalf (e.g. a host
   * tool a subagent calls). Resolves when allowed, throws ToolDeniedError.
   */
  approve: (toolName: string, input: unknown, readOnly: boolean) => Promise<void>
  /** The run's control, when the host passed one: subagents register here so they can be listed and stopped. */
  control?: RunControlPort
  /** The run's id (for provenance). */
  runId?: string
  /** Pages web_fetch read in this run (origin + path), kept as provenance for any lesson the run writes. */
  fetched?: string[]
  /** Internal - what the built-in `spawn_subagent` tool reads of the run (`subagents.dynamic`). */
  spawn?: SpawnRun
  /**
   * Set on the run of a helper the model started (`subagents.dynamic`): the call is the
   * helper's, not the run's the host started. An MCP tool reads it to decide whether the call
   * may ask the user something (`onElicitation`, `elicitation.subagents`).
   */
  subagent?: { id: string; depth: number }
  /**
   * The questions MCP servers asked the user in this run (`onElicitation`): one object per run,
   * shared with the helpers it starts (`elicitation.maxPerRun`).
   */
  elicitations?: { count: number }
  /**
   * Internal - the run's clock (wait-clock.ts): the step's `chatTimeoutMs` and the time limits
   * of the subagents the run's tool calls start are deadlines of it, and whoever asks a person
   * something on the run's behalf (the consent gate, an MCP question) pauses it for the wait.
   */
  clock?: IWaitClock
}

/** Read the run context the agent passes to a tool's execute (undefined outside a run). */
export const toolRunContextOf = (options: unknown): ToolRunContext | undefined =>
  (options as { agentRun?: ToolRunContext } | undefined)?.agentRun

const truncated = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s

const toText = (v: unknown): string => {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

type ToModelOutput = NonNullable<Tool['toModelOutput']>

/**
 * Cap what the MODEL sees of a tool result at `maxChars` (the raw output still
 * reaches events and the trace). A tool's own `toModelOutput` runs first.
 */
export const limitModelOutput = (
  original: Tool['toModelOutput'],
  maxChars: number,
): ToModelOutput =>
  (async (opts: Parameters<ToModelOutput>[0]) => {
    const base = original
      ? await original(opts)
      : typeof opts.output === 'string'
        ? ({ type: 'text', value: opts.output } as const)
        : ({ type: 'json', value: (opts.output ?? null) as never } as const)
    if (base.type === 'text' || base.type === 'error-text') {
      return { ...base, value: truncated(base.value, maxChars) }
    }
    if (base.type === 'json' || base.type === 'error-json') {
      const text = toText(base.value)
      if (text.length <= maxChars) return base
      return {
        type: base.type === 'json' ? 'text' : 'error-text',
        value: truncated(text, maxChars),
      }
    }
    return base
  }) as ToModelOutput

export interface WrapToolsOptions {
  approval: ApprovalState
  /** Names that skip the gate and the call budget (built-in meta-tools). */
  builtins: ReadonlySet<string>
  emit: (event: AgentEvent) => void
  step: () => IPlanStep | undefined
  signal?: AbortSignal
  addUsage: (usage: IUsage, phase?: UsagePhase) => void
  /** The run's usage so far, handed to tools through their run context. */
  usage?: () => IUsage
  /** Called before each counted call; throw to refuse it. */
  countCall: () => void
  maxToolOutputChars: number
  /** The run's control, handed to tools through their run context. */
  control?: RunControlPort
  runId?: string
  /** Shared with every call of the run, so a lesson can name what the run read. */
  fetched?: string[]
  /**
   * The writes of the step in flight, while that step may be escalated to a stronger tier (else
   * undefined, and nothing changes): a write that already succeeded in an EARLIER attempt at the
   * step is not executed again - the call gets the earlier result back (see `tiers.ts`).
   */
  stepWrites?: () => IStepWrites | undefined
  /** The run's place among the helpers the model starts, handed to tools through their run context. */
  spawn?: SpawnRun
  /** Set on a helper's own run: every consent request it makes carries it. */
  subagent?: { id: string; depth: number }
  /** The run's count of questions asked of the user, handed to tools through their run context. */
  elicitations?: { count: number }
  /** The run's clock: the gate pauses it while a person decides; handed to tools too. */
  clock?: IWaitClock
}

const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof v === 'object' && v !== null && Symbol.asyncIterator in v

/** Record a call's result once it is known, without changing what `execute` returns or when. */
const recording = (out: unknown, record: (value: unknown) => void): unknown => {
  if (isAsyncIterable(out)) {
    return (async function* () {
      let last: unknown
      for await (const value of out) {
        last = value
        yield value
      }
      record(last)
    })()
  }
  if (out && typeof (out as { then?: unknown }).then === 'function') {
    return (out as Promise<unknown>).then((value) => {
      record(value)
      return value
    })
  }
  record(out)
  return out
}

/**
 * Wrap every tool for one run: the consent gate, the tool-call budget, the
 * model-facing output cap, and the run context passed as `options.agentRun`.
 * When the gate allows a call synchronously, `execute` is invoked without an
 * extra await, so a streaming tool keeps returning its iterable.
 */
export const wrapToolsForRun = (tools: ToolSet, o: WrapToolsOptions): ToolSet => {
  const out: ToolSet = {}
  const gate = (toolName: string, input: unknown, readOnly: boolean, signal?: AbortSignal) =>
    gateToolCall(
      o.approval,
      {
        toolName,
        input,
        readOnly,
        step: o.step(),
        ...(o.subagent ? { subagent: o.subagent } : {}),
      },
      {
        requested: (req) =>
          o.emit({
            type: 'tool.approval-requested',
            id: req.id,
            name: req.toolName,
            input: req.input,
            readOnly: req.readOnly,
            step: req.step,
            ...(req.subagent ? { subagent: req.subagent } : {}),
          }),
        resolved: (r) => o.emit({ type: 'tool.approval-resolved', ...r }),
        ...(o.clock ? { wait: o.clock.pause } : {}),
      },
      signal ?? o.signal,
    )
  for (const [name, t] of Object.entries(tools)) {
    const execute = (t as { execute?: (input: unknown, options: unknown) => unknown }).execute
    const builtin = o.builtins.has(name)
    const readOnly = builtin || isReadOnlyTool(t)
    const wrapped: Record<string, unknown> = { ...t }
    if (o.maxToolOutputChars > 0) {
      wrapped.toModelOutput = limitModelOutput(t.toModelOutput, o.maxToolOutputChars)
    }
    if (typeof execute === 'function') {
      wrapped.execute = (input: unknown, options: unknown) => {
        // A read-only or built-in tool is never held back or recorded.
        const writes = readOnly ? undefined : o.stepWrites?.()
        // Before the consent gate and the budget: a call that is not made costs neither.
        const earlier = replayedWrite(writes, name, input)
        if (earlier) return replayOutput(earlier.output)
        const call = (): unknown => {
          if (!builtin) o.countCall()
          const agentRun: ToolRunContext = {
            emit: o.emit,
            step: o.step(),
            signal: o.signal,
            addUsage: o.addUsage,
            ...(o.usage ? { usage: o.usage } : {}),
            approve: (toolName, toolInput, ro) => gate(toolName, toolInput, ro),
            ...(o.control ? { control: o.control } : {}),
            ...(o.runId ? { runId: o.runId } : {}),
            ...(o.fetched ? { fetched: o.fetched } : {}),
            ...(o.spawn ? { spawn: o.spawn } : {}),
            ...(o.subagent ? { subagent: o.subagent } : {}),
            ...(o.elicitations ? { elicitations: o.elicitations } : {}),
            ...(o.clock ? { clock: o.clock } : {}),
          }
          return execute.call(t, input, { ...(options as object), agentRun })
        }
        const run = (): unknown =>
          writes ? recording(call(), (value) => recordWrite(writes, name, input, value)) : call()
        if (builtin) return run()
        const permission = decideToolPermission({
          toolName: name,
          readOnly,
          mode: o.approval.mode,
          rules: o.approval.config.rules,
          remembered: o.approval.remembered,
        })
        if (permission === 'allow') return run()
        return gate(
          name,
          input,
          readOnly,
          (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal,
        ).then(run)
      }
    }
    out[name] = wrapped as Tool
  }
  return out
}

/** Throws ToolBudgetError once `cap` calls were made (cap ≤ 0 = unlimited). */
export const createCallCounter = (cap: number | undefined, initial = 0) => {
  // `initial` is a resumed run's count: the cap is per RUN, not per process.
  let calls = Math.max(0, Math.floor(initial))
  return {
    count: (): void => {
      if (cap && cap > 0 && calls >= cap) throw new ToolBudgetError(cap)
      calls += 1
    },
    get calls() {
      return calls
    },
    get exhausted() {
      return Boolean(cap && cap > 0 && calls >= cap)
    },
  }
}

type JsonSchemaLike = {
  type?: string | string[]
  properties?: Record<string, JsonSchemaLike>
  required?: string[]
  items?: JsonSchemaLike
  enum?: unknown[]
}

const typeHint = (s: JsonSchemaLike | undefined, depth: number): string => {
  if (!s) return 'any'
  if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.length <= 8) {
    return s.enum.map((v) => JSON.stringify(v)).join(' | ')
  }
  const type = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type
  if (type === 'array') return `${typeHint(s.items, depth)}[]`
  if (type === 'object' || s.properties) {
    if (depth > 1 || !s.properties) return 'object'
    return objectHint(s, depth + 1)
  }
  return type ?? 'any'
}

const objectHint = (s: JsonSchemaLike, depth = 0): string => {
  const required = new Set(s.required ?? [])
  const props = Object.entries(s.properties ?? {})
  if (props.length === 0) return '{}'
  return `{ ${props
    .slice(0, 12)
    .map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${typeHint(v, depth)}`)
    .join(', ')}${props.length > 12 ? ', …' : ''} }`
}

/**
 * A short parameter hint ("{ text: string, x?: number }") derived from a
 * tool's JSON schema — so tools without a hand-written `promptHint` (every MCP
 * tool) still tell a prompted model what to pass. Undefined when unknown.
 */
export const schemaHintOf = async (t: Tool): Promise<string | undefined> => {
  const own = promptHintOf(t)
  if (own) return own
  try {
    const schema = (await asSchema(t.inputSchema as never).jsonSchema) as JsonSchemaLike
    return schema && typeof schema === 'object' ? objectHint(schema) : undefined
  } catch {
    return undefined
  }
}
