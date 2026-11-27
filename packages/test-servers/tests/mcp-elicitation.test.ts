import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ELICIT_FORM_SCHEMA,
  ELICIT_HUGE_FIELDS,
  startLocalMcpServer,
  validFormContent,
  type ILocalMcpServer,
} from '../src/index.ts'
import { initialize, legacy, modern, openStream, type IWireAnswer } from './mcp-wire.ts'

// The elicitation tools. On the 2026-07-28 revision everything is hand-built
// JSON-RPC: the question is an `input_required` result and the answer a retry
// of the call. On the 2025 revisions the question is a real request from the
// server on the stream of the call, answered with a POST of its own.

const FORM = { elicitation: { form: {} } }
const BOTH = { elicitation: { form: {}, url: {} } }

/** What a careful user would enter into `elicit_form`: one value of every field type. */
const PROFILE = {
  name: 'Ada',
  email: 'ada@example.test',
  website: 'https://example.test/ada',
  birthday: '1815-12-10',
  meeting: '2026-01-02T10:30:00Z',
  score: 7.5,
  seats: 2,
  subscribe: true,
  color: 'green',
  size: 'l',
  toppings: ['olives', 'basil'],
  languages: ['en', 'pt'],
}

const start = (extra: Parameters<typeof startLocalMcpServer>[0] = {}) =>
  startLocalMcpServer({ protocol: 'modern', elicitationTools: true, ...extra })

/** Call an elicitation tool the modern way; `retry` is what a client adds on a later round. */
const call = (
  mcp: ILocalMcpServer,
  name: string,
  capabilities: Record<string, unknown>,
  retry: { inputResponses?: Record<string, unknown>; requestState?: unknown } = {},
): Promise<IWireAnswer> =>
  modern(mcp.url, 'tools/call', { name, arguments: {}, ...retry }, { capabilities })

/** The text of a final tool result, parsed (the elicitation tools answer JSON). */
const finalOf = (answer: IWireAnswer): Record<string, unknown> => {
  assert.equal(answer.status, 200, answer.text)
  assert.equal(answer.message.result?.resultType ?? 'complete', 'complete', answer.text)
  return JSON.parse(answer.message.result.content[0].text) as Record<string, unknown>
}

/** An `input_required` result: its questions and its state. */
const askedOf = (answer: IWireAnswer) => {
  assert.equal(answer.status, 200, answer.text)
  const { result } = answer.body
  assert.equal(result.resultType, 'input_required', answer.text)
  // Not a final result, and not cacheable.
  assert.equal('content' in result, false)
  assert.equal('ttlMs' in result, false)
  return result as { inputRequests?: Record<string, any>; requestState?: string }
}

