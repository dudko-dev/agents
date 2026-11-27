import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AgentChat,
  createInitialAgentState,
  defaultLabels,
  ElicitationPrompt,
  elicitationFields,
  elicitationFormAnswer,
  elicitationInitialDraft,
  elicitationLink,
  formatCountdown,
  type ElicitationDraft,
  type ElicitationView,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpElicitationSchema,
  type PendingElicitation,
} from '../dist/index.js'
import * as main from '../dist/index.js'
import {
  createElicitationQueue,
  elicitationConnectOptions,
  elicitationSettings,
  elicitationTimeoutOf,
} from '../dist/mcp.js'

// MCP elicitation, the React side: the queue the hooks hand the core as `onElicitation`, the
// form's fields and checks (the core's own rules, cross-checked against the core's validator),
// the link rule, and the prompt rendered to markup. The flows in a browser - typing, the popup,
// the server's view of the answer - are `e2e/elicitation.spec.ts`.

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

const request = (over: Partial<McpElicitationRequest> = {}): McpElicitationRequest => ({
  id: 'q1',
  server: 'crm',
  tool: 'crm__create_contact',
  mode: 'form',
  message: 'Who is the contact?',
  requestedSchema: {
    type: 'object',
    properties: { name: { type: 'string', title: 'Name' } },
    required: ['name'],
  },
  ...over,
})

const signal = () => new AbortController()

// ── the queue: request.id → resolver ─────────────────────────────────────

test('queue: a question waits until it is answered, and the answer goes to the core once', async () => {
  const changes: PendingElicitation[][] = []
  let clock = 1_000
  const queue = createElicitationQueue({
    timeoutMs: 60_000,
    now: () => clock,
    onChange: (list) => changes.push(list),
  })
  const answer = queue.handler(request(), { signal: signal().signal })
  assert.deepEqual(
    queue.pending().map((p) => [p.id, p.server, p.expiresAt]),
    [['q1', 'crm', 61_000]],
  )
  assert.equal(changes.length, 1)
  clock = 5_000
  const content = { name: 'Typed-Secret-123' }
  assert.equal(queue.answer('q1', { action: 'accept', content }), true)
  assert.deepEqual(await answer, { action: 'accept', content })
  // Exactly once: a second answer finds nothing, and the queue is empty.
  assert.equal(queue.answer('q1', { action: 'decline' }), false)
  assert.deepEqual(queue.pending(), [])
  assert.deepEqual(changes.at(-1), [])
  // The queue never held the answer: no snapshot it reported carries the typed value.
  assert.equal(JSON.stringify(changes).includes('Typed-Secret-123'), false)
})

test('queue: when the core stops waiting (ctx.signal: its time ran out, the run stopped), the question is cancelled', async () => {
  const changes: PendingElicitation[][] = []
  const queue = createElicitationQueue({ onChange: (list) => changes.push(list) })
  const ctl = signal()
  const answer = queue.handler(request(), { signal: ctl.signal })
  assert.equal(queue.pending().length, 1)
  ctl.abort()
  assert.deepEqual(await answer, { action: 'cancel' })
  assert.deepEqual(queue.pending(), [])
  assert.deepEqual(changes.at(-1), [])
  // A late answer from the UI changes nothing.
  assert.equal(queue.answer('q1', { action: 'accept', content: { name: 'x' } }), false)
})

test('queue: a question that arrives already aborted is cancelled without being shown', async () => {
  const changes: PendingElicitation[][] = []
  const queue = createElicitationQueue({ onChange: (list) => changes.push(list) })
  const ctl = signal()
  ctl.abort()
  assert.deepEqual(await queue.handler(request(), { signal: ctl.signal }), { action: 'cancel' })
  assert.deepEqual(queue.pending(), [])
  assert.equal(changes.length, 0)
})

