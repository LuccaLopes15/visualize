import { describe, expect, it } from 'vitest'
import type { FlowSpec } from '@shared/board'
import { MAX_FLOW_WIDTH, buildAdd, buildFlow, shapeSize, type Skeleton } from './build'
import { boxesOverlap, clusterBoxes, freeSpaceOrigin, simplifyPolyline, type ElementLike } from './geometry'
import { formatBoardSummary } from './summary'
import { PALETTE } from './palette'
import { applyLiveEvent } from '../chat/liveTurn'

let n = 0
const seqId = (prefix: string): string => `${prefix}-${++n}`

const existing: ElementLike[] = [
  { id: 'old1', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 },
  { id: 'old2', type: 'ellipse', x: 300, y: 400, width: 100, height: 80 },
  { id: 'gone', type: 'rectangle', x: 5000, y: 0, width: 10, height: 10, isDeleted: true }
]

const box = (s: Skeleton): { x: number; y: number; width: number; height: number } => ({
  x: s.x,
  y: s.y,
  width: Number(s['width']),
  height: Number(s['height'])
})

const flow: FlowSpec = {
  title: 'Captura → Workspace',
  direction: 'LR',
  nodes: [
    { id: 'captura', label: 'Captura (Ctrl+Alt+Space)' },
    { id: 'hub', label: 'Hub' },
    { id: 'ok', label: 'Tem projeto?', shape: 'diamond' },
    { id: 'ws', label: 'Workspace', color: 'green' }
  ],
  edges: [
    { from: 'captura', to: 'hub', label: 'salva' },
    { from: 'hub', to: 'ok' },
    { from: 'ok', to: 'ws', label: 'sim' },
    { from: 'ok', to: 'nope' },
    { from: 'hub', to: 'hub' }
  ]
}

describe('buildFlow', () => {
  it('lays nodes out without overlaps, right of the existing content', () => {
    n = 0
    const r = buildFlow(flow, existing, seqId)
    const shapes = r.skeletons.filter((s) => s.type !== 'arrow' && s.type !== 'frame')
    expect(shapes).toHaveLength(4)
    // ids are generated and mapped from the local node ids
    expect(Object.keys(r.ids).sort()).toEqual(['captura', 'frame', 'hub', 'ok', 'ws'])
    expect(shapes.map((s) => s.id)).toEqual([r.ids['captura'], r.ids['hub'], r.ids['ok'], r.ids['ws']])
    // no overlaps (with a margin)
    for (let i = 0; i < shapes.length; i++)
      for (let j = i + 1; j < shapes.length; j++) expect(boxesOverlap(box(shapes[i]), box(shapes[j]), 20)).toBe(false)
    // all to the right of the live existing bbox (deleted element ignored)
    for (const s of r.skeletons) expect(s.x).toBeGreaterThan(400)
    expect(r.skeletons.every((s) => s.x < 4000)).toBe(true)
    // LR: x grows along the chain
    const [c, h, o, w] = shapes
    expect(c.x).toBeLessThan(h.x)
    expect(h.x).toBeLessThan(o.x)
    expect(o.x).toBeLessThan(w.x)
    // uniform rectangle size
    expect(box(c).width).toBe(box(h).width)
    expect(box(c).height).toBe(box(h).height)
    // diamond, colors and labels
    expect(o.type).toBe('diamond')
    expect(w['backgroundColor']).toBe(PALETTE.green.fill)
    expect((c['label'] as { text: string }).text).toBe('Captura (Ctrl+Alt+Space)')
  })

  it('creates bound arrows for valid edges and warns about the rest', () => {
    n = 0
    const r = buildFlow(flow, existing, seqId)
    const arrows = r.skeletons.filter((s) => s.type === 'arrow')
    expect(arrows).toHaveLength(3)
    expect(r.bindings).toEqual([
      { arrowId: arrows[0].id, fromId: r.ids['captura'], toId: r.ids['hub'] },
      { arrowId: arrows[1].id, fromId: r.ids['hub'], toId: r.ids['ok'] },
      { arrowId: arrows[2].id, fromId: r.ids['ok'], toId: r.ids['ws'] }
    ])
    expect((arrows[0]['label'] as { text: string }).text).toBe('salva')
    expect(r.warnings).toHaveLength(2)
    // arrow starts outside its source box
    const src = box(r.skeletons.find((s) => s.id === r.ids['captura'])!)
    expect(arrows[0].x).toBeGreaterThanOrEqual(src.x + src.width)
  })

  it('wraps everything in a named frame when there is a title', () => {
    n = 0
    const r = buildFlow(flow, existing, seqId)
    const frame = r.skeletons.find((s) => s.type === 'frame')!
    expect(frame['name']).toBe('Captura → Workspace')
    expect(r.frames[0].childIds).toHaveLength(r.skeletons.length - 1)
    const fb = box(frame)
    for (const s of r.skeletons.filter((x) => x.type !== 'frame' && x.type !== 'arrow')) {
      const b = box(s)
      expect(b.x).toBeGreaterThan(fb.x)
      expect(b.y).toBeGreaterThan(fb.y)
      expect(b.x + b.width).toBeLessThan(fb.x + fb.width)
      expect(b.y + b.height).toBeLessThan(fb.y + fb.height)
    }
  })

  it('TB flows grow downwards; empty board starts at the origin; duplicate ids fail', () => {
    n = 0
    const r = buildFlow(
      { direction: 'TB', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] },
      [],
      seqId
    )
    const [a, b] = r.skeletons.filter((s) => s.type === 'rectangle')
    expect(a.y).toBeLessThan(b.y)
    expect(Math.min(...r.skeletons.map((s) => s.x))).toBeGreaterThanOrEqual(0)
    expect(r.skeletons.some((s) => s.type === 'frame')).toBe(false)
    expect(() => buildFlow({ nodes: [{ id: 'x', label: '1' }, { id: 'x', label: '2' }], edges: [] }, [], seqId)).toThrow(
      /repetido/
    )
  })
})

