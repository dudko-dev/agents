import type {
  EscalationReason,
  IEscalationConfig,
  IStepResult,
  ModelTier,
  StepComplexity,
  TierReason,
} from './types.ts'

// Model tiers (config.executorTiers) and escalation (config.escalation): the pure rules. Which
// tier a step runs on, which tier is tried after a failure, what counts as a failure a stronger
// model could fix, and what the stronger model is shown of the attempt before it. The browser
// sibling's src/tiers.ts carries the same rules under the same names: change both, with tests.

// Weakest first: the order escalation climbs.
export const MODEL_TIERS: readonly ModelTier[] = ['light', 'standard', 'strong']

export const STEP_COMPLEXITIES: readonly StepComplexity[] = ['low', 'medium', 'high']

const TIER_OF: Record<StepComplexity, ModelTier> = {
  low: 'light',
  medium: 'standard',
  high: 'strong',
}

export const isStepComplexity = (v: unknown): v is StepComplexity =>
  typeof v === 'string' && (STEP_COMPLEXITIES as readonly string[]).includes(v)

/**
 * The tier a step runs on. The planner's complexity names the tier it wants (low -> light,
 * medium -> standard, high -> strong); a step the planner did not mark runs on `standard`.
 * A tier the host did not configure falls back to the NEAREST configured one, and of two equally
 * near the STRONGER: a step is never handed to a model weaker than it has to be. `standard` is
 * always configured (it is the agent's own model), so in practice a missing `light` or `strong`
 * means `standard` - the rule is general so that it stays true if that ever changes.
 */
export const pickTier = (
  complexity: StepComplexity | undefined,
  configured: ReadonlySet<ModelTier>,
): { tier: ModelTier; reason: TierReason } => {
  const wanted: ModelTier = complexity ? TIER_OF[complexity] : 'standard'
  if (configured.has(wanted)) {
    return { tier: wanted, reason: complexity ? 'planned' : 'default' }
  }
  const at = MODEL_TIERS.indexOf(wanted)
  let best: ModelTier | undefined
  let bestDistance = Infinity
  for (const tier of MODEL_TIERS) {
    if (!configured.has(tier)) {
      continue
    }
    const distance = Math.abs(MODEL_TIERS.indexOf(tier) - at)
    // `<=`: the list runs weakest first, so on a tie the later (stronger) tier wins.
    if (distance <= bestDistance) {
      best = tier
      bestDistance = distance
    }
  }
  if (!best) {
    throw new Error('no executor tier is configured')
  }
  return { tier: best, reason: 'fallback' }
}

// The next configured tier above `tier`, or undefined when it is the strongest one.
export const nextStrongerTier = (
  tier: ModelTier,
  configured: ReadonlySet<ModelTier>,
): ModelTier | undefined =>
  MODEL_TIERS.slice(MODEL_TIERS.indexOf(tier) + 1).find((t) => configured.has(t))

export interface IResolvedEscalation {
  enabled: boolean
  maxPerStep: number
  maxPerRun: number
}

export const DEFAULT_ESCALATIONS_PER_STEP = 1
export const DEFAULT_ESCALATIONS_PER_RUN = 3

const cap = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback

/**
 * Escalation is ON by default once tiers are configured, and cannot be on without them. A host
 * that routes easy steps to a light model has accepted that the planner's rating may be wrong;
 * without escalation a mis-rated step fails outright and the replanner (another paid call) has
 * to plan around a failure that a model the host already configured would not have had. The cost
 * is bounded: one retry per step and three per run unless the host says otherwise.
 */
export const resolveEscalation = (
  setting: boolean | IEscalationConfig | undefined,
  tiersActive: boolean,
): IResolvedEscalation => {
  const cfg = typeof setting === 'object' && setting !== null ? setting : {}
  const maxPerStep = cap(cfg.maxPerStep, DEFAULT_ESCALATIONS_PER_STEP)
  const maxPerRun = cap(cfg.maxPerRun, DEFAULT_ESCALATIONS_PER_RUN)
  return {
    enabled: tiersActive && setting !== false && maxPerStep > 0 && maxPerRun > 0,
    maxPerStep,
    maxPerRun,
  }
}

const nameOf = (v: unknown): string =>
  v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string'
    ? (v as { name: string }).name
    : ''

const textOf = (v: unknown): string => {
  if (typeof v === 'string') {
    return v
  }
  if (v && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string') {
    return (v as { message: string }).message
  }
  return ''
}

