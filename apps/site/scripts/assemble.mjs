// The site is one directory as it is served: the Astro build plus the demo under /demo/.
// The demo is built by apps/demo (nx runs it first: `demo` is a dependency of this project).
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const demo = resolve(here, '../../demo/dist/demo')
const target = resolve(here, '../dist/demo')

if (!existsSync(resolve(demo, 'index.html'))) {
  throw new Error(
    `the demo is not built (${demo}/index.html is missing): run \`pnpm nx build demo\` first`,
  )
}
rmSync(target, { recursive: true, force: true })
cpSync(demo, target, { recursive: true })
console.log('assembled: the demo is under dist/demo/')
