import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { PipelineCondition, PipelineStop } from '@dudko.dev/agent-web'
import { defaultCanvasLabels, type CanvasLabels } from '../canvas/Canvas.js'
import type { PipelineNodeStatus, PipelineRunStatus } from './state.js'

type ConditionKind = PipelineCondition['kind']

/**
 * Every string the pipeline editor renders or says - override any of them for another language
 * or wording, per component (`labels` prop) or for a whole tree (`<PipelineLabelsProvider>`).
 * Counted phrases are functions. The reference with the defaults is in docs/pipeline.md.
 */
export interface PipelineLabels {
  // ── toolbar ────────────────────────────────────────────────────────────────
  toolbar: string
  addNode: string
  deleteSelected: string
  fit: string
  zoomIn: string
  zoomOut: string
  importJson: string
  exportJson: string
  copyCode: string
  /** The name a new node gets ("Agent 3"). */
  newNodeName: (n: number) => string
  importFailed: (reason: string) => string

  // ── validation ─────────────────────────────────────────────────────────────
  issues: string
  noIssues: string
  errors: (n: number) => string
  warnings: (n: number) => string
  issueError: string
  issueWarning: string

  // ── canvas ─────────────────────────────────────────────────────────────────
  /** The canvas's own strings (its name, its keyboard help, what a port and an edge are called). */
  canvas: CanvasLabels
  emptyCanvas: string
  /** The node's state for a screen reader: "running, visit 2". */
  nodeDescription: (status: string, visits: number) => string

  // ── node card ──────────────────────────────────────────────────────────────
  nodeStatus: Record<PipelineNodeStatus, string>
  entry: string
  defaultModel: string
  skillsBadge: (n: number) => string
  toolsBadge: (n: number) => string
  mcpBadge: (n: number) => string
  visits: (n: number) => string
  /** The output port of a node with routes that takes no route: every other kind of edge. */
  anyOutput: string
  activityPlanning: string
  activityReplanning: string
  activityAnswering: string
  activityStep: (index: number, total: number, step: string) => string
  activityTool: (name: string) => string
  skippedBy: Record<'maxRuns' | 'maxNodeVisits', string>

  // ── inspector ──────────────────────────────────────────────────────────────
  inspector: string
  inspectorNode: string
  inspectorEdge: string
  inspectorPipeline: string
  close: string
  expand: string
  collapse: string
  fieldId: string
  fieldIdHint: string
  idTaken: string
  idEmpty: string
  fieldName: string
  fieldInstructions: string
  instructionsPlaceholder: string
  fieldModel: string
  /** An option that is in the definition but not in the host's list. */
  unknownOption: (name: string) => string
  fieldSkills: string
  fieldTools: string
  fieldMcp: string
  noOptions: string
  fieldRoutes: string
  routesHint: string
  routeLabel: string
  routeDescription: string
  addRoute: string
  removeRoute: (label: string) => string
  fieldJoin: string
  joinAll: string
  joinAny: string
  isEntry: string
  makeEntry: string
  deleteNode: string
  edgeEnds: (from: string, to: string) => string
  fieldCondition: string
  conditionKinds: Record<ConditionKind, string>
  conditionHints: Record<ConditionKind, string>
  fieldText: string
  caseSensitive: string
  fieldPattern: string
  fieldFlags: string
  fieldRoute: string
  noRoutes: string
  deleteEdge: string
  pipelineName: string
  pipelineNamePlaceholder: string
  fieldEntry: string
  fieldMaxNodeVisits: string
  fieldMaxRuns: string
  limitDefault: (n: number) => string
  counts: (nodes: number, edges: number) => string

  // ── run ────────────────────────────────────────────────────────────────────
  runPlaceholder: string
  runInput: string
  run: string
  stop: string
  fixErrorsFirst: string
  runStatus: Record<PipelineRunStatus, string>
  stoppedBy: Record<PipelineStop, string>
  /** Announced to a screen reader as nodes start, finish, fail. */
  announceNode: (name: string, status: string) => string

