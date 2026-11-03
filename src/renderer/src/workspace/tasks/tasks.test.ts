import { describe, expect, it } from 'vitest'
import { resolvePlanNodes } from '@shared/plan'
import type { PlanGraph, PlanNode, RawPlanNode } from '@shared/types'
import { PROJECT_PALETTE, projectColor } from './colors'
import { diffNewIds } from './diff'
import { buildFlow, depHandles, pruneIds, visibleNodes } from './flow'
import { layoutPlan, LANE_GAP, nodeSize, type Rect } from './layout'
import { checkConnection, deleteImpact, depCandidates, descriptionPreview, moveSibling, parentOptions } from './ops'

let seq = 0
function raw(
  id: string,
  kind: 'story' | 'task',
  parentId: string | null,
  sort: number,
  projectId: number | null = null,
  devopsId: number | null = null
): RawPlanNode {
  seq++
  return {
    id,
    ideaId: 1,
    kind,
    title: `T ${id}`,
    description: '',
    parentId,
    projectId,
    sort,
    devopsId,
    devopsUrl: null,
    devopsSyncedAt: null,
    createdAt: seq,
    updatedAt: seq
  }
}

/**
 * The user's sketch: S1(project 1) -> T1 (1.1, 1.2), T2, T3 (3.1); S2(project 2) -> U1.
 * Deps: 3.1 depende de T1; U1 depende de 1.2 (cross-story).
 */
function sketch(): PlanGraph {
  const nodes = resolvePlanNodes([
    raw('S1', 'story', null, 0, 1),
    raw('T1', 'task', 'S1', 0),
    raw('T1.1', 'task', 'T1', 0),
    raw('T1.2', 'task', 'T1', 1),
    raw('T2', 'task', 'S1', 1),
    raw('T3', 'task', 'S1', 2),
    raw('T3.1', 'task', 'T3', 0),
    raw('S2', 'story', null, 1, 2),
    raw('U1', 'task', 'S2', 0)
  ])
  return {
    ideaId: 1,
    nodes,
    deps: [
      { fromId: 'T3.1', toId: 'T1' },
      { fromId: 'U1', toId: 'T1.2' }
    ]
  }
}

