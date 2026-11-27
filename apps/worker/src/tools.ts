import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type ElicitRequestFormParams,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import { BUDGETS, registerTripBoard, TRIP_BOARD_TOOLS } from './trip-board.ts'

/**
 * The tools of the demo MCP server. Each is cheap, keeps nothing and reaches nothing: no storage,
 * no secret, no outbound request, no log. Their inputs are bounded by their schemas, so what they
 * answer is bounded too (the HTTP layer caps it once more, see `demo-server.ts`).
 *
 * Two of them ask the user something in the middle of the call (MCP elicitation): `plan_trip`
 * (a form) and `open_docs` (a link). On the 2026-07-28 revision that is an `input_required`
 * result the client answers and retries with: no state is kept between the rounds, so it works
 * on a Worker without a Durable Object. The 2025 revisions ask with a request the SERVER sends
 * on the call's stream and the client answers in a separate POST - which a stateless server has
 * no way to receive (another request, maybe another isolate). There they answer with an error
 * that says so, instead of the SDK's generic one.
 */

/** What a tool may know about the request it serves. */
export interface DemoToolContext {
  /** `modern`: 2026-07-28 (per-request `_meta`); `legacy`: the 2025 revisions. */
  era: 'legacy' | 'modern'
  /** The origin the request was sent to: the link `open_docs` hands out is on it. */
  origin: string
}

/**
 * Every tool, in the order `tools/list` names them. A host that speaks MCP Apps mounts all but
 * `APP_ONLY_TOOLS` (`trip-board.ts`) for its model.
 */
export const DEMO_TOOL_NAMES = [
  'echo',
  'current_time',
  'roll_dice',
  'plan_trip',
  'open_docs',
  ...TRIP_BOARD_TOOLS,
] as const

/** The page `open_docs` links to: the section of the docs about the feature it shows. */
export const DOCS_PATH = '/docs/browser/capabilities/#mcp-elicitation-a-server-asks-the-user'

/** The longest text `echo` takes. */
export const ECHO_MAX_CHARS = 1000

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const

const text = (value: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(isError ? { isError: true } : {}),
})

/** What an asking tool answers on a 2025 connection. */
const needsModernRevision = (tool: string): CallToolResult =>
  text(
    `${tool} asks the user a question (MCP elicitation), which this server can only do on the ` +
      '2026-07-28 revision of the protocol: it keeps nothing between requests, and on the 2025 ' +
      'revisions the answer would arrive in a request of its own. Connect with protocol "auto" ' +
      'or "modern" to use it.',
    true,
  )

/**
 * Whether the request declared that its client can be asked in this mode (2026-07-28: in the
 * request's own `_meta`). An empty `elicitation` object means the form only.
 */
const declares = (call: ServerContext, mode: 'form' | 'url'): boolean => {
  const envelope = call.mcpReq.envelope as Record<string, unknown> | undefined
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    { elicitation?: { form?: unknown; url?: unknown } } | undefined
  const elicitation = capabilities?.elicitation
  if (typeof elicitation !== 'object' || elicitation === null) return false
  return mode === 'url'
    ? elicitation.url !== undefined
    : elicitation.form !== undefined || elicitation.url === undefined
}

/** What an asking tool answers to a client that cannot be asked (rather than a protocol error). */
const cannotAsk = (tool: string, mode: 'form' | 'url'): CallToolResult =>
  text(
    `${tool} asks the user a question (MCP elicitation, ${mode} mode), and this client did not ` +
      'declare that it can show one. Nothing was asked.',
    true,
  )

// ── plan_trip: a form ───────────────────────────────────────────────────────

/**
 * The form `plan_trip` asks for, as it goes on the wire: the flat subset a form may use
 * (strings with a length or a format, integers with bounds, a single-select with titles, a
 * boolean, defaults). A destination the model already knows is offered as the default.
 */
