// End-to-end smoke test for the AI SDK wire format. The four agent stages drive `streamText`
// (executor + synthesizer), `streamText` with `Output.object` (planner, through
// `streamStructured`) and `generateText` with `Output.object` (replanner and the pipeline's
// route call, through `generateStructured`) - the v7 replacements for the deprecated
// `streamObject` / `generateObject`. This file plugs a MockLanguageModelV3 into each of those
// entry points with the exact schemas the agent uses (PlanSchema / DecisionSchema), so a
// stream-chunk-format regression or a schema-validation drift fails here at `npm test` time -
// long before any real provider call is made. It also pins what the old calls guaranteed and
// `src/structured.ts` restores: a failed attempt is a NoObjectGeneratedError that carries its
// usage and finish reason, and a provider error of a streamed call is thrown as it is.

import assert from 'node:assert/strict'
import test from 'node:test'
import { APICallError, NoObjectGeneratedError, streamText, type LanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { PlanSchema } from '../src/planner.ts'
import { DecisionSchema } from '../src/replanner.ts'
import { generateStructured, streamStructured } from '../src/structured.ts'

// V3 stream-part shapes: finishReason is { unified, raw }, usage is the
// nested-token-buckets struct. Emitting v2-shaped values here would slip
// through plain `streamText` (which is lenient about malformed usage) but trip
// the structured path deep in `chunk.finishReason.unified` access and silently
// hang the test - so we build them properly once.
const v3FinishReason = { unified: 'stop' as const, raw: undefined }
const v3Usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
})

// Helper: build a streaming model that emits a single text run with the
// given chunks then a `finish` part. Mirrors what a real provider streams
// for a plain text response.
const streamingModel = (chunks: string[]): LanguageModel =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: '0' })
          for (const delta of chunks) {
            controller.enqueue({ type: 'text-delta', id: '0', delta })
          }
          controller.enqueue({ type: 'text-end', id: '0' })
          controller.enqueue({
            type: 'finish',
            finishReason: v3FinishReason,
            usage: v3Usage(1, chunks.length),
          })
          controller.close()
        },
      }),
    }),
  })

// Helper: build a non-streaming model that returns a single text response
// from doGenerate (the path used by generateStructured).
const generatingModel = (text: string): LanguageModel =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: v3FinishReason,
      usage: v3Usage(1, text.length),
      warnings: [],
    }),
  })

test('streamText round-trips text deltas from a v3 mock model', async () => {
  const model = streamingModel(['hello ', 'v6 ', 'world'])
  const result = streamText({ model, prompt: 'greet' })
  let text = ''
  for await (const delta of result.textStream) {
    text += delta
  }
  assert.equal(text, 'hello v6 world')
})

test('streamStructured parses the planner schema from a streamed JSON model output', async () => {
  // Stream the JSON in two chunks to make sure the SDK reassembles it.
  const planJson = JSON.stringify({
    thought: 'Just answer directly - no tools needed for this prompt.',
    steps: [
      {
        id: 's1',
        description: 'Produce the final answer',
        expectedOutcome: 'A short text reply',
      },
    ],
  })
  const model = streamingModel([planJson.slice(0, 30), planJson.slice(30)])
  const result = streamStructured({ model, schema: PlanSchema, prompt: 'plan it' })
  // The stream is lazy: nothing happens until something pulls from it. partialObjectStream is
  // what the planner subscribes to in production, so iterating it here exercises the same path.
  const partials: unknown[] = []
  for await (const partial of result.partialObjectStream) {
    partials.push(partial)
  }
  assert.ok(partials.length >= 2, 'the object arrived in parts')
  const first = partials[0] as { thought?: string }
  assert.ok(planJson.includes(first.thought ?? ''), 'a partial carries the thought so far')
  const { object, usage } = await result.final()
  assert.equal(object.steps.length, 1)
  assert.equal(object.steps[0]!.id, 's1')
  assert.match(object.thought, /answer directly/)
  assert.equal(usage.inputTokens, 1)
  assert.equal(usage.outputTokens, 2)
})

test('generateStructured parses the replanner DecisionSchema (finish branch)', async () => {
  const decision = JSON.stringify({ mode: 'finish', reason: 'executor produced the answer' })
  const model = generatingModel(decision)
  const result = await generateStructured({ model, schema: DecisionSchema, prompt: 'decide' })
  assert.equal(result.object.mode, 'finish')
  assert.equal(result.object.reason, 'executor produced the answer')
  assert.equal(result.usage.inputTokens, 1)
})

test('generateStructured parses the replanner DecisionSchema (revise branch with nested PlanSchema)', async () => {
  const decision = JSON.stringify({
    mode: 'revise',
    reason: 'first plan was too optimistic; reduce scope',
    newPlan: {
      thought: 'Tighten the plan',
      steps: [{ id: 's1', description: 'do less', expectedOutcome: 'less is done' }],
    },
  })
  const model = generatingModel(decision)
  const result = await generateStructured({ model, schema: DecisionSchema, prompt: 'decide' })
  assert.equal(result.object.mode, 'revise')
  if (result.object.mode === 'revise') {
    assert.equal(result.object.newPlan.steps.length, 1)
  }
})

