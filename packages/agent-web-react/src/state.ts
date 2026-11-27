import {
  isReplayedToolOutput,
  type AgentEvent,
  type IUsage,
  type Skill,
} from '@dudko.dev/agent-web'
import type {
  WrittenFileView,
  AgentUiState,
  ApprovalView,
  ChatAttachment,
  ChatMessage,
  DecisionView,
  LessonView,
  MediaView,
  StepView,
  SubagentNode,
  SubagentView,
  ToolCallView,
  TranscriptView,
} from './types.js'

/**
 * The reducer that turns the agent's `AgentEvent` stream into a renderable
 * {@link AgentUiState}. It is a pure function of (state, action) with no React,
 * no clock and no randomness (ids come from a monotonic `seq`; times come in on
 * the action as `at`), so it can be unit-tested in isolation and reused to
 * build a fully custom UI.
 */
export type AgentAction =
  /** Clear the whole conversation (transcript + current run), keeping status. */
  | { type: 'reset' }
  /** Set the lifecycle status (owned by the hook). */
  | { type: 'status'; status: AgentUiState['status']; error?: string }
  /**
   * Fold one streamed agent event into the view. `at` (ms epoch, from the
   * hook) times runs and tool calls; `attachments` decorate the user turn a
   * `run.start` opens.
   */
  | {
      type: 'event'
      event: AgentEvent
      maxEvents?: number
      at?: number
      attachments?: ChatAttachment[]
    }
  /**
   * The agent's notebook as it is now (the hook sends it when the agent is built: lessons a
   * persistent store brought back). Later `skill.learned` / `skill.forgotten` events keep it current.
   */
  | { type: 'notebook'; lessons: LessonView[] }
  /** Replace the transcript with a saved conversation (chat history). */
  | { type: 'load'; messages: ChatMessage[]; totalUsage?: IUsage }
  /**
   * The run is over and these messages never reached the model (`RunResult.undelivered`,
   * or what was still queued when it was stopped). Clears the queue. An empty list
   * clears `undelivered` too (the follow-up was sent, or the user discarded them).
   */
  | { type: 'undelivered'; texts: string[] }

interface EventContext {
  at?: number
  attachments?: ChatAttachment[]
}

/** ≈ tokens of a value as the model sees it (chars / 4). */
const approxTokens = (value: unknown): number => {
  if (value === undefined) return 0
  let text: string
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  } catch {
    text = String(value)
  }
  return Math.ceil(text.length / 4)
}

const emptyUsage = (): IUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
})

// What a usage record counts besides tokens: calls to the media models and to the decision
// model. Absent until there is one, so a run without them keeps the six-field shape.
const USAGE_COUNTS = [
  'mediaCalls',
  'imagesGenerated',
  'speechCharacters',
  'transcriptionSeconds',
  'decisionCalls',
] as const

const addUsage = (a: IUsage, b: IUsage): IUsage => {
  const sum: IUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  }
  for (const key of USAGE_COUNTS) {
    const n = (a[key] ?? 0) + (b[key] ?? 0)
    if (n) sum[key] = n
  }
  return sum
}

/**
 * The notebook view of the agent's own skills (`agent.listLearnedSkills()`): what the core stored
 * about each lesson, in the shape the UI keeps current from `skill.learned` events.
 */
export const lessonsOf = (skills: Skill[]): LessonView[] =>
  skills
    .filter((s) => s.origin?.kind === 'learned')
    .map((s) => ({
      name: s.name,
      description: s.description,
      revision: s.origin?.revision ?? 1,
      chars: s.content.length,
      sources: [...(s.origin?.sources ?? []), ...(s.origin?.fetched ?? [])],
    }))

/** A fresh, empty view. */
export const createInitialAgentState = (): AgentUiState => ({
  status: 'idle',
  goal: undefined,
  plan: undefined,
  planThought: '',
  steps: [],
  finalText: '',
  finalReasoning: '',
  totalUsage: emptyUsage(),
  runStartedAt: undefined,
  runMessageId: undefined,
  approvals: [],
  subagents: [],
  queued: [],
  notes: [],
  undelivered: [],
  skills: [],
  learned: [],
  learnedNow: [],
  fetches: [],
  discoveredTools: [],
  compactions: [],
  budget: undefined,
  usage: emptyUsage(),
  modelLoad: undefined,
  replan: undefined,
  error: undefined,
  stopped: false,
  messages: [],
  events: [],
  seq: 0,
})

