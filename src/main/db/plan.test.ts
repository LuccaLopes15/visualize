import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createRepositories, type Repositories } from './index'
import { migrations, runMigrations } from './migrations'
import { PlanRepository } from './repositories/plan'
import { PlanError, type PlanErrorCode } from '@shared/plan'
import type { PlanGraph, PlanNode, PlanSpecNode } from '@shared/types'

let repos: Repositories
let clock: number
let ideaId: number
let p1: number // "API"
let p2: number // "Web"
let p3: number // "Mobile" (exists, NOT linked)

beforeEach(() => {
  clock = 1_000
  repos = createRepositories(':memory:', () => ++clock)
  p1 = repos.projects.create({ name: 'API', folderPath: 'C:/api' }).id
  p2 = repos.projects.create({ name: 'Web', folderPath: 'C:/web' }).id
  p3 = repos.projects.create({ name: 'Mobile', folderPath: 'C:/mobile' }).id
  ideaId = repos.ideas.create({ title: 'Ideia' }).id
  repos.ideas.linkProject(ideaId, p1)
  repos.ideas.linkProject(ideaId, p2)
})

const plan = (): PlanRepository => repos.plan
const story = (title: string, projectId = p1, extra: object = {}): PlanNode =>
  plan().createNode(ideaId, { kind: 'story', title, projectId, ...extra })
const task = (parentId: string, title: string, extra: object = {}): PlanNode =>
  plan().createNode(ideaId, { kind: 'task', title, parentId, ...extra })
const graph = (id = ideaId): PlanGraph => plan().getGraph(id)
const titles = (g: PlanGraph = graph()): string[] => g.nodes.map((n) => n.title)
const byTitle = (g: PlanGraph, title: string): PlanNode => {
  const node = g.nodes.find((n) => n.title === title)
  if (!node) throw new Error(`no node ${title}`)
  return node
}

/** Asserts a PlanError with the given code (and optional message fragment). */
function expectPlanError(fn: () => unknown, code: PlanErrorCode, msg?: string | RegExp): void {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(PlanError)
    expect((e as PlanError).code).toBe(code)
    if (msg) expect((e as PlanError).message).toMatch(msg)
    return
  }
  throw new Error(`expected PlanError(${code}) but nothing was thrown`)
}

describe('migration v4', () => {
  it('upgrades a v3 database', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(
      db,
      migrations.filter((m) => m.version <= 3)
    )
    expect(runMigrations(db)).toEqual([4, 5])
    expect(db.prepare('SELECT COUNT(*) c FROM plan_nodes').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT COUNT(*) c FROM plan_deps').get()).toEqual({ c: 0 })
  })

  it('has the Fase 5 columns, null by default', () => {
    const s = story('S')
    expect(s).toMatchObject({ devopsId: null, devopsUrl: null, devopsSyncedAt: null, devopsStale: false })
  })

  it('CHECK keeps kind/parent/project consistent even outside the repository', () => {
    const insert = (kind: string, parent: string | null, project: number | null): unknown =>
      repos.db
        .prepare(
          "INSERT INTO plan_nodes (id, idea_id, kind, title, parent_id, project_id, created_at, updated_at) VALUES (?, ?, ?, 't', ?, ?, 1, 1)"
        )
        .run(`x-${Math.random()}`, ideaId, kind, parent, project)
    const s = story('S')
    expect(() => insert('story', null, null)).toThrow() // story without project
    expect(() => insert('story', s.id, p1)).toThrow() // story with parent
    expect(() => insert('task', null, null)).toThrow() // task without parent
    expect(() => insert('task', s.id, p1)).toThrow() // task with its own project
    expect(() => insert('epic', null, p1)).toThrow()
  })
})

describe('createNode: stories', () => {
  it('creates a story in a linked project, at the top, ordered', () => {
    const a = story('A')
    const b = story('B', p2)
    expect(a).toMatchObject({ kind: 'story', parentId: null, projectId: p1, rootStoryId: a.id, depth: 0, sort: 0 })
    expect(b).toMatchObject({ projectId: p2, sort: 1 })
    expect(titles()).toEqual(['A', 'B'])
  })

  it('several stories in different projects of the same idea', () => {
    story('A', p1)
    story('B', p2)
    story('C', p1)
    expect(graph().nodes.map((n) => n.projectId)).toEqual([p1, p2, p1])
  })

  it('requires projectId', () => {
    expectPlanError(() => plan().createNode(ideaId, { kind: 'story', title: 'S' }), 'story_needs_project')
    expectPlanError(
      () => plan().createNode(ideaId, { kind: 'story', title: 'S', projectId: null }),
      'story_needs_project'
    )
  })

  it('rejects a project not linked to the idea (existing or not)', () => {
    expectPlanError(() => story('S', p3), 'project_not_linked', /Mobile/)
    expectPlanError(() => story('S', 9999), 'project_not_linked')
  })

  it('rejects a parent', () => {
    const a = story('A')
    expectPlanError(
      () => plan().createNode(ideaId, { kind: 'story', title: 'S', projectId: p1, parentId: a.id }),
      'story_has_parent'
    )
  })

  it('inserts at a given index and renumbers siblings', () => {
    story('A')
    story('B')
    story('C', p1, { index: 1 })
    expect(graph().nodes.map((n) => [n.title, n.sort])).toEqual([
      ['A', 0],
      ['C', 1],
      ['B', 2]
    ])
  })
})

