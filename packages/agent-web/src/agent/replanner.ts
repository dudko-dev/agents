import {
  askDecisionModel,
  decisionEventOf,
  decisionUsageOf,
  replanDecisionQuestion,
} from '../decision.js'
import { generate, generateStructured } from '../llm/generate.js'
import { clip, normalizeUsage, usageOfError } from '../llm/util.js'
import { parseReplannerResponse, type ReplanDecision } from '../parse.js'
import type { ToolCallMode } from '../prompts.js'
import { renderActiveSkills } from '../skills.js'
import type { IUsage } from './loop-types.js'
import { addUsage } from './loop-types.js'
import { stageCall, withCapHint, type AgentContext } from './internal.js'
import { ReplanSchema } from './schemas.js'

export interface ReplanOutcome {
  decision: ReplanDecision
  reason: string
  /** Replacement remaining steps (descriptions) when decision is 'revise'. */
  plan: string[]
  usage: IUsage
  /**
   * Set when the replanner call itself failed (the structured attempt AND the prompted
   * fallback): `decision: 'continue'` is then the fallback, not the model's decision.
   */
  failed?: true
  /** The failure, when `failed`. */
  error?: string
  /**
   * Set when `config.decisionModel` made the decision (the replanner was not called): the
   * probability it gave its choice.
   */
  confidence?: number
}

/**
 * Decide whether to continue, revise the remaining plan, or finish, after a
 * blocked/failed step. Native mode uses generateStructured(ReplanSchema); prompted
 * mode salvages the decision from text. Any failure degrades to 'continue' so a
 * flaky replanner never aborts the run or throws away the steps already done — but not
 * silently: the outcome is marked `failed` (the runner reports it as an `error` event of
 * phase 'replan' and `replan.decision { failed: true }`), and what the failed attempts cost
 * is in `usage`. An abort is a stop, not a failure: it is thrown.
 */
export const decideReplan = async (
  ctx: AgentContext,
  goal: string,
  done: string[],
  remaining: string[],
  /** How many of the user's latest messages (`ctx.userUpdates()`) the plan has not been weighed against yet. */
  newUpdates = 0,
): Promise<ReplanOutcome> => {
  const state = await ctx.state()
  const updates = ctx.userUpdates?.()
  const active = ctx.activeSkills?.() ?? []
  const commonFor = (mode: ToolCallMode) => {
    const parts = ctx.prompts.replanner({
      goal,
      state,
      done,
      remaining,
      mode,
      activeSkills: active.length ? renderActiveSkills(active) : undefined,
      ...(updates?.length ? { updates, newUpdates } : {}),
      ...(ctx.tiers ? { tiers: true } : {}),
    })
    return {
      ...stageCall(ctx, 'replanner', parts.system),
      prompt: parts.prompt,
      temperature: ctx.config.temperature,
      abortSignal: ctx.signal,
      timeoutMs: ctx.config.chatTimeoutMs,
    }
  }

  // Tokens a failed structured attempt cost, added to the fallback call's.
  let wasted = normalizeUsage()
  if (ctx.plannerMode === 'native') {
    try {
      const result = await generateStructured(ctx.plannerModel, ReplanSchema, commonFor('native'))
      return {
        decision: result.object.decision,
        reason: result.object.reason,
        plan: result.object.plan ?? [],
        usage: normalizeUsage(result.usage),
      }
    } catch (err) {
      // An abort is a stop, not a schema failure — don't spend a fallback call.
      if (ctx.signal?.aborted) throw err
      /* fall through to the prompted salvage below */
      wasted = usageOfError(err)
      const why = asMessage(withCapHint(ctx, 'replanner', err))
      ctx.log.warn('replanner: native structured output failed, salvaging:', why)
      ctx.emit({ type: 'retry', phase: 'replan', attempt: 1, error: why })
    }
  }

  try {
    // The prompted path — also the fallback after a native failure, re-rendered
    // with explicit JSON-shape instructions.
    const result = await generate(ctx.plannerModel, commonFor('prompted'))
    const parsed = parseReplannerResponse(result.text)
    return {
      decision: parsed.decision,
      reason: parsed.reason,
      plan: parsed.plan,
      usage: addUsage(wasted, normalizeUsage(result.usage)),
    }
  } catch (err) {
    if (ctx.signal?.aborted) throw err
    const error = asMessage(err)
    return {
      decision: 'continue',
      reason: `replanner failed: ${clip(error, 300)}`,
      plan: [],
      usage: addUsage(wasted, usageOfError(err)),
      failed: true,
      error,
    }
  }
}

/**
 * `config.decisionModel`, asked before the replanner: "continue or finish?". Returns the outcome
 * when the model is confident of one of those two, and undefined when the replanner must be
 * called as ever - no decision model, a low confidence, an error, a timeout, an answer that is
 * not an option, or `revise` (a revised plan is text; a decision model does not write). Either
 * way a `decision` event says what happened; `onUsage` is told what the question cost. Throws
 * only when the run is stopped.
 */
export const decideReplanWithDecisionModel = async (
  ctx: AgentContext,
  goal: string,
  done: string[],
  remaining: string[],
  onUsage: (usage: IUsage) => void,
): Promise<ReplanOutcome | undefined> => {
  const model = ctx.decisionModel
  if (!model || ctx.raw.decision?.replan === false) return undefined
  const active = ctx.activeSkills?.() ?? []
  const parts = ctx.prompts.replanner({
    goal,
    state: await ctx.state(),
    done,
    remaining,
    mode: 'native',
    activeSkills: active.length ? renderActiveSkills(active) : undefined,
  })
  let outcome = await askDecisionModel(
    model,
    replanDecisionQuestion(parts.prompt),
    ctx.raw.decision,
    ctx.signal,
  )
  onUsage(decisionUsageOf(outcome))
  if (outcome.accepted && outcome.choice === 'revise') {
    outcome = { ...outcome, accepted: false, reason: 'needs-model' }
  }
  ctx.emit(decisionEventOf('replan', outcome, model))
  if (!outcome.accepted || (outcome.choice !== 'continue' && outcome.choice !== 'finish')) {
    return undefined
  }
  const confidence = outcome.confidence ?? 0
  return {
    decision: outcome.choice,
    reason: `decision model: ${outcome.choice} (confidence ${confidence.toFixed(2)})`,
    plan: [],
    usage: normalizeUsage(),
    confidence,
  }
}

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
