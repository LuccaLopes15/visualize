import { describe, expect, it } from 'vitest'
import {
  PlanError,
  buildChildrenIndex,
  collectSubtree,
  findDepCycle,
  findRootId,
  findRootStory,
  isDescendant,
  resolvePlanNodes,
  topoOrderDeps,
  topoOrderHierarchy,
  wouldCreateDepCycle,
  wouldCreateHierarchyCycle
} from './plan'
import type { RawPlanNode } from './types'

const n = (id: string, parentId: string | null, sort = 0, kind: 'story' | 'task' = parentId ? 'task' : 'story') => ({
  id,
  parentId,
  sort,
  kind
})
const dep = (fromId: string, toId: string) => ({ fromId, toId })

//   s1 ── t1 ── t1a
//    └─── t2
//   s2 ── t3
const tree = [n('t2', 's1', 1), n('t1a', 't1'), n('s2', null, 1), n('t1', 's1', 0), n('s1', null, 0), n('t3', 's2')]

describe('hierarchy helpers', () => {
  it('buildChildrenIndex orders siblings by sort (stable)', () => {
    const idx = buildChildrenIndex(tree)
    expect(idx.get(null)!.map((x) => x.id)).toEqual(['s1', 's2'])
    expect(idx.get('s1')!.map((x) => x.id)).toEqual(['t1', 't2'])
  })

  it('topoOrderHierarchy puts parents before children (pre-order by sort)', () => {
    expect(topoOrderHierarchy(tree).map((x) => x.id)).toEqual(['s1', 't1', 't1a', 't2', 's2', 't3'])
  })

  it('topoOrderHierarchy throws on a parent cycle or a missing parent', () => {
    const cyc = [n('a', 'b'), n('b', 'a'), n('r', null)]
    expect(() => topoOrderHierarchy(cyc)).toThrowError(PlanError)
    expect(() => topoOrderHierarchy([n('x', 'ghost')])).toThrowError(/inconsistente/)
    try {
      topoOrderHierarchy(cyc)
    } catch (e) {
      expect((e as PlanError).code).toBe('hierarchy_cycle')
    }
  })

  it('collectSubtree returns root + descendants in pre-order; unknown -> []', () => {
    expect(collectSubtree(tree, 's1')).toEqual(['s1', 't1', 't1a', 't2'])
    expect(collectSubtree(tree, 't1')).toEqual(['t1', 't1a'])
    expect(collectSubtree(tree, 't3')).toEqual(['t3'])
    expect(collectSubtree(tree, 'nope')).toEqual([])
  })

  it('isDescendant / wouldCreateHierarchyCycle', () => {
    expect(isDescendant(tree, 's1', 't1a')).toBe(true)
    expect(isDescendant(tree, 't1', 't1a')).toBe(true)
    expect(isDescendant(tree, 't1a', 't1')).toBe(false)
    expect(isDescendant(tree, 's1', 's1')).toBe(false)
    expect(isDescendant(tree, 's1', 't3')).toBe(false)

    expect(wouldCreateHierarchyCycle(tree, 't1', 't1a')).toBe(true) // under own descendant
    expect(wouldCreateHierarchyCycle(tree, 't1', 't1')).toBe(true) // under itself
    expect(wouldCreateHierarchyCycle(tree, 't1', 't2')).toBe(false) // sibling
    expect(wouldCreateHierarchyCycle(tree, 't1', 't3')).toBe(false) // other story
    expect(wouldCreateHierarchyCycle(tree, 't1', null)).toBe(false)
  })

  it('findRootId / findRootStory', () => {
    expect(findRootId(tree, 't1a')).toBe('s1')
    expect(findRootId(tree, 's2')).toBe('s2')
    expect(findRootId(tree, 'ghost')).toBeNull()
    expect(findRootId([n('a', 'b'), n('b', 'a')], 'a')).toBeNull()
    expect(findRootStory(tree, 't1a')).toBe('s1')
    expect(findRootStory(tree, 's1')).toBe('s1')
    expect(findRootStory([n('x', null, 0, 'task')], 'x')).toBeNull()
  })
})

