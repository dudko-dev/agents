import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node'
import {
  createMcpHandler,
  InMemoryServerEventBus,
  inputRequired,
  isLegacyRequest,
  McpServer as ModernMcpServer,
  type McpHttpHandler,
} from '@modelcontextprotocol/server'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  startLocalAuthorizationServer,
  type IEnterpriseGrantOptions,
  type ILocalAuthorizationServer,
  type ITokenRequest,
} from './authorization-server.ts'
import {
  applyCors,
  closeServer,
  CORS_ALLOW_HEADERS_2025,
  json,
  listen,
  readBody,
  type IListenOptions,
} from './http.ts'
import {
  createElicitation,
  declaresElicitation,
  type ElicitationRequest,
  type IElicitationFaults,
  type IElicitationRound,
  type IElicitationTool,
  type IStatePayload,
  type IToolResult,
  type IUrlElicitation,
} from './mcp-elicitation.ts'
import { createSkillCatalog, type ISkillDirectoryRead, type ISkillFaults } from './mcp-skills.ts'
import {
  TRAVEL_APP_URI,
  TRAVEL_BAD_APP_URI,
  TRAVEL_FLIGHTS,
  travelAppHtml,
  type ITravelAppOptions,
} from './mcp-app.ts'

/**
 * A real MCP server and a real OAuth authorization server, both on loopback.
 *
 * The unit tests stub `fetch`; this runs the actual SDK server implementation
 * over actual sockets, so the client is validated against a peer rather than
 * against our idea of one — session headers, protocol negotiation, SSE framing
 * and the 401 challenge all come from the SDK itself.
 *
 * Two SDK generations sit behind one endpoint. The 2025 revisions (`legacy`)
 * are served by `@modelcontextprotocol/sdk` 1.x exactly as before; the
 * 2026-07-28 revision (`modern`) by `@modelcontextprotocol/server` 2.x, whose
 * answers to a 2025 client differ on the wire (schema dialect, error shapes),
 * which is why it does not serve both.
 */

/**
 * Which protocol revisions the endpoint speaks.
 *
 * - `'legacy'` (default): 2025-11-25 and earlier - the `initialize` handshake.
 * - `'modern'`: 2026-07-28 only - no handshake, no session, per-request `_meta`.
 * - `'dual'`: both on one endpoint; a request with the modern `_meta` is served
 *   the modern way, anything else the legacy way.
 */
export type McpProtocol = 'legacy' | 'modern' | 'dual'

/** How the version probe (`server/discover`) goes wrong (see `ILocalMcpServer.protocolFaults`). */
export type ProbeFault = 'unauthorized' | 'server_error' | 'garbage' | 'cors'

/** How `subscriptions/listen` is answered instead (see `ILocalMcpServer.listenFaults`). */
export type ListenFault =
  'not_found' | 'not_allowed' | 'unauthorized' | 'forbidden' | 'unavailable' | 'silent'

export interface ILocalMcpServerOptions extends IListenOptions {
  /** The protocol revisions to speak. Default `'legacy'`. */
  protocol?: McpProtocol
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
  /**
   * The `instructions` the server returns in its `initialize` result (legacy)
   * and its `server/discover` result (modern). Default: none.
   */
  instructions?: string
  /**
   * Also mount the tools that declare an `outputSchema` and answer with
   * `structuredContent`: `report` and `report_mixed`. Default: off.
   */
  structuredTools?: boolean
  /**
   * Also mount the tools that ask the user something: `elicit_form`,
   * `elicit_url`, `elicit_twice` and `elicit_state`. Default: off.
   */
  elicitationTools?: boolean
  /**
   * How long one round of `elicit_url` waits for its page to be submitted
   * before it asks to be called again. Default 3000 ms.
   */
  urlElicitationWaitMs?: number
  /**
   * The cache hint on the modern `server/discover` and `tools/list` results.
   * Default: the SDK's `ttlMs: 0`, `cacheScope: 'private'`.
   */
  cacheHint?: { ttlMs: number; cacheScope: 'public' | 'private' }
  /**
   * Also mount the MCP Apps tools (the `io.modelcontextprotocol/ui` extension) and their
   * resources: `flights.search` (read-only, with the app `ui://travel/results.html`),
   * `flights.book` (writes; model and app), `flights.refresh` (read-only, app only),
   * `flights.admin` (model only) and `flights.bad` (points at `ui://travel/bad.html`, which is
   * plain `text/html`). An object configures the app (`ITravelAppOptions`). Default: off.
   */
  appTools?: boolean | ITravelAppOptions
  /**
   * Also serve skills (the `io.modelcontextprotocol/skills` extension, SEP-2640) through the 2.x
   * SDK's `SkillsExtension`: `git-workflow`, `pdf-processing` (with `references/FORMS.md` and
   * `scripts/extract.py`), `acme/billing/refunds` and `acme/support/refunds` (one name, two
   * skills). 2026-07-28 only (`modern`, and the modern side of `dual`): the extension is written
   * against that revision. `skillFaults` adds the misbehaving ones. Default: off.
   */
  skills?: boolean
  /**
   * With `skills`: also serve `resources/directory/read` (the extension's optional method) and so
   * declare `directoryRead: true` - the direct children of a directory of the served `skill://`
   * files, subdirectories as `inode/directory`, -32602 for a URI that is not a directory, the
   * SDK's `ttlMs` / `cacheScope`. `{ pageSize }` pages the children (`nextCursor`). The faults
   * `skillFaults.directoryExtra` / `directoryOmit` / `directoryError` change what it answers.
   * Default: off (the extension is declared without `directoryRead`).
   */
  skillDirectoryRead?: boolean | ISkillDirectoryRead
}

