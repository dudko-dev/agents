// The canvas's maths: viewport transforms, fitting, hit testing and the shape of an edge.
// Pure functions over plain numbers - no DOM, no React - so they are unit-tested as they are.

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}

/**
 * Where the world sits on the screen: a world point `p` is drawn at
 * `p * zoom + (x, y)`, in pixels from the canvas's top-left corner.
 */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** The four control points of a cubic Bezier curve. */
export interface Curve {
  p0: Point
  p1: Point
  p2: Point
  p3: Point
}

export const DEFAULT_MIN_ZOOM = 0.25
export const DEFAULT_MAX_ZOOM = 2
export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 }

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export const screenToWorld = (point: Point, viewport: Viewport): Point => ({
  x: (point.x - viewport.x) / viewport.zoom,
  y: (point.y - viewport.y) / viewport.zoom,
})

export const worldToScreen = (point: Point, viewport: Viewport): Point => ({
  x: point.x * viewport.zoom + viewport.x,
  y: point.y * viewport.zoom + viewport.y,
})

export const panBy = (viewport: Viewport, dx: number, dy: number): Viewport => ({
  ...viewport,
  x: viewport.x + dx,
  y: viewport.y + dy,
})

/** Set the zoom, keeping the world point under `anchor` (a screen point) where it is. */
export const zoomAt = (
  viewport: Viewport,
  zoom: number,
  anchor: Point,
  minZoom = DEFAULT_MIN_ZOOM,
  maxZoom = DEFAULT_MAX_ZOOM,
): Viewport => {
  const next = clamp(zoom, minZoom, maxZoom)
  if (next === viewport.zoom) return viewport
  const world = screenToWorld(anchor, viewport)
  return { zoom: next, x: anchor.x - world.x * next, y: anchor.y - world.y * next }
}

/**
 * Two fingers moved from `before` to `after` (screen points): zoom by how far apart they went,
 * and keep the world point that was between them under the point that is between them now.
 */
export const pinchViewport = (
  viewport: Viewport,
  before: [Point, Point],
  after: [Point, Point],
  minZoom = DEFAULT_MIN_ZOOM,
  maxZoom = DEFAULT_MAX_ZOOM,
): Viewport => {
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
  const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const was = distance(before[0], before[1])
  const is = distance(after[0], after[1])
  const zoom = clamp(was > 0 ? (viewport.zoom * is) / was : viewport.zoom, minZoom, maxZoom)
  const world = screenToWorld(middle(before[0], before[1]), viewport)
  const at = middle(after[0], after[1])
  return { zoom, x: at.x - world.x * zoom, y: at.y - world.y * zoom }
}