test('elicitation tools: off by default, four of them when on, in both eras', async () => {
  const off = await startLocalMcpServer({ protocol: 'dual' })
  const on = await start({ protocol: 'dual' })
  try {
    const names = async (mcp: ILocalMcpServer): Promise<string[][]> => [
      (await modern(mcp.url, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name),
      (
        await legacy(mcp.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      ).message.result.tools.map((t: { name: string }) => t.name),
    ]
    const plain = ['echo', 'secret', 'boom']
    const all = [...plain, 'elicit_form', 'elicit_url', 'elicit_twice', 'elicit_state']
    assert.deepEqual(await names(off), [plain, plain])
    assert.deepEqual(await names(on), [all, all])
    // No pages without the tools.
    assert.notEqual((await fetch(`${off.origin}/elicit/anything`)).status, 404)
    assert.equal((await fetch(`${on.origin}/elicit/anything`)).status, 404)
  } finally {
    await off.close()
    await on.close()
  }
})

test('the form schema covers every field type a form may have, and is checked on the way back', () => {
  const fields = ELICIT_FORM_SCHEMA.properties
  assert.deepEqual(
    [fields.email, fields.website, fields.birthday, fields.meeting].map((f) => f.format),
    ['email', 'uri', 'date', 'date-time'],
  )
  assert.deepEqual(
    [fields.name.type, fields.score.type, fields.seats.type, fields.subscribe.type],
    ['string', 'number', 'integer', 'boolean'],
  )
  assert.ok(Array.isArray(fields.color.enum), 'single-select, plain')
  assert.ok(Array.isArray(fields.size.oneOf), 'single-select, titled')
  assert.ok(Array.isArray(fields.toppings.items.enum), 'multi-select, plain')
  assert.ok(Array.isArray(fields.languages.items.anyOf), 'multi-select, titled')

  assert.equal(validFormContent(ELICIT_FORM_SCHEMA, PROFILE), true)
  assert.equal(validFormContent(ELICIT_FORM_SCHEMA, { name: 'Ada', email: 'a@b.test' }), true)
  const broken: [string, Record<string, unknown>][] = [
    ['a required field is missing', { ...PROFILE, email: undefined }],
    ['too short', { ...PROFILE, name: '' }],
    ['not an email', { ...PROFILE, email: 'ada' }],
    ['not a URI', { ...PROFILE, website: 'not a uri' }],
    ['not a date', { ...PROFILE, birthday: '10/12/1815' }],
    ['not a date-time', { ...PROFILE, meeting: '2026-01-02' }],
    ['a number as a string', { ...PROFILE, score: '7' }],
    ['above the maximum', { ...PROFILE, score: 11 }],
    ['not an integer', { ...PROFILE, seats: 1.5 }],
    ['below the minimum', { ...PROFILE, seats: 0 }],
    ['a boolean as a string', { ...PROFILE, subscribe: 'yes' }],
    ['outside the enum', { ...PROFILE, color: 'pink' }],
    ['outside the titled options', { ...PROFILE, size: 'Small' }],
    ['a multi-select as a string', { ...PROFILE, toppings: 'olives' }],
    ['too many selected', { ...PROFILE, toppings: ['olives', 'basil', 'capers'] }],
    ['none selected', { ...PROFILE, toppings: [] }],
    ['an option that is not offered', { ...PROFILE, languages: ['fr'] }],
  ]
  for (const [label, content] of broken) {
    assert.equal(validFormContent(ELICIT_FORM_SCHEMA, content), false, label)
  }
  assert.equal(validFormContent(ELICIT_FORM_SCHEMA, ['Ada']), false, 'not an object')
})

// ── modern: input_required ────────────────────────────────────────────────

test('modern elicit_form: the form is asked for in an input_required result and read from the retry', async () => {
  const mcp = await start()
  try {
    const first = askedOf(await call(mcp, 'elicit_form', FORM))
    assert.deepEqual(first.inputRequests, {
      profile: {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: 'Fill in the profile',
          requestedSchema: ELICIT_FORM_SCHEMA,
        },
      },
    })
    // Nothing to carry: a client must not invent a state for the retry.
    assert.equal('requestState' in first, false)

    const accepted = finalOf(
      await call(mcp, 'elicit_form', FORM, {
        inputResponses: { profile: { action: 'accept', content: PROFILE } },
      }),
    )
    assert.deepEqual(accepted, { tool: 'elicit_form', action: 'accept', content: PROFILE })

    // Content that breaks the schema is asked for again rather than failed.
    const again = askedOf(
      await call(mcp, 'elicit_form', FORM, {
        inputResponses: { profile: { action: 'accept', content: { ...PROFILE, seats: 99 } } },
      }),
    )
    assert.deepEqual(Object.keys(again.inputRequests ?? {}), ['profile'])
    // So is an answer under a key that was never asked.
    askedOf(
      await call(mcp, 'elicit_form', FORM, { inputResponses: { other: { action: 'accept' } } }),
    )

    for (const action of ['decline', 'cancel']) {
      const refused = await call(mcp, 'elicit_form', FORM, {
        inputResponses: { profile: { action } },
      })
      assert.deepEqual(finalOf(refused), { tool: 'elicit_form', action })
      assert.notEqual(refused.body.result.isError, true, 'saying no is not an error')
    }

    assert.deepEqual(mcp.calls, [{ name: 'elicit_form', args: {} }], 'one call, many rounds')
    assert.equal(mcp.elicitations.length, 6)
    assert.deepEqual(mcp.elicitations[0], {
      tool: 'elicit_form',
      era: 'modern',
      capabilities: { form: {} },
      responses: undefined,
      requestState: undefined,
      stateValid: undefined,
      asked: first.inputRequests
        ? {
            profile: {
              mode: 'form',
              message: 'Fill in the profile',
              requestedSchema: ELICIT_FORM_SCHEMA,
            },
          }
        : undefined,
      issuedState: undefined,
    })
    assert.deepEqual(mcp.elicitations[1].responses, {
      profile: { action: 'accept', content: PROFILE },
    })
    assert.equal(mcp.elicitations[1].asked, undefined, 'that round ended the call')
  } finally {
    await mcp.close()
  }
})

test('modern: a client that did not declare the capability is refused with -32021, not asked', async () => {
  const mcp = await start()
  try {
    const none = await call(mcp, 'elicit_form', {})
    assert.equal(none.status, 400)
    assert.equal(none.body.error.code, -32021)
    assert.deepEqual(none.body.error.data, { requiredCapabilities: { elicitation: { form: {} } } })
    // The form only: URL mode was not declared.
    const formOnly = await call(mcp, 'elicit_url', FORM)
    assert.equal(formOnly.status, 400)
    assert.equal(formOnly.body.error.code, -32021)
    assert.deepEqual(formOnly.body.error.data, {
      requiredCapabilities: { elicitation: { url: {} } },
    })
    // An empty capability is the form only, for backwards compatibility.
    askedOf(await call(mcp, 'elicit_form', { elicitation: {} }))
    assert.equal((await call(mcp, 'elicit_url', { elicitation: {} })).status, 400)
    // URL mode only: the form was not declared.
    assert.equal((await call(mcp, 'elicit_form', { elicitation: { url: {} } })).status, 400)
    askedOf(await call(mcp, 'elicit_url', { elicitation: { url: {} } }))
  } finally {
    await mcp.close()
  }
})

test('modern elicit_url: a page on this server, and the call finishes only once it was submitted', async () => {
  const mcp = await start({ urlElicitationWaitMs: 50 })
  try {
    const first = askedOf(await call(mcp, 'elicit_url', BOTH))
    const { link } = first.inputRequests ?? {}
    assert.equal(link.method, 'elicitation/create')
    assert.deepEqual(Object.keys(link.params).sort(), ['message', 'mode', 'url'])
    assert.equal(link.params.mode, 'url')
    const page = String(link.params.url)
    assert.ok(page.startsWith(`${mcp.origin}/elicit/`), 'a loopback page of this very server')
    assert.equal(typeof first.requestState, 'string')
    assert.deepEqual(
      mcp.urlElicitations.map(({ url, opened, completed }) => ({ url, opened, completed })),
      [{ url: page, opened: 0, completed: false }],
    )

    // What the user's browser does: no token, no MCP.
    const opened = await fetch(page)
    assert.equal(opened.status, 200)
    assert.match(String(opened.headers.get('content-type')), /text\/html/)
    assert.match(await opened.text(), /<form method="post"><button id="complete"/)
    assert.equal(mcp.urlElicitations[0].opened, 1)

    // `accept` is consent to open the page, not its outcome: the server asks
    // to be called again, with a state and nothing to answer.
    const retry = {
      inputResponses: { link: { action: 'accept' } },
      requestState: first.requestState,
    }
    const waiting = askedOf(await call(mcp, 'elicit_url', BOTH, retry))
    assert.equal('inputRequests' in waiting, false)
    assert.equal(typeof waiting.requestState, 'string')

    const submitted = await fetch(page, { method: 'POST' })
    assert.equal(submitted.status, 200)
    assert.match(await submitted.text(), /id="done"/)
    assert.equal(mcp.urlElicitations[0].completed, true)
    assert.equal((await fetch(page, { method: 'DELETE' })).status, 405)

    // A state-only retry carries no inputResponses.
    const done = finalOf(
      await call(mcp, 'elicit_url', BOTH, { requestState: waiting.requestState }),
    )
    assert.deepEqual(done, {
      tool: 'elicit_url',
      action: 'accept',
      completed: mcp.urlElicitations[0].id,
    })

    const declined = askedOf(await call(mcp, 'elicit_url', BOTH))
    assert.deepEqual(
      finalOf(
        await call(mcp, 'elicit_url', BOTH, {
          inputResponses: { link: { action: 'decline' } },
          requestState: declined.requestState,
        }),
      ),
      { tool: 'elicit_url', action: 'decline' },
    )
  } finally {
    await mcp.close()
  }
})

test('modern elicit_url: a round waits for the page and answers as soon as it is submitted', async () => {
  const mcp = await start({ urlElicitationWaitMs: 5000, requireAuth: true })
  try {
    mcp.validTokens.add('t')
    const post = (extra: Record<string, unknown> = {}) =>
      modern(
        mcp.url,
        'tools/call',
        { name: 'elicit_url', arguments: {}, ...extra },
        { capabilities: BOTH, token: 't' },
      )
    const first = askedOf(await post())
    const page = String(first.inputRequests?.link.params.url)
    const started = Date.now()
    const pending = post({
      inputResponses: { link: { action: 'accept' } },
      requestState: first.requestState,
    })
    // The page needs no token even though the MCP endpoint does.
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal((await fetch(page, { method: 'POST' })).status, 200)
    assert.equal(finalOf(await pending).action, 'accept')
    assert.ok(Date.now() - started < 4000, 'it did not sit out the whole wait')
  } finally {
    await mcp.close()
  }
})

test('modern elicit_twice: two rounds, each with its own question, the first answer carried in the state', async () => {
  const mcp = await start()
  try {
    const one = askedOf(await call(mcp, 'elicit_twice', FORM))
    assert.deepEqual(Object.keys(one.inputRequests ?? {}), ['name'])
    assert.equal(one.inputRequests?.name.params.requestedSchema.properties.name.type, 'string')

    const two = askedOf(
      await call(mcp, 'elicit_twice', FORM, {
        inputResponses: { name: { action: 'accept', content: { name: 'Ada' } } },
        requestState: one.requestState,
      }),
    )
    assert.deepEqual(Object.keys(two.inputRequests ?? {}), ['color'])
    assert.equal(two.inputRequests?.color.params.message, 'Which color does Ada like?')
    assert.deepEqual(two.inputRequests?.color.params.requestedSchema.properties.color.enum, [
      'red',
      'green',
      'blue',
    ])
    assert.notEqual(two.requestState, one.requestState, 'a new state for the new round')

    // The second retry carries the color only: the name is in the state.
    const done = finalOf(
      await call(mcp, 'elicit_twice', FORM, {
        inputResponses: { color: { action: 'accept', content: { color: 'blue' } } },
        requestState: two.requestState,
      }),
    )
    assert.deepEqual(done, { tool: 'elicit_twice', action: 'accept', name: 'Ada', color: 'blue' })

    // The first state again is the first round again: the color is asked for, not assumed.
    const replayed = askedOf(
      await call(mcp, 'elicit_twice', FORM, {
        inputResponses: { color: { action: 'accept', content: { color: 'blue' } } },
        requestState: one.requestState,
      }),
    )
    assert.deepEqual(Object.keys(replayed.inputRequests ?? {}), ['name'])
    assert.deepEqual(
      mcp.elicitations.map((round) => round.stateValid),
      [undefined, true, true, true],
    )
    assert.equal(mcp.elicitations[1].requestState, one.requestState, 'recorded as it arrived')
  } finally {
    await mcp.close()
  }
})

test('modern elicit_state: only the exact state that was handed out is accepted', async () => {
  const mcp = await start()
  try {
    const asked = askedOf(await call(mcp, 'elicit_state', FORM))
    const state = String(asked.requestState)
    const answer = { confirm: { action: 'accept', content: { confirm: true } } }
    const retry = (requestState: unknown) =>
      call(mcp, 'elicit_state', FORM, { inputResponses: answer, requestState })

    const ok = finalOf(await retry(state))
    assert.equal(ok.tool, 'elicit_state')
    assert.equal(ok.action, 'accept')
    assert.match(String(ok.nonce), /^[0-9a-f-]{36}$/)

    const [body, signature] = state.split('.')
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString()),
        data: { nonce: 'mine' },
      }),
    ).toString('base64url')
    const other = String(askedOf(await call(mcp, 'elicit_twice', FORM)).requestState)
    const refusals: [string, unknown][] = [
      ['the payload changed under the old signature', `${forged}.${signature}`],
      ['one character of the signature changed', `${body}.${signature.slice(0, -2)}AA`],
      ['a character appended', `${state}A`],
      ['padding appended: the same bytes, not the same string', `${state}=`],
      ['whitespace around it', ` ${state} `],
      ['no signature', body],
      ['not a state at all', 'tampered'],
      ['a state issued to another tool', other],
    ]
    const before = mcp.elicitations.length
    for (const [label, value] of refusals) {
      const refused = await retry(value)
      // In band: the request was well-formed HTTP; the state was not acceptable.
      assert.equal(refused.status, 200, label)
      assert.equal(refused.body.result, undefined, label)
      assert.equal(refused.body.error.code, -32602, label)
      assert.equal(refused.body.error.message, 'Invalid or expired requestState', label)
    }
    const refusedRounds = mcp.elicitations.slice(before)
    assert.equal(refusedRounds.length, refusals.length)
    for (const [i, round] of refusedRounds.entries()) {
      assert.equal(round.stateValid, false, refusals[i][0])
      assert.equal(round.requestState, refusals[i][1], 'recorded exactly as it arrived')
      assert.deepEqual(round.responses, answer)
    }
    // The good one still works afterwards: nothing was consumed by the refusals.
    assert.equal(finalOf(await retry(state)).nonce, ok.nonce)
    // A state of another server is nothing to this one.
    const elsewhere = await start()
    try {
      const foreign = await call(elsewhere, 'elicit_state', FORM, {
        inputResponses: answer,
        requestState: state,
      })
      assert.equal(foreign.body.error.code, -32602)
    } finally {
      await elsewhere.close()
    }
  } finally {
    await mcp.close()
  }
})

