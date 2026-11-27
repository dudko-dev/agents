// Time limits that do not count the time a HUMAN takes.
//
// A step's limit (`llmTimeoutMs` / `chatTimeoutMs`) and a subagent's (`timeoutMs`) are about the
// latency of models and tools. While a tool call waits for a person - a tool approval, an MCP
// elicitation - the clock those limits run on is stopped, and when the person has answered it
// goes on with the time it had left: never with a full limit again, and never with more than the
// length of the wait added. The wait keeps a bound of its own (`toolApproval.timeoutMs`,
// `elicitation.timeoutMs`), which is NOT on this clock, and a stop of the run still ends
// everything at once: a clock only keeps time, it never holds an abort back.
//
// One clock per run. Its deadlines are the run's step limit and the time limits of the subagents
// its tool calls run; whoever asks a person a question pauses it for the length of the wait. A
// subagent runs on a clock of its own, and the tool that started it follows its events
// (`followHumanWaits`), so the caller's clock stops for as long as anything below it waits. A
// subagent waiting on a tool that runs in the calling run follows the caller's clock
// (`followClock`) for as long as that tool call is in flight.
//
// The deadlines run on `Date.now` and `setTimeout` - unless a TEST put a time source of its own
// on `globalThis` (`TEST_TIME`, below): the human-wait tests move the limits themselves that way,
// so how loaded the machine is never decides a result.
//
// Pure, no imports: this file is a COPY, byte for byte, of the sibling package's wait clock
// (Node: `@dudko.dev/agent` `src/wait-clock.ts`, browser: `@dudko.dev/agent-web`
// `src/wait-clock.ts`). Change both; `tests/wait-clock.test.ts` of the Node package compares them.

/** One deadline of a clock. */
export interface IWaitTimer {
  /** Take the deadline down; it will not fire. Safe to call twice, and after it fired. */
  cancel: () => void
  /** Milliseconds of running time left before it fires (0 once it fired or was cancelled). */
  left: () => number
}

export interface IWaitClock {
  /**
   * Stop the clock: a person is being asked. Returns what starts it again, to be called exactly
   * when the wait is over (a second call does nothing). Waits may overlap - the clock runs
   * again when the last of them is over.
   */
  pause: () => () => void
  /** Whether a wait is going on. */
  readonly paused: boolean
  /**
   * Call `onExpire` after `ms` of this clock's RUNNING time. `unref`: do not keep a Node
   * process alive for it (as `AbortSignal.timeout` does not).
   */
  timer: (ms: number, onExpire: () => void, options?: { unref?: boolean }) => IWaitTimer
  /**
   * Be told when the clock stops (`true`) and when it runs again (`false`). Returns what ends
   * the subscription.
   */
  watch: (listener: (waiting: boolean) => void) => () => void
}

interface IEntry {
  start: () => void
  stop: () => void
}