function rectOf(n: Pick<PlanNode, 'kind'>, p: { x: number; y: number }): Rect {
  const s = nodeSize(n.kind)
  return { x: p.x, y: p.y, w: s.w, h: s.h }
}
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('layoutPlan', () => {
  for (const dir of ['TB', 'LR'] as const) {
    it(`${dir}: no two nodes overlap and parents precede children along the flow`, () => {
      const g = sketch()
      const { positions } = layoutPlan(g.nodes, dir)
      expect(positions.size).toBe(g.nodes.length)
      for (let i = 0; i < g.nodes.length; i++) {
        for (let j = i + 1; j < g.nodes.length; j++) {
          const a = g.nodes[i]
          const b = g.nodes[j]
          expect(overlap(rectOf(a, positions.get(a.id)!), rectOf(b, positions.get(b.id)!))).toBe(false)
        }
      }
      for (const n of g.nodes) {
        if (!n.parentId) continue
        const p = positions.get(n.parentId)!
        const c = positions.get(n.id)!
        if (dir === 'TB') expect(c.y).toBeGreaterThan(p.y)
        else expect(c.x).toBeGreaterThan(p.x)
      }
    })

    it(`${dir}: keeps sibling order (sort) along the cross axis`, () => {
      const g = sketch()
      const { positions } = layoutPlan(g.nodes, dir)
      const axis = dir === 'TB' ? 'x' : 'y'
      expect(positions.get('T1')![axis]).toBeLessThan(positions.get('T2')![axis])
      expect(positions.get('T2')![axis]).toBeLessThan(positions.get('T3')![axis])
      expect(positions.get('T1.1')![axis]).toBeLessThan(positions.get('T1.2')![axis])
    })

    it(`${dir}: one lane per story, containing its nodes, lanes apart from each other`, () => {
      const g = sketch()
      const { positions, lanes } = layoutPlan(g.nodes, dir)
      expect(lanes.map((l) => l.storyId)).toEqual(['S1', 'S2'])
      expect(lanes.map((l) => l.projectId)).toEqual([1, 2])
      for (const n of g.nodes) {
        const lane = lanes.find((l) => l.storyId === n.rootStoryId)!
        const r = rectOf(n, positions.get(n.id)!)
        expect(r.x).toBeGreaterThanOrEqual(lane.x)
        expect(r.y).toBeGreaterThanOrEqual(lane.y)
        expect(r.x + r.w).toBeLessThanOrEqual(lane.x + lane.w)
        expect(r.y + r.h).toBeLessThanOrEqual(lane.y + lane.h)
      }
      const [a, b] = lanes
      expect(overlap(a, b)).toBe(false)
      if (dir === 'TB') expect(b.x - (a.x + a.w)).toBeGreaterThanOrEqual(LANE_GAP)
      else expect(b.y - (a.y + a.h)).toBeGreaterThanOrEqual(LANE_GAP)
    })
  }

  it('keeps sibling order in a wider, deeper tree (both directions)', () => {
    // S -> 6 children, each with 0..3 children of its own.
    const rows: RawPlanNode[] = [raw('S', 'story', null, 0, 1)]
    for (let i = 0; i < 6; i++) {
      rows.push(raw(`c${i}`, 'task', 'S', i))
      for (let j = 0; j < i % 4; j++) rows.push(raw(`c${i}.${j}`, 'task', `c${i}`, j))
    }
    const nodes = resolvePlanNodes(rows)
    for (const dir of ['TB', 'LR'] as const) {
      const { positions } = layoutPlan(nodes, dir)
      const axis = dir === 'TB' ? 'x' : 'y'
      for (const n of nodes) {
        const kids = nodes.filter((k) => k.parentId === n.id).sort((a, b) => a.sort - b.sort)
        for (let k = 1; k < kids.length; k++) {
          expect(positions.get(kids[k - 1].id)![axis]).toBeLessThan(positions.get(kids[k].id)![axis])
        }
      }
    }
  })

  it('handles an empty graph', () => {
    const { positions, lanes } = layoutPlan([], 'TB')
    expect(positions.size).toBe(0)
    expect(lanes).toEqual([])
  })

  it('a lone story is placed inside its lane', () => {
    const nodes = resolvePlanNodes([raw('A', 'story', null, 0, 5)])
    const { positions, lanes } = layoutPlan(nodes, 'TB')
    expect(lanes).toHaveLength(1)
    expect(positions.get('A')!.x).toBeGreaterThan(lanes[0].x)
  })
})

