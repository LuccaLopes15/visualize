import { BrowserWindow, screen } from 'electron'
import { IpcEvents } from '@shared/ipc'
import { hardenWebContents, loadPage, securePreferences } from './common'

export const CAPTURE_WIDTH = 680
const MIN_HEIGHT = 60
const MAX_HEIGHT = 420
const DEFAULT_HEIGHT = 92

let captureWindow: BrowserWindow | null = null

/**
 * Pre-creates the capture window hidden so the hotkey shows it instantly.
 * Frameless, transparent (the card + shadow are drawn by the renderer),
 * always on top and out of the taskbar.
 */
export function createCaptureWindow(): BrowserWindow {
  captureWindow = new BrowserWindow({
    width: CAPTURE_WIDTH,
    height: DEFAULT_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Nova ideia',
    webPreferences: securePreferences
  })
  captureWindow.setAlwaysOnTop(true, 'screen-saver')
  captureWindow.setMenu(null)
  hardenWebContents(captureWindow)

  // Clicking elsewhere dismisses it (the draft stays in the renderer).
  captureWindow.on('blur', () => hideCaptureWindow())
  captureWindow.on('closed', () => {
    captureWindow = null
  })

  void loadPage(captureWindow, 'capture')
  return captureWindow
}

/** Centers the window horizontally (upper third) on the display under the cursor. */
function positionOnActiveDisplay(win: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = display.workArea
  const [w, h] = win.getSize()
  win.setBounds({
    x: Math.round(x + (width - w) / 2),
    y: Math.round(y + height * 0.28),
    width: w,
    height: h
  })
}

export function showCaptureWindow(): void {
  if (!captureWindow || captureWindow.isDestroyed()) createCaptureWindow()
  const win = captureWindow!
  if (win.isVisible()) {
    win.focus()
    return
  }
  positionOnActiveDisplay(win)
  win.show()
  win.focus()
  win.webContents.focus()
  win.webContents.send(IpcEvents.captureShown)
}

/**
 * Hides the capture window. On Windows, hiding the focused window hands
 * activation back to the previous foreground window (the app the user was in).
 */
export function hideCaptureWindow(): void {
  if (!captureWindow || captureWindow.isDestroyed() || !captureWindow.isVisible()) return
  captureWindow.hide()
}

export function resizeCaptureWindow(height: number): void {
  if (!captureWindow || captureWindow.isDestroyed()) return
  const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)))
  const b = captureWindow.getBounds()
  if (b.height === h) return
  captureWindow.setBounds({ ...b, height: h })
}
