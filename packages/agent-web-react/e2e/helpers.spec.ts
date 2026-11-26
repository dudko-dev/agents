import { expect, test, type Page } from '@playwright/test'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * Helpers the model starts itself (`spawn_subagent`), in a real page: the demo's real agent and
 * the core's real helper runs, with only Gemini's HTTP answers scripted. A helper is a whole
 * agent run of its own on the same model, so its calls are told from the run's by what they were
 * given: a helper knows only its task, never the user's goal.
 */

const GOAL = 'Delegate the reading'
const TASK = 'HELPER-TASK read the manual and report'

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

const HELPERS_SWITCH = 'Let it start helpers (spawn_subagent)'

const ofHelper = (c: GeminiCall): boolean =>
  c.user.includes('HELPER-TASK') && !c.user.includes(GOAL)

const decision = (): GeminiReply => ({
  text: JSON.stringify({ decision: 'continue', reason: 'ok' }),
})

/** The run: one step that starts a helper, then reports. `helper` scripts the helper's own run. */
const script =
  (helper: (c: GeminiCall) => GeminiReply, args: Record<string, unknown> = {}) =>
  (c: GeminiCall): GeminiReply => {
    if (ofHelper(c)) return helper(c)
    if (c.stage === 'planner') return plan('Hand the reading to a helper')
    if (c.stage === 'executor') {
      if (!c.tools.includes('spawn_subagent')) return { text: 'No helpers here.' }
      return c.functionResponses.length === 0
        ? { call: { name: 'spawn_subagent', args: { task: TASK, role: 'manual reader', ...args } } }
        : { text: 'The helper reported.' }
    }
    if (c.stage === 'replanner') return decision()
    return { text: 'All read.' }
  }

test('helpers: on by default - a helper the model started is a node of the tree with its status; switched off, the tool does not exist', async ({
  page,
}) => {
  const calls = await mockGemini(
    page,
    script((c) => {
      if (c.stage === 'planner') return plan('Read the manual')
      if (c.stage === 'executor') return { text: 'Read it.' }
      if (c.stage === 'replanner') return decision()
      return { text: 'HELPER-ANSWER: the manual says press the button.' }
    }),
  )
  await openWithKey(page)

  // The default: the switch is on, and says so.
  await page.locator('.agentset__title').click()
  await expect(page.getByLabel(HELPERS_SWITCH)).toBeChecked()
  await page.locator('.agentset__title').click()

  await send(page, GOAL)
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('All read.', { timeout: 45_000 })
  await expect(answer.locator('.awr-activity__summary')).toHaveText(
    '1 step · 1 tool call · 1 subagent',
  )
  await answer.locator('.awr-activity__summary').click()

  const node = answer.locator('.awr-subagent')
  await expect(node).toHaveCount(1)
  await expect(node).toHaveClass(/awr-subagent--done/)
  await expect(node).toHaveClass(/awr-subagent--dynamic/)
  await expect(node).toHaveAttribute('data-depth', '1')
  await expect(node.locator('.awr-subagent__name')).toHaveText('manual reader')
  await expect(node.locator('.awr-subagent__profile')).toHaveText('helper')
  await expect(node.locator('.awr-subagent__task')).toContainText('HELPER-TASK')
  await expect(node.locator('.awr-subagent__status')).toHaveText('done')
  // What it spent (the helper's own model calls, as the scripted API billed them) and its time.
  await expect(node.locator('.awr-subagent__meta')).toContainText(/\d(\.\d)?k tokens/)
  await expect(node.locator('.awr-subagent__meta')).toContainText(/\d+(\.\d)? (ms|s)/)
  await expect(node.locator('.awr-subagent__activity')).toContainText('HELPER-ANSWER')
  // A finished helper has nothing to stop.
  await expect(node.getByRole('button', { name: 'Stop this subagent' })).toHaveCount(0)

  // It really was a run of its own, and the model got its answer as the tool result.
  expect(calls.filter(ofHelper).map((c) => c.stage)).toEqual(
    expect.arrayContaining(['planner', 'executor', 'synthesizer']),
  )
  const back = calls.filter((c) => !ofHelper(c) && c.stage === 'executor').at(-1)
  expect(JSON.stringify(back?.functionResponses)).toContain('HELPER-ANSWER')

  // Off: the tool does not exist, and the turn has no tree.
  await page.locator('.agentset__title').click()
  await page.getByLabel(HELPERS_SWITCH).uncheck()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  const before = calls.length
  await send(page, GOAL)
  const second = page.locator('.awr-msg--assistant').last()
  await expect(second.locator('.awr-msg__bubble')).toHaveText('All read.')
  expect(calls.slice(before).length).toBeGreaterThan(0)
  expect(calls.slice(before).flatMap((c) => c.tools)).not.toContain('spawn_subagent')
  await expect(second.locator('.awr-activity__summary')).toHaveText('1 step · 0 tool calls')
  await second.locator('.awr-activity__summary').click()
  await expect(second.locator('.awr-subagents, .awr-subagent')).toHaveCount(0)
})

