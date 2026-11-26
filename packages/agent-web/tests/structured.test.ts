import assert from 'node:assert/strict'
import test from 'node:test'
import { NoObjectGeneratedError } from 'ai'
import { z } from 'zod'
import { generateStructured } from '../dist/index.js'
import { scriptedModel, type Reply } from './helpers/scripted-model.ts'

// `generateStructured` is `generateText` with `Output.object` - the AI SDK v7 replacement for the
// deprecated `generateObject`. What the old call guaranteed is pinned here: the request asks for
// a JSON response format carrying the schema, and an answer that is not the object fails with a
// NoObjectGeneratedError that carries the usage and the finish reason of the attempt (the agent
// counts that spend, and names the output cap when it was the cause).

const Schema = z.object({ decision: z.enum(['continue', 'finish']), reason: z.string() })

const model = (reply: Reply) => scriptedModel(() => reply)

test('generateStructured returns the validated object and the usage', async () => {
  const m = model({ text: JSON.stringify({ decision: 'finish', reason: 'done' }) })
  const r = await generateStructured(m.model, Schema, { prompt: 'decide', maxOutputTokens: 33 })
  assert.deepEqual(r.object, { decision: 'finish', reason: 'done' })
  assert.equal(r.usage.inputTokens, 10)
  assert.equal(r.usage.outputTokens, 5)
  assert.equal(r.finishReason, 'stop')

  const { options } = m.calls[0]
  const format = options.responseFormat as { type: string; schema?: unknown }
  assert.equal(format.type, 'json', 'a JSON response format')
  assert.ok(format.schema, 'carrying the schema')
  assert.equal(options.tools, undefined, 'not a tool-based JSON mode')
  assert.equal(options.maxOutputTokens, 33)
})

const failure = async (reply: Reply): Promise<NoObjectGeneratedError> => {
  try {
    await generateStructured(model(reply).model, Schema, { prompt: 'decide' })
  } catch (err) {
    assert.ok(NoObjectGeneratedError.isInstance(err), `a NoObjectGeneratedError, got ${err}`)
    return err
  }
  throw new Error('expected the call to fail')
}

test('an answer that is not the object fails with its usage and finish reason', async () => {
  const usage = { input: 40, output: 7 }
  for (const text of ['prose', '{"decision":"maybe","reason":"x"}', '{"decision":"cont']) {
    const err = await failure({ text, usage, cutOff: true })
    assert.equal(err.usage?.inputTokens, 40, text)
    assert.equal(err.usage?.outputTokens, 7, text)
    assert.equal(err.finishReason, 'length', text)
  }
})

test('no text at all is the same failure, not a bare "no output" error', async () => {
  // A model cut off inside its reasoning returns no text part: `generateText` then has nothing
  // to parse, and its `.output` throws an error that knows neither the usage nor the reason.
  const err = await failure({
    reasoning: 'thinking…',
    usage: { input: 40, output: 7 },
    cutOff: true,
  })
  assert.equal(err.usage?.inputTokens, 40)
  assert.equal(err.usage?.outputTokens, 7)
  assert.equal(err.finishReason, 'length')
})
