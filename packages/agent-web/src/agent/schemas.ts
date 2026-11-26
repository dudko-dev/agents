import { z } from 'zod'

/**
 * Structured-output schemas for the native path (`generateStructured`). Kept free of
 * `.max()`/`.min()` constraints — some providers reject or mis-handle them in
 * JSON-schema mode; we cap/clean in code instead (see parse.ts normalizeSteps).
 */
export const PlanStepSchema = z.object({
  description: z.string(),
  expectedOutcome: z.string().optional(),
  suggestedTools: z.array(z.string()).optional(),
})

/**
 * The plan step of an agent with `config.executorTiers`: it also carries the planner's rating. A
 * SEPARATE schema, so an agent without tiers sends exactly the schema it always did. Optional (a
 * model that leaves it out still gives a valid plan; the step then runs on `standard`).
 */
export const TieredPlanStepSchema = PlanStepSchema.extend({
  complexity: z.enum(['low', 'medium', 'high']).optional(),
})

export const PlanSchema = z.object({
  /** One short sentence. For a greeting/small talk, holds the answer and steps is empty. */
  thought: z.string(),
  steps: z.array(PlanStepSchema),
  /** Names of the configured skills that apply to this goal. */
  skills: z.array(z.string()).optional(),
})

export const TieredPlanSchema = PlanSchema.extend({ steps: z.array(TieredPlanStepSchema) })

export const ReplanSchema = z.object({
  decision: z.enum(['continue', 'revise', 'finish']),
  reason: z.string(),
  /** Replacement for the REMAINING steps when decision is 'revise'. */
  plan: z.array(z.string()).optional(),
})

export type PlanShape = z.infer<typeof PlanSchema>
export type ReplanShape = z.infer<typeof ReplanSchema>
