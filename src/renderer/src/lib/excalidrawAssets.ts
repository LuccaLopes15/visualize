// Must run before Excalidraw registers its fonts: points the font loader at
// the copy bundled with the app (see `excalidrawAssets` in electron.vite.config.ts)
// instead of the esm.sh CDN. Absolute URL so it works both on the dev server
// (http://localhost) and on file:// in the packaged app.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

window.EXCALIDRAW_ASSET_PATH = new URL('./excalidraw-assets/', window.location.href).href

export {}
