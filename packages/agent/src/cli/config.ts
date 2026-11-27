import type {
  IAgentConfig,
  IAgentStageOverride,
  ICompactionConfig,
  IEgressPolicy,
  ILearningConfig,
  IMcpServerConfig,
  ITokenLimits,
  IToolApprovalConfig,
  LogLevel,
  ProviderType,
  ThinkingLevel,
  ThinkingSetting,
  ToolApprovalMode,
  ToolPermission,
} from '../index.ts'
import { DirSkillStore } from '../learning.ts'
import { mcpProtocolMode } from '../mcp-shared.ts'
import { mcpSkillsSettingOf, type McpSkillsSetting } from '../mcp-skills.ts'
import { parseElicitationMode } from './elicit.ts'
import type { ISandboxConfig } from '../sandbox.ts'
import type { ISubagentsConfig } from '../subagent-dynamic-shared.ts'
import type { ISearchConfig } from '../web-search.ts'
import type { IMediaConfig } from '../media.ts'
import { SEARCH_MAX_RESULTS, SEARCH_PROVIDERS } from '../web-search-shared.ts'

const PROVIDERS: readonly ProviderType[] = [
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
const REQUIRES_BASE_URL: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'openai-compatible',
  'azure',
])
const LOG_LEVELS: readonly LogLevel[] = ['none', 'error', 'warn', 'info', 'debug']
const TOOL_STRATEGIES = ['all', 'plan-narrowed', 'search', 'auto'] as const
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]
const APPROVAL_MODES: readonly ToolApprovalMode[] = [
  'autopilot',
  'ask-writes',
  'ask-all',
  'read-only',
]
type ToolStrategy = (typeof TOOL_STRATEGIES)[number]

export const loadConfig = (): IAgentConfig => {
  const providerType = (process.env.AGENT_PROVIDER_TYPE ?? 'openai') as ProviderType
  if (!PROVIDERS.includes(providerType)) {
    throw new Error(`AGENT_PROVIDER_TYPE must be ${PROVIDERS.join(' | ')}, got: ${providerType}`)
  }

  const logLevel = (process.env.AGENT_LOG_LEVEL ?? 'info') as LogLevel
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`AGENT_LOG_LEVEL must be ${LOG_LEVELS.join(' | ')}, got: ${logLevel}`)
  }

  // baseURL is required for providers with no SDK-default endpoint
  // (openai-compatible self-hosts, azure deployments). All others accept
  // an empty/missing value and fall back to the SDK's built-in default.
  const baseURL = REQUIRES_BASE_URL.has(providerType)
    ? required('AGENT_BASE_URL')
    : process.env.AGENT_BASE_URL?.trim() || undefined

  return {
    clientName: process.env.AGENT_CLIENT_NAME ?? 'vercel-mcp-test',
    providerType,
    baseURL,
    apiKey: required('AGENT_API_KEY'),
    model: required('AGENT_MODEL'),
    providerOptions: parseProviderOptions('AGENT_PROVIDER_OPTIONS'),
    // Per-stage overrides: AGENT_PLANNER_* / AGENT_SYNTHESIZER_*. The legacy
    // AGENT_PLANNER_MODEL / AGENT_SYNTHESIZER_MODEL still feed the deprecated
    // top-level model shortcut so existing setups keep working untouched.
    planner: parseStageOverride('AGENT_PLANNER'),
    synthesizer: parseStageOverride('AGENT_SYNTHESIZER'),
    plannerModel: process.env.AGENT_PLANNER_MODEL?.trim() || undefined,
    synthesizerModel: process.env.AGENT_SYNTHESIZER_MODEL?.trim() || undefined,
    ...parseExecutorTiers(),
    mcpServers: parseMcpServers(process.env.MCP_SERVERS),
    availableTools: parseList(process.env.AGENT_AVAILABLE_TOOLS),
    excludedTools: parseList(process.env.AGENT_EXCLUDED_TOOLS),
    maxIterations: parsePositiveInt(process.env.AGENT_MAX_ITERATIONS, 10),
    maxStepsPerTask: parsePositiveInt(process.env.AGENT_MAX_STEPS_PER_TASK, 8),
    maxRevisions: parseOptionalInt(process.env.AGENT_MAX_REVISIONS),
    maxTotalTokens: parseOptionalInt(process.env.AGENT_MAX_TOTAL_TOKENS),
    limits: parseLimits(),
    maxToolCalls: parseOptionalInt(process.env.AGENT_MAX_TOOL_CALLS),
    thinking: parseThinking(process.env.AGENT_THINKING),
    toolApproval: parseApproval(process.env.AGENT_TOOL_APPROVAL, process.env.AGENT_TOOL_RULES),
    // AGENT_MCP_ELICITATION=all also accepts URL mode. The callback itself is the REPL's
    // (run.ts): without it nothing is declared, whatever this says.
    ...(parseElicitationMode(process.env.AGENT_MCP_ELICITATION) === 'all'
      ? { elicitation: { url: true } }
      : {}),
    compaction: parseCompaction(),
    egress: parseEgress(),
    search: parseSearch(),
    sandbox: parseSandbox(),
    media: parseMedia(),
    subagents: parseSubagents(),
    learning: parseLearning(),
    llmTimeoutMs: parseOptionalInt(process.env.AGENT_LLM_TIMEOUT_MS),
    llmMaxRetries: parseOptionalInt(process.env.AGENT_LLM_MAX_RETRIES),
    toolSelectionStrategy: parseToolStrategy(process.env.AGENT_TOOL_SELECTION_STRATEGY),
    logLevel,
  }
}

