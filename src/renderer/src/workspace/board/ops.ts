// Applies Claude's board operations on the live Excalidraw scene of the open
// workspace. Runs in the renderer (it owns the scene); main relays the tool
// call over IPC (events:boardRequest) and waits for the reply. Changes go
// through `updateScene` with captureUpdate IMMEDIATELY: the user can Ctrl+Z
// them, and the regular onChange → autosave path persists them.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { BoardAddElement, BoardOp, BoardOpResult, BoardUpdate, FlowSpec } from '@shared/board'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { boardService } from '../boardService'
import { buildAdd, buildFlow, type BuildResult } from './build'
import { arrowBetween, unionBBox, type Box, type ElementLike } from './geometry'
import { PALETTE, TEXT_COLOR } from './palette'
import { formatBoardSummary } from './summary'

type El = ElementLike & Record<string, any>

/** Lets the workspace show "Claude mexeu no board" on a hidden Board tab. */
export const BOARD_CHANGED_EVENT = 'visualize:boardChangedByClaude'

async function waitForBoard(ideaId: number, timeoutMs = 8000): Promise<ExcalidrawImperativeAPI | null> {
  const ready = boardService.get(ideaId)
  if (ready) return ready
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(boardService.get(ideaId))
    }, timeoutMs)
    const off = boardService.subscribe(() => {
      const api = boardService.get(ideaId)
      if (api) {
        clearTimeout(timer)
        off()
        resolve(api)
      }
    })
  })
}

