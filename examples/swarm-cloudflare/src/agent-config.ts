// The agent's config from the Worker's environment: examples/swarm's agent-config.ts (a subset of
// the `dd-agent` CLI's variables, under the same names), with two differences of the platform:
//
//   - the model is built HERE, as an AI SDK model object (`model: createOpenAI(...)(id)`): the core
//     would `import()` the provider package a model id names, which a bundle cannot do (#85). So
//     AGENT_PROVIDER_TYPE is one of the four providers this Worker bundles, and a subagent's or a
//     pipeline node's `model` (a model id) is built the same way, on the same provider;
//   - MCP servers are HTTP only (`{"url": ...}`): workerd has no processes for stdio.
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type {
  IAgentConfig,
  IMcpServerConfig,
  LogLevel,
  ToolApprovalMode,
  ToolPermission,
} from '@dudko.dev/agent'
import { bool, ConfigError, int, json, oneOf, optionalInt, required, str, type Env } from './env.ts'
import { checkPipelines, preparedDefinition, type IPipelineConfig } from './pipelines.ts'
import { checkSubagentProfiles, type ISubagentProfile } from './subagents.ts'

// The providers this Worker bundles (package.json). Another one: add its @ai-sdk/* package, a case
// in `modelFactory`, and rebuild.
export const PROVIDERS = ['openai', 'anthropic', 'google', 'openai-compatible'] as const
export type CloudflareProvider = (typeof PROVIDERS)[number]

const APPROVAL_MODES: readonly ToolApprovalMode[] = [
  'autopilot',
  'ask-writes',
  'ask-all',
  'read-only',
]
const PERMISSIONS: readonly ToolPermission[] = ['allow', 'ask', 'deny']
const LOG_LEVELS: readonly LogLevel[] = ['none', 'error', 'warn', 'info', 'debug']

type ModelOf = (id: string) => Exclude<IAgentConfig['model'], string>

export interface IModelSettings {
  providerType: CloudflareProvider
  apiKey: string
  baseURL?: string
  options?: Record<string, unknown>
  clientName: string
}

// A model id on the configured provider, as a model object - the core's own provider calls, made
// here (packages/agent/src/provider.ts: the same factory options, `name: clientName` for
// openai-compatible).
export const modelFactory = (s: IModelSettings): ModelOf => {
  const baseURL = s.baseURL || undefined
  const options = s.options ?? {}
  switch (s.providerType) {
    case 'openai': {
      const p = createOpenAI({ baseURL, apiKey: s.apiKey, ...options })
      return (id) => p(id)
    }
    case 'anthropic': {
      const p = createAnthropic({ baseURL, apiKey: s.apiKey, ...options })
      return (id) => p(id)
    }
    case 'google': {
      const p = createGoogleGenerativeAI({ baseURL, apiKey: s.apiKey, ...options })
      return (id) => p(id)
    }
    case 'openai-compatible': {
      if (!baseURL) {
        throw new ConfigError(
          'AGENT_BASE_URL is required for AGENT_PROVIDER_TYPE=openai-compatible',
        )
      }
      const p = createOpenAICompatible({
        name: s.clientName,
        baseURL,
        apiKey: s.apiKey,
        ...options,
      })
      return (id) => p(id)
    }
  }
}

// MCP_SERVERS: {"name": {"url": "https://...", "headers": {...}}}. HTTP only.
const mcpServers = (env: Env): Record<string, IMcpServerConfig> => {
  const raw = json(env, 'MCP_SERVERS')
  if (raw === undefined) {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('MCP_SERVERS must be a JSON object of name -> { url, headers? }')
  }
  const out: Record<string, IMcpServerConfig> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = (value ?? {}) as Record<string, unknown>
    if (typeof v.command === 'string') {
      throw new ConfigError(
        `MCP_SERVERS.${name}: stdio servers ("command") cannot run on Cloudflare Workers - give an HTTP server's "url"`,
      )
    }
    if (typeof v.url !== 'string') {
      throw new ConfigError(`MCP_SERVERS.${name} needs a "url" (an HTTP MCP server)`)
    }
    const headers = v.headers as Record<string, string> | undefined
    if (headers !== undefined && (typeof headers !== 'object' || Array.isArray(headers))) {
      throw new ConfigError(`MCP_SERVERS.${name}.headers must be an object of strings`)
    }
    out[name] = { url: v.url, ...(headers ? { headers } : {}) }
  }
  return out
}