// AGENT_THINKING: off | provider-default | none | minimal | low | medium |
// high | xhigh | <number> (an exact budget in tokens, level 'medium').
// 'off' disables thinking explicitly (reasoning: 'none'); unset leaves the
// provider default.
export const parseThinking = (raw: string | undefined): ThinkingSetting | undefined => {
  const v = raw?.trim().toLowerCase()
  if (!v) {
    return undefined
  }
  if (v === 'off') {
    return 'none'
  }
  if (THINKING_LEVELS.includes(v as ThinkingLevel)) {
    return v as ThinkingLevel
  }
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) {
    return { level: 'medium', budgetTokens: Math.floor(n) }
  }
  throw new Error(
    `AGENT_THINKING must be off | ${THINKING_LEVELS.join(' | ')} | <budget tokens>, got: ${raw}`,
  )
}

// AGENT_EXECUTOR_LIGHT_MODEL / AGENT_EXECUTOR_STRONG_MODEL name the executor models by tier
// (AGENT_MODEL is the `standard` one); each takes the same _PROVIDER_TYPE / _BASE_URL / _API_KEY /
// _PROVIDER_OPTIONS block as the planner. AGENT_ESCALATION=off keeps a failed step on its tier;
// AGENT_ESCALATION_MAX_PER_STEP / _PER_RUN set the caps. Nothing is returned when no tier model
// is named, so the config is what it always was.
export const parseExecutorTiers = (
  env: NodeJS.ProcessEnv = process.env,
): Pick<IAgentConfig, 'executorTiers' | 'escalation'> => {
  const tiers: NonNullable<IAgentConfig['executorTiers']> = {}
  for (const tier of ['light', 'strong'] as const) {
    const prefix = `AGENT_EXECUTOR_${tier.toUpperCase()}`
    const model = env[`${prefix}_MODEL`]?.trim()
    const block = parseStageOverride(prefix, env)
    if (!model) {
      if (block) {
        throw new Error(`${prefix}_* is set but ${prefix}_MODEL is not - name the ${tier} model`)
      }
      continue
    }
    tiers[tier] = { ...block, model }
  }
  const raw = env.AGENT_ESCALATION?.trim().toLowerCase()
  const off = raw !== undefined && ['off', 'false', '0', 'no'].includes(raw)
  if (raw && !off && !['on', 'true', '1', 'yes'].includes(raw)) {
    throw new Error(`AGENT_ESCALATION must be on | off, got: ${env.AGENT_ESCALATION}`)
  }
  const maxPerStep = parseOptionalInt(env.AGENT_ESCALATION_MAX_PER_STEP)
  const maxPerRun = parseOptionalInt(env.AGENT_ESCALATION_MAX_PER_RUN)
  if (!tiers.light && !tiers.strong) {
    if (raw || maxPerStep !== undefined || maxPerRun !== undefined) {
      throw new Error(
        'AGENT_ESCALATION* is set but no tier model is - set AGENT_EXECUTOR_LIGHT_MODEL or AGENT_EXECUTOR_STRONG_MODEL',
      )
    }
    return {}
  }
  return {
    executorTiers: tiers,
    ...(off
      ? { escalation: false }
      : maxPerStep !== undefined || maxPerRun !== undefined
        ? {
            escalation: {
              ...(maxPerStep !== undefined ? { maxPerStep } : {}),
              ...(maxPerRun !== undefined ? { maxPerRun } : {}),
            },
          }
        : {}),
  }
}

const PER_CALL_STAGES = ['planner', 'executor', 'replanner', 'synthesizer', 'compaction'] as const

