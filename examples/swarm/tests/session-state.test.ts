// The session workflow's logic, without Temporal: the inbox, a turn's life, stop, parking,
// the history cap and continue-as-new.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  acceptAnswer,
  acceptMessage,
  acceptStop,
  ANSWERS_KEPT,
  capHistory,
  carry,
  finishTurn,
  hasWork,
  initialState,
  SEEN_KEPT,
  shouldContinueAsNew,
  takeTurn,
  TURNS_KEPT,
  view,
} from '../src/session-state.ts'
import type { ISessionOptions } from '../src/session-types.ts'

const options = (extra: Partial<ISessionOptions> = {}): ISessionOptions => ({
  idleTimeoutMs: 0,
  turnTimeoutMs: 60_000,
  heartbeatTimeoutMs: 10_000,
  maxTurnAttempts: 3,
  maxTurnsPerRun: 3,
  historyMaxChars: 10_000,
  maxQueuedMessages: 3,
  ...extra,
})
const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
const msg = (id: string, text = id) => ({ id, text, at: 1 })

test('messages queue, repeats are dropped, a full queue drops and counts', () => {
  const s = initialState('s', options())
  assert.equal(acceptMessage(s, msg('a')), 'queued')
  assert.equal(acceptMessage(s, msg('a')), 'duplicate')
  assert.equal(acceptMessage(s, msg('b')), 'queued')
  assert.equal(acceptMessage(s, msg('c')), 'queued')
  assert.equal(acceptMessage(s, msg('d')), 'full')
  assert.equal(s.dropped, 1)
  assert.deepEqual(
    view(s).queued.map((q) => q.id),
    ['a', 'b', 'c'],
  )
  // A dropped message was not seen: sent again once there is room, it is taken.
  takeTurn(s, 0)
  assert.equal(acceptMessage(s, msg('d')), 'queued')
})

test('the dedupe memory is bounded', () => {
  const s = initialState('s', options({ maxQueuedMessages: 1000 }))
  for (let i = 0; i < SEEN_KEPT + 10; i++) {
    acceptMessage(s, msg(`m${i}`))
    s.inbox = []
  }
  assert.equal(s.seen.length, SEEN_KEPT)
  assert.equal(acceptMessage(s, msg('m0')), 'queued', 'the oldest ids are forgotten')
})

test('a turn takes every queued message, in order, and runs alone', () => {
  const s = initialState('s', options())
  acceptMessage(s, msg('a', 'first'))
  acceptMessage(s, msg('b', 'second'))
  assert.equal(hasWork(s), true)
  const t = takeTurn(s, 100)!
  assert.equal(t.turn, 1)
  assert.equal(t.input, 'first\n\nsecond')
  assert.deepEqual(t.messageIds, ['a', 'b'])
  assert.deepEqual(t.history, [])
  assert.equal(view(s).status, 'running')
  // While it runs, nothing else starts.
  acceptMessage(s, msg('c'))
  assert.equal(hasWork(s), false)
  assert.equal(takeTurn(s, 101), undefined)
  finishTurn(s, t, { status: 'completed', runId: 'r1', attempt: 2, text: 'answer', usage }, 200)
  assert.deepEqual(s.history, [
    { role: 'user', content: 'first\n\nsecond' },
    { role: 'assistant', content: 'answer' },
  ])
  assert.deepEqual(s.turns[0], {
    turn: 1,
    status: 'completed',
    messageIds: ['a', 'b'],
    startedAt: 100,
    endedAt: 200,
    runId: 'r1',
    attempt: 2,
    text: 'answer',
    usage,
  })
  assert.deepEqual(s.endings, [
    {
      sessionId: 's',
      turn: 1,
      status: 'completed',
      runId: 'r1',
      attempt: 2,
      text: 'answer',
      usage,
    },
  ])
  // The marker first, then the next turn.
  assert.equal(hasWork(s), true)
  const next = takeTurn(s, 300)!
  assert.equal(next.turn, 2)
  assert.equal(next.history.length, 2)
})

