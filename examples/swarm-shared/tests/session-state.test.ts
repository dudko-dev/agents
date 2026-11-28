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
  childFinished,
  childPark,
  childrenRunning,
  finishTurn,
  hasWork,
  initialState,
  PIPELINE_DEFAULTS,
  pipelineAnswerOf,
  pipelineFinished,
  SEEN_KEPT,
  shouldContinueAsNew,
  startChildren,
  SUBAGENT_DEFAULTS,
  SUBAGENT_MARKER_SEQ,
  SUBAGENT_MARKER_SPAN,
  takeTurn,
  TURNS_KEPT,
  view,
} from '../src/session-state.ts'
import {
  pipelineNodeWorkflowIdOf,
  pipelineStreamOf,
  pipelineWorkflowIdOf,
  subagentStreamOf,
  subagentWorkflowIdOf,
} from '../src/session-ids.ts'
import type { IChildParkNotice, IParkedRequest, ISessionOptions } from '../src/session-types.ts'

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
    { requestId: 'q1', kind: 'approval' as const, question: { toolName: 'x' } },
    { requestId: 'q2', kind: 'approval' as const, question: { toolName: 'y' } },
  ]
  finishTurn(s, t, { status: 'parked', runId: 'r1', attempt: 1, requests }, 1)
  assert.equal(view(s).status, 'parked')
  assert.deepEqual(s.endings, [], 'a parked turn is not over')
  // New messages wait behind the parked turn.
  acceptMessage(s, msg('b'))
  assert.equal(hasWork(s), false)
  assert.equal(acceptAnswer(s, { requestId: 'q1', value: { approved: true }, at: 2 }), 'accepted')
  assert.equal(hasWork(s), false)
  assert.deepEqual(view(s).parked?.answered, ['q1'])
  acceptAnswer(s, { requestId: 'q2', value: { approved: false }, at: 3 })
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
      requests: [{ requestId: 'q', kind: 'approval', question: 1 }],
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

// --- answers, subagents and their children ------------------------------------------------------

const approval = (id: string): IParkedRequest => ({
  requestId: id,
  kind: 'approval',
  question: { request: { toolName: 'write_note' } },
})
const external = (id: string): IParkedRequest => ({
  requestId: id,
  kind: 'tool',
  question: { toolName: 'render' },
})
const sub = (id: string, task = id): IParkedRequest => ({
  requestId: id,
  kind: 'tool',
  question: { toolName: 'researcher' },
  subagent: { name: 'researcher', task },
})
const park = (
  s: ReturnType<typeof initialState>,
  requests: IParkedRequest[],
  turnAttempt: number | null = 1,
) => {
  if (!s.running) {
    acceptMessage(s, msg(`m${s.turn + 1}`))
  }
  const t = takeTurn(s, 0)!
  finishTurn(
    s,
    t,
    {
      status: 'parked',
      runId: 'r1',
      attempt: 1,
      ...(turnAttempt !== null ? { turnAttempt } : {}),
      requests,
    },
    1,
  )
  return t
}

test('answers: while parked, only a pending request, in the shape of its kind', () => {
  const s = initialState('s', options())
  park(s, [approval('a'), external('t'), sub('k')])
  const client = (requestId: string, value: unknown) =>
    acceptAnswer(s, { requestId, value, at: 2, by: 'client' })
  assert.equal(client('nope', { approved: true }), 'refused', 'not something the turn waits for')
  assert.equal(client('a', { output: 'x' }), 'refused', 'the wrong kind')
  assert.equal(client('a', { approved: true, remember: true }), 'refused')
  assert.equal(client('t', { approved: true }), 'refused')
  assert.equal(client('k', { output: 'mine' }), 'refused', 'a subagent answers it')
  assert.equal(acceptAnswer(s, { requestId: 'k', value: { output: 'x' }, at: 2 }), 'refused')
  assert.deepEqual(s.answers, {})
  assert.equal(client('a', { approved: false, reason: 'no' }), 'accepted')
  assert.equal(client('t', { error: 'render failed' }), 'accepted')
  assert.deepEqual(Object.keys(s.answers).sort(), ['a', 't'])
})

