import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'
import { startPageServer, type IPageServer } from './page-server.ts'
import type { FilesPageApi } from './fixtures/files-page.ts'

/**
 * Files the agent writes in a turn: the chips under the answer, their inline previews, and the
 * sandboxed frame an `.html` file is previewed in.
 *
 * The frame is a security boundary, so most of this file is about what a previewed page CANNOT
 * do. Each `guard …` test is one guard of `src/html-preview.ts` / `SandboxedFrame`, proved in a
 * real browser; `tests/files.test.ts` holds the same guards as string checks. Two pages are used:
 * the demo (what ships: scripts off) and a test-only page with scripts ON (`fixtures/
 * files-page.ts`, served on loopback while the tests run) - the worst case.
 */

// ── a counted endpoint: anything that reaches the network from a preview lands here ──────────

let sink: Server
let sinkUrl = ''
const hits: string[] = []
let site: IPageServer

test.beforeAll(async () => {
  sink = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(200, {
      'content-type': 'text/html',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    })
    res.end('<!doctype html><title>sink</title><p id="sink">reached the network</p>')
  })
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
  sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`
  site = await startPageServer('files-page.ts')
})

test.afterAll(async () => {
  await site?.close()
  sink.closeAllConnections()
  await new Promise<void>((resolve) => sink.close(() => resolve()))
})

test.beforeEach(() => {
  hits.length = 0
})

/** The counter itself works: a request from the test process is counted. */
const sinkIsAlive = async (): Promise<void> => {
  const before = hits.length
  await fetch(`${sinkUrl}/control`)
  expect(hits.length).toBe(before + 1)
  hits.length = before
}

/** Give anything the page started a chance to arrive, then say what did. */
const arrived = async (page: Page, ms = 700): Promise<string[]> => {
  await page.waitForTimeout(ms)
  await sinkIsAlive()
  return [...hits]
}

// ── the test-only page (scripts on) ──────────────────────────────────────────

const openFixture = async (
  page: Page,
  docs: { path: string; html: string }[],
  scripts: boolean,
): Promise<void> => {
  await page.goto(site.url)
  await expect(page.locator('#status')).toHaveText('ready')
  await page.evaluate(
    ([d, s]) =>
      (window as unknown as { filesPage: FilesPageApi }).filesPage.show(
        d as { path: string; html: string }[],
        { scripts: s as boolean },
      ),
    [docs, scripts] as const,
  )
}

/** Open a chip's preview and return the untrusted document (the inner of the two frames). */
const preview = async (page: Page, name: string): Promise<FrameLocator> => {
  await page.getByRole('button', { name: `Open ${name}` }).click()
  await expect(page.locator('iframe.awr-frame__iframe')).toBeVisible()
  return page.frameLocator('iframe.awr-frame__iframe').frameLocator('iframe')
}

/** The host page is still itself: not navigated, no popup, its secret where it was. */
const hostUntouched = async (page: Page): Promise<void> => {
  expect(page.url()).toBe(site.url)
  expect(page.context().pages()).toHaveLength(1)
  await expect(page.locator('#host-secret')).toHaveText('HOST-SECRET-9d2f')
}

// A page that tries everything a script can try, and writes down what happened.
const probe = (): string => `<!doctype html><html><body><pre id="out">not run</pre><script>
(async () => {
  const r = {}
  const t = (name, fn) => { try { r[name] = String(fn()) } catch (e) { r[name] = 'throws:' + e.name } }
  t('origin', () => self.origin)
  t('parentDom', () => parent.document.body.textContent)
  t('topDom', () => top.document.getElementById('host-secret').textContent)
  t('topGlobal', () => top.hostSecret)
  t('localStorage', () => localStorage.getItem('vault-key'))
  t('sessionStorage', () => sessionStorage.getItem('vault-key'))
  t('cookie', () => document.cookie)
  t('indexedDB', () => indexedDB.open('host-vault'))
  t('topNavigate', () => { top.location = '${sinkUrl}/hit?top-location'; return 'assigned' })
  t('parentNavigate', () => { parent.parent.location.href = '${sinkUrl}/hit?parent-location'; return 'assigned' })
  t('open', () => window.open('${sinkUrl}/hit?window-open'))
  t('beacon', () => navigator.sendBeacon('${sinkUrl}/hit?beacon'))
  t('image', () => { new Image().src = '${sinkUrl}/hit?image'; return 'set' })
  t('websocket', () => { new WebSocket('${sinkUrl.replace('http', 'ws')}/hit?ws'); return 'made' })
  t('eventsource', () => { new EventSource('${sinkUrl}/hit?sse'); return 'made' })
  t('worker', () => { new Worker('${sinkUrl}/hit?worker'); return 'made' })
  t('script', () => { const s = document.createElement('script'); s.src = '${sinkUrl}/hit?script'; document.head.appendChild(s); return 'added' })
  t('style', () => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '${sinkUrl}/hit?style'; document.head.appendChild(l); return 'added' })
  t('frame', () => { const f = document.createElement('iframe'); f.src = '${sinkUrl}/hit?frame'; document.body.appendChild(f); return 'added' })
  t('formSubmit', () => { const f = document.createElement('form'); f.action = '${sinkUrl}/hit'; f.innerHTML = '<input name="form" value="1">'; document.body.appendChild(f); f.submit(); return 'submitted' })
  t('eval', () => eval('1 + 1'))
  try { await fetch('${sinkUrl}/hit?fetch', { mode: 'no-cors' }); r.fetch = 'sent' } catch (e) { r.fetch = 'throws:' + e.name }
  try { await new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open('GET', '${sinkUrl}/hit?xhr'); x.onload = ok; x.onerror = () => no(new Error('x')); x.send() }); r.xhr = 'sent' } catch (e) { r.xhr = 'blocked' }
  try { await import('${sinkUrl}/hit?import'); r.import = 'loaded' } catch (e) { r.import = 'blocked' }
  document.getElementById('out').textContent = JSON.stringify(r)
})()
</script></body></html>`

test('guard sandbox: a previewed page that runs scripts cannot read the host’s DOM, storage or IndexedDB', async ({
  page,
}) => {
  await openFixture(page, [{ path: '/probe.html', html: probe() }], true)
  const doc = await preview(page, 'probe.html')
  // The script really ran: this is what it wrote down.
  await expect(doc.locator('#out')).toContainText('"origin"')
  const r = JSON.parse((await doc.locator('#out').textContent()) ?? '{}') as Record<string, string>
  expect(r.origin, 'an opaque origin').toBe('null')
  for (const reach of ['parentDom', 'topDom', 'topGlobal', 'localStorage', 'sessionStorage']) {
    expect(r[reach], reach).toBe('throws:SecurityError')
  }
  expect(r.cookie, 'cookies').toBe('throws:SecurityError')
  expect(r.indexedDB, 'IndexedDB').toBe('throws:SecurityError')
  expect(JSON.stringify(r)).not.toContain('HOST-SECRET')
  // The sandbox attribute is the reason, on both frames.
  await expect(page.locator('iframe.awr-frame__iframe')).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(page.frameLocator('iframe.awr-frame__iframe').locator('iframe')).toHaveAttribute(
    'sandbox',
    'allow-scripts',
  )
  await hostUntouched(page)
})

test('guard csp: nothing a script starts reaches the network - fetch, XHR, beacon, image, socket, script, style, frame, form', async ({
  page,
}) => {
  await openFixture(page, [{ path: '/probe.html', html: probe() }], true)
  const doc = await preview(page, 'probe.html')
  await expect(doc.locator('#out')).toContainText('"import"')
  const r = JSON.parse((await doc.locator('#out').textContent()) ?? '{}') as Record<string, string>
  expect(r.fetch).toBe('throws:TypeError')
  expect(r.xhr).toBe('blocked')
  expect(r.import).toBe('blocked')
  expect(r.eval, 'no eval either').toBe('throws:EvalError')
  expect(await arrived(page)).toEqual([])
  await hostUntouched(page)
})

test('guard sandbox: top navigation, window.open and popups do nothing', async ({ page }) => {
  const popups: Page[] = []
  page.context().on('page', (p) => popups.push(p))
  await openFixture(
    page,
    [
      { path: '/probe.html', html: probe() },
      {
        path: '/links.html',
        html: `<!doctype html><a id="top" target="_top" href="${sinkUrl}/hit?a-top">top</a>
