import { z } from 'zod'
import type { IUsage } from '../agent/loop-types.js'
import { addUsage } from '../agent/loop-types.js'
import { createAgent, type Agent } from '../agent/runner.js'
import { resolveConfig, type BrowserAgentConfig } from '../config.js'
import {
  askDecisionModel,
  decisionEventOf,
  decisionUsageOf,
  routeDecisionQuestion,
} from '../decision.js'
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
 * sibling's; this file is the adapter that runs a node with this package's createAgent, and the
 * route call after it (`pickPipelineRoute`, public for hosts that run the graph themselves with
 * `runPipelineGraph`).
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

export interface PipelineRouteOptions {
  /**
   * The node's agent: its planner model picks the route (structured output, then plain text), its
   * decision model (`config.decisionModel`, resolved) is asked first.
   */
  agent: Agent
  /** The config that agent was built from: the budget, temperature, timeout and `decision`. */
  config: BrowserAgentConfig
  signal?: AbortSignal
  /** A decision model's `usage` and `decision` events. A handler that throws breaks nothing. */
  onEvent?: AgentEventHandler
}

export interface PipelineRouteResult {
  /** One of the node's labels, or undefined: no route. */
  route?: string
  /** What the call cost, a failed attempt and a decision model's question included. */
  usage: IUsage
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
): Promise<PipelineRouteResult> => {
  const cfg = resolveConfig(config)
  const labels = (node.routes ?? []).map((r) => r.label)
  const call = {
    system: PIPELINE_ROUTER_SYSTEM,
    prompt: renderPipelineRoutePrompt(node, text),
    // 0 = no cap (the host turned it off, or the stage thinks).
    ...(cfg.budgets.replanner > 0 ? { maxOutputTokens: cfg.budgets.replanner } : {}),
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

/**
 * `config.decisionModel` of the node's agent, asked before the route call. Returns the route when
 * the model is confident of one of the labels, and undefined when the route call must run as
 * ever (no decision model, fewer than two labels, a low confidence, an error, a timeout, an
 * answer that is not a label). A `decision` event says what happened; what the question cost is
 * returned either way.
 */
const pickRouteWithDecisionModel = async (
  { agent, config }: NodeAgent,
  node: PipelineNode,
  text: string,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
): Promise<PipelineRouteResult | undefined> => {
  const model = agent.decisionModel
  const routes = node.routes ?? []
  if (!model || config.decision?.route === false || routes.length < 2) return undefined
  const question = routeDecisionQuestion(routes, renderPipelineRoutePrompt(node, text))
  let outcome
  try {
    outcome = await askDecisionModel(model, question, config.decision, signal)
  } catch (err) {
    if (signal.aborted) throw aborted()
    throw err
  }
  const usage = decisionUsageOf(outcome)
  emit({ type: 'usage', phase: 'decision', usage })
  emit(decisionEventOf('route', outcome, model))
  return {
    usage,
    ...(outcome.accepted && outcome.choice !== undefined ? { route: outcome.choice } : {}),
  }
}

/**
 * The route call createPipeline makes after a node with routes answered, as a function of its
 * own: a host that runs the graph itself (`runPipelineGraph`) calls it wherever the node ran, with
 * the node's answer. The node's decision model first, when it is confident of a label; otherwise
 * the node's planner model (structured output, then plain text). An answer that is not one of the
 * labels, or a call that fails, is no route (`route` undefined); an abort rejects with an
 * AbortError. A node without routes costs nothing.
 */
export const pickPipelineRoute = async (
  node: PipelineNode,
  text: string,
  options: PipelineRouteOptions,
): Promise<PipelineRouteResult> => {
  if (!node.routes?.length) return { usage: normalizeUsage() }
  const entry: NodeAgent = { agent: options.agent, config: options.config }
  const signal = options.signal ?? new AbortController().signal
  const emit = (event: AgentEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // A handler that throws must not change the route.
    }
  }
  const quick = await pickRouteWithDecisionModel(entry, node, text, signal, emit)
  if (quick?.route) return quick
  const slow = await pickRoute(entry, node, text, signal)
  return quick ? { ...slow, usage: addUsage(quick.usage, slow.usage) } : slow
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
    const picked = await pickPipelineRoute(node, result.final, {
      ...entry,
      signal: ctx.signal,
      onEvent: ctx.emit,
    })
    return {
      text: result.final,
      usage: addUsage(result.usage, picked.usage),
      ...(picked.route ? { route: picked.route } : {}),
    }
  }

  return {
    definition: plan.definition,
    run: (run) =>
      runPipelineGraph<AgentEvent>(plan, options.runNode ?? runWithAgent, {
        input: run.input,
        signal: run.signal,
        onEvent: run.onEvent as never,
        onAbort: 'resolve',
      }),
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
      // Another model: the base's per-stage overrides - and its executor tiers - were written
      // for the base model.
      const { planner, synthesizer, executorTiers, ...rest } = config
      void [planner, synthesizer, executorTiers]
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