test('answers: one that came before the park is kept only if it fits its request', () => {
  const s = initialState('s', options())
  acceptMessage(s, msg('m1'))
  const t = takeTurn(s, 0)!
  for (const [id, value] of [
    ['a', { approved: true }],
    ['b', { output: 'wrong kind' }],
    ['k', { output: 'not yours' }],
  ] as const) {
    assert.equal(acceptAnswer(s, { requestId: id, value, at: 1, by: 'client' }), 'early')
  }
  assert.equal(
    acceptAnswer(s, { requestId: 'k', value: { output: 'x' }, at: 1, by: 'subagent' }),
    'refused',
    'no child answers before its park',
  )
  finishTurn(
    s,
    t,
    {
      status: 'parked',
      runId: 'r1',
      attempt: 1,
      requests: [approval('a'), approval('b'), sub('k')],
    },
    2,
  )
  assert.deepEqual(Object.keys(s.answers), ['a'])
})

test('children: one per subagent request, ids from session + run + item, markers in order', () => {
  const s = initialState('s', options())
  park(s, [sub('k1', 'one'), approval('a'), sub('k2', 'two')], 3)
  const starts = startChildren(s, 5)
  assert.deepEqual(
    starts.map((c) => [c.requestId, c.workflowId, c.input.stream, c.input.task]),
    [
      ['k1', subagentWorkflowIdOf('s', 'r1', 'k1'), subagentStreamOf('s', 'k1'), 'one'],
      ['k2', subagentWorkflowIdOf('s', 'r1', 'k2'), subagentStreamOf('s', 'k2'), 'two'],
    ],
  )
  assert.equal(starts[0]!.input.options.maxTurnAttempts, 3)
  assert.equal(s.subagentsStarted, 2)
  assert.equal(childrenRunning(s), true)
  assert.deepEqual(startChildren(s, 6), [], 'a second call starts nothing again')
  assert.deepEqual(
    s.markers.map((m) => [m.type, m.turnAttempt, m.seq, m.body.itemId]),
    [
      ['subagent.started', 3, SUBAGENT_MARKER_SEQ, 'k1'],
      ['subagent.started', 3, SUBAGENT_MARKER_SEQ + 1, 'k2'],
    ],
  )
  assert.equal(s.markers[0]!.body.events, '/sessions/s/subagents/k1/events')
  s.markers = []
  // The second ends first: its marker comes first, and it answers its item.
  assert.equal(childFinished(s, 'k2', { status: 'failed', error: 'boom' }, 7), true)
  assert.deepEqual(s.answers.k2?.value, { error: 'the subagent failed: boom' })
  assert.equal(s.answers.k2?.by, 'subagent')
  assert.equal(childFinished(s, 'k2', { status: 'failed', error: 'again' }, 8), false, 'once')
  assert.equal(childFinished(s, 'a', { status: 'failed', error: 'x' }, 8), false, 'not a child')
  childFinished(
    s,
    'k1',
    { status: 'completed', runId: 'c1', attempt: 1, text: 'found it', usage },
    9,
  )
  assert.deepEqual(s.answers.k1?.value, { output: 'found it' })
  assert.deepEqual(
    s.markers.map((m) => [m.type, m.seq, m.body.itemId, m.body.status]),
    [
      ['subagent.ended', SUBAGENT_MARKER_SEQ + SUBAGENT_MARKER_SPAN, 'k2', 'failed'],
      ['subagent.ended', SUBAGENT_MARKER_SEQ + SUBAGENT_MARKER_SPAN + 1, 'k1', 'completed'],
    ],
  )
  assert.equal(childrenRunning(s), false)
  // The person's answer is the last one: then the turn goes on with all three.
  assert.equal(parkedReadyAfter(s, 'a'), true)
  const resumed = takeTurn(s, 10)!
  assert.deepEqual(Object.keys(resumed.answers!).sort(), ['a', 'k1', 'k2'])
  assert.deepEqual(resumed.subagents, {
    maxPerRound: SUBAGENT_DEFAULTS.maxPerRound,
    remaining: SUBAGENT_DEFAULTS.maxPerSession - 2,
  })
})

