import { asSchema, tool, type Tool, type ToolExecutionOptions, type ToolSet } from 'ai'
import { randomUUID } from 'node:crypto'
import { AsyncResource } from 'node:async_hooks'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { createAgent } from './agent.ts'
import { isReadOnlyTool, markReadOnly } from './approval.ts'
import { runContext } from './context.ts'
import type { IModelCall, ISharedLimits } from './shared-limits.ts'
import { adoptSubagentEvent } from './subagent-dynamic-shared.ts'
import type { AgentEvent, EventHandler, IAgentConfig, IUsage } from './types.ts'
import { clipText, emptyUsage, errorMessage, normalizeUsage, usageOfError } from './utils.ts'
import { createWaitClock, followHumanWaits, type IWaitClock } from './wait-clock.ts'

// 'remote': the child runs wherever the host's `dispatch` sends it (another worker, another
// machine); no config crosses - the host decides the child's config over there.
export type SubagentIsolation = 'worker' | 'in-process' | 'remote'

// A named way to run the same subagent. Its `config` is laid OVER the base
// config, field by field and shallow: a profile's `limits` replaces the base's
// `limits`, it is not merged into it. The PARENT model picks one per call with
// the optional `profile` argument; the host decides what each name means - a
// cheap model for a quick lookup, a strong one with thinking for a hard
// question, a different system prompt, a narrower tool set.
export interface ISubagentProfile {
  // When to pick this profile - shown to the parent model, which chooses by it.
  description: string
  // Fields laid over the subagent's `config` (model - even another provider -
  // thinking, limits, systemPrompt, skills, tools ...). With 'worker' isolation
  // it must be structured-cloneable, like the base config.
  config?: Partial<IAgentConfig>
}

interface ISubagentToolBase {
  // Tool name the parent model calls.
  name: string
  // When the parent should delegate to this subagent.
  description: string
  // Parallel calls of this tool beyond this many queue. Default 4.
  maxConcurrent?: number
  // Abort the child after this many ms. Default: none. Time a person takes to answer a question
  // (a tool approval, an MCP elicitation) of the child or of the calling run does not count.
  timeoutMs?: number
  // The child's final text is clipped to this. Default 8_000.
  outputMaxChars?: number
  // Mark the tool read-only for tool approval. Default false.
  readOnly?: boolean
}

export interface ILocalSubagentToolOptions extends ISubagentToolBase {
  // The child agent's config. With 'worker' isolation it must be
  // structured-cloneable: no functions anywhere (getHeaders, authProvider,
  // fetch, sanitizers, persistence, onRequest, native tools...). A `runLease` in it is dropped:
  // a subagent runs under its parent's lease.
  config: IAgentConfig
  // 'worker' (default): the child runs in its own worker_thread - its CPU
  // work and crashes stay off the parent's event loop. 'in-process': the
  // child is a plain agent on this thread.
  isolation?: 'worker' | 'in-process'
  // Host tools for the child. In-process: merged into config.tools. Worker:
  // PROXIED - the child sees their schemas, every call runs here on the
  // parent thread.
  tools?: ToolSet
  // Named variants the parent model chooses between per call. The tool gains an
  // optional `profile` argument (one of these names); leaving it out runs the
  // base config. The child's context is still just `task` - a profile that
  // changes `systemPrompt`, `skills` or `tools` is how a child gets a different
  // one. Without profiles the tool is exactly what it was.
  profiles?: Record<string, ISubagentProfile>
  dispatch?: never
}

// What `dispatch` is given: the child's input and who it is for.
export interface IRemoteSubagentTask {
  // The subagent's id in this run's events (subagent.start / .event / .complete / .error).
  id: string
  // The tool's name, and the profile the parent model chose (a name: what it means is yours).
  name: string
  profile?: string
  // The task the parent model wrote: the child's whole input.
  input: string
  // The run whose tool call this is, and the run the host started (they differ under a helper).
  parentRunId?: string
  rootRunId?: string
  // 1 for a subagent of the run the host started, 2 for one a helper of that run called, ...
  depth: number
}

