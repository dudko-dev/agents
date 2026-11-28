// The stream cursor: <turn>:<attempt>:<seq>, bounded, strictly parsed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compareCursors,
  CURSOR_MAX_CHARS,
  CURSOR_PART_MAX,
  formatCursor,
  parseCursor,
  START_CURSOR,
} from '../src/cursor.ts'

test('absent or blank: from the start', () => {
  for (const raw of [undefined, null, '', '   ']) {
    assert.deepEqual(parseCursor(raw), { ok: true, cursor: START_CURSOR })
  }
})

test('three non-negative integers, round trip', () => {
  assert.deepEqual(parseCursor('3:1:17'), { ok: true, cursor: { turn: 3, attempt: 1, seq: 17 } })
  assert.deepEqual(parseCursor(' 0:0:0 '), { ok: true, cursor: { turn: 0, attempt: 0, seq: 0 } })
  const top = `1:${CURSOR_PART_MAX}:0`
  const parsed = parseCursor(top)
  assert.ok(parsed.ok)
  assert.equal(formatCursor(parsed.cursor), top)
})

test('anything else is refused, by name', () => {
  for (const raw of [
    '1:2',
    '1:2:3:4',
    '1::3',
    'a:b:c',
    '-1:0:0',
    '+1:0:0',
    '01:0:0',
    '1.5:0:0',
    '1e3:0:0',
    '0x1:0:0',
    `1:${CURSOR_PART_MAX + 1}:0`,
    '9999999999:0:0',
    `1:1:${'1'.repeat(CURSOR_MAX_CHARS)}`,
  ]) {
    const r = parseCursor(raw)
    assert.equal(r.ok, false, raw)
  }
})

test('order: turn, then attempt, then seq', () => {
  const c = (turn: number, attempt: number, seq: number) => ({ turn, attempt, seq })
  const sorted = [c(2, 0, 0), c(1, 2, 1), c(1, 1, 9), c(1, 2147483647, 0), c(1, 0, 0)].sort(
    compareCursors,
  )
  assert.deepEqual(sorted.map(formatCursor), ['1:0:0', '1:1:9', '1:2:1', '1:2147483647:0', '2:0:0'])
})
