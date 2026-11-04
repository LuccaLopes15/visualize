// Tests for the Fase 4 review fixes: draft state machine, fit decisions, dependency routing.
import { describe, expect, it } from 'vitest'
import { resolvePlanNodes } from '@shared/plan'
import type { PlanGraph, RawPlanNode } from '@shared/types'
import { DraftCore } from './draftCore'
import { BIG_CHANGE, shouldFitAfterLayout, shouldFitAfterResize, viewportUntouched } from './fit'
import { buildFlow } from './flow'
import { nodeSize, type Rect } from './layout'
import { isNotFoundError } from './ops'
import { midpoint, roundedPath, routeDependency, segmentHitsRect } from './route'

describe('DraftCore (useDraft state machine)', () => {
  it('H1: the trimmed echo of our own commit never overwrites what the user typed', () => {
    const d = new DraftCore('')
    d.edit('hello ')
    expect(d.flush()).toBe('hello ') // idle commit while typing
    expect(d.remote('hello')).toBe(false) // the server trimmed it
    expect(d.text).toBe('hello ')
    d.edit('hello world')
    expect(d.text).toBe('hello world')
  })

  it('H1: the echo arriving after the user already typed more is still recognised (no conflict)', () => {
    const d = new DraftCore('')
    d.edit('hello ')
    d.flush()
    d.edit('hello w') // typing continues before the echo
    expect(d.remote('hello')).toBe(false)
    expect(d.conflict).toBeNull()
    expect(d.text).toBe('hello w')
    expect(d.flush()).toBe('hello w')
  })

  it('H1: keeps a trailing newline typed before a pause', () => {
    const d = new DraftCore('item')
    d.edit('item\n- ')
    d.flush()
    expect(d.remote('item\n-')).toBe(false)
    expect(d.text).toBe('item\n- ')
  })

  it('does not commit when the text only differs by whitespace from the stored value', () => {
    const d = new DraftCore('abc')
    d.edit('abc  ')
    expect(d.flush()).toBeNull()
    expect(d.dirty).toBe(false)
  })

  it('follows a remote change while the user is not editing', () => {
    const d = new DraftCore('a')
    expect(d.remote('b')).toBe(true)
    expect(d.text).toBe('b')
    expect(d.base).toBe('b')
  })

  it('H2: a remote change while dirty is a conflict, never applied silently; the flush is held', () => {
    const d = new DraftCore('original')
    d.edit('minha versão')
    expect(d.remote('versão do Claude')).toBe(true)
    expect(d.conflict).toBe('versão do Claude')
    expect(d.text).toBe('minha versão')
    expect(d.flush()).toBeNull() // skipped until resolved
    expect(d.dirty).toBe(true)
    expect(d.remote('versão do Claude')).toBe(false) // same value again: nothing new
  })

  it('H2: "usar a versão do Claude" takes the remote text and drops the edit', () => {
    const d = new DraftCore('original')
    d.edit('minha')
    d.remote('do Claude')
    d.acceptRemote()
    expect(d).toMatchObject({ text: 'do Claude', base: 'do Claude', dirty: false, conflict: null })
    expect(d.flush()).toBeNull()
  })

  it('H2: "manter a minha" releases the hold, and the next flush overwrites the remote version', () => {
    const d = new DraftCore('original')
    d.edit('minha')
    d.remote('do Claude')
    d.keepMine()
    expect(d.conflict).toBeNull()
    expect(d.flush()).toBe('minha')
    expect(d.remote('minha')).toBe(false)
    expect(d.text).toBe('minha')
  })

  it('a remote value equal to the current text resolves quietly (both sides agree)', () => {
    const d = new DraftCore('a')
    d.edit('b ')
    expect(d.remote('b')).toBe(false)
    expect(d.conflict).toBeNull()
    expect(d.flush()).toBeNull() // nothing left to write
  })

  it('reset goes back to the stored value', () => {
    const d = new DraftCore('a')
    d.edit('zzz')
    d.remote('c')
    d.reset()
    expect(d).toMatchObject({ text: 'a', dirty: false, conflict: null })
  })
})

