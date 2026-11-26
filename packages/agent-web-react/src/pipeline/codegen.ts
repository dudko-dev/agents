import type { PipelineDefinition } from '@dudko.dev/agent-web'

// "Copy as code": a definition as a program that runs it. Pure text in, text out.

export type PipelineCodeTarget = 'browser' | 'node'

export interface PipelineCodeOptions {
  /** `browser`: @dudko.dev/agent-web. `node`: @dudko.dev/agent. */
  target?: PipelineCodeTarget
  /** Keep the nodes' `position` (an editor's business; the runner ignores it). Default false. */
  positions?: boolean
  /** The request in the example call. */
  input?: string
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// "fact-checker" + "Tools" → factCheckerTools: a name for the value the host supplies.
const identifier = (name: string, suffix: string, taken: Set<string>): string => {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  let base = words
    .map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + w.slice(1))
    .join('')
  if (!base || /^[0-9]/.test(base)) base = `x${base}`
  base += suffix
  let out = base
  for (let n = 2; taken.has(out); n++) out = `${base}${n}`
  taken.add(out)
  return out
}

const namesOf = (
  definition: PipelineDefinition,
  field: 'skills' | 'tools' | 'mcpServers',
): string[] => [...new Set(definition.nodes.flatMap((n) => n[field] ?? []))]

const quote = (text: string): string =>
  `'${text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`

const key = (name: string): string => (IDENTIFIER.test(name) ? name : quote(name))

// JSON, written the way the code around it is: unquoted keys, single quotes.
const literal = (value: unknown, indent = ''): string => {
  const inner = `${indent}  `
  if (typeof value === 'string') return quote(value)
  if (value === null || typeof value !== 'object') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const flat = `[${value.map((v) => literal(v, inner)).join(', ')}]`
    if (flat.length + indent.length <= 80 && !flat.includes('\n')) return flat
    return `[\n${value.map((v) => `${inner}${literal(v, inner)},`).join('\n')}\n${indent}]`
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return '{}'
  const flat = `{ ${entries.map(([k, v]) => `${key(k)}: ${literal(v, inner)}`).join(', ')} }`
  if (flat.length + indent.length <= 80 && !flat.includes('\n')) return flat
  return `{\n${entries.map(([k, v]) => `${inner}${key(k)}: ${literal(v, inner)},`).join('\n')}\n${indent}}`
}

const registry = (
  field: string,
  names: string[],
  suffix: string,
  taken: Set<string>,
  note: string,
): string | undefined =>
  names.length === 0
    ? undefined
    : `    ${field}: { ${names.map((n) => `${key(n)}: ${identifier(n, suffix, taken)}`).join(', ')} }, // ${note}`

/**
 * A snippet that runs the definition with the browser package or with the Node one. The names
 * the definition uses (models, skills, tool groups, MCP servers) appear as variables for the
 * host to supply: a definition never carries a model or a key.
 */
export const pipelineToCode = (
  definition: PipelineDefinition,
  options: PipelineCodeOptions = {},
): string => {
  const { target = 'browser', positions = false, input = 'Your request' } = options
  const browser = target === 'browser'
  const pkg = browser ? '@dudko.dev/agent-web' : '@dudko.dev/agent'
  const def: PipelineDefinition = positions
    ? definition
    : {
        ...definition,
        nodes: definition.nodes.map((n) => {
          const { position, ...rest } = n
          void position
          return rest
        }),
      }
  const taken = new Set(['definition', 'pipeline', 'result', 'config', 'model', 'credentials'])
  const models = [...new Set(definition.nodes.flatMap((n) => (n.model ? [n.model] : [])))]
  const registries = [
    registry(
      'models',
      models,
      'Model',
      taken,
      browser ? 'a LanguageModel or a ProviderModelSpec each' : 'a model spec each',
    ),
    registry('skills', namesOf(definition, 'skills'), 'Skill', taken, 'a Skill each'),
    registry('tools', namesOf(definition, 'tools'), 'Tools', taken, 'a named group of tools each'),
    registry(
      'mcpServers',
      namesOf(definition, 'mcpServers'),
      'Mcp',
      taken,
      browser ? 'a connectMcpHttp result each' : 'an MCP server config each',
    ),
  ].filter(Boolean)

  const lines = [
    `import { createPipeline, nodeResolver } from '${pkg}'`,
    `import type { PipelineDefinition } from '${pkg}'`,
    '',
    `const definition: PipelineDefinition = ${literal(def)}`,
    '',
    'const pipeline = createPipeline(definition, {',
    '  // What the names in the definition stand for. A name that is not here fails its node.',
    '  resolveNode: nodeResolver({',
    browser
      ? '    base: { model, credentials }, // a BrowserAgentConfig: every node starts from it'
      : '    base: config, // an IAgentConfig: every node starts from it',
    ...registries,
    '  }),',
    '})',
    '',
    'const result = await pipeline.run({',
    `  input: ${literal(input)},`,
    '  onEvent: (e) => {',
    "    if (e.type === 'pipeline.node.started') console.log('→', e.nodeId, `#${e.visit}`)",
    '  },',
    '})',
    'console.log(result.text)',
    ...(browser
      ? []
      : ['await pipeline.close() // closes the node agents (their MCP connections)']),
    '',
  ]
  return lines.join('\n')
}
