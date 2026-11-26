// `config.media`: three optional modalities as tools - generate_image, generate_speech,
// transcribe_audio - and the transcription of audio the user attaches to a run. Each exists only
// when its model is configured; with none, nothing is created and no prompt changes.
//
// The models are the AI SDK's own (ImageModel / SpeechModel / TranscriptionModel, called through
// generateImage / generateSpeech / transcribe), given directly or as a stage block resolved by
// the same provider factory as the language models.
//
// Bytes never go to the language model: a generated file is written under the run's directory
// (or `media.dir`) and the model gets its path. What the bytes ARE is read from the bytes
// (media-shared.ts), file names are made here, and every call is counted against a per-run cap.
import {
  generateImage,
  generateSpeech,
  tool,
  transcribe,
  type ImageModel,
  type SpeechModel,
  type Tool,
  type ToolSet,
  type TranscriptionModel,
} from 'ai'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { runContext } from './context.ts'
import type { IRunState } from './internal.ts'
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
  MEDIA_FOLDER,
  MEDIA_MAX_ATTACHED_AUDIO,
  MEDIA_MAX_AUDIO_INPUT_BYTES,
  MEDIA_MAX_IMAGE_BYTES,
  MEDIA_MAX_PROMPT_CHARS,
  MEDIA_MAX_SPEECH_BYTES,
  MEDIA_MAX_SPEECH_CHARS,
  mediaAspectRatio,
  MediaError,
  mediaFileName,
  mediaLabel,
  mediaSize,
  mediaToken,
  resolveMediaMaxCalls,
  resolveMediaTimeout,
  TRANSCRIBE_AUDIO_TOOL,
  transcribeAudioDescription,
  withTranscripts,
  type IMediaBudget,
  type IMediaUsage,
  type ITranscriptBlock,
  type MediaKind,
} from './media-shared.ts'
import { buildMediaModelFromStage, resolveStage, type MediaModelKind } from './provider.ts'
import type { AgentEvent, IAgentConfig, IAgentStageOverride } from './types.ts'

// A media model as a stage block: like `planner` (omitted fields inherit the top-level provider,
// key and baseURL), with the model id required.
export type IMediaModelSpec = IAgentStageOverride & { model: string }

// A ready AI SDK model object (e.g. `openai.image('gpt-image-1')`). A bare string is not taken:
// it would mean the SDK's global gateway, a provider nobody configured here.
export type MediaImageModel = Exclude<ImageModel, string>
export type MediaSpeechModel = Exclude<SpeechModel, string>
export type MediaTranscriptionModel = Exclude<TranscriptionModel, string>

export interface IMediaConfig {
  // Mounts `generate_image` (a prompt becomes an image file).
  imageModel?: MediaImageModel | IMediaModelSpec
  // Mounts `generate_speech` (text becomes an audio file).
  speechModel?: MediaSpeechModel | IMediaModelSpec
  // Mounts `transcribe_audio` (an audio file of the run's directory becomes text), and lets a run
  // take audio attachments (`run({ files })`): each is transcribed once and the model reads the text.
  transcriptionModel?: MediaTranscriptionModel | IMediaModelSpec
  // Media calls one run may make, attachments included. Default 8 (MEDIA_DEFAULT_MAX_CALLS);
  // 0 = no cap. `maxToolCalls` counts the tool calls as well.
  maxCalls?: number
  // One call to a media model, in ms. Default 120_000.
  timeoutMs?: number
  // Where generated files are written. Default: `<sandboxRoot>/<runId>/media/`, removed with the
  // run's directory unless `keepSandbox` - set `dir` to keep them (the host cleans it up).
  dir?: string
  // The voice of `generate_speech` when the model names none (provider-specific id).
  voice?: string
  // The audio format asked of the speech model ('mp3', 'wav', ...). Default: the provider's.
  speechFormat?: string
}