/** Clear only the per-run view; keep the transcript, totals, status and seq counter. */
const resetRun = (state: AgentUiState): AgentUiState => ({
  ...createInitialAgentState(),
  status: state.status,
  messages: state.messages,
  totalUsage: state.totalUsage,
  seq: state.seq,
  learned: state.learned,
})

/** Apply `fn` to the step whose id matches, leaving the rest untouched. */
const patchStep = (steps: StepView[], id: string, fn: (s: StepView) => StepView): StepView[] =>
  steps.map((s) => (s.id === id ? fn(s) : s))

const patchApproval = (
  approvals: ApprovalView[],
  id: string,
  fn: (a: ApprovalView) => ApprovalView,
): ApprovalView[] => approvals.map((a) => (a.id === id ? fn(a) : a))

const patchSubagent = (
  subagents: SubagentView[],
  id: string,
  fn: (s: SubagentView) => SubagentView,
): SubagentView[] => subagents.map((s) => (s.id === id ? fn(s) : s))

/** The step currently executing (the last one still running). */
const runningStepId = (steps: StepView[]): string | undefined =>
  [...steps].reverse().find((s) => s.status === 'running')?.id

/** Fold one of a subagent's own events into its compact view. */
const applySubagentEvent = (view: SubagentView, event: AgentEvent): SubagentView => {
  switch (event.type) {
    case 'step.start':
      return {
        ...view,
        steps: view.steps + 1,
        activity: `step ${event.index}/${event.total}: ${event.step.description}`,
        // Known only when the child runs with model tiers.
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.tier !== undefined ? { tier: event.tier } : {}),
      }
    case 'step.escalated':
      return { ...view, tier: event.to, ...(event.model ? { model: event.model } : {}) }
    case 'step.tool-call':
      return { ...view, toolCalls: view.toolCalls + 1, activity: `→ ${event.name}` }
    case 'final.text-delta':
      return { ...view, text: view.text + event.delta, activity: 'writing the answer' }
    case 'final':
      return { ...view, text: event.text }
    case 'usage':
      return { ...view, usage: addUsage(view.usage, event.usage) }
    default:
      return view
  }
}

/** A subagent an event came through on its way up (a `subagent.event` envelope). */
interface Ancestor {
  id: string
}

type SubagentStart = Extract<AgentEvent, { type: 'subagent.start' }>

/**
 * The node `id`, created when it is not there yet. An event can arrive for a subagent whose
 * `subagent.start` was never seen (a capped log replayed, a host that joined late): it gets a
 * node from what the envelope says - its name, and where in the tree it is.
 */
const ensureSubagent = (
  state: AgentUiState,
  id: string,
  name: string,
  ancestors: Ancestor[],
  ctx: EventContext,
): AgentUiState => {
  if (state.subagents.some((s) => s.id === id)) return state
  const parentId = ancestors[ancestors.length - 1]?.id
  const parent = parentId ? state.subagents.find((s) => s.id === parentId) : undefined
  const stepId = parent ? parent.stepId : runningStepId(state.steps)
  const node: SubagentView = {
    id,
    name,
    task: '',
    ...(parentId ? { parentId } : {}),
    depth: ancestors.length + 1,
    status: 'running',
    ...(stepId ? { stepId } : {}),
    ...(ctx.at !== undefined ? { startedAt: ctx.at } : {}),
    activity: 'starting',
    steps: 0,
    toolCalls: 0,
    text: '',
    usage: emptyUsage(),
  }
  return { ...state, subagents: [...state.subagents, node] }
}

/** What a `subagent.start` says about its node (everything but the counters). */
const startSubagent = (
  state: AgentUiState,
  event: SubagentStart,
  ancestors: Ancestor[],
  ctx: EventContext,
): AgentUiState => {
  // The envelopes around an event are its ancestry; a start that came bare says it itself
  // (`parentId` is then a subagent only below depth 1 - at depth 1 it is the run's id).
  const depth = Math.max(event.depth ?? 1, ancestors.length + 1)
  const parentId = ancestors[ancestors.length - 1]?.id ?? (depth > 1 ? event.parentId : undefined)
  const told = {
    name: event.name,
    task: event.task,
    depth,
    ...(parentId ? { parentId } : {}),
    ...(event.profile ? { profile: event.profile } : {}),
    ...(event.dynamic ? { dynamic: true as const } : {}),
    ...(event.role ? { role: event.role } : {}),
    ...(event.tools ? { tools: event.tools } : {}),
  }
  // Already there (its events arrived first): the start fills in what they could not say.
  if (state.subagents.some((s) => s.id === event.id)) {
    return {
      ...state,
      subagents: patchSubagent(state.subagents, event.id, (s) => ({ ...s, ...told })),
    }
  }
  const parent = parentId ? state.subagents.find((s) => s.id === parentId) : undefined
  // A nested one belongs to the step that delegated its top-most ancestor.
  const stepId = parent ? parent.stepId : runningStepId(state.steps)
  const node: SubagentView = {
    id: event.id,
    ...told,
    status: 'running',
    stepId,
    ...(ctx.at !== undefined ? { startedAt: ctx.at } : {}),
    activity: 'starting',
    steps: 0,
    toolCalls: 0,
    text: '',
    usage: emptyUsage(),
  }
  return { ...state, subagents: [...state.subagents, node] }
}

