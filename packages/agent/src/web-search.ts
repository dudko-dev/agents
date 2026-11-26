import { tool, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { markReadOnly } from './approval.ts'
import { runContext } from './context.ts'
import {
  checkEgressUrl,
  createSafeFetch,
  EgressError,
  resolveEgressPolicy,
  type IEgressPolicy,
  type SafeFetch,
} from './safe-fetch.ts'
import type { AgentEvent } from './types.ts'
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
} from './web-search-shared.ts'

// `config.search`: the `web_search` tool, the companion of `web_fetch`. Off unless set. The
// library ships no key: the host passes a search engine of its own (a function - any search API)
// or names the one built-in provider, Google Search through Gemini grounding.
export interface ISearchConfig {
  // A search engine of your own: (query, { maxResults, freshness, signal }) => results. Its
  // requests are yours (like a tool you pass); its results are cleaned, capped and filtered like
  // the provider's. Exactly one of `engine` / `provider`.
  engine?: SearchEngine
  // The built-in provider: 'google' - Google Search through the Gemini API's grounding. One
  // generateContent call per search with the `google_search` tool: it needs a Gemini (Google AI
  // Studio) key and nothing else, and it spends that model's tokens (counted in the run's usage,
  // phase 'search'). Result URLs are Google redirect links, snippets the model's own summary.
  provider?: SearchProvider
  // The Gemini API key of `provider`. Sent in a header to that API only; never in a URL, an
  // event, a log line, an error or a tool result.
  apiKey?: string
  // The Gemini model that makes the grounding call. Default 'gemini-2.5-flash-lite'.
  model?: string
  // Replaces the public endpoint (a gateway of yours that holds the key - `apiKey` is then
  // optional).
  baseURL?: string
  // Results per call when the model does not say (default 5, at most 10).
  maxResults?: number
  // Let the SEARCH API itself be on a private / loopback address (a gateway of yours). It
  // widens nothing else: the request can still reach only that one host. Default false.
  allowPrivateNetwork?: boolean
  // Whole request to the search API, in ms. Default 15_000.
  timeoutMs?: number
  // How the approval gate sees a search. Default true (read-only: the only host reached is the
  // one named here). false = it asks like a write - a query is text that leaves for a third party.
  readOnly?: boolean
}

export interface IWebSearchOptions {
  search: ISearchConfig
  // `config.egress`, when the agent has it: the adapters inherit its deny list, CA and resolver,
  // and results the model could not fetch under it are left out.
  egress?: boolean | IEgressPolicy
  // A fetch of your own for the adapter's request (already bound to a policy). The seam for tests.
  fetch?: SafeFetch
}

// Origin and path only: the query is in the query string, and events are logged.
const describeUrl = (raw: string): string => {
  const u = new URL(raw)
  return `${u.origin}${u.pathname}`
}

// The policy the adapter's one request is made under. It is NOT the model's egress policy with a
// host added: the allow list is exactly the search API's host, scheme and port, so the tool cannot
// be steered anywhere else (no redirect is followed), and the host's deny list still wins.
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
    maxRedirects: 0,
    maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
    timeoutMs: Math.max(1, search.timeoutMs ?? SEARCH_TIMEOUT_MS),
    ...(inherited.ca ? { ca: inherited.ca } : {}),
    ...(inherited.lookup ? { lookup: inherited.lookup } : {}),
  }
}

const validate = (search: ISearchConfig): void => {
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
  if (search.apiKey !== undefined) {
    assertSearchKey(search.apiKey)
  } else if (!search.baseURL) {
    throw new Error(`search: provider "${provider}" needs an apiKey`)
  }
}

// `web_search({ query })`: a short list of { title, url, snippet, date? }. The provider's request
// goes through the safe fetch under `searchEgressPolicy`; what comes back is third-party text and
// is cleaned, capped and - when the agent has an egress policy - filtered to what `web_fetch`
// could open, so a search is not a way to read around the allow / deny lists.
//
// The google provider's links are Google redirect links: the filter can judge only that host
// (plus the site the API names, which is enough to drop a denied site and never to allow one).
// Nothing here follows them. `web_fetch` does, and the safe fetch judges every hop.
export const createWebSearchTool = (options: IWebSearchOptions): Tool => {
  const { search, egress } = options
  validate(search)
  const provider = search.provider
  const key = search.apiKey
  const doFetch = provider
    ? (options.fetch ?? createSafeFetch(searchEgressPolicy(search, egress)))
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
  // A grounded result is a redirect link: web_fetch opens it only if it follows redirects.
  const canFetch = Boolean(modelPolicy) && (!provider || (modelPolicy?.maxRedirects ?? 0) > 0)
  const model = provider ? searchModel(search.model) : undefined
  const defaultMax = Math.max(
    1,
    Math.min(SEARCH_MAX_RESULTS, Math.floor(search.maxResults ?? SEARCH_DEFAULT_MAX_RESULTS) || 1),
  )
  const emit = (event: AgentEvent) => runContext.getStore()?.emit?.(event)

  const viaAdapter = async (
    query: string,
    maxResults: number,
    freshness: SearchFreshness | undefined,
    signal: AbortSignal | undefined,
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
      res = await (doFetch as SafeFetch)(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body ? { body: req.body } : {}),
        signal,
      })
    } catch (err) {
      if (err instanceof EgressError) {
        emit({
          type: 'egress.request',
          url: shown,
          allowed: false,
          reason: redactSecret(`${err.code}: ${err.message}`, key),
        })
      }
      throw err
    }
    emit({ type: 'egress.request', url: shown, allowed: true, status: res.status })
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
    const answer = parseSearchResponse(provider as SearchProvider, json)
    if (answer.usage) {
      // A grounded search is a model call: its tokens count against the run like any other.
      emit({ type: 'usage', phase: 'search', usage: answer.usage })
    }
    return answer
  }

  const searchTool = tool({
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
    execute: async ({ query, maxResults, freshness }, { abortSignal }) => {
      const max = Math.min(maxResults ?? defaultMax, SEARCH_MAX_RESULTS)
      let raw: unknown
      let answer: ISearchAnswer | undefined
      try {
        if (search.engine) {
          raw = await search.engine(query, {
            maxResults: max,
            ...(freshness ? { freshness } : {}),
            ...(abortSignal ? { signal: abortSignal } : {}),
          })
        } else {
          answer = await viaAdapter(query, max, freshness, abortSignal)
          raw = answer.results
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
      return searchToolResult(query, clean, answer)
    },
  })
  return markReadOnly(searchTool, search.readOnly !== false)
}

// The tools `config.search` turns on (none when it is off).
export const createSearchTools = (
  search: ISearchConfig | undefined,
  egress?: boolean | IEgressPolicy,
): ToolSet | undefined =>
  search ? { [WEB_SEARCH_TOOL]: createWebSearchTool({ search, egress }) } : undefined
