import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createApprovalController,
  decideToolPermission,
  isReadOnlyTool,
  markReadOnly,
  matchToolRule,
  TOOL_APPROVAL_TIMEOUT_MS,
  ToolDeniedError,
} from '../src/approval.ts'
import { createAgent } from '../src/agent.ts'
import { runContext } from '../src/context.ts'
import type {
  AgentEvent,
  IToolApprovalConfig,
  IToolApprovalRequest,
  ToolApprovalDecision,
} from '../src/types.ts'

test('matchToolRule: exact beats any glob; the longest glob wins among globs', () => {
  const rules = {
    '*': 'ask',
    'github__*': 'allow',
    'github__delete_*': 'deny',
    github__delete_repo: 'ask',
  } as const
  assert.deepEqual(matchToolRule(rules, 'github__delete_repo'), {
    pattern: 'github__delete_repo',
    permission: 'ask',
  })
  assert.equal(matchToolRule(rules, 'github__delete_issue')?.permission, 'deny')
  assert.equal(matchToolRule(rules, 'github__list')?.permission, 'allow')
  assert.equal(matchToolRule(rules, 'jira__x')?.pattern, '*')
  assert.equal(matchToolRule({ 'a.b*': 'deny' }, 'aXb'), undefined, 'regex chars are literal')
  assert.equal(matchToolRule(undefined, 'x'), undefined)
})

test('decideToolPermission: mode defaults', () => {
  const d = (mode: 'autopilot' | 'ask-writes' | 'ask-all' | 'read-only', readOnly: boolean) =>
    decideToolPermission({ name: 't', readOnly, mode }).permission
  assert.equal(d('autopilot', false), 'allow')
  assert.equal(d('read-only', true), 'allow')
  assert.equal(d('read-only', false), 'deny')
  assert.equal(d('ask-writes', true), 'allow')
  assert.equal(d('ask-writes', false), 'ask')
  assert.equal(d('ask-all', true), 'ask')
})

test('decideToolPermission order: built-in > remembered > rule > mode', () => {
  const base = { name: 'fs__rm', readOnly: false, mode: 'ask-all' as const }
  assert.deepEqual(decideToolPermission({ ...base, builtIn: true, rules: { '*': 'deny' } }), {
    permission: 'allow',
    source: 'builtin',
  })
  assert.equal(
    decideToolPermission({ ...base, remembered: new Set(['fs__rm']), rules: { 'fs__*': 'deny' } })
      .source,
    'remembered',
  )
  assert.deepEqual(decideToolPermission({ ...base, rules: { 'fs__*': 'deny' } }), {
    permission: 'deny',
    source: 'rule',
    rule: 'fs__*',
  })
  // A rule beats the mode in both directions.
  assert.equal(
    decideToolPermission({ ...base, mode: 'read-only', rules: { fs__rm: 'allow' } }).permission,
    'allow',
  )
  assert.equal(
    decideToolPermission({ ...base, mode: 'autopilot', rules: { fs__rm: 'ask' } }).permission,
    'ask',
  )
})

test('markReadOnly / isReadOnlyTool', () => {
  const t = markReadOnly({ description: 'x' })
  assert.equal(isReadOnlyTool(t), true)
  assert.equal(isReadOnlyTool({}), false)
  assert.equal(isReadOnlyTool(markReadOnly({}, false)), false)
})

test('ToolDeniedError carries the reason and serialises to its message', () => {
  const e = new ToolDeniedError('not today')
  assert.equal(e.name, 'ToolDeniedError')
  assert.equal(
    e.message,
    'Tool call denied by the user: not today. Do not retry it; continue without it, or report what is blocked.',
  )
  assert.equal(JSON.parse(JSON.stringify({ e })).e, e.message)
  assert.match(new ToolDeniedError().message, /^Tool call denied by the user\. Do not retry/)
})