test('modern: a state is good for ten minutes, and refused after', async (t) => {
  const mcp = await start()
  try {
    const answer = { confirm: { action: 'accept', content: { confirm: true } } }
    const asked = askedOf(await call(mcp, 'elicit_state', FORM))
    const retry = () =>
      call(mcp, 'elicit_state', FORM, { inputResponses: answer, requestState: asked.requestState })
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    t.mock.timers.tick(9 * 60 * 1000)
    assert.equal(finalOf(await retry()).action, 'accept', 'nine minutes later')
    t.mock.timers.tick(2 * 60 * 1000)
    const late = await retry()
    assert.equal(late.body.error.code, -32602, 'eleven minutes later')
    assert.equal(mcp.elicitations.at(-1)?.stateValid, false)
  } finally {
    t.mock.timers.reset()
    await mcp.close()
  }
})

// ── modern: the fault switches ────────────────────────────────────────────

test('fault neverSatisfied: every round is answered with the question again', async () => {
  const mcp = await start()
  try {
    mcp.elicitationFaults.neverSatisfied = true
    let state: string | undefined
    for (let round = 0; round < 12; round += 1) {
      const asked = askedOf(
        await call(mcp, 'elicit_twice', FORM, {
          ...(round === 0
            ? {}
            : { inputResponses: { name: { action: 'accept', content: { name: 'Ada' } } } }),
          ...(state === undefined ? {} : { requestState: state }),
        }),
      )
      assert.deepEqual(Object.keys(asked.inputRequests ?? {}), ['name'], `round ${round}`)
      state = asked.requestState
    }
    assert.equal(mcp.elicitations.length, 12)
    assert.deepEqual(mcp.calls, [{ name: 'elicit_twice', args: {} }])
    delete mcp.elicitationFaults.neverSatisfied
    const moved = askedOf(
      await call(mcp, 'elicit_twice', FORM, {
        inputResponses: { name: { action: 'accept', content: { name: 'Ada' } } },
        requestState: state,
      }),
    )
    assert.deepEqual(Object.keys(moved.inputRequests ?? {}), ['color'], 'switched off: it moves on')
  } finally {
    await mcp.close()
  }
})