<a id="parent" target="_parent" href="${sinkUrl}/hit?a-parent">parent</a>
<a id="blank" target="_blank" href="${sinkUrl}/hit?a-blank">blank</a>`,
      },
    ],
    true,
  )
  let doc = await preview(page, 'probe.html')
  await expect(doc.locator('#out')).toContainText('"import"')
  const r = JSON.parse((await doc.locator('#out').textContent()) ?? '{}') as Record<string, string>
  expect(r.topNavigate).toBe('throws:SecurityError')
  expect(r.open, 'window.open gives no window').toBe('null')
  doc = await preview(page, 'links.html')
  for (const id of ['top', 'parent', 'blank']) await doc.locator(`#${id}`).click()
  expect(await arrived(page)).toEqual([])
  expect(popups).toEqual([])
  await hostUntouched(page)
})

// Ways a frame can navigate ITSELF. Neither the sandbox nor the document's own policy stops
// these: the shell's `frame-src 'none'` does. A page that navigates on a timer may already have
// tried - and lost its document to the browser's error page - by the time the test looks at it,
// so it tells the host page that it ran (`top.postMessage`), which outlives its document.
interface ISelfNavigation {
  path: string
  html: string
  /** Clicked to start the navigation. */
  click?: string
  /** It navigates by itself soon after it loads, with scripts on (and says so to the host). */
  timed?: boolean
  /** Its script writes `#m` (it says "before" until then). */
  writes?: boolean
  /** A form: the sandbox has no `allow-forms`, so the navigation is not even tried. */
  form?: boolean
}