/** How long a subagent ran, when both ends were stamped. */
const subagentDuration = (s: SubagentView, at?: number): Partial<SubagentView> =>
  at !== undefined && s.startedAt !== undefined ? { durationMs: Math.max(0, at - s.startedAt) } : {}

const addMedia = (state: AgentUiState, view: MediaView): AgentUiState => ({
  ...state,
  media: [...(state.media ?? []), view],
  ...(view.stepId
    ? {
        steps: patchStep(state.steps, view.stepId, (s) => ({
          ...s,
          media: [...(s.media ?? []), view],
        })),
      }
    : {}),
})

const mediaOf = (
  event: Extract<AgentEvent, { type: 'media.generated' }>,
  withStep: boolean,
): MediaView => ({
  kind: event.kind,
  path: event.path,
  mediaType: event.mediaType,
  bytes: event.bytes,
  model: event.model,
  ...(withStep && event.step ? { stepId: event.step.id } : {}),
})

type FileWritten = Extract<AgentEvent, { type: 'file.written' }>

/**
 * A file the run wrote: one entry per path (a second write updates it in place), newest size
 * and type. `by` is the subagent it came through; its step ids are its own, so no step then.
 */
const fileWritten = (
  state: AgentUiState,
  event: FileWritten,
  by?: WrittenFileView['by'],
): AgentUiState => {
  const files = state.writtenFiles ?? []
  const i = files.findIndex((f) => f.path === event.path)
  const view: WrittenFileView = {
    path: event.path,
    mediaType: event.mediaType,
    bytes: event.bytes,
    writes: (i >= 0 ? files[i].writes : 0) + 1,
    ...(!by && event.step ? { stepId: event.step.id } : {}),
    ...(by ? { by } : {}),
  }
  return {
    ...state,
    writtenFiles: i >= 0 ? files.map((f, k) => (k === i ? view : f)) : [...files, view],
  }
}

/** A file deleted later in the run is not one of its files any more. */
const fileDeleted = (state: AgentUiState, path: string): AgentUiState =>
  state.writtenFiles?.some((f) => f.path === path)
    ? { ...state, writtenFiles: state.writtenFiles.filter((f) => f.path !== path) }
    : state

const transcriptOf = (
  event: Extract<AgentEvent, { type: 'media.transcribed' }>,
): TranscriptView => ({
  source: event.source,
  name: event.name,
  text: event.text,
  ...(event.language ? { language: event.language } : {}),
  ...(event.durationInSeconds !== undefined ? { durationInSeconds: event.durationInSeconds } : {}),
  model: event.model,
})

/**
 * Fold a `subagent.*` event into the tree. `ancestors` are the subagents it came up through
 * (outermost first): a subagent's own subagents arrive nested,
 * `subagent.event{ A, subagent.event{ G, event } }`, and each level lands on its own node.
 */
