import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createMcpListenSupervisor,
  MCP_LISTEN_MAX_ATTEMPTS,
  MCP_LISTEN_RETRY_BASE_MS,
  MCP_LISTEN_RETRY_MAX_MS,
  MCP_LISTEN_STABLE_MS,
  mcpListenFinalReason,
  mcpListenRetryDelay,
  type McpListenSubscription,
} from '../src/mcp-listen.ts'
import { useListenTime } from './helpers/listen-time.ts'

// The rules that keep a 2026-07-28 `subscriptions/listen` stream open (src/mcp-listen.ts, a copy
// of the browser package's src/mcp/listen.ts), on fakes: the listen call is a promise the test
// settles, the timers are a list the test fires. The connectors' wiring is tested against real
// servers in tests/mcp-protocol.test.ts (here and in the browser package).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

test('mcp-listen: the browser package carries the same file, byte for byte', () => {
  const sibling = here('../../agent-web/src/mcp/listen.ts')
  // Only in the monorepo: the published package has no sibling to compare with.
  if (!existsSync(sibling)) return
  assert.equal(
    readFileSync(here('../src/mcp-listen.ts'), 'utf8'),
    readFileSync(sibling, 'utf8'),
    'mcp-listen.ts and agent-web/src/mcp/listen.ts must stay identical',
  )
})

