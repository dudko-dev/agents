# CLAUDE.md

> The workspace project `swarm` at `examples/swarm`. The root `CLAUDE.md` has the workspace commands
> and the shared rules; this file is about this project only. `README.md` is the user's guide (the
> architecture, the API, every env var).

## What it is

A reference deployment of `@dudko.dev/agent` as a swarm: a Temporal workflow per conversation
(`session`), one `agent.run` per turn as an activity (`runTurn`), turns that park (the core's
journal + parking) and static subagents as child workflows (`subagent` -> `runSubagent`), state in
Postgres, a stateless `node:http` gateway with SSE, one image with three roles, a Helm chart.
**Private, never published** (not in `.github/scripts/release-plan.mjs`; keep it out). No version
bumps, no CHANGELOG.

## Rules

- **Only the agent's public API** (`@dudko.dev/agent`, `workspace:*`, its `dist`). Nothing from
  `packages/agent/src`, no deep imports. A change the swarm needs in the core is made in
  `packages/agent` (and its browser sibling), with its tests - not worked around here.
- **The workflow is deterministic.** `src/workflows.ts` imports only `@temporalio/workflow`,
  `session-api.ts`, `session-state.ts` (which imports `answers.ts`, pure and import-free) and
  types; no Node, no clock but the workflow's `Date.now()`, no randomness. The logic lives in
  `session-state.ts` (pure, unit-tested); the workflow wires it. A change that alters the commands
  a running session replays (activities scheduled, their order, timers, child workflows) needs
  `patched()` (ids in `session-api.ts`, `PATCH_*`) or a new workflow type - sessions live for days.
  `tests/replay.test.ts` replays recorded histories (`tests/fixtures/*.history.json`) on the
  current code: a change that breaks one is a replay break. Record a new fixture for a new path.
- **Session options are workflow input** (`ISessionOptions`, read by the gateway at start), never
  read from a worker's env inside the workflow.
- **The lease is the heartbeat.** A user's stop aborts the run (it records `cancelled`); anything
  Temporal says about the activity (timed out, shutdown, reset, paused, not found) is a lost lease
  (`revokedReason`): the core aborts and writes nothing more, the activity throws retryable.
  Snapshot writes are fenced by attempt (`<=` a checkpoint, `<` a resume) - keep both - and by the
  run's `fence` (raised by a resume's acquire, `fenceRun`): from then on an older attempt writes
  nothing. Journal appends are fenced the same way in ONE statement that takes the run's row
  `FOR SHARE` (so the fence waits for appends that read the old one; the race test in
  `tests/integration/postgres.test.ts` fails without it). Security boundary: a change there needs a
  test and a mutation check.
- **Parking.** An "ask" of the approval mode parks (`onRequest: () => ({ park: true })`,
  `subagents.ts`); the activity records the items in `swarm_parked` (what the gateway checks an
  answer against - no worker needed) and returns `parked`. Answers are checked per kind in
  `answers.ts`, by the gateway AND by the workflow (`acceptAnswer`); an item a subagent answers
  takes no client answer. `planTurn`: a `waiting` snapshot without an answer for its items is
  reported as parked again (nothing runs).
- **Static subagents** (`SUBAGENTS`): the tool's `dispatch` only defers (within the caps of
  `ITurnInput.subagents`); the workflow starts one child per item (`startChildren`, ids from
  session + run + item), in a cancellation scope a stop cancels; a child's run and events are keyed
  by its stream (`<session>/<item>`), never the parent turn's slots; the parent's
  `subagent.started` / `.ended` markers go in the parked attempt's slot at seq >= 2^30, written by
  the workflow in order, BEFORE the resumed attempt starts. Continue-as-new waits for running
  children.
- **The cursor is `<turn>:<turn_attempt>:<seq>`**; `turn_attempt = attempt_base + attempt` so a
  turn that had to start a second run still has one total order. The turn markers use attempt `0`
  (`turn.started`) and `2147483647` (`turn.ended`).
