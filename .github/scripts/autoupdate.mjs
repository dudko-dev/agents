// Weekly dependency update for the workspace. Run from the repo root:
//
//   node .github/scripts/autoupdate.mjs            update, bump, write changelogs
//   node .github/scripts/autoupdate.mjs --dry-run  the same, but print what would be bumped
//
// 1. `pnpm update -r --latest` for everything except IGNORE (updates known to break the build).
// 2. A published package gets a patch bump and a CHANGELOG entry only when its own `dependencies`
//    changed: that is what its users install. A dev-only or lockfile-only change ships nothing
//    new, so it is committed without a release.
// Prints GitHub Actions outputs: updated=true|false, bumped=<comma list>, title=<PR title part>.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

const IGNORE = ['typescript', '@types/node']
const DRY = process.argv.includes('--dry-run')
const root = new URL('../../', import.meta.url)

const manifests = () =>
  ['packages', 'apps'].flatMap((group) =>
    readdirSync(new URL(`${group}/`, root), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(new URL(`${group}/${e.name}/package.json`, root)))
      .map((e) => `${group}/${e.name}`),
  )

const read = (dir) => JSON.parse(readFileSync(new URL(`${dir}/package.json`, root), 'utf8'))

/** Names whose range differs between two dependency maps (added, removed or changed). */
export const changedDeps = (before = {}, after = {}) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => before[name] !== after[name])
    .sort()

/** 0.0.9 -> 0.0.10. Only plain x.y.z versions: anything else is a release someone is steering. */
export const bumpPatch = (version) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`cannot bump a non-plain version: ${version}`)
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

/** The entry the old per-repository autoupdater wrote, so the changelogs read as one history. */
export const changelogEntry = (version, date, names) =>
  `# ${version} / ${date}\n\n### :tada: Enhancements\n- Updated dependencies: ${names.join(', ')}\n\n`

const main = () => {
  const dirs = manifests()
  const before = Object.fromEntries(dirs.map((d) => [d, read(d)]))

  execFileSync('pnpm', ['update', '-r', '--latest', ...IGNORE.map((name) => `!${name}`)], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  const today = new Date().toISOString().slice(0, 10)
  const bumped = []
  let anyManifestChanged = false
  for (const dir of dirs) {
    const was = before[dir]
    const now = read(dir)
    if (JSON.stringify(was) !== JSON.stringify(now)) anyManifestChanged = true
    if (now.private || !dir.startsWith('packages/')) continue
    const names = changedDeps(was.dependencies, now.dependencies)
    if (!names.length) continue
    const version = bumpPatch(now.version)
    bumped.push(`${now.name}@${version}`)
    if (DRY) continue
    const file = new URL(`${dir}/package.json`, root)
    // Replace the first "version" line only, keeping the file's formatting byte for byte.
    const text = readFileSync(file, 'utf8')
    const next = text.replace(/^(\s*"version":\s*)"[^"]+"/m, `$1"${version}"`)
    if (next === text) throw new Error(`no version line in ${dir}/package.json`)
    writeFileSync(file, next)
    const log = new URL(`${dir}/CHANGELOG.md`, root)
    const old = existsSync(log) ? readFileSync(log, 'utf8') : ''
    writeFileSync(log, changelogEntry(version, today, names) + old)
  }

  const lockChanged =
    execFileSync('git', ['status', '--porcelain', 'pnpm-lock.yaml'], { cwd: root, encoding: 'utf8' })
      .trim().length > 0
  console.log(`updated=${anyManifestChanged || lockChanged}`)
  console.log(`bumped=${bumped.join(',')}`)
  console.log(`title=${bumped.length ? bumped.map((b) => b.replace('@dudko.dev/', '')).join(', ') : 'dev dependencies'}`)
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) main()
