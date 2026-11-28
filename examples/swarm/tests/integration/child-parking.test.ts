// Children that wait for a person, end to end: a static subagent child and a pipeline node visit
// whose run asks before a write (ask-writes) park their OWN run - the child workflow holds no slot,
// the parent turn waits for its child as it always does - and the person's answer comes through
// the gateway's answer route, which looks the item up in the session and signals it to the child
// that owns it. The child resumes the same run and the write runs exactly once. A deny answer is a
// denied call; two children wait at once and a partial answer keeps one waiting; a stop ends a
// waiting child and closes its items; CHILD_ASK=deny keeps the old behaviour (nothing parks); a
// worker killed while a child waits changes nothing.
import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import type { TestWorkflowEnvironment } from '@temporalio/testing'
import { tool } from 'ai'
import type pg from 'pg'
import { z } from 'zod'
import { insertSessionSql } from '../../src/backend.ts'
import { compareCursors, parseCursor, type ICursor } from '../../src/cursor.ts'
import { createParkedStore } from '../../src/db/parked.ts'
import type { IRunningGateway } from '../../src/gateway-main.ts'
import type { IPipelineConfig } from '../../src/pipelines.ts'
import {
  answerSignal,
  childStateQuery,
  pipelineNodeWorkflowIdOf,
  pipelineWorkflowIdOf,
  SESSION_WORKFLOW,
  subagentWorkflowIdOf,
  workflowIdOf,
} from '../../src/session-api.ts'
import { SUBAGENT_MARKER_SEQ } from '../../src/session-state.ts'
import type { IChildWaiting, IParkedRequest, ISessionView } from '../../src/session-types.ts'
import type { ISubagentProfile } from '../../src/subagents.ts'
import type { IRunningWorker } from '../../src/worker.ts'
import {
  agentConfig,
  api,
  childWorker,
  DATABASE_URL,
  exited,
  gatewayConfig,
  inProcessGateway,
  inProcessWorker,
  migrated,
  planJson,
  readSse,
  roundOf,
  sessionOptions,
  stageOf,
  startLocalOpenAI,
  startTemporal,
  systemOf,
  toolNames,
  toolResults,
  uniqueQueue,
  until,
  userOf,
  workerConfig,
  type IChatRequest,
  type ILocalOpenAI,
  type ISseEvent,
} from './harness.ts'

const NOTES_WORKER = fileURLToPath(new URL('./notes-worker.ts', import.meta.url))

let temporal: TestWorkflowEnvironment
let pool: pg.Pool
let llm: ILocalOpenAI
let parkWorker: IRunningWorker
let denyWorker: IRunningWorker
let gateway: IRunningGateway
let base: string
let parkQueue: string
let denyQueue: string
let crashQueue: string
let dir: string
let notes: string
const processes: ChildProcess[] = []
// Every write the in-process workers' tool made.
const written: string[] = []

// A write tool (not read-only): under ask-writes every call asks a person.
const writeNote = tool({
  description: 'Write a note (a write).',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => {
    written.push(text)
    return `wrote ${text}`
  },
})

// The subagent: a profile with the write tool. Its own call is read-only for the parent (the
// parent's call does not ask); the child's write does.
const writer: ISubagentProfile = {
  description: 'Write the notes it is given',
  systemPrompt: 'ROLE=writer',
  tools: ['write_note'],
  readOnly: true,
}

// draft (writes, asks) -> final.
const chain: IPipelineConfig = {
  description: 'Draft the notes, then finish',
  readOnly: true,
  definition: {
    version: 1,
    entry: 'draft',
    nodes: [
      { id: 'draft', instructions: 'NODE=draft', tools: ['write_note'] },
      { id: 'final', instructions: 'NODE=final' },
    ],
    edges: [{ from: 'draft', to: 'final' }],
  },
}

// Who a request is for: the writer child, a node, or the parent (none).
const whoOf = (req: IChatRequest): string | undefined =>
  /(?:ROLE|NODE)=([a-z]+)/.exec(systemOf(req))?.[1]

