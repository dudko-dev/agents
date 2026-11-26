import { z } from 'zod'
import type { AgentEvent } from '../events.js'
import type { CredentialStore } from '../secrets/store.js'
import { markReadOnly } from './approval.js'
import { defineTool } from './define.js'
import {
  checkEgressUrl,
  createGuardedFetch,
  EgressError,
  resolveEgressPolicy,
  type GuardedFetch,
  type IEgressPolicy,
} from './egress.js'
import type { AgentTool, AgentToolSet } from './types.js'
import {
  assertSearchKey,
  buildSearchRequest,
  parseSearchResponse,
  redactSecret,
  sanitizeSearchResults,
  searchBaseUrl,
  searchModel,
  searchSiteUrl,
  searchStatusMessage,
  searchToolResult,
  SEARCH_DEFAULT_MAX_RESULTS,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_MAX_RESULTS,
  SEARCH_PROVIDERS,
  SEARCH_TIMEOUT_MS,
  WEB_SEARCH_TOOL,
  webSearchDescription,
  type ISearchAnswer,
  type SearchEngine,
  type SearchFreshness,
  type SearchProvider,
} from './web-search-shared.js'
import { toolRunContextOf } from './wrap.js'

/**
 * `config.search`: the `web_search` tool, the companion of `web_fetch`. Off unless set. The
 * library ships no key: the host passes a search engine of its own (a function - any search API)
 * or names the one built-in provider, Google Search through Gemini grounding. Browser sibling of
 * the server's `ISearchConfig` - same names - except that a key is never written here:
 * `credentialRef` names it in the `CredentialStore` the agent was given (`config.credentials`).
 *
 * The Gemini API answers a page directly (CORS). See docs/capabilities.md.
 */
export interface ISearchConfig {
  /**
   * A search engine of your own: `(query, { maxResults, freshness, signal }) => results`. Its
   * requests are yours (like a tool you pass); its results are cleaned, capped and filtered like
   * the provider's. Exactly one of `engine` / `provider`.
   */
  engine?: SearchEngine
  /**
   * The built-in provider: 'google' - Google Search through the Gemini API's grounding. One
   * generateContent call per search with the `google_search` tool: it needs a Gemini (Google AI
   * Studio) key and nothing else, and it spends that model's tokens (counted in the run's usage,
   * phase 'search'). Result URLs are Google redirect links, snippets the model's own summary.
   */
  provider?: SearchProvider
  /**
   * Where the Gemini API key is kept in the agent's `CredentialStore` (it can be the ref of a
   * Gemini model's own key). Read at each call and sent in a header to that API only; never in a
   * URL, an event, a log line, an error or a result.
   */
  credentialRef?: string
  /** The Gemini model that makes the grounding call. Default 'gemini-2.5-flash-lite'. */
  model?: string
  /**
   * Replaces the public endpoint (a gateway of yours that holds the key - `credentialRef` is
   * then optional).
   */
  baseURL?: string
  /** Results per call when the model does not say (default 5, at most 10). */
  maxResults?: number
  /**
   * Let the SEARCH API itself be on a private / loopback address or an internal-looking name (a
   * gateway of yours). It widens nothing else: the request can still reach only that one host.
   */
  allowPrivateNetwork?: boolean
  /** Whole request to the search API, in ms. Default 15_000. */
  timeoutMs?: number
  /**
   * How the consent gate sees a search. Default true (read-only: the only host reached is the one
   * named here). false = it asks like a write - a query is text that leaves for a third party.
   */
  readOnly?: boolean
  /** The fetch the adapter uses (default `globalThis.fetch`). Still bound to the search policy. */
  fetch?: typeof fetch
}

export interface IWebSearchOptions {
  search: ISearchConfig
  /** `config.egress`, when the agent has it: its deny list is inherited, and results the model could not fetch under it are left out. */
  egress?: boolean | IEgressPolicy
  /** Where `search.credentialRef` is looked up (`config.credentials`). */
  credentials?: CredentialStore
  /** A fetch of your own for the adapter's request (already bound to a policy). */
  fetch?: GuardedFetch
}

// Origin and path only: the query is in the query string, and events are logged.
const describeUrl = (raw: string): string => {
  const u = new URL(raw)
  return `${u.origin}${u.pathname}`
}

/**
 * The policy the adapter's one request is made under. It is NOT the model's egress policy with a
 * host added: the allow list is exactly the search API's host, scheme and port, so the tool
 * cannot be steered anywhere else (a redirect is never followed), and the host's deny list
 * still wins.
 */
