// The Worker's bundle: src/index.ts and everything it imports in one ES module, dist/index.js,
// which the root wrangler.jsonc names as `main`. Built the way wrangler builds a Worker (esbuild,
// platform `browser`, the conditions `workerd`, `worker`, `browser`), so the SDK resolves to its
// workerd entry here exactly as it will on Cloudflare - and a `node:*` import, which a Worker
// without `nodejs_compat` cannot load, fails this build instead of the deploy. wrangler bundles
// the file again when it deploys; there is nothing left for it to resolve.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'dist/index.js')

// A Worker on the free plan may be 3 MiB after compression (gzip); this one is about 0.2 MiB,
// most of it zod. A bundle that grows past this is a dependency gone wrong: said here, not at
// the deploy.
const MAX_GZIP_BYTES = 1024 * 1024

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser'],
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
  metafile: true,
  logLevel: 'warning',
})

const nodeImports = Object.values(result.metafile.inputs)
  .flatMap((input) => input.imports)
  .filter((imported) => imported.path.startsWith('node:'))
if (nodeImports.length > 0) {
  throw new Error(`the Worker imports ${nodeImports.map((i) => i.path).join(', ')}`)
}
const code = readFileSync(outfile)
const gzipped = gzipSync(code).length
if (gzipped > MAX_GZIP_BYTES) {
  throw new Error(`dist/index.js is ${gzipped} bytes gzipped, over the ${MAX_GZIP_BYTES} allowed`)
}
const kib = (bytes) => `${Math.round(bytes / 1024)} KiB`
console.log(`built dist/index.js (${kib(code.length)}, ${kib(gzipped)} gzipped)`)