before(async () => {
  pool = await migrated()
  temporal = await startTemporal()
  dir = mkdtempSync(join(tmpdir(), 'swarm-child-parking-'))
  notes = join(dir, 'notes.txt')
  writeFileSync(notes, '')
  llm = await startLocalOpenAI((req) => {
    const stage = stageOf(req)
    if (stage === 'replanner') {
      return { text: JSON.stringify({ decision: 'continue', reason: 'ok' }) }
    }
    const who = whoOf(req)
    if (who) {
      if (stage === 'planner') return { text: planJson(['w']) }
      if (stage === 'synthesizer') {
        const wrote = [...new Set([...userOf(req).matchAll(/wrote ([a-z0-9]+)/g)].map((m) => m[1]))]
        return {
          text: `${who} says: ${wrote.length ? `wrote ${wrote.join(',')}` : 'nothing written'}`,
        }
      }
      // The child's executor: one write per name of its task ("write: a, b"), all in one round.
      if (roundOf(req) === 0 && toolNames(req).includes('write_note')) {
        const names = (/write: ([a-z0-9, ]+)/.exec(userOf(req))?.[1] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        if (names.length) {
          return { toolCalls: names.map((text) => ({ name: 'write_note', args: { text } })) }
        }
      }
      return { text: `${who} did it (${toolResults(req).join(' | ')})` }
    }
    if (stage === 'planner') return { text: planJson(['a']) }
    if (stage === 'synthesizer') return { text: `final: ${userOf(req).slice(0, 4000)}` }
    if (roundOf(req) === 0) {
      // "writers: a b | c": one writer call per group, all in one round.
      const groups = /writers: ([a-z0-9 |]+)/.exec(userOf(req))?.[1]
      if (groups && toolNames(req).includes('writer')) {
        return {
          toolCalls: groups.split('|').map((g) => ({
            name: 'writer',
            args: { task: `write: ${g.trim().split(/\s+/).join(', ')}` },
          })),
        }
      }
      const piped = /chain: ([a-z0-9]+)/.exec(userOf(req))?.[1]
      if (piped && toolNames(req).includes('chain')) {
        return { toolCalls: [{ name: 'chain', args: { task: `write: ${piped}` } }] }
      }
    }
    return { text: `results: ${toolResults(req).join(' | ')}` }
  })
  const agent = agentConfig(llm.baseURL, {
    tools: { write_note: writeNote },
    toolApproval: { mode: 'ask-writes' },
  })
  parkQueue = uniqueQueue('childpark')
  denyQueue = uniqueQueue('childdeny')
  crashQueue = uniqueQueue('childcrash')
  parkWorker = await inProcessWorker(
    workerConfig(temporal, parkQueue, agent, {
      subagents: { writer },
      pipelines: { chain },
      childAsk: 'park',
    }),
  )
  denyWorker = await inProcessWorker(
    workerConfig(temporal, denyQueue, agent, {
      subagents: { writer },
      pipelines: { chain },
      childAsk: 'deny',
    }),
  )
  gateway = await inProcessGateway(gatewayConfig(temporal, parkQueue))
  base = `http://127.0.0.1:${gateway.port}`
})

after(async () => {
  for (const c of processes) c.kill('SIGKILL')
  await gateway?.close()
  parkWorker?.shutdown()
  denyWorker?.shutdown()
  await parkWorker?.done
  await denyWorker?.done
  await temporal?.teardown()
  await llm?.close()
  await pool?.end()
  rmSync(dir, { recursive: true, force: true })
})

const client = () => api(base)
const ended = (turn: number) => (seen: ISseEvent[]) =>
  seen.some((e) => e.data.event.type === 'turn.ended' && e.data.turn === turn)
const cursorOf = (e: ISseEvent): ICursor => {
  const parsed = parseCursor(e.id)
  assert.ok(parsed.ok)
  return parsed.cursor
}
const inOrder = (events: ISseEvent[]): void => {
  for (let i = 1; i < events.length; i++) {
    assert.ok(compareCursors(cursorOf(events[i - 1]!), cursorOf(events[i]!)) < 0, 'in order')
  }
}

type Parked = NonNullable<ISessionView['parked']>

// The session's state once `n` children wait (and, with `ids`, for exactly those items).
const waitingFor = async (sessionId: string, n: number, timeoutMs = 60_000): Promise<Parked> =>
  until(
    `${n} waiting children`,
    async () => {
      const s = await client().get(`/sessions/${sessionId}`)
      const p = s.body.parked as Parked | undefined
      return p && (p.waiting?.length ?? 0) === n ? p : undefined
    },
    timeoutMs,
  )

const rowOf = async (sessionId: string, itemId: string) =>
  (
    await pool.query<{
      state: string
      owner_id: string | null
      owner_item: string | null
      owner_node: string | null
      owner_visit: number | null
      answered_by: string
      turn: number
    }>(
      'SELECT state, owner_id, owner_item, owner_node, owner_visit, answered_by, turn FROM swarm_parked WHERE session_id = $1 AND item_id = $2',
      [sessionId, itemId],
    )
  ).rows[0]

const answer = (sessionId: string, id: string, body: unknown) =>
  client().post(`/sessions/${sessionId}/answers/${id}`, body)

const codeOf = (r: { body: Record<string, unknown> }): string | undefined =>
  (r.body.error as { code?: string } | undefined)?.code

// A session started on another task queue (the deny worker's, the crash workers'), as the
// gateway would start it on its own.
const startOn = async (queue: string, text: string): Promise<string> => {
  const sessionId = randomUUID()
  await pool.query(insertSessionSql, [sessionId, workflowIdOf(sessionId)])
  await temporal.client.workflow.signalWithStart(SESSION_WORKFLOW, {
    taskQueue: queue,
    workflowId: workflowIdOf(sessionId),
    args: [{ sessionId, options: sessionOptions() }],
    signal: 'message',
    signalArgs: [{ id: 'm1', text, at: 1 }],
  })
  return sessionId
}

test('(a) a subagent child asks for a write: it parks, the answer comes through the gateway, the write runs once', async () => {
  written.length = 0
  const { body } = await client().post('/sessions', { message: 'writers: alpha' })
  const sessionId = body.sessionId as string
  const parked = await waitingFor(sessionId, 1)
  // What waits: the child (which item of the turn, its workflow) and its question.
  const call = parked.requests[0]!
  assert.equal(call.subagent?.name, 'writer')
  const w = parked.waiting![0]!
  assert.equal(w.kind, 'subagent')
  assert.equal(w.itemId, call.requestId)
  assert.equal(w.name, 'writer')
  assert.equal(w.workflowId, subagentWorkflowIdOf(sessionId, parked.runId, call.requestId))
  assert.equal(w.events, `/sessions/${sessionId}/subagents/${call.requestId}/events`)
  assert.equal(w.requests.length, 1)
  const item = w.requests[0]!
  assert.equal(item.kind, 'approval')
  const question = item.question as { request: { toolName: string; input: unknown } }
  assert.equal(question.request.toolName, 'write_note')
  assert.deepEqual(question.request.input, { text: 'alpha' })
  assert.deepEqual(written, [], 'nothing written before the answer')
  // The item is the session's, owned by the child, in the parent's turn.
  assert.deepEqual(await rowOf(sessionId, item.requestId), {
    state: 'pending',
    owner_id: w.workflowId,
    owner_item: call.requestId,
    owner_node: null,
    owner_visit: null,
    answered_by: 'client',
    turn: 1,
  })
  // The child holds no slot: no activity of it is running, its own state says it waits.
  const child = temporal.client.workflow.getHandle(w.workflowId)
  const desc = await child.describe()
  assert.equal(desc.status.name, 'RUNNING')
  assert.equal(desc.raw.pendingActivities?.length ?? 0, 0, 'no activity while it waits')
  const own = await child.query(childStateQuery)
  assert.equal(own.status, 'waiting')
  assert.deepEqual(own.parked?.answered, [])

  // The gateway: another session's id is a 404 (as an unknown item), a wrong shape a 400.
  const other = (await client().post('/sessions')).body.sessionId as string
  const foreign = await answer(other, item.requestId, { approved: true })
  assert.equal(foreign.status, 404)
  assert.equal(codeOf(foreign), 'not_found')
  // The lookup itself, in Postgres: the item is found in its session only.
  const store = createParkedStore(pool)
  assert.equal((await store.item(other, item.requestId))?.state, undefined)
  assert.equal((await store.item(sessionId, item.requestId))?.state, 'pending')
  const bad = await answer(sessionId, item.requestId, { output: 'x' })
  assert.equal(bad.status, 400)
  assert.equal(codeOf(bad), 'invalid_answer')
  // The workflow checks again: a wrong shape, or an id it does not wait for, signalled to it
  // directly (around the gateway), is not taken.
  await child.signal(answerSignal, {
    requestId: item.requestId,
    value: { approved: 'yes' },
    at: 1,
  })
  await child.signal(answerSignal, { requestId: 'p_other', value: { approved: true }, at: 1 })
  const still = await child.query(childStateQuery)
  assert.equal(still.status, 'waiting')
  assert.deepEqual(still.parked?.answered, [], 'refused by the workflow')
  assert.deepEqual(written, [])

  const ok = await answer(sessionId, item.requestId, { approved: true })
  assert.equal(ok.status, 202)
  assert.deepEqual(ok.body.child, { itemId: call.requestId, workflowId: w.workflowId })

  const done = await readSse(`${base}/sessions/${sessionId}/events`, client().headers, ended(1))
  const events = done.events
  inOrder(events)
  const end = events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /writer says: wrote alpha/, 'the child answered the parent')
  assert.deepEqual(written, ['alpha'], 'the write ran exactly once')

  // The parent's stream: started, waiting, resumed, ended - in the parked slot, before the resume.
  const markers = events.filter((e) => e.data.event.type.startsWith('subagent.'))
  const own_ = markers.filter((e) => e.data.event.itemId !== undefined)
  assert.deepEqual(
    own_.map((e) => e.data.event.type),
    ['subagent.started', 'subagent.waiting', 'subagent.resumed', 'subagent.ended'],
  )
  const parkedSlot = cursorOf(events.find((e) => e.data.event.type === 'run.parked')!).attempt
  for (const m of own_) {
    assert.equal(cursorOf(m).attempt, parkedSlot)
    assert.ok(cursorOf(m).seq >= SUBAGENT_MARKER_SEQ)
  }
  // (By the cursor's slot: the child's own markers carry ITS attempt, 2 after its resume.)
  const resumedAt = events.findIndex((e) => cursorOf(e).attempt > parkedSlot)
  assert.equal(events[resumedAt]!.data.event.runId, parked.runId, "the parent's run went on")
  assert.ok(resumedAt > events.indexOf(own_.at(-1)!), 'the markers come before the resume')
  const waitingMarker = own_[1]!.data.event
  assert.equal(waitingMarker.workflowId, w.workflowId)
  assert.deepEqual(waitingMarker.requests, [
    { requestId: item.requestId, kind: 'approval', toolName: 'write_note' },
  ])
  assert.deepEqual(own_[2]!.data.event.answered, [item.requestId])

  // The child's own stream: its run parked (the approval asked), then the same run went on as
  // attempt 2.
  const childStream = await readSse(`${base}${w.events}`, client().headers, ended(1))
  const childTypes = childStream.events.map((e) => e.data.event.type)
  assert.ok(childTypes.includes('tool.approval-requested'))
  assert.ok(childTypes.includes('run.parked'))
  const childEnd = childStream.events.at(-1)!.data.event
  assert.equal(childEnd.status, 'completed')
  assert.equal(childEnd.attempt, 2, 'the same run, resumed')
  assert.equal(childEnd.runId, w.runId)
  assert.equal((await child.describe()).status.name, 'COMPLETED')

  // Answered: once.
  assert.equal((await rowOf(sessionId, item.requestId))?.state, 'answered')
  const again = await answer(sessionId, item.requestId, { approved: true })
  assert.equal(again.status, 409)
  assert.equal(codeOf(again), 'already_answered')
  // The parent's own child item keeps its code.
  const parentItem = await answer(sessionId, call.requestId, { output: 'mine' })
  assert.equal(parentItem.status, 409)
})