test('faults formSchema and quietResult: a form no client should show, and results without the answers', async () => {
  const mcp = await start()
  try {
    mcp.elicitationFaults.formSchema = 'nested'
    const nested = askedOf(await call(mcp, 'elicit_form', FORM))
    assert.equal(
      nested.inputRequests?.profile.params.requestedSchema.properties.address.type,
      'object',
    )
    mcp.elicitationFaults.formSchema = 'huge'
    const huge = askedOf(await call(mcp, 'elicit_form', FORM))
    assert.equal(
      Object.keys(huge.inputRequests?.profile.params.requestedSchema.properties).length,
      ELICIT_HUGE_FIELDS,
    )
    // A decline is answered as ever.
    assert.deepEqual(
      finalOf(
        await call(mcp, 'elicit_form', FORM, {
          inputResponses: { profile: { action: 'decline' } },
        }),
      ),
      { tool: 'elicit_form', action: 'decline' },
    )
    delete mcp.elicitationFaults.formSchema

    mcp.elicitationFaults.quietResult = true
    assert.deepEqual(
      finalOf(
        await call(mcp, 'elicit_form', FORM, {
          inputResponses: { profile: { action: 'accept', content: PROFILE } },
        }),
      ),
      { tool: 'elicit_form', action: 'accept' },
      'the answer is not repeated in the result',
    )
    delete mcp.elicitationFaults.quietResult
    assert.deepEqual(
      finalOf(
        await call(mcp, 'elicit_form', FORM, {
          inputResponses: { profile: { action: 'accept', content: PROFILE } },
        }),
      ).content,
      PROFILE,
    )
  } finally {
    await mcp.close()
  }
})

