// The social cards (og:image) of agent.dudko.dev, drawn from source:
//
//   scripts/og-card.html  the card: layout and type, colours from src/styles/tokens.css, the logo
//                         from src/assets/mark.svg
//   apps/site/dist        for /demo/ and /pipeline/: a strip of the page itself, as the built site
//                         serves it, rendered by a real browser
//
//   pnpm nx build site && pnpm --filter site og-cards [--out <dir>]
//
// Writes public/og.png (the landing page, the licence and the docs), public/og/demo.png and
// public/og/pipeline.png: 1200×630 PNGs. Run it by hand when a card's words, the logo, the tokens
// or the look of those two pages change, and commit the PNGs. It is not part of the build on
// purpose: it needs Chromium and the Inter font, which the Cloudflare build has neither of, and a
// build must not depend on a browser. Platforms cache a card by its URL for days: after changing
// one, ask the owner to re-scrape it (or give the file a new name).
//
// The two pages are shown in use. A dummy key is saved and the model's answers are scripted here,
// by intercepting the page's requests to the Gemini API - no key, no network, the same picture on
// every run. Everything else is the real built page: the agent loop, its tools, the sticky-notes
// board, the pipeline canvas and its run. Any other request leaving the page is refused.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const dist = resolve(here, '../dist')
const TEMPLATE = resolve(here, 'og-card.html')
const argOut = process.argv.indexOf('--out')
const out = argOut > 0 ? resolve(process.argv[argOut + 1]) : resolve(here, '../public')

// Some sandboxes ship a Chromium older than this Playwright's pinned build (the same fallback as
// the React package's playwright.config.ts). Elsewhere: `pnpm --filter site exec playwright
// install chromium`, or point CHROME_PATH at a Chrome.
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium'
const executablePath =
  process.env.CHROME_PATH ?? (existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined)

// ---------- the built site, served as the host serves it ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

const serve = () =>
  new Promise((done) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      const file = join(dist, path.endsWith('/') ? `${path}index.html` : path)
      if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(readFileSync(file))
    })
    server.listen(0, '127.0.0.1', () => done(server))
  })

// ---------- the scripted model ----------

const json = (body) => ({
  status: 200,
  headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
})

/**
 * Answer the page's Gemini requests with `answer(call)`: the text of the model's reply, or the
 * function calls it makes ({ name, args }, one or several). `call` is { stage, system, done }: the
 * stage by the role marker in the system prompt, and how many tool results the conversation holds.
 */
const scriptGemini = async (page, answer) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' || url.protocol === 'data:' || url.protocol === 'blob:') {
      return route.fallback()
    }
    if (url.hostname !== 'generativelanguage.googleapis.com') return route.abort()
    const body = route.request().postDataJSON() ?? {}
    // The decision model: unsure, so the scripted route below decides, as without one.
    if (url.pathname.endsWith('/decisions')) {
      const answers = {}
      for (const [id, question] of Object.entries(body.questions ?? {})) {
        const options = Object.keys(question.criteria ?? {})
        const p = 1 / options.length
        answers[id] = {
          type: 'choice',
          choice: options[0],
          confidence: p,
          probabilities: Object.fromEntries(options.map((o) => [o, p])),
        }
      }
      return route.fulfill(json({ answers, usage: { total_input_tokens: 100 } }))
    }
    const system = (body.systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('\n')
    const parts = (body.contents ?? []).flatMap((c) => c.parts ?? [])
    const call = {
      stage: /REPLANNER/.test(system)
        ? 'replanner'
        : /PLANNER/.test(system)
          ? 'planner'
          : /EXECUTOR/.test(system)
            ? 'executor'
            : /SYNTHESIZER/.test(system)
              ? 'synthesizer'
              : 'other',
      system,
      done: parts.filter((p) => p.functionResponse).length,
    }
    return Promise.resolve(answer(call)).then((reply) => {
      const content = {
        role: 'model',
        parts:
          typeof reply === 'string'
            ? [{ text: reply }]
            : [reply].flat().map((functionCall) => ({ functionCall })),
      }
      const chunk = {
        candidates: [{ content, finishReason: 'STOP', index: 0 }],
        usageMetadata: {
          promptTokenCount: 1840,
          candidatesTokenCount: 96,
          cachedContentTokenCount: 1200,
          totalTokenCount: 1936,
        },
      }
      const streaming = url.pathname.includes(':streamGenerateContent')
      return route
        .fulfill({
          status: 200,
          headers: {
            'content-type': streaming ? 'text/event-stream' : 'application/json',
            'access-control-allow-origin': '*',
          },
          body: streaming ? `data: ${JSON.stringify(chunk)}\r\n\r\n` : JSON.stringify(chunk),
        })
        .catch(() => {}) // the page went away mid-answer (the shot is taken mid-run)
    })
  })
}

