import assert from 'node:assert/strict'
import test from 'node:test'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createSubagentTool,
  type AgentEvent,
  type IPersistence,
  type IRunSnapshot,
} from '../src/index.ts'
import { resolveResume } from '../src/runner.ts'
import type { IAgentInternalContext } from '../src/internal.ts'
import { hasToolResult, systemOf, toolResults, userOf } from './helpers/openai-server.ts'
import {
  collect,
  config,
  linearScript,
  ofType,
  planJson,
  stageOf,
  withLlm,
} from './helpers/loop.ts'

// Event order across crashes: every event of a run carries `seq` (1, 2, ... within one attempt)
// and `attempt` (1 for the run as first started, one more for every resume), and (attempt, seq)
// orders the events of a run totally - however many times its process died, and wherever it
// died. A resume puts its attempt on record BEFORE it emits anything: otherwise a crash before
// its first checkpoint would hand the next resume the same number.

const seqs = (events: AgentEvent[]): number[] => events.map((e) => e.seq as number)
const attempts = (events: AgentEvent[]): (number | undefined)[] => [
  ...new Set(events.map((e) => e.attempt)),
]
const oneTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)

// The store a crash leaves behind: the last write and nothing else (a dead process writes no
// onRunComplete). `timeline` interleaves the writes with the events, in the order they happened.
const crashStore = (options: { resumeHook?: boolean } = {}) => {
  const saved = new Map<string, IRunSnapshot>()
  const writes: { hook: string; attempt?: number; trace: number }[] = []
  const timeline: string[] = []
  const write = (hook: string) => (snapshot: IRunSnapshot) => {
    writes.push({ hook, attempt: snapshot.attempt, trace: snapshot.trace.length })
    timeline.push(`write:${hook}:${snapshot.attempt}`)
    saved.set(snapshot.runId, structuredClone(snapshot))
  }
  const persistence: IPersistence = {
    onRunStart: write('onRunStart'),
    onStepComplete: write('onStepComplete'),
    ...(options.resumeHook === false ? {} : { onRunResume: write('onRunResume') }),
    loadRun: (runId) => structuredClone(saved.get(runId) ?? null),
  }
  return { saved, writes, timeline, persistence }
}

test('event order: a fresh run numbers its events 1..n under attempt 1', async () => {
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    const { saved, persistence } = crashStore()
    const agent = await open(config(llm.baseURL, { persistence }))
    const { events, onEvent } = collect()
    await agent.run({ input: 'two things', onEvent })
    assert.ok(events.length > 5)
    assert.deepEqual(seqs(events), oneTo(events.length), 'consecutive, from 1, in arrival order')
    assert.deepEqual(attempts(events), [1])
    assert.equal(new Set(events.map((e) => e.runId)).size, 1, 'one run')
    assert.equal([...saved.values()][0].attempt, 1, 'the snapshot carries the attempt')
  })
})

test('event order: with no persistence nothing breaks - the events are numbered all the same', async () => {
  await withLlm(linearScript(['s1']), async ({ llm, open }) => {
    const agent = await open(config(llm.baseURL))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'one thing', onEvent })
    assert.equal(result.text, 'All done.')
    assert.deepEqual(seqs(events), oneTo(events.length))
    assert.deepEqual(attempts(events), [1])
  })
})

test('event order: a resume continues under attempt 2, recorded before any of its events', async () => {
  await withLlm(linearScript(['s1', 's2', 's3']), async ({ llm, open }) => {
    const { saved, writes, timeline, persistence } = crashStore()
    const controller = new AbortController()
    const dying: IPersistence = {
      ...persistence,
      onStepComplete: async (s) => {
        await persistence.onStepComplete?.(s)
        if (s.trace.length === 1) controller.abort()
      },
    }
    const first = await open(config(llm.baseURL, { persistence: dying }))
    const before = collect()
    await assert.rejects(
      first.run({ input: 'three things', signal: controller.signal, onEvent: before.onEvent }),
    )
    const [runId] = [...saved.keys()]
    assert.equal(saved.get(runId)?.attempt, 1)

    const second = await open(config(llm.baseURL, { persistence }))
    const after = collect()
    const result = await second.run({
      input: '',
      resumeFromRunId: runId,
      onEvent: (e) => {
        timeline.push(`event:${e.attempt}:${e.seq}`)
        after.onEvent(e)
      },
    })
    assert.equal(result.trace.length, 3)
    assert.deepEqual(attempts(before.events), [1])
    assert.deepEqual(attempts(after.events), [2])
    assert.deepEqual(seqs(after.events), oneTo(after.events.length), 'seq starts again at 1')
    // The attempt was on record before the resumed run said anything.
    const resumeWrite = timeline.indexOf('write:onRunResume:2')
    assert.ok(resumeWrite >= 0, timeline.join(' '))
    assert.ok(resumeWrite < timeline.findIndex((t) => t.startsWith('event:')))
    // Every snapshot names the attempt that wrote it.
    assert.deepEqual(
      writes.map((w) => [w.hook, w.attempt]),
      [
        ['onRunStart', 1],
        ['onStepComplete', 1],
        ['onRunResume', 2],
        // After s2 (s3 is the last step: the run goes on to the answer, no checkpoint).
        ['onStepComplete', 2],
      ],
    )
    // (attempt, seq) orders the two attempts' events the way they happened.
    const all = [...before.events, ...after.events]
    const sorted = [...all].sort(
      (a, b) =>
        (a.attempt as number) - (b.attempt as number) || (a.seq as number) - (b.seq as number),
    )
    assert.deepEqual(sorted, all)
  })
})

