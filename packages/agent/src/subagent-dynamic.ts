// `config.subagents.dynamic`: the `spawn_subagent` tool. The MODEL starts a helper agent for a
// sub-task - a task, an optional role, optionally a subset of its own tools by name - and the
// helper's final answer comes back as the tool result.
//
// A helper is NOT a new agent built from a config. It is a nested run of the same loop over a
// context derived from the calling run's: the same models (tiers included), the same approval
// controller (mode as it is now, rules, what the user chose to always allow), the same skills, and
// tool OBJECTS picked from the caller's by name. So everything a tool can reach - an MCP server, an
// egress policy, the sandbox, a search key - is exactly what the caller's tool reaches, and there
// is no place a helper could get more: the only inputs are in `SPAWN_INPUT_SCHEMA`
// (subagent-dynamic-shared.ts, where the rules live). In-process only: a worker would have to
// rebuild the tools and the approval gate on the other side, which is what a static subagent
// (createSubagentTool) with its own config is for.
import { jsonSchema, tool, type Tool, type ToolSet } from 'ai'
import { randomUUID } from 'node:crypto'
import { isReadOnlyTool, markReadOnly } from './approval.ts'
import { runContext, type IRunContext } from './context.ts'
import type { IAgentInternalContext, IRunState, ISpawnScope } from './internal.ts'
import { FORGET_SKILL_TOOL, SAVE_SKILL_TOOL } from './learning.ts'
import { resolveLimits } from './limits.ts'
import { collectMcpInstructions, renderMcpInstructions } from './mcp-shared.ts'
import { runAgentLoop } from './runner.ts'
import { RUN_JS_TOOL } from './sandbox-engine.ts'
import { slimEvent } from './subagent.ts'
import {
  adoptSubagentEvent,
  assertSpawnAllowed,
  cleanSpawnInput,
  createSpawnGate,
  narrowSubagentTools,
  renderSubagentTask,
  shareSubagentBudget,
  SPAWN_INPUT_SCHEMA,
  SPAWN_SUBAGENT_TOOL,
  spawnToolDescription,
  type IResolvedDynamicSubagents,
  type ISpawnReservation,
} from './subagent-dynamic-shared.ts'
import { recordWrite, replayOutput, replayedWrite } from './tiers.ts'
import { createFindToolsTool, FIND_TOOLS_TOOL } from './tool-search.ts'
import type { AgentEvent, EventHandler, IAgentConfig, IUsage } from './types.ts'
import { addUsage, emptyUsage, errorMessage, normalizeUsage } from './utils.ts'
import { createWaitClock, followHumanWaits, type IWaitTimer } from './wait-clock.ts'

export interface IDynamicSubagentDeps {
  settings: IResolvedDynamicSubagents
  // The agent's context, read at each call: its tools are replaced on a refresh / reconnect.
  ctx: () => IAgentInternalContext
  // Wrap a built-in made for one helper (find_tools over the helper's own catalogue).
  wrapBuiltin: (tools: ToolSet) => ToolSet
}

// The scope of the run a call comes from: made on its first spawn for the host's run, handed
// over by the runner for a helper's.
const scopeOf = (state: IRunState, settings: IResolvedDynamicSubagents): ISpawnScope => {
  state.spawn ??= {
    depth: 0,
    root: state,
    running: [],
    acquire: createSpawnGate(settings.maxConcurrent),
  }
  return state.spawn
}