const applySubagent = (
  state: AgentUiState,
  event: Extract<
    AgentEvent,
    { type: 'subagent.start' | 'subagent.event' | 'subagent.complete' | 'subagent.error' }
  >,
  ancestors: Ancestor[],
  ctx: EventContext,
): AgentUiState => {
  switch (event.type) {
    case 'subagent.start':
      return startSubagent(state, event, ancestors, ctx)

    case 'subagent.event': {
      const known = ensureSubagent(state, event.id, event.name, ancestors, ctx)
      const inner = event.event
      switch (inner.type) {
        case 'subagent.start':
        case 'subagent.event':
        case 'subagent.complete':
        case 'subagent.error':
          return applySubagent(known, inner, [...ancestors, { id: event.id }], ctx)

        // A helper the model started asks through the run's own consent gate (the event says
        // which helper): its request is the user's to answer, like the run's. A subagent with
        // a gate of its own (no `subagent` on the event) is its host's business.
        case 'tool.approval-requested': {
          if (!inner.subagent || known.approvals.some((a) => a.id === inner.id)) return known
          const node = known.subagents.find((s) => s.id === inner.subagent!.id)
          return {
            ...known,
            approvals: [
              ...known.approvals,
              {
                id: inner.id,
                name: inner.name,
                input: inner.input,
                readOnly: inner.readOnly,
                // The helper's own step ids mean nothing here: the step that delegated it does.
                stepId: node?.stepId,
                subagent: {
                  id: inner.subagent.id,
                  depth: inner.subagent.depth,
                  ...(node ? { name: node.name } : {}),
                  ...(node?.role ? { role: node.role } : {}),
                },
                status: 'pending',
              },
            ],
          }
        }
        case 'tool.approval-resolved':
          return known.approvals.some((a) => a.id === inner.id)
            ? {
                ...known,
                approvals: patchApproval(known.approvals, inner.id, (a) => ({
                  ...a,
                  status: inner.approved ? 'approved' : 'denied',
                  reason: inner.reason,
                  automatic: inner.automatic,
                })),
              }
            : known

        // What a subagent generated is in the same workspace: it shows in the turn (its step
        // ids are its own, so it is tied to no step here).
        case 'media.generated':
          return addMedia(known, mediaOf(inner, false))
        case 'media.transcribed':
          return { ...known, transcripts: [...(known.transcripts ?? []), transcriptOf(inner)] }

        // A subagent works in the same workspace: what it wrote belongs to the turn, and says
        // who wrote it.
        case 'file.written': {
          const node = known.subagents.find((s) => s.id === event.id)
          return fileWritten(known, inner, {
            id: event.id,
            name: node?.name ?? event.name,
            ...(node?.role ? { role: node.role } : {}),
          })
        }
        case 'file.deleted':
          return fileDeleted(known, inner.path)

        default:
          return {
            ...known,
            subagents: patchSubagent(known.subagents, event.id, (s) =>
              applySubagentEvent(s, inner),
            ),
          }
      }
    }

    case 'subagent.complete': {
      const known = ensureSubagent(state, event.id, event.name, ancestors, ctx)
      return {
        ...known,
        subagents: patchSubagent(known.subagents, event.id, (s) => ({
          ...s,
          status: 'done',
          activity: 'done',
          text: event.text,
          usage: event.usage,
          ...subagentDuration(s, ctx.at),
        })),
      }
    }

    case 'subagent.error': {
      const known = ensureSubagent(state, event.id, event.name, ancestors, ctx)
      return {
        ...known,
        subagents: patchSubagent(known.subagents, event.id, (s) => ({
          ...s,
          status: event.stopped ? 'stopped' : 'error',
          activity: event.stopped ? 'stopped' : 'failed',
          error: event.error,
          // A helper says what it had spent when it ended; a static subagent does not.
          ...(event.usage ? { usage: event.usage } : {}),
          ...subagentDuration(s, ctx.at),
        })),
      }
    }
  }
}

/**
 * The flat `subagents` list as a tree: each node with the subagents it started, in the order
 * they started. A node whose parent is not in the list (its start was never seen) is a root.
 */
export const subagentTree = (subagents: SubagentView[]): SubagentNode[] => {
  const nodes = new Map<string, SubagentNode>()
  for (const s of subagents) nodes.set(s.id, { ...s, children: [] })
  // A parent chain that comes back to the node is not a tree: such a node is a root.
  const loops = (node: SubagentNode): boolean => {
    let up = node.parentId
    for (let i = 0; up !== undefined && i <= nodes.size; i++) {
      if (up === node.id) return true
      up = nodes.get(up)?.parentId
    }
    return false
  }
  const roots: SubagentNode[] = []
  for (const node of nodes.values()) {
    const parent =
      node.parentId !== undefined && !loops(node) ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** Finalize the trailing pending assistant message with the given content. */
const finalizeAssistant = (
  messages: ChatMessage[],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage[] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.pending) {
      const next = messages.slice()
      next[i] = { ...m, content: content || m.content, pending: false, ...extra }
      return next
    }
  }
  return messages
}

/** Duration of the current run at `at`, when both ends are known. */
const runDuration = (state: AgentUiState, at?: number): Partial<ChatMessage> =>
  at !== undefined && state.runStartedAt !== undefined
    ? { durationMs: Math.max(0, at - state.runStartedAt) }
    : {}

/** Update the trailing pending assistant message's streaming content. */
const streamAssistant = (messages: ChatMessage[], content: string): ChatMessage[] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.pending) {
      const next = messages.slice()
      next[i] = { ...m, content }
      return next
    }
  }
  return messages
}

