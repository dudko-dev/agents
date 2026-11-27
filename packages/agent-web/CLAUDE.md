# @dudko.dev/agent-web — instructions for Claude

> Lives in the `dudko-dev/agents` monorepo at `packages/agent-web`. The root `CLAUDE.md` has the workspace
> commands (pnpm + nx) and the rules shared by all packages; this file is about this package only.

Headless, UI-agnostic, **universal in-browser** LLM agent built on the **Vercel
AI SDK** (`ai` v7). One package drives cloud providers (bring-your-own-key),
local WebGPU/WebLLM models, and any AI SDK `LanguageModel` (e.g. Chrome/Edge
built-in AI). It exposes low-level primitives (generate/stream/tool-loop/
structured output) and a high-level **plan → execute → replan → synthesize**
agent. Browser sibling of the Node package `@dudko.dev/agent` — shared shapes,
separate packages.

See [docs/design.md](docs/design.md) for the architecture and the rationale
behind every decision.

## Principles

- **The model is the only seam.** Everything accepts an AI SDK `LanguageModel`,
  supplied directly or via a `ProviderModelSpec` the registry resolves.
- **No UI, no framework, no `node:*` in the core bundle.** Streams typed
  `AgentEvent`s, returns a `RunResult`. Browser Web APIs (IndexedDB, WebGPU,
  WebCrypto) are fine.
- **Two tool-modes over one tool shape.** Native function-calling / structured
  output for capable models; a prompted JSON-salvage fallback (`parse.ts`) for
  tiny local models. `selectToolMode` picks per model.
- **Everything configurable**: models per stage, providers, credentials, tools,
  MCP, prompts, budgets, timeouts, iteration caps, replan/synthesize, memory.
- **Secrets encrypted at rest.** A non-extractable WebCrypto AES-GCM key in
  IndexedDB; API keys never inlined into config. BYOK only — shared keys go
  through a proxy/gateway (see docs/security.md).
- **Optional peers, imported dynamically.** `@ai-sdk/*`, `@browser-ai/*`,
  `@modelcontextprotocol/client`, `@mlc-ai/web-llm` — external in the bundle so
  hosts install and code-split only what they use. `ai`, `zod`, `idb` are deps.
- Tracks **AI SDK v7**, in step with `@browser-ai/*` v3 which peers `ai@^7`.
  (This was pinned to v6 while `@browser-ai/web-llm` still peered `ai@^6`.)
- The public API, config fields, event names and semantics are shared with the Node sibling
  `@dudko.dev/agent`; keep names aligned when changing them.

## Layout

- `src/providers/` — `types`, `registry` (resolveStage/buildModelFromStage),
  `webllm`, `capabilities`.
- `src/secrets/` — `crypto` (AES-GCM key), `vault` (IndexedDBVault),
  `store` (CredentialStore).
- `src/storage/db.ts` — the single IndexedDB owner (keys/secrets/sessions).
- `src/llm/` — `generate`/`stream`/`generateStructured` (`generateText` with `Output.object`: AI
  SDK v7 deprecates `generateObject` / `streamObject`, do not bring them back; the helper keeps a
  failed attempt a `NoObjectGeneratedError` with `usage` and `finishReason`), `tool-loop`, `context-editing`
  (stale tool results → stubs inside one step), `util` (`clip`, prompt helpers,
  `usageOfError`: the spend of a failed structured attempt still counts).
- `src/tools/` — `define`, `prompted` (catalog + dispatch), `mode`, `types`.
- `src/agent/` — `schemas`, `planner`/`executor`/`replanner`/`synthesizer`,
  `runner` (createAgent), `loop-types`, `control` (RunControl: mid-run messages,
  stopping one subagent), `persistence` (run checkpoints / resume), `internal` (per-run
  state and prompt plumbing the stages share; not public).
- `src/memory/` — `store`, `sessions` (IndexedDBStore), `runs` (IndexedDBRunStore /
  MemoryRunStore), `compress` (compaction + `estimateTokens`).
- `src/tools/approval.ts` (consent gate), `search.ts` (find_tools / large
  catalogues), `wrap.ts` (per-run tool wrapping: gate, call budget, output cap).
- `src/tools/egress.ts` — `config.egress` / `web_fetch`: the browser sibling of the server's
  `createSafeFetch` (same policy shape; the pure address/pattern core is a COPY of the server's —
  change both, with tests). Security boundary: a change needs a test and a mutation check.
