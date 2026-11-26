import { useEffect, useState } from 'react'
import { useCredentials, useLocalModel } from '@dudko.dev/agent-web-react'
import type { LanguageModel } from 'ai'
import { buildCloudModel } from './cloud'
import { engineFor } from './local-engines'
import { isLocal, MODELS } from './models'

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
