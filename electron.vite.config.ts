import { createReadStream, cpSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

/**
 * Excalidraw loads its hand-drawn fonts at runtime from
 * `window.EXCALIDRAW_ASSET_PATH` (falling back to a CDN). To work offline we
 * serve `node_modules/@excalidraw/excalidraw/dist/prod/fonts` at
 * `/excalidraw-assets/fonts` in dev and copy it next to the built renderer.
 * The renderer points EXCALIDRAW_ASSET_PATH there (src/renderer/src/lib/excalidrawAssets.ts).
 */
// Excalidraw appends a hardcoded esm.sh URL to every font face as a fallback.
// The CSP blocks it anyway, but Chromium logs one violation per face (~230
// errors). Point the fallback at the local copy too, so nothing ever targets
// the CDN. Applied to the dev pre-bundle (esbuild) and to the production build.
const EXCALIDRAW_FILE = /[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/].*\.js$/
const FALLBACK_RE = /(["']ASSETS_FALLBACK_URL["']\s*,\s*)`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`/
const LOCAL_FALLBACK = '$1(typeof window.EXCALIDRAW_ASSET_PATH === "string" ? window.EXCALIDRAW_ASSET_PATH : "./excalidraw-assets/")'

function patchFontFallback(code: string): string | null {
  return FALLBACK_RE.test(code) ? code.replace(FALLBACK_RE, LOCAL_FALLBACK) : null
}

function excalidrawAssets(): Plugin {
  const fontsDir = resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
  const prefix = '/excalidraw-assets/fonts/'
  return {
    name: 'visualize:excalidraw-assets',
    config() {
      return {
        optimizeDeps: {
          esbuildOptions: {
            plugins: [
              {
                name: 'visualize:excalidraw-font-fallback',
                setup(build) {
                  build.onLoad({ filter: EXCALIDRAW_FILE }, (args) => {
                    const patched = patchFontFallback(readFileSync(args.path, 'utf8'))
                    return patched === null ? undefined : { contents: patched, loader: 'js' }
                  })
                }
              }
            ]
          }
        }
      }
    },
    transform(code, id) {
      if (!EXCALIDRAW_FILE.test(id.split('?')[0])) return null
      const patched = patchFontFallback(code)
      return patched === null ? null : { code: patched, map: null }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        if (!url.startsWith(prefix)) return next()
        const file = normalize(join(fontsDir, decodeURIComponent(url.slice(prefix.length))))
        if (!file.startsWith(fontsDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404
          res.end()
          return
        }
        res.setHeader('Content-Type', file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream')
        res.setHeader('Cache-Control', 'max-age=31536000, immutable')
        createReadStream(file).pipe(res)
      })
    },
    writeBundle(options) {
      if (!options.dir) return
      cpSync(fontsDir, join(options.dir, 'excalidraw-assets', 'fonts'), { recursive: true })
    }
  }
}

export default defineConfig({
  main: {
    // electron-vite 5: externalizeDeps is on by default (replaces the deprecated
    // externalizeDepsPlugin). Keeps better-sqlite3 out of the bundle so the
    // native addon is loaded from node_modules at runtime.
    build: { externalizeDeps: true },
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    build: { externalizeDeps: true },
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react(), excalidrawAssets()],
    build: {
      // Excalidraw is big; it lives in its own lazily loaded chunk.
      chunkSizeWarningLimit: 4096,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          capture: resolve(__dirname, 'src/renderer/capture.html')
        }
      }
    }
  }
})
