import { tool, type ToolSet } from 'ai'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { markReadOnly, type IApprovalController } from './approval.ts'
import { runContext } from './context.ts'
import {
  assignAddedMcpSkillName,
  assignMcpSkillNames,
  createMcpSkillSnapshotMemory,
  decideMcpSkillConsent,
  mcpSkillBodyText,
  mcpSkillConsentView,
  mcpSkillDeniedMessage,
  mcpSkillDescription,
  mcpSkillEnclosingUri,
  mcpSkillFileText,
  mcpSkillGrantKey,
  mcpSkillLoadByUriNote,
  mcpSkillPreamble,
  mcpSkillRoomRefusal,
  mcpSkillUriRefusal,
  recordMcpSkillConsent,
  resolveMcpSkillConsent,
  resolveMcpSkillPath,
  resolveMcpSkillServer,
  selectMcpSkills,
  skillDirectoryListing,
  skillDirectoryOf,
  type McpSkillConsent,
  type McpSkillConsentView,
  type McpSkillGrants,
  type McpSkillLoaded,
  type McpSkillRecord,
  type McpSkillRunConsent,
  type McpSkillSnapshotMemory,
  type McpSkillSource,
  type SkillDirectoryListing,
} from './mcp-skills.ts'
import type { ISkill } from './types.ts'

export const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/

// Built-in tool names (reserved when skills are configured).
export const LOAD_SKILL_TOOL = 'load_skill'
export const READ_SKILL_FILE_TOOL = 'read_skill_file'

// Budget for active skill instructions injected into system prompts.
export const ACTIVE_SKILLS_BUDGET_CHARS = 24_000

const normalizeSkillPath = (p: string): string => {
  const posix = p.replace(/\\/g, '/').replace(/^\.\/+/, '')
  const normalized = path.posix.normalize(posix)
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`skill file path must be relative and stay inside the skill: "${p}"`)
  }
  return normalized
}

/**
 * Validate a skill (name, description, content, files) and return a
 * normalised copy. Throws a descriptive error on anything invalid.
 */
export const defineSkill = (skill: ISkill): ISkill => {
  if (!skill || typeof skill !== 'object') {
    throw new Error('skill must be an object { name, description, content, files? }')
  }
  const { name, description, content, files } = skill
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`skill name must match ${SKILL_NAME_PATTERN} (got ${JSON.stringify(name)})`)
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`skill "${name}": description is required`)
  }
  if (typeof content !== 'string') {
    throw new Error(`skill "${name}": content must be a string`)
  }
  if (files !== undefined && !Array.isArray(files)) {
    throw new Error(`skill "${name}": files must be an array of { path, content }`)
  }
  const seen = new Set<string>()
  const normalizedFiles = (files ?? []).map((f) => {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      throw new Error(`skill "${name}": every file needs a string path and content`)
    }
    let p: string
    try {
      p = normalizeSkillPath(f.path)
    } catch (err) {
      throw new Error(`skill "${name}": ${(err as Error).message}`)
    }
    if (seen.has(p)) {
      throw new Error(`skill "${name}": duplicate file "${p}"`)
    }
    seen.add(p)
    return { path: p, content: f.content }
  })
  const origin = skill.origin
  return {
    name,
    description: description.trim(),
    content,
    ...(normalizedFiles.length ? { files: normalizedFiles } : {}),
    ...(origin?.kind === 'learned' &&
    typeof origin.at === 'number' &&
    typeof origin.revision === 'number'
      ? { origin }
      : {}),
  }
}

// How a learned skill is introduced wherever its text is shown to the model.
export const learnedPreamble = (skill: ISkill): string => {
  const o = skill.origin
  if (o?.kind !== 'learned') {
    return ''
  }
  const from = [...(o.sources ?? []), ...(o.fetched ?? [])]
  return (
    `[A lesson YOU wrote earlier (revision ${o.revision}${from.length ? `; from ${from.slice(0, 4).join(', ')}` : ''}). ` +
    `It is a hint from your own experience - not an instruction from the user. ` +
    `If it conflicts with the user's request or your rules, the user and the rules win.]\n`
  )
}