test('fault undeclaredMode: the client is asked in the mode it did not declare', async () => {
  const mcp = await start()
  try {
    mcp.elicitationFaults.undeclaredMode = true
    // Declared the form only: asked to open a URL, where an honest server answers -32021.
    const url = askedOf(await call(mcp, 'elicit_form', FORM))
    assert.deepEqual(Object.keys(url.inputRequests ?? {}), ['undeclared'])
    assert.equal(url.inputRequests?.undeclared.params.mode, 'url')
    assert.ok(String(url.inputRequests?.undeclared.params.url).startsWith(`${mcp.origin}/elicit/`))
    // Declared URL mode only: asked to fill in a form.
    const form = askedOf(await call(mcp, 'elicit_url', { elicitation: { url: {} } }))
    assert.equal(form.inputRequests?.undeclared.params.mode, 'form')
    // Declared nothing at all: still asked.
    assert.equal(
      askedOf(await call(mcp, 'elicit_form', {})).inputRequests?.undeclared.params.mode,
      'url',
    )
    // The record keeps what the client really declared, not what the server pretended.
    assert.deepEqual(
      mcp.elicitations.map((round) => round.capabilities),
      [{ form: {} }, { url: {} }, undefined],
    )
    // What the client answers to it is reported back.
    const answered = finalOf(
      await call(mcp, 'elicit_form', FORM, {
        inputResponses: { undeclared: { action: 'decline' } },
      }),
    )
    assert.deepEqual(answered, { tool: 'elicit_form', undeclared: 'url', action: 'decline' })
    // A client that declared both has no undeclared mode: the tool is its normal self.
    assert.deepEqual(
      Object.keys(askedOf(await call(mcp, 'elicit_form', BOTH)).inputRequests ?? {}),
      ['profile'],
    )
    delete mcp.elicitationFaults.undeclaredMode
    assert.equal((await call(mcp, 'elicit_url', FORM)).body.error.code, -32021, 'switched off')
  } finally {
    await mcp.close()
  }
})

