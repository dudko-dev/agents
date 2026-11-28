// A session end to end on the local Worker (mirrors examples/swarm's tests/integration/
// session.test.ts): the gateway starts the session's object, the object starts the turn's
// Workflow, the step runs the agent against the scripted model, the events reach the object's log
// and come back over SSE in (turn, attempt, seq) order - again from the cursor after a reconnect
// (`?after=`, and Last-Event-ID, which wins), and live. Plus what the gateway refuses, and the
// per-session cap on open streams (a stream the client left is closed in the object: its slot is
// free again).
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { compareCursors, parseCursor, type ICursor } from 'swarm-shared'
import {
  api,
  planJson,
  readSse,
  readStream,
  stageOf,
  startStack,
  stepOf,
  TOKEN,
  userOf,
  type IStack,
  type ISseEvent,
} from './harness.ts'

let stack: IStack

before(async () => {
  stack = await startStack(
    (req) => {
      const stage = stageOf(req)
      if (stage === 'planner') return { text: planJson(['a', 'b']) }
      if (stage === 'synthesizer') {
        return { text: `answer to: ${userOf(req).includes('again') ? 'again' : 'hello'}` }
      }
      if (stage === 'replanner')
        return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
      return { text: `did ${stepOf(req)}` }
    },
    { SSE_MAX_CONNECTIONS: '2' },
  )
})

after(async () => {
  await stack?.stop()
})

const cursorOf = (e: ISseEvent): ICursor => {
  const parsed = parseCursor(e.id)
  assert.ok(parsed.ok)
  return parsed.cursor
}

const assertOrdered = (events: ISseEvent[]): void => {
  for (let i = 1; i < events.length; i++) {
    assert.ok(compareCursors(cursorOf(events[i - 1]!), cursorOf(events[i]!)) < 0, 'in order')
  }
}

const ended = (turn: number) => (seen: ISseEvent[]) =>
  seen.some((e) => e.data.event.type === 'turn.ended' && e.data.turn === turn)

test('a turn runs end to end and its events stream in order, then replay from a cursor', async () => {
  const client = api(stack)
  const created = await client.post('/sessions', { message: 'hello' })
  assert.equal(created.status, 201)
  const sessionId = created.body.sessionId as string
  const first = await readSse(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
  )
  assert.equal(first.status, 200)
  const events = first.events
  assertOrdered(events)
  assert.equal(events[0]!.data.event.type, 'turn.started')
  assert.equal(events[0]!.id, '1:0:0')
  const end = events.at(-1)!
  assert.equal(end.data.event.type, 'turn.ended')
  assert.equal(end.id, '1:2147483647:0')
  assert.equal(end.data.event.status, 'completed')
  assert.equal(end.data.event.text, 'answer to: hello')
  const types = events.map((e) => e.data.event.type)
  for (const t of ['plan.created', 'step.start', 'step.complete', 'final']) {
    assert.ok(types.includes(t), `${t} in the stream`)
  }

  // Replay from a cursor in the middle: exactly the rest.
  const mid = events[Math.floor(events.length / 2)]!
  const rest = await readStream(
    `${stack.base}/sessions/${sessionId}/events?after=${mid.id}`,
    client.headers,
    ended(1),
  )
  assert.deepEqual(
    rest.events.map((e) => e.id),
    events.slice(events.indexOf(mid) + 1).map((e) => e.id),
  )
  // Last-Event-ID wins over `after`.
  const resumed = await readStream(
    `${stack.base}/sessions/${sessionId}/events?after=0:0:0`,
    { ...client.headers, 'last-event-id': mid.id },
    ended(1),
  )
  assert.equal(resumed.events[0]!.id, rest.events[0]!.id)

  // The state: idle, the exchange in the history, the turn on record.
  const state = await client.get(`/sessions/${sessionId}`)
  assert.equal(state.status, 200)
  assert.equal(state.body.status, 'idle')
  assert.deepEqual(state.body.history, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'answer to: hello' },
  ])
  const turns = state.body.turns as { turn: number; status: string; runId: string }[]
  assert.equal(turns[0]?.status, 'completed')
  assert.match(turns[0]!.runId, /^run-[0-9a-f]{32}$/)
})

