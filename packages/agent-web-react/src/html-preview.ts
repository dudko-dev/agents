/**
 * The sandboxed frame's security core: what untrusted HTML (a file the agent wrote, later an
 * MCP App) is wrapped in before it reaches an `<iframe>`. Pure strings - no React, no DOM - so
 * every guard is unit-tested here and proved in a real browser by `e2e/files.spec.ts`.
 *
 * The boundary, in three layers:
 *  1. `sandbox` WITHOUT `allow-same-origin`: the document gets an opaque origin - no access to
 *     the page's DOM, storage, IndexedDB (the key vault), cookies. No `allow-top-navigation`,
 *     `allow-popups`, `allow-forms`, `allow-modals`, `allow-downloads` either.
 *  2. A Content-Security-Policy with no network source at all, given twice: as the first element
 *     of the document itself, and by inheritance from the shell (3) - a `srcdoc` document takes
 *     its parent's policy, which nothing inside the document can pre-empt.
 *  3. A shell document of ours between the page and the untrusted one. A frame may always
 *     navigate ITSELF (`location = …`, a link, `<meta http-equiv=refresh>`): neither the sandbox
 *     nor a document's own CSP stops that, and a navigation is a network request. The only thing
 *     that does is the `frame-src` of the document that EMBEDS the frame - so we embed it in one
 *     we wrote, whose policy says `frame-src 'none'`.
 */

export interface SandboxedDocumentOptions {
  /** Let the document's own inline scripts run (default false). */
  scripts?: boolean
}

/**
 * The policy of the framed document: nothing is fetched from anywhere. Inline styles, and
 * images / fonts / media the document carries inside itself (`data:`, `blob:`), are all it gets;
 * inline scripts only when asked for. `frame-src 'none'` is what stops the frame from navigating.
 */
export const sandboxedCsp = (scripts = false): string =>
  [
    "default-src 'none'",
    scripts ? "script-src 'unsafe-inline'" : "script-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "webrtc 'block'",
  ].join('; ')

/**
 * The `sandbox` attribute: empty (everything off) or `allow-scripts`. Never
 * `allow-same-origin`, never a navigation, popup, form, modal or download token.
 */
export const sandboxTokens = (scripts = false): string => (scripts ? 'allow-scripts' : '')

/** A string as the value of a double-quoted HTML attribute. */
export const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A `<meta>` that carries a Content-Security-Policy. */
export const cspMetaTag = (policy: string): string =>
  `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`

const cspMeta = (scripts: boolean): string => cspMetaTag(sandboxedCsp(scripts))

// A DOCTYPE token ends at the first ">" whatever is inside it (the tokenizer's rule), so this is
// exactly where the parser leaves it.
const DOCTYPE = /^[﻿\t\n\f\r ]*<!doctype[^>]*>/i

/**
 * The document with our policy as its FIRST element: right after a leading DOCTYPE (so the
 * page stays in standards mode), otherwise before everything. Nothing the document says can
 * come earlier - not its own `<meta>`, not a `<base>`, not a script before `<html>` - and a
 * later policy of its own can only narrow ours.
 */
export const withCspFirst = (html: string, scripts = false): string =>
  withPolicyFirst(html, sandboxedCsp(scripts))

/** `withCspFirst` with a policy of the caller's (an MCP App's, built by `mcpAppCsp`). */
export const withPolicyFirst = (html: string, policy: string): string => {
  const doctype = DOCTYPE.exec(html)?.[0] ?? ''
  return `${doctype}${cspMetaTag(policy)}${html.slice(doctype.length)}`
}

/**
 * What goes into the outer frame's `srcdoc`: the shell (ours: the policy, and one inner frame
 * that fills it) carrying the untrusted document, escaped, as the inner frame's `srcdoc`.
 * Give the OUTER `<iframe>` the same `sandboxTokens(scripts)`.
 */
export const buildSandboxedDocument = (
  html: string,
  { scripts = false }: SandboxedDocumentOptions = {},
): string =>
  '<!doctype html><html><head>' +
  cspMeta(scripts) +
  '<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}' +
  'iframe{display:block;border:0;width:100%;height:100%}</style></head><body>' +
  `<iframe sandbox="${sandboxTokens(scripts)}" referrerpolicy="no-referrer" ` +
  `srcdoc="${escapeAttribute(withCspFirst(html, scripts))}"></iframe></body></html>`

/** HTML above this many characters is not framed at all - it is shown as source. */
export const HTML_PREVIEW_MAX_CHARS = 1_000_000

const ASSET_ATTR = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi

/**
 * The files a document links to by a relative path (`style.css`, `./app.js`, `img/a.png`): the
 * preview does not load them, and says so. A hint for the user, not a guard - the policy is
 * what keeps them from loading.
 */
export const linkedFilesOf = (html: string, max = 4): string[] => {
  const found: string[] = []
  for (const m of html.matchAll(ASSET_ATTR)) {
    const ref = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue
    if (!found.includes(ref)) found.push(ref)
    if (found.length >= max) break
  }
  return found
}

/** A piece of HTML source, by what it is (for colouring the Source view). */
export interface SourceToken {
  kind: 'text' | 'tag' | 'attr' | 'string' | 'comment'
  text: string
}

const RAW_TEXT = /^<(script|style|textarea|title)\b/i

/**
 * Split HTML source into coloured pieces. Lossless: the pieces joined are the input. It only
 * decides colours - the result is rendered as text nodes, never as markup.
 */
export const tokenizeHtml = (source: string): SourceToken[] => {
  const out: SourceToken[] = []
  const push = (kind: SourceToken['kind'], text: string) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  const n = source.length
  while (i < n) {
    const lt = source.indexOf('<', i)
    if (lt < 0) {
      push('text', source.slice(i))
      break
    }
    push('text', source.slice(i, lt))
    i = lt
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      const stop = end < 0 ? n : end + 3
      push('comment', source.slice(i, stop))
      i = stop
      continue
    }
    const open = /^<[!/?]?[a-zA-Z][^\s/>]*/.exec(source.slice(i, i + 80))
    if (!open) {
      push('text', '<')
      i += 1
      continue
    }
    push('tag', open[0])
    const raw = RAW_TEXT.exec(open[0])?.[1].toLowerCase()
    i += open[0].length
    // Inside the tag, up to its ">".
    while (i < n && source[i] !== '>') {
      const c = source[i]
      if (c === '"' || c === "'") {
        const end = source.indexOf(c, i + 1)
        const stop = end < 0 ? n : end + 1
        push('string', source.slice(i, stop))
        i = stop
      } else if (/[^\s=/>"']/.test(c)) {
        const name = /^[^\s=/>"']+/.exec(source.slice(i, i + 200))?.[0] ?? c
        // After "=" it is an unquoted value; otherwise a name.
        const before = out[out.length - 1]
        push(before?.kind === 'text' && before.text.endsWith('=') ? 'string' : 'attr', name)
        i += name.length
      } else {
        push(c === '/' ? 'tag' : 'text', c)
        i += 1
      }
    }
    if (i < n) {
      push('tag', '>')
      i += 1
    }
    if (raw) {
      // The content of <script> / <style> is not markup: plain, up to its closing tag.
      const close = source.toLowerCase().indexOf(`</${raw}`, i)
      const stop = close < 0 ? n : close
      push('text', source.slice(i, stop))
      i = stop
    }
  }
  return out
}