export interface IRemoteSubagentContext {
  // Aborted when the parent stops (the run, its step, a stopSubagent, the tool's timeoutMs).
  signal: AbortSignal
  // Forward an event of the remote child: it reaches the parent's stream as a subagent.event
  // envelope, as a local child's does. Untrusted - checked, clipped and capped
  // (REMOTE_SUBAGENT_LIMITS); ignored once dispatch has settled. A forwarded `usage` event is
  // shown, never charged: the usage dispatch returns is.
  emit: (event: AgentEvent) => void
}

export interface IRemoteSubagentResult {
  text: string
  // What the child spent: charged to the parent run once, when dispatch resolves. A dispatch that
  // throws an error with a `usage` field is charged that.
  usage?: IUsage
}

export type RemoteSubagentDispatch = (
  task: IRemoteSubagentTask,
  context: IRemoteSubagentContext,
) => Promise<IRemoteSubagentResult>

export interface IRemoteSubagentToolOptions extends ISubagentToolBase {
  isolation: 'remote'
  // Run the child somewhere else and resolve with its answer.
  dispatch: RemoteSubagentDispatch
  // Names the parent model chooses between (passed to dispatch as `task.profile`): a description
  // only - no config crosses.
  profiles?: Record<string, { description: string }>
  config?: never
  tools?: never
}

export type ISubagentToolOptions = ILocalSubagentToolOptions | IRemoteSubagentToolOptions

// What a remote child may send back, at most.
export const REMOTE_SUBAGENT_LIMITS = {
  // Events forwarded per call; later ones are dropped (one warning says how many).
  maxEvents: 10_000,
  // One event, as JSON.
  maxEventChars: 64_000,
  // The event's `type`.
  maxTypeChars: 64,
} as const

// ── worker protocol (JSON-cloneable) ─────────────────────────────────────
export interface IProxiedToolDescriptor {
  name: string
  description: string
  inputSchema: unknown
  readOnly?: boolean
}

export type ParentToWorkerMessage =
  | {
      type: 'run'
      task: string
      config: IAgentConfig
      proxied: IProxiedToolDescriptor[]
      // The calling run has config.sharedLimits: the child's model calls ask it over here.
      sharedLimits?: boolean
    }
  | { type: 'abort' }
  | { type: 'tool-result'; callId: string; ok: boolean; output: unknown }
  // The calling run started (true) / stopped (false) waiting for a person (its clock stopped /
  // runs again, wait-clock.ts): a proxied host tool call in flight runs in that run, so the
  // clock of the child run that made it follows.
  | { type: 'tool-wait'; waiting: boolean }
  // The calling run's beforeModelCall let the child's model call go (ok) or refused it.
  | { type: 'model-call-result'; callId: string; ok: boolean; error?: string }

export type WorkerToParentMessage =
  | { type: 'event'; event: AgentEvent }
  | { type: 'tool-call'; callId: string; name: string; input: unknown }
  // A model call of the child asks the calling run's sharedLimits / tells it the call ended.
  | { type: 'model-call'; callId: string; call: IModelCall }
  | { type: 'model-call-end'; callId: string; usage: IUsage; ok: boolean }
  | { type: 'done'; text: string; usage: IUsage; iterations: number }
  | { type: 'error'; error: string }

// A subagent runs under its parent's lease (config.runLease): one in its config is dropped.
const withoutLease = (config: IAgentConfig): IAgentConfig => {
  if (!config || config.runLease === undefined) {
    return config
  }
  const { runLease: _lease, ...rest } = config
  void _lease
  return rest as IAgentConfig
}

const DEFAULT_OUTPUT_MAX_CHARS = 8_000
const DEFAULT_MAX_CONCURRENT = 4
const EVENT_STRING_MAX = 4_000

// JSON round-trip that turns Errors into their message and drops what JSON
// cannot carry. The fallback when structuredClone refuses a payload.
const jsonSafe = (value: unknown): unknown => {
  try {
    const s = JSON.stringify(value, (_k, v: unknown) =>
      v instanceof Error ? v.message : typeof v === 'bigint' ? v.toString() : v,
    )
    return s === undefined ? undefined : JSON.parse(s)
  } catch {
    return String(value)
  }
}