const applyEvent = (state: AgentUiState, event: AgentEvent, ctx: EventContext): AgentUiState => {
  switch (event.type) {
    case 'run.start': {
      // Start a new run: clear the previous run's view but keep the transcript,
      // then push the user turn and a pending assistant turn to stream into.
      const base = resetRun(state)
      const userId = `msg-${base.seq}`
      const assistantId = `msg-${base.seq + 1}`
      return {
        ...base,
        goal: event.goal,
        runStartedAt: ctx.at,
        runMessageId: assistantId,
        messages: [
          ...base.messages,
          {
            id: userId,
            role: 'user',
            content: event.goal,
            pending: false,
            ...(ctx.attachments?.length ? { attachments: ctx.attachments } : {}),
          },
          { id: assistantId, role: 'assistant', content: '', pending: true },
        ],
        seq: base.seq + 2,
      }
    }

    case 'model.load':
      return { ...state, modelLoad: { progress: event.progress, text: event.text } }

    case 'plan.thought-delta':
      return { ...state, planThought: state.planThought + event.delta }

    case 'plan.created':
      return {
        ...state,
        plan: event.plan,
        planThought: state.planThought || event.plan.thought,
      }

    case 'plan.revised':
      return {
        ...state,
        plan: event.plan,
        // `replan.decision` came first: keep its "because the user spoke" flag.
        replan: {
          mode: 'revise',
          reason: event.reason,
          ...(state.replan?.byUser ? { byUser: true } : {}),
        },
      }

    case 'plan.step-added':
      // Execution is tracked from step.* events; the plan itself already
      // arrived via plan.created. Nothing to fold here.
      return state

    case 'step.start': {
      const view: StepView = {
        id: event.step.id,
        index: event.index,
        total: event.total,
        step: event.step,
        text: '',
        reasoning: '',
        toolCalls: [],
        status: 'running',
        blocked: false,
        // Only with `config.executorTiers`: without it the view is what it always was.
        ...(event.tier !== undefined ? { tier: event.tier } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.tierReason !== undefined ? { tierReason: event.tierReason } : {}),
      }
      return { ...state, steps: [...state.steps, view] }
    }

    case 'step.escalated':
      // The attempt on `from` is over and the step CONTINUES on `to`. What the failed attempt
      // wrote is not the next attempt's text: it moves onto the escalation. Its tool calls
      // happened (the core keeps them in the step's result and shows them to the stronger
      // model), so they stay, marked with the attempt they belong to.
      return {
        ...state,
        steps: patchStep(state.steps, event.step.id, (s) => {
          const attempt = (s.escalations?.length ?? 0) + 1
          return {
            ...s,
            tier: event.to,
            ...(event.model ? { model: event.model } : {}),
            text: '',
            reasoning: '',
            toolCalls: s.toolCalls.map((c) => (c.attempt === undefined ? { ...c, attempt } : c)),
            escalations: [
              ...(s.escalations ?? []),
              {
                from: event.from,
                to: event.to,
                reason: event.reason,
                ...(event.model ? { model: event.model } : {}),
                ...(s.text.trim() ? { text: s.text } : {}),
              },
            ],
          }
        }),
      }

    case 'step.reasoning-delta':
      return {
        ...state,
        steps: patchStep(state.steps, event.step.id, (s) => ({
          ...s,
          reasoning: s.reasoning + event.delta,
        })),
      }

    case 'step.text-delta':
      return {
        ...state,
        steps: patchStep(state.steps, event.step.id, (s) => ({ ...s, text: s.text + event.delta })),
      }

    case 'step.tool-call': {
      const call: ToolCallView = {
        name: event.name,
        input: event.input,
        status: 'calling',
        inputTokens: approxTokens(event.input),
        ...(ctx.at !== undefined ? { startedAt: ctx.at } : {}),
      }
      return {
        ...state,
        steps: patchStep(state.steps, event.step.id, (s) => ({
          ...s,
          toolCalls: [...s.toolCalls, call],
        })),
      }
    }

    case 'step.tool-result':
      return {
        ...state,
        steps: patchStep(state.steps, event.step.id, (s) => {
          // Match the last still-calling entry for this tool name.
          let done = false
          const toolCalls = s.toolCalls
            .slice()
            .reverse()
            .map((c) => {
              if (!done && c.status === 'calling' && c.name === event.name) {
                done = true
                return {
                  ...c,
                  output: event.output,
                  ok: event.ok,
                  status: 'done' as const,
                  outputTokens: approxTokens(event.output),
                  ...(isReplayedToolOutput(event.output) ? { replayed: true } : {}),
                  ...(ctx.at !== undefined && c.startedAt !== undefined
                    ? { durationMs: Math.max(0, ctx.at - c.startedAt) }
                    : {}),
                }
              }
              return c
            })
            .reverse()
          return { ...s, toolCalls }
        }),
      }

    case 'step.complete':
      return {
        ...state,
        steps: patchStep(state.steps, event.step.id, (s) => ({
          ...s,
          status: 'done',
          summary: event.result.summary,
          // With tiers: where the step finished and how it got there. The result's list is the
          // authority; an escalation seen live keeps what only the event told (model, text).
          ...(event.result.tier !== undefined ? { tier: event.result.tier } : {}),
          ...(event.result.model !== undefined ? { model: event.result.model } : {}),
          ...(event.result.escalations?.length
            ? {
                escalations: event.result.escalations.map((e, i) => {
                  const live = s.escalations?.[i]
                  return live && live.from === e.from && live.to === e.to
                    ? { ...live, reason: e.reason }
                    : { from: e.from, to: e.to, reason: e.reason }
                }),
              }
            : {}),
          blocked: event.result.blocked,
          // The result carries the authoritative, ordered tool-call list; keep
          // the timing the streamed calls measured (matched in order per name).
          toolCalls: (() => {
            const seen = new Map<string, number>()
            return event.result.toolCalls.map((c) => {
              const nth = seen.get(c.name) ?? 0
              seen.set(c.name, nth + 1)
              const streamed = s.toolCalls.filter((t) => t.name === c.name)[nth]
              return {
                name: c.name,
                input: c.input,
                output: c.output,
                ok: c.ok,
                status: 'done' as const,
                inputTokens: approxTokens(c.input),
                outputTokens: approxTokens(c.output),
                ...(streamed?.startedAt !== undefined ? { startedAt: streamed.startedAt } : {}),
                ...(streamed?.durationMs !== undefined ? { durationMs: streamed.durationMs } : {}),
                // With tiers the list holds every attempt's calls, in the order they were made.
                ...(streamed?.attempt !== undefined ? { attempt: streamed.attempt } : {}),
                ...(isReplayedToolOutput(c.output) ? { replayed: true } : {}),
              }
            })
          })(),
        })),
      }

    case 'replan.decision': {
      if (!event.failed) {
        return {
          ...state,
          replan: {
            mode: event.mode,
            reason: event.reason,
            ...(event.byUser ? { byUser: true } : {}),
            ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
          },
        }
      }
      // The replanner could not decide: `continue` is the fallback and the run goes on. The
      // failure itself came as the `error` event (phase 'replan') just before; it is pinned to
      // the step the replanner ran after, so the warning stays in that turn's activity.
      const error = state.replan?.failed ? state.replan.error : undefined
      const last = state.steps[state.steps.length - 1]
      return {
        ...state,
        replan: {
          mode: event.mode,
          reason: event.reason,
          ...(event.byUser ? { byUser: true } : {}),
          failed: true,
          ...(error ? { error } : {}),
        },
        steps: last
          ? patchStep(state.steps, last.id, (s) => ({
              ...s,
              replanFailed: error ?? event.reason,
            }))
          : state.steps,
      }
    }

    case 'decision': {
      // The decision model is asked after a step (continue / finish): the note belongs to it.
      const view: DecisionView = {
        point: event.point,
        accepted: event.accepted,
        ...(event.choice !== undefined ? { choice: event.choice } : {}),
        ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
        threshold: event.threshold,
        ...(event.reason ? { reason: event.reason } : {}),
        durationMs: event.durationMs,
        ...(event.model ? { model: event.model } : {}),
      }
      const last = state.steps[state.steps.length - 1]
      return last
        ? {
            ...state,
            steps: patchStep(state.steps, last.id, (s) => ({
              ...s,
              decisions: [...(s.decisions ?? []), view],
            })),
          }
        : { ...state, decisions: [...(state.decisions ?? []), view] }
    }

    case 'media.generated':
      return addMedia(state, mediaOf(event, true))

    case 'media.transcribed':
      return { ...state, transcripts: [...(state.transcripts ?? []), transcriptOf(event)] }

    case 'file.written':
      return fileWritten(state, event)

    case 'file.deleted':
      return fileDeleted(state, event.path)

    case 'message.queued':
      return state.queued.some((q) => q.id === event.id)
        ? state
        : { ...state, queued: [...state.queued, { id: event.id, text: event.text }] }

    case 'message.delivered': {
      // Anchored where it landed: inside the executing step (between tool calls),
      // after the step that just ended (a step boundary), or at the end (the answer).
      const anchor =
        event.at === 'round'
          ? runningStepId(state.steps)
          : event.at === 'step'
            ? state.steps[state.steps.length - 1]?.id
            : undefined
      return {
        ...state,
        queued: state.queued.filter((q) => q.id !== event.id),
        notes: [
          ...state.notes,
          { id: event.id, text: event.text, at: event.at, ...(anchor ? { stepId: anchor } : {}) },
        ],
      }
    }

    case 'final.text-delta': {
      const finalText = state.finalText + event.delta
      return { ...state, finalText, messages: streamAssistant(state.messages, finalText) }
    }

    case 'final':
      return {
        ...state,
        finalText: event.text,
        messages: finalizeAssistant(state.messages, event.text, runDuration(state, ctx.at)),
      }

    case 'final.reasoning-delta':
      return { ...state, finalReasoning: state.finalReasoning + event.delta }

    case 'usage':
      return {
        ...state,
        usage: addUsage(state.usage, event.usage),
        totalUsage: addUsage(state.totalUsage, event.usage),
      }

    case 'tool.approval-requested':
      return {
        ...state,
        approvals: [
          ...state.approvals,
          {
            id: event.id,
            name: event.name,
            input: event.input,
            readOnly: event.readOnly,
            stepId: event.step?.id,
            ...(event.subagent ? { subagent: event.subagent } : {}),
            status: 'pending',
          },
        ],
      }

    case 'tool.approval-resolved': {
      const known = state.approvals.some((a) => a.id === event.id)
      const decided = (a: ApprovalView): ApprovalView => ({
        ...a,
        status: event.approved ? 'approved' : 'denied',
        reason: event.reason,
        automatic: event.automatic,
      })
      return {
        ...state,
        approvals: known
          ? patchApproval(state.approvals, event.id, decided)
          : // A policy denial arrives without a request: record it too.
            [
              ...state.approvals,
              decided({
                id: event.id,
                name: event.name,
                input: undefined,
                readOnly: false,
                stepId: runningStepId(state.steps),
                status: 'pending',
              }),
            ],
      }
    }

    case 'subagent.start':
    case 'subagent.event':
    case 'subagent.complete':
    case 'subagent.error':
      return applySubagent(state, event, [], ctx)

    case 'skill.activated':
      return state.skills.includes(event.name)
        ? state
        : { ...state, skills: [...state.skills, event.name] }

    case 'skill.learned': {
      const before = state.learned.find((l) => l.name === event.name)
      const lesson: LessonView = {
        name: event.name,
        description: event.description,
        // A rewrite of a lesson we know goes up one; a lesson we never saw (an event for a store
        // loaded before this view existed) starts at 2 when the core says it is an update.
        revision: event.update ? (before?.revision ?? 1) + 1 : 1,
        chars: event.chars,
        sources: event.sources,
      }
      return {
        ...state,
        learned: before
          ? state.learned.map((l) => (l.name === event.name ? lesson : l))
          : [...state.learned, lesson],
        learnedNow: state.learnedNow.includes(event.name)
          ? state.learnedNow
          : [...state.learnedNow, event.name],
      }
    }

    case 'skill.forgotten':
      return { ...state, learned: state.learned.filter((l) => l.name !== event.name) }

    case 'egress.request':
      return {
        ...state,
        fetches: [
          ...state.fetches,
          {
            url: event.url,
            allowed: event.allowed,
            ...(event.status !== undefined ? { status: event.status } : {}),
            ...(event.reason ? { reason: event.reason } : {}),
          },
        ],
      }

    case 'tools.discovered':
      return {
        ...state,
        discoveredTools: [...new Set([...state.discoveredTools, ...event.names])],
      }

    case 'context.compacted':
      return {
        ...state,
        compactions: [
          ...state.compactions,
          { scope: event.scope, beforeTokens: event.beforeTokens, afterTokens: event.afterTokens },
        ],
      }

    case 'budget.exceeded':
      return { ...state, budget: { kind: event.kind, tokens: event.tokens, cap: event.cap } }

    case 'stopped':
      return {
        ...state,
        stopped: true,
        // Nothing is waiting any more once the run has stopped.
        approvals: state.approvals.map((a) =>
          a.status === 'pending' ? { ...a, status: 'denied' as const, reason: 'stopped' } : a,
        ),
        messages: finalizeAssistant(
          state.messages,
          state.finalText || 'Stopped.',
          runDuration(state, ctx.at),
        ),
      }

    case 'error':
      // A per-step ('execute'/'plan'/...) error does not end the run — only a
      // top-level 'run' error does, and it arrives with no trailing `final`.
      // A replanner that failed is not an error of the run at all: the run continues with its
      // plan. It is held for the `replan.decision { failed }` that follows, never in `error`.
      if (event.phase === 'replan') {
        return {
          ...state,
          replan: { mode: 'continue', reason: '', failed: true, error: event.error },
        }
      }
      return event.phase === 'run'
        ? {
            ...state,
            error: event.error,
            messages: finalizeAssistant(
              state.messages,
              state.finalText || `Error: ${event.error}`,
              { ...runDuration(state, ctx.at), error: true },
            ),
          }
        : { ...state, error: event.error }

    case 'retry':
      return state

    default:
      return state
  }
}

