import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { createRepositories, type Repositories } from './db'
import { registerIpc } from './ipc'
import { HotkeyManager, formatAccelerator } from './hotkey'
import { applyAutostart, launchedHidden } from './autostart'
import { createTray, refreshTrayMenu, trayNotify, type TrayActions } from './tray'
import { createMainWindow, showMainWindow } from './windows/mainWindow'
import { createCaptureWindow, showCaptureWindow } from './windows/captureWindow'
import { appState } from './state'
import { DEFAULT_SETTINGS } from '@shared/types'

// Dev runs use a separate profile so they never touch the real database
// (and the single-instance lock doesn't collide with an installed copy).
// VISUALIZE_USER_DATA overrides it (used for automated/manual test runs).
if (process.env['VISUALIZE_USER_DATA']) {
  app.setPath('userData', process.env['VISUALIZE_USER_DATA'])
} else if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'Visualize (dev)'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  app.setAppUserModelId(app.isPackaged ? 'com.visualize.app' : process.execPath)

  const dbPath = join(app.getPath('userData'), 'visualize.db')
  let repos: Repositories
  try {
    repos = createRepositories(dbPath)
  } catch (err) {
    console.error('[db] failed to open database', err)
    dialog.showErrorBox('Visualize', `Não foi possível abrir o banco de dados:\n${dbPath}\n\n${String(err)}`)
    app.exit(1)
    return
  }
  console.log(`[db] ${dbPath}`)

  const hotkeys = new HotkeyManager(() => showCaptureWindow())

  const trayActions: TrayActions = {
    openHub: () => showMainWindow(),
    newIdea: () => showCaptureWindow(),
    quit: () => {
      appState.isQuitting = true
      app.quit()
    },
    hotkeyLabel: () => {
      const s = hotkeys.status()
      return s.registered ? formatAccelerator(s.hotkey) : ''
    }
  }

  const registerHotkey = (accelerator: string): boolean => {
    const ok = hotkeys.register(accelerator)
    console.log(`[hotkey] ${accelerator} registered=${ok}`)
    if (!ok) {
      trayNotify(
        'Atalho não registrado',
        `Não foi possível registrar ${formatAccelerator(accelerator)} (talvez esteja em uso por outro app). Troque em Configurações.`
      )
    }
    return ok
  }

  registerIpc({
    repos,
    dbPath,
    hotkeyStatus: () => hotkeys.status(),
    setHotkey: (accelerator) => {
      if (!hotkeys.change(accelerator)) {
        throw new Error(
          `Não foi possível registrar ${formatAccelerator(accelerator)}. Ele pode ser inválido ou estar em uso por outro app.`
        )
      }
      repos.settings.set('hotkey', accelerator)
      refreshTrayMenu(trayActions)
      return hotkeys.status()
    },
    setAutostart: (enabled) => applyAutostart(enabled)
  })

  createTray(trayActions)

  const settings = repos.settings.getAll()
  registerHotkey(settings.hotkey || DEFAULT_SETTINGS.hotkey)
  refreshTrayMenu(trayActions)
  applyAutostart(settings.autostart)

  createMainWindow(!launchedHidden())
  createCaptureWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showMainWindow()
  })

  app.on('before-quit', () => {
    appState.isQuitting = true
  })

  app.on('will-quit', () => {
    hotkeys.unregister()
    repos.db.close()
  })
}

// The app lives in the tray: never quit just because windows are hidden/closed.
app.on('window-all-closed', () => {
  /* keep running in tray */
})
