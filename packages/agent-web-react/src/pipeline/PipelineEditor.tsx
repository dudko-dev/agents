import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  validatePipeline,
  type PipelineCondition,
  type PipelineDefinition,
  type PipelineIssue,
  type PipelineNode,
  type PipelineValidation,
} from '@dudko.dev/agent-web'
import {
  Canvas,
  type CanvasConnection,
  type CanvasEdge,
  type CanvasHandle,
  type CanvasNode,
} from '../canvas/Canvas.js'
import { screenToWorld, snapPoint } from '../canvas/geometry.js'
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  DownloadIcon,
  PlusIcon,
  StopIcon,
  XIcon,
} from '../components/icons.js'
import { formatTokens } from '../components/format.js'
import { errMessage } from '../util.js'
import { pipelineToCode, type PipelineCodeTarget } from './codegen.js'
import {
  addEdge,
  addNode,
  autoLayout,
  ensureEdgeIds,
  issueTarget,
  moveNode,
  parsePipelineJson,
  removeEdge,
  removeNode,
  slugifyId,
  uniqueNodeId,
  type PipelineSelection,
} from './edit.js'
import { CodeIcon, FitIcon, MinusIcon, PlayIcon, TrashIcon, UploadIcon } from './icons.js'
import { usePipelineLabels, type PipelineLabels, type PipelineLabelsOverride } from './labels.js'
import { inspectorTitle, PipelineInspector, type PipelineOption } from './PipelineInspector.js'
import { OUTPUT_PORT, PipelineNodeCard, routePortId } from './PipelineNodeCard.js'
import {
  createInitialPipelineState,
  pipelineNodeView,
  type PipelineNodeView,
  type PipelineUiState,
} from './state.js'

/** What the editor needs to run a pipeline and show the run: what `usePipeline` returns. */
export interface PipelineController extends PipelineUiState {
  run: (input: string) => Promise<unknown>
  stop: () => void
  isRunning: boolean
}

export interface PipelineEditorSlots {
  /** Before / after the toolbar's own buttons. */
  toolbarStart?: ReactNode
  toolbarEnd?: ReactNode
  /** Over the canvas (a legend, a watermark of your own). */
  canvas?: ReactNode
  /** Under the inspector's fields. */
  inspectorFooter?: ReactNode
  /** After the Run button. */
  runBarEnd?: ReactNode
  /** Under the results. */
  resultsFooter?: ReactNode
}

export interface PipelineNodeRenderContext {
  node: PipelineNode
  view: PipelineNodeView
  entry: boolean
  selected: boolean
  invalid: boolean
  /** The card the editor would draw. */
  card: ReactNode
}

export interface PipelineEditorProps {
  /** The definition. The editor never keeps its own copy: every edit goes out through `onChange`. */
  value: PipelineDefinition
  onChange: (next: PipelineDefinition) => void
  /** `usePipeline(...)`: adds Run / Stop, live statuses and the results. Without it: an editor only. */
  controller?: PipelineController
  /** What a node may name - the keys of the registries the host resolves. */
  models?: PipelineOption[]
  skills?: PipelineOption[]
  tools?: PipelineOption[]
  mcpServers?: PipelineOption[]
  /** Controlled selection (optional). */
  selection?: PipelineSelection
  onSelectionChange?: (selection: PipelineSelection) => void
  /** The request in the run bar (optional control). */
  input?: string
  onInputChange?: (input: string) => void
  /** Checks the definition (default: the core's `validatePipeline`). */
  validate?: (definition: PipelineDefinition) => PipelineValidation
  showToolbar?: boolean
  showInspector?: boolean
  showRunBar?: boolean
  showResults?: boolean
  showIssues?: boolean
  showImport?: boolean
  showExport?: boolean
  showCode?: boolean
  showZoom?: boolean
  showGrid?: boolean
  /** Grid step nodes snap to (default 20; 0 = no snapping). */
  snap?: number
  /** Look and run, but do not edit. */
  readOnly?: boolean
  /** Change it when another document is loaded: the canvas fits it. */
  fitKey?: string | number
  /** Under this width the inspector is a bottom sheet and the toolbar is icons (default 760). */
  narrowWidth?: number
  /** Replace the node card. */
  renderNode?: (ctx: PipelineNodeRenderContext) => ReactNode
  /** Render a node's output or the final answer (Markdown, say). Default: plain text. */
  renderContent?: (text: string) => ReactNode
  slots?: PipelineEditorSlots
  labels?: PipelineLabelsOverride
  /** Force a colour scheme (default: the system's). */
  theme?: 'light' | 'dark'
  className?: string
}