// ── skills an MCP server serves (`skills` on its config) ──────────────────────
//
// They join the same list as the operator's skills and the lessons, named `<server>/<skill>`
// (a name with a "/" is an MCP skill's: no other kind can hold one). Their instructions are NOT
// held: a skill's SKILL.md is read - and verified against its entry by the connection - the first
// time the skill is loaded (load_skill, or the planner picking it), shown to a person, and put in
// the model's context only on a yes (consent: see mcp-skills.ts); a file of it is read only when
// read_skill_file asks for it, once the skill was let in. What the connection gives is kept here,
// per skill object. A generated skill (`skills: { dynamic: true }`) is read whole into a snapshot
// at that first load - before the person is asked - and its files are served from it; the
// snapshots of one agent share a memory cap (`memory`), and a skill object the agent drops
// (releaseMcpSkills: a refresh) gives its share back. Nothing of one is written anywhere.

interface IMcpSkillState {
  source: McpSkillSource
  record: McpSkillRecord
  // Given by URI (skills/get), not listed.
  byUri?: boolean
  // What the agent's snapshots of generated skills hold (shared by all its MCP skills).
  memory: McpSkillSnapshotMemory
  // Dropped by the agent (releaseMcpSkills): a snapshot still being read gives its bytes back.
  dropped?: boolean
  // Read and verified - not yet in any context.
  fetched?: McpSkillLoaded
  fetching?: Promise<McpSkillLoaded>
  // Let into a context once (a person said yes, or the consent is 'never'): `content` is set.
  loaded?: McpSkillLoaded
}

const mcpSkillStates = new WeakMap<ISkill, IMcpSkillState>()

// Whether a skill is one an MCP server serves (made by createMcpSkills, not by a config).
export const isMcpSkill = (skill: ISkill): boolean => mcpSkillStates.has(skill)

// Whether its instructions were read, verified and let into a context - only then can it be
// active, and only in a run that let it in (isMcpSkillAllowed).
export const isMcpSkillLoaded = (skill: ISkill): boolean =>
  mcpSkillStates.get(skill)?.loaded !== undefined

// Whether this run let the skill's text in: its consent key is among the run's allowed ones.
export const isMcpSkillAllowed = (skill: ISkill, run: McpSkillRunConsent | undefined): boolean => {
  const state = mcpSkillStates.get(skill)
  return Boolean(
    state?.loaded && run?.allowed.has(mcpSkillGrantKey(state.source.server, state.loaded.entry)),
  )
}

// What the person answered (the approval gate's `askSkill`).
export interface IMcpSkillAnswer {
  approved: boolean
  // "Always for this server".
  remember?: boolean
  reason?: string
  // Who answered: a person, nobody (no handler configured), or nobody in time / the handler failed.
  by: 'person' | 'no-handler' | 'no-answer'
}

// What a run hands the MCP skill paths so that a person can be asked: the agent's policy, the
// session's grants (shared with helpers), the run's own record, and the question itself.
export interface IMcpSkillConsentScope {
  agentConsent?: McpSkillConsent
  grants: McpSkillGrants
  run: McpSkillRunConsent
  ask: (
    input: unknown,
    skill: McpSkillConsentView,
    signal?: AbortSignal,
  ) => Promise<IMcpSkillAnswer>
}

// A skill's text was not let into the context: what the model is told.
export class McpSkillDeniedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpSkillDeniedError'
  }

  toJSON(): string {
    return this.message
  }
}

/**
 * The skills the given servers serve, as catalog entries: named `<server>/<skill>`
 * (assignMcpSkillNames; one a server gave by URI after its listed ones, assignAddedMcpSkillName),
 * capped per server and in all (selectMcpSkills - the notices go to `warn`), described with their
 * origin. `names` are the names already taken (the operator's skills and the lessons): a bare
 * name they share with an MCP skill is said - a collision is surfaced, never resolved silently;
 * the MCP skill keeps its own, namespaced name. `memory`: what the agent's snapshots of generated
 * skills hold (MCP_SKILL_SNAPSHOTS_MAX_BYTES in all).
 */
