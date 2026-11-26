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

