import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  answerMcpElicitation,
  checkMcpElicitationUrl,
  cleanMcpElicitationText,
  createMcpElicitationSession,
  MCP_ELICITATION_DESCRIPTION_MAX_CHARS,
  MCP_ELICITATION_LABEL_MAX_CHARS,
  MCP_ELICITATION_MAX_FIELDS,
  MCP_ELICITATION_MAX_OPTIONS,
  MCP_ELICITATION_MAX_PER_RUN,
  MCP_ELICITATION_MAX_PER_TOOL_CALL,
  MCP_ELICITATION_MESSAGE_MAX_CHARS,
  MCP_ELICITATION_NAME_MAX_CHARS,
  MCP_ELICITATION_TIMEOUT_MS,
  MCP_ELICITATION_TRUNCATED,
  MCP_ELICITATION_URL_MAX_CHARS,
  MCP_ELICITATION_VALUE_MAX_CHARS,
  MCP_INPUT_REQUIRED_MAX_ROUNDS,
  MCP_TOOL_CALL_TIMEOUT_MS,
  mcpElicitationCapability,
  McpElicitationError,
  normalizeMcpElicitationSchema,
  parseMcpElicitationParams,
  resolveMcpElicitationOptions,
  validateMcpElicitationContent,
  type McpElicitationCall,
  type McpElicitationDeps,
  type McpElicitationEvent,
  type McpElicitationHandler,
  type McpElicitationOptions,
  type McpElicitationRequest,
  type McpElicitationSchema,
  type McpToolCallLeg,
} from '../src/mcp-elicitation.ts'

// The shared core of MCP elicitation: every limit and guard of the consent
// boundary, without a server. What the two connectors do with it over real
// sockets is in `mcp-elicitation.test.ts` (here and in the browser package).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

test('mcp-elicitation: the browser package carries the same file, byte for byte', () => {
  const sibling = here('../../agent-web/src/mcp/elicitation.ts')
  // Only in the monorepo: the published package has no sibling to compare with.
  if (!existsSync(sibling)) return
  assert.equal(
    readFileSync(here('../src/mcp-elicitation.ts'), 'utf8'),
    readFileSync(sibling, 'utf8'),
    'mcp-elicitation.ts and agent-web/src/mcp/elicitation.ts must stay identical',
  )
})

