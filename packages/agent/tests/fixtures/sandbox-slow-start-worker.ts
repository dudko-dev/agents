// The real sandbox worker on a busy machine: the engine takes 400 ms to start before the
// program's first instruction (see helpers/sandbox-slow-start.ts).
import { parentPort } from 'node:worker_threads'
import * as quickjs from 'quickjs-emscripten'
import { serveSandbox, type ISandboxLib } from '../../src/sandbox-engine.ts'
import { slowStart } from '../helpers/sandbox-slow-start.ts'

const port = parentPort
if (port) {
  serveSandbox(
    {
      post: (message) => port.postMessage(message),
      listen: (onMessage) => {
        port.on('message', onMessage)
      },
    },
    async () => slowStart(quickjs as unknown as ISandboxLib, 400),
  )
}
