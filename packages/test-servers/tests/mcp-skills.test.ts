import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { SKILL_MARKERS, SKILL_URIS, startLocalMcpServer } from '../src/index.ts'
import { initialize, legacy, modern } from './mcp-wire.ts'

// The skills (`skills`), on the wire with hand-built JSON-RPC: the extension in `server/discover`,
// `skills/list` / `skills/get` / `resources/read`, the 2025 side without them, and every fault.

const EXT = 'io.modelcontextprotocol/skills'
const sha256 = (text: string): string =>
  `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`

const rpc = async (url: string, method: string, params: Record<string, unknown> = {}) => {
  const answer = await modern(url, method, params, {
    capabilities: { extensions: { [EXT]: {} } },
    ...(typeof params.uri === 'string' ? { headers: { 'mcp-name': params.uri } } : {}),
  })
  return answer.message
}

test('skills: off by default - no extension, no skills/list', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern' })
  try {
    const discover = await rpc(mcp.url, 'server/discover')
    assert.equal(discover.result.capabilities.extensions?.[EXT], undefined)
    const list = await rpc(mcp.url, 'skills/list')
    assert.ok(list.error, 'an unknown method')
  } finally {
    await mcp.close()
  }
})

test('skills: declared and listed on 2026-07-28; the entries match what is served', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    const discover = await rpc(mcp.url, 'server/discover')
    assert.deepEqual(discover.result.capabilities.extensions[EXT], {})
    assert.ok(discover.result.capabilities.resources, 'the extension needs resources')
    const { result } = await rpc(mcp.url, 'skills/list')
    assert.equal(result.resultType, 'complete')
    assert.equal(typeof result.ttlMs, 'number')
    assert.deepEqual(
      result.skills.map((s: { uri: string }) => s.uri),
      [
        'skill://git-workflow/SKILL.md',
        'skill://pdf-processing/SKILL.md',
        'skill://acme/billing/refunds/SKILL.md',
        'skill://acme/support/refunds/SKILL.md',
      ],
    )
    assert.equal(mcp.skillReads.length, 0, 'listing reads nothing')
    // Every listed file is served with the listed digest and size.
    for (const skill of result.skills) {
      for (const file of skill.resources) {
        const read = await rpc(mcp.url, 'resources/read', { uri: file.uri })
        const text = read.result.contents[0].text as string
        assert.equal(sha256(text), file.digest, file.uri)
        assert.equal(Buffer.byteLength(text), file.size, file.uri)
      }
    }
    const pdf = await rpc(mcp.url, 'skills/get', { uri: 'skill://pdf-processing/SKILL.md' })
    assert.deepEqual(pdf.result.skill.resources.map((r: { uri: string }) => r.uri).sort(), [
      'skill://pdf-processing/SKILL.md',
      'skill://pdf-processing/references/FORMS.md',
      'skill://pdf-processing/scripts/extract.py',
    ])
    const unknown = await rpc(mcp.url, 'skills/get', { uri: 'skill://nope/SKILL.md' })
    assert.equal(unknown.error?.code, -32602)
    assert.ok(mcp.skillReads.includes('skill://pdf-processing/scripts/extract.py'))
  } finally {
    await mcp.close()
  }
})

test('skills: the 2025 side of `dual` never serves them', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'dual', skills: true })
  try {
    const init = await initialize(mcp.url, { extensions: { [EXT]: {} } })
    assert.equal(init.message.result.capabilities.extensions?.[EXT], undefined)
    const list = await legacy(mcp.url, { jsonrpc: '2.0', id: 2, method: 'skills/list', params: {} })
    assert.ok(list.message?.error)
  } finally {
    await mcp.close()
  }
})

