// The turn activity in Temporal's MockActivityEnvironment (no server): which run a retry finds,
// how a stop, a lost lease, a refusal and a failure come out, and that the lease is held through
// the activity's turn scope.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActivityCancellationDetails, ApplicationFailure } from '@temporalio/common'
import { MockActivityEnvironment } from '@temporalio/testing'
import {
  ModelCallRefusedError,
  RunLeaseError,
  type AgentEvent,
  type IAgentRunOptions,
  type IAgentRunResult,
  type IRunSnapshot,
} from '@dudko.dev/agent'
import { createActivities, isAuthError, planTurn, revokedReason } from '../src/activities.ts'
import type { IEventStore, IEventWriter, TurnMarker } from '../src/db/events.ts'
import type { IRunBinding, IRunRow, IRunStore } from '../src/db/runs.ts'
import { createHeartbeatLease } from '../src/lease.ts'
import { silentLogger } from '../src/log.ts'
import { TURN_REFUSED } from '../src/session-api.ts'
import type { ITurnInput } from '../src/session-types.ts'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const plan = { thought: 't', steps: [{ id: 'a', description: 'a', expectedOutcome: 'a' }] }
const snapshot = (
  status: IRunSnapshot['status'],
  extra: Partial<IRunSnapshot> = {},
): IRunSnapshot => ({
  runId: 'run-1',
  startedAt: 1,
  status,
  input: 'hi',
  plan,
  trace: [],
  usage,
  stepIndex: 0,
  iterations: 0,
  revisions: 0,
  attempt: 1,
  ...extra,
})
const row = (snap: IRunSnapshot | null, extra: Partial<IRunRow> = {}): IRunRow => ({
  runId: 'run-1',
  sessionId: 's',
  turn: 1,
  runNo: 1,
  attemptBase: 0,
  attempt: snap?.attempt ?? 1,
  status: snap?.status ?? null,
  snapshot: snap,
  ...extra,
})

test('planTurn: fresh, resume, already complete, stopped, died before its plan', () => {
  assert.deepEqual(planTurn(undefined), { kind: 'fresh', runNo: 1, first: true })
  assert.deepEqual(planTurn(row(snapshot('executing'), { attemptBase: 2 })), {
    kind: 'resume',
    runId: 'run-1',
    attemptBase: 2,
  })
  assert.equal(planTurn(row(snapshot('failed'))).kind, 'resume', 'a failed attempt goes on')
  assert.equal(planTurn(row(snapshot('complete'))).kind, 'completed')
  assert.equal(planTurn(row(snapshot('cancelled'))).kind, 'stopped')
  assert.deepEqual(planTurn(row(null, { runNo: 2 })), { kind: 'fresh', runNo: 3, first: false })
  const { plan: _p, ...noPlan } = snapshot('executing')
  void _p
  assert.equal(planTurn(row(noPlan)).kind, 'fresh')
})

test('revokedReason: what moves a turn; a user stop does not', () => {
  assert.equal(revokedReason(undefined), undefined)
  assert.equal(revokedReason(new ActivityCancellationDetails({ cancelRequested: true })), undefined)
  for (const flag of ['timedOut', 'workerShutdown', 'reset', 'paused', 'notFound'] as const) {
    assert.ok(revokedReason(new ActivityCancellationDetails({ [flag]: true })), flag)
  }
})

test('isAuthError: 401 / 403 anywhere down the cause chain', () => {
  assert.equal(isAuthError({ statusCode: 401 }), true)
  assert.equal(isAuthError(new Error('x', { cause: { status: 403 } })), true)
  assert.equal(isAuthError({ lastError: { statusCode: 401 } }), true)
  assert.equal(isAuthError({ statusCode: 500 }), false)
  const loop: { cause?: unknown } = {}
  loop.cause = loop
  assert.equal(isAuthError(loop), false)
})

// --- runTurn over fakes ------------------------------------------------------------------------

interface IHarness {
  latest?: IRunRow
  base?: number
  run: (o: IAgentRunOptions) => Promise<IAgentRunResult>
}

