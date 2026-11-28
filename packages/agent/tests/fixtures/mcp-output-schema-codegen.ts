// A child process of tests/mcp-output-schema-codegen.test.ts: one call of a tool that declares an
// `outputSchema`, through the connector, then one call whose result breaks it - printed as one
// JSON line. Run with `--disallow-code-generation-from-strings` it is a runtime that forbids code
// generation, as workerd (Cloudflare Workers) does.
import { codeGenerationAllowed, connectMcpServers } from '../../src/mcp.ts'

const [url, mismatchUrl] = process.argv.slice(2)
const call = async (u: string): Promise<{ ok: unknown } | { error: string }> => {
  const mcp = await connectMcpServers({ docs: { url: u } }, () => {}, 'agent-test')
  try {
    const tool = mcp.tools.docs__report as { execute: (a: unknown, o: unknown) => Promise<unknown> }
    return { ok: await tool.execute({}, {}) }
  } catch (err) {
    return { error: (err as Error).message }
  } finally {
    await mcp.close()
  }
}
const result = await call(url!)
const mismatch = await call(mismatchUrl!)
console.log(JSON.stringify({ codeGeneration: codeGenerationAllowed(), result, mismatch }))
