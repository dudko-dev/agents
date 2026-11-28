// Pipelines (PIPELINES) - examples/swarm's pipelines.ts on this platform: each one a tool of the
// session's agent (the core's remote subagent tool, whose `dispatch` defers: the turn parks with a
// 'tool' item per call) and a graph of agents run by a `PipelineWorkflow` instance - the core's
// graph engine as its scheduler - with every node visit a `PipelineNodeWorkflow` instance of its
// own. A node resolves against the worker: its model id on the worker's provider, its
// instructions under the worker's system prompt, its tools and MCP servers the worker's own;
// anything else is refused when the configuration is read.
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
import { childApproval, type ChildAsk } from './child-ask.ts'
import { ConfigError } from './env.ts'
import type { ITurnBudget } from './subagents.ts'

export interface IPipelineConfig {
  description: string
  definition: PipelineDefinition
  readOnly?: boolean
}

export const PIPELINE_NAME = /^[a-z][a-z0-9_-]{0,47}$/
// A node's id names its visits' children, streams and routes: no '.', no '/'.
export const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/

type ToolSet = NonNullable<IAgentConfig['tools']>

export const pipelineNote = (name: string): string =>
  `pipeline "${name}" runs as a child workflow; its answer will be this call's result`

export const pipelineDispatch = (name: string, budget: ITurnBudget) => async () => {
  const b = budget.pipelines
  if (!b) {
    throw new Error(`pipeline "${name}" can only be called from a turn of a session`)
  }
  if (b.dispatched >= b.maxPerRound) {
    throw new Error(
      `pipeline "${name}" refused: at most ${b.maxPerRound} pipeline calls in one round - make fewer calls at once`,
    )
  }
  if (b.dispatched >= b.remaining) {
    throw new Error(
      `pipeline "${name}" refused: this session may start no more pipeline calls - carry on without it`,
    )
  }
  b.dispatched += 1
  return deferResult({ note: pipelineNote(name) })
}

export const pipelineTools = (
  pipelines: Record<string, IPipelineConfig>,
  budget: ITurnBudget,
): ToolSet =>
  Object.fromEntries(
    Object.entries(pipelines).map(([name, p]) => [
      name,
      createSubagentTool({
        name,
        description: p.description,
        isolation: 'remote',
        dispatch: pipelineDispatch(name, budget),
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
          `${at}: its id must match ${NODE_ID} (it names the node's children, streams and routes)`,
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

// One tool of a server that is not mounted whole: the node needs an allowlist, and the allowlist
// needs the tools of the whole servers (the catalog).
export const needsCatalog = (node: PipelineNode): boolean => {
  const whole = new Set(node.mcpServers ?? [])
  return (node.tools ?? []).some((t) => {
    const server = serverOf(t)
    return server !== undefined && !whole.has(server)
  })
}

// A node's agent config: the worker's, with the node over it and only what it names (see
// examples/swarm's pipelineNodeConfig: the same rules, with the model built here as an object).
export const pipelineNodeConfig = (
  base: IAgentConfig,
  node: PipelineNode,
  modelOf: (id: string) => IAgentConfig['model'],
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
  const available = needsCatalog(node)
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
    ...(node.model ? { model: modelOf(node.model) } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    mcpServers: Object.fromEntries(
      Object.entries(base.mcpServers ?? {}).filter(([server]) => mounted.has(server)),
    ),
    ...(Object.keys(native).length ? { tools: native } : {}),
    ...(available ? { availableTools: available } : {}),
    ...childApproval(base, ask),
  }
}

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
