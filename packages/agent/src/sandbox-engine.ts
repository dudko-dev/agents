// The JavaScript sandbox behind `config.sandbox` / the `run_js` tool: the guest runs in QuickJS
// compiled to WebAssembly (the optional peer `quickjs-emscripten`), never in the host's own
// JavaScript engine. This file is the part both packages share - limits, the guest's runtime,
// the module resolver, the worker protocol and what is allowed back across the boundary.
//
// It is pure (no imports, no node:* and no DOM) and is a COPY, byte for byte, of the sibling
// package's file: `packages/agent/src/sandbox-engine.ts` = `packages/agent-web/src/sandbox/engine.ts`.
// Change both; the Node package's `tests/sandbox-engine.test.ts` compares them.
//
// Security boundary. What the guest can reach is exactly what `bootstrap` hands it: console,
// timers, and - only when the host passes them - a module map and named file operations. Every
// value that crosses is a string produced inside the guest and re-parsed here, never a host
// reference. Every guard has a test and a mutation check (see the two packages' sandbox tests).

export const RUN_JS_TOOL = 'run_js'
export const SANDBOX_PACKAGE = 'quickjs-emscripten'

export interface ISandboxConfig {
  // Time one run may take, in ms (default 5000, at most 60000). Waiting for a file operation -
  // a consent prompt included - does not count.
  timeoutMs?: number
  // The guest's memory, in bytes: the whole WebAssembly memory of its engine instance, the
  // engine's own 16 MiB included (default 32 MiB, at least 16 MiB, at most 256 MiB).
  memoryLimitBytes?: number
  // What a run returns to the model, stdout and result together, in characters (default 8000).
  maxOutputChars?: number
  // The longest program accepted, in characters (default 100000).
  maxCodeChars?: number
  // Let the guest import / require workspace files and use `fs` (default true where the agent
  // has a workspace; without one there is nothing to bind and this is ignored).
  files?: boolean
}

export interface ISandboxLimits {
  timeoutMs: number
  memoryLimitBytes: number
  maxOutputChars: number
  maxCodeChars: number
}

const MIB = 1024 * 1024

export const SANDBOX_DEFAULTS: ISandboxLimits = {
  timeoutMs: 5000,
  memoryLimitBytes: 32 * MIB,
  maxOutputChars: 8000,
  maxCodeChars: 100_000,
}

// A host cannot configure past these: the tool is for checking a piece of code, not for hosting one.
export const SANDBOX_CAPS: ISandboxLimits = {
  timeoutMs: 60_000,
  memoryLimitBytes: 256 * MIB,
  maxOutputChars: 100_000,
  maxCodeChars: 1_000_000,
}

const SANDBOX_FLOORS: ISandboxLimits = {
  timeoutMs: 50,
  // What the engine's WebAssembly module asks for before it runs anything.
  memoryLimitBytes: 16 * MIB,
  maxOutputChars: 200,
  maxCodeChars: 100,
}

// One module the guest may load, and all of them together (characters).
export const SANDBOX_MAX_MODULES = 64
export const SANDBOX_MAX_MODULE_CHARS_TOTAL = 2_000_000
// A file the guest reads or writes through `fs` (characters), and the calls of one run.
export const SANDBOX_MAX_FILE_CHARS = 1_000_000
export const SANDBOX_MAX_HOST_CALLS = 500
export const SANDBOX_MODULE_EXTENSIONS: readonly string[] = ['.js', '.mjs', '.json']

const MAX_TIMERS = 1000
// QuickJS's own stack check. Small on purpose: wasm frames live on the host thread's native
// stack, and a deeper guest recursion would overflow THAT before QuickJS noticed.
const GUEST_STACK_BYTES = 256 * 1024
const ERROR_NAME_CHARS = 200
const ERROR_TEXT_CHARS = 4000

const bounded = (value: unknown, key: keyof ISandboxLimits): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN
  if (Number.isNaN(n) || n <= 0) {
    return SANDBOX_DEFAULTS[key]
  }
  return Math.min(SANDBOX_CAPS[key], Math.max(SANDBOX_FLOORS[key], n))
}

export const resolveSandboxLimits = (config: ISandboxConfig | undefined): ISandboxLimits => ({
  timeoutMs: bounded(config?.timeoutMs, 'timeoutMs'),
  memoryLimitBytes: bounded(config?.memoryLimitBytes, 'memoryLimitBytes'),
  maxOutputChars: bounded(config?.maxOutputChars, 'maxOutputChars'),
  maxCodeChars: bounded(config?.maxCodeChars, 'maxCodeChars'),
})

export interface ISandboxError {
  name: string
  message: string
  // Guest frames only: the host's own frames never cross.
  stack?: string
}

// What `run_js` returns to the model.
export interface ISandboxResult {
  ok: boolean
  // console.log / info / warn / error, in the order they were called.
  stdout: string
  // The value of the last expression (a module's default export), as JSON-like data.
  result?: unknown
  error?: ISandboxError
  // stdout or result was cut to fit `maxOutputChars`.
  truncated: boolean
  durationMs: number
}

export type SandboxHostOp = 'readFile' | 'writeFile' | 'readdir'

// One run, as it is posted to the engine. Structured-cloneable.
export interface ISandboxRequest {
  code: string
  // The path the code is evaluated as (stack traces, the base of relative imports).
  filename?: string
  limits: ISandboxLimits
  // Workspace files the guest may `import` / `require`, by absolute path. Absent = no loader.
  modules?: Record<string, string>
  // The `fs` functions the host serves. Absent or empty = no `fs`.
  hostOps?: SandboxHostOp[]
}

