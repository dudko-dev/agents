import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgent,
  outputCapNotice,
  resolveBudgets,
  resolveConfig,
  stageOutputCap,
  type BrowserAgentConfig,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// The per-call output caps are what the model is told, so they are checked on the wire: what
// each stage's call carried as `maxOutputTokens`, not what the config object says.

const route = (info: CallInfo): Reply => {
  switch (stageOf(info)) {
    case 'planner':
      return { text: JSON.stringify({ thought: 'ok', steps: [{ description: 'Say hi' }] }) }
    case 'executor':
      return { text: 'Hi.' }
    default:
      return { text: 'Done.' }
  }
}

// The same run for a prompted-mode model: the plan and the step come as salvageable JSON.
const promptedRoute = (info: CallInfo): Reply => {
  switch (stageOf(info)) {
    case 'planner':
      return { text: JSON.stringify({ reply: 'ok', plan: ['Say hi'] }) }
    case 'executor':
      return { text: JSON.stringify({ reply: 'Hi.', actions: [] }) }
    default:
      return { text: 'Done.' }
  }
}

const capsOf = async (
  extra: Partial<BrowserAgentConfig> = {},
): Promise<Record<string, unknown>> => {
  const m = scriptedModel(extra.toolMode === 'prompted' ? promptedRoute : route)
  const agent = await createAgent({ model: m.model, ...extra })
  await agent.run('hello')
  const caps: Record<string, unknown> = {}
  for (const c of m.calls) caps[stageOf(c)] ??= c.options.maxOutputTokens
  return caps
}

test('defaults: the final answer gets room (3000); the other stages keep their caps', () => {
  assert.deepEqual(resolveConfig({ model: undefined } as never).budgets, {
    planner: 800,
    executor: 1200,
    replanner: 400,
    synthesizer: 3000,
    compaction: 1024,
  })
})

test('the synthesizer call is sent with the default cap - not a few hundred tokens', async () => {
  const caps = await capsOf()
  assert.equal(caps.synthesizer, 3000)
  assert.equal(caps.planner, 800)
  assert.equal(caps.executor, 1200)
})

test('limits.perCall wins over the legacy budgets, and both over the default', async () => {
  assert.equal((await capsOf({ budgets: { synthesizer: 700 } })).synthesizer, 700)
  assert.equal(
    (await capsOf({ budgets: { synthesizer: 700 }, limits: { perCall: { synthesizer: 5000 } } }))
      .synthesizer,
    5000,
  )
  // Other stages are not touched by raising one.
  const caps = await capsOf({ limits: { perCall: { synthesizer: 5000 } } })
  assert.equal(caps.executor, 1200)
})

// ── the same rules as the Node sibling's stageOutputCap ───────────────────────

const cfg = (extra: Partial<BrowserAgentConfig> = {}): BrowserAgentConfig =>
  ({ model: undefined, ...extra }) as never

test('stageOutputCap: a share of the window by default, marked as derived', () => {
  assert.deepEqual(stageOutputCap(cfg(), 'executor', 128_000), { tokens: 1200, derived: true })
  assert.deepEqual(stageOutputCap(cfg(), 'executor', 4_096), { tokens: 384, derived: true })
  assert.deepEqual(stageOutputCap(cfg(), 'executor', 2_000_000), { tokens: 8192, derived: true })
})

test('stageOutputCap: what the host set wins, and 0 means no cap', () => {
  const set = cfg({ limits: { perCall: { executor: 9000 } }, budgets: { executor: 700 } })
  assert.deepEqual(stageOutputCap(set, 'executor', 128_000), { tokens: 9000, derived: false })
  const legacy = cfg({ budgets: { executor: 700 } })
  assert.deepEqual(stageOutputCap(legacy, 'executor', 128_000), { tokens: 700, derived: false })
  const off = cfg({ limits: { perCall: { executor: 0 } } })
  assert.deepEqual(stageOutputCap(off, 'executor', 128_000), { derived: false })
  assert.equal(resolveBudgets(off, 128_000).executor, 0, 'resolved as 0 = none')
  assert.equal(resolveBudgets(off, 128_000).planner, 800, 'the rest keep their share')
})

