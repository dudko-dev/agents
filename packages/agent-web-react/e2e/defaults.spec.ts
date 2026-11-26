import { expect, test, type Page } from '@playwright/test'
import { mockGemini, plan, type GeminiCall, type GeminiReply } from './gemini.ts'

/**
 * The demo's defaults: every capability is on, the ones that need a key say whether they are in
 * effect, and a returning visitor's stored settings get the new defaults without losing a choice.
 */

const SETTINGS_KEY = 'agent-web-demo:settings'

const saveGoogleKey = async (page: Page) => {
  await page.getByPlaceholder('AIza…').fill('AIza-test-key')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
}

const send = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

/** The state shown next to a capability's switch. */
const stateOf = (page: Page, label: string) =>
  page.locator('.agentset__cap').filter({ hasText: label }).locator('.agentset__state')

const stored = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown, SETTINGS_KEY)

/** What the page stored before settings had a version: the whole object, defaults included. */
const LEGACY = {
  approvalMode: 'autopilot',
  thinking: 'off',
  showThoughts: true,
  maxTotalTokens: 0,
  maxToolCalls: 0,
  maxIterations: 6,
  maxStepsPerTask: 4,
  autoCompact: true,
  fastAnswers: false,
  contextWindowTokens: 0,
  enabledSkills: ['chess-coach', 'board-style', 'precise-answers'],
  customSkills: [],
  analysts: 'off',
  learning: false,
  egress: false,
  egressAllow: 'en.wikipedia.org, api.github.com',
  sandbox: false,
  helpers: false,
  search: false,
  tierLight: '',
  tierStrong: '',
  showToolCalls: true,
  showUsage: true,
  history: true,
  filesPanel: true,
  lang: 'en',
}

test('a fresh profile without a key: everything is switched on, and what needs a key says which', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('.agentset__title').click()

  for (const label of ['Let the agent learn', 'Let it run code', 'Let it start helpers']) {
    await expect(page.getByLabel(label)).toBeChecked()
    await expect(stateOf(page, label)).toHaveText('on')
  }
  await expect(page.getByLabel('Let it read the web')).toBeChecked()
  await expect(stateOf(page, 'Let it read the web')).toHaveText('on: 2 hosts')

  // On when possible: the switch is on, the state says what is missing.
  await expect(page.getByLabel('Let it search the web')).toBeChecked()
  await expect(stateOf(page, 'Let it search the web')).toHaveText('off: needs a Tavily key')
  await expect(page.getByPlaceholder('tvly-…')).toBeVisible()
  await expect(page.getByLabel('Let it make images and speech')).toBeChecked()
  await expect(stateOf(page, 'Let it make images and speech')).toHaveText(
    'off: needs a Google or OpenAI key',
  )
  await expect(page.getByLabel('Use a decision model')).toBeChecked()
  await expect(stateOf(page, 'Use a decision model')).toHaveText('off: needs a Google key')
  await expect(
    page.getByText('save your Google AI Studio key in the Model panel above'),
  ).toBeVisible()
  await expect(page.getByLabel('Light model')).toHaveValue('auto')
  await expect(page.getByLabel('Strong model')).toHaveValue('auto')
  await expect(page.getByText('Off: every step runs on the model chosen above.')).toBeVisible()

  // The chat's parts and auto-compact are on; the two switches that take something away are not.
  for (const label of ['Thoughts', 'Tool calls', 'Token usage', 'Files panel']) {
    await expect(page.getByLabel(label, { exact: true })).toBeChecked()
  }
  await expect(page.getByLabel('Saved chats (IndexedDB)')).toBeChecked()
  await expect(page.getByLabel('Auto-compact the conversation')).toBeChecked()
  await expect(page.getByLabel('Fast answers')).not.toBeChecked()

  // Consent is what it was, and the panel's first lines say what that now covers.
  await expect(page.getByText('Autopilot: the agent runs every tool on its own.')).toBeVisible()
  const can = page.locator('.agentset__can')
  await expect(can).toContainText('without asking it may')
  await expect(can).toContainText('write lessons into its notebook')
  await expect(can).toContainText('read the web (2 allowed hosts)')
  await expect(can).toContainText('run code it wrote, in a sandbox')
  await expect(can).toContainText('start helper agents')
  // Not in effect, so not claimed.
  await expect(can).not.toContainText('search the web')
  await expect(can).not.toContainText('generate images')

  // Nothing was chosen, so nothing but the version is stored.
  expect(await stored(page)).toEqual({ v: 2, set: {} })
})