describe('buildFlow: fluxos LR largos', () => {
  const chain = (steps: number): FlowSpec => ({
    direction: 'LR',
    nodes: Array.from({ length: steps }, (_, i) => ({ id: `p${i}`, label: `Passo ${i + 1} do processo` })),
    edges: Array.from({ length: steps - 1 }, (_, i) => ({ from: `p${i}`, to: `p${i + 1}` }))
  })
  const shapesOf = (r: ReturnType<typeof buildFlow>): Skeleton[] => r.skeletons.filter((s) => s.type === 'rectangle')
  const widthOf = (ss: Skeleton[]): number =>
    Math.max(...ss.map((s) => s.x + Number(s['width']))) - Math.min(...ss.map((s) => s.x))

  it('long labels wrap into taller boxes instead of wider ones', () => {
    const short = shapeSize('Hub', 'rectangle')
    const long = shapeSize('Validar o pedido do cliente e reservar o estoque', 'rectangle')
    expect(long.width).toBeLessThanOrEqual(240)
    expect(long.height).toBeGreaterThan(short.height)
  })

  it('a short chain stays on one line', () => {
    n = 0
    const shapes = shapesOf(buildFlow(chain(4), [], seqId))
    expect(new Set(shapes.map((s) => s.y)).size).toBe(1)
    for (let i = 1; i < shapes.length; i++) expect(shapes[i].x).toBeGreaterThan(shapes[i - 1].x)
  })

  it.each([10, 12, 16])('a %i-step chain wraps in a serpentine within MAX_FLOW_WIDTH', (steps) => {
    n = 0
    const r = buildFlow(chain(steps), [], seqId)
    const shapes = shapesOf(r)
    expect(shapes).toHaveLength(steps)
    expect(widthOf(shapes)).toBeLessThanOrEqual(MAX_FLOW_WIDTH)
    for (let i = 0; i < shapes.length; i++)
      for (let j = i + 1; j < shapes.length; j++) expect(boxesOverlap(box(shapes[i]), box(shapes[j]), 20)).toBe(false)
    // rows top to bottom; the 1st runs left-to-right, the 2nd right-to-left
    const rows = [...new Set(shapes.map((s) => s.y))].sort((a, b) => a - b)
    expect(rows.length).toBeGreaterThan(1)
    const row = (k: number): Skeleton[] => shapes.filter((s) => s.y === rows[k])
    expect(shapes.indexOf(row(0)[0])).toBe(0)
    for (const [k, xs] of [row(0), row(1)].entries()) {
      for (let i = 1; i < xs.length; i++) {
        if (k === 0) expect(xs[i].x).toBeGreaterThan(xs[i - 1].x)
        else expect(xs[i].x).toBeLessThan(xs[i - 1].x)
      }
    }
    // the step that changes rows sits right below the end of the previous row
    const last0 = row(0)[row(0).length - 1]
    expect(row(1)[0].x).toBe(last0.x)
    // every edge still becomes a bound arrow, none of them crossing the boxes' rows wildly
    expect(r.bindings).toHaveLength(steps - 1)
    const arrows = r.skeletons.filter((s) => s.type === 'arrow')
    for (const a of arrows) for (const [px] of a['points'] as [number, number][]) expect(Math.abs(px)).toBeLessThan(MAX_FLOW_WIDTH)
  })
})

describe('buildAdd', () => {
  it('places unpositioned elements in free space and binds arrows to refs and existing ids', () => {
    n = 0
    const r = buildAdd(
      [
        { kind: 'rectangle', ref: 'a', label: 'Nova' },
        { kind: 'note', ref: 'n', label: 'lembrar disso' },
        { kind: 'text', label: 'Título', x: 10, y: -80 },
        { kind: 'arrow', from: 'a', to: 'old1', label: 'usa' },
        { kind: 'arrow', from: 'a', to: 'missing' },
        { kind: 'frame', label: 'Grupo', children: ['a', 'n'] }
      ],
      existing,
      seqId
    )
    const rect = r.skeletons.find((s) => s.id === r.ids['a'])!
    expect(rect.x).toBeGreaterThan(400)
    const text = r.skeletons.find((s) => s.type === 'text')!
    expect([text.x, text.y]).toEqual([10, -80])
    expect(r.bindings).toEqual([{ arrowId: expect.any(String), fromId: r.ids['a'], toId: 'old1' }])
    expect(r.warnings.join()).toContain('missing')
    expect(r.frames[0].childIds).toEqual([r.ids['a'], r.ids['n']])
    const note = r.skeletons.find((s) => s.id === r.ids['n'])!
    expect(note['backgroundColor']).toBe(PALETTE.yellow.fill)
    expect(boxesOverlap(box(rect), box(note))).toBe(false)
  })
})