test('stageOutputCap: a stage that thinks gets no default cap; an explicit one still applies', () => {
  for (const thinking of [true, 'low', { level: 'high', budgetTokens: 4000 }] as const) {
    assert.deepEqual(
      stageOutputCap(cfg({ thinking }), 'executor', 128_000),
      { derived: false },
      JSON.stringify(thinking),
    )
  }
  // Thinking turned off is not thinking.
  assert.equal(stageOutputCap(cfg({ thinking: 'none' }), 'executor', 128_000).tokens, 1200)
  assert.equal(stageOutputCap(cfg({ thinking: false }), 'executor', 128_000).tokens, 1200)
  // Per stage: only the stage that thinks loses its default.
  const one = cfg({ stageThinking: { executor: 'low' } })
  assert.deepEqual(stageOutputCap(one, 'executor', 128_000), { derived: false })
  assert.equal(stageOutputCap(one, 'synthesizer', 128_000).tokens, 3000)
  const offForOne = cfg({ thinking: 'low', stageThinking: { executor: false } })
  assert.equal(stageOutputCap(offForOne, 'executor', 128_000).tokens, 1200)
  assert.deepEqual(stageOutputCap(offForOne, 'planner', 128_000), { derived: false })
  const capped = cfg({ thinking: 'low', limits: { perCall: { executor: 12_000 } } })
  assert.deepEqual(stageOutputCap(capped, 'executor', 128_000), { tokens: 12_000, derived: false })
})

test('wire: perCall 0 sends no cap at all (not maxOutputTokens: 0)', async () => {
  const caps = await capsOf({ limits: { perCall: { executor: 0 } } })
  // The SDK refuses `maxOutputTokens: 0` outright: the step must really have reached the model.
  assert.ok('executor' in caps, 'the executor call was made')
  assert.equal(caps.executor, undefined)
  assert.equal(caps.planner, 800)
  assert.equal(caps.synthesizer, 3000)
})

test('wire: an executor that thinks sends no derived cap; the other stages keep theirs', async () => {
  const caps = await capsOf({ stageThinking: { executor: 'low' } })
  assert.equal(caps.executor, undefined)
  assert.equal(caps.planner, 800)
  assert.equal(caps.synthesizer, 3000)
  const explicit = await capsOf({
    stageThinking: { executor: 'low' },
    limits: { perCall: { executor: 6000 } },
  })
  assert.equal(explicit.executor, 6000)
})

test('wire: the prompted executor follows the same cap rules', async () => {
  const prompted = (extra: Partial<BrowserAgentConfig>) =>
    capsOf({ toolMode: 'prompted', ...extra })
  assert.equal((await prompted({})).executor, 1200)
  const off = await prompted({ limits: { perCall: { executor: 0 } } })
  assert.ok('executor' in off, 'the executor call was made')
  assert.equal(off.executor, undefined)
  assert.equal((await prompted({ thinking: 'low' })).executor, undefined)
})

test('outputCapNotice speaks only for a call cut off at a cap in force', () => {
  assert.equal(outputCapNotice(cfg(), 'executor', 128_000, 'stop'), undefined)
  assert.equal(outputCapNotice(cfg(), 'executor', 128_000, undefined), undefined)
  // No cap in force: the provider's own limit cut it, nothing of ours to name.
  assert.equal(outputCapNotice(cfg({ thinking: 'low' }), 'executor', 128_000, 'length'), undefined)
  assert.equal(
    outputCapNotice(cfg({ limits: { perCall: { executor: 0 } } }), 'executor', 128_000, 'length'),
    undefined,
  )
  const derived = outputCapNotice(cfg(), 'executor', 128_000, 'length') ?? ''
  assert.match(derived, /^\[executor\] .*cut off at 1200 tokens, the default cap/)
  assert.match(derived, /128000-token window/)
  assert.match(derived, /limits\.perCall\.executor/)
  const set = cfg({ limits: { perCall: { executor: 900 } } })
  assert.match(
    outputCapNotice(set, 'executor', 128_000, 'length') ?? '',
    /cut off at limits\.perCall\.executor \(900 tokens\)/,
  )
})

