// Pipelines (PIPELINES): each one a tool of the session's agent and a graph of agents (the core's
// PipelineDefinition, plain JSON) run as child workflows. The tool is the core's remote subagent
// (`createSubagentTool({ isolation: 'remote', dispatch })`), whose `dispatch` never runs anything:
// it answers `deferResult()` at once, so the turn PARKS with one 'tool' item per call - exactly
// as a static subagent's (subagents.ts). The session workflow then starts a child workflow
// `pipeline` per item, which runs the core's graph engine as its scheduler and every node visit
// as a child workflow of its own (workflows.ts), and resumes the turn with the pipeline's answer.
//
// A node resolves against the WORKER, as a subagent profile does: `model` is a model id on the
// worker's provider (default: the worker's), `instructions` go under the worker's system prompt,
// `tools` are tools the worker mounts (a native tool, or `<server>__<tool>` of MCP_SERVERS) and
// `mcpServers` names worker MCP servers whose tools the node gets, all of them. Anything else a
// node names is refused when the worker starts (skills, settings, a tool or a server the worker
// does not have), with the pipeline and the node in the message. A node's approvals follow the
// worker's mode and rules: an 'ask' parks the node visit's own run (CHILD_ASK=park: its workflow
// waits for the person's answer, the pipeline waits for the visit) or is a denial
// (CHILD_ASK=deny). It has no subagents or pipelines of its own.
import {
  createSubagentTool,
  deferResult,
  preparePipeline,
  type IAgentConfig,
  type IToolCatalogEntry,
  type PipelineDefinition,
  type PipelineIssue,
  type PipelineNode,
} from '@dudko.dev/agent'
import { ConfigError } from './env.ts'
import { currentTurnScope } from './lease.ts'
import { childApproval, type ChildAsk } from './child-ask.ts'

export interface IPipelineConfig {
  // When the parent model should call it (the tool's description).
  description: string
  // The graph: the core's PipelineDefinition (README, "Pipelines"), validated at start.
  definition: PipelineDefinition
  // Mark the tool read-only for tool approval (under ask-writes a call then does not ask first).
  readOnly?: boolean
}

// A pipeline's name is a tool name of the session's agent (the same rule as a subagent's).
export const PIPELINE_NAME = /^[a-z][a-z0-9_-]{0,47}$/
// A node's id names its visits' child workflows, streams and routes (gateway.ts): no '.', no '/'.
export const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/

type ToolSet = NonNullable<IAgentConfig['tools']>

// The note the parked item carries (what the parent model and a client read).
export const pipelineNote = (name: string): string =>
  `pipeline "${name}" runs as a child workflow; its answer will be this call's result`

// What a call of `name` does: defer, within the caps the turn was given (ITurnInput.pipelines) -
// per round (an attempt parks at its first round that dispatches, so the attempt's count is the
// round's) and per session. A call beyond them is a tool error the model reads.
export const pipelineDispatch = (name: string) => async () => {
  const budget = currentTurnScope()?.pipelines
  if (!budget) {
    throw new Error(`pipeline "${name}" can only be called from a turn of a session`)
  }
  if (budget.dispatched >= budget.maxPerRound) {
    throw new Error(
      `pipeline "${name}" refused: at most ${budget.maxPerRound} pipeline calls in one round - make fewer calls at once`,
    )
  }
  if (budget.dispatched >= budget.remaining) {
    throw new Error(
      `pipeline "${name}" refused: this session may start no more pipeline calls - carry on without it`,
    )
  }
  budget.dispatched += 1
  return deferResult({ note: pipelineNote(name) })
}

export const pipelineTools = (pipelines: Record<string, IPipelineConfig>): ToolSet =>
  Object.fromEntries(
    Object.entries(pipelines).map(([name, p]) => [
      name,
      createSubagentTool({
        name,
        description: p.description,
        isolation: 'remote',
        dispatch: pipelineDispatch(name),
        ...(p.readOnly ? { readOnly: true } : {}),
      }),
    ]),
  )

const serverOf = (tool: string): string | undefined => {
  const at = tool.indexOf('__')
  return at > 0 ? tool.slice(0, at) : undefined
}

const issueText = (i: PipelineIssue): string =>
  [
    i.nodeId ? `node "${i.nodeId}"` : '',
    i.edgeId ? `edge "${i.edgeId}"` : i.edgeIndex !== undefined ? `edges[${i.edgeIndex}]` : '',
    i.message,
  ]
    .filter(Boolean)
    .join(': ')

// The definition, validated and normalised by the core (every edge has an id). A definition the
// core refuses is a ConfigError naming the pipeline and every issue.
export const preparedDefinition = (name: string, definition: unknown): PipelineDefinition => {
  try {
    return preparePipeline(definition as PipelineDefinition).definition
  } catch (err) {
    const e = err as { name?: string; errors?: PipelineIssue[]; message?: string }
    if (e?.name === 'PipelineValidationError' && Array.isArray(e.errors)) {
      throw new ConfigError(
        `PIPELINES.${name}.definition is not a valid pipeline: ${e.errors.map(issueText).join('; ')}`,
      )
    }
    throw new ConfigError(
      `PIPELINES.${name}.definition is not a valid pipeline: ${e?.message ?? String(err)}`,
    )
  }
}