const inRun = <T>(events: AgentEvent[], fn: () => Promise<T>): Promise<T> =>
  runContext.run(
    {
      runId: 'run-1',
      startedAt: 0,
      sandboxDir: '/tmp/x',
      emit: (e) => events.push(e),
      currentStep: { id: 's1', description: 'd', expectedOutcome: 'e' },
    },
    fn,
  )

test('approval gate: ask -> onRequest; remember skips later asks; events in order', async () => {
  const requests: IToolApprovalRequest[] = []
  const events: AgentEvent[] = []
  const gate = createApprovalController(
    {
      mode: 'ask-all',
      onRequest: (req) => {
        requests.push(req)
        return { approved: true, remember: true }
      },
    },
    { sanitize: async (_n, input) => ({ ...(input as object), secret: '***' }) },
  )
  await inRun(events, async () => {
    await gate.gate('db__write', { secret: 'p@ss' }, { readOnly: false })
    await gate.gate('db__write', { secret: 'p@ss' }, { readOnly: false })
  })
  assert.equal(requests.length, 1, 'the remembered tool is not asked again')
  assert.deepEqual(requests[0].input, { secret: '***' }, 'the request shows the sanitized input')
  assert.equal(requests[0].runId, 'run-1')
  assert.equal(requests[0].step?.id, 's1')
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool.approval-requested', 'tool.approval-resolved'],
  )
  assert.equal((events[1] as { automatic: boolean }).automatic, false)
  assert.ok(gate.remembered.has('db__write'))
})

test('approval gate: denials throw ToolDeniedError; automatic ones say so', async () => {
  const events: AgentEvent[] = []
  const noHandler = createApprovalController({ mode: 'ask-all' })
  await inRun(events, async () => {
    await assert.rejects(
      () => noHandler.gate('x', {}, { readOnly: true }),
      (err: unknown) =>
        err instanceof ToolDeniedError && /no approval handler configured/.test(err.message),
    )
  })
  assert.deepEqual(events.at(-1), {
    type: 'tool.approval-resolved',
    id: (events.at(-1) as { id: string }).id,
    name: 'x',
    approved: false,
    reason: 'no approval handler configured',
    automatic: true,
  })

  const readOnlyMode = createApprovalController({ mode: 'read-only' })
  await inRun(events, async () => {
    await readOnlyMode.gate('reader', {}, { readOnly: true })
    await assert.rejects(
      () => readOnlyMode.gate('writer', {}, { readOnly: false }),
      ToolDeniedError,
    )
  })

  const userSaysNo = createApprovalController({
    mode: 'ask-writes',
    onRequest: () => ({ approved: false, reason: 'too risky' }),
  })
  await inRun(events, async () => {
    await assert.rejects(() => userSaysNo.gate('w', {}, { readOnly: false }), /too risky/)
  })
  const last = events.at(-1) as { automatic: boolean; approved: boolean }
  assert.equal(last.approved, false)
  assert.equal(last.automatic, false)
})

test('approval gate: a timeout denies; setMode switches at runtime', async () => {
  const events: AgentEvent[] = []
  const gate = createApprovalController({
    mode: 'ask-all',
    timeoutMs: 20,
    onRequest: () => new Promise<boolean>(() => {}),
  })
  await inRun(events, async () => {
    await assert.rejects(
      () => gate.gate('slow', {}, { readOnly: false }),
      /no decision within 20ms/,
    )
  })
  gate.setMode('autopilot')
  assert.equal(gate.getMode(), 'autopilot')
  await gate.gate('slow', {}, { readOnly: false })
  assert.throws(() => gate.setMode('bogus' as never), /tool approval mode must be/)
  assert.throws(() => createApprovalController({ mode: 'nope' as never }), /toolApproval.mode/)
})

test('approval gate: built-in tools never ask', async () => {
  const gate = createApprovalController({ mode: 'ask-all', rules: { '*': 'deny' } })
  await gate.gate('load_skill', {}, { readOnly: true, builtIn: true })
})

// ── the wait's own bound (toolApproval.timeoutMs) ───────────────────────────
// On mocked timers: Node's mock fires a delay past 2^31 - 1 (Infinity included) after 1 ms, as
// the real setTimeout does, so a bound handed to the timer unresolved shows here as a denial.

