import { beforeEach, describe, expect, it } from 'vitest'
import { createRepositories, type Repositories } from './index'
import { getSchemaVersion, migrations, runMigrations } from './migrations'
import { openDatabase } from './connection'
import { AppError } from './errors'

let repos: Repositories
let clock: number

beforeEach(() => {
  clock = 1_000
  repos = createRepositories(':memory:', () => ++clock)
})

describe('migrations', () => {
  it('applies all migrations and sets user_version', () => {
    expect(getSchemaVersion(repos.db)).toBe(migrations[migrations.length - 1].version)
    const tables = repos.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toEqual(expect.arrayContaining(['ideas', 'idea_projects', 'projects', 'settings']))
  })

  it('is idempotent and only runs pending migrations', () => {
    const db = openDatabase(':memory:')
    expect(runMigrations(db)).toEqual([])
    const extra = [...migrations, { version: 99, name: 'test', up: 'CREATE TABLE t (x INTEGER);' }]
    expect(runMigrations(db, extra)).toEqual([99])
    expect(getSchemaVersion(db)).toBe(99)
    expect(runMigrations(db, extra)).toEqual([])
  })

  it('ideas table has no project_id column (links live in idea_projects)', () => {
    const cols = repos.db.pragma('table_info(ideas)') as { name: string }[]
    expect(cols.map((c) => c.name)).not.toContain('project_id')
  })
})

