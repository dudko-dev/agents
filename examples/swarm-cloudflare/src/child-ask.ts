// CHILD_ASK: what an "ask" of a child's approval mode does - a static subagent child's and a
// pipeline node visit's alike (examples/swarm's child-ask.ts). 'park': the child's run parks and
// its Workflow instance waits for a person's answer through the gateway; 'deny': an ask is a
// denial (the agent has no onRequest at all). Every child here may wait (there is no older child
// that could not), so 'park' always parks.
import type { IAgentConfig } from '@dudko.dev/agent'

export type ChildAsk = 'park' | 'deny'
export const CHILD_ASKS: readonly ChildAsk[] = ['park', 'deny']

// A child agent's approval config: the worker's mode and rules, and - under 'park' - the onRequest
// that parks. Without a mode or rules there is nothing to ask, so nothing to add.
export const childApproval = (
  base: IAgentConfig,
  ask: ChildAsk,
): Pick<IAgentConfig, 'toolApproval'> =>
  base.toolApproval
    ? {
        toolApproval: {
          ...(base.toolApproval.mode ? { mode: base.toolApproval.mode } : {}),
          ...(base.toolApproval.rules ? { rules: base.toolApproval.rules } : {}),
          ...(ask === 'park' ? { onRequest: () => ({ park: true as const }) } : {}),
        },
      }
    : {}
