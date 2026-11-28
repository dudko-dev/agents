import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as quickjs from 'quickjs-emscripten'
import {
  moduleSpecifiersOf,
  resolveModulePath,
  resolveSandboxLimits,
  runGuest,
  runInWorker,
  SANDBOX_CAPS,
  SANDBOX_MAX_HOST_CALLS,
  sandboxPromptNote,
  sanitizeSandboxResult,
  serveSandbox,
  SandboxUnavailableError,
  type ISandboxConfig,
  type ISandboxLib,
  type ISandboxPort,
  type ISandboxRequest,
  type SandboxHostCall,
} from '../src/sandbox-engine.ts'
import { slowStart } from './helpers/sandbox-slow-start.ts'

// The engine on THIS thread (no worker): what is tested here is what stops the guest by itself -
// the interrupt handler, the memory limit, the absence of any host object. The hard stop (a
// worker that is terminated) is tested in sandbox.test.ts.

const lib = quickjs as unknown as ISandboxLib
const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

const run = (
  code: string,
  config: ISandboxConfig = {},
  extra: Partial<ISandboxRequest> = {},
  hostCall?: SandboxHostCall,
) =>
  runGuest(
    lib,
    { code, limits: resolveSandboxLimits({ timeoutMs: 400, ...config }), ...extra },
    hostCall ? { hostCall } : {},
  )

test('engine: this file is the browser package copy, byte for byte', (t) => {
  const sibling = here('../../agent-web/src/sandbox/engine.ts')
  if (!existsSync(sibling)) {
    t.skip('the browser package is not in this checkout')
    return
  }
  assert.equal(
    readFileSync(here('../src/sandbox-engine.ts'), 'utf8'),
    readFileSync(sibling, 'utf8'),
    'sandbox-engine.ts and agent-web/src/sandbox/engine.ts must stay identical',
  )
})

test('engine: stdout in call order, the last expression as result', async () => {
  const r = await run(
    'console.log("a", 1, { k: [1, 2] }); console.warn("w"); console.error(new Error("e").message); console.info(null, undefined); 6 * 7',
  )
  assert.equal(r.ok, true)
  assert.equal(r.stdout, 'a 1 { k: [ 1, 2 ] }\n[warn] w\n[error] e\nnull undefined\n')
  assert.equal(r.result, 42)
  assert.equal(r.truncated, false)
  assert.equal(r.error, undefined)
})

test('engine: top-level await, a returned promise, and a module default export are the result', async () => {
  assert.equal((await run('const x = await Promise.resolve(4); x * 2')).result, 8)
  assert.deepEqual((await run('async function main() { return { a: 1 } } main()')).result, {
    a: 1,
  })
  assert.equal((await run('export default 5; export const other = 1')).result, 5)
  assert.equal((await run('const x = 1')).result, undefined)
  assert.ok(!Object.hasOwn(await run('const x = 1'), 'result'))
})

test('engine: timers run to the end of the program, like a process', async () => {
  const r = await run(
    'setTimeout(() => console.log("late"), 30); const id = setInterval(() => {}, 5); setTimeout(() => clearInterval(id), 40); console.log("first"); await new Promise((r) => setTimeout(r, 10)); "v"',
  )
  assert.equal(r.ok, true)
  assert.equal(r.stdout, 'first\nlate\n')
  assert.equal(r.result, 'v')
})

