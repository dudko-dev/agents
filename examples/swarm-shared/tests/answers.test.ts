// The answer to a parked item, by kind: what the gateway refuses with a 400 and the workflow drops.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ANSWER_LIMITS, answerProblem, isParkedKind } from '../src/answers.ts'

test('approval: { approved } with an optional reason; nothing else', () => {
  assert.equal(answerProblem('approval', { approved: true }), undefined)
  assert.equal(answerProblem('approval', { approved: false, reason: 'not now' }), undefined)
  for (const bad of [
    true,
    'yes',
    null,
    [],
    {},
    { approved: 'true' },
    { approved: 1 },
    { approved: true, reason: 3 },
    { approved: true, extra: 1 },
    { output: 'x' },
  ]) {
    assert.ok(answerProblem('approval', bad), JSON.stringify(bad))
  }
  // `remember` would hold on one worker only.
  assert.match(answerProblem('approval', { approved: true, remember: true })!, /remember/)
  assert.match(answerProblem('approval', { approved: true, remember: false })!, /remember/)
  assert.match(
    answerProblem('approval', {
      approved: false,
      reason: 'r'.repeat(ANSWER_LIMITS.reasonChars + 1),
    })!,
    /limited/,
  )
  assert.equal(
    answerProblem('approval', { approved: false, reason: 'r'.repeat(ANSWER_LIMITS.reasonChars) }),
    undefined,
  )
})

test("tool: { output: JSON } or { error: '...' }, exactly one of them", () => {
  for (const ok of [
    { output: 'text' },
    { output: { url: 'https://x', n: 1, list: [true, null] } },
    { output: null },
    { output: 0 },
    { error: 'render failed' },
  ]) {
    assert.equal(answerProblem('tool', ok), undefined, JSON.stringify(ok))
  }
  for (const bad of [
    {},
    { output: 'x', error: 'y' },
    { error: '' },
    { error: '   ' },
    { error: 3 },
    { approved: true },
    { result: 'x' },
    'x',
  ]) {
    assert.ok(answerProblem('tool', bad), JSON.stringify(bad))
  }
  assert.match(
    answerProblem('tool', { error: 'e'.repeat(ANSWER_LIMITS.errorChars + 1) })!,
    /limited/,
  )
  assert.equal(answerProblem('tool', { error: 'e'.repeat(ANSWER_LIMITS.errorChars) }), undefined)
  assert.match(answerProblem('tool', { output: Number.POSITIVE_INFINITY })!, /not finite/)
  let deep: unknown = 'leaf'
  for (let i = 0; i < ANSWER_LIMITS.outputDepth + 1; i++) deep = [deep]
  assert.match(answerProblem('tool', { output: deep })!, /nested deeper/)
  let fits: unknown = 'leaf'
  for (let i = 0; i < ANSWER_LIMITS.outputDepth; i++) fits = [fits]
  assert.equal(answerProblem('tool', { output: fits }), undefined)
  assert.match(
    answerProblem('tool', { output: 'x'.repeat(ANSWER_LIMITS.outputChars) })!,
    /limited to/,
  )
  assert.match(answerProblem('tool', { output: new Date(0) })!, /not plain JSON/)
})

test('isParkedKind', () => {
  assert.equal(isParkedKind('approval'), true)
  assert.equal(isParkedKind('tool'), true)
  assert.equal(isParkedKind('tool-approval'), false)
})