export const createDynamicSubagentTool = (deps: IDynamicSubagentDeps): Tool => {
  const { settings } = deps
  const spawn = tool({
    description: spawnToolDescription(settings),
    inputSchema: jsonSchema<Record<string, unknown>>(SPAWN_INPUT_SCHEMA),
    execute: async (raw, { abortSignal }) => {
      const store = runContext.getStore()
      const state = store?.state
      if (!store || !state) {
        throw new Error(`${SPAWN_SUBAGENT_TOOL} can only be called inside a run`)
      }
      // A helper that FINISHED in an earlier attempt at this step (escalation) did its work then:
      // the stronger model's identical call gets that answer back, the helper does not run twice.
      const earlier = replayedWrite(state.stepWrites, SPAWN_SUBAGENT_TOOL, raw)
      if (earlier) {
        return replayOutput(earlier.output)
      }
      const agent = deps.ctx()
      const scope = scopeOf(state, settings)
      const input = cleanSpawnInput(raw)
      // ── may another helper start? ──────────────────────────────────────
      assertSpawnAllowed(
        { depth: scope.depth, spawned: scope.root.subagentsSpawned ?? 0 },
        settings,
      )
      // ── its tools: a subset of what THIS run has right now ─────────────
      const parentTools = scope.tools ?? agent.tools
      const parentCatalog = scope.catalog ?? agent.toolCatalog
      const names = narrowSubagentTools(
        Object.entries(parentTools).map(([name, t]) => ({ name, readOnly: isReadOnlyTool(t) })),
        input.tools,
        {
          defaultTools: settings.defaultTools,
          implicit: [
            SPAWN_SUBAGENT_TOOL,
            FIND_TOOLS_TOOL,
            ...Object.keys(agent.builtinTools ?? {}),
          ],
          // The notebook is the parent's: a helper sees a part of the task and none of its
          // outcome, so it reports what it learned and the parent decides what is a lesson.
          withheld: [SAVE_SKILL_TOOL, FORGET_SKILL_TOOL],
        },
      )
      const depth = scope.depth + 1
      const tools: ToolSet = {}
      for (const name of names) {
        tools[name] = parentTools[name]
      }
      // A helper may start helpers only below the depth limit, and only if its parent can.
      const maySpawn = depth < settings.maxDepth && parentTools[SPAWN_SUBAGENT_TOOL] !== undefined
      if (maySpawn) {
        tools[SPAWN_SUBAGENT_TOOL] = parentTools[SPAWN_SUBAGENT_TOOL]
      }
      const catalog = parentCatalog.filter((c) => Object.hasOwn(tools, c.name))

      scope.root.subagentsSpawned = (scope.root.subagentsSpawned ?? 0) + 1
      const id = randomUUID()
      const name = SPAWN_SUBAGENT_TOOL
      const emitParent: EventHandler = store.emit ?? (() => {})
      // Events of the helper are raised inside ITS run; they are emitted on the parent from the
      // parent's own context, so they carry the parent's runId.
      const emit: EventHandler = (event) => runContext.run(store as IRunContext, emitParent, event)
      const release = await scope.acquire(abortSignal)

      const ac = new AbortController()
      const onParentAbort = (): void => ac.abort(abortSignal?.reason)
      let timedOut = false
      let stoppedByUser = false
      let timer: IWaitTimer | undefined
      // The helper's time limit is a deadline of THIS run's clock, and that clock - with this
      // run's step limit on it - is stopped while the helper waits for a person.
      const clock = state.clock ?? createWaitClock()
      const waits = followHumanWaits(clock)
      let unregister: (() => void) | undefined
      let reservation: ISpawnReservation | undefined
      let spent: IUsage = emptyUsage()
      let started = false
      try {
        // ── its budgets: a share of what is left of this run's ───────────
        const parentConfig = scope.config ?? agent.config
        const budget = shareSubagentBudget(
          {
            limits: resolveLimits(parentConfig),
            usage: state.usage,
            maxToolCalls: parentConfig.maxToolCalls,
            toolCalls: state.toolCalls,
            maxIterations: parentConfig.maxIterations,
          },
          scope.running,
          settings,
        )
        const { maxTotalTokens: _legacy, persistence: _none, ...inherited } = parentConfig
        void [_legacy, _none]
        const config: IAgentConfig = {
          ...inherited,
          maxIterations: budget.maxIterations,
          limits: { ...resolveLimits(parentConfig), ...budget.limits },
          ...(budget.maxToolCalls !== undefined ? { maxToolCalls: budget.maxToolCalls } : {}),
        }
        const control = store.control ?? scope.control
        const childScope: ISpawnScope = {
          id,
          depth,
          root: scope.root,
          running: [],
          acquire: createSpawnGate(settings.maxConcurrent),
          tools,
          catalog,
          config,
          parent: state,
          ...(control ? { control } : {}),
        }
        const {
          learning: _learning,
          sandbox: _sandbox,
          subagents: _subagents,
          findTools: _findTools,
          mcpInstructions: _mcp,
          onUsage: _onUsage,
          run: _run,
          takeRoundUpdates: _take,
          ...shared
        } = agent
        void [_learning, _sandbox, _subagents, _findTools, _mcp, _onUsage, _run, _take]
        const mcpInstructions =
          agent.config.mcpInstructions === false
            ? ''
            : renderMcpInstructions(collectMcpInstructions(tools))
        const childCtx: IAgentInternalContext = {
          ...shared,
          config,
          // Its events reach the host through this call only (as subagent.event).
          emit: () => {},
          tools,
          toolCatalog: catalog,
          ...(agent.sandbox && tools[RUN_JS_TOOL] ? { sandbox: agent.sandbox } : {}),
          ...(maySpawn ? { subagents: { dynamic: true } } : {}),
          ...(agent.findTools
            ? { findTools: deps.wrapBuiltin(createFindToolsTool(() => catalog)) }
            : {}),
          ...(mcpInstructions ? { mcpInstructions } : {}),
          spawn: childScope,
        }

        abortSignal?.addEventListener('abort', onParentAbort, { once: true })
        if (abortSignal?.aborted) {
          onParentAbort()
        }
        if (settings.timeoutMs > 0) {
          timer = clock.timer(settings.timeoutMs, () => {
            timedOut = true
            ac.abort(new Error(`the helper timed out after ${settings.timeoutMs}ms`))
          })
        }
        reservation = {
          limits: budget.limits,
          ...(budget.maxToolCalls !== undefined ? { maxToolCalls: budget.maxToolCalls } : {}),
          usage: () => spent,
          toolCalls: () => childScope.toolCalls ?? 0,
        }
        scope.running.push(reservation)

        const onChildEvent: EventHandler = (event: AgentEvent) => {
          waits.see(event)
          if (event.type === 'usage') {
            // Charged to the parent as it happens: the parent's limits see a long-running helper.
            const usage = normalizeUsage(event.usage)
            spent = addUsage(spent, usage)
            emit({ type: 'usage', phase: 'subagent', usage })
          }
          emit({
            type: 'subagent.event',
            id,
            name,
            event: slimEvent(adoptSubagentEvent(event, id)),
          })
        }
        started = true
        emit({
          type: 'subagent.start',
          id,
          name,
          task: input.task,
          // The parent is this run - or, once the event has passed up through the helper that
          // made this call, that helper (see adoptSubagentEvent).
          ...(store.runId ? { parentId: store.runId } : {}),
          depth: 1,
          dynamic: true,
          ...(input.role ? { role: input.role } : {}),
          tools: names,
        })
        unregister = control?.registerSubagent(
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
            ac.abort(new DOMException('Aborted', 'AbortError'))
          },
        )
        // The helper starts from the task alone: no history, none of the parent's trace.
        const result = await runAgentLoop(childCtx, {
          input: renderSubagentTask(input),
          signal: ac.signal,
          onEvent: onChildEvent,
        })
        emit({ type: 'subagent.complete', id, name, text: result.text, usage: { ...spent } })
        recordWrite(state.stepWrites, SPAWN_SUBAGENT_TOOL, raw, result.text)
        return result.text
      } catch (err) {
        if (!started) {
          // Refused before it began (the budget): nothing was announced, nothing ran.
          scope.root.subagentsSpawned = Math.max(0, (scope.root.subagentsSpawned ?? 1) - 1)
          throw err
        }
        // The user's stop wins over a deadline that fired at the same moment.
        const message = stoppedByUser
          ? 'the helper was stopped by the user before it finished - carry on without its result, or take another approach'
          : timedOut
            ? `the helper timed out after ${settings.timeoutMs}ms`
            : errorMessage(err)
        emit({
          type: 'subagent.error',
          id,
          name,
          error: message,
          ...(stoppedByUser ? { stopped: true } : {}),
          usage: { ...spent },
        })
        if (stoppedByUser || timedOut) {
          throw new Error(`${SPAWN_SUBAGENT_TOOL}: ${message}`)
        }
        throw err
      } finally {
        unregister?.()
        timer?.cancel()
        waits.end()
        abortSignal?.removeEventListener('abort', onParentAbort)
        if (reservation) {
          const i = scope.running.indexOf(reservation)
          if (i >= 0) {
            scope.running.splice(i, 1)
          }
        }
        release()
      }
    },
  })
  // Starting a helper changes nothing by itself: every call the helper makes passes the same
  // gate as the parent's would. So 'ask-writes' and 'read-only' let the spawn through (and still
  // ask about / refuse the helper's writes); 'ask-all' and a rule on spawn_subagent apply to it.
  return markReadOnly(spawn)
}
