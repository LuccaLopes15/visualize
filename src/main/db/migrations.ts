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
  },
  {
    version: 2,
    name: 'fase2_boards_macro_plans',
    up: `
      -- Excalidraw scene (elements + durable appState) as JSON, one per idea.
      CREATE TABLE boards (
        idea_id    INTEGER PRIMARY KEY REFERENCES ideas (id) ON DELETE CASCADE,
        scene_json TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Images pasted into a board. Kept apart from the scene: they are large and
      -- immutable (Excalidraw fileId), so autosave only writes the new ones.
      CREATE TABLE board_files (
        idea_id    INTEGER NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
        file_id    TEXT    NOT NULL,
        mime       TEXT    NOT NULL,
        data_url   TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (idea_id, file_id)
      );

      CREATE TABLE macro_plans (
        idea_id    INTEGER PRIMARY KEY REFERENCES ideas (id) ON DELETE CASCADE,
        markdown   TEXT    NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 3,
    name: 'fase3_chat',
    up: `
      -- Claude Code CLI session of an idea's chat (resumed with --resume).
      -- context_sig: hash of the idea context (title/body/projects) Claude last saw.
      CREATE TABLE chat_sessions (
        idea_id        INTEGER PRIMARY KEY REFERENCES ideas (id) ON DELETE CASCADE,
        cli_session_id TEXT,
        context_sig    TEXT    NOT NULL DEFAULT '',
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE chat_messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        idea_id      INTEGER NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
        role         TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
        content_json TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_chat_messages_idea ON chat_messages (idea_id, id);
    `
  },
  {
    version: 4,
    name: 'fase4_plan_graph',
    up: `
      -- Task graph of an idea: stories (roots) and tasks (any depth below).
      -- Tasks store project_id NULL: their project is derived from the root story
      -- (so moving a task or changing a story's project never needs a sync).
      -- project_id is RESTRICT: a project with stories cannot be deleted (the app
      -- checks first and shows a friendly message).
      CREATE TABLE plan_nodes (
        id               TEXT    PRIMARY KEY,
        idea_id          INTEGER NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
        kind             TEXT    NOT NULL CHECK (kind IN ('story', 'task')),
        title            TEXT    NOT NULL,
        description      TEXT    NOT NULL DEFAULT '',
        parent_id        TEXT    REFERENCES plan_nodes (id) ON DELETE CASCADE,
        project_id       INTEGER REFERENCES projects (id) ON DELETE RESTRICT,
        sort             INTEGER NOT NULL DEFAULT 0,
        devops_id        INTEGER,
        devops_url       TEXT,
        devops_synced_at INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        CHECK (
          (kind = 'story' AND parent_id IS NULL     AND project_id IS NOT NULL) OR
          (kind = 'task'  AND parent_id IS NOT NULL AND project_id IS NULL)
        )
      );
      CREATE INDEX idx_plan_nodes_idea    ON plan_nodes (idea_id);
      CREATE INDEX idx_plan_nodes_parent  ON plan_nodes (parent_id);
      CREATE INDEX idx_plan_nodes_project ON plan_nodes (project_id);

      -- "from_id depende de to_id". Same-idea / acyclic rules are enforced by the repository.
      CREATE TABLE plan_deps (
        from_id TEXT NOT NULL REFERENCES plan_nodes (id) ON DELETE CASCADE,
        to_id   TEXT NOT NULL REFERENCES plan_nodes (id) ON DELETE CASCADE,
        PRIMARY KEY (from_id, to_id),
        CHECK (from_id <> to_id)
      );
      CREATE INDEX idx_plan_deps_to ON plan_deps (to_id);
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
