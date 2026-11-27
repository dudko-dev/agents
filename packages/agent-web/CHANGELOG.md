# 0.0.42 / 2026-11-27

### :tada: Enhancements
- MCP skills: `read_skill_file` on a directory path (`.`, `templates/`) lists its direct children, for every kind of skill. An MCP skill is listed from the entry it was approved with; where the server declared `directoryRead`, `resources/directory/read` is asked only to see whether the skill changed there - what it lists beyond the entry is counted, never named, a file it no longer lists is marked `notServed`, and `onToolsChanged` asks the host to refresh that server
- MCP skills: `"dynamic"` skills (no checksums from the server), opt-in per server with `skills: { dynamic: true }`. Before the user is asked, the agent reads a copy of the skill (its `SKILL.md`, and every file where the server can list them) within bounds (512 files, 16 MiB, 64 directories, depth 8; 64 MiB per agent), computes the checksums itself and binds the consent to them; the model reads only that copy, from memory. The consent request says so (`skill.dynamic`, `skill.noFileListing`). Off by default: such skills are declined as before

# 0.0.41 / 2026-11-27

### :tada: Enhancements
- **Breaking for `config.search`:** the Brave, Tavily and SearXNG adapters are gone from the library. `search` takes your own `engine` function (a few lines for any provider), or `provider: 'google'` - Google Search through Gemini grounding, with its tokens reported under the usage phase `'search'`
- MCP Apps (the `io.modelcontextprotocol/ui` extension): a tool's interactive view, read through the connection (`apps: true` on connect; per server `apps: false`), the event `mcp.app`, and `agent.approveAppToolCall` - an app's tool calls go through the agent's consent gate (writes ask even on autopilot). `agent.sampleForApp` answers an app's `sampling/createMessage` with the synthesizer's model (no tools, no context, consent per request, caps and a rate per app, usage phase `'app'`; `config.appSampling`); a model seen reasoning gets `reasoningTokens` of room on top of the app's `maxTokens`. `apps.readResource` reads a file an app offers for download from its own server
- Files a run writes are reported: events `file.written` / `file.deleted`
- MCP 2026-07-28 per server: `protocol: 'legacy' | 'auto' | 'modern'`; when the `subscriptions/listen` stream ends it is opened again with backoff and the tools are re-listed
- MCP elicitation: `onElicitation(request, { signal })` (form or URL) with limits per call and run; events `mcp.elicitation-requested` / `mcp.elicitation-answered`. Off by default
- MCP skills (experimental): `skills: true | { consent }` per server, `mcpSkills` agent-wide - namespaced `<server>/<skill>`, verified against the server's digests, loaded as third-party knowledge, `load_skill({ server, uri })` for unlisted ones, and the user asked before a skill's text reaches the model (once per skill by default)
- MCP OAuth: `registration: 'auto' | 'cimd' | 'dcr'` on `BrowserOAuthProvider`, and `registrationKind()`
- Approval: a 5-minute default wait (`toolApproval.timeoutMs`; `0` / `Infinity` = until stopped); `onRequest` gets `{ signal }`. Time waiting for a person does not count against the step's or a subagent's limit
- Sandbox: `timeoutMs` counts from the program's first instruction

# 0.0.40 / 2026-11-26

### :tada: Enhancements
- **Breaking for hosts that use `./mcp`:** the optional peer is renamed - `npm uninstall @modelcontextprotocol/sdk && npm install @modelcontextprotocol/client` (^2.4). SDK types are imported from `@modelcontextprotocol/client`; stored tokens need no migration. See "Upgrading to the 2.x MCP SDK" in the README
- MCP on the 2.x SDK with the wire unchanged (protocol 2025-11-25); output schemas are checked with the SDK's browser validator, which generates no code and so runs under a CSP without `unsafe-eval`
- A 403 `insufficient_scope` in the middle of a session: an interactive OAuth provider fails the call with the scope the server asked for, a non-interactive one (enterprise) asks again once
- `tools/list` stops on a repeated cursor and warns when a server is still paginating after 100 pages
- An authorization finished without stored discovery state is refused: authorize again
- Decision model: a question without a context is sent with its prompt as the state (the live API refuses an empty one); an option without a description is described by its id
- `engines.node` is now `>=20` (what the MCP client declares)

