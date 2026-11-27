import type { Page, Route } from '@playwright/test'

/**
 * A scripted stand-in for the Gemini API, installed with `page.route`: the
 * page drives the real agent (planner → executor tool loop → synthesizer) with
 * the real `@ai-sdk/google` provider, and only the HTTP answers are scripted.
 * Each request is routed by the role marker in its system instruction.
 */
export interface GeminiCall {
  stage: 'planner' | 'replanner' | 'executor' | 'synthesizer' | 'other'
  /** All text of the system instruction. */
  system: string
  /** All user text (goal, state, tool results) in order. */
  user: string
  /** Function responses already in the conversation (tool-loop position). */
  functionResponses: { name: string; response: unknown }[]
  /** Inline files sent (images, PDFs). */
  inlineData: { mimeType: string; bytes: number }[]
  /** Names of the functions offered to the model on this call. */
  tools: string[]
  /**
   * generationConfig.responseModalities: ['AUDIO'] is a speech model's call, ['IMAGE'] an image
   * model's (the media tools; their stage is 'other', and the model id is in `model`).
   */
  modalities?: string[]
  /** generationConfig.thinkingConfig.thinkingLevel, when the call asked for thinking. */
  thinkingLevel?: string
  /** generationConfig.maxOutputTokens: the call's output cap (an app's sampling is capped). */
  maxOutputTokens?: number
  streaming: boolean
  /** The model the request was sent to (from its URL): tells the executor tiers apart. */
  model: string
}

export type GeminiReply = (
  | { text: string }
  | { call: { name: string; args: Record<string, unknown> } }
  /** A file in the answer: what a speech or an image model returns (base64 in `inlineData`). */
  | { inline: { mimeType: string; data: Buffer } }
  /** An HTTP error from the API (e.g. 429 when the quota is spent). */
  | { error: { status: number; message: string } }
  /** No answer at all: the request fails in the browser, as a blocked cross-origin call does. */
  | { blocked: true }
) & {
  /** Hold the answer this long (a slow model, to act mid-run). */
  delayMs?: number
}

type Part = {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: unknown
  functionResponse?: { name: string; response: unknown }
}
type Body = {
  systemInstruction?: { parts?: Part[] }
  contents?: { role: string; parts?: Part[] }[]
  generationConfig?: {
    thinkingConfig?: { thinkingLevel?: string }
    responseModalities?: string[]
    maxOutputTokens?: number
  }
  tools?: { functionDeclarations?: { name: string }[] }[]
}

const stageOf = (system: string): GeminiCall['stage'] => {
  if (system.includes('REPLANNER')) return 'replanner'
  if (system.includes('PLANNER')) return 'planner'
  if (system.includes('EXECUTOR')) return 'executor'
  if (system.includes('SYNTHESIZER')) return 'synthesizer'
  return 'other'
}

/** One question to the Decisions API (`POST …/v1beta/decisions`). */
export interface DecisionCall {
  model: string
  /** The question's instructions. */
  prompt: string
  /** The option ids, in order. */
  options: string[]
  /** The state the question is about (all text parts). */
  input: string
}

/** What the decision model answers: one of the options and how sure it is - or an API error. */
export type DecisionReply =
  { choice: string; confidence: number } | { error: { status: number; message: string } }

/** One call to the transcription model (`POST …/v1beta/interactions`). */
export interface TranscriptionCall {
  model: string
  mimeType: string
  /** Length of the base64 audio that was sent. */
  bytes: number
}

export interface GeminiExtras {
  /**
   * The decision model's answers. Unscripted, it is unsure (the first option, with every option
   * equally likely): below any threshold, so the ordinary model call - the scripted replanner,
   * the scripted route - decides, exactly as it does without a decision model.
   */
  decide?: (call: DecisionCall) => DecisionReply
  /** The transcript of an audio file. Unscripted: "(a scripted transcript)". */
  transcribe?: (call: TranscriptionCall) => string
}

/** The recorded model calls, plus the calls to the two other APIs of the same host. */
export type GeminiCalls = GeminiCall[] & {
  decisions: DecisionCall[]
  transcriptions: TranscriptionCall[]
}

const CORS = { 'access-control-allow-origin': '*' }
const json = (body: unknown, status = 200) => ({
  status,
  headers: { 'content-type': 'application/json', ...CORS },
  body: JSON.stringify(body),
})
const apiError = (error: { status: number; message: string }) =>
  json({ error: { code: error.status, message: error.message, status: 'ERROR' } }, error.status)

type DecisionBody = {
  model?: string
  input?: { type?: string; text?: string }[]
  questions?: Record<string, { instructions?: string; criteria?: Record<string, unknown> }>
}

/** `POST /v1beta/decisions`: the documented answer shape, as the live API returns it. */
const answerDecision = async (
  route: Route,
  body: DecisionBody,
  decisions: DecisionCall[],
  decide: GeminiExtras['decide'],
) => {
  const answers: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(body.questions ?? {})) {
    const options = Object.keys(question.criteria ?? {})
    const call: DecisionCall = {
      model: body.model ?? '',
      prompt: question.instructions ?? '',
      options,
      input: (body.input ?? []).map((p) => p.text ?? '').join('\n'),
    }
    decisions.push(call)
    const reply = decide?.(call) ?? { choice: options[0], confidence: 1 / options.length }
    if ('error' in reply) return route.fulfill(apiError(reply.error))
    const rest = options.filter((o) => o !== reply.choice)
    answers[id] = {
      type: 'choice',
      choice: reply.choice,
      confidence: reply.confidence,
      probabilities: Object.fromEntries([
        [reply.choice, reply.confidence],
        ...rest.map((o) => [o, (1 - reply.confidence) / Math.max(1, rest.length)]),
      ]),
    }
  }
  return route.fulfill(
    json({ answers, usage: { total_input_tokens: 100, total_output_tokens: 0 } }),
  )
}

