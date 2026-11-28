// The pipeline workflow's logic as plain functions over plain data, like session-state.ts for the
// session: no Temporal, no clock, no randomness. `workflows.ts` (`pipeline`) runs the core's graph
// engine (`runPipelineGraph`, from `@dudko.dev/agent/pipeline-engine` - deterministic by contract)
// as its scheduler, and wires these to the node children and the stream activity.
import type {
  PipelineEvent,
  PipelineNode,
  PipelineNodeInput,
  PipelineNodeOutput,
  PipelineResult,
} from '@dudko.dev/agent/pipeline-engine'
import type { IUsage } from '@dudko.dev/agent'
import {
  pipelineNodeEventsPath,
  pipelineNodeStreamOf,
  pipelineNodeWorkflowIdOf,
} from './session-api.ts'
import type {
  IPipelineInput,
  IPipelineNodeInput,
  IStreamBatch,
  PipelineNodeOutcome,
  PipelineOutcome,
} from './session-types.ts'

// A pipeline's answer (and a node's text), as the parent's item and Temporal carry it - the same
// bound as a subagent's answer.
export const PIPELINE_TEXT_MAX_CHARS = 32_000
// Events per write of the pipeline's own stream (one activity): a node's text is in its
// pipeline.node.finished event, so a batch stays well under Temporal's payload limit.
export const STREAM_BATCH_MAX = 50
// An error as the item's answer carries it.
export const PIPELINE_ERROR_MAX_CHARS = 2_000

export const emptyUsage = (): IUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })

// a + b, every numeric field (what the engine does for result.usage; the core's addUsage is not
// importable in the workflow sandbox).
export const sumUsage = (a: IUsage, b: IUsage | undefined): IUsage => {
  const out = { ...a } as unknown as Record<string, number>
  for (const [k, v] of Object.entries(b ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = (out[k] ?? 0) + v
  }
  return out as unknown as IUsage
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

// What `runPipelineGraph` reads of a signal: `aborted` and add / removeEventListener('abort'). The
// workflow aborts it when its cancellation scope is cancelled (a session stop). Listeners run in
// the order they were added, once; one that throws does not stop the others.
export interface IAbortLatch {
  signal: AbortSignal
  abort: () => void
}

type Listener = (event: { type: 'abort' }) => void

export const createAbortLatch = (): IAbortLatch => {
  const listeners: Listener[] = []
  const signal = {
    aborted: false,
    addEventListener: (type: string, fn: Listener): void => {
      if (type === 'abort' && !listeners.includes(fn)) listeners.push(fn)
    },
    removeEventListener: (type: string, fn: Listener): void => {
      const at = listeners.indexOf(fn)
      if (type === 'abort' && at >= 0) listeners.splice(at, 1)
    },
  }
  return {
    signal: signal as unknown as AbortSignal,
    abort: () => {
      if (signal.aborted) return
      signal.aborted = true
      for (const fn of listeners.splice(0)) {
        try {
          fn({ type: 'abort' })
        } catch {
          // A listener's failure is its own.
        }
      }
    },
  }
}

// The pipeline's own stream: the engine's events in the order it emits them, numbered from 1 (the
// stream's (turn 1, attempt 1, seq) order), waiting to be written. The workflow writes them through
// ONE activity at a time, each write taking everything queued since the last one: a wave's
// `pipeline.node.started` events go together, a settled visit's `finished` + `edge` events (and
// the next wave's starts) together. Which events land in which batch depends only on the
// activations the workflow replays, so the writes - commands - replay the same; and a write
// that waits for the one before it keeps the stream in order.
export interface IStreamLog {
  push: (event: PipelineEvent) => void
  // The next batch (at most STREAM_BATCH_MAX events), or undefined when nothing waits.
  take: () => IStreamBatch | undefined
  pending: () => number
}

// An engine event as the stream stores it: `pipeline.node.started` also names the visit's child
// workflow and its own stream (`events`), the way subagent.started names a child's.
export const streamEventOf = (
  input: Pick<IPipelineInput, 'sessionId' | 'itemId' | 'workflowId'>,
  event: PipelineEvent,
): IStreamBatch['events'][number]['event'] =>
  event.type === 'pipeline.node.started'
    ? {
        ...event,
        workflowId: pipelineNodeWorkflowIdOf(input.workflowId, event.nodeId, event.visit),
        events: pipelineNodeEventsPath(input.sessionId, input.itemId, event.nodeId, event.visit),
      }
    : { ...event }

export const createStreamLog = (
  input: Pick<IPipelineInput, 'sessionId' | 'itemId' | 'workflowId' | 'stream'>,
): IStreamLog => {
  const queue: IStreamBatch['events'] = []
  let seq = 0
  return {
    push: (event) => {
      seq += 1
      queue.push({ seq, event: streamEventOf(input, event) })
    },
    take: () =>
      queue.length
        ? { stream: input.stream, events: queue.splice(0, STREAM_BATCH_MAX) }
        : undefined,
    pending: () => queue.length,
  }
}

// What a node visit's child workflow is given.
export const nodeInputOf = (
  input: IPipelineInput,
  node: PipelineNode,
  nodeInput: PipelineNodeInput,
): IPipelineNodeInput => ({
  sessionId: input.sessionId,
  turn: input.turn,
  itemId: input.itemId,
  pipeline: input.name,
  workflowId: pipelineNodeWorkflowIdOf(input.workflowId, node.id, nodeInput.visit),
  stream: pipelineNodeStreamOf(input.sessionId, input.itemId, node.id, nodeInput.visit),
  node,
  input: nodeInput,
  options: input.options,
})

// The node visits a pipeline started, and what the finished ones spent: the outcome carries them
// whatever happened (the engine's own result is gone when a node failed or the run was stopped).
export interface ITally {
  runs: number
  usage: IUsage
}

// A node visit's outcome, as the engine takes it: its text (clipped as an answer is), usage and
// route - or a throw, which fails the pipeline (the engine's rule).
export const nodeOutputOf = (outcome: PipelineNodeOutcome): PipelineNodeOutput => {
  if (outcome.status === 'completed') {
    return {
      text: clip(outcome.text, PIPELINE_TEXT_MAX_CHARS),
      usage: outcome.usage,
      ...(outcome.route ? { route: outcome.route } : {}),
    }
  }
  // The engine's PipelineNodeError names the node and the visit; this is the reason.
  throw new Error(
    outcome.status === 'stopped' ? 'the visit was stopped before it answered' : outcome.error,
  )
}

// The engine's result, as the pipeline's outcome. `stoppedBy` 'aborted' never gets here: the
// workflow runs the engine with onAbort 'reject'.
export const completedOutcomeOf = (result: PipelineResult, tally: ITally): PipelineOutcome => ({
  status: 'completed',
  text: clip(result.text, PIPELINE_TEXT_MAX_CHARS),
  usage: tally.usage,
  runs: result.runs,
  ...(result.stoppedBy === 'maxRuns' || result.stoppedBy === 'maxNodeVisits'
    ? { stoppedBy: result.stoppedBy }
    : {}),
})

// A failure: the engine's PipelineNodeError names the node and the visit (compared by name - the
// engine subpath's classes are copies, not the main entry's), anything else is the pipeline's own.
export const failedOutcomeOf = (err: unknown, tally: ITally): PipelineOutcome => {
  const e = err as { name?: string; message?: string; nodeId?: unknown; visit?: unknown }
  const message = clip(
    (typeof e?.message === 'string' && e.message) || String(err),
    PIPELINE_ERROR_MAX_CHARS,
  )
  return {
    status: 'failed',
    error: message,
    runs: tally.runs,
    usage: tally.usage,
    ...(e?.name === 'PipelineNodeError' && typeof e.nodeId === 'string'
      ? { nodeId: e.nodeId, ...(typeof e.visit === 'number' ? { visit: e.visit } : {}) }
      : {}),
  }
}

// The engine's abort error (onAbort 'reject'): an Error named AbortError where the sandbox has no
// DOMException.
export const isAbortError = (err: unknown): boolean =>
  (err as { name?: unknown } | undefined)?.name === 'AbortError'
