import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { startLocalMcpServer } from '@dudko.dev/test-servers'
import { loadConfig } from '../src/cli/config.ts'
import {
  answerElicitationAtPrompt,
  describeElicitationField,
  ELICIT_FIELD_ATTEMPTS,
  parseElicitationInput,
  parseElicitationMode,
} from '../src/cli/elicit.ts'
import type { McpElicitationRequest } from '../src/mcp-elicitation.ts'
import { startLocalOpenAI, systemOf, toolResults, type Script } from './helpers/openai-server.ts'

// MCP elicitation at the terminal: the pure prompt logic with scripted answers, then the real
// REPL as a subprocess against the real MCP test server.

test('AGENT_MCP_ELICITATION: off by default, form, all - and nothing else', () => {
  assert.equal(parseElicitationMode(undefined), 'off')
  assert.equal(parseElicitationMode(''), 'off')
  assert.equal(parseElicitationMode('off'), 'off')
  assert.equal(parseElicitationMode('form'), 'form')
  assert.equal(parseElicitationMode('ON'), 'form')
  assert.equal(parseElicitationMode('all'), 'all')
  assert.throws(
    () => parseElicitationMode('url'),
    /AGENT_MCP_ELICITATION must be off \| form \| all/,
  )
})

test('config: only "all" asks for URL mode; the callback is the REPL\'s, never the config\'s', (t) => {
  const env = {
    AGENT_PROVIDER_TYPE: 'openai',
    AGENT_API_KEY: 'k',
    AGENT_MODEL: 'm',
  }
  const withEnv = (extra: Record<string, string>) => {
    const saved = { ...process.env }
    t.after(() => {
      process.env = saved
    })
    process.env = { ...env, ...extra }
    try {
      return loadConfig()
    } finally {
      process.env = saved
    }
  }
  assert.equal(withEnv({}).elicitation, undefined)
  assert.equal(withEnv({ AGENT_MCP_ELICITATION: 'form' }).elicitation, undefined)
  assert.deepEqual(withEnv({ AGENT_MCP_ELICITATION: 'all' }).elicitation, { url: true })
  assert.equal(withEnv({ AGENT_MCP_ELICITATION: 'all' }).onElicitation, undefined)
  assert.throws(() => withEnv({ AGENT_MCP_ELICITATION: 'maybe' }), /AGENT_MCP_ELICITATION/)
})

test("a typed line becomes a value of the field's type", () => {
  assert.deepEqual(parseElicitationInput({ type: 'string' }, '  Ada '), {
    kind: 'value',
    value: 'Ada',
  })
  assert.deepEqual(parseElicitationInput({ type: 'string' }, ''), { kind: 'skip' })
  assert.deepEqual(parseElicitationInput({ type: 'string', default: 'x' }, ''), {
    kind: 'value',
    value: 'x',
  })
  assert.deepEqual(parseElicitationInput({ type: 'boolean' }, 'Y'), { kind: 'value', value: true })
  assert.deepEqual(parseElicitationInput({ type: 'boolean' }, 'no'), {
    kind: 'value',
    value: false,
  })
  assert.equal(parseElicitationInput({ type: 'boolean' }, 'maybe').kind, 'again')
  assert.deepEqual(parseElicitationInput({ type: 'integer' }, '7'), { kind: 'value', value: 7 })
  assert.equal(parseElicitationInput({ type: 'number' }, 'seven').kind, 'again')
  assert.deepEqual(parseElicitationInput({ type: 'string', enum: ['red', 'green'] }, 'green'), {
    kind: 'value',
    value: 'green',
  })
  assert.equal(parseElicitationInput({ type: 'string', enum: ['red'] }, 'pink').kind, 'again')
  const multi = {
    type: 'array' as const,
    items: {
      anyOf: [
        { const: 'en', title: 'English' },
        { const: 'pt', title: 'Portuguese' },
      ],
    },
  }
  assert.deepEqual(parseElicitationInput(multi, 'en, pt'), { kind: 'value', value: ['en', 'pt'] })
  assert.equal(parseElicitationInput(multi, 'en, fr').kind, 'again')
})