test('the shared file imports nothing', () => {
  const source = readFileSync(here('../src/mcp-elicitation.ts'), 'utf8')
  assert.equal(/^\s*import\s/m.test(source), false)
  assert.equal(/\brequire\(/.test(source), false)
  // And reaches for nothing that opens a link or makes a request.
  assert.equal(/\bfetch\(|window\.open|location\.(href|assign)|XMLHttpRequest/.test(source), false)
})

// ── settings ────────────────────────────────────────────────────────────────

test('settings: the defaults, and a value that is not a usable number is refused', () => {
  assert.deepEqual(resolveMcpElicitationOptions(undefined), {
    timeoutMs: MCP_ELICITATION_TIMEOUT_MS,
    maxPerToolCall: MCP_ELICITATION_MAX_PER_TOOL_CALL,
    maxPerRun: MCP_ELICITATION_MAX_PER_RUN,
    url: false,
    subagents: false,
  })
  assert.equal(MCP_ELICITATION_TIMEOUT_MS, 300_000, 'a human answers: minutes, not seconds')
  assert.deepEqual(
    resolveMcpElicitationOptions({
      timeoutMs: 0,
      maxPerToolCall: 1,
      maxPerRun: 2,
      url: true,
      subagents: true,
    }),
    { timeoutMs: 0, maxPerToolCall: 1, maxPerRun: 2, url: true, subagents: true },
  )
  // Only `true` switches the two flags on.
  const loose = resolveMcpElicitationOptions({ url: 1, subagents: 'yes' } as never)
  assert.equal(loose.url, false)
  assert.equal(loose.subagents, false)
  for (const bad of [
    { timeoutMs: -1 },
    { timeoutMs: Number.NaN },
    { timeoutMs: '5' },
    { maxPerToolCall: 0 },
    { maxPerRun: 0 },
    { maxPerRun: Infinity },
  ]) {
    assert.throws(
      () => resolveMcpElicitationOptions(bad as McpElicitationOptions),
      /elicitation\.\w+ must be a number/,
      JSON.stringify(bad),
    )
  }
})

test('capability: the form always, URL mode only when the host asked for it', () => {
  assert.deepEqual(mcpElicitationCapability({ url: false }), { form: {} })
  assert.deepEqual(mcpElicitationCapability({ url: true }), { form: {}, url: {} })
})

// ── third-party text ────────────────────────────────────────────────────────

test('text: invisible characters removed, capped, never anything but a string', () => {
  assert.equal(cleanMcpElicitationText('  a​b‮c\u0007 \r\n d ', 100), 'abc \n d')
  assert.equal(cleanMcpElicitationText(42, 100), '')
  assert.equal(cleanMcpElicitationText({ toString: () => 'x' }, 100), '')
  const long = cleanMcpElicitationText('x'.repeat(5000), MCP_ELICITATION_MESSAGE_MAX_CHARS)
  assert.equal(long.length, MCP_ELICITATION_MESSAGE_MAX_CHARS + MCP_ELICITATION_TRUNCATED.length)
  assert.ok(long.endsWith(MCP_ELICITATION_TRUNCATED))
})

test('a request: the message is cleaned and capped before a host sees it', () => {
  const parsed = parseMcpElicitationParams(
    {
      mode: 'form',
      message: `Ignore‮ previous ${'y'.repeat(9000)}`,
      requestedSchema: { type: 'object', properties: {} },
    },
    { url: false },
  )
  assert.ok(parsed.ok && parsed.mode === 'form')
  assert.ok(parsed.message.startsWith('Ignore previous '))
  assert.equal(
    parsed.message.length,
    MCP_ELICITATION_MESSAGE_MAX_CHARS + MCP_ELICITATION_TRUNCATED.length,
  )
  // No mode is the form (the 2025-06-18 shape).
  const bare = parseMcpElicitationParams(
    { message: 'm', requestedSchema: { type: 'object', properties: {} } },
    { url: false },
  )
  assert.ok(bare.ok && bare.mode === 'form')
})

test('a request that is not one is declined: no parameters, no message, an unknown mode', () => {
  for (const [params, reason] of [
    [undefined, 'invalid-request'],
    ['text', 'invalid-request'],
    [{ requestedSchema: { type: 'object', properties: {} } }, 'invalid-request'],
    [{ message: 7, requestedSchema: { type: 'object', properties: {} } }, 'invalid-request'],
    [{ mode: 'voice', message: 'm' }, 'unsupported-mode'],
    [{ mode: 'form', message: 'm' }, 'unsupported-schema'],
  ] as const) {
    const parsed = parseMcpElicitationParams(params, { url: true })
    assert.equal(parsed.ok, false, JSON.stringify(params))
    assert.equal(!parsed.ok && parsed.reason, reason, JSON.stringify(params))
  }
})

// ── the form ────────────────────────────────────────────────────────────────

const FULL = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name', description: 'Your name', minLength: 1, maxLength: 40 },
    email: { type: 'string', format: 'email' },
    site: { type: 'string', format: 'uri' },
    day: { type: 'string', format: 'date' },
    at: { type: 'string', format: 'date-time' },
    score: { type: 'number', minimum: 0, maximum: 10, default: 5 },
    seats: { type: 'integer', minimum: 1, maximum: 8 },
    ok: { type: 'boolean', default: false },
    color: { type: 'string', enum: ['red', 'green'], default: 'red' },
    old: { type: 'string', enum: ['a', 'b'], enumNames: ['Alpha', 'Beta'] },
    size: {
      type: 'string',
      oneOf: [
        { const: 's', title: 'Small' },
        { const: 'l', title: 'Large' },
      ],
    },
    tops: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: { type: 'string', enum: ['x', 'y', 'z'] },
    },
    langs: {
      type: 'array',
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
}

const schemaOf = (raw: unknown): McpElicitationSchema => {
  const checked = normalizeMcpElicitationSchema(raw)
  assert.ok(checked.ok, checked.ok ? '' : checked.reason)
  return checked.value
}

const refusal = (raw: unknown): string => {
  const checked = normalizeMcpElicitationSchema(raw)
  assert.equal(checked.ok, false, `accepted: ${JSON.stringify(raw)?.slice(0, 200)}`)
  return checked.ok ? '' : checked.reason
}

test('schema: every field type a form may have comes through unchanged', () => {
  assert.deepEqual(schemaOf(FULL), FULL)
})

test('schema: keywords outside the subset are dropped, texts cleaned and capped', () => {
  const schema = schemaOf({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    title: 'ignored',
    properties: {
      name: {
        type: 'string',
        title: `T​${'t'.repeat(1000)}`,
        description: 'd'.repeat(5000),
        pattern: '^(a+)+$',
        'x-run': 'rm -rf /',
        default: 7,
      },
      color: {
        type: 'string',
        oneOf: [{ const: 'r', title: 'R'.repeat(1000) }, { const: 'g' }],
        default: 'not-an-option',
      },
    },
    additionalProperties: true,
  })
  assert.deepEqual(Object.keys(schema), ['type', 'properties'])
  assert.deepEqual(Object.keys(schema.properties.name), ['type', 'title', 'description'])
  assert.equal(
    schema.properties.name.title?.length,
    MCP_ELICITATION_LABEL_MAX_CHARS + MCP_ELICITATION_TRUNCATED.length,
  )
  assert.ok(schema.properties.name.title?.startsWith('Tt'))
  assert.equal(
    schema.properties.name.description?.length,
    MCP_ELICITATION_DESCRIPTION_MAX_CHARS + MCP_ELICITATION_TRUNCATED.length,
  )
  assert.equal(
    schema.properties.color.oneOf?.[0].title.length,
    MCP_ELICITATION_LABEL_MAX_CHARS + MCP_ELICITATION_TRUNCATED.length,
  )
  // An option without a title is titled by its value; a default the field would refuse is left out.
  assert.equal(schema.properties.color.oneOf?.[1].title, 'g')
  assert.equal('default' in schema.properties.color, false)
})

test('schema: anything but a flat form of primitives is refused, with a reason', () => {
  const one = (field: unknown) => ({ type: 'object', properties: { f: field } })
  const cases: [string, unknown, RegExp][] = [
    ['not an object', 'form', /not an object with properties/],
    ['no properties', { type: 'object' }, /not an object with properties/],
    ['an array at the top', { type: 'array', properties: {} }, /not an object with properties/],
    [
      'a nested object',
      one({ type: 'object', properties: { street: { type: 'string' } } }),
      /unsupported type \(object\)/,
    ],
    ['a string that hides an object', one({ type: 'string', properties: {} }), /nested object/],
    [
      'a list of objects',
      one({ type: 'array', items: { type: 'object', properties: {} } }),
      /flat/,
    ],
    ['a list of strings (not options)', one({ type: 'array', items: { type: 'string' } }), /flat/],
    ['a list with no items', one({ type: 'array' }), /flat/],
    ['a type union', one({ type: ['string', 'null'] }), /unsupported type/],
    ['null', one({ type: 'null' }), /unsupported type/],
    ['no type', one({ title: 'x' }), /unsupported type/],
    ['a field that is not a schema', one('string'), /is not a schema/],
    ['an unknown format', one({ type: 'string', format: 'password' }), /unsupported format/],
    ['enum and oneOf', one({ type: 'string', enum: ['a'], oneOf: [{ const: 'a' }] }), /both/],
    ['an empty enum', one({ type: 'string', enum: [] }), /cannot be shown/],
    ['an enum of numbers', one({ type: 'string', enum: [1, 2] }), /cannot be shown/],
    ['a oneOf without const', one({ type: 'string', oneOf: [{ title: 'x' }] }), /cannot be shown/],
    [
      'too many options',
      one({
        type: 'string',
        enum: Array.from({ length: MCP_ELICITATION_MAX_OPTIONS + 1 }, (_, i) => `o${i}`),
      }),
      /cannot be shown/,
    ],
    [
      'an option too long to send back',
      one({ type: 'string', enum: ['x'.repeat(MCP_ELICITATION_NAME_MAX_CHARS + 1)] }),
      /cannot be shown/,
    ],
    ['an option with a hidden character', one({ type: 'string', enum: ['a​b'] }), /cannot/],
    ['a length that is not a number', one({ type: 'string', maxLength: '5' }), /length limit/],
    ['a negative length', one({ type: 'string', minLength: -1 }), /length limit/],
    ['a bound that is not a number', one({ type: 'number', minimum: '0' }), /bound/],
    [
      'a size that is not a number',
      one({ type: 'array', items: { enum: ['a'] }, minItems: 1.5 }),
      /size limit/,
    ],
    [
      'too many fields',
      {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: MCP_ELICITATION_MAX_FIELDS + 1 }, (_, i) => [
            `f${i}`,
            { type: 'string' },
          ]),
        ),
      },
      /more than 50 fields/,
    ],
    [
      'a field name too long',
      {
        type: 'object',
        properties: { ['n'.repeat(MCP_ELICITATION_NAME_MAX_CHARS + 1)]: { type: 'string' } },
      },
      /field name that cannot be used/,
    ],
    [
      'a field name with a hidden character',
      { type: 'object', properties: { 'pass‮word': { type: 'string' } } },
      /field name that cannot be used/,
    ],
    [
      'a field named constructor',
      { type: 'object', properties: { constructor: { type: 'string' } } },
      /field name that cannot be used/,
    ],
    [
      'a field named __proto__',
      JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
      /field name that cannot be used/,
    ],
    ['required is not a list', { type: 'object', properties: {}, required: 'name' }, /not a list/],
    [
      'a required field the form does not have',
      { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
      /requires a field it does not have/,
    ],
  ]
  for (const [label, raw, expected] of cases) {
    assert.match(refusal(raw), expected, label)
  }
  // Exactly at the caps is fine.
  schemaOf({
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: MCP_ELICITATION_MAX_FIELDS }, (_, i) => [`f${i}`, { type: 'string' }]),
    ),
  })
  schemaOf(
    one({
      type: 'string',
      enum: Array.from({ length: MCP_ELICITATION_MAX_OPTIONS }, (_, i) => `o${i}`),
    }),
  )
})

