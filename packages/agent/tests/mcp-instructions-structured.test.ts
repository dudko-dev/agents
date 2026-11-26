import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REPORT_IMAGE_BASE64,
  REPORT_VALUE,
  startLocalMcpServer,
  type ILocalMcpServer,
  type ILocalMcpServerOptions,
} from '@dudko.dev/test-servers'
import { createAgent, type IAgent } from '../src/index.ts'
import { connectMcpServers } from '../src/mcp.ts'
import {
  MCP_INSTRUCTIONS_HEADING,
  MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER,
  MCP_INSTRUCTIONS_PREAMBLE,
  MCP_INSTRUCTIONS_TRUNCATED,
} from '../src/mcp-shared.ts'
import {
  startLocalOpenAI,
  systemOf,
  toolResults,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from './helpers/openai-server.ts'

// Server instructions and structured tool results against a REAL MCP server
// (the SDK's own, over sockets) - and, for the runs, a scripted model endpoint,
// so what is asserted is what actually went over the wire to the model.

const NOTES = 'Call report before report_mixed.\nNever call boom twice.'

const silent = (): void => {}

const callTool = (tools: Record<string, unknown>, name: string, args: unknown = {}) =>
  (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {})

const withMcp = async (
  opts: ILocalMcpServerOptions,
  body: (mcp: ILocalMcpServer) => Promise<void>,
): Promise<void> => {
  const mcp = await startLocalMcpServer(opts)
  try {
    await body(mcp)
  } finally {
    await mcp.close()
  }
}

// ── the connector ───────────────────────────────────────────────────────────

test('connect: a server`s instructions are read from its initialize result', async () => {
  await withMcp({ instructions: `  ${NOTES}​  ` }, async (guided) => {
    await withMcp({}, async (plain) => {
      const mcp = await connectMcpServers(
        { plain: { url: plain.url }, guided: { url: guided.url } },
        silent,
        'agent-test',
      )
      try {
        // Only the server that sent some; cleaned (trimmed, invisible characters gone).
        assert.deepEqual(mcp.instructions, [{ server: 'guided', instructions: NOTES }])
      } finally {
        await mcp.close()
      }
    })
  })
})

test('structured result: the model-facing output is the value, once', async () => {
  await withMcp({ structuredTools: true }, async (server) => {
    const mcp = await connectMcpServers({ wx: { url: server.url } }, silent, 'agent-test')
    try {
      // The server sent the value twice (structuredContent + the same JSON as text).
      assert.deepEqual(await callTool(mcp.tools, 'wx__report'), REPORT_VALUE)
      // Content that says something else stays, beside the value; the image is untouched.
      assert.deepEqual(await callTool(mcp.tools, 'wx__report_mixed'), {
        structuredContent: REPORT_VALUE,
        content: [
          'A mild, clear day.',
          { type: 'image', data: REPORT_IMAGE_BASE64, mimeType: 'image/png' },
        ],
      })
      // Tools without structured content answer exactly as before.
      assert.equal(await callTool(mcp.tools, 'wx__echo', { text: 'hi' }), 'echo:hi')
      await assert.rejects(() => callTool(mcp.tools, 'wx__boom'), /^McpToolError: kaboom$/)
    } finally {
      await mcp.close()
    }
  })
})

test('structured result that breaks its outputSchema: passed on with a note, not thrown', async () => {
  await withMcp({ structuredTools: true }, async (server) => {
    const logs: string[] = []
    const mcp = await connectMcpServers(
      { wx: { url: server.url } },
      (level, message) => logs.push(`${level} ${message}`),
      'agent-test',
    )
    try {
      server.structuredFaults.result = 'mismatch'
      const wrong = (await callTool(mcp.tools, 'wx__report')) as Record<string, unknown>
      assert.deepEqual(Object.keys(wrong), ['note', 'structuredContent'])
      assert.deepEqual(wrong.structuredContent, { ...REPORT_VALUE, temperature: 'warm' })
      assert.match(String(wrong.note), /The tool "report" ran, but its result does not follow/)
      assert.match(String(wrong.note), /does not match the tool's output schema/)

      server.structuredFaults.result = 'missing'
      const missing = (await callTool(mcp.tools, 'wx__report')) as Record<string, unknown>
      assert.deepEqual(Object.keys(missing), ['note', 'content'])
      assert.equal(missing.content, JSON.stringify(REPORT_VALUE))
      assert.match(String(missing.note), /did not return structured content/)

      assert.equal(server.calls.filter((c) => c.name === 'report').length, 2, 'one call each')
      assert.equal(
        logs.filter((l) => /^warn .*wx__report: result does not follow/.test(l)).length,
        2,
      )
    } finally {
      await mcp.close()
    }
  })
})

test('outputSanitizer: the structured value goes through it too', async () => {
  await withMcp({ structuredTools: true }, async (server) => {
    const seen: unknown[] = []
    const mcp = await connectMcpServers(
      { wx: { url: server.url } },
      silent,
      'agent-test',
      (_name, output) => {
        seen.push(output)
        // Redact the city wherever it is: a text part, or the structured object.
        return JSON.parse(JSON.stringify(output).replaceAll('Lisbon', '[city]'))
      },
    )
    try {
      assert.deepEqual(await callTool(mcp.tools, 'wx__report'), { ...REPORT_VALUE, city: '[city]' })
      // The duplicate text was dropped before sanitizing: one call, with the object.
      assert.deepEqual(seen, [REPORT_VALUE])
      seen.length = 0
      const mixed = (await callTool(mcp.tools, 'wx__report_mixed')) as Record<string, unknown>
      assert.deepEqual(mixed.structuredContent, { ...REPORT_VALUE, city: '[city]' })
      assert.equal(seen.length, 2, 'the content parts, then the structured value')
      assert.ok(Array.isArray(seen[0]))
      assert.deepEqual(seen[1], REPORT_VALUE)
    } finally {
      await mcp.close()
    }
  })
})

test('outputSanitizer that throws on the structured value: nothing unsanitized gets out', async () => {
  await withMcp({ structuredTools: true }, async (server) => {
    const mcp = await connectMcpServers({ wx: { url: server.url } }, silent, 'agent-test', () => {
      throw new Error('sanitizer exploded')
    })
    try {
      assert.equal(await callTool(mcp.tools, 'wx__report'), '[output redacted: sanitizer failed]')
    } finally {
      await mcp.close()
    }
  })
})

// ── whole runs ──────────────────────────────────────────────────────────────

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer'

const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}

const plan = JSON.stringify({
  thought: 'Read the report.',
  steps: [
    { id: 's1', description: 'Get the report', expectedOutcome: 'A report', suggestedTools: [] },
    { id: 's2', description: 'Sum it up', expectedOutcome: 'A summary', suggestedTools: [] },
  ],
})

// Step 1 calls `tool`, step 2 just answers; the replanner lets both run.
const scriptCalling =
  (tool: string): Script =>
  (req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: plan }
    if (stage === 'replanner') return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }) }
    if (stage === 'synthesizer') return { text: 'Done.' }
    const text = JSON.stringify(req.messages)
    if (text.includes('id=s2') || toolResults(req).length > 0) return { text: 'Step finished.' }
    return { toolCalls: [{ name: tool, args: {} }] }
  }

