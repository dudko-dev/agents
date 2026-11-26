# CLAUDE.md

> Lives in the `dudko-dev/agents` monorepo at `packages/agent`. The root `CLAUDE.md` has the workspace
> commands (pnpm + nx) and the rules shared by all packages; this file is about this package only.

## Project

`@dudko.dev/agent` — tool-using planning agent over MCP servers, built on the Vercel AI SDK. TypeScript, ESM, Node ≥22.6.

## Layout

- `src/` — library + CLI source (`.ts`, imported with explicit `.ts` extensions)
  - `agent.ts` (`createAgent`, `IAgent`), `runner.ts` (the loop), `planner.ts` /
    `executor.ts` / `replanner.ts` / `synthesizer.ts`, `prompts.ts` (system =
    run-stable, user = dynamic), `call-options.ts` (per-stage SDK options).
  - Feature modules: `thinking.ts`, `limits.ts`, `compaction.ts`, `skills.ts`,
    `approval.ts`, `tool-wrap.ts` (approval gate + tool-call budget + output
    cap, wrapped around every tool's `execute`), `tool-search.ts`,
    `caching.ts` (system breakpoint + rolling message breakpoint),
    `context-editing.ts` (stale tool results → stubs inside a step's loop),
    `subagent.ts` + `subagent-worker.ts` (worker entry, built to
    `dist/subagent-worker.js`).
  - `learning.ts` (`config.learning`: `save_skill` / `forget_skill` write the agent's own lessons
    as skills, `origin.kind: 'learned'`; Memory/Dir stores; secret scan, caps, operator skills
    never overwritten). Knowledge only, never policy: a lesson is loaded under `learnedPreamble`.
    Every guard has a test in `tests/learning*.test.ts` and a mutation check.
  - `sandbox.ts` (`config.sandbox`: the `run_js` tool; one worker thread per run, killed at the
    deadline) + `sandbox-worker.ts` (the worker entry, built to `dist/sandbox-worker.js`: the only
    file that imports the optional peer `quickjs-emscripten`) + `sandbox-engine.ts` (limits, the
    guest's runtime, the module resolver, the worker protocol, what may cross the boundary; pure,
    no imports). The engine is a COPY of the browser sibling's `src/sandbox/engine.ts`, byte for
    byte: change both (`tests/sandbox-engine.test.ts` compares them). The memory limit is the
    WebAssembly memory's maximum, NOT QuickJS's `setMemoryLimit` (which undercounts in this build:
    see the comment at `newBoundedModule`). Computation only here: the Node agent has no workspace.
    Security boundary: every guard has a test in `tests/sandbox*.test.ts` and a mutation check.
  - `structured.ts` (`generateStructured` / `streamStructured`): structured output for the planner,
    the replanner and the pipeline's route call, as `generateText` / `streamText` with
    `Output.object` (AI SDK v7; `generateObject` / `streamObject` are deprecated - do not bring them
    back). It restores what the old calls guaranteed: a failed attempt is always a
    `NoObjectGeneratedError` carrying `usage` and `finishReason` (also when the model returned no
    text), and a provider error of a streamed call is thrown as it is instead of going to
    `console.error`. `tests/v6-integration.test.ts` pins both. The spend of a failed attempt is
    emitted as a `usage` event by the stage (`usageOfError` in `utils.ts`).
  - A replanner failure does not end the run (`runner.ts`): the decision becomes `continue`, the
    `replan.decision` event carries `failed: true` after an `error` event of phase 'replan'. A stop
    and refused credentials (`isAuthError`: 401 / 403) still throw. `tests/replan-failure.test.ts`.
    The browser sibling uses the same names.
  - `call-options.ts` also owns the per-call output caps (`stageOutputCap`): `limits.perCall` wins (0 = no
    cap), otherwise a share of the context window between a floor and a ceiling (`OUTPUT_CAP_SHARES`), and
    none for a stage that thinks (reasoning counts against the cap on OpenAI / Gemini). A call the cap cut
    off is reported (`outputCapNotice`, `withCapHint`). Never add a fixed default number: it is wrong at one
    end of the range of windows.
  - `compaction.ts` also owns the estimate (`estimateTokens`: script-aware, errs high) and the fixed-prompt
    overhead (`promptOverheadTokens`): compaction is judged on prompt + history + trace together against
    `thresholdRatio` (0.85) of the window, never on one part alone. The estimate is calibrated high on Claude's tokenizer (1.1-1.4x real, never below): keep it that way. `agent.usage` is counted from the
    `usage` events as they arrive (`ctx.onUsage`), not summed at the end of a run.
  - `safe-fetch.ts` (`createSafeFetch`: own DNS lookup inside the connect, private / metadata
    ranges refused, allow/deny, redirects re-judged, size/time bounded) + `web-fetch.ts` (the
    `web_fetch` tool that `config.egress` switches on). Security boundary: every change needs a
    test in `tests/safe-fetch.test.ts` and a mutation check.
  - `control.ts` (`createRunControl`: send a message into a running loop, stop one
    subagent). The runner drains it at round / step / final boundaries; messages are
    recorded in `IRunState.userUpdates` and in run snapshots.
  - `provider.ts` (`resolveStage` / model factory per provider), `mcp.ts` (stdio + streamable-HTTP
    MCP connections, reconnect, paginated `tools/list`) + `mcp-oauth.ts` (OAuth 2.1 / DCR provider,
    file-backed tokens) + `mcp-enterprise-oauth.ts` (enterprise-managed authorization / ID-JAG: token
    exchange at the IdP, then the SDK's `jwt-bearer` grant; non-interactive; client secret or
    `private_key_jwt` signed with `node:crypto`; `transportFetch` turns a refused grant into a short
    `EnterpriseOAuthError` and sends the redacted detail to the log. Security boundary: every
    guard has a test in `tests/mcp-enterprise-oauth.test.ts`, which runs the flow against the test IdP
    of `@dudko.dev/test-servers` (`packages/test-servers`), and a mutation check. `assertionAudience` /
    `assertionType` (per hop) switch the client assertion to the RFC 7523 form; the default is the
    rfc7523bis one, and the token endpoint is only ever read from metadata that matched `expectedIssuer`. The browser package carries a copy:
    change both), `tracing.ts` (OpenTelemetry spans, a no-op without an SDK), `utils.ts`
    (retry / timeout / usage helpers).
  - `mcp-shared.ts` (pure, no imports): how a server's `instructions` become a prompt section
    (`renderMcpInstructions`: third-party preamble, every line quoted with `| `, per-server and
    total caps, invisible characters removed; `markMcpTool` / `collectMcpInstructions`: each MCP
    tool carries its server, so only servers with a mounted tool speak) and how `structuredContent`
    reaches the model (`dropStructuredDuplicates`, `withStructuredContent`, `outputSchemaNote`). A
    COPY of the browser sibling's `src/mcp/shared.ts`, byte for byte: change both
    (`tests/mcp-shared.test.ts` compares them and tests every cap and guard; each needs a mutation
    check). The section goes to the planner and the executor only, and `ctx.mcpInstructions` is
    replaced only between runs (prompt caching). A result the SDK client refuses for its
    `outputSchema` is passed on with a note, never thrown (`capturingResultSchema` in `mcp.ts`).
  - `pipeline-engine.ts` + `pipeline.ts` (`createPipeline`: a graph of agents with conditions and
    loops, described in plain JSON). The engine (definition types, `validatePipeline`, the conditions
    with the non-backtracking `matches` matcher, the wave scheduler; pure, no imports) is a COPY of
    the browser sibling's `src/pipeline/engine.ts`, byte for byte: change both, with tests
    (`tests/pipeline-agent.test.ts` compares the two files and the two `tests/pipeline.test.ts`).
    `pipeline.ts` is this package's adapter: a node run by `createAgent`, the route call
    (`generateStructured` on the planner model), `nodeResolver`. A definition is untrusted input: the
    caps, the `otherwise` rule, the condition input bound and the join deferral each need a test
    and a mutation check.
  - `internal.ts` (`IRunState`: the per-run mutable state shared by the runner, the stages and the tool
    wrappers) + `context.ts` (`runContext`, the AsyncLocalStorage that carries run id, emit and state
    into tools). Neither is public API.
  - `cli/` — the `dd-agent` REPL (`start.ts` entry, `args.ts` flags + `--help`, `config.ts` env →
    `IAgentConfig`, `run.ts` the REPL and its slash commands, `live.ts` what a line typed *while* a
    run goes means). A new env var / flag / command goes in `args.ts` (help), `config.ts` /
    `run.ts`, `env.example` **and** the README's CLI section.
  - `index.ts` is exports only.
- `tests/` — `node:test` suites, run via `node --experimental-strip-types`
- `dist/` — `tsup` build output (do not edit)

## Test layers

- `tests/*.test.ts` — units plus `integration.test.ts`, which runs the whole
  loop over real sockets against a scripted OpenAI-compatible endpoint, a real
  MCP server and a real authorization server (`@dudko.dev/test-servers`, a private workspace
  package the browser tests share; `tests/helpers/` keeps only what is this package's own, the
  scripted OpenAI endpoint), and
  `features-integration.test.ts`, which drives thinking, limits, compaction,
  skills, approval, tool search and subagents (worker + in-process) the same
  way. No key, ~7s.
- `tests/live-model.test.ts` — the same loop against a REAL model. Skipped
  unless `AGENT_LIVE_MODEL_URL` points at an OpenAI-compatible endpoint; CI
  starts one via `live-model.yml`. Asserts mechanics only (the loop finished, a
  tool was driven, arguments parsed) — never wording or plan shape, or the
  suite becomes a coin flip nobody trusts.

## Mandatory checks

After **any** change to `.ts` files in `src/` or `tests/`, run:

```bash
pnpm nx run-many -t typecheck format:check build test -p @dudko.dev/agent
```

(or `pnpm run typecheck` etc. inside `packages/agent`).

Do not consider a task done until all four exit cleanly. Run them with the `Bash` tool, do not infer success from "the change looks right".

If dependencies changed, run `pnpm install` at the repo root and ensure it returned 0 before running checks.

## Conventions

- Use `.ts` extensions in relative imports (project relies on `--experimental-strip-types`).
- Zod v4 is used; when passing heterogeneous schemas through a shared array/iterable, type the collection as `z.ZodType` to avoid union-narrowing errors.
- Anthropic's native structured output rejects `maxItems` on arrays — never add `.max()` to Zod arrays that flow into structured output. The guard test in `tests/anthropic-schema-compat.test.ts` enforces this.
- Keep system prompts run-stable (prompt caching): anything that changes per call (history, request, plan, trace) goes in the user prompt. Tests match stages on the role phrases "You are the Planner / Executor / Replanner / Synthesizer" — keep them.
- Tools reach the run through `runContext` (AsyncLocalStorage): emit, current step and the per-run state. Gate logic belongs inside `execute` (see `tool-wrap.ts`), not in the executor's stream loop.
- The public API, config fields, event names and semantics are shared with the browser sibling `@dudko.dev/agent-web`; keep names aligned when changing them.

## Boundaries

- Do not bump the package `version` manually. Versioning is handled by the autoupdate flow / maintainer on release.
- Do not edit `.github/workflows/release.yml` unless explicitly asked — it is the npm-trusted-publisher release pipeline.
- Do not push to `main` directly. Always work on the existing branch you were summoned to.

## When you are working on an autoupdate PR

- Branch will be `chore/autoupdate-<run_id>`.
- Goal: bring `pnpm nx run-many -t typecheck format:check build test` to green.
- Push compatibility fixes onto this branch. Each push re-runs the `CI` workflow automatically once the PR is open.
- If a fix is impossible without changing product behavior, stop and leave a comment explaining what's blocked rather than guessing.

## CI quirks carried over from the standalone repo

The release, live-model, autoupdate and Claude workflows now live at the monorepo root
(`.github/workflows/`, described in the root `CLAUDE.md`). The reasons below still apply; where a
file name or command differs, the root file is right.

This repo follows the unified `autoupdate-with-claude` baseline (same template across siblings). Several workarounds are intentional:
- `autoupdate.yml` uses `GITHUB_TOKEN` and explicitly dispatches `test.yml` (the `CI` workflow) after PR creation, because events created via `GITHUB_TOKEN` don't trigger `pull_request` workflows.
- `autoupdate.yml` dispatches `claude.yml` directly via `workflow_dispatch` instead of relying on an `@claude` PR comment.
- Releases stay wired through `release.yml` (npm Trusted Publisher), which fires via `workflow_run` after a successful CI on `main`. There is no `release-on-version-bump.yml` here — it would conflict with the existing tag/publish chain.
- `release.yml` now `needs:` the `live-model.yml` workflow: a smoke test against a real model (llama.cpp on the runner, no key) gates the publish. It also runs on PRs that touch `package.json` / `package-lock.json`, which is where dependency drift arrives. Deliberately NOT nightly — a 3am failure on yesterday's commit gets ignored, and the question it answers matters at publish time. `LLAMA_IMAGE` / `MODEL_*` are pinned so a rerun downloads nothing and behaves the same; bump them on purpose. `LLAMA_IMAGE` is pinned **by digest**, not by tag: the `server-bNNNN` tags stop at b5350 because the project renamed its tags, so the newest-looking tag was a year-old build that rejects streamed tool calls (`Cannot use tools with stream`) and blocked a release. Resolve `ghcr.io/ggml-org/llama.cpp:server` and paste the digest. A preflight step asserts the server can stream a tool call, so that failure names itself instead of dying inside the agent. 3B is the measured floor — a 1.5B answers from imagination instead of calling the tool (0/3 runs touched it).
- All actions pinned to the `@v4` line because the runner image currently lacks `externals/node24`, breaking post-cleanup of `@v5/@v6` actions.

Do **not** "fix" any of the above by replacing dispatch calls with comment-based mentions, or by bumping action versions back to `@v5/@v6`.