// An attachment of a run. The Node agent takes AUDIO only (it is transcribed); `data` is bytes,
// base64 or a data URL.
export interface IRunFile {
  data: string | Uint8Array
  // Informational: what the file is, is read from its bytes.
  mediaType?: string
  // Shown to the model as the file's label, and in events.
  name?: string
}

export interface IMediaFile {
  path: string
  mediaType: string
  bytes: number
}

export interface ITranscription {
  path: string
  text: string
  language?: string
  durationInSeconds?: number
  truncated?: true
  untrusted: true
}

interface IModels {
  image?: MediaImageModel
  speech?: MediaSpeechModel
  transcription?: MediaTranscriptionModel
}

export interface IMedia {
  // The tools the configured models switch on (maybe none: a transcription model alone still
  // mounts transcribe_audio).
  tools: ToolSet
  // The run's input with the transcripts of its audio attachments under it.
  attach: (input: string, files: IRunFile[], signal?: AbortSignal) => Promise<string>
}

const isModelObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'specificationVersion' in value

const resolveModel = async (
  config: IAgentConfig,
  input: unknown,
  kind: MediaModelKind,
  field: string,
): Promise<unknown> => {
  if (input === undefined) {
    return undefined
  }
  if (isModelObject(input)) {
    return input
  }
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as IMediaModelSpec).model !== 'string'
  ) {
    throw new Error(
      `${field}: pass an AI SDK ${kind} model object or a block with a "model" id (a bare string is not a model here)`,
    )
  }
  const stage = resolveStage(config, input as IMediaModelSpec, undefined, field)
  return buildMediaModelFromStage(config.clientName, stage, kind)
}

const modelIdOf = (model: unknown): string =>
  (model as { modelId?: unknown } | undefined)?.modelId
    ? String((model as { modelId: unknown }).modelId)
    : 'unknown'

const DATA_URL_RE = /^data:[^;,]*;base64,(.*)$/s

// The bytes of an attachment, refused by size BEFORE they are decoded.
const bytesOf = (file: IRunFile, what: string): Uint8Array => {
  if (file?.data instanceof Uint8Array) {
    return file.data
  }
  if (typeof file?.data !== 'string') {
    throw new MediaError(`${what}: data must be bytes, base64 or a data URL`)
  }
  const base64 = DATA_URL_RE.exec(file.data)?.[1] ?? file.data
  if (base64.length > Math.ceil((MEDIA_MAX_AUDIO_INPUT_BYTES * 4) / 3) + 4) {
    throw new MediaError(`${what} is larger than the limit (${MEDIA_MAX_AUDIO_INPUT_BYTES} bytes)`)
  }
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

const inside = (root: string, file: string): boolean =>
  file !== root && file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)

// The run's budget of media calls lives with the run's state (so it ends with the run).
const budgets = new WeakMap<IRunState, IMediaBudget>()

