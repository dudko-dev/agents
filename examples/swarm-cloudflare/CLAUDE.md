# CLAUDE.md

> The workspace project `swarm-cloudflare` at `examples/swarm-cloudflare`. The root `CLAUDE.md` has
> the workspace commands and the shared rules; this file is about this project only. `README.md` is
> the user's guide (the architecture, the mapping from the Temporal swarm, every env var, deploying).

## What it is

The swarm of `examples/swarm` - `swarm-shared`'s HTTP API and session semantics - on Cloudflare:
`SessionDO` (one Durable Object per session, SQLite) is the session's single writer; `TurnWorkflow`,
`SubagentWorkflow`, `PipelineWorkflow` and `PipelineNodeWorkflow` run the turns and the children,
one `agent.run` attempt per step; `LimiterDO` holds the shared limits. The Node core runs in workerd
under `nodejs_compat`. **Private, never published** (not in `.github/scripts/release-plan.mjs`;
keep it out). No version bumps, no CHANGELOG.

## Boundaries

- **Never deploy and never log in.** No `wrangler deploy` (but `--dry-run`, which is `build`), no
  `wrangler login`, no remote bindings (`remote: true`), no `--remote`, no account calls - in code,
  scripts, tests or CI. Local only: `wrangler dev` / Miniflare. Deploying is the owner's, by hand
  (README "Deploying"). CI holds no Cloudflare secret; do not add one.
- **Secrets** are Worker secrets (`.dev.vars` locally, gitignored). Never in `wrangler.jsonc`, a
  test or a fixture; the e2e use obvious fakes (`not-a-real-key`).

## Layout

- `src/store.ts` - the object's tables and every fenced write (runs, journal, lease, events, parked,
  children, phases, outbox). `src/sql.ts` the storage shape it needs (a DO's `ctx.storage` or
  `node:sqlite` in tests) and `splitText` (rows hold 2 MB).
- `src/session.ts` - `SessionCore`: every transition (swarm-shared's reducer applied, its effects as
  outbox rows, in one transaction). `src/host.ts` - `SessionHost`: the RPC surface, the DO-local
  gateway for the streams, the outbox drain, the alarm, the watchdog. `src/durable.ts` - the thin
  `cloudflare:workers` classes (`SessionDO`, `LimiterDO`): keep them thin, logic belongs in the two
  files above (they run in Node tests).
- `src/workflows.ts` - the Workflow classes; `src/steps.ts` - what a step does (an agent per step,
  the hooks on the object, `runOne`, the fences' client side). `src/backend.ts` + `src/gateway.ts` -
  the Worker's `ISessionBackend` and its routing (streams forwarded after the bearer check).
- `src/agent-config.ts` (env -> agent config, providers built in code, HTTP MCP only),
  `src/subagents.ts`, `src/pipelines.ts`, `src/child-ask.ts` - adapted copies of examples/swarm's
  (budget closures instead of AsyncLocalStorage). `src/config.ts`, `src/env.ts` - the env.
- `tests/` - `node --test` over the logic (in `pnpm check`). `e2e/` - against `wrangler dev`
  (`test:e2e`, not in `pnpm check`; `swarm-cloudflare.yml`).

## Rules

- **The object is the single writer, and a transition is one transaction.** State, markers, parked
  items, children and the outbox rows of its effects are written together (`transactionSync`); an
  effect is made after it, in order, idempotently (instance ids are functions of what they run).
  Never call another service inside a transaction, never make an effect that is not an outbox row.
- **Fences** (security boundary - a change needs a test and a mutation check): a checkpoint writes
  at `attempt >=` the stored one, a resume at `>`, nothing below the run's `fence`; a resume raises
  the fence (`fenceRun`); a run with no plan is superseded (`supersedeRun`, fence to the top); a
  journal append is refused under the fence; the lease is revoked by a newer attempt and taken only
  once it ran out. Every outcome a step reports is applied once per phase (`phases`). `tests/store.test.ts`, `tests/session.test.ts`, `tests/steps.test.ts` (with the real core) pin them.
- **Answers are checked three times**: by the gateway (swarm-shared), by the reducer or the child's
  wait in the object, by the core. A child's answer is routed only to a child that exists and still
  waits; a parked item is looked up in its own session only.
- **Workflow code replays.** A Workflow's `run()` is re-executed from its step results: every side
  effect is inside a named `step.do`, step names are deterministic (`phase k`, `settled <n>`,
  `write <point>`), results are small JSON strings. Renaming a step breaks instances in flight.
- **Only ids cross** into Workflows and events (1 MiB limits); big values stay in the object.
- **No AsyncLocalStorage, no I/O across requests**: an agent (and its MCP connections) per step.
- Shared logic belongs in `swarm-shared`, not here. The adapted copies above (and `planTurn` /
  `requestsOf` in `steps.ts`) are candidates to move there; when examples/swarm changes them, check
  these.
- A change the Worker needs in the core is made in `packages/agent` (and its browser sibling), with
  its tests - not worked around here.

## Commands

```bash
pnpm nx run-many -t typecheck format:check build test -p swarm-cloudflare
pnpm nx run swarm-cloudflare:test:e2e    # wrangler dev; a few minutes, run one file with
                                         # node --test e2e/<name>.test.ts from this directory
```

`build` writes `dist/` (gitignored) - the bundle a deploy would upload; it needs no network. The e2e
start `wrangler dev` with `--persist-to` a temporary directory and kill it (its process group) at the
end; a leftover `wrangler dev` holds memory - check `ps` after an interrupted run.
