import { ProtocolError, ProtocolErrorCode, type McpServer } from '@modelcontextprotocol/server'
import {
  skillEntry,
  SkillsExtension,
  type Skill,
  type SkillReadResult,
  type SkillSource,
} from '@modelcontextprotocol/server/ext/skills'

/**
 * The skills of the demo MCP server: the Skills extension (`io.modelcontextprotocol/skills`,
 * SEP-2640, Beta), which is written against the 2026-07-28 revision - so it is attached to the
 * servers built for that era only (`demo-server.ts`); on the 2025 revisions it is not declared and
 * its methods are unknown.
 *
 * Two small skills that work with this server's own tools:
 *
 * - `skill://demo/trip-planning/SKILL.md`, with `references/checklist.md`: how to plan a trip
 *   here - the details to collect, `plan_trip` for a form, `trip_board` for the days.
 * - `skill://demo/dice-games/SKILL.md`: the rules of Pig and Yacht-lite, played with `roll_dice`.
 *
 * Constants, like everything else here: no storage, no outbound request, no log. The entries
 * (`skills/list`, `skills/get`) are built by the SDK's `skillEntry` from the same strings
 * `resources/read` serves - byte sizes and sha256 digests computed from those bytes (WebCrypto),
 * the frontmatter parsed from the `SKILL.md`, the naming rules checked - on each call: two hashes
 * over a few KiB, nothing kept between requests, and nothing typed by hand that could drift.
 */

/** The organisational prefix of the skills: `skill://demo/<name>/...`, as `ui://demo/...`. */
export const DEMO_SKILLS_PREFIX = 'demo'

/** The most a skill of this server may take, all its files together (a test checks it). */
export const DEMO_SKILL_MAX_BYTES = 8 * 1024

const lines = (...text: string[]): string => `${text.join('\n')}\n`

const TRIP_PLANNING = lines(
  '---',
  'name: trip-planning',
  "description: Plan a trip with this server's tools - gather the details, offer the plan_trip form, lay the days out with trip_board. Use when the user wants to plan a trip, a holiday or a weekend away.",
  '---',
  '',
  '# Trip planning with the demo server',
  '',
  'This server plans trips from what it is given: the plan is demo data (no real places, prices or',
  'bookings) and nothing is kept. Its tools for it:',
  '',
  '- `trip_board` - the trip day by day. `destination` (required: a city or a region), `start`',
  '  (YYYY-MM-DD, optional), `nights` (1-14, default 3), `travellers` (1-12, default 2), `budget`',
  '  (`shoestring`, `comfortable` or `luxury`; default `comfortable`). A host that shows MCP Apps',
  '  draws the result as a board the user works with.',
  '- `plan_trip` - asks the USER for the details in a form (destination, first day, nights,',
  '  travellers, budget, flexible dates) and returns them as one line. It needs the 2026-07-28',
  '  revision of MCP.',
  '- `current_time` - the date today (UTC, or in a time zone), to turn "next Friday" into a date.',
  '',
  'A host may show these names with a prefix (`demo__trip_board`).',
  '',
  '## How to plan',
  '',
  '1. Take the details the user gave: destination, first day, nights, travellers, budget. Never',
  '   make up a destination.',
  '2. No destination, or the user would rather fill in a form? Call `plan_trip` (with the',
  '   destination they named, if any) and wait for its answer. The user answers it, not you:',
  "   never guess the form's values.",
  '3. A relative date ("next weekend", "in May")? Get the date today with `current_time` and work',
  '   out the YYYY-MM-DD. No date at all: leave `start` out - `trip_board` then starts on the',
  '   first Friday at least 14 days ahead - and tell the user which date it picked.',
  '4. Call `trip_board` once, with everything you have. More than 14 nights: plan the first 14',
  '   and say so.',
  '5. Answer briefly: where, the dates, nights, travellers, budget and the estimate in the',
  '   result, and that the plan is a demo. If the host shows the board, point the user to it',
  '   rather than repeating every day.',
  '6. Then offer a list of papers and things to pack: read the file `references/checklist.md` of',
  '   this skill and give only the items that fit this trip.',
  '',
  '## Do not',
  '',
  "- Call `reshuffle_day` or `book_trip` yourself: they are the board's own buttons, for the",
  '  user. `book_trip` books nothing; never say a trip is booked.',
  '- Ask for the same details twice: once `plan_trip` has answered, use its answer.',
)

