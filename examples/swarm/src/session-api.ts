// The session workflow's API: its name, the signals it takes and the query it answers. Shared by
// the workflow (handlers) and the gateway (callers). `define*` are plain values, safe outside the
// workflow sandbox.
import { defineQuery, defineSignal } from '@temporalio/workflow'
import type {
  IAnswer,
  IChildParkNotice,
  IChildView,
  ISessionView,
  IStopRequest,
  IUserMessage,
} from './session-types.ts'

export const SESSION_WORKFLOW = 'session'

// A workflow id per session: the prefix keeps them apart from anything else in the namespace.
export const workflowIdOf = (sessionId: string): string => `session-${sessionId}`

// The child workflow that runs one static subagent call (one item of a parked turn).
export const SUBAGENT_WORKFLOW = 'subagent'

// Its id is a function of the session, the parent run and the item (the core's item id is stable
// across attempts): a replayed or retried start names the same child, never a second one.
export const subagentWorkflowIdOf = (sessionId: string, runId: string, itemId: string): string =>
  `subagent-${sessionId}-${runId}-${itemId}`

// The child's own stream: its run (swarm_runs) and its events (swarm_events) are keyed by this in
// place of a session id, so they never mix with the parent turn's order.
export const subagentStreamOf = (sessionId: string, itemId: string): string =>
  `${sessionId}/${itemId}`

// The child workflow that runs one pipeline call (one item of a parked turn): the pipeline's
// graph engine is its scheduler, and every node visit is a child workflow of its own.
export const PIPELINE_WORKFLOW = 'pipeline'
export const PIPELINE_NODE_WORKFLOW = 'pipelineNode'

// Named like a subagent's child: from the session, the parent run and the item.
export const pipelineWorkflowIdOf = (sessionId: string, runId: string, itemId: string): string =>
  `pipeline-${sessionId}-${runId}-${itemId}`

// The pipeline's own stream (the engine's pipeline.* events): keyed like a subagent child's.
export const pipelineStreamOf = (sessionId: string, itemId: string): string =>
  `${sessionId}/${itemId}`

// A node visit's child workflow: the pipeline's id, the node and the visit. A node id has no '.'
// (pipelines.ts refuses one), so the parts never run into each other.
export const pipelineNodeWorkflowIdOf = (
  pipelineWorkflowId: string,
  nodeId: string,
  visit: number,
): string => `${pipelineWorkflowId}.${nodeId}.${visit}`

// A node visit's own stream: its run (swarm_runs) and its events (swarm_events).
export const pipelineNodeStreamOf = (
  sessionId: string,
  itemId: string,
  nodeId: string,
  visit: number,
): string => `${sessionId}/${itemId}/${nodeId}/${visit}`

// Where the gateway serves those streams.
export const pipelineEventsPath = (sessionId: string, itemId: string): string =>
  `/sessions/${sessionId}/pipelines/${itemId}/events`
export const pipelineNodeEventsPath = (
  sessionId: string,
  itemId: string,
  nodeId: string,
  visit: number,
): string => `/sessions/${sessionId}/pipelines/${itemId}/nodes/${nodeId}/${visit}/events`

// The child workflow that waits for an item of the session: a subagent child, or a pipeline's
// node visit (named from the pipeline's id, the node and the visit). A pure function of the
// session, the parked turn's run and its item - what the gateway recomputes to check that the
// child an item names is one of THIS session's before it signals it.
export const childWorkflowIdOf = (
  sessionId: string,
  runId: string,
  itemId: string,
  node?: { nodeId: string; visit: number },
): string =>
  node
    ? pipelineNodeWorkflowIdOf(
        pipelineWorkflowIdOf(sessionId, runId, itemId),
        node.nodeId,
        node.visit,
      )
    : subagentWorkflowIdOf(sessionId, runId, itemId)

// patched() ids of the session workflow: a running session replays without them, a new one gets
// them (sessions live for days).
export const PATCH_SUBAGENTS = 'swarm-subagent-children-v1'
export const PATCH_PIPELINES = 'swarm-pipeline-children-v1'
// A child that waits for a person (subagent, pipelineNode): its run parks, the workflow waits for
// the answers and resumes it; and the session's markers about it (`*.waiting` / `*.resumed`).
export const PATCH_CHILD_PARKING = 'swarm-child-parking-v1'

// Signals, not updates: a signal is accepted by the server even while no worker runs, so the
// gateway answers at once and a swarm scaled to zero still takes messages.
export const messageSignal = defineSignal<[IUserMessage]>('message')
// The answer to an item: to the session (its turn's item), or to the child workflow that waits
// for it (a subagent child, a pipeline's node visit) - the gateway signals the item's owner.
export const answerSignal = defineSignal<[IAnswer]>('answer')
export const stopSignal = defineSignal<[IStopRequest]>('stop')
export const stateQuery = defineQuery<ISessionView>('state')
// A child of a parked turn to the session: it waits for a person, or it goes on.
export const childParkSignal = defineSignal<[IChildParkNotice]>('childPark')
// A child workflow's own state (subagent, pipelineNode).
export const childStateQuery = defineQuery<IChildView>('childState')

// The activity error type the session never retries: a refusal (a limit, refused credentials)
// will refuse again.
export const TURN_REFUSED = 'TurnRefused'
