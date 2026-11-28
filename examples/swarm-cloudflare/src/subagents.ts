// Static subagents (SUBAGENTS) - examples/swarm's subagents.ts on this platform: each profile is a
// tool of the session's agent and an agent of its own. The tool is the core's remote subagent
// (`createSubagentTool({ isolation: 'remote', dispatch })`), and `dispatch` never runs the child:
// it answers `deferResult()` at once, so the turn PARKS with one 'tool' item per call. The
// session's object then starts a Workflow instance per item (`SubagentWorkflow`), whose step runs
// the profile's agent, and resumes the turn with their answers. Nothing runs while they work.
//
// One difference: an agent here lives for one step (workerd keeps no I/O across requests, so an
// agent and its MCP connections are made in the step and closed in it), so a call's budget is the
// step's own object (`ITurnBudget`), closed over by the tool - no AsyncLocalStorage needed.
import { createSubagentTool, deferResult, type IAgentConfig } from '@dudko.dev/agent'
import { childApproval, type ChildAsk } from './child-ask.ts'
import { ConfigError } from './env.ts'
import { pipelineTools, type IPipelineConfig } from './pipelines.ts'

export interface ISubagentProfile {
  description: string
  // A model id on the worker's provider (default: the worker's AGENT_MODEL).
  model?: string
  systemPrompt?: string
  tools?: string[]
  maxIterations?: number
  readOnly?: boolean
}

export const SUBAGENT_NAME = /^[a-z][a-z0-9_-]{0,47}$/

type ToolSet = NonNullable<IAgentConfig['tools']>

// What one attempt of a session turn may start (ITurnInput.subagents / .pipelines), and how many
// it dispatched (an attempt parks at its first round that dispatches, so this is the round's).
export interface IChildBudgetLeft {
  maxPerRound: number
  remaining: number
  dispatched: number
}

export interface ITurnBudget {
  subagents?: IChildBudgetLeft
  pipelines?: IChildBudgetLeft
}

export const subagentNote = (name: string): string =>
  `subagent "${name}" runs as a child workflow; its answer will be this call's result`

export const subagentDispatch = (name: string, budget: ITurnBudget) => async () => {
  const b = budget.subagents
  if (!b) {
    throw new Error(`subagent "${name}" can only be called from a turn of a session`)
  }
  if (b.dispatched >= b.maxPerRound) {
    throw new Error(
      `subagent "${name}" refused: at most ${b.maxPerRound} subagent calls in one round - make fewer calls at once`,
    )
  }
  if (b.dispatched >= b.remaining) {
    throw new Error(
      `subagent "${name}" refused: this session may start no more subagent calls - carry on without it`,
    )
  }
  b.dispatched += 1
  return deferResult({ note: subagentNote(name) })
}

export const subagentTools = (
  profiles: Record<string, ISubagentProfile>,
  budget: ITurnBudget,
): ToolSet =>
  Object.fromEntries(
    Object.entries(profiles).map(([name, p]) => [
      name,
      createSubagentTool({
        name,
        description: p.description,
        isolation: 'remote',
        dispatch: subagentDispatch(name, budget),
        ...(p.readOnly ? { readOnly: true } : {}),
      }),
    ]),
  )

export const serverOf = (tool: string): string | undefined => {
  const at = tool.indexOf('__')
  return at > 0 ? tool.slice(0, at) : undefined
}

// Every profile's tools are the worker's: a native tool, or `<server>__<tool>` of one of its MCP
// servers. A subagent's name must not shadow a tool of the worker.
export const checkSubagentProfiles = (
  profiles: Record<string, ISubagentProfile>,
  base: Pick<IAgentConfig, 'tools' | 'mcpServers'>,
): void => {
  const native = new Set(Object.keys(base.tools ?? {}))
  const servers = new Set(Object.keys(base.mcpServers ?? {}))
  for (const [name, p] of Object.entries(profiles)) {
    if (!SUBAGENT_NAME.test(name) || name.includes('__')) {
      throw new ConfigError(`SUBAGENTS: "${name}" must match ${SUBAGENT_NAME} (and have no "__")`)
    }
    if (native.has(name)) {
      throw new ConfigError(`SUBAGENTS: "${name}" is already a tool of the worker`)
    }
    for (const t of p.tools ?? []) {
      const server = serverOf(t)
      if (!native.has(t) && !(server && servers.has(server))) {
        throw new ConfigError(
          `SUBAGENTS.${name}.tools: "${t}" is not a tool of this worker (a native tool, or <server>__<tool> of MCP_SERVERS)`,
        )
      }
    }
  }
}

// The child agent's config: the worker's, with the profile over it and only its tools. `modelOf`
// builds a model id on the worker's provider (models are objects here: agent-config.ts).
export const childAgentConfig = (
  base: IAgentConfig,
  p: ISubagentProfile,
  modelOf: (id: string) => IAgentConfig['model'],
  ask: ChildAsk = 'deny',
): IAgentConfig => {
  const names = p.tools ?? []
  const servers = new Set(names.map(serverOf).filter((s): s is string => Boolean(s)))
  const { tools: _tools, availableTools: _available, subagents: _dynamic, ...rest } = base
  void [_tools, _available, _dynamic]
  const native = Object.fromEntries(
    Object.entries(base.tools ?? {}).filter(([name]) => names.includes(name)),
  )
  return {
    ...rest,
    ...(p.model ? { model: modelOf(p.model) } : {}),
    ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
    ...(p.maxIterations ? { maxIterations: p.maxIterations } : {}),
    mcpServers: Object.fromEntries(
      Object.entries(base.mcpServers ?? {}).filter(([server]) => servers.has(server)),
    ),
    ...(Object.keys(native).length ? { tools: native } : {}),
    ...(names.length ? { availableTools: names } : {}),
    ...childApproval(base, ask),
  }
}

// The session agent's config: the worker's, with the subagents' and the pipelines' tools and
// parking on a person's question.
export const sessionAgentConfig = (
  base: IAgentConfig,
  profiles: Record<string, ISubagentProfile>,
  pipelines: Record<string, IPipelineConfig>,
  budget: ITurnBudget,
): IAgentConfig => ({
  ...base,
  ...(Object.keys(profiles).length || Object.keys(pipelines).length
    ? {
        tools: {
          ...(base.tools ?? {}),
          ...subagentTools(profiles, budget),
          ...pipelineTools(pipelines, budget),
        },
      }
    : {}),
  toolApproval: { ...(base.toolApproval ?? {}), onRequest: () => ({ park: true }) },
})
