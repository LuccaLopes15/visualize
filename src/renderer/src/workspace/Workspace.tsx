import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Idea, Project } from '@shared/types'
import { StatusBadge } from '../components/StatusBadge'
import {
  IconArrowLeft,
  IconBoard,
  IconChat,
  IconCheck,
  IconDoc,
  IconFolder,
  IconPanelRight,
  IconTasks
} from '../components/Icons'
import { useToast } from '../components/Toasts'
import { flushAll, type SaveStatus } from '../lib/autosave'
import { readPref, writePref } from '../lib/prefs'
import { ProjectChips } from './ProjectChips'
import { MacroPlanTab } from './MacroPlanTab'
import { ChatPanel } from './chat/ChatPanel'
import { useChat } from './chat/useChat'
import { BOARD_CHANGED_EVENT } from './board/ops'

// Excalidraw is heavy: load it only when a workspace opens.
const Board = lazy(() => import('./Board'))

const api = window.api

type Tab = 'board' | 'macro'

interface Props {
  idea: Idea
  projects: Project[]
  onBack: () => void
  onOpenSettings: () => void
}

/**
 * Workspace of one idea: header (title, status, linked projects), tabs
 * (Board / Plano macro / Tarefas[Fase 4]) and the right-side chat slot
 * (Fase 3). Both tabs stay mounted so Excalidraw keeps its undo history.
 */
