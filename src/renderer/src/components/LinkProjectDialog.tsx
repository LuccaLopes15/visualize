import { useState } from 'react'
import type { Idea, Project } from '@shared/types'
import { Modal } from './Modal'
import { ProjectDialog } from './ProjectDialog'
import { IconFolder, IconPlus } from './Icons'
import { useToast } from './Toasts'

const api = window.api

interface Props {
  idea: Idea
  projects: Project[]
  onClose: () => void
  /** Called with the updated idea once it is linked. */
  onLinked: (idea: Idea) => void
}

/**
 * Shown when opening the workspace of a "solta" idea: the workspace needs a
 * project (the Claude chat of Fase 3 runs in the primary project's folder).
 */
export function LinkProjectDialog({ idea, projects, onClose, onLinked }: Props): React.JSX.Element {
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)

  const link = async (projectId: number): Promise<void> => {
    setBusy(true)
    try {
      onLinked(await api.ideas.linkProject(idea.id, projectId))
    } catch (err) {
      toast.error(err)
      setBusy(false)
    }
  }

  if (creating) {
    return (
      <ProjectDialog onClose={() => setCreating(false)} onSaved={(p) => void link(p.id)} />
    )
  }

  return (
    <Modal
      title="Vincular a um projeto"
      onClose={onClose}
      width={480}
      footer={
        <button className="btn" onClick={onClose}>
          Cancelar
        </button>
      }
    >
      <p className="confirm-message link-prompt-text">
        Para abrir o workspace de <strong>{idea.title}</strong>, vincule a ideia a um projeto. O
        projeto principal define a pasta onde o Claude vai trabalhar.
      </p>
      <div className="link-prompt-list">
        {projects.map((p) => (
          <button key={p.id} className="menu-item" disabled={busy} onClick={() => void link(p.id)}>
            <IconFolder />
            <span className="menu-item-text">
              <span>{p.name}</span>
              <span className="link-path">{p.folderPath}</span>
            </span>
          </button>
        ))}
        {projects.length > 0 && <div className="menu-sep" />}
        <button className="menu-item accent" disabled={busy} onClick={() => setCreating(true)}>
          <IconPlus /> Novo projeto…
        </button>
      </div>
    </Modal>
  )
}
