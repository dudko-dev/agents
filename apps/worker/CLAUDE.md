# worker — instructions for Claude

> Lives in the `dudko-dev/agents` monorepo at `apps/worker`. The root `CLAUDE.md` has the workspace
> commands (pnpm + nx) and the rules shared by all packages; this file is about this project only.

The Cloudflare Worker of https://agent.dudko.dev. The site itself is static assets and is served
without it: the root `wrangler.jsonc` runs this script for `/mcp/*` ONLY (`assets.run_worker_first`).
Today it serves one thing, the **demo MCP server** at `/mcp/demo`, which the demo's "Try the demo
server" button (MCP tab) connects to; any other `/mcp/...` path is handed back to the assets
(`env.ASSETS`, the site's 404 page). Private, never published.

## Principles

- **A public endpoint: bounded, and keeps nothing.** No storage, no secret, no outbound request, no
  log of anything a request carries (the SDK's `onerror` callbacks are silenced; nothing calls
  `console`). The limits are in `src/demo-server.ts` (`DEMO_LIMITS`): the body is bounded before it is
  parsed (413), JSON-RPC batches are refused (one message, so at most one tool call, per request), a
  `subscriptions/listen` is refused (nothing ever changes; a stream would stay open), arguments are
  bounded by the tool schemas and the SDK's `maxToolInputElements`, the answer is cut off past
  `responseBytes`, and a request with an `Origin` that is not the site's is refused (403; no CORS:
  other pages cannot use it, other kinds of clients can). Each limit has a test in
  `tests/demo-server.test.ts`; a new one gets one too. Request RATES are not limited here: that is
  a Cloudflare rate-limiting rule (dashboard), not code.
- **Stateless, both protocol eras, one factory.** `createMcpHandler` of `@modelcontextprotocol/server`
  builds a fresh `McpServer` per request from `buildServer` (`legacy: 'stateless'` serves the 2025
  revisions with a session-less streamable HTTP transport). No Durable Object: a question to the
  user works on 2026-07-28 only (an `input_required` result, answered by the client's retry, with
  nothing kept in between). On the 2025 revisions the server would have to receive the answer to
  its own `elicitation/create` in ANOTHER request (and maybe another isolate) - the SDK says so
  itself ("per-request legacy serving cannot receive server-to-client requests") - so the asking
  tools answer there with an error that names the revision they need. Do not keep state in module
  scope to "fix" that: isolates are not shared.
- **Web-standard only in the Worker.** `src/index.ts`, `src/demo-server.ts`, `src/tools.ts` import
  no `node:*` (the build fails if the bundle does: there is no `nodejs_compat`). `src/node.ts` is the
  Node adapter for the demo's Vite servers and the tests; it is never in the bundle.
- **The tests run the code that is deployed.** `tests/` imports the TypeScript source (Node strips the
  types) and, in `tests/worker.test.ts`, the bundle `wrangler.jsonc` names (`dist/index.js`). The
  demo's `vite dev` / `vite preview` mount `src/node.ts` (`apps/demo/vite.config.ts`), so the React
  package's browser test `e2e/demo-server.spec.ts` drives this same handler.

## Layout

- `src/index.ts` — the Worker: `handleRequest` (`/mcp/demo` → the demo server, anything else →
  `env.ASSETS`), `export default { fetch }`, `Env`. The demo server is made on the first request,
  not at module scope (a Worker may not make random values or timers while its script loads).
- `src/demo-server.ts` — `createDemoMcpServer()` (`fetch`, `close`): the SDK handler behind the
  limits, the origin check, the line a person gets on a GET; `DEMO_MCP_PATH`, `DEMO_LIMITS`,
  `DEMO_INSTRUCTIONS`, `DEMO_SERVER_INFO`, `boundResponse`.
- `src/tools.ts` — the tools: `echo`, `current_time`, `roll_dice` (the one with an `outputSchema` and
  `structuredContent`), `plan_trip` (a form question, `tripForm()`), `open_docs` (a link question, to
  `DOCS_PATH` on the origin the request came to). `DEMO_TOOL_NAMES` lists them in order. The doc
  comment of `registerDemoTools` is where an MCP App (a tool with a `ui://` resource) is added.
- `src/node.ts` — `toWebRequest`, `sendWebResponse`, `demoMcpMiddleware()` (connect-style; Vite).
- `scripts/build.mjs` — esbuild, the way wrangler builds a Worker (platform `browser`, conditions
  `workerd`, `worker`, `browser`) → `dist/index.js`; fails on a `node:*` import or a bundle over
  1 MiB gzipped. wrangler bundles the file again at deploy; nothing is left for it to resolve.
- `tests/demo-server.test.ts` — the wire, by hand (`tests/wire.ts`): both eras, every tool and
  question, every limit, nothing logged. `tests/client.test.ts` — the demo's own client
  (`connectMcpHttp` of `@dudko.dev/agent-web`, a dev dependency) over a real socket through
  `src/node.ts`. `tests/worker.test.ts` — `wrangler.jsonc` (only `/mcp/*` reaches the Worker) and
  the routing, on the source and on the bundle.

## Commands

```bash
pnpm nx run-many -t typecheck format:check build test -p worker
```

`pnpm nx build site` builds this project too (`site` and `demo` list it as a dev dependency), so
Cloudflare's build produces `dist/index.js` before `wrangler` reads `wrangler.jsonc`.

Locally, the demo's dev and preview servers serve `/mcp/demo` themselves. To run the Worker as
Cloudflare does, after `pnpm nx build site`: `npx wrangler dev --local` at the repository root
(wrangler is not a dependency of this repo; it works offline).

## Deployment notes (for the owner)

- Nothing to set up for the Worker itself: Workers Builds runs `pnpm nx build site`, then wrangler with
  the root `wrangler.jsonc` (`main` + `assets`). No secret, no binding but `ASSETS`, no flag.
- Recommended: a rate-limiting rule for `/mcp/*` in the Cloudflare dashboard (Security → WAF → Rate
  limiting rules), e.g. per IP. The code bounds each request, not how many there are.
- CPU: one request builds one MCP server and answers one message, a few milliseconds of CPU.

## Conventions

- Prettier: no semicolons, single quotes, trailing commas, width 100.
- `.ts` extensions in relative imports (Node runs the source). No enums, no parameter properties.
- A new tool: cheap, deterministic in what it can reach (no fetch, no storage), its inputs bounded by
  its schema, `readOnlyHint` when it changes nothing, its own test; add it to `DEMO_TOOL_NAMES`,
  the server's `DEMO_INSTRUCTIONS` and the demo's text on the MCP tab if it is worth naming.
