// Fase 4: pure helpers for the plan graph (stories/tasks hierarchy + dependency
// DAG). No I/O, no Node/DOM APIs: used by main (repository, MCP tools), the
// renderer (React Flow layout) and, in Fase 5, the Azure DevOps ticket creator.
import type { PlanDep, PlanNode, RawPlanNode } from './types'

/** Stable machine codes of every rule violation (messages are pt-BR, for the user/Claude). */
export const PLAN_ERROR_CODES = [
  'not_found', // idea / node does not exist
  'cross_idea', // node belongs to another idea
  'invalid_title', // empty / too long title
  'invalid_input', // wrong type, bad index, bad description...
  'story_needs_project', // story without projectId
  'project_not_linked', // story project is not linked to the idea
  'story_has_parent', // a story cannot have a parent
  'task_needs_parent', // a task must have a parent
  'task_project_derived', // tasks cannot hold a project of their own
  'hierarchy_cycle', // reparenting under itself / a descendant
  'dep_self', // a node cannot depend on itself
  'dep_duplicate', // dependency already exists
  'dep_cycle', // would create a circular dependency
  'project_in_use', // stories still reference the project (unlink / delete guard)
  'ticketed_nodes', // operation would delete nodes that already have a DevOps ticket
  'spec_invalid' // malformed replaceAll / mergeAdd spec
] as const
export type PlanErrorCode = (typeof PLAN_ERROR_CODES)[number]

/** Rule violation with a user-facing (pt-BR) `message` and a stable `code`. */
export class PlanError extends Error {
  constructor(
    public readonly code: PlanErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PlanError'
  }
}

// ---- hierarchy ---------------------------------------------------------------

export interface TreeNode {
  id: string
  parentId: string | null
  /** Sibling order; missing = 0. Ties keep input order. */
  sort?: number
}

/** children[parentId ?? null] -> children ordered by `sort` (stable). */
export function buildChildrenIndex<T extends TreeNode>(nodes: readonly T[]): Map<string | null, T[]> {
  const index = new Map<string | null, T[]>()
  for (const n of nodes) {
    const arr = index.get(n.parentId)
    if (arr) arr.push(n)
    else index.set(n.parentId, [n])
  }
  for (const arr of index.values()) {
    // Array.prototype.sort is stable: equal sorts keep input order.
    arr.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  }
  return index
}

/**
 * Hierarchy in topological order: every parent comes before its children
 * (pre-order DFS; siblings by `sort`). Throws `hierarchy_cycle` if some node is
 * unreachable from a root (parent cycle, or parent missing from `nodes`).
 */
export function topoOrderHierarchy<T extends TreeNode>(nodes: readonly T[]): T[] {
  const children = buildChildrenIndex(nodes)
  const out: T[] = []
  const stack: T[] = [...(children.get(null) ?? [])].reverse()
  while (stack.length > 0) {
    const n = stack.pop() as T
    out.push(n)
    const kids = children.get(n.id)
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  if (out.length !== nodes.length) {
    throw new PlanError('hierarchy_cycle', 'A hierarquia do plano está inconsistente (ciclo ou pai inexistente).')
  }
  return out
}

/** Ids of `rootId` and all its descendants, pre-order (root first). Unknown root -> []. */
export function collectSubtree(nodes: readonly TreeNode[], rootId: string): string[] {
  if (!nodes.some((n) => n.id === rootId)) return []
  const children = buildChildrenIndex(nodes)
  const out: string[] = []
  const seen = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    const kids = children.get(id)
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i].id)
  }
  return out
}

/** True when `candidateId` is a strict descendant of `ancestorId`. */
export function isDescendant(nodes: readonly TreeNode[], ancestorId: string, candidateId: string): boolean {
  if (ancestorId === candidateId) return false
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let cur = byId.get(candidateId)?.parentId ?? null
  const seen = new Set<string>()
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestorId) return true
    seen.add(cur)
    cur = byId.get(cur)?.parentId ?? null
  }
  return false
}

/**
 * Reparenting `nodeId` under `newParentId` creates a parent cycle when the new
 * parent is the node itself or one of its descendants.
 */
export function wouldCreateHierarchyCycle(
  nodes: readonly TreeNode[],
  nodeId: string,
  newParentId: string | null
): boolean {
  if (newParentId === null) return false
  return newParentId === nodeId || isDescendant(nodes, nodeId, newParentId)
}

/** Id of the topmost ancestor (the node itself if it has no parent). null if unknown / broken chain. */
export function findRootId(nodes: readonly TreeNode[], id: string): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let cur = byId.get(id)
  const seen = new Set<string>()
  while (cur) {
    if (seen.has(cur.id)) return null
    seen.add(cur.id)
    if (cur.parentId === null) return cur.id
    cur = byId.get(cur.parentId)
  }
  return null
}

/** Root story of a node (the story itself for stories). null if unknown / broken chain. */
export function findRootStory(nodes: readonly (TreeNode & { kind: string })[], id: string): string | null {
  const root = findRootId(nodes, id)
  if (root === null) return null
  return nodes.find((n) => n.id === root)?.kind === 'story' ? root : null
}

/**
 * Turns stored rows into `PlanNode`s: derives `projectId` (root story's),
 * `rootStoryId`, `depth`, `devopsStale`, and returns them in hierarchy
 * pre-order. Throws `hierarchy_cycle` on broken data.
 */
