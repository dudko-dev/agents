import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentEvent, McpSkillConsentView } from '@dudko.dev/agent-web'
import {
  agentStateReducer,
  createInitialAgentState,
  defaultLabels,
  ToolApprovalPrompt,
  type AgentAction,
  type AgentUiState,
  type ApprovalView,
} from '../dist/index.js'
import { mcpSkillsSettingOf } from '../dist/mcp.js'

// An MCP server's skill about to enter the agent's context (the core's `tool.approval-requested`
// with `skill`): what the reducer keeps - the server's text only while the request is open - and
// the card, which says whose skill it is, shows its text as text, and answers through the same
// approve / deny as a tool call. e2e/mcp.spec.ts drives it in the demo against a real server.

const event = (state: AgentUiState, e: AgentEvent): AgentUiState =>
  agentStateReducer(state, { type: 'event', event: e } as AgentAction)
const L = defaultLabels

const BODY = '# PDF processing\n\nFill the form. <img src=x onerror=alert(1)> PDF-PROCESSING-BODY'
const view = (over: Partial<McpSkillConsentView> = {}): McpSkillConsentView => ({
  server: 'docs',
  name: 'docs/pdf-processing',
  skill: 'pdf-processing',
  uri: 'skill://pdf-processing/SKILL.md',
  description: 'Extract, fill and assemble PDF documents',
  size: 1234,
  totalSize: 1500,
  files: ['references/FORMS.md', 'scripts/extract.py'],
  fileCount: 2,
  body: BODY,
  consent: 'once-per-skill',
  ...over,
})
const requested = (skill: McpSkillConsentView, id = 'q1'): AgentEvent => ({
  type: 'tool.approval-requested',
  id,
  name: 'load_skill',
  input: { name: skill.name },
  readOnly: true,
  skill,
})

test('reducer: a skill request keeps the view while pending, drops the text once decided', () => {
  let s = event(createInitialAgentState(), { type: 'run.start', goal: 'fill it', runId: 'r1' })
  s = event(s, requested(view()))
  const pending = s.approvals[0]
  assert.equal(pending.status, 'pending')
  assert.equal(pending.name, 'load_skill')
  assert.equal(pending.skill?.name, 'docs/pdf-processing')
  assert.equal(pending.skill?.body, BODY)
  s = event(s, {
    type: 'tool.approval-resolved',
    id: 'q1',
    name: 'load_skill',
    approved: true,
    automatic: false,
  })
  const decided = s.approvals[0]
  assert.equal(decided.status, 'approved')
  assert.equal(decided.skill?.name, 'docs/pdf-processing', 'who and what are kept')
  assert.equal(decided.skill?.body, undefined, 'the server text is not')
  // Nor on the run's message (a saved conversation).
  const message = s.messages.find((m) => m.approvals?.length)
  assert.ok(message)
  assert.ok(!JSON.stringify(message).includes('PDF-PROCESSING-BODY'))
})

test('reducer: a stop denies a pending skill request and drops its text; a helper asking says so', () => {
  let s = event(createInitialAgentState(), { type: 'run.start', goal: 'go', runId: 'r1' })
  s = event(s, requested(view()))
  s = event(s, { type: 'stopped' })
  assert.equal(s.approvals[0].status, 'denied')
  assert.equal(s.approvals[0].skill?.body, undefined)
  // A helper the model started asks through the run's gate: lifted from its envelope.
  let h = event(createInitialAgentState(), { type: 'run.start', goal: 'go', runId: 'r2' })
  h = event(h, {
    type: 'subagent.event',
    id: 'sub-1',
    name: 'helper',
    event: { ...requested(view(), 'q2'), subagent: { id: 'sub-1', depth: 1 } } as AgentEvent,
  } as AgentEvent)
  assert.equal(h.approvals[0].skill?.body, BODY)
  assert.equal(h.approvals[0].subagent?.id, 'sub-1')
  h = event(h, {
    type: 'subagent.event',
    id: 'sub-1',
    name: 'helper',
    event: {
      type: 'tool.approval-resolved',
      id: 'q2',
      name: 'load_skill',
      approved: false,
      automatic: false,
    },
  } as AgentEvent)
  assert.equal(h.approvals[0].status, 'denied')
  assert.equal(h.approvals[0].skill?.body, undefined)
})