// Serves one `fs` call of the guest. Arguments and the answer are JSON-like data.
export type SandboxHostCall = (op: string, args: unknown[]) => Promise<unknown>

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}

export const sandboxPeerMissing = (detail?: string): SandboxUnavailableError =>
  new SandboxUnavailableError(
    `The sandbox (${RUN_JS_TOOL}) needs the optional package "${SANDBOX_PACKAGE}", which is not installed. ` +
      `Add it to your app: npm install ${SANDBOX_PACKAGE}${detail ? ` (${detail})` : ''}`,
  )

// The run-stable sentences the stage prompts carry when the sandbox is on (both packages say the same).
export const sandboxPromptNote = (files: boolean): string =>
  `${RUN_JS_TOOL} runs JavaScript you wrote in an isolated sandbox and returns what it printed (console.log) and the value of its last expression. ` +
  `It is plain JavaScript on QuickJS (ES2023, top-level await), not Node and not a browser: no network, no npm packages, no process${
    files
      ? '; workspace files are reachable by relative path (import / require of .js, .mjs, .json) and through the async fs.readFile / fs.writeFile / fs.readdir'
      : ', no files'
  }. ` +
  `Never say that code was run, tested or printed something unless ${RUN_JS_TOOL} was called and returned it: quote its real output, and if it was not run, say so.`

export const SANDBOX_PLANNER_NOTE = `When the request needs code to be run, tested or checked on data, or a calculation that is easier to compute than to reason about, plan a step that calls ${RUN_JS_TOOL} for it.`

export const SANDBOX_SYNTHESIZER_NOTE = `Report the output of running code only when a ${RUN_JS_TOOL} call returned it; if the code was written but not run, say it was not run.`

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text)

