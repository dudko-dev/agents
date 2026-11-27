import assert from 'node:assert/strict'
import test from 'node:test'
import type { Tool } from 'ai'
import {
  createSandboxTool,
  createSandboxTools,
  RUN_JS_TOOL,
  SandboxUnavailableError,
  sandboxStats,
  sandboxWorkerUrl,
  type ISandboxConfig,
  type ISandboxResult,
} from '../src/sandbox.ts'
import { isReadOnlyTool } from '../src/approval.ts'
import { parseSandbox } from '../src/cli/config.ts'

// The tool as the agent mounts it: every run in a REAL worker thread (src/sandbox-worker.ts).

const call = (tool: Tool, code: string, signal?: AbortSignal): Promise<ISandboxResult> =>
  (
    tool.execute as unknown as (
      input: { code: string },
      options: { abortSignal?: AbortSignal; toolCallId: string; messages: [] },
    ) => Promise<ISandboxResult>
  )({ code }, { abortSignal: signal, toolCallId: 't', messages: [] })

const run = (code: string, config: ISandboxConfig = {}): Promise<ISandboxResult> =>
  call(createSandboxTool(config), code)

// While the guest runs, the agent's thread must keep turning: count timer ticks.
const whileTicking = async <T>(work: () => Promise<T>): Promise<{ value: T; ticks: number }> => {
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 10)
  try {
    return { value: await work(), ticks }
  } finally {
    clearInterval(timer)
  }
}

// One native call the engine's interrupt handler cannot stop: nothing inside it checks.
const UNINTERRUPTIBLE =
  'const s = "a".repeat(1 << 24); let n = 0; for (let i = 0; i < 100000; i++) n += s.indexOf("b"); n'

test('run_js: runs in a worker and returns stdout, result and timing', async () => {
  const before = sandboxStats.workers
  const r = await run('console.log("hello"); [1, 2, 3].map((x) => x * 2)')
  assert.deepEqual(
    { ok: r.ok, stdout: r.stdout, result: r.result, truncated: r.truncated },
    { ok: true, stdout: 'hello\n', result: [2, 4, 6], truncated: false },
  )
  assert.ok(r.durationMs > 0)
  assert.equal(sandboxStats.workers, before + 1, 'one worker per run')
  assert.match(sandboxWorkerUrl().href, /sandbox-worker\.ts$/)
})

test('run_js: the tool is a write for the approval gate and takes only code here', () => {
  const tool = createSandboxTool()
  assert.equal(isReadOnlyTool(tool), false)
  assert.match(String(tool.description), /no network/)
  assert.match(String(tool.description), /no files/)
})

test('guard timeout: an infinite loop ends at the deadline and the agent thread stays responsive', async () => {
  const started = Date.now()
  const { value: r, ticks } = await whileTicking(() =>
    run('console.log("going"); while (true) {}', { timeoutMs: 400 }),
  )
  const took = Date.now() - started
  assert.equal(r.ok, false)
  assert.equal(r.error?.name, 'TimeoutError')
  assert.equal(r.stdout, 'going\n')
  assert.ok(took < 3000, `took ${took} ms`)
  assert.ok(ticks >= 20, `the main thread ticked ${ticks} times while the guest looped`)
})

test('guard timeout (hard): a guest the interrupt cannot stop is killed with its worker', async () => {
  const started = Date.now()
  const { value: r, ticks } = await whileTicking(() => run(UNINTERRUPTIBLE, { timeoutMs: 300 }))
  const took = Date.now() - started
  assert.equal(r.ok, false)
  assert.equal(r.error?.name, 'TimeoutError')
  assert.match(r.error?.message ?? '', /killed after 300 ms/)
  // timeoutMs + the 1 s grace + starting the worker; without the kill this would run for minutes.
  assert.ok(took >= 1200 && took < 5000, `took ${took} ms`)
  assert.ok(ticks >= 50, `the main thread ticked ${ticks} times`)
})

