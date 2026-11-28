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

const replay = async (name: string): Promise<void> =>
  Worker.runReplayHistory(
    existsSync(DEFAULT_BUNDLE_PATH)
      ? { workflowBundle: { codePath: DEFAULT_BUNDLE_PATH } }
      : { workflowsPath: WORKFLOWS_PATH },
    await fixture(name),
    `session-${name}`,
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
