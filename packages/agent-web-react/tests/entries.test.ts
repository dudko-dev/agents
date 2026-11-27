import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import * as main from '../dist/index.js'
import * as mcp from '../dist/mcp.js'

// The bundle-level invariant behind the `./mcp` subpath. `useMcp` reaches the core's
// `@dudko.dev/agent-web/mcp` with a dynamic import, and a bundler resolves a dynamic import at
// BUILD time: webpack followed it into the core's mcp.js, whose static imports of the optional
// `@modelcontextprotocol/client` (`@modelcontextprotocol/sdk` before the 2.x SDK) failed the build
// of hosts that never touched MCP. Nothing in the main entry may mention that path again, whatever
// it is refactored into.

const read = (file: string): string =>
  readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8')

test('main entry (ESM and CJS) never references the core MCP subpath', () => {
  for (const file of ['index.js', 'index.cjs']) {
    assert.doesNotMatch(
      read(file),
      /agent-web\/mcp/,
      `${file} must not mention @dudko.dev/agent-web/mcp — a bundler would follow it into the optional SDK`,
    )
  }
})

test('no entry of this package names the MCP SDK: only the core imports it', () => {
  // Neither the 2.x package nor the 1.x one, in any entry or chunk: this package reaches the SDK
  // through the core's `./mcp` alone, so a host installs one copy, next to the core.
  const files = readdirSync(new URL('../dist/', import.meta.url)).filter((f) =>
    /\.(js|cjs)$/.test(f),
  )
  assert.ok(files.includes('index.js') && files.includes('mcp.js'))
  for (const file of files) {
    assert.doesNotMatch(
      read(file),
      /(?:from\s*|import\(\s*|require\(\s*)["']@modelcontextprotocol\//,
      `${file} must not import the MCP SDK`,
    )
  }
})

test('main entry does not ship the MCP hooks, and does not leave a stub behind', () => {
  for (const name of ['useMcp', 'useMcpServers', 'readCallbackParams', 'claimOAuthCallback']) {
    assert.equal(name in main, false, `${name} moved to @dudko.dev/agent-web-react/mcp`)
  }
})

test('the mcp entry carries the hooks, and is the one place that loads the core connector', () => {
  for (const name of [
    'useMcp',
    'useMcpServers',
    'readCallbackParams',
    'claimOAuthCallback',
    'stripOAuthParams',
    'describeMcpResult',
    'isUnauthorizedError',
  ]) {
    assert.equal(typeof (mcp as Record<string, unknown>)[name], 'function', `${name} is exported`)
  }
  assert.match(read('mcp.js'), /import\(["']@dudko\.dev\/agent-web\/mcp["']\)/)
})

test('the CommonJS build of the mcp entry loads too', () => {
  const require = createRequire(import.meta.url)
  const cjs = require('../dist/mcp.cjs') as Record<string, unknown>
  assert.equal(typeof cjs.useMcpServers, 'function')
  assert.equal(typeof cjs.useMcp, 'function')
})

test('package.json exposes ./mcp with types for both module systems', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    exports: Record<
      string,
      { import: { types: string; default: string }; require: { types: string; default: string } }
    >
  }
  const entry = pkg.exports['./mcp']
  assert.ok(entry, './mcp is declared')
  for (const target of [
    entry.import.types,
    entry.import.default,
    entry.require.types,
    entry.require.default,
  ]) {
    assert.ok(
      readFileSync(new URL(`../${target}`, import.meta.url)),
      `${target} exists after a build`,
    )
  }
})

// ── The pipeline editor: the same rule, for a different reason ───────────────
// A chat host should not carry a canvas, an inspector and a code generator, nor need a core new
// enough to have `createPipeline` (an ESM named import of a missing export fails the whole
// module). So nothing of it may be reachable from the main entry - not directly, and not through
// a chunk the bundler shares between the entries.

const mainGraph = (): string[] => {
  const seen = new Set<string>(['index.js'])
  const queue = ['index.js']
  while (queue.length) {
    for (const [, chunk] of read(queue.pop() as string).matchAll(/from\s*["']\.\/([^"']+)["']/g)) {
      if (!seen.has(chunk)) {
        seen.add(chunk)
        queue.push(chunk)
      }
    }
  }
  return [...seen, 'index.cjs']
}

test('main entry (and every chunk it loads) carries nothing of the pipeline editor', () => {
  for (const file of mainGraph()) {
    assert.doesNotMatch(
      read(file),
      /createPipeline|nodeResolver|validatePipeline|awr-pipeline|awr-canvas|awr-pnode/,
      `${file} must not reference the pipeline editor or the core's pipeline API`,
    )
  }
  for (const name of ['PipelineEditor', 'usePipeline', 'pipelineStateReducer', 'Canvas']) {
    assert.equal(name in main, false, `${name} lives in @dudko.dev/agent-web-react/pipeline`)
  }
})

test('the pipeline entry carries the editor, the hook, the reducer, the helpers and the canvas', async () => {
  const pipeline = (await import('../dist/pipeline.js')) as Record<string, unknown>
  for (const name of [
    'PipelineEditor',
    'PipelineInspector',
    'PipelineNodeCard',
    'PipelineResults',
    'PipelineIssues',
    'PipelineCodeDialog',
    'PipelineLabelsProvider',
    'usePipeline',
    'usePipelineLabels',
    'pipelineStateReducer',
    'createInitialPipelineState',
    'pipelineToCode',
    'addNode',
    'removeNode',
    'renameNode',
    'addEdge',
    'updateEdge',
    'removeEdge',
    'setEntry',
    'autoLayout',
    'parsePipelineJson',
    'CanvasPort',
    'fitViewport',
    'edgeCurve',
    'createPipeline',
    'validatePipeline',
    'nodeResolver',
  ]) {
    assert.equal(typeof pipeline[name], 'function', `${name} is exported`)
  }
  assert.ok(pipeline.Canvas, 'Canvas is exported')
  assert.equal(typeof pipeline.defaultPipelineLabels, 'object')
})

test('the pipeline entry adds no runtime dependency: React, the core, and its own chunks', () => {
  const allowed = /^(react|react\/jsx-runtime|@dudko\.dev\/agent-web|\.\/chunk-[\w-]+\.js)$/
  // Import and re-export statements only: the code generator's own text mentions packages too.
  const statements = /^(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/gm
  for (const [, target] of read('pipeline.js').matchAll(statements)) {
    assert.match(target, allowed, `pipeline.js imports ${target}`)
  }
  const required = [...read('pipeline.cjs').matchAll(/require\(["']([^"']+)["']\)/g)].map(
    (m) => m[1],
  )
  assert.deepEqual([...new Set(required)].sort(), [
    '@dudko.dev/agent-web',
    'react',
    'react/jsx-runtime',
  ])
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  assert.equal(pkg.dependencies, undefined, 'the package has peers, and no dependencies')
})

test('the CommonJS build of the pipeline entry loads too', () => {
  const require = createRequire(import.meta.url)
  const cjs = require('../dist/pipeline.cjs') as Record<string, unknown>
  assert.equal(typeof cjs.PipelineEditor, 'function')
  assert.equal(typeof cjs.usePipeline, 'function')
  assert.equal(typeof cjs.pipelineStateReducer, 'function')
})

test('package.json exposes ./pipeline (both module systems) and its stylesheet', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    exports: Record<string, unknown>
  }
  const entry = pkg.exports['./pipeline'] as {
    import: { types: string; default: string }
    require: { types: string; default: string }
  }
  assert.ok(entry, './pipeline is declared')
  for (const target of [
    entry.import.types,
    entry.import.default,
    entry.require.types,
    entry.require.default,
    pkg.exports['./pipeline.css'] as string,
  ]) {
    assert.ok(
      readFileSync(new URL(`../${target}`, import.meta.url)),
      `${target} exists after a build`,
    )
  }
})

test('pipeline.css stands on its own and stays inside the package’s names', () => {
  const css = read('pipeline.css').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(css, /@import/, 'no stylesheet is pulled in')
  // Every class is `awr-` prefixed (`is-` state classes aside), every custom property `--awr-`.
  const selectors = css.replace(/\{[^{}]*\}/g, '{}')
  const classes = [...selectors.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(classes.filter((c) => !c.startsWith('awr-') && !c.startsWith('is-')))],
    [],
  )
  const declared = [...css.matchAll(/[{;]\s*(--[\w-]+)\s*:/g)].map((m) => m[1])
  assert.ok(declared.length > 10)
  assert.deepEqual([...new Set(declared.filter((p) => !p.startsWith('--awr-')))], [])
  // The light/dark mechanism of styles.css, kept: defaults, the system's dark, a forced scheme.
  assert.match(css, /prefers-color-scheme: dark/)
  assert.match(css, /\[data-awr-theme='dark'\]/)
  assert.match(css, /:not\(\[data-awr-theme='light'\]\)/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /touch-action: none/)
})

// ── The MCP Apps sandbox page: for a SERVER ──────────────────────────────────
// `./mcp-app-sandbox` is what a Worker (or Node, Deno, Bun) serves on another origin: it must load
// without React, without the core (whose main entry does not tree-shake into a small Worker) and
// without anything else - its chunks included.

const graphOf = (entry: string): string[] => {
  const seen = new Set<string>([entry])
  const queue = [entry]
  while (queue.length) {
    for (const [, chunk] of read(queue.pop() as string).matchAll(/from\s*["']\.\/([^"']+)["']/g)) {
      if (!seen.has(chunk)) {
        seen.add(chunk)
        queue.push(chunk)
      }
    }
  }
  return [...seen]
}

test('the mcp-app-sandbox entry imports nothing but its own chunks (ESM and CJS)', async () => {
  const statements = /^(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/gm
  for (const file of graphOf('mcp-app-sandbox.js')) {
    for (const [, target] of read(file).matchAll(statements)) {
      assert.match(target, /^\.\/chunk-[\w-]+\.js$/, `${file} imports ${target}`)
    }
    assert.doesNotMatch(read(file), /import\(/, `${file} has no dynamic import`)
  }
  const required = [...read('mcp-app-sandbox.cjs').matchAll(/require\(["']([^"']+)["']\)/g)]
  assert.deepEqual(
    required.map((m) => m[1]).filter((t) => !t.startsWith('./')),
    [],
    'the CJS build requires nothing',
  )
  const esm = (await import('../dist/mcp-app-sandbox.js')) as Record<string, unknown>
  const require = createRequire(import.meta.url)
  const cjs = require('../dist/mcp-app-sandbox.cjs') as Record<string, unknown>
  for (const name of [
    'mcpAppSandboxResponse',
    'mcpAppSandboxPage',
    'mcpAppSandboxHeaders',
    'parseMcpAppSandboxHosts',
    'mcpAppPolicyOfToken',
  ]) {
    assert.equal(typeof esm[name], 'function', name)
    assert.equal(typeof cjs[name], 'function', `${name} (CJS)`)
  }
  assert.equal(typeof esm.MCP_APP_SANDBOX_SCRIPT, 'string')
})

test('package.json exposes ./mcp-app-sandbox with types for both module systems', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    exports: Record<
      string,
      { import: { types: string; default: string }; require: { types: string; default: string } }
    >
  }
  const entry = pkg.exports['./mcp-app-sandbox']
  assert.ok(entry, './mcp-app-sandbox is declared')
  for (const target of [
    entry.import.types,
    entry.import.default,
    entry.require.types,
    entry.require.default,
  ]) {
    assert.ok(readFileSync(new URL(`../${target}`, import.meta.url)), `${target} exists`)
  }
})