describe('isNotFoundError (L3)', () => {
  it('recognises the "node vanished" rejection, nothing else', () => {
    expect(isNotFoundError(new Error('Nó abc não encontrado.'))).toBe(true)
    expect(isNotFoundError(new Error('O título é obrigatório.'))).toBe(false)
    expect(isNotFoundError('x')).toBe(false)
  })
})

// ---- graphs -------------------------------------------------------------------------------

let seq = 0
function raw(id: string, kind: 'story' | 'task', parentId: string | null, sort: number, projectId: number | null = null): RawPlanNode {
  seq++
  return {
    id,
    ideaId: 1,
    kind,
    title: id,
    description: '',
    parentId,
    projectId,
    sort,
    devopsId: null,
    devopsUrl: null,
    devopsSyncedAt: null,
    createdAt: seq,
    updatedAt: seq
  }
}

/** S1 -> A, B, C and S2 -> X, Y, Z (one row of tasks each), A depends on Z (across the lanes). */
function twoRows(): PlanGraph {
  return {
    ideaId: 1,
    nodes: resolvePlanNodes([
      raw('S1', 'story', null, 0, 1),
      raw('A', 'task', 'S1', 0),
      raw('B', 'task', 'S1', 1),
      raw('C', 'task', 'S1', 2),
      raw('S2', 'story', null, 1, 2),
      raw('X', 'task', 'S2', 0),
      raw('Y', 'task', 'S2', 1),
      raw('Z', 'task', 'S2', 2)
    ]),
    deps: [{ fromId: 'A', toId: 'Z' }]
  }
}

describe('fit decisions (M1)', () => {
  const base = { firstLayout: false, layoutChanged: false, relayoutChanged: false, total: 10, prevTotal: 10 }

  it('first load fits; an empty plan never does', () => {
    expect(shouldFitAfterLayout({ ...base, firstLayout: true, layoutChanged: true })).toBe(true)
    expect(shouldFitAfterLayout({ ...base, firstLayout: true, layoutChanged: true, total: 0, prevTotal: 0 })).toBe(false)
  })

  it('"Reorganizar" / direction change fits once: later edits keep the viewport', () => {
    expect(shouldFitAfterLayout({ ...base, layoutChanged: true, relayoutChanged: true })).toBe(true)
    // the relayout counter did not move this time: one more task is an ordinary edit
    expect(shouldFitAfterLayout({ ...base, layoutChanged: true, total: 11, prevTotal: 10 })).toBe(false)
  })

  it('ordinary structural edits and selection changes do not refit', () => {
    expect(shouldFitAfterLayout({ ...base, layoutChanged: true, total: 11 })).toBe(false)
    expect(shouldFitAfterLayout({ ...base, layoutChanged: false })).toBe(false)
  })

  it('a big change (Claude writing the whole breakdown) refits', () => {
    expect(shouldFitAfterLayout({ ...base, layoutChanged: true, total: 10 + BIG_CHANGE })).toBe(true)
    expect(shouldFitAfterLayout({ ...base, layoutChanged: true, total: 10 - BIG_CHANGE })).toBe(true)
    expect(shouldFitAfterLayout({ ...base, layoutChanged: true, total: 5, prevTotal: 0 })).toBe(true)
  })

  it('collapsing does not refit: the plan size (not the visible count) is what is compared', () => {
    const g = twoRows()
    const collapsed = buildFlow(g, { dir: 'TB', collapsed: new Set(['S1', 'S2']) })
    const open = buildFlow(g, { dir: 'TB', collapsed: new Set() })
    expect(collapsed.nodes.length).toBe(2)
    expect(collapsed.total).toBe(8)
    expect(open.total).toBe(8)
    expect(shouldFitAfterLayout({ ...base, layoutChanged: true, total: collapsed.total, prevTotal: open.total })).toBe(false)
  })

  it('after a resize, refits only while the user has not moved the viewport', () => {
    const fit = { x: 40, y: 20, zoom: 0.5 }
    expect(viewportUntouched(fit, { x: 40.4, y: 19.6, zoom: 0.5 })).toBe(true)
    expect(shouldFitAfterResize(fit, { ...fit }, 9)).toBe(true)
    expect(shouldFitAfterResize(fit, { x: 120, y: 20, zoom: 0.5 }, 9)).toBe(false) // panned
    expect(shouldFitAfterResize(fit, { x: 40, y: 20, zoom: 0.8 }, 9)).toBe(false) // zoomed
    expect(shouldFitAfterResize(null, fit, 9)).toBe(false) // never auto-fitted
    expect(shouldFitAfterResize(fit, fit, 0)).toBe(false) // nothing to fit
  })
})

