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
  type IAgentConfig,
  type IAgentRunOptions,
  type IAgentRunResult,
  type IRunSnapshot,
  type PipelineDefinition,
} from '@dudko.dev/agent'
import {
  PIPELINE_TEXT_MAX_CHARS,
  pipelineNodeStreamOf,
  pipelineWorkflowIdOf,
  subagentWorkflowIdOf,
  type IParkedRow,
  type IPipelineNodeInput,
  type IStreamBatch,
  type IStreamMarker,
  type ISubagentInput,
  type ITurnInput,
} from 'swarm-shared'
import {
  coreAnswersOf,
  createActivities,
  isAuthError,
  pipelineCallOf,
  type IActivityDeps,
  planTurn,
  requestsOf,
  revokedReason,
  runIdOf,
  SUBAGENT_TEXT_MAX_CHARS,
  subagentCallOf,
} from '../src/activities.ts'
import type { IEventStore, IEventWriter, TurnMarker } from '../src/db/events.ts'
import type { IParkedStore } from '../src/db/parked.ts'
import type { IRunBinding, IRunRow, IRunStore } from '../src/db/runs.ts'
import type { ChildAsk } from '../src/child-ask.ts'
import { createHeartbeatLease, currentTurnScope } from '../src/lease.ts'
import { silentLogger } from '../src/log.ts'
import { pipelineDispatch } from '../src/pipelines.ts'
import { TURN_REFUSED } from '../src/session-api.ts'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
// The id the activity names the first run of turn 1 of session 's' (run({ runId })).
const FRESH = runIdOf('s', 1, 1)
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
  // A run with nothing to resume is superseded by the next one.
  assert.deepEqual(planTurn(row(null, { runNo: 2 })), {
    kind: 'fresh',
    runNo: 3,
    first: false,
    supersedes: 'run-1',
  })
  const { plan: _p, ...noPlan } = snapshot('executing')
  void _p
  assert.deepEqual(planTurn(row(noPlan)), {
    kind: 'fresh',
    runNo: 2,
    first: false,
    supersedes: 'run-1',
  })
})

test('revokedReason: what moves a turn; a user stop does not', () => {
  assert.equal(revokedReason(undefined), undefined)
  assert.equal(revokedReason(new ActivityCancellationDetails({ cancelRequested: true })), undefined)
  for (const flag of ['timedOut', 'workerShutdown', 'reset', 'paused', 'notFound'] as const) {
    assert.ok(revokedReason(new ActivityCancellationDetails({ [flag]: true })), flag)
  }
})

