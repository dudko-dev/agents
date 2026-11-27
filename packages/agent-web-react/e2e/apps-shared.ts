import { expect, type FrameLocator, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ILocalMcpServer } from '@dudko.dev/test-servers'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * What `apps.spec.ts` and `apps-sandbox.spec.ts` share: the counted endpoints, the scripted run,
 * and the demo opened with the travel app - in either of the two places an app runs:
 *
 * - `'origin'` (the demo's default): on an origin of its own, behind the sandbox page. In the
 *   browser tests the page is on 127.0.0.1 and the sandbox page is served by the same preview
 *   server as `localhost` (apps/demo/vite.config.ts), so the frames are
 *   `iframe[title] (the shell) → #proxy (the sandbox page) → #app`.
 * - `'opaque'`: the sandbox page unreachable (its requests aborted), so the frame falls back to
 *   the opaque one of the library's default: `iframe[title] (the shell) → #app`.
 */

export interface ICounted {
  url: string
  hits: string[]
  /** The `Origin` header of each request (`-` when there was none). */
  origins: string[]
  close: () => Promise<void>
}

/** An HTTP server that counts what reaches it (and answers any origin, as an API would). */
export const counted = async (body = 'counted', type = 'text/plain'): Promise<ICounted> => {
  const hits: string[] = []
  const origins: string[] = []
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '')
    origins.push(String(req.headers.origin ?? '-'))
    res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    origins,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** The run: one step that calls the tool with an app, then an answer. */
export const script = (c: GeminiCall): GeminiReply => {
  if (c.stage === 'planner') return plan('Search flights Lisbon to Vienna')
  if (c.stage === 'executor') {
    return c.functionResponses.length === 0
      ? { call: { name: 'travel__flights_search', args: { from: 'LIS', to: 'VIE' } } }
      : { text: 'Three flights found.' }
  }
  if (c.stage === 'replanner') return { text: JSON.stringify({ decision: 'finish', reason: 'ok' }) }
  return { text: 'I found three options for 12 December. Pick one in the app.' }
}

export const APP_TITLE = 'App from server travel'

export type AppMode = 'origin' | 'opaque'

/** Every request for the sandbox page (`/sandbox/v1/<policy>`, on either loopback name). */
export const SANDBOX_PAGES = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/sandbox\/v1\//

/** The sandbox page unreachable: an app's frame falls back to the opaque sandbox. */
export const blockSandbox = (page: Page) => page.route(SANDBOX_PAGES, (route) => route.abort())

/** The outer frame (ours: the shell) of the app. */
export const outerOf = (page: Page) => page.locator(`iframe[title="${APP_TITLE}"]`)

/** The app's own document, inside the frames of its mode. */
export const appOf = (page: Page, mode: AppMode = 'origin'): FrameLocator => {
  const shell = page.frameLocator(`iframe[title="${APP_TITLE}"]`)
  return mode === 'origin'
    ? shell.frameLocator('#proxy').frameLocator('#app')
    : shell.frameLocator('#app')
}

export const status = (app: FrameLocator) => app.locator('#status')

/** The origin the demo's sandbox page has in these tests: the page's port under `localhost`. */
export const sandboxOrigin = (page: Page): string => `http://localhost:${new URL(page.url()).port}`

/** Key, the MCP server connected as "travel", a question, the answer with its app. */
export const openWithApp = async (
  page: Page,
  mcp: ILocalMcpServer,
  {
    mode = 'origin',
    reply = script,
  }: { mode?: AppMode; reply?: (c: GeminiCall) => GeminiReply } = {},
) => {
  if (mode === 'opaque') await blockSandbox(page)
  const calls = await mockGemini(page, reply)
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
  // Where it runs: on its own origin once the sandbox page answered, or the opaque fallback.
  await expect(frame).toHaveAttribute('data-sandbox', mode, { timeout: 15_000 })
  const app = appOf(page, mode)
  // The app received the call's input and result and rendered them.
  await expect(app.locator('body')).toHaveAttribute('data-result', 'yes', { timeout: 15_000 })
  await expect(app.locator('.f')).toHaveCount(3)
  // The app reports its height once it has drawn the result, and the frame (and the transcript
  // around it) moves: a click in that moment can land on whatever moved under it.
  await settled(page)
  return { calls, answer, frame, app }
}

/**
 * Wait for the app's frame to keep still. Whenever the app's content grows it reports its height,
 * the frame grows and the transcript scrolls: a click in that moment lands where the button was.
 */
export const settled = async (page: Page) => {
  const outer = outerOf(page)
  let last = ''
  await expect
    .poll(
      async () => {
        const box = await outer.boundingBox()
        const now = box ? `${Math.round(box.y)}:${Math.round(box.height)}` : ''
        const still = now !== '' && now === last
        last = now
        return still
      },
      { intervals: [150], timeout: 10_000 },
    )
    .toBe(true)
}

/** Run the app's probes and read their verdicts. */
export const runProbes = async (app: FrameLocator) => {
  await app.getByRole('button', { name: 'Run probes' }).click()
  await expect(app.locator('body')).toHaveAttribute('data-probes', 'done', { timeout: 15_000 })
  return async (name: string) => (await app.locator(`[data-probe="${name}"]`).textContent())?.trim()
}
