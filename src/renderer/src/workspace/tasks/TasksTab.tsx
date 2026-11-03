import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnConnectEnd,
  type OnConnectStart
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import '../../styles/tasks.css'
import type { Idea, Project } from '@shared/types'
import { ConfirmDialog } from '../../components/Modal'
import { useToast } from '../../components/Toasts'
import { readPref, writePref } from '../../lib/prefs'
import { projectColor } from './colors'
import { TasksActionsContext, type TasksActions } from './context'
import { diffNewIds } from './diff'
import { DepEdge } from './edges'
import { buildFlow, pruneIds } from './flow'
import { IconDir, IconRelayout } from './icons'
import { type LayoutDir } from './layout'
import { LaneNode, NODE_DIMENSIONS, StoryNode, TaskNode, type LaneData, type PlanNodeData } from './nodes'
import {
  ancestorsOf,
  checkConnection,
  deleteImpact,
  moveSibling,
  type ConnectMode
} from './ops'
import { SidePanel, type PanelActions } from './SidePanel'
import { AddStoryButton, EmptyState } from './TasksToolbar'
import { usePlanGraph } from './usePlanGraph'

const api = window.api

const ACCENT = '#8b6cff'
const nodeTypes = { story: StoryNode, task: TaskNode, lane: LaneNode }
const edgeTypes = { dep: DepEdge }
const FIT = { padding: 0.15, minZoom: 0.5, maxZoom: 1, duration: 300 } as const
const HIGHLIGHT_MS = 2600

interface Props {
  idea: Idea
  projects: Project[]
  active: boolean
  onOpenChat: () => void
}

/** Tarefas tab: stories/tasks graph (React Flow) + side panel, kept in sync with the DB and with Claude's changes. */
export default function TasksTab(props: Props): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <TasksInner {...props} />
    </ReactFlowProvider>
  )
}