// A whole run with a scripted model takes a few seconds; a busy machine (a test suite next to it)
// can take many times that.
const RUN_TIMEOUT = 120_000

const plan = (description) => JSON.stringify({ thought: 'On it.', steps: [{ description }] })

/** Save a dummy Gemini key, as a visitor does: the requests it signs are answered above. */
const saveKey = async (page) => {
  await page.getByPlaceholder('AIza…').fill('AIza-og-card')
  await page.getByRole('button', { name: 'Save' }).click()
}

// ---------- the two pages, in use ----------

/** /demo/: a request on the sticky-notes tab, the agent's tool calls and the board they filled. */
const NOTES = [
  { text: 'Freeze the v2 API', color: 'yellow' },
  { text: 'Fix the login bug before launch', color: 'red' },
  { text: 'Write the release notes', color: 'blue' },
  { text: 'Record a 2-minute demo', color: 'green' },
  { text: 'Announce on the blog', color: 'purple' },
  { text: 'Ask beta users for feedback', color: 'pink' },
]
const shootDemo = async (browser, origin) => {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 760 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  })
  await scriptGemini(page, (c) => {
    if (c.stage === 'planner') return plan('Put the launch checklist on the board, urgent in red')
    // Three notes per answer: one step, two rounds of tool calls.
    if (c.stage === 'executor') {
      const next = NOTES.slice(c.done, c.done + 3)
      return next.length ? next.map((args) => ({ name: 'add_note', args })) : 'Six notes added.'
    }
    if (c.stage === 'replanner') return JSON.stringify({ decision: 'finish', reason: 'done' })
    return 'Your launch checklist is on the board: six notes, and the urgent one - the login bug - in red.'
  })
  await page.goto(`${origin}/demo/`)
  await saveKey(page)
  await page
    .getByRole('textbox', { name: 'Message' })
    .fill('Put our launch checklist on the board. Make the urgent one red.')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.locator('.board').getByText(NOTES.at(-1).text).waitFor({ timeout: RUN_TIMEOUT })
  await page
    .locator('.awr-msg--assistant .awr-msg__bubble')
    .last()
    .waitFor({ timeout: RUN_TIMEOUT })
  await page.locator('.awr-msg--assistant .awr-activity__summary').last().click()
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(0, 0)
  // The top of the page, margins included: the tabs, the model with its key, the chat and the board.
  const shot = await page.screenshot({
    clip: { x: 0, y: 0, width: 1200, height: 400 },
    animations: 'disabled',
  })
  await page.close()
  return shot
}