/**
 * How the app resource goes wrong (see `ILocalMcpServer.appFaults`): `mime` answers with that
 * MIME type, `padTo` pads the HTML to that many characters, `otherUri` answers for another URI,
 * `cspInjection` adds entries to the declared CSP that are not origins.
 */
export interface IAppFaults {
  mime?: string
  padTo?: number
  otherUri?: boolean
  cspInjection?: boolean
}

/** How the structured tools go wrong (see `ILocalMcpServer.structuredFaults`). */
export type StructuredFault = 'mismatch' | 'missing'

/** The value `report` returns as `structuredContent` (and, serialized, as its text). */
export const REPORT_VALUE = { city: 'Lisbon', temperature: 21, tags: ['mild', 'clear'] }

/** A 1x1 transparent PNG: the image part `report_mixed` returns. */
export const REPORT_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** One JSON-RPC request or notification the endpoint received. */
export interface IMcpRequestRecord {
  /** `modern` when it carried the per-request protocol version in `_meta`, else `legacy`. */
  era: 'legacy' | 'modern'
  method: string
}

export interface ILocalMcpServer {
  /** The MCP endpoint to hand to `mcpServers[name].url`. */
  url: string
  /** The server's origin (the URL without `/mcp`). */
  origin: string
  /** The protocol revisions it speaks. */
  protocol: McpProtocol
  /**
   * A value only this server knows, returned by the `secret` tool. A task that
   * asks for it cannot be answered from the model's own knowledge, so "did the
   * model actually use the tool?" has a factual answer rather than a stylistic
   * one.
   */
  secret: string
  /**
   * Arguments every tool call received, in order. A call to an elicitation
   * tool is one entry however many rounds it took.
   */
  calls: { name: string; args: unknown }[]
  /** Tokens currently accepted (with `requireAuth`). */
  validTokens: Set<string>
  /** The `capabilities` of every `initialize` request the MCP server received. */
  initializeCapabilities: Record<string, unknown>[]
  /** Every JSON-RPC request and notification received, in order, with the era it claimed. */
  requests: IMcpRequestRecord[]
  /**
   * Mutable: make the structured tools break their own `outputSchema` from now
   * on. `result: 'mismatch'` answers with `temperature` as a string;
   * `result: 'missing'` answers with no `structuredContent` at all. The schema
   * in `tools/list` stays as declared: a server whose output drifted.
   */
  structuredFaults: { result?: StructuredFault }
  /**
   * Mutable: make the answer to `server/discover` - the request a client in
   * "auto" mode probes with - go wrong, in every protocol mode. `unauthorized`:
   * 401 with the challenge, whatever the token. `server_error`: 503.
   * `garbage`: 200 `application/json` with a body that is not JSON. `cors`:
   * every preflight answers with the request headers a pre-2026 deployment
   * allows (no `Mcp-Method`, no `Mcp-Name`), so a browser blocks the probe.
   */
  protocolFaults: { probe?: ProbeFault }
  /**
   * Mutable: answer every `subscriptions/listen` request this way from now on, before
   * the SDK sees it (a stream that is already open is not touched). `not_found`: 404
   * with JSON-RPC `-32601`, what a server that does not implement the method answers.
   * `not_allowed`: 405. `unauthorized`: 401 with the challenge, whatever the token.
   * `forbidden`: 403. `unavailable`: 503 with a plain-text body. `silent`: no answer
   * at all, the request is held until the client gives it up (`heldListens()`).
   */
  listenFaults: { answer?: ListenFault }
  /**
   * End every open `subscriptions/listen` stream abruptly - the connection is cut, no
   * result is sent: what a client sees when the network or a proxy drops it. Returns
   * how many there were.
   */
  dropListenStreams: () => number
  /**
   * End every open `subscriptions/listen` stream with its result, as a server process
   * that shuts down does, and go on serving from a fresh handler on the same event bus
   * (another process taking over: a stateless server has nothing else to hand on).
   * Modern and dual only. Resolves with how many there were.
   */
  closeListenStreams: () => Promise<number>
  /** `subscriptions/listen` requests that `listenFaults.answer = 'silent'` holds right now. */
  heldListens: () => number
  /** Mutable: make the elicitation tools misbehave (with `elicitationTools`). */
  elicitationFaults: IElicitationFaults
  /** Mutable: make the app resource misbehave (with `appTools`). */
  appFaults: IAppFaults
  /** Mutable (with `skills`): the misbehaving skills the listing gets from now on. */
  skillFaults: ISkillFaults
  /** Every skill file (`resources/read` of a skill URI) a client read, in order (with `skills`). */
  skillReads: string[]
  /** Every `skills/get` URI a client asked for, in order (with `skills`). */
  skillGets: string[]
  /**
   * Every `resources/directory/read` URI a client asked for, one per page, in order (with
   * `skills` and `skillDirectoryRead`).
   */
  skillDirectoryReads: string[]
  /**
   * Serve one more skill (with `skills`) - `path` is its skill path, its last segment its name -
   * and announce a resource list change (`notifications/resources/list_changed`) to every
   * listening client, which is how a skills change reaches one. `listed: false`: served by
   * `skills/get` only, never listed (and nothing is announced).
   */
  addSkill: (
    path: string,
    description: string,
    body: string,
    options?: { listed?: boolean },
  ) => Promise<void>
  /** Every round of every elicitation tool: what the client declared, answered and echoed. */
  elicitations: IElicitationRound[]
  /** The pages URL-mode elicitations pointed at. `POST` to a page's `url` submits it. */
  urlElicitations: IUrlElicitation[]
  /**
   * Change (or, with `undefined`, drop) the `instructions` returned from the
   * next `initialize` / `server/discover` on: a client that is already
   * connected keeps what it got.
   */
  setInstructions: (instructions: string | undefined) => void
  /**
   * Tell every listening client that the tool list changed:
   * `notifications/tools/list_changed` on each open `subscriptions/listen`
   * stream that asked for it (modern) and on each open GET stream (legacy).
   */
  notifyToolsChanged: () => void
  /** Add a tool (it answers `<name>:ok`) to the list from now on, then `notifyToolsChanged()`. */
  addTool: (name: string) => void
  /** How many streams `notifyToolsChanged()` would reach right now, both eras together. */
  changeListeners: () => number
  close: () => Promise<void>
}

