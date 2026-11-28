// JSON text for storage and the event stream: Errors become { name, message } (JSON.stringify would
// make them `{}`), a bigint its decimal text, and the NUL character U+FFFD (as examples/swarm's
// db/json.ts does for Postgres; kept here so a stored event reads the same on both platforms). Pure.

const replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message }
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}

// `\u0000` as JSON.stringify writes it, unless its backslash is itself escaped.
const NUL_ESCAPE = /(?<!\\)((?:\\\\)*)\\u0000/g

export const toJsonText = (value: unknown): string =>
  JSON.stringify(value, replacer).replace(NUL_ESCAPE, '$1\\ufffd')

const encoder = new TextEncoder()

export const byteLength = (text: string): number => encoder.encode(text).byteLength
