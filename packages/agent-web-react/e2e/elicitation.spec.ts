import { expect, test, type Page } from '@playwright/test'
import { startLocalMcpServer, type ILocalMcpServer } from '@dudko.dev/test-servers'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * MCP elicitation in a real page: a server asks the USER something in the middle of a tool
 * call, and `<ElicitationPrompt>` in the demo's chat is how the answer is given. The demo's real
 * agent, the core's real MCP client and a real MCP server over real sockets
 * (`@dudko.dev/test-servers`: it has the `elicit_*` tools, speaks both protocol revisions and
 * records what the client answered); only Gemini's HTTP answers are scripted.
 *
 * What only a browser can check: the answer reaches the server through the form a person fills
 * in, a link is opened by a click and by nothing else, and what was typed is nowhere on the
 * page once it was sent.
 */

let server: ILocalMcpServer

test.beforeEach(async () => {
  server = await startLocalMcpServer({
    cors: '*',
    elicitationTools: true,
    protocol: 'dual',
    urlElicitationWaitMs: 500,
  })
})

test.afterEach(async () => {
  await server.close()
})

const decision = (): GeminiReply => ({
  text: JSON.stringify({ decision: 'continue', reason: 'ok' }),
})

/** One step that calls one of the server's tools, then an answer. */
const callTool =
  (tool: string) =>
  (c: GeminiCall): GeminiReply => {
    if (c.stage === 'planner') return plan('Ask the server')
    if (c.stage === 'executor') {
      return c.functionResponses.length === 0
        ? { call: { name: `mcp__${tool}`, args: {} } }
        : { text: 'The server answered.' }
    }
    if (c.stage === 'replanner') return decision()
    return { text: 'All done.' }
  }

/** A key, the MCP tab, and the test server connected as "mcp". */
const openWithServer = async (page: Page, protocol?: 'legacy' | 'auto' | 'modern') => {
  await page.goto('/')
  await page.getByPlaceholder('AIza…').fill('AIza-test-key')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  await page.getByRole('tab', { name: 'MCP servers' }).click()
  await page.getByPlaceholder('https://your-server.example/mcp').fill(server.url)
  await page.getByLabel('Name (tool prefix)').fill('mcp')
  if (protocol) await page.getByLabel('Protocol revision').selectOption(protocol)
  await page.getByRole('button', { name: 'Add server' }).click()
  await expect(page.locator('.mcp__server-status')).toContainText('Connected')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
}

const send = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

const prompt = (page: Page) => page.locator('.awr-elicit')
const answerBubble = (page: Page) => page.locator('.awr-msg--assistant .awr-msg__bubble').last()

/** What the client answered the question `key` with, as the server recorded it. */
const answered = (key: string): unknown[] =>
  server.elicitations.flatMap((round) => (round.responses?.[key] ? [round.responses[key]] : []))

