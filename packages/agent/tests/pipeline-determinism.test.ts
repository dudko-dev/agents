import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { preparePipeline, runPipelineGraph, type PipelineDefinition } from '../src/index.ts'

const ENGINE = new URL('../src/pipeline-engine.ts', import.meta.url)

// The determinism contract of the pipeline engine (its header comment): no clock, no randomness,
// no timers, no I/O, no imports, no global the language does not define - a run depends only on
// the definition, the input and the runner's answers in order. Held two ways: a scan of the
// engine's source, and a run inside a `node:vm` context that has nothing but the language's
// globals, compared with a normal run. Everything below this line is the same in packages/agent
// and packages/agent-web (only the import and the engine's path above differ).

const engineSource = (): string => readFileSync(ENGINE, 'utf8')

// ── the scan ─────────────────────────────────────────────────────────────────

// Names the engine must not read: a clock, randomness, timers, I/O, the host's global object,
// code from strings, garbage-collection hooks, locales.
const FORBIDDEN_NAMES = new Set([
  'Date',
  'performance',
  'crypto',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'requestIdleCallback',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'process',
  'require',
  'globalThis',
  'window',
  'self',
  'global',
  'eval',
  'Function',
  'WeakRef',
  'FinalizationRegistry',
  'SharedArrayBuffer',
  'Atomics',
  'Intl',
])
// Members that are as bad as a global: Math.random, and what reads the host's locale.
const FORBIDDEN_MEMBERS = new Set([
  'random',
  'localeCompare',
  'toLocaleString',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
])

