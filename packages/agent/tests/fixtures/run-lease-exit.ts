// Run in a child process by run-lease.test.ts: runs that hold a lease (config.runLease) end every
// way they can - success, failure, stop, a lost lease, a refused acquire, a resume of an unknown
// run - with the lease's timers on a time source (its test seam) whose every timer is a REAL,
// ref'd one of an hour. A timer one of those ways out left behind would keep this process alive
// that long, and the parent test, which waits for the exit, would see it hang. Prints how many of
// those timers are pending after each.
import { tool } from 'ai'
import { z } from 'zod'
import { createAgent, type IAgentConfig, type IRunLease } from '../../src/index.ts'
import { startLocalOpenAI, systemOf, toolResults } from '../helpers/openai-server.ts'

const TEST_TIME = Symbol.for('@dudko.dev/agent:run-lease-test-time')
const HOUR = 3_600_000
const live = new Map<ReturnType<typeof setTimeout>, { fire: () => void; ms: number }>()
;(globalThis as unknown as Record<symbol, unknown>)[TEST_TIME] = {
  set: (fire: () => void, ms: number) => {
    const handle = setTimeout(() => {
      live.delete(handle)
      fire()
    }, HOUR)
    live.set(handle, { fire, ms })
    return handle
  },
  clear: (handle: unknown) => {
    live.delete(handle as ReturnType<typeof setTimeout>)
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}
// Fire the soonest pending timer now (the renew: ttlMs / 3, before the expiry's ttlMs).
const fireSoonest = (): void => {
  const [handle, entry] = [...live.entries()].sort((a, b) => a[1].ms - b[1].ms)[0] ?? []
  if (!handle || !entry) throw new Error('no lease timer pending')
  live.delete(handle)
  clearTimeout(handle)
  entry.fire()
}

let renewAnswer = true
let acquireAnswer = true
const lease: IRunLease = {
  acquire: () => acquireAnswer,
  renew: () => renewAnswer,
  release: () => {},
}

let toolStarted = false
const wait_here = tool({
  description: 'Wait until aborted',
  inputSchema: z.object({}),
  execute: (_input, { abortSignal }) => {
    toolStarted = true
    return new Promise((_resolve, reject) => {
      abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
    })
  },
})

const llm = await startLocalOpenAI((req) => {
  const system = systemOf(req)
  const user = JSON.stringify(req.messages)
  if (system.includes('You are the Planner')) {
    return {
      text: JSON.stringify({
        thought: 't',
        steps: [{ id: 's1', description: 'one', expectedOutcome: 'done', suggestedTools: [] }],
      }),
    }
  }
  if (system.includes('You are the Synthesizer')) return { text: 'answer' }
  if (user.includes('FAIL')) return { status: 400, text: 'bad request' }
  if (user.includes('WAIT') && toolResults(req).length === 0) {
    return { toolCalls: [{ name: 'wait_here', args: {} }] }
  }
  return { text: 'did it' }
})

const config: IAgentConfig = {
  clientName: 'lease-exit',
  providerType: 'openai-compatible',
  baseURL: llm.baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 3,
  maxStepsPerTask: 3,
  logLevel: 'none',
  llmMaxRetries: 0,
  runLease: lease,
  tools: { wait_here },
  persistence: { loadRun: () => null },
}
const agent = await createAgent(config)
const report = (label: string): void => {
  process.stdout.write(`${label}: ${live.size}\n`)
}
const settle = async (p: Promise<unknown>): Promise<void> => {
  await p.then(
    () => {},
    () => {},
  )
}
const untilStarted = async (): Promise<void> => {
  while (!toolStarted) await new Promise((r) => setTimeout(r, 5))
  toolStarted = false
}

await settle(agent.run({ input: 'plain' }))
report('success')
await settle(agent.run({ input: 'FAIL please' }))
report('failure')
{
  const stop = new AbortController()
  const run = agent.run({ input: 'WAIT please', signal: stop.signal })
  await untilStarted()
  stop.abort()
  await settle(run)
  report('stop')
}
{
  renewAnswer = false
  const run = agent.run({ input: 'WAIT please' })
  await untilStarted()
  fireSoonest()
  await settle(run)
  renewAnswer = true
  report('lost')
}
acquireAnswer = false
await settle(agent.run({ input: 'plain' }))
acquireAnswer = true
report('refused')
await settle(agent.run({ input: '', resumeFromRunId: 'unknown-run' }))
report('unknown-resume')
await agent.close()
await llm.close()