const setup = (h: IHarness) => {
  const bound: IRunBinding[] = []
  const markers: TurnMarker[] = []
  const pushed: AgentEvent[] = []
  let flushes = 0
  const runs: IRunStore = {
    bindRun: async (b) => {
      bound.push(b)
      return true
    },
    latestRunOfTurn: async () => h.latest,
    nextAttemptBase: async () => h.base ?? 0,
  }
  const events: IEventStore = {
    writer: (): IEventWriter => ({
      push: (e) => void pushed.push(e),
      flush: async () => void (flushes += 1),
    }),
    marker: async (m) => void markers.push(m),
    after: async () => [],
  }
  const lease = createHeartbeatLease({ bindRun: runs.bindRun, ttlMs: 3000, owner: 'w' })
  // The core's part in miniature: take the lease, then run.
  const agent = {
    run: async (o: IAgentRunOptions) => {
      const runId = o.resumeFromRunId ?? 'fresh-run'
      if (!(await lease.acquire(runId, { owner: 'w', ttlMs: 3000 }))) {
        throw new RunLeaseError(runId, 'w', false, 'refused')
      }
      try {
        return await h.run(o)
      } finally {
        await lease.release(runId, { owner: 'w' })
      }
    },
  }
  const activities = createActivities({ agent, runs, events, log: silentLogger })
  return { activities, bound, markers, pushed, flushes: () => flushes, lease }
}

const input: ITurnInput = {
  sessionId: 's',
  turn: 1,
  input: 'hello',
  history: [{ role: 'user', content: 'before' }],
  messageIds: ['m1'],
}
const result = (text: string): IAgentRunResult => ({ text, plan, trace: [], iterations: 1, usage })

test('a fresh turn: the run is bound to the turn at acquire, its events are written', async () => {
  let seen: IAgentRunOptions | undefined
  const t = setup({
    run: async (o) => {
      seen = o
      o.onEvent?.({ type: 'plan.created', plan, runId: 'fresh-run', seq: 1, attempt: 1 })
      return result('hi there')
    },
  })
  const env = new MockActivityEnvironment()
  const heartbeats: unknown[] = []
  env.on('heartbeat', (d) => heartbeats.push(d))
  const out = await env.run(t.activities.runTurn, input)
  assert.deepEqual(out, {
    status: 'completed',
    runId: 'fresh-run',
    attempt: 1,
    text: 'hi there',
    usage,
  })
  assert.equal(seen?.input, 'hello')
  assert.deepEqual(seen?.history, input.history)
  assert.equal(seen?.resumeFromRunId, undefined)
  assert.deepEqual(t.bound, [
    { runId: 'fresh-run', sessionId: 's', turn: 1, runNo: 1, attemptBase: 0 },
  ])
  assert.equal(t.markers[0]?.kind, 'started')
  assert.deepEqual(t.markers[0]?.body, { messageIds: ['m1'], input: 'hello' })
  assert.equal(t.pushed.length, 1)
  assert.ok(t.flushes() >= 1, 'flushed before returning')
  assert.deepEqual(heartbeats, [{ runId: 'fresh-run', attempt: 1, seq: 1 }])
})

test('a retried turn resumes its run; a finished one returns its result without running', async () => {
  let seen: IAgentRunOptions | undefined
  const t = setup({
    latest: row(snapshot('executing', { runId: 'run-1' }), { attemptBase: 0 }),
    run: async (o) => {
      seen = o
      o.onEvent?.({ type: 'final', text: 'x', runId: 'run-1', seq: 1, attempt: 2 })
      return result('resumed')
    },
  })
  const out = await new MockActivityEnvironment().run(t.activities.runTurn, input)
  assert.equal(seen?.resumeFromRunId, 'run-1')
  assert.equal(seen?.input, '')
  assert.equal(seen?.history, undefined, 'the snapshot has the history')
  assert.deepEqual(t.bound, [], 'a resumed run is already bound')
  assert.deepEqual(out, { status: 'completed', runId: 'run-1', attempt: 2, text: 'resumed', usage })

  let ran = false
  const done = setup({
    latest: row(snapshot('complete', { text: 'was done', attempt: 3 })),
    run: async () => {
      ran = true
      return result('no')
    },
  })
  assert.deepEqual(await new MockActivityEnvironment().run(done.activities.runTurn, input), {
    status: 'completed',
    runId: 'run-1',
    attempt: 3,
    text: 'was done',
    usage,
  })
  const stopped = setup({ latest: row(snapshot('cancelled')), run: async () => result('no') })
  assert.equal(
    (await new MockActivityEnvironment().run(stopped.activities.runTurn, input)).status,
    'stopped',
  )
  assert.equal(ran, false)
})

