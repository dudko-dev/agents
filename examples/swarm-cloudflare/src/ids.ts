// The ids this platform adds to swarm-shared's (session-ids.ts: a session's children and their
// streams, named the same on every platform). Both are functions of what they name, so a retried
// start names the same thing, never a second one. WebCrypto only (workerd and Node alike).
import type { WorkflowKind } from './session.ts'

const encoder = new TextEncoder()

export const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

// A fresh run's id, named by the step: examples/swarm's `runIdOf` (the same digest of the same
// parts, so a run id means the same on both platforms).
export const runIdOf = async (stream: string, turn: number, runNo: number): Promise<string> =>
  `run-${(await sha256Hex(`${stream}\n${turn}\n${runNo}`)).slice(0, 32)}`

// A Workflow instance id is at most 100 characters of [A-Za-z0-9_-]: a child's name in
// swarm-shared is longer (`subagent-<session>-<run>-<item>`) and a node visit's has dots. So a
// child's instance is named by a digest of its workflow id (160 bits: no collision to fear); a
// turn's is readable (`turn-<session>-<turn>`, swarm-shared's ID_PATTERN keeps a session id short).
const PREFIX: Record<WorkflowKind, string> = {
  turn: 'turn',
  subagent: 'sub',
  pipeline: 'pipe',
  node: 'node',
}

export const INSTANCE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/

export const instanceIdOf = async (kind: WorkflowKind, id: string): Promise<string> =>
  kind === 'turn' ? id : `${PREFIX[kind]}-${(await sha256Hex(id)).slice(0, 40)}`
