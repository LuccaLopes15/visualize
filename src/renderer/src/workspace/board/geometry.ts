// Plain geometry for board elements (no Excalidraw imports: unit-testable).

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Fields of an Excalidraw element we read (they have many more). */
export interface ElementLike {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle?: number
  isDeleted?: boolean
  points?: readonly (readonly [number, number])[]
  text?: string
  originalText?: string
  containerId?: string | null
  frameId?: string | null
  name?: string | null
  strokeColor?: string
  backgroundColor?: string
  strokeStyle?: string
  boundElements?: readonly { id: string; type: string }[] | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  version?: number
}

export function elementBBox(e: ElementLike): BBox {
  if (e.points && e.points.length) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [px, py] of e.points) {
      minX = Math.min(minX, e.x + px)
      minY = Math.min(minY, e.y + py)
      maxX = Math.max(maxX, e.x + px)
      maxY = Math.max(maxY, e.y + py)
    }
    return { minX, minY, maxX, maxY }
  }
  return { minX: e.x, minY: e.y, maxX: e.x + e.width, maxY: e.y + e.height }
}

export function unionBBox(elements: readonly ElementLike[]): BBox | null {
  let out: BBox | null = null
  for (const e of elements) {
    if (e.isDeleted) continue
    const b = elementBBox(e)
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          minY: Math.min(out.minY, b.minY),
          maxX: Math.max(out.maxX, b.maxX),
          maxY: Math.max(out.maxY, b.maxY)
        }
      : b
  }
  return out
}

/** Where new content goes: to the right of everything already on the board. */
export const FREE_SPACE_GAP = 140

export function freeSpaceOrigin(existing: readonly ElementLike[]): { x: number; y: number } {
  const bb = unionBBox(existing)
  if (!bb) return { x: 0, y: 0 }
  return { x: Math.round(bb.maxX + FREE_SPACE_GAP), y: Math.round(bb.minY) }
}

export function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return (
    a.x < b.x + b.width + margin &&
    b.x < a.x + a.width + margin &&
    a.y < b.y + b.height + margin &&
    b.y < a.y + a.height + margin
  )
}

const center = (b: Box): [number, number] => [b.x + b.width / 2, b.y + b.height / 2]

/**
 * Point where the segment from the center of `b` towards (tx, ty) leaves the
 * box, pushed `gap` px further out (Excalidraw keeps a small gap at bindings).
 */
export function boxExitPoint(b: Box, tx: number, ty: number, gap = 6): [number, number] {
  const [cx, cy] = center(b)
  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const hw = b.width / 2 + gap
  const hh = b.height / 2 + gap
  const t = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity)
  return [cx + dx * t, cy + dy * t]
}

/** Straight arrow geometry between two boxes (absolute start + relative points). */
export function arrowBetween(from: Box, to: Box, gap = 6): { x: number; y: number; points: [number, number][] } {
  const [tcx, tcy] = center(to)
  const [fcx, fcy] = center(from)
  const [sx, sy] = boxExitPoint(from, tcx, tcy, gap)
  const [ex, ey] = boxExitPoint(to, fcx, fcy, gap)
  return { x: sx, y: sy, points: [[0, 0], [ex - sx, ey - sy]] }
}

/** Drops intermediate points that sit on the line between their neighbours. */
export function simplifyPolyline(points: [number, number][], tolerance = 1): [number, number][] {
  if (points.length <= 2) return points
  const out: [number, number][] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = out[out.length - 1]
    const [bx, by] = points[i]
    const [cx, cy] = points[i + 1]
    const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
    const len = Math.hypot(cx - ax, cy - ay) || 1
    if (cross / len > tolerance) out.push(points[i])
  }
  out.push(points[points.length - 1])
  return out
}

/** Merges boxes that touch or sit within `gap` px of each other (freehand strokes → regions). */
export function clusterBoxes(boxes: BBox[], gap = 40): { box: BBox; count: number }[] {
  const clusters = boxes.map((box) => ({ box: { ...box }, count: 1 }))
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i].box
        const b = clusters[j].box
        if (a.minX - gap <= b.maxX && b.minX - gap <= a.maxX && a.minY - gap <= b.maxY && b.minY - gap <= a.maxY) {
          clusters[i] = {
            box: {
              minX: Math.min(a.minX, b.minX),
              minY: Math.min(a.minY, b.minY),
              maxX: Math.max(a.maxX, b.maxX),
              maxY: Math.max(a.maxY, b.maxY)
            },
            count: clusters[i].count + clusters[j].count
          }
          clusters.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return clusters
}
