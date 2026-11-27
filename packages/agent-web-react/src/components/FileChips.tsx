import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { VirtualFile, VirtualFileSystem } from '@dudko.dev/agent-web'
import { fileKindOf, fileNameOf, type FileKind } from '../file-kinds.js'
import { useVirtualFiles } from '../hooks/use-virtual-files.js'
import {
  HTML_PREVIEW_MAX_CHARS,
  linkedFilesOf,
  tokenizeHtml,
  type SourceToken,
} from '../html-preview.js'
import { useLabels, type AgentLabels, type AgentLabelsOverride } from '../labels.js'
import type { WrittenFileView } from '../types.js'
import {
  ChevronUpIcon,
  CodeIcon,
  DownloadIcon,
  ExpandIcon,
  EyeIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  LockIcon,
  NoNetworkIcon,
  TableIcon,
  XIcon,
} from './icons.js'
import { bytesOf, useFileUrl } from './Media.js'
import { SandboxedFrame } from './SandboxedFrame.js'

/** How an `.html` file is previewed. */
export interface HtmlPreviewOptions {
  /**
   * Let the page's inline scripts run inside the sandbox (default false: a static render). Even
   * with scripts the page has an opaque origin and no network.
   */
  scripts?: boolean
  /** Height of the frame in px (default 300; clamped to 120 - 800). */
  height?: number
}

/** Characters of a text file a preview shows (the rest is cut, and the preview says so). */
export const FILE_PREVIEW_CHARS = 20_000

const textOf = (file: VirtualFile): string =>
  file.encoding === 'base64'
    ? new TextDecoder().decode(bytesOf(file.content, 'base64'))
    : file.content

const KIND_ICON: Record<FileKind, typeof FileIcon> = {
  html: CodeIcon,
  markdown: FileTextIcon,
  csv: TableIcon,
  json: CodeIcon,
  image: ImageIcon,
  code: CodeIcon,
  text: FileTextIcon,
  file: FileIcon,
}

