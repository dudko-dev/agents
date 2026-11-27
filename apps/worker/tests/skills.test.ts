import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test, { mock } from 'node:test'
import {
  MCP_SKILL_BODY_MAX_CHARS,
  MCP_SKILL_DESCRIPTION_MAX_CHARS,
  MCP_SKILL_FILE_MAX_CHARS,
  MCP_SKILLS_EXTENSION,
  mcpSkillEntryRefusal,
} from '@dudko.dev/agent-web'
import { createDemoMcpServer, DEMO_LIMITS, type DemoMcpServer } from '../src/demo-server.ts'
import {
  DEMO_SKILL_FILES,
  DEMO_SKILL_MAX_BYTES,
  DEMO_SKILL_URIS,
  DEMO_SKILLS_PREFIX,
} from '../src/skills.ts'
import { initialize, legacy, modern, URL_ON_SITE } from './wire.ts'

// The demo server's skills (the `io.modelcontextprotocol/skills` extension), spoken to by hand as
// in demo-server.test.ts: declared and served on 2026-07-28 only; every entry valid under the
// demo client's own rules (`mcpSkillEntryRefusal` of @dudko.dev/agent-web, the rules its catalog
// applies) and true to the bytes `resources/read` serves. The demo's client loading them for real
// is in client.test.ts; the agent following one in the demo, in the React package's
// e2e/demo-server-skills.spec.ts.

const withServer = async (body: (server: DemoMcpServer) => Promise<void>): Promise<void> => {
  const server = createDemoMcpServer()
  try {
    await body(server)
  } finally {
    await server.close()
  }
}

const sha256 = (text: string): string =>
  `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`

interface Entry {
  uri: string
  frontmatter: { name: string; description: string; [key: string]: unknown }
  resources: { uri: string; digest: string; size: number }[]
}

const list = async (server: DemoMcpServer): Promise<Entry[]> => {
  const answer = await modern(server, 'skills/list')
  assert.equal(answer.status, 200)
  assert.equal(answer.message.result.resultType, 'complete')
  // A CacheableResult: both fields are required on 2026-07-28.
  assert.equal(typeof answer.message.result.ttlMs, 'number')
  assert.equal(typeof answer.message.result.cacheScope, 'string')
  assert.equal(answer.message.result.nextCursor, undefined)
  return answer.message.result.skills
}

const readText = async (server: DemoMcpServer, uri: string): Promise<string> => {
  const answer = await modern(server, 'resources/read', { uri })
  assert.equal(answer.status, 200, JSON.stringify(answer.message))
  const [content, ...rest] = answer.message.result.contents
  assert.deepEqual(rest, [])
  assert.equal(content.uri, uri)
  assert.equal(content.mimeType, 'text/markdown')
  assert.equal(typeof content.text, 'string')
  return content.text
}

// The frontmatter of a SKILL.md as these files write it: `key: value` lines between `---` lines.
const frontmatterOf = (markdown: string): Record<string, string> => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(markdown)
  assert.ok(m, 'a SKILL.md starts with its frontmatter')
  return Object.fromEntries(
    m[1].split('\n').map((line) => {
      const at = line.indexOf(': ')
      return [line.slice(0, at), line.slice(at + 2)]
    }),
  )
}

// ── the extension, on one era ───────────────────────────────────────────────

test('2026-07-28: server/discover declares the extension (no directoryRead) beside resources', async () => {
  await withServer(async (server) => {
    const { capabilities } = (await modern(server, 'server/discover')).message.result
    assert.deepEqual(capabilities.extensions, { [MCP_SKILLS_EXTENSION]: {} })
    // The spec: a server that declares the extension MUST declare `resources` too.
    assert.ok(capabilities.resources)
  })
})

test('2025-11-25: no extension is declared, and the skills methods are unknown', async () => {
  await withServer(async (server) => {
    const { capabilities } = (await initialize(server)).message.result
    assert.equal(capabilities.extensions, undefined)
    for (const [method, params] of [
      ['skills/list', {}],
      ['skills/get', { uri: DEMO_SKILL_URIS[0] }],
    ] as const) {
      const answer = await legacy(server, { jsonrpc: '2.0', id: 1, method, params })
      assert.equal(answer.message.error?.code, -32601, method)
    }
  })
})

