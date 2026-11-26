import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'

/**
 * Browser tests for the demo. They exist for the things unit tests structurally
 * cannot reach: effect ordering across a real render, a real navigation away
 * and back, IndexedDB persistence, and CORS on the servers the page talks to.
 *
 * The demo is served from its production build, so what is tested is what gets
 * deployed to Pages — including the code-split MCP chunk.
 */

// Some sandboxes ship a Chromium that predates this Playwright's pinned build.
// Use it when it is there rather than failing on a version mismatch; CI runs
// `playwright install chromium` and takes the normal path.
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium'
const executablePath = existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined

// The demo's port. One port for every checkout means two checkouts on one machine cannot run the
// suite at once (the second finds the port taken, or - outside CI - silently tests the first one's
// build): give each its own with E2E_PORT.
const PORT = Number(process.env.E2E_PORT) || 4173
const ORIGIN = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    // The subpath is deliberate: the demo is served from /demo/ (the site's root is the
    // documentation site), so testing the bare origin would exercise a layout that never ships.
    baseURL: `${ORIGIN}/demo/`,
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // `--host 127.0.0.1` is load-bearing, not decoration. Vite's default host
    // is `localhost`, which Node resolves through DNS — on a GitHub runner that
    // answers `::1` first, so the server listens on IPv6 while Playwright polls
    // the IPv4 address below and waits out the full timeout with a healthy
    // server running. Binding the same literal address both places removes the
    // resolver from the equation.
    command: `pnpm --filter demo run build && pnpm --filter demo run preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `${ORIGIN}/demo/`,
    reuseExistingServer: !process.env.CI,
    // Playwright ignores webServer stdout by default, which is why the first CI
    // failure showed a build log and then silence. Piping it means the next one
    // shows the server's own banner or its error.
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 180_000,
  },
})