test('guard concurrency: runs share nothing, and a run after a killed one works', async () => {
  const tool = createSandboxTool({ timeoutMs: 400 })
  const [a, b, dead] = await Promise.all([
    call(
      tool,
      'globalThis.mark = "a"; Object.prototype.mark = "a"; await new Promise((r) => setTimeout(r, 50)); globalThis.mark',
    ),
    call(
      tool,
      'await new Promise((r) => setTimeout(r, 20)); [typeof globalThis.mark, typeof ({}).mark]',
    ),
    call(tool, 'globalThis.mark = "dead"; while (true) {}'),
  ])
  assert.equal(a.result, 'a')
  assert.deepEqual(b.result, ['undefined', 'undefined'])
  assert.equal(dead.error?.name, 'TimeoutError')
  const after = await call(tool, '[typeof globalThis.mark, 1 + 1]')
  assert.deepEqual(after.result, ['undefined', 2])
  const afterKill = await run(UNINTERRUPTIBLE, { timeoutMs: 100 })
  assert.equal(afterKill.error?.name, 'TimeoutError')
  assert.match(afterKill.error?.message ?? '', /killed after 100 ms/)
  assert.equal((await call(tool, '"alive"')).result, 'alive')
})

test('guard timeout: a slow start (a busy machine) is not the guest time - and the kill still comes', async () => {
  // A 100 ms limit used to cover the engine's start as well: on a busy machine that start
  // alone outlasted it and the run failed with "the sandbox runtime failed to start".
  const slow = createSandboxTool(
    { timeoutMs: 100 },
    { workerUrl: new URL('./fixtures/sandbox-slow-start-worker.ts', import.meta.url) },
  )
  const quick = await call(slow, 'console.log("ran"); 6 * 7')
  assert.deepEqual(
    { ok: quick.ok, stdout: quick.stdout, result: quick.result, error: quick.error },
    { ok: true, stdout: 'ran\n', result: 42, error: undefined },
  )
  assert.ok(quick.durationMs >= 400, 'the start is in the run duration, not in the limit')
  const killed = await call(slow, UNINTERRUPTIBLE)
  assert.equal(killed.error?.name, 'TimeoutError')
  assert.match(killed.error?.message ?? '', /killed after 100 ms/)
})

test('guard concurrency: more than four runs queue instead of starting more workers at once', async () => {
  const tool = createSandboxTool({ timeoutMs: 2000 })
  const before = sandboxStats.workers
  const all = Array.from({ length: 6 }, (_, i) =>
    call(tool, `await new Promise((r) => setTimeout(r, 300)); ${i}`),
  )
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(sandboxStats.workers - before, 4, 'four started, two wait')
  const results = await Promise.all(all)
  assert.deepEqual(
    results.map((r) => r.result),
    [0, 1, 2, 3, 4, 5],
  )
  assert.equal(sandboxStats.workers - before, 6)
})

test('guard memory: a guest that allocates without end fails alone; the process and the next run live', async () => {
  const r = await run(
    'const a = []; for (;;) a.push(new Array(1000).fill("x".repeat(64) + a.length))',
    {
      memoryLimitBytes: 16 * 1024 * 1024,
    },
  )
  assert.equal(r.ok, false)
  assert.match(r.error?.message ?? '', /out of memory/)
  const big = await run('new Uint8Array(512 * 1024 * 1024).length')
  assert.equal(big.ok, false)
  assert.equal((await run('"still here"')).result, 'still here')
})

test('guard escape: nothing of Node is reachable from inside the worker either', async () => {
  const r = await run(
    `const names = ['process', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Deno', 'Bun', 'fs', 'Buffer', 'global', 'parentPort', 'workerData', 'WebAssembly'];
    ({
      present: names.filter((n) => n !== 'require' && typeof globalThis[n] !== 'undefined'),
      viaFunction: Function('return typeof process')(),
      viaConstructor: (function () {}).constructor.constructor('return typeof process')(),
    })`,
  )
  assert.deepEqual(r.result, { present: [], viaFunction: 'undefined', viaConstructor: 'undefined' })
  for (const code of [
    'require("fs")',
    'require("node:worker_threads")',
    'await import("node:fs")',
  ]) {
    const refused = await run(code)
    assert.match(refused.error?.message ?? '', /Cannot load/, code)
  }
  // The worker thread is given none of the process's environment: an escape would find no secrets.
  process.env.SANDBOX_TEST_SECRET = 'zq-secret-zq'
  try {
    const probe = createSandboxTool(
      {},
      { workerUrl: new URL('./fixtures/sandbox-env-worker.ts', import.meta.url) },
    )
    await assert.rejects(call(probe, '1'), (e: Error) => {
      assert.match(e.message, /env=\[\]/)
      return true
    })
  } finally {
    delete process.env.SANDBOX_TEST_SECRET
  }
})

