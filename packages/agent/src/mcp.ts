import {
  auth,
  Client,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type ClientOptions,
  type FetchLike,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type OAuthClientProvider,
  type Transport,
} from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { URL } from 'node:url'
import packageJson from '../package.json' with { type: 'json' }
import { markReadOnly } from './approval.ts'
import { getCurrentRunSandbox, runContext } from './context.ts'
import type { IRunState } from './internal.ts'
import {
  createMcpElicitationSession,
  McpElicitationError,
  resolveMcpElicitationOptions,
  type McpElicitationCallInfo,
  type McpElicitationEvent,
  type McpElicitationHandler,
  type McpElicitationOptions,
  type McpElicitationSession,
} from './mcp-elicitation.ts'
import { assertSecureOAuthUrl } from './mcp-oauth.ts'
import {
  cleanMcpInstructions,
  dropStructuredDuplicates,
  isStructuredContent,
  markMcpTool,
  MCP_MODERN_REFUSED_HINT,
  mcpInputRequiredMessage,
  mcpProtocolMode,
  mcpVersionNegotiation,
  outputSchemaNote,
  withStructuredContent,
  type McpServerInstructions,
  type McpServerProtocol,
} from './mcp-shared.ts'
import { ATTR, withSpan } from './tracing.ts'
import type { EventHandler, IMcpServerConfig } from './types.ts'

const isStdioConfig = (
  cfg: IMcpServerConfig,
): cfg is Extract<IMcpServerConfig, { command: string }> => 'command' in cfg && !!cfg.command

const isHttpConfig = (cfg: IMcpServerConfig): cfg is Extract<IMcpServerConfig, { url: string }> =>
  'url' in cfg && !!cfg.url

const CLIENT_VERSION = (packageJson as { version: string }).version

// Provider-side tool-name limit. OpenAI rejects tool names longer than 64
// chars (regex: ^[a-zA-Z0-9_-]{1,64}$); Anthropic and Gemini are at most as
// permissive. We enforce the same cap on the prefixed `serverName__toolName`
// so a single misconfigured server can't poison the whole run with an
// invalid tool name.
const MAX_TOOL_NAME_LEN = 64

// The same providers also reject anything outside [a-zA-Z0-9_-], and MCP names
// are free to contain dots, slashes or spaces. Map them into the allowed
// alphabet; callTool still uses the ORIGINAL name from the server.
const sanitizeName = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')

// Sanitizing can collapse two distinct names onto one key ("a.b" and "a/b" both
// become "a_b"). Suffix instead of dropping: a tool the model cannot see is a
// silent capability loss.
const uniqueKey = (base: string, taken: ToolSet): string => {
  if (!taken[base]) {
    return base
  }
  for (let n = 2; n < 100; n++) {
    const suffix = `_${n}`
    const candidate = base.slice(0, MAX_TOOL_NAME_LEN - suffix.length) + suffix
    if (!taken[candidate]) {
      return candidate
    }
  }
  return ''
}

/**
 * Raised for a tool result carrying `isError`. `toJSON` matters: the AI SDK
 * puts the thrown value verbatim on the tool-error part, which ends up in
 * `IStepResult.toolCalls[].output` and therefore in whatever an `IPersistence`
 * serialises — and `JSON.stringify(new Error('boom'))` is `{}`, losing the one
 * piece of information the server sent.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolError'
  }

  toJSON(): string {
    return this.message
  }
}

// The subset of the MCP tool descriptor we mount from.
interface IMcpToolDescriptor {
  name: string
  description?: string
  inputSchema: unknown
  outputSchema?: unknown
  annotations?: { readOnlyHint?: boolean }
}

// Default connect + tools/list budget per server.
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000
// tools/list pagination cap: a server returning a cursor forever must not
// hang the connect.
export const MAX_TOOL_LIST_PAGES = 100
// `protocol: 'auto' | 'modern'` over stdio: how long the `server/discover`
// probe waits. A 2025 stdio server may never answer a request it does not know
// before `initialize`; the SDK reads that silence as "legacy" - after this long
// (its own default is the request timeout, a minute: past the connect budget).
export const MCP_STDIO_PROBE_TIMEOUT_MS = 5_000
// 2026-07-28: how long the `subscriptions/listen` stream may take to be
// acknowledged before the connect goes on without tool-list change notices.
export const MCP_LISTEN_ACK_TIMEOUT_MS = 10_000
// The longest delay a timer takes (2^31 - 1 ms): the SDK's own request timeout is set to it for
// a 2025 tool call that may ask the user something, whose time is kept by the elicitation
// session instead (it does not count the time a question waits).
const MAX_TIMER_MS = 2_147_483_647

// The run's count of questions asked of the user, kept on the state of the run the HOST started:
// a helper's calls count on the same number.
const elicitationCounter = (state: IRunState | undefined): { count: number } | undefined => {
  if (!state) {
    return undefined
  }
  let root = state
  while (root.spawn?.parent) {
    root = root.spawn.parent
  }
  root.elicitations ??= { count: 0 }
  return root.elicitations
}

/** The SDK's typed error with this code (by name too: a second copy of the SDK is another class). */
const isSdkError = (err: unknown, code: SdkErrorCode): boolean =>
  (err instanceof SdkError || (err instanceof Error && err.name === 'SdkError')) &&
  (err as { code?: unknown }).code === code

/**
 * Every tool of a server, following `nextCursor` (up to MAX_TOOL_LIST_PAGES
 * pages; a repeated cursor ends the walk).
 *
 * Page by page through `client.request`, not `client.listTools()`: called
 * without a cursor, the typed verb of the 2.x SDK walks every page itself,
 * throws past its own page cap, answers without asking when the server did not
 * advertise the tools capability, and fills the cache that switches on the
 * SDK's output-schema check in `callTool` (which this module does itself, see
 * `outputSchemaViolation`). The raw request does none of that.
 */
