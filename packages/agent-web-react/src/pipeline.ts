// The pipeline editor, behind its own subpath: `@dudko.dev/agent-web-react/pipeline`
// (styles: `@dudko.dev/agent-web-react/pipeline.css`).
//
// WHY THIS IS NOT IN THE MAIN ENTRY. A host that renders a chat has no use for a canvas, an
// inspector and a code generator, and should not carry them - nor depend on a core new enough to
// have `createPipeline`, which this entry imports. Nothing of it is referenced from
// `src/index.ts`; `tests/entries.test.ts` keeps it that way.
//
// Two layers, kept apart: `canvas/` is a generic node-and-edge canvas that knows nothing about
// agents (it imports nothing from the rest of this package), `pipeline/` is the editor on top.

// ── The canvas (generic) ─────────────────────────────────────────────────────
export * from './canvas/index.js'

// ── The editor ───────────────────────────────────────────────────────────────
export {
  PipelineEditor,
  PipelineCodeDialog,
  PipelineIssues,
  PipelineResults,
  conditionSummary,
} from './pipeline/PipelineEditor.js'
export type {
  PipelineCodeDialogProps,
  PipelineController,
  PipelineEditorProps,
  PipelineEditorSlots,
  PipelineIssuesProps,
  PipelineNodeRenderContext,
  PipelineResultsProps,
} from './pipeline/PipelineEditor.js'
export {
  PipelineNodeCard,
  activityText,
  routePortId,
  OUTPUT_PORT,
} from './pipeline/PipelineNodeCard.js'
export type { PipelineNodeCardProps } from './pipeline/PipelineNodeCard.js'
export { PipelineInspector, inspectorTitle } from './pipeline/PipelineInspector.js'
export type { PipelineInspectorProps, PipelineOption } from './pipeline/PipelineInspector.js'

// ── The hook and the headless state (the pure event → UI reducer) ────────────
export { usePipeline } from './pipeline/use-pipeline.js'
export type { UsePipelineOptions, UsePipelineReturn } from './pipeline/use-pipeline.js'
export {
  pipelineStateReducer,
  createInitialPipelineState,
  pipelineNodeView,
} from './pipeline/state.js'
export type {
  PipelineAction,
  PipelineEdgeView,
  PipelineNodeActivity,
  PipelineNodeStatus,
  PipelineNodeView,
  PipelineOutputView,
  PipelineRunStatus,
  PipelineUiState,
  PipelineVisitView,
} from './pipeline/state.js'

// ── Editing a definition, and turning one into code (pure functions) ─────────
export {
  addEdge,
  addNode,
  autoLayout,
  emptyPipeline,
  ensureEdgeIds,
  issueTarget,
  moveNode,
  nextNodePosition,
  parsePipelineJson,
  removeEdge,
  removeNode,
  renameNode,
  renameRoute,
  setEntry,
  setLimits,
  setPipelineName,
  slugifyId,
  uniqueEdgeId,
  uniqueNodeId,
  updateEdge,
  updateNode,
} from './pipeline/edit.js'
export type { AutoLayoutOptions, PipelineSelection } from './pipeline/edit.js'
export { pipelineToCode } from './pipeline/codegen.js'
export type { PipelineCodeOptions, PipelineCodeTarget } from './pipeline/codegen.js'

// ── Labels (i18n) ────────────────────────────────────────────────────────────
export {
  PipelineLabelsProvider,
  defaultPipelineLabels,
  mergePipelineLabels,
  usePipelineLabels,
} from './pipeline/labels.js'
export type {
  PipelineLabels,
  PipelineLabelsOverride,
  PipelineLabelsProviderProps,
} from './pipeline/labels.js'

// ── The core's pipeline API (a peer dep), so an app imports it from one place ─
export {
  createPipeline,
  nodeResolver,
  normalizePipeline,
  validatePipeline,
  PIPELINE_LIMITS,
  PipelineNodeError,
  PipelineValidationError,
} from '@dudko.dev/agent-web'
export type {
  NodeResolverOptions,
  Pipeline,
  PipelineCondition,
  PipelineDefinition,
  PipelineEdge,
  PipelineEvent,
  PipelineIssue,
  PipelineNode,
  PipelineOptions,
  PipelineResult,
  PipelineRoute,
  PipelineRunOptions,
  PipelineStop,
  PipelineValidation,
} from '@dudko.dev/agent-web'