test('form: a filled-in form reaches the server and the tool call completes; what was typed is nowhere on the page afterwards', async ({
  page,
}) => {
  // The server keeps the answers out of the tool result: nothing but this client could put
  // them on the page.
  server.elicitationFaults.quietResult = true
  const calls = await mockGemini(page, callTool('elicit_form'))
  // Everything the page logs, the core's connector lines included.
  const logged: string[] = []
  page.on('console', (message) => logged.push(message.text()))
  await openWithServer(page)

  // "Auto" is the demo's default, and this server offers the 2026-07-28 revision.
  await expect(page.locator('.mcp__protocol')).toContainText('MCP 2026-07-28')
  await expect(page.locator('.mcp__protocol')).toContainText('asked for: auto')

  await send(page, 'Fill in my profile')
  const card = prompt(page)
  await expect(card).toBeVisible({ timeout: 30_000 })
  // The host's own header: which server asks, during which tool.
  await expect(card.locator('.awr-elicit__head')).toContainText('The MCP server “mcp” asks')
  await expect(card.locator('.awr-elicit__head code')).toHaveText('mcp__elicit_form')
  // The server's words, marked as the server's.
  await expect(card.locator('.awr-elicit__from')).toHaveText('From the server “mcp”')
  await expect(card.locator('.awr-elicit__message')).toHaveText('Fill in the profile')
  await expect(card.locator('.awr-elicit__expiry')).toContainText(
    /Cancelled automatically in \d:\d\d/,
  )

  // Every kind of field the core lets through, with the schema's defaults.
  await expect(card.getByLabel('Score')).toHaveValue('5')
  await expect(card.getByLabel('Color')).toHaveValue('red')
  await expect(card.getByLabel('Subscribe')).not.toBeChecked()
  await expect(card.getByLabel('English')).toBeChecked()

  const SECRET = 'Zq-TYPED-VALUE-7731'
  await card.getByLabel('Name').fill(SECRET)
  await card.getByLabel('Email').fill('zq7731@example.test')
  await card.getByLabel('Birthday').fill('2001-02-03')
  await card.getByLabel('Seats').fill('3')
  await card.getByLabel('Subscribe').check()
  await card.getByLabel('Size').selectOption('l')
  await card.getByLabel('olives').check()
  await card.getByRole('button', { name: 'Submit' }).click()

  await expect(answerBubble(page)).toHaveText('All done.', { timeout: 45_000 })
  await expect(card).toHaveCount(0)

  // The server got exactly the form's answer.
  expect(answered('profile')).toEqual([
    {
      action: 'accept',
      content: {
        name: SECRET,
        email: 'zq7731@example.test',
        birthday: '2001-02-03',
        score: 5,
        seats: 3,
        subscribe: true,
        color: 'red',
        size: 'l',
        toppings: ['olives'],
        languages: ['en'],
      },
    },
  ])
  expect(server.elicitations.at(-1)?.era).toBe('modern')
  expect(server.calls.map((c) => c.name)).toEqual(['elicit_form'])

  // The typed values: not in the document (text, markup, attributes, form controls), not in the
  // transcript with its activity opened, not in what the model was sent, not in web storage, not
  // in IndexedDB (the saved chats live there), not in the console.
  await page.locator('.awr-activity__summary').last().click()
  // The saved chat is written once the run has settled.
  await page.waitForTimeout(500)
  const surface = await page.evaluate(async () => {
    const fields = [...document.querySelectorAll('input, textarea, select')].map(
      (el) => (el as HTMLInputElement).value,
    )
    // Every record of every IndexedDB database of the origin, as text.
    const dumps: string[] = []
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(info.name as string)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      for (const store of [...db.objectStoreNames]) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(store, 'readonly').objectStore(store).getAll()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        dumps.push(
          JSON.stringify(rows, (_key, value: unknown) =>
            value instanceof ArrayBuffer || ArrayBuffer.isView(value)
              ? new TextDecoder().decode(value as ArrayBuffer)
              : value,
          ),
        )
      }
      db.close()
    }
    return {
      page: [
        document.documentElement.outerHTML,
        document.body.innerText,
        fields.join('\n'),
        JSON.stringify({ ...localStorage }),
        JSON.stringify({ ...sessionStorage }),
      ].join('\n'),
      stored: dumps.join('\n'),
    }
  })
  // The dump is not empty: the chat this run was saved in is there.
  expect(surface.stored).toContain('Fill in my profile')
  for (const typed of [SECRET, 'zq7731@example.test', '2001-02-03']) {
    expect(surface.page.includes(typed), `"${typed}" is still on the page`).toBe(false)
    expect(surface.stored.includes(typed), `"${typed}" was stored in IndexedDB`).toBe(false)
    expect(
      logged.some((line) => line.includes(typed)),
      `"${typed}" was logged`,
    ).toBe(false)
    expect(
      calls.some((c) => `${c.user}\n${JSON.stringify(c.functionResponses)}`.includes(typed)),
      `"${typed}" was sent to the model`,
    ).toBe(false)
  }
})