/**
 * Mirror the current run's activity onto its assistant message, so every turn
 * of the transcript keeps its own tool calls, thoughts, subagents and usage
 * after the next run starts. Only copies what changed (cheap on every event).
 */
const syncRunMessage = (state: AgentUiState): AgentUiState => {
  const id = state.runMessageId
  if (!id) return state
  const i = state.messages.findIndex((m) => m.id === id)
  if (i < 0) return state
  const m = state.messages[i]
  const decided = state.approvals.filter((a) => a.status !== 'pending')
  const patch: Partial<ChatMessage> = {}
  if (m.steps !== state.steps) patch.steps = state.steps
  if (m.subagents !== state.subagents) patch.subagents = state.subagents
  if (state.notes.length > 0 && m.notes !== state.notes) patch.notes = state.notes
  if (m.usage !== state.usage) patch.usage = state.usage
  if ((m.reasoning ?? '') !== state.finalReasoning) patch.reasoning = state.finalReasoning
  if (m.skills !== state.skills) patch.skills = state.skills
  if (state.learnedNow.length > 0 && m.learned !== state.learnedNow)
    patch.learned = state.learnedNow
  if (state.fetches.length > 0 && m.fetches !== state.fetches) patch.fetches = state.fetches
  if (state.media && m.media !== state.media) patch.media = state.media
  if (state.transcripts && m.transcripts !== state.transcripts)
    patch.transcripts = state.transcripts
  if (state.writtenFiles && m.writtenFiles !== state.writtenFiles)
    patch.writtenFiles = state.writtenFiles
  if (
    (m.approvals?.length ?? 0) !== decided.length ||
    decided.some((a, k) => m.approvals?.[k] !== a)
  ) {
    patch.approvals = decided
  }
  if (Object.keys(patch).length === 0) return state
  const messages = state.messages.slice()
  messages[i] = { ...m, ...patch }
  return { ...state, messages }
}

