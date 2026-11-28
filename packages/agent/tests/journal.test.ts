import assert from 'node:assert/strict'
import test from 'node:test'
import { tool, type Tool } from 'ai'
import { z } from 'zod'
import { startLocalMcpServer, SKILL_MARKERS } from '@dudko.dev/test-servers'
import {
  createAgent,
  createPipeline,
  createSubagentTool,
  nodeResolver,
  deferResult,
  JournalError,
  markReadOnly,
  RunLeaseError,
  type AgentEvent,
  type IAgentConfig,
  type IJournalEntry,
  type IPersistence,
  type IRunLease,
  type IRunSnapshot,
  type IToolApprovalRequest,
  type ParkedItem,
} from '../src/index.ts'
import type { IChatRequest, IScriptedReply } from './helpers/openai-server.ts'
import { journalHash, stableJson } from '../src/journal.ts'
import { startLocalOpenAI, toolResults, userOf } from './helpers/openai-server.ts'
import { collect, config, ofType, planJson, stageOf, withLlm } from './helpers/loop.ts'

// The call journal (persistence.journal) and parking a run, end to end: the whole loop over real
// sockets against a scripted OpenAI-compatible endpoint, a journal kept as JSON (what a store
// keeps), and a store that a crash leaves with its last checkpoint only (a dead process writes no
// onRunComplete). Every guard of journal.ts has a test here.

// ── the store ────────────────────────────────────────────────────────────────────────────────────

interface IStore {
  saved: Map<string, IRunSnapshot>
  writes: { hook: string; status: string; attempt?: number; error?: string }[]
  journal: Map<string, IJournalEntry[]>
  appends: IJournalEntry[]
  timeline: string[]
  persistence: IPersistence
  // Called with every entry before it is kept: throw to fail the append.
  onAppend?: (entry: IJournalEntry) => void
  // How long the store takes to keep an entry (default 5 ms).
  delayOf?: (entry: IJournalEntry) => number
}

const makeStore = (): IStore => {
  const store = {
    saved: new Map<string, IRunSnapshot>(),
    writes: [],
    journal: new Map<string, IJournalEntry[]>(),
    appends: [],
    timeline: [],
  } as unknown as IStore
  const write = (hook: string, keep: boolean) => (s: IRunSnapshot) => {
    store.writes.push({
      hook,
      status: s.status,
      ...(s.attempt !== undefined ? { attempt: s.attempt } : {}),
      ...(s.error ? { error: s.error } : {}),
    })
    store.timeline.push(`write:${hook}:${s.status}`)
    if (keep) {
      store.saved.set(s.runId, JSON.parse(JSON.stringify(s)) as IRunSnapshot)
    }
  }
  store.persistence = {
    onRunStart: write('onRunStart', true),
    onStepComplete: write('onStepComplete', true),
    onRunResume: write('onRunResume', true),
    onRunPark: write('onRunPark', true),
    // What a crash leaves: the last checkpoint. The end of a run that died is never written.
    onRunComplete: write('onRunComplete', false),
    loadRun: (runId) => structuredClone(store.saved.get(runId) ?? null),
    journal: {
      append: async (runId, entry) => {
        // A store that takes its time: an order that is not awaited shows.
        await new Promise((resolve) => setTimeout(resolve, store.delayOf?.(entry) ?? 5))
        store.onAppend?.(entry)
        const kept = JSON.parse(JSON.stringify(entry)) as IJournalEntry
        store.appends.push(kept)
        store.timeline.push(`append:${entry.kind}:${entry.position}`)
        const list = store.journal.get(runId) ?? []
        list.push(kept)
        store.journal.set(runId, list)
      },
      load: (runId) => structuredClone(store.journal.get(runId) ?? []),
    },
  }
  return store
}

const memoryLease = () => {
  const held = new Map<string, string>()
  const log: string[] = []
  const lease: IRunLease = {
    acquire: (runId, { owner }) => {
      if (held.has(runId)) return false
      held.set(runId, owner)
      log.push(`acquire:${runId}`)
      return true
    },
    renew: (runId, { owner }) => held.get(runId) === owner,
    release: (runId) => {
      held.delete(runId)
      log.push(`release:${runId}`)
    },
  }
  return { held, log, lease }
}

// ── tools ────────────────────────────────────────────────────────────────────────────────────────

const counted = (name: string, timeline?: string[]) => {
  const calls: unknown[] = []
  const make = (out: (input: { to: string }) => unknown, readOnly = false): Tool => {
    const t = tool({
      description: `${name}: does it (a ${readOnly ? 'read' : 'write'}).`,
      inputSchema: z.object({ to: z.string() }),
      execute: async (input) => {
        calls.push(input)
        timeline?.push(`tool:${name}`)
        return out(input)
      },
    })
    return readOnly ? markReadOnly(t) : t
  }
  return { calls, make }
}

// The executor's rounds of a step: the i-th answer once i rounds are done (assistant turns).
const roundOf = (req: IChatRequest): number =>
  req.messages.filter((m) => m.role === 'assistant').length

const script =
  (s: {
    rounds: IScriptedReply[]
    timeline?: string[]
    helper?: IScriptedReply[]
    planSkills?: string[]
    seen?: (req: IChatRequest) => void
  }) =>
  (req: IChatRequest): IScriptedReply => {
    s.seen?.(req)
    const stage = stageOf(req)
    s.timeline?.push(`request:${stage}`)
    const rounds = userOf(req).includes('HELPER-TASK') && s.helper ? s.helper : s.rounds
    switch (stage) {
      case 'planner': {
        const plan = JSON.parse(planJson([{ id: 's1' }])) as Record<string, unknown>
        return { text: JSON.stringify(s.planSkills ? { ...plan, skills: s.planSkills } : plan) }
      }
      case 'executor':
        return rounds[roundOf(req)] ?? { text: 'Step done.' }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'finish', reason: 'done' }) }
      default:
        return { text: 'All done.' }
    }
  }

const call = (name: string, args: unknown) => ({ toolCalls: [{ name, args }] })
const stagesSince = (requests: IChatRequest[], from: number): string[] =>
  requests.slice(from).map((r) => stageOf(r))

// ── the journal ──────────────────────────────────────────────────────────────────────────────────