test('skills: each fault adds the skill it says, and only that', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern', skills: true })
  const uris = async (): Promise<string[]> =>
    (await rpc(mcp.url, 'skills/list')).result.skills.map((s: { uri: string }) => s.uri)
  const entry = async (uri: string) =>
    (await rpc(mcp.url, 'skills/list')).result.skills.find((s: { uri: string }) => s.uri === uri)
  const served = async (uri: string): Promise<string> =>
    (await rpc(mcp.url, 'resources/read', { uri })).result.contents[0].text
  try {
    const honest = await uris()
    mcp.skillFaults.digest = true
    const tampered = await entry('skill://tampered/SKILL.md')
    const text = await served('skill://tampered/SKILL.md')
    assert.equal(Buffer.byteLength(text), tampered.resources[0].size, 'same size')
    assert.notEqual(sha256(text), tampered.resources[0].digest, 'another digest')
    mcp.skillFaults.digest = false

    mcp.skillFaults.frontmatter = true
    const drifted = await entry('skill://drifted/SKILL.md')
    const md = await served('skill://drifted/SKILL.md')
    assert.equal(sha256(md), drifted.resources[0].digest, 'the digest matches')
    assert.ok(!md.includes(drifted.frontmatter.description), 'the description does not')
    mcp.skillFaults.frontmatter = false

    mcp.skillFaults.nameMismatch = true
    const wrong = await entry('skill://wrong-name/SKILL.md')
    assert.equal(wrong.frontmatter.name, 'other-name')
    mcp.skillFaults.nameMismatch = false

    mcp.skillFaults.oversize = true
    assert.equal((await entry('skill://huge/SKILL.md')).resources.length, 513)
    mcp.skillFaults.oversize = false

    mcp.skillFaults.dynamic = true
    assert.equal((await entry('skill://generated/SKILL.md')).resources, 'dynamic')
    mcp.skillFaults.dynamic = false

    mcp.skillFaults.hostile = true
    const hostile = await entry('skill://approve-everything/SKILL.md')
    assert.equal(hostile.frontmatter['allowed-tools'], 'run_js web_fetch')
    assert.ok((await served('skill://approve-everything/SKILL.md')).includes(SKILL_MARKERS.hostile))
    mcp.skillFaults.hostile = false

    mcp.skillFaults.longBody = true
    assert.ok((await served('skill://long-guide/SKILL.md')).length > 40_000)
    mcp.skillFaults.longBody = false

    const forms = (await entry('skill://pdf-processing/SKILL.md')).resources.find(
      (r: { uri: string }) => r.uri.endsWith('FORMS.md'),
    )
    mcp.skillFaults.changedFile = true
    const changed = await served(forms.uri)
    assert.equal(Buffer.byteLength(changed), forms.size)
    assert.notEqual(sha256(changed), forms.digest)
    mcp.skillFaults.changedFile = false

    mcp.skillFaults.extra = 3
    assert.deepEqual((await uris()).slice(honest.length), [
      'skill://extra-1/SKILL.md',
      'skill://extra-2/SKILL.md',
      'skill://extra-3/SKILL.md',
    ])
    mcp.skillFaults.extra = 0
    assert.deepEqual(await uris(), honest)
  } finally {
    await mcp.close()
  }
})

test('skills: addSkill serves it from then on', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    await mcp.addSkill(
      'release-notes',
      'Write the release notes',
      `# Notes\n\n${SKILL_MARKERS.added}\n`,
    )
    const got = await rpc(mcp.url, 'skills/get', { uri: 'skill://release-notes/SKILL.md' })
    assert.equal(got.result.skill.frontmatter.description, 'Write the release notes')
  } finally {
    await mcp.close()
  }
})

test('skills: one skill is never listed, but skills/get and resources/read answer for it', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    const listed = (await rpc(mcp.url, 'skills/list')).result.skills.map(
      (s: { uri: string }) => s.uri,
    )
    assert.ok(!listed.includes(SKILL_URIS.unlisted), 'not listed')
    const got = await rpc(mcp.url, 'skills/get', { uri: SKILL_URIS.unlisted })
    assert.equal(got.result.resultType, 'complete')
    assert.equal(got.result.skill.uri, SKILL_URIS.unlisted)
    assert.equal(got.result.skill.frontmatter.name, 'release-checklist')
    const [file] = got.result.skill.resources
    const text = (await rpc(mcp.url, 'resources/read', { uri: file.uri })).result.contents[0]
      .text as string
    assert.equal(sha256(text), file.digest)
    assert.ok(text.includes(SKILL_MARKERS.unlisted))
    assert.deepEqual(mcp.skillGets, [SKILL_URIS.unlisted])
    // addSkill with `listed: false` serves one more the same way.
    await mcp.addSkill('elsewhere/vendor-guide', 'A guide', '# Vendor\n', { listed: false })
    const vendor = await rpc(mcp.url, 'skills/get', {
      uri: 'skill://elsewhere/vendor-guide/SKILL.md',
    })
    assert.equal(vendor.result.skill.frontmatter.name, 'vendor-guide')
    assert.ok(
      !(await rpc(mcp.url, 'skills/list')).result.skills.some(
        (s: { uri: string }) => s.uri === 'skill://elsewhere/vendor-guide/SKILL.md',
      ),
    )
  } finally {
    await mcp.close()
  }
})

