# Agent swarm on Cloudflare: `@dudko.dev/agent` on Durable Objects + Workflows

The agent swarm of [`examples/swarm`](../swarm) - the same HTTP API, the same session semantics -
built on Cloudflare's own primitives instead of Temporal + Postgres: a **Durable Object per
session** (its state, its event log, its runs, its call journal, its parked items and children)
and a **Workflow instance per turn and per child** (a static subagent call, a pipeline call, a
pipeline node visit), with the Node core [`@dudko.dev/agent`](../../packages/agent) running in
workerd under `nodejs_compat`. One Worker; nothing else to run.

This is an **example**, not a package: private in the workspace, never published. Its
platform-independent part - the session reducer, the answer checks, the ids, the cursor and the
HTTP API itself - is [`swarm-shared`](../swarm-shared), the same code the Temporal swarm runs.

- [Architecture](#architecture)
- [What replaces Temporal and Postgres](#what-replaces-temporal-and-postgres) (the mapping table)
- [The HTTP API](#the-http-api)
- [Turns, parking, children, pipelines](#turns-parking-children-pipelines)
- [What happens on a crash](#what-happens-on-a-crash)
- [Limits, and what is not supported](#limits-and-what-is-not-supported)
- [Configuration](#configuration)
- [Run it locally](#run-it-locally)
- [Deploying](#deploying) (the owner's commands)
- [Security](#security)
- [Development and tests](#development-and-tests)

## Architecture

```
                HTTPS
  clients ──────────────►  Worker  (fetch: swarm-shared's createGatewayHandler)
     ▲                       │   │ every route but the streams: RPC to the session's object
     │ SSE (forwarded to     │   │ a stream: the bearer token checked, then forwarded
     │  the object, served   ▼   ▼
     │  by it)            SessionDO  (one per session: idFromName(sessionId), SQLite)
     └──────────────────  │  the reducer's state (swarm-shared/workflow), its single writer
                          │  the event log (every stream of the session) + the live readers
                          │  runs (snapshots, fences), the call journal, the lease
                          │  parked items, children, the outbox of effects, the alarm
                          │
                          │ outbox: create an instance / send it an event
                          ▼
                     TurnWorkflow  (one per turn: turn-<session>-<turn>)
                     │  step `phase k` = one agent.run attempt, every hook on the object:
                     │    persistence + journal → RPC; runLease → RPC; onEvent → RPC (batched)
                     │    sharedLimits → LimiterDO (one per bucket)
                     │  parked → waitForEvent(`resume-k`) → step `phase k+1` (the same run)
                     │
                     ├─ SubagentWorkflow      (one per static subagent call)
                     └─ PipelineWorkflow      (one per pipeline call: the graph engine)
                          └─ PipelineNodeWorkflow  (one per node visit, a wave in parallel)
```

**The session's object is its single writer.** Every transition - a message, an answer, a stop, a
turn's or a child's outcome, the idle timer - is one call into it, and everything the transition
produces is written in the **same storage transaction** as the state it leaves: the reducer's state
(`swarm-shared`'s `ISessionState`, as JSON), the `turn.ended` and child markers (the event log is in
the same object, so they need no activity of their own), the parked items, the children, and the
effects on other services, as rows of an **outbox**. After the transaction the object makes the
effects - start a Workflow instance, send one an event - in the order they were decided, one at a
time, retrying a failed one from its alarm with backoff (a later one never overtakes it). Every
effect is idempotent: instance ids are functions of what they run (a retried create finds the
instance there), and an event a waiter already took is never waited for again.

**A turn is a Workflow instance; an attempt is a step.** The instance's `phase 0` step asks the
object for the turn's input, runs ONE `agent.run` with every scale-out hook of the agent pointed at
the object, and reports the outcome (the object applies it once per phase: a retried report is a
no-op). A run that parks reports `parked`; the instance waits for `resume-1` (no step holds
anything while a person decides), which the object sends once every item has its answer; `phase 1`
resumes the SAME run (`resumeFromRunId` + `answers`). A step the engine retries (it threw, its
isolate died) finds its run on record and resumes it from its last snapshot, replaying its call
journal: a recorded model call is not sent again, a recorded tool call does not run again.

**The streams are served by the session's object.** The Worker checks the bearer token of a stream
request and forwards it (`stub.fetch`) to the object, which serves it with the same
`createGatewayHandler`, its own event log as the feed. A reader's subscription is a waiter in the
memory of the one object that writes the stream, taken synchronously before the replay reads (the
object runs one thing at a time), and woken by the write itself: LISTEN / NOTIFY without the network
hop, nothing polled, nothing missed between the replay and the live part. The alternative - the
Worker long-polling the object by RPC - would add a hop per wake and a window between the replay
read and the subscription to close by hand. An unauthenticated request never reaches an object
(an id names an object: any id would wake one).

## What replaces Temporal and Postgres

| examples/swarm (Temporal + Postgres) | Here (Durable Objects + Workflows) | Where |
| --- | --- | --- |
| the `session` workflow (signals, query, the loop) | `SessionDO`: one call per signal, the reducer applied in the object, `view()` for the query | [`src/session.ts`](src/session.ts), [`src/host.ts`](src/host.ts) |
| deterministic replay of the session | none needed: the object's state is stored, not replayed (no `patched()`, no continue-as-new) | |
| the `runTurn` activity, its retries | a `TurnWorkflow` step per attempt (`retries.limit` = `TURN_MAX_ATTEMPTS` - 1, `timeout` = `TURN_TIMEOUT_MS`) | [`src/workflows.ts`](src/workflows.ts), [`src/steps.ts`](src/steps.ts) |
| `TURN_REFUSED` (non-retryable) | `NonRetryableError` (a refusal, refused credentials, a misconfiguration) | `src/workflows.ts` |
| `endTurn` / `writeMarkers` activities | written by the object in the transition's own transaction | `src/session.ts` |
| the session's timer (`condition(ready, idleTimeoutMs)`) | the object's alarm (with the outbox's retries and the watchdog) | `src/host.ts` |
| the activity heartbeat = the lease | `runLease` on the object: a TTL by the object's clock (`LEASE_TTL_MS`), renewed every TTL/3; a newer attempt **revokes** the holder (its next renew says lost) and takes the run once the holder's lease has run out | [`src/store.ts`](src/store.ts) `leaseAcquire` |
| a user's stop = activity cancellation | the answer of the lease's renew (and of every event batch): `stop` → the step aborts the run, which records `cancelled` | `src/steps.ts` |
| `revokedReason` (heartbeat timeout, shutdown, ...) | the revoke above; the watchdog for an instance that errored or went silent | `src/host.ts` |
| `swarm_runs` (snapshots, `fence`, `supersedeRun`) | the object's `runs` table, the same fences: checkpoint `>=`, resume `>`, nothing below the fence, supersede only without a plan | `src/store.ts` |
| `swarm_journal` (`FOR SHARE` against the fence) | the object's `journal` table; the check and the insert are one synchronous block of a single-threaded object - nothing can come between them | `src/store.ts` |
| `swarm_events` + `NOTIFY` | the object's `events` table + its in-memory waiters | `src/store.ts`, [`src/feed.ts`](src/feed.ts) |
| `swarm_parked` | the object's `parked` table (the same rows, the same states) | `src/store.ts` |
| `swarm_sessions` | the object's existence (state on record) | |
| `swarm_limiter` (row lock, the database's clock) | `LimiterDO` per bucket (one call at a time, the object's clock); the bucket math is the same | [`src/limiter.ts`](src/limiter.ts) |
| child workflows (`startChild`, `child.result()`) | Workflow instances the object starts from its outbox; a child reports its outcome to the object | `src/workflows.ts`, `src/session.ts` |
| a child's wait (signals into `child-state.ts`) | the same `child-state.ts`, applied in the object; the object sends the child `resume-k` | `src/session.ts` |
| `subagentWorkflowIdOf` etc. as workflow ids | the same names (swarm-shared) for everything the API shows; the instance id is a SHA-256 of the name (Workflow ids are ≤ 100 chars of `[A-Za-z0-9_-]`) | [`src/ids.ts`](src/ids.ts) |
| the `pipeline` workflow (the engine, replayed by Temporal) | `PipelineWorkflow`: the engine between named steps; the visits' outcomes arrive as `settled <n>` events one at a time, so a replay applies them in the same order | `src/workflows.ts` |
| the gateway on `node:http` | the Worker (`fetch`); the streams in the session's object | [`src/gateway.ts`](src/gateway.ts) |
| `.env`, `*_FILE` secrets | `wrangler.jsonc` vars, Worker secrets (`.dev.vars` locally) | [`wrangler.jsonc`](wrangler.jsonc) |
| `compose.yaml`, the Helm chart, the image | `wrangler.jsonc` | |

Why this way, where there was a choice:

- **The state machine stays in the object, the waiting in the Workflows.** A Workflow has no
  query and holds no state anyone else can read cheaply; an object has both and is a natural
  single writer. Workflows are what survives a dying isolate - so every run (and every wait for a
  resume) is in one, and nothing long-running is in the object.
- **Big data stays in the object; ids cross.** A step result and an event payload are at most
  1 MiB: an instance is started with `{ sessionId, turn }`, a step reads its input from the object
  and reports its outcome to it by RPC (a compacted history, a pipeline's node texts), and returns
  only a status. Values that may outgrow a SQLite row (2 MB) - the state, a snapshot, a journal
  entry, a turn's input - are stored in parts.
- **An agent per step.** workerd keeps no I/O across requests, so the agent (and its MCP
  connections) is made in the step and closed in it; a subagent's or pipeline's call budget is the
  step's own object, closed over by its tool - no AsyncLocalStorage.
- **The lease revokes.** On Temporal the server tells a worker it lost the activity; nothing tells
  a Workflow step that the engine gave up on it. So a retried attempt that finds the run held
  revokes the holder (its next renew answers false: the core aborts it and writes nothing more) and
  waits for the holder's lease to run out before it takes the run and raises its fence. A step that
  went silent - gone with its isolate - is the same: its lease runs out.

## The HTTP API

The same as [examples/swarm's](../swarm/README.md#the-http-api), served by the same code: routes,
bodies, answers, status codes, the event stream's frames and cursor (`<turn>:<attempt>:<seq>`,
`?after=` and `Last-Event-ID`), parking and its answer checks, the children's streams and listings.
Two differences of the platform:

- `SSE_MAX_CONNECTIONS` caps the open streams of **one session** (its object serves them), not of a
  gateway instance - a Worker has no instance to protect; the object is the resource a crowd of
  readers could wear out. Default 100.
- A `503` names `durable object: ...` (the session's object could not be reached) where the
  Temporal swarm names Postgres or Temporal; `/readyz` asks a `LimiterDO` and also reports a
  configuration the steps would refuse.

## Turns, parking, children, pipelines

The semantics are [examples/swarm's](../swarm/README.md#parking-a-persons-answer-a-result-from-outside);
how they run here:

- **A turn** - `TurnWorkflow` `turn-<session>-<turn>`, steps `phase 0`, `phase 1`, ... (one per
  park and resume). A stop while a step runs reaches it at its next lease renew or event batch (at
  most TTL/3, 5 s by default); a stop while it is parked ends the turn at once (its items closed,
  its instance told to end). A stop between attempts (a retry's backoff) is read by the next
  attempt before it runs anything.
- **Parking** - the step reports `parked`; the object records the items (what the gateway checks an
  answer against), the reducer takes the answers (the authority), and the object sends `resume-k`
  once every item has one. The parked items are marked answered when the resume is decided.
- **Static subagents** - `SUBAGENTS`, as in the Temporal swarm: the tool defers, the object starts a
  `SubagentWorkflow` per call (within `SUBAGENT_MAX_PER_ROUND` / `_PER_SESSION`), the child runs
  its profile's agent in its own stream `<session>/<item>`, its outcome answers the item. A child
  parks like a turn (`CHILD_ASK=park`): its items are the session's, owned by it; the gateway
  recomputes the owner (`childOwnerOf`) and the object routes the answer to that child's wait,
  which is checked again there.
- **Pipelines** - `PIPELINES`: a `PipelineWorkflow` per call runs the core's graph engine
  (`@dudko.dev/agent/pipeline-engine`) between named steps; every node visit is a
  `PipelineNodeWorkflow` (its agent.run, then the route call where it ran), a wave started
  together. The engine's events go to the pipeline's own stream in order; a visit's outcome comes
  back through the object as a `settled` event, taken one at a time in a named wait - so a replay
  of the pipeline's instance makes the same calls and starts the same visits.

## What happens on a crash

- **A step throws** (the provider fails past the agent's retries, a journal append is refused):
  the engine retries it with backoff; the retry resumes the run from its last checkpoint, and with
  the call journal the step a crash interrupted is replayed. `e2e/crash.test.ts` (a).
- **The isolate dies mid-step** (on Cloudflare: an eviction, a deploy, a machine; locally: `wrangler
  dev` killed): the engine runs the step again; the old attempt's lease runs out (it renews no
  more), the retry takes the run, raises its fence and resumes it - the write the dead attempt made
  is answered from the journal. Locally, Miniflare resumes an instance only when something sends it
  an event: the object's watchdog **nudges** an instance whose step went silent (no heartbeat, no
  event for three lease TTLs) with an event nothing waits for; on Cloudflare the engine restarts
  the step itself and the nudge is a no-op. `e2e/crash.test.ts` (b).
- **An attempt the engine gave up on, still running** (a step timeout while it is alive, a
  partition): before its first snapshot, the retry supersedes its run - its next journal append is
  refused and the core stops it before any tool call it makes runs; after its plan, the retry
  revokes its lease and raises the run's fence: it is aborted, and nothing of it is written again.
  `tests/steps.test.ts` (both, with the real core).
- **The result was lost** (the run ended, the report did not arrive): the retry finds the snapshot
  `complete` (or `waiting`) and reports it without running anything.
- **A Workflow instance errors outside a step, or is terminated**: the watchdog (every four lease
  TTLs) fails the turn or the child, as Temporal fails an activity it gave up on.
- **An effect fails** (the Workflows API is briefly unavailable): retried from the alarm with
  backoff, in order; after 12 tries it is given up with an error in the log.
- **The session's object restarts**: nothing is lost - the state, the outbox and the alarm are
  stored; readers reconnect with `Last-Event-ID`.

## Limits, and what is not supported

- **Not on workerd**: stdio MCP servers (no processes: `MCP_SERVERS` refuses a `command`), the
  `run_js` sandbox and worker-thread subagents (no `worker_threads`), `web_fetch` / `egress` (the
  core's safe fetch does its own DNS lookup, which workerd does not offer: it fails closed - keep
  `egress` off), enterprise-managed MCP authorization with `private_key_jwt` (`KeyObject`), and
  interactive MCP OAuth (as in the Temporal swarm). Static headers on HTTP MCP servers work.
- **MCP tools with an `outputSchema`** need `@dudko.dev/agent` with `newOutputSchemaValidator`
  (Ajv compiles schemas to code, which workerd forbids; the core now picks the MCP SDK's code-free
  validator there). `e2e/mcp.test.ts`.
- **Workflows' own limits**: a step result and an event payload ≤ 1 MiB (only ids and statuses
  cross here), a step's CPU 30 s by default (up to 5 min on the paid plan; the agent's CPU per step
  is small - its time is I/O), subrequests per instance (every event batch, journal append and
  renew is an RPC: `EVENT_FLUSH_MS` trades latency for fewer), a wait for a resume taken again
  every 30 days.
- **A SQLite row holds 2 MB**: the state, snapshots, journal entries and inputs are stored in parts;
  one stored event is capped by `EVENT_MAX_BYTES` (at most 1 MiB, a stub beyond); a parked item's
  question (a tool's input) must fit a row.
- **One object per session**: every write of a session - its turns and all its children's runs and
  events - goes through one single-threaded object. That is the point (one writer, no fences
  across machines), and it bounds a session's throughput, not the swarm's.
- **No continue-as-new and no `SESSION_MAX_TURNS_PER_RUN`**: the object stores its state; nothing
  grows a history.
- **A run that fails in the middle of a step** (the executor's call fails after a tool of the same
  step ran) is resumed by the core from its `failed` snapshot under the next iteration's journal
  positions, so that step's tool calls run again. This is a limitation of `@dudko.dev/agent` as it
  stands (the Temporal swarm has it too), not of this platform; a failure between steps resumes
  without repeating anything (`e2e/crash.test.ts` (a) is that case).
- Everything [examples/swarm lists](../swarm/README.md#limits-of-this-version) that is not about
  Temporal or Postgres: `remember` refused on an approval, no steering inside a turn, MCP
  elicitation not answered, at-least-once tool calls in the one window the journal cannot close.

## Configuration

Everything comes from the Worker's environment: `vars` in [`wrangler.jsonc`](wrangler.jsonc) and
Worker **secrets** (`wrangler secret put`; locally `.dev.vars`, from
[`.dev.vars.example`](.dev.vars.example) - never committed). The names are
[examples/swarm's](../swarm/README.md#configuration) wherever the meaning is the same; a bad value
fails the request (and `/readyz`) with the variable's name.

**The API** (the Worker)

| Variable | Default | |
| --- | --- | --- |
| `GATEWAY_AUTH` | `bearer` | `none` turns auth off - for a local try only |
| `GATEWAY_TOKENS` | - (required with `bearer`; a **secret**) | Bearer tokens, comma separated, 16+ characters each |
| `CORS_ORIGINS` | none | Allowed browser origins (exact), or `*` |
| `GATEWAY_MAX_BODY_BYTES` | `65536` | |
| `MESSAGE_MAX_CHARS` | `32000` | |
| `SSE_MAX_CONNECTIONS` | `100` | Open event streams **per session** (more: `503`) |
| `SSE_KEEPALIVE_MS` | `15000` | |
| `SSE_BATCH` | `500` | Rows per replay read |
| `LOG_LEVEL` | `info` | One JSON line per entry (Workers Logs) |

**A session's options** - fixed when it starts (the object keeps them):

| Variable | Default | |
| --- | --- | --- |
| `SESSION_IDLE_TIMEOUT_MS` | `86400000` | No work for this long ends the session; `0` never |
| `TURN_TIMEOUT_MS` | `1800000` | One attempt of a turn: the step's timeout |
| `TURN_MAX_ATTEMPTS` | `5` | Attempts of one step (the engine's retries + 1) |
| `SESSION_HISTORY_MAX_CHARS` | `200000` | |
| `SESSION_MAX_QUEUED_MESSAGES` | `50` | |
| `SUBAGENT_MAX_PER_ROUND` / `SUBAGENT_MAX_PER_SESSION` | `4` / `50` | |
| `PIPELINE_MAX_PER_ROUND` / `PIPELINE_MAX_PER_SESSION` | `2` / `20` | |

**The steps**

| Variable | Default | |
| --- | --- | --- |
| `LEASE_TTL_MS` | `15000` | The run lease's TTL (renewed every third of it; a stop reaches a step within that third); what `TURN_HEARTBEAT_TIMEOUT_MS` is to the Temporal swarm. The watchdog looks every four TTLs and nudges a step silent for three |
| `EVENT_MAX_BYTES` | `262144` | One stored event's cap (at most 1 MiB) |
| `EVENT_FLUSH_MS` | `100` | How long a step buffers its run's events before one RPC sends them |
| `LIMITER_REFILL_PER_SECOND`, `LIMITER_CAPACITY`, `LIMITER_MAX_WAIT_MS`, `LIMITER_SCOPE` | off | `sharedLimits`, as in the Temporal swarm (one `LimiterDO` per bucket) |
| `CHILD_ASK` | `park` | `park` / `deny` |

**The agent** - the Temporal swarm's variables, with the model built in code
([`src/agent-config.ts`](src/agent-config.ts)): `AGENT_PROVIDER_TYPE` (`openai` default,
`anthropic`, `google`, `openai-compatible` - the providers this Worker bundles), `AGENT_API_KEY` (a
**secret**, required), `AGENT_MODEL` (required), `AGENT_BASE_URL` (required for
`openai-compatible`), `AGENT_PROVIDER_OPTIONS`, `AGENT_PLANNER_MODEL`, `AGENT_SYNTHESIZER_MODEL`,
`MCP_SERVERS` (HTTP only: `{"name": {"url": "...", "headers": {...}}}` - a secret when its headers
carry a token), `AGENT_TOOL_APPROVAL`, `AGENT_TOOL_RULES`, `SUBAGENTS`, `PIPELINES` (a profile's or
a node's `model` is a model id on the same provider), `AGENT_MAX_ITERATIONS`,
`AGENT_MAX_STEPS_PER_TASK`, `AGENT_MAX_REVISIONS`, `AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_TOTAL_TOKENS`,
`AGENT_LLM_TIMEOUT_MS`, `AGENT_LLM_MAX_RETRIES`, `AGENT_COMPACTION`, `AGENT_CONTEXT_WINDOW_TOKENS`,
`AGENT_SYSTEM_PROMPT`, `AGENT_CLIENT_NAME`, `AGENT_LOG_LEVEL`.

**Not read here** (no meaning on this platform): `DATABASE_URL`, `PG_POOL_MAX`,
`MIGRATE_DATABASE_URL`, `TEMPORAL_*`, `GATEWAY_HOST` / `GATEWAY_PORT`, `WORKER_*`,
`WORKFLOW_BUNDLE_PATH`, `TURN_HEARTBEAT_TIMEOUT_MS` (the lease TTL is it), `SESSION_MAX_TURNS_PER_RUN`
(no continue-as-new), and every `<NAME>_FILE`.

## Run it locally

Local only - `wrangler dev` runs the Worker in workerd with Miniflare's Durable Objects and
Workflows; nothing is deployed and no account is needed.

```bash
pnpm install && pnpm nx run-many -t build -p @dudko.dev/agent,swarm-shared
cd examples/swarm-cloudflare
cp .dev.vars.example .dev.vars      # set GATEWAY_TOKENS and AGENT_API_KEY; never commit it
npx wrangler dev                    # http://localhost:8787, state in .wrangler/
```

Talk to it exactly as to the Temporal swarm:

```bash
TOKEN=...   # one of GATEWAY_TOKENS
S=$(curl -s -X POST localhost:8787/sessions -H "authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' -d '{"message":"What is 2+2?"}' | jq -r .sessionId)
curl -N localhost:8787/sessions/$S/events -H "authorization: Bearer $TOKEN"
```

The local explorer (`/cdn-cgi/local/explorer/api/workflows/agent-swarm-turn/instances`, printed by
`wrangler dev`) shows every Workflow instance and its steps.

## Deploying

The owner's steps (this repository never deploys it; there is no Workers Builds project for it):

```bash
cd examples/swarm-cloudflare
pnpm nx run-many -t build -p @dudko.dev/agent,swarm-shared   # the bundle imports their dist
npx wrangler login                                           # once, the owner's account
npx wrangler secret put GATEWAY_TOKENS                       # 16+ characters, comma separated
npx wrangler secret put AGENT_API_KEY
npx wrangler secret put MCP_SERVERS                          # when its headers carry a token
# Edit the non-secret vars in wrangler.jsonc (AGENT_PROVIDER_TYPE, AGENT_MODEL, ...), then:
npx wrangler deploy
```

`wrangler.jsonc` publishes no `workers.dev` route and no preview URLs (`workers_dev: false`,
`preview_urls: false`): add a route or a Custom Domain on purpose (`routes`), or set
`workers_dev: true` to try it. The first deploy creates the Durable Object classes (migration
`v1`, SQLite) and the four Workflows. A step's CPU limit is 30 s on the free plan; on the paid plan
`limits.cpu_ms` raises it (up to 300000).

## Security

- **The bearer token** is checked in constant time (swarm-shared), on the Worker for every route and
  again in the session's object for a stream; an unauthenticated stream never reaches (or wakes) an
  object. It is one shared secret for the whole API - whoever holds it can start, steer and read any
  session: put your own authentication in front before serving several users.
- **Secrets are Worker secrets**, never in `wrangler.jsonc` and never committed (`.dev.vars` is
  gitignored). The key reaches the provider through the model object built in the step; it is in
  no snapshot, event or log.
- **The data at rest is the conversation**: each session's object holds its events (tool inputs and
  outputs), snapshots, journal (every model response and tool result) and parked items, in
  Cloudflare's storage; Workflow instances hold only ids and statuses (and a pipeline's
  definition). Nothing prunes them: delete a session's object storage when it is no longer needed.
- **Answers are untrusted**: checked by the gateway (shape, size, the item's session, the child's
  recomputed id), then by the object's reducer or the child's wait, then by the core.
- The objects are reachable only through this Worker's bindings: their RPC surface is not public.

## Development and tests

The workspace project `swarm-cloudflare` (`examples/swarm-cloudflare`): `typecheck` (the Worker
against `@cloudflare/workers-types`, tests and e2e against Node's), `format:check`, `build` (`wrangler
deploy --dry-run --outdir dist`: the bundle exactly as a deploy would upload it - it needs no
network at all, checked in an empty network namespace), `test`, and `test:e2e`.

```bash
pnpm nx run-many -t typecheck format:check build test -p swarm-cloudflare
pnpm nx run swarm-cloudflare:test:e2e      # wrangler dev, a few minutes
```

- **Unit tests** (`tests/*.test.ts`, `node --test`, in `pnpm check`): the object's tables over
  `node:sqlite` behind the shape of a Durable Object's `ctx.storage.sql` (the fences, the journal,
  the supersede, the lease, the events, the parked items, the blobs); the session's object (`SessionHost`)
  with the Workflow instances played by the test (every transition, the children, a child's wait,
  stop, the idle timer, the outbox, the watchdog); the steps with the real core against the
  scripted model (a phase, a lost result, parking, a stop, a refusal, and both fences against an
  attempt the engine gave up on); the Worker's gateway and backend and the object's streams; the
  configuration, the ids, the limiter. Why `node --test` and not `@cloudflare/vitest-pool-workers`:
  the code is written so that everything but the thin `cloudflare:*` classes runs in Node, so the
  state transitions and the guards are tested fast and without workerd (and mutation-checked in
  seconds), with the repository's one test runner; the platform glue - the bindings, the events
  between the object and the instances, retries, a killed runtime - is what the e2e run in a real
  workerd, the bundle that deploys.
- **End to end** (`e2e/*.test.ts`): `wrangler dev` on a temporary `--persist-to`, the scripted
  OpenAI-compatible model of `packages/agent/tests/helpers/openai-server.ts`, the MCP server of
  `@dudko.dev/test-servers`, the HTTP API. Mirrored from examples/swarm's integration tests:
  `session` (a turn end to end, replay from a cursor, `Last-Event-ID`, live, the refusals - plus
  the per-session stream cap), `parking` (park, answer, the write once; a partial answer; stop
  during a park), `crash` (a step that throws; the dev server killed mid-step and started again),
  `stop` (stop, the next message, end), `subagents` (two children side by side, the per-round cap,
  stop while they run), `child-parking` ((a), (d), (e) - and an answer in another session's URL),
  `pipelines` (a wave, a routed node, the streams; stop while a node runs), and `mcp` (a structured
  MCP tool from workerd). Not mirrored: what is Postgres' or Temporal's own (`postgres.test.ts`'s
  races, continue-as-new, `zombie.test.ts`'s SIGSTOP - its guarantee is `tests/steps.test.ts`'s,
  with the real core), `limits.test.ts` (the limiter is unit-tested), the pipelines' caps and
  crash test, child parking's (b), (c), (f), (g) (covered by the unit tests of the shared reducer
  and of the object).
- CI: `.github/workflows/swarm-cloudflare.yml` runs the e2e (`ci.yml` already runs the four checks
  with every other project).
