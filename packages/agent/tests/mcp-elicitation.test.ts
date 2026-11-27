import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { startLocalMcpServer, type ILocalMcpServer } from '@dudko.dev/test-servers'
import { runContext } from '../src/context.ts'
import type {
  McpElicitationHandler,
  McpElicitationOptions,
  McpElicitationRequest,
  McpElicitationResult,
} from '../src/mcp-elicitation.ts'
import { connectMcpServers } from '../src/mcp.ts'
import type { AgentEvent } from '../src/types.ts'
import { captureMcpWire, type IWireRequest } from './helpers/mcp-wire.ts'

// MCP elicitation through the connector, against REAL servers over real sockets
// (`@dudko.dev/test-servers`): the 1.x server SDK sends `elicitation/create`
// requests (`legacy`), the 2.x one answers `input_required` (`modern`). Every
// row of the matrix runs on both. The guards themselves are unit-tested in
// `mcp-elicitation-shared.test.ts`; the agent around the connector (events in a
// run, the model's context, snapshots, traces, subagents) in
// `mcp-elicitation-integration.test.ts`.

type Era = 'legacy' | 'modern'
const ERAS: Era[] = ['legacy', 'modern']

/** A value no server, schema or test name contains: if it shows up somewhere, the client put it there. */
const SECRET = 'S3CR3T-answer-7f3a'

interface IOpened {
  server: ILocalMcpServer
  tools: Record<string, unknown>
  logs: string[]
  events: AgentEvent[]
  asked: McpElicitationRequest[]
  call: (name: string, options?: Record<string, unknown>) => Promise<unknown>
  /** The outcome as text: the result, or `Name: message` of what was thrown. */
  outcome: (name: string, options?: Record<string, unknown>) => Promise<string>
}

