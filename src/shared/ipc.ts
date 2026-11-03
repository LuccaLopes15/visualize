// Typed IPC contract. Every request/response channel lives here, namespaced by
// domain (`ideas:*`, `projects:*`, `settings:*`, `capture:*`, `app:*`).
// Main registers handlers with `handle()` (src/main/ipc/handle.ts) and preload
// exposes them with `invoke()`, both typed from this single map.
// Later phases add their namespaces here (`devops:*`, ...).

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
  NewPlanNodeInput,
  NewProjectInput,
  PlanAddSpec,
  PlanDeleteResult,
  PlanDep,
  PlanGraph,
  PlanNode,
  PlanNodePatch,
  PlanOverview,
  PlanSpec,
  PlanWriteResult,
  Project,
  ProjectPatch,
  SaveResult
} from './types'
import type { BoardOpResult } from './board'
import type { ChatState, ClaudeSettings, ClaudeStatus } from './chat'

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

  // ---- Fase 3: chat com o Claude Code CLI ----
  /** History + whether a turn is running + CLI status (does not spawn anything). */
  'chat:open': (ideaId: number) => ChatState
  /** Sends a user message (spawns/resumes the CLI process on demand). */
  'chat:send': (ideaId: number, text: string) => void
  /** Interrupts the running turn. */
  'chat:stop': (ideaId: number) => void
  /** "Nova conversa": kills the process, forgets the CLI session and clears history. */
  'chat:reset': (ideaId: number) => void
  /** Leaving the workspace: ends the CLI process (history and session id are kept). */
  'chat:close': (ideaId: number) => void
  /** Renderer's answer to an `events:boardRequest`. */
  'chat:boardReply': (requestId: string, result: BoardOpResult) => void

  'claude:status': (refresh?: boolean) => ClaudeStatus
  'claude:getSettings': () => ClaudeSettings
  /** Saves the path override ('' = auto-detect) and returns the new status. */
  'claude:setPath': (path: string) => ClaudeStatus
  'claude:setModel': (model: string) => ClaudeSettings
  'claude:pickPath': () => string | null

  // ---- Fase 4: plano de tarefas (grafo). Mutations emit `events:dataChanged` { entity: 'plan', ideaId }.
  // Rule violations reject with a pt-BR message (see PlanErrorCode in shared/plan.ts).
  'plan:getGraph': (ideaId: number) => PlanGraph
  /** Graph + linked projects of the idea. */
  'plan:overview': (ideaId: number) => PlanOverview
  'plan:createNode': (ideaId: number, input: NewPlanNodeInput) => PlanNode
  'plan:updateNode': (ideaId: number, nodeId: string, patch: PlanNodePatch) => PlanNode
  /** parentId null is only valid for stories (reorder among stories). */
  'plan:setParent': (ideaId: number, nodeId: string, parentId: string | null, index?: number) => PlanNode
  'plan:reorder': (ideaId: number, parentId: string | null, orderedIds: string[]) => void
  'plan:addDep': (ideaId: number, fromId: string, toId: string) => PlanDep
  /** Resolves false when the dependency did not exist. */
  'plan:removeDep': (ideaId: number, fromId: string, toId: string) => boolean
  /** `force` confirms deleting nodes that already have a DevOps ticket. */
  'plan:deleteNode': (ideaId: number, nodeId: string, force?: boolean) => PlanDeleteResult
  'plan:replaceAll': (ideaId: number, spec: PlanSpec, force?: boolean) => PlanWriteResult
  'plan:mergeAdd': (ideaId: number, spec: PlanAddSpec, parentId?: string | null) => PlanWriteResult

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
  flushRequest: 'events:flushRequest',
  /** Chat streaming events (payload: ChatEvent). */
  chat: 'events:chat',
  /** Claude's board tool wants the renderer to apply an op (payload: BoardRequest). */
  boardRequest: 'events:boardRequest',
  /** Plano macro rewritten by Claude (payload: MacroUpdatedEvent). */
  macroUpdated: 'events:macroUpdated'
} as const
