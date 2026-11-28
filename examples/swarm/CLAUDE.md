# CLAUDE.md

> The workspace project `swarm` at `examples/swarm`. The root `CLAUDE.md` has the workspace commands
> and the shared rules; this file is about this project only. `README.md` is the user's guide (the
> architecture, the API, every env var).

## What it is

A reference deployment of `@dudko.dev/agent` as a swarm: a Temporal workflow per conversation
(`session`), one `agent.run` per turn as an activity (`runTurn`), state in Postgres, a stateless
`node:http` gateway with SSE, one image with three roles. **Private, never published** (not in
`.github/scripts/release-plan.mjs`; keep it out). No version bumps, no CHANGELOG.

## Rules

- **Only the agent's public API** (`@dudko.dev/agent`, `workspace:*`, its `dist`). Nothing from
  `packages/agent/src`, no deep imports. A change the swarm needs in the core is made in
  `packages/agent` (and its browser sibling), with its tests - not worked around here.
- **The workflow is deterministic.** `src/workflows.ts` imports only `@temporalio/workflow`,
  `session-api.ts`, `session-state.ts` and types; no Node, no clock but the workflow's `Date.now()`,
  no randomness. The logic lives in `session-state.ts` (pure, unit-tested); the workflow wires it.
  A change that alters the commands a running session replays (activities scheduled, their order,
  timers) needs `patched()` or a new workflow type - sessions live for days.
- **Session options are workflow input** (`ISessionOptions`, read by the gateway at start), never
  read from a worker's env inside the workflow.
- **The lease is the heartbeat.** A user's stop aborts the run (it records `cancelled`); anything
  Temporal says about the activity (timed out, shutdown, reset, paused, not found) is a lost lease
  (`revokedReason`): the core aborts and writes nothing more, the activity throws retryable.
  Snapshot writes are fenced by attempt (`<=` a checkpoint, `<` a resume) - keep both.
- **The cursor is `<turn>:<turn_attempt>:<seq>`**; `turn_attempt = attempt_base + attempt` so a
  turn that had to start a second run still has one total order. The turn markers use attempt `0`
  (`turn.started`) and `2147483647` (`turn.ended`).
- **Schema changes are a new `sql/NNN_name.sql`**: never edit an applied one (the runner refuses).
- Every new env var: `src/config.ts` / `src/agent-config.ts`, a test in `tests/config.test.ts`,
  the README's tables, `.env.example` and `compose.yaml` if the stack needs it.
- Imports with `.ts` extensions (type stripping); pnpm does not hoist - declare what you import.

## Layout

- `src/main.ts` — the role dispatch. `config.ts`, `env.ts`, `agent-config.ts` — the environment.
- `src/session-types.ts`, `session-api.ts`, `session-state.ts`, `workflows.ts` — the session.
- `src/activities.ts` (`runTurn`, `endTurn`, `planTurn`), `lease.ts` (the heartbeat lease and the
  turn scope), `worker.ts` (the worker, its health port, the SDK's logger).
- `src/gateway.ts` (routes, the stream), `http.ts` (bodies, auth, CORS), `backend.ts` (Temporal
  + the session table), `gateway-main.ts`, `cursor.ts`.
- `src/db/` — `pool.ts`, `migrate.ts`, `runs.ts` (snapshots, binding, fencing), `events.ts` (the
  log, the batching writer, the markers), `notify.ts` (the LISTEN fan-out), `limiter.ts`, `json.ts`.
- `sql/` — migrations. `scripts/bundle-workflows.ts` — `build`.
- `Dockerfile` (+ `Dockerfile.dockerignore`, an allowlist: the build context is the repo root),
  `compose.yaml`, `.env.example`.

## Tests

- `tests/*.test.ts` (`test`, in `pnpm check` and `ci.yml`): nothing external - loopback sockets,
  fakes, Temporal's `MockActivityEnvironment`. Must pass on Node 22, 24 and 26.
- `tests/integration/*.test.ts` (`test:integration`, `swarm.yml`): a real Postgres (`DATABASE_URL`)
  and a Temporal dev server (`@temporalio/testing` `createLocal()`, or `TEMPORAL_CLI_PATH`); the
  model is `packages/agent/tests/helpers/openai-server.ts`, imported by relative path. The crash
  test kills a real worker process (`main.ts worker`).

```bash
pnpm nx run-many -t typecheck format:check build test -p swarm
DATABASE_URL=postgres://... pnpm nx run swarm:test:integration
docker build -f examples/swarm/Dockerfile .   # from the repo root
```
