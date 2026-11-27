import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  isMcpAppSandboxHost,
  mcpAppPolicy,
  mcpAppPolicyToken,
  parseMcpAppSandboxHosts,
} from '@dudko.dev/agent-web-react/mcp-app-sandbox'
import { handleRequest, SANDBOX_PATH, type Env } from '../src/index.ts'

// The sandbox Worker as Cloudflare runs it: its own wrangler.jsonc (one Custom Domain, no
// workers.dev, the allowed hosts), the site's build and config untouched by it, and the handler
// - on the source and on the bundle `main` names.

const here = dirname(fileURLToPath(import.meta.url))
const project = resolve(here, '..')
const repo = resolve(project, '../..')

/** JSON with comments, as wrangler reads it: `//` and block comments outside strings. */
const parseJsonc = (source: string): any => {
  let out = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y
      end.lastIndex = i
      const match = end.exec(source)
      assert.ok(match, `unterminated string at ${i}`)
      out += match[0]
      i += match[0].length - 1
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      out += '\n'
    } else if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1
    } else {
      out += ch
    }
  }
  return JSON.parse(out)
}

const config = parseJsonc(readFileSync(resolve(project, 'wrangler.jsonc'), 'utf8'))
const HOSTS = 'https://agent.dudko.dev https://*-agents.dudko.workers.dev'

test('wrangler.jsonc: its own Worker on workers.dev only (never under dudko.dev), the site and its previews as hosts', () => {
  assert.equal(config.name, 'agent-demo-apps')
  assert.equal(config.main, './dist/index.js')
  // workers.dev is a public suffix: a cookie an app sets there cannot reach dudko.dev. A route or
  // a Custom Domain under dudko.dev would let any app set cookies for every dudko.dev host.
  assert.equal(config.workers_dev, true)
  assert.equal(config.preview_urls, false)
  assert.equal(config.routes, undefined)
  assert.equal(config.route, undefined)
  assert.deepEqual(config.vars, { ALLOWED_HOST_ORIGINS: HOSTS })
  // A script and nothing else: no assets, no binding, no secret, no compatibility layer.
  for (const key of [
    'assets',
    'kv_namespaces',
    'd1_databases',
    'r2_buckets',
    'durable_objects',
    'services',
    'compatibility_flags',
    'observability',
  ]) {
    assert.equal(config[key], undefined, key)
  }
  assert.deepEqual(config.previews, {})
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/)
  const hosts = parseMcpAppSandboxHosts(config.vars.ALLOWED_HOST_ORIGINS)
  assert.deepEqual(hosts.invalid, [])
  assert.deepEqual(hosts.frameAncestors, ['https://agent.dudko.dev', 'https://*.dudko.workers.dev'])
  for (const origin of [
    'https://agent.dudko.dev',
    'https://0a1b2c3d-agents.dudko.workers.dev',
    'https://my-branch-agents.dudko.workers.dev',
  ]) {
    assert.equal(isMcpAppSandboxHost(hosts, origin), true, origin)
  }
  for (const origin of [
    'https://agent-demo-apps.dudko.workers.dev',
    'https://agents.dudko.workers.dev',
    'https://other.dudko.workers.dev',
    'https://x.y-agents.dudko.workers.dev',
    'https://dudko.dev',
    'http://agent.dudko.dev',
  ]) {
    assert.equal(isMcpAppSandboxHost(hosts, origin), false, origin)
  }
})

test('the site does not build or deploy this Worker', () => {
  const site = JSON.parse(readFileSync(resolve(repo, 'apps/site/package.json'), 'utf8'))
  const demo = JSON.parse(readFileSync(resolve(repo, 'apps/demo/package.json'), 'utf8'))
  for (const pkg of [site, demo]) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    assert.equal(deps['app-sandbox'], undefined, `${pkg.name} does not depend on app-sandbox`)
  }
  const root = readFileSync(resolve(repo, 'wrangler.jsonc'), 'utf8')
  assert.doesNotMatch(root, /app-sandbox|agent-demo-apps/)
  assert.equal(parseJsonc(root).main, './apps/worker/dist/index.js')
})

const PAGE_POLICY = { connect: ['https://api.example.com'], resources: [] }
const TOKEN = mcpAppPolicyToken(PAGE_POLICY) as string
const env: Env = { ALLOWED_HOST_ORIGINS: HOSTS }
const at = (path: string, init?: RequestInit) =>
  new Request(`https://agent-demo-apps.dudko.workers.dev${path}`, init)

type Handler = (request: Request, env: Env) => Response | Promise<Response>

const serves = async (fetch: Handler): Promise<void> => {
  const page = await fetch(at(`${SANDBOX_PATH}/${TOKEN}`), env)
  assert.equal(page.status, 200)
  assert.equal(
    page.headers.get('content-security-policy'),
    `${mcpAppPolicy(PAGE_POLICY)}; frame-ancestors https://agent.dudko.dev https://*.dudko.workers.dev`,
  )
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.equal(page.headers.get('strict-transport-security'), 'max-age=31536000')
  assert.match(await page.text(), /<title>MCP App sandbox<\/title>/)
  const head = await fetch(at(`${SANDBOX_PATH}/${TOKEN}`, { method: 'HEAD' }), env)
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  // Only GET / HEAD.
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await fetch(at(`${SANDBOX_PATH}/${TOKEN}`, { method }), env)
    assert.equal(res.status, 405, method)
    assert.equal(res.headers.get('allow'), 'GET, HEAD')
  }
  // Nothing else, and nothing to index.
  for (const path of [
    '/',
    SANDBOX_PATH,
    `${SANDBOX_PATH}/`,
    '/favicon.ico',
    '/robots.txt',
    '/mcp/demo',
  ]) {
    const res = await fetch(at(path), env)
    assert.equal(res.status, 404, path)
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow')
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000')
  }
  assert.equal((await fetch(at(`${SANDBOX_PATH}/not-a-policy`), env)).status, 400)
  // Not configured: nobody gets a page.
  assert.equal((await fetch(at(`${SANDBOX_PATH}/${TOKEN}`), {})).status, 503)
  assert.equal(
    (await fetch(at(`${SANDBOX_PATH}/${TOKEN}`), { ALLOWED_HOST_ORIGINS: `${HOSTS} *` })).status,
    503,
  )
}

test('the handler (source): the page at /sandbox/v1/<policy>, with its headers; nothing else', () =>
  serves(handleRequest))

test('the bundle wrangler deploys answers the same', async () => {
  const bundle = resolve(project, config.main)
  assert.ok(existsSync(bundle), `${config.main} is built (pnpm nx build app-sandbox)`)
  const code = readFileSync(bundle, 'utf8')
  assert.doesNotMatch(code, /from\s*["'](?!\.)/, 'the bundle imports nothing')
  const worker = (await import(pathToFileURL(bundle).href)) as { default: { fetch: Handler } }
  await serves(worker.default.fetch)
})