- `src/tools/web-search.ts` — `config.search` / `web_search`: the host's `engine` function, or the
  ONE built-in provider, `'google'` (Google Search through Gemini grounding: a separate
  `generateContent` call with `google_search`, because the API refuses built-in tools next to
  function declarations). Third-party search APIs are not built in - they are recipes for `engine`
  in docs/capabilities.md; do not add adapters back. The provider's request goes through the
  guarded fetch under `searchEgressPolicy` (allow list = the API's host only, POST only, no
  redirect); its tokens are charged to the run (`addUsage(..., 'search')`); results are filtered
  by the model's `egress` policy. Result URLs are Google redirect links and are NEVER resolved
  here: the filter judges the redirect host, a site name (`searchSiteUrl`) is used only to drop a
  denied site, and the description promises `web_fetch` only when it can open such a link
  (`followRedirects` + a host `egress.fetch`: the redirect host sends no CORS headers). The key is
  never in the config: `credentialRef` into `config.credentials`, read at each call.
  `web-search-shared.ts` (pure, no imports, no clock: caps, result cleaning, the provider as
  request builder / response parser, the error message, redaction, `searchToolResult`, the
  description) is a COPY of the server's `src/web-search-shared.ts`, byte for byte — change both
  (the server's `tests/web-search-shared.test.ts` compares them and
  `tests/helpers/search-server.ts`). Security boundary: every guard has a test in
  `tests/web-search.test.ts` and a mutation check; tests never call a real API.
- `src/tools/media.ts` — `config.media`: `generate_image` / `generate_speech` / `transcribe_audio`
  (each mounted only when its model is set) and the transcription of audio attachments (`attach`,
  called from the runner before planning: the goal gets a fenced, marked transcript, the audio
  never reaches the language model). Models are the AI SDK's (`generateImage` / `generateSpeech` /
  `transcribe`), given as objects or as a spec resolved by `buildMediaModelFromSpec` in
  `providers/registry.ts` (key by `credentialRef`; an inline `apiKey` is refused). Generated bytes
  go to the virtual file system (`media.files`, else the mounted file tools'; none = `createAgent`
  throws) and the result is a path. A call is charged through the tool's run context as a `usage`
  event of phase `'media'` (the flat `mediaCalls` / `imagesGenerated` / `speechCharacters` /
  `transcriptionSeconds` fields of `IUsage`, never tokens) and counted against `media.maxCalls`
  per run (read from the run's usage, so a resume inherits it). `media-shared.ts` (pure, no
  imports: caps, `sniffMediaType` / `acceptMedia`, file names, the budget, the transcript
  wrapper, the descriptions) is a COPY of the server's `src/media-shared.ts`, byte for byte —
  change both (the server's `tests/media-shared.test.ts` compares them and
  `tests/helpers/media-models.ts`). Security boundary: every guard has a test in
  `tests/media.test.ts` (the shared ones in the server package) and a mutation check. Tests run
  on mock models; never a real provider.
- `src/learning.ts` — `config.learning`: `save_skill` / `forget_skill` write the agent's own lessons
  as skills (`origin.kind: 'learned'`); `MemorySkillStore` / `VfsSkillStore`; secret scan, caps, host
  skills never overwritten. Knowledge only, never policy: a lesson is loaded under `learnedPreamble`.
  Browser sibling of the server's `learning.ts` (same names and guards). Every guard needs a test in
  `tests/learning*.test.ts` and a mutation check.
- `src/pipeline/` — `createPipeline`: a graph of agents with conditions and loops, described in
  plain JSON. `engine` (definition types, `validatePipeline`, the conditions with the
  non-backtracking `matches` matcher, the wave scheduler; pure, no imports) is a COPY of the
  server's `src/pipeline-engine.ts`, byte for byte — change both, with tests (the server's
  `tests/pipeline-agent.test.ts` compares the two files and the two `tests/pipeline.test.ts`).
  `index` is this package's adapter: a node run by `createAgent`, the route call
  (`generateStructured`, then plain text), `nodeResolver`. A definition is untrusted input (see
  docs/security.md): the caps, the `otherwise` rule, the condition input bound and the join
  deferral each need a test and a mutation check.