const TRIP_CHECKLIST = lines(
  '# Trip checklist',
  '',
  'Pick what fits the trip - where, when, how long, who goes - and leave the rest out.',
  '',
  '## Papers and money',
  '',
  '- Passport or ID card, valid for the whole trip (some countries want six months beyond it)',
  '- A visa or a travel authorisation, if the destination asks for one',
  '- Travel insurance: health, cancellation, luggage',
  '- A bank card that works abroad, and a little local cash',
  '- Copies of the documents, kept apart from the originals (and on the phone)',
  '',
  '## Bookings',
  '',
  "- Travel there and back, the first night's stay, anything at a fixed time - written down",
  '- The address of the first night, offline',
  '- Check-in times, and how to get from the station or the airport',
  '',
  '## Phone',
  '',
  '- A roaming plan, or a local SIM or e-SIM',
  '- Offline maps of the destination',
  "- Chargers, a power bank, a plug adapter for the destination's sockets",
  '',
  '## Health',
  '',
  '- The medicines you take, in their packaging, with a copy of the prescription',
  '- A small first-aid kit',
  '- Vaccinations or tests the destination asks for',
  '',
  '## By kind of trip',
  '',
  '- City break: a transit card or app; the days museums close (many close one day a week)',
  '- Beach: sunscreen, a hat, water shoes',
  '- Mountains or hiking: a rain jacket, a map, the forecast each morning, the route left with',
  '  someone',
  '- Winter: warm layers, gloves, shoes with grip',
  '- With children: their documents, snacks, something to do on the way',
  '- A group of five or more: one shared list, and who pays for what',
  '',
  '## The day before',
  '',
  '- Check in online; boarding passes on the phone (and printed, where asked)',
  '- Liquids in hand luggage in containers of 100 ml at most, in one clear bag',
  '- The itinerary left with someone at home',
)

const DICE_GAMES = lines(
  '---',
  'name: dice-games',
  "description: Run the dice games Pig and Yacht-lite with this server's roll_dice tool - the rules, every roll from the tool, the score after each turn. Use when the user wants to play a dice game.",
  '---',
  '',
  '# Dice games with roll_dice',
  '',
  '`roll_dice` rolls `count` dice (1-20) with `sides` sides each (2-1000, default 6) and returns',
  'each roll and the total. A host may show it with a prefix (`demo__roll_dice`).',
  '',
  '## In every game',
  '',
  '- Every die comes from `roll_dice`. Never make up, change or roll again a result, and never',
  '  roll for the user before they say so.',
  '- One move per message: do what the user asked (roll, hold, keep these dice), show the result,',
  '  then ask for their next move. Play your own turns in full, without asking.',
  '- After each turn, show the scores (a small table), so the game can go on from the chat.',
  '- Who starts: each player rolls one die (`count: 1`); the highest starts, a tie rolls again.',
  '- The user may stop at any time: then give the final scores.',
  '',
  '## Pig',
  '',
  'Two or more players; the first to 100 points wins (50 for a short game - ask which).',
  '',
  '1. On a turn, roll one die (`count: 1, sides: 6`) as often as you like, adding each roll to the',
  "   turn's total.",
  "2. A 1 ends the turn, and the turn's total is lost.",
  "3. Hold to add the turn's total to your score; the turn ends.",
  '4. A player who reaches the goal wins at once.',
  '',
  "When you play: hold once your turn's total is 20 or more, or as soon as holding wins. Show each",
  'roll as `rolled 4 - turn total 9`.',
  '',
  '## Yacht-lite',
  '',
  'Five dice, seven rounds, seven boxes; the highest total after seven rounds wins.',
  '',
  '1. A turn is up to three rolls. The first rolls all five dice (`count: 5, sides: 6`). Then the',
  '   player may keep any dice and roll the others again (`count` = how many), twice at most.',
  '2. After the last roll, the player scores the dice in ONE box they have not used yet. Dice that',
  '   fit no free box score 0 in a free box of their choice.',
  '',
  '| Box | Needs | Scores |',
  '| --- | --- | --- |',
  '| Three of a kind | three dice the same | the sum of all five |',
  '| Four of a kind | four dice the same | the sum of all five |',
  '| Full house | three of one value and two of another | 25 |',
  '| Small straight | four in a row (1-2-3-4, 2-3-4-5 or 3-4-5-6) | 30 |',
  '| Large straight | five in a row (1-2-3-4-5 or 2-3-4-5-6) | 40 |',
  '| Yacht | all five the same | 50 |',
  '| Chance | anything | the sum of all five |',
  '',
  'Check the box against the dice before scoring it, and show the boxes after each turn (the used',
  'ones with their scores, the free ones empty). When you play: keep the most dice of one value,',
  'go for a straight when you hold four in a row, and use Chance last.',
)