test('journal: a model response is on record before its tool runs, a tool result before the model sees it', async () => {
  const store = makeStore()
  // Slow enough that a write the run did not wait for would land after what follows it.
  store.delayOf = () => 80
  const sent = counted('send_email', store.timeline)
  await withLlm(
    script({ timeline: store.timeline, rounds: [call('send_email', { to: 'a@x' })] }),
    async ({ llm, open }) => {
      const agent = await open(
        config(llm.baseURL, {
          persistence: store.persistence,
          tools: { send_email: sent.make((i) => `sent to ${i.to}`) },
        }),
      )
      const result = await agent.run({
        input: 'mail a',
        onEvent: (e) => {
          if (e.type === 'step.tool-call') store.timeline.push('event:step.tool-call')
        },
      })
      assert.equal(result.text, 'All done.')
      const t = store.timeline
      const at = (x: string, after = -1): number => {
        const i = t.findIndex((v, k) => v === x && k > after)
        assert.ok(i >= 0, `${x} in ${t.join(' ')}`)
        return i
      }
      assert.ok(at('append:model:1.0') < at('tool:send_email'), t.join(' '))
      // The response's tool calls are held until it is on record: nothing hears of them before.
      assert.ok(at('append:model:1.0') < at('event:step.tool-call'), t.join(' '))
      assert.ok(at('tool:send_email') < at('append:tool:1.0.t0'), t.join(' '))
      // The request that shows the model the result comes after the result is on record.
      const firstExecutor = at('request:executor')
      assert.ok(at('append:tool:1.0.t0') < at('request:executor', firstExecutor), t.join(' '))
      // Every call of the run is on record, at a position that does not depend on the attempt.
      assert.deepEqual(
        store.appends.map((e) => `${e.kind}:${e.position}`),
        ['model:0.0', 'model:1.0', 'tool:1.0.t0', 'model:1.1', 'model:f.0'],
      )
      const toolEntry = store.appends.find((e) => e.kind === 'tool')
      assert.equal(toolEntry?.kind === 'tool' && toolEntry.parent, 'a1:model:1.0')
    },
  )
})

test('journal: an append that fails ends the run as failed, with a clear error - and nothing more is sent', async () => {
  for (const failing of ['model', 'tool'] as const) {
    const store = makeStore()
    store.onAppend = (e) => {
      if (e.kind === failing && e.position.startsWith('1.')) throw new Error('disk full')
    }
    const sent = counted('send_email')
    await withLlm(
      script({ rounds: [call('send_email', { to: 'a@x' })] }),
      async ({ llm, open }) => {
        const agent = await open(
          config(llm.baseURL, {
            persistence: store.persistence,
            tools: { send_email: sent.make(() => 'sent') },
          }),
        )
        const { events, onEvent } = collect()
        await assert.rejects(
          agent.run({ input: 'mail a', onEvent }),
          (err: unknown) =>
            err instanceof JournalError &&
            /persistence\.journal\.append threw/.test(err.message) &&
            /disk full/.test(err.message),
        )
        const done = store.writes.find((w) => w.hook === 'onRunComplete')
        assert.equal(done?.status, 'failed', failing)
        assert.match(done?.error ?? '', /journal/)
        // Nothing after the failure: no tool for a response that is not on record, no request for
        // a result that is not.
        assert.deepEqual(stagesSince(llm.requests, 0), ['planner', 'executor'], failing)
        assert.equal(sent.calls.length, failing === 'model' ? 0 : 1, failing)
        assert.ok(ofType(events, 'error').some((e) => e.error instanceof JournalError))
      },
    )
  }
})

// The first attempt dies right after the step's tool result is on record (its process is gone:
// the store keeps the run's start). The resume must not ask the model again for what it answered,
// nor run the tool again.
const crashAfterToolResult = async (
  open: (c: IAgentConfig) => Promise<Awaited<ReturnType<typeof createAgent>>>,
  baseURL: string,
  store: IStore,
  tools: Record<string, Tool>,
): Promise<string> => {
  const ac = new AbortController()
  store.onAppend = (e) => {
    if (e.kind === 'tool') queueMicrotask(() => ac.abort())
  }
  const first = await open(config(baseURL, { persistence: store.persistence, tools }))
  await assert.rejects(first.run({ input: 'mail a', signal: ac.signal }))
  store.onAppend = undefined
  const [runId] = [...store.saved.keys()]
  return runId
}

test('journal: a resume replays the interrupted step - no request for a recorded response, no second run of a recorded tool call', async () => {
  const store = makeStore()
  const sent = counted('send_email')
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const tools = { send_email: sent.make((i) => `sent to ${i.to}`) }
    const runId = await crashAfterToolResult(open, llm.baseURL, store, tools)
    assert.equal(sent.calls.length, 1)
    assert.equal(store.saved.get(runId)?.trace.length, 0, 'the crash left the run at its start')

    const before = llm.requests.length
    const second = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
    const { events, onEvent } = collect()
    const result = await second.run({ input: '', resumeFromRunId: runId, onEvent })
    assert.equal(result.text, 'All done.')
    assert.equal(sent.calls.length, 1, 'the tool did not run again')
    // Only what was never answered goes out: the step's next round (it shows the recorded
    // result) and the answer.
    assert.deepEqual(stagesSince(llm.requests, before), ['executor', 'synthesizer'])
    const resumedExecutor = llm.requests.slice(before).find((r) => stageOf(r) === 'executor')
    assert.deepEqual(toolResults(resumedExecutor as IChatRequest), ['sent to a@x'])
    // The replayed calls emit their events again, under the new attempt.
    const calls = ofType(events, 'step.tool-call')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].attempt, 2)
    assert.deepEqual(
      ofType(events, 'step.tool-result').map((e) => e.output),
      ['sent to a@x'],
    )
    assert.deepEqual(
      result.trace[0].toolCalls.map((c) => c.output),
      ['sent to a@x'],
    )
    assert.equal(ofType(events, 'journal.diverged').length, 0)
  })
})

test('journal: a replayed call is not charged again and never reaches sharedLimits - the run total counts it once', async () => {
  const store = makeStore()
  const sent = counted('send_email')
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const tools = { send_email: sent.make(() => 'sent') }
    const runId = await crashAfterToolResult(open, llm.baseURL, store, tools)
    const asked: string[] = []
    const after: number[] = []
    const before = llm.requests.length
    const second = await open(
      config(llm.baseURL, {
        persistence: store.persistence,
        tools,
        sharedLimits: {
          beforeModelCall: (c) => {
            asked.push(c.stage)
          },
          afterModelCall: (_c, usage) => {
            after.push(usage.inputTokens)
          },
        },
      }),
    )
    const result = await second.run({ input: '', resumeFromRunId: runId })
    const live = llm.requests.length - before
    assert.equal(live, 2)
    assert.deepEqual(asked, ['executor', 'synthesizer'], 'asked for the live calls only')
    assert.deepEqual(after, [10, 10])
    // The agent that resumed spent the live calls only (10 in each, the endpoint's default).
    assert.equal(second.usage.inputTokens, 20)
    // The run's total: the planner (in the snapshot) + the replayed executor call (once, from the
    // journal) + the two live calls.
    assert.equal(result.usage.inputTokens, 40)
  })
})

