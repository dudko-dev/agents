import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * The demo server's MCP App, from the demo's "Try the demo server" button: the site's own server
 * (apps/worker, mounted on `vite preview`) declares a trip board for its `trip_board` tool. The
 * demo's real agent, MCP client and app host run it; only Gemini's answers are scripted. The
 * app is the server's real document: it renders the result, asks for its server's two app-only
 * tools (`reshuffle_day`, read-only, runs at once; `book_trip`, a write as far as the host knows,
 * waits for consent), a link, a message, and grows when a day is opened.
 *
 * The server keeps nothing, so what reached it is read off the page's own requests to
 * `/mcp/demo`.
 */

const TRIP = {
  destination: 'Lisbon',
  start: '2026-12-01',
  nights: 3,
  travellers: 2,
  budget: 'comfortable',
}

const APP_URI = 'ui://demo/trip-board.html'
const APP_TITLE = 'App from server demo'
const DOCS_PATH = '/docs/browser/capabilities/#mcp-apps-a-servers-interface-for-a-tool'

/** One step that calls trip_board, then an answer. */
const script = (c: GeminiCall): GeminiReply => {
  if (c.stage === 'planner') return plan('Show the trip on a board')
  if (c.stage === 'executor') {
    return c.functionResponses.length === 0
      ? { call: { name: 'demo__trip_board', args: TRIP } }
      : { text: 'The board is ready.' }
  }
  if (c.stage === 'replanner') return { text: JSON.stringify({ decision: 'finish', reason: 'ok' }) }
  return { text: 'Here is your Lisbon trip, day by day: work with it on the board.' }
}

interface ISent {
  method: string
  /** A tool's name, or a resource's URI. */
  name?: string
  args?: Record<string, unknown>
}

/** What the page sent the demo server: one JSON-RPC message per POST. */
const recordSent = (page: Page): ISent[] => {
  const sent: ISent[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/mcp/demo' || request.method() !== 'POST') return
    try {
      const message = JSON.parse(request.postData() ?? '')
      sent.push({
        method: message.method,
        name: message.params?.name ?? message.params?.uri,
        args: message.params?.arguments,
      })
    } catch {
      // not JSON: nothing to record
    }
  })
  return sent
}

const callsOf = (sent: ISent[], tool: string) =>
  sent.filter((s) => s.method === 'tools/call' && s.name === tool)

/**
 * The app's own document. The demo runs apps on an origin of their own: the outer frame (the
 * host's shell), the sandbox page in it (`#proxy`, the other loopback name in these tests), the
 * app inside that.
 */
const appOf = (page: Page): FrameLocator =>
  page.frameLocator(`iframe[title="${APP_TITLE}"]`).frameLocator('#proxy').frameLocator('#app')

/** Wait until the frame keeps still: it moves while the app reports its height. */
const settled = async (frame: Locator) => {
  let last = ''
  await expect
    .poll(
      async () => {
        const box = await frame.boundingBox()
        const now = box ? `${Math.round(box.y)}:${Math.round(box.height)}` : ''
        const still = now !== '' && now === last
        last = now
        return still
      },
      { intervals: [150], timeout: 10_000 },
    )
    .toBe(true)
}

/** Key, "Try the demo server", a question, the answer with its app. */
const openWithApp = async (page: Page) => {
  const calls = await mockGemini(page, script)
  const sent = recordSent(page)
  await page.goto('/')
  await page.getByPlaceholder('AIza…').fill('AIza-test-key')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('tab', { name: 'MCP servers' }).click()
  await page.getByRole('button', { name: 'Try the demo server' }).click()
  await expect(page.locator('.mcp__server-status')).toContainText('Connected — 6 tool(s)')
  // The panel names the server's app; its two app-only tools are not the agent's.
  await expect(page.locator('.mcp__app')).toHaveText([APP_URI])
  await page.getByText('Tools', { exact: true }).click()
  await expect(page.locator('.mcp__tool code')).toContainText(['demo__trip_board'])
  for (const name of ['demo__reshuffle_day', 'demo__book_trip']) {
    await expect(page.locator('.mcp__tool code', { hasText: name })).toHaveCount(0)
  }
  await page.getByRole('textbox', { name: 'Message' }).fill('Plan me three nights in Lisbon')
  await page.getByRole('button', { name: 'Send' }).click()
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toContainText('Here is your Lisbon trip', {
    timeout: 45_000,
  })
  const frame = answer.locator('.awr-frame--app')
  await expect(frame.locator('.awr-frame__title')).toHaveText('App from server “demo”')
  const app = appOf(page)
  await expect(app.locator('h1')).toHaveText('Lisbon', { timeout: 15_000 })
  await expect(app.locator('.day')).toHaveCount(4)
  const outer = page.locator(`iframe[title="${APP_TITLE}"]`)
  await settled(outer)
  return { calls, sent, answer, frame, outer, app }
}

