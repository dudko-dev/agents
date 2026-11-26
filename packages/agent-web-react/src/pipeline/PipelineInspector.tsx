import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import {
  PIPELINE_LIMITS,
  type PipelineCondition,
  type PipelineDefinition,
  type PipelineEdge,
  type PipelineNode,
} from '@dudko.dev/agent-web'
import { PlusIcon, XIcon } from '../components/icons.js'
import {
  removeEdge,
  removeNode,
  renameNode,
  renameRoute,
  setEntry,
  setLimits,
  setPipelineName,
  updateEdge,
  updateNode,
  type PipelineSelection,
} from './edit.js'
import { TrashIcon } from './icons.js'
import { usePipelineLabels, type PipelineLabels, type PipelineLabelsOverride } from './labels.js'

/** Something a node may name: a model, a skill, a group of tools, an MCP server. */
export interface PipelineOption {
  /** The name written into the definition. */
  id: string
  /** What the person sees (default: the id). */
  label?: string
  description?: string
}

export interface PipelineInspectorProps {
  value: PipelineDefinition
  onChange: (next: PipelineDefinition) => void
  selection: PipelineSelection
  onSelectionChange?: (selection: PipelineSelection) => void
  /** What the host can resolve; a node picks from these. */
  models?: PipelineOption[]
  skills?: PipelineOption[]
  tools?: PipelineOption[]
  mcpServers?: PipelineOption[]
  readOnly?: boolean
  /** Under the fields of whatever is selected. */
  footer?: ReactNode
  labels?: PipelineLabelsOverride
}

type ConditionKind = PipelineCondition['kind']
const KINDS: ConditionKind[] = ['always', 'contains', 'matches', 'route', 'otherwise']

const edgeIdAt = (definition: PipelineDefinition, edge: PipelineEdge): string =>
  edge.id ?? `e${definition.edges.indexOf(edge)}`

