// A sandbox worker on a machine where the optional peer is not installed: the import fails.
import { parentPort } from 'node:worker_threads'
import { serveSandbox } from '../../src/sandbox-engine.ts'

const port = parentPort
if (port) {
  serveSandbox(
    {
      post: (message) => port.postMessage(message),
      listen: (onMessage) => {
        port.on('message', onMessage)
      },
    },
    async () => {
      throw new Error("Cannot find package 'quickjs-emscripten' imported from sandbox-worker.js")
    },
  )
}