// ── skills/list ─────────────────────────────────────────────────────────────

test("skills/list: the two skills, each valid under the demo client's rules", async () => {
  await withServer(async (server) => {
    const skills = await list(server)
    assert.deepEqual(
      skills.map((s) => s.uri),
      [`skill://${DEMO_SKILLS_PREFIX}/trip-planning/SKILL.md`, `skill://demo/dice-games/SKILL.md`],
    )
    assert.deepEqual(
      DEMO_SKILL_URIS,
      skills.map((s) => s.uri),
    )
    for (const skill of skills) {
      // The rules the agent's catalog applies to an entry before it reads anything of it.
      assert.equal(mcpSkillEntryRefusal(skill), undefined, skill.uri)
      // The URI's last segment is the frontmatter name (and the naming rules hold).
      assert.equal(skill.uri.split('/').at(-2), skill.frontmatter.name)
      assert.match(skill.frontmatter.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
      // Static content: a complete list of files, never "dynamic".
      assert.ok(Array.isArray(skill.resources))
      // Its catalog line is not cut: the description and the origin tag fit in the cap.
      const tag = ` [from the MCP server "demo" - third-party]`
      assert.ok(
        skill.frontmatter.description.length + tag.length <= MCP_SKILL_DESCRIPTION_MAX_CHARS,
      )
    }
    const files = (uri: string) =>
      skills.find((s) => s.uri === uri)?.resources.map((r) => r.uri.slice(uri.length - 8))
    assert.deepEqual(files(DEMO_SKILL_URIS[0]), ['SKILL.md', 'references/checklist.md'])
    assert.deepEqual(files(DEMO_SKILL_URIS[1]), ['SKILL.md'])
  })
})

test('skills/list: sizes and digests are those of the bytes resources/read serves', async () => {
  await withServer(async (server) => {
    const skills = await list(server)
    let listed = 0
    for (const skill of skills) {
      const path = skill.uri.slice('skill://'.length, -'/SKILL.md'.length)
      const files = DEMO_SKILL_FILES[path]
      assert.ok(files, path)
      // `resources` is complete: every file of the skill is listed, and nothing else.
      assert.deepEqual(
        skill.resources.map((r) => r.uri).sort(),
        Object.keys(files)
          .map((file) => `skill://${path}/${file}`)
          .sort(),
      )
      for (const resource of skill.resources) {
        const text = await readText(server, resource.uri)
        assert.equal(text, files[resource.uri.slice(`skill://${path}/`.length)])
        assert.equal(resource.size, Buffer.byteLength(text, 'utf8'), resource.uri)
        assert.equal(resource.digest, sha256(text), resource.uri)
        listed += 1
      }
    }
    assert.equal(listed, 3)
  })
})

test("skills/list: the frontmatter is the SKILL.md's, field by field", async () => {
  await withServer(async (server) => {
    for (const skill of await list(server)) {
      assert.deepEqual(skill.frontmatter, frontmatterOf(await readText(server, skill.uri)))
    }
  })
})

test("size: each skill is small, well inside the client's caps and the answer bound", async () => {
  await withServer(async (server) => {
    for (const skill of await list(server)) {
      const bytes = skill.resources.reduce((sum, r) => sum + r.size, 0)
      assert.ok(bytes < DEMO_SKILL_MAX_BYTES, `${skill.uri}: ${bytes} bytes`)
      for (const r of skill.resources) {
        const text = await readText(server, r.uri)
        // Shown to the model whole: never cut by the client's caps.
        assert.ok(text.length < Math.min(MCP_SKILL_BODY_MAX_CHARS, MCP_SKILL_FILE_MAX_CHARS))
      }
    }
    // The largest skills answer is far under the response bound.
    const answer = await modern(server, 'skills/list')
    assert.ok(answer.text.length < DEMO_LIMITS.responseBytes / 8, `${answer.text.length}`)
  })
})

test('content: English, no URL, no outbound request asked of the model', async () => {
  for (const [path, files] of Object.entries(DEMO_SKILL_FILES)) {
    for (const [file, text] of Object.entries(files)) {
      // Plain ASCII text (English; no invisible or bidirectional characters for a client to strip).
      assert.match(text, /^[\x0a\x20-\x7e]*$/, `${path}/${file}`)
      assert.doesNotMatch(text, /https?:\/\//, `${path}/${file}`)
      assert.ok(text.endsWith('\n'))
    }
  }
})

// ── skills/get ──────────────────────────────────────────────────────────────

test('skills/list: one page; a cursor it never gave out is -32602', async () => {
  await withServer(async (server) => {
    const answer = await modern(server, 'skills/list', { cursor: 'after:skill://demo/x' })
    assert.equal(answer.message.error?.code, -32602)
  })
})

test('skills/get: a served skill is its listing entry; an unknown URI is -32602', async () => {
  await withServer(async (server) => {
    const skills = await list(server)
    for (const skill of skills) {
      const answer = await modern(server, 'skills/get', { uri: skill.uri })
      assert.equal(answer.message.result.resultType, 'complete')
      assert.equal(typeof answer.message.result.ttlMs, 'number')
      assert.deepEqual(answer.message.result.skill, skill)
    }
    for (const uri of [
      'skill://demo/unknown/SKILL.md',
      'skill://trip-planning/SKILL.md',
      'skill://demo/trip-planning/references/checklist.md',
    ]) {
      const answer = await modern(server, 'skills/get', { uri })
      assert.equal(answer.message.error?.code, -32602, uri)
      assert.match(answer.message.error.message, /No skill is served/)
    }
  })
})

// ── resources/read ──────────────────────────────────────────────────────────

test('resources/read: a skill:// file the server does not serve is -32602', async () => {
  await withServer(async (server) => {
    for (const uri of [
      'skill://demo/trip-planning/references/other.md',
      'skill://demo/trip-planning',
      'skill://demo/unknown/SKILL.md',
    ]) {
      const answer = await modern(server, 'resources/read', { uri })
      assert.equal(answer.message.error?.code, -32602, uri)
    }
    // The app's resource is still the only one listed: skill files are read by URI.
    const { resources } = (await modern(server, 'resources/list')).message.result
    assert.deepEqual(
      resources.map((r: { uri: string }) => r.uri),
      ['ui://demo/trip-board.html'],
    )
  })
})

test('stateless: two servers (two isolates) list the same entries, digests included', async () => {
  const a = createDemoMcpServer()
  const b = createDemoMcpServer()
  try {
    assert.deepEqual(await list(a), await list(b))
    assert.deepEqual(await list(a), await list(a))
  } finally {
    await a.close()
    await b.close()
  }
})

test('nothing is logged: not the skills methods, not their errors', async () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  const spies = methods.map((name) => mock.method(console, name, () => {}))
  try {
    await withServer(async (server) => {
      await modern(server, 'skills/list')
      await modern(server, 'skills/list', { cursor: 'SECRET-CURSOR' })
      await modern(server, 'skills/get', {})
      await modern(server, 'skills/get', { uri: DEMO_SKILL_URIS[1] })
      await modern(server, 'skills/get', { uri: 'skill://SECRET/SKILL.md' })
      await modern(server, 'skills/get', { uri: 'not a uri' })
      await modern(server, 'resources/read', { uri: DEMO_SKILL_URIS[0] })
      await modern(server, 'resources/read', { uri: 'skill://demo/SECRET.md' })
      await modern(server, 'resources/directory/read', { uri: 'skill://demo/trip-planning' })
      await legacy(server, { jsonrpc: '2.0', id: 1, method: 'skills/list', params: {} })
      await server.fetch(new Request(URL_ON_SITE, { method: 'GET' }))
    })
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0)
  } finally {
    for (const spy of spies) spy.mock.restore()
  }
})
