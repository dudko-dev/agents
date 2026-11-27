import { useEffect, useState } from 'react'
import { MEDIA_AUDIO_TYPES, MEDIA_IMAGE_TYPES, type VirtualFileSystem } from '@dudko.dev/agent-web'
import { useLabels, type AgentLabelsOverride } from '../labels.js'
import type { MediaView, TranscriptView } from '../types.js'
import { FileIcon } from './icons.js'

/**
 * How a generated file may be shown: only the types the core's media tools accept
 * (PNG / JPEG / GIF / WebP, and its audio list). Anything else - SVG included - is a file chip.
 */
export const mediaFamilyOf = (mediaType: string): 'image' | 'audio' | undefined => {
  const type = mediaType.toLowerCase().split(';')[0].trim()
  if (Object.hasOwn(MEDIA_IMAGE_TYPES, type)) return 'image'
  if (Object.hasOwn(MEDIA_AUDIO_TYPES, type)) return 'audio'
  return undefined
}

/** The bytes of a workspace file (its content is text, or base64). */
export const bytesOf = (content: string, encoding: string): Uint8Array<ArrayBuffer> => {
  if (encoding !== 'base64') return new TextEncoder().encode(content)
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * An object URL of a workspace file, typed as `mediaType` (never as whatever the file says it
 * is), revoked when the file, the workspace or the component goes away.
 */
export const useFileUrl = (
  files: VirtualFileSystem | undefined,
  path: string,
  mediaType: string | undefined,
): string | undefined => {
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!files || !mediaType) return
    let made: string | undefined
    let gone = false
    files
      .read(path)
      .then((file) => {
        if (gone || !file) return
        made = URL.createObjectURL(
          new Blob([bytesOf(file.content, file.encoding)], { type: mediaType }),
        )
        setUrl(made)
      })
      .catch(() => {
        /* the chip stays */
      })
    return () => {
      gone = true
      if (made) URL.revokeObjectURL(made)
      setUrl(undefined)
    }
  }, [files, path, mediaType])
  return url
}

export interface GeneratedMediaProps {
  media: MediaView
  /** The workspace the file is in (the core's `VirtualFileSystem`). Without it: a file chip. */
  files?: VirtualFileSystem
  labels?: AgentLabelsOverride
}

/**
 * A file a media tool wrote, read from the workspace: an image inline, audio as a native
 * player. A type the core does not generate, a missing file or no workspace gives a chip with
 * the path.
 */
export const GeneratedMedia = ({ media, files, labels }: GeneratedMediaProps) => {
  const L = useLabels(labels)
  const family = mediaFamilyOf(media.mediaType)
  const type = family ? media.mediaType.toLowerCase().split(';')[0].trim() : undefined
  const url = useFileUrl(files, media.path, type)
  if (url && family === 'image') {
    return (
      <a
        className="awr-media awr-media--image"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={media.path}
      >
        <img className="awr-media__img" src={url} alt={L.mediaImage(media.path)} />
      </a>
    )
  }
  if (url && family === 'audio') {
    return (
      <span className="awr-media awr-media--audio" title={media.path}>
        <audio
          className="awr-media__audio"
          controls
          preload="metadata"
          src={url}
          aria-label={L.mediaAudio(media.path)}
        />
      </span>
    )
  }
  return (
    <span className="awr-chip awr-file awr-media awr-media--file" title={L.mediaFile(media.path)}>
      <FileIcon size={13} /> {media.path}
    </span>
  )
}

export interface TranscriptBlockProps {
  transcript: TranscriptView
  labels?: AgentLabelsOverride
}

/**
 * What an audio file said, folded: "Transcript of memo.mp3". The text is the content of the
 * user's file - shown as plain text and marked as such.
 */
export const TranscriptBlock = ({ transcript, labels }: TranscriptBlockProps) => {
  const L = useLabels(labels)
  return (
    <details className="awr-transcript">
      <summary className="awr-transcript__summary">
        <FileIcon size={13} /> {L.transcriptOf(transcript.name)}
      </summary>
      <p className="awr-transcript__note">{L.transcriptNote}</p>
      <blockquote className="awr-transcript__text">{transcript.text}</blockquote>
    </details>
  )
}
