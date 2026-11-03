// Auto-layout of the plan graph with dagre. Pure (no React / DOM): unit-tested.
//
// Each story gets its own dagre layout (hierarchy edges only) and becomes a
// "lane" (tinted by project). Lanes are packed side by side (TB) or stacked (LR),
// so nodes can never overlap across stories.
import { graphlib, layout } from '@dagrejs/dagre'
import type { PlanNode } from '@shared/types'

export type LayoutDir = 'TB' | 'LR'

export const STORY_SIZE = { w: 300, h: 116 } as const
export const TASK_SIZE = { w: 250, h: 96 } as const
export const NODE_SEP = 28
export const RANK_SEP = 56
export const LANE_PAD_X = 28
export const LANE_PAD_TOP = 40 // room for the lane label
export const LANE_PAD_BOTTOM = 28
export const LANE_GAP = 56

export interface Point {
  x: number
  y: number
}
export interface Rect extends Point {
  w: number
  h: number
}
export interface Lane extends Rect {
  storyId: string
  projectId: number
}
export interface LayoutResult {
  /** id -> top-left corner of the node. */
  positions: Map<string, Point>
  /** One per story, same order as the stories. */
  lanes: Lane[]
}

export function nodeSize(kind: PlanNode['kind']): { w: number; h: number } {
  return kind === 'story' ? STORY_SIZE : TASK_SIZE
}

/**
 * `nodes` must be a hierarchy pre-order list (as `PlanGraph.nodes`, optionally
 * with collapsed subtrees removed): every parent precedes its children.
 */
export function layoutPlan(
  nodes: readonly Pick<PlanNode, 'id' | 'kind' | 'parentId' | 'rootStoryId' | 'projectId'>[],
  dir: LayoutDir
): LayoutResult {
  const groups = new Map<string, typeof nodes[number][]>()
  for (const n of nodes) {
    const g = groups.get(n.rootStoryId)
    if (g) g.push(n)
    else groups.set(n.rootStoryId, [n])
  }

  const positions = new Map<string, Point>()
  const lanes: Lane[] = []
  let cursor = 0

  for (const [storyId, members] of groups) {
    const g = new graphlib.Graph()
    g.setGraph({ rankdir: dir, nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: 0, marginy: 0 })
    g.setDefaultEdgeLabel(() => ({}))
    const ids = new Set(members.map((m) => m.id))
    for (const m of members) {
      const s = nodeSize(m.kind)
      g.setNode(m.id, { width: s.w, height: s.h })
    }
    // dagre's initial ordering walks the edges back to front, so inserting
    // them in reverse keeps siblings in `sort` order along the cross axis.
    for (let i = members.length - 1; i >= 0; i--) {
      const m = members[i]
      if (m.parentId !== null && ids.has(m.parentId)) g.setEdge(m.parentId, m.id)
    }
    layout(g)

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const m of members) {
      const p = g.node(m.id)
      const s = nodeSize(m.kind)
      minX = Math.min(minX, p.x - s.w / 2)
      minY = Math.min(minY, p.y - s.h / 2)
      maxX = Math.max(maxX, p.x + s.w / 2)
      maxY = Math.max(maxY, p.y + s.h / 2)
    }
    const laneW = maxX - minX + LANE_PAD_X * 2
    const laneH = maxY - minY + LANE_PAD_TOP + LANE_PAD_BOTTOM
    const laneX = dir === 'TB' ? cursor : 0
    const laneY = dir === 'TB' ? 0 : cursor
    for (const m of members) {
      const p = g.node(m.id)
      const s = nodeSize(m.kind)
      positions.set(m.id, {
        x: Math.round(laneX + LANE_PAD_X + (p.x - s.w / 2 - minX)),
        y: Math.round(laneY + LANE_PAD_TOP + (p.y - s.h / 2 - minY))
      })
    }
    lanes.push({
      storyId,
      projectId: members[0].projectId,
      x: Math.round(laneX),
      y: Math.round(laneY),
      w: Math.round(laneW),
      h: Math.round(laneH)
    })
    cursor += (dir === 'TB' ? laneW : laneH) + LANE_GAP
  }
  return { positions, lanes }
}
