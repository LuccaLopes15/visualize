import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

const api = window.api
/** Transparent margin around the card (room for the shadow). Must match capture.css. */
const WINDOW_PADDING = 12

/**
 * Quick capture: title (Enter saves), optional detail (Tab / Shift+Enter
 * reveals it; Shift+Tab or Backspace on an empty detail goes back to the
 * compact title-only mode), Esc discards. The draft survives an accidental
 * blur, and a hidden detail keeps its text (and is still saved).
 */
export function Capture(): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [showDetail, setShowDetail] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const focusTitle = useCallback(() => {
    const el = titleRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  useEffect(() => api.capture.onShown(() => focusTitle()), [focusTitle])
  useEffect(() => focusTitle(), [focusTitle])

  // Keep the native window height in sync with the card.
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const ro = new ResizeObserver(() => {
      void api.capture.resize(Math.ceil(card.getBoundingClientRect().height) + WINDOW_PADDING * 2)
    })
    ro.observe(card)
    return () => ro.disconnect()
  }, [])

  const reset = (): void => {
    setTitle('')
    setBody('')
    setShowDetail(false)
    setError(null)
  }

  const discard = (): void => {
    reset()
    void api.capture.close()
  }

  const save = async (): Promise<void> => {
    if (saving) return
    if (!title.trim()) {
      setError('Escreva um título para a ideia.')
      titleRef.current?.focus()
      return
    }
    setSaving(true)
    try {
      await api.capture.save({ title, body })
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const revealDetail = (): void => {
    setShowDetail(true)
    requestAnimationFrame(() => bodyRef.current?.focus())
  }

  /** Back to the title, caret at the end (no select-all: keep what was typed). */
  const focusTitleEnd = (): void => {
    const el = titleRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }

  /** Hides the detail field; its text (if any) is kept and still saved. */
  const collapseDetail = (): void => {
    setShowDetail(false)
    requestAnimationFrame(focusTitleEnd)
  }

  const toggleDetail = (): void => {
    if (showDetail) collapseDetail()
    else revealDetail()
  }

  const hasHiddenDetail = !showDetail && body.trim() !== ''

  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      discard()
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      revealDetail()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      revealDetail()
    }
  }

  const onBodyKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      discard()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void save()
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      if (body.trim() === '') {
        setBody('')
        collapseDetail()
      } else {
        focusTitleEnd()
      }
    } else if (e.key === 'Backspace' && body === '') {
      e.preventDefault()
      collapseDetail()
    }
  }

  return (
    <div className="capture-card" ref={cardRef}>
      <div className="capture-row">
        <span className="capture-spark" aria-hidden>
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path
              d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"
              fill="currentColor"
            />
          </svg>
        </span>
        <input
          ref={titleRef}
          className="capture-title"
          placeholder="Qual é a ideia?"
          value={title}
          maxLength={300}
          onChange={(e) => {
            setTitle(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={onTitleKey}
          spellCheck
          autoFocus
        />
      </div>
      {showDetail && (
        <textarea
          ref={bodyRef}
          className="capture-body-input"
          placeholder="Detalhes (opcional) — Shift+Enter quebra linha"
          value={body}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onBodyKey}
        />
      )}
      <div className="capture-hints">
        {error ? (
          <span className="capture-error">{error}</span>
        ) : showDetail ? (
          <>
            <span>
              <kbd>Enter</kbd> salvar
            </span>
            <span>
              <kbd>Shift+Enter</kbd> nova linha
            </span>
            <span>
              <kbd>Shift+Tab</kbd> voltar
            </span>
            <span>
              <kbd>Esc</kbd> descartar
            </span>
          </>
        ) : (
          <>
            <span>
              <kbd>Enter</kbd> salvar
            </span>
            <span>
              <kbd>Tab</kbd> detalhes
            </span>
            <span>
              <kbd>Esc</kbd> descartar
            </span>
          </>
        )}
        <button
          type="button"
          className={`capture-toggle${hasHiddenDetail ? ' has-text' : ''}`}
          onMouseDown={(e) => e.preventDefault() /* keep focus in the field */}
          onClick={toggleDetail}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              discard()
            }
          }}
          aria-expanded={showDetail}
          aria-label={
            showDetail
              ? 'Ocultar detalhes'
              : hasHiddenDetail
                ? 'Mostrar detalhes (há texto escrito, ele será salvo junto)'
                : 'Mostrar detalhes'
          }
          title={hasHiddenDetail ? 'Há detalhes escritos — serão salvos junto' : undefined}
        >
          {showDetail ? (
            '– detalhes'
          ) : hasHiddenDetail ? (
            <>
              <span className="capture-toggle-dot" aria-hidden />+ detalhes (com texto)
            </>
          ) : (
            '+ detalhes'
          )}
        </button>
      </div>
    </div>
  )
}