describe('resolvePlanNodes', () => {
  const raw = (over: Partial<RawPlanNode> & { id: string }): RawPlanNode => ({
    ideaId: 1,
    kind: over.parentId ? 'task' : 'story',
    title: over.id,
    description: '',
    parentId: null,
    projectId: over.parentId ? null : 7,
    sort: 0,
    devopsId: null,
    devopsUrl: null,
    devopsSyncedAt: null,
    createdAt: 10,
    updatedAt: 10,
    ...over
  })

  it('derives project, root story and depth, in hierarchy order', () => {
    const out = resolvePlanNodes([
      raw({ id: 'c', parentId: 'b' }),
      raw({ id: 'b', parentId: 'a' }),
      raw({ id: 'a', projectId: 3 }),
      raw({ id: 'z', projectId: 9 })
    ])
    expect(out.map((x) => [x.id, x.projectId, x.rootStoryId, x.depth])).toEqual([
      ['a', 3, 'a', 0],
      ['b', 3, 'a', 1],
      ['c', 3, 'a', 2],
      ['z', 9, 'z', 0]
    ])
  })

  it('flags ticketed nodes edited after the last sync as stale', () => {
    const out = resolvePlanNodes([
      raw({ id: 'plain' }),
      raw({ id: 'never', devopsId: 1 }),
      raw({ id: 'fresh', devopsId: 2, devopsSyncedAt: 50, updatedAt: 40 }),
      raw({ id: 'edited', devopsId: 3, devopsSyncedAt: 50, updatedAt: 60 })
    ])
    expect(Object.fromEntries(out.map((x) => [x.id, x.devopsStale]))).toEqual({
      plain: false,
      never: true,
      fresh: false,
      edited: true
    })
  })
})

describe('dependency helpers', () => {
  it('findDepCycle: null when acyclic; closed path when cyclic', () => {
    expect(findDepCycle([dep('a', 'b'), dep('b', 'c'), dep('a', 'c')])).toBeNull()
    expect(findDepCycle([])).toBeNull()
    const cycle = findDepCycle([dep('x', 'a'), dep('a', 'b'), dep('b', 'c'), dep('c', 'a')])!
    expect(cycle[0]).toBe(cycle[cycle.length - 1])
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']))
    // each element depends on the next one
    for (let i = 0; i < cycle.length - 1; i++) {
      expect([dep('a', 'b'), dep('b', 'c'), dep('c', 'a')]).toContainEqual(dep(cycle[i], cycle[i + 1]))
    }
  })

  it('wouldCreateDepCycle: self, direct, transitive, and benign additions', () => {
    const deps = [dep('b', 'a'), dep('c', 'b')] // c -> b -> a
    expect(wouldCreateDepCycle(deps, 'a', 'a')).toEqual(['a', 'a'])
    expect(wouldCreateDepCycle(deps, 'a', 'b')).toEqual(['a', 'b', 'a'])
    expect(wouldCreateDepCycle(deps, 'a', 'c')).toEqual(['a', 'c', 'b', 'a'])
    expect(wouldCreateDepCycle(deps, 'c', 'a')).toBeNull() // diamond-ish shortcut is fine
    expect(wouldCreateDepCycle(deps, 'd', 'a')).toBeNull()
    expect(wouldCreateDepCycle([], 'a', 'b')).toBeNull()
  })

  it('topoOrderDeps: prerequisites first, stable for independent nodes', () => {
    // a depends on b, b depends on c; d, e independent
    const out = topoOrderDeps(['a', 'd', 'b', 'e', 'c'], [dep('a', 'b'), dep('b', 'c')])
    expect(out.indexOf('c')).toBeLessThan(out.indexOf('b'))
    expect(out.indexOf('b')).toBeLessThan(out.indexOf('a'))
    expect(out).toEqual(['d', 'e', 'c', 'b', 'a'])
    expect(topoOrderDeps(['x', 'y', 'z'], [])).toEqual(['x', 'y', 'z'])
  })

  it('topoOrderDeps ignores deps outside the id set and throws dep_cycle on cycles', () => {
    expect(topoOrderDeps(['a', 'b'], [dep('a', 'ghost')])).toEqual(['a', 'b'])
    try {
      topoOrderDeps(['a', 'b'], [dep('a', 'b'), dep('b', 'a')])
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(PlanError)
      expect((e as PlanError).code).toBe('dep_cycle')
    }
  })
})
