import { defineConfig } from 'tsup'

// Size policy:
//   - sourcemap: false   -> drops ~290 KB of unpacked weight from the tarball.
//                           Stack traces from dist/ point at minified bundle
//                           positions; consumers rarely debug into our code,
//                           and dev builds can re-enable it locally.
//   - minify:  true      -> ~50% smaller code bundles.
//   - keepNames: true    -> minifier preserves function/class names so error
//                           stacks still show meaningful symbols.
const shared = {
  sourcemap: false,
  minify: true,
  keepNames: true,
  clean: true,
  target: 'node22',
  outDir: 'dist',
  treeshake: true,
  splitting: false,
} as const

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    // The types of `./pipeline-engine` too: its JS is built below, but its d.ts must come from
    // THIS build - the d.ts build of a block with `clean` deletes every d.ts in dist when it
    // starts, the ones another block has already written included.
    dts: { entry: { index: 'src/index.ts', 'pipeline-engine': 'src/pipeline-engine.ts' } },
    // The subagent tool resolves its worker entry with
    // `new URL('./subagent-worker.js', import.meta.url)`; the shim gives the
    // CJS build a real import.meta.url (pathToFileURL(__filename)).
    shims: true,
  },
  {
    ...shared,
    // Worker-thread entry of createSubagentTool({ isolation: 'worker' }).
    // ESM only (package "type": "module"); every build of the library -
    // ESM, CJS and the CLI bundle - resolves it next to itself in dist/.
    clean: false,
    entry: { 'subagent-worker': 'src/subagent-worker.ts' },
    format: ['esm'],
  },
  {
    ...shared,
    // Worker-thread entry of the sandbox (config.sandbox / run_js): the only file that imports
    // the optional peer quickjs-emscripten (left external). Resolved next to the library, like
    // the subagent worker.
    clean: false,
    entry: { 'sandbox-worker': 'src/sandbox-worker.ts' },
    format: ['esm'],
    external: ['quickjs-emscripten'],
  },
  {
    ...shared,
    // `@dudko.dev/agent/pipeline-engine`: the pipeline engine alone - a file with no imports, for
    // an orchestrator that cannot load the agent (a workflow sandbox). A build of its own, so no
    // chunk is shared with the main entry (`splitting: false` too);
    // tests/pipeline-determinism.test.ts checks the built files import nothing. Its d.ts is the
    // main block's (see there).
    clean: false,
    entry: { 'pipeline-engine': 'src/pipeline-engine.ts' },
    format: ['esm', 'cjs'],
  },
  {
    ...shared,
    // CLI is bundled standalone (it duplicates the library code) so the
    // installed `dd-agent` bin doesn't depend on dist/index.js layout.
    clean: false,
    entry: { cli: 'src/cli/start.ts' },
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
  },
])
