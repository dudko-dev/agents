import { experimental_decide, type Experimental_DecisionModel } from 'ai'

// `config.decisionModel`: a small, fast model that does not write text - it answers a closed
// question with one of the options and a probability (TypeSafe's Jev, Google's Gemini Decision 1,
// or anything of yours behind `decide`). The agent asks it where an ordinary model call only picks
// from a list: the replanner's continue / finish, and a pipeline node's route. Everything it says
// passes `askDecisionModel`: below the threshold, on an error, on a timeout, or when the answer is
// not one of the options, the ordinary model call runs exactly as it does without this feature.
//
// NEVER a security control. It is not consulted for tool approval, for egress, or for anything
// that lets the model do more: those stay in code. A wrong answer here costs a step, not a breach.
//
// This file imports nothing but `ai`. It is a COPY of the sibling package's `src/decision.ts`,
// byte for byte: change both (the Node package's `tests/decision.test.ts` compares them).

export interface IDecisionOption {
  // What the model answers with. Must be unique within a question.
  id: string
  // When this option applies. Without one the option is judged by its id alone.
  description?: string
}

export interface IDecisionQuestion {
  // Names the question in events ('replan', 'route'); the model does not need to see it.
  id: string
  // The question itself.
  prompt: string
  // The closed set of answers (two or more).
  options: readonly IDecisionOption[]
  // What the question is about: the text the ordinary model call would have been given.
  context?: string
}

export interface IDecisionCallOptions {
  // Aborts when the run stops or the decision's time is up. Honour it if you can.
  abortSignal?: AbortSignal
}

export interface IDecisionAnswer {
  // One of the question's option ids, exactly.
  choice: string
  // The probability that `choice` is right, 0..1 (NOT a self-reported feeling: a number the
  // threshold can be tuned against).
  confidence: number
  // Tokens the API says it billed, when it says. Never estimated.
  usage?: { inputTokens?: number; outputTokens?: number }
}

// The whole interface: questions in, a choice with a probability out. One question per call -
// that is all the agent needs, and it keeps an implementation of yours to a few lines.
export interface IDecisionModel {
  // For events and logs.
  readonly name?: string
  decide: (question: IDecisionQuestion, options: IDecisionCallOptions) => Promise<IDecisionAnswer>
}

export interface IDecisionConfig {
  // A decision is used only when its confidence is at least this. Default 0.8.
  confidenceThreshold?: number
  // The whole call, in ms; past it the ordinary model call runs. Default 5000. 0 = no limit.
  timeoutMs?: number
  // Ask it for the replanner's continue / finish. Default true.
  replan?: boolean
  // Ask it for a pipeline node's route. Default true.
  route?: boolean
}

// Between the two vendors' own starting points (Google's sample acts at 0.7; TypeSafe's routes
// read-only actions at 0.67 and destructive ones at 0.93). Tune it on your own traffic.
export const DEFAULT_DECISION_CONFIDENCE_THRESHOLD = 0.8
// A decision model answers in a fraction of a second; one that has not after this long is slower
// than the call it replaces.
export const DEFAULT_DECISION_TIMEOUT_MS = 5_000

export type DecisionPoint = 'replan' | 'route'

// Why the ordinary model call ran instead. 'needs-model': the decision was confident, but what it
// chose needs text only a language model can write (a revised plan).
export type DecisionFallbackReason =
  'low-confidence' | 'invalid-choice' | 'invalid-confidence' | 'error' | 'timeout' | 'needs-model'

export interface IDecisionOutcome {
  // true: `choice` is one of the options and `confidence` reached the threshold.
  accepted: boolean
  choice?: string
  confidence?: number
  threshold: number
  reason?: DecisionFallbackReason
  error?: string
  durationMs: number
  usage?: { inputTokens?: number; outputTokens?: number }
}

// What a consumer sees of one question: either the decision model's answer was used, or the
// ordinary model call ran and `reason` says why.
export interface IDecisionEvent {
  type: 'decision'
  point: DecisionPoint
  // true = the decision model's `choice` was used; false = the ordinary model call ran.
  accepted: boolean
  choice?: string
  confidence?: number
  threshold: number
  reason?: DecisionFallbackReason
  error?: string
  durationMs: number
  model?: string
}