describe('createNode: tasks', () => {
  it('requires a parent', () => {
    expectPlanError(() => plan().createNode(ideaId, { kind: 'task', title: 'T' }), 'task_needs_parent')
    expectPlanError(() => plan().createNode(ideaId, { kind: 'task', title: 'T', parentId: null }), 'task_needs_parent')
  })

  it('goes under a story or under another task (any depth) and derives project/root/depth', () => {
    const s = story('S', p2)
    const t1 = task(s.id, 'T1')
    const t2 = task(t1.id, 'T2')
    const t3 = task(t2.id, 'T3')
    expect(t1).toMatchObject({ projectId: p2, rootStoryId: s.id, depth: 1 })
    expect(t3).toMatchObject({ projectId: p2, rootStoryId: s.id, depth: 3, parentId: t2.id })
    expect(titles()).toEqual(['S', 'T1', 'T2', 'T3'])
  })

  it('stores NULL project_id for tasks (derived, never divergent)', () => {
    const s = story('S')
    const t = task(s.id, 'T')
    const row = repos.db.prepare('SELECT project_id FROM plan_nodes WHERE id = ?').get(t.id) as { project_id: number | null }
    expect(row.project_id).toBeNull()
  })

  it('rejects an explicit project that differs from the story project; same one is accepted', () => {
    const s = story('S', p1)
    expectPlanError(() => task(s.id, 'T', { projectId: p2 }), 'task_project_derived')
    expect(task(s.id, 'T', { projectId: p1 }).projectId).toBe(p1)
  })

  it('rejects a missing parent and a parent from another idea', () => {
    expectPlanError(() => task('nope', 'T'), 'not_found')
    const other = repos.ideas.create({ title: 'Outra' })
    repos.ideas.linkProject(other.id, p1)
    const foreign = repos.plan.createNode(other.id, { kind: 'story', title: 'F', projectId: p1 })
    expectPlanError(() => task(foreign.id, 'T'), 'cross_idea')
  })

  it('appends children in order and supports index', () => {
    const s = story('S')
    task(s.id, 'A')
    task(s.id, 'B')
    task(s.id, 'C', { index: 0 })
    expect(titles()).toEqual(['S', 'C', 'A', 'B'])
  })
})

describe('titles and descriptions', () => {
  it('trims, requires and caps the title; description is optional markdown', () => {
    const s = story('  Minha story  ', p1, { description: '  **negrito**  ' })
    expect(s.title).toBe('Minha story')
    expect(s.description).toBe('**negrito**')
    expect(story('S2').description).toBe('')
    expectPlanError(() => story('   '), 'invalid_title')
    expectPlanError(() => story('x'.repeat(256)), 'invalid_title')
    expect(story('x'.repeat(255)).title).toHaveLength(255)
    expectPlanError(() => plan().createNode(ideaId, { kind: 'story', title: 42 as never, projectId: p1 }), 'invalid_title')
  })

  it('rejects unknown ideas and kinds', () => {
    expectPlanError(() => plan().getGraph(9999), 'not_found')
    expectPlanError(
      () => plan().createNode(ideaId, { kind: 'epic' as never, title: 'E', projectId: p1 }),
      'invalid_input'
    )
  })
})

describe('updateNode', () => {
  it('edits title/description and bumps updatedAt only when they change', () => {
    const s = story('S')
    const t0 = s.updatedAt
    const same = plan().updateNode(ideaId, s.id, { title: 'S', description: '' })
    expect(same.updatedAt).toBe(t0)
    const edited = plan().updateNode(ideaId, s.id, { title: 'S2' })
    expect(edited.title).toBe('S2')
    expect(edited.updatedAt).toBeGreaterThan(t0)
    expectPlanError(() => plan().updateNode(ideaId, s.id, { title: ' ' }), 'invalid_title')
  })

  it('moving by sort does not touch updatedAt (not a DevOps-visible edit)', () => {
    const a = story('A')
    story('B')
    const moved = plan().updateNode(ideaId, a.id, { sort: 1 })
    expect(titles()).toEqual(['B', 'A'])
    expect(moved.updatedAt).toBe(a.updatedAt)
    expect(moved.sort).toBe(1)
  })

  it('sort clamps to the sibling range', () => {
    const s = story('S')
    task(s.id, 'A')
    const b = task(s.id, 'B')
    plan().updateNode(ideaId, b.id, { sort: 99 })
    expect(titles()).toEqual(['S', 'A', 'B'])
    plan().updateNode(ideaId, b.id, { sort: 0 })
    expect(titles()).toEqual(['S', 'B', 'A'])
    expectPlanError(() => plan().updateNode(ideaId, b.id, { sort: -1 }), 'invalid_input')
  })

  it('a story can change project (linked only); its tasks follow', () => {
    const s = story('S', p1)
    const t = task(s.id, 'T')
    plan().updateNode(ideaId, s.id, { projectId: p2 })
    expect(plan().getNode(ideaId, t.id).projectId).toBe(p2)
    expectPlanError(() => plan().updateNode(ideaId, s.id, { projectId: p3 }), 'project_not_linked')
  })

  it('a task cannot hold a project', () => {
    const s = story('S')
    const t = task(s.id, 'T')
    expectPlanError(() => plan().updateNode(ideaId, t.id, { projectId: p2 }), 'task_project_derived')
  })

  it('rejects nodes of another idea', () => {
    const s = story('S')
    const other = repos.ideas.create({ title: 'Outra' })
    expectPlanError(() => plan().updateNode(other.id, s.id, { title: 'hack' }), 'cross_idea')
  })
})

