import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { mcpAppSandboxResponse } from '@dudko.dev/agent-web-react/mcp-app-sandbox'
import { demoMcpMiddleware, sendWebResponse, toWebRequest } from 'worker/node'

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

// The pipeline editor is a second page of this project (pipeline/index.html): it shares the
// demo's source, and therefore its chunks - React, the agent core, the providers and the runtimes
// are downloaded once for both pages, from /demo/assets/. But it is SERVED at /pipeline/, at the
// site's root, not under the demo's base. So after the build its HTML is moved from
// dist/demo/pipeline/ to dist/pipeline/ (`dist` stays "the whole site as it is served"; the HTML
// names its scripts and styles by absolute /demo/assets/ URLs, so it works from anywhere on the
// origin), and the dev and preview servers answer /pipeline/ with it.
const PIPELINE_PATH = '/pipeline/'
const pipelinePage = (): Plugin => {
  const answers = (url: string | undefined) => {
    const path = (url ?? '').split(/[?#]/)[0]
    return path === PIPELINE_PATH || path === '/pipeline' || path === '/pipeline/index.html'
  }
  return {
    name: 'demo-pipeline-page',
    closeBundle() {
      if (base === '/' || this.meta.watchMode) return
      const built = at(`dist${base}pipeline/index.html`)
      if (!existsSync(built)) return
      mkdirSync(at('dist/pipeline'), { recursive: true })
      renameSync(built, at('dist/pipeline/index.html'))
      rmSync(at(`dist${base}pipeline`), { recursive: true, force: true })
    },
    // `vite dev`: the page's source is pipeline/index.html under the base.
    configureServer(server) {
      if (base === '/') return
      server.middlewares.use((req, _res, next) => {
        if (answers(req.url)) {
          req.url = `${base}pipeline/index.html${(req.url ?? '').replace(/^[^?#]*/, '')}`
        }
        next()
      })
    },
    // `vite preview` serves dist/demo under the base; the page was moved out of it.
    configurePreviewServer(server) {
      if (base === '/') return
      server.middlewares.use((req, res, next) => {
        if (!answers(req.url)) return next()
        if ((req.url ?? '').split(/[?#]/)[0] === '/pipeline') {
          res.statusCode = 301
          res.setHeader('Location', PIPELINE_PATH)
          res.end()
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(readFileSync(at('dist/pipeline/index.html')))
      })
    },
  }
}

// The demo MCP server ("Try the demo server" on the MCP tab) is served at /mcp/demo of the site
// by a Cloudflare Worker (apps/worker). There is no Worker behind `vite dev` and `vite preview`,
// so both serve that path with the same code on Node - the browser tests run against it too.
const demoMcpServer = (): Plugin => ({
  name: 'demo-mcp-server',
  configureServer(server) {
    server.middlewares.use(demoMcpMiddleware())
  },
  configurePreviewServer(server) {
    server.middlewares.use(demoMcpMiddleware())
  },
})

// The MCP Apps sandbox page (src/app-sandbox.ts). On the site it is a Worker of its own on its own
// domain (apps/app-sandbox); here the dev and preview servers answer it - the same handler, from
// the React package's `./mcp-app-sandbox` entry - and only the OTHER loopback name may frame it: the
// page reached as localhost:PORT may frame only a page of 127.0.0.1:PORT, and the other way round.
// So a demo on 127.0.0.1 runs its apps on localhost (another origin, another site - cookies are per
// host, not per port), and nothing frames the sandbox from its own origin.
const APP_SANDBOX_PATH = '/sandbox/v1'
const OTHER_LOOPBACK: Record<string, string> = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' }
const appSandbox = (): Plugin => {
  const middleware = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    next: () => void,
  ) => {
    if (!(req.url ?? '').startsWith(`${APP_SANDBOX_PATH}/`)) return next()
    const [hostname, port] = (req.headers.host ?? '').split(':')
    const other = OTHER_LOOPBACK[hostname]
    if (!other) return next()
    const host = `http://${other}${port ? `:${port}` : ''}`
    void sendWebResponse(
      res,
      mcpAppSandboxResponse(toWebRequest(req), { path: APP_SANDBOX_PATH, hosts: [host] }),
    )
  }
  return {
    name: 'demo-app-sandbox',
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  }
}

// transformers.js loads the ONNX runtime's wasm from jsDelivr at run time (its default in a
// page), yet the bundler also emits a copy because onnxruntime-web references it by URL. That copy
// is never requested, and at 25.6 MiB it is over the 25 MiB a Cloudflare Workers asset may be -
// the deploy is refused. Leave it out of the bundle.
const dropOrtWasm = (): Plugin => ({
  name: 'demo-drop-ort-wasm',
  apply: 'build',
  generateBundle(_options, bundle) {
    for (const name of Object.keys(bundle)) {
      if (/(^|\/)ort-wasm[^/]*\.wasm$/.test(name)) delete bundle[name]
    }
  },
})

// Cloudflare refuses the whole deploy over one file; say which file here, at build time.
const MAX_ASSET_BYTES = 25 * 1024 * 1024
const assetSizeLimit = (): Plugin => ({
  name: 'demo-asset-size-limit',
  apply: 'build',
  closeBundle() {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
      )
    const tooBig = walk(at('dist')).filter((f) => statSync(f).size > MAX_ASSET_BYTES)
    if (tooBig.length) {
      throw new Error(
        `Assets over 25 MiB cannot be deployed to Cloudflare Workers: ${tooBig.join(', ')}`,
      )
    }
  },
})

export default defineConfig({
  base,
  build: {
    outDir: `dist${base}`.replace(/\/$/, ''),
    // Two pages, one build: the demo and the pipeline editor (see `pipelinePage`).
    rollupOptions: { input: { main: at('index.html'), pipeline: at('pipeline/index.html') } },
  },
  // `pipelinePage` before `assetSizeLimit`: the limit is checked on `dist` as it will be served.
  plugins: [
    react(),
    siteRoot(),
    dropOrtWasm(),
    pipelinePage(),
    assetSizeLimit(),
    demoMcpServer(),
    appSandbox(),
  ],
  resolve: {
    // The library's dist sits outside this app; force ONE copy of each (two Reacts break every hook).
    dedupe: ['react', 'react-dom', '@dudko.dev/agent-web', 'ai', 'zod'],
    alias: [
      {
        find: '@dudko.dev/agent-web-react/styles.css',
        replacement: at('../../packages/agent-web-react/dist/styles.css'),
      },
      {
        find: '@dudko.dev/agent-web-react/pipeline.css',
        replacement: at('../../packages/agent-web-react/dist/pipeline.css'),
      },
      {
        find: '@dudko.dev/agent-web-react/pipeline',
        replacement: at('../../packages/agent-web-react/dist/pipeline.js'),
      },
      // Before the bare name: a string alias also matches by prefix, so without this
      // `…/mcp` would resolve to `…/dist/index.js/mcp`.
      {
        find: '@dudko.dev/agent-web-react/mcp',
        replacement: at('../../packages/agent-web-react/dist/mcp.js'),
      },
      {
        find: '@dudko.dev/agent-web-react',
        replacement: at('../../packages/agent-web-react/dist/index.js'),
      },
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
      'quickjs-emscripten',
    ],
  },
})
