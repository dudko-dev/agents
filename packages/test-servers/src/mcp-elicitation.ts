import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The elicitation tools of the test MCP server, written once for both protocol
 * eras: a tool is a step function that looks at what the client has answered so
 * far and either finishes or asks for more.
 *
 * - On the 2026-07-28 revision a step that asks becomes an `input_required`
 *   result (Multi Round-Trip Requests): the client answers and retries the call
 *   with `inputResponses` and the `requestState` it was given, byte for byte.
 * - On the 2025 revisions the server drives the same steps itself: every
 *   question is a real `elicitation/create` request sent to the client on the
 *   stream of the tool call, and the state never leaves the server.
 *
 * `mcp-server.ts` owns both drivers; nothing here knows about a transport.
 */

/** One `elicitation/create` request, in either mode. */
export type ElicitationRequest =
  | { mode: 'form'; message: string; requestedSchema: Record<string, unknown> }
  | {
      mode: 'url'
      message: string
      url: string
      /** Required on the 2025-11-25 wire; the 2026-07-28 request carries none. */
      elicitationId: string
    }

/** A tool result, as both SDK generations accept it. */
export type IToolResult = {
  // Both SDKs type a result as an open record.
  [key: string]: unknown
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** What a step answers: the final result, or what it still needs. */
export type ToolOutcome =
  { result: IToolResult } | { ask?: Record<string, ElicitationRequest>; state?: string }

/** What `requestState` holds once it is opened: which tool minted it, and where that tool is. */
export interface IStatePayload {
  tool: string
  step: string
  data: Record<string, unknown>
  /** Seconds since the epoch: after it the state is refused. */
  exp: number
}

/** One entry into a tool: what the client sent this time. */
export interface IToolRound {
  era: 'legacy' | 'modern'
  /**
   * The `elicitation` capability the client declared: on the request itself
   * (modern), in the latest `initialize` (legacy). `undefined`: not declared.
   */
  capabilities: Record<string, unknown> | undefined
  /** The answers of this round, keyed like the questions. `undefined` on a first call. */
  responses: Record<string, unknown> | undefined
  /** `requestState` exactly as it arrived. */
  rawState: string | undefined
  /** The same, verified and opened. */
  state: IStatePayload | undefined
}

/** What the server recorded about one round of an elicitation tool. */
export interface IElicitationRound {
  tool: string
  era: 'legacy' | 'modern'
  /** The client's declared `elicitation` capability, as the server knew it. */
  capabilities: Record<string, unknown> | undefined
  /** `inputResponses` of this round (legacy: the results of the requests the server sent). */
  responses: Record<string, unknown> | undefined
  /** `requestState` exactly as it came back. */
  requestState: string | undefined
  /** Whether that state passed verification. `undefined`: the round carried none. */
  stateValid: boolean | undefined
  /** The questions the server answered this round with. Absent when it answered a result or an error. */
  asked?: Record<string, ElicitationRequest>
  /** The `requestState` the server handed out this round. */
  issuedState?: string
}

/** A page a URL-mode elicitation points at. */
export interface IUrlElicitation {
  id: string
  url: string
  /** How many times the page was fetched. */
  opened: number
  /** Whether the page was submitted (`POST` to its URL). */
  completed: boolean
}

/** How the elicitation tools go wrong (see `ILocalMcpServer.elicitationFaults`). */
export interface IElicitationFaults {
  /** Ask again on every round, whatever the client answered: a client must give up by itself. */
  neverSatisfied?: boolean
  /**
   * Ask in a mode the client did not declare: URL mode from a client that
   * declared the form only (or nothing), a form from one that declared URL
   * mode only. A client that declared both gets the tool's normal behaviour.
   */
  undeclaredMode?: boolean
  /**
   * Hand out a `requestState` whose signature is broken: echoed exactly as
   * given, it still fails verification, and the retry is refused.
   */
  tamperState?: boolean
  /**
   * Ask every form with a schema a form may not have: `'nested'` (a field that
   * is itself an object - outside the flat subset the specification allows),
   * `'huge'` (`ELICIT_HUGE_FIELDS` string fields: each one allowed, the form
   * as a whole more than a client should show). A client must refuse it.
   */
  formSchema?: 'nested' | 'huge'
  /**
   * Leave the user's answers out of the tool results: a result then says only
   * `{ tool, action }`. For tests that look for an answer where it must not be
   * (the model's context, events, logs): nothing but the client could have
   * put it there.
   */
  quietResult?: boolean
}

/** An elicitation tool: its listing and its step function. */
export interface IElicitationTool {
  name: string
  description: string
  step: (round: IToolRound) => ToolOutcome | Promise<ToolOutcome>
}

/**
 * The form `elicit_form` asks for: every field type form mode allows
 * (2026-07-28, client/elicitation, "Requested Schema") - a string with length
 * limits, the four string formats, a number and an integer with bounds, a
 * boolean, both single-select forms and both multi-select forms, with defaults.
 */
export const ELICIT_FORM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name', description: 'Your name', minLength: 1, maxLength: 40 },
    email: { type: 'string', title: 'Email', format: 'email' },
    website: { type: 'string', title: 'Website', format: 'uri' },
    birthday: { type: 'string', title: 'Birthday', format: 'date' },
    meeting: { type: 'string', title: 'Meeting', format: 'date-time' },
    score: { type: 'number', title: 'Score', minimum: 0, maximum: 10, default: 5 },
    seats: { type: 'integer', title: 'Seats', minimum: 1, maximum: 8 },
    subscribe: { type: 'boolean', title: 'Subscribe', default: false },
    color: { type: 'string', title: 'Color', enum: ['red', 'green', 'blue'], default: 'red' },
    size: {
      type: 'string',
      title: 'Size',
      oneOf: [
        { const: 's', title: 'Small' },
        { const: 'l', title: 'Large' },
      ],
    },
    toppings: {
      type: 'array',
      title: 'Toppings',
      minItems: 1,
      maxItems: 2,
      items: { type: 'string', enum: ['olives', 'basil', 'capers'] },
    },
    languages: {
      type: 'array',
      title: 'Languages',
      items: {
        anyOf: [
          { const: 'en', title: 'English' },
          { const: 'pt', title: 'Portuguese' },
        ],
      },
      default: ['en'],
    },
  },
  required: ['name', 'email'],
} satisfies Record<string, unknown>