// Every pipeline is checked against the worker: its name is free (not a subagent, not a tool of the
// worker), its definition is valid, and every node names only what the worker has.
export const checkPipelines = (
  pipelines: Record<string, IPipelineConfig>,
  base: Pick<IAgentConfig, 'tools' | 'mcpServers'>,
  subagents: Iterable<string> = [],
): void => {
  const native = new Set(Object.keys(base.tools ?? {}))
  const servers = new Set(Object.keys(base.mcpServers ?? {}))
  const taken = new Set(subagents)
  for (const [name, p] of Object.entries(pipelines)) {
    if (!PIPELINE_NAME.test(name) || name.includes('__')) {
      throw new ConfigError(`PIPELINES: "${name}" must match ${PIPELINE_NAME} (and have no "__")`)
    }
    if (taken.has(name)) {
      throw new ConfigError(`PIPELINES: "${name}" is already a subagent (SUBAGENTS)`)
    }
    if (native.has(name)) {
      throw new ConfigError(`PIPELINES: "${name}" is already a tool of the worker`)
    }
    const definition = preparedDefinition(name, p.definition)
    for (const node of definition.nodes) {
      const at = `PIPELINES.${name}: node "${node.id}"`
      if (!NODE_ID.test(node.id)) {
        throw new ConfigError(
          `${at}: its id must match ${NODE_ID} (it names the node's child workflows, streams and routes)`,
        )
      }
      if (node.skills?.length) {
        throw new ConfigError(
          `${at}: "skills" are not supported here - the swarm has no skills to resolve them against`,
        )
      }
      if (node.settings !== undefined && Object.keys(node.settings).length > 0) {
        throw new ConfigError(
          `${at}: "settings" are not supported here - the swarm has no resolver that would read them`,
        )
      }
      if (node.model !== undefined && (typeof node.model !== 'string' || !node.model.trim())) {
        throw new ConfigError(`${at}: "model" must be a model id of the worker's provider`)
      }
      for (const t of node.tools ?? []) {
        const server = serverOf(t)
        if (typeof t !== 'string' || (!native.has(t) && !(server && servers.has(server)))) {
          throw new ConfigError(
            `${at}: tool "${t}" is not a tool of this worker (a native tool, or <server>__<tool> of MCP_SERVERS)`,
          )
        }
      }
      for (const s of node.mcpServers ?? []) {
        if (typeof s !== 'string' || !servers.has(s)) {
          throw new ConfigError(
            `${at}: MCP server "${s}" is not one of this worker's (MCP_SERVERS)`,
          )
        }
      }
    }
  }
}

// A node's agent config: the worker's, with the node over it and only what it names.
//
//   model         - the node's, on the worker's provider; the worker's per-stage overrides (and
//                   executor tiers) were written for the worker's model and are dropped with it,
//                   as the core's nodeResolver does
//   instructions  - under the worker's system prompt
//   tools         - those tools (MCP or native); mcpServers - every tool of those servers. A node
//                   that names one tool of a server AND whole servers gets an allowlist: its tools
//                   and the tools of the whole servers as the worker found them at start (`catalog`)
//   nothing named - no tool at all (a node that only reasons), never "every tool"
//   ask           - CHILD_ASK: an 'ask' parks the visit's run ('park') or is a denial ('deny')
export const pipelineNodeConfig = (
  base: IAgentConfig,
  node: PipelineNode,
  catalog: readonly IToolCatalogEntry[] = [],
  ask: ChildAsk = 'deny',
): IAgentConfig => {
  const names = node.tools ?? []
  const whole = new Set(node.mcpServers ?? [])
  const mounted = new Set([...whole, ...names.map(serverOf).filter((s): s is string => Boolean(s))])
  const {
    tools: _tools,
    availableTools: _available,
    subagents: _dynamic,
    planner,
    synthesizer,
    plannerModel,
    synthesizerModel,
    executorTiers,
    ...rest
  } = base
  void [_tools, _available, _dynamic]
  const stages = node.model
    ? {}
    : {
        ...(planner ? { planner } : {}),
        ...(synthesizer ? { synthesizer } : {}),
        ...(plannerModel ? { plannerModel } : {}),
        ...(synthesizerModel ? { synthesizerModel } : {}),
        ...(executorTiers ? { executorTiers } : {}),
      }
  const native = Object.fromEntries(
    Object.entries(base.tools ?? {}).filter(([name]) => names.includes(name)),
  )
  // One tool of a server that is not mounted whole: only an allowlist can say "this one there,
  // all of those".
  const partial = names.some((t) => {
    const server = serverOf(t)
    return server !== undefined && !whole.has(server)
  })
  const available = partial
    ? [
        ...new Set([
          ...names,
          ...catalog.filter((e) => e.server && whole.has(e.server)).map((e) => e.name),
        ]),
      ]
    : undefined
  const systemPrompt = [base.systemPrompt, node.instructions].filter(Boolean).join('\n\n')
  return {
    ...rest,
    ...stages,
    ...(node.model ? { model: node.model } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    mcpServers: Object.fromEntries(
      Object.entries(base.mcpServers ?? {}).filter(([server]) => mounted.has(server)),
    ),
    ...(Object.keys(native).length ? { tools: native } : {}),
    ...(available ? { availableTools: available } : {}),
    // The worker's mode and rules decide; an 'ask' parks the visit (CHILD_ASK=park) or is a denial.
    ...childApproval(base, ask),
  }
}

// JSON with the keys of every object sorted: two copies of the same node compare equal however
// their keys were written.
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  )