const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'

/** The server drives at most this many rounds of one legacy tool call (the SDK's own shim stops at 8 too). */
const LEGACY_MAX_ROUNDS = 8

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A tool that answers at once, registered the same way with both SDK generations. */
interface IPlainTool {
  name: string
  description: string
  input: Record<string, z.ZodType>
  output?: Record<string, z.ZodType>
  annotations?: { readOnlyHint: boolean }
  /** The tool's `_meta` (MCP Apps: `ui.resourceUri`, `ui.visibility`). */
  meta?: JsonObject
  run: (args: JsonObject) => IToolResult
}

/** What the modern side knows about the request it is serving (the SDK builds a server per request). */
interface IModernRequest {
  method: string | undefined
  tool: string
  /** The client capabilities the request really declared. */
  capabilities: JsonObject
  responses: JsonObject | undefined
  rawState: string | undefined
}

/** The answer to a request this server sent to a legacy client. */
interface IClientReply {
  result?: JsonObject
  error?: { code: number; message: string }
}

/**
 * Start an MCP server with three tools: `echo`, `secret` and `boom` (which
 * always fails). `structuredTools` adds `report` and `report_mixed`,
 * `elicitationTools` the four `elicit_*` tools. `protocol` picks the revisions
 * it speaks; the default is the 2025 ones, served by the 1.x SDK, stateless.
 */