test('a turn whose first run died before its plan starts a second run above its attempts', async () => {
  const t = setup({
    latest: row(null, { runId: 'dead', runNo: 1 }),
    base: 1,
    run: async () => result('again'),
  })
  await new MockActivityEnvironment().run(t.activities.runTurn, input)
  assert.deepEqual(t.bound, [
    { runId: 'fresh-run', sessionId: 's', turn: 1, runNo: 2, attemptBase: 1 },
  ])
})

const waitForAbort = (o: IAgentRunOptions): Promise<never> =>
  new Promise((_, reject) => {
    o.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true,
    })
  })

test("a user's stop aborts the run; the turn is stopped", async () => {
  const env = new MockActivityEnvironment()
  let signal: AbortSignal | undefined
  const t = setup({
    run: (o) => {
      signal = o.signal
      o.onEvent?.({
        type: 'step.start',
        step: plan.steps[0]!,
        index: 0,
        runId: 'fresh-run',
        seq: 1,
        attempt: 1,
      })
      setTimeout(
        () => env.cancel('CANCELLED', new ActivityCancellationDetails({ cancelRequested: true })),
        10,
      )
      return waitForAbort(o)
    },
  })
  const out = await env.run(t.activities.runTurn, input)
  assert.deepEqual(out, { status: 'stopped', runId: 'fresh-run', attempt: 1 })
  assert.equal(signal?.aborted, true)
})

test('a lost lease (heartbeat timed out, shutdown) moves the turn: a retryable failure', async () => {
  const env = new MockActivityEnvironment()
  let renewed: boolean | undefined
  const t = setup({
    run: async (o) => {
      env.cancel('TIMED_OUT', new ActivityCancellationDetails({ timedOut: true }))
      // The lease's next renew says no: the core would abort the run and throw RunLeaseError.
      renewed = await t.lease.renew('fresh-run', { owner: 'w', ttlMs: 3000 })
      assert.equal(o.signal?.aborted, false, 'the activity leaves the abort to the lease')
      throw new RunLeaseError('fresh-run', 'w', true, 'refused')
    },
  })
  await assert.rejects(
    async () => env.run(t.activities.runTurn, input),
    (err: unknown) =>
      err instanceof ApplicationFailure && err.type === 'TurnMoved' && !err.nonRetryable,
  )
  assert.equal(renewed, false)
})

test('a refusal and refused credentials are not retried; any other failure is', async () => {
  const refused = setup({
    run: async () => {
      throw new ModelCallRefusedError({ stage: 'executor', modelId: 'm' }, new Error('rate limit'))
    },
  })
  await assert.rejects(
    async () => new MockActivityEnvironment().run(refused.activities.runTurn, input),
    (err: unknown) =>
      err instanceof ApplicationFailure && err.type === TURN_REFUSED && err.nonRetryable === true,
  )
  const auth = setup({
    run: async () => {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    },
  })
  await assert.rejects(
    async () => new MockActivityEnvironment().run(auth.activities.runTurn, input),
    (err: unknown) => err instanceof ApplicationFailure && err.nonRetryable === true,
  )
  const flaky = setup({
    run: async () => {
      throw new Error('provider 503')
    },
  })
  await assert.rejects(
    async () => new MockActivityEnvironment().run(flaky.activities.runTurn, input),
    (err: unknown) =>
      err instanceof ApplicationFailure && err.type === 'TurnFailed' && !err.nonRetryable,
  )
})

test('endTurn writes the turn.ended marker', async () => {
  const t = setup({ run: async () => result('x') })
  await new MockActivityEnvironment().run(t.activities.endTurn, {
    sessionId: 's',
    turn: 2,
    status: 'failed',
    error: 'boom',
  })
  assert.deepEqual(t.markers, [
    { kind: 'ended', sessionId: 's', turn: 2, body: { status: 'failed', error: 'boom' } },
  ])
})
