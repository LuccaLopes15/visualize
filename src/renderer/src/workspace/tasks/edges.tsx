import { useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'

export type DepFlowEdge = Edge<{ aggregated: boolean }, 'dep'>

/** "depende de": dashed accent edge, arrow at the dependency; the label shows on hover / selection. */
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
  const [path, lx, ly] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.3
  })
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
