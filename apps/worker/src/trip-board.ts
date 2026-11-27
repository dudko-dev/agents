import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { tripBoardHtml } from './trip-board-app.ts'

/**
 * The demo server's MCP App (the `io.modelcontextprotocol/ui` extension, revision 2026-01-26): a
 * trip board. Three tools and one resource, all stateless and side-effect free:
 *
 * - `trip_board` (the model's, and the app's): a day-by-day plan for a trip, computed from its
 *   inputs (and, when no first day is given, from the day of the request: `defaultTripStart`). It declares the app (`_meta.ui.resourceUri`), so a host that shows MCP Apps draws the
 *   board with the result; any other host has the same plan as text.
 * - `reshuffle_day` (the app's only: `visibility: ['app']`, read-only): other ideas for one day.
 *   A host that speaks MCP Apps never hands it to the model, and runs it for the app without a
 *   prompt (it changes nothing).
 * - `book_trip` (the app's only, NOT read-only): a DEMO booking. Nothing is booked, charged or
 *   kept: the confirmation code is a hash of the inputs. It is declared as a write on purpose, so
 *   a host asks the user before the app runs it - as it must for a real booking.
 * - the resource `ui://demo/trip-board.html` (`text/html;profile=mcp-app`): the board itself, one
 *   document with its script and styles inline. Its CSP lists are empty: it reaches no origin,
 *   loads nothing, and talks to the host only (`postMessage`).
 *
 * Every tool is listed on both protocol revisions and to every client: on the 2025 revisions a
 * stateless server does not know, at `tools/list`, what the client declared at `initialize` (that
 * was another request), so the list cannot depend on it. A host without MCP Apps may offer the two
 * app tools to its model; they are harmless there (deterministic, nothing kept, nothing reached).
 */

/** The app's resource. */
export const TRIP_BOARD_URI = 'ui://demo/trip-board.html'

/** The content type of an MCP App (the extension's stable revision). */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

/** The tools of the app, in the order they are registered. */
export const TRIP_BOARD_TOOLS = ['trip_board', 'reshuffle_day', 'book_trip'] as const

/** The tools only the app may call (`visibility: ['app']`). */
export const APP_ONLY_TOOLS = ['reshuffle_day', 'book_trip'] as const

/** The page the app's "How MCP Apps work" asks the host to open (on the request's origin). */
export const APP_DOCS_PATH = '/docs/browser/capabilities/#mcp-apps-a-servers-interface-for-a-tool'

/** The longest trip the board plans. */
export const TRIP_MAX_NIGHTS = 14

/** A trip asked for without a first day starts at least this many days after the request... */
export const TRIP_DEFAULT_LEAD_DAYS = 14
/** ...on the next Friday (0 = Sunday): a long weekend, with dates the board can show. */
export const TRIP_DEFAULT_WEEKDAY = 5

export const BUDGETS = ['shoestring', 'comfortable', 'luxury'] as const
export type Budget = (typeof BUDGETS)[number]

export const KINDS = [
  'walk',
  'food',
  'culture',
  'nature',
  'view',
  'night',
  'travel',
  'sight',
] as const
type Kind = (typeof KINDS)[number]

// ── the plan: computed from the inputs, nothing else ────────────────────────

/** [time, kind, title, note]; `{d}` is the destination. */
type Slot = readonly [string, Kind, string, string]

interface Template {
  theme: string
  /** Morning, afternoon, evening. */
  slots: readonly [Slot, Slot, Slot]
}