  // ── results ────────────────────────────────────────────────────────────────
  results: string
  showResults: string
  hideResults: string
  finalAnswer: string
  nodeOutputs: string
  noOutputYet: string
  visitTitle: (name: string, visit: number) => string
  routeTaken: (label: string) => string
  receivedFrom: (names: string) => string
  usage: (input: string, output: string) => string
  runsCount: (n: number) => string

  // ── copy as code ───────────────────────────────────────────────────────────
  codeTitle: string
  codeBrowser: string
  codeNode: string
  copy: string
  copied: string
}

export const defaultPipelineLabels: PipelineLabels = {
  toolbar: 'Pipeline tools',
  addNode: 'Add node',
  deleteSelected: 'Delete',
  fit: 'Fit',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  importJson: 'Import JSON',
  exportJson: 'Export JSON',
  copyCode: 'Copy as code',
  newNodeName: (n) => `Agent ${n}`,
  importFailed: (reason) => `Could not import: ${reason}`,

  issues: 'Issues',
  noIssues: 'No issues',
  errors: (n) => `${n} error${n === 1 ? '' : 's'}`,
  warnings: (n) => `${n} warning${n === 1 ? '' : 's'}`,
  issueError: 'Error',
  issueWarning: 'Warning',

  canvas: { ...defaultCanvasLabels, canvas: 'Pipeline canvas' },
  emptyCanvas: 'No nodes yet. Add one to start.',
  nodeDescription: (status, visits) => (visits > 1 ? `${status}, visit ${visits}.` : `${status}.`),

  nodeStatus: {
    idle: 'idle',
    waiting: 'waiting',
    running: 'running',
    done: 'done',
    failed: 'failed',
    skipped: 'skipped',
  },
  entry: 'entry',
  defaultModel: 'default model',
  skillsBadge: (n) => `${n} skill${n === 1 ? '' : 's'}`,
  toolsBadge: (n) => `${n} tool group${n === 1 ? '' : 's'}`,
  mcpBadge: (n) => `${n} MCP server${n === 1 ? '' : 's'}`,
  visits: (n) => `×${n}`,
  anyOutput: 'any',
  activityPlanning: 'planning…',
  activityReplanning: 'checking the plan…',
  activityAnswering: 'writing the answer…',
  activityStep: (index, total, step) => `${index}/${total} ${step}`,
  activityTool: (name) => `tool: ${name}`,
  skippedBy: {
    maxNodeVisits: 'visit limit reached',
    maxRuns: 'run limit reached',
  },

  inspector: 'Inspector',
  inspectorNode: 'Node',
  inspectorEdge: 'Connection',
  inspectorPipeline: 'Pipeline',
  close: 'Close',
  expand: 'Show details',
  collapse: 'Hide details',
  fieldId: 'Id',
  fieldIdHint: 'Unique; edges and events name the node by it.',
  idTaken: 'Another node has this id.',
  idEmpty: 'A node needs an id.',
  fieldName: 'Name',
  fieldInstructions: 'Instructions',
  instructionsPlaceholder: 'The role of this node: what it does with what it receives.',
  fieldModel: 'Model',
  unknownOption: (name) => `${name} (not available)`,
  fieldSkills: 'Skills',
  fieldTools: 'Tools',
  fieldMcp: 'MCP servers',
  noOptions: 'None available.',
  fieldRoutes: 'Routes',
  routesHint: 'After it answers, the node picks one. Each becomes an output port.',
  routeLabel: 'Label',
  routeDescription: 'When to pick it',
  addRoute: 'Add route',
  removeRoute: (label) => `Remove route ${label}`,
  fieldJoin: 'When several nodes lead here',
  joinAll: 'Wait for all of them',
  joinAny: 'Run on any of them',
  isEntry: 'This node receives the request.',
  makeEntry: 'Make it the entry',
  deleteNode: 'Delete node',
  edgeEnds: (from, to) => `${from} → ${to}`,
  fieldCondition: 'Fires',
  conditionKinds: {
    always: 'always',
    contains: 'contains',
    matches: 'matches',
    route: 'route',
    otherwise: 'otherwise',
  },
  conditionHints: {
    always: 'Every time the source node answers.',
    contains: 'When the answer contains this text.',
    matches: 'When this pattern occurs in the answer. No backreferences or lookaround.',
    route: 'When the source node picks this route.',
    otherwise: 'When no other connection of the source node fired.',
  },
  fieldText: 'Text',
  caseSensitive: 'Match case',
  fieldPattern: 'Pattern',
  fieldFlags: 'Flags',
  fieldRoute: 'Route',
  noRoutes: 'The source node has no routes. Add one to it first.',
  deleteEdge: 'Delete connection',
  pipelineName: 'Name',
  pipelineNamePlaceholder: 'Untitled pipeline',
  fieldEntry: 'Entry node',
  fieldMaxNodeVisits: 'Visits per node',
  fieldMaxRuns: 'Node runs in total',
  limitDefault: (n) => `default ${n}`,
  counts: (nodes, edges) =>
    `${nodes} node${nodes === 1 ? '' : 's'}, ${edges} connection${edges === 1 ? '' : 's'}`,

  runPlaceholder: 'What should the pipeline work on?',
  runInput: 'Request',
  run: 'Run',
  stop: 'Stop',
  fixErrorsFirst: 'Fix the errors before running.',
  runStatus: {
    idle: 'Not run yet',
    running: 'Running…',
    done: 'Finished',
    failed: 'Failed',
    stopped: 'Stopped',
  },
  stoppedBy: {
    maxNodeVisits: 'A node reached its visit limit, so a loop was cut short.',
    maxRuns: 'The pipeline reached its limit of node runs.',
    aborted: 'Stopped before it finished.',
  },
  announceNode: (name, status) => `${name}: ${status}`,

  results: 'Result',
  showResults: 'Show the result',
  hideResults: 'Hide the result',
  finalAnswer: 'Final answer',
  nodeOutputs: 'Node outputs',
  noOutputYet: 'Nothing yet.',
  visitTitle: (name, visit) => (visit > 1 ? `${name} · visit ${visit}` : name),
  routeTaken: (label) => `route: ${label}`,
  receivedFrom: (names) => `from ${names}`,
  usage: (input, output) => `in ${input} · out ${output}`,
  runsCount: (n) => `${n} node run${n === 1 ? '' : 's'}`,

  codeTitle: 'Copy as code',
  codeBrowser: 'Browser',
  codeNode: 'Node',
  copy: 'Copy',
  copied: 'Copied',
}