const MAX_TIMER_MS = 2 ** 31 - 1

/** A gate asked once, with a handler that never answers; `state()` says how it has settled. */
const askForever = (
  config: Omit<IToolApprovalConfig, 'onRequest' | 'mode'>,
  signal?: AbortSignal,
) => {
  const events: AgentEvent[] = []
  const gate = createApprovalController({
    mode: 'ask-all',
    onRequest: () => new Promise<boolean>(() => {}),
    ...config,
  })
  let settled: 'pending' | 'allowed' | Error = 'pending'
  void inRun(events, () => gate.gate('write', {}, { readOnly: false, signal })).then(
    () => {
      settled = 'allowed'
    },
    (err: Error) => {
      settled = err
    },
  )
  return { events, state: () => settled }
}

/** Let the promise chains run (setImmediate is not mocked). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

test('approval timeout: absent = 5 minutes, then the call is denied with the reason', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  assert.equal(TOOL_APPROVAL_TIMEOUT_MS, 300_000, 'a person answers: minutes, not seconds')
  const q = askForever({})
  await flush()
  t.mock.timers.tick(299_999)
  await flush()
  assert.equal(q.state(), 'pending', 'denied before the five minutes were up')
  t.mock.timers.tick(1)
  await flush()
  const err = q.state()
  assert.ok(err instanceof ToolDeniedError)
  assert.match(err.message, /no decision within 300000ms/)
  assert.deepEqual(
    [q.events.at(-1)?.type, (q.events.at(-1) as { automatic?: boolean }).automatic],
    ['tool.approval-resolved', true],
  )
})

for (const [label, timeoutMs] of [
  ['0', 0],
  ['Infinity', Infinity],
  ['more than a timer holds (2^31)', 2 ** 31],
  ['Number.MAX_VALUE', Number.MAX_VALUE],
] as const) {
  test(`approval timeout: ${label} = no bound - the question waits until the run is stopped`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const controller = new AbortController()
    const q = askForever({ timeoutMs }, controller.signal)
    await flush()
    // Not at ~1 ms (what setTimeout does with Infinity or a delay past 2^31 - 1), not at 0 ms,
    // not at the default, not at the longest delay a timer holds.
    for (const ms of [0, 1, 5, TOOL_APPROVAL_TIMEOUT_MS, MAX_TIMER_MS, MAX_TIMER_MS]) {
      t.mock.timers.tick(ms)
      await flush()
      assert.equal(q.state(), 'pending', `ended after a tick of ${ms} ms`)
    }
    const stop = new Error('stopped by the user')
    controller.abort(stop)
    await flush()
    assert.equal(q.state(), stop, 'the stop is what ended it')
    const resolved = q.events.at(-1) as { type: string; reason?: string; automatic?: boolean }
    assert.deepEqual(
      [resolved.type, resolved.reason, resolved.automatic],
      ['tool.approval-resolved', 'aborted', true],
    )
  })
}

test('approval timeout: the longest delay a timer holds is still a bound, kept to the millisecond', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const q = askForever({ timeoutMs: MAX_TIMER_MS })
  await flush()
  t.mock.timers.tick(MAX_TIMER_MS - 1)
  await flush()
  assert.equal(q.state(), 'pending')
  t.mock.timers.tick(1)
  await flush()
  assert.match(String(q.state()), new RegExp(`no decision within ${MAX_TIMER_MS}ms`))
})

test('approval timeout: a positive fraction is at least 1 ms, never "no bound"', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const q = askForever({ timeoutMs: 0.5 })
  await flush()
  t.mock.timers.tick(1)
  await flush()
  assert.match(String(q.state()), /no decision within 1ms/)
})

test('approval timeout: negative, NaN or not a number is a configuration error at createAgent', async () => {
  for (const bad of [-1, -Infinity, Number.NaN, '300000', true]) {
    assert.throws(
      () => createApprovalController({ mode: 'ask-all', timeoutMs: bad as number }),
      new RegExp(
        `^Error: toolApproval\\.timeoutMs must be a number of milliseconds of at least 0 \\(0 or Infinity: no limit\\), got: ${bad === '300000' ? '"300000"' : String(bad)}$`,
      ),
      String(bad),
    )
  }
  // From createAgent itself, before anything is connected.
  await assert.rejects(
    createAgent({
      clientName: 'approval-timeout',
      providerType: 'openai-compatible',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'not-a-real-key',
      model: 'none',
      mcpServers: {},
      maxIterations: 1,
      maxStepsPerTask: 1,
      logLevel: 'none',
      toolApproval: { mode: 'ask-all', timeoutMs: Number.NaN },
    }),
    /toolApproval\.timeoutMs must be a number of milliseconds of at least 0 .*got: NaN/,
  )
})

// ── the host's signal (onRequest's second argument) ─────────────────────────

/** A gate whose handler records its signal, and what had been emitted when that signal aborted. */
const watchSignal = (
  config: Omit<IToolApprovalConfig, 'onRequest' | 'mode'>,
  answer: () => Promise<ToolApprovalDecision> = () => new Promise(() => {}),
  signal?: AbortSignal,
) => {
  const events: AgentEvent[] = []
  let hostSignal: AbortSignal | undefined
  let emittedAtAbort: string[] | undefined
  const gate = createApprovalController({
    mode: 'ask-all',
    ...config,
    onRequest: (_req, ctx) => {
      hostSignal = ctx.signal
      ctx.signal.addEventListener('abort', () => {
        emittedAtAbort = events.map((e) => e.type)
      })
      return answer()
    },
  })
  let settled: 'pending' | 'allowed' | Error = 'pending'
  void inRun(events, () => gate.gate('write', {}, { readOnly: false, signal })).then(
    () => {
      settled = 'allowed'
    },
    (err: Error) => {
      settled = err
    },
  )
  return {
    signal: () => hostSignal,
    emittedAtAbort: () => emittedAtAbort,
    state: () => settled,
  }
}

