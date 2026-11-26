import { useEffect, useMemo, useState } from 'react'
import { useCredentials, useLocalModel } from '@dudko.dev/agent-web-react'
import type { ModelInput } from '@dudko.dev/agent-web'
import type { LanguageModel } from 'ai'
import { buildCloudModel } from './cloud'
import { engineFor } from './local-engines'
import { isLocal, MODELS, type ModelOption } from './models'

// The model a visitor chose, the key it needs and the model object built from the two. One hook
// for every page of the demo (the chat tabs at /demo/, the pipeline editor at /pipeline/): they
// are one origin, so the choice in localStorage and the keys in the IndexedDB vault are shared.

const CUSTOM_MODEL_KEY = 'agent-web-demo:openrouter-model'
const readCustomModelId = (fallback: string): string => {
  try {
    return localStorage.getItem(CUSTOM_MODEL_KEY) ?? fallback
  } catch {
    return fallback
  }
}
const writeCustomModelId = (id: string) => {
  try {
    localStorage.setItem(CUSTOM_MODEL_KEY, id)
  } catch {
    /* private mode */
  }
}

// The chosen model survives a reload (the weights of a local one are in the browser's cache, so
// loading it again is quick - but only if the page still knows which one it was).
const MODEL_KEY = 'agent-web-demo:model'
const readModelId = (): string => {
  try {
    const id = localStorage.getItem(MODEL_KEY)
    if (id && MODELS.some((m) => m.id === id)) return id
  } catch {
    /* private mode */
  }
  return 'google-flash'
}

// What a local runtime says once the GPU has dropped the model. The browser takes the device
// away when memory runs out (a phone does it readily); WebLLM then disposes its objects and
// unloads, and every later request fails with one of these.
export const GPU_LOST = /already been disposed|Model not loaded before|Device (was |is )?lost/i
export const GPU_LOST_NOTICE =
  'The browser took the GPU away - most likely the device ran out of memory - and the model was dropped. Load it again, or pick a smaller model; a shorter chat needs less memory too.'

export const useDemoModel = () => {
  const [modelId, setModelIdState] = useState(readModelId)
  const setModelId = (id: string) => {
    setModelIdState(id)
    try {
      localStorage.setItem(MODEL_KEY, id)
    } catch {
      /* private mode */
    }
  }
  const model = MODELS.find((m) => m.id === modelId) ?? MODELS[0]
  const local = isLocal(model)
  // OpenRouter's "any model": the id the user typed (remembered).
  const [customModelId, setCustomModelIdState] = useState(() =>
    readCustomModelId(MODELS.find((m) => m.customModel)?.model ?? ''),
  )
  const setCustomModelId = (id: string) => {
    setCustomModelIdState(id)
    writeCustomModelId(id)
  }
  const cloudModelId = model.customModel ? customModelId.trim() || model.model : model.model

  const credentials = useCredentials()
  // One hook for every on-device runtime: WebLLM, the browser's built-in model,
  // transformers.js (local-engines.ts). WebLLM models load with their own
  // window, not WebLLM's 4096 default.
  const localModel = useLocalModel(model.model, engineFor(model), {
    contextWindowTokens: model.runtime === 'web-llm' ? model.contextWindow : undefined,
  })

  // Cloud models are built in-app from the vault-stored key and passed to the
  // agent directly (see cloud.ts). Rebuilds when the key or model changes.
  const [cloudModel, setCloudModel] = useState<LanguageModel | undefined>(undefined)
  useEffect(() => {
    if (local || !model.provider) {
      setCloudModel(undefined)
      return
    }
    let active = true
    credentials.store
      .getApiKey(model.credentialRef!)
      .then(async (key) => {
        const built = key ? await buildCloudModel(model.provider!, cloudModelId, key) : undefined
        if (active) setCloudModel(built)
      })
      .catch(() => {
        if (active) setCloudModel(undefined)
      })
    return () => {
      active = false
    }
  }, [local, model, cloudModelId, credentials.store, credentials.version])
  const resolvedModel = local ? localModel.model : cloudModel
  // The window runs must fit: a loaded local model reports its own.
  const modelWindow = local
    ? (localModel.contextWindow ?? model.contextWindow)
    : model.contextWindow

  return {
    modelId,
    setModelId,
    model,
    local,
    customModelId,
    setCustomModelId,
    cloudModelId,
    credentials,
    localModel,
    resolvedModel,
    modelWindow,
  }
}

