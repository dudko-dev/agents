// The agent's config from the environment: a SUBSET of the `dd-agent` CLI's variables, under the
// same names (the CLI's loader is not part of the package's API). Anything beyond it: build the
// IAgentConfig in code (worker.ts takes one).
import type {
  IAgentConfig,
  IMcpServerConfig,
  LogLevel,
  ProviderType,
  ToolApprovalMode,
  ToolPermission,
} from '@dudko.dev/agent'
import {
  ConfigError,
  bool,
  int,
  json,
  oneOf,
  optionalInt,
  required,
  secret,
  str,
  type Env,
} from './env.ts'
import { checkPipelines, type IPipelineConfig } from './pipelines.ts'
import { checkSubagentProfiles, type ISubagentProfile } from './subagents.ts'

export const PROVIDERS: readonly ProviderType[] = [
  'openai',
  'anthropic',
  'openai-compatible',
  'google',
  'xai',
  'azure',
  'amazon-bedrock',
  'google-vertex',
  'deepseek',
  'gateway',
  'cloudflare',
]

// The providers whose SDK package this image installs (package.json). Another one: add its
// @ai-sdk/* package to the dependencies and rebuild.
export const INSTALLED_PROVIDERS: readonly ProviderType[] = [
  'openai',
  'anthropic',
  'openai-compatible',
  'google',
]

const APPROVAL_MODES: readonly ToolApprovalMode[] = [
  'autopilot',
  'ask-writes',
  'ask-all',
  'read-only',
]
const PERMISSIONS: readonly ToolPermission[] = ['allow', 'ask', 'deny']
const LOG_LEVELS: readonly LogLevel[] = ['none', 'error', 'warn', 'info', 'debug']

// MCP_SERVERS: {"name": {"url": "https://...", "headers": {...}}} or {"name": {"command": ...}}.
const mcpServers = (env: Env): Record<string, IMcpServerConfig> => {
  const raw = json(env, 'MCP_SERVERS')
  if (raw === undefined) {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      'MCP_SERVERS must be a JSON object of name -> { url, headers? } | { command, args?, env? }',
    )
  }
  const out: Record<string, IMcpServerConfig> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = (value ?? {}) as Record<string, unknown>
    if (typeof v.url === 'string') {
      const headers = v.headers as Record<string, string> | undefined
      if (headers !== undefined && (typeof headers !== 'object' || Array.isArray(headers))) {
        throw new ConfigError(`MCP_SERVERS.${name}.headers must be an object of strings`)
      }
      out[name] = { url: v.url, ...(headers ? { headers } : {}) }
    } else if (typeof v.command === 'string') {
      const args = v.args as string[] | undefined
      if (
        args !== undefined &&
        !(Array.isArray(args) && args.every((a) => typeof a === 'string'))
      ) {
        throw new ConfigError(`MCP_SERVERS.${name}.args must be an array of strings`)
      }
      const childEnv = v.env as Record<string, string> | undefined
      out[name] = {
        command: v.command,
        ...(args ? { args } : {}),
        ...(childEnv ? { env: childEnv } : {}),
      }
    } else {
      throw new ConfigError(`MCP_SERVERS.${name} needs a "url" (HTTP) or a "command" (stdio)`)
    }
  }
  return out
}

// AGENT_TOOL_RULES: {"github__delete_*": "deny", "docs__*": "allow"}.
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

// SUBAGENTS: {"researcher": {"description": "...", "model"?: "...", "systemPrompt"?: "...",
// "tools"?: ["docs__search"], "maxIterations"?: 4, "readOnly"?: true}}. Each one is a tool of the
// session's agent; a call runs as a child workflow on the profile (see src/subagents.ts). The
// tools must be the worker's own (MCP_SERVERS).
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
  mcp: Record<string, IMcpServerConfig>,
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
  checkSubagentProfiles(out, { mcpServers: mcp })
  return out
}

// PIPELINES: {"review": {"description": "...", "definition": <the core's PipelineDefinition>,
// "readOnly"?: true}}. Each one is a tool of the session's agent; a call runs as a child workflow,
// every node visit as a child workflow of its own (src/pipelines.ts, src/workflows.ts). Every
// definition is validated by the core (preparePipeline) and every node checked against the
// worker: its tools and MCP servers the worker's own, no skills, no settings.
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

export const agentConfigFromEnv = (env: Env): IAgentConfig => {
  const providerType = oneOf(env, 'AGENT_PROVIDER_TYPE', PROVIDERS, 'openai')
  if (!INSTALLED_PROVIDERS.includes(providerType)) {
    throw new ConfigError(
      `AGENT_PROVIDER_TYPE=${providerType}: its SDK package is not installed in this example (installed: ${INSTALLED_PROVIDERS.join(', ')})`,
    )
  }
  const baseURL = str(env, 'AGENT_BASE_URL')
  if (!baseURL && (providerType === 'openai-compatible' || providerType === 'azure')) {
    throw new ConfigError(`AGENT_BASE_URL is required for AGENT_PROVIDER_TYPE=${providerType}`)
  }
  const apiKey = secret(env, 'AGENT_API_KEY')
  if (!apiKey) {
    throw new ConfigError('AGENT_API_KEY (or AGENT_API_KEY_FILE) is required')
  }
  // Approval: an 'ask' of the mode or a rule PARKS the turn until a person answers it through the
  // gateway (POST /sessions/:id/answers/:requestId); the worker adds the onRequest (worker.ts).
  const mode = oneOf(env, 'AGENT_TOOL_APPROVAL', APPROVAL_MODES, 'autopilot')
  const rules = toolRules(env)
  const planner = str(env, 'AGENT_PLANNER_MODEL')
  const synthesizer = str(env, 'AGENT_SYNTHESIZER_MODEL')
  const contextWindowTokens = optionalInt(env, 'AGENT_CONTEXT_WINDOW_TOKENS', { min: 1024 })
  const compaction = bool(env, 'AGENT_COMPACTION', true)
  const options = providerOptions(env)
  const systemPrompt = str(env, 'AGENT_SYSTEM_PROMPT')
  const maxRevisions = optionalInt(env, 'AGENT_MAX_REVISIONS')
  const maxToolCalls = optionalInt(env, 'AGENT_MAX_TOOL_CALLS', { min: 1 })
  const maxTotalTokens = optionalInt(env, 'AGENT_MAX_TOTAL_TOKENS', { min: 1 })
  const llmTimeoutMs = optionalInt(env, 'AGENT_LLM_TIMEOUT_MS', { min: 1 })
  const llmMaxRetries = optionalInt(env, 'AGENT_LLM_MAX_RETRIES', { max: 20 })
  return {
    clientName: str(env, 'AGENT_CLIENT_NAME') ?? 'swarm',
    providerType,
    ...(baseURL ? { baseURL } : {}),
    apiKey,
    model: required(env, 'AGENT_MODEL'),
    ...(options ? { providerOptions: options } : {}),
    ...(planner ? { planner: { model: planner } } : {}),
    ...(synthesizer ? { synthesizer: { model: synthesizer } } : {}),
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
  }
}