export const listAllTools = async (
  client: Pick<Client, 'request'>,
  onTruncated?: () => void,
): Promise<IMcpToolDescriptor[]> => {
  const all: IMcpToolDescriptor[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
    const r = await client.request({
      method: 'tools/list',
      params: cursor ? { cursor } : undefined,
    })
    all.push(...(r.tools as IMcpToolDescriptor[]))
    const next = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined
    if (!next || seen.has(next)) {
      return all
    }
    seen.add(next)
    cursor = next
  }
  onTruncated?.()
  return all
}

/** The longest compile error repeated in a refusal (the SDK clips at the same length). */
const OUTPUT_SCHEMA_ERROR_MAX_CHARS = 200

/**
 * Why a tool result does not follow the `outputSchema` its tool declared, or
 * `undefined` when it does. The rule and the wording are those of the SDK's
 * `Client.callTool`: a tool with an output schema must answer with
 * `structuredContent`, and that value must validate. An `isError` result is
 * not checked.
 *
 * The check is made here, on a result that was received, instead of inside
 * `callTool`, which throws on a violation and takes the result with it: the
 * call RAN on the server, so its result goes to the model with a note.
 */
export const outputSchemaViolation = (
  toolName: string,
  result: Pick<CallToolResult, 'structuredContent' | 'isError'>,
  validate: JsonSchemaValidator<unknown>,
): string | undefined => {
  if (result.isError === true) {
    return undefined
  }
  if (result.structuredContent === undefined) {
    return `Tool ${toolName} has an output schema but did not return structured content`
  }
  try {
    const checked = validate(result.structuredContent)
    return checked.valid
      ? undefined
      : `Structured content does not match the tool's output schema: ${checked.errorMessage}`
  } catch (err) {
    return `Failed to validate structured content: ${err instanceof Error ? err.message : String(err)}`
  }
}

interface IServerConnect {
  name: string
  client?: Client
  // What the server said in its initialize result ('' when nothing).
  instructions?: string
  // The revision the connection negotiated.
  protocol?: Omit<McpServerProtocol, 'server'>
  listed?: IMcpToolDescriptor[]
  error?: string
  needsAuthorization?: boolean
}

/**
 * The enterprise-managed provider (`mcp-enterprise-oauth.ts`), recognised by
 * shape so a host's own subclass or a copy from another realm still counts.
 */
type EnterpriseLog = (level: 'info' | 'warn' | 'error', message: string) => void

interface EnterpriseProviderShape {
  extension: string
  authorize: (opts: { fetch?: FetchLike; onLog?: EnterpriseLog }) => Promise<void>
  transportFetch: (base?: FetchLike, log?: EnterpriseLog) => FetchLike
}

const asEnterpriseProvider = (
  provider: OAuthClientProvider,
): EnterpriseProviderShape | undefined => {
  const p = provider as Partial<Record<keyof EnterpriseProviderShape, unknown>>
  return typeof p.extension === 'string' &&
    typeof p.authorize === 'function' &&
    typeof p.transportFetch === 'function'
    ? (provider as unknown as EnterpriseProviderShape)
    : undefined
}

/** Thrown by the refresh-only view when the SDK reaches for a redirect. */
class RefreshOnlyAbort extends Error {}

/**
 * A view of the provider that can renew a token but can never start an
 * interactive authorization.
 *
 * `auth()` has no refresh-only mode: when a refresh fails for a reason it deems
 * recoverable (a 5xx from the token endpoint, a network blip) it falls straight
 * through to a brand-new authorization — issuing a state and a PKCE verifier,
 * overwriting the stored pair, and calling `redirectToAuthorization`. So a
 * 30-second outage at the authorization server would tell an operator to
 * re-authorize a session whose refresh token is perfectly good, and the
 * transport's own `auth()` on the first 401 would then overwrite that state
 * again, leaving the operator with a code the stored pair cannot verify.
 * Blocking the three redirect-path methods aborts the escalation before
 * anything is overwritten.
 */
const refreshOnly = (p: OAuthClientProvider): OAuthClientProvider => ({
  // Must stay truthy: `auth()` reads a missing redirectUrl as "non-interactive
  // grant" and would try to fetch a token without one.
  get redirectUrl() {
    return p.redirectUrl
  },
  get clientMetadata() {
    return p.clientMetadata
  },
  get clientMetadataUrl() {
    return p.clientMetadataUrl
  },
  // The second argument is the authorization server the SDK resolved: a
  // provider that keeps credentials per issuer reads and writes by it.
  clientInformation: (ctx) => p.clientInformation(ctx),
  saveClientInformation: p.saveClientInformation?.bind(p),
  tokens: (ctx) => p.tokens(ctx),
  saveTokens: (t, ctx) => p.saveTokens(t, ctx),
  invalidateCredentials: p.invalidateCredentials?.bind(p),
  addClientAuthentication: p.addClientAuthentication?.bind(p),
  validateResourceURL: p.validateResourceURL?.bind(p),
  // What a refresh request is made of, when the provider says so.
  scopeForRefresh: p.scopeForRefresh?.bind(p),
  dpop: p.dpop?.bind(p),
  codeVerifier: () => p.codeVerifier(),
  state: () => {
    throw new RefreshOnlyAbort()
  },
  saveCodeVerifier: () => {
    throw new RefreshOnlyAbort()
  },
  redirectToAuthorization: () => {
    throw new RefreshOnlyAbort()
  },
})

/**
 * An access token that is already expired produces a guaranteed 401 on the
 * first request. When the provider can tell us so AND we hold a refresh token,
 * renew before connecting: one round-trip saved, and a run doesn't open with a
 * spurious auth failure.
 *
 * Best-effort by design — anything that goes wrong here is left to the
 * transport's own 401 handling, which is the single owner of asking a human to
 * authorize again.
 */
