import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  startLocalMcpServer,
  TRAVEL_CHECKOUT_URL,
  TRAVEL_MESSAGE,
  type ILocalMcpServer,
} from '@dudko.dev/test-servers'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * MCP Apps in a real browser: the demo's real agent and chat, a REAL MCP server on loopback whose
 * tool declares an app (`@dudko.dev/test-servers`, `appTools`), and only Gemini's answers
 * scripted. The app is the test server's "travel" app: it renders the result, asks for a tool
 * call, a link, a message and a size, and tries what a hostile app would. Two counted endpoints
 * stand for the network: one origin the app's resource DECLARES (`connectDomains`), one it does
 * not. Every guard of the frame and the bridge is checked here as the browser enforces it; the
 * same guards are unit-tested in `tests/apps.test.ts`.
 */

interface ICounted {
  url: string
  hits: string[]
  close: () => Promise<void>
}

/** An HTTP server that counts what reaches it (and answers any origin, as an API would). */
const counted = async (): Promise<ICounted> => {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' })
    res.end('counted')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

let mcp: ILocalMcpServer
let declared: ICounted
let undeclared: ICounted

test.beforeEach(async () => {
  declared = await counted()
  undeclared = await counted()
  mcp = await startLocalMcpServer({
    cors: '*',
    appTools: {
      connectDomains: [declared.url],
      declaredUrl: `${declared.url}/declared`,
      undeclaredUrl: `${undeclared.url}/undeclared`,
    },
  })
})

test.afterEach(async () => {
  await mcp.close()
  await declared.close()
  await undeclared.close()
})

/** The run: one step that calls the tool with an app, then an answer. */
const script = (c: GeminiCall): GeminiReply => {
  if (c.stage === 'planner') return plan('Search flights Lisbon to Vienna')
  if (c.stage === 'executor') {
    return c.functionResponses.length === 0
      ? { call: { name: 'travel__flights_search', args: { from: 'LIS', to: 'VIE' } } }
      : { text: 'Three flights found.' }
  }
  if (c.stage === 'replanner') return { text: JSON.stringify({ decision: 'finish', reason: 'ok' }) }
  return { text: 'I found three options for 12 December. Pick one in the app.' }
}

const APP_TITLE = 'App from server travel'

/** The app's own document: the outer frame (ours, the shell) and the app inside it. */
const appOf = (page: Page): FrameLocator =>
  page.frameLocator(`iframe[title="${APP_TITLE}"]`).frameLocator('#app')

const status = (app: FrameLocator) => app.locator('#status')

/** Key, the MCP server connected as "travel", a question, the answer with its app. */
const openWithApp = async (page: Page) => {
  const calls = await mockGemini(page, script)
  await page.goto('/')
  await page.getByPlaceholder('AIza…').fill('AIza-test-key')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('tab', { name: 'MCP servers' }).click()
  await page.getByPlaceholder('https://your-server.example/mcp').fill(mcp.url)
  await page.getByLabel('Name (tool prefix)').fill('travel')
  await page.getByRole('button', { name: 'Add server' }).click()
  await expect(page.locator('.mcp__server-status')).toContainText('Connected')
  // The panel names the server's app; the app-only tool is not the agent's.
  await expect(page.locator('.mcp__app')).toHaveText([
    'ui://travel/results.html',
    'ui://travel/bad.html',
  ])
  await expect(page.locator('.mcp__tool code')).not.toContainText(['travel__flights_refresh'])
  await page
    .getByRole('textbox', { name: 'Message' })
    .fill('Find me a flight from Lisbon to Vienna')
  await page.getByRole('button', { name: 'Send' }).click()
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toContainText('I found three options', {
    timeout: 45_000,
  })
  const frame = answer.locator('.awr-frame--app')
  await expect(frame.locator('.awr-frame__title')).toHaveText('App from server “travel”')
  const app = appOf(page)
  // The app received the call's input and result and rendered them.
  await expect(app.locator('body')).toHaveAttribute('data-result', 'yes', { timeout: 15_000 })
  await expect(app.locator('.f')).toHaveCount(3)
  return { calls, answer, frame, app }
}

test('an app renders inside the host’s frame, under the answer, with the host’s chrome outside it', async ({
  page,
}) => {
  const { answer, frame, app } = await openWithApp(page)
  await expect(app.locator('body')).toHaveAttribute(
    'data-input',
    JSON.stringify({ from: 'LIS', to: 'VIE' }),
  )
  await expect(app.locator('body')).toHaveAttribute('data-host', '@dudko.dev/agent-web-react')
  // The tool row says it came with an app, and the summary counts it.
  await expect(answer.locator('.awr-tool__tag--app')).toHaveCount(1)
  await expect(answer.locator('.awr-activity__summary')).toContainText('1 app')
  // The frames: the outer one has scripts and nothing else; so has the app inside it.
  const outer = frame.locator('iframe')
  await expect(outer).toHaveAttribute('sandbox', 'allow-scripts')
  expect(await outer.getAttribute('allow')).toBeNull()
  const inner = page.frameLocator(`iframe[title="${APP_TITLE}"]`).locator('#app')
  await expect(inner).toHaveAttribute('sandbox', 'allow-scripts')
  // The label and the controls are in the page, outside the frame.
  await expect(frame.locator('.awr-frame__head')).toContainText('sandboxed')
  await expect(frame.getByRole('button', { name: 'App menu' })).toBeVisible()
  // Folded and shown again: one line, then the app from the start.
  await frame.getByRole('button', { name: 'App menu' }).click()
  await expect(frame.locator('.awr-frame__menunote')).toContainText(
    'Served by travel as ui://travel/results.html',
  )
  await frame.getByRole('menuitem', { name: 'Hide app' }).click()
  const line = answer.locator('.awr-frame--line')
  await expect(line).toContainText('hidden')
  await expect(answer.locator(`iframe[title="${APP_TITLE}"]`)).toHaveCount(0)
  await line.getByRole('button', { name: 'Show' }).click()
  await expect(app.locator('.f')).toHaveCount(3)
})

test('a tool call the app asks for waits for consent labelled as the app’s: Allow runs it, Deny is an error for the app', async ({
  page,
}) => {
  const { app } = await openWithApp(page)
  // The demo's agent runs on autopilot: the app still may not write without asking.
  await app.locator('.f').first().getByRole('button', { name: 'Select' }).click()
  await app.getByRole('button', { name: 'Book this flight' }).click()
  const card = page.locator('.awr-approval--app')
  await expect(card).toContainText('The app “travel” wants to run')
  await expect(card.locator('code')).toHaveText('flights.book')
  await expect(card).toContainText('Asked by the app, not by the agent')
  await expect(page.locator('.awr-frame--app .awr-frame__state')).toHaveText('waiting for you')
  expect(mcp.calls.filter((c) => c.name === 'flights.book')).toHaveLength(0)
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(status(app)).toHaveText('ok: booked:SL 418')
  expect(mcp.calls.filter((c) => c.name === 'flights.book')).toEqual([
    {
      name: 'flights.book',
      args: { flight: 'SL 418', date: '2026-12-12', fare: 'flex', passengers: 1 },
    },
  ])

  await app.getByRole('button', { name: 'Book this flight' }).click()
  await page.locator('.awr-approval--app').getByRole('button', { name: 'Deny' }).click()
  await expect(status(app)).toHaveText('refused: Tool call denied by the user')
  expect(mcp.calls.filter((c) => c.name === 'flights.book')).toHaveLength(1)

  // Its server's read-only tool for apps runs without a prompt - and is listed under the frame.
  await app.getByRole('button', { name: 'Refresh' }).click()
  await expect(status(app)).toContainText('ok: Three flights')
  await expect(page.locator('.awr-frame--app .awr-frame__foot')).toContainText(
    'The app ran flights.book · flights.book (refused) · flights.refresh',
  )
  // A tool only the model may call is refused before any consent, and never reaches the server.
  await app.getByRole('button', { name: 'Admin tool' }).click()
  await expect(status(app)).toHaveText('refused: This app may not call “flights.admin”')
  expect(mcp.calls.some((c) => c.name === 'flights.admin')).toBe(false)
})

test('a link opens only on the user’s click, with its host highlighted; Cancel is an error for the app', async ({
  page,
  context,
}) => {
  const popups: string[] = []
  context.on('page', (p) => popups.push(p.url()))
  await context.route('https://example-air.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>airline</title>' }),
  )
  const { app } = await openWithApp(page)
  await app.getByRole('button', { name: 'Airline site' }).click()
  const card = page.locator('.awr-approval--app')
  await expect(card).toContainText('The app “travel” wants to open a link. Open it?')
  await expect(card.locator('.awr-approval__url b')).toHaveText('example-air.test')
  await page.waitForTimeout(300)
  expect(popups).toEqual([])
  const opened = context.waitForEvent('page')
  await card.getByRole('button', { name: 'Open' }).click()
  const popup = await opened
  await popup.waitForLoadState()
  expect(popup.url()).toBe(TRAVEL_CHECKOUT_URL)
  // No way back to the page that opened it.
  expect(await popup.evaluate(() => window.opener)).toBeNull()
  await expect(status(app)).toHaveText('link: opened')
  await popup.close()

  await app.getByRole('button', { name: 'Airline site' }).click()
  await page.locator('.awr-approval--app').getByRole('button', { name: 'Cancel' }).click()
  await expect(status(app)).toHaveText('link refused: Link opening denied by user')
  expect(popups).toHaveLength(1)
})