export const agentStateReducer = (state: AgentUiState, action: AgentAction): AgentUiState => {
  switch (action.type) {
    case 'reset':
      // A full "new conversation" clear — unlike run.start, this also drops the
      // transcript. Keep status (the agent is still built) and the seq counter
      // (so ids stay unique across resets).
      return {
        ...createInitialAgentState(),
        status: state.status,
        seq: state.seq,
        learned: state.learned,
      }
    case 'notebook':
      return { ...state, learned: action.lessons }
    case 'status':
      return {
        ...state,
        status: action.status,
        error: action.status === 'error' ? action.error : undefined,
      }
    case 'event': {
      const next = syncRunMessage(
        applyEvent(state, action.event, { at: action.at, attachments: action.attachments }),
      )
      const cap = action.maxEvents ?? 200
      const events =
        cap > 0 ? [...state.events, action.event].slice(-cap) : [...state.events, action.event]
      return { ...next, events }
    }
    case 'undelivered':
      return { ...state, queued: [], undelivered: action.texts }
    case 'load': {
      // Ids of the loaded messages must not collide with ones minted later.
      const maxSeq = action.messages.reduce((n, m) => {
        const k = Number(/^msg-(\d+)$/.exec(m.id)?.[1] ?? -1)
        return Math.max(n, k + 1)
      }, state.seq)
      return {
        ...createInitialAgentState(),
        status: state.status,
        messages: action.messages.map((m) => (m.pending ? { ...m, pending: false } : m)),
        totalUsage: action.totalUsage ?? emptyUsage(),
        seq: maxSeq,
        learned: state.learned,
      }
    }
    default:
      return state
  }
}
