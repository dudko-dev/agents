import type { AgentEvent, IUsage, PipelineResult, PipelineStop } from '@dudko.dev/agent-web'

// The pipeline's event → UI mapping: a pure reducer, like `agentStateReducer` for one agent. No
// React, no clock, no randomness - the same events always give the same state, so it is tested
// against recorded event sequences and a host can build its own UI on it.

export type PipelineRunStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped'

/**
 * `waiting`: an edge fired towards the node and it has not started yet (it waits for its wave,
 * or for the other branch of a fan-in). `skipped`: a cap refused the visit.
 */
export type PipelineNodeStatus = 'idle' | 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

/** What the node's own agent is doing right now, in one line's worth. */
export interface PipelineNodeActivity {
  phase?: 'plan' | 'execute' | 'replan' | 'synthesize'
  /** The plan step in progress, with its place in the plan (1-based, as the core counts). */
  step?: string
  stepIndex?: number
  stepTotal?: number
  /** The tool being called, while it runs. */
  tool?: string
  /** Tool calls made in this visit so far. */
  toolCalls: number
}

export interface PipelineOutputView {
  visit: number
  text: string
  route?: string
}

export interface PipelineNodeView {
  status: PipelineNodeStatus
  /** Visits started. */
  visits: number
  /** The nodes whose outputs the current (or last) visit received. */
  from: string[]
  /** One entry per finished visit, in order. */
  outputs: PipelineOutputView[]
  activity?: PipelineNodeActivity
  error?: string
  /** Why the last activation was refused. */
  skipped?: 'maxRuns' | 'maxNodeVisits'
  /** Tokens of all its finished visits. */
  usage?: IUsage
}

export interface PipelineEdgeView {
  from: string
  to: string
  /** The last decision. */
  fired: boolean
  /** The visit of the source node that decided it. */
  visit: number
  /** How many times it fired in this run. */
  count: number
  /** It fired and what it carries has not been consumed yet: the target waits or runs. */
  live: boolean
}

/** One node visit, in the order visits started: the run as a timeline. */
export interface PipelineVisitView {
  nodeId: string
  visit: number
  from: string[]
  status: 'running' | 'done' | 'failed' | 'stopped'
  text?: string
  route?: string
  error?: string
  usage?: IUsage
}

export interface PipelineUiState {
  status: PipelineRunStatus
  /** The request of the current (or last) run. */
  input?: string
  /** The definition's name, as the run reported it. */
  name?: string
  /** By node id. A node the run has not touched is absent: read it with `pipelineNodeView`. */
  nodes: Record<string, PipelineNodeView>
  /** By edge id: the last decision on each edge that was decided. */
  edges: Record<string, PipelineEdgeView>
  /** The edges the node that finished last fired. */
  lastFired: string[]
  visits: PipelineVisitView[]
  /** The final text (set when the run ends). */
  text: string
  usage: IUsage
  /** Node visits started. */
  runs: number
  stoppedBy?: PipelineStop
  error?: string
  /** The node whose failure ended the run. */
  failedNode?: string
}

export type PipelineAction =
  | { type: 'run.start'; input: string }
  | { type: 'event'; event: AgentEvent }
  /** `run` resolved. */
  | { type: 'run.result'; result: PipelineResult }
  /** `run` rejected, or could not start. */
  | { type: 'run.error'; error: string; nodeId?: string }
  | { type: 'reset' }

const ZERO: IUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

const IDLE_NODE: PipelineNodeView = { status: 'idle', visits: 0, from: [], outputs: [] }

export const createInitialPipelineState = (): PipelineUiState => ({
  status: 'idle',
  nodes: {},
  edges: {},
  lastFired: [],
  visits: [],
  text: '',
  usage: ZERO,
  runs: 0,
})

/** A node's view; an idle one for a node the run has not touched. */
export const pipelineNodeView = (state: PipelineUiState, nodeId: string): PipelineNodeView =>
  state.nodes[nodeId] ?? IDLE_NODE

