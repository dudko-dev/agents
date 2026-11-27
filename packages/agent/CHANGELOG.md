# 0.0.50 / 2026-11-27

### :tada: Enhancements
- MCP skills: `read_skill_file` on a directory path (`.`, `templates/`) lists its direct children, for every kind of skill. An MCP skill is listed from the entry it was approved with; where the server declared `directoryRead`, `resources/directory/read` is asked only to see whether the skill changed there - what it lists beyond the entry is counted, never named, a file it no longer lists is marked `notServed`, and the server's skills are re-read before the next run
- MCP skills: `"dynamic"` skills (no checksums from the server), opt-in per server with `skills: { dynamic: true }`. Before the user is asked, the agent reads a copy of the skill (its `SKILL.md`, and every file where the server can list them) within bounds (512 files, 16 MiB, 64 directories, depth 8; 64 MiB per agent), computes the checksums itself and binds the consent to them; the model reads only that copy, from memory. Off by default: such skills are declined as before
- CLI: `MCP_SERVERS` takes `skills` (`true` or `{ "consent", "dynamic" }`, with `"protocol": "auto"` or `"modern"`) and `connectTimeoutMs` per server; before a server's skill reaches the model the REPL shows it - whose it is, its size, the first lines of what the model would read - and asks `[y]es / [n]o / [a]lways for this server`

# 0.0.49 / 2026-11-27

