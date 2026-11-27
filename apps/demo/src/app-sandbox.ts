import type { McpAppSandboxOptions } from '@dudko.dev/agent-web-react'

// Where the demo's MCP Apps run: on an origin of their own, behind the sandbox page
// (`@dudko.dev/agent-web-react/mcp-app-sandbox`).
//
// - On the site (https://agent.dudko.dev and its Cloudflare previews): the separate Worker
//   apps/app-sandbox, on its own domain. One origin for every app of every server (a wildcard
//   for one origin per server would need a paid certificate) - see its README.
// - On loopback (`vite dev`, `vite preview`, the browser tests): the same page, served by the
//   dev / preview server itself (`appSandbox` in vite.config.ts) under the OTHER loopback name on
//   the same port - 127.0.0.1 for a page on localhost and the other way round. A different host
//   is a different origin and a different site (cookies are per host, not per port), so the
//   cross-origin path is the one tested.
//
// Until that page answers (the domain not set up yet, a network that blocks it), a frame falls
// back to the opaque sandbox after `timeoutMs` and says so in its header: nothing breaks.

export const APP_SANDBOX_PATH = '/sandbox/v1'
export const APP_SANDBOX_URL = 'https://agent-demo-apps.dudko.dev/sandbox/v1'

const OTHER_LOOPBACK: Record<string, string> = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' }

/** The sandbox for a page at `where` (the demo's own location). */
export const appSandboxFor = (where: { protocol: string; hostname: string; port: string }) => {
  const other = OTHER_LOOPBACK[where.hostname]
  const url = other
    ? `${where.protocol}//${other}${where.port ? `:${where.port}` : ''}${APP_SANDBOX_PATH}`
    : APP_SANDBOX_URL
  return { url, timeoutMs: 4000 } satisfies McpAppSandboxOptions
}

export const APP_SANDBOX: McpAppSandboxOptions = appSandboxFor(location)
