// CHILD_ASK: what an "ask" of a child's approval mode does - a static subagent child's and a
// pipeline node visit's alike (subagents.ts, pipelines.ts build their agents with it).
import type { IAgentConfig, ToolApprovalDecision } from '@dudko.dev/agent'
import { currentTurnScope } from './lease.ts'

// CHILD_ASK (worker): 'park': the child's run parks and its workflow waits for a person's
// answer; 'deny': an ask is a denial (the agent has no onRequest at all, as before child parking).
export type ChildAsk = 'park' | 'deny'
export const CHILD_ASKS: readonly ChildAsk[] = ['park', 'deny']

// Why a child's ask is a denial although CHILD_ASK=park: its workflow does not wait (a child
// started before child parking: its activity is not told it may park).
export const CHILD_CANNOT_WAIT = 'nobody to ask: this child cannot wait for an answer'

// A child agent's onRequest under CHILD_ASK=park: park the child's run when its turn scope says
// the child workflow waits for answers (activities.ts sets it from the workflow's `park`), else
// deny. One agent serves every child of its profile, so the decision is per run, not per agent.
export const childAskDecision = (): ToolApprovalDecision =>
  currentTurnScope()?.mayPark ? { park: true } : { approved: false, reason: CHILD_CANNOT_WAIT }

// A child agent's approval config: the worker's mode and rules, and - under 'park' - the onRequest
// that parks. Without a mode or rules of the worker there is nothing to ask, so nothing to add.
export const childApproval = (
  base: IAgentConfig,
  ask: ChildAsk,
): Pick<IAgentConfig, 'toolApproval'> =>
  base.toolApproval
    ? {
        toolApproval: {
          ...(base.toolApproval.mode ? { mode: base.toolApproval.mode } : {}),
          ...(base.toolApproval.rules ? { rules: base.toolApproval.rules } : {}),
          ...(ask === 'park' ? { onRequest: childAskDecision } : {}),
        },
      }
    : {}
