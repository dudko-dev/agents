import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from 'node:http'
import { z } from 'zod'
import {
  startLocalAuthorizationServer,
  type IEnterpriseGrantOptions,
  type ILocalAuthorizationServer,
  type ITokenRequest,
} from './authorization-server.ts'
import { applyCors, closeServer, json, listen, readBody, type IListenOptions } from './http.ts'

/**
 * A real MCP server and a real OAuth authorization server, both on loopback.
 *
 * The unit tests stub `fetch`; this runs the actual SDK server implementation
 * over actual sockets, so the client is validated against a peer rather than
 * against our idea of one — session headers, protocol negotiation, SSE framing
 * and the 401 challenge all come from the SDK itself.
 */

export interface ILocalMcpServerOptions extends IListenOptions {
  /** Reject requests without a currently-valid bearer token. */
  requireAuth?: boolean
  /**
   * The issuers this server names in its protected resource metadata
   * (RFC 9728). Default: none.
   */
  authorizationServers?: string[]
  /**
   * The tokens accepted when `requireAuth` is on: pass the authorization
   * server's `validTokens` to let it decide. Default: a set of this server's
   * own, empty until a test fills it.
   */
  validTokens?: Set<string>
}

export interface ILocalMcpServer {
  /** The MCP endpoint to hand to `mcpServers[name].url`. */
  url: string
  /** The server's origin (the URL without `/mcp`). */
  origin: string
  /**
   * A value only this server knows, returned by the `secret` tool. A task that
   * asks for it cannot be answered from the model's own knowledge, so "did the
   * model actually use the tool?" has a factual answer rather than a stylistic
   * one.
   */
  secret: string
  /** Arguments every tool call received, in order. */
  calls: { name: string; args: unknown }[]
  /** Tokens currently accepted (with `requireAuth`). */
  validTokens: Set<string>
  /** The `capabilities` of every `initialize` request the MCP server received. */
  initializeCapabilities: Record<string, unknown>[]
  close: () => Promise<void>
}

/**
 * Start an MCP server (the SDK's own, stateless streamable HTTP) with three
 * tools: `echo`, `secret` and `boom` (which always fails).
 */
export const startLocalMcpServer = async (
  opts: ILocalMcpServerOptions = {},
): Promise<ILocalMcpServer> => {
  const calls: { name: string; args: unknown }[] = []
  const secret = `zq-${Math.random().toString(36).slice(2, 8)}`
  const validTokens = opts.validTokens ?? new Set<string>()
  const initializeCapabilities: Record<string, unknown>[] = []

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
      if (applyCors(req, res, opts.cors)) {
        return
      }
      const path = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname
      if (path.includes('/.well-known/oauth-protected-resource')) {
        json(res, 200, {
          resource: mcpUrl,
          authorization_servers: opts.authorizationServers ?? [],
          scopes_supported: ['mcp:tools'],
        })
        return
      }
      if (opts.requireAuth) {
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        if (!validTokens.has(token)) {
          json(
            res,
            401,
            { error: 'unauthorized' },
            {
              'www-authenticate': `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp"`,
            },
          )
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
  const mcpOrigin = await listen(httpServer, opts)
  const mcpUrl = `${mcpOrigin}/mcp`

  return {
    url: mcpUrl,
    origin: mcpOrigin,
    secret,
    calls,
    validTokens,
    initializeCapabilities,
    close: () => closeServer(httpServer),
  }
}

// ── the pair: an MCP server and the authorization server that guards it ────

export interface ILocalMcpOptions extends Pick<IListenOptions, 'host' | 'cors'> {
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
  enterprise?: IEnterpriseGrantOptions
}

export interface ILocalMcp extends ILocalMcpServer {
  /** The authorization server's issuer: what an honest redirect carries as `iss`. */
  issuer: string
  /** The authorization server's token endpoint. */
  tokenEndpoint: string
  /** Dynamic client registrations performed so far. */
  registrations: () => number
  /** grant_type values seen at the token endpoint, in order. */
  grants: () => string[]
  /** client_id values seen at the token endpoint, in order. */
  tokenClientIds: () => string[]
  /**
   * Mutable: make the token endpoint go wrong from now on. `refuseGrant`
   * answers every grant with that OAuth error; `echoRequest` refuses and quotes
   * the whole request body in the description (a careless server).
   */
  faults: ILocalAuthorizationServer['faults']
  /** Every client ID metadata document URL the authorization server fetched. */
  cimdFetches: string[]
  /**
   * Every request the token endpoint received: its form parameters, how the
   * client authenticated, and the OAuth error it was answered with (if any).
   */
  tokenRequests: () => ITokenRequest[]
}

/**
 * Start an MCP server exposing the test tools, plus the authorization server
 * that guards it. The two live on separate ports, exactly as they would in
 * production, so RFC 9728 discovery has somewhere real to point.
 */
export const startLocalMcp = async (opts: ILocalMcpOptions = {}): Promise<ILocalMcp> => {
  const as = await startLocalAuthorizationServer({
    host: opts.host,
    cors: opts.cors,
    expiresIn: opts.expiresIn,
    clientIdMetadataDocument: opts.clientIdMetadataDocument,
    issParameter: opts.issParameter,
    enterprise: opts.enterprise,
  })
  let mcp: ILocalMcpServer
  try {
    mcp = await startLocalMcpServer({
      host: opts.host,
      cors: opts.cors,
      requireAuth: opts.requireAuth,
      authorizationServers: [as.issuer],
      validTokens: as.validTokens,
    })
  } catch (err) {
    await as.close()
    throw err
  }
  as.resource = mcp.url

  return {
    ...mcp,
    issuer: as.issuer,
    tokenEndpoint: as.tokenEndpoint,
    registrations: as.registrations,
    grants: as.grants,
    tokenClientIds: as.tokenClientIds,
    tokenRequests: as.tokenRequests,
    faults: as.faults,
    cimdFetches: as.cimdFetches,
    close: async () => {
      await mcp.close()
      await as.close()
    },
  }
}
