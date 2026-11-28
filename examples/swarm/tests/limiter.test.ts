// The token bucket's math, and the call loop over a fake database (the lock, the clock read after
// it, the wait outside the transaction, the refusal past maxWaitMs).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bucketOf,
  createPostgresLimits,
  ensureBucketSql,
  lockBucketSql,
  nowSql,
  RateLimitRefusal,
  refill,
  saveBucketSql,
  takeOrWait,
} from '../src/db/limiter.ts'
import type { IDatabase } from '../src/db/pool.ts'

const cfg = { capacity: 4, refillPerSecond: 2 }

test('refill: time adds tokens up to capacity; a clock that went back adds none', () => {
  assert.deepEqual(refill({ tokens: 0, updatedMs: 1000 }, 2000, cfg), {
    tokens: 2,
    updatedMs: 2000,
  })
  assert.deepEqual(refill({ tokens: 3, updatedMs: 0 }, 10_000, cfg), {
    tokens: 4,
    updatedMs: 10_000,
  })
  assert.deepEqual(refill({ tokens: 1, updatedMs: 5000 }, 4000, cfg), {
    tokens: 1,
    updatedMs: 5000,
  })
  assert.deepEqual(refill({ tokens: 1, updatedMs: 0 }, 250, cfg), { tokens: 1.5, updatedMs: 250 })
})

test('takeOrWait: take when there is enough, else the time until there is', () => {
  assert.deepEqual(takeOrWait({ tokens: 1, updatedMs: 0 }, 0, 1, cfg), {
    take: true,
    state: { tokens: 0, updatedMs: 0 },
  })
  assert.deepEqual(takeOrWait({ tokens: 0, updatedMs: 0 }, 0, 1, cfg), {
    take: false,
    state: { tokens: 0, updatedMs: 0 },
    waitMs: 500,
  })
  // Partly refilled: wait only for the rest.
  const d = takeOrWait({ tokens: 0, updatedMs: 0 }, 250, 1, cfg)
  assert.equal(d.take, false)
  assert.equal(d.take ? 0 : d.waitMs, 250)
  assert.deepEqual(takeOrWait({ tokens: 0, updatedMs: 0 }, 500, 1, cfg).take, true)
  assert.equal(
    (takeOrWait({ tokens: 0.2, updatedMs: 0 }, 0, 3, cfg) as { waitMs: number }).waitMs,
    1400,
  )
})

test('bucketOf: one global bucket, or one per provider and model', () => {
  assert.equal(bucketOf({ provider: 'openai.chat', modelId: 'gpt' }, 'global'), 'global')
  assert.equal(bucketOf({ provider: 'openai.chat', modelId: 'gpt' }, 'model'), 'openai.chat:gpt')
  assert.equal(bucketOf({ modelId: 'm' }, 'model'), 'unknown:m')
  assert.equal(bucketOf({ modelId: 'x'.repeat(500) }, 'model').length, 200)
})

// A bucket in memory behind the four statements the limiter sends, with a clock the test moves.
const fakeDb = (clock: { now: number }, start: { tokens: number }) => {
  const state = { tokens: start.tokens, updatedMs: clock.now, exists: false }
  const log: string[] = []
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      log.push(text.split(' ')[0]!)
      if (text === ensureBucketSql && !state.exists) {
        state.exists = true
        state.tokens = values[1] as number
      }
      if (text === lockBucketSql)
        return { rows: [{ tokens: state.tokens, updated_ms: state.updatedMs }] }
      if (text === nowSql) return { rows: [{ now_ms: clock.now }] }
      if (text === saveBucketSql) {
        state.tokens = values[1] as number
        state.updatedMs = values[2] as number
      }
      return { rows: [], rowCount: 1 }
    },
    release: () => {},
  }
  const db = { connect: async () => client, query: client.query } as unknown as IDatabase
  return { db, state, log }
}

test('beforeModelCall: takes under the lock, waits outside it, refuses past maxWaitMs', async () => {
  const clock = { now: 1_000_000 }
  const { db, state, log } = fakeDb(clock, { tokens: 0 })
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    clock.now += ms
  }
  const limits = createPostgresLimits(
    db,
    { capacity: 1, refillPerSecond: 2, maxWaitMs: 1000, scope: 'global' },
    sleep,
  )
  const call = { stage: 'executor' as const, modelId: 'm' }
  await limits.beforeModelCall(call, {})
  assert.deepEqual(sleeps, [], 'a new bucket starts full')
  assert.equal(state.tokens, 0)
  assert.deepEqual(log.slice(0, 6), ['BEGIN', 'INSERT', 'SELECT', 'SELECT', 'UPDATE', 'COMMIT'])
  await limits.beforeModelCall(call, {})
  assert.deepEqual(sleeps, [500], 'the second waits for one refill')
  // And the third: another 500 ms, within the 1000 ms allowed per call.
  await limits.beforeModelCall(call, {})
  assert.deepEqual(sleeps, [500, 500])

  const strict = createPostgresLimits(
    db,
    { capacity: 1, refillPerSecond: 2, maxWaitMs: 400, scope: 'global' },
    sleep,
  )
  await assert.rejects(async () => strict.beforeModelCall(call, {}), RateLimitRefusal)
  assert.deepEqual(sleeps, [500, 500], 'a refusal does not wait first')
})

test('beforeModelCall: a call given up while it waits stops waiting', async () => {
  const clock = { now: 0 }
  const { db } = fakeDb(clock, { tokens: 0 })
  const limits = createPostgresLimits(db, {
    capacity: 1,
    refillPerSecond: 0.01,
    maxWaitMs: 1_000_000,
    scope: 'global',
  })
  const call = { stage: 'planner' as const, modelId: 'm' }
  await limits.beforeModelCall(call, {})
  const ac = new AbortController()
  const pending = limits.beforeModelCall(call, { signal: ac.signal })
  setTimeout(() => ac.abort(new Error('given up')), 20)
  await assert.rejects(async () => pending, /given up/)
})