export async function applyBoardOp(ideaId: number, op: BoardOp): Promise<BoardOpResult> {
  const api = await waitForBoard(ideaId)
  if (!api) return { ok: false, text: 'O board desta ideia não está aberto no momento.' }
  try {
    switch (op.op) {
      case 'read':
        return { ok: true, text: formatBoardSummary(api.getSceneElements() as unknown as El[], op.maxElements ?? 200) }
      case 'add':
        return await addElements(ideaId, api, (existing) => buildAdd(op.elements as BoardAddElement[], existing), 'add')
      case 'addFlow':
        return await addElements(ideaId, api, (existing) => buildFlow(op.flow as FlowSpec, existing), 'flow')
      case 'update':
        return await updateElements(ideaId, api, op.updates)
      case 'delete':
        return await deleteElements(ideaId, api, op.ids)
      default:
        return { ok: false, text: 'Operação de board desconhecida.' }
    }
  } catch (err) {
    console.error('[board] op falhou', op, err)
    return { ok: false, text: `Erro ao alterar o board: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function excalidraw(): Promise<typeof import('@excalidraw/excalidraw')> {
  return import('@excalidraw/excalidraw')
}

function bump(lib: typeof import('@excalidraw/excalidraw'), el: El, updates: Record<string, unknown>): El {
  return lib.newElementWith(el as any, updates as any) as unknown as El
}

/** The user is dragging / drawing / typing: don't yank the viewport. */
function userBusy(api: ExcalidrawImperativeAPI): boolean {
  const s = api.getAppState() as unknown as Record<string, unknown>
  return s['cursorButton'] === 'down' || !!s['editingTextElement'] || !!s['newElement'] || s['isResizing'] === true
}

function reveal(api: ExcalidrawImperativeAPI, elements: El[]): void {
  if (!elements.length || userBusy(api)) return
  try {
    api.scrollToContent(elements as any, { fitToViewport: true, viewportZoomFactor: 0.8, animate: true, maxZoom: 1 })
  } catch {
    /* hidden tab mid-layout: not important */
  }
}

function notifyChanged(ideaId: number): void {
  window.dispatchEvent(new CustomEvent(BOARD_CHANGED_EVENT, { detail: { ideaId } }))
}

async function addElements(
  ideaId: number,
  api: ExcalidrawImperativeAPI,
  build: (existing: El[]) => BuildResult,
  kind: 'add' | 'flow'
): Promise<BoardOpResult> {
  const lib = await excalidraw()
  const existing = api.getSceneElements() as unknown as El[]
  const result = build(existing)
  if (result.skeletons.length === 0) {
    return { ok: false, text: `Nada foi desenhado. ${result.warnings.join('; ')}` }
  }
  const created = lib.convertToExcalidrawElements(result.skeletons as any, { regenerateIds: false }) as unknown as El[]
  const createdById = new Map(created.map((e) => [e.id, e]))
  const changedExisting = new Map<string, El>()
  const current = (id: string): El | undefined => createdById.get(id) ?? changedExisting.get(id) ?? existing.find((e) => e.id === id)
  const setExisting = (id: string, updates: Record<string, unknown>): void => {
    const el = current(id)
    if (!el) return
    if (createdById.has(id)) Object.assign(el, updates)
    else changedExisting.set(id, bump(lib, el, updates))
  }

  for (const b of result.bindings) {
    const arrow = createdById.get(b.arrowId)
    if (!arrow) continue
    Object.assign(arrow, {
      startBinding: { elementId: b.fromId, focus: 0, gap: 6 },
      endBinding: { elementId: b.toId, focus: 0, gap: 6 }
    })
    for (const target of [b.fromId, b.toId]) {
      const el = current(target)
      if (!el) continue
      setExisting(target, { boundElements: [...(el.boundElements ?? []), { id: b.arrowId, type: 'arrow' }] })
    }
  }

  for (const f of result.frames) {
    for (const childId of f.childIds) {
      const child = current(childId)
      if (!child) continue
      setExisting(childId, { frameId: f.frameId })
      for (const be of child.boundElements ?? []) {
        if (be.type === 'text') setExisting(be.id, { frameId: f.frameId })
      }
    }
  }

  const all = api.getSceneElementsIncludingDeleted() as unknown as El[]
  // Frames must come before their children in z-order? Excalidraw draws
  // frame names/clipping itself; it only needs the frame present. Put new
  // frames first among the created elements so children render on top.
  const createdOrdered = [...created.filter((e) => e.type === 'frame'), ...created.filter((e) => e.type !== 'frame')]
  api.updateScene({
    elements: [...all.map((e) => changedExisting.get(e.id) ?? e), ...createdOrdered] as any,
    captureUpdate: lib.CaptureUpdateAction.IMMEDIATELY
  })
  reveal(api, created)
  notifyChanged(ideaId)

  const bb = unionBBox(created)!
  const area = `x=${Math.round(bb.minX)} y=${Math.round(bb.minY)} w=${Math.round(bb.maxX - bb.minX)} h=${Math.round(bb.maxY - bb.minY)}`
  const idList = Object.entries(result.ids)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  const shapes = result.skeletons.filter((s) => s.type !== 'arrow' && s.type !== 'frame').length
  const arrows = result.skeletons.filter((s) => s.type === 'arrow').length
  const lines = [
    kind === 'flow'
      ? `Fluxo desenhado: ${shapes} caixa(s) e ${arrows} seta(s) na região ${area}.`
      : `Adicionado(s) ${result.skeletons.length} elemento(s) na região ${area}.`,
    idList ? `Ids criados (local=id no board): ${idList}.` : `Ids criados: ${result.createdIds.join(', ')}.`
  ]
  if (result.warnings.length) lines.push(`Avisos: ${result.warnings.join('; ')}.`)
  return { ok: true, text: lines.join('\n') }
}

// ---- update -----------------------------------------------------------------------

const boxOf = (e: El): Box => ({ x: e.x, y: e.y, width: e.width, height: e.height })

async function updateElements(ideaId: number, api: ExcalidrawImperativeAPI, updates: BoardUpdate[]): Promise<BoardOpResult> {
  const lib = await excalidraw()
  const all = api.getSceneElementsIncludingDeleted() as unknown as El[]
  const next = new Map<string, El>(all.map((e) => [e.id, e]))
  const added: El[] = []
  const live = (id: string): El | undefined => {
    const e = next.get(id)
    return e && !e.isDeleted ? e : undefined
  }
  const set = (id: string, updates: Record<string, unknown>): El | undefined => {
    const e = next.get(id)
    if (!e) return undefined
    const n = bump(lib, e, updates)
    next.set(id, n)
    return n
  }
  const boundText = (e: El): El | undefined => {
    const be = (e.boundElements ?? []).find((b) => b.type === 'text')
    return be ? live(be.id) : undefined
  }
  const moved = new Set<string>()
  const missing: string[] = []
  const done: string[] = []

  for (const u of updates) {
    let el = live(u.id)
    if (!el) {
      missing.push(u.id)
      continue
    }
    // Text / label
    if (u.label !== undefined) {
      if (el.type === 'frame' || el.type === 'magicframe') {
        el = set(el.id, { name: u.label })!
      } else if (el.type === 'text' && !el.containerId) {
        const [fresh] = lib.convertToExcalidrawElements(
          [{ type: 'text', id: el.id, x: el.x, y: el.y, text: u.label, fontSize: el['fontSize'], fontFamily: el['fontFamily'], strokeColor: el.strokeColor }] as any,
          { regenerateIds: false }
        ) as unknown as El[]
        el = set(el.id, { text: fresh.text, originalText: fresh.originalText, width: fresh.width, height: fresh.height })!
      } else if (['rectangle', 'ellipse', 'diamond', 'arrow'].includes(el.type)) {
        const old = boundText(el)
        const skel: Record<string, unknown> =
          el.type === 'arrow'
            ? { type: 'arrow', id: el.id, x: el.x, y: el.y, points: el.points, label: { text: u.label, fontSize: old?.['fontSize'] ?? 16, strokeColor: TEXT_COLOR } }
            : {
                type: el.type,
                id: el.id,
                x: el.x,
                y: el.y,
                width: el.width,
                height: el.height,
                label: {
                  text: u.label,
                  fontSize: old?.['fontSize'] ?? 20,
                  strokeColor: old?.strokeColor ?? TEXT_COLOR,
                  textAlign: old?.['textAlign'],
                  verticalAlign: old?.['verticalAlign']
                }
              }
        const converted = lib.convertToExcalidrawElements([skel] as any, { regenerateIds: false }) as unknown as El[]
        const text = converted.find((c) => c.type === 'text')
        const container = converted.find((c) => c.id === el!.id)
        if (old) set(old.id, { isDeleted: true })
        if (text) {
          if (el.frameId) text.frameId = el.frameId
          added.push(text)
          el = set(el.id, {
            boundElements: [...(el.boundElements ?? []).filter((b) => b.type !== 'text'), { id: text.id, type: 'text' }],
            height: container && el.type !== 'arrow' ? Math.max(el.height, container.height) : el.height
          })!
        }
      } else {
        missing.push(`${u.id} (tipo ${el.type} não tem texto)`)
      }
    }
    // Position / size
    const dx = u.x !== undefined ? u.x - el.x : 0
    const dy = u.y !== undefined ? u.y - el.y : 0
    const resize = u.width !== undefined || u.height !== undefined
    if (dx || dy || resize) {
      el = set(el.id, {
        x: el.x + dx,
        y: el.y + dy,
        ...(u.width !== undefined ? { width: u.width } : {}),
        ...(u.height !== undefined ? { height: u.height } : {})
      })!
      moved.add(el.id)
      const t = boundText(el)
      if (t && el.type !== 'arrow') {
        set(t.id, { x: el.x + (el.width - t.width) / 2, y: el.y + (el.height - t.height) / 2 })
      } else if (t) {
        set(t.id, { x: t.x + dx, y: t.y + dy })
      }
      if ((el.type === 'frame' || el.type === 'magicframe') && (dx || dy)) {
        for (const child of [...next.values()]) {
          if (child.frameId === el.id && !child.isDeleted) {
            set(child.id, { x: child.x + dx, y: child.y + dy })
            moved.add(child.id)
          }
        }
      }
    }
    // Color
    if (u.color) {
      const c = PALETTE[u.color]
      if (el.type === 'text' || el.type === 'arrow' || el.type === 'line') set(el.id, { strokeColor: c.stroke })
      else {
        const isNote = el.strokeColor && el.strokeColor === el.backgroundColor
        set(el.id, { strokeColor: isNote ? c.fill : c.stroke, backgroundColor: c.fill, fillStyle: 'solid' })
      }
    }
    done.push(u.id)
  }

  // Arrows bound to moved/resized elements follow them.
  for (const a of [...next.values()]) {
    if (a.isDeleted || a.type !== 'arrow' || moved.has(a.id)) continue
    const s = a.startBinding?.elementId
    const e = a.endBinding?.elementId
    if (!(s && moved.has(s)) && !(e && moved.has(e))) continue
    const sEl = s ? live(s) : undefined
    const eEl = e ? live(e) : undefined
    if (sEl && eEl) {
      const g = arrowBetween(boxOf(sEl), boxOf(eEl))
      set(a.id, { x: g.x, y: g.y, points: g.points, width: Math.abs(g.points[1][0]), height: Math.abs(g.points[1][1]) })
      const t = boundText(next.get(a.id)!)
      if (t) set(t.id, { x: g.x + g.points[1][0] / 2 - t.width / 2, y: g.y + g.points[1][1] / 2 - t.height / 2 })
    }
  }

  if (done.length) {
    api.updateScene({ elements: [...next.values(), ...added] as any, captureUpdate: lib.CaptureUpdateAction.IMMEDIATELY })
    notifyChanged(ideaId)
  }
  const lines = [done.length ? `Atualizado(s): ${done.join(', ')}.` : 'Nada foi alterado.']
  if (missing.length) lines.push(`Não encontrado(s) no board: ${missing.join(', ')} (use board_read para ver os ids).`)
  return { ok: done.length > 0, text: lines.join('\n') }
}

// ---- delete -----------------------------------------------------------------------

async function deleteElements(ideaId: number, api: ExcalidrawImperativeAPI, ids: string[]): Promise<BoardOpResult> {
  const lib = await excalidraw()
  const all = api.getSceneElementsIncludingDeleted() as unknown as El[]
  const next = new Map<string, El>(all.map((e) => [e.id, e]))
  const set = (id: string, updates: Record<string, unknown>): void => {
    const e = next.get(id)
    if (e) next.set(id, bump(lib, e, updates))
  }
  const toDelete = new Set<string>()
  const missing: string[] = []
  for (const id of ids) {
    const e = next.get(id)
    if (!e || e.isDeleted) {
      missing.push(id)
      continue
    }
    toDelete.add(id)
    for (const b of e.boundElements ?? []) if (b.type === 'text') toDelete.add(b.id)
  }
  for (const id of toDelete) set(id, { isDeleted: true })
  for (const e of [...next.values()]) {
    if (e.isDeleted) continue
    const updates: Record<string, unknown> = {}
    if (e.frameId && toDelete.has(e.frameId)) updates['frameId'] = null
    if (e.startBinding && toDelete.has(e.startBinding.elementId)) updates['startBinding'] = null
    if (e.endBinding && toDelete.has(e.endBinding.elementId)) updates['endBinding'] = null
    if (e.boundElements?.some((b) => toDelete.has(b.id))) {
      updates['boundElements'] = e.boundElements.filter((b) => !toDelete.has(b.id))
    }
    if (Object.keys(updates).length) set(e.id, updates)
  }
  const deleted = ids.filter((id) => toDelete.has(id))
  if (deleted.length) {
    api.updateScene({ elements: [...next.values()] as any, captureUpdate: lib.CaptureUpdateAction.IMMEDIATELY })
    notifyChanged(ideaId)
  }
  const lines = [deleted.length ? `Apagado(s): ${deleted.join(', ')}.` : 'Nada foi apagado.']
  if (missing.length) lines.push(`Não encontrado(s): ${missing.join(', ')}.`)
  return { ok: deleted.length > 0, text: lines.join('\n') }
}
