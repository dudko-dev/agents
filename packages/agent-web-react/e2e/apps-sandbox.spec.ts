import { expect, test } from '@playwright/test'
import { startLocalMcpServer, type ILocalMcpServer } from '@dudko.dev/test-servers'
import {
  APP_TITLE,
  counted,
  openWithApp,
  outerOf,
  runProbes,
  sandboxOrigin,
  status,
  type ICounted,
} from './apps-shared.ts'

/**
 * MCP Apps on an origin of their own: the demo's sandbox page (`appSandbox`; in these tests the
 * preview server answers it as `localhost` for a page on 127.0.0.1 - another origin and another
 * site), the same real MCP server and hostile "travel" app as `apps.spec.ts`, the same counted
 * endpoints for a declared and an undeclared origin. What changes with the origin is checked
 * here: the app HAS an origin (its own storage, a real `Origin` header) and it is never the
 * page's; it is same-origin with its sandbox page and uses that page from inside - and still
 * reaches no undeclared origin, through the page or by navigating it; loading that page again
 * stops the app; messages from any other window or origin are ignored; another origin cannot
 * frame the sandbox page; and an unreachable sandbox page falls back to the opaque frame. The same
 * guards as pure code: `tests/apps-sandbox.test.ts`.
 */

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

test('on its own origin: the frames, the header, the menu, and a real Origin on its requests', async ({
  page,
}) => {
  const { frame, app } = await openWithApp(page, mcp)
  const origin = sandboxOrigin(page)
  // Ours, on the page's side: the shell runs no script and may frame the sandbox page's one URL.
  const outer = outerOf(page)
  await expect(outer).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
  expect(await outer.getAttribute('allow')).toBeNull()
  const shell = (await outer.getAttribute('srcdoc')) ?? ''
  expect(shell).not.toContain('<script')
  const proxy = page.frameLocator(`iframe[title="${APP_TITLE}"]`).locator('#proxy')
  const proxyUrl = (await proxy.getAttribute('src')) ?? ''
  expect(proxyUrl.startsWith(`${origin}/sandbox/v1/`)).toBe(true)
  expect(shell).toContain("script-src 'none'")
  expect(shell).toContain(`frame-src ${proxyUrl};`)
  await expect(proxy).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
  expect(await proxy.getAttribute('allow')).toBeNull()
  // The sandbox page's frame for the app: scripts and its origin, nothing else.
  const inner = page
    .frameLocator(`iframe[title="${APP_TITLE}"]`)
    .frameLocator('#proxy')
    .locator('#app')
  await expect(inner).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
  expect(await inner.getAttribute('allow')).toBeNull()
  // The header says where it runs; the menu says which origin.
  await expect(frame.locator('.awr-frame__badges')).toHaveText('sandboxed on its own origin')
  await frame.getByRole('button', { name: 'App menu' }).click()
  await expect(frame.locator('.awr-frame__menunote').last()).toHaveText(
    `Runs on its own origin, ${origin}: its storage is its own, never this page's.`,
  )
  await page.keyboard.press('Escape')
  // Everything else is the same app: input, host info, result.
  await expect(app.locator('body')).toHaveAttribute(
    'data-input',
    JSON.stringify({ from: 'LIS', to: 'VIE' }),
  )
  await expect(app.locator('body')).toHaveAttribute('data-host', '@dudko.dev/agent-web-react')
  // Its server's read-only tool runs through the sandbox page and back.
  await app.getByRole('button', { name: 'Refresh' }).click()
  await expect(status(app)).toContainText('ok: Three flights')
})

