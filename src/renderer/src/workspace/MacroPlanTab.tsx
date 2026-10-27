import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { SaveStatus } from '../lib/autosave'
import { useAutosave } from '../hooks/useAutosave'
import { renderMarkdown } from '../lib/markdown'
import { continueList, indentLines, type Edit } from '../lib/mdEditing'
import { readPref, writePref } from '../lib/prefs'

const api = window.api

type Mode = 'edit' | 'split' | 'preview'
const MODES: { id: Mode; label: string }[] = [
  { id: 'edit', label: 'Editar' },
  { id: 'split', label: 'Dividido' },
  { id: 'preview', label: 'Visualizar' }
]

const TEMPLATE = `# Objetivo

O que esta ideia resolve e para quem.

## Escopo

- Inclui:
- Fora do escopo:

## Abordagem

1.

## Riscos e dúvidas

-
`

interface Props {
  ideaId: number
  active: boolean
  onStatus: (status: SaveStatus, error?: unknown) => void
}

/** Plano macro: markdown editor (textarea) + sanitized live preview. */
export function MacroPlanTab({ ideaId, active, onStatus }: Props): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>(() => {
    const m = readPref('ws.macroMode')
    return m === 'edit' || m === 'preview' ? m : 'split'
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** Shown for a few seconds after Claude rewrites the plan. */
  const [claudeNotice, setClaudeNotice] = useState(false)

  const autosave = useAutosave<string>(
    async (markdown) => {
      await api.macro.save(ideaId, markdown)
    },
    800,
    onStatus
  )

  useEffect(() => {
    let alive = true
    api.macro
      .get(ideaId)
      .then((plan) => alive && setText(plan.markdown))
      .catch((err: unknown) => alive && setLoadError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [ideaId])

  // Claude rewrote the plan (main already flushed our pending edits before
  // writing): show the new content, drop anything still queued.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.macro.onUpdated((e) => {
      if (e.ideaId !== ideaId) return
      autosave.cancel()
      setText(e.markdown)
      setClaudeNotice(true)
      clearTimeout(timer)
      timer = setTimeout(() => setClaudeNotice(false), 6000)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [ideaId]) // autosave.cancel only touches the stable Autosaver

  useEffect(() => {
    if (active && text !== null && mode !== 'preview') textareaRef.current?.focus()
    // Only when the tab becomes visible / finishes loading.
  }, [active, text === null])

  const deferred = useDeferredValue(text ?? '')
  const html = useMemo(() => renderMarkdown(deferred), [deferred])

  const change = (value: string): void => {
    setText(value)
    autosave.schedule(value)
  }

  const chooseMode = (m: Mode): void => {
    setMode(m)
    writePref('ws.macroMode', m)
  }

  /** Applies an edit through execCommand so the native undo stack keeps working. */
  const applyEdit = (el: HTMLTextAreaElement, e: Edit): void => {
    el.setSelectionRange(e.from, e.to)
    if (e.text) document.execCommand('insertText', false, e.text)
    else if (e.from !== e.to) document.execCommand('delete')
    el.setSelectionRange(e.selStart, e.selEnd)
  }

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = ev.currentTarget
    if (ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault()
      applyEdit(el, indentLines(el.value, el.selectionStart, el.selectionEnd, ev.shiftKey))
    } else if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
      const edit = continueList(el.value, el.selectionStart, el.selectionEnd)
      if (edit) {
        ev.preventDefault()
        applyEdit(el, edit)
      }
    }
  }

  if (loadError) return <div className="ws-placeholder">Não foi possível abrir o plano: {loadError}</div>
  if (text === null) return <div className="ws-placeholder">Carregando plano…</div>

  return (
    <div className={`macro macro-${mode}`}>
      <div className="macro-toolbar">
        <div className="segmented" role="tablist" aria-label="Modo de exibição">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              className={mode === m.id ? 'on' : ''}
              onClick={() => chooseMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {claudeNotice ? (
          <span className="macro-claude-notice" role="status">
            Atualizado pelo Claude
          </span>
        ) : (
          <span className="macro-hint">Markdown · Tab indenta · Enter continua listas</span>
        )}
        {text.trim() === '' && (
          <button className="btn btn-ghost macro-template" onClick={() => change(TEMPLATE)}>
            Usar modelo
          </button>
        )}
      </div>
      <div className="macro-panes">
        {mode !== 'preview' && (
          <textarea
            ref={textareaRef}
            className="macro-editor"
            value={text}
            spellCheck
            placeholder={'Escreva o plano macro em Markdown…\n\n# Objetivo\n## Escopo\n## Abordagem'}
            onChange={(e) => change(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
        {mode !== 'edit' && (
          <div className="macro-preview-wrap">
            {text.trim() === '' ? (
              <div className="macro-empty">A prévia aparece aqui conforme você escreve.</div>
            ) : (
              <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