test('fault tamperState: the state handed out does not verify, so an exact echo is refused', async () => {
  const mcp = await start()
  try {
    const answer = { confirm: { action: 'accept', content: { confirm: true } } }
    mcp.elicitationFaults.tamperState = true
    const asked = askedOf(await call(mcp, 'elicit_state', FORM))
    assert.match(String(asked.requestState), /^[\w-]+\.[\w-]+$/, 'it looks like any other state')
    const refused = await call(mcp, 'elicit_state', FORM, {
      inputResponses: answer,
      requestState: asked.requestState,
    })
    assert.equal(refused.status, 200)
    assert.equal(refused.body.error.code, -32602)
    assert.deepEqual(refused.body.error.data, { reason: 'invalid_request_state' })
    assert.equal(mcp.elicitations.at(-1)?.stateValid, false)
    assert.equal(mcp.elicitations.at(-1)?.requestState, asked.requestState)

    delete mcp.elicitationFaults.tamperState
    const honest = askedOf(await call(mcp, 'elicit_state', FORM))
    assert.equal(
      finalOf(
        await call(mcp, 'elicit_state', FORM, {
          inputResponses: answer,
          requestState: honest.requestState,
        }),
      ).action,
      'accept',
      'switched off',
    )
  } finally {
    await mcp.close()
  }
})

// ── legacy: real requests from the server ─────────────────────────────────

const toolCall = (name: string, id: number) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: {} },
  }),
})

