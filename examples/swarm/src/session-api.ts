// The session workflow's API: its name, the signals it takes and the query it answers. Shared by
// the workflow (handlers) and the gateway (callers). `define*` are plain values, safe outside the
// workflow sandbox.
import { defineQuery, defineSignal } from '@temporalio/workflow'
import type { IAnswer, ISessionView, IStopRequest, IUserMessage } from './session-types.ts'

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

// patched() ids of the session workflow: a running session replays without them, a new one gets
// them (sessions live for days).
export const PATCH_SUBAGENTS = 'swarm-subagent-children-v1'

// Signals, not updates: a signal is accepted by the server even while no worker runs, so the
// gateway answers at once and a swarm scaled to zero still takes messages.
export const messageSignal = defineSignal<[IUserMessage]>('message')
export const answerSignal = defineSignal<[IAnswer]>('answer')
export const stopSignal = defineSignal<[IStopRequest]>('stop')
export const stateQuery = defineQuery<ISessionView>('state')

// The activity error type the session never retries: a refusal (a limit, refused credentials)
// will refuse again.
export const TURN_REFUSED = 'TurnRefused'
