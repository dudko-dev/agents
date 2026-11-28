import type { LanguageModel } from 'ai'
import type { AgentModel, IAgentConfig, IAgentStageOverride, ProviderType } from './types.ts'

// Concrete, fully-resolved per-stage model parameters. Built by resolveStage
// from the top-level config + an optional override block.
export interface IResolvedStage {
  providerType: ProviderType
  baseURL?: string
  // Unset: the provider's SDK reads its own environment variable.
  apiKey?: string
  model: string
  // Provider-specific extras spread into the SDK factory after baseURL /
  // apiKey. Optional in the shape so direct callers (notably the unit
  // tests) can construct stages without a placeholder; buildModelFromStage
  // normalises a missing value to `{}` before use.
  providerOptions?: Record<string, unknown>
}

// An AI SDK model object of any kind (language, image, speech, transcription): V2 and later all
// carry `specificationVersion`. A stage block, a resolved stage and a model id never do.
export const isModelObject = (value: unknown): value is { readonly specificationVersion: string } =>
  typeof value === 'object' && value !== null && 'specificationVersion' in value

// A stage resolved: the model object it runs on as it is, or the stage to build from ids.
export type StageModel = AgentModel | IResolvedStage

// What a stage is called in events and telemetry: its model id.
export const stageModelId = (stage: StageModel): string =>
  isModelObject(stage) ? stage.modelId : stage.model

const PROVIDER_FIELDS = ['providerType', 'baseURL', 'apiKey', 'providerOptions'] as const

// Resolve one stage (executor / planner / synthesizer / a tier) to the model it runs on: a model
// object given for the stage; the top-level model object when the stage names nothing of its own
// (no block, or a block with no model id and no provider field); otherwise the provider stage
// built from ids by resolveStage, with all its rules.
export const resolveStageModel = (
  config: IAgentConfig,
  input: IAgentStageOverride | AgentModel | undefined,
  legacyModel: string | undefined,
  stageName: string,
): StageModel => {
  if (isModelObject(input)) {
    return input
  }
  if (
    isModelObject(config.model) &&
    input?.model === undefined &&
    legacyModel === undefined &&
    PROVIDER_FIELDS.every((field) => input?.[field] === undefined)
  ) {
    return config.model
  }
  return resolveStage(config, input, legacyModel, stageName)
}

// Resolve a single stage (executor / planner / synthesizer) by layering an
// optional override on top of the IAgentConfig defaults, then validating
// the result.
//
// Validation: a cross-provider override (e.g. planner on Anthropic while the
// default is OpenAI) MUST come with its own apiKey. Inheriting keys across
// vendors is almost always a misconfig - the SDK would either succeed against
// the wrong endpoint with the wrong format, or fail far away from the source
// of confusion. A top level with no providerType (its model is an object) has a key of no named
// provider: a stage that names one must bring its own too, unless there is no key to inherit.
// A model id needs a providerType: the stage's own or the top level's.
export const resolveStage = (
  config: IAgentConfig,
  override: IAgentStageOverride | undefined,
  // Legacy single-string shortcuts for the model only (config.plannerModel /
  // config.synthesizerModel). The override block, if present, wins.
  legacyModel: string | undefined,
  // 'executor' | 'planner' | 'synthesizer' | 'executorTiers.<tier>' - names the config block in errors.
  stageName: string,
): IResolvedStage => {
  const providerType = override?.providerType ?? config.providerType
  const apiKey = override?.apiKey ?? config.apiKey
  const baseURL = override?.baseURL ?? config.baseURL
  const model = override?.model ?? legacyModel ?? config.model
  // providerOptions inherits the same way as the other fields. We do NOT
  // shallow-merge stage on top of top-level: a stage that opts in declares
  // its full provider-specific configuration, which mirrors how baseURL /
  // apiKey work above. Callers wanting to extend rather than replace should
  // build the merged object themselves.
  const providerOptions = override?.providerOptions ?? config.providerOptions ?? {}

  if (typeof model !== 'string') {
    // Only a block that names a provider field but no model id, over a top-level model object.
    throw new Error(
      `${stageName}: sets a provider but no model id, and the top-level model is a model object - set ${stageName}.model, or give the stage a model object`,
    )
  }
  if (!providerType) {
    throw new Error(
      `${stageName}: model "${model}" is a model id, so a providerType is needed (set ${stageName}.providerType or the top-level providerType${isModelObject(config.model) ? '; the top-level model is a model object' : ''})`,
    )
  }
  if (
    override?.providerType &&
    override.providerType !== config.providerType &&
    !override.apiKey &&
    (config.providerType || config.apiKey)
  ) {
    throw new Error(
      `${stageName}: providerType "${override.providerType}" differs from the default "${config.providerType ?? 'none'}" - you must also set ${stageName}.apiKey (cross-provider key inheritance is unsafe)`,
    )
  }
  if (REQUIRES_BASE_URL.has(providerType) && !baseURL) {
    throw new Error(
      `${stageName}: provider "${providerType}" requires a baseURL (set ${stageName}.baseURL or the top-level baseURL)`,
    )
  }
  return { providerType, baseURL, apiKey, model, providerOptions }
}