describe('geometry', () => {
  it('free space origin is right of the live bbox', () => {
    expect(freeSpaceOrigin([])).toEqual({ x: 0, y: 0 })
    expect(freeSpaceOrigin(existing)).toEqual({ x: 400 + 140, y: 0 })
  })
  it('simplifies collinear points and clusters strokes', () => {
    expect(simplifyPolyline([[0, 0], [5, 0], [10, 0], [10, 10]])).toEqual([[0, 0], [10, 0], [10, 10]])
    const clusters = clusterBoxes([
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      { minX: 20, minY: 0, maxX: 30, maxY: 10 },
      { minX: 500, minY: 500, maxX: 510, maxY: 510 }
    ])
    expect(clusters.map((c) => c.count).sort()).toEqual([1, 2])
  })
})

describe('formatBoardSummary', () => {
  it('describes shapes, labels, arrows, freehand, images and frames', () => {
    const els: ElementLike[] = [
      { id: 'f1', type: 'frame', x: -20, y: -20, width: 600, height: 300, name: 'Fluxo' },
      {
        id: 'r1',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 180,
        height: 80,
        backgroundColor: PALETTE.blue.fill,
        frameId: 'f1',
        boundElements: [{ id: 't1', type: 'text' }]
      },
      { id: 't1', type: 'text', x: 10, y: 10, width: 50, height: 20, text: 'Captura', containerId: 'r1', frameId: 'f1' },
      { id: 'r2', type: 'diamond', x: 300, y: 0, width: 100, height: 100 },
      { id: 'a1', type: 'arrow', x: 180, y: 40, width: 120, height: 0, points: [[0, 0], [120, 0]], startBinding: { elementId: 'r1' }, endBinding: { elementId: 'r2' }, strokeStyle: 'dashed' },
      { id: 'fd1', type: 'freedraw', x: 1000, y: 1000, width: 30, height: 30, points: [[0, 0], [30, 30]] },
      { id: 'fd2', type: 'freedraw', x: 1040, y: 1000, width: 30, height: 30, points: [[0, 0], [30, 30]] },
      { id: 'img', type: 'image', x: 0, y: 500, width: 64, height: 64 },
      { id: 'del', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, isDeleted: true }
    ]
    const text = formatBoardSummary(els)
    expect(text).toContain('Área ocupada: x de -20 a 1070')
    expect(text).toContain('- [f1] frame "Fluxo" x=-20 y=-20 w=600 h=300 (2 elementos dentro)')
    expect(text).toContain('- [r1] retângulo "Captura" x=0 y=0 w=180 h=80 cor=blue (no frame [f1])')
    expect(text).toContain('- [r2] losango x=300 y=0 w=100 h=100')
    expect(text).toContain('- [a1] seta tracejada de [r1] "Captura" → [r2]')
    expect(text).toContain('traço livre na região x=1000 y=1000 w=70 h=30 (2 traços)')
    expect(text).toContain('- [img] imagem x=0 y=500 w=64 h=64')
    expect(text).not.toContain('[t1]')
    expect(text).not.toContain('[del]')
    expect(formatBoardSummary([])).toBe('O board está vazio.')
  })

  it('truncates long boards', () => {
    const many: ElementLike[] = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, type: 'rectangle', x: i * 10, y: 0, width: 5, height: 5 }))
    const text = formatBoardSummary(many, 10)
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(10)
    expect(text).toContain('… e mais 20 item(ns)')
  })
})

describe('applyLiveEvent (chat panel)', () => {
  it('accumulates text and tool chips like the main process does', () => {
    let live = applyLiveEvent(null, { ideaId: 1, kind: 'userMessage', message: { id: 1, ideaId: 1, role: 'user', blocks: [], createdAt: 0 } })
    live = applyLiveEvent(live, { ideaId: 1, kind: 'textDelta', text: 'Vou ' })
    live = applyLiveEvent(live, { ideaId: 1, kind: 'textDelta', text: 'ler' })
    live = applyLiveEvent(live, {
      ideaId: 1,
      kind: 'toolStart',
      tool: { type: 'tool', id: 't', name: 'Read', label: 'Lendo arquivo', summary: 'a', status: 'running' }
    })
    live = applyLiveEvent(live, { ideaId: 1, kind: 'toolEnd', id: 't', ok: true })
    expect(live?.blocks).toEqual([
      { type: 'text', text: 'Vou ler' },
      { type: 'tool', id: 't', name: 'Read', label: 'Lendo arquivo', summary: 'a', status: 'ok', error: undefined }
    ])
    expect(applyLiveEvent(live, { ideaId: 1, kind: 'reset' })).toBeNull()
  })
})
