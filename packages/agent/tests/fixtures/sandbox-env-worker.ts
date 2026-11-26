// A stand-in sandbox worker that answers with the names of its environment variables, so a test
// can see what a sandbox worker thread is given of the agent's process.
import { parentPort } from 'node:worker_threads'

parentPort?.on('message', () => {
  parentPort?.postMessage({
    type: 'failed',
    code: 'engine',
    message: `env=${JSON.stringify(Object.keys(process.env))}`,
  })
})
