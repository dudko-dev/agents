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
- `src/chat-history.ts` — `ChatHistoryStore` (raw IndexedDB, memory fallback).
- `src/composer.ts` — the composer's pure helpers (slash commands, attachment
  kinds/refusals, notices); `src/image-resize.ts` — `downscaleImage`.
- `src/labels.tsx` — every UI string (`defaultLabels`, `AgentLabelsProvider`,
  `useLabels`); components take `labels` overrides.
- MCP elicitation: STATE ONLY so far. The reducer folds the core's `mcp.elicitation-requested` /
  `mcp.elicitation-answered` into `AgentUiState.elicitations` (`ElicitationView`; optional - absent
  until a server asks, so a state without the feature is what it was; a subagent's question
  surfaces on the run; `stopped` cancels the pending ones). It is deliberately NOT mirrored onto
  the run's `ChatMessage` (a saved conversation must not hold a server's form) and never holds an
  answer. `src/mcp-types.ts` has the structural request / result / handler / options types. No
  hook passes `onElicitation` yet and there is no component: that is the next step (a prompt
  beside `ToolApprovalPrompt`, labels, `docs/chat.md`).
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
  `ToolApprovalPrompt`, `ApprovalModeSwitch`, `ChatHistoryList`, `FilesPanel`, `LearnedSkills`
  (the agent's notebook: `learned` in the state belongs to the agent, not the conversation),
  `SubagentTree` (+ `SubagentRow`: `subagents` in the state is a flat list that IS a tree -
  `parentId` / `depth`, nested by `subagentTree`; nested `subagent.event` envelopes are unwrapped in
  the reducer, and a helper's consent request is lifted from them), `Media` (`GeneratedMedia`: a
  generated file read from the VFS into an object URL, only the core's media types, never SVG;
  `TranscriptBlock`),
  `ContextMeter`, `Composer` (minimal), `PlanView`, `ModelLoadBar`,
  `UsageBadge`, `ApiKeyForm`, `icons`, `format`. Docs: `docs/chat.md`.
- `apps/demo/src/components/McpPanel.tsx` (monorepo root) — the demo's "bring your own MCP" panel.
- `src/util.ts` — tiny shared helpers (`errMessage`).
- `src/styles.css` — optional theme (light + dark).
- `src/index.ts` — public surface (+ curated re-exports from the core).
- `tests/state.test.ts`, `tests/chat.test.ts` — `node --test` over the reducer,
  composer helpers, labels and the history store (imports from `dist`).
- `tests/pipeline-state.test.ts` (the pipeline reducer against event sequences recorded from the
  core's own runner with a scripted `runNode`: linear, fan-in, a capped loop, a failed node, an
  abort), `tests/pipeline.test.ts` (editing helpers, the code generator, labels, the components
  rendered to markup), `tests/canvas.test.ts` (the canvas maths and its markup).
- `e2e/` — Playwright over the built demo. `mcp.spec.ts`: MCP (several servers, the OAuth
  redirect round-trip, IndexedDB reuse, CORS — `servers.ts` starts a real MCP server + authorization
  server on loopback). `agent.spec.ts`, `steering.spec.ts`, `learning.spec.ts`: the agent end to end
  (a run, typing to it while it works, the notebook and the fetched pages) against a scripted Gemini
  endpoint (`gemini.ts`, routed by the stage markers; it can script tool calls and the notebook's
  `save_skill`). `helpers.spec.ts`: helpers the model starts (`spawn_subagent`) - the tree, Stop on a
  slow helper, a helper's consent prompt; a helper's calls are told from the run's by what they
  were given (a helper knows its task, never the user's goal). `pipeline.spec.ts`: the pipeline editor at `/pipeline/` - mouse, keyboard, a real
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
