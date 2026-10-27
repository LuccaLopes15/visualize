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
