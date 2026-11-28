// A session's object in Node: `SessionHost` over node:sqlite with a fake clock, its effects kept
// in a list instead of reaching Workflow bindings - so a test plays the Workflow instances itself
// (or runs the real steps against it: tests/steps.test.ts).
import type { IParkedRequest, ISessionOptions, IUserMessage, TurnResult } from 'swarm-shared'
import { SessionHost, type InstanceStatus } from '../../src/host.ts'
import type { Effect, WorkflowKind } from '../../src/session.ts'
import { memoryStorage } from './sqlite.ts'

export const OPTIONS: ISessionOptions = {
  idleTimeoutMs: 0,
  turnTimeoutMs: 60_000,
  heartbeatTimeoutMs: 3000,
  maxTurnAttempts: 3,
  maxTurnsPerRun: 100,
  historyMaxChars: 200_000,
  maxQueuedMessages: 5,
  subagentMaxPerRound: 2,
  subagentMaxPerSession: 3,
  pipelineMaxPerRound: 2,
  pipelineMaxPerSession: 20,
}

export interface ITestHost {
  host: SessionHost
  effects: Effect[]
  clock: { now: number }
  statuses: Map<string, InstanceStatus>
  // Fail the next `n` effects.
  failNext: (n: number) => void
  alarms: (number | undefined)[]
  drain: () => Promise<void>
}

// `realClock`: the host reads Date.now() (a test of leases against the real core's timers).
export const testHost = (o: { leaseTtlMs?: number; realClock?: boolean } = {}): ITestHost => {
  const effects: Effect[] = []
  const clock = { now: 1_000_000 }
  const statuses = new Map<string, InstanceStatus>()
  const alarms: (number | undefined)[] = []
  let failing = 0
  const host = new SessionHost({
    storage: memoryStorage(),
    eventMaxBytes: 262_144,
    leaseTtlMs: o.leaseTtlMs ?? 3000,
    now: o.realClock ? Date.now : () => clock.now,
    perform: async (e) => {
      if (failing > 0) {
        failing -= 1
        throw new Error('the binding is down')
      }
      effects.push(e)
    },
    status: async (kind: WorkflowKind, id: string) =>
      statuses.get(`${kind}:${id}`) ?? { status: 'running' },
    setAlarm: async (at) => {
      alarms.push(at)
    },
  })
  return {
    host,
    effects,
    clock,
    statuses,
    failNext: (n) => {
      failing = n
    },
    alarms,
    drain: () => host.drain(),
  }
}

export const message = (text: string, id = text): IUserMessage => ({ id, text, at: 1 })

export const approval = (requestId: string): IParkedRequest => ({
  requestId,
  kind: 'approval',
  question: { request: { toolName: 'docs__echo', input: { text: 'x' } } },
})

export const subagentCall = (requestId: string, task = 'look into x'): IParkedRequest => ({
  requestId,
  kind: 'tool',
  question: { toolName: 'researcher', input: { task } },
  subagent: { name: 'researcher', task },
})

export const parkedResult = (
  requests: IParkedRequest[],
  runId = 'run-1',
  attempt = 1,
): TurnResult => ({ status: 'parked', runId, attempt, turnAttempt: attempt, requests })

export const completed = (text: string, runId = 'run-1', attempt = 1): TurnResult => ({
  status: 'completed',
  runId,
  attempt,
  text,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
})
