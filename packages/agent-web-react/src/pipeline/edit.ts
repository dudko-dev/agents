import { normalizePipeline } from '@dudko.dev/agent-web'
import type {
  PipelineCondition,
  PipelineDefinition,
  PipelineEdge,
  PipelineIssue,
  PipelineNode,
} from '@dudko.dev/agent-web'

// Editing a pipeline definition: pure functions from a definition to a new one. They keep the
// graph consistent (an edge never points at a node that is gone, the entry always names a node
// while there is one) and return the SAME object when there is nothing to change, so a caller
// can tell by identity.

export type PipelineSelection = { kind: 'node' | 'edge'; id: string } | null

/** A definition to start from: one node, which is the entry. */
export const emptyPipeline = (): PipelineDefinition => ({
  version: 1,
  entry: 'agent',
  nodes: [{ id: 'agent', name: 'Agent', position: { x: 0, y: 0 } }],
  edges: [],
})

/**
 * The definition with an id on every edge. The runner hands ids out by position (`e0`, `e1`, …),
 * which shift when an edge is removed - an editor needs them fixed, so it writes them down.
 */
export const ensureEdgeIds = (definition: PipelineDefinition): PipelineDefinition =>
  definition.edges.every((e) => typeof e.id === 'string' && e.id.length > 0)
    ? definition
    : normalizePipeline(definition)

const unique = (taken: Set<string>, base: string): string => {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }
}

/** "Fact checker!" → "fact-checker". */
export const slugifyId = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

/** An id no node has: `base`, or `base-2`, `base-3`, … */
export const uniqueNodeId = (definition: PipelineDefinition, base = 'node'): string =>
  unique(new Set(definition.nodes.map((n) => n.id)), slugifyId(base) || 'node')

/** An id no edge has (`e0`, `e1`, …; the positional ids of unnamed edges count as taken). */
export const uniqueEdgeId = (definition: PipelineDefinition): string => {
  const taken = new Set(definition.edges.map((e, i) => e.id ?? `e${i}`))
  for (let n = definition.edges.length; ; n++) {
    if (!taken.has(`e${n}`)) return `e${n}`
  }
}

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0)

// `patch` over `target`; a key set to nothing (undefined, '', [], {}) is removed, so a definition
// never collects empty fields.
const applyPatch = <T extends object>(target: T, patch: Partial<T>, keep: (keyof T)[]): T => {
  const out = { ...target } as Record<string, unknown>
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (isEmpty(value) && !keep.includes(key as keyof T)) {
      if (key in out) {
        delete out[key]
        changed = true
      }
    } else if (JSON.stringify(out[key]) !== JSON.stringify(value)) {
      out[key] = value
      changed = true
    }
  }
  return changed ? (out as T) : target
}

/**
 * Add a node. Without an id it gets a free one (from its name, or `node`); an id that is taken
 * is made unique. The first node of a pipeline becomes its entry.
 */
export const addNode = (
  definition: PipelineDefinition,
  node: Partial<PipelineNode> = {},
): PipelineDefinition => {
  const id = uniqueNodeId(definition, node.id || node.name || 'node')
  const nodes = [...definition.nodes, { ...node, id }]
  const hasEntry = definition.nodes.some((n) => n.id === definition.entry)
  return { ...definition, nodes, ...(hasEntry ? {} : { entry: id }) }
}

/** Change a node's fields (not its id: `renameNode`). An emptied field is removed. */
export const updateNode = (
  definition: PipelineDefinition,
  id: string,
  patch: Partial<Omit<PipelineNode, 'id'>>,
): PipelineDefinition => {
  const index = definition.nodes.findIndex((n) => n.id === id)
  if (index < 0) return definition
  const next = applyPatch(definition.nodes[index], patch as Partial<PipelineNode>, ['id'])
  if (next === definition.nodes[index]) return definition
  const nodes = [...definition.nodes]
  nodes[index] = next
  return { ...definition, nodes }
}

export const moveNode = (
  definition: PipelineDefinition,
  id: string,
  position: { x: number; y: number },
): PipelineDefinition =>
  updateNode(definition, id, { position: { x: Math.round(position.x), y: Math.round(position.y) } })

/** Remove a node and every edge that touches it. The entry moves to the first node left. */
export const removeNode = (definition: PipelineDefinition, id: string): PipelineDefinition => {
  if (!definition.nodes.some((n) => n.id === id)) return definition
  const nodes = definition.nodes.filter((n) => n.id !== id)
  return {
    ...definition,
    nodes,
    edges: definition.edges.filter((e) => e.from !== id && e.to !== id),
    entry: definition.entry === id ? (nodes[0]?.id ?? '') : definition.entry,
  }
}