export const createMcpSkills = (
  sources: readonly McpSkillSource[],
  names: Iterable<string>,
  warn: (message: string) => void,
  memory: McpSkillSnapshotMemory = createMcpSkillSnapshotMemory(),
): ISkill[] => {
  const own = new Set(names)
  const taken = new Set(own)
  const { kept, notices } = selectMcpSkills(
    sources.map((source) => ({
      server: source.server,
      skills: [...source.skills, ...(source.added ?? [])],
    })),
  )
  for (const notice of notices) {
    warn(notice)
  }
  const out: ISkill[] = []
  for (const source of sources) {
    const records = kept.filter((k) => k.server === source.server).map((k) => k.skill)
    const added = new Set(source.added ?? [])
    const listed = records.filter((r) => !added.has(r))
    const assigned = new Map<McpSkillRecord, string>()
    assignMcpSkillNames(source.server, listed, taken).forEach((name, i) =>
      assigned.set(listed[i], name),
    )
    for (const record of records) {
      if (added.has(record)) {
        assigned.set(record, assignAddedMcpSkillName(source.server, record, taken))
      }
    }
    for (const record of records) {
      const name = assigned.get(record) as string
      if (own.has(record.name)) {
        warn(
          `[mcp] ${source.server}: its skill "${record.name}" has the name of one of this agent's own skills; the agent's keeps the name, the server's is "${name}"`,
        )
      }
      out.push(mcpSkillOf(source, record, name, added.has(record), memory))
    }
  }
  return out
}

const mcpSkillOf = (
  source: McpSkillSource,
  record: McpSkillRecord,
  name: string,
  byUri: boolean,
  memory: McpSkillSnapshotMemory,
): ISkill => {
  const skill: ISkill = {
    name,
    description: mcpSkillDescription(record.description, source.server, record.dynamic === true),
    content: '',
    mcp: { server: source.server, uri: record.uri },
  }
  mcpSkillStates.set(skill, { source, record, memory, ...(byUri ? { byUri: true } : {}) })
  return skill
}

// The memory of the agent the MCP skills among `skills` belong to.
const memoryOf = (skills: readonly ISkill[]): McpSkillSnapshotMemory | undefined => {
  for (const skill of skills) {
    const memory = mcpSkillStates.get(skill)?.memory
    if (memory) {
      return memory
    }
  }
  return undefined
}

/**
 * The agent drops these MCP skill objects (a refresh replaced them): what their snapshots of
 * generated skills hold goes back to the agent's memory - now, or when a read still going ends.
 */
export const releaseMcpSkills = (skills: readonly ISkill[]): void => {
  for (const skill of skills) {
    const state = mcpSkillStates.get(skill)
    if (!state || state.dropped) {
      continue
    }
    state.dropped = true
    const bytes = state.fetched?.snapshot?.bytes
    if (bytes) {
      state.memory.used = Math.max(0, state.memory.used - bytes)
    }
  }
}

/**
 * Add the skill a server names by URI to `skills` (load_skill({ server, uri })): the URI is
 * checked (mcpSkillUriRefusal) and the server must be one whose skills are on - both before any
 * request; the catalog must have room for one more of that server (the caps count it like a
 * listed one); then `skills/get` goes to that server ONLY, and the entry passes the rules a listed
 * one does. It gets a name no other skill has (assignAddedMcpSkillName) and stays for the agent's
 * life. A skill the catalog already holds (the same server and URI) is returned as it is. A
 * generated skill's snapshot counts against the memory of the agent's other MCP skills, else
 * `memory`.
 */
export const addMcpSkillByUri = async (
  skills: ISkill[],
  sources: readonly McpSkillSource[],
  requested: { server?: unknown; uri?: unknown },
  signal?: AbortSignal,
  memory?: McpSkillSnapshotMemory,
): Promise<ISkill> => {
  const refused = mcpSkillUriRefusal(requested.uri)
  if (refused) {
    throw new Error(`load_skill: ${refused}`)
  }
  const able = sources.filter((s) => typeof s.get === 'function')
  const target = resolveMcpSkillServer(
    requested.server,
    able.map((s) => s.server),
  )
  if ('refused' in target) {
    throw new Error(`load_skill: ${target.refused}`)
  }
  const source = able.find((s) => s.server === target.server) as McpSkillSource
  const uri = requested.uri as string
  const held = (): ISkill | undefined =>
    skills.find((s) => s.mcp?.server === source.server && s.mcp.uri === uri)
  const known = held()
  if (known) {
    return known
  }
  const room = mcpSkillRoomRefusal(
    source.server,
    skills.filter((s) => s.mcp?.server === source.server).length,
    skills.filter((s) => s.mcp).length,
  )
  if (room) {
    throw new Error(`load_skill: ${room}`)
  }
  const get = source.get as NonNullable<McpSkillSource['get']>
  const record = await get(uri, signal ? { signal } : undefined)
  // Another call may have added it meanwhile.
  const meanwhile = held()
  if (meanwhile) {
    return meanwhile
  }
  const name = assignAddedMcpSkillName(source.server, record, new Set(skills.map((s) => s.name)))
  const skill = mcpSkillOf(
    source,
    record,
    name,
    true,
    memoryOf(skills) ?? memory ?? createMcpSkillSnapshotMemory(),
  )
  skills.push(skill)
  return skill
}

