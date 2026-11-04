import { useDeferredValue, useMemo, useRef, useState } from 'react'
import type { PlanGraph, PlanNode } from '@shared/types'
import { PLAN_DESCRIPTION_MAX, PLAN_TITLE_MAX } from '@shared/types'
import { IconPlus, IconTrash, IconX } from '../../components/Icons'
import { renderMarkdown } from '../../lib/markdown'
import { continueList, type Edit } from '../../lib/mdEditing'
import { projectColor } from './colors'
import { IconDown, IconUp } from './icons'
import { depCandidates, parentOptions, siblingsOf } from './ops'
import { useDraft, type Draft } from './useDraft'

export interface PanelActions {
  /** Resolve when the write finished (drafts await it on flush). */
  rename: (id: string, title: string) => Promise<void>
  setDescription: (id: string, description: string) => Promise<void>
  setProject: (id: string, projectId: number) => void
  setParent: (id: string, parentId: string) => void
  move: (id: string, delta: -1 | 1) => void
  addDep: (fromId: string, toId: string) => void
  removeDep: (fromId: string, toId: string) => void
  addChild: (id: string) => void
  remove: (id: string) => void
  select: (id: string) => void
  close: () => void
}

interface Props {
  graph: PlanGraph
  node: PlanNode
  /** Projects linked to the idea (what a story may be moved to). */
  linked: { id: number; name: string; isPrimary: boolean }[]
  projectName: (id: number) => string
  dir: 'TB' | 'LR'
  actions: PanelActions
}

export function SidePanel(props: Props): React.JSX.Element {
  const { node, actions } = props
  return (
    <aside className="tk-panel" aria-label="Detalhes do item">
      <header className="tk-panel-head">
        <span className="tk-tag" style={{ ['--pc' as string]: projectColor(node.projectId).color }}>
          {node.kind === 'story' ? 'História' : node.depth === 1 ? 'Tarefa' : 'Subtarefa'}
        </span>
        {node.devopsId !== null &&
          (node.devopsUrl ? (
            <a className="tk-badge tk-badge-devops" href={node.devopsUrl} target="_blank" rel="noreferrer">
              #{node.devopsId}
            </a>
          ) : (
            <span className="tk-badge tk-badge-devops">#{node.devopsId}</span>
          ))}
        {node.devopsStale && <span className="tk-badge tk-badge-stale">desatualizado</span>}
        <span className="tk-foot-spacer" />
        <button className="icon-btn" title="Fechar painel (Esc)" onClick={actions.close}>
          <IconX size={14} />
        </button>
      </header>
      {/* key: drafts (title / description) restart for each selected node */}
      <PanelBody key={node.id} {...props} />
    </aside>
  )
}

