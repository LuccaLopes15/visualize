import { beforeEach, describe, expect, it } from 'vitest'
import { createRepositories, type Repositories } from '../db'
import { PlanError } from '@shared/plan'
import { PlanService } from './service'

let repos: Repositories
let plan: PlanService
let events: number[]
let ideaId: number
let projectId: number

beforeEach(() => {
  let clock = 1_000
  repos = createRepositories(':memory:', () => ++clock)
  events = []
  plan = new PlanService(repos.plan, (id) => events.push(id))
  projectId = repos.projects.create({ name: 'API', folderPath: 'C:/api' }).id
  ideaId = repos.ideas.create({ title: 'Ideia' }).id
  repos.ideas.linkProject(ideaId, projectId)
})

describe('PlanService', () => {
  it('notifies the idea id after every successful mutation', () => {
    const s = plan.createNode(ideaId, { kind: 'story', title: 'S', projectId })
    const t = plan.createNode(ideaId, { kind: 'task', title: 'T', parentId: s.id })
    plan.updateNode(ideaId, t.id, { title: 'T2' })
    const t2 = plan.createNode(ideaId, { kind: 'task', title: 'U', parentId: s.id })
    plan.setParent(ideaId, t2.id, t.id)
    plan.addDep(ideaId, s.id, t.id)
    expect(plan.removeDep(ideaId, s.id, t.id)).toBe(true)
    plan.reorder(ideaId, null, [s.id])
    plan.mergeAdd(ideaId, { nodes: [{ title: 'M' }] }, s.id)
    plan.replaceAll(ideaId, { stories: [{ title: 'Novo', projectId }] })
    plan.deleteNode(ideaId, plan.getGraph(ideaId).nodes[0].id)
    expect(events).toHaveLength(11)
    expect(new Set(events)).toEqual(new Set([ideaId]))
  })

  it('does not notify on reads, failures or no-op removals', () => {
    const s = plan.createNode(ideaId, { kind: 'story', title: 'S', projectId })
    events.length = 0
    plan.getGraph(ideaId)
    plan.overview(ideaId)
    plan.getNode(ideaId, s.id)
    expect(() => plan.createNode(ideaId, { kind: 'task', title: 'T' })).toThrow(PlanError)
    expect(() => plan.replaceAll(ideaId, { stories: [{ title: 'x' }] })).toThrow(PlanError)
    expect(plan.removeDep(ideaId, s.id, s.id)).toBe(false)
    expect(events).toEqual([])
  })

  it('works without a notify callback', () => {
    const quiet = new PlanService(repos.plan)
    expect(quiet.createNode(ideaId, { kind: 'story', title: 'S', projectId }).title).toBe('S')
  })

  it('is scoped to the idea: another idea cannot touch the node', () => {
    const s = plan.createNode(ideaId, { kind: 'story', title: 'S', projectId })
    const other = repos.ideas.create({ title: 'Outra' })
    expect(() => plan.updateNode(other.id, s.id, { title: 'x' })).toThrow(/outra ideia/)
    expect(() => plan.deleteNode(other.id, s.id)).toThrow(PlanError)
    expect(plan.getGraph(ideaId).nodes).toHaveLength(1)
  })

  it('PlanError carries a stable code and a pt-BR message', () => {
    try {
      plan.createNode(ideaId, { kind: 'story', title: 'S' })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(PlanError)
      expect((e as PlanError).code).toBe('story_needs_project')
      expect((e as PlanError).message).toMatch(/projeto/)
    }
  })

  it('setDevops (Fase 5 hook) notifies and keeps the plan readable', () => {
    const s = plan.createNode(ideaId, { kind: 'story', title: 'S', projectId })
    events.length = 0
    const n = plan.setDevops(ideaId, s.id, { devopsId: 5, devopsUrl: 'https://x', syncedAt: 1 })
    expect(n.devopsId).toBe(5)
    expect(events).toEqual([ideaId])
  })
})