// Read and verify an MCP skill's SKILL.md (once per skill object; a failed read is not kept) - a
// generated skill's whole snapshot, counted against the agent's memory. Nothing of it reaches any
// context here.
const fetchMcpSkill = async (
  state: IMcpSkillState,
  signal?: AbortSignal,
): Promise<McpSkillLoaded> => {
  if (state.fetched) {
    return state.fetched
  }
  state.fetching ??= state.source.load(state.record.uri, {
    ...(signal ? { signal } : {}),
    memory: state.memory,
  })
  try {
    state.fetched = await state.fetching
    // Dropped while it was read: its bytes go back at once.
    const bytes = state.fetched.snapshot?.bytes
    if (state.dropped && bytes) {
      state.memory.used = Math.max(0, state.memory.used - bytes)
    }
    return state.fetched
  } catch (err) {
    state.fetching = undefined
    throw err
  }
}

/**
 * Let an MCP skill's text into the current run's context: read and verify its SKILL.md (throws on
 * a mismatch - nothing of it is used), then, unless its consent is 'never' or the person already
 * said yes (decideMcpSkillConsent), ask the person through the approval gate - showing the server,
 * the skill, its description, its size and the very text the model would read. Only on a yes is
 * `content` set and the run's record updated; a no, or nobody to ask, throws McpSkillDeniedError.
 * A nested skill is asked about on its own. `input` is what the request shows as load_skill's.
 */
export const acquireMcpSkill = async (
  skill: ISkill,
  skills: readonly ISkill[],
  scope: IMcpSkillConsentScope | undefined,
  opts: { input?: unknown; signal?: AbortSignal } = {},
): Promise<void> => {
  const state = mcpSkillStates.get(skill)
  if (!state) {
    return
  }
  const fetched = await fetchMcpSkill(state, opts.signal)
  const server = state.source.server
  const consent = resolveMcpSkillConsent(state.source.consent, scope?.agentConsent)
  const key = mcpSkillGrantKey(server, fetched.entry)
  const admit = (): void => {
    skill.content = mcpSkillBodyText(fetched.body, fetched.files)
    state.loaded = fetched
    scope?.run.allowed.add(key)
  }
  if (consent === 'never') {
    admit()
    return
  }
  if (!scope) {
    throw new McpSkillDeniedError(mcpSkillDeniedMessage(skill.name, server, 'no-one-to-ask'))
  }
  const known = [...state.source.skills, ...(state.source.added ?? [])].map((r) => r.uri)
  const outer = mcpSkillEnclosingUri(state.record.uri, known)
  const decision = decideMcpSkillConsent({
    consent,
    server,
    key,
    nested: outer !== undefined,
    grants: scope.grants,
    run: scope.run,
  })
  if (decision === 'deny') {
    throw new McpSkillDeniedError(mcpSkillDeniedMessage(skill.name, server, 'denied-earlier'))
  }
  if (decision === 'allow') {
    admit()
    return
  }
  // One question per skill and run: a second load of it waits for the first one's answer.
  const open = scope.run.pending.get(key)
  if (open) {
    if (await open) {
      admit()
      return
    }
    throw new McpSkillDeniedError(mcpSkillDeniedMessage(skill.name, server, 'denied-earlier'))
  }
  let settle: (approved: boolean) => void = () => {}
  scope.run.pending.set(
    key,
    new Promise<boolean>((resolve) => {
      settle = resolve
    }),
  )
  try {
    const view = mcpSkillConsentView({
      server,
      name: skill.name,
      entry: fetched.entry,
      body: fetched.body,
      consent,
      ...(state.byUri ? { byUri: true } : {}),
      ...(outer
        ? {
            nestedIn:
              skills.find((s) => s.mcp?.server === server && s.mcp.uri === outer)?.name ?? outer,
          }
        : {}),
      ...(fetched.snapshot ? { snapshot: fetched.snapshot } : {}),
    })
    const answer = await scope.ask(opts.input ?? { name: skill.name }, view, opts.signal)
    if (answer.by === 'person') {
      recordMcpSkillConsent({
        consent,
        server,
        key,
        approved: answer.approved,
        remember: answer.remember === true,
        grants: scope.grants,
        run: scope.run,
      })
    }
    settle(answer.approved)
    if (!answer.approved) {
      throw new McpSkillDeniedError(
        mcpSkillDeniedMessage(
          skill.name,
          server,
          answer.by === 'person'
            ? 'denied'
            : answer.by === 'no-handler'
              ? 'no-one-to-ask'
              : 'no-answer',
          answer.reason,
        ),
      )
    }
    admit()
  } catch (err) {
    settle(false)
    throw err
  } finally {
    scope.run.pending.delete(key)
  }
}