- **Schema changes are a new `sql/NNN_name.sql`**: never edit an applied one (the runner refuses).
- Every new env var: `src/config.ts` / `src/agent-config.ts`, a test in `tests/config.test.ts`,
  the README's tables, `.env.example` and `compose.yaml` if the stack needs it.
- Imports with `.ts` extensions (type stripping); pnpm does not hoist - declare what you import.

## Layout

- `src/main.ts` — the role dispatch. `config.ts`, `env.ts`, `agent-config.ts` — the environment.
- `src/session-types.ts`, `session-api.ts`, `session-state.ts`, `workflows.ts` (`session`,
  `subagent`) — the session; `answers.ts` — the answer checks per kind (gateway + workflow).
- `src/activities.ts` (`runTurn`, `runSubagent`, `endTurn`, `writeMarkers`, `planTurn`),
  `lease.ts` (the heartbeat lease, its fence and the turn scope), `subagents.ts` (SUBAGENTS: the
  tools, `dispatch`, the child and session agent configs), `worker.ts` (the worker and its agents,
  its health port, the SDK's logger).
- `src/gateway.ts` (routes, the stream), `http.ts` (bodies, auth, CORS), `backend.ts` (Temporal
  + the session table), `gateway-main.ts`, `cursor.ts`.
- `src/db/` — `pool.ts`, `migrate.ts`, `runs.ts` (snapshots, binding, fencing), `journal.ts` (the
  call journal, fenced), `parked.ts` (the parked items), `events.ts` (the log, the batching writer,
  the markers), `notify.ts` (the LISTEN fan-out), `limiter.ts`, `json.ts`.
- `sql/` — migrations. `scripts/bundle-workflows.ts` — `build`; `scripts/prune-image.ts` — the
  image's last build step (drops the bundler, other platforms' core-bridge binaries, `.d.ts`,
  maps; keeps anything reachable without the bundler).
- `Dockerfile` (+ `Dockerfile.dockerignore`, an allowlist: the build context is the repo root;
  distroless runtime, uid 1000), `compose.yaml`, `.env.example`.
- `deploy/helm/agent-swarm` — the Helm chart (its README has every value; `values.schema.json`
  guards them; `ci/all-on-values.yaml` renders every flag). A new env var the chart should set goes
  in `templates/configmap.yaml` and `values.yaml` + schema (`tests/chart.test.ts` fails on a
  variable the app does not read). `Chart.lock` pins the Temporal chart; `charts/` is not committed.

## Tests

- `tests/*.test.ts` (`test`, in `pnpm check` and `ci.yml`): nothing external - loopback sockets,
  fakes, Temporal's `MockActivityEnvironment`, a local replay of recorded histories. Must pass on
  Node 22, 24 and 26.
- `tests/integration/*.test.ts` (`test:integration`, `swarm.yml`): a real Postgres (`DATABASE_URL`)
  and a Temporal dev server (`@temporalio/testing` `createLocal()`, or `TEMPORAL_CLI_PATH`); the
  model is `packages/agent/tests/helpers/openai-server.ts`, imported by relative path. The crash
  test kills a real worker process (`main.ts worker`).

```bash
pnpm nx run-many -t typecheck format:check build test -p swarm
DATABASE_URL=postgres://... pnpm nx run swarm:test:integration
docker build -f examples/swarm/Dockerfile .   # from the repo root
helm repo add temporal https://go.temporal.io/helm-charts   # once; the chart's dependency
helm dependency build examples/swarm/deploy/helm/agent-swarm && helm lint --strict examples/swarm/deploy/helm/agent-swarm
```

Workflows: `swarm.yml` (integration tests, the image without a push, the chart's lint / template /
kubeconform), `swarm-image.yml` (publishes the image: GHCR, Docker Hub when its secrets are set).