export const tripForm = (destination?: string): ElicitRequestFormParams['requestedSchema'] => ({
  type: 'object',
  properties: {
    destination: {
      type: 'string',
      title: 'Destination',
      description: 'A city or a region',
      minLength: 1,
      maxLength: 80,
      ...(destination ? { default: destination } : {}),
    },
    start: { type: 'string', title: 'First day', format: 'date' },
    nights: { type: 'integer', title: 'Nights', minimum: 1, maximum: 30, default: 3 },
    travellers: { type: 'integer', title: 'Travellers', minimum: 1, maximum: 12, default: 2 },
    budget: {
      type: 'string',
      title: 'Budget',
      oneOf: [
        { const: 'shoestring', title: 'Shoestring' },
        { const: 'comfortable', title: 'Comfortable' },
        { const: 'luxury', title: 'Luxury' },
      ],
      default: 'comfortable',
    },
    flexible: {
      type: 'boolean',
      title: 'Flexible dates',
      description: 'A day earlier or later is fine',
      default: false,
    },
  },
  required: ['destination', 'start', 'nights', 'travellers', 'budget'],
})

/** The same form as a check of what comes back: the client is not obliged to have validated it. */
const TripAnswer = z.object({
  destination: z.string().trim().min(1).max(80),
  start: z.iso.date(),
  nights: z.number().int().min(1).max(30),
  travellers: z.number().int().min(1).max(12),
  budget: z.enum(BUDGETS),
  flexible: z.boolean().optional(),
})

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const tripSummary = (trip: z.infer<typeof TripAnswer>): string => {
  const people = trip.travellers === 1 ? '1 traveller' : `${trip.travellers} travellers`
  const nights = trip.nights === 1 ? '1 night' : `${trip.nights} nights`
  return (
    `Trip to ${trip.destination}: ${nights} from ${trip.start} to ` +
    `${addDays(trip.start, trip.nights)}, ${people}, ${trip.budget} budget, ` +
    `${trip.flexible ? 'flexible' : 'fixed'} dates.`
  )
}

const registerPlanTrip = (server: McpServer, ctx: DemoToolContext): void => {
  server.registerTool(
    'plan_trip',
    {
      title: 'Plan a trip',
      description:
        'Ask the user for the details of a trip (a form: destination, first day, nights, ' +
        'travellers, budget, flexible dates) and return a one-line summary. The user answers, ' +
        'not the model: call it without guessing the details.',
      inputSchema: z.object({
        destination: z
          .string()
          .max(80)
          .optional()
          .describe('A destination the user already named: it is offered in the form'),
      }),
      annotations: READ_ONLY,
    },
    (args, call) => {
      if (ctx.era === 'legacy') return needsModernRevision('plan_trip')
      if (!declares(call, 'form')) return cannotAsk('plan_trip', 'form')
      const responses = call.mcpReq.inputResponses
      const answer = inputResponse(responses, 'trip')
      if (answer.kind === 'elicit' && answer.action !== 'accept') {
        return text(`The user did not plan a trip (${answer.action}).`)
      }
      const trip = acceptedContent(responses, 'trip', TripAnswer)
      if (trip) return text(tripSummary(trip))
      // A first call, or an answer that does not fit the form: asked (again), not failed.
      return inputRequired({
        inputRequests: {
          trip: inputRequired.elicit({
            message:
              answer.kind === 'missing'
                ? 'Where and when would you like to go?'
                : 'Some answers did not fit the form. Where and when would you like to go?',
            requestedSchema: tripForm(args.destination?.trim()),
          }),
        },
      })
    },
  )
}

// ── open_docs: a link ───────────────────────────────────────────────────────

const registerOpenDocs = (server: McpServer, ctx: DemoToolContext): void => {
  const url = new URL(DOCS_PATH, ctx.origin).href
  server.registerTool(
    'open_docs',
    {
      title: 'Open the docs',
      description:
        'Ask the user to open the page of the agent.dudko.dev docs about MCP elicitation (a ' +
        'link question: the user is shown the link and decides). Returns whether they agreed.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    (_args, call) => {
      if (ctx.era === 'legacy') return needsModernRevision('open_docs')
      if (!declares(call, 'url')) return cannotAsk('open_docs', 'url')
      const answer = inputResponse(call.mcpReq.inputResponses, 'docs')
      if (answer.kind !== 'elicit') {
        return inputRequired({
          inputRequests: {
            docs: inputRequired.elicitUrl({
              message: 'Open the page about MCP elicitation in the agent.dudko.dev docs.',
              url,
            }),
          },
        })
      }
      // `accept` is consent to open the link, not proof it was read: this server keeps nothing
      // and cannot see the page being opened.
      return answer.action === 'accept'
        ? text(`The user agreed to open ${url}.`)
        : text(`The user did not open the page (${answer.action}).`)
    },
  )
}