// ── what the request carries ───────────────────────────────────────────────

test('both structured calls ask for a JSON response format carrying the schema, and no tools', async () => {
  const seen: Record<string, unknown>[] = []
  const decision = JSON.stringify({ mode: 'finish', reason: 'done' })
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.push(options as never)
      return {
        content: [{ type: 'text', text: decision }],
        finishReason: v3FinishReason,
        usage: v3Usage(1, 1),
        warnings: [],
      }
    },
    doStream: async (options) => {
      seen.push(options as never)
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue({ type: 'text-start', id: '0' })
            controller.enqueue({ type: 'text-delta', id: '0', delta: decision })
            controller.enqueue({ type: 'text-end', id: '0' })
            controller.enqueue({
              type: 'finish',
              finishReason: v3FinishReason,
              usage: v3Usage(1, 1),
            })
            controller.close()
          },
        }),
      }
    },
  })
  await generateStructured({ model, schema: DecisionSchema, prompt: 'p', maxOutputTokens: 9 })
  const streamed = streamStructured({ model, schema: DecisionSchema, prompt: 'p' })
  for await (const _ of streamed.partialObjectStream) void _
  await streamed.final()
  assert.equal(seen.length, 2)
  for (const options of seen) {
    const format = options.responseFormat as { type: string; schema?: { anyOf?: unknown[] } }
    assert.equal(format.type, 'json')
    assert.ok(format.schema, 'the JSON schema travels with the request')
    assert.equal(options.tools, undefined, 'not a tool-based JSON mode')
  }
  assert.equal(seen[0].maxOutputTokens, 9, 'the per-call cap is passed through')
})

// ── failures keep the contract of the old calls ────────────────────────────

const cutModel = (text: string | undefined): LanguageModel =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: text === undefined ? [] : [{ type: 'text', text }],
      finishReason: { unified: 'length' as const, raw: undefined },
      usage: v3Usage(40, 7),
      warnings: [],
    }),
  })

const failure = async (run: () => Promise<unknown>): Promise<NoObjectGeneratedError> => {
  try {
    await run()
  } catch (err) {
    assert.ok(NoObjectGeneratedError.isInstance(err), `a NoObjectGeneratedError, got ${err}`)
    return err
  }
  throw new Error('expected the call to fail')
}

test('generateStructured: an answer that is not the object fails with its usage and finish reason', async () => {
  for (const text of ['not json at all', '{"mode":"finish"}', '{"mode":"contin']) {
    const err = await failure(() =>
      generateStructured({ model: cutModel(text), schema: DecisionSchema, prompt: 'decide' }),
    )
    assert.equal(err.usage?.inputTokens, 40, text)
    assert.equal(err.usage?.outputTokens, 7, text)
    assert.equal(err.finishReason, 'length', text)
  }
})

test('generateStructured: no text at all is the same failure, not a bare "no output" error', async () => {
  // A model cut off inside its reasoning returns no text part: `generateText` then has nothing
  // to parse and its `.output` throws an error that knows neither the usage nor the reason.
  const err = await failure(() =>
    generateStructured({ model: cutModel(undefined), schema: DecisionSchema, prompt: 'decide' }),
  )
  assert.equal(err.usage?.inputTokens, 40)
  assert.equal(err.usage?.outputTokens, 7)
  assert.equal(err.finishReason, 'length')
})

test('streamStructured: a cut-off or invalid plan fails with its usage and finish reason', async () => {
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: '0' })
          controller.enqueue({ type: 'text-delta', id: '0', delta: '{"thought":"half a pl' })
          controller.enqueue({ type: 'text-end', id: '0' })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'length' as const, raw: undefined },
            usage: v3Usage(30, 9),
          })
          controller.close()
        },
      }),
    }),
  })
  const result = streamStructured({ model, schema: PlanSchema, prompt: 'plan it' })
  for await (const _ of result.partialObjectStream) void _
  const err = await failure(() => result.final())
  assert.equal(err.usage?.inputTokens, 30)
  assert.equal(err.usage?.outputTokens, 9)
  assert.equal(err.finishReason, 'length')
})

test('streamStructured: a provider error is thrown as it is, status code and all', async () => {
  // Left to itself `streamText` prints the error to the console and rejects with a generic
  // NoOutputGeneratedError: the retry logic could no longer tell a 500 from a 401.
  const logged: unknown[] = []
  const original = console.error
  console.error = (...args: unknown[]) => void logged.push(args)
  try {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new APICallError({
          message: 'upstream is down',
          url: 'http://scripted',
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: false,
        })
      },
    })
    const result = streamStructured({ model, schema: PlanSchema, prompt: 'plan it' })
    for await (const _ of result.partialObjectStream) void _
    await assert.rejects(result.final(), (err: unknown) => {
      assert.ok(APICallError.isInstance(err))
      assert.equal(err.statusCode, 503)
      return true
    })
    assert.deepEqual(logged, [], 'nothing was printed to the console')
  } finally {
    console.error = original
  }
})
