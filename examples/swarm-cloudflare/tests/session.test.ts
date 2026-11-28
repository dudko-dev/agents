// The session's object (src/session.ts, src/host.ts) over node:sqlite, with the Workflow
// instances played by the test: what each transition writes (the state, the markers, the parked
// items, the children) and which effects it asks for (the outbox), in order.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  childWorkflowIdOf,
  START_CURSOR,
  SUBAGENT_MARKER_SEQ,
  subagentWorkflowIdOf,
  type IChildParked,
} from 'swarm-shared'
import { eventsAfter } from '../src/store.ts'
import { OUTBOX_MAX_ATTEMPTS } from '../src/host.ts'
import {
  approval,
  completed,
  message,
  OPTIONS,
  parkedResult,
  subagentCall,
  testHost,
  type ITestHost,
} from './helpers/host.ts'

const types = (t: ITestHost, stream = 's1'): string[] =>
  eventsAfter(
    (t.host as unknown as { storage: { sql: never } }).storage.sql,
    stream,
    START_CURSOR,
    1000,
  ).map((r) => (JSON.parse(r.json) as { type: string }).type)

const started = async (t: ITestHost, first = 'hello') => {
  t.host.create('s1', OPTIONS, message(first))
  await t.drain()
}

test('create starts the first turn: one Workflow instance per turn, named by session and turn', async () => {
  const t = testHost()
  await started(t)
  assert.deepEqual(t.effects, [
    {
      kind: 'create',
      workflow: 'turn',
      id: 'turn-s1-1',
      params: { sessionId: 's1', turn: 1, options: { turnTimeoutMs: 60_000, maxTurnAttempts: 3 } },
    },
  ])
  const phase = t.host.turnPhase(1, 0)
  assert.ok('input' in phase)
  assert.equal(phase.input.input, 'hello')
  assert.equal(phase.stopping, false)
  assert.deepEqual(t.host.turnPhase(1, 1), { gone: true }, 'not a phase of this turn yet')
  // A create of a session that exists changes nothing.
  t.host.create('s1', OPTIONS, message('again'))
  await t.drain()
  assert.equal(t.effects.length, 1)
})

test('a turn completes: turn.ended, the history, the next queued message becomes the next turn', async () => {
  const t = testHost()
  await started(t)
  assert.deepEqual(t.host.message(message('second')), { ok: true, value: true })
  assert.deepEqual(t.host.message(message('second')), { ok: true, value: true }, 'a repeat')
  assert.deepEqual(t.host.turnOutcome(1, 0, completed('hi there')), { applied: 'completed' })
  await t.drain()
  const v = t.host.view()
  assert.ok(v.ok)
  assert.equal(v.value.status, 'running')
  assert.equal(v.value.turn, 2)
  assert.deepEqual(v.value.history, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ])
  assert.deepEqual(types(t), ['turn.ended'])
  assert.deepEqual(
    t.effects.map((e) => e.id),
    ['turn-s1-1', 'turn-s1-2'],
  )
  // A retried report of the same phase is a no-op.
  assert.deepEqual(t.host.turnOutcome(1, 0, completed('again')), { applied: 'completed' })
  assert.deepEqual(t.host.turnPhase(1, 0), { applied: 'completed' })
  assert.equal(types(t).length, 1)
})

test('a parked turn records its items; the answers resume it as the next phase of the same instance', async () => {
  const t = testHost()
  await started(t)
  t.host.turnOutcome(1, 0, parkedResult([approval('p1'), approval('p2')]))
  await t.drain()
  assert.equal(t.host.parkedItem('p1')?.state, 'pending')
  assert.equal(t.host.parkedItem('p1')?.answeredBy, 'client')
  const v = t.host.view()
  assert.ok(v.ok && v.value.status === 'parked')
  t.host.answer({ requestId: 'p1', value: { approved: true }, at: 1 })
  await t.drain()
  assert.equal(t.effects.length, 1, 'half the answers: nothing goes on')
  // An answer of the wrong shape is refused by the reducer (the authority) too.
  t.host.answer({ requestId: 'p2', value: { approved: 'yes' }, at: 1 })
  await t.drain()
  assert.equal(t.effects.length, 1)
  t.host.answer({ requestId: 'p2', value: { approved: false }, at: 1 })
  await t.drain()
  assert.deepEqual(t.effects[1], {
    kind: 'event',
    workflow: 'turn',
    id: 'turn-s1-1',
    type: 'resume-1',
    payload: {},
  })
  assert.equal(t.host.parkedItem('p1')?.state, 'answered')
  const phase = t.host.turnPhase(1, 1)
  assert.ok('input' in phase)
  assert.deepEqual(Object.keys(phase.input.answers ?? {}).sort(), ['p1', 'p2'])
  t.host.turnOutcome(1, 1, completed('done', 'run-1', 2))
  await t.drain()
  assert.deepEqual(types(t), ['turn.ended'])
})