test('legacy elicit_form: a real elicitation/create request on the stream of the call, answered by a POST', async () => {
  const mcp = await start({ protocol: 'legacy' })
  try {
    assert.equal((await initialize(mcp.url, FORM)).status, 200)
    const stream = await openStream(mcp.url, toolCall('elicit_form', 5))
    assert.equal(stream.status, 200)
    assert.equal(stream.headers.get('content-type'), 'text/event-stream')
    assert.equal(stream.headers.get('mcp-session-id'), null)

    const request = await stream.next()
    assert.equal(request.jsonrpc, '2.0')
    assert.equal(typeof request.id, 'number')
    assert.equal(request.method, 'elicitation/create')
    assert.deepEqual(request.params, {
      mode: 'form',
      message: 'Fill in the profile',
      requestedSchema: ELICIT_FORM_SCHEMA,
    })
    // No `input_required` and no state on this wire.
    assert.equal('result' in request, false)

    // The answer is a POST of its own: accepted, and nothing in its body.
    const answered = await legacy(mcp.url, {
      jsonrpc: '2.0',
      id: request.id,
      result: { action: 'accept', content: PROFILE },
    })
    assert.equal(answered.status, 202)
    assert.equal(answered.text, '')

    const result = await stream.next()
    assert.equal(result.id, 5)
    assert.equal('resultType' in result.result, false)
    assert.deepEqual(JSON.parse(result.result.content[0].text), {
      tool: 'elicit_form',
      action: 'accept',
      content: PROFILE,
    })
    assert.equal(await stream.next(), undefined, 'the result ends the stream')

    assert.deepEqual(mcp.calls, [{ name: 'elicit_form', args: {} }])
    assert.deepEqual(
      mcp.elicitations.map(({ era, capabilities, responses }) => ({
        era,
        capabilities,
        responses,
      })),
      [
        { era: 'legacy', capabilities: { form: {} }, responses: undefined },
        {
          era: 'legacy',
          capabilities: { form: {} },
          responses: { profile: { action: 'accept', content: PROFILE } },
        },
      ],
    )
  } finally {
    await mcp.close()
  }
})

test('legacy: no declared capability, no request - and an error from the client fails the call', async () => {
  const mcp = await start({ protocol: 'legacy' })
  try {
    // Nothing declared (not even a handshake): the tool fails without asking.
    const undeclared = await legacy(mcp.url, JSON.parse(String(toolCall('elicit_form', 1).body)))
    assert.equal(undeclared.events.length, 1, 'no request went out')
    assert.equal(undeclared.message.result.isError, true)
    assert.match(undeclared.message.result.content[0].text, /did not declare .* \(form mode\)/)
    await initialize(mcp.url, FORM)
    const urlMode = await legacy(mcp.url, JSON.parse(String(toolCall('elicit_url', 2).body)))
    assert.equal(urlMode.events.length, 1)
    assert.match(urlMode.message.result.content[0].text, /\(url mode\)/)

    const stream = await openStream(mcp.url, toolCall('elicit_form', 3))
    const request = await stream.next()
    const answered = await legacy(mcp.url, {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32603, message: 'the form could not be shown' },
    })
    assert.equal(answered.status, 202)
    const failed = await stream.next()
    assert.equal(failed.result.isError, true)
    assert.equal(
      failed.result.content[0].text,
      'elicitation/create failed: -32603 the form could not be shown',
    )

    // A client that hangs up instead of answering leaves nothing waiting.
    const abandoned = await openStream(mcp.url, toolCall('elicit_form', 4))
    const pending = await abandoned.next()
    abandoned.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const late = await legacy(mcp.url, {
      jsonrpc: '2.0',
      id: pending.id,
      result: { action: 'accept', content: PROFILE },
    })
    assert.equal(late.status, 202, 'a stray answer is accepted and dropped, as it always was')
  } finally {
    await mcp.close()
  }
})

test('legacy elicit_url: the request carries an elicitationId, and the completion is announced', async () => {
  const mcp = await start({ protocol: 'legacy' })
  try {
    await initialize(mcp.url, BOTH)
    const stream = await openStream(mcp.url, toolCall('elicit_url', 9))
    const request = await stream.next()
    assert.equal(request.method, 'elicitation/create')
    assert.deepEqual(Object.keys(request.params).sort(), [
      'elicitationId',
      'message',
      'mode',
      'url',
    ])
    assert.equal(request.params.mode, 'url')
    assert.equal(request.params.url, `${mcp.origin}/elicit/${request.params.elicitationId}`)

    assert.equal((await fetch(request.params.url, { method: 'POST' })).status, 200)
    await legacy(mcp.url, { jsonrpc: '2.0', id: request.id, result: { action: 'accept' } })
    assert.deepEqual(await stream.next(), {
      jsonrpc: '2.0',
      method: 'notifications/elicitation/complete',
      params: { elicitationId: request.params.elicitationId },
    })
    const result = await stream.next()
    assert.deepEqual(JSON.parse(result.result.content[0].text), {
      tool: 'elicit_url',
      action: 'accept',
      completed: request.params.elicitationId,
    })
  } finally {
    await mcp.close()
  }
})

