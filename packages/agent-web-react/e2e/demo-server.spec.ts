import { expect, test, type Page } from '@playwright/test'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * The site's own demo MCP server, from the demo's "Try the demo server" button: the Worker's
 * code (apps/worker) answers /mcp/demo on the demo's own origin - in production a Cloudflare
 * Worker, here the same handler mounted on `vite preview` (apps/demo/vite.config.ts). The demo's
 * real agent and MCP client talk to it; only Gemini's HTTP answers are scripted.
 *
 * The server keeps nothing, so what it received is read from what it answered: the tool result
 * the model is sent next is computed by the server from the user's answer.
 */

// The model's tools: the server's two app-only tools (`reshuffle_day`, `book_trip`) are not
// among them (see demo-server-app.spec.ts).
const TOOLS = [
  'demo__echo',
  'demo__current_time',
  'demo__roll_dice',
  'demo__plan_trip',
  'demo__open_docs',
  'demo__trip_board',
]

const decision = (): GeminiReply => ({
  text: JSON.stringify({ decision: 'continue', reason: 'ok' }),
})

/** One step that calls one tool of the demo server, then an answer. */
const callTool =
  (tool: string, args: Record<string, unknown> = {}) =>
  (c: GeminiCall): GeminiReply => {
    if (c.stage === 'planner') return plan('Use the demo server')
    if (c.stage === 'executor') {
      return c.functionResponses.length === 0
        ? { call: { name: `demo__${tool}`, args } }
        : { text: 'The server answered.' }
    }
    if (c.stage === 'replanner') return decision()
    return { text: 'All done.' }
  }

/** What the demo server answered the model's call, as the model was sent it. */
const resultOf = (calls: GeminiCall[], tool: string): string =>
  JSON.stringify(
    calls.flatMap((c) => c.functionResponses).find((r) => r.name === `demo__${tool}`)?.response ??
      null,
  )

const openWithKey = async (page: Page) => {
  await page.goto('/')
  await page.getByPlaceholder('AIza…').fill('AIza-test-key')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  await page.getByRole('tab', { name: 'MCP servers' }).click()
}

const tryDemo = async (page: Page) => {
  await page.getByRole('button', { name: 'Try the demo server' }).click()
  await expect(page.locator('.mcp__server-status')).toContainText('Connected — 6 tool(s)')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
}

const send = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

const prompt = (page: Page) => page.locator('.awr-elicit')
const answerBubble = (page: Page) => page.locator('.awr-msg--assistant .awr-msg__bubble').last()

test('"Try the demo server" connects the site\'s own server on this origin, with the 2026-07-28 revision', async ({
  page,
}) => {
  await openWithKey(page)
  await tryDemo(page)

  const origin = new URL(page.url()).origin
  await expect(page.locator('.mcp__server-name')).toHaveText(['demo'])
  await expect(page.locator('.mcp__server-url')).toHaveText(`${origin}/mcp/demo`)
  await expect(page.locator('.mcp__protocol')).toContainText('MCP 2026-07-28')
  await expect(page.locator('.mcp__protocol')).toContainText('asked for: auto')
  await page.getByText('Tools', { exact: true }).click()
  await expect(page.locator('.mcp__tool code')).toHaveText(TOOLS)
  await expect(page.locator('.mcp__ro')).toHaveCount(6)
  // The server's instructions are shown as its own words.
  await page.getByText('Instructions sent by this server').click()
  await expect(page.locator('.mcp__instructions-text')).toContainText('A demo MCP server')
  // Added once: the offer is gone, and stays gone after a reload (the list is remembered).
  await expect(page.getByRole('button', { name: 'Try the demo server' })).toHaveCount(0)
  await page.reload()
  await page.getByRole('tab', { name: 'MCP servers' }).click()
  await expect(page.locator('.mcp__server-status')).toContainText('Connected — 6 tool(s)')
  await expect(page.getByRole('button', { name: 'Try the demo server' })).toHaveCount(0)
})