// AGENT_PER_CALL_TOKENS: a JSON object of per-stage output caps, e.g.
// {"executor":16000,"synthesizer":0}. A stage left out keeps its default (a share of the context
// window); 0 means no cap at all. Validated eagerly: a typo such as "sythesizer" silently leaving
// the default in force is the failure this prevents.
export const parsePerCallTokens = (
  raw: string | undefined,
): NonNullable<ITokenLimits['perCall']> | undefined => {
  const v = raw?.trim()
  if (!v) {
    return undefined
  }
  const usage = `AGENT_PER_CALL_TOKENS must be a JSON object of ${PER_CALL_STAGES.join(' | ')} to a token count (0 = no cap), e.g. {"executor":16000}`
  let parsed: unknown
  try {
    parsed = JSON.parse(v)
  } catch {
    throw new Error(usage)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(usage)
  }
  const perCall: NonNullable<ITokenLimits['perCall']> = {}
  for (const [stage, tokens] of Object.entries(parsed)) {
    if (!PER_CALL_STAGES.includes(stage as (typeof PER_CALL_STAGES)[number])) {
      throw new Error(
        `AGENT_PER_CALL_TOKENS: unknown stage "${stage}"; use ${PER_CALL_STAGES.join(' | ')}`,
      )
    }
    if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 0) {
      throw new Error(
        `AGENT_PER_CALL_TOKENS["${stage}"] must be a whole number of tokens (0 = no cap), got: ${JSON.stringify(tokens)}`,
      )
    }
    perCall[stage as (typeof PER_CALL_STAGES)[number]] = tokens
  }
  return Object.keys(perCall).length ? perCall : undefined
}

// AGENT_MAX_INPUT_TOKENS / AGENT_MAX_OUTPUT_TOKENS / AGENT_MAX_REASONING_TOKENS, and the per-call
// output caps in AGENT_PER_CALL_TOKENS.
// (AGENT_MAX_TOTAL_TOKENS keeps feeding the legacy top-level maxTotalTokens.)
const parseLimits = (): ITokenLimits | undefined => {
  const limits: ITokenLimits = {}
  const perCall = parsePerCallTokens(process.env.AGENT_PER_CALL_TOKENS)
  if (perCall) {
    limits.perCall = perCall
  }
  const input = parseOptionalInt(process.env.AGENT_MAX_INPUT_TOKENS)
  const output = parseOptionalInt(process.env.AGENT_MAX_OUTPUT_TOKENS)
  const reasoning = parseOptionalInt(process.env.AGENT_MAX_REASONING_TOKENS)
  if (input) {
    limits.maxInputTokens = input
  }
  if (output) {
    limits.maxOutputTokens = output
  }
  if (reasoning) {
    limits.maxReasoningTokens = reasoning
  }
  return Object.keys(limits).length ? limits : undefined
}

const TOOL_PERMISSIONS: readonly ToolPermission[] = ['allow', 'ask', 'deny']

// AGENT_TOOL_RULES: a JSON object mapping tool names (exact, or with '*' globs)
// to allow | ask | deny, e.g. {"github__delete_*":"deny","docs__*":"allow"}. The
// most specific match wins (exact beats the longest glob) and it beats the
// mode, so a rule holds even under autopilot — this is the CLI's counterpart of
// the permissions block in a settings file. Validated eagerly: a typo such as
// "dney" silently leaving a destructive tool open is the failure this prevents.
export const parseToolRules = (
  raw: string | undefined,
): Record<string, ToolPermission> | undefined => {
  const v = raw?.trim()
  if (!v) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(v)
  } catch {
    throw new Error('AGENT_TOOL_RULES must be a JSON object, e.g. {"github__delete_*":"deny"}')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AGENT_TOOL_RULES must be a JSON object, e.g. {"github__delete_*":"deny"}')
  }
  const rules: Record<string, ToolPermission> = {}
  for (const [pattern, permission] of Object.entries(parsed)) {
    if (!pattern.trim()) {
      throw new Error('AGENT_TOOL_RULES: a rule needs a non-empty tool name or pattern')
    }
    if (!TOOL_PERMISSIONS.includes(permission as ToolPermission)) {
      throw new Error(
        `AGENT_TOOL_RULES["${pattern}"] must be ${TOOL_PERMISSIONS.join(' | ')}, got: ${JSON.stringify(permission)}`,
      )
    }
    rules[pattern] = permission as ToolPermission
  }
  return Object.keys(rules).length ? rules : undefined
}

const parseApproval = (
  rawMode: string | undefined,
  rawRules?: string,
): IToolApprovalConfig | undefined => {
  const v = rawMode?.trim()
  if (v && !APPROVAL_MODES.includes(v as ToolApprovalMode)) {
    throw new Error(`AGENT_TOOL_APPROVAL must be ${APPROVAL_MODES.join(' | ')}, got: ${v}`)
  }
  const rules = parseToolRules(rawRules)
  if (!v && !rules) {
    return undefined
  }
  return { ...(v ? { mode: v as ToolApprovalMode } : {}), ...(rules ? { rules } : {}) }
}

