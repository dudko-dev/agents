// The gateway's HTTP plumbing over Web-standard APIs only (Request, Response, TextEncoder /
// TextDecoder, crypto.subtle): bounded JSON bodies, JSON answers, the bearer check and CORS. No
// framework, no node:* - the same code on Node (behind its adapter), Workers, Cloud Run, Lambda.

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly headers: Record<string, string>
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
}

const encoder = new TextEncoder()

export const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response => {
  const text = JSON.stringify(body)
  if (typeof text !== 'string') {
    // `undefined` (or a function) is no JSON: a failure of the caller, answered as a 500.
    throw new TypeError('the answer is not JSON')
  }
  const bytes = encoder.encode(text)
  return new Response(bytes, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.byteLength),
      ...headers,
    },
  })
}

export const errorResponse = (err: HttpError): Response =>
  jsonResponse(err.status, { error: { code: err.code, message: err.message } }, err.headers)

const bodyTooLarge = (maxBytes: number): HttpError =>
  new HttpError(413, 'body_too_large', `the body is limited to ${maxBytes} bytes`)

// The body as JSON, at most `maxBytes`: refused by its Content-Length before a byte is read, and
// counted while it streams (a chunked body has no length; the rest is not read). Empty ->
// undefined. A byte order mark is kept, so it is not JSON (as a plain UTF-8 read of the bytes).
export const readJson = async (request: Request, maxBytes: number): Promise<unknown> => {
  const declared = Number(request.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw bodyTooLarge(maxBytes)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  if (request.body) {
    const reader = request.body.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        throw bodyTooLarge(maxBytes)
      }
      chunks.push(value)
    }
  }
  if (size === 0) {
    return undefined
  }
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'send the body as application/json')
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes))
  } catch {
    throw new HttpError(400, 'invalid_json', 'the body is not valid JSON')
  }
}

const digest = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))

// Equal bytes, compared in a time that depends on the length only (the digests' is fixed).
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}

// A constant-time check of `Authorization: Bearer <token>` against every configured token (more
// than one: rotation). The SHA-256 digests make the comparison length-independent; every token is
// compared, so the time does not tell which one matched either.
export const createBearerCheck = (
  tokens: string[],
): ((header: string | undefined) => Promise<boolean>) => {
  // Digested on the first check (WebCrypto is asynchronous), then kept.
  let known: Promise<Uint8Array[]> | undefined
  return async (header) => {
    known ??= Promise.all(tokens.map(digest))
    const m = /^Bearer[ ]+([^ ]+)[ ]*$/i.exec(header ?? '')
    const given = await digest(m?.[1] ?? '')
    let ok = false
    for (const k of await known) {
      ok = constantTimeEqual(k, given) || ok
    }
    return Boolean(m) && ok
  }
}

// CORS for the listed origins (exact match; `*` allows any). No cookies are involved - the
// gateway reads a bearer token - so credentials are never allowed.
export const corsHeaders = (
  origin: string | undefined,
  allowed: string[],
  preflight: boolean,
): Record<string, string> => {
  if (!origin || !(allowed.includes('*') || allowed.includes(origin))) {
    return {}
  }
  return {
    'access-control-allow-origin': allowed.includes('*') ? '*' : origin,
    vary: 'Origin',
    ...(preflight
      ? {
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, last-event-id',
          'access-control-max-age': '600',
        }
      : {}),
  }
}
