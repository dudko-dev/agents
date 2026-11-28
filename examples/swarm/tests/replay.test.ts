// Replay safety: sessions live for days, so the workflow code of this tree must replay the
// histories of sessions that ran on earlier code, and its own. No server: a replay is local.
//
//   before-subagents.history.json  recorded with the session workflow of main before static
//                                  subagents (ba55733): two turns, then stop + end
//   subagents.history.json         recorded with this code: a turn parks on two subagent calls,
//                                  two child workflows, the patch marker, the resume
//   subagents-staggered.history.json  the same with children that end far apart: the last one's
//                                  answer and its marker come together, and the marker is written
//                                  BEFORE the turn resumes (its events sort before the resumed ones)
//   pipelines.history.json         recorded with this code: a turn parks on a pipeline call, the
//                                  patch marker (swarm-pipeline-children-v1), one child `pipeline`,
//                                  the resume, then stop + end
//   pipeline.history.json          that child: the graph engine as the scheduler - a node, a wave
//                                  of two started in one task (they end in the other order), a
//                                  routed node, the node it routes to - and the stream's batches
//   pipeline-node.history.json     one visit of the routed node: its activity, its turn.ended
//   child-parking.history.json     recorded with this code: a turn parks on a subagent call, its
//                                  child waits for a person - the child's notices (childPark), the
//                                  patch marker (swarm-child-parking-v1), its waiting / resumed
//                                  markers - then the child ends and the turn resumes
//   subagent-parked.history.json   that child: the patch marker, its activity parks, it tells the
//                                  session, takes the answer (a signal), tells it again, resumes the
//                                  same run, then its turn.ended (closing its items)
//   node-parking.history.json      the same with a pipeline call whose node visit waits
//   pipeline-node-parked.history.json  that visit (draft): parks, answered, resumed
//
// A change that alters the commands a recorded session replays fails here: put it behind
// patched() (session-api.ts, PATCH_*) or a new workflow type, and record a new fixture for it.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Runtime, Worker } from '@temporalio/worker'
import { DEFAULT_BUNDLE_PATH, WORKFLOWS_PATH } from '../src/paths.ts'

const silent = { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} }
Runtime.install({ logger: silent })

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}.history.json`, import.meta.url), 'utf8'))

const replay = async (name: string, workflowId = `session-${name}`): Promise<void> =>
  Worker.runReplayHistory(
    existsSync(DEFAULT_BUNDLE_PATH)
      ? { workflowBundle: { codePath: DEFAULT_BUNDLE_PATH } }
      : { workflowsPath: WORKFLOWS_PATH },
    await fixture(name),
    workflowId,
  )

test('a session recorded before static subagents replays on this code', async () => {
  await replay('before-subagents')
})

test('a session with subagent children replays on this code (deterministic)', async () => {
  await replay('subagents')
})

test('the last child marker is written before the turn resumes (replay)', async () => {
  await replay('subagents-staggered')
})

test('a session with a pipeline child replays on this code (deterministic)', async () => {
  await replay('pipelines')
})

test('a pipeline workflow replays on this code: the engine schedules the same visits', async () => {
  await replay('pipeline', 'pipeline-fixture')
})

test('a pipeline node visit replays on this code', async () => {
  await replay('pipeline-node', 'pipeline-node-fixture')
})

test('a session whose subagent child waited for a person replays on this code', async () => {
  await replay('child-parking')
})

test('a subagent child that parked and was answered replays on this code', async () => {
  await replay('subagent-parked', 'subagent-fixture-child-parking-run-fixture-parent-p_sub')
})

test('a session whose pipeline node visit waited for a person replays on this code', async () => {
  await replay('node-parking')
})

test('a pipeline node visit that parked and was answered replays on this code', async () => {
  await replay(
    'pipeline-node-parked',
    'pipeline-fixture-node-parking-run-fixture-parent-p_pipe.draft.1',
  )
})