test('with a Google key saved: media, the decision model and the tiers come on by themselves; search waits for its own key', async ({
  page,
}) => {
  const calls = await mockGemini(page, (c: GeminiCall): GeminiReply => {
    if (c.stage === 'planner') return plan('Say hi')
    return { text: 'Hi.' }
  })
  await page.goto('/')
  await saveGoogleKey(page)
  await page.locator('.agentset__title').click()

  await expect(stateOf(page, 'Let it make images and speech')).toHaveText('on: Google')
  await expect(stateOf(page, 'Use a decision model')).toHaveText('on: Google')
  await expect(page.getByText('The planner rates each step')).toBeVisible()
  await expect(page.locator('.agentset__can')).toContainText(
    'generate images and speech and transcribe audio, billed to your Google key',
  )
  await expect(stateOf(page, 'Let it search the web')).toHaveText('off: needs a Tavily key')

  // What the model is really offered: every tool that is in effect, and not the one that is not.
  await send(page, 'hello')
  await expect(page.locator('.awr-msg--assistant .awr-msg__bubble')).toHaveText('Hi.')
  const offered = calls.find((c) => c.stage === 'executor')?.tools ?? []
  expect(offered).toEqual(
    expect.arrayContaining([
      'web_fetch',
      'run_js',
      'spawn_subagent',
      'save_skill',
      'generate_image',
      'generate_speech',
      'transcribe_audio',
    ]),
  )
  expect(offered).not.toContain('web_search')

  // A Tavily key: search comes on without touching its switch.
  await page.getByPlaceholder('tvly-…').fill('tvly-test-key')
  await page.locator('.agentset').getByRole('button', { name: 'Save' }).click()
  await expect(stateOf(page, 'Let it search the web')).toHaveText('on: Tavily')
  await expect(page.locator('.agentset__can')).toContainText('search the web with your Tavily key')
  const before = calls.length
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  await send(page, 'hello again')
  await expect(page.locator('.awr-msg--assistant .awr-msg__bubble').last()).toHaveText('Hi.')
  expect(calls.slice(before).find((c) => c.stage === 'executor')?.tools).toContain('web_search')
})

test('a model of another provider: the Google key that media and the decision model need is asked for in the panel', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('.settings select').first().selectOption('anthropic-sonnet')
  await page.locator('.agentset__title').click()
  await expect(stateOf(page, 'Use a decision model')).toHaveText('off: needs a Google key')
  // Auto tiers follow the chosen model: Claude's lightest and strongest, waiting for its key.
  await expect(page.getByLabel('Light model').locator('option').first()).toHaveText(
    'auto (Claude Haiku 4.5)',
  )
  await expect(page.getByLabel('Strong model').locator('option').first()).toHaveText(
    'auto (Claude Fable 5.1)',
  )

  const form = page.locator('.agentset__key')
  await form.getByPlaceholder('AIza…').fill('AIza-test-key')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(stateOf(page, 'Let it make images and speech')).toHaveText('on: Google')
  await expect(stateOf(page, 'Use a decision model')).toHaveText('on: Google')
  await expect(page.locator('.agentset__key')).toHaveCount(0)
})

