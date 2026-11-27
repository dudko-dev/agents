import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { VirtualFileSystem, type AgentEvent } from '@dudko.dev/agent-web'
import {
  agentStateReducer,
  buildSandboxedDocument,
  clampFrameHeight,
  createInitialAgentState,
  escapeAttribute,
  FileChip,
  FileChips,
  fileKindOf,
  fileNameOf,
  linkedFilesOf,
  MessageList,
  sandboxedCsp,
  SandboxedFrame,
  sandboxTokens,
  SourceView,
  tokenizeHtml,
  withCspFirst,
  type AgentAction,
  type AgentUiState,
  type ChatMessage,
  type WrittenFileView,
} from '../dist/index.js'

// Files the agent writes in a turn: the reducer (which files belong to the turn), the chips,
// and the sandboxed frame an HTML file is previewed in. The frame is a security boundary: every
// guard below has a test named "guard …", and e2e/files.spec.ts proves the same in a browser.

const event = (state: AgentUiState, e: AgentEvent): AgentUiState =>
  agentStateReducer(state, { type: 'event', event: e } as AgentAction)
const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node)

const step = { id: 'a', description: 'Write the report' }
const started = (): AgentUiState => {
  let s = event(createInitialAgentState(), { type: 'run.start', goal: 'write it' })
  s = event(s, { type: 'plan.created', plan: { thought: '', steps: [step] } })
  return event(s, { type: 'step.start', step, index: 1, total: 1 })
}
const wrote = (path: string, bytes: number, mediaType = 'text/markdown'): AgentEvent => ({
  type: 'file.written',
  path,
  mediaType,
  bytes,
  step,
})
const inSubagent = (id: string, name: string, inner: AgentEvent): AgentEvent => ({
  type: 'subagent.event',
  id,
  name,
  event: inner,
})

// ── the reducer: which files belong to a turn ────────────────────────────────

test('files: what the run wrote is on the turn, one entry per path, in the order first written', () => {
  let s = started()
  assert.equal(s.writtenFiles, undefined)
  s = event(s, wrote('/q3/report.md', 100))
  s = event(s, wrote('/q3/summary.csv', 40, 'text/csv'))
  // Written again: the same chip, the newest size, counted.
  s = event(s, wrote('/q3/report.md', 4200))
  assert.deepEqual(s.writtenFiles, [
    { path: '/q3/report.md', mediaType: 'text/markdown', bytes: 4200, writes: 2, stepId: 'a' },
    { path: '/q3/summary.csv', mediaType: 'text/csv', bytes: 40, writes: 1, stepId: 'a' },
  ])
  assert.deepEqual(s.messages[1].writtenFiles, s.writtenFiles, 'mirrored onto the assistant turn')
})

test('files: a file deleted later in the turn has no chip; written again, it is back', () => {
  let s = started()
  s = event(s, wrote('/tmp/scratch.txt', 5, 'text/plain'))
  s = event(s, wrote('/keep.md', 9))
  s = event(s, { type: 'file.deleted', path: '/tmp/scratch.txt', step })
  assert.deepEqual(
    s.messages[1].writtenFiles?.map((f) => f.path),
    ['/keep.md'],
  )
  // Deleting something the turn did not write changes nothing.
  const before = s
  s = event(s, { type: 'file.deleted', path: '/attachments/old.pdf', step })
  assert.equal(s.writtenFiles, before.writtenFiles)
  s = event(s, { type: 'file.deleted', path: '/keep.md' })
  assert.deepEqual(s.messages[1].writtenFiles, [], 'the last one deleted: no chips left')
  s = event(s, wrote('/keep.md', 3))
  assert.deepEqual(s.messages[1].writtenFiles, [
    { path: '/keep.md', mediaType: 'text/markdown', bytes: 3, writes: 1, stepId: 'a' },
  ])
})

