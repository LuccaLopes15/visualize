import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createRepositories, type Repositories } from '../db'
import { PlanService } from '../plan/service'
import { VisualizeMcpServer } from './server'
import { formatOverview, idLength, resolveNodeRef, ToolInputError } from './planFormat'

let repos: Repositories
let plan: PlanService
let server: VisualizeMcpServer
let events: number[]
let clients: Client[]
let ideaA: number
let ideaB: number
let apiId: number
let webId: number

beforeEach(async () => {
  let clock = 1_000
  repos = createRepositories(':memory:', () => ++clock)
  events = []
  plan = new PlanService(repos.plan, (id) => events.push(id))
  apiId = repos.projects.create({ name: 'API', folderPath: 'C:/api' }).id
  webId = repos.projects.create({ name: 'Web', folderPath: 'C:/web' }).id
  ideaA = repos.ideas.create({ title: 'Ideia A' }).id
  ideaB = repos.ideas.create({ title: 'Ideia B' }).id
  repos.ideas.linkProject(ideaA, apiId)
  repos.ideas.linkProject(ideaA, webId)
  repos.ideas.linkProject(ideaB, apiId)
  server = new VisualizeMcpServer({
    board: async () => ({ ok: true, text: '' }),
    macro: { read: async () => ({ markdown: '', updatedAt: 1 }), write: async () => ({ updatedAt: 1 }) },
    plan
  })
  await server.start()
  clients = []
})

afterEach(async () => {
  for (const c of clients) await c.close()
  await server.close()
})

async function connect(ideaId: number): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url()), {
      requestInit: { headers: { Authorization: `Bearer ${server.issueToken(ideaId)}` } }
    })
  )
  clients.push(client)
  return client
}

interface Res {
  isError: boolean
  text: string
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Res> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
  return { isError: !!r.isError, text: r.content.map((x) => x.text).join('\n') }
}

const short = (id: string): string => id.slice(0, 8)

/** Story + 2 tasks (T2 depends on T1) in idea A, built through the service. */
function seed(): { story: string; t1: string; t2: string } {
  const story = plan.createNode(ideaA, { kind: 'story', title: 'Login na API', projectId: apiId, description: 'Autenticação\ncom JWT' })
  const t1 = plan.createNode(ideaA, { kind: 'task', title: 'Criar endpoint', parentId: story.id, description: 'POST /login' })
  const t2 = plan.createNode(ideaA, { kind: 'task', title: 'Validar token', parentId: story.id })
  plan.addDep(ideaA, t2.id, t1.id)
  return { story: story.id, t1: t1.id, t2: t2.id }
}

describe('tasks_read', () => {
  it('reports an empty plan with the linked projects', async () => {
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_read')
    expect(r.isError).toBe(false)
    expect(r.text).toContain('id ' + apiId + ' · API · C:/api')
    expect(r.text).toContain('id ' + webId + ' · Web · C:/web')
    expect(r.text).toContain('vazio')
  })

  it('formats stories, tree, descriptions, deps and ticket status', async () => {
    const { story, t1, t2 } = seed()
    const sub = plan.createNode(ideaA, { kind: 'task', title: 'Escrever testes', parentId: t1 })
    plan.setDevops(ideaA, t1, { devopsId: 4321, devopsUrl: 'http://x', syncedAt: Date.now() + 10_000 })
    plan.setDevops(ideaA, t2, { devopsId: 4322, devopsUrl: 'http://y', syncedAt: null })
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_read')
    expect(r.text).toBe(
      [
        'Projetos vinculados à ideia (use o id em projectId ao criar stories):',
        `- id ${apiId} · API · C:/api (principal)`,
        `- id ${webId} · Web · C:/web`,
        '',
        'Plano de tarefas: 1 story, 3 tasks, 1 dependência. O id de cada nó fica entre colchetes; "depende de" lista os pré-requisitos.',
        '',
        `STORY [${short(story)}] Login na API · projeto: API (id ${apiId})`,
        '  > Autenticação com JWT',
        `  - TASK [${short(t1)}] Criar endpoint [ticket #4321]`,
        '      > POST /login',
        `    - TASK [${short(sub.id)}] Escrever testes`,
        `  - TASK [${short(t2)}] Validar token [ticket #4322, desatualizado] · depende de: ${short(t1)}`
      ].join('\n')
    )
  })

  it('reads one subtree with full descriptions and accepts short ids', async () => {
    const { story, t1 } = seed()
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_read', { nodeId: short(story) })
    expect(r.text).toContain('| Autenticação\n')
    expect(r.text).toContain('| com JWT')
    const sub = await call(c, 'tasks_read', { nodeId: short(t1) })
    expect(sub.text).toContain('Criar endpoint')
    expect(sub.text).not.toContain('Validar token')
    expect((await call(c, 'tasks_read', { nodeId: 'zzzzzzzz' })).isError).toBe(true)
  })
})