const told = (name: string): string => `<script>top.postMessage('ran:${name}', '*')</script>`

const selfNavigations = (): ISelfNavigation[] => [
  {
    path: '/nav-location.html',
    html: `<!doctype html><p id="m">before</p><script>document.getElementById('m').textContent = 'ran'; setTimeout(() => { location.href = '${sinkUrl}/hit?location' }, 300)</script>${told('nav-location.html')}`,
    timed: true,
    writes: true,
  },
  {
    path: '/nav-replace.html',
    html: `<!doctype html><p id="m">before</p><script>document.getElementById('m').textContent = 'ran'; setTimeout(() => location.replace('${sinkUrl}/hit?replace'), 300)</script>${told('nav-replace.html')}`,
    timed: true,
    writes: true,
  },
  {
    path: '/nav-open-self.html',
    html: `<!doctype html><p id="m">before</p><script>document.getElementById('m').textContent = 'ran'; setTimeout(() => window.open('${sinkUrl}/hit?open-self', '_self'), 300)</script>${told('nav-open-self.html')}`,
    timed: true,
    writes: true,
  },
  {
    path: '/nav-refresh.html',
    html: `<!doctype html><meta http-equiv="refresh" content="1;url=${sinkUrl}/hit?refresh"><p id="m">ran</p>${told('nav-refresh.html')}`,
    timed: true,
  },
  {
    path: '/nav-link.html',
    html: `<!doctype html><p id="m">ran</p><a id="go" href="${sinkUrl}/hit?link">go</a>`,
    click: '#go',
  },
  {
    path: '/nav-form.html',
    html: `<!doctype html><p id="m">ran</p><form action="${sinkUrl}/hit"><input name="form" value="1"><button id="go">send</button></form>`,
    click: '#go',
    form: true,
  },
  {
    path: '/nav-formaction.html',
    html: `<!doctype html><p id="m">ran</p><form><button id="go" formaction="${sinkUrl}/hit?formaction">send</button></form>`,
    click: '#go',
    form: true,
  },
]

