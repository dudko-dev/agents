// A worker process like `main.ts worker`, with one native write tool - `write_note`, which appends
// a line to the file SWARM_TEST_NOTES names - so a test that kills the process can count the
// writes. SUBAGENTS and PIPELINES are read the way the worker reads them, but against the agent
// WITH that tool (the environment alone has no native tools).
import { appendFileSync } from 'node:fs'
import { tool } from 'ai'
import { z } from 'zod'
import { pipelinesFromEnv, subagentProfilesFromEnv } from '../../src/agent-config.ts'
import { workerConfig } from '../../src/config.ts'
import { createLogger, errorMessage } from '../../src/log.ts'
import { installRuntime, startWorker } from '../../src/worker.ts'

const notes = process.env.SWARM_TEST_NOTES ?? ''
const writeNote = tool({
  description: 'Write a note (a write).',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => {
    appendFileSync(notes, `${text}\n`)
    return `wrote ${text}`
  },
})

const log = createLogger('warn', { role: 'worker' })
try {
  const { PIPELINES, SUBAGENTS, ...env } = process.env
  const cfg = workerConfig(env)
  const agent = { ...cfg.agent, tools: { write_note: writeNote } }
  const subagents = subagentProfilesFromEnv({ SUBAGENTS }, agent)
  const pipelines = pipelinesFromEnv({ PIPELINES }, agent, Object.keys(subagents))
  installRuntime(log)
  const running = await startWorker(cfg, log, agent, subagents, pipelines)
  await running.done
  process.exit(0)
} catch (err) {
  log.error('failed', { error: errorMessage(err) })
  process.exit(1)
}