describe('tasks_replace_all', () => {
  it('builds the whole graph from a nested spec with deps by tempId', async () => {
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_replace_all', {
      stories: [
        {
          tempId: 's-api',
          title: 'API de login',
          projectId: apiId,
          children: [
            { tempId: 'api-1', title: 'Criar endpoint', description: 'POST /login', children: [{ title: 'Hash de senha' }] },
            { tempId: 'api-2', title: 'Validar token' }
          ]
        },
        { tempId: 's-web', title: 'Tela de login', projectId: webId, children: [{ tempId: 'web-1', title: 'Criar formulário' }] }
      ],
      deps: [
        { from: 'api-2', to: 'api-1' },
        { from: 'web-1', to: 'api-1' }
      ]
    })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('6 criado(s)')
    expect(r.text).toContain('api-1 → [')
    const g = plan.getGraph(ideaA)
    expect(g.nodes.map((n) => `${n.depth}:${n.title}:${n.projectId}`)).toEqual([
      `0:API de login:${apiId}`,
      `1:Criar endpoint:${apiId}`,
      `2:Hash de senha:${apiId}`,
      `1:Validar token:${apiId}`,
      `0:Tela de login:${webId}`,
      `1:Criar formulário:${webId}`
    ])
    expect(g.deps).toHaveLength(2)
    expect(events.length).toBeGreaterThan(0)
    expect(new Set(events)).toEqual(new Set([ideaA]))
  })

  it('replaces the previous graph when nothing is ticketed', async () => {
    seed()
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_replace_all', { stories: [{ title: 'Nova', projectId: webId }] })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('3 apagado(s)')
    expect(plan.getGraph(ideaA).nodes.map((n) => n.title)).toEqual(['Nova'])
  })

  it('refuses to delete ticketed nodes and explains how to fix it; nothing changes', async () => {
    const { story, t1 } = seed()
    plan.setDevops(ideaA, t1, { devopsId: 99, devopsUrl: 'u', syncedAt: 1 })
    const before = JSON.stringify(plan.getGraph(ideaA))
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_replace_all', { stories: [{ title: 'Outra', projectId: apiId }] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('ticket')
    expect(r.text).toContain('Como corrigir')
    expect(r.text).toContain('"id"')
    expect(JSON.stringify(plan.getGraph(ideaA))).toBe(before)

    // Keeping the ticketed branch by id works (short ids), and the ticket survives.
    const ok = await call(c, 'tasks_replace_all', {
      stories: [{ id: short(story), title: 'Login (revisado)', projectId: apiId, children: [{ id: short(t1), title: 'Criar endpoint' }] }]
    })
    expect(ok.isError).toBe(false)
    const g = plan.getGraph(ideaA)
    expect(g.nodes.map((n) => n.title)).toEqual(['Login (revisado)', 'Criar endpoint'])
    expect(g.nodes[1].devopsId).toBe(99)
    expect(g.deps).toEqual([])
  })

  it('has no way to force: a "force" argument is ignored', async () => {
    const { t1 } = seed()
    plan.setDevops(ideaA, t1, { devopsId: 99, devopsUrl: 'u', syncedAt: 1 })
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_replace_all', { stories: [{ title: 'X', projectId: apiId }], force: true })
    expect(r.isError).toBe(true)
    expect(plan.getGraph(ideaA).nodes).toHaveLength(3)
  })

  it('surfaces PlanErrors as tool errors with a hint (unlinked project, cycle, unknown dep)', async () => {
    const c = await connect(ideaB)
    const noProject = await call(c, 'tasks_replace_all', { stories: [{ title: 'S', projectId: webId }] })
    expect(noProject.isError).toBe(true)
    expect(noProject.text).toContain('Erro (tasks_replace_all)')
    expect(noProject.text).toContain('Projetos vinculados')

    const cycle = await call(c, 'tasks_replace_all', {
      stories: [{ title: 'S', projectId: apiId, children: [{ tempId: 'a', title: 'A' }, { tempId: 'b', title: 'B' }] }],
      deps: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' }
      ]
    })
    expect(cycle.isError).toBe(true)
    expect(cycle.text).toContain('Como corrigir')
    expect(plan.getGraph(ideaB).nodes).toEqual([])

    const unknown = await call(c, 'tasks_replace_all', {
      stories: [{ title: 'S', projectId: apiId }],
      deps: [{ from: 'nada', to: 'nunca' }]
    })
    expect(unknown.isError).toBe(true)
  })

  it('rejects invalid input via zod', async () => {
    const c = await connect(ideaA)
    expect((await call(c, 'tasks_replace_all', { stories: [] })).isError).toBe(true)
    expect((await call(c, 'tasks_replace_all', { stories: [{ title: '', projectId: apiId }] })).isError).toBe(true)
  })
})