/** How many fields the `formSchema: 'huge'` fault asks for. */
export const ELICIT_HUGE_FIELDS = 51

const NESTED_SCHEMA = {
  type: 'object',
  properties: {
    address: {
      type: 'object',
      title: 'Address',
      properties: { street: { type: 'string' }, city: { type: 'string' } },
    },
  },
  required: ['address'],
}

const HUGE_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(
    Array.from({ length: ELICIT_HUGE_FIELDS }, (_, i) => [`field_${i + 1}`, { type: 'string' }]),
  ),
}

const NAME_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', title: 'Name', minLength: 1 } },
  required: ['name'],
}
const COLOR_SCHEMA = {
  type: 'object',
  properties: { color: { type: 'string', title: 'Color', enum: ['red', 'green', 'blue'] } },
  required: ['color'],
}
const CONFIRM_SCHEMA = {
  type: 'object',
  properties: { confirm: { type: 'boolean', title: 'Confirm' } },
  required: ['confirm'],
}

type FieldSchema = Record<string, unknown>

const constsOf = (options: unknown): unknown[] =>
  Array.isArray(options) ? options.map((o) => (o as { const?: unknown }).const) : []

const validString = (schema: FieldSchema, value: string): boolean => {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false
  if (Array.isArray(schema.oneOf) && !constsOf(schema.oneOf).includes(value)) return false
  switch (schema.format) {
    case 'email':
      return /^[^@\s]+@[^@\s]+$/.test(value)
    case 'uri':
      return URL.canParse(value)
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    case 'date-time':
      return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))
    default:
      return true
  }
}

const validField = (schema: FieldSchema, value: unknown): boolean => {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' && validString(schema, value)
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.type === 'number' || Number.isInteger(value)) &&
        (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
        (typeof schema.maximum !== 'number' || value <= schema.maximum)
      )
    case 'boolean':
      return typeof value === 'boolean'
    case 'array': {
      const items = (schema.items ?? {}) as FieldSchema
      const allowed = Array.isArray(items.enum) ? items.enum : constsOf(items.anyOf)
      return (
        Array.isArray(value) &&
        (typeof schema.minItems !== 'number' || value.length >= schema.minItems) &&
        (typeof schema.maxItems !== 'number' || value.length <= schema.maxItems) &&
        value.every((item) => allowed.includes(item))
      )
    }
    default:
      return false
  }
}

/**
 * Whether accepted form content matches the schema that was asked for (the
 * restricted subset only). A server should check what comes back: the client
 * is not obliged to have validated it.
 */
