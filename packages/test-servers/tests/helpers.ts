import {
  CLIENT_ASSERTION_TYPE,
  ID_JAG_TOKEN_TYPE,
  ID_TOKEN_TOKEN_TYPE,
  JWT_BEARER_GRANT,
  signJwt,
  TOKEN_EXCHANGE_GRANT,
  type IClientKey,
} from '../src/index.ts'
import { createPrivateKey, randomUUID } from 'node:crypto'

/** What a test needs to say about one HTTP answer. */
export interface IAnswer {
  status: number
  headers: Headers
  body: Record<string, unknown>
}

export const postForm = async (
  url: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<IAnswer> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
    redirect: 'manual',
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Not JSON (a redirect, an empty answer): the status and headers say it.
  }
  return { status: res.status, headers: res.headers, body }
}

export const getJson = async (url: string, headers: Record<string, string> = {}) => {
  const res = await fetch(url, { headers })
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, unknown>,
  }
}

export const basic = (id: string, secret: string): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
})

/** The token-exchange form of the ID-JAG draft. */
export const exchangeParams = (
  idToken: string,
  audience: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  grant_type: TOKEN_EXCHANGE_GRANT,
  requested_token_type: ID_JAG_TOKEN_TYPE,
  subject_token: idToken,
  subject_token_type: ID_TOKEN_TOKEN_TYPE,
  audience,
  ...extra,
})

export const grantParams = (
  idJag: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({ grant_type: JWT_BEARER_GRANT, assertion: idJag, ...extra })

/**
 * A client assertion made by hand (ES256), so the servers are tested against
 * something other than the providers they will later be used to test.
 */
export const clientAssertion = (
  key: IClientKey,
  claims: {
    clientId: string
    audience: unknown
    typ?: string | null
    sub?: string
    expiresIn?: number
    jti?: string
  },
): string => {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    createPrivateKey({ key: key.privateJwk, format: 'jwk' }),
    {
      ...(claims.typ === null ? {} : { typ: claims.typ ?? 'client-authentication+jwt' }),
      kid: key.kid,
    },
    {
      iss: claims.clientId,
      sub: claims.sub ?? claims.clientId,
      aud: claims.audience,
      jti: claims.jti ?? randomUUID(),
      iat: now,
      exp: now + (claims.expiresIn ?? 60),
    },
  )
}

export const assertionParams = (assertion: string): Record<string, string> => ({
  client_assertion_type: CLIENT_ASSERTION_TYPE,
  client_assertion: assertion,
})
