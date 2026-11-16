// Pure builders for Claude's board tools: they turn tool input into
// Excalidraw element *skeletons* (fed to convertToExcalidrawElements with
// regenerateIds: false) plus the arrow bindings to apply afterwards. No
// Excalidraw runtime import, so layout/placement is unit-tested in Node.
import { graphlib, layout } from '@dagrejs/dagre'
import type { BoardAddElement, BoardColor, FlowSpec, ShapeKind } from '@shared/board'
import { arrowBetween, freeSpaceOrigin, simplifyPolyline, type Box, type ElementLike } from './geometry'
import { PALETTE, TEXT_COLOR } from './palette'

/** Loose skeleton (cast to ExcalidrawElementSkeleton where Excalidraw is loaded). */
export type Skeleton = { id: string; type: string; x: number; y: number } & Record<string, unknown>

/** Arrow to bind (startBinding/endBinding + boundElements) after conversion. */
export interface ArrowBinding {
  arrowId: string
  fromId: string
  toId: string
}

export interface BuildResult {
  skeletons: Skeleton[]
  bindings: ArrowBinding[]
  /** Frame id -> ids of the elements it encloses (frameId set after conversion). */
  frames: { frameId: string; childIds: string[] }[]
  /** local id/ref -> created element id. */
  ids: Record<string, string>
  createdIds: string[]
  warnings: string[]
}

export type IdGen = (prefix: string) => string

export const randomId: IdGen = (prefix) => {
  let s = ''
  for (let i = 0; i < 8; i++) s += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)]
  return `${prefix}-${s}`
}

const PREFIX: Record<string, string> = {
  rectangle: 'r',
  ellipse: 'e',
  diamond: 'd',
  note: 'n',
  text: 't',
  arrow: 'a',
  frame: 'f'
}

// ---- sizing ------------------------------------------------------------------

export const NODE_FONT = 20
const CHAR_W = 0.56 // average glyph width / font size (Excalifont)
const LINE_H = 1.25

function textWidth(text: string, fontSize: number): number {
  const longest = text.split('\n').reduce((m, l) => Math.max(m, l.length), 0)
  return longest * fontSize * CHAR_W
}

function wrappedLines(text: string, fontSize: number, innerWidth: number): number {
  return text
    .split('\n')
    .reduce((n, l) => n + Math.max(1, Math.ceil((l.length * fontSize * CHAR_W) / Math.max(40, innerWidth))), 0)
}

/** Size that fits `label` in a shape of kind `shape`. */
export function shapeSize(label: string, shape: ShapeKind, fontSize = NODE_FONT): { width: number; height: number } {
  // Capped so long labels wrap into 2-3 lines instead of stretching the flow.
  const w = Math.min(240, Math.max(160, textWidth(label, fontSize) + 48))
  const lines = wrappedLines(label, fontSize, w - 40)
  const h = Math.max(72, Math.ceil(lines * fontSize * LINE_H + 36))
  if (shape === 'diamond') return { width: Math.round(w * 1.35), height: Math.round(h * 1.5) }
  if (shape === 'ellipse') return { width: Math.round(w * 1.15), height: Math.round(h * 1.2) }
  return { width: Math.round(w), height: Math.round(h) }
}

const DEFAULT_COLOR: Record<ShapeKind, BoardColor> = {
  rectangle: 'blue',
  ellipse: 'green',
  diamond: 'orange',
  note: 'yellow'
}

function shapeSkeleton(
  id: string,
  shape: ShapeKind,
  label: string | undefined,
  box: Box,
  color: BoardColor | undefined
): Skeleton {
  const c = PALETTE[color ?? DEFAULT_COLOR[shape]]
  const note = shape === 'note'
  const skel: Skeleton = {
    id,
    type: note ? 'rectangle' : shape,
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
    strokeColor: note ? c.fill : c.stroke,
    backgroundColor: c.fill,
    fillStyle: 'solid',
    strokeWidth: 2,
    roughness: 1,
    roundness: shape === 'rectangle' || note ? { type: 3 } : null
  }
  if (label) {
    skel['label'] = {
      text: label,
      fontSize: NODE_FONT,
      strokeColor: TEXT_COLOR,
      ...(note ? { textAlign: 'left', verticalAlign: 'top' } : {})
    }
  }
  return skel
}