/** Give a node another id; its edges and the entry follow. Refused when the id is empty or taken. */
export const renameNode = (
  definition: PipelineDefinition,
  id: string,
  nextId: string,
): PipelineDefinition => {
  const to = nextId.trim()
  if (!to || to === id) return definition
  if (!definition.nodes.some((n) => n.id === id)) return definition
  if (definition.nodes.some((n) => n.id === to)) return definition
  return {
    ...definition,
    nodes: definition.nodes.map((n) => (n.id === id ? { ...n, id: to } : n)),
    edges: definition.edges.map((e) =>
      e.from === id || e.to === id
        ? { ...e, from: e.from === id ? to : e.from, to: e.to === id ? to : e.to }
        : e,
    ),
    entry: definition.entry === id ? to : definition.entry,
  }
}

export const setEntry = (definition: PipelineDefinition, id: string): PipelineDefinition =>
  definition.entry === id || !definition.nodes.some((n) => n.id === id)
    ? definition
    : { ...definition, entry: id }

// `always` is what an edge without a condition means: keep the definition short.
const cleanCondition = (when: PipelineCondition | undefined): PipelineCondition | undefined =>
  !when || when.kind === 'always' ? undefined : when

const sameCondition = (a: PipelineCondition | undefined, b: PipelineCondition | undefined) =>
  JSON.stringify(cleanCondition(a) ?? null) === JSON.stringify(cleanCondition(b) ?? null)

/**
 * Connect two nodes. Refused when either does not exist, or when the same edge (the same ends
 * and the same condition) is already there. The edge gets a free id unless it brings one.
 */
export const addEdge = (
  definition: PipelineDefinition,
  edge: { from: string; to: string; when?: PipelineCondition; id?: string },
): PipelineDefinition => {
  const has = (id: string) => definition.nodes.some((n) => n.id === id)
  if (!has(edge.from) || !has(edge.to)) return definition
  const base = ensureEdgeIds(definition)
  if (
    base.edges.some(
      (e) => e.from === edge.from && e.to === edge.to && sameCondition(e.when, edge.when),
    )
  ) {
    return definition
  }
  const id = edge.id && !base.edges.some((e) => e.id === edge.id) ? edge.id : uniqueEdgeId(base)
  const when = cleanCondition(edge.when)
  const added: PipelineEdge = { id, from: edge.from, to: edge.to, ...(when ? { when } : {}) }
  return { ...base, edges: [...base.edges, added] }
}

const edgeIndex = (definition: PipelineDefinition, id: string): number =>
  definition.edges.findIndex((e, i) => (e.id ?? `e${i}`) === id)

/** Change an edge's condition or ends. An end that names no node is refused. */
export const updateEdge = (
  definition: PipelineDefinition,
  id: string,
  patch: { from?: string; to?: string; when?: PipelineCondition },
): PipelineDefinition => {
  const base = ensureEdgeIds(definition)
  const index = edgeIndex(base, id)
  if (index < 0) return definition
  const has = (nodeId: string) => base.nodes.some((n) => n.id === nodeId)
  if (
    (patch.from !== undefined && !has(patch.from)) ||
    (patch.to !== undefined && !has(patch.to))
  ) {
    return definition
  }
  const before = base.edges[index]
  const { when: was, ...ends } = before
  const when = cleanCondition('when' in patch ? patch.when : was)
  const next: PipelineEdge = {
    ...ends,
    ...(patch.from !== undefined ? { from: patch.from } : {}),
    ...(patch.to !== undefined ? { to: patch.to } : {}),
    ...(when ? { when } : {}),
  }
  if (JSON.stringify(next) === JSON.stringify(before)) return definition
  const edges = [...base.edges]
  edges[index] = next
  return { ...base, edges }
}

export const removeEdge = (definition: PipelineDefinition, id: string): PipelineDefinition => {
  const base = ensureEdgeIds(definition)
  const index = edgeIndex(base, id)
  if (index < 0) return definition
  return { ...base, edges: base.edges.filter((_, i) => i !== index) }
}

/** Rename one of a node's routes; the edges that take that route follow. */
export const renameRoute = (
  definition: PipelineDefinition,
  nodeId: string,
  label: string,
  nextLabel: string,
): PipelineDefinition => {
  const node = definition.nodes.find((n) => n.id === nodeId)
  if (!node?.routes?.some((r) => r.label === label) || label === nextLabel) return definition
  if (node.routes.some((r) => r.label === nextLabel)) return definition
  return {
    ...definition,
    nodes: definition.nodes.map((n) =>
      n.id === nodeId
        ? {
            ...n,
            routes: (n.routes ?? []).map((r) =>
              r.label === label ? { ...r, label: nextLabel } : r,
            ),
          }
        : n,
    ),
    edges: definition.edges.map((e) =>
      e.from === nodeId && e.when?.kind === 'route' && e.when.label === label
        ? { ...e, when: { kind: 'route', label: nextLabel } }
        : e,
    ),
  }
}

/** Set (a number) or clear (undefined) the limits; a definition with none has no `limits`. */
export const setLimits = (
  definition: PipelineDefinition,
  patch: { maxNodeVisits?: number; maxRuns?: number },
): PipelineDefinition => {
  const before = definition.limits ?? {}
  const limits = applyPatch(before, patch, [])
  if (limits === before) return definition
  const { limits: was, ...rest } = definition
  void was
  return Object.keys(limits).length > 0 ? { ...rest, limits } : rest
}

