// The image's prune step on a pnpm layout in miniature: the bundler and what only it reaches go,
// anything the app reaches without it stays; the core bridge keeps this platform's binary only.
import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { BUNDLER_ONLY, bridgeTarget, pruneImage } from '../scripts/prune-image.ts'

const write = (path: string, text = 'x'): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const link = (from: string, to: string): void => {
  mkdirSync(dirname(from), { recursive: true })
  symlinkSync(relative(dirname(from), to), from)
}

test('bridgeTarget: the core bridge directory per platform', () => {
  assert.equal(bridgeTarget('x64', 'linux'), 'x86_64-unknown-linux-gnu')
  assert.equal(bridgeTarget('arm64', 'linux'), 'aarch64-unknown-linux-gnu')
  assert.throws(() => bridgeTarget('ia32', 'linux'), /no Temporal core bridge/)
  assert.ok(BUNDLER_ONLY.has('webpack') && BUNDLER_ONLY.has('@swc/core'))
})

test('pruneImage: the bundler-only packages go, shared ones stay, one bridge binary', () => {
  const out = mkdtempSync(join(tmpdir(), 'prune-'))
  try {
    const nm = join(out, 'node_modules')
    const pkg = (id: string, name: string) => join(nm, '.pnpm', id, 'node_modules', name)
    // The app -> a, which needs `shared` and the core bridge, and (lazily) webpack.
    for (const [id, name] of [
      ['a@1', 'a'],
      ['shared@1', 'shared'],
      ['webpack@5', 'webpack'],
      ['only-webpack@1', 'only-webpack'],
      ['@swc+core@1', '@swc/core'],
      ['@temporalio+core-bridge@1', '@temporalio/core-bridge'],
    ] as const) {
      write(join(pkg(id, name), 'index.js'))
    }
    write(join(pkg('a@1', 'a'), 'index.d.ts'))
    write(join(pkg('a@1', 'a'), 'index.js.map'))
    const bridge = pkg('@temporalio+core-bridge@1', '@temporalio/core-bridge')
    for (const target of [bridgeTarget(), 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc']) {
      write(join(bridge, 'releases', target, 'index.node'))
    }
    write(join(bridge, 'sdk-core', 'Cargo.toml'))
    link(join(nm, 'a'), pkg('a@1', 'a'))
    link(join(nm, '.pnpm', 'a@1', 'node_modules', 'shared'), pkg('shared@1', 'shared'))
    link(join(nm, '.pnpm', 'a@1', 'node_modules', 'webpack'), pkg('webpack@5', 'webpack'))
    link(join(nm, '.pnpm', 'a@1', 'node_modules', '@temporalio', 'core-bridge'), bridge)
    link(join(nm, '.pnpm', 'webpack@5', 'node_modules', 'shared'), pkg('shared@1', 'shared'))
    link(
      join(nm, '.pnpm', 'webpack@5', 'node_modules', 'only-webpack'),
      pkg('only-webpack@1', 'only-webpack'),
    )
    link(
      join(nm, '.pnpm', 'webpack@5', 'node_modules', '@swc', 'core'),
      pkg('@swc+core@1', '@swc/core'),
    )

    const saved = pruneImage(out)
    assert.ok(saved > 0)
    const store = (id: string) => existsSync(join(nm, '.pnpm', id))
    assert.deepEqual(
      ['a@1', 'shared@1', '@temporalio+core-bridge@1'].map(store),
      [true, true, true],
      'what the app reaches stays',
    )
    assert.deepEqual(
      ['webpack@5', 'only-webpack@1', '@swc+core@1'].map(store),
      [false, false, false],
      'what only the bundler reaches goes',
    )
    assert.equal(
      existsSync(join(nm, '.pnpm', 'a@1', 'node_modules', 'webpack')),
      false,
      'no link left pointing at nothing',
    )
    assert.ok(lstatSync(join(nm, '.pnpm', 'a@1', 'node_modules', 'shared')).isSymbolicLink())
    assert.ok(existsSync(join(bridge, 'releases', bridgeTarget(), 'index.node')))
    assert.equal(existsSync(join(bridge, 'releases', 'x86_64-apple-darwin')), false)
    assert.equal(existsSync(join(bridge, 'sdk-core')), false)
    assert.equal(existsSync(join(pkg('a@1', 'a'), 'index.d.ts')), false)
    assert.equal(existsSync(join(pkg('a@1', 'a'), 'index.js.map')), false)
    assert.ok(existsSync(join(pkg('a@1', 'a'), 'index.js')))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('pruneImage: a core bridge without this platform binary is an error, not a broken image', () => {
  const out = mkdtempSync(join(tmpdir(), 'prune-'))
  try {
    const bridge = join(
      out,
      'node_modules',
      '.pnpm',
      '@temporalio+core-bridge@1',
      'node_modules',
      '@temporalio',
      'core-bridge',
    )
    write(join(bridge, 'releases', 'x86_64-apple-darwin', 'index.node'))
    link(join(out, 'node_modules', '@temporalio', 'core-bridge'), bridge)
    assert.throws(() => pruneImage(out), /has no binary for/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