test('helpers: Stop on a slow helper stops that helper only - the run goes on and answers', async ({
  page,
}) => {
  const calls = await mockGemini(
    page,
    script((c) => {
      if (c.stage === 'planner') return plan('Read the manual')
      // A slow model: long enough to press Stop while the helper works.
      if (c.stage === 'executor') return { text: 'Read it.', delayMs: 20_000 }
      if (c.stage === 'replanner') return decision()
      return { text: 'HELPER-ANSWER: never reached.' }
    }),
  )
  await openWithKey(page)
  await send(page, GOAL)

  const answer = page.locator('.awr-msg--assistant').last()
  const node = answer.locator('.awr-subagent')
  await expect(node).toHaveCount(1, { timeout: 30_000 })
  await expect(node).toHaveClass(/awr-subagent--running/)
  await expect(node.locator('.awr-subagent__status')).toHaveText('running')
  // The helper is at its own step when Stop is pressed.
  await expect(node.locator('.awr-subagent__activity')).toContainText('Read the manual')
  await node.getByRole('button', { name: 'Stop this subagent' }).click()

  await expect(node).toHaveClass(/awr-subagent--stopped/)
  await expect(node.locator('.awr-subagent__status')).toHaveText('stopped')
  await expect(node.getByRole('button', { name: 'Stop this subagent' })).toHaveCount(0)
  // The run was not stopped: the model was told, and wrote its answer.
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('All read.', { timeout: 45_000 })
  await expect(answer).not.toHaveClass(/awr-msg--error/)
  const back = calls.filter((c) => !ofHelper(c) && c.stage === 'executor').at(-1)
  expect(JSON.stringify(back?.functionResponses)).toContain('stopped by the user')
  expect(calls.some((c) => ofHelper(c) && c.stage === 'synthesizer')).toBe(false)
})

test("helpers: a helper's write asks the user, and the prompt says a helper is asking", async ({
  page,
}) => {
  await mockGemini(
    page,
    script(
      (c) => {
        if (c.stage === 'planner') return plan('Write the note')
        if (c.stage === 'executor') {
          return c.functionResponses.length === 0
            ? { call: { name: 'add_note', args: { text: 'from the helper' } } }
            : { text: 'Wrote it.' }
        }
        if (c.stage === 'replanner') return decision()
        return { text: 'HELPER-ANSWER: note written.' }
      },
      { tools: ['add_note'] },
    ),
  )
  await openWithKey(page)
  await page.getByRole('button', { name: /^Tool consent/ }).click()
  await page.getByRole('menuitemradio', { name: /^Ask Run read-only/ }).click()
  await expect(page.getByRole('button', { name: 'Tool consent: Ask' })).toBeVisible()
  await send(page, GOAL)

  const prompt = page.locator('.awr-approval')
  await expect(prompt).toHaveCount(1, { timeout: 30_000 })
  await expect(prompt).toHaveClass(/awr-approval--helper/)
  await expect(prompt.locator('.awr-approval__head')).toContainText(
    'The helper “manual reader” wants to run add_note',
  )
  // Nothing was written before the answer.
  await expect(page.locator('.board').getByText('from the helper')).toHaveCount(0)
  await prompt.getByRole('button', { name: 'Allow once' }).click()

  await expect(page.locator('.board').getByText('from the helper')).toHaveCount(1)
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('All read.', { timeout: 45_000 })
  await answer.locator('.awr-activity__summary').click()
  await expect(answer.locator('.awr-subagent__tools')).toHaveText('tools: add_note')
  await expect(answer.locator('.awr-subagent__status')).toHaveText('done')
})