/**
 * Let the MCP skills among `names` in before they are activated (the planner's picks, a resumed
 * run's active skills): acquireMcpSkill, with the person asked where the consent says so. One
 * that cannot be let in is reported and left out: it is not activated.
 */
export const prepareMcpSkills = async (
  skills: ISkill[],
  names: readonly string[],
  warn: (message: string) => void,
  scope: IMcpSkillConsentScope | undefined,
  signal?: AbortSignal,
): Promise<void> => {
  for (const name of names) {
    const skill = skills.find((s) => s.name === name)
    if (!skill || !isMcpSkill(skill) || isMcpSkillAllowed(skill, scope?.run)) {
      continue
    }
    try {
      await acquireMcpSkill(skill, skills, scope, { input: { name }, signal })
    } catch (err) {
      if (signal?.aborted) {
        throw err
      }
      warn(`[skills] ${name} is not loaded: ${(err as Error).message}`)
    }
  }
}

// One file of an MCP skill, as text under its own header - or, for a directory of it, its listing
// from the entry the skill was loaded with. The skill is let in first (asked about if need be): a
// file or a directory of a skill the person refused is not read. A path that is a listed file is
// that file. The server's live view of the directory is asked only when it declared
// `directoryRead` (`source.readDirectory`), and only to say whether the skill changed there.
const readMcpSkillFile = async (
  skill: ISkill,
  skills: readonly ISkill[],
  requested: string,
  scope: IMcpSkillConsentScope | undefined,
  signal?: AbortSignal,
): Promise<string | SkillDirectoryListing> => {
  if (!isMcpSkillAllowed(skill, scope?.run)) {
    await acquireMcpSkill(skill, skills, scope, { input: { name: skill.name }, signal })
  }
  const state = mcpSkillStates.get(skill) as IMcpSkillState
  const loaded = state.loaded as McpSkillLoaded
  const target = resolveMcpSkillPath(loaded.files, requested)
  if ('refused' in target) {
    throw new Error(`Skill "${skill.name}": ${target.refused}`)
  }
  if ('dir' in target) {
    const drift = await state.source.readDirectory?.(
      loaded,
      target.dir,
      signal ? { signal } : undefined,
    )
    return skillDirectoryListing(skill.name, target.dir, target, drift)
  }
  const text = await state.source.readFile(loaded, target.path, signal ? { signal } : undefined)
  return mcpSkillFileText(state.source.server, state.record.uri, target.path, text)
}

// A consent scope for the approval controller and the run (null outside a run: nobody to ask).
export const mcpSkillConsentScope = (
  approval: Pick<IApprovalController, 'mcpSkillGrants' | 'askSkill'> | undefined,
  run: McpSkillRunConsent | undefined,
  agentConsent: McpSkillConsent | undefined,
): IMcpSkillConsentScope | undefined =>
  approval && run
    ? {
        ...(agentConsent ? { agentConsent } : {}),
        grants: approval.mcpSkillGrants,
        run,
        ask: (input, skill, signal) => approval.askSkill(input, skill, { signal }),
      }
    : undefined

