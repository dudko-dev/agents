# app-sandbox — instructions for Claude

> Lives in the `dudko-dev/agents` monorepo at `apps/app-sandbox`. The root `CLAUDE.md` has the
> workspace commands (pnpm + nx) and the rules shared by all packages; this file is about this
> project only.

The Cloudflare Worker of **https://agent-demo-apps.dudko.workers.dev**: the MCP Apps sandbox page the demo
frames, so that an app runs on an origin of its own. Private, never published. A SEPARATE Worker
from the site's (`apps/worker`): its own `wrangler.jsonc`, its own Workers Builds project
(README.md), never built or deployed by `pnpm nx build site`.

## Principles

- **The library is the page; this is a deployment of it.** Everything that matters - the page,
  its script, the policy from the path, the headers, the 400 / 404 / 405 / 503 - is the React
  package's `./mcp-app-sandbox` entry (`packages/agent-web-react/src/mcp-app-sandbox.ts`, a
  security boundary with its own tests). `src/index.ts` adds the path (`/sandbox/v1`), the hosts
  from `env.ALLOWED_HOST_ORIGINS` and HSTS. A change to what the page does goes into the library,
  with its tests, never here.
- **One origin, one thing, never under dudko.dev.** `workers_dev: true` (its only address),
  `preview_urls: false`, no route, no Custom Domain; every other path is 404. A host under
  `dudko.dev` would let any app set cookies for every `dudko.dev` host (`Domain=dudko.dev`);
  `workers.dev` is a public suffix, so cookies stop at `dudko.workers.dev`. Do not add routes,
  assets or other pages: anything served on this host is same-origin with every app the demo
  shows.
- **Keeps nothing, says nothing.** No storage, no binding, no secret, no outbound request, no
  `console`, no observability.
- **The hosts are configuration.** `vars.ALLOWED_HOST_ORIGINS` in `wrangler.jsonc`; the test pins
  it. A new host of the demo (a renamed Worker, another domain) goes there, not in code.
- **The tests run the code that is deployed**: the source and the bundle `main` names.

## Layout

- `src/index.ts` — `handleRequest`, `SANDBOX_PATH`, `Env`, `export default { fetch }`.
- `scripts/build.mjs` — esbuild like wrangler (platform `browser`, conditions `workerd`, `worker`,
  `browser`) → `dist/index.js`; fails on a `node:*` import, on React / the core / `ai` / `zod` in
  the bundle, or over 32 KiB gzipped (it is ~4 KiB).
- `tests/worker.test.ts` — `wrangler.jsonc` pinned (name, workers.dev only - no route, no Custom Domain -, the
  hosts and what they admit), the site's build and config free of this Worker, and the handler on
  the source and on the bundle.
- `wrangler.jsonc` — the deployment; `README.md` — what the owner sets up on Cloudflare.

## Commands

```bash
pnpm nx run-many -t typecheck format:check build test -p app-sandbox
```

`pnpm nx build app-sandbox` builds the core and the React package first (`^build`).

## Conventions

- Prettier: no semicolons, single quotes, trailing commas, width 100.
- `.ts` extensions in relative imports (Node runs the source in the tests).
