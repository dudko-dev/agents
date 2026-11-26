import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// The demo consumes the freshly built library from packages/agent-web-react/dist (nx builds it
// first: `pnpm nx build demo`). Aliasing to the
// real dist keeps the demo honest: it exercises the published artifact, not the
// TypeScript source.
// Served at https://agent.dudko.dev/demo/ (Cloudflare Workers static assets, see the root
// wrangler.jsonc); the site's root is reserved for the documentation site. Override with DEMO_BASE
// (`/` puts the demo at the root).
const base = (process.env.DEMO_BASE ?? '/demo/').replace(/\/*$/, '/')

// The build lands in dist<base> so that `dist` is the whole site as it is served: dist/demo/…
// plus, until the site has a page of its own, a redirect from the root to the demo.
const siteRoot = (): Plugin => ({
  name: 'demo-site-root',
  apply: 'build',
  buildStart() {
    rmSync(at('dist'), { recursive: true, force: true })
  },
  closeBundle() {
    if (base === '/') return
    mkdirSync(at('dist'), { recursive: true })
    writeFileSync(at('dist/_redirects'), `/ ${base} 302\n`)
  },
})

export default defineConfig({
  base,
  build: { outDir: `dist${base}`.replace(/\/$/, '') },
  plugins: [react(), siteRoot()],
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