/** The day plans the board picks from. Generic on purpose: they read well for any place. */
const TEMPLATES: readonly Template[] = [
  {
    theme: 'Old town on foot',
    slots: [
      [
        '09:30',
        'walk',
        'A slow walk through the old town of {d}',
        'Start early, before the crowds',
      ],
      ['13:00', 'food', 'Lunch where the locals queue', 'Ask for the dish of the day'],
      ['18:30', 'view', 'Sunset from the highest viewpoint', 'Bring a layer: it gets windy'],
    ],
  },
  {
    theme: 'Markets and food',
    slots: [
      ['09:00', 'food', 'Breakfast at the central market', 'Fruit, pastries and strong coffee'],
      [
        '12:30',
        'food',
        'A food walk through three neighbourhoods',
        'Small plates, one at each stop',
      ],
      ['20:00', 'night', 'Dinner and live music', 'Book a table for the second set'],
    ],
  },
  {
    theme: 'Museums and galleries',
    slots: [
      ['10:00', 'culture', 'The city museum, before it gets busy', 'Two hours is plenty'],
      ['14:30', 'culture', 'A gallery hop in the arts quarter', 'Most of them are free to enter'],
      ['19:30', 'food', 'A long dinner by the water', 'Try the local wine'],
    ],
  },
  {
    theme: 'Parks and the waterfront',
    slots: [
      ['09:30', 'nature', 'A morning in the largest park in {d}', 'Bikes for hire at the gate'],
      ['13:00', 'food', 'A picnic by the water', 'The market sells all you need'],
      ['17:00', 'walk', 'Along the waterfront to the old harbour', 'Flat, about 5 km'],
    ],
  },
  {
    theme: 'A day out of town',
    slots: [
      ['08:30', 'travel', 'A morning train out of {d}', 'Sit on the left for the view'],
      ['12:00', 'sight', 'A castle, a village and a long lunch', 'Wear comfortable shoes'],
      ['19:00', 'travel', 'Back in {d} for a late dinner', 'The last train leaves at 21:40'],
    ],
  },
  {
    theme: 'Neighbourhoods off the map',
    slots: [
      ['10:00', 'walk', 'A district the guidebooks skip', 'Follow the side streets'],
      ['14:00', 'culture', 'A workshop with a local maker', 'Ceramics, print or textiles'],
      ['19:00', 'night', 'Drinks on a rooftop', 'Go before the sun sets'],
    ],
  },
  {
    theme: 'A slow day',
    slots: [
      ['10:30', 'food', 'A late brunch, no alarm', 'Nothing booked before noon'],
      ['14:00', 'nature', 'A garden, a beach or a long read', 'Whatever the weather allows'],
      ['19:30', 'food', 'The best table you can get', 'Reserve a day ahead'],
    ],
  },
  {
    theme: 'Views and landmarks',
    slots: [
      ['09:00', 'sight', 'The landmark of {d}, at opening time', 'Tickets online skip the queue'],
      ['13:30', 'food', 'Lunch with a view', 'A terrace if there is sun'],
      ['21:00', 'view', '{d} lit up at night', 'The bridges are the best spot'],
    ],
  },
]

const ARRIVAL: Slot = [
  '15:00',
  'travel',
  'Arrive in {d} and check in',
  'Drop the bags, find a coffee',
]
const DEPARTURE: Slot = ['12:00', 'travel', 'Check out and head home', 'Leave time to get there']

export interface TripItem {
  time: string
  kind: Kind
  title: string
  note: string
}

export interface TripDay {
  /** 1 for the first day. */
  day: number
  /** The date (YYYY-MM-DD), when the trip has a first day. */
  date?: string
  theme: string
  /** Which of the day's alternatives this is (0: the board's first pick). */
  variant: number
  items: TripItem[]
}

/** FNV-1a, 32 bits: the same text, the same number, on every runtime. */
const hash = (value: string, seed = 0x811c9dc5): number => {
  let h = seed >>> 0
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

const placeKey = (destination: string): string => destination.trim().toLowerCase()

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * The first day of a trip asked for without one (YYYY-MM-DD): the first Friday at least
 * `TRIP_DEFAULT_LEAD_DAYS` (14) days after `today`, in UTC. The same request day, the same date:
 * the server keeps nothing, and the date depends on nothing but the day of the request.
 */
export const defaultTripStart = (today: Date): string => {
  const day = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() + TRIP_DEFAULT_LEAD_DAYS,
    ),
  )
  day.setUTCDate(day.getUTCDate() + ((TRIP_DEFAULT_WEEKDAY - day.getUTCDay() + 7) % 7))
  return day.toISOString().slice(0, 10)
}

/**
 * One day of a trip of `days` days (the first is the arrival, the last the departure). The
 * template is `(seed + 3·day + 5·variant) mod 8`: 3 and 5 are prime to 8, so the first eight days
 * of a trip differ, and so do the first eight alternatives of a day.
 */
