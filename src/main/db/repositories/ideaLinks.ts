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

/**
 * "Solta" means "no linked project". Keeps status in sync with links:
 * solta + first link -> em_trabalho; em_trabalho + no links -> solta.
 * Later statuses (planejada, ticketada, arquivada) are never touched.
 */
export function syncLooseStatus(db: Database.Database, ideaId: number, now: number): void {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM idea_projects WHERE idea_id = ?').get(ideaId) as {
    n: number
  }
  if (n > 0) {
    db.prepare(
      "UPDATE ideas SET status = 'em_trabalho', updated_at = ? WHERE id = ? AND status = 'solta'"
    ).run(now, ideaId)
  } else {
    db.prepare(
      "UPDATE ideas SET status = 'solta', updated_at = ? WHERE id = ? AND status = 'em_trabalho'"
    ).run(now, ideaId)
  }
}

/** Ensures primary + status invariants after links changed. */
export function afterLinksChanged(db: Database.Database, ideaId: number, now: number): void {
  ensurePrimary(db, ideaId)
  syncLooseStatus(db, ideaId, now)
}
