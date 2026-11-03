import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  PLAN_DESCRIPTION_MAX,
  PLAN_TITLE_MAX,
  type NewPlanNodeInput,
  type PlanAddSpec,
  type PlanDeleteResult,
  type PlanDep,
  type PlanDepLink,
  type PlanDevopsPatch,
  type PlanGraph,
  type PlanNode,
  type PlanNodeKind,
  type PlanNodePatch,
  type PlanOverview,
  type PlanProjectInfo,
  type PlanSpec,
  type PlanWriteResult,
  type RawPlanNode
} from '@shared/types'
import {
  PlanError,
  collectSubtree,
  findDepCycle,
  resolvePlanNodes,
  wouldCreateDepCycle,
  wouldCreateHierarchyCycle
} from '@shared/plan'

/** Safety caps for specs coming from Claude / IPC. */
export const PLAN_SPEC_MAX_NODES = 2000
export const PLAN_SPEC_MAX_DEPTH = 50
const TEMP_ID_MAX = 100

// ---- row mapping & validators ---------------------------------------------------

interface NodeRow {
  id: string
  idea_id: number
  kind: PlanNodeKind
  title: string
  description: string
  parent_id: string | null
  project_id: number | null
  sort: number
  devops_id: number | null
  devops_url: string | null
  devops_synced_at: number | null
  created_at: number
  updated_at: number
}

const toRaw = (r: NodeRow): RawPlanNode => ({
  id: r.id,
  ideaId: r.idea_id,
  kind: r.kind,
  title: r.title,
  description: r.description,
  parentId: r.parent_id,
  projectId: r.project_id,
  sort: r.sort,
  devopsId: r.devops_id,
  devopsUrl: r.devops_url,
  devopsSyncedAt: r.devops_synced_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const q = (s: string): string => `"${s}"`

export function cleanPlanTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim()) {
    throw new PlanError('invalid_title', 'O título é obrigatório.')
  }
  const t = title.trim()
  if (t.length > PLAN_TITLE_MAX) {
    throw new PlanError('invalid_title', `O título pode ter no máximo ${PLAN_TITLE_MAX} caracteres.`)
  }
  return t
}

export function cleanPlanDescription(description: unknown): string {
  if (description == null) return ''
  if (typeof description !== 'string') throw new PlanError('invalid_input', 'Descrição inválida.')
  const d = description.trim()
  if (d.length > PLAN_DESCRIPTION_MAX) {
    throw new PlanError('invalid_input', `A descrição pode ter no máximo ${PLAN_DESCRIPTION_MAX} caracteres.`)
  }
  return d
}

function cleanIndex(index: unknown): number | undefined {
  if (index === undefined || index === null) return undefined
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new PlanError('invalid_input', 'A posição precisa ser um inteiro maior ou igual a 0.')
  }
  return index
}

/**
 * Stories of the idea that use `projectId` (all ideas when `ideaId` is omitted).
 * Used to guard unlinking/deleting a project.
 */
