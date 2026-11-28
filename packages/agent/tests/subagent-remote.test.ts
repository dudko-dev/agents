import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRunControl,
  createSubagentTool,
  REMOTE_SUBAGENT_LIMITS,
  type AgentEvent,
  type IRemoteSubagentContext,
  type IRemoteSubagentResult,
  type IRemoteSubagentTask,
  type RemoteSubagentDispatch,
} from '../src/index.ts'
import { remoteSubagentEventOf, remoteSubagentUsageOf } from '../src/subagent.ts'
import { hasToolResult, toolResults, type Script } from './helpers/openai-server.ts'
import {
  collect,
  config,
  ofType,
  planJson,
  stageOf,
  until,
  withLlm,
  within,
} from './helpers/loop.ts'
import { useVirtualTime } from './helpers/virtual-time.ts'

// createSubagentTool({ isolation: 'remote', dispatch }): the child runs wherever the host sends
// it. No config crosses; what comes back - the events the host forwards, the answer, the usage -
// is untrusted and checked; the usage is charged once; a stop of the parent aborts the dispatch.

const delegating =
  (args: Record<string, unknown> = { task: 'Find the value' }): Script =>
  (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson([{ id: 's1' }]) }
      case 'synthesizer':
        return { text: 'Parent done.' }
      default:
        return hasToolResult(req)
          ? { text: `parent got ${toolResults(req)[0]}` }
          : { toolCalls: [{ name: 'remote', args }] }
    }
  }

const remoteTool = (dispatch: RemoteSubagentDispatch, extra: Record<string, unknown> = {}) =>
  createSubagentTool({
    name: 'remote',
    description: 'Delegate to another worker',
    isolation: 'remote',
    dispatch,
    ...extra,
  })

test('remote: dispatch gets the task, who it is for, and a signal; its answer is the tool result', async () => {
  await withLlm(delegating({ task: 'Find the value', profile: 'deep' }), async ({ llm, open }) => {
    const seen: { task: IRemoteSubagentTask; signal: AbortSignal }[] = []
    const remote = remoteTool(
      async (task, { signal }) => {
        seen.push({ task, signal })
        return { text: 'remote answer: 42' }
      },
      { profiles: { deep: { description: 'A thorough look' } } },
    )
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'Delegate it', onEvent })
    assert.equal(result.trace[0].toolCalls[0].output, 'remote answer: 42')
    assert.equal(seen.length, 1)
    const [{ task, signal }] = seen
    const start = ofType(events, 'subagent.start')[0]
    assert.deepEqual(task, {
      id: start.id,
      name: 'remote',
      profile: 'deep',
      input: 'Find the value',
      parentRunId: events[0].runId,
      rootRunId: events[0].runId,
      depth: 1,
    })
    assert.equal(start.profile, 'deep')
    assert.ok(signal instanceof AbortSignal)
    assert.equal(signal.aborted, false)
    assert.equal(ofType(events, 'subagent.complete')[0].text, 'remote answer: 42')
  })
})

test('remote: forwarded events appear as subagent.event envelopes, numbered in the parent run', async () => {
  await withLlm(delegating(), async ({ llm, open }) => {
    const remote = remoteTool(async (_task, { emit }) => {
      emit({
        type: 'plan.created',
        plan: { thought: 'remote plan', steps: [] },
        runId: 'far',
        seq: 1,
        attempt: 1,
      })
      emit({ type: 'final', text: 'remote final', runId: 'far', seq: 2, attempt: 1 })
      return { text: 'ok' }
    })
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const { events, onEvent } = collect()
    await agent.run({ input: 'Delegate it', onEvent })
    const start = ofType(events, 'subagent.start')[0]
    const envelopes = ofType(events, 'subagent.event')
    assert.deepEqual(
      envelopes.map((e) => [e.id, e.name, e.event.type, e.event.runId, e.event.seq]),
      [
        [start.id, 'remote', 'plan.created', 'far', 1],
        [start.id, 'remote', 'final', 'far', 2],
      ],
    )
    assert.ok(envelopes.every((e) => e.runId === events[0].runId && typeof e.seq === 'number'))
  })
})

