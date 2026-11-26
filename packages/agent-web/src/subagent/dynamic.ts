// `config.subagents.dynamic`: the `spawn_subagent` tool. The MODEL starts a helper agent for a
// sub-task - a task, an optional role, optionally a subset of its own tools by name - and the
// helper's final answer comes back as the tool result.
//
// A helper is an agent built HERE, from the calling agent's own pieces: its resolved models (the
// same objects - a loaded WebLLM engine is not loaded twice), its approval state (the same
// object: the mode as it is now, the rules, what the user chose to always allow), its skills, and
// tool OBJECTS picked from its mounted tools by name. Nothing is resolved again from a spec, so
// everything a tool can reach - an MCP server, an egress policy, the sandbox and the workspace it
// is bound to, a search key - is exactly what the caller's tool reaches. The only inputs the model
// has are in `SPAWN_INPUT_SCHEMA` (dynamic-shared.ts, where the rules live). In-process only: a
// Web Worker cannot be handed live tools or the consent gate, which is what a static subagent
// (`createSubagentTool` with `worker`) is for.
import { jsonSchema, tool } from 'ai'
import type { RunControlPort } from '../agent/control.js'
import { addUsage, emptyUsage, type IUsage } from '../agent/loop-types.js'
import type { BrowserAgentConfig } from '../config.js'
import type { AgentEvent } from '../events.js'
import { FORGET_SKILL_TOOL, SAVE_SKILL_TOOL } from '../learning.js'
import type { StageInput } from '../providers/types.js'
import type { Skill } from '../skills.js'
import { recordWrite, replayOutput, replayedWrite, type IStepWrites } from '../tiers.js'
import { isReadOnlyTool, markReadOnly, type ApprovalState } from '../tools/approval.js'
import type { AgentTool, AgentToolSet } from '../tools/types.js'
import { toolRunContextOf } from '../tools/wrap.js'
import {
  adoptSubagentEvent,
  assertSpawnAllowed,
  cleanSpawnInput,
  createSpawnGate,
  narrowSubagentTools,
  renderSubagentTask,
  shareSubagentBudget,
  SPAWN_INPUT_HINT,
  SPAWN_INPUT_SCHEMA,
  SPAWN_SUBAGENT_TOOL,
  spawnToolDescription,
  type IResolvedDynamicSubagents,
  type ISpawnReservation,
  type ISpawnTokenLimits,
} from './dynamic-shared.js'

/** The sandbox's prompt sentences (see `AgentContext.sandbox`). */
export interface SpawnSandboxNotes {
  planner: string
  executor: string
  synthesizer: string
}

/**
 * What a helper's agent takes over from the run that started it instead of making its own.
 * Attached to the helper's config object out of band (`spawnSeedOf`): a host cannot write one
 * into a config, so there is no public way to hand an agent somebody else's consent state.
 */
export interface SpawnSeed {
  /** The caller's approval state itself: one gate for the whole tree. */
  approval: ApprovalState
  /** The helper's id (its `subagent.start` event) and depth: every consent request it makes says so. */
  subagent: { id: string; depth: number }
  /** The per-run count of helpers, shared by the tree. */
  root: { spawned: number }
  /** Count one tool call on the caller's run (and every run above it); throws when it has none left. */
  countParent: () => void
  /** Whether the helper may start helpers of its own (depth, and only if its parent can). */
  maySpawn: boolean
  /** The control of the run the host started: helpers at any depth register there. */
  control?: RunControlPort
  /** Set when the helper was given `run_js`: the notes the caller's prompts carry about it. */
  sandboxNotes?: SpawnSandboxNotes
}

const seeds = new WeakMap<object, SpawnSeed>()

/** The seed of a helper's config (undefined for every config a host wrote). */
export const spawnSeedOf = (config: BrowserAgentConfig): SpawnSeed | undefined => seeds.get(config)

/** Where a run stands among the helpers the model starts. Reaches the tool as `agentRun.spawn`. */
export interface SpawnRun {
  /** The helper's id; absent for the run the host started. */
  id?: string
  /** 0 for the host's run, 1 for its helpers, ... */
  depth: number
  root: { spawned: number }
  /** This run's helpers that are running: what each may still spend of this run's budgets. */
  running: ISpawnReservation[]
  /** At most `maxConcurrent` helpers of this run at once. */
  acquire: (signal?: AbortSignal) => Promise<() => void>
  /** The run's usage so far. */
  usage: () => IUsage
  /** Its counted tool calls so far. */
  toolCalls: () => number
  /** Count one tool call on this run and every run above it; throws ToolBudgetError. */
  countCall: () => void
  /** The writes of the step in flight, while it may be escalated (see `tiers.ts`). */
  stepWrites: () => IStepWrites | undefined
}

export const createSpawnRun = (
  settings: IResolvedDynamicSubagents | undefined,
  seed: SpawnSeed | undefined,
  run: Pick<SpawnRun, 'usage' | 'toolCalls' | 'countCall' | 'stepWrites'> & { spawned?: number },
): SpawnRun => ({
  ...(seed ? { id: seed.subagent.id } : {}),
  depth: seed?.subagent.depth ?? 0,
  root: seed?.root ?? { spawned: run.spawned ?? 0 },
  running: [],
  acquire: createSpawnGate(settings?.maxConcurrent ?? 1),
  usage: run.usage,
  toolCalls: run.toolCalls,
  countCall: run.countCall,
  stepWrites: run.stepWrites,
})

