# agents — instructions for Claude

Monorepo (pnpm workspaces + Nx) of three published packages, one private test package, four
private apps and one private example (with its shared package):

- `packages/agent` — `@dudko.dev/agent`, the Node / server agent.
- `packages/agent-web` — `@dudko.dev/agent-web`, the in-browser agent (the core of the next two).
- `packages/agent-web-react` — `@dudko.dev/agent-web-react`, React bindings; its `e2e/` drives the demo.
- `packages/test-servers` — `@dudko.dev/test-servers` (private, never published): the test
  enterprise IdP, MCP authorization server and MCP server the packages' tests run against, as
  functions and as a CLI. TypeScript run directly by Node (type stripping), no build. Loopback
  only. Not in `.github/scripts/release-plan.mjs`'s list, and must stay out of it.
- `apps/demo` — the Vite demo of the React package (private, never published). One project, two
  pages: the demo (`/demo/`) and the pipeline editor (`/pipeline/`).
- `apps/site` — https://agent.dudko.dev: the landing page and the docs (Astro + Starlight), with the
  built demo mounted under `/demo/` and the pipeline editor under `/pipeline/` (`scripts/assemble.mjs`
  copies both from `apps/demo/dist` and adds `/pipeline/` to the sitemap). The docs pages are **generated** from the packages' READMEs
  and `docs/*.md` (`scripts/sync-docs.mjs`): edit the source file in the package, never the copy.
  A new docs file needs an entry in that script's `PAGES` and in the sidebar (`astro.config.mjs`).
  Dark theme only; colours, type and motion come from `src/styles/tokens.css`.
  The link-preview cards (`public/og.png`, `public/og/demo.png`, `public/og/pipeline.png`) are
  rendered from `scripts/og-card.html` by `pnpm nx build site && pnpm --filter site og-cards`
  (Chromium and the Inter font; not part of the Cloudflare build) - run it after a visible change
  to the demo or the editor and commit the PNGs.
  Files for machines (`llms.txt`, `robots.txt`, the sitemap, the manifest) are never linked from the
  interface - no footer or menu entry: crawlers find them by their well-known paths. Check every
  page at phone width for sideways scroll before pushing.
