import type { ReplanTrigger } from '../config.js'
import { contextOverflowOf } from '../context-window.js'
import { runToolLoop } from '../llm/tool-loop.js'
import { timeoutSignal } from '../llm/util.js'
import { renderActiveSkills, renderSkillIndex } from '../skills.js'
import { WEB_FETCH_TOOL } from '../tools/egress.js'
import { renderCatalog } from '../tools/prompted.js'
import { FIND_TOOLS_NAME } from '../tools/search.js'
import { renderEarlierAttempts, type IAttemptOutcome, type IEarlierAttempt } from '../tiers.js'
import { deadlineSignal } from '../wait-clock.js'
import {
  BLOCKER,
  type IPlanStep,
  type IStepResult,
  type IToolCall,
  type IUsage,
  type ModelTier,
} from './loop-types.js'
import { capNotice, imageRefusal, promptFor, stageCall, type AgentContext } from './internal.js'
import { SPAWN_EXECUTOR_NOTE } from '../subagent/dynamic-shared.js'

/**
 * Split the executor's reply into a clean summary and a structural `blocked`
 * flag. The [BLOCKER] sentinel — emitted by the executor when it can't complete
 * a step — is language-agnostic and drives the replanner; we strip every copy
 * so it never leaks into downstream prompts.
 */
export const splitBlocker = (raw: string): { summary: string; blocked: boolean } => {
  if (!raw.includes(BLOCKER)) return { summary: raw.trim(), blocked: false }
  return { summary: raw.split(BLOCKER).join('').trim(), blocked: true }
}

/**
 * The tool names the executor may call in this step, or undefined for "all".
 * 'plan-narrowed' → the step's suggestedTools; 'search' → built-ins, the
 * step's suggestedTools and tools discovered earlier in the run (find_tools
 * adds more while the step runs).
 */
const activeToolNames = (ctx: AgentContext, step: IPlanStep): string[] | undefined => {
  const strategy = ctx.strategy ?? ctx.config.toolSelectionStrategy
  const builtins = [...(ctx.builtinTools ?? [])].filter((n) => ctx.tools[n])
  const suggested = step.suggestedTools ?? []
  const known = suggested.filter((n) => ctx.tools[n])
  // The notebook's tools are not the plan's to hand out: a narrowed step still gets them.
  const notebook = (ctx.learning?.tools ?? []).filter((n) => ctx.tools[n])
  if (strategy === 'search') {
    const discovered = (ctx.discovered?.() ?? []).slice(-16)
    return [...new Set([...builtins, ...notebook, ...known, ...discovered])]
  }
  if (strategy !== 'plan-narrowed') return undefined
  // A step that named tools but all were unknown still wants tools: fall back to
  // the full set rather than stalling with zero.
  if (known.length === 0 && suggested.length > 0) return Object.keys(ctx.tools)
  return [...new Set([...known, ...builtins, ...notebook])]
}

const summaryOf = (text: string, toolCallCount: number): string => {
  if (text.length > 0) return text
  return toolCallCount > 0 ? `Executed ${toolCallCount} tool call(s).` : 'Step produced no output.'
}

/** Catalogue lines ("- name(hint): description") for the given tool names. */
const catalogFor = (ctx: AgentContext, names: string[]): string =>
  renderCatalog(
    Object.fromEntries(names.filter((n) => ctx.tools[n]).map((n) => [n, ctx.tools[n]])),
    ctx.toolHint,
  )

/**
 * One attempt at a step on a given tier (`config.executorTiers` / escalation). Without it the
 * step runs on `ctx.executorModel`, exactly as before tiers existed.
 */
export interface StepAttempt {
  tier?: ModelTier
  /** The attempts weaker tiers already made at this step: shown to the model so it continues. */
  earlier?: IEarlierAttempt[]
  /**
   * Every tool call the attempt makes is also pushed here as it completes, so a caller still has
   * them when the attempt THROWS (the calls happened either way).
   */
  calls?: IToolCall[]
}

/** The context of one attempt: the tier's model, tool-mode and output cap in place of the default. */
const attemptContext = (ctx: AgentContext, tier: ModelTier | undefined): AgentContext => {
  const t = tier && ctx.tiers?.byTier[tier]
  if (!t) return ctx
  return {
    ...ctx,
    executorModel: t.model,
    executorMode: t.mode,
    executorWindowTokens: t.windowTokens,
    config: { ...ctx.config, budgets: { ...ctx.config.budgets, executor: t.outputCap } },
  }
}