test('remote: what comes back is capped - not an event, a bad type, too big, too many, or too late is dropped', async () => {
  // The checks on their own.
  assert.equal(remoteSubagentEventOf(null), undefined)
  assert.equal(remoteSubagentEventOf('final'), undefined)
  assert.equal(remoteSubagentEventOf([{ type: 'final' }]), undefined)
  assert.equal(remoteSubagentEventOf(Object.assign([], { type: 'final' })), undefined, 'an array')
  assert.equal(remoteSubagentEventOf({ text: 'no type' }), undefined)
  assert.equal(remoteSubagentEventOf({ type: 'Final' }), undefined)
  assert.equal(remoteSubagentEventOf({ type: 'x'.repeat(65) }), undefined)
  assert.equal(remoteSubagentEventOf({ type: 'a b' }), undefined)
  assert.equal(remoteSubagentEventOf({ type: '<script>' }), undefined)
  assert.equal(
    remoteSubagentEventOf({
      type: 'final',
      text: 'x'.repeat(REMOTE_SUBAGENT_LIMITS.maxEventChars),
    }),
    undefined,
  )
  const cyclic: Record<string, unknown> = { type: 'final' }
  cyclic.self = cyclic
  assert.equal(remoteSubagentEventOf(cyclic), undefined)
  const kept = remoteSubagentEventOf({ type: 'step.tool-call', f: () => 1, n: 1 })
  assert.deepEqual(kept, { type: 'step.tool-call', n: 1 }, 'plain data only')

  await withLlm(delegating(), async ({ llm, open }) => {
    const remote = remoteTool(async (_task, { emit }) => {
      emit('not an event' as unknown as AgentEvent)
      emit({ type: 'BAD TYPE' } as unknown as AgentEvent)
      for (let i = 0; i < REMOTE_SUBAGENT_LIMITS.maxEvents + 5; i++) {
        emit({ type: 'log', level: 'info', message: `m${i}` })
      }
      return { text: 'ok' }
    })
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const { events, onEvent } = collect()
    await agent.run({ input: 'Delegate it', onEvent })
    const envelopes = ofType(events, 'subagent.event')
    assert.equal(envelopes.length, REMOTE_SUBAGENT_LIMITS.maxEvents)
    const warning = ofType(events, 'log').find((e) =>
      e.message.includes('of the remote child were dropped'),
    )
    assert.match(warning?.message ?? '', /remote: 7 event\(s\)/)
  })
  // An emit after dispatch settled is ignored.
  await withLlm(delegating(), async ({ llm, open }) => {
    let late: IRemoteSubagentContext['emit'] | undefined
    const remote = remoteTool(async (_task, { emit }) => {
      emit({ type: 'log', level: 'info', message: 'in time' })
      late = emit
      return { text: 'ok' }
    })
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const { events, onEvent } = collect()
    await agent.run({ input: 'Delegate it', onEvent })
    const before = events.length
    late?.({ type: 'final', text: 'after the end' })
    assert.equal(events.length, before, 'nothing after dispatch settled')
    assert.equal(ofType(events, 'subagent.event').length, 1)
  })
  // A long string inside an event is clipped as a local child's is.
  await withLlm(delegating(), async ({ llm, open }) => {
    const remote = remoteTool(async (_task, { emit }) => {
      emit({ type: 'final', text: 'y'.repeat(20_000) })
      return { text: 'ok' }
    })
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const { events, onEvent } = collect()
    await agent.run({ input: 'Delegate it', onEvent })
    const inner = ofType(events, 'subagent.event')[0].event as { text: string }
    assert.match(inner.text, /\[truncated 16000 chars\]$/)
  })
})