// ── plain tools ─────────────────────────────────────────────────────────────

/** A uniform integer in [1, sides], without the bias of `random % sides`. */
const rollOne = (sides: number): number => {
  const limit = Math.floor(0x1_0000_0000 / sides) * sides
  const buffer = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buffer)
    const value = buffer[0] as number
    if (value < limit) return (value % sides) + 1
  }
}

const registerPlainTools = (server: McpServer): void => {
  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Return the text it is given, unchanged.',
      inputSchema: z.object({ text: z.string().max(ECHO_MAX_CHARS) }),
      annotations: READ_ONLY,
    },
    ({ text: value }) => text(value),
  )

  server.registerTool(
    'current_time',
    {
      title: 'Current time',
      description:
        'The current date and time, in UTC and, when given an IANA time zone such as ' +
        '"Europe/Lisbon", there too.',
      inputSchema: z.object({
        timeZone: z.string().max(64).optional().describe('An IANA time zone, e.g. Asia/Tokyo'),
      }),
      annotations: READ_ONLY,
    },
    ({ timeZone }) => {
      const now = new Date()
      if (!timeZone) return text(now.toISOString())
      let local: string
      try {
        local = new Intl.DateTimeFormat('en-GB', {
          timeZone,
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(now)
      } catch {
        return text(`Unknown time zone: ${JSON.stringify(timeZone)}.`, true)
      }
      return text(`${now.toISOString()} (${local})`)
    },
  )

  // The tool with an `outputSchema`: the value is `structuredContent`, and the same value,
  // serialized, is its text (the specification's backwards-compatible form).
  server.registerTool(
    'roll_dice',
    {
      title: 'Roll dice',
      description: 'Roll some dice and return each roll and the total.',
      inputSchema: z.object({
        count: z.number().int().min(1).max(20).default(1).describe('How many dice (1-20)'),
        sides: z.number().int().min(2).max(1000).default(6).describe('Sides of each die (2-1000)'),
      }),
      outputSchema: z.object({
        sides: z.number().int().min(2).max(1000),
        rolls: z.array(z.number().int().min(1).max(1000)),
        total: z.number().int().min(1).max(20_000),
      }),
      annotations: READ_ONLY,
    },
    ({ count, sides }) => {
      const rolls = Array.from({ length: count }, () => rollOne(sides))
      const value = { sides, rolls, total: rolls.reduce((sum, roll) => sum + roll, 0) }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
    },
  )
}

/**
 * Register every tool of the demo server on a fresh instance (one per request).
 *
 * An MCP App (a tool that comes with a UI) takes two registrations: the UI as a resource -
 * `server.registerResource(name, 'ui://demo/<name>.html', { mimeType: 'text/html;profile=mcp-app'
 * }, read)`, its HTML a constant in this project (no outbound fetch) - and the tool, with `_meta:
 * { ui: { resourceUri: 'ui://demo/<name>.html' } }` in its config so a host knows which UI to
 * render with its result. `trip-board.ts` is the one there is: follow it. Registering a resource
 * makes the server advertise the `resources` capability, with `listChanged` off as for tools (see
 * `demo-server.ts`: nothing here ever changes). Add the tool's name to `DEMO_TOOL_NAMES` and its
 * own test to `tests/demo-server.test.ts`.
 */
export const registerDemoTools = (server: McpServer, ctx: DemoToolContext): void => {
  registerPlainTools(server)
  registerPlanTrip(server, ctx)
  registerOpenDocs(server, ctx)
  registerTripBoard(server, ctx)
}