test("queue: cancel(match) ends one server's questions (a disconnect), the others keep waiting", async () => {
  const queue = createElicitationQueue()
  const a = queue.handler(request({ id: 'a', server: 'crm' }), { signal: signal().signal })
  const b = queue.handler(request({ id: 'b', server: 'docs' }), { signal: signal().signal })
  const c = queue.handler(request({ id: 'c', server: 'crm' }), { signal: signal().signal })
  queue.cancel((r) => r.server === 'crm')
  assert.deepEqual(await a, { action: 'cancel' })
  assert.deepEqual(await c, { action: 'cancel' })
  assert.deepEqual(
    queue.pending().map((p) => p.id),
    ['b'],
  )
  queue.answer('b', { action: 'decline' })
  assert.deepEqual(await b, { action: 'decline' })
})

test('queue: dispose (an unmount) cancels everything, stops reporting, and cancels a late question at once', async () => {
  const changes: PendingElicitation[][] = []
  const queue = createElicitationQueue({ onChange: (list) => changes.push(list) })
  const waiting = queue.handler(request(), { signal: signal().signal })
  const before = changes.length
  queue.dispose()
  assert.deepEqual(await waiting, { action: 'cancel' })
  assert.equal(changes.length, before, 'nothing is reported to an owner that is gone')
  assert.deepEqual(await queue.handler(request({ id: 'q2' }), { signal: signal().signal }), {
    action: 'cancel',
  })
  assert.deepEqual(queue.pending(), [])
})

test('queue: oldest first; a second question with the id of one still waiting is cancelled', async () => {
  const queue = createElicitationQueue()
  void queue.handler(request({ id: 'one' }), { signal: signal().signal })
  void queue.handler(request({ id: 'two' }), { signal: signal().signal })
  assert.deepEqual(await queue.handler(request({ id: 'one' }), { signal: signal().signal }), {
    action: 'cancel',
  })
  assert.deepEqual(
    queue.pending().map((p) => p.id),
    ['one', 'two'],
  )
  queue.cancel()
  assert.deepEqual(queue.pending(), [])
})

test('queue: the timeout is read when a question arrives; no limit means no expiresAt', () => {
  let timeout: number | undefined = 1_000
  const queue = createElicitationQueue({ timeoutMs: () => timeout, now: () => 0 })
  void queue.handler(request({ id: 'a' }), { signal: signal().signal })
  timeout = undefined
  void queue.handler(request({ id: 'b' }), { signal: signal().signal })
  const [a, b] = queue.pending()
  assert.equal(a.expiresAt, 1_000)
  assert.equal('expiresAt' in b, false)
  queue.cancel()
})

// ── the hooks' option: off means NOTHING reaches the core ────────────────

test('connect options: off adds no key at all (no capability, the wire unchanged); on adds the handler and the settings', () => {
  const handler = () => ({ action: 'cancel' as const })
  for (const off of [undefined, null, false]) {
    const added = elicitationConnectOptions(off, handler)
    assert.deepEqual(Object.keys(added), [], `${String(off)} passes nothing`)
    assert.equal(elicitationSettings(off), undefined)
  }
  assert.deepEqual(elicitationConnectOptions(true, handler), {
    onElicitation: handler,
    elicitation: {},
  })
  const settings = { url: true, timeoutMs: 90_000 }
  const added = elicitationConnectOptions(settings, handler)
  assert.deepEqual(added, { onElicitation: handler, elicitation: settings })
  assert.notEqual(added.elicitation, settings, 'a copy: the host object is not handed on')
})

test("elicitationTimeoutOf: the core's default, a whole number of ms, or no limit", () => {
  assert.equal(elicitationTimeoutOf({}), 300_000)
  assert.equal(elicitationTimeoutOf({ timeoutMs: 1500.9 }), 1500)
  assert.equal(elicitationTimeoutOf({ timeoutMs: 0 }), undefined)
  // As the core: Infinity and more than a timer holds are no limit, a positive fraction is 1 ms.
  assert.equal(elicitationTimeoutOf({ timeoutMs: Infinity }), undefined)
  assert.equal(elicitationTimeoutOf({ timeoutMs: 2 ** 31 - 1 }), 2 ** 31 - 1)
  assert.equal(elicitationTimeoutOf({ timeoutMs: 2 ** 31 }), undefined)
  assert.equal(elicitationTimeoutOf({ timeoutMs: 0.5 }), 1)
})