const toolRules = (env: Env): Record<string, ToolPermission> | undefined => {
  const raw = json(env, 'AGENT_TOOL_RULES')
  if (raw === undefined) {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      'AGENT_TOOL_RULES must be a JSON object of tool name or glob -> allow | ask | deny',
    )
  }
  for (const [pattern, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!PERMISSIONS.includes(p as ToolPermission)) {
      throw new ConfigError(`AGENT_TOOL_RULES["${pattern}"] must be allow | ask | deny`)
    }
  }
  return raw as Record<string, ToolPermission>
}

const PROFILE_KEYS = new Set([
  'description',
  'model',
  'systemPrompt',
  'tools',
  'maxIterations',
  'readOnly',
])

export const subagentProfilesFromEnv = (
  env: Env,
  base: Pick<IAgentConfig, 'tools' | 'mcpServers'>,
): Record<string, ISubagentProfile> => {
  const raw = json(env, 'SUBAGENTS')
  if (raw === undefined) {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      'SUBAGENTS must be a JSON object of name -> { description, model?, systemPrompt?, tools?, maxIterations?, readOnly? }',
    )
  }
  const out: Record<string, ISubagentProfile> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as Record<string, unknown>
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new ConfigError(`SUBAGENTS.${name} must be an object`)
    }
    const unknown = Object.keys(v).filter((k) => !PROFILE_KEYS.has(k))
    if (unknown.length) {
      throw new ConfigError(`SUBAGENTS.${name}: unknown field(s) ${unknown.join(', ')}`)
    }
    if (typeof v.description !== 'string' || !v.description.trim()) {
      throw new ConfigError(`SUBAGENTS.${name}.description is required (when to call it)`)
    }
    for (const key of ['model', 'systemPrompt'] as const) {
      if (v[key] !== undefined && (typeof v[key] !== 'string' || !(v[key] as string).trim())) {
        throw new ConfigError(`SUBAGENTS.${name}.${key} must be a non-empty string`)
      }
    }
    const tools = v.tools
    if (
      tools !== undefined &&
      !(Array.isArray(tools) && tools.every((t) => typeof t === 'string' && t.length > 0))
    ) {
      throw new ConfigError(`SUBAGENTS.${name}.tools must be an array of tool names`)
    }
    const iterations = v.maxIterations
    if (
      iterations !== undefined &&
      !(
        typeof iterations === 'number' &&
        Number.isInteger(iterations) &&
        iterations >= 1 &&
        iterations <= 100
      )
    ) {
      throw new ConfigError(`SUBAGENTS.${name}.maxIterations must be a whole number from 1 to 100`)
    }
    if (v.readOnly !== undefined && typeof v.readOnly !== 'boolean') {
      throw new ConfigError(`SUBAGENTS.${name}.readOnly must be true or false`)
    }
    out[name] = {
      description: v.description,
      ...(typeof v.model === 'string' ? { model: v.model } : {}),
      ...(typeof v.systemPrompt === 'string' ? { systemPrompt: v.systemPrompt } : {}),
      ...(tools ? { tools: tools as string[] } : {}),
      ...(iterations !== undefined ? { maxIterations: iterations as number } : {}),
      ...(v.readOnly !== undefined ? { readOnly: v.readOnly as boolean } : {}),
    }
  }
  checkSubagentProfiles(out, base)
  return out
}

const PIPELINE_KEYS = new Set(['description', 'definition', 'readOnly'])

export const pipelinesFromEnv = (
  env: Env,
  base: Pick<IAgentConfig, 'tools' | 'mcpServers'>,
  subagents: Iterable<string> = [],
): Record<string, IPipelineConfig> => {
  const raw = json(env, 'PIPELINES')
  if (raw === undefined) {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      'PIPELINES must be a JSON object of name -> { description, definition, readOnly? }',
    )
  }
  const out: Record<string, IPipelineConfig> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as Record<string, unknown>
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new ConfigError(`PIPELINES.${name} must be an object`)
    }
    const unknown = Object.keys(v).filter((k) => !PIPELINE_KEYS.has(k))
    if (unknown.length) {
      throw new ConfigError(`PIPELINES.${name}: unknown field(s) ${unknown.join(', ')}`)
    }
    if (typeof v.description !== 'string' || !v.description.trim()) {
      throw new ConfigError(`PIPELINES.${name}.description is required (when to call it)`)
    }
    if (!v.definition || typeof v.definition !== 'object' || Array.isArray(v.definition)) {
      throw new ConfigError(
        `PIPELINES.${name}.definition must be a pipeline definition (an object)`,
      )
    }
    if (v.readOnly !== undefined && typeof v.readOnly !== 'boolean') {
      throw new ConfigError(`PIPELINES.${name}.readOnly must be true or false`)
    }
    out[name] = {
      description: v.description,
      definition: v.definition as IPipelineConfig['definition'],
      ...(v.readOnly !== undefined ? { readOnly: v.readOnly as boolean } : {}),
    }
  }
  checkPipelines(out, base, subagents)
  return out
}

