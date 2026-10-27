import type { VisualizeApi } from '../shared/api'

declare global {
  interface Window {
    api: VisualizeApi
  }
}

export {}
