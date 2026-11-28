// `config.sharedLimits`: a hook before and after every LANGUAGE-MODEL call, so that limits shared
// by many workers - a provider's rate limit, a tenant's budget - can be kept by the host's own
// store. Scale-out HOOK, not a limiter: the host decides; this file only makes sure every call
// asks. `beforeModelCall` may wait (a rate limit: the call starts later) or throw (a refusal: the
// call fails with ModelCallRefusedError, which no retry of this package repeats); afterModelCall
// is told what the call used, and its errors are only logged.
//
// The seam is one AI SDK middleware (`wrapLanguageModel`) around the stage's model, applied at the
// call site (`limitedModel`): the planner model serves the planner, the replanner and a pipeline's
// route call, the synthesizer model the answer and the summaries, so the stage is named where the
// call is made. Without the hook the model is passed on untouched - not even wrapped.
//
// Not here, deliberately: the media models (image / speech / transcription), the search grounding
// call (`web_search` through Google) and decision models. They are not language-model calls of a
// stage; their spend is reported as `usage` events of their own phases.
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai'
import { estimateTokens } from './compaction.ts'
import { runContext } from './context.ts'
import { journalMiddleware } from './journal.ts'
import type { AgentStage, EventHandler, IUsage } from './types.ts'
import { emptyUsage, normalizeUsage } from './utils.ts'

export { isModelCallRefused } from './utils.ts'

// What a call is for: the four stages, a compaction summary (history or trace), a pipeline's
// route call.
export type ModelCallStage = AgentStage | 'compaction' | 'route'

export interface IModelCall {
  // The run the call is made for: the run the HOST started - a helper's or a subagent's calls
  // carry their root run's id, they are spent for it. Absent for a call made outside any run
  // (`agent.compact()`, a pipeline's route call).
  runId?: string
  stage: ModelCallStage
  // The AI SDK provider id (e.g. 'openai.chat') and model id of the model the call goes to.
  provider?: string
  modelId: string
  // The prompt and the tool definitions, estimated (errs high, like the compaction estimate).
  estimatedInputTokens?: number
  // The call's output cap, when it has one.
  maxOutputTokens?: number
}

export interface ISharedLimits {
  // Before the call is sent. Resolve to let it go (wait first for a rate limit); throw to refuse
  // it. `signal` aborts when the call itself is given up (its timeout, a stop): the time spent
  // here counts against the call's own timeout, like a slow answer.
  beforeModelCall: (call: IModelCall, context: { signal?: AbortSignal }) => void | Promise<void>
  // Once per call `beforeModelCall` let through, when it ends: `usage` is what the provider
  // reported (zeros when it reported nothing - a call that failed, or one given up while
  // `beforeModelCall` was still deciding), `ok` whether it finished. Not awaited; a throw is only
  // logged.
  afterModelCall?: (
    call: IModelCall,
    usage: IUsage,
    outcome: { ok: boolean },
  ) => void | Promise<void>
}