describe('setParent', () => {
  it('moves a task to another story; project follows the new root', () => {
    const s1 = story('S1', p1)
    const s2 = story('S2', p2)
    const t = task(s1.id, 'T')
    const moved = plan().setParent(ideaId, t.id, s2.id)
    expect(moved).toMatchObject({ parentId: s2.id, projectId: p2, rootStoryId: s2.id })
  })

  it('moves a whole branch under another task', () => {
    const s = story('S')
    const a = task(s.id, 'A')
    const b = task(s.id, 'B')
    const a1 = task(a.id, 'A1')
    plan().setParent(ideaId, a.id, b.id)
    const g = graph()
    expect(byTitle(g, 'A')).toMatchObject({ parentId: b.id, depth: 2 })
    expect(byTitle(g, 'A1')).toMatchObject({ parentId: a.id, depth: 3, id: a1.id })
    expect(titles(g)).toEqual(['S', 'B', 'A', 'A1'])
  })

  it('rejects moving a node under itself or any of its descendants', () => {
    const s = story('S')
    const a = task(s.id, 'A')
    const b = task(a.id, 'B')
    const c = task(b.id, 'C')
    expectPlanError(() => plan().setParent(ideaId, a.id, a.id), 'hierarchy_cycle')
    expectPlanError(() => plan().setParent(ideaId, a.id, b.id), 'hierarchy_cycle')
    expectPlanError(() => plan().setParent(ideaId, a.id, c.id), 'hierarchy_cycle', /ciclo/)
    expect(byTitle(graph(), 'A').parentId).toBe(s.id) // untouched
  })

  it('stories cannot get a parent; tasks cannot become roots', () => {
    const s1 = story('S1')
    const s2 = story('S2')
    const t = task(s1.id, 'T')
    expectPlanError(() => plan().setParent(ideaId, s1.id, s2.id), 'story_has_parent')
    expectPlanError(() => plan().setParent(ideaId, s1.id, t.id), 'story_has_parent')
    expectPlanError(() => plan().setParent(ideaId, t.id, null), 'task_needs_parent')
  })

  it('a story can be reordered with parent null', () => {
    story('A')
    const b = story('B')
    plan().setParent(ideaId, b.id, null, 0)
    expect(titles()).toEqual(['B', 'A'])
  })

  it('honours index and compacts the old siblings', () => {
    const s1 = story('S1')
    const s2 = story('S2')
    task(s2.id, 'X')
    const a = task(s1.id, 'A')
    task(s1.id, 'B')
    plan().setParent(ideaId, a.id, s2.id, 0)
    const g = graph()
    expect(titles(g)).toEqual(['S1', 'B', 'S2', 'A', 'X'])
    expect(byTitle(g, 'B').sort).toBe(0) // old siblings renumbered
    expect(byTitle(g, 'X').sort).toBe(1)
  })

  it('rejects a parent from another idea or unknown', () => {
    const s = story('S')
    const t = task(s.id, 'T')
    const other = repos.ideas.create({ title: 'Outra' })
    repos.ideas.linkProject(other.id, p1)
    const foreign = repos.plan.createNode(other.id, { kind: 'story', title: 'F', projectId: p1 })
    expectPlanError(() => plan().setParent(ideaId, t.id, foreign.id), 'cross_idea')
    expectPlanError(() => plan().setParent(ideaId, t.id, 'ghost'), 'not_found')
  })
})

describe('reorder', () => {
  it('sets sibling order from a full list', () => {
    const s = story('S')
    const a = task(s.id, 'A')
    const b = task(s.id, 'B')
    const c = task(s.id, 'C')
    plan().reorder(ideaId, s.id, [c.id, a.id, b.id])
    expect(titles()).toEqual(['S', 'C', 'A', 'B'])
  })

  it('reorders stories with parent null', () => {
    const a = story('A')
    const b = story('B')
    plan().reorder(ideaId, null, [b.id, a.id])
    expect(titles()).toEqual(['B', 'A'])
  })

  it('requires exactly the current siblings', () => {
    const s = story('S')
    const a = task(s.id, 'A')
    const b = task(s.id, 'B')
    expectPlanError(() => plan().reorder(ideaId, s.id, [a.id]), 'invalid_input')
    expectPlanError(() => plan().reorder(ideaId, s.id, [a.id, a.id]), 'invalid_input')
    expectPlanError(() => plan().reorder(ideaId, s.id, [a.id, b.id, 'x']), 'invalid_input')
    expectPlanError(() => plan().reorder(ideaId, null, [a.id, b.id]), 'invalid_input') // not stories
  })
})

describe('dependencies', () => {
  it('adds "from depende de to", across stories and projects', () => {
    const a = story('A', p1)
    const b = story('B', p2)
    const t = task(a.id, 'T')
    expect(plan().addDep(ideaId, a.id, b.id)).toEqual({ fromId: a.id, toId: b.id }) // story -> story, cross-project
    plan().addDep(ideaId, t.id, b.id) // task -> other story
    expect(graph().deps).toEqual([
      { fromId: a.id, toId: b.id },
      { fromId: t.id, toId: b.id }
    ])
  })

  it('rejects self-dependency and duplicates', () => {
    const a = story('A')
    const b = story('B')
    expectPlanError(() => plan().addDep(ideaId, a.id, a.id), 'dep_self')
    plan().addDep(ideaId, a.id, b.id)
    expectPlanError(() => plan().addDep(ideaId, a.id, b.id), 'dep_duplicate')
  })

  it('rejects direct and transitive cycles with the cycle in the message', () => {
    const a = story('A')
    const b = story('B')
    const c = story('C', p2)
    plan().addDep(ideaId, a.id, b.id)
    plan().addDep(ideaId, b.id, c.id)
    expectPlanError(() => plan().addDep(ideaId, b.id, a.id), 'dep_cycle', /"B" → "A" → "B"/)
    expectPlanError(() => plan().addDep(ideaId, c.id, a.id), 'dep_cycle', /"C" → "A" → "B" → "C"/)
    expect(graph().deps).toHaveLength(2)
    // a non-cyclic shortcut is fine
    plan().addDep(ideaId, a.id, c.id)
  })

  it('rejects nodes of another idea', () => {
    const a = story('A')
    const other = repos.ideas.create({ title: 'Outra' })
    repos.ideas.linkProject(other.id, p1)
    const f = repos.plan.createNode(other.id, { kind: 'story', title: 'F', projectId: p1 })
    expectPlanError(() => plan().addDep(ideaId, a.id, f.id), 'cross_idea')
    expectPlanError(() => plan().addDep(ideaId, a.id, 'ghost'), 'not_found')
  })

  it('removeDep is idempotent and reports whether something was removed', () => {
    const a = story('A')
    const b = story('B')
    plan().addDep(ideaId, a.id, b.id)
    expect(plan().removeDep(ideaId, a.id, b.id)).toBe(true)
    expect(plan().removeDep(ideaId, a.id, b.id)).toBe(false)
    expect(graph().deps).toEqual([])
    plan().addDep(ideaId, b.id, a.id) // allowed again once the opposite one is gone
  })
})