test('the run compacted the history: its copy replaces the workflow one', () => {
  const s = initialState('s', options())
  s.history = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old answer' },
  ]
  acceptMessage(s, msg('a', 'new'))
  const t = takeTurn(s, 0)!
  const compactedHistory = [{ role: 'assistant' as const, content: 'summary' }]
  finishTurn(
    s,
    t,
    { status: 'completed', runId: 'r', attempt: 1, text: 'ok', usage, compactedHistory },
    1,
  )
  assert.deepEqual(s.history, [
    { role: 'assistant', content: 'summary' },
    { role: 'user', content: 'new' },
    { role: 'assistant', content: 'ok' },
  ])
})

test('a stopped or failed turn adds nothing to the history and is recorded', () => {
  const s = initialState('s', options())
  acceptMessage(s, msg('a'))
  const t1 = takeTurn(s, 0)!
  finishTurn(s, t1, { status: 'stopped', runId: 'r1' }, 1)
  acceptMessage(s, msg('b'))
  const t2 = takeTurn(s, 2)!
  finishTurn(s, t2, { status: 'failed', error: 'boom' }, 3)
  assert.deepEqual(s.history, [])
  assert.deepEqual(
    s.turns.map((t) => [t.turn, t.status, t.error]),
    [
      [1, 'stopped', undefined],
      [2, 'failed', 'boom'],
    ],
  )
  assert.deepEqual(
    s.endings.map((e) => e.status),
    ['stopped', 'failed'],
  )
})

test('stop: cancels the running turn, drops the queue; end ends the session', () => {
  const s = initialState('s', options())
  acceptMessage(s, msg('a'))
  takeTurn(s, 0)
  acceptMessage(s, msg('b'))
  acceptStop(s, { at: 1 }, 1)
  assert.equal(s.stopping, true)
  assert.equal(view(s).status, 'stopping')
  assert.deepEqual(s.inbox, [])
  assert.equal(s.ending, false)

  const idle = initialState('t', options())
  acceptMessage(idle, msg('x'))
  acceptStop(idle, { at: 1, end: true }, 1)
  assert.equal(idle.stopping, false, 'nothing ran')
  assert.equal(idle.ending, true)
  assert.equal(acceptMessage(idle, msg('y')), 'ended')
  assert.equal(view(idle, true).status, 'ended')
})

test('parking: the turn waits for every answer, then goes on as the same turn', () => {
  const s = initialState('s', options())
  acceptMessage(s, msg('a', 'do it'))
  const t = takeTurn(s, 0)!
  const requests = [
    { requestId: 'q1', kind: 'tool-approval', question: { tool: 'x' } },
    { requestId: 'q2', kind: 'tool-approval', question: { tool: 'y' } },
  ]
  finishTurn(s, t, { status: 'parked', runId: 'r1', attempt: 1, requests }, 1)
  assert.equal(view(s).status, 'parked')
  assert.deepEqual(s.endings, [], 'a parked turn is not over')
  // New messages wait behind the parked turn.
  acceptMessage(s, msg('b'))
  assert.equal(hasWork(s), false)
  acceptAnswer(s, { requestId: 'q1', value: { allow: true }, at: 2 })
  assert.equal(hasWork(s), false)
  assert.deepEqual(view(s).parked?.answered, ['q1'])
  acceptAnswer(s, { requestId: 'q2', value: { allow: false }, at: 3 })
  assert.equal(hasWork(s), true)
  const resumed = takeTurn(s, 4)!
  assert.equal(resumed.turn, 1)
  assert.equal(resumed.input, 'do it')
  assert.deepEqual(Object.keys(resumed.answers ?? {}).sort(), ['q1', 'q2'])
  assert.deepEqual(s.answers, {}, 'the answers were handed over')
  assert.equal(s.turn, 1, 'no new turn number')
  finishTurn(s, resumed, { status: 'completed', runId: 'r1', attempt: 2, text: 'done', usage }, 5)
  assert.equal(takeTurn(s, 6)?.input, 'b')
})

