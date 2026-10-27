import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { useAppData } from './hooks/useAppData'
import { IdeaList, QuickAdd } from './components/IdeaList'
import { IdeaPanel } from './components/IdeaPanel'
import { ProjectGrid } from './components/ProjectGrid'
import { ProjectDialog } from './components/ProjectDialog'
import { ConfirmDialog } from './components/Modal'
import { SettingsView } from './components/SettingsView'
import { useToast } from './components/Toasts'
import {
  IconArchive,
  IconEdit,
  IconFolder,
  IconHome,
  IconList,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSpark,
  IconTrash,
  IconX
} from './components/Icons'
import { filterIdeas } from './lib/search'
import { formatAccelerator } from './lib/accelerator'

const api = window.api

type View =
  | { kind: 'home' }
  | { kind: 'all' }
  | { kind: 'archived' }
  | { kind: 'project'; id: number }
  | { kind: 'settings' }

export function App(): React.JSX.Element {
  const toast = useToast()
  const { ideas, projects, settings, info, loaded } = useAppData()
  const [view, setView] = useState<View>({ kind: 'home' })
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [projectDialog, setProjectDialog] = useState<{ project?: Project } | null>(null)
  const [confirmRemoveProject, setConfirmRemoveProject] = useState<Project | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const active = useMemo(() => ideas.filter((i) => i.status !== 'arquivada'), [ideas])
  const loose = useMemo(() => active.filter((i) => i.projects.length === 0), [active])
  const archived = useMemo(() => ideas.filter((i) => i.status === 'arquivada'), [ideas])
  const selectedIdea = ideas.find((i) => i.id === selectedId) ?? null
  const currentProject = view.kind === 'project' ? projectsById.get(view.id) : undefined

  // Leave a project view if the project was removed.
  useEffect(() => {
    if (view.kind === 'project' && loaded && !projectsById.has(view.id)) setView({ kind: 'home' })
  }, [view, projectsById, loaded])

  // Keyboard: Ctrl+F / Ctrl+K focus search, Esc clears search or closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'k')) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.key === 'Escape') {
        if (document.activeElement === searchRef.current && query) setQuery('')
        else if (selectedId != null) setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query, selectedId])

  const go = (v: View): void => {
    setView(v)
    setQuery('')
    if (v.kind === 'settings') setSelectedId(null)
  }

  const addIdea = async (title: string, projectId?: number): Promise<void> => {
    try {
      const idea = await api.ideas.create({ title })
      if (projectId) await api.ideas.linkProject(idea.id, projectId)
    } catch (err) {
      toast.error(err)
      throw err
    }
  }

  const removeProject = async (p: Project): Promise<void> => {
    try {
      await api.projects.remove(p.id)
      toast.info(`Projeto "${p.name}" removido. As ideias foram mantidas.`)
      go({ kind: 'home' })
    } catch (err) {
      toast.error(err)
    }
  }

  const searching = query.trim() !== '' && view.kind !== 'settings'
  const results = searching ? filterIdeas(ideas, query) : []

  const listProps = {
    projectsById,
    selectedId,
    onSelect: (id: number) => setSelectedId((cur) => (cur === id ? null : id))
  }

  let title = ''
  let content: React.ReactNode = null

  if (!loaded) {
    content = <div className="empty">Carregando…</div>
  } else if (searching) {
    title = 'Busca'
    content = (
      <section className="section">
        <div className="section-head">
          <h2>
            {results.length} {results.length === 1 ? 'resultado' : 'resultados'} para “{query.trim()}”
          </h2>
        </div>
        <IdeaList {...listProps} ideas={results} empty="Nenhuma ideia encontrada." />
      </section>
    )
  } else if (view.kind === 'home') {
    title = 'Início'
    content = (
      <div className="home">
        <section className="section">
          <div className="section-head">
            <h2>
              Ideias soltas <span className="count">{loose.length}</span>
            </h2>
          </div>
          <QuickAdd placeholder="Anotar uma ideia…" onAdd={(t) => addIdea(t)} />
          <IdeaList
            {...listProps}
            ideas={loose}
            empty={<EmptyLoose hotkey={info?.hotkey.registered ? settings?.hotkey : undefined} />}
          />
        </section>
        <section className="section">
          <div className="section-head">
            <h2>
              Projetos <span className="count">{projects.length}</span>
            </h2>
          </div>
          <ProjectGrid
            projects={projects}
            onOpen={(id) => go({ kind: 'project', id })}
            onCreate={() => setProjectDialog({})}
          />
        </section>
      </div>
    )
  } else if (view.kind === 'all') {
    title = 'Todas as ideias'
    content = (
      <section className="section narrow">
        <QuickAdd placeholder="Anotar uma ideia…" onAdd={(t) => addIdea(t)} />
        <IdeaList {...listProps} ideas={active} empty="Nenhuma ideia ainda." />
      </section>
    )
  } else if (view.kind === 'archived') {
    title = 'Arquivadas'
    content = (
      <section className="section narrow">
        <IdeaList {...listProps} ideas={archived} empty="Nada arquivado." />
      </section>
    )
  } else if (view.kind === 'project' && currentProject) {
    const p = currentProject
    const projectIdeas = active.filter((i) => i.projects.some((l) => l.projectId === p.id))
    title = p.name
    content = (
      <section className="section narrow">
        <div className="project-header">
          <div className="project-header-info">
            <span className="project-icon">
              <IconFolder size={18} />
            </span>
            <span className="project-path mono" title={p.folderPath}>
              {p.folderPath}
            </span>
          </div>
          <div className="project-header-actions">
            <button className="btn" onClick={() => setProjectDialog({ project: p })}>
              <IconEdit /> Editar
            </button>
            <button className="btn btn-danger-ghost" onClick={() => setConfirmRemoveProject(p)}>
              <IconTrash /> Remover
            </button>
          </div>
        </div>
        <QuickAdd placeholder={`Nova ideia em ${p.name}…`} onAdd={(t) => addIdea(t, p.id)} />
        <IdeaList
          {...listProps}
          ideas={projectIdeas}
          hideProjectId={p.id}
          empty="Nenhuma ideia vinculada a este projeto ainda."
        />
      </section>
    )
  } else if (view.kind === 'settings') {
    title = 'Configurações'
    content = <SettingsView settings={settings} info={info} />
  }

  return (
    <div className={`app${selectedIdea ? ' with-panel' : ''}`}>
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <IconSpark size={16} />
          </span>
          Visualize
        </div>

        <div className="nav">
          <NavItem
            icon={<IconHome />}
            label="Início"
            count={loose.length}
            active={view.kind === 'home' && !searching}
            onClick={() => go({ kind: 'home' })}
          />
          <NavItem
            icon={<IconList />}
            label="Todas as ideias"
            count={active.length}
            active={view.kind === 'all' && !searching}
            onClick={() => go({ kind: 'all' })}
          />
          <NavItem
            icon={<IconArchive />}
            label="Arquivadas"
            count={archived.length}
            active={view.kind === 'archived' && !searching}
            onClick={() => go({ kind: 'archived' })}
          />
        </div>

        <div className="nav-heading">
          <span>Projetos</span>
          <button className="icon-btn" title="Novo projeto" onClick={() => setProjectDialog({})}>
            <IconPlus size={14} />
          </button>
        </div>
        <div className="nav nav-projects">
          {projects.length === 0 && <span className="nav-empty">Nenhum projeto</span>}
          {projects.map((p) => (
            <NavItem
              key={p.id}
              icon={<IconFolder />}
              label={p.name}
              count={p.ideaCount}
              title={p.folderPath}
              active={view.kind === 'project' && view.id === p.id && !searching}
              onClick={() => go({ kind: 'project', id: p.id })}
            />
          ))}
        </div>

        <div className="sidebar-foot">
          {settings && info && (info.hotkey.registered ? (
            <div className="hotkey-hint" title="Atalho global para capturar uma ideia">
              <kbd>{formatAccelerator(settings.hotkey)}</kbd>
              <span>nova ideia</span>
            </div>
          ) : (
            <button
              className="hotkey-hint warn"
              title="O atalho está em uso por outro aplicativo"
              onClick={() => go({ kind: 'settings' })}
            >
              <kbd>{formatAccelerator(settings.hotkey)}</kbd>
              <span>em uso · trocar</span>
            </button>
          ))}
          <NavItem
            icon={<IconSettings />}
            label="Configurações"
            active={view.kind === 'settings'}
            onClick={() => go({ kind: 'settings' })}
          />
        </div>
      </nav>

      <main className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="search">
            <IconSearch />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar ideias  (Ctrl+F)"
            />
            {query && (
              <button className="icon-btn" onClick={() => setQuery('')} title="Limpar busca">
                <IconX size={14} />
              </button>
            )}
          </div>
        </header>
        <div className="content">{content}</div>
      </main>

      {selectedIdea && (
        <IdeaPanel
          key={selectedIdea.id}
          idea={selectedIdea}
          projects={projects}
          onClose={() => setSelectedId(null)}
          onOpenProject={(id) => go({ kind: 'project', id })}
        />
      )}

      {projectDialog && (
        <ProjectDialog
          project={projectDialog.project}
          onClose={() => setProjectDialog(null)}
          onSaved={(p) => {
            if (!projectDialog.project) go({ kind: 'project', id: p.id })
          }}
        />
      )}

      {confirmRemoveProject && (
        <ConfirmDialog
          title="Remover projeto?"
          message={
            <>
              O projeto <strong>{confirmRemoveProject.name}</strong> sai do Visualize. As ideias
              vinculadas <strong>não</strong> são excluídas, e nada é apagado da pasta no disco.
            </>
          }
          confirmLabel="Remover"
          danger
          onCancel={() => setConfirmRemoveProject(null)}
          onConfirm={() => {
            const p = confirmRemoveProject
            setConfirmRemoveProject(null)
            void removeProject(p)
          }}
        />
      )}
    </div>
  )
}

function NavItem({
  icon,
  label,
  count,
  active,
  title,
  onClick
}: {
  icon: React.ReactNode
  label: string
  count?: number
  active?: boolean
  title?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button className={`nav-item${active ? ' active' : ''}`} onClick={onClick} title={title}>
      {icon}
      <span className="nav-label">{label}</span>
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </button>
  )
}

function EmptyLoose({ hotkey }: { hotkey?: string }): React.JSX.Element {
  return (
    <div className="empty-loose">
      <IconSpark size={22} />
      <p>Nenhuma ideia solta.</p>
      {hotkey && (
        <p className="muted small">
          Pressione <kbd>{formatAccelerator(hotkey)}</kbd> em qualquer app para anotar uma.
        </p>
      )}
    </div>
  )
}
