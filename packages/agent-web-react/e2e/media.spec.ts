import { expect, test, type Page } from '@playwright/test'
import {
  mockGemini,
  plan,
  TINY_PNG,
  TINY_WAV,
  type GeminiCall,
  type GeminiReply,
} from './gemini.ts'

/**
 * Media in the demo, in a real page: the real agent, the real `@ai-sdk/google` image, speech and
 * transcription models built from the saved key - only Google's HTTP answers are scripted (a
 * small WAV, a small PNG, a quota refusal, a request that never gets an answer). On by default
 * once a Google key is saved; nothing here switches it on.
 */

const SPEECH_MODEL = 'gemini-3.8-flash-lite-tts'
const IMAGE_MODEL = 'gemini-3.1-flash-image'
const TRANSCRIPTION_MODEL = 'gemini-3.5-transcribe'

const QUOTA =
  'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-flash-image. Please check your plan and billing details.'

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

const isMedia = (c: GeminiCall) =>
  c.modalities?.includes('AUDIO') || c.modalities?.includes('IMAGE')

/** One step that calls `tool` once and reports; `media` answers the media model's own request. */
const script =
  (tool: string, args: Record<string, unknown>, media: (c: GeminiCall) => GeminiReply) =>
  (c: GeminiCall): GeminiReply => {
    if (isMedia(c)) return media(c)
    if (c.stage === 'planner') return plan('Make it')
    if (c.stage === 'executor') {
      if (!c.tools.includes(tool)) return { text: 'No such tool here.' }
      return c.functionResponses.length === 0 ? { call: { name: tool, args } } : { text: 'Made.' }
    }
    return { text: 'Here it is.' }
  }

test('speech: generate_speech writes a WAV into the workspace and the answer plays it', async ({
  page,
}) => {
  const calls = await mockGemini(
    page,
    script('generate_speech', { text: 'Hello from the demo.' }, () => ({
      inline: { mimeType: 'audio/wav', data: TINY_WAV },
    })),
  )
  await openWithKey(page)
  await send(page, 'Say hello aloud')

  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('Here it is.')
  // A native player on a blob of the workspace file - not a link, not a chip.
  const player = answer.locator('audio.awr-media__audio')
  await expect(player).toHaveCount(1)
  await expect(player).toHaveAttribute('src', /^blob:/)
  await expect(player).toHaveAttribute('controls', '')
  // And it is really there to press: a player with a width, not an element of no size.
  await expect(player).toBeVisible()
  expect((await player.boundingBox())?.width).toBeGreaterThan(150)
  // The browser really decodes it: the scripted bytes are a playable file.
  await expect
    .poll(() => player.evaluate((el: HTMLAudioElement) => el.readyState >= 1 && el.duration > 0))
    .toBe(true)
  // A media call is not a token: it is counted on its own, next to the conversation's usage.
  await expect(page.locator('.awr-chat .awr-usage').first()).toHaveAttribute(
    'title',
    /1 media call/,
  )

  // The speech model was asked - with the user's key, for audio - and the language model got a
  // path back, never the bytes.
  const speech = calls.filter(isMedia)
  expect(speech.map((c) => c.model)).toEqual([SPEECH_MODEL])
  expect(speech[0].user).toContain('Hello from the demo.')
  const back = JSON.stringify(calls.filter((c) => c.stage === 'executor').at(-1)?.functionResponses)
  expect(back).toMatch(/\/media\/speech-[\w-]+\.wav/)
  expect(back).toContain('audio/wav')
  expect(back).not.toContain(TINY_WAV.toString('base64').slice(0, 24))

  // It is a file of the workspace like any other.
  await page.getByRole('button', { name: 'Show files' }).click()
  await expect(page.locator('.awr-filelist__path').filter({ hasText: '/media/' })).toHaveText(
    /\/media\/speech-[\w-]+\.wav/,
  )
})

test('an image: generate_image writes a PNG and the answer shows it inline', async ({ page }) => {
  const calls = await mockGemini(
    page,
    script('generate_image', { prompt: 'A blue square' }, () => ({
      inline: { mimeType: 'image/png', data: TINY_PNG },
    })),
  )
  await openWithKey(page)
  await send(page, 'Draw a blue square')

  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('Here it is.')
  const image = answer.locator('img.awr-media__img')
  await expect(image).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(48)
  expect(calls.filter(isMedia).map((c) => c.model)).toEqual([IMAGE_MODEL])
})