const Field = ({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: (id: string, describedBy: string | undefined) => ReactNode
}) => {
  const id = useId()
  const noteId = `${id}-note`
  return (
    <div className="awr-pfield">
      <label className="awr-pfield__label" htmlFor={id}>
        {label}
      </label>
      {children(id, hint || error ? noteId : undefined)}
      {(error || hint) && (
        <p id={noteId} className={`awr-pfield__hint${error ? ' awr-pfield__hint--error' : ''}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  )
}

const Choices = ({
  label,
  options,
  value,
  onChange,
  disabled,
  L,
}: {
  label: string
  options: PipelineOption[] | undefined
  value: string[]
  onChange: (next: string[]) => void
  disabled: boolean
  L: PipelineLabels
}) => {
  const known = options ?? []
  const all: PipelineOption[] = [
    ...known,
    ...value
      .filter((id) => !known.some((o) => o.id === id))
      .map((id) => ({ id, label: L.unknownOption(id) })),
  ]
  return (
    <fieldset className="awr-pfield awr-pfield--choices">
      <legend className="awr-pfield__label">{label}</legend>
      {all.length === 0 ? (
        <p className="awr-pfield__hint">{L.noOptions}</p>
      ) : (
        <div className="awr-pchips">
          {all.map((option) => {
            const on = value.includes(option.id)
            return (
              <label
                key={option.id}
                className={`awr-pchip${on ? ' awr-pchip--on' : ''}`}
                title={option.description}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  onChange={() =>
                    onChange(on ? value.filter((v) => v !== option.id) : [...value, option.id])
                  }
                />
                <span>{option.label ?? option.id}</span>
              </label>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}

const NodeForm = ({
  node,
  props,
  L,
}: {
  node: PipelineNode
  props: PipelineInspectorProps
  L: PipelineLabels
}) => {
  const { value, onChange, readOnly = false } = props
  const patch = (p: Partial<Omit<PipelineNode, 'id'>>) => onChange(updateNode(value, node.id, p))
  // The id is typed into a draft: half an id may be another node's.
  const [idDraft, setIdDraft] = useState(node.id)
  useEffect(() => setIdDraft(node.id), [node.id])
  const idClean = idDraft.trim()
  const idError = !idClean
    ? L.idEmpty
    : idClean !== node.id && value.nodes.some((n) => n.id === idClean)
      ? L.idTaken
      : undefined
  const commitId = () => {
    if (idError || idClean === node.id) {
      setIdDraft(node.id)
      return
    }
    const next = renameNode(value, node.id, idClean)
    onChange(next)
    props.onSelectionChange?.({ kind: 'node', id: idClean })
  }
  const routes = node.routes ?? []
  const models = props.models ?? []
  const isEntry = value.entry === node.id
  const freeRoute = (): string => {
    for (let n = routes.length + 1; ; n++) {
      if (!routes.some((r) => r.label === `route-${n}`)) return `route-${n}`
    }
  }
  return (
    <>
      <Field label={L.fieldName}>
        {(id) => (
          <input
            id={id}
            className="awr-pinput"
            value={node.name ?? ''}
            placeholder={node.id}
            readOnly={readOnly}
            data-awr-first-field=""
            onChange={(e) => patch({ name: e.target.value })}
          />
        )}
      </Field>
      <Field label={L.fieldId} hint={L.fieldIdHint} error={idError}>
        {(id, describedBy) => (
          <input
            id={id}
            className="awr-pinput awr-pinput--mono"
            value={idDraft}
            readOnly={readOnly}
            spellCheck={false}
            aria-invalid={Boolean(idError)}
            aria-describedby={describedBy}
            onChange={(e) => setIdDraft(e.target.value)}
            onBlur={commitId}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitId()
            }}
          />
        )}
      </Field>
      <Field label={L.fieldInstructions}>
        {(id) => (
          <textarea
            id={id}
            className="awr-pinput awr-pinput--area"
            rows={5}
            value={node.instructions ?? ''}
            placeholder={L.instructionsPlaceholder}
            readOnly={readOnly}
            onChange={(e) => patch({ instructions: e.target.value })}
          />
        )}
      </Field>
      <Field label={L.fieldModel}>
        {(id) => (
          <select
            id={id}
            className="awr-pinput"
            value={node.model ?? ''}
            disabled={readOnly}
            onChange={(e) => patch({ model: e.target.value || undefined })}
          >
            <option value="">{L.defaultModel}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
            {node.model && !models.some((m) => m.id === node.model) && (
              <option value={node.model}>{L.unknownOption(node.model)}</option>
            )}
          </select>
        )}
      </Field>
      <Choices
        label={L.fieldSkills}
        options={props.skills}
        value={node.skills ?? []}
        onChange={(skills) => patch({ skills })}
        disabled={readOnly}
        L={L}
      />
      <Choices
        label={L.fieldTools}
        options={props.tools}
        value={node.tools ?? []}
        onChange={(tools) => patch({ tools })}
        disabled={readOnly}
        L={L}
      />
      <Choices
        label={L.fieldMcp}
        options={props.mcpServers}
        value={node.mcpServers ?? []}
        onChange={(mcpServers) => patch({ mcpServers })}
        disabled={readOnly}
        L={L}
      />
      <fieldset className="awr-pfield awr-pfield--routes">
        <legend className="awr-pfield__label">{L.fieldRoutes}</legend>
        <p className="awr-pfield__hint">{L.routesHint}</p>
        {routes.map((route, index) => (
          <div key={index} className="awr-proute">
            <input
              className="awr-pinput awr-pinput--mono"
              value={route.label}
              aria-label={L.routeLabel}
              placeholder={L.routeLabel}
              readOnly={readOnly}
              spellCheck={false}
              onChange={(e) => onChange(renameRoute(value, node.id, route.label, e.target.value))}
            />
            <input
              className="awr-pinput"
              value={route.description ?? ''}
              aria-label={L.routeDescription}
              placeholder={L.routeDescription}
              readOnly={readOnly}
              onChange={(e) =>
                patch({
                  routes: routes.map((r, i) => {
                    if (i !== index) return r
                    const { description, ...rest } = r
                    void description
                    return e.target.value ? { ...rest, description: e.target.value } : rest
                  }),
                })
              }
            />
            {!readOnly && (
              <button
                type="button"
                className="awr-pbtn awr-pbtn--icon"
                aria-label={L.removeRoute(route.label)}
                onClick={() => patch({ routes: routes.filter((_, i) => i !== index) })}
              >
                <XIcon size={14} />
              </button>
            )}
          </div>
        ))}
        {!readOnly && routes.length < PIPELINE_LIMITS.maxRoutes && (
          <button
            type="button"
            className="awr-pbtn"
            onClick={() => patch({ routes: [...routes, { label: freeRoute() }] })}
          >
            <PlusIcon size={14} />
            {L.addRoute}
          </button>
        )}
      </fieldset>
      <Field label={L.fieldJoin}>
        {(id) => (
          <select
            id={id}
            className="awr-pinput"
            value={node.join ?? 'all'}
            disabled={readOnly}
            onChange={(e) => patch({ join: e.target.value === 'any' ? 'any' : undefined })}
          >
            <option value="all">{L.joinAll}</option>
            <option value="any">{L.joinAny}</option>
          </select>
        )}
      </Field>
      <div className="awr-pinspector__actions">
        {isEntry ? (
          <p className="awr-pfield__hint">{L.isEntry}</p>
        ) : (
          !readOnly && (
            <button
              type="button"
              className="awr-pbtn"
              onClick={() => onChange(setEntry(value, node.id))}
            >
              {L.makeEntry}
            </button>
          )
        )}
        {!readOnly && (
          <button
            type="button"
            className="awr-pbtn awr-pbtn--danger"
            onClick={() => {
              onChange(removeNode(value, node.id))
              props.onSelectionChange?.(null)
            }}
          >
            <TrashIcon size={14} />
            {L.deleteNode}
          </button>
        )}
      </div>
    </>
  )
}

const EdgeForm = ({
  edge,
  props,
  L,
}: {
  edge: PipelineEdge
  props: PipelineInspectorProps
  L: PipelineLabels
}) => {
  const { value, onChange, readOnly = false } = props
  const id = edgeIdAt(value, edge)
  const nameOf = (nodeId: string) => value.nodes.find((n) => n.id === nodeId)?.name || nodeId
  const routes = value.nodes.find((n) => n.id === edge.from)?.routes ?? []
  const when: PipelineCondition = edge.when ?? { kind: 'always' }
  const set = (next: PipelineCondition) => onChange(updateEdge(value, id, { when: next }))
  const setKind = (kind: ConditionKind) => {
    if (kind === 'contains') set({ kind, text: '' })
    else if (kind === 'matches') set({ kind, pattern: '' })
    else if (kind === 'route') set({ kind, label: routes[0]?.label ?? '' })
    else set({ kind })
  }
  return (
    <>
      <p className="awr-pinspector__ends">{L.edgeEnds(nameOf(edge.from), nameOf(edge.to))}</p>
      <Field label={L.fieldCondition} hint={L.conditionHints[when.kind]}>
        {(fieldId, describedBy) => (
          <select
            id={fieldId}
            className="awr-pinput"
            value={when.kind}
            disabled={readOnly}
            aria-describedby={describedBy}
            data-awr-first-field=""
            onChange={(e) => setKind(e.target.value as ConditionKind)}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {L.conditionKinds[kind]}
              </option>
            ))}
          </select>
        )}
      </Field>
      {when.kind === 'contains' && (
        <>
          <Field label={L.fieldText}>
            {(fieldId) => (
              <input
                id={fieldId}
                className="awr-pinput"
                value={when.text}
                readOnly={readOnly}
                onChange={(e) => set({ ...when, text: e.target.value })}
              />
            )}
          </Field>
          <label className="awr-pcheck">
            <input
              type="checkbox"
              checked={when.caseSensitive === true}
              disabled={readOnly}
              onChange={(e) => {
                const { caseSensitive, ...rest } = when
                void caseSensitive
                set(e.target.checked ? { ...rest, caseSensitive: true } : rest)
              }}
            />
            <span>{L.caseSensitive}</span>
          </label>
        </>
      )}
      {when.kind === 'matches' && (
        <div className="awr-pfield-row">
          <Field label={L.fieldPattern}>
            {(fieldId) => (
              <input
                id={fieldId}
                className="awr-pinput awr-pinput--mono"
                value={when.pattern}
                readOnly={readOnly}
                spellCheck={false}
                onChange={(e) => set({ ...when, pattern: e.target.value })}
              />
            )}
          </Field>
          <Field label={L.fieldFlags}>
            {(fieldId) => (
              <input
                id={fieldId}
                className="awr-pinput awr-pinput--mono awr-pinput--short"
                value={when.flags ?? ''}
                placeholder="imsu"
                readOnly={readOnly}
                spellCheck={false}
                maxLength={4}
                onChange={(e) => {
                  const { flags, ...rest } = when
                  void flags
                  set(e.target.value ? { ...rest, flags: e.target.value } : rest)
                }}
              />
            )}
          </Field>
        </div>
      )}
      {when.kind === 'route' &&
        (routes.length === 0 ? (
          <p className="awr-pfield__hint awr-pfield__hint--error">{L.noRoutes}</p>
        ) : (
          <Field label={L.fieldRoute}>
            {(fieldId) => (
              <select
                id={fieldId}
                className="awr-pinput"
                value={when.label}
                disabled={readOnly}
                onChange={(e) => set({ kind: 'route', label: e.target.value })}
              >
                {!routes.some((r) => r.label === when.label) && (
                  <option value={when.label}>{L.unknownOption(when.label)}</option>
                )}
                {routes.map((r) => (
                  <option key={r.label} value={r.label}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ))}
      {!readOnly && (
        <div className="awr-pinspector__actions">
          <button
            type="button"
            className="awr-pbtn awr-pbtn--danger"
            onClick={() => {
              onChange(removeEdge(value, id))
              props.onSelectionChange?.(null)
            }}
          >
            <TrashIcon size={14} />
            {L.deleteEdge}
          </button>
        </div>
      )}
    </>
  )
}

const LimitField = ({
  label,
  value,
  fallback,
  max,
  readOnly,
  onChange,
  L,
}: {
  label: string
  value: number | undefined
  fallback: number
  max: number
  readOnly: boolean
  onChange: (next: number | undefined) => void
  L: PipelineLabels
}) => (
  <Field label={label}>
    {(id) => (
      <input
        id={id}
        className="awr-pinput"
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        value={value ?? ''}
        placeholder={L.limitDefault(fallback)}
        readOnly={readOnly}
        onChange={(e) => {
          const n = e.target.value === '' ? undefined : Number(e.target.value)
          onChange(n === undefined || Number.isNaN(n) ? undefined : n)
        }}
      />
    )}
  </Field>
)

const PipelineForm = ({ props, L }: { props: PipelineInspectorProps; L: PipelineLabels }) => {
  const { value, onChange, readOnly = false } = props
  return (
    <>
      <Field label={L.pipelineName}>
        {(id) => (
          <input
            id={id}
            className="awr-pinput"
            value={value.name ?? ''}
            placeholder={L.pipelineNamePlaceholder}
            readOnly={readOnly}
            data-awr-first-field=""
            onChange={(e) => onChange(setPipelineName(value, e.target.value))}
          />
        )}
      </Field>
      <Field label={L.fieldEntry}>
        {(id) => (
          <select
            id={id}
            className="awr-pinput"
            value={value.entry}
            disabled={readOnly}
            onChange={(e) => onChange(setEntry(value, e.target.value))}
          >
            {!value.nodes.some((n) => n.id === value.entry) && <option value={value.entry} />}
            {value.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name || n.id}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="awr-pfield-row">
        <LimitField
          label={L.fieldMaxNodeVisits}
          value={value.limits?.maxNodeVisits}
          fallback={PIPELINE_LIMITS.maxNodeVisits}
          max={PIPELINE_LIMITS.maxNodeVisitsCeiling}
          readOnly={readOnly}
          onChange={(maxNodeVisits) => onChange(setLimits(value, { maxNodeVisits }))}
          L={L}
        />
        <LimitField
          label={L.fieldMaxRuns}
          value={value.limits?.maxRuns}
          fallback={PIPELINE_LIMITS.maxRuns}
          max={PIPELINE_LIMITS.maxRunsCeiling}
          readOnly={readOnly}
          onChange={(maxRuns) => onChange(setLimits(value, { maxRuns }))}
          L={L}
        />
      </div>
      <p className="awr-pfield__hint">{L.counts(value.nodes.length, value.edges.length)}</p>
    </>
  )
}

/** What the inspector is showing, for a heading: the kind and the name. */
export const inspectorTitle = (
  value: PipelineDefinition,
  selection: PipelineSelection,
  labels: PipelineLabels,
): { kind: string; name: string } => {
  if (selection?.kind === 'node') {
    const node = value.nodes.find((n) => n.id === selection.id)
    if (node) return { kind: labels.inspectorNode, name: node.name || node.id }
  }
  if (selection?.kind === 'edge') {
    const edge = value.edges.find((e) => edgeIdAt(value, e) === selection.id)
    const nameOf = (id: string) => value.nodes.find((n) => n.id === id)?.name || id
    if (edge) {
      return {
        kind: labels.inspectorEdge,
        name: labels.edgeEnds(nameOf(edge.from), nameOf(edge.to)),
      }
    }
  }
  return { kind: labels.inspectorPipeline, name: value.name || labels.pipelineNamePlaceholder }
}

/**
 * The fields of whatever is selected: a node, a connection, or - with nothing selected - the
 * pipeline itself. Controlled: every edit goes out through `onChange` as a new definition.
 */
export const PipelineInspector = (props: PipelineInspectorProps) => {
  const L = usePipelineLabels(props.labels)
  const { value, selection } = props
  const node =
    selection?.kind === 'node' ? value.nodes.find((n) => n.id === selection.id) : undefined
  const edge =
    selection?.kind === 'edge'
      ? value.edges.find((e) => edgeIdAt(value, e) === selection.id)
      : undefined
  return (
    <div className="awr-pinspector">
      {node ? (
        <NodeForm node={node} props={props} L={L} />
      ) : edge ? (
        <EdgeForm edge={edge} props={props} L={L} />
      ) : (
        <PipelineForm props={props} L={L} />
      )}
      {props.footer}
    </div>
  )
}
