import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

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
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          capture: resolve(__dirname, 'src/renderer/capture.html')
        }
      }
    }
  }
})
