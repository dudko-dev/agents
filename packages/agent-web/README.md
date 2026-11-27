# @dudko.dev/agent-web

[![npm](https://img.shields.io/npm/v/@dudko.dev/agent-web.svg)](https://www.npmjs.com/package/@dudko.dev/agent-web)
[![downloads](https://img.shields.io/npm/dy/@dudko.dev/agent-web.svg)](https://www.npmjs.com/package/@dudko.dev/agent-web)
[![license](https://img.shields.io/npm/l/@dudko.dev/agent-web.svg)](https://github.com/dudko-dev/agents/blob/main/LICENSE)
[![last commit](https://img.shields.io/github/last-commit/dudko-dev/agents.svg?path=packages%2Fagent-web)](https://github.com/dudko-dev/agents/commits/main/packages/agent-web)
[![release](https://img.shields.io/github/v/release/dudko-dev/agents.svg?filter=agent-web-v*&label=release)](https://github.com/dudko-dev/agents/releases)

**[agent.dudko.dev](https://agent.dudko.dev)** · [live demo](https://agent.dudko.dev/demo/) · [source](https://github.com/dudko-dev/agents/tree/main/packages/agent-web)

Headless, **universal**, configurable **in-browser** LLM agent built on the
[Vercel AI SDK](https://ai-sdk.dev). One package drives **any** model from the
browser:

- ☁️ **Cloud providers, bring-your-own-key** — OpenAI, Anthropic, Google, xAI,
  DeepSeek, any OpenAI-compatible server, and the Vercel AI Gateway.
- 🖥️ **Local WebGPU models** — via [WebLLM](https://github.com/mlc-ai/web-llm)
  (`@browser-ai/web-llm`); no server, no key, data never leaves the device.
- 🔌 **Any AI SDK `LanguageModel`** — e.g. Chrome/Edge built-in AI.

It gives you **simple text generation, streaming, native tool-calling, and
structured output**, plus a high-level **plan → execute → replan → synthesize**
agent — with host-defined **tools**, optional **MCP**, **system prompts**,
**IndexedDB** storage, and an **encrypted token vault**. UI-agnostic: it streams
typed events; you render them however you like.

The agent loop also has **thinking** (portable reasoning levels or exact
budgets), **token limits** (input / output / thinking / total per run),
**context compaction** (automatic and `agent.compact()`), **prompt caching**,
**skills** (SKILL.md bundles), **tool consent modes with an autopilot switch**,
**tool search** for catalogues of hundreds of MCP tools, **subagents** in
Web Workers, **image / PDF / file / URL input** (with a clear error for models
that can't take them),
a **virtual file system** in IndexedDB with `fs_*` tools, **usage** counted live
across a session (`agent.usage`), **steering** a run while it goes (`RunControl`),
**resuming** an interrupted run, **egress** you switch on and bound (the model's
`web_fetch`), and **learning** — the agent writes its own lessons down as skills
— see [docs/capabilities.md](docs/capabilities.md).

> Browser sibling of the Node package
> [`@dudko.dev/agent`](https://www.npmjs.com/package/@dudko.dev/agent).

> **Using React?** [`@dudko.dev/agent-web-react`](https://www.npmjs.com/package/@dudko.dev/agent-web-react)
> wraps this core in a `useAgent` hook, an `<AgentProvider>` context and drop-in
> UI components — try the **[live demo](https://agent.dudko.dev/demo/)**
> ([source](https://github.com/dudko-dev/agents/tree/main/packages/agent-web-react)).

## Install

```bash
npm install @dudko.dev/agent-web ai zod
```

Then add **only the providers you use** (all optional peers, dynamically
imported):

```bash
# cloud, pick what you need
npm install @ai-sdk/openai        # or @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/xai, @ai-sdk/deepseek, @ai-sdk/openai-compatible
# local WebGPU models
npm install @browser-ai/web-llm @mlc-ai/web-llm
# optional: HTTP MCP (the official 2.x client SDK; see "Upgrading to the 2.x MCP SDK")
npm install @modelcontextprotocol/client
```

### CDN / standalone bundle (no build step)

`dist/agent-web.js` is a **self-contained ESM bundle** of the core — `ai`,
`zod` and `idb` are baked in. It ships in the npm package (so it's on every
CDN) and is attached to each
[GitHub release](https://github.com/dudko-dev/agents/releases) as
`agent-web-<version>.min.js`:

```html
<script type="module">
  import { createAgent, defineTool } from 'https://cdn.jsdelivr.net/npm/@dudko.dev/agent-web/dist/agent-web.js'
  // or: https://unpkg.com/@dudko.dev/agent-web/dist/agent-web.js
</script>
```

Bundler users can also opt into it via the `@dudko.dev/agent-web/bundle`
subpath. Optional provider peers stay external even in the bundle; in a
bundler-less page, map the ones you use with an import map (the runtime
`import()` respects it) — direct `LanguageModel`s and `gateway` specs need no
import map at all:

```html
<script type="importmap">
  {
    "imports": {
      "@ai-sdk/openai": "https://cdn.jsdelivr.net/npm/@ai-sdk/openai/+esm"
    }
  }
</script>
```

## Quick start — cloud model, bring-your-own-key

Keys are stored **encrypted at rest** (WebCrypto, IndexedDB) and referenced by
id — never inlined into config. See [security](docs/security.md).

```ts
import {
  createAgent,
  defineTool,
  VaultCredentialStore,
} from '@dudko.dev/agent-web'
import { z } from 'zod'

// 1. Store the user's key once (e.g. from a settings form). Encrypted at rest.
const credentials = new VaultCredentialStore()
await credentials.setApiKey('openai', userProvidedKey)

// 2. Tools = your app's actions.
const tools = {
  add_text: defineTool({
    description: 'Add a text block to the page.',
    inputSchema: z.object({ text: z.string(), x: z.number().optional() }),
    execute: async ({ text, x }) => addTextBlock(text, x), // your code
  }),
}

// 3. Create the agent. The key is fetched from the vault at build time.
const agent = await createAgent({
  model: { providerType: 'openai', model: 'gpt-4o-mini', credentialRef: 'openai' },
  credentials,
  tools,
  describeState: () => serializeMyCanvas(), // optional grounding
})

// 4. Run. Every step is a typed event.
const result = await agent.run('Add a centered title and a totals line', {
  onEvent: (e) => {
    if (e.type === 'plan.created') console.log('plan:', e.plan.steps)
    if (e.type === 'step.tool-call') console.log('tool:', e.name, e.input)
    if (e.type === 'final') console.log('done:', e.text)
  },
})
console.log(result.final, `— ${result.applied} changes`)
```

> **Direct browser calls & CORS:** as of October 2026 Google, OpenAI, xAI and
> DeepSeek send CORS headers, so a user's own key works straight from the page;
> Anthropic works too (a required header is injected for you). Kimi, Groq,
> Mistral and OpenRouter do as well (build their AI SDK models yourself and pass
> them as `model`). See [docs/providers.md](docs/providers.md).

## Quick start — local WebGPU model (no key, offline)

```ts
import { createAgent, createWebLLMModel, isWebGPUAvailable } from '@dudko.dev/agent-web'

if (!isWebGPUAvailable()) throw new Error('WebGPU required for local models')

const model = await createWebLLMModel('Llama-3.2-3B-Instruct-q4f16_1-MLC', {
  initProgressCallback: (r) => console.log('loading', Math.round(r.progress * 100), '%'),
  contextWindowTokens: 8192, // WebLLM loads with 4096 unless told otherwise
})

// Local models default to the robust "prompted" tool-mode automatically, and
// the agent sizes compaction and tool lists from the model's own window.
const agent = await createAgent({ model, tools /* ...same as above */ })
await agent.run('Summarize the current page and add a heading')
```

A local **vision** model (`Phi-3.5-vision-instruct-q4f16_1-MLC`) takes images
like a cloud one. See [docs/capabilities.md](docs/capabilities.md#the-models-window-is-a-hard-limit)
for the window: WebLLM's default is 4096 tokens, raised per model at load.

You can also pass a model by spec: `{ providerType: 'web-llm', model: '…' }`.

## Simple generation & tool-calling (no agent loop)

```ts
import { generate, stream, generateStructured, runToolLoop } from '@dudko.dev/agent-web'
import { z } from 'zod'

const { text } = await generate(model, { prompt: 'Write a haiku about WebGPU' })

const { textStream } = stream(model, { prompt: 'Explain IndexedDB' })
for await (const chunk of textStream) process.stdout.write(chunk)

const { object } = await generateStructured(
  model,
  z.object({ title: z.string(), tags: z.array(z.string()) }),
  { prompt: 'Suggest a title and tags for this article: …' },
)

// Tool-calling with feedback (native or prompted), normalized result. In both
// modes the model sees its tool results and can keep going, up to `maxSteps`
// rounds (default 4; prompted models get the results as a TOOL RESULTS turn):
const { text: reply, toolCalls } = await runToolLoop(model, {
  mode: 'native',
  prompt: 'Add a title',
  tools,
})
```

## Optional: MCP tools over HTTP

```ts
import { connectMcpHttp } from '@dudko.dev/agent-web/mcp'

const mcp = await connectMcpHttp({
  docs: { url: 'https://my-mcp-server.example/mcp', headers: { Authorization: `Bearer ${t}` } },
})
const agent = await createAgent({ model, tools: { ...tools, ...mcp.tools } })
// ... later: await mcp.close()
```

Browsers can only speak the **HTTP (StreamableHTTP)** transport — stdio MCP is
Node-only. The connector lives in the `./mcp` subpath so the MCP SDK never
enters your core bundle.

The MCP client is the official 2.x SDK, **`@modelcontextprotocol/client`** (an
optional peer: install it when you import `./mcp`; `@modelcontextprotocol/sdk`
1.x is no longer used — [what to change](#upgrading-to-the-2x-mcp-sdk)). By
default it negotiates the 2025 protocol revisions with the unchanged
`initialize` handshake, so servers see the same requests and the same headers
as before; a server that speaks **only** the 2026-07-28 revision then fails to
connect, at once, with `Unsupported protocol version: 2025-11-25` in
`results[].error`.

**The 2026-07-28 revision is a per-server opt-in**, `protocol`:

```ts
const mcp = await connectMcpHttp({
  docs: { url: 'https://docs.example.com/mcp' },                  // 'legacy', the default
  crm: { url: 'https://crm.example.com/mcp', protocol: 'auto' },
  files: { url: 'https://files.example.com/mcp', protocol: 'modern' },
})
mcp.protocols // [{ server: 'docs', version: '2025-11-25', era: 'legacy' }, { server: 'crm', version: '2026-07-28', era: 'modern' }, …]
```

| `protocol` | What is spoken | Against a server of the other kind |
| --- | --- | --- |
| `'legacy'` (default, same as leaving it out) | The 2025 revisions: exactly the requests and the request headers sent before the option existed (a test compares them with a recording made before it). | Only 2026-07-28: `Unsupported protocol version: 2025-11-25`, at once. |
| `'auto'` | The server is asked first (`server/discover`). One that answers with 2026-07-28 is spoken to that way; any other gets the 2025 handshake. | Works with both. An HTTP 5xx, an answer that is not JSON-RPC or no answer fails the connect: an outage is not read as "an old server". |
| `'modern'` | 2026-07-28 only. | A 2025 server: `the server did not offer pinned protocol version 2026-07-28 …`, at once. |

The revision is decided **once, at connect**; no tool call is ever sent again in
another revision. `protocols` says what each connected server negotiated, and
for a server with `protocol` set an `info` line goes to `onLog`
(`[mcp] crm: protocol 2026-07-28 (modern: …; configured 'auto')`).

On 2026-07-28: there is no session (`mcp-session-id`), no GET stream and no
`initialize`; `instructions`, `isError`, `structuredContent` and the
`outputSchema` note work as before; OAuth is unchanged. Three things differ:

- **CORS.** Every request carries `Mcp-Method` and `Mcp-Name`, and
  `MCP-Protocol-Version` from the first one on: the server must allow them
  ([below](#cors-what-the-server-must-send)). A server that does not cannot be
  reached that way from a page. `'modern'` then fails, and the error names the
  missing headers. `'auto'` cannot tell a blocked probe from an old server (the
  browser says nothing), so it falls back to the 2025 revisions and logs a
  `warn` line that names the headers - or, when the server speaks only
  2026-07-28, fails with that same explanation.
- **Tool list changes** arrive over a `subscriptions/listen` stream, which the
  connector opens at connect when you pass `onToolsChanged` and the server
  advertises `tools.listChanged`. When that stream ends while the connection is
  open - dropped, or closed by the server with its result - it is **opened
  again**, with backoff (at most 1 s, 2 s, 4 s, ... up to 60 s, less a random
  share of up to half; the count starts over after a stream that stayed up a
  minute), and once it is back `onToolsChanged(name)` fires once, exactly as
  for a notice: a change made in the gap was announced to nobody. After 10
  attempts in a row it gives up; a 401 / 403 / 404 / 405 (or `-32601`) stops
  it at once. One `warn` per loss with the attempt and the delay, one `info`
  when it is back, one `warn` on giving up. `close()` takes down a pending
  retry and an attempt in flight. `refreshServer(name)` always works. No
  setting: see [docs/design.md](docs/design.md#mcp-the-listen-stream-is-opened-again).
- **`input_required` needs `onElicitation`.** Without it, a tool that asks the
  user something (elicitation), or asks for the call to be sent again with a
  state, fails with `MCP tool "x" did not finish: the server asked for more
  input …`; the call is not repeated. With it, see [Elicitation](#elicitation-a-server-asks-the-user).

Pass several servers at once — they connect concurrently, each with its own
deadline (`connectTimeoutMs`, default 30 s), every page of a paginated
`tools/list` is read, and tools a server marks `readOnlyHint` are treated as
read-only by the consent gate. A failing server is reported in `results`; the
others still mount. With hundreds of tools the agent switches to tool search
automatically (see [docs/capabilities.md](docs/capabilities.md#large-tool-catalogues-several-mcp-servers)).

A server's `instructions` (from its `initialize` result) reach the planner's and
the executor's system prompts, marked as third-party text and capped; a tool's
`structuredContent` reaches the model once, as JSON, and a result that breaks
its `outputSchema` is passed on with a note instead of failing the call. See
[docs/capabilities.md](docs/capabilities.md#mcp-server-instructions-and-structured-results);
the instructions are a prompt-injection surface
([docs/security.md](docs/security.md#mcp-server-instructions-third-party-text-in-a-system-prompt)) —
`mcpInstructions: false` switches them off.

A tool the server refuses with a JSON-RPC error (what a 2.x server answers for
an unknown tool, `-32602`) is a failed call like an `isError` result; its
message is the server's own, without the `MCP error <code>: ` prefix the 1.x
SDK added — read `error.code` for the number. A paginated `tools/list` is
followed for up to 100 pages (a repeated cursor ends the walk; past the cap a
`warn` line says the rest is not mounted).

`connectMcpHttp` returns `{ tools, catalog, results, instructions, protocols, refreshServer, close }`.
`tools` and `catalog` are mutated **in place** by `refreshServer(name)`, so an
agent built from them picks up a server's new tool list (react to it via the
`onToolsChanged` option) without being rebuilt. Filtering is plain object work:
delete the keys you don't want before merging.

### MCP skills (experimental): a server's instructions as skills

A server may serve **skills** (the [Skills extension](https://github.com/modelcontextprotocol/ext-skills),
`io.modelcontextprotocol/skills`, Beta, written against 2026-07-28): `SKILL.md` instruction files
and the files they bundle. Opt in per server - they come with its tools:

```ts
const mcp = await connectMcpHttp({
  docs: { url: 'https://docs.example.com/mcp', protocol: 'auto', skills: true },
  // a server you vetted: its skills load without a question
  ours: { url: 'https://mcp.internal.example/mcp', protocol: 'auto', skills: { consent: 'never' } },
})
const agent = await createAgent({
  model,
  tools: { ...mcp.tools },
  toolApproval: { onRequest: askThePerson }, // a request with `skill`: show it, then answer
})
agent.skills // [{ name: 'docs/pdf-processing', description: '… [from the MCP server "docs" - third-party]', server: 'docs' }, …]
```

| | |
| --- | --- |
| Off by default | Without `skills` (`true`, or `{ consent }`) the extension is not declared and nothing of it is sent. It is declared only where 2026-07-28 may be spoken (`protocol: 'auto'` / `'modern'`); `'legacy'` (or none) logs a `warn` and asks nothing, an `'auto'` connection that ends on 2025 lists nothing. No agent-wide switch. |
| One catalog, namespaced | The server's skills join your `skills` and the agent's lessons as `<server>/<skill>` (the server by its key in `connectMcpHttp`, never its `serverInfo`). No other skill name can hold a `/`: a server cannot shadow yours, a lesson or another server's - your `git-workflow` keeps its name and the clash is logged. Same-named skills of one server are kept by their paths. |
| On demand, verified | The prompts carry the name, the description (one line, ≤ 300 characters) and the origin. Nothing is read at connect; `SKILL.md` is read when `load_skill` or the planner asks, a file when `read_skill_file` asks - each checked against the server's entry (size, SHA-256, and for `SKILL.md` the frontmatter): a mismatch is refused, nothing of it used. A file only from the skill's own server, only if its entry lists it, as text. |
| Knowledge, never policy | Loaded under a preamble saying it is third-party text that cannot grant permissions, approve a call or change the approval mode, widen egress or the sandbox, or make the agent run anything. Nothing of its frontmatter beyond `name` / `description` is read (`allowed-tools` grants nothing). While a run acts on an MCP skill, a tool that runs code (`run_js`, or yours marked with `markCodeExecution`) is always asked - whatever the mode or a rule say; with no `onRequest` it is refused. |
| Caps | 32 skills per server, 64 in all; 16 000 characters of instructions, 32 000 of a file - every cut said. Entries over the extension's limits (512 files, 16 MiB), `"dynamic"` ones and ones whose URI and frontmatter name disagree are refused with a `warn`. |
| Changes | Announced as a resource list change: `onToolsChanged(name)` fires (also for that notice), and `refreshServer(name)` lists the skills again. An agent built afterwards has the new ones. |
| Directories | `read_skill_file` with a directory of a skill (`templates/`, `.` for the root) lists it - `{ name, directory, files, directories, more?, notServed?, note? }`, the direct children by path, at most 64 - from the entry the skill was loaded and approved with, after the same consent as a file. When the server declared `directoryRead`, `resources/directory/read` goes to THAT server too (`skill://<path>/<dir>`, no trailing slash), only to see whether the skill changed there: what it lists beyond the entry is never shown - a fixed `note` says how many, a `warn` is logged (counts only) and `onToolsChanged(name)` fires once for that loaded skill; what the entry holds and the server no longer lists is kept and named in `notServed`. A failed directory read: the listing from the entry alone, and a log line. Without `directoryRead` the method is never called. `"dynamic"` skills stay declined: a directory read would be the only way to find their files, and it verifies nothing. |
| A person sees it first | Before a server's skill enters the model's context (`load_skill`, the planner's pick, a resumed run, `read_skill_file`), its verified `SKILL.md` is put to `toolApproval.onRequest`: a request with `toolName: 'load_skill'` and `skill` (`McpSkillConsentView`: server, name, description, size, files, `byUri`, `nestedIn`, `consent`, and `body` - the very text the model would read). Yes lets it in; `remember: true` = "Always for this server" (nested skills excepted); no keeps all of it out and the model is told. Asked whatever the approval mode says - autopilot too; without `onRequest` it is not loaded. When: `skills: { consent }` per server, else `mcpSkills: { consent }` on the agent, else `'once-per-skill'` (the first time per skill in the agent's life, again if its files change); `'ask'` (every run); `'never'` (a vetted server). A nested skill is asked about on its own. |
| By URI | A skill the listing leaves out, named by URI in a server's text: `load_skill({ server, uri })` (its description says so). A `skill://…/SKILL.md` URI and a server whose skills are on - checked before any request - and room under the per-server cap; then `skills/get` to THAT server only (its `-32602` reaches the model), the same entry rules, verification, consent (`byUri`) and preamble. It stays in the catalog, under a name no other skill has. |

A server's skills come with its tools, like its instructions: a server whose tools are all
filtered out (or that has none) offers none. Details: [docs/capabilities.md](docs/capabilities.md#mcp-skills-experimental),
what a server's skill can and cannot do: [docs/security.md](docs/security.md#mcp-skills-third-party-instructions).

### Elicitation: a server asks the user

A tool may need something only the user has - a name to confirm, a choice, a
page to visit - and ask for it **in the middle of the call**. Off until you give
the connection a callback:

```ts
const pending = new Map<string, (r: McpElicitationResult) => void>()

const mcp = await connectMcpHttp(servers, {
  // The HOST decides, never the model. `request` is the SERVER's text: show it as such.
  onElicitation: (request, { signal }) =>
    new Promise((resolve) => {
      pending.set(request.id, resolve) // your UI resolves it: accept / decline / cancel
      signal.addEventListener('abort', () => pending.delete(request.id)) // no longer wanted
    }),
  elicitation: { timeoutMs: 300_000, maxPerToolCall: 5, maxPerRun: 20 }, // the defaults
})
// later, from the form the user filled in:
pending.get(id)?.({ action: 'accept', content: { name: 'Ada' } })
```

- **Off = nothing changes.** Without `onElicitation` no capability is declared, a
  server cannot ask, and every request is byte for byte what it was (no new
  request header either: a server's CORS list needs nothing for this).
- **The request** (`McpElicitationRequest`): `id`, `server`, `tool` (the call
  that asks), `mode: 'form' | 'url'`, `message`, and `requestedSchema` (a flat
  form: strings, numbers, booleans, selects) or `url`. All of it is third-party
  text, cleaned and capped; none of it reaches a prompt. A form that is not flat,
  or too large, is declined without the callback being called.
- **The answer** is checked against the form before it is sent (types, limits,
  required fields, no field the form did not ask for) and goes **only to the
  server that asked**: not into the model's context, an event, a log or a run
  checkpoint.
- **URL mode** is opt-in (`elicitation: { url: true }`). The link is only handed
  to your callback: this package never fetches it and never calls
  `window.open`. Only `https:` (or loopback `http:`) links get that far. Open it
  from a user gesture, in a new tab, showing the host name first.
- **Nobody decided = the call fails.** A callback that throws or does not answer
  within `timeoutMs`, an answer that does not fit, a cap: the question is
  cancelled, the tool call fails with one sentence that says why, and nothing is
  retried.
- **Subagents do not ask** unless the connection says so
  (`elicitation: { subagents: true }`): a helper the model started, and a
  subagent tool's child that was handed these tools, have their questions
  cancelled without the callback being called.
- **Time.** A question waits `timeoutMs` (5 minutes) at most; `0` or
  `Infinity` removes that limit (the question waits until the run is stopped),
  and so does a value above 2^31 - 1 ms (about 24.8 days, the longest delay a
  timer holds). A negative number or `NaN` fails the connect. The step it
  belongs to does not run out of time meanwhile: `chatTimeoutMs` (default
  120 s) **is stopped while a question waits** - like the `timeoutMs` of a
  subagent the question holds up - and goes on with the time it had left. The
  same holds while a person decides a tool approval (whose own bound is
  `toolApproval.timeoutMs`, also 5 minutes by default). Stopping the run ends a
  wait at once.
- **Events** inside a run: `mcp.elicitation-requested` and
  `mcp.elicitation-answered` (field names, never a value).

The whole of it, with every guard: [docs/capabilities.md](docs/capabilities.md#mcp-elicitation-a-server-asks-the-user)
and [docs/security.md](docs/security.md#mcp-elicitation-a-server-asks-the-user-in-the-middle-of-a-tool-call).

### MCP Apps: a server's own interface for a tool

With [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (the stable extension
`io.modelcontextprotocol/ui`, revision 2026-01-26) a tool declares an HTML app
(`_meta.ui.resourceUri: 'ui://…'`) that shows its result - a flight list, a chart, a form. This
package is the host's data side: it reads the declaration, tells the run when such a tool
returned, reads the app from its server, and makes the calls the app asks for. **Drawing** the
app is the UI's job: the React package's `<AgentChat mcpApps>` does it in a sandboxed frame.
Off until you ask:

```ts
const mcp = await connectMcpHttp(servers, { apps: true })
const agent = await createAgent({ model, tools: mcp.tools })

agent.run(goal, {
  onEvent: async (e) => {
    if (e.type !== 'mcp.app') return
    // e.server, e.tool / e.toolName, e.resourceUri, e.input, e.result: what the app is shown
    const app = await mcp.apps!.readUiResource(e.server, e.resourceUri) // { html, csp, permissions, … }
    // ... frame app.html with a policy built from app.csp (connectDomains / resourceDomains only)
  },
})

// The app asks to call a tool of ITS server: consent first, then the call.
const tool = mcp.apps!.appTool('travel', 'flights.book') // undefined: not one an app may call
await agent.approveAppToolCall({ tool: tool!.key, toolName: 'flights.book', server: 'travel',
  resourceUri, input: args, readOnly: tool!.readOnly }) // throws ToolDeniedError when refused
const result = await mcp.apps!.callAppTool('travel', 'flights.book', args)
```

- **Off = nothing changes.** Without `apps` no extension is declared, `_meta` is not read, every
  tool is mounted as before and the wire is byte for byte what it was. On, the only difference on
  the wire is the extension in the handshake (`capabilities.extensions`).
- **The HTML never reaches the model**: it is in no tool result, event, log or checkpoint. The
  model's tool result is what it would be without apps. `mcp.app` carries the call's arguments
  and the result for the app (`content`, `structuredContent`, `isError`, `_meta`; left out above
  `MCP_APP_MAX_RESULT_CHARS`, 512 000).
- **An app is read only from the server that declared it**, and only a `ui://` URI that a tool of
  THAT server declares in its current listing - nothing is asked of a server otherwise; checked
  (the exact URI, the MIME type `text/html;profile=mcp-app`, at most 2 000 000 characters, `text`
  or base64 `blob`) and cached per connection; a refused read is not kept. Its declared CSP is
  cleaned to origins (`https://host`, `wss://…`, `https://*.example.com`, loopback `http`): a
  keyword, a scheme, a path, `*` or a `;` never gets through. The permissions it asks for
  (camera, microphone, …) are reported, never granted here. Each read logs the policy (`onLog`).
- **Who may call what** (`_meta.ui.visibility`): a tool for its app only (`['app']`) is not
  mounted for the model; `appTool` / `callAppTool` refuse a tool whose visibility leaves out
  `'app'`, or that the server does not list - before anything is sent.
- **Consent for an app's calls** - `agent.approveAppToolCall` - is the agent's own gate
  (`toolApproval`: its rules, handler and timeout) with two differences: under `'autopilot'` a
  write still asks (read-only tools run, as in `'ask-writes'`), and "always allow" given to an app
  is remembered for apps only. The request carries `app: { server, tool, resourceUri }`.
  `callAppTool` itself does not ask: call it after the consent.

- **One server's apps off**: `McpHttpServerConfig.apps: false` (over the connection's `apps`) -
  that server is not told of apps, none of its apps is read, no `mcp.app` is told for it, and a
  tool it marks for its app only is mounted for nobody; its other tools are plain tools. `apps:
true` turns them on for that server alone (`mcpAppsModeOf`: `'on' | 'declined' | 'off'`).
- **A file an app links to** (`ui/download-file` with a `resource_link`):
  `mcp.apps.readResource(server, uri, { maxBytes })` - `resources/read` on that server only, never a
  fetch of the URI; its bytes, at most `MCP_APP_MAX_DOWNLOAD_BYTES` (20 MB), not cached. It neither
  asks the user nor judges the type: the UI does both before it saves anything.
- **A completion an app asks for** (`sampling/createMessage`) - `agent.sampleForApp({ server,
resourceUri, params }, { approve, signal?, onEvent?, sessionId? })`: checked (text; images only
  for a model known to read them; no tools; 16 000 characters; `maxTokens` lowered to 1024), rate
  limited per app (5 a minute, 30 in all), put to `approve` with exactly what the model will get,
  then answered by the synthesizer's model with nothing of the agent's context. Its tokens count in
  `agent.usage` (a `usage` event of phase `'app'`); the answer goes to the caller only - never into
  memory, an event or a run. Caps: `config.appSampling` (`false` refuses every request).

```ts
const answer = await agent.sampleForApp(
  { server: 'demo', resourceUri: 'ui://demo/trip-board.html', params: request.params },
  { approve: (view) => askTheUser(view) }, // view: { messages, systemPrompt?, maxTokens, … }
) // { role: 'assistant', content: { type: 'text', text }, model, stopReason } - or AppSamplingError
```

Everything else an app may ask for - opening a link, putting a message in the chat, full screen,
saving a file - is the UI's to ask the user about. The whole of it: [docs/capabilities.md](docs/capabilities.md#mcp-apps-a-servers-interface-for-a-tool)
and [docs/security.md](docs/security.md#mcp-apps-a-servers-html-with-scripts).

### OAuth 2.1 + Dynamic Client Registration

A server behind OAuth needs more than a header: access tokens expire mid-run.
Pass an `authProvider` and the MCP SDK discovers the authorization server
(RFC 9728), registers this app — dynamically (RFC 7591) or by its client ID
metadata document (CIMD), automatically or one of them only (`registration`):
no client_id to pre-provision — runs PKCE, and **refreshes the access token on
any 401 and retries the request**.

```ts
import { BrowserOAuthProvider, connectMcpHttp, finishMcpOAuth, readOAuthCallback }
  from '@dudko.dev/agent-web/mcp'

const provider = new BrowserOAuthProvider({
  serverUrl: 'https://my-mcp-server.example/mcp',
  redirectUrl: `${location.origin}/callback`, // must match on the way back
})

// 1. On the callback page: finish the flow before anything else.
const callback = readOAuthCallback()
if (callback) await finishMcpOAuth(provider, callback)

// 2. Connect. `needsAuthorization` means "send the user to authorize".
const mcp = await connectMcpHttp({ docs: { url: provider.serverUrl, authProvider: provider } })
if (mcp.results[0]?.needsAuthorization) {
  location.href = String(provider.authorizationUrl) // a button, a popup — your call
}
```

Tokens, the registration, the PKCE verifier and what discovery found are stored in the same
**encrypted IndexedDB vault** as provider API keys (`VaultOAuthStorage`; swap in
`MemoryOAuthStorage` or your own via `storage`). `redirectToAuthorization` never
navigates on its own — the SDK can demand authorization from inside a running
tool call, and evicting the user then would discard the run. The URL is recorded
on `provider.authorizationUrl` and the app decides when to use it.

- **`iss` (RFC 9207).** `readOAuthCallback` reads the `iss` parameter of the
  redirect and `finishMcpOAuth` checks it against the authorization server the
  flow was started with, after `state` and before the code is exchanged. A
  different issuer is refused (a mix-up attack), and so is a missing `iss` when
  the server's metadata says `authorization_response_iss_parameter_supported:
  true`. The comparison is exact. If you parse the callback yourself, pass `iss`
  along; `checkAuthorizationResponseIssuer` is the rule on its own.
- **`clientMetadataUrl` (CIMD).** Host a client ID metadata document and pass
  its URL: an authorization server that advertises
  `client_id_metadata_document_supported` takes the URL as the `client_id` and
  no registration request is made. Other servers get dynamic registration as
  before, and a registration already in storage wins over both. The URL must be
  https with a path (anything else throws in the constructor), and the document
  must list the same `redirect_uris` as `redirectUrl`.
- **`registration`: how the client is registered** — `'auto'` (the default),
  `'cimd'` or `'dcr'`; the Node package has the same option.

  | value | the client | an authorization server without CIMD support |
  |---|---|---|
  | `'auto'` | the document where the server advertises `client_id_metadata_document_supported` (and `clientMetadataUrl` is set), a dynamic registration elsewhere; a stored client is used as it is | dynamic registration |
  | `'cimd'` | the document only; needs `clientMetadataUrl` (the constructor throws without one) | **refused before anything is sent to its registration endpoint**: the connect fails with `… does not support client ID metadata documents (CIMD), which this connection requires (registration: 'cimd') - nothing was sent to its registration endpoint`, and what discovery found is dropped, so the next attempt reads the server's metadata again |
  | `'dcr'` | a dynamic registration only, even with a `clientMetadataUrl` (the provider's `clientMetadataUrl` is then `undefined`: the SDK never sees the URL) | dynamic registration |

  `await provider.registrationKind()` says how the stored client was made —
  `'cimd'`, `'dcr'` (also a client you saved yourself), or `undefined` when
  there is none this provider would use; `provider.registration` is the
  setting. Under `'cimd'` / `'dcr'` **a stored client of the other kind is not
  reused**: it is forgotten together with the tokens issued to it (a token
  belongs to its client) before either is read, and the user signs in again.
  The kind is stamped on the stored record when it is saved, so a later change
  of `clientMetadataUrl` does not make an old document client look like a
  dynamic one; a record saved before the stamp existed is CIMD when its
  `client_id` is the document configured now.
- **Registration** describes a public PKCE client. `application_type` follows
  the redirect URL: `'web'` for an https page, `'native'` for a loopback one
  (local development). Change any field through `clientMetadata`.
- `provider.reset()` forgets tokens, registration and discovery - use it when a
  server moved to another authorization server.
- **Discovery is stored** next to the tokens (the authorization server and its
  metadata), so later calls skip it and the issuer check has something to
  compare with. A code is exchanged only when that record is still there: a
  flow whose discovery state is gone (started by a version that did not keep
  it, or storage was cleared in between) is refused by `finishMcpOAuth` with
  `Authorization cannot be completed: ... start the authorization again`.
  Tokens already in storage are not touched; send the user to authorize again
  and the new redirect completes.
- **Credentials belong to the authorization server that issued them.** The
  registration and the tokens are stored with an `issuer` stamp and are never
  presented to another authorization server: stamped for a different one, they
  are read as absent and a new authorization is asked for. Storage written
  before the stamp existed keeps working — its values are used as they are and
  stamped on first use (the SDK says so once on the console). A custom
  `McpOAuthStorage` only has to return what it was given.
- **A token endpoint must be https** (or loopback). The SDK refuses to send a
  code or a refresh token to a plain-http token endpoint; the error names it,
  and no new authorization is started in its place.
- **The metadata must be the server's own.** Authorization server metadata
  whose `issuer` is not the URL it was fetched for is refused by the SDK
  (RFC 8414 section 3.3): the connect fails with the two issuers named, and
  nothing is registered. The 1.x SDK accepted such a document.
- **`403 insufficient_scope`.** When the server answers a request with `403` and
  `WWW-Authenticate: Bearer error="insufficient_scope"`, the tool call fails
  with `Insufficient scope: required "<scope>"` (the SDK's
  `InsufficientScopeError`, with `requiredScope`; it is **not** an
  `UnauthorizedError`). No authorization is started from inside a run: a new
  authorization URL in the middle of a tool call would replace the state and
  PKCE verifier of the one the user may have open. Ask for the scope up front
  (`scope`), or authorize again with it. A provider **without** a human step
  (no `redirectUrl`: the enterprise one below) asks once for the wider scope
  and retries the request once.
- **A refresh whose result cannot be saved is an error**, not a new
  authorization: when storage throws while saving refreshed tokens (a full
  quota, a broken vault), the connect or the tool call fails with that error.

### Enterprise-managed authorization (ID-JAG)

When the company's identity provider decides who may use which MCP server (the
MCP extension `io.modelcontextprotocol/enterprise-managed-authorization`, also
called Cross App Access), there is no consent page and no redirect. Your app
already holds the user's OpenID Connect ID token from single sign-on; the
provider turns it into an access token in two POSTs: a token exchange at the IdP
(ID token in, an **ID-JAG** out), then a `jwt-bearer` grant at the MCP server's
authorization server (ID-JAG in, access token out).

```ts
import { connectMcpHttp, createEnterpriseOAuthProvider } from '@dudko.dev/agent-web/mcp'

const provider = createEnterpriseOAuthProvider({
  serverUrl: 'https://mcp.example.com/mcp',
  clientId: 'agent-web',                        // at the MCP authorization server, a public client
  expectedIssuer: 'https://auth.example.com',   // required with a clientSecret, wise without
  idp: { tokenEndpoint: 'https://acme.idp.example/oauth2/token', clientId: 'agent-web-at-idp' },
  getIdToken: () => session.idToken,            // yours: called for every new ID-JAG
})

const mcp = await connectMcpHttp({ docs: { url: 'https://mcp.example.com/mcp', authProvider: provider } })
```

- It runs before the first request when there is no usable token, and again
  when the token expires or the server answers 401 - a fresh ID token and a
  fresh exchange each time. No refresh token is used.
- Only the access token (and what discovery found) is stored, in the vault by
  default (`storage`). The ID token and the ID-JAG are never stored, logged or
  put in an error.
- Errors are `EnterpriseOAuthError` with `hop`: `'idp'`, `'authorization-server'`
  or `'discovery'`. A refusal by the authorization server reads `MCP
  authorization server refused the ID-JAG grant: invalid_grant (HTTP 400)` - the
  code and the status, never the server's own text - at connect
  (`results[].error`, `needsAuthorization` unset) and in the middle of a session
  (the tool call fails with it). What the server said goes to `onLog` at `warn`
  (to the package logger when there is none), with every token, assertion,
  secret and key cut out first.
- **`expectedIssuer` is required with `clientSecret` and with `private_key_jwt`**
  (the constructor throws otherwise): without it the MCP server's metadata would
  choose who receives the secret, or which audience a signed assertion is made
  for. A client with no credential at the authorization server may omit it: the
  only thing sent there is then the ID-JAG, which the IdP addressed to that one
  server.
- **`private_key_jwt`** (`clientAuthMethod` / `idp.clientAuthMethod`) signs a
  client assertion with WebCrypto instead of sending a secret: `privateKey` (a
  `CryptoKey` - make it non-extractable - or a JWK), `algorithm` (`ES256`,
  `RS256`, ...), optional `keyId`, and `idp.issuer` for the IdP. The assertion's
  only audience is the issuer of the server it is for, it lives 60 seconds and
  carries a new `jti` each time.
- **`assertionAudience` / `assertionType`** (and the same two inside `idp`), for
  a server built to RFC 7523 rather than to `draft-ietf-oauth-rfc7523bis`:

  | Option | Values | Default |
  | --- | --- | --- |
  | `assertionAudience`, `idp.assertionAudience` | `'issuer'` or `'token-endpoint'`: what the assertion's `aud` is | `'issuer'` |
  | `assertionType`, `idp.assertionType` | `'client-authentication+jwt'` or `'JWT'`: its `typ` header | `'client-authentication+jwt'` |

  `'token-endpoint'` addresses the assertion to `idp.tokenEndpoint` (then
  `idp.issuer` is not required) or, for the authorization server, to the token
  endpoint of the discovered metadata once it matched `expectedIssuer`. It is
  the weaker form - see
  [docs/security.md](docs/security.md#mcp-enterprise-managed-authorization-id-jag) - so
  use it only for a server that refuses the default.
- **`clientId` may be the https URL of a client ID metadata document** (CIMD),
  with `private_key_jwt` or no credential, never with a `clientSecret`.
- **In a browser:** the IdP's token endpoint must allow your origin (CORS), and
  a `clientSecret` (yours or `idp.clientSecret`) in a page is readable by anyone
  who can open the page. So this provider is for public clients, or for a
  `fetch` that routes the IdP call through your backend, which holds the
  secret. See
  [docs/security.md](docs/security.md#mcp-enterprise-managed-authorization-id-jag).
- Verified against a test identity provider, not a commercial one. Options,
  checks and limits: [docs/capabilities.md](docs/capabilities.md#mcp-servers-behind-oauth).

### CORS: what the server must send

A browser tells JavaScript nothing about why it blocked a request — a CORS
rejection and a server that is down both arrive as `TypeError: Failed to fetch`,
with the real reason printed only to the devtools console. So these are worth
checking first rather than last:

```
Access-Control-Allow-Origin:   <your origin>
Access-Control-Allow-Methods:  GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers:  Content-Type, Authorization, mcp-session-id,
                               MCP-Protocol-Version, Last-Event-ID
Access-Control-Expose-Headers: mcp-session-id, WWW-Authenticate
```

Nothing changed here with the 2.x MCP SDK: recorded on the wire against a raw
HTTP server, the old and the new client send the same requests with the same
headers (`Accept`, `Content-Type`, then `mcp-session-id` and
`MCP-Protocol-Version` after `initialize`, `Authorization` and `Last-Event-ID`
when they apply), and the browser tests run against a server with exactly this
list.

**For the 2026-07-28 revision** (a server connected with `protocol: 'auto'` or
`'modern'`) two more request headers are needed, and `MCP-Protocol-Version` is
on the very first request:

```
Access-Control-Allow-Headers:  Content-Type, Authorization, MCP-Protocol-Version,
                               Mcp-Method, Mcp-Name
```

(`mcp-session-id` and `Last-Event-ID` are not sent in that revision, and no new
response header needs exposing; keep them all in one list if the server also
serves 2025 clients.) This package does **not** send `Mcp-Param-*` headers -
the mirror of tool arguments a tool may ask for with `x-mcp-header` - so the
list above is the whole requirement for it; another client may send them, and
their names come from the tools, so a server that uses the feature has to
allow them by pattern. Without `protocol`, none of these headers is sent and
the 2025 list is still enough.

Each line earns its place:

- **`MCP-Protocol-Version` in Allow-Headers** is the one that bites hardest. The
  spec has required that header on every request *after* `initialize` since
  2025-06-18, and CORS lists written before that date omit it. The first request
  does not carry it, so discovery, the whole OAuth dance and `initialize` all
  succeed — and then everything afterwards is blocked. It reads exactly like the
  consent step failing, and sends you to debug the client.
- **`WWW-Authenticate` in Expose-Headers**, or the browser hides the 401
  challenge from JS and OAuth discovery never starts.
- **`Last-Event-ID`** for resuming a dropped SSE stream.
- The authorization server's `/register`, metadata and token endpoints need CORS
  too, `OPTIONS` included — a browser client calls them directly.
- If the server uses the MCP SDK's DNS-rebinding protection, its `allowedOrigins`
  must contain your origin. Left empty, it answers **403 `Origin not allowed`**
  to any request that carries an `Origin` header — which is every request a
  browser makes.

When a connection does fail this way, `connectMcpHttp` no longer just repeats the
browser's silence: it re-probes the endpoint with a plain request and, if that
gets through, says which header is being refused. `diagnoseMcpCors(url)` is
exported so a UI can show the same sentence.

With `protocol: 'auto'` or `'modern'` it goes one step further, because the
browser will not say *which* header a preflight refused: it sends one request
per header (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, each alone) and
names the ones that were blocked - `… one carrying Mcp-Method / Mcp-Name was
blocked: the server's Access-Control-Allow-Headers does not list them …`. That
sentence is added to the connect error (`'modern'`, and `'auto'` against a
2026-only server) or logged at `warn` (`'auto'` that fell back to 2025). The
same from your own code: `diagnoseMcpCors(url, fetch, { protocol: 'modern' })`.
These extra requests are made only after a connect already failed or fell back.

## Optional: WebMCP — a page's tools, both ways

[WebMCP](https://webmachinelearning.github.io/webmcp/) lets a page register named, typed tools
(`document.modelContext.registerTool(tool, { signal })`) that a browser's agent — Chrome's origin
trial, Edge, an extension, an in-page agent — can discover and call. The `./webmcp` subpath bridges it
and an agent's `ToolSet`, with no extra dependency and as a no-op where the browser has no WebMCP:

```ts
import { connectWebMcp, registerWebMcpTools } from '@dudko.dev/agent-web/webmcp'

// 1. Publish the tools your in-page agent uses, so any agent of the browser can drive them too.
//    One definition, two consumers; withdrawn when the signal aborts or unregister() is called.
const reg = await registerWebMcpTools(tools, {
  prefix: 'myapp_', // WebMCP tool names are shared with everything else on the page
  except: ['debug_dump'],
  consequential: ['clear_page'], // annotated consequentialHint: true
  signal: controller.signal,
})
// readOnly: true tools (defineTool) are annotated readOnlyHint: true

// 2. Use the tools a page has registered as the agent's own.
const web = await connectWebMcp({ onToolsChanged: () => rebuildAgent() })
const agent = await createAgent({ model, tools: { ...tools, ...web?.tools } })
```

Both generations of the browser API are handled: the current one on `document.modelContext` (a
tool is withdrawn by aborting its signal) and Chrome's early preview on `navigator.modelContext`
(`unregisterTool(name)`). Results are returned as text content (structured results as JSON), as
WebMCP clients read them. Validate strictly inside your `execute`, loosely in the schema: a
rejected call should be a result the calling agent can read, not a stalled tool.

## Thinking, limits, consent, skills, subagents

```ts
import { createAgent, createSubagentTool, defineSkill } from '@dudko.dev/agent-web'

const agent = await createAgent({
  model,
  tools: { ...tools, ...mcp.tools },
  thinking: 'high', // or { level, budgetTokens }; per stage via stageThinking
  limits: { maxTotalTokens: 200_000, maxReasoningTokens: 20_000 },
  maxToolCalls: 40,
  compaction: { contextWindowTokens: 128_000 }, // auto-compacts history and long runs
  skills: [defineSkill({ name: 'triage', description: 'Triage a bug report', content: '…' })],
  toolApproval: {
    mode: 'ask-writes', // autopilot | ask-writes | ask-all | read-only
    // `signal` aborts when the agent stops waiting (the bound, a stop): take your dialog down then
    onRequest: async (req, { signal }) => askInADialog(`Allow ${req.toolName}?`, { signal }),
    // no decision in 5 minutes (the default) -> deny; 0 or Infinity: wait until the run is stopped
    timeoutMs: 300_000,
  },
})
agent.setToolApprovalMode('autopilot') // flip the switch at any time
await agent.compact() // summarise the stored transcript now
```

With more than 40 tools (several MCP servers) the executor switches to **tool
search**: it starts each step small and calls `find_tools` to activate what it
needs. Subagents are tools too — `createSubagentTool({ config })` runs a child
agent in-process, `createSubagentTool({ worker, workerConfig })` isolates it in a
Web Worker served by `serveSubagentWorker()`. Add `profiles` and the parent model
chooses, per call, between named variants of the same subagent — another model,
thinking level, limits or system prompt. With `subagents: { dynamic: true }` the model
starts helpers itself (`spawn_subagent`): a sub-task, an optional role and a subset of its own
tools — a helper can only have less than the run that starts it, and its spend counts against
that run's limits. Give `persistence` a store
(`new IndexedDBRunStore()`) and a run interrupted by a reload or a crash resumes from its
last checkpoint with `run('', { resumeFromRunId })` — the planner does not run again and
no finished step is repeated. `createRunControl()` steers a run that is going: `send()`
puts a message in front of the model at the next boundary (the replanner re-checks the plan
against it), `stopSubagent(id)` stops one subagent. `egress` (off by default) gives the model one safe `web_fetch` tool with allow / deny lists. `search` (off by default) adds `web_search` over a function of yours (any search API — recipes for Tavily, Brave and SearXNG are in the docs) or the built-in Google Search through Gemini grounding, which needs only a Gemini key and spends its tokens — the key stays in the credential store. `sandbox` (off by default) gives the model `run_js`: the code it wrote runs in QuickJS-in-WebAssembly inside a Web Worker that is killed at the deadline, so "I ran it" is a tool call you can see. `media` (off by default) mounts `generate_image`, `generate_speech` and `transcribe_audio` — each only when you configure its model — writes what they make into the virtual file system instead of the context, and turns attached audio into text for a model that cannot listen. `learning` (off by default) lets the agent write down what it figured out as skills of its own — in memory, or in the file system across sessions. Details, defaults and events:
**[docs/capabilities.md](docs/capabilities.md)**.

## Pipelines: a graph of agents

A pipeline is a graph of agents - each node an agent with its own role, model and tools, each edge
passing one node's output to the next, optionally on a condition, loops allowed - described in
plain JSON, so it can be stored, shared and drawn by an editor.

```ts
import { createPipeline, nodeResolver } from '@dudko.dev/agent-web'

const definition = {
  version: 1,
  entry: 'writer',
  nodes: [
    { id: 'writer', name: 'Writer', instructions: 'Write the text the request asks for.', model: 'smart' },
    {
      id: 'reviewer',
      name: 'Reviewer',
      instructions: 'Review the text. Be strict.',
      routes: [{ label: 'approve', description: 'ready to publish' }, { label: 'revise' }],
    },
    { id: 'publisher', instructions: 'Format the approved text for publication.', tools: ['files'] },
  ],
  edges: [
    { from: 'writer', to: 'reviewer' },
    { from: 'reviewer', to: 'publisher', when: { kind: 'route', label: 'approve' } },
    { from: 'reviewer', to: 'writer', when: { kind: 'otherwise' } }, // the loop
  ],
  limits: { maxNodeVisits: 3, maxRuns: 25 }, // the defaults
}

const pipeline = createPipeline(definition, {
  // What the names in the definition stand for. A name that is not here fails its node.
  resolveNode: nodeResolver({
    base: { model, credentials }, // a BrowserAgentConfig: every node starts from it
    models: { smart: { providerType: 'openai', model: 'gpt-4o-mini', credentialRef: 'openai' } },
    tools: { files: createFileTools(vfs) },
    // skills: { ... }, mcpServers: { docs: mcp }, configure: (config, node) => config
  }),
})

const result = await pipeline.run({
  input: 'A release note for v2',
  onEvent: (e) => {
    if (e.type === 'pipeline.node.started') highlightNode(e.nodeId)
    if (e.type === 'pipeline.edge') highlightEdge(e.from, e.to, e.fired)
  },
})
result.text // the last node's answer; result.outputs, result.trace, result.usage, result.stoppedBy
```

**Abort:** `signal` aborts every running node and `run` resolves with what it has and `stoppedBy: 'aborted'`, as `agent.run` resolves with `stopped` (the Node sibling rejects with an `AbortError`, as its `agent.run` does). **Memory:** with `memory` in `base`, every node keeps a conversation of its own (`<sessionId>:<node id>`).

Conditions (`always`, `contains`, `matches`, `route`, `otherwise`), the scheduling rules (waves,
join, the loop caps), validation and the events: **[docs/capabilities.md](docs/capabilities.md#pipelines-a-graph-of-agents)**.
Loading a definition someone else wrote: [docs/security.md](docs/security.md#pipelines-a-definition-is-data).

## Configuration (highlights)

| Option | Default | Purpose |
| --- | --- | --- |
| `model` | — | a `LanguageModel` or `ProviderModelSpec` (the executor/default) |
| `planner` / `synthesizer` | = `model` | per-stage model overrides (inherit base provider/creds if partial) |
| `executorTiers` | off | `{ light?, standard?, strong? }`, each a model like `planner`: the planner rates every step low / medium / high and the executor runs it on that tier's model; a tier that is not configured falls back to the nearest one; the smallest window among them governs the run ([model tiers](docs/capabilities.md#model-tiers-and-escalation)) |
| `escalation` | on with tiers | `false`, or `{ maxPerStep?, maxPerRun? }` (1 / 3): a step that fails in a way a stronger model could fix is retried on the next stronger tier before the replanner is asked - continuing the step, never writing twice. Nothing without tiers |
| `credentials` | — | a `CredentialStore` for `credentialRef` keys |
| `tools` | `{}` | host tools (`defineTool`); mark a tool that runs code with `markCodeExecution` (always asked while a run acts on an MCP server's skill) |
| `availableTools` / `excludedTools` | — | whitelist / blacklist of tool names mounted from `tools` |
| `toolMode` | `'auto'` | `native` \| `prompted` \| `auto` (cloud→native, local→prompted) |
| `toolSelectionStrategy` | `'auto'` | `all` \| `plan-narrowed` \| `search` \| `auto` (search above `toolSearchThreshold`, 40, or once the definitions take ¼ of the window) |
| `appSampling` | on, with caps | the caps of `agent.sampleForApp` (an MCP App asking the model): `{ maxTokens: 1024, maxRequestsPerMinute: 5, maxRequests: 30, maxInputChars: 16000, reasoningTokens: 2048 }`, per app (`reasoningTokens`: room on top of an app's `maxTokens` for a model seen reasoning - its reasoning counts against the cap); `false` refuses every request. Nothing happens unless a host calls it, and every request goes to its `approve` first. See [An app asks the model](docs/capabilities.md#an-app-asks-the-model) |
| `toolApproval` | autopilot | consent policy: `{ mode, rules, onRequest, timeoutMs }`; `agent.setToolApprovalMode()`. A question waits `timeoutMs` for a decision, then is denied: default 300000 (`TOOL_APPROVAL_TIMEOUT_MS`), `0` or `Infinity` = until the run is stopped (as is a value above 2^31 - 1, the most a timer holds); negative or `NaN` fails `createAgent`. `onRequest(req, { signal })`: the signal aborts when the question ends without an answer (`TimeoutError` for the bound, `AbortError` for a stop). See [Tool consent](docs/capabilities.md#tool-consent-and-autopilot) |
| `skills` | — | SKILL.md bundles (`defineSkill` / `parseSkillMarkdown` / `loadSkillFromUrl`). An MCP server's skills come with its tools (`skills: true` or `{ consent }` on the server of `connectMcpHttp`, experimental) and join them as `<server>/<skill>` - see [MCP skills](#mcp-skills-experimental-a-servers-instructions-as-skills) |
| `mcpSkills` | `{ consent: 'once-per-skill' }` | experimental: when a person is asked (`toolApproval.onRequest`, a request with `skill`) before an MCP server's skill enters the model's context, for servers whose `skills: { consent }` does not say - `'once-per-skill'`, `'ask'` (every run) or `'never'` - see [MCP skills](#mcp-skills-experimental-a-servers-instructions-as-skills) |
| `egress` | off | what the **model** may fetch (`web_fetch`): `true` = any public host over https, or `{ allow, deny, protocols, allowPrivateNetwork, fetch, ... }`; a browser can't pin DNS, so prefer an `allow` list — see [Egress](docs/capabilities.md#egress-what-the-model-may-fetch) |
| `search` | off | the model may **search the web** (`web_search`: a short list of title / url / snippet): `{ engine: fn }` - a search engine of yours, any API - or `{ provider: 'google', credentialRef, model, baseURL, maxResults, allowPrivateNetwork, readOnly, fetch }` - Google Search through Gemini grounding: one extra `generateContent` call per search on a Gemini key (default model `gemini-2.5-flash-lite`), which **spends model tokens** (`usage` phase `'search'`) and returns **Google redirect links**, not the pages' URLs. No key ships with the library and none is written in the config (`credentialRef` names it in `credentials`); the request reaches only that API; with `egress`, results the model could not fetch are left out. Recipes for Tavily / Brave / SearXNG as an `engine`, the free-tier models and what the redirect links mean — see [Search](docs/capabilities.md#search-finding-the-page-to-fetch) |
| `media` | off | image generation, speech and transcription as tools, each mounted only when its model is set: `{ imageModel, speechModel, transcriptionModel, maxCalls, timeoutMs, files, folder, voice, speechFormat, transcribeAttachments }`. A model is an AI SDK image / speech / transcription model object or a `ProviderModelSpec` (key by `credentialRef`). Generated files go to the virtual file system and the model gets a path, never the bytes; attached audio is transcribed to text; calls are counted in `usage.mediaCalls` (and the other media fields) and capped per run — see [Media](docs/capabilities.md#media-images-speech-and-transcription) |
| `decisionModel` | off | a **decision model** - answers a closed question with one option and a probability instead of writing text: `{ providerType: 'google', model: 'gemini-decision-1', credentialRef }` (the key stays in `credentials`; the request reaches only that API) or an object with `decide(question, { abortSignal })`. Where it is confident it replaces the replanner's continue / finish call and a pipeline node's route call; never consulted for tool approval or egress — see [Decision models](docs/capabilities.md#decision-models) |
| `decision` | `{}` | `{ confidenceThreshold, timeoutMs, replan, route }` (defaults 0.8, 5000 ms, on, on): below the threshold, on an error, a timeout or an answer that is not an option, the ordinary model call runs unchanged |
| `subagents` | off | the **model** may start helper agents itself (`spawn_subagent`): `{ dynamic: true }`, or `{ dynamic: { maxDepth, maxChildren, maxConcurrent, budgetShare, minTokens, timeoutMs, defaultTools } }`. A helper gets a subset of the caller's tools by name (read-only ones by default), a share of what is left of its budgets, the same models and the same consent gate — it can only have less than the run that starts it. See [docs/capabilities.md](docs/capabilities.md#dynamic-subagents-helpers-the-model-starts-itself) |
| `sandbox` | off | the model may **run JavaScript it wrote** (`run_js`) and read the real output: `true`, or `{ worker, timeoutMs, memoryLimitBytes, maxOutputChars, maxCodeChars, files, engine }`. QuickJS in WebAssembly (optional peer `quickjs-emscripten`), in a Web Worker you supply (`@dudko.dev/agent-web/sandbox-worker`) that is killed at the deadline; with `createFileTools` the guest can import / require workspace files and use `fs` — see [Running code](docs/capabilities.md#running-code-the-sandbox) |
| `learning` | off | the agent writes down lessons as skills (`save_skill` / `forget_skill`): `true` = this session, `{ store: new VfsSkillStore(vfs) }` = across sessions — see [Learning](docs/capabilities.md#learning-lessons-that-outlive-the-task) |
| `thinking` / `stageThinking` | provider default | `true`, a level (`'low'`…`'xhigh'`, `'none'`), or `{ level, budgetTokens, includeThoughts }` |
| `limits` | — | run caps `maxInputTokens` / `maxOutputTokens` / `maxReasoningTokens` / `maxTotalTokens` + `perCall` output caps |
| `maxToolCalls` / `maxPlanSteps` | ∞ / 8 | tool calls per run / steps per plan |
| `compaction` | auto, at 85% of a 128k window (a local model: its own) | `{ auto, contextWindowTokens, thresholdRatio, thresholdTokens, keepRecentTurns, keepRecentSteps, maxToolOutputChars }` — judged on the whole context (fixed prompt + transcript + step log), never more than the model's window |
| `promptCaching` | `true` | stable system prefixes, Anthropic breakpoints, OpenAI cache key |
| `vision` / `inputs` | inferred | what the model takes as attachments (`run(goal, { images, files })`); see `agent.capabilities` |
| `systemPrompt` / `prompts` | — | prepended to every phase / override any phase's prompt builder |
| `mcpInstructions` | `true` | show the model the `instructions` MCP servers send on connect (planner + executor, marked third-party, capped); `false` keeps them out |
| `describeState` | — | serialize world state into prompt context |
| `memory` | — | `ContextStore` (`IndexedDBStore` / `MemoryStore`); recent turns are read back into the planner prompt |
| `sessionId` | — | names the stored conversation in `memory`, and the bucket `agent.sessionUsage()` counts into |
| `persistence` | — | checkpoint runs (`IndexedDBRunStore` / `MemoryRunStore`) so `run(goal, { resumeFromRunId })` continues after a reload — see [Resuming](docs/capabilities.md#resuming-an-interrupted-run) |
| `maxIterations` / `maxStepsPerTask` / `maxRevisions` | 8 / 4 / 2 | loop caps |
| `chatTimeoutMs` | 120000 | per-call watchdog; for the executor, the whole step (its tool calls included). Stopped while a tool call waits for a person (an approval, an MCP question): the step goes on with the time it had left - see [Tool consent](docs/capabilities.md#tool-consent-and-autopilot) |
| `temperature` | provider default | sampling temperature for every stage |
| `budgets` | — | legacy per-phase output caps; `limits.perCall` wins, `0` = no cap, and the defaults are shares of the model's window (none for a phase that thinks) |
| `clientName` | — | sent as the openai-compatible provider name and the MCP client name |
| `logLevel` / `logger` | `'warn'` / `console` | verbosity (`'silent' \| 'error' \| 'warn' \| 'info' \| 'debug'`) and the console-like sink the logs go to |
| `replan` / `synthesize` | `true` | toggle phases |
| `replanAfter` | `'failure'` | replan trigger: `'failure'` \| `'always'` \| `(stepResult) => boolean \| Promise<boolean>` |
| `compressAfterChars` | 12000 | legacy: summarize old history past this size (when `compaction` is unset) |

## Upgrading to the 2.x MCP SDK

The `./mcp` subpath moved from `@modelcontextprotocol/sdk` 1.x to the official
2.x client, `@modelcontextprotocol/client`, in one step. **The optional peer
dependency is renamed — that is the breaking change.** Nothing changes on the
wire, and nothing changes if you never import `@dudko.dev/agent-web/mcp`.

If you do import it:

1. **Install the new package, remove the old one.**
   `npm uninstall @modelcontextprotocol/sdk && npm install @modelcontextprotocol/client`
   (`^2.4.0`). With only the old package installed, a bundler cannot resolve
   `@modelcontextprotocol/client` and the build fails. The new SDK needs
   `zod ^4.2` (this package already depends on zod 4) and declares Node >= 20
   for tooling.
2. **Import SDK types from the new package.** `McpHttpServerConfig.authProvider`
   is the `OAuthClientProvider` of `@modelcontextprotocol/client`, `fetch` its
   `FetchLike`, `reconnection` its `StreamableHTTPReconnectionOptions`. Change
   `@modelcontextprotocol/sdk/client/auth.js`, `.../shared/auth.js`,
   `.../shared/transport.js` and `.../client/streamableHttp.js` to
   `@modelcontextprotocol/client`; the member names are the same. A provider
   that is only structurally an `OAuthClientProvider` (no import) keeps
   compiling, and a plain `fetch`-shaped function is still a `FetchLike`. If you
   only use `BrowserOAuthProvider` / `createEnterpriseOAuthProvider`, there is
   nothing to change in code.
3. **Errors.** `UnauthorizedError` (re-exported from `./mcp`) is the new
   package's class: an `instanceof` against a class imported from the 1.x
   package no longer matches. It now sets `name` to `'UnauthorizedError'`, and
   `instanceof` holds across two copies of the SDK. Other classes: `ProtocolError`
   (was `McpError`), `SdkError` / `SdkHttpError` (was `StreamableHTTPError`; the
   HTTP status is `.status`). Messages lost the `MCP error <code>: ` prefix.
4. **Your own `OAuthClientProvider`.** `tokens`, `saveTokens`,
   `clientInformation` and `saveClientInformation` get an optional last argument
   `ctx: { issuer }`; ignore it if you keep one credential set. The objects
   handed to the two `save*` methods carry an `issuer` field: store and return
   them **verbatim**. `invalidateCredentials` is called with `'client'` and then
   `'tokens'` on an `invalid_client` (it was `'all'`). When the provider
   implements `saveDiscoveryState`, `discoveryState()` must still return it when
   the code comes back, or the exchange is refused. A `saveTokens` that throws
   after a refresh now fails the request instead of starting a new
   authorization.
5. **Stored tokens need no migration.** What `BrowserOAuthProvider` wrote
   before (no `issuer` stamp) loads as it is and is stamped on first use. One
   thing does not carry over: an authorization that was *started* before the
   upgrade and comes back after it, if that version stored no discovery state —
   `finishMcpOAuth` refuses it and the user authorizes again.
6. **Behaviour that is new on purpose** (each in the sections above): a
   `tools/call` answered with a JSON-RPC error keeps the server's message
   verbatim; an `outputSchema` that cannot be compiled fails only that tool's
   calls, where it used to fail the whole server at connect; a
   `403 insufficient_scope` fails the call instead of starting an
   authorization; a server that speaks only 2026-07-28 is refused with a clear
   error (unless you opt in: `protocol: 'auto'` or `'modern'` on that server).

## Docs

- [docs/design.md](docs/design.md) — architecture & rationale.
- [docs/capabilities.md](docs/capabilities.md) — thinking, limits, compaction,
  caching, skills, tool consent / autopilot, large MCP catalogues, subagents,
  steering a running agent, learning, egress, pipelines, usage, resuming, autonomy, event reference.steering a running agent, learning, egress, usage, resuming, autonomy, event reference.
- [docs/providers.md](docs/providers.md) — every provider, CORS & direct-vs-proxy.
- [docs/security.md](docs/security.md) — the token vault, egress, learning and pipelines: threat models.— the token vault, egress and learning: threat models.
- [docs/tasks.md](docs/tasks.md) — status & roadmap.
- [`@dudko.dev/agent-web-react`](https://www.npmjs.com/package/@dudko.dev/agent-web-react) —
  React bindings (`useAgent`, `<AgentProvider>`, pre-styled components) ·
  [live demo](https://agent.dudko.dev/demo/) ·
  [source](https://github.com/dudko-dev/agents/tree/main/packages/agent-web-react).
- [`@dudko.dev/agent`](https://www.npmjs.com/package/@dudko.dev/agent) — the
  Node/server sibling (stdio MCP, persistence/resume, OpenTelemetry, CLI).

## License

MIT © Siarhei Dudko