// How a skill's text is introduced to the model: a lesson as the agent's own note, an MCP
// server's skill as third-party knowledge; the operator's skills as they are.
export const skillPreamble = (skill: ISkill): string => {
  const learned = learnedPreamble(skill)
  if (learned) {
    return learned
  }
  const state = mcpSkillStates.get(skill)
  return state ? mcpSkillPreamble(state.source.server, state.record.uri) : ''
}

const unquote = (raw: string): string => {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string
    } catch {
      return v.slice(1, -1)
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'")
  }
  // Plain scalar: strip a trailing " # comment".
  return v.replace(/\s+#.*$/, '')
}

// Minimal YAML subset: top-level `key: value` pairs with plain / quoted
// scalars and `>` / `|` block scalars (with optional -/+ chomping).
// Nested maps and lists are skipped.
const parseFrontmatter = (block: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const lines = block.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line)
    if (!m) {
      continue
    }
    const key = m[1]
    const rest = m[2].trim()
    const block = /^([>|])([+-]?)\s*(#.*)?$/.exec(rest)
    if (block) {
      const collected: string[] = []
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        collected.push(lines[++i])
      }
      while (collected.length && collected[collected.length - 1].trim() === '') {
        collected.pop()
      }
      const indent = Math.min(
        ...collected.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length),
      )
      const body = collected.map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
      out[key] =
        block[1] === '|'
          ? body.join('\n')
          : body
              .join('\n')
              .split(/\n\s*\n/)
              .map((para) => para.replace(/\n/g, ' ').trim())
              .join('\n')
      continue
    }
    out[key] = unquote(rest)
  }
  return out
}

/**
 * Parse a SKILL.md: YAML-ish frontmatter between `---` lines with `name:`
 * and `description:`, the body is the content. Throws a clear error when the
 * frontmatter, the name or the description is missing or the name invalid.
 */
export const parseSkillMarkdown = (
  markdown: string,
  files?: { path: string; content: string }[],
): ISkill => {
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const m = /^\s*---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (!m) {
    throw new Error('SKILL.md must start with a frontmatter block between "---" lines')
  }
  const meta = parseFrontmatter(m[1])
  if (!meta.name) {
    throw new Error('SKILL.md frontmatter is missing "name"')
  }
  if (!meta.description) {
    throw new Error(`SKILL.md "${meta.name}": frontmatter is missing "description"`)
  }
  return defineSkill({
    name: meta.name,
    description: meta.description,
    content: text.slice(m[0].length).trim(),
    ...(files?.length ? { files } : {}),
  })
}

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.ts',
  '.js',
  '.py',
  '.sh',
  '.html',
  '.css',
  '.xml',
  '.toml',
])
const MAX_SKILL_FILE_BYTES = 256 * 1024

const collectFiles = async (
  root: string,
  dir: string,
  out: { path: string; content: string }[],
): Promise<void> => {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') {
      continue
    }
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      await collectFiles(root, full, out)
      continue
    }
    if (!e.isFile()) {
      continue
    }
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (rel === 'SKILL.md' || !TEXT_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      continue
    }
    if ((await stat(full)).size > MAX_SKILL_FILE_BYTES) {
      continue
    }
    out.push({ path: rel, content: await readFile(full, 'utf8') })
  }
}

/**
 * Load every `<dir>/<skill>/SKILL.md`. Bundled files are the other text
 * files under that skill folder (recursive; text extensions only; files over
 * 256 KB skipped). Folders without a SKILL.md are ignored; duplicate skill
 * names throw.
 */
export const loadSkillsFromDir = async (dir: string): Promise<ISkill[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const skills: ISkill[] = []
  const names = new Set<string>()
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') {
      continue
    }
    const skillDir = path.join(dir, e.name)
    let markdown: string
    try {
      markdown = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const files: { path: string; content: string }[] = []
    await collectFiles(skillDir, skillDir, files)
    let skill: ISkill
    try {
      skill = parseSkillMarkdown(markdown, files)
    } catch (err) {
      throw new Error(`${path.join(skillDir, 'SKILL.md')}: ${(err as Error).message}`)
    }
    if (names.has(skill.name)) {
      throw new Error(`duplicate skill name "${skill.name}" in ${dir}`)
    }
    names.add(skill.name)
    skills.push(skill)
  }
  return skills
}

