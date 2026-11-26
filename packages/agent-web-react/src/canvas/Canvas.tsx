import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import {
  centerOn,
  curvePath,
  curvePoint,
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
  edgeCurve,
  fitViewport,
  hitNode,
  IDENTITY_VIEWPORT,
  inputAnchor,
  isRectVisible,
  outputAnchor,
  panBy,
  pinchViewport,
  readingOrder,
  screenToWorld,
  snapPoint,
  zoomAt,
  type Curve,
  type Point,
  type Rect,
  type Size,
  type Viewport,
} from './geometry.js'

// A generic node-and-edge canvas. It knows nothing about what a node IS: nodes are whatever HTML
// `renderNode` returns, placed in a transformed layer; edges are SVG curves under them. It is a
// controlled component - the graph and the positions come in as props, every change goes out
// through a callback - and it has no dependency: Pointer Events, a ResizeObserver and CSS.

export interface CanvasPortSpec {
  id: string
  /** What a screen reader calls it ("approved"). */
  label?: string
}

export interface CanvasNode {
  id: string
  x: number
  y: number
  /** Used until the node is measured (and where nothing can be: a server render). */
  width?: number
  height?: number
  /** The node's name for a screen reader. */
  label: string
  /** More for a screen reader: its state ("running, visit 2"). */
  description?: string
  /**
   * Its output ports. Without this the canvas draws one port on the node's right side. With it,
   * `renderNode` places a `<CanvasPort id>` for each wherever it likes.
   */
  ports?: CanvasPortSpec[]
}

export type CanvasEdgeTone = 'default' | 'active' | 'done' | 'muted' | 'danger'

export interface CanvasEdge {
  id: string
  from: string
  to: string
  /** The port of `from` it leaves by (default: the node's first port). */
  fromPort?: string
  /** Shown on the edge, at its middle. */
  label?: string
  /** What a screen reader hears after "from A to B". Defaults to `label`. */
  description?: string
  tone?: CanvasEdgeTone
}

export type CanvasSelection = { kind: 'node' | 'edge'; id: string } | null

export interface CanvasConnection {
  from: string
  fromPort?: string
  to: string
}

/** Every string the canvas shows or says. */
export interface CanvasLabels {
  /** The canvas's own name for a screen reader. */
  canvas: string
  /** How to use it with a keyboard; read once, when the canvas is focused. */
  help: string
  /** `aria-roledescription` of a node. */
  node: string
  edge: (from: string, to: string, description?: string) => string
  port: (node: string, port?: string) => string
  connectsTo: (names: string) => string
  receivesFrom: (names: string) => string
  zoomIn: string
  zoomOut: string
  fit: string
  zoomLevel: (percent: number) => string
  /** Shown (and announced) while a connection is being made without dragging. */
  connectHint: (from: string) => string
  cancel: string
  connected: (from: string, to: string) => string
}

export const defaultCanvasLabels: CanvasLabels = {
  canvas: 'Canvas',
  help: 'Tab moves between nodes and their connections. Arrow keys move the selected node, Enter opens it, Delete removes it, C starts a connection, Escape clears the selection. On the canvas itself the arrow keys pan, plus and minus zoom, 0 fits everything.',
  node: 'node',
  edge: (from, to, description) =>
    `Connection from ${from} to ${to}${description ? `: ${description}` : ''}`,
  port: (node, port) => `Connect ${node}${port ? ` (${port})` : ''} to another node`,
  connectsTo: (names) => `Connects to: ${names}.`,
  receivesFrom: (names) => `Receives from: ${names}.`,
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit to view',
  zoomLevel: (percent) => `${percent}%`,
  connectHint: (from) => `Pick the node to connect ${from} to`,
  cancel: 'Cancel',
  connected: (from, to) => `Connected ${from} to ${to}`,
}

export interface CanvasNodeState {
  selected: boolean
  dragging: boolean
  /** A connection is being made and this node can take it. */
  connectable: boolean
}

export interface CanvasHandle {
  /** Show everything. */
  fit: () => void
  zoomIn: () => void
  zoomOut: () => void
  /** Put a node or an edge in view and move the keyboard focus to it. */
  focus: (target: NonNullable<CanvasSelection>) => void
  /** Scroll a node into the middle of the view. */
  center: (nodeId: string) => void
  /** The same, but only when no part of the node is in view. */
  reveal: (nodeId: string) => void
  getViewport: () => Viewport
  /** The canvas's size on the screen, in pixels. */
  getSize: () => Size
}

