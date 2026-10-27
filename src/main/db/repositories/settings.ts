import type Database from 'better-sqlite3'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'

/**
 * Key/value settings. Values are stored JSON-encoded. Typed access for the
 * known `AppSettings` keys (with defaults) plus raw access for later phases
 * (e.g. `devops_org_url`, `claude_path`).
 */
export class SettingsRepository {
  constructor(private readonly db: Database.Database) {}

  getAll(): AppSettings {
    const result: AppSettings = { ...DEFAULT_SETTINGS }
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
      const v = this.getRaw(key)
      if (v !== undefined) (result as unknown as Record<string, unknown>)[key] = v
    }
    return result
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    const v = this.getRaw(key)
    return (v === undefined ? DEFAULT_SETTINGS[key] : v) as AppSettings[K]
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.setRaw(key, value)
  }

  getRaw(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return row.value
    }
  }

  setRaw(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, JSON.stringify(value))
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }
}