// AGENT_SANDBOX=on lets the model run JavaScript it wrote (the run_js tool); off (the default)
// means the tool does not exist. AGENT_SANDBOX_TIMEOUT_MS / AGENT_SANDBOX_MEMORY_MB set the limits
// of one run. Setting them while AGENT_SANDBOX is off is an error, not a silent no-op.
export const parseSandbox = (env: NodeJS.ProcessEnv = process.env): ISandboxConfig | undefined => {
  const raw = env.AGENT_SANDBOX?.trim().toLowerCase()
  const on = raw !== undefined && ['on', 'true', '1', 'yes'].includes(raw)
  if (raw && !on && !['off', 'false', '0', 'no'].includes(raw)) {
    throw new Error(`AGENT_SANDBOX must be on | off, got: ${env.AGENT_SANDBOX}`)
  }
  const timeoutMs = parseOptionalInt(env.AGENT_SANDBOX_TIMEOUT_MS)
  const memoryMb = parseOptionalInt(env.AGENT_SANDBOX_MEMORY_MB)
  if (!on) {
    const stray = [
      timeoutMs !== undefined && 'AGENT_SANDBOX_TIMEOUT_MS',
      memoryMb !== undefined && 'AGENT_SANDBOX_MEMORY_MB',
    ].filter(Boolean)
    if (stray.length) {
      throw new Error(
        `${stray.join(', ')} set but AGENT_SANDBOX is off - set AGENT_SANDBOX=on to use it`,
      )
    }
    return undefined
  }
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(memoryMb !== undefined ? { memoryLimitBytes: memoryMb * 1024 * 1024 } : {}),
  }
}

// AGENT_SUBAGENTS=on lets the model start helper agents itself (the spawn_subagent tool); off
// (the default) means the tool does not exist. AGENT_SUBAGENTS_MAX_DEPTH / _MAX_CHILDREN /
// _MAX_CONCURRENT set its limits. Setting them while AGENT_SUBAGENTS is off is an error, not a
// silent no-op.
export const parseSubagents = (
  env: NodeJS.ProcessEnv = process.env,
): ISubagentsConfig | undefined => {
  const raw = env.AGENT_SUBAGENTS?.trim().toLowerCase()
  const on = raw !== undefined && ['on', 'true', '1', 'yes'].includes(raw)
  if (raw && !on && !['off', 'false', '0', 'no'].includes(raw)) {
    throw new Error(`AGENT_SUBAGENTS must be on | off, got: ${env.AGENT_SUBAGENTS}`)
  }
  const maxDepth = parseOptionalInt(env.AGENT_SUBAGENTS_MAX_DEPTH)
  const maxChildren = parseOptionalInt(env.AGENT_SUBAGENTS_MAX_CHILDREN)
  const maxConcurrent = parseOptionalInt(env.AGENT_SUBAGENTS_MAX_CONCURRENT)
  if (!on) {
    const stray = [
      maxDepth !== undefined && 'AGENT_SUBAGENTS_MAX_DEPTH',
      maxChildren !== undefined && 'AGENT_SUBAGENTS_MAX_CHILDREN',
      maxConcurrent !== undefined && 'AGENT_SUBAGENTS_MAX_CONCURRENT',
    ].filter(Boolean)
    if (stray.length) {
      throw new Error(
        `${stray.join(', ')} set but AGENT_SUBAGENTS is off - set AGENT_SUBAGENTS=on to use it`,
      )
    }
    return undefined
  }
  return {
    dynamic: {
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(maxChildren !== undefined ? { maxChildren } : {}),
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    },
  }
}

