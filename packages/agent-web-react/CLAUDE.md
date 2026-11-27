# @dudko.dev/agent-web-react — instructions for Claude

> Lives in the `dudko-dev/agents` monorepo at `packages/agent-web-react`. The root `CLAUDE.md` has the workspace
> commands (pnpm + nx) and the rules shared by all packages; this file is about this package only.

React bindings for **`@dudko.dev/agent-web`**, the headless in-browser LLM agent.
This package adds a thin, UI layer: one hook (`useAgent`), a context provider,
and a set of optional pre-styled components. It ships **no agent logic of its
own** — the core does planning/tools/providers/vault; this package turns its
`AgentEvent` stream into React state and renders it.

The **Vite demo** lives in `apps/demo` of the monorepo; the browser tests in `e2e/` here run
against its production build.

## Principles

- **The core is the engine; this is the dashboard.** All model/tool/vault logic
  lives in `@dudko.dev/agent-web` (a peer dependency). Never reimplement it here.
- **Headless-first.** The event→UI mapping is a **pure reducer** (`src/state.ts`,
  exported as `agentStateReducer`) with no React, clock or randomness — so it is
  unit-testable and lets hosts build a fully custom UI. Components are sugar.
- **`useAgent` is the seam.** It builds the agent, streams events into
  `AgentUiState`, and exposes `run/stop/reset/reload`. Everything else composes it.
- **Optional peers.** `react`, `react-dom`, and `@dudko.dev/agent-web` are peers.
  Model providers / WebLLM are the **core's** optional peers — this package never
  imports them directly.
- **Styling is opt-in.** Components carry `awr-`-prefixed classes and read
  `--awr-*` custom properties; `styles.css` is a separate import, copied verbatim
  into `dist`. No CSS-in-JS runtime, no CSS imported from TS.

## Layout

- `src/state.ts` — the pure `agentStateReducer` + `createInitialAgentState`.
- `src/types.ts` — `AgentUiState`, `ChatMessage`, `StepView`, `ToolCallView`, …
- `src/hooks/` — `use-agent` (the hook; `send` / `stopSubagent` steer a running agent
  through the core's `RunControl`), `use-credentials` (vault),
  `use-local-model` (any on-device runtime as an engine) + `use-webllm-model`
  (its WebLLM engine), `use-mcp` (remote MCP + OAuth round-trip),
  `use-mcp-servers` (several servers), `use-chat-history`, `use-virtual-files`,
  `use-speech-to-text`.
- `src/approval-queue.ts` — `createApprovalQueue`, the consent queue behind `useAgent`'s
  `approve` / `deny` (the core's `onRequest`): a request whose `signal` aborts (the core's
  `timeoutMs`, a stop) leaves it, so no stale resolver is kept. `tests/approval-queue.test.ts`.
- `src/chat-history.ts` — `ChatHistoryStore` (raw IndexedDB, memory fallback).
- `src/composer.ts` — the composer's pure helpers (slash commands, attachment
  kinds/refusals, notices); `src/image-resize.ts` — `downscaleImage`.
- `src/labels.tsx` — every UI string (`defaultLabels`, `AgentLabelsProvider`,
  `useLabels`); components take `labels` overrides.
