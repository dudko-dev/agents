import { jsonSchema, tool, type Tool, type ToolSet } from 'ai'
import { normalizePath } from '../files/vfs.js'
import { toolRunContextOf } from '../tools/wrap.js'
import {
  createSandboxQueue,
  resolveSandboxLimits,
  RUN_JS_TOOL,
  runGuest,
  runInWorker,
  SANDBOX_PACKAGE,
  SANDBOX_PLANNER_NOTE,
  SANDBOX_SYNTHESIZER_NOTE,
  sandboxPeerMissing,
  sandboxPromptNote,
  sanitizeSandboxResult,
  type ISandboxConfig,
  type ISandboxLib,
  type ISandboxPort,
  type ISandboxRequest,
  type ISandboxResult,
} from './engine.js'
import {
  collectModules,
  createFileHost,
  readWorkspaceText,
  sandboxFilesOf,
  sandboxHostOps,
  type SandboxFiles,
} from './files.js'

/**
 * `config.sandbox`: the `run_js` tool - the model's code runs in QuickJS compiled to
 * WebAssembly (the optional peer `quickjs-emscripten`), never in the page's own JavaScript
 * engine. This module is loaded only when the sandbox is switched on.
 *
 * Where the guest runs:
 * - `worker` given: in a Web Worker that is terminated when the run is over or over time (the
 *   hard stop). One worker per run. The worker module is `@dudko.dev/agent-web/sandbox-worker`.
 * - no `worker`: on the page's thread, stopped by the engine's interrupt handler only. A single
 *   long native call in the guest then blocks the page until it returns - prefer a worker.
 */

/** A worker as the sandbox uses it: a real `Worker`, or a `MessagePort` in tests. */
export interface SandboxWorkerLike {
  postMessage(message: unknown): void
  addEventListener(type: string, listener: (ev: any) => void): void
  terminate?(): void
}

export interface SandboxConfig extends ISandboxConfig {
  /**
   * Builds a fresh Worker for one run, e.g.
   * `() => new Worker(new URL('@dudko.dev/agent-web/sandbox-worker', import.meta.url), { type: 'module' })`
   * (Vite: `import SandboxWorker from '@dudko.dev/agent-web/sandbox-worker?worker'`). Without it
   * the guest runs on the page's thread - isolated all the same, but only softly interruptible.
   */
  worker?: () => SandboxWorkerLike
  /**
   * Loads the engine for the page-thread fallback, e.g. `() => import('quickjs-emscripten')`, so
   * that your bundler resolves it. Default: a runtime `import('quickjs-emscripten')` (Node, or a
   * page with an import map). Not used when `worker` is given.
   */
  engine?: () => Promise<unknown>
}

export interface Sandbox {
  tools: ToolSet
  /** The run-stable sentences the stage prompts carry while `run_js` is mounted. */
  notes: { planner: string; executor: string; synthesizer: string }
  /** Whether the guest is bound to the workspace (import / require / fs). */
  files: boolean
  /** Where the guest runs. */
  thread: 'worker' | 'page'
}

const MAX_CONCURRENT_RUNS = 4

const portOf = (worker: SandboxWorkerLike): ISandboxPort => ({
  post: (message) => worker.postMessage(message),
  listen: (onMessage, onClose) => {
    worker.addEventListener('message', (ev: { data: unknown }) => onMessage(ev.data))
    worker.addEventListener('error', (ev: { message?: string }) =>
      onClose?.(ev?.message || 'the worker failed'),
    )
    // A MessagePort (tests) delivers nothing until it is started; a Worker has no start().
    ;(worker as { start?: () => void }).start?.()
  },
  terminate: () => worker.terminate?.(),
})

const loadEngine = async (custom: (() => Promise<unknown>) | undefined): Promise<ISandboxLib> => {
  let lib: unknown
  try {
    // A variable specifier plus the two bundler comments: the optional peer is left to the
    // runtime, so a host that never switches the sandbox on builds without it installed.
    const pkg = SANDBOX_PACKAGE
    lib = custom ? await custom() : await import(/* webpackIgnore: true */ /* @vite-ignore */ pkg)
  } catch (err) {
    throw sandboxPeerMissing(
      custom
        ? (err as Error)?.message
        : "in a bundled app pass sandbox.worker, or sandbox.engine: () => import('quickjs-emscripten')",
    )
  }
  const l = lib as Partial<ISandboxLib> | undefined
  if (
    typeof l?.newQuickJSWASMModuleFromVariant !== 'function' ||
    typeof l.newVariant !== 'function'
  ) {
    throw sandboxPeerMissing('what sandbox.engine returned is not the quickjs-emscripten module')
  }
  return l as ISandboxLib
}

interface RunJsInput {
  code?: string
  entry?: string
}