describe('tasks_add', () => {
  it('adds new stories without deleting anything', async () => {
    const { story } = seed()
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_add', { nodes: [{ title: 'Tela', projectId: webId, children: [{ title: 'Form' }] }] })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('2 nó(s) adicionado(s)')
    const g = plan.getGraph(ideaA)
    expect(g.nodes.map((n) => n.title)).toEqual(['Login na API', 'Criar endpoint', 'Validar token', 'Tela', 'Form'])
    expect(g.nodes[0].id).toBe(story)
  })

  it('adds tasks under an existing node, with deps on existing ids and new tempIds', async () => {
    const { story, t1 } = seed()
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_add', {
      parentId: short(story),
      nodes: [{ tempId: 'novo', title: 'Documentar' }],
      deps: [{ from: 'novo', to: short(t1) }]
    })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('novo → [')
    const g = plan.getGraph(ideaA)
    const novo = g.nodes.find((n) => n.title === 'Documentar')!
    expect(novo.parentId).toBe(story)
    expect(g.deps).toContainEqual({ fromId: novo.id, toId: t1 })
  })

  it('reports PlanErrors (story without project)', async () => {
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_add', { nodes: [{ title: 'Sem projeto' }] })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('projeto')
  })
})

describe('node editing tools', () => {
  it('tasks_update_node changes title/description and requires something to change', async () => {
    const { t1 } = seed()
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_update_node', { nodeId: short(t1), title: 'Criar endpoint /login', description: 'Novo texto' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Criar endpoint /login')
    expect(plan.getNode(ideaA, t1).description).toBe('Novo texto')
    expect((await call(c, 'tasks_update_node', { nodeId: short(t1) })).isError).toBe(true)
  })

  it('tasks_update_node flags a ticketed node as stale', async () => {
    const { t1 } = seed()
    plan.setDevops(ideaA, t1, { devopsId: 7, devopsUrl: 'u', syncedAt: 1 })
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_update_node', { nodeId: short(t1), title: 'Mudou' })
    expect(r.text).toContain('desatualizado')
  })

  it('tasks_update_node changes the project of a story only', async () => {
    const { story, t1 } = seed()
    const c = await connect(ideaA)
    expect((await call(c, 'tasks_update_node', { nodeId: short(story), projectId: webId })).isError).toBe(false)
    expect(plan.getNode(ideaA, t1).projectId).toBe(webId)
    expect((await call(c, 'tasks_update_node', { nodeId: short(t1), projectId: apiId })).isError).toBe(true)
  })

  it('tasks_set_parent moves a task; cycles and bad moves are errors', async () => {
    const { story, t1, t2 } = seed()
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_set_parent', { nodeId: short(t2), parentId: short(t1) })
    expect(r.isError).toBe(false)
    expect(plan.getNode(ideaA, t2).parentId).toBe(t1)
    const cyc = await call(c, 'tasks_set_parent', { nodeId: short(t1), parentId: short(t2) })
    expect(cyc.isError).toBe(true)
    expect(cyc.text).toContain('Como corrigir')
    expect((await call(c, 'tasks_set_parent', { nodeId: short(story), parentId: short(t1) })).isError).toBe(true)
  })

  it('tasks_reorder sets the sibling order', async () => {
    const { story, t1, t2 } = seed()
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_reorder', { parentId: short(story), orderedIds: [short(t2), short(t1)] })
    expect(r.isError).toBe(false)
    expect(plan.getGraph(ideaA).nodes.map((n) => n.id)).toEqual([story, t2, t1])
    expect((await call(c, 'tasks_reorder', { parentId: short(story), orderedIds: [short(t1)] })).isError).toBe(true)
    expect((await call(c, 'tasks_reorder', { orderedIds: [short(story)] })).isError).toBe(false)
  })
})

