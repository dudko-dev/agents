import { expect, test, type Page } from '@playwright/test'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * The decision model in the demo, in a real page: Google's Decisions API
 * (`POST …/v1beta/decisions`) is called by the real `@ai-sdk/google` decision model, built in the
 * app from the saved key; only its HTTP answer is scripted, in the shape the live API returns.
 * On by default once a Google key is saved.
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

/**
 * Two steps, and the first reports a blocker: that is when the loop asks "carry on, finish or
 * revise?" (the core's default is to re-check the plan after a step that failed, not after
 * every step) - the question the decision model answers first.
 */
const twoSteps = (c: GeminiCall): GeminiReply => {
  if (c.stage === 'planner') return plan('First thing', 'Second thing')
  if (c.stage === 'executor') {
    return c.user.includes('STEP 1/2')
      ? { text: '[BLOCKER] cannot do the first thing.' }
      : { text: 'Did it.' }
  }
  if (c.stage === 'replanner') {
    return { text: JSON.stringify({ decision: 'continue', reason: 'REPLANNER-SAID-SO' }) }
  }
  return { text: 'Both done.' }
}

test('a confident decision is used: the replanner is not called, and the step says who decided', async ({
  page,
}) => {
  const calls = await mockGemini(page, twoSteps, {
    decide: () => ({ choice: 'continue', confidence: 0.99 }),
  })
  await openWithKey(page)
  await send(page, 'Do two things')

  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('Both done.')
  await answer.locator('.awr-activity__summary').click()
  await expect(answer.locator('.awr-step')).toHaveCount(2)
  const note = answer.locator('.awr-step__decision')
  await expect(note.first()).toHaveText('decision model: continue (0.99)')
  await expect(answer.locator('.awr-step__decision--fallback')).toHaveCount(0)
  // A decision call is not a token: it is counted on its own, next to the conversation's usage.
  await expect(page.locator('.awr-chat .awr-usage').first()).toHaveAttribute(
    'title',
    /1 decision call/,
  )

  // The question went to the decision model with the options of the replanner...
  expect(calls.decisions.length).toBeGreaterThan(0)
  expect(calls.decisions[0].model).toBe('gemini-decision-1')
  expect(calls.decisions[0].options).toEqual(expect.arrayContaining(['continue', 'finish']))
  // ...and the replanner's own model call never happened.
  expect(calls.filter((c) => c.stage === 'replanner')).toHaveLength(0)
})

test('an unsure decision is not used: the replanner decides as ever, and the step says so', async ({
  page,
}) => {
  const calls = await mockGemini(page, twoSteps, {
    decide: () => ({ choice: 'finish', confidence: 0.41 }),
  })
  await openWithKey(page)
  await send(page, 'Do two things')

  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('Both done.')
  await answer.locator('.awr-activity__summary').click()
  // "finish" at 0.41 would have ended the run after one step: it did not.
  await expect(answer.locator('.awr-step')).toHaveCount(2)
  await expect(answer.locator('.awr-step__decision--fallback').first()).toHaveText(
    'decision model fell back: low confidence (0.41 < 0.8)',
  )
  expect(calls.filter((c) => c.stage === 'replanner').length).toBeGreaterThan(0)
})

test('a decision API that fails does not fail the run', async ({ page }) => {
  const calls = await mockGemini(page, twoSteps, {
    decide: () => ({ error: { status: 503, message: 'DECISIONS-DOWN' } }),
  })
  await openWithKey(page)
  await send(page, 'Do two things')
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('Both done.')
  await expect(answer).not.toHaveClass(/awr-msg--error/)
  await answer.locator('.awr-activity__summary').click()
  await expect(answer.locator('.awr-step__decision--fallback').first()).toContainText(
    'decision model fell back: the call failed',
  )
  expect(calls.filter((c) => c.stage === 'replanner').length).toBeGreaterThan(0)
})

test('the decision model switched off: the API is never called and the steps carry no note', async ({
  page,
}) => {
  const calls = await mockGemini(page, twoSteps, {
    decide: () => ({ choice: 'continue', confidence: 0.99 }),
  })
  await openWithKey(page)
  await page.locator('.agentset__title').click()
  await expect(page.getByLabel('Use a decision model')).toBeChecked()
  await page.getByLabel('Use a decision model').uncheck()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  await send(page, 'Do two things')
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('Both done.')
  await answer.locator('.awr-activity__summary').click()
  await expect(answer.locator('.awr-step__decision')).toHaveCount(0)
  expect(calls.decisions).toHaveLength(0)
  expect(calls.filter((c) => c.stage === 'replanner').length).toBeGreaterThan(0)
})