describe('deleteNode', () => {
  it('deletes the whole subtree and every dependency touching a deleted node', () => {
    const s1 = story('S1')
    const s2 = story('S2', p2)
    const a = task(s1.id, 'A')
    const a1 = task(a.id, 'A1')
    const a2 = task(a1.id, 'A2')
    const b = task(s1.id, 'B')
    const x = task(s2.id, 'X')
    plan().addDep(ideaId, x.id, a2.id) // incoming to deleted subtree
    plan().addDep(ideaId, a1.id, x.id) // outgoing from deleted subtree
    plan().addDep(ideaId, b.id, x.id) // unrelated, must survive
    const res = plan().deleteNode(ideaId, a.id)
    expect(res.deletedIds).toEqual([a.id, a1.id, a2.id])
    expect(res.ticketed).toEqual([])
    expect(titles()).toEqual(['S1', 'B', 'S2', 'X'])
    expect(graph().deps).toEqual([{ fromId: b.id, toId: x.id }])
    expect(repos.db.prepare('SELECT COUNT(*) c FROM plan_deps').get()).toEqual({ c: 1 })
  })

  it('deleting a story removes everything under it and compacts the other stories', () => {
    const s1 = story('S1')
    story('S2')
    task(s1.id, 'T')
    plan().deleteNode(ideaId, s1.id)
    expect(graph().nodes.map((n) => [n.title, n.sort])).toEqual([['S2', 0]])
  })

  it('guards ticketed nodes unless forced', () => {
    const s = story('S')
    const t = task(s.id, 'T')
    plan().setDevops(ideaId, t.id, { devopsId: 123, devopsUrl: 'https://x/123', sentUpdatedAt: 5 })
    expectPlanError(() => plan().deleteNode(ideaId, s.id), 'ticketed_nodes', /#123 "T"/)
    expect(titles()).toEqual(['S', 'T'])
    const res = plan().deleteNode(ideaId, s.id, true)
    expect(res.ticketed).toEqual([{ id: t.id, title: 'T', devopsId: 123 }])
    expect(graph().nodes).toEqual([])
  })

  it('rejects nodes of another idea / unknown nodes', () => {
    const s = story('S')
    const other = repos.ideas.create({ title: 'Outra' })
    expectPlanError(() => plan().deleteNode(other.id, s.id), 'cross_idea')
    expectPlanError(() => plan().deleteNode(ideaId, 'ghost'), 'not_found')
  })
})

describe('project guard (unlink / delete)', () => {
  it('rejects unlinking a project while stories use it, listing them', () => {
    story('Login', p1)
    story('Tela', p2)
    story('Logout', p1)
    expectPlanError(() => repos.ideas.unlinkProject(ideaId, p1), 'project_in_use', /"Login", "Logout"/)
    expect(repos.ideas.get(ideaId).projects.map((p) => p.projectId)).toContain(p1)
  })

  it('allows unlinking once the stories moved to another project or were deleted', () => {
    const a = story('A', p1)
    const b = story('B', p1)
    plan().updateNode(ideaId, a.id, { projectId: p2 })
    expectPlanError(() => repos.ideas.unlinkProject(ideaId, p1), 'project_in_use', /"B"/)
    plan().deleteNode(ideaId, b.id)
    const idea = repos.ideas.unlinkProject(ideaId, p1)
    expect(idea.projects.map((p) => p.projectId)).toEqual([p2])
  })

  it('tasks alone do not block (only stories hold a project)', () => {
    const s = story('S', p2)
    task(s.id, 'T')
    repos.ideas.unlinkProject(ideaId, p1) // p1 unused by any story
    expect(repos.ideas.get(ideaId).projects).toHaveLength(1)
  })

  it('a project used by another idea does not block this idea unlinking it', () => {
    const other = repos.ideas.create({ title: 'Outra' })
    repos.ideas.linkProject(other.id, p1)
    repos.plan.createNode(other.id, { kind: 'story', title: 'F', projectId: p1 })
    repos.ideas.unlinkProject(ideaId, p1)
  })

  it('deleting a project used by stories is rejected, naming idea and story', () => {
    story('Login', p1)
    expectPlanError(() => repos.projects.delete(p1), 'project_in_use', /"Login" em "Ideia"/)
    expect(repos.projects.list().map((p) => p.id)).toContain(p1)
    repos.projects.delete(p3) // unused project: fine
  })
})

describe('idea deletion', () => {
  it('cascades nodes and deps', () => {
    const a = story('A')
    const b = story('B', p2)
    const t = task(a.id, 'T')
    plan().addDep(ideaId, t.id, b.id)
    repos.ideas.delete(ideaId)
    expect(repos.db.prepare('SELECT COUNT(*) c FROM plan_nodes').get()).toEqual({ c: 0 })
    expect(repos.db.prepare('SELECT COUNT(*) c FROM plan_deps').get()).toEqual({ c: 0 })
    // projects are untouched
    expect(repos.projects.list()).toHaveLength(3)
  })
})

describe('devops columns', () => {
  it('setDevops stores the link without bumping updatedAt; edits afterwards mark it stale', () => {
    const s = story('S')
    const linked = plan().setDevops(ideaId, s.id, {
      devopsId: 77,
      devopsUrl: 'https://dev.azure.com/o/p/_workitems/edit/77',
      sentUpdatedAt: s.updatedAt
    })
    expect(linked).toMatchObject({ devopsId: 77, devopsSyncedAt: s.updatedAt, updatedAt: s.updatedAt })
    expect(linked.devopsStale).toBe(false)
    plan().updateNode(ideaId, s.id, { title: 'Novo título' })
    expect(plan().getNode(ideaId, s.id).devopsStale).toBe(true)
    // Re-sending the fresh snapshot clears it.
    plan().setDevops(ideaId, s.id, { devopsId: 77, devopsUrl: null, sentUpdatedAt: plan().getNode(ideaId, s.id).updatedAt })
    expect(plan().getNode(ideaId, s.id).devopsStale).toBe(false)
    plan().setDevops(ideaId, s.id, { devopsId: null, devopsUrl: null, sentUpdatedAt: null })
    expect(plan().getNode(ideaId, s.id).devopsStale).toBe(false)
  })

  it('Fase 5 sync rule: an edit made while the request was in flight is still stale', () => {
    const s = story('S')
    const snapshot = plan().getNode(ideaId, s.id) // read before the request
    plan().updateNode(ideaId, s.id, { description: 'editado durante o envio' }) // user edits meanwhile
    const linked = plan().setDevops(ideaId, s.id, { devopsId: 5, devopsUrl: null, sentUpdatedAt: snapshot.updatedAt })
    expect(linked.devopsSyncedAt).toBe(snapshot.updatedAt)
    expect(linked.devopsStale).toBe(true)
  })

  it('rejects a snapshot newer than the node (not a real snapshot) and invalid values', () => {
    const s = story('S')
    expectPlanError(
      () => plan().setDevops(ideaId, s.id, { devopsId: 1, devopsUrl: null, sentUpdatedAt: s.updatedAt + 1 }),
      'invalid_input',
      /mais nova/
    )
    expectPlanError(
      () => plan().setDevops(ideaId, s.id, { devopsId: 'x' as never, devopsUrl: null, sentUpdatedAt: null }),
      'invalid_input'
    )
  })

  it('depLinks / setDepLinked track the DevOps relation per dependency (idempotent linking)', () => {
    const a = story('A')
    const b = story('B', p2)
    const c = story('C')
    plan().addDep(ideaId, a.id, b.id)
    plan().addDep(ideaId, c.id, b.id)
    expect(plan().depLinks(ideaId)).toEqual([
      { fromId: a.id, toId: b.id, devopsLinkedAt: null },
      { fromId: c.id, toId: b.id, devopsLinkedAt: null }
    ])
    expect(plan().setDepLinked(ideaId, a.id, b.id, 777)).toBe(true)
    expect(plan().setDepLinked(ideaId, a.id, c.id, 1)).toBe(false) // no such dependency
    expect(plan().depLinks(ideaId).map((d) => d.devopsLinkedAt)).toEqual([777, null])
    // The plain graph is unchanged (PlanDep stays { fromId, toId }).
    expect(graph().deps[0]).toEqual({ fromId: a.id, toId: b.id })
    // Removing and re-adding resets the state (a new relation has to be created).
    plan().removeDep(ideaId, a.id, b.id)
    plan().addDep(ideaId, a.id, b.id)
    expect(plan().depLinks(ideaId).find((d) => d.fromId === a.id)?.devopsLinkedAt).toBeNull()
  })

  it('replaceAll keeps the link state of dependencies that survive', () => {
    const a = story('A')
    const b = story('B', p2)
    plan().addDep(ideaId, a.id, b.id)
    plan().setDepLinked(ideaId, a.id, b.id, 123)
    plan().replaceAll(ideaId, {
      stories: [
        { id: a.id, title: 'A', projectId: p1 },
        { id: b.id, title: 'B', projectId: p2 },
        { tempId: 'n', title: 'N', projectId: p1 }
      ],
      deps: [
        { from: a.id, to: b.id },
        { from: 'n', to: a.id }
      ]
    })
    const links = plan().depLinks(ideaId)
    expect(links.find((d) => d.fromId === a.id)?.devopsLinkedAt).toBe(123)
    expect(links.find((d) => d.toId === a.id)?.devopsLinkedAt).toBeNull()
  })

  it('migration v5 adds the column to a v4 database', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(
      db,
      migrations.filter((m) => m.version <= 4)
    )
    expect(runMigrations(db)).toEqual([5])
    expect(db.prepare('SELECT devops_linked_at FROM plan_deps').all()).toEqual([])
  })
})