// A call `beforeModelCall` refused. Never retried by this package: not by its retry helper, not by
// the AI SDK's (it is not an API error), not on a stronger tier. The stage then fails as it fails
// on any error - see the README, "Running on many workers".
export class ModelCallRefusedError extends Error {
  readonly call: IModelCall
  constructor(call: IModelCall, cause: unknown) {
    super(
      `the ${call.stage} call to ${call.modelId} was refused by sharedLimits.beforeModelCall: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    )
    this.name = 'ModelCallRefusedError'
    this.call = call
  }

  toJSON(): string {
    return this.message
  }
}

export const checkSharedLimits = (hooks: ISharedLimits | undefined): void => {
  if (hooks === undefined) {
    return
  }
  if (!hooks || typeof hooks.beforeModelCall !== 'function') {
    throw new Error('sharedLimits.beforeModelCall must be a function')
  }
  if (hooks.afterModelCall !== undefined && typeof hooks.afterModelCall !== 'function') {
    throw new Error('sharedLimits.afterModelCall must be a function when given')
  }
}

type Middleware = LanguageModelMiddleware
type CallParams = Parameters<NonNullable<Middleware['wrapGenerate']>>[0]['params']
type WrappedModel = Parameters<NonNullable<Middleware['wrapGenerate']>>[0]['model']
type StreamResult = Awaited<
  ReturnType<Parameters<NonNullable<Middleware['wrapStream']>>[0]['doStream']>
>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never

const textOf = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

// The prompt and the tools as text, for the estimate. Files and images are not counted: their
// cost depends on the provider, and an estimate that pretends to know is worse than none.
const promptText = (params: CallParams): string => {
  const out: string[] = []
  for (const message of params.prompt ?? []) {
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') {
      out.push(content)
      continue
    }
    if (!Array.isArray(content)) {
      continue
    }
    for (const part of content as Record<string, unknown>[]) {
      if (typeof part.text === 'string') {
        out.push(part.text)
      } else if ('input' in part) {
        out.push(textOf(part.input))
      } else if ('output' in part) {
        out.push(textOf(part.output))
      }
    }
  }
  for (const tool of params.tools ?? []) {
    out.push(textOf(tool))
  }
  return out.join('\n')
}

const callOf = (stage: ModelCallStage, params: CallParams, model: WrappedModel): IModelCall => {
  const store = runContext.getStore()
  const runId = store?.rootRunId ?? store?.runId
  return {
    ...(runId ? { runId } : {}),
    stage,
    ...(model.provider ? { provider: model.provider } : {}),
    modelId: model.modelId,
    estimatedInputTokens: estimateTokens(promptText(params)),
    ...(typeof params.maxOutputTokens === 'number'
      ? { maxOutputTokens: params.maxOutputTokens }
      : {}),
  }
}

// The provider's usage (V4: nested totals) as this package's IUsage.
const usageOf = (usage: unknown): IUsage => {
  const u = (usage ?? {}) as {
    inputTokens?: number | { total?: number; cacheRead?: number; cacheWrite?: number }
    outputTokens?: number | { total?: number; reasoning?: number }
  }
  const input = typeof u.inputTokens === 'object' && u.inputTokens ? u.inputTokens : undefined
  const output = typeof u.outputTokens === 'object' && u.outputTokens ? u.outputTokens : undefined
  return normalizeUsage({
    inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : input?.total,
    outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : output?.total,
    inputTokenDetails: { cacheReadTokens: input?.cacheRead, cacheWriteTokens: input?.cacheWrite },
    outputTokenDetails: { reasoningTokens: output?.reasoning },
  })
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('Aborted', 'AbortError')

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// Where a failed afterModelCall is reported: the run's log when the call is made in one.
const logWarn = (fallback: ((message: string) => void) | undefined, message: string): void => {
  const emit = runContext.getStore()?.emit
  try {
    if (emit) {
      emit({ type: 'log', level: 'warn', message })
    } else {
      fallback?.(message)
    }
  } catch {}
}

const after = (
  hooks: ISharedLimits,
  call: IModelCall,
  usage: IUsage,
  ok: boolean,
  log: ((message: string) => void) | undefined,
): void => {
  if (!hooks.afterModelCall) {
    return
  }
  const failed = (err: unknown): void =>
    logWarn(log, `[sharedLimits] afterModelCall threw (${call.stage}): ${messageOf(err)}`)
  try {
    const r = hooks.afterModelCall(call, usage, { ok })
    if (r && typeof (r as Promise<void>).then === 'function') {
      ;(r as Promise<void>).then(undefined, failed)
    }
  } catch (err) {
    failed(err)
  }
}

// Ask `beforeModelCall`, bounded by the call's own signal. A throw is a refusal; the call's abort
// is an abort. A hook that lets the call through only after the call was given up is told the
// call ended (afterModelCall, `ok: false`), so a host counting slots gets every one back.
const before = (
  hooks: ISharedLimits,
  call: IModelCall,
  signal: AbortSignal | undefined,
  log: ((message: string) => void) | undefined,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }
    let gaveUp = false
    const asked = Promise.resolve().then(() =>
      hooks.beforeModelCall(call, signal ? { signal } : {}),
    )
    const onAbort = (): void => {
      gaveUp = true
      reject(abortReason(signal as AbortSignal))
      asked.then(
        () => after(hooks, call, emptyUsage(), false, log),
        () => {},
      )
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    asked.then(
      () => {
        signal?.removeEventListener('abort', onAbort)
        if (!gaveUp) {
          resolve()
        }
      },
      (err) => {
        signal?.removeEventListener('abort', onAbort)
        if (gaveUp) {
          return
        }
        if (signal?.aborted) {
          reject(abortReason(signal))
          return
        }
        reject(err instanceof ModelCallRefusedError ? err : new ModelCallRefusedError(call, err))
      },
    )
  })

const middlewareOf = (
  hooks: ISharedLimits,
  stage: ModelCallStage,
  log: ((message: string) => void) | undefined,
): Middleware => ({
  wrapGenerate: async ({ doGenerate, params, model }) => {
    const call = callOf(stage, params, model)
    await before(hooks, call, params.abortSignal, log)
    let result: Awaited<ReturnType<typeof doGenerate>>
    try {
      result = await doGenerate()
    } catch (err) {
      after(hooks, call, usageOf((err as { usage?: unknown })?.usage), false, log)
      throw err
    }
    after(hooks, call, usageOf(result.usage), true, log)
    return result
  },
  wrapStream: async ({ doStream, params, model }) => {
    const call = callOf(stage, params, model)
    await before(hooks, call, params.abortSignal, log)
    let result: StreamResult
    try {
      result = await doStream()
    } catch (err) {
      after(hooks, call, emptyUsage(), false, log)
      throw err
    }
    // Passed through part by part; the call ends when the stream does - finished, failed or
    // cancelled - and afterModelCall hears of it once.
    const reader = result.stream.getReader()
    let usage: IUsage = emptyUsage()
    let finished = false
    let failed = false
    let ended = false
    const end = (ok: boolean): void => {
      if (!ended) {
        ended = true
        after(hooks, call, usage, ok, log)
      }
    }
    const stream = new ReadableStream<StreamPart>({
      pull: async (controller) => {
        let next: Awaited<ReturnType<typeof reader.read>>
        try {
          next = await reader.read()
        } catch (err) {
          end(false)
          controller.error(err)
          return
        }
        if (next.done) {
          end(finished && !failed)
          controller.close()
          return
        }
        const part = next.value as { type?: string; usage?: unknown }
        if (part.type === 'finish') {
          finished = true
          usage = usageOf(part.usage)
        } else if (part.type === 'error') {
          failed = true
        }
        controller.enqueue(next.value)
      },
      cancel: async (reason) => {
        end(false)
        await reader.cancel(reason)
      },
    })
    return { ...result, stream }
  },
})

// The key of the wrappers made for a call without a sharedLimits hook (the journal's alone).
const NO_LIMITS = {} as ISharedLimits

const cache = new WeakMap<ISharedLimits, WeakMap<object, Map<string, LanguageModel>>>()

/**
 * The model to call for `stage`: `model` itself when neither hook is in force, else `model`
 * behind the middleware of each (one wrapper per hook, model, stage and journal). The
 * sharedLimits hook in force is the run's (`runContext`: the agent's own, or - for an agent
 * without one running inside another run, an in-process subagent - the run above it), else
 * `hooks` (a call outside any run). The journal's (persistence.journal, journal.ts) is the run's
 * and goes OUTSIDE: a replayed call never reaches the sharedLimits hook.
 */
export const limitedModel = (
  model: LanguageModel,
  stage: ModelCallStage,
  hooks: ISharedLimits | undefined,
  log?: (message: string) => void,
): LanguageModel => {
  const store = runContext.getStore()
  const active = store?.sharedLimits ?? hooks
  const journaled = Boolean(store?.journal)
  if ((!active && !journaled) || typeof model !== 'object' || model === null) {
    return model
  }
  const key = active ?? NO_LIMITS
  let byModel = cache.get(key)
  if (!byModel) {
    byModel = new WeakMap()
    cache.set(key, byModel)
  }
  let byStage = byModel.get(model)
  if (!byStage) {
    byStage = new Map()
    byModel.set(model, byStage)
  }
  const slot = journaled ? `${stage}+journal` : stage
  let wrapped = byStage.get(slot)
  if (!wrapped) {
    wrapped = wrapLanguageModel({
      model,
      middleware: [
        ...(journaled ? [journalMiddleware(stage)] : []),
        ...(active ? [middlewareOf(active, stage, log)] : []),
      ],
    })
    byStage.set(slot, wrapped)
  }
  return wrapped
}

// limitedModel for a stage of an agent: its config's hook outside a run, its log for a failed
// afterModelCall made outside a run.
export const stageModel = (
  ctx: { config: { sharedLimits?: ISharedLimits }; emit: EventHandler },
  stage: ModelCallStage,
  model: LanguageModel,
): LanguageModel =>
  limitedModel(model, stage, ctx.config.sharedLimits, (message) =>
    ctx.emit({ type: 'log', level: 'warn', message }),
  )