/** Execute one plan step: run the tool loop (native or prompted) and emit events. */
export const executeStep = async (
  base: AgentContext,
  goal: string,
  step: IPlanStep,
  index: number,
  total: number,
  done: string[],
  attempt: StepAttempt = {},
): Promise<{
  result: IStepResult
  usage: IUsage
  stoppedByBudget?: boolean
  /** How the attempt ended, as far as escalation needs to know. */
  outcome: IAttemptOutcome
}> => {
  const ctx = attemptContext(base, attempt.tier)
  const state = await ctx.state()
  ctx.setCurrentStep?.(step)
  // Under plan-narrowed / search selection the prompted path must also see the
  // narrowed catalogue — the prompt is its only tool surface (native mode gets
  // the SDK's activeTools instead and never renders the catalogue).
  const initial = activeToolNames(ctx, step)
  const searchMode = (ctx.strategy ?? ctx.config.toolSelectionStrategy) === 'search'
  const toolCatalog = catalogFor(ctx, initial ?? Object.keys(ctx.tools))
  const active = ctx.activeSkills?.() ?? []
  const parts = ctx.prompts.executor({
    goal,
    state,
    step: step.description,
    index,
    total,
    toolCatalog,
    done,
    mode: ctx.executorMode,
    skills: ctx.skills?.length ? renderSkillIndex(ctx.skills) : undefined,
    activeSkills: active.length ? renderActiveSkills(active) : undefined,
    searchMode: searchMode && Boolean(ctx.tools[FIND_TOOLS_NAME]),
    updates: ctx.userUpdates?.(),
    ...(ctx.learning?.nudge ? { learning: { fetch: Boolean(ctx.tools[WEB_FETCH_TOOL]) } } : {}),
    ...(ctx.sandbox ? { sandbox: ctx.sandbox.executor } : {}),
    ...(ctx.subagents ? { subagents: SPAWN_EXECUTOR_NOTE } : {}),
  })

  // What an escalated attempt is shown of the attempts before it goes into the USER prompt here,
  // whatever prompt builder the host supplied: a model that continues a step must know what was
  // already done. Absent otherwise, so a step that is not escalated sends the prompt it always did.
  const prompt = attempt.earlier?.length
    ? `${parts.prompt}\n\n${renderEarlierAttempts(attempt.earlier)}`
    : parts.prompt
  // Inputs of the calls in flight, by tool name, to pair with their results for `attempt.calls`.
  const inFlight: { name: string; input: unknown }[] = []

  // The step's time limit, on the run's clock: it does not run while a tool call of the step
  // waits for a person (a tool approval, an MCP elicitation) - see wait-clock.ts.
  const deadline = deadlineSignal(ctx.clock, ctx.signal, ctx.config.chatTimeoutMs)
  const loop = await runToolLoop(ctx.executorModel, {
    mode: ctx.executorMode,
    ...stageCall(ctx, 'executor', parts.system),
    ...promptFor(ctx, prompt),
    tools: ctx.tools,
    // In search mode the active set grows while the step runs.
    activeTools: searchMode
      ? () => [...new Set([...(initial ?? []), ...(ctx.discovered?.() ?? [])])]
      : initial,
    describeTools: (names) => catalogFor(ctx, names),
    maxSteps: ctx.config.maxStepsPerTask,
    shouldStop: ctx.overBudget,
    ...(ctx.takeRoundUpdates ? { takeUpdates: ctx.takeRoundUpdates } : {}),
    temperature: ctx.config.temperature,
    abortSignal: deadline.signal,
    caching: ctx.caching,
    ...(ctx.config.compaction.clearToolResultsAfterTokens > 0
      ? {
          clearToolResults: {
            triggerTokens: ctx.config.compaction.clearToolResultsAfterTokens,
            keep: ctx.config.compaction.keepToolResults,
          },
        }
      : {}),
    callbacks: {
      onToolResultsCleared: (info) => {
        ctx.log.info(`cleared ${info.cleared} stale tool result(s) from the step's context`)
        ctx.emit({
          type: 'context.compacted',
          scope: 'tool-results',
          beforeTokens: info.beforeTokens,
          afterTokens: info.afterTokens,
        })
      },
      onTextDelta: (delta) => ctx.emit({ type: 'step.text-delta', step, delta }),
      onReasoningDelta: (delta) => ctx.emit({ type: 'step.reasoning-delta', step, delta }),
      onToolCall: (name, input) => {
        ctx.log.info(`tool call: ${name}`, input)
        ctx.emit({ type: 'step.tool-call', step, name, input })
        if (attempt.calls) inFlight.push({ name, input })
      },
      onToolResult: (name, output, ok) => {
        ctx.log.debug(`tool result: ${name} ${ok ? 'ok' : 'FAILED'}`, output)
        ctx.emit({ type: 'step.tool-result', step, name, output, ok })
        if (attempt.calls) {
          const at = inFlight.findIndex((c) => c.name === name)
          const [call] = at >= 0 ? inFlight.splice(at, 1) : [{ name, input: undefined }]
          attempt.calls.push({ name, input: call.input, output, ok })
        }
      },
    },
  })
    .catch((err: unknown) => {
      throw (
        imageRefusal(ctx, err, ctx.executorModel) ??
        contextOverflowOf(err, ctx.executorModel) ??
        err
      )
    })
    .finally(deadline.done)
  ctx.log.debug('executor text:', loop.text)
  // A step the output cap cut off is silent otherwise: the text just stops, or a tool call's
  // arguments (a file body) end mid-JSON and the call never happens.
  const cut = capNotice(ctx, 'executor', loop.finishReason)
  if (cut) ctx.log.warn(cut)

  const { summary, blocked } = splitBlocker(loop.text)
  return {
    result: {
      step,
      summary: summaryOf(summary, loop.toolCalls.length),
      toolCalls: loop.toolCalls,
      blocked,
    },
    usage: loop.usage,
    stoppedByBudget: loop.stoppedByBudget,
    outcome: {
      toolCalls: loop.toolCalls,
      blocked,
      empty: summary.length === 0,
      cut: loop.finishReason === 'length',
      stopped: loop.stoppedByBudget === true,
    },
  }
}

