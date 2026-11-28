// A turn whose step dies mid-run resumes from its journal (mirrors examples/swarm's
// tests/integration/crash.test.ts): what the attempt before had done - the planner's answer, the
// executor's call of the write tool, the tool's result - is REPLAYED, not done again: the model is
// not asked again for a call on record, the write does not run twice.
//
//   (a) the step throws: after the write, the provider fails the next step's call (a 500, past
//       the AI SDK's own retries), the run fails, the engine retries the step - the next attempt
//       resumes the run from its checkpoint, and the planner and the step that wrote are not asked
//       again;
//   (b) the Worker dies: `wrangler dev` (wrangler and workerd) is killed while the step waits for
//       the model, and started again on the same state - the Workflow goes on where it was.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  api,
  planJson,
  readStream,
  roundOf,
  stageOf,
  startStack,
  stepOf,
  toolResults,
  until,
  userOf,
  type IChatRequest,
  type ISseEvent,
  type IStack,
} from './harness.ts'

let stack: IStack
// Per note: how many of its step-b calls fail (the AI SDK retries a 500 itself, twice: three
// failures fail the first attempt), and whether the executor's second round is slow the first time
// it is asked.
const failing = new Map<string, number>()
const slowOnce = new Set<string>()

const noteOf = (req: IChatRequest): string =>
  /note: ([a-z]+)/.exec(JSON.stringify(req.messages))?.[1] ?? '?'

before(async () => {
  stack = await startStack(
    (req) => {
      const stage = stageOf(req)
      if (stage === 'planner') return { text: planJson(['a', 'b']) }
      if (stage === 'replanner')
        return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
      const note = noteOf(req)
      if (stage === 'synthesizer') return { text: `final: ${userOf(req).slice(0, 4000)}` }
      if (stepOf(req) === 'b') {
        const left = failing.get(note) ?? 0
        if (left > 0) {
          failing.set(note, left - 1)
          return { status: 500, text: 'the provider is down' }
        }
        return { text: 'b done' }
      }
      if (roundOf(req) === 0) return { toolCalls: [{ name: 'docs__echo', args: { text: note } }] }
      if (slowOnce.delete(note))
        return { text: `results: ${toolResults(req).join(' | ')}`, delayMs: 8000 }
      return { text: `results: ${toolResults(req).join(' | ')}` }
    },
    { AGENT_LLM_MAX_RETRIES: '0' },
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
const asked = (note: string, stage: string, round?: number, step = 'a'): number =>
  stack.model.requests.filter(
    (r) =>
      noteOf(r) === note &&
      stageOf(r) === stage &&
      (stage !== 'executor' || stepOf(r) === step) &&
      (round === undefined || roundOf(r) === round),
  ).length

test('(a) the step throws after the write: the retried step replays the journal, nothing runs twice', async () => {
  failing.set('alpha', 3)
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'note: alpha' })
  const sessionId = body.sessionId as string
  const done = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
    120_000,
  )
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'completed', JSON.stringify(end))
  assert.match(String(end.text), /echo:alpha/)
  assert.equal(echoes('alpha'), 1, 'the write ran once')
  assert.equal(asked('alpha', 'planner'), 1, 'the planner was not asked again')
  assert.equal(asked('alpha', 'executor', 0), 1, 'the step that wrote was not asked again')
  assert.equal(asked('alpha', 'executor', 1), 1)
  assert.equal(asked('alpha', 'executor', undefined, 'b'), 4, 'the failed call, again, live')
  // The second attempt is in the stream, after the first.
  assert.ok(done.events.some((e) => e.data.event.attempt === 2))
  assert.equal(end.attempt, 2)
})

test('(b) the Worker is killed mid-step: started again, the turn goes on and the write runs once', async () => {
  slowOnce.add('beta')
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'note: beta' })
  const sessionId = body.sessionId as string
  // The write ran; the step now waits for the model's slow answer.
  await until('the write', () => (echoes('beta') === 1 ? true : undefined))
  await until('the slow call', () => (asked('beta', 'executor', 1) === 1 ? true : undefined))
  await stack.restart()
  const done = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    ended(1),
    180_000,
  )
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'completed', JSON.stringify(end))
  assert.equal(echoes('beta'), 1, 'the write ran once')
  assert.equal(asked('beta', 'planner'), 1, 'the planner was not asked again')
  assert.equal(asked('beta', 'executor', 0), 1, 'the call of the write was replayed')
})