test('files: a subagent’s files belong to the parent turn and say who wrote them', () => {
  let s = started()
  s = event(s, {
    type: 'subagent.start',
    id: 'H',
    name: 'spawn_subagent',
    task: 't',
    depth: 1,
    role: 'researcher',
  })
  const helperStep = { id: 'a', description: "the helper's own step a" }
  s = event(
    s,
    inSubagent('H', 'spawn_subagent', { ...wrote('/notes/found.md', 12), step: helperStep }),
  )
  // A helper of a helper: the envelope is nested, the innermost name wins.
  s = event(
    s,
    inSubagent('H', 'spawn_subagent', inSubagent('G', 'grandchild', wrote('/notes/deep.md', 7))),
  )
  assert.deepEqual(s.messages[1].writtenFiles, [
    {
      path: '/notes/found.md',
      mediaType: 'text/markdown',
      bytes: 12,
      writes: 1,
      by: { id: 'H', name: 'spawn_subagent', role: 'researcher' },
    },
    {
      path: '/notes/deep.md',
      mediaType: 'text/markdown',
      bytes: 7,
      writes: 1,
      by: { id: 'G', name: 'grandchild' },
    },
  ])
  assert.ok(!('stepId' in s.writtenFiles![0]), "a helper's step ids are its own")
  // The agent rewrites the helper's file: it is the agent's now.
  s = event(s, wrote('/notes/found.md', 20))
  assert.deepEqual(s.writtenFiles![0], {
    path: '/notes/found.md',
    mediaType: 'text/markdown',
    bytes: 20,
    writes: 2,
    stepId: 'a',
  })
  // A helper's delete takes the chip away too.
  s = event(s, inSubagent('H', 'spawn_subagent', { type: 'file.deleted', path: '/notes/deep.md' }))
  assert.deepEqual(
    s.writtenFiles?.map((f) => f.path),
    ['/notes/found.md'],
  )
})

test('files: each turn keeps its own; the next run starts with none', () => {
  let s = started()
  s = event(s, wrote('/one.md', 1))
  s = event(s, { type: 'final', text: 'done' })
  s = event(s, { type: 'run.start', goal: 'again' })
  assert.equal(s.writtenFiles, undefined)
  assert.equal(s.messages[1].writtenFiles?.length, 1)
  assert.equal(s.messages[3].writtenFiles, undefined)
})

// ── kinds ────────────────────────────────────────────────────────────────────

test('fileKindOf: by MIME type and extension; only the core’s image types are pictures', () => {
  assert.equal(fileKindOf('/a/index.html', 'text/html'), 'html')
  assert.equal(fileKindOf('/a/page.HTM', 'text/plain'), 'html')
  assert.equal(fileKindOf('/report.md', 'text/markdown'), 'markdown')
  assert.equal(fileKindOf('/data.csv', 'text/csv'), 'csv')
  assert.equal(fileKindOf('/data.json', 'application/json'), 'json')
  assert.equal(fileKindOf('/chart.png', 'image/png'), 'image')
  assert.equal(fileKindOf('/app.ts', 'text/typescript'), 'code')
  assert.equal(fileKindOf('/notes.txt', 'text/plain'), 'text')
  assert.equal(fileKindOf('/blob.bin', 'application/octet-stream'), 'file')
  assert.equal(fileKindOf('/doc.pdf', 'application/pdf'), 'file')
  // SVG can carry script: it is never a picture here, only its source.
  assert.equal(fileKindOf('/logo.svg', 'image/svg+xml'), 'code')
  // A name is not enough to be drawn as a picture: the type must be one of the core's.
  assert.equal(fileKindOf('/fake.png', 'text/html'), 'html')
  assert.equal(fileNameOf('/q3/report.md'), 'report.md')
})

// ── the sandboxed frame: every guard ────────────────────────────────────────

test('guard sandbox: the attribute is empty or allow-scripts - never same-origin, navigation, popups, forms', () => {
  assert.equal(sandboxTokens(false), '')
  assert.equal(sandboxTokens(), '')
  assert.equal(sandboxTokens(true), 'allow-scripts')
  for (const scripts of [false, true]) {
    const out = html(
      createElement(SandboxedFrame, { html: '<p>x</p>', scripts, title: 't', label: 'l' }),
    )
    const attr = /<iframe[^>]*\ssandbox="([^"]*)"/.exec(out)
    assert.ok(attr, 'the frame always has a sandbox attribute')
    assert.equal(attr[1], scripts ? 'allow-scripts' : '')
    assert.doesNotMatch(out, /allow-(same-origin|top-navigation|popups|forms|modals|downloads)/)
    // Never by URL: a blob: or data: URL of the page could be opened outside the sandbox.
    assert.doesNotMatch(out, /<iframe[^>]*\ssrc=/)
    assert.match(out, /<iframe[^>]*\ssrcDoc=|<iframe[^>]*\ssrcdoc=/i)
    assert.match(out, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i)
  }
})

