// Worker-thread entry of the sandbox (`config.sandbox`, the run_js tool). Bundled to
// dist/sandbox-worker.js; run from source as src/sandbox-worker.ts (the worker inherits
// --experimental-strip-types). One worker serves one run and is terminated by its parent.
//
// The engine is imported HERE and nowhere else: an agent without `config.sandbox` never loads
// the optional peer, and one with it loads it off the agent's thread.
import { isMainThread, parentPort } from 'node:worker_threads'
import { SANDBOX_PACKAGE, serveSandbox, type ISandboxLib } from './sandbox-engine.ts'

if (!isMainThread && parentPort) {
  const port = parentPort
  serveSandbox(
    {
      post: (message) => port.postMessage(message),
      listen: (onMessage) => {
        port.on('message', onMessage)
      },
    },
    async () => (await import(SANDBOX_PACKAGE)) as ISandboxLib,
  )
}
