import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createAgent,
  createSubagentTool,
  RunLeaseError,
  type AgentEvent,
  type IPersistence,
  type IRunLease,
  type IRunSnapshot,
} from '../src/index.ts'
import { holdRunLease, resolveRunLease } from '../src/run-lease.ts'
import { hasToolResult, userOf, type Script } from './helpers/openai-server.ts'
import { useLeaseTime } from './helpers/lease-time.ts'
import {
  collect,
  config,
  linearScript,
  ofType,
  planJson,
  stageOf,
  stepOf,
  until,
  withLlm,
  within,
} from './helpers/loop.ts'

// config.runLease, STRICT: a run does nothing before its lease is taken; once a renew says no
// (or throws, or does not answer before the lease runs out) the run is aborted at once and writes
// nothing more - another worker may own it by then, and a late snapshot would overwrite its
// state. The renew cadence runs on virtual time (`lease-time.ts`, the lease's own seam).

interface ILeaseLog {
  calls: { op: 'acquire' | 'renew' | 'release'; runId: string; owner: string; ttlMs?: number }[]
}

const fakeLease = (
  answers: {
    acquire?: () => boolean | Promise<boolean>
    renew?: () => boolean | Promise<boolean>
  } = {},
  extra: Partial<IRunLease> = {},
): IRunLease & ILeaseLog => {
  const calls: ILeaseLog['calls'] = []
  return {
    calls,
    acquire: (runId, { owner, ttlMs }) => {
      calls.push({ op: 'acquire', runId, owner, ttlMs })
      return answers.acquire ? answers.acquire() : true
    },
    renew: (runId, { owner, ttlMs }) => {
      calls.push({ op: 'renew', runId, owner, ttlMs })
      return answers.renew ? answers.renew() : true
    },
    release: (runId, { owner }) => {
      calls.push({ op: 'release', runId, owner })
    },
    ...extra,
  }
}

const ops = (lease: ILeaseLog) => lease.calls.map((c) => c.op)

const recordingStore = () => {
  const writes: { hook: string; status: string; attempt?: number; owner?: string }[] = []
  const saved = new Map<string, IRunSnapshot>()
  const write = (hook: string) => (s: IRunSnapshot) => {
    writes.push({ hook, status: s.status, attempt: s.attempt, owner: s.leaseOwner })
    saved.set(s.runId, structuredClone(s))
  }
  const persistence: IPersistence = {
    onRunStart: write('onRunStart'),
    onStepComplete: write('onStepComplete'),
    onRunComplete: write('onRunComplete'),
    onRunResume: write('onRunResume'),
    loadRun: (runId) => structuredClone(saved.get(runId) ?? null),
  }
  return { writes, saved, persistence }
}

// A step whose tool waits for the test: the run is mid-flight while the test moves the time.
const waitingTool = () => {
  let release: () => void = () => {}
  let signal: AbortSignal | undefined
  let started = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const wait_here = tool({
    description: 'Wait for the test',
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }) => {
      started = true
      signal = abortSignal
      await new Promise<void>((resolve, reject) => {
        gate.then(resolve)
        // As most tools do: a plain AbortError, not the signal's reason - the run must still
        // reject with the RunLeaseError.
        abortSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        )
      })
      return 'waited'
    },
  })
  return {
    tools: { wait_here },
    release: () => release(),
    get started() {
      return started
    },
    get signal() {
      return signal
    },
  }
}

const waitingScript: Script = (req) => {
  switch (stageOf(req)) {
    case 'planner':
      return { text: planJson([{ id: 's1' }, { id: 's2' }]) }
    case 'executor':
      return hasToolResult(req)
        ? { text: 'done waiting' }
        : { toolCalls: [{ name: 'wait_here', args: {} }] }
    case 'replanner':
      return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }) }
    default:
      return { text: 'All done.' }
  }
}

// ── the settings ────────────────────────────────────────────────────────────

