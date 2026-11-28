// The end-to-end harness: the Worker under `wrangler dev` (local only: workerd with the Durable
// Objects and Workflows of Miniflare, state under a temporary `--persist-to`, nothing deployed,
// no account), the scripted OpenAI-compatible model of the agent package's tests (no provider, no
// key), the test MCP server of @dudko.dev/test-servers - and the SAME HTTP API as examples/swarm.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startLocalMcpServer,
  type ILocalMcpServer,
  type ILocalMcpServerOptions,
} from '@dudko.dev/test-servers'
import {
  startLocalOpenAI,
  systemOf,
  toolNames,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from '../../../packages/agent/tests/helpers/openai-server.ts'

export {
  systemOf,
  toolNames,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
}

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const TOKEN = 'e2e-test-token-0123456789abcdef'

export const stageOf = (req: IChatRequest): string => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}

export const stepOf = (req: IChatRequest): string =>
  /CURRENT STEP to execute \(id=([^)]+)\)/.exec(userOf(req))?.[1] ?? '?'

export const planJson = (ids: string[]): string =>
  JSON.stringify({
    thought: 'Step by step.',
    steps: ids.map((id) => ({
      id,
      description: `Step ${id}`,
      expectedOutcome: `${id} done`,
      suggestedTools: [],
    })),
  })

// The executor's rounds of a step: the i-th answer once i rounds are done.
export const roundOf = (req: IChatRequest): number =>
  req.messages.filter((m) => m.role === 'assistant').length

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

export interface IDev {
  base: string
  child: ChildProcess
  output: () => string
  // Kill the whole process group (wrangler and its workerd), as a crash would.
  kill: () => Promise<void>
}

const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler')

export const startDev = async (vars: Record<string, string>, persist: string): Promise<IDev> => {
  const port = await freePort()
  const inspector = await freePort()
  const args = [
    'dev',
    '--port',
    String(port),
    '--ip',
    '127.0.0.1',
    '--inspector-port',
    String(inspector),
    '--persist-to',
    persist,
    '--show-interactive-dev-session=false',
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
  ]
  const child = spawn(WRANGLER, args, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_UPDATE_NOTIFIER: '1' },
  })
  let out = ''
  const onData = (b: Buffer): void => {
    out += b.toString()
    if (process.env.E2E_VERBOSE) process.stderr.write(b)
  }
  child.stdout!.on('data', onData)
  child.stderr!.on('data', onData)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${out}`)), 60_000)
    const check = (): void => {
      if (out.includes('Ready on')) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout!.on('data', check)
    child.stderr!.on('data', check)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`wrangler dev exited ${code}:\n${out}`))
    })
  })
  const base = `http://127.0.0.1:${port}`
  // The first request builds the Worker: wait until it answers.
  await until('the worker answers', async () => {
    const res = await fetch(`${base}/healthz`).catch(() => undefined)
    return res?.status === 200 || undefined
  })
  return {
    base,
    child,
    output: () => out,
    kill: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // gone already
      }
      await exited
    },
  }
}

export interface IStack {
  base: string
  model: ILocalOpenAI
  mcp: ILocalMcpServer
  dev: IDev
  vars: Record<string, string>
  persist: string
  // Kill the Worker (wrangler and workerd) and start it again on the same state.
  restart: () => Promise<void>
  stop: () => Promise<void>
}

export const startStack = async (
  script: Script,
  vars: Record<string, string> = {},
  mcpOptions: ILocalMcpServerOptions = {},
): Promise<IStack> => {
  const model = await startLocalOpenAI(script)
  const mcp = await startLocalMcpServer(mcpOptions)
  const persist = mkdtempSync(join(tmpdir(), 'swarm-cf-e2e-'))
  const all = {
    LOG_LEVEL: 'warn',
    GATEWAY_AUTH: 'bearer',
    GATEWAY_TOKENS: TOKEN,
    AGENT_PROVIDER_TYPE: 'openai-compatible',
    AGENT_BASE_URL: model.baseURL,
    AGENT_API_KEY: 'not-a-real-key',
    AGENT_MODEL: 'scripted',
    AGENT_MAX_ITERATIONS: '6',
    AGENT_MAX_STEPS_PER_TASK: '4',
    AGENT_LOG_LEVEL: 'none',
    AGENT_COMPACTION: 'off',
    MCP_SERVERS: JSON.stringify({ docs: { url: mcp.url } }),
    SESSION_IDLE_TIMEOUT_MS: '0',
    TURN_MAX_ATTEMPTS: '4',
    LEASE_TTL_MS: '3000',
    SSE_KEEPALIVE_MS: '1000',
    ...vars,
  }
  let dev = await startDev(all, persist)
  const stack: IStack = {
    get base() {
      return dev.base
    },
    model,
    mcp,
    get dev() {
      return dev
    },
    vars: all,
    persist,
    restart: async () => {
      await dev.kill()
      dev = await startDev(all, persist)
    },
    stop: async () => {
      await dev.kill()
      await model.close()
      await mcp.close()
      rmSync(persist, { recursive: true, force: true })
    },
  }
  return stack
}

export const until = async <T>(
  what: string,
  fn: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 60_000,
  everyMs = 100,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v !== undefined && v !== false) {
      return v
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

export const api = (stack: { base: string }) => {
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`${stack.base}${path}`, {
      method: 'POST',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const get = async (path: string) => {
    const res = await fetch(`${stack.base}${path}`, { headers })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return {
    headers: { authorization: `Bearer ${TOKEN}` },
    post,
    get,
    // The session's state until `ok` says so.
    state: (sessionId: string, ok: (s: ISessionState) => boolean, timeoutMs = 60_000) =>
      until(
        `session ${sessionId}`,
        async () => {
          const r = await get(`/sessions/${sessionId}`)
          return r.status === 200 && ok(r.body as unknown as ISessionState)
            ? (r.body as unknown as ISessionState)
            : undefined
        },
        timeoutMs,
        200,
      ),
  }
}

export interface ISessionState {
  status: string
  turn: number
  parked?: {
    turn: number
    runId: string
    requests: { requestId: string; kind: string; subagent?: unknown }[]
    answered: string[]
    waiting?: { itemId: string; workflowId: string; requests: { requestId: string }[] }[]
  }
  history: { role: string; content: string }[]
  turns: { turn: number; status: string; text?: string; error?: string; attempt?: number }[]
}

// A stream read until `stop`: a 503 (the session's cap on open streams, while the object is still
// letting go of a stream the client just left) is tried again.
export const readStream = async (
  url: string,
  headers: Record<string, string>,
  stop: (seen: ISseEvent[]) => boolean,
  timeoutMs = 60_000,
): Promise<{ status: number; events: ISseEvent[] }> => {
  for (let i = 0; ; i++) {
    const got = await readSse(url, headers, stop, timeoutMs)
    if (got.status !== 503 || i >= 50) return got
    await new Promise((r) => setTimeout(r, 200))
  }
}

import { readSse, type ISseEvent } from '../tests/helpers/sse.ts'
export { readSse, type ISseEvent }
