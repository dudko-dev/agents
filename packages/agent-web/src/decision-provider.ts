import { decisionModelFromAiSdk, type IDecisionModel } from './decision.js'
import type { CredentialStore } from './secrets/store.js'
import { createGuardedFetch, type IEgressPolicy } from './tools/egress.js'

/**
 * `config.decisionModel` as a spec: a hosted decision API the agent calls itself, with the
 * user's key. The key is never written here: `credentialRef` names it in the agent's
 * `CredentialStore`. The request goes through the guarded fetch under `decisionEgressPolicy` -
 * it can reach that API's host and nothing else.
 *
 * Only APIs that answer a page are listed. Google's Decisions API does (its preflight allows any
 * origin and the `x-goog-api-key` header). TypeSafe's own API refuses cross-origin calls
 * ("Disallowed CORS origin"): from a browser, reach Jev through a gateway of yours and pass an
 * `IDecisionModel` (see docs/capabilities.md).
 */
export interface IDecisionModelSpec {
  /** 'google': the Gemini Decisions API, through the optional peer `@ai-sdk/google`. */
  providerType: 'google'
  /** e.g. 'gemini-decision-1'. */
  model: string
  /** Where the API key is kept in the agent's `CredentialStore`. */
  credentialRef?: string
  /** Replaces the public endpoint (a gateway of yours that holds the key: `credentialRef` is then optional). */
  baseURL?: string
  /** Extra request headers (e.g. a gateway's own). */
  headers?: Record<string, string>
  /** Let the API itself be on a private / loopback address (a local gateway). Widens nothing else. */
  allowPrivateNetwork?: boolean
  /** The fetch under the guard (default `globalThis.fetch`). */
  fetch?: typeof fetch
}

export const DECISION_PROVIDERS = ['google'] as const

const DECISION_BASE_URL: Record<IDecisionModelSpec['providerType'], string> = {
  google: 'https://generativelanguage.googleapis.com/v1beta',
}

/** An answer is a few hundred bytes; a megabyte is not an answer. */
export const DECISION_MAX_RESPONSE_BYTES = 1_000_000
/** The guard's own ceiling. The decision's real deadline is `decision.timeoutMs`. */
export const DECISION_REQUEST_TIMEOUT_MS = 15_000

export const decisionBaseUrl = (spec: IDecisionModelSpec): URL => {
  const raw = spec.baseURL ?? DECISION_BASE_URL[spec.providerType]
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`decisionModel: baseURL "${String(raw).slice(0, 80)}" is not a URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('decisionModel: baseURL must be http(s)')
  }
  return url
}

/**
 * The policy the decision call is made under: exactly the API's host, scheme and port, POST only,
 * no redirect. It is not the model's `egress` policy and takes nothing from it.
 */
export const decisionEgressPolicy = (spec: IDecisionModelSpec): IEgressPolicy => {
  const base = decisionBaseUrl(spec)
  const protocol = base.protocol === 'https:' ? 'https' : 'http'
  return {
    allow: [base.hostname],
    protocols: [protocol],
    ports: [Number(base.port || (protocol === 'https' ? 443 : 80))],
    methods: ['POST'],
    allowPrivateNetwork: spec.allowPrivateNetwork === true,
    followRedirects: false,
    maxResponseBytes: DECISION_MAX_RESPONSE_BYTES,
    timeoutMs: DECISION_REQUEST_TIMEOUT_MS,
    ...(spec.fetch ? { fetch: spec.fetch } : {}),
  }
}

export const isDecisionModelSpec = (input: unknown): input is IDecisionModelSpec =>
  typeof input === 'object' &&
  input !== null &&
  typeof (input as { decide?: unknown }).decide !== 'function' &&
  'providerType' in input

const validate = (spec: IDecisionModelSpec, credentials: CredentialStore | undefined): void => {
  if ('apiKey' in spec) {
    throw new Error(
      'decisionModel: an API key is never written into the config - store it in the CredentialStore and name it with `credentialRef`',
    )
  }
  if (!DECISION_PROVIDERS.includes(spec.providerType)) {
    throw new Error(
      `decisionModel: unknown provider "${String(spec.providerType)}" (known: ${DECISION_PROVIDERS.join(', ')}); pass an IDecisionModel for anything else`,
    )
  }
  if (typeof spec.model !== 'string' || !spec.model) {
    throw new Error('decisionModel: `model` is required')
  }
  decisionBaseUrl(spec)
  if (spec.credentialRef) {
    if (!credentials) {
      throw new Error(
        `decisionModel: credentialRef "${spec.credentialRef}" is set but no CredentialStore was provided to the agent`,
      )
    }
  } else if (!spec.baseURL) {
    throw new Error('decisionModel: a hosted decision API needs a credentialRef')
  }
}

/**
 * `config.decisionModel` -> the model the agent asks, or undefined when the feature is off. An
 * `IDecisionModel` passes through untouched (its requests are the host's, like a tool's).
 */
export const resolveDecisionModel = async (
  input: IDecisionModel | IDecisionModelSpec | undefined,
  credentials?: CredentialStore,
): Promise<IDecisionModel | undefined> => {
  if (input === undefined || input === null) return undefined
  if (!isDecisionModelSpec(input)) {
    if (typeof (input as IDecisionModel).decide !== 'function') {
      throw new Error('decisionModel: expected an object with `decide`, or a provider spec')
    }
    return input
  }
  validate(input, credentials)
  const apiKey = input.credentialRef
    ? await (credentials as CredentialStore).getApiKey(input.credentialRef)
    : undefined
  if (input.credentialRef && !apiKey) {
    throw new Error(
      `decisionModel: no API key found in the CredentialStore for credentialRef "${input.credentialRef}"`,
    )
  }
  let google: typeof import('@ai-sdk/google')
  try {
    // A variable import with both bundler hints, as in providers/registry.ts: the optional peer
    // is left to the runtime, so a host that never uses it builds without it.
    const pkg = '@ai-sdk/google'
    google = (await import(/* webpackIgnore: true */ /* @vite-ignore */ pkg)) as typeof google
  } catch {
    throw new Error(
      'decisionModel: provider "google" needs the package "@ai-sdk/google". Add it to your app: npm install @ai-sdk/google',
    )
  }
  const provider = google.createGoogleGenerativeAI({
    baseURL: decisionBaseUrl(input).href.replace(/\/+$/, ''),
    // A gateway that holds the key is sent none of ours; the SDK wants a value all the same.
    apiKey: apiKey ?? 'none',
    ...(input.headers ? { headers: input.headers } : {}),
    fetch: createGuardedFetch(decisionEgressPolicy(input)) as typeof fetch,
  })
  return decisionModelFromAiSdk(provider.decisionModel(input.model), {
    name: `google:${input.model}`,
  })
}
