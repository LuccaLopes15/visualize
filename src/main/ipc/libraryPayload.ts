// Excalidraw "biblioteca de formas" (LKA-21): one global list for every board,
// stored JSON-encoded in `settings` under BOARD_LIBRARY_KEY. Items are opaque to
// main (Excalidraw's LibraryItem); only the outer shape is checked so a malformed
// renderer message can never replace the saved library with garbage.

export const BOARD_LIBRARY_KEY = 'board_library'

/** Upper bound for the encoded library (shapes only, no image files). */
export const MAX_LIBRARY_BYTES = 20 * 1024 * 1024

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isItem = (v: unknown): boolean => isObj(v) && typeof v.id === 'string' && Array.isArray(v.elements)

/** Validates `boards:saveLibrary`: a list of library items ({ id, elements, ... }). */
export function libraryArg(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v) || !v.every(isItem)) throw new Error('Biblioteca de formas inválida.')
  if (JSON.stringify(v).length > MAX_LIBRARY_BYTES) throw new Error('A biblioteca de formas ficou grande demais para salvar.')
  return v as Record<string, unknown>[]
}

/** Saved library as read from settings: anything unexpected reads as "empty", item by item. */
export function storedLibrary(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? (raw.filter(isItem) as Record<string, unknown>[]) : []
}