test('journal: a run that diverged goes on live - one journal.diverged event, positions only', async () => {
  const store = makeStore()
  const sent = counted('send_email')
  await withLlm(
    script({ rounds: [call('send_email', { to: 'secret@x' })] }),
    async ({ llm, open }) => {
      const tools = { send_email: sent.make(() => 'SECRET-RESULT') }
      const runId = await crashAfterToolResult(open, llm.baseURL, store, tools)
      const before = llm.requests.length
      // Another system prompt: every request of the step differs from the recorded one.
      const second = await open(
        config(llm.baseURL, { persistence: store.persistence, tools, systemPrompt: 'Changed.' }),
      )
      const { events, onEvent } = collect()
      const result = await second.run({ input: '', resumeFromRunId: runId, onEvent })
      assert.equal(result.text, 'All done.')
      const diverged = ofType(events, 'journal.diverged')
      assert.equal(diverged.length, 1)
      assert.deepEqual(Object.keys(diverged[0]).sort(), [
        'attempt',
        'kind',
        'position',
        'runId',
        'seq',
        'stage',
        'type',
      ])
      assert.equal(diverged[0].position, '1.0')
      assert.equal(diverged[0].kind, 'model')
      assert.equal(diverged[0].stage, 'executor')
      assert.doesNotMatch(JSON.stringify(diverged[0]), /secret|SECRET/)
      // Live from there: the step is asked again and the tool runs again.
      assert.deepEqual(stagesSince(llm.requests, before), ['executor', 'executor', 'synthesizer'])
      assert.equal(sent.calls.length, 2)
    },
  )
})

test('journal: a crash between a tool run and its append re-runs that tool only (the documented window)', async () => {
  const store = makeStore()
  const looked = counted('lookup')
  const sent = counted('send_email')
  await withLlm(
    script({ rounds: [call('lookup', { to: 'a@x' }), call('send_email', { to: 'a@x' })] }),
    async ({ llm, open }) => {
      const tools = {
        lookup: looked.make(() => 'found', true),
        send_email: sent.make(() => 'sent'),
      }
      // The email went out, and the process died before its result was on record.
      store.onAppend = (e) => {
        if (e.kind === 'tool' && e.position === '1.1.t0') throw new Error('process died')
      }
      const first = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
      await assert.rejects(first.run({ input: 'look and mail' }))
      store.onAppend = undefined
      assert.deepEqual([looked.calls.length, sent.calls.length], [1, 1])
      const [runId] = [...store.saved.keys()]
      const before = llm.requests.length
      const second = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
      const result = await second.run({ input: '', resumeFromRunId: runId })
      assert.equal(result.text, 'All done.')
      assert.equal(looked.calls.length, 1, 'the recorded lookup was not run again')
      assert.equal(sent.calls.length, 2, 'the call whose result was not on record ran again')
      assert.deepEqual(stagesSince(llm.requests, before), ['executor', 'synthesizer'])
    },
  )
})

test('journal: with the hook on, a fresh run sends exactly what it sends without it', async () => {
  const wire = async (journal: boolean): Promise<unknown[]> => {
    const sent = counted('send_email')
    const llm = await startLocalOpenAI(
      script({ rounds: [call('send_email', { to: 'a@x' }), call('send_email', { to: 'b@x' })] }),
    )
    try {
      const agent = await createAgent(
        config(llm.baseURL, {
          ...(journal ? { persistence: makeStore().persistence } : {}),
          tools: { send_email: sent.make((i) => `sent to ${i.to}`) },
        }),
      )
      await agent.run({ input: 'mail two' })
      await agent.close()
      return llm.requests.map((r) => JSON.parse(JSON.stringify(r)) as unknown)
    } finally {
      await llm.close()
    }
  }
  assert.deepEqual(await wire(true), await wire(false))
})

// ── parking on a person's answer ─────────────────────────────────────────────────────────────────

const approvalConfig = (
  baseURL: string,
  store: IStore | undefined,
  tools: Record<string, Tool>,
  onRequest: (req: IToolApprovalRequest) => unknown,
  extra: Partial<IAgentConfig> = {},
): IAgentConfig =>
  config(baseURL, {
    ...(store ? { persistence: store.persistence } : {}),
    tools,
    toolApproval: {
      mode: 'ask-writes',
      onRequest: onRequest as NonNullable<IAgentConfig['toolApproval']>['onRequest'],
    },
    ...extra,
  })

test('park: the run stops without failing - snapshot waiting, run.parked, result.parked, lease released, no further model call', async () => {
  const store = makeStore()
  const sent = counted('send_email')
  const { lease, log, held } = memoryLease()
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const asked: IToolApprovalRequest[] = []
    const agent = await open(
      approvalConfig(
        llm.baseURL,
        store,
        { send_email: sent.make(() => 'sent') },
        (req) => {
          asked.push(req)
          return { park: true }
        },
        { runLease: lease },
      ),
    )
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'mail a', onEvent })
    assert.equal(result.text, '')
    assert.equal(result.parked?.items.length, 1)
    const [parkedRunId] = [...store.saved.keys()]
    assert.equal(result.parked?.runId, parkedRunId)
    const item = result.parked?.items[0] as Extract<ParkedItem, { kind: 'approval' }>
    assert.equal(item.kind, 'approval')
    assert.equal(item.id, asked[0].id)
    assert.equal(item.request.toolName, 'send_email')
    assert.deepEqual(item.request.input, { to: 'a@x' })
    // The event, the snapshot and the result say the same.
    const parked = ofType(events, 'run.parked')
    assert.equal(parked.length, 1)
    assert.deepEqual(parked[0].items, result.parked?.items)
    const resolved = ofType(events, 'tool.approval-resolved')
    assert.deepEqual(
      resolved.map((e) => [e.id, e.approved, e.parked]),
      [[item.id, false, true]],
    )
    const [runId] = [...store.saved.keys()]
    const snapshot = store.saved.get(runId) as IRunSnapshot
    assert.equal(snapshot.status, 'waiting')
    assert.deepEqual(snapshot.parked?.items, result.parked?.items)
    assert.equal(snapshot.trace.length, 0)
    assert.equal(snapshot.stepIndex, 0)
    assert.equal(snapshot.iterations, 0)
    assert.ok(store.writes.some((w) => w.hook === 'onRunPark' && w.status === 'waiting'))
    assert.ok(!store.writes.some((w) => w.hook === 'onRunComplete'), 'not a terminal status')
    // It stopped: nothing after the round that parked, and the tool never ran.
    assert.deepEqual(stagesSince(llm.requests, 0), ['planner', 'executor'])
    assert.equal(sent.calls.length, 0)
    assert.deepEqual(log, [`acquire:${runId}`, `release:${runId}`])
    assert.equal(held.size, 0)
    assert.ok(!ofType(events, 'error').length)
  })
})

