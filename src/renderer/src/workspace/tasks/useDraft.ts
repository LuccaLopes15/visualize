import { useCallback, useEffect, useRef, useState } from 'react'
import { registerFlusher } from '../../lib/autosave'
import { DraftCore, type Merge } from './draftCore'

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
 *
 * With `merge`, leaving the field (unmount, app quitting) during an unresolved conflict writes
 * both versions together instead of dropping the user's text.
 */
export function useDraft(
  value: string,
  commit: (next: string) => void | Promise<unknown>,
  idleMs = 0,
  merge?: Merge
): Draft {
  const coreRef = useRef<DraftCore>(undefined)
  if (!coreRef.current) coreRef.current = new DraftCore(value)
  const core = coreRef.current
  const [, setTick] = useState(0)
  const render = useCallback(() => setTick((t) => t + 1), [])
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const commitRef = useRef(commit)
  commitRef.current = commit
  const mergeRef = useRef(merge)
  mergeRef.current = merge

  useEffect(() => {
    if (core.remote(value)) render()
  }, [value, core, render])

  const write = useCallback(
    async (leaving: boolean): Promise<void> => {
      clearTimeout(timer.current)
      const next = leaving ? core.leave(mergeRef.current) : core.flush()
      if (next === null) return
      try {
        await commitRef.current(next)
      } catch {
        /* the caller reports its own errors */
      }
    },
    [core]
  )
  const flush = useCallback(() => write(false), [write])

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
  // Quitting and unmounting are "leaving": an open conflict is merged instead of held.
  useEffect(() => registerFlusher((opts) => write(opts.leaving === true)), [write])
  useEffect(
    () => () => {
      void write(true)
    },
    [write]
  )

  return { draft: core.text, change, flush, reset, conflict: core.conflict, acceptRemote, keepMine }
}
