// The Worker's bindings (wrangler.jsonc). Vars and secrets are strings beside them (env.ts reads
// them); the classes are in durable.ts and workflows.ts.
import type { IChildParams, ITurnParams } from './session.ts'
import type { LimiterDO, SessionDO } from './durable.ts'

export interface Env {
  SESSION: DurableObjectNamespace<SessionDO>
  LIMITER: DurableObjectNamespace<LimiterDO>
  TURN: Workflow<ITurnParams>
  SUBAGENT: Workflow<IChildParams>
  PIPELINE: Workflow<IChildParams>
  NODE: Workflow<IChildParams>
}
