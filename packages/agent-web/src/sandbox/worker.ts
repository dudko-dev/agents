import { serveSandbox, type ISandboxLib } from './engine.js'

/**
 * The Web Worker side of the sandbox (`config.sandbox.worker`): the entry
 * `@dudko.dev/agent-web/sandbox-worker`. Loaded as a worker it serves by itself:
 *
 * ```ts
 * // Vite
 * import SandboxWorker from '@dudko.dev/agent-web/sandbox-worker?worker'
 * createAgent({ model, sandbox: { worker: () => new SandboxWorker() } })
 * // webpack 5 and other bundlers that follow `new URL(..., import.meta.url)`
 * createAgent({
 *   model,
 *   sandbox: {
 *     worker: () =>
 *       new Worker(new URL('@dudko.dev/agent-web/sandbox-worker', import.meta.url), { type: 'module' }),
 *   },
 * })
 * ```
 *
 * One worker serves one run and is terminated by the agent. The engine (the optional peer
 * `quickjs-emscripten`) is imported here with a literal specifier, so the host's bundler puts
 * it - and its .wasm file - into the worker's chunk and nowhere else.
 */

/** The slice of a worker scope / MessagePort this needs. */
export interface SandboxWorkerScope {
  postMessage(message: unknown): void
  addEventListener(type: string, listener: (ev: any) => void): void
}

export interface ServeSandboxOptions {
  /** The message endpoint (default: the worker global scope). */
  scope?: SandboxWorkerScope
  /** Load the engine yourself (default: `import('quickjs-emscripten')`). */
  engine?: () => Promise<unknown>
}

export const serveSandboxWorker = (opts: ServeSandboxOptions = {}): void => {
  const scope = opts.scope ?? (globalThis as unknown as SandboxWorkerScope)
  serveSandbox(
    {
      post: (message) => scope.postMessage(message),
      listen: (onMessage) => {
        scope.addEventListener('message', (ev: { data: unknown }) => onMessage(ev.data))
        ;(scope as { start?: () => void }).start?.()
      },
    },
    async () =>
      (await (opts.engine
        ? opts.engine()
        : import('quickjs-emscripten'))) as unknown as ISandboxLib,
  )
}

const inWorker = (): boolean => {
  const g = globalThis as {
    WorkerGlobalScope?: unknown
    importScripts?: unknown
    document?: unknown
  }
  return typeof g.WorkerGlobalScope !== 'undefined' && typeof g.document === 'undefined'
}

if (inWorker()) serveSandboxWorker()
