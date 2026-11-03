import type Database from 'better-sqlite3'
import {
  IDEA_STATUSES,
  type Idea,
  type IdeaPatch,
  type IdeaProjectLink,
  type IdeaStatus,
  type NewIdeaInput
} from '@shared/types'
import { invalid, notFound } from '../errors'
import { PlanError } from '@shared/plan'
import { afterLinksChanged } from './ideaLinks'
import { storiesUsingProject } from './plan'

interface IdeaRow {
  id: number
  title: string
  body: string
  status: IdeaStatus
  created_at: number
  updated_at: number
}

interface LinkRow {
  idea_id: number
  project_id: number
  is_primary: number
}

export const TITLE_MAX = 300

function cleanTitle(title: unknown): string {
  if (typeof title !== 'string') throw invalid('O título da ideia é obrigatório.')
  const t = title.trim()
  if (!t) throw invalid('O título da ideia é obrigatório.')
  if (t.length > TITLE_MAX) throw invalid(`O título pode ter no máximo ${TITLE_MAX} caracteres.`)
  return t
}

function cleanBody(body: unknown): string {
  if (body == null) return ''
  if (typeof body !== 'string') throw invalid('Detalhe inválido.')
  return body.trim()
}

export class IdeasRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now
  ) {}

  list(): Idea[] {
    const rows = this.db
      .prepare('SELECT * FROM ideas ORDER BY created_at DESC, id DESC')
      .all() as IdeaRow[]
    const links = this.db
      .prepare(
        'SELECT idea_id, project_id, is_primary FROM idea_projects ORDER BY is_primary DESC, linked_at ASC, project_id ASC'
      )
      .all() as LinkRow[]
    const byIdea = new Map<number, IdeaProjectLink[]>()
    for (const l of links) {
      const arr = byIdea.get(l.idea_id) ?? []
      arr.push({ projectId: l.project_id, isPrimary: l.is_primary === 1 })
      byIdea.set(l.idea_id, arr)
    }
    return rows.map((r) => toIdea(r, byIdea.get(r.id) ?? []))
  }

  get(id: number): Idea {
    const row = this.db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as IdeaRow | undefined
    if (!row) throw notFound('Ideia', id)
    return toIdea(row, this.linksOf(id))
  }

  listByProject(projectId: number): Idea[] {
    return this.list().filter((i) => i.projects.some((p) => p.projectId === projectId))
  }

  create(input: NewIdeaInput): Idea {
    const title = cleanTitle(input?.title)
    const body = cleanBody(input?.body)
    const ts = this.now()
    const info = this.db
      .prepare(
        "INSERT INTO ideas (title, body, status, created_at, updated_at) VALUES (?, ?, 'solta', ?, ?)"
      )
      .run(title, body, ts, ts)
    return this.get(Number(info.lastInsertRowid))
  }

  update(id: number, patch: IdeaPatch): Idea {
    const current = this.get(id)
    const title = patch.title !== undefined ? cleanTitle(patch.title) : current.title
    const body = patch.body !== undefined ? cleanBody(patch.body) : current.body
    const status = patch.status !== undefined ? patch.status : current.status
    if (!IDEA_STATUSES.includes(status)) throw invalid(`Status inválido: ${String(status)}`)
    this.db
      .prepare('UPDATE ideas SET title = ?, body = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(title, body, status, this.now(), id)
    return this.get(id)
  }

  archive(id: number): Idea {
    return this.update(id, { status: 'arquivada' })
  }

  /** Restores an archived idea: "solta" if it has no project, else "em_trabalho". */
  unarchive(id: number): Idea {
    const idea = this.get(id)
    return this.update(id, { status: idea.projects.length > 0 ? 'em_trabalho' : 'solta' })
  }

  delete(id: number): void {
    const info = this.db.prepare('DELETE FROM ideas WHERE id = ?').run(id)
    if (info.changes === 0) throw notFound('Ideia', id)
  }

  /**
   * Links an idea to a project. The first link becomes primary automatically;
   * `makePrimary` moves the primary flag to this project.
   */
  linkProject(ideaId: number, projectId: number, makePrimary = false): Idea {
    this.get(ideaId)
    this.assertProject(projectId)
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO idea_projects (idea_id, project_id, is_primary, linked_at) VALUES (?, ?, 0, ?)'
        )
        .run(ideaId, projectId, this.now())
      if (makePrimary) this.setPrimaryTx(ideaId, projectId)
      afterLinksChanged(this.db, ideaId, this.now())
      this.touch(ideaId)
    })()
    return this.get(ideaId)
  }

  /**
   * Unlinks a project. Rejected (`project_in_use`) while stories of the idea's
   * plan still use it: moving or deleting them first is the user's call.
   */
  unlinkProject(ideaId: number, projectId: number): Idea {
    this.get(ideaId)
    const stories = storiesUsingProject(this.db, projectId, ideaId)
    if (stories.length > 0) {
      const name = (this.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined)?.name
      throw new PlanError(
        'project_in_use',
        `Não dá para desvincular o projeto "${name ?? `#${projectId}`}": ${stories.length === 1 ? 'a story' : 'as stories'} ${stories
          .map((x) => `"${x.title}"`)
          .join(', ')} do plano de tarefas ${stories.length === 1 ? 'usa' : 'usam'} esse projeto. Mude o projeto ${stories.length === 1 ? 'dela' : 'delas'} ou apague-${stories.length === 1 ? 'a' : 'as'} antes.`
      )
    }
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM idea_projects WHERE idea_id = ? AND project_id = ?')
        .run(ideaId, projectId)
      afterLinksChanged(this.db, ideaId, this.now())
      this.touch(ideaId)
    })()
    return this.get(ideaId)
  }

  setPrimaryProject(ideaId: number, projectId: number): Idea {
    this.get(ideaId)
    const linked = this.db
      .prepare('SELECT 1 FROM idea_projects WHERE idea_id = ? AND project_id = ?')
      .get(ideaId, projectId)
    if (!linked) throw invalid('O projeto precisa estar vinculado à ideia para ser o principal.')
    this.db.transaction(() => {
      this.setPrimaryTx(ideaId, projectId)
      this.touch(ideaId)
    })()
    return this.get(ideaId)
  }

  private setPrimaryTx(ideaId: number, projectId: number): void {
    this.db.prepare('UPDATE idea_projects SET is_primary = 0 WHERE idea_id = ?').run(ideaId)
    this.db
      .prepare('UPDATE idea_projects SET is_primary = 1 WHERE idea_id = ? AND project_id = ?')
      .run(ideaId, projectId)
  }

  private touch(ideaId: number): void {
    this.db.prepare('UPDATE ideas SET updated_at = ? WHERE id = ?').run(this.now(), ideaId)
  }

  private assertProject(projectId: number): void {
    const p = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)
    if (!p) throw notFound('Projeto', projectId)
  }

  private linksOf(ideaId: number): IdeaProjectLink[] {
    const rows = this.db
      .prepare(
        'SELECT idea_id, project_id, is_primary FROM idea_projects WHERE idea_id = ? ORDER BY is_primary DESC, linked_at ASC, project_id ASC'
      )
      .all(ideaId) as LinkRow[]
    return rows.map((l) => ({ projectId: l.project_id, isPrimary: l.is_primary === 1 }))
  }
}

function toIdea(r: IdeaRow, projects: IdeaProjectLink[]): Idea {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    projects
  }
}