type InteractionBody = { model?: string; input?: { data?: string; mime_type?: string }[] }

const USAGE = {
  promptTokenCount: 1200,
  candidatesTokenCount: 40,
  cachedContentTokenCount: 800,
  thoughtsTokenCount: 12,
  totalTokenCount: 1252,
}

export const mockGemini = async (
  page: Page,
  script: (call: GeminiCall) => GeminiReply,
  extras: GeminiExtras = {},
): Promise<GeminiCalls> => {
  const calls = Object.assign([] as GeminiCall[], {
    decisions: [] as DecisionCall[],
    transcriptions: [] as TranscriptionCall[],
  })
  await page.route('https://generativelanguage.googleapis.com/**', async (route: Route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    if (path.endsWith('/decisions')) {
      await answerDecision(
        route,
        (req.postDataJSON() ?? {}) as DecisionBody,
        calls.decisions,
        extras.decide,
      )
      return
    }
    if (path.endsWith('/interactions')) {
      // The transcription model: audio in, text out.
      const sent = (req.postDataJSON() ?? {}) as InteractionBody
      const call: TranscriptionCall = {
        model: sent.model ?? '',
        mimeType: sent.input?.[0]?.mime_type ?? '',
        bytes: sent.input?.[0]?.data?.length ?? 0,
      }
      calls.transcriptions.push(call)
      await route.fulfill(
        json({
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [
                { type: 'text', text: extras.transcribe?.(call) ?? '(a scripted transcript)' },
              ],
            },
          ],
        }),
      )
      return
    }
    const body = (req.postDataJSON() ?? {}) as Body
    const system = (body.systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('\n')
    const parts = (body.contents ?? []).flatMap((c) =>
      (c.parts ?? []).map((p) => ({ role: c.role, ...p })),
    )
    const call: GeminiCall = {
      stage: stageOf(system),
      system,
      user: parts
        .filter((p) => p.role === 'user' && p.text)
        .map((p) => p.text)
        .join('\n'),
      functionResponses: parts
        .filter((p) => p.functionResponse)
        .map((p) => p.functionResponse as { name: string; response: unknown }),
      inlineData: parts
        .filter((p) => p.inlineData)
        .map((p) => ({ mimeType: p.inlineData!.mimeType, bytes: p.inlineData!.data.length })),
      tools: (body.tools ?? []).flatMap((t) => (t.functionDeclarations ?? []).map((d) => d.name)),
      modalities: body.generationConfig?.responseModalities,
      thinkingLevel: body.generationConfig?.thinkingConfig?.thinkingLevel,
      maxOutputTokens: body.generationConfig?.maxOutputTokens,
      streaming: req.url().includes(':streamGenerateContent'),
      model: /\/models\/([^:/?]+)/.exec(req.url())?.[1] ?? '',
    }
    calls.push(call)
    const reply = script(call)
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs))
    if ('blocked' in reply) {
      await route.abort('failed')
      return
    }
    if ('error' in reply) {
      await route.fulfill(apiError(reply.error))
      return
    }
    const candidate = {
      content: {
        role: 'model',
        parts:
          'text' in reply
            ? [{ text: reply.text }]
            : 'inline' in reply
              ? [
                  {
                    inlineData: {
                      mimeType: reply.inline.mimeType,
                      data: reply.inline.data.toString('base64'),
                    },
                  },
                ]
              : [{ functionCall: reply.call }],
      },
      finishReason: 'STOP',
      index: 0,
    }
    const chunk = { candidates: [candidate], usageMetadata: USAGE }
    await route.fulfill(
      call.streaming
        ? {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' },
            body: `data: ${JSON.stringify(chunk)}\r\n\r\n`,
          }
        : {
            status: 200,
            headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
            body: JSON.stringify(chunk),
          },
    )
  })
  return calls
}

/** A valid WAV: 44 bytes of header and a few samples of silence. */
export const TINY_WAV = (() => {
  const samples = 16
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + samples * 2, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20) // PCM
  wav.writeUInt16LE(1, 22) // mono
  wav.writeUInt32LE(24_000, 24)
  wav.writeUInt32LE(48_000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples * 2, 40)
  return wav
})()

/** A valid PNG: a 48x48 square of one colour (small, yet visible in a screenshot). */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OQQ0AAAgEoGtkZKsZxRbOBxsBSPW8EiEhISEhISEhISEhISEhISEhISEhISEhISGhOwu8+x7ikHzBkQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * A call an MCP App asked for (`sampling/createMessage`, answered by the agent's model through
 * `Agent.sampleForApp`): no stage marker - the system instruction is the APP's - and no tools.
 */
export const isAppSampling = (c: GeminiCall, systemPrompt: string): boolean =>
  c.stage === 'other' && c.system.includes(systemPrompt) && c.tools.length === 0

/** A one-step plan, as the planner's JSON. */
export const plan = (...steps: string[]): GeminiReply => ({
  text: JSON.stringify({ thought: 'On it.', steps: steps.map((description) => ({ description })) }),
})
