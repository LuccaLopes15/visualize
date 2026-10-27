import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IpcEvents } from '@shared/ipc'

/**
 * Asks a renderer to write its pending autosaves (workspace board / plano
 * macro) and waits for the `app:flushDone` ack, or the timeout, whichever
 * comes first. Used before quitting so a debounced save is never lost.
 */
const pending = new Map<string, () => void>()

export function requestRendererFlush(win: BrowserWindow | null, timeoutMs = 3000): Promise<void> {
  if (!win || win.isDestroyed() || win.webContents.isCrashed()) return Promise.resolve()
  return new Promise((resolve) => {
    const token = randomUUID()
    const done = (): void => {
      clearTimeout(timer)
      pending.delete(token)
      resolve()
    }
    const timer = setTimeout(() => {
      console.warn('[flush] renderer did not confirm in time; quitting anyway')
      done()
    }, timeoutMs)
    pending.set(token, done)
    win.webContents.send(IpcEvents.flushRequest, token)
  })
}

/** Fire-and-forget variant (window hidden): no need to wait. */
export function notifyRendererFlush(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(IpcEvents.flushRequest, '')
}

export function resolveFlush(token: unknown): void {
  if (typeof token === 'string') pending.get(token)?.()
}
