// Pure helpers to turn Excalidraw's live state into what we persist.
// Kept free of Excalidraw imports so they are unit-testable in Node.
import type { BoardFile, BoardSaveInput } from '@shared/types'

/** Minimal element shape we rely on (Excalidraw elements have many more fields). */
export interface SceneElementLike {
  id: string
  type: string
  version: number
  isDeleted?: boolean
  fileId?: string | null
}

export type FilesLike = Record<string, BoardFile & { lastRetrieved?: number }>

/**
 * appState keys worth persisting: viewport and user preferences. Everything
 * else (selection, open menus, collaborators, editing state…) is transient.
 */
export const PERSISTED_APPSTATE_KEYS = [
  'scrollX',
  'scrollY',
  'zoom',
  'viewBackgroundColor',
  'gridSize',
  'gridStep',
  'gridModeEnabled',
  'objectsSnapModeEnabled',
  'currentItemStrokeColor',
  'currentItemBackgroundColor',
  'currentItemFillStyle',
  'currentItemStrokeWidth',
  'currentItemStrokeStyle',
  'currentItemRoughness',
  'currentItemOpacity',
  'currentItemFontFamily',
  'currentItemFontSize',
  'currentItemTextAlign',
  'currentItemStartArrowhead',
  'currentItemEndArrowhead',
  'currentItemArrowType',
  'currentItemRoundness'
] as const

export function pickPersistedAppState(appState: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of PERSISTED_APPSTATE_KEYS) {
    if (appState[key] !== undefined) out[key] = appState[key]
  }
  return out
}

export function liveElements<E extends SceneElementLike>(elements: readonly E[]): E[] {
  return elements.filter((e) => !e.isDeleted)
}

export function referencedFileIds(elements: readonly SceneElementLike[]): string[] {
  const ids = new Set<string>()
  for (const e of elements) if (!e.isDeleted && e.type === 'image' && e.fileId) ids.add(e.fileId)
  return [...ids]
}

/**
 * Cheap change detector for Excalidraw's very chatty onChange (fires on every
 * pointer move / selection). Element versions only grow, so their sum changes
 * whenever any element (incl. deletions) changes.
 */
export function sceneSignature(
  elements: readonly SceneElementLike[],
  appState: Record<string, unknown>,
  files: Record<string, unknown>
): string {
  let versions = 0
  for (const e of elements) versions += e.version
  const zoom = (appState['zoom'] as { value?: number } | undefined)?.value ?? 1
  return [
    elements.length,
    versions,
    appState['scrollX'] ?? 0,
    appState['scrollY'] ?? 0,
    zoom,
    appState['viewBackgroundColor'] ?? '',
    appState['gridModeEnabled'] ? 1 : 0,
    Object.keys(files).length
  ].join('|')
}

/**
 * Builds the save payload. Only files referenced by live image elements and
 * not yet persisted are sent; returns the new "persisted" set to remember.
 */
export function buildBoardSave(
  elements: readonly SceneElementLike[],
  appState: Record<string, unknown>,
  files: FilesLike,
  persisted: ReadonlySet<string>
): { input: BoardSaveInput; persistedAfter: Set<string> } {
  const referenced = referencedFileIds(elements)
  const newFiles: BoardFile[] = []
  const persistedAfter = new Set<string>()
  for (const id of referenced) {
    if (persisted.has(id)) {
      persistedAfter.add(id)
      continue
    }
    const f = files[id]
    if (!f) continue // image still loading; a later onChange will carry it
    newFiles.push({ id: f.id, mimeType: f.mimeType, dataURL: f.dataURL, created: f.created })
    persistedAfter.add(id)
  }
  return {
    input: {
      elements: liveElements(elements),
      appState: pickPersistedAppState(appState),
      newFiles,
      // Only ids we actually have stored (or are sending) are kept by main.
      referencedFileIds: [...persistedAfter]
    },
    persistedAfter
  }
}
