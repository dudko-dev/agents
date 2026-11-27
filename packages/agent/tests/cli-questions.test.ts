import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { PassThrough } from 'node:stream'
import test, { type TestContext } from 'node:test'
import { startLocalMcpServer } from '@dudko.dev/test-servers'
import { createApprovalController, ToolDeniedError } from '../src/approval.ts'
import {
  answerMcpElicitation,
  resolveMcpElicitationOptions,
  type McpElicitationCall,
  type McpElicitationEvent,
  type McpElicitationOptions,
} from '../src/mcp-elicitation.ts'
import {
  approvalClosedLine,
  closedReason,
  createPromptQuestions,
  elicitationClosedLine,
  SKILL_PREVIEW_LINE_CHARS,
  SKILL_PREVIEW_LINES,
  skillApprovalPrompt,
  skillClosedLine,
  type IPromptQuestions,
} from '../src/cli/questions.ts'
import type { McpSkillConsentView } from '../src/mcp-skills.ts'
import type { AgentEvent, IToolApprovalConfig } from '../src/types.ts'
import { startLocalOpenAI, systemOf, toolResults, type Script } from './helpers/openai-server.ts'

// The questions the REPL puts at its prompt (cli/questions.ts), over a REAL `readline/promises`
// interface on in-memory streams, asked by the REAL approval gate and elicitation function: a
// question the agent stops waiting for is closed with one line, and the next one is shown. Then
// the real REPL as a subprocess: Ctrl-C closes an open approval question the same way.

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** A prompt on in-memory streams: what it showed, what the REPL printed, and a typist. */
const terminal = (t: TestContext, runSignal?: () => AbortSignal | undefined) => {
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (d: Buffer) => (shown += d.toString()))
  const rl = createInterface({ input, output, terminal: false })
  t.after(() => rl.close())
  const printed: string[] = []
  const questions = createPromptQuestions({
    question: (prompt, options) => rl.question(prompt, options),
    print: (line) => printed.push(line),
    runSignal,
    approvalPrompt: (req) => `[approve] ${req.toolName}? `,
  })
  return {
    questions,
    printed,
    shown: () => shown,
    type: (line: string) => input.write(`${line}\n`),
  }
}

/** The real gate, asking through `questions`; `state()` says how one call has settled. */
const gateOf = (questions: IPromptQuestions, config: Omit<IToolApprovalConfig, 'onRequest'>) => {
  const events: AgentEvent[] = []
  const signals: AbortSignal[] = []
  const gate = createApprovalController(
    {
      mode: 'ask-all',
      ...config,
      onRequest: (req, ctx) => {
        signals.push(ctx.signal)
        return questions.approval(req, ctx)
      },
    },
    { fallbackEmit: (e) => events.push(e) },
  )
  const call = (name: string, signal?: AbortSignal) => {
    let settled: 'pending' | 'allowed' | Error = 'pending'
    void gate.gate(name, {}, { readOnly: false, signal }).then(
      () => {
        settled = 'allowed'
      },
      (err: Error) => {
        settled = err
      },
    )
    return () => settled
  }
  const resolvedId = (name: string): string | undefined =>
    events.find(
      (e): e is Extract<AgentEvent, { type: 'tool.approval-resolved' }> =>
        e.type === 'tool.approval-resolved' && e.name === name,
    )?.id
  return { call, events, signals, resolvedId }
}

test('the closing line says why: the bound (its own words), or the run being stopped', () => {
  const timeout = Object.assign(new Error('no decision within 300000ms'), { name: 'TimeoutError' })
  assert.equal(closedReason(false, timeout), 'no decision within 300000ms')
  assert.equal(closedReason(false, new DOMException('Aborted', 'AbortError')), 'no answer in time')
  assert.equal(closedReason(true, timeout), 'the run was stopped')
  assert.equal(
    approvalClosedLine('fs__write', 'the run was stopped'),
    '[approve] closed: the run was stopped - fs__write did not run',
  )
  assert.equal(
    elicitationClosedLine('no answer in time'),
    "[ask]     closed: no answer in time - the server's question was cancelled",
  )
})

