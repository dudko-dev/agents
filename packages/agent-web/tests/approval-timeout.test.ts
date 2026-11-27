import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { z } from 'zod'
import {
  createAgent,
  defineTool,
  TOOL_APPROVAL_TIMEOUT_MS,
  type AgentEvent,
  type RunResult,
  type ToolApprovalDecision,
} from '../dist/index.js'
import { scriptedModel, stageOf } from './helpers/scripted-model.ts'

// `toolApproval.timeoutMs`, the wait's own bound: absent = 5 minutes, 0 / Infinity / more than a
// timer holds = until the run is stopped, negative / NaN = a configuration error. The whole loop
// on a scripted model and MOCKED timers - in a file of its own, away from the real-timer suites
// (`human-wait.test.ts`). Node's mock fires a delay past 2^31 - 1 (Infinity included) after 1 ms,
// as the real setTimeout does (and a browser's), so a bound handed to the timer unresolved shows
// here as a denial. The scripted model streams through 0 ms timers: those are run as the run
// moves. The elicitation's bound is the shared file's, tested on mocked timers in the Node
// package (`tests/mcp-elicitation-shared.test.ts`).

const MAX_TIMER_MS = 2 ** 31 - 1

const planJson = JSON.stringify({ thought: 'Plan.', steps: [{ description: 'Step s1' }] })

const of = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

const errorOf = (output: unknown): string =>
  output instanceof Error
    ? output.message
    : typeof output === 'string'
      ? output
      : JSON.stringify(output)

/**
 * A run whose one tool call asks a person who never answers (or answers with `answer`); returns
 * once the question is out, with the handler's signal and what had been emitted when it aborted.
 */
