# agents — instructions for Claude

Monorepo (pnpm workspaces + Nx) of three published packages and one private app:

- `packages/agent` — `@dudko.dev/agent`, the Node / server agent.
- `packages/agent-web` — `@dudko.dev/agent-web`, the in-browser agent (the core of the next two).
- `packages/agent-web-react` — `@dudko.dev/agent-web-react`, React bindings; its `e2e/` drives the demo.
- `apps/demo` — the Vite demo of the React package (private, never published).

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

Projects: `@dudko.dev/agent`, `@dudko.dev/agent-web`, `@dudko.dev/agent-web-react`, `demo`.
Targets come from each package's `scripts`: `typecheck`, `format:check`, `format`, `build`, `test`
(and `test:e2e` in the React package).

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
- The demo is built and deployed by Cloudflare (Workers Builds, `wrangler.jsonc`), not by a
  workflow here.
- The autoupdate and Claude workflows of the old repositories are kept for reference under
  `.github/_imported/` until they are ported; they do not run from there.
