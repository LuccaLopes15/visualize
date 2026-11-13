import type { Project } from '@shared/types'
import { IconFolder, IconPlus } from './Icons'

interface Props {
  projects: Project[]
  onOpen: (id: number) => void
  /** Omit to hide the "Novo projeto" card (search results). */
  onCreate?: () => void
}

export function ProjectGrid({ projects, onOpen, onCreate }: Props): React.JSX.Element {
  return (
    <div className="project-grid">
      {projects.map((p) => (
        <button key={p.id} className="project-card" onClick={() => onOpen(p.id)}>
          <div className="project-card-top">
            <span className="project-icon">
              <IconFolder size={18} />
            </span>
            <span className="project-count" title="Ideias vinculadas (não arquivadas)">
              {p.ideaCount} {p.ideaCount === 1 ? 'ideia' : 'ideias'}
            </span>
          </div>
          <span className="project-name">{p.name}</span>
          <span className="project-path" title={p.folderPath}>
            {p.folderPath}
          </span>
        </button>
      ))}
      {onCreate && (
        <button className="project-card project-card-new" onClick={onCreate}>
          <IconPlus size={20} />
          <span>Novo projeto</span>
        </button>
      )}
    </div>
  )
}
