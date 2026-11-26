import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  createPipeline,
  nodeResolver,
  PipelineNodeError,
  validatePipeline,
  type AgentEvent,
  type AgentEventHandler,
  type NodeResolverOptions,
  type Pipeline,
  type PipelineDefinition,
  type PipelineNodeRunner,
  type PipelineOptions,
  type PipelineResult,
  type PipelineValidation,
} from '@dudko.dev/agent-web'
import { errMessage } from '../util.js'
import { createInitialPipelineState, pipelineStateReducer, type PipelineUiState } from './state.js'

export interface UsePipelineOptions {
  /**
   * The agent config of a node - the core's seam. Give this, or the registries below (they are
   * passed to the core's `nodeResolver`), or `runNode`.
   */
  resolveNode?: PipelineOptions['resolveNode']
  /** With registries: the config every node starts from. */
  base?: NodeResolverOptions['base']
  /** What the names in the definition stand for. A name that is not here fails its node. */
  models?: NodeResolverOptions['models']
  skills?: NodeResolverOptions['skills']
  tools?: NodeResolverOptions['tools']
  mcpServers?: NodeResolverOptions['mcpServers']
  configure?: NodeResolverOptions['configure']
  /** Run a node yourself: the pipeline then only schedules (a test, a mock, a custom runner). */
  runNode?: PipelineNodeRunner<AgentEvent>
  /** Every raw event, after the reducer folded it. */
  onEvent?: AgentEventHandler
}

export interface UsePipelineReturn extends PipelineUiState {
  /**
   * Run the pipeline on a request. Resolves with the result, or `undefined` when it could not
   * start (a run in flight, an invalid definition) or a node failed - then see `error`.
   */
  run: (input: string) => Promise<PipelineResult | undefined>
  /** Abort the run in flight; it ends with `stoppedBy: 'aborted'`. */
  stop: () => void
  /** Forget the last run (statuses, outputs, the result). */
  reset: () => void
  isRunning: boolean
  /** The definition, checked by the core: `ok`, `errors`, `warnings`. */
  validation: PipelineValidation
  /** What the last finished run returned. */
  result: PipelineResult | undefined
}

/**
 * The React binding of the core's `createPipeline`: builds the pipeline from a definition,
 * runs it, and folds its events into a renderable {@link PipelineUiState} (per-node status and
 * visits, which edges fired, what each node's agent is doing, outputs, usage).
 *
 * ```tsx
 * const pipeline = usePipeline(definition, { base: { model, credentials }, tools: { files } })
 * // <PipelineEditor value={definition} onChange={setDefinition} controller={pipeline} />
 * ```
 *
 * The node agents live as long as the definition and the options stay the same objects, so
 * keep them referentially stable (`useMemo`) for a node to remember across runs.
 */
export const usePipeline = (
  definition: PipelineDefinition,
  options: UsePipelineOptions = {},
): UsePipelineReturn => {
  const [state, dispatch] = useReducer(pipelineStateReducer, undefined, createInitialPipelineState)
  const validation = useMemo(() => validatePipeline(definition), [definition])

  const latest = useRef({ definition, options, validation })
  latest.current = { definition, options, validation }
  const built = useRef<{ pipeline: Pipeline; key: unknown[] } | undefined>(undefined)
  const controller = useRef<AbortController | undefined>(undefined)
  const result = useRef<PipelineResult | undefined>(undefined)
  const running = useRef(false)
  const mounted = useRef(true)

  const close = useCallback(() => {
    const before = built.current
    built.current = undefined
    void before?.pipeline.close().catch(() => {})
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
      close()
    }
  }, [close])

  const run = useCallback(
    async (input: string): Promise<PipelineResult | undefined> => {
      if (running.current) return undefined
      const { definition: def, options: opts, validation: checked } = latest.current
      dispatch({ type: 'run.start', input })
      result.current = undefined
      if (!checked.ok) {
        dispatch({
          type: 'run.error',
          error: checked.errors.map((e) => e.message).join('; '),
          nodeId: checked.errors.find((e) => e.nodeId)?.nodeId,
        })
        return undefined
      }
      running.current = true
      const abort = new AbortController()
      controller.current = abort
      try {
        const key = [
          def,
          opts.resolveNode,
          opts.runNode,
          opts.base,
          opts.models,
          opts.skills,
          opts.tools,
          opts.mcpServers,
          opts.configure,
        ]
        if (!built.current || built.current.key.some((value, i) => value !== key[i])) {
          close()
          const resolveNode =
            opts.resolveNode ??
            (opts.base
              ? nodeResolver({
                  base: opts.base,
                  models: opts.models,
                  skills: opts.skills,
                  tools: opts.tools,
                  mcpServers: opts.mcpServers,
                  configure: opts.configure,
                })
              : undefined)
          built.current = {
            key,
            pipeline: createPipeline(def, { runNode: opts.runNode, resolveNode }),
          }
        }
        const done = await built.current.pipeline.run({
          input,
          signal: abort.signal,
          onEvent: (event) => {
            if (mounted.current) dispatch({ type: 'event', event })
            latest.current.options.onEvent?.(event)
          },
        })
        result.current = done
        if (mounted.current) dispatch({ type: 'run.result', result: done })
        return done
      } catch (err) {
        if (mounted.current) {
          dispatch({
            type: 'run.error',
            error: errMessage(err),
            nodeId: err instanceof PipelineNodeError ? err.nodeId : undefined,
          })
        }
        return undefined
      } finally {
        running.current = false
        if (controller.current === abort) controller.current = undefined
      }
    },
    [close],
  )

  const stop = useCallback(() => controller.current?.abort(), [])
  const reset = useCallback(() => {
    if (running.current) return
    result.current = undefined
    dispatch({ type: 'reset' })
  }, [])

  return {
    ...state,
    run,
    stop,
    reset,
    isRunning: state.status === 'running',
    validation,
    result: result.current,
  }
}
