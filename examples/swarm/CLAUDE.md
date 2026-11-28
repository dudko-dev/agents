# CLAUDE.md

> The workspace project `swarm` at `examples/swarm`. The root `CLAUDE.md` has the workspace commands
> and the shared rules; this file is about this project only. `README.md` is the user's guide (the
> architecture, the API, every env var).

## What it is

A reference deployment of `@dudko.dev/agent` as a swarm: a Temporal workflow per conversation
(`session`), one `agent.run` per turn as an activity (`runTurn`), turns that park (the core's
journal + parking), static subagents as child workflows (`subagent` -> `runSubagent`) and pipelines
as child workflows (`pipeline`, the core's graph engine as its scheduler, -> one `pipelineNode` per
node visit -> `runPipelineNode`) - children that park on a person too -, state in Postgres, a
stateless gateway with SSE (swarm-shared's fetch handler on `node:http`), one image with three
roles, a Helm chart. Its platform-independent part - the session's logic, ids and types, the answer
checks, the cursor, the HTTP API - is `swarm-shared` (`examples/swarm-shared`, its own
`CLAUDE.md`), which the swarm on other platforms will share. **Private, never published** (not in
`.github/scripts/release-plan.mjs`; keep it out). No version bumps, no CHANGELOG.

## Rules

- **Only the agent's public API** (`@dudko.dev/agent`, `workspace:*`, its `dist`). Nothing from
  `packages/agent/src`, no deep imports. A change the swarm needs in the core is made in
  `packages/agent` (and its browser sibling), with its tests - not worked around here.
- **The workflow is deterministic.** `src/workflows.ts` imports only `@temporalio/workflow`,
  `@dudko.dev/agent/pipeline-engine` (the core's graph engine: no imports, deterministic by
  contract - NEVER the main entry, `tests/bundle.test.ts` fails on it), `session-api.ts` (the
  Temporal names: workflow types, signals, queries, `PATCH_*`), `swarm-shared/workflow` (NEVER
  `swarm-shared` itself, whose HTTP API `tests/bundle.test.ts` keeps out of the bundle: its
  `session-state.ts`, `child-state.ts` and `pipeline-state.ts`, `answers.ts`, `session-ids.ts`, pure
  and importing nothing but each other) and types; no Node, no clock but the workflow's
  `Date.now()`, no randomness. The logic lives in swarm-shared (pure, unit-tested there); the
  workflow wires it - a change to it there is a change to what sessions replay here. A change that
  alters the commands a running session replays (activities scheduled, their order, timers, child
  workflows) needs `patched()` (ids in `session-api.ts`, `PATCH_*`) or a new workflow type -
  sessions live for days.
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
  `tests/integration/postgres.test.ts` fails without it). A run with no plan on record (the core
  writes the first snapshot, `onRunStart`, only after the planner answered) cannot be resumed: the
  activity SUPERSEDES it before it names the turn's next run (`supersedeRun`: the fence to the top,
  `SUPERSEDED_FENCE`, so no attempt of it writes again), in one statement that re-checks "no plan"
  under the row's lock - a plan that landed first is resumed instead (`runOne` plans again). That is
  what stops a worker that lost the turn BEFORE the first snapshot (paused, partitioned): its next
  append is refused, the core stops the run before its tool calls run
  (`tests/integration/zombie.test.ts`, SIGSTOP / SIGCONT). Security boundary: a change there needs
  a test and a mutation check.
- **Parking.** An "ask" of the approval mode parks (`onRequest: () => ({ park: true })`,
  `subagents.ts`); the activity records the items in `swarm_parked` (what the gateway checks an
  answer against - no worker needed) and returns `parked`. Answers are checked per kind in
  `answers.ts`, by the gateway AND by the workflow (`acceptAnswer`); an item a subagent answers
  takes no client answer. `planTurn`: a `waiting` snapshot without an answer for its items is
  reported as parked again (nothing runs).
