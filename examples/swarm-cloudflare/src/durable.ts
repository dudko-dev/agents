// The Durable Objects. `SessionDO`: one per session (`idFromName(sessionId)`), the session's single
// writer - everything it does is `SessionHost` (host.ts); this class gives it the object's SQLite
// storage, its alarm and the Workflow bindings its effects use. `LimiterDO`: one per token bucket
// of sharedLimits (limiter.ts).
import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env-types.ts'
import { SessionHost, type InstanceStatus } from './host.ts'
import { instanceIdOf } from './ids.ts'
import { takeBucket, type BucketDecision, type IBucketConfig } from './limiter.ts'
import { apiOf, logOf, runtimeOf } from './runtime.ts'
import type { Effect, WorkflowKind } from './session.ts'
import type { ISql } from './sql.ts'
import { errorMessage } from 'swarm-shared'

const BINDING: Record<WorkflowKind, 'TURN' | 'SUBAGENT' | 'PIPELINE' | 'NODE'> = {
  turn: 'TURN',
  subagent: 'SUBAGENT',
  pipeline: 'PIPELINE',
  node: 'NODE',
}

const workflowOf = (env: Env, kind: WorkflowKind): Workflow<unknown> =>
  env[BINDING[kind]] as unknown as Workflow<unknown>

export const performEffect = async (env: Env, e: Effect): Promise<void> => {
  const binding = workflowOf(env, e.workflow)
  const id = await instanceIdOf(e.workflow, e.id)
  if (e.kind === 'create') {
    try {
      await binding.create({ id, params: e.params })
    } catch (err) {
      // A retried create (the first one's answer was lost): the instance is there.
      if (!/already.?exists/i.test(errorMessage(err))) throw err
    }
    return
  }
  await (await binding.get(id)).sendEvent({ type: e.type, payload: e.payload })
}

const statusOf = async (env: Env, kind: WorkflowKind, id: string): Promise<InstanceStatus> => {
  let instance: WorkflowInstance
  try {
    instance = await workflowOf(env, kind).get(await instanceIdOf(kind, id))
  } catch (err) {
    if (/not.?found/i.test(errorMessage(err))) return 'not_found'
    throw err
  }
  const s = await instance.status()
  return { status: s.status, ...(s.error ? { error: { message: s.error.message } } : {}) }
}

// The host's RPC surface, for the stubs' types (the gateway's and the steps' calls).
type HostMethods = Omit<SessionHost, 'core' | 'hub' | 'fetch' | 'alarm' | 'drain' | 'watchdog'>

export class SessionDO extends DurableObject<Env> {
  private readonly host: SessionHost

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql as unknown as ISql
    this.host = new SessionHost({
      storage: { sql, transactionSync: (fn) => ctx.storage.transactionSync(fn) },
      eventMaxBytes: runtimeOf(env).eventMaxBytes,
      leaseTtlMs: runtimeOf(env).leaseTtlMs,
      perform: (e) => performEffect(env, e),
      status: (kind, id) => statusOf(env, kind, id),
      setAlarm: async (at) => {
        if (at === undefined) await ctx.storage.deleteAlarm()
        else await ctx.storage.setAlarm(at)
      },
      api: () => apiOf(env),
      log: logOf(env),
      waitUntil: (p) => ctx.waitUntil(p),
    })
  }

  override fetch(request: Request): Promise<Response> {
    return this.host.fetch(request)
  }

  override alarm(): Promise<void> {
    return this.host.alarm()
  }
}

export interface SessionDO extends HostMethods {}

// Every public method of the host is a method of the object - on its prototype, which is what
// workerd exposes over RPC.
const INTERNAL = new Set(['constructor', 'settle', 'stopping', 'drainOnce', 'schedule'])
for (const name of Object.getOwnPropertyNames(SessionHost.prototype)) {
  const own = Object.getOwnPropertyDescriptor(SessionHost.prototype, name)
  if (INTERNAL.has(name) || typeof own?.value !== 'function' || name in SessionDO.prototype) {
    continue
  }
  Object.defineProperty(SessionDO.prototype, name, {
    value: function (
      this: { host: Record<string, (...args: unknown[]) => unknown> },
      ...args: unknown[]
    ) {
      return this.host[name]!(...args)
    },
  })
}

// One token bucket (sharedLimits): its tokens, by this object's clock.
export class LimiterDO extends DurableObject<Env> {
  take(bucket: string, cost: number, cfg: IBucketConfig): BucketDecision {
    return takeBucket(this.ctx.storage.sql as unknown as ISql, bucket, cost, cfg, Date.now())
  }

  ping(): string {
    return 'ok'
  }
}
