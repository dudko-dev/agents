// Run in a child process by sandbox-integration.test.ts: one full agent run with the sandbox
// OFF, while every module the process resolves is recorded. Prints what it saw as JSON.
import * as nodeModule from 'node:module'

const seen: string[] = []
const registerHooks = (
  nodeModule as unknown as {
    registerHooks?: (hooks: {
      resolve: (
        specifier: string,
        context: unknown,
        next: (s: string, c: unknown) => unknown,
      ) => unknown
    }) => void
  }
).registerHooks
registerHooks?.({
  resolve: (specifier, context, next) => {
    seen.push(specifier)
    return next(specifier, context)
  },
})

const { createAgent } = await import('../../src/index.ts')
const { sandboxStats } = await import('../../src/sandbox.ts')
const agent = await createAgent({
  clientName: 'sandbox-off-probe',
  providerType: 'openai-compatible',
  baseURL: process.env.PROBE_BASE_URL ?? '',
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 3,
  maxStepsPerTask: 3,
  logLevel: 'none',
  llmMaxRetries: 0,
  ...(process.env.PROBE_SANDBOX === 'on' ? { sandbox: true } : {}),
})
const result = await agent.run({ input: 'run the code' })
await agent.close()
console.log(
  JSON.stringify({
    hooked: Boolean(registerHooks),
    tools: agent.listTools().map((t) => t.name),
    toolCalls: result.trace.flatMap((s) => s.toolCalls.map((c) => c.name)),
    engineResolved: seen.filter((s) => /quickjs/.test(s)),
    workerResolved: seen.filter((s) => /sandbox-worker/.test(s)),
    workers: sandboxStats.workers,
  }),
)
