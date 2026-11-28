import { defineConfig } from 'tsup'

// The optional provider peers: never bundled, imported dynamically at runtime
// so consumers install / map only what they use.
const OPTIONAL_PEERS = [
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/openai-compatible',
  '@ai-sdk/xai',
  '@ai-sdk/deepseek',
  '@browser-ai/web-llm',
  '@browser-ai/core',
  '@mlc-ai/web-llm',
  '@modelcontextprotocol/client',
  'quickjs-emscripten',
]

// The entry points of the main build:
//   .        → the core agent (no MCP, no node:* — safe for any browser bundle)
//   ./mcp    → the optional HTTP MCP connector, kept separate so
//              @modelcontextprotocol/client never enters the core bundle.
//   ./webmcp → the optional bridge to the browser's WebMCP API (a page's tools
//              published from / consumed as an agent ToolSet); no extra dependency.
// All model providers, WebLLM, and the MCP SDK are external optional peers —
// consumers install only what they use; we import them dynamically at runtime.
const ENTRIES = {
  index: 'src/index.ts',
  mcp: 'src/mcp/index.ts',
  webmcp: 'src/webmcp/index.ts',
  // The Web Worker side of `config.sandbox` (run_js): the only entry that imports the
  // optional peer quickjs-emscripten by name, so a host bundles the engine into its worker.
  'sandbox-worker': 'src/sandbox/worker.ts',
}
// ./pipeline-engine → the pipeline engine alone: one file with no imports, for an orchestrator
// that cannot load the agent (a workflow sandbox).
const PIPELINE_ENGINE = { 'pipeline-engine': 'src/pipeline/engine.ts' }

export default defineConfig([
  {
    entry: ENTRIES,
    format: ['esm', 'cjs'],
    // The types of ./pipeline-engine too: its JS is built below, but its d.ts must come from
    // THIS build - the d.ts build of a block with `clean` deletes every d.ts in dist when it
    // starts, the ones another block has already written included.
    dts: { entry: { ...ENTRIES, ...PIPELINE_ENGINE } },
    sourcemap: true,
    clean: true,
    target: 'es2022',
    external: ['ai', 'zod', 'idb', ...OPTIONAL_PEERS],
  },
  // The JS of ./pipeline-engine: a build of its own with `splitting: false`, because in the
  // block above the engine would land in a chunk shared with the core, and the entry would
  // import it. tests/pipeline-determinism.test.ts checks the built files import nothing.
  {
    entry: PIPELINE_ENGINE,
    format: ['esm', 'cjs'],
    sourcemap: true,
    clean: false, // runs after the main config; must not wipe its output
    splitting: false,
    target: 'es2022',
  },
  // Standalone browser bundle (dist/agent-web.js) — the core with `ai`, `zod`
  // and `idb` bundled in, ready for a <script type="module"> tag, a CDN
  // (jsDelivr / unpkg), or a GitHub-release download. Optional provider peers
  // stay external: in a bundler-less page they resolve through an import map.
  {
    entry: { 'agent-web': 'src/index.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: true,
    dts: false,
    clean: false, // runs after the main config; must not wipe its output
    splitting: false, // ONE self-contained file, no chunk siblings
    noExternal: ['ai', 'zod', 'idb'],
    external: OPTIONAL_PEERS,
  },
])