test('host signal: aborted when the bound runs out - a TimeoutError, before the resolved event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const w = watchSignal({})
  await flush()
  assert.equal(w.signal()?.aborted, false, 'not aborted while the question waits')
  t.mock.timers.tick(TOOL_APPROVAL_TIMEOUT_MS)
  await flush()
  assert.ok(w.state() instanceof ToolDeniedError)
  assert.equal(w.signal()?.aborted, true)
  const reason = w.signal()?.reason as Error
  assert.deepEqual([reason.name, reason.message], ['TimeoutError', 'no decision within 300000ms'])
  // A host that closes its prompt hears of it before the agent reports the denial.
  assert.deepEqual(w.emittedAtAbort(), ['tool.approval-requested'])
})

test("host signal: aborted when the run is stopped - with the run's reason", async () => {
  const run = new AbortController()
  const w = watchSignal({ timeoutMs: 0 }, undefined, run.signal)
  await flush()
  const stop = new Error('stopped by the user')
  run.abort(stop)
  await flush()
  assert.equal(w.state(), stop)
  assert.equal(w.signal()?.reason, stop)
  assert.deepEqual(w.emittedAtAbort(), ['tool.approval-requested'])
})

test('host signal: aborted when the handler fails', async () => {
  const boom = new Error('the dialog crashed')
  const w = watchSignal({}, () => Promise.reject(boom))
  await flush()
  assert.match(String(w.state()), /approval handler failed: the dialog crashed/)
  assert.equal(w.signal()?.reason, boom)
})

test('host signal: never aborted once the host has answered - yes or no', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const answer of [true, false, { approved: false, reason: 'no' }] as const) {
    const w = watchSignal({}, () => Promise.resolve(answer))
    await flush()
    t.mock.timers.tick(TOOL_APPROVAL_TIMEOUT_MS * 2)
    await flush()
    assert.notEqual(w.state(), 'pending')
    assert.equal(w.signal()?.aborted, false, JSON.stringify(answer))
  }
})