test('skills: `nested` lists a skill with a skill inside it, each with its own entry', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    mcp.skillFaults.nested = true
    const skills = (await rpc(mcp.url, 'skills/list')).result.skills as {
      uri: string
      resources: { uri: string; digest: string }[]
    }[]
    const handbook = skills.find((s) => s.uri === SKILL_URIS.handbook)!
    const onboarding = skills.find((s) => s.uri === SKILL_URIS.onboarding)!
    assert.deepEqual(handbook.resources.map((r) => r.uri).sort(), [
      'skill://handbook/SKILL.md',
      'skill://handbook/onboarding/SKILL.md',
    ])
    // The same file, listed by both: the same digest.
    assert.equal(
      handbook.resources.find((r) => r.uri === SKILL_URIS.onboarding)?.digest,
      onboarding.resources[0].digest,
    )
    const body = (await rpc(mcp.url, 'resources/read', { uri: SKILL_URIS.onboarding })).result
      .contents[0].text as string
    assert.ok(body.includes(SKILL_MARKERS.onboarding))
  } finally {
    await mcp.close()
  }
})

test('skills: `emptyListing` lists nothing; skills/get still answers, faults included', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    Object.assign(mcp.skillFaults, { emptyListing: true, digest: true })
    assert.deepEqual((await rpc(mcp.url, 'skills/list')).result.skills, [])
    const pdf = await rpc(mcp.url, 'skills/get', { uri: 'skill://pdf-processing/SKILL.md' })
    assert.equal(pdf.result.skill.frontmatter.name, 'pdf-processing')
    const tampered = await rpc(mcp.url, 'skills/get', { uri: 'skill://tampered/SKILL.md' })
    assert.equal(tampered.result.skill.frontmatter.name, 'tampered')
    const nope = await rpc(mcp.url, 'skills/get', { uri: 'skill://nope/SKILL.md' })
    assert.equal(nope.error?.code, -32602)
  } finally {
    await mcp.close()
  }
})

// `skillDirectoryRead`: `resources/directory/read` (the extension's optional method), on the wire.

const directory = async (url: string, uri: string, cursor?: string) =>
  rpc(url, 'resources/directory/read', { uri, ...(cursor === undefined ? {} : { cursor }) })
const childrenOf = (answer: { result?: { resources: { uri: string; mimeType?: string }[] } }) =>
  (answer.result?.resources ?? []).map((r) => `${r.uri} ${r.mimeType}`)

test('directory reads: off by default - no directoryRead declared, the method unknown', async () => {
  const mcp = await startLocalMcpServer({ protocol: 'modern', skills: true })
  try {
    const discover = await rpc(mcp.url, 'server/discover')
    assert.deepEqual(discover.result.capabilities.extensions[EXT], {})
    const read = await directory(mcp.url, 'skill://pdf-processing')
    assert.ok(read.error, 'not served')
    assert.notEqual(read.error.code, -32602, 'an unknown method, not a refused directory')
    assert.deepEqual(mcp.skillDirectoryReads, [])
  } finally {
    await mcp.close()
  }
})

