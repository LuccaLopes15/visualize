import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcEvents, type IpcArgs, type IpcChannel, type IpcResult } from '@shared/ipc'
import type { VisualizeApi } from '@shared/api'
import type { DataChangedEvent } from '@shared/types'

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
  app: {
    info: () => invoke('app:info'),
    openHub: () => invoke('app:openHub')
  },
  onDataChanged: (cb) => subscribe<DataChangedEvent>(IpcEvents.dataChanged, cb)
}

contextBridge.exposeInMainWorld('api', api)
