// Domain types shared by main, preload and renderer.

export const IDEA_STATUSES = ['solta', 'em_trabalho', 'planejada', 'ticketada', 'arquivada'] as const
export type IdeaStatus = (typeof IDEA_STATUSES)[number]

export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = {
  solta: 'Solta',
  em_trabalho: 'Em trabalho',
  planejada: 'Planejada',
  ticketada: 'Ticketada',
  arquivada: 'Arquivada'
}

export interface Project {
  id: number
  name: string
  folderPath: string
  createdAt: number
  /** Number of non-archived ideas linked to this project. */
  ideaCount: number
}

export interface IdeaProjectLink {
  projectId: number
  isPrimary: boolean
}

export interface Idea {
  id: number
  title: string
  body: string
  status: IdeaStatus
  createdAt: number
  updatedAt: number
  /** Linked projects; the primary one comes first. Empty = idea "solta". */
  projects: IdeaProjectLink[]
}

export interface NewIdeaInput {
  title: string
  body?: string
}

export interface IdeaPatch {
  title?: string
  body?: string
  status?: IdeaStatus
}

export interface NewProjectInput {
  name: string
  folderPath: string
}

export interface ProjectPatch {
  name?: string
  folderPath?: string
}

export interface AppSettings {
  /** Electron accelerator, e.g. "Control+Alt+Space". */
  hotkey: string
  autostart: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: 'Control+Alt+Space',
  autostart: true
}

export interface HotkeyStatus {
  hotkey: string
  registered: boolean
}

export interface AppInfo {
  version: string
  isPackaged: boolean
  dbPath: string
  hotkey: HotkeyStatus
}

export type DataEntity = 'ideas' | 'projects' | 'settings'

export interface DataChangedEvent {
  entity: DataEntity
}

// ---- Fase 2: workspace (board + plano macro) ------------------------------

/**
 * A binary file referenced by an Excalidraw image element (pasted/dropped
 * image). Mirrors Excalidraw's `BinaryFileData`; `id` is Excalidraw's fileId.
 */
export interface BoardFile {
  id: string
  mimeType: string
  /** `data:<mime>;base64,...` */
  dataURL: string
  created: number
}

/**
 * Persisted Excalidraw scene. Main treats `elements` / `appState` as opaque
 * JSON (only the renderer understands their shape); `appState` holds just the
 * durable bits (viewport, grid, current tool styles), never selection/collaborators.
 */
export interface BoardScene {
  elements: unknown[]
  appState: Record<string, unknown>
}

export interface BoardData extends BoardScene {
  files: BoardFile[]
  updatedAt: number
}

export interface BoardSaveInput extends BoardScene {
  /** Files not yet persisted (new since the last save). */
  newFiles: BoardFile[]
  /**
   * Every fileId still referenced by an image element. Stored files outside
   * this list are pruned, so deleted images don't pile up in the database.
   */
  referencedFileIds: string[]
}

export interface MacroPlan {
  markdown: string
  /** 0 when the idea has no plan yet. */
  updatedAt: number
}

export interface SaveResult {
  updatedAt: number
}
