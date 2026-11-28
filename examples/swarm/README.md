# Agent swarm: `@dudko.dev/agent` on Temporal + Postgres

A reference deployment of the Node agent ([`@dudko.dev/agent`](../../packages/agent)) as a
horizontally scaled swarm: any number of stateless gateways and workers, conversations that survive
a worker dying in the middle of a turn, one event stream per conversation that a client can leave
and rejoin, and limits shared by every worker. Self-hosted Temporal for the durable part, Postgres
for the state, no Redis, one image.

This is an **example**, not a package: private in the workspace, never published. Read it, run it,
copy what you need.

- [Architecture](#architecture)
- [Run it with Docker Compose](#run-it-with-docker-compose)
- [The HTTP API](#the-http-api)
- [What happens on a crash](#what-happens-on-a-crash)
- [Scaling](#scaling)
- [Configuration](#configuration) (every variable)
- [Security](#security)
- [Limits of this version](#limits-of-this-version)
- [Next steps](#next-steps): parking, the Helm chart, image publishing
- [Development and tests](#development-and-tests)

## Architecture

```
                 HTTPS (TLS at your load balancer)
  clients ─────────────────────────────────────────►  gateway  ×N   (stateless, node:http)
     ▲                                                  │    │
     │ SSE: replay after the cursor, then live          │    │ start / signal / query
     │                                                  │    ▼
     │                                     ┌────────────┼──  Temporal (a real cluster; the dev
     │                                     │            │    server in compose.yaml)
     │                                     │            │       │ workflow + activity tasks
     │                  SELECT … > cursor  │            │       ▼
     └──────────────  LISTEN swarm_events ─┤            │    worker  ×N
                                           ▼            │      ├─ workflow `session`  (one per conversation)
                                        Postgres ◄──────┘      └─ activity `runTurn` = one agent.run()
                                     sessions, run snapshots,       persistence  → swarm_runs
                                     events (+ NOTIFY), the         onEvent      → swarm_events + NOTIFY
                                     token bucket                   runLease     → the activity heartbeat
                                                                    sharedLimits → swarm_limiter (row lock)
```

**The durable unit is a session** (a conversation), and a session is a Temporal workflow,
`session-<id>`:

- an inbox of user messages (signal `message`), answers to a person's questions (signal `answer`)
  and `stop` (signal), and a query `state`;
- a loop: wait for a message → run ONE turn as an activity → append the exchange to the history →
  write the turn's `turn.ended` marker → wait again. Messages that arrive while a turn runs wait and
  become the next turn, together;
- continue-as-new when Temporal suggests it (the history is large) or after
  `SESSION_MAX_TURNS_PER_RUN` turns; the conversation is capped at `SESSION_HISTORY_MAX_CHARS` (the
  oldest exchanges go first; the agent's own compaction normally keeps it far below);
- no message for `SESSION_IDLE_TIMEOUT_MS`: the session ends.

The workflow is deterministic and small: its logic is plain functions in
[`src/session-state.ts`](src/session-state.ts), [`src/workflows.ts`](src/workflows.ts) wires them
to Temporal. Signals, not updates: the server accepts a signal while no worker runs, so the gateway
answers at once and a swarm scaled to zero still takes messages.

**A turn is one activity, `runTurn`, and one ordinary `agent.run({ input, history })`** on the
worker's agent (one per worker process, built from the environment), with the agent's scale-out
hooks pointed at Temporal and Postgres:

| Agent hook | Here | Where |
| --- | --- | --- |
| `persistence` | the run's snapshot, as JSONB, in `swarm_runs`; every write fenced by `attempt` | [`src/db/runs.ts`](src/db/runs.ts) |
| `onEvent` | every event in `swarm_events`, keyed `(session_id, run_id, attempt, seq)`, written in batches; a statement trigger sends `NOTIFY swarm_events, '<session>'` | [`src/db/events.ts`](src/db/events.ts) |
| `runLease` | the activity heartbeat. `acquire`: Temporal runs one attempt at a time, so it only binds the run to its turn; `renew` = `heartbeat()`, false once Temporal says the turn is not this worker's (heartbeat timed out, worker shutdown, reset, paused, not found) | [`src/lease.ts`](src/lease.ts) |
| `sharedLimits` | a token bucket in `swarm_limiter`, taken under a row lock by the database's clock; a wait beyond `LIMITER_MAX_WAIT_MS` is a refusal | [`src/db/limiter.ts`](src/db/limiter.ts) |
| a stop | the session cancels the activity; the activity aborts the run, which records `cancelled` | [`src/activities.ts`](src/activities.ts) |

The activity's result is a discriminated union (`completed | stopped | parked`, see
[`src/session-types.ts`](src/session-types.ts)); a failure is an exception, retried by Temporal
(`TURN_MAX_ATTEMPTS`) unless it is a refusal (a limit, refused credentials), which fails the turn at
once.

**The gateway** is the clients' only door: HTTP on `node:http`, no framework, any number of
replicas. Sessions live in Temporal, events in Postgres; it holds nothing a restart would lose.

**Postgres** holds four tables (`sql/001_init.sql`): `swarm_sessions` (the sessions the gateway
started), `swarm_runs` (run snapshots, bound to their turn), `swarm_events` (the event log) and
`swarm_limiter` (the bucket). The `migrate` role applies `sql/*.sql` once, in order, in one
transaction under an advisory lock, and refuses a migration that was edited after it was applied.

**One image, the role is the argument:** `gateway` | `worker` | `migrate`.

## Run it with Docker Compose

You need Docker with Compose v2 and an API key of a provider this image installs (OpenAI,
Anthropic, Google, or any OpenAI-compatible server).

```bash
cd examples/swarm
cp .env.example .env          # set GATEWAY_TOKENS and AGENT_API_KEY / AGENT_MODEL; never commit .env
docker compose up --build --scale worker=3
```

`compose.yaml` starts Postgres 17, the Temporal dev server (`temporalio/temporal`,
`server start-dev --ip 0.0.0.0`, UI on <http://localhost:8233>), `migrate` (one shot), then the
gateway (<http://localhost:8080>) and the workers - each waiting for what it needs (healthchecks,
`depends_on` conditions). The swarm's containers run as `node`, on a read-only root filesystem with
only `/tmp` writable, all capabilities dropped.

The dev server keeps everything in memory and is for trying the swarm out. **Production uses a real
Temporal cluster** (self-hosted with its own persistence, or Temporal Cloud): point
`TEMPORAL_ADDRESS` (and the `TEMPORAL_TLS_*` / `TEMPORAL_API_KEY` variables) at it.

Talk to it:

```bash
TOKEN=...   # one of GATEWAY_TOKENS
S=$(curl -s -X POST localhost:8080/sessions -H "authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' -d '{"message":"What is 2+2?"}' | jq -r .sessionId)
curl -N localhost:8080/sessions/$S/events -H "authorization: Bearer $TOKEN"     # the stream
curl -s -X POST localhost:8080/sessions/$S/messages -H "authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' -d '{"text":"And times 3?"}'
curl -s localhost:8080/sessions/$S -H "authorization: Bearer $TOKEN" | jq .        # the state
```

Kill a worker while a turn runs (`docker kill agent-swarm-worker-1`) and watch the stream: the turn
goes on on another worker, from its last checkpoint, under attempt 2.

## The HTTP API

Every route but `/healthz` and `/readyz` needs `Authorization: Bearer <token>`. Bodies are JSON
(`content-type: application/json`), at most `GATEWAY_MAX_BODY_BYTES`. Errors are
`{ "error": { "code", "message" } }`.

| Route | Body | Answer |
| --- | --- | --- |
| `POST /sessions` | optional `{ "message": "...", "id"?: "..." }` (the first message) | `201 { sessionId, messageId? }`, `Location: /sessions/<id>` |
| `POST /sessions/:id/messages` | `{ "text": "...", "id"?: "..." }` | `202 { messageId }`. `id` (`[A-Za-z0-9_-]{1,64}`) makes a retried POST harmless: the session drops a repeat |
| `POST /sessions/:id/answers/:requestId` | any JSON object (the answer) | `202 { requestId }` - see [Parking](#parking) |
| `POST /sessions/:id/stop` | optional `{ "end": true }` | `202`. Stops the running turn and drops the messages queued behind it; `end` also ends the session |
| `GET /sessions/:id` | | `200` the state: `status` (`idle` / `running` / `stopping` / `parked` / `ended`), `turn`, `running`, `queued`, `dropped`, `parked`, `history`, `turns` (the last 20: status, run id, attempt, text or error, usage) |
| `GET /sessions/:id/events?after=<cursor>` | | `text/event-stream` (below) |
| `GET /healthz` | | `200` while the process runs |
| `GET /readyz` | | `200` when Postgres, Temporal and the LISTEN connection answer, else `503` with `checks` |

Status codes: `400` (a bad body, id or cursor), `401` (no or a wrong token), `404` (no such route or
session), `405`, `409` (`session_ended`), `413` (a body or message too long), `415`, `503` (Temporal
or Postgres down, too many streams - with `Retry-After`).

### The event stream

```
id: 3:1:17
data: {"cursor":"3:1:17","turn":3,"event":{"type":"step.tool-call","runId":"…","attempt":1,"seq":17,…}}
```

Every [event of the agent](../../packages/agent/README.md#streaming-events), in order, plus two
markers per turn: `turn.started` (`input`, `messageIds`) first and `turn.ended` (`status`:
`completed` / `stopped` / `failed`, `text`, `error`, `runId`, `attempt`, `usage`) last.

The stream replays from Postgres everything after the cursor, then goes live (`LISTEN/NOTIFY`, no
polling). The cursor is `<turn>:<attempt>:<seq>` - a session is many runs, one per turn, so the turn
comes first, then the core's own `(attempt, seq)`. Treat it as opaque: send back the last `id:` you
saw, as `?after=` or as `Last-Event-ID` (which an `EventSource` sends by itself on a reconnect, and
which wins over `after`). Without one, the stream starts at the session's beginning.

`attempt` here is the turn's attempt. It is the run's own attempt, unless a worker died before the
run's first snapshot (during planning: there is nothing to resume, so the turn starts a second run);
the second run's attempts then count on from the first run's, so the order stays total.

Delivery is **at-least-once**: the step a crash interrupted runs again under the next attempt, and
its events come again with the new attempt's numbers (a late event of a dead attempt sorts before
the attempt that replaced it). A client that dedupes keeps the last attempt's copy of a step.
An event larger than `EVENT_MAX_BYTES` (a huge tool output) is stored as a stub
`{ type, runId, seq, attempt, truncated: true, bytes }`; the full result is in the snapshot.

## What happens on a crash

- **A worker dies** (SIGKILL, OOM, the node goes away). Its turn's heartbeat stops;
  after `TURN_HEARTBEAT_TIMEOUT_MS` Temporal retries the activity on another worker. The retry looks
  the run up by (session, turn) in `swarm_runs` and resumes it (`resumeFromRunId`) from its last
  checkpoint, as attempt + 1 - the core records the new attempt before it emits anything. Steps that
  finished are not run again; the step in flight is (design tools to be idempotent - the core's
  [resume caveats](../../packages/agent/README.md#resume-after-crash) apply). The session workflow
  itself is replayed by Temporal on any worker.
- **A worker is stopped** (SIGTERM: a deploy, a scale-down). It stops polling and gives the running
  turns `WORKER_SHUTDOWN_GRACE_MS` to finish; then they are cancelled, the lease is lost (no more
  writes), and Temporal retries them elsewhere at once. Give the container longer than the grace
  (`stop_grace_period`, `terminationGracePeriodSeconds`).
- **A worker that does not know it lost the turn** (a paused process, a partition): its late
  snapshot writes are refused - a checkpoint may not go below the attempt on record, a resume must go
  above it - and its late events sort before the new attempt's.
- **The run itself fails** (a provider outage that outlasts the agent's own retries): the activity
  fails and Temporal retries the turn with backoff, resuming from the last checkpoint, up to
  `TURN_MAX_ATTEMPTS`; then the turn is `failed` and the session waits for the next message. A
  refusal (`sharedLimits`, a 401 / 403) fails the turn at once.
- **The result was lost** (the run completed, the worker died before reporting it): the retry finds
  the `complete` snapshot and returns its answer without running anything.
- **A gateway dies**: nothing is lost. Its streams' clients reconnect to another replica with
  `Last-Event-ID`.
- **Postgres is down**: turns fail and retry; snapshot writes are logged and the run goes on (the
  core's persistence is fail-open, except the resume record); events are retried, then dropped with
  a log.

## Scaling

- **Workers**: more replicas (`--scale worker=N`, `deploy.replicas`, an HPA later). Each runs up to
  `WORKER_MAX_CONCURRENT_TURNS` turns at once on one agent. Workers are interchangeable: any of them
  takes any session's next turn.
- **Gateways**: more replicas behind a load balancer; no affinity needed, SSE included. Each holds one
  LISTEN connection and a pool.
- **Postgres**: connections = replicas × `PG_POOL_MAX` (+1 LISTEN per gateway). Events are the big
  table: prune it (`DELETE FROM swarm_events WHERE created_at < now() - interval '30 days'`; there is
  an index for it) - nothing prunes it for you.
- **The limiter** is one row per bucket: every model call of the swarm takes that row's lock for a
  short transaction. `LIMITER_SCOPE=model` gives each provider + model its own bucket.
- **Temporal**: one task queue (`TEMPORAL_TASK_QUEUE`); heavier deployments split queues or
  partitions on the Temporal side.

## Configuration

Everything comes from the environment. A secret can come from a file instead: `<NAME>_FILE` (what
Docker and Kubernetes secrets mount) for `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `GATEWAY_TOKENS`,
`AGENT_API_KEY`, `TEMPORAL_API_KEY` - never both. A bad value stops the process at start with the
variable's name.

**Every role**

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | - (required) | Postgres connection string (`sslmode` etc. as `pg` reads it) |
| `PG_POOL_MAX` | `10` | Connections per process |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`; one JSON line per entry on stdout |

**Temporal** (gateway and worker)

| Variable | Default | |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | `localhost:7233` | The frontend |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_TASK_QUEUE` | `swarm` | The gateway starts sessions on it, the workers poll it |
| `TEMPORAL_TLS` | off (on when a CA, a client certificate or an API key is set) | `on` / `off` |
| `TEMPORAL_TLS_CA_PATH` | - | The server's CA (a file) |
| `TEMPORAL_TLS_CERT_PATH`, `TEMPORAL_TLS_KEY_PATH` | - | mTLS: the client certificate and key (files; both or neither) |
| `TEMPORAL_TLS_SERVER_NAME` | - | SNI override |
| `TEMPORAL_API_KEY` | - | An API key (Temporal Cloud) |

**`migrate`**

| Variable | Default | |
| --- | --- | --- |
| `MIGRATE_DATABASE_URL` | `DATABASE_URL` | A role that may change the schema; the gateway and the workers need only `SELECT` / `INSERT` / `UPDATE` on the four tables |

**`gateway`**

| Variable | Default | |
| --- | --- | --- |
| `GATEWAY_HOST` / `GATEWAY_PORT` | `0.0.0.0` / `8080` | |
| `GATEWAY_AUTH` | `bearer` | `none` turns auth off - for a local try only |
| `GATEWAY_TOKENS` | - (required with `bearer`) | Bearer tokens, comma separated (several: rotation), 16+ characters each |
| `CORS_ORIGINS` | none | Allowed browser origins, comma separated (exact), or `*` |
| `GATEWAY_MAX_BODY_BYTES` | `65536` | Request body cap |
| `MESSAGE_MAX_CHARS` | `32000` | One message's cap |
| `SSE_MAX_CONNECTIONS` | `1000` | Open event streams per gateway (more: `503`) |
| `SSE_KEEPALIVE_MS` | `15000` | A comment line on an idle stream, for proxies |
| `SSE_BATCH` | `500` | Rows per replay query |

The session's options are read by the gateway and **fixed when a session starts** (they are the
workflow's input, so a running session never depends on a worker's environment):

| Variable | Default | |
| --- | --- | --- |
| `SESSION_IDLE_TIMEOUT_MS` | `86400000` (a day) | No message for this long ends the session; `0` never |
| `TURN_TIMEOUT_MS` | `1800000` | One attempt of a turn |
| `TURN_HEARTBEAT_TIMEOUT_MS` | `20000` | A worker silent for this long has lost the turn. Keep it well above `LEASE_TTL_MS / 3` |
| `TURN_MAX_ATTEMPTS` | `5` | Attempts of one turn |
| `SESSION_MAX_TURNS_PER_RUN` | `100` | Turns per workflow run before continue-as-new |
| `SESSION_HISTORY_MAX_CHARS` | `200000` | The conversation the workflow carries |
| `SESSION_MAX_QUEUED_MESSAGES` | `50` | Messages waiting behind a turn; more are dropped (counted in `dropped`) |

**`worker`**

| Variable | Default | |
| --- | --- | --- |
| `WORKER_IDENTITY` | `<hostname>-<pid>` | In Temporal and in each snapshot's `lease_owner` |
| `WORKER_MAX_CONCURRENT_TURNS` | `10` | Turns at once on this worker |
| `WORKER_SHUTDOWN_GRACE_MS` | `30000` | What SIGTERM gives the running turns |
| `WORKER_HEARTBEAT_THROTTLE_MS` | `1000` | The longest gap between two heartbeats the SDK sends (a stop reaches a turn on one) |
| `WORKER_HEALTH_PORT` | `8081` | `/healthz` (not failed) and `/readyz` (polling); `0` off |
| `WORKFLOW_BUNDLE_PATH` | `dist/workflow-bundle.js` when present | The prebuilt workflow bundle (`build`); without one the worker bundles `src/workflows.ts` at start |
| `LEASE_TTL_MS` | `15000` | The agent's `runLease.ttlMs`: it renews - heartbeats - every third of it |
| `EVENT_MAX_BYTES` | `262144` | One stored event's cap |
| `LIMITER_REFILL_PER_SECOND` | - (off) | The shared bucket: tokens (model calls) per second |
| `LIMITER_CAPACITY` | the refill, at least 1 | The burst |
| `LIMITER_MAX_WAIT_MS` | `60000` | A call that would wait longer is refused (`0`: never wait) |
| `LIMITER_SCOPE` | `global` | `global` (one bucket) or `model` (one per provider + model) |

The agent (worker): a subset of the [`dd-agent` CLI's variables](../../packages/agent/README.md#cli),
under the same names - for anything else, build the `IAgentConfig` in code
([`src/agent-config.ts`](src/agent-config.ts)):

| Variable | Default | |
| --- | --- | --- |
| `AGENT_PROVIDER_TYPE` | `openai` | `openai` / `anthropic` / `google` / `openai-compatible` (the SDKs installed; add another `@ai-sdk/*` package to `package.json` for more) |
| `AGENT_API_KEY` | - (required) | |
| `AGENT_MODEL` | - (required) | |
| `AGENT_BASE_URL` | - | Required for `openai-compatible` |
| `AGENT_PROVIDER_OPTIONS` | - | JSON, passed to the provider's factory |
| `AGENT_PLANNER_MODEL`, `AGENT_SYNTHESIZER_MODEL` | - | Other models for those stages |
| `MCP_SERVERS` | - | JSON: `{"name": {"url": "...", "headers": {...}}}` or `{"name": {"command": "...", "args": [...]}}` |
| `AGENT_TOOL_APPROVAL` | `autopilot` | `autopilot` / `read-only` / `ask-writes` / `ask-all` - until [parking](#parking), an "ask" has nobody to answer it and is a denial |
| `AGENT_TOOL_RULES` | - | JSON: `{"github__delete_*": "deny"}` |
| `AGENT_MAX_ITERATIONS` / `AGENT_MAX_STEPS_PER_TASK` | `10` / `8` | |
| `AGENT_MAX_REVISIONS`, `AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_TOTAL_TOKENS` | the agent's | Per-run caps |
| `AGENT_LLM_TIMEOUT_MS`, `AGENT_LLM_MAX_RETRIES` | the agent's | |
| `AGENT_COMPACTION` / `AGENT_CONTEXT_WINDOW_TOKENS` | `on` / the agent's | |
| `AGENT_SYSTEM_PROMPT` | - | |
| `AGENT_CLIENT_NAME` | `swarm` | |
| `AGENT_LOG_LEVEL` | `warn` | The agent's `logLevel`; its warnings and errors go to the process log |

## Security

- **The gateway's bearer token** is checked in constant time (SHA-256 digests, every token compared)
  and must be 16+ characters; give several for rotation. It is one shared secret for the whole API:
  whoever holds it can start, steer and read **any** session (session ids are random UUIDs, not
  authorization). Put your own authentication and tenancy in front, or in the gateway, before
  serving several users.
- **TLS**: the gateway speaks plain HTTP. Terminate TLS in front of it (ingress, load balancer) and
  do not expose it otherwise; compose publishes it on `127.0.0.1` only.
- **No secrets in the image.** The build context is an allowlist (`Dockerfile.dockerignore`: no
  `node_modules`, no `dist`, no `.env`); keys, tokens and the database URL come from the environment
  or `*_FILE` at run time. In compose the gateway gets only `GATEWAY_TOKENS`, never a provider key;
  the workers get `.env`. `.env` is gitignored - never commit it.
- **The container**: runs as `node` (uid 1000), the code owned by root, a read-only root filesystem
  (only `/tmp` writable), all capabilities dropped, `no-new-privileges`.
- **Requests** are bounded: body size (checked by `Content-Length` and while streaming), message
  length, ids by pattern, the cursor's format and size, the number of open streams, header and
  request timeouts. CORS allows only the listed origins and never credentials.
- **The data at rest is the conversation.** `swarm_events` holds everything the agent emitted (tool
  inputs and outputs included) and `swarm_runs` the snapshots; Temporal's history holds the messages
  and the conversation (workflow inputs and activity results). Protect both stores (access, backups,
  encryption at rest); there is no payload codec in this version.
- Errors answered to clients carry no internals (a `500` is just `internal error`); the details are
  in the log.

## Limits of this version

- **Interactive OAuth for MCP servers does not work across pods.** The authorization redirect comes
  back to one replica, and the token store is per process. Use servers with static headers, the
  non-interactive [enterprise-managed authorization](../../packages/agent/README.md#mcp-with-enterprise-managed-authorization-id-jag),
  or tokens provisioned ahead of time.
- **Sandbox files do not move.** A run's sandbox directory lives in the `/tmp` of the worker that ran
  it; a run resumed on another worker starts with an empty one.
- **No parking yet**: a turn cannot stop on a person's question and wait. Tool approval comes from
  `AGENT_TOOL_APPROVAL` (default `autopilot`); an "ask" is a denial. See [Parking](#parking).
- **No steering inside a turn**: a message sent while a turn runs waits for the next turn (the
  agent's `RunControl.send` is not wired to the session yet). Stop is.
- **MCP elicitation** (a server asking the user mid-call) is not answered: no `onElicitation`.
- Tool calls of a step a crash interrupted run again (at-least-once; see the core's caveats).
- Events are never pruned for you; Temporal payloads are not encrypted.

## Next steps

### Parking

Parking - stopping a turn on a person's question and resuming it with the answer - arrives in the
core (a parallel change). The swarm is shaped for it already:

- the activity's result union has `{ status: 'parked', runId, attempt, requests }`;
- the workflow handles it: the turn is recorded as `parked`, the state query shows the open requests
  and which are answered, new messages wait behind it, `stop` ends it as stopped, and once every
  request has an answer (signal `answer`, `POST /sessions/:id/answers/:requestId`) the SAME turn
  goes on with `ITurnInput.answers` (tested in `tests/session-state.test.ts`);
- what is left is the activity's side: let `toolApproval.onRequest` (and MCP elicitation) park the
  run through the core's API, return `parked`, and resume the run with the answers.

### The Helm chart and image publishing

The next pull request. The image is ready for both: the role is the argument; configuration is the
environment, secrets can be files (`*_FILE`); `/healthz` and `/readyz` on 8080 (gateway) and 8081
(worker) for the probes; `migrate` is a one-shot (a Job or a pre-install hook); SIGTERM drains; a
read-only root filesystem with an `emptyDir` on `/tmp`; no secret in the image.

## Development and tests

This is the workspace project `swarm` (`examples/swarm`). Its source is TypeScript run directly by
Node (type stripping); `build` only bundles the workflow code (`dist/workflow-bundle.js`).

```bash
pnpm nx run-many -t typecheck format:check build test -p swarm   # unit tests: nothing external
DATABASE_URL=postgres://swarm:swarm@localhost:5432/swarm pnpm nx run swarm:test:integration
```

- **Unit tests** (`tests/*.test.ts`): the session logic, the gateway over loopback with fakes
  (routing, auth, CORS, bounds, the stream), the cursor, the limiter's math and loop, the SQL builders
  and the event writer, the lease, the activity in Temporal's `MockActivityEnvironment`, the config.
- **Integration tests** (`tests/integration/*.test.ts`) need a **Postgres** (`DATABASE_URL`; they
  migrate it) and start a **Temporal dev server** with `@temporalio/testing` (downloaded once from
  temporal.download; or set `TEMPORAL_CLI_PATH` to a `temporal` binary). The model is the agent
  package's scripted OpenAI-compatible server - no provider, no key. They cover a session end to end
  over SSE, ordering and replay from a cursor, continue-as-new and the idle end, a worker process
  killed mid-turn and the turn finished by another under attempt 2, stop and end, the limiter
  delaying and refusing (alone and inside a turn), snapshot fencing, the event log and its NOTIFY.
  `SWARM_TEST_VERBOSE=1` shows the child workers' output.
- CI: [`.github/workflows/swarm.yml`](../../.github/workflows/swarm.yml) runs both against a
  Postgres service, builds the image (no push) and smoke-tests it.
