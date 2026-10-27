import type Database from 'better-sqlite3'

/**
 * Guarantees the invariant "an idea with 1+ linked projects has exactly one
 * primary". If links exist but none is primary, the oldest link is promoted.
 */
export function ensurePrimary(db: Database.Database, ideaId: number): void {
  const hasPrimary = db
    .prepare('SELECT 1 FROM idea_projects WHERE idea_id = ? AND is_primary = 1')
    .get(ideaId)
  if (hasPrimary) return
  db.prepare(
    `UPDATE idea_projects SET is_primary = 1
     WHERE idea_id = ? AND project_id = (
       SELECT project_id FROM idea_projects WHERE idea_id = ?
       ORDER BY linked_at ASC, project_id ASC LIMIT 1
     )`
  ).run(ideaId, ideaId)
}