// Structured-cloneable copy of a payload (worker messages).
export const toCloneable = <T>(value: T): T => {
  try {
    return structuredClone(value)
  } catch {
    return jsonSafe(value) as T
  }
}

const clipStrings = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') {
    return clipText(value, EVENT_STRING_MAX)
  }
  if (value instanceof Error) {
    return value
  }
  if (!value || typeof value !== 'object' || depth > 8) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((v) => clipStrings(v, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = clipStrings(v, depth + 1)
  }
  return out
}

// A child event as forwarded to the parent: verbatim, long strings clipped.
export const slimEvent = (event: AgentEvent): AgentEvent => clipStrings(event) as AgentEvent

/**
 * Throws naming the first function-valued field of a config that has to
 * cross into a worker thread (functions are not structured-cloneable).
 */
export const assertWorkerSafeConfig = (config: IAgentConfig, label = 'config'): void => {
  if (config.tools && Object.keys(config.tools).length) {
    throw new Error(
      `${label}.tools cannot cross into a worker thread; use the \`tools\` option of createSubagentTool to proxy host tools (or isolation: 'in-process')`,
    )
  }
  const seen = new Set<unknown>()
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'function') {
      throw new Error(
        `${path} is a function and cannot cross into a worker thread; use the \`tools\` option to proxy host tools, or isolation: 'in-process'`,
      )
    }
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return
    }
    seen.add(value)
    for (const [k, v] of Object.entries(value)) {
      walk(v, `${path}.${k}`)
    }
  }
  walk(config, label)
}

// Source runs (tests, --experimental-strip-types) use the .ts entry; the
// bundles (dist/index.js, dist/index.cjs via tsup's import.meta shim,
// dist/cli.js) sit next to dist/subagent-worker.js.
export const subagentWorkerUrl = (): URL => {
  const here = import.meta.url
  return new URL(here.endsWith('.ts') ? './subagent-worker.ts' : './subagent-worker.js', here)
}

// The worker's node flags. By default (undefined) a worker inherits the
// parent's options itself - notably --experimental-strip-types for source runs
// - and Node drops the per-process ones a worker can't take; passing
// process.execArgv explicitly instead fails on Node 24 under `node --test`
// ("Initiated Worker with invalid execArgv flags: --stack-trace-limit…").
// Only when the parent's flags describe ITS entry point (-e / -p /
// --input-type would make the worker misread its own file) is an explicit,
// filtered list needed.
export const workerExecArgv = (
  argv: readonly string[] = process.execArgv,
): string[] | undefined => {
  const entryPoint = argv.some(
    (a) =>
      ['-e', '--eval', '-p', '--print', '--input-type'].includes(a) ||
      /^--(input-type|eval|print)=/.test(a),
  )
  if (!entryPoint) {
    return undefined
  }
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (['-e', '--eval', '-p', '--print', '--input-type'].includes(a)) {
      i++
      continue
    }
    if (/^--(input-type|eval|print)=/.test(a)) {
      continue
    }
    out.push(a)
  }
  return out
}

const createSemaphore = (max: number) => {
  let active = 0
  const queue: (() => void)[] = []
  return {
    acquire: (signal?: AbortSignal): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          return
        }
        const grant = (): void => {
          signal?.removeEventListener('abort', onAbort)
          active++
          resolve()
        }
        function onAbort(): void {
          const i = queue.indexOf(grant)
          if (i >= 0) {
            queue.splice(i, 1)
          }
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        if (active < max) {
          grant()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        queue.push(grant)
      }),
    release: (): void => {
      active--
      queue.shift()?.()
    },
  }
}

