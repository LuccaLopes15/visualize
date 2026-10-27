import { useEffect, useRef, useState } from 'react'
import { Autosaver, registerFlusher, type SaveStatus } from '../lib/autosave'

export interface AutosaveHandle<T> {
  schedule: (value: T) => void
  flush: () => Promise<void>
  cancel: () => void
  status: SaveStatus
}

/**
 * React wrapper around `Autosaver`: debounced save, registered in the global
 * flush registry while mounted, flushed on unmount. `save` may change between
 * renders (latest one is used).
 */
export function useAutosave<T>(
  save: (value: T) => Promise<void>,
  delay = 800,
  onStatus?: (status: SaveStatus, error?: unknown) => void
): AutosaveHandle<T> {
  const saveRef = useRef(save)
  const onStatusRef = useRef(onStatus)
  saveRef.current = save
  onStatusRef.current = onStatus
  const [status, setStatus] = useState<SaveStatus>('idle')

  const [saver] = useState(
    () =>
      new Autosaver<T>(
        (v) => saveRef.current(v),
        delay,
        (s, err) => {
          setStatus(s)
          onStatusRef.current?.(s, err)
        }
      )
  )

  useEffect(() => {
    const unregister = registerFlusher(() => saver.flush())
    return () => {
      unregister()
      // Unmount (leaving the workspace): write whatever is still pending.
      void saver.flush()
      saver.dispose()
    }
  }, [saver])

  return { schedule: (v) => saver.schedule(v), flush: () => saver.flush(), cancel: () => saver.cancel(), status }
}
