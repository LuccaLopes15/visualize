// Plan graph -> flow model (visible nodes, lanes, edges, handles). Pure: no
// React Flow import, so it is unit-tested in Node. The React layer only maps
// these specs onto React Flow nodes/edges.
import type { PlanDep, PlanGraph, PlanNode } from '@shared/types'
import { layoutPlan, nodeSize, type Lane, type LayoutDir, type Point } from './layout'

export type HandleId = 't' | 'b' | 'l' | 'r'

export interface FlowNodeSpec {
  node: PlanNode
  position: Point
  /** Direct children (always the real count, even when collapsed). */
  childCount: number
  collapsed: boolean
  /** Descendants hidden by collapsing this node. */
  hiddenCount: number
}

export interface FlowEdgeSpec {
  /** `h:<parent>><child>` or `d:<from>><to>`. */
  id: string
  kind: 'hier' | 'dep'
  /** React Flow source/target. Hierarchy: parent -> child. Dependency: dependent -> dependency. */
  source: string
  target: string
  sourceHandle: HandleId
  targetHandle: HandleId
  /**
   * Dependency drawn between visible ancestors because a real endpoint is
   * hidden by a collapsed branch (not individually removable).
   */
  aggregated: boolean
}

export interface FlowModel {
  nodes: FlowNodeSpec[]
  lanes: Lane[]
  edges: FlowEdgeSpec[]
  /** Changes only when node positions would change (structure / order / direction / collapse). */
  layoutKey: string
}

export function directChildCounts(nodes: readonly Pick<PlanNode, 'id' | 'parentId'>[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const n of nodes) if (n.parentId !== null) m.set(n.parentId, (m.get(n.parentId) ?? 0) + 1)
  return m
}

/** Nodes not hidden by a collapsed ancestor (input must be hierarchy pre-order). */
export function visibleNodes(nodes: readonly PlanNode[], collapsed: ReadonlySet<string>): PlanNode[] {
  const hidden = new Set<string>()
  const out: PlanNode[] = []
  for (const n of nodes) {
    if (n.parentId !== null && (hidden.has(n.parentId) || collapsed.has(n.parentId))) {
      hidden.add(n.id)
      continue
    }
    out.push(n)
  }
  return out
}

/** Handles for a dependency edge (dependent -> dependency), using the free sides so it never runs over the hierarchy edge. */
export function depHandles(
  dir: LayoutDir,
  from: { pos: Point; size: { w: number; h: number } },
  to: { pos: Point; size: { w: number; h: number } }
): { source: HandleId; target: HandleId } {
  if (dir === 'TB') {
    const dx = to.pos.x + to.size.w / 2 - (from.pos.x + from.size.w / 2)
    if (Math.abs(dx) < 8) return { source: 'r', target: 'r' }
    return dx > 0 ? { source: 'r', target: 'l' } : { source: 'l', target: 'r' }
  }
  const dy = to.pos.y + to.size.h / 2 - (from.pos.y + from.size.h / 2)
  if (Math.abs(dy) < 8) return { source: 'b', target: 'b' }
  return dy > 0 ? { source: 'b', target: 't' } : { source: 't', target: 'b' }
}

export function buildFlow(graph: PlanGraph, opts: { dir: LayoutDir; collapsed: ReadonlySet<string> }): FlowModel {
  const { dir, collapsed } = opts
  const visible = visibleNodes(graph.nodes, collapsed)
  const visibleIds = new Set(visible.map((n) => n.id))
  const { positions, lanes } = layoutPlan(visible, dir)
  const childCounts = directChildCounts(graph.nodes)

  // Descendant totals (for the "+N" badge of collapsed nodes).
  const descendants = new Map<string, number>()
  for (let i = graph.nodes.length - 1; i >= 0; i--) {
    const n = graph.nodes[i]
    const own = descendants.get(n.id) ?? 0
    if (n.parentId !== null) descendants.set(n.parentId, (descendants.get(n.parentId) ?? 0) + own + 1)
  }

  const nodes: FlowNodeSpec[] = visible.map((n) => ({
    node: n,
    position: positions.get(n.id) as Point,
    childCount: childCounts.get(n.id) ?? 0,
    collapsed: collapsed.has(n.id) && (childCounts.get(n.id) ?? 0) > 0,
    hiddenCount: collapsed.has(n.id) ? (descendants.get(n.id) ?? 0) : 0
  }))
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const kindOf = (id: string): PlanNode['kind'] => (byId.get(id) as PlanNode).kind

  const edges: FlowEdgeSpec[] = []
  const hierSrc: HandleId = dir === 'TB' ? 'b' : 'r'
  const hierTgt: HandleId = dir === 'TB' ? 't' : 'l'
  for (const n of visible) {
    if (n.parentId === null || !visibleIds.has(n.parentId)) continue
    edges.push({
      id: `h:${n.parentId}>${n.id}`,
      kind: 'hier',
      source: n.parentId,
      target: n.id,
      sourceHandle: hierSrc,
      targetHandle: hierTgt,
      aggregated: false
    })
  }

  const visibleAncestor = (id: string): string => {
    let cur = id
    while (!visibleIds.has(cur)) {
      const p = byId.get(cur)?.parentId
      if (p === null || p === undefined) break
      cur = p
    }
    return cur
  }
  const seen = new Set<string>()
  for (const d of graph.deps as readonly PlanDep[]) {
    if (!byId.has(d.fromId) || !byId.has(d.toId)) continue
    const from = visibleAncestor(d.fromId)
    const to = visibleAncestor(d.toId)
    if (from === to || !visibleIds.has(from) || !visibleIds.has(to)) continue
    const id = `d:${from}>${to}`
    if (seen.has(id)) continue
    seen.add(id)
    const h = depHandles(
      dir,
      { pos: positions.get(from) as Point, size: nodeSize(kindOf(from)) },
      { pos: positions.get(to) as Point, size: nodeSize(kindOf(to)) }
    )
    edges.push({
      id,
      kind: 'dep',
      source: from,
      target: to,
      sourceHandle: h.source,
      targetHandle: h.target,
      aggregated: from !== d.fromId || to !== d.toId
    })
  }

  const layoutKey = `${dir}|${visible.map((n) => `${n.id}:${n.parentId ?? ''}:${n.sort}:${n.kind}`).join(',')}`
  return { nodes, lanes, edges, layoutKey }
}

/** Ids that no longer exist are dropped (selection / collapsed state across refetches). */
export function pruneIds(ids: ReadonlySet<string>, graph: PlanGraph): Set<string> {
  const alive = new Set(graph.nodes.map((n) => n.id))
  const out = new Set<string>()
  for (const id of ids) if (alive.has(id)) out.add(id)
  return out.size === ids.size ? (ids as Set<string>) : out
}