export const validFormContent = (schema: Record<string, unknown>, content: unknown): boolean => {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    return false
  }
  const values = content as Record<string, unknown>
  const properties = (schema.properties ?? {}) as Record<string, FieldSchema>
  const required = (schema.required ?? []) as string[]
  return (
    required.every((name) => values[name] !== undefined) &&
    Object.entries(properties).every(
      ([name, field]) => values[name] === undefined || validField(field, values[name]),
    )
  )
}

/**
 * Whether a declared `elicitation` capability covers a mode. An empty object
 * means the form only (client/elicitation, "Capabilities").
 */
export const declaresElicitation = (
  capabilities: Record<string, unknown> | undefined,
  mode: 'form' | 'url',
): boolean => {
  if (capabilities === undefined) {
    return false
  }
  const url = capabilities.url !== undefined
  return mode === 'url' ? url : capabilities.form !== undefined || !url
}

interface IAnswer {
  action: 'accept' | 'decline' | 'cancel'
  content?: unknown
}

/** One answer of the round, if it has the shape of an elicitation result. */
const answerOf = (responses: Record<string, unknown> | undefined, key: string) => {
  const value = responses?.[key] as IAnswer | undefined
  return value && ['accept', 'decline', 'cancel'].includes(value.action) ? value : undefined
}

const text = (value: string, isError = false): { result: IToolResult } => ({
  result: { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) },
})

/** The result of a tool whose user said no: the action, and no error (it is a valid outcome). */
const refused = (tool: string, action: string) => text(JSON.stringify({ tool, action }))

interface IPage extends IUrlElicitation {
  waiters: Set<() => void>
}

export interface IElicitationOptions {
  /** The server's origin: URL-mode pages live under it. Read lazily (known once listening). */
  origin: () => string
  /** How long a round of `elicit_url` waits for its page to be submitted. */
  urlWaitMs: number
}

export interface IElicitation {
  tools: IElicitationTool[]
  faults: IElicitationFaults
  rounds: IElicitationRound[]
  urlElicitations: IUrlElicitation[]
  /** Run one round of a tool, with the faults applied, and record it. */
  advance: (tool: IElicitationTool, round: IToolRound) => Promise<ToolOutcome>
  /** Verify and open a `requestState` this server minted for `tool`. Throws when it is not one. */
  openState: (raw: string, tool: string) => IStatePayload
  /** Record a round that ended before the tool ran: its state was refused. */
  refuseState: (round: Omit<IToolRound, 'state'>, tool: string) => void
  /** Whether a URL-mode page was submitted. */
  completed: (id: string) => boolean
  /** Serve `/elicit/<id>`. Returns false when the path is not a page of ours. */
  handlePage: (req: IncomingMessage, res: ServerResponse, path: string) => boolean
  /** Let go of everything that waits for a page. */
  close: () => void
}

const STATE_TTL_SECONDS = 600