test('an image the provider refuses (no quota on a free-tier key): the chat says why, in the provider’s words, and the run goes on', async ({
  page,
}) => {
  const calls = await mockGemini(
    page,
    script('generate_image', { prompt: 'A blue square' }, () => ({
      error: { status: 429, message: QUOTA },
    })),
  )
  await openWithKey(page)
  await send(page, 'Draw a blue square')

  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('Here it is.')
  await expect(answer).not.toHaveClass(/awr-msg--error/)
  await expect(page.locator('.awr-chat__error')).toHaveCount(0)
  await expect(answer.locator('.awr-media')).toHaveCount(0)
  await answer.locator('.awr-activity__summary').click()
  await expect(answer.locator('.awr-tool--failed .awr-tool__name')).toHaveText('generate_image')
  await expect(answer.locator('.tool-error')).toContainText('Quota exceeded for metric')
  await expect(answer.locator('.tool-error')).toContainText('check your plan and billing')
  // One attempt, not a retry storm against a quota; and the model was told the same thing.
  expect(calls.filter(isMedia)).toHaveLength(1)
  const back = JSON.stringify(calls.filter((c) => c.stage === 'executor').at(-1)?.functionResponses)
  expect(back).toContain('Quota exceeded for metric')
})

test('a media call that gets no answer at all (a blocked cross-origin request): a sentence, not "Failed to fetch"', async ({
  page,
}) => {
  const calls = await mockGemini(
    page,
    script('generate_speech', { text: 'Hello.' }, () => ({ blocked: true })),
  )
  await openWithKey(page)
  await send(page, 'Say hello aloud')

  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('Here it is.')
  await answer.locator('.awr-activity__summary').click()
  const error = answer.locator('.tool-error')
  await expect(error).toContainText(
    'Google media: no answer from generativelanguage.googleapis.com reached this page',
  )
  await expect(error).toContainText('does not allow calls from a browser page (CORS)')
  const back = JSON.stringify(calls.filter((c) => c.stage === 'executor').at(-1)?.functionResponses)
  expect(back).toContain('no answer from generativelanguage.googleapis.com reached this page')
})

test('an attached audio file is transcribed before the model reads it, and the transcript is shown', async ({
  page,
}) => {
  const calls = await mockGemini(
    page,
    (c) =>
      c.stage === 'planner' ? plan('Answer from the memo') : { text: 'It says to buy milk.' },
    { transcribe: () => 'Remember to buy milk on Friday.' },
  )
  await openWithKey(page)
  await page
    .locator('.awr-composer2 input[type=file]')
    .setInputFiles({ name: 'memo.wav', mimeType: 'audio/wav', buffer: TINY_WAV })
  await expect(page.locator('.awr-files .awr-file__name')).toHaveText(['memo.wav'])
  await send(page, 'What does the memo say?')

  const answer = page.locator('.awr-msg--assistant').last()
  await expect(answer.locator('.awr-msg__bubble')).toHaveText('It says to buy milk.')
  // The audio went to the transcription model, once...
  expect(calls.transcriptions).toHaveLength(1)
  expect(calls.transcriptions[0].model).toBe(TRANSCRIPTION_MODEL)
  expect(calls.transcriptions[0].mimeType).toBe('audio/wav')
  expect(calls.transcriptions[0].bytes).toBeGreaterThan(40)
  // ...the language model read the text, and was never sent the file...
  const planner = calls.find((c) => c.stage === 'planner')
  expect(planner?.user).toContain('Remember to buy milk on Friday.')
  expect(calls.flatMap((c) => c.inlineData)).toHaveLength(0)
  // ...and the person sees what was heard.
  const transcript = answer.locator('.awr-transcript')
  await expect(transcript.locator('.awr-transcript__summary')).toContainText(
    'Transcript of memo.wav',
  )
  await transcript.locator('.awr-transcript__summary').click()
  await expect(transcript.locator('.awr-transcript__text')).toHaveText(
    'Remember to buy milk on Friday.',
  )
})

test('media switched off: no media tool is offered, and nothing is transcribed', async ({
  page,
}) => {
  const calls = await mockGemini(
    page,
    script('generate_speech', { text: 'Hello.' }, () => ({
      inline: { mimeType: 'audio/wav', data: TINY_WAV },
    })),
  )
  await openWithKey(page)
  await page.locator('.agentset__title').click()
  await page.getByLabel('Let it make images and speech').uncheck()
  await expect(
    page
      .locator('.agentset__cap')
      .filter({ hasText: 'Let it make images' })
      .locator('.agentset__state'),
  ).toHaveText('off')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  await send(page, 'Say hello aloud')
  await expect(page.locator('.awr-msg--assistant .awr-msg__bubble').last()).toHaveText(
    'Here it is.',
  )
  const offered = calls.filter((c) => c.stage === 'executor').flatMap((c) => c.tools)
  expect(offered.length).toBeGreaterThan(0)
  expect(offered).not.toContain('generate_speech')
  expect(offered).not.toContain('generate_image')
  expect(offered).not.toContain('transcribe_audio')
  expect(calls.filter(isMedia)).toHaveLength(0)
})