export const setPipelineName = (
  definition: PipelineDefinition,
  name: string,
): PipelineDefinition => {
  if ((definition.name ?? '') === name) return definition
  const { name: was, ...rest } = definition
  void was
  return name ? { ...rest, name } : rest
}

export interface AutoLayoutOptions {
  /** Distance between the left sides of two columns (default 320). */
  columnGap?: number
  /** Distance between the tops of two nodes of a column (default 170). */
  rowGap?: number
  /** Place every node, not only the ones without a position. */
  all?: boolean
}

/**
 * Give a position to the nodes that have none (a definition written by hand, or by a model):
 * columns by distance from the entry, left to right. Nodes the entry does not reach go last.
 */
export const autoLayout = (
  definition: PipelineDefinition,
  options: AutoLayoutOptions = {},
): PipelineDefinition => {
  const { columnGap = 320, rowGap = 170, all = false } = options
  const placed = (n: PipelineNode) =>
    !all && typeof n.position?.x === 'number' && typeof n.position?.y === 'number'
  if (definition.nodes.every(placed)) return definition
  const depth = new Map<string, number>()
  const ids = new Set(definition.nodes.map((n) => n.id))
  const walk = (start: string, from: number) => {
    const queue: string[] = [start]
    depth.set(start, from)
    while (queue.length) {
      const id = queue.shift() as string
      for (const edge of definition.edges) {
        if (edge.from === id && ids.has(edge.to) && !depth.has(edge.to)) {
          depth.set(edge.to, (depth.get(id) as number) + 1)
          queue.push(edge.to)
        }
      }
    }
  }
  if (ids.has(definition.entry)) walk(definition.entry, 0)
  for (const node of definition.nodes) {
    if (!depth.has(node.id)) walk(node.id, Math.max(-1, ...depth.values()) + 1)
  }
  const rows = new Map<number, number>()
  const columns = new Map<number, number>()
  for (const node of definition.nodes) {
    const d = depth.get(node.id) as number
    columns.set(d, (columns.get(d) ?? 0) + 1)
  }
  const tallest = Math.max(...columns.values())
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      const d = depth.get(node.id) as number
      const row = rows.get(d) ?? 0
      rows.set(d, row + 1)
      if (placed(node)) return node
      // Each column is centred on the tallest one.
      const offset = ((tallest - (columns.get(d) as number)) * rowGap) / 2
      return { ...node, position: { x: d * columnGap, y: Math.round(offset + row * rowGap) } }
    }),
  }
}

/** A free spot for a new node: to the right of the lowest node of the last column. */
export const nextNodePosition = (definition: PipelineDefinition): { x: number; y: number } => {
  const positions = definition.nodes.map((n) => n.position).filter(Boolean) as {
    x: number
    y: number
  }[]
  if (positions.length === 0) return { x: 0, y: 0 }
  const right = Math.max(...positions.map((p) => p.x))
  const bottom = Math.max(...positions.filter((p) => p.x === right).map((p) => p.y))
  return { x: right, y: bottom + 170 }
}

/** What a validation issue is about, as something to select. */
export const issueTarget = (
  issue: PipelineIssue,
  definition: PipelineDefinition,
): PipelineSelection => {
  if (issue.edgeId !== undefined || issue.edgeIndex !== undefined) {
    const index =
      issue.edgeIndex ?? definition.edges.findIndex((e, i) => (e.id ?? `e${i}`) === issue.edgeId)
    const edge = definition.edges[index]
    if (edge) return { kind: 'edge', id: edge.id ?? `e${index}` }
  }
  if (issue.nodeId !== undefined && definition.nodes.some((n) => n.id === issue.nodeId)) {
    return { kind: 'node', id: issue.nodeId }
  }
  return null
}

/**
 * Read a definition from text (an imported file, a paste). Throws with a plain message when the
 * text is not JSON or not the shape of a pipeline; a definition that parses but does not
 * validate is returned as it is, for the editor to show what is wrong with it.
 */
export const parsePipelineJson = (text: string): PipelineDefinition => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`not JSON: ${(err as Error).message}`)
  }
  const def = value as Partial<PipelineDefinition> | null
  if (typeof def !== 'object' || def === null || Array.isArray(def)) {
    throw new Error('a pipeline definition must be an object')
  }
  if (!Array.isArray(def.nodes) || !Array.isArray(def.edges)) {
    throw new Error('a pipeline definition needs `nodes` and `edges` arrays')
  }
  if (def.nodes.some((n) => typeof n !== 'object' || n === null || typeof n.id !== 'string')) {
    throw new Error('every node needs an `id`')
  }
  if (
    def.edges.some(
      (e) =>
        typeof e !== 'object' ||
        e === null ||
        typeof e.from !== 'string' ||
        typeof e.to !== 'string',
    )
  ) {
    throw new Error('every edge needs `from` and `to`')
  }
  return autoLayout(
    ensureEdgeIds({
      ...(def as PipelineDefinition),
      entry: typeof def.entry === 'string' ? def.entry : '',
    }),
  )
}