test('lease: createAgent refuses a lease that cannot work', async () => {
  const ok = fakeLease()
  assert.equal(resolveRunLease(undefined), undefined)
  assert.equal(resolveRunLease(ok)?.ttlMs, 30_000, 'default ttl')
  assert.match(resolveRunLease(ok)?.owner ?? '', /^agent-[0-9a-f-]{36}$/, 'a random owner')
  assert.notEqual(resolveRunLease(ok)?.owner, resolveRunLease(ok)?.owner, 'one per agent')
  assert.equal(resolveRunLease({ ...ok, owner: 'worker-7', ttlMs: 9_000 })?.owner, 'worker-7')
  for (const ttlMs of [999, 0, -1, Number.NaN, Infinity, 2_147_483_648, '30000']) {
    assert.throws(
      () => resolveRunLease({ ...ok, ttlMs: ttlMs as number }),
      /runLease\.ttlMs must be a number of milliseconds from 1000 to 2147483647/,
      String(ttlMs),
    )
  }
  for (const owner of ['', '   ', 'x'.repeat(257), 42]) {
    assert.throws(() => resolveRunLease({ ...ok, owner: owner as string }), /runLease\.owner/)
  }
  for (const method of ['acquire', 'renew', 'release'] as const) {
    assert.throws(
      () => resolveRunLease({ ...ok, [method]: undefined } as unknown as IRunLease),
      new RegExp(`runLease\\.${method} must be a function`),
    )
  }
  await assert.rejects(
    createAgent({ ...config('http://127.0.0.1:9/v1'), runLease: { ...ok, ttlMs: 10 } }),
    /runLease\.ttlMs/,
  )
})

test('lease: agent.leaseOwner is the owner the lease is asked with', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const lease = fakeLease()
    const agent = await open(config(llm.baseURL, { runLease: lease }))
    assert.match(agent.leaseOwner ?? '', /^agent-/)
    await agent.run({ input: 'x' })
    assert.ok(lease.calls.every((c) => c.owner === agent.leaseOwner))
    const named = await open(config(llm.baseURL, { runLease: { ...lease, owner: 'w-1' } }))
    assert.equal(named.leaseOwner, 'w-1')
    const without = await open(config(llm.baseURL))
    assert.equal(without.leaseOwner, undefined)
  })
})

// ── acquire ─────────────────────────────────────────────────────────────────

for (const [how, acquire] of [
  ['answers false', () => false],
  [
    'throws',
    () => {
      throw new Error('broker down')
    },
  ],
] as const) {
  test(`lease: an acquire that ${how} means no run - no model call, no event, no persistence write`, async () => {
    await withLlm(linearScript(['s1']), async ({ llm, open }) => {
      const lease = fakeLease({ acquire })
      const { writes, persistence } = recordingStore()
      const agent = await open(config(llm.baseURL, { runLease: lease, persistence }))
      const { events, onEvent } = collect()
      const err = await agent.run({ input: 'x', onEvent }).then(
        () => assert.fail('the run must not start'),
        (e: unknown) => e,
      )
      assert.ok(err instanceof RunLeaseError, String(err))
      assert.equal(err.lost, false)
      assert.equal(err.reason, how === 'throws' ? 'error' : 'refused')
      assert.match(err.message, /could not be acquired.*nothing ran and nothing was persisted/)
      assert.deepEqual(writes, [])
      assert.deepEqual(events, [])
      assert.equal(llm.requests.length, 0)
      assert.deepEqual(ops(lease), ['acquire'], 'nothing to release')
    })
  })
}

test('lease: a resume acquires too - before it reads the snapshot - and a refusal writes nothing', async () => {
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    const { writes, saved, persistence } = recordingStore()
    const controller = new AbortController()
    const first = await open(
      config(llm.baseURL, {
        persistence: {
          ...persistence,
          onStepComplete: async (s) => {
            await persistence.onStepComplete?.(s)
            controller.abort()
          },
        },
      }),
    )
    await assert.rejects(first.run({ input: 'two things', signal: controller.signal }))
    const [runId] = [...saved.keys()]
    const order: string[] = []
    const refusing = fakeLease({ acquire: () => (order.push('acquire'), false) })
    const second = await open(
      config(llm.baseURL, {
        runLease: refusing,
        persistence: {
          ...persistence,
          loadRun: (id) => (order.push('loadRun'), persistence.loadRun!(id)),
        },
      }),
    )
    const before = writes.length
    await assert.rejects(second.run({ input: '', resumeFromRunId: runId }), RunLeaseError)
    assert.deepEqual(order, ['acquire'], 'not even read')
    assert.equal(writes.length, before, 'no resume write')
    assert.deepEqual(refusing.calls[0], {
      op: 'acquire',
      runId,
      owner: second.leaseOwner,
      ttlMs: 30_000,
    })

    const taking = fakeLease({ acquire: () => (order.push('acquire'), true) })
    const third = await open(
      config(llm.baseURL, {
        runLease: taking,
        persistence: {
          ...persistence,
          loadRun: (id) => (order.push('loadRun'), persistence.loadRun!(id)),
        },
      }),
    )
    await third.run({ input: '', resumeFromRunId: runId })
    assert.deepEqual(order, ['acquire', 'acquire', 'loadRun'])
    assert.deepEqual(ops(taking), ['acquire', 'release'])
    assert.equal(taking.calls[0].runId, runId)
    const resumeWrite = writes.find((w) => w.hook === 'onRunResume')
    assert.equal(resumeWrite?.owner, third.leaseOwner, 'the snapshot names its owner (fencing)')
  })
})