// Run a host tool for a proxied call; the output is made cloneable.
const runHostTool = async (
  host: Tool | undefined,
  name: string,
  input: unknown,
  callId: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; output: unknown }> => {
  if (!host?.execute) {
    return { ok: false, output: `Unknown proxied tool "${name}"` }
  }
  try {
    const options = {
      toolCallId: callId,
      messages: [],
      abortSignal: signal,
      context: {},
    } as unknown as ToolExecutionOptions<unknown>
    let output = (host.execute as (i: unknown, o: unknown) => unknown)(input, options)
    if (output && typeof (output as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
      let last: unknown
      for await (const v of output as AsyncIterable<unknown>) {
        last = v
      }
      output = last
    }
    return { ok: true, output: jsonSafe(await output) }
  } catch (err) {
    return { ok: false, output: errorMessage(err) }
  }
}

const describeTools = (tools: ToolSet): IProxiedToolDescriptor[] =>
  Object.entries(tools).map(([name, t]) => ({
    name,
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: asSchema(t.inputSchema).jsonSchema,
    ...(isReadOnlyTool(t) ? { readOnly: true } : {}),
  }))

interface IChildOutcome {
  text: string
  usage: IUsage
}

const runInProcess = async (
  opts: ILocalSubagentToolOptions,
  config: IAgentConfig,
  task: string,
  signal: AbortSignal,
  onEvent: EventHandler,
): Promise<IChildOutcome> => {
  const tools = { ...(config.tools ?? {}), ...(opts.tools ?? {}) }
  const child = await createAgent(
    { ...config, ...(Object.keys(tools).length ? { tools } : {}) },
    onEvent,
  )
  try {
    const r = await child.run({ input: task, signal })
    return { text: r.text, usage: r.usage }
  } finally {
    await child.close({ timeoutMs: 5_000 }).catch(() => {})
  }
}

const runInWorker = (
  opts: ILocalSubagentToolOptions,
  config: IAgentConfig,
  task: string,
  signal: AbortSignal,
  onEvent: EventHandler,
  clock: IWaitClock,
): Promise<IChildOutcome> =>
  new Promise<IChildOutcome>((resolve, reject) => {
    const hostTools = opts.tools ?? {}
    // The calling run's sharedLimits (functions cannot cross): the child's model calls ask it
    // here, under the run the host started.
    const store = runContext.getStore()
    const limits: ISharedLimits | undefined = store?.sharedLimits
    const rootRunId = store?.rootRunId ?? store?.runId
    const modelCalls = new Map<string, IModelCall>()
    const warn = (message: string): void => {
      try {
        store?.emit?.({ type: 'log', level: 'warn', message })
      } catch {}
    }
    let settled = false
    let worker: Worker
    let unwatch: (() => void) | undefined
    try {
      const execArgv = workerExecArgv()
      worker = new Worker(subagentWorkerUrl(), {
        workerData: { subagent: opts.name },
        ...(execArgv ? { execArgv } : {}),
      })
    } catch (err) {
      reject(err)
      return
    }
    const finish = (fn: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      unwatch?.()
      signal.removeEventListener('abort', onAbort)
      fn()
      void worker.terminate().catch(() => {})
    }
    function onAbort(): void {
      worker.postMessage({ type: 'abort' } satisfies ParentToWorkerMessage)
      // Give the child a moment to unwind cleanly, then cut it off.
      const t = setTimeout(
        () => finish(() => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))),
        1_000,
      )
      t.unref?.()
    }
    // Messages arrive outside of the tool call's async context; bind the
    // handler so proxied host tools still see the parent run (runId,
    // sandbox, approval events).
    const onMessage = AsyncResource.bind((msg: WorkerToParentMessage) => {
      switch (msg.type) {
        case 'event':
          onEvent(msg.event)
          break
        case 'tool-call':
          void runHostTool(hostTools[msg.name], msg.name, msg.input, msg.callId, signal).then(
            (r) => {
              if (!settled) {
                worker.postMessage({
                  type: 'tool-result',
                  callId: msg.callId,
                  ok: r.ok,
                  output: r.output,
                } satisfies ParentToWorkerMessage)
              }
            },
          )
          break
        case 'model-call': {
          if (!limits) {
            break
          }
          const { runId: _childRun, ...rest } = msg.call
          void _childRun
          const call: IModelCall = { ...rest, ...(rootRunId ? { runId: rootRunId } : {}) }
          modelCalls.set(msg.callId, call)
          const answer = (ok: boolean, error?: string): void => {
            if (!settled) {
              worker.postMessage({
                type: 'model-call-result',
                callId: msg.callId,
                ok,
                ...(error !== undefined ? { error } : {}),
              } satisfies ParentToWorkerMessage)
            }
          }
          Promise.resolve()
            .then(() => limits.beforeModelCall(call, { signal }))
            .then(
              () => answer(true),
              (err) => {
                modelCalls.delete(msg.callId)
                answer(false, errorMessage(err))
              },
            )
          break
        }
        case 'model-call-end': {
          const call = modelCalls.get(msg.callId)
          modelCalls.delete(msg.callId)
          if (!call || !limits?.afterModelCall) {
            break
          }
          const failed = (err: unknown): void =>
            warn(`[sharedLimits] afterModelCall threw (${call.stage}): ${errorMessage(err)}`)
          try {
            const r = limits.afterModelCall(call, normalizeUsage(msg.usage), { ok: msg.ok })
            if (r && typeof (r as Promise<void>).then === 'function') {
              ;(r as Promise<void>).then(undefined, failed)
            }
          } catch (err) {
            failed(err)
          }
          break
        }
        case 'done':
          finish(() => resolve({ text: msg.text, usage: msg.usage }))
          break
        case 'error':
          finish(() =>
            reject(
              signal.aborted
                ? (signal.reason ?? new DOMException('Aborted', 'AbortError'))
                : new Error(msg.error),
            ),
          )
          break
      }
    })
    worker.on('message', onMessage)
    worker.on('error', (err) => finish(() => reject(err)))
    worker.on('exit', (code) =>
      finish(() => reject(new Error(`subagent worker exited with code ${code} before finishing`))),
    )
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // A host tool the child calls runs HERE, in the calling run: while that run waits for a
    // person (an MCP question of the host tool, say) its clock is stopped, and the child is told,
    // so a step of the child that is waiting for a host tool's result does not run out of time
    // meanwhile. The worker cannot tell which question is whose: a proxied call in flight
    // follows every wait of this run - its step is paused at most as long as this run is.
    const tell = (waiting: boolean): void => {
      if (!settled) {
        worker.postMessage({ type: 'tool-wait', waiting } satisfies ParentToWorkerMessage)
      }
    }
    unwatch = clock.watch(tell)
    if (clock.paused) {
      tell(true)
    }
    worker.postMessage({
      type: 'run',
      task,
      config: toCloneable(config),
      proxied: describeTools(hostTools),
      ...(limits ? { sharedLimits: true } : {}),
    } satisfies ParentToWorkerMessage)
  })

