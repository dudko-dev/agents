# worker — instructions for Claude

> Lives in the `dudko-dev/agents` monorepo at `apps/worker`. The root `CLAUDE.md` has the workspace
> commands (pnpm + nx) and the rules shared by all packages; this file is about this project only.

The Cloudflare Worker of https://agent.dudko.dev. The site itself is static assets and is served
without it: the root `wrangler.jsonc` runs this script for `/mcp/*` ONLY (`assets.run_worker_first`).
Today it serves one thing, the **demo MCP server** at `/mcp/demo`, which the demo's "Try the demo
server" button (MCP tab) connects to; any other `/mcp/...` path is handed back to the assets
(`env.ASSETS`, the site's 404 page). Private, never published. The server has one MCP App (the
`io.modelcontextprotocol/ui` extension): `trip_board`'s trip board, the demo's way to show MCP
Apps to a visitor who brings no server. And, on 2026-07-28 only, two skills (the Skills extension
`io.modelcontextprotocol/skills`, Beta): `skill://demo/trip-planning/SKILL.md` (with
`references/checklist.md`) and `skill://demo/dice-games/SKILL.md` - the demo's "Try it with its
skills" adds the server with `skills: true`.

What it serves:

| Kind | Name | Era | What |
| --- | --- | --- | --- |
| tool | `echo`, `current_time`, `roll_dice` | both | answer at once (`roll_dice`: `outputSchema` + `structuredContent`) |
| tool | `plan_trip`, `open_docs` | 2026-07-28 (an error on 2025) | ask the user: a form, a link |
| tool + app | `trip_board` (+ `reshuffle_day`, `book_trip` for the app only) | both | the trip board, `ui://demo/trip-board.html` |
| skill | `demo/trip-planning` (+ `references/checklist.md`) | 2026-07-28 | plan a trip with `plan_trip` / `trip_board` / `current_time`; a packing and papers list |
| skill | `demo/dice-games` | 2026-07-28 | Pig and Yacht-lite, every roll from `roll_dice` |

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
- **Skills: 2026-07-28 only, static, and true to their bytes.** `src/skills.ts` attaches the SDK's
  `SkillsExtension` (`@modelcontextprotocol/server/ext/skills`, shipped by the installed 2.x server
  SDK) to the servers `buildServer` makes for the modern era only: the extension is written against
  2026-07-28, so a 2025 client sees no `extensions` and gets -32601 for `skills/*`. The skills are
  constant strings (`DEMO_SKILL_FILES`), served through `resources/read` (`skill://demo/...`, not
  in `resources/list`); the entries of `skills/list` / `skills/get` are built from those same
  strings on every call by the SDK's `skillEntry` (sizes and sha256 digests by WebCrypto, the
  frontmatter parsed from the `SKILL.md`, the naming rules checked) - never typed by hand, nothing
  kept between requests. `strict` (a broken entry is an error, not a skill that vanishes),
  `onWarning` silenced (nothing logged), one page (a cursor is -32602), no `directoryRead`, no
  `"dynamic"`. Each skill under `DEMO_SKILL_MAX_BYTES` (8 KiB; about 4 KiB and 2.6 KiB now), plain
  ASCII English, no URL. A skill names only this server's tools, says what it cannot do (book
  anything) and leaves host details out (it says "a file of this skill", not a host's tool name).
- **Web-standard only in the Worker.** `src/index.ts`, `src/demo-server.ts`, `src/tools.ts`,
  `src/trip-board.ts`, `src/trip-board-app.ts`, `src/skills.ts` import no `node:*` (the build
  fails if the bundle does: there is no `nodejs_compat`). `src/node.ts` is the Node adapter for the demo's Vite servers
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
- `src/skills.ts` — the skills (see above): `DEMO_SKILL_FILES` (path → file → text),
  `DEMO_SKILL_URIS`, `DEMO_SKILLS_PREFIX`, `DEMO_SKILL_MAX_BYTES`, `attachDemoSkills(server)`.
- `src/node.ts` — `toWebRequest`, `sendWebResponse`, `demoMcpMiddleware()` (connect-style; Vite).
- `scripts/build.mjs` — esbuild, the way wrangler builds a Worker (platform `browser`, conditions
  `workerd`, `worker`, `browser`) → `dist/index.js`; fails on a `node:*` import or a bundle over
  1 MiB gzipped (about 240 KiB now; the skills extension added about 20 KiB). wrangler bundles the
  file again at deploy; nothing is left for it to resolve.
- `tests/demo-server.test.ts` — the wire, by hand (`tests/wire.ts`): both eras, every tool and
  question, the app (its declarations, `resources/read`, the plan, the code), every limit, nothing
  logged. `tests/client.test.ts` — the demo's own client (`connectMcpHttp` of
  `@dudko.dev/agent-web`, a dev dependency) over a real socket through `src/node.ts`, with and
  without `apps: true` (the app tools are not mounted for the model; the app is read and its tools
  called as a host does), and with `skills: true` (both skills listed with no refusal, one loaded
  and its file read - verified by the SDK's skills client - none on a 2025 connection, nothing
  of the extension without the flag). `tests/skills.test.ts` — the skills on the wire: the
  extension on 2026-07-28 only, every entry accepted by the demo client's own rule checker
  (`mcpSkillEntryRefusal` from the built `@dudko.dev/agent-web`), sizes / digests / frontmatter
  against the bytes `resources/read` serves, URI = name, `skills/get` (a known entry, -32602
  otherwise), unknown files and cursors (-32602), the size caps, plain ASCII, nothing logged.
  `tests/worker.test.ts` — `wrangler.jsonc` (only `/mcp/*` reaches the Worker) and the routing,
  on the source and on the bundle (`skills/list` included: the digests are made there too), and that the docs links (`open_docs`,
  the app) name headings that exist. The React package's `e2e/demo-server-app.spec.ts` drives the app in
  the demo: its consent prompt, link prompt, message draft, height and the phone sheet, full screen
  (and a request without a click refused), the download prompt (Save / Cancel), the sampling
  prompt (Allow once / Always / Deny; the answer only in the app), and the server added with its
  apps off. Its `e2e/demo-server-skills.spec.ts` drives the skills: "Try it with its skills", the
  planner picks `demo/trip-planning`, its text reaches the model under the third-party preamble,
  `references/checklist.md` is read and `trip_board` called; "Try the demo server" lists none.

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
- A new skill: a path `demo/<name>` (its last segment = its frontmatter `name`) in
  `DEMO_SKILL_FILES`, `SKILL.md` first; nothing else to keep in step (the entries are built from
  the files). Under `DEMO_SKILL_MAX_BYTES`, plain ASCII English, no URL, about this server's tools
  only; update `tests/skills.test.ts`'s listing and the table above. A frontmatter value is a plain
  YAML scalar: no `: ` and no ` #` in it.
- `DEMO_LIMITS.responseBytes` (64 KiB) is twice the largest answer (the app's `resources/read`,
  about 31 KiB on the wire): a bigger app needs a test-backed reason to raise it.