// AGENT_EGRESS=on lets the model read the web (the web_fetch tool); off (the default) means no
// outbound requests of its own. The rest narrows it: AGENT_EGRESS_ALLOW / AGENT_EGRESS_DENY
// (comma lists: "docs.example.com", "*.example.com", an IP or a CIDR), AGENT_EGRESS_PROTOCOLS
// (https | http), AGENT_EGRESS_ALLOW_PRIVATE=on (reach private networks - cloud metadata stays
// refused). Setting any of them while AGENT_EGRESS is off is an error, not a silent no-op.
export const parseEgress = (env: NodeJS.ProcessEnv = process.env): IEgressPolicy | undefined => {
  const raw = env.AGENT_EGRESS?.trim().toLowerCase()
  const on = raw !== undefined && ['on', 'true', '1', 'yes'].includes(raw)
  if (raw && !on && !['off', 'false', '0', 'no'].includes(raw)) {
    throw new Error(`AGENT_EGRESS must be on | off, got: ${env.AGENT_EGRESS}`)
  }
  const allow = parseList(env.AGENT_EGRESS_ALLOW)
  const deny = parseList(env.AGENT_EGRESS_DENY)
  const protocols = parseList(env.AGENT_EGRESS_PROTOCOLS)
  const priv = env.AGENT_EGRESS_ALLOW_PRIVATE?.trim().toLowerCase()
  if (!on) {
    const stray = [
      allow && 'AGENT_EGRESS_ALLOW',
      deny && 'AGENT_EGRESS_DENY',
      protocols && 'AGENT_EGRESS_PROTOCOLS',
      priv && 'AGENT_EGRESS_ALLOW_PRIVATE',
    ].filter(Boolean)
    if (stray.length) {
      throw new Error(
        `${stray.join(', ')} set but AGENT_EGRESS is off - set AGENT_EGRESS=on to use it`,
      )
    }
    return undefined
  }
  for (const p of protocols ?? []) {
    if (p !== 'https' && p !== 'http') {
      throw new Error(`AGENT_EGRESS_PROTOCOLS must list https and/or http, got: ${p}`)
    }
  }
  if (priv && !['on', 'true', '1', 'yes', 'off', 'false', '0', 'no'].includes(priv)) {
    throw new Error(
      `AGENT_EGRESS_ALLOW_PRIVATE must be on | off, got: ${env.AGENT_EGRESS_ALLOW_PRIVATE}`,
    )
  }
  return {
    ...(allow ? { allow } : {}),
    ...(deny ? { deny } : {}),
    ...(protocols ? { protocols: protocols as ('https' | 'http')[] } : {}),
    ...(priv && ['on', 'true', '1', 'yes'].includes(priv) ? { allowPrivateNetwork: true } : {}),
  }
}

// AGENT_SEARCH=google lets the model search the web (the web_search tool) with Google Search
// through Gemini grounding; off (the default) means no tool. It is the one provider the CLI
// offers: any other search API is a function (`search.engine`), which an environment cannot carry.
// AGENT_SEARCH_API_KEY is the Gemini API key - when it is not set and the agent itself runs on
// Gemini (AGENT_PROVIDER_TYPE=google), AGENT_API_KEY is used: one key for both.
// AGENT_SEARCH_MODEL is the model that makes the grounding call, AGENT_SEARCH_BASE_URL a gateway
// in place of the public endpoint, AGENT_SEARCH_MAX_RESULTS the results per call,
// AGENT_SEARCH_ALLOW_PRIVATE=on lets that gateway be on a private address. Setting any of them
// while AGENT_SEARCH is off is an error.
export const parseSearch = (env: NodeJS.ProcessEnv = process.env): ISearchConfig | undefined => {
  const raw = env.AGENT_SEARCH?.trim().toLowerCase()
  const on = Boolean(raw) && !['off', 'false', '0', 'no'].includes(raw as string)
  const ownKey = env.AGENT_SEARCH_API_KEY?.trim()
  const model = env.AGENT_SEARCH_MODEL?.trim()
  const baseURL = env.AGENT_SEARCH_BASE_URL?.trim()
  const max = env.AGENT_SEARCH_MAX_RESULTS?.trim()
  const priv = env.AGENT_SEARCH_ALLOW_PRIVATE?.trim().toLowerCase()
  if (!on) {
    const stray = [
      ownKey && 'AGENT_SEARCH_API_KEY',
      model && 'AGENT_SEARCH_MODEL',
      baseURL && 'AGENT_SEARCH_BASE_URL',
      max && 'AGENT_SEARCH_MAX_RESULTS',
      priv && 'AGENT_SEARCH_ALLOW_PRIVATE',
    ].filter(Boolean)
    if (stray.length) {
      throw new Error(
        `${stray.join(', ')} set but AGENT_SEARCH is off - set AGENT_SEARCH=<provider> to use it`,
      )
    }
    return undefined
  }
  const provider = SEARCH_PROVIDERS.find((p) => p === raw)
  if (!provider) {
    throw new Error(
      `AGENT_SEARCH must be ${SEARCH_PROVIDERS.join(' | ')} | off, got: ${env.AGENT_SEARCH}`,
    )
  }
  const sharedKey =
    env.AGENT_PROVIDER_TYPE?.trim() === 'google' ? env.AGENT_API_KEY?.trim() : undefined
  const apiKey = ownKey || (baseURL ? undefined : sharedKey)
  if (!apiKey && !baseURL) {
    throw new Error(
      `AGENT_SEARCH=${provider} needs AGENT_SEARCH_API_KEY (a Gemini API key; AGENT_API_KEY is used when AGENT_PROVIDER_TYPE=google)`,
    )
  }
  const maxResults = max ? Number(max) : undefined
  if (
    maxResults !== undefined &&
    !(Number.isInteger(maxResults) && maxResults >= 1 && maxResults <= SEARCH_MAX_RESULTS)
  ) {
    throw new Error(`AGENT_SEARCH_MAX_RESULTS must be 1..${SEARCH_MAX_RESULTS}, got: ${max}`)
  }
  if (priv && !['on', 'true', '1', 'yes', 'off', 'false', '0', 'no'].includes(priv)) {
    throw new Error(
      `AGENT_SEARCH_ALLOW_PRIVATE must be on | off, got: ${env.AGENT_SEARCH_ALLOW_PRIVATE}`,
    )
  }
  return {
    provider,
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(maxResults ? { maxResults } : {}),
    ...(priv && ['on', 'true', '1', 'yes'].includes(priv) ? { allowPrivateNetwork: true } : {}),
  }
}