test('the queue and the connect options are in ./mcp; the prompt and the form helpers in the main entry', () => {
  for (const name of ['createElicitationQueue', 'elicitationConnectOptions']) {
    assert.equal(name in main, false, `${name} belongs to ./mcp`)
  }
  for (const name of ['ElicitationPrompt', 'elicitationFields', 'elicitationFormAnswer']) {
    assert.equal(typeof (main as Record<string, unknown>)[name], 'function', `${name} is exported`)
  }
})

// ── the form: what each field is drawn as ────────────────────────────────

// The test server's form, as the core hands it to a host (checked, cleaned, capped).
const coreSchema = async (raw: unknown): Promise<McpElicitationSchema> => {
  const { normalizeMcpElicitationSchema } = (await import('@dudko.dev/agent-web/mcp')) as {
    normalizeMcpElicitationSchema: (
      raw: unknown,
    ) => { ok: true; value: McpElicitationSchema } | { ok: false; reason: string }
  }
  const out = normalizeMcpElicitationSchema(raw)
  assert.ok(out.ok, 'the core accepts the form')
  return out.value
}

const profile = async (): Promise<McpElicitationSchema> => {
  const { ELICIT_FORM_SCHEMA } = await import('@dudko.dev/test-servers')
  return coreSchema(ELICIT_FORM_SCHEMA)
}

test('fields: every kind the core lets through has a control, in the order the server listed them', async () => {
  const fields = elicitationFields(await profile())
  assert.deepEqual(
    fields.map((f) => [f.name, f.control, f.required]),
    [
      ['name', 'text', true],
      ['email', 'email', true],
      ['website', 'url', false],
      ['birthday', 'date', false],
      ['meeting', 'datetime', false],
      ['score', 'number', false],
      ['seats', 'number', false],
      ['subscribe', 'checkbox', false],
      ['color', 'select', false],
      ['size', 'select', false],
      ['toppings', 'multiselect', false],
      ['languages', 'multiselect', false],
    ],
  )
  const by = Object.fromEntries(fields.map((f) => [f.name, f]))
  assert.equal(by.name.label, 'Name')
  assert.equal(by.name.description, 'Your name')
  // Plain options show their value; titled ones (oneOf, anyOf) their title.
  assert.deepEqual(by.color.options, [
    { value: 'red', label: 'red' },
    { value: 'green', label: 'green' },
    { value: 'blue', label: 'blue' },
  ])
  assert.deepEqual(by.size.options, [
    { value: 's', label: 'Small' },
    { value: 'l', label: 'Large' },
  ])
  assert.deepEqual(
    by.languages.options?.map((o) => o.label),
    ['English', 'Portuguese'],
  )
})

test('fields: the older titled enum (enumNames) shows the titles; a field without a title shows its name', async () => {
  const schema = await coreSchema({
    type: 'object',
    properties: {
      plan: { type: 'string', enum: ['f', 'p'], enumNames: ['Free', 'Pro'] },
      note: { type: 'string' },
    },
  })
  const [plan, note] = elicitationFields(schema)
  assert.deepEqual(plan.options, [
    { value: 'f', label: 'Free' },
    { value: 'p', label: 'Pro' },
  ])
  assert.equal(note.label, 'note')
})

test("the initial draft holds the schema's defaults, and nothing else", async () => {
  assert.deepEqual(elicitationInitialDraft(await profile()), {
    name: '',
    email: '',
    website: '',
    birthday: '',
    meeting: '',
    score: '5',
    seats: '',
    subscribe: false,
    color: 'red',
    size: '',
    toppings: [],
    languages: ['en'],
  })
})

// ── the form: the answer and its checks, the core's rules ────────────────

const coreValidate = async () =>
  (
    (await import('@dudko.dev/agent-web/mcp')) as {
      validateMcpElicitationContent: (
        schema: McpElicitationSchema,
        content: unknown,
      ) => { ok: boolean; value?: unknown }
    }
  ).validateMcpElicitationContent

const filled = (schema: McpElicitationSchema, patch: ElicitationDraft): ElicitationDraft => ({
  ...elicitationInitialDraft(schema),
  name: 'Ada',
  email: 'ada@example.test',
  ...patch,
})

