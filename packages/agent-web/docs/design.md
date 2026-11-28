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
├── wait-clock.ts        the run's clock: step / subagent limits that stop while a person is asked
│                        (pure, a COPY of the Node sibling's)
├── thinking.ts limits.ts caching.ts skills.ts images.ts   — see docs/capabilities.md
├── llm/context-editing.ts  stale tool results → stubs inside one step's tool loop
├── llm/util.ts          clip / prompt helpers / usageOfError (the spend of a failed structured call)
├── mcp/                 OPTIONAL HTTP MCP connector (./mcp subpath)
│   ├── http.ts          StreamableHTTP connect / mount / refresh
│   └── oauth.ts         OAuth 2.1 client provider: CIMD or DCR (`registration`), vault-backed
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

### Event order across crashes: `(attempt, seq)`

A client that shows a run - or a server that relays it from many workers - must put its
events in order, and a run's events do not come from one uninterrupted process: a reload
or a crash cuts the run, a resume continues it, perhaps elsewhere. Arrival order, wall
clocks and a counter alone all fail there: arrival order is the transport's, clocks of two
machines disagree, and a counter restarted by the resume collides with the one before it.
So every event of a run carries `seq` (1, 2, ... within one attempt) and `attempt` (1 for
the run as first started, one more per resume), and `(attempt, seq)` is a TOTAL order with
no ties: within an attempt the counter is monotonic, and two attempts never share a number.

That last part is why the attempt is persisted, and when. The attempt a resume runs as is
one more than the snapshot's; if it were only written at the resumed run's first
checkpoint, a crash before that checkpoint would hand the NEXT resume the same number, and
two attempts' events would interleave ambiguously. So a resume records its attempt
(`onRunResume`, else `onStepComplete`) before it emits anything - and, unlike every other
write, a failure there refuses the resume: carrying on would produce events under a number
the store does not know about. A snapshot whose attempt is not a positive integer is
refused for the same reason.

Delivery stays at-least-once, and the numbering says so instead of hiding it: the step a
crash interrupted runs again under the next attempt, so its events (and its tool calls)
come again with the new attempt's numbers - a consumer that deduplicates keeps the later
attempt's copy. A subagent's envelope is numbered in the parent run and the child event
inside keeps the child run's own numbers: each run's events are one order, and a tree of
runs is a tree of orders. The fields are optional on the type because events outside a run
(a pipeline's own events) carry none; the Node sibling has the same names and rules, and
on the server they are what its scale-out hooks (a run lease, shared limits) build on.

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

## Dynamic subagents: a helper is derived, never configured

**Why a switch under `subagents`, and static ones stay tools.** A static subagent is a tool the
host builds (`createSubagentTool`) and passes in `tools`: nothing about the agent changes, so it
needs no config field. A helper the model starts is a behaviour of the agent itself - a
built-in tool, a prompt note, limits - which is what a config field is for. `subagents` is the
namespace; `dynamic` is the one thing in it, so a later mode does not need a third name. The
same field and the same tool name (`spawn_subagent`) as the Node sibling.

**Why a helper is built from the caller's pieces.** The obvious design - take the model's
arguments, make a config, call `createAgent` - makes "a helper may only have less" a rule
someone has to enforce on every field, forever. Here there is nothing to enforce it on: a
helper's agent is assembled from the calling agent's resolved model objects, its approval
state (the object, not a copy), its skills, and tool objects picked from its mounted tools by
name. `egress`, `search`, `sandbox`, `learning`, `memory` and `persistence` are left out of the
helper's config altogether, so it cannot build a second fetcher or a second notebook: it has
the caller's `web_fetch` or none. The hand-over (approval state, depth, the parent's counters)
travels in a `WeakMap` keyed by the helper's config object, so no config a host writes can
carry one. The pure rules - input validation, narrowing, the budget share, the caps, the texts
- are `subagent/dynamic-shared.ts`, the same file byte for byte as the Node package's
(`subagent-dynamic-shared.ts`); only the assembly differs (Node nests a run of its loop over a
derived context, because its tools are wrapped once per agent and read the run from
AsyncLocalStorage; here tools are wrapped per run, so a helper is a small agent of its own).

**Why the default is the read-only tools.** With no `tools` the choice is between "everything
the parent has" and something smaller. What the tool is *for* - independent look-ups, long
reading - needs reads. A model that wants a helper to write has to say so, tool by tool, and
that list is in the `subagent.start` event for the host to see. `defaultTools: 'all'` is there
for hosts that prefer the other trade. Either way every call a helper makes passes the same
gate, so the default is about how much a confused helper can touch, not about consent.

**Why a share of what is left, with promises counted.** A fixed per-helper budget is wrong at
both ends: too much for a run that is nearly spent, too little for one that has barely begun.
`budgetShare` of the remainder scales with the run. "Remainder" subtracts what running helpers
were promised and have not used, or three helpers started in one turn would each be promised
half of the same tokens. The share is a cap *inside* the parent's - usage is charged upward as
it arrives, and a tool call is counted on every run above the helper before it executes - so
the parent's limit is the hard one and the share only decides how a parent's budget is split.
Iterations are not a resource (they are a loop guard), so a helper gets that share of the
*cap*, and they are not charged back. There is no run-level wall clock to share, hence a
plain `timeoutMs`.

**Why in-process only.** A worker subagent works by rebuilding the child on the other side
from a serializable config (`workerConfig`, a `resolveModel`). A helper is defined by what
cannot cross: live tool objects, a loaded model, the consent state the user is answering
through. Proxying every tool and every consent request over `postMessage` would re-create the
static worker subagent with more moving parts; a helper that is given a static worker
subagent's tool can call it.

**Why the notebook is withheld.** The parent *could* write a lesson, so "only narrow" would
allow passing `save_skill` down. It is refused anyway: a lesson is "this problem, this fix,
it worked", and a helper sees a fragment of the task and never learns whether its answer was
used. It reports; the run that owns the outcome writes.

**Why one tree convention.** Subagent events already travel in an envelope
(`subagent.event { id, event }`), and pipelines tag a node's events with `nodeId` / `visit` on
the outermost event. Rather than a third scheme, `subagent.start` gained `parentId` and
`depth`, and the rule that fills them lives where events are forwarded
(`adoptSubagentEvent`): a start is born with depth 1 and its run's id, and each subagent it
passes through adds a level - the first one also puts itself in as the parent. That needs no
shared state between a parent and a child, so it is right for a static subagent in a worker
too, and static and dynamic subagents are nodes of one tree.

**Why a lost helper is not replayed.** A run is checkpointed at step boundaries; a helper lives
inside one step and has no checkpoint. Replaying its writes on resume would need a durable log
of every helper's calls keyed by a task the model may word differently next time. The honest
contract is the existing one for a step in flight: it runs again. Within one process the
escalation guard does better, and is used: a spawn that *finished* in an earlier attempt at
the step is answered from its result.

## Decision models: a fast path with the old path underneath

Some model calls in the loop do not need text: "continue or finish?", "which route?". Decision
models (TypeSafe's Jev, Google's Gemini Decision 1) answer such a question with an option and a
probability for a fraction of the latency and price. `decisionModel` uses one there.

- **Our own small interface, `decide(question) -> { choice, confidence }`.** One question per
  call, options with descriptions, an optional context. The vendors' APIs take many questions of
  several types per request; the agent has one closed question at a time, and an interface this
  small is what a host can implement in ten lines over anything (a gateway, a local classifier).
- **No HTTP client of ours.** The AI SDK ships `experimental_decide` and provider decision models
  (`@ai-sdk/google`, `@ai-sdk/typesafe-ai`); `decisionModelFromAiSdk` adapts them. That keeps the
  model the only seam. The price: the AI SDK API is experimental, so the adapter is thin and the
  interface is ours - if theirs changes, one function changes.
- **Confidence is the probability of the chosen option**, taken from the API's distribution. Not
  a vendor's separate "confidence" statistic (TypeSafe's is a different formula), and not a
  language model's self-reported number: a model that returns no distribution gets 0 and is never
  used. That is also why there is no "cheap LLM as a decision model" adapter: its confidence would
  be a guess, and a threshold on a guess protects nothing.
