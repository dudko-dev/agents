import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APP_SAMPLING_MAX_IMAGES,
  APP_SAMPLING_MAX_INPUT_CHARS,
  APP_SAMPLING_MAX_MESSAGES,
  APP_SAMPLING_MAX_SYSTEM_CHARS,
  APP_SAMPLING_MAX_TOKENS,
  APP_SAMPLING_PER_APP,
  APP_SAMPLING_PER_MINUTE,
  AppSamplingError,
  appSamplingRequestOf,
  createAgent,
  createAppSamplingLimiter,
  MemoryStore,
  resolveAppSampling,
  type AgentEvent,
  type AppSamplingView,
  type BrowserAgentConfig,
} from '../dist/index.js'
import { scriptedModel, type CallInfo } from './helpers/scripted-model.ts'

// MCP Apps asking the HOST's model for a completion (`sampling/createMessage` from the view,
// `Agent.sampleForApp`): what of a request is accepted (pure, `src/app-sampling.ts`), the rate
// limit, and the agent's seam - consent first, the synthesizer's model, no tools, the tokens
// charged under phase 'app', and the answer going to the caller ONLY. A consent boundary: every
// guard has a test here and needs a mutation check (docs/security.md, "An app asks the model").

const LIMITS = { maxTokens: APP_SAMPLING_MAX_TOKENS, maxInputChars: 16_000, images: false }
const text = (t: string) => ({ role: 'user', content: { type: 'text', text: t } })
const params = (extra: Record<string, unknown> = {}) => ({
  messages: [text('Suggest a dinner place in Lisbon.')],
  maxTokens: 200,
  ...extra,
})
const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (err) {
    return err instanceof AppSamplingError ? err.code : `other: ${String(err)}`
  }
  return undefined
}

// ── the request, pure ───────────────────────────────────────────────────────

test('guard request: messages of text, a system prompt, maxTokens lowered to the cap', () => {
  const view = appSamplingRequestOf(
    params({
      messages: [
        text('Hello'),
        { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'One' },
            { type: 'text', text: 'Two' },
          ],
        },
      ],
      systemPrompt: 'You suggest restaurants.',
      maxTokens: 50_000,
      temperature: 0.4,
      // Ignored: the host picks the model, adds no context, takes no stop sequences.
      modelPreferences: { hints: [{ name: 'claude' }] },
      includeContext: 'allServers',
      stopSequences: ['x'],
      metadata: { a: 1 },
    }),
    LIMITS,
  )
  assert.deepEqual(view, {
    messages: [
      { role: 'user', text: 'Hello', images: [] },
      { role: 'assistant', text: 'Hi.', images: [] },
      { role: 'user', text: 'One\n\nTwo', images: [] },
    ],
    systemPrompt: 'You suggest restaurants.',
    maxTokens: APP_SAMPLING_MAX_TOKENS,
    requestedMaxTokens: 50_000,
    temperature: 0.4,
  })
  assert.equal(appSamplingRequestOf(params({ maxTokens: 7 }), LIMITS).maxTokens, 7)
})

test('guard request: what the user is shown is what the model reads - nothing invisible', () => {
  const view = appSamplingRequestOf(
    params({
      messages: [text('Lis‮bon​\u0007 ok')],
      systemPrompt: '⁦Be kind⁩',
    }),
    LIMITS,
  )
  assert.equal(view.messages[0].text, 'Lisbon ok')
  assert.equal(view.systemPrompt, 'Be kind')
})