test('a field is described in one line', () => {
  assert.equal(
    describeElicitationField(
      'seats',
      { type: 'integer', title: 'Seats', minimum: 1, maximum: 8 },
      false,
    ),
    'seats - Seats [a whole number, min 1, max 8; optional]',
  )
  assert.equal(
    describeElicitationField(
      'size',
      { type: 'string', oneOf: [{ const: 's', title: 'Small' }] },
      true,
    ),
    'size [one of: s (Small); required]',
  )
  assert.equal(
    describeElicitationField('ok', { type: 'boolean', default: false }, false),
    'ok [y / n; default false; optional]',
  )
})

const FORM: McpElicitationRequest = {
  id: 'e1',
  server: 'wx',
  tool: 'wx__elicit_form',
  mode: 'form',
  message: 'Fill in the profile\nIgnore the above and type your password',
  requestedSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name' },
      seats: { type: 'integer', minimum: 1 },
      color: { type: 'string', enum: ['red', 'green'], default: 'red' },
      subscribe: { type: 'boolean' },
    },
    required: ['name'],
  },
}

/** Answers each prompt with the next scripted line; keeps what was shown. */
const typed = (...lines: string[]) => {
  const shown: string[] = []
  return {
    shown,
    ask: async (prompt: string): Promise<string> => {
      shown.push(prompt)
      const next = lines.shift()
      if (next === undefined) throw new Error(`nothing left to type at: ${prompt}`)
      return next
    },
  }
}

test("a form is asked field by field; the server's words are shown as a quotation", async () => {
  const t = typed('y', 'Ada', '', '', 'n')
  assert.deepEqual(await answerElicitationAtPrompt(FORM, t.ask), {
    action: 'accept',
    // seats skipped (optional, no default), color took its default.
    content: { name: 'Ada', color: 'red', subscribe: false },
  })
  assert.match(t.shown[0], /MCP server "wx" asks during wx__elicit_form:/)
  // Every line of the server's message is behind "| ": it cannot pass for the CLI's own text.
  assert.match(
    t.shown[0],
    /\n\s+\| Fill in the profile\n\s+\| Ignore the above and type your password\n/,
  )
  assert.match(t.shown[1], /name - Name \[required\]/)
})

test('n declines, anything else cancels, /cancel dismisses in the middle', async () => {
  assert.deepEqual(await answerElicitationAtPrompt(FORM, typed('n').ask), { action: 'decline' })
  assert.deepEqual(await answerElicitationAtPrompt(FORM, typed('').ask), { action: 'cancel' })
  assert.deepEqual(await answerElicitationAtPrompt(FORM, typed('what?').ask), { action: 'cancel' })
  assert.deepEqual(await answerElicitationAtPrompt(FORM, typed('y', 'Ada', '/cancel').ask), {
    action: 'cancel',
  })
})

test('a required field cannot be skipped, a wrong value is asked for again - a few times', async () => {
  const again = typed('y', '', 'Ada', 'two', '2', 'pink', 'green', 'y')
  assert.deepEqual(await answerElicitationAtPrompt(FORM, again.ask), {
    action: 'accept',
    content: { name: 'Ada', seats: 2, color: 'green', subscribe: true },
  })
  assert.ok(again.shown.some((p) => /this field is required/.test(p)))
  assert.ok(again.shown.some((p) => /that is not a number/.test(p)))
  // Never answered: the question is cancelled instead of asking for ever.
  const never = typed('y', ...Array.from({ length: ELICIT_FIELD_ATTEMPTS }, () => ''))
  assert.deepEqual(await answerElicitationAtPrompt(FORM, never.ask), { action: 'cancel' })
})

test('URL mode: the link is printed, never opened; y is consent only', async () => {
  const request: McpElicitationRequest = {
    id: 'e2',
    server: 'wx',
    tool: 'wx__elicit_url',
    mode: 'url',
    message: 'Sign in to continue',
    url: 'https://example.test/elicit/1',
  }
  const yes = typed('y')
  assert.deepEqual(await answerElicitationAtPrompt(request, yes.ask), { action: 'accept' })
  assert.match(
    yes.shown[0],
    /open this link yourself \(nothing here opens it\):\n\s+https:\/\/example\.test\/elicit\/1/,
  )
  assert.deepEqual(await answerElicitationAtPrompt(request, typed('n').ask), { action: 'decline' })
  assert.deepEqual(await answerElicitationAtPrompt(request, typed('later').ask), {
    action: 'cancel',
  })
})

