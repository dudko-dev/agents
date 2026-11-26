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
# optional: HTTP MCP
npm install @modelcontextprotocol/sdk
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

`connectMcpHttp` returns `{ tools, catalog, results, instructions, refreshServer, close }`.
`tools` and `catalog` are mutated **in place** by `refreshServer(name)`, so an
agent built from them picks up a server's new tool list (react to it via the
`onToolsChanged` option) without being rebuilt. Filtering is plain object work:
delete the keys you don't want before merging.

### OAuth 2.1 + Dynamic Client Registration

A server behind OAuth needs more than a header: access tokens expire mid-run.
Pass an `authProvider` and the MCP SDK discovers the authorization server
(RFC 9728), registers this app dynamically (RFC 7591 — no client_id to
pre-provision), runs PKCE, and **refreshes the access token on any 401 and
retries the request**.

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
- **Registration** describes a public PKCE client. `application_type` follows
  the redirect URL: `'web'` for an https page, `'native'` for a loopback one
  (local development). Change any field through `clientMetadata`.
- `provider.reset()` forgets tokens, registration and discovery - use it when a
  server moved to another authorization server.

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
    onRequest: async (req) => window.confirm(`Allow ${req.toolName}?`),
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
thinking level, limits or system prompt. Give `persistence` a store
(`new IndexedDBRunStore()`) and a run interrupted by a reload or a crash resumes from its
last checkpoint with `run('', { resumeFromRunId })` — the planner does not run again and
no finished step is repeated. `createRunControl()` steers a run that is going: `send()`
puts a message in front of the model at the next boundary (the replanner re-checks the plan
against it), `stopSubagent(id)` stops one subagent. `egress` (off by default) gives the model one safe `web_fetch` tool with allow / deny lists. `search` (off by default) adds `web_search` over a search API you name (Tavily, Brave through a gateway, your SearXNG) or a function of yours — the key stays in the credential store. `sandbox` (off by default) gives the model `run_js`: the code it wrote runs in QuickJS-in-WebAssembly inside a Web Worker that is killed at the deadline, so "I ran it" is a tool call you can see. `learning` (off by default) lets the agent write down what it figured out as skills of its own — in memory, or in the file system across sessions. Details, defaults and events:
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
| `tools` | `{}` | host tools (`defineTool`) |
| `availableTools` / `excludedTools` | — | whitelist / blacklist of tool names mounted from `tools` |
| `toolMode` | `'auto'` | `native` \| `prompted` \| `auto` (cloud→native, local→prompted) |
| `toolSelectionStrategy` | `'auto'` | `all` \| `plan-narrowed` \| `search` \| `auto` (search above `toolSearchThreshold`, 40, or once the definitions take ¼ of the window) |
| `toolApproval` | autopilot | consent policy: `{ mode, rules, onRequest, timeoutMs }`; `agent.setToolApprovalMode()` |
| `skills` | — | SKILL.md bundles (`defineSkill` / `parseSkillMarkdown` / `loadSkillFromUrl`) |
| `egress` | off | what the **model** may fetch (`web_fetch`): `true` = any public host over https, or `{ allow, deny, protocols, allowPrivateNetwork, fetch, ... }`; a browser can't pin DNS, so prefer an `allow` list — see [Egress](docs/capabilities.md#egress-what-the-model-may-fetch) |
| `search` | off | the model may **search the web** (`web_search`: a short list of title / url / snippet): `{ provider: 'tavily' \| 'brave' \| 'searxng', credentialRef, baseURL, maxResults, allowPrivateNetwork, readOnly, fetch }` or `{ engine: fn }`. No key ships with the library and none is written in the config (`credentialRef` names it in `credentials`); the request reaches only the search API; with `egress`, results the model could not fetch are left out. Brave needs a gateway from a page (no CORS) — see [Search](docs/capabilities.md#search-finding-the-page-to-fetch) |
| `decisionModel` | off | a **decision model** - answers a closed question with one option and a probability instead of writing text: `{ providerType: 'google', model: 'gemini-decision-1', credentialRef }` (the key stays in `credentials`; the request reaches only that API) or an object with `decide(question, { abortSignal })`. Where it is confident it replaces the replanner's continue / finish call and a pipeline node's route call; never consulted for tool approval or egress — see [Decision models](docs/capabilities.md#decision-models) |
| `decision` | `{}` | `{ confidenceThreshold, timeoutMs, replan, route }` (defaults 0.8, 5000 ms, on, on): below the threshold, on an error, a timeout or an answer that is not an option, the ordinary model call runs unchanged |
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
| `chatTimeoutMs` | 120000 | per-call watchdog |
| `temperature` | provider default | sampling temperature for every stage |
| `budgets` | — | legacy per-phase output caps; `limits.perCall` wins, `0` = no cap, and the defaults are shares of the model's window (none for a phase that thinks) |
| `clientName` | — | sent as the openai-compatible provider name and the MCP client name |
| `logLevel` / `logger` | `'warn'` / `console` | verbosity (`'silent' \| 'error' \| 'warn' \| 'info' \| 'debug'`) and the console-like sink the logs go to |
| `replan` / `synthesize` | `true` | toggle phases |
| `replanAfter` | `'failure'` | replan trigger: `'failure'` \| `'always'` \| `(stepResult) => boolean \| Promise<boolean>` |
| `compressAfterChars` | 12000 | legacy: summarize old history past this size (when `compaction` is unset) |

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