### :tada: Enhancements
- **Breaking for `config.search`:** the Brave, Tavily and SearXNG adapters are gone from the library. `search` takes your own `engine` function (a few lines for any provider), or `provider: 'google'` - Google Search through Gemini grounding, with its tokens reported under the usage phase `'search'`
- MCP 2026-07-28 per server: `protocol: 'legacy' | 'auto' | 'modern'` (`'legacy'` keeps the 2025 revisions, the default)
- MCP elicitation: a server may ask the user something during a tool call - `onElicitation(request, { signal })` (form or URL), with limits per call and run; events `mcp.elicitation-requested` / `mcp.elicitation-answered`. Off by default
- MCP 2026-07-28: when the `subscriptions/listen` stream ends it is opened again with backoff (10 failures in a row give up), and the tools are re-listed after a re-subscribe
- MCP skills (the `io.modelcontextprotocol/skills` extension, experimental): `skills: true | { consent }` per server, `mcpSkills` agent-wide. A server's skills join the catalog as `<server>/<skill>`, are read when needed, verified against the server's digests and loaded as third-party knowledge; `load_skill({ server, uri })` loads one the listing left out. The user is asked before a skill's text reaches the model (through `toolApproval.onRequest`; once per skill by default; autopilot does not skip it), and while one is active every tool that runs code is asked
- MCP OAuth: `registration: 'auto' | 'cimd' | 'dcr'` - a client ID metadata document where the server supports it (default), the document only, or dynamic registration only; `registrationKind()` says which one a stored client is
- Approval: a question waits 5 minutes by default (`toolApproval.timeoutMs`; `0` or `Infinity` = until the run is stopped); `onRequest` gets `{ signal }`. The CLI closes a question that ended without an answer
- Time spent waiting for a person (a consent prompt, a server's question) does not count against the step's or a subagent's time limit
- Sandbox: `timeoutMs` counts from the program's first instruction, not from the engine's start (a busy machine no longer fails short limits)

# 0.0.48 / 2026-11-26

### :tada: Enhancements
- MCP runs on the 2.x SDK (`@modelcontextprotocol/client` ^2.4, a dependency: nothing to install); the wire is unchanged (protocol 2025-11-25). Errors from the SDK lost the `MCP error <code>: ` prefix, and an authorization finished without stored discovery state is refused: authorize again
- A 403 `insufficient_scope` in the middle of a session: an interactive OAuth provider fails the call with the scope the server asked for, a non-interactive one asks again once
- Decision model: a question without a context is sent with its prompt as the state (the live API refuses an empty one); an option without a description is described by its id

# 0.0.47 / 2026-11-26

### :tada: Enhancements
- Model tiers: `executorTiers` (`light` / `standard` / `strong`) - the planner rates a step and the executor runs it on that tier's model; `escalation` retries a failed step on the next stronger tier (new event `step.escalated`)
- `web_search`: `config.search` with Brave, Tavily and SearXNG adapters or your own engine; results filtered by the egress policy and treated as untrusted text
- `decisionModel`: a decision model answers the replanner's continue / finish and a pipeline route, with a confidence threshold and fallback to the ordinary call (new event `decision`)
- Media: `config.media` - `generate_image`, `generate_speech`, `transcribe_audio` and transcription of audio attachments; files are written to the workspace, never sent to the model as bytes (events `media.generated`, `media.transcribed`)
- Dynamic subagents: `subagents: { dynamic }` - the model starts a helper (`spawn_subagent`) with a subset of its own tools, under depth, count and budget limits; `subagent.start` carries `parentId` and `depth`
- MCP: a server's `instructions` reach the planner and executor as third-party notes (`mcpInstructions`); `structuredContent` is handled and a result that breaks its `outputSchema` is passed on with a note instead of lost
- A replanner failure no longer ends the run: it continues with the existing plan (`replan.decision.failed`); abort and 401/403 still stop it
- Structured calls moved off the deprecated `streamObject` / `generateObject`
- `outputSanitizer` is now also called for a tool's structured value (an object, not a content array)

# 0.0.46 / 2026-11-26

### :tada: Enhancements
- Pipelines: `createPipeline` runs a graph of agents with conditions and loops, described in plain JSON
- Sandbox: `config.sandbox` gives the model `run_js` - its JavaScript runs in QuickJS (WebAssembly) in a worker thread with time and memory limits (optional peer `quickjs-emscripten`); CLI: `AGENT_SANDBOX`
- MCP OAuth: client ID metadata documents (`clientMetadataUrl`), `application_type`, the `iss` of the authorization response is checked (RFC 9207)
- MCP OAuth: enterprise-managed authorization (ID-JAG) with `createEnterpriseOAuthProvider` - client secret or `private_key_jwt`, `assertionAudience` / `assertionType`

# 0.0.45 / 2026-11-26

### :tada: Enhancements
- Updated dependencies: ai

# 0.0.43 / 2026-11-21

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai

# 0.0.42 / 2026-11-14

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, prettier

# 0.0.36 / 2026-11-07

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai

# 0.0.35 / 2026-10-31

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai

# 0.0.34 / 2026-10-24

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @modelcontextprotocol/sdk, @opentelemetry/api, ai, workers-ai-provider

# 0.0.33 / 2026-10-17

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, prettier, tsup, zod

# 0.0.32 / 2026-10-10

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @modelcontextprotocol/sdk, ai

# 0.0.30 / 2026-09-26

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @modelcontextprotocol/sdk, ai, prettier

# 0.0.29 / 2026-09-19

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, prettier, typescript, zod

# 0.0.28 / 2026-09-12

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, typescript, zod

# 0.0.27 / 2026-09-05

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, typescript, zod

# 0.0.26 / 2026-08-29

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, typescript, zod

# 0.0.25 / 2026-08-21

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, typescript

# 0.0.21 / 2026-08-14

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, typescript

# 0.0.20 / 2026-08-07

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, typescript

# 0.0.19 / 2026-08-01

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, @modelcontextprotocol/sdk, ai, typescript

# 0.0.18 / 2026-07-25

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, prettier, typescript, workers-ai-provider

# 0.0.16 / 2026-07-02

### :tada: Enhancements
- README: cross-link to the browser sibling package [`@dudko.dev/agent-web`](https://www.npmjs.com/package/@dudko.dev/agent-web)

# 0.0.15 / 2026-06-20

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, workers-ai-provider

# 0.0.14 / 2026-06-13

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, prettier

# 0.0.13 / 2026-06-06

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/azure, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/xai, ai

# 0.0.12 / 2026-05-30

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, ai

# 0.0.11 / 2026-05-23

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai

# 0.0.10 / 2026-05-15

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/xai, ai

# 0.0.9 / 2026-05-08

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, workers-ai-provider

# 0.0.8 / 2026-05-06

### :tada: Enhancements
- Updated dependencies: @ai-sdk/amazon-bedrock, @ai-sdk/anthropic, @ai-sdk/azure, @ai-sdk/deepseek, @ai-sdk/google, @ai-sdk/google-vertex, @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/xai, ai, typescript, zod

