import type { IPlan, IPlanStep, IStepResult, IUsage } from './loop-types.js'

/**
 * Run persistence: checkpoints a run so that a page reload, a crashed tab or a
 * killed worker does not lose the work already done. Same hook names as the Node
 * sibling (`@dudko.dev/agent`), where this contract originated.
 *
 * WHAT A CHECKPOINT IS. One is written when the plan is in hand (`onRunStart`)
 * and again at the end of every iteration of the step loop (`onStepComplete`),
 * so it always names a boundary: the steps finished so far, the steps still to
 * run, and the counters. Resuming picks up exactly there — the planner does not
 * run again and a finished step is not repeated.
 *
 * WHAT IT IS NOT. A step that was in flight when the page died is NOT
 * checkpointed — it runs again from its start. For a read that is free; for a
 * write it may apply twice, so a tool with side effects should be idempotent (or
 * the host should keep the consent gate on). Attachments (images, files) are not
 * stored — pass them again to `run()` when resuming.
 *
 * Persistence is observability, not a correctness boundary: a hook that throws is
 * logged and the run carries on. The one exception is `onRunResume`: a resume whose attempt
 * cannot be put on record is refused (see `recordResume`).
 */

export type RunStatus = 'executing' | 'complete' | 'failed' | 'cancelled'

/** Everything needed to continue a run from the end of an iteration. */
export interface RunSnapshot {
  runId: string
  startedAt: number
  /**
   * `executing` is the only non-terminal status the runtime writes. The others are
   * written once, when the run resolves; `failed` and `cancelled` can still be
   * resumed (a stopped run is not a lost one), `complete` cannot.
   */
  status: RunStatus
  /** The goal as first given: a resumed run uses THIS one, whatever `run()` is passed. */
  goal: string
  /** The session the run belongs to; a resumed run keeps it. */
  sessionId: string
  /** The plan as first created (a `revise` later changes `remaining`, not this). */
  plan: IPlan
  /** Steps still to run, after any `revise`. */
  remaining: IPlanStep[]
  /** Finished steps, as the run's trace. */
  trace: IStepResult[]
  /** The step log later steps and the answer are written from. */
  done: string[]
  /** Tool findings the synthesizer is given. */
  findings: string[]
  usage: IUsage
  /** Steps executed so far (the cap `maxIterations` counts these — across a crash). */
  iterations: number
  /** Replanner `revise` decisions so far (`maxRevisions`). */
  revisions: number
  /** Successful tool calls so far (`maxToolCalls`). */
  toolCalls: number
  /** Tool calls that went through: `RunResult.applied`. */
  applied: number
  /** Skills whose instructions are active. */
  skills: string[]
  /** Tools activated through `find_tools`, in order. */
  discovered: string[]
  /** How many images/files the run was given (their bytes are not kept). */
  attachments: number
  /**
   * What the user said while the run was going (`RunControl.send`), in order, and whether the
   * replanner has already weighed each. A resumed run keeps them: otherwise it would forget a
   * correction the user had already made.
   */
  userUpdates?: { text: string; reconciled: boolean }[]
  /** Escalations so far (counts against `escalation.maxPerRun` on resume). */
  escalations?: number
  /** Helpers the model started so far (counts against `subagents.dynamic.maxChildren` on resume). */
  subagentsSpawned?: number
  /**
   * The attempt that wrote the snapshot: 1 for the run as first started, one more for every
   * resume - the `attempt` of its events. A resume records its attempt BEFORE any of its events
   * (`onRunResume`), so a crash at any point never lets two attempts share a number. Absent on a
   * snapshot written before the field existed: read as 1.
   */
  attempt?: number
  /** Final answer (status `complete`). */
  text?: string
  /** What ended the run (status `failed`). */
  error?: string
  completedAt?: number
}