const REMOTE_EVENT_TYPE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/

// One event a remote child sent, as plain data, or undefined when it is not one: not an object,
// no well-formed `type`, too big, not serialisable.
export const remoteSubagentEventOf = (raw: unknown): AgentEvent | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }
  const type = (raw as { type?: unknown }).type
  if (
    typeof type !== 'string' ||
    type.length > REMOTE_SUBAGENT_LIMITS.maxTypeChars ||
    !REMOTE_EVENT_TYPE.test(type)
  ) {
    return undefined
  }
  let json: string | undefined
  try {
    json = JSON.stringify(raw)
  } catch {
    return undefined
  }
  if (json === undefined || json.length > REMOTE_SUBAGENT_LIMITS.maxEventChars) {
    return undefined
  }
  return JSON.parse(json) as AgentEvent
}

const countOf = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, Number.MAX_SAFE_INTEGER) : 0

// What a remote child says it spent, as a usage that can only ADD to the parent's: every field a
// count that is not negative (a negative one would hand budget back), the total at least input +
// output.
export const remoteSubagentUsageOf = (raw: unknown): IUsage => {
  if (!raw || typeof raw !== 'object') {
    return emptyUsage()
  }
  const usage = normalizeUsage(raw as Parameters<typeof normalizeUsage>[0])
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number') {
      out[key] = countOf(value)
    }
  }
  const bounded = out as unknown as IUsage
  bounded.totalTokens = Math.max(bounded.totalTokens, bounded.inputTokens + bounded.outputTokens)
  return bounded
}