describe('overview', () => {
  it('returns the graph plus linked projects (primary first)', () => {
    story('S')
    const ov = plan().getOverview(ideaId)
    expect(ov.graph.nodes).toHaveLength(1)
    expect(ov.projects.map((p) => [p.name, p.isPrimary])).toEqual([
      ['API', true],
      ['Web', false]
    ])
    expect(ov.projects[0].folderPath).toBe('C:/api')
  })
})

// ---------------------------------------------------------------------------------------------
describe('replaceAll', () => {
  const spec = (): { stories: PlanSpecNode[]; deps: { from: string; to: string }[] } => ({
    stories: [
      {
        tempId: 's1',
        title: 'Backend',
        description: 'API nova',
        projectId: p1,
        children: [
          { tempId: 't1', title: 'Endpoint', children: [{ tempId: 't1a', title: 'Teste do endpoint' }] },
          { tempId: 't2', title: 'Migration' }
        ]
      },
      { tempId: 's2', title: 'Frontend', projectId: p2, children: [{ tempId: 't3', title: 'Tela' }] }
    ],
    deps: [
      { from: 's2', to: 's1' },
      { from: 't3', to: 't1' }
    ]
  })

  it('builds the whole graph from a nested spec and returns the tempId -> id map', () => {
    const res = plan().replaceAll(ideaId, spec())
    expect(res).toMatchObject({ created: 6, updated: 0, deleted: 0, deletedIds: [] })
    expect(Object.keys(res.idMap).sort()).toEqual(['s1', 's2', 't1', 't1a', 't2', 't3'])
    const g = graph()
    expect(titles(g)).toEqual(['Backend', 'Endpoint', 'Teste do endpoint', 'Migration', 'Frontend', 'Tela'])
    expect(byTitle(g, 'Tela')).toMatchObject({ projectId: p2, depth: 1, rootStoryId: res.idMap.s2, id: res.idMap.t3 })
    expect(byTitle(g, 'Teste do endpoint')).toMatchObject({ depth: 2, parentId: res.idMap.t1 })
    expect(byTitle(g, 'Backend')).toMatchObject({ description: 'API nova', sort: 0 })
    expect(byTitle(g, 'Frontend').sort).toBe(1)
    expect(g.deps).toEqual([
      { fromId: res.idMap.s2, toId: res.idMap.s1 },
      { fromId: res.idMap.t3, toId: res.idMap.t1 }
    ])
  })

  it('replaces an existing (non-ticketed) graph completely', () => {
    const old = story('Velha')
    const oldT = task(old.id, 'Velha T')
    plan().addDep(ideaId, oldT.id, old.id)
    const res = plan().replaceAll(ideaId, spec())
    expect(res.deleted).toBe(2)
    expect(res.deletedIds.sort()).toEqual([old.id, oldT.id].sort())
    expect(titles()).not.toContain('Velha')
    expect(graph().deps).toHaveLength(2)
    expect(repos.db.prepare('SELECT COUNT(*) c FROM plan_deps').get()).toEqual({ c: 2 })
  })

  it('an empty spec clears the plan', () => {
    story('A')
    const res = plan().replaceAll(ideaId, { stories: [] })
    expect(res.deleted).toBe(1)
    expect(graph().nodes).toEqual([])
  })

  it('dependencies across stories/projects are fine; duplicate deps collapse', () => {
    const s = spec()
    s.deps.push({ from: 's2', to: 's1' })
    const res = plan().replaceAll(ideaId, s)
    expect(graph().deps).toHaveLength(2)
    expect(res.created).toBe(6)
  })

  it('rolls back everything when the spec is invalid (nothing changes)', () => {
    const keep = story('Fica')
    task(keep.id, 'Fica T')
    const before = JSON.stringify(graph())
    const bad: { stories: PlanSpecNode[] }[] = [
      { stories: [{ title: 'Ok', projectId: p1, children: [{ title: ' ' }] }] }, // empty title deep inside
      { stories: [{ title: 'Ok', projectId: p3 }] }, // project not linked
      { stories: [{ title: 'Ok' }] }, // story without project
      { stories: [{ title: 'Ok', projectId: p1 }, { title: 'Ok2', projectId: p1, children: [{ title: 'x', projectId: p2 }] }] }, // task project diverges
      { stories: [{ tempId: 'a', title: 'A', projectId: p1 }, { tempId: 'a', title: 'B', projectId: p1 }] }, // dup tempId
      { stories: 'nope' as never }
    ]
    for (const b of bad) {
      expect(() => plan().replaceAll(ideaId, b)).toThrow(PlanError)
      expect(JSON.stringify(graph())).toBe(before)
    }
  })

  it('rejects dependency problems: unknown ref, self, cycle', () => {
    const base = (deps: { from: string; to: string }[]) => ({
      stories: [
        { tempId: 'a', title: 'A', projectId: p1 },
        { tempId: 'b', title: 'B', projectId: p2 },
        { tempId: 'c', title: 'C', projectId: p2 }
      ],
      deps
    })
    story('Existente')
    expectPlanError(() => plan().replaceAll(ideaId, base([{ from: 'a', to: 'zzz' }])), 'spec_invalid', /zzz/)
    expectPlanError(() => plan().replaceAll(ideaId, base([{ from: 'a', to: 'a' }])), 'dep_self')
    expectPlanError(
      () =>
        plan().replaceAll(
          ideaId,
          base([
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c' },
            { from: 'c', to: 'a' }
          ])
        ),
      'dep_cycle',
      /"A" → "B" → "C" → "A"|"B" → "C" → "A" → "B"|"C" → "A" → "B" → "C"/
    )
    expect(titles()).toEqual(['Existente'])
  })

  it('is atomic even when a failure happens mid-apply (after some rows were written)', () => {
    const keep = story('Fica')
    task(keep.id, 'Fica T')
    const before = JSON.stringify(graph())
    let n = 0
    const flaky = new PlanRepository(repos.db, () => ++clock, () => {
      // The 4th new node reuses an id: PK violation after 3 rows were already inserted.
      return `n-${n++ === 3 ? 1 : n}`
    })
    expect(() => flaky.replaceAll(ideaId, spec())).toThrow(/UNIQUE|constraint/i)
    expect(JSON.stringify(graph())).toBe(before)
    expect(repos.db.prepare('SELECT COUNT(*) c FROM plan_nodes').get()).toEqual({ c: 2 })
  })

  describe('nodes with a DevOps ticket', () => {
    let story1: PlanNode
    let taskA: PlanNode
    let taskB: PlanNode
    beforeEach(() => {
      story1 = story('S1', p1)
      taskA = task(story1.id, 'A')
      taskB = task(story1.id, 'B')
      plan().setDevops(ideaId, story1.id, { devopsId: 10, devopsUrl: 'https://d/10', sentUpdatedAt: story1.updatedAt })
      plan().setDevops(ideaId, taskA.id, { devopsId: 11, devopsUrl: 'https://d/11', sentUpdatedAt: taskA.updatedAt })
    })

    it('rejects (ticketed_nodes) when the spec would drop ticketed nodes; nothing changes', () => {
      const before = JSON.stringify(graph())
      expectPlanError(
        () => plan().replaceAll(ideaId, { stories: [{ title: 'Nova', projectId: p1 }] }),
        'ticketed_nodes',
        /#10 "S1".*#11 "A"/
      )
      expect(JSON.stringify(graph())).toBe(before)
    })

    it('keeps ticketed nodes referenced by id (same uuid, devops fields intact), even re-parented/retitled', () => {
      clock = 200_000 // edits below happen after the sync
      const res = plan().replaceAll(ideaId, {
        stories: [
          {
            id: story1.id,
            title: 'S1',
            projectId: p1,
            children: [{ id: taskA.id, tempId: 'a', title: 'A renomeada', children: [{ tempId: 'n', title: 'Nova' }] }]
          },
          { tempId: 's2', title: 'Outra', projectId: p2 }
        ],
        deps: [{ from: 's2', to: taskA.id }, { from: 'n', to: 'a' }]
      })
      expect(res).toMatchObject({ created: 2, updated: 2, deleted: 1, deletedIds: [taskB.id] })
      expect(res.idMap).toMatchObject({ [story1.id]: story1.id, [taskA.id]: taskA.id, a: taskA.id })
      const g = graph()
      expect(titles(g)).toEqual(['S1', 'A renomeada', 'Nova', 'Outra'])
      const a = byTitle(g, 'A renomeada')
      expect(a).toMatchObject({ id: taskA.id, devopsId: 11, devopsUrl: 'https://d/11', devopsSyncedAt: taskA.updatedAt, devopsStale: true })
      expect(byTitle(g, 'S1')).toMatchObject({ id: story1.id, devopsId: 10, devopsStale: false, createdAt: story1.createdAt })
      expect(g.deps).toHaveLength(2)
    })

    it('unchanged kept nodes are not marked stale (updatedAt untouched)', () => {
      plan().replaceAll(ideaId, {
        stories: [{ id: story1.id, title: 'S1', projectId: p1, children: [{ id: taskA.id, title: 'A' }] }]
      }, { force: true })
      expect(plan().getNode(ideaId, taskA.id)).toMatchObject({ devopsStale: false, updatedAt: taskA.updatedAt })
    })

    it('a kept node can move to another parent in the spec (also across stories/projects)', () => {
      plan().replaceAll(ideaId, {
        stories: [
          { id: story1.id, title: 'S1', projectId: p1 },
          { tempId: 'x', title: 'X', projectId: p2, children: [{ id: taskA.id, title: 'A' }] }
        ]
      }, { force: true })
      expect(plan().getNode(ideaId, taskA.id)).toMatchObject({ projectId: p2, depth: 1 })
    })

    it('force discards ticketed nodes that are not in the spec', () => {
      const res = plan().replaceAll(ideaId, { stories: [{ title: 'Nova', projectId: p1 }] }, { force: true })
      expect(res.deleted).toBe(3)
      expect(titles()).toEqual(['Nova'])
    })

    it('validates ids: unknown, other idea, repeated, wrong kind', () => {
      const other = repos.ideas.create({ title: 'Outra' })
      repos.ideas.linkProject(other.id, p1)
      const foreign = repos.plan.createNode(other.id, { kind: 'story', title: 'F', projectId: p1 })
      const sp = (children: PlanSpecNode[], top: Partial<PlanSpecNode> = {}) => ({
        stories: [{ title: 'S', projectId: p1, ...top, children }]
      })
      expectPlanError(() => plan().replaceAll(ideaId, sp([{ id: 'ghost', title: 'x' }])), 'spec_invalid', /ghost/)
      expectPlanError(() => plan().replaceAll(ideaId, sp([{ id: foreign.id, title: 'x' }])), 'spec_invalid')
      expectPlanError(
        () => plan().replaceAll(ideaId, sp([{ id: taskA.id, title: 'x' }, { id: taskA.id, title: 'y' }])),
        'spec_invalid',
        /mais de uma vez/
      )
      // task id used as a top-level story / story id used as a task
      expectPlanError(
        () => plan().replaceAll(ideaId, { stories: [{ id: taskA.id, title: 'x', projectId: p1 }] }, { force: true }),
        'spec_invalid',
        /não pode virar story/
      )
      expectPlanError(
        () => plan().replaceAll(ideaId, sp([{ id: story1.id, title: 'x' }]), { force: true }),
        'spec_invalid',
        /não pode virar task/
      )
    })
  })
})

