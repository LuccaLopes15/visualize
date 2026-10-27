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
