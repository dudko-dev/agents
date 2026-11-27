# @dudko.dev/agent-web-react

[![npm](https://img.shields.io/npm/v/@dudko.dev/agent-web-react.svg)](https://www.npmjs.com/package/@dudko.dev/agent-web-react)
[![downloads](https://img.shields.io/npm/dy/@dudko.dev/agent-web-react.svg)](https://www.npmjs.com/package/@dudko.dev/agent-web-react)
[![license](https://img.shields.io/npm/l/@dudko.dev/agent-web-react.svg)](https://github.com/dudko-dev/agents/blob/main/LICENSE)
[![last commit](https://img.shields.io/github/last-commit/dudko-dev/agents.svg?path=packages%2Fagent-web-react)](https://github.com/dudko-dev/agents/commits/main/packages/agent-web-react)
[![release](https://img.shields.io/github/v/release/dudko-dev/agents.svg?filter=agent-web-react-v*&label=release)](https://github.com/dudko-dev/agents/releases)

**[agent.dudko.dev](https://agent.dudko.dev)** · [live demo](https://agent.dudko.dev/demo/) · [source](https://github.com/dudko-dev/agents/tree/main/packages/agent-web-react)

React bindings for [`@dudko.dev/agent-web`](https://www.npmjs.com/package/@dudko.dev/agent-web) —
the headless, universal **in-browser LLM agent**. Drop the agent into any React
app with a single hook and (optionally) a set of pre-styled components:

- 🪝 **`useAgent`** — build the agent from a config, stream its typed events into
  a ready-to-render state (plan, steps, tool calls, streamed answer, token
  usage, model-load progress, chat transcript), and get `run` / `stop` /
  `reset` / `reload`.
- 💬 **`<AgentChat>`** — a drop-in chat: every tool call with its cost, tokens by
  kind per answer and in total, thoughts, subagents, consent prompts; a
  composer with "+" / Ctrl+V / drag & drop attachments (images, PDFs, files),
  "/" commands, run timer, agents, model + thinking chip, the "⚡ Auto" consent
  chip and speech to text; saved chats in IndexedDB and a workspace (virtual
  file system) panel. Everything is a prop: show/hide, labels (i18n), render
  props, slots, swappable components, theme — see [docs/chat.md](docs/chat.md).
- 🕸️ **Pipeline editor** — draw a graph of agents on a canvas (our own: no canvas or
  graph library), connect them with conditions and loops, run it with live statuses,
  copy it as code: `<PipelineEditor>` and `usePipeline`, behind
  `@dudko.dev/agent-web-react/pipeline` — see [docs/pipeline.md](docs/pipeline.md).
- 🗣️ **Steering and learning** — type to the agent while it works (`send`,
  `stopSubagent`; queued / delivered notes under the step that got them), and watch
  it keep a notebook: lessons it wrote down as skills (`learned`, `<LearnedSkills>`,
  `forgetSkill`) and the pages it fetched — see
  [docs/chat.md](docs/chat.md#talking-to-the-agent-while-it-works).
- 🧩 **Building blocks** — `<AgentComposer>`, `<MessageList>`, `<StepList>`,
  `<ToolApprovalPrompt>`, `<ElicitationPrompt>`, `<ApprovalModeSwitch>`, `<ChatHistoryList>`, `<FilesPanel>`,
  `<LearnedSkills>`, `<ContextMeter>`, `<PlanView>`, `<ModelLoadBar>`, `<UsageBadge>`, `<ApiKeyForm>`; hooks `useChatHistory`,
  `useVirtualFiles`, `useSpeechToText`; MCP hooks `useMcp` / `useMcpServers` live in
  [`@dudko.dev/agent-web-react/mcp`](#mcp-hooks-live-in-their-own-subpath).
- 🔑 **`useCredentials`** — store BYOK API keys **encrypted at rest**
  (WebCrypto + IndexedDB).
- 🖥️ **`useWebLLMModel`** / **`useLocalModel`** — load an on-device model (WebLLM,
  the browser's built-in model, transformers.js, or your own runtime) with
  download progress, switching and unloading.
- 🎛️ **Headless-first** — the event→UI logic is a pure, exported reducer
  (`agentStateReducer`); the components are optional sugar on top.

> **▶︎ [Live demo](https://agent.dudko.dev/demo/)** — three agents:
> one edits a sticky-notes board, one drives any number of MCP servers (plus a
> 185-tool mock catalogue to show tool search), and one plays chess against you
> — your move triggers it, analyst subagents run in Web Workers. Cloud BYOK or
> local WebGPU, all in your browser. Settings turn on tool consent, thinking, token
> and step limits, compaction, skills - the agent's own **notebook** (it writes down
> what it figured out, in the workspace, across reloads) and **web access** limited
> to hosts you list. Type to the agent while it works. Source in [`apps/demo`](https://github.com/dudko-dev/agents/tree/main/apps/demo).

## Install

```bash
npm install @dudko.dev/agent-web-react @dudko.dev/agent-web react react-dom
```

Then add **only the model providers you use** (optional peers of the core,
dynamically imported):

```bash
# cloud, pick what you need
npm install @ai-sdk/openai        # or @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/xai, @ai-sdk/deepseek, @ai-sdk/openai-compatible
# local WebGPU models
npm install @browser-ai/web-llm @mlc-ai/web-llm
```

Import the optional stylesheet once (skip it if you style the components
yourself):

```ts
import '@dudko.dev/agent-web-react/styles.css'
```

## Quick start — a drop-in chat panel

`<AgentProvider>` builds one agent and shares it; `<AgentChat>` renders it.

```tsx
import { useMemo } from 'react'
import {
  AgentProvider,
  AgentChat,
  useCredentials,
  defineTool,
} from '@dudko.dev/agent-web-react'
import { z } from 'zod'
import '@dudko.dev/agent-web-react/styles.css'

export function Assistant() {
  const credentials = useCredentials() // encrypted vault (WebCrypto + IndexedDB)

  // Your app's actions, as tools. Keep the object referentially stable.
  const tools = useMemo(
    () => ({
      add_text: defineTool({
        description: 'Add a text block to the page.',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => addTextBlock(text), // your code
      }),
    }),
    [],
  )

  return (
    <AgentProvider
      config={{
        model: { providerType: 'google', model: 'gemini-3.5-flash', credentialRef: 'google' },
        credentials: credentials.store,
        tools,
        describeState: () => serializeMyState(), // optional grounding
      }}
    >
      <AgentChat title="Assistant" style={{ height: 520 }} />
    </AgentProvider>
  )
}
```

> **Using a bundler (Vite, Next, CRA)?** A provider **spec** like the one above
> asks the core to `import('@ai-sdk/google')` at runtime — but browser bundlers
> can't resolve that bare, `@vite-ignore`d import, so it fails with
> _“Provider package … is not installed”_ (and WebLLM fails with _“webLLM is not
> a function”_). Build the model yourself and pass it **directly** instead — see
> [Models in a bundler](#models-in-a-bundler-vite-next-cra). It's a few extra
> lines and works in every bundler.

Store the user's key once (encrypted at rest), e.g. from a settings form:

```tsx
const credentials = useCredentials()
await credentials.setKey('google', userProvidedKey)
// or drop in <ApiKeyForm credentials={credentials} credentialRef="google" />
```

## The `useAgent` hook (headless)

`useAgent` is the whole library in one hook — use it directly if you want your
own UI:

```tsx
import { useAgent } from '@dudko.dev/agent-web-react'

function Custom() {
  const agent = useAgent({
    // In a bundler, pass a model you built (see “Models in a bundler”); a
    // provider spec like this one only resolves where dynamic imports do.
    model: { providerType: 'openai', model: 'gpt-5.4-mini', credentialRef: 'openai' },
    credentials,
    tools,
  })

  return (
    <>
      <button disabled={!agent.isReady} onClick={() => agent.run('Add a totals row')}>
        Run
      </button>
      {agent.isRunning && <button onClick={agent.stop}>Stop</button>}

      {/* Everything below is live, derived from the event stream: */}
      {agent.plan && <p>{agent.plan.thought}</p>}
      {agent.steps.map((s) => (
        <div key={s.id}>
          {s.index}/{s.total} · {s.step.description} · {s.status}
          {s.toolCalls.map((c, i) => (
            <code key={i}>{c.name}</code>
          ))}
        </div>
      ))}
      <p>{agent.finalText}</p>
      <small>{agent.usage.totalTokens} tokens</small>
    </>
  )
}
```

`useAgent(config, options)` returns the full [`AgentUiState`](src/types.ts) plus:

| Field | Description |
| --- | --- |
| `run(goal, { images, files, attachments, label })` | Start a run (with attachments); resolves with the `RunResult` |
| `stop()` | Abort the in-flight run |
| `agent` | the core `Agent` itself (or `undefined` until built): `agent.usage` / `agent.sessionUsage()` (tokens spent, counted live; core ≥ 0.0.32), `agent.listLearnedSkills()`, `agent.capabilities` |
| `forgetSkill(name)` | delete one of the agent's own lessons from its notebook |
| `sendUndelivered()` / `discardUndelivered()` | send, or drop, what a stopped run never showed the agent |
| `send(text)`, `stopSubagent(id)` | Say something to the running agent (shown to the model at its next boundary; the replanner re-checks the plan) / stop one subagent. `queued`, `notes` and `undelivered` show where a message is — see [docs/chat.md](docs/chat.md#talking-to-the-agent-while-it-works) |
| `reset()` | Clear the whole conversation (and the agent's memory of it) |
| `reload()` | Rebuild the agent (e.g. after storing a new key) |
| `status` | `idle` \| `initializing` \| `ready` \| `running` \| `error` |
| `isReady` / `isRunning` | convenience booleans |
| `messages` | transcript; each assistant message keeps its steps, tool calls, thoughts, approvals, subagents, usage and duration |
| `plan` / `steps` | the live plan and per-step tool calls (with timing) |
| `finalText` / `finalReasoning` | the streamed answer and its thoughts |
| `usage` / `totalUsage` | tokens of this run / of the conversation, by kind - plus `mediaCalls` and `decisionCalls` (calls, not tokens) when the run made some |
| `pendingApprovals`, `approve(id, { remember })`, `deny(id)` | tool consent (a request made by a helper the model started carries `subagent: { id, depth, name?, role? }`). A request the core stops waiting for - no decision within `toolApproval.timeoutMs` (default five minutes), the run stopped - is settled by the core and leaves the list; a late `approve` does nothing |
| `approvalMode` / `setApprovalMode(mode)` | the autopilot switch, live |
| `approveAppToolCall(call, signal)` / `sampleForApp(request, approve, signal)` | for MCP Apps: an app's tool call through the agent's consent gate; an app's `sampling/createMessage` answered by the agent's model (the core's `Agent.sampleForApp`: checked, rate-limited, put to `approve`, no tools, none of the chat; its tokens count in `totalUsage` only, the answer goes to the caller only) - `<AgentChat>` wires both |
| `compact()` | summarise the stored transcript now |
| `sessionId` / `loadChat(chat)` | the memory session; switch conversations |
| `subagents`, `skills`, `discoveredTools`, `compactions`, `budget` | the rest of the run, folded. `subagents` is a **tree**: static subagents and the helpers the model started (`subagents.dynamic`), each node with `parentId` / `depth`, status, model, tokens, tool calls and time; `subagentTree(subagents)` nests it - see [docs/chat.md](docs/chat.md#subagents-and-helpers-the-tree) |
| `media`, `transcripts`, `decisions` | absent until there is one: the files the run generated (`MediaView[]`: a path in the workspace, never bytes), the audio it transcribed (`TranscriptView[]`), and the decision model's answers that came before any step (`DecisionView[]`; later ones are on their step) |
| `learned`, `learnedNow`, `fetches` | the agent's notebook (`LessonView[]`, survives `reset`), what it wrote this run, and the `web_fetch` requests this run made (`FetchView[]`) |
| `queued`, `notes`, `undelivered`, `replan` | steering: messages waiting, shown (and where), left over; the last replan decision (`byUser` when a message caused it; `failed` + `error` when the replanner call itself failed and the run went on with its plan) |
| `steps[i].tier`, `.model`, `.tierReason`, `.escalations`, `.replanFailed` | with the core's `executorTiers`: the tier and model a step is on, why it started there, and its escalations (`StepEscalationView[]`); a tool call of an escalated attempt has `attempt`, a write that was not run twice `replayed`. `replanFailed`: the replanner failed after this step (a warning). All absent when tiers are off — see [docs/chat.md](docs/chat.md#model-tiers-escalation-and-a-replanner-that-failed) |
| `error`, `stopped`, `events`, `seq` | the run's error text (a replanner failure is not one: see `replan.failed`), whether it was stopped, the raw event log and its counter |
| `modelLoad` | WebLLM download progress, when loading |

**Options:** `deps` (rebuild the agent when these change — e.g. on a model
switch), `onEvent` (tap the raw event stream), `autoStart`, `maxEvents`,
`approvals` (route consent requests into the hook; default true). The queue behind `approve` /
`deny` is exported for a host that builds the core's agent itself: `createApprovalQueue()` gives
`handler` (pass it as `toolApproval.onRequest`; a request whose `signal` aborts leaves the queue),
`approve(id, { remember })`, `deny(id, reason)`, `settleAll(decision)` and `pending()`.

> Keep `tools` and `describeState` referentially stable (`useMemo` /
> `useCallback`); pass a changed `deps` array to rebuild the agent on a
> model/provider switch.

## Local WebGPU model (no key, offline)

```tsx
import { useAgent, useWebLLMModel, ModelLoadBar } from '@dudko.dev/agent-web-react'
import { webLLM } from '@browser-ai/web-llm' // your app's optional peer

// Build WebLLM in your own code so the bundler includes it (see note below).
const createLocalModel = (id: string, opts?: object) => Promise.resolve(webLLM(id, opts as never))

function LocalAgent() {
  const local = useWebLLMModel('Qwen2.5-1.5B-Instruct-q4f16_1-MLC', { create: createLocalModel })
  const agent = useAgent(
    { model: local.model!, tools },
    { deps: [local.model] }, // build once the model is loaded
  )

  if (!local.ready) {
    return local.loading ? (
      <ModelLoadBar load={{ progress: local.progress, text: local.text }} />
    ) : (
      <button disabled={!local.supported} onClick={local.load}>
        Load local model
      </button>
    )
  }
  return <AgentChat controller={agent} />
}
```

> `load()` eagerly downloads the weights (so the progress bar fills during load,
> not silently on the first message) and `ready` flips only once the model can
> actually answer. The `create` option is what makes it work under a bundler —
> see below.
>
> Change the `modelId` and everything the hook reports — `model`, `ready`,
> `loading`, `progress`, `error` — is about the new one, which is not loaded
> yet. The previous model stays in memory (`loadedModelId`; switching back is
> instant) until the new one is loaded — that frees it first, so two models
> never share the GPU — or until `unload()`.
>
> **Context window.** WebLLM loads its models with a 4096-token window, far
> below what Qwen3 or Llama 3.x were trained on. Pass `contextWindowTokens` to
> load with more (it costs KV-cache VRAM, not a new download); your `create`
> factory receives it and applies it with the core's `withWebLLMContextWindow`
> (see the demo's `providers.ts`). `local.contextWindow` is the window the model
> was loaded with, and the agent fits its runs into it on its own — compaction,
> tool lists and tool results are sized from it.
>
> **Vision.** `Phi-3.5-vision-instruct-q4f16_1-MLC` takes images (paste, drop
> or attach them) — a multimodal model that never sends them anywhere.

### Any on-device runtime — `useLocalModel`

`useWebLLMModel` is `useLocalModel` with the WebLLM engine. Describe another
runtime as an engine — `create`, and optionally `warmUp` (download now, with
progress), `unload`, `supported`, `contextWindowOf` — and the hook gives the
same `load` / `unload` / progress / switching:

```tsx
import { useLocalModel, createWebLLMEngine, type LocalModelEngine } from '@dudko.dev/agent-web-react'

const builtIn: LocalModelEngine = {
  create: async () => (await import('@browser-ai/core')).browserAI('text', {
    expectedInputs: [{ type: 'text' }, { type: 'image' }],
  }),
  warmUp: async (m, { onProgress }) => {
    await m.createSessionWithProgress((p) => onProgress({ progress: p, text: 'Downloading' }))
  },
  supported: () => 'LanguageModel' in globalThis, // Chrome's Prompt API
  contextWindowOf: (m) => m.getContextWindow(),
}
const webllm = createWebLLMEngine({ create: createLocalModel })

// One hook, any runtime: switching frees the previous model with its own engine.
const local = useLocalModel(option.model, option.builtIn ? builtIn : webllm, {
  contextWindowTokens: option.contextWindow,
})
```

The demo runs WebLLM, Chrome's Gemini Nano and transformers.js this way — see
[`apps/demo/src/local-engines.ts`](https://github.com/dudko-dev/agents/blob/main/apps/demo/src/local-engines.ts).

## Models in a bundler (Vite, Next, CRA)

The core builds cloud providers with `import('@ai-sdk/<provider>')` and WebLLM
with `import('@browser-ai/web-llm')`. Those are **bare, `@vite-ignore`d dynamic
imports** — great for Node/SSR/import-map setups, but a browser bundler either
leaves them unresolvable at runtime (cloud → _“Provider package … is not
installed”_) or stubs them to an empty module (WebLLM → _“webLLM is not a
function”_).

The fix is the same for both: **build the model in your own code** (a static
import your bundler can see) and hand the agent a direct `LanguageModel`.

**Cloud** — construct the provider from the vault-stored key:

```tsx
import { useEffect, useState } from 'react'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import { useAgent, useCredentials } from '@dudko.dev/agent-web-react'

function CloudAgent() {
  const credentials = useCredentials()
  const [model, setModel] = useState<LanguageModel>()

  useEffect(() => {
    credentials.store.getApiKey('google').then((key) => {
      setModel(key ? createGoogleGenerativeAI({ apiKey: key })('gemini-3.5-flash') : undefined)
    })
  }, [credentials.store, credentials.version])

  const agent = useAgent({ model: model!, credentials: credentials.store, tools }, { deps: [model] })
  // …render <AgentChat controller={agent} /> once model is set
}
```

> Anthropic needs `headers: { 'anthropic-dangerous-direct-browser-access': 'true' }`
> passed to `createAnthropic({ … })` for direct browser calls.

**Local** — pass a statically-imported `webLLM` factory via `useWebLLMModel`'s
`create` option (see the WebLLM example above).

The [`apps/demo`](https://github.com/dudko-dev/agents/tree/main/apps/demo) app does exactly this — see
[`apps/demo/src/providers.ts`](https://github.com/dudko-dev/agents/blob/main/apps/demo/src/providers.ts).

## MCP hooks live in their own subpath

```tsx
import { useMcp, useMcpServers } from '@dudko.dev/agent-web-react/mcp'
```

The MCP hooks are **not** exported from `@dudko.dev/agent-web-react`. They load the
core's `@dudko.dev/agent-web/mcp`, which imports the MCP SDK
(`@modelcontextprotocol/client`) — an
*optional* peer, so npm does not install it for you. A bundler cannot honour
"optional": it resolves even a dynamic `import()` at build time, so a host that
merely imported `useAgent` from the main entry used to fail webpack/CRA with
`Module not found` for the SDK while never touching MCP. Behind a
subpath the decision is yours:

- **Don't use MCP** → import only from the main entry. Nothing in your build
  mentions the SDK; install nothing extra.
- **Use MCP** → import from `…/mcp` and `npm install @modelcontextprotocol/client`
  next to the core (it is bundled into an async chunk, loaded when you connect).

> **The MCP SDK is the core's peer, and it was renamed.** A core on the 2.x MCP
> SDK (`@dudko.dev/agent-web@0.0.40` and later) imports
> `@modelcontextprotocol/client` (`^2.4.0`); cores up to 0.0.39 import
> `@modelcontextprotocol/sdk` 1.x. Install the one your core asks for — when you
> upgrade the core: `npm uninstall @modelcontextprotocol/sdk && npm install
> @modelcontextprotocol/client`. This package imports neither, and its hooks
> work with both. Nothing changes in the hooks' API: `ConnectedMcp`,
> `BrowserOAuthProviderOptions`, `McpServerResult` and the other types exported
> from `…/mcp` are structural types of this package, not the SDK's. The one
> difference you can observe: `isUnauthorizedError(err)` now also recognises the
> error by its `name` (the 2.x class sets it) and across two copies of the SDK.
> A tool call refused with `403 insufficient_scope` fails with the SDK's
> `InsufficientScopeError`, which is **not** an authorization failure for
> `isUnauthorizedError` — the status stays `connected`. See the core's
> [upgrade notes](https://github.com/dudko-dev/agents/blob/main/packages/agent-web/README.md#upgrading-to-the-2x-mcp-sdk).

> **Migrating from ≤ 0.0.18.** `useMcp`, `useMcpServers` and their helpers
> (`readCallbackParams`, `claimOAuthCallback`, `stripOAuthParams`,
> `describeMcpResult`, `isUnauthorizedError`) and types (`McpStatus`,
> `McpAuthMode`, `McpServerView`, …) moved: change the import path, nothing else.

## Pipelines: an editor on a canvas

```tsx
import { PipelineEditor, usePipeline } from '@dudko.dev/agent-web-react/pipeline'
import '@dudko.dev/agent-web-react/pipeline.css'

const pipeline = usePipeline(definition, { base: { model, credentials }, tools: { files } })
return <PipelineEditor value={definition} onChange={setDefinition} controller={pipeline} />
```

The editor for the core's [pipelines](https://github.com/dudko-dev/agents/blob/main/packages/agent-web/docs/capabilities.md#pipelines-a-graph-of-agents)
(a graph of agents in plain JSON) lives in its own entry, like MCP and for a similar reason: a
chat host should not carry a canvas, an inspector and a code generator, nor need a core new
enough to have `createPipeline`. Nothing in the main entry references it. Its stylesheet,
`pipeline.css`, is separate too and stands on its own. It adds **no dependency**: the canvas is
this package's own code.

| Export | What it is |
| --- | --- |
| `usePipeline(definition, options)` | Builds the pipeline with the core (`resolveNode`, or the registries of `nodeResolver`: `base`, `models`, `skills`, `tools`, `mcpServers`), and returns `run(input)`, `stop()`, `reset()`, `isRunning`, `validation`, `result` plus the state below. |
| `pipelineStateReducer`, `createInitialPipelineState`, `pipelineNodeView` | The pure event → state reducer: per-node status and visits, which edges fired, what each node's agent is doing, outputs, usage, `stoppedBy`, the error. |
| `<PipelineEditor>` | The editor: canvas, node cards, inspector, toolbar, validation, run bar, results. Controlled (`value`, `onChange`). |
| `<PipelineNodeCard>`, `<PipelineInspector>`, `<PipelineResults>`, `<PipelineIssues>`, `<PipelineCodeDialog>` | Its parts, to compose your own. |
| `<Canvas>`, `<CanvasPort>` and the canvas maths | The generic node-and-edge canvas underneath: pan, zoom, drag, connect, keyboard, screen readers. |
| `addNode`, `removeNode`, `renameNode`, `addEdge`, `updateEdge`, `removeEdge`, `setEntry`, `autoLayout`, `parsePipelineJson`, ... | Editing a definition, as pure functions. |
| `pipelineToCode(definition, { target })` | "Copy as code": a snippet for the browser package or for the Node one. |
| `PipelineLabelsProvider`, `defaultPipelineLabels`, `usePipelineLabels` | Every string of the editor (its own labels object, not `AgentLabels`). |

The full guide, with every prop, state field and label: [docs/pipeline.md](docs/pipeline.md).
Live: <https://agent.dudko.dev/pipeline/>.

## The `useMcp` hook — connect a remote MCP server

Let the user name their own MCP server at runtime and hand its tools to the
agent. Auth is either a static header or the full OAuth 2.1 flow with **dynamic
client registration** — no client ID to configure, and the access token is
refreshed for you when it expires mid-run.

```tsx
import { useMcp } from '@dudko.dev/agent-web-react/mcp'

const mcp = useMcp({ clientName: 'my-app' })

await mcp.connect({ url, oauth: true })       // or { url, headers: { Authorization } }

// The server wants a sign-in: send the user off from a real click.
{mcp.status === 'needs-authorization' && <button onClick={mcp.authorize}>Authorize</button>}

// Then just merge the tools into any agent config.
const config = { model, tools: { ...myTools, ...mcp.tools } }
```

`useMcp` returns `{ status, tools, catalog, instructions, protocol, error, authorizationUrl,
oauthSupported, completingAuthorization, pendingElicitations, answerElicitation, connect,
disconnect, authorize, forgetAuthorization, checkOAuthSupport }`. `status` is
`idle | connecting | connected | needs-authorization | error`. `protocol` is the revision
negotiated with the connected server (`{ server, version, era }`, e.g. `2025-11-25` / `legacy` or
`2026-07-28` / `modern`; absent until connected, and on a core that does not report it).
`pendingElicitations` / `answerElicitation` are the server's questions to the user - see
[MCP elicitation](#mcp-elicitation--a-server-asks-the-user).

`instructions` is what the connected server told the agent in its handshake (MCP `instructions`),
when it sent any. The core puts that text into the system prompt of an agent that uses the
server's tools, and it is **third-party text**: with bring-your-own servers, show it to the user,
labelled as the server's words (`useMcpServers().servers[i].instructions` is the same per server;
`mcpInstructionsOf(connection, name)` reads it from a `ConnectedMcp`).

The OAuth round-trip navigates away from your app, so the hook persists what it
needs and, on the way back, finishes the code exchange (passing `iss` to the
core, which refuses a response from another authorization server - RFC 9207),
strips `?code=…` from the address bar and reconnects before rendering — `completingAuthorization`
covers that window.

Options:

| | |
| --- | --- |
| `useMcp({ clientName })` | the MCP client name, and the `client_name` of a dynamic registration |
| `useMcp({ clientMetadataUrl })` | the URL of a **client ID metadata document** (CIMD) your app hosts, for every OAuth server - see below |
| `useMcp({ onLog })` | connector log lines |
| `useMcp({ elicitation })` | let a server ask the user something in the middle of a tool call: `true`, or the core's settings `{ url, timeoutMs, maxPerToolCall, maxPerRun, subagents }`. Off by default - see [MCP elicitation](#mcp-elicitation--a-server-asks-the-user) |
| `connect({ url, name, headers })` | the endpoint, the tool prefix (`"<name>__<tool>"`, default `mcp`), static headers |
| `connect({ oauth })` | `true`, or `{ redirectUrl, scope, clientName, clientMetadataUrl, registration }` (`McpOAuthOptions`) - each overrides the hook-level value for this server; `registration` is below |
| `connect({ protocol })` | the MCP protocol revisions this connection may use: `'legacy'` (the 2025 revisions), `'auto'` (2026-07-28 when the server offers it, the 2025 ones otherwise) or `'modern'` (2026-07-28 only). Left out, nothing is passed and the core speaks the 2025 revisions, exactly as before. Kept across the OAuth redirect. See [the protocol revision](#the-protocol-revision) |
| `connect({ skills })` | **experimental**: load the skills the server serves (the MCP Skills extension) into the agent's skills catalog, as `<server>/<skill>`. They come with `tools` - nothing else to wire. Needs `protocol: 'auto'` or `'modern'`. `true`, or `{ consent: 'once-per-skill' \| 'ask' \| 'never' }` (when a person is asked before one of its skills enters the agent's context; `McpSkillsSetting`, `mcpSkillsSettingOf`). Off (left out) by default. Kept across the OAuth redirect. See [MCP skills](#mcp-skills-experimental) |

**`clientMetadataUrl` (CIMD).** Instead of registering itself with every authorization server, an
app can publish one JSON document that describes it and use that document's URL as its
`client_id`:

```tsx
const mcp = useMcp({
  clientName: 'my-app',
  clientMetadataUrl: 'https://my-app.example/oauth/client.json',
})
await mcp.connect({ url, oauth: true })
// or for one server only: connect({ url, oauth: { clientMetadataUrl: '…' } })
```

The hooks pass the URL to the core's OAuth provider unchanged. An authorization server that
advertises `client_id_metadata_document_supported` takes it as the `client_id` and no registration
request is made; any other server gets dynamic registration as before, and a registration already
stored for the server wins over both (`forgetAuthorization` drops it). The URL must be https with a
path of its own, and the document served there must list the `redirectUrl` (by default this page,
without query or hash) in its `redirect_uris` - the core refuses any other URL before a request is
made, and the server ends in `status: 'error'` with the reason. The URL is public and is remembered
with the rest of the server's OAuth details across the redirect and reloads. The core's
[README](https://github.com/dudko-dev/agents/blob/main/packages/agent-web/README.md) and
[security notes](https://github.com/dudko-dev/agents/blob/main/packages/agent-web/docs/security.md)
say what the document must contain.

**`oauth.registration`: CIMD, DCR, or whichever the server supports.** Per server, `'auto'` (the
default - the document where the server supports it, dynamic registration elsewhere), `'cimd'` (the
document only) or `'dcr'` (dynamic registration only, even with a `clientMetadataUrl`), handed to
the core's provider of the same name:

```tsx
await mcp.connect({ url, oauth: { registration: 'cimd' } }) // with useMcp({ clientMetadataUrl })
mcp.oauthRegistration // 'cimd' | 'dcr', once connected: which way was taken
```

Under `'cimd'` a server whose authorization server does not support documents ends in
`status: 'error'` with the core's reason - `… does not support client ID metadata documents (CIMD),
which this connection requires (registration: 'cimd') - nothing was sent to its registration
endpoint` - and is never offered for authorization; `'cimd'` with no `clientMetadataUrl` fails the
same way before any request. A client stored for the server under the other kind is not reused:
the core forgets it and its tokens, and the user signs in again. The setting is kept across the
redirect (and, in `useMcpServers`, with the server list); `oauthRegistration` (`useMcp`) /
`servers[i].oauthRegistration` (`useMcpServers`) is `'cimd'` or `'dcr'` while the server is
connected with OAuth, read from the core's `registrationKind()`. A core older than the option
would ignore it and register the old way, so the hooks refuse `'cimd'` / `'dcr'` there
(`status: 'error'`); `'auto'` and no value work with any core. The helpers the hooks use are
exported from `./mcp`: `newMcpOAuthProvider`, `mcpOAuthRecordOf` / `mcpOAuthOptionsOfRecord` (what
the redirect record keeps) and `mcpOAuthRegistrationOf`.

Two notes:

- The connector lives in the core's optional `@dudko.dev/agent-web/mcp` subpath
  and is loaded with a **dynamic import**, so the SDK stays out of your initial
  bundle until `connect` runs. Install `@modelcontextprotocol/client` alongside the
  core (`@modelcontextprotocol/sdk` for a core up to 0.0.39) — importing these
  hooks is what puts it in your build.
- `oauthSupported` is `false` on cores older than `@dudko.dev/agent-web@0.0.9`,
  which introduced `BrowserOAuthProvider`; header auth still works there. The
  peer floor is `>=0.0.39` — the first core with model tiers, dynamic subagents,
  media and decision models, whose helpers and constants this package imports
  (`isReplayedToolOutput`, the media type lists), on top of pipelines, the learning
  notebook, the virtual file system, attachments, consent, tool search, subagents,
  steering and context editing this package's chat builds on.

## Several MCP servers — `useMcpServers`

```tsx
import { useMcpServers } from '@dudko.dev/agent-web-react/mcp'

const mcp = useMcpServers({ clientName: 'my-app' }) // the list persists; reconnects on load
await mcp.add({ name: 'docs', url, auth: 'oauth' }) // 'none' | 'bearer' (+ token) | 'oauth'
mcp.servers  // [{ name, url, status, catalog, instructions, error, … }]
const config = { model, tools: { ...myTools, ...mcp.tools } } // "<name>__<tool>"
```

`useMcpServers` takes the options of `useMcp` (`clientName`, `clientMetadataUrl`, `onLog`,
`elicitation`) plus `persist`, `storageKey`, `autoConnect` and `connectTimeoutMs`, and returns
`{ servers, tools, catalog, protocols, connectedCount, pendingElicitations, answerElicitation, … }`.
A server may be added with its own `protocol` (`add({ name, url, protocol: 'auto' })`),
`skills: true` or `{ consent }` ([MCP skills](#mcp-skills-experimental); `servers[i].skills`) and `apps: false`
(that server's [MCP Apps](#mcp-apps--a-servers-interface-in-the-chat) off while the others' are
shown; `servers[i].apps`), all remembered with the list; `servers[i].protocolMode` is what it was added with and
`servers[i].protocol` (`{ version, era }`) what was negotiated while it is connected - `protocols`
lists them for every connected server. A server added with
`auth: 'oauth'` may carry its own `oauth: { redirectUrl, scope, clientName, clientMetadataUrl, registration }`,
which wins over the hook-level values and is remembered with the list; `servers[i].oauthRegistration`
says which way its client was registered once it is connected:

```tsx
const mcp = useMcpServers({ clientMetadataUrl: 'https://my-app.example/oauth/client.json' })
await mcp.add({ name: 'docs', url, auth: 'oauth' }) // CIMD where the server supports it, DCR elsewhere
await mcp.add({ name: 'crm', url: crmUrl, auth: 'oauth', oauth: { registration: 'cimd' } }) // CIMD or nothing
mcp.servers[0].oauthRegistration // 'cimd' | 'dcr'
```

Servers connect in parallel, each with its own deadline; paginated tool lists
are read to the end; tools a server marks read-only skip the "ask before
changes" prompt. With hundreds of tools the core switches to **tool search**
(a compact catalogue + `find_tools`) above `toolSearchThreshold` — see the
core's [capabilities doc](https://github.com/dudko-dev/agents/blob/main/packages/agent-web/docs/capabilities.md).

### MCP skills (experimental)

```tsx
await mcp.add({ name: 'docs', url, protocol: 'auto', skills: true })
// the agent's catalog now has docs/<skill> entries; mcp.servers[0].skills === true
// a server you vetted: its skills load without asking
await mcp.add({ name: 'ours', url: ourUrl, protocol: 'auto', skills: { consent: 'never' } })
```

A server may serve **skills** (the `io.modelcontextprotocol/skills` extension, Beta): instruction
files the agent can load. With `skills: true` (on `connect`, or per server on `add`, remembered
with the list) the core declares the extension and puts the server's skills into the agent's
catalog next to your own skills and the agent's lessons, named `<server>/<skill>` - so a server
can never take the name of one of yours, nor of another server's skill. Nothing else is wired: the
skills come with the server's `tools`, like its instructions. The run's skills
(`message.skills`, the `skill.activated` event, which carries `server` for these) show that
name, so a UI says whose skill it is. The text is third-party: the core loads it on demand,
verified against the server's digests, under a preamble that says it is knowledge only - it cannot
approve a call, change the approval mode, open the web or run code (while the agent acts on one, a
tool that runs code is always asked). Needs the 2026-07-28 revision. The core's
[README](https://github.com/dudko-dev/agents/blob/main/packages/agent-web/README.md) ("MCP
skills") has the rules.

**A person sees a server's skill before the agent does.** The first time a skill would enter the
agent's context, the core asks through the same consent gate as a tool call - `useAgent()`'s
`pendingApprovals` gets a request whose `skill` (`SkillConsentView`) holds the server, the skill,
its description, size and files, and the very text the model would read (`skill.body`, while the
request is open: the reducer drops it once it is decided, so a saved chat does not keep it).
`<AgentChat>` / `<ToolApprovalPrompt>` render it as its own card - "The server “docs” offers the
skill “pdf-processing”", the description, a collapsed preview of the text (plain text) and **Allow
once** / **Always for this server** / **Deny**; `approve(id)` / `approve(id, { remember: true })`
/ `deny(id)` answer it. Asked whatever the approval mode - autopilot too. `skills: { consent }`
(per server, remembered) or the agent's `mcpSkills: { consent }` (core config) choose when:
`'once-per-skill'` (default: once per skill in the agent's life, again when the server changes
it), `'ask'` (every task that loads it) or `'never'` (a server you vetted: today's behaviour). A
skill inside another one (nested) is asked about on its own. The agent may also load a skill a
server names by its address (`skill://…/SKILL.md`, in its instructions or a skill), from that
server only - the card says so (`skill.byUri`).

### The protocol revision

```tsx
await mcp.add({ name: 'docs', url, protocol: 'auto' })
mcp.servers[0].protocol // { version: '2026-07-28', era: 'modern' } - or 2025-11-25 / legacy
```

- `'legacy'` (and no `protocol` at all) is the 2025 handshake: the requests and the CORS request
  headers are exactly what they were before the option existed.
- `'auto'` asks the server first (`server/discover`, one extra request at connect) and speaks
  2026-07-28 to a server that offers it. From a page, that revision sends two more request headers,
  `Mcp-Method` and `Mcp-Name`: a server whose `Access-Control-Allow-Headers` does not list them
  blocks the probe in the browser, and the core falls back to the 2025 revisions with a warning
  (`onLog`) that names the missing headers.
- `'modern'` is 2026-07-28 only: a server that does not offer it, or whose CORS blocks the headers,
  fails the connect with the reason.

The revision is decided once, at connect. The core's
[README](https://github.com/dudko-dev/agents/blob/main/packages/agent-web/README.md) has the
details (CORS, tool-list changes on 2026-07-28).

## MCP elicitation — a server asks the user

A server may ask the **user** for input in the middle of a tool call: a form to fill in (a name, a
date, a choice), or - with `url: true` - a page to open (a payment, a sign-in on the server's own
site). Turn it on in the hook and show the questions:

```tsx
import { useMcpServers } from '@dudko.dev/agent-web-react/mcp'
import { AgentChat, useAgent } from '@dudko.dev/agent-web-react'

const mcp = useMcpServers({ elicitation: { url: true } }) // or `true`: forms only
const agent = useAgent({ model, tools: mcp.tools }, { deps: [mcp.tools] })

<AgentChat
  controller={agent}
  elicitations={mcp.pendingElicitations}
  onElicitationAnswer={mcp.answerElicitation}
/>
// or anywhere: <ElicitationPrompt elicitations={…} onAnswer={…} outcomes={agent.elicitations} />
```

- **Off by default.** Without `elicitation` the hooks pass nothing to the core: no capability is
  declared in the handshake, a server cannot ask, and the wire is what it was. `true` turns it on
  with the core's defaults; an object is the core's settings - `url` (also offer URL mode; default
  false), `timeoutMs` (how long a question waits; default 300 000), `maxPerToolCall` (5),
  `maxPerRun` (20), `subagents` (let a helper's call ask too; default false). The option is read
  when a server connects: changing it takes a reconnect. A core without elicitation ignores it.
- **`pendingElicitations`** are the questions waiting, oldest first (`PendingElicitation`: the
  core's `McpElicitationRequest` - `id`, `server`, `tool`, `mode`, `message`, `requestedSchema` or
  `url`, `subagent?` - plus `expiresAt` when the question has a time limit). **`answerElicitation(id,
  result)`** answers one: `{ action: 'accept', content }` (a form's values; nothing for a link),
  `{ action: 'decline' }` or `{ action: 'cancel' }`; it returns false when the question is no longer
  waiting. A question also leaves the list, answered `cancel`, when the core stops waiting (its time
  ran out, the run stopped), when its server is disconnected or removed, and when the component
  that holds the hook unmounts.
- **Time.** A question waits `timeoutMs` (default 300 000: five minutes; `0` or `Infinity` = until
  the run is stopped). The step it belongs to does not cut it short: the core stops the step's
  clock (`chatTimeoutMs`) while a person is asked, and the step goes on with the time it had left
  once the question is settled. A question nobody answered in time is cancelled by the core and its
  tool call fails; the prompt then says it was answered automatically, and why.
- **`<ElicitationPrompt>`** (main entry; it imports neither the SDK nor the core's `./mcp`) draws the
  question where the consent cards are, one at a time with a count: the host's own header (which
  server asks, during which tool), the server's message under a caption that says it is the
  server's, then the form - text (plain, email, URL, date, date and time, with length limits),
  numbers and whole numbers (with bounds), a tick box, a select (plain, titled, `enumNames`), a
  multi-select - with required marks, titles, descriptions and defaults, and **Submit / Decline /
  Cancel**. Submit is checked first by the core's own rules (`elicitationFormAnswer`) and a refused
  field says what is wrong with it, by name. A link shows its host large, the whole address as
  text, and an **Open in a new tab** button; "I have finished there" (the accept) appears once the
  user opened it.
- **On the 2025 revisions** the core sends the calls to a server that may ask one at a time
  (its question does not say which call it belongs to); on 2026-07-28 a question is part of the
  call's own answer. Both work the same from here.

A host that calls the core's `connectMcpHttp` itself can use the same queue the hooks use
(`createElicitationQueue` from `…/mcp`) or pass its own `onElicitation`, and render
`<ElicitationPrompt>` with what it was given.

> **Security.** The question is the SERVER's text, and the prompt treats it so. Its message, the
> field titles and descriptions and the option names are shown as plain text (never as markup)
> inside a box captioned "From the server “*server*”"; the header above it is the
> app's own. A link is never followed by itself: there is no `<a>`, nothing opens it before the
> user's click on **Open**, which calls `window.open(url, '_blank', 'noopener,noreferrer')`, and
> there is no Open at all for anything but https (or http on a loopback host) without credentials -
> checked again here, although the core already refuses such links. What the user types stays in
> the prompt's own component state until Submit hands it to `answerElicitation`, which passes it
> to the core and keeps nothing: it is not in the agent's state (`state.elicitations` holds field
> NAMES only), its events, the transcript, a saved chat or a log. The core sends it to the server
> that asked and nowhere else - never to the model.

## MCP Apps — a server's interface in the chat

`apps: true` (on `useMcp` or `useMcpServers`) declares the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)
extension: a tool whose server ships an HTML app for its result comes with that app, and
`<AgentChat mcpApps>` draws it under the answer in a sandboxed frame. Whatever the app asks the
host to do - call a tool of its server, open a link, put a message in the chat - is put to the
user in the chat's consent area, labelled as the app's.

```tsx
const mcp = useMcpServers({ apps: true })
const agent = useAgent({ model, tools: mcp.tools }, { deps: [mcp.tools] })
<AgentChat controller={agent} mcpApps={mcp.apps} appPanel="auto" />
```

Off by default (the hooks declare nothing and every tool is mounted as before). Needs a core with
MCP Apps. See [docs/chat.md](docs/chat.md#mcp-apps-a-servers-interface-in-the-chat).

**One server's apps off.** `useMcpServers({ apps: true })` with `add({ name, url, apps: false })`:
that server is not told of apps, none of its apps is read or drawn, a tool it marks for its app
only is mounted for nobody, and its other tools are plain tools.

**What an app may ask for besides** - each off by default, each put to the user:

```tsx
<AgentChat
  controller={agent}
  mcpApps={mcp.apps}
  appFullscreen // ui/request-display-mode: full screen over the chat, after a click in the app; Esc / Exit back
  appDownloads // ui/download-file: name, type, size shown; saved by your page; programs, scripts, pages refused
  appSampling // sampling/createMessage: the agent's model answers the app; no tools; the answer never in the chat
/>
```

`hostCapabilities` names only what is on (`downloadFile`, `sampling` - never `sampling.tools`);
`hostContext.availableDisplayModes` is `['inline', 'fullscreen']` with `appFullscreen` (no
picture-in-picture). The rules: [docs/chat.md](docs/chat.md#what-an-app-may-ask-for-besides-a-tool-call).

**An origin of its own (opt-in).** By default an app runs in an opaque frame: no storage or
cookies of its own, requests with `Origin: null`. Serve the sandbox page of
`@dudko.dev/agent-web-react/mcp-app-sandbox` on ANOTHER origin and pass its URL, and apps run on
that origin instead - the specification's sandbox proxy:

```tsx
<AgentChat controller={agent} mcpApps={mcp.apps} appSandbox={{ url: 'https://apps.example.com/sandbox/v1' }} />
// or one origin per server (needs a wildcard certificate): 'https://{server}.apps.example.com/sandbox/v1'
```

```ts
// A Cloudflare Worker on apps.example.com (or Node / Deno / Bun: Request in, Response out)
import { mcpAppSandboxResponse } from '@dudko.dev/agent-web-react/mcp-app-sandbox'
export default {
  fetch: (request: Request) =>
    mcpAppSandboxResponse(request, { path: '/sandbox/v1', hosts: 'https://chat.example.com' }),
}
```

A URL on your page's own origin, or not `https://` (`http://` only on `localhost` / `127.0.0.1`), is
refused; a sandbox page that does not answer in `timeoutMs` (5 s) is given up for the page's life.
Either way the app runs in the opaque frame - the stricter of the two - and its header says
"sandboxed" instead of "sandboxed on its own origin". The headers, the hosts setting and the
trade-offs: [docs/chat.md](docs/chat.md#an-app-on-an-origin-of-its-own).

## Components

All components are optional and styled by `styles.css` (class-prefixed `awr-`,
themeable via `--awr-*` custom properties, light + dark, or `theme`). Each
accepts a `className` and `labels`; data components take plain props so you can
use them standalone. The full guide: [docs/chat.md](docs/chat.md).

| Component | Purpose |
| --- | --- |
| `<AgentChat>` | Full panel: transcript with per-answer activity + composer + optional history and files panels. Reads a `controller` prop or the `<AgentProvider>` context. |
| `<AgentComposer>` | The input and its toolbar: attachments, commands, timer, agents, model/thinking, consent, mic, send/stop. |
| `<MessageList>` | The transcript; each answer with its steps, tool calls, thoughts, usage. |
| `<StepList>` / `<ToolCallRow>` | Execution steps / one tool call with its cost and images. With model tiers: the tier / model badge, the escalation line, the earlier attempt's calls (`showTiers`); a replanner failure as a warning (`showReplanFailed`); the decision model's note (`showDecisions`); the subagent tree under its step (`showSubagents`); a `web_search` call's results as plain text and safe links (`showSearchResults`). |
| `<SubagentTree>` / `<SubagentRow>` | The run's subagents - static ones and the helpers the model started - as an indented tree: status, model, tokens, time and a Stop button per node (`onStop`, `showUsage`, `showTools`, `renderSubagent`). |
| `<GeneratedMedia>` / `<TranscriptBlock>` | A file a media tool wrote, read from the workspace: an image inline or a native audio player (only the types the core generates; never SVG) / a folded "Transcript of …" block. `<MessageList files showMedia renderMedia>` places them in the answer. |
| `<FileChips>` / `<FileChip>` | The files an answer wrote to the workspace (the core's `file.written` / `file.deleted`), as chips: name, kind, size, open, download; an inline preview (text with line numbers, a picture, your own rendering through `renderFileContent`), and an `.html` file in a sandboxed frame with Preview / Source. `<MessageList files showFileChips htmlPreview renderFile renderFileContent>` places them under the answer. |
| `<SandboxedFrame>` / `<SourceView>` | Untrusted HTML inside chrome the host draws: `<iframe sandbox>` without `allow-same-origin`, by `srcdoc`, no network, fixed height (`html`, `scripts`, `title`, `label`, `actions`, `footer`, `height`) / a file's text with line numbers, never markup. See [the boundary](#the-html-preview-is-a-security-boundary). |
| `<ToolApprovalPrompt>` | Consent cards (Allow once / Always / Deny); a helper's request says which helper asks (`showHelper`); an MCP App's says the APP asks, with the server's own tool name; an MCP server's skill gets its own card (the server, the skill, a collapsed preview of its text - `showSkillPreview` - and Allow once / Always for this server / Deny). |
| `<ElicitationPrompt>` | A question an MCP server puts to the user during a tool call: a form (Submit / Decline / Cancel, checked by the core's rules) or a link opened only by a click, one at a time with a count, the time left, and the questions nobody answered (`elicitations`, `onAnswer`, `outcomes`, `showOutcomes`, `showExpiry`, `showHelper`, `renderElicitation`). See [MCP elicitation](#mcp-elicitation--a-server-asks-the-user). |
| `<McpAppFrame>` / `<McpAppLine>` | An MCP App in host-drawn chrome ("App from server “travel” · sandboxed", panel, menu: reload / open in panel / hide): an opaque-origin frame - or, with `host.sandbox` (`useMcpAppHost({ sandbox })`, `<AgentChat appSandbox>`), an origin of its own behind your sandbox page ("· sandboxed on its own origin") - network only to the origins its resource declared, a bridge with an allow-list; inline, folded, in a panel or - with `allowFullscreen`, asked for by the app after a click in it - full screen over the chat with Exit / Esc (`app`, `host`, `variant`, `theme`, `defaultCollapsed`, `onOpenPanel`, `onClosePanel`, `showCalls`, `allowFullscreen`). `<AgentChat mcpApps>` places them under the answer. See [the boundary](#an-mcp-app-is-a-security-boundary). |
| `<AppRequestPrompt>` | What an MCP App asks for besides a tool call: a link (its host highlighted, opened only on the user's click), a message (put in the message box as a draft, never sent for the user), a file (its sanitized name, type and size; saved by the page on Save file) or an answer of the agent's model (the app's text as text, the token cap; Allow once / Always for this app / Deny). |
| `<ApprovalModeSwitch>` | Segmented consent-mode switch. |
| `<ChatHistoryList>` | Saved chats (from `useChatHistory`). |
| `<FilesPanel>` | A `VirtualFileSystem`, live: preview, download, delete, upload. |
| `<LearnedSkills>` | The agent's notebook (`learning`): its lessons, where each came from, forget. |
| `<ContextMeter>` | Tokens by kind, budget bar, last compaction, Compact. |
| `<PlanView>` | A plan's reasoning + step list. |
| `<ModelLoadBar>` | WebLLM download/init progress. |
| `<UsageBadge>` | Compact token readout; media and decision calls when there were some (`showCalls`). |
| `<ApiKeyForm>` | BYOK key entry that writes to the encrypted vault. |
| `<Composer>` | The minimal textarea + send/stop (kept for existing apps). |
| `<PipelineEditor>` and its parts | The pipeline editor - from `@dudko.dev/agent-web-react/pipeline`, styled by `pipeline.css`. See [Pipelines](#pipelines-an-editor-on-a-canvas). |

### The HTML preview is a security boundary

`<AgentChat files={vfs}>` shows the files an answer wrote as chips, and an `.html` one can be
previewed. That page is **untrusted**: a model wrote it, possibly on the say-so of a page it read,
and your origin holds the key vault. The preview therefore never puts the file into your document
and never opens it by URL - `<SandboxedFrame>` draws it:

| Guard | What it stops |
| --- | --- |
| `<iframe sandbox>` = `""` or `"allow-scripts"`, never `allow-same-origin` | reading your DOM, `localStorage`, cookies, IndexedDB (an opaque origin); no top navigation, popups, forms, modals, downloads |
| `srcdoc`, never a `blob:` / `data:` URL | the same document opened outside the sandbox with your origin |
| CSP with no network source (`default-src 'none'`, inline styles, `data:` / `blob:` images) | `fetch`, XHR, beacon, WebSocket, `<img src=https://…>`, external scripts and styles, forms |
| the policy first in the document AND inherited from a shell document of ours | a page that brings its own `<meta>` policy, a `<base>`, or content before `<html>` |
| the shell's `frame-src 'none'` | the frame navigating itself to the network (`location = …`, a link, `<meta http-equiv=refresh>`) |
| the label, the switch and the footer drawn by the host, outside the frame; a fixed height; no message listened to | content imitating chat controls or resizing itself over them |
| Source as text nodes | markup injection through the source view |

Scripts are **off by default** (`htmlPreview={{ scripts: true }}` runs the page's inline scripts,
still without an origin or a network; `htmlPreview={false}` shows HTML as source only). Limits of
this version: files a page links to (`style.css`, `app.js`, images next to it) are not loaded, and
the frame says so; a DNS prefetch is not a request the policy sees (it can carry only what the
agent itself wrote into the page); the guards are verified in Chromium. Every guard has a test in
`tests/files.test.ts` and, in a real browser, in `e2e/files.spec.ts`. Details:
[docs/chat.md](docs/chat.md#the-html-preview-is-a-security-boundary).

### An MCP App is a security boundary

An MCP App is third-party HTML **with scripts** that talks to your page. `<McpAppFrame>` keeps the
HTML preview's boundary and adds a bridge:

| Guard | What it stops |
| --- | --- |
| `<iframe sandbox="allow-scripts">` (outer and inner), never `allow-same-origin`, no `allow` attribute | your DOM, `localStorage`, cookies, IndexedDB (the key vault); navigating your tab, popups, forms; camera, microphone, location, clipboard |
| a policy built from the resource's declared origins only (`connectDomains`, `resourceDomains`), re-checked; nothing declared = no network | `fetch` / images / scripts to an origin the server did not declare; a declared entry that is not an origin (`*`, `'unsafe-eval'`, `; script-src *`) |
| the policy first in the app's document AND inherited from a shell of ours; the shell's `frame-src 'none'` | the app pre-empting the policy; navigating itself to the network |
| a relay in the shell by window; your page listens to the frame it drew only (`event.source`) | an app (or anything else) posting to your page directly |
| an allow-list of methods, parameters checked, at most 3 requests in flight, nothing but `ping` before `ui/initialize`; `ui/download-file` / `sampling/createMessage` only when on | resource reads, model-context updates; downloads and sampling the host did not offer; floods |
| full screen only for an app that declared it, right after a click or a key inside its frame, never while it waits for the user; the host's chrome (who asked, Exit, Esc) on top, the focus kept inside | an app taking over the chat unasked, or hiding a prompt |
| a file: one per request, its name sanitized, programs / scripts / HTML / SVG / XML refused by name and type, 20 MB, a linked file read through its own server only, saved by your page as `application/octet-stream` on the click | path tricks, a page or a program saved in the user's name, a fetch to an address the app chose |
| sampling: the core's rules (text, no tools, caps, a rate per app), the user shown exactly what the model gets, the answer to the app only | an app spending the user's model unasked, or reading the conversation through it |
| tool calls through the agent's consent gate (writes always ask, "always allow" is the app's alone), only tools of its own server that let apps call them; links only on the user's click; messages only as a draft | an app acting with the user's authority, silently |
| the label, the controls, the menu and every prompt drawn by the host outside the frame; the height clamped to 120 - 800 px | an app imitating or covering a control of the chat |

That is the default: an opaque origin (no storage or cookies of its own; its requests carry
`Origin: null`) - stricter than the specification, which asks a web host for a sandbox proxy on a
second origin with `allow-same-origin`. With `appSandbox` (above) you give it that second origin,
and the guards that change are these:

| Guard (`appSandbox`) | What it stops |
| --- | --- |
| a sandbox URL on your page's origin, or plain `http://` off loopback, is refused (opaque) | `allow-same-origin` handing the app your storage and the key vault |
| the sandbox page's response carries the app's policy (from its URL's path) and `frame-ancestors` = your hosts; the app's frame inherits it | the app's network beyond what it declared, through its own frame or through the sandbox page (same origin, so it can reach it); other sites framing the page |
| a shell of ours (your origin, no script) whose `frame-src` is the sandbox page's exact URL | the app navigating the sandbox page away (it can: same origin) - a request to an undeclared origin |
| messages only from the sandbox page's window AND origin, posted to that origin only; one handshake, a second one stops the app | anything else posting to your page; the app reloading its frame |

Its cost: the app is same-origin with every other app on the same sandbox origin (one origin for
all servers shares storage between them) - `{server}` in the URL gives each server its own.
WebRTC is not governed by `connect-src` in Chromium. Every guard has a test in
`tests/apps.test.ts` / `tests/apps-sandbox.test.ts` and, in a real browser against a hostile app,
in `e2e/apps.spec.ts` / `e2e/apps-sandbox.spec.ts`. Details:
[docs/chat.md](docs/chat.md#an-app-is-a-security-boundary).

### Build your own UI

The components are a thin layer over the exported, **pure** reducer. Use it
directly if you'd rather render everything yourself:

```ts
import { agentStateReducer, createInitialAgentState } from '@dudko.dev/agent-web-react'

let state = createInitialAgentState()
state = agentStateReducer(state, { type: 'event', event }) // fold each AgentEvent
```

The state is made of plain, exported view types you can render with your own components:
`StepView` (a step and its `ToolCallView`s; `StepEscalationView` for its escalations), `ApprovalView`, `ElicitationView` (a question an MCP server put to the user in the middle of a tool call - `state.elicitations`, see below), `SubagentView`, `UserNoteView` /
`QueuedMessageView` (steering), `LessonView` / `FetchView` (the notebook and the pages fetched),
`BudgetView`, `CompactionView`, `AttachmentView`, `ChatMessage` (a transcript entry that keeps its
own steps, usage and duration). Outside `<AgentChat>`, `useAgentContext()` returns the controller of
the enclosing `<AgentProvider>` (it throws outside one; `useOptionalAgentContext()` returns
`undefined` instead), and `useLabels()` the labels in effect.

**MCP elicitation in the state.** The core's `mcp.elicitation-requested` /
`mcp.elicitation-answered` events fold into `state.elicitations` (absent until the first one): an
`ElicitationView` per question with `id`, `server`, `tool`, `mode`, `message`, `requestedSchema` or
`url`, `stepId`, `subagent?`, and a `status` of `pending | accepted | declined | cancelled`
(`automatic` / `reason` when nobody decided, `fields` - the names an accepted form was answered
with). The view never holds an answer, and it is a per-run view: it is not copied into the
transcript, so a saved conversation never contains a server's form. `message`, the schema's titles
and `url` are the SERVER's text - render them as text, as the server's. The questions to ANSWER come
from the hooks (`pendingElicitations`, [above](#mcp-elicitation--a-server-asks-the-user)); the
state is what `<ElicitationPrompt outcomes>` reads to say which ones were answered automatically.
The prompt's pure half is exported for a UI of your own: `elicitationFields` (a form's fields and
the control each is drawn as), `elicitationInitialDraft` (the defaults), `elicitationFormAnswer`
(the answer, or an issue per field), `elicitationLink` (host, address, whether it may be opened)
and `formatCountdown`.

## How it fits together

```
@dudko.dev/agent-web (peer)     →  the headless agent + providers + vault
@dudko.dev/agent-web-react      →  useAgent / <AgentProvider> / components
your app                        →  tools, credentials, and where the panel goes
```

The React package re-exports the core primitives you usually need
(`createAgent`, `defineTool`, `VaultCredentialStore`, `createWebLLMModel`,
`isWebGPUAvailable`, and the key types), so a React app can import everything
from one place.

> **Direct browser calls & CORS:** not every provider allows direct BYOK calls
> from a browser origin. Google (Gemini), openai-compatible and the gateway are
> the reliable direct paths; Anthropic works (a required header is injected);
> OpenAI/xAI/DeepSeek usually need a proxy. See the core's
> [providers doc](https://github.com/dudko-dev/agents/blob/main/packages/agent-web/docs/providers.md).
> Ship only the **user's own** key to the browser — shared/app keys belong
> behind a proxy or the gateway.

## Browser tests

`pnpm nx test:e2e @dudko.dev/agent-web-react` (from the monorepo root) builds the demo and drives it in Chromium:

- MCP: connecting to one and to several servers, the full OAuth redirect
  round-trip (authorize → come back with a code → connected), reconnecting
  with the stored tokens after a reload, and an unreachable server;
- the agent, against a scripted Gemini endpoint ([`e2e/gemini.ts`](e2e/gemini.ts),
  the real `@ai-sdk/google` provider underneath): tool calls and tokens by
  kind in the transcript, a chat saved and restored after a reload, an image
  attached (shown, sent as a file part, saved in the workspace), a file
  dropped anywhere on the page, consent in "Ask" mode, slash commands, the
  chess move that triggers the agent, and Spanish and German labels; the agent's
  notebook (a lesson written, kept in the workspace across a reload, seen by the
  planner, forgotten on request) and web access (off by default; an allowed page
  is read, a metadata address is refused). The MCP and authorization servers it
talks to are started on loopback by [`e2e/servers.ts`](e2e/servers.ts), CORS
headers included — so the test also pins the deployment requirement that the
challenge header be exposed;
- the pipeline editor at `/pipeline/` ([`e2e/pipeline.spec.ts`](e2e/pipeline.spec.ts)): a node
  added, dragged and connected with the mouse and with the keyboard alone, a three-node
  pipeline run for real against the scripted endpoint (nodes light up in order, the route is
  taken, the loop runs once, the result is shown), stop and a failing node, import / export /
  copy as code, the definition surviving a reload, the vault shared with the demo, and a phone:
  no sideways scroll, the inspector as a bottom sheet, one finger panning and two zooming the
  canvas while the page stays put.

- files written in a turn ([`e2e/files.spec.ts`](e2e/files.spec.ts)): the chips under the answer
  (one per file, none for a deleted one), the Markdown / CSV / HTML previews, the download, the
  chips after a reload, a phone; and the sandboxed frame against hostile pages - with scripts on,
  on a test-only page - which cannot read the host's DOM, storage or IndexedDB, reach a counted
  local endpoint by any request or navigation, open a window, or pre-empt the policy.

These cover what unit tests structurally cannot: effect ordering across a real
render, a real navigation away and back, and IndexedDB.

## Demo & deployment

The demo app (Vite + React) lives in
[`apps/demo`](https://github.com/dudko-dev/agents/tree/main/apps/demo) of the monorepo. To run it
locally, from the repo root:

```bash
pnpm install
pnpm nx build @dudko.dev/agent-web-react   # build the library (and the core) into dist/
pnpm --filter demo dev
```

The demo aliases `@dudko.dev/agent-web-react` to this package's built `dist`, so rebuild the
library after changing its source.

The same Vite project has a second page, the pipeline editor (`apps/demo/pipeline/index.html`),
served at `/pipeline/`: <http://localhost:5173/pipeline/> in dev.

## License

MIT © Siarhei Dudko