test('stop while parked: the parked turn ends as stopped', () => {
  const s = initialState('s', options())
  acceptMessage(s, msg('a'))
  const t = takeTurn(s, 0)!
  finishTurn(
    s,
    t,
    {
      status: 'parked',
      runId: 'r1',
      attempt: 1,
      requests: [{ requestId: 'q', kind: 'k', question: 1 }],
    },
    1,
  )
  acceptStop(s, { at: 2 }, 2)
  assert.equal(s.parked, undefined)
  assert.equal(s.turns[0]?.status, 'stopped')
  assert.deepEqual(s.endings, [{ sessionId: 's', turn: 1, status: 'stopped', runId: 'r1' }])
})

test('answers nobody asked for are bounded', () => {
  const s = initialState('s', options())
  for (let i = 0; i < ANSWERS_KEPT + 20; i++) {
    acceptAnswer(s, { requestId: `x${i}`, value: i, at: i })
  }
  assert.equal(Object.keys(s.answers).length, ANSWERS_KEPT)
  assert.ok(s.answers[`x${ANSWERS_KEPT + 19}`], 'the newest are kept')
})

test('capHistory drops the oldest exchanges first and keeps the last one whole', () => {
  const h = [
    { role: 'user' as const, content: 'a'.repeat(50) },
    { role: 'assistant' as const, content: 'b'.repeat(50) },
    { role: 'user' as const, content: 'c'.repeat(50) },
    { role: 'assistant' as const, content: 'd'.repeat(50) },
  ]
  assert.deepEqual(capHistory(h, 1000), h)
  const capped = capHistory(h, 120)
  assert.deepEqual(
    capped.map((t) => t.content[0]),
    ['c', 'd'],
  )
  assert.equal(capHistory(h, 10).length, 2, 'never below the last exchange')
  // Never starts with an orphan answer.
  const odd = [{ role: 'assistant' as const, content: 'x'.repeat(100) }, ...h]
  assert.equal(capHistory(odd, 220)[0]?.role, 'user')
})

test('the record keeps the last turns only', () => {
  const s = initialState('s', options({ maxQueuedMessages: 1000 }))
  for (let i = 0; i < TURNS_KEPT + 5; i++) {
    acceptMessage(s, msg(`m${i}`))
    const t = takeTurn(s, i)!
    finishTurn(s, t, { status: 'failed', error: 'x' }, i)
  }
  assert.equal(s.turns.length, TURNS_KEPT)
  assert.equal(s.turns[0]?.turn, 6)
})

test('continue-as-new: only at a quiet point, after maxTurnsPerRun or when suggested', () => {
  const s = initialState('s', options({ maxTurnsPerRun: 2 }))
  assert.equal(shouldContinueAsNew(s, false), false)
  assert.equal(shouldContinueAsNew(s, true), true)
  acceptMessage(s, msg('a'))
  const t = takeTurn(s, 0)!
  assert.equal(shouldContinueAsNew(s, true), false, 'not while a turn runs')
  finishTurn(s, t, { status: 'completed', runId: 'r', attempt: 1, text: 'x', usage }, 1)
  assert.equal(shouldContinueAsNew(s, true), false, 'not before the marker is written')
  s.endings = []
  acceptMessage(s, msg('b'))
  finishTurn(
    s,
    takeTurn(s, 2)!,
    { status: 'completed', runId: 'r2', attempt: 1, text: 'y', usage },
    3,
  )
  s.endings = []
  assert.equal(shouldContinueAsNew(s, false), true, 'two turns this run')

  // The carry restores everything but the per-run counter.
  acceptMessage(s, msg('c'))
  const next = initialState('s', options(), carry(s))
  assert.equal(next.turn, 2)
  assert.equal(next.turnsThisRun, 0)
  assert.deepEqual(next.history, s.history)
  assert.deepEqual(next.inbox, s.inbox)
  assert.equal(acceptMessage(next, msg('a')), 'duplicate', 'the dedupe memory is carried')
  assert.deepEqual(view(next).turns, view(s).turns)
})