// ── renew ───────────────────────────────────────────────────────────────────

test('lease: renewed every ttlMs / 3 while the run goes, and not once after it', async (t) => {
  const time = useLeaseTime(t)
  await withLlm(waitingScript, async ({ llm, open }) => {
    const lease = fakeLease({}, { ttlMs: 9_000 })
    const wait = waitingTool()
    const agent = await open(config(llm.baseURL, { runLease: lease, tools: wait.tools }))
    const run = agent.run({ input: 'wait' })
    await until(() => wait.started, 'the tool to start')
    assert.deepEqual(ops(lease), ['acquire'])
    time.tick(2_999)
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(ops(lease), ['acquire'], 'not before ttlMs / 3')
    time.tick(1)
    await until(() => ops(lease).length === 2, 'the first renew')
    assert.deepEqual(lease.calls[1], {
      op: 'renew',
      runId: lease.calls[0].runId,
      owner: agent.leaseOwner,
      ttlMs: 9_000,
    })
    time.tick(3_000)
    await until(() => ops(lease).length === 3, 'the second renew')
    time.tick(3_000)
    await until(() => ops(lease).length === 4, 'the third renew')
    wait.release()
    await run
    assert.deepEqual(ops(lease), ['acquire', 'renew', 'renew', 'renew', 'release'])
    assert.equal(time.running, 0, 'no timer left')
    time.tick(60_000)
    await new Promise((r) => setImmediate(r))
    assert.equal(ops(lease).length, 5, 'no renew after the release')
  })
})

for (const [how, renew, reason] of [
  ['answers false', () => false, 'refused'],
  [
    'throws',
    () => {
      throw new Error('lease store gone')
    },
    'error',
  ],
] as const) {
  test(`lease: a renew that ${how} aborts the run at once, writes nothing more and rejects with RunLeaseError (lost)`, async (t) => {
    const time = useLeaseTime(t)
    await withLlm(waitingScript, async ({ llm, open }) => {
      const lease = fakeLease({ renew })
      const { writes, persistence } = recordingStore()
      const wait = waitingTool()
      const agent = await open(
        config(llm.baseURL, { runLease: lease, persistence, tools: wait.tools }),
      )
      const { events, onEvent } = collect()
      const run = agent.run({ input: 'wait', onEvent })
      await until(() => wait.started, 'the tool to start')
      assert.deepEqual(
        writes.map((w) => w.hook),
        ['onRunStart'],
      )
      time.tick(10_000)
      const err = await within(run, 'the run after the loss').then(
        () => assert.fail('the run must not finish'),
        (e: unknown) => e,
      )
      assert.ok(err instanceof RunLeaseError, String(err))
      assert.equal(err.lost, true)
      assert.equal(err.reason, reason)
      assert.equal(err.owner, agent.leaseOwner)
      assert.equal(wait.signal?.aborted, true, "the tool's signal was aborted")
      assert.deepEqual(
        writes.map((w) => w.hook),
        ['onRunStart'],
        'no snapshot after the loss, terminal or not',
      )
      const lost = ofType(events, 'lease.lost')
      assert.equal(lost.length, 1)
      assert.equal(lost[0].reason, reason)
      assert.equal(lost[0].owner, agent.leaseOwner)
      if (reason === 'error') assert.equal(lost[0].error, 'lease store gone')
      const at = events.indexOf(lost[0] as AgentEvent)
      assert.ok(
        events.slice(at + 1).every((e) => e.type !== 'step.complete' && e.type !== 'final'),
        'nothing of the run after it',
      )
      assert.deepEqual(
        ops(lease),
        ['acquire', 'renew'],
        'a lost lease is not released: it is not ours',
      )
      assert.equal(time.running, 0)
    })
  })
}

