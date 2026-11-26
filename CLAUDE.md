# agents — instructions for Claude

Monorepo (pnpm workspaces + Nx) of three published packages, one private test package and two
private apps:

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
  Files for machines (`llms.txt`, `robots.txt`, the sitemap, the manifest) are never linked from the
  interface - no footer or menu entry: crawlers find them by their well-known paths. Check every
  page at phone width for sideways scroll before pushing.

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
`@dudko.dev/test-servers`, `demo`, `site`.
Targets come from each package's `scripts`: `typecheck`, `format:check`, `format`, `build`, `test`
(and `test:e2e` in the React package; `@dudko.dev/test-servers` has no `build`).

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

## Conventions

- Prettier (root `.prettierrc.json`): no semicolons, single quotes, trailing commas, width 100.
  It checks `.ts` / `.tsx` / `.css` only — do not run it on `.md`.
- Docs ship inside the npm packages: a new config field, event, export, env var or label is
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
  dependencies). Do not edit `release.yml` unless asked: npm's Trusted Publisher setting names
  that file and the `release` environment.
- The site and the demo are built and deployed by Cloudflare (Workers Builds: `pnpm nx build site`,
  then `wrangler.jsonc` publishes `apps/site/dist`), not by a workflow here.
- `autoupdate.yml` (weekly): `.github/scripts/autoupdate.mjs` runs `pnpm update -r --latest`
  (except `typescript` and `@types/node`), patch-bumps and changelogs the published packages whose
  own `dependencies` changed, opens a PR, merges it when CI is green and dispatches the release.
  When the checks are red it dispatches `claude.yml`, which fixes the branch (up to 3 attempts).
  Events made with `GITHUB_TOKEN` start no workflows, which is why these two dispatch `ci.yml`,
  `live-model.yml` and `release.yml` explicitly — do not replace the dispatches with comment
  mentions or rely on `pull_request` / `push` triggers there.
- On an autoupdate branch (`chore/autoupdate-<run_id>`): make the checks green with compatibility
  fixes only, never change product behaviour or versions; if that is impossible, say so in a PR
  comment instead of guessing.