export const decisionThreshold = (config?: IDecisionConfig): number => {
  const t = config?.confidenceThreshold
  return typeof t === 'number' && Number.isFinite(t) ? t : DEFAULT_DECISION_CONFIDENCE_THRESHOLD
}

const decisionTimeout = (config?: IDecisionConfig): number => {
  const t = config?.timeoutMs
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : DEFAULT_DECISION_TIMEOUT_MS
}

const MAX_ERROR_CHARS = 300

const messageOf = (err: unknown): string => {
  const text = err instanceof Error ? err.message : String(err)
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text
}

const TIMED_OUT = Symbol('decision-timeout')

// Ask one question and judge the answer. Resolves with an outcome whatever the model does - a
// refusal, a slow answer and a made-up option are all "not accepted", never an exception. Only a
// stop of the run (`signal`) throws, as it does everywhere else.
export const askDecisionModel = async (
  model: IDecisionModel,
  question: IDecisionQuestion,
  config?: IDecisionConfig,
  signal?: AbortSignal,
): Promise<IDecisionOutcome> => {
  const threshold = decisionThreshold(config)
  const timeoutMs = decisionTimeout(config)
  const started = Date.now()
  const rejected = (
    reason: DecisionFallbackReason,
    extra: Partial<IDecisionOutcome> = {},
  ): IDecisionOutcome => ({
    accepted: false,
    threshold,
    reason,
    durationMs: Date.now() - started,
    ...extra,
  })

  signal?.throwIfAborted()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  let answer: IDecisionAnswer | typeof TIMED_OUT
  try {
    // A `decide` that ignores its signal must not hold the run: the race ends at the deadline,
    // and what the call does afterwards is nobody's business (its late rejection is swallowed).
    const call = Promise.resolve().then(() =>
      model.decide(question, { abortSignal: controller.signal }),
    )
    call.catch(() => {})
    const waits: Promise<IDecisionAnswer | typeof TIMED_OUT>[] = [call]
    if (timeoutMs > 0) {
      waits.push(
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
        }),
      )
    }
    if (signal) {
      waits.push(
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      )
    }
    answer = await Promise.race(waits)
  } catch (err) {
    if (signal?.aborted) throw err
    return rejected('error', { error: messageOf(err) })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }

  if (answer === TIMED_OUT) {
    return rejected('timeout', { error: `no answer within ${timeoutMs} ms` })
  }
  const usage = answer?.usage ? { usage: answer.usage } : {}
  const choice = answer?.choice
  if (typeof choice !== 'string' || !question.options.some((o) => o.id === choice)) {
    return rejected('invalid-choice', {
      ...usage,
      error: `not one of the options: ${messageOf(JSON.stringify(choice) ?? 'undefined')}`,
    })
  }
  const confidence = answer.confidence
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return rejected('invalid-confidence', { ...usage, choice })
  }
  if (confidence < threshold) {
    return rejected('low-confidence', { ...usage, choice, confidence })
  }
  return {
    accepted: true,
    choice,
    confidence,
    threshold,
    durationMs: Date.now() - started,
    ...usage,
  }
}

export const decisionEventOf = (
  point: DecisionPoint,
  outcome: IDecisionOutcome,
  model?: IDecisionModel,
): IDecisionEvent => ({
  type: 'decision',
  point,
  accepted: outcome.accepted,
  ...(outcome.choice !== undefined ? { choice: outcome.choice } : {}),
  ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
  threshold: outcome.threshold,
  ...(outcome.reason ? { reason: outcome.reason } : {}),
  ...(outcome.error ? { error: outcome.error } : {}),
  durationMs: outcome.durationMs,
  ...(model?.name ? { model: model.name } : {}),
})

const tokens = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0

