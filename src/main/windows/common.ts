import { app, shell, type BrowserWindow, type WebPreferences } from 'electron'
import { join } from 'node:path'

export type RendererPage = 'index' | 'capture'

export const securePreferences: WebPreferences = {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: true
}

export function loadPage(win: BrowserWindow, page: RendererPage): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) return win.loadURL(`${devUrl}/${page}.html`)
  return win.loadFile(join(__dirname, `../renderer/${page}.html`))
}

/** Blocks in-app navigation and opens external links in the default browser. */
export function hardenWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })
}
