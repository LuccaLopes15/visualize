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

export type DataEntity = 'ideas' | 'projects' | 'settings' | 'plan'

export interface DataChangedEvent {
  entity: DataEntity
  /** Set for `plan` events: the idea whose task graph changed. */
  ideaId?: number
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

/** Pushed when Claude rewrites/appends to the plano macro of an idea. */
export interface MacroUpdatedEvent {
  ideaId: number
  markdown: string
  updatedAt: number
}

// ---- Fase 4: plano de tarefas (grafo de stories/tasks + dependências) -------

export const PLAN_NODE_KINDS = ['story', 'task'] as const
export type PlanNodeKind = (typeof PLAN_NODE_KINDS)[number]

export const PLAN_TITLE_MAX = 255
export const PLAN_DESCRIPTION_MAX = 50_000

/**
 * A node as stored (before derived fields). `projectId` is only set for
 * stories; tasks store NULL and inherit the project of their root story.
 */
export interface RawPlanNode {
  /** UUID. */
  id: string
  ideaId: number
  kind: PlanNodeKind
  title: string
  /** Markdown, may be empty. */
  description: string
  /** null for stories; a story or task of the same idea for tasks. */
  parentId: string | null
  projectId: number | null
  /** 0-based position among siblings (same parent, or all stories when parentId is null). */
  sort: number
  /** Fase 5: Azure DevOps work item id / url / last sync time (ms). All null until ticketed. */
  devopsId: number | null
  devopsUrl: string | null
  devopsSyncedAt: number | null
  createdAt: number
  /** Bumped only when title/description change (so it can flag "desatualizado" after a sync). */
  updatedAt: number
}

export interface PlanNode extends Omit<RawPlanNode, 'projectId'> {
  /** Effective project: the story's own, or the root story's for tasks. Always a number. */
  projectId: number
  /** The story at the top of this node's branch (itself for stories). */
  rootStoryId: string
  /** 0 for stories, 1 for their direct tasks, and so on. */
  depth: number
  /**
   * Ticketed node edited after the last sync (or never marked as synced):
   * `devopsId != null && (devopsSyncedAt == null || updatedAt > devopsSyncedAt)`.
   */
  devopsStale: boolean
}

/** "fromId depende de toId" (to must be done first). May cross stories and projects. */
export interface PlanDep {
  fromId: string
  toId: string
}

export interface PlanGraph {
  ideaId: number
  /** Hierarchy pre-order: stories by `sort`, each followed by its subtree (children by `sort`). */
  nodes: PlanNode[]
  deps: PlanDep[]
}

export interface PlanProjectInfo {
  id: number
  name: string
  folderPath: string
  isPrimary: boolean
}

/** Graph + the idea's linked projects (what Claude's `tasks_read` returns). */
export interface PlanOverview {
  graph: PlanGraph
  projects: PlanProjectInfo[]
}

export interface NewPlanNodeInput {
  kind: PlanNodeKind
  title: string
  description?: string
  /** Required for tasks (a story or task of the idea); must be null/omitted for stories. */
  parentId?: string | null
  /** Required for stories (a project linked to the idea); omit for tasks (derived). */
  projectId?: number | null
  /** Insert position among siblings (0-based); default = last. */
  index?: number
}

export interface PlanNodePatch {
  title?: string
  description?: string
  /** New 0-based position among siblings (others are renumbered). */
  sort?: number
  /** Stories only: move the story (and its tasks) to another linked project. */
  projectId?: number
}

/**
 * Nested spec node used by `replaceAll` / `mergeAdd`. Top-level nodes are
 * stories (need `projectId`); nested ones are tasks (any depth).
 */
export interface PlanSpecNode {
  /** Temporary id: lets `deps` (and the returned `idMap`) refer to this node. */
  tempId?: string
  /** replaceAll only: id of an EXISTING node to keep/update in place (keeps devops fields). */
  id?: string
  title: string
  description?: string
  /** Stories only. For tasks it is optional and, if given, must equal the story's. */
  projectId?: number
  children?: PlanSpecNode[]
}

/** "from depende de to"; each side is a spec `tempId` or the `id` of an existing node. */
export interface PlanSpecDep {
  from: string
  to: string
}

/** Whole-graph spec for `replaceAll`. */
export interface PlanSpec {
  stories: PlanSpecNode[]
  deps?: PlanSpecDep[]
}

/** Subtree spec for `mergeAdd`: nodes go under `parentId`, or are new stories when omitted. */
export interface PlanAddSpec {
  nodes: PlanSpecNode[]
  deps?: PlanSpecDep[]
}

export interface PlanWriteResult {
  /** tempId (or existing id, for kept nodes) -> real node id, for every spec node. */
  idMap: Record<string, string>
  created: number
  updated: number
  deleted: number
  deletedIds: string[]
}

export interface PlanDeleteResult {
  /** Removed node ids, pre-order (the requested node first). */
  deletedIds: string[]
  /** Removed nodes that already had a DevOps ticket (never deleted in DevOps). */
  ticketed: { id: string; title: string; devopsId: number }[]
}

/** Input for Fase 5 (`PlanService.setDevops`); not exposed over IPC. */
export interface PlanDevopsPatch {
  devopsId: number | null
  devopsUrl: string | null
  /** Sync time (ms); null clears it. */
  syncedAt: number | null
}