- **Children park too** (`CHILD_ASK`, worker: `park` default | `deny`; `child-ask.ts`). A child's
  agent (`childAgentConfig`, `pipelineNodeConfig`) gets `onRequest: childAskDecision` under `park`
  (it parks only when the run's turn scope says `mayPark`, which the activity sets from the
  workflow's `park`, i.e. a child behind `PATCH_CHILD_PARKING`; else a denial), and NO `onRequest`
  under `deny` (the agent as it was). Its activity records the items under the SESSION
  (`swarm_parked.session_id`), in the PARENT's turn, owned by the child's workflow id (`owner_*`,
  `sql/003_child_parking.sql`); a child that may not wait records nothing and is refused as
  before. The child workflow waits on signals (`child-state.ts`: per-kind checks again, partial
  answers keep it waiting, a re-park waits again, a closed wait takes nothing), resumes the SAME
  run with `answers`, tells the session (`childParkSignal` -> `childPark`: the state's
  `parked.waiting`, `*.waiting` / `*.resumed` markers on the SAME counter as `*.ended`), and its
  `endTurn` closes what it still waited for (`closes`). The gateway signals the answer to the
  child directly - after looking the item up in THAT session and RECOMPUTING the child's workflow
  id from the request's session and the turn's own call (`childOwnerOf`, `childWorkflowIdOf`),
  never trusting the row. Security boundary: every guard (the row's session, the call's session,
  the recomputed id, the closed item, the workflow-side check, "every item answered") has a test
  and a mutation check.
- **Static subagents** (`SUBAGENTS`): the tool's `dispatch` only defers (within the caps of
  `ITurnInput.subagents`); the workflow starts one child per item (`startChildren`, ids from
  session + run + item), in a cancellation scope a stop cancels; a child's run and events are keyed
  by its stream (`<session>/<item>`), never the parent turn's slots; the parent's
  `subagent.started` / `.ended` markers (and `.waiting` / `.resumed` of a child that waits for a
  person) go in the parked attempt's slot at seq >= 2^30, written by the workflow in order, BEFORE
  the resumed attempt starts. Continue-as-new waits for running children (and waiting ones).
- **Pipelines** (`PIPELINES`, `pipelines.ts`): the tool defers like a subagent's (caps in
  `ITurnInput.pipelines`); the session starts a child `pipeline` per item (behind
  `PATCH_PIPELINES`; every start of a park, of both kinds, decided at once in `startChildren` -
  one marker counter, so the markers stay in order). `pipeline` reads its definition through an
  activity (`pipelineDefinition`), runs `runPipelineGraph` with `onAbort: 'reject'` and an abort
  latch on its cancellation scope, starts one child `pipelineNode` per visit (a wave in the same
  task), writes the engine's events through ONE `writeStream` at a time (`createStreamLog`: the
  batches depend only on the activations, so they replay), waits for its visits, then its
  `turn.ended`. `runPipelineNode`: the worker's node agent (checked equal to the planned node,
  `canonicalJson`) on `renderPipelineNodeInput`, then `pickPipelineRoute` in the same activity
  (heartbeats; a stop is `stopped`, a lost turn `TurnMoved`). Streams: the pipeline's
  `<session>/<item>`, a visit's `<session>/<item>/<node>/<visit>`. A node resolves against the
  worker (`pipelineNodeConfig`); anything it names that the worker cannot honour is a ConfigError
  at start.
- **Run ids**: a fresh run's id is named by the activity (`runIdOf(stream, turn, runNo)`,
  `agent.run({ runId })`); the lease takes only the run the activity named. A run that is on record
  is resumed (planTurn), never started again under its id; one that cannot be resumed is superseded
  (above) before the next `run_no` is named.
- **The cursor is `<turn>:<turn_attempt>:<seq>`**; `turn_attempt = attempt_base + attempt` so a
  turn that had to start a second run still has one total order. The turn markers use attempt `0`
  (`turn.started`) and `2147483647` (`turn.ended`).
- **Schema changes are a new `sql/NNN_name.sql`**: never edit an applied one (the runner refuses).
- Every new env var: `src/config.ts` / `src/agent-config.ts`, a test in `tests/config.test.ts`,
  the README's tables, `.env.example` and `compose.yaml` if the stack needs it.
