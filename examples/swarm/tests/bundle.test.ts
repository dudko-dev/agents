// The workflow bundle holds the pipeline engine (`@dudko.dev/agent/pipeline-engine`, which imports
// nothing) and NOTHING of the agent's main entry, the AI SDK, zod or the MCP client: the workflow
// sandbox has the language and little else, and the engine is the only part of the agent that is
// deterministic by contract. Bundled here from the source (not the `build` output, which may be
// stale). Each marker is a string literal that minification keeps, checked to be in its library
// first, so the test cannot pass by looking for something that is nowhere.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { bundleWorkflowCode } from '@temporalio/worker'
import { WORKFLOWS_PATH } from '../src/paths.ts'

const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} }

// Every JS file of the package `name` (a marker may sit in a chunk), from one of its files.
const packageText = (name: string, entry: string): string => {
  let dir = dirname(entry)
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) break
    dir = dirname(dir)
  }
  const files: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory() && entry.name !== 'node_modules') walk(p)
      else if (entry.isFile() && /\.(c|m)?js$/.test(entry.name)) files.push(p)
    }
  }
  walk(dir)
  assert.ok(files.length > 0, `found the files of ${name}`)
  return files.map((f) => readFileSync(f, 'utf8')).join('\n')
}

const resolved = (specifier: string): string => fileURLToPath(import.meta.resolve(specifier))

test('the workflow bundle has the pipeline engine and none of the main entry, ai, zod or MCP', async () => {
  const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH, logger: silent })
  const agentMain = resolved('@dudko.dev/agent')
  const engine = resolved('@dudko.dev/agent/pipeline-engine')
  // The MCP client is the agent's dependency, not the swarm's: resolved from the agent.
  const mcp = createRequire(agentMain).resolve('@modelcontextprotocol/client')
  const present: [string, string][] = [
    // PipelineNodeError's message (runPipelineGraph) and PipelineValidationError's (preparePipeline).
    ['Pipeline node "', readFileSync(engine, 'utf8')],
    ['Invalid pipeline: ', readFileSync(engine, 'utf8')],
  ]
  const absent: [string, string, string][] = [
    // The planner's role phrase: the agent's main entry.
    ['the main entry', 'You are the Planner', readFileSync(agentMain, 'utf8')],
    // The AI SDK's error marker.
    ['ai', 'vercel.ai.error', packageText('ai', resolved('ai'))],
    // zod's error class name.
    ['zod', 'ZodError', packageText('zod', resolved('zod'))],
    // An MCP method the client sends on every connection.
    [
      'the MCP client',
      'notifications/initialized',
      packageText('@modelcontextprotocol/client', mcp),
    ],
  ]
  for (const [marker, source] of present) {
    assert.ok(source.includes(marker), `"${marker}" is in the engine`)
    assert.ok(code.includes(marker), `the engine is in the bundle ("${marker}")`)
  }
  for (const [what, marker, source] of absent) {
    assert.ok(source.includes(marker), `"${marker}" is in ${what}`)
    assert.ok(!code.includes(marker), `${what} is not in the bundle ("${marker}")`)
  }
})
