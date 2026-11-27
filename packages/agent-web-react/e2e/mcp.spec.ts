import { expect, test, type Page } from '@playwright/test'
import { SKILL_MARKERS, startLocalMcpServer, type ILocalMcpServer } from '@dudko.dev/test-servers'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'
import { startServers, type ILocalServers } from './servers.ts'

/**
 * What only a browser can check.
 *
 * The MCP connector and the OAuth flow are unit-tested in the core, and the
 * hook's pure parts are unit-tested here — but the failure that actually
 * shipped was none of those: an unrelated `useEffect` rewrote `location`
 * while the hook was awaiting a dynamic import, so the authorization code was
 * gone by the time it looked. That needs a real page, real effects, real
 * navigation and real IndexedDB.
 */

let servers: ILocalServers

test.beforeEach(async () => {
  servers = await startServers({ requireAuth: test.info().title.includes('OAuth') })
})

test.afterEach(async () => {
  await servers.close()
})

const openMcpPanel = async (page: Page) => {
  await page.goto('/')
  await page.getByRole('tab', { name: 'MCP servers' }).click()
  await expect(page.getByPlaceholder('https://your-server.example/mcp')).toBeVisible()
}

const addServer = async (page: Page, url: string, auth?: 'OAuth', registration?: string) => {
  await page.getByPlaceholder('https://your-server.example/mcp').fill(url)
  // The name is the tool prefix: "mcp" keeps the tool called mcp__echo.
  await page.getByLabel('Name (tool prefix)').fill('mcp')
  if (auth) await page.getByRole('radio', { name: auth, exact: true }).check()
  if (registration) await registrationSelect(page).selectOption({ label: registration })
  await page.getByRole('button', { name: 'Add server' }).click()
}

const registrationSelect = (page: Page) => page.getByLabel('Client registration')

const status = (page: Page) => page.locator('.mcp__server-status')

test('OAuth: the client registration select is under the OAuth choice; off agent.dudko.dev CIMD only is disabled', async ({
  page,
}) => {
  await openMcpPanel(page)
  await expect(registrationSelect(page)).toHaveCount(0)
  await page.getByRole('radio', { name: 'OAuth', exact: true }).check()

  const select = registrationSelect(page)
  await expect(select).toBeVisible()
  await expect(select).toHaveValue('auto')
  const options = select.locator('option')
  await expect(options).toHaveText(['Auto (CIMD or DCR)', 'CIMD only', 'DCR only'])
  // The demo's client ID metadata document names agent.dudko.dev's pages only: on any other
  // origin (this one is loopback) it cannot be used, and the note says why.
  await expect(options.nth(1)).toBeDisabled()
  await expect(options.nth(0)).toBeEnabled()
  await expect(options.nth(2)).toBeEnabled()
  await expect(page.getByText('so here Auto means DCR')).toBeVisible()

  await page.getByRole('radio', { name: 'No auth', exact: true }).check()
  await expect(registrationSelect(page)).toHaveCount(0)
})

test('OAuth: "DCR only" registers, signs in, and the card says OAuth · DCR', async ({ page }) => {
  await openMcpPanel(page)
  await addServer(page, servers.mcpUrl, 'OAuth', 'DCR only')
  await expect(status(page)).toContainText('Authorization required')
  expect(servers.registrations()).toBe(1)
  await page.getByRole('button', { name: /Authorize/ }).click()

  await expect(status(page)).toContainText('Connected', { timeout: 15_000 })
  await expect(page.locator('.mcp__protocol')).toContainText('OAuth · DCR')
  expect(servers.registrations()).toBe(1)

  // Remembered with the server: a reload reconnects the same client, and says so again.
  await page.reload()
  await page.getByRole('tab', { name: 'MCP servers' }).click()
  await expect(status(page)).toContainText('Connected', { timeout: 15_000 })
  await expect(page.locator('.mcp__protocol')).toContainText('OAuth · DCR')
  expect(servers.registrations()).toBe(1)
  const stored = await page.evaluate(() => localStorage.getItem('agent-web-react:mcp-servers'))
  expect(JSON.parse(stored ?? '[]')[0]?.oauth).toEqual({ registration: 'dcr' })
})

