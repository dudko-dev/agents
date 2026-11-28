// The gateway's HTTP plumbing on node:http: bounded JSON bodies, JSON answers, the bearer check
// and CORS. No framework.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

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

export const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  })
  res.end(text)
}

export const sendError = (res: ServerResponse, err: HttpError): void =>
  sendJson(res, err.status, { error: { code: err.code, message: err.message } }, err.headers)

// The body as JSON, at most `maxBytes`: refused by its Content-Length before a byte is read, and
// counted while it streams (a chunked body has no length). Empty -> undefined.
export const readJson = async (req: IncomingMessage, maxBytes: number): Promise<unknown> => {
  const declared = Number(req.headers['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'body_too_large', `the body is limited to ${maxBytes} bytes`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) {
      throw new HttpError(413, 'body_too_large', `the body is limited to ${maxBytes} bytes`)
    }
    chunks.push(chunk)
  }
  if (size === 0) {
    return undefined
  }
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase()
  if (type !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'send the body as application/json')
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json', 'the body is not valid JSON')
  }
}

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest()

// A constant-time check of `Authorization: Bearer <token>` against every configured token (more
// than one: rotation). The digests make the comparison length-independent; every token is
// compared, so the time does not tell which one matched either.
export const createBearerCheck = (tokens: string[]): ((header: string | undefined) => boolean) => {
  const known = tokens.map(digest)
  return (header) => {
    const m = /^Bearer[ ]+([^ ]+)[ ]*$/i.exec(header ?? '')
    const given = digest(m?.[1] ?? '')
    let ok = false
    for (const k of known) {
      ok = timingSafeEqual(k, given) || ok
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
