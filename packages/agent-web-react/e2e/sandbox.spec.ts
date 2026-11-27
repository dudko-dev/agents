import { expect, test, type Page } from '@playwright/test'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * Running code, in a real page: the demo's real agent, a real Web Worker and the real QuickJS
 * engine, with only Gemini's HTTP answers scripted. What matters is what the MODEL got back
 * from `run_js` (read off the recorded requests): a real output, and a real stop.
 */

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

const decision = (): GeminiReply => ({
  text: JSON.stringify({ decision: 'continue', reason: 'ok' }),
})

const PROGRAMS = [
  // A computation with output, and what the guest can see of the page around it.
  `console.log('sum', [1, 2, 3].reduce((a, b) => a + b, 0)); [typeof document, typeof fetch, typeof indexedDB]`,
  // A loop that never ends: the run is stopped, the page and the agent go on.
  `for (;;) {}`,
]

test('sandbox: on by default - run_js runs the code in a worker and returns its real output, and a runaway loop is stopped; switched off, the tool is not offered', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const calls = await mockGemini(page, (c: GeminiCall): GeminiReply => {
    if (c.stage === 'planner') return plan('Run it')
    if (c.stage === 'executor') {
      const n = c.functionResponses.length
      if (!c.tools.includes('run_js') || n >= PROGRAMS.length) return { text: 'Ran it.' }
      return { call: { name: 'run_js', args: { code: PROGRAMS[n] } } }
    }
    if (c.stage === 'replanner') return decision()
    return { text: 'Done.' }
  })
  await openWithKey(page)

  // The default: nothing to switch on.
  await send(page, 'run the code')
  await expect(page.locator('.awr-msg--assistant .awr-msg__bubble').last()).toHaveText('Done.', {
    timeout: 60_000,
  })

  const results = JSON.stringify(
    calls.filter((c) => c.stage === 'executor').at(-1)?.functionResponses,
  )
  // The first program really ran: its output and its value, and nothing of the page in reach.
  expect(results).toContain('sum 6')
  expect(results).toMatch(/undefined\W+undefined\W+undefined/)
  // The second was stopped at the deadline and reported as a result the model can read.
  expect(results).toContain('TimeoutError')

  // Off: the model is not offered the tool.
  await page.locator('.agentset__title').click()
  await expect(page.getByLabel('Let it run code')).toBeChecked()
  await page.getByLabel('Let it run code').uncheck()
  const before = calls.length
  await send(page, 'run the code again')
  await expect(page.locator('.awr-msg--assistant .awr-msg__bubble').last()).toHaveText('Done.')
  const after = calls.slice(before).filter((c) => c.stage === 'executor')
  expect(after.length).toBeGreaterThan(0)
  expect(after.flatMap((c) => c.tools)).not.toContain('run_js')
})
