import { expect, test, type Page } from '@playwright/test'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * The pipeline editor at /pipeline/, in a real page: the canvas under a real mouse and a real
 * keyboard, and a pipeline run for real - the core's `createPipeline`, one real agent per node,
 * the real `@ai-sdk/google` provider - with only Gemini's HTTP answers scripted.
 */

// The page is served at the site's root, not under the demo's base (see `pipelinePage` in
// apps/demo/vite.config.ts).
const PIPELINE = '/pipeline/'

const node = (page: Page, id: string) => page.locator(`.awr-canvas__node[data-awr-node="${id}"]`)
const card = (page: Page, id: string) => node(page, id).locator('.awr-pnode')
const edges = (page: Page) => page.locator('button.awr-canvas__edge-handle')

/** The definition as the page saved it. */
const saved = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('agent-web-demo:pipeline') ?? 'null') as {
        nodes: { id: string; name?: string; position?: { x: number; y: number } }[]
        edges: { id?: string; from: string; to: string; when?: { kind: string } }[]
      } | null,
  )

const open = async (page: Page) => {
  await page.goto(PIPELINE)
  await expect(node(page, 'writer')).toBeVisible()
}

test('the page loads: one heading, a proper head, the starter pipeline on the canvas', async ({
  page,
}) => {
  await open(page)
  await expect(page).toHaveTitle('Pipeline editor · dudko.dev agents')
  await expect(page.locator('h1')).toHaveCount(1)
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'https://agent.dudko.dev/pipeline/',
  )
  // Its own card (apps/site/public/og/pipeline.png), with the size and the alt text previews read.
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    'https://agent.dudko.dev/og/pipeline.png',
  )
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute('content', '1200')
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute('content', /\S/)
  await expect(page.locator('.awr-canvas__node')).toHaveCount(3)
  await expect(edges(page)).toHaveCount(3)
  await expect(card(page, 'writer').locator('.awr-pnode__entry')).toHaveText('entry')
  // The reviewer's routes are its output ports; the loop back is an edge like any other.
  await expect(node(page, 'reviewer').locator('[data-awr-port]')).toHaveCount(3)
  await expect(
    page.getByRole('button', { name: 'Connection from Reviewer to Writer: otherwise' }),
  ).toBeVisible()
  // The loop is allowed, and said: a warning, not an error.
  await expect(page.locator('[data-tool="issues"]')).toContainText('1 warning')
  // Back to the demo and to the docs.
  await expect(page.getByRole('link', { name: 'Demo' })).toHaveAttribute('href', '/demo/')
  await expect(page.getByRole('link', { name: 'Docs' })).toHaveAttribute(
    'href',
    '/docs/react/pipeline/',
  )
  // The other examples load, and the canvas shows them whole.
  await page.getByLabel('Example').selectOption('research')
  await expect(page.locator('.awr-canvas__node')).toHaveCount(5)
  await expect(edges(page)).toHaveCount(6)
  await page.getByLabel('Example').selectOption('router')
  await expect(page.locator('.awr-canvas__node')).toHaveCount(4)
  for (const id of ['triage', 'billing', 'technical', 'general']) {
    await expect(node(page, id)).toBeInViewport()
  }
})

