import { BrowserWindow } from 'electron'
import { IpcEvents } from '@shared/ipc'
import type { DataEntity } from '@shared/types'

/** Notifies every open window that some data changed so it can refetch. */
export function notifyChanged(...entities: DataEntity[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    for (const entity of entities) win.webContents.send(IpcEvents.dataChanged, { entity })
  }
}

/**
 * The plan graph (stories/tasks/deps) of an idea changed: the open Tarefas tab
 * (and any other window) refetches it. Payload: `{ entity: 'plan', ideaId }`.
 */
export function notifyPlanChanged(ideaId: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(IpcEvents.dataChanged, { entity: 'plan', ideaId })
  }
}