function arrowSkeleton(
  id: string,
  geom: { x: number; y: number; points: [number, number][] },
  label: string | undefined,
  dashed: boolean
): Skeleton {
  const skel: Skeleton = {
    id,
    type: 'arrow',
    x: Math.round(geom.x),
    y: Math.round(geom.y),
    points: geom.points.map(([px, py]) => [Math.round(px), Math.round(py)]),
    strokeColor: TEXT_COLOR,
    strokeWidth: 2,
    strokeStyle: dashed ? 'dashed' : 'solid',
    roughness: 1,
    roundness: geom.points.length > 2 ? { type: 2 } : null,
    endArrowhead: 'arrow',
    startArrowhead: null
  }
  if (label) skel['label'] = { text: label, fontSize: 16, strokeColor: TEXT_COLOR }
  return skel
}

const FRAME_PAD = 48

function frameSkeleton(id: string, name: string, around: Box): Skeleton {
  return {
    id,
    type: 'frame',
    // Excalidraw treats 0 as "compute from children"; never pass exactly 0.
    x: around.x - FRAME_PAD || 0.01,
    y: around.y - FRAME_PAD || 0.01,
    width: around.width + FRAME_PAD * 2,
    height: around.height + FRAME_PAD * 2,
    name,
    children: []
  }
}

function boxOf(s: Skeleton): Box {
  return { x: s.x, y: s.y, width: Number(s['width'] ?? 0), height: Number(s['height'] ?? 0) }
}

function unionOf(boxes: Box[]): Box {
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.width))
  const maxY = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function polylineBox(s: Skeleton): Box {
  const pts = (s['points'] as [number, number][]) ?? [[0, 0]]
  const xs = pts.map((p) => s.x + p[0])
  const ys = pts.map((p) => s.y + p[1])
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

// ---- board_add_flow ---------------------------------------------------------------

/** Widest LR flow kept on one line; past it the flow wraps (~70% zoom on a common monitor). */
export const MAX_FLOW_WIDTH = 1400
const BAND_GAP = 110
/** Flows with fewer columns (dagre ranks) than this never wrap. */
const MIN_WRAP_COLUMNS = 5

interface LaidNode {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Wraps a wide LR layout into stacked bands (serpentine): columns (dagre ranks)
 * fill a band up to MAX_FLOW_WIDTH, the next band goes below it and odd bands
 * run right-to-left, so the arrow from one band to the next goes straight down.
 * Returns null when the flow already fits or is short.
 */
function serpentine(laid: LaidNode[]): {
  bandOf: Map<LaidNode, number>
  moveNode: (n: LaidNode) => void
  movePoint: (p: { x: number; y: number }, band: number) => { x: number; y: number }
} | null {
  // Columns: nodes of a rank share the center x.
  const cols = new Map<number, LaidNode[]>()
  for (const n of laid) {
    const k = Math.round(n.x)
    cols.set(k, [...(cols.get(k) ?? []), n])
  }
  const columns = [...cols.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ns]) => ({
      nodes: ns,
      left: Math.min(...ns.map((n) => n.x - n.width / 2)),
      right: Math.max(...ns.map((n) => n.x + n.width / 2))
    }))
  if (columns.length < MIN_WRAP_COLUMNS || columns[columns.length - 1].right - columns[0].left <= MAX_FLOW_WIDTH) return null

  const bands: { left: number; right: number; nodes: LaidNode[] }[] = []
  for (const c of columns) {
    const cur = bands[bands.length - 1]
    if (cur && c.right - cur.left <= MAX_FLOW_WIDTH) {
      cur.right = c.right
      cur.nodes.push(...c.nodes)
    } else bands.push({ left: c.left, right: c.right, nodes: [...c.nodes] })
  }
  const span = Math.max(...bands.map((b) => b.right - b.left))
  const bandOf = new Map<LaidNode, number>()
  const shift: { left: number; top: number; dy: number; flip: boolean }[] = []
  let y = 0
  bands.forEach((b, i) => {
    const top = Math.min(...b.nodes.map((n) => n.y - n.height / 2))
    const bottom = Math.max(...b.nodes.map((n) => n.y + n.height / 2))
    shift.push({ left: b.left, top, dy: y - top, flip: i % 2 === 1 })
    for (const n of b.nodes) bandOf.set(n, i)
    y += bottom - top + BAND_GAP
  })
  const movePoint = (p: { x: number; y: number }, i: number): { x: number; y: number } => {
    const s = shift[i]
    const local = p.x - s.left
    return { x: s.flip ? span - local : local, y: p.y + s.dy }
  }
  return {
    bandOf,
    movePoint,
    moveNode: (n) => {
      const p = movePoint(n, bandOf.get(n)!)
      n.x = p.x
      n.y = p.y
    }
  }
}

