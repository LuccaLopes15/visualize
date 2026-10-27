import { ipcMain } from 'electron'
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'

type Handler<C extends IpcChannel> = (
  ...args: IpcArgs<C>
) => IpcResult<C> | Promise<IpcResult<C>>

/** Registers a typed `ipcMain.handle` for a channel declared in `IpcContract`. */
export function handle<C extends IpcChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (_event, ...args) => fn(...(args as IpcArgs<C>)))
}

/** Coerces an IPC argument to a positive integer id. */
export function toId(value: unknown, what = 'id'): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} inválido`)
  return n
}