/** Save a workspace file through the browser's download. */
const downloadFile = async (vfs: VirtualFileSystem, path: string): Promise<void> => {
  const file = await vfs.read(path)
  if (!file) return
  // Never typed as what it claims to be: a download, not a document the page could open.
  const url = URL.createObjectURL(
    new Blob([bytesOf(file.content, file.encoding)], { type: 'application/octet-stream' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = fileNameOf(path)
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

interface SegProps<T extends string> {
  value: T
  options: { value: T; label: string; icon?: ReactNode }[]
  onChange: (value: T) => void
  label: string
}

/** A two-way switch (Preview | Source). */
const Seg = <T extends string>({ value, options, onChange, label }: SegProps<T>) => (
  <div className="awr-seg" role="group" aria-label={label}>
    {options.map((o) => (
      <button
        key={o.value}
        type="button"
        className={`awr-seg__opt${o.value === value ? ' is-on' : ''}`}
        aria-pressed={o.value === value}
        onClick={() => onChange(o.value)}
      >
        {o.icon}
        {o.label}
      </button>
    ))}
  </div>
)

const linesOf = (tokens: SourceToken[]): SourceToken[][] => {
  const lines: SourceToken[][] = [[]]
  for (const t of tokens) {
    const parts = t.text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part) lines[lines.length - 1].push({ kind: t.kind, text: part })
    })
  }
  return lines
}

export interface SourceViewProps {
  text: string
  /** Colour it as HTML (default: plain). */
  html?: boolean
  /** Characters shown (default 20 000). */
  maxChars?: number
  labels?: AgentLabelsOverride
  className?: string
}

/**
 * A file's text with line numbers. Always text nodes - the content of a file is never set as
 * markup, whatever it contains.
 */
export const SourceView = ({
  text,
  html = false,
  maxChars = FILE_PREVIEW_CHARS,
  labels,
  className,
}: SourceViewProps) => {
  const L = useLabels(labels)
  const cut = text.length > maxChars
  const shown = cut ? text.slice(0, maxChars) : text
  const lines = useMemo(
    () => linesOf(html ? tokenizeHtml(shown) : [{ kind: 'text', text: shown }]),
    [shown, html],
  )
  return (
    <>
      <pre className={['awr-source', className].filter(Boolean).join(' ')} tabIndex={0}>
        {lines.map((line, i) => (
          <span key={i} className="awr-source__line">
            {line.map((t, k) =>
              t.kind === 'text' ? (
                <Fragment key={k}>{t.text}</Fragment>
              ) : (
                <span key={k} className={`awr-source__${t.kind}`}>
                  {t.text}
                </span>
              ),
            )}
            {'\n'}
          </span>
        ))}
      </pre>
      {cut && <p className="awr-fileview__cut">{L.fileCut(maxChars)}</p>}
    </>
  )
}

interface PreviewProps {
  written: WrittenFileView
  file: VirtualFile
  kind: FileKind
  vfs: VirtualFileSystem
  htmlPreview: HtmlPreviewOptions | false
  renderFileContent?: FileChipsProps['renderFileContent']
  previewChars: number
  onClose: () => void
  L: AgentLabels
}

/** An `.html` file: the page in the sandboxed frame, or its source as text. */
const HtmlPreview = ({ written, file, htmlPreview, previewChars, L }: PreviewProps) => {
  const html = useMemo(() => textOf(file), [file])
  const options = htmlPreview === false ? undefined : htmlPreview
  const tooLarge = html.length > HTML_PREVIEW_MAX_CHARS
  const canFrame = Boolean(options) && !tooLarge
  const [view, setView] = useState<'preview' | 'source'>(canFrame ? 'preview' : 'source')
  const [tall, setTall] = useState(false)
  const showing = canFrame ? view : 'source'
  const scripts = options?.scripts === true
  const height = options?.height ?? 300
  const linked = useMemo(() => (showing === 'preview' ? linkedFilesOf(html) : []), [html, showing])
  return (
    <SandboxedFrame
      className="awr-frame--html"
      title={L.htmlFrameName(written.path)}
      html={showing === 'preview' ? html : undefined}
      scripts={scripts}
      height={tall ? height * 2 : height}
      label={
        <>
          <CodeIcon size={14} className="awr-frame__icon" />
          <span className="awr-frame__titles">
            <span className="awr-frame__title">{L.htmlFrameTitle}</span>
            <span className="awr-frame__badges">
              {showing === 'preview' ? (
                <>
                  <LockIcon size={11} /> {L.htmlSandboxed} · <NoNetworkIcon size={11} />{' '}
                  {L.htmlNoNetwork}
                </>
              ) : (
                L.htmlSourceNote
              )}
            </span>
          </span>
        </>
      }
      actions={
        canFrame ? (
          <>
            <Seg
              label={L.htmlFrameTitle}
              value={showing}
              onChange={setView}
              options={[
                { value: 'preview', label: L.preview, icon: <EyeIcon size={13} /> },
                { value: 'source', label: L.fileSource, icon: <CodeIcon size={13} /> },
              ]}
            />
            <button
              type="button"
              className={`awr-frame__btn${tall ? ' is-on' : ''}`}
              aria-label={tall ? L.htmlShorter : L.htmlTaller}
              title={tall ? L.htmlShorter : L.htmlTaller}
              aria-pressed={tall}
              disabled={showing !== 'preview'}
              onClick={() => setTall((t) => !t)}
            >
              <ExpandIcon size={15} />
            </button>
          </>
        ) : undefined
      }
      footer={
        <>
          <FileIcon size={11} />
          <code>{written.path}</code>
          <span className="awr-frame__footmeta">
            · {L.bytes(file.size)} ·{' '}
            {showing === 'preview' ? L.htmlScripts(scripts) : L.fileLines(html.split('\n').length)}
            {linked.length > 0 ? ` · ${L.htmlLinkedFiles(linked.join(', '))}` : ''}
          </span>
        </>
      }
    >
      {showing === 'source' ? (
        <>
          {tooLarge && options ? <p className="awr-fileview__cut">{L.htmlTooLarge}</p> : null}
          <SourceView text={html} html maxChars={previewChars} className="awr-frame__source" />
        </>
      ) : undefined}
    </SandboxedFrame>
  )
}

/** A picture, typed as one of the image types the core writes (never as what the file claims). */
const ImagePreview = ({ written, vfs, onClose, L }: PreviewProps) => {
  const url = useFileUrl(vfs, written.path, written.mediaType.toLowerCase().split(';')[0].trim())
  return (
    <div className="awr-fileview">
      <FileViewHead written={written} kind="image" onClose={onClose} L={L} />
      <div className="awr-fileview__image">
        {url ? <img src={url} alt={fileNameOf(written.path)} /> : null}
      </div>
    </div>
  )
}

const FileViewHead = ({
  written,
  kind,
  onClose,
  L,
  children,
}: {
  written: WrittenFileView
  kind: FileKind
  onClose: () => void
  L: AgentLabels
  children?: ReactNode
}) => (
  <div className="awr-fileview__head">
    <span className="awr-fileview__name" title={written.path}>
      {fileNameOf(written.path)}
    </span>
    <span className="awr-fileview__kind">· {L.fileKinds[kind]}</span>
    <span className="awr-fileview__actions">
      {children}
      <button
        type="button"
        className="awr-iconbtn"
        aria-label={L.closePreview}
        title={L.closePreview}
        onClick={onClose}
      >
        <XIcon size={14} />
      </button>
    </span>
  </div>
)

/** Text, Markdown, CSV, JSON, code: the source - and the host's rendering of it, when it has one. */
const TextPreview = ({
  written,
  file,
  kind,
  renderFileContent,
  previewChars,
  onClose,
  L,
}: PreviewProps) => {
  const text = useMemo(() => textOf(file), [file])
  const rendered = useMemo(
    () => renderFileContent?.(written, text.slice(0, previewChars)),
    [renderFileContent, written, text, previewChars],
  )
  const hasRendered = rendered !== undefined && rendered !== null && rendered !== false
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [all, setAll] = useState(false)
  const showing = hasRendered ? view : 'source'
  // Long enough to be worth folding (the fold itself is CSS: a capped height).
  const long = text.length > 1200 || text.split('\n').length > 16
  return (
    <div className="awr-fileview">
      <FileViewHead written={written} kind={kind} onClose={onClose} L={L}>
        {hasRendered && (
          <Seg
            label={fileNameOf(written.path)}
            value={showing}
            onChange={setView}
            options={[
              { value: 'rendered', label: L.fileRendered },
              { value: 'source', label: L.fileSource },
            ]}
          />
        )}
      </FileViewHead>
      <div className={`awr-fileview__body${long && !all ? ' is-folded' : ''}`}>
        {showing === 'rendered' ? (
          <>
            <div className="awr-fileview__rendered">{rendered}</div>
            {text.length > previewChars && (
              <p className="awr-fileview__cut">{L.fileCut(previewChars)}</p>
            )}
          </>
        ) : (
          <SourceView text={text} maxChars={previewChars} />
        )}
      </div>
      {long && (
        <div className="awr-fileview__more">
          <button type="button" className="awr-linkbtn" onClick={() => setAll((a) => !a)}>
            {all ? L.fileShowLess : L.fileShowRest}
          </button>
        </div>
      )}
    </div>
  )
}

const NoPreview = ({ written, kind, onClose, L }: PreviewProps) => (
  <div className="awr-fileview">
    <FileViewHead written={written} kind={kind} onClose={onClose} L={L} />
    <p className="awr-fileview__none">{L.fileNoPreview}</p>
  </div>
)

export interface FileChipsProps {
  /** The files of a turn (`ChatMessage.writtenFiles`). */
  written: WrittenFileView[]
  /**
   * The workspace they are in (the core's `VirtualFileSystem`). Without it the chips still
   * name the files, with nothing to open or download.
   */
  files?: VirtualFileSystem
  /** The line above the chips - "3 files written in this turn" (default true). */
  showHeader?: boolean
  /** Shows a "Show in Files" link in that line. */
  onShowFiles?: () => void
  /**
   * How an `.html` file is previewed: in a sandboxed frame without network, scripts off
   * (default `{}`); `{ scripts: true }` lets its inline scripts run; `false` never renders
   * HTML - the file is shown as source only.
   */
  htmlPreview?: HtmlPreviewOptions | false
  /** A whole chip; `fallback` is the built-in one. */
  renderFile?: (file: WrittenFileView, fallback: ReactNode) => ReactNode
  /**
   * A text file rendered your way - e.g. Markdown through your renderer. Return `undefined`
   * for a file you do not render: it is then shown as source. `text` is already capped.
   */
  renderFileContent?: (file: WrittenFileView, text: string) => ReactNode
  /** Characters of a text file a preview shows (default 20 000). */
  previewChars?: number
  /** A file whose preview is open at first (its path). */
  defaultOpen?: string
  labels?: AgentLabelsOverride
  className?: string
}

/**
 * The files an answer left in the workspace, as chips under it: name, kind, size, open and
 * download. Opening one shows it right there - text as text (rendered too, when the host gives
 * a renderer), a picture as a picture, and an `.html` page in a sandboxed frame with a
 * Preview / Source switch (see `SandboxedFrame`).
 */
export const FileChips = ({
  written,
  files: vfs,
  showHeader = true,
  onShowFiles,
  htmlPreview = {},
  renderFile,
  renderFileContent,
  previewChars = FILE_PREVIEW_CHARS,
  defaultOpen,
  labels,
  className,
}: FileChipsProps) => {
  const L = useLabels(labels)
  const live = useVirtualFiles(vfs)
  const [openPath, setOpenPath] = useState<string | undefined>(defaultOpen)
  const [file, setFile] = useState<VirtualFile | undefined>()

  const open = written.find((f) => f.path === openPath)
  // The open file's content, re-read when it is written again.
  const stamp = live.files.find((f) => f.path === openPath)?.updatedAt
  useEffect(() => {
    if (!vfs || !openPath) return setFile(undefined)
    let gone = false
    vfs
      .read(openPath)
      .then((f) => {
        if (!gone) setFile(f)
      })
      .catch(() => {
        if (!gone) setFile(undefined)
      })
    return () => {
      gone = true
    }
  }, [vfs, openPath, stamp])

  if (written.length === 0) return null

  const preview = (): ReactNode => {
    if (!open || !vfs || !file || file.path !== open.path) return null
    const kind = fileKindOf(open.path, file.mimeType)
    const props: PreviewProps = {
      written: open,
      file,
      kind,
      vfs,
      htmlPreview,
      renderFileContent,
      previewChars,
      onClose: () => setOpenPath(undefined),
      L,
    }
    if (kind === 'html') return <HtmlPreview key={open.path} {...props} />
    if (kind === 'image') return <ImagePreview key={open.path} {...props} />
    if (kind === 'file') return <NoPreview key={open.path} {...props} />
    return <TextPreview key={open.path} {...props} />
  }

  return (
    <div className={['awr-msg__files', className].filter(Boolean).join(' ')}>
      {showHeader && (
        <div className="awr-msg__fileshead">
          <FileIcon size={13} />
          <span>{L.filesWritten(written.length)}</span>
          {onShowFiles && (
            <button type="button" className="awr-linkbtn" onClick={onShowFiles}>
              {L.showInFiles}
            </button>
          )}
        </div>
      )}
      <ul className="awr-filechips">
        {written.map((w) => {
          const info = live.files.find((f) => f.path === w.path)
          const gone = Boolean(vfs) && !live.loading && !info
          const usable = Boolean(vfs) && !gone
          const isOpen = openPath === w.path && usable
          const chip = (
            <FileChip
              written={w}
              mediaType={info?.mimeType ?? w.mediaType}
              bytes={info?.size ?? w.bytes}
              files={usable ? vfs : undefined}
              gone={gone}
              open={isOpen}
              onToggle={() => setOpenPath(isOpen ? undefined : w.path)}
              labels={labels}
            />
          )
          return (
            <li key={w.path} className="awr-filechips__item">
              {renderFile ? renderFile(w, chip) : chip}
            </li>
          )
        })}
      </ul>
      {preview()}
    </div>
  )
}

export interface FileChipProps {
  written: WrittenFileView
  /** The type and size now (default: what the turn recorded). */
  mediaType?: string
  bytes?: number
  /** The workspace: gives the chip its download, its thumbnail and its open button. */
  files?: VirtualFileSystem
  /** The file is not in the workspace any more. */
  gone?: boolean
  open?: boolean
  onToggle?: () => void
  labels?: AgentLabelsOverride
}

/** One file: icon (a thumbnail for a picture), name, kind · size, open, download. */
export const FileChip = ({
  written,
  mediaType = written.mediaType,
  bytes = written.bytes,
  files: vfs,
  gone = false,
  open = false,
  onToggle,
  labels,
}: FileChipProps) => {
  const L = useLabels(labels)
  const kind = fileKindOf(written.path, mediaType)
  const name = fileNameOf(written.path)
  const Icon = KIND_ICON[kind]
  const thumb = useFileUrl(
    kind === 'image' ? vfs : undefined,
    written.path,
    kind === 'image' ? mediaType.toLowerCase().split(';')[0].trim() : undefined,
  )
  const meta = gone
    ? L.fileGone
    : [L.fileKinds[kind], L.bytes(bytes), written.by ? L.fileBy(written.by.name) : '']
        .filter(Boolean)
        .join(' · ')
  return (
    <div
      className={`awr-filechip${open ? ' is-open' : ''}${gone ? ' is-gone' : ''}`}
      title={written.path}
    >
      <span className="awr-filechip__thumb">
        {thumb ? <img src={thumb} alt="" /> : <Icon size={16} />}
      </span>
      <span className="awr-filechip__text">
        <span className="awr-filechip__name">{name}</span>
        <span className="awr-filechip__meta">{meta}</span>
      </span>
      {vfs && (
        <span className="awr-filechip__actions">
          {onToggle && (
            <button
              type="button"
              className={`awr-iconbtn${open ? ' is-on' : ''}`}
              aria-label={open ? L.fileClose(name) : L.fileOpen(name)}
              title={open ? L.closePreview : L.preview}
              aria-expanded={open}
              onClick={onToggle}
            >
              {open ? <ChevronUpIcon size={15} /> : <EyeIcon size={15} />}
            </button>
          )}
          <button
            type="button"
            className="awr-iconbtn"
            aria-label={L.fileDownload(name)}
            title={L.download}
            onClick={() => void downloadFile(vfs, written.path)}
          >
            <DownloadIcon size={15} />
          </button>
        </span>
      )}
    </div>
  )
}