- **The HTTP API is swarm-shared's** (`createGatewayHandler`): a route, a check or a limit is
  changed there, with its tests (no sockets); `src/gateway.ts` only adapts `node:http` to it. The
  adapter keeps what the handler cannot see: the body read from the socket only when a route reads
  it (a refused one ends the read, the socket kept for the 413), the response's close before it
  finished = the client gone (the request's signal, the body cancelled), 'drain' before the next
  chunk, `closeStreams()` on shutdown, and a 400 for a request fetch cannot represent.
- Imports with `.ts` extensions (type stripping); pnpm does not hoist - declare what you import.
  `swarm-shared` is imported from its built `dist` (`build` first; nx orders it).

## Layout

- `src/main.ts` — the role dispatch. `config.ts`, `env.ts`, `agent-config.ts` — the environment.
- `src/session-api.ts` (the Temporal names: workflow types, signals, queries, `PATCH_*`,
  `TURN_REFUSED`), `workflows.ts` (`session`, `subagent`, `pipeline`, `pipelineNode`) — the session
  on Temporal. Its logic, shapes and ids are swarm-shared's: `session-types.ts`, `session-ids.ts`,
  `session-state.ts`, `child-state.ts` (a child's wait for a person, the workflow side),
  `pipeline-state.ts` (the `pipeline` workflow's pure logic: the abort latch, the stream log, node
  input / output, outcomes), `answers.ts` (the answer checks per kind, gateway + workflows).
- `src/activities.ts` (`runTurn`, `runSubagent`, `pipelineDefinition`, `runPipelineNode`,
  `endTurn`, `writeMarkers`, `writeStream`, `planTurn`, `runIdOf`), `lease.ts` (the heartbeat
  lease, its fence and the turn scope), `subagents.ts` (SUBAGENTS: the tools, `dispatch`, the child
  and session agent configs), `child-ask.ts` (CHILD_ASK: a child agent's `onRequest`),
  `pipelines.ts` (PIPELINES: the tools, `dispatch`, the checks, a node's agent config),
  `worker.ts` (the worker and its agents - session, subagents, every pipeline node -, its health
  port, the SDK's logger). `log.ts` — swarm-shared's JSON logger on stdout.
- `src/gateway.ts` — swarm-shared's fetch handler (the routes, the checks, the stream: its
  `gateway.ts` / `http.ts`) behind a `node:http` <-> fetch adapter (the request body streamed on
  demand, a signal for a client gone, backpressure on the response body, `listen`);
  `backend.ts` (swarm-shared's `ISessionBackend` on Temporal + the session table),
  `gateway-main.ts` (the role: the backend, the `IEventFeed` of `db/events.ts` + `db/notify.ts`).
- `src/db/` — `pool.ts`, `migrate.ts`, `runs.ts` (snapshots, binding, fencing), `journal.ts` (the
  call journal, fenced), `parked.ts` (the parked items), `events.ts` (the log, the batching writer,
  the markers), `notify.ts` (the LISTEN fan-out), `limiter.ts`, `json.ts`.
- `sql/` — migrations. `scripts/bundle-workflows.ts` — `build`; `scripts/prune-image.ts` — the
  image's last build step (drops the bundler, other platforms' core-bridge binaries, `.d.ts`,
  maps; keeps anything reachable without the bundler).
- `Dockerfile` (+ `Dockerfile.dockerignore`, an allowlist: the build context is the repo root - a
  file of swarm-shared the build needs is listed there too; it builds the agent and swarm-shared,
  then the bundle, and `pnpm deploy` copies both packages' `dist` into `node_modules`; distroless
  runtime, uid 1000), `compose.yaml`, `.env.example`.
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
  tests kill a real worker process (`main.ts worker`, or `tests/integration/notes-worker.ts`: the
  same with a native write tool, so a test can count the writes); `zombie.test.ts` pauses one
  (SIGSTOP) instead and wakes it (SIGCONT) once the retry has finished the turn.

```bash
pnpm nx run-many -t typecheck format:check build test -p swarm,swarm-shared
DATABASE_URL=postgres://... pnpm nx run swarm:test:integration
docker build -f examples/swarm/Dockerfile .   # from the repo root
helm repo add temporal https://go.temporal.io/helm-charts   # once; the chart's dependency
helm dependency build examples/swarm/deploy/helm/agent-swarm && helm lint --strict examples/swarm/deploy/helm/agent-swarm
```

Workflows: `swarm.yml` (integration tests, the image without a push, the chart's lint / template /
kubeconform), `swarm-image.yml` (publishes the image: GHCR, Docker Hub when its secrets are set).