// AGENT_IMAGE_MODEL / AGENT_SPEECH_MODEL / AGENT_TRANSCRIPTION_MODEL: a model id each; each one
// mounts its tool (generate_image / generate_speech / transcribe_audio; the last also lets
// /audio attach a file). They run on the main provider unless AGENT_MEDIA_PROVIDER_TYPE /
// AGENT_MEDIA_API_KEY / AGENT_MEDIA_BASE_URL / AGENT_MEDIA_PROVIDER_OPTIONS name another (one
// block for the three). AGENT_MEDIA_DIR is where generated files are kept (default
// ./agent-media), AGENT_MEDIA_MAX_CALLS the media calls one run may make, AGENT_SPEECH_VOICE the
// default voice. Setting any of those without a model is an error, not a silent no-op.
export const MEDIA_DEFAULT_DIR = './agent-media'
export const parseMedia = (env: NodeJS.ProcessEnv = process.env): IMediaConfig | undefined => {
  const image = env.AGENT_IMAGE_MODEL?.trim()
  const speech = env.AGENT_SPEECH_MODEL?.trim()
  const transcription = env.AGENT_TRANSCRIPTION_MODEL?.trim()
  const block = parseStageOverride('AGENT_MEDIA', env)
  const dir = env.AGENT_MEDIA_DIR?.trim()
  const maxRaw = env.AGENT_MEDIA_MAX_CALLS?.trim()
  const voice = env.AGENT_SPEECH_VOICE?.trim()
  if (!image && !speech && !transcription) {
    const stray = [
      block && 'AGENT_MEDIA_PROVIDER_TYPE / _BASE_URL / _API_KEY / _PROVIDER_OPTIONS',
      dir && 'AGENT_MEDIA_DIR',
      maxRaw && 'AGENT_MEDIA_MAX_CALLS',
      voice && 'AGENT_SPEECH_VOICE',
    ].filter(Boolean)
    if (stray.length) {
      throw new Error(
        `${stray.join(', ')} set but no media model is - set AGENT_IMAGE_MODEL, AGENT_SPEECH_MODEL or AGENT_TRANSCRIPTION_MODEL`,
      )
    }
    return undefined
  }
  if (voice && !speech) {
    throw new Error('AGENT_SPEECH_VOICE set but AGENT_SPEECH_MODEL is not')
  }
  const maxCalls = maxRaw ? Number(maxRaw) : undefined
  if (maxCalls !== undefined && !(Number.isInteger(maxCalls) && maxCalls >= 0)) {
    throw new Error(`AGENT_MEDIA_MAX_CALLS must be a whole number (0 = no cap), got: ${maxRaw}`)
  }
  const spec = (model: string) => ({ ...block, model })
  return {
    ...(image ? { imageModel: spec(image) } : {}),
    ...(speech ? { speechModel: spec(speech) } : {}),
    ...(transcription ? { transcriptionModel: spec(transcription) } : {}),
    dir: dir || MEDIA_DEFAULT_DIR,
    ...(maxCalls !== undefined ? { maxCalls } : {}),
    ...(voice ? { voice } : {}),
  }
}

