# worker — instructions for Claude

> Lives in the `dudko-dev/agents` monorepo at `apps/worker`. The root `CLAUDE.md` has the workspace
> commands (pnpm + nx) and the rules shared by all packages; this file is about this project only.

The Cloudflare Worker of https://agent.dudko.dev. The site itself is static assets and is served
without it: the root `wrangler.jsonc` runs this script for `/mcp/*` ONLY (`assets.run_worker_first`).
Today it serves one thing, the **demo MCP server** at `/mcp/demo`, which the demo's "Try the demo
server" button (MCP tab) connects to; any other `/mcp/...` path is handed back to the assets
(`env.ASSETS`, the site's 404 page). Private, never published. The server has one MCP App (the
`io.modelcontextprotocol/ui` extension): `trip_board`'s trip board, the demo's way to show MCP
Apps to a visitor who brings no server.

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
- **Web-standard only in the Worker.** `src/index.ts`, `src/demo-server.ts`, `src/tools.ts`,
  `src/trip-board.ts`, `src/trip-board-app.ts` import no `node:*` (the build fails if the bundle
  does: there is no `nodejs_compat`). `src/node.ts` is the Node adapter for the demo's Vite servers
  and the tests; it is never in the bundle.
- **The app is ours and reaches nothing.** `ui://demo/trip-board.html` is one document - markup,
  styles, one script - in `src/trip-board-app.ts`, with its resource's CSP lists declared EMPTY: no
  fetch, no external script / style / image / font, no frame. It talks to the host only, by hand
  (no SDK bundle), exactly as the extension's revision 2026-01-26 says (`ui/initialize` with
  `appInfo` / `appCapabilities` / `protocolVersion`, then `ui/notifications/initialized`; it
  answers `ping` and `ui/resource-teardown`, follows the host's theme, reports its height). It
  declares `['inline', 'fullscreen']` and has a Full screen button (`ui/request-display-mode`, shown
  only when the host offers it; Esc inside asks for inline), and - only where `hostCapabilities`
  says so - Download itinerary (`ui/download-file`, an embedded `.txt`, `downloadFile`) and, per
  day, Dinner idea (`sampling/createMessage` to the HOST's model, no tools, `maxTokens: 120`,
  `sampling`; the answer set with `textContent`). Text from the server or the model is set with
  `textContent` only; `innerHTML` takes the constant icons. Keep it under 40 KB (about 30 KB now;
  the script is sent without its indentation and whole-line comments, `shipped()`):
  `tests/demo-server.test.ts` checks the size, the empty lists, that there is no URL in it but the
  docs link, what it declares and asks for, and compiles the script. No backticks and no
  backslashes in that script: it is a template literal.
- **App tools: all stateless, listed to everyone.** `trip_board` (model and app, read-only) plans a
  trip from its inputs - and, when the model gives no `start`, from the day of the request: the
  first Friday at least 14 days later, in UTC (`defaultTripStart`; the same request day, the same
  dates; the text tells the model the date was picked and how to change it), so the board always
  shows real dates; `reshuffle_day` (`visibility: ['app']`, read-only) and `book_trip`
  (`visibility: ['app']`) are the board's. `book_trip` books nothing (the code is a hash of the
  inputs, `bookingCode`) yet is declared NOT read-only on purpose: a host asks the user before an
  app runs a write, and that prompt is what the demo shows. It is the one exception to "read-only
  when it changes nothing", and its description says so. Every tool is in `tools/list` on both
  eras and for every client: a stateless server cannot know, at a 2025 `tools/list`, what the
  client declared at `initialize` (another request), so the list does not depend on it; a host
  without MCP Apps may show the two app tools to its model, where they are harmless.
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
- `src/tools.ts` — the tools: `echo`, `current_time`, `roll_dice` (an `outputSchema` and
  `structuredContent`), `plan_trip` (a form question, `tripForm()`), `open_docs` (a link question, to
  `DOCS_PATH` on the origin the request came to), then the trip board's. `DEMO_TOOL_NAMES` lists
  them all in order. The doc comment of `registerDemoTools` says how an MCP App is added.
- `src/trip-board.ts` — the MCP App: `registerTripBoard` (the resource `TRIP_BOARD_URI`, MIME
  `text/html;profile=mcp-app`, empty CSP lists; the tools `trip_board`, `reshuffle_day`,
  `book_trip`), the plan as pure functions (`tripPlan`, `tripDay`, `tripEstimate`, `bookingCode`:
  FNV-1a, the same on every runtime), `TRIP_BOARD_TOOLS`, `APP_ONLY_TOOLS`, `APP_DOCS_PATH` (the
  link the app asks the host to open, on the request's origin, as `open_docs` does).
- `src/trip-board-app.ts` — `tripBoardHtml(docsUrl)`: the app's document (see above).
- `src/node.ts` — `toWebRequest`, `sendWebResponse`, `demoMcpMiddleware()` (connect-style; Vite).
- `scripts/build.mjs` — esbuild, the way wrangler builds a Worker (platform `browser`, conditions
  `workerd`, `worker`, `browser`) → `dist/index.js`; fails on a `node:*` import or a bundle over
  1 MiB gzipped. wrangler bundles the file again at deploy; nothing is left for it to resolve.
- `tests/demo-server.test.ts` — the wire, by hand (`tests/wire.ts`): both eras, every tool and
  question, the app (its declarations, `resources/read`, the plan, the code), every limit, nothing
  logged. `tests/client.test.ts` — the demo's own client (`connectMcpHttp` of
  `@dudko.dev/agent-web`, a dev dependency) over a real socket through `src/node.ts`, with and
  without `apps: true` (the app tools are not mounted for the model; the app is read and its tools
  called as a host does). `tests/worker.test.ts` — `wrangler.jsonc` (only `/mcp/*` reaches the
  Worker) and the routing, on the source and on the bundle, and that the docs links (`open_docs`,
  the app) name headings that exist. The React package's `e2e/demo-server-app.spec.ts` drives the app in
  the demo: its consent prompt, link prompt, message draft, height and the phone sheet, full screen
  (and a request without a click refused), the download prompt (Save / Cancel), the sampling
  prompt (Allow once / Always / Deny; the answer only in the app), and the server added with its
  apps off.

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
  its schema, `readOnlyHint` when it changes nothing (`book_trip` is the one exception, above), its
  own test; add it to `DEMO_TOOL_NAMES`, the server's `DEMO_INSTRUCTIONS` and the demo's text on
  the MCP tab if it is worth naming.
- `DEMO_LIMITS.responseBytes` (64 KiB) is twice the largest answer (the app's `resources/read`,
  about 31 KiB on the wire): a bigger app needs a test-backed reason to raise it.
