import { useState } from 'react'
import type { Project } from '@shared/types'
import { Modal } from './Modal'
import { IconFolder } from './Icons'
import { basename } from '../lib/format'
import { useToast } from './Toasts'

const api = window.api

interface Props {
  /** Existing project to edit; omit to create. */
  project?: Project
  onClose: () => void
  onSaved?: (project: Project) => void
}

export function ProjectDialog({ project, onClose, onSaved }: Props): React.JSX.Element {
  const toast = useToast()
  const [name, setName] = useState(project?.name ?? '')
  const [folder, setFolder] = useState(project?.folderPath ?? '')
  const [saving, setSaving] = useState(false)

  const pick = async (): Promise<void> => {
    try {
      const chosen = await api.projects.pickFolder(folder || undefined)
      if (!chosen) return
      setFolder(chosen)
      if (!name.trim()) setName(basename(chosen))
    } catch (err) {
      toast.error(err)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const saved = project
        ? await api.projects.update(project.id, { name, folderPath: folder })
        : await api.projects.create({ name, folderPath: folder })
      onSaved?.(saved)
      onClose()
    } catch (err) {
      toast.error(err)
    } finally {
      setSaving(false)
    }
  }

  const canSave = name.trim() !== '' && folder.trim() !== '' && !saving

  return (
    <Modal
      title={project ? 'Editar projeto' : 'Novo projeto'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
            {project ? 'Salvar' : 'Criar projeto'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) void save()
        }}
      >
        <label className="field">
          <span className="field-label">Pasta no computador</span>
          <div className="input-with-button">
            <input
              className="input mono"
              value={folder}
              placeholder="C:\Projetos\meu-sistema"
              onChange={(e) => setFolder(e.target.value)}
            />
            <button type="button" className="btn" onClick={() => void pick()}>
              <IconFolder /> Escolher…
            </button>
          </div>
          <span className="field-hint">O Claude vai trabalhar nesta pasta nas próximas fases.</span>
        </label>
        <label className="field">
          <span className="field-label">Nome</span>
          <input
            className="input"
            value={name}
            placeholder="Nome do projeto"
            onChange={(e) => setName(e.target.value)}
            autoFocus={!!project}
          />
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