// AGENT_LEARNING=on lets the agent write down what it learned (lessons become skills for the rest
// of the session - the REPL process). AGENT_LEARNING_DIR=<dir> keeps them as <dir>/<name>/SKILL.md
// across sessions. A dir without the switch is an error, not a silent no-op.
export const parseLearning = (
  env: NodeJS.ProcessEnv = process.env,
): ILearningConfig | undefined => {
  const raw = env.AGENT_LEARNING?.trim().toLowerCase()
  const on = raw !== undefined && ['on', 'true', '1', 'yes'].includes(raw)
  if (raw && !on && !['off', 'false', '0', 'no'].includes(raw)) {
    throw new Error(`AGENT_LEARNING must be on | off, got: ${env.AGENT_LEARNING}`)
  }
  const dir = env.AGENT_LEARNING_DIR?.trim()
  if (!on) {
    if (dir) {
      throw new Error(
        'AGENT_LEARNING_DIR set but AGENT_LEARNING is off - set AGENT_LEARNING=on to use it',
      )
    }
    return undefined
  }
  return dir ? { store: new DirSkillStore(dir) } : {}
}

// AGENT_COMPACTION=off disables automatic compaction (the /compact command
// still works); AGENT_CONTEXT_WINDOW_TOKENS sets the window the default
// threshold (50%) is derived from.
const parseCompaction = (): ICompactionConfig | undefined => {
  const raw = process.env.AGENT_COMPACTION?.trim().toLowerCase()
  const window = parseOptionalInt(process.env.AGENT_CONTEXT_WINDOW_TOKENS)
  const cfg: ICompactionConfig = {}
  if (raw) {
    if (['off', 'false', '0', 'no'].includes(raw)) {
      cfg.auto = false
    } else if (['on', 'auto', 'true', '1', 'yes'].includes(raw)) {
      cfg.auto = true
    } else {
      throw new Error(`AGENT_COMPACTION must be on | off, got: ${process.env.AGENT_COMPACTION}`)
    }
  }
  if (window) {
    cfg.contextWindowTokens = window
  }
  // AGENT_COMPACTION_THRESHOLD: the share of the window at which auto-compaction starts, as a
  // percent (85 or 85%). Default 80.
  const pct = process.env.AGENT_COMPACTION_THRESHOLD?.trim().replace(/%$/, '')
  if (pct) {
    const n = Number(pct)
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      throw new Error(
        `AGENT_COMPACTION_THRESHOLD must be a percent of the window, 1 to 100, got: ${process.env.AGENT_COMPACTION_THRESHOLD}`,
      )
    }
    cfg.thresholdRatio = n / 100
  }
  return Object.keys(cfg).length ? cfg : undefined
}

// AGENT_SKILLS_DIR: a folder of <skill>/SKILL.md (loaded by the REPL, which
// is async; loadConfig stays sync).
export const skillsDirFromEnv = (): string | undefined =>
  process.env.AGENT_SKILLS_DIR?.trim() || undefined

// Read AGENT_<prefix>_PROVIDER_TYPE / _BASE_URL / _API_KEY / _MODEL into a
// stage override block. Returns undefined if no field is set so the agent
// inherits everything from the top-level defaults.
const parseStageOverride = (
  prefix: string,
  env: NodeJS.ProcessEnv = process.env,
): IAgentStageOverride | undefined => {
  const provider = env[`${prefix}_PROVIDER_TYPE`]?.trim()
  const baseURL = env[`${prefix}_BASE_URL`]?.trim()
  const apiKey = env[`${prefix}_API_KEY`]?.trim()
  const providerOptions = parseProviderOptions(`${prefix}_PROVIDER_OPTIONS`, env)
  // Stage block mirrors planner/synthesizer.model. The deprecated single-
  // string AGENT_PLANNER_MODEL / AGENT_SYNTHESIZER_MODEL still flows through
  // the legacy plannerModel/synthesizerModel slot - we ignore it here so the
  // override block can stay independently undefined.
  if (!provider && !baseURL && !apiKey && !providerOptions) {
    return undefined
  }
  if (provider && !PROVIDERS.includes(provider as ProviderType)) {
    throw new Error(`${prefix}_PROVIDER_TYPE must be ${PROVIDERS.join(' | ')}, got: ${provider}`)
  }
  return {
    providerType: (provider as ProviderType) || undefined,
    baseURL: baseURL || undefined,
    apiKey: apiKey || undefined,
    providerOptions,
  }
}

// Parse a provider-options JSON env block (e.g. AGENT_PROVIDER_OPTIONS,
// AGENT_PLANNER_PROVIDER_OPTIONS). Empty / unset returns undefined so the
// agent's config-level inheritance kicks in.
const parseProviderOptions = (
  varName: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined => {
  const raw = env[varName]?.trim()
  if (!raw) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${varName} must be valid JSON: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${varName} must be a JSON object (got ${typeof parsed})`)
  }
  return parsed as Record<string, unknown>
}

const parseToolStrategy = (raw: string | undefined): ToolStrategy | undefined => {
  const v = raw?.trim()
  if (!v) {
    return undefined
  }
  if (!TOOL_STRATEGIES.includes(v as ToolStrategy)) {
    throw new Error(
      `AGENT_TOOL_SELECTION_STRATEGY must be ${TOOL_STRATEGIES.join(' | ')}, got: ${v}`,
    )
  }
  return v as ToolStrategy
}

const parseOptionalInt = (raw: string | undefined): number | undefined => {
  if (!raw?.trim()) {
    return undefined
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Expected non-negative number, got: ${raw}`)
  }
  return Math.floor(n)
}

