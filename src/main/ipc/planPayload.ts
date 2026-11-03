// Shape checks for the `plan:*` IPC payloads. The repository validates the domain rules; this
// layer makes sure a malformed renderer message (wrong types, missing lists) is rejected with a
// pt-BR PlanError BEFORE it reaches them: e.g. a missing `stories` must never read as "empty plan".
import { PlanError } from '@shared/plan'
import type { NewPlanNodeInput, PlanAddSpec, PlanNodePatch, PlanSpec } from '@shared/types'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function nodeIdArg(v: unknown, what = 'nó'): string {
  if (typeof v !== 'string' || !v || v.length > 100) throw new PlanError('invalid_input', `Id de ${what} inválido.`)
  return v
}

/** `null` / `undefined` = top level (stories). */
export function parentIdArg(v: unknown): string | null {
  return v == null ? null : nodeIdArg(v, 'pai')
}

export function indexArg(v: unknown): number | undefined {
  if (v == null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new PlanError('invalid_input', 'A posição precisa ser um inteiro maior ou igual a 0.')
  }
  return v
}

export function orderedIdsArg(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 5000) throw new PlanError('invalid_input', 'A ordem precisa ser uma lista de ids.')
  return v.map((id) => nodeIdArg(id))
}

export function newNodeArg(v: unknown): NewPlanNodeInput {
  if (!isObj(v)) throw new PlanError('invalid_input', 'Dados do nó inválidos.')
  return v as unknown as NewPlanNodeInput
}

export function patchArg(v: unknown): PlanNodePatch {
  if (!isObj(v)) throw new PlanError('invalid_input', 'Alterações inválidas.')
  return v as PlanNodePatch
}

/** `replaceAll` payload: needs an explicit `stories` list (`[]` = deliberately clear the plan). */
export function replaceSpecArg(v: unknown): PlanSpec {
  if (!isObj(v)) throw new PlanError('spec_invalid', 'O plano precisa ser um objeto { stories, deps }.')
  if (!Array.isArray(v.stories)) {
    throw new PlanError(
      'spec_invalid',
      'O plano precisa da lista "stories" (envie stories: [] apenas se a intenção for esvaziar o plano).'
    )
  }
  if (v.deps != null && !Array.isArray(v.deps)) throw new PlanError('spec_invalid', 'deps precisa ser uma lista de { from, to }.')
  return v as unknown as PlanSpec
}

export function addSpecArg(v: unknown): PlanAddSpec {
  if (!isObj(v)) throw new PlanError('spec_invalid', 'O spec precisa ser um objeto { nodes, deps }.')
  if (!Array.isArray(v.nodes)) throw new PlanError('spec_invalid', 'O spec precisa da lista "nodes".')
  if (v.deps != null && !Array.isArray(v.deps)) throw new PlanError('spec_invalid', 'deps precisa ser uma lista de { from, to }.')
  return v as unknown as PlanAddSpec
}
