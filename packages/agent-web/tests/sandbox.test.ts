import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import {
  createAgent,
  createFileTools,
  fileToolBindingOf,
  VirtualFileSystem,
  type AgentEvent,
  type BrowserAgentConfig,
  type ISandboxResult,
  type SandboxConfig,
  type SandboxWorkerLike,
  type ToolApprovalRequest,
} from '../dist/index.js'
import { serveSandboxWorker } from '../dist/sandbox-worker.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// `config.sandbox` through the real agent loop: a model that calls run_js, the gates, the
// engine. The engine's own guards (interrupt, memory, no host objects, the module resolver)
// are tested where the engine is tested - the Node package's tests/sandbox-engine.test.ts, which
// also asserts that src/sandbox/engine.ts here is the same file byte for byte. This suite covers
// what is this package's: where the guest runs, the workspace binding, the switch.

const plan = JSON.stringify({ thought: 'Run it.', steps: [{ description: 'Run the code' }] })

/** A model that calls run_js once with `args`, then reports what came back. */
const runner =
  (args: unknown) =>
  (info: CallInfo): Reply => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan }
      case 'executor':
        if (info.toolResults > 0) return { text: 'Ran it.' }
        return info.tools.includes('run_js')
          ? { toolCalls: [{ name: 'run_js', args }] }
          : { text: 'I have no way to run it.' }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'finish', reason: 'done' }) }
      default:
        return { text: 'Done.' }
    }
  }

interface Outcome {
  ok: boolean
  /** run_js's result (or the tool error text when the call itself failed). */
  out: ISandboxResult
  error: string
  events: AgentEvent[]
  calls: CallInfo[]
  warnings: string[]
}

const drive = async (
  args: unknown,
  sandbox: BrowserAgentConfig['sandbox'],
  extra: Partial<BrowserAgentConfig> = {},
): Promise<Outcome> => {
  const m = scriptedModel(runner(args))
  const warnings: string[] = []
  const agent = await createAgent({
    model: m.model,
    sandbox,
    replan: false,
    logger: { warn: (...a: unknown[]) => warnings.push(a.join(' ')) } as never,
    ...extra,
  })
  const events: AgentEvent[] = []
  await agent.run('run the code', { onEvent: (e) => events.push(e) })
  const result = events.find(
    (e): e is Extract<AgentEvent, { type: 'step.tool-result' }> =>
      e.type === 'step.tool-result' && e.name === 'run_js',
  )
  return {
    ok: result?.ok === true,
    out: (result?.output ?? {}) as ISandboxResult,
    error: result && !result.ok ? errorOf(result.output) : '',
    events,
    calls: m.calls,
    warnings,
  }
}

const errorOf = (output: unknown): string =>
  output instanceof Error
    ? output.message
    : typeof output === 'string'
      ? output
      : JSON.stringify(output)

const js = (code: string, sandbox: BrowserAgentConfig['sandbox'] = true, extra = {}) =>
  drive({ code }, sandbox, extra)

/** A real thread (see helpers/sandbox-thread.mjs), counted. */
const threads = () => {
  const state = { made: 0, terminated: 0 }
  const worker = (): SandboxWorkerLike => {
    state.made += 1
    const w = new Worker(new URL('./helpers/sandbox-thread.mjs', import.meta.url), {
      resourceLimits: { stackSizeMb: 16 },
    })
    return {
      postMessage: (m) => w.postMessage(m),
      addEventListener: (type, listener) => {
        if (type === 'message') w.on('message', (data) => listener({ data }))
        if (type === 'error') w.on('error', (err) => listener({ message: String(err) }))
      },
      terminate: () => {
        state.terminated += 1
        void w.terminate()
      },
    }
  }
  return { state, worker }
}

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

const UNINTERRUPTIBLE =
  'const s = "a".repeat(1 << 24); let n = 0; for (let i = 0; i < 100000; i++) n += s.indexOf("b"); n'

const workspace = async (files: Record<string, string> = {}) => {
  const vfs = new VirtualFileSystem({ memory: true })
  for (const [path, content] of Object.entries(files)) await vfs.write(path, content)
  return vfs
}

// ── the switch ───────────────────────────────────────────────────────────────