test('stop while running: the step hears it in its heartbeat; while parked: the turn ends at once', async () => {
  const t = testHost()
  await started(t)
  assert.equal(t.host.heartbeat({ turn: 1 }, 'r', 'o', 1000).stop, false)
  t.host.message(message('queued'))
  t.host.stop({ at: 1 })
  assert.equal(t.host.heartbeat({ turn: 1 }, 'r', 'o', 1000).stop, true)
  assert.equal(t.host.appendEvents([], { turn: 1 }).stop, true)
  const phase = t.host.turnPhase(1, 0)
  assert.ok('input' in phase && phase.stopping)
  t.host.turnOutcome(1, 0, { status: 'stopped', runId: 'run-1' })
  await t.drain()
  let v = t.host.view()
  assert.ok(v.ok && v.value.status === 'idle')
  assert.equal(v.value.turn, 1, 'the queued message was dropped')

  t.host.message(message('two'))
  await t.drain()
  t.host.turnOutcome(2, 0, parkedResult([approval('q1')], 'run-2'))
  await t.drain()
  t.host.stop({ at: 2 })
  await t.drain()
  v = t.host.view()
  assert.ok(v.ok && v.value.status === 'idle')
  assert.equal(t.host.parkedItem('q1')?.state, 'cancelled')
  assert.deepEqual(t.effects.at(-1), {
    kind: 'event',
    workflow: 'turn',
    id: 'turn-s1-2',
    type: 'resume-1',
    payload: { stop: true },
  })
})

test('stop with end ends the session once nothing runs; later calls are refused as ended', async () => {
  const t = testHost()
  await started(t)
  t.host.stop({ end: true, at: 1 })
  assert.ok(
    t.host.view().ok &&
      (t.host.view() as { value: { status: string } }).value.status === 'stopping',
  )
  t.host.turnOutcome(1, 0, { status: 'stopped' })
  await t.drain()
  const v = t.host.view()
  assert.ok(v.ok && v.value.status === 'ended')
  assert.deepEqual(t.host.message(message('late')), { ok: false, error: 'ended' })
  assert.deepEqual(t.host.answer({ requestId: 'x', value: {}, at: 1 }), {
    ok: false,
    error: 'ended',
  })
  assert.deepEqual(t.host.stop({ at: 1 }), { ok: false, error: 'ended' })
})

test('a session never started here: not found, and nothing is written', () => {
  const t = testHost()
  assert.equal(t.host.exists(), false)
  assert.deepEqual(t.host.message(message('x')), { ok: false, error: 'not_found' })
  assert.deepEqual(t.host.view(), { ok: false, error: 'not_found' })
  assert.deepEqual(t.host.answerChild('w', { requestId: 'x', value: {}, at: 1 }), {
    ok: false,
    error: 'not_found',
  })
  assert.equal(t.host.exists(), false)
})

test('subagent calls: a child each (within the caps), markers in the parked slot, the answers resume the turn', async () => {
  const t = testHost()
  await started(t)
  t.host.turnOutcome(1, 0, parkedResult([subagentCall('a'), subagentCall('b'), subagentCall('c')]))
  await t.drain()
  const wa = subagentWorkflowIdOf('s1', 'run-1', 'a')
  const wb = subagentWorkflowIdOf('s1', 'run-1', 'b')
  assert.deepEqual(
    t.effects.slice(1).map((e) => [e.kind, e.workflow, e.id]),
    [
      ['create', 'subagent', wa],
      ['create', 'subagent', wb],
    ],
    'the third call is past the per-round cap: no child',
  )
  assert.equal(t.host.parkedItem('a')?.answeredBy, 'subagent')
  assert.equal(t.host.parkedItem('a')?.childId, wa)
  const phase = t.host.childPhase(wa, 0)
  assert.ok('input' in phase && phase.kind === 'subagent')
  assert.equal(phase.input.stream, 's1/a')
  // The children end in another order than they started.
  t.host.childOutcome(wb, 0, completed('b says') as never)
  t.host.childOutcome(wa, 0, { status: 'failed', error: 'no' })
  await t.drain()
  const rows = eventsAfter(
    (t.host as unknown as { storage: { sql: never } }).storage.sql,
    's1',
    START_CURSOR,
    100,
  )
  const markers = rows.map((r) => [
    r.cursor.seq - SUBAGENT_MARKER_SEQ,
    (JSON.parse(r.json) as { type: string }).type,
  ])
  assert.deepEqual(markers, [
    [0, 'subagent.started'],
    [1, 'subagent.started'],
    [1_048_576, 'subagent.ended'],
    [1_048_577, 'subagent.ended'],
  ])
  assert.deepEqual(types(t, 's1/b'), ['turn.ended'], "the child's own stream ends")
  const resume = t.effects.at(-1)!
  assert.equal(resume.kind === 'event' && resume.type, 'resume-1')
  const next = t.host.turnPhase(1, 1)
  assert.ok('input' in next)
  assert.deepEqual(next.input.answers?.b?.value, { output: 'b says' })
  assert.match(
    String((next.input.answers?.c?.value as { error: string }).error),
    /at most 2 subagent calls/,
  )
  // A finished child takes nothing more.
  assert.deepEqual(t.host.childOutcome(wb, 0, completed('again') as never), {
    applied: 'completed',
  })
  assert.deepEqual(t.host.childPhase(wb, 0), { applied: 'completed' })
})

