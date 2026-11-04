import { useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import type { Point } from './layout'
import { midpoint, roundedPath } from './route'

export type DepFlowEdge = Edge<{ aggregated: boolean; route: Point[] | null }, 'dep'>

/**
 * The precomputed route only holds while the cards are where the layout put them (not mid-drag).
 * React Flow reports the handle centres, which sit ~10px outside the card edge the route starts from.
 */
function routeMatches(route: Point[], sx: number, sy: number, tx: number, ty: number): boolean {
  const a = route[0]
  const b = route[route.length - 1]
  const tol = 14
  return Math.abs(a.x - sx) <= tol && Math.abs(a.y - sy) <= tol && Math.abs(b.x - tx) <= tol && Math.abs(b.y - ty) <= tol
}

/**
 * "depende de": dashed accent edge, arrow at the dependency; the label shows on hover / selection.
 * Drawn as an orthogonal route around the other cards when the straight curve would pass behind them.
 */
export function DepEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data
}: EdgeProps<DepFlowEdge>): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const route = data?.route && data.route.length >= 2 && routeMatches(data.route, sourceX, sourceY, targetX, targetY) ? data.route : null
  let path: string
  let lx: number
  let ly: number
  if (route) {
    // endpoints = the real handle positions; the middle of the route comes from the layout
    const pts = [{ x: sourceX, y: sourceY }, ...route.slice(1, -1), { x: targetX, y: targetY }]
    path = roundedPath(pts, 10)
    const m = midpoint(pts)
    lx = m.x
    ly = m.y
  } else {
    ;[path, lx, ly] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      curvature: 0.3
    })
  }
  return (
    <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={24} className="tk-dep" />
      {(hover || selected) && (
        <EdgeLabelRenderer>
          <div
            className="tk-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
          >
            depende de{data?.aggregated ? ' (itens recolhidos)' : ''}
            {selected && !data?.aggregated ? ' · Delete remove' : ''}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  )
}