// ── model tiers ─────────────────────────────────────────────────────────────

/**
 * What can be a light or a strong executor: the cloud models with a fixed id. A local model is
 * left out on purpose - loading a second set of weights next to the chosen one is how a browser
 * tab loses its GPU - and so is OpenRouter's "any model" (its id is typed in the model picker).
 */
export const TIER_MODELS: ModelOption[] = MODELS.filter(
  (m) => m.runtime === 'cloud' && m.provider && !m.customModel,
)

type TierName = 'light' | 'strong'

/**
 * "Auto" tiers for a chosen model: the lightest ranked model of the SAME provider below it and
 * the strongest above it (`rank` in models.ts). The same provider means the same key, so auto
 * tiers never ask for a second one. A local model, OpenRouter's "any model" or a provider with a
 * single model in the list has none - tiers are then off, and the panel says so.
 */
export const autoTiers = (chosen: ModelOption): { light?: ModelOption; strong?: ModelOption } => {
  if (chosen.rank === undefined || !chosen.provider) return {}
  const family = TIER_MODELS.filter(
    (m) => m.provider === chosen.provider && m.rank !== undefined && m.id !== chosen.id,
  ).sort((a, b) => a.rank! - b.rank!)
  const light = family.find((m) => m.rank! < chosen.rank!)
  const strong = family.filter((m) => m.rank! > chosen.rank!).at(-1)
  return { ...(light ? { light } : {}), ...(strong ? { strong } : {}) }
}

/** A tier setting ('auto', '' or a model id) as the id `useDemoTiers` takes. */
export const tierChoice = (setting: string, auto: ModelOption | undefined): string =>
  setting === 'auto' ? (auto?.id ?? '') : setting

export interface DemoTiers {
  /** `config.executorTiers`, or undefined when no tier model could be built (tiers off). */
  executorTiers?: Partial<Record<TierName, ModelInput>>
  /** Changes when the tier models do: a dependency of the agents. */
  key: string
  /** Tiers that are chosen but have no key in the vault yet (they stay off until it is saved). */
  missingKey: { tier: TierName; model: ModelOption }[]
}

/**
 * The light / strong executor models of the "Agent settings" panel, built like the main cloud
 * model: in the app, from the key in the vault (the same key as the model picker's, per provider).
 */
export const useDemoTiers = (
  choice: { light: string; strong: string },
  credentials: ReturnType<typeof useCredentials>,
): DemoTiers => {
  const [built, setBuilt] = useState<{
    models: Partial<Record<TierName, LanguageModel>>
    missing: TierName[]
    key: string
  }>({ models: {}, missing: [], key: '' })
  useEffect(() => {
    let active = true
    const tiers: TierName[] = ['light', 'strong']
    void Promise.all(
      tiers.map(async (tier) => {
        const option = TIER_MODELS.find((m) => m.id === choice[tier])
        if (!option) return { tier, option }
        const apiKey = await credentials.store
          .getApiKey(option.credentialRef!)
          .catch(() => undefined)
        const model = apiKey
          ? await buildCloudModel(option.provider!, option.model, apiKey).catch(() => undefined)
          : undefined
        return { tier, option, model }
      }),
    ).then((results) => {
      if (!active) return
      const models: Partial<Record<TierName, LanguageModel>> = {}
      for (const r of results) if (r.model) models[r.tier] = r.model
      setBuilt({
        models,
        missing: results.filter((r) => r.option && !r.model).map((r) => r.tier),
        key:
          results.map((r) => (r.model ? r.option!.id : '')).join('|') + `#${credentials.version}`,
      })
    })
    return () => {
      active = false
    }
  }, [choice.light, choice.strong, credentials.store, credentials.version])
  return useMemo(() => {
    const has = Object.keys(built.models).length > 0
    return {
      executorTiers: has ? (built.models as Partial<Record<TierName, ModelInput>>) : undefined,
      key: has ? built.key : '',
      missingKey: built.missing.flatMap((tier) => {
        const model = TIER_MODELS.find((m) => m.id === choice[tier])
        return model ? [{ tier, model }] : []
      }),
    }
  }, [built, choice.light, choice.strong])
}