const withMcp = async (
  era: Era,
  setup: {
    onElicitation?: McpElicitationHandler
    elicitation?: McpElicitationOptions
    structuredTools?: boolean
    urlElicitationWaitMs?: number
  },
  body: (ctx: IOpened) => Promise<void>,
): Promise<void> => {
  const server = await startLocalMcpServer({
    protocol: era,
    elicitationTools: true,
    structuredTools: setup.structuredTools,
    urlElicitationWaitMs: setup.urlElicitationWaitMs,
  })
  const logs: string[] = []
  const events: AgentEvent[] = []
  const asked: McpElicitationRequest[] = []
  const handler = setup.onElicitation
  const mcp = await connectMcpServers(
    { wx: { url: server.url, ...(era === 'modern' ? { protocol: 'modern' as const } : {}) } },
    (level, message) => logs.push(`${level} ${message}`),
    'agent-test',
    undefined,
    undefined,
    undefined,
    {
      ...(handler
        ? {
            onElicitation: (request, ctx) => {
              asked.push(request)
              return handler(request, ctx)
            },
          }
        : {}),
      ...(setup.elicitation ? { elicitation: setup.elicitation } : {}),
      emit: (event) => events.push(event),
    },
  )
  const call = (name: string, options: Record<string, unknown> = {}): Promise<unknown> =>
    (mcp.tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(
      {},
      options,
    )
  try {
    assert.deepEqual(mcp.results, [{ name: 'wx', connected: true }])
    await body({
      server,
      tools: mcp.tools,
      logs,
      events,
      asked,
      call,
      outcome: (name, options) =>
        call(name, options).then(
          (value) => (typeof value === 'string' ? value : JSON.stringify(value)),
          (err: unknown) => String(err),
        ),
    })
  } finally {
    await mcp.close()
    await server.close()
  }
}

/** Answers the test server's forms: a name, then a color; anything else with a confirmation. */
const answerForms: McpElicitationHandler = (request): McpElicitationResult => {
  const fields = request.requestedSchema?.properties ?? {}
  if (fields.email) return { action: 'accept', content: { name: 'Ada', email: 'ada@example.test' } }
  if (fields.name) return { action: 'accept', content: { name: 'Ada' } }
  if (fields.color) return { action: 'accept', content: { color: 'green' } }
  return { action: 'accept', content: { confirm: true } }
}

const answered = (events: AgentEvent[]) =>
  events.flatMap((e) =>
    e.type === 'mcp.elicitation-answered'
      ? [[e.action, e.automatic, e.reason ?? null, e.fields ?? null]]
      : [],
  )

for (const era of ERAS) {
  // ── the matrix ────────────────────────────────────────────────────────────

  test(`${era} / accept: two questions, one call on the server, the result passed on`, async () => {
    await withMcp(era, { onElicitation: answerForms }, async (ctx) => {
      assert.equal(
        await ctx.outcome('wx__elicit_twice'),
        JSON.stringify({ tool: 'elicit_twice', action: 'accept', name: 'Ada', color: 'green' }),
      )
      // The server ran the tool ONCE, however many requests it took.
      assert.deepEqual(ctx.server.calls, [{ name: 'elicit_twice', args: {} }])
      assert.deepEqual(
        ctx.asked.map((r) => [r.server, r.tool, r.mode, r.message]),
        [
          ['wx', 'wx__elicit_twice', 'form', 'Who is it?'],
          ['wx', 'wx__elicit_twice', 'form', 'Which color does Ada like?'],
        ],
      )
      assert.deepEqual(
        ctx.events.map((e) => e.type),
        [
          'mcp.elicitation-requested',
          'mcp.elicitation-answered',
          'mcp.elicitation-requested',
          'mcp.elicitation-answered',
        ],
      )
      assert.deepEqual(answered(ctx.events), [
        ['accept', false, null, ['name']],
        ['accept', false, null, ['color']],
      ])
      // What the server received is what the host answered, and nothing else.
      const responses = ctx.server.elicitations.flatMap((r) => Object.values(r.responses ?? {}))
      assert.deepEqual(responses, [
        { action: 'accept', content: { name: 'Ada' } },
        { action: 'accept', content: { color: 'green' } },
      ])
      // The state the server handed out came back untouched (modern), or never left it (legacy).
      assert.ok(ctx.server.elicitations.every((r) => r.stateValid !== false))
    })
  })

  test(`${era} / accept: a signed state comes back byte for byte`, async () => {
    await withMcp(era, { onElicitation: answerForms }, async (ctx) => {
      const out = JSON.parse(await ctx.outcome('wx__elicit_state')) as Record<string, unknown>
      assert.equal(out.action, 'accept')
      const rounds = ctx.server.elicitations
      assert.equal(rounds.at(-1)?.stateValid, true)
      if (era === 'modern') {
        assert.equal(rounds.at(-1)?.requestState, rounds[0].issuedState)
      }
      assert.deepEqual(ctx.server.calls, [{ name: 'elicit_state', args: {} }])
    })
  })

  for (const action of ['decline', 'cancel'] as const) {
    test(`${era} / ${action}: the host's no reaches the server, and its result is passed on`, async () => {
      await withMcp(era, { onElicitation: () => ({ action }) }, async (ctx) => {
        // A valid outcome, not an error: the server decides what a "no" means.
        assert.equal(
          await ctx.outcome('wx__elicit_form'),
          JSON.stringify({ tool: 'elicit_form', action }),
        )
        assert.deepEqual(ctx.server.calls, [{ name: 'elicit_form', args: {} }])
        assert.deepEqual(answered(ctx.events), [[action, false, null, null]])
        assert.deepEqual(
          ctx.server.elicitations.flatMap((r) => Object.values(r.responses ?? {})),
          [{ action }],
        )
      })
    })
  }

  test(`${era} / the callback throws: cancelled, the call fails clearly, nothing is retried`, async () => {
    await withMcp(
      era,
      {
        onElicitation: () => {
          throw new Error(`dialog crashed while the user typed ${SECRET}`)
        },
      },
      async (ctx) => {
        const out = await ctx.outcome('wx__elicit_twice')
        assert.match(out, /^McpToolError: MCP tool "wx__elicit_twice" did not finish/)
        assert.match(out, /its elicitation handler failed/)
        assert.match(out, /The call was not repeated/)
        assert.equal(ctx.asked.length, 1)
        assert.deepEqual(ctx.server.calls, [{ name: 'elicit_twice', args: {} }])
        assert.deepEqual(answered(ctx.events), [['cancel', true, 'handler-error', null]])
        if (era === 'modern') {
          // No second request: the server saw the first call and nothing after.
          assert.equal(ctx.server.elicitations.length, 1)
          assert.equal(ctx.server.requests.filter((r) => r.method === 'tools/call').length, 1)
        } else {
          // The pending request was answered `cancel`; the server's own result is discarded.
          assert.deepEqual(
            ctx.server.elicitations.flatMap((r) => Object.values(r.responses ?? {})),
            [{ action: 'cancel' }],
          )
        }
        assert.equal(JSON.stringify([out, ctx.events, ctx.logs]).includes(SECRET), false)
      },
    )
  })

  test(`${era} / timeout: nobody answers, the question is cancelled and the call fails`, async () => {
    let hostSignal: AbortSignal | undefined
    await withMcp(
      era,
      {
        onElicitation: (_request, ctx) => {
          hostSignal = ctx.signal
          return new Promise(() => {})
        },
        elicitation: { timeoutMs: 60 },
      },
      async (ctx) => {
        const out = await ctx.outcome('wx__elicit_form')
        assert.match(out, /nobody answered within 60 ms \(elicitation\.timeoutMs\)/)
        assert.equal(hostSignal?.aborted, true, 'the host was not told the wait is over')
        assert.deepEqual(ctx.server.calls, [{ name: 'elicit_form', args: {} }])
        assert.deepEqual(answered(ctx.events), [['cancel', true, 'timeout', null]])
        if (era === 'modern') {
          assert.equal(ctx.server.requests.filter((r) => r.method === 'tools/call').length, 1)
        }
      },
    )
  })

  test(`${era} / abort: stopping the run cancels the pending question`, async () => {
    let hostSignal: AbortSignal | undefined
    let asked!: () => void
    const waiting = new Promise<void>((resolve) => {
      asked = resolve
    })
    await withMcp(
      era,
      {
        onElicitation: (_request, ctx) => {
          hostSignal = ctx.signal
          asked()
          return new Promise(() => {})
        },
      },
      async (ctx) => {
        const controller = new AbortController()
        const pending = ctx.outcome('wx__elicit_form', { abortSignal: controller.signal })
        await waiting
        controller.abort(new Error('stopped by the user'))
        const out = await pending
        assert.match(out, /stopped by the user/)
        assert.equal(hostSignal?.aborted, true)
        assert.deepEqual(answered(ctx.events), [['cancel', true, 'aborted', null]])
        assert.deepEqual(ctx.server.calls, [{ name: 'elicit_form', args: {} }])
        // Nothing was sent on behalf of the stopped call.
        assert.equal(
          ctx.server.elicitations.some((r) =>
            Object.values(r.responses ?? {}).some(
              (a) => (a as { action?: string }).action === 'accept',
            ),
          ),
          false,
        )
      },
    )
  })

  test(`${era} / an answer that does not fit the form is not sent`, async () => {
    await withMcp(
      era,
      {
        // The form asks for a name (a text of at least one character).
        onElicitation: () => ({ action: 'accept', content: { name: '', extra: SECRET } }) as never,
      },
      async (ctx) => {
        const out = await ctx.outcome('wx__elicit_twice')
        assert.match(out, /the answer did not fit the form \(.*\) and was not sent/)
        assert.deepEqual(answered(ctx.events), [['cancel', true, 'invalid-answer', null]])
        // The server never saw the content.
        assert.equal(JSON.stringify(ctx.server.elicitations).includes(SECRET), false)
        assert.equal(
          ctx.server.elicitations.some((r) =>
            Object.values(r.responses ?? {}).some(
              (a) => (a as { action?: string }).action === 'accept',
            ),
          ),
          false,
        )
        assert.deepEqual(ctx.server.calls, [{ name: 'elicit_twice', args: {} }])
        assert.equal(JSON.stringify([out, ctx.events, ctx.logs]).includes(SECRET), false)
      },
    )
  })

  test(`${era} / a form with more fields than a form may have is declined, the host not asked`, async () => {
    await withMcp(era, { onElicitation: answerForms }, async (ctx) => {
      ctx.server.elicitationFaults.formSchema = 'huge'
      const out = await ctx.outcome('wx__elicit_form')
      assert.match(out, /the form it sent cannot be shown \(the form has more than 50 fields\)/)
      assert.equal(ctx.asked.length, 0)
      assert.deepEqual(answered(ctx.events), [['decline', true, 'unsupported-schema', null]])
      assert.deepEqual(ctx.server.calls, [{ name: 'elicit_form', args: {} }])
      if (era === 'modern') {
        assert.equal(ctx.server.requests.filter((r) => r.method === 'tools/call').length, 1)
      }
    })
  })

  test(`${era} / a nested form is refused, the host not asked`, async () => {
    await withMcp(era, { onElicitation: answerForms }, async (ctx) => {
      ctx.server.elicitationFaults.formSchema = 'nested'
      const out = await ctx.outcome('wx__elicit_form')
      assert.equal(ctx.asked.length, 0)
      assert.match(out, /^McpToolError: /)
      if (era === 'modern') {
        assert.match(out, /cannot be shown \(field "address" has an unsupported type \(object\)/)
        assert.deepEqual(answered(ctx.events), [['decline', true, 'unsupported-schema', null]])
      } else {
        // On the 2025 wire the SDK's own check of the request refuses it first
        // (a JSON-RPC error to the server, which fails its tool): same outcome,
        // one layer earlier.
        assert.match(out, /elicitation\/create failed: -32602/)
      }
      assert.deepEqual(ctx.server.calls, [{ name: 'elicit_form', args: {} }])
    })
  })

  test(`${era} / no callback: no capability, the server cannot ask, the call fails as before`, async () => {
    await withMcp(era, { elicitation: { url: true, timeoutMs: 5 } }, async (ctx) => {
      const out = await ctx.outcome('wx__elicit_form')
      if (era === 'legacy') {
        assert.deepEqual(ctx.server.initializeCapabilities, [{}])
        assert.match(out, /The client did not declare the elicitation capability \(form mode\)/)
      } else {
        // -32021: the request did not declare what the tool needs.
        assert.match(out, /-32021|capabilit/i)
        assert.equal(JSON.stringify(ctx.server.elicitations).includes('"elicitation"'), false)
        // And a server that asks anyway gets the error this client always gave.
        ctx.server.elicitationFaults.undeclaredMode = true
        const forced = await ctx.outcome('wx__elicit_form')
        assert.match(forced, /did not finish: the server asked for more input/)
        assert.match(forced, /which this client does not support/)
      }
      assert.deepEqual(ctx.events, [])
    })
  })

  // ── what is declared ──────────────────────────────────────────────────────

  test(`${era} / the capability: the form with a callback, URL mode only when asked for`, async () => {
    const declared = async (elicitation?: McpElicitationOptions): Promise<unknown> => {
      let seen: unknown
      await withMcp(era, { onElicitation: answerForms, elicitation }, async (ctx) => {
        await ctx.outcome('wx__elicit_state')
        seen =
          era === 'legacy'
            ? ctx.server.initializeCapabilities.at(-1)?.elicitation
            : ctx.server.elicitations[0].capabilities
      })
      return seen
    }
    assert.deepEqual(await declared(), { form: {} })
    assert.deepEqual(await declared({ url: true }), { form: {}, url: {} })
  })

  // ── URL mode ──────────────────────────────────────────────────────────────

  test(`${era} / URL mode: the link is handed to the host, which opens it; nothing here does`, async () => {
    const links: string[] = []
    await withMcp(
      era,
      {
        onElicitation: async (request) => {
          assert.equal(request.mode, 'url')
          links.push(request.url ?? '')
          // The HOST opens the page (here: submits it), then says the user agreed.
          await fetch(request.url as string, { method: 'POST' })
          return { action: 'accept' }
        },
        elicitation: { url: true },
        urlElicitationWaitMs: 2_000,
      },
      async (ctx) => {
        const out = JSON.parse(await ctx.outcome('wx__elicit_url')) as Record<string, unknown>
        assert.equal(out.action, 'accept')
        assert.equal(links.length, 1)
        assert.equal(links[0], ctx.server.urlElicitations[0].url)
        // Never fetched by the connector: the page was not opened (GET), only submitted by the host.
        assert.equal(ctx.server.urlElicitations[0].opened, 0)
        assert.equal(ctx.server.urlElicitations[0].completed, true)
        assert.deepEqual(ctx.server.calls, [{ name: 'elicit_url', args: {} }])
        assert.equal(ctx.asked[0].requestedSchema, undefined)
        assert.equal(ctx.asked[0].elicitationId !== undefined, era === 'legacy')
        assert.deepEqual(answered(ctx.events), [['accept', false, null, null]])
        const requested = ctx.events.find((e) => e.type === 'mcp.elicitation-requested')
        assert.equal(requested?.type === 'mcp.elicitation-requested' && requested.url, links[0])
      },
    )
  })

  test(`${era} / URL mode: declined by the host, the page is never touched`, async () => {
    await withMcp(
      era,
      { onElicitation: () => ({ action: 'decline' }), elicitation: { url: true } },
      async (ctx) => {
        assert.equal(
          await ctx.outcome('wx__elicit_url'),
          JSON.stringify({ tool: 'elicit_url', action: 'decline' }),
        )
        assert.deepEqual(
          ctx.server.urlElicitations.map((p) => [p.opened, p.completed]),
          [[0, false]],
        )
      },
    )
  })

  test(`${era} / URL mode that was not offered is refused, even when a server asks anyway`, async () => {
    await withMcp(era, { onElicitation: () => ({ action: 'accept' }) }, async (ctx) => {
      // The server asks for a link from a client that declared the form only.
      ctx.server.elicitationFaults.undeclaredMode = true
      const out = await ctx.outcome('wx__elicit_form')
      assert.equal(ctx.asked.length, 0, 'the host was shown a link it did not offer to take')
      assert.match(out, /^McpToolError: /)
      if (era === 'modern') {
        assert.match(out, /asked in a way this client does not offer \(URL mode was not offered/)
        assert.deepEqual(answered(ctx.events), [['decline', true, 'unsupported-mode', null]])
      } else {
        assert.match(out, /Client does not support URL-mode elicitation requests/)
      }
      assert.equal(
        ctx.server.urlElicitations.every((p) => p.opened === 0 && !p.completed),
        true,
      )
    })
  })

  // ── caps ──────────────────────────────────────────────────────────────────

  test(`${era} / a server that never stops asking: five questions, then the call fails`, async () => {
    await withMcp(era, { onElicitation: answerForms }, async (ctx) => {
      ctx.server.elicitationFaults.neverSatisfied = true
      const out = await ctx.outcome('wx__elicit_twice')
      assert.match(
        out,
        /it had already asked 5 time\(s\) in this call \(elicitation\.maxPerToolCall\)/,
      )
      assert.equal(ctx.asked.length, 5)
      assert.deepEqual(ctx.server.calls, [{ name: 'elicit_twice', args: {} }])
      // The first answer nobody decided is the cap; a 2025 server that asks yet again after
      // that has its call aborted ('after-failure').
      const automatic = answered(ctx.events).filter((a) => a[1] === true)
      assert.equal(automatic[0][2], 'cap-per-call')
      assert.ok(automatic.length <= 2, 'the server went on being answered')
    })
  })

  test(`${era} / maxPerToolCall is the host's to set`, async () => {
    await withMcp(
      era,
      { onElicitation: answerForms, elicitation: { maxPerToolCall: 1 } },
      async (ctx) => {
        // elicit_twice needs two answers: the second question is one too many.
        const out = await ctx.outcome('wx__elicit_twice')
        assert.match(out, /it had already asked 1 time\(s\) in this call/)
        assert.equal(ctx.asked.length, 1)
        assert.deepEqual(ctx.server.calls, [{ name: 'elicit_twice', args: {} }])
      },
    )
  })

  test(`${era} / maxPerRun counts across the calls of one run, and starts again in the next`, async () => {
    await withMcp(
      era,
      { onElicitation: answerForms, elicitation: { maxPerRun: 3 } },
      async (ctx) => {
        const inRun = <T>(runId: string, fn: () => Promise<T>): Promise<T> =>
          runContext.run({ runId, startedAt: Date.now(), sandboxDir: '', state: {} as never }, fn)
        await inRun('run-1', async () => {
          assert.match(await ctx.outcome('wx__elicit_twice'), /"action":"accept"/)
          assert.match(await ctx.outcome('wx__elicit_state'), /"action":"accept"/)
          // Three were asked; the fourth is not.
          const out = await ctx.outcome('wx__elicit_state')
          assert.match(
            out,
            /3 question\(s\) were already asked in this run \(elicitation\.maxPerRun\)/,
          )
          assert.equal(ctx.asked.length, 3)
          assert.ok(ctx.asked.every((r) => r.runId === 'run-1'))
        })
        await inRun('run-2', async () => {
          assert.match(await ctx.outcome('wx__elicit_state'), /"action":"accept"/)
        })
        assert.equal(ctx.asked.length, 4)
      },
    )
  })

  // ── what stays as it was ──────────────────────────────────────────────────

  test(`${era} / a result that breaks its outputSchema is still passed on with a note`, async () => {
    await withMcp(era, { onElicitation: answerForms, structuredTools: true }, async (ctx) => {
      ctx.server.structuredFaults.result = 'mismatch'
      const out = (await ctx.call('wx__report')) as Record<string, unknown>
      assert.deepEqual(Object.keys(out), ['note', 'structuredContent'])
      assert.match(String(out.note), /does not follow the output schema/)
      ctx.server.structuredFaults.result = undefined
      assert.equal(await ctx.call('wx__boom').then(String, String), 'McpToolError: kaboom')
      assert.deepEqual(
        ctx.server.calls.map((c) => c.name),
        ['report', 'boom'],
      )
      assert.equal(ctx.asked.length, 0)
    })
  })

  test(`${era} / the answer is nowhere but on its way to the server`, async () => {
    await withMcp(
      era,
      { onElicitation: () => ({ action: 'accept', content: { name: SECRET, email: 'a@b.test' } }) },
      async (ctx) => {
        // The server keeps the answers out of its result, so anything found is ours.
        ctx.server.elicitationFaults.quietResult = true
        const out = await ctx.outcome('wx__elicit_form')
        assert.equal(out, JSON.stringify({ tool: 'elicit_form', action: 'accept' }))
        // It did arrive ...
        assert.ok(JSON.stringify(ctx.server.elicitations).includes(SECRET))
        // ... and is in no event and no log line.
        assert.equal(JSON.stringify(ctx.events).includes(SECRET), false)
        assert.equal(ctx.logs.join('\n').includes(SECRET), false)
        assert.equal(ctx.logs.join('\n').includes('a@b.test'), false)
        assert.deepEqual(answered(ctx.events), [['accept', false, null, ['name', 'email']]])
      },
    )
  })

  test(`${era} / two calls at once: each question reaches the host under its own tool`, async () => {
    await withMcp(era, { onElicitation: answerForms }, async (ctx) => {
      const [twice, state] = await Promise.all([
        ctx.outcome('wx__elicit_twice'),
        ctx.outcome('wx__elicit_state'),
      ])
      assert.match(twice, /"name":"Ada","color":"green"/)
      assert.match(state, /"action":"accept"/)
      assert.deepEqual(
        ctx.asked.map((r) => [r.tool, Object.keys(r.requestedSchema?.properties ?? {})[0]]).sort(),
        [
          ['wx__elicit_state', 'confirm'],
          ['wx__elicit_twice', 'color'],
          ['wx__elicit_twice', 'name'],
        ],
      )
      assert.deepEqual(ctx.server.calls.map((c) => c.name).sort(), ['elicit_state', 'elicit_twice'])
    })
  })
}

// ── the SDK's minute ────────────────────────────────────────────────────────

// Takes more than a minute of real time, so it runs only when asked for
// (MCP_ELICITATION_SLOW=1). The clock itself is tested with mock timers in the
// Node package's `mcp-elicitation-shared.test.ts`; this is the one thing those
// cannot show: that the SDK's own request timeout (60 s) is really out of the
// way while a 2025 server's question waits for a person.
test(
  'legacy / a question may wait longer than the SDK lets a request take',
  { skip: !process.env.MCP_ELICITATION_SLOW, timeout: 120_000 },
  async () => {
    await withMcp(
      'legacy',
      {
        onElicitation: async () => {
          await new Promise((resolve) => setTimeout(resolve, 63_000))
          return { action: 'accept', content: { confirm: true } }
        },
      },
      async (ctx) => {
        const out = await ctx.outcome('wx__elicit_state')
        assert.match(out, /"action":"accept"/)
        assert.deepEqual(ctx.server.calls, [{ name: 'elicit_state', args: {} }])
      },
    )
  },
)

// ── off = the wire it always was ────────────────────────────────────────────

const connectForWire =
  (options: Parameters<typeof connectMcpServers>[6]) =>
  async (url: string, fetchFn: (input: string | URL, init?: RequestInit) => Promise<Response>) => {
    const mcp = await connectMcpServers(
      { wx: { url, fetch: fetchFn } },
      () => {},
      'agent-test',
      undefined,
      undefined,
      undefined,
      options,
    )
    return { tools: mcp.tools, close: mcp.close }
  }

const golden = (): IWireRequest[] =>
  JSON.parse(
    readFileSync(new URL('./fixtures/mcp-wire-without-protocol.json', import.meta.url), 'utf8'),
  ) as IWireRequest[]

test('off: without onElicitation the wire is byte for byte what it was, whatever the settings say', async () => {
  // The fixture was recorded before the protocol option existed - and so before this one.
  assert.deepEqual(await captureMcpWire(connectForWire({})), golden())
  assert.deepEqual(
    await captureMcpWire(
      connectForWire({ elicitation: { url: true, subagents: true, timeoutMs: 1, maxPerRun: 1 } }),
    ),
    golden(),
    'settings without a callback changed the wire',
  )
})

test('on: the only difference on the 2025 wire is the declared capability', async () => {
  const withCallback = await captureMcpWire(
    connectForWire({ onElicitation: () => ({ action: 'decline' }) }),
  )
  const expected = golden().map((request) => {
    const body = request.body as { method?: string; params?: { capabilities?: object } } | null
    if (body?.method !== 'initialize') {
      return request
    }
    return {
      ...request,
      body: {
        ...body,
        params: {
          ...body.params,
          capabilities: { ...body.params?.capabilities, elicitation: { form: {} } },
        },
      },
    }
  })
  const sorted = (list: IWireRequest[]): string[] => list.map((r) => JSON.stringify(r)).sort()
  assert.deepEqual(sorted(withCallback), sorted(expected))
})

test('off, 2026-07-28: no request says anything about elicitation', async () => {
  const connect = (options: Parameters<typeof connectMcpServers>[6]) =>
    captureMcpWire(async (url, fetchFn) => {
      const mcp = await connectMcpServers(
        { wx: { url, fetch: fetchFn, protocol: 'modern' } },
        () => {},
        'agent-test',
        undefined,
        undefined,
        undefined,
        options,
      )
      return { tools: mcp.tools, close: mcp.close }
    }, 'modern')
  const off = await connect({})
  assert.equal(JSON.stringify(off).includes('elicitation'), false)
  assert.deepEqual(await connect({ elicitation: { url: true } }), off)
  // On: every request declares it, and nothing else moves.
  const on = await connect({ onElicitation: () => ({ action: 'decline' }) })
  assert.equal(on.length, off.length)
  assert.ok(on.every((r) => JSON.stringify(r).includes('"elicitation":{"form":{}}')))
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(on)
        .replaceAll(',"elicitation":{"form":{}}', '')
        .replaceAll('"elicitation":{"form":{}},', '')
        .replaceAll('"elicitation":{"form":{}}', ''),
    ),
    off,
  )
})

test('a setting that is not a usable number fails the connect, with or without a callback', async () => {
  await assert.rejects(
    connectMcpServers({}, () => {}, 't', undefined, undefined, undefined, {
      elicitation: { maxPerRun: 0 },
    }),
    /elicitation\.maxPerRun must be a number of at least 1/,
  )
})