/** Each skill: its path under `skill://`, and its files (path inside the skill -> text). */
export const DEMO_SKILL_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [`${DEMO_SKILLS_PREFIX}/trip-planning`]: {
    'SKILL.md': TRIP_PLANNING,
    'references/checklist.md': TRIP_CHECKLIST,
  },
  [`${DEMO_SKILLS_PREFIX}/dice-games`]: { 'SKILL.md': DICE_GAMES },
}

/** The `SKILL.md` URI of each skill, in the order `skills/list` names them. */
export const DEMO_SKILL_URIS = Object.keys(DEMO_SKILL_FILES).map(
  (path) => `skill://${path}/SKILL.md`,
)

// URI -> the text served for it. The paths are plain ASCII, so these are the URIs `skillEntry`
// writes into the entries (a test reads every listed URI back).
const SERVED = new Map<string, string>(
  Object.entries(DEMO_SKILL_FILES).flatMap(([path, files]) =>
    Object.entries(files).map(([file, text]): [string, string] => [
      `skill://${path}/${file}`,
      text,
    ]),
  ),
)

const pathOf = (uri: string): string | undefined => {
  const path = uri.startsWith('skill://') && uri.endsWith('/SKILL.md') ? uri.slice(8, -9) : ''
  return Object.hasOwn(DEMO_SKILL_FILES, path) ? path : undefined
}

const entryOf = (path: string): Promise<Skill> =>
  skillEntry(path, DEMO_SKILL_FILES[path] as Record<string, string>)

const source: SkillSource = {
  // One page: a cursor is one this server never gave out (the base protocol: -32602).
  list: async ({ cursor }) => {
    if (cursor !== undefined)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid cursor')
    return { skills: await Promise.all(Object.keys(DEMO_SKILL_FILES).map(entryOf)) }
  },
  // `undefined` for a URI that is not one of ours: the SDK answers -32602, as the spec says.
  get: async (uri) => {
    const path = pathOf(uri)
    return path === undefined ? undefined : entryOf(path)
  },
  read: async (uri): Promise<SkillReadResult | undefined> => {
    const text = SERVED.get(uri)
    return text === undefined ? undefined : { text, mimeType: 'text/markdown' }
  },
}

/**
 * Serve the skills on one server (one per request, 2026-07-28 only): `skills/list`,
 * `skills/get`, the `skill://` files through `resources/read`, and the extension in the
 * capabilities. `strict`: an entry that broke a rule is an error on the wire, not a skill that
 * silently vanishes; warnings go nowhere (nothing is logged).
 */
export const attachDemoSkills = (server: McpServer): void => {
  new SkillsExtension({ source, strict: true, onWarning: () => {} }).attach(server)
}
