import { mcpAppSandboxResponse } from '@dudko.dev/agent-web-react/mcp-app-sandbox'

/**
 * The Worker of https://agent-demo-apps.dudko.dev: the MCP Apps sandbox page of the demo, on an
 * origin that is not the site's, so that an app the demo shows runs on an origin of its own and
 * never on agent.dudko.dev. Everything is the React package's `./mcp-app-sandbox` entry (the same
 * handler the demo's `vite dev` / `vite preview` mount for the browser tests); this file adds the
 * path, the allowed hosts from the configuration, and HSTS.
 *
 * Stateless and quiet: no storage, no binding, no outbound request, nothing logged.
 */

/** Where the page is: `/sandbox/v1/<policy>`. */
export const SANDBOX_PATH = '/sandbox/v1'

/** The configuration (`wrangler.jsonc` `vars`). */
export interface Env {
  /** The host origins that may frame the page, space separated (`parseMcpAppSandboxHosts`). */
  ALLOWED_HOST_ORIGINS?: string
}

export const handleRequest = (request: Request, env: Env): Response => {
  const response = mcpAppSandboxResponse(request, {
    path: SANDBOX_PATH,
    hosts: env.ALLOWED_HOST_ORIGINS,
  })
  response.headers.set('Strict-Transport-Security', 'max-age=31536000')
  return response
}

export default { fetch: handleRequest }