test('(b) a pipeline node asks: the visit parks, the answer resumes it, the next node runs, the turn completes', async () => {
  written.length = 0
  const { body } = await client().post('/sessions', { message: 'chain: beta' })
  const sessionId = body.sessionId as string
  const parked = await waitingFor(sessionId, 1)
  const call = parked.requests[0]!
  assert.equal(call.pipeline?.name, 'chain')
  const w = parked.waiting![0]!
  assert.equal(w.kind, 'pipeline')
  assert.equal(w.name, 'chain')
  assert.equal(w.nodeId, 'draft')
  assert.equal(w.visit, 1)
  assert.equal(
    w.workflowId,
    pipelineNodeWorkflowIdOf(
      pipelineWorkflowIdOf(sessionId, parked.runId, call.requestId),
      'draft',
      1,
    ),
  )
  assert.equal(w.events, `/sessions/${sessionId}/pipelines/${call.requestId}/nodes/draft/1/events`)
  const item = w.requests[0]!
  const row = await rowOf(sessionId, item.requestId)
  assert.equal(row?.owner_id, w.workflowId)
  assert.equal(row?.owner_node, 'draft')
  assert.equal(row?.owner_visit, 1)
  assert.deepEqual(written, [])
  // The pipeline waits for its visit; final has not started.
  const pipelineStream = `${base}/sessions/${sessionId}/pipelines/${call.requestId}/events`
  const sofar = await readSse(pipelineStream, client().headers, (seen) =>
    seen.some((e) => e.data.event.type === 'pipeline.node.started'),
  )
  assert.deepEqual(
    sofar.events
      .filter((e) => e.data.event.type === 'pipeline.node.started')
      .map((e) => e.data.event.nodeId),
    ['draft'],
  )

  assert.equal((await answer(sessionId, item.requestId, { approved: true })).status, 202)
  const done = await readSse(`${base}/sessions/${sessionId}/events`, client().headers, ended(1))
  inOrder(done.events)
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /final says/, 'the pipeline went on to its next node')
  assert.deepEqual(written, ['beta'], 'the write ran exactly once')
  const markers = done.events
    .filter((e) => e.data.event.type.startsWith('pipeline.call.'))
    .map((e) => [e.data.event.type, e.data.event.nodeId, e.data.event.visit])
  assert.deepEqual(markers, [
    ['pipeline.call.started', undefined, undefined],
    ['pipeline.call.waiting', 'draft', 1],
    ['pipeline.call.resumed', 'draft', 1],
    ['pipeline.call.ended', undefined, undefined],
  ])
  const own = await readSse(pipelineStream, client().headers, ended(1))
  assert.deepEqual(
    own.events
      .filter((e) => e.data.event.type === 'pipeline.node.started')
      .map((e) => e.data.event.nodeId),
    ['draft', 'final'],
  )
  const visit = await readSse(`${base}${w.events}`, client().headers, ended(1))
  assert.equal(visit.events.at(-1)!.data.event.status, 'completed')
  assert.equal(visit.events.at(-1)!.data.event.attempt, 2)
})

