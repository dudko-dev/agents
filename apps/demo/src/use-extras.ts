import { useEffect, useMemo, useState } from 'react'
import {
  createGuardedFetch,
  decisionEgressPolicy,
  decisionModelFromAiSdk,
  type IDecisionModel,
  type IDecisionModelSpec,
  type IMediaConfig,
} from '@dudko.dev/agent-web'
import type { useCredentials } from '@dudko.dev/agent-web-react'
import { MODELS } from './models'
import { SEARCH_CREDENTIAL } from './settings'
import { workspace } from './workspace'

// The capabilities that are "on when possible": they need a key the visitor may not have saved
// (media, the decision model, web search). One place knows which keys are in the vault, and
// builds the models from them the way cloud.ts builds the chat models - in the app, with a
// literal `import('@ai-sdk/…')` a bundler can see. The core's own spec resolution
// (`{ providerType, model, credentialRef }`) imports the provider package by a bare, ignored
// specifier, which a browser bundle cannot resolve.

type Credentials = ReturnType<typeof useCredentials>

const KEY_REFS = [
  ...new Set([
    ...MODELS.flatMap((m) => (m.credentialRef ? [m.credentialRef] : [])),
    SEARCH_CREDENTIAL,
  ]),
]

/**
 * Which keys are in the vault. Asked of the vault, never read: only "there is one" leaves it.
 * `undefined` while the first answer is on its way.
 */
export const useSavedKeys = (credentials: Credentials): ReadonlySet<string> | undefined => {
  const [saved, setSaved] = useState<ReadonlySet<string> | undefined>(undefined)
  useEffect(() => {
    let active = true
    void Promise.all(
      KEY_REFS.map((ref) =>
        credentials.store
          .getApiKey(ref)
          .then((key) => (key ? ref : undefined))
          .catch(() => undefined),
      ),
    ).then((found) => {
      if (active) setSaved(new Set(found.filter((r): r is string => Boolean(r))))
    })
    return () => {
      active = false
    }
  }, [credentials.store, credentials.version])
  return saved
}

/**
 * A provider's own `fetch`, with the one failure a page cannot read made readable. When a
 * browser blocks a cross-origin answer (CORS) or the network is down, `fetch` rejects with a
 * bare "Failed to fetch": no status, no body. The model - and the person - then get a sentence
 * that says what happened and what to do, instead of that.
 */