test("isAuthError (the core's, re-exported): 401 / 403 anywhere down the cause chain", () => {
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
  // latestRunOfTurn's answers in turn (the last one repeats), in place of `latest`.
  latests?: (IRunRow | undefined)[]
  // What supersedeRun answers (default: superseded).
  supersede?: (runId: string) => boolean
  base?: number
  run: (o: IAgentRunOptions) => Promise<IAgentRunResult>
  // The static subagents' agents (their run, by name).
  subagents?: Record<string, (o: IAgentRunOptions) => Promise<IAgentRunResult>>
  // The pipelines: their definitions and their nodes' agents (their run, by node id).
  pipelines?: Record<
    string,
    {
      definition: PipelineDefinition
      runs: Record<string, (o: IAgentRunOptions) => Promise<IAgentRunResult>>
    }
  >
  pickRoute?: IActivityDeps['pickRoute']
  // The agent as it is, without the lease taken first (a run that ends before it takes one).
  unleased?: boolean
  childAsk?: ChildAsk
}

const setup = (h: IHarness) => {
  const bound: IRunBinding[] = []
  const fenced: string[] = []
  const markers: TurnMarker[] = []
  const streamMarkers: IStreamMarker[] = []
  const pushed: AgentEvent[] = []
  const recorded: Omit<IParkedRow, 'state'>[] = []
  const answered: { sessionId: string; ids: string[] }[] = []
  const cancelled: { sessionId: string; turn: number }[] = []
  const closed: { sessionId: string; owner: string }[] = []
  const latestAsked: { stream: string; turn: number }[] = []
  const batches: IStreamBatch[] = []
  const superseded: string[] = []
  // The store's calls and the run's start, in order.
  const trail: string[] = []
  let flushes = 0
  const runs: IRunStore = {
    bindRun: async (b) => {
      trail.push(`bind ${b.runId}`)
      bound.push(b)
      return true
    },
    fenceRun: async (runId) => {
      trail.push(`fence ${runId}`)
      fenced.push(runId)
      return 2
    },
    supersedeRun: async (runId) => {
      trail.push(`supersede ${runId}`)
      superseded.push(runId)
      return h.supersede ? h.supersede(runId) : true
    },
    latestRunOfTurn: async (stream, turn) => {
      trail.push('latest')
      latestAsked.push({ stream, turn })
      return h.latests ? h.latests[Math.min(latestAsked.length, h.latests.length) - 1] : h.latest
    },
    nextAttemptBase: async () => {
      trail.push('base')
      return h.base ?? 0
    },
  }
  const events: IEventStore = {
    writer: (): IEventWriter => ({
      push: (e) => void pushed.push(e),
      flush: async () => void (flushes += 1),
    }),
    marker: async (m) => void markers.push(m),
    streamMarkers: async (m) => void streamMarkers.push(...m),
    streamBatch: async (b) => void batches.push(b),
    after: async () => [],
  }
  const parked: IParkedStore = {
    record: async (rows) => void recorded.push(...rows),
    markAnswered: async (sessionId, ids) => void answered.push({ sessionId, ids }),
    cancelTurn: async (sessionId, turn) => void cancelled.push({ sessionId, turn }),
    cancelOwned: async (sessionId, owner) => void closed.push({ sessionId, owner }),
    item: async () => undefined,
    subagents: async () => [],
    pipelines: async () => [],
  }
  const lease = createHeartbeatLease({
    bindRun: runs.bindRun,
    fenceRun: runs.fenceRun,
    ttlMs: 3000,
    owner: 'w',
  })
  // The core's part in miniature: take the lease, then run.
  const leased = (run: (o: IAgentRunOptions) => Promise<IAgentRunResult>) => ({
    run: async (o: IAgentRunOptions) => {
      const runId = o.resumeFromRunId ?? o.runId ?? 'unnamed'
      trail.push(`run ${runId}`)
      if (!(await lease.acquire(runId, { owner: 'w', ttlMs: 3000 }))) {
        throw new RunLeaseError(runId, 'w', false, 'refused')
      }
      try {
        return await run(o)
      } finally {
        await lease.release(runId, { owner: 'w' })
      }
    },
  })
  const activities = createActivities({
    agent: h.unleased ? { run: h.run } : leased(h.run),
    runs,
    events,
    parked,
    log: silentLogger,
    subagents: new Map(Object.entries(h.subagents ?? {}).map(([k, run]) => [k, leased(run)])),
    pipelines: new Map(
      Object.entries(h.pipelines ?? {}).map(([name, p]) => [
        name,
        {
          definition: p.definition,
          nodes: new Map(
            p.definition.nodes.map((node) => [
              node.id,
              {
                node,
                agent: leased(p.runs[node.id] ?? (async () => result(`${node.id} says ok`))),
                config: { model: `config-of-${node.id}` } as unknown as IAgentConfig,
              },
            ]),
          ),
        },
      ]),
    ),
    ...(h.pickRoute ? { pickRoute: h.pickRoute } : {}),
    ...(h.childAsk ? { childAsk: h.childAsk } : {}),
    routeHeartbeatMs: 5,
  })
  return {
    activities,
    bound,
    fenced,
    superseded,
    trail,
    markers,
    streamMarkers,
    pushed,
    recorded,
    answered,
    cancelled,
    closed,
    latestAsked,
    batches,
    flushes: () => flushes,
    lease,
  }
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
      o.onEvent?.({ type: 'plan.created', plan, runId: FRESH, seq: 1, attempt: 1 })
      return result('hi there')
    },
  })
  const env = new MockActivityEnvironment()
  const heartbeats: unknown[] = []
  env.on('heartbeat', (d) => heartbeats.push(d))
  const out = await env.run(t.activities.runTurn, input)
  assert.deepEqual(out, {
    status: 'completed',
    runId: FRESH,
    attempt: 1,
    text: 'hi there',
    usage,
  })
  assert.equal(seen?.input, 'hello')
  assert.deepEqual(seen?.history, input.history)
  assert.equal(seen?.resumeFromRunId, undefined)
  assert.equal(seen?.runId, FRESH, 'the activity names the fresh run (session, turn, run no)')
  assert.deepEqual(t.bound, [{ runId: FRESH, sessionId: 's', turn: 1, runNo: 1, attemptBase: 0 }])
  assert.equal(t.markers[0]?.kind, 'started')
  assert.deepEqual(t.markers[0]?.body, { messageIds: ['m1'], input: 'hello' })
  assert.equal(t.pushed.length, 1)
  assert.ok(t.flushes() >= 1, 'flushed before returning')
  assert.deepEqual(heartbeats, [{ runId: FRESH, attempt: 1, seq: 1 }])
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

test('a turn whose first run died before its plan supersedes it, then starts a second run above its attempts', async () => {
  const t = setup({
    latest: row(null, { runId: 'dead', runNo: 1 }),
    base: 1,
    run: async () => result('again'),
  })
  await new MockActivityEnvironment().run(t.activities.runTurn, input)
  const second = runIdOf('s', 1, 2)
  assert.deepEqual(t.bound, [{ runId: second, sessionId: 's', turn: 1, runNo: 2, attemptBase: 1 }])
  // The first run is fenced off before anything of the second one: its attempt base, its run,
  // its bind (the run may still be running on a worker that lost the turn).
  assert.deepEqual(t.trail, ['latest', 'supersede dead', 'base', `run ${second}`, `bind ${second}`])
})

test('nothing is superseded by a first run, a resume, or a run that is done, stopped or parked', async () => {
  const item = { id: 'p1', kind: 'tool', toolName: 't', input: {}, note: 'n' }
  const waiting = snapshot('waiting', { parked: { runId: 'run-1', items: [item as never], at: 1 } })
  for (const latest of [
    undefined,
    row(snapshot('executing')),
    row(snapshot('complete', { text: 'done' })),
    row(snapshot('cancelled')),
    row(waiting),
  ]) {
    const t = setup({ ...(latest ? { latest } : {}), run: async () => result('ok') })
    await new MockActivityEnvironment().run(t.activities.runTurn, input)
    assert.deepEqual(t.superseded, [], latest?.snapshot?.status ?? 'no run yet')
  }
})