test('lease: lost between two steps (while a checkpoint is written) - no next step, RunLeaseError, nothing more written', async (t) => {
  const time = useLeaseTime(t)
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    const lease = fakeLease({ renew: () => false })
    const { writes, persistence } = recordingStore()
    let inWrite = false
    let finishWrite: () => void = () => {}
    const written = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const slow: IPersistence = {
      ...persistence,
      onStepComplete: async (s) => {
        inWrite = true
        await written
        await persistence.onStepComplete?.(s)
      },
    }
    const agent = await open(config(llm.baseURL, { runLease: lease, persistence: slow }))
    const run = agent.run({ input: 'two steps' })
    await until(() => inWrite, 'the checkpoint after s1')
    time.tick(10_000)
    await until(() => ops(lease).includes('renew'), 'the renew')
    finishWrite()
    const err = await within(run, 'the run after the loss').then(
      () => assert.fail('the run must not finish'),
      (e: unknown) => e,
    )
    assert.ok(err instanceof RunLeaseError, `a RunLeaseError, not ${String(err)}`)
    assert.equal(err.lost, true)
    assert.deepEqual(
      writes.map((w) => w.hook),
      ['onRunStart', 'onStepComplete'],
      'the write in flight lands; nothing after it',
    )
    assert.ok(
      !llm.requests.some((r) => stageOf(r) === 'executor' && stepOf(r) === 's2'),
      'the next step never ran',
    )
  })
})

test('lease: a renew that does not answer before the lease runs out counts as lost (expired)', async (t) => {
  const time = useLeaseTime(t)
  await withLlm(waitingScript, async ({ llm, open }) => {
    const lease = fakeLease({ renew: () => new Promise<boolean>(() => {}) }, { ttlMs: 3_000 })
    const wait = waitingTool()
    const agent = await open(config(llm.baseURL, { runLease: lease, tools: wait.tools }))
    const run = agent.run({ input: 'wait' })
    await until(() => wait.started, 'the tool to start')
    time.tick(1_000)
    await until(() => ops(lease).length === 2, 'the renew')
    time.tick(1_999)
    await new Promise((r) => setImmediate(r))
    assert.equal(wait.signal?.aborted, false, 'still within the lease')
    time.tick(1)
    const err = await within(run, 'the run after the loss').then(
      () => assert.fail('the run must not finish'),
      (e: unknown) => e,
    )
    assert.ok(err instanceof RunLeaseError)
    assert.equal(err.lost, true)
    assert.equal(err.reason, 'expired')
  })
})

test('lease: the holder on its own - lost once, the signal aborted with the error, listeners told', async (t) => {
  const time = useLeaseTime(t)
  let answer = true
  const lease = fakeLease({ renew: () => answer })
  const held = await holdRunLease({ lease, ttlMs: 6_000, owner: 'me' }, 'run-1')
  const told: string[] = []
  held.onLost((err) => told.push(err.reason))
  time.tick(2_000)
  await until(() => ops(lease).length === 2, 'renew 1')
  assert.equal(held.lost, undefined)
  answer = false
  time.tick(2_000)
  await until(() => held.lost !== undefined, 'the loss')
  assert.deepEqual(told, ['refused'])
  assert.equal(held.signal.aborted, true)
  assert.equal(held.signal.reason, held.lost)
  held.onLost((err) => told.push(`late:${err.reason}`))
  assert.deepEqual(
    told,
    ['refused', 'late:refused'],
    'a listener added after the loss is told at once',
  )
  await held.release(() => {})
  assert.deepEqual(ops(lease), ['acquire', 'renew', 'renew'])
  assert.equal(time.running, 0)
})

// ── release ─────────────────────────────────────────────────────────────────

