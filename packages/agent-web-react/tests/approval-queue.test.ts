import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApprovalQueue, type ToolApprovalRequest } from '../dist/index.js'

// The consent queue behind useAgent's approve / deny: the core's `toolApproval.onRequest`. A
// request the core stops waiting for (its signal: the 5-minute bound, a stopped run) leaves the
// queue at once - no stale resolver is kept for an answer nobody wants.

const request = (id: string): ToolApprovalRequest => ({
  id,
  toolName: 'fs__write',
  input: {},
  readOnly: false,
})

test('approve and deny answer a waiting request once; an unknown id is a no-op', async () => {
  const q = createApprovalQueue()
  const a = q.handler(request('a'), { signal: new AbortController().signal })
  const b = q.handler(request('b'))
  assert.deepEqual(q.pending(), ['a', 'b'])
  assert.equal(q.approve('a', { remember: true }), true)
  assert.equal(q.approve('a'), false, 'answered once')
  assert.equal(q.deny('b', 'not now'), true)
  assert.equal(q.deny('nope'), false)
  assert.deepEqual(await a, { approved: true, remember: true })
  assert.deepEqual(await b, { approved: false, reason: 'not now' })
  assert.deepEqual(q.pending(), [])
})

test('a request whose signal aborts leaves the queue: approve finds nothing to resolve', async () => {
  const q = createApprovalQueue()
  const asked = new AbortController()
  const kept = new AbortController()
  const gone = q.handler(request('gone'), { signal: asked.signal })
  const stays = q.handler(request('stays'), { signal: kept.signal })
  asked.abort(
    Object.assign(new Error('no approval decision within 300000 ms'), { name: 'TimeoutError' }),
  )
  assert.deepEqual(q.pending(), ['stays'], 'the timed-out request was dropped')
  assert.deepEqual(await gone, { approved: false, reason: 'no longer asked' })
  assert.equal(q.approve('gone'), false, 'a late click does nothing')
  assert.equal(q.approve('stays'), true)
  assert.deepEqual(await stays, { approved: true, remember: undefined })
  // An abort after the answer changes nothing.
  kept.abort()
  assert.deepEqual(q.pending(), [])
})

test('a request asked with an already aborted signal is never queued', async () => {
  const q = createApprovalQueue()
  const decision = await q.handler(request('late'), { signal: AbortSignal.abort() })
  assert.deepEqual(decision, { approved: false, reason: 'no longer asked' })
  assert.deepEqual(q.pending(), [])
})

test('settleAll answers every waiting request (the run ended, the view closed)', async () => {
  const q = createApprovalQueue()
  const one = q.handler(request('1'), { signal: new AbortController().signal })
  const two = q.handler(request('2'))
  q.settleAll({ approved: false, reason: 'the run ended' })
  assert.deepEqual(await Promise.all([one, two]), [
    { approved: false, reason: 'the run ended' },
    { approved: false, reason: 'the run ended' },
  ])
  assert.deepEqual(q.pending(), [])
})
