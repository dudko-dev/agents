// A child workflow's wait for a person, as plain functions over plain data - like session-state.ts
// for the session: no Temporal, no clock (the workflow passes `now`), no randomness. A child
// (`subagent`, or a pipeline's `pipelineNode`) whose run parks (an "ask" of the approval mode, a
// deferred tool result) holds no worker slot: its workflow keeps the items here, takes the
// answers the gateway signals - each one checked by its kind (answers.ts), the workflow being the
// authority - and resumes the SAME run once every item has its answer. A partial answer keeps it
// waiting; a resume that parks again waits again.
import { answerProblem } from './answers.ts'
import type { IAnswer, IChildParked, IChildView, IParkedRequest } from './session-types.ts'

// Answers kept while the child does not wait (one that came before the workflow learned of the
// park: the client may be faster), bounded so that answers nobody asked for cannot grow the state.
export const CHILD_ANSWERS_KEPT = 100

export interface IChildWait {
  parked?: { runId: string; requests: IParkedRequest[]; since: number }
  answers: Record<string, IAnswer>
  // The child is over (ended, stopped): it takes no answer any more.
  closed: boolean
  // How many times its run parked.
  parks: number
}

export const initialChildWait = (): IChildWait => ({ answers: {}, closed: false, parks: 0 })

export type ChildAnswerVerdict = 'accepted' | 'early' | 'refused'

// Why the child cannot take this answer for this request (undefined: it can). A child's items are
// answered by a client only (a child has no children of its own).
const refusalOf = (request: IParkedRequest, answer: IAnswer): string | undefined => {
  if (answer.by !== undefined && answer.by !== 'client') {
    return 'a client answers a child item'
  }
  return answerProblem(request.kind, answer.value)
}

// A client's answer (the gateway checked it already; this is the authority). While the child
// waits it must name one of its items and fit its kind. While it runs it is kept (checked when
// the park arrives), bounded. Once the child is over, nothing is taken.
export const acceptChildAnswer = (w: IChildWait, answer: IAnswer): ChildAnswerVerdict => {
  if (w.closed) {
    return 'refused'
  }
  if (w.parked) {
    const request = w.parked.requests.find((r) => r.requestId === answer.requestId)
    if (!request || refusalOf(request, answer)) {
      return 'refused'
    }
    w.answers[answer.requestId] = answer
    return 'accepted'
  }
  if (answer.by !== undefined && answer.by !== 'client') {
    return 'refused'
  }
  w.answers[answer.requestId] = answer
  const ids = Object.keys(w.answers)
  for (const id of ids.slice(0, Math.max(0, ids.length - CHILD_ANSWERS_KEPT))) {
    delete w.answers[id]
  }
  return 'early'
}

// The run parked: the child waits for every item. An answer that came early is kept only where
// it fits its item; anything else is dropped (no other park is open).
export const childParked = (w: IChildWait, parked: IChildParked, now: number): void => {
  w.parked = { runId: parked.runId, requests: parked.requests, since: now }
  w.parks += 1
  for (const id of Object.keys(w.answers)) {
    const request = parked.requests.find((r) => r.requestId === id)
    if (!request || refusalOf(request, w.answers[id]!)) {
      delete w.answers[id]
    }
  }
}

// The child may go on once EVERY item it waits for has an answer.
export const childReady = (w: IChildWait): boolean =>
  Boolean(!w.closed && w.parked && w.parked.requests.every((r) => w.answers[r.requestId]))

// The answers the resume takes (one per item), and the child runs again.
export const takeChildAnswers = (w: IChildWait): Record<string, IAnswer> => {
  const parked = w.parked
  delete w.parked
  const out: Record<string, IAnswer> = {}
  for (const r of parked?.requests ?? []) {
    const answer = w.answers[r.requestId]
    if (answer) {
      out[r.requestId] = answer
    }
    delete w.answers[r.requestId]
  }
  return out
}

// The child is over: whatever it waited for is closed with it.
export const closeChildWait = (w: IChildWait): void => {
  w.closed = true
  delete w.parked
  w.answers = {}
}

export const childView = (w: IChildWait): IChildView => ({
  status: w.closed ? 'ended' : w.parked ? 'waiting' : 'running',
  parks: w.parks,
  ...(w.parked
    ? {
        parked: {
          runId: w.parked.runId,
          requests: w.parked.requests,
          answered: w.parked.requests
            .map((r) => r.requestId)
            .filter((id) => w.answers[id] !== undefined),
        },
      }
    : {}),
})