const errorText = (err: unknown): string => {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`
  }
  return typeof err === 'string' ? err : 'unknown error'
}

const dirname = (path: string): string => {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

// Resolve what the guest asked to load against the file that asked. Throws (with a message for
// the model) on anything that is not a workspace file by path: a package, a Node built-in, a
// path that climbs out of the root, an extension outside the allowed three.
export const resolveModulePath = (base: string, specifier: string): string => {
  const spec = String(specifier)
  if (!/^(\.{1,2}\/|\/)/.test(spec) || /[\\\0]/.test(spec)) {
    throw new Error(
      `Cannot load "${clip(spec, 200)}": the sandbox has no packages and no Node or browser modules - only workspace files by path ("./lib.js")`,
    )
  }
  const parts: string[] = spec.startsWith('/') ? [] : dirname(base).split('/').filter(Boolean)
  for (const seg of spec.split('/')) {
    if (!seg || seg === '.') {
      continue
    }
    if (seg === '..') {
      if (parts.length === 0) {
        throw new Error(`Cannot load "${clip(spec, 200)}": the path leaves the workspace`)
      }
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  const path = `/${parts.join('/')}`
  if (!SANDBOX_MODULE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) {
    throw new Error(
      `Cannot load "${clip(path, 200)}": only ${SANDBOX_MODULE_EXTENSIONS.join(', ')} files can be imported`,
    )
  }
  return path
}

// The literal specifiers a source names (import / export-from / import() / require). Used by the
// host to hand the guest exactly the files a program refers to. A regex, not a parser: a match
// inside a string or a comment only costs one more read of a real workspace file.
export const moduleSpecifiersOf = (source: string): string[] => {
  const found = new Set<string>()
  const patterns = [
    /\bimport\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(['"])([^'"\n]+)\1/g,
    /\bexport\s*[\w$*{}\s,]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
    /\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  ]
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      found.add(m[2])
    }
  }
  return [...found]
}

// Static import / export declarations make the program an ES module (its result is then the
// default export); everything else is a script whose result is its last expression.
const looksLikeModule = (code: string): boolean =>
  /(^|[\n;])\s*(import\s*[\w$*{'"]|export\s+[\w$*{])/.test(code)

// JS_EVAL_FLAG_ASYNC: a script may use top-level await; its completion value arrives wrapped.
const EVAL_SCRIPT_ASYNC = 128

// The guest's own runtime, evaluated inside it before the program. It may be tampered with by
// the program (it shares its realm) - which only ever damages the program's own output: the
// host takes nothing from it but strings.
const BOOTSTRAP = `(function (host, cfg) {
  'use strict';
  var g = globalThis, J = JSON, S = String, E = Error, P = Promise, M = Map, R = Reflect;
  var hostLog = host.log, hostTimer = host.timer, hostClear = host.clear;
  var hostCall = host.call, hostResolve = host.resolve, hostCompile = host.compile;
  function inspect(v, depth, seen) {
    var t = typeof v;
    if (t === 'string') return depth ? J.stringify(v) : v;
    if (t === 'bigint') return S(v) + 'n';
    if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
    if (t !== 'object' || v === null) return S(v);
    if (v instanceof E) return S(v.name) + ': ' + S(v.message) + (v.stack ? '\\n' + S(v.stack).replace(/\\n$/, '') : '');
    if (seen.indexOf(v) >= 0) return '[Circular]';
    if (depth > 4) return Array.isArray(v) ? '[Array]' : '[Object]';
    if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return S(v);
    seen.push(v);
    var parts = [], out, i, keys;
    if (Array.isArray(v)) {
      for (i = 0; i < v.length && i < 100; i++) parts.push(inspect(v[i], depth + 1, seen));
      if (v.length > 100) parts.push('... ' + (v.length - 100) + ' more');
      out = parts.length ? '[ ' + parts.join(', ') + ' ]' : '[]';
    } else if (v instanceof M) {
      v.forEach(function (val, key) { if (parts.length < 50) parts.push(inspect(key, depth + 1, seen) + ' => ' + inspect(val, depth + 1, seen)); });
      out = 'Map(' + v.size + ') {' + (parts.length ? ' ' + parts.join(', ') + ' ' : '') + '}';
    } else if (v instanceof Set) {
      v.forEach(function (val) { if (parts.length < 50) parts.push(inspect(val, depth + 1, seen)); });
      out = 'Set(' + v.size + ') {' + (parts.length ? ' ' + parts.join(', ') + ' ' : '') + '}';
    } else {
      keys = Object.keys(v);
      for (i = 0; i < keys.length && i < 50; i++) parts.push(keys[i] + ': ' + inspect(v[keys[i]], depth + 1, seen));
      if (keys.length > 50) parts.push('... ' + (keys.length - 50) + ' more');
      out = parts.length ? '{ ' + parts.join(', ') + ' }' : '{}';
    }
    seen.pop();
    return out;
  }
  function print(level) {
    return function () {
      var s = '', i;
      try {
        for (i = 0; i < arguments.length && s.length <= cfg.max; i++) s += (i ? ' ' : '') + inspect(arguments[i], 0, []);
      } catch (e) { s += '[unprintable]'; }
      hostLog(level, s.length > cfg.max ? s.slice(0, cfg.max + 1) : s);
    };
  }
  g.console = { log: print(''), info: print(''), debug: print(''), trace: print(''), warn: print('warn'), error: print('error') };
  function plain(v, depth, seen, budget) {
    var t = typeof v, out, i, keys;
    if ((budget.n -= 1) < 0) { budget.cut = true; return '[Truncated]'; }
    if (v === null || t === 'boolean' || t === 'undefined') return v;
    if (t === 'string') { if (v.length > cfg.max) { budget.cut = true; return v.slice(0, cfg.max); } return v; }
    if (t === 'number') return isFinite(v) ? v : S(v);
    if (t === 'bigint') return S(v) + 'n';
    if (t === 'symbol') return S(v);
    if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
    if (v instanceof E) return { name: S(v.name), message: S(v.message) };
    if (seen.indexOf(v) >= 0) return '[Circular]';
    if (depth >= 8) return Array.isArray(v) ? '[Array]' : '[Object]';
    if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
    seen.push(v);
    if (v instanceof M) { out = []; v.forEach(function (val, key) { out.push([plain(key, depth + 1, seen, budget), plain(val, depth + 1, seen, budget)]); }); }
    else if (v instanceof Set) { out = []; v.forEach(function (val) { out.push(plain(val, depth + 1, seen, budget)); }); }
    else if (Array.isArray(v)) { out = []; for (i = 0; i < v.length && budget.n >= 0; i++) out.push(plain(v[i], depth + 1, seen, budget)); }
    else { out = {}; keys = Object.keys(v); for (i = 0; i < keys.length && budget.n >= 0; i++) out[keys[i]] = plain(v[keys[i]], depth + 1, seen, budget); }
    seen.pop();
    return out;
  }
  function serialize(v, max) {
    if (v === undefined) return '';
    var budget = { n: 20000, cut: false }, text;
    try { text = J.stringify(plain(v, 0, [], budget)); } catch (e) { text = J.stringify('[unserializable]'); }
    if (text === undefined) return '';
    if (text.length > max) return 'T' + text.slice(0, max);
    return (budget.cut ? 'C' : 'J') + text;
  }
  function describe(e) {
    var name = 'Error', message = '', stack = '';
    try {
      if (e instanceof E || (e && typeof e === 'object' && typeof e.message === 'string')) {
        name = S(e.name || 'Error'); message = S(e.message); stack = typeof e.stack === 'string' ? e.stack : '';
      } else { message = 'thrown: ' + inspect(e, 1, []); }
    } catch (x) { message = '[unprintable error]'; }
    return J.stringify([name.slice(0, cfg.nameMax), message.slice(0, cfg.textMax), stack.slice(0, cfg.textMax)]);
  }
  var timers = new M(), nextTimer = 1;
  function timer(repeat) {
    return function (fn, ms) {
      if (typeof fn !== 'function') throw new TypeError('the first argument must be a function');
      if (timers.size >= cfg.maxTimers) throw new RangeError('too many timers');
      var id = nextTimer++;
      ms = +ms; if (!(ms >= 0)) ms = 0; if (ms > 2147483647) ms = 2147483647;
      if (repeat && ms < 1) ms = 1;
      timers.set(id, { fn: fn, args: Array.prototype.slice.call(arguments, 2), ms: ms, repeat: repeat });
      hostTimer(id, ms);
      return id;
    };
  }
  function clear(id) { if (timers.delete(id)) hostClear(id); }
  function fire(id) {
    var t = timers.get(id);
    if (!t) return;
    if (t.repeat) hostTimer(id, t.ms); else timers.delete(id);
    R.apply(t.fn, undefined, t.args);
  }
  g.setTimeout = timer(false); g.setInterval = timer(true);
  g.clearTimeout = clear; g.clearInterval = clear;
  g.queueMicrotask = function (fn) { P.resolve().then(fn); };
  if (cfg.ops.length) {
    var fs = {};
    cfg.ops.forEach(function (op) {
      fs[op] = function () {
        var text;
        try { text = J.stringify(Array.prototype.slice.call(arguments)); } catch (e) { return P.reject(new TypeError('fs.' + op + ': the arguments must be plain data')); }
        if (text.length > cfg.maxCall) return P.reject(new RangeError('fs.' + op + ': the arguments are too large'));
        return hostCall(op, text).then(function (r) { return r === '' ? undefined : J.parse(r); });
      };
    });
    g.fs = fs;
  }
  var loaded = new M();
  function requireFrom(base) {
    return function require(spec) {
      var path = hostResolve(base, S(spec)), mod = loaded.get(path), made;
      if (mod) return mod.exports;
      mod = { exports: {} };
      loaded.set(path, mod);
      made = hostCompile(path);
      if (typeof made === 'string') mod.exports = J.parse(made);
      else made.call(mod.exports, mod, mod.exports, requireFrom(path), path, path.slice(0, Math.max(1, path.lastIndexOf('/'))));
      return mod.exports;
    };
  }
  g.require = requireFrom(cfg.filename);
  return { fire: fire, serialize: serialize, describe: describe };
})`

const BOOTSTRAP_FILE = '<sandbox>'
const REFUSED = '\u0001refused:'

// The slice of quickjs-emscripten this file uses. Typed loosely on purpose: the package is an
// optional peer, so its types must not appear in what this package publishes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
export interface ISandboxLib {
  RELEASE_SYNC: Any
  newVariant: (base: Any, options: { wasmMemory: Any }) => Any
  newQuickJSWASMModuleFromVariant: (variant: Any) => Promise<Any>
}

const WASM_PAGE = 65536

// The memory limit. QuickJS's own accounting (`setMemoryLimit`) cannot be relied on in this
// build: without malloc_usable_size it counts 8 bytes per allocation, so a 2 MiB "limit" let a
// guest take 490 MB (measured). The bound that holds is the WebAssembly memory itself: the
// engine is instantiated on a Memory with a maximum, and the wasm runtime refuses to grow past
// it - whatever the guest, or a bug in the engine, asks for.
const newBoundedModule = (lib: ISandboxLib, limitBytes: number): Promise<Any> => {
  const wasm = (globalThis as Any).WebAssembly
  const wasmMemory = new wasm.Memory({
    initial: SANDBOX_FLOORS.memoryLimitBytes / WASM_PAGE,
    maximum: Math.floor(limitBytes / WASM_PAGE),
  })
  return lib.newQuickJSWASMModuleFromVariant(lib.newVariant(lib.RELEASE_SYNC, { wasmMemory }))
}

export interface IRunGuestOptions {
  hostCall?: SandboxHostCall
  // Called once the engine is loaded, right before the program is evaluated (the clock starts here).
  onStart?: () => void
}

/**
 * Run one program in a fresh QuickJS instance (its own WebAssembly module, so its own memory)
 * and resolve with what it printed and returned. Never rejects for anything the GUEST did - a
 * throw, a timeout, running out of memory are results. It rejects only when the engine itself
 * cannot be created.
 *
 * It runs on the calling thread: the interrupt handler stops JavaScript that loops, but not a
 * single long native call (a 16 MiB `indexOf`). The hard stop is the caller's - see `runInWorker`.
 */
export const runGuest = async (
  lib: ISandboxLib,
  request: ISandboxRequest,
  options: IRunGuestOptions = {},
): Promise<ISandboxResult> => {
  const { limits } = request
  const filename = request.filename ?? '/main.js'
  const modules = request.modules
  const hostOps = options.hostCall ? (request.hostOps ?? []) : []
  const mod = await newBoundedModule(lib, limits.memoryLimitBytes)
  const rt = mod.newRuntime()
  // Makes one oversized allocation fail at once; the bound itself is the module's memory.
  rt.setMemoryLimit(limits.memoryLimitBytes)
  rt.setMaxStackSize(GUEST_STACK_BYTES)
  const ctx = rt.newContext()

  return new Promise<ISandboxResult>((resolve) => {
    const startedAt = Date.now()
    let finished = false
    let interrupted = false
    // Time spent inside the guest, and time spent waiting for the host to serve a file call.
    let cpuMs = 0
    let entryAt = 0
    let waitMs = 0
    let waitingSince = 0
    let pendingCalls = 0
    let hostCalls = 0
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const hostTimers = new Map<number, ReturnType<typeof setTimeout>>()
    const out: string[] = []
    let outChars = 0
    let truncated = false
    let internals: Any
    let main: Any
    // 'script' = the async-script wrapper ({ value }), 'module' = a namespace, 'value' = the result itself.
    let mainKind: 'script' | 'module' | 'value' = 'value'

    const cpuUsed = (): number => cpuMs + (entryAt ? Date.now() - entryAt : 0)
    const wallUsed = (): number =>
      Date.now() - startedAt - waitMs - (waitingSince ? Date.now() - waitingSince : 0)
    const overTime = (): boolean =>
      cpuUsed() > limits.timeoutMs || (pendingCalls === 0 && wallUsed() > limits.timeoutMs)

    rt.setInterruptHandler(() => {
      if (finished || overTime()) {
        interrupted = true
        return true
      }
      return false
    })

    const finish = (error?: ISandboxError, result?: { value: unknown }): void => {
      if (finished) {
        return
      }
      finished = true
      if (watchdog !== undefined) {
        clearTimeout(watchdog)
      }
      for (const t of hostTimers.values()) {
        clearTimeout(t)
      }
      hostTimers.clear()
      // The instance is not disposed handle by handle: nothing of it is reused, and dropping the
      // module frees its memory with it.
      resolve({
        ok: !error,
        stdout: out.join(''),
        ...(result ? { result: result.value } : {}),
        ...(error ? { error } : {}),
        truncated,
        durationMs: Date.now() - startedAt,
      })
    }

    const timedOut = (): ISandboxError => ({
      name: 'TimeoutError',
      message: `the run was stopped after ${limits.timeoutMs} ms (timeoutMs)`,
    })

    // Read a guest error. Runs guest code (getters), so it is skipped after an interrupt.
    const describe = (handle: Any): ISandboxError => {
      if (interrupted) {
        return timedOut()
      }
      try {
        let raw: unknown
        if (internals) {
          const r = ctx.callFunction(internals.describe, ctx.undefined, handle)
          raw = r.error ? undefined : JSON.parse(ctx.getString(r.value))
        }
        if (!Array.isArray(raw)) {
          const d = ctx.dump(handle) as { name?: unknown; message?: unknown; stack?: unknown }
          raw = [d?.name ?? 'Error', d?.message ?? String(d), d?.stack ?? '']
        }
        const [name, message, stack] = raw as unknown[]
        const frames = String(stack ?? '')
          .split('\n')
          .filter((line) => line.trim() && !line.includes(BOOTSTRAP_FILE))
          .join('\n')
        return {
          name: clip(String(name || 'Error'), ERROR_NAME_CHARS),
          message: clip(String(message ?? ''), ERROR_TEXT_CHARS),
          ...(frames ? { stack: clip(frames, ERROR_TEXT_CHARS) } : {}),
        }
      } catch {
        return interrupted
          ? timedOut()
          : { name: 'Error', message: 'the program threw an error that could not be read' }
      }
    }

    // Something escaped the engine as a HOST exception (the native stack ran out under a deep
    // guest recursion, or the engine trapped). The instance is not trusted after that.
    const engineFailure = (err: unknown): void => {
      if (interrupted) {
        finish(timedOut())
      } else if (err instanceof RangeError) {
        finish({ name: 'RangeError', message: 'Maximum call stack size exceeded' })
      } else {
        finish({ name: 'SandboxError', message: clip(errorText(err), ERROR_TEXT_CHARS) })
      }
    }

    const armWatchdog = (): void => {
      if (watchdog !== undefined) {
        clearTimeout(watchdog)
        watchdog = undefined
      }
      if (finished || pendingCalls > 0) {
        return
      }
      watchdog = setTimeout(
        () => {
          watchdog = undefined
          if (overTime()) {
            interrupted = true
            finish(timedOut())
          } else {
            armWatchdog()
          }
        },
        Math.max(1, limits.timeoutMs - wallUsed() + 1),
      )
    }

    // Look at the program's promise: done, failed, or still waiting on a timer / a file call.
    const settle = (): void => {
      while (!finished) {
        if (interrupted) {
          finish(timedOut())
          return
        }
        const state = ctx.getPromiseState(main)
        if (state.type === 'rejected') {
          finish(describe(state.error))
          return
        }
        if (state.type === 'pending') {
          if (hostTimers.size === 0 && pendingCalls === 0) {
            finish({
              name: 'Error',
              message:
                'the program awaits a promise that can never settle (nothing is left to run)',
            })
          }
          return
        }
        if (mainKind !== 'value') {
          main = ctx.getProp(state.value, mainKind === 'script' ? 'value' : 'default')
          mainKind = 'value'
          continue
        }
        if (!state.notAPromise) {
          main = state.value
          continue
        }
        // Like Node, the run ends when nothing is left to run - not when the last line is reached.
        if (hostTimers.size > 0 || pendingCalls > 0) {
          return
        }
        const max = Math.max(200, limits.maxOutputChars - outChars)
        const r = ctx.callFunction(
          internals.serialize,
          ctx.undefined,
          state.value,
          ctx.newNumber(max),
        )
        if (r.error) {
          finish(describe(r.error))
          return
        }
        const text = ctx.getString(r.value) as string
        if (text === '') {
          finish()
        } else if (text[0] === 'T') {
          truncated = true
          finish(undefined, { value: clip(text.slice(1), max) })
        } else {
          truncated ||= text[0] === 'C'
          finish(undefined, { value: JSON.parse(text.slice(1)) })
        }
        return
      }
    }

    // Every entry into the guest goes through here: timed, drained, then judged.
    const enter = (fn: () => void): void => {
      if (finished) {
        return
      }
      entryAt = Date.now()
      try {
        fn()
        while (!finished && !interrupted) {
          const jobs = rt.executePendingJobs()
          if (jobs.error) {
            const error = describe(jobs.error)
            cpuMs += Date.now() - entryAt
            entryAt = 0
            finish(error)
            return
          }
          if (!rt.hasPendingJob()) {
            break
          }
        }
        cpuMs += Date.now() - entryAt
        entryAt = 0
        settle()
      } catch (err) {
        cpuMs += Date.now() - entryAt
        entryAt = 0
        engineFailure(err)
      }
    }

    const guestError = (name: string, message: string): Error =>
      Object.assign(new Error(message), { name })

    const host = ctx.newObject()
    const expose = (name: string, fn: (...args: Any[]) => Any): void => {
      ctx.setProp(host, name, ctx.newFunction(name, fn))
    }
    expose('log', (levelHandle, textHandle) => {
      if (outChars >= limits.maxOutputChars) {
        truncated = true
        return
      }
      const level = ctx.getString(levelHandle) as string
      let line = `${level ? `[${level}] ` : ''}${ctx.getString(textHandle) as string}\n`
      if (outChars + line.length > limits.maxOutputChars) {
        line = line.slice(0, limits.maxOutputChars - outChars)
        truncated = true
      }
      out.push(line)
      outChars += line.length
    })
    expose('timer', (idHandle, msHandle) => {
      const id = ctx.getNumber(idHandle) as number
      const ms = ctx.getNumber(msHandle) as number
      const previous = hostTimers.get(id)
      if (previous !== undefined) {
        clearTimeout(previous)
      } else if (hostTimers.size >= MAX_TIMERS) {
        throw guestError('RangeError', 'too many timers')
      }
      hostTimers.set(
        id,
        setTimeout(
          () => {
            hostTimers.delete(id)
            enter(() => {
              const r = ctx.callFunction(internals.fire, ctx.undefined, ctx.newNumber(id))
              if (r.error) {
                // An exception nobody caught in a timer callback ends the run, as it would a process.
                finish(describe(r.error))
              }
            })
          },
          // A timer past the deadline never fires: the watchdog ends the run first.
          Math.min(Math.max(0, ms), limits.timeoutMs + 1),
        ),
      )
    })
    expose('clear', (idHandle) => {
      const id = ctx.getNumber(idHandle) as number
      const t = hostTimers.get(id)
      if (t !== undefined) {
        clearTimeout(t)
        hostTimers.delete(id)
      }
    })
    expose('call', (opHandle, argsHandle) => {
      const op = ctx.getString(opHandle) as string
      if (!hostOps.includes(op as SandboxHostOp) || !options.hostCall) {
        throw guestError('Error', `fs.${clip(op, 40)} is not available in this sandbox`)
      }
      if ((hostCalls += 1) > SANDBOX_MAX_HOST_CALLS) {
        throw guestError(
          'RangeError',
          `too many file operations in one run (limit ${SANDBOX_MAX_HOST_CALLS})`,
        )
      }
      const args = JSON.parse(ctx.getString(argsHandle) as string) as unknown[]
      const deferred = ctx.newPromise()
      if (pendingCalls === 0) {
        waitingSince = Date.now()
        if (watchdog !== undefined) {
          clearTimeout(watchdog)
          watchdog = undefined
        }
      }
      pendingCalls += 1
      const done = (settleGuest: () => void): void => {
        pendingCalls -= 1
        if (pendingCalls === 0) {
          waitMs += Date.now() - waitingSince
          waitingSince = 0
        }
        if (finished) {
          return
        }
        armWatchdog()
        enter(settleGuest)
      }
      options.hostCall(op, args).then(
        (value) =>
          done(() => {
            const text = value === undefined ? '' : JSON.stringify(value)
            deferred.resolve(ctx.newString(text ?? ''))
          }),
        (err: unknown) =>
          done(() => {
            deferred.reject(
              ctx.newError({
                name: 'Error',
                message: clip(err instanceof Error ? err.message : String(err), ERROR_TEXT_CHARS),
              }),
            )
          }),
      )
      return deferred.handle
    })
    const load = (path: string): string => {
      if (!modules) {
        throw guestError('Error', `Cannot load "${clip(path, 200)}": this sandbox has no files`)
      }
      if (!Object.hasOwn(modules, path)) {
        throw guestError(
          'Error',
          `Cannot load "${clip(path, 200)}": no such file in the workspace (a module must exist before the run and be named by a literal path)`,
        )
      }
      return modules[path]
    }
    const resolvePath = (base: string, spec: string): string => {
      try {
        return resolveModulePath(base, spec)
      } catch (err) {
        throw guestError('Error', err instanceof Error ? err.message : String(err))
      }
    }
    expose('resolve', (baseHandle, specHandle) =>
      ctx.newString(
        resolvePath(ctx.getString(baseHandle) as string, ctx.getString(specHandle) as string),
      ),
    )
    expose('compile', (pathHandle) => {
      const path = ctx.getString(pathHandle) as string
      const source = load(path)
      if (path.toLowerCase().endsWith('.json')) {
        return ctx.newString(source)
      }
      const r = ctx.evalCode(
        `(function (module, exports, require, __filename, __dirname) {${source}\n})`,
        path,
      )
      if (r.error) {
        return { error: r.error }
      }
      return r.value
    })
    // `import` (static and dynamic). Always installed, so that `import('node:fs')` fails with a
    // sentence the model can act on instead of an engine default.
    rt.setModuleLoader(
      (path: string) => {
        try {
          if (path.startsWith(REFUSED)) {
            throw new Error(path.slice(REFUSED.length))
          }
          const source = load(path)
          return path.toLowerCase().endsWith('.json')
            ? `export default JSON.parse(${JSON.stringify(source)})`
            : source
        } catch (err) {
          return { error: err as Error }
        }
      },
      (base: string, spec: string) => {
        // A refusal travels as a name the loader then refuses with the same sentence (the
        // engine drops an error returned from here).
        try {
          return resolveModulePath(base, spec)
        } catch (err) {
          return `${REFUSED}${err instanceof Error ? err.message : String(err)}`
        }
      },
    )

    try {
      const boot = ctx.evalCode(BOOTSTRAP, BOOTSTRAP_FILE)
      if (boot.error) {
        finish({ name: 'SandboxError', message: 'the sandbox runtime failed to start' })
        return
      }
      const made = ctx.callFunction(
        boot.value,
        ctx.undefined,
        host,
        ctx
          .evalCode(
            `(${JSON.stringify({
              max: limits.maxOutputChars,
              nameMax: ERROR_NAME_CHARS,
              textMax: ERROR_TEXT_CHARS,
              maxTimers: MAX_TIMERS,
              maxCall: SANDBOX_MAX_FILE_CHARS + 2000,
              ops: hostOps,
              filename,
            })})`,
            BOOTSTRAP_FILE,
          )
          .unwrap(),
      )
      if (made.error) {
        finish({ name: 'SandboxError', message: 'the sandbox runtime failed to start' })
        return
      }
      internals = {
        fire: ctx.getProp(made.value, 'fire'),
        serialize: ctx.getProp(made.value, 'serialize'),
        describe: ctx.getProp(made.value, 'describe'),
      }
    } catch (err) {
      engineFailure(err)
      return
    }

    options.onStart?.()
    armWatchdog()
    enter(() => {
      let evaluated = ctx.evalCode(request.code, filename, EVAL_SCRIPT_ASYNC)
      mainKind = 'script'
      // A script that does not compile has run nothing: when it is written as a module, run it as one.
      if (evaluated.error && !interrupted && looksLikeModule(request.code)) {
        evaluated = ctx.evalCode(request.code, filename, { type: 'module' })
        mainKind = 'module'
      }
      if (evaluated.error) {
        finish(describe(evaluated.error))
        return
      }
      main = evaluated.value
    })
  })
}

// ── What comes back ──────────────────────────────────────────────────────

const jsonSafe = (value: unknown, max: number): { value: unknown; cut: boolean } => {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    return { value: '[unserializable]', cut: true }
  }
  if (text === undefined) {
    return { value: undefined, cut: false }
  }
  if (text.length > max) {
    return { value: text.slice(0, max), cut: true }
  }
  // Re-parsed: what leaves is plain data, whatever was handed in.
  return { value: JSON.parse(text) as unknown, cut: false }
}

/**
 * The authoritative shape and size of a run's result. The engine already bounds what it
 * produces; this runs on the agent's side of the boundary and trusts none of it (a worker is
 * the guest's side).
 */
export const sanitizeSandboxResult = (raw: unknown, limits: ISandboxLimits): ISandboxResult => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  let truncated = r.truncated === true
  let stdout = typeof r.stdout === 'string' ? r.stdout : ''
  if (stdout.length > limits.maxOutputChars) {
    stdout = stdout.slice(0, limits.maxOutputChars)
    truncated = true
  }
  const result: ISandboxResult = { ok: r.ok === true, stdout, truncated, durationMs: 0 }
  if (Object.hasOwn(r, 'result') && r.result !== undefined) {
    const safe = jsonSafe(r.result, Math.max(200, limits.maxOutputChars - stdout.length))
    if (safe.value !== undefined) {
      result.result = safe.value
    }
    truncated ||= safe.cut
  }
  if (r.error && typeof r.error === 'object') {
    const e = r.error as Record<string, unknown>
    result.error = {
      name: clip(typeof e.name === 'string' ? e.name : 'Error', ERROR_NAME_CHARS),
      message: clip(typeof e.message === 'string' ? e.message : '', ERROR_TEXT_CHARS),
      ...(typeof e.stack === 'string' && e.stack ? { stack: clip(e.stack, ERROR_TEXT_CHARS) } : {}),
    }
    result.ok = false
  } else if (!result.ok) {
    result.error = { name: 'Error', message: 'the run failed' }
  }
  result.truncated = truncated
  result.durationMs =
    typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0
      ? Math.round(r.durationMs)
      : 0
  return result
}

// ── The worker protocol ──────────────────────────────────────────────────
// The guest does not run on the agent's thread. One worker serves one run and is thrown away.

export type SandboxToWorker =
  | { type: 'run'; request: ISandboxRequest }
  | { type: 'host-result'; id: number; ok: boolean; value?: unknown; error?: string }

export type SandboxFromWorker =
  | { type: 'started' }
  | { type: 'host-call'; id: number; op: string; args: unknown[] }
  | { type: 'done'; result: unknown }
  | { type: 'failed'; code: 'peer-missing' | 'engine'; message: string }

// A message channel as this file needs it; each package adapts its own worker type to it.
export interface ISandboxPort {
  post: (message: unknown) => void
  // `onClose` fires when the other side is gone (a worker that exited or crashed).
  listen: (onMessage: (message: unknown) => void, onClose?: (reason: string) => void) => void
  // The parent's side only: kill the worker.
  terminate?: () => void
}

/** The worker's side: load the engine, run what is posted, answer. */
export const serveSandbox = (port: ISandboxPort, loadLib: () => Promise<ISandboxLib>): void => {
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let seq = 0
  let busy = false
  const run = async (request: ISandboxRequest): Promise<void> => {
    let lib: ISandboxLib
    try {
      lib = await loadLib()
    } catch (err) {
      port.post({ type: 'failed', code: 'peer-missing', message: errorText(err) })
      return
    }
    try {
      const result = await runGuest(lib, request, {
        onStart: () => port.post({ type: 'started' }),
        hostCall: (op, args) =>
          new Promise((resolve, reject) => {
            const id = (seq += 1)
            waiting.set(id, { resolve, reject })
            port.post({ type: 'host-call', id, op, args })
          }),
      })
      port.post({ type: 'done', result })
    } catch (err) {
      port.post({ type: 'failed', code: 'engine', message: errorText(err) })
    }
  }
  port.listen((message) => {
    const m = message as SandboxToWorker
    if (m?.type === 'run' && !busy) {
      busy = true
      void run(m.request)
    } else if (m?.type === 'host-result') {
      const w = waiting.get(m.id)
      if (w) {
        waiting.delete(m.id)
        if (m.ok) {
          w.resolve(m.value)
        } else {
          w.reject(new Error(typeof m.error === 'string' ? m.error : 'the file operation failed'))
        }
      }
    }
  })
}

export interface IRunInWorkerOptions {
  hostCall?: SandboxHostCall
  signal?: AbortSignal
  // How long the worker may take to load the engine before the run is given up (default 20 s).
  startupMs?: number
  // How far past `timeoutMs` the worker lives before it is terminated (default 1000 ms).
  graceMs?: number
}

/**
 * The agent's side: post one run to a fresh worker and wait for it - or kill it. The engine's
 * own interrupt handler is the soft stop; `terminate()` here is the hard one, and it does not
 * depend on anything the guest does. Rejects only when the sandbox itself is unavailable (the
 * optional peer is missing, the worker never started) or the run was aborted.
 */
export const runInWorker = (
  port: ISandboxPort,
  request: ISandboxRequest,
  options: IRunInWorkerOptions = {},
): Promise<ISandboxResult> =>
  new Promise<ISandboxResult>((resolve, reject) => {
    const { limits } = request
    const startedAt = Date.now()
    const graceMs = options.graceMs ?? 1000
    let over = false
    let serving = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      over = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      options.signal?.removeEventListener('abort', onAbort)
      try {
        port.terminate?.()
      } catch {
        /* already gone */
      }
    }
    const end = (result: ISandboxResult): void => {
      if (over) {
        return
      }
      stop()
      resolve({ ...result, durationMs: Date.now() - startedAt })
    }
    const fail = (err: Error): void => {
      if (over) {
        return
      }
      stop()
      reject(err)
    }
    const failed = (name: string, message: string): ISandboxResult => ({
      ok: false,
      stdout: '',
      error: { name, message },
      truncated: false,
      durationMs: 0,
    })
    function onAbort(): void {
      fail(Object.assign(new Error('The run was aborted'), { name: 'AbortError' }))
    }
    const arm = (ms: number, onFire: () => void): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      timer = setTimeout(onFire, ms)
    }
    const armKill = (): void =>
      arm(limits.timeoutMs + graceMs, () =>
        end(
          failed(
            'TimeoutError',
            `the run was killed after ${limits.timeoutMs} ms (timeoutMs): it did not stop by itself`,
          ),
        ),
      )
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    arm(options.startupMs ?? 20_000, () =>
      fail(new SandboxUnavailableError('the sandbox worker did not start in time')),
    )
    port.listen(
      (message) => {
        if (over) {
          return
        }
        const m = message as SandboxFromWorker
        switch (m?.type) {
          case 'started':
            armKill()
            break
          case 'host-call': {
            const id = m.id
            serving += 1
            // The clock does not run while the agent's side serves a call (it may be asking the user).
            if (timer !== undefined) {
              clearTimeout(timer)
              timer = undefined
            }
            const answer = (reply: SandboxToWorker): void => {
              serving -= 1
              if (over) {
                return
              }
              if (serving === 0) {
                armKill()
              }
              port.post(reply)
            }
            const call = options.hostCall
              ? options.hostCall(String(m.op), Array.isArray(m.args) ? m.args : [])
              : Promise.reject(new Error('this sandbox has no files'))
            call.then(
              (value) => answer({ type: 'host-result', id, ok: true, value }),
              (err: unknown) =>
                answer({
                  type: 'host-result',
                  id,
                  ok: false,
                  error: clip(err instanceof Error ? err.message : String(err), ERROR_TEXT_CHARS),
                }),
            )
            break
          }
          case 'done':
            end(sanitizeSandboxResult(m.result, limits))
            break
          case 'failed':
            fail(
              m.code === 'peer-missing'
                ? sandboxPeerMissing(clip(String(m.message), 300))
                : new SandboxUnavailableError(
                    `the sandbox engine failed: ${clip(String(m.message), 300)}`,
                  ),
            )
            break
        }
      },
      (reason) =>
        end(failed('SandboxError', `the sandbox stopped unexpectedly: ${clip(reason, 300)}`)),
    )
    port.post({ type: 'run', request } satisfies SandboxToWorker)
  })

// At most `size` runs at once; the rest wait their turn (each run is a worker and a heap).
export const createSandboxQueue = (size: number): (<T>(task: () => Promise<T>) => Promise<T>) => {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= size) {
      await new Promise<void>((go) => waiting.push(go))
    }
    active += 1
    try {
      return await task()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}
