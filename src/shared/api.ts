// Shape of `window.api` exposed by the preload. Derived from IpcContract so the
// renderer, preload and main can't drift apart.
import type { IpcChannel, IpcContract } from './ipc'
import type { DataChangedEvent } from './types'

type Invoke<C extends IpcChannel> = IpcContract[C] extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never

export type Unsubscribe = () => void

export interface VisualizeApi {
  ideas: {
    list: Invoke<'ideas:list'>
    create: Invoke<'ideas:create'>
    update: Invoke<'ideas:update'>
    archive: Invoke<'ideas:archive'>
    unarchive: Invoke<'ideas:unarchive'>
    remove: Invoke<'ideas:delete'>
    linkProject: Invoke<'ideas:linkProject'>
    unlinkProject: Invoke<'ideas:unlinkProject'>
    setPrimaryProject: Invoke<'ideas:setPrimaryProject'>
  }
  projects: {
    list: Invoke<'projects:list'>
    create: Invoke<'projects:create'>
    update: Invoke<'projects:update'>
    remove: Invoke<'projects:delete'>
    pickFolder: Invoke<'projects:pickFolder'>
  }
  settings: {
    get: Invoke<'settings:get'>
    setHotkey: Invoke<'settings:setHotkey'>
    setAutostart: Invoke<'settings:setAutostart'>
  }
  capture: {
    save: Invoke<'capture:save'>
    close: Invoke<'capture:close'>
    resize: Invoke<'capture:resize'>
    onShown: (cb: () => void) => Unsubscribe
  }
  boards: {
    get: Invoke<'boards:get'>
    save: Invoke<'boards:save'>
  }
  macro: {
    get: Invoke<'macro:get'>
    save: Invoke<'macro:save'>
  }
  app: {
    info: Invoke<'app:info'>
    openHub: Invoke<'app:openHub'>
    flushDone: Invoke<'app:flushDone'>
    /** Main wants pending autosaves flushed; reply with `flushDone(token)`. */
    onFlushRequest: (cb: (token: string) => void) => Unsubscribe
  }
  /** Fires whenever main changes data; the renderer refetches that entity. */
  onDataChanged: (cb: (e: DataChangedEvent) => void) => Unsubscribe
}