export const readableFetch =
  (what: string): typeof fetch =>
  async (input, init) => {
    try {
      return await fetch(input, init)
    } catch (err) {
      if (init?.signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        throw err
      }
      let host = 'the API'
      try {
        host = new URL(input instanceof Request ? input.url : String(input)).host
      } catch {
        /* keep the generic name */
      }
      throw new Error(
        `${what}: no answer from ${host} reached this page. Either the network is down, or the API does not allow calls from a browser page (CORS) - then it needs a gateway of yours in between. (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }

// ── media ────────────────────────────────────────────────────────────────────

export type MediaProvider = 'google' | 'openai'

/**
 * The media models per provider. Google: speech was heard working from a page with a real key
 * (a WAV came back); its image models answer a free-tier key with a quota error (they need a
 * paid one). OpenAI's ids are the SDK's current ones; whether its media endpoints answer a
 * browser page directly has not been checked here.
 */
export const MEDIA_MODELS: Record<
  MediaProvider,
  { label: string; credentialRef: string; image: string; speech: string; transcription: string }
> = {
  google: {
    label: 'Google',
    credentialRef: 'google',
    image: 'gemini-3.1-flash-image',
    speech: 'gemini-3.8-flash-lite-tts',
    transcription: 'gemini-3.5-transcribe',
  },
  openai: {
    label: 'OpenAI',
    credentialRef: 'openai',
    image: 'gpt-image-1',
    speech: 'gpt-4o-mini-tts',
    transcription: 'gpt-4o-mini-transcribe',
  },
}

export interface DemoMedia {
  /** `config.media`, or undefined when media is off or no key for it is saved. */
  config?: IMediaConfig
  /** Whose models are in use. */
  provider?: MediaProvider
  /** Changes when the models do: a dependency of the agents. */
  key: string
}

/** The provider media runs on: the chosen model's own when it has media, else the first with a key. */
export const mediaProviderFor = (
  preferred: string | undefined,
  saved: ReadonlySet<string> | undefined,
): MediaProvider | undefined => {
  const order: MediaProvider[] =
    preferred === 'openai' ? ['openai', 'google'] : ['google', 'openai']
  return order.find((p) => saved?.has(MEDIA_MODELS[p].credentialRef))
}

const buildMedia = async (provider: MediaProvider, apiKey: string): Promise<IMediaConfig> => {
  const ids = MEDIA_MODELS[provider]
  const fetch = readableFetch(`${ids.label} media`)
  const models =
    provider === 'google'
      ? await import('@ai-sdk/google').then(({ createGoogleGenerativeAI }) => {
          const google = createGoogleGenerativeAI({ apiKey, fetch })
          return {
            imageModel: google.image(ids.image),
            speechModel: google.speech(ids.speech),
            transcriptionModel: google.transcription(ids.transcription),
          }
        })
      : await import('@ai-sdk/openai').then(({ createOpenAI }) => {
          const openai = createOpenAI({ apiKey, fetch })
          return {
            imageModel: openai.image(ids.image),
            speechModel: openai.speech(ids.speech),
            transcriptionModel: openai.transcription(ids.transcription),
          }
        })
  // Generated files go to the demo's workspace (/media), never to the language model.
  return { ...models, files: workspace }
}

/**
 * `config.media` for the demo: image, speech and transcription models of a provider whose key
 * is saved, built in the app from that key.
 */
export const useDemoMedia = (
  enabled: boolean,
  preferred: string | undefined,
  credentials: Credentials,
  saved: ReadonlySet<string> | undefined,
): DemoMedia => {
  const provider = enabled ? mediaProviderFor(preferred, saved) : undefined
  const [built, setBuilt] = useState<{ config: IMediaConfig; key: string } | undefined>(undefined)
  useEffect(() => {
    if (!provider) {
      setBuilt(undefined)
      return
    }
    let active = true
    credentials.store
      .getApiKey(MEDIA_MODELS[provider].credentialRef)
      .then(async (apiKey) => {
        const config = apiKey ? await buildMedia(provider, apiKey) : undefined
        if (active) {
          setBuilt(config ? { config, key: `${provider}#${credentials.version}` } : undefined)
        }
      })
      .catch(() => {
        if (active) setBuilt(undefined)
      })
    return () => {
      active = false
    }
  }, [provider, credentials.store, credentials.version])
  return useMemo(
    () => (built && provider ? { config: built.config, provider, key: built.key } : { key: '' }),
    [built, provider],
  )
}

// ── the decision model ───────────────────────────────────────────────────────

/** What the core's `decisionModel` spec would be; here it names the model and its key. */
export const DECISION_SPEC = {
  providerType: 'google',
  model: 'gemini-decision-1',
  credentialRef: 'google',
} as const satisfies IDecisionModelSpec

export interface DemoDecision {
  /** `config.decisionModel`, or undefined when it is off or no Google key is saved. */
  model?: IDecisionModel
  key: string
}

/**
 * `config.decisionModel` for the demo. The core would build it from `DECISION_SPEC` itself -
 * but through `import('@ai-sdk/google')` by a bare specifier, which this bundle cannot resolve.
 * So it is built here exactly as the core builds it (decision-provider.ts): the provider's
 * decision model behind the guarded fetch under the spec's own egress policy - the API's host,
 * POST only, no redirects - wrapped by `decisionModelFromAiSdk`.
 */
export const useDemoDecision = (
  enabled: boolean,
  credentials: Credentials,
  saved: ReadonlySet<string> | undefined,
): DemoDecision => {
  const possible = enabled && Boolean(saved?.has(DECISION_SPEC.credentialRef))
  const [built, setBuilt] = useState<DemoDecision>({ key: '' })
  useEffect(() => {
    if (!possible) {
      setBuilt({ key: '' })
      return
    }
    let active = true
    credentials.store
      .getApiKey(DECISION_SPEC.credentialRef)
      .then(async (apiKey) => {
        if (!apiKey) return undefined
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
        const provider = createGoogleGenerativeAI({
          apiKey,
          fetch: createGuardedFetch(decisionEgressPolicy(DECISION_SPEC)) as typeof fetch,
        })
        return decisionModelFromAiSdk(provider.decisionModel(DECISION_SPEC.model), {
          name: `google:${DECISION_SPEC.model}`,
        })
      })
      .then((model) => {
        if (active)
          setBuilt(model ? { model, key: `decision#${credentials.version}` } : { key: '' })
      })
      .catch(() => {
        if (active) setBuilt({ key: '' })
      })
    return () => {
      active = false
    }
  }, [possible, credentials.store, credentials.version])
  return built
}
