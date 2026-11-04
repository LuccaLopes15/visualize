// When should the viewport be refitted? Pure decisions (unit-tested); the React layer only applies them.

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** A change of at least this many nodes in the plan (e.g. Claude generating the breakdown) refits. */
export const BIG_CHANGE = 3

export interface LayoutFitInput {
  /** First layout of this tab. */
  firstLayout: boolean
  /** Node positions would change (structure / order / direction / collapse). */
  layoutChanged: boolean
  /** The user pressed "Reorganizar" or switched direction since the last layout. */
  relayoutChanged: boolean
  /** Nodes in the plan (NOT only the visible ones: collapsing must not refit). */
  total: number
  prevTotal: number
}

/**
 * Refit after: the first load, "Reorganizar"/direction change, and big structural changes. Ordinary
 * edits (add a task, rename, move, collapse/expand) keep whatever viewport the user has.
 */
export function shouldFitAfterLayout(i: LayoutFitInput): boolean {
  if (i.total === 0) return false
  if (i.relayoutChanged) return true
  if (!i.layoutChanged) return false
  return i.firstLayout || i.prevTotal === 0 || Math.abs(i.total - i.prevTotal) >= BIG_CHANGE
}

/** True when `current` is (within rounding) the viewport the last automatic fit produced. */
export function viewportUntouched(lastFit: Viewport | null, current: Viewport, eps = 1.5): boolean {
  if (!lastFit) return false
  return (
    Math.abs(lastFit.x - current.x) <= eps &&
    Math.abs(lastFit.y - current.y) <= eps &&
    Math.abs(lastFit.zoom - current.zoom) <= 0.002
  )
}

/**
 * The canvas changed size (chat panel opened/closed, window resized): refit only if the user has not
 * panned/zoomed since the last automatic fit, so we never fight them.
 */
export function shouldFitAfterResize(lastFit: Viewport | null, current: Viewport, total: number): boolean {
  return total > 0 && viewportUntouched(lastFit, current)
}
