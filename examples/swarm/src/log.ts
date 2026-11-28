// The shared logger (`swarm-shared`: one JSON line per entry) with this process's stdout as its
// sink - what a container platform collects. Never pass secrets in `fields` - nothing redacts.
import { createLogger as createJsonLogger, type ILogger, type LogLevel } from 'swarm-shared'

export { errorMessage, isLogLevel, silentLogger, type ILogger, type LogLevel } from 'swarm-shared'

export const createLogger = (
  level: LogLevel,
  base: Record<string, unknown> = {},
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): ILogger => createJsonLogger(level, base, write)