function PanelBody({ graph, node, linked, projectName, dir, actions }: Props): React.JSX.Element {
  const siblings = siblingsOf(graph.nodes, node)
  const idx = siblings.findIndex((s) => s.id === node.id)
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes])
  const dependsOn = graph.deps.filter((d) => d.fromId === node.id).map((d) => byId.get(d.toId))
  const dependents = graph.deps.filter((d) => d.toId === node.id).map((d) => byId.get(d.fromId))
  const candidates = useMemo(() => depCandidates(graph, node.id), [graph, node.id])
  const parents = useMemo(() => parentOptions(graph.nodes, node.id), [graph.nodes, node.id])
  const [depPick, setDepPick] = useState('')

  const title = useDraft(node.title, (v) => {
    const t = v.trim()
    if (!t) title.reset()
    else return actions.rename(node.id, t)
  })

  return (
    <div className="tk-panel-body">
      <div className="tk-field">
        <label className="tk-field">
          <span className="tk-label">Título</span>
          <input
            className="input"
            value={title.draft}
            maxLength={PLAN_TITLE_MAX}
            onChange={(e) => title.change(e.target.value)}
            onBlur={() => void title.flush()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.stopPropagation()
                title.reset()
                e.currentTarget.blur()
              }
            }}
          />
        </label>
        <DraftConflict draft={title} />
      </div>

      <DescriptionField node={node} onCommit={(v) => actions.setDescription(node.id, v)} />

      <div className="tk-field">
        <span className="tk-label">Projeto</span>
        {node.kind === 'story' ? (
          <select
            className="input"
            value={node.projectId}
            onChange={(e) => actions.setProject(node.id, Number(e.target.value))}
          >
            {!linked.some((p) => p.id === node.projectId) && (
              <option value={node.projectId}>{projectName(node.projectId)}</option>
            )}
            {linked.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.isPrimary ? ' (principal)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <div className="tk-static">
            <i className="tk-dot" style={{ background: projectColor(node.projectId).color }} />
            {projectName(node.projectId)}
            <span className="tk-hint"> · herdado da história</span>
          </div>
        )}
      </div>

      {node.kind === 'task' && (
        <label className="tk-field">
          <span className="tk-label">Pai</span>
          <NodeSelect
            value={node.parentId ?? ''}
            nodes={parents}
            onChange={(id) => id && id !== node.parentId && actions.setParent(node.id, id)}
          />
        </label>
      )}

      <div className="tk-field">
        <span className="tk-label">
          Ordem entre {node.kind === 'story' ? 'histórias' : 'irmãs'}
          <span className="tk-hint">
            {' '}
            · {idx + 1} de {siblings.length}
          </span>
        </span>
        <div className="tk-btn-row">
          <button className="btn" disabled={idx <= 0} onClick={() => actions.move(node.id, -1)}>
            <IconUp size={13} /> {dir === 'TB' ? 'Mais à esquerda' : 'Mais acima'}
          </button>
          <button className="btn" disabled={idx < 0 || idx >= siblings.length - 1} onClick={() => actions.move(node.id, 1)}>
            <IconDown size={13} /> {dir === 'TB' ? 'Mais à direita' : 'Mais abaixo'}
          </button>
        </div>
      </div>

      <div className="tk-field">
        <span className="tk-label">Depende de</span>
        {dependsOn.length === 0 && <div className="tk-hint">Nenhuma dependência.</div>}
        <ul className="tk-list">
          {dependsOn.map(
            (d) =>
              d && (
                <li key={d.id}>
                  <RefButton node={d} onSelect={actions.select} />
                  <button
                    className="icon-btn icon-btn-danger"
                    title="Remover dependência"
                    onClick={() => actions.removeDep(node.id, d.id)}
                  >
                    <IconX size={13} />
                  </button>
                </li>
              )
          )}
        </ul>
        <select
          className="input"
          value={depPick}
          aria-label="Adicionar dependência"
          onChange={(e) => {
            const id = e.target.value
            setDepPick('')
            if (id) actions.addDep(node.id, id)
          }}
        >
          <option value="">+ Adicionar dependência…</option>
          {groupByStory(candidates.map((c) => c.node)).map(({ story, items }) => (
            <optgroup key={story.id} label={story.title}>
              {items.map((n) => {
                const c = candidates.find((x) => x.node.id === n.id)!
                return (
                  <option key={n.id} value={n.id} disabled={c.blocked !== null}>
                    {indent(n)}
                    {n.title}
                    {c.blocked === 'exists' ? ' (já depende)' : c.blocked === 'cycle' ? ' (criaria ciclo)' : ''}
                  </option>
                )
              })}
            </optgroup>
          ))}
        </select>
      </div>

      {dependents.length > 0 && (
        <div className="tk-field">
          <span className="tk-label">Dependentes (dependem deste)</span>
          <ul className="tk-list">
            {dependents.map(
              (d) =>
                d && (
                  <li key={d.id}>
                    <RefButton node={d} onSelect={actions.select} />
                    <button
                      className="icon-btn icon-btn-danger"
                      title="Remover dependência"
                      onClick={() => actions.removeDep(d.id, node.id)}
                    >
                      <IconX size={13} />
                    </button>
                  </li>
                )
            )}
          </ul>
        </div>
      )}

      <div className="tk-panel-actions">
        <button className="btn" onClick={() => actions.addChild(node.id)}>
          <IconPlus size={14} /> Tarefa filha
        </button>
        <button className="btn btn-danger-ghost" onClick={() => actions.remove(node.id)}>
          <IconTrash size={14} /> Excluir
        </button>
      </div>
    </div>
  )
}