test('a plain tool: the model calls roll_dice and is sent its structured result', async ({
  page,
}) => {
  const calls = await mockGemini(page, callTool('roll_dice', { count: 3, sides: 6 }))
  await openWithKey(page)
  await tryDemo(page)
  await send(page, 'Roll three dice')

  await expect(answerBubble(page)).toHaveText('All done.', { timeout: 45_000 })
  expect(calls.find((c) => c.stage === 'executor')?.tools).toEqual(expect.arrayContaining(TOOLS))
  // The core hands the model the server's structured content as it is.
  const { content } = JSON.parse(resultOf(calls, 'roll_dice')) as {
    content: { sides: number; rolls: number[]; total: number }
  }
  expect(content.sides).toBe(6)
  expect(content.rolls).toHaveLength(3)
  expect(content.rolls.every((roll) => roll >= 1 && roll <= 6)).toBe(true)
  expect(content.total).toBe(content.rolls.reduce((a, b) => a + b, 0))
})

test("plan_trip: the server's form is shown, and the submitted answer reaches the server", async ({
  page,
}) => {
  const calls = await mockGemini(page, callTool('plan_trip', { destination: 'Lisbon' }))
  // The client's retry of the call carries the answer: the request the server receives.
  const sent: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/mcp/demo') sent.push(request.postData() ?? '')
  })
  await openWithKey(page)
  await tryDemo(page)
  await send(page, 'Plan a trip to Lisbon')

  const card = prompt(page)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('.awr-elicit__head')).toContainText('The MCP server “demo” asks')
  await expect(card.locator('.awr-elicit__head code')).toHaveText('demo__plan_trip')
  await expect(card.locator('.awr-elicit__message')).toHaveText(
    'Where and when would you like to go?',
  )
  // The form as the server wrote it, with its defaults - the destination the model named among
  // them.
  await expect(card.getByLabel('Destination')).toHaveValue('Lisbon')
  await expect(card.getByLabel('Nights')).toHaveValue('3')
  await expect(card.getByLabel('Travellers')).toHaveValue('2')
  await expect(card.getByLabel('Flexible dates')).not.toBeChecked()

  await card.getByLabel('First day').fill('2026-12-01')
  await card.getByLabel('Nights').fill('4')
  await card.getByLabel('Budget').selectOption('luxury')
  await card.getByLabel('Flexible dates').check()
  await card.getByRole('button', { name: 'Submit' }).click()

  await expect(answerBubble(page)).toHaveText('All done.', { timeout: 45_000 })
  await expect(card).toHaveCount(0)
  // The answer went to the server, in the retried call...
  const retry = sent.find((body) => body.includes('"inputResponses"'))
  expect(retry, 'the call was not sent again with the answer').toBeTruthy()
  expect(JSON.parse(retry ?? '{}').params.inputResponses).toEqual({
    trip: {
      action: 'accept',
      content: {
        destination: 'Lisbon',
        start: '2026-12-01',
        nights: 4,
        travellers: 2,
        budget: 'luxury',
        flexible: true,
      },
    },
  })
  // ...and the server built its result from it.
  expect(resultOf(calls, 'plan_trip')).toContain(
    'Trip to Lisbon: 4 nights from 2026-12-01 to 2026-12-05, 2 travellers, luxury budget, flexible dates.',
  )
})

test('open_docs: a link question on this origin; Decline opens nothing and the server hears no', async ({
  page,
  context,
}) => {
  const calls = await mockGemini(page, callTool('open_docs'))
  const popups: Page[] = []
  context.on('page', (p) => popups.push(p))
  await openWithKey(page)
  await tryDemo(page)
  await send(page, 'Show me the docs')

  const card = prompt(page)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toHaveClass(/awr-elicit--url/)
  const origin = new URL(page.url()).origin
  await expect(card.locator('.awr-elicit__host')).toHaveText(new URL(origin).host)
  await expect(card.locator('.awr-elicit__url')).toHaveText(
    `${origin}/docs/browser/capabilities/#mcp-elicitation-a-server-asks-the-user`,
  )
  await card.getByRole('button', { name: 'Decline' }).click()

  await expect(answerBubble(page)).toHaveText('All done.', { timeout: 45_000 })
  expect(popups).toHaveLength(0)
  expect(resultOf(calls, 'open_docs')).toContain('The user did not open the page (decline).')
})