const usageIsZero = (u: IUsage): boolean =>
  Object.values(u).every((v) => typeof v !== 'number' || v === 0)

// The remote child: dispatch, bounded by the signal (a stop does not wait for a dispatch that
// ignores it), its events checked and capped, its answer checked.
const runRemote = async (
  opts: IRemoteSubagentToolOptions,
  task: IRemoteSubagentTask,
  signal: AbortSignal,
  onEvent: EventHandler,
  warn: (message: string) => void,
): Promise<IChildOutcome> => {
  let open = true
  let forwarded = 0
  let dropped = 0
  const emit = (raw: AgentEvent): void => {
    if (!open) {
      return
    }
    const event = remoteSubagentEventOf(raw)
    if (!event || forwarded >= REMOTE_SUBAGENT_LIMITS.maxEvents) {
      dropped++
      return
    }
    forwarded++
    onEvent(event)
  }
  try {
    const out = await new Promise<IRemoteSubagentResult>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve()
        .then(() => opts.dispatch(task, { signal, emit }))
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort))
    })
    if (!out || typeof out !== 'object' || typeof (out as { text?: unknown }).text !== 'string') {
      throw new Error(`subagent "${opts.name}": dispatch must resolve to { text: string, usage? }`)
    }
    return { text: out.text, usage: remoteSubagentUsageOf(out.usage) }
  } finally {
    open = false
    if (dropped) {
      warn(
        `[subagent] ${opts.name}: ${dropped} event(s) of the remote child were dropped (not an event, too big, or past ${REMOTE_SUBAGENT_LIMITS.maxEvents})`,
      )
    }
  }
}

/**
 * Expose a whole agent as ONE tool of a parent agent: input `{ task }`,
 * output the child's final text. Calls in one model step run in parallel
 * (bounded by maxConcurrent); the parent's abort aborts the child; child
 * usage is emitted on the parent as `usage` (phase 'subagent') so it counts
 * against the parent's limits; child events arrive as `subagent.event`.
 */