describe('dependency tools', () => {
  it('adds and removes deps; reports per-pair failures', async () => {
    const { story, t1, t2 } = seed()
    plan.removeDep(ideaA, t2, t1)
    const c = await connect(ideaA)
    const add = await call(c, 'tasks_add_dep', { deps: [{ from: short(t2), to: short(t1) }] })
    expect(add.isError).toBe(false)
    expect(plan.getGraph(ideaA).deps).toEqual([{ fromId: t2, toId: t1 }])

    const mixed = await call(c, 'tasks_add_dep', {
      deps: [
        { from: short(t1), to: short(t2) }, // would close a cycle
        { from: short(story), to: short(t1) } // valid
      ]
    })
    expect(mixed.isError).toBe(true)
    expect(mixed.text).toContain('FALHOU')
    expect(mixed.text).toContain('ok:')
    expect(plan.getGraph(ideaA).deps).toHaveLength(2)

    const rm = await call(c, 'tasks_remove_dep', { deps: [{ from: short(t2), to: short(t1) }] })
    expect(rm.text).toContain('removida')
    const again = await call(c, 'tasks_remove_dep', { deps: [{ from: short(t2), to: short(t1) }] })
    expect(again.isError).toBe(false)
    expect(again.text).toContain('não existia')
  })
})

