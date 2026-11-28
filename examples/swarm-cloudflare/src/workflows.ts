// The Workflows: what runs, as steps that survive the isolate they run in.
//
//   TurnWorkflow          one instance per turn (`turn-<session>-<turn>`): phase 0 is the turn's
//                         run; a run that parks waits for `resume-<k>` (the session's object sends
//                         it once every item has its answer), then phase k resumes the SAME run
//   SubagentWorkflow      one per static subagent call; PipelineNodeWorkflow one per pipeline node
//                         visit - the same shape: a phase, a park, a resume
//   PipelineWorkflow      one per pipeline call: the core's graph engine as the scheduler, here,
//                         every node visit a PipelineNodeWorkflow instance
//
// A step is retried by the engine (TURN_MAX_ATTEMPTS attempts, exponential backoff); a retried
// step finds its run on record and RESUMES it - its journal replays what the attempt before had
// done (steps.ts). A failure that would fail again is a NonRetryableError. Whatever the steps
// return is small (a status): the outcomes go to the session's object directly.
//
// Workflows re-run `run()` from the top after an eviction, with every finished step's result
// cached by its name: so the names here are functions of the phase, and the code between the
// steps decides nothing from the clock.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import {
  preparePipeline,
  runPipelineGraph,
  type PipelineDefinition,
  type PipelineNodeRunner,
} from '@dudko.dev/agent/pipeline-engine'
import {
  completedOutcomeOf,
  createAbortLatch,
  createStreamLog,
  emptyUsage,
  failedOutcomeOf,
  isAbortError,
  nodeInputOf,
  nodeOutputOf,
  sumUsage,
  type IPipelineInput,
  type ITally,
  type PipelineNodeOutcome,
  type PipelineOutcome,
} from 'swarm-shared/workflow'
import type { Env } from './env-types.ts'
import { ConfigError } from './env.ts'
import { sessionPort, setupOf, stepDepsOf } from './runtime.ts'
import {
  resumeEventOf,
  SETTLED_EVENT,
  type ChildPhase,
  type IChildParams,
  type ITurnParams,
} from './session.ts'
import { runChildPhase, runTurnPhase, TurnRefused } from './steps.ts'

type Options = ITurnParams['options']

// One attempt of a phase: its timeout, and the attempts the engine makes before it gives up.
const phaseConfig = (o: Options) => ({
  retries: {
    limit: Math.max(0, o.maxTurnAttempts - 1),
    delay: '1 second' as const,
    backoff: 'exponential' as const,
  },
  timeout: o.turnTimeoutMs,
})

// A report to the session's object (short, retried soon).
const REPORT = {
  retries: { limit: 10, delay: '1 second' as const, backoff: 'exponential' as const },
  timeout: '1 minute' as const,
}

// A park waits for its answers as long as it takes: a wait that times out is taken again.
const WAIT_TIMEOUT = '30 days'
const WAIT_ROUNDS = 1000

const messageOf = (err: unknown): string => {
  let e = err as { message?: string; cause?: unknown } | undefined
  while (e?.cause && typeof e.cause === 'object') {
    e = e.cause as { message?: string; cause?: unknown }
  }
  return e?.message || String(err)
}

// A refusal (a limit, refused credentials, a misconfiguration) fails at once: retrying it would
// be refused again.
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof TurnRefused || err instanceof ConfigError) {
      throw new NonRetryableError(err.message, err.name)
    }
    throw err
  }
}

const waitResume = async (step: WorkflowStep, k: number): Promise<{ stop?: boolean }> => {
  for (let round = 0; ; round++) {
    try {
      const event = await step.waitForEvent<{ stop?: boolean }>(`resume ${k}.${round}`, {
        type: resumeEventOf(k),
        timeout: WAIT_TIMEOUT,
      })
      return event.payload ?? {}
    } catch (err) {
      if (round + 1 >= WAIT_ROUNDS) throw err
    }
  }
}