test('(c) a deny answer: the call fails as a denial, the child goes on and answers', async () => {
  written.length = 0
  const { body } = await client().post('/sessions', { message: 'writers: gamma' })
  const sessionId = body.sessionId as string
  const parked = await waitingFor(sessionId, 1)
  const item = parked.waiting![0]!.requests[0]!
  const no = await answer(sessionId, item.requestId, { approved: false, reason: 'not today' })
  assert.equal(no.status, 202)
  const done = await readSse(`${base}/sessions/${sessionId}/events`, client().headers, ended(1))
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /writer says: nothing written/)
  assert.deepEqual(written, [], 'denied: nothing written')
  // The child's round after the answer saw its call fail as a denial, with the reason.
  const resumed = llm.requests.find(
    (r) =>
      whoOf(r) === 'writer' &&
      stageOf(r) === 'executor' &&
      /write: gamma/.test(userOf(r)) &&
      toolResults(r).length === 1,
  )
  assert.ok(resumed, 'the child went on after the denial')
  assert.match(toolResults(resumed).join('\n'), /not today/)
})

test('(d) two children wait at once; answered in either order; a partial answer keeps one waiting', async () => {
  written.length = 0
  const { body } = await client().post('/sessions', { message: 'writers: dx dy | ez' })
  const sessionId = body.sessionId as string
  const parked = await waitingFor(sessionId, 2)
  const byTask = (re: RegExp): IChildWaiting =>
    parked.waiting!.find((w) =>
      parked.requests.some((r) => r.requestId === w.itemId && re.test(r.subagent?.task ?? '')),
    )!
  const x = byTask(/dx, dy/)
  const y = byTask(/ez/)
  assert.equal(x.requests.length, 2, 'two writes in one round: one park, two items')
  assert.equal(y.requests.length, 1)
  const inputOf = (r: IParkedRequest): string =>
    (r.question as { request: { input: { text: string } } }).request.input.text
  const [dx, dy] = ['dx', 'dy'].map((t) => x.requests.find((r) => inputOf(r) === t)!)

  // The second child first: it goes on and ends; the other still waits, the turn is parked.
  assert.equal((await answer(sessionId, y.requests[0]!.requestId, { approved: true })).status, 202)
  const one = await waitingFor(sessionId, 1)
  assert.equal(one.waiting![0]!.workflowId, x.workflowId)
  await until('y to end', async () =>
    (await temporal.client.workflow.getHandle(y.workflowId).describe()).status.name === 'COMPLETED'
      ? true
      : undefined,
  )
  assert.deepEqual(written, ['ez'])
  // A partial answer: x keeps waiting, nothing of it runs.
  assert.equal((await answer(sessionId, dx!.requestId, { approved: true })).status, 202)
  const handle = temporal.client.workflow.getHandle(x.workflowId)
  const half = await until('the first answer to be taken', async () => {
    const s = await handle.query(childStateQuery)
    return s.parked?.answered.includes(dx!.requestId) ? s : undefined
  })
  assert.equal(half.status, 'waiting', 'still waiting for the other item')
  assert.equal((await client().get(`/sessions/${sessionId}`)).body.status, 'parked')
  assert.deepEqual(written, ['ez'], 'the partial answer ran nothing')
  assert.equal((await rowOf(sessionId, dx!.requestId))?.state, 'pending')

  assert.equal((await answer(sessionId, dy!.requestId, { approved: true })).status, 202)
  const done = await readSse(`${base}/sessions/${sessionId}/events`, client().headers, ended(1))
  inOrder(done.events)
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /writer says: wrote dx,dy/)
  assert.match(String(end.text), /writer says: wrote ez/)
  assert.deepEqual([...written].sort(), ['dx', 'dy', 'ez'], 'each write once')
  const types = done.events
    .filter((e) => e.data.event.type.startsWith('subagent.') && e.data.event.itemId)
    .map((e) => `${e.data.event.type}:${e.data.event.itemId === x.itemId ? 'x' : 'y'}`)
  assert.deepEqual(types.slice(0, 2).sort(), ['subagent.started:x', 'subagent.started:y'])
  assert.deepEqual(types.slice(2, 4).sort(), ['subagent.waiting:x', 'subagent.waiting:y'])
  assert.deepEqual(types.slice(4), [
    'subagent.resumed:y',
    'subagent.ended:y',
    'subagent.resumed:x',
    'subagent.ended:x',
  ])
})