test('an accepted form is exactly what the core accepts: typed values, empty fields left out', async () => {
  const schema = await profile()
  const validate = await coreValidate()
  const draft = filled(schema, {
    website: 'https://ada.example',
    birthday: '1815-12-10',
    meeting: '2026-11-27T10:30',
    score: ' 1e1 ',
    seats: '3',
    subscribe: true,
    size: 'l',
    toppings: ['olives', 'basil'],
    stray: 'not a field of the form',
  })
  const out = elicitationFormAnswer(schema, draft)
  assert.ok(out.ok)
  assert.deepEqual(out.content, {
    name: 'Ada',
    email: 'ada@example.test',
    website: 'https://ada.example',
    birthday: '1815-12-10',
    // Local time as RFC 3339 with its offset: the server cannot read it as another zone.
    meeting: new Date('2026-11-27T10:30').toISOString(),
    score: 10,
    seats: 3,
    subscribe: true,
    color: 'red',
    size: 'l',
    toppings: ['olives', 'basil'],
    languages: ['en'],
  })
  const core = validate(schema, out.content)
  assert.ok(core.ok, 'the core accepts it')
  assert.deepEqual(core.value, out.content)
  // Optional fields left empty are not sent (an unticked box is an answer: false).
  const minimal = elicitationFormAnswer(schema, filled(schema, { languages: [], color: '' }))
  assert.ok(minimal.ok)
  assert.deepEqual(minimal.content, {
    name: 'Ada',
    email: 'ada@example.test',
    score: 5,
    subscribe: false,
  })
  assert.ok(validate(schema, minimal.content).ok)
})

test('every rule the core checks is checked here first, with the field and the limit, never the value', async () => {
  const schema = await profile()
  const validate = await coreValidate()
  // [what is typed, the issue on that field, what the core would have been sent]
  const cases: [ElicitationDraft, string, { kind: string; limit?: number }, unknown][] = [
    [{ name: '' }, 'name', { kind: 'required' }, undefined],
    [{ name: 'x'.repeat(41) }, 'name', { kind: 'tooLong', limit: 40 }, 'x'.repeat(41)],
    [{ email: 'not-an-email' }, 'email', { kind: 'email' }, 'not-an-email'],
    [{ website: 'example dot com' }, 'website', { kind: 'uri' }, 'example dot com'],
    [{ birthday: '10/12/1815' }, 'birthday', { kind: 'date' }, '10/12/1815'],
    [{ meeting: 'tomorrow' }, 'meeting', { kind: 'dateTime' }, 'tomorrow'],
    [{ score: 'ten' }, 'score', { kind: 'notNumber' }, 'ten'],
    [{ score: '11' }, 'score', { kind: 'aboveMaximum', limit: 10 }, 11],
    [{ score: '-1' }, 'score', { kind: 'belowMinimum', limit: 0 }, -1],
    [{ seats: '2.5' }, 'seats', { kind: 'notInteger' }, 2.5],
    [{ seats: '0' }, 'seats', { kind: 'belowMinimum', limit: 1 }, 0],
    [{ seats: '12' }, 'seats', { kind: 'aboveMaximum', limit: 8 }, 12],
    [{ color: 'pink' }, 'color', { kind: 'notAnOption' }, 'pink'],
    [{ toppings: ['ham'] }, 'toppings', { kind: 'notAnOption' }, ['ham']],
    [
      { toppings: ['olives', 'basil', 'capers'] },
      'toppings',
      { kind: 'tooMany', limit: 2 },
      ['olives', 'basil', 'capers'],
    ],
  ]
  for (const [patch, field, issue, sent] of cases) {
    const out = elicitationFormAnswer(schema, filled(schema, patch))
    assert.equal(out.ok, false, `${JSON.stringify(patch)} is refused`)
    if (out.ok) continue
    assert.deepEqual(out.issues, { [field]: issue }, JSON.stringify(patch))
    // An issue names a rule; it never carries what was typed.
    const typed = Object.values(patch)[0]
    if (typeof typed === 'string' && typed.length > 3) {
      assert.equal(JSON.stringify(out.issues).includes(typed), false)
    }
    // The core refuses the same value: the form is not stricter by accident. (A required
    // text left empty is the one place it is: the core would take "".)
    if (sent !== undefined) {
      const content = { name: 'Ada', email: 'ada@example.test', [field]: sent }
      assert.equal(validate(schema, content).ok, false, `the core refuses ${field}=${sent}`)
    }
  }
})