describe('buildFlow: edges', () => {
  it('hierarchy edges go parent -> child, dependency edges dependent -> dependency', () => {
    const g = sketch()
    const m = buildFlow(g, { dir: 'TB', collapsed: new Set() })
    const hier = m.edges.filter((e) => e.kind === 'hier')
    const deps = m.edges.filter((e) => e.kind === 'dep')
    expect(hier).toHaveLength(g.nodes.filter((n) => n.parentId).length)
    expect(hier.find((e) => e.target === 'T1.1')).toMatchObject({ source: 'T1', sourceHandle: 'b', targetHandle: 't' })
    expect(deps).toHaveLength(2)
    // "3.1 depende de Task 1": the arrow ends (target) at the dependency.
    expect(deps.find((e) => e.id === 'd:T3.1>T1')).toMatchObject({ source: 'T3.1', target: 'T1', aggregated: false })
    expect(deps.find((e) => e.id === 'd:U1>T1.2')).toMatchObject({ source: 'U1', target: 'T1.2' })
  })

  it('LR uses left/right handles for the hierarchy', () => {
    const m = buildFlow(sketch(), { dir: 'LR', collapsed: new Set() })
    expect(m.edges.find((e) => e.id === 'h:S1>T1')).toMatchObject({ sourceHandle: 'r', targetHandle: 'l' })
  })

  it('dependency handles use the free sides facing each other', () => {
    const size = { w: 100, h: 50 }
    const at = (x: number, y: number): { pos: { x: number; y: number }; size: typeof size } => ({ pos: { x, y }, size })
    expect(depHandles('TB', at(300, 0), at(0, 0))).toEqual({ source: 'l', target: 'r' })
    expect(depHandles('TB', at(0, 0), at(300, 100))).toEqual({ source: 'r', target: 'l' })
    expect(depHandles('TB', at(0, 0), at(0, 200))).toEqual({ source: 'r', target: 'r' })
    expect(depHandles('LR', at(0, 0), at(0, 200))).toEqual({ source: 'b', target: 't' })
    expect(depHandles('LR', at(0, 200), at(0, 0))).toEqual({ source: 't', target: 'b' })
  })

  it('child counts are direct children; collapsing hides the subtree and reroutes dependencies', () => {
    const g = sketch()
    const full = buildFlow(g, { dir: 'TB', collapsed: new Set() })
    expect(full.nodes.find((n) => n.node.id === 'S1')!.childCount).toBe(3)
    expect(full.nodes.find((n) => n.node.id === 'T1')!.childCount).toBe(2)

    const m = buildFlow(g, { dir: 'TB', collapsed: new Set(['T1']) })
    const ids = m.nodes.map((n) => n.node.id)
    expect(ids).not.toContain('T1.1')
    expect(ids).toContain('T1')
    const t1 = m.nodes.find((n) => n.node.id === 'T1')!
    expect(t1).toMatchObject({ collapsed: true, hiddenCount: 2, childCount: 2 })
    // U1 -> 1.2 is now drawn to T1 (aggregated); 3.1 -> T1 stays direct.
    expect(m.edges.find((e) => e.id === 'd:U1>T1')).toMatchObject({ aggregated: true })
    expect(m.edges.find((e) => e.id === 'd:T3.1>T1')).toMatchObject({ aggregated: false })
    expect(m.edges.every((e) => ids.includes(e.source) && ids.includes(e.target))).toBe(true)
  })

  it('layoutKey ignores titles/descriptions but reacts to structure, order and direction', () => {
    const g = sketch()
    const base = buildFlow(g, { dir: 'TB', collapsed: new Set() }).layoutKey
    const renamed: PlanGraph = {
      ...g,
      nodes: g.nodes.map((n) => (n.id === 'T2' ? { ...n, title: 'outro', description: 'x' } : n))
    }
    expect(buildFlow(renamed, { dir: 'TB', collapsed: new Set() }).layoutKey).toBe(base)
    expect(buildFlow(g, { dir: 'LR', collapsed: new Set() }).layoutKey).not.toBe(base)
    const moved: PlanGraph = { ...g, nodes: g.nodes.map((n) => (n.id === 'T2' ? { ...n, sort: 5 } : n)) }
    expect(buildFlow(moved, { dir: 'TB', collapsed: new Set() }).layoutKey).not.toBe(base)
  })

  it('visibleNodes drops whole collapsed subtrees only', () => {
    const g = sketch()
    expect(visibleNodes(g.nodes, new Set(['S1'])).map((n) => n.id)).toEqual(['S1', 'S2', 'U1'])
  })

  it('pruneIds forgets removed nodes and keeps the same Set when nothing changed', () => {
    const g = sketch()
    const same = new Set(['T1'])
    expect(pruneIds(same, g)).toBe(same)
    expect([...pruneIds(new Set(['T1', 'gone']), g)]).toEqual(['T1'])
  })
})

describe('projectColor', () => {
  it('is stable per project id and distinct for the first palette-size ids', () => {
    expect(projectColor(7)).toEqual(projectColor(7))
    const colors = new Set(Array.from({ length: PROJECT_PALETTE.length }, (_, i) => projectColor(i + 1).color))
    expect(colors.size).toBe(PROJECT_PALETTE.length)
  })
  it('wraps around and tolerates odd ids', () => {
    expect(projectColor(1).color).toBe(projectColor(1 + PROJECT_PALETTE.length).color)
    expect(PROJECT_PALETTE).toContain(projectColor(0).color)
    expect(PROJECT_PALETTE).toContain(projectColor(-3).color)
  })
  it('derives translucent lane colours from the solid one', () => {
    expect(projectColor(1).soft).toMatch(/^rgba\(\d+, \d+, \d+, 0\.\d+\)$/)
  })
})

describe('diffNewIds', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('first load highlights nothing', () => {
    expect(diffNewIds(null, nodes)).toEqual([])
  })
  it('returns only ids that were not there before', () => {
    expect(diffNewIds(new Set(['a', 'c']), nodes)).toEqual(['b'])
    expect(diffNewIds(new Set(['a', 'b', 'c']), nodes)).toEqual([])
    expect(diffNewIds(new Set(), nodes)).toEqual(['a', 'b', 'c'])
  })
})

