import type Database from 'better-sqlite3'

/**
 * Versioned migrations. The schema version is stored in `PRAGMA user_version`.
 * Rules: never edit a migration that has shipped; append a new one instead.
 * Each migration runs inside a transaction together with the version bump.
 */
export interface Migration {
  version: number
  name: string
  up: string
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'fase1_projects_ideas_settings',
    up: `
      CREATE TABLE projects (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        folder_path TEXT    NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE ideas (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT    NOT NULL,
        body       TEXT    NOT NULL DEFAULT '',
        status     TEXT    NOT NULL DEFAULT 'solta'
                   CHECK (status IN ('solta','em_trabalho','planejada','ticketada','arquivada')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_ideas_created ON ideas (created_at DESC);

      CREATE TABLE idea_projects (
        idea_id    INTEGER NOT NULL REFERENCES ideas (id)    ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        linked_at  INTEGER NOT NULL,
        PRIMARY KEY (idea_id, project_id)
      );
      CREATE INDEX idx_idea_projects_project ON idea_projects (project_id);
      -- At most one primary project per idea.
      CREATE UNIQUE INDEX idx_idea_projects_primary ON idea_projects (idea_id) WHERE is_primary = 1;

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  }
]

export function getSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number
}

/** Applies pending migrations in order. Returns the list of versions applied. */
export function runMigrations(db: Database.Database, list: Migration[] = migrations): number[] {
  const sorted = [...list].sort((a, b) => a.version - b.version)
  const current = getSchemaVersion(db)
  const applied: number[] = []
  for (const m of sorted) {
    if (m.version <= current) continue
    db.transaction(() => {
      db.exec(m.up)
      db.pragma(`user_version = ${m.version}`)
    })()
    applied.push(m.version)
  }
  return applied
}
