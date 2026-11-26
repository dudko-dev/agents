import {
  NoObjectGeneratedError,
  Output,
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from 'ai'
import type { ZodType } from 'zod'
import type { ProviderOptionsMap, ThinkingLevel } from '../thinking.js'
import { promptOf, timeoutSignal } from './util.js'

/** Options shared by the low-level generation helpers. Provide `prompt` OR `messages`. */
export interface GenerateOptions {
  /** The system prompt — a string, or a SystemModelMessage (e.g. with a cache breakpoint). */
  system?: string | SystemModelMessage
  prompt?: string
  messages?: ModelMessage[]
  tools?: ToolSet
  maxOutputTokens?: number
  temperature?: number
  /** Portable thinking level (see `resolveThinking`). */
  reasoning?: ThinkingLevel
  /** Provider-keyed options (thinking budgets, cache keys, …). */
  providerOptions?: ProviderOptionsMap
  abortSignal?: AbortSignal
  /** Time-box the call; combined with `abortSignal` (0/undefined = no timeout). */
  timeoutMs?: number
}

/** The settings every helper forwards; omits undefined keys the SDK would reject. */
const callSettings = (opts: GenerateOptions) => ({
  ...(opts.system !== undefined ? { instructions: opts.system } : {}),
  maxOutputTokens: opts.maxOutputTokens,
  temperature: opts.temperature,
  ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
  ...(opts.providerOptions ? { providerOptions: opts.providerOptions as never } : {}),
  abortSignal: timeoutSignal(opts.abortSignal, opts.timeoutMs),
})

/**
 * One-shot text generation. Thin, provider-agnostic wrapper over the AI SDK's
 * `generateText` — the same call works against a cloud model, a local WebLLM
 * model, or Chrome/Edge built-in AI. Returns the full AI SDK result (`.text`,
 * `.usage`, `.toolCalls`, `.steps`, …).
 */
export const generate = (
  model: LanguageModel,
  opts: GenerateOptions = {},
): ReturnType<typeof generateText> =>
  generateText({
    model,
    ...callSettings(opts),
    ...promptOf(opts),
    tools: opts.tools,
  })

/** Streaming text generation. Returns the AI SDK `streamText` result (`.textStream`, `.fullStream`). */
export const stream = (
  model: LanguageModel,
  opts: GenerateOptions = {},
): ReturnType<typeof streamText> =>
  streamText({
    model,
    ...callSettings(opts),
    ...promptOf(opts),
    tools: opts.tools,
  })

type TextResult = Awaited<ReturnType<typeof generateText>>

/** What `generateStructured` returns: the validated object and the call's metadata. */
export interface StructuredResult<OBJECT> {
  object: OBJECT
  /** The raw text the object was parsed from. */
  text: string
  usage: TextResult['usage']
  finishReason: TextResult['finishReason']
  warnings: TextResult['warnings']
  request: TextResult['request']
  response: TextResult['response']
  providerMetadata: TextResult['providerMetadata']
}

/**
 * Structured output constrained to a Zod schema: the AI SDK's `generateText` with
 * `Output.object` (v7's replacement for the deprecated `generateObject` — the same request, a
 * JSON response format carrying the schema). Cloud models and WebLLM both support this; tiny
 * local models can be unreliable — the agent's prompted mode is the fallback.
 *
 * Returns `.object` and `.usage` (plus `.text`, `.finishReason`, `.warnings`, `.request`,
 * `.response`, `.providerMetadata`). An answer that is not the object — unparsable, off the
 * schema, or no text at all — throws `NoObjectGeneratedError` carrying the `usage` and the
 * `finishReason` of the attempt, so the spend of a failed attempt can still be counted
 * (`usageOfError`).
 */
export const generateStructured = async <OBJECT>(
  model: LanguageModel,
  schema: ZodType<OBJECT>,
  opts: GenerateOptions = {},
): Promise<StructuredResult<OBJECT>> => {
  const result = await generateText({
    model,
    output: Output.object({ schema }),
    ...callSettings(opts),
    ...promptOf(opts),
  })
  let object: OBJECT
  try {
    object = result.output as OBJECT
  } catch (err) {
    // The model stopped without any text (cut off inside its reasoning, a content filter): the
    // SDK has nothing to parse and throws an error that knows neither the usage nor the reason.
    throw new NoObjectGeneratedError({
      message: 'No object generated: the model did not return a response.',
      cause: err instanceof Error ? err : undefined,
      text: result.text,
      response: result.response,
      usage: result.usage,
      finishReason: result.finishReason,
    })
  }
  return {
    object,
    text: result.text,
    usage: result.usage,
    finishReason: result.finishReason,
    warnings: result.warnings,
    request: result.request,
    response: result.response,
    providerMetadata: result.providerMetadata,
  }
}
