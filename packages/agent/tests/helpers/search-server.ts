import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// One loopback server that answers like the three search APIs with a built-in adapter, each
// under its own prefix (so a test's `baseURL` is `${url}/brave`, `/tavily` or `/searxng`), as
// their public documentation describes the request and the response:
//   brave   GET  /res/v1/web/search?q=&count=  header X-Subscription-Token -> { web: { results } }
//   tavily  POST /search { query, max_results } header Authorization: Bearer -> { results }
//   searxng GET  /search?q=&format=json         no key                      -> { results }
// Strict where the real API is: a missing or wrong key is 401, SearXNG without format=json 403.
// Never a real key: tests pass a made-up one. The same file lives in the browser package's tests.

export interface ISearchHit {
  api: 'brave' | 'tavily' | 'searxng' | 'other'
  method: string
  path: string
  query: Record<string, string>
  headers: IncomingMessage['headers']
  body?: unknown
}

export interface ISearchItem {
  title?: unknown
  url?: unknown
  text?: unknown
  date?: unknown
}

export interface ILocalSearch {
  url: string
  port: number
  hits: ISearchHit[]
  close: () => Promise<void>
}

export interface ILocalSearchOptions {
  // The key the "API" accepts.
  key: string
  // What a search returns, in the neutral shape; each API dresses it its own way.
  items?: ISearchItem[]
  // Misbehaviour, one thing at a time.
  fault?:
    | { kind: 'status'; status: number; echoKey?: boolean }
    | { kind: 'redirect'; to: string }
    | { kind: 'not-json' }
    | { kind: 'huge'; bytes: number }
    | { kind: 'hang' }
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

export const DEFAULT_ITEMS: ISearchItem[] = [
  {
    title: 'Install guide',
    url: 'https://docs.example.com/install',
    text: 'Run the installer, then restart.',
    date: '2026-03-01T10:00:00',
  },
  { title: 'Forum thread', url: 'https://forum.example.org/t/42', text: 'It worked for me.' },
  { title: 'Blog', url: 'https://blog.example.net/post', text: 'A long story about installing.' },
]

export const startLocalSearch = async (options: ILocalSearchOptions): Promise<ILocalSearch> => {
  const hits: ISearchHit[] = []
  const items = options.items ?? DEFAULT_ITEMS
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://local')
      const query = Object.fromEntries(url.searchParams)
      const raw = req.method === 'POST' ? await readBody(req) : ''
      let body: unknown
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = raw
      }
      const api = url.pathname.startsWith('/brave/')
        ? 'brave'
        : url.pathname.startsWith('/tavily/')
          ? 'tavily'
          : url.pathname.startsWith('/searxng/')
            ? 'searxng'
            : 'other'
      hits.push({
        api,
        method: req.method ?? '',
        path: url.pathname,
        query,
        headers: req.headers,
        body,
      })
      const json = (status: number, value: unknown): void =>
        void res
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(value))

      const fault = options.fault
      if (fault?.kind === 'status') {
        // Like an API that repeats what it was sent in its error.
        return json(fault.status, {
          error: 'refused',
          detail: fault.echoKey ? `the key ${options.key} is not valid here` : 'no',
        })
      }
      if (fault?.kind === 'redirect') {
        return void res.writeHead(302, { location: fault.to }).end()
      }
      if (fault?.kind === 'not-json') {
        return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>')
      }
      if (fault?.kind === 'huge') {
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(`{"pad":"${'x'.repeat(fault.bytes)}"}`)
      }
      if (fault?.kind === 'hang') {
        return
      }

      if (api === 'brave' && req.method === 'GET' && url.pathname === '/brave/res/v1/web/search') {
        if (req.headers['x-subscription-token'] !== options.key) {
          return json(401, { type: 'ErrorResponse', error: { status: 401 } })
        }
        const count = Number(query.count ?? 20)
        return json(200, {
          type: 'search',
          query: { original: query.q, more_results_available: false },
          web: {
            type: 'search',
            results: items.slice(0, count).map((i) => ({
              type: 'search_result',
              title: i.title,
              url: i.url,
              description: i.text,
              ...(i.date ? { page_age: i.date, age: '2 days ago' } : {}),
              language: 'en',
              family_friendly: true,
            })),
          },
        })
      }
      if (api === 'tavily' && req.method === 'POST' && url.pathname === '/tavily/search') {
        if (req.headers.authorization !== `Bearer ${options.key}`) {
          return json(401, {
            detail: { error: 'Unauthorized: missing or invalid API key.' },
          })
        }
        const b = (body ?? {}) as { query?: string; max_results?: number }
        return json(200, {
          query: b.query,
          answer: null,
          images: [],
          results: items.slice(0, b.max_results ?? 10).map((i, n) => ({
            title: i.title,
            url: i.url,
            content: i.text,
            score: 0.9 - n * 0.1,
            raw_content: null,
            ...(i.date ? { published_date: i.date } : {}),
          })),
          response_time: 0.5,
          request_id: 'req-1',
        })
      }
      if (api === 'searxng' && req.method === 'GET' && url.pathname === '/searxng/search') {
        if (query.format !== 'json') {
          return void res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden')
        }
        return json(200, {
          query: query.q,
          results: items.map((i) => ({
            url: i.url,
            title: i.title,
            content: i.text,
            engine: 'test',
            engines: ['test'],
            template: 'default.html',
            score: 1,
            category: 'general',
            publishedDate: i.date ?? null,
          })),
          answers: [],
          corrections: [],
          infoboxes: [],
          suggestions: [],
          unresponsive_engines: [],
        })
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
