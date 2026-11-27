import type {
  McpElicitationContext,
  McpElicitationRequest,
  McpElicitationResult,
} from '../mcp-elicitation.ts'
import type { IToolApprovalContext, IToolApprovalRequest, ToolApprovalDecision } from '../types.ts'
import { answerElicitationAtPrompt } from './elicit.ts'

// The questions the REPL puts to the person while a run goes - tool approvals and MCP
// elicitations - one at a time, at the one prompt. Pure but for the `question` and `print` it is
// given (the REPL's readline and console), so it is tested without a terminal.
//
// A question the agent no longer wants - its signal aborted: the bound ran out (a tool
// approval's `timeoutMs`, an elicitation's), the run was stopped - is closed at once with one
// line that says why; one still waiting for its turn is never shown. Either way the next
// question is not stuck behind it. The line is printed before the agent's own event for that
// question (the core aborts the signal first), and `closedAtPrompt` lets the REPL skip the event's
// line, which would say the same thing again.

/**
 * `readline/promises`' `question`: rejects when `signal` aborts - and at once, without writing
 * the prompt, if it already has. That is what keeps a question no longer wanted by the time its
 * turn comes off the screen.
 */
export type AskLine = (prompt: string, options: { signal: AbortSignal }) => Promise<string>

export interface IPromptQuestionsDeps {
  question: AskLine
  /** One line of the REPL's own (the closing line). */
  print: (line: string) => void
  /** Called right before a question is shown (ends a line the model was streaming). */
  beforeAsk?: () => void
  /**
   * The run's stop, read when a question is shown: says whether a closed question was ended by
   * Ctrl-C. (It is the agent's signal that closes it - a stop aborts that one too.)
   */
  runSignal?: () => AbortSignal | undefined
  /** The text of an approval question. */
  approvalPrompt: (req: IToolApprovalRequest) => string
}

export interface IPromptQuestions {
  /** `toolApproval.onRequest`. */
  approval: (req: IToolApprovalRequest, ctx?: IToolApprovalContext) => Promise<ToolApprovalDecision>
  /** `onElicitation`. */
  elicitation: (
    request: McpElicitationRequest,
    ctx: McpElicitationContext,
  ) => Promise<McpElicitationResult>
  /** True, once, for a question closed at the prompt: its line is already printed. */
  closedAtPrompt: (id: string) => boolean
}

/** Why a question was closed, in a few words. */
export const closedReason = (stopped: boolean, reason: unknown): string => {
  if (stopped) {
    return 'the run was stopped'
  }
  const r = reason as { name?: unknown; message?: unknown } | undefined
  return r?.name === 'TimeoutError' && typeof r.message === 'string' && r.message
    ? r.message
    : 'no answer in time'
}

/** The line printed when an approval question is closed. */
export const approvalClosedLine = (toolName: string, why: string): string =>
  `[approve] closed: ${why} - ${toolName} did not run`

/** The line printed when an MCP server's question is closed. */
export const elicitationClosedLine = (why: string): string =>
  `[ask]     closed: ${why} - the server's question was cancelled`

export const createPromptQuestions = (deps: IPromptQuestionsDeps): IPromptQuestions => {
  // Parallel tool calls would otherwise interleave their questions: one at a time.
  let turn: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = turn.then(fn, fn)
    turn = next.catch(() => {})
    return next
  }
  const closed = new Set<string>()

  // Show one question. `body` asks its lines through `ask`; `wanted` is the agent's signal, and
  // the one that takes the readline question down. While the question is open, its abort prints
  // the closing line - synchronously, inside the abort, so before the agent emits its event - and
  // marks the question closed. Once it is over the listener goes: an elicitation's signal is
  // aborted after an answer too, which means nothing here.
  const show = async <T>(
    id: string,
    wanted: AbortSignal | undefined,
    line: (why: string) => string,
    body: (ask: (prompt: string) => Promise<string>) => Promise<T>,
  ): Promise<T> => {
    deps.beforeAsk?.()
    const run = deps.runSignal?.()
    const onWithdrawn = (): void => {
      closed.add(id)
      deps.print(line(closedReason(run?.aborted === true, wanted?.reason)))
    }
    wanted?.addEventListener('abort', onWithdrawn, { once: true })
    const ask = (prompt: string): Promise<string> =>
      deps.question(prompt, { signal: wanted ?? new AbortController().signal })
    try {
      return await body(ask)
    } finally {
      wanted?.removeEventListener('abort', onWithdrawn)
    }
  }

  return {
    approval: (req, ctx) =>
      enqueue(async (): Promise<ToolApprovalDecision> => {
        const answer = await show(
          req.id,
          ctx?.signal,
          (why) => approvalClosedLine(req.toolName, why),
          (ask) => ask(deps.approvalPrompt(req)),
        )
        const a = answer.trim().toLowerCase()
        if (a === 'a' || a === 'always') {
          return { approved: true, remember: true }
        }
        if (a === 'y' || a === 'yes') {
          return true
        }
        return { approved: false, reason: 'denied at the prompt' }
      }),
    elicitation: (request, ctx) =>
      enqueue((): Promise<McpElicitationResult> =>
        show(request.id, ctx.signal, elicitationClosedLine, (ask) =>
          answerElicitationAtPrompt(request, ask),
        ),
      ),
    closedAtPrompt: (id) => closed.delete(id),
  }
}
