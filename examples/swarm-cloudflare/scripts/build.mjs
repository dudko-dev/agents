// `build`: the Worker's bundle, as `wrangler deploy` would upload it - and nothing is uploaded:
// `--dry-run` bundles locally and stops (checked to need no network at all: it runs in an empty
// network namespace). Output: dist/index.js (+ its source map). Metrics off, no update check.
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
rmSync(dist, { recursive: true, force: true })
const wrangler = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
)
const run = spawnSync(wrangler, ['deploy', '--dry-run', '--outdir', 'dist'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
  env: {
    ...process.env,
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG: 'warn',
    NO_UPDATE_NOTIFIER: '1',
  },
})
process.stdout.write(run.stdout ?? '')
const bundle = join(dist, 'index.js')
if (run.status !== 0 || !existsSync(bundle)) {
  console.error('build: wrangler did not produce dist/index.js')
  process.exit(1)
}
console.log(`build: dist/index.js ${(statSync(bundle).size / 1024).toFixed(1)} KiB`)