describe('IdeasRepository', () => {
  it('creates an idea as "solta", trimmed, with no projects', () => {
    const idea = repos.ideas.create({ title: '  Cache de relatórios  ', body: ' detalhe ' })
    expect(idea).toMatchObject({ title: 'Cache de relatórios', body: 'detalhe', status: 'solta', projects: [] })
    expect(idea.createdAt).toBe(idea.updatedAt)
  })

  it('rejects empty titles', () => {
    expect(() => repos.ideas.create({ title: '   ' })).toThrow(AppError)
  })

  it('lists newest first', () => {
    const a = repos.ideas.create({ title: 'A' })
    const b = repos.ideas.create({ title: 'B' })
    expect(repos.ideas.list().map((i) => i.id)).toEqual([b.id, a.id])
  })

  it('updates title/body/status and bumps updated_at', () => {
    const idea = repos.ideas.create({ title: 'A' })
    const updated = repos.ideas.update(idea.id, { title: 'A2', body: 'x', status: 'planejada' })
    expect(updated).toMatchObject({ title: 'A2', body: 'x', status: 'planejada' })
    expect(updated.updatedAt).toBeGreaterThan(idea.updatedAt)
  })

  it('rejects invalid status', () => {
    const idea = repos.ideas.create({ title: 'A' })
    expect(() => repos.ideas.update(idea.id, { status: 'xyz' as never })).toThrow(/Status inválido/)
  })

  it('archives and unarchives', () => {
    const idea = repos.ideas.create({ title: 'A' })
    expect(repos.ideas.archive(idea.id).status).toBe('arquivada')
    expect(repos.ideas.unarchive(idea.id).status).toBe('solta')
  })

  it('deletes and throws not_found for missing ids', () => {
    const idea = repos.ideas.create({ title: 'A' })
    repos.ideas.delete(idea.id)
    expect(repos.ideas.list()).toHaveLength(0)
    expect(() => repos.ideas.delete(idea.id)).toThrow(/não encontrad/)
    expect(() => repos.ideas.get(12345)).toThrow(AppError)
  })

  describe('project links', () => {
    it('first linked project becomes primary; others are secondary', () => {
      const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
      const p2 = repos.projects.create({ name: 'P2', folderPath: 'C:\\p2' })
      const idea = repos.ideas.create({ title: 'A' })
      repos.ideas.linkProject(idea.id, p1.id)
      const linked = repos.ideas.linkProject(idea.id, p2.id)
      expect(linked.projects).toEqual([
        { projectId: p1.id, isPrimary: true },
        { projectId: p2.id, isPrimary: false }
      ])
    })

    it('linking twice is a no-op', () => {
      const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
      const idea = repos.ideas.create({ title: 'A' })
      repos.ideas.linkProject(idea.id, p1.id)
      expect(repos.ideas.linkProject(idea.id, p1.id).projects).toHaveLength(1)
    })

    it('makePrimary / setPrimaryProject moves the primary flag (exactly one)', () => {
      const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
      const p2 = repos.projects.create({ name: 'P2', folderPath: 'C:\\p2' })
      const idea = repos.ideas.create({ title: 'A' })
      repos.ideas.linkProject(idea.id, p1.id)
      let i = repos.ideas.linkProject(idea.id, p2.id, true)
      expect(i.projects.filter((p) => p.isPrimary)).toEqual([{ projectId: p2.id, isPrimary: true }])
      i = repos.ideas.setPrimaryProject(idea.id, p1.id)
      expect(i.projects[0]).toEqual({ projectId: p1.id, isPrimary: true })
      expect(i.projects.filter((p) => p.isPrimary)).toHaveLength(1)
    })

    it('setPrimaryProject requires an existing link', () => {
      const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
      const idea = repos.ideas.create({ title: 'A' })
      expect(() => repos.ideas.setPrimaryProject(idea.id, p1.id)).toThrow(/vinculado/)
    })

    it('unlinking the primary promotes the oldest remaining link', () => {
      const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
      const p2 = repos.projects.create({ name: 'P2', folderPath: 'C:\\p2' })
      const p3 = repos.projects.create({ name: 'P3', folderPath: 'C:\\p3' })
      const idea = repos.ideas.create({ title: 'A' })
      repos.ideas.linkProject(idea.id, p1.id)
      repos.ideas.linkProject(idea.id, p2.id)
      repos.ideas.linkProject(idea.id, p3.id)
      const i = repos.ideas.unlinkProject(idea.id, p1.id)
      expect(i.projects).toEqual([
        { projectId: p2.id, isPrimary: true },
        { projectId: p3.id, isPrimary: false }
      ])
      expect(repos.ideas.unlinkProject(idea.id, p2.id).projects).toEqual([{ projectId: p3.id, isPrimary: true }])
      expect(repos.ideas.unlinkProject(idea.id, p3.id).projects).toEqual([])
    })

    it('rejects linking to a missing project', () => {
      const idea = repos.ideas.create({ title: 'A' })
      expect(() => repos.ideas.linkProject(idea.id, 999)).toThrow(/Projeto #999/)
    })

    it('listByProject returns ideas linked to that project (in any role)', () => {
      const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
      const p2 = repos.projects.create({ name: 'P2', folderPath: 'C:\\p2' })
      const a = repos.ideas.create({ title: 'A' })
      const b = repos.ideas.create({ title: 'B' })
      repos.ideas.create({ title: 'C solta' })
      repos.ideas.linkProject(a.id, p1.id)
      repos.ideas.linkProject(a.id, p2.id)
      repos.ideas.linkProject(b.id, p2.id)
      expect(repos.ideas.listByProject(p1.id).map((i) => i.title)).toEqual(['A'])
      expect(repos.ideas.listByProject(p2.id).map((i) => i.title)).toEqual(['B', 'A'])
    })

    it('"solta" means unlinked: first link -> em_trabalho, last unlink -> solta', () => {
      const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
      const idea = repos.ideas.create({ title: 'A' })
      expect(repos.ideas.linkProject(idea.id, p1.id).status).toBe('em_trabalho')
      expect(repos.ideas.unlinkProject(idea.id, p1.id).status).toBe('solta')
    })

    it('status sync never touches later statuses', () => {
      const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
      const idea = repos.ideas.create({ title: 'A' })
      repos.ideas.update(idea.id, { status: 'planejada' })
      repos.ideas.linkProject(idea.id, p1.id)
      expect(repos.ideas.unlinkProject(idea.id, p1.id).status).toBe('planejada')
    })

    it('unarchive restores solta or em_trabalho depending on links', () => {
      const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
      const a = repos.ideas.create({ title: 'A' })
      const b = repos.ideas.create({ title: 'B' })
      repos.ideas.linkProject(b.id, p1.id)
      repos.ideas.archive(a.id)
      repos.ideas.archive(b.id)
      expect(repos.ideas.unarchive(a.id).status).toBe('solta')
      expect(repos.ideas.unarchive(b.id).status).toBe('em_trabalho')
    })

    it('deleting an idea removes its links', () => {
      const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
      const idea = repos.ideas.create({ title: 'A' })
      repos.ideas.linkProject(idea.id, p1.id)
      repos.ideas.delete(idea.id)
      expect(repos.db.prepare('SELECT COUNT(*) c FROM idea_projects').get()).toEqual({ c: 0 })
    })
  })
})

describe('ProjectsRepository', () => {
  it('creates, lists (by name) and updates', () => {
    repos.projects.create({ name: 'zeta', folderPath: 'C:\\z' })
    const a = repos.projects.create({ name: 'Alpha', folderPath: ' C:\\a ' })
    expect(a.folderPath).toBe('C:\\a')
    expect(repos.projects.list().map((p) => p.name)).toEqual(['Alpha', 'zeta'])
    const u = repos.projects.update(a.id, { name: 'Alpha 2' })
    expect(u).toMatchObject({ name: 'Alpha 2', folderPath: 'C:\\a' })
  })

  it('validates name and folder', () => {
    expect(() => repos.projects.create({ name: '', folderPath: 'C:\\x' })).toThrow(/nome/)
    expect(() => repos.projects.create({ name: 'X', folderPath: ' ' })).toThrow(/pasta/)
  })

  it('counts non-archived linked ideas', () => {
    const p = repos.projects.create({ name: 'P', folderPath: 'C:\\p' })
    const a = repos.ideas.create({ title: 'A' })
    const b = repos.ideas.create({ title: 'B' })
    repos.ideas.linkProject(a.id, p.id)
    repos.ideas.linkProject(b.id, p.id)
    repos.ideas.archive(b.id)
    expect(repos.projects.get(p.id).ideaCount).toBe(1)
  })

  it('deleting a project keeps ideas and re-assigns primary', () => {
    const p1 = repos.projects.create({ name: 'P1', folderPath: 'C:\\p1' })
    const p2 = repos.projects.create({ name: 'P2', folderPath: 'C:\\p2' })
    const a = repos.ideas.create({ title: 'A' })
    const b = repos.ideas.create({ title: 'B' })
    repos.ideas.linkProject(a.id, p1.id)
    repos.ideas.linkProject(a.id, p2.id)
    repos.ideas.linkProject(b.id, p1.id)
    repos.projects.delete(p1.id)
    expect(repos.ideas.list()).toHaveLength(2)
    expect(repos.ideas.get(a.id).projects).toEqual([{ projectId: p2.id, isPrimary: true }])
    expect(repos.ideas.get(b.id).projects).toEqual([])
    expect(repos.ideas.get(b.id).status).toBe('solta')
    expect(repos.ideas.get(a.id).status).toBe('em_trabalho')
    expect(() => repos.projects.get(p1.id)).toThrow(AppError)
  })
})

describe('SettingsRepository', () => {
  it('returns defaults when nothing stored', () => {
    expect(repos.settings.getAll()).toEqual({ hotkey: 'Control+Alt+Space', autostart: true })
  })

  it('persists typed values', () => {
    repos.settings.set('hotkey', 'Control+Shift+I')
    repos.settings.set('autostart', false)
    expect(repos.settings.getAll()).toEqual({ hotkey: 'Control+Shift+I', autostart: false })
    expect(repos.settings.get('autostart')).toBe(false)
  })

  it('supports raw keys for later phases', () => {
    repos.settings.setRaw('claude_path', 'C:\\bin\\claude.exe')
    expect(repos.settings.getRaw('claude_path')).toBe('C:\\bin\\claude.exe')
    repos.settings.delete('claude_path')
    expect(repos.settings.getRaw('claude_path')).toBeUndefined()
  })
})
