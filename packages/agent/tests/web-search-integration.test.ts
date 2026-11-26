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
import { startLocalSearch, type ILocalSearch } from './helpers/search-server.ts'

// The whole stack: the agent, a model that asks to search, the search adapter behind the safe
// fetch and a local server that answers like the search API. The key here is made up.
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
            ? { toolCalls: [{ name: 'web_search', args: { query: 'install guide' } }] }
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

test('search on: the model searches, gets the short list, and the key reaches the API and nothing else', async () => {
  await withStack(async ({ llm, srv, open }) => {
    const agent = await open({
      search: {
        provider: 'brave',
        apiKey: KEY,
        baseURL: `${srv.url}/brave`,
        allowPrivateNetwork: true,
      },
      egress: { allow: ['docs.example.com'] },
    })
    const events: AgentEvent[] = []
    const result = await agent.run({ input: 'find the guide', onEvent: (e) => events.push(e) })
    const offered = toolNames(executorRequests(llm)[0])
    assert.ok(offered.includes('web_search') && offered.includes('web_fetch'))

    const call = result.trace[0].toolCalls[0]
    assert.equal(call.name, 'web_search')
    assert.equal(call.ok, true)
    assert.deepEqual(call.output, {
      query: 'install guide',
      results: [
        {
          title: 'Install guide',
          url: 'https://docs.example.com/install',
          snippet: 'Run the installer, then restart.',
          date: '2026-03-01T10:00:00',
        },
      ],
      filtered: 2,
      untrusted: true,
    })
    assert.equal(srv.hits.length, 1)
    assert.equal(srv.hits[0].headers['x-subscription-token'], KEY)
    // The model saw the result, flagged as untrusted.
    const seen = toolResults(executorRequests(llm)[1]).join('\n')
    assert.match(seen, /docs\.example\.com\/install/)
    assert.match(seen, /"untrusted":true/)

    const e = events.find((x) => x.type === 'egress.request')
    assert.ok(e?.type === 'egress.request' && e.allowed)
    assert.equal(e.url, `${srv.url}/brave/res/v1/web/search`)
    // The key is in one place: the header of the request to the search API.
    for (const text of [
      JSON.stringify(events),
      JSON.stringify(result),
      JSON.stringify(llm.requests),
    ]) {
      assert.ok(!text.includes(KEY), 'the key leaked')
    }
  })
})

test('search without egress: the tool works alone, web_fetch is not mounted, and the search host is not a way in', async () => {
  await withStack(async ({ llm, srv, open }) => {
    const agent = await open({
      search: { provider: 'searxng', baseURL: `${srv.url}/searxng`, allowPrivateNetwork: true },
    })
    const result = await agent.run({ input: 'find the guide' })
    const offered = toolNames(executorRequests(llm)[0])
    assert.ok(offered.includes('web_search'))
    assert.ok(!offered.includes('web_fetch'))
    const out = result.trace[0].toolCalls[0].output as { results: unknown[] }
    assert.equal(out.results.length, 3)
  })
})

test('search under read-only approval: it runs; with readOnly: false it is refused before any request', async () => {
  await withStack(async ({ srv, open }) => {
    const search = {
      provider: 'searxng' as const,
      baseURL: `${srv.url}/searxng`,
      allowPrivateNetwork: true,
    }
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