export class TurnWorkflow extends WorkflowEntrypoint<Env, ITurnParams> {
  override async run(event: Readonly<WorkflowEvent<ITurnParams>>, step: WorkflowStep) {
    const { sessionId, turn, options } = event.payload
    for (let k = 0; ; k++) {
      let status: string
      try {
        ;({ status } = await step.do(`phase ${k}`, phaseConfig(options), () =>
          guard(() => runTurnPhase(stepDepsOf(this.env), sessionId, turn, k)),
        ))
      } catch (err) {
        const error = messageOf(err)
        await step.do(`phase ${k} failed`, REPORT, async () => {
          await sessionPort(this.env, sessionId).turnOutcome(turn, k, { status: 'failed', error })
          return true
        })
        return { status: 'failed' }
      }
      if (status !== 'parked') {
        return { status }
      }
      if ((await waitResume(step, k + 1)).stop) {
        return { status: 'stopped' }
      }
    }
  }
}

// A subagent call's or a node visit's instance: its phases, as a turn's.
abstract class ChildWorkflow extends WorkflowEntrypoint<Env, IChildParams> {
  override async run(event: Readonly<WorkflowEvent<IChildParams>>, step: WorkflowStep) {
    const { sessionId, workflowId, options } = event.payload
    for (let k = 0; ; k++) {
      let status: string
      try {
        ;({ status } = await step.do(`phase ${k}`, phaseConfig(options), () =>
          guard(() => runChildPhase(stepDepsOf(this.env), sessionId, workflowId, k)),
        ))
      } catch (err) {
        const error = messageOf(err)
        await step.do(`phase ${k} failed`, REPORT, async () => {
          await sessionPort(this.env, sessionId).childOutcome(workflowId, k, {
            status: 'failed',
            error,
          })
          return true
        })
        return { status: 'failed' }
      }
      if (status !== 'parked') {
        return { status }
      }
      if ((await waitResume(step, k + 1)).stop) {
        return { status: 'stopped' }
      }
    }
  }
}

export class SubagentWorkflow extends ChildWorkflow {}
export class PipelineNodeWorkflow extends ChildWorkflow {}

// A node visit's outcome, or the session's stop, as the pipeline's instance receives it.
interface ISettled {
  workflowId?: string
  outcome?: PipelineNodeOutcome
  stop?: boolean
}

