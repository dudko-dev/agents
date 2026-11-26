import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createAgent, type AgentEvent, type IAgent, type IAgentConfig } from '../src/index.ts'
import { sandboxStats } from '../src/sandbox.ts'
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

// The whole loop: a model that writes a program and asks to run it, the gates in between, a real
// worker thread, and the output coming back for the answer.

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}

const CODE =
  'const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));\nconsole.log("fib(20) =", fib(20));\nfib(10)'

const script =
  (code: string): Script =>
  (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return {
          text: JSON.stringify({
            thought: 'Run it.',
            steps: [
              {
                id: 's1',
                description: 'Run the function on test data',
                expectedOutcome: 'its output',
                suggestedTools: ['run_js'],
              },
            ],
          }),
        }
      case 'executor':
        return hasToolResult(req)
          ? { text: `The run printed: ${toolResults(req).join(' ')}` }
          : toolNames(req).includes('run_js')
            ? { toolCalls: [{ name: 'run_js', args: { code } }] }
            : { text: 'I wrote the code but have no way to run it.' }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'finish', reason: 'done' }) }
      default:
        return { text: 'Done.' }
    }
  }

const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'sandbox-test',
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

const withAgent = async (
  code: string,
  extra: Partial<IAgentConfig>,
  body: (ctx: { llm: ILocalOpenAI; agent: IAgent }) => Promise<void>,
): Promise<void> => {
  const llm = await startLocalOpenAI(script(code))
  let agent: IAgent | undefined
  try {
    agent = await createAgent(config(llm.baseURL, extra))
    await body({ llm, agent })
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
  }
}

const stage = (llm: ILocalOpenAI, s: Stage) => llm.requests.filter((r) => stageOf(r) === s)

test('sandbox on: the model calls run_js, gets the real output, and answers with it', async () => {
  await withAgent(CODE, { sandbox: true }, async ({ llm, agent }) => {
    const events: AgentEvent[] = []
    const result = await agent.run({
      input: 'run fib on test data',
      onEvent: (e) => events.push(e),
    })

    assert.ok(
      agent.listTools().some((t) => t.name === 'run_js' && !t.readOnly),
      'run_js is in the catalogue, as a write',
    )
    const calls = result.trace[0].toolCalls
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'run_js')
    assert.equal(calls[0].ok, true)
    const output = calls[0].output as { ok: boolean; stdout: string; result: unknown }
    assert.equal(output.ok, true)
    assert.equal(output.stdout, 'fib(20) = 6765\n')
    assert.equal(output.result, 55)

    // The model was shown that output, and a UI gets it as ordinary tool events.
    const executor = stage(llm, 'executor')
    assert.match(toolResults(executor[1]).join(''), /fib\(20\) = 6765/)
    assert.match(result.trace[0].summary, /6765/)
    const called = events.find((e) => e.type === 'step.tool-call')
    assert.ok(called && called.type === 'step.tool-call' && called.name === 'run_js')
    const returned = events.find((e) => e.type === 'step.tool-result')
    assert.ok(returned && returned.type === 'step.tool-result' && returned.ok)

    // The stages are told what it is - in the system prompt, the same text on every call.
    assert.match(systemOf(executor[0]), /RUNNING CODE:\nrun_js runs JavaScript/)
    assert.match(systemOf(executor[0]), /Never say that code was run/)
    assert.equal(systemOf(executor[0]), systemOf(executor[1]), 'run-stable')
    assert.match(systemOf(stage(llm, 'planner')[0]), /RUNNING CODE:/)
    assert.match(systemOf(stage(llm, 'synthesizer')[0]), /RUNNING CODE:/)
  })
})

test('sandbox off (the default): no tool, no prompt change, no worker', async () => {
  const before = sandboxStats.workers
  await withAgent(CODE, {}, async ({ llm, agent }) => {
    const result = await agent.run({ input: 'run fib on test data' })
    assert.ok(!agent.listTools().some((t) => t.name === 'run_js'))
    assert.ok(llm.requests.every((r) => !toolNames(r).includes('run_js')))
    assert.ok(llm.requests.every((r) => !/RUNNING CODE|run_js/.test(systemOf(r))))
    assert.equal(result.trace[0].toolCalls.length, 0)
    assert.equal(sandboxStats.workers, before)
  })
})

