import { createDemoMcpServer, DEMO_MCP_PATH, type DemoMcpServer } from './demo-server.ts'

/**
 * The Worker of agent.dudko.dev. The site is static assets (`apps/site/dist`), served by
 * Cloudflare without this script: the root `wrangler.jsonc` sends only `/mcp/*` here
 * (`assets.run_worker_first`). This script serves the demo MCP server at `DEMO_MCP_PATH` and
 * hands every other path back to the assets, so an unknown `/mcp/...` gets the site's own 404
 * page, exactly as any other unknown path does.
 */

/** The bindings of the Worker (`wrangler.jsonc`): the static assets, as `assets.binding`. */
export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

// Made on the first request, not at module scope: a Worker may not generate random values or
// set timers while its script is being evaluated, and what the SDK does at construction is its
// business. One per isolate; every request still gets a fresh MCP server instance.
let demo: DemoMcpServer | undefined

export const handleRequest = async (request: Request, env: Env): Promise<Response> => {
  const { pathname } = new URL(request.url)
  if (pathname === DEMO_MCP_PATH) {
    demo ??= createDemoMcpServer()
    return demo.fetch(request)
  }
  return env.ASSETS.fetch(request)
}

export default { fetch: handleRequest }