export const createMedia = async (config: IAgentConfig): Promise<IMedia | undefined> => {
  const media = config.media
  if (!media) {
    return undefined
  }
  const [image, speech, transcription] = await Promise.all([
    resolveModel(config, media.imageModel, 'image', 'media.imageModel'),
    resolveModel(config, media.speechModel, 'speech', 'media.speechModel'),
    resolveModel(config, media.transcriptionModel, 'transcription', 'media.transcriptionModel'),
  ])
  const models: IModels = {
    ...(image ? { image: image as MediaImageModel } : {}),
    ...(speech ? { speech: speech as MediaSpeechModel } : {}),
    ...(transcription ? { transcription: transcription as MediaTranscriptionModel } : {}),
  }
  if (!models.image && !models.speech && !models.transcription) {
    return undefined
  }
  const maxCalls = resolveMediaMaxCalls(media.maxCalls)
  const timeoutMs = resolveMediaTimeout(media.timeoutMs)
  const hostDir = media.dir?.trim() ? path.resolve(media.dir.trim()) : undefined
  const voice = media.voice === undefined ? undefined : mediaToken(media.voice)
  if (media.voice !== undefined && !voice) {
    throw new Error('media.voice must be a plain voice id')
  }
  const speechFormat = media.speechFormat === undefined ? undefined : mediaToken(media.speechFormat)
  if (media.speechFormat !== undefined && !speechFormat) {
    throw new Error('media.speechFormat must be a plain format name, e.g. "mp3"')
  }
  // Budgets of calls made outside a run (a tool executed directly): the cap still holds per agent.
  const looseBudget = createMediaBudget(maxCalls)

  const emit = (event: AgentEvent): void => runContext.getStore()?.emit?.(event)

  // One call to a media model: the run's budget, the abort signal, the timeout, the usage.
  const call = async <T>(
    name: string,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
    units: (result: T) => Partial<IMediaUsage>,
  ): Promise<T> => {
    signal?.throwIfAborted()
    const state = runContext.getStore()?.state
    let budget = looseBudget
    if (state) {
      budget = budgets.get(state) ?? createMediaBudget(maxCalls)
      budgets.set(state, budget)
    }
    const release = budget.reserve(state?.usage.mediaCalls ?? 0)
    const timeout = AbortSignal.timeout(timeoutMs)
    const both = signal ? AbortSignal.any([signal, timeout]) : timeout
    let spent: Partial<IMediaUsage> = {}
    try {
      // Raced against the signal: a model that ignores it still ends the call here.
      const result = await Promise.race([
        run(both),
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(both.reason ?? new DOMException('Aborted', 'AbortError'))
          if (both.aborted) {
            onAbort()
          } else {
            both.addEventListener('abort', onAbort, { once: true })
          }
        }),
      ])
      spent = units(result)
      return result
    } catch (err) {
      if (timeout.aborted && !signal?.aborted) {
        throw new MediaError(`${name} timed out after ${timeoutMs} ms`)
      }
      throw err
    } finally {
      // Counted whether it worked or not: the call was made. Counted before the reservation is
      // released, so the cap never sees fewer calls than were made.
      emit({
        type: 'usage',
        phase: 'media',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          ...emptyMediaUsage(),
          mediaCalls: 1,
          ...spent,
        },
      })
      release()
    }
  }

  // Where a generated file goes: the host's directory, else the run's own.
  const outDir = (): string => {
    if (hostDir) {
      return hostDir
    }
    const sandbox = runContext.getStore()?.sandboxDir
    if (!sandbox) {
      throw new MediaError('media: no run directory to write to (set media.dir)')
    }
    return path.join(sandbox, MEDIA_FOLDER)
  }

  const save = async (
    kind: 'image' | 'speech',
    bytes: Uint8Array,
    model: unknown,
  ): Promise<IMediaFile> => {
    const accepted = acceptMedia(
      kind === 'image' ? 'image' : 'audio',
      bytes,
      kind === 'image' ? MEDIA_MAX_IMAGE_BYTES : MEDIA_MAX_SPEECH_BYTES,
      kind === 'image' ? 'the generated image' : 'the generated audio',
    )
    const dir = outDir()
    const file = path.join(dir, mediaFileName(kind, accepted.ext))
    // Belt and braces: the name is ours, and it still must land in the folder itself.
    if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
      throw new MediaError('media: refused to write outside the media folder')
    }
    await mkdir(dir, { recursive: true })
    // 'wx': a file that exists is never replaced.
    await writeFile(file, bytes, { flag: 'wx' })
    const saved: IMediaFile = { path: file, mediaType: accepted.mediaType, bytes: bytes.length }
    emit({
      type: 'media.generated',
      kind,
      ...saved,
      model: modelIdOf(model),
      ...(runContext.getStore()?.currentStep ? { step: runContext.getStore()?.currentStep } : {}),
    })
    return saved
  }

  const transcribeBytes = async (
    bytes: Uint8Array,
    what: string,
    signal: AbortSignal | undefined,
  ) => {
    acceptMedia('audio', bytes, MEDIA_MAX_AUDIO_INPUT_BYTES, what)
    return call(
      TRANSCRIBE_AUDIO_TOOL,
      signal,
      (abortSignal) =>
        transcribe({
          model: models.transcription as MediaTranscriptionModel,
          audio: bytes,
          maxRetries: 0,
          abortSignal,
        }),
      (r) => ({ transcriptionSeconds: r.durationInSeconds ?? 0 }),
    )
  }

  const tools: ToolSet = {}

  if (models.image) {
    tools[GENERATE_IMAGE_TOOL] = tool({
      description: generateImageDescription("in the run's media folder"),
      inputSchema: z.object({
        prompt: z.string().min(1).max(MEDIA_MAX_PROMPT_CHARS).describe('What the image shows'),
        size: z.string().optional().describe('Optional size, "WIDTHxHEIGHT", e.g. "1024x1024"'),
        aspectRatio: z.string().optional().describe('Optional aspect ratio, e.g. "16:9"'),
      }),
      execute: async ({ prompt, size, aspectRatio }, { abortSignal }): Promise<IMediaFile> => {
        const text = cleanMediaText(prompt)
        if (!text) {
          throw new MediaError(`${GENERATE_IMAGE_TOOL}: a prompt is required`)
        }
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
        const result = await call(
          GENERATE_IMAGE_TOOL,
          abortSignal,
          (signal) =>
            generateImage({
              model: models.image as MediaImageModel,
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
        return save('image', result.image.uint8Array, models.image)
      },
    }) as Tool
  }

  if (models.speech) {
    tools[GENERATE_SPEECH_TOOL] = tool({
      description: generateSpeechDescription("in the run's media folder"),
      inputSchema: z.object({
        text: z.string().min(1).max(MEDIA_MAX_SPEECH_CHARS).describe('The text to speak'),
        voice: z
          .string()
          .optional()
          .describe('A voice id of the speech service - only when the user named one'),
        language: z.string().optional().describe('Optional language code, e.g. "en"'),
      }),
      execute: async ({ text, voice: asked, language }, { abortSignal }): Promise<IMediaFile> => {
        const spoken = cleanMediaText(text)
        if (!spoken) {
          throw new MediaError(`${GENERATE_SPEECH_TOOL}: the text is empty`)
        }
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
        const result = await call(
          GENERATE_SPEECH_TOOL,
          abortSignal,
          (signal) =>
            generateSpeech({
              model: models.speech as MediaSpeechModel,
              text: spoken,
              ...(useVoice ? { voice: useVoice } : {}),
              ...(speechFormat ? { outputFormat: speechFormat } : {}),
              ...(mediaToken(language) ? { language: mediaToken(language) } : {}),
              maxRetries: 0,
              abortSignal: signal,
            }),
          () => ({ speechCharacters: spoken.length }),
        )
        return save('speech', result.audio.uint8Array, models.speech)
      },
    }) as Tool
  }

  if (models.transcription) {
    tools[TRANSCRIBE_AUDIO_TOOL] = tool({
      description: transcribeAudioDescription(
        "of this run's directory (a file a tool saved there, by the path it returned)",
      ),
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .max(1024)
          .describe('The path of the audio file, as a tool returned it'),
      }),
      execute: async ({ path: asked }, { abortSignal }): Promise<ITranscription> => {
        const sandbox = runContext.getStore()?.sandboxDir
        const roots = [sandbox, hostDir].filter((r): r is string => Boolean(r))
        if (typeof asked !== 'string' || !asked || asked.includes('\0') || roots.length === 0) {
          throw new MediaError(`${TRANSCRIBE_AUDIO_TOOL}: no such file in this run's directory`)
        }
        // Resolved THROUGH symlinks on both sides, then compared: a link inside the run's
        // directory that points out of it is outside.
        let file: string | undefined
        for (const root of roots) {
          try {
            const realRoot = await realpath(root)
            const real = await realpath(path.resolve(root, asked))
            if (inside(realRoot, real)) {
              file = real
              break
            }
          } catch {
            /* not there under this root */
          }
        }
        if (!file) {
          throw new MediaError(
            `${TRANSCRIBE_AUDIO_TOOL}: "${mediaLabel(asked, 'the path')}" is not a file of this run's directory`,
          )
        }
        const info = await stat(file)
        if (!info.isFile()) {
          throw new MediaError(`${TRANSCRIBE_AUDIO_TOOL}: not a file`)
        }
        // By size before a byte is read.
        if (info.size > MEDIA_MAX_AUDIO_INPUT_BYTES) {
          throw new MediaError(
            `${TRANSCRIBE_AUDIO_TOOL}: the file is ${info.size} bytes; the limit is ${MEDIA_MAX_AUDIO_INPUT_BYTES}`,
          )
        }
        const bytes = new Uint8Array(await readFile(file))
        const result = await transcribeBytes(bytes, 'the file', abortSignal)
        const clean = cleanTranscript(result.text)
        emit({
          type: 'media.transcribed',
          source: 'tool',
          name: path.basename(file),
          text: clean.text,
          ...(result.language ? { language: result.language } : {}),
          ...(result.durationInSeconds ? { durationInSeconds: result.durationInSeconds } : {}),
          model: modelIdOf(models.transcription),
        })
        return {
          path: file,
          text: clean.text,
          ...(result.language ? { language: result.language } : {}),
          ...(result.durationInSeconds ? { durationInSeconds: result.durationInSeconds } : {}),
          ...(clean.truncated ? { truncated: true as const } : {}),
          untrusted: true,
        }
      },
    }) as Tool
  }

  const attach = async (
    input: string,
    files: IRunFile[],
    signal?: AbortSignal,
  ): Promise<string> => {
    if (!models.transcription) {
      throw new MediaError(
        'this agent cannot take attachments: audio needs media.transcriptionModel (it is transcribed to text)',
      )
    }
    if (files.length > MEDIA_MAX_ATTACHED_AUDIO) {
      throw new MediaError(
        `${files.length} audio files attached; a run takes at most ${MEDIA_MAX_ATTACHED_AUDIO}`,
      )
    }
    // Everything is checked before the first call is paid for.
    const prepared = files.map((file, i) => {
      const name = mediaLabel(file?.name, `audio ${i + 1}`)
      const what = `the attached file "${name}"`
      const bytes = bytesOf(file, what)
      acceptMedia('audio', bytes, MEDIA_MAX_AUDIO_INPUT_BYTES, what)
      return { name, what, bytes }
    })
    const blocks: ITranscriptBlock[] = []
    for (const { name, what, bytes } of prepared) {
      const result = await transcribeBytes(bytes, what, signal)
      const clean = cleanTranscript(result.text)
      emit({
        type: 'media.transcribed',
        source: 'attachment',
        name,
        text: clean.text,
        ...(result.language ? { language: result.language } : {}),
        ...(result.durationInSeconds ? { durationInSeconds: result.durationInSeconds } : {}),
        model: modelIdOf(models.transcription),
      })
      blocks.push({
        name,
        text: result.text,
        ...(result.language ? { language: result.language } : {}),
        ...(result.durationInSeconds ? { durationInSeconds: result.durationInSeconds } : {}),
      })
    }
    return withTranscripts(input, blocks)
  }

  return { tools, attach }
}

// The input of a run that carries attachments. Without a transcription model the run is refused
// before anything is spent: silently dropping the user's file would be worse.
export const attachRunFiles = (
  media: IMedia | undefined,
  input: string,
  files: IRunFile[],
  signal?: AbortSignal,
): Promise<string> => {
  if (!media) {
    return Promise.reject(
      new MediaError(
        'this agent cannot take attachments: audio needs media.transcriptionModel (it is transcribed to text)',
      ),
    )
  }
  return media.attach(input, files, signal)
}

export type { MediaKind }
