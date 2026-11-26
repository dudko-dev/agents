import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { ID_JAG_TYP, JWT_BEARER_GRANT, readClientAuth, verifyJwt } from './idp-server.ts'

/**
 * A real MCP server and a real OAuth authorization server, both on loopback.
 *
 * The unit tests stub `fetch`; this runs the actual SDK server implementation
 * over actual sockets, so the client is validated against a peer rather than
 * against our idea of one — session headers, protocol negotiation, SSE framing
 * and the 401 challenge all come from the SDK itself.
 */

export interface ILocalMcpOptions {
  /** Reject requests without a currently-valid bearer token. */
  requireAuth?: boolean
  /** Seconds until an issued access token expires. Default 3600. */
  expiresIn?: number
  /** Advertise `client_id_metadata_document_supported` (CIMD). */
  clientIdMetadataDocument?: boolean
  /**
   * Advertise `authorization_response_iss_parameter_supported` (RFC 9207). There
   * is no browser in these tests, so nothing redirects: a test plays the
   * redirect by passing `issuer` (or a wrong value) as the callback's `iss`.
   */
  issParameter?: boolean
  /**
   * Accept the `jwt-bearer` grant with an ID-JAG (enterprise-managed
   * authorization) from this identity provider, for this pre-registered
   * confidential client. Every other grant is then refused: there is no
   * interactive way in.
   */
  enterprise?: {
    /** The `iss` an ID-JAG must carry. */
    idpIssuer: string
    /** Where the IdP's signing keys are fetched from, on every grant. */
    jwksUri: string
    clientId: string
    clientSecret: string
    /** Refuse every grant, quoting the assertion in the error (a careless server). */
    echoAssertion?: boolean
  }
}

export interface ILocalMcp {
  /** The MCP endpoint to hand to `mcpServers[name].url`. */
  url: string
  /** The authorization server's issuer: what an honest redirect carries as `iss`. */
  issuer: string
  /**
   * A value only this server knows, returned by the `secret` tool. A task that
   * asks for it cannot be answered from the model's own knowledge, so "did the
   * model actually use the tool?" has a factual answer rather than a stylistic
   * one.
   */
  secret: string
  /** Arguments every tool call received, in order. */
  calls: { name: string; args: unknown }[]
  /** Tokens the authorization server currently accepts. */
  validTokens: Set<string>
  /** Dynamic client registrations performed so far. */
  registrations: () => number
  /** grant_type values seen at the token endpoint, in order. */
  grants: () => string[]
  /** client_id values seen at the token endpoint, in order. */
  tokenClientIds: () => string[]
  /**
   * Every request the token endpoint received: its form parameters, how the
   * client authenticated, and the OAuth error it was answered with (if any).
   */
  /** The `capabilities` of every `initialize` request the MCP server received. */
  initializeCapabilities: Record<string, unknown>[]
  tokenRequests: () => { params: Record<string, string>; authMethod: string; error?: string }[]
  close: () => Promise<void>
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString()
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

const close = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })

/**
 * Start an MCP server exposing one `echo` tool, plus the authorization server
 * that guards it. The two live on separate ports, exactly as they would in
 * production, so RFC 9728 discovery has somewhere real to point.
 */