test('approval: y, a and n are answers - the signal stays as it is and nothing is printed', async (t) => {
  const term = terminal(t)
  const g = gateOf(term.questions, {})
  for (const [typed, expected] of [
    ['n', 'denied'],
    ['y', 'allowed'],
    ['a', 'allowed'],
  ] as const) {
    const state = g.call(`tool_${typed}`)
    await flush()
    assert.match(term.shown(), new RegExp(`\\[approve\\] tool_${typed}\\? $`))
    term.type(typed)
    await flush()
    const settled = state()
    assert.equal(
      settled === 'allowed' ? 'allowed' : settled instanceof ToolDeniedError ? 'denied' : settled,
      expected,
    )
  }
  assert.deepEqual(
    g.signals.map((s) => s.aborted),
    [false, false, false],
    'an answered question is never aborted',
  )
  assert.deepEqual(term.printed, [])
})

test('approval: the 5-minute bound closes the open question with one line; the next one is shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const term = terminal(t)
  const g = gateOf(term.questions, {})
  const first = g.call('fs__write')
  await flush()
  assert.match(term.shown(), /\[approve\] fs__write\? $/)
  t.mock.timers.tick(299_999)
  await flush()
  assert.equal(first(), 'pending')
  t.mock.timers.tick(1)
  await flush()
  assert.ok(first() instanceof ToolDeniedError)
  assert.match(String(first()), /no decision within 300000ms/)
  assert.deepEqual(term.printed, [
    '[approve] closed: no decision within 300000ms - fs__write did not run',
  ])
  assert.equal(g.signals[0].aborted, true)
  assert.equal((g.signals[0].reason as Error).name, 'TimeoutError')
  // The REPL skips the event's own line for it: the prompt already said so. Once.
  const id = g.resolvedId('fs__write')
  assert.ok(id)
  assert.equal(term.questions.closedAtPrompt(id), true)
  assert.equal(term.questions.closedAtPrompt(id), false)
  // Not stuck: the next question is shown, and the line typed now answers it.
  const second = g.call('fs__delete')
  await flush()
  assert.match(term.shown(), /\[approve\] fs__delete\? $/)
  term.type('y')
  await flush()
  assert.equal(second(), 'allowed')
  assert.equal(g.signals[1].aborted, false)
})

test('approval: Infinity - only the stop closes the question, with its own line', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const run = new AbortController()
  const term = terminal(t, () => run.signal)
  const g = gateOf(term.questions, { timeoutMs: Infinity })
  const first = g.call('fs__write', run.signal)
  await flush()
  t.mock.timers.tick(2 ** 31)
  await flush()
  assert.equal(first(), 'pending')
  assert.deepEqual(term.printed, [])
  run.abort(new Error('stopped by the user'))
  await flush()
  assert.match(String(first()), /stopped by the user/)
  assert.deepEqual(term.printed, ['[approve] closed: the run was stopped - fs__write did not run'])
  const id = g.resolvedId('fs__write')
  assert.ok(id && term.questions.closedAtPrompt(id))
})

test('approval: a question that is no longer wanted when its turn comes is never shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const term = terminal(t)
  const open = gateOf(term.questions, { timeoutMs: 0 })
  const queued = gateOf(term.questions, { timeoutMs: 1000 })
  const first = open.call('fs__write')
  const second = queued.call('fs__delete')
  await flush()
  t.mock.timers.tick(1000)
  await flush()
  assert.ok(second() instanceof ToolDeniedError, 'the queued question timed out')
  // It was never on screen: no closing line, and the REPL prints the event's line for it.
  assert.deepEqual(term.printed, [])
  const id = queued.resolvedId('fs__delete')
  assert.ok(id)
  assert.equal(term.questions.closedAtPrompt(id), false)
  term.type('y')
  await flush()
  assert.equal(first(), 'allowed')
  await flush()
  assert.doesNotMatch(term.shown(), /fs__delete/)
})

// ── MCP elicitation at the same prompt ──────────────────────────────────────

const NAME_FORM = {
  mode: 'form',
  message: 'Who is it?',
  requestedSchema: {
    type: 'object',
    properties: { name: { type: 'string', title: 'Name' } },
    required: ['name'],
  },
}

