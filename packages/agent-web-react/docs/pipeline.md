# Pipeline editor

A canvas editor for the core's **pipelines** - graphs of agents with conditions and loops, described
in plain JSON ([what a pipeline is, and how it runs](https://github.com/dudko-dev/agents/blob/main/packages/agent-web/docs/capabilities.md#pipelines-a-graph-of-agents)).
It lives behind its own entry, so a chat host never carries it:

```tsx
import { PipelineEditor, usePipeline, type PipelineDefinition } from '@dudko.dev/agent-web-react/pipeline'
import '@dudko.dev/agent-web-react/pipeline.css'

function Editor({ model, credentials, fileTools }) {
  const [definition, setDefinition] = useState<PipelineDefinition>(starter)
  const base = useMemo(() => ({ model, credentials }), [model, credentials])
  const tools = useMemo(() => ({ files: fileTools }), [fileTools])
  const pipeline = usePipeline(definition, { base, tools })
  return (
    <PipelineEditor
      value={definition}
      onChange={setDefinition}
      controller={pipeline}
      tools={[{ id: 'files', label: 'Workspace files' }]}
    />
  )
}
```

Try it: <https://agent.dudko.dev/pipeline/>.

- [What is in the entry](#what-is-in-the-entry)
- [`PipelineEditor`](#pipelineeditor)
- [`usePipeline`](#usepipeline)
- [The reducer](#the-reducer)
- [Editing helpers](#editing-helpers)
- [Copy as code](#copy-as-code)
- [The canvas](#the-canvas)
- [Keyboard, touch and screen readers](#keyboard-touch-and-screen-readers)
- [Styling](#styling)
- [Label reference](#label-reference)

## What is in the entry

Two layers, kept apart:

- **The canvas** (`Canvas`, `CanvasPort`, and its maths as plain functions) is a generic
  node-and-edge canvas. It knows nothing about agents and imports nothing from the rest of the
  package, so it can be used for any graph.
- **The editor** on top of it: `PipelineEditor` and its parts (`PipelineNodeCard`,
  `PipelineInspector`, `PipelineResults`, `PipelineIssues`, `PipelineCodeDialog`), the `usePipeline`
  hook, the pure `pipelineStateReducer`, the editing helpers and `pipelineToCode`.

The entry also re-exports the core's pipeline API (`createPipeline`, `nodeResolver`,
`validatePipeline`, `normalizePipeline`, `PIPELINE_LIMITS`, the error classes and the definition
types), so a page imports everything about pipelines from one place.

It has **no dependency of its own**: the canvas is this package's code (Pointer Events, a
`ResizeObserver`, SVG and CSS), MIT like the rest - no canvas, graph or drag library, and nobody
else's mark on it. It needs a core that has `createPipeline`; the main entry (`useAgent`, the
chat) does not, and never loads any of this.

## `PipelineEditor`

A controlled component: the definition comes in as `value`, every edit goes out through
`onChange` as a new definition. It never keeps a copy.

| Prop | Meaning |
| --- | --- |
| `value`, `onChange` | The `PipelineDefinition`, and what receives each edited one. |
| `controller` | What `usePipeline` returns. Adds the run bar (Run / Stop), live statuses on the nodes and edges, and the results. Without it the component is an editor only. |
| `models`, `skills`, `tools`, `mcpServers` | `PipelineOption[]` (`{ id, label?, description? }`): what a node may name - the keys of the registries your resolver has. A name in the definition that is not in the list is shown as *not available* and can still be unticked. |
| `selection`, `onSelectionChange` | Optional control of what is selected: `{ kind: 'node' \| 'edge', id }` or `null`. |
| `input`, `onInputChange` | Optional control of the request in the run bar. |
| `validate` | Checks the definition. Default: the core's `validatePipeline`. |
| `renderNode` | `({ node, view, entry, selected, invalid, card }) => ReactNode`: replace the node card (`card` is the one the editor would draw). Place `<CanvasPort>`s yourself for a node with routes. |
| `renderContent` | `(text) => ReactNode` for a node's output and the final answer - plug a Markdown renderer in. Default: plain text. |
| `slots` | `toolbarStart`, `toolbarEnd`, `canvas` (over the canvas), `inspectorFooter`, `runBarEnd`, `resultsFooter`. |
| `show*` | `showToolbar`, `showInspector`, `showRunBar`, `showResults`, `showIssues`, `showImport`, `showExport`, `showCode`, `showZoom`, `showGrid` - all `true` by default. |
| `snap` | The grid nodes snap to, in pixels (default 20; 0 = none). |
| `readOnly` | Look and run, but do not edit. |
| `fitKey` | Change it when you load another document: the canvas fits it. |
| `narrowWidth` | Under this width of the component (default 760) the inspector is a bottom sheet and the toolbar is icons. It follows the component's own width, not the window's. |
| `labels`, `theme`, `className` | Every string (see [the reference](#label-reference)); `'light'` / `'dark'` to force a scheme. |

What it draws:

- **A node card**: the name, the model, badges for its skills, tool groups and MCP servers, its
  routes as labelled output ports, the run status (idle, waiting, running, done, failed, skipped),
  the number of visits, and - while it runs - one line of what its agent is doing.
- **Edges** as curves with an arrowhead and their condition written on them; a loop swings around
  below its nodes. During a run an edge that fired is highlighted while its target waits or runs.
- **The inspector**, for the selected node (name, id, instructions, model, skills, tools, MCP
  servers, routes, `join`, entry), the selected connection (the condition: `always`, `contains`,
  `matches`, `route`, `otherwise`, and its fields) or - with nothing selected - the pipeline (name,
  entry node, limits).
- **The toolbar**: add node, delete, zoom, fit, import JSON, export JSON, copy as code, and the
  validation chip - errors and warnings, each leading to its node or edge when picked.
- **The run bar and the results**: the final answer, and every node's output visit by visit.

A definition without positions (written by hand, or by a model) is laid out in columns from the
entry; the positions are written into the definition with the first edit. Edges without ids get
them written down the same way (the runner's positional `e0`, `e1`, ... shift when an edge is
removed; an editor needs them fixed).

Every part is exported, to compose your own editor:

```tsx
<PipelineInspector value={def} onChange={setDef} selection={selection} models={models} />
<PipelineResults state={pipeline} definition={def} renderContent={(t) => <Markdown text={t} />} />
<PipelineIssues validation={pipeline.validation} onPick={(issue) => select(issueTarget(issue, def))} />
<PipelineCodeDialog definition={def} open={open} onClose={() => setOpen(false)} />
<PipelineNodeCard node={node} view={pipelineNodeView(pipeline, node.id)} entry />
```

## `usePipeline`

`usePipeline(definition, options)` builds the pipeline with the core, runs it and folds its
events into state.

| Option | Meaning |
| --- | --- |
| `resolveNode` | `(node) => BrowserAgentConfig`: the core's seam, when you decide a node's config yourself. |
| `base`, `models`, `skills`, `tools`, `mcpServers`, `configure` | The registries of the core's `nodeResolver`, used when there is no `resolveNode`. A name that is not registered fails its node: a definition cannot reach anything you did not put here. |
| `runNode` | Run a node yourself - the pipeline then only schedules. Also how to drive the UI without a model. |
| `onEvent` | Every raw event, after the reducer folded it. |

It returns the state (below) plus:

| Field | Meaning |
| --- | --- |
| `run(input)` | Resolves with the `PipelineResult`, or `undefined` when it could not start (a run in flight, an invalid definition) or a node failed - then read `error`. |
| `stop()` | Aborts the run; it ends with `stoppedBy: 'aborted'`. |
| `reset()` | Forgets the last run. |
| `isRunning`, `validation`, `result` | Whether a run is in flight; `validatePipeline(definition)`; what the last finished run returned. |

The node agents live as long as the definition and the options stay **the same objects**, so keep
them stable (`useMemo`) if a node should remember across runs; a change builds the pipeline anew at
the next run.

## The reducer

`pipelineStateReducer(state, action)` is pure - no React, no clock, no randomness - like
`agentStateReducer` for one agent. Build your own UI on it:

```ts
let state = createInitialPipelineState()
state = pipelineStateReducer(state, { type: 'run.start', input })
await pipeline.run({ input, onEvent: (event) => { state = pipelineStateReducer(state, { type: 'event', event }) } })
```

Actions: `run.start` (`input`), `event` (any event of the run), `run.result` (`result`),
`run.error` (`error`, `nodeId?`), `reset`. An action that changes nothing returns the same object,
so a stream of text deltas does not re-render anything.

`PipelineUiState`:

| Field | Meaning |
| --- | --- |
| `status` | `idle`, `running`, `done`, `failed`, `stopped`. A run a cap cut short is `done`, with `stoppedBy`. |
| `nodes[id]` | `status` (`idle`, `waiting`, `running`, `done`, `failed`, `skipped`), `visits`, `from` (who activated the visit), `outputs` (`{ visit, text, route? }[]`), `activity`, `error`, `skipped` (the cap that refused it), `usage`. A node the run has not touched is absent: read it with `pipelineNodeView(state, id)`. |
| `nodes[id].activity` | The node's own agent, in one line: `phase`, the plan `step` with `stepIndex` / `stepTotal`, the `tool` being called, `toolCalls`. |
| `edges[id]` | The last decision on the edge: `fired`, `visit` (of the source), `count` (times it fired), `live` (it fired and its target has not consumed it yet), `from`, `to`. |
| `lastFired` | The edges the node that finished last fired. |
| `visits` | The run as a timeline: one entry per node visit, in the order they started, with `status`, `text`, `route`, `error`, `usage`. |
| `text`, `usage`, `runs`, `stoppedBy`, `error`, `failedNode`, `input`, `name` | The final answer; the tokens of all nodes; node visits started; why it stopped; what failed and where. |

`waiting` is a node an edge fired towards that has not started: it waits for its wave, or - a
fan-in - for its other branch. When a run ends by a failure or an abort, nothing is left
`running`: such a node goes back to `done` (it has outputs) or `idle`.

## Editing helpers

Pure functions from a definition to a new one. They keep the graph consistent and return the
**same object** when there is nothing to change.

| Function | What it does |
| --- | --- |
| `addNode(def, node?)` | Adds a node with a free id (from its name, or `node`; a taken id is made unique). The first node becomes the entry. |
| `updateNode(def, id, patch)` | Patches fields; an emptied one (`''`, `[]`, `undefined`) is removed. |
| `moveNode(def, id, position)` | Sets `position`, rounded. |
| `removeNode(def, id)` | Removes the node and every edge that touches it; the entry moves to the first node left. |
| `renameNode(def, id, nextId)` | Changes the id; its edges and the entry follow. Refused when the id is empty or taken. |
| `setEntry(def, id)` | The node that receives the request. |
| `addEdge(def, { from, to, when?, id? })` | Connects two existing nodes, once (the same ends and the same condition twice is refused), with a unique id. |
| `updateEdge(def, id, { from?, to?, when? })` | Changes the condition or the ends; `always` leaves no `when`. |
| `removeEdge(def, id)` | Removes it; the other edges keep their ids. |
| `renameRoute(def, nodeId, label, nextLabel)` | Renames a route and the edges that take it. |
| `setLimits(def, patch)`, `setPipelineName(def, name)` | Set or clear; no empty `limits` left behind. |
| `ensureEdgeIds(def)` | Writes an id on every edge. |
| `autoLayout(def, { columnGap?, rowGap?, all? })` | Places the nodes that have no position, in columns from the entry. |
| `parsePipelineJson(text)` | Reads an imported definition: throws a plain message when it is not JSON or not a pipeline's shape; one that parses but does not validate comes back as it is, for the editor to show what is wrong. |
| `issueTarget(issue, def)` | What a validation issue is about, as a selection. |
| `uniqueNodeId`, `uniqueEdgeId`, `slugifyId`, `nextNodePosition`, `emptyPipeline` | Small ones. |

## Copy as code

`pipelineToCode(definition, { target, positions?, input? })` returns a TypeScript snippet that runs
the definition - `target: 'browser'` with `@dudko.dev/agent-web`, `target: 'node'` with
`@dudko.dev/agent`. The names the definition uses (models, skills, tool groups, MCP servers) appear
as variables for you to supply; a definition never carries a model or a key. Positions are left
out unless `positions: true` (the runner ignores them).

## The canvas

`Canvas` is the editor's lower layer, usable alone for any graph. It is controlled: nodes, edges
and positions are props, changes are callbacks.

```tsx
import { Canvas, CanvasPort } from '@dudko.dev/agent-web-react/pipeline'

<Canvas
  nodes={[{ id: 'a', x: 0, y: 0, label: 'First' }, { id: 'b', x: 320, y: 0, label: 'Second' }]}
  edges={[{ id: 'e', from: 'a', to: 'b', label: 'then' }]}
  renderNode={(node) => <div className="card">{node.label}</div>}
  selection={selection}
  onSelectionChange={setSelection}
  onNodeMove={(id, position) => move(id, position)}
  onConnect={({ from, fromPort, to }) => connect(from, to)}
  onDelete={(target) => remove(target)}
/>
```

| Prop | Meaning |
| --- | --- |
| `nodes` | `{ id, x, y, label, description?, ports?, width?, height? }[]`. `label` and `description` are what a screen reader hears. |
| `edges` | `{ id, from, to, fromPort?, label?, description?, tone? }[]`; `tone` is `default`, `active`, `done`, `muted` or `danger`. |
| `renderNode` | `(node, { selected, dragging, connectable }) => ReactNode`: the node's HTML. |
| `selection`, `onSelectionChange` | A node or an edge, or `null`. |
| `viewport`, `onViewportChange` | `{ x, y, zoom }`. Leave both out and the canvas keeps its own. |
| `onNodeMove`, `onNodeMoveEnd` | While a node is dragged (or moved with the arrow keys), and when it stops. |
| `onConnect`, `onDelete`, `onOpen` | A port was connected to a node; Delete was pressed; Enter or a double click. |
| `snap`, `showGrid`, `showControls`, `minZoom`, `maxZoom`, `fitOnMount`, `fitKey`, `readOnly` | The grid step (20), the dot grid, the zoom buttons, the zoom range (0.25-2), fitting, look-only. |
| `autoFitMinZoom` | The smallest zoom the canvas fits to by itself. A graph that does not fit at it is shown from its top-left corner at that zoom - readable - and the Fit button still shows all of it. The editor uses 0.7 on a narrow component. |
| `labels` | Its own strings: `CanvasLabels`, defaults in `defaultCanvasLabels`. |

A node has one output port on its right side. Give it `ports: [{ id, label? }]` and place a
`<CanvasPort id>` for each inside `renderNode` - the edge with that `fromPort` starts at the
port's centre (the canvas measures it). Edges enter a node at the middle of its left side.

A `ref` gives `fit()`, `zoomIn()`, `zoomOut()`, `center(nodeId)`, `reveal(nodeId)` (centre it only
when it is out of view), `focus({ kind, id })`, `getViewport()` and `getSize()`.

The canvas fits the graph when it first has a size, and again whenever its box changes - until
the person pans or zooms; from then on the view is theirs.

The maths is exported as plain functions, tested as they are: `screenToWorld`, `worldToScreen`,
`panBy`, `zoomAt`, `pinchViewport`, `fitViewport`, `centerOn`, `boundsOf`, `isRectVisible`,
`snapTo`, `snapPoint`, `rectContains`, `hitNode`, `hitEdge`, `distanceToCurve`, `inputAnchor`,
`outputAnchor`, `edgeCurve`, `curvePath`, `curvePoint`, `readingOrder`.

## Keyboard, touch and screen readers

| Input | What it does |
| --- | --- |
| Drag the background; the wheel; two fingers | Pan. |
| Ctrl / Cmd + wheel; pinch; the zoom buttons; `+` `-` `0` on the canvas | Zoom; `0` and *Fit* show everything. |
| Drag a node | Move it (snapped to the grid). |
| Drag from a port to a node | Connect them. Or press the port, then the node - the way to do it on a phone, and with a keyboard. |
| Click, tap | Select a node or an edge. A double click (or Enter) opens the inspector on it. |
| Tab | Walks the nodes left to right, top to bottom; after each node, its ports and the connections that leave it. |
| Arrow keys on a node | Move it one grid step (Shift: five). On the canvas itself: pan. |
| `C` on a node, or Enter on a port | Start a connection; move to the target node and press Enter. Escape cancels. |
| Delete / Backspace | Remove the selected node or connection. |
| Escape | Cancel a connection, else clear the selection. |

A touch that starts on the canvas belongs to the canvas (`touch-action: none` on it, and on
nothing else): one finger pans, two zoom, and the page behind neither scrolls nor zooms. On a
narrow component the inspector is a bottom sheet: a bar with the selection's name that opens over
the canvas.

During a run the editor brings a node that starts into view when it is outside it (a graph
larger than a phone's canvas).

A screen reader hears the canvas as an application with its keyboard help, each node by its name
with its state ("running, visit 2"), what it connects to and receives from, and each connection
with its ends and condition. Node starts, finishes and failures of a run are announced politely.
Focus is always visible (`:focus-visible`), and `prefers-reduced-motion` turns the animations off.

## Styling

`pipeline.css` is a **separate stylesheet** (not part of `styles.css`), copied verbatim into
`dist`: a chat host does not pay for it, and it stands on its own - an editor host need not load
`styles.css`. It follows the same rules: every class is prefixed `awr-` (`awr-canvas...` for the
canvas, `awr-pipeline...` and `awr-p...` for the editor), and every colour is one of the chat's
`--awr-*` custom properties with the same light and dark defaults. Override them on
`.awr-pipeline` (or on `.awr-canvas`, used alone); `data-awr-theme="light|dark"` (the `theme`
prop) forces a scheme.

```css
.awr-pipeline {
  --awr-bg: #0b101a;        /* cards, the toolbar, the inspector */
  --awr-canvas-bg: #04070e; /* the canvas behind the nodes (default: --awr-bg) */
  --awr-accent: #2f9fe0;
  --awr-radius: 14px;
  --awr-focus: #8fd0f7;     /* the focus ring (default: --awr-accent) */
  --awr-ease: cubic-bezier(0.22, 1, 0.36, 1); /* every transition */
  --awr-inspector-width: 320px;
}
```

## Label reference

Every string the editor shows or says is a key of `PipelineLabels`. Pass a partial object as
`labels` (to a component, or to `<PipelineLabelsProvider>` for a whole tree); whatever you leave out
falls back to `defaultPipelineLabels`. Keys marked *(fn)* are functions, so plurals work in any
language; *(map)* keys are objects, merged key by key.

- **Toolbar:** `toolbar`, `addNode`, `deleteSelected`, `fit`, `zoomIn`, `zoomOut`, `importJson`,
  `exportJson`, `copyCode`, `newNodeName` *(fn: n)*, `importFailed` *(fn: reason)*.
- **Validation:** `issues`, `noIssues`, `errors` *(fn: n)*, `warnings` *(fn: n)*, `issueError`,
  `issueWarning`.
- **Canvas:** `emptyCanvas`, `nodeDescription` *(fn: status, visits)*, and `canvas` *(map)* - the
  canvas's own `CanvasLabels`: `canvas` (its name), `help` (the keyboard instructions), `node`
  (what a node is called), `edge` *(fn: from, to, description)*, `port` *(fn: node, port)*,
  `connectsTo` *(fn: names)*, `receivesFrom` *(fn: names)*, `zoomIn`, `zoomOut`, `fit`,
  `zoomLevel` *(fn: percent)*, `connectHint` *(fn: from)*, `cancel`, `connected` *(fn: from, to)*.
- **Node card:** `nodeStatus` *(map by status)*, `entry`, `defaultModel`, `skillsBadge` *(fn: n)*,
  `toolsBadge` *(fn: n)*, `mcpBadge` *(fn: n)*, `visits` *(fn: n)*, `anyOutput`,
  `activityPlanning`, `activityReplanning`, `activityAnswering`,
  `activityStep` *(fn: index, total, step)*, `activityTool` *(fn: name)*,
  `skippedBy` *(map by cap)*.
- **Inspector:** `inspector`, `inspectorNode`, `inspectorEdge`, `inspectorPipeline`, `close`,
  `expand`, `collapse`, `fieldId`, `fieldIdHint`, `idTaken`, `idEmpty`, `fieldName`,
  `fieldInstructions`, `instructionsPlaceholder`, `fieldModel`, `unknownOption` *(fn: name)*,
  `fieldSkills`, `fieldTools`, `fieldMcp`, `noOptions`, `fieldRoutes`, `routesHint`, `routeLabel`,
  `routeDescription`, `addRoute`, `removeRoute` *(fn: label)*, `fieldJoin`, `joinAll`, `joinAny`,
  `isEntry`, `makeEntry`, `deleteNode`, `edgeEnds` *(fn: from, to)*, `fieldCondition`,
  `conditionKinds` *(map by kind)*, `conditionHints` *(map by kind)*, `fieldText`,
  `caseSensitive`, `fieldPattern`, `fieldFlags`, `fieldRoute`, `noRoutes`, `deleteEdge`,
  `pipelineName`, `pipelineNamePlaceholder`, `fieldEntry`, `fieldMaxNodeVisits`, `fieldMaxRuns`,
  `limitDefault` *(fn: n)*, `counts` *(fn: nodes, edges)*.
- **Run:** `runPlaceholder`, `runInput`, `run`, `stop`, `fixErrorsFirst`,
  `runStatus` *(map by status)*, `stoppedBy` *(map by reason)*,
  `announceNode` *(fn: name, status)*.
- **Results:** `results`, `showResults`, `hideResults`, `finalAnswer`, `nodeOutputs`,
  `noOutputYet`, `visitTitle` *(fn: name, visit)*, `routeTaken` *(fn: label)*,
  `receivedFrom` *(fn: names)*, `usage` *(fn: input, output)*, `runsCount` *(fn: n)*.
- **Copy as code:** `codeTitle`, `codeBrowser`, `codeNode`, `copy`, `copied`.