export function storiesUsingProject(
  db: Database.Database,
  projectId: number,
  ideaId?: number
): { id: string; title: string; ideaId: number; ideaTitle: string }[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.title, n.idea_id AS ideaId, i.title AS ideaTitle
       FROM plan_nodes n JOIN ideas i ON i.id = n.idea_id
       WHERE n.kind = 'story' AND n.project_id = ?${ideaId === undefined ? '' : ' AND n.idea_id = ?'}
       ORDER BY n.idea_id, n.sort, n.created_at`
    )
    .all(...(ideaId === undefined ? [projectId] : [projectId, ideaId])) as {
    id: string
    title: string
    ideaId: number
    ideaTitle: string
  }[]
  return rows
}

// ---- spec flattening -------------------------------------------------------------

interface FlatNode {
  /** Internal unique id: the existing node id, or `new:<n>`. */
  uid: string
  /** Every spec identifier of this node (tempId and/or id). */
  keys: string[]
  existingId: string | null
  kind: PlanNodeKind
  title: string
  description: string
  /** Stories only. */
  projectId: number | null
  /** uid of the parent inside the spec; null for top-level nodes. */
  parentUid: string | null
  /** Position among its siblings inside the spec. */
  index: number
}

interface FlattenOptions {
  /** replaceAll: nodes may carry `id` of an existing node to keep. */
  allowIds: boolean
  /** mergeAdd with parent: top-level nodes are tasks under this node. */
  topParent: PlanNode | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export class PlanRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID
  ) {}

  // ---- reads ---------------------------------------------------------------------

  getGraph(ideaId: number): PlanGraph {
    this.ensureIdea(ideaId)
    return { ideaId, nodes: resolvePlanNodes(this.rawNodes(ideaId)), deps: this.depsOf(ideaId) }
  }

  getNode(ideaId: number, nodeId: string): PlanNode {
    this.requireNode(ideaId, nodeId)
    const node = resolvePlanNodes(this.rawNodes(ideaId)).find((n) => n.id === nodeId)
    /* c8 ignore next */
    if (!node) throw new PlanError('not_found', 'Nó não encontrado.')
    return node
  }

  linkedProjects(ideaId: number): PlanProjectInfo[] {
    this.ensureIdea(ideaId)
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, p.folder_path AS folderPath, ip.is_primary AS isPrimary
         FROM idea_projects ip JOIN projects p ON p.id = ip.project_id
         WHERE ip.idea_id = ? ORDER BY ip.is_primary DESC, ip.linked_at ASC, p.id ASC`
      )
      .all(ideaId) as { id: number; name: string; folderPath: string; isPrimary: number }[]
    return rows.map((r) => ({ id: r.id, name: r.name, folderPath: r.folderPath, isPrimary: r.isPrimary === 1 }))
  }

  getOverview(ideaId: number): PlanOverview {
    return { graph: this.getGraph(ideaId), projects: this.linkedProjects(ideaId) }
  }

  // ---- single-node mutations -------------------------------------------------------

  createNode(ideaId: number, input: NewPlanNodeInput): PlanNode {
    if (!isObj(input)) throw new PlanError('invalid_input', 'Dados do nó inválidos.')
    return this.db.transaction((): PlanNode => {
      this.ensureIdea(ideaId)
      const title = cleanPlanTitle(input.title)
      const description = cleanPlanDescription(input.description)
      const index = cleanIndex(input.index)
      const ts = this.now()
      const id = this.newId()

      if (input.kind === 'story') {
        if (input.parentId != null) {
          throw new PlanError('story_has_parent', 'Uma story não pode ter pai: ela fica no topo do plano.')
        }
        const projectId = this.requireStoryProject(ideaId, input.projectId, title)
        this.insertRow({ id, ideaId, kind: 'story', title, description, parentId: null, projectId, ts })
        this.placeAt(ideaId, null, id, index)
      } else if (input.kind === 'task') {
        if (typeof input.parentId !== 'string' || !input.parentId) {
          throw new PlanError('task_needs_parent', 'Uma task precisa de um pai (uma story ou outra task).')
        }
        const parent = this.getNode(ideaId, input.parentId)
        this.assertDepth(parent.depth + 1)
        if (input.projectId != null && input.projectId !== parent.projectId) {
          throw new PlanError(
            'task_project_derived',
            'O projeto de uma task é sempre o da sua story; mude o projeto da story em vez disso.'
          )
        }
        this.insertRow({ id, ideaId, kind: 'task', title, description, parentId: parent.id, projectId: null, ts })
        this.placeAt(ideaId, parent.id, id, index)
      } else {
        throw new PlanError('invalid_input', 'O tipo do nó deve ser "story" ou "task".')
      }
      return this.getNode(ideaId, id)
    })()
  }

  /**
   * Updates title / description / position (`sort` = new 0-based index among
   * siblings) and, for stories, the project. `updatedAt` only moves when the
   * title or description really change.
   */
  updateNode(ideaId: number, nodeId: string, patch: PlanNodePatch): PlanNode {
    if (!isObj(patch)) throw new PlanError('invalid_input', 'Alterações inválidas.')
    return this.db.transaction((): PlanNode => {
      const node = this.requireNode(ideaId, nodeId)
      const sets: string[] = []
      const vals: unknown[] = []

      const title = patch.title !== undefined ? cleanPlanTitle(patch.title) : node.title
      const description = patch.description !== undefined ? cleanPlanDescription(patch.description) : node.description
      if (title !== node.title || description !== node.description) {
        sets.push('title = ?', 'description = ?', 'updated_at = ?')
        vals.push(title, description, this.now())
      }

      if (patch.projectId !== undefined) {
        if (node.kind === 'task') {
          throw new PlanError(
            'task_project_derived',
            'O projeto de uma task é sempre o da sua story; mude o projeto da story em vez disso.'
          )
        }
        const projectId = this.requireStoryProject(ideaId, patch.projectId, node.title)
        if (projectId !== node.projectId) {
          sets.push('project_id = ?')
          vals.push(projectId)
        }
      }
      const index = patch.sort === undefined ? undefined : (cleanIndex(patch.sort) ?? undefined)

      if (sets.length > 0) {
        this.db.prepare(`UPDATE plan_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...vals, nodeId)
      }
      if (index !== undefined) this.placeAt(ideaId, node.parentId, nodeId, index)
      return this.getNode(ideaId, nodeId)
    })()
  }

  /**
   * Moves a task under another story/task of the same idea (appended last, or at
   * `index`). Stories cannot be reparented (only reordered: pass `null`).
   */
  setParent(ideaId: number, nodeId: string, parentId: string | null, index?: number): PlanNode {
    return this.db.transaction((): PlanNode => {
      const node = this.requireNode(ideaId, nodeId)
      const pos = cleanIndex(index)
      if (node.kind === 'story') {
        if (parentId != null) {
          throw new PlanError('story_has_parent', `A story ${q(node.title)} não pode ter pai: ela fica no topo do plano.`)
        }
        this.placeAt(ideaId, null, nodeId, pos)
        return this.getNode(ideaId, nodeId)
      }
      if (typeof parentId !== 'string' || !parentId) {
        throw new PlanError('task_needs_parent', `A task ${q(node.title)} precisa de um pai (uma story ou outra task).`)
      }
      const parent = this.requireNode(ideaId, parentId)
      const all = this.rawNodes(ideaId)
      if (wouldCreateHierarchyCycle(all, nodeId, parentId)) {
        throw new PlanError(
          'hierarchy_cycle',
          parentId === nodeId
            ? `${q(node.title)} não pode ser pai de si mesma.`
            : `${q(node.title)} não pode ficar dentro de ${q(parent.title)}: ela é ancestral dessa task (criaria um ciclo).`
        )
      }
      // Depth cap: the moved subtree keeps its own height below the new parent.
      const resolved = resolvePlanNodes(all)
      const movedIds = new Set(collectSubtree(resolved, nodeId))
      const moved = resolved.filter((n) => movedIds.has(n.id))
      const height = Math.max(...moved.map((n) => n.depth)) - (moved.find((n) => n.id === nodeId) as PlanNode).depth
      this.assertDepth((resolved.find((n) => n.id === parentId) as PlanNode).depth + 1 + height)
      const oldParent = node.parentId
      this.db.prepare('UPDATE plan_nodes SET parent_id = ? WHERE id = ?').run(parentId, nodeId)
      this.placeAt(ideaId, parentId, nodeId, pos)
      if (oldParent !== parentId) this.compact(ideaId, oldParent)
      return this.getNode(ideaId, nodeId)
    })()
  }

  /** Sets the order of all siblings under `parentId` (null = stories). `orderedIds` must list each exactly once. */
  reorder(ideaId: number, parentId: string | null, orderedIds: string[]): void {
    this.db.transaction(() => {
      this.ensureIdea(ideaId)
      if (parentId != null) this.requireNode(ideaId, parentId)
      if (!Array.isArray(orderedIds)) throw new PlanError('invalid_input', 'A nova ordem precisa ser uma lista de ids.')
      const current = this.siblingRows(ideaId, parentId ?? null).map((r) => r.id)
      const given = new Set(orderedIds)
      if (
        given.size !== orderedIds.length ||
        orderedIds.length !== current.length ||
        !current.every((id) => given.has(id))
      ) {
        throw new PlanError('invalid_input', 'A nova ordem deve listar exatamente os irmãos atuais, cada um uma vez.')
      }
      this.renumber(orderedIds)
    })()
  }

  /**
   * Deletes the node and its whole subtree, plus every dependency touching a
   * deleted node. Refuses (`ticketed_nodes`) when the subtree contains nodes
   * that already have a DevOps ticket, unless `force` (the UI confirms first;
   * the work items in DevOps are never touched).
   */
  deleteNode(ideaId: number, nodeId: string, force = false): PlanDeleteResult {
    return this.db.transaction((): PlanDeleteResult => {
      const node = this.requireNode(ideaId, nodeId)
      const all = this.rawNodes(ideaId)
      const deletedIds = collectSubtree(all, nodeId)
      const byId = new Map(all.map((n) => [n.id, n]))
      const ticketed = deletedIds
        .map((id) => byId.get(id) as RawPlanNode)
        .filter((n) => n.devopsId !== null)
        .map((n) => ({ id: n.id, title: n.title, devopsId: n.devopsId as number }))
      if (ticketed.length > 0 && !force) throw ticketedError(ticketed)
      // FK cascades remove the subtree (parent_id) and every dependency (from_id / to_id).
      this.db.prepare('DELETE FROM plan_nodes WHERE id = ?').run(nodeId)
      this.compact(ideaId, node.parentId)
      return { deletedIds, ticketed }
    })()
  }

  // ---- dependencies ----------------------------------------------------------------

  /** "fromId depende de toId". Rejects self, duplicate, cross-idea and circular dependencies. */
  addDep(ideaId: number, fromId: string, toId: string): PlanDep {
    return this.db.transaction((): PlanDep => {
      const from = this.requireNode(ideaId, fromId)
      const to = this.requireNode(ideaId, toId)
      if (fromId === toId) {
        throw new PlanError('dep_self', `${q(from.title)} não pode depender de si mesma.`)
      }
      const existing = this.depsOf(ideaId)
      if (existing.some((d) => d.fromId === fromId && d.toId === toId)) {
        throw new PlanError('dep_duplicate', `${q(from.title)} já depende de ${q(to.title)}.`)
      }
      const cycle = wouldCreateDepCycle(existing, fromId, toId)
      if (cycle) {
        const titles = new Map(this.rawNodes(ideaId).map((n) => [n.id, n.title]))
        throw cycleError(cycle, titles)
      }
      this.db.prepare('INSERT INTO plan_deps (from_id, to_id) VALUES (?, ?)').run(fromId, toId)
      return { fromId, toId }
    })()
  }

  /** Returns false when the dependency did not exist (idempotent). */
  removeDep(ideaId: number, fromId: string, toId: string): boolean {
    this.requireNode(ideaId, fromId)
    this.requireNode(ideaId, toId)
    return this.db.prepare('DELETE FROM plan_deps WHERE from_id = ? AND to_id = ?').run(fromId, toId).changes > 0
  }

  // ---- bulk ------------------------------------------------------------------------

  /**
   * Atomically replaces the idea's whole graph by `spec`.
   *
   * - Spec nodes WITHOUT `id` are created (new UUIDs, `tempId`s resolve `deps`).
   * - Spec nodes WITH `id` (an existing node of this idea, same kind as its
   *   position) are KEPT and updated in place: same UUID, created_at and
   *   devops_* fields; title/description/parent/project/order follow the spec.
   * - Existing nodes absent from the spec are deleted (with their deps).
   *   If any of them already has a DevOps ticket and `force` is not set, the
   *   whole call is rejected with `ticketed_nodes` (nothing changes).
   * - All dependencies are replaced by `spec.deps`.
   * - Any rule violation aborts the whole transaction.
   */
  replaceAll(ideaId: number, spec: PlanSpec, opts: { force?: boolean } = {}): PlanWriteResult {
    return this.db.transaction((): PlanWriteResult => {
      this.ensureIdea(ideaId)
      if (!isObj(spec)) throw new PlanError('spec_invalid', 'O plano precisa ser um objeto { stories, deps }.')
      // A missing/mistyped list must never read as "empty plan" (that would delete everything):
      // clearing the plan is only possible by sending `stories: []` explicitly.
      if (!Array.isArray(spec.stories)) {
        throw new PlanError(
          'spec_invalid',
          'O plano precisa da lista "stories" (envie stories: [] apenas se a intenção for esvaziar o plano).'
        )
      }
      const existing = this.rawNodes(ideaId)
      const existingById = new Map(existing.map((n) => [n.id, n]))
      const flat = this.flatten(ideaId, spec.stories, { allowIds: true, topParent: null }, existingById)
      const { keyMap } = flat
      const kept = new Set(flat.nodes.flatMap((n) => (n.existingId ? [n.existingId] : [])))

      const titles = new Map<string, string>(flat.nodes.map((n) => [n.uid, n.title]))
      const deps = this.resolveSpecDeps(spec.deps, keyMap, null, titles, [])

      const removed = existing.filter((n) => !kept.has(n.id))
      const ticketed = removed
        .filter((n) => n.devopsId !== null)
        .map((n) => ({ id: n.id, title: n.title, devopsId: n.devopsId as number }))
      if (ticketed.length > 0 && !opts.force) throw ticketedError(ticketed)

      // 1. all deps go (re-inserted at the end; the DevOps link state of the pairs that survive is kept)
      const linkedDeps = this.depLinks(ideaId).filter((d) => d.devopsLinkedAt !== null)
      this.db
        .prepare('DELETE FROM plan_deps WHERE from_id IN (SELECT id FROM plan_nodes WHERE idea_id = ?)')
        .run(ideaId)
      // 2. real ids; new nodes are inserted first (pre-order => parents before children)
      const realId = new Map<string, string>()
      for (const n of flat.nodes) realId.set(n.uid, n.existingId ?? this.newId())
      const ts = this.now()
      let created = 0
      let updated = 0
      for (const n of flat.nodes) {
        if (n.existingId) continue
        this.insertRow({
          id: realId.get(n.uid) as string,
          ideaId,
          kind: n.kind,
          title: n.title,
          description: n.description,
          parentId: n.parentUid ? (realId.get(n.parentUid) as string) : null,
          projectId: n.kind === 'story' ? n.projectId : null,
          ts,
          sort: n.index
        })
        created++
      }
      // 3. kept nodes follow the spec (all final parents exist by now)
      for (const n of flat.nodes) {
        if (!n.existingId) continue
        const cur = existingById.get(n.existingId) as RawPlanNode
        const textChanged = cur.title !== n.title || cur.description !== n.description
        this.db
          .prepare(
            `UPDATE plan_nodes SET title = ?, description = ?, parent_id = ?, project_id = ?, sort = ?,
               updated_at = ? WHERE id = ?`
          )
          .run(
            n.title,
            n.description,
            n.parentUid ? (realId.get(n.parentUid) as string) : null,
            n.kind === 'story' ? n.projectId : null,
            n.index,
            textChanged ? ts : cur.updatedAt,
            n.existingId
          )
        updated++
      }
      // 4. now nothing kept hangs below a removed node: delete the rest
      const del = this.db.prepare('DELETE FROM plan_nodes WHERE id = ?')
      for (const n of removed) del.run(n.id)
      // 5. dependencies
      this.insertDeps(deps, realId)
      const relink = this.db.prepare('UPDATE plan_deps SET devops_linked_at = ? WHERE from_id = ? AND to_id = ?')
      for (const d of linkedDeps) relink.run(d.devopsLinkedAt, d.fromId, d.toId)

      const idMap: Record<string, string> = {}
      for (const n of flat.nodes) for (const k of n.keys) idMap[k] = realId.get(n.uid) as string
      return { idMap, created, updated, deleted: removed.length, deletedIds: removed.map((n) => n.id) }
    })()
  }

  /**
   * Adds new nodes without deleting anything: under `parentId` (new tasks,
   * appended after its current children) or, without parent, as new stories
   * (appended after the existing ones). `spec.deps` may refer to the new
   * nodes' `tempId`s and to ids of existing nodes. `id` is not allowed here.
   */
  mergeAdd(ideaId: number, spec: PlanAddSpec, parentId?: string | null): PlanWriteResult {
    return this.db.transaction((): PlanWriteResult => {
      this.ensureIdea(ideaId)
      if (!isObj(spec)) throw new PlanError('spec_invalid', 'O spec precisa ser um objeto { nodes, deps }.')
      if (!Array.isArray(spec.nodes)) throw new PlanError('spec_invalid', 'O spec precisa da lista "nodes".')
      const topParent = parentId == null ? null : this.getNode(ideaId, parentId)
      const existing = this.rawNodes(ideaId)
      const existingById = new Map(existing.map((n) => [n.id, n]))
      const flat = this.flatten(ideaId, spec.nodes, { allowIds: false, topParent }, existingById)

      const titles = new Map<string, string>(existing.map((n) => [n.id, n.title]))
      for (const n of flat.nodes) titles.set(n.uid, n.title)
      const deps = this.resolveSpecDeps(spec.deps, flat.keyMap, existingById, titles, this.depsOf(ideaId))

      const ts = this.now()
      const baseSort = this.siblingRows(ideaId, topParent?.id ?? null).length
      const realId = new Map<string, string>()
      for (const n of flat.nodes) realId.set(n.uid, this.newId())
      for (const n of flat.nodes) {
        this.insertRow({
          id: realId.get(n.uid) as string,
          ideaId,
          kind: n.kind,
          title: n.title,
          description: n.description,
          parentId: n.parentUid ? (realId.get(n.parentUid) as string) : (topParent?.id ?? null),
          projectId: n.kind === 'story' ? n.projectId : null,
          ts,
          sort: n.parentUid ? n.index : baseSort + n.index
        })
      }
      // Dependencies on existing nodes resolve to themselves.
      this.insertDeps(deps, realId)

      const idMap: Record<string, string> = {}
      for (const n of flat.nodes) for (const k of n.keys) idMap[k] = realId.get(n.uid) as string
      return { idMap, created: flat.nodes.length, updated: 0, deleted: 0, deletedIds: [] }
    })()
  }

  // ---- Fase 5 hooks ------------------------------------------------------------------

  /**
   * Stores (or clears) the Azure DevOps link of a node. Does NOT touch `updatedAt`.
   *
   * Sync rule: `sentUpdatedAt` is the `updatedAt` of the node SNAPSHOT that was sent to DevOps
   * (read before the request), never "now". `devopsStale` is `updatedAt > devopsSyncedAt`, so an edit made
   * while the request was in flight (updatedAt moved past the snapshot) still shows as stale.
   * A snapshot newer than the node itself is impossible and rejected.
   */
  setDevops(ideaId: number, nodeId: string, patch: PlanDevopsPatch): PlanNode {
    const node = this.requireNode(ideaId, nodeId)
    const num = (v: unknown, what: string): number | null => {
      if (v === null) return null
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new PlanError('invalid_input', `${what} inválido.`)
      }
      return v
    }
    const url = patch.devopsUrl
    if (url !== null && typeof url !== 'string') throw new PlanError('invalid_input', 'URL do work item inválida.')
    const sent = num(patch.sentUpdatedAt, 'Versão enviada (updatedAt do snapshot)')
    if (sent !== null && sent > node.updatedAt) {
      throw new PlanError(
        'invalid_input',
        'A versão enviada ao DevOps não pode ser mais nova que o nó: informe o updatedAt lido antes do envio.'
      )
    }
    this.db
      .prepare('UPDATE plan_nodes SET devops_id = ?, devops_url = ?, devops_synced_at = ? WHERE id = ?')
      .run(num(patch.devopsId, 'Id do work item'), url, sent, nodeId)
    return this.getNode(ideaId, nodeId)
  }

  /** Dependencies of the idea with their DevOps link state (`devopsLinkedAt` null = relation not created yet). */
  depLinks(ideaId: number): PlanDepLink[] {
    this.ensureIdea(ideaId)
    return this.db
      .prepare(
        `SELECT d.from_id AS fromId, d.to_id AS toId, d.devops_linked_at AS devopsLinkedAt FROM plan_deps d
         JOIN plan_nodes n ON n.id = d.from_id WHERE n.idea_id = ? ORDER BY d.rowid`
      )
      .all(ideaId) as PlanDepLink[]
  }

  /** Marks (`linkedAt` = timestamp) or clears (null) the DevOps relation of a dependency. false = dependency does not exist. */
  setDepLinked(ideaId: number, fromId: string, toId: string, linkedAt: number | null): boolean {
    this.requireNode(ideaId, fromId)
    this.requireNode(ideaId, toId)
    if (linkedAt !== null && (typeof linkedAt !== 'number' || !Number.isInteger(linkedAt) || linkedAt < 0)) {
      throw new PlanError('invalid_input', 'Data do vínculo inválida.')
    }
    return (
      this.db
        .prepare('UPDATE plan_deps SET devops_linked_at = ? WHERE from_id = ? AND to_id = ?')
        .run(linkedAt, fromId, toId).changes > 0
    )
  }

  // ---- internals -------------------------------------------------------------------

  /** `depth` = the `PlanNode.depth` the deepest node would reach (story = 0). Same cap as a spec (50 levels). */
  private assertDepth(depth: number): void {
    if (depth + 1 > PLAN_SPEC_MAX_DEPTH) {
      throw new PlanError('invalid_input', `A hierarquia pode ter no máximo ${PLAN_SPEC_MAX_DEPTH} níveis.`)
    }
  }

  private ensureIdea(ideaId: number): void {
    if (!this.db.prepare('SELECT 1 FROM ideas WHERE id = ?').get(ideaId)) {
      throw new PlanError('not_found', `Ideia #${ideaId} não encontrada.`)
    }
  }

  private rawNodes(ideaId: number): RawPlanNode[] {
    const rows = this.db.prepare('SELECT * FROM plan_nodes WHERE idea_id = ?').all(ideaId) as NodeRow[]
    // Stable order for ties: sort, then creation, then id.
    rows.sort((a, b) => a.sort - b.sort || a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
    return rows.map(toRaw)
  }

  private depsOf(ideaId: number): PlanDep[] {
    const rows = this.db
      .prepare(
        `SELECT d.from_id AS fromId, d.to_id AS toId FROM plan_deps d
         JOIN plan_nodes n ON n.id = d.from_id WHERE n.idea_id = ? ORDER BY d.rowid`
      )
      .all(ideaId) as PlanDep[]
    return rows
  }

  /** Node of THIS idea or a typed error (not_found / cross_idea). */
  private requireNode(ideaId: number, nodeId: string): RawPlanNode {
    this.ensureIdea(ideaId)
    if (typeof nodeId !== 'string' || !nodeId) throw new PlanError('invalid_input', 'Id de nó inválido.')
    const row = this.db.prepare('SELECT * FROM plan_nodes WHERE id = ?').get(nodeId) as NodeRow | undefined
    if (!row) throw new PlanError('not_found', `Nó ${nodeId} não encontrado.`)
    if (row.idea_id !== ideaId) {
      throw new PlanError('cross_idea', `O nó ${q(row.title)} pertence a outra ideia.`)
    }
    return toRaw(row)
  }

  /** Validates a story's project: given, an existing project and linked to the idea. */
  private requireStoryProject(ideaId: number, projectId: unknown, storyTitle: string): number {
    if (typeof projectId !== 'number' || !Number.isInteger(projectId) || projectId <= 0) {
      throw new PlanError('story_needs_project', `A story ${q(storyTitle)} precisa de um projeto vinculado à ideia.`)
    }
    const linked = this.db
      .prepare('SELECT 1 FROM idea_projects WHERE idea_id = ? AND project_id = ?')
      .get(ideaId, projectId)
    if (!linked) {
      const p = this.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined
      throw new PlanError(
        'project_not_linked',
        p
          ? `O projeto ${q(p.name)} não está vinculado a esta ideia; vincule-o antes de usá-lo em uma story.`
          : `O projeto #${projectId} não existe ou não está vinculado a esta ideia.`
      )
    }
    return projectId
  }

  private insertRow(r: {
    id: string
    ideaId: number
    kind: PlanNodeKind
    title: string
    description: string
    parentId: string | null
    projectId: number | null
    ts: number
    sort?: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO plan_nodes (id, idea_id, kind, title, description, parent_id, project_id, sort, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(r.id, r.ideaId, r.kind, r.title, r.description, r.parentId, r.projectId, r.sort ?? 0, r.ts, r.ts)
  }

  /** Inserts resolved deps; uids of spec nodes map to real ids, existing node ids map to themselves. */
  private insertDeps(deps: [string, string][], realId: Map<string, string>): void {
    const ins = this.db.prepare('INSERT OR IGNORE INTO plan_deps (from_id, to_id) VALUES (?, ?)')
    for (const [from, to] of deps) ins.run(realId.get(from) ?? from, realId.get(to) ?? to)
  }

  private siblingRows(ideaId: number, parentId: string | null): { id: string }[] {
    return this.db
      .prepare('SELECT id FROM plan_nodes WHERE idea_id = ? AND parent_id IS ? ORDER BY sort, created_at, id')
      .all(ideaId, parentId) as { id: string }[]
  }

  /** Puts `nodeId` at `index` (default last) among the siblings under `parentId`, renumbering them 0..n-1. */
  private placeAt(ideaId: number, parentId: string | null, nodeId: string, index?: number): void {
    const ids = this.siblingRows(ideaId, parentId)
      .map((r) => r.id)
      .filter((id) => id !== nodeId)
    const pos = index === undefined ? ids.length : Math.min(index, ids.length)
    ids.splice(pos, 0, nodeId)
    this.renumber(ids)
  }

  private compact(ideaId: number, parentId: string | null): void {
    this.renumber(this.siblingRows(ideaId, parentId).map((r) => r.id))
  }

  private renumber(ids: string[]): void {
    const upd = this.db.prepare('UPDATE plan_nodes SET sort = ? WHERE id = ? AND sort <> ?')
    ids.forEach((id, i) => upd.run(i, id, i))
  }

  /** Validates a nested spec and flattens it in pre-order. */
  private flatten(
    ideaId: number,
    input: unknown,
    opts: FlattenOptions,
    existingById: Map<string, RawPlanNode>
  ): { nodes: FlatNode[]; keyMap: Map<string, FlatNode> } {
    const nodes: FlatNode[] = []
    const keyMap = new Map<string, FlatNode>()
    const usedExisting = new Set<string>()
    let seq = 0

    const walk = (
      list: unknown,
      parent: FlatNode | null,
      kind: PlanNodeKind,
      storyProject: number | null,
      depth: number,
      where: string
    ): void => {
      if (list === undefined || list === null) return
      if (!Array.isArray(list)) throw new PlanError('spec_invalid', `${where}: esperava uma lista de nós.`)
      if (depth > PLAN_SPEC_MAX_DEPTH) {
        throw new PlanError('spec_invalid', `O plano tem níveis demais (máximo ${PLAN_SPEC_MAX_DEPTH}).`)
      }
      list.forEach((raw, index) => {
        if (!isObj(raw)) throw new PlanError('spec_invalid', `${where}: item ${index + 1} inválido.`)
        if (nodes.length >= PLAN_SPEC_MAX_NODES) {
          throw new PlanError('spec_invalid', `O plano tem nós demais (máximo ${PLAN_SPEC_MAX_NODES}).`)
        }
        const title = cleanPlanTitle(raw.title)
        const description = cleanPlanDescription(raw.description)
        const keys: string[] = []

        let tempId: string | undefined
        if (raw.tempId != null) {
          if (typeof raw.tempId !== 'string' || !raw.tempId.trim() || raw.tempId.length > TEMP_ID_MAX) {
            throw new PlanError('spec_invalid', `tempId inválido em ${q(title)}.`)
          }
          tempId = raw.tempId.trim()
          keys.push(tempId)
        }
        let existingId: string | null = null
        if (raw.id != null) {
          if (!opts.allowIds) {
            throw new PlanError(
              'spec_invalid',
              `${q(title)}: o campo "id" só vale ao substituir o plano inteiro; para editar um nó existente use a edição de nó.`
            )
          }
          if (typeof raw.id !== 'string' || !raw.id) throw new PlanError('spec_invalid', `id inválido em ${q(title)}.`)
          const ex = existingById.get(raw.id)
          if (!ex) {
            throw new PlanError('spec_invalid', `${q(title)}: o id ${raw.id} não é um nó existente desta ideia.`)
          }
          if (ex.kind !== kind) {
            throw new PlanError(
              'spec_invalid',
              `${q(ex.title)} é ${ex.kind === 'story' ? 'uma story' : 'uma task'} e não pode virar ${kind === 'story' ? 'story' : 'task'} (um nó de topo é story; os aninhados são tasks).`
            )
          }
          if (usedExisting.has(raw.id)) {
            throw new PlanError('spec_invalid', `O nó ${q(ex.title)} aparece mais de uma vez no plano.`)
          }
          usedExisting.add(raw.id)
          existingId = raw.id
          if (!keys.includes(raw.id)) keys.push(raw.id)
        }
        let projectId: number | null = null
        if (kind === 'story') {
          projectId = this.requireStoryProject(ideaId, raw.projectId, title)
        } else {
          if (raw.projectId != null && raw.projectId !== storyProject) {
            throw new PlanError(
              'task_project_derived',
              `A task ${q(title)} herda o projeto da story; não informe outro projeto.`
            )
          }
        }

        const flat: FlatNode = {
          uid: existingId ?? `new:${seq++}`,
          keys,
          existingId,
          kind,
          title,
          description,
          projectId,
          parentUid: parent?.uid ?? null,
          index
        }
        for (const k of flat.keys) {
          if (keyMap.has(k) || (opts.allowIds ? false : existingById.has(k))) {
            throw new PlanError('spec_invalid', `Identificador repetido no plano: "${k}".`)
          }
          keyMap.set(k, flat)
        }
        nodes.push(flat)
        walk(raw.children, flat, 'task', kind === 'story' ? projectId : storyProject, depth + 1, q(title))
      })
    }

    if (opts.topParent) {
      // mergeAdd under an existing node: top-level spec nodes are tasks.
      walk(input, null, 'task', opts.topParent.projectId, 1, 'nós')
    } else {
      walk(input, null, 'story', null, 1, 'stories')
    }
    return { nodes, keyMap }
  }

  /** Resolves spec deps to uid pairs; validates self/cycles. Duplicates collapse silently. */
  private resolveSpecDeps(
    specDeps: unknown,
    keyMap: Map<string, FlatNode>,
    existingById: Map<string, RawPlanNode> | null,
    titles: Map<string, string>,
    existingDeps: PlanDep[]
  ): [string, string][] {
    if (specDeps == null) specDeps = []
    if (!Array.isArray(specDeps)) throw new PlanError('spec_invalid', 'deps precisa ser uma lista de { from, to }.')
    const resolve = (ref: unknown): string => {
      if (typeof ref !== 'string' || !ref) throw new PlanError('spec_invalid', 'Dependência com referência inválida.')
      const flat = keyMap.get(ref)
      if (flat) return flat.uid
      if (existingById?.has(ref)) return ref
      throw new PlanError('spec_invalid', `Dependência referencia "${ref}", que não existe no plano.`)
    }
    const out: [string, string][] = []
    const seen = new Set<string>()
    for (const d of specDeps) {
      if (!isObj(d)) throw new PlanError('spec_invalid', 'Dependência inválida (esperado { from, to }).')
      const from = resolve(d.from)
      const to = resolve(d.to)
      if (from === to) {
        throw new PlanError('dep_self', `${q(titles.get(from) ?? from)} não pode depender de si mesma.`)
      }
      const key = `${from}\u0000${to}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push([from, to])
    }
    // Existing deps (mergeAdd) participate in the cycle check.
    const all: PlanDep[] = out.map(([fromId, toId]) => ({ fromId, toId }))
    for (const d of existingDeps) if (!seen.has(`${d.fromId}\u0000${d.toId}`)) all.push(d)
    const cycle = findDepCycle(all)
    if (cycle) throw cycleError(cycle, titles)
    return out
  }
}

function cycleError(cycle: string[], titles: Map<string, string>): PlanError {
  const names = cycle.map((id) => q(titles.get(id) ?? id)).join(' → ')
  return new PlanError('dep_cycle', `Dependência circular não permitida: ${names}.`)
}

function ticketedError(ticketed: { id: string; title: string; devopsId: number }[]): PlanError {
  const list = ticketed
    .slice(0, 5)
    .map((t) => `#${t.devopsId} ${q(t.title)}`)
    .join(', ')
  const more = ticketed.length > 5 ? ` e mais ${ticketed.length - 5}` : ''
  return new PlanError(
    'ticketed_nodes',
    `Isso apagaria ${ticketed.length} nó(s) que já têm ticket no Azure DevOps (${list}${more}). Preserve-os no plano (reenviando o campo "id") ou confirme o descarte.`
  )
}