// Every forbidden use in a source, as `<line>: <what>`. Parsed, not grepped: a comment or a string
// that mentions `Date` is not a use of it, and `x.Date` / `{ Date: 1 }` name a property.
const violations = (source: string): string[] => {
  const file = ts.createSourceFile('engine.ts', source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const at = (node: ts.Node, what: string): void => {
    found.push(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${what}`)
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
    ) {
      at(node, 'a module import')
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      at(node, 'import()')
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      at(node, 'import.meta')
    } else if (ts.isImportTypeNode(node)) {
      at(node, 'import("...") in a type')
    } else if (ts.isIdentifier(node)) {
      const parent = node.parent
      const member = ts.isPropertyAccessExpression(parent) && parent.name === node
      const key =
        (ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyDeclaration(parent)) &&
        parent.name === node
      if (member && FORBIDDEN_MEMBERS.has(node.text)) at(node, `.${node.text}`)
      if (!member && !key && FORBIDDEN_NAMES.has(node.text)) at(node, node.text)
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      (FORBIDDEN_NAMES.has(node.argumentExpression.text) ||
        FORBIDDEN_MEMBERS.has(node.argumentExpression.text))
    ) {
      at(node, `["${node.argumentExpression.text}"]`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

test('determinism: the scan finds every forbidden form, and nothing in comments or strings', () => {
  const caught = [
    'const t = Date.now()',
    'const d = new Date()',
    'const r = Math.random()',
    "const r = Math['random']()",
    'setTimeout(() => {}, 0)',
    'const h = setInterval(f, 10)',
    'const t = performance.now()',
    'const id = crypto.randomUUID()',
    "import { x } from './x.ts'",
    "import './side-effect.ts'",
    "export { x } from './x.ts'",
    "export * from './x.ts'",
    "const m = await import('./x.ts')",
    'const u = import.meta.url',
    "type T = import('./x.ts').T",
    'const g = globalThis.fetch',
    "const f = new Function('return 1')",
    'const s = a.localeCompare(b)',
    'const p = process.env',
  ]
  for (const snippet of caught) {
    assert.notDeepEqual(violations(snippet), [], `the scan must catch: ${snippet}`)
  }
  const clean = [
    '// Date, Math.random, setTimeout, import, crypto - only words here',
    "const words = 'Date performance crypto import'",
    'const o = { Date: 1, random: 2 }; o.Date; o.performance',
    'interface I { setTimeout: number }',
    'const n = Math.max(1, 2)',
    'export const x = 1',
    'export { x as y }',
  ]
  for (const snippet of clean) assert.deepEqual(violations(snippet), [], snippet)
})

test('determinism: the engine reads no clock, randomness, timer, host global or module', () => {
  assert.deepEqual(
    violations(engineSource()),
    [],
    'the pipeline engine is a deterministic scheduler: see its header comment',
  )
})

// ── the sandbox ──────────────────────────────────────────────────────────────

// The language's own globals the engine uses, and nothing else: no Date, no timers, no crypto,
// no performance, no console, no DOMException, no AbortController. `Math` without `random`.
const LANGUAGE_GLOBALS = [
  'Array',
  'Boolean',
  'Error',
  'Infinity',
  'Int32Array',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'RegExp',
  'Set',
  'String',
  'globalThis',
  'parseInt',
  'undefined',
]

interface IEngine {
  preparePipeline: typeof preparePipeline
  runPipelineGraph: typeof runPipelineGraph
}

// A `node:vm` context with only LANGUAGE_GLOBALS (and `host`, given from this realm), and the
// engine evaluated in it: its own source with the types erased, nothing else changed.
const sandbox = (host: Record<string, unknown> = {}) => {
  const context = vm.createContext({})
  vm.runInContext(
    `for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (!${JSON.stringify(LANGUAGE_GLOBALS)}.includes(name)) delete globalThis[name]
    }
    delete Math.random`,
    context,
  )
  Object.assign(context, host)
  const { outputText } = ts.transpileModule(engineSource(), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const engine = vm.runInContext(
    `(function () { 'use strict'; var exports = {};\n${outputText}\nreturn exports })()`,
    context,
  ) as IEngine
  const inside = <T>(code: string): T => vm.runInContext(code, context) as T
  return { engine, inside }
}

// One visit of a scenario: its answer, how many microtask turns it takes (the order the answers
// arrive in), and what it does besides answering.
interface IStep {
  text?: string
  route?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  turns?: number
  // Abort the run's signal (the host's) during the visit.
  abort?: boolean
  // Reject with this message.
  fail?: string
  // Log what the visit's `ctx.signal` says when it aborts.
  watch?: boolean
  // Add an abort listener that throws (only where a throwing listener is not the platform's
  // uncaught error: the sandbox without AbortController).
  throwing?: boolean
}

interface IScenario {
  definition: PipelineDefinition
  // By `<node>#<visit>`, else by `<node>`.
  script: Record<string, IStep>
  onAbort?: 'reject' | 'resolve'
  abortBefore?: boolean
}

// Runs one scenario on `engine` and describes everything that happened as JSON: the result or the
// error, every event, and the runner's log. It closes over nothing, so the same function runs in
// this realm and - from its source text - inside a sandbox; it brings its own stand-in for the
// host's signal where there is no AbortController.
async function drive(engine: IEngine, scenarioJson: string): Promise<string> {
  const scenario = JSON.parse(scenarioJson) as IScenario
  const log: string[] = []
  const events: unknown[] = []
  let signal: AbortSignal
  let abort: () => void
  if (typeof AbortController === 'function') {
    const controller = new AbortController()
    signal = controller.signal
    abort = () => controller.abort()
  } else {
    const listeners: (() => void)[] = []
    const standIn = {
      aborted: false,
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: (_type: string, listener: () => void) => {
        if (listeners.includes(listener)) listeners.splice(listeners.indexOf(listener), 1)
      },
    }
    signal = standIn as unknown as AbortSignal
    abort = () => {
      if (standIn.aborted) return
      standIn.aborted = true
      for (const listener of listeners.splice(0)) listener()
    }
  }
  if (scenario.abortBefore) abort()

  const runNode = async (
    node: { id: string },
    input: { visit: number; from: { nodeId: string }[] },
    ctx: { signal: AbortSignal; emit: (event: { type: string; key: string }) => void },
  ) => {
    const key = `${node.id}#${input.visit}`
    const step = scenario.script[key] ?? scenario.script[node.id] ?? {}
    log.push(`start ${key} from [${input.from.map((f) => f.nodeId).join(',')}]`)
    if (step.watch) {
      const said = (how: string): void => {
        let thrown = 'nothing'
        try {
          ctx.signal.throwIfAborted()
        } catch (err) {
          thrown = (err as Error).name
        }
        const reason = (ctx.signal.reason as Error | undefined)?.name
        log.push(`${key} ${how}: aborted ${ctx.signal.aborted}, reason ${reason}, threw ${thrown}`)
      }
      if (step.throwing) {
        ctx.signal.addEventListener('abort', () => {
          throw new Error('a listener that throws')
        })
      }
      // Added twice, runs once; an object with handleEvent; one removed again; then onabort.
      const listener = (): void => said('listener')
      ctx.signal.addEventListener('abort', listener, { once: true })
      ctx.signal.addEventListener('abort', listener)
      ctx.signal.addEventListener('abort', { handleEvent: () => said('handleEvent') })
      const removed = (): void => said('a removed listener')
      ctx.signal.addEventListener('abort', removed)
      ctx.signal.removeEventListener('abort', removed)
      ctx.signal.onabort = () => said('onabort')
    }
    ctx.emit({ type: 'step.said', key })
    for (let turn = 0; turn < (step.turns ?? 0); turn++) await null
    if (step.abort) abort()
    if (step.fail) throw new Error(step.fail)
    log.push(`end ${key}`)
    return {
      text: step.text ?? `${key} output`,
      ...(step.route ? { route: step.route } : {}),
      ...(step.usage ? { usage: step.usage } : {}),
    }
  }

  let outcome: unknown
  try {
    const result = await engine.runPipelineGraph(
      engine.preparePipeline(scenario.definition),
      runNode as never,
      {
        input: 'the request',
        signal,
        onEvent: (event) => events.push(event),
        ...(scenario.onAbort ? { onAbort: scenario.onAbort } : {}),
      },
    )
    outcome = { result }
  } catch (err) {
    const e = err as Error & { nodeId?: string; visit?: number }
    outcome = {
      error: {
        name: e.name,
        message: e.message,
        nodeId: e.nodeId,
        visit: e.visit,
        cause: (e.cause as Error | undefined)?.message,
      },
    }
  }
  return JSON.stringify({ outcome, events, log })
}

// plan → research, draft; draft → polish; research, polish → merge (join all); research, polish
// → log (join any); merge → review, whose routes go to publish or to fix → review (the loop), and
// whose text also decides notes ("contains"), scores ("matches") and fallback ("otherwise");
// publish → announce, archive (two terminals of one wave).
const everything: PipelineDefinition = {
  version: 1,
  name: 'everything',
  entry: 'plan',
  nodes: [
    { id: 'plan' },
    { id: 'research', name: 'Research' },
    { id: 'draft' },
    { id: 'polish' },
    { id: 'merge', name: 'Merge' },
    { id: 'log', join: 'any' },
    {
      id: 'review',
      routes: [{ label: 'approve' }, { label: 'revise', description: 'not yet' }],
    },
    { id: 'fix' },
    { id: 'publish' },
    { id: 'announce', name: 'Announcement' },
    { id: 'archive' },
    { id: 'notes' },
    { id: 'scores' },
    { id: 'fallback' },
  ],
  edges: [
    { from: 'plan', to: 'research' },
    { from: 'plan', to: 'draft' },
    { from: 'draft', to: 'polish' },
    { from: 'research', to: 'merge' },
    { from: 'polish', to: 'merge' },
    { from: 'research', to: 'log' },
    { from: 'polish', to: 'log' },
    { from: 'merge', to: 'review' },
    { id: 'ok', from: 'review', to: 'publish', when: { kind: 'route', label: 'approve' } },
    { id: 'again', from: 'review', to: 'fix', when: { kind: 'route', label: 'revise' } },
    { from: 'fix', to: 'review' },
    { from: 'review', to: 'notes', when: { kind: 'contains', text: 'NOTE' } },
    {
      from: 'review',
      to: 'scores',
      when: { kind: 'matches', pattern: '^score: \\d+$', flags: 'm' },
    },
    { from: 'review', to: 'fallback', when: { kind: 'otherwise' } },
    { from: 'publish', to: 'announce' },
    { from: 'publish', to: 'archive' },
  ],
  limits: { maxNodeVisits: 2, maxRuns: 40 },
}

const usage = (n: number) => ({ inputTokens: n, outputTokens: 1, totalTokens: n + 1 })

const SCENARIOS: Record<string, IScenario> = {
  'waves, joins, routes, conditions and the loop': {
    definition: everything,
    script: {
      // research answers last of its wave, polish takes a turn: the arrival order matters.
      research: { turns: 3, usage: usage(5) },
      polish: { turns: 1 },
      'review#1': { route: 'revise', text: 'a note: tighten it', usage: usage(7) },
      'review#2': { route: 'approve', text: 'fine\nscore: 9' },
      announce: { turns: 2 },
    },
  },
  'the loop under its cap': {
    definition: everything,
    script: { review: { route: 'revise', text: 'again' } },
  },
  'a label the node does not have': {
    definition: everything,
    script: { review: { route: 'ship-it', text: 'nothing to add' } },
  },
  maxRuns: {
    definition: { ...everything, limits: { maxNodeVisits: 5, maxRuns: 9 } },
    script: { review: { route: 'revise' } },
  },
  'a node that fails while a sibling watches': {
    definition: everything,
    script: {
      research: { turns: 2, watch: true },
      draft: { fail: 'the worker is gone' },
    },
  },
  'an abort, resolved': {
    definition: everything,
    onAbort: 'resolve',
    script: { log: { watch: true, turns: 4 }, polish: { abort: true } },
  },
  'an abort, rejected': {
    definition: everything,
    script: { log: { watch: true, turns: 4 }, polish: { abort: true } },
  },
  'aborted before it starts': {
    definition: everything,
    onAbort: 'resolve',
    abortBefore: true,
    script: {},
  },
}

const runs = async (): Promise<Record<string, Record<string, string>>> => {
  const withHostApis = sandbox({ DOMException, AbortController })
  const languageOnly = sandbox()
  const engines: Record<string, IEngine> = { here: { preparePipeline, runPipelineGraph } }
  const drivers: Record<string, typeof drive> = { here: drive }
  for (const [name, box] of Object.entries({ withHostApis, languageOnly })) {
    engines[name] = box.engine
    drivers[name] = box.inside<typeof drive>(`(${drive.toString()})`)
  }
  const out: Record<string, Record<string, string>> = {}
  for (const [scenario, definition] of Object.entries(SCENARIOS)) {
    const json = JSON.stringify(definition)
    out[scenario] = {}
    for (const where of Object.keys(engines)) {
      out[scenario][where] = await drivers[where](engines[where], json)
    }
    out[scenario].again = await drive(engines.here, json)
  }
  return out
}

test('determinism: the sandbox has only the language - no clock, timers, crypto or host APIs', () => {
  const { inside } = sandbox()
  assert.deepEqual(
    JSON.parse(inside('JSON.stringify(Object.getOwnPropertyNames(globalThis).sort())')),
    [...LANGUAGE_GLOBALS].sort(),
  )
  for (const name of [
    'Date',
    'Math.random',
    'setTimeout',
    'setInterval',
    'queueMicrotask',
    'performance',
    'crypto',
    'DOMException',
    'AbortController',
    'AbortSignal',
    'console',
  ]) {
    assert.equal(inside(`typeof ${name}`), 'undefined', name)
  }
})

test('determinism: a run in the sandbox is the run here, with or without DOMException and AbortController', async () => {
  const all = await runs()
  for (const [scenario, by] of Object.entries(all)) {
    assert.equal(by.again, by.here, `${scenario}: the same answers in the same order, the same run`)
    assert.equal(by.withHostApis, by.here, `${scenario}: in a sandbox with the host's APIs`)
    assert.equal(by.languageOnly, by.here, `${scenario}: in a sandbox with the language only`)
  }

  // What the runs were: each scenario did what its name says (or the comparison proves little).
  const parsed = (scenario: string) =>
    JSON.parse(all[scenario].languageOnly) as {
      outcome: {
        result?: { text: string; runs: number; stoppedBy?: string; outputs: object }
        error?: Record<string, unknown>
      }
      events: { type: string }[]
      log: string[]
    }
  const rich = parsed('waves, joins, routes, conditions and the loop')
  assert.equal(rich.outcome.result?.stoppedBy, undefined)
  assert.equal(rich.outcome.result?.runs, 15)
  // Two terminals of the last wave, in the order their answers arrived (announce took longer).
  assert.equal(
    rich.outcome.result?.text,
    '## archive\n\narchive#1 output\n\n## Announcement\n\nannounce#1 output',
  )
  assert.deepEqual(
    Object.keys(rich.outcome.result?.outputs ?? {}).sort(),
    [
      'announce',
      'archive',
      'draft',
      'fix',
      'log',
      'merge',
      'notes',
      'plan',
      'polish',
      'publish',
      'research',
      'review',
      'scores',
    ],
    'every condition fired somewhere, so nothing fell back',
  )
  assert.ok(rich.log.includes('start merge#1 from [research,polish]'), 'the join got both')
  assert.ok(rich.log.includes('start log#2 from [polish]'), "the 'any' join ran per arrival")
  const capped = parsed('the loop under its cap').outcome.result
  assert.deepEqual(
    [capped?.stoppedBy, capped?.runs, capped?.text],
    ['maxNodeVisits', 11, 'fix#2 output'],
  )
  assert.equal(parsed('a label the node does not have').outcome.result?.text, 'fallback#1 output')
  const maxRuns = parsed('maxRuns').outcome.result
  assert.deepEqual([maxRuns?.stoppedBy, maxRuns?.runs], ['maxRuns', 9])

  const failed = parsed('a node that fails while a sibling watches')
  assert.deepEqual(failed.outcome.error, {
    name: 'PipelineNodeError',
    message: 'Pipeline node "draft" failed (visit 1): the worker is gone',
    nodeId: 'draft',
    visit: 1,
    cause: 'the worker is gone',
  })
  // Without AbortController the visits' signal is the engine's stand-in, and it behaves as one.
  assert.deepEqual(
    failed.log.filter((l) => l.startsWith('research#1 ')),
    [
      'research#1 listener: aborted true, reason AbortError, threw AbortError',
      'research#1 handleEvent: aborted true, reason AbortError, threw AbortError',
      'research#1 onabort: aborted true, reason AbortError, threw AbortError',
    ],
  )
  assert.equal(failed.events.at(-1)?.type, 'pipeline.node.failed')

  const resolved = parsed('an abort, resolved')
  assert.deepEqual(
    [resolved.outcome.result?.stoppedBy, resolved.outcome.result?.runs],
    ['aborted', 5],
  )
  assert.ok(
    resolved.log.includes('log#1 listener: aborted true, reason AbortError, threw AbortError'),
  )
  // Without DOMException the abort error is an Error with the same name and message.
  assert.deepEqual(parsed('an abort, rejected').outcome.error, {
    name: 'AbortError',
    message: 'Aborted',
  })
  const before = parsed('aborted before it starts')
  assert.equal(before.outcome.result?.runs, 0)
  assert.deepEqual(before.log, [])
})

test('determinism: without AbortController, a listener that throws breaks neither the others nor the run', async () => {
  // With a real AbortController a throwing listener is the platform's uncaught error, so this is
  // the stand-in's alone: the run must be the run without that listener.
  const { engine, inside } = sandbox()
  const run = inside<typeof drive>(`(${drive.toString()})`)
  for (const name of ['a node that fails while a sibling watches', 'an abort, resolved']) {
    const scenario = SCENARIOS[name]
    const watcher = Object.keys(scenario.script).find((key) => scenario.script[key].watch) as string
    const throwing = {
      ...scenario,
      script: { ...scenario.script, [watcher]: { ...scenario.script[watcher], throwing: true } },
    }
    assert.equal(
      await run(engine, JSON.stringify(throwing)),
      await run(engine, JSON.stringify(scenario)),
      name,
    )
  }
})