/** What an edge's condition reads as on the canvas ("" for an edge that always fires). */
export const conditionSummary = (
  when: PipelineCondition | undefined,
  labels: PipelineLabels,
): string => {
  switch (when?.kind) {
    case 'route':
      return when.label
    case 'contains':
      return `${labels.conditionKinds.contains} “${when.text}”`
    case 'matches':
      return `/${when.pattern}/${when.flags ?? ''}`
    case 'otherwise':
      return labels.conditionKinds.otherwise
    default:
      return ''
  }
}

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

export interface PipelineCodeDialogProps {
  definition: PipelineDefinition
  open: boolean
  onClose: () => void
  /** The request in the snippet's example call. */
  input?: string
  labels?: PipelineLabelsOverride
}

/** "Copy as code": the definition as a snippet for the browser package or for the Node one. */
export const PipelineCodeDialog = ({
  definition,
  open,
  onClose,
  input,
  labels: over,
}: PipelineCodeDialogProps) => {
  const L = usePipelineLabels(over)
  const ref = useRef<HTMLDialogElement>(null)
  const [target, setTarget] = useState<PipelineCodeTarget>('browser')
  const [copied, setCopied] = useState(false)
  const titleId = useId()
  const code = useMemo(
    () => (open ? pipelineToCode(definition, { target, ...(input ? { input } : {}) }) : ''),
    [open, definition, target, input],
  )
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])
  useEffect(() => setCopied(false), [code])
  return (
    <dialog
      ref={ref}
      className="awr-pcode"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {open && (
        <div className="awr-pcode__body">
          <div className="awr-pcode__head">
            <h2 id={titleId} className="awr-pcode__title">
              {L.codeTitle}
            </h2>
            <button
              type="button"
              className="awr-pbtn awr-pbtn--icon"
              aria-label={L.close}
              onClick={onClose}
            >
              <XIcon size={16} />
            </button>
          </div>
          <div className="awr-pcode__bar">
            <div className="awr-pseg" role="tablist" aria-label={L.codeTitle}>
              {(['browser', 'node'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={target === t}
                  className={`awr-pseg__item${target === t ? ' is-active' : ''}`}
                  onClick={() => setTarget(t)}
                >
                  {t === 'browser' ? L.codeBrowser : L.codeNode}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="awr-pbtn awr-pbtn--primary"
              onClick={() => void copyText(code).then(setCopied)}
            >
              {copied ? <CheckIcon size={14} /> : <CodeIcon size={14} />}
              <span aria-live="polite">{copied ? L.copied : L.copy}</span>
            </button>
          </div>
          <pre className="awr-pcode__pre" tabIndex={0}>
            <code>{code}</code>
          </pre>
        </div>
      )}
    </dialog>
  )
}

export interface PipelineResultsProps {
  /** The run: `usePipeline(...)`, or any `PipelineUiState`. */
  state: PipelineUiState
  /** For the names of the nodes. */
  definition: PipelineDefinition
  renderContent?: (text: string) => ReactNode
  footer?: ReactNode
  labels?: PipelineLabelsOverride
}

/** What a run produced: the final answer, and every node's output, visit by visit. */
export const PipelineResults = ({
  state,
  definition,
  renderContent,
  footer,
  labels: over,
}: PipelineResultsProps) => {
  const L = usePipelineLabels(over)
  const nameOf = (id: string) => definition.nodes.find((n) => n.id === id)?.name || id
  const render = (text: string) =>
    renderContent ? renderContent(text) : <div className="awr-presults__plain">{text}</div>
  return (
    <div className={`awr-presults awr-presults--${state.status}`}>
      <div className="awr-presults__summary">
        <span className={`awr-presults__status awr-presults__status--${state.status}`}>
          {L.runStatus[state.status]}
        </span>
        {state.runs > 0 && <span>{L.runsCount(state.runs)}</span>}
        {state.usage.totalTokens > 0 && (
          <span>
            {L.usage(formatTokens(state.usage.inputTokens), formatTokens(state.usage.outputTokens))}
          </span>
        )}
      </div>
      {state.error && (
        <p className="awr-presults__error" role="alert">
          {state.failedNode ? `${nameOf(state.failedNode)}: ` : ''}
          {state.error}
        </p>
      )}
      {state.stoppedBy && <p className="awr-presults__note">{L.stoppedBy[state.stoppedBy]}</p>}
      <div className="awr-presults__columns">
        <section className="awr-presults__final" aria-label={L.finalAnswer}>
          <h3 className="awr-presults__heading">{L.finalAnswer}</h3>
          {state.text ? (
            <div className="awr-presults__text">{render(state.text)}</div>
          ) : (
            <p className="awr-presults__empty">{L.noOutputYet}</p>
          )}
        </section>
        <section className="awr-presults__outputs" aria-label={L.nodeOutputs}>
          <h3 className="awr-presults__heading">{L.nodeOutputs}</h3>
          {state.visits.length === 0 ? (
            <p className="awr-presults__empty">{L.noOutputYet}</p>
          ) : (
            <ol className="awr-presults__visits">
              {state.visits.map((visit) => (
                <li key={`${visit.nodeId}#${visit.visit}`}>
                  <details className={`awr-pvisit awr-pvisit--${visit.status}`}>
                    <summary className="awr-pvisit__summary">
                      <span className="awr-pvisit__name">
                        {L.visitTitle(nameOf(visit.nodeId), visit.visit)}
                      </span>
                      {visit.route && (
                        <span className="awr-pvisit__route">{L.routeTaken(visit.route)}</span>
                      )}
                      <span className="awr-pvisit__status">
                        {
                          L.nodeStatus[
                            visit.status === 'stopped'
                              ? 'idle'
                              : (visit.status as 'running' | 'done' | 'failed')
                          ]
                        }
                      </span>
                    </summary>
                    {visit.from.length > 0 && (
                      <p className="awr-pvisit__from">
                        {L.receivedFrom(visit.from.map(nameOf).join(', '))}
                      </p>
                    )}
                    {visit.error && <p className="awr-presults__error">{visit.error}</p>}
                    {visit.text !== undefined && (
                      <div className="awr-presults__text">{render(visit.text)}</div>
                    )}
                  </details>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
      {footer}
    </div>
  )
}

export interface PipelineIssuesProps {
  validation: PipelineValidation
  /** An issue was picked: select what it is about. */
  onPick?: (issue: PipelineIssue) => void
  labels?: PipelineLabelsOverride
}

/** The definition's errors and warnings as a list; each one leads to its node or edge. */
export const PipelineIssues = ({ validation, onPick, labels: over }: PipelineIssuesProps) => {
  const L = usePipelineLabels(over)
  const rows = [
    ...validation.errors.map((issue) => ({ issue, error: true })),
    ...validation.warnings.map((issue) => ({ issue, error: false })),
  ]
  if (rows.length === 0) return <p className="awr-pissues__none">{L.noIssues}</p>
  return (
    <ul className="awr-pissues">
      {rows.map(({ issue, error }, index) => (
        <li key={index}>
          <button
            type="button"
            className={`awr-pissue awr-pissue--${error ? 'error' : 'warning'}`}
            onClick={() => onPick?.(issue)}
          >
            <span className="awr-pissue__kind">{error ? L.issueError : L.issueWarning}</span>
            <span className="awr-pissue__text">{issue.message}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

const IDLE = createInitialPipelineState()

/**
 * The pipeline editor: a canvas of nodes and connections, an inspector for what is selected, a
 * toolbar, and - with a `controller` - a run bar, live statuses and the results. Controlled:
 * `value` in, `onChange` out. Import `@dudko.dev/agent-web-react/pipeline.css` for its styles.
 */
export const PipelineEditor = (props: PipelineEditorProps) => {
  const {
    value,
    onChange,
    controller,
    showToolbar = true,
    showInspector = true,
    showRunBar = true,
    showResults = true,
    showIssues = true,
    showImport = true,
    showExport = true,
    showCode = true,
    showZoom = true,
    showGrid = true,
    snap = 20,
    readOnly = false,
    narrowWidth = 760,
    renderNode,
    renderContent,
    slots,
    theme,
    className,
  } = props
  const L = usePipelineLabels(props.labels)
  const state: PipelineUiState = controller ?? IDLE
  const validate = props.validate ?? validatePipeline

  // What is drawn: every edge has an id and every node a place. Edits start from this, so the
  // first edit of a definition written by hand also writes those down.
  const def = useMemo(() => autoLayout(ensureEdgeIds(value)), [value])
  const validation = useMemo(() => validate(def), [validate, def])
  const invalid = useMemo(() => {
    const nodes = new Set<string>()
    const edges = new Set<string>()
    for (const issue of validation.errors) {
      const target = issueTarget(issue, def)
      if (target?.kind === 'edge') edges.add(target.id)
      else if (target?.kind === 'node') nodes.add(target.id)
    }
    return { nodes, edges }
  }, [validation, def])

  // ── Selection ──────────────────────────────────────────────────────────────
  const [ownSelection, setOwnSelection] = useState<PipelineSelection>(null)
  const rawSelection = props.selection !== undefined ? props.selection : ownSelection
  // Whatever was selected may be gone (deleted, another document loaded).
  const selection = useMemo<PipelineSelection>(() => {
    if (!rawSelection) return null
    const exists =
      rawSelection.kind === 'node'
        ? def.nodes.some((n) => n.id === rawSelection.id)
        : def.edges.some((e) => e.id === rawSelection.id)
    return exists ? rawSelection : null
  }, [rawSelection, def])
  const { onSelectionChange } = props
  const select = useCallback(
    (next: PipelineSelection) => {
      setOwnSelection(next)
      onSelectionChange?.(next)
    },
    [onSelectionChange],
  )

  // ── Layout: wide (inspector beside) or narrow (inspector as a bottom sheet) ─
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<CanvasHandle>(null)
  const inspectorRef = useRef<HTMLDivElement>(null)
  // A first guess from the window, so that a phone does not draw the wide layout for a frame.
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < narrowWidth,
  )
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => setNarrow(el.getBoundingClientRect().width < narrowWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [narrowWidth])
  const [sheetOpen, setSheetOpen] = useState(false)
  const [issuesOpen, setIssuesOpen] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(true)
  const [notice, setNotice] = useState<string | undefined>()
  const [ownInput, setOwnInput] = useState('')
  const input = props.input ?? ownInput
  const setInput = (text: string) => {
    setOwnInput(text)
    props.onInputChange?.(text)
  }
  const [loads, setLoads] = useState(0)

  const focusFields = useRef(false)
  const openInspector = useCallback(
    (target: PipelineSelection) => {
      select(target)
      setSheetOpen(true)
      focusFields.current = true
    },
    [select],
  )
  useEffect(() => {
    if (!focusFields.current) return
    focusFields.current = false
    inspectorRef.current?.querySelector<HTMLElement>('[data-awr-first-field]')?.focus()
  })

  const pendingFocus = useRef<string | undefined>(undefined)
  useEffect(() => {
    const id = pendingFocus.current
    if (!id || !def.nodes.some((n) => n.id === id)) return
    pendingFocus.current = undefined
    canvasRef.current?.focus({ kind: 'node', id })
  })

  // ── What the canvas draws ──────────────────────────────────────────────────
  const canvasNodes = useMemo<CanvasNode[]>(
    () =>
      def.nodes.map((node) => {
        const view = pipelineNodeView(state, node.id)
        const routes = node.routes ?? []
        return {
          id: node.id,
          x: node.position?.x ?? 0,
          y: node.position?.y ?? 0,
          label: node.name || node.id,
          description: [
            def.entry === node.id ? `${L.entry}.` : '',
            L.nodeDescription(L.nodeStatus[view.status], view.visits),
          ]
            .filter(Boolean)
            .join(' '),
          ...(routes.length > 0
            ? {
                ports: [
                  { id: OUTPUT_PORT, label: L.anyOutput },
                  ...routes.map((r) => ({ id: routePortId(r.label), label: r.label })),
                ],
              }
            : {}),
        }
      }),
    [def, state, L],
  )
  const canvasEdges = useMemo<CanvasEdge[]>(
    () =>
      def.edges.map((edge) => {
        const id = edge.id as string
        const run = state.edges[id]
        const source = def.nodes.find((n) => n.id === edge.from)
        const label = conditionSummary(edge.when, L)
        const route = edge.when?.kind === 'route' ? edge.when.label : undefined
        const routed = route !== undefined && source?.routes?.some((r) => r.label === route)
        return {
          id,
          from: edge.from,
          to: edge.to,
          ...(routed ? { fromPort: routePortId(route as string) } : {}),
          ...(label ? { label } : {}),
          tone: invalid.edges.has(id)
            ? 'danger'
            : run?.live
              ? 'active'
              : run && run.count > 0
                ? 'done'
                : run
                  ? 'muted'
                  : 'default',
        }
      }),
    [def, state.edges, invalid, L],
  )
  const modelLabel = useCallback(
    (node: PipelineNode) =>
      node.model ? props.models?.find((m) => m.id === node.model)?.label : undefined,
    [props.models],
  )

  // ── Edits ──────────────────────────────────────────────────────────────────
  const handleAdd = () => {
    const id = uniqueNodeId(def, 'agent')
    const canvas = canvasRef.current
    const size = canvas?.getSize()
    let position = { x: 0, y: 0 }
    if (canvas && size && size.width > 0) {
      const middle = screenToWorld({ x: size.width / 2, y: size.height / 2 }, canvas.getViewport())
      position = snapPoint({ x: middle.x - 120, y: middle.y - 48 }, snap)
    }
    // Never exactly on top of another node.
    while (def.nodes.some((n) => n.position?.x === position.x && n.position?.y === position.y)) {
      position = { x: position.x + 40, y: position.y + 40 }
    }
    onChange(addNode(def, { id, name: L.newNodeName(def.nodes.length + 1), position }))
    select({ kind: 'node', id })
    pendingFocus.current = id
  }
  const handleDelete = (target: PipelineSelection = selection) => {
    if (!target || readOnly) return
    onChange(target.kind === 'node' ? removeNode(def, target.id) : removeEdge(def, target.id))
    select(null)
  }
  const handleConnect = ({ from, to, fromPort }: CanvasConnection) => {
    const route = fromPort?.startsWith('route:') ? fromPort.slice('route:'.length) : undefined
    const next = addEdge(def, {
      from,
      to,
      ...(route !== undefined ? { when: { kind: 'route', label: route } } : {}),
    })
    if (next === def) return
    onChange(next)
    const added = next.edges[next.edges.length - 1]
    select({ kind: 'edge', id: added.id as string })
  }
  const fileRef = useRef<HTMLInputElement>(null)
  const handleImport = async (file: File | undefined) => {
    if (!file) return
    try {
      onChange(parsePipelineJson(await file.text()))
      setNotice(undefined)
      select(null)
      setLoads((n) => n + 1)
    } catch (err) {
      setNotice(L.importFailed(errMessage(err)))
    }
  }
  const handleExport = () =>
    download(`${slugifyId(def.name ?? '') || 'pipeline'}.json`, `${JSON.stringify(def, null, 2)}\n`)
  const pickIssue = (issue: PipelineIssue) => {
    const target = issueTarget(issue, def)
    setIssuesOpen(false)
    if (!target) {
      select(null)
      setSheetOpen(true)
      return
    }
    select(target)
    canvasRef.current?.focus(target)
  }

  // ── Run ────────────────────────────────────────────────────────────────────
  const running = controller?.isRunning ?? false
  const canRun = Boolean(controller) && validation.ok && input.trim().length > 0
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!controller) return
    if (running) {
      controller.stop()
      return
    }
    if (!canRun) return
    setResultsOpen(true)
    void controller.run(input.trim())
  }

  // Say what the run does, for someone who cannot watch the nodes light up.
  const said = useRef<Record<string, string>>({})
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    const now: Record<string, string> = {}
    let message = ''
    for (const [id, node] of Object.entries(state.nodes)) {
      now[id] = `${node.status}:${node.visits}`
      if (said.current[id] !== now[id] && node.status !== 'idle' && node.status !== 'waiting') {
        const name = def.nodes.find((n) => n.id === id)?.name || id
        message = L.announceNode(name, L.nodeStatus[node.status])
        // And bring the node that started into view, where the graph is larger than the canvas.
        if (node.status === 'running') canvasRef.current?.reveal(id)
      }
    }
    said.current = now
    if (message) setAnnouncement(message)
  }, [state.nodes, def.nodes, L])

  const title = inspectorTitle(def, selection, L)
  const errorCount = validation.errors.length
  const warningCount = validation.warnings.length
  const hasRun = state.status !== 'idle'
  const resultsId = useId()
  const issuesId = useId()
  const inspectorId = useId()

  const tool = (
    key: string,
    label: string,
    icon: ReactNode,
    onClick: () => void,
    options: { disabled?: boolean; text?: boolean; primary?: boolean; hideNarrow?: boolean } = {},
  ) => (
    <button
      key={key}
      type="button"
      className={`awr-pbtn awr-ptool${options.primary ? ' awr-pbtn--primary' : ''}${options.hideNarrow ? ' awr-ptool--wide-only' : ''}`}
      aria-label={label}
      title={label}
      data-tool={key}
      disabled={options.disabled}
      onClick={onClick}
    >
      {icon}
      {options.text !== false && <span className="awr-ptool__text">{label}</span>}
    </button>
  )

  return (
    <div
      ref={rootRef}
      className={['awr-pipeline', narrow ? 'awr-pipeline--narrow' : '', className]
        .filter(Boolean)
        .join(' ')}
      data-awr-theme={theme}
      data-status={state.status}
    >
      {showToolbar && (
        <div className="awr-pipeline__toolbar" role="toolbar" aria-label={L.toolbar}>
          {slots?.toolbarStart}
          {!readOnly && (
            <div className="awr-ptools">
              {tool('add', L.addNode, <PlusIcon size={16} />, handleAdd, { primary: true })}
              {tool('delete', L.deleteSelected, <TrashIcon size={16} />, () => handleDelete(), {
                disabled: !selection,
              })}
            </div>
          )}
          {showZoom && (
            <div className="awr-ptools">
              {tool(
                'zoom-out',
                L.zoomOut,
                <MinusIcon size={16} />,
                () => canvasRef.current?.zoomOut(),
                { text: false, hideNarrow: true },
              )}
              {tool(
                'zoom-in',
                L.zoomIn,
                <PlusIcon size={16} />,
                () => canvasRef.current?.zoomIn(),
                { text: false, hideNarrow: true },
              )}
              {tool('fit', L.fit, <FitIcon size={16} />, () => canvasRef.current?.fit())}
            </div>
          )}
          {(showImport || showExport || showCode) && (
            <div className="awr-ptools">
              {showImport &&
                !readOnly &&
                tool('import', L.importJson, <UploadIcon size={16} />, () =>
                  fileRef.current?.click(),
                )}
              {showExport && tool('export', L.exportJson, <DownloadIcon size={16} />, handleExport)}
              {showCode &&
                tool('code', L.copyCode, <CodeIcon size={16} />, () => setCodeOpen(true))}
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              void handleImport(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <span className="awr-pipeline__spacer" />
          {slots?.toolbarEnd}
          {showIssues && (
            <div className="awr-pipeline__issues">
              <button
                type="button"
                className={`awr-pbtn awr-pissues-chip${errorCount ? ' awr-pissues-chip--error' : warningCount ? ' awr-pissues-chip--warning' : ' awr-pissues-chip--ok'}`}
                aria-expanded={issuesOpen}
                aria-controls={issuesId}
                data-tool="issues"
                onClick={() => setIssuesOpen((open) => !open)}
              >
                {errorCount || warningCount ? <AlertIcon size={15} /> : <CheckIcon size={15} />}
                <span className="awr-pipeline__sr">{L.issues}: </span>
                <span className="awr-pissues-chip__text">
                  {errorCount || warningCount
                    ? [
                        errorCount ? L.errors(errorCount) : '',
                        warningCount ? L.warnings(warningCount) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : L.noIssues}
                </span>
                <span className="awr-pissues-chip__count" aria-hidden="true">
                  {errorCount + warningCount || ''}
                </span>
              </button>
              {issuesOpen && (
                <div id={issuesId} className="awr-pipeline__issues-panel">
                  <PipelineIssues
                    validation={validation}
                    onPick={pickIssue}
                    labels={props.labels}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {notice && (
        <div className="awr-pipeline__notice" role="alert">
          <span>{notice}</span>
          <button
            type="button"
            className="awr-pbtn awr-pbtn--icon"
            aria-label={L.close}
            onClick={() => setNotice(undefined)}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}

      <div className="awr-pipeline__stage">
        <Canvas
          ref={canvasRef}
          className="awr-pipeline__canvas"
          nodes={canvasNodes}
          edges={canvasEdges}
          selection={selection}
          onSelectionChange={select}
          onNodeMove={(id, position) => onChange(moveNode(def, id, position))}
          onConnect={handleConnect}
          onDelete={handleDelete}
          onOpen={openInspector}
          snap={snap}
          showGrid={showGrid}
          showControls={false}
          readOnly={readOnly}
          fitKey={`${props.fitKey ?? ''}:${loads}`}
          // A phone shows a wide graph from its entry, readable; Fit shows all of it.
          autoFitMinZoom={narrow ? 0.7 : undefined}
          labels={L.canvas}
          renderNode={(canvasNode, nodeState) => {
            const node = def.nodes.find((n) => n.id === canvasNode.id) as PipelineNode
            const view = pipelineNodeView(state, node.id)
            const entry = def.entry === node.id
            const bad = invalid.nodes.has(node.id)
            const card = (
              <PipelineNodeCard
                node={node}
                view={view}
                entry={entry}
                invalid={bad}
                modelLabel={modelLabel(node)}
                labels={props.labels}
              />
            )
            return renderNode
              ? renderNode({ node, view, entry, selected: nodeState.selected, invalid: bad, card })
              : card
          }}
        >
          {def.nodes.length === 0 && <p className="awr-pipeline__empty">{L.emptyCanvas}</p>}
          {slots?.canvas}
        </Canvas>

        {showInspector && (
          <aside
            ref={inspectorRef}
            id={inspectorId}
            className={`awr-pipeline__inspector${sheetOpen ? ' is-open' : ''}`}
            aria-label={L.inspector}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && narrow && sheetOpen) setSheetOpen(false)
            }}
          >
            <div className="awr-pipeline__inspector-head">
              <button
                type="button"
                className="awr-pipeline__inspector-title"
                aria-expanded={narrow ? sheetOpen : undefined}
                aria-label={narrow ? (sheetOpen ? L.collapse : L.expand) : undefined}
                disabled={!narrow}
                onClick={() => setSheetOpen((open) => !open)}
              >
                <span className="awr-pipeline__inspector-kind">{title.kind}</span>
                <span className="awr-pipeline__inspector-name">{title.name}</span>
                <ChevronIcon size={16} className="awr-pipeline__inspector-chevron" />
              </button>
              {selection && (
                <button
                  type="button"
                  className="awr-pbtn awr-pbtn--icon"
                  aria-label={L.close}
                  onClick={() => {
                    select(null)
                    setSheetOpen(false)
                  }}
                >
                  <XIcon size={16} />
                </button>
              )}
            </div>
            <div className="awr-pipeline__inspector-body">
              <PipelineInspector
                value={def}
                onChange={onChange}
                selection={selection}
                onSelectionChange={select}
                models={props.models}
                skills={props.skills}
                tools={props.tools}
                mcpServers={props.mcpServers}
                readOnly={readOnly}
                footer={slots?.inspectorFooter}
                labels={props.labels}
              />
            </div>
          </aside>
        )}
      </div>

      {controller && (showRunBar || showResults) && (
        <div className="awr-pipeline__dock">
          {showRunBar && (
            <form className="awr-pipeline__run" onSubmit={submit}>
              <input
                className="awr-pinput awr-pipeline__run-input"
                value={input}
                placeholder={L.runPlaceholder}
                aria-label={L.runInput}
                disabled={running}
                enterKeyHint="go"
                onChange={(e) => setInput(e.target.value)}
              />
              {running ? (
                <button type="submit" className="awr-pbtn awr-pbtn--stop awr-pipeline__run-btn">
                  <StopIcon size={15} />
                  {L.stop}
                </button>
              ) : (
                <button
                  type="submit"
                  className="awr-pbtn awr-pbtn--primary awr-pipeline__run-btn"
                  disabled={!canRun}
                  title={validation.ok ? undefined : L.fixErrorsFirst}
                >
                  <PlayIcon size={15} />
                  {L.run}
                </button>
              )}
              {showResults && hasRun && (
                <button
                  type="button"
                  className="awr-pbtn awr-pipeline__results-toggle"
                  aria-expanded={resultsOpen}
                  aria-controls={resultsId}
                  aria-label={resultsOpen ? L.hideResults : L.showResults}
                  onClick={() => setResultsOpen((open) => !open)}
                >
                  <span className="awr-ptool__text">{L.results}</span>
                  <ChevronIcon
                    size={16}
                    className={resultsOpen ? 'awr-pipeline__chevron--up' : undefined}
                  />
                </button>
              )}
              {slots?.runBarEnd}
            </form>
          )}
          {showResults && hasRun && resultsOpen && (
            <div id={resultsId} className="awr-pipeline__results">
              <PipelineResults
                state={state}
                definition={def}
                renderContent={renderContent}
                footer={slots?.resultsFooter}
                labels={props.labels}
              />
            </div>
          )}
        </div>
      )}

      {showCode && (
        <PipelineCodeDialog
          definition={def}
          open={codeOpen}
          onClose={() => setCodeOpen(false)}
          input={input.trim() || undefined}
          labels={props.labels}
        />
      )}
      <span className="awr-pipeline__sr" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  )
}
