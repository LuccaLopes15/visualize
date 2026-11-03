// Task-graph tools (Fase 4): tasks_* → PlanService. Like every visualize tool they
// work on the idea bound to the caller's token (no ideaId parameter), and node ids
// are resolved against that idea's graph only. `force` is never exposed: only the
// user can discard ticketed nodes (Tarefas tab).
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PlanError, collectSubtree, type PlanErrorCode } from '@shared/plan'
import type { PlanGraph, PlanSpecDep, PlanSpecNode, PlanWriteResult } from '@shared/types'
import type { PlanService } from '../plan/service'
import { ToolInputError, formatOverview, nodeLabel, resolveNodeRef, shortId, idLength } from './planFormat'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {})
})

const HINTS: Partial<Record<PlanErrorCode, string>> = {
  not_found: 'Use tasks_read para ver os ids atuais.',
  cross_idea: 'Use tasks_read: só os nós desta ideia podem ser usados.',
  story_needs_project: 'Informe projectId de um projeto da lista "Projetos vinculados" de tasks_read.',
  project_not_linked: 'Use um id da lista "Projetos vinculados" de tasks_read.',
  story_has_parent: 'Stories ficam na raiz; só tasks têm pai.',
  task_needs_parent: 'Tasks precisam de uma story ou task como pai (parentId).',
  task_project_derived: 'Tasks herdam o projeto da story; omita projectId nelas.',
  hierarchy_cycle: 'Escolha um pai que não seja o próprio nó nem um descendente dele.',
  dep_self: 'Um nó não pode depender de si mesmo.',
  dep_duplicate: 'Essa dependência já existe; nada a fazer.',
  dep_cycle: 'Remova ou inverta uma das dependências do ciclo (tasks_remove_dep) e tente de novo.',
  spec_invalid: 'Revise tempIds (únicos), ids existentes, projectId das stories e as referências em deps.',
  invalid_title: 'Informe um título curto e não vazio (máx. 255 caracteres).',
  invalid_input: 'Revise os parâmetros informados.'
}