test('a multi-select with a minimum: fewer ticked than it needs is refused once anything is ticked', async () => {
  const schema = await coreSchema({
    type: 'object',
    properties: {
      tags: {
        type: 'array',
        minItems: 2,
        items: { type: 'string', enum: ['a', 'b', 'c'] },
      },
      code: { type: 'string', minLength: 3 },
    },
    required: ['tags'],
  })
  const validate = await coreValidate()
  const out = elicitationFormAnswer(schema, { tags: ['a'], code: 'xy' })
  assert.equal(out.ok, false)
  if (!out.ok) {
    assert.deepEqual(out.issues, {
      tags: { kind: 'tooFew', limit: 2 },
      code: { kind: 'tooShort', limit: 3 },
    })
  }
  assert.equal(validate(schema, { tags: ['a'] }).ok, false)
  assert.equal(validate(schema, { tags: ['a', 'b'], code: 'xy' }).ok, false)
  const ok = elicitationFormAnswer(schema, { tags: ['a', 'c'], code: 'xyz' })
  assert.ok(ok.ok)
  assert.ok(validate(schema, ok.content).ok)
})

// ── a link ───────────────────────────────────────────────────────────────

test('link: only https (or http on loopback) without credentials gets an Open action', () => {
  assert.deepEqual(elicitationLink('https://pay.example.com/checkout?id=7'), {
    host: 'pay.example.com',
    href: 'https://pay.example.com/checkout?id=7',
    openable: true,
  })
  assert.equal(elicitationLink('http://127.0.0.1:4100/elicit/1').openable, true)
  assert.equal(elicitationLink('http://localhost/x').openable, true)
  for (const refused of [
    'http://pay.example.com/',
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'https://user:pw@pay.example.com/',
    'ftp://files.example.com/',
    'not a link',
    '',
    undefined,
  ]) {
    assert.equal(elicitationLink(refused).openable, false, String(refused))
  }
  // An internationalised host shows as the browser will resolve it.
  assert.equal(elicitationLink('https://bücher.example/').host, 'xn--bcher-kva.example')
  assert.equal(elicitationLink('not a link').host, '')
})

test('formatCountdown: minutes and seconds, never below zero', () => {
  assert.equal(formatCountdown(300_000), '5:00')
  assert.equal(formatCountdown(61_000), '1:01')
  assert.equal(formatCountdown(400), '0:01')
  assert.equal(formatCountdown(-5_000), '0:00')
})

// ── the prompt ───────────────────────────────────────────────────────────

const pending = (over: Partial<PendingElicitation> = {}): PendingElicitation => ({
  ...request(),
  ...over,
})
const noAnswer = (_id: string, _result: McpElicitationResult) => {}

test("prompt: the host's header says which server asks during which tool; the server's words are text, marked as the server's", () => {
  const out = html(
    createElement(ElicitationPrompt, {
      elicitations: [
        pending({
          message: 'Please <b>confirm</b> <script>alert(1)</script>',
          expiresAt: Date.now() + 240_500,
        }),
      ],
      onAnswer: noAnswer,
    }),
  )
  assert.match(out, /The MCP server “crm” asks for your input/)
  assert.match(out, /during <code class="awr-tool__name">crm__create_contact<\/code>/)
  assert.match(out, /class="awr-elicit__from">From the server “crm”</)
  // Markup from the server is shown as characters, never rendered.
  assert.match(out, /Please &lt;b&gt;confirm&lt;\/b&gt; &lt;script&gt;/)
  assert.doesNotMatch(out, /<script>|<b>/)
  // The server's text sits inside the box that says whose it is.
  assert.ok(out.indexOf('awr-elicit__from') < out.indexOf('Please &lt;b&gt;'))
  assert.match(out, /Cancelled automatically in 4:0\d/)
  // The three outcomes.
  assert.match(out, /<button type="submit"[^>]*>Submit<\/button>/)
  assert.match(out, />Decline<\/button>/)
  assert.match(out, />Cancel<\/button>/)
  // A required field is marked, with a word for assistive technology.
  assert.match(out, /Name<span class="awr-elicit__req"[^>]*><span aria-hidden="true">\*<\/span>/)
  assert.match(out, /\(required\)/)
  assert.doesNotMatch(out, /<a\s/)
})