export function buildFlow(flow: FlowSpec, existing: readonly ElementLike[], genId: IdGen = randomId): BuildResult {
  const warnings: string[] = []
  const nodes = flow.nodes
  const seen = new Set<string>()
  for (const n of nodes) {
    if (seen.has(n.id)) throw new Error(`id de node repetido: "${n.id}". Cada node precisa de um id único.`)
    seen.add(n.id)
  }
  const dir = flow.direction === 'TB' ? 'TB' : 'LR'

  // Uniform size per shape kind (the widest label wins), so the flow looks even.
  const sizes = new Map<ShapeKind, { width: number; height: number }>()
  for (const n of nodes) {
    const shape = n.shape ?? 'rectangle'
    const s = shapeSize(n.label, shape)
    const cur = sizes.get(shape)
    sizes.set(shape, cur ? { width: Math.max(cur.width, s.width), height: Math.max(cur.height, s.height) } : s)
  }

  const g = new graphlib.Graph({ multigraph: true })
  g.setGraph({ rankdir: dir, nodesep: dir === 'LR' ? 60 : 70, ranksep: dir === 'LR' ? 90 : 80, edgesep: 30, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { ...sizes.get(n.shape ?? 'rectangle')! })
  const edges = flow.edges.filter((e, i) => {
    if (!seen.has(e.from) || !seen.has(e.to)) {
      warnings.push(`seta ${i + 1} ignorada: node "${!seen.has(e.from) ? e.from : e.to}" não existe`)
      return false
    }
    if (e.from === e.to) {
      warnings.push(`seta ${i + 1} ignorada: liga "${e.from}" a ele mesmo`)
      return false
    }
    return true
  })
  edges.forEach((e, i) => {
    const label = e.label ? { width: Math.min(220, textWidth(e.label, 16) + 16), height: 24, labelpos: 'c' } : { width: 0, height: 0 }
    g.setEdge(e.from, e.to, label, `e${i}`)
  })
  layout(g)
  const band = dir === 'LR' ? serpentine(nodes.map((n) => g.node(n.id))) : null
  if (band) {
    // Move the nodes (and the edges inside a band) to their serpentine place.
    for (const n of nodes) band.moveNode(g.node(n.id))
    edges.forEach((e, i) => {
      const ge = g.edge({ v: e.from, w: e.to, name: `e${i}` })
      const b = band.bandOf.get(g.node(e.from))
      if (ge && b !== undefined && b === band.bandOf.get(g.node(e.to))) {
        ge.points = (ge.points ?? []).map((p: { x: number; y: number }) => band.movePoint(p, b))
      } else if (ge) ge.points = [] // crosses bands: straight arrow between the boxes
    })
  }

  // Graph coordinates -> board: top-left of the flow at the free-space origin
  // (leaving room for the frame padding / title).
  const origin = freeSpaceOrigin(existing)
  let minX = Infinity
  let minY = Infinity
  for (const n of nodes) {
    const ln = g.node(n.id)
    minX = Math.min(minX, ln.x - ln.width / 2)
    minY = Math.min(minY, ln.y - ln.height / 2)
  }
  const useFrame = flow.frame ?? !!flow.title
  const offsetX = origin.x + (useFrame ? FRAME_PAD : 0) - minX
  const offsetY = origin.y + (useFrame ? FRAME_PAD : flow.title ? 50 : 0) - minY

  const ids: Record<string, string> = {}
  const skeletons: Skeleton[] = []
  const boxes = new Map<string, Box>()
  for (const n of nodes) {
    const shape = n.shape ?? 'rectangle'
    const ln = g.node(n.id)
    const box = { x: ln.x - ln.width / 2 + offsetX, y: ln.y - ln.height / 2 + offsetY, width: ln.width, height: ln.height }
    const id = genId(PREFIX[shape])
    ids[n.id] = id
    boxes.set(n.id, box)
    skeletons.push(shapeSkeleton(id, shape, n.label, box, n.color))
  }

  const bindings: ArrowBinding[] = []
  edges.forEach((e, i) => {
    const pts = (g.edge({ v: e.from, w: e.to, name: `e${i}` })?.points ?? []) as { x: number; y: number }[]
    let geom: { x: number; y: number; points: [number, number][] }
    if (pts.length >= 2) {
      const abs = simplifyPolyline(pts.map((p) => [p.x + offsetX, p.y + offsetY] as [number, number]))
      // dagre ends edges exactly on the node border; keep Excalidraw's binding gap.
      const straight = arrowBetween(boxes.get(e.from)!, boxes.get(e.to)!)
      if (abs.length === 2) geom = straight
      else {
        const [sx, sy] = abs[0]
        geom = { x: sx, y: sy, points: abs.map(([x, y]) => [x - sx, y - sy] as [number, number]) }
      }
    } else {
      geom = arrowBetween(boxes.get(e.from)!, boxes.get(e.to)!)
    }
    const id = genId('a')
    skeletons.push(arrowSkeleton(id, geom, e.label, e.style === 'dashed'))
    bindings.push({ arrowId: id, fromId: ids[e.from], toId: ids[e.to] })
  })

  const frames: BuildResult['frames'] = []
  const contentBox = unionOf(skeletons.map((s) => (s.type === 'arrow' ? polylineBox(s) : boxOf(s))))
  if (useFrame) {
    const frameId = genId('f')
    skeletons.push(frameSkeleton(frameId, flow.title ?? 'Fluxo', contentBox))
    frames.push({ frameId, childIds: skeletons.filter((s) => s.id !== frameId).map((s) => s.id) })
    ids['frame'] = frameId
  } else if (flow.title) {
    const id = genId('t')
    skeletons.unshift({ id, type: 'text', x: contentBox.x, y: contentBox.y - 50, text: flow.title, fontSize: 28, strokeColor: TEXT_COLOR })
    ids['title'] = id
  }

  return { skeletons, bindings, frames, ids, createdIds: skeletons.map((s) => s.id), warnings }
}

// ---- board_add ---------------------------------------------------------------------

const GRID_GAP = 60
const PER_ROW = 4

export function buildAdd(
  elements: readonly BoardAddElement[],
  existing: readonly ElementLike[],
  genId: IdGen = randomId
): BuildResult {
  const warnings: string[] = []
  const ids: Record<string, string> = {}
  const skeletons: Skeleton[] = []
  const boxes = new Map<string, Box>() // element id -> box (new + existing)
  for (const e of existing) if (!e.isDeleted) boxes.set(e.id, { x: e.x, y: e.y, width: e.width, height: e.height })

  // Unpositioned shapes flow in a grid starting at the free-space origin.
  const origin = freeSpaceOrigin(existing)
  let cursorX = origin.x
  let cursorY = origin.y
  let rowH = 0
  let inRow = 0
  const place = (w: number, h: number): { x: number; y: number } => {
    if (inRow >= PER_ROW) {
      cursorX = origin.x
      cursorY += rowH + GRID_GAP
      rowH = 0
      inRow = 0
    }
    const p = { x: cursorX, y: cursorY }
    cursorX += w + GRID_GAP
    rowH = Math.max(rowH, h)
    inRow++
    return p
  }

  const resolveRef = (key: string | undefined): string | null => {
    if (!key) return null
    if (ids[key]) return ids[key]
    return boxes.has(key) ? key : null
  }

  // 1st pass: shapes, notes and texts.
  for (const [i, el] of elements.entries()) {
    if (el.kind === 'arrow' || el.kind === 'frame') continue
    const id = genId(PREFIX[el.kind])
    if (el.ref) ids[el.ref] = id
    if (el.kind === 'text') {
      if (!el.label?.trim()) {
        warnings.push(`elemento ${i + 1} (text) ignorado: sem texto`)
        continue
      }
      const fontSize = el.fontSize ?? 20
      const w = Math.max(20, textWidth(el.label, fontSize))
      const h = el.label.split('\n').length * fontSize * LINE_H
      const p = el.x !== undefined && el.y !== undefined ? { x: el.x, y: el.y } : place(w, h)
      const c = el.color ? PALETTE[el.color].stroke : TEXT_COLOR
      skeletons.push({ id, type: 'text', x: p.x, y: p.y, text: el.label, fontSize, strokeColor: c })
      boxes.set(id, { x: p.x, y: p.y, width: w, height: h })
      continue
    }
    if (el.kind === 'note' && !el.label?.trim()) {
      warnings.push(`elemento ${i + 1} (note) ignorado: sem texto`)
      continue
    }
    const auto = shapeSize(el.label ?? '', el.kind)
    const width = el.width ?? (el.kind === 'note' ? Math.max(auto.width, 200) : auto.width)
    const height = el.height ?? (el.kind === 'note' ? Math.max(auto.height, 120) : auto.height)
    const p = el.x !== undefined && el.y !== undefined ? { x: el.x, y: el.y } : place(width, height)
    const box = { x: p.x, y: p.y, width, height }
    skeletons.push(shapeSkeleton(id, el.kind, el.label, box, el.color))
    boxes.set(id, box)
  }

  // 2nd pass: arrows between resolved elements.
  const bindings: ArrowBinding[] = []
  for (const [i, el] of elements.entries()) {
    if (el.kind !== 'arrow') continue
    const from = resolveRef(el.from)
    const to = resolveRef(el.to)
    if (!from || !to) {
      warnings.push(`seta ${i + 1} ignorada: ${!from ? `origem "${el.from ?? ''}"` : `destino "${el.to ?? ''}"`} não encontrada (use um id do board_read ou um ref desta chamada)`)
      continue
    }
    if (from === to) {
      warnings.push(`seta ${i + 1} ignorada: origem e destino são o mesmo elemento`)
      continue
    }
    const id = genId('a')
    if (el.ref) ids[el.ref] = id
    skeletons.push(arrowSkeleton(id, arrowBetween(boxes.get(from)!, boxes.get(to)!), el.label, el.style === 'dashed'))
    bindings.push({ arrowId: id, fromId: from, toId: to })
  }

  // 3rd pass: frames around their children (or an explicit area).
  const frames: BuildResult['frames'] = []
  for (const [i, el] of elements.entries()) {
    if (el.kind !== 'frame') continue
    const childIds = (el.children ?? []).map((c) => resolveRef(c)).filter((c): c is string => !!c)
    let area: Box | null = null
    if (childIds.length) area = unionOf(childIds.map((c) => boxes.get(c)!))
    else if (el.x !== undefined && el.y !== undefined && el.width && el.height) {
      area = { x: el.x + FRAME_PAD, y: el.y + FRAME_PAD, width: el.width - FRAME_PAD * 2, height: el.height - FRAME_PAD * 2 }
    }
    if (!area) {
      warnings.push(`frame ${i + 1} ignorado: informe children (ids/refs) ou x, y, width e height`)
      continue
    }
    const id = genId('f')
    if (el.ref) ids[el.ref] = id
    skeletons.push(frameSkeleton(id, el.label ?? 'Frame', area))
    frames.push({ frameId: id, childIds })
  }

  return { skeletons, bindings, frames, ids, createdIds: skeletons.map((s) => s.id), warnings }
}