export const tripDay = (
  destination: string,
  day: number,
  days: number,
  variant: number,
  start?: string,
): TripDay => {
  const place = destination.trim()
  const index = (hash(placeKey(place)) + 3 * (day - 1) + 5 * variant) % TEMPLATES.length
  const template = TEMPLATES[index] as Template
  const [morning, afternoon, evening] = template.slots
  const slots: Slot[] =
    day === 1
      ? [ARRIVAL, evening]
      : day === days
        ? [morning, DEPARTURE]
        : [morning, afternoon, evening]
  const theme =
    day === 1 ? 'Arrive and settle in' : day === days ? 'A last morning' : template.theme
  return {
    day,
    ...(start ? { date: addDays(start, day - 1) } : {}),
    theme,
    variant,
    items: slots.map(([time, kind, title, note]) => ({
      time,
      kind,
      title: title.replaceAll('{d}', place),
      note,
    })),
  }
}

/** Per person, in euros: a night's room, and a day's spending. Demo numbers. */
const PRICES: Record<Budget, { night: number; day: number }> = {
  shoestring: { night: 40, day: 35 },
  comfortable: { night: 95, day: 70 },
  luxury: { night: 260, day: 180 },
}

export interface TripEstimate {
  currency: 'EUR'
  perPerson: number
  total: number
}

export const tripEstimate = (nights: number, travellers: number, budget: Budget): TripEstimate => {
  const price = PRICES[budget]
  const perPerson = nights * price.night + (nights + 1) * price.day
  return { currency: 'EUR', perPerson, total: perPerson * travellers }
}

export interface Trip {
  destination: string
  start?: string
  end?: string
  nights: number
  travellers: number
  budget: Budget
}

/** The whole board: the trip, a plan for each of its `nights + 1` days, the estimate. */
export const tripPlan = (trip: Trip, variants: readonly number[] = []) => ({
  trip,
  days: Array.from({ length: trip.nights + 1 }, (_, i) =>
    tripDay(trip.destination, i + 1, trip.nights + 1, variants[i] ?? 0, trip.start),
  ),
  estimate: tripEstimate(trip.nights, trip.travellers, trip.budget),
})

// Crockford's base 32: no I, L, O or U to misread.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * The confirmation code of a demo booking: a hash of everything booked (the place, ignoring case
 * and spaces around it; the dates; the party; the budget; the plan of each day). The same trip,
 * the same code - there is nothing to look it up in.
 */
export const bookingCode = (trip: Trip, variants: readonly number[]): string => {
  const key = [
    placeKey(trip.destination),
    trip.start ?? '',
    trip.nights,
    trip.travellers,
    trip.budget,
    Array.from({ length: trip.nights + 1 }, (_, i) => variants[i] ?? 0).join('.'),
  ].join('|')
  // Four characters (20 bits) from each of two hashes of the key.
  const part = (h: number): string =>
    Array.from({ length: 4 }, (_, i) => CODE_ALPHABET[(h >>> (i * 5)) & 31]).join('')
  return `DEMO-${part(hash(key))}-${part(hash(key, 0x01234567))}`
}

const euros = (value: number): string => `€${value.toLocaleString('en-GB')}`

/** The plan as text: what the model reads, and what a host without MCP Apps shows. */
const planText = (plan: ReturnType<typeof tripPlan>, defaulted = false): string => {
  const { trip, days, estimate } = plan
  const people = trip.travellers === 1 ? '1 traveller' : `${trip.travellers} travellers`
  const nights = trip.nights === 1 ? '1 night' : `${trip.nights} nights`
  const when = trip.start ? ` from ${trip.start} to ${trip.end}` : ''
  const lines = days.map(
    (d) =>
      `Day ${d.day}${d.date ? ` (${d.date})` : ''}, ${d.theme}: ` +
      d.items.map((item) => `${item.time} ${item.title}`).join('; ') +
      '.',
  )
  return [
    `Trip board for ${trip.destination}: ${nights}${when}, ${people}, ${trip.budget} budget.`,
    ...(defaulted
      ? [
          `No first day was given, so the trip starts on ${trip.start}: the first Friday at least ` +
            `${TRIP_DEFAULT_LEAD_DAYS} days from today (UTC). Pass start to plan other dates.`,
        ]
      : []),
    ...lines,
    `Rough estimate: ${euros(estimate.total)} in all, ${euros(estimate.perPerson)} each (demo numbers).`,
    'A host that shows MCP Apps draws this as a board the user works with: other ideas for a ' +
      'day, a demo booking (nothing is booked), the plan sent to the chat.',
  ].join('\n')
}

