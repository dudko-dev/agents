# agent-web-react — demo

A Vite + React app showcasing [`@dudko.dev/agent-web-react`](../): an in-browser
LLM agent driving tools. Pick a cloud model (bring your own key, stored
encrypted) or an on-device one — everything runs in the browser.

**Models** (October 2026): Gemini (3.8 Flash, 3.5 Flash-Lite, 3.1 Pro), Claude
(Haiku 4.5, Sonnet 5.5, Opus 5.5, Fable 5.1), GPT-6 (Luna, Sol, Astra), Kimi
(K2.6, K3), Groq and Cerebras for speed (GPT-OSS, Qwen3.8 with images), Mistral
(Small 4, Medium 3.5) and OpenRouter (type any model id). Every one of them
answers a page directly with your key (CORS). On the device: WebLLM (Gemma 3 1B,
Llama 3.2 1B/3B, Qwen3.5 0.8B–9B, Ministral 3 3B, Phi-4 mini, Llama 3.1 8B and
Phi-3.5 Vision for images), Chrome's built-in Gemini Nano (no download), and
transformers.js (SmolVLM 256M and Gemma 4 E2B, images). Each provider and
runtime is fetched the first time you pick one of its models.

A second page, the **pipeline editor** (`pipeline/index.html`, `src/pipeline/`), is built by the
same project and served at `/pipeline/`: a graph of agents drawn on a canvas
(`@dudko.dev/agent-web-react/pipeline`), run in the browser. It imports the demo's own modules
for the model list, the key entry, the MCP panel and the model state (`src/use-model.ts`), and it
is the same origin - so a key saved on one page, the chosen model and the connected MCP servers
are there on the other.

Three tabs, sharing one "Agent settings" panel:

- **Sticky notes** — the agent edits a board through locally defined tools.
  Attach files (the "+" button, Ctrl+V for images, or drop them anywhere on the
  page): images go to vision models, PDFs to models that read them — and are
  converted to Markdown in the browser with
  [`@dudko.dev/pdf-to-md-core`](https://www.npmjs.com/package/@dudko.dev/pdf-to-md-core)
  for the ones that don't. Attachments land in a workspace (a virtual file
  system in IndexedDB) the agent reads and writes with its `fs_*` tools.
- **MCP servers** — connect **any number** of remote MCP endpoints; their tools
  merge into one agent (`<server>__<tool>`). Auth per server is none, a bearer
  token, or **OAuth 2.1 + dynamic client registration**: the app registers
  itself, runs PKCE, keeps the tokens encrypted in IndexedDB and refreshes them.
  The list is remembered and reconnects on load. Tick the **mock catalogue** to
  add 185 tools on six pretend servers and watch the agent switch to **tool
  search** (a compact catalogue + `find_tools`) instead of sending every schema.
  Each server must send CORS headers for this origin (including
  `Access-Control-Expose-Headers: WWW-Authenticate, mcp-session-id`).
  No server of your own? **Try the demo server** adds the site's own one,
  `<this origin>/mcp/demo` (a Cloudflare Worker, [`apps/worker`](../worker/); same origin, so no
  CORS): `echo`, `current_time`, `roll_dice` (structured content), two tools that ask *you*
  something in the middle of the call — `plan_trip` (a form) and `open_docs` (a link) — and
  `trip_board`, which comes with an **MCP App**: a trip board drawn in the chat, in a sandboxed
  frame. The board calls its server's two tools for apps only (the model never sees them):
  "Other ideas" for a day runs at once (`reshuffle_day`, read-only), "Book this trip" waits for
  your OK in the chat (`book_trip`, a pretend booking that returns a code computed from the trip),
  and it asks to open the docs and to put the plan in your message box. It is connected with the
  protocol on "Auto": its questions need the 2026-07-28 revision (the board works on both).
  A server's **MCP Apps** are drawn in the chat, on an origin of their own: the sandbox page of
  `@dudko.dev/agent-web-react/mcp-app-sandbox` at `https://agent-demo-apps.dudko.workers.dev/sandbox/v1`
  (a second Worker, [`apps/app-sandbox`](../app-sandbox/); `src/app-sandbox.ts`). The frame says
  "sandboxed on its own origin"; when that page does not answer, it falls back to the opaque frame
  and says "sandboxed".
- **Chess vs agent** — you play White; **your move is the trigger**: the agent
  reads the position with `get_position`, weighs candidates (`evaluate_moves`,
  or analyst **subagents** — each in its own **Web Worker**, or in-process),
  and plays with `make_move`. No chat message needed. The rules, not the
  model, decide the outcome: a mate, stalemate or draw ends the game on the
  spot (a mating move is never answered), and a turn the agent ends without
  moving — an API error, a spent quota, a stop — is shown as such, with the
  board locked until it moves (Retry, or the built-in engine).