const parkFirst = async (
  open: (c: IAgentConfig) => Promise<Awaited<ReturnType<typeof createAgent>>>,
  baseURL: string,
  store: IStore,
  tools: Record<string, Tool>,
): Promise<{ runId: string; id: string }> => {
  const first = await open(approvalConfig(baseURL, store, tools, () => ({ park: true })))
  const result = await first.run({ input: 'mail a' })
  const id = result.parked?.items[0]?.id as string
  assert.ok(id)
  const [runId] = [...store.saved.keys()]
  return { runId, id }
}

test('park: resume with allow - the write runs exactly once across park, resume and a crash after the answer', async () => {
  const store = makeStore()
  const sent = counted('send_email')
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const tools = { send_email: sent.make(() => 'sent') }
    const { runId, id } = await parkFirst(open, llm.baseURL, store, tools)
    // The resume: answered from `answers`, nobody is asked; it dies once the result is on record.
    let asked = 0
    const ac = new AbortController()
    store.onAppend = (e) => {
      if (e.kind === 'tool') queueMicrotask(() => ac.abort())
    }
    const second = await open(
      approvalConfig(llm.baseURL, store, tools, () => {
        asked++
        return true
      }),
    )
    const { events, onEvent } = collect()
    await assert.rejects(
      second.run({
        input: '',
        resumeFromRunId: runId,
        answers: { [id]: true },
        signal: ac.signal,
        onEvent,
      }),
    )
    store.onAppend = undefined
    assert.equal(sent.calls.length, 1)
    assert.equal(asked, 0, 'the answer came from answers')
    assert.deepEqual(
      ofType(events, 'tool.approval-resolved').map((e) => [e.id, e.approved, e.automatic]),
      [[id, true, false]],
    )
    assert.ok(store.appends.some((e) => e.kind === 'answer' && e.itemId === id))
    // A third worker, without the answer (it is on record): the write is not run again.
    const third = await open(
      approvalConfig(llm.baseURL, store, tools, () => {
        asked++
        return { park: true }
      }),
    )
    const result = await third.run({ input: '', resumeFromRunId: runId })
    assert.equal(result.text, 'All done.')
    assert.equal(result.parked, undefined)
    assert.equal(sent.calls.length, 1, 'once, across park + resume + crash')
    assert.equal(asked, 0)
  })
})

test('park: resume with deny - the call fails as a denial, the write never runs, the run goes on', async () => {
  const store = makeStore()
  const sent = counted('send_email')
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const tools = { send_email: sent.make(() => 'sent') }
    const { runId, id } = await parkFirst(open, llm.baseURL, store, tools)
    const second = await open(approvalConfig(llm.baseURL, store, tools, () => true))
    const result = await second.run({
      input: '',
      resumeFromRunId: runId,
      answers: { [id]: { approved: false, reason: 'not today' } },
    })
    assert.equal(result.text, 'All done.')
    assert.equal(sent.calls.length, 0)
    const [c] = result.trace[0].toolCalls
    assert.equal(c.ok, false)
    assert.match(JSON.stringify(c.output), /not today/)
  })
})

test('park: a resume without an answer parks again at once, nobody asked - with the same stable id', async () => {
  const store = makeStore()
  const sent = counted('send_email')
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const tools = { send_email: sent.make(() => 'sent') }
    const { runId, id } = await parkFirst(open, llm.baseURL, store, tools)
    let asked = 0
    const before = llm.requests.length
    const second = await open(
      approvalConfig(llm.baseURL, store, tools, () => {
        asked++
        return true
      }),
    )
    const { events, onEvent } = collect()
    const result = await second.run({ input: '', resumeFromRunId: runId, onEvent })
    assert.equal(asked, 0)
    assert.deepEqual(
      result.parked?.items.map((i) => i.id),
      [id],
      'the same id on the replay',
    )
    assert.deepEqual(
      ofType(events, 'tool.approval-requested').map((e) => e.id),
      [id],
    )
    assert.equal(llm.requests.length, before, 'the parked step replayed: nothing was sent')
    assert.equal(store.saved.get(runId)?.status, 'waiting')
    assert.equal(store.saved.get(runId)?.attempt, 2)
    assert.equal(sent.calls.length, 0)
  })
})

test('park: an answer for an id that is not pending is refused - and the resume does not start', async () => {
  const store = makeStore()
  const sent = counted('send_email')
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const tools = { send_email: sent.make(() => 'sent') }
    const { runId, id } = await parkFirst(open, llm.baseURL, store, tools)
    const second = await open(approvalConfig(llm.baseURL, store, tools, () => true))
    const before = llm.requests.length
    const writes = store.writes.length
    await assert.rejects(
      second.run({ input: '', resumeFromRunId: runId, answers: { p_not_pending: true } }),
      /answers\["p_not_pending"\] was refused: no item with that id is pending/,
    )
    // The wrong shape for the item's kind.
    await assert.rejects(
      second.run({ input: '', resumeFromRunId: runId, answers: { [id]: { output: 'x' } } }),
      /was refused: an 'approval' item takes/,
    )
    await assert.rejects(
      second.run({
        input: '',
        resumeFromRunId: runId,
        answers: { [id]: { approved: true, park: true } as never },
      }),
      /was refused/,
    )
    assert.equal(llm.requests.length, before)
    assert.equal(store.writes.length, writes, 'no attempt on record')
    // A fresh run has nothing pending.
    await assert.rejects(second.run({ input: 'x', answers: { [id]: true } }), /was refused/)
    assert.equal(sent.calls.length, 0)
  })
})

test('park: without the journal hook a park answer is a denial, with a reason', async () => {
  const sent = counted('send_email')
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const agent = await open(
      approvalConfig(llm.baseURL, undefined, { send_email: sent.make(() => 'sent') }, () => ({
        park: true,
      })),
    )
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'mail a', onEvent })
    assert.equal(result.parked, undefined)
    assert.equal(result.text, 'All done.')
    assert.equal(sent.calls.length, 0)
    const [resolved] = ofType(events, 'tool.approval-resolved')
    assert.equal(resolved.approved, false)
    assert.equal(resolved.automatic, true)
    assert.match(
      resolved.reason ?? '',
      /cannot park: parking a run needs config\.persistence\.journal/,
    )
    assert.equal(result.trace[0].toolCalls[0].ok, false)
  })
})

