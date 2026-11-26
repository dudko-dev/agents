import {
  generateImage,
  generateSpeech,
  transcribe,
  type ImageModel,
  type SpeechModel,
  type TranscriptionModel,
} from 'ai'
import { z } from 'zod'
import type { IPlanStep, IUsage } from '../agent/loop-types.js'
import type { AgentEvent } from '../events.js'
import { fileToolBindingOf } from '../files/tools.js'
import { normalizePath, type VirtualFileSystem } from '../files/vfs.js'
import type { RunFile } from '../images.js'
import {
  buildMediaModelFromSpec,
  resolveStage,
  type MediaModelKind,
} from '../providers/registry.js'
import type { ModelInput, ProviderModelSpec, StageOverride } from '../providers/types.js'
import type { CredentialStore } from '../secrets/store.js'
import { defineTool } from './define.js'
import {
  acceptMedia,
  cleanMediaText,
  cleanTranscript,
  createMediaBudget,
  emptyMediaUsage,
  GENERATE_IMAGE_TOOL,
  GENERATE_SPEECH_TOOL,
  generateImageDescription,
  generateSpeechDescription,
  MEDIA_AUDIO_TYPES,
  MEDIA_MAX_ATTACHED_AUDIO,
  MEDIA_MAX_AUDIO_INPUT_BYTES,
  MEDIA_MAX_IMAGE_BYTES,
  MEDIA_MAX_PROMPT_CHARS,
  MEDIA_MAX_SPEECH_BYTES,
  MEDIA_MAX_SPEECH_CHARS,
  mediaAspectRatio,
  MediaError,
  mediaFileName,
  mediaFolder,
  mediaLabel,
  mediaSize,
  mediaToken,
  resolveMediaMaxCalls,
  resolveMediaTimeout,
  sniffMediaType,
  TRANSCRIBE_AUDIO_TOOL,
  transcribeAudioDescription,
  withTranscripts,
  type IMediaBudget,
  type IMediaUsage,
  type ITranscriptBlock,
} from './media-shared.js'
import type { AgentToolSet } from './types.js'
import { toolRunContextOf } from './wrap.js'

/**
 * A media model as a spec: a full `ProviderModelSpec`, or a partial one that inherits the
 * provider, key reference and endpoint of `config.model` and names only the media model. The key
 * is never written here: `credentialRef` names it in the agent's `CredentialStore`.
 */
export type IMediaModelSpec =
  Omit<ProviderModelSpec, 'apiKey'> | (Omit<StageOverride, 'apiKey'> & { model: string })

/**
 * A ready AI SDK model object (e.g. `openai.image('gpt-image-1')`). A bare string is not taken:
 * it would mean the SDK's global gateway, a provider nobody configured here.
 */
export type MediaImageModel = Exclude<ImageModel, string>
export type MediaSpeechModel = Exclude<SpeechModel, string>
export type MediaTranscriptionModel = Exclude<TranscriptionModel, string>

/**
 * `config.media`: three optional modalities as tools, each mounted only when its model is set -
 * `generate_image`, `generate_speech`, `transcribe_audio` - and the transcription of audio the
 * user attaches to a run. Browser sibling of the server's `IMediaConfig` (same names), except
 * that generated files go to a virtual file system instead of a directory.
 */
export interface IMediaConfig {
  /** Mounts `generate_image` (a prompt becomes an image file in the workspace). */
  imageModel?: MediaImageModel | IMediaModelSpec
  /** Mounts `generate_speech` (text becomes an audio file in the workspace). */
  speechModel?: MediaSpeechModel | IMediaModelSpec
  /**
   * Audio attached to a run (`run(goal, { files })`) is transcribed once and the model reads the
   * text; with a file system it also mounts `transcribe_audio` (an audio file of the workspace).
   */
  transcriptionModel?: MediaTranscriptionModel | IMediaModelSpec
  /**
   * Media calls one run may make, attachments included. Default 8 (`MEDIA_DEFAULT_MAX_CALLS`);
   * 0 = no cap. `maxToolCalls` counts the tool calls as well.
   */
  maxCalls?: number
  /** One call to a media model, in ms. Default 120 000. */
  timeoutMs?: number
  /**
   * Where generated files are written and where `transcribe_audio` reads. Default: the file
   * system of the mounted file tools (`createFileTools(vfs)`). An image or a speech model without
   * either is a configuration error: the bytes must not go to the language model.
   */
  files?: VirtualFileSystem
  /** The folder of that file system generated files go to. Default '/media'. */
  folder?: string
  /** The voice of `generate_speech` when the model names none (provider-specific id). */
  voice?: string
  /** The audio format asked of the speech model ('mp3', 'wav', ...). Default: the provider's. */
  speechFormat?: string
  /**
   * Transcribe audio attachments instead of sending them to the language model (default true).
   * Set false for a model that listens to audio itself and should get the file.
   */
  transcribeAttachments?: boolean
}

