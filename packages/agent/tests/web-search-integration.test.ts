import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgent, type AgentEvent, type IAgent, type IAgentConfig } from '../src/index.ts'
import {
  hasToolResult,
  startLocalOpenAI,
  systemOf,
  toolNames,
  toolResults,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from './helpers/openai-server.ts'
import {
  REDIRECT_HOST,
  redirectLink,
  startLocalSearch,
  type ILocalSearch,
} from './helpers/search-server.ts'

// The whole stack: the agent, a model that asks to search, the google provider behind the safe
// fetch and a local server that answers like the Gemini API does to a grounded search. The key
// here is made up.
const KEY = 'zq-test-key-zq-0123456789'

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}

const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'search-test',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 4,
  maxStepsPerTask: 4,
  logLevel: 'none',
  llmMaxRetries: 0,
  ...extra,
})

const withStack = async (
  body: (ctx: {
    llm: ILocalOpenAI
    srv: ILocalSearch
    open: (c?: Partial<IAgentConfig>) => Promise<IAgent>
  }) => Promise<void>,
  // How many searches the scripted model asks for in its one turn.
  searches = 1,
): Promise<void> => {
  const srv = await startLocalSearch({ key: KEY })
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return {
          text: JSON.stringify({
            thought: 'Search.',
            steps: [
              { id: 's1', description: 'Search', expectedOutcome: 'links', suggestedTools: [] },
            ],
          }),
        }
      case 'executor':
        return hasToolResult(req)
          ? { text: 'I searched.' }
          : toolNames(req).includes('web_search')
            ? {
                toolCalls: Array.from({ length: searches }, () => ({
                  name: 'web_search',
                  args: { query: 'install guide' },
                })),
              }
            : { text: 'I have no way to search.' }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }) }
      default:
        return { text: 'Done.' }
    }
  }
  const llm = await startLocalOpenAI(script)
  const agents: IAgent[] = []
  try {
    await body({
      llm,
      srv,
      open: async (extra = {}) => {
        const agent = await createAgent(config(llm.baseURL, extra))
        agents.push(agent)
        return agent
      },
    })
  } finally {
    for (const a of agents) await a.close().catch(() => {})
    await llm.close()
    await srv.close()
  }
}

const executorRequests = (llm: ILocalOpenAI) =>
  llm.requests.filter((r) => stageOf(r) === 'executor')

test('search off (the default): no tool is offered and not a word of the prompts changes', async () => {
  await withStack(async ({ llm, srv, open }) => {
    const agent = await open()
    const result = await agent.run({ input: 'find the guide' })
    assert.ok(llm.requests.every((r) => !toolNames(r).includes('web_search')))
    assert.ok(llm.requests.every((r) => !JSON.stringify(r).includes('web_search')))
    assert.equal(result.trace[0].toolCalls.length, 0)
    assert.equal(srv.hits.length, 0)
  })
})

const google = (srv: ILocalSearch, extra: Record<string, unknown> = {}) => ({
  provider: 'google' as const,
  apiKey: KEY,
  baseURL: srv.url,
  allowPrivateNetwork: true,
  ...extra,
})

test('search on: the model searches, gets the short list, the key reaches the API and nothing else, and the tokens are in the usage', async () => {
  await withStack(async ({ llm, srv, open }) => {
    const snapshots: unknown[] = []
    const agent = await open({
      search: google(srv),
      egress: { allow: [REDIRECT_HOST] },
      persistence: {
        onStepComplete: (snapshot) => void snapshots.push(structuredClone(snapshot)),
        onRunComplete: (snapshot) => void snapshots.push(structuredClone(snapshot)),
      },
    })
    const events: AgentEvent[] = []
    const result = await agent.run({ input: 'find the guide', onEvent: (e) => events.push(e) })
    const offered = toolNames(executorRequests(llm)[0])
    assert.ok(offered.includes('web_search') && offered.includes('web_fetch'))

    const call = result.trace[0].toolCalls[0]
    assert.equal(call.name, 'web_search')
    assert.equal(call.ok, true)
    const output = call.output as { results: { title: string; url: string }[]; note: string }
    assert.deepEqual(output.results[0], {
      title: 'docs.example.com',
      url: redirectLink(1),
      snippet: 'Run the installer, then restart.',
    })
    assert.equal(output.results.length, 3)
    assert.match(output.note, /redirect link/)
    assert.equal(srv.hits.length, 1)
    assert.equal(srv.hits[0].headers['x-goog-api-key'], KEY)
    // The grounding call carries the query and nothing of the conversation.
    const sent = JSON.stringify(srv.hits[0].body)
    assert.ok(sent.includes('install guide'))
    assert.ok(!sent.includes('find the guide'), "the user's request did not go to the search")
    // The model saw the result, flagged as untrusted.
    const seen = toolResults(executorRequests(llm)[1]).join('\n')
    assert.match(seen, /grounding-api-redirect/)
    assert.match(seen, /"untrusted":true/)

    const e = events.find((x) => x.type === 'egress.request')
    assert.ok(e?.type === 'egress.request' && e.allowed)
    assert.equal(e.url, `${srv.url}/v1beta/models/gemini-2.5-flash-lite:generateContent`)
    // The grounding call's tokens (43 in, 92 out) are an event of their own and part of the totals.
    const spent = events.filter((x) => x.type === 'usage' && x.phase === 'search')
    assert.equal(spent.length, 1)
    const stages = events
      .filter((x) => x.type === 'usage' && x.phase !== 'search')
      .reduce((n, x) => n + (x.type === 'usage' ? x.usage.totalTokens : 0), 0)
    assert.equal(result.usage.totalTokens, stages + 135)
    assert.equal(agent.usage.totalTokens, result.usage.totalTokens)
    // The key is in one place: the header of the request to the search API.
    assert.ok(
      JSON.stringify(snapshots).includes('grounding-api-redirect'),
      'a snapshot holds the result',
    )
    for (const text of [
      JSON.stringify(events),
      JSON.stringify(result),
      JSON.stringify(llm.requests),
      JSON.stringify(snapshots),
    ]) {
      assert.ok(!text.includes(KEY), 'the key leaked')
    }
  })
})