// ── the answer ──────────────────────────────────────────────────────────────

const GOOD = {
  name: 'Ada',
  email: 'ada@example.test',
  site: 'https://example.test/ada',
  day: '1815-12-10',
  at: '2026-01-02T10:30:00Z',
  score: 7.5,
  seats: 2,
  ok: true,
  color: 'green',
  old: 'b',
  size: 'l',
  tops: ['x', 'y'],
  langs: ['en', 'pt'],
}

test('answer: a form that fits is passed on as a fresh object of its own fields', () => {
  const schema = schemaOf(FULL)
  const checked = validateMcpElicitationContent(schema, GOOD)
  assert.ok(checked.ok)
  assert.deepEqual(checked.value, GOOD)
  assert.notEqual(checked.value, GOOD)
  assert.notEqual(checked.value.tops, GOOD.tops)
  // Optional fields may be left out; null counts as left out.
  const partial = validateMcpElicitationContent(schema, {
    name: 'Ada',
    email: 'a@b.c',
    seats: null,
  })
  assert.ok(partial.ok)
  assert.deepEqual(partial.value, { name: 'Ada', email: 'a@b.c' })
  // No content at all is an empty form (fine when nothing is required).
  const none = validateMcpElicitationContent(
    schemaOf({ type: 'object', properties: {} }),
    undefined,
  )
  assert.ok(none.ok)
  assert.deepEqual(none.value, {})
})