const askElicitation = (
  questions: IPromptQuestions,
  settings: McpElicitationOptions,
  signal?: AbortSignal,
) => {
  const events: McpElicitationEvent[] = []
  const call: McpElicitationCall = {
    server: 'srv',
    tool: 'srv__ask',
    emit: (e) => events.push(e),
    run: { count: 0 },
    asked: 0,
    ...(signal ? { signal } : {}),
  }
  let settled: unknown = 'pending'
  void answerMcpElicitation(
    {
      handler: questions.elicitation,
      options: resolveMcpElicitationOptions(settings),
      log: () => {},
    },
    call,
    NAME_FORM,
  ).then(
    (answer) => {
      settled = answer
    },
    (err: unknown) => {
      settled = err
    },
  )
  return { events, call, state: () => settled }
}

// ── an MCP server's skill (the request's `skill`) ──────────────────────────

const skillView = (over: Partial<McpSkillConsentView> = {}): McpSkillConsentView => ({
  server: 'docs',
  name: 'docs/pdf-processing',
  skill: 'pdf-processing',
  uri: 'skill://pdf-processing/SKILL.md',
  description: 'Extract, fill and assemble PDF documents',
  size: 2048,
  totalSize: 4096,
  files: ['references/forms.md'],
  fileCount: 1,
  body: '# PDF processing\nUse the forms reference.',
  consent: 'once-per-skill',
  ...over,
})