# 0.0.39 / 2026-11-26

### :tada: Enhancements
- Model tiers: `executorTiers` (`light` / `standard` / `strong`) - the planner rates a step and the executor runs it on that tier's model; `escalation` retries a failed step on the next stronger tier (new event `step.escalated`)
- `web_search`: `config.search` with Brave, Tavily and SearXNG adapters or your own engine; results filtered by the egress policy and treated as untrusted text
- `decisionModel`: a decision model answers the replanner's continue / finish and a pipeline route, with a confidence threshold and fallback to the ordinary call (new event `decision`)
- Media: `config.media` - `generate_image`, `generate_speech`, `transcribe_audio` and transcription of audio attachments; files are written to the workspace, never sent to the model as bytes (events `media.generated`, `media.transcribed`)
- Dynamic subagents: `subagents: { dynamic }` - the model starts a helper (`spawn_subagent`) with a subset of its own tools, under depth, count and budget limits; `subagent.start` carries `parentId` and `depth`
- MCP: a server's `instructions` reach the planner and executor as third-party notes (`mcpInstructions`); `structuredContent` is handled and a result that breaks its `outputSchema` is passed on with a note instead of lost
- Per-call output caps follow the Node rules: `limits.perCall.<stage>: 0` means no cap, a thinking stage has no default cap, a cut answer is reported
- A replanner failure is reported (`error` with phase `replan`, `replan.decision.failed`) instead of degrading silently
- `generateStructured` returns a plain typed object (`StructuredResult`) instead of the SDK's `GenerateObjectResult`
- The guarded fetch forwards a request body

# 0.0.38 / 2026-11-26

### :tada: Enhancements
- Pipelines: `createPipeline` runs a graph of agents with conditions and loops, described in plain JSON
- Sandbox: `config.sandbox` gives the model `run_js` - its JavaScript runs in QuickJS (WebAssembly) in a Web Worker you supply (new entry `./sandbox-worker`, optional peer `quickjs-emscripten`), bound to the workspace files through the same consent rules
- MCP OAuth: client ID metadata documents (`clientMetadataUrl`), `application_type`, the `iss` of the authorization response is checked (RFC 9207)
- MCP OAuth: enterprise-managed authorization (ID-JAG) with `createEnterpriseOAuthProvider` - client secret or `private_key_jwt`, `assertionAudience` / `assertionType`

# 0.0.37 / 2026-11-26

### :tada: Enhancements
- Updated dependencies: ai

# 0.0.35 / 2026-11-21

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @mlc-ai/web-llm, ai

# 0.0.34 / 2026-11-14

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @mlc-ai/web-llm, ai, prettier

# 0.0.27 / 2026-11-07

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai

# 0.0.26 / 2026-10-31

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @mlc-ai/web-llm, ai, fake-indexeddb

# 0.0.25 / 2026-10-24

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @modelcontextprotocol/sdk, ai

# 0.0.24 / 2026-10-17

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @mlc-ai/web-llm, ai, fake-indexeddb, prettier, tsup, zod

# 0.0.23 / 2026-10-10

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @modelcontextprotocol/sdk, ai, idb

# 0.0.19 / 2026-09-26

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @modelcontextprotocol/sdk, ai, prettier

# 0.0.18 / 2026-09-19

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, prettier, zod

# 0.0.17 / 2026-09-12

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @browser-ai/core, @browser-ai/web-llm, @mlc-ai/web-llm, ai, typescript, zod

# 0.0.16 / 2026-09-05

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, typescript, zod

# 0.0.15 / 2026-08-29

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, typescript, zod

# 0.0.14 / 2026-08-21

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @browser-ai/core, @browser-ai/web-llm, ai, typescript

# 0.0.8 / 2026-08-14

### :tada: Enhancements
- Updated dependencies: @ai-sdk/anthropic, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @browser-ai/core, @browser-ai/web-llm, @modelcontextprotocol/sdk, ai, prettier, typescript