test('live: a stream open at the end gets the next turn as it happens', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'hello' })
  const sessionId = body.sessionId as string
  const first = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
  )
  const last = first.events.at(-1)!.id
  const live = readStream(
    `${stack.base}/sessions/${sessionId}/events?after=${last}`,
    client.headers,
    ended(2),
  )
  await new Promise((r) => setTimeout(r, 300))
  const sent = await client.post(`/sessions/${sessionId}/messages`, { text: 'again', id: 'm-2' })
  assert.equal(sent.status, 202)
  assert.equal(sent.body.messageId, 'm-2')
  const got = await live
  assertOrdered(got.events)
  assert.equal(got.events[0]!.data.event.type, 'turn.started')
  assert.equal(got.events[0]!.data.turn, 2)
  assert.equal(got.events.at(-1)!.data.event.text, 'answer to: again')
  // A repeated POST (the same id) is dropped by the session: no third turn.
  await client.post(`/sessions/${sessionId}/messages`, { text: 'again', id: 'm-2' })
  await new Promise((r) => setTimeout(r, 500))
  const state = await client.get(`/sessions/${sessionId}`)
  assert.equal(state.body.turn, 2)
})

test('the gateway refuses what it should, and never wakes an object for an unauthenticated stream', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', {})
  const sessionId = body.sessionId as string
  const no = await fetch(`${stack.base}/sessions/${sessionId}/events`)
  assert.equal(no.status, 401)
  assert.equal(no.headers.get('www-authenticate'), 'Bearer')
  const wrong = await fetch(`${stack.base}/sessions/${sessionId}`, {
    headers: { authorization: 'Bearer wrong-token-wrong-token' },
  })
  assert.equal(wrong.status, 401)
  const bad = await fetch(`${stack.base}/sessions/${sessionId}/events?after=x`, {
    headers: client.headers,
  })
  assert.equal(bad.status, 400)
  await bad.body?.cancel()
  const unknown = await fetch(`${stack.base}/sessions/no-such-session/events`, {
    headers: client.headers,
  })
  assert.equal(unknown.status, 404)
  assert.equal((await client.post('/sessions/no-such-session/messages', { text: 'x' })).status, 404)
  assert.equal((await client.get('/sessions/no-such-session')).status, 404)
  assert.equal((await client.get('/sessions/bad.id')).status, 404)
  assert.equal((await client.post(`/sessions/${sessionId}/messages`, { text: '' })).status, 400)
  const health = await fetch(`${stack.base}/healthz`)
  assert.equal(health.status, 200)
  const ready = await fetch(`${stack.base}/readyz`)
  assert.equal(ready.status, 200, await ready.text())
  void TOKEN
})

test('the open streams of a session are capped; a stream the client left frees its slot', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', {})
  const sessionId = body.sessionId as string
  const url = `${stack.base}/sessions/${sessionId}/events`
  const a = new AbortController()
  const b = new AbortController()
  const one = await fetch(url, { headers: client.headers, signal: a.signal })
  const two = await fetch(url, { headers: client.headers, signal: b.signal })
  assert.equal(one.status, 200)
  assert.equal(two.status, 200)
  const three = await fetch(url, { headers: client.headers })
  assert.equal(three.status, 503)
  assert.equal(three.headers.get('retry-after'), '5')
  a.abort()
  await one.body?.cancel().catch(() => {})
  // The client went away: the object ends that stream, and a new one fits again.
  let again: Response | undefined
  for (let i = 0; i < 50; i++) {
    again = await fetch(url, { headers: client.headers })
    if (again.status === 200) break
    await again.body?.cancel()
    await new Promise((r) => setTimeout(r, 200))
  }
  assert.equal(again?.status, 200)
  await again?.body?.cancel()
  b.abort()
  await two.body?.cancel().catch(() => {})
})