export function Workspace({ idea, projects, onBack, onOpenSettings }: Props): React.JSX.Element {
  const toast = useToast()
  const [tab, setTab] = useState<Tab>(() => (readPref('ws.tab') === 'macro' ? 'macro' : 'board'))
  const [chatOpen, setChatOpen] = useState(() => readPref('ws.chatOpen') === '1')
  const [status, setStatus] = useState<Record<Tab, SaveStatus>>({ board: 'idle', macro: 'idle' })

  const chat = useChat(idea.id)
  /** Claude changed the board while another tab was visible. */
  const [boardBadge, setBoardBadge] = useState(false)

  // Leaving the workspace ends the Claude process (history + session are kept).
  useEffect(() => () => void api.chat.close(idea.id), [idea.id])

  useEffect(() => {
    const onChanged = (e: Event): void => {
      if ((e as CustomEvent<{ ideaId: number }>).detail?.ideaId === idea.id) setBoardBadge(true)
    }
    window.addEventListener(BOARD_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(BOARD_CHANGED_EVENT, onChanged)
  }, [idea.id])
  useEffect(() => {
    if (tab === 'board') setBoardBadge(false)
  }, [tab, boardBadge])

  const primary = idea.projects.find((l) => l.isPrimary)
  const primaryProject = primary ? projects.find((p) => p.id === primary.projectId) : undefined

  const reportStatus =
    (which: Tab) =>
    (s: SaveStatus, err?: unknown): void => {
      setStatus((cur) => (cur[which] === s ? cur : { ...cur, [which]: s }))
      if (s === 'error') {
        const what = which === 'board' ? 'o board' : 'o plano macro'
        toast.error(`Não foi possível salvar ${what}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  // Stable callbacks (children keep them in refs anyway).
  const [onBoardStatus] = useState(() => reportStatus('board'))
  const [onMacroStatus] = useState(() => reportStatus('macro'))

  const switchTab = (t: Tab): void => {
    if (t === tab) return
    void flushAll()
    setTab(t)
    writePref('ws.tab', t)
  }

  const toggleChat = (): void => {
    setChatOpen((v) => {
      writePref('ws.chatOpen', v ? '0' : '1')
      return !v
    })
  }

  const back = async (): Promise<void> => {
    await flushAll()
    onBack()
  }

  const openSettings = async (): Promise<void> => {
    await flushAll()
    onOpenSettings()
  }

  return (
    <div className="ws">
      <header className="ws-header">
        <button className="btn btn-ghost ws-back" onClick={() => void back()} title="Voltar às ideias">
          <IconArrowLeft /> Ideias
        </button>
        <div className="ws-head-main">
          <div className="ws-title-row">
            <TitleInput idea={idea} />
            <StatusBadge status={idea.status} />
          </div>
          <div className="ws-meta-row">
            <ProjectChips idea={idea} projects={projects} />
            {primaryProject && (
              <span className="ws-folder mono" title={`Pasta do projeto principal: ${primaryProject.folderPath}`}>
                <IconFolder size={13} />
                {primaryProject.folderPath}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="ws-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'board'}
          className={`ws-tab${tab === 'board' ? ' active' : ''}`}
          onClick={() => switchTab('board')}
        >
          <IconBoard /> Board
          {boardBadge && tab !== 'board' && <span className="ws-tab-dot" title="O Claude alterou o board" />}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'macro'}
          className={`ws-tab${tab === 'macro' ? ' active' : ''}`}
          onClick={() => switchTab('macro')}
        >
          <IconDoc /> Plano macro
        </button>
        <button role="tab" className="ws-tab" disabled title="Grafo de tarefas — chega na Fase 4">
          <IconTasks /> Tarefas <span className="ws-soon">Fase 4</span>
        </button>
        <span className="ws-tabs-spacer" />
        <SaveIndicator status={status[tab]} onRetry={() => void flushAll()} />
        <button
          className={`icon-btn ws-chat-toggle${chatOpen ? ' on' : ''}`}
          title={chatOpen ? 'Fechar painel do chat' : 'Abrir painel do chat'}
          onClick={toggleChat}
        >
          <IconPanelRight />
        </button>
      </div>

      <div className="ws-body">
        <div className="ws-main">
          <section className={`ws-pane${tab === 'board' ? ' active' : ''}`} inert={tab !== 'board'}>
            <Suspense fallback={<div className="ws-placeholder">Carregando board…</div>}>
              <Board ideaId={idea.id} active={tab === 'board'} onStatus={onBoardStatus} />
            </Suspense>
          </section>
          <section className={`ws-pane${tab === 'macro' ? ' active' : ''}`} inert={tab !== 'macro'}>
            <MacroPlanTab ideaId={idea.id} active={tab === 'macro'} onStatus={onMacroStatus} />
          </section>
        </div>
        {chatOpen ? (
          <ChatPanel chat={chat} onCollapse={toggleChat} onOpenSettings={() => void openSettings()} />
        ) : (
          <ChatRail onToggle={toggleChat} busy={chat.busy} />
        )}
      </div>
    </div>
  )
}

function TitleInput({ idea }: { idea: Idea }): React.JSX.Element {
  const toast = useToast()
  const [value, setValue] = useState(idea.title)
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setValue(idea.title)
  }, [idea.title])

  const save = (): void => {
    const t = value.trim()
    if (!t) {
      setValue(idea.title)
      toast.error('O título não pode ficar vazio.')
      return
    }
    if (t !== idea.title) api.ideas.update(idea.id, { title: t }).catch((err: unknown) => toast.error(err))
  }

  return (
    <input
      className="ws-title"
      value={value}
      maxLength={300}
      aria-label="Título da ideia"
      onChange={(e) => setValue(e.target.value)}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setValue(idea.title)
          focused.current = false
          requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.blur())
        }
      }}
    />
  )
}

function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }): React.JSX.Element {
  if (status === 'error') {
    return (
      <button className="ws-save error" onClick={onRetry} title="Tentar salvar de novo">
        Erro ao salvar · tentar de novo
      </button>
    )
  }
  const busy = status === 'pending' || status === 'saving'
  return (
    <span className={`ws-save${busy ? ' busy' : ''}`} role="status" aria-live="polite">
      {busy ? (
        <>
          <span className="ws-save-dot" /> Salvando…
        </>
      ) : (
        <>
          <IconCheck size={13} /> Salvo
        </>
      )}
    </span>
  )
}

/** Collapsed chat: a thin rail on the right. */
function ChatRail({ onToggle, busy }: { onToggle: () => void; busy: boolean }): React.JSX.Element {
  return (
    <aside className="ws-chat collapsed">
      <button className="ws-chat-rail" onClick={onToggle} title="Abrir chat com Claude">
        <IconChat />
        <span>Chat</span>
        {busy && <span className="ws-chat-rail-busy" title="O Claude está respondendo" />}
      </button>
    </aside>
  )
}