/** The slice of an agent a helper runs through. */
interface HelperAgent {
  run: (
    goal: string,
    opts: { signal?: AbortSignal; onEvent?: (event: AgentEvent) => void },
  ) => Promise<{ final: string; stopped: boolean }>
}

export interface DynamicSubagentDeps {
  settings: IResolvedDynamicSubagents
  /** The agent's config as it was given. */
  config: BrowserAgentConfig
  /** Its effective run limits. */
  limits: { limits: ISpawnTokenLimits; maxToolCalls: number; maxIterations: number }
  /** Its mounted tools (after the filters), read at each call. */
  tools: () => AgentToolSet
  /** Names a helper has by rule, whatever is asked (the built-in meta-tools). */
  implicit: () => string[]
  /** Its resolved models. */
  models: {
    executor: StageInput
    planner: StageInput
    synthesizer: StageInput
    tiers?: BrowserAgentConfig['executorTiers']
  }
  approval: () => ApprovalState
  /** Its skills, the lessons it wrote included (read live). */
  skills: () => Skill[]
  /** Its sandbox notes, when `run_js` is its sandbox's own tool. */
  sandboxNotes: () => SpawnSandboxNotes | undefined
  /** Whether a helper of this agent may start helpers of its own, the depth aside. */
  mayNest: () => boolean
  createAgent: (config: BrowserAgentConfig) => Promise<HelperAgent>
}

const abortError = (): Error => {
  const e = new Error('The helper was aborted')
  e.name = 'AbortError'
  return e
}

let seq = 0
const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `helper-${Date.now().toString(36)}-${(seq += 1)}`