export const startLocalMcpServer = async (
  opts: ILocalMcpServerOptions = {},
): Promise<ILocalMcpServer> => {
  const protocol = opts.protocol ?? 'legacy'
  const calls: { name: string; args: unknown }[] = []
  const secret = `zq-${Math.random().toString(36).slice(2, 8)}`
  const validTokens = opts.validTokens ?? new Set<string>()
  const initializeCapabilities: Record<string, unknown>[] = []
  const requests: IMcpRequestRecord[] = []
  const structuredFaults: { result?: StructuredFault } = {}
  const protocolFaults: { probe?: ProbeFault } = {}
  const listenFaults: { answer?: ListenFault } = {}
  // The answers of the `subscriptions/listen` requests: streams the SDK serves, and
  // requests the `silent` fault holds.
  const listenStreams = new Set<ServerResponse>()
  const heldListens = new Set<ServerResponse>()
  const appFaults: IAppFaults = {}
  const appOptions: ITravelAppOptions | undefined =
    opts.appTools === true ? {} : opts.appTools || undefined
  const extraTools: string[] = []
  // Modern only: the SDK's skills extension over a source of ours (see `mcp-skills.ts`).
  const skillCatalog = opts.skills
    ? await createSkillCatalog({ directoryRead: opts.skillDirectoryRead })
    : undefined
  let instructions = opts.instructions
  let mcpOrigin = ''
  const elicitation = createElicitation({
    origin: () => mcpOrigin,
    urlWaitMs: opts.urlElicitationWaitMs ?? 3000,
  })

  // `method` is the JSON-RPC method the server instance will answer. Both SDKs
  // validate a result against the tool's outputSchema before they send it, so a
  // faulty answer is only possible from an instance that does not carry the
  // schema: with a fault switched on, the instance answering `tools/call`
  // registers the structured tools without one, while the one answering
  // `tools/list` still declares it.
  const plainTools = (method?: string): IPlainTool[] => {
    const tools: IPlainTool[] = [
      {
        name: 'echo',
        description: 'Echo the input back',
        input: { text: z.string() },
        run: ({ text }) => {
          calls.push({ name: 'echo', args: { text } })
          return { content: [{ type: 'text', text: `echo:${String(text)}` }] }
        },
      },
      {
        name: 'secret',
        description: 'Return the server-side secret code. There is no other way to learn it.',
        input: {},
        annotations: { readOnlyHint: true },
        run: () => {
          calls.push({ name: 'secret', args: {} })
          return { content: [{ type: 'text', text: secret }] }
        },
      },
      {
        name: 'boom',
        description: 'Always fails',
        input: {},
        run: () => {
          calls.push({ name: 'boom', args: {} })
          return { content: [{ type: 'text', text: 'kaboom' }], isError: true }
        },
      },
    ]
    if (opts.structuredTools) {
      const fault = method === 'tools/call' ? structuredFaults.result : undefined
      const output = fault
        ? undefined
        : { city: z.string(), temperature: z.number(), tags: z.array(z.string()) }
      const structured = (): Record<string, unknown> | undefined =>
        fault === 'missing'
          ? undefined
          : fault === 'mismatch'
            ? { ...REPORT_VALUE, temperature: 'warm' }
            : { ...REPORT_VALUE }
      tools.push(
        // The specification's backwards-compatible form: the same value as
        // structuredContent and, serialized, as a text block.
        {
          name: 'report',
          description: 'Return a weather report as structured content',
          input: {},
          output,
          annotations: { readOnlyHint: true },
          run: () => {
            calls.push({ name: 'report', args: {} })
            const value = structured()
            return {
              content: [{ type: 'text', text: JSON.stringify(value ?? REPORT_VALUE) }],
              ...(value ? { structuredContent: value } : {}),
            }
          },
        },
        // Structured content beside content that says something else: a sentence
        // and an image.
        {
          name: 'report_mixed',
          description: 'Return a weather report with a summary and a picture',
          input: {},
          output,
          annotations: { readOnlyHint: true },
          run: () => {
            calls.push({ name: 'report_mixed', args: {} })
            const value = structured()
            return {
              content: [
                { type: 'text', text: 'A mild, clear day.' },
                { type: 'image', data: REPORT_IMAGE_BASE64, mimeType: 'image/png' },
              ],
              ...(value ? { structuredContent: value } : {}),
            }
          },
        },
      )
    }
    if (appOptions) {
      const flightsResult = (route: JsonObject): IToolResult =>
        ({
          content: [
            {
              type: 'text',
              text: `Three flights ${String(route.from)} → ${String(route.to)}: ${TRAVEL_FLIGHTS.map(
                (f) => `${f.flight} ${f.depart} €${f.price}`,
              ).join(', ')}`,
            },
          ],
          structuredContent: { route, flights: TRAVEL_FLIGHTS },
        }) as IToolResult
      const app = (visibility?: string[]): JsonObject => ({
        ui: { resourceUri: TRAVEL_APP_URI, ...(visibility ? { visibility } : {}) },
      })
      tools.push(
        {
          name: 'flights.search',
          description: 'Search flights between two airports on a date; shows them in an app',
          input: { from: z.string(), to: z.string(), date: z.string().optional() },
          annotations: { readOnlyHint: true },
          meta: app(),
          run: (args) => {
            calls.push({ name: 'flights.search', args })
            return flightsResult({
              from: args.from,
              to: args.to,
              date: args.date ?? '2026-12-12',
            })
          },
        },
        {
          name: 'flights.book',
          description: 'Book a flight',
          input: {
            flight: z.string(),
            date: z.string().optional(),
            fare: z.string().optional(),
            passengers: z.number().optional(),
          },
          meta: app(['model', 'app']),
          run: (args) => {
            calls.push({ name: 'flights.book', args })
            return { content: [{ type: 'text', text: `booked:${String(args.flight)}` }] }
          },
        },
        {
          name: 'flights.refresh',
          description: 'Fetch the flights again (for the app)',
          input: {},
          annotations: { readOnlyHint: true },
          meta: app(['app']),
          run: () => {
            calls.push({ name: 'flights.refresh', args: {} })
            return flightsResult({ from: 'LIS', to: 'VIE', date: '2026-12-12' })
          },
        },
        {
          name: 'flights.admin',
          description: 'An administrative tool for the model only',
          input: {},
          meta: { ui: { visibility: ['model'] } },
          run: () => {
            calls.push({ name: 'flights.admin', args: {} })
            return { content: [{ type: 'text', text: 'admin:ok' }] }
          },
        },
        {
          name: 'flights.bad',
          description: 'A tool whose app is not an app',
          input: {},
          annotations: { readOnlyHint: true },
          meta: { ui: { resourceUri: TRAVEL_BAD_APP_URI } },
          run: () => {
            calls.push({ name: 'flights.bad', args: {} })
            return { content: [{ type: 'text', text: 'bad:ok' }] }
          },
        },
      )
    }
    for (const name of extraTools) {
      tools.push({
        name,
        description: 'A tool added while the server was running',
        input: {},
        run: () => {
          calls.push({ name, args: {} })
          return { content: [{ type: 'text', text: `${name}:ok` }] }
        },
      })
    }
    return tools
  }

  /** The app resources (`appTools`): the travel app, and one that is plain HTML. */
  const appResources = (): {
    name: string
    uri: string
    mimeType: string
    read: () => { contents: JsonObject[] }
  }[] => {
    if (!appOptions) {
      return []
    }
    return [
      {
        name: 'travel-results',
        uri: TRAVEL_APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        read: () => {
          let html = travelAppHtml(appOptions)
          if (appFaults.padTo && html.length < appFaults.padTo) {
            html += `<!--${'x'.repeat(appFaults.padTo - html.length - 7)}-->`
          }
          const connectDomains = [
            ...(appOptions.connectDomains ?? []),
            ...(appFaults.cspInjection
              ? ['https://ok.example; script-src *', '*', "'unsafe-eval'", 'data:', 'https://*.com']
              : []),
          ]
          return {
            contents: [
              {
                uri: appFaults.otherUri ? 'ui://travel/other.html' : TRAVEL_APP_URI,
                mimeType: appFaults.mime ?? 'text/html;profile=mcp-app',
                text: html,
                _meta: {
                  ui: {
                    csp: { connectDomains, resourceDomains: [] },
                    permissions: { camera: {} },
                    prefersBorder: true,
                  },
                },
              },
            ],
          }
        },
      },
      {
        name: 'travel-bad',
        uri: TRAVEL_BAD_APP_URI,
        mimeType: 'text/html',
        read: () => ({
          contents: [{ uri: TRAVEL_BAD_APP_URI, mimeType: 'text/html', text: '<p>not an app</p>' }],
        }),
      },
    ]
  }

  const elicitationTools = (): IElicitationTool[] =>
    opts.elicitationTools ? elicitation.tools : []

  const firstRound = (tool: IElicitationTool, first: boolean): void => {
    if (first) {
      calls.push({ name: tool.name, args: {} })
    }
  }

  // ── legacy: the 1.x SDK, a server and a transport per request ─────────────

  /** Requests this server sent to a legacy client and still waits on, by JSON-RPC id. */
  const awaitedReplies = new Map<number, (reply: IClientReply | undefined) => void>()
  /** The open GET streams of legacy clients: where a list change is announced. */
  const legacyStreams = new Set<StreamableHTTPServerTransport>()
  let serverRequestId = 0

  /** Send one request to a legacy client on the stream of the call that needs it. */
  type AskClient = (method: string, params: JsonObject) => Promise<IClientReply | undefined>

  const legacyErrorResult = (text: string): IToolResult => ({
    content: [{ type: 'text', text }],
    isError: true,
  })

  /**
   * The 2025 way to run an elicitation tool: there is no `input_required`
   * there, so the server asks each question itself - a real
   * `elicitation/create` request - and enters the tool again with the answers.
   * The state it would have handed to a modern client never leaves it.
   */
  const driveLegacy = async (
    tool: IElicitationTool,
    ask: AskClient,
    notify: (method: string, params: JsonObject) => Promise<void>,
  ): Promise<IToolResult> => {
    // No session: the handshake that declared the capabilities was another
    // request. The latest one is the best this server can know.
    const declared = initializeCapabilities.at(-1)?.elicitation
    const capabilities = isObject(declared) ? declared : undefined
    const opened: string[] = []
    let responses: JsonObject | undefined
    let rawState: string | undefined
    let state: IStatePayload | undefined
    firstRound(tool, true)
    for (let round = 0; round < LEGACY_MAX_ROUNDS; round += 1) {
      const outcome = await elicitation.advance(tool, {
        era: 'legacy',
        capabilities,
        responses,
        rawState,
        state,
      })
      if ('result' in outcome) {
        for (const elicitationId of opened.filter((id) => elicitation.completed(id))) {
          await notify('notifications/elicitation/complete', { elicitationId })
        }
        return outcome.result
      }
      responses = outcome.ask ? {} : undefined
      for (const [key, request] of Object.entries(outcome.ask ?? {})) {
        if (
          !elicitation.faults.undeclaredMode &&
          !declaresElicitation(capabilities, request.mode)
        ) {
          return legacyErrorResult(
            `The client did not declare the elicitation capability (${request.mode} mode)`,
          )
        }
        if (request.mode === 'url') {
          opened.push(request.elicitationId)
        }
        const reply = await ask('elicitation/create', { ...request })
        if (!reply?.result) {
          return legacyErrorResult(
            reply?.error
              ? `elicitation/create failed: ${reply.error.code} ${reply.error.message}`
              : 'elicitation/create was never answered',
          )
        }
        ;(responses as JsonObject)[key] = reply.result
      }
      if (!outcome.ask) {
        // Nothing to ask, only "call me again": do not spin.
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      rawState = outcome.state
      state = undefined
      if (rawState !== undefined) {
        try {
          state = elicitation.openState(rawState, tool.name)
        } catch {
          elicitation.refuseState({ era: 'legacy', capabilities, responses, rawState }, tool.name)
          return legacyErrorResult('Invalid or expired requestState')
        }
      }
    }
    return legacyErrorResult(`${tool.name} still needs input after ${LEGACY_MAX_ROUNDS} rounds`)
  }

  // Built per request: a stateless StreamableHTTP transport is single-use, and
  // an McpServer can only be connected to one transport at a time. This is the
  // SDK's own pattern for stateless mode.
  const buildServer = (
    method: string | undefined,
    send: (message: JsonObject, relatedRequestId: string | number) => Promise<void>,
    gone: Promise<void>,
  ): McpServer => {
    const server = new McpServer(
      { name: 'local-mcp', version: '1.0.0' },
      instructions === undefined ? undefined : { instructions },
    )
    for (const tool of plainTools(method)) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input,
          ...(tool.output ? { outputSchema: tool.output } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(tool.meta ? { _meta: tool.meta } : {}),
        },
        (args: JsonObject) => tool.run(args),
      )
    }
    for (const resource of appResources()) {
      server.registerResource(
        resource.name,
        resource.uri,
        { mimeType: resource.mimeType },
        () => resource.read() as never,
      )
    }
    for (const tool of elicitationTools()) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: {} },
        (_args: JsonObject, extra: { requestId: string | number }) =>
          driveLegacy(
            tool,
            (requestMethod, params) => {
              serverRequestId += 1
              const id = serverRequestId
              const reply = new Promise<IClientReply | undefined>((resolve) => {
                awaitedReplies.set(id, resolve)
              })
              // The client hanging up is the only other way this ends.
              void gone.then(() => awaitedReplies.get(id)?.(undefined))
              void send({ jsonrpc: '2.0', id, method: requestMethod, params }, extra.requestId)
              return reply.finally(() => awaitedReplies.delete(id))
            },
            (notification, params) =>
              send({ jsonrpc: '2.0', method: notification, params }, extra.requestId),
          ),
      )
    }
    return server
  }

  const serveLegacy = async (
    req: IncomingMessage,
    res: ServerResponse,
    raw: string,
  ): Promise<void> => {
    const message = raw
      ? (JSON.parse(raw) as {
          method?: string
          params?: { capabilities?: Record<string, unknown> }
        })
      : undefined
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const gone = new Promise<void>((resolve) => {
      res.on('close', resolve)
    })
    const server = buildServer(
      message?.method,
      (outgoing, relatedRequestId) =>
        transport.send(outgoing as never, { relatedRequestId }).catch(() => undefined),
      gone,
    )
    res.on('close', () => {
      legacyStreams.delete(transport)
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    if (message?.method === 'initialize') {
      initializeCapabilities.push(message.params?.capabilities ?? {})
    }
    if (req.method === 'GET') {
      legacyStreams.add(transport)
    }
    await transport.handleRequest(req, res, message)
  }

  // ── modern: the 2.x SDK's per-request handler ─────────────────────────────

  const modernRequest = new AsyncLocalStorage<IModernRequest>()
  const bus = new InMemoryServerEventBus()

  const buildModernServer = (): ModernMcpServer => {
    const request = modernRequest.getStore()
    const declared = request?.capabilities.elicitation
    const round = {
      era: 'modern' as const,
      capabilities: isObject(declared) ? declared : undefined,
      responses: request?.responses,
      rawState: request?.rawState,
    }
    const server = new ModernMcpServer(
      { name: 'local-mcp', version: '1.0.0' },
      {
        ...(instructions === undefined ? {} : { instructions }),
        ...(opts.cacheHint
          ? { cacheHints: { 'server/discover': opts.cacheHint, 'tools/list': opts.cacheHint } }
          : {}),
        // `requestState` comes back through the client: it is verified before
        // any tool sees it, and a state that fails is answered -32602 by the SDK.
        requestState: {
          verify: (state: string) => {
            try {
              return elicitation.openState(state, request?.tool ?? '')
            } catch (err) {
              elicitation.refuseState(round, request?.tool ?? '')
              throw err
            }
          },
        },
      },
    )
    for (const tool of plainTools(request?.method)) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: z.object(tool.input),
          ...(tool.output ? { outputSchema: z.object(tool.output) } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(tool.meta ? { _meta: tool.meta } : {}),
        },
        (args) => tool.run(args as JsonObject),
      )
    }
    for (const resource of appResources()) {
      server.registerResource(
        resource.name,
        resource.uri,
        { mimeType: resource.mimeType },
        () => resource.read() as never,
      )
    }
    for (const tool of elicitationTools()) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: z.object({}) },
        async (_args, ctx) => {
          firstRound(tool, round.responses === undefined && round.rawState === undefined)
          const outcome = await elicitation.advance(tool, {
            ...round,
            state: ctx.mcpReq.requestState<IStatePayload>(),
          })
          if ('result' in outcome) {
            return outcome.result
          }
          const asked = Object.entries(outcome.ask ?? {}).map(([key, request]) => [
            key,
            request.mode === 'url'
              ? inputRequired.elicitUrl({ message: request.message, url: request.url })
              : inputRequired.elicit({
                  message: request.message,
                  requestedSchema: request.requestedSchema as never,
                }),
          ])
          return inputRequired({
            ...(outcome.ask ? { inputRequests: Object.fromEntries(asked) } : {}),
            ...(outcome.state === undefined ? {} : { requestState: outcome.state }),
          } as never)
        },
      )
    }
    // Before the handler connects it: the capability is declared by `attach`.
    skillCatalog?.extension.attach(server)
    return server
  }

  let modern: McpHttpHandler | undefined
  let modernNode: ReturnType<typeof toNodeHandler> | undefined
  if (protocol !== 'legacy') {
    // `legacy: 'reject'`: this handler is the modern era only. In `dual` mode
    // the 2025 traffic never reaches it (see `serve`).
    modern = createMcpHandler(buildModernServer, { legacy: 'reject', bus })
    modernNode = toNodeHandler(modern)
  }

  /** The request again, as the SDK's adapter reads one: the body was already consumed here. */
  const replay = (req: IncomingMessage, raw: string) => ({
    method: req.method,
    url: req.url,
    headers: req.headers,
    async *[Symbol.asyncIterator]() {
      if (raw) {
        yield Buffer.from(raw)
      }
    },
  })

  const serveModern = async (
    req: IncomingMessage,
    res: ServerResponse,
    raw: string,
    message: unknown,
  ): Promise<void> => {
    const params = isObject(message) && isObject(message.params) ? message.params : {}
    const meta = isObject(params._meta) ? params._meta : {}
    const declared = meta[CLIENT_CAPABILITIES_KEY]
    const capabilities = isObject(declared) ? declared : {}
    const method = isObject(message) ? (message.method as string | undefined) : undefined
    let body = raw
    if (elicitation.faults.undeclaredMode && method === 'tools/call') {
      // The SDK refuses (-32021) to ask for what the request did not declare.
      // To make it ask anyway, it is shown a request that declares both modes;
      // the tools and the record keep what the client really sent.
      body = JSON.stringify({
        ...(message as JsonObject),
        params: {
          ...params,
          _meta: {
            ...meta,
            [CLIENT_CAPABILITIES_KEY]: { ...capabilities, elicitation: { form: {}, url: {} } },
          },
        },
      })
    }
    if (method === 'subscriptions/listen') {
      listenStreams.add(res)
      res.on('close', () => listenStreams.delete(res))
    }
    const request: IModernRequest = {
      method,
      tool: typeof params.name === 'string' ? params.name : '',
      capabilities,
      responses: isObject(params.inputResponses) ? params.inputResponses : undefined,
      rawState: typeof params.requestState === 'string' ? params.requestState : undefined,
    }
    await modernRequest.run(request, () =>
      (modernNode as NonNullable<typeof modernNode>)(replay(req, body), res),
    )
  }

  // ── the endpoint ──────────────────────────────────────────────────────────

  const parse = (raw: string): unknown => {
    try {
      return raw ? JSON.parse(raw) : undefined
    } catch {
      return undefined
    }
  }

  const record = (message: unknown): void => {
    for (const one of Array.isArray(message) ? message : [message]) {
      if (isObject(one) && typeof one.method === 'string') {
        const meta = isObject(one.params) && isObject(one.params._meta) ? one.params._meta : {}
        requests.push({
          era: meta[PROTOCOL_VERSION_KEY] === undefined ? 'legacy' : 'modern',
          method: one.method,
        })
      }
    }
  }

  const challenge = (): Record<string, string> => ({
    'www-authenticate': `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/mcp"`,
  })

  /** Answer the probe wrongly, if a fault says so. Returns true when it did. */
  const failProbe = (res: ServerResponse): boolean => {
    switch (protocolFaults.probe) {
      case 'unauthorized':
        json(res, 401, { error: 'unauthorized' }, challenge())
        return true
      case 'server_error':
        res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('upstream unavailable')
        return true
      case 'garbage':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('<!doctype html><title>Welcome</title><p>This is not an MCP answer.</p>')
        return true
      default:
        return false
    }
  }

  /** Answer `subscriptions/listen` wrongly, if a fault says so. Returns true when it did. */
  const failListen = (res: ServerResponse, id: unknown): boolean => {
    switch (listenFaults.answer) {
      case 'not_found':
        json(res, 404, {
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32601, message: 'Method not found: subscriptions/listen' },
        })
        return true
      case 'not_allowed':
        res.writeHead(405, { 'content-type': 'text/plain' })
        res.end('method not allowed')
        return true
      case 'unauthorized':
        json(res, 401, { error: 'unauthorized' }, challenge())
        return true
      case 'forbidden':
        json(res, 403, { error: 'forbidden' })
        return true
      case 'unavailable':
        res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('upstream unavailable')
        return true
      case 'silent':
        heldListens.add(res)
        res.on('close', () => heldListens.delete(res))
        return true
      default:
        return false
    }
  }

  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const oldCors = protocolFaults.probe === 'cors' ? CORS_ALLOW_HEADERS_2025 : undefined
    if (applyCors(req, res, opts.cors, oldCors)) {
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
    // A browser opens these without the client's token: that is the point of URL mode.
    if (opts.elicitationTools && elicitation.handlePage(req, res, path)) {
      return
    }
    if (opts.requireAuth) {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (!validTokens.has(token)) {
        json(res, 401, { error: 'unauthorized' }, challenge())
        return
      }
    }
    const raw = await readBody(req)
    const message = parse(raw)
    record(message)
    if (isObject(message) && message.method === 'server/discover' && failProbe(res)) {
      return
    }
    if (
      isObject(message) &&
      message.method === 'subscriptions/listen' &&
      failListen(res, message.id)
    ) {
      return
    }
    // `skillFaults.nameMismatch`: the SDK drops an entry whose URI and name disagree, so the
    // listing that carries one is answered here, before the SDK sees the request.
    if (
      skillCatalog?.faults.nameMismatch &&
      isObject(message) &&
      message.method === 'skills/list' &&
      isObject(message.params) &&
      isObject(message.params._meta) &&
      message.params._meta[PROTOCOL_VERSION_KEY] !== undefined
    ) {
      json(res, 200, {
        jsonrpc: '2.0',
        id: message.id ?? null,
        result: {
          resultType: 'complete',
          skills: await skillCatalog.listing(),
          ttlMs: 0,
          cacheScope: 'private',
        },
      })
      return
    }
    // The answer of a legacy client to a request this server sent it.
    if (isObject(message) && message.method === undefined && typeof message.id === 'number') {
      const deliver = awaitedReplies.get(message.id)
      if (deliver) {
        deliver(message as IClientReply)
        res.writeHead(202)
        res.end()
        return
      }
    }
    const legacy =
      protocol === 'legacy' ||
      (protocol === 'dual' && (await isLegacyRequest(await toWebRequest(replay(req, raw)))))
    await (legacy ? serveLegacy(req, res, raw) : serveModern(req, res, raw, message))
  }

  const httpServer = createServer((req, res) => {
    serve(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'server_error' })
    })
  })
  mcpOrigin = await listen(httpServer, opts)
  const mcpUrl = `${mcpOrigin}/mcp`

  const notifyToolsChanged = (): void => {
    modern?.notify.toolsChanged()
    for (const transport of legacyStreams) {
      void transport
        .send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
        .catch(() => undefined)
    }
  }

  return {
    url: mcpUrl,
    origin: mcpOrigin,
    protocol,
    secret,
    calls,
    validTokens,
    initializeCapabilities,
    requests,
    structuredFaults,
    protocolFaults,
    listenFaults,
    dropListenStreams: () => {
      const open = [...listenStreams]
      for (const res of open) {
        res.destroy()
      }
      return open.length
    },
    closeListenStreams: async () => {
      if (!modern) {
        throw new Error('closeListenStreams: this server does not speak 2026-07-28')
      }
      const open = listenStreams.size
      const previous = modern
      modern = createMcpHandler(buildModernServer, { legacy: 'reject', bus })
      modernNode = toNodeHandler(modern)
      await previous.close()
      return open
    },
    heldListens: () => heldListens.size,
    elicitationFaults: elicitation.faults,
    appFaults,
    skillFaults: skillCatalog?.faults ?? {},
    skillReads: skillCatalog?.reads ?? [],
    skillGets: skillCatalog?.gets ?? [],
    skillDirectoryReads: skillCatalog?.directoryReads ?? [],
    addSkill: async (path, description, body, options) => {
      if (!skillCatalog) {
        throw new Error('addSkill: this server was started without `skills`')
      }
      await skillCatalog.add(path, description, body, options)
      if (options?.listed !== false) modern?.notify.resourcesChanged()
    },
    elicitations: elicitation.rounds,
    urlElicitations: elicitation.urlElicitations,
    setInstructions: (next) => {
      instructions = next
    },
    notifyToolsChanged,
    addTool: (name) => {
      extraTools.push(name)
      notifyToolsChanged()
    },
    changeListeners: () => legacyStreams.size + bus.listenerCount,
    close: async () => {
      elicitation.close()
      // Ends every `subscriptions/listen` stream with its result, as a server shutting down should.
      await modern?.close()
      await closeServer(httpServer)
    },
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
  /** The `instructions` the MCP server returns in its `initialize` result. */
  instructions?: string
  /** Also mount the structured tools (`report`, `report_mixed`). */
  structuredTools?: boolean
  /** The protocol revisions the MCP server speaks. Default `'legacy'`. */
  protocol?: McpProtocol
  /** Also mount the elicitation tools (`elicit_form`, `elicit_url`, `elicit_twice`, `elicit_state`). */
  elicitationTools?: boolean
  /** How long one round of `elicit_url` waits for its page. Default 3000 ms. */
  urlElicitationWaitMs?: number
  /** The cache hint on the modern `server/discover` and `tools/list` results. */
  cacheHint?: { ttlMs: number; cacheScope: 'public' | 'private' }
  /** Also mount the MCP Apps tools and resources (see `ILocalMcpServerOptions.appTools`). */
  appTools?: boolean | ITravelAppOptions
  /** Also serve skills, 2026-07-28 only (see `ILocalMcpServerOptions.skills`). */
  skills?: boolean
  /** With `skills`: directory reads too (see `ILocalMcpServerOptions.skillDirectoryRead`). */
  skillDirectoryRead?: boolean | ISkillDirectoryRead
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
  /** Mutable: what the authorization server's metadata advertises from now on. */
  advertised: ILocalAuthorizationServer['advertised']
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
      instructions: opts.instructions,
      structuredTools: opts.structuredTools,
      protocol: opts.protocol,
      elicitationTools: opts.elicitationTools,
      urlElicitationWaitMs: opts.urlElicitationWaitMs,
      cacheHint: opts.cacheHint,
      appTools: opts.appTools,
      skills: opts.skills,
      skillDirectoryRead: opts.skillDirectoryRead,
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
    advertised: as.advertised,
    close: async () => {
      await mcp.close()
      await as.close()
    },
  }
}