function planGuard(tool: string, ticketedHint: string) {
  return async (fn: () => ToolResult): Promise<ToolResult> => {
    try {
      return fn()
    } catch (err) {
      if (err instanceof PlanError) {
        const hint = err.code === 'ticketed_nodes' ? ticketedHint : HINTS[err.code]
        return text(`Erro (${tool}): ${err.message}${hint ? `\nComo corrigir: ${hint}` : ''}`, true)
      }
      if (err instanceof ToolInputError) {
        return text(`Erro (${tool}): ${err.message}${err.hint ? `\nComo corrigir: ${err.hint}` : ''}`, true)
      }
      return text(`Erro (${tool}): ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }
}

const REPLACE_TICKETED_HINT =
  'Há nós já enviados ao Azure DevOps (com ticket) que sumiriam do plano. Reenvie-os no spec com o campo "id" (veja tasks_read) para preservá-los, ou faça mudanças incrementais com tasks_add / tasks_update_node / tasks_set_parent. Você não pode descartar nós com ticket: só o usuário, pela aba Tarefas.'
const DELETE_TICKETED_HINT =
  'Esse nó (ou algum descendente) já tem ticket no Azure DevOps. Você não pode apagá-lo: avise o usuário, que decide pela aba Tarefas.'

// ---- schemas (written for the model) ---------------------------------------------

const idRef = (what: string): z.ZodString =>
  z
    .string()
    .min(1)
    .describe(`${what} Use o id mostrado por tasks_read (texto entre colchetes; o id completo também vale).`)

const TEMP_ID = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe(
    'Apelido temporário, único nesta chamada, para referenciar o nó em "deps" (ex.: "api-login"). Evite apelidos que pareçam um id hexadecimal.'
  )
const TITLE = z.string().min(1).max(255).describe('Título curto no imperativo, em pt-BR (ex.: "Criar endpoint de login").')
const DESCRIPTION = z
  .string()
  .max(50_000)
  .optional()
  .describe('Descrição em Markdown: contexto, critérios de aceite e notas técnicas (arquivos/classes reais do projeto).')
const SPEC_ID = z
  .string()
  .optional()
  .describe(
    'Só para MANTER um nó existente (id de tasks_read), preservando o ticket do DevOps e demais dados; título/descrição/filhos passam a ser os informados. Omita para criar um nó novo.'
  )
const CHILDREN_DESC =
  'Sub-tasks deste nó (use só quando agregarem clareza; no máximo 3 níveis de tasks abaixo da story).'

/** Task spec with up to `depth` nested levels (no recursion: keeps the JSON schema flat for the CLI). */
function taskNode(depth: number, opts: { keep: boolean; project: boolean }): z.ZodObject {
  const shape: Record<string, z.ZodType> = {
    tempId: TEMP_ID,
    ...(opts.keep ? { id: SPEC_ID } : {}),
    title: TITLE,
    description: DESCRIPTION,
    ...(opts.project
      ? {
          projectId: z
            .number()
            .int()
            .optional()
            .describe(
              'Só para STORIES novas (sem parentId): id do projeto vinculado onde o trabalho será feito. Tasks herdam o projeto da story: omita.'
            )
        }
      : {})
  }
  if (depth > 0) {
    shape.children = z
      .array(taskNode(depth - 1, { ...opts, project: false }))
      .max(100)
      .optional()
      .describe(CHILDREN_DESC)
  }
  return z.object(shape)
}

const storyNode = z.object({
  tempId: TEMP_ID,
  id: SPEC_ID,
  title: TITLE,
  description: DESCRIPTION,
  projectId: z.number().int().describe('Id do projeto (de "Projetos vinculados" em tasks_read) afetado por esta story.'),
  children: z
    .array(taskNode(2, { keep: true, project: false }))
    .max(200)
    .optional()
    .describe('Tasks da story (podem ter sub-tasks aninhadas em "children").')
})

const depsSchema = z
  .array(
    z.object({
      from: z.string().min(1).describe('Nó que DEPENDE do outro (tempId ou id).'),
      to: z.string().min(1).describe('Pré-requisito: precisa ficar pronto antes de "from" (tempId ou id).')
    })
  )
  .max(500)
  .optional()
  .describe(
    'Dependências reais de ordem entre nós: "from" depende de "to". Use só quando há restrição de ordem de verdade; não crie ciclos.'
  )

// ---- spec conversion ------------------------------------------------------------

interface RawSpecNode {
  tempId?: string
  id?: string
  title: string
  description?: string
  projectId?: number
  children?: RawSpecNode[]
}

/** Resolves short ids inside the spec tree and collects tempIds. */
function convertNodes(graph: PlanGraph, nodes: RawSpecNode[], tempIds: Set<string>): PlanSpecNode[] {
  return nodes.map((n) => {
    if (n.tempId) tempIds.add(n.tempId)
    const out: PlanSpecNode = { title: n.title }
    if (n.tempId) out.tempId = n.tempId
    if (n.id) out.id = resolveNodeRef(graph, n.id)
    if (n.description !== undefined) out.description = n.description
    if (n.projectId !== undefined) out.projectId = n.projectId
    if (n.children?.length) out.children = convertNodes(graph, n.children, tempIds)
    return out
  })
}

/** Dep ends are spec tempIds (kept) or existing node ids (short ids resolved). */
function convertDeps(graph: PlanGraph, deps: PlanSpecDep[] | undefined, tempIds: Set<string>): PlanSpecDep[] | undefined {
  if (!deps?.length) return undefined
  const ref = (r: string): string => (tempIds.has(r) ? r : resolveNodeRef(graph, r))
  return deps.map((d) => ({ from: ref(d.from), to: ref(d.to) }))
}

const OUTLINE_MAX_NODES = 80

function writeSummary(plan: PlanService, ideaId: number, head: string, result: PlanWriteResult, rootId?: string): string {
  const overview = plan.overview(ideaId)
  const { graph } = overview
  const lines = [head]
  const len = idLength(graph.nodes)
  const tempIds = Object.entries(result.idMap)
  if (tempIds.length) {
    lines.push('Ids reais (tempId → id):')
    for (const [temp, real] of tempIds) lines.push(`- ${temp.length > 20 ? temp.slice(0, 8) : temp} → [${real.slice(0, len)}]`)
  }
  if (graph.nodes.length <= OUTLINE_MAX_NODES) {
    lines.push('', 'Plano atual:', formatOverview(overview, { titlesOnly: true, omitProjects: true, rootId }))
  } else {
    lines.push('Use tasks_read para ver o plano e os ids atuais.')
  }
  return lines.join('\n')
}

// ---- registration ---------------------------------------------------------------

export function registerPlanTools(server: McpServer, ideaId: number, plan: PlanService): void {
  server.registerTool(
    'tasks_read',
    {
      title: 'Ler o plano de tarefas',
      description:
        'Lê o plano de tarefas da ideia: projetos vinculados (com id), stories agrupadas por projeto, árvore indentada de tasks/sub-tasks com id curto entre colchetes, trecho da descrição, dependências ("depende de") e status de ticket do Azure DevOps ([ticket #N], "desatualizado" = editado depois do último envio). Use SEMPRE antes de alterar o plano e para obter os ids usados nas outras tools tasks_*.',
      inputSchema: {
        nodeId: z
          .string()
          .optional()
          .describe('Ler só a subárvore deste nó (id de tasks_read), com a descrição completa.'),
        full: z.boolean().optional().describe('Mostrar as descrições completas em vez de um trecho (padrão false).')
      },
      annotations: { readOnlyHint: true }
    },
    ({ nodeId, full }) =>
      planGuard('tasks_read', '')(() => {
        const overview = plan.overview(ideaId)
        const rootId = nodeId ? resolveNodeRef(overview.graph, nodeId) : undefined
        return text(formatOverview(overview, { full: full || !!rootId, rootId }))
      })
  )

  server.registerTool(
    'tasks_replace_all',
    {
      title: 'Montar o plano de tarefas inteiro',
      description:
        'Substitui o plano de tarefas inteiro por um novo, de uma vez e de forma atômica (tudo ou nada). Use para a PRIMEIRA quebra do plano macro em tarefas, ou para reestruturar tudo. Uma story por projeto afetado; tasks concretas e entregáveis dentro de cada story; sub-tasks só quando agregarem clareza. Nós sem "id" são criados; nós com "id" (de tasks_read) são mantidos/atualizados no lugar; nós existentes ausentes do spec são APAGADOS, e todas as dependências existentes são substituídas por "deps". Nós que já têm ticket no DevOps NÃO podem ser apagados: reenvie-os com "id" (se der erro, a mensagem diz como corrigir). Para ajustes pontuais depois, prefira tasks_add / tasks_update_node / tasks_set_parent / tasks_add_dep.',
      inputSchema: {
        stories: z.array(storyNode).min(1).max(50).describe('Stories do plano (uma por projeto afetado), cada uma com suas tasks.'),
        deps: depsSchema
      },
      annotations: { destructiveHint: true }
    },
    ({ stories, deps }) =>
      planGuard('tasks_replace_all', REPLACE_TICKETED_HINT)(() => {
        const graph = plan.getGraph(ideaId)
        const tempIds = new Set<string>()
        const spec = { stories: convertNodes(graph, stories as RawSpecNode[], tempIds), deps: convertDeps(graph, deps, tempIds) }
        const r = plan.replaceAll(ideaId, spec)
        return text(
          writeSummary(
            plan,
            ideaId,
            `Plano de tarefas substituído: ${r.created} criado(s), ${r.updated} mantido(s)/atualizado(s), ${r.deleted} apagado(s). Avise o usuário para ver a aba Tarefas.`,
            r
          )
        )
      })
  )

  server.registerTool(
    'tasks_add',
    {
      title: 'Adicionar tarefas',
      description:
        'Adiciona nós ao plano SEM apagar nada. Com parentId (story ou task existente): "nodes" são tasks adicionadas no fim dos filhos dele (podem ter sub-tasks em "children"). Sem parentId: "nodes" são STORIES novas e cada uma exige projectId (de "Projetos vinculados" em tasks_read). Dependências em "deps" aceitam tempIds dos nós novos e ids de nós existentes.',
      inputSchema: {
        parentId: z
          .string()
          .optional()
          .describe('Story ou task existente onde as tasks serão adicionadas. Omita para criar stories novas.'),
        nodes: z.array(taskNode(3, { keep: false, project: true })).min(1).max(200),
        deps: depsSchema
      }
    },
    ({ parentId, nodes, deps }) =>
      planGuard('tasks_add', '')(() => {
        const graph = plan.getGraph(ideaId)
        const parent = parentId ? resolveNodeRef(graph, parentId) : null
        const tempIds = new Set<string>()
        const spec = { nodes: convertNodes(graph, nodes as unknown as RawSpecNode[], tempIds), deps: convertDeps(graph, deps, tempIds) }
        const r = plan.mergeAdd(ideaId, spec, parent)
        return text(writeSummary(plan, ideaId, `${r.created} nó(s) adicionado(s).`, r, parent ?? undefined))
      })
  )

  server.registerTool(
    'tasks_update_node',
    {
      title: 'Atualizar uma tarefa',
      description:
        'Altera o título e/ou a descrição de um nó existente (story ou task). Em stories também dá para trocar o projeto (projectId; as tasks acompanham). Informe só o que muda. A descrição enviada substitui a anterior inteira: leia antes com tasks_read (nodeId) para não perder conteúdo.',
      inputSchema: {
        nodeId: idRef('Nó a alterar.'),
        title: TITLE.optional(),
        description: z.string().max(50_000).optional().describe('Nova descrição completa em Markdown ("" para limpar).'),
        projectId: z.number().int().optional().describe('Só para stories: novo projeto vinculado.')
      }
    },
    ({ nodeId, title, description, projectId }) =>
      planGuard('tasks_update_node', '')(() => {
        if (title === undefined && description === undefined && projectId === undefined) {
          throw new ToolInputError('Nada para alterar.', 'Informe title, description e/ou projectId.')
        }
        const graph = plan.getGraph(ideaId)
        const id = resolveNodeRef(graph, nodeId)
        const node = plan.updateNode(ideaId, id, {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(projectId !== undefined ? { projectId } : {})
        })
        const fresh = plan.getGraph(ideaId)
        return text(`Nó atualizado: ${nodeLabel(fresh, node.id)}${node.devopsStale ? ' (ticket do DevOps agora desatualizado)' : ''}.`)
      })
  )

  server.registerTool(
    'tasks_set_parent',
    {
      title: 'Mover uma tarefa',
      description:
        'Move uma task (com sua subárvore) para baixo de outra story ou task da mesma ideia. A task passa a herdar o projeto da nova story. Não serve para stories (ficam na raiz; use tasks_reorder para mudar a ordem delas) nem para tornar uma task raiz.',
      inputSchema: {
        nodeId: idRef('Task a mover.'),
        parentId: idRef('Novo pai (story ou task).'),
        index: z.number().int().min(0).optional().describe('Posição entre os filhos do novo pai (0 = primeiro; padrão: no fim).')
      }
    },
    ({ nodeId, parentId, index }) =>
      planGuard('tasks_set_parent', '')(() => {
        const graph = plan.getGraph(ideaId)
        const node = plan.setParent(ideaId, resolveNodeRef(graph, nodeId), resolveNodeRef(graph, parentId), index)
        const fresh = plan.getGraph(ideaId)
        return text(`Movido: ${nodeLabel(fresh, node.id)} → agora sob ${nodeLabel(fresh, node.parentId ?? '')}.`)
      })
  )

  server.registerTool(
    'tasks_reorder',
    {
      title: 'Reordenar tarefas',
      description:
        'Define a ordem completa dos irmãos: informe TODOS os filhos atuais de um pai (ou todas as stories, sem parentId) na nova ordem.',
      inputSchema: {
        parentId: z.string().optional().describe('Pai cujos filhos serão reordenados (story ou task). Omita para reordenar as stories.'),
        orderedIds: z.array(z.string().min(1)).min(1).max(500).describe('Ids de todos os irmãos, na ordem desejada.')
      }
    },
    ({ parentId, orderedIds }) =>
      planGuard('tasks_reorder', '')(() => {
        const graph = plan.getGraph(ideaId)
        const parent = parentId ? resolveNodeRef(graph, parentId) : null
        plan.reorder(
          ideaId,
          parent,
          orderedIds.map((i) => resolveNodeRef(graph, i))
        )
        return text(`Ordem atualizada (${orderedIds.length} nó(s)).`)
      })
  )

  const depPairs = z
    .array(z.object({ from: idRef('Nó que DEPENDE do outro.'), to: idRef('Pré-requisito (precisa ficar pronto antes de "from").') }))
    .min(1)
    .max(100)

  server.registerTool(
    'tasks_add_dep',
    {
      title: 'Ligar dependências',
      description:
        'Cria dependências entre nós existentes: "from" depende de "to" (to deve ser concluído antes). Podem cruzar stories e projetos. Rejeita auto-dependência, duplicatas e ciclos (cada par é tratado separadamente; o resultado diz quais foram criados e quais falharam).',
      inputSchema: { deps: depPairs }
    },
    ({ deps }) =>
      planGuard('tasks_add_dep', '')(() => {
        const graph = plan.getGraph(ideaId)
        const lines: string[] = []
        let failed = 0
        for (const d of deps) {
          try {
            const from = resolveNodeRef(graph, d.from)
            const to = resolveNodeRef(graph, d.to)
            plan.addDep(ideaId, from, to)
            lines.push(`ok: ${nodeLabel(graph, from)} depende de ${nodeLabel(graph, to)}`)
          } catch (err) {
            if (!(err instanceof PlanError || err instanceof ToolInputError)) throw err
            failed++
            lines.push(`FALHOU (${d.from} → ${d.to}): ${err.message}`)
          }
        }
        return text(lines.join('\n'), failed > 0)
      })
  )

  server.registerTool(
    'tasks_remove_dep',
    {
      title: 'Remover dependências',
      description: 'Remove dependências entre nós ("from" depende de "to"). Remover uma que não existe é inofensivo.',
      inputSchema: { deps: depPairs }
    },
    ({ deps }) =>
      planGuard('tasks_remove_dep', '')(() => {
        const graph = plan.getGraph(ideaId)
        const lines = deps.map((d) => {
          const from = resolveNodeRef(graph, d.from)
          const to = resolveNodeRef(graph, d.to)
          const removed = plan.removeDep(ideaId, from, to)
          return `${removed ? 'removida' : 'não existia'}: ${nodeLabel(graph, from)} depende de ${nodeLabel(graph, to)}`
        })
        return text(lines.join('\n'))
      })
  )

  server.registerTool(
    'tasks_delete_node',
    {
      title: 'Apagar uma tarefa',
      description:
        'Apaga um nó e toda a sua subárvore (e as dependências que tocam nela). NÃO funciona para nós que já têm ticket no Azure DevOps (nem se algum descendente tiver): nesse caso avise o usuário, que decide pela aba Tarefas. Confirme com o usuário antes de apagar algo que ele criou.',
      inputSchema: { nodeId: idRef('Nó a apagar (com seus descendentes).') },
      annotations: { destructiveHint: true }
    },
    ({ nodeId }) =>
      planGuard('tasks_delete_node', DELETE_TICKETED_HINT)(() => {
        const graph = plan.getGraph(ideaId)
        const id = resolveNodeRef(graph, nodeId)
        const subtreeIds = new Set(collectSubtree(graph.nodes, id))
        const subtree = graph.nodes.filter((n) => subtreeIds.has(n.id))
        const r = plan.deleteNode(ideaId, id)
        const names = subtree.slice(0, 8).map((n) => `"${n.title}"`)
        const more = subtree.length > 8 ? ` e mais ${subtree.length - 8}` : ''
        return text(`Apagado(s) ${r.deletedIds.length} nó(s): ${names.join(', ')}${more}. (id ${shortId(graph, id)})`)
      })
  )
}
