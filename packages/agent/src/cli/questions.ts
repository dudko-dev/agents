import type {
  McpElicitationContext,
  McpElicitationRequest,
  McpElicitationResult,
} from '../mcp-elicitation.ts'
import type { McpSkillConsentView } from '../mcp-skills.ts'
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

/** The line printed when a question about an MCP server's skill is closed. */
export const skillClosedLine = (skillName: string, why: string): string =>
  `[skill]   closed: ${why} - ${skillName} was not loaded`

/** How many lines of a skill's instructions the question shows, and how wide each may be. */
export const SKILL_PREVIEW_LINES = 12
export const SKILL_PREVIEW_LINE_CHARS = 160

// The terminal is a boundary of its own: the core already removes control characters from a
// server's text, and this removes them again - an escape sequence must never reach the screen.
const plain = (raw: unknown): string =>
  (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')

const oneLine = (raw: unknown): string => plain(raw).replace(/\s+/g, ' ').trim()

const clipLine = (line: string, n: number): string =>
  line.length > n ? `${line.slice(0, n)}...` : line

const bytes = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

/**
 * The question put before an MCP server's skill enters the model's context (the request's
 * `skill`). Everything quoted is the SERVER's text and is captioned so; the instructions are shown
 * as the model would read them, the first {@link SKILL_PREVIEW_LINES} lines, each line behind
 * `| `. `y` allows it once (for the agent's life under 'once-per-skill'), `a` every skill of that
 * server (not the nested ones), anything else is a no.
 */
export const skillApprovalPrompt = (view: McpSkillConsentView): string => {
  const pad = '          '
  const out: string[] = [
    `[skill]   the server "${oneLine(view.server)}" offers the skill "${oneLine(view.skill)}" (${oneLine(view.name)})`,
  ]
  const description = oneLine(view.description)
  if (description) out.push(`${pad}"${clipLine(description, 240)}"`)
  const more = view.fileCount ? ` + ${view.fileCount} more file(s)` : ''
  out.push(`${pad}SKILL.md ${bytes(view.size)}${more} - ${oneLine(view.uri)}`)
  if (view.byUri) out.push(`${pad}not in the server's list: the agent asked for it by its address`)
  if (view.nestedIn) {
    out.push(
      `${pad}it sits inside the skill "${oneLine(view.nestedIn)}": allowing that one did not allow this one`,
    )
  }
  if (view.dynamic) {
    out.push(
      `${pad}the server publishes no checksums for this skill: you approve the copy the agent just read, and only that copy is used`,
    )
  }
  if (view.noFileListing) {
    out.push(`${pad}the server cannot list this skill's files: that copy is its SKILL.md alone`)
  }
  const lines = plain(view.body).split('\n')
  out.push(`${pad}what the agent would read (the server's text):`)
  for (const line of lines.slice(0, SKILL_PREVIEW_LINES)) {
    out.push(`${pad}| ${clipLine(line, SKILL_PREVIEW_LINE_CHARS)}`)
  }
  if (lines.length > SKILL_PREVIEW_LINES) {
    out.push(`${pad}| (${lines.length - SKILL_PREVIEW_LINES} more line(s))`)
  }
  if (view.files.length) {
    const rest = view.fileCount - view.files.length
    out.push(
      `${pad}its files, read as text and never run: ${view.files.map(oneLine).join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`,
    )
  }
  out.push(
    `${pad}written by the server, not by you; it cannot change the agent's rules or approvals${
      view.consent === 'ask'
        ? ' - asked again in every task that loads it'
        : ' - asked again if the server changes it'
    }`,
  )
  out.push(`${pad}allow? [y]es / [n]o / [a]lways for this server: `)
  return out.join('\n')
}

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
        const skill = req.skill
        const answer = await show(
          req.id,
          ctx?.signal,
          (why) =>
            skill ? skillClosedLine(skill.name, why) : approvalClosedLine(req.toolName, why),
          (ask) => ask(skill ? skillApprovalPrompt(skill) : deps.approvalPrompt(req)),
        )
        const a = answer.trim().toLowerCase()
        if (a === 'a' || a === 'always') {
          return { approved: true, remember: true }
        }
        if (a === 'y' || a === 'yes') {
          return true
        }
        return {
          approved: false,
          reason: skill ? 'the user declined the skill' : 'denied at the prompt',
        }
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
