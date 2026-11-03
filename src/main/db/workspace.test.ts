import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createRepositories, type Repositories } from './index'
import { getSchemaVersion, migrations, runMigrations } from './migrations'
import { AppError } from './errors'
import type { BoardFile } from '@shared/types'

let repos: Repositories
let clock: number

beforeEach(() => {
  clock = 1_000
  repos = createRepositories(':memory:', () => ++clock)
})

const png = (id: string, extra = ''): BoardFile => ({
  id,
  mimeType: 'image/png',
  dataURL: `data:image/png;base64,iVBORw0KGgo${extra}`,
  created: 500
})

const rect = { id: 'r1', type: 'rectangle', x: 10, y: 20, width: 100, height: 50 }
const image = (fileId: string) => ({ id: `img-${fileId}`, type: 'image', fileId, x: 0, y: 0 })

describe('migration v2', () => {
  it('creates boards, board_files and macro_plans', () => {
    const tables = repos.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toEqual(expect.arrayContaining(['boards', 'board_files', 'macro_plans']))
    expect(getSchemaVersion(repos.db)).toBeGreaterThanOrEqual(2)
  })

  it('upgrades a v1 database keeping existing data', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(
      db,
      migrations.filter((m) => m.version === 1)
    )
    db.prepare("INSERT INTO ideas (title, created_at, updated_at) VALUES ('antiga', 1, 1)").run()
    expect(runMigrations(db)).toEqual([2, 3, 4])
    expect(db.prepare('SELECT title FROM ideas').get()).toEqual({ title: 'antiga' })
    expect(db.prepare('SELECT COUNT(*) c FROM boards').get()).toEqual({ c: 0 })
  })
})

describe('BoardsRepository', () => {
  it('returns null for an idea without board', () => {
    const idea = repos.ideas.create({ title: 'A' })
    expect(repos.boards.get(idea.id)).toBeNull()
  })

  it('saves and loads elements, appState and files', () => {
    const idea = repos.ideas.create({ title: 'A' })
    const appState = { scrollX: 12, scrollY: -4, zoom: { value: 1.5 }, viewBackgroundColor: '#fff' }
    const res = repos.boards.save(idea.id, {
      elements: [rect, image('f1')],
      appState,
      newFiles: [png('f1')],
      referencedFileIds: ['f1']
    })
    const board = repos.boards.get(idea.id)!
    expect(board.elements).toEqual([rect, image('f1')])
    expect(board.appState).toEqual(appState)
    expect(board.files).toEqual([png('f1')])
    expect(board.updatedAt).toBe(res.updatedAt)
  })

  it('overwrites the scene and keeps already stored files when only referenced', () => {
    const idea = repos.ideas.create({ title: 'A' })
    repos.boards.save(idea.id, {
      elements: [image('f1')],
      appState: {},
      newFiles: [png('f1')],
      referencedFileIds: ['f1']
    })
    // Second save: f1 is not re-sent, f2 is new.
    const second = repos.boards.save(idea.id, {
      elements: [rect, image('f1'), image('f2')],
      appState: { scrollX: 1 },
      newFiles: [png('f2')],
      referencedFileIds: ['f1', 'f2']
    })
    const board = repos.boards.get(idea.id)!
    expect(board.elements).toHaveLength(3)
    expect(board.files.map((f) => f.id).sort()).toEqual(['f1', 'f2'])
    expect(board.updatedAt).toBe(second.updatedAt)
    expect(repos.db.prepare('SELECT COUNT(*) c FROM boards').get()).toEqual({ c: 1 })
  })

  it('prunes files no longer referenced by any image element', () => {
    const idea = repos.ideas.create({ title: 'A' })
    repos.boards.save(idea.id, {
      elements: [image('f1'), image('f2')],
      appState: {},
      newFiles: [png('f1'), png('f2')],
      referencedFileIds: ['f1', 'f2']
    })
    repos.boards.save(idea.id, {
      elements: [image('f2')],
      appState: {},
      newFiles: [],
      referencedFileIds: ['f2']
    })
    expect(repos.boards.get(idea.id)!.files.map((f) => f.id)).toEqual(['f2'])
  })

  it('isolates boards per idea', () => {
    const a = repos.ideas.create({ title: 'A' })
    const b = repos.ideas.create({ title: 'B' })
    repos.boards.save(a.id, { elements: [rect], appState: {}, newFiles: [png('f1')], referencedFileIds: ['f1'] })
    repos.boards.save(b.id, { elements: [], appState: {}, newFiles: [], referencedFileIds: [] })
    expect(repos.boards.get(a.id)!.files).toHaveLength(1)
    expect(repos.boards.get(b.id)!.files).toHaveLength(0)
  })

  it('validates input', () => {
    const idea = repos.ideas.create({ title: 'A' })
    expect(() =>
      repos.boards.save(999, { elements: [], appState: {}, newFiles: [], referencedFileIds: [] })
    ).toThrow(AppError)
    expect(() =>
      repos.boards.save(idea.id, { elements: 'x' as never, appState: {}, newFiles: [], referencedFileIds: [] })
    ).toThrow(/Cena/)
    expect(() =>
      repos.boards.save(idea.id, {
        elements: [],
        appState: {},
        newFiles: [{ ...png('f1'), dataURL: 'http://evil/x.png' }],
        referencedFileIds: ['f1']
      })
    ).toThrow(/Conteúdo/)
  })

  it('tolerates a corrupted scene row', () => {
    const idea = repos.ideas.create({ title: 'A' })
    repos.db.prepare("INSERT INTO boards (idea_id, scene_json, updated_at) VALUES (?, '{oops', 1)").run(idea.id)
    expect(repos.boards.get(idea.id)).toMatchObject({ elements: [], appState: {}, files: [] })
  })
})