// What one question cost, as a usage record: the tokens the API reported (zero when it reported
// none - nothing is estimated) and ONE decision call. A call is not a token: it has its own field.
export const decisionUsageOf = (
  outcome: IDecisionOutcome,
): { inputTokens: number; outputTokens: number; totalTokens: number; decisionCalls: number } => {
  const inputTokens = tokens(outcome.usage?.inputTokens)
  const outputTokens = tokens(outcome.usage?.outputTokens)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, decisionCalls: 1 }
}

// The replanner's question. `revise` is an option so that the model can say "neither": a revised
// plan is text, which a decision model cannot write - that answer hands over to the replanner.
export const REPLAN_DECISION_OPTIONS: readonly IDecisionOption[] = [
  {
    id: 'continue',
    description:
      'The remaining plan is still right: the next planned step should run as it is written.',
  },
  {
    id: 'finish',
    description:
      'The request is already fully satisfied by the completed steps: no more steps are needed.',
  },
  {
    id: 'revise',
    description:
      'The remaining plan no longer fits (a step failed, was blocked, or showed the plan is wrong): it must be rewritten.',
  },
]

export const replanDecisionQuestion = (context: string): IDecisionQuestion => ({
  id: 'replan',
  prompt:
    'An agent is working through a plan and has just finished a step. Given the request, the plan and the results so far, what should happen next?',
  options: REPLAN_DECISION_OPTIONS,
  context,
})

export const routeDecisionQuestion = (
  routes: readonly { label: string; description?: string }[],
  context: string,
): IDecisionQuestion => ({
  id: 'route',
  prompt: 'One step of a pipeline has answered. Which ONE route does its answer take?',
  options: routes.map((r) => ({
    id: r.label,
    ...(r.description ? { description: r.description } : {}),
  })),
  context,
})

export interface IAiSdkDecisionOptions {
  // For events and logs. Default: the model's provider and id.
  name?: string
  // Retries inside the call. Default 0: the fallback of a decision is the ordinary model call,
  // not a second wait.
  maxRetries?: number
  headers?: Record<string, string>
}

// The one question key sent to the API. The agent's own ids could break a vendor's key rules,
// and the model never sees the key.
const QUESTION_KEY = 'decision'

// An `IDecisionModel` over an AI SDK decision model (`experimental_decide`):
// `google.decisionModel('gemini-decision-1')`, `typeSafeAi.decisionModel('jev-latest')`, or any
// other provider's. The confidence is the probability the API gave the option it chose. A model
// that returns no distribution (a language model adapted to decide) gets confidence 0, so its
// answers are never used: a threshold needs a probability, not a guess at one.
export const decisionModelFromAiSdk = (
  model: Experimental_DecisionModel,
  options: IAiSdkDecisionOptions = {},
): IDecisionModel => {
  const described =
    typeof model === 'string' ? model : `${model.provider}:${model.modelId}`.replace(/^:|:$/g, '')
  return {
    name: options.name ?? described,
    decide: async (question, call) => {
      const result = await experimental_decide({
        model,
        state: question.context ?? '',
        questions: {
          [QUESTION_KEY]: {
            type: 'choice',
            instructions: question.prompt,
            criteria: Object.fromEntries(question.options.map((o) => [o.id, o.description ?? ''])),
          },
        },
        maxRetries: options.maxRetries ?? 0,
        ...(options.headers ? { headers: options.headers } : {}),
        ...(call.abortSignal ? { abortSignal: call.abortSignal } : {}),
      })
      const answer = result.answers[QUESTION_KEY] as
        { choice?: unknown; probabilities?: Record<string, number> } | undefined
      const choice = typeof answer?.choice === 'string' ? answer.choice : ''
      const probability = answer?.probabilities?.[choice]
      return {
        choice,
        confidence: typeof probability === 'number' ? probability : 0,
        usage: {
          ...(result.usage?.inputTokens !== undefined
            ? { inputTokens: result.usage.inputTokens }
            : {}),
          ...(result.usage?.outputTokens !== undefined
            ? { outputTokens: result.usage.outputTokens }
            : {}),
        },
      }
    },
  }
}
