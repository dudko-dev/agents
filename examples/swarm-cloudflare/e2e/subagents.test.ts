// Static subagents as Workflow instances (mirrors examples/swarm's tests/integration/
// subagents.test.ts): two calls in one round park the turn with two items; the session's object
// starts a `SubagentWorkflow` instance per item - side by side - each running the profile's agent
// in its own stream (`<session>/<item>`); their outcomes answer the items and the turn resumes
// with both. The per-round cap; a stop while the children run.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  compareCursors,
  parseCursor,
  SUBAGENT_MARKER_SEQ,
  subagentWorkflowIdOf,
  type ICursor,
} from 'swarm-shared'
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
  type ISseEvent,
  type IStack,
} from './harness.ts'

let stack: IStack
const childAsked: Record<string, number[]> = {}
const CHILD_DELAY_MS = 1500

const taskOf = (req: IChatRequest): string | undefined =>
  /look into ([a-z]+)/.exec(userOf(req))?.[1]
const isChild = (req: IChatRequest): boolean => req.model === 'child-model'

before(async () => {
  stack = await startStack(
    (req) => {
      const stage = stageOf(req)
      if (stage === 'replanner')
        return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
      if (isChild(req)) {
        const task = taskOf(req) ?? '?'
        if (stage === 'planner') return { text: planJson(['c']) }
        if (stage === 'synthesizer') return { text: `child says ${task}` }
        ;(childAsked[task] ??= []).push(Date.now())
        return { text: `looked into ${task}`, delayMs: task === 'slow' ? 30_000 : CHILD_DELAY_MS }
      }
      if (stage === 'planner') return { text: planJson(['a']) }
      if (stage === 'synthesizer') return { text: `final: ${userOf(req).slice(0, 3000)}` }
      if (roundOf(req) === 0 && toolNames(req).includes('researcher')) {
        const tasks = /research these: ([a-z, ]+)/.exec(userOf(req))?.[1]?.split(',') ?? []
        return {
          toolCalls: tasks.map((t) => ({
            name: 'researcher',
            args: { task: `look into ${t.trim()}` },
          })),
        }
      }
      return { text: `results: ${toolResults(req).join(' | ')}` }
    },
    {
      SUBAGENTS: JSON.stringify({
        researcher: {
          description: 'Look into one thing and report what you found',
          model: 'child-model',
          systemPrompt: 'You are a careful researcher.',
          readOnly: true,
        },
      }),
      SUBAGENT_MAX_PER_ROUND: '2',
    },
  )
})

after(async () => {
  await stack?.stop()
})

const ended = (turn: number) => (seen: ISseEvent[]) =>
  seen.some((e) => e.data.event.type === 'turn.ended' && e.data.turn === turn)
const cursorOf = (e: ISseEvent): ICursor => {
  const parsed = parseCursor(e.id)
  assert.ok(parsed.ok)
  return parsed.cursor
}

test('two subagent calls in one round: two Workflow instances side by side, the turn resumes with both', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'research these: alpha, beta' })
  const sessionId = body.sessionId as string
  const stream = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
    120_000,
  )
  const events = stream.events
  for (let i = 1; i < events.length; i++) {
    assert.ok(compareCursors(cursorOf(events[i - 1]!), cursorOf(events[i]!)) < 0, 'in order')
  }
  const end = events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /child says alpha/)
  assert.match(String(end.text), /child says beta/)
  // Side by side: each child's executor was asked before the other had answered.
  const [a, b] = [childAsked.alpha?.[0], childAsked.beta?.[0]]
  assert.ok(a && b && Math.abs(a - b) < CHILD_DELAY_MS, `alpha ${a}, beta ${b}`)

  // The markers, in the parked attempt's slot, between run.parked and the resumed attempt.
  const types = events.map((e) => e.data.event.type)
  const parkedAt = types.indexOf('run.parked')
  const own = events.filter(
    (e) => e.data.event.type.startsWith('subagent.') && e.data.event.itemId !== undefined,
  )
  assert.deepEqual(
    own.map((e) => e.data.event.type),
    ['subagent.started', 'subagent.started', 'subagent.ended', 'subagent.ended'],
  )
  const slot = cursorOf(events[parkedAt]!).attempt
  for (const m of own) {
    assert.equal(cursorOf(m).attempt, slot)
    assert.ok(cursorOf(m).seq >= SUBAGENT_MARKER_SEQ)
    assert.ok(events.indexOf(m) > parkedAt)
  }
  const resumedAt = events.findIndex((e) => e.data.event.attempt === 2)
  assert.ok(resumedAt > events.indexOf(own.at(-1)!), 'the markers come before the resumed attempt')

  // The children: listed, answered, named after session + run + item; each one's own stream.
  const listed = await client.get(`/sessions/${sessionId}/subagents`)
  const subs = listed.body.subagents as {
    itemId: string
    runId: string
    state: string
    workflowId: string
    task: string
    events: string
  }[]
  assert.deepEqual(
    subs.map((s) => s.state),
    ['answered', 'answered'],
  )
  assert.deepEqual(subs.map((s) => s.task).sort(), ['look into alpha', 'look into beta'])
  for (const s of subs) {
    assert.equal(s.workflowId, subagentWorkflowIdOf(sessionId, s.runId, s.itemId))
    const child = await readStream(`${stack.base}${s.events}`, client.headers, ended(1))
    const childTypes = child.events.map((e) => e.data.event.type)
    assert.equal(childTypes[0], 'turn.started')
    assert.ok(childTypes.includes('plan.created'))
    assert.equal(child.events.at(-1)!.data.event.status, 'completed')
    assert.match(String(child.events.at(-1)!.data.event.text), /child says (alpha|beta)/)
  }
  // An item of the session that a subagent answers is not a client's.
  const own0 = subs[0]!
  const refused = await client.post(`/sessions/${sessionId}/answers/${own0.itemId}`, {
    output: 'mine',
  })
  assert.equal(refused.status, 409)
})

test('the per-round cap: a call beyond it is a tool error the model reads, never a child', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', {
    message: 'research these: gamma, delta, epsilon',
  })
  const sessionId = body.sessionId as string
  const stream = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
    120_000,
  )
  const end = stream.events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /at most 2 subagent calls in one round/)
  const listed = await client.get(`/sessions/${sessionId}/subagents`)
  assert.equal((listed.body.subagents as unknown[]).length, 2)
  assert.equal(childAsked.epsilon, undefined, 'the third call started no child')
})

test('stop while the children run: the turn ends as stopped, the children are stopped', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'research these: slow' })
  const sessionId = body.sessionId as string
  await until('the slow child', () => (childAsked.slow?.length ? true : undefined), 60_000)
  assert.equal((await client.post(`/sessions/${sessionId}/stop`, {})).status, 202)
  const stream = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
  )
  assert.equal(stream.events.at(-1)!.data.event.status, 'stopped')
  const listed = await client.get(`/sessions/${sessionId}/subagents`)
  const sub = (listed.body.subagents as { events: string; state: string }[])[0]!
  assert.equal(sub.state, 'cancelled')
  // The child saw the stop at its next heartbeat: its own stream ends stopped, long before the
  // slow answer would have come.
  const child = await readStream(`${stack.base}${sub.events}`, client.headers, ended(1), 30_000)
  assert.equal(child.events.at(-1)!.data.event.status, 'stopped')
})