- `src/sandbox/` — `config.sandbox` / the `run_js` tool: the model's code in QuickJS compiled to
  WebAssembly (optional peer `quickjs-emscripten`). `engine` (limits, the guest's runtime, the
  module resolver, the worker protocol, what may cross the boundary; pure, no imports) is a COPY of
  the server's `src/sandbox-engine.ts`, byte for byte — change both (the server's
  `tests/sandbox-engine.test.ts` compares them and tests the engine's guards). `index` is the tool
  (a Web Worker from the host's `sandbox.worker` factory, else the page thread; imported by the
  runner DYNAMICALLY, only when the flag is set — keep it out of `src/index.ts` except for types),
  `files` binds the guest to the VFS of the mounted file tools (each fs call gated under that
  tool's name), `worker` is the `./sandbox-worker` entry — the only file that names the peer.
  Security boundary: every guard has a test (`tests/sandbox.test.ts` here, the engine's in the
  server package) and a mutation check.
- `src/tiers.ts` — `config.executorTiers` / `config.escalation`, the pure rules: which tier a step
  runs on (`pickTier`: the planner's `complexity`, else `standard`; a missing tier falls back to the
  nearest configured one, the stronger of two), what is a failure a stronger model could fix
  (`escalationReasonOf`, `isEscalatableError`), what the escalated attempt is shown, and the write
  guard (`IStepWrites`: a non-read-only call that already succeeded in an earlier attempt at the
  step is answered from its result by `tools/wrap.ts`, not executed again). Same rules and names as
  the Node sibling's `src/tiers.ts`: change both. OFF without `executorTiers.light` / `.strong`:
  `tests/model-tiers.test.ts` compares the calls with `tests/fixtures/requests-without-tiers.json`,
  recorded before the feature existed (`UPDATE_GOLDEN=1` rewrites it after a deliberate prompt or
  schema change). The smallest window among all models, tiers included, governs a run; a tier's
  tool-mode and output cap are its own. Every guard has a test there and a mutation check.
- `src/decision.ts` — `config.decisionModel` / `config.decision`: a decision model answers a closed
  question with an option and a probability instead of writing text. The interface
  (`IDecisionModel.decide`), the guard `askDecisionModel` (below `confidenceThreshold`, default 0.8,
  on an error, a timeout, an answer that is not an option or a confidence that is not a probability
  the ordinary model call runs UNCHANGED), the `decision` event, the usage record (`decisionCalls`:
  a call is not a token) and `decisionModelFromAiSdk` (the AI SDK's experimental
  `experimental_decide`). Imports only `ai`; a COPY of the server's `src/decision.ts`, byte for
  byte - change both (the server's `tests/decision.test.ts` compares them and tests the guard case
  by case). `src/decision-provider.ts` is this package's own: a spec of a hosted decision API a
  page can call (`google` only: CORS decides, see docs/capabilities.md), the key from the
  `CredentialStore` (`credentialRef`; an inline `apiKey` is refused), the request through the
  guarded fetch under `decisionEgressPolicy` (the API's host only, POST, no redirect); the optional
  peer is imported with a variable specifier, like the registry's. Asked at two points:
  `decideReplanWithDecisionModel` (`agent/replanner.ts`) and `pickRouteWithDecisionModel`
  (`pipeline/index.ts`; the engine is not involved). NEVER a security control: not consulted for
  approval, egress or the sandbox. OFF without `decisionModel`: the golden calls of
  `tests/model-tiers.test.ts` must pass untouched. Every guard has a test in
  `tests/decision.test.ts` and a mutation check; no test calls a real API.
- `src/subagent/` — `tool` (createSubagentTool), `worker` (serveSubagentWorker),
  `protocol` (postMessage shapes).
- `src/subagent/dynamic.ts` + `dynamic-shared.ts` — `config.subagents.dynamic`: the
  `spawn_subagent` tool, with which the MODEL starts a helper for a sub-task. A helper is an agent
  ASSEMBLED from the calling agent's own pieces (its model objects, its approval state itself, its
  skills, tool objects picked by name) - never built from the model's arguments, and never with an
  `egress` / `search` / `sandbox` / `media` / `learning` / `memory` of its own; that is what makes
  "a helper can only have less" hold. The helper's config is the caller's MINUS those fields: a new
  config field that mounts a tool must be removed there too, with a test that a helper not given
  the tool does not have it (`media` was missed once, at a merge). The hand-over (`SpawnSeed`) travels in a WeakMap keyed by the helper's
  config object, not in the config. `dynamic-shared` (pure, no imports: the settings, the input
  schema and its validation, narrowing, the budget share, the depth / count guards, the texts,
  `adoptSubagentEvent`) is a COPY of the server's `src/subagent-dynamic-shared.ts`, byte for byte —
  change both (the server's `tests/subagent-dynamic.test.ts` compares them and unit-tests the
  rules). The runner mounts the tool, hands tools their `SpawnRun` through `wrap.ts` and counts a
  helper's tool calls on every run above it. OFF without the switch: the same golden fixture as
  the tiers. Privilege boundary: every guard has a test in `tests/subagent-dynamic.test.ts` and a
  mutation check. In-process only.
- `src/wait-clock.ts` (pure, no imports) — time limits that do not count the time a PERSON takes.
  One clock per run (made in `agent/runner.ts`, on `AgentContext.clock` and
  `ToolRunContext.clock`); the executor's step limit (`chatTimeoutMs`, `deadlineSignal` in
  `agent/executor.ts`, passed to `runToolLoop` as its `abortSignal`) and the `timeoutMs` of every
  subagent the run's tool calls start (`subagent/tool.ts`, `subagent/dynamic.ts`) are its
  deadlines. The consent gate (`tools/approval.ts`, `ApprovalEvents.wait`, given by `tools/wrap.ts`)
  and an MCP question (`call.pause` in `mcp/elicitation.ts`, wired in `mcp/http.ts` from
  `agentRun.clock`, or `subagentCall.pause` for a worker's host tool) pause it for the wait; it goes
  on with what it had left - never reset, never extended past the wait. The waits' own bounds
  (`toolApproval.timeoutMs`, `elicitation.timeoutMs`) are plain timers, NOT on the clock, and a
  stop is passed on at once. Both default to 5 minutes; `0`, `Infinity` and more than 2^31 - 1 ms
  are "no bound", resolved before a timer sees them (`resolveApprovalTimeout` in
  `tools/approval.ts`, `timeoutOf` in `mcp/elicitation.ts`: `setTimeout` fires those after ~1 ms);
  negative / NaN throw at creation; each rule has a test on mocked timers. A subagent tool follows
  its child's events (`followHumanWaits`); a
  host tool asked about by the PARENT's gate pauses the parent's clock and the child's follows
  (`followClock`; a worker child by `tool-wait` messages). A COPY of the server's
  `src/wait-clock.ts`, byte for byte — change both (the server's `tests/wait-clock.test.ts`
  compares them and tests the clock on mocked timers; `tests/human-wait.test.ts` here drives the
  whole loop). Every guard has a test and a mutation check. Without a wait nothing changes.
  The loop's tests run the limits on VIRTUAL time: `tests/helpers/virtual-time.ts` (the same file
  in both packages) puts a time source under the test seam `TEST_TIME` (a `Symbol.for` key on
  `globalThis`, read when a clock is made; not exported, not an API) and a person's wait is a
  `tick` while the question is open. Never go back to real sleeps against short real limits: the
  model's, the sockets' and a worker's real latency counted against them and the suite failed
  under load. `chatTimeoutMs` there is large (it is also the planner's REAL bound); one test
  keeps real timers, with relative bounds only.
- `src/{thinking,limits,caching,skills,images}.ts` — see docs/capabilities.md.
- `src/logger.ts` — `logLevel` / `logger` (leveled, console-like sink; default `warn`).
- Compaction (`memory/compress.ts`, `context-window.ts`) is judged on prompt + transcript + step log together
  against `thresholdRatio` (0.85) of the window; `estimateTokens` is calibrated high on Claude's tokenizer
  (1.1-1.4x real, never below): keep it that way. `agent.usage` / `sessionUsage` count from the usage as it
  arrives (`charge`), not at the end of a run; per-call output caps default to shares of the window
  (`stageOutputCap` in `config.ts`, the Node sibling's rules: the host's value wins, 0 = no cap, none for a
  stage that thinks, a cut-off call is reported with `outputCapNotice`; only the share sizes differ). A
  replanner that fails both attempts degrades to `continue` and says so (`replan.decision.failed`, an
  `error` event of phase 'replan'): same names as the Node sibling, `tests/replan-failure.test.ts`.
- `src/context-window.ts` — the model's real window (read from WebLLM models),
  compaction sized to it, tool search by definition size, the clear
  `ContextWindowExceededError`.
- `src/files/` — `vfs` (VirtualFileSystem, IndexedDB `files` store) + `tools`
  (createFileTools). `fs_write` / `fs_delete` (and the sandbox's `fs.writeFile`, `sandbox/index.ts`)
  emit `file.written` / `file.deleted` through the tool's run context, AFTER the write succeeded:
  it is how a UI knows the files of a turn. Browser only - the Node sibling has no VFS.
- `src/mcp/` — optional HTTP connector (`./mcp` subpath): `http` (transport,
  mount, refresh) + `oauth` (OAuth 2.1 / DCR provider, vault-backed tokens) + `enterprise-oauth`
  (enterprise-managed authorization / ID-JAG: token exchange at the IdP, then the SDK's `jwt-bearer`
  grant; non-interactive; client secret or `private_key_jwt` signed with WebCrypto). A copy of the Node
  package's `mcp-enterprise-oauth.ts` except for the signing section - change both.
  Security boundary: every guard has a test in `tests/mcp-enterprise.test.ts` and a mutation check.
  That suite mocks `fetch`; its last tests run over real sockets against `@dudko.dev/test-servers`
  (`packages/test-servers`, a dev dependency), whose IdP and authorization server each accept one form
  of client assertion (`assertionAudience` / `assertionType`) and refuse the other.
  `shared` (pure, no imports; the core imports it too, so it must never import the SDK): how a
  server's `instructions` become a prompt section (third-party preamble, every line quoted, caps)
  and how `structuredContent` reaches the model. A COPY of the server's `src/mcp-shared.ts`, byte
  for byte — change both (the server's `tests/mcp-shared.test.ts` compares them and tests every
  cap and guard; each needs a mutation check). The section is appended in `stageCall`
  (`agent/internal.ts`) for the planner and the executor only, from text fixed in `createAgent`.
  A result that breaks its tool's `outputSchema` is passed on with a note, never thrown
  (`outputSchemaViolation` in `http.ts`).
- `src/mcp/elicitation.ts` (pure, no imports; `ConnectMcpOptions.onElicitation` /
  `.elicitation`) — MCP elicitation: a server asks the USER for input during a tool call and the
  host's callback answers. The limits, what a request must be before the host sees it
  (third-party text cleaned and capped, the form restricted to the flat subset of the
  specification, a link only https or loopback http - handed over, never opened: no
  `window.open`, no fetch), what an answer must be before the server sees it, the one function
  that asks (helpers refused unless `elicitation.subagents`, caps per tool call and per run,
  timeout, abort, a failed handler = cancel) and the session that drives a tool call in both
  revisions (2025: the `elicitation/create` handler, calls to that server ONE AT A TIME, the
  call's own 60 s clock stopped while a question waits - and the run's clock too, see
  `wait-clock.ts`; 2026-07-28: `input_required` answered
  and the same call sent again, never after an automatic answer). A COPY of the server's
  `src/mcp-elicitation.ts`, byte for byte — change both (the server's
  `tests/mcp-elicitation-shared.test.ts` compares them and tests every guard). `http.ts` wires
  it and reads the run STRUCTURALLY from `options.agentRun` (`emit`, `step`, `runId`,
  `subagent`, `elicitations` - set by `tools/wrap.ts`; the per-run counter is made in
  `agent/runner.ts` and handed to helpers through `SpawnSeed`) and `options.subagentCall` (the
  mark `subagent/tool.ts` puts on every tool it gives a child: a new way to hand a child tools
  must mark them too). The option is on the CONNECTION because the capability is in the
  handshake; the Node sibling has the same names on its agent config. OFF without
  `onElicitation`: no capability, the same `client.request` call, no new header
  (`tests/mcp-elicitation.test.ts` compares the wire with the fixture). A consent boundary: the
  answer must never reach the model's context, an event, a log or a checkpoint
  (`tests/mcp-elicitation-agent.test.ts` looks for it in each); every guard has a test and
  needs a mutation check. Docs: README (MCP), `docs/capabilities.md`, `docs/security.md`,
  `docs/design.md`.
- The MCP client is the official 2.x SDK, `@modelcontextprotocol/client` (the optional peer of
  `./mcp`; `@modelcontextprotocol/sdk` 1.x is gone from this package - the test servers and the
  React package's e2e servers keep it, as real 1.x SERVERS). The JSON Schema validator is imported
  from its `/validators/cf-worker` subpath: the engine the SDK's root entry already bundles under
  the `browser` export condition (so it costs a browser bundle nothing), pure JS with no code
  generation (CSP), and the same engine in the Node-run tests as in a page - never
  `/validators/ajv` (`new Function`, and ~295 kB) and never the internal `/_shims`.
  The revision is a per-server opt-in, `McpHttpServerConfig.protocol: 'legacy' | 'auto' |
  'modern'` (`mcpProtocolMode` / `mcpVersionNegotiation` in `shared.ts` map it to the SDK's
  `versionNegotiation`: nothing is passed for `'legacy'`, `'auto'`, a pin to 2026-07-28 for
  `'modern'`). Without the field the client is built with the options it always had: the same
  wire and the same CORS request headers - `tests/mcp-protocol.test.ts` compares every request
  (method, headers, body) with `tests/fixtures/mcp-wire-without-protocol.json`, RECORDED before
  the option existed (`tests/helpers/mcp-wire.ts`; re-record only after a deliberate change of
  the 2025 wire), and runs each mode against the `legacy` / `dual` / `modern` test servers. On a
  modern connection: `Mcp-Method` / `Mcp-Name` are set by the transport from the message (so
  `client.request` is enough; `Mcp-Param-*` is `callTool`'s own and is not sent), tool list
  changes need `client.listen` (opened at connect when `onToolsChanged` is given; never opened
  again), `inputRequired.autoFulfill` is off and an `input_required` answer fails the call
  unless `onElicitation` is set (then `elicitation.ts` answers it). CORS: a page's SDK reads a BLOCKED probe as "a 2025 server"
  (it decides by `window` + `document`), so `http.ts` remembers a network-level failure seen
  during the probe (`ProbeState.blocked`) and `diagnoseMcpCors(url, fetch, { protocol })` tries
  each 2026 header on its own to name the ones the server's `Access-Control-Allow-Headers`
  lacks; `tests/mcp-protocol-cors.test.ts` plays the browser's preflight against the test
  server's `cors` probe fault. The negotiated revision is in `ConnectedMcp.protocols`. Docs: README
  (MCP + CORS), `docs/capabilities.md`, `docs/security.md`. `http.ts`
  deliberately does NOT use the typed verbs: `tools/list` goes page by page through
  `client.request` (`listAllTools`: our page cap `MAX_TOOL_LIST_PAGES` and repeated-cursor guard;
  `client.listTools()` would aggregate, throw past its own cap, skip servers without the tools
  capability and switch on the SDK's output check), and `tools/call` through `client.request` too
  (`client.callTool` throws on a result that breaks the `outputSchema` and takes the result with
  it). A 403 `insufficient_scope` never starts an interactive authorization
  (`onInsufficientScope: 'throw'` for a provider with a `redirectUrl`). All of it mirrors the Node
  sibling's `src/mcp.ts` / `mcp-oauth.ts`: change both. OAuth guards on this boundary - the `iss`
  check (and `iss` handed to the SDK's `auth()`), the refusal of a callback without discovery
  state, the issuer stamp surviving storage, the scope policy - each have a test in
  `tests/mcp.test.ts` and need a mutation check.
- `src/webmcp/` — optional `./webmcp` subpath: publish a ToolSet through the browser's WebMCP API
  and use a page's WebMCP tools as one. No dependency; a no-op where the browser has no WebMCP.
- `src/{parse,prompts,events,config,index}.ts`.
- `tests/` — `node --test` with `--experimental-strip-types` (Node ≥ 22.6);
  tests import from `dist` (pretest builds).

## Commands

```bash
pnpm nx typecheck @dudko.dev/agent-web     # tsc --noEmit
pnpm nx format:check @dudko.dev/agent-web  # prettier
pnpm nx build @dudko.dev/agent-web         # tsup → dist (ESM + CJS + d.ts; entries: ., ./mcp, ./webmcp, ./sandbox-worker; + dist/agent-web.js)
pnpm nx test @dudko.dev/agent-web          # node --test tests/*.test.ts (nx builds first: tests import dist)
```

CI (the root `.github/workflows/ci.yml`) runs typecheck → format:check → build → test for every
package. Keep all four green before pushing.

## Conventions

- Prettier: no semicolons, single quotes, trailing commas, width 100.
- Docs live next to the code (the README goes to npm; `docs/*.md` are published on the site, not in the npm package). A new config field, event, export or entry point goes in the README
  (config table), `docs/capabilities.md` (the section + the event reference) and, if it can hurt
  someone, `docs/security.md`. A new design decision gets its rationale in `docs/design.md`.
- Keep the core free of DOM-UI, framework, and `node:*` imports. Use
  `globalThis.crypto` (WebCrypto), never `node:crypto`. Anything Node-only
  (stdio MCP, fs) belongs in the sibling package, not here.
- New providers: add to the `ProviderType` union + `PROVIDER_PACKAGE` map +
  the `buildModelFromStage` switch, and declare the peer as optional.