- **The fallback is the code that was already there.** `askDecisionModel` turns everything that
  is not a confident, valid answer into "not accepted", and the caller then makes the ordinary
  call - not a copy of it. Off, and on-but-rejected, send the same requests as before
  (`tests/decision.test.ts`, and the golden requests of `tests/model-tiers.test.ts`).
- **`revise` is an option the model cannot be given.** The replanner's third answer needs a plan.
  The question still offers it, so the decision model can say "neither of the cheap answers":
  that hands over to the replanner (`needs-model`).
- **A call is not a token.** `usage.decisionCalls` counts calls; the token fields carry only what
  the API reported. Nothing is estimated.
- **In the page, a spec, not a client.** `{ providerType: 'google', ... }` resolves like a model
  spec (key from the `CredentialStore`), but its request is pinned to the API's host by the
  guarded fetch, as `web_search`'s is. Only an API whose CORS lets a page in gets a spec.
- **Never a gate.** See security.md. `src/decision.ts` is a byte-for-byte copy of the Node
  sibling's; `src/decision-provider.ts` is this package's own.

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

**No key and no third-party search API ship with the library.** A search API costs money and
has terms; the host passes one as a function (`engine`), and the docs carry recipes for Tavily,
Brave and SearXNG. Each is a dozen lines a host can own, while inside the library each would be
an API to track, a key format to know and a CORS answer to keep re-checking. What stays shared with the Node sibling is
everything a host should *not* have to write - the caps, the cleaning, the egress filter, the
key redaction - in `web-search-shared.ts`, a byte-for-byte copy of the Node file.

**One provider is built in: Google Search through Gemini grounding.** It is not a third party
in the same sense - it goes through a model provider the agent already knows how to talk to,
and needs that provider's key and no other. It is a *separate* `generateContent` call with the
`google_search` tool rather than a switch on the agent's own model calls, because the Gemini API
refuses built-in tools and function declarations in one request (HTTP 400, measured
2026-11-26), and every step of an agent carries function declarations. The call holds a fixed
instruction and the query - never the conversation. Its tokens are a `usage` event of phase
`'search'`: a search that spends model tokens must show up where model tokens are counted.

**Google's links are redirect links, and the agent does not resolve them.** The API returns
`vertexaisearch.cloud.google.com/grounding-api-redirect/<token>` and the site's name, never the
page's URL. Resolving them here would mean a request per result to an address the egress policy
has not judged, so the links are handed over as they are and the consequences are stated: the
result filter judges the redirect host; a title that names a site is used only to *drop* a
denied one, never to allow; `web_fetch` follows a link under the ordinary redirect rules (from a
page: only with `followRedirects` and a server-side `egress.fetch`, since the redirect host
sends no CORS headers), and the tool's description stops promising `web_fetch` when it cannot
open them. Snippets are the grounding model's sentences per source (`groundingSupports`); the
whole answer is attached once, capped, only when no source has a sentence and nothing was
filtered.

**The key follows the providers' rule.** It is never in the config: `credentialRef` names it in
the `CredentialStore`, it is read at each call and put into one header. An inline `apiKey` is an
error, not a warning - there is no development shortcut to grow into a habit. Errors carry the
status and never the API's body (which may echo the request), and are redacted before they are
thrown.

**`search` and `egress` are independent, and neither loosens the other.** The tempting design -
"add the search host to the egress allow list" - would make the search API fetchable by
`web_fetch` and would make `search` unusable without opening `egress`. Instead the provider's
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

## Media: three models, one object, bytes that stay out of the context

Image generation, speech and transcription are tools a model may call, and one input path
(attached audio). The decisions:

**The AI SDK's own model interfaces are the seam.** `generateImage`, `generateSpeech` and
`transcribe` take an `ImageModel`, a `SpeechModel` and a `TranscriptionModel` (stable names in
`ai` v7). The agent accepts those objects directly, or a spec the existing registry resolves:
`buildMediaModelFromSpec` builds the same provider factory as for a language model - same
package, same key from the `CredentialStore`, same `baseURL` and headers - and asks it for
`imageModel(id)` / `speechModel(id)` / `transcriptionModel(id)`, the names every `ProviderV4`
carries. No provider-specific code, and no new dependency.

