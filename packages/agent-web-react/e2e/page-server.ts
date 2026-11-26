import { build } from 'esbuild'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

/**
 * Bundle a test-only page from `e2e/fixtures/` and serve it on loopback.
 *
 * For a browser test of something the demo has no screen for. The alternative was a hidden route
 * in the demo, which would have shipped test code (and a form for client secrets) to the deployed
 * site; this way the page exists only while its test runs. The bundle is made from the packages'
 * built `dist` (nx builds them before `test:e2e`), so what runs is the published artifact.
 *
 * Loopback over http is a secure context, so WebCrypto and the IndexedDB vault work as on https.
 */

export interface IPageServer {
  /** The page's origin: what the test servers must allow with CORS. */
  origin: string
  url: string
  close: () => Promise<void>
}

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="robots" content="noindex" />
    <title>test fixture</title>
  </head>
  <body>
    <main>
      <p id="status">loading</p>
      <ul id="tools"></ul>
      <pre id="result"></pre>
      <p id="error-kind"></p>
      <p id="error-hop"></p>
      <p id="error-code"></p>
      <pre id="error"></pre>
      <ul id="log"></ul>
    </main>
    <script type="module" src="./page.js"></script>
  </body>
</html>
`

/** `fixture` is a file name in `e2e/fixtures/`, e.g. `enterprise-page.ts`. */
export const startPageServer = async (fixture: string): Promise<IPageServer> => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  })
  const script = bundle.outputFiles[0].text

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split(/[?#]/)[0]
    const send = (type: string, body: string): void => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    if (path === '/') send('text/html; charset=utf-8', HTML)
    else if (path === '/page.js') send('text/javascript; charset=utf-8', script)
    else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    origin,
    url: `${origin}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
