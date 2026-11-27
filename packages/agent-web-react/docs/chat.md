# The chat panel

`<AgentChat>` is the drop-in UI: a transcript where every answer keeps its own
activity, a composer with everything around the input, and optional side
panels for saved chats and the agent's workspace. Every part can be switched
off, relabelled, rendered by you, or swapped for your own component — and
everything it does is also available as hooks and pure helpers for a fully
custom UI.

```tsx
import {
  AgentChat,
  ChatHistoryStore,
  VirtualFileSystem,
  createFileTools,
  useAgent,
} from '@dudko.dev/agent-web-react'
import '@dudko.dev/agent-web-react/styles.css'

const files = new VirtualFileSystem({ namespace: 'my-app' }) // IndexedDB
const history = new ChatHistoryStore()                        // IndexedDB

function Assistant() {
  const agent = useAgent({
    model,
    tools: { ...myTools, ...createFileTools(files) }, // the agent can use the workspace too
    memory: new IndexedDBStore(),                     // a reopened chat keeps its context
    toolApproval: { mode: 'ask-writes' },
  })
  return (
    <AgentChat
      controller={agent}
      title="Assistant"
      history={history}
      files={files}
      composer={{
        model: { label: 'Gemini 3.5 Flash', options: models, value, onSelect },
        thinking: { value: level, onChange: setLevel },
        convertFile: pdfToMarkdown, // PDFs the model can't read become Markdown
        dropZone: 'window',
      }}
      style={{ height: 640 }}
    />
  )
}
```

## Contents