export function resolvePlanNodes(raw: readonly RawPlanNode[]): PlanNode[] {
  const ordered = topoOrderHierarchy(raw)
  const derived = new Map<string, { projectId: number; rootStoryId: string; depth: number }>()
  const out: PlanNode[] = []
  for (const n of ordered) {
    let info: { projectId: number; rootStoryId: string; depth: number }
    if (n.parentId === null) {
      info = { projectId: n.projectId as number, rootStoryId: n.id, depth: 0 }
    } else {
      const p = derived.get(n.parentId) as { projectId: number; rootStoryId: string; depth: number }
      info = { projectId: p.projectId, rootStoryId: p.rootStoryId, depth: p.depth + 1 }
    }
    derived.set(n.id, info)
    out.push({
      ...n,
      ...info,
      devopsStale: n.devopsId !== null && (n.devopsSyncedAt === null || n.updatedAt > n.devopsSyncedAt)
    })
  }
  return out
}

// ---- dependencies ------------------------------------------------------------

/** adjacency: from -> [to...] ("from depende de to"). */
function depAdjacency(deps: readonly PlanDep[]): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const d of deps) {
    const arr = adj.get(d.fromId)
    if (arr) arr.push(d.toId)
    else adj.set(d.fromId, [d.toId])
  }
  return adj
}

/**
 * Finds a dependency cycle. Returns the cycle as a closed path
 * `[a, b, c, a]` (each element depends on the next), or null if acyclic.
 */
export function findDepCycle(deps: readonly PlanDep[]): string[] | null {
  const adj = depAdjacency(deps)
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const nodes = new Set<string>()
  for (const d of deps) {
    nodes.add(d.fromId)
    nodes.add(d.toId)
  }
  for (const start of nodes) {
    if ((color.get(start) ?? WHITE) !== WHITE) continue
    // Iterative DFS with an explicit path.
    const path: string[] = [start]
    const iters: number[] = [0]
    color.set(start, GRAY)
    while (path.length > 0) {
      const cur = path[path.length - 1]
      const next = adj.get(cur) ?? []
      const i = iters[iters.length - 1]
      if (i >= next.length) {
        color.set(cur, BLACK)
        path.pop()
        iters.pop()
        continue
      }
      iters[iters.length - 1] = i + 1
      const to = next[i]
      const c = color.get(to) ?? WHITE
      if (c === GRAY) return [...path.slice(path.indexOf(to)), to]
      if (c === WHITE) {
        color.set(to, GRAY)
        path.push(to)
        iters.push(0)
      }
    }
  }
  return null
}

/**
 * Would adding "from depende de to" close a cycle? Returns the cycle as a
 * closed path `[from, to, ..., from]` or null. Self-dependency yields `[x, x]`.
 */
export function wouldCreateDepCycle(deps: readonly PlanDep[], fromId: string, toId: string): string[] | null {
  if (fromId === toId) return [fromId, fromId]
  // A cycle appears iff `to` already (transitively) depends on `from`.
  const adj = depAdjacency(deps)
  const prev = new Map<string, string>()
  const seen = new Set<string>([toId])
  const queue = [toId]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const nxt of adj.get(cur) ?? []) {
      if (seen.has(nxt)) continue
      seen.add(nxt)
      prev.set(nxt, cur)
      if (nxt === fromId) {
        const path = [fromId]
        let p: string | undefined = cur
        while (p !== undefined) {
          path.push(p)
          p = prev.get(p)
        }
        // path = [from, ..., to] walking back; reverse the tail to read forward.
        return [fromId, ...path.slice(1).reverse(), fromId]
      }
      queue.push(nxt)
    }
  }
  return null
}

/**
 * Dependency topological order: prerequisites first. For "from depende de to",
 * `to` appears before `from`. Nodes without deps keep their input order
 * (stable). Dependencies naming ids outside `ids` are ignored. Throws
 * `dep_cycle` on a circular dependency.
 */
export function topoOrderDeps<T extends string>(ids: readonly T[], deps: readonly PlanDep[]): T[] {
  const index = new Map<string, number>(ids.map((id, i) => [id, i]))
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]))
  const dependents = new Map<string, string[]>() // to -> [from...]
  for (const d of deps) {
    if (!index.has(d.fromId) || !index.has(d.toId)) continue
    indeg.set(d.fromId, (indeg.get(d.fromId) ?? 0) + 1)
    const arr = dependents.get(d.toId)
    if (arr) arr.push(d.fromId)
    else dependents.set(d.toId, [d.fromId])
  }
  // Kahn's algorithm; the ready set is kept ordered by input position.
  const ready: string[] = ids.filter((id) => indeg.get(id) === 0)
  const out: T[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a) as number) - (index.get(b) as number))
    const id = ready.shift() as T
    out.push(id)
    for (const dep of dependents.get(id) ?? []) {
      const left = (indeg.get(dep) as number) - 1
      indeg.set(dep, left)
      if (left === 0) ready.push(dep)
    }
  }
  if (out.length !== ids.length) {
    const cycle = findDepCycle(deps.filter((d) => index.has(d.fromId) && index.has(d.toId)))
    throw new PlanError('dep_cycle', `Dependência circular: ${(cycle ?? []).join(' → ')}`)
  }
  return out
}
