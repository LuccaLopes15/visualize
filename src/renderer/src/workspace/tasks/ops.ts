// Pure decision helpers for the Tarefas UI (what is allowed, what to confirm).
import { buildChildrenIndex, collectSubtree, wouldCreateDepCycle, wouldCreateHierarchyCycle } from '@shared/plan'
import type { PlanGraph, PlanNode } from '@shared/types'

export type ConnectMode = 'dep' | 'child'

/** Siblings of `node` (same parent; stories = all stories), ordered by `sort`. */
export function siblingsOf(nodes: readonly PlanNode[], node: Pick<PlanNode, 'parentId'>): PlanNode[] {
  return (buildChildrenIndex(nodes).get(node.parentId) ?? []) as PlanNode[]
}

/**
 * New position (0-based among its siblings) after moving `id` one slot (-1 = before, +1 = after), or
 * null when it is already at that end. Feed it to `plan.updateNode(id, { sort })`: one atomic
 * server-side move instead of sending a (possibly stale) full sibling list.
 */
export function moveTarget(nodes: readonly PlanNode[], id: string, delta: -1 | 1): number | null {
  const node = nodes.find((n) => n.id === id)
  if (!node) return null
  const siblings = siblingsOf(nodes, node)
  const i = siblings.findIndex((n) => n.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= siblings.length) return null
  return j
}

/** The node was deleted (by Claude / another window) while a pending edit was still being written. */
export function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /não encontrad/i.test(err.message)
}

/** Ancestors of `id`, nearest first (parent, grandparent, ... story). */
export function ancestorsOf(nodes: readonly PlanNode[], id: string): PlanNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: PlanNode[] = []
  let cur = byId.get(id)?.parentId ?? null
  while (cur !== null && out.length < 1000) {
    const p = byId.get(cur)
    if (!p) break
    out.push(p)
    cur = p.parentId
  }
  return out
}

/** Nodes `id` may be reparented under: everything except itself and its descendants. */
export function parentOptions(nodes: readonly PlanNode[], id: string): PlanNode[] {
  return nodes.filter((n) => !wouldCreateHierarchyCycle(nodes, id, n.id))
}

export interface DepCandidate {
  node: PlanNode
  /** Why it can't be picked (listed but disabled). */
  blocked: null | 'exists' | 'cycle'
}

/** Nodes `id` could depend on, flagging the ones that would be rejected. */
export function depCandidates(graph: PlanGraph, id: string): DepCandidate[] {
  const existing = new Set(graph.deps.filter((d) => d.fromId === id).map((d) => d.toId))
  return graph.nodes
    .filter((n) => n.id !== id)
    .map((node) => ({
      node,
      blocked: existing.has(node.id) ? 'exists' : wouldCreateDepCycle(graph.deps, id, node.id) ? 'cycle' : null
    }))
}

export interface DeleteImpact {
  /** Node + descendants, pre-order. */
  ids: string[]
  /** Descendants only. */
  descendants: number
  /** Nodes in the subtree that already have an Azure DevOps ticket. */
  ticketed: PlanNode[]
  /** Dependencies (either side) that disappear with the subtree. */
  deps: number
}

export function deleteImpact(graph: PlanGraph, id: string): DeleteImpact {
  const ids = collectSubtree(graph.nodes, id)
  const set = new Set(ids)
  return {
    ids,
    descendants: Math.max(0, ids.length - 1),
    ticketed: graph.nodes.filter((n) => set.has(n.id) && n.devopsId !== null),
    deps: graph.deps.filter((d) => set.has(d.fromId) || set.has(d.toId)).length
  }
}

/**
 * Pre-check for a connection drawn on the canvas. `source` is where the drag
 * started. Dependency mode: source depende de target. Child mode: source
 * becomes the parent of target. Returns a pt-BR message, or null when allowed
 * (the server stays the authority and re-validates).
 */
export function checkConnection(graph: PlanGraph, mode: ConnectMode, sourceId: string, targetId: string): string | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const source = byId.get(sourceId)
  const target = byId.get(targetId)
  if (!source || !target) return 'Esse item não existe mais.'
  if (sourceId === targetId) return 'Escolha outro cartão: um item não pode se ligar a si mesmo.'
  if (mode === 'dep') {
    if (graph.deps.some((d) => d.fromId === sourceId && d.toId === targetId)) {
      return `"${source.title}" já depende de "${target.title}".`
    }
    const cycle = wouldCreateDepCycle(graph.deps, sourceId, targetId)
    if (cycle) {
      const title = (id: string): string => `"${byId.get(id)?.title ?? id}"`
      return `Dependência circular: ${cycle.map(title).join(' → ')}.`
    }
    return null
  }
  if (target.kind === 'story') return 'Histórias não podem ter pai: só tarefas podem ser movidas.'
  if (target.parentId === sourceId) return `"${target.title}" já é filha de "${source.title}".`
  if (wouldCreateHierarchyCycle(graph.nodes, targetId, sourceId)) {
    return `Não dá para mover "${target.title}" para dentro de "${source.title}": ela é descendente da tarefa movida.`
  }
  return null
}

/** One-line plain-text preview of a markdown description (first meaningful line, markup stripped). */
export function descriptionPreview(markdown: string, max = 140): string {
  for (const raw of markdown.split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim()
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }
  return ''
}