/** /pipeline/: the starter pipeline mid-run - writer and reviewer done twice, publisher at work. */
const shootPipeline = async (browser, origin) => {
  // Wide enough for the canvas to show the graph at full size, loop and all.
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  })
  let reviews = 0
  let release
  const publishing = new Promise((r) => (release = r))
  const ANSWERS = {
    writer: ['Draft one.', 'Draft two, with the notes taken in.'],
    reviewer: ['Too thin: say what changed.', 'Ready.'],
    publisher: ['# Pipelines\n\nDraft two, published.'],
  }
  const visits = {}
  await scriptGemini(page, async (c) => {
    // The small call that picks the reviewer's route: revise first, approved the second time.
    if (c.system.includes('Router of one step')) {
      reviews++
      return JSON.stringify({ route: reviews === 1 ? 'revise' : 'approved' })
    }
    const who = c.system.includes('Write the text the request asks for')
      ? 'writer'
      : c.system.includes('Review the text against the request')
        ? 'reviewer'
        : c.system.includes('Format the approved text for publication')
          ? 'publisher'
          : undefined
    if (!who) return 'ok'
    if (c.stage === 'planner') {
      visits[who] = (visits[who] ?? 0) + 1
      // Hold the publisher at work: the shot is taken while it runs.
      if (who === 'publisher') await publishing
      return plan('Do the work')
    }
    if (c.stage === 'replanner') return JSON.stringify({ decision: 'finish', reason: 'done' })
    if (c.stage === 'synthesizer') return ANSWERS[who][(visits[who] ?? 1) - 1] ?? 'Done.'
    return 'Worked on it.'
  })
  await page.goto(`${origin}/pipeline/`)
  await saveKey(page)
  await page
    .getByRole('textbox', { name: 'Request' })
    .fill('A release note for v2: pipelines, a graph of agents with conditions and loops')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await page
    .locator('.awr-canvas__node[data-awr-node="publisher"] .awr-pnode[data-status="running"]')
    .waitFor({ timeout: RUN_TIMEOUT })
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(0, 0)
  // The editor from its toolbar to the bottom of the canvas, margins included.
  const editor = await page.locator('.awr-pipeline').boundingBox()
  const stage = await page.locator('.awr-pipeline__stage').boundingBox()
  const top = editor.y - 8
  const shot = await page.screenshot({
    clip: { x: 0, y: top, width: 1440, height: stage.y + stage.height + 10 - top },
    animations: 'disabled',
  })
  release()
  await page.close()
  return shot
}

// ---------- the cards ----------

const CARDS = [
  { file: 'og.png', layout: 'home' },
  {
    file: 'og/demo.png',
    layout: 'page',
    title: 'Live demo',
    line: 'An agent in your browser tab, with your key or a local model.',
    url: 'agent.dudko.dev/demo',
    shoot: shootDemo,
    scale: 0.94,
  },
  {
    file: 'og/pipeline.png',
    layout: 'page',
    title: 'Pipeline editor',
    line: 'Draw a graph of agents, then run it in your browser.',
    url: 'agent.dudko.dev/pipeline',
    shoot: shootPipeline,
    scale: 0.9,
  },
]

if (!existsSync(join(dist, 'demo/index.html')) || !existsSync(join(dist, 'pipeline/index.html'))) {
  throw new Error(`the site is not built (${dist}): run \`pnpm nx build site\` first`)
}

const server = await serve()
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch(executablePath ? { executablePath } : {})
try {
  for (const card of CARDS) {
    const shot = card.shoot ? await card.shoot(browser, origin) : null
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
    await page.goto(pathToFileURL(TEMPLATE).href)
    await page.evaluate(() => document.fonts.ready)
    // The cards are drawn in Inter, as the first one was. Without it the browser falls back to
    // another face and every card changes: refuse rather than write that.
    const inter = await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d')
      const width = (font) => ((ctx.font = font), ctx.measureText('agents · dudko.dev').width)
      return width('700 64px Inter, monospace') !== width('700 64px monospace')
    })
    if (!inter) throw new Error('the Inter font is not installed (fonts-inter, or rsms.me/inter)')
    if (card.layout === 'page') {
      await page.evaluate(
        ({ title, line, url, src, scale }) => {
          document.getElementById('home').hidden = true
          document.getElementById('page').hidden = false
          document.getElementById('page-title').textContent = title
          document.getElementById('page-line').textContent = line
          document.getElementById('page-url').textContent = url
          const img = document.getElementById('page-shot')
          return new Promise((done) => {
            img.onload = () => {
              // The shot is taken at 2x: shown at `scale` of its CSS size.
              img.style.width = `${(img.naturalWidth / 2) * scale}px`
              done()
            }
            img.src = src
          })
        },
        { ...card, shoot: undefined, src: `data:image/png;base64,${shot.toString('base64')}` },
      )
    }
    const png = await page.screenshot({ type: 'png' })
    await page.close()
    // A palette PNG: a card is a few flat colours and type, and must stay light for the crawlers
    // that fetch it (under 150 KB here; previewers give up on large ones).
    const small = await sharp(png).png({ palette: true, colors: 256, effort: 10 }).toBuffer()
    const target = join(out, card.file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, small)
    console.log(`${card.file.padEnd(16)} 1200×630  ${(small.length / 1024).toFixed(1)} KB`)
  }
} finally {
  await browser.close()
  server.close()
}