test('with the mouse: add a node, drag it, connect it by dragging from its port, edit and delete', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('button', { name: 'Add node' }).click()
  await expect(page.locator('.awr-canvas__node')).toHaveCount(4)
  const added = node(page, 'agent')
  await expect(added).toBeVisible()
  await expect(card(page, 'agent').locator('.awr-pnode__name')).toHaveText('Agent 4')

  // Drag the node by its body: it follows the pointer, snapped to the grid.
  const before = (await saved(page))?.nodes.find((n) => n.id === 'agent')?.position
  const body = (await added.boundingBox())!
  await page.mouse.move(body.x + 40, body.y + 16)
  await page.mouse.down()
  await page.mouse.move(body.x + 40, body.y + 140, { steps: 8 })
  await page.mouse.up()
  await expect
    .poll(async () => (await saved(page))?.nodes.find((n) => n.id === 'agent')?.position?.y)
    .toBeGreaterThan((before?.y ?? 0) + 60)
  const moved = (await saved(page))!.nodes.find((n) => n.id === 'agent')!.position!
  expect(moved.x % 20).toBe(0)
  expect(moved.y % 20).toBe(0)

  // Drag from its output port onto the Writer: an edge.
  const port = (await added.locator('[data-awr-port="out"]').boundingBox())!
  const target = (await node(page, 'writer').boundingBox())!
  await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
  await expect(page.locator('.awr-canvas__edge-draft')).toHaveCount(1)
  await page.mouse.up()
  await expect(edges(page)).toHaveCount(4)
  const edge = page.getByRole('button', { name: 'Connection from Agent 4 to Writer' })
  await expect(edge).toBeVisible()
  // The new connection is selected, and the inspector edits it.
  await expect(page.locator('.awr-pipeline__inspector-kind')).toHaveText('Connection')
  await page.getByLabel('Fires').selectOption('contains')
  await page.getByLabel('Text', { exact: true }).fill('DONE')
  await expect(
    page.getByRole('button', { name: 'Connection from Agent 4 to Writer: contains “DONE”' }),
  ).toBeVisible()

  // Dragging from a route port makes an edge on that route.
  const route = (await node(page, 'reviewer')
    .locator('[data-awr-port="route:revise"]')
    .boundingBox())!
  const agent = (await added.boundingBox())!
  await page.mouse.move(route.x + route.width / 2, route.y + route.height / 2)
  await page.mouse.down()
  await page.mouse.move(agent.x + agent.width / 2, agent.y + agent.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(
    page.getByRole('button', { name: 'Connection from Reviewer to Agent 4: revise' }),
  ).toBeVisible()
  await expect
    .poll(async () => (await saved(page))?.edges.map((e) => `${e.from}>${e.to}:${e.when?.kind}`))
    .toEqual([
      'writer>reviewer:undefined',
      'reviewer>publisher:route',
      'reviewer>writer:otherwise',
      'agent>writer:contains',
      'reviewer>agent:route',
    ])

  // Click the node, rename it in the inspector, delete it from the toolbar: its edges go too.
  await added.click({ position: { x: 30, y: 12 } })
  await expect(page.locator('.awr-pipeline__inspector-kind')).toHaveText('Node')
  await page.getByLabel('Name', { exact: true }).fill('Fact checker')
  await expect(card(page, 'agent').locator('.awr-pnode__name')).toHaveText('Fact checker')
  await page.getByRole('toolbar').getByRole('button', { name: 'Delete' }).click()
  await expect(page.locator('.awr-canvas__node')).toHaveCount(3)
  await expect(edges(page)).toHaveCount(3)
})

test('with the keyboard: add a node, move it, connect it, open it, delete it', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Add node' }).focus()
  await page.keyboard.press('Enter')
  // The new node has the focus.
  const added = node(page, 'agent')
  await expect(added).toBeFocused()

  // Arrow keys move it one grid step; with Shift, five.
  const at = async () => (await saved(page))?.nodes.find((n) => n.id === 'agent')?.position
  await expect.poll(at).toBeTruthy()
  const start = (await at())!
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect.poll(at).toEqual({ x: start.x + 20, y: start.y + 120 })
  await expect(added).toBeFocused()

  // C starts a connection; Tab to the target; Enter makes it.
  await page.keyboard.press('c')
  await expect(page.locator('.awr-canvas__hint')).toContainText(
    'Pick the node to connect Agent 4 to',
  )
  for (let i = 0; i < 40; i++) {
    if (await node(page, 'writer').evaluate((el) => el === document.activeElement)) break
    await page.keyboard.press('Shift+Tab')
  }
  await expect(node(page, 'writer')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('.awr-canvas__hint')).toHaveCount(0)
  await expect(edges(page)).toHaveCount(4)
  await expect(
    page.getByRole('button', { name: 'Connection from Agent 4 to Writer' }),
  ).toBeVisible()

  // The same from a port: Enter on a route port, Enter on the target.
  const approved = node(page, 'reviewer').locator('[data-awr-port="route:approved"]')
  await approved.focus()
  await page.keyboard.press('Enter')
  await expect(approved).toHaveAttribute('aria-pressed', 'true')
  await added.focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('button', { name: 'Connection from Reviewer to Agent 4: approved' }),
  ).toBeVisible()

  // Escape cancels a connection that was started.
  await page.keyboard.press('c')
  await expect(page.locator('.awr-canvas__hint')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.awr-canvas__hint')).toHaveCount(0)
  await expect(edges(page)).toHaveCount(5)

  // Tab from a node reaches the connections that leave it; Delete removes the one in focus.
  const edge = page.getByRole('button', { name: 'Connection from Agent 4 to Writer' })
  await edge.focus()
  await page.keyboard.press('Delete')
  await expect(edges(page)).toHaveCount(4)

  // Enter on a node opens it in the inspector, with the first field focused.
  await added.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Name', { exact: true })).toBeFocused()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Agent 4')

  // Delete on the node removes it, and the connection into it.
  await added.focus()
  await page.keyboard.press('Delete')
  await expect(page.locator('.awr-canvas__node')).toHaveCount(3)
  await expect(edges(page)).toHaveCount(3)
  // The focus is not lost to the page: it stays on the canvas.
  await expect(page.locator('.awr-canvas')).toBeFocused()
})