test('answer: every rule of every field type is enforced, and a refusal never quotes the value', () => {
  const schema = schemaOf(FULL)
  const SECRET = 'hunter2-SECRET-VALUE'
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['a required field is missing', { ...GOOD, email: undefined }, /"email" is required/],
    ['too short', { ...GOOD, name: '' }, /"name" is too short/],
    ['too long', { ...GOOD, name: SECRET.repeat(3) }, /"name" is too long/],
    ['not an email', { ...GOOD, email: SECRET }, /"email" is not a valid email/],
    ['not a URI', { ...GOOD, site: `not a uri ${SECRET}` }, /"site" is not a valid uri/],
    ['not a date', { ...GOOD, day: '10/12/1815' }, /"day" is not a valid date/],
    ['not a date-time', { ...GOOD, at: '2026-01-02' }, /"at" is not a valid date-time/],
    ['a number as a string', { ...GOOD, score: '7' }, /"score" must be a number/],
    ['NaN', { ...GOOD, score: Number.NaN }, /"score" must be a number/],
    ['above the maximum', { ...GOOD, score: 11 }, /"score" is above the maximum/],
    ['not an integer', { ...GOOD, seats: 1.5 }, /"seats" must be a whole number/],
    ['below the minimum', { ...GOOD, seats: 0 }, /"seats" is below the minimum/],
    ['a boolean as a string', { ...GOOD, ok: 'yes' }, /"ok" must be true or false/],
    ['outside the enum', { ...GOOD, color: SECRET }, /"color" is not one of the options/],
    ['outside the titled options', { ...GOOD, size: 'Small' }, /"size" is not one of the options/],
    ['a multi-select as a string', { ...GOOD, tops: 'x' }, /"tops" must be a list of options/],
    ['a list of numbers', { ...GOOD, tops: [1] }, /"tops" must be a list of options/],
    ['too many selected', { ...GOOD, tops: ['x', 'y', 'z'] }, /"tops" has too many selected/],
    ['none selected', { ...GOOD, tops: [] }, /"tops" has too few selected/],
    ['an option that is not offered', { ...GOOD, langs: [SECRET] }, /"langs" holds something/],
    [
      'an object where a text goes',
      { ...GOOD, name: { toString: () => SECRET } },
      /"name" must be a text/,
    ],
    // What the server did not ask for is not sent to it.
    [
      'a field the form does not have',
      { ...GOOD, ssn: SECRET },
      /"ssn" is not a field of the form/,
    ],
  ]
  for (const [label, content, expected] of cases) {
    const checked = validateMcpElicitationContent(schema, content)
    assert.equal(checked.ok, false, label)
    const reason = checked.ok ? '' : checked.reason
    assert.match(reason, expected, label)
    assert.equal(reason.includes(SECRET), false, `${label}: the reason quotes the value`)
  }
  for (const content of ['Ada', ['Ada'], 7, null]) {
    assert.equal(validateMcpElicitationContent(schema, content).ok, false, JSON.stringify(content))
  }
  // A text field without its own limit still has one.
  const free = schemaOf({ type: 'object', properties: { note: { type: 'string' } } })
  assert.equal(
    validateMcpElicitationContent(free, { note: 'n'.repeat(MCP_ELICITATION_VALUE_MAX_CHARS) }).ok,
    true,
  )
  assert.equal(
    validateMcpElicitationContent(free, { note: 'n'.repeat(MCP_ELICITATION_VALUE_MAX_CHARS + 1) })
      .ok,
    false,
  )
})

// ── links ───────────────────────────────────────────────────────────────────

test('link: https, or http on a loopback host - nothing else', () => {
  for (const good of [
    'https://example.test/consent?x=1',
    'http://localhost:3000/elicit/1',
    'http://127.0.0.1:8080/elicit/1',
    'http://[::1]:8080/elicit/1',
  ]) {
    const checked = checkMcpElicitationUrl(good)
    assert.ok(checked.ok, good)
  }
  const refused: [string, unknown, RegExp][] = [
    ['plain http', 'http://example.test/login', /only https/],
    ['a host that only starts like loopback', 'http://localhost.attacker.example/', /only https/],
    ['javascript:', 'javascript:alert(1)', /only https/],
    ['data:', 'data:text/html,<script>1</script>', /only https/],
    ['file:', 'file:///etc/passwd', /only https/],
    ['a custom scheme', 'myapp://open', /only https/],
    ['credentials in the link', 'https://user:pw@example.test/', /credentials/],
    ['a user name alone', 'https://bank.example@evil.test/', /credentials/],
    ['not a URL', 'not a url', /cannot be shown|not a valid URL/],
    ['relative', '/elicit/1', /not a valid URL/],
    ['a hidden character', 'https://exam​ple.test/', /cannot be shown/],
    ['a newline', 'https://example.test/\nhttps://evil.test/', /cannot be shown/],
    ['too long', `https://example.test/${'a'.repeat(MCP_ELICITATION_URL_MAX_CHARS)}`, /too long/],
    ['empty', '', /missing/],
    ['not a string', { href: 'https://example.test/' }, /missing/],
  ]
  for (const [label, raw, expected] of refused) {
    const checked = checkMcpElicitationUrl(raw)
    assert.equal(checked.ok, false, label)
    assert.match(checked.ok ? '' : checked.reason, expected, label)
  }
  // The host is shown as a browser would resolve it.
  const idn = checkMcpElicitationUrl('https://аpple.test/')
  assert.ok(idn.ok && idn.value.startsWith('https://xn--'))
})

test('URL mode is declined unless the host offered it, and a bad link whatever was offered', () => {
  const ask = {
    mode: 'url',
    message: 'Open it',
    url: 'https://example.test/x',
    elicitationId: 'e1',
  }
  const off = parseMcpElicitationParams(ask, { url: false })
  assert.equal(!off.ok && off.reason, 'unsupported-mode')
  const on = parseMcpElicitationParams(ask, { url: true })
  assert.deepEqual(on, {
    ok: true,
    mode: 'url',
    message: 'Open it',
    url: 'https://example.test/x',
    elicitationId: 'e1',
  })
  const bad = parseMcpElicitationParams({ ...ask, url: 'http://example.test/x' }, { url: true })
  assert.equal(!bad.ok && bad.reason, 'insecure-url')
})

// ── asking ──────────────────────────────────────────────────────────────────

const NAME_FORM = {
  mode: 'form',
  message: 'Who is it?',
  requestedSchema: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1 } },
    required: ['name'],
  },
}

const harness = (
  handler: McpElicitationHandler,
  settings: McpElicitationOptions = {},
  call: Partial<McpElicitationCall> = {},
) => {
  const logs: string[] = []
  const events: McpElicitationEvent[] = []
  const deps: McpElicitationDeps = {
    handler,
    options: resolveMcpElicitationOptions(settings),
    log: (level, message) => logs.push(`${level} ${message}`),
  }
  const state: McpElicitationCall = {
    server: 'srv',
    tool: 'srv__ask',
    emit: (event) => events.push(event),
    run: { count: 0 },
    asked: 0,
    ...call,
  }
  return { deps, call: state, logs, events }
}