test('(e) a stop while a child waits: the child ends, its item is closed, a later answer is refused', async () => {
  written.length = 0
  const { body } = await client().post('/sessions', { message: 'writers: stopme' })
  const sessionId = body.sessionId as string
  const parked = await waitingFor(sessionId, 1)
  const w = parked.waiting![0]!
  const item = w.requests[0]!
  assert.equal((await client().post(`/sessions/${sessionId}/stop`)).status, 202)
  const done = await readSse(`${base}/sessions/${sessionId}/events`, client().headers, ended(1))
  assert.equal(done.events.at(-1)!.data.event.status, 'stopped')
  const closed = await until('the item to be closed', async () => {
    const r = await rowOf(sessionId, item.requestId)
    return r?.state === 'cancelled' ? r : undefined
  })
  assert.equal(closed.state, 'cancelled')
  const late = await answer(sessionId, item.requestId, { approved: true })
  assert.equal(late.status, 404, 'nothing waits for it any more')
  const status = await until('the child to be over', async () => {
    const d = await temporal.client.workflow.getHandle(w.workflowId).describe()
    return d.status.name === 'RUNNING' ? undefined : d.status.name
  })
  assert.equal(status, 'CANCELLED')
  const child = await readSse(`${base}${w.events}`, client().headers, ended(1))
  assert.equal(child.events.at(-1)!.data.event.status, 'stopped')
  // The store says the same once the child itself is over: nothing of it pending.
  const store = createParkedStore(pool)
  assert.equal((await store.item(sessionId, item.requestId))?.state, 'cancelled')
  assert.deepEqual(written, [])
})