const askForever = async (
  t: TestContext,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
  answer: () => Promise<ToolApprovalDecision> = () => new Promise(() => {}),
) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ran: string[] = []
  const events: AgentEvent[] = []
  let hostSignal: AbortSignal | undefined
  let emittedAtAbort: string[] | undefined
  const { model } = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: planJson }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'finish', reason: 'done' }) }
      case 'synthesizer':
        return { text: 'All done.' }
      default:
        return info.toolResults < 1
          ? { toolCalls: [{ name: 'save_note', args: { text: 'a' } }] }
          : { text: 'reported' }
    }
  })
  const agent = await createAgent({
    model,
    toolMode: 'native',
    tools: {
      save_note: defineTool({
        description: 'Save a note',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => {
          ran.push(text)
          return `saved ${text}`
        },
      }),
    },
    toolApproval: {
      mode: 'ask-all',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      onRequest: (_req, ctx) => {
        hostSignal = ctx.signal
        ctx.signal.addEventListener('abort', () => {
          emittedAtAbort = events.map((e) => e.type)
        })
        return answer()
      },
    },
  })
  let result: RunResult | undefined
  void agent
    .run('Save it', { onEvent: (e) => events.push(e), ...(signal ? { signal } : {}) })
    .then((res) => {
      result = res
    })
  /** Let the run move: its promise chains (setImmediate is not mocked) and its 0 ms timers. */
  const move = async (until: () => boolean = () => false, max = 20): Promise<void> => {
    for (let i = 0; i < max && !until(); i += 1) {
      t.mock.timers.tick(0)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  await move(() => of(events, 'tool.approval-requested').length > 0, 500)
  assert.equal(of(events, 'tool.approval-requested').length, 1, 'the question was never put')
  return {
    ran,
    move,
    settled: () => of(events, 'tool.approval-resolved'),
    result: () => result,
    signal: () => hostSignal,
    emittedAtAbort: () => emittedAtAbort,
    finish: async (): Promise<RunResult> => {
      await move(() => result !== undefined, 2000)
      assert.ok(result, 'the run did not end')
      return result
    },
  }
}

test('approval: without toolApproval.timeoutMs a question waits 5 minutes, then the call is denied', async (t) => {
  assert.equal(TOOL_APPROVAL_TIMEOUT_MS, 300_000)
  const q = await askForever(t, undefined)
  t.mock.timers.tick(299_999)
  await q.move()
  assert.deepEqual(q.settled(), [], 'denied before the five minutes were up')
  t.mock.timers.tick(1)
  const result = await q.finish()
  const [resolved] = q.settled()
  assert.deepEqual([resolved.approved, resolved.automatic], [false, true])
  assert.match(String(resolved.reason), /no approval decision within 300000 ms/)
  const calls = result.trace.flatMap((s) => s.toolCalls)
  assert.deepEqual(
    calls.map((c) => [c.name, c.ok]),
    [['save_note', false]],
  )
  assert.match(errorOf(calls[0].output), /no approval decision within 300000 ms/)
  assert.deepEqual(q.ran, [])
  assert.equal(result.final, 'All done.')
})

for (const [label, timeoutMs] of [
  ['0', 0],
  ['Infinity', Infinity],
  ['more than a timer holds (2^31)', 2 ** 31],
] as const) {
  test(`approval: toolApproval.timeoutMs ${label} = no bound - the question waits until the run is stopped`, async (t) => {
    const controller = new AbortController()
    const q = await askForever(t, timeoutMs, controller.signal)
    // Not at ~1 ms (what setTimeout does with Infinity or a delay past 2^31 - 1), not at 0 ms,
    // not at the default, not at the longest delay a timer holds.
    for (const ms of [0, 1, 5, TOOL_APPROVAL_TIMEOUT_MS, MAX_TIMER_MS, MAX_TIMER_MS]) {
      t.mock.timers.tick(ms)
      await q.move()
      assert.deepEqual(q.settled(), [], `ended after a tick of ${ms} ms`)
      assert.equal(q.result(), undefined)
    }
    controller.abort(new Error('stopped by the user'))
    const result = await q.finish()
    assert.equal(result.stopped, true)
    const [resolved] = q.settled()
    assert.deepEqual(
      [resolved.approved, resolved.automatic, resolved.reason],
      [false, true, 'the run was stopped while waiting for approval'],
    )
    assert.deepEqual(q.ran, [])
  })
}

test('approval: a timeoutMs that is negative, NaN or not a number fails createAgent', async () => {
  const { model } = scriptedModel(() => ({ text: 'unused' }))
  for (const timeoutMs of [-1, -Infinity, Number.NaN, '300000']) {
    await assert.rejects(
      createAgent({ model, toolApproval: { mode: 'ask-all', timeoutMs: timeoutMs as number } }),
      new RegExp(
        `^Error: toolApproval\\.timeoutMs must be a number of milliseconds of at least 0 \\(0 or Infinity: no limit\\), got: ${typeof timeoutMs === 'string' ? `"${timeoutMs}"` : String(timeoutMs)}$`,
      ),
      String(timeoutMs),
    )
  }
})

// ── the host's signal (onRequest's second argument) ─────────────────────────

test('host signal: aborted when the bound runs out - a TimeoutError, before the resolved event', async (t) => {
  const q = await askForever(t, undefined)
  assert.equal(q.signal()?.aborted, false, 'not aborted while the question waits')
  t.mock.timers.tick(TOOL_APPROVAL_TIMEOUT_MS)
  await q.finish()
  const reason = q.signal()?.reason as Error
  assert.deepEqual(
    [q.signal()?.aborted, reason.name, reason.message],
    [true, 'TimeoutError', 'no approval decision within 300000 ms'],
  )
  // A host that closes its prompt hears of it before the agent reports the denial.
  assert.equal(q.emittedAtAbort()?.includes('tool.approval-resolved'), false)
  assert.ok(q.emittedAtAbort()?.includes('tool.approval-requested'))
})

test('host signal: aborted when the run is stopped', async (t) => {
  const controller = new AbortController()
  const q = await askForever(t, 0, controller.signal)
  controller.abort(new Error('stopped by the user'))
  await q.finish()
  const reason = q.signal()?.reason as Error
  assert.deepEqual(
    [q.signal()?.aborted, reason.name, reason.message],
    [true, 'AbortError', 'the run was stopped while waiting for approval'],
  )
  assert.equal(q.emittedAtAbort()?.includes('tool.approval-resolved'), false)
})

test('host signal: aborted when the handler fails', async (t) => {
  const boom = new Error('the dialog crashed')
  const q = await askForever(t, undefined, undefined, () => Promise.reject(boom))
  await q.finish()
  assert.equal(q.signal()?.reason, boom)
  assert.equal(q.settled()[0]?.reason, 'the dialog crashed')
})

test('host signal: never aborted once the host has answered - yes or no', async (t) => {
  for (const answer of [true, { approved: false, reason: 'no' }] as const) {
    const q = await askForever(t, undefined, undefined, () => Promise.resolve(answer))
    await q.finish()
    t.mock.timers.tick(TOOL_APPROVAL_TIMEOUT_MS * 2)
    await q.move()
    assert.equal(q.signal()?.aborted, false, JSON.stringify(answer))
    assert.equal(q.settled()[0]?.automatic, false)
    t.mock.timers.reset()
  }
})
