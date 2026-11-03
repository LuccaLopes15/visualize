// Model-friendly text for the task graph (tasks_read and write summaries) and id
// resolution. Node ids are shown as short prefixes of the UUID (8 chars, longer
// only when two ids would collide); tools accept the short prefix (>= 6 chars)
// or the full UUID, resolved against the idea's own graph only.
import { collectSubtree } from '@shared/plan'
import type { PlanGraph, PlanNode, PlanOverview } from '@shared/types'

export const MIN_REF_LENGTH = 6
const DEFAULT_ID_LENGTH = 8

export class ToolInputError extends Error {
  constructor(
    message: string,
    public readonly hint?: string
  ) {
    super(message)
    this.name = 'ToolInputError'
  }
}

/** Shortest common prefix length (>= 8) that keeps every id of the graph unique. */
export function idLength(nodes: { id: string }[]): number {
  let len = DEFAULT_ID_LENGTH
  while (len < 36 && new Set(nodes.map((n) => n.id.slice(0, len))).size !== nodes.length) len++
  return len
}

/** Resolves a short prefix or a full UUID to a node of THIS graph (never another idea's). */
export function resolveNodeRef(graph: PlanGraph, ref: string): string {
  const r = ref.trim().toLowerCase()
  if (!r) throw new ToolInputError('Id de nó vazio.', 'Use um id mostrado por tasks_read.')
  const exact = graph.nodes.find((n) => n.id === r)
  if (exact) return exact.id
  if (r.length >= MIN_REF_LENGTH) {
    const hits = graph.nodes.filter((n) => n.id.startsWith(r))
    if (hits.length === 1) return hits[0].id
    if (hits.length > 1) {
      throw new ToolInputError(
        `O id "${ref}" é ambíguo (${hits.length} nós começam com ele).`,
        'Informe mais caracteres do id (ou o id completo) mostrado por tasks_read.'
      )
    }
  }
  throw new ToolInputError(
    `Nó não encontrado nesta ideia: "${ref}".`,
    'Use tasks_read para ver os ids atuais (o id é o texto entre colchetes).'
  )
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

function snippet(s: string, max: number): string {
  const t = oneLine(s)
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function ticketTag(n: PlanNode): string {
  if (n.devopsId == null) return ''
  return ` [ticket #${n.devopsId}${n.devopsStale ? ', desatualizado' : ''}]`
}

export interface FormatOptions {
  /** Whole description (indented) instead of a short snippet. */
  full?: boolean
  /** No descriptions at all (write summaries). */
  titlesOnly?: boolean
  /** Only this node's subtree (plus its dependencies). */
  rootId?: string
  /** Skip the "Projetos vinculados" section (write summaries). */
  omitProjects?: boolean
}

const SNIPPET_MAX = 200

/** Compact text of the graph: projects, stories by project, indented task tree, dependencies, tickets. */
export function formatOverview(overview: PlanOverview, opts: FormatOptions = {}): string {
  const { graph, projects } = overview
  const len = idLength(graph.nodes)
  const id = (n: { id: string }): string => n.id.slice(0, len)
  const nameOf = (projectId: number): string => projects.find((p) => p.id === projectId)?.name ?? `projeto ${projectId}`

  const subtreeIds = opts.rootId ? new Set(collectSubtree(graph.nodes, opts.rootId)) : null
  const nodes = subtreeIds ? graph.nodes.filter((n) => subtreeIds.has(n.id)) : graph.nodes
  const inScope = new Set(nodes.map((n) => n.id))
  const deps = opts.rootId ? graph.deps.filter((d) => inScope.has(d.fromId) || inScope.has(d.toId)) : graph.deps
  const dependsOn = new Map<string, string[]>()
  for (const d of deps) {
    const list = dependsOn.get(d.fromId) ?? []
    list.push(d.toId)
    dependsOn.set(d.fromId, list)
  }

  const lines: string[] = []
  if (!opts.omitProjects) {
    lines.push('Projetos vinculados à ideia (use o id em projectId ao criar stories):')
    if (!projects.length) lines.push('- (nenhum projeto vinculado: stories exigem um projeto vinculado)')
    for (const p of projects) {
      lines.push(`- id ${p.id} · ${p.name} · ${p.folderPath}${p.isPrimary ? ' (principal)' : ''}`)
    }
    lines.push('')
  }

  const stories = nodes.filter((n) => n.kind === 'story').length
  const tasks = nodes.length - stories
  if (!nodes.length) {
    lines.push('Plano de tarefas: (vazio — nenhuma story ou task ainda)')
    return lines.join('\n')
  }
  lines.push(
    `Plano de tarefas${opts.rootId ? ' (subárvore)' : ''}: ${stories} stor${stories === 1 ? 'y' : 'ies'}, ${tasks} task${tasks === 1 ? '' : 's'}, ${deps.length} dependência${deps.length === 1 ? '' : 's'}. O id de cada nó fica entre colchetes; "depende de" lista os pré-requisitos.`
  )
  lines.push('')

  const baseDepth = nodes[0].depth
  for (const n of nodes) {
    const indent = '  '.repeat(n.depth - baseDepth)
    const deptxt = dependsOn.get(n.id)?.length
      ? ` · depende de: ${dependsOn.get(n.id)!.map((d) => d.slice(0, len)).join(', ')}`
      : ''
    const head =
      n.kind === 'story'
        ? `${indent}STORY [${id(n)}] ${n.title} · projeto: ${nameOf(n.projectId)} (id ${n.projectId})`
        : `${indent}- TASK [${id(n)}] ${n.title}`
    lines.push(head + ticketTag(n) + deptxt)
    if (!opts.titlesOnly && n.description.trim()) {
      const pad = indent + (n.kind === 'story' ? '  ' : '    ')
      if (opts.full) {
        for (const l of n.description.trim().split(/\r?\n/)) lines.push(pad + '| ' + l)
      } else {
        lines.push(`${pad}> ${snippet(n.description, SNIPPET_MAX)}`)
      }
    }
  }
  return lines.join('\n')
}

/** One-line description of a node for write summaries: `[id] "title"`. */
export function nodeLabel(graph: PlanGraph, nodeId: string): string {
  const len = idLength(graph.nodes)
  const n = graph.nodes.find((x) => x.id === nodeId)
  return n ? `[${n.id.slice(0, len)}] "${n.title}"` : `[${nodeId.slice(0, DEFAULT_ID_LENGTH)}]`
}

export function shortId(graph: PlanGraph, nodeId: string): string {
  return nodeId.slice(0, idLength(graph.nodes))
}