// A failed call the USER (or the approval policy) refused: a bigger model must not get a second
// go at something a person said no to.
export const isDeniedOutput = (output: unknown): boolean =>
  nameOf(output) === 'ToolDeniedError' || /Tool call denied by the user/.test(textOf(output))

// A failed call the run's tool-call budget refused.
export const isBudgetOutput = (output: unknown): boolean =>
  nameOf(output) === 'ToolBudgetError' || /tool-call budget exhausted/i.test(textOf(output))

// A failed call whose ARGUMENTS the model got wrong (they did not parse, or did not match the
// tool's schema) - the AI SDK's InvalidToolInputError (which reaches the trace as its text), or
// the prompted path's own message.
export const isInvalidArgumentsOutput = (output: unknown): boolean =>
  /InvalidToolInput|InvalidToolArguments|ToolCallRepair/.test(nameOf(output)) ||
  /InvalidToolInputError|Invalid input for tool |^invalid args for "/i.test(textOf(output))

// "Repeatedly": the same tool was called with bad arguments at least twice in the attempt and
// never got a good call in after the last of them.
const argumentsKeptFailing = (calls: IStepResult['toolCalls']): boolean => {
  const bad = new Map<string, number[]>()
  calls.forEach((c, i) => {
    if (!c.ok && isInvalidArgumentsOutput(c.output)) {
      bad.set(c.name, [...(bad.get(c.name) ?? []), i])
    }
  })
  return [...bad].some(
    ([name, at]) =>
      at.length >= 2 && !calls.slice(at[at.length - 1] + 1).some((c) => c.ok && c.name === name),
  )
}

// What one executor attempt at a step came to, as far as escalation needs to know.
export interface IAttemptOutcome {
  toolCalls: IStepResult['toolCalls']
  blocked: boolean
  // The model wrote no text at all.
  empty: boolean
  // The last model call ended on the output cap (finishReason 'length').
  cut: boolean
  // A run-level budget (tokens, tool calls) stopped the attempt.
  stopped: boolean
}

/**
 * Why an attempt that RETURNED should be retried on a stronger model, or undefined when it should
 * not. Never for an attempt a budget stopped, or one in which the user (or the approval policy)
 * denied a tool: those are not the model's failures.
 */
export const escalationReasonOf = (o: IAttemptOutcome): EscalationReason | undefined => {
  if (o.stopped || o.toolCalls.some((c) => !c.ok && isBudgetOutput(c.output))) {
    return undefined
  }
  if (o.toolCalls.some((c) => !c.ok && isDeniedOutput(c.output))) {
    return undefined
  }
  if (o.cut) {
    return 'output-cut'
  }
  if (o.blocked) {
    return 'blocked'
  }
  if (argumentsKeptFailing(o.toolCalls)) {
    return 'tool-arguments'
  }
  if (o.empty && !o.toolCalls.some((c) => c.ok)) {
    return 'empty-result'
  }
  return undefined
}

const statusIn = (
  err: unknown,
  match: (status: number) => boolean,
  seen: Set<unknown> = new Set(),
): boolean => {
  if (!err || typeof err !== 'object' || seen.has(err)) {
    return false
  }
  seen.add(err)
  const e = err as { statusCode?: number; status?: number; cause?: unknown; lastError?: unknown }
  const status = e.statusCode ?? e.status
  if (typeof status === 'number' && match(status)) {
    return true
  }
  return statusIn(e.cause, match, seen) || statusIn(e.lastError, match, seen)
}

/**
 * Whether an attempt that THREW may be retried on a stronger model. Not a stop or a timeout (the
 * call was cut, not wrong), not refused credentials (401 / 403: the next call fails the same way
 * and the host must hear about it), not a rate limit (429: that is for retry and backoff, and a
 * bigger model on the same account is the last thing to send), not a denial or a spent budget.
 */
export const isEscalatableError = (err: unknown): boolean => {
  const name = nameOf(err)
  if (name === 'AbortError' || name === 'TimeoutError') {
    return false
  }
  if (isDeniedOutput(err) || isBudgetOutput(err)) {
    return false
  }
  return !statusIn(err, (s) => s === 401 || s === 403 || s === 429)
}

// One attempt at a step that a stronger model now continues.
export interface IEarlierAttempt {
  tier: ModelTier
  reason: EscalationReason
  // What the attempt said (its summary, or the error it died of).
  summary: string
  toolCalls: IStepResult['toolCalls']
}

