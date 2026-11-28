// Reading the environment: typed values, defaults, and errors that name the variable. A secret may
// come from a file instead (`<NAME>_FILE`, what Docker and Kubernetes secrets mount), so it never
// has to be in the environment of a process listing. Pure but for `readSecretFile`.
import { readFileSync } from 'node:fs'

export type Env = Record<string, string | undefined>

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const ON = ['on', 'true', '1', 'yes']
const OFF = ['off', 'false', '0', 'no']

export const str = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim()
  return v ? v : undefined
}

export const required = (env: Env, name: string): string => {
  const v = str(env, name)
  if (!v) {
    throw new ConfigError(`${name} is required`)
  }
  return v
}

export const int = (
  env: Env,
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {},
): number => {
  const raw = str(env, name)
  if (raw === undefined) {
    return fallback
  }
  const n = Number(raw)
  const min = bounds.min ?? 0
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER
  if (!/^-?[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}, got: ${raw}`)
  }
  return n
}

export const optionalInt = (
  env: Env,
  name: string,
  bounds: { min?: number; max?: number } = {},
): number | undefined => (str(env, name) === undefined ? undefined : int(env, name, 0, bounds))

export const num = (env: Env, name: string, bounds: { min: number; max: number }): number => {
  const raw = required(env, name)
  const n = Number(raw)
  if (!Number.isFinite(n) || n < bounds.min || n > bounds.max) {
    throw new ConfigError(
      `${name} must be a number from ${bounds.min} to ${bounds.max}, got: ${raw}`,
    )
  }
  return n
}

export const bool = (env: Env, name: string, fallback: boolean): boolean => {
  const raw = str(env, name)?.toLowerCase()
  if (raw === undefined) {
    return fallback
  }
  if (ON.includes(raw)) return true
  if (OFF.includes(raw)) return false
  throw new ConfigError(`${name} must be on | off, got: ${env[name]}`)
}

export const oneOf = <T extends string>(
  env: Env,
  name: string,
  values: readonly T[],
  fallback: T,
): T => {
  const raw = str(env, name)
  if (raw === undefined) {
    return fallback
  }
  if (!values.includes(raw as T)) {
    throw new ConfigError(`${name} must be ${values.join(' | ')}, got: ${raw}`)
  }
  return raw as T
}

export const list = (env: Env, name: string): string[] =>
  (str(env, name) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export const json = (env: Env, name: string): unknown => {
  const raw = str(env, name)
  if (raw === undefined) {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`${name} must be valid JSON: ${(err as Error).message}`)
  }
}

export const readSecretFile = (path: string): string => readFileSync(path, 'utf8').trim()

// `<NAME>`, or the contents of the file `<NAME>_FILE` names (not both).
export const secret = (
  env: Env,
  name: string,
  read: (path: string) => string = readSecretFile,
): string | undefined => {
  const direct = str(env, name)
  const file = str(env, `${name}_FILE`)
  if (direct && file) {
    throw new ConfigError(`set ${name} or ${name}_FILE, not both`)
  }
  if (file) {
    try {
      return read(file) || undefined
    } catch (err) {
      throw new ConfigError(`${name}_FILE: cannot read ${file}: ${(err as Error).message}`)
    }
  }
  return direct
}