const withRun = async (
  serverOpts: ILocalMcpServerOptions,
  script: Script,
  extra: Record<string, unknown>,
  body: (ctx: { agent: IAgent; llm: ILocalOpenAI; server: ILocalMcpServer }) => Promise<void>,
): Promise<void> => {
  const server = await startLocalMcpServer(serverOpts)
  const llm = await startLocalOpenAI(script)
  let agent: IAgent | undefined
  try {
    agent = await createAgent({
      clientName: 'agent-mcp-test',
      providerType: 'openai-compatible',
      baseURL: llm.baseURL,
      apiKey: 'not-a-real-key',
      model: 'scripted',
      mcpServers: { wx: { url: server.url } },
      maxIterations: 4,
      replanAfter: 'always',
      logLevel: 'none',
      ...extra,
    } as never)
    await body({ agent, llm, server })
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
    await server.close()
  }
}

const systemsOf = (llm: ILocalOpenAI, stage: Stage): string[] =>
  llm.requests.filter((r) => stageOf(r) === stage).map(systemOf)

test('run: the planner and the executor get the server`s instructions, marked as third-party', async () => {
  await withRun(
    { instructions: NOTES, structuredTools: true },
    scriptCalling('wx__report'),
    { systemPrompt: 'OPERATOR RULES: answer in English.' },
    async ({ agent, llm }) => {
      const result = await agent.run({ input: 'What is the weather?' })
      assert.equal(result.text, 'Done.')

      const section =
        `${MCP_INSTRUCTIONS_HEADING}:\n${MCP_INSTRUCTIONS_PREAMBLE}\n\n` +
        'Server "wx":\n| Call report before report_mixed.\n| Never call boom twice.'
      const planner = systemsOf(llm, 'planner')
      const executor = systemsOf(llm, 'executor')
      assert.equal(planner.length, 1)
      assert.ok(executor.length >= 3, 'two steps, one of them with a tool round')
      for (const system of [...planner, ...executor]) {
        assert.ok(system.includes(section), 'the section is in the prompt, whole')
        // After the operator's own text: the preamble's "rules above" covers it.
        assert.ok(system.indexOf('OPERATOR RULES') < system.indexOf(MCP_INSTRUCTIONS_HEADING))
      }
      // Prompt caching: one executor system prompt for the whole run.
      assert.equal(new Set(executor).size, 1)
      // The stages that neither choose nor call tools do not carry third-party text.
      for (const system of [...systemsOf(llm, 'replanner'), ...systemsOf(llm, 'synthesizer')]) {
        assert.ok(!system.includes(MCP_INSTRUCTIONS_HEADING))
        assert.ok(!system.includes('Never call boom twice'))
      }
      assert.ok(systemsOf(llm, 'replanner').length > 0)
    },
  )
})