test('the definition survives a reload, and so does the choice between an example and your own', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('button', { name: 'Add node' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Fact checker')
  await expect(page.locator('.awr-canvas__node')).toHaveCount(4)
  // Straight away: the save is delayed while typing, but leaving the page must not lose it.
  await page.reload()
  await expect(page.locator('.awr-canvas__node')).toHaveCount(4)
  await expect(card(page, 'agent').locator('.awr-pnode__name')).toHaveText('Fact checker')
  await expect(page.getByLabel('Example')).toHaveValue('mine')

  // Another example does not throw the visitor's own pipeline away.
  await page.getByLabel('Example').selectOption('router')
  await expect(node(page, 'triage')).toBeVisible()
  await expect(page.locator('.awr-canvas__node')).toHaveCount(4)
  await page.reload()
  await expect(node(page, 'triage')).toBeVisible()
  await page.getByLabel('Example').selectOption('mine')
  await expect(card(page, 'agent').locator('.awr-pnode__name')).toHaveText('Fact checker')
})

// Which node's agent a request belongs to: its instructions are in the system prompt.
const nodeOf = (c: GeminiCall): 'writer' | 'reviewer' | 'publisher' | undefined => {
  const text = `${c.system}\n${c.user}`
  if (c.system.includes('Write the text the request asks for')) return 'writer'
  if (c.system.includes('Review the text against the request')) return 'reviewer'
  if (c.system.includes('Format the approved text for publication')) return 'publisher'
  if (text.includes('Step: Reviewer')) return 'reviewer'
  return undefined
}

test('a run lights the nodes up in order, takes the route, loops once and shows the result', async ({
  page,
}) => {
  let reviews = 0
  const ANSWER: Record<string, (n: number) => string> = {
    writer: (n) => (n === 1 ? 'Draft one.' : 'Draft two, with the notes taken in.'),
    reviewer: (n) => (n === 1 ? 'Too thin. Say what changed.' : 'Ready.'),
    publisher: () => '# Pipelines\n\nDraft two, **published**.',
  }
  const visits: Record<string, number> = {}
  const calls = await mockGemini(page, (c: GeminiCall): GeminiReply => {
    const who = nodeOf(c)
    // The small call that picks the reviewer's route: revise first, approved the second time.
    if (c.system.includes('Router of one step')) {
      reviews++
      return { text: JSON.stringify({ route: reviews === 1 ? 'revise' : 'approved' }) }
    }
    if (!who) return { text: 'ok' }
    if (c.stage === 'planner') {
      visits[who] = (visits[who] ?? 0) + 1
      // Slow enough to see the node running.
      return { ...plan('Do the work'), delayMs: 500 }
    }
    if (c.stage === 'replanner') {
      return { text: JSON.stringify({ decision: 'finish', reason: 'done' }) }
    }
    if (c.stage === 'synthesizer') return { text: ANSWER[who](visits[who]) }
    return { text: 'Worked on it.' }
  })

  await open(page)
  await page.getByPlaceholder('AIza…').fill('AIza-test-key')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.settings__summary-status').first()).toHaveText('key stored ✓')

  await page.getByRole('textbox', { name: 'Request' }).fill('A release note for v2')
  await page.getByRole('button', { name: 'Run', exact: true }).click()

  // In order: the writer, then the reviewer (the writer done), then - the reviewer said
  // "revise" - the writer again, the reviewer again, and only then the publisher.
  await expect(card(page, 'writer')).toHaveAttribute('data-status', 'running')
  await expect(card(page, 'reviewer')).toHaveAttribute('data-status', 'idle')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()

  await expect(card(page, 'reviewer')).toHaveAttribute('data-status', 'running')
  await expect(card(page, 'writer')).toHaveAttribute('data-status', 'done')
  await expect(card(page, 'publisher')).toHaveAttribute('data-status', 'idle')

  // The loop: the writer runs a second time, and its card counts the visits.
  await expect(card(page, 'writer').locator('.awr-pnode__visits')).toHaveText('×2')
  await expect(card(page, 'publisher')).toHaveAttribute('data-status', 'running')
  await expect(card(page, 'reviewer')).toHaveAttribute('data-status', 'done')
  await expect(card(page, 'reviewer').locator('.awr-pnode__visits')).toHaveText('×2')
  // The edge that led here is the one in flight.
  await expect(
    page.getByRole('button', { name: 'Connection from Reviewer to Publisher: approved' }),
  ).toHaveClass(/awr-canvas__edge-handle--active/)

  // Finished: every node done, the answer rendered (Markdown), each visit listed in order.
  await expect(page.locator('.awr-presults__status')).toHaveText('Finished')
  for (const id of ['writer', 'reviewer', 'publisher']) {
    await expect(card(page, id)).toHaveAttribute('data-status', 'done')
  }
  const final = page.locator('.awr-presults__final')
  await expect(final).toContainText('Draft two, published.')
  await expect(final.locator('strong:not(.md-h)')).toHaveText('published')
  await expect(page.locator('.awr-pvisit__name')).toHaveText([
    'Writer',
    'Reviewer',
    'Writer · visit 2',
    'Reviewer · visit 2',
    'Publisher',
  ])
  await expect(page.locator('.awr-pvisit__route')).toHaveText(['route: revise', 'route: approved'])
  await expect(page.locator('.awr-presults__summary')).toContainText('5 node runs')
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible()
  // Every edge fired at some point of this run.
  await expect(page.locator('button.awr-canvas__edge-handle--done')).toHaveCount(3)

  // What the model was sent: the second writer got the reviewer's notes, by name.
  const second = calls.filter((c) => nodeOf(c) === 'writer' && c.stage === 'planner')[1]
  expect(second.user).toContain('Output of "Reviewer":\nToo thin. Say what changed.')
  expect(second.user).toContain('A release note for v2')
  // And the publisher got the approved draft.
  const published = calls.find((c) => nodeOf(c) === 'publisher' && c.stage === 'planner')!
  expect(published.user).toContain('Output of "Reviewer":\nReady.')
})

test('a run can be stopped, and a node that fails says why', async ({ page }) => {
  let fail = false
  await mockGemini(page, (c: GeminiCall): GeminiReply => {
    if (fail) return { error: { status: 429, message: 'Quota exceeded for this key.' } }
    if (c.stage === 'planner') return { ...plan('Do the work'), delayMs: 1500 }
    return { text: 'ok' }
  })
  await open(page)
  await page.getByPlaceholder('AIza…').fill('AIza-test-key')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.settings__summary-status').first()).toHaveText('key stored ✓')

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(card(page, 'writer')).toHaveAttribute('data-status', 'running')
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.awr-presults__status')).toHaveText('Stopped')
  await expect(card(page, 'writer')).toHaveAttribute('data-status', 'idle')
  await expect(page.locator('.awr-presults__note')).toHaveText('Stopped before it finished.')

  fail = true
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.awr-presults__status')).toHaveText('Failed', { timeout: 30_000 })
  await expect(card(page, 'writer')).toHaveAttribute('data-status', 'failed')
  await expect(page.locator('.awr-presults__error').first()).toContainText('Writer: ')
  await expect(card(page, 'reviewer')).toHaveAttribute('data-status', 'idle')
})

test('import, export and copy as code', async ({ page }) => {
  await open(page)
  // Export: the definition as a file.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export JSON' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('write-review-publish.json')

  // Import: a definition without positions or edge ids is laid out and shown whole.
  await page.locator('.awr-pipeline input[type=file]').setInputFiles({
    name: 'mine.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'Imported',
        entry: 'a',
        nodes: [
          { id: 'a', name: 'First' },
          { id: 'b', name: 'Second', tools: ['files'] },
        ],
        edges: [{ from: 'a', to: 'b', when: { kind: 'contains', text: 'go' } }],
      }),
    ),
  })
  await expect(page.locator('.awr-canvas__node')).toHaveCount(2)
  await expect(node(page, 'a')).toBeInViewport()
  await expect(node(page, 'b')).toBeInViewport()
  await expect(
    page.getByRole('button', { name: 'Connection from First to Second: contains “go”' }),
  ).toBeVisible()
  await expect(page.locator('[data-tool="issues"]')).toContainText('No issues')

  // A file that is not a pipeline is refused, in words, and nothing is lost.
  await page.locator('.awr-pipeline input[type=file]').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"hello": "world"}'),
  })
  await expect(page.locator('.awr-pipeline__notice')).toContainText('Could not import')
  await expect(page.locator('.awr-canvas__node')).toHaveCount(2)

  // An invalid definition is flagged; the issue leads to what it is about.
  await node(page, 'b').click({ position: { x: 30, y: 12 } })
  await page.getByRole('button', { name: 'Make it the entry' }).click()
  await page.locator('[data-tool="issues"]').click()
  const issue = page.locator('.awr-pissue').first()
  await expect(issue).toContainText('cannot be reached')
  await issue.click()
  await expect(node(page, 'a')).toBeFocused()
  await expect(page.locator('.awr-pipeline__inspector-name')).toHaveText('First')

  // Copy as code: a snippet for the browser package and one for Node.
  await page.getByRole('button', { name: 'Copy as code' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('pre')).toContainText("from '@dudko.dev/agent-web'")
  await expect(dialog.locator('pre')).toContainText('tools: { files: filesTools }')
  await dialog.getByRole('tab', { name: 'Node' }).click()
  await expect(dialog.locator('pre')).toContainText("from '@dudko.dev/agent'")
  await expect(dialog.locator('pre')).toContainText('await pipeline.close()')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "import { createPipeline, nodeResolver } from '@dudko.dev/agent'",
  )
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('the keys, the model and the MCP servers are the demo’s: one origin, one vault', async ({
  page,
}) => {
  // A key saved in the demo...
  await page.goto('/demo/')
  await page.getByPlaceholder('AIza…').fill('AIza-test-key')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  // ...and the way from the demo to the editor.
  await page.getByRole('link', { name: 'Pipeline' }).click()
  await expect(page).toHaveURL(/\/pipeline\/$/)
  // ...is the key here: the model is ready, nothing to enter.
  await expect(page.locator('.settings__summary-status').first()).toHaveText('key stored ✓')
  // A node may name any model whose key is in the vault.
  await node(page, 'writer').click({ position: { x: 30, y: 12 } })
  const models = page.getByLabel('Model', { exact: true }).last()
  await expect(models.locator('option').first()).toHaveText('default model')
  expect(await models.locator('option').count()).toBeGreaterThan(1)
  // The model chosen here is the model chosen there.
  await page.locator('.settings__summary').first().click()
  await page.locator('.settings select').first().selectOption('google-pro')
  await page.getByRole('link', { name: 'Demo' }).click()
  await expect(page).toHaveURL(/\/demo\/$/)
  await expect(page.locator('.settings__summary-value').first()).toContainText('Pro')
})

