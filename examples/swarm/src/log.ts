// One JSON line per entry on stdout: what a container platform collects. Never pass secrets in
// `fields` - nothing here redacts.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface ILogger {
  debug: (message: string, fields?: Record<string, unknown>) => void
  info: (message: string, fields?: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
  error: (message: string, fields?: Record<string, unknown>) => void
}

export const isLogLevel = (v: string): v is LogLevel => v in RANK

export const createLogger = (
  level: LogLevel,
  base: Record<string, unknown> = {},
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): ILogger => {
  const at =
    (l: LogLevel) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      if (RANK[l] < RANK[level]) {
        return
      }
      write(
        JSON.stringify({ time: new Date().toISOString(), level: l, message, ...base, ...fields }),
      )
    }
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

export const silentLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)
