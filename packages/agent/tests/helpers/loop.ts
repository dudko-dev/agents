// The whole loop over real sockets for the scale-out tests (event order, the run lease, shared
// limits, remote subagents): a scripted OpenAI-compatible endpoint answering per stage, an agent
// config pointed at it, and small readers of the event stream.
import { createAgent, type AgentEvent, type IAgent, type IAgentConfig } from '../../src/index.ts'
import {
  startLocalOpenAI,
  systemOf,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from './openai-server.ts'

export type Stage =
  | 'planner'
  | 'executor'
  | 'replanner'
  | 'synthesizer'
  | 'compact-history'
  | 'compact-trace'
  | 'route'

export const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  if (system.includes('You compress conversation history')) return 'compact-history'
  if (system.includes('You compress the execution trace')) return 'compact-trace'
  if (system.includes('You are the Router')) return 'route'
  return 'executor'
}

// Which plan step an executor request is for.
export const stepOf = (req: IChatRequest): string =>
  /CURRENT STEP to execute \(id=([^)]+)\)/.exec(userOf(req))?.[1] ?? '?'

export const planJson = (steps: { id: string; suggestedTools?: string[]; complexity?: string }[]) =>
  JSON.stringify({
    thought: 'Do it step by step.',
    steps: steps.map((s) => ({
      id: s.id,
      description: `Step ${s.id}`,
      expectedOutcome: `${s.id} done`,
      suggestedTools: s.suggestedTools ?? [],
      ...(s.complexity ? { complexity: s.complexity } : {}),
    })),
  })

export const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'scale-out-test',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 6,
  maxStepsPerTask: 6,
  logLevel: 'none',
  ...extra,
})

export const withLlm = async (
  script: Script,
  body: (ctx: { llm: ILocalOpenAI; open: (c: IAgentConfig) => Promise<IAgent> }) => Promise<void>,
): Promise<void> => {
  const llm = await startLocalOpenAI(script)
  const agents: IAgent[] = []
  try {
    await body({
      llm,
      open: async (c) => {
        const agent = await createAgent(c)
        agents.push(agent)
        return agent
      },
    })
  } finally {
    for (const agent of agents) await agent.close().catch(() => {})
    await llm.close()
  }
}

export const collect = () => {
  const events: AgentEvent[] = []
  return { events, onEvent: (e: AgentEvent) => events.push(e) }
}

export const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

// A plan of `ids`, one executor answer per step, a synthesis.
export const linearScript =
  (ids: string[]): Script =>
  (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson(ids.map((id) => ({ id }))) }
      case 'executor':
        return { text: `did ${stepOf(req)}` }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'on track' }) }
      default:
        return { text: 'All done.' }
    }
  }

// `promise`, or a failure naming `what` after `ms` (real time): a regression that would hang the
// run fails the test instead.
export const within = <T>(promise: Promise<T>, what: string, ms = 15_000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })

// Resolves once `predicate` holds, checked every few ms (bounded).
export const until = async (predicate: () => boolean, what: string, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