test('mcp-listen: pure, no imports', () => {
  const source = readFileSync(here('../src/mcp-listen.ts'), 'utf8')
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /\brequire\(|\bimport\(/)
})

// ── the delay ───────────────────────────────────────────────────────────────

test('mcpListenRetryDelay: doubles from the base, capped, and the jitter only takes off up to half', () => {
  const full = (attempt: number): number => mcpListenRetryDelay(attempt, () => 0)
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(full),
    [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000],
  )
  assert.equal(MCP_LISTEN_RETRY_BASE_MS, 1_000)
  assert.equal(MCP_LISTEN_RETRY_MAX_MS, 60_000)
  // The most the jitter takes: half.
  assert.equal(
    mcpListenRetryDelay(1, () => 0.999_999),
    500,
  )
  assert.equal(
    mcpListenRetryDelay(7, () => 0.999_999),
    30_000,
  )
  assert.equal(
    mcpListenRetryDelay(3, () => 0.5),
    3_000,
  )
  // Never more than the schedule, never less than half of it, whatever the source returns.
  for (const drawn of [-1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    const delay = mcpListenRetryDelay(2, () => drawn)
    assert.ok(delay >= 1_000 && delay <= 2_000, `${drawn} -> ${delay}`)
  }
  // A huge attempt number does not overflow past the cap; zero and less are the first delay.
  assert.equal(full(10_000), 60_000)
  assert.equal(full(0), 1_000)
  assert.equal(full(-3), 1_000)
  for (let i = 0; i < 200; i += 1) {
    const delay = mcpListenRetryDelay(4)
    assert.ok(delay >= 4_000 && delay <= 8_000, `Math.random: ${delay}`)
  }
})

// ── what is final ─────────────────────────────────────────────────────────────

test('mcpListenFinalReason: auth, "not offered" and a closed client are final; anything else is retried', () => {
  // The SDK's shapes, built by hand (a second copy of the SDK is another class).
  const http = (status: number) =>
    Object.assign(new Error(`Error POSTing to endpoint: ${status}`), {
      name: 'SdkHttpError',
      code: 'CLIENT_HTTP_NOT_IMPLEMENTED',
      status,
    })
  const protocol = (code: number) =>
    Object.assign(new Error(`MCP error ${code}`), { name: 'ProtocolError', code })
  const sdk = (code: string) => Object.assign(new Error(code), { name: 'SdkError', code })
  const unauthorized = Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' })

  for (const err of [http(401), http(403), unauthorized]) {
    assert.equal(mcpListenFinalReason(err), 'the server refused the authorization', err.message)
  }
  for (const err of [
    http(404),
    http(405),
    protocol(-32601),
    sdk('METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION'),
  ]) {
    assert.equal(
      mcpListenFinalReason(err),
      'the server does not offer subscriptions/listen',
      err.message,
    )
  }
  assert.equal(mcpListenFinalReason(protocol(-32602)), 'the server refused the request')
  assert.equal(mcpListenFinalReason(sdk('NOT_CONNECTED')), 'the connection is closed')

  for (const err of [
    http(500),
    http(502),
    http(503),
    http(429),
    http(400),
    protocol(-32603), // the SDK server's "Subscription limit reached": capacity comes back
    protocol(-32000),
    sdk('REQUEST_TIMEOUT'), // the acknowledgement did not come in time
    sdk('CONNECTION_CLOSED'), // e.g. the server's result before the acknowledgement
    new TypeError('fetch failed'),
    new Error('subscriptions/listen: stream ended'),
    'a string',
    undefined,
    null,
    42,
  ]) {
    assert.equal(mcpListenFinalReason(err), undefined, String((err as Error)?.message ?? err))
  }
  // The status is the HTTP error's own, never something a server put in an error's `data`.
  assert.equal(
    mcpListenFinalReason(Object.assign(protocol(-32000), { data: { status: 401 } })),
    undefined,
  )
})

// ── the supervisor, on fakes ──────────────────────────────────────────────────

interface IFakeTimer {
  ms: number
  fire: () => void
  state: 'pending' | 'cancelled' | 'fired'
  /** The stability timer is the one set when a stream is acknowledged; the others are retries. */
  kind: 'retry' | 'stable'
}

interface IAttempt {
  signal: AbortSignal
  resolve: (subscription: McpListenSubscription) => void
  reject: (err: unknown) => void
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const harness = (options: { random?: () => number; onResubscribed?: () => void } = {}) => {
  const timers: IFakeTimer[] = []
  const attempts: IAttempt[] = []
  const logs: string[] = []
  let resubscribed = 0
  const supervisor = createMcpListenSupervisor({
    server: 'wx',
    listen: (signal) =>
      new Promise<McpListenSubscription>((resolve, reject) => {
        attempts.push({ signal, resolve, reject })
      }),
    timer: (ms, fire) => {
      const timer: IFakeTimer = { ms, fire, state: 'pending', kind: 'retry' }
      timers.push(timer)
      return {
        cancel: () => {
          if (timer.state === 'pending') timer.state = 'cancelled'
        },
      }
    },
    log: (level, message) => logs.push(`${level} ${message}`),
    onResubscribed: () => {
      resubscribed += 1
      options.onResubscribed?.()
    },
    random: options.random ?? (() => 0),
  })
  const pending = (): IFakeTimer[] => timers.filter((t) => t.state === 'pending')
  /** The one pending retry (not the stability timer): fire it. */
  const fireRetry = async (): Promise<number> => {
    const retry = pending().filter((t) => t.kind === 'retry')
    assert.equal(retry.length, 1, 'exactly one retry pending')
    retry[0].state = 'fired'
    retry[0].fire()
    await flush()
    return retry[0].ms
  }
  const fireStable = async (): Promise<void> => {
    const stable = pending().filter((t) => t.kind === 'stable')
    assert.equal(stable.length, 1, 'exactly one stability timer pending')
    stable[0].state = 'fired'
    stable[0].fire()
    await flush()
  }
  /** Acknowledge the latest attempt; returns what ends the stream. */
  const ack = async (
    honoredFilter: { toolsListChanged?: boolean } = { toolsListChanged: true },
  ): Promise<(cause: 'local' | 'graceful' | 'remote') => Promise<void>> => {
    let end!: (cause: 'local' | 'graceful' | 'remote') => void
    const closed = new Promise<'local' | 'graceful' | 'remote'>((resolve) => {
      end = resolve
    })
    const before = timers.length
    attempts.at(-1)?.resolve({ honoredFilter, closed })
    await flush()
    for (const timer of timers.slice(before)) {
      assert.equal(timer.ms, MCP_LISTEN_STABLE_MS)
      timer.kind = 'stable'
    }
    return async (cause) => {
      end(cause)
      await flush()
    }
  }
  const fail = async (err: unknown): Promise<void> => {
    attempts.at(-1)?.reject(err)
    await flush()
  }
  const warns = (): string[] => logs.filter((l) => l.startsWith('warn '))
  return {
    supervisor,
    timers,
    attempts,
    logs,
    warns,
    pending,
    fireRetry,
    fireStable,
    ack,
    fail,
    get resubscribed() {
      return resubscribed
    },
  }
}

const unavailable = Object.assign(new Error('Error POSTing to endpoint: upstream unavailable'), {
  name: 'SdkHttpError',
  status: 503,
})
const notFound = Object.assign(new Error('Error POSTing to endpoint: Method not found'), {
  name: 'SdkHttpError',
  status: 404,
})

test('supervisor: a dropped stream is opened again after the first delay, and the tool list is reported changed once', async () => {
  const h = harness()
  const start = h.supervisor.start()
  const end = await h.ack()
  await start
  assert.equal(h.attempts.length, 1)
  assert.equal(h.resubscribed, 0, 'the first stream is no recovery: the list is read after it')
  assert.deepEqual(h.logs, [])
  assert.deepEqual(
    h.pending().map((t) => t.ms),
    [MCP_LISTEN_STABLE_MS],
  )

  await end('remote')
  assert.deepEqual(h.warns(), [
    'warn [mcp] wx: the tool list change stream ended (dropped); listening again in 1.0 s (attempt 1 of 10)',
  ])
  assert.deepEqual(
    h.pending().map((t) => t.ms),
    [1_000],
    'the stability timer went with the stream',
  )
  assert.equal(await h.fireRetry(), 1_000)
  assert.equal(h.attempts.length, 2)
  assert.equal(h.resubscribed, 0, 'not before the acknowledgement')
  await h.ack()
  assert.equal(h.resubscribed, 1)
  assert.deepEqual(
    h.logs.at(-1),
    'info [mcp] wx: listening for tool list changes again (attempt 1); the tool list is read again',
  )
  assert.equal(h.warns().length, 1, 'one warning for the one drop')

  h.supervisor.stop()
  assert.deepEqual(h.pending(), [], 'nothing pending after stop')
})

test('supervisor: a stream the server closed with its result is opened again too, said as such', async () => {
  const h = harness()
  const start = h.supervisor.start()
  const end = await h.ack()
  await start
  await end('graceful')
  assert.deepEqual(h.warns(), [
    'warn [mcp] wx: the tool list change stream ended (closed by the server); listening again in 1.0 s (attempt 1 of 10)',
  ])
  await h.fireRetry()
  await h.ack()
  assert.equal(h.resubscribed, 1)
  h.supervisor.stop()
})

test('supervisor: failed attempts back off, and the count is reset only by a stream that stayed up', async () => {
  const h = harness()
  const start = h.supervisor.start()
  let end = await h.ack()
  await start
  await end('remote')
  const delays: number[] = []
  // Three failures in a row: 1 s, 2 s, 4 s, then 8 s.
  delays.push(await h.fireRetry())
  await h.fail(unavailable)
  delays.push(await h.fireRetry())
  await h.fail(unavailable)
  delays.push(await h.fireRetry())
  await h.fail(unavailable)
  delays.push(await h.fireRetry())
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000])
  assert.deepEqual(h.warns().slice(1), [
    'warn [mcp] wx: could not subscribe to tool list changes - Error POSTing to endpoint: upstream unavailable; listening again in 2.0 s (attempt 2 of 10)',
    'warn [mcp] wx: could not subscribe to tool list changes - Error POSTing to endpoint: upstream unavailable; listening again in 4.0 s (attempt 3 of 10)',
    'warn [mcp] wx: could not subscribe to tool list changes - Error POSTing to endpoint: upstream unavailable; listening again in 8.0 s (attempt 4 of 10)',
  ])
  // The fourth attempt is acknowledged - and lost at once: the count goes on (a flapping server
  // is not a fresh start each time).
  end = await h.ack()
  assert.equal(h.resubscribed, 1)
  await end('remote')
  assert.equal(await h.fireRetry(), 16_000)
  end = await h.ack()
  assert.equal(h.resubscribed, 2)
  // This one stays up long enough: the next loss starts from the first delay again.
  await h.fireStable()
  await end('remote')
  assert.equal(await h.fireRetry(), 1_000)
  assert.match(h.warns().at(-1) ?? '', /\(attempt 1 of 10\)$/)
  h.supervisor.stop()
})