// Providers whose endpoint is not implied by the SDK and must be specified
// explicitly. openai-compatible: any self-hosted OpenAI-spec server.
// azure: per-tenant deployment URL (the SDK can also derive it from
// `resourceName`, but we expose only the single `baseURL` knob).
const REQUIRES_BASE_URL: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'openai-compatible',
  'azure',
])

// Map provider -> npm package name that provides the factory. Used both for
// the dynamic import path and for the "please install X" error message when
// a peerDependency is missing. `gateway` is omitted because createGateway
// ships with the `ai` package itself.
const PROVIDER_PACKAGE: Record<Exclude<ProviderType, 'gateway'>, string> = {
  openai: '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google',
  'openai-compatible': '@ai-sdk/openai-compatible',
  xai: '@ai-sdk/xai',
  azure: '@ai-sdk/azure',
  'amazon-bedrock': '@ai-sdk/amazon-bedrock',
  'google-vertex': '@ai-sdk/google-vertex',
  deepseek: '@ai-sdk/deepseek',
  cloudflare: 'workers-ai-provider',
}

// Wrap a dynamic import with a clear "missing peer" message. The provider
// SDKs are declared as optional peerDependencies, so a typical install only
// pulls the ones the consumer actually uses; reaching here for an
// uninstalled provider is a configuration mistake we surface explicitly.
const loadProvider = async <T>(pkg: string): Promise<T> => {
  try {
    return (await import(pkg)) as T
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `Provider package "${pkg}" is not installed. Add it to your project: npm install ${pkg}`,
      )
    }
    throw err
  }
}

// We deliberately do NOT override `user-agent` here: the AI SDK injects its
// own descriptive UA (`ai-sdk/openai/x.y.z ...`) which providers use for
// analytics and rate-limit policies. clientName is propagated through MCP
// instead.
//
// Each branch builds the SDK factory args in the same order:
//   1. baseURL / apiKey (or provider-specific equivalents)
//   2. ...stage.providerOptions (escape hatch - last write wins, so callers
//      can also override (1) when absolutely needed)
//
// Provider-specific notes:
// - `google` uses Gemini's native API. PREFER THIS for Gemini models: the
//   OpenAI-compatible Gemini endpoint silently drops `responseFormat` (breaks
//   structured outputs) and omits `tool_calls[].index` in stream chunks (breaks
//   the SDK's stream validator).
// - `openai-compatible` is for self-hosted OpenAI-spec servers (vLLM, ollama,
//   etc.) - works with anything that follows the spec strictly.
// - `gateway` routes through the Vercel AI Gateway (createGateway from `ai`).
//   apiKey is the Vercel API key; baseURL is optional and only needed for a
//   self-hosted gateway endpoint.
// - `azure` requires baseURL pointing at the Azure OpenAI deployment URL.
//   Use providerOptions for `apiVersion`, `resourceName`, etc.
// - `amazon-bedrock` accepts apiKey for the Bearer-token auth flow; for AWS
//   SigV4 set `region` / `accessKeyId` / `secretAccessKey` / `sessionToken`
//   via providerOptions or the standard AWS_* env vars.
// - `google-vertex` authenticates via Google ADC and ignores stage.apiKey.
//   Pass `project` / `location` / `googleAuthOptions` via providerOptions
//   or set GOOGLE_VERTEX_PROJECT / GOOGLE_VERTEX_LOCATION /
//   GOOGLE_APPLICATION_CREDENTIALS in the environment.
// - `cloudflare` needs `accountId`: pass it via providerOptions.accountId
//   or CLOUDFLARE_ACCOUNT_ID env var.
//
// A model object (resolveStageModel) is the model already: it is returned as it is, and no
// provider package is imported for it.
export const buildModelFromStage = async (
  clientName: string,
  stage: StageModel,
): Promise<LanguageModel> =>
  isModelObject(stage)
    ? stage
    : buildFromStage(clientName, stage, (provider, modelId) =>
        (provider as (id: string) => LanguageModel)(modelId),
      )