const describeTool = (limits: { timeoutMs: number; memoryLimitBytes: number }, files: boolean) =>
  'Run JavaScript in an isolated sandbox and get back what it printed (console.log) and the value of its last expression. ' +
  'Use it to actually execute code you wrote - a function on test data, a calculation, a parser on a sample - instead of predicting its output. ' +
  `Plain JavaScript on QuickJS (ES2023, top-level await, setTimeout): no Node or browser APIs, no network, no packages${files ? '' : ', no files'}. ` +
  (files
    ? 'Workspace files: import or require them by relative path (.js, .mjs, .json), or use the async fs.readFile(path), fs.writeFile(path, text), fs.readdir(path). '
    : '') +
  `Limits: ${limits.timeoutMs} ms, ${Math.round(limits.memoryLimitBytes / (1024 * 1024))} MiB. ` +
  'A failing program returns { ok: false, error } with its stack: read it and fix the code.'

/**
 * Build the sandbox for one agent. `mounted` are the agent's tools after its allow / exclude
 * filters: file tools among them (from `createFileTools`) are what binds the guest to the
 * workspace, unless `files: false`.
 */
export const createSandbox = (
  config: SandboxConfig,
  mounted: ToolSet = {},
  warn: (message: string) => void = () => {},
): Sandbox => {
  const limits = resolveSandboxLimits(config)
  const files: SandboxFiles | undefined =
    config.files === false ? undefined : sandboxFilesOf(mounted)
  const queue = createSandboxQueue(MAX_CONCURRENT_RUNS)
  if (!config.worker) {
    warn(
      '[sandbox] no sandbox.worker: run_js runs on the page thread (isolated, but a long native call in the guest blocks the page). Pass a worker factory.',
    )
  }

  const execute = async (input: RunJsInput, options: unknown): Promise<ISandboxResult> => {
    const agentRun = toolRunContextOf(options)
    const approve = agentRun?.approve
    const signal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal
    const hasCode = typeof input?.code === 'string' && input.code.trim() !== ''
    const hasEntry = typeof input?.entry === 'string' && input.entry.trim() !== ''
    if (hasEntry && !files?.read) {
      throw new Error(`${RUN_JS_TOOL}: "entry" needs workspace files; pass the program as "code"`)
    }
    if (hasCode === hasEntry) {
      throw new Error(
        `${RUN_JS_TOOL}: pass ${files?.read ? 'either "code" or "entry" (a workspace file)' : '"code"'}`,
      )
    }
    let code = input.code as string
    let filename = '/main.js'
    if (hasEntry && files) {
      filename = normalizePath(input.entry as string)
      if (!/\.(js|mjs)$/i.test(filename)) {
        throw new Error(`${RUN_JS_TOOL}: "entry" must be a .js or .mjs file, got "${filename}"`)
      }
      code = await readWorkspaceText(files, filename, approve, limits.maxCodeChars)
    }
    if (code.length > limits.maxCodeChars) {
      throw new Error(
        `${RUN_JS_TOOL}: the code is ${code.length} characters; the limit is ${limits.maxCodeChars}`,
      )
    }
    const request: ISandboxRequest = { code, filename, limits }
    if (files) {
      request.modules = await collectModules(files, code, filename, approve, limits.maxCodeChars)
      request.hostOps = sandboxHostOps(files)
    }
    const hostCall = files ? createFileHost(files, approve) : undefined
    return queue(async () => {
      let worker: SandboxWorkerLike | undefined
      if (config.worker) {
        try {
          worker = config.worker()
        } catch (err) {
          // No Worker here (an old or locked-down environment): the page thread still isolates.
          warn(
            `[sandbox] sandbox.worker failed (${(err as Error)?.message ?? err}); running on the page thread`,
          )
        }
      }
      if (worker) {
        return runInWorker(portOf(worker), request, { hostCall, signal })
      }
      const startedAt = Date.now()
      const lib = await loadEngine(config.engine)
      const raw = await runGuest(lib, request, { hostCall })
      return { ...sanitizeSandboxResult(raw, limits), durationMs: Date.now() - startedAt }
    })
  }

  const withFiles = Boolean(files?.read)
  const runJs: Tool = tool({
    description: describeTool(limits, Boolean(files)),
    inputSchema: jsonSchema<RunJsInput>({
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'The program. Print with console.log; the value of the last expression is returned as "result".',
        },
        ...(withFiles
          ? {
              entry: {
                type: 'string',
                description:
                  'Instead of "code": the path of a workspace .js / .mjs file to run, e.g. "/main.js".',
              },
            }
          : {}),
      },
      ...(withFiles ? {} : { required: ['code'] }),
      additionalProperties: false,
    }),
    execute,
  })
  return {
    tools: { [RUN_JS_TOOL]: runJs },
    notes: {
      planner: SANDBOX_PLANNER_NOTE,
      executor: sandboxPromptNote(Boolean(files)),
      synthesizer: SANDBOX_SYNTHESIZER_NOTE,
    },
    files: Boolean(files),
    thread: config.worker ? 'worker' : 'page',
  }
}
