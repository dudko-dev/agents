// The Worker's bundle: src/index.ts and the React package's `./mcp-app-sandbox` entry it imports,
// in one ES module, dist/index.js, which wrangler.jsonc names as `main`. Built the way wrangler
// builds a Worker (esbuild, platform `browser`, the conditions `workerd`, `worker`, `browser`).
// Fails on a `node:*` import (there is no `nodejs_compat`), on React or the agent core ending up
// in the bundle (the entry imports neither), and on a bundle that is not small.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'dist/index.js')

// It is a page and a handler: a few KiB. Anything near this is a dependency gone wrong.
const MAX_GZIP_BYTES = 32 * 1024

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser'],
  target: 'es2022',
  sourcemap: true,
  metafile: true,
  logLevel: 'warning',
})

const inputs = Object.keys(result.metafile.inputs)
const nodeImports = Object.values(result.metafile.inputs)
  .flatMap((input) => input.imports)
  .filter((imported) => imported.path.startsWith('node:'))
if (nodeImports.length > 0) {
  throw new Error(`the Worker imports ${nodeImports.map((i) => i.path).join(', ')}`)
}
const foreign = inputs.filter((p) =>
  /node_modules\/(?:react|react-dom|ai|zod)\/|agent-web\/dist/.test(p),
)
if (foreign.length > 0) throw new Error(`the Worker bundles ${foreign.join(', ')}`)
const code = readFileSync(outfile)
const gzipped = gzipSync(code).length
if (gzipped > MAX_GZIP_BYTES) {
  throw new Error(`dist/index.js is ${gzipped} bytes gzipped, over the ${MAX_GZIP_BYTES} allowed`)
}
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`
console.log(`built dist/index.js (${kib(code.length)}, ${kib(gzipped)} gzipped)`)