const refreshIfExpired = async (
  provider: OAuthClientProvider,
  serverUrl: string,
  fetchFn: FetchLike | undefined,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  name: string,
): Promise<void> => {
  const check = (provider as { isAccessTokenExpired?: () => boolean | Promise<boolean> })
    .isAccessTokenExpired
  if (typeof check !== 'function') {
    return
  }
  if (!(await check.call(provider))) {
    return
  }
  const enterprise = asEnterpriseProvider(provider)
  if (enterprise) {
    // No human step and no refresh token (the ID-JAG replaces it): get the
    // token now. A refusal by the IdP or the authorization server is final -
    // asking again through the 401 path would only repeat the exchange - so it
    // fails this server with the error that names who refused. Only a
    // discovery failure is left to the transport: the server's 401 may say
    // where its metadata lives, or it may need no authorization at all.
    try {
      await enterprise.authorize({ fetch: fetchFn, onLog: log })
    } catch (err) {
      if ((err as { hop?: unknown })?.hop !== 'discovery') {
        throw err
      }
      log('info', `[mcp] ${name}: ${(err as Error).message}; continuing`)
    }
    return
  }
  const tokens = await provider.tokens()
  if (!tokens?.refresh_token) {
    return
  }
  try {
    await auth(refreshOnly(provider), { serverUrl, fetchFn })
  } catch (err) {
    log(
      'info',
      err instanceof RefreshOnlyAbort
        ? `[mcp] ${name}: the stored token could not be refreshed; a new authorization is needed`
        : `[mcp] ${name}: proactive token refresh failed (${(err as Error).message}); continuing`,
    )
  }
}

export interface IConnectedMcp {
  // Live, mutable maps. When a server pushes notifications/tools/list_changed
  // and the agent calls refreshServer(), entries for that server are rewritten
  // in place. Callers should always read through these references rather than
  // caching their own snapshot.
  tools: ToolSet
  catalog: { name: string; description: string; server: string; readOnly?: boolean }[]
  close: () => Promise<void>
  // Per-server connect outcome so the caller can decide whether to fail hard
  // (e.g. when every configured server failed and the agent would otherwise
  // start with zero tools). `needsAuthorization` marks the one failure a host
  // can actually act on: the server wants OAuth and the configured
  // authProvider has no usable token yet.
  results: { name: string; connected: boolean; error?: string; needsAuthorization?: boolean }[]
  // The `instructions` each connected server returned in its initialize
  // result, in declaration order; servers that sent none are absent. Read once
  // per connection: a transport-level reconnect does not change it. Third-party
  // text - render it with renderMcpInstructions, never as the operator's own.
  instructions: McpServerInstructions[]
  // The protocol revision negotiated with each connected server, in
  // declaration order: `2025-…` after the `initialize` handshake (always, for
  // a server without `protocol`), `2026-07-28` when `protocol: 'auto'` or
  // `'modern'` found a server that offers it. Fixed for the life of the
  // connection.
  protocols: McpServerProtocol[]
  // Re-fetch one server's tool list and rewrite its entries in tools/catalog.
  // Throws if the server is not connected.
  refreshServer: (name: string) => Promise<void>
}