/** The 1.x SDK client, answering elicitation the way a host application would. */
const sdkClient = async (
  url: string,
  capabilities: Record<string, unknown>,
  answer: (params: Record<string, unknown>) => Record<string, unknown>,
) => {
  const asked: Record<string, unknown>[] = []
  const client = new Client({ name: 'elicitation-test', version: '1.0.0' }, { capabilities })
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    asked.push(request.params)
    return answer(request.params) as never
  })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return { client, asked }
}

const textOf = (result: unknown): string =>
  (result as { content: { text: string }[] }).content[0].text

test('legacy elicit_twice and elicit_state, with the 1.x SDK client as the peer', async () => {
  for (const protocol of ['legacy', 'dual'] as const) {
    const mcp = await start({ protocol })
    try {
      const { client, asked } = await sdkClient(mcp.url, FORM, (params) => {
        const fields = (params.requestedSchema as { properties: Record<string, unknown> })
          .properties
        return {
          action: 'accept',
          content:
            'name' in fields
              ? { name: 'Ada' }
              : 'color' in fields
                ? { color: 'red' }
                : { confirm: true },
        }
      })
      const twice = await client.callTool({ name: 'elicit_twice', arguments: {} })
      assert.deepEqual(JSON.parse(textOf(twice)), {
        tool: 'elicit_twice',
        action: 'accept',
        name: 'Ada',
        color: 'red',
      })
      assert.deepEqual(
        asked.map((params) => params.message),
        ['Who is it?', 'Which color does Ada like?'],
      )
      const state = await client.callTool({ name: 'elicit_state', arguments: {} })
      assert.equal(JSON.parse(textOf(state)).action, 'accept')
      await client.close()
      assert.deepEqual(
        mcp.elicitations.map((round) => [round.tool, round.era, round.stateValid]),
        [
          ['elicit_twice', 'legacy', undefined],
          ['elicit_twice', 'legacy', true],
          ['elicit_twice', 'legacy', true],
          ['elicit_state', 'legacy', undefined],
          ['elicit_state', 'legacy', true],
        ],
        protocol,
      )
    } finally {
      await mcp.close()
    }
  }
})

test('legacy faults: asked without end, asked in an undeclared mode, a state that does not verify', async () => {
  const mcp = await start({ protocol: 'legacy' })
  try {
    const { client, asked } = await sdkClient(mcp.url, FORM, (params) =>
      params.mode === 'url'
        ? { action: 'decline' }
        : { action: 'accept', content: { name: 'Ada', confirm: true } },
    )
    mcp.elicitationFaults.neverSatisfied = true
    const endless = await client.callTool({ name: 'elicit_twice', arguments: {} })
    assert.equal(endless.isError, true)
    assert.equal(textOf(endless), 'elicit_twice still needs input after 8 rounds')
    assert.equal(asked.length, 8, 'the same question, eight times')
    delete mcp.elicitationFaults.neverSatisfied

    asked.length = 0
    mcp.elicitationFaults.undeclaredMode = true
    const undeclared = await client.callTool({ name: 'elicit_form', arguments: {} })
    // The request did go out in URL mode: this client declared the form only,
    // and the SDK refuses it before the application is asked.
    assert.equal(asked.length, 0)
    assert.equal(undeclared.isError, true)
    assert.match(textOf(undeclared), /^elicitation\/create failed: -32602 .*URL/i)
    assert.equal(mcp.elicitations.at(-1)?.asked?.undeclared.mode, 'url')
    delete mcp.elicitationFaults.undeclaredMode

    mcp.elicitationFaults.tamperState = true
    const tampered = await client.callTool({ name: 'elicit_state', arguments: {} })
    assert.equal(tampered.isError, true)
    assert.equal(textOf(tampered), 'Invalid or expired requestState')
    assert.equal(mcp.elicitations.at(-1)?.stateValid, false)
    delete mcp.elicitationFaults.tamperState
    const fine = await client.callTool({ name: 'elicit_state', arguments: {} })
    assert.equal(JSON.parse(textOf(fine)).action, 'accept')
    await client.close()
  } finally {
    await mcp.close()
  }
})
