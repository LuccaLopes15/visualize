import type Database from 'better-sqlite3'
import type { MacroPlan, SaveResult } from '@shared/types'
import { invalid, notFound } from '../errors'

/** Generous cap (~5 MB of text); keeps a runaway paste from bloating the DB. */
export const MACRO_MAX = 5_000_000

/** Markdown "plano macro" per idea. Rows cascade when the idea is deleted. */
export class MacroPlansRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now
  ) {}

  get(ideaId: number): MacroPlan {
    const row = this.db
      .prepare('SELECT markdown, updated_at FROM macro_plans WHERE idea_id = ?')
      .get(ideaId) as { markdown: string; updated_at: number } | undefined
    return row ? { markdown: row.markdown, updatedAt: row.updated_at } : { markdown: '', updatedAt: 0 }
  }

  save(ideaId: number, markdown: string): SaveResult {
    if (typeof markdown !== 'string') throw invalid('Plano macro inválido.')
    if (markdown.length > MACRO_MAX) throw invalid('O plano macro ficou grande demais.')
    if (!this.db.prepare('SELECT 1 FROM ideas WHERE id = ?').get(ideaId)) throw notFound('Ideia', ideaId)
    const ts = this.now()
    this.db
      .prepare(
        `INSERT INTO macro_plans (idea_id, markdown, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(idea_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`
      )
      .run(ideaId, markdown, ts)
    return { updatedAt: ts }
  }
}
