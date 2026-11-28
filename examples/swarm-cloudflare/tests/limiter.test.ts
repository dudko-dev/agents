// sharedLimits on this platform (src/limiter.ts): the bucket in its object's SQLite, by the
// object's clock, and the step's side - a wait, then a refusal beyond LIMITER_MAX_WAIT_MS.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSharedLimits, takeBucket, RateLimitRefusal } from '../src/limiter.ts'
import { memoryStorage } from './helpers/sqlite.ts'

const call = { stage: 'executor' as const, modelId: 'm', provider: 'p' }

test('the bucket: full at first, taken, refilled by the clock, never above capacity', () => {
  const { sql } = memoryStorage()
  const cfg = { capacity: 2, refillPerSecond: 1 }
  assert.equal(takeBucket(sql, 'b', 1, cfg, 0).take, true)
  assert.equal(takeBucket(sql, 'b', 1, cfg, 0).take, true)
  const wait = takeBucket(sql, 'b', 1, cfg, 0)
  assert.ok(!wait.take && wait.waitMs === 1000)
  assert.equal(takeBucket(sql, 'b', 1, cfg, 1000).take, true)
  assert.equal(takeBucket(sql, 'other', 1, cfg, 1000).take, true, 'a bucket is its own')
  const later = takeBucket(sql, 'b', 1, cfg, 100_000)
  assert.ok(later.take && later.state.tokens === 1, 'capped at the capacity')
})

test('the step waits for a token, and refuses a wait beyond the limit', async () => {
  const { sql } = memoryStorage()
  let now = 0
  const slept: number[] = []
  const limitsOf = (refillPerSecond: number) =>
    createSharedLimits(
      async (bucket, cost, cfg) => takeBucket(sql, bucket, cost, cfg, now),
      { capacity: 1, refillPerSecond, scope: 'model', maxWaitMs: 1500 },
      async (ms) => {
        slept.push(ms)
        now += ms
      },
    )
  const signal = new AbortController().signal
  const waits = limitsOf(1)
  await waits.beforeModelCall(call, { signal })
  await waits.beforeModelCall(call, { signal })
  assert.deepEqual(slept, [1000], 'the second call waited for the refill')
  const slow = limitsOf(0.001)
  await slow.beforeModelCall({ ...call, modelId: 'other' }, { signal })
  await assert.rejects(
    async () => slow.beforeModelCall({ ...call, modelId: 'other' }, { signal }),
    (err: unknown) => err instanceof RateLimitRefusal && /p:other/.test(err.message),
  )
  assert.deepEqual(slept, [1000], 'a refusal waits for nothing')
})