const providerOptions = (env: Env): Record<string, unknown> | undefined => {
  const raw = json(env, 'AGENT_PROVIDER_OPTIONS')
  if (raw === undefined) {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('AGENT_PROVIDER_OPTIONS must be a JSON object')
  }
  return raw as Record<string, unknown>
}

// The worker's agent: its config (models as objects), how to build another model id on the same
// provider, its subagents and pipelines (each pipeline's definition validated and normalised).
export interface IAgentSetup {
  config: IAgentConfig
  modelOf: ModelOf
  subagents: Record<string, ISubagentProfile>
  pipelines: Record<string, IPipelineConfig>
}

export const agentSetupFromEnv = (env: Env, extra: Partial<IAgentConfig> = {}): IAgentSetup => {
  const providerType = oneOf(env, 'AGENT_PROVIDER_TYPE', PROVIDERS, 'openai')
  const baseURL = str(env, 'AGENT_BASE_URL')
  if (!baseURL && providerType === 'openai-compatible') {
    throw new ConfigError(`AGENT_BASE_URL is required for AGENT_PROVIDER_TYPE=${providerType}`)
  }
  const apiKey = str(env, 'AGENT_API_KEY')
  if (!apiKey) {
    throw new ConfigError('AGENT_API_KEY is required (a Worker secret; .dev.vars locally)')
  }
  const clientName = str(env, 'AGENT_CLIENT_NAME') ?? 'swarm'
  const options = providerOptions(env)
  const modelOf = modelFactory({
    providerType,
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(options ? { options } : {}),
    clientName,
  })
  const mode = oneOf(env, 'AGENT_TOOL_APPROVAL', APPROVAL_MODES, 'autopilot')
  const rules = toolRules(env)
  const planner = str(env, 'AGENT_PLANNER_MODEL')
  const synthesizer = str(env, 'AGENT_SYNTHESIZER_MODEL')
  const contextWindowTokens = optionalInt(env, 'AGENT_CONTEXT_WINDOW_TOKENS', { min: 1024 })
  const compaction = bool(env, 'AGENT_COMPACTION', true)
  const systemPrompt = str(env, 'AGENT_SYSTEM_PROMPT')
  const maxRevisions = optionalInt(env, 'AGENT_MAX_REVISIONS')
  const maxToolCalls = optionalInt(env, 'AGENT_MAX_TOOL_CALLS', { min: 1 })
  const maxTotalTokens = optionalInt(env, 'AGENT_MAX_TOTAL_TOKENS', { min: 1 })
  const llmTimeoutMs = optionalInt(env, 'AGENT_LLM_TIMEOUT_MS', { min: 1 })
  const llmMaxRetries = optionalInt(env, 'AGENT_LLM_MAX_RETRIES', { max: 20 })
  const config: IAgentConfig = {
    clientName,
    model: modelOf(required(env, 'AGENT_MODEL')),
    ...(planner ? { planner: modelOf(planner) } : {}),
    ...(synthesizer ? { synthesizer: modelOf(synthesizer) } : {}),
    mcpServers: mcpServers(env),
    maxIterations: int(env, 'AGENT_MAX_ITERATIONS', 10, { min: 1 }),
    maxStepsPerTask: int(env, 'AGENT_MAX_STEPS_PER_TASK', 8, { min: 1 }),
    ...(maxRevisions !== undefined ? { maxRevisions } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
    ...(llmTimeoutMs !== undefined ? { llmTimeoutMs } : {}),
    ...(llmMaxRetries !== undefined ? { llmMaxRetries } : {}),
    toolApproval: { mode, ...(rules ? { rules } : {}) },
    compaction: {
      auto: compaction,
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
    },
    ...(systemPrompt ? { systemPrompt } : {}),
    logLevel: oneOf(env, 'AGENT_LOG_LEVEL', LOG_LEVELS, 'warn'),
    ...extra,
  }
  const subagents = subagentProfilesFromEnv(env, config)
  const pipelines = pipelinesFromEnv(env, config, Object.keys(subagents))
  for (const [name, p] of Object.entries(pipelines)) {
    p.definition = preparedDefinition(name, p.definition)
  }
  return { config, modelOf, subagents, pipelines }
}