const NESTED = [
  'canvas',
  'nodeStatus',
  'skippedBy',
  'conditionKinds',
  'conditionHints',
  'runStatus',
  'stoppedBy',
] as const
type Nested = (typeof NESTED)[number]

/** Overrides: any label, with the nested groups merged key by key. */
export type PipelineLabelsOverride = Partial<Omit<PipelineLabels, Nested>> & {
  [K in Nested]?: Partial<PipelineLabels[K]>
}

/** `base` with `over` applied (nested groups merged, not replaced). */
export const mergePipelineLabels = (
  base: PipelineLabels,
  over?: PipelineLabelsOverride,
): PipelineLabels => {
  if (!over) return base
  const out = { ...base, ...over } as PipelineLabels
  for (const key of NESTED) {
    if (over[key]) (out as unknown as Record<string, unknown>)[key] = { ...base[key], ...over[key] }
  }
  return out
}

const LabelsContext = createContext<PipelineLabels>(defaultPipelineLabels)

export interface PipelineLabelsProviderProps {
  labels: PipelineLabelsOverride
  children?: ReactNode
}

/** Override labels for every pipeline component below (nests: inner providers win). */
export const PipelineLabelsProvider = ({ labels, children }: PipelineLabelsProviderProps) => {
  const parent = useContext(LabelsContext)
  const value = useMemo(() => mergePipelineLabels(parent, labels), [parent, labels])
  return <LabelsContext.Provider value={value}>{children}</LabelsContext.Provider>
}

/** The labels in effect: the provider's, with a component's own `labels` prop on top. */
export const usePipelineLabels = (over?: PipelineLabelsOverride): PipelineLabels => {
  const ctx = useContext(LabelsContext)
  return useMemo(() => mergePipelineLabels(ctx, over), [ctx, over])
}