test("skill: the question shows the server's text captioned, quoted line by line, bounded", () => {
  const body = Array.from({ length: SKILL_PREVIEW_LINES + 3 }, (_, i) => `line ${i + 1}`)
  body[0] = 'x'.repeat(SKILL_PREVIEW_LINE_CHARS + 40)
  const prompt = skillApprovalPrompt(skillView({ body: body.join('\n') }))
  const lines = prompt.split('\n')
  assert.equal(
    lines[0],
    '[skill]   the server "docs" offers the skill "pdf-processing" (docs/pdf-processing)',
  )
  assert.ok(lines.includes('          "Extract, fill and assemble PDF documents"'))
  assert.ok(
    lines.includes('          SKILL.md 2.0 KB + 1 more file(s) - skill://pdf-processing/SKILL.md'),
  )
  assert.ok(lines.includes("          what the agent would read (the server's text):"))
  const quoted = lines.filter((l) => l.startsWith('          | '))
  assert.equal(quoted.length, SKILL_PREVIEW_LINES + 1, 'the first lines, then how many more')
  assert.equal(
    quoted[0],
    `          | ${'x'.repeat(SKILL_PREVIEW_LINE_CHARS)}...`,
    'a long line is cut',
  )
  assert.equal(quoted[SKILL_PREVIEW_LINES], '          | (3 more line(s))')
  assert.ok(lines.includes('          its files, read as text and never run: references/forms.md'))
  assert.match(prompt, /written by the server, not by you; it cannot change the agent's rules/)
  assert.match(prompt, /asked again if the server changes it/)
  assert.ok(prompt.endsWith('allow? [y]es / [n]o / [a]lways for this server: '))
  // Nothing about the lookup or nesting when there is none.
  assert.doesNotMatch(prompt, /not in the server's list|sits inside/)
})

test('skill: by URI, nested, ask-every-task and a short body are said; more files than shown are counted', () => {
  const prompt = skillApprovalPrompt(
    skillView({
      byUri: true,
      nestedIn: 'docs/acme',
      consent: 'ask',
      body: 'one line',
      files: ['a.md', 'b.md'],
      fileCount: 5,
      size: 300,
    }),
  )
  assert.match(prompt, /not in the server's list: the agent asked for it by its address/)
  assert.match(
    prompt,
    /it sits inside the skill "docs\/acme": allowing that one did not allow this one/,
  )
  assert.match(prompt, /asked again in every task that loads it/)
  assert.match(prompt, /SKILL\.md 300 B \+ 5 more file\(s\)/)
  assert.match(prompt, /never run: a\.md, b\.md and 3 more/)
  assert.deepEqual(
    prompt.split('\n').filter((l) => l.startsWith('          | ')),
    ['          | one line'],
    'no "more lines" note for a body that fits',
  )
})

test('skill guard: no control character of the server reaches the terminal - in any field', () => {
  const esc = '\u001b[2J\u001b]0;pwned\u0007\r\u009b31m\u0000\u007f'
  const prompt = skillApprovalPrompt(
    skillView({
      server: `docs${esc}`,
      name: `docs/pdf${esc}`,
      skill: `pdf${esc}`,
      uri: `skill://pdf/SKILL.md${esc}`,
      description: `PDFs${esc}`,
      body: `# PDF${esc}\nsecond${esc}`,
      files: [`a.md${esc}`],
      nestedIn: `docs/acme${esc}`,
    }),
  )
  // Line ends are the prompt's own; every other C0 / C1 control is gone.
  assert.doesNotMatch(prompt, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/)
  assert.match(prompt, /\| # PDF\[2J\]0;pwned31m\n/, 'the printable rest stays, as text')
})

/** The real gate's skill question (`askSkill`), asked through `questions`. */
const askSkillAt = (questions: IPromptQuestions, timeoutMs?: number) => {
  const signals: AbortSignal[] = []
  const gate = createApprovalController(
    {
      mode: 'autopilot',
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      onRequest: (req, ctx) => {
        signals.push(ctx.signal)
        return questions.approval(req, ctx)
      },
    },
    { fallbackEmit: () => {} },
  )
  return {
    signals,
    ask: (view: McpSkillConsentView) =>
      gate.askSkill({ name: view.name }, view, {}) as Promise<{
        approved: boolean
        remember?: boolean
        reason?: string
        by: string
      }>,
  }
}

test('skill: y lets it in, a is "always for this server", anything else declines - asked as a skill, not a tool', async (t) => {
  const term = terminal(t)
  const g = askSkillAt(term.questions)
  for (const [typed, approved, remember] of [
    ['y', true, false],
    ['a', true, true],
    ['n', false, false],
    ['ok', false, false],
  ] as const) {
    const answer = g.ask(skillView())
    await flush()
    assert.match(term.shown(), /allow\? \[y\]es \/ \[n\]o \/ \[a\]lways for this server: $/)
    term.type(typed)
    const a = await answer
    assert.equal(a.approved, approved, typed)
    assert.equal(a.remember === true, remember, typed)
    assert.equal(a.by, 'person')
    if (!approved) assert.equal(a.reason, 'the user declined the skill')
  }
  assert.match(term.shown(), /\[skill\]   the server "docs" offers the skill "pdf-processing"/)
  assert.doesNotMatch(
    term.shown(),
    /\[approve\]/,
    "the tool question's text is never used for a skill",
  )
  assert.deepEqual(term.printed, [])
})

test('skill: the bound closes the open question with its own line; the next one is shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const term = terminal(t)
  const g = askSkillAt(term.questions, 1000)
  const first = g.ask(skillView())
  await flush()
  t.mock.timers.tick(1000)
  const a = await first
  assert.equal(a.approved, false)
  assert.equal(a.by, 'no-answer')
  assert.deepEqual(term.printed, [
    skillClosedLine('docs/pdf-processing', 'no decision within 1000ms'),
  ])
  assert.equal(
    term.printed[0],
    '[skill]   closed: no decision within 1000ms - docs/pdf-processing was not loaded',
  )
  const second = g.ask(skillView({ name: 'docs/other', skill: 'other' }))
  await flush()
  assert.match(term.shown(), /offers the skill "other" \(docs\/other\)/)
  term.type('y')
  assert.equal((await second).approved, true)
})

test('elicitation: answered at the prompt - the abort that follows an answer prints nothing', async (t) => {
  const term = terminal(t)
  const q = askElicitation(term.questions, {})
  await flush()
  assert.match(term.shown(), /answer\? \[y\]es \/ \[n\]o \/ \[c\]ancel: $/)
  term.type('y')
  await flush()
  term.type('Ada')
  await flush()
  assert.deepEqual(q.state(), { action: 'accept', content: { name: 'Ada' } })
  assert.deepEqual(term.printed, [])
})

test("elicitation: the question's bound closes it with one line; the next question is shown", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const term = terminal(t)
  const q = askElicitation(term.questions, { timeoutMs: 1000 })
  await flush()
  assert.match(term.shown(), /answer\? \[y\]es/)
  t.mock.timers.tick(1000)
  await flush()
  assert.deepEqual(q.state(), { action: 'cancel' })
  assert.deepEqual(term.printed, [
    "[ask]     closed: no answer in time - the server's question was cancelled",
  ])
  const answered = q.events.find((e) => e.type === 'mcp.elicitation-answered')
  assert.equal(answered?.type === 'mcp.elicitation-answered' && answered.reason, 'timeout')
  assert.equal(term.questions.closedAtPrompt(answered!.id), true)
  // The same prompt goes on: an approval asked next is shown and answered.
  const g = gateOf(term.questions, {})
  const next = g.call('fs__write')
  await flush()
  assert.match(term.shown(), /\[approve\] fs__write\? $/)
  term.type('y')
  await flush()
  assert.equal(next(), 'allowed')
})

test('elicitation: Infinity - a stop of the run closes it, with its own line', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const run = new AbortController()
  const term = terminal(t, () => run.signal)
  const q = askElicitation(term.questions, { timeoutMs: Infinity }, run.signal)
  await flush()
  t.mock.timers.tick(2 ** 31)
  await flush()
  assert.equal(q.state(), 'pending')
  run.abort(new Error('stopped by the user'))
  await flush()
  assert.match(String(q.state()), /stopped by the user/)
  assert.deepEqual(term.printed, [
    "[ask]     closed: the run was stopped - the server's question was cancelled",
  ])
})

// ── the real REPL: Ctrl-C closes an open approval question ──────────────────

const planJson = JSON.stringify({
  thought: 'Plan.',
  steps: [{ id: 's1', description: 'Step s1', expectedOutcome: 'done', suggestedTools: [] }],
})
const script: Script = (req) => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return { text: planJson }
  if (system.includes('You are the Replanner')) {
    return { text: JSON.stringify({ mode: 'finish', reason: 'done' }) }
  }
  if (system.includes('You are the Synthesizer')) return { text: 'All done.' }
  return toolResults(req).length
    ? { text: 'Echoed.' }
    : { toolCalls: [{ name: 'wx__echo', args: { text: 'hi' } }] }
}