test("park: an MCP server's skill consent parks and resumes", async () => {
  const srv = await startLocalMcpServer({ protocol: 'modern', skills: true })
  const store = makeStore()
  try {
    await withLlm(
      script({ rounds: [call('load_skill', { name: 'docs/git-workflow' })] }),
      async ({ llm, open }) => {
        const asked: IToolApprovalRequest[] = []
        const cfg = (onRequest: (req: IToolApprovalRequest) => unknown) =>
          config(llm.baseURL, {
            persistence: store.persistence,
            mcpServers: { docs: { url: srv.url, protocol: 'modern', skills: true } },
            toolApproval: {
              onRequest: onRequest as NonNullable<IAgentConfig['toolApproval']>['onRequest'],
            },
          })
        const first = await open(
          cfg((req) => {
            asked.push(req)
            return { park: true }
          }),
        )
        const parked = await first.run({ input: 'use the git skill' })
        const item = parked.parked?.items[0] as Extract<ParkedItem, { kind: 'approval' }>
        assert.equal(item?.kind, 'approval')
        assert.equal(item.request.toolName, 'load_skill')
        assert.equal(item.request.skill?.name, 'docs/git-workflow')
        assert.equal(item.id, asked[0].id)
        const [runId] = [...store.saved.keys()]
        assert.equal(store.saved.get(runId)?.status, 'waiting')

        const before = llm.requests.length
        const second = await open(cfg(() => assert.fail('nobody is asked on the resume')))
        const result = await second.run({
          input: '',
          resumeFromRunId: runId,
          answers: { [item.id]: true },
        })
        assert.equal(result.text, 'All done.')
        const resumed = llm.requests.slice(before).find((r) => stageOf(r) === 'executor')
        assert.match(
          toolResults(resumed as IChatRequest).join('\n'),
          new RegExp(SKILL_MARKERS.gitWorkflow),
        )
      },
    )
  } finally {
    await srv.close()
  }
})

// ── parking on a result from outside (deferResult) ───────────────────────────────────────────────

const deferring = (name: string, note?: string) => {
  const calls: unknown[] = []
  const make = (): Tool =>
    tool({
      description: `${name}: starts a job whose result comes later.`,
      inputSchema: z.object({ to: z.string() }),
      execute: async (input) => {
        calls.push(input)
        return deferResult(note ? { note } : {})
      },
    })
  return { calls, make }
}

test('defer: a round with two deferred calls and a normal one parks once, with two items - the normal call is not run again', async () => {
  const store = makeStore()
  const a = deferring('job_a', 'queued as #1')
  const b = deferring('job_b')
  const sent = counted('send_email')
  const round = {
    toolCalls: [
      { name: 'job_a', args: { to: 'a' } },
      { name: 'send_email', args: { to: 'c@x' } },
      { name: 'job_b', args: { to: 'b' } },
    ],
  }
  await withLlm(script({ rounds: [round] }), async ({ llm, open }) => {
    const tools = { job_a: a.make(), job_b: b.make(), send_email: sent.make(() => 'sent') }
    const first = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
    const { events, onEvent } = collect()
    const parked = await first.run({ input: 'three things', onEvent })
    const items = parked.parked?.items ?? []
    assert.deepEqual(
      items.map((i) => [
        i.kind,
        i.kind === 'tool' ? i.toolName : '',
        i.kind === 'tool' ? i.note : '',
      ]),
      [
        ['tool', 'job_a', 'queued as #1'],
        ['tool', 'job_b', undefined],
      ],
    )
    assert.equal(ofType(events, 'run.parked').length, 1)
    assert.equal(sent.calls.length, 1, 'the normal call settled with the round')
    assert.ok(store.appends.some((e) => e.kind === 'tool' && e.tool === 'send_email'))
    assert.deepEqual(stagesSince(llm.requests, 0), ['planner', 'executor'])
    // No result event for a call that has none yet.
    assert.deepEqual(
      ofType(events, 'step.tool-result').map((e) => e.name),
      ['send_email'],
    )

    const [runId] = [...store.saved.keys()]
    const before = llm.requests.length
    const second = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
    const result = await second.run({
      input: '',
      resumeFromRunId: runId,
      answers: { [items[0].id]: { output: 'A-RESULT' }, [items[1].id]: { error: 'B failed' } },
    })
    assert.equal(result.text, 'All done.')
    assert.equal(sent.calls.length, 1, 'answered from the journal')
    assert.deepEqual(
      [a.calls.length, b.calls.length],
      [1, 1],
      'a deferred call does not start again',
    )
    const resumed = llm.requests.slice(before).find((r) => stageOf(r) === 'executor')
    const shown = toolResults(resumed as IChatRequest).join('\n')
    assert.match(shown, /A-RESULT/)
    assert.match(shown, /sent/)
    assert.match(shown, /B failed/)
    // Parallel calls, in the order they settled.
    assert.deepEqual(result.trace[0].toolCalls.map((c) => `${c.name}:${c.ok}`).sort(), [
      'job_a:true',
      'job_b:false',
      'send_email:true',
    ])
  })
})

test('defer: a partial answer parks again with the rest - the answered item is on record, its id stays', async () => {
  const store = makeStore()
  const a = deferring('job_a')
  const b = deferring('job_b')
  const round = {
    toolCalls: [
      { name: 'job_a', args: { to: 'a' } },
      { name: 'job_b', args: { to: 'b' } },
    ],
  }
  await withLlm(script({ rounds: [round] }), async ({ llm, open }) => {
    const tools = { job_a: a.make(), job_b: b.make() }
    const first = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
    const parked = await first.run({ input: 'two jobs' })
    const [ia, ib] = parked.parked?.items ?? []
    const [runId] = [...store.saved.keys()]
    const second = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
    const again = await second.run({
      input: '',
      resumeFromRunId: runId,
      answers: { [ia.id]: { output: 'A-DONE' } },
    })
    assert.deepEqual(
      again.parked?.items.map((i) => i.id),
      [ib.id],
    )
    assert.equal(store.saved.get(runId)?.status, 'waiting')
    // The last answer alone finishes it: A's is on record, not needed again - and a retried
    // resume that still sends it is not an error.
    const third = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
    const result = await third.run({
      input: '',
      resumeFromRunId: runId,
      answers: { [ib.id]: { output: 'B-DONE' }, [ia.id]: { output: 'A-DONE' } },
    })
    assert.equal(result.text, 'All done.')
    assert.deepEqual(result.trace[0].toolCalls.map((c) => c.output).sort(), ['A-DONE', 'B-DONE'])
    assert.deepEqual([a.calls.length, b.calls.length], [1, 1])
  })
})