test('a run that put its plan on record after it was read is resumed, not superseded', async () => {
  let seen: IAgentRunOptions | undefined
  const t = setup({
    // Read with no snapshot; by the time the fence is raised, its plan is on record.
    latests: [row(null, { runId: 'late' }), row(snapshot('executing'), { runId: 'late' })],
    supersede: () => false,
    run: async (o) => {
      seen = o
      return result('resumed')
    },
  })
  const out = await new MockActivityEnvironment().run(t.activities.runTurn, input)
  assert.equal(seen?.resumeFromRunId, 'late')
  assert.deepEqual(t.bound, [], 'no second run')
  assert.deepEqual(t.trail, ['latest', 'supersede late', 'latest', 'run late', 'fence late'])
  assert.equal(out.status, 'completed')

  // Still nothing to resume after a refused supersede (the row changed under the turn): the
  // attempt is retried, and nothing runs.
  let ran = false
  const odd = setup({
    latests: [row(null, { runId: 'a' }), row(null, { runId: 'b', runNo: 2 })],
    supersede: () => false,
    run: async () => {
      ran = true
      return result('no')
    },
  })
  await assert.rejects(
    async () => new MockActivityEnvironment().run(odd.activities.runTurn, input),
    (err: unknown) =>
      err instanceof ApplicationFailure && err.type === 'TurnMoved' && !err.nonRetryable,
  )
  assert.equal(ran, false)
  assert.deepEqual(odd.bound, [])
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
        runId: FRESH,
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
  assert.deepEqual(out, { status: 'stopped', runId: FRESH, attempt: 1 })
  assert.equal(signal?.aborted, true)
})

test('a fresh run stopped before its lease bound it reports no run id (there is none)', async () => {
  const env = new MockActivityEnvironment()
  let named: string | undefined
  const t = setup({
    unleased: true,
    run: (o) => {
      named = o.runId
      setTimeout(
        () => env.cancel('CANCELLED', new ActivityCancellationDetails({ cancelRequested: true })),
        10,
      )
      return waitForAbort(o)
    },
  })
  assert.deepEqual(await env.run(t.activities.runTurn, input), { status: 'stopped' })
  assert.equal(named, FRESH, 'the id was named all the same')
  assert.deepEqual(t.bound, [])
})