test('prompt: every control of a form, with the defaults filled in', async () => {
  const out = html(
    createElement(ElicitationPrompt, {
      elicitations: [pending({ requestedSchema: await profile() })],
      onAnswer: noAnswer,
    }),
  )
  assert.match(out, /type="email"/)
  assert.match(out, /type="url"/)
  assert.match(out, /type="date"/)
  assert.match(out, /type="datetime-local"/)
  // Numbers are typed as text, so a value that does not parse can be named, not swallowed.
  assert.match(out, /inputMode="decimal"[^>]*value="5"|value="5"[^>]*inputMode="decimal"/i)
  assert.match(out, /inputMode="numeric"/i)
  assert.match(out, /<select[^>]*>.*<option value="red" selected="">red<\/option>/)
  assert.match(out, /<option value="l">Large<\/option>/)
  assert.match(out, /<legend class="awr-elicit__label">Toppings<\/legend>/)
  assert.match(out, /checked=""[^>]*\/><span>English<\/span>/)
  assert.match(out, /Your name/)
})

test('prompt: several questions are shown one at a time, with a count', () => {
  const out = html(
    createElement(ElicitationPrompt, {
      elicitations: [
        pending({ id: 'a', message: 'First question' }),
        pending({ id: 'b', message: 'Second question' }),
      ],
      onAnswer: noAnswer,
    }),
  )
  assert.match(out, /class="awr-elicit__count">1 of 2</)
  assert.match(out, /First question/)
  assert.doesNotMatch(out, /Second question/)
  assert.equal(out.match(/<section/g)?.length, 1)
})

test('prompt, link: the host first, the whole address as text, an Open button - and no link to follow', () => {
  const url = 'https://pay.example.com/checkout?session=abc'
  const out = html(
    createElement(ElicitationPrompt, {
      elicitations: [pending({ mode: 'url', url, requestedSchema: undefined })],
      onAnswer: noAnswer,
    }),
  )
  assert.match(out, /class="awr-elicit__host">pay\.example\.com</)
  assert.match(
    out,
    /<code class="awr-elicit__url">https:\/\/pay\.example\.com\/checkout\?session=abc<\/code>/,
  )
  assert.match(out, /Open in a new tab<\/button>/)
  // "Finished" comes only after the user opened it.
  assert.doesNotMatch(out, /I have finished there/)
  assert.doesNotMatch(out, /<a\s|href=/)
})

test('prompt, link: anything but https (http on loopback) has no Open action', () => {
  for (const url of ['http://pay.example.com/', 'javascript:alert(1)']) {
    const out = html(
      createElement(ElicitationPrompt, {
        elicitations: [pending({ mode: 'url', url, requestedSchema: undefined })],
        onAnswer: noAnswer,
      }),
    )
    assert.doesNotMatch(out, /Open in a new tab/, url)
    assert.match(out, /not a secure \(https\) address/, url)
    assert.match(out, />Decline<\/button>/)
  }
})

const outcome = (over: Partial<ElicitationView>): ElicitationView => ({
  id: 'q9',
  server: 'crm',
  tool: 'crm__create_contact',
  mode: 'form',
  message: 'Who?',
  status: 'cancelled',
  ...over,
})