test('defer: a tool answer is untrusted - shape checked, cleaned, sanitized and capped like any tool output', async () => {
  const store = makeStore()
  const a = deferring('job_a')
  await withLlm(script({ rounds: [call('job_a', { to: 'a' })] }), async ({ llm, open }) => {
    const tools = { job_a: a.make() }
    const extra = {
      persistence: store.persistence,
      tools,
      compaction: { maxToolOutputChars: 120 },
      outputSanitizer: (_name: string, output: unknown) =>
        JSON.parse(JSON.stringify(output).replaceAll('SECRET', '[redacted]')) as unknown,
    }
    const first = await open(config(llm.baseURL, extra))
    const parked = await first.run({ input: 'a job' })
    const [item] = parked.parked?.items ?? []
    const [runId] = [...store.saved.keys()]
    const second = await open(config(llm.baseURL, extra))
    for (const bad of [
      'just a string',
      { output: 'x', extra: 1 },
      { error: '' },
      { output: new Date() },
      { output: { n: Number.NaN } },
      { output: 'x'.repeat(1_000_001) },
    ]) {
      await assert.rejects(
        second.run({ input: '', resumeFromRunId: runId, answers: { [item.id]: bad as never } }),
        /was refused/,
        JSON.stringify(bad).slice(0, 40),
      )
    }
    const before = llm.requests.length
    const result = await second.run({
      input: '',
      resumeFromRunId: runId,
      answers: {
        [item.id]: { output: `SECRET start\u200B\u202E${'y'.repeat(400)} end` },
      },
    })
    assert.equal(result.text, 'All done.')
    const resumed = llm.requests.slice(before).find((r) => stageOf(r) === 'executor')
    const [shown] = toolResults(resumed as IChatRequest)
    assert.doesNotMatch(shown, /SECRET/)
    assert.doesNotMatch(shown, /[\u200B\u202E]/)
    assert.match(shown, /\[redacted\] start/)
    assert.match(shown, /truncated/)
    assert.ok(shown.length < 300, `capped: ${shown.length}`)
  })
})

test('defer: without the journal hook deferResult fails the call, with a clear error', async () => {
  const a = deferring('job_a')
  await withLlm(script({ rounds: [call('job_a', { to: 'a' })] }), async ({ llm, open }) => {
    const agent = await open(config(llm.baseURL, { tools: { job_a: a.make() } }))
    const result = await agent.run({ input: 'a job' })
    assert.equal(result.parked, undefined)
    assert.equal(result.text, 'All done.')
    const [c] = result.trace[0].toolCalls
    assert.equal(c.ok, false)
    assert.match(JSON.stringify(c.output), /deferResult\(\).*needs config\.persistence\.journal/)
  })
})

test('defer: a remote dispatch that returns deferResult parks - the answer is the call result', async () => {
  const store = makeStore()
  let dispatched = 0
  await withLlm(
    script({ rounds: [call('researcher', { task: 'find it' })] }),
    async ({ llm, open }) => {
      const tools = {
        researcher: createSubagentTool({
          name: 'researcher',
          description: 'Researches on another worker.',
          isolation: 'remote',
          dispatch: async () => {
            dispatched++
            return deferResult({ note: 'queued on the research pool' })
          },
        }),
      }
      const first = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
      const parked = await first.run({ input: 'research' })
      const [item] = parked.parked?.items ?? []
      assert.equal(item?.kind, 'tool')
      assert.equal(item.kind === 'tool' && item.toolName, 'researcher')
      assert.equal(item.kind === 'tool' && item.note, 'queued on the research pool')
      const [runId] = [...store.saved.keys()]
      const before = llm.requests.length
      const second = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
      const result = await second.run({
        input: '',
        resumeFromRunId: runId,
        answers: { [item.id]: { output: 'THE-CHILD-ANSWER' } },
      })
      assert.equal(result.text, 'All done.')
      assert.equal(dispatched, 1)
      const resumed = llm.requests.slice(before).find((r) => stageOf(r) === 'executor')
      assert.match(toolResults(resumed as IChatRequest).join('\n'), /THE-CHILD-ANSWER/)
    },
  )
})

test('defer: inside a helper the model started, the whole run parks with the item - and the helper replays on resume', async () => {
  const store = makeStore()
  const a = deferring('job_a', 'helper job')
  const helperRequests = (requests: IChatRequest[]) =>
    requests.filter((r) => userOf(r).includes('HELPER-TASK'))
  await withLlm(
    script({
      rounds: [call('spawn_subagent', { task: 'HELPER-TASK: run job a', tools: ['job_a'] })],
      helper: [call('job_a', { to: 'a' })],
    }),
    async ({ llm, open }) => {
      const tools = { job_a: a.make() }
      const cfg = config(llm.baseURL, {
        persistence: store.persistence,
        tools,
        subagents: { dynamic: true },
      })
      const first = await open(cfg)
      const parked = await first.run({ input: 'delegate' })
      const [item] = parked.parked?.items ?? []
      assert.equal(item?.kind, 'tool')
      assert.equal(item.kind === 'tool' && item.toolName, 'job_a')
      assert.ok(item.kind === 'tool' && item.subagent?.id, 'the helper made the call')
      const helperBefore = helperRequests(llm.requests).length
      assert.ok(helperBefore >= 2, 'the helper planned and executed')
      const [runId] = [...store.saved.keys()]
      const second = await open(cfg)
      const result = await second.run({
        input: '',
        resumeFromRunId: runId,
        answers: { [item.id]: { output: 'JOB-A-RESULT' } },
      })
      assert.equal(result.text, 'All done.')
      assert.equal(a.calls.length, 1)
      // The helper's recorded calls replayed: its new requests are the round after the answer and
      // its answer, nothing it had sent before.
      const helperAfter = helperRequests(llm.requests).slice(helperBefore)
      assert.deepEqual(
        helperAfter.map((r) => stageOf(r)),
        ['executor', 'synthesizer'],
      )
      assert.match(toolResults(helperAfter[0]).join('\n'), /JOB-A-RESULT/)
    },
  )
})

test('defer: inside an in-process subagent, the whole run parks with the item', async () => {
  const store = makeStore()
  const a = deferring('job_a')
  await withLlm(
    script({
      rounds: [call('child', { task: 'HELPER-TASK: run job a' })],
      helper: [call('job_a', { to: 'a' })],
    }),
    async ({ llm, open }) => {
      const tools = {
        child: createSubagentTool({
          name: 'child',
          description: 'A child agent.',
          isolation: 'in-process',
          config: config(llm.baseURL, { tools: { job_a: a.make() } }),
        }),
      }
      const cfg = config(llm.baseURL, { persistence: store.persistence, tools })
      const first = await open(cfg)
      const parked = await first.run({ input: 'delegate' })
      const [item] = parked.parked?.items ?? []
      assert.equal(item?.kind === 'tool' && item.toolName, 'job_a')
      const [runId] = [...store.saved.keys()]
      const second = await open(cfg)
      const result = await second.run({
        input: '',
        resumeFromRunId: runId,
        answers: { [item.id]: { output: 'CHILD-JOB-RESULT' } },
      })
      assert.equal(result.text, 'All done.')
      assert.equal(a.calls.length, 1)
    },
  )
})

test('journal: createAgent refuses a journal it cannot use', async () => {
  const base = config('http://127.0.0.1:9', {})
  await assert.rejects(
    createAgent({ ...base, persistence: { journal: { append: () => {} } as never } }),
    /persistence\.journal must be/,
  )
  await assert.rejects(
    createAgent({ ...base, persistence: { journal: { append: () => {}, load: () => [] } } }),
    /needs persistence\.loadRun/,
  )
})

