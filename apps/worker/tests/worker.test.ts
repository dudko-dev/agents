import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEMO_MCP_PATH } from '../src/demo-server.ts'
import { handleRequest, type Env } from '../src/index.ts'
import { modernRequest, read } from './wire.ts'

// The Worker as Cloudflare runs it: which paths reach it (the root wrangler.jsonc), what it does
// with them (the source, and the bundle `main` names), and that every other path stays the
// static site.

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')

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

const config = parseJsonc(readFileSync(resolve(repo, 'wrangler.jsonc'), 'utf8'))

/**
 * Whether a path matches `assets.run_worker_first` (Cloudflare's route patterns: `*` matches
 * anything, `/` included; a pattern that starts with `!` sends its matches back to the assets).
 */
const reachesWorker = (patterns: string[], path: string): boolean => {
  const matches = (pattern: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(path)
  return (
    patterns.some((p) => !p.startsWith('!') && matches(p)) &&
    !patterns.some((p) => p.startsWith('!') && matches(p.slice(1)))
  )
}

test('wrangler.jsonc: a Worker for /mcp/* only, in front of the same static site', () => {
  assert.equal(config.main, './apps/worker/dist/index.js')
  assert.deepEqual(config.assets, {
    directory: './apps/site/dist',
    not_found_handling: '404-page',
    binding: 'ASSETS',
    run_worker_first: ['/mcp/*'],
  })
  // The binding the Worker reads is the one the config names.
  const env: Env = { ASSETS: { fetch: async () => new Response() } }
  assert.deepEqual(Object.keys(env), [config.assets.binding])
  // Workers Builds' previews need the block, even empty.
  assert.deepEqual(config.previews, {})
  // The SDK runs on workerd as it is: no Node compatibility layer.
  assert.equal(config.compatibility_flags, undefined)

  const patterns: string[] = config.assets.run_worker_first
  assert.equal(reachesWorker(patterns, DEMO_MCP_PATH), true)
  assert.equal(reachesWorker(patterns, '/mcp/anything/else'), true)
  for (const path of [
    '/',
    '/demo/',
    '/pipeline/',
    '/docs/browser/',
    '/mcp',
    '/demo/mcp/demo',
    '/404',
  ]) {
    assert.equal(reachesWorker(patterns, path), false, path)
  }
})

/** The assets, as a fake that records what was handed back to it. */
const assets = () => {
  const seen: string[] = []
  const env: Env = {
    ASSETS: {
      fetch: async (request) => {
        seen.push(new URL(request.url).pathname)
        return new Response('<!doctype html><title>Not found</title>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        })
      },
    },
  }
  return { env, seen }
}

type Handler = (request: Request, env: Env) => Promise<Response>

const routes = async (fetch: Handler): Promise<void> => {
  const { env, seen } = assets()
  const mcp = await read(await fetch(modernRequest('tools/list'), env))
  assert.equal(mcp.status, 200)
  assert.equal(mcp.message.result.tools.length, 5)
  // Any other path the Worker sees is the assets' answer: the site's own 404 page.
  for (const path of ['/mcp/other', '/mcp/demo/', '/']) {
    const res = await fetch(new Request(`https://agent.dudko.dev${path}`), env)
    assert.equal(res.status, 404)
    assert.match(await res.text(), /Not found/)
  }
  assert.deepEqual(seen, ['/mcp/other', '/mcp/demo/', '/'])
}

test('the Worker (source): /mcp/demo is the MCP server, every other path goes to the assets', async () => {
  await routes(handleRequest)
})

test('the Worker (the bundle wrangler deploys): the same', async () => {
  const bundle = resolve(repo, config.main)
  assert.ok(existsSync(bundle), `${config.main} is not built: run \`pnpm nx build worker\``)
  const mod = (await import(pathToFileURL(bundle).href)) as { default: { fetch: Handler } }
  await routes(mod.default.fetch)
})