test("prompt: a question nobody answered says so, with the core's reason; one the user decided does not", () => {
  const out = html(
    createElement(ElicitationPrompt, {
      elicitations: [],
      onAnswer: noAnswer,
      outcomes: [
        outcome({ id: 't', automatic: true, reason: 'timeout' }),
        outcome({ id: 'd', status: 'declined', automatic: false }),
        outcome({ id: 'p', status: 'pending' }),
      ],
    }),
  )
  assert.equal(out.match(/class="awr-elicit-outcome"/g)?.length, 1)
  assert.match(
    out,
    /A question from the MCP server “crm” was answered automatically, and its tool call did not finish: nobody answered in time\./,
  )
  assert.match(out, /data-reason="timeout"/)
  assert.match(out, /aria-label="Dismiss"/)
  // Hidden on request; nothing at all when there is nothing to show.
  assert.equal(
    html(
      createElement(ElicitationPrompt, {
        elicitations: [],
        onAnswer: noAnswer,
        outcomes: [outcome({ automatic: true, reason: 'timeout' })],
        showOutcomes: false,
      }),
    ),
    '',
  )
  assert.equal(html(createElement(ElicitationPrompt, { elicitations: [], onAnswer: noAnswer })), '')
})

test('prompt: relabelled, replaced, the expiry note hidden; a helper that asks is named', () => {
  const relabelled = html(
    createElement(ElicitationPrompt, {
      elicitations: [pending({ subagent: { id: 'h1', depth: 1 } })],
      outcomes: [
        outcome({
          id: 'q1',
          status: 'pending',
          subagent: { id: 'h1', depth: 1, role: 'Researcher' },
        }),
      ],
      onAnswer: noAnswer,
      showExpiry: false,
      labels: { elicitationSubmit: 'Senden', elicitationErrors: { required: (f) => `${f}!` } },
    }),
  )
  assert.match(relabelled, />Senden<\/button>/)
  assert.match(relabelled, /a call by the helper “Researcher”/)
  assert.match(relabelled, /data-subagent="h1"/)
  assert.doesNotMatch(relabelled, /awr-elicit__expiry/)

  const replaced = html(
    createElement(ElicitationPrompt, {
      elicitations: [pending()],
      onAnswer: noAnswer,
      renderElicitation: (e, fallback, answer) =>
        createElement(
          'div',
          { 'data-mine': e.id, onClick: () => answer({ action: 'cancel' }) },
          fallback,
        ),
    }),
  )
  assert.match(replaced, /<div data-mine="q1"><section/)
})

test('AgentChat shows the prompt beside the consent cards, and hides it on request', () => {
  const controller = {
    ...createInitialAgentState(),
    pendingApprovals: [],
    approvalMode: 'autopilot',
    isRunning: true,
    isReady: true,
    run: async () => undefined,
    stop: () => {},
    send: () => false,
    stopSubagent: () => false,
    forgetSkill: async () => false,
    sendUndelivered: () => {},
    discardUndelivered: () => {},
    reset: () => {},
    reload: () => {},
    approve: () => {},
    deny: () => {},
    setApprovalMode: () => {},
    compact: async () => undefined,
    sessionId: 's',
    loadChat: () => {},
    agent: undefined,
  } as unknown as Parameters<typeof AgentChat>[0]['controller']
  const props = {
    controller,
    elicitations: [pending()],
    onElicitationAnswer: noAnswer,
    composer: false as const,
  }
  const shown = html(createElement(AgentChat, props))
  assert.match(shown, /class="awr-elicit awr-elicit--form"/)
  assert.match(shown, /The MCP server “crm” asks for your input/)
  assert.doesNotMatch(
    html(createElement(AgentChat, { ...props, showElicitation: false })),
    /awr-elicit/,
  )
  // Without the hook's answer callback there is nothing to answer with: no prompt.
  assert.doesNotMatch(
    html(createElement(AgentChat, { ...props, onElicitationAnswer: undefined })),
    /awr-elicit/,
  )
})

test('labels: every elicitation label has an English default, every reason the core can give included', () => {
  const reasons = [
    'unsupported-schema',
    'unsupported-mode',
    'insecure-url',
    'invalid-request',
    'subagent',
    'cap-per-call',
    'cap-per-run',
    'handler-error',
    'timeout',
    'invalid-answer',
    'aborted',
    'step-timeout',
    'after-failure',
    'no-tool-call',
    'stopped',
  ]
  assert.deepEqual(Object.keys(defaultLabels.elicitationReasons).sort(), [...reasons].sort())
  for (const kind of Object.keys(defaultLabels.elicitationErrors)) {
    const text = defaultLabels.elicitationErrors[kind as 'required']('Seats', 8)
    assert.match(text, /^Seats/, `${kind} names the field`)
  }
})

