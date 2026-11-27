// 2026-07-28: the `subscriptions/listen` stream that carries a server's tool list change notices,
// kept open for the life of the connection.
//
// That revision has no stream a server may write to unasked: `notifications/tools/list_changed`
// arrives only on a `subscriptions/listen` stream the client opened, and the SDK does not open it
// again when it ends. This file does, with backoff, and once a stream is back it reports the tool
// list as changed - a change made while no stream was open was announced to nobody - through the
// same callback the notice itself calls, so whoever listens sees exactly what a notice causes.
//
// - Retried: a stream that DROPPED (no result: "an unexpected disconnect, which the client MAY
//   treat as a trigger to reconnect") and one the server CLOSED with its result (the server's own
//   initiative, "for example, during shutdown": on a stateless revision the process that ends a
//   subscription is not the service - the next request may reach another - and a server that no
//   longer takes listeners says so to the next attempt, which is final). A failed attempt is
//   retried too, unless its error is final.
// - Final, never retried: 401 / 403 (authorization is the OAuth flow's job, not a loop's), 404 /
//   405 / -32601 (the server does not offer the method), -32602 (it refuses the request as made),
//   a client that is not connected, and an acknowledgement that leaves `toolsListChanged` out.
// - The delay before attempt n: MCP_LISTEN_RETRY_BASE_MS doubled n - 1 times, at most
//   MCP_LISTEN_RETRY_MAX_MS, less a random share of up to half (so many clients that lost one
//   server do not come back in step). The count goes back to zero only when a stream stayed up
//   MCP_LISTEN_STABLE_MS: a stream that is acknowledged and lost at once counts against it, so a
//   flapping server is tried MCP_LISTEN_MAX_ATTEMPTS times in a row and then given up on.
// - Logs: one `warn` per end or failed attempt (the attempt and the delay; past the last attempt
//   the same line says it gave up), one `info` when a stream is back. Nothing after `stop()`.
// - `stop()` takes down a pending retry and the stability timer and gives up an attempt in
//   flight. An acknowledged stream is ended by the connection's own close (no extra request).
//
// Pure, no imports: the listen call and the log are given; the timers are `setTimeout`'s, or a
// test's through the seam below. This file is a COPY, byte for byte, of the sibling package's (Node: `@dudko.dev/agent` `src/mcp-listen.ts`, browser:
// `@dudko.dev/agent-web` `src/mcp/listen.ts`). Change both; `tests/mcp-listen.test.ts` of the
// Node package compares them.

/** The first delay: attempt 1 waits at most this long. */
export const MCP_LISTEN_RETRY_BASE_MS = 1_000
/** The longest delay between two attempts. */
export const MCP_LISTEN_RETRY_MAX_MS = 60_000
/** A stream that stayed up this long resets the count: the next loss starts at the first delay. */
export const MCP_LISTEN_STABLE_MS = 60_000
/** Attempts in a row (failed, or lost before they were stable) before this connection gives up. */
export const MCP_LISTEN_MAX_ATTEMPTS = 10

/** The SDK's `McpSubscription`, as far as this file reads it. */
export interface McpListenSubscription {
  /** The filter the server agreed to (its acknowledgement). */
  readonly honoredFilter: { toolsListChanged?: boolean }
  /** How the stream ended: `local` (this side), `graceful` (the server's result), `remote`. */
  readonly closed: Promise<'local' | 'graceful' | 'remote'>
}

export interface McpListenDeps {
  /** The server's name, for the log. */
  server: string
  /** Open one stream; resolves once the server acknowledged it. `signal` gives the attempt up. */
  listen: (signal: AbortSignal) => Promise<McpListenSubscription>
  /** Call `fire` after `ms`; the result takes the timer down. Default: `setTimeout` (or the seam). */
  timer?: (ms: number, fire: () => void) => { cancel: () => void }
  log: (level: 'info' | 'warn', message: string) => void
  /** A stream is open again after one ended or failed: report the tool list as changed. */
  onResubscribed: () => void
  /** The source of the jitter (default `Math.random`). */
  random?: () => number
}

export interface McpListenSupervisor {
  /** Open the first stream. Resolves once it was acknowledged, or the attempt failed. */
  start: () => Promise<void>
  /** For good: no retry, no log, nothing pending. Safe to call twice. */
  stop: () => void
}

/** The delay before attempt `attempt` (1, 2, ...), `random` in [0, 1) taking up to half off. */
export const mcpListenRetryDelay = (
  attempt: number,
  random: () => number = Math.random,
): number => {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  const full = Math.min(MCP_LISTEN_RETRY_MAX_MS, MCP_LISTEN_RETRY_BASE_MS * 2 ** exponent)
  const drawn = random()
  const share = Number.isFinite(drawn) ? Math.min(1, Math.max(0, drawn)) : 0
  return Math.round(full - (full / 2) * share)
}

/**
 * Why a failed attempt must not be made again, or `undefined` when it may be. Read structurally:
 * the SDK's `SdkHttpError.status`, `ProtocolError.code` (a number), `SdkError.code` (a string),
 * `UnauthorizedError`'s name - a second copy of the SDK is another class.
 */