- [Transcript](#transcript)
- [Composer](#composer)
- [Talking to the agent while it works](#talking-to-the-agent-while-it-works)
- [Subagents and helpers: the tree](#subagents-and-helpers-the-tree)
- [Generated media and transcripts](#generated-media-and-transcripts)
- [Files written in a turn: chips, previews, the HTML frame](#files-written-in-a-turn-chips-previews-the-html-frame)
- [The decision model's note](#the-decision-models-note)
- [Web search results](#web-search-results)
- [The agent's notebook, and what it fetched](#the-agents-notebook-and-what-it-fetched)
- [Attachments: images, PDFs, files, URLs](#attachments-images-pdfs-files-urls)
- [Saved chats (IndexedDB)](#saved-chats-indexeddb)
- [Workspace (virtual file system)](#workspace-virtual-file-system)
- [Tool consent](#tool-consent)
- [Customising: show/hide, labels, render props, slots, components, theme](#customising)
- [Hooks and helpers for your own UI](#hooks-and-helpers-for-your-own-ui)
- [Label reference](#label-reference)

## Transcript

Each assistant message keeps **its own** activity after the next run starts —
the reducer mirrors the run onto the message:

- a collapsible summary ("2 steps · 3 tool calls · skills: …"), open while the
  answer is being produced;
- every step with its streamed text and thoughts;
- **every tool call** — name, arguments, status, ≈tokens of its arguments and
  of the result fed back to the model, its duration, and any images it
  returned (data URLs or `{ type: 'image' }` parts are shown as thumbnails);
- consent decisions and the [subagent tree](#subagents-and-helpers-the-tree) under the step that
  made them;
- what the run generated - images inline, audio as a player
  ([media](#generated-media-and-transcripts));
- the answer's thoughts (when the model thinks);
- a usage line with **tokens by kind**: `in 12k · out 456 · think 120 · cached 9k · 4.2 s`.

User messages show their text and attachments: image thumbnails (click to open
full size) and file chips. The header shows the conversation's total.

| Prop | Default | |
| --- | --- | --- |
| `showActivity` | `true` | the per-answer activity block |
| `showToolCalls` | `true` | each tool call inside it |
| `showUsage` | `true` | per-answer and per-tool-call tokens |
| `showTotalUsage` | `true` | the conversation total in the header |
| `showThoughts` | `true` | step and answer thoughts |
| `showSubagents` | `true` | the [subagent tree](#subagents-and-helpers-the-tree) under a step |
| `showMedia` | `true` | generated images / audio and transcripts in an answer |
| `showFileChips` | `true` | the [files an answer wrote](#files-written-in-a-turn-chips-previews-the-html-frame), as chips under it |
| `htmlPreview` | `{}` | how a written `.html` file is previewed: `{ scripts?: boolean, height?: number }`, or `false` for source only |
| `showDecisions` | `true` | the decision model's note under a step |
| `showSearchResults` | `true` | a `web_search` call's results under its row |
| `showStatus` | `true` | the status dot in the header |
| `showContext` | `false` | context meter above the composer (`number` = budget bar) |
| `activityOpen` | `false` | keep finished answers' activity expanded |
| `emptyState` | `labels.emptyState` | what the transcript shows before the first message (any node) |
| `defaultHistoryOpen` | wide panel: yes · narrow: no | whether the saved-chats sidebar starts open |
| `defaultFilesOpen` | `false` | whether the Files panel starts open |
| `narrowWidth` | `760` | below this width (px) the side panels overlay the chat |

## Composer

`<AgentComposer>` (the footer of `<AgentChat>`, usable on its own):

- **notices** above the input: a limit that stopped the run, a compaction, a
  start failure, an attachment the model can't take, a microphone error —
  dismissible;
- **"+"**, **Ctrl+V** and **drag & drop** for files and images;
- **"/" commands**: `/compact`, `/new`, `/stop`, `/autopilot`, `/ask`,
  `/ask-all`, `/read-only`, `/think <level>`, and every skill as
  `/skill-name <goal>`; add your own with `commands`;
- **run timer**, **running subagents** ("2 agents"), the **model + thinking**
  chip (with a switcher), the **consent-mode** chip ("⚡ Auto"), a **mic**
  (speech to text with the browser's Web Speech API) and send / stop.

| Prop | |
| --- | --- |
| `model` | `{ label, options?, value?, onSelect? }` — chip and switcher |
| `thinking` | `{ value, options?, onChange }` — shown next to the model; default levels `off` (the provider's default), `none` (thinking off), `low`, `medium`, `high` |
| `commands` / `builtinCommands` / `skillCommands` | slash commands |
| `attachments` | `false`, or `{ accept, maxBytes, imageMaxDimension, imageMaxPixels }` |
| `convertFile` / `convert` | file → text (e.g. PDF → Markdown), `'when-needed'` or `'always'` |
| `files` | save attachments into a `VirtualFileSystem` under `/attachments/` |
| `dropZone` | `'self'` (default), `'window'`, or a ref (`<AgentChat>` passes its panel) |
| `speech` | `false`, or `{ lang }` |
| `steering` / `showQueued` | typing to the agent while it works; the queue strips ([below](#talking-to-the-agent-while-it-works)) |
| `showTimer` / `showAgents` / `showApprovalMode` / `showNotices` | toolbar parts |
| `toolbarExtra` / `toolbarEnd` | your own toolbar content |
| `compactWidth` | below this width (px) the toolbar chips show icons and numbers only (default 460) |
| `renderAttachment` | render a pending attachment chip yourself |
| `labels`, `placeholder`, `disabled`, `className` | |

Speech to text uses `SpeechRecognition` / `webkitSpeechRecognition` (Chrome,
Edge, Safari). In Chrome the audio is recognised by Google's service; the mic
button only appears where the API exists.

## Talking to the agent while it works

The input stays live during a run. Text typed then is **said to the running agent** (the
send button, or Enter): it is shown to the model at the next boundary — between tool
calls, or when the step ends, where the replanner re-checks the plan against it. It never
cuts a tool call short. Needs `@dudko.dev/agent-web` with `createRunControl` (see the
core's [steering docs](https://github.com/dudko-dev/agents/blob/main/packages/agent-web/docs/capabilities.md)).

What the user sees:

- a message waiting for a boundary shows above the input as **queued** ("waiting for the
  agent's next step");
- once the agent has it, the queue entry becomes a **note** under the step it reached —
  "you said, between tool calls" / "after this step" / "before the answer". It is a note
  on that run, not a new turn, and it is saved with the chat;
- a message that arrives too late for the run (while the answer is being written) is
  **sent as the next message** when the run ends (`followUp`, default on);
- **Stop** does not send behind the user's back: whatever the run never showed the agent
  is offered above the input — "Not delivered (1 message)" with **Send now** / **Discard**;
- every running **subagent** gets a stop button (and shows its profile, when the parent
  chose one). Stopping one fails only that delegation — the parent model is told and
  routes around it; the run and its siblings go on. It then shows as "stopped".
- files cannot join a run that is going (they are sent with the next message) — the
  composer says so instead of dropping them.

```tsx
const agent = useAgent(config)
agent.send('use the staging database') // false: no run in flight (or empty) — use run()
agent.stopSubagent(agent.subagents.find((s) => s.status === 'running')!.id)
agent.queued // [{ id, text }] — sent, not yet shown to the model
agent.notes // [{ id, text, at: 'round' | 'step' | 'final', stepId? }] — shown, and where
agent.undelivered // string[] — a stopped run's leftovers; sendUndelivered() / discardUndelivered()
```

| Prop / option | |
| --- | --- |
| `steering` (composer, default true) | off: the input does nothing during a run, as before |
| `showQueued` (composer, default true) | the queue and "not delivered" strips |
| `showNotes` (chat / message list / step list, default true) | the notes under the steps |
| `stoppableSubagents` (chat, default true) | the stop button on running subagents |
| `followUp` (`useAgent` option, default true) | send what a run never showed the agent as the next message |
| `onStopSubagent` (message list / step list) | wire your own stop button (`useAgent().stopSubagent`) |

Labels: `placeholderBusy`, `steer`, `noAttachmentsWhileBusy`, `queuedWaiting`, `noteAt`,
`undelivered`, `sendUndelivered`, `discardUndelivered`, `stopSubagent`, `subagentStopped`.
A replan caused by a message has `replan.byUser === true`.

## Model tiers, escalation and a replanner that failed

With `executorTiers` in the agent's config (core: a `light` and / or a `strong` executor model next
to the agent's own) each step runs on the model the planner rated it for, and a step that fails in
a way a stronger model could fix is retried on the next stronger one. The UI follows it:

- **A step** carries a quiet badge with its tier and model id (the badge's tooltip says why the
  step started there: planned, the default, or a fallback).
- **An escalation** is a line under the step - "Escalated: light → strong (reported a blocker)" -
  with what the failed attempt had written folded beneath it. The step's own text is the current
  attempt's only: the two are never joined.
- **Tool calls** of the attempt that was escalated stay in the step (they happened, and the
  stronger model continues from them), dimmed and tagged "attempt 1". A write the stronger model
  repeated and the core did not run a second time is tagged "not run again".
- **The summary** of the turn counts the escalations ("2 steps · 3 tool calls · 1 escalation").

Without tiers the core sends none of this and the UI is exactly what it was. `showTiers={false}`
(chat / message list / step list / tool call row) hides all of it.

**A replanner that failed** (the provider was down, or its answer did not parse) does not fail the
run: the core carries on with the plan it has. The step it ran after shows a warning -
"Replanning failed, continuing with the plan" (the provider's error is its tooltip) - and nothing
is put in `error`. `showReplanFailed={false}` (chat / message list / step list) hides it.

```ts
step.tier // 'light' | 'standard' | 'strong' - where the step is now (undefined: tiers off)
step.model // that tier's model id
step.tierReason // 'planned' | 'default' | 'fallback' - why it STARTED where it did
step.escalations // [{ from, to, reason, model?, text? }] - text: what the failed attempt wrote
step.toolCalls[i].attempt // 1, 2, … on a call of an escalated attempt; none on the current one
step.toolCalls[i].replayed // true: not run again, answered from the earlier attempt
step.replanFailed // the replanner's error, when the call after this step failed
agent.replan // { mode, reason, byUser?, failed?, error? }
```

Labels: `tierNames`, `tierReasons`, `escalationReasons`, `escalated`, `escalatedAttemptText`,
`escalations`, `attemptTag`, `replayed`, `replayedTitle`, `replanFailed`.

## Subagents and helpers: the tree

A run can delegate: to a subagent the host defined (`createSubagentTool`, in-process or a Web
Worker) and, with `subagents: { dynamic: true }` in the agent's config, to **helpers the model
starts itself** (`spawn_subagent`) - which can start helpers of their own when `maxDepth` allows.
All of them are nodes of **one tree**, and the state holds it:

```ts
agent.subagents // SubagentView[] - every node of the run, at every depth, in start order
// each: { id, parentId?, depth, name, task, dynamic?, role?, tools?, profile?,
//         status: 'running' | 'done' | 'error' | 'stopped',
//         model?, tier?, usage, toolCalls, steps, activity, text, error?,
//         startedAt?, durationMs?, stepId? }
subagentTree(agent.subagents) // SubagentNode[] - the same nodes nested: { ...view, children }
```

- `parentId` is the subagent that started the node; the run's own subagents (depth 1) have none.
  The reducer reads it from the events alone: a subagent's own subagents arrive as nested
  `subagent.event` envelopes, and each level lands on its own node.
- `dynamic` marks a helper the model started; `role` is what the model wrote for it (model-written
  text - the components show it as plain text) and `tools` the tool names it was given.
- `usage` is everything spent **under** the node, its own helpers included: counted live from its
  `usage` events, then replaced by the total its end reports. `toolCalls` / `steps` are its own.
- `model` / `tier` are known when the child runs with model tiers (its steps say them).
- `startedAt` / `durationMs` need the hook's timestamps (it stamps every event).
- Events for an id whose start was never seen still give a node (with an empty `task`); a start
  that arrives late fills it in; a node whose parent is unknown is drawn at the top.
- Each assistant message keeps its own tree (`message.subagents`).

`<SubagentTree subagents onStop />` draws it as an indented list - under the step that delegated,
in `<AgentChat>` / `<MessageList>` / `<StepList>`. Each node shows who it is (a helper's role, a
static subagent's name and profile), its task, a status line - **status, model, tier, tokens, tool
calls, time** - what it is doing now (or its answer, or its error), the tools a helper was given,
and, while it runs, a **Stop** button (`useAgent().stopSubagent(id)`: only that node stops, its
parent is told and goes on). It wraps at phone width.

| Prop | |
| --- | --- |
| `subagents` | the flat list (`agent.subagents`, a message's) |
| `onStop` | a stop button on each running node |
| `showUsage` (default true) | the status line |
| `showTools` (default true) | the tools each helper was given |
| `renderSubagent(node, fallback)` | draw a node yourself (`node.children` are its subagents; return an `<li>`) |
| `labels`, `className` | |

`showSubagents={false}` (chat / message list / step list) hides the tree; `renderSubagent` is on all
three too. `<SubagentRow sub />` is one node on its own.

**A helper's consent request.** A helper asks through the run's own consent gate, so its request
is the user's to answer: it appears in `pendingApprovals` like any other, with
`subagent: { id, depth, name?, role? }`, and `<ToolApprovalPrompt>` says who is asking - "The
helper “researcher” wants to run …" (`showHelper={false}` shows the ordinary lead). A subagent
with a consent gate of its own is its host's business and is not lifted.

Without subagents the state and the markup are exactly what they were.

Labels: `subagentHelper`, `subagentStatus`, `subagentTokens`, `subagentTools`, `subagentNoTools`,
`approvalLeadHelper`, and `stopSubagent` / `subagentStopped` from the steering set.

## Generated media and transcripts

With `media` in the agent's config (core: an image, a speech and / or a transcription model) the
run can write files and transcribe audio. The bytes are **never in the state**: a generated file
is in the workspace (`VirtualFileSystem`) at its `path`.

```ts
agent.media // MediaView[] | undefined - { kind: 'image' | 'speech', path, mediaType, bytes, model, stepId? }
agent.transcripts // TranscriptView[] | undefined - { source, name, text, language?, durationInSeconds?, model }
message.media / message.transcripts // the same, kept on each assistant turn
step.media // the files that step's tool calls wrote
```

`<AgentChat files={vfs}>` shows them in the answer:

- **an image** inline (click to open it), **audio** as a native `<audio controls>` player. The
  file is read from `files` into an object URL that is revoked when the message goes away. Only
  the types the core generates are rendered (PNG, JPEG, GIF, WebP; its audio list) - anything
  else, **SVG included**, a file that is gone, or no `files` at all is a chip with the path;
- **a transcript** as a folded "Transcript of memo.mp3" block, marked as what was said in the
  user's file: it is content, shown as plain text, never as markup.

`showMedia={false}` (chat / message list) hides both; `renderMedia(media, message, fallback)` draws
a file yourself. `<GeneratedMedia media files />` and `<TranscriptBlock transcript />` are the
parts on their own; `mediaFamilyOf(mediaType)` says `'image'`, `'audio'` or `undefined`.

**Usage.** A media call is not a token: `usage.mediaCalls` (and `imagesGenerated`,
`speechCharacters`, `transcriptionSeconds`) and `usage.decisionCalls` are carried through the
run's, the turn's and the conversation's usage, and `<UsageBadge>` shows "· 2 media calls · 1
decision call" when there were some (`showCalls={false}` hides them).

Labels: `mediaImage`, `mediaAudio`, `mediaFile`, `transcriptOf`, `transcriptNote`, `usageMedia`,
`usageDecisions`.

## Files written in a turn: chips, previews, the HTML frame

When the agent writes files (`createFileTools(files)`: `fs_write`; or `fs.writeFile` from the
sandbox), the answer shows them as **chips** under its text: name, kind, size, **open** and
**download**. Which files belong to a turn comes from the core's `file.written` / `file.deleted`
events, folded by the reducer:

```ts
agent.writtenFiles // WrittenFileView[] | undefined - { path, mediaType, bytes, writes, stepId?, by? }
message.writtenFiles // the same, kept on each assistant turn (and in a saved chat)
```

- a file written several times is **one chip** (`writes` counts them, the size is the last one);
- a file **deleted later in the turn has no chip**;
- a file a **subagent** or a helper wrote belongs to the parent's turn and says who wrote it
  (`by: { id, name, role? }`, shown as "by researcher");
- what the user uploads, an attachment, and a generated image (`media`, above) are not here:
  these are the files the run WROTE with the file tools.

The content is never in the state. A chip reads the file from `files` when it is opened; a file
that has since left the workspace keeps its chip, marked "no longer in the workspace", with
nothing to open. Without `files` the chips only name the files.

**Open** shows the file right there, one at a time:

- **text, Markdown, CSV, JSON, code** as source with line numbers - always text nodes, never
  markup. The first `previewChars` (20 000) characters; a longer file says it was cut. A long
  preview is folded with "Show the rest". Give `renderFileContent(file, text)` and a file you
  return something for gets a **Rendered / Source** switch - that is where your Markdown renderer
  goes (the package ships none); return `undefined` for the rest;
- **a picture** (PNG, JPEG, GIF, WebP - the types the core writes; **never SVG**, which is shown
  as its source) inline, and as the chip's thumbnail;
- **an `.html` file** in a sandboxed frame with a **Preview / Source** switch - see below;
- anything else (a PDF, a binary) has no preview, only the download.

```tsx
<AgentChat
  files={vfs}
  showFileChips            // default true
  htmlPreview={{ scripts: false }} // the default; { scripts: true } | false
  renderFileContent={(file, text) =>
    /\.md$/i.test(file.path) ? <Markdown text={text} /> : undefined}
  renderFile={(file, message, fallback) => fallback} // a whole chip
/>
```

`<FileChips written files />` is the part on its own (`showHeader`, `onShowFiles` for the "Show in
Files" link - `<AgentChat>` wires it to its Files panel -, `htmlPreview`, `renderFile`,
`renderFileContent`, `previewChars`, `defaultOpen`); `<FileChip>` is one chip, `<SourceView text
html? />` the numbered source, `fileKindOf(path, mediaType)` says `'html' | 'markdown' | 'csv' |
'json' | 'image' | 'code' | 'text' | 'file'`.

### The HTML preview is a security boundary

A page the agent wrote is **untrusted content**: the model may have been told what to write by a
web page it read, and your page's origin holds the key vault. So the preview never puts the file
into your document and never opens it by URL. `<SandboxedFrame>` draws it, and every line of the
following is a guard with a test (`tests/files.test.ts`, and in a real browser
`e2e/files.spec.ts`):

- **Sandbox, opaque origin.** `<iframe sandbox>` with `""` or `"allow-scripts"` - never
  `allow-same-origin`. The page cannot read your DOM, `localStorage`, `sessionStorage`, cookies or
  IndexedDB. No `allow-top-navigation` (it cannot navigate your tab; `<a target=_top>` does
  nothing), no `allow-popups` (`window.open` and `target=_blank` give nothing), no `allow-forms`,
  `allow-modals`, `allow-downloads`.
- **By `srcdoc`, not by URL.** A `blob:` URL made by your page carries your origin: opened
  outside the frame (a new tab) the same document would run as your application. `srcdoc` has no
  address to open. A page above 1 000 000 characters is not framed at all - source only.
- **No network.** A Content-Security-Policy with no network source: `default-src 'none'`, inline
  styles, `data:` / `blob:` images, `data:` fonts, and inline scripts only with `scripts: true`.
  `fetch`, XHR, `sendBeacon`, WebSocket, an `<img src=https://…>`, an external script or
  stylesheet, a form: none of them leaves.
- **The policy cannot be pre-empted.** It is given twice. Once as the first element of the
  document itself (right after a leading doctype, otherwise before everything - no `<meta>`,
  `<base>` or script of the document can come earlier, and a later policy of its own can only
  narrow ours). And once by inheritance: the document is not framed by your page directly but by
  a **shell document of ours** inside the outer frame, and a `srcdoc` document takes its parent's
  policy whatever its own markup says.
- **No self-navigation.** A frame may always navigate ITSELF - `location = …`, a clicked link,
  `<meta http-equiv=refresh>` - and neither the sandbox nor the document's own policy stops it;
  each is a request that can carry data in its URL. The shell's `frame-src 'none'` does: it is the
  embedding document's policy that governs where a frame may go. (The browser then shows its own
  error page inside the frame; nothing was requested.)
- **The host draws the chrome.** The label ("HTML written by the agent · sandboxed · no
  network"), the Preview / Source switch, the size button and the footer are in your document,
  outside the frame: the content cannot imitate or cover a control of the chat.
- **A fixed height.** `htmlPreview.height` (300, clamped to 120 - 800), doubled by the size
  button. The frame is never resized from inside: the component listens to no message.
- **Source is text.** Line by line, as text nodes.

**Scripts are off by default** (`htmlPreview={{ scripts: true }}` turns them on): a static render
is enough to look at a page, and the footer says which it is. With scripts on the page still has
an opaque origin and no network. `htmlPreview={false}` never renders HTML.

What it does **not** do, in this version:

- **Linked files are not loaded.** An `index.html` that refers to `style.css`, `app.js` or an
  image next to it is shown without them (the policy refuses anything that is not inline), and
  the footer names what was left out. One self-contained file previews fully.
- **A DNS lookup is not a request the policy sees.** A browser may resolve a host named in
  `<link rel=dns-prefetch>` without fetching anything. What could leak that way is only what the
  agent itself put into the page it wrote - never anything of your origin.
- The guards are verified in Chromium (the browser tests). Firefox and Safari implement the same
  standards but are not in the test run.

`<SandboxedFrame html scripts title label actions footer height>` is exported for anything else
untrusted you need to draw (the builders are too: `buildSandboxedDocument`, `sandboxedCsp`,
`sandboxTokens`, `withCspFirst`). Do not weaken it by adding sandbox tokens around it.

Labels: `filesWritten`, `filesCount`, `showInFiles`, `fileKinds`, `fileOpen`, `fileClose`,
`fileDownload`, `fileBy`, `fileGone`, `fileNoPreview`, `fileCut`, `fileShowRest`, `fileShowLess`,
`fileRendered`, `fileSource`, `closePreview`, `fileLines`, `htmlFrameTitle`, `htmlSandboxed`,
`htmlNoNetwork`, `htmlSourceNote`, `htmlScripts`, `htmlLinkedFiles`, `htmlTooLarge`, `htmlTaller`,
`htmlShorter`, `htmlFrameName`.

## The decision model's note

With `decisionModel` in the agent's config a small model answers the replanner's continue / finish.
Each question it was asked leaves a quiet line under the step it followed:

- "decision model: continue (0.93)" - its answer was used;
- "decision model fell back: low confidence (0.41 < 0.8)" - the ordinary model call ran instead
  (also: an answer that is not an option, a timeout, an error).

```ts
step.decisions // DecisionView[] | undefined - { point, accepted, choice?, confidence?, threshold, reason?, durationMs, model? }
agent.decisions // the ones asked before any step existed
agent.replan?.confidence // set when the decision model made the last replan decision
```

`showDecisions={false}` (chat / message list / step list) hides the lines; `decisionNote(view,
labels)` is the sentence itself. Labels: `decisionAccepted`, `decisionFellBack`, `decisionReasons`.

## Web search results

`web_search` (core: `search` in the config) is an ordinary tool call. Its row gets a readable
result under it: the query, then each result as **title + host** - the title a link that opens in
a new tab with `rel="noopener noreferrer"` - and its snippet. Titles and snippets are third-party
text: they are rendered as plain text, never as HTML or Markdown, and a result whose address is
not `http(s)` is left out. "2 left out by the web access policy" / "list cut short" follow when
the core says so. `showSearchResults={false}` (chat / message list / step list / tool call row)
keeps the plain row; `webSearchOf(output)` is the parser.

Labels: `searchQuery`, `searchNoResults`, `searchFiltered`, `searchTruncated`.

## The agent's notebook, and what it fetched

With `learning` in the agent's config (core: `learning: true`, or `{ store: new VfsSkillStore(files) }`
to keep lessons as `SKILL.md` in the workspace) the agent writes down what it figured out. The UI
follows it:

- **The turn** says what the agent learned in that answer ("learned: image-format-jpg") and, with
  `egress`, what it fetched - each request with its status, a refused one with the reason
  ("refused: not on the allow list"). Hide it with `showLearned={false}` (chat / message list).
- **`<LearnedSkills />`** is the notebook itself: each lesson with when it applies, its revision
  and where it came from (the sources it named, the pages it read), and a button to forget it.
  Place it anywhere - a settings panel, a sidebar (`slots.sidebar`). Props: `controller`
  (default: the provider's), `lessons` (to show your own list), `onForget` (default
  `controller.forgetSkill`; `false` = read-only), `showSources`, `hideTitle`, `empty`, `labels`.
- **State:** `learned` (the notebook, `LessonView[]`) belongs to the agent, not to a conversation -
  it survives `reset` and a chat switch, and the hook re-reads it whenever the agent is rebuilt (so
  a store that persists brings its lessons back). `learnedNow` / `fetches` are the current run's;
  each assistant message keeps its own `learned` / `fetches`. `useAgent().forgetSkill(name)`
  deletes one.

Labels: `learnedNow`, `fetches`, `fetchRefused`, `notebookTitle`, `notebookEmpty`, `notebookForget`,
`notebookRevision`, `notebookFrom`.

## Attachments: images, PDFs, files, URLs

What the composer does with each file:

| Kind | Goes to the model as | When the model can't take it |
| --- | --- | --- |
| text (`.md`, `.json`, `.ts`, …) | inlined into the goal, fenced | — (every model reads text) |
| image | a file part (downscaled to ≤ 1568 px / 1.15 MP first) | refused with a sentence the user can act on |
| PDF | a file part | converted with `convertFile` if given, else refused |
| other | a file part | `convertFile`, else refused |

"Can't take it" comes from the core's `agent.capabilities` (`images`, `pdf`,
`files`: true / false / unknown). Unknown means *try*: if the provider refuses,
the run fails with an `AttachmentsNotSupportedError` naming the model and what
to do instead — never a raw provider error.

Images are downscaled because providers bill images by their pixel size and
resize anything larger themselves; a 12 MP phone photo costs the same tokens
as its 1.15 MP version but uploads ten times slower.

The core also takes URLs: `agent.run(goal, { files: [{ data: new
URL('https://…/report.pdf') }] })` — providers that accept links fetch them
themselves; for the rest the AI SDK downloads them (from a browser: subject to
CORS).

## Saved chats (IndexedDB)

`history` on `<AgentChat>`: `true` (a default `ChatHistoryStore`), your own
`ChatHistoryStore`, or the result of your own `useChatHistory()` (to render the
list elsewhere). Each chat stores the transcript **with** its tool calls, usage
and image attachments, and its id becomes the agent's memory session — use a
persistent `memory` (`IndexedDBStore`) and a reopened chat continues with the
model's context intact.

The sidebar sits beside a wide panel and overlays a narrow one (under
`narrowWidth`, default 760 px), where it starts closed.

```ts
const store = new ChatHistoryStore({ dbName: 'my-app-chats' }) // or { memory: true }
const chats = useChatHistory(agent, { store, resumeLatest: true })
chats.chats      // [{ id, title, createdAt, updatedAt, messageCount, totalUsage }]
chats.select(id) // open one
chats.newChat()  // start fresh
chats.remove(id)
```

Chats are saved when a run settles, not on every streamed token.

`<ChatHistoryList>` (the sidebar, usable on its own) also takes `renderChat(chat, active, fallback)`
to draw a row yourself and `formatTime(ms)` for the timestamps.

## Workspace (virtual file system)

`files` takes the core's `VirtualFileSystem` (IndexedDB, browser only — in Node
use the real file system). The composer saves attachments into it under
`/attachments/`, the Files panel shows it live (preview text and images,
download, delete, upload), and `createFileTools(files)` gives the agent
`fs_list`, `fs_read` (read-only), `fs_write` and `fs_delete` over the same
files — so "summarise the PDF I attached and save the summary next to it"
works.

`<FilesPanel>` (usable on its own) props: `allowUpload` / `allowDelete` (both default true),
`uploadDir` (where uploads go, default `/uploads`), `onOpen(file)` (a row was clicked, in addition to
the preview) and `renderFile(file, fallback)` to draw a row yourself.

## Tool consent

With a `toolApproval` mode other than autopilot, consent requests appear as
cards in the transcript ("Allow once", "Always allow", "Deny"); the consent
chip in the composer and the `/autopilot`, `/ask`, `/ask-all`, `/read-only`
commands switch the mode live, even mid-run.

`<ToolApprovalPrompt>` (usable on its own) takes `approvals` (e.g. `useAgent().pendingApprovals`), `onApprove(id, { remember })` and
`onDeny(id, reason)` (wire them to `useAgent().approve` / `.deny`), `allowRemember` (default
true; false hides "Always allow") and `showHelper` (default true: a request made by a helper the
model started says which helper asks - see [the tree](#subagents-and-helpers-the-tree)). `<ContextMeter>` shows tokens against `budgetTokens` and, with
`onCompact` (e.g. `agent.compact`), a "Compact" button — `compacting` disables it while it runs.

## Customising

**Show / hide** — the `show*` props above, `composer={false}`, `history`,
`files`.

**Labels (i18n)** — every string is a label, counted phrases are functions so
plurals work in any language:

```tsx
<AgentChat labels={{ send: 'Отправить', steps: (n) => `${n} шаг(ов)` }} />
// or for a whole tree:
<AgentLabelsProvider labels={ruLabels}>…</AgentLabelsProvider>
```

See `defaultLabels` for the full list (the demo ships a complete Russian set in
`demo/src/i18n.ts`).

**Render props** — take over a part and keep the rest; each gets the built-in
rendering as `fallback`:

```tsx
<AgentChat
  renderContent={(m) => <Markdown>{m.content}</Markdown>}
  renderToolCall={(call, fallback) =>
    call.name === 'make_move' ? <li><ChessMove move={call.input} /></li> : fallback}
  renderAttachment={(a) => <MyThumb attachment={a} />}
  renderMessage={(m, fallback) => <Animated key={m.id}>{fallback}</Animated>}
  renderApproval={(req, fallback) => fallback}
  renderSubagent={(node, fallback) => fallback}
  renderMedia={(media, message, fallback) => fallback}
  renderFile={(file, message, fallback) => fallback}
  renderFileContent={(file, text) => undefined}
/>
```

**Slots** — `slots={{ header, headerStart, headerEnd, beforeMessages,
afterMessages, footerStart, sidebar }}` (`header: false` hides it).

**Components** — swap whole parts with your own (same props):
`components={{ Composer, MessageList, HistoryList, FilesPanel, ApprovalPrompt }}`.

**Theme** — `theme="auto" | "light" | "dark"`, the `--awr-*` custom properties
(colours, radius, fonts, `--awr-sidebar-width`, `--awr-files-width`),
`classNames={{ root, main, header, body, footer, sidebar, files }}` and
`className` / `style`. Components used outside `<AgentChat>` get the theme
tokens inside an element with class `awr-theme`.

## Hooks and helpers for your own UI

| | |
| --- | --- |
| `useAgent` | the agent, its UI state, `run(goal, { images, files, attachments, label })`, `send` / `stopSubagent` (steer a running agent), `forgetSkill` (the notebook), consent, `compact`, `sessionId`, `loadChat` |
| `useChatHistory` | saved chats over a `ChatHistoryStore` |
| `lessonsOf` | the agent's own skills (`agent.listLearnedSkills()`) as `LessonView[]` - what the hook seeds the notebook with |
| `useVirtualFiles` | a live listing of a `VirtualFileSystem` + upload / remove / read |
| `useSpeechToText` | Web Speech API: `{ supported, listening, interim, start, stop, toggle }` |
| `useMcp` / `useMcpServers` | one or several MCP servers, merged tools — import from `@dudko.dev/agent-web-react/mcp`. `instructions` (on `useMcp`, and on each of `useMcpServers().servers`) is what the server told the agent in its handshake - third-party text that goes into the agent's prompt: show it to the user as the server's words. Options: `clientName`, `clientMetadataUrl` (a client ID metadata document, CIMD, used as the OAuth `client_id` where the authorization server supports it; per server through `oauth.clientMetadataUrl`), `onLog` — see the README |
| `mcpOAuthProviderOptions` | the options the MCP hooks hand the core's OAuth provider for one server (pure; same subpath) |
| `agentStateReducer` | the pure event → UI reducer |
| `subagentTree` | `agent.subagents` (flat) as nested `SubagentNode[]` |
| `webSearchOf`, `mediaFamilyOf`, `decisionNote` | a `web_search` result as a view, the family a generated file may be shown as, the decision model's sentence |
| `useAgentContext` / `useOptionalAgentContext` | the controller of the enclosing `<AgentProvider>` (the first throws outside one, the second returns `undefined`) |
| `useLabels` / `mergeLabels` / `defaultLabels` | the labels in effect, merged over a base, and the English defaults ([below](#label-reference)) |
| `parseSlash`, `filterCommands`, `attachmentKindOf`, `withAttachments`, `attachmentRefusal`, `noticesOf`, `formatElapsed`, `usageLine` | the composer's and transcript's pure logic |
| `downscaleImage` | the image downscaler |

## Label reference

Every string the components show is a key of `AgentLabels`. Pass a partial object as `labels` (to a
component or `<AgentLabelsProvider>`); whatever you leave out falls back to `defaultLabels`. Keys marked
*(fn)* are functions, so plurals work in any language; *(map)* keys are objects keyed by something.

- **Frame and transcript:** `emptyState`, `status` *(map by status)*, `history`, `newChat`, `files`,
  `totalUsage`, `showHistory`, `showFiles`, `close`, `steps` *(fn: n)*, `toolCalls` *(fn: n)*,
  `subagents` *(fn: n)*, `skillsUsed` *(fn: names)*, `answerThoughts`, `stepThoughts`, `usageTitle`,
  `attachments`, `planned`, `replanned` *(fn: mode, reason)*, `failed`, `toolCostTitle`.
- **Model tiers:** `tierNames` *(map by tier: `light` / `standard` / `strong`)*, `tierReasons` *(map by
  `planned` / `default` / `fallback`)*, `escalationReasons` *(map by `blocked` / `empty-result` /
  `tool-arguments` / `output-cut` / `error`)*, `escalated` *(fn: from, to, reason)*,
  `escalatedAttemptText`, `escalations` *(fn: n)*, `attemptTag` *(fn: n)*, `replayed`, `replayedTitle`,
  `replanFailed`.
- **Notebook and fetches:** `learnedNow` *(fn: names)*, `fetches` *(fn: n)*, `fetchRefused` *(fn: reason)*,
  `notebookTitle`, `notebookEmpty`, `notebookForget`, `notebookRevision` *(fn: n)*, `notebookFrom`.
- **Composer:** `placeholder`, `listening`, `message`, `dropHint`, `attach`, `attachTitle`, `commands`,
  `commandsTitle`, `send`, `stop`, `dismiss`, `remove` *(fn: name)*, `dictate`, `dictateTitle`,
  `stopDictation`, `microphone`, `model`, `thinking`, `toolConsent`, `modes` *(map by approval mode:
  `{ label, hint }`)*, `timerRunning`, `timerLast`, `agents` *(fn: n)*, `agentsTitle`, `notices` *(map
  of notice texts)*, `attachmentsOnly`, `seeAttachments`, `tooLarge` *(fn: name, mb)*, `binaryText`
  *(fn: name)*, `commandGroups` *(map)*, `commandDescriptions` *(map)*, `thinkingLevels` *(map)*.
- **Steering:** `placeholderBusy`, `steer`, `noAttachmentsWhileBusy`, `queuedWaiting`, `noteAt` *(map by
  `round` / `step` / `final`)*, `undelivered` *(fn: n)*, `sendUndelivered`, `discardUndelivered`,
  `stopSubagent`, `subagentStopped`.
- **Files and saved chats:** `filesEmpty`, `upload`, `download`, `delete`, `preview`, `bytes` *(fn: n)*,
  `historyEmpty`, `deleteChat`, `messagesCount` *(fn: n)*.
- **Subagent tree:** `subagentHelper`, `subagentStatus` *(map by `running` / `done` / `error` /
  `stopped`)*, `subagentTokens` *(fn: tokens)*, `subagentTools` *(fn: names)*, `subagentNoTools`,
  `approvalLeadHelper` *(fn: role?, depth)*.
- **Media, decisions, search:** `mediaImage` *(fn: path)*, `mediaAudio` *(fn: path)*, `mediaFile`
  *(fn: path)*, `transcriptOf` *(fn: name)*, `transcriptNote`, `usageMedia` *(fn: n)*,
  `usageDecisions` *(fn: n)*, `decisionAccepted` *(fn: choice, confidence)*, `decisionFellBack`
  *(fn: reason, detail)*, `decisionReasons` *(map by `low-confidence` / `invalid-choice` /
  `invalid-confidence` / `error` / `timeout` / `needs-model`)*, `searchQuery`, `searchNoResults`,
  `searchFiltered` *(fn: n)*, `searchTruncated`.
- **Files of a turn:** `filesWritten` *(fn: n)*, `filesCount` *(fn: n)*, `showInFiles`, `fileKinds`
  *(map by `html` / `markdown` / `csv` / `json` / `image` / `code` / `text` / `file`)*, `fileOpen`
  *(fn: name)*, `fileClose` *(fn: name)*, `fileDownload` *(fn: name)*, `fileBy` *(fn: name)*,
  `fileGone`, `fileNoPreview`, `fileCut` *(fn: chars)*, `fileShowRest`, `fileShowLess`,
  `fileRendered`, `fileSource`, `closePreview`, `fileLines` *(fn: n)*.
- **HTML preview:** `htmlFrameTitle`, `htmlSandboxed`, `htmlNoNetwork`, `htmlSourceNote`,
  `htmlScripts` *(fn: on)*, `htmlLinkedFiles` *(fn: names)*, `htmlTooLarge`, `htmlTaller`,
  `htmlShorter`, `htmlFrameName` *(fn: path)*.
- **Consent:** `approvalLead`, `approve`, `alwaysAllow`, `deny`, `declinedReason`, `readOnlyTool`,
  `consentWaiting`, `consentAllowed`, `consentDenied` *(fn: reason?)*.

`tests/chat.test.ts` fails if a key is added to `AgentLabels` and not listed here.
