import type Database from 'better-sqlite3'
import type { BoardData, BoardFile, BoardSaveInput, SaveResult } from '@shared/types'
import { invalid, notFound } from '../errors'

interface BoardRow {
  scene_json: string
  updated_at: number
}

interface FileRow {
  file_id: string
  mime: string
  data_url: string
  created_at: number
}

/** Generous cap per image (Excalidraw itself downsizes pasted images). */
export const MAX_FILE_DATA_URL = 25 * 1024 * 1024

function cleanFile(f: unknown): BoardFile {
  const file = f as Partial<BoardFile> | null
  if (!file || typeof file.id !== 'string' || !file.id || file.id.length > 200)
    throw invalid('Arquivo do board inválido.')
  if (typeof file.mimeType !== 'string' || !file.mimeType)
    throw invalid('Tipo do arquivo do board inválido.')
  if (typeof file.dataURL !== 'string' || !file.dataURL.startsWith('data:'))
    throw invalid('Conteúdo do arquivo do board inválido.')
  if (file.dataURL.length > MAX_FILE_DATA_URL) throw invalid('Imagem grande demais para o board.')
  const created = Number(file.created)
  return {
    id: file.id,
    mimeType: file.mimeType,
    dataURL: file.dataURL,
    created: Number.isFinite(created) ? created : 0
  }
}

/**
 * Excalidraw board per idea. The scene is opaque JSON for main; binary files
 * live in `board_files` and are written incrementally (only new ones), with
 * unreferenced files pruned on every save. Rows cascade when the idea is deleted.
 */
export class BoardsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now
  ) {}

  get(ideaId: number): BoardData | null {
    const row = this.db
      .prepare('SELECT scene_json, updated_at FROM boards WHERE idea_id = ?')
      .get(ideaId) as BoardRow | undefined
    if (!row) return null
    let scene: { elements?: unknown; appState?: unknown }
    try {
      scene = JSON.parse(row.scene_json) as typeof scene
    } catch {
      scene = {}
    }
    const files = (
      this.db
        .prepare(
          'SELECT file_id, mime, data_url, created_at FROM board_files WHERE idea_id = ? ORDER BY created_at, file_id'
        )
        .all(ideaId) as FileRow[]
    ).map((f) => ({ id: f.file_id, mimeType: f.mime, dataURL: f.data_url, created: f.created_at }))
    return {
      elements: Array.isArray(scene.elements) ? scene.elements : [],
      appState:
        scene.appState && typeof scene.appState === 'object' && !Array.isArray(scene.appState)
          ? (scene.appState as Record<string, unknown>)
          : {},
      files,
      updatedAt: row.updated_at
    }
  }

  save(ideaId: number, input: BoardSaveInput): SaveResult {
    this.assertIdea(ideaId)
    if (!input || !Array.isArray(input.elements)) throw invalid('Cena do board inválida.')
    const appState =
      input.appState && typeof input.appState === 'object' && !Array.isArray(input.appState)
        ? input.appState
        : {}
    const newFiles = (Array.isArray(input.newFiles) ? input.newFiles : []).map(cleanFile)
    const referenced = new Set(
      (Array.isArray(input.referencedFileIds) ? input.referencedFileIds : []).filter(
        (id): id is string => typeof id === 'string'
      )
    )
    const sceneJson = JSON.stringify({ elements: input.elements, appState })
    const ts = this.now()

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO boards (idea_id, scene_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(idea_id) DO UPDATE SET scene_json = excluded.scene_json, updated_at = excluded.updated_at`
        )
        .run(ideaId, sceneJson, ts)

      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO board_files (idea_id, file_id, mime, data_url, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      for (const f of newFiles) insert.run(ideaId, f.id, f.mimeType, f.dataURL, f.created || ts)

      const stored = this.db
        .prepare('SELECT file_id FROM board_files WHERE idea_id = ?')
        .all(ideaId) as { file_id: string }[]
      const del = this.db.prepare('DELETE FROM board_files WHERE idea_id = ? AND file_id = ?')
      for (const { file_id } of stored) if (!referenced.has(file_id)) del.run(ideaId, file_id)
    })()

    return { updatedAt: ts }
  }

  private assertIdea(ideaId: number): void {
    if (!this.db.prepare('SELECT 1 FROM ideas WHERE id = ?').get(ideaId)) throw notFound('Ideia', ideaId)
  }
}
