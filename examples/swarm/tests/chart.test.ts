// The Helm chart (deploy/helm/agent-swarm) without helm: its values schema takes the default and
// the every-flag-on values and refuses what must not deploy, and every variable its ConfigMaps
// set is one the app reads (a typo there would be ignored without a word). helm lint / template
// and kubeconform run in swarm.yml.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Ajv } from 'ajv'
import { parse } from 'yaml'

const chart = new URL('../deploy/helm/agent-swarm/', import.meta.url)
const read = (path: string): Promise<string> => readFile(new URL(path, chart), 'utf8')

const validator = async () => {
  const schema = JSON.parse(await read('values.schema.json')) as object
  return new Ajv({ allErrors: true, strict: false }).compile(schema)
}

const defaults = async (): Promise<Record<string, unknown>> =>
  parse(await read('values.yaml')) as Record<string, unknown>

// A deep copy of `base` with `path` (a.b.c) set to `value`.
const withValue = (base: Record<string, unknown>, path: string, value: unknown) => {
  const copy = structuredClone(base)
  const keys = path.split('.')
  let at = copy as Record<string, unknown>
  for (const k of keys.slice(0, -1)) {
    at[k] ??= {}
    at = at[k] as Record<string, unknown>
  }
  at[keys.at(-1)!] = value
  return copy
}

test('the values schema takes the defaults and the every-flag-on values', async () => {
  const validate = await validator()
  const base = await defaults()
  assert.ok(validate(base), JSON.stringify(validate.errors))
  // Helm merges the CI file over the defaults.
  const allOn = parse(await read('ci/all-on-values.yaml')) as Record<string, unknown>
  const merged = structuredClone(base)
  const merge = (into: Record<string, unknown>, from: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(from)) {
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        into[k] &&
        typeof into[k] === 'object'
      ) {
        merge(into[k] as Record<string, unknown>, v as Record<string, unknown>)
      } else {
        into[k] = v
      }
    }
  }
  merge(merged, allOn)
  assert.ok(validate(merged), JSON.stringify(validate.errors))
})

const pipelineDef = { version: 1, entry: 'a', nodes: [{ id: 'a' }], edges: [] }

test('the values schema refuses what must not deploy', async () => {
  const validate = await validator()
  const base = await defaults()
  for (const [path, value] of [
    ['podSecurityContext.runAsNonRoot', false],
    ['securityContext.readOnlyRootFilesystem', false],
    ['securityContext.allowPrivilegeEscalation', true],
    ['securityContext.privileged', true],
    ['agent.toolApproval', 'yolo'],
    ['agent.providerType', 'xai'],
    ['gateway.auth', 'open'],
    ['temporal.address', 'no-port'],
    ['image.digest', 'latest'],
    ['session.subagentMaxPerRound', 0],
    ['session.subagentMaxPerRound', 65],
    ['worker.leaseTtlMs', 500],
    ['worker.autoscaling.keda.queueTypes', 'everything'],
    ['agent.subagents', { 'Bad Name': { description: 'x' } }],
    ['agent.subagents', { researcher: {} }],
    ['session.pipelineMaxPerRound', 0],
    ['session.pipelineMaxPerRound', 65],
    ['session.pipelineMaxPerSession', -1],
    ['agent.pipelines', { 'Bad Name': { description: 'x', definition: pipelineDef } }],
    ['agent.pipelines', { review: { definition: pipelineDef } }],
    ['agent.pipelines', { review: { description: 'x' } }],
    ['agent.pipelines', { review: { description: 'x', definition: pipelineDef, tools: [] } }],
    [
      'agent.pipelines',
      { review: { description: 'x', definition: { ...pipelineDef, version: 2 } } },
    ],
    [
      'agent.pipelines',
      { review: { description: 'x', definition: { ...pipelineDef, nodes: [{ id: 'a.b' }] } } },
    ],
    [
      'agent.pipelines',
      {
        review: {
          description: 'x',
          definition: { ...pipelineDef, nodes: [{ id: 'a', skills: ['s'] }] },
        },
      },
    ],
    [
      'agent.pipelines',
      {
        review: {
          description: 'x',
          definition: { ...pipelineDef, nodes: [{ id: 'a', settings: { t: 1 } }] },
        },
      },
    ],
    [
      'agent.pipelines',
      { review: { description: 'x', definition: { ...pipelineDef, limits: { maxRuns: 0 } } } },
    ],
    ['agent.extra', { lower_case: 'x' }],
    ['secrets.databaseUrl', { name: '', key: 'database-url' }],
    ['tmp.sizeLimit', 'lots'],
    ['nope', true],
  ] as const) {
    assert.equal(
      validate(withValue(base, path, value)),
      false,
      `${path} = ${JSON.stringify(value)}`,
    )
  }
  // The bundled Temporal chart's own values pass through.
  assert.ok(validate(withValue(base, 'temporal.server', { replicaCount: 1 })))
  // A pipeline the app takes passes; so does one given as a JSON string.
  assert.ok(
    validate(
      withValue(base, 'agent.pipelines', { review: { description: 'x', definition: pipelineDef } }),
    ),
    JSON.stringify(validate.errors),
  )
  assert.ok(validate(withValue(base, 'agent.pipelines', '{"review":{}}')))
})

test("every variable the chart's ConfigMaps set is one the app reads", async () => {
  const template = await read('templates/configmap.yaml')
  const names = [...template.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!)
  assert.ok(names.length > 30, `found ${names.length}`)
  const src = new URL('../src/', import.meta.url)
  const code = (
    await Promise.all(
      ['config.ts', 'agent-config.ts', 'env.ts', 'log.ts'].map((f) =>
        readFile(new URL(f, src), 'utf8'),
      ),
    )
  ).join('\n')
  const unread = names.filter((n) => !code.includes(`'${n}'`))
  assert.deepEqual(unread, [], 'set by the chart, read by nobody')
  // And the secrets go as files: the chart never puts a secret's value in a ConfigMap.
  for (const secret of ['DATABASE_URL', 'GATEWAY_TOKENS', 'AGENT_API_KEY', 'TEMPORAL_API_KEY']) {
    assert.ok(!names.includes(secret), secret)
  }
  const helpers = await read('templates/_helpers.tpl')
  for (const file of [
    'DATABASE_URL_FILE',
    'MIGRATE_DATABASE_URL_FILE',
    'GATEWAY_TOKENS_FILE',
    'AGENT_API_KEY_FILE',
    'TEMPORAL_API_KEY_FILE',
  ]) {
    assert.match(helpers, new RegExp(`"env" "${file}"`))
  }
})
