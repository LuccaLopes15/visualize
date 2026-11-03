import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Local draft of a remote text value: follows `value` while the user is not
 * editing, commits on `flush()` (blur / Enter) or after `idleMs` without typing,
 * and flushes on unmount (so switching selection never loses an edit).
 */
export function useDraft(
  value: string,
  commit: (next: string) => void,
  idleMs = 0
): { draft: string; change: (v: string) => void; flush: () => void; reset: () => void } {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)
  const valueRef = useRef(value)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const commitRef = useRef(commit)
  commitRef.current = commit
  valueRef.current = value

  useEffect(() => {
    if (!dirty.current) {
      draftRef.current = value
      setDraft(value)
    }
  }, [value])

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    if (!dirty.current) return
    dirty.current = false
    if (draftRef.current !== valueRef.current) commitRef.current(draftRef.current)
  }, [])

  const change = useCallback(
    (v: string) => {
      draftRef.current = v
      dirty.current = true
      setDraft(v)
      clearTimeout(timer.current)
      if (idleMs > 0) timer.current = setTimeout(flush, idleMs)
    },
    [flush, idleMs]
  )

  /** Drop the edit and go back to the stored value. */
  const reset = useCallback(() => {
    clearTimeout(timer.current)
    dirty.current = false
    draftRef.current = valueRef.current
    setDraft(valueRef.current)
  }, [])

  useEffect(() => flush, [flush])

  return { draft, change, flush, reset }
}
