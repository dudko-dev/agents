// An HTTP MCP server's tools from a step in workerd, a tool that declares an `outputSchema`
// included: its result is checked against the schema by the MCP SDK's code-free validator - Ajv
// compiles schemas to code, which workerd forbids (packages/agent's newOutputSchemaValidator:
// without it, this call is "an invalid outputSchema").
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import {
  api,
  planJson,
  readStream,
  roundOf,
  stageOf,
  startStack,
  toolResults,
  type ISseEvent,
  type IStack,
} from './harness.ts'

let stack: IStack

before(async () => {
  stack = await startStack(
    (req) => {
      const stage = stageOf(req)
      if (stage === 'planner') return { text: planJson(['a']) }
      if (stage === 'replanner')
        return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
      if (stage === 'synthesizer') return { text: 'final' }
      if (roundOf(req) === 0) return { toolCalls: [{ name: 'docs__report', args: {} }] }
      return { text: `results: ${toolResults(req).join(' | ')}` }
    },
    {},
    { structuredTools: true },
  )
})

after(async () => {
  await stack?.stop()
})

test('a structured MCP tool is called from workerd and its result checked against its schema', async () => {
  const client = api(stack)
  const { body } = await client.post('/sessions', { message: 'the weather' })
  const sessionId = body.sessionId as string
  const done = await readStream(
    `${stack.base}/sessions/${sessionId}/events`,
    client.headers,
    (seen: ISseEvent[]) => seen.some((e) => e.data.event.type === 'turn.ended'),
  )
  const result = done.events.find((e) => e.data.event.type === 'step.tool-result')!.data.event
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.output, { city: 'Lisbon', temperature: 21, tags: ['mild', 'clear'] })
  assert.equal(stack.mcp.calls.filter((c) => c.name === 'report').length, 1)
})