- MCP elicitation (a server asks the USER something during a tool call), in four parts:
  - state: the reducer folds the core's `mcp.elicitation-requested` / `mcp.elicitation-answered`
    into `AgentUiState.elicitations` (`ElicitationView`; optional - absent until a server asks, so
    a state without the feature is what it was; a subagent's question surfaces on the run;
    `stopped` cancels the pending ones). It is deliberately NOT mirrored onto the run's
    `ChatMessage` (a saved conversation must not hold a server's form) and never holds an answer.
  - `src/elicitation.ts` - pure, no SDK, no `./mcp`: the queue the hooks hand the core as
    `onElicitation` (`createElicitationQueue`: `request.id → resolver`, each question leaves once -
    answered, `cancel` on `ctx.signal` abort, on a disconnect, on unmount), `elicitationConnectOptions`
    (OFF adds no key at all: no capability, the wire unchanged), and the prompt's pure half (fields →
    controls, the draft, `elicitationFormAnswer` with the core's own rules - `tests/elicitation.test.ts`
    cross-checks it against the core's `validateMcpElicitationContent` - `elicitationLink`, the
    countdown). The queue is exported from `./mcp`, the form helpers from the main entry.
  - hooks (`./mcp` only): `useMcp` / `useMcpServers` take `elicitation: true | settings` and per
    server `protocol: 'legacy' | 'auto' | 'modern'` (passed only when given), and return
    `pendingElicitations`, `answerElicitation`, the negotiated `protocol` / `protocols`
    (`useElicitationQueue` in `use-mcp.ts` is shared by both).
  - `src/components/ElicitationPrompt.tsx` (main entry) beside `ToolApprovalPrompt` in `AgentChat`
    (`elicitations`, `onElicitationAnswer`, `showElicitation`, `renderElicitation`,
    `components.ElicitationPrompt`). A consent boundary: the server's text is plain text in a box
    captioned as the server's, a link is opened only by the click on Open (`window.open(url,
    '_blank', 'noopener,noreferrer')`; no `<a>`, no Open for anything but https / loopback http),
    and typed values live in the form's own state only (`e2e/elicitation.spec.ts` looks for them in
    the DOM, storage, IndexedDB, the console and the model's requests). Labels `elicitation*`.
- `src/mcp-types.ts` — structural types for the core's optional `./mcp` subpath,
  which `use-mcp` loads with a dynamic import (never a static one).
- `src/mcp.ts` — the **`./mcp` entry**: `useMcp`, `useMcpServers` and their helpers
  and types. They are deliberately NOT in `src/index.ts`. A bundler resolves even a
  dynamic `import('@dudko.dev/agent-web/mcp')` at build time, and the core's `mcp.js`
  statically imports the optional `@modelcontextprotocol/client` (the 2.x MCP SDK; it was
  `@modelcontextprotocol/sdk` 1.x up to core 0.0.39) — so any reference from
  the main entry fails webpack/CRA builds of hosts that never use MCP.
  `tests/entries.test.ts` enforces it (and that no entry of THIS package imports the SDK at all);
  don't move MCP back "for convenience". `isUnauthorizedError` recognises the SDK's error by the
  class the core re-exports (a brand on 2.x, so it holds across two copies of the SDK), then by
  `name`, then by `constructor.name` (1.x cores): `tests/mcp.test.ts` loads the real class through
  the core's `./mcp` and a second copy of the SDK. The `@modelcontextprotocol/sdk` 1.x
  devDependency is there for `e2e/servers.ts` only: a real 1.x MCP SERVER over real sockets.
- `src/pipeline.ts` — the **`./pipeline` entry**: the pipeline editor. Like MCP, deliberately NOT in
  `src/index.ts` (a chat host should not carry a canvas and a code generator, nor need a core that
  has `createPipeline`); `tests/entries.test.ts` checks the main entry and every chunk it loads.
  Two layers, kept apart:
  - `src/canvas/` — a GENERIC canvas (`Canvas`, `CanvasPort`; `geometry.ts` is its maths as pure
    functions). It knows nothing about agents and imports only `react` and its own files
    (`tests/canvas.test.ts` fails otherwise): it must stay liftable into a package of its own.
    Our own code, no canvas / graph / drag library - and no new dependency in this package at all.
  - `src/pipeline/` — the editor: `PipelineEditor` (+ toolbar, issues, run bar, `PipelineResults`,
    `PipelineCodeDialog`), `PipelineNodeCard`, `PipelineInspector`, `use-pipeline` (the hook),
    `state` (the pure `pipelineStateReducer`, the pipeline's `agentStateReducer`), `edit` (pure
    editing helpers: they keep edges and the entry consistent and return the same object when
    nothing changes), `codegen` (`pipelineToCode`), `labels` (`PipelineLabels` - its own object,
    not `AgentLabels`; `tests/pipeline.test.ts` fails when a key is missing from
    `docs/pipeline.md`), `icons`.
  - `src/pipeline.css` — its stylesheet, separate from `styles.css` and standing on its own (same
    `awr-` prefix, same `--awr-*` tokens with the same light + dark defaults), copied to `dist`.
- `src/context.tsx` — `AgentProvider` + `useAgentContext`.
- `src/components/` — `AgentChat` (panel: history sidebar, transcript,
  composer, files panel; slots / render props / components / theme),
  `AgentComposer`, `MessageList`, `StepList` (+ `ToolCallRow`),
  `ToolApprovalPrompt`, `ElicitationPrompt`, `ApprovalModeSwitch`, `ChatHistoryList`, `FilesPanel`, `LearnedSkills`
  (the agent's notebook: `learned` in the state belongs to the agent, not the conversation),
  `SubagentTree` (+ `SubagentRow`: `subagents` in the state is a flat list that IS a tree -
  `parentId` / `depth`, nested by `subagentTree`; nested `subagent.event` envelopes are unwrapped in
  the reducer, and a helper's consent request is lifted from them), `Media` (`GeneratedMedia`: a
  generated file read from the VFS into an object URL, only the core's media types, never SVG;
  `TranscriptBlock`),
  `FileChips` (+ `FileChip`, `SourceView`: the files an answer wrote - `writtenFiles` in the
  state, folded from the core's `file.written` / `file.deleted`; a file's text is always text
  nodes), `SandboxedFrame` (untrusted HTML in host-drawn chrome), `McpAppFrame` / `McpAppLine` /
  `AppRequestPrompt` (MCP Apps, below),
  `ContextMeter`, `Composer` (minimal), `PlanView`, `ModelLoadBar`,
  `UsageBadge`, `ApiKeyForm`, `icons`, `format`. Docs: `docs/chat.md`.
- `apps/demo/src/app-sandbox.ts` (monorepo root) — where the demo's apps run: the production sandbox
  page (`apps/app-sandbox`), or on loopback the same page under the other loopback name (the Vite
  servers' `appSandbox` plugin).
- `apps/demo/src/components/McpPanel.tsx` (monorepo root) — the demo's "bring your own MCP" panel,
  and its "Try the demo server" (adds `${location.origin}/mcp/demo`, protocol `auto`: the site's
  own MCP server, `apps/worker`).
- `src/html-preview.ts` — the sandboxed frame's security core as pure strings: `sandboxTokens`
  (never `allow-same-origin`), `sandboxedCsp` (no network source), `withCspFirst`,
  `buildSandboxedDocument` (the SHELL: the untrusted document is framed by a document of ours
  whose `frame-src 'none'` is the only thing that stops a frame navigating itself), `tokenizeHtml`.
  **Security boundary**: every guard has a `guard …` test in `tests/files.test.ts` AND in
  `e2e/files.spec.ts` (a real browser, hostile pages, a counted endpoint), and a change needs a
  mutation check. Never render a workspace file by `blob:` / `data:` URL or as markup.
  `src/file-kinds.ts` — `fileKindOf` (only the core's image types are pictures; SVG is source).
- MCP Apps (the `io.modelcontextprotocol/ui` extension) — `src/mcp-app.ts`: the frame's security
  core as pure code (no React, no DOM): `mcpAppCsp` (the app's policy from its resource's declared
  origins ONLY, each re-checked with the core's `mcpAppOrigin`; frames / workers / `<base>` never
  granted), `buildMcpAppDocument` (the shell: the policy first, one inner `sandbox="allow-scripts"`
  frame with the same policy first in it, and `MCP_APP_RELAY` - by window, never the reserved
  `ui/notifications/sandbox-*`), `appLinkOf`, `appMessageTextOf`, and `McpAppBridge` (the
  extension's JSON-RPC: an allow-list of methods, parameters checked, `MCP_APP_MAX_IN_FLIGHT`,
  nothing but `ping` before `ui/initialize`, the tool's input / result once after `initialized`).
  `src/hooks/use-mcp-app-host.ts` (`useMcpAppHost`: reads an app through the connection, puts each
  tool call through `useAgent().approveAppToolCall` - the core's gate - and holds link / message
  requests until the user answers; a link is opened only in `answer`, on the click, `noopener`),
  `src/components/McpAppFrame.tsx` (chrome outside the frame, folded / inline / panel variants,
  the listener checks `event.source === iframe.contentWindow`), `AppRequestPrompt.tsx`. The state:
  `mcp.app` → `apps` → `message.apps`, the tool call tagged (`ToolCallView.app`, kept through
  `step.complete`); an app's consent request (`ApprovalView.app`) outlives `run.start` and
  `stopped`, and is NEVER mirrored onto a message; `useAgent` keeps its resolvers apart (a run
  ending does not answer them). `<AgentChat mcpApps appPanel …>`, `<AgentComposer draft>` (an
  accepted app message, never sent). The MCP hooks take `apps: true` and return `apps`
  (`mcpAppsRouter`, `./mcp` entry). **Security boundary**: every guard has a `guard …` test in
  `tests/apps.test.ts` AND in `e2e/apps.spec.ts` (the demo, a real MCP server with the test
  server's hostile "travel" app, counted endpoints for a declared and an undeclared origin), and a
  change needs a mutation check. Never add `allow-same-origin`, an `allow` attribute, or a method
  to the allow-list without its consent and a test.
- MCP Apps, what an app may ask for besides a tool call (each off by default; `<AgentChat
appFullscreen appDownloads appSampling>`, `useMcpAppHost({ downloads, sampling, sample })`,
  `<McpAppFrame allowFullscreen>`): the bridge offers `ui/download-file` / `sampling/createMessage`
  only with a handler (`MCP_APP_OPTIONAL_REQUESTS`; `hostCapabilities` says only what is on, never
  `sampling.tools`), and `ui/request-display-mode` grants `fullscreen` only to an app that declared
  it (`appDisplayModeAllowed`), right after the user acted in its frame (`appGestureOf`: the
  frame's element focused + `navigator.userActivation`), never while it waits for the user (it goes
  back inline then); no `pip`. Full screen is CSS on the same element (`awr-frame--fullscreen`,
  fixed over `.awr-chat` or the viewport; the iframe is never re-parented - that would reload it),
  a holder keeps its place, focus guards, Esc, Exit. Downloads: `appDownloadOf` (one file),
  `appFileNameOf`, `appDownloadRefusal` (programs, scripts, HTML / SVG / XML by name and type),
  `resolveAppDownload` (a link read through `connection.readResource`, its type judged again),
  `saveAppFile` (octet-stream blob, `<a download>` on the click). Sampling: the core's
  `Agent.sampleForApp` through `useAgent().sampleForApp`; the prompt, and "Always for this app"
  (until a reload), are `useMcpAppHost`'s; `appSamplingErrorOf` maps the core's codes; the
  reducer adds a `usage` of phase `'app'` to `totalUsage` only. Per server: `useMcpServers`
  `add({ apps })` (remembered; `servers[i].apps`), and the router refuses a server whose apps are
  off. Tests: `tests/apps-features.test.ts` (every guard) and `e2e/demo-server-app.spec.ts` /
  `e2e/apps.spec.ts`. Labels `appFullscreen*`, `appDownload*`, `appSampling*`.
- MCP Apps on an origin of their own (opt-in: `appSandbox` / `useMcpAppHost({ sandbox })`, the
  specification's sandbox proxy) - three files, two sides:
  - `src/mcp-app-policy.ts` - shared, pure, NO imports (a Worker bundles it): `mcpAppPolicy` (the
    app's CSP - `mcpAppCsp` is built on it, so the page's frame and the sandbox page cannot
    differ), the policy as a PATH segment (`mcpAppPolicyToken` / `mcpAppPolicyOfToken`: canonical,
    strict), the sandbox message names, and `mcpAppPolicyOrigin` - a COPY of the core's
    `mcpAppOrigin` (`tests/apps-sandbox.test.ts` holds them to the same lines and answers).
  - `src/mcp-app-sandbox.ts` - the **`./mcp-app-sandbox` entry**, for a SERVER: the page
    (`mcpAppSandboxPage`, `MCP_APP_SANDBOX_SCRIPT`: binds to the first ancestor on an allowed host
    that sends `sandbox-resource-ready`, once; writes the app into an `allow-scripts
    allow-same-origin` frame; relays to exact origins; ignores `sandbox` / `csp` / `permissions`),
    its headers (the app's policy + `frame-ancestors`), `parseMcpAppSandboxHosts` (exact origins,
    one-label `*` patterns), `mcpAppSandboxResponse` (Request → Response; 400 / 404 / 405 / 503).
    No React, no core, no import but the policy module - `tests/entries.test.ts` checks the entry
    and its chunks. `apps/app-sandbox` deploys it; the demo's Vite servers mount it.
  - `src/mcp-app.ts` (page side): `mcpAppSandboxTarget` (the URL: another origin than the page's,
    `https` or loopback `http`, `{server}` only in the host name and only a DNS label),
    `mcpAppSandboxProxyUrl`, `buildMcpAppSandboxShell` (ours, the page's origin, NO script,
    `frame-src` = the proxy's exact URL - the only thing that stops the app, same-origin with its
    proxy, navigating it to an undeclared origin), `McpAppSandboxLink` (source AND origin, posts to
    the sandbox origin only, one handshake; a second = the app reloaded its frame → stopped).
    `McpAppFrame` falls back to the opaque frame on a refused URL or a silent page (`timeoutMs`;
    1 s after the shell loaded), remembers a silent origin for the page's life, says which mode in
    its badge (`appSandboxed` / `appSandboxedOrigin`, `data-sandbox`). Labels `appSandbox*`.
  - Tests: `tests/apps-sandbox.test.ts` (every guard, the proxy's script under stand-in windows,
    the server) and `e2e/apps-sandbox.spec.ts` (the demo's sandbox page on the other loopback name;
    the hostile app's probes through its sandbox page, navigating and reloading it, forged
    messages, `frame-ancestors`, the fallback). `e2e/apps-shared.ts` is what both app specs share.
    Security boundary: each guard a test and a mutation check.
- `src/util.ts` — tiny shared helpers (`errMessage`).
- `src/styles.css` — optional theme (light + dark).
- `src/index.ts` — public surface (+ curated re-exports from the core).
- `tests/files.test.ts` — files of a turn: the reducer, the chips, and every guard of the sandboxed
  frame as a string check.
- `tests/state.test.ts`, `tests/chat.test.ts` — `node --test` over the reducer,
  composer helpers, labels and the history store (imports from `dist`). `tests/elicitation.test.ts`:
  the queue, the form helpers against the core's validator, the prompt as markup, and the queue as
  the core's `onElicitation` over real sockets (both revisions; off = no capability).
- `tests/pipeline-state.test.ts` (the pipeline reducer against event sequences recorded from the
  core's own runner with a scripted `runNode`: linear, fan-in, a capped loop, a failed node, an
  abort), `tests/pipeline.test.ts` (editing helpers, the code generator, labels, the components
  rendered to markup), `tests/canvas.test.ts` (the canvas maths and its markup).
- `e2e/` — Playwright over the built demo. `mcp.spec.ts`: MCP (several servers, the OAuth
  redirect round-trip, IndexedDB reuse, CORS — `servers.ts` starts a real MCP server + authorization
  server on loopback). `elicitation.spec.ts`: a server's questions in the demo's chat against
  `@dudko.dev/test-servers` (its `elicit_*` tools, both protocol revisions): accept / decline /
  cancel reach the server, validation blocks Submit, a link opens only on the click, an expired
  question (the page clock) is reported as answered automatically, typed values are nowhere after
  Submit. `demo-server.spec.ts`: "Try the demo server" - the site's own MCP server on the demo's
  origin (`vite preview` mounts the Worker's handler, `apps/demo/vite.config.ts`): it connects on
  2026-07-28, a plain tool's structured result reaches the model, `plan_trip`'s form is filled in
  and the answer is in the retried call and in the server's result, `open_docs`'s link is declined.
  `demo-server-app.spec.ts`: the same server's MCP App (`trip_board`'s board, `apps/worker`) in the
  demo - the model is never offered its two app-only tools, the board renders and grows, its
  read-only app tool runs without a prompt, its `book_trip` waits for consent (Deny sends nothing,
  Allow once sends one call), its link and message prompts, the phone sheet without sideways scroll.
  `agent.spec.ts`, `steering.spec.ts`, `learning.spec.ts`: the agent end to end
  (a run, typing to it while it works, the notebook and the fetched pages) against a scripted Gemini
  endpoint (`gemini.ts`, routed by the stage markers; it can script tool calls and the notebook's
  `save_skill`). `apps.spec.ts`: MCP Apps - the app in the demo's MCP tab, its consent prompts
  (tool call, link, message), the clamped height, the panel / sheet, and what a hostile app tries
  (the page, storage, an undeclared origin, navigation, the top window) against
  `@dudko.dev/test-servers` (`appTools`). `files.spec.ts`: files written in a turn - the chips in the demo, and the sandboxed HTML frame against hostile pages on a test-only page with scripts on (`fixtures/files-page.ts`). `helpers.spec.ts`: helpers the model starts (`spawn_subagent`) - the tree, Stop on a
  slow helper, a helper's consent prompt; a helper's calls are told from the run's by what they
  were given (a helper knows its task, never the user's goal). `defaults.spec.ts`: the demo's
  defaults (every capability on; the ones that need a key say which) and the settings migration
  of a returning visitor. `media.spec.ts` and `decision.spec.ts`: the media tools and the
  decision model, on by default with a Google key - `gemini.ts` also answers the speech / image
  models (a small WAV, a small PNG, a quota refusal, a request that gets no answer), the
  transcription model (`/interactions`) and the Decisions API (`/decisions`; unscripted, it is
  unsure, so the scripted replanner or route decides). A spec that needs a capability OFF
  switches it off in the panel: the demo's defaults are all on. `pipeline.spec.ts`: the pipeline editor at `/pipeline/` - mouse, keyboard, a real
  run against the scripted endpoint, a reload, a phone (touch pan and pinch through CDP).
  `enterprise.spec.ts` is the one spec that does NOT use the demo: enterprise-managed MCP
  authorization (ID-JAG) has no screen there and the hooks take no `authProvider`, so it drives the
  core on a test-only page (`fixtures/enterprise-page.ts`, bundled with esbuild and served on
  loopback by `page-server.ts` while the test runs - never built into the demo or the site) against
  `@dudko.dev/test-servers`. Keep test pages there; do not add hidden routes to the demo.
- `apps/demo/` (monorepo root) — the Vite + React demo (aliases the library to this package's `dist`).
  One Vite project, two pages: the demo (`index.html`, served at `/demo/`) and the pipeline editor
  (`pipeline/index.html`, `src/pipeline/`, served at `/pipeline/`). They share source - the model
  state (`use-model.ts`), `Settings`, `McpPanel`, `models.ts`, `cloud.ts` - and one origin, so the
  key vault, the chosen model and the MCP server list are the same on both. Change the shared
  modules with both pages in mind.

## Commands

```bash
pnpm nx typecheck @dudko.dev/agent-web-react     # tsc --noEmit (nx builds the core first)
pnpm nx format:check @dudko.dev/agent-web-react  # prettier
pnpm nx build @dudko.dev/agent-web-react         # tsup → dist (ESM + CJS + d.ts) + copy styles.css, pipeline.css
pnpm nx test @dudko.dev/agent-web-react          # node --test tests/*.test.ts (nx builds first)
pnpm nx test:e2e @dudko.dev/agent-web-react      # playwright over the built demo (browser flows)

