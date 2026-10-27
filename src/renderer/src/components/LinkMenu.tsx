import { useEffect, useRef } from 'react'
import type { Project } from '@shared/types'
import { IconFolder, IconPlus } from './Icons'

/** Dropdown to link an idea to an existing project or start a new one. */
export function LinkMenu({
  projects,
  onPick,
  onNew,
  onClose,
  className
}: {
  projects: Project[]
  onPick: (id: number) => void
  onNew: () => void
  onClose: () => void
  className?: string
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
    <div className={`menu${className ? ` ${className}` : ''}`} ref={ref} role="menu">
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