/** What `generate_image` / `generate_speech` return: where the file is, never its bytes. */
export interface IMediaFile {
  path: string
  mediaType: string
  bytes: number
}

/** What `transcribe_audio` returns. */
export interface ITranscription {
  path: string
  text: string
  language?: string
  durationInSeconds?: number
  truncated?: true
  untrusted: true
}

/** What a media call can reach of the run that made it (the tool's run context, or the runner). */
export interface IMediaRun {
  emit?: (event: AgentEvent) => void
  step?: IPlanStep
  signal?: AbortSignal
  /** Charge the call to the run (phase 'media'). */
  addUsage?: (usage: IUsage, phase?: 'media') => void
  /** The run's usage so far: the cap counts the media calls in it (a resumed run's included). */
  usage?: () => IUsage
  runId?: string
}

export interface IMedia {
  /** The tools the configured models switch on (maybe none). */
  tools: AgentToolSet
  /** True when audio attachments are transcribed (a transcription model, not switched off). */
  transcribes: boolean
  /**
   * Transcribe the audio among a run's attachments: the goal with the transcripts under it, and
   * the attachments that are left for the language model.
   */
  attach: (
    goal: string,
    files: RunFile[],
    run: IMediaRun,
  ) => Promise<{ goal: string; rest: RunFile[] }>
}

export interface IMediaOptions {
  media: IMediaConfig | undefined
  /** `config.model`: a partial media spec inherits its provider, key reference and endpoint. */
  base?: ModelInput
  credentials?: CredentialStore
  clientName?: string
  /** The agent's host tools: the file system of mounted file tools is the default workspace. */
  tools?: AgentToolSet
}

const isModelObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'specificationVersion' in value

const resolveModel = async (
  o: IMediaOptions,
  input: unknown,
  kind: MediaModelKind,
  field: string,
): Promise<unknown> => {
  if (input === undefined) return undefined
  if (isModelObject(input)) return input
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as { model?: unknown }).model !== 'string'
  ) {
    throw new Error(
      `${field}: pass an AI SDK ${kind} model object or a spec with a "model" id (a bare string is not a model here)`,
    )
  }
  if ((input as { apiKey?: unknown }).apiKey !== undefined) {
    throw new Error(
      `${field}: an inline apiKey is not taken here - keep the key in the CredentialStore and name it with credentialRef`,
    )
  }
  const resolved = resolveStage(o.base as ModelInput, input as ProviderModelSpec, field)
  if (resolved.type !== 'spec') throw new Error(`${field}: not a model spec`)
  return buildMediaModelFromSpec(resolved.spec, kind, o.credentials, o.clientName)
}

const modelIdOf = (model: unknown): string => {
  const id = (model as { modelId?: unknown } | undefined)?.modelId
  return id ? String(id) : 'unknown'
}

const DATA_URL_RE = /^data:([^;,]*);base64,(.*)$/s
const HTTP_RE = /^https?:\/\//i
const AUDIO_EXT = new Set([...Object.values(MEDIA_AUDIO_TYPES), 'mpga', 'mpeg', 'oga', 'opus'])

