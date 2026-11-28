import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createAgent, defineTool, type AgentEvent, type RunPersistence } from '../dist/index.js'
import { scriptedModel, stageOf } from './helpers/scripted-model.ts'

// The Node sibling's server-only hooks - the call journal, parking, the run lease, shared limits
// (docs/design.md, "The call journal and parking: names reserved, server-only") - are REFUSED
// here, not ignored: code written for the server agent fails at createAgent / run instead of
// running without the guarantee it was written for. `{ park: true }` from an approval handler is
// a denial, as it always was, and now says why.

const planJson = JSON.stringify({ thought: 'Plan.', steps: [{ description: 'Step s1' }] })

const script = (useTool = true) =>
  scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: planJson }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'finish', reason: 'done' }) }
      case 'synthesizer':
        return { text: 'All done.' }
      default:
        return useTool && info.toolResults < 1
          ? { toolCalls: [{ name: 'save_note', args: { text: 'a' } }] }
          : { text: 'reported' }
    }
  })

const SERVER_ONLY = /is the server package's \(@dudko\.dev\/agent\), not this browser package's/

for (const [label, extra] of [
  ['runLease', { runLease: { acquire: () => true, renew: () => true, release: () => {} } }],
  ['sharedLimits', { sharedLimits: { beforeModelCall: () => ({ ok: true }) } }],
  [
    'persistence.journal',
    { persistence: { journal: { append: () => {}, load: () => [] } } as unknown as RunPersistence },
  ],
] as const) {
  test(`server-only: createAgent refuses ${label}, naming it, before any model call`, async () => {
    const { model, calls } = script()
    await assert.rejects(
      createAgent({ model, toolMode: 'native', ...(extra as object) }),
      (err: Error) => err.message.startsWith(`${label} `) && SERVER_ONLY.test(err.message),
    )
    assert.equal(calls.length, 0)
  })
}

test('server-only: persistence without a journal is accepted as before', async () => {
  const { model } = script(false)
  const persistence: RunPersistence = { onRunStart: () => {}, onRunComplete: () => {} }
  const agent = await createAgent({ model, toolMode: 'native', persistence })
  const result = await agent.run('go')
  assert.equal(result.final, 'All done.')
})

test('server-only: run({ answers }) is refused before anything of the run', async () => {
  const { model, calls } = script()
  const events: AgentEvent[] = []
  const agent = await createAgent({ model, toolMode: 'native' })
  await assert.rejects(
    agent.run('go', { answers: { x: true }, onEvent: (e: AgentEvent) => events.push(e) } as never),
    (err: Error) => err.message.startsWith('run({ answers }) ') && SERVER_ONLY.test(err.message),
  )
  assert.equal(calls.length, 0)
  assert.equal(events.length, 0)
})

test('server-only: { park: true } from onRequest denies the call and says parking is server-only', async () => {
  const { model } = script()
  const ran: string[] = []
  const events: AgentEvent[] = []
  const agent = await createAgent({
    model,
    toolMode: 'native',
    tools: {
      save_note: defineTool({
        description: 'Save a note',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => {
          ran.push(text)
          return `saved ${text}`
        },
      }),
    },
    toolApproval: { mode: 'ask-all', onRequest: () => ({ park: true }) as never },
  })
  await agent.run('go', { onEvent: (e: AgentEvent) => events.push(e) })
  assert.deepEqual(ran, [], 'the tool never ran')
  const resolved = events.filter(
    (e): e is Extract<AgentEvent, { type: 'tool.approval-resolved' }> =>
      e.type === 'tool.approval-resolved',
  )
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].approved, false)
  assert.match(String(resolved[0].reason), /parking \(\{ park: true \}\) is the server package's/)
})
