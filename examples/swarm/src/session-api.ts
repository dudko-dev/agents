// The session workflow's API: its name, the signals it takes and the query it answers. Shared by
// the workflow (handlers) and the gateway (callers). `define*` are plain values, safe outside the
// workflow sandbox.
import { defineQuery, defineSignal } from '@temporalio/workflow'
import type { IAnswer, ISessionView, IStopRequest, IUserMessage } from './session-types.ts'

export const SESSION_WORKFLOW = 'session'

// A workflow id per session: the prefix keeps them apart from anything else in the namespace.
export const workflowIdOf = (sessionId: string): string => `session-${sessionId}`

// Signals, not updates: a signal is accepted by the server even while no worker runs, so the
// gateway answers at once and a swarm scaled to zero still takes messages.
export const messageSignal = defineSignal<[IUserMessage]>('message')
export const answerSignal = defineSignal<[IAnswer]>('answer')
export const stopSignal = defineSignal<[IStopRequest]>('stop')
export const stateQuery = defineQuery<ISessionView>('state')

// The activity error type the session never retries: a refusal (a limit, refused credentials)
// will refuse again.
export const TURN_REFUSED = 'TurnRefused'
