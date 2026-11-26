# Design

## Goal

A **headless, UI-agnostic, universal** in-browser LLM agent that any web app can
embed. It runs entirely in the browser and can drive **any** model:

- **Cloud providers via bring-your-own-key (BYOK)** — OpenAI, Anthropic, Google,
  xAI, DeepSeek, any OpenAI-compatible server, and the Vercel AI Gateway.
- **Local WebGPU models** — via [`@browser-ai/web-llm`](https://www.npmjs.com/package/@browser-ai/web-llm)
  (WebLLM), no server and no key.
- **Any AI SDK `LanguageModel`** you hand it — e.g. Chrome/Edge built-in AI
  (`@browser-ai/core`).

It exposes both **low-level primitives** (text generation, streaming,
tool-calling, structured output) and a **high-level agent** that runs a
**plan → execute → replan → synthesize** loop. It stores data in **IndexedDB**
and keeps **API tokens encrypted at rest** in a WebCrypto-backed vault.

It is the browser sibling of the Node package `@dudko.dev/agent`. They
deliberately share shapes (provider-type union, config field names, event
names) but are **separate packages** — Node and browser diverge in exactly the
load-bearing places (credentials, tool I/O, MCP transport, model runtime,
bundling), so unifying them would help nothing and couple two release cadences.

## The one seam: an AI SDK `LanguageModel`

Everything is built on the [Vercel AI SDK](https://ai-sdk.dev) (`ai` v7). The
whole package accepts an AI SDK `LanguageModel`; providers are just different
ways of producing one. You give the agent a model in one of two ways:

1. **Directly** — pass a ready `LanguageModel` (WebLLM, built-in AI, or any
   custom model). It bypasses the registry entirely.
2. **By spec** — pass a `ProviderModelSpec { providerType, model, baseURL?,
   credentialRef?, providerOptions? }`. The registry resolves it, fetching the
   API key from the credential vault **at build time** — a plaintext key never
   lives on the long-lived config object.

Because the model is the only seam, "simple text generation", "tool-calling",
and "structured output" are just thin wrappers over `generateText` /
`streamText` (structured output is `generateText` with `Output.object`), and the planning agent sits on top of the same
primitives.

## Why AI SDK v7

The package tracks the current `ai` major (v7) together with the provider
packages and `@browser-ai/*` v3, which peers `ai@^7`. (It was pinned to v6 while
the local-model provider `@browser-ai/web-llm` still peered `ai@^6`; the whole
stack moved together once it shipped v7 support.) v7 also brings what the agent
builds on: the portable `reasoning` setting, `instructions` system messages that
carry provider options (Anthropic cache breakpoints), `prepareStep` for
per-step active tools (tool search), and `toModelOutput` (tool-output caps).

## Modules

```text
src/
├── providers/           the universal model layer
│   ├── types.ts         ProviderType, ProviderModelSpec, ModelInput, guards
│   ├── registry.ts      resolveStage() + buildModelFromStage() (dynamic @ai-sdk/* imports)
│   ├── webllm.ts        createWebLLMModel() + isWebGPUAvailable()
│   └── capabilities.ts  supportsNativeTools / directBrowserOk hints
├── secrets/             the encrypted token vault
│   ├── crypto.ts        non-extractable AES-GCM key in IDB; encryptJSON/decryptJSON
│   ├── vault.ts         IndexedDBVault (secrets encrypted at rest)
│   └── store.ts         CredentialStore + Vault/Memory implementations
├── storage/db.ts        single IndexedDB owner (keys, secrets, sessions stores)
├── llm/                 low-level primitives
│   ├── generate.ts      generate / stream / generateStructured
│   └── tool-loop.ts     runToolLoop() — native OR prompted, one signature
├── tools/               host tools
│   ├── define.ts        defineTool() → an AI SDK tool (+ optional promptHint)
│   ├── prompted.ts      renderCatalog() + dispatch() (the salvage path)
│   ├── mode.ts          selectToolMode() — native vs prompted per model
│   ├── approval.ts      the consent gate (autopilot / ask-writes / ask-all / read-only)
│   ├── search.ts        searchTools() + find_tools for large catalogues
│   ├── wrap.ts          per-run wrapping: gate, call budget, model-facing output cap
│   └── types.ts         AgentTool / AgentToolSet
├── agent/               the plan→execute→replan→synthesize loop
│   ├── schemas.ts       zod Plan/Replan schemas (native path)
│   ├── planner/executor/replanner/synthesizer.ts
│   ├── runner.ts        createAgent() — orchestration, events, usage accounting
│   ├── internal.ts      per-run state + the prompt/option plumbing the stages share (not public)
│   ├── control.ts       RunControl: say something to a running agent, stop one subagent
│   ├── persistence.ts   run checkpoints (RunSnapshot) for resuming after a reload
│   └── loop-types.ts    IPlan / IStepResult / IUsage
├── memory/              store.ts, sessions.ts (IndexedDBStore), compress.ts (compaction + the
│                        token estimate), runs.ts (IndexedDBRunStore / MemoryRunStore)
├── files/               vfs.ts (VirtualFileSystem on IndexedDB) + tools.ts (the fs_* tools)
├── subagent/            tool.ts (createSubagentTool), worker.ts (serveSubagentWorker), protocol.ts
├── tools/egress.ts      `egress` / `web_fetch`: the model's one way to make a request
├── tools/web-search.ts  `search` / `web_search`: a search API behind the guarded fetch
│                        (+ web-search-shared.ts: caps, cleaning, adapters - a COPY of the Node sibling's)
├── sandbox/             `sandbox` / `run_js`: the model's code in QuickJS-in-wasm
│   ├── engine.ts        limits, guest runtime, worker protocol - pure, a COPY of the Node sibling's
│   ├── index.ts         the tool: worker or page thread, loaded only when switched on
│   ├── files.ts         the workspace binding: fs calls and modules through the file tools' VFS
│   └── worker.ts        the `./sandbox-worker` entry (serveSandboxWorker)
├── learning.ts          `learning`: save_skill / forget_skill, the skill stores, the secret scan
├── pipeline/            `createPipeline`: a graph of agents described in JSON
│   ├── engine.ts        validation, conditions, the scheduler - pure, a COPY of the Node sibling's
│   └── index.ts         the adapter (a node = createAgent + a route call), nodeResolver
├── context-window.ts    the model's real window; compaction, tool search and caps sized to it
├── thinking.ts limits.ts caching.ts skills.ts images.ts   — see docs/capabilities.md
├── llm/context-editing.ts  stale tool results → stubs inside one step's tool loop
├── llm/util.ts          clip / prompt helpers / usageOfError (the spend of a failed structured call)
├── mcp/                 OPTIONAL HTTP MCP connector (./mcp subpath)
│   ├── http.ts          StreamableHTTP connect / mount / refresh
│   └── oauth.ts         OAuth 2.1 + DCR client provider (vault-backed)
├── webmcp/              OPTIONAL bridge to the browser's WebMCP API (./webmcp subpath)
├── parse.ts             robust JSON-salvage parsers (the prompted backbone)
├── prompts.ts           default phase prompts (native + prompted variants)
├── events.ts            AgentEvent union
├── logger.ts            leveled logging onto a console-like sink
├── config.ts            BrowserAgentConfig + resolveConfig + resolveBudgets
└── index.ts             public surface
```

## Two tool-modes (robust on small models)

Cloud models do reliable native function-calling and JSON-schema output. Tiny
in-browser models (1–3B) do not — they wrap JSON in prose, truncate it, or drift
to text. So the agent has two strategies over **one** tool shape (an AI SDK
`ToolSet`):

- **native** — pass the tools straight to `streamText({ tools, stopWhen })`;
  plan via `generateStructured(PlanSchema)` (`generateText` + `Output.object`).
- **prompted** — render the tool catalogue into the prompt, let the model reply
  with text, and salvage `{ reply, actions }` JSON with `parse.ts`; each action
  is validated against the tool's own `inputSchema` and dispatched to the same
  `execute`. Plan via `parsePlannerResponse`. After a round's actions run, the
  model is shown their `TOOL RESULTS` as a follow-up user turn and may continue
  the same task — so read-tools and failed calls are visible to it — until it
  returns no actions, signals `[BLOCKER]`, re-emits a batch it already ran
  (stutter guard, catches A→B→A oscillation too), or `maxSteps` rounds are spent
  (default 4; `maxSteps: 1` restores single-round). All rounds share ONE
  `chatTimeoutMs` watchdog, so a slow model can't stretch a step to
  `maxSteps × chatTimeoutMs`.

`selectToolMode` picks per model: `toolMode: 'auto'` (default) → cloud = native,
local/on-device = prompted; override with `'native'` / `'prompted'`. Native
failures on the planner/replanner **degrade gracefully** to the prompted parse
instead of throwing.

## The run loop (`agent/runner.ts`)

`plan → (execute step → replan on block/failure)* → synthesize → compress`, with:

- **Intent gate** — an empty plan (greeting/question/unclear) short-circuits to a
  friendly answer; no tools run.
- **Grounded steps** — optional `describeState()` is re-read before each phase so
  the model always sees the real, mutated world.
- **Replan** — by default after a **blocked** step (`[BLOCKER]` sentinel) or an
  **unresolved failed** tool call (a failure a later same-tool call retried is
  not counted); `replanAfter` widens the trigger to `'always'` or a host
  predicate on the step result (e.g. "issues found in my state") — the predicate
  is bounded by the `chatTimeoutMs` watchdog and abort, falling back to the
  failure rule if it throws or hangs. Bounded by `maxIterations` / `maxRevisions`.
- **Watchdog + abort** — every model call is time-boxed (`chatTimeoutMs`, via
  `AbortSignal.timeout`); `RunOptions.signal` cancels between phases.
- **Events** — the full list is the table in
  [capabilities.md](./capabilities.md#event-reference).

No `AsyncLocalStorage`, no filesystem sandbox, no OpenTelemetry — those
Node-only concerns from the sibling are intentionally dropped for the browser.
Run persistence and resume are NOT dropped: see "Resuming" below.

## Resuming an interrupted run

A reload or a crashed tab must not lose finished work, so with `persistence` a
checkpoint is written when the plan is in hand and again after every step
(`RunSnapshot`, in IndexedDB: `IndexedDBRunStore`). `run(goal, { resumeFromRunId })`
continues from the last boundary: the planner does not run again and a finished
step is not repeated. What is deliberately NOT kept: the step that was in flight
(it runs again from its start — so a tool with side effects should be
idempotent, or the consent gate should stay on) and attachments (pass them
again). A hook that throws is logged and the run carries on: persistence is
observability, not a correctness boundary. The hook names match the Node
sibling, where the contract originated.

## Steering a run (`RunControl`)

`run()` returns when the run is over, so a host with something to say mid-run
("use staging instead") had nothing to call. A `RunControl` passed as
`run(goal, { control })` is the handle. A message is **not an interrupt**: the
run never cuts a tool call short (it may be a write); it is held to the next
boundary — the next tool-calling round inside a step, the end of the step, or
just before the answer — and shown to the model there. At a step boundary it
also forces the replanner to look at the plan, because a plan made before the
user spoke may be the wrong one. Whatever never reached the model (the answer
was already being written) comes back as `undelivered`, to be sent as the next
run — nothing the user typed is dropped silently. `stopSubagent(id)` ends one of
several parallel subagents without ending the run.

## Compaction: judged on the whole context

A window fills from three things: the transcript, the run's step log, and the
**fixed prompt** every call carries (stage instructions, the goal and plan, tool
definitions, skills). Judging only the transcript would let a 15k-token tool
catalogue push a call over the window while the "history" looked small. So
compaction is decided on all three together against `thresholdRatio`
(default **85%**) of the window - late enough not to throw away context early,
early enough that the answer and a step's growth still fit; a host-set
`thresholdTokens` wins but is never allowed past 95% of the model's own window.
Under tool search only a few definitions are sent at a time, so the tools count
as a bounded allowance instead of the whole catalogue. The summariser's own input
is capped at 60% of the window, so compacting can never itself overflow.

The estimate (`estimateTokens`) is **calibrated against a real tokenizer and
leans high on purpose**: 1.1-1.4x the count Claude reports for English, code,
JSON and CJK, never below. An estimate that errs low compacts too late and the
provider refuses the prompt; one that errs high compacts a little early, which
costs a summary. It is script-aware (Latin letters, digits, Cyrillic and other
scripts, CJK and emoji, whitespace each weigh differently) and computed in integer thousandths so a fixture sized by it does
not move with float rounding. Do not "fix" it down to look more accurate.

## Usage is counted as it arrives

`agent.usage` / `agent.sessionUsage()` charge every `usage` event the moment it
is emitted (`charge` in the runner), not by summing the result at the end of a
run. A run that throws, is stopped, or ends on a budget breach has still spent
tokens, and an unparsable structured-output attempt (`usageOfError`) is billed
too. Subagent spend is counted once; a manual `compact()` is counted; a resumed
run adds only what *this* process spent after the checkpoint.

## Output caps are shares of the window

A fixed "synthesizer: 400 tokens" cut a normal answer short on a 128k model and
would eat a 4k local model's whole window. The per-call output caps
(`resolveBudgets`) are therefore shares of the window - planner 1/160, executor
3/320, replanner 1/320, synthesizer 3/128, compaction 1/125 - each with a floor
and a ceiling, which gives 800 / 1200 / 400 / 3000 / 1024 at the default 128k
window. A cap the host set (`limits.perCall`, then the legacy `budgets`) wins, and `0` means
no cap.

The rules around the shares are the Node sibling's (`stageOutputCap` there and here). A stage
that **thinks** gets no default cap: on OpenAI and Gemini the reasoning counts against
`maxOutputTokens`, so 1200 tokens sized for an executor's answer would be spent on thoughts
before the step wrote anything - or cut a tool call's arguments mid-JSON. And a call the cap
**cut off** (`finishReason: 'length'`) says so in the log, naming the cap and how to lift it: a
truncated step is otherwise silent, and a default cap makes it something a host can hit without
ever having set a limit. Only the share sizes differ between the two packages (the browser ones
are smaller: a page talks to small windows more often).

## Model tiers and escalation

**Why the planner rates, and nobody else.** A separate router model would be a fifth stage: one
more call per step, one more prompt to keep stable, one more thing that can fail. The planner
already reads the whole request and writes every step; rating each one costs a few output tokens
in a call that happens anyway. The rating is a hint with a net under it (escalation), not a
contract.

**Why the schema is a second schema.** `TieredPlanSchema` is used only when tiers are on. Adding an
optional field to `PlanSchema` would have changed the request of every agent, tiers or not - and
"off means nothing changes" is checked against a recording of the calls made before the feature
existed, on both tool-modes. The field is an optional enum: no bounds, nothing a provider's
structured output rejects, and a plan without it is still a plan.

**Why a tag on the prompted path.** A tiny local planner answers `{ reply, plan: string[] }`, often
cut off or wrapped in prose; `parse.ts` salvages the strings it can. A `complexity` array next to
`plan` would have to stay aligned with it through truncation, de-duplication and dropped empties.
A `[high]` at the head of the string travels with the string. The same form serves a revised plan
in both modes (the replanner's `plan` is a list of strings there).

**Fallback: nearest, then stronger.** `standard` always exists (it is `model`), so in practice a
missing `light` or `strong` means `standard`. "Nearest" keeps a `low` step off the strong model
when only `strong` was added (the host added it for the hard steps, not to pay for every lookup);
"the stronger of two equally near" is the tie rule that never under-powers a step.

**The smallest window governs.** The run's window was already the smallest among the planner, the
executor and the synthesizer; the tiers join that set. The alternative - compacting for the tier a
step is routed to - breaks on escalation and on the plan itself: the step log is compacted after a
step for the *next* one, before its tier is known. A prompt that overflows a local model is a hard
failure, a prompt smaller than a cloud model could take is only a missed opportunity, so the safe
side is the small one. What a call may *write* is different: the prompt is already fitted, so each
tier's output cap is a share of its own window.

**Escalation defaults on with tiers.** Tiers without it are a pure cost optimisation that fails
harder: the step the planner under-rated fails on the light model and the replanner has to route
around it. The host already named the stronger model; using it for the one step that needed it,
once, capped per step and per run, is what the configuration plainly asks for. It cannot be on
without tiers (there is nothing stronger to go to).

**What escalates.** Only failures that read as "this model was not up to it": a blocker, nothing
at all, arguments that keep failing to parse, output cut by the cap, a failed call. Never what a
bigger model cannot fix or must not be given: a stop, a timeout, refused credentials, a rate limit
(the same account, a costlier model), a spent budget, a denial by the user. A tool that failed for
its own reasons stays the replanner's.

**Side effects: continue, never restart - enforced, not requested.** A step that wrote something
and then got stuck is the dangerous case: handing the same step to a stronger model "from the
top" would write again. Two layers. The prompt: the stronger model gets every earlier call with
its arguments and result, appended to the user prompt in `executeStep` itself so a host's own
`prompts.executor` cannot drop it. The guard: while a step may be escalated, the tool wrapper
records each successful call of a tool that is not read-only, and an identical call in a LATER
attempt returns the recorded result instead of executing. It sits before the consent gate and the
call budget (a call that is not made costs neither) and it is scoped to the step: within an
attempt, and across steps, a model may repeat a call as it always could. It cannot recognise a
write repeated with different arguments; that is what the prompt and read-only marks are for.

## Structured output: `generateText` + `Output.object`

AI SDK v7 deprecates `generateObject` / `streamObject`. `generateStructured` is therefore
`generateText` with `output: Output.object({ schema })` - the same request on the wire (a JSON
response format carrying the schema; no tool-based JSON mode). One thing the new call does not
keep is restored in the helper: when the model returns no text at all, `generateText`'s `.output`
throws a `NoOutputGeneratedError` that knows neither the usage nor the finish reason, so the
helper turns it into the `NoObjectGeneratedError` the old call threw. The spend of a failed
attempt can then still be counted (`usageOfError`) and a cut named (`withCapHint`).

## A replanner that fails does not end the run, and says so

The replanner's structured attempt falls back to a prompted call; when that fails too, the
decision is `continue` - the steps already done are worth more than a decision nobody could
make. It used to do so silently (`reason: 'replanner unavailable'`). Now the outcome is marked:
an `error` event of phase 'replan', then `replan.decision { mode: 'continue', failed: true }`,
a warning in the log, and the failed attempts' tokens in the usage. An abort is a stop, not a
failure. Same names as the Node sibling, which stops on refused credentials (401 / 403) where
this package, fail-soft throughout (a failed step is a blocked step, not a thrown run), carries
on.

## Egress: off, and bounded by what a page can enforce

The agent has no way to make a request of its own unless `egress` is set; the
provider's API, MCP servers and the host's tools are configuration, not the
model's choice. With it on, the model gets exactly one tool, `web_fetch`, whose
policy has the **same shape and names as the server's `createSafeFetch`**
(`@dudko.dev/agent`) - and the address/pattern core is a copy of the server's, so
the two cannot disagree about what "private" means.

The browser cannot do what the server does: it cannot resolve a name itself, so
it **cannot pin DNS** (a public-looking name that resolves to a private address
is invisible), and it cannot see where a redirect leads. The design answers
honestly rather than pretending: refuse everything decidable *before* the
request (scheme, port, credentials in the URL, host lists, IP literals in every
spelling, names that are internal by shape); fail a redirect by default; send
nothing of the user's (no cookies, referrer or credentials); bound size and time;
treat the result as `untrusted`; and make an open-internet fetch ask like a
write, because the URL itself is a way to leak data. CORS and Private Network
Access are the backstop, and `egress.fetch` lets a host route the request through
a gateway running the real safe fetch. See [security.md](./security.md).

## Search: an engine you bring, a request that cannot wander

`web_fetch` needs an address; a model without search invents one. `search` adds `web_search`,
and four decisions shape it.

**No engine and no key ship with the library.** A search API costs money and has terms; the
host picks one (`provider`) or passes a function (`engine`). The built-in adapters are
deliberately thin - one documented HTTP call each, written as pure request builders and response
parsers in `web-search-shared.ts`, a byte-for-byte copy of the Node sibling's file, so the two
packages cannot drift on a parameter or a cap. Three were chosen: Tavily (an API made for
agents, and the one that answers cross-origin calls), Brave (an independent index; no CORS, so a
gateway from a page) and SearXNG (self-hosted, keyless - the option with no third party).

**The key follows the providers' rule.** It is never in the config: `credentialRef` names it in
the `CredentialStore`, it is read at each call and put into one header. An inline `apiKey` is an
error, not a warning - there is no development shortcut to grow into a habit. Errors carry the
status and never the API's body (which may echo the request), and are redacted before they are
thrown.

**`search` and `egress` are independent, and neither loosens the other.** The tempting design -
"add the search host to the egress allow list" - would make the search API fetchable by
`web_fetch` and would make `search` unusable without opening `egress`. Instead the adapter's
request runs under its own policy (`searchEgressPolicy`): the allow list is exactly the API's
host, scheme and port, redirects are never followed, and only the host's `deny` list is
inherited. In the other direction, results are filtered by the model's egress policy: with an
allow list, a snippet from another host is text read around that list, so it is dropped along
with its link. Without `egress` there is no list and no `web_fetch`; the snippets are leads.

**A search is read-only for consent, and says why.** `web_fetch` is read-only only when the
policy names the hosts, because an open GET can carry data to anyone. A search reaches one host
and the operator named it - the same rule gives read-only. The query still leaves for that
party, so the description tells the model not to put private data into one, and `readOnly: false`
turns the default around for hosts that want every query reviewed.

Results are third-party text like a fetched page: reduced to four fields, each one line, stripped
of invisible characters, capped per field and in total, flagged `untrusted`. The provider-native
search tools (server-side, inside the model call) are a different mechanism with none of these
controls and are left for a separate change.

## Learning: a notebook, knowledge never policy

An agent that solves a problem and forgets it solves it again next session.
`learning` gives it `save_skill` / `forget_skill`; a lesson **is a skill**
(`origin.kind: 'learned'`), so the reading side is the machinery that already
exists: it appears in the planner's `SKILLS:` index at once and loads with
`load_skill`. The design choices are all about what a notebook must not become:

- **Knowledge, never policy.** A lesson loads under a header that says it is the
  agent's own hint; the user's request and the host's rules win a conflict. It
  cannot grant a permission or loosen `egress`.
- **Written in the imperative, from what works.** Tested against a real model: a
  diary-style lesson ("I tried X, it failed, then Y") made the next run repeat
  the detour. The tool description asks for what to do next time.
- **Gated like any write**, scanned for secrets, capped in number and size,
  never allowed to overwrite a host-configured skill, and stamped with
  provenance by the harness (not by the model).
- **Its tools stay callable** under `plan-narrowed` and `search` tool selection,
  or a notebook would silently stop working on large catalogues.
- **Off by default**: no extra tools and not a word more in the prompts.

## Sandbox: QuickJS in WebAssembly, in a worker

`sandbox` gives the model `run_js` (`src/sandbox/`). Without it a model asked to "run it
on test data" writes a file and claims an output; with it the run is a visible tool call.

- **Why an interpreter in wasm, and not the host's engine.** Isolation by construction:
  the guest's realm contains the language and what we pass in, so there is nothing to
  forget to remove. The alternatives all start from a full environment and subtract:
  `node:vm` shares the heap and intrinsics with the host and is documented as not a
  security mechanism; `isolated-vm` is a native addon (a build step per platform, no
  browser, and it has needed maintenance rescue more than once); a sandboxed `<iframe>`
  or a bare Web Worker runs the browser's real engine with `fetch`, timers and
  same-origin storage to be stripped one by one, differs from Node's semantics, and has
  no memory limit at all; a child process is Node-only and inherits the user's file
  system and network unless an OS sandbox is added. QuickJS-in-wasm is the same engine,
  the same language level and the same limits in Node and in every browser, in one MIT
  package (`quickjs-emscripten`) of about 0.5 MB of wasm.
- **Why a worker as well.** The interrupt handler stops JavaScript at loop edges and
  calls; it cannot stop one long native call (measured: 40 `indexOf` over a 16 MiB string
  take 2.5 s with a single check). So the guest never runs on the agent's thread where
  that can be helped: Node always uses a `worker_threads` worker, the browser a Web
  Worker the host supplies, and `terminate()` is the hard stop. One worker and one wasm
  instance per run: no state survives, a killed run cannot poison the next.
- **Why the host supplies the browser worker.** A `new Worker(new URL(...))` inside this
  package would be followed by every bundler into every host build - with an import of an
  optional peer that most hosts have not installed. The pattern is the subagent's: the
  host passes a factory; the package ships the worker module as its own entry
  (`./sandbox-worker`), the only place that names the peer. Without a factory the guest
  runs on the page thread (soft stop only), with a warning.
- **Why the memory limit is the wasm memory.** QuickJS's `JS_SetMemoryLimit` counts
  allocation sizes through `malloc_usable_size`, which this build lacks: it counts 8
  bytes per allocation, and a "2 MiB" guest took 490 MB before it was refused (measured).
  The engine is therefore instantiated on a `WebAssembly.Memory` whose `maximum` is the
  limit; growth past it fails in the wasm runtime, which no guest can argue with.
- **Why the sync build, with async `fs`.** Host calls that look synchronous to the guest
  need the asyncify build: twice the wasm, a second stack to overflow, one suspended call
  at a time. Instead `fs.*` returns promises (top-level `await` is on), and the module
  loader - which must answer synchronously - is fed before the run with the files a
  program names literally. The cost: a computed `require(name)` finds nothing.
- **Result convention.** The last expression of a script (evaluated with top-level
  await), or the `default` export when the program is written as a module - what a REPL
  and a module would each give. A program that does not compile as a script has run
  nothing, so retrying it as a module is free of side effects.
- **The engine file is shared.** `src/sandbox/engine.ts` is a byte-for-byte copy of the
  Node sibling's `sandbox-engine.ts` (limits, the guest runtime, the resolver, the worker
  protocol, the result sanitiser); the Node package's tests compare the two and test the
  guards. What differs per package is small: how a worker is made, and the workspace -
  the browser binds the virtual file system the file tools use, Node has none and
  computes only.
- **Off costs nothing at run time.** The runner imports `sandbox/index.js` dynamically
  when the flag is set; the ESM build keeps it in a chunk of its own.

## Pipelines: waves, a join rule, caps

`createPipeline` runs a graph of agents described in JSON (`src/pipeline/`). The
engine - validation, conditions, scheduling - is one file with no imports,
`pipeline/engine.ts`, and it is the same file, byte for byte, as the Node
sibling's `pipeline-engine.ts` (a test there compares them): a definition must run
the same in both. Only the adapter that runs a node with `createAgent` differs.

- **A definition holds names, the host holds the things.** The definition will be
  edited on a canvas, saved and shared, so it has no code, no model objects and no
  secrets; `resolveNode` maps names to config. It is also why a node's `settings`
  are passed on and never applied.
- **Waves, not a queue of callbacks.** Everything activated runs concurrently,
  then the edges are evaluated, then the next wave starts. A run is then a list of
  waves - easy to draw, easy to reason about, and deterministic for a given set of
  outputs, which a "start a node the moment an edge fires" scheduler is not.
- **The join rule is about reachability, not about counting edges.** "Wait for all
  incoming edges" deadlocks as soon as one of them is conditional and does not
  fire, and it has no meaning inside a loop. Instead a `join: 'all'` node waits
  while something still activated can reach it through the graph: a fan-in waits
  for the slower branch however long it is, and stops waiting the moment that
  branch dies out. When everything activated waits for something else (a cycle),
  nothing would ever start, so all of it starts. Reachability ignores conditions
  on purpose: it can only make a node wait a wave longer, never deadlock it.
  The known limit is a fan-in inside a loop: the join and a slower branch that
  leads to it reach each other through the cycle, so they wait for each other,
  both run, and the join fires without that branch. `join: 'any'`, or a loop
  drawn around the whole fan-out / fan-in, is the way out.
- **Every edge has an id.** A UI lights edges up from events, so an edge must be
  nameable even when the author gave it no id: it gets `e<position>`, the
  normalised definition is what `pipeline.definition` returns, and
  `pipeline.edge` carries the id and the source node's visit. An activation a
  cap refuses is an event too (`pipeline.node.skipped`), or an edge would light
  up towards a node that never starts.
- **One agent per node, one conversation per node.** A node keeps its agent for
  the pipeline's life, so with `memory` it remembers its earlier visits; the
  resolver gives each node its own session (`<sessionId>:<node id>`), because
  nodes built from one base config would otherwise write into one transcript.
- **Caps instead of cycle detection.** A review loop is the point of the feature,
  so a cycle is a warning, not an error. `maxNodeVisits` (3) bounds a loop,
  `maxRuns` (25) bounds the run; hitting one drops that activation and the run ends
  normally with `stoppedBy`, because the three drafts already written are worth
  more than an exception. The defaults are small on purpose - a run is paid for.
- **`matches` does not use `RegExp`.** The brief case against it: a regex engine
  that backtracks cannot be given a timeout, and capping the input does not help
  (an exponential pattern needs thirty characters). So a pattern is compiled to a
  small program and simulated as a set of states (a Pike VM): linear in the input,
  no captures needed for a yes/no. It costs a subset of the syntax
  (no backreferences, no lookaround) and ~300 lines; it buys a definition that can
  be loaded from anywhere.
- **A route is a second, small call** to the node's planner model, structured
  output first and plain text as the fallback, rather than a marker the node must
  remember to print: the node's answer stays clean, and an answer that is not a
  label is simply no route (the `otherwise` edge is there for it).
- **Abort follows the package's agent**: here `run` resolves with
  `stoppedBy: 'aborted'` (as `agent.run` resolves with `stopped`); on the server
  it rejects with an `AbortError`. A failed node rejects in both.

## MCP: server instructions and structured results

- **Instructions travel on the tools.** The connector is a separate entry point and the host
  merges `mcp.tools` into `config.tools` (the React hooks wrap and re-merge them), so a
  `config.serverInstructions` field would be one more thing every host has to thread through.
  Each MCP tool carries its server and that server's instructions under a registry symbol
  (`markMcpTool`, copied by an object spread); `createAgent` collects them from the tools it
  really mounts. A filtered-out server therefore says nothing, with no extra rule.
- **Appended in `stageCall`, not in the prompt builders.** A host that overrides
  `prompts.planner` would otherwise drop the section — or, worse, be handed raw third-party
  text to place. The preamble and the quoting are not the host's to forget.
- **Planner and executor only.** They choose and call tools. The replanner revises by
  description and the synthesizer writes the answer: neither needs the notes, and third-party
  text is kept away from the stage that speaks to the user.
- **Fixed at `createAgent`.** System prompts must not move inside a run (prompt caching), and a
  server must not be able to change them mid-run by reconnecting.
- **A schema mismatch is a note, not an error.** The SDK client throws after the result
  arrived. Reporting a call that ran as failed makes the model call it again, and the tool may
  write. The connector keeps the parsed result (a refinement on the result schema hands it
  over before the SDK's check) and passes it on with a note; if the SDK ever stops parsing
  through that schema, the code falls back to the SDK's own error, which is still a failed
  tool call and not a crashed run.
- **No duplicate, no guess.** A text part is dropped only when it parses to exactly the
  structured value (key order aside). A sentence that paraphrases it stays: telling the two
  apart is the model's job, not a heuristic's.
- The pure core (`mcp/shared.ts`) is a byte-for-byte copy of the Node package's
  `mcp-shared.ts`, like the pipeline and sandbox engines.

## Secrets

API keys are encrypted at rest with a **non-extractable AES-GCM `CryptoKey`**
generated by WebCrypto and stored (as a live, unreadable `CryptoKey`) in
IndexedDB. See [`security.md`](./security.md) for the full threat model — the
short version: this is safe for the **user's own key on their own device**;
**shared/app-owned keys must go through a proxy or the gateway**, never the
client.

## Memory

`ContextStore` persists `{role, content, ts}[]` per `sessionId`.
`IndexedDBStore` (via the shared `storage/db.ts` owner) is the browser default;
`MemoryStore` is the fallback. After a run, if the transcript exceeds
`compressAfterChars`, `compressHistory` summarizes old turns via the synthesizer
model.

## Build & packaging

**tsup** → `dist/` as ESM + CJS + `.d.ts`, four entries: `.` (core), `./mcp`
(the MCP connector, isolated so `@modelcontextprotocol/sdk` never enters the core
bundle), `./webmcp` (the WebMCP bridge) and `./sandbox-worker` (the Web Worker side of
`sandbox`, the only entry that names `quickjs-emscripten`), plus a standalone browser bundle
`dist/agent-web.js` for a `<script type="module">` tag or a CDN. All model providers, WebLLM, and the MCP SDK are **optional peers**,
imported dynamically — a consumer installs only what they use, and the core
bundle contains **no `node:*`**. Target ES2022, `moduleResolution: Bundler`.

See [`providers.md`](./providers.md) for the provider matrix and the
direct-vs-proxy / CORS guidance.

## Not in scope (the host's job)

- Any UI. The React hook and chat panel are a separate package,
  [`@dudko.dev/agent-web-react`](https://www.npmjs.com/package/@dudko.dev/agent-web-react).
- Domain tools — the host registers its own via `defineTool`.
- stdio MCP — Node-only; browsers get HTTP MCP only.