const parkedReadyAfter = (s: ReturnType<typeof initialState>, id: string): boolean => {
  acceptAnswer(s, { requestId: id, value: { approved: true }, at: 9, by: 'client' })
  s.markers = []
  return hasWork(s)
}

test('children: a stopped child answers with an error; a stop of the park drops late results', () => {
  const s = initialState('s', options())
  park(s, [sub('k1')])
  startChildren(s, 1)
  childFinished(s, 'k1', { status: 'stopped' }, 2)
  assert.match(String((s.answers.k1?.value as { error: string }).error), /stopped/)

  const t = initialState('t', options())
  park(t, [sub('k1')])
  startChildren(t, 1)
  acceptStop(t, { at: 2 }, 2)
  assert.equal(t.parked, undefined)
  assert.equal(
    childFinished(t, 'k1', { status: 'completed', runId: 'c', attempt: 1, text: 'late', usage }, 3),
    false,
  )
  assert.deepEqual(t.answers, {})
})

test('children: the caps per round and per session refuse with a tool error, never a child', () => {
  const s = initialState('s', options({ subagentMaxPerRound: 2, subagentMaxPerSession: 3 }))
  park(s, [sub('a'), sub('b'), sub('c')])
  const first = startChildren(s, 1)
  assert.deepEqual(
    first.map((c) => c.requestId),
    ['a', 'b'],
  )
  assert.match(
    String((s.answers.c?.value as { error: string }).error),
    /at most 2 subagent calls in one round/,
  )
  assert.equal(s.subagentsStarted, 2)
  // The next park: one left in the session.
  for (const id of ['a', 'b']) {
    childFinished(s, id, { status: 'completed', runId: id, attempt: 1, text: id, usage }, 2)
  }
  const resumed = takeTurn(s, 3)!
  assert.deepEqual(resumed.subagents, { maxPerRound: 2, remaining: 1 })
  finishTurn(
    s,
    resumed,
    { status: 'parked', runId: 'r1', attempt: 2, turnAttempt: 2, requests: [sub('d'), sub('e')] },
    4,
  )
  assert.deepEqual(
    startChildren(s, 5).map((c) => c.requestId),
    ['d'],
  )
  assert.match(
    String((s.answers.e?.value as { error: string }).error),
    /at most 3 subagent calls in one session/,
  )
  assert.equal(view(s).subagentsStarted, 3)
})

test('children: no markers without the parked slot; continue-as-new waits for running children', () => {
  const s = initialState('s', options({ maxTurnsPerRun: 1 }))
  park(s, [sub('k')], null)
  startChildren(s, 1)
  assert.equal(s.markers.length, 0, 'no slot, no marker')
  assert.equal(shouldContinueAsNew(s, true), false, 'a child runs')
  childFinished(s, 'k', { status: 'completed', runId: 'c', attempt: 1, text: 'x', usage }, 2)
  assert.equal(shouldContinueAsNew(s, true), true)
  s.markers.push({
    sessionId: 's',
    turn: 1,
    turnAttempt: 1,
    seq: 1,
    type: 'subagent.ended',
    body: {},
  })
  assert.equal(shouldContinueAsNew(s, true), false, 'markers are written first')
  assert.equal(hasWork(s), true, 'a marker is work')
  // What continue-as-new carries keeps the count and the queued markers.
  const next = initialState('s', options(), carry(s))
  assert.equal(next.subagentsStarted, 1)
  assert.equal(next.markers.length, 1)
})

test('a session started before subagents existed gets the defaults', () => {
  const s = initialState('s', options())
  acceptMessage(s, msg('m'))
  assert.deepEqual(takeTurn(s, 0)?.subagents, {
    maxPerRound: SUBAGENT_DEFAULTS.maxPerRound,
    remaining: SUBAGENT_DEFAULTS.maxPerSession,
  })
  const old = initialState('s', options(), {
    ...carry(s),
    markers: undefined,
    subagentsStarted: undefined,
  } as never)
  assert.deepEqual(old.markers, [])
  assert.equal(old.subagentsStarted, 0)
})

