// A real thread for the sandbox tests: the package's worker entry, served over a Node worker's
// port (a browser loads dist/sandbox-worker.js as a Web Worker and it serves by itself).
import { parentPort } from 'node:worker_threads'
import { serveSandboxWorker } from '../../dist/sandbox-worker.js'

serveSandboxWorker({
  scope: {
    postMessage: (message) => parentPort.postMessage(message),
    addEventListener: (type, listener) => {
      if (type === 'message') parentPort.on('message', (data) => listener({ data }))
    },
  },
})
