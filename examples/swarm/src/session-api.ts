// The session workflow's Temporal API: the workflow types, the signals they take and the queries
// they answer, the patch ids. Shared by the workflows (handlers) and the gateway's backend
// (callers). `define*` are plain values, safe outside the workflow sandbox. The ids and stream keys
// a session names things by are platform-free: `swarm-shared` (session-ids.ts).
import { defineQuery, defineSignal } from '@temporalio/workflow'
import type {
  IAnswer,
  IChildParkNotice,
  IChildView,
  ISessionView,
  IStopRequest,
  IUserMessage,
} from 'swarm-shared/workflow'

export const SESSION_WORKFLOW = 'session'

// The child workflow that runs one static subagent call (one item of a parked turn).
export const SUBAGENT_WORKFLOW = 'subagent'

// The child workflow that runs one pipeline call (one item of a parked turn): the pipeline's
// graph engine is its scheduler, and every node visit is a child workflow of its own.
export const PIPELINE_WORKFLOW = 'pipeline'
export const PIPELINE_NODE_WORKFLOW = 'pipelineNode'

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
