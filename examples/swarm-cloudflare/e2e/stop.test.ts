// Stop (mirrors examples/swarm's tests/integration/stop.test.ts): a stop reaches the running step
// in the answer of its next heartbeat or event batch, the step aborts the run, which records
// `cancelled`, and the turn ends `stopped`; the messages queued behind it are dropped; the session
// takes the next message; `end` ends the session (a later message is a 409).
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  api,
  planJson,
  readStream,
  stageOf,
  startStack,
  until,
  userOf,
  type ISseEvent,
  type IStack,
} from './harness.ts'

let stack: IStack

before(async () => {
  stack = await startStack((req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson(['a']) }
    if (stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    if (stage === 'synthesizer')
      return { text: `final: ${userOf(req).includes('quick') ? 'quick' : 'slow'}` }
    // A slow step unless the message says quick.
    return userOf(req).includes('quick') ? { text: 'done' } : { text: 'done', delayMs: 20_000 }
  })
})

after(async () => {
  await stack?.stop()
})

const ended = (turn: number) => (seen: ISseEvent[]) =>
  seen.some((e) => e.data.event.type === 'turn.ended' && e.data.turn === turn)

test('stop cancels the running turn; the session takes the next message; end ends it', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'slow one' })
  const sessionId = body.sessionId as string
  await client.state(sessionId, (s) => s.status === 'running')
  await until('the slow step', () =>
    stack.model.requests.some((r) => stageOf(r) === 'executor') ? true : undefined,
  )
  // Queued behind the running turn, then dropped by the stop.
  await client.post(`/sessions/${sessionId}/messages`, { text: 'queued one' })
  const t0 = Date.now()
  assert.equal((await client.post(`/sessions/${sessionId}/stop`, {})).status, 202)
  const first = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
  )
  const end = first.events.at(-1)!.data.event
  assert.equal(end.status, 'stopped')
  assert.ok(Date.now() - t0 < 15_000, 'stopped long before the slow answer came')
  const state = await client.state(sessionId, (s) => s.status === 'idle')
  assert.equal(state.turns[0]?.status, 'stopped')
  assert.equal(state.turn, 1, 'the queued message was dropped')

  await client.post(`/sessions/${sessionId}/messages`, { text: 'quick one' })
  const second = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(2),
  )
  assert.equal(second.events.at(-1)!.data.event.status, 'completed')
  assert.equal(second.events.at(-1)!.data.event.text, 'final: quick')

  const stopEnd = await client.post(`/sessions/${sessionId}/stop`, { end: true })
  assert.equal(stopEnd.status, 202)
  assert.deepEqual(stopEnd.body, { stopping: true, ending: true })
  const gone = await client.state(sessionId, (s) => s.status === 'ended')
  assert.equal(gone.status, 'ended')
  const late = await client.post(`/sessions/${sessionId}/messages`, { text: 'hello?' })
  assert.equal(late.status, 409)
  assert.equal((late.body.error as { code: string }).code, 'session_ended')
})
