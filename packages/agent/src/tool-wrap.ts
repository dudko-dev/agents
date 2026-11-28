import type { Tool, ToolExecutionOptions, ToolSet } from 'ai'
import { isCodeExecutionTool, isReadOnlyTool, type IApprovalController } from './approval.ts'
import { defaultModelOutput, withToolOutputLimit } from './compaction.ts'
import { runContext } from './context.ts'
import type { IRunState } from './internal.ts'
import {
  beginJournalToolCall,
  DeferRefusedError,
  isDeferredResult,
  isJournalRerun,
  journalModelOutput,
  runJournaledToolCall,
  type IJournalToolHooks,
} from './journal.ts'
import { recordWrite, replayOutput, replayedWrite, toolCallKey } from './tiers.ts'

export interface IToolWrapDeps {
  approval: IApprovalController
  // Cap on tool calls per run (built-ins do not count).
  maxToolCalls?: number
  // Model-visible output cap per result (0 = unlimited).
  maxToolOutputChars: number
  // The input as a request shows it (inputSanitizer; idempotent): for a parked item.
  sanitize?: (name: string, input: unknown) => Promise<unknown>
}

const WRAPPED = Symbol.for('@dudko.dev/agent:wrapped-tool')

export class ToolBudgetError extends Error {
  constructor(cap: number) {
    super(
      `tool-call budget exhausted (maxToolCalls=${cap}). Do not call more tools; finish the step with what you have.`,
    )
    this.name = 'ToolBudgetError'
  }

  toJSON(): string {
    return this.message
  }
}

// One call against a run's tool budget. A helper the model started (config.subagents.dynamic)
// has its own cap - its share of its parent's - and its calls ALSO count on the parent, all the
// way up: a helper cannot make a call its parent has no budget left for.
const reserveOn = (state: IRunState, cap: number | undefined): (() => void) => {
  const own = state.spawn?.parent ? state.spawn.config?.maxToolCalls : cap
  if (typeof own === 'number' && own > 0 && state.toolCalls >= own) {
    throw new ToolBudgetError(own)
  }
  const parent = state.spawn?.parent
  const releaseParent = parent ? reserveOn(parent, cap) : undefined
  state.toolCalls++
  if (parent && state.spawn) {
    state.spawn.toolCalls = state.toolCalls
  }
  return () => {
    state.toolCalls--
    if (parent && state.spawn) {
      state.spawn.toolCalls = state.toolCalls
    }
    releaseParent?.()
  }
}

// Reserve one call of the run's tool budget; returns a release for a call
// that ends up not running (denied).
const reserveToolCall = (cap: number | undefined): (() => void) => {
  const state = runContext.getStore()?.state
  if (!state) {
    return () => {}
  }
  return reserveOn(state, cap)
}

const isAsyncGeneratorFunction = (fn: unknown): boolean =>
  Object.prototype.toString.call(fn) === '[object AsyncGeneratorFunction]'

/**
 * Wrap one tool's execute with the run-level gates — tool-call budget, then
 * the approval gate — and cap what the model sees of its results. The gate
 * runs INSIDE execute, so it works for every tool (MCP, native, subagent,
 * built-in) and every call path. Idempotent.
 */