test('a child workflow id is a function of session, run and item - nothing else', () => {
  const id = subagentWorkflowIdOf('s1', 'run-1', 'p_abc')
  assert.equal(id, 'subagent-s1-run-1-p_abc')
  assert.equal(subagentWorkflowIdOf('s1', 'run-1', 'p_abc'), id, 'the same call, the same child')
  assert.notEqual(subagentWorkflowIdOf('s2', 'run-1', 'p_abc'), id)
  assert.notEqual(subagentWorkflowIdOf('s1', 'run-2', 'p_abc'), id)
  assert.notEqual(subagentWorkflowIdOf('s1', 'run-1', 'p_abd'), id)
  assert.equal(subagentStreamOf('s1', 'p_abc'), 's1/p_abc')
  // The same park seen twice (a replay, a retried start) names the same children.
  const ids = () => {
    const s = initialState('s', options())
    park(s, [sub('k1'), sub('k2')])
    return startChildren(s, 1).map((c) => c.workflowId)
  }
  assert.deepEqual(ids(), ids())
})

// --- pipelines ----------------------------------------------------------------------------------

const pipe = (id: string, task = id, name = 'review'): IParkedRequest => ({
  requestId: id,
  kind: 'tool',
  question: { toolName: name },
  pipeline: { name, task },
})

