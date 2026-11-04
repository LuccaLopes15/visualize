import { useCallback, useEffect, useRef, useState } from 'react'
import { registerFlusher } from '../../lib/autosave'
import { DraftCore } from './draftCore'

export interface Draft {
  draft: string
  change: (v: string) => void
  /** Writes pending edits (resolves when the commit finished). No-op while a conflict is unresolved. */
  flush: () => Promise<void>
  reset: () => void
  /** The stored value changed under the user's unsent edit (null = no conflict). */
  conflict: string | null
  acceptRemote: () => void
  keepMine: () => void
}

/**
 * Local draft of a remote text value: follows `value` while the user is not editing, commits on
 * `flush()` (blur / Enter) or after `idleMs` without typing, and flushes on unmount and on the
 * global flush request (so switching selection, quitting, or Claude reading the plan never loses /
 * ignores an edit). See `DraftCore` for the rules about echoes and concurrent changes.
 */
export function useDraft(value: string, commit: (next: string) => void | Promise<unknown>, idleMs = 0): Draft {
  const coreRef = useRef<DraftCore>(undefined)
  if (!coreRef.current) coreRef.current = new DraftCore(value)
  const core = coreRef.current
  const [, setTick] = useState(0)
  const render = useCallback(() => setTick((t) => t + 1), [])
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const commitRef = useRef(commit)
  commitRef.current = commit

  useEffect(() => {
    if (core.remote(value)) render()
  }, [value, core, render])

  const flush = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current)
    const next = core.flush()
    if (next === null) return
    try {
      await commitRef.current(next)
    } catch {
      /* the caller reports its own errors */
    }
  }, [core])

  const change = useCallback(
    (v: string) => {
      core.edit(v)
      render()
      clearTimeout(timer.current)
      if (idleMs > 0) timer.current = setTimeout(() => void flush(), idleMs)
    },
    [core, render, flush, idleMs]
  )

  const reset = useCallback(() => {
    clearTimeout(timer.current)
    core.reset()
    render()
  }, [core, render])

  const acceptRemote = useCallback(() => {
    clearTimeout(timer.current)
    core.acceptRemote()
    render()
  }, [core, render])

  const keepMine = useCallback(() => {
    core.keepMine()
    render()
    void flush()
  }, [core, render, flush])

  // Global flush (quit / hide / Claude's tasks_* tools) and unmount (selection change, panel closed).
  useEffect(() => registerFlusher(flush), [flush])
  useEffect(
    () => () => {
      void flush()
    },
    [flush]
  )

  return { draft: core.text, change, flush, reset, conflict: core.conflict, acceptRemote, keepMine }
}