const required = (name: string): string => {
  const v = process.env[name]?.trim()
  if (!v) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

const parseList = (raw: string | undefined): string[] | undefined => {
  const t = raw?.trim()
  if (!t) {
    return undefined
  }
  return t
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (!raw?.trim()) {
    return fallback
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Expected positive number, got: ${raw}`)
  }
  return Math.floor(n)
}

const parseMcpServers = (raw: string | undefined): Record<string, IMcpServerConfig> => {
  if (!raw?.trim()) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`MCP_SERVERS must be valid JSON: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'MCP_SERVERS must be a JSON object: Record<name, { url, headers?, protocol?, skills?, connectTimeoutMs? } | { command, args?, env?, cwd?, protocol?, skills?, connectTimeoutMs? }>',
    )
  }
  const result: Record<string, IMcpServerConfig> = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      throw new Error(`MCP_SERVERS.${name} must be an object`)
    }
    const v = value as {
      url?: unknown
      headers?: unknown
      command?: unknown
      args?: unknown
      env?: unknown
      cwd?: unknown
      protocol?: unknown
      skills?: unknown
      connectTimeoutMs?: unknown
    }
    // 'legacy' (default) | 'auto' | 'modern': anything else is refused here,
    // by name, instead of at connect.
    const protocol =
      v.protocol === undefined ? undefined : mcpProtocolMode(v.protocol, `MCP_SERVERS.${name}`)
    // The Skills extension (experimental): true, false or { consent }, checked by the core's own
    // rule. It is written against 2026-07-28, so it needs a protocol that may speak it: the core
    // would only warn and request nothing, which in an env var reads as "on" and is silently off.
    const skillsOn = mcpSkillsSettingOf(v.skills, `MCP_SERVERS.${name}`).on
    if (skillsOn && protocol !== 'auto' && protocol !== 'modern') {
      throw new Error(
        `MCP_SERVERS.${name}: "skills" needs "protocol": "auto" or "modern" (the Skills extension is written against 2026-07-28)`,
      )
    }
    if (
      v.connectTimeoutMs !== undefined &&
      (typeof v.connectTimeoutMs !== 'number' ||
        !Number.isInteger(v.connectTimeoutMs) ||
        v.connectTimeoutMs < 0)
    ) {
      throw new Error(
        `MCP_SERVERS.${name}.connectTimeoutMs must be a non-negative integer (ms; 0 = no bound)`,
      )
    }
    const shared = {
      ...(protocol ? { protocol } : {}),
      ...(v.skills !== undefined ? { skills: v.skills as McpSkillsSetting } : {}),
      ...(v.connectTimeoutMs !== undefined ? { connectTimeoutMs: v.connectTimeoutMs } : {}),
    }
    const hasUrl = typeof v.url === 'string' && v.url.length > 0
    const hasCommand = typeof v.command === 'string' && v.command.length > 0
    if (hasUrl && hasCommand) {
      throw new Error(
        `MCP_SERVERS.${name}: specify either "url" (HTTP) or "command" (stdio), not both`,
      )
    }
    if (!hasUrl && !hasCommand) {
      throw new Error(`MCP_SERVERS.${name}: must specify "url" (HTTP) or "command" (stdio)`)
    }
    if (hasUrl) {
      const headers =
        v.headers && typeof v.headers === 'object' && !Array.isArray(v.headers)
          ? (v.headers as Record<string, string>)
          : undefined
      result[name] = { url: v.url as string, headers, ...shared }
      continue
    }
    // stdio path
    if (v.args !== undefined && !Array.isArray(v.args)) {
      throw new Error(`MCP_SERVERS.${name}.args must be a string array`)
    }
    if (v.env !== undefined && (!v.env || typeof v.env !== 'object' || Array.isArray(v.env))) {
      throw new Error(`MCP_SERVERS.${name}.env must be a string-to-string map`)
    }
    if (v.cwd !== undefined && typeof v.cwd !== 'string') {
      throw new Error(`MCP_SERVERS.${name}.cwd must be a string`)
    }
    result[name] = {
      command: v.command as string,
      args: v.args as string[] | undefined,
      env: v.env as Record<string, string> | undefined,
      cwd: v.cwd as string | undefined,
      ...shared,
    }
  }
  return result
}
