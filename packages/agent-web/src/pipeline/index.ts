import { z } from 'zod'
import type { IUsage } from '../agent/loop-types.js'
import { addUsage } from '../agent/loop-types.js'
import { createAgent, type Agent } from '../agent/runner.js'
import { resolveConfig, type BrowserAgentConfig } from '../config.js'
import type { AgentEvent, AgentEventHandler } from '../events.js'
import { generate, generateStructured } from '../llm/generate.js'
import { normalizeUsage, usageOfError } from '../llm/util.js'
import type { ModelInput } from '../providers/types.js'
import type { Skill } from '../skills.js'
import type { AgentToolSet } from '../tools/types.js'
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
} from './engine.js'

/**
 * A pipeline: a graph of agents with conditions and loops, described in plain JSON. The graph
 * engine (validation, conditions, scheduling) is `engine.ts`, the same file as the Node
 * sibling's; this file is the adapter that runs a node with this package's createAgent.
 */

export interface PipelineOptions {
  /** The seam: run a node yourself. When given, the pipeline knows nothing about agents. */
  runNode?: PipelineNodeRunner<AgentEvent>
  /**
   * Otherwise: the agent config of a node. One agent is created per node, on its first visit,
   * and kept until `pipeline.close()`.
   */
  resolveNode?: (node: PipelineNode) => BrowserAgentConfig | Promise<BrowserAgentConfig>
}

export interface PipelineRunOptions {
  input: string
  signal?: AbortSignal
  /** The pipeline.* events, and every node agent's own events with `nodeId` and `visit` added. */
  onEvent?: AgentEventHandler
}

export interface Pipeline {
  /** A copy of the validated definition. */
  definition: PipelineDefinition
  /**
   * Rejects with PipelineNodeError when a node fails. An aborted `signal` resolves with what the
   * run has and `stoppedBy: 'aborted'` (as agent.run resolves with `stopped`).
   */
  run: (options: PipelineRunOptions) => Promise<PipelineResult>
  /** Drop the node agents. The pipeline can run again: agents are created anew. */
  close: () => Promise<void>
}

interface NodeAgent {
  agent: Agent
  config: BrowserAgentConfig
}

const aborted = (): Error => new DOMException('Aborted', 'AbortError')

/**
 * Ask the node's planner model which of its routes the answer takes: structured output first,
 * a plain-text answer as the fallback (tiny local models). An answer that is not one of the
 * labels - or a call that fails - is no route.
 */
const pickRoute = async (
  { agent, config }: NodeAgent,
  node: PipelineNode,
  text: string,
  signal: AbortSignal,
): Promise<{ route?: string; usage: IUsage }> => {
  const cfg = resolveConfig(config)
  const labels = (node.routes ?? []).map((r) => r.label)
  const call = {
    system: PIPELINE_ROUTER_SYSTEM,
    prompt: renderPipelineRoutePrompt(node, text),
    maxOutputTokens: cfg.budgets.replanner,
    temperature: cfg.temperature,
    abortSignal: signal,
    timeoutMs: cfg.chatTimeoutMs,
  }
  let wasted = normalizeUsage()
  try {
    const schema = z.object({
      route: z.enum(labels as [string, ...string[]]).describe('The label of the chosen route'),
    })
    const r = await generateStructured(agent.models.planner, schema, call)
    return { route: matchPipelineRoute(node, r.object), usage: normalizeUsage(r.usage) }
  } catch (err) {
    if (signal.aborted) throw aborted()
    wasted = usageOfError(err)
  }
  try {
    const r = await generate(agent.models.planner, call)
    return {
      route: matchPipelineRoute(node, r.text),
      usage: addUsage(wasted, normalizeUsage(r.usage)),
    }
  } catch {
    if (signal.aborted) throw aborted()
    return { usage: wasted }
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
  const agents = new Map<string, Promise<NodeAgent>>()

  const agentOf = (node: PipelineNode): Promise<NodeAgent> => {
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
    // agent.run reports a failed run as an event and an answer that is the error text; for a
    // pipeline that is a failed node, not an output to route on.
    let failure: string | undefined
    const result = await entry.agent.run(renderPipelineNodeInput(input), {
      signal: ctx.signal,
      onEvent: (event) => {
        if (event.type === 'error' && event.phase === 'run') failure = event.error
        ctx.emit(event)
      },
    })
    if (result.stopped || ctx.signal.aborted) throw aborted()
    if (failure !== undefined) throw new Error(failure)
    if (!node.routes?.length) return { text: result.final, usage: result.usage }
    const picked = await pickRoute(entry, node, result.final, ctx.signal)
    return {
      text: result.final,
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
        'resolve',
      ),
    close: async () => {
      agents.clear()
    },
  }
}

export interface NodeResolverOptions {
  /**
   * The config every node starts from. With `memory`, each node gets a session of its own,
   * `<base sessionId>:<node id>`, unless `configure` sets another.
   */
  base: BrowserAgentConfig
  /**
   * What the names in a node may refer to. A name that is not registered fails the node: a
   * definition cannot reach anything the host did not put here.
   */
  models?: Record<string, ModelInput>
  skills?: Record<string, Skill>
  /** Named groups of tools. */
  tools?: Record<string, AgentToolSet>
  /** Connected MCP servers (`connectMcpHttp` from `./mcp`), or any object with their `tools`. */
  mcpServers?: Record<string, { tools: AgentToolSet }>
  /**
   * The last word on a node's config - the place to read `node.settings`, which is never
   * applied by itself (it comes from the definition, and a definition is not trusted).
   */
  configure?: (
    config: BrowserAgentConfig,
    node: PipelineNode,
  ) => BrowserAgentConfig | Promise<BrowserAgentConfig>
}

const lookup = <T>(
  node: PipelineNode,
  kind: string,
  registry: Record<string, T> | undefined,
  key: string,
): T => {
  if (!registry || !Object.prototype.hasOwnProperty.call(registry, key)) {
    const known = Object.keys(registry ?? {})
    throw new Error(
      `Pipeline node "${node.id}": unknown ${kind} "${key}" (registered: ${known.length ? known.join(', ') : 'none'})`,
    )
  }
  return registry[key]
}

/**
 * Build a `resolveNode` from registries: a node's `model`, `skills`, `tools` and `mcpServers`
 * names are looked up and added to `base`.
 */
export const nodeResolver =
  (options: NodeResolverOptions): NonNullable<PipelineOptions['resolveNode']> =>
  async (node) => {
    let config: BrowserAgentConfig = { ...options.base }
    if (node.model !== undefined) {
      // Another model: the base's per-stage overrides were written for the base model.
      const { planner, synthesizer, ...rest } = config
      void [planner, synthesizer]
      config = { ...rest, model: lookup(node, 'model', options.models, node.model) }
    }
    if (node.skills?.length) {
      const named = node.skills.map((key) => lookup(node, 'skill', options.skills, key))
      const names = new Set(named.map((s) => s.name))
      config.skills = [...(config.skills ?? []).filter((s) => !names.has(s.name)), ...named]
    }
    const groups = [
      ...(node.tools ?? []).map((key) => lookup(node, 'tool group', options.tools, key)),
      ...(node.mcpServers ?? []).map(
        (key) => lookup(node, 'MCP server', options.mcpServers, key).tools,
      ),
    ]
    if (groups.length) config.tools = Object.assign({ ...config.tools }, ...groups) as AgentToolSet
    // A node keeps its own conversation across visits; two nodes must not share one by accident.
    if (config.memory) config.sessionId = `${config.sessionId ?? 'default'}:${node.id}`
    return options.configure ? options.configure(config, node) : config
  }