const fromBase64 = (base64: string, what: string): Uint8Array => {
  // By size before a byte is decoded.
  if (base64.length > Math.ceil((MEDIA_MAX_AUDIO_INPUT_BYTES * 4) / 3) + 4) {
    throw new MediaError(`${what} is larger than the limit (${MEDIA_MAX_AUDIO_INPUT_BYTES} bytes)`)
  }
  let bin: string
  try {
    bin = atob(base64.replace(/\s+/g, ''))
  } catch {
    throw new MediaError(`${what} is not valid base64`)
  }
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** The inline bytes of an attachment, or undefined for a link (nothing is downloaded here). */
const inlineBytes = (file: RunFile, what: string): Uint8Array | undefined => {
  if (file.data instanceof Uint8Array) return file.data
  if (typeof file.data !== 'string' || HTTP_RE.test(file.data)) return undefined
  return fromBase64(DATA_URL_RE.exec(file.data)?.[2] ?? file.data, what)
}

/**
 * Is this attachment audio the agent should transcribe? Said by its declared type, its name or
 * its bytes; whether it really IS audio is then decided by the bytes alone (`acceptMedia`).
 */
const looksLikeAudio = (file: RunFile): boolean => {
  if (file.data instanceof URL || (typeof file.data === 'string' && HTTP_RE.test(file.data))) {
    return false
  }
  const declared =
    file.mediaType ?? (typeof file.data === 'string' ? DATA_URL_RE.exec(file.data)?.[1] : '') ?? ''
  if (declared.toLowerCase().startsWith('audio/')) return true
  const ext = file.name?.split('.').pop()?.toLowerCase()
  if (ext && file.name?.includes('.') && AUDIO_EXT.has(ext)) return true
  if (declared) return false
  if (file.data instanceof Uint8Array) {
    return Boolean(sniffMediaType(file.data)?.startsWith('audio/'))
  }
  // Undeclared base64: look at its first bytes only.
  try {
    const head = fromBase64(String(file.data).slice(0, 24), 'the file')
    return Boolean(sniffMediaType(head)?.startsWith('audio/'))
  } catch {
    return false
  }
}

/**
 * Build what `config.media` switches on. Undefined when it names no model: no tool, no prompt
 * text, nothing loaded.
 */
export const createMedia = async (o: IMediaOptions): Promise<IMedia | undefined> => {
  const media = o.media
  if (!media) return undefined
  const [image, speech, transcription] = (await Promise.all([
    resolveModel(o, media.imageModel, 'image', 'media.imageModel'),
    resolveModel(o, media.speechModel, 'speech', 'media.speechModel'),
    resolveModel(o, media.transcriptionModel, 'transcription', 'media.transcriptionModel'),
  ])) as [
    MediaImageModel | undefined,
    MediaSpeechModel | undefined,
    MediaTranscriptionModel | undefined,
  ]
  if (!image && !speech && !transcription) return undefined

  const maxCalls = resolveMediaMaxCalls(media.maxCalls)
  const timeoutMs = resolveMediaTimeout(media.timeoutMs)
  const folder = mediaFolder(media.folder)
  const voice = media.voice === undefined ? undefined : mediaToken(media.voice)
  if (media.voice !== undefined && !voice) throw new Error('media.voice must be a plain voice id')
  const speechFormat = media.speechFormat === undefined ? undefined : mediaToken(media.speechFormat)
  if (media.speechFormat !== undefined && !speechFormat) {
    throw new Error('media.speechFormat must be a plain format name, e.g. "mp3"')
  }
  // The workspace: the host's, else the one the mounted file tools are bound to.
  const vfs =
    media.files ??
    Object.values(o.tools ?? {})
      .map(fileToolBindingOf)
      .find((b) => b !== undefined)?.vfs
  if ((image || speech) && !vfs) {
    throw new Error(
      'media: an image or speech model needs a file system to write to - pass media.files (a VirtualFileSystem) or mount createFileTools(vfs). The bytes are never sent to the language model.',
    )
  }

  // Calls in flight per run (the finished ones are in the run's usage). An entry lives only
  // while its run has a call in flight.
  const budgets = new Map<string, { budget: IMediaBudget; active: number }>()
  // Calls made outside a run (a tool executed directly): the cap still holds, per agent.
  const loose = { budget: createMediaBudget(maxCalls), spent: 0 }

  const reserve = (run: IMediaRun): (() => void) => {
    if (!run.runId || !run.usage) {
      const release = loose.budget.reserve(loose.spent)
      return () => {
        loose.spent += 1
        release()
      }
    }
    const id = run.runId
    const entry = budgets.get(id) ?? { budget: createMediaBudget(maxCalls), active: 0 }
    const release = entry.budget.reserve(run.usage().mediaCalls ?? 0)
    entry.active += 1
    budgets.set(id, entry)
    return () => {
      release()
      entry.active -= 1
      if (entry.active <= 0) budgets.delete(id)
    }
  }

  /** One call to a media model: the run's budget, the abort signal, the timeout, the usage. */
  const call = async <T>(
    name: string,
    run: IMediaRun,
    signal: AbortSignal | undefined,
    make: (signal: AbortSignal) => Promise<T>,
    units: (result: T) => Partial<IMediaUsage>,
  ): Promise<T> => {
    const stop = signal ?? run.signal
    stop?.throwIfAborted()
    const release = reserve(run)
    const timeout = AbortSignal.timeout(timeoutMs)
    const both = stop ? AbortSignal.any([stop, timeout]) : timeout
    let spent: Partial<IMediaUsage> = {}
    try {
      // Raced against the signal: a model that ignores it still ends the call here.
      const result = await Promise.race([
        make(both),
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(both.reason ?? new DOMException('Aborted', 'AbortError'))
          if (both.aborted) onAbort()
          else both.addEventListener('abort', onAbort, { once: true })
        }),
      ])
      spent = units(result)
      return result
    } catch (err) {
      if (timeout.aborted && !stop?.aborted) {
        throw new MediaError(`${name} timed out after ${timeoutMs} ms`)
      }
      throw err
    } finally {
      // Counted whether it worked or not: the call was made. Counted before the reservation is
      // released, so the cap never sees fewer calls than were made.
      run.addUsage?.(
        {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          ...emptyMediaUsage(),
          mediaCalls: 1,
          ...spent,
        },
        'media',
      )
      release()
    }
  }

  const save = async (
    kind: 'image' | 'speech',
    bytes: Uint8Array,
    model: unknown,
    run: IMediaRun,
  ): Promise<IMediaFile> => {
    const accepted = acceptMedia(
      kind === 'image' ? 'image' : 'audio',
      bytes,
      kind === 'image' ? MEDIA_MAX_IMAGE_BYTES : MEDIA_MAX_SPEECH_BYTES,
      kind === 'image' ? 'the generated image' : 'the generated audio',
    )
    const fs = vfs as VirtualFileSystem
    const path = `${folder}/${mediaFileName(kind, accepted.ext)}`
    // Belt and braces: the name is ours, and it still must be a file of the folder itself.
    if (normalizePath(path) !== path || path.slice(folder.length + 1).includes('/')) {
      throw new MediaError('media: refused to write outside the media folder')
    }
    // A file that exists is never replaced.
    if (await fs.read(path)) throw new MediaError('media: the file name is taken; try again')
    const info = await fs.write(path, bytes, { mimeType: accepted.mediaType })
    const saved: IMediaFile = { path: info.path, mediaType: accepted.mediaType, bytes: info.size }
    run.emit?.({
      type: 'media.generated',
      kind,
      ...saved,
      model: modelIdOf(model),
      ...(run.step ? { step: run.step } : {}),
    })
    return saved
  }

  const transcribeBytes = (
    bytes: Uint8Array,
    what: string,
    run: IMediaRun,
    signal: AbortSignal | undefined,
  ) => {
    acceptMedia('audio', bytes, MEDIA_MAX_AUDIO_INPUT_BYTES, what)
    return call(
      TRANSCRIBE_AUDIO_TOOL,
      run,
      signal,
      (abortSignal) =>
        transcribe({
          model: transcription as MediaTranscriptionModel,
          audio: bytes,
          maxRetries: 0,
          abortSignal,
        }),
      (r) => ({ transcriptionSeconds: r.durationInSeconds ?? 0 }),
    )
  }

  const runOf = (options: unknown): IMediaRun => toolRunContextOf(options) ?? {}
  const signalOf = (options: unknown): AbortSignal | undefined =>
    (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal

  const tools: AgentToolSet = {}

  if (image) {
    tools[GENERATE_IMAGE_TOOL] = defineTool({
      description: generateImageDescription(`in the workspace folder ${folder}`),
      inputSchema: z.object({
        prompt: z.string().min(1).max(MEDIA_MAX_PROMPT_CHARS).describe('What the image shows'),
        size: z.string().optional().describe('Optional size, "WIDTHxHEIGHT", e.g. "1024x1024"'),
        aspectRatio: z.string().optional().describe('Optional aspect ratio, e.g. "16:9"'),
      }),
      promptHint: '{ prompt: string, size?: "1024x1024", aspectRatio?: "16:9" }',
      execute: async ({ prompt, size, aspectRatio }, options): Promise<IMediaFile> => {
        const text = cleanMediaText(prompt)
        if (!text) throw new MediaError(`${GENERATE_IMAGE_TOOL}: a prompt is required`)
        if (text.length > MEDIA_MAX_PROMPT_CHARS) {
          throw new MediaError(
            `${GENERATE_IMAGE_TOOL}: the prompt is ${text.length} characters; the limit is ${MEDIA_MAX_PROMPT_CHARS}`,
          )
        }
        if (size !== undefined && !mediaSize(size)) {
          throw new MediaError(`${GENERATE_IMAGE_TOOL}: size must look like "1024x1024"`)
        }
        if (aspectRatio !== undefined && !mediaAspectRatio(aspectRatio)) {
          throw new MediaError(`${GENERATE_IMAGE_TOOL}: aspectRatio must look like "16:9"`)
        }
        const run = runOf(options)
        const result = await call(
          GENERATE_IMAGE_TOOL,
          run,
          signalOf(options),
          (signal) =>
            generateImage({
              model: image,
              prompt: text,
              n: 1,
              ...(mediaSize(size) ? { size: mediaSize(size) } : {}),
              ...(mediaAspectRatio(aspectRatio)
                ? { aspectRatio: mediaAspectRatio(aspectRatio) }
                : {}),
              maxRetries: 0,
              abortSignal: signal,
            }),
          () => ({ imagesGenerated: 1 }),
        )
        return save('image', result.image.uint8Array, image, run)
      },
    })
  }

  if (speech) {
    tools[GENERATE_SPEECH_TOOL] = defineTool({
      description: generateSpeechDescription(`in the workspace folder ${folder}`),
      inputSchema: z.object({
        text: z.string().min(1).max(MEDIA_MAX_SPEECH_CHARS).describe('The text to speak'),
        voice: z
          .string()
          .optional()
          .describe('A voice id of the speech service - only when the user named one'),
        language: z.string().optional().describe('Optional language code, e.g. "en"'),
      }),
      promptHint: '{ text: string, voice?: string, language?: string }',
      execute: async ({ text, voice: asked, language }, options): Promise<IMediaFile> => {
        const spoken = cleanMediaText(text)
        if (!spoken) throw new MediaError(`${GENERATE_SPEECH_TOOL}: the text is empty`)
        if (spoken.length > MEDIA_MAX_SPEECH_CHARS) {
          throw new MediaError(
            `${GENERATE_SPEECH_TOOL}: the text is ${spoken.length} characters; the limit is ${MEDIA_MAX_SPEECH_CHARS}`,
          )
        }
        if (asked !== undefined && !mediaToken(asked)) {
          throw new MediaError(`${GENERATE_SPEECH_TOOL}: voice must be a plain voice id`)
        }
        if (language !== undefined && !mediaToken(language)) {
          throw new MediaError(`${GENERATE_SPEECH_TOOL}: language must be a code like "en"`)
        }
        const useVoice = mediaToken(asked) ?? voice
        const run = runOf(options)
        const result = await call(
          GENERATE_SPEECH_TOOL,
          run,
          signalOf(options),
          (signal) =>
            generateSpeech({
              model: speech,
              text: spoken,
              ...(useVoice ? { voice: useVoice } : {}),
              ...(speechFormat ? { outputFormat: speechFormat } : {}),
              ...(mediaToken(language) ? { language: mediaToken(language) } : {}),
              maxRetries: 0,
              abortSignal: signal,
            }),
          () => ({ speechCharacters: spoken.length }),
        )
        return save('speech', result.audio.uint8Array, speech, run)
      },
    })
  }

  if (transcription && vfs) {
    tools[TRANSCRIBE_AUDIO_TOOL] = defineTool({
      description: transcribeAudioDescription('of the workspace (by its path)'),
      inputSchema: z.object({
        path: z.string().min(1).max(1024).describe('Absolute path, e.g. "/attachments/memo.mp3"'),
      }),
      promptHint: '{ path: string }',
      execute: async ({ path: asked }, options): Promise<ITranscription> => {
        // normalizePath refuses a path that leaves the root; the workspace has no other files.
        const file = typeof asked === 'string' && asked ? await vfs.read(asked) : undefined
        if (!file) {
          throw new MediaError(
            `${TRANSCRIBE_AUDIO_TOOL}: no file "${mediaLabel(asked, 'the path')}" in the workspace`,
          )
        }
        // By size before a byte is decoded.
        if (file.size > MEDIA_MAX_AUDIO_INPUT_BYTES) {
          throw new MediaError(
            `${TRANSCRIBE_AUDIO_TOOL}: the file is ${file.size} bytes; the limit is ${MEDIA_MAX_AUDIO_INPUT_BYTES}`,
          )
        }
        if (file.encoding !== 'base64') {
          throw new MediaError(`${TRANSCRIBE_AUDIO_TOOL}: "${file.path}" is a text file, not audio`)
        }
        const bytes = fromBase64(file.content, 'the file')
        const run = runOf(options)
        const result = await transcribeBytes(bytes, 'the file', run, signalOf(options))
        const clean = cleanTranscript(result.text)
        const facts = {
          ...(result.language ? { language: result.language } : {}),
          ...(result.durationInSeconds ? { durationInSeconds: result.durationInSeconds } : {}),
        }
        run.emit?.({
          type: 'media.transcribed',
          source: 'tool',
          name: file.path,
          text: clean.text,
          ...facts,
          model: modelIdOf(transcription),
        })
        return {
          path: file.path,
          text: clean.text,
          ...facts,
          ...(clean.truncated ? { truncated: true as const } : {}),
          untrusted: true,
        }
      },
    })
  }

  const transcribes = Boolean(transcription) && media.transcribeAttachments !== false

  const attach: IMedia['attach'] = async (goal, files, run) => {
    const audio = transcribes ? files.filter(looksLikeAudio) : []
    if (audio.length === 0) return { goal, rest: files }
    if (audio.length > MEDIA_MAX_ATTACHED_AUDIO) {
      throw new MediaError(
        `${audio.length} audio files attached; a run takes at most ${MEDIA_MAX_ATTACHED_AUDIO}`,
      )
    }
    // Everything is checked before the first call is paid for.
    const prepared = audio.map((file, i) => {
      const name = mediaLabel(file.name, `audio ${i + 1}`)
      const what = `the attached file "${name}"`
      const bytes = inlineBytes(file, what) as Uint8Array
      acceptMedia('audio', bytes, MEDIA_MAX_AUDIO_INPUT_BYTES, what)
      return { name, what, bytes }
    })
    const blocks: ITranscriptBlock[] = []
    for (const { name, what, bytes } of prepared) {
      const result = await transcribeBytes(bytes, what, run, run.signal)
      const facts = {
        ...(result.language ? { language: result.language } : {}),
        ...(result.durationInSeconds ? { durationInSeconds: result.durationInSeconds } : {}),
      }
      run.emit?.({
        type: 'media.transcribed',
        source: 'attachment',
        name,
        text: cleanTranscript(result.text).text,
        ...facts,
        model: modelIdOf(transcription),
      })
      blocks.push({ name, text: result.text, ...facts })
    }
    return {
      goal: withTranscripts(goal, blocks),
      rest: files.filter((f) => !audio.includes(f)),
    }
  }

  return { tools, transcribes, attach }
}
