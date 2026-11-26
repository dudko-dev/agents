import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// The demo consumes the freshly built library from packages/agent-web-react/dist (nx builds it
// first: `pnpm nx build demo`). Aliasing to the
// real dist keeps the demo honest: it exercises the published artifact, not the
// TypeScript source.
export default defineConfig({
  // Served at https://<user>.github.io/agent-web-react/ on GitHub Pages.
  base: process.env.DEMO_BASE ?? '/agent-web-react/',
  plugins: [react()],
  resolve: {
    // The library's dist sits outside this app; force ONE copy of each (two Reacts break every hook).
    dedupe: ['react', 'react-dom', '@dudko.dev/agent-web', 'ai', 'zod'],
    alias: [
      { find: '@dudko.dev/agent-web-react/styles.css', replacement: at('../../packages/agent-web-react/dist/styles.css') },
      // Before the bare name: a string alias also matches by prefix, so without this
      // `…/mcp` would resolve to `…/dist/index.js/mcp`.
      { find: '@dudko.dev/agent-web-react/mcp', replacement: at('../../packages/agent-web-react/dist/mcp.js') },
      { find: '@dudko.dev/agent-web-react', replacement: at('../../packages/agent-web-react/dist/index.js') },
    ],
  },
  // The chess analysts run as module Web Workers (`new Worker(new URL(…), {
  // type: 'module' })`) that import the agent core — they need ES output.
  worker: { format: 'es' },
  // WebLLM, transformers.js (onnxruntime-web) and the PDF converter ship their
  // own wasm (found next to their JS via `new URL(…, import.meta.url)`) and
  // must not be pre-bundled.
  optimizeDeps: {
    exclude: [
      '@browser-ai/web-llm',
      '@mlc-ai/web-llm',
      '@browser-ai/transformers-js',
      '@huggingface/transformers',
      '@dudko.dev/pdf-to-md-core',
    ],
  },
})