export interface RunPersistence {
  /** The plan is in hand and the loop is about to start. Not called again on resume. */
  onRunStart?: (snapshot: RunSnapshot) => void | Promise<void>
  /** An iteration finished: a checkpoint to resume from. */
  onStepComplete?: (snapshot: RunSnapshot) => void | Promise<void>
  /** The run resolved: `complete`, `failed` (it threw) or `cancelled` (it was stopped). */
  onRunComplete?: (snapshot: RunSnapshot) => void | Promise<void>
  /**
   * A resume is starting: the loaded snapshot with the NEW `attempt` (status `executing`),
   * written before the resumed run emits anything, so that a crash before its first checkpoint
   * still leaves the attempt on record. Without it the same write goes to `onStepComplete`.
   * Unlike the other write hooks this one is NOT best-effort: a throw fails the resume (nothing
   * ran) - an attempt that is not on record would be reused by the next resume.
   */
  onRunResume?: (snapshot: RunSnapshot) => void | Promise<void>
  /**
   * What `run(goal, { resumeFromRunId })` reads. Return `null` when there is none.
   * An implementation that does not want to support resume can leave it out.
   */
  loadRun?: (runId: string) => RunSnapshot | null | Promise<RunSnapshot | null>
}

// A run id is a key in someone's store and may end up in a URL or a file name by
// way of a custom persistence layer: keep it boring.
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/

export const assertSafeRunId = (runId: unknown, label = 'runId'): string => {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) {
    throw new Error(`${label} must be 1-128 characters of letters, digits, "_" or "-"`)
  }
  return runId
}

/**
 * Load and validate the snapshot a `resumeFromRunId` names. Throws a message the
 * caller can act on for: no `loadRun`, no such run, a store that answers with a
 * different run, a run that already completed, a snapshot with nothing left to do.
 * Persistence is host-controlled, so what `loadRun` returns is not trusted.
 */
export const resolveResume = async (
  persistence: RunPersistence | undefined,
  resumeFromRunId: string | undefined,
): Promise<RunSnapshot | undefined> => {
  if (resumeFromRunId === undefined) return undefined
  assertSafeRunId(resumeFromRunId, 'resumeFromRunId')
  if (!persistence?.loadRun) {
    throw new Error('resumeFromRunId requires `persistence.loadRun` to be implemented')
  }
  const snapshot = await persistence.loadRun(resumeFromRunId)
  if (!snapshot) throw new Error(`No persisted run found for runId "${resumeFromRunId}"`)
  assertSafeRunId(snapshot.runId, 'snapshot.runId')
  if (snapshot.runId !== resumeFromRunId) {
    throw new Error(
      `Persistence returned runId "${snapshot.runId}" for resumeFromRunId "${resumeFromRunId}"; refusing to resume on mismatch`,
    )
  }
  if (snapshot.status === 'complete') {
    throw new Error(`Run "${resumeFromRunId}" is already complete; nothing to resume`)
  }
  if (!snapshot.plan || !Array.isArray(snapshot.remaining) || !Array.isArray(snapshot.trace)) {
    throw new Error(
      `Run "${resumeFromRunId}" has no usable checkpoint (status="${snapshot.status}"); cannot resume`,
    )
  }
  if (snapshot.remaining.length === 0) {
    throw new Error(
      `Run "${resumeFromRunId}" has no steps left to run (status="${snapshot.status}"); nothing to resume`,
    )
  }
  // The attempt numbers the run's events across crashes: one the store mangled could make two
  // attempts share a number, and the order of the run's events would be ambiguous.
  if (
    snapshot.attempt !== undefined &&
    !(Number.isSafeInteger(snapshot.attempt) && snapshot.attempt >= 1)
  ) {
    throw new Error(
      `Run "${resumeFromRunId}" has an invalid attempt (${JSON.stringify(snapshot.attempt)}); it must be a positive integer`,
    )
  }
  return snapshot
}

