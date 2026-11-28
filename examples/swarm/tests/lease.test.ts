// The heartbeat lease: acquire only inside a turn activity, for the turn's own run; renew is a
// heartbeat until Temporal takes the turn away.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IRunBinding } from '../src/db/runs.ts'
import { createHeartbeatLease, withTurnScope, type ITurnScope } from '../src/lease.ts'

const opts = { owner: 'w', ttlMs: 3000 }

const make = (bindOk = true, fenceOk = true) => {
  const bound: IRunBinding[] = []
  const fenced: string[] = []
  const lease = createHeartbeatLease({
    bindRun: async (b) => {
      bound.push(b)
      return bindOk
    },
    fenceRun: async (runId) => {
      fenced.push(runId)
      return fenceOk ? 2 : undefined
    },
    ttlMs: 9000,
    owner: 'worker-1',
  })
  return { lease, bound, fenced }
}

const scope = (extra: Partial<ITurnScope> = {}): ITurnScope & { beats: unknown[] } => {
  const beats: unknown[] = []
  return {
    sessionId: 's',
    turn: 2,
    intent: { kind: 'fresh', runId: 'r1', runNo: 1, attemptBase: 0 },
    heartbeat: (d) => void beats.push(d),
    revoked: () => undefined,
    beats,
    ...extra,
  }
}

test('the lease carries its ttl and owner to the core', () => {
  const { lease } = make()
  assert.equal(lease.ttlMs, 9000)
  assert.equal(lease.owner, 'worker-1')
})

test('acquire outside a turn activity is refused', async () => {
  const { lease, bound } = make()
  assert.equal(await lease.acquire('r', opts), false)
  assert.deepEqual(bound, [])
})

test('a fresh run is bound to its turn; renew heartbeats; release forgets it', async () => {
  const { lease, bound } = make()
  const s = scope()
  // Only the run the activity named (run({ runId })): another id is refused before any bind.
  assert.equal(await withTurnScope(s, () => Promise.resolve(lease.acquire('other', opts))), false)
  assert.deepEqual(bound, [])
  assert.equal(await withTurnScope(s, () => Promise.resolve(lease.acquire('r1', opts))), true)
  assert.deepEqual(bound, [{ runId: 'r1', sessionId: 's', turn: 2, runNo: 1, attemptBase: 0 }])
  assert.equal(s.runId, 'r1')
  assert.equal(lease.scopeOf('r1'), s)
  // Renew is called from the core's timer: the scope is found by run id, not by context.
  assert.equal(await lease.renew('r1', opts), true)
  assert.deepEqual(s.beats, [{ runId: 'r1' }])
  await lease.release('r1', opts)
  assert.equal(lease.scopeOf('r1'), undefined)
  assert.equal(await lease.renew('r1', opts), false, 'a released run is not renewed')
})

test('a slot already bound (a worker that lost the turn) is refused', async () => {
  const { lease } = make(false)
  assert.equal(
    await withTurnScope(scope(), () => Promise.resolve(lease.acquire('r1', opts))),
    false,
  )
})

test('a resume takes only the run the turn resumes, and one run per turn activity', async () => {
  const { lease, bound, fenced } = make()
  const s = scope({ intent: { kind: 'resume', runId: 'r9', attemptBase: 0 } })
  assert.equal(await withTurnScope(s, () => Promise.resolve(lease.acquire('other', opts))), false)
  assert.deepEqual(fenced, [], 'another run is refused before anything is written')
  assert.equal(await withTurnScope(s, () => Promise.resolve(lease.acquire('r9', opts))), true)
  assert.deepEqual(bound, [], 'a resumed run is already bound')
  assert.deepEqual(fenced, ['r9'], 'the resume raised the fence when it took the run')
  assert.equal(await withTurnScope(s, () => Promise.resolve(lease.acquire('r10', opts))), false)
})

test('a resume of a run that is not bound (the fence finds no row) is refused', async () => {
  const { lease } = make(true, false)
  const s = scope({ intent: { kind: 'resume', runId: 'r9', attemptBase: 0 } })
  assert.equal(await withTurnScope(s, () => Promise.resolve(lease.acquire('r9', opts))), false)
  assert.equal(lease.scopeOf('r9'), undefined)
})

test('once Temporal takes the turn away, acquire and renew say no', async () => {
  const { lease } = make()
  let why: string | undefined
  const s = scope({ revoked: () => why })
  assert.equal(await withTurnScope(s, () => Promise.resolve(lease.acquire('r1', opts))), true)
  why = 'the heartbeat timed out'
  assert.equal(await lease.renew('r1', opts), false)
  assert.deepEqual(s.beats, [], 'no heartbeat for a turn that is not ours')
  const late = scope({
    intent: { kind: 'fresh', runId: 'r2', runNo: 1, attemptBase: 0 },
    revoked: () => 'the worker is shutting down',
  })
  assert.equal(await withTurnScope(late, () => Promise.resolve(lease.acquire('r2', opts))), false)
})
