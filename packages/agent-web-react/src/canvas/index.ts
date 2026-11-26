// The generic canvas: nodes, edges, pan, zoom, connect. It imports nothing from the rest of the
// package (and nothing from the agent core) - `tests/canvas.test.ts` keeps it that way - so it
// can be lifted into a package of its own.
export { Canvas, CanvasPort, defaultCanvasLabels } from './Canvas.js'
export type {
  CanvasConnection,
  CanvasEdge,
  CanvasEdgeTone,
  CanvasHandle,
  CanvasLabels,
  CanvasNode,
  CanvasNodeState,
  CanvasPortProps,
  CanvasPortSpec,
  CanvasProps,
  CanvasSelection,
} from './Canvas.js'
export {
  boundsOf,
  centerOn,
  clamp,
  curvePath,
  curvePoint,
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
  distanceToCurve,
  edgeCurve,
  fitViewport,
  hitEdge,
  hitNode,
  IDENTITY_VIEWPORT,
  inputAnchor,
  isRectVisible,
  outputAnchor,
  panBy,
  pinchViewport,
  readingOrder,
  rectContains,
  screenToWorld,
  snapPoint,
  snapTo,
  worldToScreen,
  zoomAt,
} from './geometry.js'
export type {
  Curve,
  EdgeCurveOptions,
  FitOptions,
  Point,
  Rect,
  Size,
  Viewport,
} from './geometry.js'
