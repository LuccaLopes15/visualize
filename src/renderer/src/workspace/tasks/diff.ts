// Which nodes appeared between two renders of the graph (used to briefly
// highlight what Claude — or the user — just added).
import type { PlanNode } from '@shared/types'

/**
 * Ids present in `next` and absent from `prev`. `prev === null` means "first
 * load": nothing is new (the whole graph would flash otherwise).
 */
export function diffNewIds(prev: ReadonlySet<string> | null, next: readonly Pick<PlanNode, 'id'>[]): string[] {
  if (prev === null) return []
  return next.filter((n) => !prev.has(n.id)).map((n) => n.id)
}