describe('mergeAdd', () => {
  it('adds tasks under a story/task without deleting anything, appended last', () => {
    const s = story('S')
    const a = task(s.id, 'A')
    const res = plan().mergeAdd(
      ideaId,
      { nodes: [{ tempId: 'n1', title: 'N1', children: [{ tempId: 'n2', title: 'N2' }] }, { title: 'N3' }] },
      s.id
    )
    expect(res).toMatchObject({ created: 3, updated: 0, deleted: 0 })
    expect(Object.keys(res.idMap).sort()).toEqual(['n1', 'n2'])
    expect(titles()).toEqual(['S', 'A', 'N1', 'N2', 'N3'])
    expect(plan().getNode(ideaId, res.idMap.n2)).toMatchObject({ depth: 2, rootStoryId: s.id, projectId: p1 })

    plan().mergeAdd(ideaId, { nodes: [{ title: 'Sob A' }] }, a.id)
    expect(byTitle(graph(), 'Sob A')).toMatchObject({ parentId: a.id, depth: 2 })
  })

  it('without a parent adds new stories (need a linked project)', () => {
    story('Existente')
    const res = plan().mergeAdd(ideaId, {
      nodes: [{ tempId: 'x', title: 'Nova', projectId: p2, children: [{ title: 'Filha' }] }]
    })
    expect(titles()).toEqual(['Existente', 'Nova', 'Filha'])
    expect(plan().getNode(ideaId, res.idMap.x)).toMatchObject({ sort: 1, projectId: p2 })
    expectPlanError(() => plan().mergeAdd(ideaId, { nodes: [{ title: 'Sem projeto' }] }), 'story_needs_project')
    expectPlanError(() => plan().mergeAdd(ideaId, { nodes: [{ title: 'X', projectId: p3 }] }), 'project_not_linked')
  })

  it('task project must match the parent project', () => {
    const s = story('S', p1)
    expectPlanError(() => plan().mergeAdd(ideaId, { nodes: [{ title: 'T', projectId: p2 }] }, s.id), 'task_project_derived')
    plan().mergeAdd(ideaId, { nodes: [{ title: 'T', projectId: p1 }] }, s.id)
  })

  it('deps may point to new tempIds and to existing nodes; cycles (incl. through existing deps) are rejected', () => {
    const s1 = story('S1')
    const s2 = story('S2', p2)
    plan().addDep(ideaId, s1.id, s2.id) // S1 depends on S2
    // N depends on S2 (its own parent) and S1 depends on N: S1 -> N -> S2 and S1 -> S2, acyclic.
    const ok = plan().mergeAdd(
      ideaId,
      { nodes: [{ tempId: 'n', title: 'N' }], deps: [{ from: 'n', to: s2.id }, { from: s1.id, to: 'n' }] },
      s2.id
    )
    expect(ok.created).toBe(1)
    expect(graph().deps).toContainEqual({ fromId: s1.id, toId: ok.idMap.n })
    expect(graph().deps).toContainEqual({ fromId: ok.idMap.n, toId: s2.id })
  })

  it('rejects a cycle that closes through existing dependencies; nothing is added', () => {
    const s1 = story('S1')
    const s2 = story('S2', p2)
    plan().addDep(ideaId, s1.id, s2.id)
    const before = JSON.stringify(graph())
    expectPlanError(
      () =>
        plan().mergeAdd(
          ideaId,
          { nodes: [{ tempId: 'n', title: 'N' }], deps: [{ from: 's2x', to: 'n' }] },
          s2.id
        ),
      'spec_invalid'
    )
    expectPlanError(
      () =>
        plan().mergeAdd(
          ideaId,
          { nodes: [{ tempId: 'n', title: 'N' }], deps: [{ from: 'n', to: s1.id }, { from: s2.id, to: 'n' }] },
          s2.id
        ),
      'dep_cycle'
    )
    expect(JSON.stringify(graph())).toBe(before)
  })

  it('rejects "id", bad parents, tempId clashes with existing ids', () => {
    const s = story('S')
    expectPlanError(() => plan().mergeAdd(ideaId, { nodes: [{ id: s.id, title: 'X' }] }, s.id), 'spec_invalid', /"id"/)
    expectPlanError(() => plan().mergeAdd(ideaId, { nodes: [{ title: 'X' }] }, 'ghost'), 'not_found')
    expectPlanError(() => plan().mergeAdd(ideaId, { nodes: [{ tempId: s.id, title: 'X' }] }, s.id), 'spec_invalid')
    expect(titles()).toEqual(['S'])
  })
})