test('sandbox off: the engine is never resolved and no worker starts (checked in a clean process)', async (t) => {
  const llm = await startLocalOpenAI(script(CODE))
  const probe = fileURLToPath(new URL('./fixtures/sandbox-off-probe.ts', import.meta.url))
  const runProbe = async (sandbox: 'on' | 'off') => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', probe],
      { env: { ...process.env, PROBE_BASE_URL: llm.baseURL, PROBE_SANDBOX: sandbox } },
    )
    return JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
      hooked: boolean
      tools: string[]
      toolCalls: string[]
      engineResolved: string[]
      engineLoaded: string[]
      workerResolved: string[]
      workers: number
    }
  }
  try {
    const off = await runProbe('off')
    if (!off.hooked) {
      t.skip('this Node has no module.registerHooks')
      return
    }
    assert.deepEqual(off.tools, [])
    assert.deepEqual(off.engineResolved, [], 'quickjs-emscripten was never looked up')
    assert.deepEqual(off.engineLoaded, [])
    assert.equal(off.workers, 0)
    // The same probe sees the difference when the sandbox is on, so its silence means something.
    const on = await runProbe('on')
    assert.deepEqual(on.tools, ['run_js'])
    assert.deepEqual(on.toolCalls, ['run_js'])
    assert.equal(on.workers, 1)
    // Even then the engine is imported by the worker only: the agent's thread never loads it.
    // (It may be resolved there: that is the "is the peer installed" check at creation.)
    assert.deepEqual(on.engineLoaded, [])
  } finally {
    await llm.close()
  }
})

test('sandbox: a failing program is a result the model reads, not a crashed step', async () => {
  await withAgent(
    'function parse(s) { return JSON.parse(s) }\nparse("{oops")',
    { sandbox: true },
    async ({ llm, agent }) => {
      const result = await agent.run({ input: 'run it' })
      const call = result.trace[0].toolCalls[0]
      assert.equal(call.ok, true, 'the tool call itself succeeded')
      const output = call.output as { ok: boolean; error: { name: string; stack: string } }
      assert.equal(output.ok, false)
      assert.equal(output.error.name, 'SyntaxError')
      assert.match(output.error.stack, /at parse \(\/main\.js:1/)
      assert.match(toolResults(stage(llm, 'executor')[1]).join(''), /SyntaxError/)
    },
  )
})

test('sandbox gates: read-only mode refuses run_js, ask-writes asks first, the budget counts it', async () => {
  await withAgent(
    CODE,
    { sandbox: true, toolApproval: { mode: 'read-only' } },
    async ({ agent }) => {
      const before = sandboxStats.workers
      const result = await agent.run({ input: 'run it' })
      assert.equal(result.trace[0].toolCalls[0].ok, false)
      assert.match(JSON.stringify(result.trace[0].toolCalls[0].output), /read-only/)
      assert.equal(sandboxStats.workers, before, 'a refused run starts nothing')
    },
  )

  const asked: { name: string; input: unknown; readOnly: boolean }[] = []
  await withAgent(
    CODE,
    {
      sandbox: true,
      toolApproval: {
        mode: 'ask-writes',
        onRequest: (req) => {
          asked.push({ name: req.toolName, input: req.input, readOnly: req.readOnly })
          return { approved: false, reason: 'not this code' }
        },
      },
    },
    async ({ agent }) => {
      const before = sandboxStats.workers
      const result = await agent.run({ input: 'run it' })
      assert.equal(asked.length, 1)
      assert.equal(asked[0].name, 'run_js')
      assert.equal(asked[0].readOnly, false)
      assert.deepEqual(asked[0].input, { code: CODE }, 'the user is shown the code')
      assert.equal(result.trace[0].toolCalls[0].ok, false)
      assert.equal(sandboxStats.workers, before)
    },
  )

  await withAgent(CODE, { sandbox: true, maxToolCalls: 1 }, async ({ agent }) => {
    const events: AgentEvent[] = []
    const result = await agent.run({ input: 'run it', onEvent: (e) => events.push(e) })
    assert.equal(result.trace[0].toolCalls.length, 1)
    assert.ok(
      events.some((e) => e.type === 'budget.exceeded' && e.kind === 'tool-calls'),
      'run_js counts against maxToolCalls',
    )
  })
})

test('sandbox: excludedTools removes run_js and the prompts stop mentioning it', async () => {
  await withAgent(CODE, { sandbox: true, excludedTools: ['run_js'] }, async ({ llm, agent }) => {
    await agent.run({ input: 'run it' })
    assert.ok(!agent.listTools().some((t) => t.name === 'run_js'))
    assert.ok(llm.requests.every((r) => !/RUNNING CODE/.test(systemOf(r))))
  })
})

test('sandbox: the output the model sees is capped by sandbox.maxOutputChars', async () => {
  await withAgent(
    'for (let i = 0; i < 5000; i++) console.log("line " + i); "end"',
    { sandbox: { maxOutputChars: 600 } },
    async ({ llm, agent }) => {
      const result = await agent.run({ input: 'run it' })
      const output = result.trace[0].toolCalls[0].output as { stdout: string; truncated: boolean }
      assert.equal(output.stdout.length, 600)
      assert.equal(output.truncated, true)
      assert.ok(toolResults(stage(llm, 'executor')[1]).join('').length < 1200)
    },
  )
})