test('pipelines: one child per call, ids from session + run + item, in one order with subagents', () => {
  const s = initialState('s', options())
  park(s, [sub('k1', 'dig'), pipe('p1', 'check it'), approval('a'), pipe('p2', 'again')], 3)
  const starts = startChildren(s, 5)
  assert.deepEqual(
    starts.map((c) => [c.kind, c.requestId, c.workflowId, c.input.stream, c.input.task]),
    [
      ['subagent', 'k1', subagentWorkflowIdOf('s', 'r1', 'k1'), subagentStreamOf('s', 'k1'), 'dig'],
      [
        'pipeline',
        'p1',
        pipelineWorkflowIdOf('s', 'r1', 'p1'),
        pipelineStreamOf('s', 'p1'),
        'check it',
      ],
      [
        'pipeline',
        'p2',
        pipelineWorkflowIdOf('s', 'r1', 'p2'),
        pipelineStreamOf('s', 'p2'),
        'again',
      ],
    ],
  )
  const p1 = starts[1]!
  assert.ok(p1.kind === 'pipeline')
  if (p1.kind === 'pipeline') {
    assert.equal(p1.input.workflowId, p1.workflowId, 'it names its node children from its own id')
    assert.equal(p1.input.name, 'review')
    assert.equal(p1.input.parentRunId, 'r1')
    assert.equal(p1.input.options.maxTurnAttempts, 3)
  }
  assert.equal(s.subagentsStarted, 1)
  assert.equal(s.pipelinesStarted, 2)
  assert.equal(childrenRunning(s), true)
  assert.deepEqual(startChildren(s, 6), [], 'a second call starts nothing again')
  // The started markers: one counter for both kinds, in start order.
  assert.deepEqual(
    s.markers.map((m) => [m.type, m.turnAttempt, m.seq, m.body.itemId]),
    [
      ['subagent.started', 3, SUBAGENT_MARKER_SEQ, 'k1'],
      ['pipeline.call.started', 3, SUBAGENT_MARKER_SEQ + 1, 'p1'],
      ['pipeline.call.started', 3, SUBAGENT_MARKER_SEQ + 2, 'p2'],
    ],
  )
  assert.deepEqual(s.markers[1]!.body, {
    itemId: 'p1',
    name: 'review',
    task: 'check it',
    workflowId: pipelineWorkflowIdOf('s', 'r1', 'p1'),
    events: '/sessions/s/pipelines/p1/events',
  })
  s.markers = []
  // The ends, in the order the children end, whatever their kind; each answers its own item.
  assert.equal(
    pipelineFinished(
      s,
      'p2',
      {
        status: 'failed',
        error: 'Pipeline node "b" failed (visit 1): boom',
        runs: 2,
        usage,
        nodeId: 'b',
        visit: 1,
      },
      7,
    ),
    true,
  )
  assert.deepEqual(s.answers.p2, {
    requestId: 'p2',
    value: { error: 'pipeline "review" failed: Pipeline node "b" failed (visit 1): boom' },
    at: 7,
    by: 'pipeline',
  })
  assert.equal(pipelineFinished(s, 'p2', { status: 'stopped', runs: 0, usage }, 8), false, 'once')
  assert.equal(
    pipelineFinished(s, 'k1', { status: 'stopped', runs: 0, usage }, 8),
    false,
    'a subagent',
  )
  assert.equal(
    childFinished(s, 'p1', { status: 'failed', error: 'x' }, 8),
    false,
    'a pipeline is not a subagent child',
  )
  childFinished(s, 'k1', { status: 'completed', runId: 'c', attempt: 1, text: 'dug', usage }, 9)
  pipelineFinished(s, 'p1', { status: 'completed', text: 'checked', usage, runs: 3 }, 10)
  assert.deepEqual(s.answers.p1?.value, { output: 'checked' })
  assert.deepEqual(
    s.markers.map((m) => [m.type, m.seq, m.body.itemId, m.body.status]),
    [
      ['pipeline.call.ended', SUBAGENT_MARKER_SEQ + SUBAGENT_MARKER_SPAN, 'p2', 'failed'],
      ['subagent.ended', SUBAGENT_MARKER_SEQ + SUBAGENT_MARKER_SPAN + 1, 'k1', 'completed'],
      ['pipeline.call.ended', SUBAGENT_MARKER_SEQ + SUBAGENT_MARKER_SPAN + 2, 'p1', 'completed'],
    ],
  )
  assert.deepEqual(s.markers[0]!.body, {
    itemId: 'p2',
    name: 'review',
    status: 'failed',
    error: 'Pipeline node "b" failed (visit 1): boom',
    nodeId: 'b',
    visit: 1,
    runs: 2,
    usage,
  })
  assert.deepEqual(s.markers[2]!.body, {
    itemId: 'p1',
    name: 'review',
    status: 'completed',
    text: 'checked',
    runs: 3,
    usage,
  })
  assert.equal(childrenRunning(s), false)
  assert.equal(parkedReadyAfter(s, 'a'), true)
  const resumed = takeTurn(s, 11)!
  assert.deepEqual(Object.keys(resumed.answers!).sort(), ['a', 'k1', 'p1', 'p2'])
  assert.deepEqual(resumed.pipelines, {
    maxPerRound: PIPELINE_DEFAULTS.maxPerRound,
    remaining: PIPELINE_DEFAULTS.maxPerSession - 2,
  })
  assert.equal(view(s).pipelinesStarted, 2)
})