export const connectMcpServers = async (
  servers: Record<string, IMcpServerConfig>,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  clientName: string,
  outputSanitizer?: (toolName: string, output: unknown) => unknown | Promise<unknown>,
  // Fires when an MCP server pushes notifications/tools/list_changed. The
  // handler MUST NOT mutate tools/catalog directly (a run may be in flight
  // and reading ctx.tools); instead it should schedule a deferred
  // refreshServer() call from a safe quiescent point.
  onToolsChanged?: (server: string) => void,
  // Sanitizes args before they reach the MCP server (and after the executor
  // already sanitized them for event emission - idempotency is documented
  // and required).
  inputSanitizer?: (toolName: string, input: unknown) => unknown | Promise<unknown>,
  options: {
    // Default per-server connect + tools/list budget (a server's own
    // connectTimeoutMs wins). Default 30_000; 0 disables.
    connectTimeoutMs?: number
    // Elicitation: a server may ask the user for input during a tool call, and
    // this callback answers. Without it nothing is declared and nothing is
    // sent that was not sent before (see mcp-elicitation.ts).
    onElicitation?: McpElicitationHandler
    elicitation?: McpElicitationOptions
    // Where the elicitation events of a tool called outside a run go.
    emit?: EventHandler
  } = {},
): Promise<IConnectedMcp> => {
  // Read first: a setting that is not a usable number is a configuration error.
  const elicitationOptions = resolveMcpElicitationOptions(options.elicitation)
  const elicitationDeps = options.onElicitation
    ? { handler: options.onElicitation, options: elicitationOptions, log }
    : undefined
  // One per server, made before its client: the capability it declares is part
  // of the handshake.
  const elicitationSessions = new Map<string, McpElicitationSession>()
  const elicitationSessionOf = (name: string): McpElicitationSession | undefined => {
    if (!elicitationDeps) {
      return undefined
    }
    let session = elicitationSessions.get(name)
    if (!session) {
      session = createMcpElicitationSession(name, elicitationDeps)
      elicitationSessions.set(name, session)
    }
    return session
  }
  const clients = new Map<string, Client>()
  const tools: ToolSet = {}
  const catalog: IConnectedMcp['catalog'] = []
  const results: IConnectedMcp['results'] = []
  const instructions: McpServerInstructions[] = []
  const instructionsOf = new Map<string, string>()
  const protocols: McpServerProtocol[] = []
  let closing = false
  // server name -> the tool keys it currently owns, so a refresh removes
  // exactly its own entries.
  const mountedKeys = new Map<string, string[]>()

  const mountServerTools = (name: string, client: Client, listed: IMcpToolDescriptor[]): void => {
    const serverPrefix = `${sanitizeName(name)}__`
    // Drop existing entries for this server before re-listing. We mutate in
    // place so external references to `tools` and `catalog` stay valid.
    //
    // Delete the keys this server actually mounted, NOT everything sharing its
    // prefix: sanitizing can make two server names collapse onto one prefix
    // ("a.b" and "a/b"), and one server's prefix can nest inside another's
    // ("a" and "a__b"). A prefix sweep would unmount a DIFFERENT server's
    // tools while leaving its catalogue rows behind.
    for (const k of mountedKeys.get(name) ?? []) {
      delete tools[k]
    }
    for (let i = catalog.length - 1; i >= 0; i--) {
      if (catalog[i].server === name) {
        catalog.splice(i, 1)
      }
    }
    const keys: string[] = []
    // The SDK's own validator (Ajv, dialect by `$schema`), one per mount: a
    // schema with an `$id` is remembered by the instance that compiled it, so
    // it is never shared between servers nor kept across a refresh.
    let schemaValidator: AjvJsonSchemaValidator | undefined

    let mounted = 0
    let skipped = 0
    for (const t of listed) {
      const candidate = serverPrefix + sanitizeName(t.name)
      if (candidate.length > MAX_TOOL_NAME_LEN) {
        log(
          'warn',
          `[mcp] ${name}: tool "${t.name}" prefixed name (${candidate.length} chars) exceeds the ${MAX_TOOL_NAME_LEN}-char limit enforced by major LLM providers; skipping`,
        )
        skipped++
        continue
      }
      const prefixed = uniqueKey(candidate, tools)
      if (!prefixed) {
        log('warn', `[mcp] ${name}: no free name left for tool "${t.name}"; skipping`)
        skipped++
        continue
      }
      if (prefixed !== candidate) {
        log(
          'warn',
          `[mcp] ${name}: tool name "${candidate}" already taken; mounted as "${prefixed}"`,
        )
      }
      const description = t.description ?? ''
      const readOnly = t.annotations?.readOnlyHint === true
      // Compiled on the first call, as the SDK does, and once per mount.
      let outputValidator: JsonSchemaValidator<unknown> | undefined
      const outputValidatorOf = (): JsonSchemaValidator<unknown> | undefined => {
        if (!t.outputSchema || outputValidator) {
          return outputValidator
        }
        try {
          schemaValidator ??= new AjvJsonSchemaValidator()
          outputValidator = schemaValidator.getValidator(t.outputSchema as JsonSchemaType)
        } catch (err) {
          // Before anything is sent, so nothing ran on the server: a schema
          // that cannot be compiled is refused as the SDK refuses it, and never
          // silently skipped.
          const reason = (err instanceof Error ? err.message : String(err)).slice(
            0,
            OUTPUT_SCHEMA_ERROR_MAX_CHARS,
          )
          throw new McpToolError(`Tool '${t.name}' has an invalid outputSchema: ${reason}`)
        }
        return outputValidator
      }
      tools[prefixed] = dynamicTool({
        description,
        inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (args, opts) =>
          withSpan(
            'agent.tool_call',
            { [ATTR.TOOL_NAME]: prefixed },
            async (span): Promise<unknown> => {
              let toSend: Record<string, unknown> = (args ?? {}) as Record<string, unknown>
              if (inputSanitizer) {
                try {
                  const sanitized = await inputSanitizer(prefixed, toSend)
                  // The sanitizer can return any shape; coerce non-objects to a
                  // wrapper so the MCP "arguments" field stays a JSON object.
                  toSend =
                    sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
                      ? (sanitized as Record<string, unknown>)
                      : { value: sanitized }
                } catch (err) {
                  log(
                    'warn',
                    `[mcp] ${prefixed}: inputSanitizer threw - ${(err as Error).message}; input replaced with placeholder`,
                  )
                  toSend = { _redacted: 'inputSanitizer failed' }
                }
              }
              let validate: JsonSchemaValidator<unknown> | undefined
              let result: CallToolResult
              const elicitation = elicitationSessionOf(name)
              try {
                validate = outputValidatorOf()
                // `client.request`, not `client.callTool`: the typed verb also
                // checks the result against the tool's outputSchema and throws
                // when it does not fit - taking with it a result that DID
                // arrive. The request is the same on the wire, in both eras:
                // on 2026-07-28 the transport derives `Mcp-Method` and
                // `Mcp-Name` from the message itself, whoever built it. Only
                // the `Mcp-Param-*` headers are the typed verb's own - a
                // mirror of arguments a tool marked with `x-mcp-header`, for
                // intermediaries; this client does not send them.
                if (elicitation) {
                  // The server may ask the user something during this call
                  // (`onElicitation`). The session answers - on the 2025
                  // revisions a request of the server's own, on 2026-07-28 an
                  // `input_required` result followed by the same call sent
                  // again with the answers and the server's state - and keeps
                  // the caps; see mcp-elicitation.ts.
                  const store = runContext.getStore()
                  const emit = store?.emit ?? options.emit
                  const step = store?.currentStep
                  const scope = store?.state?.spawn
                  const run = elicitationCounter(store?.state)
                  const era = client.getProtocolEra() ?? 'legacy'
                  const info: McpElicitationCallInfo = {
                    tool: prefixed,
                    toolName: t.name,
                    ...(opts?.abortSignal ? { signal: opts.abortSignal } : {}),
                    ...(emit
                      ? {
                          emit: (event: McpElicitationEvent) =>
                            emit(
                              event.type === 'mcp.elicitation-requested' && step
                                ? { ...event, step }
                                : event,
                            ),
                        }
                      : {}),
                    ...(store?.runId ? { runId: store.runId } : {}),
                    // A call made by a helper the model started says so: it may
                    // ask the user only when the host allowed that.
                    ...(scope?.id ? { subagent: { id: scope.id, depth: scope.depth } } : {}),
                    ...(run ? { run } : {}),
                    // While the user is asked, the step's time limit does not run.
                    ...(store?.state?.clock ? { pause: store.state.clock.pause } : {}),
                  }
                  result = await elicitation.call(
                    era,
                    info,
                    (leg) =>
                      client.request(
                        {
                          method: 'tools/call',
                          params: { name: t.name, arguments: toSend, ...leg.retry },
                        },
                        {
                          ...(leg.signal ? { signal: leg.signal } : {}),
                          ...(leg.ownTimeout ? { timeout: MAX_TIMER_MS } : {}),
                          // Hand an `input_required` result back instead of
                          // failing on it: the session answers it.
                          ...(era === 'modern' ? { allowInputRequired: true } : {}),
                        },
                      ) as Promise<CallToolResult>,
                  )
                } else {
                  result = await client.request(
                    { method: 'tools/call', params: { name: t.name, arguments: toSend } },
                    opts?.abortSignal ? { signal: opts.abortSignal } : undefined,
                  )
                }
              } catch (err) {
                // The request itself failed (transport, protocol, abort), or
                // was never sent: there is no result. The AI SDK records the
                // throw as a failed call.
                span.setAttribute(ATTR.TOOL_OK, false)
                // 2026-07-28: the server answered `input_required` (it wants
                // the user asked something, or the call sent again with a
                // state). Not supported here, and the call is not repeated.
                if (isSdkError(err, SdkErrorCode.UnsupportedResultType)) {
                  throw new McpToolError(mcpInputRequiredMessage(t.name))
                }
                // A question of this call was answered without the host
                // deciding (a guard, a cap, a timeout, a failed handler): the
                // call fails with the reason, and was not sent again.
                if (err instanceof McpElicitationError) {
                  throw new McpToolError(err.message)
                }
                throw err
              }
              // A result arrived. When it does not follow the tool's
              // outputSchema (no structuredContent, or one that does not
              // match) it is passed on with a note rather than reported as a
              // failure - a tool the model is told failed is a tool it calls
              // again, and this one may write.
              let schemaNote: string | undefined
              const violation = validate && outputSchemaViolation(t.name, result, validate)
              if (violation) {
                schemaNote = outputSchemaNote(t.name, violation)
                log(
                  'warn',
                  `[mcp] ${prefixed}: result does not follow the declared outputSchema - ${violation}; passed on with a note`,
                )
              }
              // outputSanitizer runs BEFORE flattenContent so the user can
              // redact the raw MCP content (including image/audio base64 data
              // that would otherwise be spilled to disk before sanitisation).
              // Caller wanting post-spill redaction can sanitise the file path
              // they receive in the model-facing output - this order favors
              // privacy by default.
              // An MCP failure is a NORMAL response carrying isError, not a
              // transport error. It has to end in a throw so the AI SDK records
              // a failed tool call (ok: false) instead of feeding the error
              // text to the model as a successful result — which is also what
              // keeps replanAfter: 'failure' able to see it. Read the flag
              // before sanitisation, so a sanitizer that throws cannot turn a
              // failure back into a success.
              const isError = result.isError === true
              // structuredContent is read for a successful result only: an
              // error keeps reaching the model as the text it always was.
              let structured: unknown =
                !isError && isStructuredContent(result.structuredContent)
                  ? result.structuredContent
                  : undefined
              // A server that returns structured content also sends it
              // serialized as text (the specification's backwards-compatible
              // form); the model must not get the same data twice.
              let raw: unknown =
                structured === undefined
                  ? result.content
                  : dropStructuredDuplicates(result.content, structured)
              if (outputSanitizer) {
                try {
                  // The structured value is model-facing output too: it goes
                  // through the sanitizer in a call of its own (an object, not
                  // the content array), or it would be a way around redaction.
                  if (structured === undefined || !(Array.isArray(raw) && raw.length === 0)) {
                    raw = await outputSanitizer(prefixed, raw)
                  }
                  if (structured !== undefined) {
                    structured = await outputSanitizer(prefixed, structured)
                  }
                } catch (err) {
                  log(
                    'warn',
                    `[mcp] ${prefixed}: outputSanitizer threw - ${(err as Error).message}; output replaced with placeholder`,
                  )
                  span.setAttribute(ATTR.TOOL_OK, false)
                  if (isError) {
                    throw new McpToolError('[output redacted: sanitizer failed]')
                  }
                  return '[output redacted: sanitizer failed]'
                }
              }
              const flat = await flattenContent(raw, {
                toolName: prefixed,
                // Resolved per-call so concurrent runs spill into their own
                // per-runId subdirs. undefined when called outside of a run
                // (defensive; in practice every tool call sits inside runAgentLoop).
                // Failed calls never spill: the files would be orphaned, since
                // the model only ever sees the thrown message.
                sandboxDir: isError ? undefined : getCurrentRunSandbox(),
              })
              if (isError) {
                span.setAttribute(ATTR.TOOL_OK, false)
                const text = typeof flat === 'string' ? flat : JSON.stringify(flat)
                throw new McpToolError(
                  text && text !== '[]'
                    ? text
                    : `MCP tool "${t.name}" reported an error with no content`,
                )
              }
              span.setAttribute(ATTR.TOOL_OK, true)
              return withStructuredContent(flat, structured, schemaNote)
            },
          ),
      })
      if (readOnly) {
        markReadOnly(tools[prefixed])
      }
      // Which server the tool came from, and that server's instructions: the
      // agent shows the notes of the servers whose tools it actually mounts.
      markMcpTool(tools[prefixed], name, instructionsOf.get(name))
      catalog.push({ name: prefixed, description, server: name, readOnly })
      keys.push(prefixed)
      mounted++
    }
    mountedKeys.set(name, keys)
    if (skipped > 0) {
      log('info', `[mcp] ${name}: ${mounted} tools mounted, ${skipped} skipped (length cap)`)
    } else {
      log('info', `[mcp] ${name}: ${mounted} tools mounted`)
    }
  }

  const listServerTools = (name: string, client: Client): Promise<IMcpToolDescriptor[]> =>
    listAllTools(client, () =>
      log(
        'warn',
        `[mcp] ${name}: tools/list still paginating after ${MAX_TOOL_LIST_PAGES} pages; the rest is ignored`,
      ),
    )

  const registerServerTools = async (name: string, client: Client): Promise<void> => {
    mountServerTools(name, client, await listServerTools(name, client))
  }

  const openConnection = async (name: string, cfg: IMcpServerConfig): Promise<IServerConnect> => {
    const configured = cfg.connectTimeoutMs ?? options.connectTimeoutMs
    const timeoutMs =
      typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
        ? configured
        : DEFAULT_MCP_CONNECT_TIMEOUT_MS
    // `client` is shared with the watchdog below: a connect that times out
    // closes whatever client it got as far as creating, and an attempt that
    // completes AFTER the timeout closes its own client instead of mounting.
    let client: Client | undefined
    let timedOut = false
    const attempt = connectOnce(
      name,
      cfg,
      (c) => {
        client = c
      },
      () => timedOut,
      timeoutMs,
    )
    try {
      return await (timeoutMs > 0
        ? withConnectTimeout(attempt, timeoutMs, () => {
            timedOut = true
          })
        : attempt)
    } catch (err) {
      // The client may be live even though we ended up here (listTools failing
      // after a successful connect, or the watchdog firing). Close it, or the
      // transport - an SSE stream or a spawned child process - outlives the
      // failed connect.
      if (client) {
        await (client as Client).close().catch(() => {})
      }
      let message = timedOut ? `connect timed out after ${timeoutMs}ms` : (err as Error).message
      // `protocol: 'modern'` against a server that did not offer the revision:
      // the SDK's sentence, plus which option to turn.
      if (
        !timedOut &&
        cfg.protocol === 'modern' &&
        isSdkError(err, SdkErrorCode.EraNegotiationFailed)
      ) {
        message = `${message} - ${MCP_MODERN_REFUSED_HINT}`
      }
      const needsAuthorization = !timedOut && err instanceof UnauthorizedError
      log(
        'error',
        needsAuthorization
          ? `[mcp] ${name}: authorization required - complete the OAuth flow and reconnect`
          : `[mcp] ${name}: failed to connect - ${message}`,
      )
      return { name, error: message, needsAuthorization }
    }
  }

  // 2026-07-28: ask the server for tool-list change notices. Best effort - a
  // server that does not announce them, or a stream that cannot be opened,
  // leaves a connection whose tools still work; `refreshServer` still re-lists.
  const listenForToolChanges = async (name: string, client: Client): Promise<void> => {
    if (!client.getServerCapabilities()?.tools?.listChanged) {
      log('info', `[mcp] ${name}: the server does not announce tool list changes`)
      return
    }
    try {
      const subscription = await client.listen(
        { toolsListChanged: true },
        { timeout: MCP_LISTEN_ACK_TIMEOUT_MS },
      )
      // The SDK does not open the stream again, and neither does this
      // connector: say so, or the silence reads as "nothing changed".
      void subscription.closed.then((cause) => {
        if (!closing) {
          log(
            'warn',
            `[mcp] ${name}: the tool list change stream ended (${cause === 'graceful' ? 'closed by the server' : 'dropped'}); changes are not announced until the server is connected again`,
          )
        }
      })
    } catch (err) {
      log(
        'warn',
        `[mcp] ${name}: could not subscribe to tool list changes - ${(err as Error).message}`,
      )
    }
  }

  const connectOnce = async (
    name: string,
    cfg: IMcpServerConfig,
    onClient: (client: Client) => void,
    isTimedOut: () => boolean,
    timeoutMs: number,
  ): Promise<IServerConnect> => {
    // Read first: a `protocol` that is none of the three names is a
    // configuration error, said before anything is started.
    const mode = mcpProtocolMode(cfg.protocol, name)
    let client: Client | undefined
    const bail = async (): Promise<void> => {
      if (isTimedOut()) {
        await client?.close().catch(() => {})
        throw new Error('connect timed out')
      }
    }
    try {
      let transport: Transport
      if (isStdioConfig(cfg)) {
        // stdio: spawn the configured executable; the SDK pipes JSON-RPC
        // over the child's stdin/stdout.
        //
        // Env merge: the SDK replaces (does NOT merge) when `env` is given,
        // which means a user passing { DEBUG: '1' } loses PATH, HOME, etc.
        // and the child can't find binaries on PATH. We merge here on top
        // of getDefaultEnvironment() (the safe inheritance subset) so user
        // additions are additive, not replacing.
        const mergedEnv = cfg.env ? { ...getDefaultEnvironment(), ...cfg.env } : undefined
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: mergedEnv,
          cwd: cfg.cwd,
        })
      } else if (isHttpConfig(cfg)) {
        if (cfg.headers && cfg.getHeaders) {
          throw new Error(`MCP server "${name}": specify either headers or getHeaders, not both`)
        }
        const headers = cfg.getHeaders ? await cfg.getHeaders() : cfg.headers
        if (cfg.authProvider) {
          if (headers && 'Authorization' in headers) {
            log(
              'warn',
              `[mcp] ${name}: an explicit Authorization header shadows the OAuth token from authProvider`,
            )
          }
          // The provider guards its own serverUrl, but the transport talks to
          // cfg.url — guard that too, or a config pairing an https provider
          // with an http endpoint posts bearer tokens in cleartext.
          assertSecureOAuthUrl(cfg.url, `MCP server "${name}"`)
          await refreshIfExpired(cfg.authProvider, cfg.url, cfg.fetch, log, name)
        }
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: headers ? { headers } : undefined,
          // With an authProvider the SDK attaches the access token, refreshes
          // it on a 401 and retries the request - the one thing a static
          // header can never do.
          authProvider: cfg.authProvider,
          // A 403 `insufficient_scope` in the middle of a session. A provider
          // without a human step (no `redirectUrl`: the enterprise one, client
          // credentials) may ask again for the wider scope, once per request -
          // the SDK's cap. One WITH a human step never does: the SDK would
          // skip the refresh and start a new authorization from inside a tool
          // call, replacing the stored state and PKCE verifier each time the
          // model tried the tool again. The call fails with the scope the
          // server asked for, and the host decides.
          onInsufficientScope: cfg.authProvider?.redirectUrl ? 'throw' : 'reauthorize',
          // The enterprise provider reports a refused grant itself: a short
          // typed error for the caller, the server's words (redacted) to the log.
          fetch:
            (cfg.authProvider &&
              asEnterpriseProvider(cfg.authProvider)?.transportFetch(cfg.fetch, log)) ||
            cfg.fetch,
          // Built-in reconnect for transient SSE drops. Defaults are conservative;
          // production deployments should tune via direct transport access if needed.
          reconnectionOptions: {
            maxReconnectionDelay: 30_000,
            initialReconnectionDelay: 1_000,
            reconnectionDelayGrowFactor: 1.5,
            maxRetries: 5,
          },
        })
      } else {
        throw new Error(
          `MCP server "${name}": config must specify either { url } (HTTP) or { command } (stdio)`,
        )
      }
      // 'auto' asks a question a 2025 server answers with an HTTP error: that
      // answer is the expected "no", not a fault of the connection.
      let probing = mode === 'auto'
      transport.onerror = (err) =>
        probing
          ? log('info', `[mcp] ${name}: version probe (server/discover) - ${err.message}`)
          : log('warn', `[mcp] ${name}: transport error - ${err.message}`)
      transport.onclose = () => log('warn', `[mcp] ${name}: transport closed`)

      await bail()
      const enterprise =
        isHttpConfig(cfg) && cfg.authProvider ? asEnterpriseProvider(cfg.authProvider) : undefined
      // Without `protocol` (or with 'legacy') nothing is added here: the
      // client is built with exactly the options it always had.
      const negotiation = mcpVersionNegotiation(
        mode,
        // Over stdio a silent server is a 2025 one, after this long.
        isStdioConfig(cfg)
          ? Math.min(MCP_STDIO_PROBE_TIMEOUT_MS, timeoutMs > 0 ? timeoutMs / 2 : Infinity)
          : undefined,
      )
      // Only with `onElicitation`: without a handler no capability is declared,
      // and a server cannot ask.
      const elicitation = elicitationSessionOf(name)
      const clientOptions: ClientOptions | undefined =
        enterprise || negotiation || elicitation
          ? {
              // An extension is opt-in: it is declared only by the client that uses it.
              ...(enterprise || elicitation
                ? {
                    capabilities: {
                      ...(enterprise ? { extensions: { [enterprise.extension]: {} } } : {}),
                      ...(elicitation ? { elicitation: elicitation.capability } : {}),
                    },
                  }
                : {}),
              ...(negotiation
                ? {
                    versionNegotiation: negotiation,
                    // 2026-07-28: an `input_required` result is NOT answered and
                    // the call is NOT sent again by the SDK (its default would
                    // try both). Without `onElicitation` it fails the tool call;
                    // with it, `execute` answers it through the session, which
                    // keeps the caps the SDK's own loop does not have.
                    inputRequired: { autoFulfill: false },
                  }
                : {}),
            }
          : undefined
      client = new Client({ name: clientName, version: CLIENT_VERSION }, clientOptions)
      if (elicitation) {
        // 2025 revisions: the server's question is a request of its own. (On
        // 2026-07-28 the SDK drops inbound requests; the question is then the
        // tool call's `input_required` result.)
        client.setRequestHandler('elicitation/create', (request) =>
          elicitation.onRequest(request.params),
        )
      }
      onClient(client)
      await client.connect(transport)
      probing = false
      await bail()
      const era = client.getProtocolEra() ?? 'legacy'
      const version = client.getNegotiatedProtocolVersion() ?? ''
      if (mode !== 'legacy') {
        log(
          'info',
          `[mcp] ${name}: protocol ${version} (${era === 'modern' ? 'modern: stateless, no session' : 'legacy: the initialize handshake'}; configured '${mode}')`,
        )
      }

      // Subscribe BEFORE the first list call: a server that mutates its tool
      // set during init would otherwise lose the notification in the small
      // window between connect() and listTools().
      if (onToolsChanged) {
        client.setNotificationHandler('notifications/tools/list_changed', () => {
          onToolsChanged(name)
        })
        // 2026-07-28 has no stream a server may write to unasked: the notice
        // above arrives only on a `subscriptions/listen` stream the client
        // opens. (The 2025 revisions send it on the GET stream the transport
        // opens by itself.)
        if (era === 'modern') {
          await listenForToolChanges(name, client)
          await bail()
        }
      }

      const listed = await listServerTools(name, client)
      await bail()
      // Read once, here: the text is fixed for the life of this connection.
      return {
        name,
        client,
        listed,
        instructions: cleanMcpInstructions(client.getInstructions()),
        protocol: { version, era },
      }
    } catch (err) {
      if (client) {
        await client.close().catch(() => {})
      }
      throw err
    }
  }

  // Servers connect concurrently (a slow or hanging server no longer delays
  // every server after it), but mount in declaration order so the resulting
  // tool set and catalogue stay deterministic.
  const opened = await Promise.all(
    Object.entries(servers).map(([name, cfg]) => openConnection(name, cfg)),
  )

  for (const server of opened) {
    if (!server.client || !server.listed) {
      results.push({
        name: server.name,
        connected: false,
        error: server.error,
        ...(server.needsAuthorization ? { needsAuthorization: true } : {}),
      })
      continue
    }
    clients.set(server.name, server.client)
    if (server.instructions) {
      log(
        'info',
        `[mcp] ${server.name}: the server sent instructions (${server.instructions.length} chars)`,
      )
      instructions.push({ server: server.name, instructions: server.instructions })
      instructionsOf.set(server.name, server.instructions)
    }
    if (server.protocol) {
      protocols.push({ server: server.name, ...server.protocol })
    }
    mountServerTools(server.name, server.client, server.listed)
    results.push({ name: server.name, connected: true })
  }

  return {
    tools,
    catalog,
    results,
    instructions,
    protocols,
    close: async () => {
      closing = true
      await Promise.allSettled([...clients.values()].map((c) => c.close()))
    },
    refreshServer: async (name: string) => {
      const client = clients.get(name)
      if (!client) {
        throw new Error(`MCP server "${name}" is not connected`)
      }
      await registerServerTools(name, client)
    },
  }
}