test('guard csp: no network source anywhere; scripts only when asked', () => {
  for (const scripts of [false, true]) {
    const csp = sandboxedCsp(scripts)
    const directives = Object.fromEntries(
      csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]),
    )
    assert.equal(directives['default-src'], "'none'")
    assert.equal(directives['script-src'], scripts ? "'unsafe-inline'" : "'none'")
    assert.equal(directives['style-src'], "'unsafe-inline'")
    assert.equal(directives['img-src'], 'data: blob:')
    assert.equal(directives['font-src'], 'data:')
    assert.equal(directives['connect-src'], "'none'")
    assert.equal(directives['form-action'], "'none'")
    assert.equal(directives['base-uri'], "'none'")
    assert.equal(directives['object-src'], "'none'")
    // No host, no scheme that reaches a network, no wildcard, no eval.
    assert.doesNotMatch(csp, /https?:|wss?:|\*|'self'|unsafe-eval/)
  }
})

test('guard navigation: the policy says frame-src none, in the shell and in the document', () => {
  for (const scripts of [false, true]) {
    assert.match(sandboxedCsp(scripts), /(^|; )frame-src 'none'(;|$)/)
    assert.match(sandboxedCsp(scripts), /(^|; )child-src 'none'(;|$)/)
    const shell = buildSandboxedDocument('<p>x</p>', { scripts })
    const policies = shell.match(/http-equiv=(?:"|&quot;)Content-Security-Policy/g) ?? []
    assert.equal(policies.length, 2, 'one for the shell, one inside the document')
  }
})

test('guard shell: the document is framed inside a document of ours, whose policy comes first', () => {
  const shell = buildSandboxedDocument('<p>hello</p>', { scripts: true })
  // Our policy is the first thing in the shell's head: nothing precedes it.
  assert.match(
    shell,
    /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; /,
  )
  // Exactly one inner frame, sandboxed like the outer one, by srcdoc.
  const frames = shell.match(/<iframe /g) ?? []
  assert.equal(frames.length, 1)
  assert.match(shell, /<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="/)
  assert.match(
    buildSandboxedDocument('x'),
    /<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="/,
  )
  assert.doesNotMatch(shell, /allow-same-origin/)
  // The shell itself runs nothing and loads nothing.
  assert.doesNotMatch(shell.slice(0, shell.indexOf('<iframe')), /<script|src=|href=/)
})

test('guard escaping: a document cannot close its attribute and write into the shell', () => {
  const attack =
    '"></iframe><script>parent.postMessage(1,"*")</script><iframe src="https://evil.example/">&quot;<b>'
  assert.equal(escapeAttribute('a"b&c<d>e'), 'a&quot;b&amp;c&lt;d&gt;e')
  const shell = buildSandboxedDocument(attack, { scripts: true })
  const start = shell.indexOf('srcdoc="') + 'srcdoc="'.length
  const end = shell.indexOf('"', start)
  const value = shell.slice(start, end)
  // The attribute value holds the whole document; what follows it is only our closing markup.
  assert.equal(shell.slice(end), '"></iframe></body></html>')
  assert.doesNotMatch(value, /["<>]/)
  // Decoded as a browser decodes an attribute, it is the document again, policy first.
  const decoded = value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  assert.equal(decoded, withCspFirst(attack, true))
})

test('guard csp first: our policy precedes everything the document says, and keeps a doctype', () => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${sandboxedCsp(false)}">`
  // After a leading doctype (standards mode is kept), before anything else.
  assert.equal(
    withCspFirst('<!DOCTYPE html>\n<html><head><title>x</title>'),
    `<!DOCTYPE html>${meta}\n<html><head><title>x</title>`,
  )
  assert.equal(withCspFirst('\uFEFF \n<!doctype html><p>'), `\uFEFF \n<!doctype html>${meta}<p>`)
  // A document that tries to get in first: its own policy, a base, a script before <html>.
  const attacks = [
    '<meta http-equiv="Content-Security-Policy" content="default-src *"><html>',
    '<base href="https://evil.example/"><!doctype html><html>',
    '<script>fetch("https://evil.example")</script><html>',
    '<!-- x --><!doctype html><meta http-equiv="Content-Security-Policy" content="default-src *">',
    'text first <!doctype html>',
    '<html><head><meta http-equiv="Content-Security-Policy" content="script-src *"></head>',
    // A doctype that pretends to go on: the tokenizer ends it at the first ">".
    '<!doctype html "><meta http-equiv=Content-Security-Policy content=\'default-src *\'>">',
  ]
  for (const doc of attacks) {
    const out = withCspFirst(doc)
    const at = out.indexOf(meta)
    assert.ok(at >= 0, doc)
    const before = out.slice(0, at)
    assert.match(before, /^(|<!doctype html ">)$/, `nothing of the document precedes ours: ${doc}`)
    assert.equal(before + out.slice(at + meta.length), doc, 'the document itself is unchanged')
  }
  assert.match(withCspFirst('<p>', true), /script-src 'unsafe-inline'/)
})

test('guard height: the frame’s size is the host’s number, clamped', () => {
  assert.equal(clampFrameHeight(300), 300)
  assert.equal(clampFrameHeight(5), 120)
  assert.equal(clampFrameHeight(100_000), 800)
  assert.equal(clampFrameHeight(Number.NaN), 300)
  assert.equal(clampFrameHeight(Number.POSITIVE_INFINITY), 300)
  const out = html(
    createElement(SandboxedFrame, { html: 'x', title: 't', label: 'l', height: 99_999 }),
  )
  assert.match(out, /style="height:800px"/)
  // The component listens to nothing the content could say.
  const source = readFileSync(
    new URL('../src/components/SandboxedFrame.tsx', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(source, /addEventListener|onMessage|postMessage\(/)
})

test('guard chrome: the label, the switch and the footer are the host’s, outside the frame', () => {
  const out = html(
    createElement(SandboxedFrame, {
      html: '<button class="awr-frame__btn">Approve</button>',
      title: 'Preview of /x.html',
      label: 'HTML written by the agent',
      actions: createElement('button', { type: 'button' }, 'Source'),
      footer: 'x.html',
    }),
  )
  const frameAt = out.indexOf('<iframe')
  assert.ok(out.indexOf('HTML written by the agent') < frameAt)
  assert.ok(out.indexOf('>Source<') < frameAt)
  assert.ok(out.indexOf('awr-frame__foot') > frameAt)
  // The document exists only as an attribute value: none of its markup is the host's markup.
  assert.equal(out.match(/<button/g)?.length, 1)
  assert.match(out, /title="Preview of \/x\.html"/)
})

test('guard source: a file’s text is rendered as text, never as markup', () => {
  const evil = '<img src=x onerror="alert(1)">\n<script>alert(2)</script>\n<!-- c -->'
  const out = html(createElement(SourceView, { text: evil, html: true }))
  assert.doesNotMatch(out, /<img|<script|onerror="alert/)
  assert.match(out, /&lt;img/)
  assert.match(out, /&lt;script/)
  // Plain files too.
  assert.doesNotMatch(html(createElement(SourceView, { text: evil })), /<img|<script/)
  // And no source of this package sets markup from a string.
  for (const file of ['FileChips.tsx', 'SandboxedFrame.tsx']) {
    const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|document\.write/)
  }
})

test('SourceView: line numbers, colours for HTML, and a cut that says so', () => {
  const out = html(createElement(SourceView, { text: '<p class="a">hi</p>\nsecond', html: true }))
  assert.equal(out.match(/awr-source__line/g)?.length, 2)
  assert.match(out, /<span class="awr-source__tag">&lt;p<\/span>/)
  assert.match(out, /<span class="awr-source__attr">class<\/span>/)
  assert.match(out, /<span class="awr-source__string">&quot;a&quot;<\/span>/)
  const cut = html(createElement(SourceView, { text: 'x'.repeat(50), maxChars: 10 }))
  assert.match(cut, />x{10}\n</)
  assert.match(cut, /Only the first 10 characters are shown/)
  assert.doesNotMatch(html(createElement(SourceView, { text: 'short' })), /Only the first/)
})

test('tokenizeHtml: lossless on anything, and script / style content is not coloured as markup', () => {
  const samples = [
    '<!doctype html><html lang="en"><head><style>a > b { color: red }</style></head>',
    '<script>if (a < b && c > d) { x = "<p>" }</script><p data-x=1 hidden>t</p>',
    '<!-- never closed',
    '<a href="unterminated',
    '< not a tag > & <3',
    '',
    "<p\nclass = 'x'\n/>",
  ]
  for (const s of samples) {
    assert.equal(
      tokenizeHtml(s)
        .map((t) => t.text)
        .join(''),
      s,
    )
  }
  const script = tokenizeHtml('<script>if (a < b) "<p>"</script>')
  assert.deepEqual(
    script.find((t) => t.text.includes('a < b')),
    { kind: 'text', text: 'if (a < b) "<p>"' },
  )
  assert.equal(tokenizeHtml('<!-- c -->')[0].kind, 'comment')
})

test('linkedFilesOf: relative references only, capped', () => {
  assert.deepEqual(
    linkedFilesOf(
      '<link href="style.css"><script src=./app.js></script><img src=\'img/a.png\'>' +
        '<a href="https://example.com">x</a><a href="#top">t</a><img src="data:image/png;base64,AA">' +
        '<a href="//cdn.example/x.js">c</a><a href="mailto:a@b.c">m</a><link href="style.css">',
    ),
    ['style.css', './app.js', 'img/a.png'],
  )
  assert.equal(linkedFilesOf('<a href=a><a href=b><a href=c><a href=d><a href=e>', 2).length, 2)
})

// ── chips ────────────────────────────────────────────────────────────────────

const report: WrittenFileView = {
  path: '/q3/report.md',
  mediaType: 'text/markdown',
  bytes: 4301,
  writes: 1,
}
const page: WrittenFileView = {
  path: '/site/index.html',
  mediaType: 'text/html',
  bytes: 3174,
  writes: 1,
  by: { id: 'H', name: 'designer' },
}

test('FileChip: name, kind, size, who wrote it; actions only with a workspace', () => {
  const vfs = new VirtualFileSystem({ memory: true })
  const bare = html(createElement(FileChip, { written: report }))
  assert.match(bare, /class="awr-filechip__name">report\.md</)
  assert.match(bare, /class="awr-filechip__meta">Markdown · 4\.2 KB</)
  assert.match(bare, /title="\/q3\/report\.md"/)
  assert.doesNotMatch(bare, /<button/)

  const full = html(createElement(FileChip, { written: page, files: vfs, onToggle: () => {} }))
  assert.match(full, /HTML · 3\.1 KB · by designer/)
  assert.match(full, /aria-label="Open index\.html"/)
  assert.match(full, /aria-expanded="false"/)
  assert.match(full, /aria-label="Download index\.html"/)
  const open = html(
    createElement(FileChip, { written: page, files: vfs, open: true, onToggle: () => {} }),
  )
  assert.match(open, /awr-filechip is-open/)
  assert.match(open, /aria-label="Close preview of index\.html"/)
  const gone = html(createElement(FileChip, { written: page, gone: true }))
  assert.match(gone, /is-gone/)
  assert.match(gone, /no longer in the workspace/)
})

test('FileChips: a header with the count, one chip per file; hidden, relabelled or replaced', () => {
  const out = html(createElement(FileChips, { written: [report, page], onShowFiles: () => {} }))
  assert.match(out, /2 files written in this turn/)
  assert.match(out, /Show in Files/)
  assert.equal(out.match(/class="awr-filechip"/g)?.length, 2)
  assert.equal(html(createElement(FileChips, { written: [] })), '')
  assert.doesNotMatch(
    html(createElement(FileChips, { written: [report], showHeader: false })),
    /written in this turn/,
  )
  assert.doesNotMatch(html(createElement(FileChips, { written: [report] })), /Show in Files/)
  const custom = html(
    createElement(FileChips, {
      written: [report],
      labels: {
        filesWritten: (n) => `файлов: ${n}`,
        fileKinds: { markdown: 'Маркдаун' },
      },
      renderFile: (f, fallback) => createElement('div', { 'data-mine': f.path }, fallback),
    }),
  )
  assert.match(custom, /файлов: 1/)
  assert.match(custom, /Маркдаун · 4\.2 KB/)
  assert.match(custom, /data-mine="\/q3\/report\.md"/)
})

test('MessageList: an answer’s files show under it and in the activity summary; showFileChips hides both', () => {
  const messages: ChatMessage[] = [
    { id: 'u', role: 'user', content: 'write', pending: false },
    {
      id: 'a',
      role: 'assistant',
      content: 'Done.',
      pending: false,
      steps: [
        {
          id: 's',
          index: 1,
          total: 1,
          step: { id: 's', description: 'Write' },
          text: '',
          reasoning: '',
          toolCalls: [],
          status: 'done',
          blocked: false,
        },
      ],
      writtenFiles: [report, page],
    },
  ]
  const out = html(createElement(MessageList, { messages }))
  assert.match(out, /1 step · 0 tool calls · 2 files/)
  assert.ok(out.indexOf('awr-msg__files') > out.indexOf('awr-msg__bubble'), 'under the answer')
  assert.equal(out.match(/class="awr-filechip"/g)?.length, 2)
  const hidden = html(createElement(MessageList, { messages, showFileChips: false }))
  assert.doesNotMatch(hidden, /awr-filechip|2 files/)
  const replaced = html(
    createElement(MessageList, {
      messages,
      renderFile: (f, m) => createElement('i', null, `${m.id}:${f.path}`),
    }),
  )
  assert.match(replaced, /<i>a:\/q3\/report\.md<\/i>/)
})