describe('MacroPlansRepository', () => {
  it('returns an empty plan by default', () => {
    const idea = repos.ideas.create({ title: 'A' })
    expect(repos.macroPlans.get(idea.id)).toEqual({ markdown: '', updatedAt: 0 })
  })

  it('saves (upsert) and loads markdown verbatim', () => {
    const idea = repos.ideas.create({ title: 'A' })
    repos.macroPlans.save(idea.id, '# Plano\n\n- passo 1\n')
    const res = repos.macroPlans.save(idea.id, '# Plano\n\n- passo 1\n- passo 2  \n')
    expect(repos.macroPlans.get(idea.id)).toEqual({
      markdown: '# Plano\n\n- passo 1\n- passo 2  \n',
      updatedAt: res.updatedAt
    })
    expect(repos.db.prepare('SELECT COUNT(*) c FROM macro_plans').get()).toEqual({ c: 1 })
  })

  it('validates input', () => {
    const idea = repos.ideas.create({ title: 'A' })
    expect(() => repos.macroPlans.save(idea.id, 42 as never)).toThrow(AppError)
    expect(() => repos.macroPlans.save(999, 'x')).toThrow(/não encontrad/)
  })
})

describe('deleting an idea cascades its workspace', () => {
  it('removes board, board files and macro plan', () => {
    const a = repos.ideas.create({ title: 'A' })
    const b = repos.ideas.create({ title: 'B' })
    for (const idea of [a, b]) {
      repos.boards.save(idea.id, {
        elements: [image('f1')],
        appState: {},
        newFiles: [png('f1')],
        referencedFileIds: ['f1']
      })
      repos.macroPlans.save(idea.id, '# x')
    }
    repos.ideas.delete(a.id)
    const count = (t: string): number =>
      (repos.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE idea_id = ?`).get(a.id) as { c: number }).c
    expect(count('boards')).toBe(0)
    expect(count('board_files')).toBe(0)
    expect(count('macro_plans')).toBe(0)
    // The other idea is untouched.
    expect(repos.boards.get(b.id)!.files).toHaveLength(1)
    expect(repos.macroPlans.get(b.id).markdown).toBe('# x')
  })

  it('archiving keeps the workspace', () => {
    const a = repos.ideas.create({ title: 'A' })
    repos.macroPlans.save(a.id, 'mantém')
    repos.ideas.archive(a.id)
    expect(repos.macroPlans.get(a.id).markdown).toBe('mantém')
  })
})