test('ask: the host is given the cleaned request and its answer goes back, checked', async () => {
  const seen: McpElicitationRequest[] = []
  const h = harness(
    (request) => {
      seen.push(request)
      return { action: 'accept', content: { name: 'Ada' } }
    },
    {},
    { runId: 'run-1' },
  )
  const answer = await answerMcpElicitation(h.deps, h.call, NAME_FORM)
  assert.deepEqual(answer, { action: 'accept', content: { name: 'Ada' } })
  assert.equal(seen.length, 1)
  assert.deepEqual(
    { ...seen[0], id: '<id>' },
    {
      id: '<id>',
      server: 'srv',
      tool: 'srv__ask',
      mode: 'form',
      message: 'Who is it?',
      requestedSchema: NAME_FORM.requestedSchema,
      runId: 'run-1',
    },
  )
  assert.equal(h.call.failure, undefined)
  assert.equal(h.call.asked, 1)
  assert.equal(h.call.run.count, 1)
  // Two events with the request's id; the second names the fields, never their values.
  assert.deepEqual(
    h.events.map((e) => e.type),
    ['mcp.elicitation-requested', 'mcp.elicitation-answered'],
  )
  assert.equal(h.events[0].id, seen[0].id)
  assert.deepEqual(h.events[1], {
    type: 'mcp.elicitation-answered',
    id: seen[0].id,
    server: 'srv',
    tool: 'srv__ask',
    action: 'accept',
    automatic: false,
    fields: ['name'],
  })
  assert.equal(JSON.stringify([h.events, h.logs]).includes('Ada'), false)
})

test('ask: decline and cancel are the host deciding - no failure', async () => {
  for (const action of ['decline', 'cancel'] as const) {
    const h = harness(() => ({ action }))
    assert.deepEqual(await answerMcpElicitation(h.deps, h.call, NAME_FORM), { action })
    assert.equal(h.call.failure, undefined)
    assert.deepEqual(h.events.at(-1), {
      type: 'mcp.elicitation-answered',
      id: h.events[0].id,
      server: 'srv',
      tool: 'srv__ask',
      action,
      automatic: false,
    })
  }
})

test('ask: a handler that throws cancels, fails the call, and its message is not repeated', async () => {
  const h = harness(() => {
    throw new TypeError('the user typed hunter2 and then the dialog crashed')
  })
  assert.deepEqual(await answerMcpElicitation(h.deps, h.call, NAME_FORM), { action: 'cancel' })
  assert.match(h.call.failure ?? '', /its elicitation handler failed/)
  assert.match(h.call.failure ?? '', /The call was not repeated/)
  const said = JSON.stringify([h.events, h.logs, h.call.failure])
  assert.equal(said.includes('hunter2'), false, 'the handler error text went somewhere')
  assert.ok(h.logs.some((l) => l.includes('handler-error: TypeError')))
  assert.deepEqual(h.events.at(-1), {
    type: 'mcp.elicitation-answered',
    id: h.events[0].id,
    server: 'srv',
    tool: 'srv__ask',
    action: 'cancel',
    automatic: true,
    reason: 'handler-error',
  })
})

test('ask: no answer in time cancels and fails the call; the host is told the wait is over', async () => {
  let signal: AbortSignal | undefined
  const h = harness(
    (_request, ctx) => {
      signal = ctx.signal
      return new Promise(() => {})
    },
    { timeoutMs: 30 },
  )
  const startedAt = Date.now()
  assert.deepEqual(await answerMcpElicitation(h.deps, h.call, NAME_FORM), { action: 'cancel' })
  assert.ok(Date.now() - startedAt >= 25)
  assert.match(h.call.failure ?? '', /nobody answered within 30 ms \(elicitation\.timeoutMs\)/)
  assert.equal(signal?.aborted, true)
  assert.equal((h.events.at(-1) as { reason?: string }).reason, 'timeout')
})

test('ask: an answer that is not one, or does not fit the form, is not sent', async () => {
  const cases: [string, unknown, RegExp][] = [
    ['nothing', undefined, /no accept, decline or cancel/],
    ['a string', 'accept', /no accept, decline or cancel/],
    ['an unknown action', { action: 'approve' }, /no accept, decline or cancel/],
    [
      'a value of the wrong type',
      { action: 'accept', content: { name: 7 } },
      /"name" must be a text/,
    ],
    ['a missing required field', { action: 'accept', content: {} }, /"name" is required/],
    [
      'a field that was not asked for',
      { action: 'accept', content: { name: 'Ada', token: 'SECRET-TOKEN' } },
      /"token" is not a field of the form/,
    ],
  ]
  for (const [label, result, expected] of cases) {
    const h = harness(() => result as never)
    assert.deepEqual(
      await answerMcpElicitation(h.deps, h.call, NAME_FORM),
      { action: 'cancel' },
      label,
    )
    assert.match(h.call.failure ?? '', expected, label)
    assert.match(h.call.failure ?? '', /was not sent/, label)
    assert.equal((h.events.at(-1) as { reason?: string }).reason, 'invalid-answer', label)
    assert.equal(JSON.stringify([h.events, h.logs, h.call.failure]).includes('SECRET-TOKEN'), false)
  }
})