export const searchEgressPolicy = (
  search: ISearchConfig,
  egress?: boolean | IEgressPolicy,
): IEgressPolicy => {
  const base = searchBaseUrl(search.provider as SearchProvider, search.baseURL)
  const inherited = typeof egress === 'object' ? egress : {}
  const protocol = base.protocol === 'https:' ? 'https' : 'http'
  return {
    allow: [base.hostname],
    ...(inherited.deny ? { deny: inherited.deny } : {}),
    protocols: [protocol],
    ports: [Number(base.port || (protocol === 'https' ? 443 : 80))],
    methods: ['POST'],
    allowPrivateNetwork: search.allowPrivateNetwork === true,
    followRedirects: false,
    maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
    timeoutMs: Math.max(1, search.timeoutMs ?? SEARCH_TIMEOUT_MS),
    ...(search.fetch ? { fetch: search.fetch } : {}),
  }
}

const validate = (search: ISearchConfig, credentials: CredentialStore | undefined): void => {
  if ('apiKey' in search) {
    throw new Error(
      'search: an API key is never written into the config - store it in the CredentialStore and name it with `credentialRef`',
    )
  }
  if (Boolean(search.engine) === Boolean(search.provider)) {
    throw new Error('search: set exactly one of `engine` (a function) or `provider`')
  }
  if (search.engine) {
    if (typeof search.engine !== 'function') {
      throw new Error('search: `engine` must be a function')
    }
    return
  }
  const provider = search.provider as SearchProvider
  if (!SEARCH_PROVIDERS.includes(provider)) {
    throw new Error(
      `search: unknown provider "${String(provider)}" (known: ${SEARCH_PROVIDERS.join(', ')})`,
    )
  }
  searchBaseUrl(provider, search.baseURL)
  searchModel(search.model)
  if (search.credentialRef) {
    if (!credentials) {
      throw new Error(
        `search: credentialRef "${search.credentialRef}" is set but no CredentialStore was provided to the agent`,
      )
    }
  } else if (!search.baseURL) {
    throw new Error(`search: provider "${provider}" needs a credentialRef`)
  }
}

/**
 * `web_search({ query })`: a short list of `{ title, url, snippet, date? }`. The adapter's
 * request goes through the guarded fetch under `searchEgressPolicy`; what comes back is
 * third-party text and is cleaned, capped and - when the agent has an egress policy - filtered
 * to what `web_fetch` could open, so a search is not a way to read around the allow / deny lists.
 *
 * The google provider's links are Google redirect links: the filter can judge only that host
 * (plus the site the API names, which is enough to drop a denied site and never to allow one).
 * Nothing here follows them. `web_fetch` opens one only under `egress.followRedirects` (the
 * guarded fetch then judges where it ended) and, from a page, only through an `egress.fetch`
 * of the host's: the redirect host sends no CORS headers.
 */
