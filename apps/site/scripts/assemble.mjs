// The site is one directory as it is served: the Astro build, the demo under /demo/ and the
// pipeline editor under /pipeline/. Both are built by apps/demo (nx runs it first: `demo` is a
// dependency of this project) - one Vite project with two pages, so the pipeline page's scripts
// and styles are among the demo's, under /demo/assets/ (which is what `_headers` caches).
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const built = resolve(here, '../../demo/dist')
const dist = resolve(here, '../dist')
const SITE = 'https://agent.dudko.dev'

// [directory of apps/demo/dist, where it goes in the site, what it is]
const PARTS = [
  ['demo', 'demo', 'the demo'],
  ['pipeline', 'pipeline', 'the pipeline editor'],
]

for (const [from, to, what] of PARTS) {
  const source = resolve(built, from)
  if (!existsSync(resolve(source, 'index.html'))) {
    throw new Error(
      `${what} is not built (${source}/index.html is missing): run \`pnpm nx build demo\` first`,
    )
  }
  const target = resolve(dist, to)
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
}

// The page's assets must be where its HTML says they are.
const page = readFileSync(resolve(dist, 'pipeline/index.html'), 'utf8')
for (const [, url] of page.matchAll(/(?:src|href)="(\/demo\/[^"]+)"/g)) {
  if (!existsSync(resolve(dist, `.${url}`))) {
    throw new Error(`the pipeline page names ${url}, which is not in the site`)
  }
}

// The sitemap is written by Astro from its own pages. The demo and the pipeline editor are pages
// of the site that Astro did not build: add them. (A file for crawlers; nothing in the interface
// links to it.)
const sitemap = resolve(dist, 'sitemap-0.xml')
if (!existsSync(sitemap)) throw new Error('sitemap-0.xml is missing from the Astro build')
let xml = readFileSync(sitemap, 'utf8')
if (!xml.includes('</urlset>')) throw new Error('sitemap-0.xml has no </urlset> to add a page to')
for (const path of ['/demo/', '/pipeline/']) {
  const loc = `<url><loc>${SITE}${path}</loc></url>`
  if (!xml.includes(loc)) xml = xml.replace('</urlset>', `${loc}</urlset>`)
}
writeFileSync(sitemap, xml)

console.log('assembled: the demo is under dist/demo/, the pipeline editor under dist/pipeline/')
