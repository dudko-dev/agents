import { generateObject, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import { createAgent, type IAgent } from './agent.ts'
import { stageCallOptions } from './call-options.ts'
import {
  matchPipelineRoute,
  PIPELINE_ROUTER_SYSTEM,
  preparePipeline,
  renderPipelineNodeInput,
  renderPipelineRoutePrompt,
  runPipelineGraph,
  type PipelineDefinition,
  type PipelineNode,
  type PipelineNodeRunner,
  type PipelineResult,
} from './pipeline-engine.ts'
import { buildModelFromStage, resolveStage } from './provider.ts'
import type {
  AgentEvent,
  EventHandler,
  IAgentConfig,
  IMcpServerConfig,
  ISkill,
  IUsage,
} from './types.ts'
import { addUsage, normalizeUsage, withRetry, withTimeout } from './utils.ts'

// A pipeline: a graph of agents with conditions and loops, described in plain JSON. The graph
// engine (validation, conditions, scheduling) is `pipeline-engine.ts`, the same file as the
// browser sibling's; this file is the adapter that runs a node with this package's createAgent.

export interface PipelineOptions {
  // The seam: run a node yourself. When given, the pipeline knows nothing about agents.
  runNode?: PipelineNodeRunner<AgentEvent>
  // Otherwise: the agent config of a node. One agent is created per node, on its first visit,
  // and kept until `pipeline.close()`.
  resolveNode?: (node: PipelineNode) => IAgentConfig | Promise<IAgentConfig>
}

export interface PipelineRunOptions {
  input: string
  signal?: AbortSignal
  // The pipeline.* events, and every node agent's own events with `nodeId` and `visit` added.
  onEvent?: EventHandler
}

export interface Pipeline {
  // A copy of the validated definition.
  definition: PipelineDefinition
  // Rejects with PipelineNodeError when a node fails, and with an AbortError when `signal` aborts
  // (as agent.run does).
  run: (options: PipelineRunOptions) => Promise<PipelineResult>
  // Close the node agents (their MCP connections). The pipeline can run again: agents are
  // created anew.
  close: () => Promise<void>
}

interface INodeAgent {
  agent: IAgent
  config: IAgentConfig
  // The model that picks a route: the node's planner model, the one this package uses for
  // structured output.
  router?: LanguageModel
}

// Ask the node's model which of its routes the answer takes. An answer that is not one of the
// labels - or a call that fails - is no route.
const pickRoute = async (
  entry: INodeAgent,
  node: PipelineNode,
  text: string,
  signal: AbortSignal,
): Promise<{ route?: string; usage: IUsage }> => {
  const { config } = entry
  entry.router ??= await buildModelFromStage(
    config.clientName,
    resolveStage(config, config.planner, config.plannerModel, 'planner'),
  )
  const model = entry.router
  const labels = (node.routes ?? []).map((r) => r.label)
  const schema = z.object({
    route: z.enum(labels as [string, ...string[]]).describe('The label of the chosen route'),
  })
  try {
    const r = await withRetry(
      () =>
        generateObject({
          model,
          schema,
          ...stageCallOptions(config, 'replanner', PIPELINE_ROUTER_SYSTEM),
          prompt: renderPipelineRoutePrompt(node, text),
          abortSignal: withTimeout(signal, config.llmTimeoutMs ?? 0),
        }),
      { maxRetries: config.llmMaxRetries ?? 2, signal },
    )
    return { route: matchPipelineRoute(node, r.object), usage: normalizeUsage(r.usage) }
  } catch (err) {
    if (signal.aborted) throw err
    // What a failed structured attempt cost still counts.
    return { usage: normalizeUsage((err as { usage?: never } | null)?.usage) }
  }
}

export const createPipeline = (
  definition: PipelineDefinition,
  options: PipelineOptions,
): Pipeline => {
  const plan = preparePipeline(definition)
  const { resolveNode } = options
  if (!options.runNode && !resolveNode) {
    throw new Error('createPipeline needs `resolveNode` (or `runNode`)')
  }
  const agents = new Map<string, Promise<INodeAgent>>()

  const agentOf = (node: PipelineNode): Promise<INodeAgent> => {
    let entry = agents.get(node.id)
    if (!entry) {
      entry = (async () => {
        const resolved = await (resolveNode as NonNullable<typeof resolveNode>)(node)
        const systemPrompt = [resolved.systemPrompt, node.instructions].filter(Boolean).join('\n\n')
        const config = { ...resolved, ...(systemPrompt ? { systemPrompt } : {}) }
        return { agent: await createAgent(config), config }
      })()
      agents.set(node.id, entry)
      // A node that could not be built is tried again on its next visit.
      entry.catch(() => agents.delete(node.id))
    }
    return entry
  }

  const runWithAgent: PipelineNodeRunner<AgentEvent> = async (node, input, ctx) => {
    const entry = await agentOf(node)
    const result = await entry.agent.run({
      input: renderPipelineNodeInput(input),
      signal: ctx.signal,
      onEvent: ctx.emit,
    })
    if (!node.routes?.length) return { text: result.text, usage: result.usage }
    const picked = await pickRoute(entry, node, result.text, ctx.signal)
    return {
      text: result.text,
      usage: addUsage(result.usage, picked.usage),
      ...(picked.route ? { route: picked.route } : {}),
    }
  }

  return {
    definition: plan.definition,
    run: (run) =>
      runPipelineGraph<AgentEvent>(
        plan,
        options.runNode ?? runWithAgent,
        { input: run.input, signal: run.signal, onEvent: run.onEvent as never },
        'reject',
      ),
    close: async () => {
      const open = [...agents.values()]
      agents.clear()
      await Promise.all(
        open.map((entry) =>
          entry.then(
            ({ agent }) => agent.close().catch(() => {}),
            () => {},
          ),
        ),
      )
    },
  }
}

// What a `model` key of a node stands for: the model fields of an agent config.
export type PipelineModelConfig = Pick<IAgentConfig, 'model'> &
  Partial<
    Pick<
      IAgentConfig,
      'providerType' | 'baseURL' | 'apiKey' | 'providerOptions' | 'planner' | 'synthesizer'
    >
  >

export interface NodeResolverOptions {
  // The config every node starts from.
  base: IAgentConfig
  // What the names in a node may refer to. A name that is not registered fails the node: a
  // definition cannot reach anything the host did not put here.
  models?: Record<string, PipelineModelConfig>
  skills?: Record<string, ISkill>
  // Named groups of tools.
  tools?: Record<string, ToolSet>
  mcpServers?: Record<string, IMcpServerConfig>
  // The last word on a node's config - the place to read `node.settings`, which is never
  // applied by itself (it comes from the definition, and a definition is not trusted).
  configure?: (config: IAgentConfig, node: PipelineNode) => IAgentConfig | Promise<IAgentConfig>
}

const lookup = <T>(
  node: PipelineNode,
  kind: string,
  registry: Record<string, T> | undefined,
  key: string,
): T => {
  if (!registry || !Object.hasOwn(registry, key)) {
    const known = Object.keys(registry ?? {})
    throw new Error(
      `Pipeline node "${node.id}": unknown ${kind} "${key}" (registered: ${known.length ? known.join(', ') : 'none'})`,
    )
  }
  return registry[key]
}

// Build a `resolveNode` from registries: a node's `model`, `skills`, `tools` and `mcpServers`
// names are looked up and added to `base`.
export const nodeResolver =
  (options: NodeResolverOptions): NonNullable<PipelineOptions['resolveNode']> =>
  async (node) => {
    let config: IAgentConfig = { ...options.base }
    if (node.model !== undefined) {
      // Another model: the base's per-stage overrides were written for the base model.
      const { planner, synthesizer, plannerModel, synthesizerModel, ...rest } = config
      void [planner, synthesizer, plannerModel, synthesizerModel]
      config = { ...rest, ...lookup(node, 'model', options.models, node.model) }
    }
    if (node.skills?.length) {
      const named = node.skills.map((key) => lookup(node, 'skill', options.skills, key))
      const names = new Set(named.map((s) => s.name))
      config.skills = [...(config.skills ?? []).filter((s) => !names.has(s.name)), ...named]
    }
    if (node.tools?.length) {
      config.tools = Object.assign(
        { ...config.tools },
        ...node.tools.map((key) => lookup(node, 'tool group', options.tools, key)),
      ) as ToolSet
    }
    if (node.mcpServers?.length) {
      config.mcpServers = { ...config.mcpServers }
      for (const key of node.mcpServers) {
        config.mcpServers[key] = lookup(node, 'MCP server', options.mcpServers, key)
      }
    }
    return options.configure ? options.configure(config, node) : config
  }
