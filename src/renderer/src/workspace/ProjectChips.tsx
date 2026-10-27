import { useState } from 'react'
import type { Idea, Project } from '@shared/types'
import { LinkMenu } from '../components/LinkMenu'
import { ProjectDialog } from '../components/ProjectDialog'
import { IconPlus, IconStar, IconX } from '../components/Icons'
import { useToast } from '../components/Toasts'

const api = window.api

/**
 * Linked projects as chips in the workspace header: star = primary (click to
 * make primary), x = unlink, + = link another (existing or new). The last
 * project can't be unlinked here: the workspace needs one.
 */
export function ProjectChips({ idea, projects }: { idea: Idea; projects: Project[] }): React.JSX.Element {
  const toast = useToast()
  const [menu, setMenu] = useState(false)
  const [creating, setCreating] = useState(false)
  const byId = new Map(projects.map((p) => [p.id, p]))
  const linked = new Set(idea.projects.map((l) => l.projectId))
  const available = projects.filter((p) => !linked.has(p.id))
  const single = idea.projects.length <= 1

  const run = (fn: () => Promise<unknown>): void => {
    fn().catch((err: unknown) => toast.error(err))
  }

  return (
    <div className="ws-chips">
      {idea.projects.map((l) => {
        const p = byId.get(l.projectId)
        if (!p) return null
        return (
          <span key={p.id} className={`ws-chip${l.isPrimary ? ' primary' : ''}`} title={p.folderPath}>
            <button
              className="ws-chip-star"
              disabled={l.isPrimary}
              title={l.isPrimary ? 'Projeto principal' : 'Tornar principal'}
              onClick={() => run(() => api.ideas.setPrimaryProject(idea.id, p.id))}
            >
              <IconStar size={13} filled={l.isPrimary} />
            </button>
            <span className="ws-chip-name">{p.name}</span>
            <button
              className="ws-chip-x"
              disabled={single}
              title={single ? 'O workspace precisa de pelo menos um projeto' : 'Desvincular'}
              onClick={() => run(() => api.ideas.unlinkProject(idea.id, p.id))}
            >
              <IconX size={12} />
            </button>
          </span>
        )
      })}
      <span className="ws-chip-add">
        <button className="ws-chip-add-btn" title="Vincular outro projeto" onClick={() => setMenu((v) => !v)}>
          <IconPlus size={13} /> Projeto
        </button>
        {menu && (
          <LinkMenu
            className="ws-link-menu"
            projects={available}
            onPick={(projectId) => {
              setMenu(false)
              run(() => api.ideas.linkProject(idea.id, projectId))
            }}
            onNew={() => {
              setMenu(false)
              setCreating(true)
            }}
            onClose={() => setMenu(false)}
          />
        )}
      </span>
      {creating && (
        <ProjectDialog
          onClose={() => setCreating(false)}
          onSaved={(p) => run(() => api.ideas.linkProject(idea.id, p.id))}
        />
      )}
    </div>
  )
}