test('guard: a hostile app keeps to its own origin - its storage, never the page’s; no undeclared origin, not even through its sandbox page', async ({
  page,
}) => {
  const { app } = await openWithApp(page, mcp)
  const origin = sandboxOrigin(page)
  // Something of the page's own to steal.
  await page.evaluate(() => {
    localStorage.setItem('host-secret', 'vault-key')
    document.cookie = 'host-cookie=1; path=/'
  })
  const hostDatabases = await page.evaluate(async () =>
    (await indexedDB.databases()).map((d) => d.name ?? ''),
  )
  expect(hostDatabases.length).toBeGreaterThan(0)
  const url = page.url()
  const verdict = await runProbes(app)
  // An origin, the sandbox's - and its document's URL says so too.
  expect(await verdict('origin')).toBe(`origin: ${origin} ${origin}`)
  // Same-origin with its sandbox page, which is why the guards are not in that page.
  expect(await verdict('parent-dom')).toBe('allowed: MCP App sandbox')
  // Storage of its own, empty of the page's.
  for (const name of ['local-storage', 'session-storage']) {
    expect(await verdict(name), name).toBe('allowed')
  }
  expect(await verdict('host-secret')).toBe('allowed: null')
  expect(await verdict('cookie')).not.toContain('host-cookie')
  expect(await verdict('indexeddb')).toMatch(/^allowed: /)
  const seen = (await verdict('host-databases')) ?? ''
  for (const name of hostDatabases) expect(seen, name).not.toContain(`"${name}"`)
  // The page, the shell around it, the top window, popups, the network it did not declare -
  // directly or through its sandbox page (whose policy is the app's own).
  for (const name of [
    'top-dom',
    'grandparent-dom',
    'top-location',
    'window-open',
    'top-navigation',
    'fetch-undeclared',
    'image-undeclared',
    'parent-fetch',
    'parent-image',
  ]) {
    expect(await verdict(name), name).toBe('blocked')
  }
  expect(await verdict('parent-frame')).toBe('attempted')
  expect(await verdict('fetch-declared')).toBe('allowed: 200')
  expect(declared.hits).toEqual(['/declared?fetch'])
  // A real Origin: its APIs can allow it by name.
  expect(declared.origins).toEqual([origin])
  // What it wrote is on its origin; the page's storage is as it was.
  expect(await app.locator('body').evaluate(() => localStorage.getItem('mcp-app-probe'))).toBe('1')
  expect(await page.evaluate(() => localStorage.getItem('mcp-app-probe'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('host-secret'))).toBe('vault-key')
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

  // Navigating itself away: refused by its sandbox page's policy (the app's frame shows the
  // browser's error page) - nothing is requested.
  await app.getByRole('button', { name: 'Leave', exact: true }).click()
  await page.waitForTimeout(800)
  expect(undeclared.hits).toEqual([])
  expect(page.url()).toBe(url)
})

test('guard: an app that navigates its sandbox page away, from inside that page, reaches nothing', async ({
  page,
}) => {
  const { app } = await openWithApp(page, mcp)
  const url = page.url()
  // A link in the sandbox page's own document (same origin as the app), clicked: the browser lets
  // that page navigate itself, and only the shell's `frame-src`, pinned to the page's URL, refuses
  // the request. Without the shell this request would leave (see docs/chat.md).
  await app.getByRole('button', { name: 'Leave through the frame' }).click()
  await page.waitForTimeout(1500)
  expect(undeclared.hits).toEqual([])
  expect(page.url()).toBe(url)
  const proxy = page
    .frames()
    .find((f) => f.parentFrame()?.parentFrame() === page.mainFrame() && f.url() !== 'about:srcdoc')
  expect(proxy?.url().startsWith('chrome-error://')).toBe(true)
})

test('guard: an app that lifts its own frame’s sandbox gets no more than the frames above it allow', async ({
  page,
}) => {
  const { app } = await openWithApp(page, mcp)
  const url = page.url()
  // Same origin as its sandbox page, it reaches its own <iframe>: the attribute goes, and the
  // document it loads there tries the top window and the network. The flags of the frames above
  // (drawn on the page's side) and the inherited policy are what is left - and they hold.
  await app.getByRole('button', { name: 'Lift its sandbox' }).click()
  // It did: its frame has no sandbox attribute any more, and its own document is in it.
  const own = page
    .frameLocator(`iframe[title="${APP_TITLE}"]`)
    .frameLocator('#proxy')
    .locator('#app')
  await expect(own).not.toHaveAttribute('sandbox', /./)
  await expect.poll(() => app.locator('html').evaluate(() => document.title)).toBe('lifted')
  await page.waitForTimeout(1000)
  expect(page.url()).toBe(url)
  expect(undeclared.hits).toEqual([])
})

test('guard: an app that loads its sandbox page again is stopped; Reload starts it afresh', async ({
  page,
}) => {
  const { frame, app } = await openWithApp(page, mcp)
  // The pin lets the sandbox page's own URL load again: a second handshake, which the page takes
  // as the app having navigated its frame.
  await app.getByRole('button', { name: 'Reload the frame' }).click()
  await expect(frame.locator('[role="alert"]')).toHaveText(
    'The app reloaded its frame, so it was stopped. Reload it to start again.',
  )
  await expect(outerOf(page)).toHaveCount(0)
  // Its requests are not answered any more: the frame is gone. The user can start it again.
  await frame.getByRole('button', { name: 'App menu' }).click()
  await frame.getByRole('menuitem', { name: 'Reload app' }).click()
  await expect(frame).toHaveAttribute('data-sandbox', 'origin', { timeout: 15_000 })
  await expect(app.locator('.f')).toHaveCount(3)
})

test('guard: messages from another window or origin change nothing - a forged handshake, forged requests', async ({
  page,
}) => {
  const { frame, app } = await openWithApp(page, mcp)
  const forged = [
    { jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} },
    {
      jsonrpc: '2.0',
      method: 'ui/notifications/sandbox-resource-ready',
      params: { html: '<p>forged</p>' },
    },
    { jsonrpc: '2.0', id: 77, method: 'ui/open-link', params: { url: 'https://forged.test/' } },
    {
      jsonrpc: '2.0',
      id: 78,
      method: 'tools/call',
      params: { name: 'flights.book', arguments: { flight: 'FORGED' } },
    },
  ]
  // A page of another origin, framed by the page, posting to the page.
  const foreign = await counted(
    `<!doctype html><script>for (const m of ${JSON.stringify(forged)}) top.postMessage(m, '*')</script>`,
    'text/html',
  )
  try {
    await page.evaluate((src) => {
      const f = document.createElement('iframe')
      f.src = src
      document.body.append(f)
    }, `${foreign.url}/foreign`)
    await expect.poll(() => foreign.hits).toEqual(['/foreign'])
    // The page itself (right origin for nothing, wrong window).
    await page.evaluate((all) => {
      for (const m of all) window.postMessage(m, '*')
    }, forged)
    await page.waitForTimeout(800)
    await expect(page.locator('.awr-approval--app')).toHaveCount(0)
    await expect(frame).toHaveAttribute('data-sandbox', 'origin')
    await expect(frame.locator('[role="alert"]')).toHaveCount(0)
    expect(mcp.calls.some((c) => JSON.stringify(c.args).includes('FORGED'))).toBe(false)
    // The app is untouched: its own request still reaches the user.
    await app.getByRole('button', { name: 'Airline site' }).click()
    const card = page.locator('.awr-approval--app')
    await expect(card).toContainText('wants to open a link')
    await expect(card.locator('.awr-approval__url b')).toHaveText('example-air.test')
    await card.getByRole('button', { name: 'Cancel' }).click()
    await expect(status(app)).toHaveText('link refused: Link opening denied by user')
  } finally {
    await foreign.close()
  }
})