describe('ops', () => {
  it('moveSibling swaps with the neighbour and refuses at the ends', () => {
    const g = sketch()
    expect(moveSibling(g.nodes, 'T2', -1)).toEqual(['T2', 'T1', 'T3'])
    expect(moveSibling(g.nodes, 'T2', 1)).toEqual(['T1', 'T3', 'T2'])
    expect(moveSibling(g.nodes, 'T1', -1)).toBeNull()
    expect(moveSibling(g.nodes, 'T3', 1)).toBeNull()
    expect(moveSibling(g.nodes, 'S2', -1)).toEqual(['S2', 'S1']) // stories reorder among themselves
    expect(moveSibling(g.nodes, 'nope', 1)).toBeNull()
  })

  it('parentOptions excludes the node and its descendants', () => {
    const g = sketch()
    expect(parentOptions(g.nodes, 'T1').map((n) => n.id)).toEqual(['S1', 'T2', 'T3', 'T3.1', 'S2', 'U1'])
  })

  it('depCandidates flags existing and cycle-closing choices', () => {
    const g = sketch()
    const c = Object.fromEntries(depCandidates(g, 'T1').map((x) => [x.node.id, x.blocked]))
    expect(c['T1']).toBeUndefined() // never itself
    expect(c['T3.1']).toBe('cycle') // 3.1 already depends on T1
    expect(c['T2']).toBeNull()
    const d = Object.fromEntries(depCandidates(g, 'T3.1').map((x) => [x.node.id, x.blocked]))
    expect(d['T1']).toBe('exists')
  })

  it('deleteImpact counts the subtree, dependencies and ticketed nodes', () => {
    const nodes = resolvePlanNodes([
      raw('S', 'story', null, 0, 1),
      raw('A', 'task', 'S', 0, null, 42),
      raw('A1', 'task', 'A', 0),
      raw('B', 'task', 'S', 1)
    ])
    const g: PlanGraph = {
      ideaId: 1,
      nodes,
      deps: [
        { fromId: 'B', toId: 'A1' },
        { fromId: 'B', toId: 'S' }
      ]
    }
    const imp = deleteImpact(g, 'A')
    expect(imp.ids).toEqual(['A', 'A1'])
    expect(imp.descendants).toBe(1)
    expect(imp.deps).toBe(1)
    expect(imp.ticketed.map((n) => n.id)).toEqual(['A'])
    expect(deleteImpact(g, 'B')).toMatchObject({ descendants: 0, deps: 2, ticketed: [] })
  })

  it('checkConnection: dependency mode', () => {
    const g = sketch()
    expect(checkConnection(g, 'dep', 'T2', 'T1')).toBeNull()
    expect(checkConnection(g, 'dep', 'T2', 'T2')).toMatch(/si mesmo/)
    expect(checkConnection(g, 'dep', 'T3.1', 'T1')).toMatch(/já depende/)
    // T1 depende de T3.1 would close T1 -> T3.1 -> T1
    expect(checkConnection(g, 'dep', 'T1', 'T3.1')).toMatch(/circular.*"T T1".*"T T3\.1".*"T T1"/)
  })

  it('checkConnection: child mode', () => {
    const g = sketch()
    expect(checkConnection(g, 'child', 'T2', 'T3')).toBeNull()
    expect(checkConnection(g, 'child', 'T2', 'S1')).toMatch(/Histórias não podem ter pai/)
    expect(checkConnection(g, 'child', 'S1', 'T1')).toMatch(/já é filha/)
    expect(checkConnection(g, 'child', 'T1.1', 'T1')).toMatch(/descendente/)
    expect(checkConnection(g, 'child', 'S2', 'T1')).toBeNull() // moving to another story is fine
  })
})

describe('descriptionPreview', () => {
  it('uses the first meaningful line without markdown markup', () => {
    expect(descriptionPreview('')).toBe('')
    expect(descriptionPreview(' \n \n ')).toBe('')
    expect(descriptionPreview('## Critérios\n- a')).toBe('Critérios')
    expect(descriptionPreview('- [ ] validar **estoque** e `sku`')).toBe('validar estoque e sku')
    expect(descriptionPreview('Veja [o doc](http://x.y/z) agora')).toBe('Veja o doc agora')
  })
  it('truncates long lines with an ellipsis', () => {
    const out = descriptionPreview('x'.repeat(300), 20)
    expect(out).toHaveLength(20)
    expect(out.endsWith('…')).toBe(true)
  })
})