test('event order: a crash right after a resume started - before its first checkpoint - still gives attempt 3 on the next resume', async () => {
  await withLlm(linearScript(['s1', 's2', 's3']), async ({ llm, open }) => {
    const { saved, persistence } = crashStore()
    const crashAt = (n: number) => {
      const controller = new AbortController()
      const p: IPersistence = {
        ...persistence,
        onStepComplete: async (s) => {
          await persistence.onStepComplete?.(s)
          if (s.trace.length === n) controller.abort()
        },
      }
      return { controller, persistence: p }
    }
    const a = crashAt(1)
    const first = await open(config(llm.baseURL, { persistence: a.persistence }))
    await assert.rejects(first.run({ input: 'three things', signal: a.controller.signal }))
    const [runId] = [...saved.keys()]

    // The second process dies at its very first event: nothing of it is checkpointed but its
    // attempt.
    const dies = new AbortController()
    const second = await open(config(llm.baseURL, { persistence }))
    const secondEvents = collect()
    await assert.rejects(
      second.run({
        input: '',
        resumeFromRunId: runId,
        signal: dies.signal,
        onEvent: (e) => {
          secondEvents.onEvent(e)
          dies.abort()
        },
      }),
    )
    assert.deepEqual(attempts(secondEvents.events), [2])
    assert.equal(saved.get(runId)?.attempt, 2, 'only the resume write is on record')
    assert.equal(saved.get(runId)?.trace.length, 1)

    const third = await open(config(llm.baseURL, { persistence }))
    const thirdEvents = collect()
    const result = await third.run({
      input: '',
      resumeFromRunId: runId,
      onEvent: thirdEvents.onEvent,
    })
    assert.equal(result.trace.length, 3)
    assert.deepEqual(attempts(thirdEvents.events), [3], 'never a second attempt 2')
    assert.deepEqual(seqs(thirdEvents.events), oneTo(thirdEvents.events.length))
    assert.equal(saved.get(runId)?.attempt, 3)
  })
})

test('event order: without onRunResume the resume write goes to onStepComplete, still before any event', async () => {
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    const { saved, timeline, persistence } = crashStore({ resumeHook: false })
    const controller = new AbortController()
    const dying: IPersistence = {
      ...persistence,
      onStepComplete: async (s) => {
        await persistence.onStepComplete?.(s)
        if (s.trace.length === 1 && s.attempt === 1) controller.abort()
      },
    }
    const first = await open(config(llm.baseURL, { persistence: dying }))
    await assert.rejects(first.run({ input: 'two things', signal: controller.signal }))
    const [runId] = [...saved.keys()]
    timeline.length = 0
    const second = await open(config(llm.baseURL, { persistence }))
    await second.run({
      input: '',
      resumeFromRunId: runId,
      onEvent: (e) => timeline.push(`event:${e.attempt}:${e.seq}`),
    })
    assert.equal(timeline[0], 'write:onStepComplete:2', timeline.slice(0, 3).join(' '))
    assert.equal(timeline[1], 'event:2:1')
  })
})

test('event order: a resume whose attempt cannot be recorded is refused before anything runs', async () => {
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    const { saved, persistence } = crashStore()
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
    const requests = llm.requests.length
    const second = await open(
      config(llm.baseURL, {
        persistence: {
          ...persistence,
          onRunResume: () => {
            throw new Error('store is down')
          },
        },
      }),
    )
    const { events, onEvent } = collect()
    await assert.rejects(
      second.run({ input: '', resumeFromRunId: runId, onEvent }),
      /onRunResume threw while recording attempt 2.*store is down/,
    )
    assert.equal(events.length, 0, 'not one event')
    assert.equal(llm.requests.length, requests, 'not one model call')
  })
})