/** Where a clock reads the time and sets its timers. */
interface ITimeSource {
  now: () => number
  set: (fire: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

/** The real time: the globals, looked up at each call (so mocked timers apply). */
const REAL_TIME: ITimeSource = {
  now: () => Date.now(),
  set: (fire, ms) => setTimeout(fire, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * A TEST seam, not an API: a test that puts a time source under this key of `globalThis` before
 * a run moves the deadlines of the clocks made meanwhile itself - the step limits and the
 * subagents' limits - while everything else (the model, sockets, workers, the waits' own bounds,
 * a host's `AbortSignal.timeout`) keeps real time. Nothing exports it and nothing documents it
 * for hosts; it gives no power the globals it stands for do not (whoever can set it can replace
 * `Date.now` and `setTimeout` as well).
 */
const TEST_TIME = Symbol.for('@dudko.dev/agent:wait-clock-test-time')

const timeSource = (): ITimeSource => {
  const test = (globalThis as unknown as Record<symbol, Partial<ITimeSource> | undefined>)[
    TEST_TIME
  ]
  return typeof test?.now === 'function' &&
    typeof test.set === 'function' &&
    typeof test.clear === 'function'
    ? (test as ITimeSource)
    : REAL_TIME
}

export const createWaitClock = (): IWaitClock => {
  const time = timeSource()
  let waits = 0
  const entries = new Set<IEntry>()
  const watchers = new Set<(waiting: boolean) => void>()
  const tell = (waiting: boolean): void => {
    for (const watcher of [...watchers]) {
      try {
        watcher(waiting)
      } catch {
        // A listener's failure is not the clock's.
      }
    }
  }
  return {
    get paused() {
      return waits > 0
    },
    pause: () => {
      let over = false
      waits += 1
      if (waits === 1) {
        for (const entry of [...entries]) {
          entry.stop()
        }
        tell(true)
      }
      return () => {
        if (over) {
          return
        }
        over = true
        waits -= 1
        if (waits === 0) {
          for (const entry of [...entries]) {
            entry.start()
          }
          tell(false)
        }
      }
    },
    timer: (ms, onExpire, options) => {
      let left = Math.max(0, ms)
      let startedAt = 0
      let handle: unknown
      let ended = false
      // Time that ran since the deadline last started (never negative: a wall clock set back
      // must not give a deadline more time).
      const ran = (): number => Math.max(0, time.now() - startedAt)
      const entry: IEntry = {
        start: () => {
          if (ended || handle !== undefined) {
            return
          }
          startedAt = time.now()
          handle = time.set(() => {
            handle = undefined
            ended = true
            left = 0
            entries.delete(entry)
            onExpire()
          }, left)
          if (options?.unref) {
            ;(handle as { unref?: () => void } | undefined)?.unref?.()
          }
        },
        stop: () => {
          if (handle === undefined) {
            return
          }
          time.clear(handle)
          handle = undefined
          // What is left is what was left when it started, less the time it ran.
          left = Math.max(0, left - ran())
        },
      }
      entries.add(entry)
      if (waits === 0) {
        entry.start()
      }
      return {
        cancel: () => {
          if (handle !== undefined) {
            time.clear(handle)
            handle = undefined
          }
          if (!ended) {
            ended = true
            left = 0
            entries.delete(entry)
          }
        },
        left: () => (ended ? 0 : handle === undefined ? left : Math.max(0, left - ran())),
      }
    },
    watch: (listener) => {
      watchers.add(listener)
      return () => {
        watchers.delete(listener)
      }
    },
  }
}

/** What `AbortSignal.timeout` aborts with: the same name, so a caller cannot tell them apart. */
const timeoutError = (): unknown => {
  const message = 'The operation was aborted due to timeout'
  const Ctor = (globalThis as { DOMException?: new (message: string, name: string) => unknown })
    .DOMException
  if (typeof Ctor === 'function') {
    return new Ctor(message, 'TimeoutError')
  }
  const err = new Error(message)
  err.name = 'TimeoutError'
  return err
}

export interface IDeadlineSignal {
  /** Aborts when `outer` does (with its reason) or when the limit is spent (a TimeoutError). */
  signal: AbortSignal | undefined
  /** The call is over: take the deadline down. */
  done: () => void
}

/**
 * `outer` with a time limit of `ms` on `clock`: what `AbortSignal.any([outer,
 * AbortSignal.timeout(ms)])` is, except that the limit does not run while the clock is paused.
 * Without a limit (`ms` absent, 0, negative or not finite) the signal is `outer` itself; without
 * a clock the limit is never paused. An abort of `outer` is passed on at once, paused or not.
 */
export const deadlineSignal = (
  clock: IWaitClock | undefined,
  outer: AbortSignal | undefined,
  ms: number | undefined,
): IDeadlineSignal => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return { signal: outer, done: () => {} }
  }
  const controller = new AbortController()
  let timer: IWaitTimer | undefined
  const onOuter = (): void => {
    timer?.cancel()
    controller.abort(outer?.reason)
  }
  if (outer?.aborted) {
    onOuter()
    return { signal: controller.signal, done: () => {} }
  }
  timer = (clock ?? createWaitClock()).timer(
    ms,
    () => {
      outer?.removeEventListener('abort', onOuter)
      controller.abort(timeoutError())
    },
    { unref: true },
  )
  outer?.addEventListener('abort', onOuter, { once: true })
  return {
    signal: controller.signal,
    done: () => {
      timer?.cancel()
      outer?.removeEventListener('abort', onOuter)
    },
  }
}

/**
 * Keep `follower` stopped whenever `leader` is (now, if it already is), until the returned
 * function is called - which also starts `follower` again if it was holding it.
 */
export const followClock = (follower: IWaitClock, leader: IWaitClock): (() => void) => {
  let resume: (() => void) | undefined = leader.paused ? follower.pause() : undefined
  const unwatch = leader.watch((waiting) => {
    if (waiting) {
      resume ??= follower.pause()
      return
    }
    const r = resume
    resume = undefined
    r?.()
  })
  return () => {
    unwatch()
    const r = resume
    resume = undefined
    r?.()
  }
}

// ── the waits of a subagent, read from its events ────────────────────────────

const MAX_NESTING = 64

/**
 * Whether an event of a run (or of a subagent of it, at any depth) says that a person started
 * or stopped being asked: a tool approval or an MCP elicitation. `key` pairs the two events of
 * one question - the ids of the subagents the event passed through are part of it, since an id
 * is unique only within the agent that made it.
 */
export const humanWaitOf = (event: unknown): { key: string; waiting: boolean } | undefined => {
  let current = event as { type?: unknown; id?: unknown; event?: unknown } | null | undefined
  let path = ''
  for (let depth = 0; depth < MAX_NESTING && current?.type === 'subagent.event'; depth += 1) {
    path += `${String(current.id)}/`
    current = current.event as typeof current
  }
  if (!current || typeof current.id !== 'string') {
    return undefined
  }
  switch (current.type) {
    case 'tool.approval-requested':
      return { key: `${path}approval:${current.id}`, waiting: true }
    case 'tool.approval-resolved':
      return { key: `${path}approval:${current.id}`, waiting: false }
    case 'mcp.elicitation-requested':
      return { key: `${path}elicitation:${current.id}`, waiting: true }
    case 'mcp.elicitation-answered':
      return { key: `${path}elicitation:${current.id}`, waiting: false }
    default:
      return undefined
  }
}

export interface IHumanWaitFollower {
  /** Give it every event of the subagent, as it arrives. */
  see: (event: unknown) => void
  /** The subagent is over: any wait still counted ends here. */
  end: () => void
}

/**
 * Keep `clock` stopped for as long as a subagent waits for a person, going by its events: a
 * question that was put (`…-requested`) stops it until that same question is closed
 * (`…-resolved` / `…-answered`, which every question gets - answered, refused, timed out or
 * aborted). An answer to a question that was never put (a call refused before anybody was
 * asked) changes nothing.
 */
export const followHumanWaits = (clock: IWaitClock): IHumanWaitFollower => {
  const open = new Map<string, () => void>()
  return {
    see: (event) => {
      const wait = humanWaitOf(event)
      if (!wait) {
        return
      }
      if (wait.waiting) {
        if (!open.has(wait.key)) {
          open.set(wait.key, clock.pause())
        }
        return
      }
      const resume = open.get(wait.key)
      if (resume) {
        open.delete(wait.key)
        resume()
      }
    },
    end: () => {
      for (const resume of open.values()) {
        resume()
      }
      open.clear()
    },
  }
}
