// The gateway's backend (swarm-shared's ISessionBackend) on this platform: every call goes to the
// session's Durable Object (`idFromName(sessionId)`), whose answer is a result, not an exception
// (an error's class does not cross an RPC boundary) - mapped here to swarm-shared's errors: a
// session never started here is a 404, an ended one a 409, a child that is over a 404; a call that
// fails on the way (the object cannot be reached) is an outage, 503.
import {
  BackendUnavailableError,
  ChildEndedError,
  errorMessage,
  SessionEndedError,
  SessionNotFoundError,
  type ISessionBackend,
  type ISessionOptions,
} from 'swarm-shared'
import type { Env } from './env-types.ts'
import type { Result } from './session.ts'

export interface IBackendPorts {
  // The session's object (its RPC methods, durable.ts).
  session: (sessionId: string) => {
    exists: () => Promise<boolean>
    create: (sessionId: string, options: ISessionOptions, first?: unknown) => Promise<Result>
    message: (message: never) => Promise<Result>
    answer: (answer: never) => Promise<Result>
    answerChild: (workflowId: string, answer: never) => Promise<Result>
    stop: (stop: never) => Promise<Result>
    view: () => Promise<Result<unknown>>
    parkedItem: (itemId: string) => Promise<unknown>
    calls: (by: 'subagent' | 'pipeline') => Promise<unknown[]>
  }
  ping: () => Promise<unknown>
}

export const portsOf = (env: Env): IBackendPorts => ({
  session: (sessionId) =>
    env.SESSION.get(env.SESSION.idFromName(sessionId)) as unknown as ReturnType<
      IBackendPorts['session']
    >,
  ping: () => env.LIMITER.get(env.LIMITER.idFromName('global')).ping(),
})

export const createDurableBackend = (
  ports: IBackendPorts,
  session: ISessionOptions,
): ISessionBackend => {
  const reach = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      throw new BackendUnavailableError(`durable object: ${errorMessage(err)}`)
    }
  }
  const valueOf = <T>(sessionId: string, r: Result<T>, child?: string): T => {
    if (r.ok) return r.value
    if (r.error === 'ended') throw new SessionEndedError(sessionId)
    if (r.error === 'child_ended') throw new ChildEndedError(child ?? '')
    throw new SessionNotFoundError(sessionId)
  }
  const call = async <T>(sessionId: string, fn: () => Promise<Result<T>>, child?: string) =>
    valueOf(sessionId, await reach(fn), child)
  const s = ports.session
  return {
    create: async (sessionId, first) => {
      await call(sessionId, () => s(sessionId).create(sessionId, session, first))
    },
    message: async (sessionId, message) => {
      await call(sessionId, () => s(sessionId).message(message as never))
    },
    answer: async (sessionId, answer) => {
      await call(sessionId, () => s(sessionId).answer(answer as never))
    },
    answerChild: async (sessionId, workflowId, answer) => {
      await call(sessionId, () => s(sessionId).answerChild(workflowId, answer as never), workflowId)
    },
    stop: async (sessionId, stop) => {
      await call(sessionId, () => s(sessionId).stop(stop as never))
    },
    state: (sessionId) => call(sessionId, () => s(sessionId).view()) as never,
    exists: (sessionId) => reach(() => s(sessionId).exists()),
    parkedItem: (sessionId, itemId) => reach(() => s(sessionId).parkedItem(itemId)) as never,
    subagents: (sessionId) => reach(() => s(sessionId).calls('subagent')) as never,
    pipelines: (sessionId) => reach(() => s(sessionId).calls('pipeline')) as never,
    ready: async () => {
      await reach(() => ports.ping())
    },
  }
}
