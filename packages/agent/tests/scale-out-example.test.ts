import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelCallRefusedError, RunLeaseError, type IModelCall } from '../src/index.ts'
import { createMemoryRunLease, createTokenBucketLimits } from '../examples/scale-out-memory.ts'
import { config, linearScript, withLlm } from './helpers/loop.ts'

// The in-memory reference implementations of the two scale-out hooks (examples/), as the README
// shows them: the contract they keep, and two agents ("workers") sharing them.

test('example lease: one owner at a time; a renew after expiry is refused; release frees it', () => {
  let t = 0
  const lease = createMemoryRunLease({ now: () => t })
  const opts = (owner: string) => ({ owner, ttlMs: 1_000 })
  assert.equal(lease.acquire('r', opts('a')), true)
  assert.equal(lease.acquire('r', opts('b')), false, 'held by a')
  assert.equal(lease.renew('r', opts('b')), false, 'b does not hold it')
  t = 900
  assert.equal(lease.renew('r', opts('a')), true)
  t = 1_800
  assert.equal(lease.holder('r'), 'a', 'renewed at 900: held until 1900')
  t = 2_000
  assert.equal(lease.renew('r', opts('a')), false, 'ran out: another worker may have it')
  assert.equal(lease.acquire('r', opts('b')), true, 'free once it ran out')
  lease.release('r', { owner: 'a' })
  assert.equal(lease.holder('r'), 'b', 'only the holder releases')
  lease.release('r', { owner: 'b' })
  assert.equal(lease.holder('r'), undefined)
})

test('example bucket: waits when empty, refuses a run that spent its budget', async () => {
  let t = 0
  const slept: number[] = []
  const limits = createTokenBucketLimits({
    capacity: 2,
    refillPerSecond: 1,
    maxTokensPerRun: 30,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms)
      t += ms
    },
  })
  const call: IModelCall = { runId: 'r', stage: 'executor', modelId: 'm' }
  await limits.beforeModelCall(call, {})
  await limits.beforeModelCall(call, {})
  assert.deepEqual(slept, [], 'a burst of two')
  await limits.beforeModelCall(call, {})
  assert.deepEqual(slept, [1_000], 'the third waits for the refill')
  const usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30 }
  await limits.afterModelCall?.(call, usage, { ok: true })
  assert.equal(limits.spent('r'), 30)
  await assert.rejects(Promise.resolve(limits.beforeModelCall(call, {})), /spent its 30 tokens/)
})

test('example: two workers share one lease and one budget', async () => {
  await withLlm(linearScript(['s1', 's2']), async ({ llm, open }) => {
    const lease = createMemoryRunLease()
    const limits = createTokenBucketLimits({
      capacity: 100,
      refillPerSecond: 100,
      maxTokensPerRun: 45,
    })
    const a = await open(config(llm.baseURL, { runLease: lease, sharedLimits: limits }))
    const b = await open(config(llm.baseURL, { runLease: lease, sharedLimits: limits }))
    assert.notEqual(a.leaseOwner, b.leaseOwner)
    // A run held by worker a cannot be started by worker b.
    assert.equal(lease.acquire('held-run', { owner: a.leaseOwner as string, ttlMs: 30_000 }), true)
    await assert.rejects(
      b.run({ input: '', resumeFromRunId: 'held-run' }),
      (err: unknown) => err instanceof RunLeaseError && !err.lost,
    )
    // Plan, s1, s2: three calls of 15 tokens spend a run's budget of 45 - the synthesizer's call
    // is refused.
    await assert.rejects(a.run({ input: 'x' }), ModelCallRefusedError)
    assert.equal(llm.requests.length, 3)
  })
})
