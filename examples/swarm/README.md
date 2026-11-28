# Agent swarm: `@dudko.dev/agent` on Temporal + Postgres

A reference deployment of the Node agent ([`@dudko.dev/agent`](../../packages/agent)) as a
horizontally scaled swarm: any number of stateless gateways and workers, conversations that survive
a worker dying in the middle of a turn, one event stream per conversation that a client can leave
and rejoin, turns that park on a person's answer (or a result from outside) and go on days later,
static subagents and pipelines (graphs of agents) run as child workflows, and limits shared by
every worker. Self-hosted Temporal for the durable part, Postgres for the state, no Redis, one
image, a Helm chart.

This is an **example**, not a package: private in the workspace, never published. Read it, run it,
copy what you need.

- [Architecture](#architecture)
- [Run it with Docker Compose](#run-it-with-docker-compose)
- [The HTTP API](#the-http-api)
- [Parking: a person's answer, a result from outside](#parking-a-persons-answer-a-result-from-outside)
- [Static subagents: child workflows](#static-subagents-child-workflows)
- [Pipelines: child workflows](#pipelines-child-workflows)
- [What happens on a crash](#what-happens-on-a-crash)
- [Scaling](#scaling)
- [Kubernetes: the Helm chart](#kubernetes-the-helm-chart)
- [The image](#the-image)
- [Configuration](#configuration) (every variable)
- [Security](#security)
- [Limits of this version](#limits-of-this-version)
- [Next steps](#next-steps)
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
                                        Postgres ◄──────┘      ├─ activity `runTurn` = one agent.run()
                                     sessions, run snapshots,  │      persistence  → swarm_runs (+ journal)
                                     the call journal, events  │      onEvent      → swarm_events + NOTIFY
                                     (+ NOTIFY), parked items, │      runLease     → the activity heartbeat
                                     the token bucket          │      sharedLimits → swarm_limiter (row lock)
                                                               ├─ child workflow `subagent` (one per static
                                                               │  subagent call) → activity `runSubagent`
                                                               └─ child workflow `pipeline` (one per pipeline
                                                                  call): the graph engine schedules
                                                                  └─ child workflow `pipelineNode` (one per
                                                                     node visit, a wave in parallel)
                                                                     → activity `runPipelineNode`
```

**The durable unit is a session** (a conversation), and a session is a Temporal workflow,
`session-<id>`:

- an inbox of user messages (signal `message`), answers to what a parked turn waits for (signal
  `answer`) and `stop` (signal), and a query `state`;
- a loop: wait for a message → run ONE turn as an activity → append the exchange to the history →
  write the turn's `turn.ended` marker → wait again. Messages that arrive while a turn runs wait and
  become the next turn, together;
- continue-as-new when Temporal suggests it (the history is large) or after
  `SESSION_MAX_TURNS_PER_RUN` turns; the conversation is capped at `SESSION_HISTORY_MAX_CHARS` (the
  oldest exchanges go first; the agent's own compaction normally keeps it far below);
- no message for `SESSION_IDLE_TIMEOUT_MS`: the session ends.

The workflow is deterministic and small: its logic is plain functions in
[`swarm-shared`](../swarm-shared) ([`src/session-state.ts`](../swarm-shared/src/session-state.ts)),
[`src/workflows.ts`](src/workflows.ts) wires them to Temporal. Signals, not updates: the server accepts a signal while no worker runs, so the gateway
answers at once and a swarm scaled to zero still takes messages.

**A turn is one activity, `runTurn`, and one ordinary `agent.run({ input, history })`** on the
worker's agent (one per worker process, built from the environment), with the agent's scale-out
hooks pointed at Temporal and Postgres:

| Agent hook | Here | Where |
| --- | --- | --- |
| `persistence` | the run's snapshot, as JSONB, in `swarm_runs`; every write fenced by `attempt` and by the fence a resume raises (or the turn's next run, when it supersedes a run with no plan on record) | [`src/db/runs.ts`](src/db/runs.ts) |
| `persistence.journal` | the call journal: every model response and tool result, in `swarm_journal`, in append order; appends fenced like the snapshots. A resume replays the step a crash (or a park) interrupted instead of running it again | [`src/db/journal.ts`](src/db/journal.ts) |
| `toolApproval.onRequest` | `{ park: true }`: an "ask" of the approval mode parks the turn until a person answers through the gateway - and a child's ask parks the child's own run (`CHILD_ASK`) | [`src/subagents.ts`](src/subagents.ts), [`src/child-ask.ts`](src/child-ask.ts) |
| `onEvent` | every event in `swarm_events`, keyed `(session_id, run_id, attempt, seq)`, written in batches; a statement trigger sends `NOTIFY swarm_events, '<session>'` | [`src/db/events.ts`](src/db/events.ts) |
| `runLease` | the activity heartbeat. `acquire`: Temporal runs one attempt at a time, so it only binds the run to its turn; `renew` = `heartbeat()`, false once Temporal says the turn is not this worker's (heartbeat timed out, worker shutdown, reset, paused, not found) | [`src/lease.ts`](src/lease.ts) |
| `sharedLimits` | a token bucket in `swarm_limiter`, taken under a row lock by the database's clock; a wait beyond `LIMITER_MAX_WAIT_MS` is a refusal | [`src/db/limiter.ts`](src/db/limiter.ts) |
| a stop | the session cancels the activity; the activity aborts the run, which records `cancelled` | [`src/activities.ts`](src/activities.ts) |

The activity's result is a discriminated union (`completed | stopped | parked`, see
[`session-types.ts`](../swarm-shared/src/session-types.ts)); a failure is an exception, retried by Temporal
(`TURN_MAX_ATTEMPTS`) unless it is a refusal (a limit, refused credentials), which fails the turn at
once. `parked` carries the items the run waits for; the workflow collects their answers (from
clients, from child workflows) and runs the activity again, which resumes the run with them - see
[Parking](#parking-a-persons-answer-a-result-from-outside).

**The gateway** is the clients' only door, any number of replicas. Sessions live in Temporal,
events in Postgres; it holds nothing a restart would lose. The API itself - the routes, the checks,
the event stream - is a fetch-style handler over Web APIs in [`swarm-shared`](../swarm-shared)
(`(request: Request) => Promise<Response>`, the same on any platform); here it runs on `node:http`,
no framework, behind a small adapter ([`src/gateway.ts`](src/gateway.ts)).

**`swarm-shared`** ([`examples/swarm-shared`](../swarm-shared), private, never published) is the
part of the swarm that does not depend on Temporal, Postgres or Node: the session's logic, its ids
and types, the answer checks, the cursor and the HTTP API. It ships built JavaScript (the image
copies it into `node_modules`, where Node strips no types); `build` makes it, and nx builds it
before the swarm's typecheck, build and tests.

**Postgres** holds six tables: `swarm_sessions` (the sessions the gateway started), `swarm_runs`
(run snapshots, bound to their turn), `swarm_events` (the event log), `swarm_limiter` (the bucket)
(`sql/001_init.sql`), `swarm_journal` (the call journal) and `swarm_parked` (the items parked turns
wait for) (`sql/002_parking.sql`; `sql/003_child_parking.sql` adds the child that owns an item).
The `migrate` role applies `sql/*.sql` once, in order, in one transaction under an advisory lock,
and refuses a migration that was edited after it was applied.

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
| `POST /sessions/:id/answers/:requestId` | the answer, by the item's kind: `{ "approved": true \| false, "reason"? }` or `{ "output": <JSON> }` / `{ "error": "..." }` | `202 { requestId, kind, child? }` (`child`: the child that waited for it - `itemId`, `workflowId`, `nodeId` / `visit`); `404` nothing of this session waits for that id, `409` `already_answered` / `answered_by_subagent` / `answered_by_pipeline`, `400` `invalid_answer` - see [Parking](#parking-a-persons-answer-a-result-from-outside). The turn's own items and those its children wait for alike |
| `POST /sessions/:id/stop` | optional `{ "end": true }` | `202`. Stops the running turn and drops the messages queued behind it; `end` also ends the session |
| `GET /sessions/:id` | | `200` the state: `status` (`idle` / `running` / `stopping` / `parked` / `ended`), `turn`, `running`, `queued`, `dropped`, `parked` (its `waiting`: the children that wait for a person), `history`, `turns` (the last 20: status, run id, attempt, text or error, usage) |
| `GET /sessions/:id/events?after=<cursor>` | | `text/event-stream` (below) |
| `GET /sessions/:id/subagents` | | `200 { subagents: [{ itemId, turn, runId, state, workflowId, name, task, events }] }`: the session's static subagent calls |
| `GET /sessions/:id/subagents/:itemId/events?after=<cursor>` | | `text/event-stream`: one child's own stream (same frames, `turn` is 1) |
| `GET /sessions/:id/pipelines` | | `200 { pipelines: [{ itemId, turn, runId, state, workflowId, name, task, events }] }`: the session's pipeline calls |
| `GET /sessions/:id/pipelines/:itemId/events?after=<cursor>` | | `text/event-stream`: a pipeline's own stream - the graph engine's `pipeline.*` events (same frames, `turn` is 1) - see [Pipelines](#pipelines-child-workflows) |
| `GET /sessions/:id/pipelines/:itemId/nodes/:nodeId/:visit/events?after=<cursor>` | | `text/event-stream`: one node visit's own stream (its run's events; `visit` from 1) |
| `GET /healthz` | | `200` while the process runs |
| `GET /readyz` | | `200` when Postgres, Temporal and the LISTEN connection answer, else `503` with `checks` |

Status codes: `400` (a bad body, id, cursor or answer), `401` (no or a wrong token), `404` (no such
route, session, pending item or child stream), `405`, `409` (`session_ended`, `already_answered`,
`answered_by_subagent`, `answered_by_pipeline`), `413` (a body or message too long), `415`, `503`
(Temporal or Postgres down, too many streams - with `Retry-After`).

### The event stream

```
id: 3:1:17
data: {"cursor":"3:1:17","turn":3,"event":{"type":"step.tool-call","runId":"…","attempt":1,"seq":17,…}}
```

Every [event of the agent](../../packages/agent/README.md#streaming-events), in order, plus two
markers per turn: `turn.started` (`input`, `messageIds`) first and `turn.ended` (`status`:
`completed` / `stopped` / `failed`, `text`, `error`, `runId`, `attempt`, `usage`) last. A turn that
parks has, between them, the core's `run.parked` (`items`) at the end of the parked attempt, and -
for static subagent calls - `subagent.started` (`itemId`, `name`, `task`, `workflowId`, `events`:
the child's stream) and `subagent.ended` (`itemId`, `status`, `text` or `error`, `usage`), for
pipeline calls `pipeline.call.started` / `pipeline.call.ended` (the same, plus `runs`, `stoppedBy`,
the failed `nodeId`), then the resumed attempt. Between them, a child that waits for a person adds
`subagent.waiting` / `pipeline.call.waiting` (`itemId`, `name`, `workflowId`, `runId`, `nodeId` /
`visit` of a node visit, `requests`: `requestId`, `kind`, `toolName` - what to answer -, `events`)
when its run parks and `subagent.resumed` / `pipeline.call.resumed` (`answered`: the ids) when it
goes on - see [Children wait too](#children-wait-too). A parked turn writes no `turn.ended` until
it is over.

The stream replays from Postgres everything after the cursor, then goes live (`LISTEN/NOTIFY`, no
polling). The cursor is `<turn>:<attempt>:<seq>` - a session is many runs, one per turn, so the turn
comes first, then the core's own `(attempt, seq)`. Treat it as opaque: send back the last `id:` you
saw, as `?after=` or as `Last-Event-ID` (which an `EventSource` sends by itself on a reconnect, and
which wins over `after`). Without one, the stream starts at the session's beginning.

`attempt` here is the turn's attempt. It is the run's own attempt, unless a worker died before the
run's first snapshot (during planning: there is nothing to resume, so the turn supersedes the first
run and starts a second one); the second run's attempts then count on from the first run's, so the
order stays total.

Delivery is **at-least-once**: the step a crash interrupted runs again under the next attempt, and
its events come again with the new attempt's numbers (a late event of a dead attempt sorts before
the attempt that replaced it). A client that dedupes keeps the last attempt's copy of a step.
An event larger than `EVENT_MAX_BYTES` (a huge tool output) is stored as a stub
`{ type, runId, seq, attempt, truncated: true, bytes }`; the full result is in the snapshot.

## Parking: a person's answer, a result from outside

A turn can **park**: stop without failing, hold no worker, and go on - as the same turn and the
same run - when what it waits for has arrived, minutes or days later, on any worker. It is the
core's [parking](../../packages/agent/README.md#parking-a-run-a-persons-answer-or-a-result-from-outside)
on Temporal and Postgres.

**What parks a turn.**

- **A person's question.** `AGENT_TOOL_APPROVAL` (and `AGENT_TOOL_RULES`) decide which tool calls
  ask; the worker answers every "ask" with `{ park: true }`. `ask-writes` asks for every tool not
  known to be read-only, `ask-all` for every one. The item's `kind` is `'approval'`.
- **A result from outside**: a tool that returns `deferResult()` (`kind: 'tool'`). The static
  subagents and the pipelines (below) are such tools; so is any tool you add whose result comes
  from another system - a job queue, a webhook, a review.

The run parks at the end of its tool round with **every** pending item of that round. The activity
records the items in `swarm_parked` and returns `parked`; the workflow records the turn as
`parked`. Clients see the items in the stream (the core's `run.parked`, and
`tool.approval-requested` / `tool.approval-resolved` with `parked: true`) and in the state
(`GET /sessions/:id`: `status: 'parked'`, `parked.requests` - `requestId`, `kind`, `question`,
`subagent?`, `pipeline?` - and `parked.answered`). Messages sent meanwhile wait behind the parked turn.

**Answering.** `POST /sessions/:id/answers/:requestId` with the answer, one item at a time. The
gateway checks it against `swarm_parked` - without asking a worker, so an answer is taken while the
swarm is scaled to zero - and refuses, before the session hears of it:

| Answer | Refused with |
| --- | --- |
| an id nothing of this session waits for (unknown, another session's - a child's item included -, a stopped turn's, a child that has ended, a child that cannot be shown to be this session's) | `404 not_found` |
| an item the turn already went on with | `409 already_answered` |
| an item a subagent answers | `409 answered_by_subagent` |
| an item a pipeline answers | `409 answered_by_pipeline` |
| the wrong shape for the kind: an approval is `{ "approved": true \| false, "reason"? }` (no `remember`: an approval is for one call, on whichever worker), a tool result `{ "output": <JSON> }` or `{ "error": "..." }`, bounded | `400 invalid_answer` |

The workflow checks it again (the authority), and the core a third time on the resume. When every
item has its answer, the workflow runs the activity again, which resumes the run with them
(`resumeFromRunId` + `answers`): the run replays its journal up to the round that parked - the
calls that finished are not run again, the model is not asked again - takes the answers, and goes
on live. An approved write runs exactly once. A resume that has answers for only some of the items
(a retried, older resume) parks again at once with the rest, under the same ids.

**Stop** (`POST /sessions/:id/stop`) ends a parked turn as `stopped` (its `turn.ended` is
written, its items are cancelled - its children's too: an answer to them is a `404` - and its
children are cancelled, a waiting one included).
How long an item may wait, reminders and escalation are yours: nothing times a park out but the
session's own `SESSION_IDLE_TIMEOUT_MS` (no message for that long ends the session), which does
not run while the parked turn has children - working, or waiting for a person.

### Children wait too

A static subagent's child and a pipeline's node visit ask a person the same way: under
`AGENT_TOOL_APPROVAL` / `AGENT_TOOL_RULES` (the worker's, as for the session), an "ask" of the
CHILD's run parks that run (`CHILD_ASK=park`, the default; `deny` keeps the old behaviour - an ask
is a denial, nothing parks). So does a deferred tool result in a child.

- **The child waits, holding no slot.** Its activity records the items in `swarm_parked` - under
  the SESSION, in the parent's turn, answered by a client, owned by the child's workflow id - and
  returns `parked`. The child workflow (`subagent`, or `pipelineNode`) waits for the answers on
  signals, like the session, checks each one by its kind itself (the authority), and when EVERY
  item has its answer resumes the SAME run (`resumeFromRunId` + `answers`): its journal is
  replayed, the approved write runs once. A partial answer keeps it waiting; a resume that parks
  again waits again. Its own state is the query `childState`.
- **The parent just waits.** The parent turn is parked on its child's item as always (it waits for
  its children); a pipeline waits for that node visit. Nothing anywhere holds a worker slot while
  the person decides.
- **Answering** is the same route, `POST /sessions/:id/answers/:requestId`, with the same checks
  and codes. The gateway looks the item up in `swarm_parked` for THAT session only - an item of
  another session is a `404`, as an unknown one - and sends it to the child that owns it, directly
  (a signal to the child workflow), never through the session. The child's workflow id is not
  taken from the row: the gateway recomputes it from the session of the request, the parked turn's
  call the child answers (its own row in the same session: its run and its id) and, for a node
  visit, the node and the visit - the function the session named the child with - and refuses
  (`404`) when it differs. (Through the session would mean a copy of every child's items in the
  session and, for a node, two hops - session, pipeline, node - with new commands in both
  histories; the child is where the items are and where they are checked.)
- **Seeing it.** `GET /sessions/:id` lists the waiting children under `parked.waiting`: which item
  of the turn (`itemId`, `kind` `subagent` / `pipeline`, `name`), which child (`workflowId`, a node
  visit's `nodeId` / `visit`), its run, its `requests` with their `question`s, `since`, and its own
  stream (`events`). The parent's stream gets `subagent.waiting` / `subagent.resumed`
  (`pipeline.call.waiting` / `.resumed` for a node visit) in the parked attempt's slot, in one
  order with the other child markers; the child's own stream has its `run.parked` and the
  approval events, then the resumed attempt.
- **Stop.** A session stop ends a waiting child like a working one: the turn's `turn.ended` closes
  every item of the turn, the child's own (`404` from then on), the child is cancelled and its own
  end closes what it still waited for. A node visit cancelled because another node of its wave
  failed closes its items the same way.

`CHILD_ASK` is a worker setting, like the approval mode it goes with: it decides what the child's
agent does with an ask (`deny`: no `onRequest` at all - exactly the agent as it was), on whichever
worker runs or resumes the child. A child started before child parking (a session running at the
upgrade) never waits: its activity is not told it may park, so its asks are denials. In a rolling
deploy with mixed settings a child follows the worker its run is on.

## Static subagents: child workflows

`SUBAGENTS` (worker) names subagents: each one a tool of the session's agent and a profile - a
model, a system prompt, the tools it may use (ones the worker has), a step cap - that the worker
builds an agent of its own for.

```bash
SUBAGENTS='{"researcher":{"description":"Research one question with the docs and report the facts","model":"gpt-4.1-mini","tools":["docs__search","docs__fetch"],"maxIterations":4,"readOnly":true}}'
```

The tool is the core's remote subagent (`createSubagentTool({ isolation: 'remote', dispatch })`),
whose `dispatch` answers `deferResult()` at once: the turn **parks** with one `'tool'` item per
call (several calls in one round: several items). For each, the session workflow starts a child
workflow **`subagent`**, all of them in parallel, and holds no worker slot while they run:

- the child runs **one activity**, `runSubagent`: one `agent.run` of the profile on the task, under
  the same `sharedLimits` and the same lease (the heartbeat of its own activity), with the same
  snapshots and call journal - so a child whose worker dies resumes on another from its last
  checkpoint, and replays what it had done;
- its **id** is a function of the session, the parent run and the item -
  `subagent-<session>-<run>-<item>` (the core's item id is stable) - so a replayed or retried
  start names the same child, and a child started twice for one item finds its run already done
  and returns its answer without running anything;
- its outcome **answers the item**: `{ output: <its answer> }`, or `{ error }` if it failed or was
  stopped. When every child has ended (and every other item of the round has its answer), the turn
  goes on with them.

**Bounds.** `SUBAGENT_MAX_PER_ROUND` (default 4) calls in one round, `SUBAGENT_MAX_PER_SESSION`
(default 50) in a session (session options, fixed at its start): a call beyond them is a tool error
the model reads ("refused: at most 4 subagent calls in one round") and starts no child. The
workflow checks the same caps again.

**A child's events** are a stream of their own: its run and its events are keyed by
`<session>/<item>` in place of a session id (`swarm_runs`, `swarm_events`), so they never mix with
the turn's `(turn, attempt, seq)` order. `GET /sessions/:id/subagents/:itemId/events` serves it -
the same frames and cursor (`turn` is 1), from its `turn.started` to its `turn.ended`. The parent
stream gets `subagent.started` / `subagent.ended` markers, written by the session workflow in the
parked attempt's slot of the turn (seq from 2^30 up, after every event of that attempt, before the
resumed attempt's, in the order the workflow wrote them - a reader that follows the stream never
sees one land behind its cursor). `GET /sessions/:id/subagents` lists a session's calls.

**A child asks a person** like the session does: its approvals follow the worker's mode and rules,
and an "ask" parks the child's own run until the person answers through the gateway (`CHILD_ASK`,
see [Children wait too](#children-wait-too)); with `CHILD_ASK=deny` it is a denial. It has no
subagents or pipelines of its own. Its tokens are charged to its own run (and to `sharedLimits`),
not to the parent turn's `usage`; `subagent.ended` carries them.

## Pipelines: child workflows

`PIPELINES` (worker) names pipelines: each one a tool of the session's agent and a graph of
agents - the core's [pipeline definition](../../packages/agent/README.md#pipelines), plain JSON:
nodes (each an agent with its own role, model and tools), edges with conditions, routes, loops,
limits.

```bash
PIPELINES='{"review":{"description":"Draft an answer, check it against the docs, publish it","readOnly":true,
  "definition":{"version":1,"entry":"draft","nodes":[
    {"id":"draft","instructions":"Write a first draft."},
    {"id":"check","instructions":"Check it against the docs.","tools":["docs__search"],
     "routes":[{"label":"approve"},{"label":"revise"}]},
    {"id":"publish","instructions":"Format it for publication.","model":"gpt-4.1-mini"}],
  "edges":[{"from":"draft","to":"check"},
    {"from":"check","to":"publish","when":{"kind":"route","label":"approve"}},
    {"from":"check","to":"draft","when":{"kind":"otherwise"}}],
  "limits":{"maxNodeVisits":2,"maxRuns":8}}}}'
```

The tool takes `{ task }` (it is the core's remote subagent tool, like a static subagent's) and its
`dispatch` answers `deferResult()` at once: the turn **parks** with one `'tool'` item per call. For
each, the session workflow starts a child workflow **`pipeline`** (`pipeline-<session>-<run>-<item>`,
like a subagent's), and the `task` is the pipeline's request. How it maps:

- **The graph engine runs IN the workflow.** `pipeline` runs `preparePipeline` + `runPipelineGraph`
  from [`@dudko.dev/agent/pipeline-engine`](../../packages/agent/README.md#running-the-graph-yourself),
  a file that imports nothing and is deterministic by contract: no clock, no randomness, no I/O.
  It is the scheduler; Temporal's history is the graph's snapshot. The workflow bundle holds the
  engine and none of the agent's main entry (`tests/bundle.test.ts`). The definition is read once,
  by an activity, from the worker that runs it (`pipelineDefinition`), so the history holds the graph
  the run used.
- **A node visit is a child workflow.** `pipelineNode` (`<pipeline id>.<node>.<visit>`) runs one
  activity, `runPipelineNode`: one `agent.run` of the node's agent on the engine's rendering of its
  input (`renderPipelineNodeInput`: the request, then each activating node's output), under the same
  heartbeat lease, snapshots and call journal as a turn. The visits of a wave are started together:
  a wave runs in parallel across the swarm, and the next wave starts once all of them have settled.
- **The route call is where the node ran.** A node with `routes` picks one in the same activity,
  after its run (`pickPipelineRoute` with the node agent's config: its decision model, else its
  planner model, under `sharedLimits`); no label, or a failed call, is no route (the core's rule).
- **A crash.** The pipeline workflow is replayed on any worker: the engine makes the same calls in
  the same order and gets every finished visit's answer from the history - a finished node is not
  run again. A node whose worker died is retried on another and resumes its run from its snapshot
  and its call journal: its recorded model calls are replayed, a write it already made is not made
  again. The route call runs after the run, so a crash after it may ask the router again (the
  answer Temporal records is the one that counts).
- **The answer.** `PipelineResult.text` (the last terminal node's output, clipped to 32,000
  characters) is the call's `{ output }`. A run the definition's `limits` cut short (`stoppedBy`
  `maxRuns` / `maxNodeVisits`) still answers, with a note the model reads (`[pipeline "review" was
  cut short by its maxNodeVisits limit after 8 node runs: ...]`). A failed node fails the pipeline
  (the engine's rule: the other visits in flight are cancelled) and the item is answered
  `{ error: 'pipeline "review" failed: Pipeline node "check" failed (visit 1): ...' }`, which the
  parent model reads like any tool error.
- **Stop.** A session stop cancels the pipeline workflow and, through its cancellation scope, the
  signal the engine reads (`aborted` + `addEventListener('abort')`) and every node child in flight.
  The engine runs with `onAbort: 'reject'`: an abort is an `AbortError`, never a result that looks
  finished, and a stopped pipeline has nobody to answer - its parked turn is stopped with it. The
  workflow waits for its nodes to end (their streams get their `turn.ended`) and ends cancelled.
- **Bounds.** `PIPELINE_MAX_PER_ROUND` (default 2) calls in one round, `PIPELINE_MAX_PER_SESSION`
  (default 20) in a session (session options, fixed at its start, like the subagent caps): a call
  beyond them is a tool error the model reads ("refused: at most 2 pipeline calls in one round")
  and starts nothing; the workflow checks the caps again. The definition's own `limits`
  (`maxNodeVisits`, default 3; `maxRuns`, default 25) bound each run - the engine enforces them. A
  node's output is clipped to 32,000 characters before the edges see it.

**A node resolves against the worker**, as a subagent profile does: `model` is a model id on the
worker's provider (default: the worker's; another model drops the worker's per-stage overrides, as
the core's `nodeResolver` does), `instructions` go under the worker's system prompt, `tools` are
tools the worker mounts (`<server>__<tool>` of `MCP_SERVERS`, or a native tool), `mcpServers` gives
every tool of those worker servers; a node that names none gets no tool at all. Every definition is
validated at worker start (`preparePipeline`: a `PipelineValidationError` stops the worker with the
pipeline and every issue), and refused there, naming the pipeline and the node: a tool or a server
the worker does not have, `skills` (the swarm has none), `settings` (nothing here would read them),
a node id that cannot name a workflow or a route (`[A-Za-z0-9_-]{1,64}`). A pipeline's name must
not be a subagent's or a tool of the worker. A node asks like a subagent child: its approvals
follow the worker's mode and rules, an "ask" parks the visit's own run (the pipeline waits for the
visit; `CHILD_ASK=deny`: a denial - see [Children wait too](#children-wait-too)), and it has no
subagents or pipelines of its own. A worker whose node differs from the one the run was
planned with (PIPELINES changed during a rolling deploy) leaves the visit to another worker.

**Events: three kinds of stream.**

- The **parent's** stream gets `pipeline.call.started` (`itemId`, `name`, `task`, `workflowId`,
  `events`: the pipeline's stream) and `pipeline.call.ended` (`itemId`, `status`, `text` or
  `error`, `runs`, `usage`, `stoppedBy?`, `nodeId?`), written by the session workflow in the
  parked attempt's slot, in one order with the subagent markers. (Not `pipeline.started`: that is
  the engine's own event, below.) The core's own `subagent.start` for the call is there too: the
  tool is the core's remote subagent tool.
- The **pipeline's own** stream (`GET /sessions/:id/pipelines/:itemId/events`): `turn.started`,
  the engine's events in the order it emitted them - `pipeline.started`, `pipeline.node.started`
  (`nodeId`, `visit`, `from`, plus the visit's `workflowId` and `events`), `pipeline.node.finished`
  (`text`, `route`, `usage`), `pipeline.edge`, `pipeline.node.skipped`, `pipeline.node.failed`,
  `pipeline.finished` - then `turn.ended` (`status`, `text` or `error`, `runs`, `usage`). The
  workflow cannot do I/O: it numbers the events (seq from 1) and writes them through ONE activity at
  a time, each write taking everything emitted since the last one - a wave's starts together, a
  settled visit's finish and edges together. Which event lands in which write depends only on the
  activations the workflow replays, so the writes replay the same; and one write at a time keeps
  the stream in order.
- Each **node visit's** stream (`GET /sessions/:id/pipelines/:itemId/nodes/:nodeId/:visit/events`):
  its run's events, keyed by `<session>/<item>/<node>/<visit>` like a subagent child's, from its
  `turn.started` to its `turn.ended` (with the `route` it picked).

The same cursor and replay rules (`?after=` / `Last-Event-ID`), the same auth and error codes as
the subagent routes. `GET /sessions/:id/pipelines` lists a session's calls; a pipeline's node
visits are named by the `pipeline.node.started` events of its stream.

## What happens on a crash

- **A worker dies** (SIGKILL, OOM, the node goes away). Its turn's heartbeat stops;
  after `TURN_HEARTBEAT_TIMEOUT_MS` Temporal retries the activity on another worker. The retry looks
  the run up by (session, turn) in `swarm_runs` and resumes it (`resumeFromRunId`) from its last
  checkpoint, as attempt + 1 - the core records the new attempt before it emits anything. Steps that
  finished are not run again, and with the call journal neither is what the step in flight had
  finished: its recorded model calls are replayed (not sent again) and its recorded tool calls are
  answered from the journal (not run again). Only a tool that ran but whose result was not on
  record yet runs again (design tools to be idempotent - the core's
  [resume caveats](../../packages/agent/README.md#the-call-journal-exact-resume) apply). The session
  workflow itself is replayed by Temporal on any worker; a parked turn's children go on.
- **A worker is stopped** (SIGTERM: a deploy, a scale-down). It stops polling and gives the running
  turns `WORKER_SHUTDOWN_GRACE_MS` to finish; then they are cancelled, the lease is lost (no more
  writes), and Temporal retries them elsewhere at once. Give the container longer than the grace
  (`stop_grace_period`, `terminationGracePeriodSeconds`).
- **A worker that does not know it lost the turn** (a paused process, a partition): its late
  writes are refused - a checkpoint may not go below the attempt on record, a resume must go above
  it, and once a resume has taken the run (its lease's acquire raises the run's `fence` to the
  attempt it claims) nothing of an older attempt is written, no snapshot and no journal entry. A
  journal append takes the run's row `FOR SHARE`, so the fence waits for any append that read the
  old one: the resume reads a journal that nothing of the old attempt can land behind. A refused
  append stops that run (an append is fail-closed), and since every model response is appended
  before any tool call in it runs, no tool call of that run runs after the fence is up. Its late
  events sort before the new attempt's.
- **...and lost it before the run's first snapshot** (the planner had not answered yet, so there
  is no plan to resume): the retry starts the turn's next run, but first it **supersedes** the old
  one - its `fence` goes to the top, so no attempt of it writes anything again (no snapshot, no
  journal entry, no resume). The fence is raised in one statement that also checks the old run
  still has no plan on record (a plan that landed first is resumed instead), it waits for any
  journal append that read the old fence, and it is committed before the new run is even named.
  The paused worker's next append is refused, and its run stops before any of its tool calls run.
  The same holds for a subagent's run and a pipeline node's visit.
- **The run itself fails** (a provider outage that outlasts the agent's own retries): the activity
  fails and Temporal retries the turn with backoff, resuming from the last checkpoint, up to
  `TURN_MAX_ATTEMPTS`; then the turn is `failed` and the session waits for the next message. A
  refusal (`sharedLimits`, a 401 / 403) fails the turn at once.
- **The result was lost** (the run completed or parked, the worker died before reporting it): the
  retry finds the `complete` (or `waiting`) snapshot and returns its answer (or its park) without
  running anything.
- **A worker dies while a parked turn's children run**: each child's activity is retried on
  another worker and resumes the child's run; the session starts no second child; the turn goes on
  once they are done. A pipeline's workflow is replayed elsewhere and starts no node visit twice;
  a node whose worker died resumes its run there (see [Pipelines](#pipelines-child-workflows)).
- **A worker dies while a child waits for a person**: nothing is lost and nothing runs - no
  activity is open while it waits. The answer is taken (a signal, accepted with no worker at all);
  any worker replays the child and the session and resumes the child's run from its snapshot and
  its journal: the write runs once.
- **A gateway dies**: nothing is lost. Its streams' clients reconnect to another replica with
  `Last-Event-ID`.
- **Postgres is down**: turns fail and retry; snapshot writes are logged and the run goes on (the
  core's persistence is fail-open, except the resume record, a park and - with the journal, as here -
  the run's first snapshot); events are retried, then dropped with a log.

## Scaling

- **Workers**: more replicas (`--scale worker=N`, `deploy.replicas`, an HPA later). Each runs up to
  `WORKER_MAX_CONCURRENT_TURNS` turns at once on one agent. Workers are interchangeable: any of them
  takes any session's next turn.
- **Gateways**: more replicas behind a load balancer; no affinity needed, SSE included. Each holds one
  LISTEN connection and a pool.
- **Postgres**: connections = replicas × `PG_POOL_MAX` (+1 LISTEN per gateway). Events and the
  journal are the big tables: prune them (`DELETE FROM swarm_events WHERE created_at < now() -
  interval '30 days'`, the same for `swarm_journal`; there is an index for each) - nothing prunes
  them for you. Never prune the journal of a run that may still resume (a parked turn's).
- **The limiter** is one row per bucket: every model call of the swarm takes that row's lock for a
  short transaction. `LIMITER_SCOPE=model` gives each provider + model its own bucket.
- **Temporal**: one task queue (`TEMPORAL_TASK_QUEUE`); heavier deployments split queues or
  partitions on the Temporal side.

## Kubernetes: the Helm chart

[`deploy/helm/agent-swarm`](deploy/helm/agent-swarm/README.md): Deployments for the gateway and
the workers, a Service (and an optional Ingress) for the gateway, the `migrate` Job as a
pre-install / pre-upgrade hook, ConfigMaps for the non-secret environment and the secrets mounted
as `*_FILE` from Secrets you create; an HPA for the gateway, KEDA's Temporal scaler (KEDA v2.17.0+)
or an HPA on CPU for the workers, PodDisruptionBudgets, an optional NetworkPolicy, a ServiceAccount
without a token, non-root read-only pods. Postgres is external; Temporal is external by default,
or the official Temporal chart as a dependency (`temporal.enabled`). The chart's README has every
value.

```bash
helm repo add temporal https://go.temporal.io/helm-charts && helm dependency build examples/swarm/deploy/helm/agent-swarm
helm install swarm examples/swarm/deploy/helm/agent-swarm --set temporal.address=temporal-frontend.temporal:7233
```

## The image

One image, the role is the argument. Published by
[`.github/workflows/swarm-image.yml`](../../.github/workflows/swarm-image.yml) for `linux/amd64`
and `linux/arm64` to `ghcr.io/dudko-dev/agent-swarm` and, when the `DOCKER_USER` / `DOCKER_PAT`
secrets are set, `docker.io/sergdudko/agent-swarm` - on the agent's release tag (`agent-v<version>`:
tags `<version>`, `latest`, `sha-<short>`) and by hand (`workflow_dispatch`: `sha-<short>` unless
the ref is the release tag), with OCI labels (source, revision, version, licenses).

The runtime is distroless (`gcr.io/distroless/cc-debian12`: glibc, no shell, no package manager)
with Node's binary from the official image; the install is pruned by
[`scripts/prune-image.ts`](scripts/prune-image.ts): the workflow bundler (webpack, swc and what only
they need - the bundle is built into the image, so a worker never bundles), the Temporal core
bridge's binaries of the other platforms and its sources, declarations and source maps. 765 MB
before (178 MB compressed), 315 MB after (74 MB compressed), on linux/amd64. Without its bundle
(`WORKFLOW_BUNDLE_PATH` pointing nowhere) a worker in the image cannot bundle at start, and says
so.

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
| `MIGRATE_DATABASE_URL` | `DATABASE_URL` | A role that may change the schema; the gateway and the workers need only `SELECT` / `INSERT` / `UPDATE` on the six tables (the journal's identity column needs nothing more) |

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
| `SUBAGENT_MAX_PER_ROUND` | `4` | Static subagent calls in one round of a turn (1-64); more are refused with a tool error |
| `SUBAGENT_MAX_PER_SESSION` | `50` | Static subagent calls in a session (`0`: none) |
| `PIPELINE_MAX_PER_ROUND` | `2` | Pipeline calls in one round of a turn (1-64); more are refused with a tool error |
| `PIPELINE_MAX_PER_SESSION` | `20` | Pipeline calls in a session (`0`: none) |

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
| `CHILD_ASK` | `park` | What an "ask" of a CHILD's approval (a static subagent, a pipeline node visit) does: `park` - the child's own run waits for a person's answer through the gateway ([Children wait too](#children-wait-too)) - or `deny` (an ask is a denial; nothing parks, as before) |

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
| `AGENT_TOOL_APPROVAL` | `autopilot` | `autopilot` / `read-only` / `ask-writes` / `ask-all` - an "ask" [parks the turn](#parking-a-persons-answer-a-result-from-outside) until a person answers through the gateway |
| `AGENT_TOOL_RULES` | - | JSON: `{"github__delete_*": "deny"}` (`ask` parks, like the mode's asks) |
| `SUBAGENTS` | - | JSON: `{"name": {"description": "...", "model"?: "...", "systemPrompt"?: "...", "tools"?: ["server__tool"], "maxIterations"?: 4, "readOnly"?: true}}` - [static subagents](#static-subagents-child-workflows); `tools` must be the worker's own (MCP_SERVERS); none: a child that only reasons |
| `PIPELINES` | - | JSON: `{"name": {"description": "...", "definition": <the core's PipelineDefinition>, "readOnly"?: true}}` - [pipelines](#pipelines-child-workflows); validated at start; a node's `tools` / `mcpServers` must be the worker's own, its `model` one of the worker's provider; no `skills`, no `settings` |
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
- **The container**: distroless (no shell, no package manager), runs as `node` (uid 1000), the
  code owned by root, a read-only root filesystem (only `/tmp` writable), all capabilities dropped,
  `no-new-privileges`. The Helm chart enforces the same (its values schema refuses less).
- **Requests** are bounded: body size (checked by `Content-Length` and while streaming), message
  length, ids by pattern, the cursor's format and size, the number of open streams, header and
  request timeouts. CORS allows only the listed origins and never credentials.
- **The data at rest is the conversation.** `swarm_events` holds everything the agent emitted (tool
  inputs and outputs included), `swarm_runs` the snapshots, `swarm_journal` every model response and
  tool result, `swarm_parked` the parked items (tool inputs); Temporal's history holds the messages,
  the conversation, the answers, the subagents' answers, and each pipeline's definition, its nodes'
  inputs and outputs and its own events (workflow inputs and activity results).
  Protect both stores (access, backups, encryption at rest); there is no payload codec in this
  version.
- **Answers are untrusted.** Whoever holds a gateway token can answer any item of any session: an
  approval is a person's decision only as far as your authentication in front of the gateway makes
  it one. A tool answer is checked (shape, size, nesting), cleaned and capped by the core like any
  tool result, and the model reads it as a tool result, never as instructions. An answer to a
  child's item goes only to a child of the session in the URL: the gateway finds the item in that
  session alone and recomputes the child's workflow id from the session and the turn's own call
  (never taken from the item's row), and the child checks the answer again.
- Errors answered to clients carry no internals (a `500` is just `internal error`); the details are
  in the log.

## Limits of this version

- **Interactive OAuth for MCP servers does not work across pods.** The authorization redirect comes
  back to one replica, and the token store is per process. Use servers with static headers, the
  non-interactive [enterprise-managed authorization](../../packages/agent/README.md#mcp-with-enterprise-managed-authorization-id-jag),
  or tokens provisioned ahead of time.
- **Sandbox files do not move.** A run's sandbox directory lives in the `/tmp` of the worker that ran
  it; a run resumed on another worker starts with an empty one.
- **Nothing times out a child's question but a stop**: the session's idle timeout does not run
  while its parked turn has children, waiting ones included.
- **A pipeline runs in ONE workflow history**: its definition, every node's input and output and
  its own events are in it - keep `maxRuns` modest (the default is 25; the core allows 1000) and
  node outputs short (each is clipped to 32,000 characters). A pipeline cannot continue-as-new.
- **`remember` on an approval is refused**: the core's "always allow" lasts for one agent
  instance, and the next call may run on any worker.
- **No steering inside a turn**: a message sent while a turn runs waits for the next turn (the
  agent's `RunControl.send` is not wired to the session yet). Stop is.
- **MCP elicitation** (a server asking the user mid-call) is not answered: no `onElicitation`.
- Tool calls of a step a crash interrupted run again (at-least-once; see the core's caveats).
- A run that has no snapshot yet cannot be resumed (the core resumes from a snapshot; a fresh run
  under an id that has journal entries is refused), so the turn's next run asks the planner again.
  That is all such a run journaled: the first snapshot is written right after the plan, before any
  tool call, and with a journal the core does not go on without it (a first snapshot that cannot be
  written - Postgres briefly down - fails the run before its first step, and the activity's retry
  starts the next run).
- Events are never pruned for you; Temporal payloads are not encrypted.

## Next steps

- **MCP elicitation** (a server asking the user mid-call) parked like an approval, once the core
  parks it.

## Development and tests

This is the workspace project `swarm` (`examples/swarm`), with `swarm-shared`
(`examples/swarm-shared`) - its platform-independent part. The swarm's source is TypeScript run
directly by Node (type stripping); its `build` only bundles the workflow code
(`dist/workflow-bundle.js`). `swarm-shared`'s `build` compiles it to `dist` (ESM + `.d.ts`), which
the swarm imports.

```bash
pnpm nx run-many -t typecheck format:check build test -p swarm,swarm-shared   # nothing external
DATABASE_URL=postgres://swarm:swarm@localhost:5432/swarm pnpm nx run swarm:test:integration
```

- **Unit tests of `swarm-shared`** (`examples/swarm-shared/tests/*.test.ts`): the session logic
  (parking, answers, children, caps, markers), the answer checks per kind, the cursor, the pipeline
  workflow's logic with the engine driven as the workflow drives it, a child's wait for a person
  (the answers it takes per kind, a partial answer, a re-park, a closed child; the session's
  notices and markers about it), the HTTP API as a fetch handler driven with `new Request(...)` -
  no sockets (routing, auth, CORS, bounds, error mapping, answers and the lookup and routing of a
  child's item, the listings, the stream: replay, cursor, live, keep-alive, the cap,
  backpressure, the client going away, shutdown) - and what the package ships (built files that
  import nothing but each other; `./workflow` without the HTTP API, a clock or I/O).
- **Unit tests** (`tests/*.test.ts`): the gateway over loopback - the shared handler behind the
  `node:http` adapter - with fakes (routing, auth, CORS, bounds, the stream, backpressure through
  the socket, a client that goes away, answers, the subagent and pipeline routes, what `node:http`
  takes that fetch cannot build), the limiter's math and loop, the SQL builders and the event
  writer, the lease and its fence, the activities in Temporal's `MockActivityEnvironment` (parks,
  resumes, a partial resume, the child activity, a pipeline node's run and route call), the
  subagent and pipeline tools and configs (every refusal), the config, the workflow bundle (the
  engine and `swarm-shared/workflow` in it, none of the agent's main entry, `ai`, `zod`, MCP or
  swarm-shared's HTTP API), the image's prune step, the Helm chart's values schema and its
  variables, and a
  **replay** of recorded histories (`tests/fixtures/*.history.json`: a session from before static
  subagents, two with subagent children, one with a pipeline child, the pipeline workflow and a
  node visit, and - with children that waited for a person - two sessions, a subagent child and a
  node visit that parked and were answered) against this workflow code.
- **Integration tests** (`tests/integration/*.test.ts`) need a **Postgres** (`DATABASE_URL`; they
  migrate it) and start a **Temporal dev server** with `@temporalio/testing` (downloaded once from
  temporal.download; or set `TEMPORAL_CLI_PATH` to a `temporal` binary). The model is the agent
  package's scripted OpenAI-compatible server - no provider, no key. They cover a session end to end
  over SSE, ordering and replay from a cursor, continue-as-new and the idle end, a worker process
  killed mid-turn and the turn finished by another under attempt 2, stop and end, the limiter
  delaying and refusing (alone and inside a turn), snapshot fencing, the journal and its fence
  (the race of a late append against a resume), a superseded run refused everything (and the race
  of a late append, or a late first snapshot, against the supersede), a worker process paused
  (SIGSTOP) before its run's first snapshot and woken after the retry finished the turn (its tool
  call does not run; the turn ends once), the event log and its NOTIFY, a turn parked on a
  person's question and answered through the gateway (the write runs once), a partial answer, a
  partial resume parking again, stop during a park, two subagent calls run as two child workflows
  in parallel, the per-round cap, stop while children run, a worker killed while children run, a
  pipeline call (a wave of two node visits side by side, a routed node, the streams and their
  routes), the pipeline caps, stop during a pipeline, a worker killed mid-node (another
  finishes it; the finished node does not run again; the node's write runs once), and children
  that wait for a person (`child-parking.test.ts`): a subagent child and a pipeline node visit
  that park on a write and are answered through the gateway (the write runs once, the next node
  runs), a deny answer, two children waiting at once and a partial answer, a stop while a child
  waits, `CHILD_ASK=deny`, and a worker killed while a child waits.
  `SWARM_TEST_VERBOSE=1` shows the child workers' output.
- CI: [`.github/workflows/swarm.yml`](../../.github/workflows/swarm.yml) runs both against a
  Postgres service, builds the image (no push) and smoke-tests it, and checks the Helm chart (lint,
  template, kubeconform - see the chart's README). Publishing is `swarm-image.yml`.
