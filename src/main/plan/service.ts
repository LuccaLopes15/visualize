// Fase 4: main-side service over the plan repository. It is THE entry point for
// both the IPC handlers (src/main/ipc) and Claude's MCP tools (src/main/mcp):
// every mutation notifies listeners with the idea id, so the open Tarefas tab
// (and any other window) refreshes. Rule violations throw `PlanError`
// (stable `code` + pt-BR `message`).
//
// Every function takes the `ideaId` first and verifies the node belongs to it:
// a chat session (MCP token bound to one idea) can never touch another idea.
import type {
  NewPlanNodeInput,
  PlanAddSpec,
  PlanDeleteResult,
  PlanDep,
  PlanDevopsPatch,
  PlanGraph,
  PlanNode,
  PlanNodePatch,
  PlanOverview,
  PlanSpec,
  PlanWriteResult
} from '@shared/types'
import type { PlanRepository } from '../db/repositories/plan'

export class PlanService {
  /** @param notify called with the idea id after every mutation (main wires `notifyPlanChanged`). */
  constructor(
    private readonly repo: PlanRepository,
    private readonly notify: (ideaId: number) => void = () => {}
  ) {}

  // ---- reads -----------------------------------------------------------------
  getGraph(ideaId: number): PlanGraph {
    return this.repo.getGraph(ideaId)
  }

  /** Graph + the idea's linked projects (id, name, folder, isPrimary). */
  overview(ideaId: number): PlanOverview {
    return this.repo.getOverview(ideaId)
  }

  getNode(ideaId: number, nodeId: string): PlanNode {
    return this.repo.getNode(ideaId, nodeId)
  }

  // ---- mutations -------------------------------------------------------------
  createNode(ideaId: number, input: NewPlanNodeInput): PlanNode {
    return this.changed(ideaId, this.repo.createNode(ideaId, input))
  }

  updateNode(ideaId: number, nodeId: string, patch: PlanNodePatch): PlanNode {
    return this.changed(ideaId, this.repo.updateNode(ideaId, nodeId, patch))
  }

  setParent(ideaId: number, nodeId: string, parentId: string | null, index?: number): PlanNode {
    return this.changed(ideaId, this.repo.setParent(ideaId, nodeId, parentId, index))
  }

  reorder(ideaId: number, parentId: string | null, orderedIds: string[]): void {
    this.repo.reorder(ideaId, parentId, orderedIds)
    this.notify(ideaId)
  }

  addDep(ideaId: number, fromId: string, toId: string): PlanDep {
    return this.changed(ideaId, this.repo.addDep(ideaId, fromId, toId))
  }

  /** false = the dependency did not exist (nothing changed, no event). */
  removeDep(ideaId: number, fromId: string, toId: string): boolean {
    const removed = this.repo.removeDep(ideaId, fromId, toId)
    if (removed) this.notify(ideaId)
    return removed
  }

  /** Subtree delete; `force` is required when it would delete ticketed nodes. */
  deleteNode(ideaId: number, nodeId: string, force = false): PlanDeleteResult {
    return this.changed(ideaId, this.repo.deleteNode(ideaId, nodeId, force))
  }

  /** See `PlanRepository.replaceAll` (and docs/fase4-contract.md) for the keep-by-id semantics. */
  replaceAll(ideaId: number, spec: PlanSpec, opts: { force?: boolean } = {}): PlanWriteResult {
    return this.changed(ideaId, this.repo.replaceAll(ideaId, spec, opts))
  }

  /** Adds a subtree without deleting anything (under `parentId`, or as new stories). */
  mergeAdd(ideaId: number, spec: PlanAddSpec, parentId?: string | null): PlanWriteResult {
    return this.changed(ideaId, this.repo.mergeAdd(ideaId, spec, parentId))
  }

  /** Fase 5: store/clear the DevOps link of a node (no IPC channel; main-side only). */
  setDevops(ideaId: number, nodeId: string, patch: PlanDevopsPatch): PlanNode {
    return this.changed(ideaId, this.repo.setDevops(ideaId, nodeId, patch))
  }

  private changed<T>(ideaId: number, result: T): T {
    this.notify(ideaId)
    return result
  }
}