/**
 * The id a caller gives a fresh run (`RunOptions.runId`), checked before anything of the run
 * happens: the rule of every run id, refused together with `resumeFromRunId` (a resume keeps the
 * id of the run it resumes), and refused when `persistence.loadRun` has a snapshot for it - resume
 * that run instead; a run on record is never written over. A store that throws refuses the run
 * too: no answer is not a "free". `undefined` when no id was given.
 */
export const resolveRunId = async (
  persistence: RunPersistence | undefined,
  runId: string | undefined,
  resumeFromRunId: string | undefined,
): Promise<string | undefined> => {
  if (runId === undefined) return undefined
  if (resumeFromRunId !== undefined) {
    throw new Error(
      'runId names a fresh run and cannot be combined with resumeFromRunId: a resume keeps the id of the run it resumes',
    )
  }
  assertSafeRunId(runId, 'runId')
  const snapshot = await persistence?.loadRun?.(runId)
  if (snapshot) {
    throw new Error(
      `Run "${runId}" already exists (status "${snapshot.status}"); resume it with resumeFromRunId instead of starting it again`,
    )
  }
  return runId
}

/** The attempt a resume of `snapshot` runs as: one more than the attempt that wrote it. */
export const resumeAttemptOf = (snapshot: RunSnapshot): number => (snapshot.attempt ?? 1) + 1

/**
 * A resume starts: its attempt goes on record BEFORE any of its events (`onRunResume`, else
 * `onStepComplete`). Throws when the store cannot record it - an attempt that is not on record
 * would be reused by the next resume, and two attempts would share a number.
 */
export const recordResume = async (
  persistence: RunPersistence | undefined,
  resumed: RunSnapshot,
  attempt: number,
  warn: (message: string) => void,
): Promise<void> => {
  const hook = persistence?.onRunResume
    ? ('onRunResume' as const)
    : persistence?.onStepComplete
      ? ('onStepComplete' as const)
      : undefined
  if (!persistence || !hook) {
    warn(
      `persistence has neither onRunResume nor onStepComplete: attempt ${attempt} of run ${resumed.runId} is not on record until the run ends`,
    )
    return
  }
  const { error: _error, completedAt: _completedAt, text: _text, ...rest } = resumed
  void [_error, _completedAt, _text]
  try {
    await persistence[hook]?.call(persistence, { ...rest, status: 'executing', attempt })
  } catch (err) {
    throw new Error(
      `persistence.${hook} threw while recording attempt ${attempt} of run ${resumed.runId}; the resume was refused: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

// The Node sibling's server-only hooks (docs/design.md, "The call journal and parking: names
// reserved, server-only"). Their names are reserved here and REFUSED: code written for the server
// agent fails at createAgent / run instead of running without the guarantee it was written for
// (a journal that is never written, a lease nobody holds, limits nobody counts).
const SERVER_ONLY = "is the server package's (@dudko.dev/agent), not this browser package's"

/** Throws when a config carries a hook only the Node sibling has. */
export const refuseServerOnlyConfig = (config: object): void => {
  const c = config as Record<string, unknown>
  for (const key of ['runLease', 'sharedLimits'] as const) {
    if (c[key] !== undefined) {
      throw new Error(`${key} ${SERVER_ONLY}: a run in a page has no other worker to share with`)
    }
  }
  const persistence = c.persistence as Record<string, unknown> | undefined
  if (persistence?.journal !== undefined) {
    throw new Error(
      `persistence.journal ${SERVER_ONLY}: a page's run is not resumed by another worker, and IndexedDB in a tab that may close at any moment is not the fail-closed store a journal needs`,
    )
  }
}

/** Throws when run options carry what only the Node sibling's parked runs take. */
export const refuseServerOnlyRunOptions = (opts: object): void => {
  if ((opts as Record<string, unknown>).answers !== undefined) {
    throw new Error(`run({ answers }) ${SERVER_ONLY}: there are no parked runs here to answer`)
  }
}