// ── schemas ─────────────────────────────────────────────────────────────────

const Destination = z.string().min(1).max(80).describe('A city or a region')
const Start = z.iso.date().optional().describe('The first day (YYYY-MM-DD), when it is known')
const BoardStart = z.iso
  .date()
  .optional()
  .describe(
    'The first day (YYYY-MM-DD). Optional: without it the trip starts on the first Friday at ' +
      `least ${TRIP_DEFAULT_LEAD_DAYS} days from today (UTC).`,
  )
const Nights = z.number().int().min(1).max(TRIP_MAX_NIGHTS)
const Travellers = z.number().int().min(1).max(12)
const BudgetSchema = z.enum(BUDGETS)

const Item = z.object({
  time: z.string(),
  kind: z.enum(KINDS),
  title: z.string(),
  note: z.string(),
})

const Day = z.object({
  day: z.number().int().min(1),
  date: z.string().optional(),
  theme: z.string(),
  variant: z.number().int().min(0),
  items: z.array(Item),
})

const Estimate = z.object({
  currency: z.literal('EUR'),
  perPerson: z.number().int().min(0),
  total: z.number().int().min(0),
})

const TripOut = z.object({
  destination: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
  nights: z.number().int(),
  travellers: z.number().int(),
  budget: BudgetSchema,
})

const Variant = z.number().int().min(0).max(999)

const text = (value: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(isError ? { isError: true } : {}),
})

/** The place as given, without the spaces around it; an empty one is the caller's mistake. */
const placeOf = (destination: string): string | undefined => destination.trim() || undefined

const tripOf = (args: {
  destination: string
  start?: string
  nights: number
  travellers: number
  budget: Budget
}): Trip | undefined => {
  const destination = placeOf(args.destination)
  if (!destination) return undefined
  return {
    destination,
    ...(args.start ? { start: args.start, end: addDays(args.start, args.nights) } : {}),
    nights: args.nights,
    travellers: args.travellers,
    budget: args.budget,
  }
}

const NO_PLACE = 'A destination is needed: a city or a region.'

// ── registration ────────────────────────────────────────────────────────────

/** The app's resource: its document, and the policy it asks for (nothing at all). */
const APP_RESOURCE_META = {
  ui: {
    // Empty: no fetch, no script, style, image or font from anywhere, no frame, no <base>.
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    prefersBorder: true,
  },
} as const

export interface TripBoardContext {
  /** The origin the request was sent to: the docs link of the app is on it. */
  origin: string
}