test('run: no instructions from the server, no section in any prompt', async () => {
  await withRun(
    { structuredTools: true },
    scriptCalling('wx__report'),
    {},
    async ({ agent, llm }) => {
      await agent.run({ input: 'What is the weather?' })
      assert.ok(llm.requests.length > 0)
      for (const req of llm.requests) {
        assert.ok(!systemOf(req).includes(MCP_INSTRUCTIONS_HEADING))
        assert.ok(!systemOf(req).includes('third-party'))
      }
    },
  )
})

test('run: mcpInstructions: false keeps a server`s text out of the prompts', async () => {
  await withRun(
    { instructions: NOTES },
    scriptCalling('wx__echo'),
    { mcpInstructions: false },
    async ({ agent, llm }) => {
      await agent.run({ input: 'Echo' }).catch(() => {})
      assert.ok(llm.requests.length > 0)
      for (const req of llm.requests) {
        assert.ok(!systemOf(req).includes(MCP_INSTRUCTIONS_HEADING))
        assert.ok(!systemOf(req).includes('Never call boom twice'))
      }
    },
  )
})

test('run: a server whose tools are all filtered out has no say', async () => {
  await withRun(
    { instructions: NOTES },
    scriptCalling('wx__echo'),
    { availableTools: ['some_other_tool'] },
    async ({ agent, llm }) => {
      assert.deepEqual(agent.listTools(), [])
      await agent.run({ input: 'Echo' }).catch(() => {})
      assert.ok(llm.requests.length > 0)
      for (const req of llm.requests) {
        assert.ok(!systemOf(req).includes(MCP_INSTRUCTIONS_HEADING))
      }
    },
  )
})

test('run: tool search does not drop the instructions, and an oversized note is cut', async () => {
  const long = `START ${'9'.repeat(MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER)} END-OF-NOTES`
  await withRun(
    { instructions: long, structuredTools: true },
    scriptCalling('find_tools'),
    { toolSelectionStrategy: 'search' },
    async ({ agent, llm }) => {
      await agent.run({ input: 'What is the weather?' }).catch(() => {})
      const planner = systemsOf(llm, 'planner')[0]
      assert.match(planner, /tool-search mode/)
      for (const system of [planner, ...systemsOf(llm, 'executor')]) {
        assert.ok(system.includes(`${MCP_INSTRUCTIONS_HEADING}:`))
        assert.ok(system.includes('Server "wx":\n| START 999'))
        assert.ok(system.includes(MCP_INSTRUCTIONS_TRUNCATED))
        assert.ok(!system.includes('END-OF-NOTES'))
        assert.equal(system.split('9').length - 1 <= MCP_INSTRUCTIONS_MAX_CHARS_PER_SERVER, true)
      }
      assert.ok(systemsOf(llm, 'executor').length > 0)
    },
  )
})