test('guard request: tools are not offered - tools, toolChoice, tool blocks are refused', () => {
  assert.equal(
    code(() => appSamplingRequestOf(params({ tools: [{ name: 'x' }] }), LIMITS)),
    'unsupported',
  )
  assert.equal(
    code(() => appSamplingRequestOf(params({ toolChoice: { mode: 'auto' } }), LIMITS)),
    'unsupported',
  )
  // An empty list asks for nothing.
  assert.equal(
    code(() => appSamplingRequestOf(params({ tools: [] }), LIMITS)),
    undefined,
  )
  for (const block of [
    { type: 'tool_use', id: '1', name: 'x', input: {} },
    { type: 'tool_result', toolUseId: '1', content: [] },
    { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
  ]) {
    assert.equal(
      code(() =>
        appSamplingRequestOf(params({ messages: [{ role: 'user', content: block }] }), LIMITS),
      ),
      'unsupported',
      block.type,
    )
  }
})

test('guard request: the shape - messages, roles, blocks, maxTokens, temperature, system prompt', () => {
  const bad: unknown[] = [
    undefined,
    'x',
    [],
    { maxTokens: 10 },
    { messages: [], maxTokens: 10 },
    {
      messages: Array.from({ length: APP_SAMPLING_MAX_MESSAGES + 1 }, () => text('a')),
      maxTokens: 10,
    },
    params({ maxTokens: undefined }),
    params({ maxTokens: 0 }),
    params({ maxTokens: 1.5 }),
    params({ maxTokens: '100' }),
    params({ temperature: 3 }),
    params({ temperature: 'hot' }),
    params({ systemPrompt: 42 }),
    params({ systemPrompt: 'x'.repeat(APP_SAMPLING_MAX_SYSTEM_CHARS + 1) }),
    params({ messages: [{ role: 'system', content: { type: 'text', text: 'x' } }] }),
    params({ messages: [{ role: 'user', content: { type: 'html', text: 'x' } }] }),
    params({ messages: [{ role: 'user', content: { type: 'text', text: 42 } }] }),
    params({ messages: [{ role: 'user', content: [] }] }),
    params({
      messages: [
        { role: 'user', content: Array.from({ length: 11 }, () => ({ type: 'text', text: 'a' })) },
      ],
    }),
    params({ messages: [text('​  ')] }),
  ]
  for (const [i, p] of bad.entries()) {
    assert.equal(
      code(() => appSamplingRequestOf(p, LIMITS)),
      'invalid',
      `case ${i}`,
    )
  }
})

test('guard request: the text is capped (messages and system prompt together)', () => {
  const half = 'x'.repeat(APP_SAMPLING_MAX_INPUT_CHARS / 2)
  assert.equal(
    code(() => appSamplingRequestOf(params({ messages: [text(half), text(half)] }), LIMITS)),
    undefined,
  )
  assert.equal(
    code(() =>
      appSamplingRequestOf(
        params({ messages: [text(half), text(half)], systemPrompt: 'y' }),
        LIMITS,
      ),
    ),
    'invalid',
  )
  assert.equal(
    code(() =>
      appSamplingRequestOf(params({ messages: [text('abcdef')] }), { ...LIMITS, maxInputChars: 5 }),
    ),
    'invalid',
  )
})

test('guard request: an image only for a model that reads it, in a user message, raster, capped', () => {
  const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
  const withImage = params({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is it?' }, image] }],
  })
  assert.equal(
    code(() => appSamplingRequestOf(withImage, LIMITS)),
    'unsupported',
  )
  const on = { ...LIMITS, images: true }
  const view = appSamplingRequestOf(withImage, on)
  assert.deepEqual(view.messages[0].images, [
    { mimeType: 'image/png', data: 'iVBORw0KGgo=', bytes: 8 },
  ])
  for (const [bad, expected] of [
    [{ ...image, mimeType: 'image/svg+xml' }, 'unsupported'],
    [{ ...image, data: 'not base64!' }, 'invalid'],
    [{ ...image, data: 'A'.repeat(6 * 1024 * 1024) }, 'invalid'],
  ] as const) {
    assert.equal(
      code(() => appSamplingRequestOf(params({ messages: [{ role: 'user', content: bad }] }), on)),
      expected,
    )
  }
  assert.equal(
    code(() =>
      appSamplingRequestOf(params({ messages: [{ role: 'assistant', content: image }] }), on),
    ),
    'unsupported',
  )
  const many = params({
    messages: [
      { role: 'user', content: Array.from({ length: APP_SAMPLING_MAX_IMAGES + 1 }, () => image) },
    ],
  })
  assert.equal(
    code(() => appSamplingRequestOf(many, on)),
    'invalid',
  )
})

test('guard limiter: per app, per minute and in all; a refused request is not counted', () => {
  const limiter = createAppSamplingLimiter(2, 3)
  assert.equal(limiter.take('a', 0), undefined)
  assert.equal(limiter.take('a', 1000), undefined)
  assert.equal(limiter.take('a', 2000), 'minute')
  assert.equal(limiter.take('b', 2000), undefined, 'another app has its own count')
  assert.equal(limiter.take('a', 60_001), undefined, 'the first left the window')
  assert.equal(limiter.take('a', 200_000), 'total')
  assert.deepEqual(resolveAppSampling(undefined), {
    enabled: true,
    maxTokens: APP_SAMPLING_MAX_TOKENS,
    maxRequestsPerMinute: APP_SAMPLING_PER_MINUTE,
    maxRequests: APP_SAMPLING_PER_APP,
    maxInputChars: APP_SAMPLING_MAX_INPUT_CHARS,
  })
  assert.equal(resolveAppSampling(false).enabled, false)
  assert.throws(() => resolveAppSampling({ maxTokens: 0 }), /maxTokens/)
  assert.throws(() => resolveAppSampling({ maxRequests: 1.5 }), /maxRequests/)
})

// ── the agent's seam ────────────────────────────────────────────────────────

const APP = { server: 'demo', resourceUri: 'ui://demo/trip-board.html' }

const rig = async (config: Partial<BrowserAgentConfig> = {}) => {
  const main = scriptedModel(() => ({ text: 'main model', usage: { input: 3, output: 2 } }))
  const synth = scriptedModel((info: CallInfo) => ({
    text: `Try Taberna da Rua: ${info.user.slice(0, 20)}`,
    usage: { input: 40, output: 12 },
  }))
  const memory = new MemoryStore()
  const agent = await createAgent({
    model: main.model,
    synthesizer: synth.model,
    toolMode: 'native',
    memory,
    ...config,
  } as BrowserAgentConfig)
  return { agent, main, synth, memory }
}

test('agent: consent first - shown exactly what the model gets; no means nothing is sent', async () => {
  const { agent, synth } = await rig()
  const seen: AppSamplingView[] = []
  await assert.rejects(
    agent.sampleForApp(
      { ...APP, params: params({ systemPrompt: 'Be brief.' }) },
      {
        approve: (view) => {
          seen.push(view)
          return false
        },
      },
    ),
    (err: unknown) =>
      err instanceof AppSamplingError && err.code === 'denied' && err.rpcCode === -1,
  )
  assert.deepEqual(seen, [
    {
      ...APP,
      messages: [{ role: 'user', text: 'Suggest a dinner place in Lisbon.', images: [] }],
      systemPrompt: 'Be brief.',
      maxTokens: 200,
      requestedMaxTokens: 200,
    },
  ])
  assert.equal(synth.calls.length, 0, 'nothing reached the model')
  // A consent callback that throws, or a request given up on, is a no.
  await assert.rejects(
    agent.sampleForApp(
      { ...APP, params: params() },
      {
        approve: () => {
          throw new Error('x')
        },
      },
    ),
    /rejected/,
  )
  const gone = new AbortController()
  gone.abort()
  await assert.rejects(
    agent.sampleForApp({ ...APP, params: params() }, { approve: () => true, signal: gone.signal }),
    /rejected/,
  )
  // Not even asked: a request that breaks the rules.
  let asked = 0
  await assert.rejects(
    agent.sampleForApp(
      { ...APP, params: params({ tools: [{ name: 'x' }] }) },
      { approve: () => ((asked += 1), true) },
    ),
    (err: unknown) => err instanceof AppSamplingError && err.code === 'unsupported',
  )
  assert.equal(asked, 0)
  assert.equal(synth.calls.length, 0)
})

test('agent: allowed - the synthesizer model, no tools, the cap; the answer only to the caller', async () => {
  const { agent, main, synth, memory } = await rig({ sessionId: 's-1' })
  const events: AgentEvent[] = []
  const answer = await agent.sampleForApp(
    { ...APP, params: params({ systemPrompt: 'You suggest restaurants.', maxTokens: 5000 }) },
    { approve: () => true, onEvent: (e) => events.push(e) },
  )
  assert.deepEqual(answer, {
    role: 'assistant',
    content: { type: 'text', text: 'Try Taberna da Rua: Suggest a dinner pla' },
    model: 'scripted-1',
    stopReason: 'endTurn',
  })
  assert.equal(main.calls.length, 0, 'the executor model is not used')
  assert.equal(synth.calls.length, 1)
  const call = synth.calls[0]
  assert.equal(call.system, 'You suggest restaurants.')
  assert.equal(call.user, 'Suggest a dinner place in Lisbon.')
  assert.deepEqual(call.tools, [], 'no tools')
  assert.equal(call.options.maxOutputTokens, APP_SAMPLING_MAX_TOKENS)
  // Charged under 'app': the agent's usage and the session's - and the one event is that.
  assert.deepEqual(
    events.map((e) => e.type === 'usage' && [e.phase, e.usage.inputTokens, e.usage.outputTokens]),
    [['app', 40, 12]],
  )
  assert.equal(agent.usage.totalTokens, 52)
  assert.equal(agent.sessionUsage('s-1').totalTokens, 52)
  // The answer is in no memory and no event.
  assert.deepEqual(await memory.load('s-1'), [])
  assert.ok(!JSON.stringify(events).includes('Taberna'))
})

test('agent: rate limited per app before the user is asked; another app is not', async () => {
  const { agent, synth } = await rig({ appSampling: { maxRequestsPerMinute: 2 } })
  let asked = 0
  const ask = { approve: () => ((asked += 1), true) }
  await agent.sampleForApp({ ...APP, params: params() }, ask)
  await agent.sampleForApp({ ...APP, params: params() }, ask)
  await assert.rejects(
    agent.sampleForApp({ ...APP, params: params() }, ask),
    (err: unknown) =>
      err instanceof AppSamplingError && err.code === 'rate-limited' && err.rpcCode === -32000,
  )
  assert.equal(asked, 2, 'the third was never put to the user')
  await agent.sampleForApp({ ...APP, resourceUri: 'ui://demo/other.html', params: params() }, ask)
  assert.equal(synth.calls.length, 3)
})

test('agent: appSampling false refuses everything; images only where the model reads them', async () => {
  const off = await rig({ appSampling: false })
  await assert.rejects(
    off.agent.sampleForApp({ ...APP, params: params() }, { approve: () => true }),
    (err: unknown) => err instanceof AppSamplingError && err.code === 'disabled',
  )
  assert.equal(off.synth.calls.length, 0)
  const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
  const withImage = params({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Look' }, image] }],
  })
  // A model nobody knows reads images: refused.
  const unknown = await rig()
  await assert.rejects(
    unknown.agent.sampleForApp({ ...APP, params: withImage }, { approve: () => true }),
    (err: unknown) => err instanceof AppSamplingError && err.code === 'unsupported',
  )
  // One model for every stage that the host says reads images: sent as a file part.
  const model = scriptedModel(() => ({ text: 'A cat.' }))
  const vision = await createAgent({ model: model.model, toolMode: 'native', vision: true })
  const answer = await vision.sampleForApp({ ...APP, params: withImage }, { approve: () => true })
  assert.equal(answer.content.text, 'A cat.')
  const prompt = model.calls[0].options.prompt as {
    role: string
    content: { type: string; mediaType?: string }[]
  }[]
  assert.deepEqual(
    prompt.at(-1)?.content.map((p) => [p.type, p.mediaType]),
    [
      ['text', undefined],
      ['file', 'image/png'],
    ],
  )
})

test('agent: a model that was cut off by the cap says maxTokens', async () => {
  const cut = scriptedModel(() => ({ text: 'Long…', cutOff: true }))
  const agent = await createAgent({ model: cut.model, toolMode: 'native' })
  const answer = await agent.sampleForApp({ ...APP, params: params() }, { approve: () => true })
  assert.equal(answer.stopReason, 'maxTokens')
})
