import { addMediaUsage } from '../tools/media-shared.js'

/** Executor models by strength (`config.executorTiers`), weakest first. */
export type ModelTier = 'light' | 'standard' | 'strong'

/**
 * What the planner marks a step with when tiers are configured: how hard the step is. It names
 * the tier the step should run on (low -> light, medium -> standard, high -> strong).
 */
export type StepComplexity = 'low' | 'medium' | 'high'

/**
 * Why a step started on its tier: 'planned' - the planner's complexity named a configured tier;
 * 'default' - the planner did not mark the step, so it runs on `standard`; 'fallback' - the tier
 * the planner named is not configured, so the nearest configured one runs it.
 */
export type TierReason = 'planned' | 'default' | 'fallback'

/**
 * Why a step was retried on a stronger tier: the executor reported a blocker; it produced no
 * text and no successful tool call; it kept calling a tool with arguments that did not parse;
 * its output was cut by the per-call cap; or its model call failed.
 */
export type EscalationReason =
  'blocked' | 'empty-result' | 'tool-arguments' | 'output-cut' | 'error'

/** One escalation of a step, kept on its result. */
export interface IStepEscalation {
  from: ModelTier
  to: ModelTier
  reason: EscalationReason
}

export interface EscalationConfig {
  /** Retries of ONE step on stronger tiers (each on the next stronger configured tier). Default 1. */
  maxPerStep?: number
  /** Escalations in one run, a resumed run included. Default 3. */
  maxPerRun?: number
}

/** A single step of a plan. Mirrors the Node sibling's IPlanStep. */
export interface IPlanStep {
  id: string
  description: string
  expectedOutcome?: string
  /** Tools the planner thinks this step needs (drives 'plan-narrowed' selection). */
  suggestedTools?: string[]
  /** Set by the pipeline when suggestedTools were named but all were unknown. */
  requiresTools?: boolean
  /** How hard the planner rated the step. Only when `config.executorTiers` is on. */
  complexity?: StepComplexity
}

export interface IPlan {
  thought: string
  steps: IPlanStep[]
}

export interface IUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Output tokens spent thinking (a subset of outputTokens). */
  reasoningTokens?: number
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens?: number
  /** Input tokens written to the provider's prompt cache. */
  cacheWriteTokens?: number
  /**
   * What the media models (`config.media`) were asked for - calls (failed ones included), images
   * written, characters sent to the speech model, seconds of audio transcribed. Not tokens and
   * not part of the counts above. Absent until a media model is called (see `IMediaUsage`).
   */
  mediaCalls?: number
  imagesGenerated?: number
  speechCharacters?: number
  transcriptionSeconds?: number
  /**
   * Calls made to `config.decisionModel`. A call is not a token: what the API billed for it (when
   * it says) is in the token fields, the number of calls is here. Absent when zero.
   */
  decisionCalls?: number
}

export interface IToolCall {
  name: string
  input: unknown
  output: unknown
  ok: boolean
}

export interface IStepResult {
  step: IPlanStep
  summary: string
  toolCalls: IToolCall[]
  /** True when the executor signalled it could not complete the step ([BLOCKER]). */
  blocked: boolean
  /**
   * Only when `config.executorTiers` is on: the tier (and its model id) the step FINISHED on, and
   * the escalations that led there, in order. `toolCalls` then holds every attempt's calls.
   */
  tier?: ModelTier
  model?: string
  escalations?: IStepEscalation[]
}

/**
 * Sentinel the executor emits when it cannot complete a step. Language-agnostic
 * and shared by the tool loop (which must preserve it across prompted rounds)
 * and `splitBlocker` (which strips it and drives the replanner).
 */
export const BLOCKER = '[BLOCKER]'

export const emptyUsage = (): IUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
})

export const addUsage = (a: IUsage, b: IUsage): IUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  ...addMediaUsage(a, b),
  ...((a.decisionCalls ?? 0) + (b.decisionCalls ?? 0) > 0
    ? { decisionCalls: (a.decisionCalls ?? 0) + (b.decisionCalls ?? 0) }
    : {}),
})