/** The smallest rectangle around all of `rects`; undefined when there are none. */
export const boundsOf = (rects: Rect[]): Rect | undefined => {
  if (rects.length === 0) return undefined
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const r of rects) {
    left = Math.min(left, r.x)
    top = Math.min(top, r.y)
    right = Math.max(right, r.x + r.width)
    bottom = Math.max(bottom, r.y + r.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export interface FitOptions {
  /** Free space kept around the content, in screen pixels (default 48). */
  padding?: number
  minZoom?: number
  /** Fitting never zooms in past this (default 1: a small graph is not blown up). */
  maxZoom?: number
}

// One axis of a fit: centred when the content fits, from its start (the padding kept) when it
// does not - a graph too large for the canvas at the smallest zoom shows where it begins.
const fitAxis = (start: number, length: number, room: number, zoom: number, padding: number) =>
  length * zoom <= room - padding * 2 + 0.5
    ? (room - length * zoom) / 2 - start * zoom
    : padding - start * zoom

/**
 * The viewport that shows all of `rects` centred in a canvas of `size`. When they do not fit at
 * `minZoom`, it shows them from their top-left corner at that zoom instead.
 */
export const fitViewport = (rects: Rect[], size: Size, options: FitOptions = {}): Viewport => {
  const bounds = boundsOf(rects)
  if (!bounds || size.width <= 0 || size.height <= 0) return IDENTITY_VIEWPORT
  const { minZoom = DEFAULT_MIN_ZOOM, maxZoom = 1 } = options
  // A narrow canvas cannot afford the padding a wide one has.
  const padding = Math.min(options.padding ?? 48, size.width / 8, size.height / 8)
  const zoom = clamp(
    Math.min(
      (size.width - padding * 2) / Math.max(bounds.width, 1),
      (size.height - padding * 2) / Math.max(bounds.height, 1),
    ),
    minZoom,
    maxZoom,
  )
  return {
    zoom,
    x: fitAxis(bounds.x, bounds.width, size.width, zoom, padding),
    y: fitAxis(bounds.y, bounds.height, size.height, zoom, padding),
  }
}

/** The viewport with `rect` in the middle of a canvas of `size`, at the zoom given. */
export const centerOn = (rect: Rect, size: Size, zoom: number): Viewport => ({
  zoom,
  x: size.width / 2 - (rect.x + rect.width / 2) * zoom,
  y: size.height / 2 - (rect.y + rect.height / 2) * zoom,
})

/** Is any part of `rect` (world) inside a canvas of `size` under `viewport`? */
export const isRectVisible = (rect: Rect, size: Size, viewport: Viewport): boolean => {
  const a = worldToScreen(rect, viewport)
  const b = worldToScreen({ x: rect.x + rect.width, y: rect.y + rect.height }, viewport)
  return b.x > 0 && b.y > 0 && a.x < size.width && a.y < size.height
}

export const snapTo = (value: number, grid: number): number =>
  // `+ 0`: a rounded-away negative is 0, not -0.
  grid > 0 ? Math.round(value / grid) * grid + 0 : value

export const snapPoint = (point: Point, grid: number): Point => ({
  x: snapTo(point.x, grid),
  y: snapTo(point.y, grid),
})

export const rectContains = (rect: Rect, point: Point): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height

/** The id of the node under `point` (world). Later nodes are drawn on top, so they win. */
export const hitNode = <T extends Rect & { id: string }>(
  nodes: T[],
  point: Point,
): string | undefined => {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (rectContains(nodes[i], point)) return nodes[i].id
  }
  return undefined
}

/** Where an edge enters a node: the middle of its left side. */
export const inputAnchor = (rect: Rect): Point => ({ x: rect.x, y: rect.y + rect.height / 2 })

/** Where an edge leaves a node that has `count` output ports: spread down its right side. */
export const outputAnchor = (rect: Rect, index = 0, count = 1): Point => ({
  x: rect.x + rect.width,
  y: rect.y + (rect.height * (index + 1)) / (Math.max(count, 1) + 1),
})

export interface EdgeCurveOptions {
  /**
   * How far an edge that runs backwards (its target is to the left of its source) swings below
   * the two nodes so that it does not cross them (default 90).
   */
  clearance?: number
}

/**
 * The curve of an edge that leaves `from` to the right and enters `to` from the left. A forward
 * edge is a plain S; a backward one (a loop) swings out and around.
 */
export const edgeCurve = (from: Point, to: Point, options: EdgeCurveOptions = {}): Curve => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx >= 40) {
    const reach = Math.max(dx / 2, 40)
    return {
      p0: from,
      p1: { x: from.x + reach, y: from.y },
      p2: { x: to.x - reach, y: to.y },
      p3: to,
    }
  }
  const reach = clamp(60 + Math.abs(dx) / 4, 60, 220)
  const clearance = options.clearance ?? 90
  // Nearly level: go around below. Otherwise the height difference already keeps it clear.
  const swing = Math.abs(dy) < clearance ? clearance + Math.abs(dy) / 2 : 0
  return {
    p0: from,
    p1: { x: from.x + reach, y: from.y + swing },
    p2: { x: to.x - reach, y: to.y + swing },
    p3: to,
  }
}

const round = (n: number): number => Math.round(n * 100) / 100

/** The SVG path data of a curve. */
export const curvePath = ({ p0, p1, p2, p3 }: Curve): string =>
  `M ${round(p0.x)} ${round(p0.y)} C ${round(p1.x)} ${round(p1.y)}, ${round(p2.x)} ${round(p2.y)}, ${round(p3.x)} ${round(p3.y)}`

/** The point of a curve at `t` in 0..1. */
export const curvePoint = ({ p0, p1, p2, p3 }: Curve, t: number): Point => {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

const distanceToSegment = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length, 0, 1)
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** How far `point` is from a curve (the curve is walked in `samples` straight pieces). */
export const distanceToCurve = (curve: Curve, point: Point, samples = 24): number => {
  let best = Infinity
  let previous = curve.p0
  for (let i = 1; i <= samples; i++) {
    const next = curvePoint(curve, i / samples)
    best = Math.min(best, distanceToSegment(point, previous, next))
    previous = next
  }
  return best
}

/** The id of the edge within `tolerance` of `point`, the nearest one when several are. */
export const hitEdge = (
  edges: { id: string; curve: Curve }[],
  point: Point,
  tolerance = 8,
): string | undefined => {
  let best: string | undefined
  let bestDistance = Infinity
  for (const edge of edges) {
    const distance = distanceToCurve(edge.curve, point)
    if (distance <= tolerance && distance < bestDistance) {
      best = edge.id
      bestDistance = distance
    }
  }
  return best
}

/**
 * The order a keyboard walks the nodes in: left to right, then top to bottom - the direction a
 * graph that flows from its entry to its end is read in. Nodes in the same column (within
 * `column` pixels) count as level.
 */
export const readingOrder = <T extends Point & { id: string }>(nodes: T[], column = 40): string[] =>
  nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const ax = Math.round(a.node.x / column)
      const bx = Math.round(b.node.x / column)
      return ax - bx || a.node.y - b.node.y || a.index - b.index
    })
    .map(({ node }) => node.id)