export const wrapTool = (
  name: string,
  tool: Tool,
  deps: IToolWrapDeps,
  opts: { builtIn?: boolean } = {},
): Tool => {
  if ((tool as { [WRAPPED]?: boolean })[WRAPPED]) {
    return tool
  }
  const readOnly = isReadOnlyTool(tool)
  const codeExecution = isCodeExecutionTool(tool)
  const builtIn = opts.builtIn === true
  const inner = tool.execute as
    ((input: unknown, options: ToolExecutionOptions<unknown>) => unknown) | undefined
  const before = async (input: unknown, options: ToolExecutionOptions<unknown>) => {
    const release = builtIn ? () => {} : reserveToolCall(deps.maxToolCalls)
    try {
      await deps.approval.gate(name, input, {
        readOnly,
        builtIn,
        ...(codeExecution ? { codeExecution } : {}),
        signal: options?.abortSignal,
      })
    } catch (err) {
      release()
      throw err
    }
  }
  // The step's writes, while the step may be escalated to a stronger tier (else undefined, and
  // nothing below does anything). A read-only or built-in tool is never held back or recorded.
  const writes = () => (readOnly || builtIn ? undefined : runContext.getStore()?.state?.stepWrites)
  // persistence.journal: what this call is to the journal (journal.ts). A built-in runs again on
  // a replay (its effects are on the run's own state), and so does a tool that runs a run inside
  // it (that run replays); every other result is recorded and replayed.
  const journalKind: IJournalToolHooks['kind'] = builtIn
    ? 'builtin'
    : isJournalRerun(tool)
      ? 'rerun'
      : 'journaled'
  // What the model is shown of a result: set below, once the output cap is on the tool.
  let modelOutputOf: (
    output: unknown,
    toolCallId: string,
    input: unknown,
  ) => Promise<unknown> = async (output) => defaultModelOutput(output)
  const hooksOf = (
    input: unknown,
    options: ToolExecutionOptions<unknown>,
    live: () => Promise<unknown>,
  ): IJournalToolHooks => ({
    kind: journalKind,
    live,
    // A call answered without running still is one of the run's calls.
    count: () => {
      if (!builtIn) {
        try {
          reserveToolCall(deps.maxToolCalls)
        } catch {}
      }
    },
    modelOutput: (output) => modelOutputOf(output, options?.toolCallId, input),
    shown: async () => (deps.sanitize ? deps.sanitize(name, input) : input),
    wrote: (output) => {
      const w = writes()
      if (w && !w.done.has(toolCallKey(name, input))) {
        recordWrite(w, name, input, output)
      }
    },
    keepChars: deps.maxToolOutputChars,
    ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
  })
  let execute: unknown
  if (inner) {
    execute = isAsyncGeneratorFunction(inner)
      ? async function* (input: unknown, options: ToolExecutionOptions<unknown>) {
          const call = beginJournalToolCall(name, input, options?.toolCallId)
          if (call) {
            // Under the journal a streaming tool's values are passed on once the call is over
            // (the last one is its result, recorded before the model sees it).
            const values: unknown[] = []
            const result = await runJournaledToolCall(
              call,
              hooksOf(input, options, async () => {
                const earlier = replayedWrite(writes(), name, input)
                if (earlier) {
                  return replayOutput(earlier.output)
                }
                await before(input, options)
                let last: unknown
                for await (const value of inner(input, options) as AsyncIterable<unknown>) {
                  last = value
                  values.push(value)
                }
                if (!isDeferredResult(last)) {
                  recordWrite(writes(), name, input, last)
                }
                return last
              }),
            )
            for (const value of values.slice(0, -1)) {
              yield value
            }
            yield result
            return
          }
          // Before the budget and the consent gate: a call that is not made costs neither.
          const earlier = replayedWrite(writes(), name, input)
          if (earlier) {
            yield replayOutput(earlier.output)
            return
          }
          await before(input, options)
          let last: unknown
          for await (const value of inner(input, options) as AsyncIterable<unknown>) {
            if (isDeferredResult(value)) {
              throw new DeferRefusedError(name)
            }
            last = value
            yield value
          }
          recordWrite(writes(), name, input, last)
        }
      : async (input: unknown, options: ToolExecutionOptions<unknown>) => {
          const live = async (): Promise<unknown> => {
            const earlier = replayedWrite(writes(), name, input)
            if (earlier) {
              return replayOutput(earlier.output)
            }
            await before(input, options)
            const output = await inner(input, options)
            if (!isDeferredResult(output)) {
              recordWrite(writes(), name, input, output)
            }
            return output
          }
          const call = beginJournalToolCall(name, input, options?.toolCallId)
          if (call) {
            return runJournaledToolCall(call, hooksOf(input, options, live))
          }
          const output = await live()
          // A result that would come later needs the journal: without it the call fails.
          if (isDeferredResult(output)) {
            throw new DeferRefusedError(name)
          }
          return output
        }
  }
  const limited = withToolOutputLimit(
    { ...tool, ...(execute ? { execute } : {}) } as Tool,
    deps.maxToolOutputChars,
  )
  const own = limited.toModelOutput
  if (own) {
    modelOutputOf = async (output, toolCallId, input) =>
      own({ toolCallId, input, output } as Parameters<typeof own>[0])
  }
  // A result the journal handed back (or one it recorded) is shown to the model as recorded;
  // anything else as the tool shows it. Without a journal there is never one: the tool's own.
  const wrapped: Tool = own
    ? {
        ...limited,
        toModelOutput: async (opts) =>
          (journalModelOutput(opts.toolCallId) as Awaited<ReturnType<typeof own>> | undefined) ??
          own(opts),
      }
    : limited
  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false })
  return wrapped
}

export const wrapToolSet = (
  tools: ToolSet,
  deps: IToolWrapDeps,
  opts: { builtIn?: boolean } = {},
): ToolSet => {
  const out: ToolSet = {}
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = wrapTool(name, tool, deps, opts)
  }
  return out
}
