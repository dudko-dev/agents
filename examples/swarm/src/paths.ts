import { fileURLToPath } from 'node:url'

// The workflow source the bundler reads, and the bundle `build` writes (worker.ts prefers it).
export const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows.ts', import.meta.url))
export const DEFAULT_BUNDLE_PATH = fileURLToPath(
  new URL('../dist/workflow-bundle.js', import.meta.url),
)