test('supervisor: the jitter is taken off the schedule, and the log says the delay it chose', async () => {
  const h = harness({ random: () => 0.5 })
  const start = h.supervisor.start()
  const end = await h.ack()
  await start
  await end('remote')
  assert.equal(await h.fireRetry(), 750)
  assert.match(h.warns()[0], /listening again in 0\.8 s \(attempt 1 of 10\)$/)
  await h.fail(unavailable)
  assert.equal(await h.fireRetry(), 1_500)
  h.supervisor.stop()
})

test(`supervisor: gives up after ${MCP_LISTEN_MAX_ATTEMPTS} attempts in a row, with one warning, and nothing is left pending`, async () => {
  const h = harness()
  const start = h.supervisor.start()
  const end = await h.ack()
  await start
  await end('remote')
  const delays: number[] = []
  for (let i = 0; i < MCP_LISTEN_MAX_ATTEMPTS; i += 1) {
    delays.push(await h.fireRetry())
    await h.fail(unavailable)
  }
  assert.deepEqual(
    delays,
    [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000],
  )
  assert.equal(h.attempts.length, 1 + MCP_LISTEN_MAX_ATTEMPTS)
  assert.deepEqual(h.pending(), [], 'no retry after the last one')
  const warns = h.warns()
  assert.equal(
    warns.length,
    MCP_LISTEN_MAX_ATTEMPTS + 1,
    'one per loss or failure, and one to give up',
  )
  assert.equal(
    warns.at(-1),
    'warn [mcp] wx: could not subscribe to tool list changes - Error POSTing to endpoint: upstream unavailable; gave up after 10 attempts in a row - tool list changes are not announced until the server is connected again (refreshServer still re-lists)',
  )
  assert.equal(warns.filter((w) => w.includes('gave up')).length, 1)
  assert.equal(h.resubscribed, 0)
})

