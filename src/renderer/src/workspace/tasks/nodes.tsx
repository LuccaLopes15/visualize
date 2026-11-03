import { useEffect, useRef } from 'react'
import { Handle, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react'
import type { PlanNode } from '@shared/types'
import { IconPlus, IconTrash, IconEdit } from '../../components/Icons'
import { useTasksActions } from './context'
import { IconChevron } from './icons'
import { LANE_PAD_TOP, STORY_SIZE, TASK_SIZE } from './layout'
import { descriptionPreview } from './ops'

export interface PlanNodeData extends Record<string, unknown> {
  node: PlanNode
  color: string
  projectName: string
  childCount: number
  collapsed: boolean
  hiddenCount: number
  /** Appeared since the last render (briefly highlighted). */
  isNew: boolean
}
export type StoryFlowNode = Node<PlanNodeData, 'story'>
export type TaskFlowNode = Node<PlanNodeData, 'task'>

export interface LaneData extends Record<string, unknown> {
  label: string
  color: string
  soft: string
  line: string
}
export type LaneFlowNode = Node<LaneData, 'lane'>

export const NODE_DIMENSIONS = { story: STORY_SIZE, task: TASK_SIZE } as const

/** Four handles (loose connection mode): hierarchy uses t/b (TB) or l/r (LR), dependencies the free sides. */
function Handles(): React.JSX.Element {
  return (
    <>
      <Handle id="t" type="source" position={Position.Top} className="tk-handle" />
      <Handle id="b" type="source" position={Position.Bottom} className="tk-handle" />
      <Handle id="l" type="source" position={Position.Left} className="tk-handle" />
      <Handle id="r" type="source" position={Position.Right} className="tk-handle" />
    </>
  )
}

function Title({ node, className }: { node: PlanNode; className: string }): React.JSX.Element {
  const { editingId, startEdit, stopEdit, rename } = useTasksActions()
  const editing = editingId === node.id
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)

  useEffect(() => {
    if (editing) {
      done.current = false
      ref.current?.focus()
      ref.current?.select()
    }
  }, [editing])

  if (!editing) {
    return (
      <div className={className} title={node.title} onDoubleClick={() => startEdit(node.id)}>
        {node.title}
      </div>
    )
  }
  const finish = (save: boolean): void => {
    if (done.current) return
    done.current = true
    const v = (ref.current?.value ?? '').trim()
    stopEdit()
    if (save && v && v !== node.title) rename(node.id, v)
  }
  return (
    <textarea
      ref={ref}
      className={`${className} tk-title-input nodrag nowheel nopan`}
      defaultValue={node.title}
      rows={2}
      maxLength={255}
      aria-label="Título"
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
    />
  )
}

function Badges({ node }: { node: PlanNode }): React.JSX.Element | null {
  if (node.devopsId === null && !node.devopsStale) return null
  return (
    <>
      {node.devopsId !== null && (
        <span className="tk-badge tk-badge-devops" title="Work item no Azure DevOps">
          #{node.devopsId}
        </span>
      )}
      {node.devopsStale && (
        <span className="tk-badge tk-badge-stale" title="Editado depois da última sincronização com o Azure DevOps">
          desatualizado
        </span>
      )}
    </>
  )
}

function Footer({ data }: { data: PlanNodeData }): React.JSX.Element {
  const { toggleCollapse } = useTasksActions()
  const { node, childCount, collapsed, hiddenCount } = data
  return (
    <div className="tk-foot">
      {childCount > 0 ? (
        <button
          className="tk-count nodrag"
          title={collapsed ? 'Expandir filhas' : 'Recolher filhas'}
          onClick={(e) => {
            e.stopPropagation()
            toggleCollapse(node.id)
          }}
        >
          <IconChevron size={11} open={!collapsed} />
          {childCount} {childCount === 1 ? 'filha' : 'filhas'}
          {collapsed && hiddenCount > childCount ? ` (+${hiddenCount - childCount})` : ''}
        </button>
      ) : (
        <span className="tk-count tk-count-none">sem filhas</span>
      )}
      <span className="tk-foot-spacer" />
      <Badges node={node} />
    </div>
  )
}

function SelectedToolbar({ data, selected }: { data: PlanNodeData; selected: boolean }): React.JSX.Element {
  const { addChild, remove, startEdit } = useTasksActions()
  const { node } = data
  return (
    <NodeToolbar isVisible={selected} position={Position.Top} offset={8} className="tk-toolbar">
      <button className="tk-tb-btn" onClick={() => addChild(node.id)} title="Adicionar tarefa filha (Tab)">
        <IconPlus size={13} /> {node.kind === 'story' ? 'Tarefa' : 'Filha'}
      </button>
      <button className="tk-tb-btn" onClick={() => startEdit(node.id)} title="Renomear (Enter ou duplo clique)">
        <IconEdit size={13} /> Renomear
      </button>
      <button className="tk-tb-btn tk-tb-danger" onClick={() => remove(node.id)} title="Excluir (Delete)">
        <IconTrash size={13} />
      </button>
    </NodeToolbar>
  )
}

export function StoryNode({ data, selected }: NodeProps<StoryFlowNode>): React.JSX.Element {
  const { node, color, projectName } = data
  return (
    // Handles and toolbar live outside the (overflow: hidden) card so they are not clipped.
    <div className="tk-node">
      <Handles />
      <SelectedToolbar data={data} selected={!!selected} />
      <div
        className={`tk-card tk-story${selected ? ' selected' : ''}${data.isNew ? ' is-new' : ''}`}
        style={{ ['--pc' as string]: color }}
      >
        <div className="tk-row">
          <span className="tk-tag">História</span>
          <span className="tk-chip" title={`Projeto: ${projectName}`}>
            <i />
            {projectName}
          </span>
        </div>
        <Title node={node} className="tk-title tk-title-story" />
        <Footer data={data} />
      </div>
    </div>
  )
}

export function TaskNode({ data, selected }: NodeProps<TaskFlowNode>): React.JSX.Element {
  const { node, color } = data
  const preview = descriptionPreview(node.description)
  return (
    <div className="tk-node">
      <Handles />
      <SelectedToolbar data={data} selected={!!selected} />
      <div
        className={`tk-card tk-task${selected ? ' selected' : ''}${data.isNew ? ' is-new' : ''}`}
        style={{ ['--pc' as string]: color }}
      >
        <Title node={node} className="tk-title tk-title-task" />
        <div className={`tk-desc${preview ? '' : ' tk-desc-empty'}`}>{preview || 'Sem descrição'}</div>
        <Footer data={data} />
      </div>
    </div>
  )
}

/** Tinted background rectangle of a story (one per story, coloured by project). */
export function LaneNode({ data }: NodeProps<LaneFlowNode>): React.JSX.Element {
  return (
    <div className="tk-lane" style={{ background: data.soft, borderColor: data.line, ['--pc' as string]: data.color }}>
      <div className="tk-lane-label" style={{ height: LANE_PAD_TOP }}>
        <i />
        {data.label}
      </div>
    </div>
  )
}
