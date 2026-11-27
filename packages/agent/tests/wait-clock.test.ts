import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test, { mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createWaitClock,
  deadlineSignal,
  followClock,
  followHumanWaits,
  humanWaitOf,
} from '../src/wait-clock.ts'

// The clock the step and subagent time limits run on: stopped while a person is asked, going on
// with what it had left. Pure, so it is tested here on mocked timers (setTimeout and Date move
// only when a test ticks them); what the two cores do with it, over real sockets, is in
// `human-wait.test.ts` (here and in the browser package).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

test('wait-clock: the browser package carries the same file, byte for byte', () => {
  const sibling = here('../../agent-web/src/wait-clock.ts')
  // Only in the monorepo: the published package has no sibling to compare with.
  if (!existsSync(sibling)) return
  assert.equal(
    readFileSync(here('../src/wait-clock.ts'), 'utf8'),
    readFileSync(sibling, 'utf8'),
    'wait-clock.ts and agent-web/src/wait-clock.ts must stay identical',
  )
})

test('wait-clock: the shared file imports nothing', () => {
  const source = readFileSync(here('../src/wait-clock.ts'), 'utf8')
  assert.equal(/^\s*import\s/m.test(source), false)
  assert.equal(/\brequire\(/.test(source), false)
})

/** Mocked setTimeout + Date for one test; restored after it. */
const fakeTime = (t: { after: (fn: () => void) => void }) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  t.after(() => mock.timers.reset())
  return (ms: number) => mock.timers.tick(ms)
}

test('a deadline fires after its running time; nothing earlier', (t) => {
  const tick = fakeTime(t)
  const clock = createWaitClock()
  let fired = 0
  const timer = clock.timer(100, () => (fired += 1))
  tick(99)
  assert.equal(fired, 0)
  assert.equal(timer.left(), 1)
  tick(1)
  assert.equal(fired, 1)
  assert.equal(timer.left(), 0)
  tick(1000)
  assert.equal(fired, 1, 'once')
})

test('pause: the deadline stops, and goes on with what it had left - not a full limit, not none', (t) => {
  const tick = fakeTime(t)
  const clock = createWaitClock()
  let fired = 0
  const timer = clock.timer(100, () => (fired += 1))
  tick(70)
  const resume = clock.pause()
  assert.equal(clock.paused, true)
  tick(10_000)
  assert.equal(fired, 0, 'the wait counted against the deadline')
  assert.equal(timer.left(), 30)
  resume()
  assert.equal(clock.paused, false)
  tick(29)
  assert.equal(fired, 0, 'the deadline lost time it had')
  tick(1)
  assert.equal(fired, 1, 'the deadline got more than it had left')
})

test('pause: overlapping waits - the clock runs again when the LAST is over; a resume counts once', (t) => {
  const tick = fakeTime(t)
  const clock = createWaitClock()
  let fired = 0
  clock.timer(50, () => (fired += 1))
  const first = clock.pause()
  const second = clock.pause()
  tick(100)
  first()
  first()
  assert.equal(clock.paused, true, 'a second call of the same resume ended another wait')
  tick(100)
  assert.equal(fired, 0)
  second()
  tick(49)
  assert.equal(fired, 0)
  tick(1)
  assert.equal(fired, 1)
})

test('a deadline set while the clock is paused starts when the wait is over', (t) => {
  const tick = fakeTime(t)
  const clock = createWaitClock()
  const resume = clock.pause()
  let fired = 0
  clock.timer(20, () => (fired += 1))
  tick(1000)
  assert.equal(fired, 0)
  resume()
  tick(20)
  assert.equal(fired, 1)
})

test('cancel: a deadline taken down never fires, paused or not; twice is safe', (t) => {
  const tick = fakeTime(t)
  const clock = createWaitClock()
  let fired = 0
  const a = clock.timer(10, () => (fired += 1))
  const b = clock.timer(10, () => (fired += 1))
  a.cancel()
  a.cancel()
  const resume = clock.pause()
  b.cancel()
  resume()
  tick(100)
  assert.equal(fired, 0)
  assert.equal(a.left(), 0)
})

test('a wall clock set back gives a deadline no more time', (t) => {
  const tick = fakeTime(t)
  const clock = createWaitClock()
  const timer = clock.timer(100, () => {})
  tick(40)
  mock.timers.setTime(0)
  assert.ok(timer.left() <= 100)
  const resume = clock.pause()
  assert.ok(timer.left() <= 100)
  resume()
})

test('watch: told when the clock stops and when it runs again, once per change', () => {
  const clock = createWaitClock()
  const seen: boolean[] = []
  const unwatch = clock.watch((waiting) => seen.push(waiting))
  const a = clock.pause()
  const b = clock.pause()
  a()
  b()
  unwatch()
  clock.pause()()
  assert.deepEqual(seen, [true, false])
})

// ── deadlineSignal ──────────────────────────────────────────────────────────

test('deadlineSignal: without a limit it is the outer signal itself', () => {
  const outer = new AbortController().signal
  for (const ms of [undefined, 0, -1, Number.NaN, Infinity]) {
    assert.equal(deadlineSignal(createWaitClock(), outer, ms).signal, outer)
  }
  assert.equal(deadlineSignal(createWaitClock(), undefined, 0).signal, undefined)
})

