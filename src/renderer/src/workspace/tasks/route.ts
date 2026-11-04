// Routing of dependency edges around cards (pure: unit-tested). The default curve is a bezier
// between the two handles; when it would run behind other cards (cross-story dependencies on the
// same row, dependencies spanning several rows) an orthogonal route through the free channels
// between rows / cards is used instead.
import type { HandleId } from './flow'
import type { LayoutDir, Point, Rect } from './layout'

/** Length of the stub leaving a handle, and the offset of the horizontal channels from a row (hierarchy connectors run at half the 56px rank gap, so keep clear of them). */
const STUB = 20
const CHANNEL = 16
/** Obstacles are inflated by this much so a route never grazes a card. */
const MARGIN = 3

function handlePoint(r: Rect, h: HandleId): Point {
  switch (h) {
    case 'l':
      return { x: r.x, y: r.y + r.h / 2 }
    case 'r':
      return { x: r.x + r.w, y: r.y + r.h / 2 }
    case 't':
      return { x: r.x + r.w / 2, y: r.y }
    default:
      return { x: r.x + r.w / 2, y: r.y + r.h }
  }
}

/** Does the segment a-b touch the rectangle (inflated by `m`)? (Liang-Barsky slab clipping.) */
export function segmentHitsRect(a: Point, b: Point, r: Rect, m = MARGIN): boolean {
  const minX = r.x - m
  const maxX = r.x + r.w + m
  const minY = r.y - m
  const maxY = r.y + r.h + m
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return clip(-dx, a.x - minX) && clip(dx, maxX - a.x) && clip(-dy, a.y - minY) && clip(dy, maxY - a.y)
}

function polylineHits(points: Point[], obstacles: Rect[]): number {
  let hits = 0
  for (const o of obstacles) {
    for (let i = 0; i + 1 < points.length; i++) {
      if (segmentHitsRect(points[i], points[i + 1], o)) {
        hits++
        break
      }
    }
  }
  return hits
}

const length = (pts: Point[]): number => {
  let l = 0
  for (let i = 0; i + 1 < pts.length; i++) l += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
  return l
}

/** Drops repeated points (zero-length segments). */
function dedupe(pts: Point[]): Point[] {
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y)
}

const transposeRect = (r: Rect): Rect => ({ x: r.y, y: r.x, w: r.h, h: r.w })
const transposePoint = (p: Point): Point => ({ x: p.y, y: p.x })
const transposeHandle = (h: HandleId): HandleId => ({ l: 't', r: 'b', t: 'l', b: 'r' })[h] as HandleId

/** Core, in the "TB frame": the edge leaves/enters through left/right handles. */
function routeSides(from: Rect, to: Rect, sH: HandleId, tH: HandleId, obstacles: Rect[]): Point[] | null {
  const s = handlePoint(from, sH)
  const t = handlePoint(to, tH)
  if (polylineHits([s, t], obstacles) === 0) return null // the plain curve is clear

  const sDir = sH === 'r' ? 1 : -1
  const tDir = tH === 'r' ? 1 : -1
  const s1: Point = { x: s.x + sDir * STUB, y: s.y }
  const t1: Point = { x: t.x + tDir * STUB, y: t.y }
  const candidates: Point[][] = []

  // Horizontal channels above / below the rows of both cards.
  const ys = new Set<number>()
  for (const r of [from, to]) {
    ys.add(r.y - CHANNEL)
    ys.add(r.y + r.h + CHANNEL)
  }
  for (const cy of ys) candidates.push([s, s1, { x: s1.x, y: cy }, { x: t1.x, y: cy }, t1, t])

  // One vertical channel between / beside the cards (Z or C shape).
  const mx = sDir === tDir ? (sDir > 0 ? Math.max(s1.x, t1.x) : Math.min(s1.x, t1.x)) : (s.x + t.x) / 2
  candidates.push([s, { x: mx, y: s.y }, { x: mx, y: t.y }, t])

  let best: { pts: Point[]; hits: number; len: number } | null = null
  for (const c of candidates) {
    const pts = dedupe(c)
    const hits = polylineHits(pts, obstacles)
    const len = length(pts)
    if (!best || hits < best.hits || (hits === best.hits && len < best.len)) best = { pts, hits, len }
  }
  return best ? best.pts : null
}

/**
 * Orthogonal route for a dependency edge, or null when the default curve between the handles does
 * not cross any other card. `from`/`to` are the two cards; `others` every other visible card.
 * The returned polyline starts at the source handle and ends at the target handle.
 */
export function routeDependency(
  dir: LayoutDir,
  sourceHandle: HandleId,
  targetHandle: HandleId,
  from: Rect,
  to: Rect,
  others: readonly Rect[]
): Point[] | null {
  if (dir === 'TB') return routeSides(from, to, sourceHandle, targetHandle, others as Rect[])
  const pts = routeSides(
    transposeRect(from),
    transposeRect(to),
    transposeHandle(sourceHandle),
    transposeHandle(targetHandle),
    others.map(transposeRect)
  )
  return pts ? pts.map(transposePoint) : null
}

/** SVG path through `points` with rounded corners (radius `r`, capped by half of each adjacent segment). */
export function roundedPath(points: readonly Point[], r = 10): string {
  if (points.length === 0) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1]
    const p = points[i]
    const p2 = points[i + 1]
    const l1 = Math.hypot(p.x - p0.x, p.y - p0.y)
    const l2 = Math.hypot(p2.x - p.x, p2.y - p.y)
    const rr = Math.min(r, l1 / 2, l2 / 2)
    if (rr <= 0) {
      d += ` L ${p.x} ${p.y}`
      continue
    }
    const a = { x: p.x + ((p0.x - p.x) / l1) * rr, y: p.y + ((p0.y - p.y) / l1) * rr }
    const b = { x: p.x + ((p2.x - p.x) / l2) * rr, y: p.y + ((p2.y - p.y) / l2) * rr }
    d += ` L ${a.x} ${a.y} Q ${p.x} ${p.y} ${b.x} ${b.y}`
  }
  const last = points[points.length - 1]
  if (points.length > 1) d += ` L ${last.x} ${last.y}`
  return d
}

/** Point halfway along the polyline (where the hover label goes). */
export function midpoint(points: readonly Point[]): Point {
  const total = length(points as Point[])
  let acc = 0
  for (let i = 0; i + 1 < points.length; i++) {
    const seg = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y)
    if (acc + seg >= total / 2 && seg > 0) {
      const t = (total / 2 - acc) / seg
      return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t }
    }
    acc += seg
  }
  return points[0] ?? { x: 0, y: 0 }
}