/** Keep what the previewed pages post to the host page (`top.postMessage`). */
const listenToPages = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as unknown as { told: string[] }
    w.told = []
    addEventListener('message', (e) => {
      if (typeof e.data === 'string') w.told.push(e.data)
    })
  })
const toldHost = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { told: string[] }).told)

/** The URL of the frame the previewed document is in: the inner of the two. */
const documentFrameUrl = (page: Page): string | undefined =>
  page
    .frames()
    .find((f) => f.parentFrame()?.parentFrame() === page.mainFrame())
    ?.url()

for (const scripts of [true, false]) {
  test(`guard navigation: a previewed page cannot navigate its own frame to the network (scripts ${scripts ? 'on' : 'off'})`, async ({
    page,
  }) => {
    const docs = selfNavigations()
    await openFixture(page, docs, scripts)
    await listenToPages(page)
    for (const d of docs) {
      const name = d.path.slice(1)
      const doc = await preview(page, name)
      if (d.timed && scripts) {
        // It ran - wherever its document is by now.
        await expect
          .poll(() => toldHost(page), { message: `${name} never ran` })
          .toContain(`ran:${name}`)
      } else {
        // With scripts off the script variants never run: the page stays as written.
        await expect(doc.locator('#m')).toHaveText(d.writes && !scripts ? 'before' : 'ran')
      }
      if (d.click) await doc.locator(d.click).click()
      if ((d.timed && scripts) || (d.click && !d.form)) {
        // It tried: the frame left the document. Refused, it holds the browser's own error page -
        // the document is gone, and nothing was requested (the checks below).
        await expect
          .poll(() => documentFrameUrl(page) ?? 'about:srcdoc', { message: `${name} never tried` })
          .not.toBe('about:srcdoc')
      } else {
        // Nothing to wait for (a form, or a script that does not run): long enough for the delayed
        // ones (300 ms, and the refresh's second) to have tried, were they going to.
        await page.waitForTimeout(d.click ? 400 : 1500)
      }
      // The sink's page is not in the frame.
      await expect(doc.locator('#sink')).toHaveCount(0)
      await page.getByRole('button', { name: `Close preview of ${name}` }).click()
    }
    expect(await arrived(page)).toEqual([])
    await hostUntouched(page)
  })
}

test('guard csp first: a document that tries to pre-empt the policy is still blocked', async ({
  page,
}) => {
  const loose = `default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline'; connect-src *; img-src *; style-src *; frame-src *; form-action *`
  const docs = [
    {
      // Its own permissive policy and a <base>, before anything else.
      path: '/preempt-meta.html',
      html: `<meta http-equiv="Content-Security-Policy" content="${loose}"><base href="${sinkUrl}/"><!doctype html><html><head></head><body><p id="m">before</p><img src="hit?preempt-base-img"><img src="${sinkUrl}/hit?preempt-img"><link rel="stylesheet" href="${sinkUrl}/hit?preempt-css"><script src="${sinkUrl}/hit?preempt-script"></script><script>document.getElementById('m').textContent = 'ran'; fetch('${sinkUrl}/hit?preempt-fetch').catch(() => {})</script><iframe src="${sinkUrl}/hit?preempt-frame"></iframe></body></html>`,
    },
    {
      // Content before <html>, and a second document's worth of markup.
      path: '/preempt-early.html',
      html: `<script>fetch('${sinkUrl}/hit?early-fetch').catch(() => {}); new Image().src = '${sinkUrl}/hit?early-img'</script><html><head><meta http-equiv="Content-Security-Policy" content="${loose}"></head><body><p id="m">ran</p><img src="${sinkUrl}/hit?early-img2"></body></html>`,
    },
    {
      // Tries to close the attribute it is carried in and write into the shell.
      path: '/breakout.html',
      html: `<p id="m">ran</p>"></iframe><meta http-equiv="Content-Security-Policy" content="${loose}"><script>fetch('${sinkUrl}/hit?breakout-fetch').catch(() => {})</script><img src="${sinkUrl}/hit?breakout-img"><iframe src="${sinkUrl}/hit?breakout-frame"></iframe><iframe srcdoc="<img src='${sinkUrl}/hit?breakout-srcdoc'>"></iframe>`,
    },
  ]
  await openFixture(page, docs, true)
  for (const d of docs) {
    const name = d.path.slice(1)
    const doc = await preview(page, name)
    await expect(doc.locator('#m')).toHaveText('ran')
    // The shell holds exactly one frame: nothing of the document landed beside it.
    await expect(page.frameLocator('iframe.awr-frame__iframe').locator('iframe')).toHaveCount(1)
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: `Close preview of ${name}` }).click()
  }
  expect(await arrived(page)).toEqual([])
  await hostUntouched(page)
})