const html = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>Test elicitation</title>${body}`)
}

export const createElicitation = (opts: IElicitationOptions): IElicitation => {
  const faults: IElicitationFaults = {}
  const rounds: IElicitationRound[] = []
  const pages = new Map<string, IPage>()
  const urlElicitations: IUrlElicitation[] = []
  // Made at start-up, gone with the process: a state from another run is refused.
  const key = randomBytes(32)

  const mac = (body: string): Buffer => createHmac('sha256', key).update(body).digest()

  const seal = (tool: string, step: string, data: Record<string, unknown> = {}): string => {
    const payload: IStatePayload = {
      tool,
      step,
      data,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    }
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = mac(body)
    if (faults.tamperState) {
      signature[0] ^= 0xff
    }
    return `${body}.${signature.toString('base64url')}`
  }

  const openState = (raw: string, tool: string): IStatePayload => {
    const [body, signature, ...rest] = raw.split('.')
    const given = Buffer.from(signature ?? '', 'base64url')
    const expected = mac(body ?? '')
    if (
      rest.length > 0 ||
      !body ||
      !signature ||
      // The exact bytes that were handed out, not something that decodes to them.
      given.toString('base64url') !== signature ||
      given.length !== expected.length ||
      !timingSafeEqual(given, expected)
    ) {
      throw new Error('requestState signature does not verify')
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as IStatePayload
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('requestState expired')
    }
    if (payload.tool !== tool) {
      throw new Error(`requestState was issued to ${payload.tool}, not ${tool}`)
    }
    return payload
  }

  const newPage = (): IPage => {
    const id = randomUUID()
    const page: IPage = {
      id,
      url: `${opts.origin()}/elicit/${id}`,
      opened: 0,
      completed: false,
      waiters: new Set(),
    }
    pages.set(id, page)
    urlElicitations.push(page)
    return page
  }

  const urlRequest = (message: string, page: IPage): ElicitationRequest => ({
    mode: 'url',
    message,
    url: page.url,
    elicitationId: page.id,
  })

  const waitForPage = (id: string, ms: number): Promise<boolean> => {
    const page = pages.get(id)
    if (!page || page.completed) {
      return Promise.resolve(page?.completed ?? false)
    }
    return new Promise<boolean>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        page.waiters.delete(done)
        resolve(page.completed)
      }
      const timer = setTimeout(done, ms)
      page.waiters.add(done)
    })
  }

  const formTool: IElicitationTool = {
    name: 'elicit_form',
    description:
      'Ask the user to fill in a profile form (every field type a form may have) and return what they entered',
    step: ({ responses }) => {
      const ask = {
        ask: {
          profile: {
            mode: 'form' as const,
            message: 'Fill in the profile',
            requestedSchema: ELICIT_FORM_SCHEMA,
          },
        },
      }
      const answer = answerOf(responses, 'profile')
      if (!answer) {
        return ask
      }
      if (answer.action !== 'accept') {
        return refused('elicit_form', answer.action)
      }
      // Content that breaks the schema is asked for again, not failed (MRTR, "Error Handling").
      return validFormContent(ELICIT_FORM_SCHEMA, answer.content)
        ? text(JSON.stringify({ tool: 'elicit_form', action: 'accept', content: answer.content }))
        : ask
    },
  }

  const urlTool: IElicitationTool = {
    name: 'elicit_url',
    description:
      'Send the user to a page of this server and finish once they have submitted it there',
    step: async ({ state, responses }) => {
      if (!state) {
        const page = newPage()
        return {
          ask: { link: urlRequest('Open the page and press the button to continue', page) },
          state: seal('elicit_url', 'link', { id: page.id }),
        }
      }
      const answer = answerOf(responses, 'link')
      if (answer && answer.action !== 'accept') {
        return refused('elicit_url', answer.action)
      }
      // `accept` is consent to open the page, not the page's outcome: the
      // server finds that out by itself, and asks to be called again if the
      // user has not finished yet.
      const id = String(state.data.id)
      return (await waitForPage(id, opts.urlWaitMs))
        ? text(JSON.stringify({ tool: 'elicit_url', action: 'accept', completed: id }))
        : { state: seal('elicit_url', 'link', { id }) }
    },
  }

  const twiceTool: IElicitationTool = {
    name: 'elicit_twice',
    description: 'Ask for a name, then for a favourite color, in two separate rounds',
    step: ({ state, responses }) => {
      const askName = {
        ask: {
          name: { mode: 'form' as const, message: 'Who is it?', requestedSchema: NAME_SCHEMA },
        },
        state: seal('elicit_twice', 'name'),
      }
      if (!state) {
        return askName
      }
      const key = state.step === 'color' ? 'color' : 'name'
      const answer = answerOf(responses, key)
      if (answer && answer.action !== 'accept') {
        return refused('elicit_twice', answer.action)
      }
      if (key === 'name') {
        if (!answer || !validFormContent(NAME_SCHEMA, answer.content)) {
          return askName
        }
        // Each round carries only its own answers: the name travels in the state.
        const { name } = answer.content as { name: string }
        return {
          ask: {
            color: {
              mode: 'form' as const,
              message: `Which color does ${name} like?`,
              requestedSchema: COLOR_SCHEMA,
            },
          },
          state: seal('elicit_twice', 'color', { name }),
        }
      }
      const name = String(state.data.name)
      if (!answer || !validFormContent(COLOR_SCHEMA, answer.content)) {
        return {
          ask: {
            color: {
              mode: 'form' as const,
              message: `Which color does ${name} like?`,
              requestedSchema: COLOR_SCHEMA,
            },
          },
          state: seal('elicit_twice', 'color', { name }),
        }
      }
      const { color } = answer.content as { color: string }
      return text(JSON.stringify({ tool: 'elicit_twice', action: 'accept', name, color }))
    },
  }

  const stateTool: IElicitationTool = {
    name: 'elicit_state',
    description:
      'Ask for a confirmation and finish only if the state handed out with the question comes back untouched',
    step: ({ state, responses }) => {
      if (!state) {
        return {
          ask: {
            confirm: {
              mode: 'form' as const,
              message: 'Confirm to continue',
              requestedSchema: CONFIRM_SCHEMA,
            },
          },
          state: seal('elicit_state', 'confirm', { nonce: randomUUID() }),
        }
      }
      const answer = answerOf(responses, 'confirm')
      return text(
        JSON.stringify({
          tool: 'elicit_state',
          action: answer?.action ?? 'missing',
          nonce: state.data.nonce,
        }),
      )
    },
  }

  /** The mode the client did not declare, if there is one. */
  const undeclaredMode = (
    capabilities: Record<string, unknown> | undefined,
  ): 'form' | 'url' | undefined =>
    !declaresElicitation(capabilities, 'url')
      ? 'url'
      : !declaresElicitation(capabilities, 'form')
        ? 'form'
        : undefined

  const advance = async (tool: IElicitationTool, round: IToolRound): Promise<ToolOutcome> => {
    const record: IElicitationRound = {
      tool: tool.name,
      era: round.era,
      capabilities: round.capabilities,
      responses: round.responses,
      requestState: round.rawState,
      stateValid: round.rawState === undefined ? undefined : true,
    }
    rounds.push(record)
    const mode = faults.undeclaredMode ? undeclaredMode(round.capabilities) : undefined
    let outcome: ToolOutcome
    if (mode) {
      const answer = answerOf(round.responses, 'undeclared')
      outcome =
        round.responses === undefined
          ? {
              ask: {
                undeclared:
                  mode === 'url'
                    ? urlRequest('Open the page to continue', newPage())
                    : {
                        mode: 'form',
                        message: 'Confirm to continue',
                        requestedSchema: CONFIRM_SCHEMA,
                      },
              },
            }
          : text(
              JSON.stringify({ tool: tool.name, undeclared: mode, action: answer?.action ?? null }),
            )
    } else if (faults.neverSatisfied) {
      outcome = await tool.step({
        ...round,
        responses: undefined,
        rawState: undefined,
        state: undefined,
      })
    } else {
      outcome = await tool.step(round)
    }
    if (!('result' in outcome)) {
      if (faults.formSchema && outcome.ask) {
        const requestedSchema = faults.formSchema === 'nested' ? NESTED_SCHEMA : HUGE_SCHEMA
        outcome = {
          ...outcome,
          ask: Object.fromEntries(
            Object.entries(outcome.ask).map(([key, request]) => [
              key,
              request.mode === 'form' ? { ...request, requestedSchema } : request,
            ]),
          ),
        }
      }
      record.asked = outcome.ask
      record.issuedState = outcome.state
    } else if (faults.quietResult && !outcome.result.isError) {
      const first = outcome.result.content[0]
      try {
        const said = JSON.parse(first?.type === 'text' ? first.text : '') as Record<string, unknown>
        outcome = text(JSON.stringify({ tool: said.tool, action: said.action }))
      } catch {
        // Not one of the JSON answers: left as it is.
      }
    }
    return outcome
  }

  return {
    tools: [formTool, urlTool, twiceTool, stateTool],
    faults,
    rounds,
    urlElicitations,
    advance,
    openState,
    refuseState: (round, tool) => {
      rounds.push({
        tool,
        era: round.era,
        capabilities: round.capabilities,
        responses: round.responses,
        requestState: round.rawState,
        stateValid: false,
      })
    },
    completed: (id) => pages.get(id)?.completed ?? false,
    handlePage: (req, res, path) => {
      const match = /^\/elicit\/([^/]+)$/.exec(path)
      if (!match) {
        return false
      }
      const page = pages.get(match[1])
      if (!page) {
        html(res, 404, '<p>No such elicitation.</p>')
      } else if (req.method === 'POST') {
        page.completed = true
        for (const wake of [...page.waiters]) {
          wake()
        }
        html(res, 200, '<p id="done">Done. You can close this page.</p>')
      } else if (req.method === 'GET') {
        page.opened += 1
        html(
          res,
          200,
          page.completed
            ? '<p id="done">Done. You can close this page.</p>'
            : '<p>A test MCP server asks you to continue.</p><form method="post"><button id="complete" type="submit">Continue</button></form>',
        )
      } else {
        res.writeHead(405, { allow: 'GET, POST' })
        res.end()
      }
      return true
    },
    close: () => {
      for (const page of pages.values()) {
        for (const wake of [...page.waiters]) {
          wake()
        }
      }
    },
  }
}