const card = (approvals: ApprovalView[], props: Record<string, unknown> = {}) => {
  const answers: unknown[] = []
  const markup = renderToStaticMarkup(
    createElement(ToolApprovalPrompt, {
      approvals,
      onApprove: (id: string, o?: { remember?: boolean }) => answers.push(['approve', id, o]),
      onDeny: (id: string, reason?: string) => answers.push(['deny', id, reason]),
      ...props,
    }),
  )
  return { markup, answers }
}
const pendingView = (over: Partial<McpSkillConsentView> = {}): ApprovalView => ({
  id: 'q1',
  name: 'load_skill',
  input: { name: 'docs/pdf-processing' },
  readOnly: true,
  status: 'pending',
  skill: view(over),
})

test('card: "The server … offers the skill …", its description, size, a collapsed preview, three answers', () => {
  const { markup } = card([pendingView()])
  assert.ok(markup.includes('awr-approval--skill'))
  assert.ok(markup.includes('data-skill="docs/pdf-processing"'))
  assert.ok(markup.includes(L.skillConsentLead('docs', 'pdf-processing')))
  assert.ok(markup.includes('Extract, fill and assemble PDF documents'))
  assert.ok(markup.includes(L.skillConsentSize(1234, 2)))
  assert.ok(markup.includes(L.skillConsentNote('docs', 'once-per-skill')))
  // The preview is collapsed: a <details> without `open`.
  assert.match(markup, /<details class="awr-approval__preview"><summary>/)
  assert.ok(!/<details[^>]* open/.test(markup))
  assert.ok(markup.includes(`>${L.skillConsentPreview}<`))
  for (const label of [L.skillConsentAllow, L.skillConsentAlways, L.skillConsentDeny]) {
    assert.ok(markup.includes(`>${label}<`), label)
  }
  // Not the tool card's words.
  assert.ok(!markup.includes(L.approvalLead))
  assert.ok(!markup.includes(`>${L.alwaysAllow}<`))
})

test('card: the server text is text - markup in it is escaped, never rendered', () => {
  const { markup } = card([
    pendingView({ description: '<b>bold</b> claim', skill: 'x<script>', server: 'd"s' }),
  ])
  assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.ok(!markup.includes('<img'))
  assert.ok(markup.includes('&lt;b&gt;bold&lt;/b&gt; claim'))
  assert.ok(!markup.includes('<script>'))
  // Inside a <pre>: line breaks kept, nothing interpreted.
  assert.match(
    markup,
    /<pre class="awr-approval__quote awr-approval__body"># PDF processing\n\nFill/,
  )
})

test('card: by URI and nested are said; the preview and "Always" can be hidden; a decided one has no preview', () => {
  const { markup } = card([pendingView({ byUri: true, nestedIn: 'docs/handbook', consent: 'ask' })])
  assert.ok(markup.includes(L.skillConsentByUri))
  assert.ok(markup.includes(L.skillConsentNested('docs/handbook')))
  assert.ok(markup.includes(L.skillConsentNote('docs', 'ask')))
  const hidden = card([pendingView()], { showSkillPreview: false, allowRemember: false }).markup
  assert.ok(!hidden.includes('awr-approval__preview'))
  assert.ok(!hidden.includes(`>${L.skillConsentAlways}<`))
  const noBody = card([{ ...pendingView(), skill: { ...view(), body: undefined } }]).markup
  assert.ok(!noBody.includes('awr-approval__preview'))
  // Relabelled, as every string.
  const es = card([pendingView()], {
    labels: { skillConsentLead: (s: string, k: string) => `«${s}» ofrece «${k}»` },
  }).markup
  assert.ok(es.includes('«docs» ofrece «pdf-processing»'))
})