test('a lost lease (heartbeat timed out, shutdown) moves the turn: a retryable failure', async () => {
  const env = new MockActivityEnvironment()
  let renewed: boolean | undefined
  const t = setup({
    run: async (o) => {
      env.cancel('TIMED_OUT', new ActivityCancellationDetails({ timedOut: true }))
      // The lease's next renew says no: the core would abort the run and throw RunLeaseError.
      renewed = await t.lease.renew(FRESH, { owner: 'w', ttlMs: 3000 })
      assert.equal(o.signal?.aborted, false, 'the activity leaves the abort to the lease')
      throw new RunLeaseError(FRESH, 'w', true, 'refused')
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

test('endTurn writes the turn.ended marker and cancels what the turn still waited for', async () => {
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
  assert.deepEqual(t.cancelled, [{ sessionId: 's', turn: 2 }])
  const m: IStreamMarker = {
    sessionId: 's',
    turn: 1,
    turnAttempt: 1,
    seq: 1_073_741_824,
    type: 'subagent.started',
    body: { itemId: 'p1' },
  }
  await new MockActivityEnvironment().run(t.activities.writeMarkers, [m])
  assert.deepEqual(t.streamMarkers, [m])
  // A child's end also closes what it still waited for (its own items, under the session); that
  // is not part of the marker.
  await new MockActivityEnvironment().run(t.activities.endTurn, {
    sessionId: 's/p_sub',
    turn: 1,
    status: 'stopped',
    closes: { sessionId: 's', owner: 'subagent-s-run-1-p_sub' },
  })
  assert.deepEqual(t.markers.at(-1), {
    kind: 'ended',
    sessionId: 's/p_sub',
    turn: 1,
    body: { status: 'stopped' },
  })
  assert.deepEqual(t.closed, [{ sessionId: 's', owner: 'subagent-s-run-1-p_sub' }])
})

// --- parking ----------------------------------------------------------------------------------

const approvalItem = {
  id: 'p_approve',
  kind: 'approval' as const,
  request: { id: 'p_approve', toolName: 'write_note', input: { text: 'x' }, readOnly: false },
}
const subagentItem = (id: string, task: string) => ({
  id,
  kind: 'tool' as const,
  toolName: 'researcher',
  input: { task },
  note: 'runs as a child workflow',
})
const parkedResult = (items: unknown[]): IAgentRunResult => ({
  ...result(''),
  parked: { runId: FRESH, items: items as never, at: 5 },
})

test('planTurn: a waiting run is parked still unless the turn brings an answer for it', () => {
  const waiting = snapshot('waiting', {
    parked: { runId: 'run-1', items: [approvalItem], at: 1 },
  })
  assert.equal(planTurn(row(waiting)).kind, 'parked')
  assert.equal(planTurn(row(waiting), ['p_other']).kind, 'parked', 'a stale answer runs nothing')
  assert.deepEqual(planTurn(row(waiting, { attemptBase: 1 }), ['p_approve']), {
    kind: 'resume',
    runId: 'run-1',
    attemptBase: 1,
  })
  // A resume that crashed after it took the answers: executing, answers again -> resume.
  assert.equal(planTurn(row(snapshot('executing')), ['p_approve']).kind, 'resume')
})

test('subagentCallOf / requestsOf: only a configured subagent with a { task } input', () => {
  const names = new Set(['researcher'])
  assert.deepEqual(subagentCallOf(subagentItem('a', 'look'), names), {
    name: 'researcher',
    task: 'look',
  })
  assert.equal(subagentCallOf(subagentItem('a', 'look'), new Set()), undefined)
  assert.equal(subagentCallOf({ ...subagentItem('a', 'x'), input: { task: 1 } }, names), undefined)
  assert.equal(subagentCallOf(approvalItem, names), undefined)
  const [approval, sub] = requestsOf([approvalItem, subagentItem('a', 'look')], names)
  assert.deepEqual(approval, {
    requestId: 'p_approve',
    kind: 'approval',
    question: { request: approvalItem.request },
  })
  assert.equal(sub?.subagent?.task, 'look')
  assert.deepEqual(coreAnswersOf({ a: { requestId: 'a', value: { approved: true }, at: 1 } }), {
    a: { approved: true },
  })
})

test('a run that parks: its items are recorded for the gateway, the turn is parked', async () => {
  const t = setup({
    base: 2,
    run: async (o) => {
      o.onEvent?.({
        type: 'run.parked',
        items: [],
        at: 5,
        runId: FRESH,
        seq: 4,
        attempt: 1,
      } as AgentEvent)
      return parkedResult([approvalItem, subagentItem('p_sub', 'dig')])
    },
    subagents: { researcher: async () => result('child') },
  })
  const out = await new MockActivityEnvironment().run(t.activities.runTurn, input)
  assert.equal(out.status, 'parked')
  if (out.status !== 'parked') return
  assert.equal(out.runId, FRESH)
  assert.equal(out.attempt, 1)
  assert.equal(out.turnAttempt, 1, 'base 0 (the first run) + attempt 1')
  assert.deepEqual(
    out.requests.map((r) => [r.requestId, r.kind, r.subagent?.name]),
    [
      ['p_approve', 'approval', undefined],
      ['p_sub', 'tool', 'researcher'],
    ],
  )
  assert.deepEqual(
    t.recorded.map((r) => [r.itemId, r.answeredBy, r.childId, r.turn, r.runId]),
    [
      ['p_approve', 'client', undefined, 1, FRESH],
      ['p_sub', 'subagent', subagentWorkflowIdOf('s', FRESH, 'p_sub'), 1, FRESH],
    ],
  )
})

test('the parked turn goes on: the run resumes with the answers, which are marked answered', async () => {
  let seen: IAgentRunOptions | undefined
  const waiting = snapshot('waiting', { parked: { runId: 'run-1', items: [approvalItem], at: 1 } })
  const t = setup({
    latest: row(waiting),
    run: async (o) => {
      seen = o
      return result('written')
    },
  })
  const out = await new MockActivityEnvironment().run(t.activities.runTurn, {
    ...input,
    answers: { p_approve: { requestId: 'p_approve', value: { approved: true }, at: 3 } },
  })
  assert.equal(out.status, 'completed')
  assert.equal(seen?.resumeFromRunId, 'run-1')
  assert.deepEqual(seen?.answers, { p_approve: { approved: true } })
  assert.deepEqual(t.answered, [{ sessionId: 's', ids: ['p_approve'] }])
  assert.deepEqual(t.fenced, ['run-1'], 'the resume raised the fence')
})

test('a retry of a parked turn reports the park again and runs nothing', async () => {
  let ran = false
  const waiting = snapshot('waiting', {
    attempt: 2,
    parked: { runId: 'run-1', items: [approvalItem], at: 1 },
  })
  const t = setup({
    latest: row(waiting, { attemptBase: 1 }),
    run: async () => {
      ran = true
      return result('no')
    },
  })
  const out = await new MockActivityEnvironment().run(t.activities.runTurn, input)
  assert.equal(ran, false)
  assert.equal(out.status, 'parked')
  if (out.status === 'parked') {
    assert.equal(out.turnAttempt, 3, 'base 1 + attempt 2')
    assert.deepEqual(
      out.requests.map((r) => r.requestId),
      ['p_approve'],
    )
  }
})

test('a partial resume parks again with what is left', async () => {
  const waiting = snapshot('waiting', {
    parked: { runId: 'run-1', items: [approvalItem, subagentItem('p_b', 'b')], at: 1 },
  })
  const t = setup({
    latest: row(waiting),
    run: async (o) => {
      o.onEvent?.({
        type: 'run.parked',
        items: [],
        at: 6,
        runId: 'run-1',
        seq: 2,
        attempt: 2,
      } as AgentEvent)
      return {
        ...parkedResult([subagentItem('p_b', 'b')]),
        parked: { runId: 'run-1', items: [subagentItem('p_b', 'b')] as never, at: 6 },
      }
    },
  })
  const out = await new MockActivityEnvironment().run(t.activities.runTurn, {
    ...input,
    answers: { p_approve: { requestId: 'p_approve', value: { approved: true }, at: 3 } },
  })
  assert.equal(out.status, 'parked')
  if (out.status === 'parked') {
    assert.equal(out.attempt, 2)
    assert.deepEqual(
      out.requests.map((r) => r.requestId),
      ['p_b'],
    )
  }
  assert.deepEqual(
    t.recorded.map((r) => r.itemId),
    ['p_b'],
    'the rest is pending again',
  )
})

const childInput: ISubagentInput = {
  sessionId: 's',
  turn: 1,
  parentRunId: 'run-1',
  itemId: 'p_sub',
  stream: 's/p_sub',
  name: 'researcher',
  task: 'dig into it',
  options: { turnTimeoutMs: 60_000, heartbeatTimeoutMs: 10_000, maxTurnAttempts: 3 },
}

test('runSubagent: the profile agent runs the task as turn 1 of its own stream', async () => {
  let seen: IAgentRunOptions | undefined
  const t = setup({
    run: async () => result('parent'),
    subagents: {
      researcher: async (o) => {
        seen = o
        return result('x'.repeat(SUBAGENT_TEXT_MAX_CHARS + 10))
      },
    },
  })
  const out = await new MockActivityEnvironment().run(t.activities.runSubagent, childInput)
  assert.equal(seen?.input, 'dig into it')
  assert.deepEqual(seen?.history, [])
  assert.deepEqual(t.latestAsked, [{ stream: 's/p_sub', turn: 1 }])
  assert.deepEqual(t.bound[0], {
    runId: runIdOf('s/p_sub', 1, 1),
    sessionId: 's/p_sub',
    turn: 1,
    runNo: 1,
    attemptBase: 0,
  })
  assert.equal(t.markers[0]?.sessionId, 's/p_sub')
  assert.equal(out.status, 'completed')
  if (out.status === 'completed') {
    assert.equal(out.text.length, SUBAGENT_TEXT_MAX_CHARS, 'clipped')
  }
})

test('runSubagent: an unknown profile is retried elsewhere; a child that parks is refused', async () => {
  const none = setup({ run: async () => result('x') })
  await assert.rejects(
    async () => new MockActivityEnvironment().run(none.activities.runSubagent, childInput),
    (err: unknown) =>
      err instanceof ApplicationFailure && err.type === 'SubagentUnknown' && !err.nonRetryable,
  )
  const parks = setup({
    run: async () => result('x'),
    subagents: { researcher: async () => parkedResult([approvalItem]) },
  })
  await assert.rejects(
    async () => new MockActivityEnvironment().run(parks.activities.runSubagent, childInput),
    (err: unknown) =>
      err instanceof ApplicationFailure && err.type === TURN_REFUSED && err.nonRetryable === true,
  )
})

// --- children that wait for a person ------------------------------------------------------------

test("runSubagent with park: an ask parks the child's run, its items are the session's, owned by the child", async () => {
  let mayPark: boolean | undefined
  const t = setup({
    run: async () => result('parent'),
    subagents: {
      researcher: async () => {
        mayPark = currentTurnScope()?.mayPark
        // A deferred call named like a subagent is still a client's item in a child.
        return parkedResult([approvalItem, subagentItem('p_x', 'not a call')])
      },
    },
  })
  const out = await new MockActivityEnvironment().run(t.activities.runSubagent, {
    ...childInput,
    park: true,
  })
  assert.equal(mayPark, true, 'the run may park')
  assert.deepEqual(out, {
    status: 'parked',
    runId: FRESH,
    attempt: 1,
    requests: requestsOf([approvalItem, subagentItem('p_x', 'not a call')], new Set()),
  })
  const owner = { workflowId: subagentWorkflowIdOf('s', 'run-1', 'p_sub'), itemId: 'p_sub' }
  assert.deepEqual(
    t.recorded.map((r) => [
      r.sessionId,
      r.itemId,
      r.turn,
      r.runId,
      r.answeredBy,
      r.childId,
      r.owner,
    ]),
    [
      ['s', 'p_approve', 1, FRESH, 'client', undefined, owner],
      ['s', 'p_x', 1, FRESH, 'client', undefined, owner],
    ],
  )
})

test('runSubagent resumes a parked child with its answers, marked answered under the session', async () => {
  let seen: IAgentRunOptions | undefined
  const waiting = snapshot('waiting', { parked: { runId: 'run-1', items: [approvalItem], at: 1 } })
  const t = setup({
    latest: row(waiting, { sessionId: 's/p_sub' }),
    run: async () => result('parent'),
    subagents: {
      researcher: async (o) => {
        seen = o
        return result('wrote it')
      },
    },
  })
  const out = await new MockActivityEnvironment().run(t.activities.runSubagent, {
    ...childInput,
    park: true,
    answers: { p_approve: { requestId: 'p_approve', value: { approved: true }, at: 3 } },
  })
  assert.equal(out.status, 'completed')
  assert.equal(seen?.resumeFromRunId, 'run-1')
  assert.deepEqual(seen?.answers, { p_approve: { approved: true } })
  assert.deepEqual(t.answered, [{ sessionId: 's', ids: ['p_approve'] }])
  // A retry without an answer for it: the child is parked still, under the session again.
  const again = setup({
    latest: row(waiting, { sessionId: 's/p_sub' }),
    run: async () => result('parent'),
    subagents: { researcher: async () => result('never') },
  })
  const parked = await new MockActivityEnvironment().run(again.activities.runSubagent, {
    ...childInput,
    park: true,
  })
  assert.equal(parked.status, 'parked')
  assert.equal(again.recorded[0]?.sessionId, 's')
  assert.equal(again.recorded[0]?.owner?.itemId, 'p_sub')
})

test('a child that may not wait: no park flag (started before child parking) or CHILD_ASK=deny - refused', async () => {
  for (const [why, childAsk, park] of [
    ['no park flag', undefined, undefined],
    ['CHILD_ASK=deny', 'deny', true],
  ] as const) {
    let mayPark: boolean | undefined
    const t = setup({
      run: async () => result('x'),
      ...(childAsk ? { childAsk } : {}),
      subagents: {
        researcher: async () => {
          mayPark = currentTurnScope()?.mayPark
          return parkedResult([approvalItem])
        },
      },
    })
    await assert.rejects(
      async () =>
        new MockActivityEnvironment().run(t.activities.runSubagent, {
          ...childInput,
          ...(park ? { park } : {}),
        }),
      (err: unknown) =>
        err instanceof ApplicationFailure && err.type === TURN_REFUSED && err.nonRetryable === true,
      why,
    )
    assert.equal(mayPark, undefined, `${why}: the run was not told it may park`)
    assert.deepEqual(t.recorded, [], `${why}: nothing recorded`)
  }
})

// --- pipelines ----------------------------------------------------------------------------------

const review: PipelineDefinition = {
  version: 1,
  entry: 'draft',
  nodes: [
    { id: 'draft', instructions: 'Write it.' },
    { id: 'judge', routes: [{ label: 'approve' }, { label: 'revise' }] },
  ],
  edges: [{ id: 'e0', from: 'draft', to: 'judge' }],
}
const pipelineItem = (id: string, task: string) => ({
  id,
  kind: 'tool' as const,
  toolName: 'review',
  input: { task },
  note: 'runs as a child workflow',
})
const nodeInput = (
  nodeId: string,
  extra: Partial<IPipelineNodeInput> = {},
): IPipelineNodeInput => ({
  sessionId: 's',
  turn: 1,
  itemId: 'p_pipe',
  pipeline: 'review',
  workflowId: `pipeline-s-run-1-p_pipe.${nodeId}.1`,
  stream: pipelineNodeStreamOf('s', 'p_pipe', nodeId, 1),
  node: review.nodes.find((n) => n.id === nodeId)!,
  input: { request: 'the draft', from: [{ nodeId: 'draft', text: 'a draft' }], visit: 1 },
  options: { turnTimeoutMs: 60_000, heartbeatTimeoutMs: 10_000, maxTurnAttempts: 3 },
  ...extra,
})

test('pipelineCallOf / requestsOf: a configured pipeline with a { task } input', () => {
  const pipes = new Set(['review'])
  assert.deepEqual(pipelineCallOf(pipelineItem('p', 'check'), pipes), {
    name: 'review',
    task: 'check',
  })
  assert.equal(pipelineCallOf(pipelineItem('p', 'check'), new Set()), undefined)
  assert.equal(pipelineCallOf({ ...pipelineItem('p', 'x'), input: { task: 2 } }, pipes), undefined)
  assert.equal(pipelineCallOf(approvalItem, pipes), undefined)
  const [sub, pipe] = requestsOf(
    [subagentItem('k', 'dig'), pipelineItem('p', 'check')],
    new Set(['researcher']),
    pipes,
  )
  assert.equal(sub?.subagent?.name, 'researcher')
  assert.equal(sub?.pipeline, undefined)
  assert.deepEqual(pipe?.pipeline, { name: 'review', task: 'check' })
  assert.equal(pipe?.subagent, undefined)
})

test('a run that parks on a pipeline call: recorded as answered by the pipeline, its child named', async () => {
  let deferred: unknown
  const t = setup({
    run: async () => {
      // The tool's dispatch runs inside the run, inside the turn's scope: the budget is there.
      deferred = await pipelineDispatch('review')()
      return parkedResult([pipelineItem('p_pipe', 'check it')])
    },
    pipelines: { review: { definition: review, runs: {} } },
  })
  const out = await new MockActivityEnvironment().run(t.activities.runTurn, {
    ...input,
    pipelines: { maxPerRound: 2, remaining: 5 },
  })
  assert.ok(deferred && typeof deferred === 'object', 'dispatched within the turn budget')
  assert.equal(out.status, 'parked')
  if (out.status === 'parked') {
    assert.deepEqual(out.requests[0]?.pipeline, { name: 'review', task: 'check it' })
  }
  assert.deepEqual(
    t.recorded.map((r) => [r.itemId, r.answeredBy, r.childId]),
    [['p_pipe', 'pipeline', pipelineWorkflowIdOf('s', FRESH, 'p_pipe')]],
  )
  assert.deepEqual((t.recorded[0]?.item as { pipeline?: unknown }).pipeline, {
    name: 'review',
    task: 'check it',
  })
  // Without a pipeline budget (a child's run), the dispatch refuses.
  const none = setup({
    run: async () => {
      await pipelineDispatch('review')()
      return result('no')
    },
  })
  await assert.rejects(
    async () => new MockActivityEnvironment().run(none.activities.runTurn, input),
    /can only be called from a turn/,
  )
})

test("pipelineDefinition: the worker's graph; a worker without it leaves it to another", async () => {
  const t = setup({
    run: async () => result('x'),
    pipelines: { review: { definition: review, runs: {} } },
  })
  assert.deepEqual(
    await new MockActivityEnvironment().run(t.activities.pipelineDefinition, { name: 'review' }),
    { definition: review },
  )
  await assert.rejects(
    async () =>
      new MockActivityEnvironment().run(t.activities.pipelineDefinition, { name: 'nope' }),
    (err: unknown) =>
      err instanceof ApplicationFailure && err.type === 'PipelineUnknown' && !err.nonRetryable,
  )
})

test('runPipelineNode: the node agent on the rendered input, as turn 1 of the visit stream', async () => {
  let seen: IAgentRunOptions | undefined
  let routed = false
  const t = setup({
    run: async () => result('parent'),
    pipelines: {
      review: {
        definition: review,
        runs: {
          draft: async (o) => {
            seen = o
            return result('x'.repeat(PIPELINE_TEXT_MAX_CHARS + 10))
          },
        },
      },
    },
    pickRoute: async () => {
      routed = true
      return { usage }
    },
  })
  const out = await new MockActivityEnvironment().run(
    t.activities.runPipelineNode,
    nodeInput('draft', {
      input: { request: 'the draft', from: [], visit: 1 },
    }),
  )
  const stream = pipelineNodeStreamOf('s', 'p_pipe', 'draft', 1)
  assert.equal(
    seen?.input,
    'the draft',
    "the engine's rendering: the request alone on a first visit",
  )
  assert.deepEqual(seen?.history, [])
  assert.equal(seen?.runId, runIdOf(stream, 1, 1))
  assert.deepEqual(t.latestAsked, [{ stream, turn: 1 }])
  assert.equal(t.bound[0]?.sessionId, stream)
  assert.equal(t.markers[0]?.sessionId, stream)
  assert.equal(t.markers[0]?.body.nodeId, 'draft')
  assert.equal(routed, false, 'no routes: no route call')
  assert.equal(out.status, 'completed')
  if (out.status === 'completed') {
    assert.equal(out.text.length, PIPELINE_TEXT_MAX_CHARS, 'clipped')
    assert.equal(out.route, undefined)
  }
})

test('runPipelineNode: a node with routes picks one where it ran - its config, the full answer', async () => {
  let asked: { node: unknown; text: string; config: unknown } | undefined
  let seenInput = ''
  const t = setup({
    run: async () => result('parent'),
    pipelines: {
      review: {
        definition: review,
        runs: {
          judge: async (o) => {
            seenInput = o.input
            return result('looks good')
          },
        },
      },
    },
    pickRoute: async (node, text, o) => {
      asked = { node, text, config: o.config }
      await new Promise((r) => setTimeout(r, 30))
      return { route: 'approve', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } }
    },
  })
  const env = new MockActivityEnvironment()
  const beats: unknown[] = []
  env.on('heartbeat', (d) => beats.push(d))
  const out = await env.run(t.activities.runPipelineNode, nodeInput('judge'))
  assert.match(seenInput, /^Request:\nthe draft\n\nOutput of "draft":\na draft$/)
  assert.equal(asked?.text, 'looks good')
  assert.deepEqual(asked?.node, review.nodes[1])
  assert.deepEqual(asked?.config, { model: 'config-of-judge' })
  assert.ok(
    beats.some((b) => (b as { route?: string })?.route === 'judge'),
    'it heartbeats',
  )
  assert.deepEqual(out, {
    status: 'completed',
    runId: runIdOf(pipelineNodeStreamOf('s', 'p_pipe', 'judge', 1), 1, 1),
    attempt: 1,
    text: 'looks good',
    usage: {
      inputTokens: 6,
      outputTokens: 2,
      totalTokens: 8,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    },
    route: 'approve',
  })
  // A route call that fails is no route (the core's rule); the node's answer stands.
  const failing = setup({
    run: async () => result('parent'),
    pipelines: { review: { definition: review, runs: { judge: async () => result('hm') } } },
    pickRoute: async () => {
      throw new Error('router down')
    },
  })
  const noRoute = await new MockActivityEnvironment().run(
    failing.activities.runPipelineNode,
    nodeInput('judge'),
  )
  assert.equal(noRoute.status, 'completed')
  assert.equal(noRoute.status === 'completed' && noRoute.route, undefined)
})

test('runPipelineNode: a stop during the route call stops the visit; a lost turn moves it', async () => {
  const hang = async (_n: unknown, _t: string, o: { signal?: AbortSignal }) =>
    new Promise<never>((_, reject) =>
      o.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    )
  const stop = setup({
    run: async () => result('parent'),
    pipelines: { review: { definition: review, runs: {} } },
    pickRoute: hang,
  })
  const env = new MockActivityEnvironment()
  setTimeout(
    () => env.cancel('CANCELLED', new ActivityCancellationDetails({ cancelRequested: true })),
    20,
  )
  const stopped = await env.run(stop.activities.runPipelineNode, nodeInput('judge'))
  assert.equal(stopped.status, 'stopped')
  const moved = setup({
    run: async () => result('parent'),
    pipelines: { review: { definition: review, runs: {} } },
    pickRoute: hang,
  })
  const lost = new MockActivityEnvironment()
  setTimeout(
    () => lost.cancel('TIMED_OUT', new ActivityCancellationDetails({ timedOut: true })),
    20,
  )
  await assert.rejects(
    async () => lost.run(moved.activities.runPipelineNode, nodeInput('judge')),
    (err: unknown) =>
      err instanceof ApplicationFailure && err.type === 'TurnMoved' && !err.nonRetryable,
  )
})

test('runPipelineNode: refused when the worker lacks the node or has another one; a node that parks', async () => {
  const t = setup({
    run: async () => result('x'),
    pipelines: { review: { definition: review, runs: {} } },
  })
  for (const bad of [
    nodeInput('draft', { pipeline: 'other' }),
    nodeInput('draft', { node: { id: 'nope' } }),
  ]) {
    await assert.rejects(
      async () => new MockActivityEnvironment().run(t.activities.runPipelineNode, bad),
      (err: unknown) =>
        err instanceof ApplicationFailure && err.type === 'PipelineUnknown' && !err.nonRetryable,
    )
  }
  // The same node with its keys in another order is the same node; one that differs is not.
  const reordered = nodeInput('draft', { node: { instructions: 'Write it.', id: 'draft' } })
  assert.equal(
    (await new MockActivityEnvironment().run(t.activities.runPipelineNode, reordered)).status,
    'completed',
  )
  await assert.rejects(
    async () =>
      new MockActivityEnvironment().run(
        t.activities.runPipelineNode,
        nodeInput('draft', { node: { id: 'draft', instructions: 'Something else.' } }),
      ),
    (err: unknown) =>
      err instanceof ApplicationFailure && err.type === 'PipelineChanged' && !err.nonRetryable,
  )
  const parks = setup({
    run: async () => result('x'),
    pipelines: {
      review: { definition: review, runs: { draft: async () => parkedResult([approvalItem]) } },
    },
  })
  await assert.rejects(
    async () =>
      new MockActivityEnvironment().run(parks.activities.runPipelineNode, nodeInput('draft')),
    (err: unknown) =>
      err instanceof ApplicationFailure && err.type === TURN_REFUSED && err.nonRetryable === true,
  )
})

test('runPipelineNode with park: the visit parks, owned by the visit (its node and visit), resumed with answers', async () => {
  let mayPark: boolean | undefined
  const t = setup({
    run: async () => result('x'),
    pipelines: {
      review: {
        definition: review,
        runs: {
          draft: async () => {
            mayPark = currentTurnScope()?.mayPark
            return parkedResult([approvalItem])
          },
        },
      },
    },
  })
  const input = nodeInput('draft')
  const out = await new MockActivityEnvironment().run(t.activities.runPipelineNode, {
    ...input,
    park: true,
  })
  assert.equal(mayPark, true)
  assert.equal(out.status, 'parked')
  assert.deepEqual(
    t.recorded.map((r) => [r.sessionId, r.turn, r.answeredBy, r.owner]),
    [
      [
        's',
        1,
        'client',
        { workflowId: input.workflowId, itemId: 'p_pipe', nodeId: 'draft', visit: 1 },
      ],
    ],
  )
  const waiting = snapshot('waiting', { parked: { runId: 'run-1', items: [approvalItem], at: 1 } })
  let seen: IAgentRunOptions | undefined
  const resumed = setup({
    latest: row(waiting, { sessionId: input.stream }),
    run: async () => result('x'),
    pipelines: {
      review: {
        definition: review,
        runs: {
          draft: async (o) => {
            seen = o
            return result('draft says ok')
          },
        },
      },
    },
  })
  const done = await new MockActivityEnvironment().run(resumed.activities.runPipelineNode, {
    ...input,
    park: true,
    answers: { p_approve: { requestId: 'p_approve', value: { approved: false }, at: 2 } },
  })
  assert.equal(done.status, 'completed')
  assert.deepEqual(seen?.answers, { p_approve: { approved: false } })
  assert.deepEqual(resumed.answered, [{ sessionId: 's', ids: ['p_approve'] }])
})

test('runSubagent and runPipelineNode supersede a run of theirs that died before its plan, first', async () => {
  const child = setup({
    latest: row(null, { runId: 'dead-child', sessionId: 's/p_sub' }),
    base: 1,
    run: async () => result('parent'),
    subagents: { researcher: async () => result('child answer') },
  })
  await new MockActivityEnvironment().run(child.activities.runSubagent, childInput)
  const childRun = runIdOf('s/p_sub', 1, 2)
  assert.deepEqual(child.trail, [
    'latest',
    'supersede dead-child',
    'base',
    `run ${childRun}`,
    `bind ${childRun}`,
  ])

  const stream = pipelineNodeStreamOf('s', 'p_pipe', 'draft', 1)
  const node = setup({
    latest: row(null, { runId: 'dead-visit', sessionId: stream }),
    base: 1,
    run: async () => result('parent'),
    pipelines: { review: { definition: review, runs: {} } },
  })
  await new MockActivityEnvironment().run(node.activities.runPipelineNode, nodeInput('draft'))
  const visitRun = runIdOf(stream, 1, 2)
  assert.deepEqual(node.trail, [
    'latest',
    'supersede dead-visit',
    'base',
    `run ${visitRun}`,
    `bind ${visitRun}`,
  ])
})

test("writeStream writes a batch of a pipeline's own stream", async () => {
  const t = setup({ run: async () => result('x') })
  const batch: IStreamBatch = {
    stream: 's/p_pipe',
    started: { name: 'review' },
    events: [{ seq: 1, event: { type: 'pipeline.started' } }],
  }
  await new MockActivityEnvironment().run(t.activities.writeStream, batch)
  assert.deepEqual(t.batches, [batch])
})