test('guard caps: code and output sizes', async () => {
  const tool = createSandboxTool({ maxCodeChars: 200, maxOutputChars: 300 })
  await assert.rejects(
    call(tool, `"${'x'.repeat(300)}"`),
    /the code is 302 characters; the limit is 200/,
  )
  await assert.rejects(call(tool, '   '), /"code" is empty/)
  const r = await call(tool, 'console.log("x".repeat(100000)); "y".repeat(100000)')
  assert.equal(r.stdout.length, 300)
  assert.equal(r.truncated, true)
  assert.ok(JSON.stringify(r).length < 1000, 'the whole result stays small')
})

test('run_js: aborting the call kills the worker', async () => {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 150)
  const started = Date.now()
  await assert.rejects(
    call(createSandboxTool({ timeoutMs: 30000 }), 'while (true) {}', ac.signal),
    (e: Error) => e.name === 'AbortError',
  )
  assert.ok(Date.now() - started < 2000)
})

test('guard off by default: no config, no tool - and nothing is started', () => {
  const before = sandboxStats.workers
  assert.equal(createSandboxTools(undefined), undefined)
  assert.equal(createSandboxTools(false), undefined)
  assert.equal(sandboxStats.workers, before)
  assert.deepEqual(Object.keys(createSandboxTools(true) ?? {}), [RUN_JS_TOOL])
  assert.deepEqual(Object.keys(createSandboxTools({ timeoutMs: 100 }) ?? {}), [RUN_JS_TOOL])
  assert.equal(sandboxStats.workers, before, 'creating the tool starts nothing either')
})

test('guard missing peer: a clear error that names the package to install', async () => {
  assert.throws(
    () => createSandboxTools(true, { peerInstalled: () => false }),
    (e: Error) => {
      assert.ok(e instanceof SandboxUnavailableError)
      assert.match(e.message, /optional package "quickjs-emscripten"/)
      assert.match(e.message, /npm install quickjs-emscripten/)
      return true
    },
  )
  // And when it disappears between creation and the run (the worker cannot import it).
  const tool = createSandboxTool(
    {},
    { workerUrl: new URL('./fixtures/sandbox-no-peer-worker.ts', import.meta.url) },
  )
  await assert.rejects(call(tool, '1'), (e: Error) => {
    assert.ok(e instanceof SandboxUnavailableError)
    assert.match(e.message, /npm install quickjs-emscripten/)
    return true
  })
})

test('CLI: AGENT_SANDBOX switches it on; limits without it are an error', () => {
  assert.equal(parseSandbox({}), undefined)
  assert.equal(parseSandbox({ AGENT_SANDBOX: 'off' }), undefined)
  assert.deepEqual(parseSandbox({ AGENT_SANDBOX: 'on' }), {})
  assert.deepEqual(
    parseSandbox({
      AGENT_SANDBOX: 'on',
      AGENT_SANDBOX_TIMEOUT_MS: '2000',
      AGENT_SANDBOX_MEMORY_MB: '64',
    }),
    { timeoutMs: 2000, memoryLimitBytes: 64 * 1024 * 1024 },
  )
  assert.throws(() => parseSandbox({ AGENT_SANDBOX: 'maybe' }), /must be on \| off/)
  assert.throws(
    () => parseSandbox({ AGENT_SANDBOX_TIMEOUT_MS: '2000' }),
    /AGENT_SANDBOX_TIMEOUT_MS set but AGENT_SANDBOX is off/,
  )
})