**One `media` object, not three top-level fields.** The three models share a budget
(`maxCalls`), a timeout, a destination (`files`, `folder`) and a threat model; `egress`,
`search` and `sandbox` are each one object for the same reason. Inside it the names are the
plain ones - `imageModel`, `speechModel`, `transcriptionModel` - and each mounts its tool only
when set, so a host pays (in prompt tokens for a tool definition, and in attack surface) only
for the modality it configured. The golden-request fixture guards that "off" is byte-for-byte
the old behaviour.

**The bytes go to the virtual file system; the model gets a path.** A megabyte of base64 in a
tool result would overflow a small window at once and be re-sent on every later call. The file
system is already the workspace the user sees. When there is none, `createAgent` refuses an
image or speech model instead of falling back to "bytes in an event": one place for a file, one
code path, and an event that stays small enough to cross a worker boundary or sit in a
checkpoint. `media.generated` names the path, and `vfs.readDataUrl(path)` is the picture.

**The type of a file is what its bytes are.** A provider's declared media type is a claim; the
signature is a fact. `sniffMediaType` knows a short list (four image formats, seven audio
containers) and everything else is refused - including SVG, which a page would execute.

**Usage is counted in its own units.** An image is not tokens. Four optional numbers on `IUsage`
(`mediaCalls`, `imagesGenerated`, `speechCharacters`, `transcriptionSeconds`) ride on the same
`usage` events, phase `'media'`, with zero tokens. They are flat numbers, not a nested object,
on purpose: every place that sums a usage field by field - the pipeline engine, a host's own
reducer - then carries them without knowing they exist. So `agent.usage`, `sessionUsage`, a
checkpoint and a subagent's charge to its parent all carry them for free, and the token limits
are not distorted. Tokens some
image models report for themselves are deliberately not added to `totalTokens`: they are priced
differently, and a cap meant for the language model would start counting pictures.

**A cap on calls, per run, with a small default.** A model in a loop can ask for a picture
forty times. `media.maxCalls` (8) is checked against the media calls in the run's usage - which
a resumed run inherits from its checkpoint - plus the calls in flight, so parallel tool calls
of one model step cannot pass together. Past it the tool fails with a message that tells the
model to stop; the run goes on (other tools are not affected), which is why this is not a
`budget.exceeded` stop. A failed call counts and is not retried by the SDK (`maxRetries: 0`).

**Transcription is an input path first.** The point of the transcription model is that a
text-only model can work with a voice memo, so attached audio is transcribed once, before
planning, and replaced by a fenced, labelled block under the goal - every stage then sees the
same text, memory and checkpoints keep it, and no stage gets the audio. It is on by default
when the model is set (`transcribeAttachments: false` for a model that listens itself). The
tool, `transcribe_audio`, is the same call on a file of the workspace. No duration cap exists
because none can be enforced before the call; the size cap can.