describe('dependency routing', () => {
  const card = (x: number, y: number): Rect => ({ x, y, w: 250, h: 96 })

  it('segmentHitsRect handles crossings, misses and the margin', () => {
    const r = { x: 100, y: 100, w: 50, h: 50 }
    expect(segmentHitsRect({ x: 0, y: 125 }, { x: 300, y: 125 }, r)).toBe(true)
    expect(segmentHitsRect({ x: 0, y: 200 }, { x: 300, y: 200 }, r)).toBe(false)
    expect(segmentHitsRect({ x: 0, y: 98 }, { x: 300, y: 98 }, r)).toBe(true) // inside the margin
    expect(segmentHitsRect({ x: 125, y: 0 }, { x: 125, y: 90 }, r)).toBe(false)
  })

  it('keeps the plain curve when nothing is in the way', () => {
    expect(routeDependency('TB', 'r', 'l', card(0, 0), card(400, 0), [])).toBeNull()
  })

  it('goes around a card standing between two cards on the same row (TB)', () => {
    const from = card(0, 100)
    const to = card(700, 100)
    const between = card(350, 100)
    const route = routeDependency('TB', 'r', 'l', from, to, [between])!
    expect(route).not.toBeNull()
    expect(route[0]).toEqual({ x: 250, y: 148 }) // right handle of the source
    expect(route[route.length - 1]).toEqual({ x: 700, y: 148 }) // left handle of the target
    for (let i = 0; i + 1 < route.length; i++) {
      expect(segmentHitsRect(route[i], route[i + 1], between, 0)).toBe(false)
      expect(route[i].x === route[i + 1].x || route[i].y === route[i + 1].y).toBe(true) // orthogonal
    }
  })

  it('works in LR too (transposed), starting on the bottom handle', () => {
    const from = card(100, 0)
    const to = card(100, 600)
    const between = card(100, 300)
    const route = routeDependency('LR', 'b', 't', from, to, [between])!
    expect(route).not.toBeNull()
    expect(route[0]).toEqual({ x: 225, y: 96 })
    for (let i = 0; i + 1 < route.length; i++) expect(segmentHitsRect(route[i], route[i + 1], between, 0)).toBe(false)
  })

  for (const dir of ['TB', 'LR'] as const) {
    it(`${dir}: buildFlow routes a cross-lane dependency around the cards in between`, () => {
      const m = buildFlow(twoRows(), { dir, collapsed: new Set() })
      const dep = m.edges.find((e) => e.kind === 'dep')!
      expect(dep.route).not.toBeNull()
      const pos = new Map(m.nodes.map((n) => [n.node.id, n.position]))
      for (const n of m.nodes) {
        if (n.node.id === dep.source || n.node.id === dep.target) continue
        const s = nodeSize(n.node.kind)
        const r = { ...pos.get(n.node.id)!, w: s.w, h: s.h }
        for (let i = 0; i + 1 < dep.route!.length; i++) {
          expect(segmentHitsRect(dep.route![i], dep.route![i + 1], r, 0)).toBe(false)
        }
      }
      // hierarchy edges never carry a route
      expect(m.edges.filter((e) => e.kind === 'hier').every((e) => e.route === null)).toBe(true)
    })
  }

  it('roundedPath draws rounded corners and midpoint sits halfway along the route', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 }
    ]
    expect(roundedPath(pts, 10)).toBe('M 0 0 L 90 0 Q 100 0 100 10 L 100 100')
    expect(midpoint(pts)).toEqual({ x: 100, y: 0 })
    expect(roundedPath([])).toBe('')
  })
})
