// Board palette for Claude-made elements. Values are Excalidraw's own light
// palette: in dark theme Excalidraw inverts the canvas, so these render as
// muted dark fills with light text/strokes (readable on the app's dark UI).
import type { BoardColor } from '@shared/board'

export const TEXT_COLOR = '#1e1e1e'

export const PALETTE: Record<BoardColor, { stroke: string; fill: string }> = {
  gray: { stroke: '#495057', fill: '#e9ecef' },
  blue: { stroke: '#1971c2', fill: '#a5d8ff' },
  green: { stroke: '#2f9e44', fill: '#b2f2bb' },
  yellow: { stroke: '#f08c00', fill: '#ffec99' },
  orange: { stroke: '#e8590c', fill: '#ffd8a8' },
  red: { stroke: '#e03131', fill: '#ffc9c9' },
  purple: { stroke: '#6741d9', fill: '#d0bfff' },
  pink: { stroke: '#c2255c', fill: '#eebefa' },
  teal: { stroke: '#0c8599', fill: '#99e9f2' }
}

/** Palette name for an element's colors (fill first), or null. */
export function colorName(fill?: string | null, stroke?: string | null): BoardColor | null {
  const f = (fill ?? '').toLowerCase()
  const s = (stroke ?? '').toLowerCase()
  for (const [name, c] of Object.entries(PALETTE) as [BoardColor, { stroke: string; fill: string }][]) {
    if (f && f === c.fill) return name
  }
  for (const [name, c] of Object.entries(PALETTE) as [BoardColor, { stroke: string; fill: string }][]) {
    if (s && s === c.stroke) return name
  }
  return null
}
