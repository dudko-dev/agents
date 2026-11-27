import type {
  ToolApprovalContext,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '@dudko.dev/agent-web'

/** The consent requests waiting for a person, by request id. */
export interface ApprovalQueue {
  /**
   * The core's `toolApproval.onRequest`: resolves when `approve` / `deny` is called. A request
   * the core stops waiting for (`ctx.signal`: its `timeoutMs` ran out, the run stopped) leaves
   * the queue at once, so no stale answer is kept for it.
   */
  handler: (req: ToolApprovalRequest, ctx?: ToolApprovalContext) => Promise<ToolApprovalDecision>
  /** Allow one. False when no such request is waiting (answered, expired, settled). */
  approve: (id: string, options?: { remember?: boolean }) => boolean
  /** Deny one. False when no such request is waiting. */
  deny: (id: string, reason?: string) => boolean
  /** Answer every waiting request with `decision` (the run ended, the view closed). */
  settleAll: (decision: ToolApprovalDecision) => void
  /** The ids of the requests waiting, oldest first. */
  pending: () => string[]
}

/**
 * The queue behind `useAgent`'s `approve` / `deny`: `request.id → resolver`. A request leaves it
 * exactly once - answered, settled by `settleAll`, or dropped when the core no longer wants the
 * answer (its signal aborted; the core has already denied the call and said so in its event).
 */
export const createApprovalQueue = (): ApprovalQueue => {
  const waiting = new Map<string, (decision: ToolApprovalDecision) => void>()

  const handler: ApprovalQueue['handler'] = (req, ctx) =>
    new Promise<ToolApprovalDecision>((resolve) => {
      const signal = ctx?.signal
      if (signal?.aborted) {
        resolve({ approved: false, reason: 'no longer asked' })
        return
      }
      const onAbort = (): void => {
        if (waiting.get(req.id) !== settle) return
        settle({ approved: false, reason: 'no longer asked' })
      }
      // Called only for the request in the map (every caller looks it up first): exactly once.
      const settle = (decision: ToolApprovalDecision): void => {
        waiting.delete(req.id)
        signal?.removeEventListener('abort', onAbort)
        resolve(decision)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiting.set(req.id, settle)
    })

  const answer = (id: string, decision: ToolApprovalDecision): boolean => {
    const settle = waiting.get(id)
    if (!settle) return false
    settle(decision)
    return true
  }

  return {
    handler,
    approve: (id, options) => answer(id, { approved: true, remember: options?.remember }),
    deny: (id, reason) => answer(id, { approved: false, reason }),
    settleAll: (decision) => {
      for (const settle of [...waiting.values()]) settle(decision)
    },
    pending: () => [...waiting.keys()],
  }
}