// Validate a configured skill list (shapes + unique names).
export const validateSkills = (skills: ISkill[] | undefined): ISkill[] => {
  const out: ISkill[] = []
  const names = new Set<string>()
  for (const s of skills ?? []) {
    const skill = defineSkill(s)
    if (names.has(skill.name)) {
      throw new Error(`duplicate skill name "${skill.name}"`)
    }
    names.add(skill.name)
    out.push(skill)
  }
  return out
}

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// "- name: description" lines for the planner / executor system prompts.
export const renderSkillsIndex = (skills: ISkill[]): string =>
  skills.map((s) => `- ${s.name}: ${oneLine(s.description, 300)}`).join('\n')

/**
 * The instructions of the active skills, in activation order, within a char
 * budget (the rest is clipped with a marker).
 */
export const renderActiveSkills = (
  skills: ISkill[],
  active: string[],
  budget = ACTIVE_SKILLS_BUDGET_CHARS,
): string => {
  const byName = new Map(skills.map((s) => [s.name, s]))
  const parts: string[] = []
  let used = 0
  for (const name of active) {
    const skill = byName.get(name)
    if (!skill) {
      continue
    }
    // An MCP skill whose instructions were not read is not active (activateSkill), whatever a
    // resumed snapshot says.
    if (isMcpSkill(skill) && !isMcpSkillLoaded(skill)) {
      continue
    }
    const block = `### Skill: ${skill.name}\n${skillPreamble(skill)}${skill.content.trim()}`
    const left = budget - used
    if (left <= 0) {
      parts.push(`### Skill: ${skill.name}\n… [skill instructions clipped: budget exhausted]`)
      continue
    }
    if (block.length > left) {
      parts.push(`${block.slice(0, left)}\n… [skill instructions clipped]`)
      used = budget
      continue
    }
    parts.push(block)
    used += block.length
  }
  return parts.join('\n\n')
}

/**
 * Activate a skill for the rest of the current run (idempotent). Emits
 * skill.activated once per skill and run. Returns false for an unknown name.
 */
export const activateSkill = (
  skills: ISkill[],
  name: string,
  by: 'plan' | 'tool',
  target?: { activeSkills: string[]; mcpSkillConsent?: McpSkillRunConsent },
  emit?: (event: {
    type: 'skill.activated'
    name: string
    by: 'plan' | 'tool'
    server?: string
  }) => void,
): boolean => {
  const skill = skills.find((s) => s.name === name)
  if (!skill) {
    return false
  }
  // An MCP skill is active only once its instructions were read, verified and let into THIS
  // run's context (acquireMcpSkill: the person's consent).
  if (isMcpSkill(skill) && !isMcpSkillAllowed(skill, target?.mcpSkillConsent)) {
    return false
  }
  if (target && !target.activeSkills.includes(name)) {
    target.activeSkills.push(name)
    emit?.({
      type: 'skill.activated',
      name,
      by,
      ...(skill.mcp ? { server: skill.mcp.server } : {}),
    })
  }
  return true
}

// What createSkillTools needs of the MCP servers whose skills are on (`skills` on a server).
export interface ISkillToolsMcp {
  // The servers' keys, fixed for the agent's life: they are named in load_skill's description
  // (run-stable), which then takes `{ server, uri }` too.
  servers: readonly string[]
  // The connected servers' skill sources, read when a call needs one.
  sources: () => readonly McpSkillSource[]
  // The current run's consent scope (undefined outside a run: nobody to ask).
  scope: () => IMcpSkillConsentScope | undefined
  // What the agent's snapshots of generated skills hold (a skill added by URI counts there).
  memory?: McpSkillSnapshotMemory
}

