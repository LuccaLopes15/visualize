// `board_read`: turns the live scene into a compact text for the model.
import { clusterBoxes, elementBBox, unionBBox, type ElementLike } from './geometry'
import { colorName } from './palette'

const TYPE_LABEL: Record<string, string> = {
  rectangle: 'retângulo',
  ellipse: 'elipse',
  diamond: 'losango',
  text: 'texto',
  arrow: 'seta',
  line: 'linha',
  frame: 'frame',
  magicframe: 'frame',
  image: 'imagem',
  embeddable: 'embed',
  iframe: 'iframe'
}

const r = (n: number): number => Math.round(n)

function quote(s: string, max = 120): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return `"${one.length > max ? one.slice(0, max - 1) + '…' : one}"`
}

function geom(e: ElementLike): string {
  return `x=${r(e.x)} y=${r(e.y)} w=${r(e.width)} h=${r(e.height)}`
}

/** Element order in the listing: frames, shapes, texts, arrows, the rest. */
function rank(type: string): number {
  if (type === 'frame' || type === 'magicframe') return 0
  if (type === 'rectangle' || type === 'ellipse' || type === 'diamond') return 1
  if (type === 'text') return 2
  if (type === 'arrow' || type === 'line') return 3
  return 4
}

export function formatBoardSummary(all: readonly ElementLike[], maxElements = 200): string {
  const live = all.filter((e) => !e.isDeleted)
  if (live.length === 0) return 'O board está vazio.'

  const byId = new Map(live.map((e) => [e.id, e]))
  const labels = new Map<string, string>() // container id -> bound text
  for (const e of live) {
    if (e.type === 'text' && e.containerId) labels.set(e.containerId, e.originalText ?? e.text ?? '')
  }
  const frameCounts = new Map<string, number>()
  for (const e of live) if (e.frameId) frameCounts.set(e.frameId, (frameCounts.get(e.frameId) ?? 0) + 1)

  const nameOf = (id: string): string => {
    const t = byId.get(id)
    if (!t) return `[${id}]`
    const text = labels.get(id) ?? (t.type === 'text' ? t.text : t.name) ?? ''
    return text ? `[${id}] ${quote(text, 40)}` : `[${id}]`
  }

  const lines: string[] = []
  const freedraw: ElementLike[] = []
  const listed = live
    .filter((e) => !(e.type === 'text' && e.containerId && byId.has(e.containerId)))
    .sort((a, b) => rank(a.type) - rank(b.type))

  for (const e of listed) {
    if (e.type === 'freedraw') {
      freedraw.push(e)
      continue
    }
    const inFrame = e.frameId && byId.has(e.frameId) ? ` (no frame [${e.frameId}])` : ''
    const color = colorName(e.backgroundColor, e.strokeColor)
    const colorPart = color ? ` cor=${color}` : ''
    switch (e.type) {
      case 'rectangle':
      case 'ellipse':
      case 'diamond': {
        const label = labels.get(e.id)
        lines.push(`- [${e.id}] ${TYPE_LABEL[e.type]}${label ? ' ' + quote(label) : ''} ${geom(e)}${colorPart}${inFrame}`)
        break
      }
      case 'text':
        lines.push(`- [${e.id}] texto ${quote(e.originalText ?? e.text ?? '')} ${geom(e)}${inFrame}`)
        break
      case 'arrow':
      case 'line': {
        const label = labels.get(e.id)
        const bb = elementBBox(e)
        const pts = e.points ?? []
        const first = pts[0] ?? [0, 0]
        const last = pts[pts.length - 1] ?? [0, 0]
        const from = e.startBinding?.elementId
          ? nameOf(e.startBinding.elementId)
          : `(${r(e.x + first[0])},${r(e.y + first[1])})`
        const to = e.endBinding?.elementId ? nameOf(e.endBinding.elementId) : `(${r(e.x + last[0])},${r(e.y + last[1])})`
        const dashed = e.strokeStyle === 'dashed' ? ' tracejada' : ''
        lines.push(
          `- [${e.id}] ${TYPE_LABEL[e.type]}${dashed}${label ? ' ' + quote(label) : ''} de ${from} → ${to}` +
            ` (região x=${r(bb.minX)} y=${r(bb.minY)} w=${r(bb.maxX - bb.minX)} h=${r(bb.maxY - bb.minY)})${inFrame}`
        )
        break
      }
      case 'frame':
      case 'magicframe':
        lines.push(`- [${e.id}] frame${e.name ? ' ' + quote(e.name) : ''} ${geom(e)} (${frameCounts.get(e.id) ?? 0} elementos dentro)`)
        break
      case 'image':
        lines.push(`- [${e.id}] imagem ${geom(e)}${inFrame}`)
        break
      default:
        lines.push(`- [${e.id}] ${TYPE_LABEL[e.type] ?? e.type} ${geom(e)}${inFrame}`)
    }
  }

  for (const c of clusterBoxes(freedraw.map(elementBBox))) {
    const b = c.box
    lines.push(
      `- traço livre na região x=${r(b.minX)} y=${r(b.minY)} w=${r(b.maxX - b.minX)} h=${r(b.maxY - b.minY)}` +
        (c.count > 1 ? ` (${c.count} traços)` : '')
    )
  }

  const bb = unionBBox(live)!
  const shown = lines.slice(0, maxElements)
  const header =
    `Board com ${listed.length} elemento(s). Área ocupada: x de ${r(bb.minX)} a ${r(bb.maxX)}, ` +
    `y de ${r(bb.minY)} a ${r(bb.maxY)}. Ids entre colchetes; coordenadas em px (y cresce para baixo).`
  const more = lines.length > shown.length ? [`… e mais ${lines.length - shown.length} item(ns) (aumente maxElements para ver).`] : []
  return [header, ...shown, ...more].join('\n')
}
