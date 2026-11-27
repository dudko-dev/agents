import { MEDIA_IMAGE_TYPES, isTextMime } from '@dudko.dev/agent-web'

/**
 * What a workspace file is to the UI. `image` is only what the core's media tools accept
 * (PNG / JPEG / GIF / WebP - never SVG, which is shown as its source); `file` is anything that
 * cannot be shown as text: a chip with a download and no preview.
 */
export type FileKind = 'html' | 'markdown' | 'csv' | 'json' | 'image' | 'code' | 'text' | 'file'

const CODE =
  /\.(?:js|mjs|cjs|jsx|ts|tsx|css|scss|py|rb|go|rs|java|kt|c|h|cpp|cs|php|sh|sql|xml|svg|yaml|yml|toml)$/i

const mimeOf = (mediaType: string): string => mediaType.toLowerCase().split(';')[0].trim()

/** The kind of a file, by its MIME type first and its extension second. */
export const fileKindOf = (path: string, mediaType: string): FileKind => {
  const mime = mimeOf(mediaType)
  if (Object.hasOwn(MEDIA_IMAGE_TYPES, mime)) return 'image'
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || /\.x?html?$/i.test(path))
    return 'html'
  if (mime === 'text/markdown' || /\.(?:md|markdown)$/i.test(path)) return 'markdown'
  if (mime === 'text/csv' || /\.(?:csv|tsv)$/i.test(path)) return 'csv'
  if (mime === 'application/json' || /\.json$/i.test(path)) return 'json'
  if (CODE.test(path)) return 'code'
  if (mime === 'text/plain' || /\.(?:txt|log)$/i.test(path) || isTextMime(mime)) return 'text'
  return 'file'
}

/** The last segment of a path: what a chip is called and what a download is saved as. */
export const fileNameOf = (path: string): string => path.split('/').filter(Boolean).pop() || 'file'
