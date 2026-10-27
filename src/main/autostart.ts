import { app } from 'electron'

export const HIDDEN_ARG = '--hidden'

/**
 * Applies the "iniciar com o Windows" setting. Only touches the OS when the
 * app is packaged: dev runs (electron.exe from node_modules) must never be
 * registered as a login item.
 */
export function applyAutostart(enabled: boolean): boolean {
  if (!app.isPackaged) {
    console.log(`[autostart] dev mode: skipping setLoginItemSettings(openAtLogin=${enabled})`)
    return false
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] })
  return true
}

/** True when the process was launched by the login item (start in tray). */
export function launchedHidden(): boolean {
  return process.argv.includes(HIDDEN_ARG)
}