test('card: a render prop gets the built-in skill card as fallback', () => {
  const markup = renderToStaticMarkup(
    createElement(ToolApprovalPrompt, {
      approvals: [pendingView()],
      onApprove: () => {},
      onDeny: () => {},
      renderApproval: (a: ApprovalView, fallback: unknown) =>
        createElement('section', { 'data-mine': a.skill?.name }, fallback as never),
    }),
  )
  assert.match(
    markup,
    /<section data-mine="docs\/pdf-processing"><div class="awr-approval awr-approval--skill/,
  )
})

test('hooks: a skills setting is true or { consent } with a known value; anything else is off', () => {
  assert.equal(mcpSkillsSettingOf(true), true)
  assert.equal(mcpSkillsSettingOf({}), true)
  assert.deepEqual(mcpSkillsSettingOf({ consent: 'never' }), { consent: 'never' })
  assert.deepEqual(mcpSkillsSettingOf({ consent: 'ask' }), { consent: 'ask' })
  assert.deepEqual(mcpSkillsSettingOf({ consent: 'once-per-skill' }), { consent: 'once-per-skill' })
  for (const off of [false, undefined, null, 'true', 1, [], { consent: 'always' }]) {
    assert.equal(mcpSkillsSettingOf(off), undefined, JSON.stringify(off))
  }
})

test('hooks: { dynamic: true } is kept (with or without a consent), false dropped, a non-boolean is off', () => {
  assert.deepEqual(mcpSkillsSettingOf({ dynamic: true }), { dynamic: true })
  assert.deepEqual(mcpSkillsSettingOf({ consent: 'never', dynamic: true }), {
    consent: 'never',
    dynamic: true,
  })
  assert.equal(mcpSkillsSettingOf({ dynamic: false }), true, 'on, no generated skills')
  assert.deepEqual(mcpSkillsSettingOf({ consent: 'ask', dynamic: false }), { consent: 'ask' })
  // From storage: anything else is dropped - never read as "on, with generated skills".
  for (const off of [
    { dynamic: 'yes' },
    { dynamic: 1 },
    { dynamic: null },
    { consent: 'x', dynamic: true },
  ]) {
    assert.equal(mcpSkillsSettingOf(off), undefined, JSON.stringify(off))
  }
})

test('card: a generated skill says there are no checksums and only the copy read is used; no listing is said', () => {
  const plain = card([pendingView()]).markup
  assert.ok(!plain.includes(L.skillConsentDynamic))
  assert.ok(!plain.includes('awr-approval__dynamic'))
  const generated = card([pendingView({ dynamic: true })]).markup
  assert.ok(
    generated.includes(
      `<p class="awr-approval__from awr-approval__dynamic">${L.skillConsentDynamic}</p>`,
    ),
    generated,
  )
  assert.equal(
    L.skillConsentDynamic,
    'This server publishes no checksums for this skill: you approve the copy the agent just read, and only that copy is used.',
  )
  // Before the preview and the answers: read first.
  assert.ok(generated.indexOf('awr-approval__dynamic') < generated.indexOf('awr-approval__preview'))
  assert.ok(!generated.includes(L.skillConsentNoFileListing), 'listed: not said')
  const alone = card([
    pendingView({ dynamic: true, noFileListing: true, files: [], fileCount: 0 }),
  ]).markup
  assert.ok(alone.includes(L.skillConsentNoFileListing))
  // Relabelled like every string.
  const es = card([pendingView({ dynamic: true })], {
    labels: { skillConsentDynamic: 'Sin sumas de control: apruebas esta copia.' },
  }).markup
  assert.ok(es.includes('Sin sumas de control: apruebas esta copia.'))
})

test('reducer: a generated skill keeps dynamic once decided - only the text is dropped', () => {
  let s = event(createInitialAgentState(), { type: 'run.start', goal: 'go', runId: 'r1' })
  s = event(s, requested(view({ dynamic: true, noFileListing: true })))
  assert.equal(s.approvals[0].skill?.dynamic, true)
  s = event(s, {
    type: 'tool.approval-resolved',
    id: 'q1',
    name: 'load_skill',
    approved: true,
    automatic: false,
  })
  assert.deepEqual(
    [
      s.approvals[0].skill?.dynamic,
      s.approvals[0].skill?.noFileListing,
      s.approvals[0].skill?.body,
    ],
    [true, true, undefined],
  )
})