test('event order: a snapshot whose attempt is not a positive integer is not resumed', async () => {
  const snapshot = (attempt: unknown): IRunSnapshot =>
    ({
      runId: 'r1',
      startedAt: 1,
      status: 'executing',
      input: 'x',
      plan: { thought: '', steps: [{ id: 's', description: 'd', expectedOutcome: 'o' }] },
      trace: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      stepIndex: 0,
      iterations: 0,
      revisions: 0,
      attempt,
    }) as IRunSnapshot
  const ctxOf = (s: IRunSnapshot) =>
    ({ config: { persistence: { loadRun: () => s } } }) as unknown as IAgentInternalContext
  for (const bad of [0, -1, 1.5, Number.NaN, '2', null, Infinity]) {
    await assert.rejects(
      resolveResume(ctxOf(snapshot(bad)), { input: '', resumeFromRunId: 'r1' }),
      /invalid attempt/,
      `refuses ${String(bad)}`,
    )
  }
  for (const ok of [undefined, 1, 7]) {
    assert.ok(await resolveResume(ctxOf(snapshot(ok)), { input: '', resumeFromRunId: 'r1' }))
  }
})

test('event order: a subagent envelope is numbered in the parent run; the child event keeps its own numbers', async () => {
  const script = (req: Parameters<Parameters<typeof withLlm>[0]>[0]) => {
    const stage = stageOf(req)
    const child = systemOf(req).includes('CHILD AGENT')
    if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
    if (stage === 'synthesizer') return { text: child ? 'child answer' : 'Parent done.' }
    if (child) return { text: 'child did it' }
    if (hasToolResult(req)) return { text: `parent got ${toolResults(req)[0]}` }
    return { toolCalls: [{ name: 'helper', args: { task: 'Do the sub-task' } }] }
  }
  await withLlm(script, async ({ llm, open }) => {
    const helper = createSubagentTool({
      name: 'helper',
      description: 'Delegate',
      isolation: 'in-process',
      config: config(llm.baseURL, { systemPrompt: 'CHILD AGENT', maxIterations: 2 }),
    })
    const agent = await open(config(llm.baseURL, { tools: { helper } }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'Delegate it', onEvent })
    assert.equal(result.text, 'Parent done.')
    // The parent's stream: one run, numbered without a gap - the envelopes included.
    assert.deepEqual(seqs(events), oneTo(events.length))
    const parentRun = events[0].runId
    assert.ok(parentRun)
    assert.ok(
      events.every((e) => e.runId === parentRun),
      'an envelope carries the PARENT run id, even when it is emitted from inside the child run',
    )
    const envelopes = ofType(events, 'subagent.event')
    assert.ok(envelopes.length > 3)
    const inner = envelopes.map((e) => e.event)
    assert.ok(
      inner.every((e) => e.runId && e.runId !== parentRun),
      'the child run is its own',
    )
    assert.deepEqual(seqs(inner), oneTo(inner.length), "the child's own numbers, from 1")
    assert.deepEqual(attempts(inner), [1])
  })
})

test('event order: a dynamic helper is numbered the same way', async () => {
  const script = (req: Parameters<Parameters<typeof withLlm>[0]>[0]) => {
    const stage = stageOf(req)
    const helper = userOf(req).includes('HELPER TASK')
    if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
    if (stage === 'synthesizer') return { text: helper ? 'helper answer' : 'Parent done.' }
    if (helper) return { text: 'helper did it' }
    if (hasToolResult(req)) return { text: 'parent got it' }
    return { toolCalls: [{ name: 'spawn_subagent', args: { task: 'HELPER TASK: look' } }] }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open(config(llm.baseURL, { subagents: { dynamic: true } }))
    const { events, onEvent } = collect()
    await agent.run({ input: 'Spawn one', onEvent })
    assert.deepEqual(seqs(events), oneTo(events.length))
    const inner = ofType(events, 'subagent.event').map((e) => e.event)
    assert.ok(inner.length > 3)
    assert.deepEqual(seqs(inner), oneTo(inner.length))
    assert.ok(inner.every((e) => e.runId !== events[0].runId))
  })
})

// The host's tools see the run the way they always did: a tool reads its run through the context.
test('event order: tools still emit into their run, numbered', async () => {
  const script = (req: Parameters<Parameters<typeof withLlm>[0]>[0]) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
    if (stage === 'synthesizer') return { text: 'done' }
    if (hasToolResult(req)) return { text: 'ok' }
    return { toolCalls: [{ name: 'note', args: { text: 'hi' } }] }
  }
  await withLlm(script, async ({ llm, open }) => {
    const note = tool({
      description: 'Write a note',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => text,
    })
    const agent = await open(config(llm.baseURL, { tools: { note } }))
    const { events, onEvent } = collect()
    await agent.run({ input: 'note it', onEvent })
    assert.deepEqual(seqs(events), oneTo(events.length))
    assert.ok(ofType(events, 'step.tool-result').length === 1)
  })
})