test('run: the model sees a structured result once, as JSON', async () => {
  await withRun(
    { structuredTools: true },
    scriptCalling('wx__report'),
    {},
    async ({ agent, llm }) => {
      const result = await agent.run({ input: 'What is the weather?' })
      const call = result.trace[0].toolCalls[0]
      assert.equal(call.name, 'wx__report')
      assert.equal(call.ok, true)
      assert.deepEqual(call.output, REPORT_VALUE)
      const seen = llm.requests.flatMap(toolResults)
      assert.ok(seen.length > 0)
      for (const text of seen) {
        assert.deepEqual(JSON.parse(text), REPORT_VALUE)
        assert.equal(text.split('Lisbon').length - 1, 1, 'the value is there once')
      }
    },
  )
})

test('run: a result that breaks its outputSchema does not fail the call or the run', async () => {
  await withRun(
    { structuredTools: true },
    scriptCalling('wx__report'),
    {},
    async ({ agent, llm, server }) => {
      server.structuredFaults.result = 'mismatch'
      const result = await agent.run({ input: 'What is the weather?' })
      assert.equal(result.text, 'Done.')
      const call = result.trace[0].toolCalls[0]
      assert.equal(call.ok, true, 'the call ran on the server: it is not reported as failed')
      assert.equal(server.calls.filter((c) => c.name === 'report').length, 1)
      const seen = llm.requests.flatMap(toolResults)[0]
      assert.match(seen, /does not follow the output schema/)
      assert.match(seen, /"temperature":"warm"/)
    },
  )
})

test('run: the output cap still applies to a structured result', async () => {
  await withRun(
    { structuredTools: true },
    scriptCalling('wx__report'),
    { compaction: { maxToolOutputChars: 20 } },
    async ({ agent, llm }) => {
      const result = await agent.run({ input: 'What is the weather?' })
      // The trace keeps the whole value; the model got the capped text.
      assert.deepEqual(result.trace[0].toolCalls[0].output, REPORT_VALUE)
      const seen = llm.requests.flatMap(toolResults)[0]
      assert.match(seen, /truncated/)
      assert.ok(!seen.includes('clear'))
      assert.ok(seen.startsWith(JSON.stringify(REPORT_VALUE).slice(0, 20)))
    },
  )
})

test('run: a reconnect cannot change the instructions under a run; the next run gets the new ones', async () => {
  const slow: Script = (req) => {
    const reply = scriptCalling('wx__echo_missing')(req)
    // Hold the first executor answer, so the test can act while the run is going.
    return stageOf(req) === 'executor' ? { text: 'Step finished.', delayMs: 150 } : reply
  }
  await withRun({ instructions: 'VERSION ONE' }, slow, {}, async ({ agent, llm, server }) => {
    const running = agent.run({ input: 'Go' })
    while (!llm.requests.some((r) => stageOf(r) === 'executor')) {
      await new Promise((r) => setTimeout(r, 5))
    }
    server.setInstructions('VERSION TWO')
    await assert.rejects(() => agent.reconnect(), /active run/)
    await running
    const first = llm.requests.filter((r) => ['planner', 'executor'].includes(stageOf(r)))
    assert.ok(first.length >= 3)
    for (const req of first) {
      assert.ok(systemOf(req).includes('| VERSION ONE'))
      assert.ok(!systemOf(req).includes('VERSION TWO'))
    }

    await agent.reconnect()
    const before = llm.requests.length
    await agent.run({ input: 'Go again' })
    const second = llm.requests
      .slice(before)
      .filter((r) => ['planner', 'executor'].includes(stageOf(r)))
    assert.ok(second.length >= 3)
    for (const req of second) {
      assert.ok(systemOf(req).includes('| VERSION TWO'))
      assert.ok(!systemOf(req).includes('VERSION ONE'))
    }
  })
})
