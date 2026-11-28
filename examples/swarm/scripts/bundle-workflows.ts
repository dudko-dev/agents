// `build`: bundle the workflow code once, at build time, into dist/workflow-bundle.js. A worker
// that finds it starts without webpack and never writes to disk (the image runs with a read-only
// root filesystem); without it the worker bundles src/workflows.ts at start.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { bundleWorkflowCode } from '@temporalio/worker'
import { DEFAULT_BUNDLE_PATH, WORKFLOWS_PATH } from '../src/paths.ts'

const { code } = await bundleWorkflowCode({
  workflowsPath: WORKFLOWS_PATH,
  logger: {
    log: () => {},
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (message) => process.stderr.write(`[bundle] ${message}\n`),
    error: (message) => process.stderr.write(`[bundle] ${message}\n`),
  },
})
await mkdir(dirname(DEFAULT_BUNDLE_PATH), { recursive: true })
await writeFile(DEFAULT_BUNDLE_PATH, code)
process.stdout.write(`workflow bundle: ${DEFAULT_BUNDLE_PATH} (${code.length} bytes)\n`)
