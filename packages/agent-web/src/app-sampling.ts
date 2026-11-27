/**
 * MCP Apps: a completion an app asks the HOST's model for (`sampling/createMessage` sent by the
 * view, the extension's draft revision; the request is MCP's own `CreateMessageRequest`).
 *
 * Pure, no imports: what of an app's request is accepted, what the user is shown before anything
 * is sent (the same text the model gets), and the per-app rate limit. `Agent.sampleForApp`
 * (`agent/runner.ts`) is the one caller - the request is checked here, counted, put to the host's
 * consent callback, and only then sent to the agent's model: no tools, nothing of the agent's
 * context, nothing kept. The answer goes back to the app and nowhere else.
 */

/** The most an app may have the model write per request: a larger `maxTokens` is lowered to it. */
export const APP_SAMPLING_MAX_TOKENS = 1024
/** At most this many messages in one request. */
export const APP_SAMPLING_MAX_MESSAGES = 20
/** At most this many content blocks in one message. */
export const APP_SAMPLING_MAX_BLOCKS = 10
/** The text of a request (its messages and system prompt): at most this many characters. */
export const APP_SAMPLING_MAX_INPUT_CHARS = 16_000
/** An app's system prompt: at most this many characters (counted in the input too). */
export const APP_SAMPLING_MAX_SYSTEM_CHARS = 4_000
/** Images of one request (only to a model that reads them): at most this many... */
export const APP_SAMPLING_MAX_IMAGES = 4
/** ...each at most this many bytes. */
export const APP_SAMPLING_MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** Requests of one app (server + `ui://` resource) per minute. */
export const APP_SAMPLING_PER_MINUTE = 5
/** Requests of one app for the life of the agent (a page reload starts again). */
export const APP_SAMPLING_PER_APP = 30

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** `config.appSampling`: the caps, or `false` - then `sampleForApp` refuses every request. */
export interface AppSamplingSettings {
  /** The most the model writes per request (default `APP_SAMPLING_MAX_TOKENS`). */
  maxTokens?: number
  /** Requests of one app per minute (default `APP_SAMPLING_PER_MINUTE`). */
  maxRequestsPerMinute?: number
  /** Requests of one app for the agent's life (default `APP_SAMPLING_PER_APP`). */
  maxRequests?: number
  /** Characters of a request's text (default `APP_SAMPLING_MAX_INPUT_CHARS`). */
  maxInputChars?: number
}

export interface ResolvedAppSampling {
  enabled: boolean
  maxTokens: number
  maxRequestsPerMinute: number
  maxRequests: number
  maxInputChars: number
}

const positiveInt = (value: unknown, name: string, fallback: number): number => {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `appSampling.${name} must be a whole number of at least 1, got: ${String(value)}`,
    )
  }
  return value
}

/** `config.appSampling` resolved; throws on a cap that is not a whole number of at least 1. */
export const resolveAppSampling = (setting: unknown): ResolvedAppSampling => {
  const s = typeof setting === 'object' && setting !== null ? (setting as AppSamplingSettings) : {}
  return {
    enabled: setting !== false,
    maxTokens: positiveInt(s.maxTokens, 'maxTokens', APP_SAMPLING_MAX_TOKENS),
    maxRequestsPerMinute: positiveInt(
      s.maxRequestsPerMinute,
      'maxRequestsPerMinute',
      APP_SAMPLING_PER_MINUTE,
    ),
    maxRequests: positiveInt(s.maxRequests, 'maxRequests', APP_SAMPLING_PER_APP),
    maxInputChars: positiveInt(s.maxInputChars, 'maxInputChars', APP_SAMPLING_MAX_INPUT_CHARS),
  }
}

/** Why a request was not answered. */
export type AppSamplingErrorCode =
  'disabled' | 'invalid' | 'unsupported' | 'rate-limited' | 'denied'

/** The JSON-RPC code an app is answered with for each (`-1`: MCP's "user rejected sampling"). */
export const APP_SAMPLING_RPC_CODES: Record<AppSamplingErrorCode, number> = {
  disabled: -32601,
  invalid: -32602,
  unsupported: -32602,
  'rate-limited': -32000,
  denied: -1,
}

export class AppSamplingError extends Error {
  readonly code: AppSamplingErrorCode
  /** What the app is told (`APP_SAMPLING_RPC_CODES`). */
  readonly rpcCode: number
  constructor(code: AppSamplingErrorCode, message: string) {
    super(message)
    this.name = 'AppSamplingError'
    this.code = code
    this.rpcCode = APP_SAMPLING_RPC_CODES[code]
  }
}

