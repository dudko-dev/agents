// Parking end to end (mirrors examples/swarm's tests/integration/parking.test.ts): a turn stops on
// a person's question (ask-writes; the MCP server's `echo` is not read-only, so every call asks),
// the item reaches the client in the stream and in the state, the answer comes through the
// gateway and the SAME turn - the same run - goes on in a resume phase of its Workflow instance:
// the write runs exactly once. The answer checks (shape, an unknown item, an answered one); a
// partial answer keeps the turn parked; stop during a park ends it and closes its items.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  api,
  planJson,
  readStream,
  roundOf,
  stageOf,
  startStack,
  toolResults,
  userOf,
  until,
  type IChatRequest,
  type ISseEvent,
  type IStack,
} from './harness.ts'

let stack: IStack

// The executor echoes one note per name in the user's input ("notes: a, b"), all in one round,
// then answers with what the tool said.
const notesOf = (req: IChatRequest): string[] => {
  const m = /notes: ([a-z, ]+)/.exec(JSON.stringify(req.messages))
  return m ? m[1]!.split(',').map((s) => s.trim()) : []
}

before(async () => {
  stack = await startStack(
    (req) => {
      const stage = stageOf(req)
      if (stage === 'planner') return { text: planJson(['a']) }
      if (stage === 'replanner')
        return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
      if (stage === 'synthesizer') {
        return { text: `final: ${userOf(req).includes('echo:') ? 'written' : 'not written'}` }
      }
      if (roundOf(req) === 0) {
        return { toolCalls: notesOf(req).map((text) => ({ name: 'docs__echo', args: { text } })) }
      }
      return { text: `results: ${toolResults(req).join(' | ')}` }
    },
    { AGENT_TOOL_APPROVAL: 'ask-writes' },
  )
})

after(async () => {
  await stack?.stop()
})

const ended = (turn: number) => (seen: ISseEvent[]) =>
  seen.some((e) => e.data.event.type === 'turn.ended' && e.data.turn === turn)

const echoes = (text: string): number =>
  stack.mcp.calls.filter((c) => c.name === 'echo' && (c.args as { text: string }).text === text)
    .length

test('a turn parks on a person question; the answer comes through the gateway; the write runs once', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'notes: alpha' })
  const sessionId = body.sessionId as string
  const parked = await client.state(sessionId, (s) => s.status === 'parked')
  assert.equal(parked.parked?.requests.length, 1)
  const item = parked.parked!.requests[0]!
  assert.equal(item.kind, 'approval')
  assert.equal(echoes('alpha'), 0, 'nothing written before the answer')
  // The stream shows the park: run.parked in the parked attempt, no turn.ended yet.
  const before = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    (seen) => seen.some((e) => e.data.event.type === 'run.parked'),
  )
  assert.ok(!before.events.some((e) => e.data.event.type === 'turn.ended'))

  // What the gateway refuses, before the session hears of it.
  const shape = await client.post(`/sessions/${sessionId}/answers/${item.requestId}`, { yes: 1 })
  assert.equal(shape.status, 400)
  assert.equal((shape.body.error as { code: string }).code, 'invalid_answer')
  const remember = await client.post(`/sessions/${sessionId}/answers/${item.requestId}`, {
    approved: true,
    remember: true,
  })
  assert.equal(remember.status, 400)
  const unknown = await client.post(`/sessions/${sessionId}/answers/p_nothing`, { approved: true })
  assert.equal(unknown.status, 404)

  const ok = await client.post(`/sessions/${sessionId}/answers/${item.requestId}`, {
    approved: true,
  })
  assert.equal(ok.status, 202)
  assert.deepEqual(ok.body, { requestId: item.requestId, kind: 'approval' })
  const done = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
  )
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.equal(end.text, 'final: written')
  assert.equal(echoes('alpha'), 1, 'the approved write ran exactly once')
  // The resumed attempt is the same run, one attempt on.
  const runIds = new Set(
    done.events
      .filter((e) => e.data.event.runId?.toString().startsWith('run-'))
      .map((e) => e.data.event.runId),
  )
  assert.equal(runIds.size, 1)
  assert.ok(done.events.some((e) => e.data.event.attempt === 2))
  // Answered: a second answer is refused.
  const again = await client.post(`/sessions/${sessionId}/answers/${item.requestId}`, {
    approved: true,
  })
  assert.equal(again.status, 409)
  assert.equal((again.body.error as { code: string }).code, 'already_answered')
})

test('a partial answer keeps the turn parked; the rest finishes it, each write once', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'notes: beta, gamma' })
  const sessionId = body.sessionId as string
  const parked = await client.state(sessionId, (s) => s.status === 'parked')
  const [one, two] = parked.parked!.requests
  assert.ok(one && two)
  await client.post(`/sessions/${sessionId}/answers/${one.requestId}`, { approved: true })
  const half = await client.state(sessionId, (s) => (s.parked?.answered.length ?? 0) === 1)
  assert.equal(half.status, 'parked')
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(echoes('beta') + echoes('gamma'), 0, 'nothing runs on half the answers')
  await client.post(`/sessions/${sessionId}/answers/${two.requestId}`, {
    approved: false,
    reason: 'not this one',
  })
  const done = await client.state(sessionId, (s) => s.turns.some((t) => t.status === 'completed'))
  assert.equal(done.status, 'idle')
  const ran = echoes('beta') + echoes('gamma')
  assert.equal(ran, 1, 'the approved one ran once, the denied one never')
})

test('stop during a park ends the turn as stopped; its items are closed', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'notes: delta' })
  const sessionId = body.sessionId as string
  const parked = await client.state(sessionId, (s) => s.status === 'parked')
  const item = parked.parked!.requests[0]!
  assert.equal((await client.post(`/sessions/${sessionId}/stop`, {})).status, 202)
  const stopped = await client.state(sessionId, (s) => s.turns.some((t) => t.status === 'stopped'))
  assert.equal(stopped.status, 'idle')
  const stream = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
  )
  assert.equal(stream.events.at(-1)!.data.event.status, 'stopped')
  const late = await client.post(`/sessions/${sessionId}/answers/${item.requestId}`, {
    approved: true,
  })
  assert.equal(late.status, 404)
  assert.equal(echoes('delta'), 0)
  // The session takes the next message (and parks again on it).
  await client.post(`/sessions/${sessionId}/messages`, { text: 'notes: epsilon' })
  await until('turn 2 parks', async () => {
    const s = await client.get(`/sessions/${sessionId}`)
    return s.body.status === 'parked' && s.body.turn === 2 ? true : undefined
  })
})
