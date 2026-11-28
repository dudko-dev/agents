// The image's last build step: drop from the production install (`pnpm deploy`) what the roles
// never load at run time. Run by the Dockerfile on its output directory, in the build stage of the
// target platform; no import of the project, Node built-ins only.
//
//   - the workflow BUNDLER: webpack, swc, their loaders and the in-memory file system the SDK
//     bundles with. The image ships the bundle (`build`, dist/workflow-bundle.js), so a worker
//     never bundles; the SDK imports the bundler lazily, only when it has to bundle.
//   - Temporal's core bridge: the prebuilt binaries of every other platform, and its Rust sources.
//   - type declarations and source maps (never read at run time).
//
// A package is removed only when nothing else of the install reaches it: everything reachable
// from the app's own dependencies without going through the bundler stays.
//
//   node --experimental-strip-types scripts/prune-image.ts /out
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { join, resolve } from 'node:path'

// Imported only to bundle workflow code (@temporalio/worker's workflow/bundler.js).
export const BUNDLER_ONLY = new Set([
  'webpack',
  '@swc/core',
  'swc-loader',
  'source-map-loader',
  'memfs',
  'unionfs',
])

// The core bridge's binary directory for this platform (its own common.js names them so).
export const bridgeTarget = (a: string = arch(), p: string = platform()): string => {
  const archs: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' }
  const platforms: Record<string, string> = { linux: 'unknown-linux-gnu', darwin: 'apple-darwin' }
  if (!archs[a] || !platforms[p]) {
    throw new Error(`no Temporal core bridge for ${p}/${a}`)
  }
  return `${archs[a]}-${platforms[p]}`
}

const DROPPED_FILES = /\.(d\.ts|d\.mts|d\.cts|map)$/

const sizeOf = (path: string): number => {
  const s = lstatSync(path)
  if (s.isSymbolicLink()) return 0
  if (!s.isDirectory()) return s.size
  return readdirSync(path).reduce((n, e) => n + sizeOf(join(path, e)), 0)
}

// The packages a node_modules directory links to: `name` and `@scope/name` entries.
const entries = (dir: string): { name: string; path: string }[] => {
  if (!existsSync(dir)) return []
  const out: { name: string; path: string }[] = []
  for (const e of readdirSync(dir)) {
    if (e === '.pnpm' || e === '.bin' || e.startsWith('.')) continue
    if (e.startsWith('@')) {
      for (const s of readdirSync(join(dir, e)))
        out.push({ name: `${e}/${s}`, path: join(dir, e, s) })
    } else {
      out.push({ name: e, path: join(dir, e) })
    }
  }
  return out
}

// `<out>/node_modules/.pnpm/<id>/node_modules/<name>` -> `<id>`.
const storeIdOf = (store: string, real: string): string | undefined => {
  const rel = real.startsWith(store + '/') ? real.slice(store.length + 1) : undefined
  return rel?.split('/')[0]
}

export const pruneImage = (out: string, log: (line: string) => void = () => {}): number => {
  const root = resolve(out)
  const modules = join(root, 'node_modules')
  const store = join(modules, '.pnpm')
  const before = sizeOf(root)

  // What the app reaches without the bundler.
  const reached = new Set<string>()
  const queue: string[] = []
  const visit = (link: string, name: string): void => {
    if (BUNDLER_ONLY.has(name) || !existsSync(link)) return
    const id = storeIdOf(store, realpathSync(link))
    if (id && !reached.has(id)) {
      reached.add(id)
      queue.push(id)
    }
  }
  for (const e of entries(modules)) visit(e.path, e.name)
  while (queue.length) {
    const id = queue.shift()!
    for (const e of entries(join(store, id, 'node_modules'))) visit(e.path, e.name)
  }
  for (const id of readdirSync(store)) {
    if (id === 'node_modules' || id.startsWith('.') || reached.has(id)) continue
    if (!statSync(join(store, id)).isDirectory()) continue
    log(`[prune] ${id}`)
    rmSync(join(store, id), { recursive: true, force: true })
  }

  // The core bridge: this platform's binary only, no sources.
  const target = bridgeTarget()
  for (const id of readdirSync(store).filter((d) => d.startsWith('@temporalio+core-bridge@'))) {
    const bridge = join(store, id, 'node_modules', '@temporalio', 'core-bridge')
    if (!existsSync(join(bridge, 'releases', target, 'index.node'))) {
      throw new Error(`the core bridge has no binary for ${target}: ${bridge}`)
    }
    for (const r of readdirSync(join(bridge, 'releases'))) {
      if (r !== target) rmSync(join(bridge, 'releases', r), { recursive: true, force: true })
    }
    for (const dir of [
      'sdk-core',
      'src',
      'bridge-macros',
      'scripts',
      'ts',
      'Cargo.toml',
      'Cargo.lock',
    ]) {
      rmSync(join(bridge, dir), { recursive: true, force: true })
    }
  }

  // Declarations and source maps; then the links left pointing at nothing.
  const sweep = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const path = join(dir, e)
      const s = lstatSync(path)
      if (s.isSymbolicLink()) {
        if (!existsSync(path)) rmSync(path, { force: true })
      } else if (s.isDirectory()) {
        sweep(path)
      } else if (DROPPED_FILES.test(e)) {
        rmSync(path, { force: true })
      }
    }
  }
  sweep(modules)

  const after = sizeOf(root)
  log(`[prune] ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`)
  return before - after
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2]
  if (!out) {
    process.stderr.write('usage: prune-image.ts <deploy dir>\n')
    process.exit(2)
  }
  pruneImage(out, (line) => process.stdout.write(`${line}\n`))
}
