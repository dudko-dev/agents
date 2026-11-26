import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  boundsOf,
  Canvas,
  CanvasPort,
  centerOn,
  curvePath,
  curvePoint,
  distanceToCurve,
  edgeCurve,
  fitViewport,
  hitEdge,
  hitNode,
  inputAnchor,
  isRectVisible,
  outputAnchor,
  panBy,
  pinchViewport,
  readingOrder,
  screenToWorld,
  snapPoint,
  snapTo,
  worldToScreen,
  zoomAt,
  type Viewport,
} from '../dist/pipeline.js'

// The canvas's maths, as plain functions: viewport transforms, fitting, hit testing, edge shape.

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`)

test('screen and world coordinates convert both ways under pan and zoom', () => {
  const v: Viewport = { x: 30, y: -20, zoom: 2 }
  assert.deepEqual(worldToScreen({ x: 10, y: 10 }, v), { x: 50, y: 0 })
  assert.deepEqual(screenToWorld({ x: 50, y: 0 }, v), { x: 10, y: 10 })
  const back = screenToWorld(worldToScreen({ x: -7.5, y: 3.25 }, v), v)
  near(back.x, -7.5)
  near(back.y, 3.25)
  assert.deepEqual(panBy(v, 5, 6), { x: 35, y: -14, zoom: 2 })
})

test('zoomAt keeps the point under the cursor where it is, and respects the limits', () => {
  const v: Viewport = { x: 100, y: 50, zoom: 1 }
  const anchor = { x: 300, y: 200 }
  const before = screenToWorld(anchor, v)
  const zoomed = zoomAt(v, 1.6, anchor)
  assert.equal(zoomed.zoom, 1.6)
  const after = screenToWorld(anchor, zoomed)
  near(after.x, before.x)
  near(after.y, before.y)
  assert.equal(zoomAt(v, 100, anchor).zoom, 2, 'clamped to the largest zoom')
  assert.equal(zoomAt(v, 0.001, anchor).zoom, 0.25, 'clamped to the smallest zoom')
  assert.equal(zoomAt(v, 9, anchor, 0.5, 4).zoom, 4, 'limits can be given')
  assert.equal(zoomAt(v, 1, anchor), v, 'no change, the same object')
})

test('a pinch zooms by the spread of the fingers and pans with their middle', () => {
  const v: Viewport = { x: 0, y: 0, zoom: 1 }
  // The fingers go twice as far apart around the same middle: zoom doubles, the middle stays.
  const spread = pinchViewport(
    v,
    [
      { x: 90, y: 100 },
      { x: 110, y: 100 },
    ],
    [
      { x: 80, y: 100 },
      { x: 120, y: 100 },
    ],
  )
  assert.equal(spread.zoom, 2)
  assert.deepEqual(worldToScreen({ x: 100, y: 100 }, spread), { x: 100, y: 100 })
  // The fingers move together: a pan, no zoom.
  const moved = pinchViewport(
    v,
    [
      { x: 90, y: 100 },
      { x: 110, y: 100 },
    ],
    [
      { x: 120, y: 140 },
      { x: 140, y: 140 },
    ],
  )
  assert.deepEqual(moved, { zoom: 1, x: 30, y: 40 })
  // Fingers on one spot give no distance to divide by.
  const stuck = pinchViewport(
    v,
    [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ],
    [
      { x: 5, y: 5 },
      { x: 9, y: 9 },
    ],
  )
  assert.equal(stuck.zoom, 1)
})

test('boundsOf surrounds every rectangle; fitViewport centres them in the canvas', () => {
  assert.equal(boundsOf([]), undefined)
  const rects = [
    { x: 0, y: 0, width: 200, height: 100 },
    { x: 600, y: 300, width: 200, height: 100 },
  ]
  assert.deepEqual(boundsOf(rects), { x: 0, y: 0, width: 800, height: 400 })

  // A canvas twice the size of the content: no zooming in past 1, the content centred.
  const roomy = fitViewport(rects, { width: 1600, height: 800 })
  assert.equal(roomy.zoom, 1)
  assert.deepEqual(worldToScreen({ x: 400, y: 200 }, roomy), { x: 800, y: 400 })

  // A canvas smaller than the content: zoomed out so that all of it shows, padding kept.
  const tight = fitViewport(rects, { width: 500, height: 400 }, { padding: 50 })
  near(tight.zoom, 0.5)
  const topLeft = worldToScreen({ x: 0, y: 0 }, tight)
  const bottomRight = worldToScreen({ x: 800, y: 400 }, tight)
  assert.ok(topLeft.x >= 50 - 1e-9 && bottomRight.x <= 450 + 1e-9)
  assert.ok(topLeft.y >= 0 && bottomRight.y <= 400)

  // A phone: the padding gives way before the content does.
  const phone = fitViewport(rects, { width: 360, height: 300 })
  assert.ok(phone.zoom >= 0.25 && phone.zoom < 0.5)
  assert.ok(worldToScreen({ x: 0, y: 0 }, phone).x >= 0)
  assert.ok(worldToScreen({ x: 800, y: 0 }, phone).x <= 360)

  // It cannot fit at the smallest zoom allowed: shown from its top-left corner, readable,
  // instead of centred with both ends cut off.
  const start = fitViewport(rects, { width: 360, height: 600 }, { minZoom: 0.7, padding: 24 })
  assert.equal(start.zoom, 0.7)
  assert.deepEqual(worldToScreen({ x: 0, y: 0 }, start), { x: 24, y: 160 })
  assert.ok(worldToScreen({ x: 800, y: 0 }, start).x > 360, 'the far end is off the canvas')

  // Nothing to fit, or nowhere to fit it.
  assert.deepEqual(fitViewport([], { width: 100, height: 100 }), { x: 0, y: 0, zoom: 1 })
  assert.deepEqual(fitViewport(rects, { width: 0, height: 0 }), { x: 0, y: 0, zoom: 1 })
})

test('centerOn and isRectVisible', () => {
  const rect = { x: 1000, y: 1000, width: 200, height: 100 }
  const size = { width: 800, height: 600 }
  assert.equal(isRectVisible(rect, size, { x: 0, y: 0, zoom: 1 }), false)
  const v = centerOn(rect, size, 1.5)
  assert.equal(v.zoom, 1.5)
  assert.deepEqual(worldToScreen({ x: 1100, y: 1050 }, v), { x: 400, y: 300 })
  assert.equal(isRectVisible(rect, size, v), true)
})

test('snapping to a grid, and not snapping without one', () => {
  assert.equal(snapTo(27, 20), 20)
  assert.equal(snapTo(31, 20), 40)
  assert.equal(snapTo(-9, 20), 0, 'never a negative zero')
  assert.equal(snapTo(27.3, 0), 27.3)
  assert.deepEqual(snapPoint({ x: 11, y: 49 }, 20), { x: 20, y: 40 })
})

test('hitNode finds the node under a point, the topmost one where two overlap', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b', x: 50, y: 50, width: 100, height: 100 },
  ]
  assert.equal(hitNode(nodes, { x: 10, y: 10 }), 'a')
  assert.equal(hitNode(nodes, { x: 75, y: 75 }), 'b', 'later nodes are drawn on top')
  assert.equal(hitNode(nodes, { x: 140, y: 140 }), 'b')
  assert.equal(hitNode(nodes, { x: 100, y: 0 }), 'a', 'the border counts')
  assert.equal(hitNode(nodes, { x: 200, y: 10 }), undefined)
})

test('anchors: an edge enters on the left, and leaves by ports spread down the right', () => {
  const rect = { x: 100, y: 100, width: 200, height: 90 }
  assert.deepEqual(inputAnchor(rect), { x: 100, y: 145 })
  assert.deepEqual(outputAnchor(rect), { x: 300, y: 145 })
  assert.deepEqual(outputAnchor(rect, 0, 2), { x: 300, y: 130 })
  assert.deepEqual(outputAnchor(rect, 1, 2), { x: 300, y: 160 })
})

test('a forward edge is an S that leaves and arrives horizontally', () => {
  const curve = edgeCurve({ x: 0, y: 0 }, { x: 200, y: 100 })
  assert.deepEqual(curve.p0, { x: 0, y: 0 })
  assert.deepEqual(curve.p3, { x: 200, y: 100 })
  assert.equal(curve.p1.y, 0, 'leaves level')
  assert.equal(curve.p2.y, 100, 'arrives level: the arrowhead points right')
  assert.ok(curve.p1.x > 0 && curve.p2.x < 200)
  assert.equal(curvePath(curve), 'M 0 0 C 100 0, 100 100, 200 100')
  assert.deepEqual(curvePoint(curve, 0), { x: 0, y: 0 })
  assert.deepEqual(curvePoint(curve, 1), { x: 200, y: 100 })
  assert.deepEqual(curvePoint(curve, 0.5), { x: 100, y: 50 })
})

test('a backward edge (a loop) swings around below instead of crossing its nodes', () => {
  const from = { x: 500, y: 100 }
  const to = { x: 0, y: 100 }
  const curve = edgeCurve(from, to, { clearance: 80 })
  assert.ok(curve.p1.x > from.x, 'it leaves to the right')
  assert.ok(curve.p2.x < to.x, 'it arrives from the left')
  assert.ok(curvePoint(curve, 0.5).y > 100 + 50, 'its middle is well below the nodes')
  // With enough height between the ends there is no need to swing.
  const tall = edgeCurve({ x: 500, y: 0 }, { x: 0, y: 400 }, { clearance: 80 })
  assert.equal(tall.p1.y, 0)
  assert.equal(tall.p2.y, 400)
})

test('distanceToCurve and hitEdge: the nearest edge within reach of the point', () => {
  const straight = edgeCurve({ x: 0, y: 0 }, { x: 300, y: 0 })
  near(distanceToCurve(straight, { x: 150, y: 0 }), 0, 1e-6)
  near(distanceToCurve(straight, { x: 150, y: 12 }), 12, 1e-6)
  near(distanceToCurve(straight, { x: -30, y: 40 }), 50, 1e-6)
  const edges = [
    { id: 'top', curve: straight },
    { id: 'bottom', curve: edgeCurve({ x: 0, y: 100 }, { x: 300, y: 100 }) },
  ]
  assert.equal(hitEdge(edges, { x: 100, y: 3 }), 'top')
  assert.equal(hitEdge(edges, { x: 100, y: 96 }), 'bottom')
  assert.equal(hitEdge(edges, { x: 100, y: 50 }), undefined, 'between them, out of reach')
  assert.equal(hitEdge(edges, { x: 100, y: 50 }, 60), 'top', 'the first of two equally near')
  assert.equal(hitEdge(edges, { x: 100, y: 60 }, 60), 'bottom', 'the nearer one')
})

test('readingOrder walks columns left to right, each from the top', () => {
  const nodes = [
    { id: 'editor', x: 680, y: 180 },
    { id: 'skeptic', x: 340, y: 180 },
    { id: 'planner', x: 0, y: 180 },
    { id: 'practitioner', x: 345, y: 360 },
    { id: 'advocate', x: 338, y: 0 },
  ]
  assert.deepEqual(readingOrder(nodes), [
    'planner',
    'advocate',
    'skeptic',
    'practitioner',
    'editor',
  ])
  assert.deepEqual(readingOrder([]), [])
})

// ── The component, rendered to markup ────────────────────────────────────────

const render = (props: Partial<Parameters<typeof Canvas>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(Canvas, {
      nodes: [
        { id: 'a', x: 0, y: 0, label: 'Writer', description: 'running.' },
        { id: 'b', x: 300, y: 0, label: 'Reviewer' },
      ],
      edges: [{ id: 'e0', from: 'a', to: 'b', label: 'approved' }],
      renderNode: (node) => createElement('div', { className: 'card' }, node.label),
      ...props,
    }),
  )

test('a screen reader hears each node, its state, what it connects to, and each edge', () => {
  const out = render()
  assert.match(out, /role="application"[^>]*aria-label="Canvas"/)
  assert.match(out, /aria-roledescription="node"[^>]*aria-label="Writer"/)
  assert.match(out, /running\. Connects to: Reviewer \(approved\)\./)
  assert.match(out, /Receives from: Writer\./)
  assert.match(out, /aria-label="Connection from Writer to Reviewer: approved"/)
  assert.match(out, /aria-label="Connect Writer to another node"/)
  // Nodes and edges are in the tab order, a node before the edges that leave it.
  assert.ok(
    out.indexOf('data-awr-node="a"') <
      out.indexOf('<button type="button" class="awr-canvas__edge-handle'),
  )
  assert.ok(out.indexOf('awr-canvas__edge-handle') < out.indexOf('data-awr-node="b"'))
  assert.match(out, /Tab moves between nodes/)
})

test('the canvas takes its strings from `labels`, shows selection, and can hide its controls', () => {
  const out = render({
    labels: { canvas: 'Схема', zoomIn: 'Ближе', edge: (from, to) => `${from} → ${to}` },
    selection: { kind: 'edge', id: 'e0' },
  })
  assert.match(out, /aria-label="Схема"/)
  assert.match(out, /aria-label="Ближе"/)
  assert.match(out, /aria-label="Writer → Reviewer"/)
  assert.match(out, /awr-canvas__edge--selected/)
  assert.match(out, /aria-pressed="true"/)
  assert.match(out, /awr-canvas__controls/)
  assert.doesNotMatch(render({ showControls: false }), /awr-canvas__controls/)
  assert.match(render({ selection: { kind: 'node', id: 'b' } }), /awr-canvas__node--selected/)
})

test('a node with declared ports draws only the ports its renderer places', () => {
  const out = render({
    nodes: [
      {
        id: 'a',
        x: 0,
        y: 0,
        label: 'Reviewer',
        ports: [{ id: 'out' }, { id: 'route:approved', label: 'approved' }],
      },
      { id: 'b', x: 300, y: 0, label: 'Publisher' },
    ],
    edges: [{ id: 'e0', from: 'a', to: 'b', fromPort: 'route:approved' }],
    renderNode: (node) =>
      node.id === 'a'
        ? createElement(CanvasPort, { id: 'route:approved', label: 'approved' })
        : createElement('span', null, node.label),
  })
  assert.match(
    out,
    /data-awr-port="route:approved"[^>]*aria-label="Connect Reviewer \(approved\) to another node"/,
  )
  assert.equal(out.match(/data-awr-port=/g)?.length, 2, 'one placed port, one default on the other')
  const locked = render({ readOnly: true })
  assert.equal(
    locked.match(/data-awr-port="[^"]*"[^>]*disabled=""/g)?.length,
    locked.match(/data-awr-port=/g)?.length,
    'read-only: no port can start a connection',
  )
})

test('the canvas layer imports nothing from the rest of the package, nor from the core', () => {
  const dir = new URL('../src/canvas/', import.meta.url)
  for (const file of readdirSync(dir)) {
    const source = readFileSync(new URL(file, dir), 'utf8')
    for (const [, target] of source.matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(
        target === 'react' || target.startsWith('./'),
        `src/canvas/${file} imports ${target}: the canvas must stay liftable into its own package`,
      )
    }
  }
})