/** An image of a request, as checked (base64, one of four raster types). */
export interface AppSamplingImage {
  mimeType: string
  /** Base64. */
  data: string
  /** Its size, decoded. */
  bytes: number
}

/** One message of a request, as the user is shown it and the model is sent it. */
export interface AppSamplingMessage {
  role: 'user' | 'assistant'
  /** Its text blocks, joined, without invisible characters. */
  text: string
  /** Images (a user message only, and only to a model that reads them). */
  images: AppSamplingImage[]
}

/** A request as checked: what the consent callback is shown, and exactly what the model gets. */
export interface AppSamplingView {
  /** The server whose app asks. */
  server: string
  /** The app (`ui://…`). */
  resourceUri: string
  messages: AppSamplingMessage[]
  systemPrompt?: string
  /** What the model may write: the app's `maxTokens`, at most the cap. */
  maxTokens: number
  /** What the app asked for. */
  requestedMaxTokens: number
  temperature?: number
}

/** The answer, in MCP's `CreateMessageResult` shape: a text, the model's id, why it stopped. */
export interface AppSamplingResult {
  role: 'assistant'
  content: { type: 'text'; text: string }
  model: string
  stopReason: string
}

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Characters that change how text reads without being seen (bidirectional overrides, zero-width)
// and control characters other than line breaks and tabs: the user must see what the model reads.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g

/** Text as the user is shown it and the model reads it: nothing invisible in it. */
export const appSamplingText = (text: string): string => text.replace(HIDDEN, '')

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const invalid = (message: string): AppSamplingError => new AppSamplingError('invalid', message)
const unsupported = (message: string): AppSamplingError =>
  new AppSamplingError('unsupported', message)

const hasTools = (value: unknown): boolean =>
  value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)

/**
 * The parts of `params` (MCP `CreateMessageRequest.params`) this host takes, checked:
 * 1 - `APP_SAMPLING_MAX_MESSAGES` messages of role `user` / `assistant`, each a text block or a
 * list of blocks (text; an image - PNG, JPEG, GIF, WebP, base64 - in a user message only when
 * `images` is true); a system prompt; `maxTokens` (required, a whole number, lowered to the cap);
 * a temperature from 0 to 2. Refused: tools (`tools` / `toolChoice`, tool-use and tool-result
 * blocks - `hostCapabilities.sampling.tools` is not offered), audio, an image the model cannot
 * read, more text than `maxInputChars`. Ignored: `modelPreferences` (the host picks the model),
 * `includeContext` (no context is ever added), `stopSequences`, `metadata`. Throws
 * {@link AppSamplingError}.
 */