export const createDynamicSubagentTool = (deps: DynamicSubagentDeps): AgentTool => {
  const { settings } = deps
  const t = tool({
    description: spawnToolDescription(settings),
    inputSchema: jsonSchema<Record<string, unknown>>(SPAWN_INPUT_SCHEMA),
    execute: async (raw, options) => {
      const runCtx = toolRunContextOf(options)
      const scope = runCtx?.spawn
      if (!runCtx || !scope) {
        throw new Error(`${SPAWN_SUBAGENT_TOOL} can only be called inside a run`)
      }
      // A helper that FINISHED in an earlier attempt at this step (escalation) did its work then:
      // the stronger model's identical call gets that answer back, the helper does not run twice.
      const earlier = replayedWrite(scope.stepWrites(), SPAWN_SUBAGENT_TOOL, raw)
      if (earlier) return replayOutput(earlier.output)
      const input = cleanSpawnInput(raw)
      // ── may another helper start? ──────────────────────────────────────
      assertSpawnAllowed({ depth: scope.depth, spawned: scope.root.spawned }, settings)
      // ── its tools: a subset of what THIS agent has ─────────────────────
      const parentTools = deps.tools()
      const names = narrowSubagentTools(
        Object.entries(parentTools).map(([name, tl]) => ({ name, readOnly: isReadOnlyTool(tl) })),
        input.tools,
        {
          defaultTools: settings.defaultTools,
          implicit: [SPAWN_SUBAGENT_TOOL, ...deps.implicit()],
          // The notebook is the parent's: a helper sees a part of the task and none of its
          // outcome, so it reports what it learned and the parent decides what is a lesson.
          withheld: [SAVE_SKILL_TOOL, FORGET_SKILL_TOOL],
        },
      )
      const tools: AgentToolSet = {}
      for (const name of names) tools[name] = parentTools[name]
      const depth = scope.depth + 1
      // A helper may start helpers only below the depth limit, and only if its parent can.
      const maySpawn = depth < settings.maxDepth && deps.mayNest()

      scope.root.spawned += 1
      const id = newId()
      const name = SPAWN_SUBAGENT_TOOL
      const emit = (e: AgentEvent): void => runCtx.emit(e)
      const parentSignal =
        (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal ?? runCtx.signal
      const release = await scope.acquire(parentSignal)

      const controller = new AbortController()
      const onParentAbort = (): void => controller.abort()
      let timedOut = false
      let stoppedByUser = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unregister: (() => void) | undefined
      let reservation: ISpawnReservation | undefined
      let spent: IUsage = emptyUsage()
      let calls = 0
      let started = false
      try {
        // ── its budgets: a share of what is left of this run's ───────────
        const budget = shareSubagentBudget(
          {
            limits: deps.limits.limits,
            usage: scope.usage(),
            maxToolCalls: deps.limits.maxToolCalls,
            toolCalls: scope.toolCalls(),
            maxIterations: deps.limits.maxIterations,
          },
          scope.running,
          settings,
        )
        const {
          memory: _memory,
          sessionId: _session,
          persistence: _persistence,
          learning: _learning,
          egress: _egress,
          search: _search,
          sandbox: _sandbox,
          // Like egress, search and the sandbox: a helper has the caller's media tools (when it
          // is given them) or none. Left in, the helper's agent would mount its own from the
          // config - tools it was not given, that spend money and write files.
          media: _media,
          availableTools: _available,
          skills: _skills,
          ...inherited
        } = deps.config
        void [
          _memory,
          _session,
          _persistence,
          _learning,
          _egress,
          _search,
          _sandbox,
          _media,
          _available,
        ]
        void _skills
        const skills = deps.skills()
        const sandboxNotes = deps.sandboxNotes()
        const config: BrowserAgentConfig = {
          ...inherited,
          // The caller's models as they are: nothing is resolved from a spec again.
          model: deps.models.executor as BrowserAgentConfig['model'],
          planner: deps.models.planner,
          synthesizer: deps.models.synthesizer,
          ...(deps.models.tiers ? { executorTiers: deps.models.tiers } : { executorTiers: {} }),
          tools,
          ...(skills.length ? { skills: [...skills] } : {}),
          maxIterations: budget.maxIterations,
          limits: { ...deps.config.limits, ...budget.limits },
          ...(budget.maxToolCalls !== undefined ? { maxToolCalls: budget.maxToolCalls } : {}),
        }
        seeds.set(config, {
          approval: deps.approval(),
          subagent: { id, depth },
          root: scope.root,
          countParent: () => {
            scope.countCall()
            calls += 1
          },
          maySpawn,
          ...(runCtx.control ? { control: runCtx.control } : {}),
          ...(sandboxNotes && tools.run_js ? { sandboxNotes } : {}),
        })

        parentSignal?.addEventListener('abort', onParentAbort, { once: true })
        if (parentSignal?.aborted) controller.abort()
        if (settings.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true
            controller.abort()
          }, settings.timeoutMs)
        }
        reservation = {
          limits: budget.limits,
          ...(budget.maxToolCalls !== undefined ? { maxToolCalls: budget.maxToolCalls } : {}),
          usage: () => spent,
          toolCalls: () => calls,
        }
        scope.running.push(reservation)

        started = true
        emit({
          type: 'subagent.start',
          id,
          name,
          task: input.task,
          // The parent is this run - or, once the event has passed up through the helper that
          // made this call, that helper (see adoptSubagentEvent).
          ...(runCtx.runId ? { parentId: runCtx.runId } : {}),
          depth: 1,
          dynamic: true,
          ...(input.role ? { role: input.role } : {}),
          tools: names,
        })
        unregister = runCtx.control?.registerSubagent(
          {
            id,
            name,
            task: input.task,
            startedAt: Date.now(),
            ...(scope.id ? { parentId: scope.id } : {}),
            depth,
            dynamic: true,
            ...(input.role ? { role: input.role } : {}),
          },
          () => {
            stoppedByUser = true
            controller.abort()
          },
        )
        // The helper starts from the task alone: no memory, none of the parent's steps.
        const agent = await deps.createAgent(config)
        let runError: string | undefined
        const result = await agent.run(renderSubagentTask(input), {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'error' && event.phase === 'run') runError = event.error
            if (event.type === 'usage') {
              // Charged to the parent as it happens: the parent's limits see a long-running helper.
              spent = addUsage(spent, event.usage)
              runCtx.addUsage(event.usage)
            }
            emit({ type: 'subagent.event', id, name, event: adoptSubagentEvent(event, id) })
          },
        })
        if (result.stopped) throw abortError()
        if (runError) throw new Error(runError)
        emit({ type: 'subagent.complete', id, name, text: result.final, usage: { ...spent } })
        recordWrite(scope.stepWrites(), SPAWN_SUBAGENT_TOOL, raw, result.final)
        return result.final
      } catch (err) {
        if (!started) {
          // Refused before it began (the budget): nothing was announced, nothing ran.
          scope.root.spawned = Math.max(0, scope.root.spawned - 1)
          throw err
        }
        // The user's stop wins over a deadline that fired at the same moment.
        const message = stoppedByUser
          ? 'the helper was stopped by the user before it finished - carry on without its result, or take another approach'
          : timedOut
            ? `the helper timed out after ${settings.timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err)
        emit({
          type: 'subagent.error',
          id,
          name,
          error: message,
          ...(stoppedByUser ? { stopped: true } : {}),
          usage: { ...spent },
        })
        if (stoppedByUser || timedOut) throw new Error(`${SPAWN_SUBAGENT_TOOL}: ${message}`)
        throw err
      } finally {
        unregister?.()
        if (timer !== undefined) clearTimeout(timer)
        parentSignal?.removeEventListener('abort', onParentAbort)
        if (reservation) {
          const i = scope.running.indexOf(reservation)
          if (i >= 0) scope.running.splice(i, 1)
        }
        release()
      }
    },
  }) as AgentTool
  t.promptHint = SPAWN_INPUT_HINT
  // Starting a helper changes nothing by itself: every call the helper makes passes the same
  // gate as the parent's would. So 'ask-writes' and 'read-only' let the spawn through (and still
  // ask about / refuse the helper's writes); 'ask-all' and a rule on spawn_subagent apply to it.
  return markReadOnly(t)
}