test('a node gets the capabilities it ticks - and the tiers and the decision model of the demo - and no other node does', async ({
  page,
}) => {
  const calls = await mockGemini(
    page,
    (c: GeminiCall): GeminiReply => {
      if (c.system.includes('Router of one step')) {
        return { text: JSON.stringify({ route: 'ROUTER-MODEL-WAS-ASKED' }) }
      }
      if (c.stage === 'planner') {
        return {
          text: JSON.stringify({
            thought: 'One hard step.',
            steps: [{ description: 'Work it out', complexity: 'high' }],
          }),
        }
      }
      if (c.stage === 'synthesizer') return { text: 'An answer.' }
      return { text: 'Worked on it.' }
    },
    // The route is a closed question: the decision model answers it.
    {
      decide: (q) => ({
        choice: q.options.includes('second') ? 'second' : q.options[0],
        confidence: 0.97,
      }),
    },
  )
  await open(page)
  await page.getByPlaceholder('AIza…').fill('AIza-test-key')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.settings__summary-status').first()).toHaveText('key stored ✓')

  await page.locator('.awr-pipeline input[type=file]').setInputFiles({
    name: 'caps.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        name: 'Capabilities',
        entry: 'a',
        nodes: [
          {
            id: 'a',
            name: 'Coder',
            instructions: 'NODE-A works with code.',
            tools: ['code', 'web'],
            routes: [
              { label: 'second', description: 'Hand over to the second node' },
              { label: 'stop', description: 'Nothing more to do' },
            ],
          },
          { id: 'b', name: 'Plain', instructions: 'NODE-B only writes.' },
        ],
        edges: [{ from: 'a', to: 'b', when: { kind: 'route', label: 'second' } }],
      }),
    ),
  })
  await expect(page.locator('.awr-canvas__node')).toHaveCount(2)

  // The inspector offers the capabilities as things a node can tick, and says what each is.
  await node(page, 'a').click({ position: { x: 30, y: 12 } })
  await expect(page.getByLabel('Run code')).toBeChecked()
  await expect(page.getByLabel('Web pages')).toBeChecked()
  await expect(page.getByLabel('Helpers')).not.toBeChecked()
  await expect(page.getByLabel('Media')).not.toBeChecked()

  await page.getByRole('textbox', { name: 'Request' }).fill('Do the thing')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.awr-presults__status')).toHaveText('Finished', { timeout: 30_000 })
  await expect(page.locator('.awr-pvisit__name')).toHaveText(['Coder', 'Plain'])

  const executorOf = (marker: string) =>
    calls.filter((c) => c.stage === 'executor' && c.system.includes(marker))
  const a = executorOf('NODE-A')
  const b = executorOf('NODE-B')
  expect(a.length).toBeGreaterThan(0)
  expect(b.length).toBeGreaterThan(0)
  // The ticked node has run_js and web_fetch; nobody has what nobody ticked.
  expect(a[0].tools).toEqual(expect.arrayContaining(['run_js', 'web_fetch']))
  expect(a[0].tools).not.toContain('spawn_subagent')
  expect(a[0].tools).not.toContain('generate_image')
  for (const tool of ['run_js', 'web_fetch', 'spawn_subagent', 'generate_image', 'web_search']) {
    expect(b[0].tools).not.toContain(tool)
  }
  // Model tiers reach every node: the step rated hard ran on the provider's strongest model.
  expect(a[0].model).toBe('gemini-3.1-pro-preview')
  expect(b[0].model).toBe('gemini-3.1-pro-preview')
  // The route was the decision model's: the router call of the language model never ran.
  expect(calls.decisions.some((d) => d.options.includes('second'))).toBe(true)
  expect(calls.filter((c) => c.system.includes('Router of one step'))).toHaveLength(0)
  await expect(page.locator('.awr-pvisit__route')).toHaveText(['route: second'])
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  const noSidewaysScroll = async (page: Page) => {
    const [scroll, client] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ])
    expect(scroll, 'no sideways scroll').toBe(client)
  }

  test('no sideways scroll, the inspector is a bottom sheet, the main actions are 44px', async ({
    page,
  }) => {
    await open(page)
    await noSidewaysScroll(page)
    await expect(page.locator('.awr-pipeline')).toHaveClass(/awr-pipeline--narrow/)
    // A graph wider than a phone is shown from its entry at a readable size, not whole and tiny...
    await expect(node(page, 'writer')).toBeInViewport({ ratio: 0.99 })
    expect((await node(page, 'writer').boundingBox())!.width).toBeGreaterThan(160)
    await expect(node(page, 'publisher')).not.toBeInViewport()
    // ...and Fit shows all of it.
    await page.getByRole('button', { name: 'Fit' }).tap()
    for (const id of ['writer', 'reviewer', 'publisher']) {
      await expect(node(page, id)).toBeInViewport({ ratio: 0.99 })
    }

    for (const control of [
      page.getByRole('button', { name: 'Add node' }),
      page.getByRole('toolbar').getByRole('button', { name: 'Delete' }),
      page.getByRole('button', { name: 'Fit' }),
      page.getByRole('button', { name: 'Run', exact: true }),
      page.getByRole('textbox', { name: 'Request' }),
      page.getByLabel('Example'),
    ]) {
      const box = (await control.boundingBox())!
      expect(
        box.height,
        await control.evaluate((el) => el.outerHTML.slice(0, 80)),
      ).toBeGreaterThanOrEqual(44)
    }
    expect(
      (await page.getByRole('button', { name: 'Add node' }).boundingBox())!.width,
    ).toBeGreaterThanOrEqual(44)

    // A tap selects a node: the sheet names it, folded; a tap on the bar opens it.
    await node(page, 'reviewer').tap({ position: { x: 30, y: 12 } })
    const sheet = page.locator('.awr-pipeline__inspector')
    await expect(sheet.locator('.awr-pipeline__inspector-name')).toHaveText('Reviewer')
    await expect(sheet).not.toHaveClass(/is-open/)
    expect((await sheet.boundingBox())!.height).toBeLessThan(60)
    await sheet.getByRole('button', { name: 'Show details' }).tap()
    await expect(sheet).toHaveClass(/is-open/)
    await expect(page.getByLabel('Instructions')).toBeVisible()
    // It slides up: wait for it to arrive.
    await expect.poll(async () => (await sheet.boundingBox())!.height).toBeGreaterThan(200)
    const opened = (await sheet.boundingBox())!
    expect(opened.x).toBeLessThanOrEqual(13)
    expect(opened.width).toBeGreaterThan(360)
    await noSidewaysScroll(page)
    await sheet.getByRole('button', { name: 'Hide details' }).tap()
    await expect(sheet).not.toHaveClass(/is-open/)

    // Tap a port, then a node: a connection without dragging.
    await page.getByRole('button', { name: 'Add node' }).tap()
    await node(page, 'agent').locator('[data-awr-port="out"]').tap()
    await expect(page.locator('.awr-canvas__hint')).toBeVisible()
    await node(page, 'writer').tap({ position: { x: 30, y: 12 } })
    await expect(
      page.getByRole('button', { name: 'Connection from Agent 4 to Writer' }),
    ).toHaveCount(1)
    await noSidewaysScroll(page)
  })

  test('one finger pans the canvas and two zoom it, and the page neither scrolls nor zooms', async ({
    page,
  }) => {
    await open(page)
    const canvas = page.locator('.awr-canvas')
    expect(await canvas.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none')
    const box = (await canvas.boundingBox())!
    const start = (await node(page, 'writer').boundingBox())!
    const client = await page.context().newCDPSession(page)
    const touch = (type: string, points: { x: number; y: number; id: number }[]) =>
      client.send('Input.dispatchTouchEvent', {
        type: type as 'touchStart',
        touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })),
      })
    // One finger on the background (the top strip of the canvas has no node): a pan.
    const x = box.x + box.width / 2
    const y = box.y + 30
    await touch('touchStart', [{ x, y, id: 1 }])
    for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: x + i * 10, y: y + i * 15, id: 1 }])
    await touch('touchEnd', [])
    const panned = (await node(page, 'writer').boundingBox())!
    expect(panned.x - start.x).toBeGreaterThan(40)
    expect(panned.y - start.y).toBeGreaterThan(60)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)

    // Two fingers moving apart: the canvas zooms in, the page's own zoom stays 1.
    const cy = box.y + box.height / 2
    await touch('touchStart', [
      { x: x - 30, y: cy, id: 1 },
      { x: x + 30, y: cy, id: 2 },
    ])
    for (let i = 1; i <= 6; i++) {
      await touch('touchMove', [
        { x: x - 30 - i * 12, y: cy, id: 1 },
        { x: x + 30 + i * 12, y: cy, id: 2 },
      ])
    }
    await touch('touchEnd', [])
    const zoomed = (await node(page, 'writer').boundingBox())!
    expect(zoomed.width).toBeGreaterThan(panned.width * 1.5)
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
    expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0])
    await noSidewaysScroll(page)
  })

  test('the demo and its new link fit a phone too', async ({ page }) => {
    await page.goto('/demo/')
    await expect(page.getByRole('link', { name: 'Pipeline' })).toBeVisible()
    await noSidewaysScroll(page)
  })
})