// ── over real sockets: the queue as the core's onElicitation ─────────────

const until = async <T>(read: () => T | undefined, what: string): Promise<T> => {
  for (let i = 0; i < 500; i++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

type Connected = {
  results: { connected: boolean }[]
  tools: Record<string, { execute: (args: unknown, options: unknown) => Promise<unknown> }>
  close: () => Promise<void>
}

for (const era of ['legacy', 'modern'] as const) {
  test(`${era}: the hooks' queue answers the core - the form's answer reaches the server, a disconnect cancels`, async () => {
    const { startLocalMcpServer } = await import('@dudko.dev/test-servers')
    const { connectMcpHttp } = (await import('@dudko.dev/agent-web/mcp')) as unknown as {
      connectMcpHttp: (servers: unknown, opts: unknown) => Promise<Connected>
    }
    const server = await startLocalMcpServer({ protocol: 'dual', elicitationTools: true })
    const queue = createElicitationQueue({ timeoutMs: 30_000 })
    try {
      const mcp = await connectMcpHttp(
        { wx: { url: server.url, ...(era === 'modern' ? { protocol: 'modern' } : {}) } },
        { clientName: 'awr-test', ...elicitationConnectOptions(true, queue.handler) },
      )
      assert.deepEqual(
        mcp.results.map((r) => r.connected),
        [true],
      )
      const call = mcp.tools.wx__elicit_form.execute({}, {})
      const question = await until(() => queue.pending()[0], 'the question')
      assert.equal(question.server, 'wx')
      assert.equal(question.tool, 'wx__elicit_form')
      // What a person fills in, turned into the answer by the prompt's own helper.
      const out = elicitationFormAnswer(question.requestedSchema, {
        ...elicitationInitialDraft(question.requestedSchema),
        name: 'Ada',
        email: 'ada@example.test',
        toppings: ['basil'],
      })
      assert.ok(out.ok)
      assert.equal(queue.answer(question.id, { action: 'accept', content: out.content }), true)
      const result = JSON.stringify(await call)
      assert.match(result, /\\"action\\":\\"accept\\"/)
      const round = server.elicitations.at(-1)
      assert.equal(round?.era, era)
      assert.deepEqual(round?.responses?.profile, { action: 'accept', content: out.content })
      assert.deepEqual(round?.capabilities, { form: {} }, 'the form, and no URL mode, was declared')

      // A disconnect: the hook cancels that server's questions - the server is told "cancel".
      const second = mcp.tools.wx__elicit_form.execute({}, {})
      await until(() => queue.pending()[0], 'the second question')
      queue.cancel((r) => r.server === 'wx')
      assert.match(JSON.stringify(await second), /\\"action\\":\\"cancel\\"/)
      assert.deepEqual(server.elicitations.at(-1)?.responses?.profile, { action: 'cancel' })
      assert.deepEqual(queue.pending(), [])
      await mcp.close()
    } finally {
      queue.dispose()
      await server.close()
    }
  })
}

test('legacy: with the option off the hooks pass nothing - the server sees no elicitation capability, and nobody is asked', async () => {
  const { startLocalMcpServer } = await import('@dudko.dev/test-servers')
  const { connectMcpHttp } = (await import('@dudko.dev/agent-web/mcp')) as unknown as {
    connectMcpHttp: (servers: unknown, opts: unknown) => Promise<Connected>
  }
  const server = await startLocalMcpServer({ protocol: 'legacy', elicitationTools: true })
  let asked = 0
  try {
    const mcp = await connectMcpHttp(
      { wx: { url: server.url } },
      {
        clientName: 'awr-test',
        ...elicitationConnectOptions(undefined, () => {
          asked += 1
          return { action: 'cancel' as const }
        }),
      },
    )
    await mcp.tools.wx__elicit_form.execute({}, {}).catch(() => undefined)
    assert.equal(asked, 0)
    assert.ok(server.elicitations.length > 0, 'the tool ran')
    assert.equal(server.elicitations.at(-1)?.capabilities, undefined)
    await mcp.close()
  } finally {
    await server.close()
  }
})