test('(f) CHILD_ASK=deny keeps the old behaviour: the ask is a denial, nothing parks', async () => {
  written.length = 0
  const sessionId = await startOn(denyQueue, 'writers: denied')
  const done = await readSse(
    `${base}/sessions/${sessionId}/events`,
    client().headers,
    ended(1),
    60_000,
  )
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /writer says: nothing written/)
  assert.deepEqual(written, [])
  assert.equal(
    done.events.filter((e) => /\.(waiting|resumed)$/.test(e.data.event.type)).length,
    0,
    'no child waited',
  )
  const owned = await pool.query(
    'SELECT 1 FROM swarm_parked WHERE session_id = $1 AND owner_id IS NOT NULL',
    [sessionId],
  )
  assert.equal(owned.rowCount, 0, 'no item of a child')
  const listed = await client().get(`/sessions/${sessionId}/subagents`)
  const sub = (listed.body.subagents as { itemId: string }[])[0]!
  const child = await readSse(
    `${base}/sessions/${sessionId}/subagents/${sub.itemId}/events`,
    client().headers,
    ended(1),
  )
  const types = child.events.map((e) => e.data.event.type)
  assert.ok(!types.includes('run.parked'), 'the child did not park')
  assert.equal(child.events.at(-1)!.data.event.attempt, 1, 'one attempt, no resume')
})