test('lease: released once on every way out - success, failure, stop - and a failed release is only logged', async (t) => {
  useLeaseTime(t)
  const failing: Script = (req) =>
    stageOf(req) === 'executor' ? { status: 400, text: 'bad request' } : linearScript(['s1'])(req)
  await withLlm(failing, async ({ llm, open }) => {
    const lease = fakeLease()
    const agent = await open(config(llm.baseURL, { runLease: lease, llmMaxRetries: 0 }))
    await assert.rejects(agent.run({ input: 'fail' }))
    assert.deepEqual(ops(lease), ['acquire', 'release'], 'failure')
  })
  await withLlm(waitingScript, async ({ llm, open }) => {
    const lease = fakeLease()
    const wait = waitingTool()
    const agent = await open(config(llm.baseURL, { runLease: lease, tools: wait.tools }))
    const stop = new AbortController()
    const run = agent.run({ input: 'wait', signal: stop.signal })
    await until(() => wait.started, 'the tool')
    stop.abort()
    await assert.rejects(run)
    assert.deepEqual(ops(lease), ['acquire', 'release'], 'stop')
  })
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const lease = fakeLease(
      {},
      {
        release: () => {
          throw new Error('release failed')
        },
      },
    )
    const agent = await open(config(llm.baseURL, { runLease: lease }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'ok', onEvent })
    assert.equal(result.text, 'All done.', 'success, whatever the release says')
    assert.ok(
      ofType(events, 'log').some((e) =>
        /\[lease\] release of run .* threw: release failed/.test(e.message),
      ),
    )
  })
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    // A resume of an unknown run: the lease was taken for it, and is given back.
    const lease = fakeLease()
    const agent = await open(
      config(llm.baseURL, { runLease: lease, persistence: { loadRun: () => null } }),
    )
    await assert.rejects(agent.run({ input: '', resumeFromRunId: 'nope' }), /No persisted run/)
    assert.deepEqual(ops(lease), ['acquire', 'release'], 'a resume that failed to load')
  })
})

// ── subagents run under the parent's lease ──────────────────────────────────

test('lease: helpers and subagents take no lease of their own', async () => {
  const script: Script = (req) => {
    const stage = stageOf(req)
    const sub = userOf(req).includes('SUB TASK')
    if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
    if (stage === 'synthesizer') return { text: sub ? 'sub answer' : 'Parent done.' }
    if (sub) return { text: 'sub did it' }
    const results = (req.messages ?? []).filter((m) => m.role === 'tool').length
    if (results === 0)
      return { toolCalls: [{ name: 'spawn_subagent', args: { task: 'SUB TASK one' } }] }
    if (results === 1) return { toolCalls: [{ name: 'child', args: { task: 'SUB TASK two' } }] }
    return { text: 'parent got both' }
  }
  await withLlm(script, async ({ llm, open }) => {
    const lease = fakeLease()
    const child = createSubagentTool({
      name: 'child',
      description: 'Delegate',
      isolation: 'in-process',
      // The same config, lease and all: dropped for the child.
      config: config(llm.baseURL, { runLease: lease }),
    })
    const agent = await open(
      config(llm.baseURL, { runLease: lease, subagents: { dynamic: true }, tools: { child } }),
    )
    const result = await agent.run({ input: 'delegate twice' })
    assert.equal(result.text, 'Parent done.')
    assert.equal(result.trace[0].toolCalls.length, 2)
    assert.ok(
      result.trace[0].toolCalls.every((c) => c.ok),
      JSON.stringify(result.trace[0].toolCalls),
    )
    assert.deepEqual(ops(lease), ['acquire', 'release'], 'one lease: the run the host started')
  })
})

// ── no timer outlives a run ─────────────────────────────────────────────────

test('lease: no timer is left behind on any way out (a child process that would hang)', async () => {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      fileURLToPath(new URL('./fixtures/run-lease-exit.ts', import.meta.url)),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the process did not exit: a timer kept it alive\n${out}\n${err}`))
    }, 30_000)
    child.on('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  assert.equal(code, 0, err)
  const lines = out.trim().split('\n')
  assert.deepEqual(lines, [
    'success: 0',
    'failure: 0',
    'stop: 0',
    'lost: 0',
    'refused: 0',
    'unknown-resume: 0',
  ])
})

test('lease: a renew timer on real time never keeps the process alive', async () => {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      fileURLToPath(new URL('./fixtures/run-lease-unref.ts', import.meta.url)),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  const started = Date.now()
  const code = await new Promise<number | null>((resolve, reject) => {
    // A ref'd renew timer (every 1 s) would keep the process alive for good.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('the process did not exit: the renew timer kept it alive'))
    }, 20_000)
    child.on('exit', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  assert.equal(code, 0)
  assert.equal(out, 'held\n')
  assert.ok(Date.now() - started < 20_000)
})
