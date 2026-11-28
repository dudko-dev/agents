// A tool's `outputSchema` where code generation from strings is forbidden (Cloudflare Workers;
// here `node --disallow-code-generation-from-strings`): Ajv compiles a schema to code and would be
// refused - every structured tool would fail as having "an invalid outputSchema". The connector
// takes the SDK's code-free validator there (`newOutputSchemaValidator`), with the same result:
// a value that follows the schema is passed on, one that breaks it gets the note.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { startLocalMcpServer, type ILocalMcpServer } from '@dudko.dev/test-servers'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import { codeGenerationAllowed, newOutputSchemaValidator } from '../src/mcp.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-output-schema-codegen.ts', import.meta.url))

const REPORT = { city: 'Lisbon', temperature: 21, tags: ['mild', 'clear'] }

// Not spawnSync: the servers answer from this process's event loop.
const spawnAsync = (cmd: string, args: string[]) =>
  new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
    p.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
    p.on('exit', (status) => resolve({ stdout, stderr, status }))
  })

const runChild = async (flags: string[]) => {
  const ok: ILocalMcpServer = await startLocalMcpServer({ structuredTools: true })
  const bad: ILocalMcpServer = await startLocalMcpServer({ structuredTools: true })
  bad.structuredFaults.result = 'mismatch'
  try {
    const child = await spawnAsync(process.execPath, [
      ...flags,
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      FIXTURE,
      ok.url,
      bad.url,
    ])
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout.trim().split('\n').at(-1)!) as {
      codeGeneration: boolean
      result: { ok?: unknown; error?: string }
      mismatch: { ok?: { note?: string; structuredContent?: unknown }; error?: string }
    }
  } finally {
    await ok.close()
    await bad.close()
  }
}

test('the validator: Ajv where code can be generated, the code-free one where it cannot', () => {
  assert.equal(codeGenerationAllowed(), true, 'Node as it ships generates code')
  assert.ok(newOutputSchemaValidator() instanceof AjvJsonSchemaValidator)
  assert.ok(newOutputSchemaValidator(false) instanceof CfWorkerJsonSchemaValidator)
  // The code-free one checks what Ajv checks.
  const v = newOutputSchemaValidator(false).getValidator({
    type: 'object',
    properties: { temperature: { type: 'number' } },
    required: ['temperature'],
  })
  assert.equal(v({ temperature: 21 }).valid, true)
  assert.equal(v({ temperature: 'warm' }).valid, false)
})

test('code generation forbidden: a structured tool is called and checked, not refused', async () => {
  const out = await runChild(['--disallow-code-generation-from-strings'])
  assert.equal(out.codeGeneration, false)
  assert.equal(out.result.error, undefined, out.result.error)
  assert.deepEqual(out.result.ok, REPORT)
  assert.match(String(out.mismatch.ok?.note), /does not follow the output schema/)
  assert.deepEqual(out.mismatch.ok?.structuredContent, { ...REPORT, temperature: 'warm' })
})

test('code generation allowed: the same answers on Ajv', async () => {
  const out = await runChild([])
  assert.equal(out.codeGeneration, true)
  assert.deepEqual(out.result.ok, REPORT)
  assert.match(String(out.mismatch.ok?.note), /does not follow the output schema/)
})