// The built-in load_skill / read_skill_file tools. Read-only, never need
// approval; they activate skills in the CURRENT run via the run context.
// With `live`, the list may grow while the agent runs (learned skills): the tools exist from the
// start, and look the list up when called instead of freezing its names. With `mcp`, an MCP
// server's skill enters the context only once the person let it in (acquireMcpSkill), and a skill
// a server names by URI can be loaded with `{ server, uri }`.
export const createSkillTools = (
  skills: ISkill[],
  opts: { live?: boolean; mcp?: ISkillToolsMcp } = {},
): ToolSet => {
  if (!skills.length && !opts.live) {
    return {}
  }
  const names = opts.live ? undefined : skills.map((s) => s.name)
  const find = (name: string): ISkill => {
    const skill = skills.find((s) => s.name === name)
    if (!skill) {
      throw new Error(
        `Unknown skill "${name}". Available skills: ${skills.map((s) => s.name).join(', ') || '(none yet)'}`,
      )
    }
    return skill
  }
  const mcp = opts.mcp
  const byUri = Boolean(mcp?.servers.length)
  const nameField = z
    .string()
    .describe(
      names ? `Skill name, one of: ${names.join(', ')}` : 'Skill name, from the SKILLS list',
    )
  const describe =
    'Load the full instructions of a skill from the SKILLS list and activate it for the rest of the task. Call it before doing work a skill covers.'
  const load = async (
    skill: ISkill,
    input: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{ name: string; content: string; files: string[] }> => {
    const store = runContext.getStore()
    // An MCP server's skill: its SKILL.md is read and verified now (throws on a mismatch), and
    // enters the context only once the person let it in.
    if (isMcpSkill(skill)) {
      await acquireMcpSkill(skill, skills, mcp?.scope(), { input, signal })
    }
    activateSkill(skills, skill.name, 'tool', store?.state, store?.emit)
    return {
      name: skill.name,
      content: `${skillPreamble(skill)}${skill.content}`,
      files: isMcpSkill(skill)
        ? [...((mcpSkillStates.get(skill) as IMcpSkillState).loaded?.files ?? [])]
        : (skill.files ?? []).map((f) => f.path),
    }
  }
  return {
    [LOAD_SKILL_TOOL]: markReadOnly(
      byUri
        ? tool({
            description: `${describe} ${mcpSkillLoadByUriNote(mcp?.servers ?? [])}`,
            inputSchema: z.object({
              name: nameField.optional(),
              server: z
                .string()
                .optional()
                .describe('With uri: the MCP server that named the skill'),
              uri: z
                .string()
                .optional()
                .describe("With server: the skill:// URI of the skill's SKILL.md"),
            }),
            execute: async (input, options) => {
              const { name, server, uri } = input
              if (uri !== undefined || server !== undefined) {
                const skill = await addMcpSkillByUri(
                  skills,
                  mcp?.sources() ?? [],
                  { server, uri },
                  options?.abortSignal,
                  mcp?.memory,
                )
                return load(skill, { server, uri }, options?.abortSignal)
              }
              if (typeof name !== 'string' || !name) {
                throw new Error(
                  'load_skill: give "name" (from the SKILLS list), or "server" and "uri"',
                )
              }
              return load(find(name), { name }, options?.abortSignal)
            },
          })
        : tool({
            description: describe,
            inputSchema: z.object({ name: nameField }),
            execute: async ({ name }, options) => load(find(name), { name }, options?.abortSignal),
          }),
    ),
    [READ_SKILL_FILE_TOOL]: markReadOnly(
      tool({
        description:
          'Read a file bundled with a skill (paths are listed by load_skill). Returns the file content; a directory path ("templates/", "." for the root) returns its listing.',
        inputSchema: z.object({
          name: z.string().describe('Skill name'),
          path: z
            .string()
            .describe('Skill-relative file path, as listed by load_skill, or a directory to list'),
        }),
        execute: async ({ name, path: filePath }, options) => {
          const skill = find(name)
          // An MCP server's skill: the file is read from that server only, if its entry lists
          // it, and verified - as text, never run.
          if (isMcpSkill(skill)) {
            return readMcpSkillFile(skill, skills, filePath, mcp?.scope(), options?.abortSignal)
          }
          const paths = (skill.files ?? []).map((f) => f.path)
          let wanted: string
          try {
            wanted = normalizeSkillPath(filePath)
          } catch (err) {
            // Not a file path - perhaps the root (".", "/") or another directory of the skill.
            const directory = skillDirectoryOf(paths, filePath)
            if (directory) {
              return skillDirectoryListing(skill.name, directory.dir, directory)
            }
            throw new Error((err as Error).message)
          }
          const file = (skill.files ?? []).find((f) => f.path === wanted)
          if (!file) {
            const directory = skillDirectoryOf(paths, filePath)
            if (directory) {
              return skillDirectoryListing(skill.name, directory.dir, directory)
            }
            throw new Error(
              `Skill "${skill.name}" has no file "${filePath}". Files: ${paths.length ? paths.join(', ') : '(none)'}`,
            )
          }
          return file.content
        },
      }),
    ),
  }
}