test('directory reads: declared; the direct children, subdirectories as inode/directory', async () => {
  const mcp = await startLocalMcpServer({
    protocol: 'modern',
    skills: true,
    skillDirectoryRead: true,
  })
  try {
    const discover = await rpc(mcp.url, 'server/discover')
    assert.deepEqual(discover.result.capabilities.extensions[EXT], { directoryRead: true })
    const root = await directory(mcp.url, 'skill://pdf-processing')
    assert.equal(root.result.resultType, 'complete')
    assert.equal(typeof root.result.ttlMs, 'number')
    assert.equal(typeof root.result.cacheScope, 'string')
    assert.equal(root.result.nextCursor, undefined)
    assert.deepEqual(childrenOf(root), [
      'skill://pdf-processing/SKILL.md text/markdown',
      'skill://pdf-processing/references inode/directory',
      'skill://pdf-processing/scripts inode/directory',
    ])
    for (const r of root.result.resources) assert.equal(typeof r.name, 'string')
    assert.deepEqual(childrenOf(await directory(mcp.url, 'skill://pdf-processing/references')), [
      'skill://pdf-processing/references/FORMS.md text/markdown',
    ])
    // A prefix above the skills is a directory too; the listing is not recursive.
    assert.deepEqual(childrenOf(await directory(mcp.url, 'skill://acme')), [
      'skill://acme/billing inode/directory',
      'skill://acme/support inode/directory',
    ])
    // Not a directory: a file, a trailing slash, nothing at all - -32602.
    for (const uri of [
      'skill://pdf-processing/SKILL.md',
      'skill://pdf-processing/',
      'skill://nope',
      'https://example.com/x',
    ]) {
      assert.equal((await directory(mcp.url, uri)).error?.code, -32602, uri)
    }
    assert.equal(mcp.skillDirectoryReads[0], 'skill://pdf-processing')
    assert.equal(mcp.skillDirectoryReads.length, 7)
    assert.ok(
      mcp.requests.some((r) => r.method === 'resources/directory/read'),
      'in the request log',
    )
  } finally {
    await mcp.close()
  }
})

test('directory reads: `pageSize` pages the children with nextCursor; a bad cursor is -32602', async () => {
  const mcp = await startLocalMcpServer({
    protocol: 'modern',
    skills: true,
    skillDirectoryRead: { pageSize: 2 },
  })
  try {
    const first = await directory(mcp.url, 'skill://pdf-processing')
    assert.equal(first.result.resources.length, 2)
    assert.equal(typeof first.result.nextCursor, 'string')
    const second = await directory(mcp.url, 'skill://pdf-processing', first.result.nextCursor)
    assert.equal(second.result.nextCursor, undefined)
    assert.deepEqual(
      [...childrenOf(first), ...childrenOf(second)],
      [
        'skill://pdf-processing/SKILL.md text/markdown',
        'skill://pdf-processing/references inode/directory',
        'skill://pdf-processing/scripts inode/directory',
      ],
    )
    assert.equal((await directory(mcp.url, 'skill://pdf-processing', 'nope')).error?.code, -32602)
    assert.deepEqual(mcp.skillDirectoryReads, [
      'skill://pdf-processing',
      'skill://pdf-processing',
      'skill://pdf-processing',
    ])
  } finally {
    await mcp.close()
  }
})

test('directory reads: the faults - an extra file, an omitted one, an error', async () => {
  const mcp = await startLocalMcpServer({
    protocol: 'modern',
    skills: true,
    skillDirectoryRead: true,
  })
  try {
    const references = 'skill://pdf-processing/references'
    const scripts = 'skill://pdf-processing/scripts'
    mcp.skillFaults.directoryExtra = true
    assert.deepEqual(childrenOf(await directory(mcp.url, references)), [
      'skill://pdf-processing/references/FORMS.md text/markdown',
      `${SKILL_URIS.newFile} text/markdown`,
    ])
    const extra = await rpc(mcp.url, 'resources/read', { uri: SKILL_URIS.newFile })
    assert.ok((extra.result.contents[0].text as string).includes(SKILL_MARKERS.newFile))
    // The entry is unchanged: the server's listing is ahead of it.
    const pdf = await rpc(mcp.url, 'skills/get', { uri: 'skill://pdf-processing/SKILL.md' })
    assert.ok(!JSON.stringify(pdf.result.skill).includes('NEW.md'))
    mcp.skillFaults.directoryExtra = false
    assert.deepEqual(childrenOf(await directory(mcp.url, references)), [
      'skill://pdf-processing/references/FORMS.md text/markdown',
    ])

    mcp.skillFaults.directoryOmit = true
    const omitted = await directory(mcp.url, scripts)
    assert.deepEqual(omitted.result.resources, [], 'still a directory, now empty')
    mcp.skillFaults.directoryOmit = false
    assert.deepEqual(childrenOf(await directory(mcp.url, scripts)), [
      'skill://pdf-processing/scripts/extract.py text/plain',
    ])

    mcp.skillFaults.directoryError = true
    assert.equal((await directory(mcp.url, references)).error?.code, -32603)
    mcp.skillFaults.directoryError = false
  } finally {
    await mcp.close()
  }
})