test('connects to a server that needs no auth and lists its tools', async ({ page }) => {
  await openMcpPanel(page)
  await addServer(page, servers.mcpUrl)

  await expect(status(page)).toContainText('Connected')
  await expect(page.locator('.mcp__tool code')).toHaveText(['mcp__echo'])
  // The chat panel only appears once tools are in hand.
  await expect(page.getByText('Connect one or more servers on the right')).toBeHidden()
})

test('OAuth: authorize, come back, and end up connected', async ({ page }) => {
  await openMcpPanel(page)
  await addServer(page, servers.mcpUrl, 'OAuth')

  // The server challenges; the app registers itself and asks the user to go.
  await expect(status(page)).toContainText('Authorization required')

  // Clicking through leaves the app entirely — the authorization server
  // bounces back with ?code=, and the page reloads from scratch.
  await page.getByRole('button', { name: /Authorize/ }).click()

  await expect(status(page)).toContainText('Connected', { timeout: 15_000 })
  await expect(page.locator('.mcp__tool code')).toHaveText(['mcp__echo'])
  expect(servers.registrations()).toBe(1)
  // Auto, on an origin that cannot use the demo's document: a dynamic registration, and the
  // card says which way was taken.
  await expect(page.locator('.mcp__protocol')).toContainText('OAuth · DCR')

  // The single-use code must not survive in the address bar, or a reload
  // replays a spent authorization.
  expect(new URL(page.url()).searchParams.get('code')).toBeNull()
  // And the visitor lands back on the panel they were using, not the default.
  await expect(page.getByRole('tab', { name: 'MCP servers' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

test('OAuth: a reload reconnects with the stored tokens, without re-authorizing', async ({
  page,
}) => {
  await openMcpPanel(page)
  await addServer(page, servers.mcpUrl, 'OAuth')
  await expect(status(page)).toContainText('Authorization required')
  await page.getByRole('button', { name: /Authorize/ }).click()
  await expect(status(page)).toContainText('Connected', { timeout: 15_000 })

  await page.reload()
  await page.getByRole('tab', { name: 'MCP servers' }).click()

  // The server list is remembered and reconnects on its own.
  await expect(status(page)).toContainText('Connected', { timeout: 15_000 })
  // Tokens and the dynamic registration came out of the encrypted vault: no
  // second round-trip to the authorization server.
  expect(servers.registrations()).toBe(1)
})

test('reports a server that cannot be reached instead of hanging', async ({ page }) => {
  await openMcpPanel(page)
  await addServer(page, 'http://127.0.0.1:1/mcp')

  await expect(status(page)).toContainText('Failed', { timeout: 15_000 })
  await expect(page.locator('.mcp__server .settings__warn')).toBeVisible()
})

test('several servers merge into one toolbox', async ({ page }) => {
  await openMcpPanel(page)
  await addServer(page, servers.mcpUrl)
  await expect(status(page)).toContainText('Connected')
  await page.getByPlaceholder('https://your-server.example/mcp').fill(servers.mcpUrl)
  await page.getByLabel('Name (tool prefix)').fill('second')
  await page.getByRole('button', { name: 'Add server' }).click()

  await expect(status(page)).toHaveText([/Connected/, /Connected/])
  await expect(page.locator('.mcp__tool code')).toHaveText(['mcp__echo', 'second__echo'])
})

/**
 * MCP skills (`skills` on a server): a server's skill is shown to the person before its text
 * reaches the model - the demo's real agent and connector, the test server's skills over real
 * sockets (2026-07-28), Gemini's answers scripted. What only a page can check: the card a person
 * reads, the preview opened by a click, and that the model was sent nothing of the skill before
 * the click on "Allow once" - and nothing at all after "Deny".
 */
test.describe('MCP skills', () => {
  let skills: ILocalMcpServer

  test.beforeEach(async () => {
    skills = await startLocalMcpServer({ cors: '*', protocol: 'dual', skills: true })
  })

  test.afterEach(async () => {
    await skills.close()
  })

  /** One step that loads `skill`, then an answer. */
  const loads =
    (skill: string) =>
    (c: GeminiCall): GeminiReply => {
      if (c.stage === 'planner') return plan('Use the skill')
      if (c.stage === 'executor') {
        return c.functionResponses.length === 0
          ? { call: { name: 'load_skill', args: { name: skill } } }
          : { text: 'Step done.' }
      }
      if (c.stage === 'replanner') {
        return { text: JSON.stringify({ decision: 'finish', reason: 'done' }) }
      }
      return { text: 'All done.' }
    }

  /** A key, the MCP tab, and the skills server added as "docs" with its skills on. */
  const openWithSkills = async (page: Page) => {
    await page.goto('/')
    await page.getByPlaceholder('AIza…').fill('AIza-test-key')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
    await page.getByRole('tab', { name: 'MCP servers' }).click()
    await page.getByPlaceholder('https://your-server.example/mcp').fill(skills.url)
    await page.getByLabel('Name (tool prefix)').fill('docs')
    await page.getByLabel('Load skills from this server (experimental)').check()
    await page.getByRole('button', { name: 'Add server' }).click()
    await expect(status(page)).toContainText('Connected')
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  }

  const send = async (page: Page, text: string) => {
    await page.getByRole('textbox', { name: 'Message' }).fill(text)
    await page.getByRole('button', { name: 'Send' }).click()
  }

  const answer = (page: Page) => page.locator('.awr-msg--assistant .awr-msg__bubble').last()
  const sent = (calls: GeminiCall[]): string => JSON.stringify(calls)

  test('the card says whose skill it is and shows its text; nothing reaches the model before "Allow once"', async ({
    page,
  }) => {
    const calls = await mockGemini(page, loads('docs/pdf-processing'))
    await openWithSkills(page)
    await send(page, 'Fill in the form')

    const card = page.locator('.awr-approval--skill')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toHaveAttribute('data-skill', 'docs/pdf-processing')
    await expect(card.locator('.awr-approval__head')).toHaveText(
      'The server “docs” offers the skill “pdf-processing”',
    )
    await expect(card.locator('.awr-approval__quote').first()).toHaveText(
      'Extract, fill and assemble PDF documents',
    )
    await expect(card.locator('.awr-approval__skillmeta')).toContainText('docs/pdf-processing')
    await expect(card.locator('.awr-approval__skillmeta')).toContainText('2 more files')
    // The text is behind a click, and it is the server's text, as text.
    const preview = card.locator('details.awr-approval__preview')
    await expect(preview).not.toHaveAttribute('open', '')
    await expect(card.locator('.awr-approval__body')).toBeHidden()
    await preview.locator('summary').click()
    await expect(card.locator('.awr-approval__body')).toBeVisible()
    await expect(card.locator('.awr-approval__body')).toContainText(SKILL_MARKERS.pdfProcessing)
    await expect(card.locator('.awr-approval__body img, .awr-approval__body a')).toHaveCount(0)
    await expect(preview).toContainText('references/FORMS.md, scripts/extract.py')
    // The model has been sent nothing of it yet.
    expect(sent(calls)).not.toContain(SKILL_MARKERS.pdfProcessing)
    expect(skills.skillReads).toEqual(['skill://pdf-processing/SKILL.md'])

    await card.getByRole('button', { name: 'Allow once' }).click()
    await expect(answer(page)).toHaveText('All done.', { timeout: 45_000 })
    await expect(card).toHaveCount(0)
    // Now it is the load_skill result the executor read.
    const executor = calls.filter((c) => c.stage === 'executor')
    const loaded = executor.find((c) => c.functionResponses.some((r) => r.name === 'load_skill'))
    expect(JSON.stringify(loaded?.functionResponses)).toContain(SKILL_MARKERS.pdfProcessing)
    // A saved chat keeps who and what, not the server's text.
    const saved = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))
    expect(saved).not.toContain(SKILL_MARKERS.pdfProcessing)
  })

  test('"Deny" keeps all of it out: the model is told, and never sent the text', async ({
    page,
  }) => {
    const calls = await mockGemini(page, loads('docs/git-workflow'))
    await openWithSkills(page)
    await send(page, 'Commit it')

    const card = page.locator('.awr-approval--skill')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.locator('.awr-approval__head')).toHaveText(
      'The server “docs” offers the skill “git-workflow”',
    )
    await card.getByRole('button', { name: 'Deny' }).click()
    await expect(answer(page)).toHaveText('All done.', { timeout: 45_000 })
    await expect(card).toHaveCount(0)
    expect(sent(calls)).not.toContain(SKILL_MARKERS.gitWorkflow)
    const executor = calls.filter((c) => c.stage === 'executor')
    expect(JSON.stringify(executor.at(-1)?.functionResponses)).toContain(
      'The user did not allow the skill \\"docs/git-workflow\\"',
    )
  })

  test('a generated skill: the card says no checksums and shows the copy read; nothing reaches the model before "Allow once"', async ({
    page,
  }) => {
    // A server added with `skills: { dynamic: true }` - remembered in the list as any setting, and
    // reconnected from it on load: the hooks hand the setting to the core as it is.
    const generated = await startLocalMcpServer({
      cors: '*',
      protocol: 'dual',
      skills: true,
      skillDirectoryRead: true,
    })
    generated.skillFaults.dynamic = true
    try {
      const calls = await mockGemini(page, loads('docs/generated'))
      await page.addInitScript((url) => {
        const key = 'agent-web-react:mcp-servers'
        if (localStorage.getItem(key)) return
        localStorage.setItem(
          key,
          JSON.stringify([
            { name: 'docs', url, auth: 'none', protocol: 'auto', skills: { dynamic: true } },
          ]),
        )
      }, generated.url)
      await page.goto('/')
      await page.getByPlaceholder('AIza…').fill('AIza-test-key')
      await page.getByRole('button', { name: 'Save' }).click()
      await page.getByRole('tab', { name: 'MCP servers' }).click()
      await expect(status(page)).toContainText('Connected', { timeout: 15_000 })
      await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
      await send(page, 'Use the generated skill')

      const card = page.locator('.awr-approval--skill')
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card).toHaveAttribute('data-skill', 'docs/generated')
      await expect(card.locator('.awr-approval__dynamic')).toHaveText(
        'This server publishes no checksums for this skill: you approve the copy the agent just read, and only that copy is used.',
      )
      // The size and files are the copy's: read whole before the card was shown.
      await expect(card.locator('.awr-approval__skillmeta')).toContainText('2 more files')
      expect(generated.skillReads).toEqual([
        'skill://generated/SKILL.md',
        'skill://generated/references/notes.md',
        'skill://generated/templates/a.md',
      ])
      await card.locator('details.awr-approval__preview summary').click()
      await expect(card.locator('.awr-approval__body')).toContainText(SKILL_MARKERS.generated)
      await expect(card.locator('details.awr-approval__preview')).toContainText(
        'references/notes.md, templates/a.md',
      )
      expect(sent(calls)).not.toContain(SKILL_MARKERS.generated)
      // On a phone the card fits too.
      await page.setViewportSize({ width: 390, height: 844 })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBe(0)
      await page.setViewportSize({ width: 1280, height: 720 })

      await card.getByRole('button', { name: 'Allow once' }).click()
      await expect(answer(page)).toHaveText('All done.', { timeout: 45_000 })
      const executor = calls.filter((c) => c.stage === 'executor')
      const loaded = executor.find((c) => c.functionResponses.some((r) => r.name === 'load_skill'))
      expect(JSON.stringify(loaded?.functionResponses)).toContain(SKILL_MARKERS.generated)
      // The files it read up front reached the model nowhere; nothing of the copy is stored.
      for (const marker of [SKILL_MARKERS.generatedNotes, SKILL_MARKERS.generatedTemplate]) {
        expect(sent(calls)).not.toContain(marker)
      }
      const saved = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))
      expect(saved).not.toContain(SKILL_MARKERS.generated)
      const list = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('agent-web-react:mcp-servers') ?? '[]'),
      )
      expect(list[0]?.skills).toEqual({ dynamic: true })
      expect(generated.skillReads).toHaveLength(3)
    } finally {
      await generated.close()
    }
  })

  test('on a phone the card fits: no sideways scroll, the preview wraps', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockGemini(page, loads('docs/pdf-processing'))
    await openWithSkills(page)
    await send(page, 'Fill in the form')
    const card = page.locator('.awr-approval--skill')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.locator('details.awr-approval__preview summary').click()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
    await card.getByRole('button', { name: 'Deny' }).click()
  })
})
