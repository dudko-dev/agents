import type { ReactNode } from 'react'
import { buildSandboxedDocument, sandboxTokens } from '../html-preview.js'

/** The frame's height is the host's: a number of pixels between these, never the content's wish. */
export const FRAME_MIN_HEIGHT = 120
export const FRAME_MAX_HEIGHT = 800

export const clampFrameHeight = (height: number): number =>
  Math.min(
    FRAME_MAX_HEIGHT,
    Math.max(FRAME_MIN_HEIGHT, Math.round(Number.isFinite(height) ? height : 300)),
  )

export interface SandboxedFrameProps {
  /**
   * The untrusted document. It is shown inside `<iframe sandbox>` without `allow-same-origin`,
   * under a policy with no network, wrapped by `buildSandboxedDocument`. Omit it (and pass
   * `children`) to show host-rendered content - the source as text - in the same chrome.
   */
  html?: string
  /** Let the document's inline scripts run (default false). */
  scripts?: boolean
  /** The accessible name of the frame. */
  title: string
  /** The host's label, in the header: what this is and where it came from. */
  label: ReactNode
  /** Host controls in the header (a view switch, buttons). */
  actions?: ReactNode
  /** A host line under the frame. */
  footer?: ReactNode
  /** Height of the framed document in px (default 300; clamped to 120 - 800). */
  height?: number
  /** Host-rendered content in place of the framed document. */
  children?: ReactNode
  className?: string
}

/**
 * Third-party HTML inside chrome the host draws. The header, the footer and every control are
 * OUTSIDE the `<iframe>`: the content can paint whatever it likes inside its box and still cannot
 * imitate or cover a control of the chat. The box has a fixed height the host chose - the frame
 * is never resized by a message from the content, and the component listens to none.
 *
 * Reusable for anything untrusted that must be drawn (an HTML file, an MCP App): give it the
 * document and a label; see `html-preview.ts` for what the boundary is made of.
 */
export const SandboxedFrame = ({
  html,
  scripts = false,
  title,
  label,
  actions,
  footer,
  height = 300,
  children,
  className,
}: SandboxedFrameProps) => (
  <div className={['awr-frame', className].filter(Boolean).join(' ')}>
    <div className="awr-frame__head">
      <div className="awr-frame__label">{label}</div>
      {actions}
    </div>
    {html !== undefined && children === undefined ? (
      <div className="awr-frame__well">
        <iframe
          // A new mode is a new frame: `sandbox` is read when a document loads, so the element
          // is replaced rather than re-attributed.
          key={scripts ? 'scripts' : 'static'}
          className="awr-frame__iframe"
          title={title}
          sandbox={sandboxTokens(scripts)}
          referrerPolicy="no-referrer"
          srcDoc={buildSandboxedDocument(html, { scripts })}
          style={{ height: clampFrameHeight(height) }}
        />
      </div>
    ) : (
      children
    )}
    {footer ? <div className="awr-frame__foot">{footer}</div> : null}
  </div>
)