test('guard scripts off: with the default, nothing in the page runs and static loads are blocked too', async ({
  page,
}) => {
  await openFixture(
    page,
    [
      {
        path: '/static.html',
        html: `<!doctype html><p id="m">before</p><script>document.getElementById('m').textContent = 'ran'</script><img src="x" onerror="document.getElementById('m').textContent = 'onerror'"><img src="${sinkUrl}/hit?static-img"><link rel="stylesheet" href="${sinkUrl}/hit?static-css"><link rel="prefetch" href="${sinkUrl}/hit?static-prefetch"><link rel="preload" as="image" href="${sinkUrl}/hit?static-preload"><video src="${sinkUrl}/hit?static-video" autoplay></video><object data="${sinkUrl}/hit?static-object"></object><iframe src="${sinkUrl}/hit?static-frame"></iframe><style>body { background: url(${sinkUrl}/hit?static-bg) } @import url(${sinkUrl}/hit?static-import);</style>`,
      },
    ],
    false,
  )
  const doc = await preview(page, 'static.html')
  await expect(doc.locator('#m')).toHaveText('before')
  await expect(page.locator('iframe.awr-frame__iframe')).toHaveAttribute('sandbox', '')
  await expect(page.locator('.awr-frame__foot')).toContainText('scripts off')
  expect(await arrived(page)).toEqual([])
  await hostUntouched(page)
})

test('guard chrome: the label and the switch are the host’s; the frame keeps its height whatever the page does', async ({
  page,
}) => {
  await openFixture(
    page,
    [
      {
        path: '/tall.html',
        html: `<!doctype html><body style="margin:0"><div id="m" style="height:5000px;width:5000px">tall</div><script>parent.postMessage({ type: 'resize', height: 5000 }, '*'); top.postMessage({ type: 'resize', height: 5000 }, '*'); document.getElementById('m').textContent = 'ran'</script></body>`,
      },
    ],
    true,
  )
  const doc = await preview(page, 'tall.html')
  await expect(doc.locator('#m')).toHaveText('ran')
  await page.waitForTimeout(300)
  const frame = page.locator('iframe.awr-frame__iframe')
  expect(await frame.evaluate((el) => el.clientHeight)).toBe(300)
  // The host's controls are in the host's document, outside the frame.
  await expect(page.locator('.awr-frame__head')).toContainText('HTML written by the agent')
  await expect(page.locator('.awr-frame__head')).toContainText('sandboxed')
  await expect(page.locator('.awr-frame__head')).toContainText('no network')
  // Source: the page as text, and no frame at all.
  await page.getByRole('button', { name: 'Source' }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('.awr-source')).toContainText("parent.postMessage({ type: 'resize'")
  await expect(page.locator('.awr-frame__head')).toContainText('shown as text, nothing runs')
  await expect(page.locator('.awr-source script')).toHaveCount(0)
  // Taller is the host's button, and its size is the host's number.
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await page.getByRole('button', { name: 'Make the preview taller' }).click()
  expect(await frame.evaluate((el) => el.clientHeight)).toBe(600)
})

// ── the demo: what ships ─────────────────────────────────────────────────────

const openWithKey = async (page: Page) => {
  await page.goto('/')
  await page.getByPlaceholder('AIza…').fill('AIza-test-key')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
}

const send = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