test('REPL: Ctrl-C closes the open approval question with one line; the next run asks again', async () => {
  const mcp = await startLocalMcpServer({})
  const llm = await startLocalOpenAI(script)
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/cli/start.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      AGENT_PROVIDER_TYPE: 'openai-compatible',
      AGENT_BASE_URL: llm.baseURL,
      AGENT_API_KEY: 'not-a-real-key',
      AGENT_MODEL: 'scripted',
      AGENT_LOG_LEVEL: 'none',
      AGENT_LLM_MAX_RETRIES: '0',
      AGENT_TOOL_APPROVAL: 'ask-all',
      MCP_SERVERS: JSON.stringify({ wx: { url: mcp.url } }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout.on('data', (d: Buffer) => (buffer += d.toString()))
  child.stderr.on('data', (d: Buffer) => (buffer += d.toString()))
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
  const count = (pattern: RegExp): number => buffer.match(new RegExp(pattern, 'g'))?.length ?? 0
  const until = async (pattern: RegExp, times = 1): Promise<void> => {
    const t0 = Date.now()
    while (count(pattern) < times) {
      if (Date.now() - t0 > 20_000) {
        throw new Error(`timed out waiting for ${pattern}; output so far:\n${buffer}`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  const say = (line: string) => void child.stdin.write(`${line}\n`)
  try {
    await until(/you> /)
    say('echo it')
    await until(/allow\? \[y\]es/)
    child.kill('SIGINT')
    await until(/\[approve\] closed: the run was stopped - wx__echo did not run/)
    await until(/you> /, 2)
    // One line for it: the event's own "denied" line is not printed as well.
    assert.doesNotMatch(buffer, /!! wx__echo denied/)
    say('echo it again')
    await until(/allow\? \[y\]es/, 2)
    say('y')
    await until(/All done\./)
    assert.deepEqual(mcp.calls, [{ name: 'echo', args: { text: 'hi' } }])
    child.stdin.write('/exit\n')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
  } finally {
    child.kill('SIGKILL')
    await llm.close()
    await mcp.close()
  }
})
