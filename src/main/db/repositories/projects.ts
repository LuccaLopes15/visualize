import type Database from 'better-sqlite3'
import type { NewProjectInput, Project, ProjectPatch } from '@shared/types'
import { invalid, notFound } from '../errors'
import { PlanError } from '@shared/plan'
import { afterLinksChanged } from './ideaLinks'
import { storiesUsingProject } from './plan'

interface ProjectRow {
  id: number
  name: string
  folder_path: string
  created_at: number
  idea_count: number
}

const SELECT_PROJECTS = `
  SELECT p.*,
    (SELECT COUNT(*) FROM idea_projects ip JOIN ideas i ON i.id = ip.idea_id
      WHERE ip.project_id = p.id AND i.status <> 'arquivada') AS idea_count
  FROM projects p`

function cleanName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw invalid('O nome do projeto é obrigatório.')
  const n = name.trim()
  if (n.length > 120) throw invalid('O nome do projeto pode ter no máximo 120 caracteres.')
  return n
}

function cleanFolder(folder: unknown): string {
  if (typeof folder !== 'string' || !folder.trim())
    throw invalid('A pasta do projeto é obrigatória.')
  return folder.trim()
}

export class ProjectsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now
  ) {}

  list(): Project[] {
    const rows = this.db
      .prepare(`${SELECT_PROJECTS} ORDER BY p.name COLLATE NOCASE ASC, p.id ASC`)
      .all() as ProjectRow[]
    return rows.map(toProject)
  }

  get(id: number): Project {
    const row = this.db.prepare(`${SELECT_PROJECTS} WHERE p.id = ?`).get(id) as
      | ProjectRow
      | undefined
    if (!row) throw notFound('Projeto', id)
    return toProject(row)
  }

  create(input: NewProjectInput): Project {
    const name = cleanName(input?.name)
    const folder = cleanFolder(input?.folderPath)
    const info = this.db
      .prepare('INSERT INTO projects (name, folder_path, created_at) VALUES (?, ?, ?)')
      .run(name, folder, this.now())
    return this.get(Number(info.lastInsertRowid))
  }

  update(id: number, patch: ProjectPatch): Project {
    const current = this.get(id)
    const name = patch.name !== undefined ? cleanName(patch.name) : current.name
    const folder = patch.folderPath !== undefined ? cleanFolder(patch.folderPath) : current.folderPath
    this.db.prepare('UPDATE projects SET name = ?, folder_path = ? WHERE id = ?').run(name, folder, id)
    return this.get(id)
  }

  /**
   * Removes the project (rejected with `project_in_use` while plan stories use it). Ideas are kept: only their links to this project go
   * away. Ideas that had it as primary get another linked project promoted;
   * ideas left without any project go back to "solta".
   */
  delete(id: number): void {
    const project = this.get(id)
    const stories = storiesUsingProject(this.db, id)
    if (stories.length > 0) {
      throw new PlanError(
        'project_in_use',
        `Não dá para excluir o projeto "${project.name}": há stories de planos de tarefas que o usam (${stories
          .slice(0, 5)
          .map((x) => `"${x.title}" em "${x.ideaTitle}"`)
          .join(', ')}${stories.length > 5 ? ` e mais ${stories.length - 5}` : ''}). Mude o projeto delas ou apague-as antes.`
      )
    }
    this.db.transaction(() => {
      const affected = this.db
        .prepare('SELECT idea_id FROM idea_projects WHERE project_id = ?')
        .all(id) as { idea_id: number }[]
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      for (const a of affected) afterLinksChanged(this.db, a.idea_id, this.now())
    })()
  }
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    folderPath: r.folder_path,
    createdAt: r.created_at,
    ideaCount: r.idea_count
  }
}