/**
 * The replanner runs when a step was blocked or a tool call failed and stayed
 * failed. A failure that a LATER call to the same tool retried successfully is
 * resolved — the prompted feedback loop (and native multi-step) let the model
 * self-correct within the step, so it must not force a replan.
 */
export const shouldReplan = (result: IStepResult): boolean => {
  if (result.blocked) return true
  const { toolCalls } = result
  return toolCalls.some(
    (c, i) => !c.ok && !toolCalls.slice(i + 1).some((later) => later.ok && later.name === c.name),
  )
}

/** Bound a host `replanAfter` predicate by the same watchdog/abort as a model call. */
export interface ReplanWantedOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Called with whatever a host predicate threw before falling back to 'failure'. */
  onError?: (err: unknown) => void
}

/**
 * Resolve the configured `replanAfter` trigger for one step result. 'failure'
 * is the classic `shouldReplan`; 'always' consults the replanner after every
 * step; a host predicate decides per result. A predicate that throws, rejects,
 * or outlives the watchdog/abort falls back to 'failure' behaviour so a buggy
 * or hung predicate can never stall the run (its throw is surfaced via onError).
 */
export const replanWanted = async (
  trigger: ReplanTrigger,
  result: IStepResult,
  opts: ReplanWantedOptions = {},
): Promise<boolean> => {
  if (trigger === 'always') return true
  if (typeof trigger !== 'function') return shouldReplan(result)

  const fallback = (): boolean => shouldReplan(result)
  // Never rejects: a sync throw or async rejection resolves to the fallback.
  const decided = (async () => {
    try {
      return Boolean(await trigger(result))
    } catch (err) {
      opts.onError?.(err)
      return fallback()
    }
  })()

  const guard = timeoutSignal(opts.signal, opts.timeoutMs)
  if (!guard) return decided
  return Promise.race([
    decided,
    new Promise<boolean>((resolve) => {
      if (guard.aborted) resolve(fallback())
      else guard.addEventListener('abort', () => resolve(fallback()), { once: true })
    }),
  ])
}