// Race a connect attempt against a watchdog. The attempt keeps running in
// the background after a timeout (its own checks close the client), so its
// eventual rejection is swallowed here.
const withConnectTimeout = <T>(
  attempt: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error(`connect timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    attempt.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })

// Map common MCP mimeTypes to file extensions. Falls back to a generic
// extension keyed by the part kind so the file at least carries a hint for
// downstream tools.
const FALLBACK_EXT = { image: '.bin', audio: '.bin', resource: '.bin' } as const

const extFromMime = (mime: string | undefined, kind: keyof typeof FALLBACK_EXT): string => {
  if (!mime) {
    return FALLBACK_EXT[kind]
  }
  const slash = mime.indexOf('/')
  const sub = slash >= 0 ? mime.slice(slash + 1) : mime
  const cleaned = sub.split(';')[0].trim().toLowerCase()
  if (!cleaned || /[^a-z0-9.+-]/.test(cleaned)) {
    return FALLBACK_EXT[kind]
  }
  // Common subtypes carry vendor prefixes (e.g. "vnd.openxmlformats..."); we
  // keep the simple short form for the popular ones, fallback to the cleaned
  // subtype for the rest.
  const map: Record<string, string> = {
    jpeg: '.jpg',
    jpg: '.jpg',
    png: '.png',
    gif: '.gif',
    webp: '.webp',
    svg: '.svg',
    'svg+xml': '.svg',
    mp3: '.mp3',
    mpeg: '.mp3',
    wav: '.wav',
    'x-wav': '.wav',
    ogg: '.ogg',
    pdf: '.pdf',
    json: '.json',
    plain: '.txt',
    html: '.html',
    csv: '.csv',
  }
  return map[cleaned] ?? `.${cleaned.replace(/\+/g, '-')}`
}

const SAFE_NAME = /[^a-zA-Z0-9_-]/g

interface ISpilledRef {
  type: 'file'
  kind: 'image' | 'audio' | 'resource'
  path: string
  mimeType?: string
  bytes: number
  uri?: string
}

const spillBase64 = async (
  data: string,
  mimeType: string | undefined,
  kind: ISpilledRef['kind'],
  toolName: string,
  sandboxDir: string,
  ensureDir: () => Promise<void>,
): Promise<ISpilledRef> => {
  await ensureDir()
  const ext = extFromMime(mimeType, kind)
  const safe = toolName.replace(SAFE_NAME, '_').slice(0, 32) || 'tool'
  const id = randomUUID().slice(0, 8)
  const fullPath = path.join(sandboxDir, `${kind}-${safe}-${id}${ext}`)
  const buf = Buffer.from(data, 'base64')
  await writeFile(fullPath, buf)
  return { type: 'file', kind, path: fullPath, mimeType, bytes: buf.byteLength }
}

// Async because spilling binary parts to the sandbox involves disk I/O. Pure
// text content (the common case) returns synchronously-computed values via a
// resolved promise, so the await cost is negligible.
//
// Unknown / non-binary parts pass through unchanged: the previous behavior
// (text concatenation when ALL parts are text, otherwise array of unwrapped
// strings + raw objects) is preserved bit-for-bit.
export const flattenContent = async (
  content: unknown,
  context?: { toolName: string; sandboxDir?: string },
): Promise<unknown> => {
  if (!Array.isArray(content)) {
    return content
  }
  const parts = content as Array<Record<string, unknown>>
  const allText =
    parts.length > 0 && parts.every((p) => p?.type === 'text' && typeof p.text === 'string')
  if (allText) {
    return parts.map((p) => p.text as string).join('\n')
  }
  const sandboxDir = context?.sandboxDir
  const toolName = context?.toolName ?? 'tool'
  // mkdir-once: when a tool result has many binary parts, spillBase64 used
  // to mkdir() per part. Cache a single mkdir promise per flattenContent
  // call so we make at most one syscall regardless of part count.
  let mkdirOnce: Promise<void> | undefined
  const ensureDir = (): Promise<void> => {
    if (!sandboxDir) {
      return Promise.resolve()
    }
    if (!mkdirOnce) {
      mkdirOnce = mkdir(sandboxDir, { recursive: true }).then(() => undefined)
    }
    return mkdirOnce
  }
  const out: unknown[] = []
  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string') {
      out.push(p.text)
      continue
    }
    if (sandboxDir && (p?.type === 'image' || p?.type === 'audio') && typeof p.data === 'string') {
      const ref = await spillBase64(
        p.data,
        typeof p.mimeType === 'string' ? p.mimeType : undefined,
        p.type as 'image' | 'audio',
        toolName,
        sandboxDir,
        ensureDir,
      )
      out.push(ref)
      continue
    }
    if (sandboxDir && p?.type === 'resource' && p.resource && typeof p.resource === 'object') {
      const r = p.resource as { blob?: unknown; text?: unknown; mimeType?: unknown; uri?: unknown }
      if (typeof r.blob === 'string') {
        const ref = await spillBase64(
          r.blob,
          typeof r.mimeType === 'string' ? r.mimeType : undefined,
          'resource',
          toolName,
          sandboxDir,
          ensureDir,
        )
        if (typeof r.uri === 'string') {
          ref.uri = r.uri
        }
        out.push(ref)
        continue
      }
      if (typeof r.text === 'string') {
        out.push(r.text)
        continue
      }
    }
    out.push(p)
  }
  return out
}

export const filterTools = (
  tools: ToolSet,
  catalog: IConnectedMcp['catalog'],
  available?: string[],
  excluded?: string[],
  log?: (level: 'info' | 'warn' | 'error', message: string) => void,
): { tools: ToolSet; catalog: IConnectedMcp['catalog'] } => {
  // Catalogue names are sanitized ("my.docs__files.read" mounts as
  // "my_docs__files_read"), so raw configured names would silently match
  // nothing: an allowlist would yield zero tools, and — worse — a denylist
  // would stop denying. Compare on the sanitized form, and say so when an
  // entry matches nothing at all.
  const allow = available?.length ? new Set(available.map(sanitizeName)) : null
  const deny = excluded?.length ? new Set(excluded.map(sanitizeName)) : null
  const matched = new Set<string>()

  const result: ToolSet = {}
  const filteredCatalog: IConnectedMcp['catalog'] = []

  for (const entry of catalog) {
    if (allow?.has(entry.name) || deny?.has(entry.name)) {
      matched.add(entry.name)
    }
    if (allow && !allow.has(entry.name)) {
      continue
    }
    if (!allow && deny?.has(entry.name)) {
      continue
    }
    const t = tools[entry.name]
    if (!t) {
      continue
    }
    result[entry.name] = t
    filteredCatalog.push(entry)
  }

  if (log) {
    for (const [kind, configured] of [
      ['availableTools', available],
      ['excludedTools', excluded],
    ] as const) {
      for (const raw of configured ?? []) {
        if (!matched.has(sanitizeName(raw))) {
          log('warn', `[mcp] ${kind}: "${raw}" matches no discovered tool`)
        }
      }
    }
  }
  return { tools: result, catalog: filteredCatalog }
}