test('a message the app sends becomes a draft the user sends - or not; nothing reaches the model', async ({
  page,
}) => {
  const { calls, app } = await openWithApp(page)
  const before = calls.length
  await app.getByRole('button', { name: 'Ask the agent' }).click()
  const card = page.locator('.awr-approval--app')
  await expect(card).toContainText('The app “travel” wants to put a message in your message box')
  await expect(card.locator('.awr-approval__quote')).toHaveText(TRAVEL_MESSAGE)
  await card.getByRole('button', { name: 'Put in the message box' }).click()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(TRAVEL_MESSAGE)
  await expect(status(app)).toHaveText('message: accepted')
  await page.waitForTimeout(300)
  expect(calls.length).toBe(before)
})

test('a height the app asks for is clamped to the host’s bound', async ({ page }) => {
  const { frame, app } = await openWithApp(page)
  await app.getByRole('button', { name: 'Taller' }).click()
  const outer = frame.locator(`iframe[title="${APP_TITLE}"]`)
  await expect.poll(async () => (await outer.boundingBox())?.height).toBe(800)
})

test('guard: what a hostile app tries fails - the page, storage, other origins, navigation, the top window', async ({
  page,
}) => {
  const { app } = await openWithApp(page)
  // Something of the page's own to steal.
  await page.evaluate(() => localStorage.setItem('host-secret', 'vault-key'))
  const url = page.url()
  await app.getByRole('button', { name: 'Run probes' }).click()
  await expect(app.locator('body')).toHaveAttribute('data-probes', 'done', { timeout: 15_000 })
  const verdict = async (name: string) =>
    (await app.locator(`[data-probe="${name}"]`).textContent())?.trim()
  for (const name of [
    'parent-dom',
    'top-location',
    'local-storage',
    'session-storage',
    'cookie',
    'indexeddb',
    'host-databases',
    'window-open',
    'top-navigation',
    'fetch-undeclared',
    'image-undeclared',
  ]) {
    expect(await verdict(name), name).toBe('blocked')
  }
  // The origin the resource declared is reachable: the policy comes from the metadata.
  expect(await verdict('fetch-declared')).toBe('allowed: 200')
  expect(declared.hits).toEqual(['/declared?fetch'])
  expect(undeclared.hits).toEqual([])
  expect(page.url()).toBe(url)
  // The page's storage is as it was: nothing read, nothing added.
  expect(await page.evaluate(() => localStorage.getItem('mcp-app-probe'))).toBeNull()
  const databases = await page.evaluate(async () =>
    (await indexedDB.databases()).map((d) => d.name),
  )
  expect(databases).not.toContain('mcp-app-probe')

  // Writing to the top window directly is not the frame the host listens to.
  await app.getByRole('button', { name: 'Talk to the page' }).click()
  await expect(status(app)).toHaveText('spoof: sent')
  await page.waitForTimeout(500)
  await expect(page.locator('.awr-approval--app')).toHaveCount(0)
  expect(mcp.calls.some((c) => JSON.stringify(c.args).includes('SPOOF'))).toBe(false)

  // Navigating itself away: refused by the shell's policy - nothing is requested.
  await app.getByRole('button', { name: 'Leave' }).click()
  await page.waitForTimeout(800)
  expect(undeclared.hits).toEqual([])
  expect(page.url()).toBe(url)
})