export const createSubagentTool = (opts: ISubagentToolOptions): Tool => {
  const isolation: SubagentIsolation = opts.isolation ?? 'worker'
  if (!opts.name || typeof opts.name !== 'string') {
    throw new Error('createSubagentTool: name is required')
  }
  if (isolation !== 'worker' && isolation !== 'in-process' && isolation !== 'remote') {
    throw new Error(
      `subagent "${opts.name}": isolation must be 'worker', 'in-process' or 'remote', got ${JSON.stringify(isolation)}`,
    )
  }
  const remote = isolation === 'remote' ? (opts as IRemoteSubagentToolOptions) : undefined
  const local = isolation === 'remote' ? undefined : (opts as ILocalSubagentToolOptions)
  if (remote) {
    if (typeof remote.dispatch !== 'function') {
      throw new Error(`subagent "${opts.name}": isolation 'remote' needs a dispatch function`)
    }
    // What the child runs with is decided where it runs: nothing of a config, and no host tool,
    // can be sent there.
    for (const field of ['config', 'tools'] as const) {
      if ((remote as unknown as Record<string, unknown>)[field] !== undefined) {
        throw new Error(
          `subagent "${opts.name}": \`${field}\` makes no sense with isolation 'remote' - nothing crosses to the remote child; its ${field} is decided where dispatch runs it`,
        )
      }
    }
  } else if ((opts as { dispatch?: unknown }).dispatch !== undefined) {
    throw new Error(`subagent "${opts.name}": dispatch is for isolation 'remote' only`)
  }
  if (local && isolation === 'worker') {
    assertWorkerSafeConfig(withoutLease(local.config), `subagent "${opts.name}": config`)
  }
  const profiles: Record<string, ISubagentProfile> = opts.profiles ?? {}
  const profileNames = Object.keys(profiles)
  for (const [pname, p] of Object.entries(profiles)) {
    if (!pname.trim()) {
      throw new Error(`subagent "${opts.name}": a profile needs a non-empty name`)
    }
    if (!p || typeof p.description !== 'string' || !p.description.trim()) {
      throw new Error(
        `subagent "${opts.name}": profile "${pname}" needs a description - the parent model chooses by it`,
      )
    }
    if (remote && p.config !== undefined) {
      throw new Error(
        `subagent "${opts.name}": profile "${pname}" has a config, which makes no sense with isolation 'remote' - the profile's name is passed to dispatch, which decides what it means`,
      )
    }
    if (isolation === 'worker' && p.config) {
      // A function in a profile would otherwise surface only when that profile is
      // first chosen - possibly hours into a run.
      assertWorkerSafeConfig(
        withoutLease(p.config as IAgentConfig),
        `subagent "${opts.name}": profile "${pname}" config`,
      )
    }
  }
  // An empty value counts as "not given": models do send `profile: ""`.
  const pickProfile = (name: string | undefined): ISubagentProfile | undefined => {
    if (!name) {
      return undefined
    }
    // hasOwn, not `in`: a model answering "constructor" must not resolve to Object's.
    if (!Object.hasOwn(profiles, name)) {
      throw new Error(
        `subagent "${opts.name}": unknown profile "${name}" - choose one of: ${profileNames.join(', ')}`,
      )
    }
    return profiles[name]
  }
  const outputMaxChars = opts.outputMaxChars ?? DEFAULT_OUTPUT_MAX_CHARS
  const sem = createSemaphore(Math.max(1, opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT))

  // The profiles are described in the tool's DESCRIPTION, not only on the schema
  // property: a prompted-mode model reads the catalogue and a one-line shape, and
  // would otherwise never learn what "deep" is for.
  const description = profileNames.length
    ? `${opts.description}\n\nOptional \`profile\` (omit it for the default):\n${profileNames
        .map((n) => `- ${n}: ${profiles[n].description}`)
        .join('\n')}`
    : opts.description
  const taskSchema = z
    .string()
    .describe('A complete, self-contained task for the subagent, with all context it needs')
  const inputSchema = (
    profileNames.length
      ? z.object({
          task: taskSchema,
          profile: z
            .enum(profileNames as [string, ...string[]])
            .optional()
            .describe("One of this tool's profiles, described above. Omit it for the default."),
        })
      : z.object({ task: taskSchema })
  ) as z.ZodType<{ task: string; profile?: string }>

  const subagent = tool({
    description,
    inputSchema,
    execute: async ({ task, profile: profileName }, { abortSignal }) => {
      // Before taking a slot or announcing a start: an unknown name is a tool error
      // the model can correct, not a delegation that began and died.
      const profile = pickProfile(profileName)
      // A subagent runs under its parent's lease: never one of its own.
      const config: IAgentConfig | undefined = local
        ? withoutLease({ ...local.config, ...profile?.config })
        : undefined
      const store = runContext.getStore()
      const emit: EventHandler = store?.emit ?? (() => {})
      const id = randomUUID()
      const name = opts.name
      await sem.acquire(abortSignal)
      const ac = new AbortController()
      const onParentAbort = (): void => ac.abort(abortSignal?.reason)
      abortSignal?.addEventListener('abort', onParentAbort, { once: true })
      if (abortSignal?.aborted) {
        onParentAbort()
      }
      let timedOut = false
      let stoppedByUser = false
      let unregister: (() => void) | undefined
      // The child's time limit is a deadline of the calling run's clock, and that clock - with
      // the caller's step limit on it - is stopped while the child waits for a person.
      const clock = store?.state?.clock ?? createWaitClock()
      const waits = followHumanWaits(clock)
      const timer =
        typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
          ? clock.timer(opts.timeoutMs, () => {
              timedOut = true
              ac.abort(new Error(`subagent "${name}" timed out after ${opts.timeoutMs}ms`))
            })
          : undefined
      let childUsage: IUsage = emptyUsage()
      const onChildEvent: EventHandler = (event) => {
        waits.see(event)
        // A remote child's usage is charged once, from what dispatch returns: a forwarded usage
        // event is shown, not charged (it would count twice).
        if (event.type === 'usage' && !remote) {
          // Counted on the parent as it happens, so the parent's limits
          // see a long-running child.
          const usage = normalizeUsage(event.usage)
          emit({ type: 'usage', phase: 'subagent', usage })
        }
        // A subagent the child started is one level deeper from here, and this child is its parent.
        emit({
          type: 'subagent.event',
          id,
          name,
          event: slimEvent(adoptSubagentEvent(event, id)),
        })
      }
      try {
        emit({
          type: 'subagent.start',
          id,
          name,
          task,
          ...(profile ? { profile: profileName } : {}),
          // The tree: called by this run (a subagent this event passes through on its way up
          // replaces the parent with its own id and adds a level - see adoptSubagentEvent).
          ...(store?.runId ? { parentId: store.runId } : {}),
          depth: 1,
        })
        // Listed in the run's control from here, so the host can stop THIS child on its own.
        unregister = (store?.control ?? store?.state?.spawn?.control)?.registerSubagent(
          {
            id,
            name,
            task,
            ...(profile ? { profile: profileName } : {}),
            startedAt: Date.now(),
          },
          () => {
            stoppedByUser = true
            ac.abort(new DOMException('Aborted', 'AbortError'))
          },
        )
        const out = remote
          ? await runRemote(
              remote,
              {
                id,
                name,
                ...(profile ? { profile: profileName } : {}),
                input: task,
                ...(store?.runId ? { parentRunId: store.runId } : {}),
                ...((store?.rootRunId ?? store?.runId)
                  ? { rootRunId: store?.rootRunId ?? store?.runId }
                  : {}),
                depth: (store?.state?.spawn?.depth ?? 0) + 1,
              },
              ac.signal,
              onChildEvent,
              (message) => emit({ type: 'log', level: 'warn', message }),
            )
          : isolation === 'worker'
            ? await runInWorker(
                local as ILocalSubagentToolOptions,
                config as IAgentConfig,
                task,
                ac.signal,
                onChildEvent,
                clock,
              )
            : await runInProcess(
                local as ILocalSubagentToolOptions,
                config as IAgentConfig,
                task,
                ac.signal,
                onChildEvent,
              )
        childUsage = normalizeUsage(out.usage)
        if (remote && !usageIsZero(childUsage)) {
          emit({ type: 'usage', phase: 'subagent', usage: childUsage })
        }
        const text = clipText(out.text, outputMaxChars)
        emit({ type: 'subagent.complete', id, name, text, usage: childUsage })
        return text
      } catch (err) {
        // The user's stop wins over a deadline that fired at the same moment.
        const message = stoppedByUser
          ? `subagent "${name}" was stopped by the user before it finished - carry on without its result, or take another approach`
          : timedOut
            ? `subagent "${name}" timed out after ${opts.timeoutMs}ms`
            : errorMessage(err)
        // A remote child that failed may still say what it spent (an error with `usage`).
        const lost = remote ? usageOfError(err) : undefined
        const spent = lost ? remoteSubagentUsageOf(lost) : undefined
        if (spent && !usageIsZero(spent)) {
          emit({ type: 'usage', phase: 'subagent', usage: spent })
        }
        emit({
          type: 'subagent.error',
          id,
          name,
          error: message,
          ...(stoppedByUser ? { stopped: true } : {}),
          ...(spent && !usageIsZero(spent) ? { usage: spent } : {}),
        })
        if (stoppedByUser || timedOut) {
          throw new Error(message)
        }
        throw err
      } finally {
        unregister?.()
        timer?.cancel()
        waits.end()
        abortSignal?.removeEventListener('abort', onParentAbort)
        sem.release()
      }
    },
  })
  return markReadOnly(subagent, opts.readOnly === true)
}