const status = (app: FrameLocator) => app.locator('#status')

test('the model calls trip_board and never sees the app’s own tools; the board renders in the frame and grows as a day opens', async ({
  page,
}) => {
  const { calls, sent, frame, outer, app } = await openWithApp(page)
  // What the model was offered: the board, not the two tools for the app.
  const offered = calls.find((c) => c.stage === 'executor')?.tools ?? []
  expect(offered).toContain('demo__trip_board')
  expect(offered).not.toContain('demo__reshuffle_day')
  expect(offered).not.toContain('demo__book_trip')
  // The host read the app from the server whose tool declared it, once.
  expect(sent.filter((s) => s.method === 'resources/read')).toEqual([
    { method: 'resources/read', name: APP_URI, args: undefined },
  ])
  // The app got the call's result and drew it: the trip, four days, the first one open.
  await expect(app.locator('#facts li')).toHaveText([
    '3 nights',
    '1–4 Dec 2026',
    '2 travellers',
    'Comfortable',
    '≈ €1,130',
  ])
  await expect(app.getByRole('button', { name: /^Day 1, Tue 1 Dec/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(app.getByRole('button', { name: /^Day 2, Wed 2 Dec/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  // The host told it the demo's theme.
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark')
  // Sandboxed on an origin of its own, in the host's chrome.
  await expect(outer).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
  await expect(frame.locator('.awr-frame__badges')).toHaveText('sandboxed on its own origin')
  // Opening every day makes the content taller: the app says so, and the host's frame follows.
  const before = (await outer.boundingBox())?.height ?? 0
  await app.getByRole('button', { name: 'Open all days' }).click()
  await expect(app.getByRole('button', { name: 'Close all days' })).toBeVisible()
  await expect.poll(async () => (await outer.boundingBox())?.height ?? 0).toBeGreaterThan(before)
})

test('Other ideas: a read-only tool for the app only runs without a prompt, and is listed under the frame', async ({
  page,
}) => {
  const { sent, frame, app } = await openWithApp(page)
  const day2 = app.locator('.day[data-day="2"]')
  const theme = (await day2.locator('.theme').textContent()) ?? ''
  await app.getByRole('button', { name: /^Day 2, / }).click()
  await app.getByRole('button', { name: 'Other ideas for day 2' }).click()
  await expect(status(app)).toContainText('New ideas for day 2')
  await expect(day2.locator('.theme')).not.toHaveText(theme)
  await expect(page.locator('.awr-approval--app')).toHaveCount(0)
  expect(callsOf(sent, 'reshuffle_day')).toEqual([
    {
      method: 'tools/call',
      name: 'reshuffle_day',
      args: { destination: 'Lisbon', day: 2, days: 4, variant: 1, start: '2026-12-01' },
    },
  ])
  await expect(frame.locator('.awr-frame__foot')).toContainText('The app ran reshuffle_day')
})

test('Book: the host asks first; Deny books nothing, Allow once makes the one call and shows its code', async ({
  page,
}) => {
  const { sent, frame, app } = await openWithApp(page)
  const book = app.getByRole('button', { name: 'Book this trip' })

  // Denied: the call never leaves the page.
  await book.click()
  const card = page.locator('.awr-approval--app')
  await expect(card).toContainText('The app “demo” wants to run')
  await expect(card.locator('code')).toHaveText('book_trip')
  await expect(card).toContainText('Asked by the app, not by the agent')
  await expect(frame.locator('.awr-frame__state')).toHaveText('waiting for you')
  await expect(app.getByRole('button', { name: 'Waiting for your OK…' })).toBeVisible()
  await page.waitForTimeout(300)
  expect(callsOf(sent, 'book_trip')).toHaveLength(0)
  await card.getByRole('button', { name: 'Deny' }).click()
  await expect(status(app)).toHaveText('Not booked: you said no.')
  await expect(app.locator('#ticket')).toBeHidden()
  expect(callsOf(sent, 'book_trip')).toHaveLength(0)

  // Allowed: one call, with the trip, and the server's code on the ticket.
  await book.click()
  await expect(card).toContainText('The app “demo” wants to run')
  expect(callsOf(sent, 'book_trip')).toHaveLength(0)
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(app.locator('#ticket')).toBeVisible()
  const code = (await app.locator('#code').textContent()) ?? ''
  expect(code).toMatch(/^DEMO-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  await expect(app.locator('#ticket-note')).toContainText('Nothing was booked or charged')
  await expect(app.getByRole('button', { name: 'Booked ✓' })).toBeDisabled()
  await expect(card).toHaveCount(0)
  const booked = callsOf(sent, 'book_trip')
  expect(booked).toEqual([
    { method: 'tools/call', name: 'book_trip', args: { ...TRIP, variants: [0, 0, 0, 0] } },
  ])
  // The code is the server's, and only its inputs make it: the same call made again (outside
  // the page, with no consent involved) gets the same one.
  const again = await page.request.post('/mcp/demo', {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'book_trip',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'book_trip',
        arguments: booked[0]?.args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
  })
  expect(await again.text()).toContain(`"confirmation":"${code}"`)
  await expect(frame.locator('.awr-frame__foot')).toContainText(
    'The app ran book_trip (refused) · book_trip',
  )
})

test('How MCP Apps work: the host’s link prompt names this origin; the docs open only on Open, with no opener', async ({
  page,
  context,
}) => {
  const popups: string[] = []
  context.on('page', (p) => popups.push(p.url()))
  const { app } = await openWithApp(page)
  const origin = new URL(page.url()).origin
  await context.route(`${origin}/docs/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>docs</title>' }),
  )
  await app.getByRole('button', { name: 'How MCP Apps work' }).click()
  const card = page.locator('.awr-approval--app')
  await expect(card).toContainText('The app “demo” wants to open a link. Open it?')
  await expect(card.locator('.awr-approval__url b')).toHaveText(new URL(origin).host)
  await expect(status(app)).toHaveText('Waiting for your OK…')
  await page.waitForTimeout(300)
  expect(popups).toEqual([])
  const opened = context.waitForEvent('page')
  await card.getByRole('button', { name: 'Open' }).click()
  const popup = await opened
  await popup.waitForLoadState()
  expect(popup.url()).toBe(`${origin}${DOCS_PATH}`)
  expect(await popup.evaluate(() => window.opener)).toBeNull()
  await expect(status(app)).toHaveText('The docs are open in a new tab.')
})

test('Send to chat: the message becomes a draft in the message box once the user agrees; nothing is sent', async ({
  page,
}) => {
  const { calls, app } = await openWithApp(page)
  const before = calls.length
  await app.getByRole('button', { name: 'Send to chat' }).click()
  const card = page.locator('.awr-approval--app')
  await expect(card).toContainText('The app “demo” wants to put a message in your message box')
  const text =
    'My trip board for Lisbon: 3 nights from Tue 1 Dec, 2 travellers. ' +
    'Day 1 (Tue 1 Dec) arrive and settle in; '
  await expect(card.locator('.awr-approval__quote')).toContainText(text)
  await card.getByRole('button', { name: 'Put in the message box' }).click()
  const box = page.getByRole('textbox', { name: 'Message' })
  await expect(box).toHaveValue(new RegExp(`^${text.replace(/[()]/g, '\\$&')}`))
  await expect(box).toHaveValue(/What would you change\?$/)
  await expect(status(app)).toHaveText(
    'It is in your message box: edit it, and send it when you like.',
  )
  await page.waitForTimeout(300)
  expect(calls.length).toBe(before)
})

test('on a phone: the board inline and in the sheet, with no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { answer, frame, app } = await openWithApp(page)
  const sideways = async () => ({
    page: await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
    app: await app.locator('html').evaluate((html) => html.scrollWidth - html.clientWidth),
  })
  expect(await sideways()).toEqual({ page: 0, app: 0 })
  await frame.getByRole('button', { name: 'Open in panel' }).click()
  const sheet = page.locator('.awr-chat__appsheet')
  await expect(sheet).toBeVisible()
  await expect(appOf(page).locator('.day')).toHaveCount(4)
  expect(await sideways()).toEqual({ page: 0, app: 0 })
  await sheet.getByRole('button', { name: 'Close the panel' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(answer.locator('.awr-frame--app')).toBeVisible()
})