const sum = (a: IUsage | undefined, b: IUsage | undefined): IUsage => {
  const out: Record<string, number> = { ...(a ?? ZERO) }
  for (const [key, value] of Object.entries(b ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = (out[key] ?? 0) + value
  }
  return out as unknown as IUsage
}

const withNode = (
  state: PipelineUiState,
  nodeId: string,
  patch: (node: PipelineNodeView) => PipelineNodeView,
): PipelineUiState => ({
  ...state,
  nodes: { ...state.nodes, [nodeId]: patch(pipelineNodeView(state, nodeId)) },
})

// The run is over: nothing waits or runs any more, and no edge carries anything.
const settle = (state: PipelineUiState, visitStatus: 'stopped' | 'done'): PipelineUiState => {
  const nodes: PipelineUiState['nodes'] = {}
  for (const [id, node] of Object.entries(state.nodes)) {
    if (node.status === 'running' || node.status === 'waiting') {
      const { activity, ...rest } = node
      void activity
      nodes[id] = { ...rest, status: node.outputs.length > 0 ? 'done' : 'idle' }
    } else {
      nodes[id] = node
    }
  }
  const edges: PipelineUiState['edges'] = {}
  for (const [id, edge] of Object.entries(state.edges)) {
    edges[id] = edge.live ? { ...edge, live: false } : edge
  }
  return {
    ...state,
    nodes,
    edges,
    visits: state.visits.map((v) => (v.status === 'running' ? { ...v, status: visitStatus } : v)),
  }
}

const quiet = (state: PipelineUiState, to: string): PipelineUiState['edges'] => {
  let edges = state.edges
  for (const [id, edge] of Object.entries(state.edges)) {
    if (edge.live && edge.to === to) {
      if (edges === state.edges) edges = { ...state.edges }
      edges[id] = { ...edge, live: false }
    }
  }
  return edges
}

const patchVisit = (
  visits: PipelineVisitView[],
  nodeId: string,
  visit: number,
  patch: Partial<PipelineVisitView>,
): PipelineVisitView[] =>
  visits.map((v) => (v.nodeId === nodeId && v.visit === visit ? { ...v, ...patch } : v))

// An event of a node's own agent: keep one line of it.
const activityOf = (
  current: PipelineNodeActivity | undefined,
  event: AgentEvent,
): PipelineNodeActivity | undefined => {
  const base = current ?? { toolCalls: 0 }
  switch (event.type) {
    case 'run.start':
      return { phase: 'plan', toolCalls: 0 }
    case 'step.start':
      return {
        phase: 'execute',
        step: event.step.description,
        stepIndex: event.index,
        stepTotal: event.total,
        toolCalls: base.toolCalls,
      }
    case 'step.tool-call':
      return { ...base, phase: 'execute', tool: event.name, toolCalls: base.toolCalls + 1 }
    case 'step.tool-result':
    case 'step.complete': {
      if (base.tool === undefined) return current
      const { tool, ...rest } = base
      void tool
      return rest
    }
    case 'replan.decision':
      return base.phase === 'replan' && base.tool === undefined
        ? current
        : { toolCalls: base.toolCalls, phase: 'replan' }
    case 'final.text-delta':
    case 'final.reasoning-delta':
      return base.phase === 'synthesize'
        ? current
        : { toolCalls: base.toolCalls, phase: 'synthesize' }
    default:
      return current
  }
}

const reduceEvent = (state: PipelineUiState, event: AgentEvent): PipelineUiState => {
  switch (event.type) {
    case 'pipeline.started':
      return event.pipeline === state.name ? state : { ...state, name: event.pipeline }

    case 'pipeline.node.started': {
      const next = withNode(state, event.nodeId, (node) => {
        const { error, skipped, activity, ...rest } = node
        void [error, skipped, activity]
        return { ...rest, status: 'running', visits: event.visit, from: event.from }
      })
      return {
        ...next,
        runs: state.runs + 1,
        visits: [
          ...state.visits,
          { nodeId: event.nodeId, visit: event.visit, from: event.from, status: 'running' },
        ],
      }
    }

    case 'pipeline.node.finished': {
      const output: PipelineOutputView = {
        visit: event.visit,
        text: event.text,
        ...(event.route !== undefined ? { route: event.route } : {}),
      }
      const next = withNode(state, event.nodeId, (node) => {
        const { activity, ...rest } = node
        void activity
        return {
          ...rest,
          status: 'done',
          outputs: [...node.outputs, output],
          ...(event.usage ? { usage: sum(node.usage, event.usage as IUsage) } : {}),
        }
      })
      return {
        ...next,
        edges: quiet(state, event.nodeId),
        lastFired: [],
        usage: sum(state.usage, event.usage as IUsage | undefined),
        visits: patchVisit(state.visits, event.nodeId, event.visit, {
          status: 'done',
          text: event.text,
          ...(event.route !== undefined ? { route: event.route } : {}),
          ...(event.usage ? { usage: event.usage as IUsage } : {}),
        }),
      }
    }

    case 'pipeline.node.failed': {
      const settled = settle(
        {
          ...state,
          visits: patchVisit(state.visits, event.nodeId, event.visit, {
            status: 'failed',
            error: event.error,
          }),
        },
        'stopped',
      )
      const next = withNode(settled, event.nodeId, (node) => {
        const { activity, ...rest } = node
        void activity
        return { ...rest, status: 'failed', error: event.error }
      })
      return { ...next, status: 'failed', error: event.error, failedNode: event.nodeId }
    }

    case 'pipeline.node.skipped': {
      const next = withNode(state, event.nodeId, (node) => ({
        ...node,
        status: 'skipped',
        skipped: event.reason,
        from: event.from,
      }))
      return { ...next, edges: quiet(state, event.nodeId) }
    }

    case 'pipeline.edge': {
      const before = state.edges[event.edgeId]
      const edge: PipelineEdgeView = {
        from: event.from,
        to: event.to,
        fired: event.fired,
        visit: event.visit,
        count: (before?.count ?? 0) + (event.fired ? 1 : 0),
        live: event.fired,
      }
      const next: PipelineUiState = {
        ...state,
        edges: { ...state.edges, [event.edgeId]: edge },
        lastFired: event.fired ? [...state.lastFired, event.edgeId] : state.lastFired,
      }
      if (!event.fired) return next
      const target = pipelineNodeView(next, event.to)
      // A node that is running takes this output in a later visit; its status stays.
      if (target.status === 'running' || target.status === 'waiting') return next
      return withNode(next, event.to, (node) => ({ ...node, status: 'waiting' }))
    }

    case 'pipeline.finished': {
      const settled = settle(state, event.stoppedBy === 'aborted' ? 'stopped' : 'done')
      const { stoppedBy, ...rest } = settled
      void stoppedBy
      return {
        ...rest,
        status: event.stoppedBy === 'aborted' ? 'stopped' : 'done',
        runs: event.runs,
        ...(event.stoppedBy ? { stoppedBy: event.stoppedBy } : {}),
      }
    }

    default: {
      // Everything else is an event of one node's own agent.
      if (event.nodeId === undefined) return state
      const node = state.nodes[event.nodeId]
      if (!node || node.status !== 'running') return state
      const activity = activityOf(node.activity, event)
      if (activity === node.activity) return state
      return withNode(state, event.nodeId, (n) => ({ ...n, activity }))
    }
  }
}

/** Fold one action into the state. Returns the same object when nothing changed. */
export const pipelineStateReducer = (
  state: PipelineUiState,
  action: PipelineAction,
): PipelineUiState => {
  switch (action.type) {
    case 'reset':
      return createInitialPipelineState()
    case 'run.start':
      return { ...createInitialPipelineState(), status: 'running', input: action.input }
    case 'event':
      return reduceEvent(state, action.event)
    case 'run.result': {
      const { result } = action
      const settled = state.status === 'running' ? settle(state, 'done') : state
      const { stoppedBy, ...rest } = settled
      void stoppedBy
      return {
        ...rest,
        status:
          state.status === 'running'
            ? result.stoppedBy === 'aborted'
              ? 'stopped'
              : 'done'
            : state.status,
        text: result.text,
        usage: result.usage as IUsage,
        runs: result.runs,
        ...(result.stoppedBy ? { stoppedBy: result.stoppedBy } : {}),
      }
    }
    case 'run.error': {
      const settled = settle(state, 'stopped')
      return {
        ...settled,
        status: 'failed',
        // The node's own words (from `pipeline.node.failed`) say more than the wrapper's.
        error: state.error ?? action.error,
        ...(action.nodeId && !state.failedNode ? { failedNode: action.nodeId } : {}),
      }
    }
  }
}