export const startLocalMcp = async (opts: ILocalMcpOptions = {}): Promise<ILocalMcp> => {
  const calls: { name: string; args: unknown }[] = []
  const secret = `zq-${Math.random().toString(36).slice(2, 8)}`
  const validTokens = new Set<string>()
  const grants: string[] = []
  const tokenClientIds: string[] = []
  const tokenRequests: { params: Record<string, string>; authMethod: string; error?: string }[] = []
  const seenJti = new Set<string>()
  const initializeCapabilities: Record<string, unknown>[] = []
  let registrations = 0
  let issued = 0

  // ── authorization server ────────────────────────────────────────────────
  const as = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      if (url.pathname.includes('/.well-known/oauth-authorization-server')) {
        json(res, 200, {
          issuer: asUrl,
          authorization_endpoint: `${asUrl}/authorize`,
          token_endpoint: `${asUrl}/token`,
          registration_endpoint: `${asUrl}/register`,
          response_types_supported: ['code'],
          grant_types_supported: opts.enterprise
            ? [JWT_BEARER_GRANT]
            : ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: opts.enterprise
            ? ['client_secret_basic', 'client_secret_post']
            : ['none'],
          ...(opts.enterprise
            ? {
                authorization_grant_profiles_supported: [
                  'urn:ietf:params:oauth:grant-profile:id-jag',
                ],
              }
            : {}),
          ...(opts.clientIdMetadataDocument ? { client_id_metadata_document_supported: true } : {}),
          ...(opts.issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
        })
        return
      }
      if (url.pathname === '/register') {
        registrations += 1
        const metadata = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        json(res, 201, { ...metadata, client_id: `dcr-${registrations}`, client_id_issued_at: 1 })
        return
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(await readBody(req))
        const grant = params.get('grant_type') ?? ''
        grants.push(grant)
        tokenClientIds.push(params.get('client_id') ?? '')
        const client = readClientAuth(req, params)
        const record: (typeof tokenRequests)[number] = {
          params: Object.fromEntries(params),
          authMethod: client.method,
        }
        tokenRequests.push(record)
        if (opts.enterprise) {
          // Section 4.4.1 of the ID-JAG draft, in order: the client, the grant,
          // then the assertion - signature, typ, iss, aud, exp, client_id, jti.
          const ent = opts.enterprise
          const refuse = (status: number, error: string, description: string): void => {
            record.error = `${error}: ${description}`
            json(res, status, { error, error_description: description })
          }
          if (client.clientId !== ent.clientId || client.clientSecret !== ent.clientSecret) {
            refuse(401, 'invalid_client', 'Client authentication failed')
            return
          }
          if (grant !== JWT_BEARER_GRANT) {
            refuse(400, 'unsupported_grant_type', 'Only the jwt-bearer grant is accepted')
            return
          }
          if (ent.echoAssertion) {
            refuse(400, 'invalid_request', `cannot accept assertion=${params.get('assertion')}`)
            return
          }
          const jwks = (await (await fetch(ent.jwksUri)).json()) as { keys: never[] }
          const jag = verifyJwt(params.get('assertion') ?? '', jwks)
          if (!jag) {
            refuse(400, 'invalid_grant', 'Signature validation failed')
            return
          }
          const { header, payload } = jag
          if (header.typ !== ID_JAG_TYP) {
            refuse(400, 'invalid_grant', 'Not an ID-JAG')
            return
          }
          if (payload.iss !== ent.idpIssuer) {
            refuse(400, 'invalid_grant', 'Issuer is not trusted')
            return
          }
          const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
          if (aud.length !== 1 || aud[0] !== asUrl) {
            refuse(400, 'invalid_grant', 'Audience validation failed')
            return
          }
          if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
            refuse(400, 'invalid_grant', 'Assertion has expired')
            return
          }
          if (payload.client_id !== client.clientId) {
            refuse(400, 'invalid_grant', 'Assertion was issued to another client')
            return
          }
          if (typeof payload.sub !== 'string' || !payload.sub) {
            refuse(400, 'invalid_grant', 'Assertion names no subject')
            return
          }
          if (typeof payload.jti !== 'string' || seenJti.has(payload.jti)) {
            refuse(400, 'invalid_grant', 'Assertion was already used')
            return
          }
          if (payload.resource !== undefined && payload.resource !== mcpUrl) {
            refuse(400, 'invalid_target', 'This authorization server does not govern that resource')
            return
          }
          seenJti.add(payload.jti)
          issued += 1
          const access = `access-${issued}`
          validTokens.clear()
          validTokens.add(access)
          // Section 4.4.4: no refresh token - the ID-JAG replaces it.
          json(res, 200, {
            access_token: access,
            token_type: 'Bearer',
            expires_in: opts.expiresIn ?? 3600,
            ...(typeof payload.scope === 'string' ? { scope: payload.scope } : {}),
          })
          return
        }
        if (grant === 'authorization_code' && !params.get('code_verifier')) {
          json(res, 400, { error: 'invalid_request' })
          return
        }
        issued += 1
        const access = `access-${issued}`
        // Rotation: only the newest token works, like a real short-lived one.
        validTokens.clear()
        validTokens.add(access)
        json(res, 200, {
          access_token: access,
          token_type: 'Bearer',
          expires_in: opts.expiresIn ?? 3600,
          refresh_token: `refresh-${issued}`,
        })
        return
      }
      json(res, 404, { error: 'not_found' })
    })()
  })
  const asPort = await listen(as)
  const asUrl = `http://127.0.0.1:${asPort}`

  // ── MCP server ──────────────────────────────────────────────────────────
  // Built per request: a stateless StreamableHTTP transport is single-use, and
  // an McpServer can only be connected to one transport at a time. This is the
  // SDK's own pattern for stateless mode.
  const buildServer = (): McpServer => {
    const server = new McpServer({ name: 'local-mcp', version: '1.0.0' })
    server.registerTool(
      'echo',
      { description: 'Echo the input back', inputSchema: { text: z.string() } },
      ({ text }) => {
        calls.push({ name: 'echo', args: { text } })
        return { content: [{ type: 'text' as const, text: `echo:${text}` }] }
      },
    )
    server.registerTool(
      'secret',
      {
        description: 'Return the server-side secret code. There is no other way to learn it.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () => {
        calls.push({ name: 'secret', args: {} })
        return { content: [{ type: 'text' as const, text: secret }] }
      },
    )
    server.registerTool('boom', { description: 'Always fails', inputSchema: {} }, () => {
      calls.push({ name: 'boom', args: {} })
      return { content: [{ type: 'text' as const, text: 'kaboom' }], isError: true }
    })
    return server
  }

  const httpServer = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname
      if (path.includes('/.well-known/oauth-protected-resource')) {
        json(res, 200, {
          resource: mcpUrl,
          authorization_servers: [asUrl],
          scopes_supported: ['mcp:tools'],
        })
        return
      }
      if (opts.requireAuth) {
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        if (!validTokens.has(token)) {
          res.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp"`,
          })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
      }
      const server = buildServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      const raw = await readBody(req)
      const message = raw
        ? (JSON.parse(raw) as {
            method?: string
            params?: { capabilities?: Record<string, unknown> }
          })
        : undefined
      if (message?.method === 'initialize') {
        initializeCapabilities.push(message.params?.capabilities ?? {})
      }
      await transport.handleRequest(req, res, message)
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'server_error' })
    })
  })
  const mcpPort = await listen(httpServer)
  const mcpOrigin = `http://127.0.0.1:${mcpPort}`
  const mcpUrl = `${mcpOrigin}/mcp`

  return {
    url: mcpUrl,
    issuer: asUrl,
    secret,
    calls,
    validTokens,
    registrations: () => registrations,
    grants: () => grants,
    tokenClientIds: () => tokenClientIds,
    tokenRequests: () => tokenRequests,
    initializeCapabilities,
    close: async () => {
      await close(httpServer)
      await close(as)
    },
  }
}
