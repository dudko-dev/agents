// A small SSE client over fetch: reads frames (id + data) until `stop` says so (examples/swarm's tests/helpers/sse.ts).
export interface ISseEvent {
  id: string
  data: { cursor: string; turn: number; event: Record<string, unknown> & { type: string } }
}

// Read an SSE stream until `stop` says so (or the timeout); returns what it saw.
export const readSse = async (
  url: string,
  headers: Record<string, string>,
  stop: (seen: ISseEvent[]) => boolean,
  timeoutMs = 30_000,
): Promise<{ status: number; events: ISseEvent[] }> => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const events: ISseEvent[] = []
  try {
    const res = await fetch(url, { headers, signal: ac.signal })
    if (res.status !== 200 || !res.body) {
      return { status: res.status, events }
    }
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let i: number
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        const id = /^id: (.*)$/m.exec(frame)?.[1]
        const data = /^data: (.*)$/m.exec(frame)?.[1]
        if (id && data) {
          events.push({ id, data: JSON.parse(data) as ISseEvent['data'] })
        }
      }
      if (stop(events)) {
        ac.abort()
        break
      }
    }
    return { status: 200, events }
  } catch (err) {
    if (ac.signal.aborted) {
      return { status: 200, events }
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