export const appSamplingRequestOf = (
  params: unknown,
  limits: { maxTokens: number; maxInputChars: number; images: boolean },
): Omit<AppSamplingView, 'server' | 'resourceUri'> => {
  if (!isObj(params)) throw invalid('params must be an object')
  if (hasTools(params.tools) || hasTools(params.toolChoice)) {
    throw unsupported('Tools in sampling are not supported by this host (no sampling.tools)')
  }
  const raw = params.messages
  if (!Array.isArray(raw) || raw.length === 0) throw invalid('messages must be a non-empty list')
  if (raw.length > APP_SAMPLING_MAX_MESSAGES) {
    throw invalid(`at most ${APP_SAMPLING_MAX_MESSAGES} messages`)
  }
  const max = params.maxTokens
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
    throw invalid('maxTokens must be a whole number of at least 1')
  }
  let temperature: number | undefined
  if (params.temperature !== undefined) {
    const t = params.temperature
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 2) {
      throw invalid('temperature must be a number from 0 to 2')
    }
    temperature = t
  }
  let systemPrompt: string | undefined
  if (params.systemPrompt !== undefined) {
    if (typeof params.systemPrompt !== 'string') throw invalid('systemPrompt must be text')
    if (params.systemPrompt.length > APP_SAMPLING_MAX_SYSTEM_CHARS) {
      throw invalid(`the system prompt is longer than ${APP_SAMPLING_MAX_SYSTEM_CHARS} characters`)
    }
    systemPrompt = appSamplingText(params.systemPrompt).trim() || undefined
  }
  let chars = systemPrompt?.length ?? 0
  let images = 0
  const messages: AppSamplingMessage[] = raw.map((m, i) => {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant')) {
      throw invalid(`message ${i + 1}: role must be "user" or "assistant"`)
    }
    const role = m.role
    const blocks = Array.isArray(m.content) ? m.content : [m.content]
    if (blocks.length === 0 || blocks.length > APP_SAMPLING_MAX_BLOCKS) {
      throw invalid(`message ${i + 1}: 1 to ${APP_SAMPLING_MAX_BLOCKS} content blocks`)
    }
    const texts: string[] = []
    const pictures: AppSamplingImage[] = []
    for (const block of blocks) {
      if (!isObj(block) || typeof block.type !== 'string') {
        throw invalid(`message ${i + 1}: a content block must be an object with a type`)
      }
      if (block.type === 'text') {
        if (typeof block.text !== 'string') throw invalid(`message ${i + 1}: text must be text`)
        texts.push(block.text)
      } else if (block.type === 'image') {
        if (!limits.images) {
          throw unsupported('Images are not supported: the host’s model does not read them')
        }
        if (role !== 'user') throw unsupported('An image is accepted in a user message only')
        if (typeof block.mimeType !== 'string' || !IMAGE_TYPES.includes(block.mimeType)) {
          throw unsupported(`an image must be one of ${IMAGE_TYPES.join(', ')}`)
        }
        if (typeof block.data !== 'string' || !BASE64.test(block.data)) {
          throw invalid(`message ${i + 1}: an image's data must be base64`)
        }
        const bytes =
          Math.floor((block.data.length * 3) / 4) - (block.data.match(/=+$/)?.[0].length ?? 0)
        if (bytes > APP_SAMPLING_MAX_IMAGE_BYTES) {
          throw invalid(`an image is larger than ${APP_SAMPLING_MAX_IMAGE_BYTES} bytes`)
        }
        images += 1
        if (images > APP_SAMPLING_MAX_IMAGES) {
          throw invalid(`at most ${APP_SAMPLING_MAX_IMAGES} images`)
        }
        pictures.push({ mimeType: block.mimeType, data: block.data, bytes })
      } else if (
        block.type === 'audio' ||
        block.type === 'tool_use' ||
        block.type === 'tool_result'
      ) {
        throw unsupported(`${block.type} content is not supported by this host`)
      } else {
        throw invalid(
          `message ${i + 1}: unknown content type ${JSON.stringify(block.type.slice(0, 40))}`,
        )
      }
    }
    const text = appSamplingText(texts.join('\n\n')).trim()
    if (!text && pictures.length === 0) throw invalid(`message ${i + 1} is empty`)
    chars += text.length
    if (chars > limits.maxInputChars) {
      throw invalid(`the request's text is longer than ${limits.maxInputChars} characters`)
    }
    return { role, text, images: pictures }
  })
  return {
    messages,
    ...(systemPrompt ? { systemPrompt } : {}),
    maxTokens: Math.min(max, limits.maxTokens),
    requestedMaxTokens: max,
    ...(temperature !== undefined ? { temperature } : {}),
  }
}

/** Why the model stopped, in MCP's words (the AI SDK's `finishReason` otherwise, as it is). */
export const appSamplingStopReason = (finishReason: unknown): string =>
  finishReason === 'length'
    ? 'maxTokens'
    : finishReason === 'stop' || finishReason === undefined
      ? 'endTurn'
      : String(finishReason).slice(0, 40)

/**
 * The rate limit of `sampleForApp`, per app (its key: server + resource): at most `perMinute`
 * requests in any 60 s, and `total` for the life of the limiter. `take` counts a request and
 * answers `undefined`, or says which limit it hit (and does not count it). Pure: the time is
 * the caller's.
 */
export const createAppSamplingLimiter = (perMinute: number, total: number) => {
  const recent = new Map<string, number[]>()
  const counts = new Map<string, number>()
  return {
    take(app: string, now: number): 'minute' | 'total' | undefined {
      const count = counts.get(app) ?? 0
      if (count >= total) return 'total'
      const window = (recent.get(app) ?? []).filter((t) => now - t < 60_000)
      if (window.length >= perMinute) {
        recent.set(app, window)
        return 'minute'
      }
      window.push(now)
      recent.set(app, window)
      counts.set(app, count + 1)
      return undefined
    },
  }
}
