// Worker-thread entry of a subagent (createSubagentTool, isolation 'worker').
// Bundled to dist/subagent-worker.js; run from source as
// src/subagent-worker.ts (the worker inherits --experimental-strip-types).
//
// Protocol: see ParentToWorkerMessage / WorkerToParentMessage in subagent.ts.
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { randomUUID } from 'node:crypto'
import { isMainThread, parentPort, type MessagePort } from 'node:worker_threads'
import { createAgent, type IAgent } from './agent.ts'
import { markReadOnly } from './approval.ts'
import { runContext } from './context.ts'
import { toCloneable, type ParentToWorkerMessage, type WorkerToParentMessage } from './subagent.ts'
import { errorMessage } from './utils.ts'

export const serveSubagentWorker = (port: MessagePort): void => {
  const ac = new AbortController()
  const pending = new Map<string, (r: { ok: boolean; output: unknown }) => void>()
  // What stops the clock of the run each proxied call in flight belongs to, and what starts the
  // clocks again that a 'tool-wait' message stopped.
  const pauses = new Map<string, () => () => void>()
  let resumes: (() => void)[] = []
  const setWaiting = (waiting: boolean): void => {
    for (const resume of resumes) {
      resume()
    }
    resumes = waiting ? [...pauses.values()].map((pause) => pause()) : []
  }
  let started = false
  const post = (msg: WorkerToParentMessage): void => {
    try {
      port.postMessage(msg)
    } catch {
      port.postMessage(toCloneable(msg))
    }
  }

  const run = async (msg: Extract<ParentToWorkerMessage, { type: 'run' }>): Promise<void> => {
    // Proxied host tools: the child sees the schema, the call runs on the
    // parent thread and the result comes back as a tool-result message.
    const tools: ToolSet = {}
    for (const p of msg.proxied) {
      tools[p.name] = markReadOnly(
        dynamicTool({
          description: p.description,
          inputSchema: jsonSchema(p.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: (input, options) =>
            new Promise<unknown>((resolve, reject) => {
              const callId = randomUUID()
              const signal = options?.abortSignal
              const onAbort = (): void => {
                pending.delete(callId)
                pauses.delete(callId)
                reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
              }
              if (signal?.aborted) {
                onAbort()
                return
              }
              signal?.addEventListener('abort', onAbort, { once: true })
              const clock = runContext.getStore()?.state?.clock
              if (clock) {
                pauses.set(callId, clock.pause)
              }
              pending.set(callId, (r) => {
                pending.delete(callId)
                pauses.delete(callId)
                signal?.removeEventListener('abort', onAbort)
                if (r.ok) {
                  resolve(r.output)
                } else {
                  reject(
                    new Error(typeof r.output === 'string' ? r.output : JSON.stringify(r.output)),
                  )
                }
              })
              post({ type: 'tool-call', callId, name: p.name, input: toCloneable(input) })
            }),
        }),
        p.readOnly === true,
      )
    }
    let agent: IAgent | undefined
    try {
      agent = await createAgent(
        { ...msg.config, ...(msg.proxied.length ? { tools } : {}) },
        (event) => post({ type: 'event', event: toCloneable(event) }),
      )
      const r = await agent.run({ input: msg.task, signal: ac.signal })
      post({ type: 'done', text: r.text, usage: toCloneable(r.usage), iterations: r.iterations })
    } catch (err) {
      post({ type: 'error', error: errorMessage(err) })
    } finally {
      await agent?.close({ timeoutMs: 2_000 }).catch(() => {})
    }
  }

  port.on('message', (msg: ParentToWorkerMessage) => {
    switch (msg.type) {
      case 'run':
        if (!started) {
          started = true
          void run(msg)
        }
        break
      case 'abort':
        ac.abort()
        break
      case 'tool-result':
        pending.get(msg.callId)?.({ ok: msg.ok, output: msg.output })
        break
      case 'tool-wait':
        setWaiting(msg.waiting)
        break
    }
  })
}

if (!isMainThread && parentPort) {
  serveSubagentWorker(parentPort)
}
