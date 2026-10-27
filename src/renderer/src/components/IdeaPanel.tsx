import { useEffect, useRef, useState } from 'react'
import { IDEA_STATUSES, IDEA_STATUS_LABELS, type Idea, type IdeaStatus, type Project } from '@shared/types'
import { StatusBadge } from './StatusBadge'
import { ConfirmDialog } from './Modal'
import { ProjectDialog } from './ProjectDialog'
import { IconArchive, IconFolder, IconLink, IconPlus, IconRestore, IconStar, IconTrash, IconX } from './Icons'
import { fullDate } from '../lib/format'
import { useToast } from './Toasts'

const api = window.api

interface Props {
  idea: Idea
  projects: Project[]
  onClose: () => void
  onOpenProject: (id: number) => void
}

/** Side panel to edit an idea: title/body inline, status, project links, archive/delete. */
export function IdeaPanel({ idea, projects, onClose, onOpenProject }: Props): React.JSX.Element {
  const toast = useToast()
  const [title, setTitle] = useState(idea.title)
  const [body, setBody] = useState(idea.body)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [linkMenu, setLinkMenu] = useState(false)
  const [newProject, setNewProject] = useState(false)
  const titleFocused = useRef(false)
  const bodyFocused = useRef(false)

  // Follow external updates unless the user is editing that field.
  useEffect(() => {
    if (!titleFocused.current) setTitle(idea.title)
  }, [idea.title])
  useEffect(() => {
    if (!bodyFocused.current) setBody(idea.body)
  }, [idea.body])

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      toast.error(err)
    }
  }

  const saveTitle = (): void => {
    const t = title.trim()
    if (!t) {
      setTitle(idea.title)
      toast.error('O título não pode ficar vazio.')
      return
    }
    if (t !== idea.title) void run(() => api.ideas.update(idea.id, { title: t }))
  }

  const saveBody = (): void => {
    if (body.trim() !== idea.body) void run(() => api.ideas.update(idea.id, { body }))
  }

  const setStatus = (status: IdeaStatus): void => {
    void run(() => api.ideas.update(idea.id, { status }))
  }

  const projectsById = new Map(projects.map((p) => [p.id, p]))
  const linkedIds = new Set(idea.projects.map((l) => l.projectId))
  const available = projects.filter((p) => !linkedIds.has(p.id))
  const archived = idea.status === 'arquivada'

  return (
    <aside className="panel" aria-label="Detalhes da ideia">
      <header className="panel-header">
        <StatusBadge status={idea.status} />
        <span className="panel-dates" title={`Atualizada ${fullDate(idea.updatedAt)}`}>
          Criada {fullDate(idea.createdAt)}
        </span>
        <button className="icon-btn" onClick={onClose} title="Fechar (Esc)">
          <IconX />
        </button>
      </header>

      <div className="panel-body">
        <textarea
          className="panel-title"
          value={title}
          rows={1}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
          onFocus={() => (titleFocused.current = true)}
          onBlur={() => {
            titleFocused.current = false
            saveTitle()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
          ref={(el) => {
            if (el) {
              el.style.height = 'auto'
              el.style.height = `${el.scrollHeight}px`
            }
          }}
        />

        <textarea
          className="panel-text"
          placeholder="Detalhes, contexto, links…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onFocus={() => (bodyFocused.current = true)}
          onBlur={() => {
            bodyFocused.current = false
            saveBody()
          }}
        />

        <section className="panel-section">
          <h3>Status</h3>
          <select
            className="input"
            value={idea.status}
            onChange={(e) => setStatus(e.target.value as IdeaStatus)}
          >
            {IDEA_STATUSES.map((s) => (
              <option key={s} value={s}>
                {IDEA_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </section>

        <section className="panel-section">
          <h3>Projetos vinculados</h3>
          {idea.projects.length === 0 && (
            <p className="muted small">Ideia solta — ainda sem projeto.</p>
          )}
          <ul className="link-list">
            {idea.projects.map((l) => {
              const p = projectsById.get(l.projectId)
              if (!p) return null
              return (
                <li key={l.projectId} className="link-item">
                  <button
                    className={`star-btn${l.isPrimary ? ' on' : ''}`}
                    title={l.isPrimary ? 'Projeto principal' : 'Tornar principal'}
                    disabled={l.isPrimary}
                    onClick={() => void run(() => api.ideas.setPrimaryProject(idea.id, p.id))}
                  >
                    <IconStar filled={l.isPrimary} />
                  </button>
                  <button className="link-name" onClick={() => onOpenProject(p.id)} title={p.folderPath}>
                    <span>{p.name}</span>
                    <span className="link-path">{p.folderPath}</span>
                  </button>
                  {l.isPrimary && <span className="tag">Principal</span>}
                  <button
                    className="icon-btn"
                    title="Desvincular"
                    onClick={() => void run(() => api.ideas.unlinkProject(idea.id, p.id))}
                  >
                    <IconX size={14} />
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="link-add">
            <button className="btn btn-ghost" onClick={() => setLinkMenu((v) => !v)}>
              <IconLink /> Vincular a projeto
            </button>
            {linkMenu && (
              <LinkMenu
                projects={available}
                onPick={(projectId) => {
                  setLinkMenu(false)
                  void run(() => api.ideas.linkProject(idea.id, projectId))
                }}
                onNew={() => {
                  setLinkMenu(false)
                  setNewProject(true)
                }}
                onClose={() => setLinkMenu(false)}
              />
            )}
          </div>
        </section>
      </div>

      <footer className="panel-footer">
        {archived ? (
          <button className="btn" onClick={() => void run(() => api.ideas.unarchive(idea.id))}>
            <IconRestore /> Desarquivar
          </button>
        ) : (
          <button className="btn" onClick={() => void run(() => api.ideas.archive(idea.id))}>
            <IconArchive /> Arquivar
          </button>
        )}
        <button className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>
          <IconTrash /> Excluir
        </button>
      </footer>

      {confirmDelete && (
        <ConfirmDialog
          title="Excluir ideia?"
          message={
            <>
              <strong>{idea.title}</strong> será excluída permanentemente. Se quiser só tirar da frente,
              use <em>Arquivar</em>.
            </>
          }
          confirmLabel="Excluir"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void run(async () => {
              await api.ideas.remove(idea.id)
              onClose()
            })
          }}
        />
      )}

      {newProject && (
        <ProjectDialog
          onClose={() => setNewProject(false)}
          onSaved={(p) => void run(() => api.ideas.linkProject(idea.id, p.id))}
        />
      )}
    </aside>
  )
}

function LinkMenu({
  projects,
  onPick,
  onNew,
  onClose
}: {
  projects: Project[]
  onPick: (id: number) => void
  onNew: () => void
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div className="menu" ref={ref} role="menu">
      {projects.length === 0 && <div className="menu-empty">Nenhum outro projeto</div>}
      {projects.map((p) => (
        <button key={p.id} className="menu-item" role="menuitem" onClick={() => onPick(p.id)}>
          <IconFolder />
          <span className="menu-item-text">
            <span>{p.name}</span>
            <span className="link-path">{p.folderPath}</span>
          </span>
        </button>
      ))}
      <div className="menu-sep" />
      <button className="menu-item accent" role="menuitem" onClick={onNew}>
        <IconPlus /> Novo projeto…
      </button>
    </div>
  )
}