// One pipeline call: examples/swarm's `pipeline` workflow. The engine is deterministic by
// contract, and everything it is told arrives through named steps in one order - the visits'
// outcomes one `settled <n>` wait after the other, in the order they came (whatever order a replay
// would have resolved them in otherwise) - so a replay makes the same calls, emits the same events
// and starts the same visits (each start is a step named by its node and visit: once). The
// engine's events go to the pipeline's own stream through one write at a time, numbered from 1;
// a write takes everything emitted since the one before (a replay's first live write takes it all
// again: the rows are written once by their numbers).
export class PipelineWorkflow extends WorkflowEntrypoint<Env, IChildParams> {
  override async run(event: Readonly<WorkflowEvent<IChildParams>>, step: WorkflowStep) {
    const { sessionId, workflowId } = event.payload
    const port = () => sessionPort(this.env, sessionId)
    // Step results are JSON here (the engine keeps them; they are small).
    const phase = JSON.parse(
      await step.do('input', REPORT, async () =>
        JSON.stringify(await port().childPhase(workflowId, 0)),
      ),
    ) as ChildPhase
    if ('applied' in phase || 'gone' in phase) {
      return { status: 'gone' }
    }
    const input = phase.input as IPipelineInput
    // Read once: a replay runs the graph it ran with (a later deploy may change PIPELINES).
    const definition = JSON.parse(
      await step.do('definition', REPORT, async () => {
        const p = setupOf(this.env).pipelines[input.name]
        if (!p) {
          throw new NonRetryableError(`pipeline "${input.name}" is not configured (PIPELINES)`)
        }
        return JSON.stringify(p.definition)
      }),
    ) as PipelineDefinition
    const log = createStreamLog(input)
    // One write at a time, in order, each named by where it is made (so a replay names them the
    // same); each takes what is queued when it runs - a replayed one, answered from its cache,
    // takes nothing, and the next live write takes it all.
    let writing: Promise<unknown> = step.do('stream start', REPORT, async () => {
      await port().writeStream({
        stream: input.stream,
        started: {
          input: input.task,
          name: input.name,
          parent: { sessionId: input.sessionId, turn: input.turn, runId: input.parentRunId },
          itemId: input.itemId,
          workflowId: input.workflowId,
        },
        events: [],
      })
      return true
    })
    const flush = (name: string): void => {
      writing = writing.then(() =>
        step.do(`stream ${name}`, REPORT, async () => {
          for (let batch = log.take(); batch; batch = log.take()) {
            await port().writeStream(batch)
          }
          return true
        }),
      )
    }
    const latch = createAbortLatch()
    let stopped = phase.stopping
    if (stopped) latch.abort()
    // The visits waiting for their outcome, and the one wait for the next `settled` at a time.
    const waiting = new Map<string, (outcome: PipelineNodeOutcome) => void>()
    let n = 0
    let pumping: Promise<void> | undefined
    const pump = (): void => {
      pumping ??= (async () => {
        while (waiting.size) {
          const ev = await step.waitForEvent<ISettled>(`settled ${n}`, {
            type: SETTLED_EVENT,
            timeout: WAIT_TIMEOUT,
          })
          n += 1
          const s = ev.payload ?? {}
          if (s.stop) {
            stopped = true
            latch.abort()
          } else if (s.workflowId && s.outcome) {
            const settle = waiting.get(s.workflowId)
            waiting.delete(s.workflowId)
            settle?.(s.outcome)
          }
          flush(`after ${n}`)
        }
        pumping = undefined
      })()
    }
    const tally: ITally = { runs: 0, usage: emptyUsage() }
    const cancels: Promise<unknown>[] = []
    const runNode: PipelineNodeRunner = async (node, nodeInput, ctx) => {
      tally.runs += 1
      const args = nodeInputOf(input, node, nodeInput)
      const visit = `${node.id}.${nodeInput.visit}`
      await step.do(`start ${visit}`, REPORT, () => port().startNodeVisit(workflowId, args))
      const outcome = new Promise<PipelineNodeOutcome>((resolve) => {
        waiting.set(args.workflowId, resolve)
      })
      pump()
      // A failure elsewhere in the wave aborts ctx.signal (the engine's rule): the visit is
      // stopped, and its outcome still comes (the pipeline waits for it before it ends).
      const cancel = (): void => {
        cancels.push(
          step.do(`stop ${visit}`, REPORT, async () => {
            await port().stopNodeVisit(args.workflowId)
            return true
          }),
        )
      }
      ctx.signal.addEventListener('abort', cancel)
      try {
        const o = await outcome
        if (o.status === 'completed') {
          tally.usage = sumUsage(tally.usage, o.usage)
        }
        return nodeOutputOf(o)
      } finally {
        ctx.signal.removeEventListener('abort', cancel)
      }
    }
    let outcome: PipelineOutcome
    try {
      const plan = preparePipeline(definition)
      const result = await runPipelineGraph(plan, runNode, {
        input: input.task,
        signal: latch.signal,
        onEvent: (e) => {
          log.push(e)
        },
        onAbort: 'reject',
      })
      outcome = completedOutcomeOf(result, tally)
    } catch (err) {
      outcome =
        stopped || isAbortError(err)
          ? { status: 'stopped', runs: tally.runs, usage: tally.usage }
          : failedOutcomeOf(err, tally)
    }
    // The visits a failure or a stop cancelled end first: their own streams get their turn.ended.
    while (pumping) await pumping
    await Promise.allSettled(cancels)
    flush('end')
    await writing
    await step.do('outcome', REPORT, async () => {
      await port().childOutcome(workflowId, 0, outcome)
      return true
    })
    return { status: outcome.status }
  }
}