test('ask: a request that cannot be shown is declined without the host being called', async () => {
  const cases: [string, unknown, string, 'decline' | 'cancel'][] = [
    [
      'a nested form',
      { ...NAME_FORM, requestedSchema: { type: 'object', properties: { a: { type: 'object' } } } },
      'unsupported-schema',
      'decline',
    ],
    [
      'URL mode that was not offered',
      { mode: 'url', message: 'm', url: 'https://x.test/' },
      'unsupported-mode',
      'decline',
    ],
    ['no message', { requestedSchema: NAME_FORM.requestedSchema }, 'invalid-request', 'decline'],
  ]
  for (const [label, params, reason, action] of cases) {
    let called = 0
    const h = harness(() => {
      called += 1
      return { action: 'accept', content: { name: 'x' } }
    })
    assert.deepEqual(await answerMcpElicitation(h.deps, h.call, params), { action }, label)
    assert.equal(called, 0, label)
    assert.ok(h.call.failure, label)
    // Nothing was shown, so nothing was "requested"; the one event says why.
    assert.deepEqual(
      h.events.map((e) => [e.type, (e as { reason?: string }).reason]),
      [['mcp.elicitation-answered', reason]],
      label,
    )
    assert.equal(h.call.asked, 0, label)
  }
  // A plain-http link is refused even when URL mode is on.
  let called = 0
  const h = harness(
    () => {
      called += 1
      return { action: 'accept' }
    },
    { url: true },
  )
  assert.deepEqual(
    await answerMcpElicitation(h.deps, h.call, {
      mode: 'url',
      message: 'm',
      url: 'http://evil.test/',
    }),
    { action: 'decline' },
  )
  assert.equal(called, 0)
  assert.match(h.call.failure ?? '', /the link it sent was refused \(only https/)
  assert.equal(h.call.failure?.includes('evil.test'), false, 'the refused link is not repeated')
})

test('ask: URL mode hands the link to the host and sends back consent only', async () => {
  const seen: McpElicitationRequest[] = []
  const h = harness(
    (request) => {
      seen.push(request)
      // Whatever a host adds, a URL-mode answer carries no content.
      return { action: 'accept', content: { leaked: 'x' } }
    },
    { url: true },
  )
  const answer = await answerMcpElicitation(h.deps, h.call, {
    mode: 'url',
    message: 'Open the page',
    url: 'https://example.test/elicit/1',
    elicitationId: 'e-1',
  })
  assert.deepEqual(answer, { action: 'accept' })
  assert.equal(seen[0].url, 'https://example.test/elicit/1')
  assert.equal(seen[0].elicitationId, 'e-1')
  assert.equal(seen[0].requestedSchema, undefined)
  assert.equal((h.events[0] as { url?: string }).url, 'https://example.test/elicit/1')
})

test('ask: a helper may not ask unless the host allowed it', async () => {
  let called = 0
  const handler: McpElicitationHandler = () => {
    called += 1
    return { action: 'accept', content: { name: 'x' } }
  }
  const subagent = { id: 'helper-1', depth: 1 }
  const off = harness(handler, {}, { subagent })
  assert.deepEqual(await answerMcpElicitation(off.deps, off.call, NAME_FORM), { action: 'cancel' })
  assert.equal(called, 0)
  assert.match(off.call.failure ?? '', /a helper is not allowed to ask the user/)
  assert.equal((off.events.at(-1) as { reason?: string }).reason, 'subagent')

  const seen: McpElicitationRequest[] = []
  const on = harness(
    (request) => {
      seen.push(request)
      return { action: 'accept', content: { name: 'x' } }
    },
    { subagents: true },
    { subagent },
  )
  assert.equal((await answerMcpElicitation(on.deps, on.call, NAME_FORM)).action, 'accept')
  assert.deepEqual(seen[0].subagent, subagent)
  assert.deepEqual((on.events[0] as { subagent?: unknown }).subagent, subagent)
})

test('ask: the caps - per tool call and per run - end the asking without the host', async () => {
  let called = 0
  const handler: McpElicitationHandler = () => {
    called += 1
    return { action: 'accept', content: { name: 'x' } }
  }
  const perCall = harness(handler, { maxPerToolCall: 2 })
  await answerMcpElicitation(perCall.deps, perCall.call, NAME_FORM)
  await answerMcpElicitation(perCall.deps, perCall.call, NAME_FORM)
  assert.equal(perCall.call.failure, undefined)
  assert.deepEqual(await answerMcpElicitation(perCall.deps, perCall.call, NAME_FORM), {
    action: 'cancel',
  })
  assert.equal(called, 2)
  assert.match(perCall.call.failure ?? '', /already asked 2 time\(s\) in this call/)
  assert.equal((perCall.events.at(-1) as { reason?: string }).reason, 'cap-per-call')
  // Once a call has failed, nothing more is asked on its behalf.
  assert.deepEqual(await answerMcpElicitation(perCall.deps, perCall.call, NAME_FORM), {
    action: 'cancel',
  })
  assert.equal(called, 2)
  assert.equal((perCall.events.at(-1) as { reason?: string }).reason, 'after-failure')

  // Per run: the counter is shared by every call of the run.
  called = 0
  const run = { count: 0 }
  const first = harness(handler, { maxPerRun: 3 }, { run })
  const second = harness(handler, { maxPerRun: 3 }, { run })
  await answerMcpElicitation(first.deps, first.call, NAME_FORM)
  await answerMcpElicitation(first.deps, first.call, NAME_FORM)
  await answerMcpElicitation(second.deps, second.call, NAME_FORM)
  assert.equal(run.count, 3)
  assert.deepEqual(await answerMcpElicitation(second.deps, second.call, NAME_FORM), {
    action: 'cancel',
  })
  assert.equal(called, 3)
  assert.match(second.call.failure ?? '', /3 question\(s\) were already asked in this run/)
})

test('ask: a stopped run cancels the wait and rethrows the abort; a step limit says so', async () => {
  const controller = new AbortController()
  let hostSignal: AbortSignal | undefined
  const h = harness(
    (_request, ctx) => {
      hostSignal = ctx.signal
      return new Promise(() => {})
    },
    {},
    { signal: controller.signal },
  )
  const pending = answerMcpElicitation(h.deps, h.call, NAME_FORM)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const stop = new Error('stopped by the user')
  controller.abort(stop)
  await assert.rejects(pending, (err) => err === stop)
  assert.equal(hostSignal?.aborted, true)
  assert.equal((h.events.at(-1) as { reason?: string }).reason, 'aborted')

  // The step's own time limit (AbortSignal.timeout): named, and warned about.
  const limited = harness(() => new Promise(() => {}), {}, { signal: AbortSignal.timeout(20) })
  await assert.rejects(answerMcpElicitation(limited.deps, limited.call, NAME_FORM), {
    name: 'TimeoutError',
  })
  assert.equal((limited.events.at(-1) as { reason?: string }).reason, 'step-timeout')
  assert.ok(limited.logs.some((l) => /the step's time limit ended/.test(l)))

  // Already stopped: nobody is asked.
  let called = 0
  const gone = harness(
    () => {
      called += 1
      return { action: 'decline' }
    },
    {},
    { signal: AbortSignal.abort(stop) },
  )
  await assert.rejects(answerMcpElicitation(gone.deps, gone.call, NAME_FORM), (err) => err === stop)
  assert.equal(called, 0)
})

// ── driving a tool call ─────────────────────────────────────────────────────

const INFO = { tool: 'srv__ask', toolName: 'ask' }
const DONE = { content: [{ type: 'text', text: 'done' }] }
const ACCEPT: McpElicitationHandler = () => ({ action: 'accept', content: { name: 'Ada' } })

const sessionOf = (handler: McpElicitationHandler, settings: McpElicitationOptions = {}) => {
  const h = harness(handler, settings)
  return { session: createMcpElicitationSession('srv', h.deps), logs: h.logs }
}

test('modern: input_required is answered and the same call is sent again with the answers and the state', async () => {
  const { session } = sessionOf(ACCEPT)
  const legs: McpToolCallLeg[] = []
  const result = await session.call('modern', INFO, async (leg) => {
    legs.push(leg)
    if (legs.length === 1) {
      return {
        resultType: 'input_required',
        inputRequests: { q1: { method: 'elicitation/create', params: NAME_FORM } },
        requestState: 'opaque.state/bytes==',
      }
    }
    return DONE
  })
  assert.equal(result, DONE)
  assert.equal(legs.length, 2)
  assert.equal(legs[0].retry, undefined)
  assert.equal(legs[0].ownTimeout, undefined)
  assert.equal(legs[1].retry?.requestState, 'opaque.state/bytes==')
  assert.deepEqual(JSON.parse(JSON.stringify(legs[1].retry?.inputResponses)), {
    q1: { action: 'accept', content: { name: 'Ada' } },
  })
})

test('modern: a server-chosen key cannot be special', async () => {
  const { session } = sessionOf(ACCEPT)
  const legs: McpToolCallLeg[] = []
  await session.call('modern', INFO, async (leg) => {
    legs.push(leg)
    return legs.length === 1
      ? {
          resultType: 'input_required',
          inputRequests: JSON.parse(
            `{"__proto__":{"method":"elicitation/create","params":${JSON.stringify(NAME_FORM)}}}`,
          ),
        }
      : DONE
  })
  const responses = legs[1].retry?.inputResponses as object
  assert.equal(Object.getPrototypeOf(responses), null)
  assert.deepEqual(Object.keys(responses), ['__proto__'])
})

test('modern: after an automatic answer nothing is sent again', async () => {
  for (const [label, handler, expected] of [
    [
      'the handler throws',
      () => {
        throw new Error('x')
      },
      /handler failed/,
    ],
    [
      'an answer that does not fit',
      () => ({ action: 'accept', content: {} }),
      /did not fit the form/,
    ],
  ] as [string, McpElicitationHandler, RegExp][]) {
    const { session } = sessionOf(handler)
    let legs = 0
    await assert.rejects(
      session.call('modern', INFO, async () => {
        legs += 1
        return {
          resultType: 'input_required',
          inputRequests: { q1: { method: 'elicitation/create', params: NAME_FORM } },
        }
      }),
      (err: unknown) => err instanceof McpElicitationError && expected.test(err.message),
      label,
    )
    assert.equal(legs, 1, label)
  }
})

test('modern: only elicitation is answered - sampling or roots fail the call before anybody is asked', async () => {
  let called = 0
  const { session } = sessionOf(() => {
    called += 1
    return { action: 'decline' }
  })
  let legs = 0
  await assert.rejects(
    session.call('modern', INFO, async () => {
      legs += 1
      return {
        resultType: 'input_required',
        inputRequests: {
          q1: { method: 'elicitation/create', params: NAME_FORM },
          q2: { method: 'sampling/createMessage', params: { messages: [] } },
        },
      }
    }),
    /asked for input this client does not provide \(sampling\/createMessage; only elicitation/,
  )
  assert.equal(legs, 1)
  assert.equal(called, 0)
  await assert.rejects(
    session.call('modern', INFO, async () => ({ resultType: 'input_required' })),
    /an empty input_required result/,
  )
})

test('modern: a server that never stops asking is cut off - by the question cap, and by the round cap', async () => {
  let called = 0
  const { session } = sessionOf(() => {
    called += 1
    return { action: 'accept', content: { name: 'Ada' } }
  })
  let legs = 0
  await assert.rejects(
    session.call('modern', INFO, async () => {
      legs += 1
      return {
        resultType: 'input_required',
        inputRequests: { q: { method: 'elicitation/create', params: NAME_FORM } },
      }
    }),
    /already asked 5 time\(s\) in this call/,
  )
  assert.equal(called, MCP_ELICITATION_MAX_PER_TOOL_CALL)
  assert.equal(legs, MCP_ELICITATION_MAX_PER_TOOL_CALL + 1)
})

test('modern: "call me again" rounds are paced and counted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { session } = sessionOf(ACCEPT)
  let legs = 0
  const pending = session.call('modern', INFO, async (leg) => {
    legs += 1
    assert.equal(leg.retry === undefined, legs === 1)
    return { resultType: 'input_required', requestState: `s${legs}` }
  })
  const outcome = pending.then(
    () => 'resolved',
    (err: unknown) => String(err),
  )
  for (let i = 0; i < MCP_INPUT_REQUIRED_MAX_ROUNDS + 2; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(legs <= i + 1, 'a round was sent without the pause')
    t.mock.timers.tick(250)
  }
  assert.match(await outcome, /still asked for input after 10 rounds/)
  assert.equal(legs, MCP_INPUT_REQUIRED_MAX_ROUNDS + 1)
})

test('legacy: the question belongs to the call in flight, and calls run one at a time', async () => {
  const seen: string[] = []
  const { session } = sessionOf((request) => {
    seen.push(request.tool)
    return { action: 'accept', content: { name: 'Ada' } }
  })
  const order: string[] = []
  const gate: Record<string, () => void> = {}
  const call = (tool: string) =>
    session.call('legacy', { tool, toolName: tool }, async (leg) => {
      order.push(`start ${tool}`)
      assert.equal(leg.ownTimeout, true)
      assert.ok(leg.signal)
      await new Promise<void>((resolve) => {
        gate[tool] = resolve
      })
      // The server asks in the middle of this call.
      const answer = await session.onRequest(NAME_FORM)
      assert.equal(answer.action, 'accept')
      order.push(`end ${tool}`)
      return tool
    })
  const a = call('a')
  const b = call('b')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['start a'], 'the second call waited for the first')
  gate.a()
  assert.equal(await a, 'a')
  await new Promise((resolve) => setImmediate(resolve))
  gate.b()
  assert.equal(await b, 'b')
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b'])
  assert.deepEqual(seen, ['a', 'b'])
})

test('legacy: a question with no tool call in flight is cancelled without the host', async () => {
  let called = 0
  const { session, logs } = sessionOf(() => {
    called += 1
    return { action: 'accept', content: { name: 'x' } }
  })
  assert.deepEqual(await session.onRequest(NAME_FORM), { action: 'cancel' })
  assert.equal(called, 0)
  assert.ok(logs.some((l) => /no tool call was in progress/.test(l)))
})

test('legacy: after an automatic answer the result is discarded, and a server that asks again is cut off', async () => {
  const { session } = sessionOf(() => {
    throw new Error('x')
  })
  // The server takes the cancel and answers normally: the call fails all the same.
  await assert.rejects(
    session.call('legacy', INFO, async () => {
      assert.deepEqual(await session.onRequest(NAME_FORM), { action: 'cancel' })
      return DONE
    }),
    (err: unknown) => err instanceof McpElicitationError && /handler failed/.test(err.message),
  )
  // The server asks again instead: its call is aborted.
  let aborted = false
  await assert.rejects(
    session.call('legacy', INFO, async (leg) => {
      leg.signal?.addEventListener('abort', () => {
        aborted = true
      })
      await session.onRequest(NAME_FORM)
      await session.onRequest(NAME_FORM)
      assert.equal(leg.signal?.aborted, true)
      throw leg.signal?.reason
    }),
    /handler failed/,
  )
  assert.equal(aborted, true)
})

test('legacy: the call keeps its own minute, which does not run while a question waits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let answer!: () => void
  const { session } = sessionOf(
    () =>
      new Promise((resolve) => {
        answer = () => resolve({ action: 'accept', content: { name: 'Ada' } })
      }),
    { timeoutMs: 0 },
  )
  const tick = async (ms: number): Promise<void> => {
    t.mock.timers.tick(ms)
    await new Promise((resolve) => setImmediate(resolve))
  }
  let legSignal: AbortSignal | undefined
  let finish!: () => void
  const pending = session.call('legacy', INFO, async (leg) => {
    legSignal = leg.signal
    const asked = session.onRequest(NAME_FORM)
    await new Promise<void>((resolve, reject) => {
      finish = resolve
      leg.signal?.addEventListener('abort', () => reject(leg.signal?.reason))
    })
    await asked
    return DONE
  })
  const outcome = pending.then(
    () => 'resolved',
    (err: unknown) => String(err),
  )
  await tick(0)
  // Ten minutes of a human thinking: the call's clock stands still.
  await tick(10 * 60_000)
  assert.equal(legSignal?.aborted, false, 'the wait for the user counted against the call')
  answer()
  await tick(0)
  // Its own time runs again from here: just under a minute is fine ...
  await tick(MCP_TOOL_CALL_TIMEOUT_MS - 1_000)
  assert.equal(legSignal?.aborted, false)
  // ... and past it the call is ended, by name.
  await tick(2_000)
  assert.equal(legSignal?.aborted, true)
  assert.match(await outcome, /timed out after 60000 ms \(not counting the time/)
  void finish
})

test('legacy: the caller stopping ends the wait for the turn and the call, with its own reason', async () => {
  const { session } = sessionOf(ACCEPT)
  let release!: () => void
  const first = session.call('legacy', INFO, async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return DONE
  })
  const controller = new AbortController()
  let started = false
  const queued = session.call('legacy', { ...INFO, signal: controller.signal }, async () => {
    started = true
    return DONE
  })
  const stop = new Error('stop')
  controller.abort(stop)
  await assert.rejects(queued, (err) => err === stop)
  assert.equal(started, false)
  release()
  assert.equal(await first, DONE)
  // The queue is not broken for those behind.
  assert.equal(await session.call('legacy', INFO, async () => DONE), DONE)
})