export interface CanvasProps {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  renderNode: (node: CanvasNode, state: CanvasNodeState) => ReactNode
  selection?: CanvasSelection
  onSelectionChange?: (selection: CanvasSelection) => void
  /** Controlled viewport. Leave both out and the canvas keeps its own. */
  viewport?: Viewport
  onViewportChange?: (viewport: Viewport) => void
  /** A node is being dragged, or was moved with the arrow keys. */
  onNodeMove?: (id: string, position: Point) => void
  /** The drag ended (or the key was pressed): the place to save. */
  onNodeMoveEnd?: (id: string, position: Point) => void
  /** A port was dragged (or keyboard-connected) to another node. */
  onConnect?: (connection: CanvasConnection) => void
  /** Delete / Backspace on a node or an edge. */
  onDelete?: (target: NonNullable<CanvasSelection>) => void
  /** Enter or a double click on a node or an edge. */
  onOpen?: (target: NonNullable<CanvasSelection>) => void
  /** Grid step nodes snap to, in world pixels (default 20; 0 = no snapping). */
  snap?: number
  /** The dot grid behind the graph (default true). */
  showGrid?: boolean
  /** The zoom buttons in the corner (default true). */
  showControls?: boolean
  minZoom?: number
  maxZoom?: number
  /** Fit the graph when the canvas first has a size (default true; ignored when controlled). */
  fitOnMount?: boolean
  /** Change it to fit again - a new document was loaded. */
  fitKey?: string | number
  /**
   * The smallest zoom the canvas fits to BY ITSELF (on mount, on `fitKey`, when its box changes).
   * A wide graph on a phone is then readable from its start rather than whole and tiny; the Fit
   * button still shows everything. Default: `minZoom`.
   */
  autoFitMinZoom?: number
  /** Look, pan and zoom only: nothing can be moved, connected or deleted. */
  readOnly?: boolean
  labels?: Partial<CanvasLabels>
  className?: string
  style?: CSSProperties
  /** Drawn over the canvas, outside the zoomed layer (a legend, an empty state). */
  children?: ReactNode
}

interface Measure extends Size {
  ports: Record<string, Point>
}

type Gesture =
  | { kind: 'pan' | 'pinch'; start: Point; moved: boolean }
  | { kind: 'node'; id: string; start: Point; origin: Point; moved: boolean; at: Point }
  | { kind: 'edge'; id: string; start: Point; moved: boolean }
  | { kind: 'connect'; from: string; port: string | undefined; start: Point; moved: boolean }

interface PortContextValue {
  nodeLabel: string
  labels: CanvasLabels
  disabled: boolean
  active: string | undefined
}

const PortContext = createContext<PortContextValue | undefined>(undefined)

const DEFAULT_SIZE: Size = { width: 240, height: 96 }
const DEFAULT_PORT = 'out'
const DRAG_THRESHOLD = 4
const DOUBLE_TAP_MS = 350
const INTERACTIVE = 'button, a, input, textarea, select, summary, [data-awr-nodrag]'
const EDITABLE = 'input, textarea, select, [contenteditable="true"]'
const TONES: CanvasEdgeTone[] = ['default', 'active', 'done', 'muted', 'danger']

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const domId = (id: string): string => encodeURIComponent(id).replace(/[^a-zA-Z0-9_-]/g, '_')

const cx = (...parts: (string | false | undefined)[]): string => parts.filter(Boolean).join(' ')

export interface CanvasPortProps {
  /** The port's id (default: the node's only port). */
  id?: string
  /** Its name for a screen reader, when the node's `ports` does not give one. */
  label?: string
  className?: string
}

/**
 * An output port: drag from it to another node to connect them, or press it and then the node.
 * Place it inside what `renderNode` returns; an edge with this `fromPort` starts at its centre.
 */
export const CanvasPort = ({ id = DEFAULT_PORT, label, className }: CanvasPortProps) => {
  const ctx = useContext(PortContext)
  return (
    <button
      type="button"
      className={cx(
        'awr-canvas__port',
        ctx?.active === id && 'awr-canvas__port--active',
        className,
      )}
      data-awr-port={id}
      aria-label={ctx ? ctx.labels.port(ctx.nodeLabel, label) : label}
      aria-pressed={ctx?.active === id}
      disabled={ctx?.disabled}
    />
  )
}

/**
 * The canvas. Nodes are HTML, edges are SVG; drag the background to pan, pinch or ctrl+wheel to
 * zoom, drag a node to move it, drag a port to another node to connect them.
 */