# demo
pnpm nx build @dudko.dev/agent-web-react && pnpm --filter demo dev   # local dev
pnpm nx run-many -t typecheck build -p demo
```

CI (`.github/workflows/ci.yml`) runs the library job (typecheck → format:check →
build → test), then a demo job (build lib → build demo) and a browser job
(Playwright over the built demo). Release (`release.yml`)
publishes to npm via Trusted Publishing after CI passes on `main`. Pages
(`deploy-demo.yml`) builds and deploys the demo. Keep all green before pushing.

## Conventions

- Prettier: no semicolons, single quotes, trailing commas, width 100.
- Intra-package imports use `.js` specifiers (tsup/esbuild resolve them to
  `.ts`/`.tsx`), matching the core package.
- The **demo** uses extensionless imports (Vite) and consumes the built
  library from `../dist` via a Vite alias + a tsconfig `paths` mapping — so
  build the library before building the demo.
- Keep the event→UI logic in the reducer, not the components. New event fields
  from the core map to new `AgentUiState` fields + a reducer case + a test.
- Every user-visible string goes through `labels` (add it to `AgentLabels` and
  `defaultLabels`); every new part of a component gets a `show*` prop or a
  render prop / slot — hosts must be able to hide, relabel or replace it.
- The pipeline editor follows the same rules with its own names: strings through `PipelineLabels`
  (`src/pipeline/labels.tsx`), docs in `docs/pipeline.md` (a page of the site: it is in
  `apps/site/scripts/sync-docs.mjs` and the sidebar), event → state logic in `pipelineStateReducer`.
  The core's pipeline API is imported statically from `@dudko.dev/agent-web`, as `use-agent` imports
  `createAgent` - it is in the core's main entry and has no optional peer behind it.
- Docs live next to the code (the README goes to npm; `docs/*.md` are published on the site, not in the npm package): a new prop, hook field, exported type or label goes in the README
  (hook table / components table) and `docs/chat.md`. `tests/chat.test.ts` fails when a label key is not
  listed in `docs/chat.md`'s label reference.
- Don't import model providers, `ai`, or `zod` at runtime here — the core owns
  them. Type-only imports from `@dudko.dev/agent-web` are fine.
