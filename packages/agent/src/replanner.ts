import { z } from 'zod'
import { stageCallOptions, withCapHint } from './call-options.ts'
import {
  askDecisionModel,
  decisionEventOf,
  decisionUsageOf,
  replanDecisionQuestion,
} from './decision.ts'
import type { IAgentInternalContext } from './internal.ts'
import { PlanSchema, TieredPlanSchema, catalogModeFor, effectiveToolStrategy } from './planner.ts'
import { buildReplannerUserPrompt, composeReplannerSystem } from './prompts.ts'
import { stageModel } from './shared-limits.ts'
import { generateStructured } from './structured.ts'
import { ATTR, withSpan } from './tracing.ts'
import type { IPlan, IPlanStep, IStepResult, IUsage } from './types.ts'
import { normalizeUsage, usageOfError, withRetry, withTimeout } from './utils.ts'

const decisionSchemaWith = (plan: typeof PlanSchema) =>
  z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('continue'),
      reason: z.string().min(1).describe('Why the next step is still appropriate'),
    }),
    z.object({
      mode: z.literal('finish'),
      reason: z.string().min(1).describe('Why no more steps are needed'),
    }),
    z.object({
      mode: z.literal('revise'),
      reason: z.string().min(1).describe('Why the plan must change'),
      newPlan: plan.describe('Plan covering ONLY the remaining work'),
    }),
  ])

export const DecisionSchema = decisionSchemaWith(PlanSchema)

// With config.executorTiers: a revised plan's steps carry a complexity too (see TieredPlanSchema).
export const TieredDecisionSchema = decisionSchemaWith(
  TieredPlanSchema as unknown as typeof PlanSchema,
)

export type ReplanDecision = z.infer<typeof DecisionSchema>

export const decideNextAction = async (
  input: string,
  plan: IPlan,
  trace: IStepResult[],
  nextStep: IPlanStep | null,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
  // How many of the user's latest messages (ctx.run.userUpdates) the plan has not been
  // weighed against yet.
  newUpdates = 0,
): Promise<ReplanDecision> =>
  withSpan('agent.replan', { [ATTR.PHASE]: 'replan' }, async (span) => {
    const catalogMode = catalogModeFor(effectiveToolStrategy(ctx))
    const view = ctx.run
      ? { summary: ctx.run.traceSummary, upTo: ctx.run.traceSummaryUpTo }
      : undefined

    const { object, usage } = await withRetry(
      async () => {
        const call = stageCallOptions(
          ctx.config,
          'replanner',
          composeReplannerSystem({
            mode: catalogMode,
            catalog: ctx.toolCatalog,
            domain: ctx.config.systemPrompt,
            skills: ctx.skills,
            activeSkills: ctx.run?.activeSkills,
            ...(ctx.tiers ? { tiers: true } : {}),
          }),
        )
        const r = await generateStructured({
          model: stageModel(ctx, 'replanner', ctx.plannerModel),
          schema: ctx.tiers ? TieredDecisionSchema : DecisionSchema,
          ...call,
          prompt: buildReplannerUserPrompt(
            input,
            plan,
            trace,
            nextStep,
            view,
            ctx.run?.userUpdates.map((u) => u.text),
            newUpdates,
          ),
          abortSignal: withTimeout(signal, ctx.config.llmTimeoutMs ?? 0),
        }).catch((err) => {
          throw withCapHint(err, ctx.config, 'replanner')
        })
        const usage: IUsage = normalizeUsage(r.usage)
        return { object: r.object, usage }
      },
      {
        maxRetries: ctx.config.llmMaxRetries ?? 2,
        signal,
        onRetry: (attempt, err) =>
          ctx.emit({ type: 'retry', phase: 'replan', attempt, error: (err as Error).message }),
      },
    ).catch((err) => {
      // A decision that could not be parsed was paid for all the same: it counts in the run's
      // usage (and against its limits) whatever the runner does with the failure.
      const wasted = usageOfError(err)
      if (wasted) {
        ctx.emit({ type: 'usage', phase: 'replan', usage: wasted })
      }
      throw err
    })

    ctx.emit({ type: 'usage', phase: 'replan', usage })
    span.setAttribute(ATTR.REPLAN_MODE, object.mode)
    span.setAttribute(ATTR.USAGE_TOTAL_TOKENS, usage.totalTokens)
    return object
  })

// `config.decisionModel`, asked before the replanner: "continue or finish?". Returns the decision
// when the model is confident of one of those two, and undefined when the replanner must be
// called as ever - no decision model, a low confidence, an error, a timeout, an answer that is
// not an option, or `revise` (a revised plan is text; a decision model does not write). Either
// way a `decision` event says what happened. Throws only when the run is stopped.
export const decideWithDecisionModel = async (
  input: string,
  plan: IPlan,
  trace: IStepResult[],
  nextStep: IPlanStep | null,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
): Promise<{ decision: ReplanDecision; confidence: number } | undefined> => {
  const model = ctx.config.decisionModel
  if (!model || ctx.config.decision?.replan === false) {
    return undefined
  }
  const view = ctx.run
    ? { summary: ctx.run.traceSummary, upTo: ctx.run.traceSummaryUpTo }
    : undefined
  const question = replanDecisionQuestion(
    buildReplannerUserPrompt(input, plan, trace, nextStep, view),
  )
  let outcome = await askDecisionModel(model, question, ctx.config.decision, signal)
  ctx.emit({ type: 'usage', phase: 'decision', usage: decisionUsageOf(outcome) })
  if (outcome.accepted && outcome.choice === 'revise') {
    outcome = { ...outcome, accepted: false, reason: 'needs-model' }
  }
  ctx.emit(decisionEventOf('replan', outcome, model))
  if (!outcome.accepted || (outcome.choice !== 'continue' && outcome.choice !== 'finish')) {
    return undefined
  }
  const confidence = outcome.confidence ?? 0
  return {
    decision: {
      mode: outcome.choice,
      reason: `decision model: ${outcome.choice} (confidence ${confidence.toFixed(2)})`,
    },
    confidence,
  }
}