test('a returning visitor: stored settings of the old shape get the new defaults for what was never touched, and keep every choice', async ({
  page,
}) => {
  await page.goto('/')
  // The old page stored the whole object. This visitor had changed five things.
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [
      SETTINGS_KEY,
      JSON.stringify({
        ...LEGACY,
        egressAllow: 'example.org',
        maxIterations: 9,
        showThoughts: false,
        sandbox: true,
        tierLight: 'google-flash-lite',
      }),
    ],
  )
  await page.reload()
  await page.locator('.agentset__title').click()

  // Never touched (they were the defaults of that time): the new defaults.
  await expect(page.getByLabel('Let the agent learn')).toBeChecked()
  await expect(page.getByLabel('Let it read the web')).toBeChecked()
  await expect(page.getByLabel('Let it start helpers')).toBeChecked()
  await expect(page.getByLabel('Let it search the web')).toBeChecked()
  await expect(page.getByLabel('Let it make images and speech')).toBeChecked()
  await expect(page.getByLabel('Use a decision model')).toBeChecked()
  await expect(page.getByLabel('Strong model')).toHaveValue('auto')
  // Chosen: kept as they were.
  await expect(page.getByLabel('Allowed hosts')).toHaveValue('example.org')
  await expect(page.getByLabel('Steps / run')).toHaveValue('9')
  await expect(page.getByLabel('Thoughts', { exact: true })).not.toBeChecked()
  await expect(page.getByLabel('Let it run code')).toBeChecked()
  await expect(page.getByLabel('Light model')).toHaveValue('google-flash-lite')
  // Consent was not a choice here, and it is not changed either.
  await expect(page.getByText('Autopilot: the agent runs every tool on its own.')).toBeVisible()

  // Stored again in the new shape: the choices only.
  expect(await stored(page)).toEqual({
    v: 2,
    set: {
      showThoughts: false,
      maxIterations: 9,
      egressAllow: 'example.org',
      sandbox: true,
      tierLight: 'google-flash-lite',
    },
  })

  // A switch turned off now is a choice like any other: it survives a reload.
  await page.getByLabel('Let it start helpers').uncheck()
  await page.reload()
  await page.locator('.agentset__title').click()
  await expect(page.getByLabel('Let it start helpers')).not.toBeChecked()
  await expect(page.getByLabel('Let the agent learn')).toBeChecked()

  // Reset forgets every choice: back on the defaults.
  await page.getByRole('button', { name: 'Reset settings' }).click()
  await expect(page.getByLabel('Let it start helpers')).toBeChecked()
  await expect(page.getByLabel('Thoughts', { exact: true })).toBeChecked()
  await expect(page.getByLabel('Steps / run')).toHaveValue('6')
  await expect(page.getByLabel('Light model')).toHaveValue('auto')
  await expect(page.getByLabel('Allowed hosts')).toHaveValue('en.wikipedia.org, api.github.com')
  await expect.poll(() => stored(page)).toEqual({ v: 2, set: {} })
})

test('a visitor who had switched things off in the old shape and back: a stored "off" equal to the old default follows the new default', async ({
  page,
}) => {
  // The limit of the rule, stated as a test: the old shape cannot tell "never touched" from
  // "turned on and off again", so both follow the new default. Consent and the limits are kept.
  await page.goto('/')
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [SETTINGS_KEY, JSON.stringify({ ...LEGACY, approvalMode: 'ask-writes', maxToolCalls: 10 })],
  )
  await page.reload()
  await page.locator('.agentset__title').click()
  await expect(page.getByLabel('Let the agent learn')).toBeChecked()
  await expect(page.getByLabel('Tool calls / run')).toHaveValue('10')
  await expect(page.getByText('Read-only tools run freely; you approve anything')).toBeVisible()
  await expect(page.locator('.agentset__can')).toContainText(
    'it has, under the consent mode above, the means to',
  )
  expect(await stored(page)).toEqual({
    v: 2,
    set: { approvalMode: 'ask-writes', maxToolCalls: 10 },
  })
})
