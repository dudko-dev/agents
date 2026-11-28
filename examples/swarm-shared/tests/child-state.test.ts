// A child workflow's wait for a person, without Temporal: which answers it takes (the workflow
// checks every one by its kind - the authority, whatever the gateway did), a partial answer keeps
// it waiting, a re-park waits again, a closed child takes nothing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  acceptChildAnswer,
  CHILD_ANSWERS_KEPT,
  childParked,
  childReady,
  childView,
  closeChildWait,
  initialChildWait,
  takeChildAnswers,
} from '../src/child-state.ts'
import type { IChildParked, IParkedRequest } from '../src/session-types.ts'

const approval = (id: string): IParkedRequest => ({
  requestId: id,
  kind: 'approval',
  question: { request: { id, toolName: 'write_note', input: { text: id }, readOnly: false } },
})
const external = (id: string): IParkedRequest => ({
  requestId: id,
  kind: 'tool',
  question: { toolName: 'render', input: {}, note: 'from outside' },
})
const parkedOf = (requests: IParkedRequest[], runId = 'c1'): IChildParked => ({
  status: 'parked',
  runId,
  attempt: 1,
  requests,
})
const client = (requestId: string, value: unknown) => ({
  requestId,
  value,
  at: 2,
  by: 'client' as const,
})

test('a waiting child takes an answer to one of its items, in the shape of its kind - nothing else', () => {
  const w = initialChildWait()
  childParked(w, parkedOf([approval('a'), external('t')]), 1)
  assert.equal(acceptChildAnswer(w, client('nope', { approved: true })), 'refused', 'not its item')
  assert.equal(acceptChildAnswer(w, client('a', { output: 'x' })), 'refused', 'the wrong kind')
  assert.equal(acceptChildAnswer(w, client('a', { approved: 'yes' })), 'refused', 'not an answer')
  assert.equal(acceptChildAnswer(w, client('a', { approved: true, remember: true })), 'refused')
  assert.equal(acceptChildAnswer(w, client('t', { approved: true })), 'refused')
  assert.equal(acceptChildAnswer(w, client('t', 'a string')), 'refused')
  assert.equal(
    acceptChildAnswer(w, { requestId: 'a', value: { approved: true }, at: 2, by: 'subagent' }),
    'refused',
    'a child item is a client answer',
  )
  assert.deepEqual(w.answers, {})
  assert.equal(childReady(w), false)
  assert.equal(acceptChildAnswer(w, client('a', { approved: false, reason: 'no' })), 'accepted')
  assert.equal(acceptChildAnswer(w, client('t', { error: 'render failed' })), 'accepted')
  assert.deepEqual(Object.keys(w.answers).sort(), ['a', 't'])
})

test('a partial answer keeps the child waiting; every item answered, it goes on with exactly those', () => {
  const w = initialChildWait()
  childParked(w, parkedOf([approval('a'), approval('b')]), 1)
  assert.deepEqual(childView(w), {
    status: 'waiting',
    parks: 1,
    parked: { runId: 'c1', requests: [approval('a'), approval('b')], answered: [] },
  })
  acceptChildAnswer(w, client('a', { approved: true }))
  assert.equal(childReady(w), false, 'one of two: still waiting')
  assert.deepEqual(childView(w).parked?.answered, ['a'])
  acceptChildAnswer(w, client('b', { approved: false }))
  assert.equal(childReady(w), true)
  const answers = takeChildAnswers(w)
  assert.deepEqual(Object.keys(answers).sort(), ['a', 'b'])
  assert.deepEqual(answers.b?.value, { approved: false })
  assert.equal(childView(w).status, 'running', 'the resume runs')
  assert.deepEqual(w.answers, {})
})

test('a resume that parks again waits again, for the new items only', () => {
  const w = initialChildWait()
  childParked(w, parkedOf([approval('a')]), 1)
  acceptChildAnswer(w, client('a', { approved: true }))
  takeChildAnswers(w)
  // A late repeat of the answer to the old item while it runs: kept as early, dropped at the park.
  assert.equal(acceptChildAnswer(w, client('a', { approved: false })), 'early')
  childParked(w, parkedOf([approval('c')]), 5)
  assert.equal(w.parks, 2)
  assert.deepEqual(w.answers, {}, 'nothing of the old park survives')
  assert.equal(acceptChildAnswer(w, client('a', { approved: true })), 'refused', 'no longer open')
  assert.equal(childReady(w), false)
  acceptChildAnswer(w, client('c', { approved: true }))
  assert.equal(childReady(w), true)
})

test('an answer that came before the park is kept only if it fits its item; early answers are bounded', () => {
  const w = initialChildWait()
  assert.equal(acceptChildAnswer(w, client('a', { approved: true })), 'early')
  assert.equal(acceptChildAnswer(w, client('b', { output: 'wrong kind' })), 'early')
  assert.equal(acceptChildAnswer(w, client('z', { approved: true })), 'early')
  assert.equal(
    acceptChildAnswer(w, { requestId: 'a', value: { approved: true }, at: 1, by: 'pipeline' }),
    'refused',
  )
  childParked(w, parkedOf([approval('a'), approval('b')]), 2)
  assert.deepEqual(Object.keys(w.answers), ['a'], 'b had the wrong shape, z is not an item')
  assert.equal(childReady(w), false)

  const many = initialChildWait()
  for (let i = 0; i < CHILD_ANSWERS_KEPT + 10; i++) {
    acceptChildAnswer(many, client(`x${i}`, { approved: true }))
  }
  assert.equal(Object.keys(many.answers).length, CHILD_ANSWERS_KEPT)
  assert.equal(many.answers.x0, undefined, 'the oldest go first')
})

test('a closed child (ended, stopped) takes no answer and is never ready', () => {
  const w = initialChildWait()
  childParked(w, parkedOf([approval('a')]), 1)
  closeChildWait(w)
  assert.equal(acceptChildAnswer(w, client('a', { approved: true })), 'refused')
  assert.equal(childReady(w), false)
  assert.deepEqual(childView(w), { status: 'ended', parks: 1 })
  // Even with an answer somehow on record, a closed wait does not go on.
  const v = initialChildWait()
  childParked(v, parkedOf([approval('a')]), 1)
  acceptChildAnswer(v, client('a', { approved: true }))
  v.closed = true
  assert.equal(childReady(v), false)
})
