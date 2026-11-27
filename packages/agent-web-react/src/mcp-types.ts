import type { AgentToolSet } from '@dudko.dev/agent-web'

/**
 * Structural types for the core's OPTIONAL `@dudko.dev/agent-web/mcp` subpath.
 *
 * The subpath is loaded with a dynamic import and typed here rather than
 * imported, for two reasons: it drags in `@modelcontextprotocol/client` (an
 * optional peer of the core, which apps without MCP must not have to install),
 * and the OAuth half only exists in newer cores while this package supports
 * `@dudko.dev/agent-web >= 0.0.6`. `useMcp` feature-detects at runtime and
 * reports `oauthSupported: false` on an older core instead of crashing.
 */

export interface McpCatalogEntry {
  name: string
  description: string
  server: string
  /** The server marked the tool read-only (newer cores). */
  readOnly?: boolean
}

export interface McpServerResult {
  name: string
  connected: boolean
  error?: string
  needsAuthorization?: boolean
}

/** The `instructions` one connected server returned in its `initialize` result. */
export interface McpServerInstructions {
  /** The server's name: its key in the configuration. */
  server: string
  instructions: string
}

/**
 * Which revisions of the MCP protocol a connection may use (the core's per-server `protocol`):
 * `'legacy'` (default) the 2025 revisions, `'auto'` 2026-07-28 when the server offers it and the
 * 2025 ones otherwise, `'modern'` 2026-07-28 only.
 */
export type McpProtocolMode = 'legacy' | 'auto' | 'modern'

/** What a connection negotiated with one server. */
export interface McpServerProtocol {
  /** The server's name: its key in the configuration. */
  server: string
  /** The protocol revision in use, e.g. `2025-11-25` or `2026-07-28`. */
  version: string
  era: 'legacy' | 'modern'
}

export interface ConnectedMcp {
  tools: AgentToolSet
  catalog: McpCatalogEntry[]
  results: McpServerResult[]
  /**
   * What each connected server told the agent in its handshake (newer cores; absent on older
   * ones). THIRD-PARTY text: the core puts it in the system prompt of an agent that uses the
   * server's tools, so a host should let the user see it.
   */
  instructions?: McpServerInstructions[]
  /** The protocol revision negotiated with each connected server (cores with `protocol`). */
  protocols?: McpServerProtocol[]
  refreshServer?: (name: string) => Promise<void>
  close: () => Promise<void>
}

export interface McpHttpServerConfig {
  url: string
  headers?: Record<string, string>
  authProvider?: unknown
  /** Per-server connect deadline (newer cores; ignored by older ones). */
  connectTimeoutMs?: number
  /**
   * The MCP protocol revisions this connection may use (newer cores; an older one ignores the
   * field and speaks the 2025 revisions). The hooks set it only for a server that was given a
   * `protocol`. From a page, `'auto'` and `'modern'` need `Mcp-Method` and `Mcp-Name` in the
   * server's `Access-Control-Allow-Headers`.
   */
  protocol?: McpProtocolMode
}

/**
 * One field of a form a server asks the user to fill in (MCP elicitation): the flat subset of
 * JSON Schema the specification allows. The core has already checked, cleaned and capped it.
 */
export interface McpElicitationFieldSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  title?: string
  description?: string
  default?: string | number | boolean | string[]
  minLength?: number
  maxLength?: number
  format?: 'email' | 'uri' | 'date' | 'date-time'
  /** Single-select, plain (`enumNames`: the older titled form). */
  enum?: string[]
  enumNames?: string[]
  /** Single-select with titles. */
  oneOf?: { const: string; title: string }[]
  minimum?: number
  maximum?: number
  /** Multi-select. */
  minItems?: number
  maxItems?: number
  items?: { type?: 'string'; enum?: string[]; anyOf?: { const: string; title: string }[] }
}

/** The form of an elicitation, as the core hands it to a host. */
export interface McpElicitationSchema {
  type: 'object'
  properties: Record<string, McpElicitationFieldSchema>
  required?: string[]
}

/**
 * What the core's `onElicitation` callback is given: an MCP server asks the user for input in
 * the middle of a tool call. Every string in it is the SERVER's text, never instructions.
 */
export interface McpElicitationRequest {
  /** Unique per question; the `mcp.elicitation-*` events carry the same id. */
  id: string
  server: string
  /** The tool call during which the server asks: the tool's name as the model called it. */
  tool: string
  mode: 'form' | 'url'
  message: string
  /** Form mode: the fields to fill in. */
  requestedSchema?: McpElicitationSchema
  /** URL mode: a link the server wants the user to open. The core never opens it. */
  url?: string
  elicitationId?: string
  runId?: string
  /** Set when a helper (a subagent) is the one whose call asks. */
  subagent?: { id: string; depth: number }
}

/** The answer to an elicitation. `accept` carries the form's values (form mode only). */
export type McpElicitationResult =
  | { action: 'accept'; content?: Record<string, string | number | boolean | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' }

/** The core's `onElicitation`. `ctx.signal` aborts when the answer is no longer wanted. */
export type McpElicitationHandler = (
  request: McpElicitationRequest,
  ctx: { signal: AbortSignal },
) => McpElicitationResult | Promise<McpElicitationResult>

/** The core's `elicitation` settings (all optional; see the core's README). */
export interface McpElicitationOptions {
  timeoutMs?: number
  maxPerToolCall?: number
  maxPerRun?: number
  /** Also accept URL mode. Default false. */
  url?: boolean
  /** Let a subagent's call ask the user too. Default false. */
  subagents?: boolean
}

export interface McpOAuthCallback {
  code?: string
  state?: string
  /** The `iss` parameter of the response (RFC 9207); the core checks it. */
  iss?: string
  error?: string
  errorDescription?: string
}

export interface BrowserOAuthProvider {
  serverUrl: string
  authorizationUrl?: URL
  isAuthorized(): Promise<boolean>
  reset(): Promise<void>
}

export interface BrowserOAuthProviderOptions {
  serverUrl: string
  redirectUrl: string
  clientName?: string
  scope?: string
  /** Client ID metadata document URL (CIMD). Cores without it ignore the field. */
  clientMetadataUrl?: string
}

/** The shape of the subpath module, as far as this package uses it. */
export interface McpModule {
  connectMcpHttp: (
    servers: Record<string, McpHttpServerConfig>,
    opts?: {
      clientName?: string
      onLog?: (level: string, message: string) => void
      connectTimeoutMs?: number
      /**
       * Answer a server's question to the user (cores with MCP elicitation; an older core
       * ignores both fields and declares no capability). The hooks set them only when their
       * `elicitation` option is on.
       */
      onElicitation?: McpElicitationHandler
      elicitation?: McpElicitationOptions
    },
  ) => Promise<ConnectedMcp>
  BrowserOAuthProvider?: new (opts: BrowserOAuthProviderOptions) => BrowserOAuthProvider
  readOAuthCallback?: (input?: string | URL) => McpOAuthCallback | undefined
  finishMcpOAuth?: (provider: BrowserOAuthProvider, callback: McpOAuthCallback) => Promise<void>
  /**
   * The SDK's error class, re-exported by the core so an authorization failure
   * can be recognised by identity (`@modelcontextprotocol/client` on a core on
   * the 2.x MCP SDK, `@modelcontextprotocol/sdk` before). Absent on cores older
   * than 0.0.12.
   */
  UnauthorizedError?: new (message?: string) => Error
}
