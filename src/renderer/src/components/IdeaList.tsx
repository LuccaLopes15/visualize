import { useState, type ReactNode } from 'react'
import type { Idea, Project } from '@shared/types'
import { StatusBadge } from './StatusBadge'
import { relativeTime } from '../lib/format'
import { IconPlus } from './Icons'

interface IdeaListProps {
  ideas: Idea[]
  projectsById: Map<number, Project>
  selectedId: number | null
  onSelect: (id: number) => void
  empty: ReactNode
  /** Hide the project chips (e.g. inside a project view, for the current project). */
  hideProjectId?: number
}

export function IdeaList({
  ideas,
  projectsById,
  selectedId,
  onSelect,
  empty,
  hideProjectId
}: IdeaListProps): React.JSX.Element {
  if (ideas.length === 0) return <div className="empty">{empty}</div>
  return (
    <ul className="idea-list">
      {ideas.map((idea) => {
        const chips = idea.projects.filter((l) => l.projectId !== hideProjectId)
        return (
          <li key={idea.id}>
            <button
              className={`idea-row${selectedId === idea.id ? ' selected' : ''}${
                idea.status === 'arquivada' ? ' archived' : ''
              }`}
              onClick={() => onSelect(idea.id)}
            >
              <div className="idea-row-main">
                <span className="idea-row-title">{idea.title}</span>
                {idea.body && <span className="idea-row-body">{idea.body}</span>}
              </div>
              <div className="idea-row-meta">
                {chips.map((l) => {
                  const p = projectsById.get(l.projectId)
                  if (!p) return null
                  return (
                    <span
                      key={l.projectId}
                      className={`chip${l.isPrimary ? ' chip-primary' : ''}`}
                      title={l.isPrimary ? 'Projeto principal' : undefined}
                    >
                      {p.name}
                    </span>
                  )
                })}
                <StatusBadge status={idea.status} />
                <span className="idea-row-time" title={new Date(idea.createdAt).toLocaleString('pt-BR')}>
                  {relativeTime(idea.createdAt)}
                </span>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** Inline "jot an idea" input shown above lists in the hub. */
export function QuickAdd({
  placeholder,
  onAdd
}: {
  placeholder: string
  onAdd: (title: string) => Promise<void>
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="quick-add"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!value.trim() || busy) return
        setBusy(true)
        try {
          await onAdd(value)
          setValue('')
        } catch {
          // onAdd reports its own errors; keep the text so nothing is lost.
        } finally {
          setBusy(false)
        }
      }}
    >
      <IconPlus />
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} maxLength={300} />
      {value.trim() && (
        <span className="quick-add-hint">
          <kbd>Enter</kbd>
        </span>
      )}
    </form>
  )
}
