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
    The limit's clock starts at `onStart` (the program's first instruction), not at the engine's own
    start, which `startupMs` bounds instead; `tests/helpers/sandbox-slow-start.ts` reproduces a slow
    start (a busy machine) on every run.
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
  - `web-search.ts` (`config.search`: the `web_search` tool - the host's `engine` function, or the
    ONE built-in provider, `'google'`: Google Search through Gemini grounding, a separate
    `generateContent` call with `google_search`, because the API refuses built-in tools next to
    function declarations. Third-party search APIs are not built in - they are README recipes for
    `engine`; do not add adapters back. The provider's request goes through `createSafeFetch`
    under `searchEgressPolicy` - the allow list is exactly the API's host, POST only, no redirect -
    its tokens are a `usage` event of phase `'search'`, and results are filtered by the model's
    `egress` policy. Result URLs are Google redirect links and are NEVER resolved here: the
    filter judges the redirect host, a site name (`searchSiteUrl`) is used only to drop a denied
    site, `web_fetch` follows a link with every hop re-judged) + `web-search-shared.ts` (pure, no
    imports, no clock: caps, cleaning of results, the provider as request builder / response
    parser, the error message - status and the API's code word, never its text -, key redaction,
    `searchToolResult`, the tool's description). The shared
    file is a COPY of the browser sibling's `src/tools/web-search-shared.ts`, byte for byte: change
    both (`tests/web-search-shared.test.ts` compares them, and the two copies of
    `tests/helpers/search-server.ts`, the local imitation of a grounded Gemini answer in the
    shapes recorded live on 2026-11-26). Security boundary:
    every guard has a test in `tests/web-search*.test.ts` and a mutation check; the key must never
    reach a URL, an event, an error, a result or a snapshot. Tests never call a real search API.
  - `media.ts` (`config.media`: `generate_image` / `generate_speech` / `transcribe_audio`, each
    mounted only when its model is set, and `run({ files })` - audio attachments transcribed once
    and put under the input as a fenced, marked transcript by `attachRunFiles`, called from
    `runner.ts`) + `media-shared.ts` (pure, no imports: the caps, `sniffMediaType` / `acceptMedia` -
    what a file is, is read from its bytes -, `mediaFileName`, `IMediaUsage`, the per-run budget,
    the transcript wrapper, the descriptions). The shared file is a COPY of the browser sibling's
    `src/tools/media-shared.ts`, byte for byte: change both (`tests/media-shared.test.ts` compares
    them, and the two copies of `tests/helpers/media-models.ts`, the mock models). Models are the AI
    SDK's (`generateImage` / `generateSpeech` / `transcribe`), given as objects or as a stage block
    resolved by `buildMediaModelFromStage` in `provider.ts`. Bytes never reach the language model:
    files go to `<sandboxRoot>/<runId>/media/` (or `media.dir`), the result is a path. A call is a
    `usage` event of phase `'media'` (the flat `mediaCalls` / `imagesGenerated` / `speechCharacters` /
    `transcriptionSeconds` fields of `IUsage`, never tokens - flat numbers so that every generic
    usage sum, the pipeline's included, carries them), counted against
    `media.maxCalls` per run; `maxRetries: 0` on purpose. Security boundary: every guard has a test
    in `tests/media*.test.ts` and a mutation check. Tests never call a real provider.
  - `control.ts` (`createRunControl`: send a message into a running loop, stop one
    subagent). The runner drains it at round / step / final boundaries; messages are
    recorded in `IRunState.userUpdates` and in run snapshots.
  - Scale-out HOOKS (README, "Running on many workers"): small optional hooks, the host brings the
    broker / store - NO broker code, no runtime dependency here. Without them nothing changes: no
    timer, the models not even wrapped, the golden fixtures untouched (`tests/model-tiers.test.ts`
    also runs the golden requests WITH both hooks on and gets the same wire).
    - Event order (`runner.ts`, both cores, same names): every event of a run is tagged in ONE
      place (`dispatch` in `runAgentLoop`: the run's fixed `runId`, `seq` from 1 per attempt,
      `attempt`), so a subagent envelope emitted from inside the child's run context still
      carries the PARENT's id. `IRunSnapshot.attempt`; a resume runs as `resumeAttemptOf` (+1) and
      records it BEFORE any event (`recordResume`: `onRunResume`, else `onStepComplete`) - NOT
      fail-open, a throw refuses the resume; `resolveResume` refuses an attempt that is not a
      positive integer. `tests/event-order.test.ts` (both packages).
    - `run-lease.ts` (`config.runLease`, Node only: `resolveRunLease` - ttl 1000..2^31-1, owner,
      methods - `holdRunLease` - acquire, renew every ttl/3, lost on false / throw / no answer
      within ttl, `release`, `RunLeaseError`). STRICT: acquired before anything of a run (a resume
      even before `loadRun`); a lost lease aborts the run's signal (combined into the run's own)
      and `callPersistence` writes NOTHING more; one `lease.lost` event; the run rejects with the
      `RunLeaseError`; a lost lease is not released. Helpers and subagents never take one (the
      helper's ctx drops `lease` and its config `runLease`, `subagent.ts` drops `runLease`). Its
      timers have a test seam of their OWN (`Symbol.for('@dudko.dev/agent:run-lease-test-time')`,
      `tests/helpers/lease-time.ts`), never the wait clock's; real timers are unref'd; a child
      process (`tests/fixtures/run-lease-exit.ts`) proves no way out leaves one. Every guard has a
      test in `tests/run-lease.test.ts` and a mutation check.
    - `shared-limits.ts` (`config.sharedLimits`, Node only): one AI SDK middleware
      (`wrapLanguageModel`) around the stage's model, applied AT THE CALL SITE (`stageModel(ctx,
      stage, model)`, `limitedModel` for the pipeline's route call): the planner model serves the
      planner, the replanner and the route call, the synthesizer model the answer and the summaries,
      so the stage is named where the call is made. A new language-model call MUST go through it
      (`tests/shared-limits.test.ts` counts the hook's calls per stage against the endpoint's log).
      The hook in force is the run's (`IRunContext.sharedLimits`: the agent's own, else the run
      above it - an in-process subagent), `call.runId` the ROOT run (`IRunContext.rootRunId`); a
      worker child asks the parent over the worker protocol (`model-call` / `model-call-result` /
      `model-call-end`). A refusal is `ModelCallRefusedError`, never retried (`withRetry` checks
      `isModelCallRefused` in `utils.ts` before anything else) nor escalated (`tiers.ts`); a wait
      counts against the call's own timeout (not the wait clock); a slot given after the call was
      given up gets `afterModelCall(ok: false)`. Media, search grounding and decision models are
      NOT wrapped, deliberately.
    - Remote subagents (`subagent.ts`, `isolation: 'remote'`, `dispatch(task, { signal, emit })`):
      no config crosses (`config` / `tools` / a profile's `config` refused); what comes back is
      untrusted (`remoteSubagentEventOf`: plain object, `type` pattern, size, `REMOTE_SUBAGENT_LIMITS`
      count, nothing after settle; `remoteSubagentUsageOf`: non-negative counts); usage charged
      ONCE from the result (forwarded `usage` events are not charged); a stop aborts `signal` and
      does not wait for the dispatch. Every guard has a test in `tests/subagent-remote.test.ts`.
    - `examples/scale-out-memory.ts`: in-memory reference implementations (lease map with TTL,
      token bucket + per-run budget), typechecked with the package and exercised by
      `tests/scale-out-example.test.ts`.
  - `provider.ts` (`resolveStage` / model factory per provider), `mcp.ts` (stdio + streamable-HTTP
    MCP connections, reconnect, paginated `tools/list`) + `mcp-oauth.ts` (OAuth 2.1 provider,
    file-backed tokens; `registration: 'auto' | 'cimd' | 'dcr'`, the browser sibling's names and
    rules - change both; every rule a test in `tests/mcp-oauth-registration.test.ts`, the same tests
    in both packages, and a mutation check) + `mcp-enterprise-oauth.ts` (enterprise-managed authorization / ID-JAG: token
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
    replaced only between runs (prompt caching). A result that breaks its tool's `outputSchema`
    is passed on with a note, never thrown (`outputSchemaViolation` in `mcp.ts`).
  - MCP Apps (`io.modelcontextprotocol/ui`) are NOT here, deliberately: the browser sibling has
    them (`apps` on its connection, `mcp.app`, `approveAppToolCall`) and its React package draws
    them; this package renders nothing (README, "MCP Apps: not in this package"). If they are
    added, keep the browser's names, its "off = the recorded wire" test and its guards.
  - `mcp-elicitation.ts` (pure, no imports; `config.onElicitation` / `config.elicitation`): MCP
    elicitation - a server asks the USER for input during a tool call and the host's callback
    answers. The limits, what a request must be before the host sees it (third-party text
    cleaned and capped, the form restricted to the flat subset of the specification, a link only
    https or loopback http), what an answer must be before the server sees it (checked against
    the form, no field that was not asked for), the one function that asks
    (`answerMcpElicitation`: helpers refused unless `elicitation.subagents`, caps per tool call
    and per run, timeout, abort, a failed handler = cancel) and the session that drives a tool
    call in both revisions (`createMcpElicitationSession`: 2025 = the `elicitation/create`
    request handler, calls to that server ONE AT A TIME because the request does not name its
    call, the call's own 60 s clock stopped while a question waits - and the run's clock too,
    `call.pause`, see `wait-clock.ts`; 2026-07-28 = `input_required`
    answered and the same call sent again with `inputResponses` + `requestState`, never after an
    automatic answer). A COPY of the browser sibling's `src/mcp/elicitation.ts`, byte for byte:
    change both (`tests/mcp-elicitation-shared.test.ts` compares them and tests every guard).
    `mcp.ts` only wires it: the session per server (made before the client: the capability is in
    the handshake), `allowInputRequired` per call, the run context (emit, step, run id, the
    helper mark from `state.spawn`, the per-run counter kept on the ROOT run's state). OFF
    without `onElicitation`: no capability, the same `client.request` call as ever -
    `tests/mcp-elicitation.test.ts` compares the wire with
    `tests/fixtures/mcp-wire-without-protocol.json`. A consent boundary: the answer must never
    reach the model's context, an event, a log, a span or a snapshot
    (`tests/mcp-elicitation-integration.test.ts` looks for it in each); every guard has a test
    and needs a mutation check. One test takes over a minute and runs only with
    `MCP_ELICITATION_SLOW=1` (the SDK's 60 s request timeout is out of the way while a question
    waits). The REPL's side is `cli/elicit.ts` (`AGENT_MCP_ELICITATION`; pure but for the `ask`
    it is given; `tests/cli-elicit.test.ts`).
  - The MCP client is the official 2.x SDK, `@modelcontextprotocol/client` (stdio from its
    `/stdio` subpath, the JSON Schema validator from `/validators/ajv`); `@modelcontextprotocol/sdk`
    1.x is gone from this package (the test servers keep it, for their `legacy` mode).
    The revision is a per-server opt-in, `protocol: 'legacy' | 'auto' | 'modern'` (both config
    shapes; `mcpProtocolMode` / `mcpVersionNegotiation` in `mcp-shared.ts` map it to the SDK's
    `versionNegotiation`: nothing is passed for `'legacy'`, `'auto'`, a pin to 2026-07-28 for
    `'modern'`). Without the field the client is built with the options it always had and the wire
    does not move: `tests/mcp-protocol.test.ts` compares every request (method, headers, body)
    with `tests/fixtures/mcp-wire-without-protocol.json`, RECORDED before the option existed
    (`tests/helpers/mcp-wire.ts`; re-record only after a deliberate change of the 2025 wire). The
    same suite runs each mode against the `legacy` / `dual` / `modern` test servers. On a modern
    connection: `Mcp-Method` / `Mcp-Name` are set by the transport from the message (so
    `client.request` is enough; `Mcp-Param-*` is `callTool`'s own and is not sent), tool list
    changes need `client.listen` (opened at connect when `onToolsChanged` is given, and opened
    again by `mcp-listen.ts` when it ends), `inputRequired.autoFulfill` is off and an `input_required` answer is a `McpToolError`
    unless `onElicitation` is set (then `mcp-elicitation.ts` answers it), a stdio probe runs on a sibling process and is bounded by
    `MCP_STDIO_PROBE_TIMEOUT_MS`. The negotiated revision is in `IConnectedMcp.protocols`. Same
    names and rules in the browser sibling: change both. `mcp.ts` deliberately
    does NOT use the typed verbs: `tools/list` goes page by page through `client.request`
    (`listAllTools`: our page cap and repeated-cursor guard; `client.listTools()` would aggregate,
    throw past its own cap, skip servers without the tools capability and switch on the SDK's
    output check), and `tools/call` through `client.request` too (`client.callTool` throws on a
    result that breaks the `outputSchema` and takes the result with it). A 403 `insufficient_scope`
    never starts an interactive authorization (`onInsufficientScope: 'throw'` for a provider with a
    `redirectUrl`). OAuth guards on this boundary - the `iss` check, the refusal of a callback
    without discovery state, the issuer stamp surviving the store, the scope policy - each have a
    test in `tests/mcp-connect.test.ts` and need a mutation check.
  - `mcp-listen.ts` (pure, no imports): the 2026-07-28 `subscriptions/listen` stream kept open
    (`createMcpListenSupervisor`, used by `listenForToolChanges` in `mcp.ts`). A stream that ends
    while the connection is open - dropped, or closed by the server with its result - is opened
    again with exponential backoff and jitter (`mcpListenRetryDelay`: 1 s doubled up to 60 s, less
    up to half), the count reset only by a stream that stayed up `MCP_LISTEN_STABLE_MS`, given up
    after `MCP_LISTEN_MAX_ATTEMPTS` in a row; final at once on 401 / 403 / 404 / 405 / -32601 /
    -32602 (`mcpListenFinalReason`). Once a stream is back it calls the SAME `onToolsChanged` the
    notice calls (the agent re-lists as after a notice). `close()` stops every listener BEFORE the
    clients close (and so does every failed-connect path). Its timers (`setTimeout`) have a test
    seam of their OWN (`Symbol.for('@dudko.dev/agent:mcp-listen-test-time')`, driven by
    `tests/helpers/listen-time.ts`, the same file in both packages) - never the wait clock's: the
    agent always passes `onToolsChanged`, and a listen timer on that seam made the human-wait
    tests see a run deadline running while a person was asked. A COPY of the browser sibling's
    `src/mcp/listen.ts`, byte for byte: change both (`tests/mcp-listen.test.ts` compares them and
    tests every rule on fakes; `tests/mcp-protocol.test.ts` drives it against the test server's
    `listenFaults` / `dropListenStreams` / `closeListenStreams` on virtual time, and a child
    process, `tests/fixtures/mcp-listen-exit.ts`, proves close leaves no timer). Every rule needs
    a mutation check. No setting, by design (the browser's `docs/design.md` says why).
  - `mcp-skills.ts` (pure, no imports; `skills: true` on a server, EXPERIMENTAL - the MCP Skills
    extension `io.modelcontextprotocol/skills`, Beta, written against 2026-07-28): the rules on a
    server's entries (`mcpSkillEntryRefusal`: URI last segment = frontmatter name, the naming
    rules, `"dynamic"` declined unless `{ dynamic: true }`, complete file list inside the skill,
    sha256 digests, the 512-file / 16 MiB limits), the catalog names (`assignMcpSkillNames`: `<server>/<skill>` by the HOST's
    label - no host skill or lesson name can hold a "/", so nothing shadows anything), the caps
    (`selectMcpSkills`, 32 per server / 64 in all; body / file / description caps), the preamble
    (`mcpSkillPreamble`: knowledge, never policy), the file rule (`resolveMcpSkillFile`: only what
    the LOADED entry lists, never a URI / absolute / `..`), the mark that carries a server's
    skills on its tools (`markMcpSkills` / `collectMcpSkillSources`, like the instructions: a
    server with no mounted tool offers none) and one server's catalog over the SDK's
    `SkillsClient` (`createMcpSkillCatalog`: list, `get` one by URI (`skills/get`, kept in
    `source.added`), load SKILL.md, read a file against the held entry - the SDK verifies size,
    digest and frontmatter), a skill by URI (`mcpSkillUriRefusal`: `skill://` only;
    `resolveMcpSkillServer`: the server the model names, never a search; `mcpSkillRoomRefusal`;
    `assignAddedMcpSkillName`) and the person's consent before a skill's text enters the context
    (`McpSkillConsent` `'once-per-skill'` default / `'ask'` / `'never'`, per server `skills:
    { consent }` over `config.mcpSkills.consent`; `decideMcpSkillConsent` / `recordMcpSkillConsent`,
    the grant bound to `mcpSkillGrantKey` - server, URI, every digest; nested skills
    (`mcpSkillEnclosingUri`) never covered by another yes; `mcpSkillConsentView` - the body is
    the model's text exactly), and a directory of a skill (`read_skill_file` on a directory, for
    every kind of skill: `skillDirectoryRef` - root `''` / `.` / `./` / `/`, never a URI, `..`,
    `?`, `#` or `\` -, `skillDirectoryChildren` / `skillDirectoryOf`, `resolveMcpSkillPath` - a
    listed file wins -, `skillDirectoryListing` - `{ name, directory, files, directories, more?,
    notServed?, note? }`, 64 at most). The listing comes from the HELD entry; with `directoryRead`
    declared, the catalog's `readDirectory` (present only then) sends `resources/directory/read` to
    that server for `<root>[/<dir>]` and `compareMcpSkillDirectory` only counts what it lists
    beyond the entry (never named: `mcpSkillDirectoryNote` is counts only) and marks `notServed`;
    a change logs a `warn` and calls `onChanged` (wired to `onToolsChanged`: the deferred
    refresh) once per held entry; a failed read = the entry alone. GENERATED skills
    (`"resources": "dynamic"`) are declined unless the server's `skills: { dynamic: true }`
    (`mcpSkillsSettingOf` returns `dynamic`, refuses a non-boolean by name; NO agent-wide switch):
    then the catalog's `load` reads one into a SNAPSHOT before anyone is asked - SKILL.md through
    the SDK, then with `directoryRead` the tree (`startMcpSkillWalk` / `nextMcpSkillWalkDirectory`
    / `takeMcpSkillWalkListing`: direct children, `inode/directory` inside the root, never twice;
    512 files, 64 directories (`MCP_SKILL_SNAPSHOT_MAX_DIRECTORIES`), depth 8
    (`MCP_SKILL_SNAPSHOT_MAX_DEPTH`)) and every file, bytes counted as read
    (`mcpSkillSnapshotBytesRefusal`: 16 MiB per skill, `MCP_SKILL_SNAPSHOTS_MAX_BYTES` 64 MiB per
    agent, `McpSkillSnapshotMemory`), digests computed here (`mcpSkillSha256`, WebCrypto, or
    `options.digest`), the manifest (`mcpSkillSnapshotEntry`) = the held entry (`loaded.snapshot`);
    `readFile` serves its files from memory, never re-read; past a bound: declined, `warn`, nobody
    asked. The record's `dynamic` marks the catalog line (`mcpSkillTag(server, true)`: "no
    checksums"), the view's `dynamic` / `noFileListing` the request. A COPY of the browser sibling's
    `src/mcp/skills.ts`, byte for byte: change both (`tests/mcp-skills-shared.test.ts` compares
    them and tests every rule). `mcp.ts` wires it (the extension declared only with `skills: true`
    and a mode that may speak 2026-07-28; listed only on a 2026-07-28 connection; a change comes
    as `notifications/resources/list_changed`, on the same listen stream, and goes the
    `onToolsChanged` -> `refreshServer` path); `skills.ts` keeps an MCP skill's state per skill
    object (`createMcpSkills`, `acquireMcpSkill` - read, verify, ASK, then let in -,
    `addMcpSkillByUri`, `prepareMcpSkills`; `isMcpSkillAllowed` per run, `IRunState.mcpSkillConsent`;
    `skillPreamble`; the agent's snapshot memory in each skill's state, given back by
    `releaseMcpSkills` when `syncMcpSkills` drops the objects); the question is `approval.ts`'s `askSkill` (`onRequest`, the request's
    `skill`; the mode and the rules play no part; grants in `mcpSkillGrants`); `agent.ts`
    syncs them into `skills` between runs; the runner reads a planner's pick before activating
    it. While a run (or a run above it) acts on an MCP skill, a tool that runs code
    (`markCodeExecution`: `run_js`) is ALWAYS asked (`decideToolPermission`, source
    `'mcp-skill'`). OFF without `skills: true`: no capability, no request. Security boundary:
    every guard has a test (`tests/mcp-skills*.test.ts`, the second over real sockets against the
    test server's `skills` / `skillFaults`) and a mutation check.
  - `pipeline-engine.ts` + `pipeline.ts` (`createPipeline`: a graph of agents with conditions and
    loops, described in plain JSON). The engine (definition types, `validatePipeline`, the conditions
    with the non-backtracking `matches` matcher, the wave scheduler; pure, no imports) is a COPY of
    the browser sibling's `src/pipeline/engine.ts`, byte for byte: change both, with tests
    (`tests/pipeline-agent.test.ts` compares the two files and the two `tests/pipeline.test.ts`).
    `pipeline.ts` is this package's adapter: a node run by `createAgent`, the route call
    (`generateStructured` on the planner model), `nodeResolver`. A definition is untrusted input: the
    caps, the `otherwise` rule, the condition input bound and the join deferral each need a test
    and a mutation check.
  - `tiers.ts` (`config.executorTiers` / `config.escalation`, the pure rules: `pickTier` - the
    planner's `complexity`, else `standard`; a missing tier falls back to the nearest configured one,
    the stronger of two; `escalationReasonOf` / `isEscalatableError` - what is a failure a stronger
    model could fix; what the escalated attempt is shown; and the write guard, `IStepWrites`: a
    non-read-only call that already succeeded in an earlier attempt at the step is answered from its
    result by `tool-wrap.ts`, not executed again). The runner's escalation loop is in `runner.ts`,
    the tiered schemas in `planner.ts` / `replanner.ts` (SEPARATE schemas: an agent without tiers
    sends what it always did). Same rules and names as the browser sibling's `src/tiers.ts`: change
    both. OFF without `executorTiers.light` / `.strong`: `tests/model-tiers.test.ts` compares the
    requests with `tests/fixtures/requests-without-tiers.json`, recorded before the feature existed
    (`UPDATE_GOLDEN=1` rewrites it after a deliberate prompt or schema change). Every guard has a
    test there and a mutation check.
  - `decision.ts` (`config.decisionModel` / `config.decision`: a decision model answers a closed
    question with an option and a probability instead of writing text. The interface
    (`IDecisionModel.decide`), the guard `askDecisionModel` - below `confidenceThreshold` (default
    0.8), on an error, a timeout, an answer that is not an option or a confidence that is not a
    probability the ordinary model call runs UNCHANGED - the `decision` event, the usage record
    (`decisionCalls`: a call is not a token) and `decisionModelFromAiSdk`, the adapter over the AI
    SDK's experimental `experimental_decide` (Gemini Decision 1 via `@ai-sdk/google`, TypeSafe's
    Jev via `@ai-sdk/typesafe-ai`). Imports only `ai`; a COPY of the browser sibling's
    `src/decision.ts`, byte for byte: change both (`tests/decision.test.ts` compares them). Asked
    at two points: `decideWithDecisionModel` in `replanner.ts` (continue / finish; `revise` hands
    over to the replanner; not asked when the user's message forced the replan) and
    `pickRouteWithDecisionModel` in `pipeline.ts` (the engine is not involved). NEVER a security
    control: it is not consulted for approval, egress or the sandbox, and a test says so. OFF
    without `decisionModel`: the golden requests of `tests/model-tiers.test.ts` must pass
    untouched. Every guard has a test in `tests/decision.test.ts` and a mutation check; the vendor
    adapter is tested against a local imitation of the documented response, never a real API.
  - `subagent-dynamic.ts` + `subagent-dynamic-shared.ts` (`config.subagents.dynamic`: the
    `spawn_subagent` tool, with which the MODEL starts a helper for a sub-task). A helper is a
    nested `runAgentLoop` over a context DERIVED from the calling run's (`ISpawnScope` in
    `internal.ts`): the caller's tool objects picked by name, the same models, approval controller
    and skills, a share of what is left of its budgets. It is never a new agent built from a
    config - that is what makes "a helper can only have less" hold. The shared file (pure, no
    imports: the settings, the input schema and its validation, narrowing, the budget share, the
    depth / count guards, the texts, `adoptSubagentEvent`) is a COPY of the browser sibling's
    `src/subagent/dynamic-shared.ts`, byte for byte: change both (`tests/subagent-dynamic.test.ts`
    compares them). The tool-call share is enforced in `tool-wrap.ts` (`reserveOn`: a helper's
    call counts on every run above it), the approval label in `approval.ts`. OFF without the
    switch: the same golden fixture as the tiers. Privilege boundary: every guard has a test in
    `tests/subagent-dynamic.test.ts` and a mutation check. In-process only.
  - `wait-clock.ts` (pure, no imports): time limits that do not count the time a PERSON takes. One
    clock per run (`IRunState.clock`, made in `runner.ts`); the executor's step limit
    (`llmTimeoutMs`, `deadlineSignal` in `executor.ts`) and the `timeoutMs` of every subagent the
    run's tool calls start (`subagent.ts`, `subagent-dynamic.ts`) are its deadlines. The approval
    gate (`approval.ts`) and an MCP question (`answerMcpElicitation`, `call.pause`, wired in
    `mcp.ts`) pause it for the wait; it goes on with what it had left - never reset, never
    extended past the wait. The waits' own bounds (`toolApproval.timeoutMs`, `elicitation.timeoutMs`)
    are plain timers, NOT on the clock, and a stop is passed on at once. Both default to 5 minutes;
    `0`, `Infinity` and more than 2^31 - 1 ms are "no bound", resolved before a timer sees them
    (`resolveApprovalTimeout`, the shared file's `timeoutOf`: `setTimeout` fires those after ~1 ms);
    negative / NaN throw at creation; each rule has a test on mocked timers. A subagent tool follows its
    child's events (`followHumanWaits`: `…-requested` → `…-resolved` / `…-answered`, any depth), so
    the caller's clock stops while anything below waits; a worker child is told by `tool-wait`
    messages and a proxied call in flight follows (`followClock`) the calling run's clock. A COPY
    of the browser sibling's `src/wait-clock.ts`, byte for byte: change both
    (`tests/wait-clock.test.ts` compares them and tests the clock on mocked timers;
    `tests/human-wait.test.ts` drives the whole loop). Every guard has a test and a mutation check.
    Without a wait nothing changes: the golden fixtures pass untouched. The loop's tests run the
    limits on VIRTUAL time: `tests/helpers/virtual-time.ts` (the same file in both packages) puts
    a time source under the test seam `TEST_TIME` (a `Symbol.for` key on `globalThis`, read when
    a clock is made; not exported, not an API) and a person's wait is a `tick` while the question
    is open. Never go back to real sleeps against short real limits: the model's and the sockets'
    real latency counted against them and the suite failed under load. `llmTimeoutMs` there is
    large (it is also the planner's REAL bound). A worker THREAD does not share the seam: that
    test, and one more, stay on real timers with relative bounds only.
  - `internal.ts` (`IRunState`: the per-run mutable state shared by the runner, the stages and the tool
    wrappers) + `context.ts` (`runContext`, the AsyncLocalStorage that carries run id, emit and state
    into tools). Neither is public API.
  - `cli/` — the `dd-agent` REPL (`start.ts` entry, `args.ts` flags + `--help`, `config.ts` env →
    `IAgentConfig`, `run.ts` the REPL and its slash commands, `live.ts` what a line typed *while* a
    run goes means, `questions.ts` the approval / elicitation / skill questions at the prompt -
    `skillApprovalPrompt` says a generated skill's "no checksums" and "SKILL.md alone": one at a
    time, and one the agent stops waiting for - its `signal` aborted - closed with one line, the
    event's own line skipped via `closedAtPrompt`; `tests/cli-questions.test.ts` drives it over a
    real `readline/promises` interface and the real REPL). A new env var / flag / command goes in `args.ts` (help), `config.ts` /
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