test('supervisor: a flapping server (acknowledged, then lost at once) is given up on too', async () => {
  const h = harness()
  const start = h.supervisor.start()
  let end = await h.ack()
  await start
  for (let i = 0; i < MCP_LISTEN_MAX_ATTEMPTS; i += 1) {
    await end('graceful')
    await h.fireRetry()
    end = await h.ack()
  }
  await end('graceful')
  assert.deepEqual(h.pending(), [])
  assert.equal(h.attempts.length, 1 + MCP_LISTEN_MAX_ATTEMPTS)
  assert.match(h.warns().at(-1) ?? '', /closed by the server\); gave up after 10 attempts in a row/)
  assert.equal(h.resubscribed, MCP_LISTEN_MAX_ATTEMPTS)
})

test('supervisor: a final error stops at once - at the start, or at a retry', async () => {
  const atStart = harness()
  const start = atStart.supervisor.start()
  await atStart.fail(notFound)
  await start
  assert.deepEqual(atStart.pending(), [])
  assert.deepEqual(atStart.warns(), [
    'warn [mcp] wx: could not subscribe to tool list changes - Error POSTing to endpoint: Method not found; not tried again: the server does not offer subscriptions/listen',
  ])

  const later = harness()
  const begun = later.supervisor.start()
  const end = await later.ack()
  await begun
  await end('remote')
  await later.fireRetry()
  await later.fail(Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' }))
  assert.deepEqual(later.pending(), [])
  assert.equal(later.attempts.length, 2)
  assert.equal(
    later.warns().at(-1),
    'warn [mcp] wx: could not subscribe to tool list changes - Unauthorized; not tried again: the server refused the authorization',
  )
})

test('supervisor: a first attempt that fails for a passing reason is retried, and its success reported', async () => {
  const h = harness()
  const start = h.supervisor.start()
  await h.fail(
    Object.assign(new Error('subscriptions/listen ack timed out'), { code: 'REQUEST_TIMEOUT' }),
  )
  await start
  assert.deepEqual(h.warns(), [
    'warn [mcp] wx: could not subscribe to tool list changes - subscriptions/listen ack timed out; listening again in 1.0 s (attempt 1 of 10)',
  ])
  await h.fireRetry()
  await h.ack()
  // The tool list was read without a stream: what changed since was announced to nobody.
  assert.equal(h.resubscribed, 1)
  h.supervisor.stop()
})

test('supervisor: an acknowledgement without toolsListChanged ends it, quietly and for good', async () => {
  const h = harness()
  const start = h.supervisor.start()
  await h.ack({})
  await start
  assert.equal(h.attempts[0].signal.aborted, true, 'the useless stream is closed')
  assert.deepEqual(h.pending(), [])
  assert.deepEqual(h.logs, [
    'info [mcp] wx: the server did not agree to announce tool list changes',
  ])
})

test('supervisor: stop takes down a pending retry', async () => {
  const h = harness()
  const start = h.supervisor.start()
  const end = await h.ack()
  await start
  await end('remote')
  assert.equal(h.pending().length, 1)
  h.supervisor.stop()
  assert.deepEqual(h.pending(), [])
  assert.equal(h.timers.at(-1)?.state, 'cancelled')
  h.supervisor.stop()
})

test('supervisor: stop gives up an attempt in flight, and its end is neither logged nor retried', async () => {
  const h = harness()
  const start = h.supervisor.start()
  const end = await h.ack()
  await start
  await end('remote')
  await h.fireRetry()
  const inFlight = h.attempts.at(-1) as IAttempt
  assert.equal(inFlight.signal.aborted, false)
  const before = h.logs.length
  h.supervisor.stop()
  assert.equal(inFlight.signal.aborted, true)
  await h.fail(new Error('aborted'))
  assert.equal(h.logs.length, before)
  assert.deepEqual(h.pending(), [])
  // An acknowledgement that was already on its way changes nothing either.
  inFlight.resolve({ honoredFilter: { toolsListChanged: true }, closed: new Promise(() => {}) })
  await flush()
  assert.deepEqual(h.pending(), [])
  assert.equal(h.resubscribed, 0)
})

test('supervisor: stop leaves an open stream to the connection, and its end afterwards is not a drop', async () => {
  const h = harness()
  const start = h.supervisor.start()
  const end = await h.ack()
  await start
  h.supervisor.stop()
  assert.equal(h.attempts[0].signal.aborted, false, 'no extra request: the client close ends it')
  assert.deepEqual(h.pending(), [], 'the stability timer is down')
  // The client's own close ends the stream as `remote` (the SDK resets its listen state).
  await end('remote')
  assert.deepEqual(h.logs, [])
  assert.deepEqual(h.pending(), [])
  // Stopped before it started: nothing at all.
  const never = harness()
  never.supervisor.stop()
  await never.supervisor.start()
  assert.equal(never.attempts.length, 0)
})

test('supervisor: start is once; a callback that throws is logged and the stream is kept', async () => {
  const h = harness({
    onResubscribed: () => {
      throw new Error('host bug')
    },
  })
  const start = h.supervisor.start()
  const end = await h.ack()
  await start
  await h.supervisor.start()
  assert.equal(h.attempts.length, 1)
  await end('remote')
  await h.fireRetry()
  await h.ack()
  assert.equal(h.resubscribed, 1)
  assert.equal(h.logs.at(-1), 'warn [mcp] wx: the tool list change callback failed - host bug')
  assert.deepEqual(
    h.pending().map((t) => t.ms),
    [MCP_LISTEN_STABLE_MS],
  )
  h.supervisor.stop()
})

test('supervisor: a stream that ends while a "local" close is reported is not retried', async () => {
  const h = harness()
  const start = h.supervisor.start()
  const end = await h.ack()
  await start
  await end('local')
  assert.deepEqual(h.pending(), [])
  assert.deepEqual(h.logs, [])
})

test('supervisor: without a timer of its own it uses the test seam when one is set (and setTimeout otherwise)', async (t) => {
  const time = useListenTime(t)
  const logs: string[] = []
  let end!: (cause: 'local' | 'graceful' | 'remote') => void
  const supervisor = createMcpListenSupervisor({
    server: 'wx',
    listen: async () => ({
      honoredFilter: { toolsListChanged: true },
      closed: new Promise((resolve) => {
        end = resolve
      }),
    }),
    log: (level, message) => logs.push(`${level} ${message}`),
    onResubscribed: () => {},
    random: () => 0,
  })
  await supervisor.start()
  assert.equal(time.running, 1, 'the stability timer, on the seam')
  end('remote')
  await flush()
  assert.equal(time.running, 1, 'the retry, on the seam')
  time.tick(1_000)
  await flush()
  assert.match(logs.at(-1) ?? '', /listening for tool list changes again \(attempt 1\)/)
  supervisor.stop()
  assert.equal(time.running, 0)
})
