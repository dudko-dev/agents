// The documentation pages are generated from the Markdown that ships with the packages (their
// READMEs and docs/), so there is one text to maintain and the site cannot drift from npm.
// Output: src/content/docs/docs/<section>/*.md (git-ignored). Run by `dev`, `build`, `typecheck`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const out = resolve(here, '../src/content/docs/docs')
const GITHUB = 'https://github.com/dudko-dev/agents'

/** source file (repo-relative) -> page. `route` is the URL under /docs/. */
export const PAGES = [
  [
    'packages/agent/README.md',
    'node/index',
    'Node agent',
    'A tool-using planning agent for Node: plan, execute, replan and synthesize over MCP servers, with a REPL CLI, persistence and OpenTelemetry.',
  ],
  [
    'packages/agent-web/README.md',
    'browser/index',
    'Browser agent',
    'The same planning loop running fully in the browser: bring-your-own-key cloud providers or local WebGPU models, an encrypted key vault and HTTP MCP.',
  ],
  [
    'packages/agent-web/docs/capabilities.md',
    'browser/capabilities',
    'Capabilities',
    'Thinking, token limits, compaction, prompt caching, skills, tool consent, large MCP catalogues, subagents, steering, learning, egress and the event reference.',
  ],
  [
    'packages/agent-web/docs/providers.md',
    'browser/providers',
    'Providers',
    'Every model provider the browser agent supports, which ones allow direct calls from a page, and when to use a proxy.',
  ],
  [
    'packages/agent-web/docs/security.md',
    'browser/security',
    'Security',
    'The threat model of the browser key vault, of the web_fetch egress tool and of the learning notebook: what is protected and what is not.',
  ],
  [
    'packages/agent-web/docs/design.md',
    'browser/design',
    'Design',
    'The architecture of the browser agent and the reasoning behind each decision.',
  ],
  [
    'packages/agent-web-react/README.md',
    'react/index',
    'React bindings',
    'The useAgent hook, a context provider and a drop-in chat for the browser agent.',
  ],
  [
    'packages/agent-web-react/docs/chat.md',
    'react/chat',
    'Chat components',
    'The AgentChat panel and its parts: transcript, composer, steering, the notebook, attachments, saved chats, the workspace and every label.',
  ],
  [
    'packages/agent-web-react/docs/pipeline.md',
    'react/pipeline',
    'Pipeline editor',
    'A canvas editor for graphs of agents: the PipelineEditor component, the usePipeline hook and its pure reducer, the canvas, the editing helpers and every label.',
  ],
].map(([source, route, title, description]) => ({ source, route, title, description }))

const routeOf = new Map(
  PAGES.map((p) => [p.source, `/docs/${p.route.replace(/\/?index$/, '')}/`.replace(/\/+$/, '/')]),
)

/** Rewrite one Markdown link target that appears in `source`. */
export const rewriteLink = (target, source) => {
  // An absolute GitHub link to a file that is a page here (the React docs point at the core's
  // docs that way, for npm readers) becomes a link within the site.
  const own = /^https:\/\/github\.com\/dudko-dev\/agents\/blob\/main\/([^#]+)(#.*)?$/.exec(target)
  if (own && routeOf.has(own[1])) return routeOf.get(own[1]) + (own[2] ?? '')
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return target // absolute, mailto:, in-page
  const [path, hash = ''] = target.split('#')
  const resolved = posix.normalize(posix.join(posix.dirname(source), path))
  const anchor = hash ? `#${hash}` : ''
  if (routeOf.has(resolved)) return routeOf.get(resolved) + anchor
  if (resolved.startsWith('..')) return target
  // Anything else in the repository (source files, examples, LICENSE): link to GitHub.
  const kind = /\.[a-z0-9]+$/i.test(resolved) ? 'blob' : 'tree'
  return `${GITHUB}/${kind}/main/${resolved}${anchor}`
}

/** README/docs Markdown -> a Starlight page body. */
export const transform = (markdown, source) => {
  const lines = markdown.split('\n')
  const body = []
  let inFence = false
  let droppedTitle = false
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence) {
      if (!droppedTitle && /^# /.test(line)) {
        droppedTitle = true // the page title comes from the frontmatter
        continue
      }
      // A file with a second top-level heading: the page has one h1, the rest are sections.
      if (/^# /.test(line)) {
        body.push(`#${line}`)
        continue
      }
      // Badge rows and the "site · demo · source" line are for npm and GitHub, not for the site.
      if (/img\.shields\.io|badge\.svg/.test(line)) continue
      if (/^\*\*\[agent\.dudko\.dev\]/.test(line)) continue
    }
    body.push(line)
  }
  let text = body.join('\n')
  // Links and images outside code fences. Inline code is left alone by matching `](`.
  const parts = text.split(/(^(?:```|~~~)[\s\S]*?^(?:```|~~~).*$)/m)
  text = parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(
            /(!?\[[^\]]*\]\()([^)\s]+)(\s+"[^"]*")?\)/g,
            (_m, open, target, title = '') => `${open}${rewriteLink(target, source)}${title})`,
          ),
    )
    .join('')
  return text.replace(/^\n+/, '')
}

const frontmatter = (p) =>
  `---\ntitle: ${JSON.stringify(p.title)}\ndescription: ${JSON.stringify(p.description)}\neditUrl: ${JSON.stringify(`${GITHUB}/edit/main/${p.source}`)}\n---\n\n`

const main = () => {
  // Only the generated sections: docs/index.md (the overview) is written by hand and lives here too.
  for (const section of new Set(PAGES.map((p) => p.route.split('/')[0]))) {
    rmSync(join(out, section), { recursive: true, force: true })
  }
  for (const page of PAGES) {
    const file = join(out, `${page.route}.md`)
    mkdirSync(dirname(file), { recursive: true })
    const source = readFileSync(join(repo, page.source), 'utf8')
    writeFileSync(file, frontmatter(page) + transform(source, page.source))
  }
  console.log(`synced ${PAGES.length} documentation pages into ${relative(repo, out)}`)
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) main()