const childParked = (requestId: string, runId = 'run-child'): IChildParked => ({
  status: 'parked',
  runId,
  attempt: 1,
  requests: [approval(requestId)],
})

test("a child waits for a person: its items are the session's, owned by it; the answers resume the same run", async () => {
  const t = testHost()
  await started(t)
  t.host.turnOutcome(1, 0, parkedResult([subagentCall('a')]))
  await t.drain()
  const wa = childWorkflowIdOf('s1', 'run-1', 'a')
  t.host.childOutcome(wa, 0, { ...childParked('x1'), requests: [approval('x1'), approval('x2')] })
  await t.drain()
  const item = t.host.parkedItem('x1')!
  assert.equal(item.sessionId, 's1')
  assert.equal(item.turn, 1, "in the parent's turn")
  assert.deepEqual(item.owner, { workflowId: wa, itemId: 'a' })
  const v = t.host.view()
  assert.ok(v.ok)
  assert.equal(v.value.parked?.waiting?.[0]?.workflowId, wa)
  assert.deepEqual(types(t).slice(-1), ['subagent.waiting'])
  // Partial: still waiting.
  t.host.answerChild(wa, { requestId: 'x1', value: { approved: true }, at: 1 })
  await t.drain()
  assert.equal(t.effects.filter((e) => e.kind === 'event').length, 0)
  // A wrong shape is refused by the child's wait (the authority).
  t.host.answerChild(wa, { requestId: 'x2', value: { yes: 1 }, at: 1 })
  await t.drain()
  assert.equal(t.effects.filter((e) => e.kind === 'event').length, 0)
  t.host.answerChild(wa, { requestId: 'x2', value: { approved: false }, at: 1 })
  await t.drain()
  assert.deepEqual(t.effects.at(-1), {
    kind: 'event',
    workflow: 'subagent',
    id: wa,
    type: 'resume-1',
    payload: {},
  })
  assert.equal(t.host.parkedItem('x1')?.state, 'answered')
  assert.deepEqual(types(t).slice(-1), ['subagent.resumed'])
  const phase = t.host.childPhase(wa, 1)
  assert.ok('input' in phase)
  assert.deepEqual(Object.keys(phase.answers ?? {}).sort(), ['x1', 'x2'])
  t.host.childOutcome(wa, 1, completed('child done', 'run-child', 2) as never)
  await t.drain()
  assert.deepEqual(types(t).slice(-1), ['subagent.ended'])
  assert.deepEqual(t.host.answerChild(wa, { requestId: 'x1', value: { approved: true }, at: 1 }), {
    ok: false,
    error: 'child_ended',
  })
})

test('a child the session does not have, or that is over, takes no answer', async () => {
  const t = testHost()
  await started(t)
  assert.deepEqual(t.host.answerChild('nope', { requestId: 'x', value: {}, at: 1 }), {
    ok: false,
    error: 'child_ended',
  })
})