export const createWebSearchTool = (options: IWebSearchOptions): AgentTool => {
  const { search, egress, credentials } = options
  validate(search, credentials)
  const provider = search.provider
  const doFetch = provider
    ? (options.fetch ?? createGuardedFetch(searchEgressPolicy(search, egress)))
    : undefined
  const modelPolicy = egress ? resolveEgressPolicy(egress === true ? {} : egress) : undefined
  const accepts = modelPolicy
    ? (url: URL, title?: unknown): boolean => {
        try {
          checkEgressUrl(url, modelPolicy, 'GET')
        } catch {
          return false
        }
        // The site a grounded result names: a host on the deny list is dropped by name too.
        const site = provider ? searchSiteUrl(title) : undefined
        if (site) {
          try {
            checkEgressUrl(site, modelPolicy, 'GET')
          } catch (err) {
            if (err instanceof EgressError && err.code === 'denied-host') {
              return false
            }
          }
        }
        return true
      }
    : undefined
  // A grounded result is a redirect link on a host that sends no CORS headers: a page's own
  // fetch cannot read through it. web_fetch opens one only when it follows redirects AND goes
  // through a fetch of the host's (a gateway).
  const canFetch =
    Boolean(modelPolicy) &&
    (!provider ||
      (modelPolicy?.followRedirects === true &&
        typeof egress === 'object' &&
        typeof egress.fetch === 'function'))
  const model = provider ? searchModel(search.model) : undefined
  const defaultMax = Math.max(
    1,
    Math.min(SEARCH_MAX_RESULTS, Math.floor(search.maxResults ?? SEARCH_DEFAULT_MAX_RESULTS) || 1),
  )

  // The key, read from the store at each call (it may have been rotated), never kept here.
  const readKey = async (): Promise<string | undefined> => {
    if (!search.credentialRef) {
      return undefined
    }
    const key = await (credentials as CredentialStore).getApiKey(search.credentialRef)
    if (!key) {
      throw new Error(
        `web_search failed: no API key in the CredentialStore for credentialRef "${search.credentialRef}"`,
      )
    }
    return assertSearchKey(key)
  }

  const viaAdapter = async (
    query: string,
    maxResults: number,
    freshness: SearchFreshness | undefined,
    key: string | undefined,
    signal: AbortSignal | undefined,
    emit: ((event: AgentEvent) => void) | undefined,
  ): Promise<ISearchAnswer> => {
    const req = buildSearchRequest({
      provider: provider as SearchProvider,
      query,
      maxResults,
      freshness,
      apiKey: key,
      baseURL: search.baseURL,
      model,
      now: Date.now(),
    })
    const shown = describeUrl(req.url)
    let res: Response
    try {
      res = await (doFetch as GuardedFetch)(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body ? { body: req.body } : {}),
        signal,
      })
    } catch (err) {
      if (err instanceof EgressError) {
        emit?.({
          type: 'egress.request',
          url: shown,
          allowed: false,
          reason: redactSecret(`${err.code}: ${err.message}`, key),
        })
      }
      throw err
    }
    emit?.({ type: 'egress.request', url: shown, allowed: true, status: res.status })
    if (!res.ok) {
      // The status and the API's own error code word, never the text of the body: that is
      // third-party text, and may echo what was sent.
      let body: unknown
      try {
        body = JSON.parse(await res.text())
      } catch {
        body = undefined
      }
      throw new Error(searchStatusMessage(provider as SearchProvider, res.status, model, body))
    }
    let json: unknown
    try {
      json = JSON.parse(await res.text())
    } catch (err) {
      if (err instanceof EgressError) {
        throw err
      }
      throw new Error(`web_search failed: the ${provider} search API did not answer with JSON`)
    }
    return parseSearchResponse(provider as SearchProvider, json)
  }

  const t = defineTool({
    description: webSearchDescription(canFetch, provider),
    inputSchema: z.object({
      query: z.string().min(1).max(SEARCH_MAX_QUERY_CHARS).describe('What to search for'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(SEARCH_MAX_RESULTS)
        .optional()
        .describe(`How many results (default ${defaultMax})`),
      freshness: z
        .enum(['day', 'week', 'month', 'year'])
        .optional()
        .describe('Only results from the last day / week / month / year'),
    }),
    promptHint:
      '{ query: string, maxResults?: number, freshness?: "day" | "week" | "month" | "year" }',
    execute: async (
      {
        query,
        maxResults,
        freshness,
      }: { query: string; maxResults?: number; freshness?: SearchFreshness },
      options: unknown,
    ) => {
      const run = toolRunContextOf(options)
      const abortSignal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal
      // The prompted path does not validate against the schema: the caps hold here too.
      const q = String(query ?? '').slice(0, SEARCH_MAX_QUERY_CHARS)
      if (!q.trim()) {
        throw new Error('web_search needs a query')
      }
      const max = Math.max(
        1,
        Math.min(Math.floor(Number(maxResults ?? defaultMax)) || defaultMax, SEARCH_MAX_RESULTS),
      )
      let key: string | undefined
      let raw: unknown
      let answer: ISearchAnswer | undefined
      try {
        if (search.engine) {
          raw = await search.engine(q, {
            maxResults: max,
            ...(freshness ? { freshness } : {}),
            ...(abortSignal ? { signal: abortSignal } : {}),
          })
        } else {
          key = await readKey()
          answer = await viaAdapter(q, max, freshness, key, abortSignal, run?.emit)
          raw = answer.results
          if (answer.usage) {
            // A grounded search is a model call: its tokens count against the run like any other.
            run?.addUsage(answer.usage, 'search')
          }
        }
      } catch (err) {
        // Whatever failed, the key is not part of what the model, the events or the log see.
        const message = err instanceof Error ? err.message : String(err)
        if (key && message.includes(key)) {
          throw new Error(redactSecret(message, key))
        }
        throw err
      }
      const clean = sanitizeSearchResults(raw, { maxResults: max, accepts })
      return searchToolResult(q, clean, answer)
    },
  })
  return markReadOnly(t, search.readOnly !== false)
}

/** The tools `config.search` turns on (none when it is off). */
export const createSearchTools = (
  search: ISearchConfig | undefined,
  egress?: boolean | IEgressPolicy,
  credentials?: CredentialStore,
): AgentToolSet | undefined =>
  search ? { [WEB_SEARCH_TOOL]: createWebSearchTool({ search, egress, credentials }) } : undefined
