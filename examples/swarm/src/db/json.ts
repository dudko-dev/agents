// JSON for Postgres `jsonb`: Errors become { name, message } (JSON.stringify would make them `{}`),
// and the NUL character - which jsonb refuses ("unsupported Unicode escape sequence") and a tool's
// output may well carry - becomes U+FFFD. Pure; no imports.

const replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message }
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}

// `\u0000` as JSON.stringify writes it, unless its backslash is itself escaped (an odd run of
// backslashes in front is the escape; an even run is literal backslashes followed by "u0000").
const NUL_ESCAPE = /(?<!\\)((?:\\\\)*)\\u0000/g

export const toJsonText = (value: unknown): string =>
  JSON.stringify(value, replacer).replace(NUL_ESCAPE, '$1\\ufffd')