describe('review fixes: replaceAll without stories (M2)', () => {
  it('a spec without a stories list is rejected and nothing is deleted', () => {
    const s = story('S')
    task(s.id, 'T')
    const before = JSON.stringify(graph())
    for (const bad of [{}, { deps: [] }, { stories: null }, { stories: 'x' }, { stories: {} }, null, [] as never]) {
      expectPlanError(() => plan().replaceAll(ideaId, bad as never), 'spec_invalid', /stories/)
    }
    expect(JSON.stringify(graph())).toBe(before)
  })

  it('an explicit empty list still clears the plan (and keeps ticketed protection)', () => {
    const s = story('S')
    const t = task(s.id, 'T')
    plan().setDevops(ideaId, t.id, { devopsId: 9, devopsUrl: null, sentUpdatedAt: t.updatedAt })
    expectPlanError(() => plan().replaceAll(ideaId, { stories: [] }), 'ticketed_nodes')
    expect(titles()).toEqual(['S', 'T'])
    expect(plan().replaceAll(ideaId, { stories: [] }, { force: true }).deleted).toBe(2)
    expect(graph().nodes).toEqual([])
  })

  it('mergeAdd requires a nodes list', () => {
    expectPlanError(() => plan().mergeAdd(ideaId, {} as never), 'spec_invalid', /nodes/)
  })
})

