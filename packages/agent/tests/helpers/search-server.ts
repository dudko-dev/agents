import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// One loopback server that answers like the Gemini API does to a grounded search - the one
// built-in provider of `config.search` - in the shapes recorded from the live API on 2026-11-26
// (made-up content, the real structure):
//   POST /v1beta/models/{model}:generateContent   header x-goog-api-key
//   { systemInstruction, contents, tools: [{ google_search }], generationConfig }
//   -> { candidates: [{ content, groundingMetadata: { groundingChunks, groundingSupports,
//        webSearchQueries, searchEntryPoint } }], usageMetadata }
// Strict where the real API is: a wrong key is HTTP 400 API_KEY_INVALID, an unknown model 404.
// Never a real key: tests pass a made-up one. The same file lives in the browser package's tests.

export interface ISearchHit {
  api: 'google' | 'other'
  method: string
  path: string
  // The model named in the path.
  model?: string
  query: Record<string, string>
  headers: IncomingMessage['headers']
  body?: unknown
}

// A source of the grounded answer: `title` is what the API sends as the site's name, `url` the
// link (a Google redirect link in real life), `text` the sentence of the answer attributed to it.
export interface ISearchItem {
  title?: unknown
  url?: unknown
  text?: unknown
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
  // The sources of the answer.
  items?: ISearchItem[]
  // The model's answer text (default: the items' sentences, joined).
  answer?: string
  // false = the answer comes without groundingSupports (no per-source sentences).
  supports?: boolean
  // What `usageMetadata` reports (default: the numbers of a recorded call). null = none.
  usage?: Record<string, unknown> | null
  // The only model this "key" may use (others answer 404, like a retired model).
  model?: string
  // Misbehaviour, one thing at a time.
  fault?:
    | { kind: 'status'; status: number; code?: string; reason?: string; echoKey?: boolean }
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

// The host of a real result link, and the shape of one (the token is made up).
export const REDIRECT_HOST = 'vertexaisearch.cloud.google.com'
export const redirectLink = (n: number): string =>
  `https://${REDIRECT_HOST}/grounding-api-redirect/AUZIYQE${String(n).padStart(2, '0')}xYjcQPv4h58To2AahCTgx-Eo7YCzkVal_OMGp4sC2Q_yoje12J6PpXM2fACxqe9fxv13xkzxDuwHLa_aqVE3vrVKVasVuJ3z6RxmmvTIrQrYT8u-u2E6MowKt==`

export const DEFAULT_ITEMS: ISearchItem[] = [
  { title: 'docs.example.com', url: redirectLink(1), text: 'Run the installer, then restart.' },
  { title: 'example.org', url: redirectLink(2), text: 'It worked for me.' },
  { title: 'example.net', url: redirectLink(3), text: 'A long story about installing.' },
]

// What one recorded call reported: 8 + 35 tokens in, 92 out.
export const DEFAULT_USAGE = {
  promptTokenCount: 8,
  candidatesTokenCount: 92,
  totalTokenCount: 135,
  promptTokensDetails: [{ modality: 'TEXT', tokenCount: 8 }],
  toolUsePromptTokenCount: 35,
  toolUsePromptTokensDetails: [{ modality: 'TEXT', tokenCount: 35 }],
  serviceTier: 'standard',
}

const STATUS_CODE: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
}

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
      const m = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(url.pathname)
      const model = m ? decodeURIComponent(m[1]) : undefined
      hits.push({
        api: m ? 'google' : 'other',
        method: req.method ?? '',
        path: url.pathname,
        ...(model ? { model } : {}),
        query,
        headers: req.headers,
        body,
      })
      const json = (status: number, value: unknown): void =>
        void res
          .writeHead(status, { 'content-type': 'application/json; charset=UTF-8' })
          .end(JSON.stringify(value))
      // A Google API error: a code, a sentence, a status word, sometimes details.
      const refuse = (status: number, message: string, code?: string, reason?: string): void =>
        json(status, {
          error: {
            code: status,
            message,
            status: code ?? STATUS_CODE[status] ?? 'UNKNOWN',
            ...(reason
              ? {
                  details: [
                    {
                      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                      reason,
                      domain: 'googleapis.com',
                    },
                  ],
                }
              : {}),
          },
        })

      const fault = options.fault
      if (fault?.kind === 'status') {
        // Like an API that repeats what it was sent in its error.
        return refuse(
          fault.status,
          fault.echoKey
            ? `the key ${options.key} is not valid here`
            : 'You exceeded your current quota, please check your plan and billing details.',
          fault.code,
          fault.reason,
        )
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

      if (m && req.method === 'POST') {
        if (req.headers['x-goog-api-key'] !== options.key) {
          return refuse(
            400,
            'API key not valid. Please pass a valid API key.',
            'INVALID_ARGUMENT',
            'API_KEY_INVALID',
          )
        }
        if (options.model && model !== options.model) {
          return refuse(404, `This model models/${model} is no longer available to new users.`)
        }
        const b = (body ?? {}) as { contents?: { parts?: { text?: string }[] }[] }
        const asked = b.contents?.[0]?.parts?.[0]?.text ?? ''
        const answer =
          options.answer ??
          items
            .map((i) => i.text)
            .filter((t) => typeof t === 'string')
            .join(' ')
        const grounded = items.length > 0
        return json(200, {
          candidates: [
            {
              content: { parts: [{ text: answer }], role: 'model' },
              finishReason: 'STOP',
              index: 0,
              groundingMetadata: grounded
                ? {
                    searchEntryPoint: {
                      renderedContent: `<style>.chip{}</style><div class="container"><a class="chip" href="${redirectLink(99)}">${asked}</a></div>`,
                    },
                    groundingChunks: items.map((i) => ({ web: { uri: i.url, title: i.title } })),
                    ...(options.supports === false
                      ? {}
                      : {
                          groundingSupports: items.flatMap((i, n) =>
                            i.text === undefined
                              ? []
                              : [
                                  {
                                    segment: {
                                      startIndex: n * 10,
                                      endIndex: n * 10 + 9,
                                      text: i.text,
                                    },
                                    groundingChunkIndices: [n],
                                  },
                                ],
                          ),
                        }),
                    webSearchQueries: [asked],
                  }
                : {},
            },
          ],
          ...(options.usage === null ? {} : { usageMetadata: options.usage ?? DEFAULT_USAGE }),
          modelVersion: model,
          responseId: 'resp-1',
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
