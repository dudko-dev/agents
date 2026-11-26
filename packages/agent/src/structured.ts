import {
  NoObjectGeneratedError,
  Output,
  generateText,
  streamText,
  type DeepPartial,
  type LanguageModel,
} from 'ai'
import type { z } from 'zod'
import type { IStageCallOptions } from './call-options.ts'
import type { ISdkUsageLike } from './utils.ts'

// Structured output for the stages that need an object back (planner, replanner, a pipeline's
// route call): `generateText` / `streamText` with `Output.object`, the AI SDK v7 replacement for
// the deprecated `generateObject` / `streamObject`. The request is the same one (a JSON response
// format carrying the schema); what the old calls guaranteed and the new ones do not is restored
// here, so a caller keeps one contract:
//   - a failure to produce the object is ALWAYS a NoObjectGeneratedError carrying the `usage` and
//     the `finishReason` of the attempt (the spend still counts, and `withCapHint` reads the
//     finish reason), including the case where the model returned no text at all;
//   - a provider error of a streamed call is thrown as it is (status code and all, so the retry
//     logic can judge it), instead of being logged to the console and replaced with a bare
//     "no output generated".
export interface IStructuredCall<OBJECT> extends Partial<IStageCallOptions> {
  model: LanguageModel
  schema: z.ZodType<OBJECT>
  prompt: string
  abortSignal?: AbortSignal
}

export interface IStructuredResult<OBJECT> {
  object: OBJECT
  usage: ISdkUsageLike
}

export const generateStructured = async <OBJECT>({
  schema,
  ...call
}: IStructuredCall<OBJECT>): Promise<IStructuredResult<OBJECT>> => {
  const result = await generateText({ ...call, output: Output.object({ schema }) })
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
  return { object, usage: result.usage }
}

export interface IStructuredStream<OBJECT> {
  // The object as it grows. Never throws for a provider error: `final()` does.
  partialObjectStream: AsyncIterable<DeepPartial<OBJECT>>
  // Call after the partial stream is drained: the validated object and the usage, or the error.
  final: () => Promise<IStructuredResult<OBJECT>>
}

export const streamStructured = <OBJECT>({
  schema,
  ...call
}: IStructuredCall<OBJECT>): IStructuredStream<OBJECT> => {
  let failed = false
  let streamError: unknown
  const result = streamText({
    ...call,
    output: Output.object({ schema }),
    // Without a handler the SDK prints the error and the result promises reject with a generic
    // NoOutputGeneratedError: keep the first real one to throw.
    onError: ({ error }) => {
      if (!failed) {
        failed = true
        streamError = error
      }
    },
  })
  return {
    partialObjectStream: result.partialOutputStream as AsyncIterable<DeepPartial<OBJECT>>,
    final: async () => {
      if (failed) {
        throw streamError instanceof Error ? streamError : new Error(String(streamError))
      }
      const [object, usage] = await Promise.all([result.output, result.usage])
      return { object: object as OBJECT, usage }
    },
  }
}