test('remote: the answer is checked and clipped', async () => {
  for (const [out, ok] of [
    [{ text: 'z'.repeat(9_000) }, true],
    [{ text: 42 }, false],
    [null, false],
    ['just a string', false],
  ] as const) {
    await withLlm(delegating(), async ({ llm, open }) => {
      const remote = remoteTool(async () => out as unknown as IRemoteSubagentResult)
      const agent = await open(config(llm.baseURL, { tools: { remote } }))
      const result = await agent.run({ input: 'Delegate it' })
      const call = result.trace[0].toolCalls[0]
      assert.equal(call.ok, ok, JSON.stringify(out))
      if (ok) assert.match(String(call.output), /\[truncated 1000 chars\]$/)
      else assert.match(String(call.output), /dispatch must resolve to \{ text: string, usage\? \}/)
    })
  }
})

test('remote: the usage dispatch returns is charged once - forwarded usage events are shown, not charged', async () => {
  await withLlm(delegating(), async ({ llm, open }) => {
    const remote = remoteTool(async (_task, { emit }) => {
      emit({
        type: 'usage',
        phase: 'execute',
        usage: { inputTokens: 500, outputTokens: 500, totalTokens: 1000 },
      })
      return { text: 'ok', usage: { inputTokens: 70, outputTokens: 30, totalTokens: 100 } }
    })
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'Delegate it', onEvent })
    const charged = ofType(events, 'usage').filter((e) => e.phase === 'subagent')
    assert.equal(charged.length, 1)
    assert.equal(charged[0].usage.totalTokens, 100)
    // The parent's own calls (plan + 2 executor rounds + synthesis = 4 x 15) and the remote's 100.
    assert.equal(result.usage.totalTokens, 4 * 15 + 100)
    assert.equal(agent.usage.totalTokens, 4 * 15 + 100)
    assert.equal(ofType(events, 'subagent.complete')[0].usage.totalTokens, 100)
  })
  // A remote child cannot hand budget back, and an unknown total is at least input + output.
  assert.deepEqual(
    remoteSubagentUsageOf({
      inputTokens: -1_000,
      outputTokens: 5,
      totalTokens: -2,
      reasoningTokens: Number.NaN,
    }),
    {
      inputTokens: 0,
      outputTokens: 5,
      totalTokens: 5,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    },
  )
  assert.equal(
    remoteSubagentUsageOf({ inputTokens: 10, outputTokens: 5, totalTokens: 3 }).totalTokens,
    15,
  )
  assert.equal(remoteSubagentUsageOf('lots').totalTokens, 0)
  // A dispatch that fails may still say what it spent.
  await withLlm(delegating(), async ({ llm, open }) => {
    const remote = remoteTool(async () => {
      throw Object.assign(new Error('remote crashed'), {
        usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      })
    })
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'Delegate it', onEvent })
    assert.equal(result.trace[0].toolCalls[0].ok, false)
    const error = ofType(events, 'subagent.error')[0]
    assert.equal(error.error, 'remote crashed')
    assert.equal(error.usage?.totalTokens, 10)
    assert.equal(result.usage.totalTokens, 4 * 15 + 10)
  })
})

test('remote: a stop of the parent aborts the signal, and the run does not wait for a dispatch that ignores it', async () => {
  await withLlm(delegating(), async ({ llm, open }) => {
    let signal: AbortSignal | undefined
    const remote = remoteTool(async (_task, ctx) => {
      signal = ctx.signal
      return new Promise<IRemoteSubagentResult>(() => {})
    })
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const stop = new AbortController()
    const run = agent.run({ input: 'Delegate it', signal: stop.signal })
    await until(() => signal !== undefined, 'the dispatch')
    stop.abort()
    await assert.rejects(run, /abort/i)
    assert.equal(signal?.aborted, true)
  })
})