describe('tasks_delete_node', () => {
  it('deletes a subtree', async () => {
    const { story, t1 } = seed()
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_delete_node', { nodeId: short(t1) })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('1 nó(s)')
    expect(plan.getGraph(ideaA).nodes.map((n) => n.id)).toContain(story)
    expect(plan.getGraph(ideaA).nodes).toHaveLength(2)
    expect(plan.getGraph(ideaA).deps).toEqual([])
  })

  it('refuses ticketed subtrees (no force available)', async () => {
    const { story, t1 } = seed()
    plan.setDevops(ideaA, t1, { devopsId: 55, devopsUrl: 'u', syncedAt: 1 })
    const c = await connect(ideaA)
    const r = await call(c, 'tasks_delete_node', { nodeId: short(story), force: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('aba Tarefas')
    expect(plan.getGraph(ideaA).nodes).toHaveLength(3)
  })
})

describe('idea scoping', () => {
  it('a session for idea B cannot read or touch idea A nodes, even with their full ids', async () => {
    const { story, t1, t2 } = seed()
    plan.createNode(ideaB, { kind: 'story', title: 'Só da B', projectId: apiId })
    const before = JSON.stringify(plan.getGraph(ideaA))
    const c = await connect(ideaB)

    const read = await call(c, 'tasks_read')
    expect(read.text).toContain('Só da B')
    expect(read.text).not.toContain('Login na API')

    for (const id of [story, short(story), t1]) {
      expect((await call(c, 'tasks_read', { nodeId: id })).isError).toBe(true)
      expect((await call(c, 'tasks_update_node', { nodeId: id, title: 'invadido' })).isError).toBe(true)
      expect((await call(c, 'tasks_delete_node', { nodeId: id })).isError).toBe(true)
      expect((await call(c, 'tasks_set_parent', { nodeId: t2, parentId: id })).isError).toBe(true)
      expect((await call(c, 'tasks_add', { parentId: id, nodes: [{ title: 'x' }] })).isError).toBe(true)
      expect((await call(c, 'tasks_add_dep', { deps: [{ from: id, to: t1 }] })).isError).toBe(true)
      expect((await call(c, 'tasks_reorder', { parentId: id, orderedIds: [t1, t2] })).isError).toBe(true)
    }
    // replace_all cannot adopt another idea's node by id either.
    const steal = await call(c, 'tasks_replace_all', { stories: [{ id: story, title: 'roubada', projectId: apiId }] })
    expect(steal.isError).toBe(true)

    expect(JSON.stringify(plan.getGraph(ideaA))).toBe(before)
    expect(plan.getGraph(ideaB).nodes.map((n) => n.title)).toEqual(['Só da B'])
  })

  it('an ideaId argument cannot redirect a call', async () => {
    seed()
    events.length = 0
    const c = await connect(ideaB)
    const r = await call(c, 'tasks_replace_all', { stories: [{ title: 'Na B', projectId: apiId }], ideaId: ideaA })
    expect(r.isError).toBe(false)
    expect(plan.getGraph(ideaB).nodes.map((n) => n.title)).toEqual(['Na B'])
    expect(plan.getGraph(ideaA).nodes).toHaveLength(3)
    expect(events).not.toContain(ideaA)
  })
})

describe('id helpers', () => {
  it('resolves short prefixes, rejects ambiguous and unknown ids, lengthens colliding ids', () => {
    const mk = (id: string): { id: string } => ({ id })
    const graph = { ideaId: 1, deps: [], nodes: [mk('aaaaaaaa-1'), mk('aaaaaaaa-2'), mk('bbbbbbbb-1')] } as never
    expect(resolveNodeRef(graph, 'BBBBBB')).toBe('bbbbbbbb-1')
    expect(resolveNodeRef(graph, 'aaaaaaaa-2')).toBe('aaaaaaaa-2')
    expect(() => resolveNodeRef(graph, 'aaaaaa')).toThrow(/ambíguo/)
    expect(() => resolveNodeRef(graph, 'cccccc')).toThrow(ToolInputError)
    expect(() => resolveNodeRef(graph, 'bbb')).toThrow(/não encontrado/)
    expect(idLength([mk('aaaaaaaa-1'), mk('aaaaaaaa-2')])).toBe(10)
    expect(idLength([mk('11111111xxxx'), mk('22222222xxxx')])).toBe(8)
  })

  it('formatOverview titlesOnly hides descriptions and projects can be omitted', () => {
    const { story } = seed()
    const out = formatOverview(plan.overview(ideaA), { titlesOnly: true, omitProjects: true })
    expect(out).not.toContain('Autenticação')
    expect(out).not.toContain('Projetos vinculados')
    expect(out).toContain(`STORY [${short(story)}]`)
  })
})