test('engine: an error is a result with the guest frames - and nothing of the host', async () => {
  const r = await run(
    'function a() { throw new RangeError("bad") }\nfunction b() { a() }\nconsole.log("before"); b()',
  )
  assert.equal(r.ok, false)
  assert.equal(r.stdout, 'before\n')
  assert.equal(r.error?.name, 'RangeError')
  assert.equal(r.error?.message, 'bad')
  assert.match(r.error?.stack ?? '', /at a \(\/main\.js:1:\d+\)\n\s+at b \(\/main\.js:2/)
  const rejected = await run('async function main() { throw new TypeError("boom") } main()')
  assert.equal(rejected.error?.name, 'TypeError')
  const syntax = await run('let x = ;')
  assert.equal(syntax.error?.name, 'SyntaxError')
  const thrown = await run('throw { code: 7 }')
  assert.match(thrown.error?.message ?? '', /code: 7/)
  // A host function that refuses (require) throws a guest error: no host frame in its stack.
  const refused = await run('require("fs")')
  for (const e of [r, rejected, syntax, thrown, refused]) {
    const all = JSON.stringify(e.error)
    assert.doesNotMatch(all, /node:|file:\/\/|sandbox-engine|<sandbox>|node_modules|quickjs/)
  }
})

test('guard timeout: an infinite loop ends at the deadline', async () => {
  const started = Date.now()
  const r = await run('console.log("start"); while (true) {}')
  const took = Date.now() - started
  assert.equal(r.ok, false)
  assert.equal(r.error?.name, 'TimeoutError')
  assert.match(r.error?.message ?? '', /400 ms/)
  assert.equal(r.stdout, 'start\n', 'what was printed before the stop is kept')
  assert.ok(took >= 380 && took < 2000, `stopped at the deadline, took ${took} ms`)
})

test('guard timeout: a guest that catches the interrupt cannot continue', async () => {
  const r = await run(
    'Promise.resolve().then(() => console.log("job")); setTimeout(() => console.log("timer"), 1);\n' +
      'for (;;) { try { while (true) {} } catch (e) { console.log("caught") } finally { console.log("finally") } }\n' +
      'console.log("after")',
  )
  assert.equal(r.error?.name, 'TimeoutError')
  assert.equal(r.stdout, '', 'no catch, no finally, no job and no timer ran after the stop')
})

test('guard timeout: waiting is bounded too (a timer past the deadline, a regex that backtracks)', async () => {
  const sleep = await run('await new Promise((r) => setTimeout(r, 60000)); "slept"')
  assert.equal(sleep.error?.name, 'TimeoutError')
  const interval = await run('setInterval(() => {}, 1); 1')
  assert.equal(interval.error?.name, 'TimeoutError')
  const regex = await run('/^(a|aa)+$/.test("a".repeat(40) + "b")')
  assert.equal(regex.error?.name, 'TimeoutError')
  const never = await run('await new Promise(() => {})')
  assert.match(never.error?.message ?? '', /never settle/)
})

// The engine's clock is Date.now(); Node's timers run on the event loop's own (monotonic) time.
// These tests move the first by hand and restore it afterwards.
const realNow = Date.now

test('guard timeout: a timer not due yet never runs its callback - not even when the clock reads the deadline exactly', async () => {
  // The edge CI hit: the host timers fire at the deadline, but Date.now() - programAt reads
  // exactly timeoutMs (two clocks, millisecond granularity), which is not over the limit. Here the
  // clock stalls at that value for 100 ms of real time and then goes on, so it happens every run.
  const timeoutMs = 400
  let last = 0
  let deadline = 0
  let stallEnds = 0
  Date.now = () => {
    const now = realNow()
    if (deadline && now >= deadline) {
      stallEnds ||= now + 100
      if (now < stallEnds) {
        return (last = deadline)
      }
    }
    return (last = now)
  }
  try {
    for (const code of [
      'await new Promise((r) => setTimeout(() => { console.log("woke"); r() }, 60000)); "slept"',
      'setTimeout(() => console.log("woke"), 60000); "ended"',
    ]) {
      deadline = 0
      stallEnds = 0
      const r = await runGuest(
        lib,
        { code, limits: resolveSandboxLimits({ timeoutMs }) },
        // Called right after the engine read the program's start from the clock.
        { onStart: () => (deadline = last + timeoutMs) },
      )
      assert.ok(stallEnds > 0, 'the clock did stall at the deadline')
      assert.equal(r.error?.name, 'TimeoutError', code)
      assert.equal(r.stdout, '', `the 60 s timer's callback never ran: ${code}`)
      assert.ok(!Object.hasOwn(r, 'result'), code)
    }
  } finally {
    Date.now = realNow
  }
})

test('guard timeout: while a file call waits, a timer runs its callback at its time - never before it', async () => {
  // No watchdog runs and the budget is paused while the host serves a call; a timer clamped to
  // the deadline used to run its callback at 400 ms, whatever it asked for.
  const slow: SandboxHostCall = () => new Promise((r) => setTimeout(() => r('read'), 700))
  const due = await run(
    'const t0 = Date.now(); const timer = new Promise((r) => setTimeout(() => r(Date.now() - t0), 900)); const text = await fs.readFile("/a"); ({ text, waited: await timer })',
    {},
    { hostOps: ['readFile'] },
    slow,
  )
  assert.equal(due.ok, true, JSON.stringify(due.error))
  const { text, waited } = due.result as { text: string; waited: number }
  assert.equal(text, 'read')
  // 900 ms of which 700 were the wait: 200 ms of the 400 ms budget.
  assert.ok(waited >= 900, `the 900 ms timer ran after ${waited} ms`)

  const past = await run(
    'setTimeout(() => console.log("early"), 30000); await fs.readFile("/a"); "read"',
    {},
    { hostOps: ['readFile'] },
    slow,
  )
  assert.equal(past.error?.name, 'TimeoutError')
  assert.equal(past.stdout, '', 'a timer past the deadline never runs, during a wait included')
})

test('guard timeout: a run whose time is spent ends at the deadline while a file call waits', async () => {
  // The guest spends its time in one long native call (no interrupt check inside one), then
  // waits on a file call: no watchdog runs while a call waits, so it is the guest's own timer,
  // not due yet, that finds the time is up. The clock jumps a second to stand for that call.
  let skew = 0
  Date.now = () => realNow() + skew
  let answer: ((value: unknown) => void) | undefined
  const fallback = setTimeout(() => answer?.('read'), 3000)
  try {
    const began = realNow()
    const r = await run(
      'setTimeout(() => console.log("woke"), 60000); await fs.readFile("/a"); "read"',
      {},
      { hostOps: ['readFile'] },
      () => {
        skew += 1000
        return new Promise((resolve) => (answer = resolve))
      },
    )
    const took = realNow() - began
    assert.equal(r.error?.name, 'TimeoutError')
    assert.equal(r.stdout, '')
    assert.ok(took < 2000, `stopped at the deadline, not when the call was answered: ${took} ms`)
  } finally {
    Date.now = realNow
    clearTimeout(fallback)
    answer?.('read')
  }
})

test('guard timeout: a guest whose time is spent is not entered again - not for an answer, not for a due timer', async () => {
  // As above, the clock jumps a second inside the guest (one long native call) before a file call.
  let skew = 0
  Date.now = () => realNow() + skew
  const answers: (() => void)[] = []
  try {
    const answered = await run(
      'await fs.readFile("/a"); console.log("after"); "read"',
      {},
      { hostOps: ['readFile'] },
      () => {
        skew += 1000
        return new Promise((resolve) => setTimeout(() => resolve('read'), 20))
      },
    )
    assert.equal(answered.error?.name, 'TimeoutError')
    assert.equal(answered.stdout, '', 'nothing ran after the answer came')

    skew = 0
    const fallback = setTimeout(() => answers.forEach((a) => a()), 3000)
    const timer = await run(
      'setTimeout(() => console.log("timer"), 10); await fs.readFile("/a"); "read"',
      {},
      { hostOps: ['readFile'] },
      () => {
        skew += 1000
        return new Promise((resolve) => answers.push(() => resolve('read')))
      },
    )
    clearTimeout(fallback)
    assert.equal(timer.error?.name, 'TimeoutError')
    assert.equal(timer.stdout, '', 'the due timer found the time spent and did not run')
  } finally {
    Date.now = realNow
    answers.forEach((a) => a())
  }
})

test('guard timers: once a run is over none of its host timers is left - one cleared after it slept again included', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const live = new Set<unknown>()
  let waiting = false
  let armedWhileWaiting = 0
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = realSetTimeout(() => {
      live.delete(handle)
      fn(...args)
    }, ms)
    live.add(handle)
    armedWhileWaiting += waiting ? 1 : 0
    return handle
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    live.delete(handle)
    realClearTimeout(handle)
  }) as typeof clearTimeout
  const slow: SandboxHostCall = () => {
    waiting = true
    return new Promise((r) =>
      realSetTimeout(() => {
        waiting = false
        r('read')
      }, 500),
    )
  }
  try {
    // timeoutMs 200: the 60 s timer wakes at the deadline during the 500 ms wait and sleeps
    // again (a new host timer), then the guest clears it.
    const cleared = await run(
      'const id = setTimeout(() => console.log("cleared"), 60000); await fs.readFile("/a"); clearTimeout(id); "done"',
      { timeoutMs: 200 },
      { hostOps: ['readFile'] },
      slow,
    )
    assert.equal(cleared.ok, true, JSON.stringify(cleared.error))
    assert.equal(cleared.result, 'done')
    assert.equal(cleared.stdout, '')
    assert.ok(armedWhileWaiting >= 1, 'the timer slept again while the file call waited')
    assert.equal(live.size, 0, 'the clear reached the host timer that was armed')

    const timedOut = await run('await new Promise((r) => setTimeout(r, 60000))')
    assert.equal(timedOut.error?.name, 'TimeoutError')
    assert.equal(live.size, 0, 'a run that timed out leaves no host timer either')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

test('guard timers: at most 1000 at once - counted by the guest and again by the host, and sleeping again is not a new one', async () => {
  const guest = await run(
    'const ids = []; for (let i = 0; i < 1000; i++) ids.push(setTimeout(() => {}, 60000)); let e; try { setTimeout(() => {}, 1) } catch (x) { e = x.name + ": " + x.message } ids.forEach(clearTimeout); e',
  )
  assert.equal(guest.result, 'RangeError: too many timers')
  // The guest shares its realm with its runtime: it can blind the runtime's own count.
  const blind = 'Object.defineProperty(Map.prototype, "size", { get() { return 0 } });'
  const host = await run(
    `${blind} const ids = []; let e; try { for (let i = 0; i < 2000; i++) ids.push(setTimeout(() => {}, 60000)) } catch (x) { e = x.name + ": " + x.message } ids.forEach(clearTimeout); [e, ids.length]`,
  )
  assert.deepEqual(host.result, ['RangeError: too many timers', 1000])
  // 1000 timers wake at the deadline during a 500 ms wait and sleep again: still 1000, not more.
  const slow: SandboxHostCall = () => new Promise((r) => setTimeout(() => r('read'), 500))
  const slept = await run(
    `${blind} const ids = []; for (let i = 0; i < 1000; i++) ids.push(setTimeout(() => {}, 60000));
    await fs.readFile("/a"); clearTimeout(ids.pop()); const out = [];
    for (let i = 0; i < 2; i++) { try { ids.push(setTimeout(() => {}, 60000)); out.push("ok") } catch (x) { out.push(x.message) } }
    ids.forEach(clearTimeout); out`,
    { timeoutMs: 200 },
    { hostOps: ['readFile'] },
    slow,
  )
  assert.deepEqual(slept.result, ['ok', 'too many timers'])
})

test('guard memory: allocating past the limit fails inside the guest, not the host', async () => {
  const r = await run(
    'const a = []; for (;;) a.push(new Array(1000).fill("x".repeat(64) + a.length))',
    { memoryLimitBytes: 16 * 1024 * 1024, timeoutMs: 5000 },
  )
  assert.equal(r.ok, false)
  assert.equal(r.error?.name, 'InternalError')
  assert.match(r.error?.message ?? '', /out of memory/)
  // A larger limit lets the same program go further: the limit is what stopped it.
  const roomy = await run(
    'const a = []; for (let i = 0; i < 3000; i++) a.push(new Array(1000).fill(i)); a.length',
    { memoryLimitBytes: 64 * 1024 * 1024, timeoutMs: 5000 },
  )
  assert.equal(roomy.result, 3000)
  const tight = await run(
    'const a = []; for (let i = 0; i < 3000; i++) a.push(new Array(1000).fill(i)); a.length',
    { memoryLimitBytes: 16 * 1024 * 1024, timeoutMs: 5000 },
  )
  assert.match(tight.error?.message ?? '', /out of memory/)
})

test('guard memory: runaway recursion is a guest error', async () => {
  const r = await run('function f() { return f() + 1 } f()', { timeoutMs: 5000 })
  assert.equal(r.ok, false)
  // QuickJS's own check fires first: its stack budget is far below the thread's.
  assert.equal(`${r.error?.name}: ${r.error?.message}`, 'InternalError: stack overflow')
  assert.equal((await run('1 + 1')).result, 2, 'the next run is unaffected')
})

test('guard escape: no host object is reachable from the guest', async () => {
  const clean = await run(
    `const names = ['process', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Deno', 'Bun', 'fs', 'module',
      'Buffer', 'global', 'window', 'self', 'navigator', 'document', 'importScripts', 'postMessage',
      'WebAssembly', 'Worker', 'host', 'cfg', 'hostCall']
    const present = names.filter((n) => typeof globalThis[n] !== 'undefined');
    ({
      present,
      viaFunction: typeof Function('return this')().process,
      viaConstructor: (0).constructor.constructor('return typeof process')(),
      sameGlobal: Function('return this')() === globalThis,
      evalProcess: eval('typeof process'),
    })`,
  )
  assert.deepEqual(clean.result, {
    present: [],
    viaFunction: 'undefined',
    viaConstructor: 'undefined',
    sameGlobal: true,
    evalProcess: 'undefined',
  })
})

test('guard escape: require and import of anything but a workspace file are refused', async () => {
  for (const code of [
    'require("fs")',
    'require("node:child_process")',
    'await import("node:fs")',
    'import fs from "fs"; fs',
    'await import("https://example.com/x.js")',
    'require("quickjs-emscripten")',
  ]) {
    const r = await run(code)
    assert.equal(r.ok, false, code)
    assert.match(r.error?.message ?? '', /Cannot load .*no packages/, code)
  }
  // Even a path is refused when the host bound no files.
  const noFiles = await run('require("./x.js")')
  assert.match(noFiles.error?.message ?? '', /this sandbox has no files/)
})

test('guard escape: what crosses the boundary is a copy - no prototype pollution, no live values', async () => {
  const r = await run(
    `Object.prototype.polluted = 'yes'; Array.prototype.polluted = 'yes';
    console.log({ __proto__: { evil: 1 } });
    JSON.parse('{"__proto__": {"evil": 1}, "constructor": {"prototype": {"evil": 2}}, "fn": 1}')`,
  )
  assert.equal(r.ok, true)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(([] as unknown as Record<string, unknown>).polluted, undefined)
  assert.equal(({} as Record<string, unknown>).evil, undefined)
  assert.equal(Object.getPrototypeOf(r.result), Object.prototype)
  assert.equal(Object.getPrototypeOf(r), Object.prototype)

  const live = await run(
    '({ f() { return 1 }, s: Symbol("x"), big: 10n, d: new Date(0), m: new Map([[1, { a: 1 }]]), e: new Error("x"), u: undefined, n: NaN })',
  )
  assert.deepEqual(live.result, {
    f: '[Function: f]',
    s: 'Symbol(x)',
    big: '10n',
    d: '1970-01-01T00:00:00.000Z',
    m: [[1, { a: 1 }]],
    e: { name: 'Error', message: 'x' },
    n: 'NaN',
  })
  const cyclic = await run('const o = { name: "o" }; o.self = o; o')
  assert.deepEqual(cyclic.result, { name: 'o', self: '[Circular]' })
  // The guest cannot reach the engine's own entry points to tamper with what is reported.
  const tamper = await run(
    'JSON.stringify = () => "{\\"ok\\":true}"; Object.keys = () => { throw new Error("no") }; ({ a: 1 })',
  )
  // A guest that rewrites its own realm can only change what it reports about itself.
  assert.equal(Object.getPrototypeOf(tamper), Object.prototype)
  assert.equal(typeof tamper.stdout, 'string')
})

test('guard output: a huge console.log is cut at the cap, and so is a huge result', async () => {
  const big = await run('console.log("x".repeat(5_000_000)); console.log("more"); 1', {
    maxOutputChars: 1000,
  })
  assert.equal(big.ok, true)
  assert.equal(big.stdout.length, 1000)
  assert.equal(big.truncated, true)

  const many = await run('for (let i = 0; i < 100000; i++) console.log("line " + i); "done"', {
    maxOutputChars: 500,
    timeoutMs: 5000,
  })
  assert.equal(many.stdout.length, 500)
  assert.equal(many.truncated, true)

  const result = await run('"y".repeat(1_000_000)', { maxOutputChars: 1000 })
  assert.equal(result.truncated, true)
  assert.ok(JSON.stringify(result.result).length <= 1100)

  const wide = await run('Array.from({ length: 200000 }, (_, i) => i)', {
    maxOutputChars: 2000,
    timeoutMs: 5000,
  })
  assert.equal(wide.truncated, true)
  assert.ok(JSON.stringify(wide.result).length <= 2100)

  const small = await run('console.log("ok"); [1, 2]', { maxOutputChars: 1000 })
  assert.equal(small.truncated, false)
})

test('guard files: only the modules the host handed over can be loaded', async () => {
  const modules = {
    '/lib.js': 'export const a = 40; export default function inc(x) { return x + 1 }',
    '/data.json': '{"k": 2}',
    '/cjs/util.js': 'exports.twice = (x) => x * 2; exports.data = require("../data.json")',
    '/nested/a.mjs': 'import inc from "../lib.js"; export const b = inc(1)',
  }
  const esm = await run(
    'import inc, { a } from "./lib.js"; import d from "./data.json"; import { b } from "./nested/a.mjs"; export default inc(a) + d.k + b',
    {},
    { modules },
  )
  assert.equal(esm.result, 45)
  const cjs = await run(
    'const u = require("./cjs/util.js"); u.twice(u.data.k) + require("/data.json").k',
    {},
    { modules },
  )
  assert.equal(cjs.result, 6)
  const dynamic = await run('(await import("./lib.js")).a', {}, { modules })
  assert.equal(dynamic.result, 40)

  const refused: [string, RegExp][] = [
    ['require("../outside.js")', /leaves the workspace/],
    ['require("./a/../../../etc/passwd.js")', /leaves the workspace/],
    ['await import("../../x.mjs")', /leaves the workspace/],
    ['require("./secret.txt")', /only \.js, \.mjs, \.json/],
    ['require("./lib")', /only \.js, \.mjs, \.json/],
    ['require("./lib.wasm")', /only \.js, \.mjs, \.json/],
    ['require(".\\\\lib.js")', /no packages/],
    ['require("C:\\\\lib.js")', /no packages/],
    ['require("file:///etc/passwd.js")', /no packages/],
    ['require("./missing.js")', /no such file in the workspace/],
    ['require("/etc/hosts.json")', /no such file in the workspace/],
    ['require("./constructor.js")', /no such file/],
  ]
  for (const [code, message] of refused) {
    const r = await run(code, {}, { modules })
    assert.equal(r.ok, false, code)
    assert.match(r.error?.message ?? '', message, code)
  }
  // A JSON module is data, never code.
  const json = await run(
    'require("./evil.json")',
    {},
    { modules: { '/evil.json': '1); globalThis.x = 1; (' } },
  )
  assert.equal(json.error?.name, 'SyntaxError')
})

test('guard files: fs exists only when the host serves it, and only the operations it named', async () => {
  const none = await run('typeof fs')
  assert.equal(none.result, 'undefined')
  // hostOps without a host function is nothing.
  const noHost = await run('typeof fs', {}, { hostOps: ['readFile'] })
  assert.equal(noHost.result, 'undefined')

  const calls: [string, unknown[]][] = []
  const host: SandboxHostCall = async (op, args) => {
    calls.push([op, args])
    if (op === 'readFile') {
      if (args[0] === '/nope') {
        throw new Error('no file "/nope"')
      }
      return 'hello'
    }
    return undefined
  }
  const r = await run(
    'const t = await fs.readFile("/a.txt"); await fs.writeFile("/b.txt", t + "!"); let e; try { await fs.readFile("/nope") } catch (x) { e = x.message } ({ t, e, ops: Object.keys(fs) })',
    {},
    { hostOps: ['readFile', 'writeFile'] },
    host,
  )
  assert.deepEqual(r.result, {
    t: 'hello',
    e: 'no file "/nope"',
    ops: ['readFile', 'writeFile'],
  })
  assert.deepEqual(calls, [
    ['readFile', ['/a.txt']],
    ['writeFile', ['/b.txt', 'hello!']],
    ['readFile', ['/nope']],
  ])

  const flood = await run(
    'let n = 0; try { for (;;) { await fs.readFile("/a.txt"); n++ } } catch (e) { console.log(e.message) } n',
    { timeoutMs: 5000 },
    { hostOps: ['readFile'] },
    async () => 'x',
  )
  assert.equal(flood.result, SANDBOX_MAX_HOST_CALLS)
  assert.match(flood.stdout, /too many file operations/)

  const huge = await run(
    'let e; try { await fs.writeFile("/b.txt", "x".repeat(3_000_000)) } catch (x) { e = x.message } e',
    { timeoutMs: 5000 },
    { hostOps: ['writeFile'] },
    host,
  )
  assert.match(String(huge.result), /too large/)
  assert.equal(calls.filter(([op]) => op === 'writeFile').length, 1, 'the host never saw it')
})

test('engine: time spent waiting for the host is not the guest time - guest time still is', async () => {
  const slow: SandboxHostCall = () => new Promise((r) => setTimeout(() => r('late'), 700))
  const waited = await run('await fs.readFile("/a")', {}, { hostOps: ['readFile'] }, slow)
  assert.equal(waited.result, 'late', 'a 700 ms answer inside a 400 ms limit is not a timeout')
  const spinning = await run(
    'await fs.readFile("/a"); while (true) {}',
    {},
    { hostOps: ['readFile'] },
    slow,
  )
  assert.equal(spinning.error?.name, 'TimeoutError')
})

test('guard timeout: the clock starts with the program - a slow engine start is not the guest time', async () => {
  // The engine's start takes 300 ms (a busy machine); the limit is 100 ms.
  const slow = slowStart(lib, 300)
  const limits = resolveSandboxLimits({ timeoutMs: 100 })
  const quick = await runGuest(slow, { code: 'console.log("ran"); 6 * 7', limits })
  assert.deepEqual(
    { ok: quick.ok, stdout: quick.stdout, result: quick.result, error: quick.error },
    { ok: true, stdout: 'ran\n', result: 42, error: undefined },
    'a 300 ms start inside a 100 ms limit is not a timeout',
  )
  // And from the program's first instruction the limit holds as before.
  const began = Date.now()
  let programAt = 0
  const loop = await runGuest(
    slow,
    { code: 'console.log("going"); while (true) {}', limits },
    { onStart: () => (programAt = Date.now()) },
  )
  const ranFor = Date.now() - programAt
  assert.ok(programAt - began >= 300, 'the start was slow')
  assert.equal(loop.error?.name, 'TimeoutError')
  assert.match(loop.error?.message ?? '', /stopped after 100 ms/)
  assert.equal(loop.stdout, 'going\n')
  assert.ok(ranFor >= 90 && ranFor < 2000, `stopped ${ranFor} ms after the program started`)
})

test('engine: two runs share nothing', async () => {
  const [a, b] = await Promise.all([
    run(
      'globalThis.shared = "a"; Object.prototype.mark = "a"; await new Promise((r) => setTimeout(r, 30)); [globalThis.shared, ({}).mark]',
    ),
    run(
      'await new Promise((r) => setTimeout(r, 10)); [typeof globalThis.shared, typeof ({}).mark]',
    ),
  ])
  assert.deepEqual(a.result, ['a', 'a'])
  assert.deepEqual(b.result, ['undefined', 'undefined'])
  assert.deepEqual((await run('[typeof globalThis.shared, typeof ({}).mark]')).result, [
    'undefined',
    'undefined',
  ])
})

test('resolveModulePath: relative to the importing file, inside the root, three extensions', () => {
  assert.equal(resolveModulePath('/main.js', './lib.js'), '/lib.js')
  assert.equal(resolveModulePath('/src/app/main.js', '../util/x.mjs'), '/src/util/x.mjs')
  assert.equal(resolveModulePath('/src/main.js', '/data.JSON'), '/data.JSON')
  assert.equal(resolveModulePath('/src/main.js', './a/./b//c.js'), '/src/a/b/c.js')
  for (const spec of ['../x.js', './../../x.js', '/../x.js', './a/../../x.js']) {
    assert.throws(() => resolveModulePath('/main.js', spec), /leaves the workspace/, spec)
  }
  for (const spec of ['fs', 'node:fs', 'lodash', 'https://x/y.js', 'file:///x.js', 'x.js', '']) {
    assert.throws(() => resolveModulePath('/main.js', spec), /no packages/, spec)
  }
  for (const spec of ['./x.ts', './x', './x.js.txt', './x.node', './.js/x']) {
    assert.throws(() => resolveModulePath('/main.js', spec), /only \.js/, spec)
  }
  assert.throws(() => resolveModulePath('/main.js', './a\\..\\..\\x.js'), /no packages/)
  assert.throws(() => resolveModulePath('/main.js', './x.js\0.txt'), /no packages/)
})

test('moduleSpecifiersOf: the literal imports and requires of a source', () => {
  const found = moduleSpecifiersOf(
    `import a from './a.js'\nimport { b, c as d } from "./b.mjs"\nimport * as e from './e.js'\nimport './side.js'\n` +
      `export { x } from './x.js'\nexport * from "./y.js"\nconst z = await import('./z.json')\nconst r = require("../r.js")\n` +
      'const dyn = require(name)\n',
  )
  assert.deepEqual(found.sort(), [
    '../r.js',
    './a.js',
    './b.mjs',
    './e.js',
    './side.js',
    './x.js',
    './y.js',
    './z.json',
  ])
})

test('resolveSandboxLimits: defaults, and a host cannot configure past the caps', () => {
  assert.deepEqual(resolveSandboxLimits(undefined), {
    timeoutMs: 5000,
    memoryLimitBytes: 32 * 1024 * 1024,
    maxOutputChars: 8000,
    maxCodeChars: 100_000,
  })
  assert.deepEqual(
    resolveSandboxLimits({
      timeoutMs: 10 ** 9,
      memoryLimitBytes: 10 ** 12,
      maxOutputChars: 10 ** 9,
      maxCodeChars: 10 ** 9,
    }),
    SANDBOX_CAPS,
  )
  const odd = resolveSandboxLimits({
    timeoutMs: -1,
    memoryLimitBytes: NaN,
    maxOutputChars: Infinity,
    maxCodeChars: 0,
  })
  assert.deepEqual(odd, resolveSandboxLimits({}))
  assert.equal(resolveSandboxLimits({ timeoutMs: 1 }).timeoutMs, 50)
  assert.equal(resolveSandboxLimits({ memoryLimitBytes: 1 }).memoryLimitBytes, 16 * 1024 * 1024)
})

test('sanitizeSandboxResult: the agent side trusts nothing a worker says', () => {
  const limits = resolveSandboxLimits({ maxOutputChars: 300 })
  const r = sanitizeSandboxResult(
    {
      ok: true,
      stdout: 'o'.repeat(5000),
      result: { big: 'r'.repeat(5000) },
      truncated: false,
      durationMs: 12.4,
      extra: 'dropped',
    },
    limits,
  )
  assert.equal(r.stdout.length, 300)
  assert.equal(r.truncated, true)
  assert.equal(typeof r.result, 'string')
  assert.ok((r.result as string).length <= 200)
  assert.deepEqual(Object.keys(r).sort(), ['durationMs', 'ok', 'result', 'stdout', 'truncated'])

  const e = sanitizeSandboxResult(
    { ok: true, stdout: 5, error: { name: 'n'.repeat(999), message: 7, stack: 's'.repeat(9999) } },
    limits,
  )
  assert.equal(e.ok, false, 'an error means not ok, whatever the flag says')
  assert.equal(e.stdout, '')
  assert.equal(e.error?.name.length, 200)
  assert.equal(e.error?.message, '')
  assert.equal(e.error?.stack?.length, 4000)

  for (const junk of [null, undefined, 'x', 7, []]) {
    const j = sanitizeSandboxResult(junk, limits)
    assert.equal(j.ok, false)
    assert.equal(j.stdout, '')
  }
  const live = sanitizeSandboxResult(
    { ok: true, result: { d: new Date(0), f: () => 1, n: 1 } },
    limits,
  )
  assert.deepEqual(live.result, { d: '1970-01-01T00:00:00.000Z', n: 1 }, 'plain data only')
  const cyc: Record<string, unknown> = {}
  cyc.self = cyc
  assert.equal(sanitizeSandboxResult({ ok: true, result: cyc }, limits).result, '[unserializable]')
  const proto = sanitizeSandboxResult(
    { ok: true, result: JSON.parse('{"__proto__": {"evil": 1}}') },
    limits,
  )
  assert.equal(({} as Record<string, unknown>).evil, undefined)
  assert.equal(Object.getPrototypeOf(proto.result), Object.prototype)
})

// A pair of ports wired to each other, with a kill switch - a worker without the thread.
const fakeWorker = (): {
  parent: ISandboxPort
  child: ISandboxPort
  state: { killed: boolean }
} => {
  const state = { killed: false }
  let toParent: ((m: unknown) => void) | undefined
  let toChild: ((m: unknown) => void) | undefined
  let closed: ((reason: string) => void) | undefined
  return {
    state,
    parent: {
      post: (m) => queueMicrotask(() => !state.killed && toChild?.(structuredClone(m))),
      listen: (on, onClose) => {
        toParent = on
        closed = onClose
      },
      terminate: () => {
        state.killed = true
        closed?.('terminated')
      },
    },
    child: {
      post: (m) => queueMicrotask(() => !state.killed && toParent?.(structuredClone(m))),
      listen: (on) => {
        toChild = on
      },
    },
  }
}

const request = (code: string, config: ISandboxConfig = {}): ISandboxRequest => ({
  code,
  limits: resolveSandboxLimits({ timeoutMs: 300, ...config }),
})

test('worker protocol: a run goes through, and the worker is terminated afterwards', async () => {
  const w = fakeWorker()
  serveSandbox(w.child, async () => lib)
  const r = await runInWorker(w.parent, request('console.log("hi"); 2 + 2'))
  assert.deepEqual(
    { ok: r.ok, stdout: r.stdout, result: r.result, truncated: r.truncated },
    { ok: true, stdout: 'hi\n', result: 4, truncated: false },
  )
  assert.equal(w.state.killed, true)
})

test('guard timeout (hard): a worker that does not answer is terminated at timeoutMs + grace', async () => {
  const w = fakeWorker()
  // "Started", then silence: the shape of a guest stuck in one long native call.
  w.child.listen(() => w.child.post({ type: 'started' }))
  const started = Date.now()
  const r = await runInWorker(w.parent, request('1'), { graceMs: 100 })
  const took = Date.now() - started
  assert.equal(r.ok, false)
  assert.equal(r.error?.name, 'TimeoutError')
  assert.match(r.error?.message ?? '', /killed after 300 ms/)
  assert.equal(w.state.killed, true)
  assert.ok(took >= 380 && took < 1500, `killed at the deadline, took ${took} ms`)
})

test('guard timeout (hard): the kill is counted from "started" - a slow start is bounded by startupMs instead', async () => {
  const w = fakeWorker()
  // A start longer than timeoutMs + grace, then a run that finishes at once.
  w.child.listen(() =>
    setTimeout(() => {
      w.child.post({ type: 'started' })
      w.child.post({ type: 'done', result: { ok: true, stdout: '', result: 'ran' } })
    }, 600),
  )
  const r = await runInWorker(w.parent, request('1'), { graceMs: 100 })
  assert.equal(r.ok, true, JSON.stringify(r.error))
  assert.equal(r.result, 'ran')

  // A start that never ends is still given up, by its own bound.
  const stuck = fakeWorker()
  stuck.child.listen(() => {})
  const started = Date.now()
  await assert.rejects(
    runInWorker(stuck.parent, request('1'), { startupMs: 600, graceMs: 100 }),
    (e: Error) => e instanceof SandboxUnavailableError && /did not start/.test(e.message),
  )
  assert.ok(Date.now() - started >= 590, 'not at timeoutMs + grace')
  assert.equal(stuck.state.killed, true)
})

test('worker protocol: a worker that never starts, dies, or lacks the peer', async () => {
  const silent = fakeWorker()
  silent.child.listen(() => {})
  await assert.rejects(
    runInWorker(silent.parent, request('1'), { startupMs: 100 }),
    (e: Error) => e instanceof SandboxUnavailableError && /did not start/.test(e.message),
  )
  assert.equal(silent.state.killed, true)

  const noPeer = fakeWorker()
  serveSandbox(noPeer.child, async () => {
    throw new Error("Cannot find package 'quickjs-emscripten'")
  })
  await assert.rejects(runInWorker(noPeer.parent, request('1')), (e: Error) => {
    assert.ok(e instanceof SandboxUnavailableError)
    assert.match(e.message, /optional package "quickjs-emscripten"/)
    assert.match(e.message, /npm install quickjs-emscripten/)
    return true
  })

  const dying = fakeWorker()
  dying.child.listen(() => dying.parent.terminate?.())
  const died = await runInWorker(dying.parent, request('1'))
  assert.equal(died.error?.name, 'SandboxError')

  const aborted = fakeWorker()
  aborted.child.listen(() => aborted.child.post({ type: 'started' }))
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 20)
  await assert.rejects(
    runInWorker(aborted.parent, request('1'), { signal: ac.signal }),
    (e: Error) => e.name === 'AbortError',
  )
  assert.equal(aborted.state.killed, true)
})