describe('review fixes: depth cap (L1)', () => {
  const chain = (n: number): PlanNode => {
    let cur: PlanNode = story('S0')
    for (let i = 1; i < n; i++) cur = task(cur.id, `N${i}`)
    return cur
  }

  it('createNode refuses to go past 50 levels (same cap as a spec)', () => {
    const deepest = chain(50) // levels 1..50 => depth 49
    expect(deepest.depth).toBe(49)
    expectPlanError(() => task(deepest.id, 'one too many'), 'invalid_input', /50 níveis/)
    expect(graph().nodes).toHaveLength(50)
  })

  it('setParent accounts for the height of the moved subtree', () => {
    const deepest = chain(48) // depth 47
    const other = story('Other', p2)
    const mid = task(other.id, 'Mid')
    task(mid.id, 'Leaf') // subtree height 1 (Mid + Leaf)
    // Mid under depth 47 => Mid depth 48, Leaf depth 49: allowed
    plan().setParent(ideaId, mid.id, deepest.id)
    expect(plan().getNode(ideaId, mid.id).depth).toBe(48)
    // one more level on top of the subtree would exceed the cap
    const lone = task(other.id, 'Lone')
    const leaf2 = graph().nodes.find((n) => n.title === 'Leaf') as PlanNode
    expectPlanError(() => plan().setParent(ideaId, lone.id, leaf2.id), 'invalid_input', /50 níveis/)
  })
})