test('sandbox on: the model calls run_js, gets stdout and the result, and the stages are told', async () => {
  const r = await js('console.log("sum", [1, 2, 3].reduce((a, b) => a + b)); 6 * 7')
  assert.equal(r.ok, true)
  assert.deepEqual(
    { ok: r.out.ok, stdout: r.out.stdout, result: r.out.result, truncated: r.out.truncated },
    { ok: true, stdout: 'sum 6\n', result: 42, truncated: false },
  )
  assert.ok(r.events.some((e) => e.type === 'step.tool-call' && e.name === 'run_js'))
  const executor = r.calls.filter((c) => stageOf(c) === 'executor')
  assert.match(executor[0].system, /- run_js runs JavaScript you wrote in an isolated sandbox/)
  assert.match(executor[0].system, /Never say that code was run/)
  assert.match(executor[0].system, /no files/)
  assert.equal(executor[0].system, executor[1].system, 'run-stable')
  assert.match(
    r.calls.find((c) => stageOf(c) === 'planner')!.system,
    /plan a step that calls run_js/,
  )
  assert.match(
    r.calls.find((c) => stageOf(c) === 'synthesizer')!.system,
    /only when a run_js call returned it/,
  )
})

test('guard off by default: no tool, no prompt change, and the engine is never loaded', async () => {
  const off = await drive({ code: '1 + 1' }, undefined)
  assert.equal(off.ok, false)
  assert.ok(off.calls.every((c) => !c.tools.includes('run_js')))
  assert.ok(off.calls.every((c) => !/run_js|sandbox/i.test(c.system)))
  assert.ok(off.warnings.every((w) => !/sandbox/.test(w)))
  const no = await js('1 + 1', false)
  assert.ok(no.calls.every((c) => !c.tools.includes('run_js')))

  // On, the engine is loaded on the first run - not when the agent is created.
  let loads = 0
  const m = scriptedModel(runner({ code: '1 + 1' }))
  const agent = await createAgent({
    model: m.model,
    replan: false,
    logLevel: 'silent',
    sandbox: {
      engine: () => {
        loads += 1
        return import('quickjs-emscripten')
      },
    },
  })
  assert.equal(loads, 0, 'creating the agent loads nothing')
  await agent.run('run')
  assert.equal(loads, 1)

  // And the build keeps it that way: the core entry never names the peer, and reaches the
  // sandbox code through a dynamic import only.
  const core = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(core, /from\s*["']quickjs-emscripten["']/)
  assert.doesNotMatch(core, /import\(\s*["']quickjs-emscripten["']\s*\)/)
  assert.doesNotMatch(core, /^import .*from\s*["']\.\/sandbox-[A-Z0-9]+\.js["']/m)
  assert.match(core, /import\(\s*["']\.\/sandbox-[A-Z0-9]+\.js["']\s*\)/)
})

test('guard missing peer: a clear error that names the package to install', async () => {
  const r = await js('1', {
    engine: () =>
      Promise.reject(new Error("Failed to resolve module specifier 'quickjs-emscripten'")),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /needs the optional package "quickjs-emscripten"/)
  assert.match(r.error, /npm install quickjs-emscripten/)
  const wrong = await js('1', { engine: async () => ({ notTheEngine: true }) })
  assert.match(wrong.error, /npm install quickjs-emscripten/)
})

test('sandbox: run_js is a write for the consent gate, and counts against the tool budget', async () => {
  const denied = await js('1', true, { toolApproval: { mode: 'read-only' } })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /read-only/)

  const asked: ToolApprovalRequest[] = []
  const ask = await js('40 + 2', true, {
    toolApproval: {
      mode: 'ask-writes',
      onRequest: (req: ToolApprovalRequest) => {
        asked.push(req)
        return true
      },
    },
  })
  assert.equal(ask.out.result, 42)
  assert.deepEqual(
    asked.map((a) => [a.toolName, a.readOnly, a.input]),
    [['run_js', false, { code: '40 + 2' }]],
  )

  const excluded = await js('1', true, { excludedTools: ['run_js'] })
  assert.ok(excluded.calls.every((c) => !c.tools.includes('run_js') && !/run_js/.test(c.system)))
})

test('guard caps: code and output sizes', async () => {
  const long = await js(`"${'x'.repeat(500)}"`, { maxCodeChars: 200 })
  assert.match(long.error, /the code is 502 characters; the limit is 200/)
  const empty = await drive({ code: '  ' }, true)
  assert.match(empty.error, /pass "code"/)
  const loud = await js('console.log("x".repeat(1e6)); "y".repeat(1e6)', { maxOutputChars: 400 })
  assert.equal(loud.out.stdout.length, 400)
  assert.equal(loud.out.truncated, true)
  assert.ok(JSON.stringify(loud.out).length < 1200)
})

// ── where the guest runs ─────────────────────────────────────────────────────

test('page thread (no worker): isolated, stopped by the interrupt handler, and it says so', async () => {
  const started = Date.now()
  const r = await js('console.log("going"); while (true) {}', { timeoutMs: 300 })
  assert.equal(r.out.ok, false)
  assert.equal(r.out.error?.name, 'TimeoutError')
  assert.equal(r.out.stdout, 'going\n')
  assert.ok(Date.now() - started < 3000)
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /no sandbox\.worker: run_js runs on the page thread/)

  const globals = await js(
    '["process", "fetch", "XMLHttpRequest", "WebSocket", "window", "document", "self", "indexedDB", "localStorage", "navigator", "fs"].filter((n) => typeof globalThis[n] !== "undefined")',
  )
  assert.deepEqual(globals.out.result, [])
  const escape = await js(
    '[Function("return typeof process")(), (0).constructor.constructor("return typeof fetch")()]',
  )
  assert.deepEqual(escape.out.result, ['undefined', 'undefined'])
  const oom = await js(
    'const a = []; for (;;) a.push(new Array(1000).fill("x".repeat(64) + a.length))',
    {
      memoryLimitBytes: 16 * 1024 * 1024,
    },
  )
  assert.match(oom.out.error?.message ?? '', /out of memory/)
})

test('worker: one fresh worker per run, terminated afterwards', async () => {
  const t = threads()
  const m = scriptedModel(runner({ code: 'globalThis.n = (globalThis.n ?? 0) + 1; globalThis.n' }))
  const warnings: string[] = []
  const agent = await createAgent({
    model: m.model,
    replan: false,
    logger: { warn: (...a: unknown[]) => warnings.push(a.join(' ')) } as never,
    sandbox: { worker: t.worker },
  })
  const results: unknown[] = []
  for (let i = 0; i < 2; i++) {
    await agent.run('run', {
      onEvent: (e) => {
        if (e.type === 'step.tool-result') results.push((e.output as ISandboxResult).result)
      },
    })
  }
  assert.deepEqual(results, [1, 1], 'the second run saw nothing of the first')
  assert.deepEqual(t.state, { made: 2, terminated: 2 })
  assert.deepEqual(warnings, [], 'no page-thread warning with a worker')
})

test('guard timeout (worker): an infinite loop ends at the deadline; the agent thread stays responsive', async () => {
  const t = threads()
  const { value: r, ticks } = await whileTicking(() =>
    js('console.log("going"); while (true) {}', { timeoutMs: 400, worker: t.worker }),
  )
  assert.equal(r.out.error?.name, 'TimeoutError')
  assert.equal(r.out.stdout, 'going\n')
  assert.ok(ticks >= 20, `ticked ${ticks} times while the guest looped`)
  assert.equal(t.state.terminated, 1)
})

test('guard timeout (worker, hard): a guest the interrupt cannot stop is terminated', async () => {
  const t = threads()
  const started = Date.now()
  const { value: r, ticks } = await whileTicking(() =>
    js(UNINTERRUPTIBLE, { timeoutMs: 300, worker: t.worker }),
  )
  const took = Date.now() - started
  assert.equal(r.out.error?.name, 'TimeoutError')
  assert.match(r.out.error?.message ?? '', /killed after 300 ms/)
  assert.ok(took >= 1200 && took < 6000, `took ${took} ms`)
  assert.ok(ticks >= 50, `ticked ${ticks} times`)
  assert.equal(t.state.terminated, 1)
  const after = await js('"alive"', { worker: t.worker })
  assert.equal(after.out.result, 'alive', 'a run after a killed one gets a fresh worker')
})

test('worker: a factory that fails falls back to the page thread, with a warning', async () => {
  const r = await js('1 + 1', {
    worker: () => {
      throw new Error('Worker is not defined')
    },
  })
  assert.equal(r.out.result, 2)
  assert.ok(r.warnings.some((w) => /sandbox\.worker failed \(Worker is not defined\)/.test(w)))
})

test('worker: the shipped entry serves over any message port', async () => {
  const r = await js('console.log("via port"); 5', {
    worker: () => {
      const channel = new MessageChannel()
      serveSandboxWorker({ scope: channel.port2 })
      return Object.assign(channel.port1, {
        terminate: () => {
          channel.port1.close()
          channel.port2.close()
        },
      }) as unknown as SandboxWorkerLike
    },
  })
  assert.deepEqual([r.out.stdout, r.out.result], ['via port\n', 5])
})

// ── the workspace ────────────────────────────────────────────────────────────

const FILES = {
  '/lib/math.js':
    'export const double = (x) => x * 2\nexport default function inc(x) { return x + 1 }',
  '/lib/util.js':
    'const data = require("../data.json"); exports.total = () => data.items.reduce((a, b) => a + b, 0)',
  '/data.json': '{"items": [1, 2, 3]}',
  '/main.js':
    'import inc, { double } from "./lib/math.js"\nconsole.log("main", double(4))\nexport default inc(41)',
  '/notes.txt': 'hello from the workspace',
  '/secret.txt': 'export default "not a module"',
}

test('files: import, require and fs go through the agent workspace', async () => {
  const vfs = await workspace(FILES)
  const tools = createFileTools(vfs)
  const esm = await js(
    'import inc, { double } from "./lib/math.js"; import data from "./data.json"; export default [inc(1), double(4), data.items.length]',
    true,
    { tools },
  )
  assert.deepEqual(esm.out.result, [2, 8, 3])
  const cjs = await js('require("./lib/util.js").total()', true, { tools })
  assert.equal(cjs.out.result, 6)

  const fs = await js(
    'const text = await fs.readFile("/notes.txt"); await fs.writeFile("/out/report.md", text.toUpperCase()); (await fs.readdir("/out")).concat(await fs.readdir("/lib"))',
    true,
    { tools },
  )
  assert.deepEqual(fs.out.result, ['/out/report.md', '/lib/math.js', '/lib/util.js'])
  assert.equal((await vfs.read('/out/report.md'))?.content, 'HELLO FROM THE WORKSPACE')

  const entry = await drive({ entry: '/main.js' }, true, { tools })
  assert.deepEqual([entry.out.stdout, entry.out.result], ['main 8\n', 42])
  // A file the guest wrote in one run is a module of the next.
  await js('await fs.writeFile("/gen.js", "exports.v = 7")', true, { tools })
  assert.equal((await js('require("./gen.js").v', true, { tools })).out.result, 7)

  const executor = esm.calls.find((c) => stageOf(c) === 'executor')!
  assert.match(executor.system, /workspace files are reachable by relative path/)
  assert.doesNotMatch(executor.system, /no files/)
})

test('guard files: traversal, other extensions, missing and oversize files are refused', async () => {
  const vfs = await workspace({
    ...FILES,
    '/big.js': `export default "${'x'.repeat(3000)}"`,
    '/huge.txt': 'h'.repeat(1_100_000),
  })
  await vfs.write('/image.png', new Uint8Array([137, 80, 78, 71]))
  const tools = createFileTools(vfs)
  const refused: [string, RegExp][] = [
    ['require("../outside.js")', /leaves the workspace/],
    ['require("./lib/../../etc/passwd.js")', /leaves the workspace/],
    ['await import("../../x.mjs")', /leaves the workspace/],
    ['await fs.readFile("../../etc/passwd")', /escapes the root/],
    ['await fs.writeFile("../x.txt", "x")', /escapes the root/],
    ['await fs.readdir("../..")', /escapes the root/],
    ['require("./secret.txt")', /only \.js, \.mjs, \.json/],
    ['import x from "./notes.txt"; x', /only \.js, \.mjs, \.json/],
    ['require("fs")', /no packages/],
    ['require("file:///etc/passwd.js")', /no packages/],
    ['require("./nope.js")', /no such file in the workspace/],
    ['await fs.readFile("/nope.txt")', /no file "\/nope\.txt"/],
    ['await fs.readFile("/image.png")', /binary file/],
    ['await fs.readFile("/huge.txt")', /reads at most 1000000/],
    ['await fs.writeFile("/w.txt", "x".repeat(1_000_001))', /writes at most 1000000/],
    ['await fs.writeFile("/w.txt", { not: "text" })', /must be a string/],
    ['await fs.unlink("/notes.txt")', /not a function/],
  ]
  for (const [code, message] of refused) {
    const r = await js(code, true, { tools })
    assert.equal(r.out.ok, false, code)
    assert.match(r.out.error?.message ?? '', message, code)
  }
  assert.equal(await vfs.read('/w.txt'), undefined)
  assert.equal(await vfs.read('/x.txt'), undefined)

  // A module larger than maxCodeChars is not handed to the guest.
  const big = await js('require("./big.js")', { maxCodeChars: 2000 }, { tools })
  assert.match(big.out.error?.message ?? '', /no such file in the workspace/)
  // An entry must be a script, and inside the workspace.
  for (const [entry, message] of [
    ['/notes.txt', /must be a \.js or \.mjs file/],
    ['/data.json', /must be a \.js or \.mjs file/],
    ['../main.js', /escapes the root/],
    ['/missing.js', /no file/],
  ] as [string, RegExp][]) {
    const r = await drive({ entry }, true, { tools })
    assert.equal(r.ok, false, entry)
    assert.match(r.error, message, entry)
  }
  const both = await drive({ code: '1', entry: '/main.js' }, true, { tools })
  assert.match(both.error, /either "code" or "entry"/)
})

test('guard files: files false, or no file tools - no loader, no fs, no entry', async () => {
  const vfs = await workspace(FILES)
  const tools = createFileTools(vfs)
  for (const [sandbox, extra] of [
    [{ files: false }, { tools }],
    [true, {}],
  ] as [SandboxConfig | true, Partial<BrowserAgentConfig>][]) {
    const probe = await js('[typeof fs, typeof require]', sandbox, extra)
    assert.deepEqual(probe.out.result, ['undefined', 'function'])
    const load = await js('require("./lib/math.js")', sandbox, extra)
    assert.match(load.out.error?.message ?? '', /this sandbox has no files/)
    const imported = await js('import d from "./data.json"; d', sandbox, extra)
    assert.match(imported.out.error?.message ?? '', /this sandbox has no files/)
    const entry = await drive({ entry: '/main.js' }, sandbox, extra)
    assert.match(entry.error, /"entry" needs workspace files/)
    assert.equal(entry.out.stdout, undefined, 'the file was not run')
    assert.match(probe.calls.find((c) => stageOf(c) === 'executor')!.system, /no files/)
  }
})

test('guard files: the guest gets what the file tools grant - no more', async () => {
  const vfs = await workspace(FILES)
  // A read-only mount: reading works, writing does not exist.
  const readOnly = await js('[Object.keys(fs), await fs.readFile("/notes.txt")]', true, {
    tools: createFileTools(vfs, { readOnly: true }),
  })
  assert.deepEqual(readOnly.out.result, [['readFile', 'readdir'], 'hello from the workspace'])
  // The write tool excluded by the host: same.
  const excluded = await js('Object.keys(fs)', true, {
    tools: createFileTools(vfs),
    excludedTools: ['fs_write'],
  })
  assert.deepEqual(excluded.out.result, ['readFile', 'readdir'])
  // A rule that denies fs_write denies the guest's writes; nothing is written.
  const denied = await js(
    'let e; try { await fs.writeFile("/denied.txt", "x") } catch (x) { e = x.message } e',
    true,
    { tools: createFileTools(vfs), toolApproval: { rules: { fs_write: 'deny' } } },
  )
  assert.match(String(denied.out.result), /denied/)
  assert.equal(await vfs.read('/denied.txt'), undefined)
  // A rule that denies fs_read hides the workspace from import and fs alike.
  const blind = await js(
    'let e; try { await fs.readFile("/notes.txt") } catch (x) { e = x.message } let m; try { require("./lib/math.js") } catch (x) { m = x.message } [e, m]',
    true,
    { tools: createFileTools(vfs), toolApproval: { rules: { fs_read: 'deny' } } },
  )
  assert.match(String((blind.out.result as string[])[0]), /denied/)
  assert.match(String((blind.out.result as string[])[1]), /no such file in the workspace/)

  // ask-writes: the run is asked for, then each write under the file tool's own name - and the
  // time the user takes to answer is not the guest's time.
  const asked: [string, boolean, unknown][] = []
  const ask = await js(
    'await fs.readFile("/notes.txt"); await fs.writeFile("/asked.txt", "ok"); "written"',
    { timeoutMs: 300 },
    {
      tools: createFileTools(vfs),
      toolApproval: {
        mode: 'ask-writes',
        onRequest: async (req: ToolApprovalRequest) => {
          asked.push([req.toolName, req.readOnly, req.input])
          await new Promise((r) => setTimeout(r, 400))
          return true
        },
      },
    },
  )
  assert.equal(ask.out.result, 'written')
  assert.deepEqual(asked, [
    [
      'run_js',
      false,
      {
        code: 'await fs.readFile("/notes.txt"); await fs.writeFile("/asked.txt", "ok"); "written"',
      },
    ],
    ['fs_write', false, { path: '/asked.txt', content: 'ok' }],
  ])
  assert.equal((await vfs.read('/asked.txt'))?.content, 'ok')
})

test('guard files: a worker is the guest side - what it asks for is judged again by the agent', async () => {
  const vfs = await workspace(FILES)
  // Not the engine: a "worker" that asks for file operations by itself, as a compromised one would.
  const forged = (op: string, args: unknown[]) => (): SandboxWorkerLike => {
    const channel = new MessageChannel()
    channel.port2.on(
      'message',
      (m: { type: string; ok?: boolean; error?: string; value?: unknown }) => {
        if (m.type === 'run') {
          channel.port2.postMessage({ type: 'started' })
          channel.port2.postMessage({ type: 'host-call', id: 1, op, args })
        } else if (m.type === 'host-result') {
          channel.port2.postMessage({
            type: 'done',
            result: {
              ok: true,
              stdout: '',
              result: m.ok ? ['served', m.value] : ['refused', m.error],
            },
          })
        }
      },
    )
    return Object.assign(channel.port1, {
      terminate: () => {
        channel.port1.close()
        channel.port2.close()
      },
    }) as unknown as SandboxWorkerLike
  }
  const readOnly = { tools: createFileTools(vfs, { readOnly: true }) }
  const cases: [string, unknown[], RegExp][] = [
    ['writeFile', ['/forged.txt', 'x'], /writing files is not available/],
    ['readFile', ['../../etc/passwd'], /escapes the root/],
    ['readFile', [{ path: '/notes.txt' }], /a path \(string\) is required/],
    ['unlink', ['/notes.txt'], /fs\.unlink is not available/],
    ['delete', ['/notes.txt'], /fs\.delete is not available/],
  ]
  for (const [op, args, message] of cases) {
    const r = await js('1', { worker: forged(op, args) }, readOnly)
    const [verdict, detail] = r.out.result as [string, string]
    assert.equal(verdict, 'refused', op)
    assert.match(detail, message, op)
  }
  assert.equal(await vfs.read('/forged.txt'), undefined)
  assert.ok(await vfs.read('/notes.txt'), 'nothing was deleted')
  // And with no file tools at all there is nobody to ask.
  const none = await js('1', { worker: forged('readFile', ['/notes.txt']) })
  assert.match((none.out.result as string[])[1], /no files/)
})

test('files through a worker: file calls are served on the agent side', async () => {
  const vfs = await workspace(FILES)
  const t = threads()
  const r = await js(
    'const { total } = require("./lib/util.js"); await fs.writeFile("/total.txt", String(total())); await fs.readFile("/total.txt")',
    { worker: t.worker },
    { tools: createFileTools(vfs) },
  )
  assert.equal(r.out.result, '6')
  assert.equal((await vfs.read('/total.txt'))?.content, '6')
})

test('createFileTools: each tool says which file system it works on', async () => {
  const vfs = await workspace()
  const tools = createFileTools(vfs, { prefix: 'ws_' })
  assert.deepEqual(
    Object.entries(tools).map(([name, t]) => [name, fileToolBindingOf(t)?.op]),
    [
      ['ws_list', 'list'],
      ['ws_read', 'read'],
      ['ws_write', 'write'],
      ['ws_delete', 'delete'],
    ],
  )
  assert.equal(fileToolBindingOf(tools.ws_read)?.vfs, vfs)
  assert.equal(fileToolBindingOf({}), undefined)
  // The binding is found under any prefix.
  const r = await js('await fs.readdir("/")', true, { tools })
  assert.deepEqual(r.out.result, [])
})