function RefButton({ node, onSelect }: { node: PlanNode; onSelect: (id: string) => void }): React.JSX.Element {
  return (
    <button className="tk-ref" title={node.title} onClick={() => onSelect(node.id)}>
      <i className="tk-dot" style={{ background: projectColor(node.projectId).color }} />
      <span>{node.title}</span>
      {node.kind === 'story' && <em>história</em>}
    </button>
  )
}

const indent = (n: PlanNode): string => (n.depth > 0 ? `${'– '.repeat(n.depth)}` : '')

/** Nodes grouped under their root story (input in hierarchy pre-order). */
function groupByStory(nodes: PlanNode[]): { story: { id: string; title: string }; items: PlanNode[] }[] {
  const groups = new Map<string, { story: { id: string; title: string }; items: PlanNode[] }>()
  const stories = new Map(nodes.filter((n) => n.kind === 'story').map((n) => [n.id, n]))
  for (const n of nodes) {
    let g = groups.get(n.rootStoryId)
    if (!g) {
      const s = stories.get(n.rootStoryId)
      g = { story: { id: n.rootStoryId, title: s ? s.title : 'História' }, items: [] }
      groups.set(n.rootStoryId, g)
    }
    g.items.push(n)
  }
  return [...groups.values()]
}

function NodeSelect({
  value,
  nodes,
  onChange
}: {
  value: string
  nodes: PlanNode[]
  onChange: (id: string) => void
}): React.JSX.Element {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {groupByStory(nodes).map(({ story, items }) => (
        <optgroup key={story.id} label={story.title}>
          {items.map((n) => (
            <option key={n.id} value={n.id}>
              {indent(n)}
              {n.title}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

/** Shown when the stored value changed (Claude's tasks_update_node) while the user had unsent edits. */
function DraftConflict({ draft }: { draft: Draft }): React.JSX.Element | null {
  if (draft.conflict === null) return null
  return (
    <div className="tk-conflict" role="alert">
      <span>Atualizado pelo Claude enquanto você editava.</span>
      <div className="tk-btn-row">
        <button className="btn" onClick={draft.acceptRemote}>
          Usar a versão do Claude
        </button>
        <button className="btn" onClick={draft.keepMine}>
          Manter a minha
        </button>
      </div>
    </div>
  )
}

function DescriptionField({
  node,
  onCommit
}: {
  node: PlanNode
  onCommit: (v: string) => Promise<void>
}): React.JSX.Element {
  const [preview, setPreview] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const d = useDraft(node.description, onCommit, 900)
  const deferred = useDeferredValue(d.draft)
  const html = useMemo(() => renderMarkdown(deferred), [deferred])

  const applyEdit = (el: HTMLTextAreaElement, e: Edit): void => {
    el.setSelectionRange(e.from, e.to)
    if (e.text) document.execCommand('insertText', false, e.text)
    else if (e.from !== e.to) document.execCommand('delete')
    el.setSelectionRange(e.selStart, e.selEnd)
  }

  return (
    <div className="tk-field">
      <div className="tk-label-row">
        <span className="tk-label">Descrição</span>
        <div className="segmented tk-seg-small" role="tablist" aria-label="Modo da descrição">
          <button role="tab" aria-selected={!preview} className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>
            Editar
          </button>
          <button
            role="tab"
            aria-selected={preview}
            className={preview ? 'on' : ''}
            onClick={() => {
              void d.flush()
              setPreview(true)
            }}
          >
            Visualizar
          </button>
        </div>
      </div>
      <DraftConflict draft={d} />
      {preview ? (
        d.draft.trim() ? (
          <article className="markdown tk-md-preview" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="tk-hint tk-md-preview">Sem descrição.</div>
        )
      ) : (
        <textarea
          ref={ref}
          className="tk-textarea"
          value={d.draft}
          maxLength={PLAN_DESCRIPTION_MAX}
          spellCheck
          placeholder={'Descreva o que precisa ser feito (Markdown).\n\n- critérios de aceite\n- observações'}
          onChange={(e) => d.change(e.target.value)}
          onBlur={() => void d.flush()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
              const el = e.currentTarget
              const edit = continueList(el.value, el.selectionStart, el.selectionEnd)
              if (edit) {
                e.preventDefault()
                applyEdit(el, edit)
              }
            }
          }}
        />
      )}
    </div>
  )
}