test('worker protocol: a forged "done" is cut to size on the agent side', async () => {
  const w = fakeWorker()
  w.child.listen(() =>
    w.child.post({
      type: 'done',
      result: { ok: true, stdout: 'z'.repeat(50_000), result: 'q'.repeat(50_000) },
    }),
  )
  const r = await runInWorker(w.parent, request('1', { maxOutputChars: 400 }))
  assert.equal(r.stdout.length, 400)
  assert.ok(String(r.result).length <= 200)
  assert.equal(r.truncated, true)
})

test('worker protocol: file calls are served on the agent side; without a host they are refused', async () => {
  const w = fakeWorker()
  serveSandbox(w.child, async () => lib)
  const r = await runInWorker(
    w.parent,
    { ...request('(await fs.readFile("/a.txt")) + "!"'), hostOps: ['readFile'] },
    { hostCall: async (op, args) => `${op}:${String(args[0])}` },
  )
  assert.equal(r.result, 'readFile:/a.txt!')

  const bare = fakeWorker()
  serveSandbox(bare.child, async () => lib)
  const refused = await runInWorker(bare.parent, {
    ...request('let e; try { await fs.readFile("/a.txt") } catch (x) { e = x.message } e'),
    hostOps: ['readFile'],
  })
  assert.match(String(refused.result), /no files/)
})

test('prompt note: says what run_js is, what it cannot do, and never to claim an unrun result', () => {
  const note = sandboxPromptNote(false)
  assert.match(note, /run_js/)
  assert.match(note, /QuickJS/)
  assert.match(note, /no network/)
  assert.match(note, /no files/)
  assert.match(note, /Never say that code was run/)
  assert.match(sandboxPromptNote(true), /fs\.readFile/)
  assert.doesNotMatch(sandboxPromptNote(true), /no files/)
})