const INPUT_CHARS = 400
const OUTPUT_CHARS = 1500

const asText = (v: unknown, max: number): string => {
  let s: string
  try {
    s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v))
  } catch {
    s = String(v)
  }
  return s.length > max ? `${s.slice(0, max)}... [truncated, ${s.length - max} chars]` : s
}

const WHY: Record<EscalationReason, string> = {
  blocked: 'it reported that it was blocked',
  'empty-result': 'it produced no result',
  'tool-arguments': 'it kept calling a tool with arguments that did not parse',
  'output-cut': 'its output was cut off by the output cap',
  error: 'its model call failed',
}

/**
 * What the stronger model is shown of the attempts before it - in the USER prompt, so the system
 * prompt stays run-stable. It names every tool call with its arguments and result, because the
 * calls that succeeded HAPPENED: the step continues from them, it does not start over.
 */
export const renderEarlierAttempts = (attempts: IEarlierAttempt[]): string => {
  if (attempts.length === 0) {
    return ''
  }
  const blocks = attempts.map((a, i) => {
    const calls = a.toolCalls.length
      ? a.toolCalls
          .map(
            (c) =>
              `    - ${c.name} ${asText(c.input, INPUT_CHARS)} -> ${c.ok ? 'ok' : 'FAILED'}: ${asText(c.output, OUTPUT_CHARS)}`,
          )
          .join('\n')
      : '    (no tool calls)'
    return [
      `Attempt ${i + 1} (${a.tier} model) stopped because ${WHY[a.reason]}.`,
      `  It said: ${asText(a.summary, OUTPUT_CHARS) || '(nothing)'}`,
      '  Tool calls it made:',
      calls,
    ].join('\n')
  })
  return [
    'EARLIER ATTEMPT AT THIS STEP - a smaller model started this step and did not finish it. You are continuing it, not starting over.',
    'Every tool call below marked ok was REALLY executed and its effect is already in place: do not make it again, use its result. Redo only what FAILED or is still missing.',
    ...blocks,
  ].join('\n')
}

const stable = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    return v.map(stable)
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

// Identity of a tool call: its name and its arguments, key order aside.
export const toolCallKey = (name: string, input: unknown): string => {
  try {
    return `${name}\u0000${JSON.stringify(stable(input)) ?? ''}`
  } catch {
    return `${name}\u0000${String(input)}`
  }
}

/**
 * The writes of the step in flight, kept while it may be escalated. A stronger model continuing
 * the step is TOLD what was already done; this is what makes it true even if it does not listen:
 * a call to a tool that is not read-only, with the same arguments as a call that already
 * succeeded in an EARLIER attempt at this step, is not executed again - it gets the earlier
 * result back. Within one attempt nothing changes (a model may repeat a call there as it always
 * could), and read-only tools are never held back.
 */
export interface IStepWrites {
  // 0 for the first attempt, +1 per escalation.
  attempt: number
  done: Map<string, { attempt: number; output: unknown }>
}

export const createStepWrites = (): IStepWrites => ({ attempt: 0, done: new Map() })

// The earlier result to hand back instead of running the call, or undefined to run it.
export const replayedWrite = (
  writes: IStepWrites | undefined,
  name: string,
  input: unknown,
): { output: unknown } | undefined => {
  const hit = writes?.done.get(toolCallKey(name, input))
  return hit && hit.attempt < writes!.attempt ? { output: hit.output } : undefined
}

export const recordWrite = (
  writes: IStepWrites | undefined,
  name: string,
  input: unknown,
  output: unknown,
): void => {
  writes?.done.set(toolCallKey(name, input), { attempt: writes.attempt, output })
}

export const REPLAY_NOTE =
  '[not run again: this exact call already succeeded in an earlier attempt at this step, and its effect is in place. Its result then:]'

export const replayOutput = (output: unknown): string => `${REPLAY_NOTE} ${asText(output, 20_000)}`

// Whether a tool call's `output` (in a `step.tool-result` event or a step's `toolCalls`) is the
// answer to a write that was NOT run again: the same call already succeeded in an earlier attempt
// at the step, and the model was handed that result under REPLAY_NOTE. For a UI or a log that
// marks such a call instead of counting it as a second execution. The browser sibling exports
// the same helper.
export const isReplayedToolOutput = (output: unknown): boolean =>
  typeof output === 'string' && output.startsWith(REPLAY_NOTE)