test('a stop while a child waits ends it at once and closes its items; a working one is told by its heartbeat', async () => {
  const t = testHost()
  await started(t)
  t.host.turnOutcome(1, 0, parkedResult([subagentCall('a'), subagentCall('b')]))
  await t.drain()
  const wa = childWorkflowIdOf('s1', 'run-1', 'a')
  const wb = childWorkflowIdOf('s1', 'run-1', 'b')
  t.host.childOutcome(wa, 0, childParked('x1'))
  await t.drain()
  assert.equal(t.host.childStopping(wb), false)
  t.host.stop({ at: 1 })
  await t.drain()
  assert.equal(t.host.parkedItem('x1')?.state, 'cancelled')
  assert.deepEqual(types(t, 's1/a'), ['turn.ended'])
  assert.deepEqual(
    t.effects.slice(-2).map((e) => (e.kind === 'event' ? [e.id, e.type, e.payload] : e.kind)),
    [
      ['turn-s1-1', 'resume-1', { stop: true }],
      [wa, 'resume-1', { stop: true }],
    ],
  )
  assert.equal(t.host.childStopping(wb), true, 'the working one is told at its next heartbeat')
  assert.equal(t.host.heartbeat({ child: wb }, 'r', 'o', 1000).stop, true)
  // Its stopped outcome ends its stream; the stopped park takes it no more.
  t.host.childOutcome(wb, 0, { status: 'stopped' })
  await t.drain()
  assert.deepEqual(types(t, 's1/b'), ['turn.ended'])
})

test('the idle timer ends a session after SESSION_IDLE_TIMEOUT_MS without work - never while children work', async () => {
  const t = testHost()
  t.host.create('s1', { ...OPTIONS, idleTimeoutMs: 10_000 }, message('hi'))
  await t.drain()
  assert.equal(t.host.core.idleDeadline(), undefined, 'not while a turn runs')
  t.host.turnOutcome(1, 0, parkedResult([subagentCall('a')]))
  await t.drain()
  assert.equal(t.host.core.idleDeadline(), undefined, 'not while a child works')
  t.host.childOutcome(childWorkflowIdOf('s1', 'run-1', 'a'), 0, completed('x') as never)
  await t.drain()
  t.host.turnOutcome(1, 1, completed('done', 'run-1', 2))
  await t.drain()
  const at = t.host.core.idleDeadline()!
  assert.equal(at, t.clock.now + 10_000)
  t.clock.now = at - 1
  assert.equal(t.host.core.idle(), false)
  t.clock.now = at
  assert.equal(t.host.core.idle(), true)
  const v = t.host.view()
  assert.ok(v.ok && v.value.status === 'ended')
})

test('the outbox: an effect that fails is retried later, in order; one that keeps failing is given up', async () => {
  const t = testHost()
  t.failNext(1)
  t.host.create('s1', OPTIONS, message('hi'))
  await t.drain()
  assert.equal(t.effects.length, 0)
  assert.ok((t.alarms.at(-1) ?? 0) > t.clock.now, 'an alarm for the retry')
  t.host.message(message('two'))
  await t.drain()
  assert.equal(t.effects.length, 0, 'nothing overtakes the failed one')
  t.clock.now += 120_000
  await t.drain()
  assert.deepEqual(
    t.effects.map((e) => e.id),
    ['turn-s1-1'],
  )
  // Given up after OUTBOX_MAX_ATTEMPTS.
  const u = testHost()
  u.failNext(OUTBOX_MAX_ATTEMPTS)
  u.host.create('s2', OPTIONS, message('hi'))
  for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
    u.clock.now += 120_000
    await u.drain()
  }
  assert.equal(u.effects.length, 0)
  u.clock.now += 120_000
  await u.drain()
  assert.equal(u.effects.length, 0, 'given up: it is not made late')
})

test('the watchdog fails a turn whose instance errored, and nudges one whose step went silent', async () => {
  const t = testHost({ leaseTtlMs: 1000 })
  await started(t)
  await t.host.watchdog()
  t.clock.now += 3001
  await t.host.watchdog()
  assert.deepEqual(t.effects.at(-1), {
    kind: 'event',
    workflow: 'turn',
    id: 'turn-s1-1',
    type: 'nudge',
    payload: {},
  })
  // Heard of again: no nudge.
  t.host.heartbeat({ turn: 1 }, 'r', 'o', 1000)
  const n = t.effects.length
  await t.host.watchdog()
  assert.equal(t.effects.length, n)
  t.statuses.set('turn:turn-s1-1', { status: 'errored', error: { message: 'boom' } })
  await t.host.watchdog()
  await t.drain()
  const v = t.host.view()
  assert.ok(v.ok)
  assert.equal(v.value.turns[0]?.status, 'failed')
  assert.match(String(v.value.turns[0]?.error), /errored: boom/)
})

test('the watchdog leaves an instance alone whose start is still in the outbox', async () => {
  const t = testHost()
  t.failNext(1)
  t.host.create('s1', OPTIONS, message('hi'))
  await t.drain()
  t.statuses.set('turn:turn-s1-1', 'not_found')
  await t.host.watchdog()
  const v = t.host.view()
  assert.ok(v.ok && v.value.status === 'running', 'not failed: it was never started yet')
})
