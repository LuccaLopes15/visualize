import { app, BrowserWindow, dialog } from 'electron'
import type {
  BoardSaveInput,
  IdeaPatch,
  NewIdeaInput,
  NewProjectInput,
  ProjectPatch
} from '@shared/types'
import type { Repositories } from '../db'
import { notifyChanged } from '../events'
import { handle, toId } from './handle'
import { hideCaptureWindow, resizeCaptureWindow } from '../windows/captureWindow'
import { showMainWindow } from '../windows/mainWindow'
import { resolveFlush } from '../flush'
import type { PlanService } from '../plan/service'
import type { ChatManager } from '../claude/manager'
import { publicStatus } from '../claude/manager'
import { ChatError } from '../claude/session'
import { resolveBoardReply } from '../mcp/boardBridge'

export interface IpcDeps {
  repos: Repositories
  dbPath: string
  setHotkey: (accelerator: string) => { hotkey: string; registered: boolean }
  hotkeyStatus: () => { hotkey: string; registered: boolean }
  setAutostart: (enabled: boolean) => void
  chat: ChatManager
  /** Fase 4: plan graph service (emits `dataChanged` { entity: 'plan', ideaId } on mutations). */
  plan: PlanService
}

/** Registers all IPC handlers. One block per namespace. */
export function registerIpc(deps: IpcDeps): void {
  const { repos } = deps

  // ---- ideas:* ----------------------------------------------------------
  handle('ideas:list', () => repos.ideas.list())
  handle('ideas:create', (input: NewIdeaInput) => {
    const idea = repos.ideas.create(input)
    notifyChanged('ideas')
    return idea
  })
  handle('ideas:update', (id, patch: IdeaPatch) => {
    const idea = repos.ideas.update(toId(id), pickIdeaPatch(patch))
    notifyChanged('ideas', 'projects')
    return idea
  })
  handle('ideas:archive', (id) => {
    const idea = repos.ideas.archive(toId(id))
    notifyChanged('ideas', 'projects')
    return idea
  })
  handle('ideas:unarchive', (id) => {
    const idea = repos.ideas.unarchive(toId(id))
    notifyChanged('ideas', 'projects')
    return idea
  })
  handle('ideas:delete', (id) => {
    deps.chat.close(toId(id))
    repos.ideas.delete(toId(id))
    notifyChanged('ideas', 'projects')
  })
  handle('ideas:linkProject', (ideaId, projectId, makePrimary) => {
    const idea = repos.ideas.linkProject(toId(ideaId), toId(projectId), makePrimary === true)
    notifyChanged('ideas', 'projects')
    return idea
  })
  handle('ideas:unlinkProject', (ideaId, projectId) => {
    const idea = repos.ideas.unlinkProject(toId(ideaId), toId(projectId))
    notifyChanged('ideas', 'projects')
    return idea
  })
  handle('ideas:setPrimaryProject', (ideaId, projectId) => {
    const idea = repos.ideas.setPrimaryProject(toId(ideaId), toId(projectId))
    notifyChanged('ideas')
    return idea
  })

  // ---- projects:* -------------------------------------------------------
  handle('projects:list', () => repos.projects.list())
  handle('projects:create', (input: NewProjectInput) => {
    const project = repos.projects.create(input)
    notifyChanged('projects')
    return project
  })
  handle('projects:update', (id, patch: ProjectPatch) => {
    const project = repos.projects.update(toId(id), {
      name: patch?.name,
      folderPath: patch?.folderPath
    })
    notifyChanged('projects')
    return project
  })
  handle('projects:delete', (id) => {
    repos.projects.delete(toId(id))
    notifyChanged('projects', 'ideas')
  })
  handle('projects:pickFolder', async (defaultPath) => {
    const parent = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Escolher pasta do projeto',
      properties: ['openDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // ---- settings:* -------------------------------------------------------
  handle('settings:get', () => repos.settings.getAll())
  handle('settings:setHotkey', (accelerator) => {
    if (typeof accelerator !== 'string' || !accelerator.trim()) throw new Error('Atalho inválido.')
    const status = deps.setHotkey(accelerator.trim())
    notifyChanged('settings')
    return status
  })
  handle('settings:setAutostart', (enabled) => {
    repos.settings.set('autostart', enabled === true)
    deps.setAutostart(enabled === true)
    notifyChanged('settings')
    return repos.settings.getAll()
  })

  // ---- capture:* --------------------------------------------------------
  handle('capture:save', (input: NewIdeaInput) => {
    const idea = repos.ideas.create(input)
    hideCaptureWindow()
    notifyChanged('ideas')
    return idea
  })
  handle('capture:close', () => hideCaptureWindow())
  handle('capture:resize', (height) => resizeCaptureWindow(Number(height)))

  // ---- boards:* / macro:* (workspace) -----------------------------------
  // Autosaves: no `dataChanged` broadcast (the only editor is the window
  // that saved). Fase 3 will push Claude's board edits on its own channel.
  handle('boards:get', (ideaId) => repos.boards.get(toId(ideaId, 'ideia')))
  handle('boards:save', (ideaId, input: BoardSaveInput) =>
    repos.boards.save(toId(ideaId, 'ideia'), input)
  )
  handle('macro:get', (ideaId) => repos.macroPlans.get(toId(ideaId, 'ideia')))
  handle('macro:save', (ideaId, markdown) => repos.macroPlans.save(toId(ideaId, 'ideia'), markdown))

  // ---- plan:* (Fase 4) ---------------------------------------------------
  const { plan } = deps
  handle('plan:getGraph', (ideaId) => plan.getGraph(toId(ideaId, 'ideia')))
  handle('plan:overview', (ideaId) => plan.overview(toId(ideaId, 'ideia')))
  handle('plan:createNode', (ideaId, input) => plan.createNode(toId(ideaId, 'ideia'), input))
  handle('plan:updateNode', (ideaId, nodeId, patch) =>
    plan.updateNode(toId(ideaId, 'ideia'), nodeId, patch)
  )
  handle('plan:setParent', (ideaId, nodeId, parentId, index) =>
    plan.setParent(toId(ideaId, 'ideia'), nodeId, parentId ?? null, index ?? undefined)
  )
  handle('plan:reorder', (ideaId, parentId, orderedIds) =>
    plan.reorder(toId(ideaId, 'ideia'), parentId ?? null, orderedIds)
  )
  handle('plan:addDep', (ideaId, fromId, toNodeId) => plan.addDep(toId(ideaId, 'ideia'), fromId, toNodeId))
  handle('plan:removeDep', (ideaId, fromId, toNodeId) =>
    plan.removeDep(toId(ideaId, 'ideia'), fromId, toNodeId)
  )
  handle('plan:deleteNode', (ideaId, nodeId, force) =>
    plan.deleteNode(toId(ideaId, 'ideia'), nodeId, force === true)
  )
  handle('plan:replaceAll', (ideaId, spec, force) =>
    plan.replaceAll(toId(ideaId, 'ideia'), spec, { force: force === true })
  )
  handle('plan:mergeAdd', (ideaId, spec, parentId) =>
    plan.mergeAdd(toId(ideaId, 'ideia'), spec, parentId ?? null)
  )

  // ---- chat:* / claude:* (Fase 3) ----------------------------------------
  const { chat } = deps
  handle('chat:open', (ideaId) => chat.open(toId(ideaId, 'ideia')))
  handle('chat:send', async (ideaId, text) => {
    try {
      await chat.send(toId(ideaId, 'ideia'), String(text ?? ''))
    } catch (err) {
      // ChatError details already reached the panel as an `error` event.
      if (err instanceof ChatError) throw new Error(err.detail.message)
      throw err
    }
  })
  handle('chat:stop', (ideaId) => chat.stop(toId(ideaId, 'ideia')))
  handle('chat:reset', (ideaId) => chat.reset(toId(ideaId, 'ideia')))
  handle('chat:close', (ideaId) => chat.close(toId(ideaId, 'ideia')))
  handle('chat:boardReply', (requestId, result) => resolveBoardReply(requestId, result))

  handle('claude:status', async (refresh) => publicStatus(await chat.detector.status(refresh === true)))
  handle('claude:getSettings', () => chat.settings())
  handle('claude:setPath', (path) => chat.setPath(typeof path === 'string' ? path : ''))
  handle('claude:setModel', (model) => chat.setModel(typeof model === 'string' ? model : ''))
  handle('claude:pickPath', async () => {
    const parent = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Escolher o executável do Claude Code',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [
              { name: 'Claude Code', extensions: ['exe', 'cmd', 'js'] },
              { name: 'Todos os arquivos', extensions: ['*'] }
            ]
          : []
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // ---- app:* ------------------------------------------------------------
  handle('app:info', () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    dbPath: deps.dbPath,
    hotkey: deps.hotkeyStatus()
  }))
  handle('app:openHub', () => {
    hideCaptureWindow()
    showMainWindow()
  })
  handle('app:flushDone', (token) => resolveFlush(token))
}

function pickIdeaPatch(patch: IdeaPatch): IdeaPatch {
  const out: IdeaPatch = {}
  if (patch?.title !== undefined) out.title = patch.title
  if (patch?.body !== undefined) out.body = patch.body
  if (patch?.status !== undefined) out.status = patch.status
  return out
}