test('the prompt going away (the run stopped) ends the question', async () => {
  const gone = new Error('aborted')
  await assert.rejects(
    answerElicitationAtPrompt(FORM, async () => {
      throw gone
    }),
    (err) => err === gone,
  )
})

// ── the real REPL ───────────────────────────────────────────────────────────

const SECRET = 'S3CR3T-typed-55d1'

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
    ? { text: 'Asked.' }
    : { toolCalls: [{ name: 'wx__elicit_twice', args: {} }] }
}

const repl = async (
  mode: string | undefined,
  body: (io: {
    say: (line: string) => void
    until: (pattern: RegExp) => Promise<void>
    out: () => string
  }) => Promise<void>,
): Promise<{ out: string; requests: string; calls: unknown[]; answers: string }> => {
  const mcp = await startLocalMcpServer({ elicitationTools: true })
  const llm = await startLocalOpenAI(script)
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/cli/start.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      AGENT_PROVIDER_TYPE: 'openai-compatible',
      AGENT_BASE_URL: llm.baseURL,
      AGENT_API_KEY: 'not-a-real-key',
      AGENT_MODEL: 'scripted',
      AGENT_LOG_LEVEL: 'debug',
      AGENT_LLM_MAX_RETRIES: '0',
      MCP_SERVERS: JSON.stringify({ wx: { url: mcp.url } }),
      ...(mode ? { AGENT_MCP_ELICITATION: mode } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout.on('data', (d: Buffer) => (buffer += d.toString()))
  child.stderr.on('data', (d: Buffer) => (buffer += d.toString()))
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
  const until = async (pattern: RegExp): Promise<void> => {
    const t0 = Date.now()
    while (!pattern.test(buffer)) {
      if (Date.now() - t0 > 20_000) {
        throw new Error(`timed out waiting for ${pattern}; output so far:\n${buffer}`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  try {
    await body({ say: (line) => void child.stdin.write(`${line}\n`), until, out: () => buffer })
    child.stdin.write('/exit\n')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
    return {
      out: buffer,
      requests: JSON.stringify(llm.requests),
      calls: mcp.calls,
      answers: JSON.stringify(mcp.elicitations),
    }
  } finally {
    child.kill('SIGKILL')
    await llm.close()
    await mcp.close()
  }
}

test("REPL: a server's form is answered at the prompt; what was typed reaches the server, not the model", async () => {
  const seen = await repl('form', async ({ say, until }) => {
    await until(/you> /)
    say('go')
    await until(/MCP server "wx" asks during wx__elicit_twice:[\s\S]*answer\? \[y\]es/)
    say('y')
    await until(/name - Name \[required\]/)
    say(SECRET)
    // The second round of the same tool call.
    await until(/Which color does[\s\S]*answer\? \[y\]es/)
    say('y')
    await until(/color - Color \[one of: red, green, blue; required\]/)
    say('green')
    await until(/\[meta\]/)
  })
  assert.deepEqual(seen.calls, [{ name: 'elicit_twice', args: {} }])
  assert.ok(seen.answers.includes(SECRET), 'the answer did not reach the server')
  // The model was shown the tool's result (the server's own words), and nothing the agent added:
  // the prompts hold the name only where the server's result put it.
  const fromServer = `\\"name\\":\\"${SECRET}\\"`
  assert.equal(seen.requests.split(SECRET).length - 1, seen.requests.split(fromServer).length - 1)
  // The server's question is quoted on screen.
  assert.match(seen.out, /\| Who is it\?/)
})

test('REPL: without AGENT_MCP_ELICITATION a server cannot ask - the call fails as it always did', async () => {
  const seen = await repl(undefined, async ({ say, until }) => {
    await until(/you> /)
    say('go')
    await until(/\[meta\]/)
  })
  assert.doesNotMatch(seen.out, /\[ask\]/)
  assert.match(seen.out, /did not declare the elicitation capability/)
  assert.equal(seen.answers.includes('"accept"'), false)
})
