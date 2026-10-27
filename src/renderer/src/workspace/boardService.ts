// Single access point to the live Excalidraw board of the open workspace.
//
// Fase 3 hook: Claude's board tools run in main and only build element
// skeletons; main sends them over IPC and the renderer applies them here
// (`addSkeletons`). The resulting `onChange` goes through the normal autosave,
// so programmatic edits are persisted exactly like manual ones.
//
// Only *types* are imported statically so this module can live in the main
// chunk; Excalidraw itself is loaded lazily with the Board tab.
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'

interface ActiveBoard {
  ideaId: number
  api: ExcalidrawImperativeAPI
}

let active: ActiveBoard | null = null
const listeners = new Set<(board: ActiveBoard | null) => void>()

function emit(): void {
  for (const l of listeners) l(active)
}

export const boardService = {
  /** Called by the Board component once Excalidraw hands over its API. */
  attach(ideaId: number, api: ExcalidrawImperativeAPI): void {
    active = { ideaId, api }
    emit()
  },

  detach(ideaId: number): void {
    if (active?.ideaId !== ideaId) return
    active = null
    emit()
  },

  /** Live API of the board for `ideaId` (or of whichever board is open). */
  get(ideaId?: number): ExcalidrawImperativeAPI | null {
    if (!active) return null
    if (ideaId !== undefined && active.ideaId !== ideaId) return null
    return active.api
  },

  /** Notified when a board is attached/detached. Returns an unsubscribe. */
  subscribe(cb: (board: ActiveBoard | null) => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },

  /**
   * Adds elements described as skeletons (text, rectangle, arrow bound to
   * other ids...). Ids in the skeletons are kept (`regenerateIds: false`) so
   * later updates/deletes and arrow bindings can address them. Undoable.
   * Returns false when that idea's board is not open.
   */
  async addSkeletons(ideaId: number, skeletons: ExcalidrawElementSkeleton[]): Promise<boolean> {
    const api = this.get(ideaId)
    if (!api) return false
    const { convertToExcalidrawElements, CaptureUpdateAction } = await import('@excalidraw/excalidraw')
    const created = convertToExcalidrawElements(skeletons, { regenerateIds: false })
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), ...created],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    })
    return true
  }
}