test('remote: stopSubagent and timeoutMs abort the signal too; the parent run carries on', async () => {
  await withLlm(delegating(), async ({ llm, open }) => {
    let signal: AbortSignal | undefined
    const remote = remoteTool(async (_task, ctx) => {
      signal = ctx.signal
      return new Promise<IRemoteSubagentResult>(() => {})
    })
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const control = createRunControl()
    const run = agent.run({ input: 'Delegate it', control })
    await until(() => control.subagents().length === 1, 'the subagent to register')
    assert.equal(control.stopSubagent(control.subagents()[0].id), true)
    const result = await within(run, 'the run after the stop')
    assert.equal(signal?.aborted, true)
    assert.match(String(result.trace[0].toolCalls[0].output), /stopped by the user/)
    assert.equal(result.text, 'Parent done.')
  })
  await withLlm(delegating(), async ({ llm, open }) => {
    let signal: AbortSignal | undefined
    const remote = remoteTool(
      async (_task, ctx) => {
        signal = ctx.signal
        return new Promise<IRemoteSubagentResult>(() => {})
      },
      { timeoutMs: 200 },
    )
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const result = await agent.run({ input: 'Delegate it' })
    assert.equal(signal?.aborted, true)
    assert.match(String(result.trace[0].toolCalls[0].output), /timed out after 200ms/)
  })
})

test('remote: options that make no sense with it are refused when the tool is made', () => {
  const dispatch: RemoteSubagentDispatch = async () => ({ text: 'x' })
  const base = { name: 'remote', description: 'd', isolation: 'remote' as const }
  assert.throws(
    () => createSubagentTool({ ...base } as never),
    /isolation 'remote' needs a dispatch function/,
  )
  assert.throws(
    () => createSubagentTool({ ...base, dispatch, config: config('http://x') } as never),
    /`config` makes no sense with isolation 'remote'/,
  )
  assert.throws(
    () => createSubagentTool({ ...base, dispatch, tools: {} } as never),
    /`tools` makes no sense with isolation 'remote'/,
  )
  assert.throws(
    () =>
      createSubagentTool({
        ...base,
        dispatch,
        profiles: { deep: { description: 'd', config: { model: 'x' } } },
      } as never),
    /profile "deep" has a config, which makes no sense with isolation 'remote'/,
  )
  assert.throws(
    () =>
      createSubagentTool({
        name: 'local',
        description: 'd',
        isolation: 'in-process',
        config: config('http://x'),
        dispatch,
      } as never),
    /dispatch is for isolation 'remote' only/,
  )
  assert.throws(
    () => createSubagentTool({ ...base, isolation: 'cloud', dispatch } as never),
    /isolation must be 'worker', 'in-process' or 'remote'/,
  )
  assert.ok(createSubagentTool({ ...base, dispatch }))
})

test('remote: forwarded waits for a person stop the caller clock, as a local child does', async (t) => {
  const time = useVirtualTime(t)
  await withLlm(delegating(), async ({ llm, open }) => {
    // The tool's own timeoutMs is a deadline of the run's clock: while the remote child says a
    // person is being asked, it does not run - however long that takes.
    let asked = false
    let answer: () => void = () => {}
    const answered = new Promise<void>((resolve) => {
      answer = resolve
    })
    const remote = remoteTool(
      async (_task, { emit }) => {
        emit({
          type: 'tool.approval-requested',
          id: 'q1',
          name: 'write',
          input: {},
          readOnly: false,
        })
        asked = true
        await answered
        emit({
          type: 'tool.approval-resolved',
          id: 'q1',
          name: 'write',
          approved: true,
          automatic: false,
        })
        return { text: 'answered after the person' }
      },
      { timeoutMs: 1_000 },
    )
    const agent = await open(config(llm.baseURL, { tools: { remote } }))
    const run = agent.run({ input: 'Delegate it' })
    await until(() => asked, 'the question')
    time.tick(60_000)
    answer()
    const result = await run
    assert.equal(result.trace[0].toolCalls[0].output, 'answered after the person')
  })
})
