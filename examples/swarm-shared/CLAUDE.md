# CLAUDE.md

> The workspace project `swarm-shared` at `examples/swarm-shared`. The root `CLAUDE.md` has the
> workspace commands and the shared rules; `examples/swarm/CLAUDE.md` has the swarm's (its README is
> the user's guide: the architecture, the API, the semantics). This file is about this package only.

## What it is

The platform-independent part of the agent swarm: what every platform's swarm (Temporal + Postgres
in `examples/swarm` today; Cloudflare, GCP and AWS next) shares so that they expose the SAME HTTP API
with the same session semantics. **Private, never published** (not in
`.github/scripts/release-plan.mjs`; keep it out). No version bumps, no CHANGELOG.

- `./workflow` - what a workflow may import: the session's logic as plain functions over plain data
  (`session-state.ts`), a child's wait for a person (`child-state.ts`), the pipeline workflow's
  logic (`pipeline-state.ts`), the answer checks per kind (`answers.ts`), the ids and stream keys
  (`session-ids.ts`), the shapes (`session-types.ts`).
- `.` - all of that, plus the event cursor (`cursor.ts`), the HTTP API as a fetch-style handler
  (`gateway.ts`: `createGatewayHandler(deps) -> { fetch(request): Promise<Response>, closeStreams }`),
  its plumbing (`http.ts`: bodies, the bearer check, CORS), what it needs from a platform
  (`platform.ts`: `ISessionBackend`, `IEventFeed`, the row types, the errors a backend throws) and
  the JSON logger (`log.ts`). `index.ts` and `workflow.ts` are exports only.

## Rules

- **No platform in here.** No `node:*`, no `process` / `Buffer`, no dependency at runtime (the
  `@dudko.dev/agent` imports are types only): Web-standard APIs - `Request`, `Response`, `Headers`,
  `ReadableStream`, `TextEncoder` / `TextDecoder`, `crypto` (`randomUUID`, `subtle`),
  `AbortController`. The build compiles against the WebWorker lib without Node's types, so a Node API
  in `src` fails `build`; `tests/package.test.ts` checks the built files import nothing but each
  other.
- **`./workflow` is deterministic.** Its modules import only each other (and types): no clock (the
  caller passes `now`), no randomness, no I/O. The swarm's Temporal bundle takes them
  (`examples/swarm/tests/bundle.test.ts`: none of the HTTP API comes with it), and sessions REPLAY on
  them: a change that alters what a running session does (the commands it makes, their order, the
  markers) is a replay break - see `examples/swarm/CLAUDE.md` (`patched()`, the recorded histories in
  `examples/swarm/tests/fixtures`). Run the swarm's `tests/replay.test.ts` after any change here.
- **Persisted formats never change.** The ids (`workflowIdOf`, `subagentWorkflowIdOf`, ...), the
  stream keys (`<session>/<item>`, `<session>/<item>/<node>/<visit>`), the cursor
  (`<turn>:<attempt>:<seq>`) and the marker seq slots are stored in Postgres and Temporal.
- **The gateway is the security boundary for answers**: every guard of the answer route (the item's
  session, the parent call's session, the recomputed child id - `childOwnerOf` -, the closed item,
  the per-kind check) has a test in `tests/gateway.test.ts` and a mutation check. So do the event
  stream's limits and the client going away.
- The handler never rejects: every failure is an answer (a 500 says only `internal error`, the log
  has the rest). An event stream ends on the body's `cancel` (the client is gone), the request's
  `signal`, or `closeStreams()`; a frame waits until the reader took the one before it
  (backpressure).
- Imports with `.ts` extensions; `build` (tsc, `rewriteRelativeImportExtensions`) emits `.js`.

## Packaging

The swarm runs its own sources with Node's type stripping, which Node refuses under `node_modules`;
the image's `pnpm deploy` COPIES this package into `node_modules`. So it ships built JS: `build` is
`tsc -p tsconfig.build.json` -> `dist` (ESM, `.d.ts`, maps), one file per module; `exports` point at
`dist`. tsc rather than a bundler: no new tool, the emitted code is the source minus its types, file
for file, and `./workflow` stays a set of modules of their own. nx builds it before anything that
depends on it (`dependsOn: ^build`); its own tests read `src` (type stripping, the real path is
outside `node_modules`) and, for `tests/package.test.ts`, `dist`.

## Tests

`tests/*.test.ts` (`test`): nothing external, no sockets - the session logic, a child's wait, the
pipeline logic with the engine driven as a workflow drives it, the answers, the cursor, the handler
driven with `new Request(...)` (routing, auth, CORS, bodies, error mapping, answers and a child's
item, the listings, the stream: replay, cursor, live, keep-alive, the cap, backpressure, the client
going away, shutdown), and what the package ships. A platform's own tests (sockets, its services)
live with the platform: the swarm's `tests/gateway.test.ts` runs this handler behind its `node:http`
adapter.

```bash
pnpm nx run-many -t typecheck format:check build test -p swarm-shared,swarm
```
