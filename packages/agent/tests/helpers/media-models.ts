import { MockImageModelV4, MockSpeechModelV4, MockTranscriptionModelV4 } from 'ai/test'

// Mock image / speech / transcription models (the AI SDK's own model interfaces) and bytes that
// are, by their signature, what the media tools accept or refuse. No provider, no key, no network.
// The same file in both packages (the Node package's tests/media-shared.test.ts compares them).

const filled = (head: number[], size: number): Uint8Array => {
  const bytes = new Uint8Array(Math.max(size, head.length))
  bytes.set(head)
  for (let i = head.length; i < bytes.length; i++) {
    bytes[i] = (i * 31) % 251
  }
  return bytes
}

const codes = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))

export const pngBytes = (size = 96): Uint8Array =>
  filled([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], size)
export const jpegBytes = (size = 96): Uint8Array => filled([0xff, 0xd8, 0xff, 0xe0], size)
export const mp3Bytes = (size = 96): Uint8Array => filled([...codes('ID3'), 4, 0, 0], size)
export const wavBytes = (size = 96): Uint8Array =>
  filled([...codes('RIFF'), 0, 0, 0, 0, ...codes('WAVE')], size)
// Not media at all: a page, and a vector image that can carry a script.
export const htmlBytes = (): Uint8Array =>
  new TextEncoder().encode('<!doctype html><script>alert(1)</script>')
export const svgBytes = (): Uint8Array =>
  new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')

export const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

export interface IMockOptions {
  // Hold the answer this long.
  delayMs?: number
  // Do not look at the abort signal while waiting (a model that cannot be cancelled).
  ignoreAbort?: boolean
  // Fail the call with this message.
  fail?: string
}

const wait = (options: IMockOptions, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (options.fail) {
      reject(new Error(options.fail))
      return
    }
    if (!options.delayMs) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, options.delayMs)
    if (!options.ignoreAbort && signal) {
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
  })

const response = (modelId: string) => ({ timestamp: new Date(0), modelId, headers: undefined })

export const mockImageModel = (
  bytes: Uint8Array | (() => Uint8Array) = pngBytes(),
  options: IMockOptions = {},
) => {
  const calls: { prompt: unknown; size: unknown; aspectRatio: unknown; n: unknown }[] = []
  const model = new MockImageModelV4({
    provider: 'mock',
    modelId: 'mock-image-1',
    maxImagesPerCall: 1,
    doGenerate: async (o) => {
      calls.push({ prompt: o.prompt, size: o.size, aspectRatio: o.aspectRatio, n: o.n })
      await wait(options, o.abortSignal)
      return {
        images: [typeof bytes === 'function' ? bytes() : bytes],
        warnings: [],
        response: response('mock-image-1'),
      }
    },
  })
  return { model, calls }
}

export const mockSpeechModel = (bytes: Uint8Array = mp3Bytes(), options: IMockOptions = {}) => {
  const calls: { text: string; voice: unknown; outputFormat: unknown; language: unknown }[] = []
  const model = new MockSpeechModelV4({
    provider: 'mock',
    modelId: 'mock-speech-1',
    doGenerate: async (o) => {
      calls.push({
        text: o.text,
        voice: o.voice,
        outputFormat: o.outputFormat,
        language: o.language,
      })
      await wait(options, o.abortSignal)
      return { audio: bytes, warnings: [], response: response('mock-speech-1') }
    },
  })
  return { model, calls }
}

export const mockTranscriptionModel = (
  text: string | ((bytes: number) => string) = 'the quarterly numbers are up',
  options: IMockOptions & { durationInSeconds?: number; language?: string } = {},
) => {
  const calls: { bytes: number; mediaType: string }[] = []
  const model = new MockTranscriptionModelV4({
    provider: 'mock',
    modelId: 'mock-transcribe-1',
    doGenerate: async (o) => {
      const size = typeof o.audio === 'string' ? o.audio.length : o.audio.length
      calls.push({ bytes: size, mediaType: o.mediaType })
      await wait(options, o.abortSignal)
      return {
        text: typeof text === 'function' ? text(size) : text,
        segments: [],
        language: options.language ?? 'en',
        durationInSeconds: options.durationInSeconds ?? 12,
        warnings: [],
        response: response('mock-transcribe-1'),
      }
    },
  })
  return { model, calls }
}
