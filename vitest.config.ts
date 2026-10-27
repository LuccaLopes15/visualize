import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// better-sqlite3 >= 13 ships N-API prebuilds (prebuilds/<platform>-<arch>.node),
// so the same binary loads under plain Node (tests) and under Electron (app).
// No ABI rebuild and no ELECTRON_RUN_AS_NODE trick are needed.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