test('deadlineSignal: the limit aborts with a TimeoutError, as AbortSignal.timeout does', (t) => {
  const tick = fakeTime(t)
  const { signal } = deadlineSignal(createWaitClock(), undefined, 30)
  tick(29)
  assert.equal(signal?.aborted, false)
  tick(1)
  assert.equal(signal?.aborted, true)
  assert.equal((signal?.reason as Error).name, 'TimeoutError')
})

test('deadlineSignal: the limit does not run while the clock is paused', (t) => {
  const tick = fakeTime(t)
  const clock = createWaitClock()
  const { signal } = deadlineSignal(clock, undefined, 100)
  tick(70)
  const resume = clock.pause()
  tick(60_000)
  assert.equal(signal?.aborted, false, 'the wait counted against the limit')
  resume()
  tick(29)
  assert.equal(signal?.aborted, false)
  tick(1)
  assert.equal(signal?.aborted, true)
})

test('deadlineSignal: a stop is passed on at once - paused or not - with its own reason', (t) => {
  fakeTime(t)
  const clock = createWaitClock()
  const outer = new AbortController()
  const { signal } = deadlineSignal(clock, outer.signal, 100)
  clock.pause()
  const stop = new Error('stopped by the user')
  outer.abort(stop)
  assert.equal(signal?.aborted, true, 'the stop waited for the clock')
  assert.equal(signal?.reason, stop)
  // Already stopped: aborted from the start.
  const gone = deadlineSignal(clock, AbortSignal.abort(stop), 100)
  assert.equal(gone.signal?.reason, stop)
})

test('deadlineSignal: done() takes the limit down', (t) => {
  const tick = fakeTime(t)
  const { signal, done } = deadlineSignal(createWaitClock(), undefined, 10)
  done()
  tick(100)
  assert.equal(signal?.aborted, false)
})

// ── followClock ─────────────────────────────────────────────────────────────

test('followClock: the follower stops while the leader does, until it is let go', (t) => {
  const tick = fakeTime(t)
  const leader = createWaitClock()
  const follower = createWaitClock()
  let fired = 0
  follower.timer(50, () => (fired += 1))
  const unfollow = followClock(follower, leader)
  assert.equal(follower.paused, false)
  const resume = leader.pause()
  assert.equal(follower.paused, true)
  tick(1000)
  resume()
  assert.equal(follower.paused, false)
  // Let go while the leader is paused: the follower runs again.
  const again = leader.pause()
  unfollow()
  assert.equal(follower.paused, false)
  again()
  tick(50)
  assert.equal(fired, 1)
  // Following a leader that is paused already stops at once.
  const held = leader.pause()
  const late = followClock(follower, leader)
  assert.equal(follower.paused, true)
  late()
  held()
  assert.equal(follower.paused, false)
})

// ── the waits of a subagent, from its events ────────────────────────────────

test('humanWaitOf: the four events of a question, paired by id - through any number of subagents', () => {
  assert.deepEqual(humanWaitOf({ type: 'tool.approval-requested', id: 'a' }), {
    key: 'approval:a',
    waiting: true,
  })
  assert.deepEqual(humanWaitOf({ type: 'tool.approval-resolved', id: 'a' }), {
    key: 'approval:a',
    waiting: false,
  })
  assert.deepEqual(humanWaitOf({ type: 'mcp.elicitation-requested', id: 'e' }), {
    key: 'elicitation:e',
    waiting: true,
  })
  assert.deepEqual(humanWaitOf({ type: 'mcp.elicitation-answered', id: 'e' }), {
    key: 'elicitation:e',
    waiting: false,
  })
  const nested = {
    type: 'subagent.event',
    id: 's1',
    event: {
      type: 'subagent.event',
      id: 's2',
      event: { type: 'tool.approval-requested', id: 'a' },
    },
  }
  assert.deepEqual(humanWaitOf(nested), { key: 's1/s2/approval:a', waiting: true })
  for (const other of [
    { type: 'step.tool-call', id: 'x' },
    { type: 'tool.approval-requested' },
    { type: 'subagent.event', id: 's', event: { type: 'usage' } },
    null,
    undefined,
    'tool.approval-requested',
  ]) {
    assert.equal(humanWaitOf(other), undefined)
  }
})

test('followHumanWaits: a question stops the clock until that same question is closed', () => {
  const clock = createWaitClock()
  const waits = followHumanWaits(clock)
  // Closed without being put (refused before anybody was asked): nothing changes.
  waits.see({ type: 'tool.approval-resolved', id: 'never-asked' })
  assert.equal(clock.paused, false)
  waits.see({ type: 'tool.approval-requested', id: 'a' })
  waits.see({ type: 'tool.approval-requested', id: 'a' })
  waits.see({
    type: 'subagent.event',
    id: 's',
    event: { type: 'mcp.elicitation-requested', id: 'a' },
  })
  assert.equal(clock.paused, true)
  waits.see({ type: 'tool.approval-resolved', id: 'a' })
  assert.equal(clock.paused, true, 'another question is still open')
  waits.see({
    type: 'subagent.event',
    id: 's',
    event: { type: 'mcp.elicitation-answered', id: 'a' },
  })
  assert.equal(clock.paused, false, 'the same id twice counted as one wait twice')
  // A subagent that ends with a question open (aborted, its worker gone) lets the clock go.
  waits.see({ type: 'mcp.elicitation-requested', id: 'b' })
  assert.equal(clock.paused, true)
  waits.end()
  assert.equal(clock.paused, false)
})