// ── a call the cap cut off says so ────────────────────────────────────────────

const warnings = async (
  reply: (info: CallInfo) => Reply,
  extra: Partial<BrowserAgentConfig> = {},
): Promise<string[]> => {
  const warned: string[] = []
  const m = scriptedModel(reply)
  const agent = await createAgent({
    model: m.model,
    logger: {
      error: () => {},
      warn: (...args: unknown[]) => void warned.push(args.map(String).join(' ')),
      info: () => {},
      debug: () => {},
    },
    ...extra,
  })
  await agent.run('hello')
  return warned.filter((w) => /cut off/.test(w))
}

const cutAt =
  (stage: string, text: string) =>
  (info: CallInfo): Reply =>
    stageOf(info) === stage ? { text, cutOff: true } : route(info)

test('an executor step cut off by its cap says so, naming the cap and how to lift it', async () => {
  const cut = await warnings(cutAt('executor', 'half a sent'))
  assert.equal(cut.length, 1)
  assert.match(
    cut[0],
    /\[executor\] the model's output was cut off at 1200 tokens, the default cap/,
  )
  assert.match(cut[0], /raise limits\.perCall\.executor, or set it to 0 for no cap/)
})

test('a prompted executor step cut off by its cap says so too', async () => {
  const cut = await warnings(
    (info) =>
      stageOf(info) === 'executor'
        ? { text: '{"reply":"half a sent', cutOff: true }
        : promptedRoute(info),
    { toolMode: 'prompted' },
  )
  assert.equal(cut.length, 1)
  assert.match(cut[0], /\[executor\] .*cut off at 1200 tokens/)
})

test('a cap the host set is named as theirs', async () => {
  const cut = await warnings(cutAt('executor', 'half'), { limits: { perCall: { executor: 50 } } })
  assert.equal(cut.length, 1)
  assert.match(cut[0], /cut off at limits\.perCall\.executor \(50 tokens\); raise it/)
})

test('a synthesis cut off by its cap says so', async () => {
  const cut = await warnings(cutAt('synthesizer', 'A long answer that'))
  assert.equal(cut.length, 1)
  assert.match(cut[0], /\[synthesizer\] .*cut off at 3000 tokens/)
})

test('no notice when nothing was cut off, or when no cap of ours was in force', async () => {
  assert.deepEqual(await warnings(route), [])
  assert.deepEqual(
    await warnings(cutAt('executor', 'half'), { limits: { perCall: { executor: 0 } } }),
    [],
  )
})

test('a plan cut off by its cap is reported with a message that names the cap', async () => {
  const m = scriptedModel((info) => {
    if (stageOf(info) !== 'planner') return route(info)
    // The structured attempt is cut; the prompted fallback then answers.
    return info.options.responseFormat &&
      (info.options.responseFormat as { type: string }).type === 'json'
      ? { text: '{"thought":"ok","steps":[{"descr', cutOff: true }
      : { text: JSON.stringify({ reply: 'ok', plan: ['Say hi'] }) }
  })
  const agent = await createAgent({ model: m.model, logLevel: 'silent' })
  const retries: string[] = []
  await agent.run('hello', {
    onEvent: (e) => {
      if (e.type === 'retry') retries.push(e.error)
    },
  })
  assert.equal(retries.length, 1)
  assert.match(retries[0], /\[planner\] .*cut off at 800 tokens/)
})