The **Agent settings** panel drives the core's features live: tool consent
(⚡ autopilot / ask before changes / ask everything / read-only), thinking
level ("none" turns a local Qwen's thinking off), token / tool-call / step limits, context window and auto-compaction,
skills (each tab lists its own built-in examples; your own or imported
`SKILL.md` ones apply to every tab), the chess analysts — and the **chat UI**: tool calls, token usage, saved chats
(IndexedDB), the files panel, theme, and the labels (English / Spanish / German — every
string of the chat is a prop).

**Every capability is on by default** - the demo shows the most the library can do, which is
not the library's own default (there each of these is off until the host switches it on): the
notebook (`learning`), web access (`web_fetch`, limited to the listed hosts), running code
(`run_js`, sandboxed), helpers (`spawn_subagent`), auto-compaction and every part of the chat.
Four more are **on when possible** - the switch is on, and the panel says whether it is in
effect and what is missing:

| Capability | In effect when | Otherwise the panel says |
| --- | --- | --- |
| Model tiers (`auto`) | the chosen model's provider has a lighter / a stronger model in the list (same key) | `off: no lighter model of this provider` |
| Web search (`web_search`) | a Tavily key is saved (the form is in the panel) | `off: needs a Tavily key` |
| Media (`generate_image`, `generate_speech`, `transcribe_audio`, attached audio) | a Google or an OpenAI key is saved | `off: needs a Google or OpenAI key` |
| The decision model (`gemini-decision-1`) | a Google key is saved | `off: needs a Google key` |

Tool consent is not changed by any of this: it is the mode you chose (autopilot unless you
changed it), and the panel's first lines say what the agent may do on its own under it. Media
calls are billed by the provider to your key; Google's image models have no free quota, so on a
free-tier key `generate_image` answers with Google's quota error, shown under the tool call.
The models are built in the app from the vault's key (`src/use-extras.ts`), like the chat
models: the core's own `{ providerType, model, credentialRef }` spec imports the provider by a
bare specifier, which a bundle cannot resolve.

Settings are stored in `localStorage` as `{ v: 2, set }`: only what you changed. Everything
else follows the defaults of the day, so new defaults reach a returning visitor. Settings stored
before that (the whole object) are read once: a field that differs from the default of that
time is your choice and is kept; a field equal to it follows the new default. **Reset settings**
forgets every choice.

On the pipeline page the loop settings, the model tiers and the decision model (it picks a
node's route) apply to every node; web, code, helpers, search and media go to the nodes that
tick them in the inspector.

The chat itself shows every tool call with its cost, tokens by kind per answer
and in total, thoughts, subagents and consent prompts; the composer has
attachments, "/" commands, a run timer, the running-agents count, the model +
thinking chip, the consent chip and a speech-to-text mic.

For quick answers: a fast provider (Groq, Cerebras, Flash-Lite), a small local
model with Thinking "none", and **Fast answers** in the agent settings (no
replanner, no separate final answer: 2 model calls per turn instead of 3+).

Local models: pick one and press "Download & load". Switching to another one
shows it as not loaded (the loaded one stays in memory, so switching back is
instant); loading it frees the previous model's GPU memory first, and
"Unload" frees it on demand. Each is loaded with its own context window —
WebLLM's default is 4096 tokens; Qwen3.5 0.8B/2B get 32k, 4B/9B 16k, Llama 3.2
1B 16k, the rest 8k (each note says the VRAM it takes) — and the agent
fits its runs into it: compaction, tool lists and tool results are sized from
the window ("Window: auto"). **Phi-3.5 Vision** is a local multimodal model:
paste or drop an image and ask about it.

**Live:** https://agent.dudko.dev/demo/

## Run locally

```bash
# from the monorepo root — build the library the demo consumes, then run the demo
pnpm install
pnpm nx build @dudko.dev/agent-web-react
pnpm --filter demo dev
```

The demo aliases `@dudko.dev/agent-web-react` to the built `packages/agent-web-react/dist` (see
[`vite.config.ts`](vite.config.ts)), so rebuild the library after editing its source.

There is no Worker behind `vite dev` and `vite preview`: both serve `/mcp/demo` themselves, with the
Worker's own handler running on Node (`demoMcpServer` in `vite.config.ts`, from
`apps/worker/src/node.ts`), so "Try the demo server" works locally and in the browser tests.
The MCP Apps sandbox page is served by them too (`appSandbox` in `vite.config.ts`, the React
package's own handler), under the OTHER loopback name on the same port: a demo opened on
`http://127.0.0.1:5173` runs its apps on `http://localhost:5173`, and the other way round - another
origin and another site, so the browser tests go through the real cross-origin path. (`vite dev`
listens on `localhost`; where that is IPv6 only, `127.0.0.1` does not answer and apps fall back to
the opaque frame - open the demo on the name the server listens on, or pass `--host 127.0.0.1`.)

## Deployment

Cloudflare builds and serves it (Workers static assets, the root `wrangler.jsonc`; the one
Worker script there answers `/mcp/*` only - the demo MCP server; the apps' sandbox page is a
separate Worker on `agent-demo-apps.dudko.workers.dev`, [`apps/app-sandbox`](../app-sandbox/), deployed by a project
of its own): every push to
`main` that touches the demo or the browser packages is built with `pnpm nx build demo` and
deployed; pull requests get a preview. The Vite `base` is `/demo/` — the build lands in
`dist/demo`, with a `dist/_redirects` that sends the site's root there until the documentation
site takes it. Set `DEMO_BASE=/` to build the demo for the root of a host instead.