test('journal: a waiting run cannot be resumed without the journal hook', async () => {
  const store = makeStore()
  const sent = counted('send_email')
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const tools = { send_email: sent.make(() => 'sent') }
    const { runId } = await parkFirst(open, llm.baseURL, store, tools)
    const { journal: _journal, ...withoutJournal } = store.persistence
    void _journal
    const second = await open(
      approvalConfig(llm.baseURL, undefined, tools, () => true, { persistence: withoutJournal }),
    )
    await assert.rejects(
      second.run({ input: '', resumeFromRunId: runId }),
      /waits for answers; resuming it needs config\.persistence\.journal/,
    )
  })
})

test('journal: a tool call is answered from the record of its own response - never from another branch of the run', async () => {
  const store = makeStore()
  let n = 0
  const tools = {
    stamp: tool({
      description: 'Stamps (a write).',
      inputSchema: z.object({ to: z.string() }),
      execute: async () => `result #${++n}`,
    }),
  }
  await withLlm(script({ rounds: [call('stamp', { to: 'a' })] }), async ({ llm, open }) => {
    // Each attempt dies once its tool result is on record.
    const attempt = async (extra: Partial<IAgentConfig>, resume?: string) => {
      const ac = new AbortController()
      store.onAppend = (e) => {
        if (e.kind === 'tool') queueMicrotask(() => ac.abort())
      }
      const agent = await open(
        config(llm.baseURL, { persistence: store.persistence, tools, ...extra }),
      )
      await assert.rejects(
        agent.run({
          input: 'stamp it',
          signal: ac.signal,
          ...(resume ? { resumeFromRunId: resume } : {}),
        }),
      )
      store.onAppend = undefined
      return [...store.saved.keys()][0]
    }
    const runId = await attempt({})
    // A second branch: another prompt diverges at the step, the same call runs again live.
    await attempt({ systemPrompt: 'Changed.' }, runId)
    assert.equal(n, 2)
    // The first prompt again: its recorded response replays - and so does ITS result, not the
    // later one of the other branch at the same position.
    const before = llm.requests.length
    const third = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
    const result = await third.run({ input: '', resumeFromRunId: runId })
    assert.equal(result.text, 'All done.')
    assert.equal(n, 2)
    const resumed = llm.requests.slice(before).find((r) => stageOf(r) === 'executor')
    assert.deepEqual(toolResults(resumed as IChatRequest), ['result #1'])
  })
})

test('journal: stable serialization - key order, bytes and dates do not change a hash', () => {
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}')
  assert.equal(journalHash({ x: 1, y: 2 }), journalHash({ y: 2, x: 1 }))
  assert.notEqual(journalHash({ x: 1 }), journalHash({ x: 2 }))
  assert.equal(
    stableJson({ at: new Date('2026-01-02T03:04:05.000Z'), bytes: new Uint8Array([1, 2]) }),
    '{"at":{"$date":"2026-01-02T03:04:05.000Z"},"bytes":{"$bytes":"AQI="}}',
  )
  const loop: Record<string, unknown> = { a: 1 }
  loop.self = loop
  assert.equal(stableJson(loop), '{"a":1,"self":"[circular]"}')
})

test('park: helpers started in the parked step count once across the resume (maxChildren)', async () => {
  const store = makeStore()
  const a = deferring('job_a')
  await withLlm(
    script({
      rounds: [
        {
          toolCalls: [
            { name: 'spawn_subagent', args: { task: 'HELPER-TASK one', tools: [] } },
            { name: 'job_a', args: { to: 'a' } },
          ],
        },
        call('spawn_subagent', { task: 'HELPER-TASK two', tools: [] }),
      ],
      helper: [],
    }),
    async ({ llm, open }) => {
      const cfg = config(llm.baseURL, {
        persistence: store.persistence,
        tools: { job_a: a.make() },
        subagents: { dynamic: { maxChildren: 1 } },
      })
      const first = await open(cfg)
      const parked = await first.run({ input: 'delegate and wait' })
      const [item] = parked.parked?.items ?? []
      assert.equal(item?.kind === 'tool' && item.toolName, 'job_a')
      const [runId] = [...store.saved.keys()]
      const second = await open(cfg)
      const { events, onEvent } = collect()
      const result = await second.run({
        input: '',
        resumeFromRunId: runId,
        answers: { [item.id]: { output: 'done' } },
        onEvent,
      })
      assert.equal(result.text, 'All done.')
      // The first helper ran again inside its replayed call (counted again), so the second one
      // is past maxChildren.
      assert.equal(ofType(events, 'subagent.start').length, 1)
      assert.ok(!llm.requests.some((r) => userOf(r).includes('HELPER-TASK two')))
      const spawns = result.trace[0].toolCalls.filter((c) => c.name === 'spawn_subagent')
      assert.deepEqual(
        spawns.map((c) => c.ok),
        [true, false],
      )
    },
  )
})

test('park: calls answered without running still count against maxToolCalls on the resume', async () => {
  const store = makeStore()
  const a = deferring('job_a')
  const sent = counted('send_email')
  await withLlm(
    script({
      rounds: [
        {
          toolCalls: [
            { name: 'send_email', args: { to: 'a@x' } },
            { name: 'job_a', args: { to: 'a' } },
          ],
        },
        call('send_email', { to: 'b@x' }),
      ],
    }),
    async ({ llm, open }) => {
      const cfg = config(llm.baseURL, {
        persistence: store.persistence,
        tools: { job_a: a.make(), send_email: sent.make(() => 'sent') },
        maxToolCalls: 2,
      })
      const first = await open(cfg)
      const parked = await first.run({ input: 'two calls' })
      const [item] = parked.parked?.items ?? []
      const [runId] = [...store.saved.keys()]
      const before = llm.requests.length
      const second = await open(cfg)
      const { events, onEvent } = collect()
      const result = await second.run({
        input: '',
        resumeFromRunId: runId,
        answers: { [item.id]: { output: 'done' } },
        onEvent,
      })
      assert.equal(result.text, 'All done.')
      // The replayed email and the answered job are the run's two calls: the step stops there.
      assert.deepEqual(stagesSince(llm.requests, before), ['synthesizer'])
      assert.equal(ofType(events, 'budget.exceeded')[0]?.kind, 'tool-calls')
      assert.equal(sent.calls.length, 1)
    },
  )
})

