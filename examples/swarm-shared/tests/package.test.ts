// What the package ships (`dist`, `build`): files that import nothing but each other - no node:*,
// no dependency at all - so every platform can load them; and `./workflow`, the part a workflow
// sandbox runs, holds the session logic and none of the HTTP API, the logger or anything with a
// clock, randomness or I/O. Read from the built files: what a consumer gets.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const dist = new URL('../dist/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, { types: string; default: string }>
  dependencies?: Record<string, string>
}

const code = (file: string): string => readFileSync(new URL(file, dist), 'utf8')
// Every module specifier of an ES module: static imports and re-exports, dynamic imports.
const specifiers = (text: string): string[] => [
  ...[...text.matchAll(/^\s*(?:import|export)\b[^'"\n;]*\bfrom\s*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1]!,
  ),
  ...[...text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]!),
  ...[...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
]
// The code without its comments (the files describe what they do NOT do).
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the exports point at built files, and the package has no runtime dependency', () => {
  for (const [entry, target] of Object.entries(manifest.exports)) {
    assert.ok(
      existsSync(new URL(`.${target.default.slice(1)}`, new URL('../', import.meta.url))),
      entry,
    )
    assert.ok(
      existsSync(new URL(`.${target.types.slice(1)}`, new URL('../', import.meta.url))),
      entry,
    )
  }
  assert.deepEqual(manifest.dependencies ?? {}, {})
})

test('every built file imports only files of the package (no node:*, no dependency)', () => {
  const files = readdirSync(dist).filter((f) => f.endsWith('.js'))
  assert.ok(files.length >= 10, 'built')
  for (const file of files) {
    const text = code(file)
    for (const s of specifiers(text)) {
      assert.match(s, /^\.\/[a-z-]+\.js$/, `${file} imports ${s}`)
      assert.ok(files.includes(s.slice(2)), `${file} imports ${s}, which is built`)
    }
    assert.doesNotMatch(withoutComments(text), /\bnode:/, `${file} names no node: module`)
    assert.doesNotMatch(
      withoutComments(text),
      /\b(process|Buffer|require)\b/,
      `${file}: Node globals`,
    )
  }
})

test('./workflow: the session logic, none of the HTTP API, no clock, randomness or I/O', () => {
  const closure = new Set<string>()
  const visit = (file: string): void => {
    if (closure.has(file)) return
    closure.add(file)
    for (const s of specifiers(code(file))) visit(s.slice(2))
  }
  visit('workflow.js')
  assert.deepEqual([...closure].sort(), [
    'answers.js',
    'child-state.js',
    'pipeline-state.js',
    'session-ids.js',
    'session-state.js',
    'session-types.js',
    'workflow.js',
  ])
  for (const file of closure) {
    assert.doesNotMatch(
      withoutComments(code(file)),
      /\b(Date|Math\.random|crypto|setTimeout|setInterval|fetch|console|globalThis|Request|Response)\b/,
      `${file} is deterministic and does no I/O`,
    )
  }
})
