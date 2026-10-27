import { Menu, Tray, nativeImage } from 'electron'
import trayIconPath from '../../resources/tray.png?asset'

let tray: Tray | null = null

export interface TrayActions {
  openHub: () => void
  newIdea: () => void
  quit: () => void
  hotkeyLabel: () => string
}

export function createTray(actions: TrayActions): Tray {
  const image = nativeImage.createFromPath(trayIconPath)
  tray = new Tray(image)
  tray.setToolTip('Visualize')
  tray.on('click', actions.openHub)
  tray.on('double-click', actions.openHub)
  refreshTrayMenu(actions)
  return tray
}

export function refreshTrayMenu(actions: TrayActions): void {
  if (!tray) return
  const hotkey = actions.hotkeyLabel()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir Visualize', click: actions.openHub },
      { label: hotkey ? `Nova ideia\t${hotkey}` : 'Nova ideia', click: actions.newIdea },
      { type: 'separator' },
      { label: 'Sair', click: actions.quit }
    ])
  )
}

export function trayNotify(title: string, content: string): void {
  if (!tray) return
  tray.displayBalloon({ title, content, iconType: 'warning' })
}
