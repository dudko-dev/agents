/** Compact one-line preview of a tool input/output value, truncated. */
export const previewValue = (value: unknown, max = 140): string => {
  if (value === undefined) return ''
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 1234 → "1.2k", 12345 → "12k". */
export const formatTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)

/** 340 → "340 ms", 4200 → "4.2 s", 125_000 → "2m 5s". */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

const isDataImage = (v: unknown): v is string =>
  typeof v === 'string' && /^data:image\/[\w.+-]+;base64,/.test(v)

/**
 * Images inside a tool result, as data URLs: MCP image parts
 * (`{ type: 'image', data, mimeType }`), data-URL strings, and objects that
 * carry one (`{ dataUrl }` / `{ url: 'data:…' }`). Looks two levels deep.
 */
export const imagesInOutput = (output: unknown, depth = 0): string[] => {
  if (depth > 2 || output == null) return []
  if (isDataImage(output)) return [output]
  if (Array.isArray(output)) return output.flatMap((v) => imagesInOutput(v, depth + 1))
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>
    if (o.type === 'image' && typeof o.data === 'string') {
      const mime = typeof o.mimeType === 'string' ? o.mimeType : 'image/png'
      return [o.data.startsWith('data:') ? o.data : `data:${mime};base64,${o.data}`]
    }
    for (const key of ['dataUrl', 'url', 'image'])
      if (isDataImage(o[key])) return [o[key] as string]
    if (depth < 2) return Object.values(o).flatMap((v) => imagesInOutput(v, depth + 1))
  }
  return []
}

/** One result of the core's `web_search` tool, as far as a UI shows it. */
export interface WebSearchResultView {
  title: string
  /** An http(s) address - anything else is left out. */
  url: string
  /** The host of `url`, for the line under the title. */
  host: string
  snippet: string
  date?: string
}

export interface WebSearchView {
  query: string
  results: WebSearchResultView[]
  /** Results the egress policy left out. */
  filtered: number
  truncated: boolean
}

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/**
 * The result of the core's `web_search` tool (`{ query, results: [{ title, url, snippet, date? }],
 * filtered?, truncated?, untrusted: true }`), or undefined when `output` is not one. Titles and
 * snippets are third-party text: they come back as plain strings, to be rendered as text. A
 * result whose `url` is not http(s) is dropped, so a link can never be a `javascript:` one.
 */
export const webSearchOf = (output: unknown): WebSearchView | undefined => {
  let value = output
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const o = value as Record<string, unknown>
  if (typeof o.query !== 'string' || !Array.isArray(o.results)) return undefined
  const results: WebSearchResultView[] = []
  for (const r of o.results.slice(0, 10)) {
    if (!r || typeof r !== 'object') continue
    const item = r as Record<string, unknown>
    if (typeof item.url !== 'string') continue
    let url: URL
    try {
      url = new URL(item.url)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    const date = text(item.date, 40)
    results.push({
      title: text(item.title, 200) || url.host,
      url: url.href,
      host: url.host,
      snippet: text(item.snippet, 400),
      ...(date ? { date } : {}),
    })
  }
  return {
    query: text(o.query, 300),
    results,
    filtered: typeof o.filtered === 'number' && o.filtered > 0 ? o.filtered : 0,
    truncated: o.truncated === true,
  }
}

/** 0.934 → "0.93", 0.8 → "0.8", 1 → "1". */
export const formatProbability = (p: number): string => String(Math.round(p * 100) / 100)
