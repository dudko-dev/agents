import { expect, test, type Page } from '@playwright/test'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * Model tiers and a replanner that failed, in a real page: the demo's real agent and provider,
 * only Gemini's HTTP answers scripted. The two executor models are told apart by the model id in
 * the request URL, so an escalation is a real one: the light model's call, then the standard's.
 */

const LIGHT = 'gemini-3.5-flash-lite'
const STANDARD = 'gemini-3.8-flash'
const STRONG = 'gemini-3.1-pro-preview'

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

test('a step the light model gives up on is escalated, and the two attempts are not glued together', async ({
  page,
}) => {
  const calls = await mockGemini(page, (c: GeminiCall): GeminiReply => {
    if (c.stage === 'planner') {
      return {
        text: JSON.stringify({
          thought: 'One easy step.',
          steps: [{ description: 'Add the note', complexity: 'low' }],
        }),
      }
    }
    if (c.stage === 'executor') {
      if (c.model === LIGHT) return { text: '[BLOCKER] LIGHT-GAVE-UP: this is beyond me.' }
      return c.functionResponses.length === 0
        ? { call: { name: 'add_note', args: { text: 'escalated note' } } }
        : { text: 'STRONGER-DID-IT.' }
    }
    if (c.stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    return { text: 'The note is on the board.' }
  })
  await openWithKey(page)

  // Tiers are on by default: "auto" takes the lightest and the strongest model of the chosen
  // model's own provider (the key is the same one), and the panel names what it took.
  await page.getByText('Agent settings').click()
  await expect(page.getByLabel('Light model')).toHaveValue('auto')
  await expect(page.getByLabel('Strong model')).toHaveValue('auto')
  await expect(page.locator('.agentset__state').filter({ hasText: 'Flash-Lite' })).toHaveText(
    'on: Gemini 3.5 Flash-Lite',
  )
  await expect(page.locator('.agentset__state').filter({ hasText: 'Pro' })).toHaveText(
    'on: Gemini 3.1 Pro',
  )
  await expect(page.getByText('The planner rates each step')).toBeVisible()

  await send(page, 'Add a note')
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('The note is on the board.')
  await expect(answer.locator('.awr-activity__summary')).toHaveText(
    '1 step · 1 tool call · 1 escalation',
  )
  await answer.locator('.awr-activity__summary').click()

  // Where the step finished, and how it got there.
  await expect(answer.locator('.awr-step__tier')).toHaveText('standard')
  await expect(answer.locator('.awr-step__model')).toHaveText(STANDARD)
  await expect(answer.locator('.awr-step__escalated-line')).toHaveText(
    'Escalated: light → standard (reported a blocker)',
  )
  // The step's text is the attempt that finished it; the failed attempt's is folded away.
  const text = answer.locator('.awr-step > .awr-step__text')
  await expect(text).toHaveText('STRONGER-DID-IT.')
  await expect(answer.locator('.awr-step__attempt')).not.toHaveAttribute('open', '')
  await answer.locator('.awr-step__attempt summary').click()
  await expect(answer.locator('.awr-step__attempt .awr-step__text')).toContainText('LIGHT-GAVE-UP')
  await expect(answer.locator('.awr-step--blocked')).toHaveCount(0)

  // It really was two models, and the tool really ran (once).
  const executors = calls.filter((c) => c.stage === 'executor').map((c) => c.model)
  expect(executors[0]).toBe(LIGHT)
  expect(executors.slice(1).every((m) => m === STANDARD)).toBe(true)
  expect(executors.length).toBeGreaterThan(1)
  await expect(page.locator('.board').getByText('escalated note')).toHaveCount(1)
  // The stronger model was told what the first attempt did.
  const second = calls.filter((c) => c.stage === 'executor')[1]
  expect(second.user).toContain('EARLIER ATTEMPT AT THIS STEP')
})

test('tiers switched off: every step runs on the chosen model, and shows no tier, no model and no escalation', async ({
  page,
}) => {
  const calls = await mockGemini(page, (c) => {
    if (c.stage === 'planner') {
      // Rated easy and hard: with tiers these would go to the light and the strong model.
      return {
        text: JSON.stringify({
          thought: 'Two steps.',
          steps: [
            { description: 'Add the note', complexity: 'low' },
            { description: 'Check the board', complexity: 'high' },
          ],
        }),
      }
    }
    if (c.stage === 'executor') {
      return c.user.includes('STEP 1/2') && c.functionResponses.length === 0
        ? { call: { name: 'add_note', args: { text: 'plain' } } }
        : { text: 'Done.' }
    }
    if (c.stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    return { text: 'Added.' }
  })
  await openWithKey(page)
  await page.getByText('Agent settings').click()
  await page.getByLabel('Light model').selectOption('')
  await page.getByLabel('Strong model').selectOption('')
  await expect(page.getByText('Off: every step runs on the model chosen above.')).toBeVisible()

  await send(page, 'Add a note')
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('Added.')
  await expect(answer.locator('.awr-activity__summary')).toHaveText('2 steps · 1 tool call')
  await answer.locator('.awr-activity__summary').click()
  await expect(answer.locator('.awr-step')).toHaveCount(2)
  await expect(
    answer.locator('.awr-step__meta, .awr-step__tier, .awr-step__escalated, .awr-tool__tag'),
  ).toHaveCount(0)
  // One model did all of it.
  expect(new Set(calls.filter((c) => c.stage === 'executor').map((c) => c.model))).toEqual(
    new Set([STANDARD]),
  )
})

test('auto tiers: a step rated hard runs on the strongest model of the same provider, an unrated one on the chosen model', async ({
  page,
}) => {
  const calls = await mockGemini(page, (c) => {
    if (c.stage === 'planner') {
      return {
        text: JSON.stringify({
          thought: 'Two steps.',
          steps: [{ description: 'Think hard', complexity: 'high' }, { description: 'Wrap up' }],
        }),
      }
    }
    if (c.stage === 'executor') return { text: 'Done.' }
    if (c.stage === 'replanner')
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    return { text: 'All done.' }
  })
  await openWithKey(page)
  await send(page, 'Do two things')
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('All done.')
  await answer.locator('.awr-activity__summary').click()
  await expect(answer.locator('.awr-step__tier')).toHaveText(['strong', 'standard'])
  await expect(answer.locator('.awr-step__model')).toHaveText([STRONG, STANDARD])
  expect(calls.filter((c) => c.stage === 'executor').map((c) => c.model)).toEqual([
    STRONG,
    STANDARD,
  ])
})

test('a replanner that fails is a warning on the step: the run goes on and ends with its answer', async ({
  page,
}) => {
  const calls = await mockGemini(page, (c: GeminiCall): GeminiReply => {
    if (c.stage === 'planner') return plan('Try the impossible', 'Add the note')
    if (c.stage === 'executor') {
      // The first step is blocked (which is what brings the replanner in); the second is fine.
      return c.user.includes('STEP 1/2')
        ? { text: '[BLOCKER] cannot do the impossible.' }
        : { text: 'Noted.' }
    }
    if (c.stage === 'replanner') return { error: { status: 400, message: 'REPLANNER-DOWN' } }
    return { text: 'Here is what I managed.' }
  })
  await openWithKey(page)
  await send(page, 'Do two things')
  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('Here is what I managed.', {
    timeout: 45_000,
  })
  expect(calls.some((c) => c.stage === 'replanner')).toBe(true)
  // Not a failed run: no error styling on the turn, no error banner.
  await expect(answer).not.toHaveClass(/awr-msg--error/)
  await expect(page.locator('.awr-chat__error')).toHaveCount(0)
  await answer.locator('.awr-activity__summary').click()
  const warn = answer.locator('.awr-step__warn').first()
  await expect(warn).toHaveText('Replanning failed, continuing with the plan')
  await expect(warn).toHaveAttribute('title', /REPLANNER-DOWN/)
  // The plan it had was carried out: the second step ran.
  await expect(answer.locator('.awr-step')).toHaveCount(2)
})
