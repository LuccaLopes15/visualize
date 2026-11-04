import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanGraph } from '@shared/types'
import { useToast } from '../../components/Toasts'
import { isNotFoundError } from './ops'

const api = window.api

export interface PlanGraphState {
  graph: PlanGraph | null
  /** Load error (not a rule violation: those go to toasts). */
  error: string | null
  refetch: () => Promise<void>
  /**
   * Runs a mutation. A rejection (PlanError message, already in pt-BR) becomes
   * a toast; the graph is ALWAYS refetched afterwards so the UI never keeps
   * stale state. Resolves to the result, or undefined when it failed. `quietNotFound`: a rejection because
   * the node no longer exists (deleted meanwhile) is swallowed silently (late autosave of a draft).
   */
  mutate: <T>(fn: () => Promise<T>, opts?: { quietNotFound?: boolean }) => Promise<T | undefined>
}

/** Plan graph of an idea, kept fresh: refetches on `events:dataChanged` (entity 'plan', same idea). */
export function usePlanGraph(ideaId: number): PlanGraphState {
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const [graph, setGraph] = useState<PlanGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const refetch = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    try {
      const g = await api.plan.getGraph(ideaId)
      if (mine !== seq.current) return // a newer request is in flight / done
      setGraph(g)
      setError(null)
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [ideaId])

  useEffect(() => {
    setGraph(null)
    setError(null)
    void refetch()
    const off = api.onDataChanged((e) => {
      if (e.entity === 'plan' && e.ideaId === ideaId) void refetch()
    })
    return () => {
      off()
      seq.current++ // drop in-flight responses of the previous idea
    }
  }, [ideaId, refetch])

  const mutate = useCallback(
    async <T,>(fn: () => Promise<T>, opts?: { quietNotFound?: boolean }): Promise<T | undefined> => {
      try {
        return await fn()
      } catch (err) {
        if (!(opts?.quietNotFound && isNotFoundError(err))) toastRef.current.error(err)
        return undefined
      } finally {
        void refetch()
      }
    },
    [refetch]
  )

  return { graph, error, refetch, mutate }
}