- `apps/worker` — the Cloudflare Worker of the site, for `/mcp/*` only: the public demo MCP server at
  `/mcp/demo` (the demo's "Try the demo server"). Stateless, both protocol revisions, abuse limits
  in code; bundled to `apps/worker/dist/index.js`. The demo's `vite dev` / `vite preview` serve the
  same handler on Node (`apps/worker/src/node.ts`), which is what the browser tests talk to.
- `apps/app-sandbox` — a SECOND Cloudflare Worker, NOT the site's: https://agent-demo-apps.dudko.workers.dev,
  the MCP Apps sandbox page (`/sandbox/v1/<policy>`, 404 elsewhere) the demo frames so that an app
  runs on an origin of its own. A thin deployment of the React package's `./mcp-app-sandbox`
  entry (the page, its headers and guards live and are tested there); its own `wrangler.jsonc`
  (workers.dev only - never a host under dudko.dev, where an app could set cookies for all of
  dudko.dev; the allowed hosts in `vars`), its own Workers Builds project.
  `pnpm nx build site` never builds it (`site` / `demo` do not depend on it; its test pins that).
  Locally the demo's `vite dev` / `vite preview` serve the same page under the other loopback name.
- `examples/swarm` — `swarm` (private, NEVER published; not in `release-plan.mjs`, and must stay
  out of it): a reference deployment of the Node agent as a horizontally scaled swarm on
  self-hosted Temporal + Postgres - a session workflow per conversation, one `agent.run` per turn as
  an activity, the agent's scale-out hooks (`persistence` with the call journal, `runLease`,
  `sharedLimits`, events) on Temporal and Postgres, turns that park on a person's answer, static
  subagents and pipelines (the core's graph engine in a workflow) as child workflows, a stateless
  gateway with SSE (`swarm-shared`'s fetch handler on `node:http`), one image (`Dockerfile`,
  distroless, roles `gateway` | `worker` | `migrate`), `compose.yaml` and a Helm chart
  (`deploy/helm/agent-swarm`). TypeScript run directly by Node; `build`
  only bundles the workflow code. `test` needs nothing external; `test:integration` needs a Postgres
  (`DATABASE_URL`) and starts a Temporal dev server (`@temporalio/testing`, downloaded) - CI runs it
  in `swarm.yml`, not in `ci.yml`. It uses only the agent's public API: a change it would need in
  the core is a change to `packages/agent`, made there. Its own `CLAUDE.md` has the rules.
- `examples/swarm-shared` — `swarm-shared` (private, NEVER published; not in `release-plan.mjs`,
  and must stay out of it): the platform-independent part of the swarm, shared by its ports to
  other platforms (the same HTTP API, the same session semantics) - the session's logic, ids and
  types, the answer checks, the cursor (`./workflow`: what a workflow sandbox may import), and the
  HTTP API as a fetch-style handler over Web APIs (`(request: Request) => Promise<Response>`, no
  `node:*`). Unlike `test-servers` it ships built JS (`build`: tsc -> `dist`, which `exports`
  names): the swarm's image copies it into `node_modules`, where Node strips no types. Its own
  `CLAUDE.md` has the rules.

**Each package has its own `CLAUDE.md`. Read it before changing that package** — layout, conventions
and the reasons behind them live there. This file holds only what is shared.

## Commands

Run from the repo root. Nx orders tasks by the dependency graph and caches them.

```bash
pnpm install                 # after any dependency change; commit pnpm-lock.yaml
pnpm check                   # typecheck + format:check + build + test, every project
pnpm affected                # the same for what changed against main
pnpm test:e2e                # Playwright over the built demo
pnpm nx <target> <project>   # e.g. pnpm nx test @dudko.dev/agent-web
```

Projects: `@dudko.dev/agent`, `@dudko.dev/agent-web`, `@dudko.dev/agent-web-react`,
`@dudko.dev/test-servers`, `demo`, `site`, `worker`, `app-sandbox`, `swarm`, `swarm-shared`.
Targets come from each package's `scripts`: `typecheck`, `format:check`, `format`, `build`, `test`
(and `test:e2e` in the React package, `test:integration` in `swarm` - not part of `pnpm check`;
`@dudko.dev/test-servers` has no `build`).

After **any** change to `.ts` / `.tsx`, run the four checks for the packages you touched **and
everything that depends on them** (`pnpm affected`, or `pnpm check` when in doubt) with the Bash
tool. Do not infer success from "the change looks right".

## How the packages fit

- `agent-web-react` and `demo` depend on `agent-web` through `workspace:*`: they always build and
  test against the core in this tree. `agent-web` stays a **peer** dependency of the React package
  for users (one core instance per app) — keep the peer range honest when the React package starts
  needing a newer core API.
- Tests of the two browser packages import from `dist`, the typecheck of the React package reads
  the core's `dist` types, and the demo aliases the React package's `dist`. That is why `build`
  comes first in `nx.json` (`dependsOn`). Do not add `pretest` / `prebuild` scripts that rebuild —
  two builds of the same `dist` in parallel race.
- `agent` and `agent-web` take `test-servers` as a `workspace:*` **dev** dependency and import its
  TypeScript source directly (`exports` points at `src/index.ts`): there is nothing to build, and
  Node strips the types because pnpm's link resolves to the real path outside `node_modules`.
  It never becomes a runtime dependency of a published package.
- `agent` and `agent-web` are siblings, not dependants: public API, config fields, event names and
  semantics are shared **by convention**. A change to one usually needs the same change in the
  other, in the same pull request. Some code is a deliberate copy (the egress policy core, learning
  guards, the token estimate) — change both, with tests.
- pnpm does not hoist: a package may import only what its own `package.json` declares. A new import
  in a test or an e2e file needs a `devDependencies` entry in that package.
- Dependency install scripts are off except for the ones listed in `pnpm-workspace.yaml`
  (`onlyBuiltDependencies`).
- `pnpm-workspace.yaml` keeps `@types/json-schema` out of the hidden hoist (`hoistPattern`): the
  swarm's Temporal worker brings it (through webpack), and hoisted it would give the AI SDK's own
  `.d.ts` a real `JSONSchema7` and change what the cores typecheck against. Drop the exclusion once
  the cores' JSON schemas typecheck against it.

## Conventions

- Prettier (root `.prettierrc.json`): no semicolons, single quotes, trailing commas, width 100.
  It checks `.ts` / `.tsx` / `.css` only — do not run it on `.md`.
- Docs live next to the code (the README goes to npm; `docs/*.md` are published on the site, not in the npm package): a new config field, event, export, env var or label is
  documented in the same pull request (each package's `CLAUDE.md` says where).
- Security boundaries (safe fetch / egress, learning guards, consent, OAuth) need a test for every
  guard and a mutation check.
- Never commit secrets, API keys or customer data, in tests or fixtures either.

## Boundaries

- Do not push to `main` directly; work on a branch and open a pull request.
- Versions are per package (`packages/*/package.json`). Do not bump them as part of a feature
  change — a release is its own pull request that bumps the version of the package(s) to publish.
- Workflows: `ci.yml` (checks + browser tests); `release.yml` (after CI passes on `main`, publishes
  every package whose version is not on npm yet — `.github/scripts/release-plan.mjs` decides — via
  npm Trusted Publishing, tags `<dir>-v<version>` and creates a GitHub release); `live-model.yml`
  (the Node agent against a real local model: gates its publish, and runs on PRs that touch its
  dependencies); `swarm.yml` (the swarm example's integration tests against a Postgres service
  and a Temporal dev server, its Docker image built without a push, and its Helm chart's lint /
  template / kubeconform, on changes to `examples/swarm`, `examples/swarm-shared` or
  `packages/agent`); `swarm-image.yml`
  (publishes the swarm image for linux/amd64 + arm64 to `ghcr.io/dudko-dev/agent-swarm`, and to
  `docker.io/sergdudko/agent-swarm` when the `DOCKER_USER` / `DOCKER_PAT` secrets are set: on an
  `agent-v*` tag - after a Release run, since release.yml's tag push starts no workflow - and by
  hand; never on PRs). Do not edit `release.yml` unless asked: npm's Trusted Publisher setting
  names that file and the `release` environment.
- The site and the demo are built and deployed by Cloudflare (Workers Builds: `pnpm nx build site`,
  then `wrangler.jsonc` publishes `apps/site/dist`), not by a workflow here. The site is static
  assets, served without a script; there IS a Worker script (`main`: `apps/worker/dist/index.js`,
  built by `pnpm nx build site` through `site`'s dev dependency on `worker`), and
  `assets.run_worker_first: ["/mcp/*"]` runs it for those paths ONLY - every other path, the 404
  page included, is answered by the assets exactly as before. Keep it that way: a path added to
  `run_worker_first` is a path the static site no longer answers first
  (`apps/worker/tests/worker.test.ts` pins the config). Keep `"previews": {}`.
- The apps' sandbox page is a second Workers Builds project (`agent-demo-apps`, set up by the
  owner - `apps/app-sandbox/README.md`): build `pnpm nx build app-sandbox`, deploy
  `npx wrangler deploy --config apps/app-sandbox/wrangler.jsonc`, served at
  `agent-demo-apps.dudko.workers.dev` (no Custom Domain: see above). Never fold it into the site's Worker or `run_worker_first`: every
  site request would go through a script, and the page must be on ANOTHER origin than the site.
- `autoupdate.yml` (weekly): `.github/scripts/autoupdate.mjs` runs `pnpm update -r --latest`
  (except `typescript` and `@types/node`), patch-bumps and changelogs the published packages whose
  own `dependencies` changed, opens a PR, merges it when CI is green and dispatches the release.
  When the checks are red it dispatches `claude.yml`, which fixes the branch (up to 3 attempts).
  Events made with `GITHUB_TOKEN` start no workflows, which is why these two dispatch `ci.yml`,
  `live-model.yml` and `release.yml` explicitly — do not replace the dispatches with comment
  mentions or rely on `pull_request` / `push` triggers there. The same goes for the swarm image:
  a Release run autoupdate dispatched fires no `workflow_run`, so autoupdate waits for the agent's
  release tag at the merge commit and dispatches `swarm-image.yml` with it.
- On an autoupdate branch (`chore/autoupdate-<run_id>`): make the checks green with compatibility
  fixes only, never change product behaviour or versions; if that is impossible, say so in a PR
  comment instead of guessing.