test('guard: another origin cannot frame the sandbox page, and gets nothing from it', async ({
  page,
  context,
}) => {
  await openWithApp(page, mcp)
  const proxyUrl =
    (await page
      .frameLocator(`iframe[title="${APP_TITLE}"]`)
      .locator('#proxy')
      .getAttribute('src')) ?? ''
  expect(proxyUrl).toMatch(/\/sandbox\/v1\/[A-Za-z0-9_-]+$/)
  const foreign = await counted(
    '<!doctype html><iframe id="f"></iframe><script>window.got = []; ' +
      "addEventListener('message', (e) => window.got.push(e.data)); " +
      'document.getElementById("f").src = decodeURIComponent(location.hash.slice(1))</script>',
    'text/html',
  )
  try {
    const other = await context.newPage()
    await other.goto(`${foreign.url}/framer#${encodeURIComponent(proxyUrl)}`)
    await other.waitForTimeout(1000)
    // `frame-ancestors`: the browser refuses to show it, so its script never runs.
    const child = other.frames().find((f) => f !== other.mainFrame())
    expect(child?.url().startsWith('chrome-error://')).toBe(true)
    expect(await other.evaluate(() => (window as unknown as { got: unknown[] }).got)).toEqual([])
    await other.close()
  } finally {
    await foreign.close()
  }
})

test('fallback: the sandbox page unreachable, the app runs in the opaque frame - and works', async ({
  page,
}) => {
  const { frame, app } = await openWithApp(page, mcp, { mode: 'opaque' })
  await expect(frame.locator('.awr-frame__badges')).toHaveText('sandboxed')
  await expect(outerOf(page)).toHaveAttribute('sandbox', 'allow-scripts')
  const verdict = await runProbes(app)
  expect(await verdict('origin')).toBe('origin: null null')
  expect(await verdict('local-storage')).toBe('blocked')
  expect(await verdict('fetch-undeclared')).toBe('blocked')
  expect(undeclared.hits).toEqual([])
  // Its requests reach the user as before.
  await app.locator('.f').first().getByRole('button', { name: 'Select' }).click()
  await app.getByRole('button', { name: 'Book this flight' }).click()
  const card = page.locator('.awr-approval--app')
  await expect(card).toContainText('The app “travel” wants to run')
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(status(app)).toHaveText('ok: booked:SL 418')
})