export const registerTripBoard = (server: McpServer, ctx: TripBoardContext): void => {
  server.registerResource(
    'trip-board',
    TRIP_BOARD_URI,
    {
      title: 'Trip board',
      description: 'The interface of trip_board (an MCP App): the plan as cards, day by day.',
      mimeType: MCP_APP_MIME_TYPE,
      _meta: APP_RESOURCE_META,
    },
    // Built when it is read, not for every request: the document's link is on this origin.
    () => ({
      contents: [
        {
          uri: TRIP_BOARD_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: tripBoardHtml(new URL(APP_DOCS_PATH, ctx.origin).href),
          _meta: APP_RESOURCE_META,
        },
      ],
    }),
  )

  server.registerTool(
    'trip_board',
    {
      title: 'Trip board',
      description:
        'Plan a trip day by day (an MCP App: a host that shows apps draws it as a board the ' +
        'user works with - other ideas for a day, a demo booking, the plan sent to the chat). ' +
        'Pass what you know; the plan is made up from the inputs (demo data, no real places or ' +
        'prices), and nothing is booked or kept. The start date is optional: without one the ' +
        `trip starts on the first Friday at least ${TRIP_DEFAULT_LEAD_DAYS} days from today ` +
        '(UTC), so every day has a date.',
      inputSchema: z.object({
        destination: Destination,
        start: BoardStart,
        nights: Nights.default(3).describe(`Nights (1-${TRIP_MAX_NIGHTS})`),
        travellers: Travellers.default(2).describe('Travellers (1-12)'),
        budget: BudgetSchema.default('comfortable'),
      }),
      outputSchema: z.object({ trip: TripOut, days: z.array(Day), estimate: Estimate }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      // The app, in the extension's form and in the deprecated flat key older hosts read (as the
      // extension's own server SDK writes both).
      _meta: {
        ui: { resourceUri: TRIP_BOARD_URI, visibility: ['model', 'app'] },
        'ui/resourceUri': TRIP_BOARD_URI,
      },
    },
    (args) => {
      // No first day: one computed from the day of THIS request (UTC), so the board has dates.
      const defaulted = args.start === undefined
      const trip = tripOf({ ...args, start: args.start ?? defaultTripStart(new Date()) })
      if (!trip) return text(NO_PLACE, true)
      const plan = tripPlan(trip)
      return {
        content: [{ type: 'text', text: planText(plan, defaulted) }],
        structuredContent: plan,
      }
    },
  )

  server.registerTool(
    'reshuffle_day',
    {
      title: 'Other ideas for a day',
      description:
        'For the trip board app only (MCP Apps, visibility "app"): another plan for one day of ' +
        'a trip, computed from the inputs. A model has no use for it: call trip_board.',
      inputSchema: z.object({
        destination: Destination,
        day: z
          .number()
          .int()
          .min(1)
          .max(TRIP_MAX_NIGHTS + 1)
          .describe('The day (1 = arrival)'),
        days: z
          .number()
          .int()
          .min(2)
          .max(TRIP_MAX_NIGHTS + 1)
          .describe('Days of the trip'),
        variant: Variant.describe('Which alternative (the board asks for the next one)'),
        start: Start,
      }),
      outputSchema: Day,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['app'] } },
    },
    ({ destination, day, days, variant, start }) => {
      const place = placeOf(destination)
      if (!place) return text(NO_PLACE, true)
      if (day > days) return text(`Day ${day} is not in a trip of ${days} days.`, true)
      const plan = tripDay(place, day, days, variant, start)
      const items = plan.items.map((item) => `${item.time} ${item.title}`).join('; ')
      return {
        content: [{ type: 'text', text: `Day ${day}, ${plan.theme}: ${items}.` }],
        structuredContent: { ...plan },
      }
    },
  )

  server.registerTool(
    'book_trip',
    {
      title: 'Book the trip (demo)',
      description:
        'For the trip board app only (MCP Apps, visibility "app"). A DEMO booking: nothing is ' +
        'booked, charged or stored, and nothing is sent anywhere; the confirmation code is ' +
        'computed from the inputs, so the same trip always gets the same code. Declared as a ' +
        'write (not read-only) on purpose: a host asks the user before an app runs it, as it ' +
        'would for a real booking.',
      inputSchema: z.object({
        destination: Destination,
        start: Start,
        nights: Nights,
        travellers: Travellers,
        budget: BudgetSchema,
        variants: z
          .array(Variant)
          .optional()
          .describe('The alternative picked for each day, in order (default: the first)'),
      }),
      outputSchema: z.object({
        confirmation: z.string(),
        trip: TripOut,
        total: z.number().int().min(0),
        currency: z.literal('EUR'),
        demo: z.literal(true),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    (args) => {
      const trip = tripOf(args)
      if (!trip) return text(NO_PLACE, true)
      const variants = args.variants ?? []
      if (variants.length > trip.nights + 1) {
        return text(`A trip of ${trip.nights + 1} days has ${trip.nights + 1} plans at most.`, true)
      }
      const confirmation = bookingCode(trip, variants)
      const { total, currency } = tripEstimate(trip.nights, trip.travellers, trip.budget)
      const value = { confirmation, trip, total, currency, demo: true as const }
      return {
        content: [
          {
            type: 'text',
            text:
              `Demo booking ${confirmation}: ${trip.destination}, ${trip.nights} night(s), ` +
              `${trip.travellers} traveller(s), ${euros(total)}. Nothing was booked or charged: ` +
              'the code is computed from the trip, and this server keeps nothing.',
          },
        ],
        structuredContent: value,
      }
    },
  )
}