export const Canvas = forwardRef<CanvasHandle, CanvasProps>((props, ref) => {
  const {
    nodes,
    edges,
    renderNode,
    selection = null,
    onSelectionChange,
    onViewportChange,
    onNodeMove,
    onNodeMoveEnd,
    onConnect,
    onDelete,
    onOpen,
    snap = 20,
    showGrid = true,
    showControls = true,
    minZoom = DEFAULT_MIN_ZOOM,
    maxZoom = DEFAULT_MAX_ZOOM,
    fitOnMount = true,
    fitKey,
    autoFitMinZoom,
    readOnly = false,
    className,
    style,
    children,
  } = props
  const labels = useMemo(() => ({ ...defaultCanvasLabels, ...props.labels }), [props.labels])
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  const rootRef = useRef<HTMLDivElement>(null)
  const nodeEls = useRef(new Map<string, HTMLElement>())
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [measured, setMeasured] = useState<Record<string, Measure>>({})

  // ── Viewport: the host's, or our own ───────────────────────────────────────
  const [ownViewport, setOwnViewport] = useState<Viewport>(IDENTITY_VIEWPORT)
  const controlled = props.viewport !== undefined
  const viewport = props.viewport ?? ownViewport
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const setViewport = useCallback(
    (next: Viewport | ((current: Viewport) => Viewport)) => {
      const value = typeof next === 'function' ? next(viewportRef.current) : next
      if (
        value.x === viewportRef.current.x &&
        value.y === viewportRef.current.y &&
        value.zoom === viewportRef.current.zoom
      ) {
        return
      }
      viewportRef.current = value
      touched.current = true
      if (!controlled) setOwnViewport(value)
      onViewportChange?.(value)
    },
    [controlled, onViewportChange],
  )
  // Whether the person has moved the view since it was last fitted.
  const touched = useRef(false)

  // ── Sizes: the canvas's own, and each node's with the places of its ports ──
  const rectOf = useCallback(
    (node: CanvasNode): Rect => {
      const m = measured[node.id]
      return {
        x: node.x,
        y: node.y,
        width: m?.width ?? node.width ?? DEFAULT_SIZE.width,
        height: m?.height ?? node.height ?? DEFAULT_SIZE.height,
      }
    },
    [measured],
  )
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const rectOfRef = useRef(rectOf)
  rectOfRef.current = rectOf

  const measure = useCallback((ids?: string[]) => {
    const zoom = viewportRef.current.zoom || 1
    setMeasured((current) => {
      let next = current
      const live = new Set(nodeEls.current.keys())
      for (const id of Object.keys(current)) {
        if (!live.has(id)) {
          if (next === current) next = { ...current }
          delete next[id]
        }
      }
      for (const id of ids ?? live) {
        const el = nodeEls.current.get(id)
        if (!el) continue
        const box = el.getBoundingClientRect()
        const ports: Record<string, Point> = {}
        for (const port of el.querySelectorAll<HTMLElement>('[data-awr-port]')) {
          const p = port.getBoundingClientRect()
          ports[port.dataset.awrPort as string] = {
            x: Math.round((p.left + p.width / 2 - box.left) / zoom),
            y: Math.round((p.top + p.height / 2 - box.top) / zoom),
          }
        }
        const value: Measure = { width: el.offsetWidth, height: el.offsetHeight, ports }
        const before = current[id]
        const same =
          before &&
          before.width === value.width &&
          before.height === value.height &&
          Object.keys(before.ports).length === Object.keys(ports).length &&
          Object.entries(ports).every(
            ([key, p]) => before.ports[key]?.x === p.x && before.ports[key]?.y === p.y,
          )
        if (!same) {
          if (next === current) next = { ...current }
          next[id] = value
        }
      }
      return next
    })
  }, [])

  const observer = useRef<ResizeObserver | undefined>(undefined)
  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') {
      if (root) setSize({ width: root.clientWidth, height: root.clientHeight })
      return
    }
    const ro = new ResizeObserver((entries) => {
      const changed: string[] = []
      for (const entry of entries) {
        if (entry.target === root) {
          setSize({ width: root.clientWidth, height: root.clientHeight })
        } else {
          const id = (entry.target as HTMLElement).dataset.awrNode
          if (id) changed.push(id)
        }
      }
      if (changed.length) measure(changed)
    })
    observer.current = ro
    ro.observe(root)
    for (const el of nodeEls.current.values()) ro.observe(el)
    setSize({ width: root.clientWidth, height: root.clientHeight })
    return () => {
      ro.disconnect()
      observer.current = undefined
    }
  }, [measure])

  // A node's ports can change without its box changing (a route was renamed): measure again
  // whenever the set of nodes or of their ports does.
  const shape = nodes.map((n) => `${n.id}:${(n.ports ?? []).map((p) => p.id).join(',')}`).join('|')
  useIsomorphicLayoutEffect(() => {
    measure()
  }, [shape, measure])

  const setNodeEl = useCallback((id: string, el: HTMLElement | null) => {
    const before = nodeEls.current.get(id)
    if (before === el) return
    if (before) observer.current?.unobserve(before)
    if (el) {
      nodeEls.current.set(id, el)
      observer.current?.observe(el)
    } else {
      nodeEls.current.delete(id)
    }
  }, [])

  // ── The order nodes are in the document: the order Tab walks them in ───────
  const [order, setOrder] = useState<string[]>(() => readingOrder(nodes))
  const reorder = useCallback(() => {
    const next = readingOrder(nodesRef.current)
    setOrder((current) =>
      current.length === next.length && current.every((id, i) => id === next[i]) ? current : next,
    )
  }, [])
  const idsKey = nodes.map((n) => n.id).join('|')
  useEffect(() => {
    reorder()
  }, [idsKey, reorder])
  const ordered = useMemo(() => {
    const known = order.filter((id) => nodeById.has(id))
    const rest = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id)
    return [...known, ...rest].map((id) => nodeById.get(id) as CanvasNode)
  }, [order, nodes, nodeById])

  // ── Fitting ────────────────────────────────────────────────────────────────
  const sizeRef = useRef(size)
  sizeRef.current = size
  const fitTo = useCallback(
    (smallest: number) => {
      const rects = nodesRef.current.map((n) => rectOfRef.current(n))
      if (rects.length === 0 || sizeRef.current.width === 0) return
      setViewport(
        fitViewport(rects, sizeRef.current, {
          // Room for an edge that loops back around its nodes.
          padding: 64,
          minZoom: smallest,
          maxZoom: Math.min(1, maxZoom),
        }),
      )
      touched.current = false
    },
    [setViewport, maxZoom],
  )
  const fit = useCallback(() => fitTo(minZoom), [fitTo, minZoom])
  const autoFit = useCallback(
    () => fitTo(Math.max(minZoom, autoFitMinZoom ?? minZoom)),
    [fitTo, minZoom, autoFitMinZoom],
  )
  const fitted = useRef<string | number | undefined | null>(null)
  const allMeasured = nodes.length > 0 && nodes.every((n) => measured[n.id])
  useEffect(() => {
    if (size.width === 0 || !allMeasured) return
    const first = fitted.current === null
    const wanted = fitOnMount && !controlled
    if (first ? !wanted : fitted.current === fitKey) {
      if (first) fitted.current = fitKey
      // The same document in a box that changed (the page is still laying out, a phone was
      // turned): fit again, unless the person has already moved the view.
      else if (wanted && !touched.current) autoFit()
      return
    }
    fitted.current = fitKey
    autoFit()
  }, [size.width, size.height, allMeasured, fitKey, fitOnMount, controlled, autoFit])

  const zoomStep = useCallback(
    (factor: number) => {
      const { width, height } = sizeRef.current
      setViewport((v) =>
        zoomAt(v, v.zoom * factor, { x: width / 2, y: height / 2 }, minZoom, maxZoom),
      )
    },
    [setViewport, minZoom, maxZoom],
  )

  const reveal = useCallback(
    (nodeId: string, always = false) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      if (!node || sizeRef.current.width === 0) return
      const rect = rectOfRef.current(node)
      if (always || !isRectVisible(rect, sizeRef.current, viewportRef.current)) {
        setViewport(centerOn(rect, sizeRef.current, viewportRef.current.zoom))
      }
    },
    [setViewport],
  )

  // ── Selection, and connecting without dragging ─────────────────────────────
  const select = useCallback(
    (next: CanvasSelection) => {
      if (next?.kind === selection?.kind && next?.id === selection?.id) return
      onSelectionChange?.(next)
    },
    [selection, onSelectionChange],
  )
  const [connectFrom, setConnectFrom] = useState<{ node: string; port?: string } | undefined>()
  const [dragLine, setDragLine] = useState<{ from: string; port?: string; to: Point } | undefined>()
  const [dragging, setDragging] = useState<string | undefined>()
  const [announcement, setAnnouncement] = useState('')
  const labelOf = useCallback((id: string) => nodeById.get(id)?.label ?? id, [nodeById])

  const startConnect = useCallback(
    (node: string, port?: string) => {
      if (readOnly) return
      setConnectFrom({ node, port })
      setAnnouncement(labels.connectHint(labelOf(node)))
    },
    [readOnly, labels, labelOf],
  )
  const finishConnect = useCallback(
    (from: string, port: string | undefined, to: string) => {
      setConnectFrom(undefined)
      if (from === to || !nodeById.has(to)) return
      onConnect?.({ from, to, ...(port && port !== DEFAULT_PORT ? { fromPort: port } : {}) })
      setAnnouncement(labels.connected(labelOf(from), labelOf(to)))
    },
    [nodeById, onConnect, labels, labelOf],
  )
  // The source of a pending connection was removed.
  useEffect(() => {
    if (connectFrom && !nodeById.has(connectFrom.node)) setConnectFrom(undefined)
  }, [connectFrom, nodeById])

  useImperativeHandle(
    ref,
    () => ({
      fit,
      zoomIn: () => zoomStep(1.25),
      zoomOut: () => zoomStep(0.8),
      center: (nodeId) => reveal(nodeId, true),
      reveal: (nodeId) => reveal(nodeId),
      getViewport: () => viewportRef.current,
      getSize: () => sizeRef.current,
      focus: (target) => {
        const root = rootRef.current
        if (!root) return
        if (target.kind === 'node') {
          reveal(target.id)
          nodeEls.current.get(target.id)?.focus({ preventScroll: true })
        } else {
          const el = [...root.querySelectorAll<HTMLElement>('button[data-awr-edge]')].find(
            (b) => b.dataset.awrEdge === target.id,
          )
          const edge = el && edgesRef.current.find((e) => e.id === target.id)
          if (edge) reveal(edge.from)
          el?.focus({ preventScroll: true })
        }
      },
    }),
    [fit, zoomStep, reveal],
  )
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  // ── Pointer: pan, pinch, drag a node, drag out a connection ────────────────
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | undefined>(undefined)
  const last = useRef<Point>({ x: 0, y: 0 })
  const lastTap = useRef<{ key: string; time: number } | undefined>(undefined)

  const toLocal = (e: { clientX: number; clientY: number }): Point => {
    const box = (rootRef.current as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
    const target = e.target as Element
    if (target.closest('[data-awr-canvas-ignore]')) return
    const nodeEl = target.closest<HTMLElement>('[data-awr-node]')
    const portEl = target.closest<HTMLElement>('[data-awr-port]')
    // A control inside a node keeps its own clicks.
    if (nodeEl && !portEl && target !== nodeEl && target.closest(INTERACTIVE)) return
    const local = toLocal(e)
    pointers.current.set(e.pointerId, local)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // A pointer that is already gone.
    }
    last.current = local
    if (pointers.current.size === 2) {
      gesture.current = { kind: 'pinch', start: local, moved: true }
      setDragLine(undefined)
      setDragging(undefined)
      return
    }
    if (pointers.current.size > 2) return
    const edgeEl = target.closest<HTMLElement | SVGElement>('[data-awr-edge]')
    if (e.button === 1) {
      gesture.current = { kind: 'pan', start: local, moved: false }
      e.preventDefault()
    } else if (portEl && nodeEl && !readOnly) {
      gesture.current = {
        kind: 'connect',
        from: nodeEl.dataset.awrNode as string,
        port: portEl.dataset.awrPort,
        start: local,
        moved: false,
      }
    } else if (nodeEl) {
      const id = nodeEl.dataset.awrNode as string
      const node = nodeById.get(id)
      if (!node) return
      const origin = { x: node.x, y: node.y }
      gesture.current = { kind: 'node', id, start: local, origin, moved: false, at: origin }
      if (!connectFrom) select({ kind: 'node', id })
    } else if (edgeEl) {
      gesture.current = {
        kind: 'edge',
        id: (edgeEl as HTMLElement).dataset.awrEdge as string,
        start: local,
        moved: false,
      }
    } else {
      gesture.current = { kind: 'pan', start: local, moved: false }
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const before = pointers.current.get(e.pointerId)
    if (!before) return
    const local = toLocal(e)
    const g = gesture.current
    if (g?.kind === 'pinch') {
      if (pointers.current.size < 2) return
      const [a, b] = [...pointers.current.entries()]
      const was: [Point, Point] = [a[1], b[1]]
      pointers.current.set(e.pointerId, local)
      const is: [Point, Point] = [
        pointers.current.get(a[0]) as Point,
        pointers.current.get(b[0]) as Point,
      ]
      setViewport((v) => pinchViewport(v, was, is, minZoom, maxZoom))
      return
    }
    pointers.current.set(e.pointerId, local)
    if (!g) return
    if (!g.moved) {
      if (Math.hypot(local.x - g.start.x, local.y - g.start.y) < DRAG_THRESHOLD) return
      g.moved = true
      if (g.kind === 'node' && !readOnly) setDragging(g.id)
    }
    if (g.kind === 'pan' || g.kind === 'edge' || (g.kind === 'node' && readOnly)) {
      setViewport((v) => panBy(v, local.x - last.current.x, local.y - last.current.y))
    } else if (g.kind === 'node') {
      const zoom = viewportRef.current.zoom
      const next = snapPoint(
        {
          x: g.origin.x + (local.x - g.start.x) / zoom,
          y: g.origin.y + (local.y - g.start.y) / zoom,
        },
        snap,
      )
      if (next.x !== g.at.x || next.y !== g.at.y) {
        g.at = next
        onNodeMove?.(g.id, next)
      }
    } else if (g.kind === 'connect') {
      setDragLine({ from: g.from, port: g.port, to: screenToWorld(local, viewportRef.current) })
    }
    last.current = local
  }

  const tapped = (key: string): boolean => {
    const now = Date.now()
    const double = lastTap.current?.key === key && now - lastTap.current.time < DOUBLE_TAP_MS
    lastTap.current = double ? undefined : { key, time: now }
    return double
  }

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    const local = toLocal(e)
    pointers.current.delete(e.pointerId)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Already released.
    }
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pinch') {
      // The finger that stays does nothing until it is lifted too.
      if (pointers.current.size === 0) gesture.current = undefined
      return
    }
    gesture.current = undefined
    setDragging(undefined)
    setDragLine(undefined)
    if (e.type === 'pointercancel') return
    if (g.kind === 'pan') {
      if (g.moved) return
      if (connectFrom) setConnectFrom(undefined)
      else select(null)
    } else if (g.kind === 'node') {
      if (g.moved) {
        if (!readOnly) {
          onNodeMoveEnd?.(g.id, g.at)
          reorder()
        }
      } else if (connectFrom) {
        finishConnect(connectFrom.node, connectFrom.port, g.id)
      } else if (tapped(`node:${g.id}`)) {
        onOpen?.({ kind: 'node', id: g.id })
      }
    } else if (g.kind === 'edge') {
      if (g.moved) return
      select({ kind: 'edge', id: g.id })
      if (tapped(`edge:${g.id}`)) onOpen?.({ kind: 'edge', id: g.id })
    } else if (g.kind === 'connect') {
      if (!g.moved) {
        if (connectFrom?.node === g.from && connectFrom.port === g.port) setConnectFrom(undefined)
        else startConnect(g.from, g.port)
        return
      }
      const world = screenToWorld(local, viewportRef.current)
      const rects = ordered.map((n) => ({ id: n.id, ...rectOf(n) }))
      const to = hitNode(rects, world)
      if (to) finishConnect(g.from, g.port, to)
    }
  }

  // The wheel pans, ctrl / cmd + wheel (and a trackpad pinch, which arrives as that) zooms.
  // React listens passively, and the page must not scroll or zoom under the canvas.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest?.('[data-awr-canvas-ignore]')) return
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? root.clientHeight : 1
      if (e.ctrlKey || e.metaKey) {
        const box = root.getBoundingClientRect()
        const anchor = { x: e.clientX - box.left, y: e.clientY - box.top }
        const factor = Math.exp((-e.deltaY * unit) / 240)
        setViewport((v) => zoomAt(v, v.zoom * factor, anchor, minZoom, maxZoom))
      } else {
        setViewport((v) => panBy(v, -e.deltaX * unit, -e.deltaY * unit))
      }
    }
    // Safari's own pinch gesture would zoom the page.
    const stop = (e: Event) => e.preventDefault()
    root.addEventListener('wheel', onWheel, { passive: false })
    root.addEventListener('gesturestart', stop)
    root.addEventListener('gesturechange', stop)
    return () => {
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('gesturestart', stop)
      root.removeEventListener('gesturechange', stop)
    }
  }, [setViewport, minZoom, maxZoom])

  // ── Keyboard ───────────────────────────────────────────────────────────────
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-awr-canvas-ignore]') || target.matches(EDITABLE)) return
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const root = rootRef.current as HTMLElement
    if (e.key === 'Escape') {
      if (connectFrom) setConnectFrom(undefined)
      else if (selection) select(null)
      else return
      e.preventDefault()
      return
    }
    const nodeEl = target.closest<HTMLElement>('[data-awr-node]')
    const portEl = target.closest<HTMLElement>('[data-awr-port]')
    const activate = e.key === 'Enter' || e.key === ' '
    const remove = e.key === 'Delete' || e.key === 'Backspace'
    if (portEl && nodeEl) {
      if (!activate) return
      e.preventDefault()
      const id = nodeEl.dataset.awrNode as string
      if (connectFrom?.node === id && connectFrom.port === portEl.dataset.awrPort) {
        setConnectFrom(undefined)
      } else {
        startConnect(id, portEl.dataset.awrPort)
      }
      return
    }
    if (nodeEl && target === nodeEl) {
      const id = nodeEl.dataset.awrNode as string
      const node = nodeById.get(id)
      if (!node) return
      const arrows: Record<string, Point> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      }
      const arrow = arrows[e.key]
      if (arrow) {
        e.preventDefault()
        if (readOnly) return
        const step = (snap > 0 ? snap : 10) * (e.shiftKey ? 5 : 1)
        const next = snapPoint({ x: node.x + arrow.x * step, y: node.y + arrow.y * step }, snap)
        onNodeMove?.(id, next)
        onNodeMoveEnd?.(id, next)
      } else if (activate) {
        e.preventDefault()
        if (connectFrom) finishConnect(connectFrom.node, connectFrom.port, id)
        else onOpen?.({ kind: 'node', id })
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault()
        startConnect(id, node.ports?.[0]?.id)
      } else if (remove && !readOnly) {
        e.preventDefault()
        onDelete?.({ kind: 'node', id })
        root.focus({ preventScroll: true })
      }
      return
    }
    const edgeEl = target.closest<HTMLElement>('button[data-awr-edge]')
    if (edgeEl) {
      const id = edgeEl.dataset.awrEdge as string
      if (activate) {
        e.preventDefault()
        select({ kind: 'edge', id })
        onOpen?.({ kind: 'edge', id })
      } else if (remove && !readOnly) {
        e.preventDefault()
        onDelete?.({ kind: 'edge', id })
        root.focus({ preventScroll: true })
      }
      return
    }
    if (target !== root) return
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [48, 0],
      ArrowRight: [-48, 0],
      ArrowUp: [0, 48],
      ArrowDown: [0, -48],
    }
    if (pan[e.key]) {
      e.preventDefault()
      setViewport((v) => panBy(v, pan[e.key][0], pan[e.key][1]))
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      zoomStep(1.25)
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      zoomStep(0.8)
    } else if (e.key === '0') {
      e.preventDefault()
      fit()
    }
  }

  // A node or an edge reached with the keyboard is the selected one.
  const onFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    let byKeyboard = false
    try {
      byKeyboard = target.matches(':focus-visible')
    } catch {
      byKeyboard = false
    }
    if (!byKeyboard) return
    if (target.dataset.awrNode !== undefined) {
      reveal(target.dataset.awrNode)
      if (!connectFrom) select({ kind: 'node', id: target.dataset.awrNode })
    } else if (target.dataset.awrEdge !== undefined && target.tagName === 'BUTTON') {
      if (!connectFrom) select({ kind: 'edge', id: target.dataset.awrEdge })
    }
  }
  const onBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    // Arrow keys move a node without reordering the document under the focus; catch up now.
    if ((e.target as HTMLElement).dataset.awrNode !== undefined) reorder()
  }

  // ── Edges ──────────────────────────────────────────────────────────────────
  const portPoint = useCallback(
    (node: CanvasNode, portId: string | undefined): Point => {
      const rect = rectOf(node)
      const ports = node.ports
      const id = portId ?? ports?.[0]?.id ?? DEFAULT_PORT
      const at = measured[node.id]?.ports[id]
      if (at) return { x: node.x + at.x, y: node.y + at.y }
      const index = ports
        ? Math.max(
            0,
            ports.findIndex((p) => p.id === id),
          )
        : 0
      return outputAnchor(rect, index, ports?.length ?? 1)
    },
    [measured, rectOf],
  )
  const drawn = useMemo(() => {
    const out: { edge: CanvasEdge; curve: Curve; path: string; middle: Point }[] = []
    for (const edge of edges) {
      const from = nodeById.get(edge.from)
      const to = nodeById.get(edge.to)
      if (!from || !to) continue
      const a = rectOf(from)
      const b = rectOf(to)
      const curve = edgeCurve(portPoint(from, edge.fromPort), inputAnchor(b), {
        clearance: Math.max(a.height, b.height) / 2 + 44,
      })
      out.push({ edge, curve, path: curvePath(curve), middle: curvePoint(curve, 0.5) })
    }
    return out
  }, [edges, nodeById, rectOf, portPoint])

  const outgoing = useMemo(() => {
    const map = new Map<string, typeof drawn>()
    for (const d of drawn) map.set(d.edge.from, [...(map.get(d.edge.from) ?? []), d])
    return map
  }, [drawn])
  const neighbours = useMemo(() => {
    const to = new Map<string, string[]>()
    const from = new Map<string, string[]>()
    for (const { edge } of drawn) {
      const said = edge.description ?? edge.label
      to.set(edge.from, [
        ...(to.get(edge.from) ?? []),
        said ? `${labelOf(edge.to)} (${said})` : labelOf(edge.to),
      ])
      from.set(edge.to, [...(from.get(edge.to) ?? []), labelOf(edge.from)])
    }
    return { to, from }
  }, [drawn, labelOf])

  const dragPath = useMemo(() => {
    if (!dragLine) return undefined
    const from = nodeById.get(dragLine.from)
    if (!from) return undefined
    return curvePath(edgeCurve(portPoint(from, dragLine.port), dragLine.to, { clearance: 0 }))
  }, [dragLine, nodeById, portPoint])

  // The grid is drawn by CSS; it only needs to know where the world is.
  let grid = (snap > 0 ? snap : 20) * viewport.zoom
  while (grid < 14) grid *= 2
  const rootStyle = {
    ...style,
    '--awr-canvas-x': `${viewport.x}px`,
    '--awr-canvas-y': `${viewport.y}px`,
    '--awr-canvas-grid': `${grid}px`,
  } as CSSProperties

  const selectedEdge = selection?.kind === 'edge' ? selection.id : undefined
  const selectedNode = selection?.kind === 'node' ? selection.id : undefined

  return (
    <div
      ref={rootRef}
      className={cx(
        'awr-canvas',
        showGrid && 'awr-canvas--grid',
        connectFrom && 'awr-canvas--connecting',
        (dragging || dragLine) && 'awr-canvas--dragging',
        className,
      )}
      style={rootStyle}
      role="application"
      aria-label={labels.canvas}
      aria-describedby={`${uid}-help`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div
        className="awr-canvas__world"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        }}
      >
        <svg className="awr-canvas__edges" aria-hidden="true" focusable="false">
          <defs>
            {[...TONES, 'selected'].map((tone) => (
              <marker
                key={tone}
                id={`${uid}-arrow-${tone}`}
                viewBox="0 0 10 10"
                markerWidth="10"
                markerHeight="10"
                refX="9"
                refY="5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path
                  d="M1 1.5 9 5 1 8.5z"
                  className={`awr-canvas__arrow awr-canvas__arrow--${tone}`}
                />
              </marker>
            ))}
          </defs>
          {drawn.map(({ edge, path }) => {
            const tone = edge.tone ?? 'default'
            const selected = edge.id === selectedEdge
            return (
              <g
                key={edge.id}
                className={cx(
                  'awr-canvas__edge',
                  `awr-canvas__edge--${tone}`,
                  selected && 'awr-canvas__edge--selected',
                )}
              >
                <path className="awr-canvas__edge-hit" d={path} data-awr-edge={edge.id} />
                <path
                  className="awr-canvas__edge-line"
                  d={path}
                  markerEnd={`url(#${uid}-arrow-${selected ? 'selected' : tone})`}
                />
              </g>
            )
          })}
          {dragPath && (
            <path className="awr-canvas__edge-line awr-canvas__edge-draft" d={dragPath} />
          )}
        </svg>

        {ordered.map((node) => {
          const selected = node.id === selectedNode
          const state: CanvasNodeState = {
            selected,
            dragging: dragging === node.id,
            connectable: Boolean(
              (connectFrom && connectFrom.node !== node.id) ||
              (dragLine && dragLine.from !== node.id),
            ),
          }
          const said = [
            node.description,
            neighbours.to.get(node.id)?.length
              ? labels.connectsTo((neighbours.to.get(node.id) as string[]).join(', '))
              : undefined,
            neighbours.from.get(node.id)?.length
              ? labels.receivesFrom((neighbours.from.get(node.id) as string[]).join(', '))
              : undefined,
          ]
            .filter(Boolean)
            .join(' ')
          const port: PortContextValue = {
            nodeLabel: node.label,
            labels,
            disabled: readOnly,
            active: connectFrom?.node === node.id ? (connectFrom.port ?? DEFAULT_PORT) : undefined,
          }
          return (
            <PortContext.Provider key={node.id} value={port}>
              <div
                ref={(el) => setNodeEl(node.id, el)}
                className={cx(
                  'awr-canvas__node',
                  selected && 'awr-canvas__node--selected',
                  state.dragging && 'awr-canvas__node--dragging',
                  state.connectable && 'awr-canvas__node--connectable',
                )}
                style={{ transform: `translate(${node.x}px, ${node.y}px)` }}
                data-awr-node={node.id}
                role="group"
                aria-roledescription={labels.node}
                aria-label={node.label}
                aria-describedby={said ? `${uid}-n-${domId(node.id)}` : undefined}
                tabIndex={0}
              >
                {renderNode(node, state)}
                {!node.ports && <CanvasPort className="awr-canvas__port--default" />}
                {said && (
                  <span id={`${uid}-n-${domId(node.id)}`} className="awr-canvas__sr">
                    {said}
                  </span>
                )}
              </div>
              {(outgoing.get(node.id) ?? []).map(({ edge, middle }) => (
                <button
                  key={edge.id}
                  type="button"
                  className={cx(
                    'awr-canvas__edge-handle',
                    `awr-canvas__edge-handle--${edge.tone ?? 'default'}`,
                    edge.label ? 'awr-canvas__edge-handle--label' : undefined,
                    edge.id === selectedEdge && 'awr-canvas__edge-handle--selected',
                  )}
                  style={{ left: middle.x, top: middle.y }}
                  data-awr-edge={edge.id}
                  aria-label={labels.edge(
                    labelOf(edge.from),
                    labelOf(edge.to),
                    edge.description ?? edge.label,
                  )}
                  aria-pressed={edge.id === selectedEdge}
                >
                  {edge.label ? <span>{edge.label}</span> : null}
                </button>
              ))}
            </PortContext.Provider>
          )
        })}
      </div>

      {children}

      {connectFrom && (
        <div className="awr-canvas__hint" data-awr-canvas-ignore="">
          <span>{labels.connectHint(labelOf(connectFrom.node))}</span>
          <button type="button" onClick={() => setConnectFrom(undefined)}>
            {labels.cancel}
          </button>
        </div>
      )}

      {showControls && (
        <div className="awr-canvas__controls" data-awr-canvas-ignore="">
          <button type="button" aria-label={labels.zoomOut} onClick={() => zoomStep(0.8)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14" />
            </svg>
          </button>
          <output className="awr-canvas__zoom">
            {labels.zoomLevel(Math.round(viewport.zoom * 100))}
          </output>
          <button type="button" aria-label={labels.zoomIn} onClick={() => zoomStep(1.25)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button type="button" aria-label={labels.fit} onClick={fit}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
            </svg>
          </button>
        </div>
      )}

      <span id={`${uid}-help`} className="awr-canvas__sr">
        {labels.help}
      </span>
      <span className="awr-canvas__sr" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  )
})
Canvas.displayName = 'Canvas'
