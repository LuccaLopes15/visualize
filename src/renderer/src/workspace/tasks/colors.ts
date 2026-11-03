// Stable colour per project id (stories of different projects look different).
// Hues avoid the app accent (violet), which is reserved for dependency edges.

export const PROJECT_PALETTE = [
  '#38bdf8', // sky
  '#fb923c', // orange
  '#34d399', // emerald
  '#f472b6', // pink
  '#facc15', // yellow
  '#2dd4bf', // teal
  '#f87171', // coral
  '#a3e635' // lime
] as const

export interface ProjectColor {
  /** Solid colour (borders, chips, minimap). */
  color: string
  /** Translucent fill for the project lane. */
  soft: string
  /** Translucent border for the project lane. */
  line: string
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Same project id -> same colour, always (palette index = id mod size). */
export function projectColor(projectId: number): ProjectColor {
  const n = PROJECT_PALETTE.length
  const hex = PROJECT_PALETTE[((Math.trunc(projectId) % n) + n) % n]
  return { color: hex, soft: rgba(hex, 0.06), line: rgba(hex, 0.28) }
}
