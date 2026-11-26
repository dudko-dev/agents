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
  searchStatusMessage,
  SEARCH_DEFAULT_MAX_RESULTS,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_MAX_RESULTS,
  SEARCH_PROVIDERS,
  SEARCH_TIMEOUT_MS,
  WEB_SEARCH_TOOL,
  webSearchDescription,
  type ISearchResult,
  type SearchEngine,
  type SearchFreshness,
  type SearchProvider,
} from './web-search-shared.ts'

// `config.search`: the `web_search` tool, the companion of `web_fetch`. Off unless set. The
// library ships no key and no engine of its own: the host names a hosted search API (a built-in
// adapter, one HTTP call) or passes a function.
export interface ISearchConfig {
  // A search engine of your own: (query, { maxResults, freshness, signal }) => results. Its
  // requests are yours (like a tool you pass); its results are cleaned, capped and filtered like
  // an adapter's. Exactly one of `engine` / `provider`.
  engine?: SearchEngine
  // A built-in adapter: 'brave' | 'tavily' | 'searxng'.
  provider?: SearchProvider
  // The API key of `provider` (brave, tavily). Sent in a header to that API only; never in a URL,
  // an event, a log line, an error or a tool result.
  apiKey?: string
  // Where the API lives. Required for 'searxng' (your instance); for the others it replaces the
  // public endpoint (a gateway of yours - the key is then optional).
  baseURL?: string
  // Results per call when the model does not say (default 5, at most 10).
  maxResults?: number
  // Let the SEARCH API itself be on a private / loopback address (a self-hosted SearXNG). It
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
    methods: ['GET', 'POST'],
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
  if (search.apiKey !== undefined) {
    assertSearchKey(search.apiKey)
  } else if (provider !== 'searxng' && !search.baseURL) {
    throw new Error(`search: provider "${provider}" needs an apiKey`)
  }
}

// `web_search({ query })`: a short list of { title, url, snippet, date? }. The adapter's request
// goes through the safe fetch under `searchEgressPolicy`; what comes back is third-party text and
// is cleaned, capped and - when the agent has an egress policy - filtered to what `web_fetch`
// could open, so a search is not a way to read around the allow / deny lists.
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
    ? (url: URL): boolean => {
        try {
          checkEgressUrl(url, modelPolicy, 'GET')
          return true
        } catch {
          return false
        }
      }
    : undefined
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
  ): Promise<unknown[]> => {
    const req = buildSearchRequest({
      provider: provider as SearchProvider,
      query,
      maxResults,
      freshness,
      apiKey: key,
      baseURL: search.baseURL,
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
      await res.body?.cancel().catch(() => {})
      // The status only: an error body is third-party text, and may echo what was sent.
      throw new Error(searchStatusMessage(provider as SearchProvider, res.status))
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

  const searchTool = tool({
    description: webSearchDescription(Boolean(egress)),
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
      try {
        raw = search.engine
          ? await search.engine(query, {
              maxResults: max,
              ...(freshness ? { freshness } : {}),
              ...(abortSignal ? { signal: abortSignal } : {}),
            })
          : await viaAdapter(query, max, freshness, abortSignal)
      } catch (err) {
        // Whatever failed, the key is not part of what the model, the events or the log see.
        const message = err instanceof Error ? err.message : String(err)
        if (key && message.includes(key)) {
          throw new Error(redactSecret(message, key))
        }
        throw err
      }
      const clean = sanitizeSearchResults(raw, { maxResults: max, accepts })
      return {
        query,
        results: clean.results satisfies ISearchResult[],
        ...(clean.filtered ? { filtered: clean.filtered } : {}),
        ...(clean.truncated ? { truncated: true } : {}),
        untrusted: true,
      }
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