The pure part (caps, the sniffer, names, the budget, the transcript wrapper, the descriptions)
is `tools/media-shared.ts`, a byte-for-byte copy of the Node sibling's file. The Node agent
writes to its per-run directory instead of a virtual file system; everything else is the same.

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
- **Why the clock starts with the program.** `timeoutMs` bounds the guest. The engine's
  own start before it (the runtime, the host functions, the bootstrap that builds the
  guest's console and timers) is our code, the same for every run, and runs nothing the
  guest wrote. When it counted, a short limit on a busy machine was spent before the
  program began: the interrupt landed in the bootstrap and a legitimate run failed with
  "the sandbox runtime failed to start". The start has a bound of its own instead - a
  worker that has not said `started` within 20 s is given up and terminated - and
  `durationMs` still reports the whole run, start included.
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

## MCP: the listen stream is opened again

On 2026-07-28 a tool list change reaches a client only on a `subscriptions/listen` stream the
client opened. The SDK opens it once (`client.listen`) and never again; a stream that is gone
without anyone noticing reads as "nothing changed", for the life of the connection. So the
connector keeps it open (`mcp/listen.ts`, a byte-for-byte copy of the Node package's
`mcp-listen.ts`; pure, so both cores make the same decisions and the rules are tested once, on
fakes, in the Node package).

- **A dropped stream is retried** - the specification says a transport that closes without the
  listen result "indicates an unexpected disconnect, which the client MAY treat as a trigger to
  reconnect" (basic/patterns/subscriptions, "Graceful Closure"). Resumption is no help: the
  revision has no `Last-Event-ID` (streamable HTTP: "Resumable SSE streams via `Last-Event-ID`
  are not supported"), so a new stream is a new `subscriptions/listen` request.
- **So is a stream the server closed with its result.** That result means the server ended the
  subscription "on its own initiative (for example, during shutdown)", and the SDK's server
  sends it from `close()`. On a stateless revision the process that shuts down is not the
  service: no session binds the client to it, and the next request may well reach another
  process. Not listening again would turn every rolling restart into a connection that never
  hears of a change again. The specification gives a server that wants no listeners a final
  answer instead - `404` with `-32601` for a method it does not implement (streamable HTTP,
  "Request Metadata") - and that answer is final here.
- **Final errors stop at once**: 401 / 403 belong to the authorization flow (the transport's
  `authProvider` already refreshed and retried; a loop would only hammer the authorization
  server), 404 / 405 / `-32601` / `-32602` cannot heal by waiting, and a client that is not
  connected has nothing to listen on. Everything else - a 5xx, a 429, a missed acknowledgement,
  the network, the SDK server's "Subscription limit reached" (`-32603`) - can.
- **Backoff with jitter, reset by stability, not by success.** Attempt n waits at most
  `min(60 s, 1 s × 2^(n-1))`, less a random share of up to half, so the clients that lost one
  server do not return in step. The count is NOT reset when a new stream is acknowledged: a
  server that accepts and then drops at once (a proxy that cuts idle streams, a crash loop)
  would otherwise be retried every second forever, with a re-list each time. It is reset when a
  stream stayed up a minute, and a stream lost sooner counts as an attempt - so a flapping
  server and a dead one are both given up on after 10 attempts in a row (within five minutes),
  each with one warning per attempt and one on giving up.
- **The re-list goes through the notice's own path.** Changes made while no stream was open were
  announced to nobody, so once a stream is back the connector calls `onToolsChanged(server)`
  once - the callback the `notifications/tools/list_changed` handler calls. A host (or the Node
  agent's deferred refresh) cannot tell the two apart, which is the point: one way to pick up a
  new tool list, not two. The connector still never re-lists behind a running agent's back.
- **Close leaves nothing behind.** `close()` stops every listener before the clients close: the
  retry timer and the stability timer are taken down, an attempt in flight is given up (its
  signal), and whatever the SDK reports afterwards is neither logged nor retried. An open
  stream is left to the client's own close, which ends it without the extra
  `notifications/cancelled` request an explicit `subscription.close()` would send.
- **Timers with a seam of their own.** The two timers are `setTimeout`'s, unless a test put a
  time source under the file's own test key: then the tests run the whole backoff on virtual
  time against real servers, without a sleep. Not the wait clock's seam (`wait-clock.ts`): that
  one carries the deadlines of runs, and the human-wait tests ask whether any of them is running
  while a person is asked - a listen timer is not a run's deadline and must not answer "yes".
- **No setting.** Turning the retries off would leave a connection that silently stops hearing
  of changes - the behaviour this replaces. The schedule is bounded and the stream exists only
  when the host asked for change notices (`onToolsChanged`); a host that wants none passes none.
  The 2025 revisions are untouched: their GET stream belongs to the transport, which resumes it.

## MCP skills: one catalog, namespaced, under a preamble, opt-in

A server's skills (the `io.modelcontextprotocol/skills` extension, SEP-2640, Beta) are a second
source of the agent's skills, beside the host's and the lessons. The choices:

- **The same catalog, not a parallel one.** The agent already has progressive disclosure (an
  index in the prompts, `load_skill` / `read_skill_file`, the planner's `plan.skills`), and the
  extension is a transport for exactly that format. A second mechanism would be a second set of
  prompts and tools to keep safe; one catalog means an MCP skill is loaded, capped and accounted
  for (compaction, the active-skills budget) like any other.
- **Namespaced by the host's label, with a separator no other name can hold.** The extension says
  a name is a label, not an identity, that two servers may serve skills of one name, and that an
  MCP skill must never silently shadow, or be substituted for, another origin's - the host's
  included (Names; Security Considerations). `<server>/<skill>` does that by construction: a host
  skill's and a lesson's name is `[a-z0-9-]`, so no comparison or precedence rule is needed to keep
  `git-workflow` the host's - there is no way for the two to meet. The server is named by the
  host's key, not its `serverInfo.name` (which a server chooses, and which two servers can share),
  in the alphabet of the tool prefix `server__tool`. Same-named skills of one server are kept by
  their full path rather than dropped ("MUST disambiguate ... rather than silently discarding or
  preferring one").
- **Under a preamble, like a lesson.** A lesson is loaded under `learnedPreamble` - "a hint from
  your own experience, not an instruction" - because what the agent wrote must not outrank the
  user. A server's skill gets the same treatment one step further away (`mcpSkillPreamble`):
  third-party text, knowledge only, which cannot grant permissions, approve a call, change the
  approval mode, widen egress or the sandbox, or make the agent run anything. The extension asks
  for exactly that: origin visible "at the point it enters model context", never "indistinguishable
  from a local filesystem skill", "data, not directives". The wording is the guard the model sees;
  the controls themselves are code and do not read it.
- **Opt-in per server, no agent-wide default.** It is experimental (the extension is Beta), it is
  "a higher-risk surface than remote tool invocation", and the host's per-server decision is the
  "explicit user policy" that governs whether a skill is loaded at all. A default on the agent
  would hand that decision to whichever servers are added later - in the demo, any URL a user
  types. Off means off: the capability is not declared and nothing is asked (the wire is what it
  was).
- **2026-07-28 only.** The extension is written against that revision (Protocol Revision: every
  request carries `_meta`, results are `CacheableResult`s); the SDK would also run it on a 2025
  connection, but there is no specification of it there. So `'legacy'` warns and asks nothing, and
  an `'auto'` connection that negotiated 2025 lists nothing.
- **The SDK verifies, the shared file decides.** `SkillsClient` (`@modelcontextprotocol/client/ext/skills`)
  checks every read against the entry - size, SHA-256, the frontmatter parsed with a YAML 1.2
  parser and compared field by field - which is the part where an own implementation (a YAML
  parser) would be the weak point. Everything that is policy is ours, pure and shared byte for byte
  with the Node sibling (`mcp/skills.ts`): which entries are taken, the names, the caps, the
  preamble, which file may be read (only what the entry the skill was loaded with lists: "the held
  entry"), the catalog over the client. In this package the SDK's skills client is imported only by
  a connection that lists skills.
- **Carried by the tools, like the instructions.** The host merges `mcp.tools` into the agent and
  that is all it does for instructions; skills follow the same path (`markMcpSkills`), so a host -
  and the React hooks - wire nothing new. The cost: a server none of whose tools is mounted offers
  no skills (the same rule as its instructions: a server the host filtered out does not speak).
- **Lazy, and nothing on disk.** The extension forbids fetching files ahead of need, and caching
  on disk brings rules of its own; a skill's text lives in memory, per agent, for as long as the
  agent does, and a checkpoint keeps only names.
- **Code is asked for while acting on one.** The extension requires that no code runs on the host
  because a server's skill said so without a person's approval. The agent's code-running tool is
  `run_js` (and whatever the host marks): while the run, or the run that started a helper, has an
  MCP skill active, a call of one is asked whatever the mode. This only tightens: a deny stays a
  deny, and nothing else about consent changes.
- **A person sees a skill before the model does - through the gate the host already has.** The
  extension says a host SHOULD let users inspect a skill before it is loaded and MAY gate loading
  per skill or per server; for a third party's instructions both are cheap and worth it. The
  question goes to `toolApproval.onRequest` - the same handler, events, timeout and clock as a
  tool call, with `skill` on the request - rather than a callback of its own: every UI that
  answers tool calls (the React card, the Node REPL's prompt) answers it already, and one that
  does not know `skill` still shows a request for `load_skill` instead of loading silently. The
  approval MODE does not lower it: a mode is about tool calls, and autopilot is exactly the
  setting where nobody would see the text otherwise (the same reasoning as an MCP App's writes).
- **The default: once per skill, bound to its entry.** Every run would make a person click through
  the same text over and over, and a click that is routine stops meaning anything. Never would
  mean nobody ever sees a third party's instructions. Once per skill per agent - per session -
  shows every text a person has not seen, and binds the yes to what was shown: the server, the URI
  and every file's digest (the extension's content-bound approval), so a server that changes the
  skill is asked about again. `'ask'` (every run) is there for hosts that want it, `'never'` for a
  server the host vetted (the behaviour before the question existed). Per server, with an
  agent-wide default: the decision is about a server, and a host trusts its own servers and not a
  URL a user typed in. Nothing is persisted: a grant on disk would have to be bound and revoked
  across restarts, and a person re-seeing a skill once per session is cheap.
- **Fetched to be shown, not to be used.** To be inspected, the text must be read before the yes.
  It is read when the model asks for the skill (the point of need, which the lazy-retrieval rule
  allows), verified, held off any context, and shown; only a yes puts it in. The preview is the
  model's text exactly (`mcpSkillBodyPreview`: the same cleaning and cap), so what is approved is
  what is sent. A decided request keeps no copy of it (the React state drops `body`).
- **Nested skills, and "Always for this server".** A nested skill needs "fresh, explicit user
  consent", and approving the enclosing skill does not substitute for it. Per-skill grants are
  keyed by URI, so the enclosing skill's yes never covers it; a server-wide yes, given before the
  nested skill was ever shown, is not "fresh" either, so it does not cover nested skills. Nesting
  is read from the URIs the agent knows (listed and given by URI): a `SKILL.md` inside another
  one's directory.
- **A no is final for the run.** A model that is refused tends to try again; the run remembers the
  refusal and answers the next load of that skill itself, so a person is not asked the same
  question twice in one task. Nobody to ask, or no answer in time, is not a person's no: it is not
  remembered, and the skill is asked about next time.
- **By URI: the server the model names, nothing else.** The listing may be partial, and a host
  "MUST support loading a skill given only its URI"; a URI is scoped to the server that serves it.
  The agent cannot tell which server's text the model read a URI in (instructions, a skill, a tool
  result all end up in one context), so it does not guess: `load_skill({ server, uri })` names the
  server, the URI goes to that one server only, and only to a server whose skills the host turned
  on. Searching every server for a URI would let one server's text make the agent ask another one
  - the cross-server confused deputy the extension warns about. Only `skill://` is taken from the
  model: other schemes are allowed in a listing, but a URI the model hands over came from
  third-party text, and `skill://` is what the extension's servers use. What comes back is an
  entry like a listed one - the same rules, cap, verification, preamble and consent - and it stays
  in the catalog (on the connection's source) so the next run, and the planner, see it.
- **A directory is listed from the entry; the server is asked only for staleness.** A skill's
  instructions name directories ("pick a template from `templates/`"), and the model needs to see
  what is in one. The entry the skill was loaded with already lists every file (it MUST be
  complete), and it is what the person approved - so the listing comes from it, and a host "MAY
  answer from the entry alone". `read_skill_file` takes the directory rather than a new tool: one
  tool that reads what a skill holds, a path the model already has, no new name in every prompt,
  and the same consent path as a file (a directory of a skill nobody allowed lists nothing). The
  server's own view (`resources/directory/read`, only where it declared `directoryRead`) is ahead
  of or behind the entry, and nothing ties the two to one snapshot - so it can never extend what
  may be read under the approval ("MUST NOT treat the directory result as extending the
  manifest"), and a child it adds must not reach the model as a file of the skill. What it can
  tell is that the skill changed: the listing says so with a count in a sentence of ours (nothing
  of the server's text), the log says so, and the server's skills are listed again between runs -
  through the same `onToolsChanged` path a resource list change takes, never behind a running
  agent, because re-reading a held entry mid-run would swap what a person approved for what the
  server says now. A changed entry is a new consent key, so the person is asked again: the spec's
  "a skill that has changed and needs re-approval". A child of the entry the server no longer
  lists is the entry's own path, so it is named (`notServed`). A failed directory read costs
  nothing but a log line: the entry is enough. The work is bounded - the SDK walks at most
  `listMaxPages` pages, and at most 640 entries of the answer are looked at.
- **`"dynamic"` skills: declined by default, a snapshot when a server is trusted with them.** The
  extension lets a host decline them, and by default this one does: a directory read is the only
  way to find their files, and it verifies nothing - no digest, no size, nothing a consent could
  bind to, so a yes would cover whatever the server serves next. Some servers can only generate
  their skills, though, so `skills: { dynamic: true }` takes them on terms that keep the one
  property the consent stands for - what the model reads is what the person approved:
  - **Why a snapshot.** With no published digests there is nothing to bind a yes to except bytes
    the agent itself holds. So the agent reads the whole skill BEFORE asking (`SKILL.md`, then -
    where the server lists directories - every file in its tree), computes the digests itself
    and makes that manifest the held entry. The consent is then content-bound after all, to the
    copy: the same machinery as a listed skill (`mcpSkillGrantKey`, `'once-per-skill'`, nested
    rules, the card), nothing special-cased downstream. Reading up front breaks the extension's
    lazy-retrieval rule for these skills; a copy must be complete to be what a person approves,
    and the bounds (the extension's 512 files / 16 MiB counted on what is read, 64 directories,
    8 levels, 64 MiB per agent) cap what that costs. A copy over a bound is declined before
    anyone is asked: a person should not be asked about something the agent would not use.
  - **Why served from memory.** A generated skill may differ on every read - the test server's
    `changing` fault does exactly that. Reading a file again at `read_skill_file` time would give
    the model bytes nobody saw, and there would be nothing to check them against. So every file
    is served from the copy, and a path the copy does not hold is refused like an unlisted file
    of any held entry. Memory, not IndexedDB or a checkpoint: a stored copy would be a second
    copy to keep honest (the extension's cache rules) and would outlive the approval it was
    taken for; a resumed run in a new agent simply reads - and, if it differs, asks - again.
  - **Why opt-in per server, with no agent-wide switch.** The snapshot protects the approval, not
    the content: the server still chooses what to send at that moment, and nothing protects
    against it or an intermediary. Whether that is acceptable is a judgement about one server,
    like `consent: 'never'` - so it is set where the server is configured, never for every server
    at once (`mcpSkills` stays consent-only), and a new server never brings generated skills by
    default.
  - **Why the walk is pure and shared.** What is read (direct children, `inode/directory` only
    inside the root, nothing twice, the bounds) is security-relevant and identical in both
    packages, so it lives in the shared file (`startMcpSkillWalk`, `takeMcpSkillWalkListing`,
    `mcpSkillSnapshotBytesRefusal`, `mcpSkillSnapshotEntry`), tested once rule by rule; the
    digest is WebCrypto's (`globalThis.crypto.subtle`, browsers and Node >= 20), so the shared
    file still imports nothing.

## MCP elicitation: the host answers, the model never sees the question

- **On the connection, not on the agent.** The capability is declared in the handshake
  (`initialize`, or every request's `_meta` on 2026-07-28), and in this package the host makes
  the connection before the agent exists. So `onElicitation` / `elicitation` are options of
  `connectMcpHttp`. (The Node sibling owns its connections, so there they are fields of the
  agent's config: the same names, the same request, the same events.)
- **Manual mode, not the SDK's auto-fulfilment.** The 2.x SDK can answer `input_required`
  itself through a registered `elicitation/create` handler and retry the call. It is not used:
  its loop has one cap (rounds), puts all the questions of a round to the handler at once, and
  has no notion of which tool call, run or helper asks. The connector keeps `inputRequired.autoFulfill: false`, asks for the
  `input_required` result (`allowInputRequired`) and drives the rounds itself, so the same
  guards - caps per call and per run, the helper rule, "nothing is sent again after an answer
  nobody decided" - hold in both revisions. The request handler is registered only for the
  2025 revisions, where the SDK needs one.
- **One at a time on the 2025 revisions.** An `elicitation/create` request carries nothing that
  ties it to the tool call it belongs to (the SDK's context has the request's own id, no
  relation). Guessing would put a question under the wrong tool, count it against the wrong
  call and - worse - let a helper's question pass as the run's. So calls to a server with
  elicitation on run one at a time on such a connection: the call in flight is the one that
  asks. The cost is parallelism towards that one server; the option is opt-in.
- **Run context read structurally.** The `./mcp` entry does not import the core. A tool reads
  what the agent passes it as `options.agentRun` (the event sink, the step, the run id, the
  per-run counter, the helper mark) by shape; a subagent tool marks the calls of the tools it
  hands its child (`options.subagentCall`). Outside a run a question is still answered - a host
  calling a tool directly is the host deciding - and nothing is emitted.
- **A flat form, checked twice.** The request is normalised to the specification's subset
  before a host sees it (so a UI renders a closed set of field types), and the answer is
  validated against that same normalised form before it is sent (so a UI bug cannot send a
  server something it did not ask for).
- **Automatic answers fail the call.** When nobody decided, the server is told `cancel` (or
  `decline`) and the tool call is reported to the model as failed with the reason - even on the
  2025 revisions, where the server then returns a perfectly good "the user cancelled" result,
  which is discarded. A result that says "cancelled" would read as the user's choice; it was
  not. A server that asks again after that has its call aborted.
- **A question stops the step's clock.** While a question waits, `chatTimeoutMs` does not run
  (see [Time a person takes](#time-a-person-takes-is-not-a-steps-time)); the question is bounded
  by its own `timeoutMs` and by a stop. Separately, the MCP SDK's 60-second request timeout is
  paused on the 2025 revisions, where it would otherwise end every form that takes longer than
  a minute to fill in. `step-timeout` is left for a question that arrives when the step's time
  is already spent, and for a time limit the host put on the run's signal.
- **Events beside approval's.** `mcp.elicitation-requested` / `mcp.elicitation-answered`, in the
  shape of `tool.approval-requested` / `tool.approval-resolved`: an id to correlate, the step,
  the helper. No value in either.
- The pure core (`mcp/elicitation.ts`) is a byte-for-byte copy of the Node package's
  `mcp-elicitation.ts`.

## Time a person takes is not a step's time

`chatTimeoutMs` (120 s by default) bounds a step so that a hung model or tool cannot freeze a
run. A person answering a tool approval or an MCP question is neither: two minutes to read a
form is ordinary, and the step used to end under them (the elicitation answered with
`step-timeout`, the approval denied as aborted). So the limits that measure latency run on a
**clock that stops while a person is asked**, and goes on with what it had left:

- **One primitive, `wait-clock.ts`**, pure and shared with the Node sibling byte for byte (its
  test compares them): `createWaitClock` (deadlines measured in running time; `pause()` returns
  the resume, waits may overlap), `deadlineSignal` (what `AbortSignal.any([outer,
  AbortSignal.timeout(ms)])` was, on the clock), `followHumanWaits` and `followClock`.
- **One clock per run, on the run context** (`ToolRunContext.clock`): the executor's step limit
  and the `timeoutMs` of every subagent the run's tool calls start are its deadlines. The
  consent gate pauses it from `tool.approval-requested` to the decision, an MCP question from
  `mcp.elicitation-requested` to the answer. Nothing else does: a tool that is merely slow is
  still cut.
- **Resumed, never reset.** A deadline keeps what it had left when the clock stopped; a fresh
  limit after every question would let a run that asks often never time out, and a limit
  extended past the wait would hide a real hang.
- **The waits keep their own bounds** - `toolApproval.timeoutMs`, `elicitation.timeoutMs` - on
  plain timers, never on the clock; and a stop (the run's signal, `stopSubagent`) is passed on
  at once, paused or not: the clock only keeps time, it never holds an abort back. A limit the
  host put on the run's signal is such a stop and is not paused; the config has no run-level
  time limit.
- **Subagents follow by events.** A subagent runs on a clock of its own; the tool that started
  it reads its events (`followHumanWaits`: a `…-requested` holds the caller's clock until the
  same question's `…-resolved` / `…-answered`, at any depth of `subagent.event`), so the
  caller's step and the subagent's `timeoutMs` stop while anything below waits. The reverse
  direction - a host tool of a subagent asked about by the PARENT's gate - pauses the parent's
  clock, and the child's clock follows it for that call (`followClock`); a worker child is told
  by a `tool-wait` message and its proxied call in flight follows. The worker cannot tell which
  question is whose, so a proxied call follows every wait of the calling run: the child's step
  is paused at most as long as the calling run's is.
- **No wait, no change**: without a question the clock never stops and the deadline is the
  timer it was.
- **Tested on the test's own time.** The clock reads `Date.now` and sets `setTimeout`s unless a
  test put a time source of its own on `globalThis` (a `Symbol.for` key read when a clock is
  made). The tests of the whole loop do (`tests/helpers/virtual-time.ts`): the limits then move
  only when a test moves them - a person's wait is a tick taken while the question is open - so
  a loaded machine cannot end a step that real but short limits would, and what a step had left
  is checked to the millisecond; one test keeps the real timers. It is a test seam, not an API:
  nothing exports it, and it gives no power that the globals it stands for do not.
- **Approval's bound is 5 minutes by default**, as an elicitation's is. The step's limit stops
  while a person decides, so without a bound of its own nothing but a stop would end a question
  nobody answers: a run left alone would wait for ever with its tool call half done. Five minutes
  is long enough to read a request and short enough that an abandoned run moves on (the call is
  denied, the replanner routes around it). A host that wants the person to take as long as they
  need says so: `0` or `Infinity`.
- **A bound a timer cannot hold is no bound.** `setTimeout` takes a 32-bit delay: `Infinity` or
  anything above 2^31 - 1 ms (about 24.8 days) fires after about 1 ms. Both waits resolve their
  `timeoutMs` before a timer sees it: `0`, `Infinity` and more than 2^31 - 1 mean "until the run
  is stopped". Not clamped to 2^31 - 1: that would end a wait the host asked to be longer, with a
  denial quoting a number nobody set - and a wait of more than 24 days outlives any page and any
  run anyway. A negative number or `NaN` is a configuration error at `createAgent` (or the
  connect, for an elicitation), never a silent "no bound".

## MCP Apps: the host reads, the browser draws

- **Two halves.** The core is the data side of a host - the extension in the handshake, the
  tools' `_meta.ui` at list time, the `mcp.app` event, `readUiResource` / `appTool` /
  `callAppTool` on the connection, and the consent gate (`agent.approveAppToolCall`). The frame,
  the `postMessage` bridge and every prompt the user sees are the React package's: the core has
  no DOM, and a host without React can draw apps with the same core API.
- **On the connection, like elicitation.** The extension is declared in the handshake, so `apps`
  is an option of `connectMcpHttp`, off by default. Off, nothing is read and the wire is the
  recorded fixture's; on, the only wire difference is the extension.
- **The event carries data, never the app.** `mcp.app` has the call's input and the result for
  the app - so a saved conversation can show the app again - and the UI reads the HTML from the
  server when it draws. Putting the HTML in the event would put third-party code in every event
  log, every saved chat and every checkpoint, and near the model.
- **Read only what a tool of that server declares.** A UI could be tricked (or a host careless)
  into reading `ui://` URIs a server never tied to a tool, or another server's; the connection
  answers only for URIs in the server's current listing. The cache is per connection and
  dropped when the server's tools are listed again.
- **Consent is the agent's gate, not a second one.** An app's call goes through the same
  `toolApproval` - rules, handler, timeout - so a host has one policy and one prompt. Two
  differences, both towards asking more: `'autopilot'` is the model's licence, not the app's
  (writes ask), and an app's "always allow" is kept apart (the user trusted the agent, or the
  app, not both). `callAppTool` does not ask by itself: it is the host's capability, like a
  tool's `execute`.
- **An app's call is not the step's.** Its consent and any question its server asks during it
  wait outside the run's clock (see [Time a person takes](#time-a-person-takes-is-not-a-steps-time)):
  the app's prompt may come while no run goes, and when one does, the step it would pause is
  not waiting for that person. Its bounds are the gate's own `toolApproval.timeoutMs` and the
  question's `elicitation.timeoutMs`.
- **No `@modelcontextprotocol/ext-apps` dependency.** Its host helper (`AppBridge`) is built on
  the SDK's `Protocol` with zod schemas and console logging, peers `@modelcontextprotocol/client`,
  `core` and `zod`, and assumes a sandbox proxy on another origin. The host side we need is an
  allow-list of a few methods: the bridge and the frame's policy are one file of the React package
  (`src/mcp-app.ts`), the guards on the server's declarations one file here (`mcp/apps.ts`, pure,
  no imports). Both follow the package's
  types (`spec.types.ts`) and wire (`ui/initialize` → `ui/notifications/initialized` →
  `tool-input` / `tool-result`), and the test server's app speaks it by hand.
- **An origin of its own is opt-in, and its guards are not in the sandbox page.** The default
  frame is opaque because a library in a page has no second origin. `appSandbox` adds the
  specification's proxy for a host that has one, and keeps it the stricter fallback. The design
  follows from one fact the reference proxy of `ext-apps` (`examples/basic-host`) does not plan
  for: the app is same-origin with the proxy, so it can reach into it - run code there, click a
  link it put there - and a frame may always navigate itself. So nothing the proxy page says can
  hold the app; what holds it is out of its reach: the app's policy is a response HEADER of the
  proxy page (inherited by the app's `document.write` frame, by the page's own realm, by any copy
  of the page), built from the URL's PATH so that the host's shell can pin the proxy's frame to
  that exact URL with `frame-src` (a source with a path matches the path, never the query - a
  query-borne policy, as in the reference, would let one app reload another's proxy with a policy
  of its choosing); the sandbox flags are on the host's frames; a second handshake means the
  proxy was loaded again and stops the app. The proxy page binds to the first ANCESTOR on an
  allowed origin, not to its parent, because the shell (no script) sits between. The page and
  its server are one import-free module (`./mcp-app-sandbox`) because the core does not
  tree-shake into a small Worker; its origin rule is a copy of `mcpAppOrigin`, held to it by a
  test. A per-server origin is a template (`{server}` in the host name, a DNS label), never the
  server's own `_meta.ui.domain`: the host decides origins.
- **Off for one server is "declined", not "unknown".** `McpHttpServerConfig.apps: false` is a host
  that knows MCP Apps and will not show that server's - so it reads `_meta.ui.visibility` (a tool
  for its app only is mounted for nobody: there is no app to call it) and nothing else, and does
  not declare the extension (the server is told the truth). Leaving both settings out stays the
  recorded wire of before, every tool mounted: what a host that never heard of apps does.
- **Downloads: the core reads, the UI judges.** A `resource_link` is read with `resources/read` on
  the app's own server (`apps.readResource`) - the draft says a host "can retrieve the content
  directly from the URI", but a fetch to an address an app chose is exactly what its CSP stops; the
  server it came from is the one place the host already talks to. Which names and types are
  saved is the UI's rule (a page saves files; the core has no filesystem).
- **Sampling: one seam, in the agent.** `Agent.sampleForApp` is where the model, the usage counter
  and the consent timeout already are, so the rules (`app-sampling.ts`, pure) and the order -
  check, count, ask, send - live there and a Node host gets the same by calling it. The consent is
  a callback (`approve`), not the `toolApproval` gate: a sampling request is not a tool call (no
  name for a rule to match, nothing a mode like `'ask-writes'` means for it), and it must always
  ask. The model is the synthesizer's: a completion with no tools is that stage's work. The rate
  is counted before the user is asked: a prompt is the scarce resource.
- **An app's `maxTokens` is for the answer, not the reasoning.** Found on production: Gemini 3
  Flash thinks whatever it is told (`thinkingBudget: 0` and the lowest level still thought 112 -
  166 tokens), and its reasoning counts against `maxOutputTokens` - a 120-token request came back
  "(e.g.," with `MAX_TOKENS`. Detecting thinking models by name would rot; the result says it
  (`finishReason: 'length'` with reasoning tokens), so the first such call is asked once more with
  `reasoningTokens` of room, and the agent remembers the model thinks. A model that never reasons
  never gets more than the app asked for.
- **Display modes are the UI's.** Full screen is a layout and a focus rule; nothing of it is in
  the core.
- **Node: nothing yet.** The Node agent renders nothing, and an app's requests come from a browser:
  a server-side host would need the bridge in the page and a round trip for every app call. The
  names (`apps`, `mcp.app`, `readUiResource`, `appTool`, `callAppTool`, `approveAppToolCall`) are
  kept for when it does.

## MCP OAuth: `registration` - auto by default, and `'cimd'` refuses before it registers

How the OAuth client gets its `client_id` is one option on the provider, `registration`, with the
same names and rules in both cores: `'auto'`, `'cimd'`, `'dcr'`.

**Why `'auto'` is the default.** It is what the SDK does on its own and what the providers did
before the option existed, so no stored client changes meaning and no host has to change a line.
It is also the right choice for most hosts: the client ID metadata document where the authorization
server supports it (no registration record left at every server, one stable `client_id` whose
redirect addresses the host controls), dynamic registration elsewhere - which every MCP
authorization server accepts today (the 2026-07-28 revision deprecates DCR, but keeps it for at
least a year). The other two are for hosts that must know which one happened. `'cimd'`: a host
that may not leave registrations at third-party servers, or needs a `client_id` a server's policy
can name. `'dcr'`: a document that cannot be used from where the host runs (the demo off
agent.dudko.dev: its document lists that site's pages only), or a server that advertises CIMD and
then cannot fetch the document.

**Why `'cimd'` fails in `clientInformation()`.** The SDK chooses between the document and a
registration inside `auth()` (`@modelcontextprotocol/client` 2.4, `authInternal`): it saves the
discovery state, then reads `provider.clientInformation()`, and only with nothing stored looks at
`client_id_metadata_document_supported` and `provider.clientMetadataUrl` - the document when both
are there, `registerClient()` otherwise. `clientInformation()` is the last call of ours before that
choice and comes after the metadata is saved, so the provider reads the same metadata the SDK is
about to read and throws when it promises nothing. Nothing has been sent but discovery. The
alternative - a fetch that refuses the registration endpoint - would have to be ours on every path
(the transport's 401 handling, `beginMcpOAuth`, a host's own fetch), would know the endpoint only
by URL, and would surface as a network error. With no record of the server at all the provider
refuses too: it fails closed, because a future SDK that reads the client before saving discovery
would otherwise register. After a refusal the stored discovery state is dropped: the SDK reuses it
without asking again, so a server that starts advertising CIMD would stay refused until a reset.
`'dcr'` needs no such hook: the getter `clientMetadataUrl` is what the SDK reads, and under
`'dcr'` it returns nothing.

**Why the kind is stamped, not derived.** "CIMD when the `client_id` is the configured document"
is right until the document's URL changes; then an old document client would read as a dynamic
one and be reused under `'dcr'`. When a client is saved the provider knows exactly which URL the SDK
used, so the kind is written on the record then (and a registration response cannot set it). Records
written before the stamp fall back to the comparison.

**Why a changed setting forgets the client AND its tokens.** A token belongs to the client it was
issued to. Keeping the tokens would keep the old client in use - the transport sends the stored
access token without asking `auth()` - until it expires, and its refresh would then go out under
the new client and fail. Forgetting both costs one sign-in and leaves nothing of the old setting
behind. It happens once per provider, before the first read of the client or a token (the setting
of a provider is fixed); `'auto'` forgets nothing and reads nothing extra.

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
(the MCP connector, isolated so `@modelcontextprotocol/client` never enters the core
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
