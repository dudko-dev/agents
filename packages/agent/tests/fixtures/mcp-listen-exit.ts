// Run in a child process by mcp-protocol.test.ts: a 2026-07-28 connection whose listen stream was
// dropped, closed while the retry is pending. The connector's listen timers are put on a time
// source (their test seam, see tests/helpers/listen-time.ts) whose every timer is a REAL
// one of an hour: one that close() left behind would keep this process alive that long, and the
// parent test, which waits for the exit, would see it hang. Prints how many of those timers
// were pending before and after the close.
import { startLocalMcpServer } from '@dudko.dev/test-servers'
import { connectMcpServers } from '../../src/mcp.ts'

const TEST_TIME = Symbol.for('@dudko.dev/agent:mcp-listen-test-time')
const HOUR = 3_600_000
const live = new Set<ReturnType<typeof setTimeout>>()
;(globalThis as unknown as Record<symbol, unknown>)[TEST_TIME] = {
  set: (fire: () => void) => {
    const handle = setTimeout(() => {
      live.delete(handle)
      fire()
    }, HOUR)
    live.add(handle)
    return handle
  },
  clear: (handle: unknown) => {
    live.delete(handle as ReturnType<typeof setTimeout>)
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

const main = async (): Promise<void> => {
  const server = await startLocalMcpServer({ protocol: 'modern' })
  const logs: string[] = []
  const mcp = await connectMcpServers(
    { wx: { url: server.url, protocol: 'modern' } },
    (level, message) => logs.push(`${level} ${message}`),
    'agent-exit-test',
    undefined,
    () => {},
  )
  server.dropListenStreams()
  const deadline = Date.now() + 5_000
  while (!logs.some((l) => /listening again in/.test(l))) {
    if (Date.now() > deadline) throw new Error(`no retry was scheduled: ${logs.join(' | ')}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  process.stdout.write(`pending: ${live.size}\n`)
  await mcp.close()
  await server.close()
  process.stdout.write(`closed: ${live.size}\n`)
}

await main()
