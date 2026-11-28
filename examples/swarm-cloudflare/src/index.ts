// The Worker: the gateway (fetch) and the classes wrangler.jsonc binds - the session's and the
// limiter's Durable Objects, the turn's and the children's Workflows.
import type { Env } from './env-types.ts'
import { createDurableBackend, portsOf } from './backend.ts'
import { createWorkerGateway, type IWorkerGateway } from './gateway.ts'
import { apiOf, logOf, sessionOf, setupOf } from './runtime.ts'
import { errorMessage } from 'swarm-shared'

export { LimiterDO, SessionDO } from './durable.ts'
export {
  PipelineNodeWorkflow,
  PipelineWorkflow,
  SubagentWorkflow,
  TurnWorkflow,
} from './workflows.ts'

const gateways = new WeakMap<object, IWorkerGateway>()

const gatewayOf = (env: Env): IWorkerGateway => {
  let g = gateways.get(env)
  if (!g) {
    const ports = portsOf(env)
    const backend = createDurableBackend(ports, sessionOf(env))
    g = createWorkerGateway({
      config: apiOf(env),
      backend: {
        ...backend,
        // /readyz also says when the agent's configuration is wrong (the steps would refuse).
        ready: async () => {
          setupOf(env)
          await backend.ready()
        },
      },
      forward: (sessionId, request) =>
        env.SESSION.get(env.SESSION.idFromName(sessionId)).fetch(request),
      log: logOf(env),
    })
    gateways.set(env, g)
  }
  return g
}

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => {
    let gateway: IWorkerGateway
    try {
      gateway = gatewayOf(env)
    } catch (err) {
      // The API's own configuration is wrong: nothing can be answered - say so, once, in the log.
      logOf(env).error('the gateway is misconfigured', { error: errorMessage(err) })
      return Response.json(
        { error: { code: 'misconfigured', message: 'the gateway is misconfigured: see its log' } },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      )
    }
    return gateway.fetch(request)
  },
} satisfies ExportedHandler<Env>
