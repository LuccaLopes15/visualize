import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcEvents, type IpcArgs, type IpcChannel, type IpcResult } from '@shared/ipc'
import type { VisualizeApi } from '@shared/api'
import type { DataChangedEvent, MacroUpdatedEvent } from '@shared/types'
import type { BoardRequest } from '@shared/board'
import type { ChatEvent } from '@shared/chat'

/** Invokes a typed channel and strips Electron's "Error invoking remote method" prefix. */
async function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcArgs<C>
): Promise<Awaited<IpcResult<C>>> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as Awaited<IpcResult<C>>
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const message = raw
      .replace(/^Error invoking remote method '[^']+':\s*/, '')
      .replace(/^\w*Error:\s*/, '')
    throw new Error(message)
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: VisualizeApi = {
  ideas: {
    list: () => invoke('ideas:list'),
    create: (...a) => invoke('ideas:create', ...a),
    update: (...a) => invoke('ideas:update', ...a),
    archive: (...a) => invoke('ideas:archive', ...a),
    unarchive: (...a) => invoke('ideas:unarchive', ...a),
    remove: (...a) => invoke('ideas:delete', ...a),
    linkProject: (...a) => invoke('ideas:linkProject', ...a),
    unlinkProject: (...a) => invoke('ideas:unlinkProject', ...a),
    setPrimaryProject: (...a) => invoke('ideas:setPrimaryProject', ...a)
  },
  projects: {
    list: () => invoke('projects:list'),
    create: (...a) => invoke('projects:create', ...a),
    update: (...a) => invoke('projects:update', ...a),
    remove: (...a) => invoke('projects:delete', ...a),
    pickFolder: (...a) => invoke('projects:pickFolder', ...a)
  },
  settings: {
    get: () => invoke('settings:get'),
    setHotkey: (...a) => invoke('settings:setHotkey', ...a),
    setAutostart: (...a) => invoke('settings:setAutostart', ...a)
  },
  capture: {
    save: (...a) => invoke('capture:save', ...a),
    close: () => invoke('capture:close'),
    resize: (...a) => invoke('capture:resize', ...a),
    onShown: (cb) => subscribe<void>(IpcEvents.captureShown, cb)
  },
  boards: {
    get: (...a) => invoke('boards:get', ...a),
    save: (...a) => invoke('boards:save', ...a)
  },
  macro: {
    get: (...a) => invoke('macro:get', ...a),
    save: (...a) => invoke('macro:save', ...a),
    onUpdated: (cb) => subscribe<MacroUpdatedEvent>(IpcEvents.macroUpdated, cb)
  },
  plan: {
    getGraph: (...a) => invoke('plan:getGraph', ...a),
    overview: (...a) => invoke('plan:overview', ...a),
    createNode: (...a) => invoke('plan:createNode', ...a),
    updateNode: (...a) => invoke('plan:updateNode', ...a),
    setParent: (...a) => invoke('plan:setParent', ...a),
    reorder: (...a) => invoke('plan:reorder', ...a),
    addDep: (...a) => invoke('plan:addDep', ...a),
    removeDep: (...a) => invoke('plan:removeDep', ...a),
    deleteNode: (...a) => invoke('plan:deleteNode', ...a),
    replaceAll: (...a) => invoke('plan:replaceAll', ...a),
    mergeAdd: (...a) => invoke('plan:mergeAdd', ...a)
  },
  chat: {
    open: (...a) => invoke('chat:open', ...a),
    send: (...a) => invoke('chat:send', ...a),
    stop: (...a) => invoke('chat:stop', ...a),
    reset: (...a) => invoke('chat:reset', ...a),
    close: (...a) => invoke('chat:close', ...a),
    boardReply: (...a) => invoke('chat:boardReply', ...a),
    onEvent: (cb) => subscribe<ChatEvent>(IpcEvents.chat, cb),
    onBoardRequest: (cb) => subscribe<BoardRequest>(IpcEvents.boardRequest, cb)
  },
  claude: {
    status: (...a) => invoke('claude:status', ...a),
    getSettings: () => invoke('claude:getSettings'),
    setPath: (...a) => invoke('claude:setPath', ...a),
    setModel: (...a) => invoke('claude:setModel', ...a),
    pickPath: () => invoke('claude:pickPath')
  },
  app: {
    info: () => invoke('app:info'),
    openHub: () => invoke('app:openHub'),
    flushDone: (...a) => invoke('app:flushDone', ...a),
    onFlushRequest: (cb) => subscribe<string>(IpcEvents.flushRequest, cb)
  },
  onDataChanged: (cb) => subscribe<DataChangedEvent>(IpcEvents.dataChanged, cb)
}

contextBridge.exposeInMainWorld('api', api)
