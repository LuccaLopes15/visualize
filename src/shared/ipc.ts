// Typed IPC contract. Every request/response channel lives here, namespaced by
// domain (`ideas:*`, `projects:*`, `settings:*`, `capture:*`, `app:*`).
// Main registers handlers with `handle()` (src/main/ipc/handle.ts) and preload
// exposes them with `invoke()`, both typed from this single map.
// Later phases add their namespaces here (`boards:*`, `plan:*`, `chat:*`, ...).

import type {
  AppInfo,
  AppSettings,
  BoardData,
  BoardSaveInput,
  HotkeyStatus,
  Idea,
  IdeaPatch,
  MacroPlan,
  NewIdeaInput,
  NewProjectInput,
  Project,
  ProjectPatch,
  SaveResult
} from './types'

export interface IpcContract {
  'ideas:list': () => Idea[]
  'ideas:create': (input: NewIdeaInput) => Idea
  'ideas:update': (id: number, patch: IdeaPatch) => Idea
  'ideas:archive': (id: number) => Idea
  'ideas:unarchive': (id: number) => Idea
  'ideas:delete': (id: number) => void
  'ideas:linkProject': (ideaId: number, projectId: number, makePrimary?: boolean) => Idea
  'ideas:unlinkProject': (ideaId: number, projectId: number) => Idea
  'ideas:setPrimaryProject': (ideaId: number, projectId: number) => Idea

  'projects:list': () => Project[]
  'projects:create': (input: NewProjectInput) => Project
  'projects:update': (id: number, patch: ProjectPatch) => Project
  'projects:delete': (id: number) => void
  'projects:pickFolder': (defaultPath?: string) => string | null

  'settings:get': () => AppSettings
  'settings:setHotkey': (accelerator: string) => HotkeyStatus
  'settings:setAutostart': (enabled: boolean) => AppSettings

  'capture:save': (input: NewIdeaInput) => Idea
  'capture:close': () => void
  'capture:resize': (height: number) => void

  /** Board of an idea, or null if nothing was drawn yet. */
  'boards:get': (ideaId: number) => BoardData | null
  'boards:save': (ideaId: number, input: BoardSaveInput) => SaveResult

  'macro:get': (ideaId: number) => MacroPlan
  'macro:save': (ideaId: number, markdown: string) => SaveResult

  'app:info': () => AppInfo
  'app:openHub': () => void
  /** Renderer acknowledges an `events:flushRequest` (pending autosaves written). */
  'app:flushDone': (token: string) => void
}

export type IpcChannel = keyof IpcContract
export type IpcArgs<C extends IpcChannel> = Parameters<IpcContract[C]>
export type IpcResult<C extends IpcChannel> = ReturnType<IpcContract[C]>

/** Events pushed from main to renderer windows. */
export const IpcEvents = {
  dataChanged: 'events:dataChanged',
  captureShown: 'events:captureShown',
  /**
   * Main asks the hub to write pending autosaves now (window hidden, app
   * quitting). Payload: a token the renderer echoes back via `app:flushDone`.
   */
  flushRequest: 'events:flushRequest'
} as const