test('form: a value that breaks a rule blocks Submit with a message that names the field; nothing is sent until it is fixed', async ({
  page,
}) => {
  await mockGemini(page, callTool('elicit_form'))
  await openWithServer(page)
  await send(page, 'Fill in my profile')
  const card = prompt(page)
  await expect(card).toBeVisible({ timeout: 30_000 })

  await card.getByLabel('Email').fill('not-an-email')
  await card.getByLabel('Seats').fill('12')
  await card.getByRole('button', { name: 'Submit' }).click()

  await expect(card.locator('[data-field="name"] .awr-elicit__error')).toHaveText(
    'Name is required.',
  )
  await expect(card.locator('[data-field="email"] .awr-elicit__error')).toHaveText(
    'Email must be an email address.',
  )
  await expect(card.locator('[data-field="seats"] .awr-elicit__error')).toHaveText(
    'Seats must be 8 or less.',
  )
  await expect(card.locator('.awr-elicit__fix')).toHaveText('3 fields need a correction.')
  await expect(card.getByLabel('Name')).toBeFocused()
  await expect(card.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true')
  // Nothing went to the server: the question is still open there.
  expect(answered('profile')).toEqual([])
  await expect(card).toBeVisible()

  // The messages follow what is typed, and a fixed form goes through.
  await card.getByLabel('Name').fill('Ada')
  await expect(card.locator('[data-field="name"] .awr-elicit__error')).toHaveCount(0)
  await card.getByLabel('Email').fill('ada@example.test')
  await card.getByLabel('Seats').fill('2')
  await expect(card.locator('.awr-elicit__error')).toHaveCount(0)
  await card.getByRole('button', { name: 'Submit' }).click()

  await expect(answerBubble(page)).toHaveText('All done.', { timeout: 45_000 })
  expect(answered('profile')).toHaveLength(1)
  expect(answered('profile')[0]).toMatchObject({
    action: 'accept',
    content: { name: 'Ada', email: 'ada@example.test', seats: 2 },
  })
})

test('form: Decline is a decline at the server (on the 2025 revisions), and the run goes on', async ({
  page,
}) => {
  await mockGemini(page, callTool('elicit_form'))
  await openWithServer(page, 'legacy')
  await expect(page.locator('.mcp__protocol')).toContainText('MCP 2025-')
  await expect(page.locator('.mcp__protocol')).toContainText('asked for: legacy')

  await send(page, 'Fill in my profile')
  const card = prompt(page)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByLabel('Name').fill('Never sent')
  await card.getByRole('button', { name: 'Decline' }).click()

  await expect(answerBubble(page)).toHaveText('All done.', { timeout: 45_000 })
  await expect(card).toHaveCount(0)
  expect(answered('profile')).toEqual([{ action: 'decline' }])
  expect(server.elicitations.at(-1)?.era).toBe('legacy')
  // The user decided: nothing is reported as answered automatically.
  await expect(page.locator('.awr-elicit-outcome')).toHaveCount(0)
})

test('form: Cancel is a cancel at the server, not a decline', async ({ page }) => {
  await mockGemini(page, callTool('elicit_form'))
  await openWithServer(page)
  await send(page, 'Fill in my profile')
  const card = prompt(page)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('button', { name: 'Cancel' }).click()

  await expect(answerBubble(page)).toHaveText('All done.', { timeout: 45_000 })
  await expect(card).toHaveCount(0)
  expect(answered('profile')).toEqual([{ action: 'cancel' }])
  await expect(page.locator('.awr-elicit-outcome')).toHaveCount(0)
})

test('link: the page is opened by the click on Open and by nothing else; "finished" is the accept', async ({
  page,
  context,
}) => {
  await mockGemini(page, callTool('elicit_url'))
  const popups: Page[] = []
  context.on('page', (p) => popups.push(p))
  await openWithServer(page)
  await send(page, 'Send me to the page')

  const card = prompt(page)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toHaveClass(/awr-elicit--url/)
  const link = server.urlElicitations[0]
  expect(link).toBeTruthy()
  // The host first, the whole address as text - and no link anybody could follow by accident.
  await expect(card.locator('.awr-elicit__host')).toHaveText(new URL(link.url).host)
  await expect(card.locator('.awr-elicit__url')).toHaveText(link.url)
  await expect(card.locator('a')).toHaveCount(0)
  await expect(page.locator(`a[href="${link.url}"]`)).toHaveCount(0)
  // Before the click there is nothing to confirm, and nothing was opened or fetched.
  await expect(card.getByRole('button', { name: 'I have finished there' })).toHaveCount(0)
  await page.waitForTimeout(1500)
  expect(popups).toHaveLength(0)
  expect(link.opened).toBe(0)
  expect(answered('link')).toEqual([])

  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    card.getByRole('button', { name: 'Open in a new tab' }).click(),
  ])
  await popup.waitForLoadState()
  expect(popup.url()).toBe(link.url)
  // noopener: the opened page has no handle on the app.
  expect(await popup.evaluate(() => window.opener)).toBeNull()
  expect(popups).toHaveLength(1)
  await popup.locator('#complete').click()
  await expect(popup.locator('#done')).toBeVisible()
  await popup.close()

  await expect(card.locator('.awr-elicit__opened')).toBeVisible()
  await card.getByRole('button', { name: 'I have finished there' }).click()
  await expect(answerBubble(page)).toHaveText('All done.', { timeout: 45_000 })
  await expect(card).toHaveCount(0)
  expect(answered('link')).toEqual([{ action: 'accept' }])
  expect(popups).toHaveLength(1)
})

test('link: Decline opens nothing', async ({ page, context }) => {
  await mockGemini(page, callTool('elicit_url'))
  const popups: Page[] = []
  context.on('page', (p) => popups.push(p))
  await openWithServer(page)
  await send(page, 'Send me to the page')
  const card = prompt(page)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('button', { name: 'Decline' }).click()

  await expect(answerBubble(page)).toHaveText('All done.', { timeout: 45_000 })
  expect(answered('link')).toEqual([{ action: 'decline' }])
  expect(popups).toHaveLength(0)
  expect(server.urlElicitations[0].opened).toBe(0)
})

test('a question nobody answers expires: the prompt goes, and the chat says it was answered automatically', async ({
  page,
}) => {
  // The page's clock is ours, so the five minutes the core waits pass at once.
  await page.clock.install()
  await mockGemini(page, callTool('elicit_form'))
  // On the 2025 revisions the question is a request the server waits on, so the automatic
  // answer is something it receives. (On 2026-07-28 the call is simply not sent again.)
  await openWithServer(page, 'legacy')
  await send(page, 'Fill in my profile')
  const card = prompt(page)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('.awr-elicit__expiry')).toContainText('Cancelled automatically in')
  await card.getByLabel('Name').fill('Too late')

  await page.clock.fastForward(301_000)

  await expect(card).toHaveCount(0)
  const outcome = page.locator('.awr-elicit-outcome')
  await expect(outcome).toHaveAttribute('data-reason', 'timeout')
  await expect(outcome).toContainText(
    'A question from the MCP server “mcp” was answered automatically',
  )
  await expect(outcome).toContainText('nobody answered in time')
  // The server was told "cancel"; the run went on and said so.
  await expect(answerBubble(page)).toHaveText('All done.', { timeout: 45_000 })
  expect(answered('profile')).toEqual([{ action: 'cancel' }])

  await outcome.getByRole('button', { name: 'Dismiss' }).click()
  await expect(outcome).toHaveCount(0)
})