test("pipelines: a pipeline's answer; a cap cut it short - still an answer, with a note", () => {
  assert.deepEqual(
    pipelineAnswerOf('review', { status: 'completed', text: 'done', usage, runs: 2 }),
    {
      output: 'done',
    },
  )
  const cut = pipelineAnswerOf('review', {
    status: 'completed',
    text: 'last draft',
    usage,
    runs: 6,
    stoppedBy: 'maxNodeVisits',
  }) as { output: string }
  assert.match(
    cut.output,
    /^last draft\n\n\[pipeline "review" was cut short by its maxNodeVisits limit after 6 node runs/,
  )
  assert.deepEqual(pipelineAnswerOf('review', { status: 'stopped', runs: 1, usage }), {
    error: 'pipeline "review" was stopped before it answered',
  })
})

test('pipelines: only the pipeline answers its item; a client answer is refused', () => {
  const s = initialState('s', options())
  park(s, [pipe('p1')])
  assert.equal(
    acceptAnswer(s, { requestId: 'p1', value: { output: 'mine' }, at: 2, by: 'client' }),
    'refused',
  )
  assert.equal(acceptAnswer(s, { requestId: 'p1', value: { output: 'x' }, at: 2 }), 'refused')
  assert.equal(
    acceptAnswer(s, { requestId: 'p1', value: { output: 'x' }, at: 2, by: 'subagent' }),
    'refused',
    'nor a subagent',
  )
  assert.deepEqual(s.answers, {})
  // Before a park, a pipeline's answer is never kept (no child runs before its park).
  const t = initialState('t', options())
  assert.equal(
    acceptAnswer(t, { requestId: 'x', value: { output: 'x' }, at: 1, by: 'pipeline' }),
    'refused',
  )
})

test('pipelines: the caps per round and per session refuse with a tool error, never a child', () => {
  const s = initialState(
    's',
    options({ pipelineMaxPerRound: 1, pipelineMaxPerSession: 2, subagentMaxPerRound: 1 }),
  )
  park(s, [pipe('a'), pipe('b'), sub('k1'), sub('k2')])
  const first = startChildren(s, 1)
  assert.deepEqual(
    first.map((c) => c.requestId),
    ['a', 'k1'],
    'each kind has its own cap',
  )
  assert.deepEqual(s.answers.b, {
    requestId: 'b',
    value: { error: 'pipeline "review" refused: at most 1 pipeline calls in one round' },
    at: 1,
    by: 'pipeline',
  })
  assert.match(String((s.answers.k2?.value as { error: string }).error), /at most 1 subagent calls/)
  pipelineFinished(s, 'a', { status: 'completed', text: 'a', usage, runs: 1 }, 2)
  childFinished(s, 'k1', { status: 'completed', runId: 'c', attempt: 1, text: 'k', usage }, 2)
  const resumed = takeTurn(s, 3)!
  assert.deepEqual(resumed.pipelines, { maxPerRound: 1, remaining: 1 })
  finishTurn(
    s,
    resumed,
    { status: 'parked', runId: 'r1', attempt: 2, turnAttempt: 2, requests: [pipe('c')] },
    4,
  )
  assert.deepEqual(
    startChildren(s, 5).map((c) => c.requestId),
    ['c'],
  )
  pipelineFinished(s, 'c', { status: 'completed', text: 'c', usage, runs: 1 }, 6)
  const third = takeTurn(s, 7)!
  assert.deepEqual(third.pipelines, { maxPerRound: 1, remaining: 0 })
  finishTurn(
    s,
    third,
    { status: 'parked', runId: 'r1', attempt: 3, turnAttempt: 3, requests: [pipe('d')] },
    8,
  )
  assert.deepEqual(startChildren(s, 9), [])
  assert.match(
    String((s.answers.d?.value as { error: string }).error),
    /at most 2 pipeline calls in one session/,
  )
})

test('pipelines: only the kinds the workflow starts (each behind its own patch)', () => {
  const s = initialState('s', options())
  park(s, [sub('k1'), pipe('p1')])
  assert.deepEqual(
    startChildren(s, 1, { subagents: true, pipelines: false }).map((c) => c.requestId),
    ['k1'],
  )
  assert.equal(s.answers.p1, undefined, 'not refused either: left alone')
  assert.deepEqual(
    startChildren(s, 2, { subagents: true, pipelines: true }).map((c) => c.requestId),
    ['p1'],
  )
})

test('pipelines: a stop drops a late result; continue-as-new waits for a running pipeline', () => {
  const s = initialState('s', options({ maxTurnsPerRun: 1 }))
  park(s, [pipe('p1')])
  startChildren(s, 1)
  s.markers = []
  assert.equal(shouldContinueAsNew(s, true), false, 'a pipeline runs')
  const next = initialState('s', options(), carry(s))
  assert.equal(next.pipelinesStarted, 1, 'the count is carried')
  acceptStop(s, { at: 2 }, 2)
  assert.equal(
    pipelineFinished(s, 'p1', { status: 'completed', text: 'late', usage, runs: 1 }, 3),
    false,
  )
  assert.deepEqual(s.answers, {})
  assert.equal(shouldContinueAsNew(s, true), false, 'the turn.ended marker first')
})

test('a session started before pipelines existed gets their defaults', () => {
  const s = initialState('s', options())
  acceptMessage(s, msg('m'))
  assert.deepEqual(takeTurn(s, 0)?.pipelines, {
    maxPerRound: PIPELINE_DEFAULTS.maxPerRound,
    remaining: PIPELINE_DEFAULTS.maxPerSession,
  })
  const old = initialState('s', options(), { ...carry(s), pipelinesStarted: undefined } as never)
  assert.equal(old.pipelinesStarted, 0)
})

// --- children that wait for a person ------------------------------------------------------------

const childItem = (id: string): IParkedRequest => ({
  requestId: id,
  kind: 'approval',
  question: { request: { toolName: 'write_note', input: { text: id } } },
})
const waitingOf = (
  itemId: string,
  workflowId: string,
  extra: Partial<IChildParkNotice> = {},
): IChildParkNotice => ({
  itemId,
  kind: 'subagent',
  workflowId,
  runId: 'c1',
  state: 'waiting',
  requests: [childItem('q1')],
  at: 4,
  ...extra,
})

test('a child that waits: shown in the state, its waiting / resumed markers in order with the others', () => {
  const s = initialState('s', options())
  park(s, [sub('k1'), sub('k2'), approval('a')], 3)
  startChildren(s, 1)
  s.markers = []
  const k1 = subagentWorkflowIdOf('s', 'r1', 'k1')
  const k2 = subagentWorkflowIdOf('s', 'r1', 'k2')
  assert.equal(childPark(s, waitingOf('k1', k1), 4), true)
  assert.deepEqual(view(s).parked?.waiting, [
    {
      itemId: 'k1',
      name: 'researcher',
      workflowId: k1,
      runId: 'c1',
      kind: 'subagent',
      requests: [childItem('q1')],
      since: 4,
      events: '/sessions/s/subagents/k1/events',
    },
  ])
  // The other child ends meanwhile; then the first one goes on: one counter for every marker
  // after the starts, in the order the workflow saw them.
  childFinished(s, 'k2', { status: 'completed', runId: 'c2', attempt: 1, text: 'ok', usage }, 5)
  assert.equal(
    childPark(s, { ...waitingOf('k1', k1), state: 'resumed', answered: ['q1'], requests: [] }, 6),
    true,
  )
  assert.equal(view(s).parked?.waiting, undefined, 'nobody waits')
  childFinished(s, 'k1', { status: 'completed', runId: 'c1', attempt: 2, text: 'ok', usage }, 7)
  assert.deepEqual(
    s.markers.map((m) => [
      m.type,
      m.turnAttempt,
      m.seq - SUBAGENT_MARKER_SEQ - SUBAGENT_MARKER_SPAN,
      m.body.itemId,
    ]),
    [
      ['subagent.waiting', 3, 0, 'k1'],
      ['subagent.ended', 3, 1, 'k2'],
      ['subagent.resumed', 3, 2, 'k1'],
      ['subagent.ended', 3, 3, 'k1'],
    ],
  )
  assert.deepEqual(s.markers[0]!.body, {
    itemId: 'k1',
    name: 'researcher',
    workflowId: k1,
    runId: 'c1',
    requests: [{ requestId: 'q1', kind: 'approval', toolName: 'write_note' }],
    events: '/sessions/s/subagents/k1/events',
  })
  assert.deepEqual(s.markers[2]!.body.answered, ['q1'])
  // The person's own item is the last one: the turn goes on.
  assert.equal(parkedReadyAfter(s, 'a'), true)
})

test('a pipeline node visit that waits: the visit named, its own stream; the pipeline ending drops it', () => {
  const s = initialState('s', options())
  park(s, [pipe('p1')], 2)
  startChildren(s, 1)
  s.markers = []
  const visit = pipelineNodeWorkflowIdOf(pipelineWorkflowIdOf('s', 'r1', 'p1'), 'draft', 2)
  const notice = waitingOf('p1', visit, { kind: 'pipeline', nodeId: 'draft', visit: 2 })
  assert.equal(childPark(s, notice, 4), true)
  const w = view(s).parked!.waiting![0]!
  assert.deepEqual(
    [w.kind, w.name, w.nodeId, w.visit, w.workflowId],
    ['pipeline', 'review', 'draft', 2, visit],
  )
  assert.equal(w.events, '/sessions/s/pipelines/p1/nodes/draft/2/events')
  assert.equal(s.markers[0]!.type, 'pipeline.call.waiting')
  assert.deepEqual([s.markers[0]!.body.nodeId, s.markers[0]!.body.visit], ['draft', 2])
  // The pipeline fails (another node of the wave): it waits for nobody any more.
  pipelineFinished(s, 'p1', { status: 'failed', error: 'x', runs: 2, usage }, 5)
  assert.equal(view(s).parked?.waiting, undefined)
  assert.equal(childPark(s, { ...notice, state: 'resumed', answered: ['q1'] }, 6), false, 'over')
})

test('a notice about anything but a running child of this park is ignored', () => {
  const s = initialState('s', options())
  park(s, [sub('k1'), approval('a'), pipe('p1')], 1)
  startChildren(s, 1)
  s.markers = []
  const k1 = subagentWorkflowIdOf('s', 'r1', 'k1')
  const ignored: [string, IChildParkNotice][] = [
    ['not an item of the park', waitingOf('nope', k1)],
    ['an item no child answers', waitingOf('a', subagentWorkflowIdOf('s', 'r1', 'a'))],
    ['another workflow', waitingOf('k1', 'subagent-other-r1-k1')],
    ["another session's child", waitingOf('k1', subagentWorkflowIdOf('t', 'r1', 'k1'))],
    ["another run's child", waitingOf('k1', subagentWorkflowIdOf('s', 'r0', 'k1'))],
    ['the wrong kind', waitingOf('k1', k1, { kind: 'pipeline', nodeId: 'n', visit: 1 })],
    ['a subagent with a node', waitingOf('k1', k1, { nodeId: 'n', visit: 1 })],
    [
      'a node visit without its node',
      waitingOf('p1', pipelineWorkflowIdOf('s', 'r1', 'p1'), { kind: 'pipeline' }),
    ],
    [
      'another node than its workflow names',
      waitingOf('p1', pipelineNodeWorkflowIdOf(pipelineWorkflowIdOf('s', 'r1', 'p1'), 'a', 1), {
        kind: 'pipeline',
        nodeId: 'b',
        visit: 1,
      }),
    ],
    ['nothing to wait for', waitingOf('k1', k1, { requests: [] })],
    ['resumed without waiting', { ...waitingOf('k1', k1), state: 'resumed' }],
  ]
  for (const [why, notice] of ignored) {
    assert.equal(childPark(s, notice, 2), false, why)
  }
  assert.equal(view(s).parked?.waiting, undefined)
  assert.deepEqual(s.markers, [])
  // A child that has ended, and a park that is over (stopped), take no notice.
  childFinished(s, 'k1', { status: 'failed', error: 'x' }, 3)
  assert.equal(childPark(s, waitingOf('k1', k1), 4), false, 'ended')
  const t = initialState('s', options())
  park(t, [sub('k1')], 1)
  startChildren(t, 1)
  acceptStop(t, { at: 2 }, 2)
  assert.equal(childPark(t, waitingOf('k1', k1), 3), false, 'stopped')
})

test('a waiting child is still a child: no continue-as-new, its item is not ready; a stop ends it all', () => {
  const s = initialState('s', options({ maxTurnsPerRun: 1 }))
  park(s, [sub('k1')], 1)
  startChildren(s, 1)
  s.markers = []
  childPark(s, waitingOf('k1', subagentWorkflowIdOf('s', 'r1', 'k1')), 2)
  s.markers = []
  assert.equal(childrenRunning(s), true)
  assert.equal(shouldContinueAsNew(s, true), false)
  assert.equal(hasWork(s), false, 'nothing to do while the person decides')
  acceptStop(s, { at: 3 }, 3)
  assert.equal(view(s).parked, undefined)
  assert.equal(s.endings[0]?.status, 'stopped')
})