function TasksInner({ idea, projects, active, onOpenChat }: Props): React.JSX.Element {
  const toast = useToast()
  const rf = useReactFlow()
  const { graph, error, refetch, mutate } = usePlanGraph(idea.id)

  const [dir, setDir] = useState<LayoutDir>(() => (readPref('tasks.dir') === 'LR' ? 'LR' : 'TB'))
  const [mode, setMode] = useState<ConnectMode>(() => (readPref('tasks.mode') === 'child' ? 'child' : 'dep'))
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<Set<string>>(() => new Set())
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [relayout, setRelayout] = useState(0)
  const [connecting, setConnecting] = useState<ConnectMode | null>(null)
  const [pendingTick, setPendingTick] = useState(0)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const canvasRef = useRef<HTMLDivElement>(null)
  const prevIds = useRef<Set<string> | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pending = useRef<{ id: string; edit: boolean } | null>(null)
  const layoutKeyRef = useRef('')
  const relayoutRef = useRef(0)
  const lastCount = useRef(0)
  const fitTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const altHeld = useRef(false)

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const projectName = useCallback((id: number) => projectById.get(id)?.name ?? `Projeto #${id}`, [projectById])
  const linked = useMemo(
    () => idea.projects.map((l) => ({ id: l.projectId, name: projectName(l.projectId), isPrimary: l.isPrimary })),
    [idea.projects, projectName]
  )

  // ---- derived model -----------------------------------------------------------
  const model = useMemo(() => (graph ? buildFlow(graph, { dir, collapsed }) : null), [graph, dir, collapsed])
  const selectedNode = graph?.nodes.find((n) => n.id === selectedId) ?? null

  // ---- per-graph bookkeeping: highlight new nodes, prune stale ids, resolve "create then select" ----
  useEffect(() => {
    if (!graph) {
      prevIds.current = null
      return
    }
    const added = diffNewIds(prevIds.current, graph.nodes)
    prevIds.current = new Set(graph.nodes.map((n) => n.id))
    if (added.length > 0) {
      setHighlight(new Set(added))
      clearTimeout(highlightTimer.current)
      highlightTimer.current = setTimeout(() => setHighlight(new Set()), HIGHLIGHT_MS)
    }
    setCollapsed((c) => pruneIds(c, graph))
    setSelectedId((id) => (id && graph.nodes.some((n) => n.id === id) ? id : null))
    setEditingId((id) => (id && graph.nodes.some((n) => n.id === id) ? id : null))
  }, [graph])
  useEffect(() => () => clearTimeout(highlightTimer.current), [])

  const isInView = useCallback(
    (id: string): boolean => {
      const n = rf.getNode(id)
      const box = canvasRef.current?.getBoundingClientRect()
      if (!n || !box) return true
      const { x, y, zoom } = rf.getViewport()
      const d = NODE_DIMENSIONS[n.type === 'story' ? 'story' : 'task']
      const l = n.position.x * zoom + x
      const t = n.position.y * zoom + y
      return l >= 0 && t >= 0 && l + d.w * zoom <= box.width && t + d.h * zoom <= box.height
    },
    [rf]
  )
  /** Pan (keeping the zoom) so the node is on screen; no-op when it already is. */
  const reveal = useCallback(
    (id: string): void => {
      // Layout/fit land a few frames after the state change: try again a bit later.
      for (const delay of [100, 450]) {
        setTimeout(() => {
          const n = rf.getNode(id)
          if (!n || isInView(id)) return
          const d = NODE_DIMENSIONS[n.type === 'story' ? 'story' : 'task']
          void rf.setCenter(n.position.x + d.w / 2, n.position.y + d.h / 2, { zoom: rf.getZoom(), duration: 300 })
        }, delay)
      }
    },
    [rf, isInView]
  )

  // A node this UI just created: once it is in the graph, select it and start renaming.
  useEffect(() => {
    const p = pending.current
    if (!p || !graph || !graph.nodes.some((n) => n.id === p.id)) return
    pending.current = null
    setSelectedId(p.id)
    setSelectedEdge(null)
    if (p.edit) setEditingId(p.id)
    reveal(p.id)
  }, [graph, pendingTick, reveal])

  // ---- React Flow nodes/edges from the model -------------------------------------
  useEffect(() => {
    if (!model) return
    const sameLayout = layoutKeyRef.current === model.layoutKey && relayoutRef.current === relayout
    const firstLayout = layoutKeyRef.current === ''
    layoutKeyRef.current = model.layoutKey
    relayoutRef.current = relayout

    setNodes((cur) => {
      // Dragging is temporary: positions survive only while the layout inputs are unchanged.
      const dragged = sameLayout ? new Map(cur.map((n) => [n.id, n.position])) : null
      // Every node has a fixed, known size. Handing it over as `measured` keeps
      // `nodesInitialized` true even though these nodes are rebuilt on each change
      // (otherwise fitView waits forever for measurements that never re-arrive).
      void cur
      const lanes: Node[] = model.lanes.map((l) => {
        const c = projectColor(l.projectId)
        const data: LaneData = { label: projectName(l.projectId), color: c.color, soft: c.soft, line: c.line }
        return {
          id: `lane:${l.storyId}`,
          type: 'lane',
          position: { x: l.x, y: l.y },
          // Sized by style (not node.width/height): those would make React Flow skip
          // measuring, and fitView waits forever for measured nodes.
          initialWidth: l.w,
          initialHeight: l.h,
          style: { width: l.w, height: l.h },
          measured: { width: l.w, height: l.h },
          zIndex: -1,
          draggable: false,
          selectable: false,
          connectable: false,
          focusable: false,
          data
        }
      })
      const items: Node[] = model.nodes.map((spec) => {
        const n = spec.node
        const dim = NODE_DIMENSIONS[n.kind]
        const data: PlanNodeData = {
          node: n,
          color: projectColor(n.projectId).color,
          projectName: projectName(n.projectId),
          childCount: spec.childCount,
          collapsed: spec.collapsed,
          hiddenCount: spec.hiddenCount,
          isNew: highlight.has(n.id)
        }
        return {
          id: n.id,
          type: n.kind,
          position: dragged?.get(n.id) ?? spec.position,
          initialWidth: dim.w,
          initialHeight: dim.h,
          style: { width: dim.w, height: dim.h },
          measured: { width: dim.w, height: dim.h },
          selected: n.id === selectedId,
          data
        }
      })
      return [...lanes, ...items]
    })
    setEdges(
      model.edges.map((e): Edge =>
        e.kind === 'hier'
          ? {
              id: e.id,
              type: 'smoothstep',
              source: e.source,
              target: e.target,
              sourceHandle: e.sourceHandle,
              targetHandle: e.targetHandle,
              selectable: false,
              focusable: false,
              style: { stroke: 'var(--border-strong)', strokeWidth: 1.6 }
            }
          : {
              id: e.id,
              type: 'dep',
              source: e.source,
              target: e.target,
              sourceHandle: e.sourceHandle,
              targetHandle: e.targetHandle,
              selectable: !e.aggregated,
              focusable: false,
              selected: e.id === selectedEdge,
              markerEnd: { type: MarkerType.ArrowClosed, color: ACCENT, width: 16, height: 16 },
              data: { aggregated: e.aggregated }
            }
      )
    )

    // Refit on first load, after "Reorganizar"/direction changes and on big changes
    // (e.g. Claude generating the whole breakdown); otherwise keep the viewport.
    const count = model.nodes.length
    const big = !sameLayout && (firstLayout || lastCount.current === 0 || Math.abs(count - lastCount.current) >= 3)
    const forced = relayoutRef.current !== 0 && !sameLayout
    lastCount.current = count
    if (count > 0 && (big || forced)) {
      clearTimeout(fitTimer.current)
      fitTimer.current = setTimeout(() => void rf.fitView(FIT), 80)
    }
  }, [model, relayout, selectedId, selectedEdge, highlight, projectName, setNodes, setEdges, rf])
  useEffect(() => () => clearTimeout(fitTimer.current), [])

  // ---- actions ---------------------------------------------------------------------
  const expandAncestors = useCallback(
    (id: string): void => {
      if (!graph) return
      const anc = ancestorsOf(graph.nodes, id).map((a) => a.id)
      setCollapsed((c) => {
        if (!anc.some((a) => c.has(a))) return c
        const next = new Set(c)
        for (const a of anc) next.delete(a)
        return next
      })
    },
    [graph]
  )

  const createNode = useCallback(
    async (input: Parameters<typeof api.plan.createNode>[1]): Promise<void> => {
      const created = await mutate(() => api.plan.createNode(idea.id, input))
      if (!created) return
      if (input.parentId) expandAncestors(created.id)
      pending.current = { id: created.id, edit: true }
      setPendingTick((t) => t + 1)
    },
    [idea.id, mutate, expandAncestors]
  )
  const addStory = useCallback(
    (projectId: number) => void createNode({ kind: 'story', title: 'Nova história', projectId }),
    [createNode]
  )
  const addChild = useCallback(
    (parentId: string) => {
      setCollapsed((c) => {
        if (!c.has(parentId)) return c
        const next = new Set(c)
        next.delete(parentId)
        return next
      })
      void createNode({ kind: 'task', title: 'Nova tarefa', parentId })
    },
    [createNode]
  )
  const rename = useCallback(
    (id: string, title: string) => void mutate(() => api.plan.updateNode(idea.id, id, { title })),
    [idea.id, mutate]
  )
  const requestDelete = useCallback((id: string) => setConfirmId(id), [])
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const selectNode = useCallback(
    (id: string) => {
      expandAncestors(id)
      setSelectedId(id)
      setSelectedEdge(null)
      reveal(id)
    },
    [expandAncestors, reveal]
  )

  const removeDepEdge = useCallback(
    (edgeId: string) => {
      const e = model?.edges.find((x) => x.id === edgeId)
      if (!e || e.kind !== 'dep' || e.aggregated) return
      setSelectedEdge(null)
      void mutate(() => api.plan.removeDep(idea.id, e.source, e.target))
    },
    [model, idea.id, mutate]
  )

  const confirmDelete = (): void => {
    const id = confirmId
    setConfirmId(null)
    if (!id || !graph) return
    const impact = deleteImpact(graph, id)
    void mutate(() => api.plan.deleteNode(idea.id, id, impact.ticketed.length > 0)).then((res) => {
      if (res) setSelectedId((cur) => (cur && res.deletedIds.includes(cur) ? null : cur))
    })
  }

  const panelActions: PanelActions = {
    rename,
    setDescription: (id, description) => void mutate(() => api.plan.updateNode(idea.id, id, { description })),
    setProject: (id, projectId) => void mutate(() => api.plan.updateNode(idea.id, id, { projectId })),
    setParent: (id, parentId) => {
      expandAncestors(parentId)
      void mutate(() => api.plan.setParent(idea.id, id, parentId))
    },
    move: (id, delta) => {
      if (!graph) return
      const order = moveSibling(graph.nodes, id, delta)
      const node = graph.nodes.find((n) => n.id === id)
      if (order && node) void mutate(() => api.plan.reorder(idea.id, node.parentId, order))
    },
    addDep: (fromId, toId) => void mutate(() => api.plan.addDep(idea.id, fromId, toId)),
    removeDep: (fromId, toId) => void mutate(() => api.plan.removeDep(idea.id, fromId, toId)),
    addChild,
    remove: requestDelete,
    select: selectNode,
    close: () => setSelectedId(null)
  }

  // Must keep a stable identity: React Flow re-fires it whenever the function changes.
  const onSelectionChange = useCallback(({ nodes: ns, edges: es }: { nodes: Node[]; edges: Edge[] }): void => {
    setSelectedId(ns.find((n) => n.type !== 'lane')?.id ?? null)
    setSelectedEdge(es[0]?.id ?? null)
  }, [])

  // ---- connecting by drag ------------------------------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') altHeld.current = true
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') altHeld.current = false
    }
    const reset = (): void => {
      altHeld.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', reset)
    }
  }, [])

  const effectiveMode = (alt: boolean): ConnectMode => (alt ? (mode === 'dep' ? 'child' : 'dep') : mode)

  const onConnectStart: OnConnectStart = (event) => {
    setConnecting(effectiveMode(altHeld.current || ('altKey' in event && !!event.altKey)))
  }
  /** source -> target as drawn by the user (dependency: source depende de target; filha: source vira pai de target). */
  const connectNodes = (source: string, target: string, alt: boolean): void => {
    if (!graph) return
    const m = effectiveMode(alt)
    const problem = checkConnection(graph, m, source, target)
    if (problem) {
      toast.error(problem)
      void refetch() // never trust what the canvas shows after a rejected action
      return
    }
    if (m === 'dep') {
      void mutate(() => api.plan.addDep(idea.id, source, target))
    } else {
      expandAncestors(source)
      void mutate(() => api.plan.setParent(idea.id, target, source))
    }
  }
  const onConnect = (c: Connection): void => {
    if (c.source && c.target) connectNodes(c.source, c.target, altHeld.current)
  }
  // Dropping anywhere on a card (not only on its small handles) also connects.
  const onConnectEnd: OnConnectEnd = (event, state) => {
    setConnecting(null)
    if (state.isValid || !state.fromNode || !('clientX' in event)) return
    const hit = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((el) => el.classList.contains('react-flow__node') && !el.classList.contains('react-flow__node-lane'))
    const target = hit?.getAttribute('data-id')
    if (target && target !== state.fromNode.id) connectNodes(state.fromNode.id, target, altHeld.current || event.altKey)
  }

  // ---- keyboard (only while the tab is visible; never while typing) -----------------
  const kb = useRef({ selectedId, selectedEdge, editingId, confirmId, addChild, requestDelete, removeDepEdge })
  kb.current = { selectedId, selectedEdge, editingId, confirmId, addChild, requestDelete, removeDepEdge }
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      const s = kb.current
      if (s.confirmId || s.editingId || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && t.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
      // Only when focus is on the canvas (or nowhere), never in the chat / header.
      if (t && t !== document.body && !t.closest('.tk-canvas')) return
      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          if (s.selectedEdge) s.removeDepEdge(s.selectedEdge)
          else if (s.selectedId) s.requestDelete(s.selectedId)
          else return
          break
        case 'Enter':
        case 'F2':
          if (!s.selectedId) return
          setEditingId(s.selectedId)
          break
        case 'Tab':
          if (!s.selectedId || e.shiftKey) return
          s.addChild(s.selectedId)
          break
        case 'Escape':
          if (!s.selectedId && !s.selectedEdge) return
          setSelectedId(null)
          setSelectedEdge(null)
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  const actionsCtx: TasksActions = {
    dir,
    editingId,
    startEdit: setEditingId,
    stopEdit: () => setEditingId(null),
    rename,
    addChild,
    remove: requestDelete,
    toggleCollapse
  }

  // ---- toolbar handlers -----------------------------------------------------------------
  const chooseDir = (d: LayoutDir): void => {
    if (d === dir) return
    setDir(d)
    writePref('tasks.dir', d)
    setRelayout((n) => n + 1)
  }
  const chooseMode = (m: ConnectMode): void => {
    setMode(m)
    writePref('tasks.mode', m)
  }
  const anyCollapsed = collapsed.size > 0
  const toggleAll = (): void => {
    if (!graph) return
    if (anyCollapsed) setCollapsed(new Set())
    else {
      const parents = new Set(graph.nodes.filter((n) => n.parentId !== null).map((n) => n.parentId as string))
      setCollapsed(parents)
      setSelectedId((id) => id)
    }
  }

  if (error && !graph) return <div className="ws-placeholder">Não foi possível abrir as tarefas: {error}</div>
  if (!graph) return <div className="ws-placeholder">Carregando tarefas…</div>

  const stories = graph.nodes.filter((n) => n.kind === 'story').length
  const tasks = graph.nodes.length - stories
  const empty = graph.nodes.length === 0
  const hintMode = connecting ?? mode
  const confirmNode = confirmId ? graph.nodes.find((n) => n.id === confirmId) : undefined
  const impact = confirmNode ? deleteImpact(graph, confirmNode.id) : null

  return (
    <TasksActionsContext.Provider value={actionsCtx}>
      <div className="tk">
        <div className="tk-bar">
          <AddStoryButton linked={linked} onPick={addStory} />
          <span className="tk-sep" />
          <button className="btn" onClick={() => setRelayout((n) => n + 1)} title="Reaplicar o layout automático" disabled={empty}>
            <IconRelayout size={14} /> Reorganizar
          </button>
          <div className="segmented" role="group" aria-label="Direção do layout">
            <button className={dir === 'TB' ? 'on' : ''} onClick={() => chooseDir('TB')} title="Hierarquia de cima para baixo">
              <IconDir size={13} vertical /> Vertical
            </button>
            <button className={dir === 'LR' ? 'on' : ''} onClick={() => chooseDir('LR')} title="Hierarquia da esquerda para a direita">
              <IconDir size={13} /> Horizontal
            </button>
          </div>
          <button className="btn btn-ghost" onClick={toggleAll} disabled={empty || tasks === 0} title="Recolher ou expandir as filhas de todos os itens">
            {anyCollapsed ? 'Expandir tudo' : 'Recolher tudo'}
          </button>
          <span className="tk-sep" />
          <span className="tk-bar-label">Ligar como</span>
          <div className="segmented" role="group" aria-label="Ao arrastar de um cartão para outro">
            <button
              className={mode === 'dep' ? 'on' : ''}
              onClick={() => chooseMode('dep')}
              title="Arrastar de A até B faz A depender de B (Alt inverte)"
            >
              Dependência
            </button>
            <button
              className={mode === 'child' ? 'on' : ''}
              onClick={() => chooseMode('child')}
              title="Arrastar de A até B move B para dentro de A (Alt inverte)"
            >
              Filha
            </button>
          </div>
          <span className="tk-foot-spacer" />
          <span className="tk-summary">
            {stories} {stories === 1 ? 'história' : 'histórias'} · {tasks} {tasks === 1 ? 'tarefa' : 'tarefas'} ·{' '}
            {graph.deps.length} {graph.deps.length === 1 ? 'dependência' : 'dependências'}
          </span>
        </div>

        <div className="tk-main">
          <div className="tk-canvas" ref={canvasRef}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectStart={onConnectStart}
              onConnectEnd={onConnectEnd}
              isValidConnection={(c) => c.source !== c.target}
              onSelectionChange={onSelectionChange}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={36}
              colorMode="dark"
              minZoom={0.15}
              maxZoom={1.6}
              deleteKeyCode={null}
              multiSelectionKeyCode={null}
              selectionKeyCode={null}
              zoomOnDoubleClick={false}
              onlyRenderVisibleElements={false}
              proOptions={{ hideAttribution: false }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#2a3040" />
              <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT} />
              {!empty && <MiniMap
                pannable
                zoomable
                position="bottom-right"
                style={{ width: 150, height: 100 }}
                maskColor="rgba(13, 15, 19, 0.72)"
                nodeColor={(n) => (n.type === 'lane' ? 'transparent' : ((n.data as PlanNodeData).color ?? '#888'))}
                nodeStrokeWidth={0}
              />}
              {!empty && (
                <Panel position="top-center" className="tk-hint-pill">
                  {hintMode === 'dep'
                    ? 'Arraste da borda de um cartão até outro: o primeiro passa a depender do segundo'
                    : 'Arraste da borda de um cartão até outro: o segundo passa a ser filho do primeiro'}
                  {' · '}
                  <kbd>Alt</kbd> inverte o modo
                </Panel>
              )}
            </ReactFlow>
            {empty && <EmptyState linked={linked} onPick={addStory} onOpenChat={onOpenChat} />}
          </div>

          {selectedNode && (
            <SidePanel
              graph={graph}
              node={selectedNode}
              linked={linked}
              projectName={projectName}
              dir={dir}
              actions={panelActions}
            />
          )}
        </div>
      </div>

      {confirmNode && impact && (
        <ConfirmDialog
          title={confirmNode.kind === 'story' ? 'Excluir história?' : 'Excluir tarefa?'}
          confirmLabel={impact.ticketed.length > 0 ? 'Excluir mesmo assim' : 'Excluir'}
          danger
          onCancel={() => setConfirmId(null)}
          onConfirm={confirmDelete}
          message={
            <>
              <p>
                <strong>{confirmNode.title}</strong>
                {impact.descendants > 0
                  ? ` e ${impact.descendants} ${impact.descendants === 1 ? 'item descendente' : 'itens descendentes'} serão excluídos.`
                  : ' será excluído.'}
                {impact.deps > 0 &&
                  ` ${impact.deps} ${impact.deps === 1 ? 'dependência ligada' : 'dependências ligadas'} a eles também ${impact.deps === 1 ? 'será removida' : 'serão removidas'}.`}
              </p>
              {impact.ticketed.length > 0 && (
                <p className="tk-warn">
                  Atenção: {impact.ticketed.length === 1 ? 'um item já tem' : `${impact.ticketed.length} itens já têm`} ticket no
                  Azure DevOps ({impact.ticketed.map((n) => `#${n.devopsId}`).join(', ')}). O work item no DevOps{' '}
                  <strong>não</strong> será apagado, mas o vínculo com ele será perdido.
                </p>
              )}
            </>
          }
        />
      )}
    </TasksActionsContext.Provider>
  )
}
