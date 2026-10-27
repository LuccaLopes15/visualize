import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ClaudeError, ClaudeStatus } from '@shared/chat'
import { applyLiveEvent, type LiveTurn } from './liveTurn'

const api = window.api

export interface ChatController {
  loaded: boolean
  messages: ChatMessage[]
  live: LiveTurn | null
  busy: boolean
  status: ClaudeStatus | null
  /** Problem that blocks chatting (CLI missing / too old / not logged in). */
  blocker: ClaudeError | null
  /** Last runtime error (crash, etc.), dismissible. */
  error: ClaudeError | null
  dismissError: () => void
  send: (text: string) => Promise<boolean>
  stop: () => void
  reset: () => Promise<void>
  recheck: () => Promise<void>
}

const BLOCKING = new Set(['not_found', 'too_old', 'not_logged_in', 'spawn'])

export function useChat(ideaId: number): ChatController {
  const [loaded, setLoaded] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [live, setLive] = useState<LiveTurn | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [runtimeBlocker, setRuntimeBlocker] = useState<ClaudeError | null>(null)
  const [error, setError] = useState<ClaudeError | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    setLoaded(false)
    api.chat
      .open(ideaId)
      .then((state) => {
        if (!alive.current) return
        setMessages(state.messages)
        setBusy(state.busy)
        setLive(state.busy ? { blocks: [] } : null)
        setStatus(state.status)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (!alive.current) return
        setError({ code: 'other', message: err instanceof Error ? err.message : String(err) })
        setLoaded(true)
      })

    const off = api.chat.onEvent((ev) => {
      if (ev.ideaId !== ideaId) return
      setLive((cur) => applyLiveEvent(cur, ev))
      switch (ev.kind) {
        case 'userMessage':
          setMessages((m) => [...m, ev.message])
          setError(null)
          break
        case 'assistantMessage':
          setMessages((m) => [...m, ev.message])
          break
        case 'busy':
          setBusy(ev.busy)
          break
        case 'error':
          if (BLOCKING.has(ev.error.code)) setRuntimeBlocker(ev.error)
          else setError(ev.error)
          break
        case 'reset':
          setMessages([])
          setError(null)
          break
      }
    })
    return () => {
      alive.current = false
      off()
    }
  }, [ideaId])

  const recheck = useCallback(async () => {
    const s = await api.claude.status(true)
    setStatus(s)
    setRuntimeBlocker(null)
  }, [])

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await api.chat.send(ideaId, text)
        return true
      } catch (err) {
        // ChatErrors also arrive as events; only show what didn't.
        const message = err instanceof Error ? err.message : String(err)
        setError((cur) => cur ?? { code: 'other', message })
        return false
      }
    },
    [ideaId]
  )

  const stop = useCallback(() => void api.chat.stop(ideaId), [ideaId])
  const reset = useCallback(async () => {
    await api.chat.reset(ideaId)
  }, [ideaId])

  const statusBlocker = status?.problem && BLOCKING.has(status.problem.code) ? status.problem : null
  return {
    loaded,
    messages,
    live,
    busy,
    status,
    blocker: runtimeBlocker ?? statusBlocker,
    error,
    dismissError: () => setError(null),
    send,
    stop,
    reset,
    recheck
  }
}
