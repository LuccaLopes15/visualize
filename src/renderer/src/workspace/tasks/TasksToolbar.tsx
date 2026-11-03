import { useEffect, useRef, useState } from 'react'
import { IconPlus } from '../../components/Icons'

export interface LinkedProject {
  id: number
  name: string
  isPrimary: boolean
}

/** "+ História": one linked project -> creates right away; several -> pick the project first (primary first). */
export function AddStoryButton({
  linked,
  onPick
}: {
  linked: LinkedProject[]
  onPick: (projectId: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const none = linked.length === 0
  const click = (): void => {
    if (linked.length === 1) onPick(linked[0].id)
    else setOpen((v) => !v)
  }
  return (
    <span className="tk-addstory" ref={ref}>
      <button
        className="btn btn-primary"
        onClick={click}
        disabled={none}
        title={
          none
            ? 'Vincule um projeto à ideia (chip + Projeto no cabeçalho) para criar histórias'
            : linked.length > 1
              ? 'Nova história: escolha o projeto'
              : 'Nova história'
        }
      >
        <IconPlus size={14} /> História
      </button>
      {open && (
        <div className="menu tk-addstory-menu" role="menu">
          <div className="menu-empty">Projeto da história</div>
          {linked.map((p) => (
            <button
              key={p.id}
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onPick(p.id)
              }}
            >
              {p.name}
              {p.isPrimary && <span className="tk-hint"> · principal</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

export function EmptyState({
  linked,
  onPick,
  onOpenChat
}: {
  linked: LinkedProject[]
  onPick: (projectId: number) => void
  onOpenChat: () => void
}): React.JSX.Element {
  return (
    <div className="tk-empty">
      <div className="tk-empty-card">
        <h3>Ainda não há tarefas</h3>
        <p>
          Monte o plano de execução: histórias (uma por projeto, quando fizer sentido), as tarefas de cada uma e o que
          depende do quê.
        </p>
        <div className="tk-empty-actions">
          <AddStoryButton linked={linked} onPick={onPick} />
        </div>
        <p className="tk-hint">
          Ou peça ao Claude no chat: <em>“quebra o plano macro em tarefas”</em>.{' '}
          <button className="link-btn" onClick={onOpenChat}>
            Abrir chat
          </button>
        </p>
      </div>
    </div>
  )
}