test('park: a question asked outside a tool call (an MCP skill the planner picked) cannot park - it is a denial', async () => {
  const srv = await startLocalMcpServer({ protocol: 'modern', skills: true })
  const store = makeStore()
  try {
    await withLlm(
      script({ rounds: [{ text: 'Step done.' }], planSkills: ['docs/git-workflow'] }),
      async ({ llm, open }) => {
        const agent = await open(
          config(llm.baseURL, {
            persistence: store.persistence,
            mcpServers: { docs: { url: srv.url, protocol: 'modern', skills: true } },
            toolApproval: { onRequest: () => ({ park: true }) },
          }),
        )
        const { events, onEvent } = collect()
        const result = await agent.run({ input: 'use the git skill', onEvent })
        assert.equal(result.parked, undefined)
        assert.equal(result.text, 'All done.')
        const [resolved] = ofType(events, 'tool.approval-resolved')
        assert.equal(resolved.approved, false)
        assert.match(
          resolved.reason ?? '',
          /cannot park: the question is not asked from a tool call/,
        )
        assert.ok(!ofType(events, 'skill.activated').length)
      },
    )
  } finally {
    await srv.close()
  }
})

test('park: a park that cannot go on record fails the run', async () => {
  const store = makeStore()
  store.persistence.onRunPark = () => {
    throw new Error('db down')
  }
  const sent = counted('send_email')
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const agent = await open(
      approvalConfig(llm.baseURL, store, { send_email: sent.make(() => 'sent') }, () => ({
        park: true,
      })),
    )
    await assert.rejects(
      agent.run({ input: 'mail a' }),
      /\[park\] persistence\.onRunPark threw while parking run .*: db down/,
    )
    assert.equal(store.writes.find((w) => w.hook === 'onRunComplete')?.status, 'failed')
  })
})

test('journal: once the lease is lost, nothing more is appended', async () => {
  const store = makeStore()
  const tools = {
    send_email: tool({
      description: 'Send an email (slow).',
      inputSchema: z.object({ to: z.string() }),
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 800))
        return 'sent'
      },
    }),
  }
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const agent = await open(
      config(llm.baseURL, {
        persistence: store.persistence,
        tools,
        runLease: {
          acquire: () => true,
          renew: () => false,
          release: () => {},
          ttlMs: 1_000,
        },
      }),
    )
    await assert.rejects(agent.run({ input: 'mail a' }), RunLeaseError)
    // Wait for the tool to finish: its result must not be appended for a run this worker lost.
    await new Promise((resolve) => setTimeout(resolve, 900))
    assert.ok(!store.appends.some((e) => e.kind === 'tool'), store.timeline.join(' '))
  })
})

test('park: an answer on record is not needed again after a crash before the call ran', async () => {
  const store = makeStore()
  const sent: unknown[] = []
  const tools = {
    send_email: tool({
      description: 'Send an email (a write).',
      inputSchema: z.object({ to: z.string() }),
      execute: async (input, { abortSignal }) => {
        // The process died before the email went out.
        if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError')
        sent.push(input)
        return 'sent'
      },
    }),
  }
  await withLlm(script({ rounds: [call('send_email', { to: 'a@x' })] }), async ({ llm, open }) => {
    const { runId, id } = await parkFirst(open, llm.baseURL, store, tools)
    const ac = new AbortController()
    store.onAppend = (e) => {
      if (e.kind === 'answer') queueMicrotask(() => ac.abort())
    }
    const second = await open(approvalConfig(llm.baseURL, store, tools, () => true))
    await assert.rejects(
      second.run({ input: '', resumeFromRunId: runId, answers: { [id]: true }, signal: ac.signal }),
    )
    store.onAppend = undefined
    assert.equal(sent.length, 0)
    let asked = 0
    const third = await open(
      approvalConfig(llm.baseURL, store, tools, () => {
        asked++
        return { park: true }
      }),
    )
    const result = await third.run({ input: '', resumeFromRunId: runId })
    assert.equal(result.parked, undefined, 'the answer on record stands: no park, nobody asked')
    assert.equal(asked, 0)
    assert.equal(sent.length, 1)
  })
})

test('journal: a recorded failure replays as the same failure - the tool does not run again', async () => {
  const store = makeStore()
  let n = 0
  const tools = {
    flaky: tool({
      description: 'Fails (a write).',
      inputSchema: z.object({ to: z.string() }),
      execute: async (): Promise<string> => {
        throw new Error(`boom #${++n}`)
      },
    }),
  }
  await withLlm(script({ rounds: [call('flaky', { to: 'a' })] }), async ({ llm, open }) => {
    const runId = await crashAfterToolResult(open, llm.baseURL, store, tools)
    assert.equal(n, 1)
    const before = llm.requests.length
    const second = await open(config(llm.baseURL, { persistence: store.persistence, tools }))
    const result = await second.run({ input: '', resumeFromRunId: runId })
    assert.equal(result.text, 'All done.')
    assert.equal(n, 1)
    const resumed = llm.requests.slice(before).find((r) => stageOf(r) === 'executor')
    assert.match(toolResults(resumed as IChatRequest).join('\n'), /boom #1/)
    assert.equal(result.trace[0].toolCalls[0].ok, false)
  })
})

test('park: a subagent whose own journal parks its run is refused - only the run the host started waits', async () => {
  const childStore = makeStore()
  const a = deferring('job_a')
  await withLlm(
    script({
      rounds: [call('child', { task: 'HELPER-TASK: run job a' })],
      helper: [call('job_a', { to: 'a' })],
    }),
    async ({ llm, open }) => {
      const tools = {
        child: createSubagentTool({
          name: 'child',
          description: 'A child agent.',
          isolation: 'in-process',
          config: config(llm.baseURL, {
            persistence: childStore.persistence,
            tools: { job_a: a.make() },
          }),
        }),
      }
      // The calling agent has no journal: the child's run is a run of its own.
      const agent = await open(config(llm.baseURL, { tools }))
      const result = await agent.run({ input: 'delegate' })
      assert.equal(result.parked, undefined)
      const [c] = result.trace[0].toolCalls
      assert.equal(c.ok, false)
      assert.match((c.output as Error).message, /its run parked, and a subagent's run cannot wait/)
    },
  )
})

test('park: a pipeline node whose run parks fails the node - a pipeline cannot wait', async () => {
  const store = makeStore()
  const a = deferring('job_a')
  const llm = await startLocalOpenAI(script({ rounds: [call('job_a', { to: 'a' })] }))
  const pipeline = createPipeline(
    { version: 1, name: 'one', entry: 'n1', nodes: [{ id: 'n1' }], edges: [] },
    {
      resolveNode: nodeResolver({
        base: config(llm.baseURL, { persistence: store.persistence, tools: { job_a: a.make() } }),
      }),
    },
  )
  try {
    await assert.rejects(
      pipeline.run({ input: 'go' }),
      /its run parked .*a pipeline node cannot wait/,
    )
  } finally {
    await pipeline.close()
    await llm.close()
  }
})

// Events stay typed: a consumer can switch on the new names.
const _typed = (e: AgentEvent): string =>
  e.type === 'run.parked'
    ? e.items.map((i) => i.id).join(',')
    : e.type === 'journal.diverged'
      ? e.position
      : ''
void _typed