export const mcpListenFinalReason = (err: unknown): string | undefined => {
  if (typeof err !== 'object' || err === null) return undefined
  const { name, status, code } = err as { name?: unknown; status?: unknown; code?: unknown }
  if (name === 'UnauthorizedError' || status === 401 || status === 403) {
    return 'the server refused the authorization'
  }
  if (
    status === 404 ||
    status === 405 ||
    code === -32601 ||
    code === 'METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION'
  ) {
    return 'the server does not offer subscriptions/listen'
  }
  if (code === -32602) return 'the server refused the request'
  if (code === 'NOT_CONNECTED') return 'the connection is closed'
  return undefined
}

/** Where the timers are set: the globals, looked up at each call (so mocked timers apply). */
interface McpListenTimeSource {
  set: (fire: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const REAL_TIME: McpListenTimeSource = {
  set: (fire, ms) => setTimeout(fire, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * A TEST seam, not an API: a test that puts a time source under this key of `globalThis` before
 * a connection is made moves this file's timers itself - the retry and the stability timer - so
 * the whole schedule runs on virtual time against real servers. A key of its own, not the wait
 * clock's (`wait-clock.ts`): that one is for the deadlines of runs, and its tests ask whether any
 * deadline is running, which a listen timer is not. Nothing exports it; it gives no power the
 * globals it stands for do not.
 */
const TEST_TIME = Symbol.for('@dudko.dev/agent:mcp-listen-test-time')

const timeSource = (): McpListenTimeSource => {
  const test = (globalThis as unknown as Record<symbol, Partial<McpListenTimeSource> | undefined>)[
    TEST_TIME
  ]
  return typeof test?.set === 'function' && typeof test.clear === 'function'
    ? (test as McpListenTimeSource)
    : REAL_TIME
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const createMcpListenSupervisor = (deps: McpListenDeps): McpListenSupervisor => {
  const { server, log } = deps
  const random = deps.random ?? Math.random
  // Read when the supervisor is made, as the wait clock reads its own seam.
  const time = timeSource()
  const timer =
    deps.timer ??
    ((ms: number, fire: () => void) => {
      const handle = time.set(fire, ms)
      return { cancel: () => time.clear(handle) }
    })
  let started = false
  let stopped = false
  // Attempts since the start, or since the last stream that stayed up MCP_LISTEN_STABLE_MS.
  let attempts = 0
  let retry: { cancel: () => void } | undefined
  let stable: { cancel: () => void } | undefined
  let inFlight: AbortController | undefined
  let current: McpListenSubscription | undefined

  // A stream ended or an attempt failed (`what` says which): the next attempt, or the end.
  const again = (what: string): void => {
    if (attempts >= MCP_LISTEN_MAX_ATTEMPTS) {
      log(
        'warn',
        `[mcp] ${server}: ${what}; gave up after ${attempts} attempts in a row - tool list changes are not announced until the server is connected again (refreshServer still re-lists)`,
      )
      return
    }
    attempts += 1
    const delay = mcpListenRetryDelay(attempts, random)
    log(
      'warn',
      `[mcp] ${server}: ${what}; listening again in ${seconds(delay)} (attempt ${attempts} of ${MCP_LISTEN_MAX_ATTEMPTS})`,
    )
    retry = timer(delay, () => {
      retry = undefined
      void open(true)
    })
  }

  const ended = (subscription: McpListenSubscription, cause: string): void => {
    if (stopped || current !== subscription) return
    current = undefined
    stable?.cancel()
    stable = undefined
    // Only this side closes a stream locally, and only when it is done with it.
    if (cause === 'local') return
    again(
      `the tool list change stream ended (${cause === 'graceful' ? 'closed by the server' : 'dropped'})`,
    )
  }

  const open = async (resubscribe: boolean): Promise<void> => {
    if (stopped) return
    const attempt = new AbortController()
    inFlight = attempt
    let subscription: McpListenSubscription
    try {
      subscription = await deps.listen(attempt.signal)
    } catch (err) {
      if (inFlight === attempt) inFlight = undefined
      if (stopped) return
      const final = mcpListenFinalReason(err)
      if (final) {
        log(
          'warn',
          `[mcp] ${server}: could not subscribe to tool list changes - ${messageOf(err)}; not tried again: ${final}`,
        )
        return
      }
      again(`could not subscribe to tool list changes - ${messageOf(err)}`)
      return
    }
    if (inFlight === attempt) inFlight = undefined
    // Stopped while the acknowledgement was on its way: `stop()` already gave the attempt up.
    if (stopped) return
    if (subscription.honoredFilter?.toolsListChanged !== true) {
      log('info', `[mcp] ${server}: the server did not agree to announce tool list changes`)
      attempt.abort()
      return
    }
    current = subscription
    stable = timer(MCP_LISTEN_STABLE_MS, () => {
      stable = undefined
      attempts = 0
    })
    subscription.closed.then(
      (cause) => ended(subscription, cause),
      () => ended(subscription, 'remote'),
    )
    if (resubscribe) {
      log(
        'info',
        `[mcp] ${server}: listening for tool list changes again (attempt ${attempts}); the tool list is read again`,
      )
      try {
        deps.onResubscribed()
      } catch (err) {
        log('warn', `[mcp] ${server}: the tool list change callback failed - ${messageOf(err)}`)
      }
    }
  }

  return {
    start: async () => {
      if (started || stopped) return
      started = true
      await open(false)
    },
    stop: () => {
      stopped = true
      retry?.cancel()
      retry = undefined
      stable?.cancel()
      stable = undefined
      inFlight?.abort()
      inFlight = undefined
      current = undefined
    },
  }
}
