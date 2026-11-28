// Static subagents (SUBAGENTS): each profile is a tool of the session's agent and an agent of its
// own on the worker. The tool is the core's remote subagent (`createSubagentTool({ isolation:
// 'remote', dispatch })`), and `dispatch` never runs the child: it answers `deferResult()` at once,
// so the turn PARKS with one 'tool' item per call. The session workflow then starts a child
// workflow per item (session-state.ts, workflows.ts), whose activity runs the profile's agent
// (activities.ts, runSubagent), and resumes the turn with their answers. No worker slot is held
// while the children run.
//
// A profile's agent is the worker's agent with the profile laid over it: another model, another
// system prompt, and ONLY the tools it lists - each one a tool the worker itself has (an MCP
// server's `<server>__<tool>`, or a native tool), checked when the worker starts. A child has no
// subagents of its own. Its approvals follow the worker's mode and rules; an 'ask' PARKS the
// child's own run (CHILD_ASK=park, the default: the child workflow waits for the person's answer
// through the gateway, like a session turn) or is a denial (CHILD_ASK=deny: nobody to ask).
import { createSubagentTool, deferResult, type IAgentConfig } from '@dudko.dev/agent'
import { childApproval, type ChildAsk } from './child-ask.ts'
import { ConfigError } from './env.ts'
import { currentTurnScope } from './lease.ts'
import { pipelineTools, type IPipelineConfig } from './pipelines.ts'

export interface ISubagentProfile {
  // When the parent model should call it (the tool's description).
  description: string
  // The model, on the worker's provider (default: the worker's AGENT_MODEL).
  model?: string
  systemPrompt?: string
  // The tools the child may use: names the worker mounts. None: a child that only reasons.
  tools?: string[]
  maxIterations?: number
  // Mark the tool read-only for tool approval (under ask-writes a call then does not ask first).
  readOnly?: boolean
}

export const SUBAGENT_NAME = /^[a-z][a-z0-9_-]{0,47}$/

type ToolSet = NonNullable<IAgentConfig['tools']>

// The note the parked item carries (what the parent model and a client read).
export const subagentNote = (name: string): string =>
  `subagent "${name}" runs as a child workflow; its answer will be this call's result`

// What a call of `name` does: defer, within the caps the turn was given (ITurnInput.subagents) -
// per round (an attempt parks at its first round that dispatches, so the attempt's count is the
// round's) and per session. A call beyond them is a tool error the model reads.
export const subagentDispatch = (name: string) => async () => {
  const budget = currentTurnScope()?.subagents
  if (!budget) {
    throw new Error(`subagent "${name}" can only be called from a turn of a session`)
  }
  if (budget.dispatched >= budget.maxPerRound) {
    throw new Error(
      `subagent "${name}" refused: at most ${budget.maxPerRound} subagent calls in one round - make fewer calls at once`,
    )
  }
  if (budget.dispatched >= budget.remaining) {
    throw new Error(
      `subagent "${name}" refused: this session may start no more subagent calls - carry on without it`,
    )
  }
  budget.dispatched += 1
  return deferResult({ note: subagentNote(name) })
}

export const subagentTools = (profiles: Record<string, ISubagentProfile>): ToolSet =>
  Object.fromEntries(
    Object.entries(profiles).map(([name, p]) => [
      name,
      createSubagentTool({
        name,
        description: p.description,
        isolation: 'remote',
        dispatch: subagentDispatch(name),
        ...(p.readOnly ? { readOnly: true } : {}),
      }),
    ]),
  )

const serverOf = (tool: string): string | undefined => {
  const at = tool.indexOf('__')
  return at > 0 ? tool.slice(0, at) : undefined
}

// Every profile's tools are the worker's: a native tool of `base`, or `<server>__<tool>` of one of
// its MCP servers. A subagent's name must not shadow a tool of the worker.
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

// The child agent's config: the worker's, with the profile over it and only its tools. `ask`:
// CHILD_ASK (default 'deny' here: nobody to ask unless the worker says the children may wait).
export const childAgentConfig = (
  base: IAgentConfig,
  p: ISubagentProfile,
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
    ...(p.model ? { model: p.model } : {}),
    ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
    ...(p.maxIterations ? { maxIterations: p.maxIterations } : {}),
    mcpServers: Object.fromEntries(
      Object.entries(base.mcpServers ?? {}).filter(([server]) => servers.has(server)),
    ),
    ...(Object.keys(native).length ? { tools: native } : {}),
    ...(names.length ? { availableTools: names } : {}),
    // The worker's mode and rules decide; an 'ask' parks the child (CHILD_ASK=park) or is a denial.
    ...childApproval(base, ask),
  }
}

// The session agent's config: the worker's, with the subagents' and the pipelines' tools and
// parking on a person's question (an 'ask' of the approval mode parks the turn until the answer
// comes through the gateway).
export const sessionAgentConfig = (
  base: IAgentConfig,
  profiles: Record<string, ISubagentProfile>,
  pipelines: Record<string, IPipelineConfig> = {},
): IAgentConfig => ({
  ...base,
  ...(Object.keys(profiles).length || Object.keys(pipelines).length
    ? {
        tools: {
          ...(base.tools ?? {}),
          ...subagentTools(profiles),
          ...pipelineTools(pipelines),
        },
      }
    : {}),
  toolApproval: { ...(base.toolApproval ?? {}), onRequest: () => ({ park: true }) },
})