// The media models of a provider (config.media), by the names every AI SDK provider carries
// (ProviderV4: imageModel, speechModel, transcriptionModel).
export type MediaModelKind = 'image' | 'speech' | 'transcription'

const MEDIA_FACTORY: Record<MediaModelKind, string> = {
  image: 'imageModel',
  speech: 'speechModel',
  transcription: 'transcriptionModel',
}

// The same provider factory as buildModelFromStage (same package, key, baseURL, options), asked
// for an image / speech / transcription model instead of a language model. A provider that has
// none of that kind says so here, at createAgent, not at the first call.
export const buildMediaModelFromStage = (
  clientName: string,
  stage: IResolvedStage,
  kind: MediaModelKind,
): Promise<unknown> =>
  buildFromStage(clientName, stage, (provider, modelId) => {
    const factory = (provider as Record<string, unknown>)[MEDIA_FACTORY[kind]]
    if (typeof factory !== 'function') {
      throw new Error(
        `provider "${stage.providerType}" has no ${kind} models (its package exposes no ${MEDIA_FACTORY[kind]}())`,
      )
    }
    return (factory as (id: string) => unknown).call(provider, modelId)
  })

const buildFromStage = async <T>(
  clientName: string,
  stage: IResolvedStage,
  pick: (provider: unknown, modelId: string) => T,
): Promise<T> => {
  // Normalise once so every branch can `...providerOptions` unconditionally.
  const providerOptions: Record<string, unknown> = stage.providerOptions ?? {}
  switch (stage.providerType) {
    case 'openai': {
      const { createOpenAI } = await loadProvider<typeof import('@ai-sdk/openai')>(
        PROVIDER_PACKAGE.openai,
      )
      const provider = createOpenAI({
        baseURL: stage.baseURL || undefined,
        apiKey: stage.apiKey,
        ...providerOptions,
      })
      return pick(provider, stage.model)
    }
    case 'anthropic': {
      const { createAnthropic } = await loadProvider<typeof import('@ai-sdk/anthropic')>(
        PROVIDER_PACKAGE.anthropic,
      )
      const provider = createAnthropic({
        baseURL: stage.baseURL || undefined,
        apiKey: stage.apiKey,
        ...providerOptions,
      })
      return pick(provider, stage.model)
    }
    case 'openai-compatible': {
      if (!stage.baseURL) {
        throw new Error('openai-compatible provider requires baseURL')
      }
      const { createOpenAICompatible } = await loadProvider<
        typeof import('@ai-sdk/openai-compatible')
      >(PROVIDER_PACKAGE['openai-compatible'])
      const provider = createOpenAICompatible({
        name: clientName,
        baseURL: stage.baseURL,
        apiKey: stage.apiKey,
        ...providerOptions,
      })
      return pick(provider, stage.model)
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await loadProvider<typeof import('@ai-sdk/google')>(
        PROVIDER_PACKAGE.google,
      )
      const provider = createGoogleGenerativeAI({
        baseURL: stage.baseURL || undefined,
        apiKey: stage.apiKey,
        ...providerOptions,
      })
      return pick(provider, stage.model)
    }
    case 'xai': {
      const { createXai } = await loadProvider<typeof import('@ai-sdk/xai')>(PROVIDER_PACKAGE.xai)
      const provider = createXai({
        baseURL: stage.baseURL || undefined,
        apiKey: stage.apiKey,
        ...providerOptions,
      })
      return pick(provider, stage.model)
    }
    case 'azure': {
      // Azure has no public default endpoint. resolveStage normally enforces
      // baseURL for this provider, but buildModelFromStage is also exported
      // for direct use (and exercised that way in tests), so re-check here
      // to surface a clean error instead of an opaque SDK failure.
      if (!stage.baseURL) {
        throw new Error('azure provider requires baseURL (Azure OpenAI deployment URL)')
      }
      const { createAzure } = await loadProvider<typeof import('@ai-sdk/azure')>(
        PROVIDER_PACKAGE.azure,
      )
      const provider = createAzure({
        baseURL: stage.baseURL,
        apiKey: stage.apiKey,
        ...providerOptions,
      })
      return pick(provider, stage.model)
    }
    case 'amazon-bedrock': {
      const { createAmazonBedrock } = await loadProvider<typeof import('@ai-sdk/amazon-bedrock')>(
        PROVIDER_PACKAGE['amazon-bedrock'],
      )
      const provider = createAmazonBedrock({
        baseURL: stage.baseURL || undefined,
        apiKey: stage.apiKey,
        ...providerOptions,
      })
      return pick(provider, stage.model)
    }
    case 'google-vertex': {
      const { createVertex } = await loadProvider<typeof import('@ai-sdk/google-vertex')>(
        PROVIDER_PACKAGE['google-vertex'],
      )
      // Vertex does NOT accept an apiKey; we simply omit it. Pass project /
      // location / googleAuthOptions via providerOptions or env vars.
      const provider = createVertex({
        baseURL: stage.baseURL || undefined,
        ...providerOptions,
      })
      return pick(provider, stage.model)
    }
    case 'deepseek': {
      const { createDeepSeek } = await loadProvider<typeof import('@ai-sdk/deepseek')>(
        PROVIDER_PACKAGE.deepseek,
      )
      const provider = createDeepSeek({
        baseURL: stage.baseURL || undefined,
        apiKey: stage.apiKey,
        ...providerOptions,
      })
      return pick(provider, stage.model)
    }
    case 'gateway': {
      // Vercel AI Gateway ships inside the `ai` package itself, so there is
      // no separate peerDependency to install.
      const { createGateway } = await import('ai')
      const provider = createGateway({
        baseURL: stage.baseURL || undefined,
        apiKey: stage.apiKey,
        ...providerOptions,
      })
      return pick(provider, stage.model)
    }
    case 'cloudflare': {
      // Cloudflare Workers AI needs an account ID alongside the API key.
      // Prefer providerOptions.accountId, fall back to the standard
      // CLOUDFLARE_ACCOUNT_ID env var. Inside a Worker runtime users can
      // pass a `binding` (also via providerOptions) instead of accountId -
      // we let it through unchanged so consumers can wire that path.
      const optAccountId =
        typeof providerOptions.accountId === 'string' ? providerOptions.accountId : undefined
      const accountId = optAccountId ?? process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
      const { accountId: _drop, ...rest } = providerOptions
      if (!accountId && !('binding' in rest)) {
        throw new Error(
          'cloudflare provider requires accountId (set providerOptions.accountId, CLOUDFLARE_ACCOUNT_ID, or providerOptions.binding for a Worker runtime)',
        )
      }
      const { createWorkersAI } = await loadProvider<typeof import('workers-ai-provider')>(
        PROVIDER_PACKAGE.cloudflare,
      )
      // The two valid call shapes are { binding } | { accountId, apiKey }
      // (with optional `gateway`). We assemble whichever the caller asked
      // for and let TS verify the union at the call site.
      const opts = (
        'binding' in rest ? rest : { accountId: accountId!, apiKey: stage.apiKey, ...rest }
      ) as Parameters<typeof createWorkersAI>[0]
      const provider = createWorkersAI(opts)
      return pick(provider, stage.model)
    }
  }
}
