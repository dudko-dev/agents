// `config.sandbox`: the `run_js` tool. The model's code runs in QuickJS compiled to WebAssembly
// (the optional peer `quickjs-emscripten`), inside a worker thread that is terminated when the
// run is over or over time. Not `node:vm` - that shares the process's heap and intrinsics and
// is documented as not a security mechanism.
//
// In this package the sandbox computes only: the Node agent has no workspace to bind (the
// per-run `sandboxRoot` directory is a spill area for binary tool results, not the model's
// files), so the guest gets no loader and no `fs`. The browser sibling binds its virtual file
// system; the engine (`sandbox-engine.ts`) is the same file in both.
import { tool, type Tool, type ToolSet } from 'ai'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { markCodeExecution } from './approval.ts'
import {
  createSandboxQueue,
  resolveSandboxLimits,
  RUN_JS_TOOL,
  runInWorker,
  SANDBOX_PACKAGE,
  sandboxPeerMissing,
  type ISandboxConfig,
  type ISandboxPort,
  type ISandboxResult,
} from './sandbox-engine.ts'
import { workerExecArgv } from './subagent.ts'

export { RUN_JS_TOOL, resolveSandboxLimits, SandboxUnavailableError } from './sandbox-engine.ts'
export type {
  ISandboxConfig,
  ISandboxError,
  ISandboxLimits,
  ISandboxResult,
} from './sandbox-engine.ts'

// Source runs (tests, --experimental-strip-types) use the .ts entry; the bundles sit next to
// dist/sandbox-worker.js (the same arrangement as the subagent worker).
export const sandboxWorkerUrl = (): URL => {
  const here = import.meta.url
  return new URL(here.endsWith('.ts') ? './sandbox-worker.ts' : './sandbox-worker.js', here)
}

// How many workers this process has started for the sandbox (tests assert it stays 0 when off).
export const sandboxStats = { workers: 0 }

// Runs at once; further calls wait. Each run is a thread and a heap of its own.
const MAX_CONCURRENT_RUNS = 4
// The worker thread's own limits, beside QuickJS's. The stack is larger than Node's default so
// that the guest's bounded recursion ends in QuickJS ("stack overflow") and not in the thread.
const WORKER_STACK_MB = 16
const WORKER_HEAP_MB = 256

const portOf = (worker: Worker): ISandboxPort => ({
  post: (message) => worker.postMessage(message),
  listen: (onMessage, onClose) => {
    worker.on('message', onMessage)
    worker.on('error', (err) => onClose?.(err instanceof Error ? err.message : String(err)))
    worker.on('exit', (code) => onClose?.(`the worker exited (code ${code})`))
  },
  terminate: () => {
    void worker.terminate()
  },
})

const peerInstalled = (): boolean => {
  try {
    createRequire(import.meta.url).resolve(SANDBOX_PACKAGE)
    return true
  } catch {
    return false
  }
}

export interface ISandboxDeps {
  // Test seams: another worker entry, another answer to "is the peer installed".
  workerUrl?: URL
  peerInstalled?: () => boolean
}

// `run_js({ code })`: run a program the model wrote and return what it printed and its last
// value. A guest that throws, loops or runs out of memory is a RESULT ({ ok: false, error }),
// so the model reads it and fixes its code; only an unusable sandbox is a tool error.
// Not read-only for the approval gate: 'ask-writes' asks before each run.
export const createSandboxTool = (config: ISandboxConfig = {}, deps: ISandboxDeps = {}): Tool => {
  // Resolved, not imported: with the peer missing the agent fails at creation with the package
  // to install, and the engine itself is only ever loaded inside a run's worker.
  if (!(deps.peerInstalled ?? peerInstalled)()) {
    throw sandboxPeerMissing()
  }
  const limits = resolveSandboxLimits(config)
  const queue = createSandboxQueue(MAX_CONCURRENT_RUNS)
  return tool({
    description:
      'Run JavaScript in an isolated sandbox and get back what it printed (console.log) and the value of its last expression. ' +
      'Use it to actually execute code you wrote - a function on test data, a calculation, a parser on a sample - instead of predicting its output. ' +
      'Plain JavaScript on QuickJS (ES2023, top-level await, setTimeout): no Node or browser APIs, no network, no files, no packages. ' +
      `Limits: ${limits.timeoutMs} ms, ${Math.round(limits.memoryLimitBytes / (1024 * 1024))} MiB. ` +
      'A failing program returns { ok: false, error } with its stack: read it and fix the code.',
    inputSchema: z.object({
      code: z
        .string()
        .describe(
          'The program. Print with console.log; the value of the last expression is returned as "result".',
        ),
    }),
    execute: async ({ code }, { abortSignal }): Promise<ISandboxResult> => {
      if (typeof code !== 'string' || !code.trim()) {
        throw new Error(`${RUN_JS_TOOL}: "code" is empty`)
      }
      if (code.length > limits.maxCodeChars) {
        throw new Error(
          `${RUN_JS_TOOL}: the code is ${code.length} characters; the limit is ${limits.maxCodeChars}`,
        )
      }
      return queue(async () => {
        const execArgv = workerExecArgv()
        const worker = new Worker(deps.workerUrl ?? sandboxWorkerUrl(), {
          // Nothing of the process's environment is the guest's business.
          env: {},
          resourceLimits: { stackSizeMb: WORKER_STACK_MB, maxOldGenerationSizeMb: WORKER_HEAP_MB },
          ...(execArgv ? { execArgv } : {}),
        })
        sandboxStats.workers += 1
        return runInWorker(portOf(worker), { code, limits }, { signal: abortSignal })
      })
    },
  })
}

// The tools `config.sandbox` turns on (none when it is off: nothing is loaded, nothing starts).
export const createSandboxTools = (
  sandbox: boolean | ISandboxConfig | undefined,
  deps?: ISandboxDeps,
): ToolSet | undefined => {
  if (!sandbox) {
    return undefined
  }
  // It runs code: asked whenever the run acts on an MCP server's skill (approval.ts).
  return {
    [RUN_JS_TOOL]: markCodeExecution(createSandboxTool(sandbox === true ? {} : sandbox, deps)),
  }
}
