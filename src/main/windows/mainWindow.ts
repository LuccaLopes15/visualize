import { BrowserWindow } from 'electron'
import appIcon from '../../../resources/icon.png?asset'
import { hardenWebContents, loadPage, securePreferences } from './common'
import { appState } from '../state'

let mainWindow: BrowserWindow | null = null

export function createMainWindow(showOnReady: boolean): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Visualize',
    icon: appIcon,
    backgroundColor: '#0e1014',
    autoHideMenuBar: true,
    // Dark custom title bar; Windows still draws the min/max/close buttons.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0f13', symbolColor: '#8b93a5', height: 40 },
    webPreferences: securePreferences
  })
  mainWindow.setMenu(null)
  hardenWebContents(mainWindow)

  if (showOnReady) mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Closing the hub only hides it to the tray; "Sair" in the tray really quits.
  mainWindow.on('close', (event) => {
    if (!appState.isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  void loadPage(mainWindow, 'index')
  return mainWindow
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(true)
  const win = mainWindow!
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