test('an app moves to the panel and back: the right column on a wide page, a sheet on a phone', async ({
  page,
}) => {
  const { answer, frame } = await openWithApp(page)
  await frame.getByRole('button', { name: 'Open in panel' }).click()
  const panel = page.locator('.app__apppanel .awr-frame--panel')
  await expect(panel.locator('.awr-frame__title')).toHaveText('App from server “travel”')
  await expect(panel.locator('.awr-frame__badges')).toContainText('ui://travel/results.html')
  await expect(answer.locator('.awr-frame--line')).toContainText('open in the panel')
  // The servers' panel gives the column to the app, which starts again there.
  await expect(page.locator('.mcp__servers')).toHaveCount(0)
  await expect(appOf(page).locator('.f')).toHaveCount(3)
  await answer.getByRole('button', { name: 'Bring back' }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.mcp__servers')).toHaveCount(1)
  await expect(appOf(page).locator('.f')).toHaveCount(3)

  await page.setViewportSize({ width: 390, height: 844 })
  await answer.locator('.awr-frame--app').getByRole('button', { name: 'Open in panel' }).click()
  const sheet = page.locator('.awr-chat__appsheet')
  await expect(sheet).toBeVisible()
  await expect(appOf(page).locator('.f')).toHaveCount(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  await sheet.getByRole('button', { name: 'Close the panel' }).click()
  await expect(sheet).toHaveCount(0)
})