test('(g) a worker killed while a child waits changes nothing: another one resumes it after the answer', async () => {
  const env = (name: string): Record<string, string> => ({
    DATABASE_URL,
    PG_POOL_MAX: '3',
    TEMPORAL_ADDRESS: temporal.address,
    TEMPORAL_TASK_QUEUE: crashQueue,
    WORKER_IDENTITY: name,
    WORKER_HEALTH_PORT: '0',
    WORKER_HEARTBEAT_THROTTLE_MS: '200',
    WORKER_SHUTDOWN_GRACE_MS: '1000',
    LEASE_TTL_MS: '1500',
    AGENT_PROVIDER_TYPE: 'openai-compatible',
    AGENT_BASE_URL: llm.baseURL,
    AGENT_API_KEY: 'not-a-real-key',
    AGENT_MODEL: 'scripted',
    AGENT_LOG_LEVEL: 'none',
    AGENT_TOOL_APPROVAL: 'ask-writes',
    CHILD_ASK: 'park',
    LOG_LEVEL: 'warn',
    SUBAGENTS: JSON.stringify({ writer }),
    SWARM_TEST_NOTES: notes,
  })
  const a = childWorker(env('worker-a'), NOTES_WORKER)
  processes.push(a)
  const sessionId = await startOn(crashQueue, 'writers: crash')
  const parked = await waitingFor(sessionId, 1, 90_000)
  const w = parked.waiting![0]!
  assert.equal(readFileSync(notes, 'utf8'), '', 'nothing written yet')
  a.kill('SIGKILL')
  assert.equal(await exited(a), null)

  // Nothing ran while it waited, so nothing is lost: the answer is taken with no worker at all.
  const ok = await answer(sessionId, w.requests[0]!.requestId, { approved: true })
  assert.equal(ok.status, 202)
  const b = childWorker(env('worker-b'), NOTES_WORKER)
  processes.push(b)
  const done = await readSse(
    `${base}/sessions/${sessionId}/events`,
    client().headers,
    ended(1),
    120_000,
  )
  const end = done.events.at(-1)!.data.event
  assert.equal(end.status, 'completed')
  assert.match(String(end.text), /writer says: wrote crash/)
  assert.equal(readFileSync(notes, 'utf8'), 'crash\n', 'the write ran exactly once')
  // One child for the item (the session's history), its run resumed once.
  const history = await temporal.client.workflow.getHandle(workflowIdOf(sessionId)).fetchHistory()
  assert.equal(
    (history.events ?? []).filter((e) => e.childWorkflowExecutionStartedEventAttributes).length,
    1,
  )
  const runs = await pool.query<{ run_no: number; attempt: number; status: string }>(
    "SELECT run_no, attempt, status FROM swarm_runs WHERE session_id LIKE $1 || '/%'",
    [sessionId],
  )
  assert.deepEqual(
    runs.rows.map((r) => [r.run_no, r.attempt, r.status]),
    [[1, 2, 'complete']],
  )
  b.kill('SIGTERM')
  assert.equal(await exited(b), 0)
})
