import {
  createGuardedFetch,
  VaultCredentialStore,
  type CredentialStore,
  type SearchEngine,
} from '@dudko.dev/agent-web'

// An example search engine for `config.search.engine`: Tavily, the hosted search API that
// answers a page directly (CORS). The library ships no search API of a third party - an engine
// is a function of the host, and this is the demo's.

const TAVILY_HOST = 'api.tavily.com'

// The engine's one request, bound to the API's host: https, POST, no redirect followed.
const tavilyFetch = createGuardedFetch({ allow: [TAVILY_HOST], methods: ['POST'] })

/**
 * Tavily as a search engine. The key is the user's own: read at each call from the vault under
 * `credentialRef` (the demo's vault is the default one, so a store of our own opens the same
 * keys), sent in a header to api.tavily.com only, never part of an error. What it returns is
 * cleaned, capped and filtered by the agent like any engine's results.
 */
export const tavilyEngine = (
  credentialRef: string,
  credentials: CredentialStore = new VaultCredentialStore(),
): SearchEngine => {
  return async (query, { maxResults, freshness, signal }) => {
    const key = await credentials.getApiKey(credentialRef)
    if (!key) {
      throw new Error('web_search failed: no Tavily API key is saved')
    }
    const res = await tavilyFetch(`https://${TAVILY_HOST}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        ...(freshness ? { time_range: freshness } : {}),
      }),
      signal,
    })
    if (!res.ok) {
      // The status only: an error body is third-party text, and may echo what was sent.
      throw new Error(`web_search failed: the Tavily search API answered HTTP ${res.status}`)
    }
    const body = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string; published_date?: string }[]
    }
    return (body.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
      ...(r.published_date ? { date: r.published_date } : {}),
    }))
  }
}