/** Plan two steps, make the tool calls in order (three to a step), then answer. */
const toolCalls = (calls: { name: string; args: Record<string, unknown> }[], answer: string) => {
  let next = 0
  return (c: GeminiCall): GeminiReply => {
    if (c.stage === 'planner') return plan('Write the report and the numbers', 'Write the page')
    if (c.stage === 'replanner') {
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    }
    if (c.stage === 'executor') {
      return c.functionResponses.length < 3 && next < calls.length
        ? { call: calls[next++] }
        : { text: 'Done.' }
    }
    return { text: answer }
  }
}

const REPORT = `# Support tickets, Q3\n\n1,284 tickets were opened, **9% fewer** than in Q2.\n\n## What changed\n\n- Median first reply is 2 h 25 min.\n- Billing questions fell by a third.\n`
const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Tacknote pricing</title>
  <style>body { font: 14px/1.45 Georgia, serif; margin: 24px } .hi { background: #fff3d6 }</style>
</head>
<body>
  <h1 id="h">Tacknote pricing</h1>
  <p id="m">Three plans.</p>
  <script>document.getElementById('m').textContent = 'script ran'; fetch('SINK/hit?demo-fetch').catch(() => {})</script>
  <img src="SINK/hit?demo-img" alt="">
  <a id="go" href="SINK/hit?demo-link">Buy</a>
</body>
</html>
`

test('the files a run wrote are chips under the answer: open, preview, download, and gone when deleted', async ({
  page,
}) => {
  const html = PAGE.replaceAll('SINK', sinkUrl)
  await mockGemini(
    page,
    toolCalls(
      [
        { name: 'fs_write', args: { path: '/q3/report.md', content: 'draft' } },
        { name: 'fs_write', args: { path: '/q3/scratch.txt', content: 'temporary' } },
        { name: 'fs_write', args: { path: '/q3/report.md', content: REPORT } },
        // The second step.
        {
          name: 'fs_write',
          args: { path: '/q3/summary.csv', content: 'month,tickets\nJuly,451\n' },
        },
        { name: 'fs_write', args: { path: '/site/index.html', content: html } },
        { name: 'fs_delete', args: { path: '/q3/scratch.txt' } },
      ],
      'The report, the numbers and the page are attached.',
    ),
  )
  await openWithKey(page)
  await send(page, 'Summarise the tickets and make a pricing page')

  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText(
    'The report, the numbers and the page are attached.',
  )
  // One chip per file: written twice is one, deleted later is none.
  await expect(answer.locator('.awr-filechip__name')).toHaveText([
    'report.md',
    'summary.csv',
    'index.html',
  ])
  await expect(answer.locator('.awr-msg__fileshead')).toContainText('3 files written in this turn')
  await expect(answer.locator('.awr-activity__summary')).toContainText(
    '2 steps · 6 tool calls · 3 files',
  )
  await expect(answer.locator('.awr-filechip__meta').first()).toHaveText(/^Markdown · \d+ B$/)

  // Markdown: rendered by the demo's renderer, and as source.
  await answer.getByRole('button', { name: 'Open report.md' }).click()
  await expect(answer.locator('.awr-fileview__rendered .md-h').first()).toHaveText(
    'Support tickets, Q3',
  )
  await expect(answer.locator('.awr-fileview__rendered strong:not(.md-h)')).toHaveText('9% fewer')
  await answer.getByRole('button', { name: 'Source' }).click()
  await expect(answer.locator('.awr-source')).toContainText('# Support tickets, Q3')

  // CSV: text. One preview at a time.
  await answer.getByRole('button', { name: 'Open summary.csv' }).click()
  await expect(answer.locator('.awr-fileview')).toHaveCount(1)
  await expect(answer.locator('.awr-source')).toContainText('July,451')

  // Download: the file's bytes, under its name.
  const downloading = page.waitForEvent('download')
  await answer.getByRole('button', { name: 'Download summary.csv' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('summary.csv')

  // "Show in Files" opens the panel.
  await answer.getByRole('button', { name: 'Show in Files' }).click()
  await expect(page.locator('.awr-filespanel')).toBeVisible()
  await expect(page.locator('.awr-filelist__path', { hasText: '/site/index.html' })).toBeVisible()
  await page.locator('.awr-chat__files').getByRole('button', { name: 'Close' }).click()

  // HTML: in the sandboxed frame, scripts off, nothing fetched.
  await answer.getByRole('button', { name: 'Open index.html' }).click()
  const outer = answer.locator('iframe.awr-frame__iframe')
  await expect(outer).toHaveAttribute('sandbox', '')
  await expect(outer).not.toHaveAttribute('src', /.*/)
  const doc = page.frameLocator('iframe.awr-frame__iframe').frameLocator('iframe')
  await expect(doc.locator('#h')).toHaveText('Tacknote pricing')
  await expect(doc.locator('#m')).toHaveText('Three plans.')
  await doc.locator('#go').click()
  await expect(answer.locator('.awr-frame__head')).toContainText('HTML written by the agent')
  await expect(answer.locator('.awr-frame__foot')).toContainText('/site/index.html')
  await expect(answer.locator('.awr-frame__foot')).toContainText('scripts off')
  expect(await arrived(page)).toEqual([])
  expect(page.url()).toContain('/demo/')

  // Source: the same file as text.
  await answer.getByRole('button', { name: 'Source' }).click()
  await expect(answer.locator('iframe')).toHaveCount(0)
  await expect(answer.locator('.awr-source')).toContainText('<title>Tacknote pricing</title>')
  await expect(answer.locator('.awr-source__tag').first()).toHaveText('<!doctype')

  // A reload brings the turn back with its chips (the chat is saved; the files are in IndexedDB).
  await page.reload()
  const again = page.locator('.awr-msg--assistant').last()
  await expect(again.locator('.awr-filechip__name')).toHaveText([
    'report.md',
    'summary.csv',
    'index.html',
  ])
  // A file removed afterwards: its chip says so and offers nothing.
  await page.getByRole('button', { name: 'Show files' }).click()
  await page.getByRole('button', { name: 'Delete /q3/summary.csv' }).click()
  await expect(again.locator('.awr-filechip.is-gone .awr-filechip__meta')).toHaveText(
    'no longer in the workspace',
  )
  await expect(again.getByRole('button', { name: 'Open summary.csv' })).toHaveCount(0)
})

test('phone width: chips and previews fit, and every new control is at least 40px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockGemini(
    page,
    toolCalls(
      [
        {
          name: 'fs_write',
          args: { path: '/q3/a-rather-long-file-name-for-a-report.md', content: REPORT },
        },
        {
          name: 'fs_write',
          args: { path: '/site/index.html', content: PAGE.replaceAll('SINK', sinkUrl) },
        },
      ],
      'Two files.',
    ),
  )
  await openWithKey(page)
  await send(page, 'Write two files')
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-filechip')).toHaveCount(2)
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  const atLeast40 = async (selector: string) => {
    for (const box of await answer
      .locator(selector)
      .evaluateAll((els) =>
        els.map((e) => e.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height })),
      )) {
      expect(box.w, selector).toBeGreaterThanOrEqual(40)
      expect(box.h, selector).toBeGreaterThanOrEqual(40)
    }
  }
  expect(await overflow()).toBe(0)
  await atLeast40('.awr-filechip .awr-iconbtn')
  await answer.getByRole('button', { name: /^Open a-rather-long/ }).click()
  await expect(answer.locator('.awr-fileview')).toBeVisible()
  expect(await overflow()).toBe(0)
  await atLeast40('.awr-fileview .awr-iconbtn, .awr-seg__opt')
  for (const view of ['preview', 'source'] as const) {
    if (view === 'preview') await answer.getByRole('button', { name: 'Open index.html' }).click()
    else await answer.getByRole('button', { name: 'Source' }).click()
    await expect(answer.locator('.awr-frame')).toBeVisible()
    expect(await overflow(), view).toBe(0)
    await atLeast40('.awr-frame__btn, .awr-seg__opt, .awr-filechip .awr-iconbtn')
  }
})