test('search and the budgets: its tokens count against the token limit', async () => {
  await withStack(async ({ srv, open }) => {
    // The scripted stages spend 15 tokens a call: under the limit on their own, as the same run
    // with an engine of the host shows. The grounding call's 135 tokens put the run over it.
    const limits = { maxTotalTokens: 120 }
    const run = async (search: IAgentConfig['search']) => {
      const events: AgentEvent[] = []
      const agent = await open({ search, limits })
      const result = await agent.run({ input: 'find the guide', onEvent: (e) => events.push(e) })
      return { result, exceeded: events.some((e) => e.type === 'budget.exceeded') }
    }
    const own = await run({ engine: async () => [] })
    assert.equal(own.exceeded, false)
    assert.ok(own.result.usage.totalTokens < 120)
    const grounded = await run(google(srv))
    assert.equal(grounded.exceeded, true, 'the limit saw the tokens of the search')
    assert.ok(grounded.result.usage.totalTokens >= 135)
  })
})

test('search and the budgets: a search is a tool call - past maxToolCalls it never reaches the API', async () => {
  await withStack(async ({ srv, open }) => {
    const agent = await open({ search: google(srv), maxToolCalls: 1 })
    const result = await agent.run({ input: 'find the guide' })
    const calls = result.trace[0].toolCalls
    // Two calls in one turn: one runs, the other is refused (which of the two is not fixed).
    assert.deepEqual(calls.map((c) => c.ok).sort(), [false, true])
    assert.match(JSON.stringify(calls.find((c) => !c.ok)), /tool-call budget exhausted/)
    assert.equal(srv.hits.length, 1)
  }, 2)
})

test('search without egress: the tool works alone, web_fetch is not mounted, and the search host is not a way in', async () => {
  await withStack(async ({ llm, srv, open }) => {
    const agent = await open({ search: google(srv) })
    const result = await agent.run({ input: 'find the guide' })
    const offered = toolNames(executorRequests(llm)[0])
    assert.ok(offered.includes('web_search'))
    assert.ok(!offered.includes('web_fetch'))
    const out = result.trace[0].toolCalls[0].output as { results: unknown[] }
    assert.equal(out.results.length, 3)
  })
})

test('search with an engine of the host: the same tool, no request of ours, no search usage', async () => {
  await withStack(async ({ srv, open }) => {
    const agent = await open({
      search: {
        engine: async (query) => [
          { title: 'Guide', url: 'https://docs.example.com/install', snippet: `about ${query}` },
          { title: 'Elsewhere', url: 'https://evil.example.net/', snippet: 'bait' },
        ],
      },
      egress: { allow: ['docs.example.com'] },
    })
    const events: AgentEvent[] = []
    const result = await agent.run({ input: 'find the guide', onEvent: (e) => events.push(e) })
    assert.deepEqual(result.trace[0].toolCalls[0].output, {
      query: 'install guide',
      results: [
        {
          title: 'Guide',
          url: 'https://docs.example.com/install',
          snippet: 'about install guide',
        },
      ],
      filtered: 1,
      untrusted: true,
    })
    assert.equal(srv.hits.length, 0)
    assert.ok(!events.some((e) => e.type === 'usage' && e.phase === 'search'))
  })
})

test('search under read-only approval: it runs; with readOnly: false it is refused before any request', async () => {
  await withStack(async ({ srv, open }) => {
    const search = google(srv)
    const allowed = await open({ search, toolApproval: { mode: 'read-only' } })
    const ok = await allowed.run({ input: 'find the guide' })
    assert.equal(ok.trace[0].toolCalls[0].ok, true)
    const hitsBefore = srv.hits.length

    const strict = await open({
      search: { ...search, readOnly: false },
      toolApproval: { mode: 'read-only' },
    })
    const denied = await strict.run({ input: 'find the guide' })
    assert.equal(denied.trace[0].toolCalls[0].ok, false)
    assert.equal(srv.hits.length, hitsBefore, 'a denied search never reached the API')
  })
})
