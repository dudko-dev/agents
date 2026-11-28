// Children wait for a person too (mirrors examples/swarm's tests/integration/child-parking.test.ts):
// a subagent child's run asks (ask-writes, the MCP `echo` is a write), parks; its items are the
// session's, owned by the child - the answer comes through the SAME route, the session's object
// checks it against the child's wait, and the child's instance resumes the SAME run: the write
// runs once, and the parent turn goes on with the child's answer. A partial answer keeps it
// waiting; a stop while it waits ends it and closes its items; an answer to it in another
// session's URL is not found.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  api,
  planJson,
  readStream,
  roundOf,
  stageOf,
  startStack,
  toolNames,
  toolResults,
  until,
  userOf,
  type IChatRequest,
  type ISessionState,
  type ISseEvent,
  type IStack,
} from './harness.ts'

let stack: IStack

const isChild = (req: IChatRequest): boolean => req.model === 'child-model'
// The child echoes each note of its task ("write: a, b"), in one round.
const notesOf = (req: IChatRequest): string[] =>
  /write: ([a-z, ]+)/
    .exec(userOf(req))?.[1]
    ?.split(',')
    .map((s) => s.trim()) ?? []

before(async () => {
  stack = await startStack(
    (req) => {
      const stage = stageOf(req)
      if (stage === 'replanner')
        return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
      if (isChild(req)) {
        if (stage === 'planner') return { text: planJson(['c']) }
        if (stage === 'synthesizer')
          return { text: `child: ${userOf(req).includes('echo:') ? 'written' : 'not written'}` }
        if (roundOf(req) === 0) {
          return { toolCalls: notesOf(req).map((text) => ({ name: 'docs__echo', args: { text } })) }
        }
        return { text: `results: ${toolResults(req).join(' | ')}` }
      }
      if (stage === 'planner') return { text: planJson(['a']) }
      if (stage === 'synthesizer') return { text: `final: ${userOf(req).slice(0, 3000)}` }
      if (roundOf(req) === 0 && toolNames(req).includes('writer')) {
        const task = /delegate: (write: [a-z, ]+)/.exec(userOf(req))?.[1] ?? 'write: x'
        return { toolCalls: [{ name: 'writer', args: { task } }] }
      }
      return { text: `results: ${toolResults(req).join(' | ')}` }
    },
    {
      AGENT_TOOL_APPROVAL: 'ask-writes',
      SUBAGENTS: JSON.stringify({
        writer: {
          description: 'Write the notes it is given',
          model: 'child-model',
          tools: ['docs__echo'],
          readOnly: true,
        },
      }),
    },
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
const waitingOf = (s: ISessionState) => s.parked?.waiting ?? []

test('(a) a subagent child asks for a write: it parks, the answer comes through the gateway, the write runs once', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'delegate: write: alpha' })
  const sessionId = body.sessionId as string
  const parked = await client.state(sessionId, (s) => waitingOf(s).length === 1)
  const waiting = waitingOf(parked)[0]!
  assert.equal(parked.status, 'parked')
  assert.equal(waiting.requests.length, 1)
  const item = waiting.requests[0]!.requestId
  assert.equal(echoes('alpha'), 0)
  // The parent's stream says the child waits, in the parked attempt's slot.
  const before = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    (seen) => seen.some((e) => e.data.event.type === 'subagent.waiting'),
  )
  const marker = before.events.find((e) => e.data.event.type === 'subagent.waiting')!
  assert.equal(marker.data.event.workflowId, waiting.workflowId)
  assert.deepEqual(
    (marker.data.event.requests as { requestId: string; toolName?: string }[]).map((r) => [
      r.requestId,
      r.toolName,
    ]),
    [[item, 'docs__echo']],
  )
  // Another session's URL: not found (the item is looked up in THAT session only).
  const other = (await client.post('/sessions', {})).body.sessionId as string
  const wrong = await client.post(`/sessions/${other}/answers/${item}`, { approved: true })
  assert.equal(wrong.status, 404)
  // A bad shape is refused before the child hears of it.
  assert.equal(
    (await client.post(`/sessions/${sessionId}/answers/${item}`, { yes: true })).status,
    400,
  )

  const ok = await client.post(`/sessions/${sessionId}/answers/${item}`, { approved: true })
  assert.equal(ok.status, 202)
  assert.equal((ok.body.child as { workflowId: string }).workflowId, waiting.workflowId)
  const done = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
    120_000,
  )
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /child: written/)
  assert.equal(echoes('alpha'), 1, 'the approved write ran exactly once')
  const types = done.events.map((e) => e.data.event.type).filter((t) => t.startsWith('subagent.'))
  assert.deepEqual(
    types.filter(
      (t) => t !== 'subagent.start' && t !== 'subagent.event' && t !== 'subagent.complete',
    ),
    ['subagent.started', 'subagent.waiting', 'subagent.resumed', 'subagent.ended'],
  )
  assert.equal(
    (await client.post(`/sessions/${sessionId}/answers/${item}`, { approved: true })).status,
    409,
  )
})

test('(d) a partial answer keeps the child waiting; the rest resumes it', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'delegate: write: beta, gamma' })
  const sessionId = body.sessionId as string
  const parked = await client.state(sessionId, (s) => waitingOf(s).length === 1)
  const [one, two] = waitingOf(parked)[0]!.requests
  assert.ok(one && two)
  await client.post(`/sessions/${sessionId}/answers/${one.requestId}`, { approved: true })
  await new Promise((r) => setTimeout(r, 1000))
  const still = await client.get(`/sessions/${sessionId}`)
  assert.equal(waitingOf(still.body as unknown as ISessionState).length, 1, 'still waiting')
  assert.equal(echoes('beta') + echoes('gamma'), 0)
  await client.post(`/sessions/${sessionId}/answers/${two.requestId}`, { approved: true })
  await client.state(sessionId, (s) => s.turns.some((t) => t.status === 'completed'), 120_000)
  assert.equal(echoes('beta'), 1)
  assert.equal(echoes('gamma'), 1)
})

test('(e) a stop while a child waits: the child ends, its item is closed, a later answer is refused', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'delegate: write: delta' })
  const sessionId = body.sessionId as string
  const parked = await client.state(sessionId, (s) => waitingOf(s).length === 1)
  const item = waitingOf(parked)[0]!.requests[0]!.requestId
  assert.equal((await client.post(`/sessions/${sessionId}/stop`, {})).status, 202)
  await client.state(sessionId, (s) => s.turns.some((t) => t.status === 'stopped'))
  const listed = await client.get(`/sessions/${sessionId}/subagents`)
  const sub = (listed.body.subagents as { events: string }[])[0]!
  const child = await readStream(`${stack.base}${sub.events}`, client.headers, ended(1))
  assert.equal(child.events.at(-1)!.data.event.status, 'stopped')
  await until('the item closed', async () => {
    const late = await client.post(`/sessions/${sessionId}/answers/${item}`, { approved: true })
    return late.status === 404 ? true : undefined
  })
  assert.equal(echoes('delta'), 0)
})
